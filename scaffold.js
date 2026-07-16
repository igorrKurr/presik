#!/usr/bin/env node
// =====================================================================
//  presik new <session> — generates a starter questions.json (and, unless
//  --questions-only, a deck.marp.md) for a new session, from the templates
//  shipped in templates/. Refuses to overwrite files that already exist.
//
//    presik new s02                              → ./s02/questions.json + ./s02/deck.marp.md
//    presik new web-dev/s02 --title "S02 — ..."   → nested session, custom title
//    presik new s02 --questions-only              → skip the deck, just the quiz
//    presik new s02 --dir ~/courses/x              → content root isn't the cwd
// =====================================================================
const fs = require('fs');
const path = require('path');
const { readAssetText } = require('./assets');

// bin/cli.js dispatches here with the leading "new" still in argv when run
// as `presik new ...`; running this file directly (`node scaffold.js s02`)
// won't have it. Strip it either way so parsing is identical.
const rawArgv = process.argv.slice(2);
const argv = rawArgv[0] === 'new' ? rawArgv.slice(1) : rawArgv;

const FLAGS_WITH_VALUE = new Set(['dir', 'title']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (FLAGS_WITH_VALUE.has(a.slice(2))) i++;
    continue;
  }
  positional.push(a);
}
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  const v = argv[i + 1];
  return i >= 0 && v && !v.startsWith('--') ? v : dflt;
};
const has = (name) => argv.includes('--' + name);

const CONTENT_DIR = path.resolve(opt('dir', process.cwd()));
const sessionArg = positional[0];

if (!sessionArg) {
  console.error('\n  Usage: presik new <session> [--title "S02 — Name"] [--questions-only] [--dir <path>]\n');
  console.error('  Example: presik new s02');
  console.error('           presik new web-dev/s02 --title "S02 — Status codes"\n');
  process.exit(1);
}

const SESSION_DIR = path.resolve(CONTENT_DIR, sessionArg);
if (SESSION_DIR !== CONTENT_DIR && !SESSION_DIR.startsWith(CONTENT_DIR + path.sep)) {
  console.error('\n  Session must be inside the content root (' + CONTENT_DIR + ').\n');
  process.exit(1);
}

const sessionName = path.relative(CONTENT_DIR, SESSION_DIR).split(path.sep).join('/') || path.basename(CONTENT_DIR) || 'session';
const title = opt('title', 'S00 — ' + sessionName);
const withDeck = !has('questions-only');

const QUESTIONS_FILE = path.join(SESSION_DIR, 'questions.json');
const DECK_FILE = path.join(SESSION_DIR, 'deck.marp.md');

const targets = [QUESTIONS_FILE, ...(withDeck ? [DECK_FILE] : [])];
const already = targets.filter(fs.existsSync);
if (already.length) {
  console.error('\n  Already exists, not overwriting:');
  already.forEach((f) => console.error('    ' + path.relative(CONTENT_DIR, f)));
  console.error('\n  Pick a different session path, or remove the file(s) above first.\n');
  process.exit(1);
}

fs.mkdirSync(SESSION_DIR, { recursive: true });

const questionsTpl = readAssetText('templates/questions.example.json').split('S00 — Class name').join(title);
fs.writeFileSync(QUESTIONS_FILE, questionsTpl);
console.log('  created ' + path.relative(CONTENT_DIR, QUESTIONS_FILE));

if (withDeck) {
  const deckTpl = readAssetText('templates/deck.example.marp.md').split('S00 — Class name').join(title);
  fs.writeFileSync(DECK_FILE, deckTpl);
  console.log('  created ' + path.relative(CONTENT_DIR, DECK_FILE));
}

console.log('\n  Next: edit the question text, then run: presik ' + sessionName + '\n');
