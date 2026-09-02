/* Regression tests for index.html (Alloy Rebalancer).
 *
 * Pulls the pure helpers straight out of the page and checks them: the protobuf encoders
 * against reference bytes (cosmjs-types for MsgExecuteContract and MsgTransfer; the chain's own
 * tx decoder confirmed MsgSwapExactAmountIn), the bech32 derivations against known addresses,
 * and the route validators against real Skip responses saved under test-fixtures/.
 * The validators are what keep a bad route from being signed, so the "bad" fixtures matter
 * most: each is a route Skip actually offered that would have moved funds the wrong way.
 *
 *   node test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HTML = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const FIX = p => JSON.parse(fs.readFileSync(new URL("./test-fixtures/" + p, import.meta.url), "utf8"));

/* brace matching runs on a copy with string literals and comments blanked (same length, so indexes
   line up), because a lone "{" inside a string would otherwise run the extraction to the end of the file */
const MASK = HTML.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, s => " ".repeat(s.length));
function extractFrom(startRe, name) {
  const m = startRe.exec(HTML);
  if (!m) throw new Error(`cannot find ${name} in index.html`);
  // skip the parameter list first: a default parameter like `out = {}` would otherwise
  // end the brace matching inside the signature
  let start = m.index;
  const paren = MASK.indexOf("(", m.index);
  if (paren >= 0 && paren < MASK.indexOf("{", m.index)) {
    let pd = 0, i = paren;
    for (; i < MASK.length; i++) { if (MASK[i] === "(") pd++; else if (MASK[i] === ")") { pd--; if (!pd) break; } }
    start = i;
  }
  let k = MASK.indexOf("{", start), depth = 0;
  while (k < MASK.length) {
    if (MASK[k] === "{") depth++;
    else if (MASK[k] === "}") { depth--; if (!depth) break; }
    k++;
  }
  if (depth) throw new Error(`unbalanced braces extracting ${name}`);
  return HTML.slice(m.index, k + 1) + (HTML[k + 1] === ";" ? ";" : "");
}
const fn = name => extractFrom(new RegExp("(?:async +)?function " + name + " *\\("), name);
const arrow = name => { const m = new RegExp(`^const ${name}\\s*=`, "m").exec(HTML); if (!m) throw new Error(`cannot find const ${name}`); return HTML.slice(m.index, HTML.indexOf("\n", m.index) + 1); };

const FNS = ["uint64Value","varint","cat","tag","bytesF","strF","u64F","Height","MsgTransfer","MsgExecuteContract","SwapAmountInRoute","MsgSwapExactAmountIn","MsgSendToEth","peggySendCalldata",
             "parseAmount","fmtUnits","fmt2","withinLoss",
             "b32Polymod","b32HrpExpand","bech32Decode","bech32Encode","convertBits","bech32Rehrp","bech32ToHex",
             "skipMsgToAny","swapOps","eip712MsgTypes","eip712Types","TxBody","checkCommon","checkSwap","checkSwapAndAction","parseJsonField","transferOp","abiWords","abiDyn","checkEvmTx","approvalPlan","decodeAxelarPayload","checkHookTransfer","singleCosmosMsg","checkAxelarMemo","addrsMismatch",
             "describeLimiter","variantConfigs",
             "nomicEncodeIbc","scriptNum","pushData","nomicRedeemScript","nomicDepositAddress","sameSigset","chainflipMinPriceX128","checkChainflipChannel",
             "checkOrbiterMemo","validateNobleToHub","validateFreeExitToHub","validateHubToInj","validateInjToHub","validateHubToNoble","validateInjToAll","validateNobleToAll",
             "validateAxlUnwrapFor","validateEthToAlloyAxelar","checkEurekaAction","validateAtomUnwrap","validateEthToAlloyEureka","validateGas"];
const src = [
  "const te = new TextEncoder();",
  extractFrom(/const K = /, "K"), extractFrom(/const GAS = /, "GAS"),
  arrow("U64_MAX"), arrow("B32"), arrow("Any"), arrow("sortedJson"), arrow("EIP712_DOMAIN"), arrow("EIP712_UINT64"), arrow("EIP712_MSG_TYPES"), arrow("eip712TypeName"), arrow("Coin"), arrow("pad32"), arrow("sameAddr"), arrow("hexToBytes"), arrow("opKind"), arrow("nearly"), arrow("limiterDenom"), arrow("bridgeFee"),
  arrow("OPC"), arrow("sha256"), arrow("nomicWithdrawMemo"), arrow("abiStr"), arrow("wordEq"),
  "const esc = s => String(s).replace(/[&<>\\\"']/g, c => ({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]));",
  "const unb64 = s => Uint8Array.from(Buffer.from(s, 'base64'));",
  ...FNS.map(fn),
  arrow("validateAxlUnwrap"), arrow("validateEthToAll"),
  `export {K,GAS,${FNS.join(",")},Any,Coin,sortedJson,EIP712_DOMAIN,eip712TypeName,pad32,sameAddr,nearly,limiterDenom,validateAxlUnwrap,validateEthToAll,nomicWithdrawMemo};`,
].join("\n");
const tmp = path.join(process.cwd(), ".test-extract.mjs");
fs.writeFileSync(tmp, src);
const M = await import(pathToFileURL(tmp).href);

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log("  FAIL  " + name); } };
const hex = u => Buffer.from(u).toString("hex");
const te = new TextEncoder();

/* ---------- protobuf against reference bytes ---------- */
const G = FIX("golden.json");
{
  const exec = M.MsgExecuteContract({
    sender: "osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0",
    contract: "osmo10a3k4hvk37cc4hnxctw4p95fhscd2z6h2rmx0aukc6rm8u9qqx9smfsh7u",
    msg: te.encode(JSON.stringify({swap_and_action:{user_swap:{swap_exact_asset_in:{swap_venue_name:"osmosis-poolmanager",operations:[{pool:"3497",denom_in:"a",denom_out:"b"}]}},min_asset:{native:{denom:"b",amount:"1"}},timeout_timestamp:"1787902690934484095",post_swap_action:{transfer:{to_address:"osmo1x"}},affiliates:[]}})),
    funds: [{denom:"factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC", amount:"10000000000"}],
  });
  ok(hex(exec) === G.exec, "MsgExecuteContract bytes == cosmjs-types");
  ok(hex(M.MsgExecuteContract({ sender:"osmo1a", contract:"osmo1b", msg: te.encode("{}"), funds: [] })) === G.exec0, "MsgExecuteContract with no funds");
  const xfer = M.MsgTransfer({ sourcePort:"transfer", sourceChannel:"channel-8",
    token:{denom:"erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a", amount:"9999999698"},
    sender:"inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpyurwgh", receiver:"osmo10a3k4hvk37cc4hnxctw4p95fhscd2z6h2rmx0aukc6rm8u9qqx9smfsh7u",
    timeoutHeight:{revisionNumber:0, revisionHeight:0}, timeoutTimestamp:"1787904803123140414", memo:'{"wasm":{"contract":"x"}}' });
  ok(hex(xfer) === G.xfer, "MsgTransfer bytes == cosmjs-types");
  const swap = M.MsgSwapExactAmountIn({ sender: "osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0",
    routes: [{ poolId: "3497", tokenOutDenom: "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138" }],
    tokenIn: { denom: "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC", amount: "10000000000" }, tokenOutMinAmount: "10000000000" });
  ok(hex(swap) === G.swap, "MsgSwapExactAmountIn bytes == chain-decoded reference");
}
{
  ok(M.skipMsgToAny(FIX("stage3-good.json").txs[0].cosmos_tx.msgs[0]).length > 600, "hook MsgTransfer encodes");
  ok(M.skipMsgToAny(FIX("stageA1-bad-folded-exit.json").txs[0].cosmos_tx.msgs[0]).length > 800, "MsgExecuteContract encodes");
  ok(M.skipMsgToAny(FIX("stageA1-good.json").txs[0].cosmos_tx.msgs[0]).length > 600, "orbiter MsgTransfer encodes");
  ok(M.skipMsgToAny(FIX("stageD1-good.json").txs[0].cosmos_tx.msgs[0]).length > 400, "Axelar MsgTransfer encodes");
  let threw = false; try { M.skipMsgToAny({ msg_type_url: "/cosmos.bank.v1beta1.MsgSend", msg: "{}" }); } catch { threw = true; }
  ok(threw, "refuses to encode an unexpected msg type");
}

/* ---------- Peggy: MsgSendToEth bytes (chain-decoded reference) and sendToInjective calldata ---------- */
{
  const m = M.MsgSendToEth({ sender: "inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpyurwgh", ethDest: "0x000000000000000000000000000000000000dead",
    amount: { denom: "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", amount: "1000000000" }, bridgeFee: { denom: "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", amount: "5000000" } });
  ok(hex(m) === G.sendToEth, "MsgSendToEth bytes == Injective-decoded reference");
  /* keccak-256, enough to check the pinned selector against the canonical signature */
  function keccak256(bytes) {
    const RC = [1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
    const R = [[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]];
    const M64 = (1n << 64n) - 1n, rot = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;
    const st = Array(25).fill(0n), rate = 136;
    const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate); padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) { let v = 0n; for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(padded[off + i * 8 + b]); st[i] ^= v; }
      for (let r = 0; r < 24; r++) {
        const C = [0,1,2,3,4].map(x => st[x] ^ st[x+5] ^ st[x+10] ^ st[x+15] ^ st[x+20]);
        const D = [0,1,2,3,4].map(x => C[(x+4)%5] ^ rot(C[(x+1)%5], 1));
        for (let i = 0; i < 25; i++) st[i] ^= D[i % 5];
        const B = Array(25);
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2*x + 3*y) % 5)] = rot(st[x + 5*y], R[x][y]);
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) st[x + 5*y] = B[x + 5*y] ^ ((~B[(x+1)%5 + 5*y] & M64) & B[(x+2)%5 + 5*y]);
        st[0] ^= RC[r];
      }
    }
    const out = []; for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out.push(Number((st[i] >> BigInt(8*b)) & 0xffn));
    return Buffer.from(out).toString("hex");
  }
  ok(keccak256(new Uint8Array(0)) === "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak-256 of the empty string");
  ok(keccak256(te.encode("sendToInjective(address,bytes32,uint256,string)")).slice(0, 8) === M.K.PEGGY_SEND_SELECTOR, "pinned Peggy selector == keccak of the canonical signature");
  const cd = M.peggySendCalldata("0xdac17f958d2ee523a2206206994597c13d831ec7", "0x000000000000000000000000000000000000dead", "1000000000");
  const words = cd.slice(2 + 8).match(/.{64}/g);
  ok(cd.startsWith("0x" + M.K.PEGGY_SEND_SELECTOR) && words.length === 5 && words[0].endsWith("dac17f958d2ee523a2206206994597c13d831ec7") && words[1].endsWith("dead") && BigInt("0x" + words[2]) === 1000000000n && BigInt("0x" + words[3]) === 0x80n && BigInt("0x" + words[4]) === 0n, "sendToInjective calldata: selector, token, bytes32 destination, amount, empty string");
}

/* ---------- Nomic deposit address derivation (reference values from the official nomic-bitcoin library run against
   this exact signatory set through a mock relayer: same broadcast bytes, same address) ---------- */
{
  const sigset = FIX("nomic-sigset.json");
  const dest = { sourcePort: "transfer", sourceChannel: "channel-1", receiver: "osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4dauqjkl", sender: "nomic1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4dflqcn8", memo: "", timeoutTimestamp: "1788354000000000000" };
  const r = await M.nomicDepositAddress(sigset, dest);
  ok(r.address === "bc1q2l84ujyh2r6qzwxl483t69fgjtds0kjskf4kzpexruwjl3tk2gfsagmfcw", "Nomic deposit address == nomic-bitcoin-js reference (" + r.address + ")");
  ok(r.broadcastBytes[0] === 1 && r.broadcastBytes.length === 1 + 1 + 8 + 1 + 9 + 1 + 43 + 1 + 44 + 8 + 2, "broadcast bytes: 0x01 || encoded IBC destination");
  ok(M.bech32Rehrp("osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4dauqjkl", "nomic") === dest.sender, "Nomic sender is the same key re-prefixed");
  ok(M.nomicWithdrawMemo("bc1qxyz") === '{"type":"bitcoin","data":"bc1qxyz"}', "withdrawal memo shape");
  ok([0, 1, 16, 17, 127, 128, 255, 256, 32767, 32768, 8388607, -1].map(n => Buffer.from(M.scriptNum(n)).toString("hex")).join(",") === ",01,10,11,7f,8000,ff00,0001,ff7f,008000,ffff7f,81", "script numbers match bitcoinjs encoding");
  ok(Buffer.from(M.pushData(new Uint8Array(0))).toString("hex") === "00" && Buffer.from(M.pushData(Uint8Array.of(7))).toString("hex") === "57" && Buffer.from(M.pushData(Uint8Array.of(0x81))).toString("hex") === "4f" && Buffer.from(M.pushData(Uint8Array.of(0x11))).toString("hex") === "0111", "minimal push opcodes");
  const other = JSON.parse(JSON.stringify(sigset)); other.signatories[3].voting_power = String(BigInt(other.signatories[3].voting_power) + 1n);
  ok(M.sameSigset(sigset, JSON.parse(JSON.stringify(sigset))) && !M.sameSigset(sigset, other), "relayer consensus compares the signatory set exactly");
  const r2 = await M.nomicDepositAddress(other, dest);
  ok(r2.address === r.address, "a voting-power change below the script's truncation leaves the address unchanged (why consensus must compare the set, not the address)");
  const other2 = JSON.parse(JSON.stringify(sigset)); other2.signatories[3].pubkey[5] ^= 1;
  const r4 = await M.nomicDepositAddress(other2, dest);
  ok(r4.address !== r.address, "a different signatory pubkey yields a different address");
  const r3 = await M.nomicDepositAddress(sigset, { ...dest, receiver: "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3" });
  ok(r3.address !== r.address, "a different receiver yields a different address");
}
/* ---------- Chainflip ---------- */
{
  const q = FIX("chainflip-quote-wbtc-btc.json").find(x => x.type === "REGULAR"), st = FIX("chainflip-status-good.json"), ch = FIX("chainflip-channel-good.json");
  const x128 = M.chainflipMinPriceX128(q.estimatedPrice, q.recommendedSlippageTolerancePercent, 8, 8);
  const back = Number(BigInt(x128) * 10n ** 20n / (1n << 128n)) / 1e20;
  ok(Math.abs(back - Number(st.fillOrKillParams.minPrice)) < 1e-12, `minPriceX128 round-trips to the minPrice Chainflip recorded (${back})`);
  const exp = { srcChain: "Ethereum", srcAsset: "WBTC", destChain: "Bitcoin", destAsset: "BTC", destAddress: "bc1q2l84ujyh2r6qzwxl483t69fgjtds0kjskf4kzpexruwjl3tk2gfsagmfcw", amount: "10000000", depositAddress: ch.depositAddress, id: ch.id, refundAddress: "0x000000000000000000000000000000000000dead", retryDurationBlocks: 150, minPriceX128: x128 };
  const errs = []; M.checkChainflipChannel(errs, st, exp); ok(!errs.length, "channel status accepted" + (errs.length ? " -> " + errs.join(" | ") : ""));
  const bad = (f, re, label) => { const e = []; const s2 = JSON.parse(JSON.stringify(st)); const x = { ...exp }; f(s2, x); M.checkChainflipChannel(e, s2, x); ok(e.some(m => re.test(m)), label + (e.length ? "" : " (ACCEPTED)")); };
  bad((s2) => { s2.destAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"; }, /pays to/, "channel paying elsewhere refused");
  bad((s2) => { s2.depositChannel.depositAddress = "0x000000000000000000000000000000000000beef"; }, /deposit address/, "deposit address mismatch refused");
  bad((s2) => { s2.depositChannel.expectedDepositAmount = "20000000"; }, /expected deposit/, "amount mismatch refused");
  bad((s2) => { s2.depositChannel.isExpired = true; }, /expired/, "expired channel refused");
  bad((s2) => { s2.destAsset = "ETH"; }, /destination/, "wrong destination asset refused");
  bad((s2) => { s2.fillOrKillParams.refundAddress = "0x000000000000000000000000000000000000beef"; }, /refund/, "refund to someone else refused");
  bad((s2, x) => { x.id = "1-Ethereum-2"; }, /channel id/, "channel id mismatch refused");
}

/* ---------- bech32 / hex ---------- */
ok(M.bech32Rehrp("osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0", "noble") === "noble147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqrunt9d", "osmo -> noble rehrp");
ok(M.bech32Rehrp("osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4dauqjkl", "axelar") === "axelar1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4d3f92tv", "osmo -> axelar rehrp");
ok(M.bech32Decode("axelar1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4da2h9pg") === null, "the mis-checksummed axelar address the probes used is rejected here");
ok(M.bech32ToHex("inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpyurwgh") === "0x0000000000000000000000000000000000000001", "inj -> 0x");
ok(M.bech32ToHex("noble1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4dayx2cr") === "0x000000000000000000000000000000000000dead", "noble -> 0x");
{ let t = false; try { M.bech32ToHex("osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0"); } catch { t = true; } ok(t, "32-byte (contract) address is not a 20-byte recipient"); }
ok(M.bech32Decode("osmox147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0") === null, "bad checksum rejected");
ok(M.pad32("0xDeAd") === "0".repeat(60) + "dead", "pad32 lowercases and pads");
ok(M.withinLoss("10000000000", "9995000000") && !M.withinLoss("10000000000", "9994999999"), "withinLoss at 5 bps");
ok(M.nearly("9990000000", "10000000000") && !M.nearly("9989999999", "10000000000"), "nearly at 0.1%");
{
  const env = (prefix, text) => Uint8Array.from([...prefix, ...Buffer.from(text, "utf8")]);
  const good = '{"swap_and_action_with_recover":{"recovery_addr":"osmo1x"}}';
  let e = []; ok(M.decodeAxelarPayload(env([0, 0, 0, 2], good), e)?.recovery_addr === "osmo1x" && !e.length, "exact Axelar envelope decodes");
  e = []; M.decodeAxelarPayload(env([0, 0, 0, 0], good), e); ok(e.some(m => /envelope/.test(m)), "wrong envelope refused");
  e = []; M.decodeAxelarPayload(env([0, 0, 0, 2], good + "x"), e); ok(e.some(m => /single JSON/.test(m)), "trailing bytes refused");
  e = []; M.decodeAxelarPayload(env([0, 0, 0, 2], '{"swap_and_action":{}}'), e); ok(e.some(m => /top-level/.test(m)), "plain swap_and_action refused");
  e = []; M.decodeAxelarPayload(env([0, 0, 0, 2], '{"swap_and_action_with_recover":{},"x":1}'), e); ok(e.some(m => /top-level/.test(m)), "extra top-level key refused");
  e = []; M.decodeAxelarPayload(Uint8Array.from([0, 0, 0, 2, 0xff, 0xfe, 0x7b, 0x7d]), e); ok(e.some(m => /UTF-8/.test(m)), "invalid UTF-8 refused");
}

/* ---------- transmuter limiter shapes ---------- */
{
  const v3 = [["ibc/AAA", "1h"], { static_limiter: { upper_limit: "0.6" } }];
  ok(M.limiterDenom(v3) === "ibc/AAA" && M.describeLimiter(v3) === "static ≤ 60.0% (1h)", "v3 pair-shaped static limiter");
  const ch = [["ibc/BBB", "1d"], { change_limiter: { boundary_offset: "0.05", divisions: [] } }];
  ok(M.describeLimiter(ch) === "change ±5.0% (1d)", "change limiter");
  const obj = { denom: "ibc/CCC", label: "x", limiter: { static_limiter: { upper_limit: "0.25" } } };
  ok(M.limiterDenom(obj) === "ibc/CCC" && M.describeLimiter(obj) === "static ≤ 25.0% (x)", "object-shaped limiter");
  ok(M.describeLimiter([["d", ""], { something_else: {} }]) === "unrecognised limiter", "unknown limiter type is named, not hidden");
}

/* ---------- variants come from the contract's asset configs, minus the alloy itself ---------- */
{
  const ALL = "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC";
  const v = M.variantConfigs([{ denom: "ibc/A", normalization_factor: "1" }, { denom: "ibc/B", normalization_factor: "1000000" }, { denom: ALL, normalization_factor: "1" }], ALL);
  ok(JSON.stringify(v.denoms) === JSON.stringify(["ibc/A", "ibc/B"]) && v.nf["ibc/B"] === "1000000", "alloy denom excluded, normalisation factors kept");
  ok(M.variantConfigs(undefined, ALL).denoms.length === 0 && M.variantConfigs([{ normalization_factor: "1" }], ALL).denoms.length === 0, "missing or malformed configs yield no variants");
}

/* ---------- amounts ---------- */
ok(M.parseAmount("10000", 6) === "10000000000" && M.parseAmount("0.000001", 6) === "1", "parseAmount");
ok(M.fmtUnits("10000000000") === "10,000" && M.fmtUnits("9999979927") === "9,999.979927", "fmtUnits exact");
ok(M.fmt2("10000000000") === "10,000.00" && M.fmt2("9999979927") === "9,999.97" && M.fmt2("0") === "0.00" && M.fmt2("9999") === "<0.01" && M.fmt2("10000") === "0.01", "fmt2 floors to two decimals");
ok(M.fmt2("131571891751785121", 18) === "0.13" && M.fmt2("3200000000000000", 18) === "<0.01", "fmt2 at 18 decimals");
{ let t = false; try { M.parseAmount("1.1234567", 6); } catch { t = true; } ok(t, "too many decimals rejected"); }

/* ---------- validators: the addresses the fixtures were requested with ---------- */
const OSMO32 = "osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0";   // A/B fixtures were requested with this (contract) address as "you"
const OSMO20 = "osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4dauqjkl";                        // Ethereum-leg fixtures with this one
const EVM  = "0x000000000000000000000000000000000000dead";
const INJ  = "inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpyurwgh";
const NOBLE20 = "noble1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4dayx2cr", NOBLE20HEX = "0x000000000000000000000000000000000000dead";
const HUB20 = "cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4d48nzqd";
const AMT  = "10000000000";
const FUTURE = String((BigInt(Date.now()) + 3600000n) * 1000000n);
function freshen(res) {
  const r = JSON.parse(JSON.stringify(res));
  for (const t of r.txs || []) for (const m of t.cosmos_tx?.msgs || []) {
    const j = JSON.parse(m.msg);
    if (j.timeout_timestamp) j.timeout_timestamp = FUTURE;
    if (j.msg?.swap_and_action) j.msg.swap_and_action.timeout_timestamp = FUTURE;
    if (j.memo) { try { const mm = JSON.parse(j.memo); if (mm.wasm?.msg?.swap_and_action) { mm.wasm.msg.swap_and_action.timeout_timestamp = FUTURE; j.memo = JSON.stringify(mm); } } catch {} }
    m.msg = JSON.stringify(j);
  }
  /* Eureka calls carry unix-second timeouts as ABI words (word 4, and word 4 of the pointed-to struct): push them forward */
  for (const t of r.txs || []) if (t.evm_tx?.data && t.evm_tx.data.replace(/^0x/i, "").startsWith("eecf31f9")) {
    const d = t.evm_tx.data.replace(/^0x/i, ""); const body = d.slice(8);
    const future = BigInt(Math.floor(Date.now() / 1000) + 3600).toString(16).padStart(64, "0");
    const setW = (b, i, v) => b.slice(0, i * 64) + v + b.slice((i + 1) * 64);
    let nb = setW(body, 4, future);
    const st = Number(BigInt("0x" + body.slice(64, 128))) * 2;
    nb = nb.slice(0, st) + setW(nb.slice(st), 4, future);
    t.evm_tx.data = d.slice(0, 8) + nb;
  }
  /* Axelar GMP and Eureka calldata embed JSON timeouts too, sometimes escaped inside a nested memo string:
     rewrite the digits of every occurrence in place so the hex stays aligned */
  for (const t of r.txs || []) if (t.evm_tx?.data) {
    const buf = Buffer.from(t.evm_tx.data.replace(/^0x/, ""), "hex");
    const fixed = buf.toString("latin1").replace(/("timeout_timestamp\\?":)(\d+)/g, (all, pre, num) => pre + FUTURE.padStart(num.length, "1").slice(0, num.length));
    t.evm_tx.data = Buffer.from(fixed, "latin1").toString("hex");
  }
  return r;
}
const show = v => v.errs.length ? " -> " + v.errs.join(" | ") : "";
const mut = (res, f) => { const r = JSON.parse(JSON.stringify(res)); f(r); return r; };
const setMsg = (r, f) => { const m = r.txs[0].cosmos_tx.msgs[0]; const j = JSON.parse(m.msg); f(j); m.msg = JSON.stringify(j); };
const setMemo = (j, f) => { const mm = JSON.parse(j.memo); f(mm); j.memo = JSON.stringify(mm); };
const refused = (label, v, re) => ok(!v.ok && v.errs.some(e => re.test(e)), label + (v.ok ? " (ACCEPTED)" : " (wrong reason: " + v.errs.join(" | ") + ")"));

/* ----- Avalanche hub: reduce noble > increase inj (A) and the reverse (B) ----- */
const a1 = freshen(FIX("stageA1-good.json")), a1s = freshen(FIX("stageA1-good-25.json")), a2 = freshen(FIX("stage2-good.json")), a3 = freshen(FIX("stage3-good.json"));
const c1 = { osmo: OSMO20, evm: EVM, amountIn: AMT, hub: "43114" }, c2 = { evm: EVM, injHex: EVM, amountIn: AMT, hub: "43114" }, c3 = { inj: INJ, osmo: OSMO32, amountIn: AMT };
{ const v = M.validateNobleToHub(a1, c1); ok(v.ok, "A1 good route accepted" + show(v)); }
{ const v = M.validateNobleToHub(a1s, { ...c1, amountIn: "25000000" }); ok(v.ok, "A1 good route at 25 USDC accepted (flat relay fee exceeds 5 bps)" + show(v)); }
{ const v = M.validateHubToInj(a2, c2); ok(v.ok, "A2 good route accepted" + show(v)); }
{ const v = M.validateInjToAll(a3, c3); ok(v.ok, "A3 good route accepted" + show(v)); }
/* the two ways Skip offered to do the transmuter exit for us, both refused: the page does that swap itself */
refused("A1: Skip's folded exit (MsgExecuteContract via 3497)", M.validateNobleToHub(freshen(FIX("stageA1-bad-folded-exit.json")), { ...c1, osmo: OSMO32 }), /source denom|operations|msg type/);
refused("A1: Skip's allBTC detour at small size (pools 3504 + 1943)", M.validateNobleToHub(freshen(FIX("stageA1-bad-allbtc-detour.json")), { ...c1, amountIn: "25000000" }), /source denom|operations|msg type/);
refused("A1: Ethereum-bound transfer offered for the Avalanche stage", M.validateNobleToHub(freshen(FIX("stageE1-good.json")), c1), /dest|chain path|destination domain/);
refused("A2: Go Fast route landing as USDC.noble", M.validateHubToInj(freshen(FIX("stage2-bad-gofast-to-noble.json")), c2), /operations|dest/);
refused("A2: two-tx route", M.validateHubToInj(freshen(FIX("stage2-bad-two-txs.json")), c2), /exactly 1 tx|chain path/);
refused("A1: Skip error body", M.validateNobleToHub({ message: "no route" }, c1), /no route/);
refused("A3: null", M.validateInjToAll(null, c3), /no route/);
refused("A1: someone else's mint recipient", M.validateNobleToHub(a1, { ...c1, evm: "0x000000000000000000000000000000000000beef" }), /mint_recipient/);
refused("A1: token is allUSDC, not USDC.noble", M.validateNobleToHub(mut(a1, r => setMsg(r, j => { j.token.denom = "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC"; })), c1), /token/);
refused("A1: wrong token amount", M.validateNobleToHub(mut(a1, r => setMsg(r, j => { j.token.amount = "9000000000"; })), c1), /token/);
refused("A1: wrong channel", M.validateNobleToHub(mut(a1, r => setMsg(r, j => { j.source_channel = "channel-122"; })), c1), /channel/);
refused("A1: low amount_out at 10k", M.validateNobleToHub(mut(a1, r => { r.route.amount_out = "9990000000"; }), c1), /loses more than/);
refused("A1: low amount_out at 25 beyond the flat allowance", M.validateNobleToHub(mut(a1s, r => { r.route.amount_out = "24900000"; }), { ...c1, amountIn: "25000000" }), /loses more than/);
refused("A1: wrong Noble receiver", M.validateNobleToHub(mut(a1, r => setMsg(r, j => { j.receiver = "noble1dyw0geqa2cy0ppdjcxfpzusjpwmq85r5a35hqe"; })), c1), /orbiter module/);
refused("A1: wrong CCTP domain", M.validateNobleToHub(mut(a1, r => setMsg(r, j => setMemo(j, mm => { mm.orbiter.forwarding.attributes.destination_domain = 0; }))), c1), /destination domain/);
refused("A1: extra bridge hop", M.validateNobleToHub(mut(a1, r => { r.route.operations.push({ hyperlane_transfer: {} }); }), c1), /operations/);
refused("A1: signer mismatch", M.validateNobleToHub(a1, { ...c1, osmo: "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3" }), /signer|sender/);
/* the opt-in free exit: Skip picks the pools, everything downstream is still pinned, and it reports whether 3497 was used */
{
  const detour = freshen(FIX("stageA1-bad-allbtc-detour.json")), folded = freshen(FIX("stageA1-bad-folded-exit.json"));
  const v = M.validateFreeExitToHub(detour, { ...c1, amountIn: "25000000" });
  ok(v.ok && !v.removesVariant && v.pools.join(",") === "3504,1943", "free exit: allBTC detour accepted and flagged as not removing USDC.noble" + show(v));
  const w = M.validateFreeExitToHub(folded, { ...c1, osmo: OSMO32 });
  ok(w.ok && w.removesVariant && w.pools.join(",") === "3497", "free exit: Skip's 3497 exit accepted and flagged as removing USDC.noble" + show(w));
  refused("free exit: the pinned Noble MsgTransfer is not a free exit", M.validateFreeExitToHub(a1, c1), /source denom|operations|msg type/);
  refused("free exit: someone else's mint recipient", M.validateFreeExitToHub(detour, { ...c1, amountIn: "25000000", evm: "0x000000000000000000000000000000000000beef" }), /mint_recipient/);
  refused("free exit: affiliate skim", M.validateFreeExitToHub(mut(detour, r => setMsg(r, j => { j.msg.swap_and_action.affiliates = [{ address: "osmo1x", basis_points_fee: "10" }]; })), { ...c1, amountIn: "25000000" }), /affiliates/);
  refused("free exit: wrong contract", M.validateFreeExitToHub(mut(detour, r => setMsg(r, j => { j.contract = "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3"; })), { ...c1, amountIn: "25000000" }), /pinned Skip entry point/);
  refused("free exit: swap path ending somewhere other than USDC.noble", M.validateFreeExitToHub(mut(detour, r => setMsg(r, j => { const o = j.msg.swap_and_action.user_swap.swap_exact_asset_in.operations; o[o.length - 1].denom_out = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138"; })), { ...c1, amountIn: "25000000" }), /USDC.noble/);
  refused("free exit: min_asset far below input", M.validateFreeExitToHub(mut(detour, r => setMsg(r, j => { j.msg.swap_and_action.min_asset.native.amount = "20000000"; })), { ...c1, amountIn: "25000000" }), /min_asset/);
  refused("free exit: wrong Noble receiver", M.validateFreeExitToHub(mut(detour, r => setMsg(r, j => { j.msg.swap_and_action.post_swap_action.ibc_transfer.ibc_info.receiver = "noble1dyw0geqa2cy0ppdjcxfpzusjpwmq85r5a35hqe"; })), { ...c1, amountIn: "25000000" }), /orbiter module/);
  refused("free exit: Ethereum-bound route on the Avalanche stage", M.validateFreeExitToHub(freshen(FIX("stageE1-bad-folded-exit.json")), c1), /dest|chain path|destination domain/);
  ok(!M.validateGas(detour, { osmo: OSMO20, target: "avax", recipient: EVM, recipientHex: EVM }).ok, "gas validator still refuses the detour route");
}
refused("A1: unexpected orbiter pre_action", M.validateNobleToHub(mut(a1, r => setMsg(r, j => setMemo(j, mm => { mm.orbiter.pre_actions.push({ id: "ACTION_SWAP", attributes: {} }); }))), c1), /pre_action/);
refused("A2: wrong adapter", M.validateHubToInj(mut(a2, r => { r.txs[0].evm_tx.to = "0xb7B287F15e5edDFEfF2b05ef1BE7F7cc73197AaA"; }), c2), /pinned adapter/);
refused("A2: recipient is not my Injective account", M.validateHubToInj(a2, { ...c2, injHex: "0x000000000000000000000000000000000000beef" }), /recipient/);
refused("A2: approval to a third party", M.validateHubToInj(mut(a2, r => { r.txs[0].evm_tx.required_erc20_approvals[0].spender = "0x000000000000000000000000000000000000beef"; }), c2), /spender/);
refused("A2: unlimited approval", M.validateHubToInj(mut(a2, r => { r.txs[0].evm_tx.required_erc20_approvals[0].amount = "115792089237316195423570985008687907853269984665640564039457584007913129639935"; }), c2), /approval amount/);
refused("A2: native value attached", M.validateHubToInj(mut(a2, r => { r.txs[0].evm_tx.value = "1"; }), c2), /native value/);
refused("A3: wrong channel", M.validateInjToAll(mut(a3, r => setMsg(r, j => { j.source_channel = "channel-122"; })), c3), /channel/);
refused("A3: final recipient is not me", M.validateInjToAll(a3, { ...c3, osmo: "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3" }), /final recipient/);
refused("A3: hook swaps on another pool", M.validateInjToAll(mut(a3, r => setMsg(r, j => setMemo(j, mm => { mm.wasm.msg.swap_and_action.user_swap.swap_exact_asset_in.operations[0].pool = "1868"; }))), c3), /pool 1868/);
refused("A3: hook to another contract", M.validateInjToAll(mut(a3, r => setMsg(r, j => setMemo(j, mm => { mm.wasm.contract = "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3"; }))), c3), /hook contract/);
refused("A3: min_asset too low", M.validateInjToAll(mut(a3, r => setMsg(r, j => setMemo(j, mm => { mm.wasm.msg.swap_and_action.min_asset.native.amount = "9000000000"; }))), c3), /min_asset/);
refused("A3: expired timeout", M.validateInjToAll(mut(a3, r => setMsg(r, j => { j.timeout_timestamp = "1000000000000000000"; })), c3), /timeout/);
refused("A3: token is USDC.noble", M.validateInjToAll(mut(a3, r => setMsg(r, j => { j.token.denom = "ibc/2CBC2EA121AE42563B08028466F37B600F2D7D4282342DE938283CC3FB2BC00E"; })), c3), /token/);

const b2 = freshen(FIX("stageB2-good.json")), b3 = freshen(FIX("stageB3-good.json")), b4 = freshen(FIX("stageB4-good.json"));
const cb2 = { injHex: EVM, evm: EVM, amountIn: AMT, hub: "43114" }, cb3 = { evm: EVM, nobleHex: NOBLE20HEX, amountIn: AMT, hub: "43114" }, cb4 = { noble: NOBLE20, osmo: OSMO32, amountIn: "9999980000" };
{ const v = M.validateInjToHub(b2, cb2); ok(v.ok, "B2 good route accepted" + show(v)); }
{ const v = M.validateHubToNoble(b3, cb3); ok(v.ok, "B3 good route accepted" + show(v)); }
{ const v = M.validateNobleToAll(b4, cb4); ok(v.ok, "B4 good route accepted" + show(v)); }
{ const f = freshen(FIX("stageB-bad-skip-forwarder.json"));
  ok(!M.validateInjToHub(f, cb2).ok && !M.validateInjToAll(f, c3).ok && !M.validateNobleToHub(f, { ...c1, osmo: OSMO32 }).ok && !M.validateAxlUnwrap(f, { osmo: OSMO32, evm: EVM, amountIn: AMT }).ok, "B: Osmosis MsgTransfer to Skip's Injective forwarder refused everywhere"); }
{ const f = freshen(FIX("stageB-bad-two-txs-via-noble.json"));
  ok(!M.validateHubToNoble(f, cb3).ok && !M.validateHubToInj(f, c2).ok, "B: two-tx Avalanche -> Noble -> Osmosis route refused"); }
refused("B2: recipient is not my Avalanche address", M.validateInjToHub(b2, { ...cb2, evm: "0x000000000000000000000000000000000000beef" }), /recipient/);
refused("B2: wrong source chain", M.validateInjToHub(mut(b2, r => { r.route.source_asset_chain_id = "injective-1"; }), cb2), /source chain/);
refused("B2: wrong adapter", M.validateInjToHub(mut(b2, r => { r.txs[0].evm_tx.to = "0xB19Ff56BD455C2515207BDbdEDC68B57fBA9A78D"; }), cb2), /pinned adapter/);
refused("B2: Ethereum-bound burn offered for the Avalanche stage", M.validateInjToHub(freshen(FIX("stageC2-good.json")), cb2), /dest|chain path|mint domain/);
refused("B3: recipient is not my Noble account", M.validateHubToNoble(b3, { ...cb3, nobleHex: "0x000000000000000000000000000000000000beef" }), /recipient/);
refused("B3: wrong adapter (the v2 one)", M.validateHubToNoble(mut(b3, r => { r.txs[0].evm_tx.to = "0x400BB58033a7763A834199190B68F66A2661aE73"; }), cb3), /pinned adapter/);
refused("B3: Ethereum's v1 adapter offered on Avalanche", M.validateHubToNoble(mut(b3, r => { r.txs[0].evm_tx.to = "0xf33e750336e9C0D4E2f4c0D450d753030693CC71"; }), cb3), /pinned adapter/);
refused("B4: wrong channel", M.validateNobleToAll(mut(b4, r => setMsg(r, j => { j.source_channel = "channel-4"; })), cb4), /channel/);
refused("B4: final recipient is not me", M.validateNobleToAll(b4, { ...cb4, osmo: "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3" }), /final recipient/);
refused("B4: hook swap in the wrong denom", M.validateNobleToAll(mut(b4, r => setMsg(r, j => setMemo(j, mm => { mm.wasm.msg.swap_and_action.user_swap.swap_exact_asset_in.operations[0].denom_in = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138"; }))), cb4), /denom_in/);

/* ----- Ethereum hub: every pairing that touches USDC.axl ----- */
const e1 = freshen(FIX("stageE1-good.json")), e2 = freshen(FIX("stageE2-good.json")), d1 = freshen(FIX("stageD1-good.json")), d2 = freshen(FIX("stageD2-good.json")), cc2 = freshen(FIX("stageC2-good.json")), cc3 = freshen(FIX("stageC3-good.json"));
const ce1 = { osmo: OSMO20, evm: EVM, amountIn: AMT, hub: "1" }, ce2 = { evm: EVM, osmo: OSMO20, amountIn: AMT }, cd1 = { osmo: OSMO20, evm: EVM, amountIn: AMT };
const cd2 = { evm: EVM, nobleHex: NOBLE20HEX, amountIn: AMT, hub: "1" }, ccc2 = { injHex: EVM, evm: EVM, amountIn: AMT, hub: "1" }, ccc3 = { evm: EVM, injHex: EVM, amountIn: AMT, hub: "1" };
{ const v = M.validateNobleToHub(e1, ce1); ok(v.ok, "E1 (USDC.noble -> Noble -> Ethereum) accepted" + show(v)); }
{ const v = M.validateEthToAll(e2, ce2); ok(v.ok, "E2 (Ethereum -> Axelar -> allUSDC) accepted" + show(v)); }
refused("E1: Skip's folded exit toward Ethereum refused", M.validateNobleToHub(freshen(FIX("stageE1-bad-folded-exit.json")), ce1), /source denom|operations|msg type/);
refused("E1: orbiter fee above the Ethereum cap", M.validateNobleToHub(mut(e1, r => setMsg(r, j => setMemo(j, mm => { mm.orbiter.pre_actions[0].attributes.fees_info[0].amount.value = "400000"; }))), ce1), /orbiter fee/);
refused("A1: Ethereum-sized orbiter fee refused on the Avalanche stage", M.validateNobleToHub(mut(a1, r => setMsg(r, j => setMemo(j, mm => { mm.orbiter.pre_actions[0].attributes.fees_info[0].amount.value = "84086"; }))), c1), /orbiter fee/);
refused("E1: Avalanche-bound transfer offered for the Ethereum stage", M.validateNobleToHub(a1, ce1), /dest|chain path|destination domain/);
{ const v = M.validateAxlUnwrap(d1, cd1); ok(v.ok && v.fee === "1052486", "D1 (USDC.axl -> Axelar -> Ethereum) accepted" + show(v)); }
{ const v = M.validateHubToNoble(d2, cd2); ok(v.ok, "D2 (Ethereum -> Noble) accepted" + show(v)); }
{ const v = M.validateInjToHub(cc2, ccc2); ok(v.ok, "C2 (Injective EVM -> Ethereum) accepted" + show(v)); }
{ const v = M.validateHubToInj(cc3, ccc3); ok(v.ok, "C3 (Ethereum -> Injective EVM) accepted" + show(v)); }
/* Skip's default for USDC.axl is to swap it into USDC.noble on pool 3497 and CCTP from Noble: that is not an axl exit */
refused("D1: Skip's default route (3497 swap into noble) refused", M.validateAxlUnwrap(freshen(FIX("stageD1-bad-skip-default-swaps-into-noble.json")), cd1), /operations|chain path|msg type/);
refused("D1: Axelar fee above cap", M.validateAxlUnwrap(mut(d1, r => { r.route.estimated_fees[0].usd_amount = "9"; }), cd1), /Axelar fee \$9.00 exceeds/);
refused("D1: memo fee differs from the quote", M.validateAxlUnwrap(mut(d1, r => setMsg(r, j => setMemo(j, mm => { mm.fee.amount = "5000000"; }))), cd1), /memo fee/);
refused("D1: amount_out hides a larger loss", M.validateAxlUnwrap(mut(d1, r => { r.route.amount_out = "9990000000"; }), cd1), /loses more than the quoted Axelar fee/);
refused("D1: payload to someone else", M.validateAxlUnwrap(d1, { ...cd1, evm: "0x000000000000000000000000000000000000beef" }), /payload/);
refused("D1: GMP receiver is not the pinned Axelar account", M.validateAxlUnwrap(mut(d1, r => setMsg(r, j => { j.receiver = "axelar1aythygn6z5thymj6tmzfwekzh05ewg3l7d6y89"; })), cd1), /Axelar GMP account/);
refused("D1: destination contract is not Skip's receiver", M.validateAxlUnwrap(mut(d1, r => setMsg(r, j => setMemo(j, mm => { mm.destination_address = "0xBeB12d8861765c850E8426Cc5c6a5207222f2477"; }))), cd1), /destination_address/);
refused("D1: destination chain is not Ethereum", M.validateAxlUnwrap(mut(d1, r => setMsg(r, j => setMemo(j, mm => { mm.destination_chain = "Avalanche"; }))), cd1), /Axelar destination/);
refused("D1: token is USDC.noble", M.validateAxlUnwrap(mut(d1, r => setMsg(r, j => { j.token.denom = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4"; })), cd1), /token/);
refused("E2: plain USDC.axl delivery without the swap refused", M.validateEthToAll(freshen(FIX("stageE2-bad-no-swap-plain-axl.json")), ce2), /operations|dest denom|swap_and_action/);
refused("E2: final recipient is not me", M.validateEthToAll(e2, { ...ce2, osmo: "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3" }), /final recipient|recovery_addr/);
refused("E2: wrong receiver contract", M.validateEthToAll(mut(e2, r => { r.txs[0].evm_tx.to = "0x400BB58033a7763A834199190B68F66A2661aE73"; }), ce2), /pinned adapter/);
refused("E2: native value not equal to the quoted relayer fee", M.validateEthToAll(mut(e2, r => { r.txs[0].evm_tx.value = "999999999999999999"; }), ce2), /native value/);
refused("E2: relayer fee over cap", M.validateEthToAll(mut(e2, r => { r.route.estimated_fees[0].amount = "3000000000000000"; r.txs[0].evm_tx.value = "3000000000000000"; }), ce2), /relayer fee/);
refused("E2: unlimited approval", M.validateEthToAll(mut(e2, r => { r.txs[0].evm_tx.required_erc20_approvals[0].amount = "115792089237316195423570985008687907853269984665640564039457584007913129639935"; }), ce2), /approval amount/);
refused("E2: calldata swaps on another pool", M.validateEthToAll(mut(e2, r => { r.txs[0].evm_tx.data = r.txs[0].evm_tx.data.replace(Buffer.from('"pool":"3497"').toString("hex"), Buffer.from('"pool":"1223"').toString("hex")); }), ce2), /pool 1223/);
refused("E2: calldata to another entry point", M.validateEthToAll(mut(e2, r => { r.txs[0].evm_tx.data = r.txs[0].evm_tx.data.split(Buffer.from("osmo10a3k4hvk37cc4hnxctw4p95fhscd2z6h2rmx0aukc6rm8u9qqx9smfsh7u").toString("hex")).join(Buffer.from("osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3").toString("hex")); }), ce2), /destination address/);
refused("D2: recipient is not my Noble account", M.validateHubToNoble(d2, { ...cd2, nobleHex: "0x000000000000000000000000000000000000beef" }), /recipient/);
refused("D2: Avalanche's v1 adapter offered on Ethereum", M.validateHubToNoble(mut(d2, r => { r.txs[0].evm_tx.to = "0xB19Ff56BD455C2515207BDbdEDC68B57fBA9A78D"; }), cd2), /pinned adapter/);
refused("C2: Avalanche-bound burn offered for the Ethereum stage", M.validateInjToHub(b2, ccc2), /dest|chain path|mint domain/);
refused("C3: recipient is not my Injective account", M.validateHubToInj(cc3, { ...ccc3, injHex: "0x000000000000000000000000000000000000beef" }), /recipient/);

/* ----- the Axelar <-> Eureka pairs of Alloyed BTC, ETH and USDT (all through Ethereum) ----- */
{
  const specs = {
    BTC:  { alloy: "factory/osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3/alloyed/allBTC",  pool: "1868", amt: "100000000" },
    ETH:  { alloy: "factory/osmo1k6c8jln7ejuqwtqmay3yvzrg3kueaczl96pk067ldg8u835w0yhsw27twm/alloyed/allETH",  pool: "1878", amt: "1000000000000000000" },
    USDT: { alloy: "factory/osmo1em6xs47hd82806f5cxgyufguxrrc7l0aqx7nzzptjuqgswczk8csavdxek/alloyed/allUSDT", pool: "1816", amt: "1000000000" },
  };
  for (const [name, sp] of Object.entries(specs)) {
    const pr = M.K.ETH_PAIRS["all" + name], amt = sp.amt;
    const x1 = freshen(FIX(`pair${name}-X1-good.json`)), x2 = freshen(FIX(`pair${name}-X2-good.json`)), y1 = freshen(FIX(`pair${name}-Y1-good.json`)), y2 = freshen(FIX(`pair${name}-Y2-good.json`));
    const cx1 = { osmo: OSMO20, evm: EVM, amountIn: amt, denom: pr.axl, token: pr.token };
    const cx2 = { evm: EVM, osmo: OSMO20, hub: HUB20, amountIn: amt, alloy: sp.alloy, pool: sp.pool, variant: pr.atom, token: pr.token };
    const cy1 = { osmo: OSMO20, hub: HUB20, evm: EVM, amountIn: amt, denom: pr.atom, token: pr.token };
    const cy2 = { evm: EVM, osmo: OSMO20, amountIn: amt, alloy: sp.alloy, pool: sp.pool, variant: pr.axl, token: pr.token, sym: pr.sym };
    { const v = M.validateAxlUnwrapFor(x1, cx1); ok(v.ok, `${name} X1 (Axelar unwrap) accepted` + show(v)); }
    { const v = M.validateEthToAlloyEureka(x2, cx2); ok(v.ok, `${name} X2 (Eureka wrap + pool ${sp.pool} swap) accepted` + show(v)); }
    { const v = M.validateAtomUnwrap(y1, cy1); ok(v.ok, `${name} Y1 (Eureka unwrap) accepted` + show(v)); }
    { const v = M.validateEthToAlloyAxelar(y2, cy2); ok(v.ok, `${name} Y2 (Axelar wrap + pool ${sp.pool} swap) accepted` + show(v)); }
    /* the legs must not be interchangeable */
    refused(`${name}: Eureka wrap offered where Axelar wrap expected`, M.validateEthToAlloyAxelar(x2, cy2), /operations|chain path|pinned adapter/);
    refused(`${name}: Axelar wrap offered where Eureka wrap expected`, M.validateEthToAlloyEureka(y2, cx2), /operations|chain path|pinned adapter/);
    refused(`${name}: Eureka unwrap offered where Axelar unwrap expected`, M.validateAxlUnwrapFor(y1, cx1), /source denom|operations|chain path/);
    refused(`${name}: Axelar unwrap offered where Eureka unwrap expected`, M.validateAtomUnwrap(x1, cy1), /source denom|operations|chain path/);
    /* recipients */
    refused(`${name} Y1: Ethereum receiver is not me`, M.validateAtomUnwrap(y1, { ...cy1, evm: "0x000000000000000000000000000000000000beef" }), /EVM address/);
    refused(`${name} Y1: recovery address is not my Hub account`, M.validateAtomUnwrap(y1, { ...cy1, hub: "cosmos1lqu9662kd4my6dww4gzp3730vew0gkwe0nl9ztjh0n5da0a8zc4swsvd22" }), /recover_address/);
    refused(`${name} X2: final recipient is not me`, M.validateEthToAlloyEureka(x2, { ...cx2, osmo: "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3" }), /final recipient/);
    refused(`${name} X2: recovery address is not my Hub account`, M.validateEthToAlloyEureka(x2, { ...cx2, hub: "cosmos1lqu9662kd4my6dww4gzp3730vew0gkwe0nl9ztjh0n5da0a8zc4swsvd22" }), /recover_address/);
    refused(`${name} X1: payload to someone else`, M.validateAxlUnwrapFor(x1, { ...cx1, evm: "0x000000000000000000000000000000000000beef" }), /payload/);
    refused(`${name} Y2: final recipient is not me`, M.validateEthToAlloyAxelar(y2, { ...cy2, osmo: "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3" }), /final recipient|recovery_addr/);
    /* pinned contracts and pools */
    refused(`${name} X2: wrong Eureka contract`, M.validateEthToAlloyEureka(mut(x2, r => { r.txs[0].evm_tx.to = "0xB773bCc5B325ad9AC6B36e1A046AD4466833A16E"; }), cx2), /pinned adapter/);
    refused(`${name} X2: swap on another pool`, M.validateEthToAlloyEureka(x2, { ...cx2, pool: "3497" }), /pool/);
    refused(`${name} Y2: swap on another pool`, M.validateEthToAlloyAxelar(y2, { ...cy2, pool: "3497" }), /pool/);
    refused(`${name} Y1: Hub receiver is not Skip's entry point`, M.validateAtomUnwrap(mut(y1, r => setMsg(r, j => { j.receiver = "cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4d48nzqd"; })), cy1), /Hub entry point/);
    refused(`${name} Y1: Hub action contract swapped`, M.validateAtomUnwrap(mut(y1, r => setMsg(r, j => setMemo(j, mm => { mm.wasm.contract = "cosmos1lqu9662kd4my6dww4gzp3730vew0gkwe0nl9ztjh0n5da0a8zc4swsvd22"; }))), cy1), /action contract/);
    refused(`${name} X1: token is the Hub variant`, M.validateAxlUnwrapFor(mut(x1, r => setMsg(r, j => { j.token.denom = pr.atom; })), cx1), /token/);
    /* fees */
    refused(`${name} Y1: Eureka fee over cap`, M.validateAtomUnwrap(mut(y1, r => { r.route.estimated_fees[0].usd_amount = "9"; }), cy1), /Eureka fee/);
    refused(`${name} X1: Axelar fee over cap`, M.validateAxlUnwrapFor(mut(x1, r => { r.route.estimated_fees[0].usd_amount = "9"; }), cx1), /Axelar fee/);
    refused(`${name} Y1: memo fee differs from the quote`, M.validateAtomUnwrap(mut(y1, r => setMsg(r, j => setMemo(j, mm => { mm.wasm.msg.action.action.ibc_transfer.ibc_info.eureka_fee.coin.amount = "1"; }))), cy1), /memo Eureka fee/);
  }
  const pr = M.K.ETH_PAIRS.allBTC;
  refused("BTC: plain Eureka delivery without the alloy swap refused", M.validateEthToAlloyEureka(freshen(FIX("pairBTC-bad-eureka-no-swap.json")), { evm: EVM, osmo: OSMO20, hub: HUB20, amountIn: "100000000", alloy: specs.BTC.alloy, pool: "1868", variant: pr.atom, token: pr.token }), /operations|dest denom|swap/);
  ok(!M.validateEthToAll(freshen(FIX("pairBTC-Y2-good.json")), { evm: EVM, osmo: OSMO20, amountIn: "100000000" }).ok, "a WBTC Axelar wrap is refused by the USDC validator");
}

/* ----- review findings: calldata is decoded argument by argument, never searched ----- */
{
  const setWord = (res, i, hex64) => mut(res, r => { const d = r.txs[0].evm_tx.data.replace(/^0x/i, ""); r.txs[0].evm_tx.data = d.slice(0, 8 + i * 64) + hex64 + d.slice(8 + (i + 1) * 64); });
  const setSel = (res, sel) => mut(res, r => { r.txs[0].evm_tx.data = sel + r.txs[0].evm_tx.data.replace(/^0x/i, "").slice(8); });
  const W0 = "0".repeat(64);
  /* CCTP v2 (A2): amount, domain, recipient, token, fee, relayer words */
  refused("A2: foreign selector with the same arguments", M.validateHubToInj(setSel(a2, "deadbeef"), c2), /selector/);
  refused("A2: amount word altered", M.validateHubToInj(setWord(a2, 0, W0.slice(0, 63) + "1"), c2), /amount \(word 0\)/);
  refused("A2: destination domain altered", M.validateHubToInj(setWord(a2, 1, W0.slice(0, 63) + "0"), c2), /destination domain/);
  refused("A2: mint recipient word altered while the recipient bytes still appear elsewhere", M.validateHubToInj(mut(a2, r => { const d = r.txs[0].evm_tx.data.replace(/^0x/i, ""); r.txs[0].evm_tx.data = d.slice(0, 8 + 2 * 64) + W0.slice(0, 60) + "beef" + d.slice(8 + 3 * 64) + M.pad32(EVM); }), c2), /mint recipient/);
  refused("A2: burn token altered", M.validateHubToInj(setWord(a2, 3, M.pad32("0xdac17f958d2ee523a2206206994597c13d831ec7")), c2), /burn token/);
  refused("A2: fee relayer altered", M.validateHubToInj(setWord(a2, 7, M.pad32("0x000000000000000000000000000000000000beef")), c2), /fee relayer/);
  refused("A2: hook data appended", M.validateHubToInj(mut(a2, r => { r.txs[0].evm_tx.data += W0; }), c2), /expected 10/);
  refused("A2: approvals field missing", M.validateHubToInj(mut(a2, r => { delete r.txs[0].evm_tx.required_erc20_approvals; }), c2), /approvals/);
  /* CCTP v1 (B3) */
  refused("B3: v2 selector on the v1 adapter", M.validateHubToNoble(setSel(b3, "d1cc447d"), cb3), /selector/);
  refused("B3: fee recipient altered", M.validateHubToNoble(setWord(b3, 5, M.pad32("0x000000000000000000000000000000000000beef")), cb3), /fee recipient/);
  refused("B3: recipient word altered", M.validateHubToNoble(setWord(b3, 2, M.pad32("0x000000000000000000000000000000000000beef")), cb3), /mint recipient/);
  /* Axelar receiver (E2): dynamic fields are read from their offsets */
  refused("E2: destination chain string altered", M.validateEthToAll(mut(e2, r => { r.txs[0].evm_tx.data = r.txs[0].evm_tx.data.replace(Buffer.from("osmosis").toString("hex") + "0".repeat(50), Buffer.from("noblesi").toString("hex") + "0".repeat(50)); }), ce2), /destination chain/);
  refused("E2: amount word altered", M.validateEthToAll(setWord(e2, 4, W0.slice(0, 63) + "1"), ce2), /amount \(word 4\)/);
  refused("E2: gas fee word not equal to native value", M.validateEthToAll(setWord(e2, 5, W0.slice(0, 63) + "1"), ce2), /gas fee/);
  refused("E2: Axelar symbol altered (USDT for USDC)", M.validateEthToAll(mut(e2, r => { r.txs[0].evm_tx.data = r.txs[0].evm_tx.data.replace(Buffer.from("USDC").toString("hex") + "0".repeat(56), Buffer.from("USDT").toString("hex") + "0".repeat(56)); }), ce2), /Axelar symbol/);
  refused("E2: payload envelope altered", M.validateEthToAll(mut(e2, r => { r.txs[0].evm_tx.data = r.txs[0].evm_tx.data.replace("00000002" + Buffer.from('{"swap_and_action_with_recover"').toString("hex"), "00000001" + Buffer.from('{"swap_and_action_with_recover"').toString("hex")); }), ce2), /envelope/);
  refused("E2: recovery_addr removed", M.validateEthToAll(mut(e2, r => { r.txs[0].evm_tx.data = r.txs[0].evm_tx.data.replace(Buffer.from('"recovery_addr"').toString("hex"), Buffer.from('"recovery_xddr"').toString("hex")); }), ce2), /recovery_addr/);
  { const pr = M.K.ETH_PAIRS.allBTC, y2 = freshen(FIX("pairBTC-Y2-good.json")), cy2 = { evm: EVM, osmo: OSMO20, amountIn: "100000000", alloy: "factory/osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3/alloyed/allBTC", pool: "1868", variant: pr.axl, token: pr.token, sym: "WBTC" };
    refused("Y2 BTC: symbol pinned to the spec (WETH offered for WBTC)", M.validateEthToAlloyAxelar(y2, { ...cy2, sym: "WETH" }), /Axelar symbol/);
    refused("Y2 BTC: no symbol supplied is itself refused", M.validateEthToAlloyAxelar(y2, { ...cy2, sym: undefined }), /symbol/); }
  /* Eureka (X2) */
  { const pr = M.K.ETH_PAIRS.allBTC, x2 = freshen(FIX("pairBTC-X2-good.json")), cx2 = { evm: EVM, osmo: OSMO20, hub: HUB20, amountIn: "100000000", alloy: "factory/osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3/alloyed/allBTC", pool: "1868", variant: pr.atom, token: pr.token };
    refused("X2: Axelar selector on the Eureka contract", M.validateEthToAlloyEureka(setSel(x2, "d421c105"), cx2), /selector/);
    refused("X2: token word altered", M.validateEthToAlloyEureka(setWord(x2, 5, M.pad32("0xdac17f958d2ee523a2206206994597c13d831ec7")), cx2), /token/);
    refused("X2: fee recipient altered", M.validateEthToAlloyEureka(setWord(x2, 3, M.pad32("0x000000000000000000000000000000000000beef")), cx2), /fee recipient/);
    const r2 = M.abiWords(x2.txs[0].evm_tx.data); ok(r2.sel === M.K.EUREKA_SELECTOR && r2.w.length === 59, "abiWords splits selector and words");
    ok(M.abiDyn(r2.body, 1000000) === null && M.abiDyn("00", 0) === null, "abiDyn refuses offsets outside the data"); }
}
/* ----- review findings: Chainflip fill-or-kill is mandatory and compared ----- */
{
  const st = FIX("chainflip-status-good.json"), ch = FIX("chainflip-channel-good.json"), q = FIX("chainflip-quote-wbtc-btc.json").find(x => x.type === "REGULAR");
  const x128 = M.chainflipMinPriceX128(q.estimatedPrice, q.recommendedSlippageTolerancePercent, 8, 8);
  const exp = { srcChain: "Ethereum", srcAsset: "WBTC", destChain: "Bitcoin", destAsset: "BTC", destAddress: st.destAddress, amount: "10000000", depositAddress: ch.depositAddress, id: ch.id, refundAddress: "0x000000000000000000000000000000000000dead", retryDurationBlocks: 150, minPriceX128: x128 };
  { const e = []; M.checkChainflipChannel(e, st, exp); ok(!e.length, "channel with matching fill-or-kill accepted" + (e.length ? " -> " + e.join(" | ") : "")); }
  const bad = (f, re, label) => { const e = []; const s2 = JSON.parse(JSON.stringify(st)); const x = { ...exp }; f(s2, x); M.checkChainflipChannel(e, s2, x); ok(e.some(m => re.test(m)), label + (e.length ? "" : " (ACCEPTED)")); };
  bad(s2 => { delete s2.fillOrKillParams; }, /no fill-or-kill/, "missing fill-or-kill refused");
  bad(s2 => { s2.fillOrKillParams.retryDurationBlocks = 10; }, /retry window/, "retry window mismatch refused");
  bad(s2 => { s2.fillOrKillParams.minPrice = "0.5"; }, /minimum price/, "weaker minimum price refused");
  bad(s2 => { delete s2.fillOrKillParams.minPrice; }, /no minimum price/, "absent minimum price refused");
  bad(s2 => { delete s2.depositChannel.openedThroughBackend; }, /provenance/, "unknown provenance refused");
}
/* ----- allowance sequencing (USDT refuses nonzero -> nonzero) ----- */
ok(JSON.stringify(M.approvalPlan("0", "100")) === '["100"]', "no allowance: one approve");
ok(JSON.stringify(M.approvalPlan("40", "100")) === '["0","100"]', "partial stale allowance: reset to zero, then approve");
ok(JSON.stringify(M.approvalPlan("100", "100")) === "[]" && JSON.stringify(M.approvalPlan("500", "100")) === "[]", "sufficient allowance: nothing to send");
ok(!/eth\("eth_sendTransaction"/.test(fn("sendSkipEvm")) && /evmSend\(/.test(fn("sendSkipEvm")) && (HTML.match(/eth\("eth_sendTransaction"/g) || []).length === 1, "every send goes through evmSend, which rechecks chain and account first");
/* ----- review findings: limiter labels are escaped, cycles are bound to addresses ----- */
ok(M.describeLimiter([["d", "<img src=x onerror=alert(1)>"], { static_limiter: { upper_limit: "0.5" } }]) === "static ≤ 50.0% (&lt;img src=x onerror=alert(1)&gt;)", "contract-controlled limiter label is escaped");
{
  const rec = { osmo: OSMO20, inj: INJ, noble: NOBLE20, hub: HUB20, evm: EVM, btc: "bc1qtest" };
  ok(M.addrsMismatch(rec, { ...rec }, true) === null, "same addresses continue");
  ok(/osmo address changed/.test(M.addrsMismatch(rec, { ...rec, osmo: OSMO32 }, false)), "changed Osmosis account refused");
  ok(/evm address changed/.test(M.addrsMismatch(rec, { ...rec, evm: "0x000000000000000000000000000000000000beef" }, false)), "changed EVM account refused");
  ok(M.addrsMismatch(rec, { ...rec, btc: "bc1qother" }, false) === null && /Bitcoin address changed/.test(M.addrsMismatch(rec, { ...rec, btc: "bc1qother" }, true)), "Bitcoin address only matters for BTC plans");
  ok(/predates/.test(M.addrsMismatch(undefined, rec, false)), "a cycle without recorded addresses cannot continue");
}

/* ----- gas purchases ----- */
const gc = t => ({ osmo: OSMO32, target: t, recipient: { osmo: OSMO32, avax: EVM, eth: EVM, inj: INJ, noble: NOBLE20 }[t], recipientHex: EVM });
for (const t of ["osmo", "avax", "inj", "noble"]) { const v = M.validateGas(freshen(FIX(`gas-${t}-good.json`)), gc(t)); ok(v.ok, `gas ${t} good route accepted` + show(v)); }
{ const v = M.validateGas(freshen(FIX("gas-eth-good.json")), { ...gc("eth"), osmo: OSMO20 }); ok(v.ok, "gas eth (5 allUSDC via Axelar) accepted" + show(v)); }
refused("gas: fixed purchase amount", M.validateGas(mut(freshen(FIX("gas-osmo-good.json")), r => { r.route.amount_in = "2000000"; setMsg(r, j => { j.funds[0].amount = "2000000"; }); }), gc("osmo")), /amount_in|funds/);
refused("gas: poor quote", M.validateGas(mut(freshen(FIX("gas-osmo-good.json")), r => { r.route.usd_amount_out = "0.5"; }), gc("osmo")), /only \$0.500/);
refused("gas eth: poor quote", M.validateGas(mut(freshen(FIX("gas-eth-good.json")), r => { r.route.usd_amount_out = "2.0"; }), { ...gc("eth"), osmo: OSMO20 }), /only \$2.000/);
refused("gas osmo: recipient is not me", M.validateGas(freshen(FIX("gas-osmo-good.json")), { ...gc("osmo"), recipient: "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3" }), /recipient/);
refused("gas inj: recipient is not me", M.validateGas(freshen(FIX("gas-inj-good.json")), { ...gc("inj"), recipient: "inj1mjp7a2c4h3wt9v5c6m7gvr5ssaq9utd3l938cd" }), /Injective address/);
refused("gas noble: recipient is not me", M.validateGas(freshen(FIX("gas-noble-good.json")), { ...gc("noble"), recipient: "noble15xt7kx5mles58vkkfxvf0lq78sw04jajvfgd4d" }), /Noble address/);
refused("gas avax: payload is not my address", M.validateGas(freshen(FIX("gas-avax-good.json")), { ...gc("avax"), recipientHex: "0x000000000000000000000000000000000000beef" }), /payload/);
refused("gas eth: payload is not my address", M.validateGas(freshen(FIX("gas-eth-good.json")), { ...gc("eth"), osmo: OSMO20, recipientHex: "0x000000000000000000000000000000000000beef" }), /payload/);
refused("gas: affiliate skim", M.validateGas(mut(freshen(FIX("gas-osmo-good.json")), r => setMsg(r, j => { j.msg.swap_and_action.affiliates = [{ address: "osmo1x", basis_points_fee: "10" }]; })), gc("osmo")), /affiliates/);
refused("gas: wrong contract", M.validateGas(mut(freshen(FIX("gas-osmo-good.json")), r => setMsg(r, j => { j.contract = "osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3"; })), gc("osmo")), /entry point/);
ok(!M.validateGas(a1, gc("avax")).ok, "gas validator refuses a 10k rebalance route");
ok(!M.validateNobleToHub(freshen(FIX("gas-noble-good.json")), { ...c1, osmo: OSMO32 }).ok, "exit validator refuses a gas route");
ok(!M.validateGas(a1, gc("avax")).ok && !M.validateGas(freshen(FIX("stageA1-bad-allbtc-detour.json")), gc("avax")).ok, "gas validator refuses exit routes");

/* ---------- temporal-dead-zone guard for the long async handlers ---------- */
for (const name of ["signAndBroadcast", "runCycle", "fundGas", "sendSkipEvm", "connectKeplr", "renderSteps", "renderStranded", "refreshPool", "syncStart", "updateEstimate"]) {
  const body = fn(name).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/`[^`]*`|"[^"]*"|'[^']*'/g, '""');
  const decls = [...body.matchAll(/\b(?:const|let)\s+(?:\{([^}]*)\}|\[([^\]]*)\]|(\w+))/g)].flatMap(m => m[1] || m[2] ? (m[1] || m[2]).split(",").map(s => s.trim().split(":").pop().trim()).filter(Boolean) : [m[3]]);
  for (const d of decls) {
    const declAt = body.search(new RegExp(`\\b(?:const|let)\\s+(?:[\\{\\[][^}\\]]*\\b${d}\\b[^}\\]]*[\\}\\]]|${d}\\b)`));
    const useAt = body.search(new RegExp(`(?<![.\\/])\\b${d}\\b`));
    ok(useAt >= declAt, `${name}: '${d}' used before declaration`);
  }
}

fs.unlinkSync(tmp);


/* ---------- EIP-712 typed data (Injective Ledger signing) ---------- */
{
  const xferValue = { source_port: "transfer", source_channel: "channel-8", token: { denom: "peggy0xd", amount: "10000000" },
    sender: "inj1x", receiver: "osmo1y", timeout_height: { revision_number: "1", revision_height: "100" }, timeout_timestamp: "123", memo: "hi" };
  const t1 = M.eip712MsgTypes(xferValue);
  ok(M.sortedJson(t1.MsgValue) === M.sortedJson([
    { name: "source_port", type: "string" }, { name: "source_channel", type: "string" }, { name: "token", type: "TypeToken" },
    { name: "sender", type: "string" }, { name: "receiver", type: "string" }, { name: "timeout_height", type: "TypeTimeoutHeight" },
    { name: "timeout_timestamp", type: "uint64" }, { name: "memo", type: "string" }]), "MsgTransfer MsgValue types in proto field order");
  ok(M.sortedJson(t1.TypeToken) === M.sortedJson([{ name: "denom", type: "string" }, { name: "amount", type: "string" }]), "TypeToken");
  ok(M.sortedJson(t1.TypeTimeoutHeight) === M.sortedJson([{ name: "revision_number", type: "uint64" }, { name: "revision_height", type: "uint64" }]), "TypeTimeoutHeight uses uint64 (chain reflection walk)");
  const noMemo = M.eip712MsgTypes({ ...xferValue, memo: "" });
  ok(!noMemo.MsgValue.some(f => f.name === "memo"), "empty memo omitted from types, matching the chain's walk");

  const se = M.eip712MsgTypes({ sender: "inj1x", eth_dest: "0xdead", amount: { denom: "peggy0xd", amount: "5" }, bridge_fee: { denom: "peggy0xd", amount: "5" } });
  ok(M.sortedJson(se.MsgValue.map(f => f.type)) === M.sortedJson(["string", "string", "TypeAmount", "TypeBridgeFee"]) && !!se.TypeBridgeFee, "MsgSendToEth types: TypeAmount / TypeBridgeFee");
  ok(M.eip712TypeName("bridge_fee", "MsgValue") === "TypeBridgeFee" && M.eip712TypeName("foo_bar", "TypeToken") === "TypeTokenFooBar", "type names match the chain's sanitizeTypedef");

  const all = M.eip712Types(xferValue);
  ok(M.sortedJson(all.Tx.map(f => f.name)) === M.sortedJson(["account_number", "chain_id", "fee", "memo", "msgs", "sequence", "timeout_height"]), "root Tx type matches the chain's fixed root types");
  ok(all.EIP712Domain.length === 5 && M.EIP712_DOMAIN.verifyingContract === "cosmos" && M.EIP712_DOMAIN.chainId === "0x1" && M.EIP712_DOMAIN.name === "Injective Web3", "domain pinned to Injective Web3 / chainId 0x1 / cosmos");

  ok(hex(M.TxBody([Uint8Array.of(1, 2, 3)], "", "5", [Uint8Array.of(9)])) === "0a030102031805fa3f0109", "TxBody encodes timeout_height (field 3) and extension_options (field 1023)");
  ok(hex(M.TxBody([Uint8Array.of(1)], "")) === "0a0101", "TxBody without timeout or extensions is unchanged");
}
{
  const sab = fn("signAndBroadcast");
  ok((HTML.match(/experimentalSignEIP712CosmosTx_v0/g) || []).length === 1 && /ledger712/.test(sab), "one EIP-712 call site, behind the Injective Ledger branch");
  ok(/sig\.length !== 65/.test(sab) && /ExtensionOptionsWeb3Tx/.test(sab) && /SignerInfo\(pkAny, 127,/.test(sab), "65-byte signature, web3 extension, sign mode 127");
  ok(/timeout_height\?\.revision_number/.test(sab), "IBC transfers without a full timeout height are refused on the EIP-712 path");
  ok(/s\.signed\.timeout_height !== txTimeout/.test(sab), "a wallet-altered timeout is refused before broadcast");
  ok(/osmoTimeoutHeight\(900\)/.test(HTML) && (HTML.match(/osmoTimeoutHeight\(/g) || []).length >= 3, "Ledger IBC transfers from Injective get a nonzero timeout height (P4 and A3)");
}


/* ---------- EIP-712 against Injective's canonical generator ----------
   test-fixtures/eip712-golden-*.json hold real responses from the web3gw PrepareEip712 endpoint,
   which runs the chain's own typed-data code. Our generator must agree exactly on types, domain
   and the amino message; the Tx-level scaffolding is checked field by field (the gw renders
   timeout_height as a JSON number and computes its own fee, so those are normalised). */
{
  const build = {
    "eip712-golden-transfer": v => M.MsgTransfer({ sourcePort: v.source_port, sourceChannel: v.source_channel, token: v.token,
      sender: v.sender, receiver: v.receiver, timeoutHeight: { revisionNumber: v.timeout_height.revision_number, revisionHeight: v.timeout_height.revision_height },
      timeoutTimestamp: v.timeout_timestamp, memo: v.memo || "" }).amino,
    "eip712-golden-transfer-memo": v => M.MsgTransfer({ sourcePort: v.source_port, sourceChannel: v.source_channel, token: v.token,
      sender: v.sender, receiver: v.receiver, timeoutHeight: { revisionNumber: v.timeout_height.revision_number, revisionHeight: v.timeout_height.revision_height },
      timeoutTimestamp: v.timeout_timestamp, memo: v.memo || "" }).amino,
    "eip712-golden-sendtoeth": v => M.MsgSendToEth({ sender: v.sender, ethDest: v.eth_dest, amount: v.amount, bridgeFee: v.bridge_fee }).amino,
  };
  for (const fx of Object.keys(build)) {
    const g = FIX(fx + ".json"), resp = g.response;
    const { ["@type"]: _t, ...reqValue } = g.request.msgs[0];
    const amino = build[fx](reqValue);
    ok(M.sortedJson(M.eip712Types(amino.value)) === M.sortedJson(resp.types), `${fx}: generated types match the chain's generator`);
    ok(M.sortedJson(M.EIP712_DOMAIN) === M.sortedJson(resp.domain) && resp.primaryType === "Tx", `${fx}: domain and primary type match`);
    ok(M.sortedJson(amino) === M.sortedJson(resp.message.msgs[0]), `${fx}: amino form matches the canonical message`);
    ok(resp.message.chain_id === "injective-1" && resp.message.memo === "" && String(resp.message.timeout_height) === g.request.timeout_height
       && resp.message.account_number === g.request.account_number && resp.message.sequence === g.request.sequence, `${fx}: sign-doc scaffolding fields`);
  }
}

/* ---------- amino forms (Ledger signing) ---------- */
{
  const xp = { sourcePort: "transfer", sourceChannel: "channel-750",
    token: { denom: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4", amount: "25000000" },
    sender: "osmo19w2t4ue7qpdh6022m3yxmxvv3w7jla7u3hfq0r", receiver: "noble15xt7kx5mles58vkkfxvf0lq7",
    timeoutHeight: {}, timeoutTimestamp: "1756400000000000000", memo: '{"orbiter":{}}' };
  const xa = M.MsgTransfer(xp).amino;
  ok(M.sortedJson(xa) === M.sortedJson({ type: "cosmos-sdk/MsgTransfer", value: {
    source_port: "transfer", source_channel: "channel-750",
    token: { denom: xp.token.denom, amount: "25000000" }, sender: xp.sender, receiver: xp.receiver,
    timeout_height: {}, timeout_timestamp: "1756400000000000000", memo: '{"orbiter":{}}' } }), "MsgTransfer amino: zero height empty object, ts and memo present");
  const x0 = M.MsgTransfer({ ...xp, timeoutTimestamp: "0", memo: "", timeoutHeight: { revisionNumber: "1", revisionHeight: "500" } }).amino;
  ok(!("timeout_timestamp" in x0.value) && !("memo" in x0.value), "MsgTransfer amino: zero timestamp and empty memo omitted");
  ok(M.sortedJson(x0.value.timeout_height) === M.sortedJson({ revision_number: "1", revision_height: "500" }), "MsgTransfer amino: nonzero height as strings");

  const sw = M.MsgSwapExactAmountIn({ sender: "osmo1a", routes: [{ poolId: "3497", tokenOutDenom: "ibc/498A" }], tokenIn: { denom: "factory/x/allUSDC", amount: 25000000n }, tokenOutMinAmount: 25000000n }).amino;
  ok(M.sortedJson(sw) === M.sortedJson({ type: "osmosis/poolmanager/swap-exact-amount-in", value: {
    sender: "osmo1a", routes: [{ pool_id: "3497", token_out_denom: "ibc/498A" }],
    token_in: { denom: "factory/x/allUSDC", amount: "25000000" }, token_out_min_amount: "25000000" } }), "MsgSwapExactAmountIn amino: pool_id and amounts as strings");

  const ex = M.MsgExecuteContract({ sender: "osmo1a", contract: "osmo1b", msg: te.encode('{"swap_and_action":{"x":1}}'), funds: [{ denom: "uosmo", amount: 5n }] }).amino;
  ok(M.sortedJson(ex) === M.sortedJson({ type: "wasm/MsgExecuteContract", value: { sender: "osmo1a", contract: "osmo1b", msg: { swap_and_action: { x: 1 } }, funds: [{ denom: "uosmo", amount: "5" }] } }), "MsgExecuteContract amino: msg embedded as JSON, funds amounts as strings");

  const se = M.MsgSendToEth({ sender: "inj1a", ethDest: "0xdead", amount: { denom: "peggy0xd", amount: "5000000" }, bridgeFee: { denom: "peggy0xd", amount: "5000000" } }).amino;
  ok(se.type === "peggy/MsgSendToEth" && se.value.eth_dest === "0xdead" && se.value.bridge_fee.amount === "5000000", "MsgSendToEth amino");

  const anyv = M.Any("/ibc.applications.transfer.v1.MsgTransfer", M.MsgTransfer(xp));
  ok(anyv.amino && anyv.amino.type === "cosmos-sdk/MsgTransfer", "Any propagates the amino form");
  const sk = M.skipMsgToAny({ msg_type_url: "/cosmwasm.wasm.v1.MsgExecuteContract", msg: { sender: "osmo1a", contract: "osmo1b", msg: { q: 1 }, funds: [{ denom: "uosmo", amount: "1" }] } });
  ok(sk.amino && sk.amino.type === "wasm/MsgExecuteContract" && sk.amino.value.msg.q === 1, "skipMsgToAny output carries amino");

  ok(M.sortedJson({ b: 1, a: { d: 2, c: 3 } }) === M.sortedJson({ a: { c: 3, d: 2 }, b: 1 }), "sortedJson is key-order insensitive");
  ok(M.sortedJson([1, 2]) !== M.sortedJson([2, 1]), "sortedJson keeps array order significant");
}
{
  const sab = fn("signAndBroadcast");
  ok(/isNanoLedger/.test(sab) && /signAmino\(/.test(sab) && /SignerInfo\(pkAny, 127,/.test(sab), "signAndBroadcast has the Ledger amino branch with mode 127");
  ok(/injective-1/.test(sab.split("isNanoLedger")[1].split("} else {")[0]), "the Ledger branch refuses Injective (EIP-712 only)");
  ok(/sortedJson\(s\.signed\.msgs\) !== sortedJson\(aminoMsgs\)/.test(sab), "a wallet-altered amino doc is refused before broadcast");
  ok((HTML.match(/window\.keplr\.signDirect\(/g) || []).length === 1 && (HTML.match(/window\.keplr\.signAmino\(/g) || []).length === 1, "exactly one signDirect and one signAmino call site");
  const ck = fn("connectKeplr");
  ok(/routes that sign on Injective stay disabled/.test(ck) && /ki\.isNanoLedger/.test(ck), "connect survives a missing or Ledger-only Injective key");
  ok(/planNeedsInj\(pk\) && !W\.inj/.test(fn("syncStart")), "syncStart gates Injective-signing plans when no Injective account");
  /* not via fn(): skipRoute's `extra = {}` default parameter defeats the brace matcher */
  ok(HTML.includes("chain_ids_to_addresses: Object.fromEntries(Object.entries(addrs).filter(([, v]) => v))"), "skipRoute drops empty addresses before calling Skip");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
process.exit(fail ? 1 : 0);
