/* Chain reads the bot decides on (pool composition, freeze state, IBC rate-limit headroom, gas balances) and the gas
 * refill, which reuses the page's Fund Gas route and validator. Every read throws on failure; nothing defaults to zero.
 */
import { P } from "./page.mjs";
import { signAndBroadcast } from "./sign.mjs";

const { K, GAS, smartQuery, lcdGet, bankBalance, evmNative, erc20BalanceOf, skipRoute, validateGas, skipMsgToAny, trackToCompletion, bech32Rehrp, fmtUnits, sleep } = P;
const ALL_CONTRACT = K.ALLOYS.find(a => a.sym === "allUSDC").contract;

export async function readPool() {
  const [liq, active, corrupted, lims] = await Promise.all([
    smartQuery(ALL_CONTRACT, { get_total_pool_liquidity: {} }),
    smartQuery(ALL_CONTRACT, { is_active: {} }),
    smartQuery(ALL_CONTRACT, { get_corrupted_denoms: {} }),
    smartQuery(ALL_CONTRACT, { list_limiters: {} }),
  ]);
  const held = Object.fromEntries((liq.total_pool_liquidity || []).map(c => [c.denom, BigInt(c.amount)]));
  if (held[K.NOBLE] === undefined || held[K.INJ_IBC] === undefined) throw new Error("pool 3497 liquidity is missing USDC.noble or USDC.inj");
  const total = Object.values(held).reduce((a, b) => a + b, 0n);   // allUSDC variants all have normalization factor 1
  if (typeof active?.is_active !== "boolean") throw new Error("is_active returned no boolean");
  return { held, total, inj: held[K.INJ_IBC], noble: held[K.NOBLE], active: active.is_active,
           corrupted: corrupted?.corrupted_denoms || [], limiters: lims?.limiters || [] };
}

/* the smallest amount of USDC.inj that lifts the share to target_pct (moving x from noble to inj keeps the total fixed) */
export function deficit(pool, targetPct) {
  const bps = BigInt(Math.round(targetPct * 100));
  const want = (pool.total * bps + 9999n) / 10000n;
  return want > pool.inj ? want - pool.inj : 0n;
}
export const sharePct = pool => pool.total ? Number(pool.inj * 1000000n / pool.total) / 10000 : 0;

/* ---------------- IBC rate limits (x/ibc-rate-limit contract v0.1.1) ----------------
   Each quota caps the NET flow in its window: inflow - outflow must stay <= channel_value * max_percentage_recv / 100
   (outflow - inflow for sends). A window whose period_end has passed restarts from zero on the next transfer. */
let RL = null;
async function rateLimiter() {
  if (!RL) RL = (await lcdGet("osmosis-1", "/osmosis/ibc-rate-limit/v1beta1/params")).params?.contract_address;
  if (!RL) throw new Error("no IBC rate limiter contract in the chain params");
  return RL;
}
async function quotasFor(channel, denom) {
  try { return (await smartQuery(await rateLimiter(), { get_quotas: { channel_id: channel, denom } })) || []; }
  catch (e) { if (/not found/i.test(e.message)) return []; throw e; }
}
export function quotaRoom(q, direction, nowNs) {
  const pct = BigInt(direction === "in" ? q.quota.max_percentage_recv : q.quota.max_percentage_send);
  const cap = BigInt(q.quota.channel_value || 0) * pct / 100n;
  if (BigInt(q.flow.period_end) < nowNs) return { room: cap, resetsAt: null };
  const inflow = BigInt(q.flow.inflow), outflow = BigInt(q.flow.outflow);
  const used = direction === "in" ? (inflow > outflow ? inflow - outflow : 0n) : (outflow > inflow ? outflow - inflow : 0n);
  return { room: cap > used ? cap - used : 0n, resetsAt: Number(BigInt(q.flow.period_end) / 1000000n) };
}
/* smallest headroom over every quota on (any, denom) and (channel, denom); room null when the denom has no quota */
export async function headroom(denom, direction, channel) {
  const qs = [...await quotasFor("any", denom), ...await quotasFor(channel, denom)];
  const nowNs = BigInt(Date.now()) * 1000000n;
  let best = { room: null, resetsAt: null, quota: null };
  for (const q of qs) {
    const r = quotaRoom(q, direction, nowNs);
    if (best.room === null || r.room < best.room) best = { ...r, quota: q.quota.name };
  }
  return best;
}

/* ---------------- balances ---------------- */
export async function balances(W) {
  const [all, noble, avaxUsdc, avax, inj, injUsdc] = await Promise.all([
    bankBalance("osmosis-1", W.osmo, K.ALL), bankBalance("osmosis-1", W.osmo, K.NOBLE),
    erc20BalanceOf("43114", K.HUB["43114"].usdc, W.evm), evmNative("43114", W.evm),
    bankBalance("injective-1", W.inj, "inj"), bankBalance("injective-1", W.inj, K.INJ_ERC20),
  ]);
  return { all, noble, avaxUsdc, avax, inj, injUsdc };
}

/* ---------------- gas refill: the page's Fund Gas route (allUSDC -> native gas, delivered to the bot's own address) ----------------
   The page buys a fixed 1 allUSDC with a flat $0.85 floor. Axelar's fee toward Avalanche is flat (~$0.11), so the bot
   sizes refills from config and scales the floor with the amount; the page's validator runs on that sized entry.
   A quote that fails only on value is a wait (quotes move), anything else about the route halts. */
export function gasSpec(target, cfg) {
  const base = GAS[target], usdc = Number(cfg.gas_refill_usdc?.[target] ?? 1);
  if (!(usdc > 0 && usdc <= 10)) throw new Error(`gas_refill_usdc.${target} must be in (0, 10]`);
  return { ...base, amount: String(Math.round(usdc * 1e6)), minUsd: usdc * cfg.gas_min_value_pct / 100 };
}
function validateGasSized(res, ctx, G) {
  const page = GAS[ctx.target];
  GAS[ctx.target] = G;   // validateGas reads GAS[target] for the amount and floor; restored before anything awaits
  try { return validateGas(res, ctx); } finally { GAS[ctx.target] = page; }
}
export async function refillGas(target, ctx, note, onSigned = async () => {}) {
  const G = gasSpec(target, ctx.cfg), W = ctx.W;
  const recipient = { avax: W.evm, inj: W.inj }[target];
  const read = { avax: () => evmNative("43114", W.evm), inj: () => bankBalance("injective-1", W.inj, "inj") }[target];
  const addrs = { "osmosis-1": W.osmo, "injective-1": W.inj, "axelar-dojo-1": bech32Rehrp(W.osmo, "axelar"), "43114": W.evm };
  const res = await skipRoute(K.ALL, "osmosis-1", G.dst[0], G.dst[1], G.amount, addrs, { slippage_tolerance_percent: "1" });
  const v = validateGasSized(res, { osmo: W.osmo, target, recipient, recipientHex: W.evm }, G);
  if (!v.ok) {
    const valueOnly = v.errs.every(e => /^quote returns only/.test(e));
    throw Object.assign(new Error(`gas route for ${G.sym} ${valueOnly ? "is below the value floor" : "refused"}: ${v.errs.join("; ")}`),
      valueOnly ? { wait: true, until: Date.now() + 30 * 60000 } : { halt: true });
  }
  const before = await read();
  note(`buying ${G.sym} gas with ${fmtUnits(G.amount)} allUSDC, about $${v.usd.toFixed(2)} delivered to ${recipient}`);
  const { hash, fee } = await signAndBroadcast("osmosis-1", ctx.wallet, res.txs[0].cosmos_tx.msgs.map(skipMsgToAny), note, onSigned, ctx.signOpts);
  if (ctx.signOpts.dryRun) return { spent: 0n };
  await trackToCompletion("osmosis-1", hash, s => note("Skip: " + s));
  let after = before; for (let i = 0; i < 60 && after <= before; i++) { await sleep(5000); after = await read(); }
  if (after <= before) throw new Error(`${G.sym} balance has not risen after the refill ${hash}`);
  note(`received ${fmtUnits(after - before, G.dec)} ${G.sym}`);
  return { spent: BigInt(G.amount) + BigInt(fee) };
}
