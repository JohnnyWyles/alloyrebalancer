/* The resumable loop runner. Rules, in order of importance:
 *   - a stage whose tx is recorded is never signed again until the chain proves that tx failed or can no longer land
 *     (included with an error, past its timeout height, its nonce taken by another tx, or rejected at CheckTx);
 *   - a stage whose tx landed is signed again only when refunded() proves the funds are back at the stage's source;
 *   - at most MAX_SIGNED_ATTEMPTS signatures per stage, then halt; anything unexplained halts.
 * Dependencies are injected so test.mjs can drive it with fake stages.
 */
import { P } from "./page.mjs";
const { K, fmtUnits } = P;
const LATE_ALERT_MS = 3 * 3600e3;   // a late arrival is reported when first noticed and then every 3 hours
const halt = msg => Object.assign(new Error(msg), { halt: true });
export const MAX_SIGNED_ATTEMPTS = 3;
const ARRIVAL_FAILED = /rose by only|^Skip reports/;   // page's waitArrival timeout, trackToCompletion's terminal error
/* Refused quotes sign nothing, so they are asked again indefinitely: 30 s, 1, 2, 4, 8, then every 15 minutes. After
   ALERT_REQUOTES in a row a person is told once (the usual cause is a gas spike pushing a relay fee past the page's
   bound, which clears by itself; a persistent one means Skip changed an adapter or route shape). */
export const ALERT_REQUOTES = 6;
export const MAX_REQUOTE_DELAY_MS = 15 * 60000;

/* Loop loss. Each bridge stage's quote is validated by the page (at most K.MAX_LOSS_BPS, or the hub's flat relay bound
   on A1 when that is larger), and the loop halts only when what came back falls short of what Skip quoted by more than
   max_loop_loss_bps of the amount: an unexplained loss, not an expensive-but-quoted one.
   loopLossBound is the worst a loop can lose without halting (validated quotes plus that margin); the daily fee ceiling
   reserves it before a loop starts, so for every loop that completes normally the ceiling holds. */
const stageLossBound = (key, a) => {   // the most a validated quote for this stage may lose
  const leg = a * BigInt(K.MAX_LOSS_BPS) / 10000n, flat = BigInt(K.HUB["43114"].flatLoss);
  return key === "A1" ? (leg > flat ? leg : flat) : key === "A2" ? leg : 0n;   // A3 and N0 are exact 1:1 swaps
};
/* worst loss a cycle can book without halting: the stages it runs (a recovery runs only the tail of the loop, from
   c.startIdx) plus the max_loop_loss_bps margin. It stays reserved until the cycle completes and books its loss. */
export function cycleLossBound(c, order, bps) {
  const a = BigInt(c.amountIn);
  return order.slice(c.startIdx || 0).reduce((t, k) => t + stageLossBound(k, a), 0n) + a * BigInt(bps) / 10000n;
}
export const loopLossBound = (amountIn, bps) => cycleLossBound({ amountIn }, ["A1", "A2", "A3"], bps);
/* what Skip quoted the loop would lose: each stage's amount in minus the amount its quote promised */
export const quotedLoss = (c, order) => order.reduce((t, k) => { const st = c.stages[k]; return t + (st?.expected ? BigInt(st.amountIn) - BigInt(st.expected) : 0n); }, 0n);
/* lossMicro overrides the full-loop bound (recoveries, cycles already in flight) */
export function fitsFeeCap({ capMicro, bookedMicro, amountIn, bps, feeMicro, lossMicro }) {
  return BigInt(bookedMicro || 0) + BigInt(feeMicro || 0) + (lossMicro ?? loopLossBound(amountIn, bps)) <= BigInt(capMicro);
}
export const nextUtcMidnight = (now = Date.now()) => { const d = new Date(now); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };

/* Funds found outside the alloy with no loop in flight are brought home by the part of the loop that starts where they
   are, so recovery uses the same stages, validators and journal as a loop. Closest to home first, one at a time.
   Returns the cycle to run, or null. `b` holds the balances in base units. */
export function planRecovery(b, strandMicro, ORDER, now = Date.now()) {
  const id = "recover-" + new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const at = (idx, prevKey, amt, what) => ({ id, recovery: what, amountIn: amt.toString(), idx, startIdx: idx, order: ORDER,
    stages: { [prevKey]: { amountIn: amt.toString(), received: amt.toString(), signed: 0, recovered: true } } });
  if (b.injUsdc >= strandMicro) return at(2, ORDER[1], b.injUsdc, "USDC.inj on Injective");
  if (b.avaxUsdc >= strandMicro) return at(1, ORDER[0], b.avaxUsdc, "USDC on Avalanche");
  if (b.noble >= strandMicro) return { id, recovery: "USDC.noble on Osmosis", amountIn: b.noble.toString(), idx: 0, order: ["N0"], stages: {} };
  return null;
}

export function makeRunner({ STAGES, ORDER, saveState, log, addFee, notify = async () => {}, refillGas = null, retryMs = 120000, refundRetryMs = 300000, requoteMs = 30000 }) {
 return async function runCycle(ctx, s) {
  const c = s.cycle, order = c.order || ORDER;   // a recovery cycle carries its own (partial) stage order
  for (; c.idx < order.length; c.idx++) {
    const key = order[c.idx], S = STAGES[key];
    const st = c.stages[key] ||= { amountIn: c.idx === 0 ? c.amountIn : c.stages[order[c.idx - 1]].received, signed: 0 };
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
            const bound = cycleLossBound(c, order, ctx.cfg.max_loop_loss_bps);
            if (fee > 0n && !fitsFeeCap({ capMicro: ctx.capMicro, bookedMicro: s.feesToday, feeMicro: fee, lossMicro: bound }))
              throw Object.assign(new Error(`${key} fee ${fmtUnits(fee)} plus this cycle's worst-case loss ${fmtUnits(bound)} does not fit in today's remaining fee budget`), { feeCap: true });
            st.tx = tx; st.signed++; st.requotes = 0; if (fee > 0n) addFee(s, fee); save();
          });
          if (r?.dryRun) { note("dry run stops here"); return "dry"; }
        } catch (e) {
          if (e.gasShort && !st.tx && refillGas) {   // nothing signed; buy gas from the Osmosis reserve, then try the stage again
            note(`${e.gasShort.toUpperCase()} is too low for this stage; refilling mid-loop`);
            await refillGas(ctx, s, e.gasShort); continue;
          }
          if (e.feeCap && !st.tx) {   // nothing signed: the funds stay at this stage's source until the budget resets
            st.retryAfter = nextUtcMidnight(); note(`${e.message}; not sent, waiting for 00:00 UTC`); save(); continue;
          }
          if (e.requote && !st.tx) {   // nothing was signed: ask again later, halt only if it keeps refusing
            st.requotes = (st.requotes || 0) + 1;
            if (st.requotes === ALERT_REQUOTES) await notify(ctx, `${key}: ${st.requotes} refused quotes in a row (still retrying every ${MAX_REQUOTE_DELAY_MS / 60000} min; nothing is signed). Latest: ${e.message}`);
            const delay = Math.min(requoteMs * 2 ** (st.requotes - 1), MAX_REQUOTE_DELAY_MS);
            note(`${e.message}; asking Skip again in ${Math.round(delay / 1000)} s (refusal ${st.requotes} in a row)`);
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
        // late, not lost: the tx is recorded and neither delivered nor refunded yet, so keep waiting (waiting never
        // signs) and tell a person when it first goes late and every few hours after
        st.lateSince ||= Date.now();
        if (!st.lateAlertedAt || Date.now() - st.lateAlertedAt >= LATE_ALERT_MS) {
          st.lateAlertedAt = Date.now(); save();
          await notify(ctx, `${key} is late (${Math.round((Date.now() - st.lateSince) / 60000)} min past its arrival window; tx ${st.tx?.hash}). Still waiting, nothing re-signed. ${e.message}`);
        }
        save();
        throw Object.assign(new Error(`${key} arrival late: ${e.message}; waiting`), { wait: true });
      }
    }
  }
  const last = c.stages[order[order.length - 1]];
  const out = BigInt(c.amountIn), back = BigInt(last.received), loss = out > back ? out - back : 0n, quoted = quotedLoss(c, order);
  addFee(s, loss);
  s.history = [...(s.history || []).slice(-49), { id: c.id, out: c.amountIn, back: last.received, done: new Date().toISOString(), ...(c.recovery ? { recovery: c.recovery } : {}) }];
  s.cycle = null; if (!c.recovery) s.loopsToday = (s.loopsToday || 0) + 1;   // a recovery brings funds home; it is not a loop
  saveState(s);
  log(`[${c.id}] ${c.recovery ? `recovered ${c.recovery}` : "loop complete"}: ${fmtUnits(out)} out, ${fmtUnits(back)} back, loss ${fmtUnits(loss)}`);
  const unexplained = loss > quoted ? loss - quoted : 0n;
  if (unexplained * 10000n > out * BigInt(ctx.cfg.max_loop_loss_bps))
    throw halt(`loop ${c.id} lost ${fmtUnits(loss)} allUSDC, ${fmtUnits(unexplained)} more than Skip quoted (${fmtUnits(quoted)}); max_loop_loss_bps ${ctx.cfg.max_loop_loss_bps} allows ${fmtUnits(out * BigInt(ctx.cfg.max_loop_loss_bps) / 10000n)} beyond the quote`);
  return "done";
 };
}
