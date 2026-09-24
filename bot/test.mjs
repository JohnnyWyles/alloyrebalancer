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
import { tightenMinAsset } from "./stages.mjs";
import { makeRunner, MAX_SIGNED_ATTEMPTS, MAX_REQUOTES } from "./cycle.mjs";

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
  ok(quotaRoom(q("999999", "0", past), "in", now).room === 1000000n && quotaRoom(q("999999", "0", past), "in", now).resetsAt === null, "expired window counts as reset");
  ok(quotaRoom(q("1", "0", later), "in", now).resetsAt === Number(BigInt(later) / 1000000n), "resetsAt is the window end in ms");
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

/* ---------- runner: resume / retry / halt ---------- */
function harness(behaviour, cfg = {}) {
  const calls = [], saved = [];
  const mk = key => ({
    title: key,
    async state(tx) { calls.push(`${key}:state`); return behaviour[key]?.state?.shift?.() ?? "exists"; },
    async rebroadcast() { calls.push(`${key}:rebroadcast`); },
    async send(ctx, st, note, onSigned) {
      calls.push(`${key}:send`);
      const b = behaviour[key]?.send?.shift?.();
      if (b instanceof Error) { if (b.afterSign) await onSigned({ hash: "H" + calls.length }); throw b; }
      await onSigned({ hash: "H" + calls.length });
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
  const STAGES = { A1: mk("A1"), A2: mk("A2"), A3: mk("A3") };
  const run = makeRunner({ STAGES, ORDER: ["A1", "A2", "A3"], saveState: s => saved.push(JSON.parse(JSON.stringify(s))), log: () => {}, addFee: (s, a) => { s.fees = (BigInt(s.fees || 0) + BigInt(a)).toString(); }, retryMs: 0, refundRetryMs: 0, requoteMs: 0 });
  const ctx = { cfg: { max_loop_loss_bps: 10, ...cfg } };
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
  const h = harness({ A2: { arrive: [new Error("Injective USDC.inj rose by only 0")] } }), s = fresh();
  await rejects(h.go(s), /A2 .*rose by only/, "arrival failure without a refund halts");
  ok(s.cycle && s.cycle.stages.A2.tx && s.cycle.idx === 1, "halted loop keeps its journal (resumable after the human looks)");
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
  await rejects(h.go(s), /above max_loop_loss_bps/, "a 1% loss halts at 10 bps");
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
  const rq = () => Object.assign(new Error("route refused: route: expected exactly one swap hop, got 3"), { requote: true });
  const h = harness({ A3: { send: [rq(), rq()] } }), s = fresh();
  ok(await h.go(s) === "done", "a refused A3 quote is asked again and the loop completes");
  ok(h.calls.filter(c => c === "A3:send").length === 3 && s.history.at(-1).back === "100000000", "two refusals, then the good quote is signed once");
}
{
  const rq = () => Object.assign(new Error("route refused: adapter changed"), { requote: true });
  const h = harness({ A2: { send: Array.from({ length: 10 }, rq) } }), s = fresh();
  await rejects(h.go(s), new RegExp(`${MAX_REQUOTES} refused quotes in a row`), "a refusal that keeps coming back halts");
  ok(h.calls.filter(c => c === "A2:send").length === MAX_REQUOTES && !s.cycle.stages.A2.tx && s.cycle.stages.A2.signed === 0, "after MAX_REQUOTES asks, with nothing signed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
