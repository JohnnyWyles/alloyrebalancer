/* The mnemonic file's permission rule, kept apart from bot.mjs so test.mjs can drive it with fake stat results.
 * A plain file must not be readable by group or other (mode 600 or tighter). systemd 255 hands a system service with
 * User= its LoadCredential file as root:root mode 0440, inside a root:root 0550 directory, and grants the service
 * user read through an ACL; group read there is root's group, not another user, so that exact layout is accepted.
 * (systemd 249 handed the same credential over as the service user's mode 0400, which the plain rule already passes.)
 */
import path from "node:path";

/* st, dirSt: { mode, uid, gid } from fs.statSync of the file and of its directory. Returns null if the file is
   acceptable, otherwise the reason it is not. */
export function mnemonicFileProblem(file, st, credDir, dirSt) {
  const mode = st.mode & 0o777;
  if (!(mode & 0o077)) return null;
  const systemdCredential = !!credDir && !!dirSt && path.dirname(path.resolve(file)) === path.resolve(credDir)
    && !(mode & 0o037) && st.uid === 0 && st.gid === 0
    && dirSt.uid === 0 && dirSt.gid === 0 && !(dirSt.mode & 0o027);
  return systemdCredential ? null : `${file} is readable by group/other (mode ${mode.toString(8)}); chmod 600 it`;
}
