// Optional per-project settings: presik.config.json.
//
// The point is to stop retyping the same flags for a course you run every week
// — so the file holds exactly what a flag could hold, under the same names, and
// a flag always beats the file. Two levels, both optional:
//
//   <content-root>/presik.config.json     the project's settings
//   <session>/presik.config.json          overrides for one session
//
//   precedence:  CLI flag  >  session config  >  root config  >  built-in default
//
// Relative paths (qr, db) resolve against the directory of the config file that
// set them, not the cwd — a config file means the same thing no matter where you
// happen to be standing when you run presik. (CLI paths still resolve against
// the cwd, which is what you'd expect while typing one.)
const fs = require('fs');
const path = require('path');
const { CONFIG_FILE, CONFIG_SPEC, validateConfigObject, mergeConfig } = require('./lib');

function resolvePaths(config, dir) {
  const out = Object.assign({}, config);
  for (const [k, kind] of Object.entries(CONFIG_SPEC)) {
    if (kind === 'path' && typeof out[k] === 'string') out[k] = path.resolve(dir, out[k]);
  }
  return out;
}

// One layer. Returns null when there's no config file here at all (the common
// case — the whole feature is opt-in).
function readConfigFile(dir, label) {
  const file = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, config: null, errors: [label + ': invalid JSON — ' + e.message] };
  }
  const errors = validateConfigObject(raw, label);
  return { file, config: errors.length ? null : resolvePaths(raw, dir), errors };
}

// Read both levels and merge them. Errors are collected rather than thrown: the
// caller prints them all at once and exits, so you fix a typo'd config in one
// pass instead of one message per run.
function loadConfig(contentDir, sessionDir) {
  const dirs = sessionDir && sessionDir !== contentDir ? [contentDir, sessionDir] : [contentDir];
  const layers = [];
  const files = [];
  const errors = [];
  for (const dir of dirs) {
    const label = path.relative(contentDir, path.join(dir, CONFIG_FILE)).split(path.sep).join('/') || CONFIG_FILE;
    const r = readConfigFile(dir, label);
    if (!r) continue;
    files.push(label);
    errors.push(...r.errors);
    if (r.config) layers.push(r.config);
  }
  return { config: mergeConfig(layers), files, errors };
}

module.exports = { loadConfig, readConfigFile, resolvePaths, CONFIG_FILE };
