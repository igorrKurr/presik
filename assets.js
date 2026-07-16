// Read bundled assets (the HTML/CSS/JS pages and the scaffold templates) the
// same way whether presik runs from source/npm (files on disk) or as a packaged
// single-file binary (assets embedded in the executable via node:sea).
//
// Asset keys are POSIX-style paths relative to the engine root, e.g.
// "public/host.html" — matching the keys in build/sea-config.json.
const fs = require('fs');
const path = require('path');

let sea = null;
try { sea = require('node:sea'); } catch (_) {}
const IS_SEA = !!(sea && typeof sea.isSea === 'function' && sea.isSea());

const ROOT = __dirname; // engine dir when running from source/npm

function readAssetText(rel) {
  if (IS_SEA) return sea.getAsset(rel, 'utf8');
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readAssetBuffer(rel) {
  if (IS_SEA) return Buffer.from(sea.getAsset(rel));
  return fs.readFileSync(path.join(ROOT, rel));
}

module.exports = { IS_SEA, readAssetText, readAssetBuffer };
