// One folder's decisions for Sync with My Cloud: compare the base (each file as it was when last in step on both
// sides), the PC and the Cloud, and say what to do. No I/O. With no base nothing reads as deleted, so a first sync, or
// one after the record was lost, never deletes.
import { clashPath, foldKey, windowsProblem } from "./cloud-sync-rules.mjs";

export function planFolder({ base, pc, cloud, windows = false, caseInsensitive = false, now = Date.now() }) {
  const held = [];
  const visible = new Map();
  const localSpelling = new Map();
  if (caseInsensitive) for (const path of [...base.keys(), ...pc.keys()]) localSpelling.set(foldKey(path), path);
  const seen = new Set();
  const keepLocal = new Set();
  const renames = [];
  for (const path of [...cloud.keys()].sort()) {
    if (windows && windowsProblem(path)) { held.push({ path, reason: "windows-name" }); continue; }
    if (caseInsensitive) {
      const key = foldKey(path);
      const local = localSpelling.get(key);
      // Renamed on My Cloud in capitals only: this PC's spelling is not deleted; with the same bytes it is renamed.
      if (local !== undefined && local !== path && !cloud.has(local) && !seen.has(key)) {
        keepLocal.add(local);
        const mine = pc.get(local) ?? base.get(local);
        const theirs = cloud.get(path);
        if (mine && !mine.unsettled && mine.sha256 === theirs.sha256) {
          seen.add(key);
          renames.push({ type: "movePc", from: local, to: path, sha256: theirs.sha256, size: theirs.size });
          continue;
        }
      }
      if (seen.has(key) || (local !== undefined && local !== path)) { held.push({ path, reason: "case-clash" }); continue; }
      seen.add(key);
    }
    visible.set(path, cloud.get(path));
  }
  const taken = (path) => pc.has(path) || cloud.has(path);
  const actions = [];
  for (const path of [...new Set([...base.keys(), ...pc.keys(), ...visible.keys()])].sort()) {
    if ((cloud.has(path) && !visible.has(path)) || keepLocal.has(path)) continue;
    const b = base.get(path), l = pc.get(path), c = visible.get(path);
    if (l?.unsettled) continue;
    const local = !l ? (b ? "deleted" : "absent") : !b ? "new" : l.sha256 === b.sha256 ? "same" : "changed";
    const remote = !c ? (b ? "deleted" : "absent") : !b ? "new" : c.sha256 === b.sha256 ? "same" : "changed";
    switch (`${local}/${remote}`) {
      case "new/absent":
      case "changed/deleted":
        actions.push({ type: "upload", path, sha256: l.sha256, size: l.size, mtimeMs: l.mtimeMs, baseSha256: null });
        break;
      case "changed/same":
        actions.push({ type: "upload", path, sha256: l.sha256, size: l.size, mtimeMs: l.mtimeMs, baseSha256: b.sha256 });
        break;
      case "absent/new":
      case "same/changed":
      case "deleted/changed":
        actions.push({ type: "download", path, sha256: c.sha256, size: c.size });
        break;
      case "new/new":
      case "changed/changed":
        if (l.sha256 === c.sha256) actions.push({ type: "record", path, sha256: l.sha256, size: l.size, mtimeMs: l.mtimeMs });
        else actions.push({ type: "clash", path, clashPath: clashPath(path, now, taken), pcSha256: l.sha256, pcSize: l.size, cloudSha256: c.sha256, cloudSize: c.size });
        break;
      case "deleted/same":
        actions.push({ type: "deleteCloud", path, baseSha256: b.sha256 });
        break;
      case "same/deleted":
        actions.push({ type: "deletePc", path, sha256: b.sha256 });
        break;
      case "deleted/deleted":
        actions.push({ type: "forget", path });
        break;
      default:
        break;
    }
  }
  return { actions: [...renames, ...pairRenames(actions)], held };
}

// A delete on one side and a new file with the same bytes on that side is a rename: move it on the other side.
function pairRenames(actions) {
  const out = [...actions];
  const pair = (gone, arrived, make) => {
    for (const removed of out.filter((action) => action.type === gone)) {
      const sha = removed.baseSha256 ?? removed.sha256;
      const added = out.find((action) => action.type === arrived && action.sha256 === sha && (arrived !== "upload" || action.baseSha256 === null));
      if (!added) continue;
      out.splice(out.indexOf(removed), 1);
      out.splice(out.indexOf(added), 1, make(removed, added));
    }
  };
  pair("deleteCloud", "upload", (removed, added) => ({ type: "moveCloud", from: removed.path, to: added.path, sha256: added.sha256, size: added.size, mtimeMs: added.mtimeMs }));
  pair("deletePc", "download", (removed, added) => ({ type: "movePc", from: removed.path, to: added.path, sha256: added.sha256, size: added.size }));
  return out;
}
