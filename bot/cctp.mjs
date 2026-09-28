/* Circle CCTP without Skip: the pinned contracts, calldata encoders, message decoders, the Iris attestation client and
 * the Noble lookups the self-relayed stages need. Nothing here signs; stages.mjs sends through sign.mjs.
 *
 *   Noble -> Avalanche   CCTP v1. Noble's orbiter burns on receipt of our IBC packet (memo below); we mint on Avalanche
 *                        with MessageTransmitter v1.receiveMessage once Circle has attested the burn.
 *   Avalanche -> Inj EVM CCTP v2. We burn with TokenMessengerV2.depositForBurn (standard finality, no fee) and mint on
 *                        Injective EVM with MessageTransmitterV2.receiveMessage.
 *
 * Both burns name our own address as destinationCaller, so only this wallet can mint them: a relayer cannot front-run
 * the mint, and a mint that already happened can only have been ours. Every message Circle attests is decoded and
 * checked field by field against what the stage burned before it is submitted.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { P } from "./page.mjs";

const { K, rpc, jget, lcdGet, pad32, sameAddr, sleep } = P;
const hex = u => Buffer.from(u).toString("hex");
const strip = h => String(h).replace(/^0x/i, "").toLowerCase();
const sel = sig => hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
const word = v => BigInt(v).toString(16).padStart(64, "0");

export const CCTP = {
  IRIS: "https://iris-api.circle.com",
  /* CCTP v1 on Avalanche (localDomain 1). The v1 message recipient is the destination TokenMessenger. */
  MT_V1_AVAX: "0x8186359aF5F57FbB40c6b14A588d2A59C0C29880",
  TM_V1_AVAX: "0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982",
  /* Noble's TokenMessenger and uusdc as CCTP v1 sees them (the sender and burn token of every Noble burn message) */
  NOBLE_TOKEN_MESSENGER: "0x57d4eaf1091577a6b7d121202afbd2808134f117",
  NOBLE_BURN_TOKEN: "0x487039debedbf32d260137b0a6f66b90962bec777250910d253781de326a716d",
  /* CCTP v2: the same addresses on Avalanche and Injective EVM */
  TM_V2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  MT_V2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  FINALITY_STANDARD: 2000,
  DOMAIN: K.CCTP_DOMAIN,   // { "1": 0, "43114": 1, "noble-1": 4, "1776": 29 }
};
export const SEL = {
  receiveMessage: sel("receiveMessage(bytes,bytes)"),
  depositForBurnV2: sel("depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)"),
  usedNonces: sel("usedNonces(bytes32)"),
  localDomain: sel("localDomain()"),
  localMessageTransmitter: sel("localMessageTransmitter()"),
};
export const MESSAGE_SENT_TOPIC = "0x" + hex(keccak_256(new TextEncoder().encode("MessageSent(bytes)")));

/* ---------------- calldata ---------------- */
export function depositForBurnV2Calldata({ amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee = 0, minFinalityThreshold = CCTP.FINALITY_STANDARD }) {
  return "0x" + SEL.depositForBurnV2 + word(amount) + word(destinationDomain) + pad32(mintRecipient) + pad32(burnToken) + pad32(destinationCaller)
    + word(maxFee) + word(minFinalityThreshold);
}
const abiBytesTail = h => { const b = strip(h); return word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, "0"); };
export function receiveMessageCalldata(message, attestation) {
  const a = abiBytesTail(message), b = abiBytesTail(attestation);
  return "0x" + SEL.receiveMessage + word(64) + word(64 + a.length / 2) + a + b;
}
/* the Noble orbiter memo: CCTP v1 forwarding to `domain`, minting to our EVM address, only our address may mint. No
   pre_actions: Skip's ACTION_FEE paid Skip's relayer, and we relay ourselves. */
export function orbiterMemo(evm, domain) {
  const b32 = h => Buffer.from(pad32(h), "hex").toString("base64");
  return JSON.stringify({ orbiter: { forwarding: { protocol_id: "PROTOCOL_CCTP", attributes: {
    "@type": "/noble.orbiter.controller.forwarding.v1.CCTPAttributes", destination_domain: domain, mint_recipient: b32(evm), destination_caller: b32(evm) },
    passthrough_payload: "" } } });
}

/* ---------------- messages ---------------- */
const rd = (b, o, n) => b.subarray(o, o + n);
const uint = (b, o, n) => BigInt("0x" + (hex(rd(b, o, n)) || "0"));
const addr32 = (b, o) => "0x" + hex(rd(b, o, 32));
const toBuf = m => Buffer.from(strip(m), "hex");
/* v1: version 4 | source 4 | destination 4 | nonce 8 | sender 32 | recipient 32 | destinationCaller 32 | body
   v1 burn body: version 4 | burnToken 32 | mintRecipient 32 | amount 32 | messageSender 32 */
export function parseMessageV1(m) {
  const b = toBuf(m); if (b.length < 116 + 132) throw new Error(`CCTP v1 message is ${b.length} bytes, too short for a burn`);
  const body = b.subarray(116);
  return { version: Number(uint(b, 0, 4)), sourceDomain: Number(uint(b, 4, 4)), destinationDomain: Number(uint(b, 8, 4)), nonce: uint(b, 12, 8),
    sender: addr32(b, 20), recipient: addr32(b, 52), destinationCaller: addr32(b, 84),
    body: { version: Number(uint(body, 0, 4)), burnToken: addr32(body, 4), mintRecipient: addr32(body, 36), amount: uint(body, 68, 32), messageSender: addr32(body, 100) } };
}
/* v2: version 4 | source 4 | destination 4 | nonce 32 | sender 32 | recipient 32 | destinationCaller 32 | minFinality 4 | finalityExecuted 4 | body
   v2 burn body: version 4 | burnToken 32 | mintRecipient 32 | amount 32 | messageSender 32 | maxFee 32 | feeExecuted 32 | expirationBlock 32 | hookData */
export function parseMessageV2(m) {
  const b = toBuf(m); if (b.length < 148 + 228) throw new Error(`CCTP v2 message is ${b.length} bytes, too short for a burn`);
  const body = b.subarray(148);
  return { version: Number(uint(b, 0, 4)), sourceDomain: Number(uint(b, 4, 4)), destinationDomain: Number(uint(b, 8, 4)), nonce: "0x" + hex(rd(b, 12, 32)),
    sender: addr32(b, 44), recipient: addr32(b, 76), destinationCaller: addr32(b, 108),
    minFinalityThreshold: Number(uint(b, 140, 4)), finalityThresholdExecuted: Number(uint(b, 144, 4)),
    body: { version: Number(uint(body, 0, 4)), burnToken: addr32(body, 4), mintRecipient: addr32(body, 36), amount: uint(body, 68, 32), messageSender: addr32(body, 100),
      maxFee: uint(body, 132, 32), feeExecuted: uint(body, 164, 32), expirationBlock: uint(body, 196, 32), hookData: "0x" + hex(body.subarray(228)) } };
}
const is32 = (a, h) => strip(a) === pad32(h);
/* what a burn message must say before we submit it, field by field; returns the list of mismatches */
export function checkBurnV1(m, exp) {
  const e = [];
  if (m.version !== 0 || m.body.version !== 0) e.push(`message version ${m.version}/${m.body.version}, expected CCTP v1 (0/0)`);
  if (m.sourceDomain !== exp.sourceDomain) e.push(`source domain ${m.sourceDomain} != ${exp.sourceDomain}`);
  if (m.destinationDomain !== exp.destinationDomain) e.push(`destination domain ${m.destinationDomain} != ${exp.destinationDomain}`);
  if (!is32(m.sender, CCTP.NOBLE_TOKEN_MESSENGER)) e.push(`sender ${m.sender} is not Noble's TokenMessenger`);
  if (!is32(m.recipient, exp.recipient)) e.push(`recipient ${m.recipient} is not the destination TokenMessenger ${exp.recipient}`);
  if (!is32(m.destinationCaller, exp.destinationCaller)) e.push(`destinationCaller ${m.destinationCaller} is not ${exp.destinationCaller}`);
  if (!is32(m.body.burnToken, CCTP.NOBLE_BURN_TOKEN)) e.push(`burn token ${m.body.burnToken} is not Noble uusdc`);
  if (!is32(m.body.mintRecipient, exp.mintRecipient)) e.push(`mint recipient ${m.body.mintRecipient} is not ${exp.mintRecipient}`);
  if (m.body.amount !== BigInt(exp.amount)) e.push(`amount ${m.body.amount} != ${exp.amount}`);
  if (exp.nonce !== undefined && m.nonce !== BigInt(exp.nonce)) e.push(`nonce ${m.nonce} != ${exp.nonce}`);
  return e;
}
/* attested: true for the message Iris returns (nonce and finality filled in); false for the one the burn emitted */
export function checkBurnV2(m, exp, attested) {
  const e = [];
  if (m.version !== 1 || m.body.version !== 1) e.push(`message version ${m.version}/${m.body.version}, expected CCTP v2 (1/1)`);
  if (m.sourceDomain !== exp.sourceDomain) e.push(`source domain ${m.sourceDomain} != ${exp.sourceDomain}`);
  if (m.destinationDomain !== exp.destinationDomain) e.push(`destination domain ${m.destinationDomain} != ${exp.destinationDomain}`);
  if (!is32(m.sender, CCTP.TM_V2) || !is32(m.recipient, CCTP.TM_V2)) e.push(`sender/recipient ${m.sender}/${m.recipient} are not TokenMessengerV2`);
  if (!is32(m.destinationCaller, exp.destinationCaller)) e.push(`destinationCaller ${m.destinationCaller} is not ${exp.destinationCaller}`);
  if (m.minFinalityThreshold !== CCTP.FINALITY_STANDARD) e.push(`minFinalityThreshold ${m.minFinalityThreshold} != ${CCTP.FINALITY_STANDARD}`);
  if (attested && m.finalityThresholdExecuted < CCTP.FINALITY_STANDARD) e.push(`attested at finality ${m.finalityThresholdExecuted}, below standard`);
  if (!is32(m.body.burnToken, exp.burnToken)) e.push(`burn token ${m.body.burnToken} is not ${exp.burnToken}`);
  if (!is32(m.body.mintRecipient, exp.mintRecipient)) e.push(`mint recipient ${m.body.mintRecipient} is not ${exp.mintRecipient}`);
  if (m.body.amount !== BigInt(exp.amount)) e.push(`amount ${m.body.amount} != ${exp.amount}`);
  if (!is32(m.body.messageSender, exp.messageSender)) e.push(`burned by ${m.body.messageSender}, not ${exp.messageSender}`);
  if (m.body.maxFee !== 0n || m.body.feeExecuted !== 0n) e.push(`fee ${m.body.feeExecuted} (max ${m.body.maxFee}); this bot burns with no fee`);
  if (strip(m.body.hookData) !== "") e.push("unexpected hook data");
  return e;
}
/* the v2 message a burn receipt emitted (MessageTransmitterV2's MessageSent(bytes)); its nonce is zero until attested */
export function messageFromReceipt(receipt) {
  const logs = (receipt?.logs || []).filter(l => sameAddr(l.address, CCTP.MT_V2) && l.topics?.[0] === MESSAGE_SENT_TOPIC);
  if (logs.length !== 1) throw new Error(`burn receipt has ${logs.length} MessageSent events from MessageTransmitterV2, expected 1`);
  const d = strip(logs[0].data), len = Number(BigInt("0x" + d.slice(64, 128)));
  return "0x" + d.slice(128, 128 + len * 2);
}

/* ---------------- Iris (Circle's attestation service) ---------------- */
/* the attested messages a source tx produced. Noble hashes are uppercase without 0x; EVM hashes keep their 0x. A tx
   Iris has not indexed yet answers 404, which is "not yet", not an error. */
export async function irisMessages(domain, txHash, get = jget) {
  const h = domain === CCTP.DOMAIN["noble-1"] ? strip(txHash).toUpperCase() : "0x" + strip(txHash);
  try { return (await get(`${CCTP.IRIS}/v2/messages/${domain}?transactionHash=${h}`)).messages || []; }
  catch (e) { if (/\b404\b|not found/i.test(e.message)) return []; throw e; }
}
/* polls until the message `pick` selects is attested ({message, attestation}); null when it is not within maxMs */
export async function waitAttestation(domain, txHash, pick, { note = () => {}, maxMs = 90000, pollMs = 3000, get = jget, sleepFn = sleep, now = () => Date.now() } = {}) {
  const t0 = now(); let last = "";
  for (;;) {
    const m = (await irisMessages(domain, txHash, get)).find(pick);
    const state = m ? m.status : "not indexed";
    if (state !== last) { note(`Circle attestation: ${state}`); last = state; }
    if (m && m.status === "complete" && m.attestation && !/^pending/i.test(m.attestation)) return { message: m.message, attestation: m.attestation, eventNonce: m.eventNonce };
    if (now() - t0 >= maxMs) return null;
    await sleepFn(pollMs);
  }
}

/* ---------------- onchain reads ---------------- */
const call = async (chain, to, data) => rpc(chain, "eth_call", [{ to, data }, "latest"]);
/* v1 keys a nonce by keccak256(abi.encodePacked(uint32 sourceDomain, uint64 nonce)); v2 by the message's bytes32 nonce */
export const v1NonceKey = (sourceDomain, nonce) => "0x" + hex(keccak_256(Buffer.from(word(sourceDomain).slice(-8) + word(nonce).slice(-16), "hex")));
export async function nonceUsed(chain, transmitter, key) { return BigInt(await call(chain, transmitter, "0x" + SEL.usedNonces + pad32(key))) !== 0n; }

/* the contracts are what the pins say: each MessageTransmitter reports its chain's domain and each TokenMessengerV2
   points at the pinned MessageTransmitterV2. Checked once per process; a mismatch halts before anything is burned. */
let checked = null;
export function cctpSelfCheck() {
  return checked ||= (async () => {
    const want = [["43114", CCTP.MT_V1_AVAX, CCTP.DOMAIN["43114"]], ["43114", CCTP.MT_V2, CCTP.DOMAIN["43114"]], [K.INJ_EVM_CHAIN, CCTP.MT_V2, CCTP.DOMAIN[K.INJ_EVM_CHAIN]]];
    for (const [chain, mt, dom] of want) {
      const got = Number(BigInt(await call(chain, mt, "0x" + SEL.localDomain)));
      if (got !== dom) throw Object.assign(new Error(`${mt} on ${chain} reports CCTP domain ${got}, pinned ${dom}; refusing to use it`), { halt: true });
    }
    for (const chain of ["43114", K.INJ_EVM_CHAIN]) {
      const mt = "0x" + strip(await call(chain, CCTP.TM_V2, "0x" + SEL.localMessageTransmitter)).slice(24);
      if (!sameAddr(mt, CCTP.MT_V2)) throw Object.assign(new Error(`TokenMessengerV2 on ${chain} points at ${mt}, not the pinned ${CCTP.MT_V2}`), { halt: true });
    }
  })().catch(e => { checked = null; throw e; });   // a failed read is retried on the next call; a mismatch halts
}

/* ---------------- Noble: the orbiter's receipt of our packet ---------------- */
const attrs = e => Object.fromEntries(e.attributes.map(a => [a.key, a.value]));
/* event values from cosmos-sdk typed events are JSON ("\"123\""); plain ones are not */
const val = v => { try { const j = JSON.parse(v); return typeof j === "string" || typeof j === "number" ? String(j) : v; } catch { return v; } };
/* the sequence of the packet our Osmosis tx sent on `channel` */
export function packetSeqOf(txResponse, channel) {
  const sp = (txResponse?.events || []).filter(e => e.type === "send_packet").map(attrs).filter(a => a.packet_src_channel === channel);
  if (sp.length !== 1) throw new Error(`Osmosis tx ${txResponse?.txhash} sent ${sp.length} packets on ${channel}, expected 1`);
  return sp[0].packet_sequence;
}
/* From the Noble txs that received packet `seq` from Osmosis `channel`, the one that wrote its acknowledgement. Returns
   null until it exists, else { hash, ackError } or { hash, burn, message } where burn and message are the CCTP events
   emitted by that same message (a relayer batches many packets per tx). */
export function nobleReceiptOf(txResponses, seq, channel) {
  for (const r of txResponses || []) {
    if (Number(r.code) !== 0) continue;
    const ack = (r.events || []).find(e => e.type === "write_acknowledgement" && attrs(e).packet_sequence === String(seq) && attrs(e).packet_src_channel === channel);
    if (!ack) continue;
    const a = attrs(ack), idx = a.msg_index;
    let res; try { res = JSON.parse(a.packet_ack); } catch { res = { error: `unparseable ack ${a.packet_ack}` }; }
    if (!res.result) return { hash: r.txhash, ackError: res.error || a.packet_ack };
    const same = t => (r.events || []).filter(e => e.type === t && attrs(e).msg_index === idx).map(attrs);
    const burns = same("circle.cctp.v1.DepositForBurn"), msgs = same("circle.cctp.v1.MessageSent");
    if (burns.length !== 1 || msgs.length !== 1) return { hash: r.txhash, ackError: `packet acked but ${burns.length} burns / ${msgs.length} messages were emitted for it` };
    const b = Object.fromEntries(Object.entries(burns[0]).map(([k, v]) => [k, val(v)]));
    return { hash: r.txhash, burn: b, message: "0x" + Buffer.from(val(msgs[0].message), "base64").toString("hex") };
  }
  return null;
}
export async function findNobleReceipt(seq, channel) {
  const q = encodeURIComponent(`recv_packet.packet_sequence='${seq}' AND recv_packet.packet_src_channel='${channel}'`);
  const j = await lcdGet("noble-1", `/cosmos/tx/v1beta1/txs?query=${q}&pagination.limit=10`);
  return nobleReceiptOf(j.tx_responses, seq, channel);
}
/* the orbiter's burn event, checked against what we asked for */
export function checkNobleBurn(burn, exp) {
  const e = [], b64 = h => Buffer.from(pad32(h), "hex").toString("base64");
  if (burn.depositor !== K.NOBLE_ORBITER) e.push(`burned by ${burn.depositor}, not the orbiter`);
  if (String(burn.amount) !== String(exp.amount)) e.push(`burned ${burn.amount}, expected ${exp.amount}`);
  if (String(burn.destination_domain) !== String(exp.destinationDomain)) e.push(`destination domain ${burn.destination_domain} != ${exp.destinationDomain}`);
  if (burn.mint_recipient !== b64(exp.mintRecipient)) e.push(`mint recipient ${burn.mint_recipient} is not ${exp.mintRecipient}`);
  if (burn.destination_caller !== b64(exp.destinationCaller)) e.push(`destination caller ${burn.destination_caller} is not ${exp.destinationCaller}`);
  return e;
}
