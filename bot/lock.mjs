/* The single-signer lock's staleness rule, kept apart from bot.mjs so test.mjs can drive it with fake process facts.
 * A lock names the pid that took it and, on Linux, the boot it was taken in. After a reboot the old pid is usually
 * reused by an unrelated process, so "a process with that pid is alive" alone would refuse to start forever.
 */
import fs from "node:fs";

export const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const readOr = (f, d) => { try { return fs.readFileSync(f, "utf8"); } catch { return d; } };

export function lockText(pid, bootId) { return JSON.stringify({ pid, boot: bootId || null }); }

/* facts: { bootId, alive(pid) -> bool, cmdline(pid) -> string | null (null when it cannot be read) }.
   Returns { stale, pid, why }. A lock from an older build is a bare pid with no boot id. */
export function lockStatus(text, facts) {
  let pid, boot = null;
  try { const j = JSON.parse(text); if (typeof j === "number") pid = j; else ({ pid, boot } = j); } catch { pid = Number(text); }
  if (!Number.isInteger(pid) || pid <= 0) return { stale: true, pid, why: "unreadable lock" };
  if (boot && facts.bootId && boot !== facts.bootId) return { stale: true, pid, why: "taken before the last reboot" };
  if (!facts.alive(pid)) return { stale: true, pid, why: "its process has exited" };
  const cmd = facts.cmdline(pid);
  if (cmd !== null && !/bot\.mjs/.test(cmd)) return { stale: true, pid, why: `pid ${pid} is now another program` };
  return { stale: false, pid, why: "held by a running alloybot" };
}

/* the real facts for this machine */
export function processFacts() {
  return {
    bootId: readOr(BOOT_ID_FILE, "").trim() || null,
    alive: pid => { try { process.kill(pid, 0); return true; } catch (k) { return k.code === "EPERM"; } },
    cmdline: pid => { const c = readOr(`/proc/${pid}/cmdline`, null); return c === null ? null : c.replace(/\0/g, " "); },
  };
}
