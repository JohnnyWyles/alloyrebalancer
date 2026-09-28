/* The noble -> inj loop, headless, in two implementations.
 *
 * CCTP (the default): every message is built here and every bridge is relayed by the bot itself; Skip is not involved.
 *   C1  Osmosis:      allUSDC -> USDC.noble (1:1 on pool 3497) + IBC to Noble's orbiter, which burns via CCTP v1
 *   C1m Avalanche:    mint that burn (MessageTransmitter v1.receiveMessage with Circle's attestation)
 *   C2  Avalanche:    burn with TokenMessengerV2.depositForBurn toward Injective EVM (standard finality, no fee)
 *   C2m Injective EVM: mint it (MessageTransmitterV2.receiveMessage)
 *   C3  Injective:    IBC the USDC.inj to our own Osmosis address, no memo
 *   C3s Osmosis:      USDC.inj -> allUSDC, 1:1 on pool 3497
 *
 * Skip (--skip): the page's A1/A2/A3 with Keplr and the confirm sheets replaced by the bot's own signer and a journal.
 * Every Skip response goes through the page's validator before anything is signed, and a refusal halts.
 *   A1  Osmosis:   allUSDC -> USDC.noble (own 1:1 swap on pool 3497) + Skip's IBC to Noble's orbiter, CCTP v1 -> Avalanche
 *   A2  Avalanche: USDC -> Injective USDC.inj (Skip's CCTP v2 adapter)
 *   A3  Injective: USDC.inj -> IBC -> Osmosis, ibc-hooks swap into allUSDC on pool 3497
 *
 * A stage's send() records { before, expected } and then the signed tx (hash + raw bytes) before broadcast. arrive()
 * watches the destination balance until it rises (Skip's status only reports failures). refunded() says whether a
 * failed stage's funds are provably back where the stage started, which is the only condition under which the runner
 * signs that stage again.
 */
import { P } from "./page.mjs";
import { signAndBroadcast, evmSend, sendRawEvm, cosmosTxState, evmTxState, rebroadcastCosmos, waitCosmosTx, waitReceiptFast } from "./sign.mjs";
import { headroom, readPool } from "./chain.mjs";
import { CCTP, orbiterMemo, depositForBurnV2Calldata, receiveMessageCalldata, parseMessageV1, parseMessageV2, checkBurnV1, checkBurnV2,
         messageFromReceipt, waitAttestation, v1NonceKey, nonceUsed, cctpSelfCheck, packetSeqOf, findNobleReceipt, checkNobleBurn } from "./cctp.mjs";

const { K, Any, MsgSwapExactAmountIn, MsgTransfer, skipMsgToAny, skipRoute, validateNobleToHub, validateHubToInj, validateInjToAll, assertChannel, checkOrbiterMemo,
        bankBalance, erc20BalanceOf, erc20Allowance, approvalPlan, approveCalldata, skipTrack, skipStatus, lcdGet, rpc, fmtUnits, sleep } = P;

const AVAX = "43114", H = K.HUB[AVAX];
export const halt = msg => Object.assign(new Error(msg), { halt: true });
export const wait = (msg, until) => Object.assign(new Error(msg), { wait: true, until });
/* Arrival is decided by the destination balance, polled every ARRIVAL_POLL_MS from the moment the stage's tx has
   landed. Skip's status runs alongside only to surface a terminal error it reports; it is not waited for, because it
   trails the real delivery (by about a minute on the Avalanche -> Injective CCTP v2 mint). An unreachable status API
   is not a failure. A failed balance read propagates, so the runner treats it as transient and waits again. */
const ARRIVAL_POLL_MS = 2000;
const ARRIVAL_MAX_MS = 75 * 60000;   // the old bound: up to 45 min of Skip status plus 30 min of balance polling
const SKIP_POLL_MS = 6000;
const SKIP_OK = new Set(["STATE_COMPLETED", "STATE_COMPLETED_SUCCESS"]);
export async function watchArrival({ read, before, expected, what, status = null, note = () => {}, pollMs = ARRIVAL_POLL_MS, maxMs = ARRIVAL_MAX_MS,
                                     skipPollMs = SKIP_POLL_MS, sleepFn = sleep, now = () => Date.now() }) {
  let failed = null, done = false;
  if (status) (async () => {
    let last = "";
    while (!done) {
      let s; try { s = await status(); } catch { await sleepFn(skipPollMs); continue; }
      if (s === null) return;   // tracking unavailable: the balance alone decides
      if (s.state !== last) { note("Skip: " + s.state); last = s.state; }
      if (P.TERMINAL.has(s.state)) {
        if (!SKIP_OK.has(s.state)) failed = new Error(`Skip reports ${s.state}: ${JSON.stringify(s.error || s.transfer_asset_release || "")}`);
        return;
      }
      await sleepFn(skipPollMs);
    }
  })().catch(() => {});
  try {
    const t0 = now();
    for (;;) {
      const received = BigInt(await read()) - BigInt(before);
      if (P.nearly(received, expected)) return received.toString();
      if (failed) throw failed;
      if (now() - t0 >= maxMs) throw new Error(`${what} rose by only ${fmtUnits(received > 0n ? received : 0n)}; expected ${fmtUnits(expected)}.`);
      await sleepFn(pollMs);
    }
  } finally { done = true; }
}
/* Skip's status for a landed tx, as a poller for watchArrival: null when tracking cannot be registered */
const skipStatusOf = (chain, hash, note) => {
  let registered = null;
  return async () => {
    if (registered === null) {
      try { await skipTrack(chain, hash); registered = true; }
      catch (e) { note(`Skip tracking unavailable (${e.message}); watching the balance instead`); registered = false; }
    }
    return registered ? skipStatus(chain, hash) : null;
  };
};
const arrival = (ctx, st, note, chain, read, what) => watchArrival({ read, before: st.before, expected: st.expected, what, note,
  status: chain ? skipStatusOf(chain, st.tx.hash, note) : null });
/* A refused route has signed nothing, so the runner asks Skip again (Skip sometimes answers with a detour it does not
   offer a minute later). The validator still decides every answer; a refusal that keeps coming back halts. */
export const requote = msg => Object.assign(new Error(msg), { requote: true });
const refused = v => requote("route refused: " + v.errs.join("; "));

const avaxUsdc = ctx => erc20BalanceOf(AVAX, H.usdc, ctx.W.evm);
const injUsdc = ctx => bankBalance("injective-1", ctx.W.inj, K.INJ_ERC20);
const osmoAll = ctx => bankBalance("osmosis-1", ctx.W.osmo, K.ALL);
const osmoNoble = ctx => bankBalance("osmosis-1", ctx.W.osmo, K.NOBLE);
const osmoInj = ctx => bankBalance("osmosis-1", ctx.W.osmo, K.INJ_IBC);
/* a definitive "this stage did not deliver" that is not a balance timeout: the runner then asks refunded() */
const arrivalFailed = msg => Object.assign(new Error(msg), { arrivalFailed: true });
const IBC_TIMEOUT_MS = 60 * 60000;   // an unrelayed packet times out (and refunds) after an hour
const ibcTimeout = () => String((BigInt(Date.now()) + BigInt(IBC_TIMEOUT_MS)) * 1000000n);
const INJ_EVM = K.INJ_EVM_CHAIN;

async function needRateRoom(denom, direction, channel, amount, ctx) {
  const h = await headroom(denom, direction, channel, ctx.cfg.rate_limit_margin_pct);
  const need = BigInt(amount);
  if (h.room !== null && h.room < need)
    throw wait(`IBC rate limit ${h.quota}: ${fmtUnits(h.room)} of ${direction === "in" ? "inflow" : "outflow"} room left, this stage needs ${fmtUnits(need)}; waiting for the window to reset`, h.resetsAt);
}

/* every stage that swaps through pool 3497 (A1 out of it, A3 and N0 into it) re-checks its health right before signing:
   a transmuter frozen, marked corrupted or given limiters mid-loop makes the stage wait, never sign into it */
async function needHealthyPool() {
  const p = await readPool();
  const why = !p.active ? "inactive (frozen)" : p.corrupted.length ? `holding corrupted denoms ${p.corrupted.join(", ")}` : p.limiters.length ? `carrying ${p.limiters.length} limiter(s)` : null;
  if (why) throw wait(`pool ${K.POOL} is ${why}; this stage waits until it is healthy`, Date.now() + 10 * 60000);
}

/* cosmos stages share the "how did the recorded tx end" logic; the EVM stages share theirs */
const cosmosTx = chain => ({
  async state(tx) { return (await cosmosTxState(chain, tx.hash, tx.timeoutHeight)).state; },
  async rebroadcast(tx) { await rebroadcastCosmos(chain, tx.raw); await waitCosmosTx(chain, tx.hash, tx.timeoutHeight); },
});
const evmTx = chain => ({
  async state(tx, ctx) { return evmTxState(chain, tx.hash, tx.nonce, ctx.W.evm); },
  /* the same signed bytes again. A deterministic refusal with the hash unknown (e.g. its max fee is now below the base
     fee after the node dropped it) means it can never land as signed, so the runner may sign it again */
  async rebroadcast(tx) {
    const r = await sendRawEvm(chain, tx.raw, tx.hash);
    if (r.refused) throw Object.assign(new Error(`recorded tx ${tx.hash} is refused on rebroadcast: ${r.refused}`), { txExpired: true });
    await waitReceiptFast(chain, tx.hash, 15 * 60 * 1000);
  },
});
const evmOpts = (ctx, chain) => ({ ...ctx.signOpts, maxFeeGwei: chain === AVAX ? ctx.cfg.avax_max_fee_gwei : ctx.cfg.inj_evm_max_fee_gwei });

/* Mint a burn Circle has attested, on `chain`, through `transmitter`. `check` validates the attested message and returns
   its used-nonce key. Only our address may mint (destinationCaller), so a nonce that is already used was minted by an
   earlier attempt of this stage: then nothing is sent and arrival is judged from the balance that mint left. */
async function mintAttested(ctx, st, note, onSigned, { chain, transmitter, sourceDomain, srcTx, pick, check, read, what }) {
  const att = await waitAttestation(sourceDomain, srcTx, pick, { note });
  if (!att) throw wait(`Circle has not attested ${srcTx} yet; checking again shortly`, Date.now() + 30000);
  const key = check(att.message);
  const bal = await read();
  if (await nonceUsed(chain, transmitter, key)) {
    if (bal < BigInt(st.amountIn)) throw halt(`the burn from ${srcTx} is already minted but ${what} holds only ${fmtUnits(bal)}; look before resuming`);
    Object.assign(st, { before: (bal - BigInt(st.amountIn)).toString(), expected: st.amountIn });
    note(`already minted (nonce used); ${what} holds ${fmtUnits(bal)}`);
    return { alreadyMinted: true };
  }
  Object.assign(st, { before: bal.toString(), expected: st.amountIn });
  note(`minting ${fmtUnits(st.amountIn)} on ${K.EVM[chain].name} with Circle's attestation`);
  return evmSend(chain, ctx.wallet, { to: transmitter, data: receiveMessageCalldata(att.message, att.attestation), value: 0 }, note, onSigned, evmOpts(ctx, chain));
}

export const STAGES = {
  A1: {
    title: "Osmosis: allUSDC -> USDC.noble (pool 3497) -> Noble -> CCTP v1 -> Avalanche USDC",
    ...cosmosTx("osmosis-1"),
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn;
      // after a refunded IBC hop (refunded() below) the USDC.noble is already on Osmosis: send it again without swapping more
      // the checks and the quote are independent reads, so they run together; every one must pass before anything is signed
      const [noble, all, , , , before, res] = await Promise.all([osmoNoble(ctx), osmoAll(ctx), needHealthyPool(),
        assertChannel("osmosis-1", K.OSMO_TO_NOBLE, "noble-1"), needRateRoom(K.NOBLE, "out", K.OSMO_TO_NOBLE, amountIn, ctx), avaxUsdc(ctx),
        skipRoute(K.NOBLE, "osmosis-1", H.usdc, AVAX, amountIn, { "osmosis-1": ctx.W.osmo, "noble-1": ctx.W.noble, [AVAX]: ctx.W.evm })]);
      const resend = st.refunds > 0 && noble >= BigInt(amountIn);
      if (!resend && all < BigInt(amountIn)) throw halt(`allUSDC balance is below the ${fmtUnits(amountIn)} this loop was started with`);
      const v = validateNobleToHub(res, { osmo: ctx.W.osmo, evm: ctx.W.evm, amountIn, hub: AVAX }); if (!v.ok) throw refused(v);
      Object.assign(st, { before: before.toString(), expected: v.amountOut });
      const anys = [
        ...(resend ? [] : [Any("/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn", MsgSwapExactAmountIn({ sender: ctx.W.osmo, routes: [{ poolId: K.POOL, tokenOutDenom: K.NOBLE }],
          tokenIn: { denom: K.ALL, amount: amountIn }, tokenOutMinAmount: amountIn }))]),   // 1:1 or the whole tx fails
        skipMsgToAny(res.txs[0].cosmos_tx.msgs[0]),
      ];
      note(`${resend ? `resend the refunded ${fmtUnits(amountIn)} USDC.noble` : `swap ${fmtUnits(amountIn)} allUSDC -> USDC.noble`}, IBC to Noble orbiter, ${fmtUnits(v.amountOut)} USDC expected on Avalanche`);
      return signAndBroadcast("osmosis-1", ctx.wallet, anys, note, onSigned, ctx.signOpts);
    },
    async arrive(ctx, st, note) { return arrival(ctx, st, note, "osmosis-1", () => avaxUsdc(ctx), "Avalanche USDC"); },
    /* the IBC hop to Noble was acked with an error or timed out: the USDC.noble is back on Osmosis and nothing reached
       Avalanche. Polls up to 10 minutes, since the refund follows the ack. */
    async refunded(ctx, st) {
      for (let i = 0; i < 60; i++) {
        const [noble, avax] = await Promise.all([osmoNoble(ctx), avaxUsdc(ctx)]);
        if (avax - BigInt(st.before) >= BigInt(st.amountIn) / 2n) return false;   // it did arrive: not a refund
        if (noble >= BigInt(st.amountIn)) return true;
        await sleep(10000);
      }
      return false;
    },
  },

  /* recovery only: USDC.noble found on Osmosis with no loop in flight goes back into the alloy at exactly 1:1 */
  N0: {
    title: "Osmosis: USDC.noble -> allUSDC (pool 3497), recovery",
    ...cosmosTx("osmosis-1"),
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn, bal = await osmoNoble(ctx);
      await needHealthyPool();
      if (bal < BigInt(amountIn)) throw halt(`USDC.noble balance ${fmtUnits(bal)} is below the ${fmtUnits(amountIn)} this recovery expects`);
      Object.assign(st, { before: (await osmoAll(ctx)).toString(), expected: amountIn });
      note(`swap ${fmtUnits(amountIn)} USDC.noble -> allUSDC on pool ${K.POOL}, minimum out ${fmtUnits(amountIn)}`);
      return signAndBroadcast("osmosis-1", ctx.wallet, [Any("/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn", MsgSwapExactAmountIn({ sender: ctx.W.osmo,
        routes: [{ poolId: K.POOL, tokenOutDenom: K.ALL }], tokenIn: { denom: K.NOBLE, amount: amountIn }, tokenOutMinAmount: amountIn }))], note, onSigned, ctx.signOpts);
    },
    async arrive(ctx, st, note) { return arrival(ctx, st, note, null, () => osmoAll(ctx), "allUSDC"); },
    async refunded() { return false; },   // a swap either lands or fails in block; there is nothing to refund
  },

  A2: {
    title: "Avalanche: USDC -> Injective USDC.inj (CCTP v2)",
    async state(tx, ctx) { return evmTxState(AVAX, tx.hash, tx.nonce, ctx.W.evm); },
    /* the same signed bytes again. A deterministic refusal with the hash unknown (e.g. its max fee is now below the base
       fee after the node dropped it) means it can never land as signed, so the runner may sign it again */
    async rebroadcast(tx) {
      const r = await sendRawEvm(AVAX, tx.raw, tx.hash);
      if (r.refused) throw Object.assign(new Error(`recorded burn ${tx.hash} is refused on rebroadcast: ${r.refused}`), { txExpired: true });
      await waitReceiptFast(AVAX, tx.hash, 15 * 60 * 1000);
    },
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn;
      const [bal, before, res] = await Promise.all([avaxUsdc(ctx), injUsdc(ctx),
        skipRoute(H.usdc, AVAX, K.INJ_EVM_USDC, K.INJ_EVM_CHAIN, amountIn, { [AVAX]: ctx.W.evm, [K.INJ_EVM_CHAIN]: ctx.W.injHex })]);
      if (bal < BigInt(amountIn)) throw halt(`Avalanche USDC balance ${fmtUnits(bal)} is below the ${fmtUnits(amountIn)} this stage expects`);
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
    async arrive(ctx, st, note) { return arrival(ctx, st, note, AVAX, () => injUsdc(ctx), "Injective USDC.inj"); },
    async refunded() { return false; },   // a burn is final; if the mint is late a human looks at it
  },

  A3: {
    title: "Injective: USDC.inj -> Osmosis, hook swap into allUSDC (pool 3497)",
    ...cosmosTx("injective-1"),
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn;
      const [bal, , , , before, res] = await Promise.all([injUsdc(ctx), assertChannel("injective-1", K.INJ_TO_OSMO, "osmosis-1"), needHealthyPool(),
        needRateRoom(K.INJ_IBC, "in", K.OSMO_TO_INJ, amountIn, ctx), osmoAll(ctx),
        skipRoute(K.INJ_ERC20, "injective-1", K.ALL, "osmosis-1", amountIn, { "injective-1": ctx.W.inj, "osmosis-1": ctx.W.osmo })]);
      if (bal < BigInt(amountIn)) throw halt(`Injective USDC.inj balance ${fmtUnits(bal)} is below the ${fmtUnits(amountIn)} this stage expects`);
      const v = validateInjToAll(res, { inj: ctx.W.inj, osmo: ctx.W.osmo, amountIn }); if (!v.ok) throw refused(v);
      if (BigInt(v.amountOut || 0) < BigInt(amountIn)) throw requote(`Skip quotes ${fmtUnits(v.amountOut)} allUSDC for ${fmtUnits(amountIn)} USDC.inj through a 1:1 transmuter`);
      tightenMinAsset(res, amountIn);
      const v2 = validateInjToAll(res, { inj: ctx.W.inj, osmo: ctx.W.osmo, amountIn }); if (!v2.ok) throw refused(v2);
      Object.assign(st, { before: before.toString(), expected: amountIn, injBefore: bal.toString() });
      note(`IBC ${fmtUnits(amountIn)} USDC.inj to Osmosis, hook swap with min_asset ${fmtUnits(amountIn)} allUSDC`);
      return signAndBroadcast("injective-1", ctx.wallet, res.txs[0].cosmos_tx.msgs.map(skipMsgToAny), note, onSigned, ctx.signOpts);
    },
    async arrive(ctx, st, note) { return arrival(ctx, st, note, "injective-1", () => osmoAll(ctx), "allUSDC"); },
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

  /* ---------------- CCTP (default): no Skip, the bot relays both bridges itself ---------------- */
  C1: {
    title: "Osmosis: allUSDC -> USDC.noble (pool 3497) -> Noble orbiter, CCTP v1 burn toward Avalanche",
    ...cosmosTx("osmosis-1"),
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn;
      // after a refunded IBC hop (refunded() below) the USDC.noble is already on Osmosis: send it again without swapping more
      const [noble, all] = await Promise.all([osmoNoble(ctx), osmoAll(ctx), needHealthyPool(), cctpSelfCheck(),
        assertChannel("osmosis-1", K.OSMO_TO_NOBLE, "noble-1"), needRateRoom(K.NOBLE, "out", K.OSMO_TO_NOBLE, amountIn, ctx)]);
      const resend = st.refunds > 0 && noble >= BigInt(amountIn);
      if (!resend && all < BigInt(amountIn)) throw halt(`allUSDC balance is below the ${fmtUnits(amountIn)} this loop was started with`);
      const memo = orbiterMemo(ctx.W.evm, H.cctpDomain), errs = [];
      checkOrbiterMemo(errs, JSON.parse(memo), H, ctx.W.evm);   // the page's own orbiter check, on the memo we built
      if (errs.length) throw halt("orbiter memo refused: " + errs.join("; "));
      Object.assign(st, { expected: amountIn });
      const anys = [
        ...(resend ? [] : [Any("/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn", MsgSwapExactAmountIn({ sender: ctx.W.osmo, routes: [{ poolId: K.POOL, tokenOutDenom: K.NOBLE }],
          tokenIn: { denom: K.ALL, amount: amountIn }, tokenOutMinAmount: amountIn }))]),   // 1:1 or the whole tx fails
        Any("/ibc.applications.transfer.v1.MsgTransfer", MsgTransfer({ sourcePort: "transfer", sourceChannel: K.OSMO_TO_NOBLE, token: { denom: K.NOBLE, amount: amountIn },
          sender: ctx.W.osmo, receiver: K.NOBLE_ORBITER, timeoutHeight: {}, timeoutTimestamp: ibcTimeout(), memo })),
      ];
      note(`${resend ? `resend the refunded ${fmtUnits(amountIn)} USDC.noble` : `swap ${fmtUnits(amountIn)} allUSDC -> USDC.noble`}, IBC to the Noble orbiter for a CCTP burn to ${ctx.W.evm} on Avalanche`);
      return signAndBroadcast("osmosis-1", ctx.wallet, anys, note, onSigned, ctx.signOpts);
    },
    /* arrival is the orbiter's burn on Noble: find the tx that received our packet, then check its ack and the burn */
    async arrive(ctx, st, note) {
      if (st.packet?.hash !== st.tx.hash) {
        const q = await lcdGet("osmosis-1", `/cosmos/tx/v1beta1/txs/${st.tx.hash}`);
        st.packet = { hash: st.tx.hash, seq: packetSeqOf(q.tx_response, K.OSMO_TO_NOBLE) };
      }
      const t0 = Date.now();
      for (;;) {
        const r = await findNobleReceipt(st.packet.seq, K.OSMO_TO_NOBLE);
        if (r?.ackError) throw arrivalFailed(`Noble acknowledged packet ${st.packet.seq} with an error (${r.hash}): ${r.ackError}`);
        if (r) {
          const exp = { amount: st.amountIn, destinationDomain: H.cctpDomain, mintRecipient: ctx.W.evm, destinationCaller: ctx.W.evm };
          const errs = [...checkNobleBurn(r.burn, exp),
            ...checkBurnV1(parseMessageV1(r.message), { ...exp, sourceDomain: CCTP.DOMAIN["noble-1"], recipient: CCTP.TM_V1_AVAX, nonce: r.burn.nonce })];
          if (errs.length) throw halt(`the orbiter's burn in ${r.hash} is not what C1 asked for: ${errs.join("; ")}`);
          note(`Noble burned ${fmtUnits(r.burn.amount)} (tx ${r.hash}, CCTP nonce ${r.burn.nonce})`);
          st.carry = { nobleTx: r.hash, nonce: String(r.burn.nonce) };
          return String(r.burn.amount);
        }
        if (Date.now() - t0 >= ARRIVAL_MAX_MS) throw arrivalFailed(`Noble has not received packet ${st.packet.seq} after ${ARRIVAL_MAX_MS / 60000} min`);
        await sleep(4000);
      }
    },
    /* the IBC hop was acked with an error or timed out: the USDC.noble is back on Osmosis. Polls up to 10 minutes. */
    async refunded(ctx, st) {
      for (let i = 0; i < 60; i++) { if (await osmoNoble(ctx) >= BigInt(st.amountIn)) return true; await sleep(10000); }
      return false;
    },
  },

  C1m: {
    title: "Avalanche: mint the Noble burn (CCTP v1, self-relayed)",
    ...evmTx(AVAX),
    async send(ctx, st, note, onSigned) {
      const c = st.carry;
      if (!c?.nobleTx) throw halt("C1m has no Noble burn recorded to mint");
      const exp = { sourceDomain: CCTP.DOMAIN["noble-1"], destinationDomain: H.cctpDomain, recipient: CCTP.TM_V1_AVAX, destinationCaller: ctx.W.evm,
                    mintRecipient: ctx.W.evm, amount: st.amountIn, nonce: c.nonce };
      return mintAttested(ctx, st, note, onSigned, { chain: AVAX, transmitter: CCTP.MT_V1_AVAX, sourceDomain: CCTP.DOMAIN["noble-1"], srcTx: c.nobleTx,
        pick: m => String(m.eventNonce) === c.nonce, read: () => avaxUsdc(ctx), what: "Avalanche USDC",
        check: msg => { const m = parseMessageV1(msg), e = checkBurnV1(m, exp); if (e.length) throw halt(`attested message refused: ${e.join("; ")}`); return v1NonceKey(m.sourceDomain, m.nonce); } });
    },
    async arrive(ctx, st, note) { return arrival(ctx, st, note, null, () => avaxUsdc(ctx), "Avalanche USDC"); },
    async refunded() { return false; },   // a mint either lands or is attempted again; nothing is refunded
  },

  C2: {
    title: "Avalanche: CCTP v2 burn toward Injective EVM",
    ...evmTx(AVAX),
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn;
      const [bal] = await Promise.all([avaxUsdc(ctx), cctpSelfCheck()]);
      if (bal < BigInt(amountIn)) throw halt(`Avalanche USDC balance ${fmtUnits(bal)} is below the ${fmtUnits(amountIn)} this stage expects`);
      Object.assign(st, { expected: amountIn });
      const eo = evmOpts(ctx, AVAX), have = await erc20Allowance(AVAX, H.usdc, ctx.W.evm, CCTP.TM_V2);
      for (const amt of approvalPlan(have, amountIn)) {
        note(`approving exactly ${fmtUnits(amt)} USDC to TokenMessengerV2`);
        await evmSend(AVAX, ctx.wallet, { to: H.usdc, data: approveCalldata(CCTP.TM_V2, amt), value: 0 }, note, async () => {}, eo);   // an approval moves nothing
      }
      note(`CCTP v2 burn of ${fmtUnits(amountIn)} USDC to ${ctx.W.injHex} on Injective EVM (standard finality, no fee)`);
      return evmSend(AVAX, ctx.wallet, { to: CCTP.TM_V2, value: 0, data: depositForBurnV2Calldata({ amount: amountIn, destinationDomain: CCTP.DOMAIN[INJ_EVM],
        mintRecipient: ctx.W.injHex, burnToken: H.usdc, destinationCaller: ctx.W.injHex, maxFee: 0, minFinalityThreshold: CCTP.FINALITY_STANDARD }) }, note, onSigned, eo);
    },
    /* arrival is the burn itself: its receipt must carry exactly our message */
    async arrive(ctx, st, note) {
      const r = await rpc(AVAX, "eth_getTransactionReceipt", [st.tx.hash]);
      if (!r) throw new Error(`no receipt for the burn ${st.tx.hash} yet`);   // transient: the next tick looks again
      if (r.status !== "0x1") throw Object.assign(new Error(`burn ${st.tx.hash} reverted`), { halt: true });
      const e = checkBurnV2(parseMessageV2(messageFromReceipt(r)), { sourceDomain: H.cctpDomain, destinationDomain: CCTP.DOMAIN[INJ_EVM], destinationCaller: ctx.W.injHex,
        burnToken: H.usdc, mintRecipient: ctx.W.injHex, amount: st.amountIn, messageSender: ctx.W.evm }, false);
      if (e.length) throw halt(`burn ${st.tx.hash} emitted an unexpected message: ${e.join("; ")}`);
      note(`burned ${fmtUnits(st.amountIn)} on Avalanche (tx ${st.tx.hash})`);
      st.carry = { avaxTx: st.tx.hash };
      return st.amountIn;
    },
    async refunded() { return false; },   // a burn is final
  },

  C2m: {
    title: "Injective EVM: mint the Avalanche burn (CCTP v2, self-relayed)",
    ...evmTx(INJ_EVM),
    async send(ctx, st, note, onSigned) {
      const c = st.carry;
      if (!c?.avaxTx) throw halt("C2m has no Avalanche burn recorded to mint");
      const exp = { sourceDomain: H.cctpDomain, destinationDomain: CCTP.DOMAIN[INJ_EVM], destinationCaller: ctx.W.injHex, burnToken: H.usdc,
                    mintRecipient: ctx.W.injHex, amount: st.amountIn, messageSender: ctx.W.evm };
      return mintAttested(ctx, st, note, onSigned, { chain: INJ_EVM, transmitter: CCTP.MT_V2, sourceDomain: H.cctpDomain, srcTx: c.avaxTx,
        pick: m => { try { return checkBurnV2(parseMessageV2(m.message), exp, false).length === 0; } catch { return false; } },
        read: () => injUsdc(ctx), what: "Injective USDC.inj",
        check: msg => { const m = parseMessageV2(msg), e = checkBurnV2(m, exp, true); if (e.length) throw halt(`attested message refused: ${e.join("; ")}`); return m.nonce; } });
    },
    async arrive(ctx, st, note) { return arrival(ctx, st, note, null, () => injUsdc(ctx), "Injective USDC.inj"); },
    async refunded() { return false; },
  },

  C3: {
    title: "Injective: USDC.inj -> IBC -> our Osmosis address",
    ...cosmosTx("injective-1"),
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn;
      const [bal, , , before] = await Promise.all([injUsdc(ctx), assertChannel("injective-1", K.INJ_TO_OSMO, "osmosis-1"),
        needRateRoom(K.INJ_IBC, "in", K.OSMO_TO_INJ, amountIn, ctx), osmoInj(ctx)]);
      if (bal < BigInt(amountIn)) throw halt(`Injective USDC.inj balance ${fmtUnits(bal)} is below the ${fmtUnits(amountIn)} this stage expects`);
      Object.assign(st, { before: before.toString(), expected: amountIn });
      note(`IBC ${fmtUnits(amountIn)} USDC.inj to ${ctx.W.osmo}`);
      return signAndBroadcast("injective-1", ctx.wallet, [Any("/ibc.applications.transfer.v1.MsgTransfer", MsgTransfer({ sourcePort: "transfer", sourceChannel: K.INJ_TO_OSMO,
        token: { denom: K.INJ_ERC20, amount: amountIn }, sender: ctx.W.inj, receiver: ctx.W.osmo, timeoutHeight: {}, timeoutTimestamp: ibcTimeout(), memo: "" }))], note, onSigned, ctx.signOpts);
    },
    async arrive(ctx, st, note) { return arrival(ctx, st, note, null, () => osmoInj(ctx), "USDC.inj on Osmosis"); },
    /* the packet was acked with an error or timed out: USDC.inj is back on Injective. Polls up to 10 minutes. */
    async refunded(ctx, st) {
      for (let i = 0; i < 60; i++) {
        const [inj, osmo] = await Promise.all([injUsdc(ctx), osmoInj(ctx)]);
        if (osmo - BigInt(st.before) >= BigInt(st.amountIn) / 2n) return false;   // it did arrive: not a refund
        if (inj >= BigInt(st.amountIn)) return true;
        await sleep(10000);
      }
      return false;
    },
  },

  /* the loop's last CCTP stage, and the recovery for USDC.inj found on Osmosis with no loop in flight */
  C3s: {
    title: "Osmosis: USDC.inj -> allUSDC (pool 3497)",
    ...cosmosTx("osmosis-1"),
    async send(ctx, st, note, onSigned) {
      const amountIn = st.amountIn;
      const [bal] = await Promise.all([osmoInj(ctx), needHealthyPool()]);
      if (bal < BigInt(amountIn)) throw halt(`USDC.inj balance on Osmosis ${fmtUnits(bal)} is below the ${fmtUnits(amountIn)} this stage expects`);
      Object.assign(st, { before: (await osmoAll(ctx)).toString(), expected: amountIn });
      note(`swap ${fmtUnits(amountIn)} USDC.inj -> allUSDC on pool ${K.POOL}, minimum out ${fmtUnits(amountIn)}`);
      return signAndBroadcast("osmosis-1", ctx.wallet, [Any("/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn", MsgSwapExactAmountIn({ sender: ctx.W.osmo,
        routes: [{ poolId: K.POOL, tokenOutDenom: K.ALL }], tokenIn: { denom: K.INJ_IBC, amount: amountIn }, tokenOutMinAmount: amountIn }))], note, onSigned, ctx.signOpts);
    },
    async arrive(ctx, st, note) { return arrival(ctx, st, note, null, () => osmoAll(ctx), "allUSDC"); },
    async refunded() { return false; },   // a swap either lands or fails in block
  },
};
export const SKIP_ORDER = ["A1", "A2", "A3"];
export const CCTP_ORDER = ["C1", "C1m", "C2", "C2m", "C3", "C3s"];
/* a journal written before cycles recorded their order is a Skip loop */
export const ORDER = SKIP_ORDER;
/* where each order picks up funds found outside the alloy (see cycle.mjs planRecovery) */
export const RECOVERY_STARTS = { skip: { avaxUsdc: "A2", injUsdc: "A3" }, cctp: { avaxUsdc: "C2", injUsdc: "C3" } };

/* The transmuter is 1:1 with no fee, so the hook swap's minimum is raised to the full amount: a short fill reverts
   the swap, the packet is acked with an error and USDC.inj is refunded, instead of the loop landing short. */
export function tightenMinAsset(res, amountIn) {
  const m = res.txs[0].cosmos_tx.msgs[0], j = JSON.parse(m.msg), memo = JSON.parse(j.memo);
  const ma = memo?.wasm?.msg?.swap_and_action?.min_asset?.native;
  if (!ma || ma.denom !== K.ALL) throw requote("route refused: hook memo has no allUSDC min_asset to tighten");
  if (BigInt(ma.amount) < BigInt(amountIn)) ma.amount = String(amountIn);
  j.memo = JSON.stringify(memo); m.msg = JSON.stringify(j);
}
