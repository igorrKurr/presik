#!/usr/bin/env node
// =====================================================================
//  presik widget — vendor an independently-built game into the content so
//  a quiz can reference it by name and the class runs fully offline.
//
//    presik widget add ../dungeon/dist          → copies the built bundle into
//                                                   ./widgets/<name>@<version>/
//    presik widget add ../dungeon/dist --force   → overwrite an existing version
//    presik widget ls                            → list vendored packages
//    presik widget add <dist> --dir <path>       → content root isn't the cwd
//
//  The bundle must contain a widget.json manifest at its root (see CONVENTIONS.md):
//    { "presikWidget": "1", "name": "dungeon-escape", "version": "3.2.0",
//      "entry": "index.html", "answer": "choice", "options": [{ "id": "east" }] }
// =====================================================================
const fs = require('fs');
const path = require('path');
const { parseArgs, isPackageRef } = require('./lib');
const { listPackageDirs, readManifest } = require('./widgets');

const rawArgv = process.argv.slice(2);
const argv = rawArgv[0] === 'widget' ? rawArgv.slice(1) : rawArgv;
const sub = argv[0];
const { positional, opt, has } = parseArgs(argv.slice(1), ['dir']);

const CONTENT_DIR = path.resolve(opt('dir', process.cwd()));
const WIDGETS_DIR = path.join(CONTENT_DIR, 'widgets');

// Show the shorter of cwd-relative or absolute — a clean "widgets/…" when run
// from the content root, an unambiguous absolute path when --dir points away.
function rel(p) {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith('..') ? r : p;
}

if (sub === 'add') add();
else if (sub === 'ls' || sub === 'list') ls();
else usage();

function usage() {
  console.error('\n  Usage:');
  console.error('    presik widget add <path-to-built-dist> [--force] [--dir <content-root>]');
  console.error('    presik widget ls [--dir <content-root>]\n');
  console.error('  The bundle needs a widget.json at its root (name, version, entry, answer).\n');
  process.exit(sub ? 1 : 0);
}

function add() {
  const srcArg = positional[0];
  if (!srcArg) usage();
  const srcDir = path.resolve(srcArg);
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory())
    die('Not a folder: ' + srcArg + '\n  Point at your game\'s build output (e.g. ../dungeon/dist).');

  const manifest = readManifest(srcDir);
  if (!manifest) die('No readable widget.json in ' + srcArg + '\n  A widget package must carry a widget.json manifest at its root — see CONVENTIONS.md.');
  const name = String(manifest.name || '').trim();
  if (!isPackageRef(name)) die('widget.json "name" must be a simple package name (letters, digits, . _ -), got: ' + JSON.stringify(manifest.name));
  const version = manifest.version == null ? '' : String(manifest.version).trim();
  const dirName = version ? name + '@' + version : name;
  if (!isPackageRef(dirName)) die('widget.json "version" is not a valid version: ' + JSON.stringify(manifest.version));
  const entry = typeof manifest.entry === 'string' && manifest.entry.trim() ? manifest.entry : 'index.html';
  if (!fs.existsSync(path.join(srcDir, entry)))
    die('Manifest entry "' + entry + '" does not exist in the bundle — check widget.json "entry".');

  const destDir = path.join(WIDGETS_DIR, dirName);
  if (fs.existsSync(destDir)) {
    if (!has('force')) die('Already installed: widgets/' + dirName + '\n  Re-add with --force to overwrite, or bump the version in widget.json.');
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(WIDGETS_DIR, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });

  console.log('\n  Vendored ' + dirName + ' → ' + rel(destDir) + (has('force') ? '  (overwrote)' : ''));
  const answer = manifest.answer || 'choice';
  const opts = Array.isArray(manifest.options) ? manifest.options : [];
  console.log('\n  Reference it from a question in questions.json:\n');
  console.log('    {');
  console.log('      "type": "widget", "text": "…",');
  console.log('      "answer": ' + JSON.stringify(answer) + ',');
  if (answer === 'choice') {
    const rows = (opts.length ? opts : [{ id: 'a' }, { id: 'b' }]).map(
      (o, i) => '        { "id": ' + JSON.stringify(o.id || String.fromCharCode(97 + i)) + ', "text": "…"' + (i === 0 ? ', "correct": true' : '') + ' }'
    );
    console.log('      "options": [\n' + rows.join(',\n') + '\n      ],');
  } else if (answer === 'scale') {
    console.log('      "min": 1, "max": 5,');
  }
  console.log('      "widget": { "package": ' + JSON.stringify(version ? name + '@' + version : name) + ' }');
  console.log('    }\n');
  console.log('  (The manifest supplies the outcome ids; the quiz supplies the labels and which is correct.)\n');
}

function ls() {
  const dirs = listPackageDirs(WIDGETS_DIR);
  if (!dirs.length) {
    console.log('\n  No widget packages in ' + rel(WIDGETS_DIR) + '.');
    console.log('  Add one:  presik widget add <path-to-built-dist>\n');
    return;
  }
  console.log('\n  Widget packages in ' + rel(WIDGETS_DIR) + ':\n');
  for (const d of dirs.sort()) {
    const m = readManifest(path.join(WIDGETS_DIR, d)) || {};
    const bits = ['answers as ' + (m.answer || 'choice')];
    if (m.entry) bits.push('entry ' + m.entry);
    if (m.isolate) bits.push('isolate');
    console.log('    ' + d.padEnd(28) + '  ' + bits.join(' · '));
  }
  console.log('');
}

function die(msg) {
  console.error('\n  ' + msg + '\n');
  process.exit(1);
}
