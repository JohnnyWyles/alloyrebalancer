/* Keys and signing for the headless bot. The page signs through Keplr; this is the one place the bot does it itself.
 *
 *   Osmosis / Noble   m/44'/118'/0'/0/0  secp256k1,     sha256(SignDoc),    64-byte r||s
 *   Injective         m/44'/60'/0'/0/0   ethsecp256k1,  keccak256(SignDoc), 64-byte r||s
 *   Avalanche (EVM)   m/44'/60'/0'/0/0   EIP-1559 type-2, keccak256, y-parity + r + s
 *
 * The coin-type-60 key gives both the inj1 address and the 0x address, as Keplr does, so one mnemonic has three
 * addresses. Private keys never leave this module and are never logged.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { P } from "./page.mjs";

const { K, CHAIN, cat, bytesF, strF, u64F, Any, TxBody, Fee, SignerInfo, AuthInfo, TxRaw, txHashOf, lcdGet, lcdPost, jget, proveEndpoints,
        rpc, waitReceipt, bech32Encode, convertBits, gasPriceOf, b64, sleep } = P;

const FEE_POOL_ALL = "3499";   // txfees fee-token pool for allUSDC (allUSDC/OSMO)
const hex = u => Buffer.from(u).toString("hex");
const unhex = h => Uint8Array.from(Buffer.from(String(h).replace(/^0x/i, ""), "hex"));

export function deriveWallet(mnemonic) {
  const m = mnemonic.trim().split(/\s+/).join(" ");
  if (!validateMnemonic(m, wordlist)) throw new Error("the mnemonic file does not hold a valid BIP-39 English mnemonic");
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(m));
  const c = root.derive("m/44'/118'/0'/0/0"), e = root.derive("m/44'/60'/0'/0/0");
  const cPub = secp256k1.getPublicKey(c.privateKey, true);
  const cWords = convertBits(ripemd160(sha256(cPub)), 8, 5, true);
  const ePub = secp256k1.getPublicKey(e.privateKey, true), eAddr = keccak_256(secp256k1.getPublicKey(e.privateKey, false).slice(1)).slice(12);
  const evm = "0x" + hex(eAddr);
  const W = { osmo: bech32Encode("osmo", cWords), noble: bech32Encode("noble", cWords), inj: bech32Encode("inj", convertBits(eAddr, 8, 5, true)), injHex: evm, evm };
  const KEYS = new Map([
    ["osmosis-1", { priv: c.privateKey, pub: cPub, hash: sha256, addr: W.osmo }],
    ["noble-1", { priv: c.privateKey, pub: cPub, hash: sha256, addr: W.noble }],
    ["injective-1", { priv: e.privateKey, pub: ePub, hash: keccak_256, addr: W.inj }],
    ["evm", { priv: e.privateKey, addr: evm }],
  ]);
  return { W, key: chain => { const k = KEYS.get(chain); if (!k) throw new Error(`no key for ${chain}`); return k; } };
}

/* cosmos.tx.v1beta1.SignDoc */
export function SignDoc(body, authInfo, chainId, accountNumber) {
  let d = cat(bytesF(1, body), bytesF(2, authInfo), strF(3, chainId));
  if (BigInt(accountNumber) !== 0n) d = cat(d, u64F(4, accountNumber));
  return d;
}
export function signCosmosBytes(k, signDoc) {
  return secp256k1.sign(k.hash(signDoc), k.priv, { prehash: false, lowS: true, format: "compact" });
}

/* The fee on Osmosis is paid in allUSDC (a txfees fee token, pool 3499), so the wallet never needs OSMO. The node converts
   it to OSMO at the fee pool's spot price and compares it with the base fee, so the margin covers price drift in between. */
async function osmoFeeInAllUSDC(gas, margin) {
  const uosmoPerGas = await gasPriceOf("osmosis-1");
  const j = await lcdGet("osmosis-1", `/osmosis/poolmanager/v2/pools/${FEE_POOL_ALL}/prices?base_asset_denom=uosmo&quote_asset_denom=${encodeURIComponent(K.ALL)}`);
  const px = Number(j.spot_price);   // allUSDC per OSMO, both 6 decimals
  if (!(px > 0)) throw new Error(`fee pool ${FEE_POOL_ALL} returned no spot price`);
  return String(Math.max(1, Math.ceil(gas * uosmoPerGas * px * margin)));
}

/* Signs and broadcasts one Cosmos tx. The tx carries a timeout height, so a tx that is not in a block by then provably
   never will be, and the raw bytes are handed to onSigned before broadcast so a restart can rebroadcast the same tx
   instead of signing a new one. Returns { hash, fee }. */
export async function signAndBroadcast(chainId, wallet, anys, note, onSigned, opts = {}) {
  const k = wallet.key(chainId), eps = await proveEndpoints(chainId), C = CHAIN[chainId];
  const feeDenom = chainId === "osmosis-1" ? K.ALL : C.feeDenom;
  const acc = await getAccountRetry(chainId, k.addr);
  const pkAny = Any(chainId === "injective-1" ? "/injective.crypto.v1beta1.ethsecp256k1.PubKey" : "/cosmos.crypto.secp256k1.PubKey", bytesF(1, k.pub));
  const latest = await lcdGet(chainId, "/cosmos/base/tendermint/v1beta1/blocks/latest");
  const timeoutHeight = String(Number(latest.block.header.height) + (opts.timeoutBlocks || 300));
  const body = TxBody(anys, "", timeoutHeight, []);
  const simAI = AuthInfo([SignerInfo(pkAny, 1, acc.sequence)], Fee([{ denom: feeDenom, amount: "0" }], "400000"));
  let sim, simEp;
  for (const ep of eps) {
    try { sim = await lcdPost(ep, "/cosmos/tx/v1beta1/simulate", { tx_bytes: b64(TxRaw(body, simAI, [new Uint8Array(64)])) }); simEp = ep; break; }
    catch (e) { note(`simulate on ${ep} failed: ${e.message}`); if (/insufficient|invalid|unauthorized|not found|out of gas|failed to execute/i.test(e.message)) throw Object.assign(new Error(`simulation rejected the tx: ${e.message}`), { nothingSent: true }); }
  }
  if (!sim) throw Object.assign(new Error("simulation failed on every endpoint"), { nothingSent: true });
  const used = Number(sim.gas_info?.gas_used || 0); if (!used) throw Object.assign(new Error("node returned no gas_used"), { nothingSent: true });
  const gas = Math.ceil(used * 1.4);
  const fee = chainId === "osmosis-1" ? await osmoFeeInAllUSDC(gas, opts.osmoFeeMargin || 1.5) : String(Math.ceil(gas * await gasPriceOf(chainId)));
  if (chainId !== "osmosis-1") {   // Osmosis fees come out of the allUSDC reserve; INJ is only refilled between loops
    const bal = await P.bankBalance(chainId, k.addr, feeDenom);
    if (bal < BigInt(fee)) throw Object.assign(new Error(`${C.feeSym} balance ${P.fmtUnits(bal, C.feeDec)} cannot pay this tx's fee ${P.fmtUnits(fee, C.feeDec)}. Send ${C.feeSym} to ${k.addr}, then delete HALTED; the stage resumes where it is.`), { halt: true, nothingSent: true, gasShort: chainId === "injective-1" ? "inj" : null });
  }
  const authInfo = AuthInfo([SignerInfo(pkAny, 1, acc.sequence)], Fee([{ denom: feeDenom, amount: fee }], String(gas)));
  const raw = TxRaw(body, authInfo, [signCosmosBytes(k, SignDoc(body, authInfo, chainId, acc.accountNumber))]);
  const hash = await txHashOf(raw);
  if (opts.dryRun) { note(`dry run: would broadcast ${hash} (gas ${gas}, fee ${fee} ${feeDenom})`); return { hash, fee, feeDenom, dryRun: true }; }
  // recorded before the POST; feeAllUSDC lets the caller book the fee in the same durable write as the tx
  await onSigned({ hash, raw: b64(raw), timeoutHeight, chain: chainId, fee, feeDenom, feeAllUSDC: feeDenom === K.ALL ? fee : "0" });
  note(`broadcasting ${hash} (gas ${gas}, fee ${fee} ${feeDenom === K.ALL ? "uallUSDC" : feeDenom})`);
  // a transport error here propagates without rejectedHash: the journaled tx is resolved by hash / timeout height later
  const res = await lcdPost(simEp, "/cosmos/tx/v1beta1/txs", { tx_bytes: b64(raw), mode: "BROADCAST_MODE_SYNC" });
  const tr = res.tx_response || {};
  // code 19: already in the mempool cache, i.e. accepted
  if (Number(tr.code) !== 0 && Number(tr.code) !== 19) throw Object.assign(new Error(`rejected at CheckTx (code ${tr.code}): ${tr.raw_log || tr.log || "no log"}`), { rejectedHash: hash });
  await waitCosmosTx(chainId, hash, timeoutHeight);
  return { hash, fee, feeDenom };
}
async function getAccountRetry(chainId, addr) {
  let last; for (let i = 0; i < 3; i++) { try { return await P.getAccount(chainId, addr); } catch (e) { last = e; await sleep(3000); } }
  throw Object.assign(last, { nothingSent: true });
}

/* waits for inclusion; resolves when included with code 0, throws `failed` when included with an error, and
   throws `expired` once the chain is past the tx's timeout height with the tx still absent */
export async function waitCosmosTx(chainId, hash, timeoutHeight) {
  for (;;) {
    const s = await cosmosTxState(chainId, hash, timeoutHeight);
    if (s.state === "exists") return;
    if (s.state === "failed") throw Object.assign(new Error(`tx ${hash} failed in block: ${s.log}`), { txFailed: true });
    if (s.state === "expired") throw Object.assign(new Error(`tx ${hash} never landed and the chain is past its timeout height ${timeoutHeight}`), { txExpired: true });
    await sleep(4000);
  }
}
export async function cosmosTxState(chainId, hash, timeoutHeight) {
  const eps = await proveEndpoints(chainId);
  for (const ep of eps) {
    try {
      const q = await jget(`${ep}/cosmos/tx/v1beta1/txs/${hash}`);
      if (q.tx_response) return Number(q.tx_response.code) === 0 ? { state: "exists" } : { state: "failed", log: q.tx_response.raw_log };
    } catch {}
  }
  if (timeoutHeight) {
    try {
      const latest = await lcdGet(chainId, "/cosmos/base/tendermint/v1beta1/blocks/latest");
      // a margin of blocks past the timeout, so an endpoint lagging on tx indexing cannot fake an expiry
      if (Number(latest.block.header.height) > Number(timeoutHeight) + 20) return { state: "expired" };
    } catch {}
  }
  return { state: "pending" };
}
export async function rebroadcastCosmos(chainId, rawB64) {
  const eps = await proveEndpoints(chainId);
  for (const ep of eps) { try { await lcdPost(ep, "/cosmos/tx/v1beta1/txs", { tx_bytes: rawB64, mode: "BROADCAST_MODE_SYNC" }); return; } catch {} }
}

/* ---------------- EVM ---------------- */
function rlpBytes(b) {
  if (b.length === 1 && b[0] < 0x80) return b;
  return cat(rlpLen(b.length, 0x80), b);
}
function rlpLen(n, off) {
  if (n < 56) return Uint8Array.of(off + n);
  const l = unhex(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0"));
  return cat(Uint8Array.of(off + 55 + l.length), l);
}
const rlpInt = v => { v = BigInt(v); if (v === 0n) return new Uint8Array(0); const h = v.toString(16); return unhex(h.length % 2 ? "0" + h : h); };
export function rlp(x) {
  if (Array.isArray(x)) { const inner = cat(...x.map(rlp)); return cat(rlpLen(inner.length, 0xc0), inner); }
  return rlpBytes(x);
}
/* EIP-1559 (type 2) transaction, signed; returns { raw: 0x.., hash: 0x.. } */
export function signEip1559(priv, tx) {
  const fields = [rlpInt(tx.chainId), rlpInt(tx.nonce), rlpInt(tx.maxPriorityFeePerGas), rlpInt(tx.maxFeePerGas), rlpInt(tx.gas), unhex(tx.to), rlpInt(tx.value || 0), unhex(tx.data || "0x"), []];
  const unsigned = cat(Uint8Array.of(2), rlp(fields));
  const sig = secp256k1.Signature.fromBytes(secp256k1.sign(keccak_256(unsigned), priv, { prehash: false, lowS: true, format: "recovered" }), "recovered");
  const signed = cat(Uint8Array.of(2), rlp([...fields, rlpInt(sig.recovery), rlpInt(sig.r), rlpInt(sig.s)]));
  return { raw: "0x" + hex(signed), hash: "0x" + hex(keccak_256(signed)) };
}

/* Sends one EVM tx from the bot's 0x address and waits for a successful receipt. The fee cap is a hard ceiling:
   above it the send is refused (nothing signed), not raised. */
export async function evmSend(chainId, wallet, { to, data, value }, note, onSigned, opts = {}) {
  const k = wallet.key("evm");
  const nonce = BigInt(await rpc(chainId, "eth_getTransactionCount", [k.addr, "pending"]));
  const block = await rpc(chainId, "eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(block.baseFeePerGas);
  let prio; try { prio = BigInt(await rpc(chainId, "eth_maxPriorityFeePerGas", [])); } catch { prio = 1000000000n; }
  const maxFee = base * 2n + prio, cap = BigInt(Math.round((opts.maxFeeGwei || 50) * 1e9));
  if (maxFee > cap) throw Object.assign(new Error(`${chainId} max fee ${maxFee / 1000000000n} gwei is above the ${opts.maxFeeGwei || 50} gwei cap; waiting`), { nothingSent: true, waitRetry: true });
  const call = { from: k.addr, to, data, value: "0x" + BigInt(value || 0).toString(16) };
  const gas = BigInt(await rpc(chainId, "eth_estimateGas", [call])) * 13n / 10n;
  // gas is only refilled between loops; running short mid-loop must stop loudly here, not spin on node refusals
  const have = BigInt(await rpc(chainId, "eth_getBalance", [k.addr, "latest"])), worst = gas * maxFee + BigInt(value || 0);
  if (have < worst) throw Object.assign(new Error(`${K.EVM[chainId]?.sym || chainId} balance ${Number(have) / 1e18} cannot cover this tx's worst-case ${Number(worst) / 1e18} (gas ${gas} at ${Number(maxFee) / 1e9} gwei). Send ${K.EVM[chainId]?.sym || "gas"} to ${k.addr}, then delete HALTED; the stage resumes where it is.`), { halt: true, nothingSent: true, gasShort: chainId === "43114" ? "avax" : null });
  const { raw, hash } = signEip1559(k.priv, { chainId: BigInt(chainId), nonce, maxPriorityFeePerGas: prio, maxFeePerGas: maxFee, gas, to, value: value || 0, data });
  if (opts.dryRun) { note(`dry run: would send ${hash} to ${to} (gas ${gas})`); return { hash, dryRun: true }; }
  await onSigned({ hash, raw, nonce: nonce.toString(), chain: chainId });
  note(`sending ${hash} to ${to} (nonce ${nonce}, gas ${gas}, max fee ${Number(maxFee) / 1e9} gwei)`);
  const sent = await sendRawEvm(chainId, raw, hash);
  if (sent.refused) throw Object.assign(new Error(`${chainId} refused the tx: ${sent.refused}`), { rejectedHash: hash });
  if (sent.ambiguous) throw new Error(`${chainId} send of ${hash} is unconfirmed (${sent.ambiguous}); the recorded tx is resolved by hash and nonce on the next tick`);
  await waitReceipt(chainId, hash, 15 * 60 * 1000);
  return { hash };
}
/* Classifies one eth_sendRawTransaction. Only an explicit JSON-RPC refusal, confirmed by the node not knowing the
   hash, counts as "never sent" ({refused}); a timeout, dropped connection or unparseable reply may have been accepted
   before the response was lost ({ambiguous}), so the caller keeps the journaled tx and resolves it later. */
/* geth/coreth txpool validation errors: the node evaluated these bytes and will never admit them as they are. Not in
   the list on purpose: "nonce too low" (may be this very tx, mined) and "replacement transaction underpriced" (another
   tx with our nonce is pending, which may be this one). */
const DETERMINISTIC_REFUSAL = /insufficient funds|intrinsic gas too low|max fee per gas less than block base fee|transaction underpriced|exceeds block gas limit|invalid sender|invalid chain id|gas limit reached|max priority fee per gas higher than max fee per gas|oversized data|tip above fee cap|fee cap less than block base fee/i;
export async function sendRawEvm(chainId, raw, hash, fetchJson = evmPost) {
  let reply, lastTransport = null;
  for (const url of K.EVM[chainId].rpc) {
    try { reply = await fetchJson(url, "eth_sendRawTransaction", [raw]); break; }
    catch (e) { lastTransport = e.message; }
  }
  if (!reply) return { ambiguous: lastTransport || "no RPC answered" };
  if (!reply.error) return { accepted: true };
  const msg = String(reply.error.message || JSON.stringify(reply.error));
  if (/already known|known transaction|already imported/i.test(msg)) return { accepted: true };
  // Only a deterministic validation refusal of these exact bytes can be forgotten. Provider errors (internal error,
  // rate limit, upstream timeout, "header not found", ...) come from load-balanced public RPCs and prove nothing, and a
  // previous URL that failed in transport may have accepted the tx before this one answered.
  if (lastTransport || /replacement/i.test(msg) || !DETERMINISTIC_REFUSAL.test(msg)) return { ambiguous: lastTransport ? `${msg} (after a transport error on another RPC: ${lastTransport})` : msg };
  try {
    const [byHash, receipt] = await Promise.all([fetchJson(K.EVM[chainId].rpc[0], "eth_getTransactionByHash", [hash]), fetchJson(K.EVM[chainId].rpc[0], "eth_getTransactionReceipt", [hash])]);
    if (byHash.error || receipt.error) return { ambiguous: `${msg} (and the hash lookup failed)` };
    if (byHash.result || receipt.result) return { accepted: true };
  } catch (e) { return { ambiguous: `${msg} (and the hash lookup failed: ${e.message})` }; }
  return { refused: msg };
}
async function evmPost(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { throw new Error(`${r.status} non-JSON reply from ${url}`); }
  if (!("result" in j) && !j.error) throw new Error(`malformed JSON-RPC reply from ${url}`);
  return j;
}
export async function evmTxState(chainId, hash, nonce, addr) {
  const r = await rpc(chainId, "eth_getTransactionReceipt", [hash]);
  if (r) return r.status === "0x1" ? "exists" : "failed";
  if (await rpc(chainId, "eth_getTransactionByHash", [hash])) return "pending";
  // mined nonce past ours with no receipt for our hash: the nonce went to another tx, ours can never land
  if (nonce !== undefined && BigInt(await rpc(chainId, "eth_getTransactionCount", [addr, "latest"])) > BigInt(nonce)) return "expired";
  return "unknown";
}
export const unhexBytes = unhex;
