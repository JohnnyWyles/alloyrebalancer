/* The noble -> inj loop, headless: the page's A1/A2/A3 with Keplr and the confirm sheets replaced by the bot's own signer
 * and a journal. Every Skip response goes through the page's validator before anything is signed, and a refusal halts.
 *
 *   A1  Osmosis:   allUSDC -> USDC.noble (own 1:1 swap on pool 3497) + Skip's IBC to Noble's orbiter, CCTP v1 -> Avalanche
 *   A2  Avalanche: USDC -> Injective USDC.inj (Skip's CCTP v2 adapter)
 *   A3  Injective: USDC.inj -> IBC -> Osmosis, ibc-hooks swap into allUSDC on pool 3497
 *
 * A stage's send() records { before, expected } and then the signed tx (hash + raw bytes) before broadcast. arrive()
 * waits for the destination balance to rise. refunded() says whether a failed stage's funds are provably back where
 * the stage started, which is the only condition under which the runner signs that stage again.
 */
import { P } from "./page.mjs";
import { signAndBroadcast, evmSend, cosmosTxState, evmTxState, rebroadcastCosmos, waitCosmosTx } from "./sign.mjs";
import { headroom } from "./chain.mjs";

const { K, Any, MsgSwapExactAmountIn, skipMsgToAny, skipRoute, validateNobleToHub, validateHubToInj, validateInjToAll, assertChannel,
        bankBalance, erc20BalanceOf, erc20Allowance, approvalPlan, approveCalldata, trackToCompletion, waitArrival, rpc, waitReceipt, fmtUnits, sleep } = P;

const AVAX = "43114", H = K.HUB[AVAX];
export const halt = msg => Object.assign(new Error(msg), { halt: true });
export const wait = (msg, until) => Object.assign(new Error(msg), { wait: true, until });
/* Skip's status API is a convenience: a terminal error it reports is real, but an unreachable API is not a failure,
   so arrival then falls back to watching the destination balance */
async function track(chain, hash, note) {
  try { await trackToCompletion(chain, hash, s => note("Skip: " + s)); }
  catch (e) { if (/^Skip reports/.test(e.message)) throw e; note(`Skip tracking unavailable (${e.message}); watching the balance instead`); }
}
const ARRIVAL_POLLS = 360;   // x 5 s = 30 minutes after Skip reports completion (or stops answering)
/* A refused route has signed nothing, so the runner asks Skip again (Skip sometimes answers with a detour it does not
   offer a minute later). The validator still decides every answer; a refusal that keeps coming back halts. */
export const requote = msg => Object.assign(new Error(msg), { requote: true });
const refused = v => requote("route refused: " + v.errs.join("; "));

const avaxUsdc = ctx => erc20BalanceOf(AVAX, H.usdc, ctx.W.evm);
const injUsdc = ctx => bankBalance("injective-1", ctx.W.inj, K.INJ_ERC20);
const osmoAll = ctx => bankBalance("osmosis-1", ctx.W.osmo, K.ALL);

async function needRateRoom(denom, direction, channel, amount, ctx) {
  const h = await headroom(denom, direction, channel);
  const need = BigInt(amount) * BigInt(10000 + Math.round(ctx.cfg.rate_limit_margin_pct * 100)) / 10000n;
  if (h.room !== null && h.room < need)
    throw wait(`IBC rate limit ${h.quota}: ${fmtUnits(h.room)} of ${direction === "in" ? "inflow" : "outflow"} room left, this stage needs ${fmtUnits(need)}; waiting for the window to reset`, h.resetsAt);
}

/* cosmos stages share the "how did the recorded tx end" logic; the EVM stage has its own */
const cosmosTx = chain => ({
  async state(tx) { return (await cosmosTxState(chain, tx.hash, tx.timeoutHeight)).state; },
  async rebroadcast(tx) { await rebroadcastCosmos(chain, tx.raw); await waitCosmosTx(chain, tx.hash, tx.timeoutHeight); },
});

export const STAGES = {
  A1: {
    title: "Osmosis: allUSDC -> USDC.noble (pool 3497) -> Noble -> CCTP v1 -> Avalanche USDC",
    ...cosmosTx("osmosis-1"),
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn;
      if (await osmoAll(ctx) < BigInt(amountIn)) throw halt(`allUSDC balance is below the ${fmtUnits(amountIn)} this loop was started with`);
      await assertChannel("osmosis-1", K.OSMO_TO_NOBLE, "noble-1");
      await needRateRoom(K.NOBLE, "out", K.OSMO_TO_NOBLE, amountIn, ctx);
      const before = await avaxUsdc(ctx);
      const res = await skipRoute(K.NOBLE, "osmosis-1", H.usdc, AVAX, amountIn, { "osmosis-1": ctx.W.osmo, "noble-1": ctx.W.noble, [AVAX]: ctx.W.evm });
      const v = validateNobleToHub(res, { osmo: ctx.W.osmo, evm: ctx.W.evm, amountIn, hub: AVAX }); if (!v.ok) throw refused(v);
      Object.assign(st, { before: before.toString(), expected: v.amountOut });
      const anys = [
        Any("/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn", MsgSwapExactAmountIn({ sender: ctx.W.osmo, routes: [{ poolId: K.POOL, tokenOutDenom: K.NOBLE }],
          tokenIn: { denom: K.ALL, amount: amountIn }, tokenOutMinAmount: amountIn })),   // 1:1 or the whole tx fails
        skipMsgToAny(res.txs[0].cosmos_tx.msgs[0]),
      ];
      note(`swap ${fmtUnits(amountIn)} allUSDC -> USDC.noble, IBC to Noble orbiter, ${fmtUnits(v.amountOut)} USDC expected on Avalanche`);
      return signAndBroadcast("osmosis-1", ctx.wallet, anys, note, onSigned, ctx.signOpts);
    },
    async arrive(ctx, st, note) {
      await track("osmosis-1", st.tx.hash, note);
      return waitArrival(() => avaxUsdc(ctx), BigInt(st.before), st.expected, "Avalanche USDC", ARRIVAL_POLLS);
    },
    async refunded() { return false; },   // a refund lands as USDC.noble on Osmosis, not allUSDC: a human looks at it
  },

  A2: {
    title: "Avalanche: USDC -> Injective USDC.inj (CCTP v2)",
    async state(tx, ctx) { return evmTxState(AVAX, tx.hash, tx.nonce, ctx.W.evm); },
    async rebroadcast(tx) { try { await rpc(AVAX, "eth_sendRawTransaction", [tx.raw]); } catch {} await waitReceipt(AVAX, tx.hash, 15 * 60 * 1000); },
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn;
      const bal = await avaxUsdc(ctx);
      if (bal < BigInt(amountIn)) throw halt(`Avalanche USDC balance ${fmtUnits(bal)} is below the ${fmtUnits(amountIn)} this stage expects`);
      const before = await injUsdc(ctx);
      const res = await skipRoute(H.usdc, AVAX, K.INJ_EVM_USDC, K.INJ_EVM_CHAIN, amountIn, { [AVAX]: ctx.W.evm, [K.INJ_EVM_CHAIN]: ctx.W.injHex });
      const v = validateHubToInj(res, { evm: ctx.W.evm, injHex: ctx.W.injHex, amountIn, hub: AVAX }); if (!v.ok) throw refused(v);
      Object.assign(st, { before: before.toString(), expected: v.amountOut });
      const tx = res.txs[0].evm_tx, eo = { ...ctx.signOpts, maxFeeGwei: ctx.cfg.avax_max_fee_gwei };
      for (const a of v.approvals) {
        const have = await erc20Allowance(AVAX, a.token_contract, ctx.W.evm, a.spender);
        for (const amt of approvalPlan(have, a.amount)) {
          note(`approving exactly ${fmtUnits(amt)} USDC to ${a.spender}`);
          await evmSend(AVAX, ctx.wallet, { to: a.token_contract, data: approveCalldata(a.spender, amt), value: 0 }, note, async () => {}, eo);   // an approval moves nothing
        }
      }
      note(`CCTP v2 burn of ${fmtUnits(amountIn)} USDC, ${fmtUnits(v.amountOut)} USDC.inj expected on Injective`);
      return evmSend(AVAX, ctx.wallet, { to: tx.to, data: "0x" + String(tx.data).replace(/^0x/i, ""), value: tx.value || 0 }, note, onSigned, eo);
    },
    async arrive(ctx, st, note) {
      await track(AVAX, st.tx.hash, note);
      return waitArrival(() => injUsdc(ctx), BigInt(st.before), st.expected, "Injective USDC.inj", ARRIVAL_POLLS);
    },
    async refunded() { return false; },   // a burn is final; if the mint is late a human looks at it
  },

  A3: {
    title: "Injective: USDC.inj -> Osmosis, hook swap into allUSDC (pool 3497)",
    ...cosmosTx("injective-1"),
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn;
      const bal = await injUsdc(ctx);
      if (bal < BigInt(amountIn)) throw halt(`Injective USDC.inj balance ${fmtUnits(bal)} is below the ${fmtUnits(amountIn)} this stage expects`);
      await assertChannel("injective-1", K.INJ_TO_OSMO, "osmosis-1");
      await needRateRoom(K.INJ_IBC, "in", K.OSMO_TO_INJ, amountIn, ctx);
      const before = await osmoAll(ctx);
      const res = await skipRoute(K.INJ_ERC20, "injective-1", K.ALL, "osmosis-1", amountIn, { "injective-1": ctx.W.inj, "osmosis-1": ctx.W.osmo });
      const v = validateInjToAll(res, { inj: ctx.W.inj, osmo: ctx.W.osmo, amountIn }); if (!v.ok) throw refused(v);
      if (BigInt(v.amountOut || 0) < BigInt(amountIn)) throw requote(`Skip quotes ${fmtUnits(v.amountOut)} allUSDC for ${fmtUnits(amountIn)} USDC.inj through a 1:1 transmuter`);
      tightenMinAsset(res, amountIn);
      const v2 = validateInjToAll(res, { inj: ctx.W.inj, osmo: ctx.W.osmo, amountIn }); if (!v2.ok) throw refused(v2);
      Object.assign(st, { before: before.toString(), expected: amountIn, injBefore: bal.toString() });
      note(`IBC ${fmtUnits(amountIn)} USDC.inj to Osmosis, hook swap with min_asset ${fmtUnits(amountIn)} allUSDC`);
      return signAndBroadcast("injective-1", ctx.wallet, res.txs[0].cosmos_tx.msgs.map(skipMsgToAny), note, onSigned, ctx.signOpts);
    },
    async arrive(ctx, st, note) {
      await track("injective-1", st.tx.hash, note);
      return waitArrival(() => osmoAll(ctx), BigInt(st.before), st.expected, "allUSDC", ARRIVAL_POLLS);
    },
    /* the packet was acked with an error or timed out: USDC.inj is back on Injective and allUSDC never arrived. The
       refund follows the ack by a few blocks to minutes, so this polls for up to 10 minutes before answering no. */
    async refunded(ctx, st) {
      for (let i = 0; i < 60; i++) {
        const [inj, all] = await Promise.all([injUsdc(ctx), osmoAll(ctx)]);
        if (all - BigInt(st.before) >= BigInt(st.amountIn) / 2n) return false;   // allUSDC did arrive: not a refund
        if (inj >= BigInt(st.amountIn)) return true;
        await sleep(10000);
      }
      return false;
    },
  },
};
export const ORDER = ["A1", "A2", "A3"];

/* The transmuter is 1:1 with no fee, so the hook swap's minimum is raised to the full amount: a short fill reverts
   the swap, the packet is acked with an error and USDC.inj is refunded, instead of the loop landing short. */
export function tightenMinAsset(res, amountIn) {
  const m = res.txs[0].cosmos_tx.msgs[0], j = JSON.parse(m.msg), memo = JSON.parse(j.memo);
  const ma = memo?.wasm?.msg?.swap_and_action?.min_asset?.native;
  if (!ma || ma.denom !== K.ALL) throw halt("hook memo has no allUSDC min_asset to tighten");
  if (BigInt(ma.amount) < BigInt(amountIn)) ma.amount = String(amountIn);
  j.memo = JSON.stringify(memo); m.msg = JSON.stringify(j);
}
