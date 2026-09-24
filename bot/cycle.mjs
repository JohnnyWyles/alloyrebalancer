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
const ARRIVAL_FAILED = /rose by only|^Skip reports/;   // page's waitArrival timeout, trackToCompletion's terminal error
export const MAX_REQUOTES = 6;   // consecutive refused quotes per stage before halting: 30 s, 1, 2, 4, 8 min apart (~15 min)

/* The daily fee ceiling, for loops. A loop may still lose up to max_loop_loss_bps of its amount (booked when it
   completes), so any allUSDC fee signed for it must fit together with that worst-case loss. A loss beyond the bound
   halts the bot anyway, so for every loop that completes normally the ceiling holds. */
export const loopLossBound = (amountIn, bps) => BigInt(amountIn) * BigInt(bps) / 10000n;
export function fitsFeeCap({ capMicro, bookedMicro, amountIn, bps, feeMicro }) {
  return BigInt(bookedMicro || 0) + BigInt(feeMicro || 0) + loopLossBound(amountIn, bps) <= BigInt(capMicro);
}
export const nextUtcMidnight = (now = Date.now()) => { const d = new Date(now); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };

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
          // the tx and its allUSDC fee are journaled in one durable write, so a restart during the arrival wait
          // neither loses the fee nor books it twice (the resume path never signs, so never books)
          const r = await S.send(ctx, st, note, async tx => {
            const fee = BigInt(tx.feeAllUSDC || 0);
            // exact fee known, nothing journaled or broadcast yet: the fee plus the loop's worst-case loss must fit today
            if (fee > 0n && !fitsFeeCap({ capMicro: ctx.capMicro, bookedMicro: s.feesToday, amountIn: c.amountIn, bps: ctx.cfg.max_loop_loss_bps, feeMicro: fee }))
              throw Object.assign(new Error(`${key} fee ${fmtUnits(fee)} plus this loop's worst-case loss ${fmtUnits(loopLossBound(c.amountIn, ctx.cfg.max_loop_loss_bps))} does not fit in today's remaining fee budget`), { feeCap: true });
            st.tx = tx; st.signed++; st.requotes = 0; if (fee > 0n) addFee(s, fee); save();
          });
          if (r?.dryRun) { note("dry run stops here"); return "dry"; }
        } catch (e) {
          if (e.feeCap && !st.tx) {   // nothing signed: the funds stay at this stage's source until the budget resets
            st.retryAfter = nextUtcMidnight(); note(`${e.message}; not sent, waiting for 00:00 UTC`); save(); continue;
          }
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
        // only a definitive outcome is judged here: the arrival window ran out, or Skip reports a terminal error. A failed
        // read (LCD or RPC blip) is transient; the tx stays journaled and the next tick waits again without signing.
        if (!ARRIVAL_FAILED.test(e.message)) throw e;
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
