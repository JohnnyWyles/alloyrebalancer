#!/usr/bin/env node
/* Alloy Rebalancer bot: keeps USDC.inj at or above a target share of the allUSDC alloy (pool 3497) by running the
 * noble -> inj loop (A1 Osmosis, A2 Avalanche, A3 Injective) with its own wallet.
 *
 *   node bot.mjs run        the service loop (checks every 60 s; a loop starts only when it is needed and allowed)
 *   node bot.mjs once       one decision tick, then exit
 *   node bot.mjs status     pool share, deficit, balances, rate-limit room, journal; signs nothing
 *   node bot.mjs addresses  the wallet's osmo1 / inj1 / 0x addresses
 *   node bot.mjs keygen F   write a new mnemonic to file F (mode 600, never overwrites)
 *   add --dry-run to build, validate and simulate everything but broadcast nothing
 *
 * Environment:
 *   ALLOYBOT_MNEMONIC_FILE  path to the mnemonic (default: $CREDENTIALS_DIRECTORY/mnemonic, i.e. systemd LoadCredential)
 *   ALLOYBOT_STATE_DIR      directory for config.json, state.json, HALTED and STOP (default /var/lib/alloybot)
 */
import fs from "node:fs";
import path from "node:path";
import { P } from "./page.mjs";
import { deriveWallet } from "./sign.mjs";
import { STAGES, ORDER, halt, tightenMinAsset } from "./stages.mjs";
import { makeRunner, fitsFeeCap, loopLossBound } from "./cycle.mjs";
import { readPool, deficit, sharePct, headroom, balances, refillGas } from "./chain.mjs";

const { K, fmtUnits, setLog, PROVEN, sleep } = P;
const argv = process.argv.slice(2), cmd = argv.find(a => !a.startsWith("--")) || "status", DRY = argv.includes("--dry-run");
const DIR = process.env.ALLOYBOT_STATE_DIR || "/var/lib/alloybot";
const F = { config: path.join(DIR, "config.json"), state: path.join(DIR, "state.json"), halted: path.join(DIR, "HALTED"), stop: path.join(DIR, "STOP"), init: path.join(DIR, "JOURNAL_INITIALIZED") };
const TICK_MS = 60000;
const REFILL_FEE_BOUND = 50000n;   // 0.05 allUSDC: far above an Osmosis tx fee (0.0017 A1, 0.0045 refill observed), reserved before one is signed

/* ---------------- config (re-read every tick, so edits apply without a restart) ---------------- */
const DEFAULTS = {
  enabled: true,
  target_inj_pct: 50,
  loop_usdc: 100,            // allUSDC per loop
  min_loop_usdc: 10,         // below this (idle funds or remaining deficit) no loop starts
  reserve_usdc: 3,           // allUSDC kept back for Osmosis fees and gas refills
  max_loops_per_day: 100,
  max_loop_loss_bps: 10,     // allUSDC back vs out, per loop; more than this halts
  max_fee_usdc_per_day: 5,   // loop losses + gas refills + Osmosis fees, UTC day
  gas_floor: { avax: 0.02, inj: 0.001 },   // avax covers one loop's approval + burn at the 50 gwei cap (~0.0174)
  max_gas_refills_per_day: 4,
  gas_refill_usdc: { avax: 2, inj: 1 },   // allUSDC per refill; Axelar's flat fee makes small AVAX refills poor value
  gas_min_value_pct: 80,     // a refill quote must deliver at least this % of its allUSDC in gas
  avax_max_fee_gwei: 50,
  osmo_fee_margin: 2,       // Osmosis fee (in allUSDC) over the base fee at the fee pool's spot price
  rate_limit_margin_pct: 1,
  stranded_threshold_usdc: 1,
  telegram: null,            // { "token_file": "/etc/alloybot/telegram.token", "chat_id": "123" }
};
/* run/once require the file: a skipped provisioning step must not start live loops on the defaults above. status may
   run without it (it signs nothing) and reports what the defaults would be. */
function loadConfig(required) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(F.config, "utf8")); }
  catch (e) {
    if (e.code !== "ENOENT") throw new Error(`config.json: ${e.message}`);
    if (required) throw Object.assign(new Error(`${F.config} is missing; copy config.example.json there before running`), { noConfig: true });
  }
  const cfg = { ...DEFAULTS, ...c, gas_floor: { ...DEFAULTS.gas_floor, ...(c.gas_floor || {}) }, gas_refill_usdc: { ...DEFAULTS.gas_refill_usdc, ...(c.gas_refill_usdc || {}) } };
  if (!(cfg.gas_min_value_pct >= 50 && cfg.gas_min_value_pct <= 100)) throw new Error("gas_min_value_pct must be in [50, 100]");
  if (!(cfg.target_inj_pct > 0 && cfg.target_inj_pct <= 100)) throw new Error("target_inj_pct must be in (0, 100]");
  if (!(cfg.loop_usdc >= cfg.min_loop_usdc && cfg.min_loop_usdc > 0)) throw new Error("need loop_usdc >= min_loop_usdc > 0");
  return cfg;
}
const usdc = n => BigInt(Math.round(Number(n) * 1e6));

/* ---------------- state journal (atomic and durable) ----------------
   The journal is written before every broadcast, so it has to survive a VM or host power loss: the temp file is
   fsynced before the rename and the directory after it. JOURNAL_INITIALIZED marks a directory that has held a journal;
   a missing state.json there is a lost journal (which could hide an in-flight stage), not a fresh wallet. */
function durableWrite(file, text) {
  const t = file + ".tmp", fd = fs.openSync(t, "w", 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(t, file);
  try { const d = fs.openSync(DIR, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
  catch (e) { if (process.platform !== "win32") throw e; }   // Windows cannot fsync a directory; the bot runs on Linux
}
/* readOnly (status only): a lost journal is reported as { journalLost } instead of thrown, so the operator can read
   onchain balances before deciding to delete the marker. Anything that signs loads without it and fails closed. */
function loadState({ readOnly = false } = {}) {
  try { return JSON.parse(fs.readFileSync(F.state, "utf8")); }
  catch (e) {
    if (e.code !== "ENOENT") throw new Error(`state.json unreadable (${e.message}); refusing to run without the journal`);
    if (fs.existsSync(F.init) && readOnly) return { journalLost: `state.json is missing; ${F.init} says a journal existed since ${fs.readFileSync(F.init, "utf8").trim()}` };
    if (fs.existsSync(F.init)) throw Object.assign(new Error(`state.json is missing but ${F.init} says this directory has held a journal since ${fs.readFileSync(F.init, "utf8").trim()}. `
      + `A lost journal could hide a loop in flight. Restore state.json, or, only if you have checked on chain that no loop is in flight, delete ${F.init}.`), { lostJournal: true, halt: true });
    return {};
  }
}
function saveState(s) {
  durableWrite(F.state, JSON.stringify(s, null, 1));
  if (!fs.existsSync(F.init)) durableWrite(F.init, new Date().toISOString() + "\n");
}
const today = () => new Date().toISOString().slice(0, 10);
function rollDay(s) { if (s.day !== today()) Object.assign(s, { day: today(), loopsToday: 0, feesToday: "0", refillsToday: 0 }); }
const addFee = (s, amt) => { s.feesToday = (BigInt(s.feesToday || 0) + BigInt(amt)).toString(); };

/* ---------------- logging and alerts ---------------- */
const log = (...a) => console.log(new Date().toISOString(), ...a);
setLog((...a) => log("[page]", ...a));
async function alert(cfg, text) {
  log("ALERT", text);
  const t = cfg.telegram; if (!t?.token_file || !t.chat_id) return;
  try {
    const token = fs.readFileSync(t.token_file, "utf8").trim();
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: t.chat_id, text: `alloybot: ${text}`.slice(0, 4000) }) });
  } catch (e) { log("telegram failed:", e.message.replace(/bot\d+:[\w-]+/g, "bot<REDACTED>")); }
}
function writeHalt(reason) {
  fs.writeFileSync(F.halted, `${new Date().toISOString()}\n${reason}\n\nInvestigate, then delete this file to let the bot run again.\n`);
  try { const s = loadState(); s.haltedAt = new Date().toISOString(); saveState(s); }
  catch (e) { if (!e.lostJournal) throw e; }   // a lost journal is itself the halt reason; never write a fresh one here
}
/* HALTED was deleted: a person has looked. A stage with no recorded tx has nothing in flight, so it gets a fresh set
   of attempts; a stage with a recorded tx keeps it and is resolved against the chain as usual. */
function acknowledgeHalt(s) {
  if (!s.haltedAt) return;
  log(`halt from ${s.haltedAt} acknowledged`);
  const st = s.cycle && s.cycle.stages[ORDER[s.cycle.idx]];
  if (st && !st.tx) { st.signed = 0; st.requotes = 0; st.retryAfter = undefined; }
  s.haltedAt = undefined; saveState(s);
}

/* ---------------- wallet ---------------- */
function loadWallet() {
  const file = process.env.ALLOYBOT_MNEMONIC_FILE || (process.env.CREDENTIALS_DIRECTORY && path.join(process.env.CREDENTIALS_DIRECTORY, "mnemonic"));
  if (!file) throw new Error("set ALLOYBOT_MNEMONIC_FILE (or run under systemd with LoadCredential=mnemonic:...)");
  const st = fs.statSync(file);
  if (process.platform !== "win32" && (st.mode & 0o077)) throw new Error(`${file} is readable by group/other (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  return deriveWallet(fs.readFileSync(file, "utf8"));
}

const runCycle = makeRunner({ STAGES, ORDER, saveState, log, addFee });

/* ---------------- one decision ---------------- */
async function tick(ctx) {
  const s = loadState(); rollDay(s); acknowledgeHalt(s);
  if (s.addrs && (s.addrs.osmo !== ctx.W.osmo || s.addrs.evm !== ctx.W.evm)) throw halt(`state.json belongs to ${s.addrs.osmo}, this mnemonic is ${ctx.W.osmo}`);
  s.addrs = { osmo: ctx.W.osmo, inj: ctx.W.inj, evm: ctx.W.evm };
  if (s.cycle && DRY) return log(`a real loop ${s.cycle.id} is in flight; dry run does nothing while it is`), "busy";
  if (s.cycle) { log(`resuming loop ${s.cycle.id} at ${ORDER[s.cycle.idx]}`); return runCycle(ctx, s); }
  if (!ctx.cfg.enabled || fs.existsSync(F.stop)) { saveState(s); return "disabled"; }
  if (s.waitUntil && Date.now() < s.waitUntil) return "waiting";

  const pool = await readPool();
  if (!pool.active) return log("transmuter is inactive (frozen); not starting"), "frozen";
  if (pool.corrupted.length) return log("transmuter has corrupted denoms:", pool.corrupted.join(", ")), "frozen";
  if (pool.limiters.length) return log(`transmuter has ${pool.limiters.length} limiter(s) set; not starting until they are reviewed`), "limited";
  const need = deficit(pool, ctx.cfg.target_inj_pct);
  log(`pool: USDC.inj ${sharePct(pool).toFixed(2)}% (target ${ctx.cfg.target_inj_pct}%), short by ${fmtUnits(need)}`);
  if (need < usdc(ctx.cfg.min_loop_usdc)) { saveState(s); return "at-target"; }

  const b = await balances(ctx.W), strand = usdc(ctx.cfg.stranded_threshold_usdc);
  for (const [what, v] of [["USDC.noble on Osmosis", b.noble], ["USDC on Avalanche", b.avaxUsdc], ["USDC.inj on Injective", b.injUsdc]])
    if (v >= strand) throw halt(`${fmtUnits(v)} ${what} with no loop in flight: an earlier loop left funds outside the alloy. Recover them (the page's stranded-funds offer), then delete HALTED.`);

  for (const [g, bal, dec] of [["avax", b.avax, 18], ["inj", b.inj, 18]]) {
    if (Number(bal) / 10 ** dec >= ctx.cfg.gas_floor[g]) continue;
    // a refill still in flight (slow Axelar delivery, or an error while waiting) must not be bought a second time.
    // Only signed refills are recorded ({at, hash}); a bare timestamp from an earlier version was set before the route
    // check and says nothing about a signature, so it is dropped.
    const pending = s.refillPending?.[g];
    if (typeof pending === "number") { delete s.refillPending[g]; log(`dropping unsigned ${g.toUpperCase()} refill marker from ${new Date(pending).toISOString()}`); }
    else if (pending && Date.now() - pending.at < 45 * 60000) { saveState(s); return log(`${g.toUpperCase()} refill ${pending.hash} from ${new Date(pending.at).toISOString()} is still in flight; waiting`), "waiting"; }
    if ((s.refillsToday || 0) >= ctx.cfg.max_gas_refills_per_day) throw halt(`${g.toUpperCase()} gas is below its floor and today's ${ctx.cfg.max_gas_refills_per_day} refills are used up`);
    const spend = usdc(ctx.cfg.gas_refill_usdc?.[g] ?? 1);
    // the daily fee cap is a hard ceiling for refills too: the refill plus a bound on its Osmosis fee must fit
    const room = usdc(ctx.cfg.max_fee_usdc_per_day) - BigInt(s.feesToday || 0);
    if (room < spend + REFILL_FEE_BOUND) { saveState(s); return log(`${g.toUpperCase()} gas is below its floor but a ${fmtUnits(spend)} refill does not fit in today's remaining fee budget ${fmtUnits(room > 0n ? room : 0n)}; waiting for 00:00 UTC`), "capped"; }
    try {
      await refillGas(g, ctx, m => log(`[gas ${g}]`, m), async tx => {   // counted at signing, before broadcast, with its own tx fee
        const total = spend + BigInt(tx.feeAllUSDC || 0);
        // the exact fee is known here: recheck the hard cap before anything is journaled or broadcast
        if (total > room) throw Object.assign(new Error(`${g.toUpperCase()} refill costs ${fmtUnits(total)} with its fee, over today's remaining budget ${fmtUnits(room)}`), { feeCap: true });
        s.refillsToday = (s.refillsToday || 0) + 1; s.refillPending = { ...s.refillPending, [g]: { at: Date.now(), hash: tx.hash } };
        addFee(s, total); saveState(s);
      });
    } catch (e) {
      if (e.feeCap) { saveState(s); return log(`${e.message}; not sent, waiting for 00:00 UTC`), "capped"; }
      if (!e.requote || DRY) throw e;
      // a refused gas route signed nothing: ask again in 10 minutes, halt when it keeps refusing
      const n = (s.gasRefusals?.[g] || 0) + 1; s.gasRefusals = { ...s.gasRefusals, [g]: n };
      if (n >= 6) { s.gasRefusals[g] = 0; saveState(s); throw halt(`${g.toUpperCase()} gas route refused ${n} times in a row, latest: ${e.message}`); }
      s.waitUntil = Date.now() + 10 * 60000; saveState(s);
      return log(`${e.message}; asking again in 10 minutes (${n}/6)`), "waiting";
    }
    if (s.gasRefusals?.[g]) s.gasRefusals[g] = 0;
    if (DRY) continue;   // a dry run goes on to the loop checks as if the refill had landed
    delete s.refillPending[g]; saveState(s);
    return "refilled";
  }

  if ((s.loopsToday || 0) >= ctx.cfg.max_loops_per_day) { saveState(s); return log("max_loops_per_day reached"), "capped"; }
  const idle = b.all - usdc(ctx.cfg.reserve_usdc);
  let amount = usdc(ctx.cfg.loop_usdc); if (need < amount) amount = need; if (idle < amount) amount = idle;
  if (amount < usdc(ctx.cfg.min_loop_usdc)) { saveState(s); return log(`idle allUSDC ${fmtUnits(b.all)} (reserve ${ctx.cfg.reserve_usdc}) is below min_loop_usdc`), "no-funds"; }
  // a loop starts only if its worst-case loss and a bound on its A1 fee fit in today's budget; A1 rechecks the exact fee
  if (!fitsFeeCap({ capMicro: ctx.capMicro, bookedMicro: s.feesToday, amountIn: amount, bps: ctx.cfg.max_loop_loss_bps, feeMicro: REFILL_FEE_BOUND })) {
    saveState(s); return log(`a ${fmtUnits(amount)} loop (worst-case loss ${fmtUnits(loopLossBound(amount, ctx.cfg.max_loop_loss_bps))} + fee) does not fit in today's remaining fee budget; waiting for 00:00 UTC`), "capped";
  }

  for (const [denom, dir, ch, label] of [[K.NOBLE, "out", K.OSMO_TO_NOBLE, "USDC.noble outflow"], [K.INJ_IBC, "in", K.OSMO_TO_INJ, "USDC.inj inflow"]]) {
    const h = await headroom(denom, dir, ch);
    if (h.room !== null && h.room < amount * BigInt(10000 + Math.round(ctx.cfg.rate_limit_margin_pct * 100)) / 10000n) {
      s.waitUntil = h.resetsAt || Date.now() + 3600000; saveState(s);
      return log(`${label} rate limit ${h.quota} has ${fmtUnits(h.room)} room; waiting until ${new Date(s.waitUntil).toISOString()}`), "rate-limited";
    }
  }

  if (DRY) return dryRun(ctx, s, amount);
  s.cycle = { id: new Date().toISOString().replace(/[-:]/g, "").slice(0, 15), amountIn: amount.toString(), idx: 0, stages: {}, poolShareAtStart: sharePct(pool) };
  s.waitUntil = undefined; saveState(s);
  log(`starting loop ${s.cycle.id}: ${fmtUnits(amount)} allUSDC`);
  return runCycle(ctx, s);
}

/* everything a loop would sign, built and checked with nothing broadcast: the A1 tx is signed and simulated, the A2
   and A3 routes are fetched for the same amount and validated (they cannot be simulated before A1's funds exist), and
   both gas refill routes are validated and simulated */
async function dryRun(ctx, s, amount) {
  const a = amount.toString();
  s.cycle = { id: "dry", amountIn: a, idx: 0, stages: {} };
  await runCycle(ctx, s);
  const { skipRoute, validateHubToInj, validateInjToAll } = P, H = K.HUB["43114"], W = ctx.W;
  const v2 = validateHubToInj(await skipRoute(H.usdc, "43114", K.INJ_EVM_USDC, K.INJ_EVM_CHAIN, a, { "43114": W.evm, [K.INJ_EVM_CHAIN]: W.injHex }), { evm: W.evm, injHex: W.injHex, amountIn: a, hub: "43114" });
  log(`[dry A2] route ${v2.ok ? "ok" : "REFUSED: " + v2.errs.join("; ")}, ${fmtUnits(v2.amountOut || 0)} USDC.inj out`);
  const r3 = await skipRoute(K.INJ_ERC20, "injective-1", K.ALL, "osmosis-1", a, { "injective-1": W.inj, "osmosis-1": W.osmo });
  let v3 = validateInjToAll(r3, { inj: W.inj, osmo: W.osmo, amountIn: a });
  if (v3.ok) { tightenMinAsset(r3, a); v3 = validateInjToAll(r3, { inj: W.inj, osmo: W.osmo, amountIn: a }); }
  log(`[dry A3] route ${v3.ok ? "ok (min_asset raised to the full amount)" : "REFUSED: " + v3.errs.join("; ")}, ${fmtUnits(v3.amountOut || 0)} allUSDC out`);
  for (const g of ["avax", "inj"]) {
    try { await refillGas(g, ctx, m => log(`[dry gas ${g}]`, m)); } catch (e) { log(`[dry gas ${g}] ${e.message}`); }
  }
  return "dry";
}

/* ---------------- commands ---------------- */
async function status(ctx) {
  const s = loadState({ readOnly: true }), cfg = ctx.cfg, pool = await readPool(), b = await balances(ctx.W);
  const rl = await Promise.all([headroom(K.NOBLE, "out", K.OSMO_TO_NOBLE), headroom(K.INJ_IBC, "in", K.OSMO_TO_INJ)]);
  console.log(JSON.stringify({
    addresses: ctx.W, journalLost: s.journalLost || null, halted: fs.existsSync(F.halted) ? fs.readFileSync(F.halted, "utf8").split("\n")[1] : null, stopFile: fs.existsSync(F.stop), enabled: cfg.enabled,
    pool: { noble: fmtUnits(pool.noble), inj: fmtUnits(pool.inj), total: fmtUnits(pool.total), injPct: sharePct(pool), target: cfg.target_inj_pct, shortBy: fmtUnits(deficit(pool, cfg.target_inj_pct)),
            active: pool.active, corrupted: pool.corrupted, limiters: pool.limiters.length },
    balances: { allUSDC: fmtUnits(b.all), usdcNobleOnOsmosis: fmtUnits(b.noble), avalancheUSDC: fmtUnits(b.avaxUsdc), AVAX: fmtUnits(b.avax, 18), INJ: fmtUnits(b.inj, 18), injectiveUSDCinj: fmtUnits(b.injUsdc) },
    rateLimitRoom: { nobleOut: rl[0].room === null ? "no quota" : fmtUnits(rl[0].room), injIn: rl[1].room === null ? "no quota" : fmtUnits(rl[1].room) },
    today: { day: s.day, loops: s.loopsToday || 0, feesUsdc: fmtUnits(s.feesToday || 0), refills: s.refillsToday || 0 },
    cycle: s.cycle || null, lastLoops: (s.history || []).slice(-5),
  }, null, 1));
}

/* one signer per wallet: two instances would each sign the same stage. A lock left by a dead process is taken over. */
function lock() {
  const f = path.join(DIR, "LOCK");
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, String(process.pid), { flag: "wx" }); process.on("exit", () => { try { fs.unlinkSync(f); } catch {} }); for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0)); return; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(f, "utf8"));
      let alive = false; try { process.kill(pid, 0); alive = true; } catch (k) { alive = k.code === "EPERM"; }
      if (alive) throw new Error(`another alloybot (pid ${pid}) holds ${f}; stop it first (systemctl stop alloybot)`);
      fs.unlinkSync(f);
    }
  }
  throw new Error(`could not take ${f}`);
}

/* writes a fresh 24-word mnemonic to a new file with mode 0600; refuses to overwrite. Nothing is printed. */
async function keygen(file) {
  if (!file) throw new Error("usage: node bot.mjs keygen /etc/alloybot/mnemonic");
  const { generateMnemonic } = await import("@scure/bip39"), { wordlist } = await import("@scure/bip39/wordlists/english.js");
  fs.writeFileSync(file, generateMnemonic(wordlist, 256) + "\n", { mode: 0o600, flag: "wx" });
  console.log(`wrote a new 24-word mnemonic to ${file} (mode 600). Back it up offline before funding the wallet.`);
}

async function main() {
  if (cmd === "keygen") return keygen(argv.filter(a => !a.startsWith("--"))[1]);
  if (cmd === "addresses") { const { W } = loadWallet(); console.log(JSON.stringify(W, null, 1)); return; }
  fs.mkdirSync(DIR, { recursive: true });
  const wallet = loadWallet();
  const mk = () => { const cfg = loadConfig(cmd !== "status"); return { W: wallet.W, wallet, cfg, capMicro: usdc(cfg.max_fee_usdc_per_day), signOpts: { dryRun: DRY, osmoFeeMargin: cfg.osmo_fee_margin } }; };
  if (cmd === "status") return status(mk());
  if (cmd !== "run" && cmd !== "once") throw new Error(`unknown command ${cmd}`);
  loadConfig(true);   // fail at startup, not on the first tick, when config.json is missing or invalid
  lock();
  log(`alloybot ${cmd}${DRY ? " (dry run)" : ""} for ${wallet.W.osmo} / ${wallet.W.inj} / ${wallet.W.evm}, state in ${DIR}`);
  let lastHaltLog = 0, transient = 0;
  for (;;) {
    let ctx;
    try {
      ctx = mk();
      if (fs.existsSync(F.halted)) {
        if (Date.now() - lastHaltLog > 3600000) { log("HALTED:", fs.readFileSync(F.halted, "utf8").split("\n")[1]); lastHaltLog = Date.now(); }
      } else {
        const r = await tick(ctx); transient = 0;
        if (r === "done" || r === "refilled") { if (cmd === "once") return; continue; }   // straight to the next decision
      }
    } catch (e) {
      const cfg = ctx?.cfg || DEFAULTS;
      if (e.halt) { writeHalt(e.message); await alert(cfg, "HALTED: " + e.message); }
      else if (e.wait) { log("waiting:", e.message); if (e.until) { const s = loadState(); if (!s.cycle) { s.waitUntil = e.until; saveState(s); } } }
      else { transient++; log(`error (${transient} in a row): ${e.message}`); if (transient % 15 === 0) await alert(cfg, `${transient} consecutive errors, latest: ${e.message}`); for (const k of Object.keys(PROVEN)) delete PROVEN[k]; }
    }
    if (cmd === "once" || DRY) return;
    await sleep(TICK_MS);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
