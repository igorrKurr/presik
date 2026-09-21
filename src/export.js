#!/usr/bin/env node
// =====================================================================
//  presik export <session> — the session's Marp deck as a PDF, for handouts,
//  uploading to an LMS, or presenting without presik.
//
//    presik export s01                     → s01/deck.marp.pdf — your slides only
//    presik export s01 --with-quiz         → s01/deck.marp.quiz.pdf — plus a static
//                                            question + answer slide per question
//    presik export s01 --out handout.pdf   → pick the file
//    presik export s01 --open              → open it when it's written
//    presik export s01 --dir ~/courses/x   → content root isn't the cwd
//
// Quiz slides are left out by default: a PDF has no server to make them live,
// and a handout usually shouldn't give the answers away. --with-quiz renders
// them statically (staticQuizSlides in lib.js) — never the teacher-only hint.
// Rendering is marp-cli's own --pdf (headless Chrome/Edge/Firefox), so the
// PDF matches what /slides shows.
// =====================================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseArgs, toSessionName, normalizeQuiz, exportMarpMarkdown } = require('./lib');
const { MARP_JS } = require('./marp');
const { findChrome, openFile } = require('./report-export');

const rawArgv = process.argv.slice(2);
const argv = rawArgv[0] === 'export' ? rawArgv.slice(1) : rawArgv;
const { positional, opt, has } = parseArgs(argv, ['dir', 'out']);

const CONTENT_DIR = path.resolve(opt('dir', process.cwd()));
const WITH_QUIZ = has('with-quiz');
const rel = (p) => {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith('..') ? r : p;
};
function die(msg) {
  console.error('\n  ' + msg + '\n');
  process.exit(1);
}

const sessionArg = positional[0] || '.';
const SESSION_DIR = path.resolve(CONTENT_DIR, sessionArg);
if (SESSION_DIR !== CONTENT_DIR && !SESSION_DIR.startsWith(CONTENT_DIR + path.sep))
  die('Session must be inside the content root (' + CONTENT_DIR + ').');

const DECK_FILE = path.join(SESSION_DIR, 'deck.marp.md');
if (!fs.existsSync(DECK_FILE)) {
  // Say what to do for the deck the session does have, rather than just "no Marp deck".
  const other = ['deck.pdf', 'deck.pptx', 'deck.key'].find((f) => fs.existsSync(path.join(SESSION_DIR, f)));
  if (other === 'deck.pdf') die(rel(path.join(SESSION_DIR, other)) + ' is already a PDF — nothing to export.');
  if (other) die('`presik export` works on Marp decks. ' + rel(path.join(SESSION_DIR, other)) + ' is converted to PDF\n  whenever the session runs — the copy is in .presik/cache/ — or use File → Export in its app.');
  die('No deck.marp.md in ' + rel(SESSION_DIR) + '\n  Usage: presik export <session> [--with-quiz] [--out <file.pdf>] [--open] [--dir <path>]');
}
if (!MARP_JS)
  die('Exporting needs Marp, which this install doesn\'t have (the single-file binary ships without it).\n' +
    '  Install presik from npm (`npm i -g presik`), or run it with `npx presik export …`.');

const OUT = path.resolve(opt('out', path.join(SESSION_DIR, WITH_QUIZ ? 'deck.marp.quiz.pdf' : 'deck.marp.pdf')));

// Build from a derived copy of the deck: quiz slides removed, or (--with-quiz)
// rendered statically — see exportMarpMarkdown in lib.js. It sits beside the
// deck so relative image paths resolve, and is removed afterwards.
const EXPORT_BUILD = path.join(SESSION_DIR, '.deck.export.md');
const qFile = path.join(SESSION_DIR, 'questions.json');
let questions = [];
if (WITH_QUIZ && !fs.existsSync(qFile)) die('--with-quiz needs ' + rel(qFile) + ', which doesn\'t exist.');
if (fs.existsSync(qFile)) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(qFile, 'utf8'));
  } catch (e) {
    die('Error in JSON (' + rel(qFile) + '):\n  ' + e.message);
  }
  const sessionPath = toSessionName(CONTENT_DIR, SESSION_DIR);
  const { quiz, errors } = normalizeQuiz(raw, sessionPath === '.' ? path.basename(CONTENT_DIR) : sessionPath);
  // Without --with-quiz the questions only matter for knowing what to strip, so
  // a quiz that wouldn't launch shouldn't block exporting the slides.
  if (errors.length && WITH_QUIZ) die(errors.join('\n  '));
  questions = quiz.questions;
}
fs.writeFileSync(EXPORT_BUILD, exportMarpMarkdown(fs.readFileSync(DECK_FILE, 'utf8'), questions, WITH_QUIZ));

// Marp finds Chrome/Edge/Firefox on its own; point it at the browser presik's
// report export would use too, so a Brave-only machine (say) works for both.
const env = { ...process.env };
if (!env.CHROME_PATH) {
  const chrome = findChrome();
  if (chrome) env.CHROME_PATH = chrome;
}

console.log('\n  Exporting ' + rel(DECK_FILE) + (WITH_QUIZ ? ' with quiz slides' : '') + ' …');
// --no-stdin: otherwise marp-cli waits to read Markdown from stdin whenever it
// isn't a terminal (a script, CI, an editor task) and the export just hangs.
const marpArgs = [MARP_JS, EXPORT_BUILD, '--pdf', '--html', '--allow-local-files', '--no-stdin', '-o', OUT];
let ok = true;
try {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync(process.execPath, marpArgs, { stdio: ['ignore', 'inherit', 'inherit'], env });
} catch (_) {
  ok = false;
} finally {
  fs.rmSync(EXPORT_BUILD, { force: true }); // before any exit — process.exit would skip it
}
if (!ok)
  die('Marp couldn\'t render the PDF (its message is above). It needs Chrome, Edge or Firefox installed —\n' +
    '  set CHROME_PATH to the browser binary if it\'s somewhere unusual.');
console.log('\n  PDF written: ' + rel(OUT) + '\n');
if (has('open')) openFile(OUT);
