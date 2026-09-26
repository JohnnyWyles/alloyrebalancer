/* Tests for the headless bot.
 *
 *   signing   keys, SignDoc bytes and signatures against @cosmjs/proto-signing (Osmosis) and ethers v6 (Injective
 *             keccak signing, EIP-1559 raw txs), generated once into ../test-fixtures/bot-signing-golden.json
 *   decision  deficit math, rate-limit headroom, the A3 min_asset tightening on a real Skip response
 *   runner    the resume / retry / halt rules of cycle.mjs, driven with fake stages
 *
 *   node test.mjs
 */
import fs from "node:fs";
import { P } from "./page.mjs";
import { deriveWallet, SignDoc, signCosmosBytes, signEip1559, rlp, sendRawEvm } from "./sign.mjs";
import { deficit, sharePct, quotaRoom, gasSpec } from "./chain.mjs";
import { tightenMinAsset, watchArrival } from "./stages.mjs";
import { makeRunner, MAX_SIGNED_ATTEMPTS, ALERT_REQUOTES, fitsFeeCap, loopLossBound, cycleLossBound, nextUtcMidnight, planRecovery } from "./cycle.mjs";

const FIX = p => JSON.parse(fs.readFileSync(new URL("../test-fixtures/" + p, import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log("  FAIL  " + name); } };
const hex = u => Buffer.from(u).toString("hex");
const unhex = h => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const rejects = async (p, re, name) => { try { await p; ok(false, name + " (did not throw)"); } catch (e) { ok(re.test(e.message) && (e.halt ?? true), name + ` (${e.message})`); } };

/* ---------- signing ---------- */
const G = FIX("bot-signing-golden.json");
const M = "test test test test test test test test test test test junk";
const { W, key } = deriveWallet(M);
ok(W.osmo === G.osmo, "osmo address == cosmjs");
ok(W.evm === G.evm, "0x address == ethers");
ok(W.inj === G.inj, "inj address == cosmjs toBech32 of the ethers address");
ok(W.noble === P.bech32Rehrp(G.osmo, "noble") && W.injHex === W.evm, "noble / injHex follow from the same keys");
ok(hex(key("osmosis-1").pub) === G.osmoPub, "osmosis pubkey == cosmjs");
ok(hex(key("injective-1").pub) === G.injPub, "injective compressed pubkey == ethers");
{
  const sd = unhex(G.signDoc), f = P.bytesF; // body and authInfo are the fields 1 and 2 of the golden sign doc
  const body = unhex("0a0b0a03666f6f12046261727a12185aaa01");
  const auth = unhex("0a4a0a400a1f2f636f736d6f732e63727970746f2e736563703235366b312e5075624b6579120a0a08000102030405060712040a020801180512130a0d0a0575757364631204313030301090a10f");
  ok(hex(SignDoc(body, auth, "osmosis-1", 12345)) === G.signDoc, "SignDoc bytes == cosmjs makeSignBytes");
  ok(hex(SignDoc(body, auth, "injective-1", 777)) === G.injSignDoc, "injective SignDoc bytes == cosmjs makeSignBytes");
  ok(hex(signCosmosBytes(key("osmosis-1"), sd)) === G.osmoSig, "osmosis signature == cosmjs signDirect (RFC 6979)");
  ok(hex(signCosmosBytes(key("injective-1"), unhex(G.injSignDoc))) === G.injSig, "injective signature == ethers keccak256 signing");
  ok(hex(SignDoc(body, auth, "osmosis-1", 0)).endsWith(hex(P.strF(3, "osmosis-1"))), "account number 0 is omitted (proto3 default)");
  void f;
}
{
  const t = G.evmTx, k = key("evm");
  const tx = { chainId: BigInt(t.chainId), nonce: BigInt(t.nonce), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas), maxFeePerGas: BigInt(t.maxFeePerGas), gas: BigInt(t.gasLimit), to: t.to, value: 0, data: t.data };
  const s = signEip1559(k.priv, tx);
  ok(s.raw === G.evmRaw, "EIP-1559 raw tx == ethers signTransaction");
  ok(s.hash === G.evmHash, "EIP-1559 tx hash == ethers");
  const t0 = G.evmTx0;
  const s0 = signEip1559(k.priv, { ...tx, nonce: 0n, value: 1n, data: "0x" });
  ok(s0.raw === G.evmRaw0, "EIP-1559 with nonce 0, value 1, empty data == ethers");
  void t0;
  ok(hex(rlp(new Uint8Array(0))) === "80" && hex(rlp(Uint8Array.of(0x7f))) === "7f" && hex(rlp([])) === "c0", "rlp edge cases");
  ok(hex(rlp(new Uint8Array(56).fill(1))).startsWith("b838"), "rlp long string length prefix");
}
let bad = false; try { deriveWallet("test test test"); } catch { bad = true; }
ok(bad, "invalid mnemonic refused");

/* ---------- EVM send classification: only a confirmed refusal may be forgotten ---------- */
{
  const fake = (send, byHash = null, receipt = null) => async (url, method) => {
    if (method === "eth_sendRawTransaction") { if (send instanceof Error) throw send; return send; }
    if (byHash instanceof Error) throw byHash;
    return method === "eth_getTransactionByHash" ? { result: byHash } : { result: receipt };
  };
  const go = f => sendRawEvm("43114", "0x02", "0xabc", f);
  ok((await go(fake(new Error("fetch failed")))).ambiguous, "transport error (timeout, reset) is ambiguous, not a refusal");
  ok((await go(fake({ result: "0xabc" }))).accepted, "a hash result is accepted");
  ok((await go(fake({ error: { message: "already known" } }))).accepted, "already known is accepted");
  ok((await go(fake({ error: { message: "nonce too low" } }))).ambiguous, "nonce too low is ambiguous (may be this tx, mined)");
  ok((await go(fake({ error: { message: "insufficient funds for gas * price + value" } }))).refused, "explicit refusal with an unknown hash is a refusal");
  ok((await go(fake({ error: { message: "insufficient funds" } }, { hash: "0xabc" }))).accepted, "explicit error but the node knows the hash: accepted");
  ok((await go(fake({ error: { message: "insufficient funds" } }, new Error("timeout")))).ambiguous, "explicit error but the hash lookup failed: ambiguous");
  for (const m of ["internal error", "rate limit exceeded", "429 Too Many Requests", "upstream request timeout", "header not found", "replacement transaction underpriced"])
    ok((await go(fake({ error: { code: -32000, message: m } }))).ambiguous, `provider/pool error "${m}" with an unknown hash stays ambiguous`);
  ok((await go(fake({ error: { message: "max fee per gas less than block base fee: address 0x.., maxFeePerGas: 1, baseFee: 2" } }))).refused, "deterministic fee-cap refusal is a refusal");
  // Ethereum has two RPCs: a transport failure on the first poisons a refusal from the second
  let n = 0;
  const twoRpc = async (url, method) => { if (method === "eth_sendRawTransaction") { if (n++ === 0) throw new Error("socket hang up"); return { error: { message: "insufficient funds" } }; } return { result: null }; };
  ok((await sendRawEvm("1", "0x02", "0xabc", twoRpc)).ambiguous, "a refusal after a transport error on another RPC stays ambiguous");
}

/* ---------- decision math ---------- */
{
  const pool = { total: 1710533581167n, inj: 160153798883n };
  const d50 = deficit(pool, 50);
  ok((pool.inj + d50) * 2n >= pool.total && (pool.inj + d50 - 1n) * 2n < pool.total, "deficit lifts the share to exactly 50%");
  ok(deficit(pool, 100) === pool.total - pool.inj, "100% target needs every non-inj unit");
  ok(deficit({ total: 1000n, inj: 600n }, 50) === 0n, "no deficit above target");
  ok(Math.abs(sharePct(pool) - 9.3627) < 0.001, "share percentage");
}
{
  const now = BigInt(Date.now()) * 1000000n, later = String(now + 3600n * 1000000000n), past = String(now - 1000n);
  const q = (inflow, outflow, end, recv = 100, send = 25) => ({ quota: { name: "q", max_percentage_recv: recv, max_percentage_send: send, channel_value: "1000000" }, flow: { inflow, outflow, period_end: end } });
  ok(quotaRoom(q("300000", "100000", later), "in", now).room === 800000n, "inflow room is cap minus NET inflow");
  ok(quotaRoom(q("100000", "300000", later), "in", now).room === 1000000n, "net outflow leaves the full inflow cap");
  ok(quotaRoom(q("0", "200000", later), "out", now).room === 50000n, "outflow room at 25% send");
  ok(quotaRoom(q("0", "900000", later), "out", now).room === 0n, "exhausted quota has no room");
  // channel_value is 1,000,000 in the stale cache; the window resets to the current supply (here 600,000)
  ok(quotaRoom(q("999999", "0", past), "in", now, 600000n).room === 600000n && quotaRoom(q("999999", "0", past), "in", now, 600000n).resetsAt === null, "expired window is sized from the supply it will reset to, not the stale cache");
  let threw = false; try { quotaRoom(q("0", "0", past), "in", now); } catch { threw = true; }
  ok(threw, "an expired window without a current supply is refused, never guessed");
  ok(quotaRoom(q("300000", "100000", later), "in", now, 1n).room === 800000n, "a live window ignores the supply and uses its own snapshot");
  ok(quotaRoom(q("1", "0", later), "in", now).resetsAt === Number(BigInt(later) / 1000000n), "resetsAt is the window end in ms");
  ok(quotaRoom(q("300000", "100000", later), "in", now, undefined, 8).room === 720000n, "reserve keeps 8% of the cap free: 920,000 usable minus 200,000 net inflow");
  ok(quotaRoom(q("100000", "300000", later), "in", now, undefined, 8).room === 920000n, "net outflow leaves the reserved cap, not the full cap");
  ok(quotaRoom(q("0", "240000", later), "out", now, undefined, 8).room === 0n, "net flow inside the reserve leaves no room");
  ok(quotaRoom(q("999999", "0", past), "in", now, 600000n, 8).room === 552000n, "an expired window's reset size is reserved too");
  const reset = { quota: { name: "r", max_percentage_recv: 100, max_percentage_send: 25, channel_value: null }, flow: { inflow: "0", outflow: "0", period_end: later } };
  ok(quotaRoom(reset, "in", now, 600000n).room === 600000n, "a freshly reset quota (null channel_value) is sized from the supply it will snapshot");
  ok(quotaRoom(reset, "in", now, 600000n, 5).room === 570000n && quotaRoom(reset, "in", now, 600000n).resetsAt === Number(BigInt(later) / 1000000n), "a reset quota keeps its reserve and its live window end");
  let threwNull = false; try { quotaRoom(reset, "in", now); } catch { threwNull = true; }
  ok(threwNull, "a null channel_value without a current supply is refused, never read as zero room");
}

/* ---------- gas refill sizing ---------- */
{
  const g = gasSpec("avax", { gas_refill_usdc: { avax: 2 }, gas_min_value_pct: 80 });
  ok(g.amount === "2000000" && g.minUsd === 1.6 && g.dst[1] === "43114", "AVAX refill sized from config with a proportional floor");
  ok(P.GAS.avax.amount === "1000000" && P.GAS.avax.minUsd === 0.85, "the page's own Fund Gas entry is untouched");
  ok(gasSpec("inj", { gas_refill_usdc: {}, gas_min_value_pct: 80 }).amount === "1000000", "a target missing from config falls back to 1 allUSDC");
  let threw = false; try { gasSpec("avax", { gas_refill_usdc: { avax: 50 }, gas_min_value_pct: 80 }); } catch { threw = true; }
  ok(threw, "an oversized refill is refused");
}

/* ---------- A3 min_asset tightening on the real Skip response ---------- */
{
  const FUTURE = String((BigInt(Date.now()) + 3600000n) * 1000000n);
  const r = FIX("stage3-good.json"), m = r.txs[0].cosmos_tx.msgs[0], j = JSON.parse(m.msg), memo = JSON.parse(j.memo);
  j.timeout_timestamp = FUTURE; memo.wasm.msg.swap_and_action.timeout_timestamp = FUTURE;
  const AMT = r.route.amount_in;
  memo.wasm.msg.swap_and_action.min_asset.native.amount = String(BigInt(AMT) * 999n / 1000n);   // what the page would accept
  j.memo = JSON.stringify(memo); m.msg = JSON.stringify(j);
  const ctx3 = { inj: "inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpyurwgh", osmo: "osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0", amountIn: AMT };
  ok(P.validateInjToAll(r, ctx3).ok, "the page accepts a 99.9% min_asset");
  tightenMinAsset(r, AMT);
  const after = JSON.parse(JSON.parse(r.txs[0].cosmos_tx.msgs[0].msg).memo).wasm.msg.swap_and_action.min_asset.native;
  ok(after.amount === AMT, "the bot raises min_asset to the full amount");
  ok(P.validateInjToAll(r, ctx3).ok, "the tightened route still validates");
  ok(P.skipMsgToAny(r.txs[0].cosmos_tx.msgs[0]).length > 600, "the tightened msg still encodes");
}

/* ---------- arrival: the balance decides, Skip's status only reports failures ---------- */
{
  // a fake clock: every sleep advances it and yields, so the status poller and the balance poller interleave
  const clock = () => { const c = { t: 0 }; c.now = () => c.t; c.sleep = async ms => { c.t += ms; await new Promise(r => setImmediate(r)); }; return c; };
  const seq = vals => { let i = 0; return async () => vals[Math.min(i++, vals.length - 1)]; };
  const base = c => ({ before: "1000", expected: "500", what: "Injective USDC.inj", sleepFn: c.sleep, now: c.now, pollMs: 2000, skipPollMs: 6000, maxMs: 60000 });
  {
    const c = clock(); let statusCalls = 0;
    let reads = 0; const vals = [1000n, 1000n, 1500n];
    const r = await watchArrival({ ...base(c), read: async () => vals[Math.min(reads++, 2)], status: async () => (statusCalls++, { state: "STATE_PENDING" }) });
    ok(r === "500", "arrival returns as soon as the balance rises, while Skip still reports pending");
    ok(reads === 3, "and on the first read that shows it");
    const calls = statusCalls; await c.sleep(20000);
    ok(statusCalls === calls, "the Skip status poller stops once arrival is decided");
  }
  {
    const c = clock();
    await rejects(watchArrival({ ...base(c), read: seq([1000n]), status: async () => ({ state: "STATE_COMPLETED_ERROR", error: { message: "ack error" } }) }),
      /^Skip reports STATE_COMPLETED_ERROR/, "a terminal Skip error with no arrival fails with the message the runner judges");
  }
  {
    const c = clock();
    const r = await watchArrival({ ...base(c), read: seq([1000n, 1000n, 1000n, 1000n, 1000n, 1499n]), status: async () => ({ state: "STATE_COMPLETED_SUCCESS" }) });
    ok(r === "499", "Skip completing first does not end the wait: the balance is still watched until it lands (within 0.1%)");
  }
  {
    const c = clock();
    const r = await watchArrival({ ...base(c), read: seq([1000n, 1500n]), status: async () => null });
    ok(r === "500", "with Skip tracking unavailable the balance alone decides");
  }
  {
    const c = clock();
    await rejects(watchArrival({ ...base(c), read: seq([1100n]), status: async () => { throw new Error("503"); } }),
      /^Injective USDC\.inj rose by only 0\.0001; expected 0\.0005\.$/, "no arrival within the window fails with the timeout message, even with Skip unreachable");
  }
  {
    const c = clock();
    const e = await watchArrival({ ...base(c), read: async () => { throw new Error("fetch failed"); } }).catch(x => x);
    ok(e instanceof Error && e.message === "fetch failed", "a failed balance read propagates as itself, so the runner treats it as transient");
  }
}

/* ---------- runner: resume / retry / halt ---------- */
function harness(behaviour, cfg = {}) {
  const calls = [], saved = [];
  const mk = key => ({
    title: key,
    async state(tx) { calls.push(`${key}:state`); return behaviour[key]?.state?.shift?.() ?? "exists"; },
    async rebroadcast() { calls.push(`${key}:rebroadcast`); const b = behaviour[key]?.rebroadcast?.shift?.(); if (b instanceof Error) throw b; },
    async send(ctx, st, note, onSigned) {
      calls.push(`${key}:send`);
      const b = behaviour[key]?.send?.shift?.();
      const fee = behaviour[key]?.fee || "0";
      if (b instanceof Error) { if (b.afterSign) await onSigned({ hash: "H" + calls.length, feeAllUSDC: fee }); throw b; }
      await onSigned({ hash: "H" + calls.length, feeAllUSDC: fee });
      if (behaviour[key]?.quote) st.expected = behaviour[key].quote;
      return { hash: "H" };
    },
    async arrive(ctx, st) {
      calls.push(`${key}:arrive`);
      const b = behaviour[key]?.arrive?.shift?.();
      if (b instanceof Error) throw b;
      return b ?? st.amountIn;
    },
    async refunded() { calls.push(`${key}:refunded`); return behaviour[key]?.refunded?.shift?.() ?? false; },
  });
  const STAGES = { A1: mk("A1"), A2: mk("A2"), A3: mk("A3"), N0: mk("N0") };
  const run = makeRunner({ STAGES, ORDER: ["A1", "A2", "A3"], saveState: s => saved.push(JSON.parse(JSON.stringify(s))), log: () => {}, notify: cfg.notify, refillGas: cfg.refillGas, addFee: (s, a) => { s.fees = (BigInt(s.fees || 0) + BigInt(a)).toString(); }, retryMs: 0, refundRetryMs: 0, requoteMs: 0 });
  const ctx = { cfg: { max_loop_loss_bps: 10, ...cfg }, capMicro: cfg.capMicro ?? 5000000n };
  return { calls, saved, go: s => run(ctx, s) };
}
const fresh = (amt = "100000000") => ({ cycle: { id: "t", amountIn: amt, idx: 0, stages: {} } });
{
  const h = harness({ A2: { arrive: ["99990000"] }, A3: { arrive: ["99990000"] } }), s = fresh();
  ok(await h.go(s) === "done", "happy path completes");
  ok(s.cycle === null && s.loopsToday === 1 && s.fees === "10000", "cycle cleared, loop counted, 0.01 loss booked");
  ok(h.calls.join() === "A1:send,A1:arrive,A2:send,A2:arrive,A3:send,A3:arrive", "each stage signs once and uses the previous stage's arrival");
  ok(h.saved.some(x => x.cycle?.stages?.A1?.tx?.hash) , "the tx is journaled (before arrival)");
}
{
  const h = harness({}), s = fresh(); s.cycle.stages.A1 = { amountIn: "100000000", signed: 1, tx: { hash: "X" } };
  await h.go(s);
  ok(h.calls.slice(0, 2).join() === "A1:state,A1:arrive", "resume with a landed tx waits for arrival and never signs again");
}
{
  const h = harness({ A1: { state: ["failed"] } }), s = fresh(); s.cycle.stages.A1 = { amountIn: "100000000", signed: 1, tx: { hash: "X" } };
  await h.go(s);
  ok(h.calls.slice(0, 3).join() === "A1:state,A1:send,A1:arrive", "a recorded tx that failed in block is re-signed");
  ok(s.history.at(-1).out === "100000000", "and the loop completes");
}
{
  const h = harness({ A1: { state: ["pending"] } }), s = fresh(); s.cycle.stages.A1 = { amountIn: "100000000", signed: 1, tx: { hash: "X" } };
  await h.go(s);
  ok(h.calls.slice(0, 3).join() === "A1:state,A1:rebroadcast,A1:arrive", "a pending/unknown tx is rebroadcast as the same bytes, not re-signed");
}
{
  const alerts = [];
  const h = harness({ A2: { arrive: [new Error("Injective USDC.inj rose by only 0"), new Error("Injective USDC.inj rose by only 0")] } }, { notify: (c, t) => alerts.push(t) }), s = fresh();
  try { await h.go(s); ok(false, "late arrival propagates"); } catch (e) { ok(e.wait && !e.halt && /arrival late/.test(e.message), "a late arrival without a refund waits instead of halting"); }
  ok(s.cycle.stages.A2.tx && s.cycle.idx === 1 && alerts.length === 1 && /A2 is late/.test(alerts[0]), "keeps the journaled tx and alerts once");
  await h.go(s).catch(() => {});
  ok(alerts.length === 1 && h.calls.filter(c => c === "A2:send").length === 1, "still late on the next tick: no second alert within 3 h, never re-signed");
  ok(await h.go(s) === "done", "and when it lands the loop completes");
}
{
  const h = harness({ A3: { arrive: [new Error("Skip reports STATE_COMPLETED_ERROR")], refunded: [true] } }), s = fresh();
  ok(await h.go(s) === "done", "A3 refunded then retried completes");
  ok(h.calls.filter(c => c === "A3:send").length === 2 && s.history.at(-1).out === "100000000", "exactly one re-sign after the proven refund");
}
{
  const e = () => Object.assign(new Error("rejected at CheckTx"), { rejectedHash: "Z", afterSign: true });
  const h = harness({ A1: { send: [e(), e(), e(), e()] } }), s = fresh();
  await rejects(h.go(s), new RegExp(`signed ${MAX_SIGNED_ATTEMPTS} times`), "gives up after MAX_SIGNED_ATTEMPTS signatures");
  ok(h.calls.filter(c => c === "A1:send").length === MAX_SIGNED_ATTEMPTS, "and signed no more than that");
}
{
  const h = harness({ A1: { send: [Object.assign(new Error("fetch failed"), {})] } }), s = fresh();
  try { await h.go(s); ok(false, "transient error before signing propagates"); } catch (e) { ok(!e.halt && /fetch failed/.test(e.message), "transient error before signing is not a halt"); }
  ok(s.cycle.stages.A1.signed === 0 && !s.cycle.stages.A1.tx, "and records no attempt");
}
{
  const h = harness({ A3: { arrive: ["99000000"] } }), s = fresh();
  await rejects(h.go(s), /more than Skip quoted/, "a 1% loss nobody quoted halts at 10 bps");
  ok(s.cycle === null, "after the funds are home (cycle cleared)");
}
{
  const h = harness({ A1: { send: [Object.assign(new Error("route refused"), { halt: true })] } }), s = fresh();
  await rejects(h.go(s), /route refused/, "a validator refusal halts");
  ok(!s.cycle.stages.A1.tx, "without anything signed");
}

{
  const amb = Object.assign(new Error("43114 send of 0xH is unconfirmed (fetch failed)"), { afterSign: true });
  const h = harness({ A2: { send: [amb] } }), s = fresh();
  try { await h.go(s); ok(false, "ambiguous send propagates"); } catch (e) { ok(!e.halt && /unconfirmed/.test(e.message), "an ambiguous send is a transient error, not a halt"); }
  ok(s.cycle.stages.A2.tx && s.cycle.stages.A2.signed === 1, "and the signed tx stays journaled");
  await h.go(s);
  ok(h.calls.filter(c => c === "A2:send").length === 1 && h.calls.includes("A2:state"), "the next run resolves it by state instead of signing a second burn");
}
{
  // A1 signed with a 1664 fee, then the service restarts during the bridge wait (arrive throws a transient error)
  const h = harness({ A1: { fee: "1664", arrive: [new Error("fetch failed while waiting")] } }), s = fresh();
  await h.go(s).catch(() => {});
  ok(s.fees === "1664" && h.saved.some(x => x.fees === "1664" && x.cycle?.stages?.A1?.tx), "the A1 fee is journaled in the same write as the signed tx");
  s.cycle.stages.A1.retryAfter = undefined;
  await h.go(s).catch(() => {});
  ok(h.calls.filter(c => c === "A1:send").length === 1, "resume does not sign A1 again");
  ok(BigInt(s.fees) === 1664n, "and does not book the fee twice (loop loss is 0 here)");
}
{
  ok(loopLossBound("100000000", 10) === 200000n, "worst case for a 100 USDC loop at 10 bps: 0.05 A1 relay bound + 0.05 A2 (5 bps) + 0.10 margin");
  ok(loopLossBound("10000000000", 1) === 11000000n, "10,000 USDC at 1 bps: 5 + 5 (5 bps legs) + 1 margin");
  ok(fitsFeeCap({ capMicro: 5000000n, bookedMicro: "4750000", amountIn: "100000000", bps: 10, feeMicro: 1664n }), "fee + worst-case loss that fit are allowed");
  ok(!fitsFeeCap({ capMicro: 5000000n, bookedMicro: "4990000", amountIn: "100000000", bps: 10, feeMicro: 1664n }), "a loop with 0.01 of budget left is refused");
  ok(!fitsFeeCap({ capMicro: 5000000n, bookedMicro: "4899000", amountIn: "100000000", bps: 10, feeMicro: 1664n }), "the exact fee tips it over: refused");
  const m = nextUtcMidnight(Date.UTC(2026, 8, 24, 15, 4)); ok(m === Date.UTC(2026, 8, 25), "next UTC midnight");
  // recoveries run only the tail of the loop, so they reserve only what those stages can lose
  const O = ["A1", "A2", "A3"], z = { noble: 0n, avaxUsdc: 0n, injUsdc: 0n };
  const ri = planRecovery({ ...z, injUsdc: 100000000n }, 1000000n, O), ra = planRecovery({ ...z, avaxUsdc: 100000000n }, 1000000n, O), rn = planRecovery({ ...z, noble: 100000000n }, 1000000n, O);
  ok(cycleLossBound(ri, ri.order, 5) === 50000n, "Injective recovery (A3 only, exact 1:1): just the 5 bps margin, 0.05");
  ok(cycleLossBound(ra, ra.order, 5) === 100000n, "Avalanche recovery (A2 + A3): 5 bps A2 quote bound + margin, 0.10");
  ok(cycleLossBound(rn, rn.order, 5) === 50000n, "USDC.noble recovery (N0, exact 1:1): just the margin");
  ok(cycleLossBound({ amountIn: "100000000" }, O, 5) === loopLossBound("100000000", 5), "a full loop reserves the full-loop bound");
  // the reviewer's case: 4.99 booked, a 100 USDC Avalanche recovery may lose 0.10: does not fit a 5 cap
  ok(!fitsFeeCap({ capMicro: 5000000n, bookedMicro: "4990000", feeMicro: 0n, lossMicro: cycleLossBound(ra, ra.order, 5) }), "a recovery whose worst case does not fit the day is refused");
  // a refill mid-loop must leave the in-flight cycle's reservation intact: 2.9 booked + 2.05 refill + 0.2 reserved > 5
  const inFlight = loopLossBound("100000000", 10);
  ok(5000000n - 2900000n - inFlight < 2000000n + 50000n, "a 2 USDC refill with 2.9 booked and a 100 USDC loop in flight does not fit a 5 cap");
}
{
  // 4.99 already booked today: A1's exact fee plus the loop's 0.1 worst-case loss does not fit a 5 cap
  const h = harness({ A1: { fee: "1664" } }, { capMicro: 5000000n }), s = fresh(); s.fees = "4990000"; s.feesToday = "4990000";
  try { await h.go(s); ok(false, "fee cap stops A1"); } catch (e) { ok(e.wait && /retry scheduled/.test(e.message), "A1 over the fee cap waits instead of signing"); }
  ok(!s.cycle.stages.A1.tx && s.cycle.stages.A1.signed === 0 && s.fees === "4990000", "nothing journaled, signed or booked");
  ok(s.cycle.stages.A1.retryAfter === nextUtcMidnight(), "and the stage resumes at 00:00 UTC");
}
{
  // an LCD blip while polling for arrival: not a halt, no refund check, no second signature
  const h = harness({ A2: { arrive: [new Error("503 from https://injective-api.polkachu.com/...")] } }), s = fresh();
  try { await h.go(s); ok(false, "read error propagates"); } catch (e) { ok(!e.halt, "a failed balance read while waiting is transient, not a halt"); }
  ok(!h.calls.includes("A2:refunded") && s.cycle.stages.A2.tx, "no refund check, and the burn stays journaled");
  await h.go(s);
  ok(h.calls.filter(c => c === "A2:send").length === 1 && s.history.at(-1).out === "100000000", "the next tick resumes the wait and completes without signing again");
}
{
  // a recorded burn the node dropped and now refuses deterministically on rebroadcast: re-signed exactly once
  const exp = Object.assign(new Error("recorded burn is refused on rebroadcast: max fee per gas less than block base fee"), { txExpired: true });
  const h = harness({ A2: { state: ["unknown"], rebroadcast: [exp] } }), s = fresh();
  s.cycle.idx = 1; s.cycle.stages.A1 = { amountIn: "100000000", received: "100000000", signed: 1, tx: { hash: "A" } };
  s.cycle.stages.A2 = { amountIn: "100000000", signed: 1, tx: { hash: "B", nonce: "5" } };
  ok(await h.go(s) === "done", "a burn refused on rebroadcast is signed again and the loop completes");
  ok(h.calls.slice(0, 3).join() === "A2:state,A2:rebroadcast,A2:send" && s.history.at(-1).out === "100000000", "state, rebroadcast refused, one new signature");
}
{
  const O = ["A1", "A2", "A3"], z = { noble: 0n, avaxUsdc: 0n, injUsdc: 0n };
  ok(planRecovery(z, 1000000n, O) === null, "nothing outside the alloy: no recovery");
  ok(planRecovery({ ...z, injUsdc: 999999n }, 1000000n, O) === null, "dust below the threshold is left alone");
  const pi = planRecovery({ ...z, injUsdc: 99999331n, avaxUsdc: 5000000n }, 1000000n, O);
  ok(pi.idx === 2 && pi.order === O && pi.stages.A2.received === "99999331" && pi.amountIn === "99999331", "USDC.inj on Injective first: resume at A3 with the whole balance");
  const pa = planRecovery({ ...z, avaxUsdc: 99994737n }, 1000000n, O);
  ok(pa.idx === 1 && pa.stages.A1.received === "99994737", "USDC on Avalanche: resume at A2");
  const pn = planRecovery({ ...z, noble: 100000000n }, 1000000n, O);
  ok(pn.order.join() === "N0" && pn.idx === 0 && pn.amountIn === "100000000", "USDC.noble on Osmosis: the single 1:1 swap stage");
}
{
  const h = harness({}), s = { cycle: planRecovery({ noble: 0n, avaxUsdc: 0n, injUsdc: 99999331n }, 1000000n, ["A1", "A2", "A3"]) }; s.loopsToday = 7;
  ok(await h.go(s) === "done", "an Injective recovery completes");
  ok(h.calls.join() === "A3:send,A3:arrive", "running only A3");
  ok(s.loopsToday === 7 && s.history.at(-1).recovery === "USDC.inj on Injective" && s.cycle === null, "and does not count as a loop");
}
{
  const h = harness({}), s = { cycle: planRecovery({ noble: 100000000n, avaxUsdc: 0n, injUsdc: 0n }, 1000000n, ["A1", "A2", "A3"]) };
  ok(await h.go(s) === "done" && h.calls.join() === "N0:send,N0:arrive", "a USDC.noble recovery is one swap");
}
{
  // A1's IBC hop refunded: the stage is retried (resending the refunded USDC.noble), not halted
  const h = harness({ A1: { arrive: [new Error("Avalanche USDC rose by only 0; expected 99.99")], refunded: [true] } }), s = fresh();
  ok(await h.go(s) === "done" && h.calls.filter(c => c === "A1:send").length === 2 && s.cycle === null, "a refunded A1 is retried after proof and the loop completes");
}
{
  // an expensive but quoted loop (gas spike: A1 quoted 0.05 relay) does not halt at 5 bps; the same loss unquoted would
  const h = harness({ A1: { quote: "99950000", arrive: ["99950000"] }, A3: { arrive: ["99950000"] } }, { max_loop_loss_bps: 5 }), s = fresh();
  ok(await h.go(s) === "done" && s.history.at(-1).back === "99950000", "a 0.05 loss that Skip quoted completes at 5 bps");
  const h2 = harness({ A1: { quote: "99990000", arrive: ["99990000"] }, A3: { arrive: ["99900000"] } }, { max_loop_loss_bps: 5 }), s2 = fresh();
  await rejects(h2.go(s2), /more than Skip quoted/, "0.1 lost against a 0.01 quote: 0.09 unexplained, over 0.05, halts");
}
{
  // AVAX runs out at A2: refilled from the Osmosis reserve, then A2 is signed; no halt
  const short = Object.assign(new Error("AVAX balance cannot cover"), { halt: true, nothingSent: true, gasShort: "avax" });
  const refills = [];
  const h = harness({ A2: { send: [short] } }, { refillGas: async (c, st, g) => { refills.push(g); } }), s = fresh();
  ok(await h.go(s) === "done" && refills.join() === "avax", "a mid-loop gas shortfall refills once and the loop completes");
  ok(h.calls.filter(c => c === "A2:send").length === 2 && s.cycle === null, "A2 tried again after the refill");
  const h2 = harness({ A2: { send: [short] } }), s3 = fresh();
  await rejects(h2.go(s3), /cannot cover/, "without a refill hook it still halts before signing");
}
{
  const rq = () => Object.assign(new Error("route refused: route: expected exactly one swap hop, got 3"), { requote: true });
  const h = harness({ A3: { send: [rq(), rq()] } }), s = fresh();
  ok(await h.go(s) === "done", "a refused A3 quote is asked again and the loop completes");
  ok(h.calls.filter(c => c === "A3:send").length === 3 && s.history.at(-1).back === "100000000", "two refusals, then the good quote is signed once");
}
{
  // a refusal that keeps coming back: keeps asking, never signs, tells a person once, does not halt
  const rq = () => Object.assign(new Error("route refused: amount_out loses more than 5 bps"), { requote: true });
  const alerts = [];
  const h = harness({ A1: { send: Array.from({ length: 12 }, rq) } }, { notify: (ctx, t) => alerts.push(t) }), s = fresh();
  ok(await h.go(s) === "done", "twelve refusals in a row, then a good quote: the loop completes");
  ok(h.calls.filter(c => c === "A1:send").length === 13 && s.cycle === null, "it kept asking instead of halting");
  ok(alerts.length === 1 && /6 refused quotes in a row/.test(alerts[0]), "and alerted exactly once, at the sixth refusal");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
