/* Loads the parts of ../index.html the bot needs: pinned constants, protobuf encoders, route validators, and the
 * read-only network helpers (REST/RPC/Skip). Nothing here signs; the page signs through Keplr, the bot through
 * ./sign.mjs. A change to a pinned address or a validator in the page therefore changes the bot too.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractor } from "./extract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, "..", "index.html"), "utf8");
const { extractFrom, fn, arrow } = extractor(HTML);

const FNS = [
  /* protobuf + tx envelope */
  "uint64Value", "varint", "cat", "tag", "bytesF", "strF", "u64F", "Height", "MsgTransfer", "MsgExecuteContract", "SwapAmountInRoute", "MsgSwapExactAmountIn",
  "TxBody", "Fee", "SignerInfo", "AuthInfo", "TxRaw", "txHashOf", "skipMsgToAny",
  /* units and loss bounds */
  "parseAmount", "fmtUnits", "fmt2", "withinLoss",
  /* bech32 */
  "b32Polymod", "b32HrpExpand", "bech32Decode", "bech32Encode", "convertBits", "bech32Rehrp", "bech32ToHex",
  /* validators */
  "swapOps", "checkCommon", "checkSwap", "checkSwapAndAction", "parseJsonField", "transferOp", "abiWords", "abiDyn", "checkEvmTx", "approvalPlan",
  "checkHookTransfer", "singleCosmosMsg", "checkAxelarMemo", "checkOrbiterMemo", "validateNobleToHub", "validateHubToInj", "validateInjToAll", "validateGas",
  /* network reads */
  "jget", "proveEndpoints", "lcdGet", "lcdPost", "bankBalance", "getAccount", "smartQuery", "assertChannel", "rpc", "erc20BalanceOf", "erc20Allowance",
  "evmNative", "waitReceipt", "skipPost", "skipRoute", "skipTrack", "skipStatus", "waitSkip", "trackToCompletion", "gasPriceOf", "pubkeyTypeUrl", "txState", "waitArrival",
];
const ARROWS = ["U64_MAX", "B32", "Any", "sortedJson", "Coin", "pad32", "sameAddr", "hexToBytes", "opKind", "nearly", "bridgeFee", "abiStr", "wordEq",
  "approveCalldata", "refused", "PROVEN", "SKIP_OPTS", "TERMINAL"];

const src = [
  "const te = new TextEncoder();",
  /* the page's log() writes to its DOM; the bot swaps in its own logger */
  "let log = (...a) => console.log(...a);",
  "export const setLog = f => { log = f; };",
  "const sleep = ms => new Promise(r => setTimeout(r, ms));",
  "const b64 = u => Buffer.from(u).toString('base64');",
  "const unb64 = s => Uint8Array.from(Buffer.from(s, 'base64'));",
  extractFrom(/const K = /, "K"), extractFrom(/const GAS = /, "GAS"), extractFrom(/const CHAIN = /, "CHAIN"),
  ...ARROWS.map(arrow),
  ...FNS.map(fn),
  `export {K,GAS,CHAIN,${[...ARROWS, ...FNS].join(",")},b64,unb64,sleep};`,
].join("\n");

/* imported from memory (the extracted code has no imports of its own), so the bot needs no writable code directory */
export const P = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
