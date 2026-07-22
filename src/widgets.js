// Widget packages: a game project builds to a self-contained folder with a
// widget.json manifest, and `presik widget add` vendors that folder into
// <content-root>/widgets/<name>@<version>/. A question then references it by
// name (widget.package), and the server resolves it here. Vendored = the class
// runs fully offline; the game keeps its own repo, build and tests.
//
// The version-matching logic is pure (given a list of dir names), so it's
// unit-tested in test/lib.test.js; only the small fs wrappers touch disk.
const fs = require('fs');
const path = require('path');

// "name" or "name@version" → { name, version|null }. A dir vendored from a
// manifest with no version is just "name" (version null).
function parsePackageRef(ref) {
  const s = String(ref == null ? '' : ref);
  const at = s.indexOf('@');
  if (at < 0) return { name: s, version: null };
  return { name: s.slice(0, at), version: s.slice(at + 1) || null };
}

// Numeric, segment-by-segment version compare (a<b → <0). Non-numeric tails like
// "-beta" are ignored — enough to pick the highest matching build.
function cmpVersion(a, b) {
  const pa = String(a).split('.'), pb = String(b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// Does an installed version satisfy the wanted one? `want` may be absent (any),
// exact ("3.2.0"), or a dotted prefix ("3" or "3.2" → highest under it).
function versionSatisfies(v, want) {
  if (!want) return true;
  return v === want || String(v).startsWith(want + '.');
}

// Pick the best-matching vendored dir name for a ref, or null. Highest version
// wins when several satisfy a prefix.
function pickPackageDir(dirNames, ref) {
  const { name, version } = parsePackageRef(ref);
  const cands = [];
  for (const d of dirNames || []) {
    const p = parsePackageRef(d);
    if (p.name !== name) continue;
    if (!versionSatisfies(p.version || '', version)) continue;
    cands.push({ dir: d, version: p.version || '' });
  }
  if (!cands.length) return null;
  cands.sort((x, y) => cmpVersion(y.version, x.version));
  return cands[0].dir;
}

// ---- fs wrappers ----------------------------------------------------------
function listPackageDirs(widgetsDir) {
  try {
    return fs.readdirSync(widgetsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (_) { return []; }
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'widget.json'), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch (_) { return null; }
}

// Resolve a widget.package ref to a served bundle: { dirName, dir, manifest, entry }.
function resolvePackage(widgetsDir, ref) {
  const dirName = pickPackageDir(listPackageDirs(widgetsDir), ref);
  if (!dirName) return null;
  const dir = path.join(widgetsDir, dirName);
  const manifest = readManifest(dir) || {};
  const entry = typeof manifest.entry === 'string' && manifest.entry.trim() ? manifest.entry : 'index.html';
  return { dirName, dir, manifest, entry };
}

module.exports = { parsePackageRef, cmpVersion, versionSatisfies, pickPackageDir, listPackageDirs, readManifest, resolvePackage };
