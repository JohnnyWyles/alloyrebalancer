/* The resumable loop runner. Rules, in order of importance:
 *   - a stage whose tx is recorded is never signed again until the chain proves that tx failed or can no longer land
 *     (included with an error, past its timeout height, its nonce taken by another tx, or rejected at CheckTx);
 *   - a stage whose tx landed is signed again only when refunded() proves the funds are back at the stage's source;
 *   - at most MAX_SIGNED_ATTEMPTS signatures per stage, then halt; anything unexplained halts.
 * Dependencies are injected so test.mjs can drive it with fake stages.
 */
import { P } from "./page.mjs";
const { fmtUnits } = P;
const halt = msg => Object.assign(new Error(msg), { halt: true });
export const MAX_SIGNED_ATTEMPTS = 3;
export const MAX_REQUOTES = 6;   // consecutive refused quotes per stage before halting: 30 s, 1, 2, 4, 8 min apart (~15 min)

export function makeRunner({ STAGES, ORDER, saveState, log, addFee, retryMs = 120000, refundRetryMs = 300000, requoteMs = 30000 }) {
 return async function runCycle(ctx, s) {
  const c = s.cycle;
  for (; c.idx < ORDER.length; c.idx++) {
    const key = ORDER[c.idx], S = STAGES[key];
    const st = c.stages[key] ||= { amountIn: c.idx === 0 ? c.amountIn : c.stages[ORDER[c.idx - 1]].received, signed: 0 };
    const note = m => log(`[${c.id} ${key}]`, m);
    const save = () => saveState(s);
    for (;;) {
      if (!st.tx) {
        if (st.retryAfter && Date.now() < st.retryAfter) throw Object.assign(new Error(`${key} retry scheduled`), { wait: true, until: st.retryAfter });
        if (st.signed >= MAX_SIGNED_ATTEMPTS) throw halt(`${key} was signed ${st.signed} times without success`);
        note(`${S.title}: sending ${fmtUnits(st.amountIn)}`);
        try {
          const r = await S.send(ctx, st, note, async tx => { st.tx = tx; st.signed++; st.requotes = 0; save(); });
          if (r?.dryRun) { note("dry run stops here"); return "dry"; }
          if (key === "A1" && r?.fee) addFee(s, r.fee);   // Osmosis fee, paid in allUSDC
        } catch (e) {
          if (e.requote && !st.tx) {   // nothing was signed: ask again later, halt only if it keeps refusing
            st.requotes = (st.requotes || 0) + 1;
            if (st.requotes >= MAX_REQUOTES) throw halt(`${key}: ${st.requotes} refused quotes in a row, latest: ${e.message}`);
            const delay = requoteMs * 2 ** (st.requotes - 1);
            note(`${e.message}; asking Skip again in ${Math.round(delay / 1000)} s (${st.requotes}/${MAX_REQUOTES})`);
            st.retryAfter = Date.now() + delay; save(); continue;
          }
          if (e.rejectedHash || e.txFailed || e.txExpired) {   // provably never moved funds: forget the tx and retry after a pause
            note(`attempt did not land (${e.message}); retrying in 2 minutes`);
            st.tx = undefined; st.retryAfter = Date.now() + retryMs; save(); continue;
          }
          throw e;
        }
      } else {
        const state = await S.state(st.tx, ctx);
        note(`recorded tx ${st.tx.hash}: ${state}`);
        if (state === "failed" || state === "expired") { st.tx = undefined; st.retryAfter = Date.now() + retryMs; save(); continue; }
        if (state === "pending" || state === "unknown") {
          try { await S.rebroadcast(st.tx, ctx); }   // the same signed bytes: idempotent
          catch (e) { if (e.txFailed || e.txExpired) { st.tx = undefined; save(); continue; } throw e; }
        }
      }
      try {
        st.received = await S.arrive(ctx, st, note);
        note(`received ${fmtUnits(st.received)}`); save(); break;
      } catch (e) {
        if (await S.refunded(ctx, st).catch(() => false)) {
          note(`refunded to the stage's source (${e.message}); retrying in 5 minutes`);
          st.tx = undefined; st.refunds = (st.refunds || 0) + 1; st.retryAfter = Date.now() + refundRetryMs; save(); continue;
        }
        throw halt(`${key} ${S.title}: ${e.message}`);
      }
    }
  }
  const last = c.stages[ORDER[ORDER.length - 1]];
  const out = BigInt(c.amountIn), back = BigInt(last.received), loss = out > back ? out - back : 0n;
  addFee(s, loss);
  s.history = [...(s.history || []).slice(-49), { id: c.id, out: c.amountIn, back: last.received, done: new Date().toISOString() }];
  s.cycle = null; s.loopsToday = (s.loopsToday || 0) + 1; saveState(s);
  log(`[${c.id}] loop complete: ${fmtUnits(out)} out, ${fmtUnits(back)} back, loss ${fmtUnits(loss)}`);
  if (loss * 10000n > out * BigInt(ctx.cfg.max_loop_loss_bps)) throw halt(`loop ${c.id} lost ${fmtUnits(loss)} allUSDC, above max_loop_loss_bps ${ctx.cfg.max_loop_loss_bps}`);
  return "done";
 };
}
