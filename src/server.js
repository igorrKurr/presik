#!/usr/bin/env node
// =====================================================================
//  presik
//  Live in-class quizzes, embedded directly into Marp slides.
// =====================================================================
/**
 * The engine and the content (slides/questions) are separate: this file and
 * public/ live in the package, content lives anywhere on disk (typically
 * wherever the command is run from). Content format — see CONVENTIONS.md.
 *
 *   presik new s02                → scaffolds ./s02/ from templates/ (see scaffold.js)
 *   presik                        → lists all sessions under the current directory
 *   presik s01                    → runs ./s01/ (deck.marp.md + questions.json)
 *   presik web-dev/s01            → a session can live at any depth — it's just a path
 *   presik s01 --dir ~/courses/x  → content root isn't where the command was run from
 *   presik s01 --tunnel           → brings up a public URL via cloudflared
 *   presik s01 --port 8080 --key myword
 *   presik s01 --group "3-A"      → tags results with a group name (or asks interactively)
 *   presik s01 --no-group         → don't ask for a group name
 *
 * The join QR for students is written to <session>/join-qr.svg (path
 * overridable via --qr) in case a slide links to it directly. The primary
 * join path is the <div data-quiz-join></div> marker embedded in the slides,
 * which pulls the QR straight from the server and doesn't need this file.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const QRCode = require('qrcode');
const { openDb } = require('./db');
const { groupSlug, sessionSlug, toSessionName, parseArgs, bestHostIp, rankHostIps, effectiveKind, validateAnswer, splitMarpSlides, deriveMarpMarkdown, normalizeQuiz, CONFIG_FILE } = require('./lib');
const { resolvePackage } = require('./widgets');
const { readAssetText } = require('./assets');
const { ensureDeckPdf } = require('./convert');
const { buildReport } = require('./report-data');
const { loadConfig } = require('./config');
const { readQuestions, saveQuestions, restoreQuestions, listHistory, readHistory } = require('./editor');

const VERSION = require('../package.json').version;

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const FLAGS_WITH_VALUE = new Set(['dir', 'port', 'key', 'qr', 'db', 'group', 'host']);
const { positional, opt, has } = parseArgs(argv, FLAGS_WITH_VALUE);

// --dir is resolved first and is the one setting a config file may not touch:
// it says where the content root is, and the content root is where sessions and
// presik.config.json are looked up. Everything else waits until we know which
// session is running — a session may carry its own config (see "settings" below).
const CONTENT_DIR = path.resolve(opt('dir', process.cwd()));
const DATA_DIR = path.join(CONTENT_DIR, '.presik');
const OPEN_EDITOR = has('edit'); // `presik edit <session>` — bin/cli.js rewrites the subcommand to this flag

// ---------------------------------------------------------------- content sessions
// A session is any directory that has deck.marp.md and/or questions.json in
// it. Its "name" is its path relative to the content root (POSIX-style), so
// the exact same code works whether it's a single deck at the root, a course
// with many sessions, or a root holding several courses — it's just a
// different path depth.
const SKIP_DIRS = new Set(['node_modules', '.git', '.presik', 'public', 'templates', 'widgets']);

function findSessionDirs(root, depth = 4) {
  const out = [];
  (function walk(dir, level) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    const hasQuestions = entries.some((e) => e.isFile() && e.name === 'questions.json');
    const hasDeck = entries.some((e) => e.isFile() && e.name === 'deck.marp.md');
    if (hasQuestions || hasDeck) out.push(dir);
    if (level >= depth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), level + 1);
    }
  })(root, 0);
  return out.sort();
}

let sessionArg = positional[0];

if (!sessionArg) {
  const dirs = findSessionDirs(CONTENT_DIR);
  if (dirs.length === 1 && dirs[0] === CONTENT_DIR) {
    // the only session is the content root itself ("single deck" mode) —
    // no point asking for a path, just run it.
    sessionArg = '.';
  } else {
    console.log('\n  Content root: ' + CONTENT_DIR);
    console.log('  Available sessions:\n');
    if (!dirs.length) {
      console.log('    (none — needs a directory with deck.marp.md and/or questions.json)');
    }
    dirs.forEach((d) => {
      const n = toSessionName(CONTENT_DIR, d);
      let t = '';
      try {
        t = JSON.parse(fs.readFileSync(path.join(d, 'questions.json'), 'utf8')).title || '';
      } catch (_) {}
      console.log('    presik ' + n.padEnd(16) + '  ' + t);
    });
    console.log('');
    process.exit(0);
  }
}

const SESSION_DIR = path.resolve(CONTENT_DIR, sessionArg);
if (SESSION_DIR !== CONTENT_DIR && !SESSION_DIR.startsWith(CONTENT_DIR + path.sep)) {
  console.error('\n  Session must be inside the content root (' + CONTENT_DIR + ').\n');
  process.exit(1);
}
const sessionPath = toSessionName(CONTENT_DIR, SESSION_DIR);
// "." (the content root itself is the session — single-deck mode) reads
// better as the folder's name than as a literal dot in labels/filenames.
const name = sessionPath === '.' ? path.basename(CONTENT_DIR) || 'session' : sessionPath;
const course = path.dirname(sessionPath) === '.' ? null : path.dirname(sessionPath);

// ---------------------------------------------------------------- settings
// Anything you didn't type can come from presik.config.json — the project's, at
// the content root, and the session's own, if it has one. A flag always wins, so
// the command line never lies about what it's doing. See config.js.
const { config: CONFIG, files: CONFIG_FILES, errors: CONFIG_ERRORS } = loadConfig(CONTENT_DIR, SESSION_DIR);
if (CONFIG_ERRORS.length) {
  console.error('\n  Problem with ' + CONFIG_FILE + ':\n');
  CONFIG_ERRORS.forEach((e) => console.error('    ' + e));
  console.error('');
  process.exit(1);
}
// Flag values are strings (they came off a command line); config values already
// carry their JSON type.
const setting = (nm, dflt) => {
  const v = opt(nm, null);
  if (v != null) return v;
  return CONFIG[nm] != null ? CONFIG[nm] : dflt;
};
// A path typed as a flag is relative to where you typed it; a path from a config
// file was already resolved against that file's own directory (config.js).
const cliPath = (nm) => (opt(nm, null) ? path.resolve(opt(nm, null)) : null);

const PORT = parseInt(setting('port', 3000), 10);
const HOST_OVERRIDE = setting('host', null); // advertised LAN address (skip auto-detect)
// The teacher key controls the whole quiz (next/reveal/reset). "teach" used to
// be the default — but the project is public, so a known default means anyone
// on the network can hijack a class. Default is now random per run; --key (or
// "key" in a config file) still lets you pin a memorable one on purpose.
const KEY_GIVEN = setting('key', null);
const KEY = KEY_GIVEN || crypto.randomBytes(4).toString('hex');
const TUNNEL = has('tunnel') || CONFIG.tunnel === true;
const NO_GROUP = has('no-group') || CONFIG.noGroup === true;
// Only trust X-Forwarded-For when we're actually behind the cloudflared tunnel
// (all students then share Cloudflare's edge IP, so the real client IP is in
// the header). On a plain LAN we ignore it — otherwise a cheater could spoof
// the header to dodge the per-IP answer limits below.
const TRUST_PROXY = TUNNEL;
const DB_FILE = cliPath('db') || CONFIG.db || path.join(DATA_DIR, 'data.db');
let GROUP = setting('group', null);

const QUESTIONS_FILE = path.join(SESSION_DIR, 'questions.json');
const DECK_FILE = path.join(SESSION_DIR, 'deck.marp.md');
const DECK_HTML = path.join(SESSION_DIR, 'deck.marp.html');
const DECK_BUILD = path.join(SESSION_DIR, '.deck.build.md'); // derived deck with auto-inserted quiz markers (kept beside the deck so relative assets resolve)
const DECK_PDF = path.join(SESSION_DIR, 'deck.pdf');
const DECK_PPTX = path.join(SESSION_DIR, 'deck.pptx');
const DECK_KEY = path.join(SESSION_DIR, 'deck.key');
const QR_FILE = cliPath('qr') || CONFIG.qr || path.join(SESSION_DIR, 'join-qr.svg');

// Load and validate questions.json up front, not in the middle of class. The
// two runs differ in how forgiving they are:
//   • a normal run needs a clean quiz — missing, unparseable, or invalid stops
//     the launch, because there'd be nothing (or something broken) to run;
//   • `presik edit` never dies for a questions.json reason. Whatever's wrong —
//     no file yet, bad JSON, a duplicate id — the editor opens so you can fix
//     it (it reads the file's real state itself, via /api/edit/state) or write
//     the first one. Until then the server runs on an empty in-memory quiz.
// Problems print to the terminal either way; only a normal run treats them as
// fatal. `fail` is the single exit path, so the two modes can't drift.
const QUESTIONS_EXISTS = fs.existsSync(QUESTIONS_FILE);
const fail = (msg) => {
  if (OPEN_EDITOR) return void console.error('  Note: ' + msg + ' — opening the editor to fix it.');
  console.error('\n  ' + msg + '\n');
  process.exit(1);
};

let quiz = null;
if (!QUESTIONS_EXISTS) {
  fail(
    'Missing ' + path.relative(CONTENT_DIR, QUESTIONS_FILE) + '\n\n' +
      '  Every session is a directory with questions.json (and, optionally, deck.marp.md).\n' +
      '  Example — templates/questions.example.json, or start one in the browser with `presik edit`.'
  );
} else {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  } catch (e) {
    fail('Error in JSON (' + QUESTIONS_FILE + '):\n  ' + e.message);
  }
  if (raw != null) {
    // Same validator /edit runs before accepting a save (normalizeQuiz, in
    // lib.js) — so the editor can't write a file the server then refuses to
    // start on, and startup can't reject one the editor would happily open.
    const { quiz: normalized, errors, warnings } = normalizeQuiz(raw, name);
    warnings.forEach((w) => console.error('  Note: ' + w));
    if (errors.length) fail(errors.join('\n  '));
    else quiz = normalized;
  }
}
// Editor run with nothing usable yet: start empty. The first save creates (or
// repairs) the file; /api/edit/state, read fresh, still shows what's on disk.
if (!quiz) quiz = { title: name, questions: [] };

// Widget packages are vendored (offline-first) under <content-root>/widgets/.
// Resolve every widget.package once so serving is a map lookup, not a disk walk
// per broadcast. A missing package is fatal at startup (fail fast, like a bad
// questions.json) but only a note on hot-reload — a typo mid-class mustn't kill
// a running session.
const WIDGETS_DIR = path.join(CONTENT_DIR, 'widgets');
const pkgResolved = {}; // qid -> { dirName, entry, manifest }
function resolveWidgetPackages(fatal) {
  for (const q of quiz.questions) {
    if (q.type !== 'widget' || !q.widget || q.widget.package == null) continue;
    const r = resolvePackage(WIDGETS_DIR, q.widget.package);
    if (r) { pkgResolved[q.id] = r; continue; }
    delete pkgResolved[q.id];
    const msg = 'Question ' + q.id + ': widget package "' + q.widget.package + '" not found in ' +
      path.relative(CONTENT_DIR, WIDGETS_DIR) + '\n  Vendor it with:  presik widget add <path-to-built-dist>';
    if (fatal) fail(msg); else console.error('  Note: ' + msg);
  }
}
resolveWidgetPackages(true);

// Cross-origin isolation (SharedArrayBuffer / wasm threads for a heavy engine) is
// a page-wide property: the student page opts in with COOP+COEP, embedded widget
// docs assert COEP, and their assets carry CORP. We only send those headers when
// the session actually has an isolate widget, so ordinary sessions keep the lax,
// maximally-compatible headers. A widget is isolate if its descriptor says so or
// its resolved package manifest does.
let SESSION_ISOLATE = false;
function widgetIsolate(q) {
  if (q.type !== 'widget' || !q.widget) return false;
  if (q.widget.isolate) return true;
  const r = pkgResolved[q.id];
  return !!(r && r.manifest && r.manifest.isolate);
}
function computeIsolation() { SESSION_ISOLATE = quiz.questions.some(widgetIsolate); }
computeIsolation();
const COOP_COEP = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

// ---------------------------------------------------------------- slides (Marp)
// Slides are the source of truth in deck.marp.md; deck.marp.html is a build
// artifact the server rebuilds itself whenever the .md is newer than the
// .html (or the .html doesn't exist yet).
// Run marp-cli's JS entry through the current node binary rather than the
// node_modules/.bin/marp shim: the shim is a shell script on macOS/Linux and
// a .cmd on Windows, and execFileSync on the extensionless name can't launch
// the .cmd — so the old approach silently broke slide builds on Windows.
// Resolve it rather than joining a path under the engine root: when presik is
// installed as a dependency, npm HOISTS marp-cli to the consumer's top-level
// node_modules, so <engine>/node_modules/@marp-team/… doesn't exist and the old
// existsSync check reported "no Marp" on a perfectly good install.
// require.resolve walks the whole node_modules chain, so it finds Marp whether
// it's hoisted, nested, or installed globally alongside presik.
let MARP_JS = null;
try {
  MARP_JS = require.resolve('@marp-team/marp-cli/marp-cli.js');
} catch (_) {}
// Marp is an optionalDependency: a normal install gets it and /slides works,
// but it's absent from the packaged single-file binary and from an install run
// with --omit=optional. Slide-building degrades gracefully in that case:
// everything else — phones, /host, /present, PDF decks — works, and /slides
// explains how to get Marp support.
const MARP_AVAILABLE = MARP_JS !== null;
// A session's deck is Marp markdown or a PDF (later: pptx/key converted to a
// PDF under the hood). Marp wins if both are present. Either way presik owns
// navigation on /slides, so slides and quiz stay in lockstep.
// Precedence: Marp markdown, then a PDF — given directly (deck.pdf) or
// converted under the hood from PowerPoint/Keynote (deck.pptx / deck.key).
const convertSrc = fs.existsSync(DECK_PDF) ? null : [DECK_PPTX, DECK_KEY].find((f) => fs.existsSync(f));
const deckType = fs.existsSync(DECK_FILE) ? 'marp' : (fs.existsSync(DECK_PDF) || convertSrc ? 'pdf' : null);
const CACHE_PDF = path.join(DATA_DIR, 'cache', sessionSlug(name) + '.pdf'); // converted decks land here
let pdfServePath = fs.existsSync(DECK_PDF) ? DECK_PDF : null; // resolved after conversion for convertibles
let deckError = null; // conversion failure message, surfaced on /slides
if (deckType === 'marp') {
  try {
    const count = splitMarpSlides(fs.readFileSync(DECK_FILE, 'utf8')).slides.length;
    quiz.questions.forEach((q) => {
      if (q.slide && q.slide > count)
        console.error('  Note: question ' + q.id + ' is placed on slide ' + q.slide + ', but the deck has ' + count + ' slides — it will appear at the end.');
    });
  } catch (_) {}
}

// Injects a link to embed.js/css plus a marker where the server will splice
// in the live config on EVERY /slides request (not here, because here we
// don't know if the request came with ?key=, and that determines whether the
// slides can be controlled by arrow keys). Gets reinjected on every rebuild,
// since marp rewrites the .marp.html from scratch each time.
const QUIZ_CONFIG_MARKER = '<!--PRESIK_CONFIG-->';
function injectQuizEmbed(htmlPath) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const snippet = QUIZ_CONFIG_MARKER + '\n<link rel="stylesheet" href="/embed.css">\n<script src="/embed.js"></script>\n';
  html = html.includes('</body>') ? html.replace('</body>', snippet + '</body>') : html + snippet;
  fs.writeFileSync(htmlPath, html);
}

// Questions without "correct" — what's safe to show on slides BEFORE reveal
// (the text/options are already on the slide anyway; correctness is separate,
// comes from /api/stream, and only after revealed).
// What the phone needs to render a widget: the answer contract it borrows and
// how to load its front-end. An inline `srcdoc` game travels as-is; a `src`
// bundle becomes a URL served (sandboxed) from the session folder. Never leaks
// `config` secrets? config is author content shown to the student anyway. The
// options' `correct` flags are NOT here — correctness ships only via /api/stream
// at reveal, same as every other type.
function widgetPublic(q) {
  if (q.type !== 'widget') return undefined;
  const w = q.widget || {};
  const out = { height: w.height || null, config: w.config || null, isolate: !!w.isolate };
  // Every source collapses to what the phone actually needs: inline HTML, or a
  // URL to load in the sandboxed iframe. A local bundle is served from the
  // session folder; url/dev point straight at a remote origin (still sandboxed
  // to a null origin, so it only talks to the quiz over postMessage).
  if (w.srcdoc != null) out.srcdoc = w.srcdoc;
  else if (w.src != null) out.src = '/widget/' + w.src.split('/').map(encodeURIComponent).join('/');
  else if (w.url != null) out.src = w.url;
  else if (w.dev != null) out.src = w.dev;
  else if (w.package != null) {
    const r = pkgResolved[q.id];
    if (r) {
      const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
      out.src = '/widgetpkg/' + enc(r.dirName) + '/' + enc(r.entry);
      // The manifest supplies defaults the quiz didn't set — height and the
      // engine's cross-origin-isolation need. The quiz always wins when it does.
      if (out.height == null && Number.isInteger(r.manifest.height)) out.height = r.manifest.height;
      if (!out.isolate && r.manifest.isolate) out.isolate = true;
    } else {
      out.error = 'Widget package "' + w.package + '" is not installed — run: presik widget add <dist>';
    }
  }
  return out;
}

const STATIC_TYPES = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  // A widget bundle can be a whole WebGL/engine build. `.wasm` MUST be served as
  // application/wasm or the browser refuses to streaming-compile it; the rest are
  // the common 3D/engine asset extensions, so they arrive typed, not as a download.
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream', '.data': 'application/octet-stream',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};
// Serve one file resolved strictly inside `root` — the ".." guard is what keeps
// /slides/, /widget/ and /widgetpkg/ from climbing out into the rest of the disk.
function serveFileFrom(res, root, encodedRel) {
  const rel = decodeURIComponent(encodedRel);
  const filePath = path.join(root, rel);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const type = STATIC_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // A widget runs in a null-origin sandbox, so it fetches its own assets/wasm
    // cross-origin — allow that (these are public bundle files, no credentials).
    // CORP lets them load under a cross-origin-isolated page; when the session is
    // isolated the entry doc also asserts COEP so the iframe can be isolated too.
    const extra = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (SESSION_ISOLATE) extra['Cross-Origin-Embedder-Policy'] = 'require-corp';
    return send(res, 200, type, fs.readFileSync(filePath), extra);
  }
  return send(res, 404, 'text/plain; charset=utf-8', 'not found');
}
const serveSessionFile = (res, encodedRel) => serveFileFrom(res, SESSION_DIR, encodedRel);

function quizConfig(isHost) {
  return {
    session: name,
    group: GROUP || null,
    isHost,
    key: isHost ? KEY : null,
    questions: quiz.questions.map((q) => ({
      id: q.id,
      text: q.text,
      note: q.note || null,
      type: q.type,
      answer: q.type === 'widget' ? effectiveKind(q) : undefined,
      options: (q.options || []).map((o) => ({ id: o.id, text: o.text })),
      min: q.min,
      max: q.max,
      slide: q.slide || null,
    })),
  };
}

function ensureSlideHtml() {
  // Placement comes from questions.json ("slide": N), so a change there — not
  // just the deck — means a rebuild. When any question is placed, build a
  // derived deck with the quiz markers auto-inserted; otherwise build as-is.
  const needsDerive = quiz.questions.some((q) => q.slide);
  // A brand-new session (presik edit) may not have questions.json on disk yet;
  // its mtime only matters when a question is placed on a slide, which can't
  // happen with none. A missing file just means "no placement input" — statting
  // it unconditionally would throw ENOENT and break /slides for a deck-only run.
  const qMtime = fs.existsSync(QUESTIONS_FILE) ? fs.statSync(QUESTIONS_FILE).mtimeMs : 0;
  const srcMtime = Math.max(fs.statSync(DECK_FILE).mtimeMs, qMtime);
  const stale = !fs.existsSync(DECK_HTML) || srcMtime > fs.statSync(DECK_HTML).mtimeMs;
  if (stale) {
    let buildSrc = DECK_FILE;
    if (needsDerive) {
      fs.writeFileSync(DECK_BUILD, deriveMarpMarkdown(fs.readFileSync(DECK_FILE, 'utf8'), quiz.questions));
      buildSrc = DECK_BUILD;
    }
    execFileSync(process.execPath, [MARP_JS, buildSrc, '-o', DECK_HTML, '--html', '--allow-local-files'], { stdio: 'inherit' });
    injectQuizEmbed(DECK_HTML);
    console.log('  Slides built: ' + path.relative(CONTENT_DIR, DECK_HTML));
  }
  return DECK_HTML;
}

// ---------------------------------------------------------------- state
// autoReveal is an opt-in, per-run teacher preference (toggled from /host):
// when on, a question reveals itself once every connected student has answered.
const state = { index: -1, revealed: false, autoReveal: false };
const answers = new Map(); // qid -> Map(clientId -> value)
const students = new Set();
const streams = new Set();
let joinUrl = '';
let qrSvg = '';

// Casual ballot-stuffing guard. clientId is browser-generated, so it isn't a
// real identity — but capping distinct clientIds and answer rate per source IP
// stops the trivial "loop and POST 500 random ids" attack that would otherwise
// wreck the distribution and the archive. Not tamper-proof; it keeps an honest
// room honest. Per-IP is meaningful because each phone on the LAN has its own
// address; under --tunnel we key off the real client IP.
// On a plain LAN every phone has its own address, so a tight per-IP cap is a
// real per-student guard against the "loop and POST 500 ids" attack. Behind the
// tunnel that reasoning inverts: Cloudflare's edge — and usually a single campus
// NAT behind it — puts the whole class on ONE source IP, so LAN-tight numbers
// would lock every student past the 12th out of their own quiz and throttle the
// rest to one shared bucket. Size the caps for a lecture hall there; the guard
// is looser (as anything past the tunnel always is), but a trivial flood still
// trips it.
const MAX_CLIENTS_PER_IP = TRUST_PROXY ? 1000 : 12;
const RATE_BURST = TRUST_PROXY ? 300 : 8; // answers per burst
const RATE_REFILL_MS = TRUST_PROXY ? 50 : 400; // one token back this often (LAN ~2.5/s)
const IDLE_IP_MS = 30 * 60 * 1000; // forget a source IP after this long with no answers
const clientsByIp = new Map(); // ip -> Set(clientId)
const rateByIp = new Map(); // ip -> { tokens, ts }

function clientIp(req) {
  if (TRUST_PROXY) {
    // Cloudflare sets CF-Connecting-IP at its edge, so it's the one client
    // address a student can't forge. X-Forwarded-For is appended to, so its
    // *leftmost* entry is whatever the client sent — worthless for a per-IP cap
    // (a cheater would just rotate it). Prefer CF's header; only fall back to
    // XFF's edge-added rightmost entry.
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',').pop().trim();
  }
  return req.socket.remoteAddress || 'local';
}
// Drop per-IP bookkeeping for addresses that have gone quiet, so a long-lived
// server (especially under --tunnel, where every source IP is distinct) doesn't
// accumulate a map entry per address it ever saw. Cheap: runs on each answer.
function forgetIdleIps() {
  const cutoff = Date.now() - IDLE_IP_MS;
  for (const [ip, b] of rateByIp) if (b.ts < cutoff) { rateByIp.delete(ip); clientsByIp.delete(ip); }
}
function rateOk(ip) {
  const now = Date.now();
  let b = rateByIp.get(ip);
  if (!b) { b = { tokens: RATE_BURST, ts: now }; rateByIp.set(ip, b); }
  b.tokens = Math.min(RATE_BURST, b.tokens + (now - b.ts) / RATE_REFILL_MS);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
function clientAllowed(ip, cid) {
  let set = clientsByIp.get(ip);
  if (!set) { set = new Set(); clientsByIp.set(ip, set); }
  if (!set.has(cid) && set.size >= MAX_CLIENTS_PER_IP) return false;
  set.add(cid);
  return true;
}

// ---------------------------------------------------------------- sqlite
// One file for the whole content root — all courses, sessions, and groups.
// This is both the long-term archive (report.js) and the crash/sleep recovery
// store: on restart we resume the most recent unfinished run for this exact
// session+group and rehydrate the live state from it.
const db = openDb(DB_FILE);
let runId = null;

// A run is "resumable" if it's the same session+group, was never cleanly ended
// (ended_at IS NULL — crash, laptop sleep, kill -9), and started recently — so
// "restart the server mid-class" just picks up where it left off, without
// accidentally reattaching to last week's class of the same name.
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h
function findResumableRun() {
  const cutoff = new Date(Date.now() - RESUME_WINDOW_MS).toISOString();
  return db
    .prepare(
      `SELECT * FROM runs WHERE session = ? AND ifnull(group_name,'') = ifnull(?, '')
       AND ended_at IS NULL AND started_at >= ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(name, GROUP || null, cutoff);
}
function rehydrate(run) {
  runId = run.id;
  state.index = run.cur_index == null ? -1 : run.cur_index;
  state.revealed = !!run.revealed;
  const rows = db.prepare('SELECT qid, client_id, value FROM answers WHERE run_id = ?').all(runId);
  for (const r of rows) {
    if (!answers.has(r.qid)) answers.set(r.qid, new Map());
    answers.get(r.qid).set(r.client_id, r.value);
  }
  return rows.length;
}
function startRun() {
  const prior = findResumableRun();
  if (prior) {
    const n = rehydrate(prior);
    console.log('  Resumed run #' + runId + ' — ' + n + ' answers, at question ' + (state.index + 1) + '.');
    return;
  }
  const info = db
    .prepare('INSERT INTO runs (course, session, group_name, title, started_at, cur_index, revealed) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(course, name, GROUP || null, quiz.title || name, new Date().toISOString(), -1, 0);
  runId = info.lastInsertRowid;
}
function persistLiveState() {
  if (!runId) return;
  try {
    db.prepare('UPDATE runs SET cur_index = ?, revealed = ? WHERE id = ?').run(state.index, state.revealed ? 1 : 0, runId);
  } catch (_) {}
}

// Opt-in: reveal a question the moment every connected student has answered it,
// so the teacher gets one tap per question instead of two. Off unless toggled.
function maybeAutoReveal() {
  if (!state.autoReveal || state.revealed) return;
  const q = cur();
  if (!q) return;
  const answered = (answers.get(q.id) || new Map()).size;
  if (students.size > 0 && answered >= students.size) {
    state.revealed = true;
    persistLiveState();
  }
}

const upsertAnswerStmt = db.prepare(`
  INSERT INTO answers (run_id, course, session, group_name, qid, question_text, question_type, client_id, value, is_correct, answered_at)
  VALUES (@runId, @course, @session, @group, @qid, @qtext, @qtype, @clientId, @value, @isCorrect, @ts)
  ON CONFLICT(run_id, qid, client_id) DO UPDATE SET
    value = excluded.value, is_correct = excluded.is_correct, answered_at = excluded.answered_at
`);

function persistAnswer(q, clientId, value) {
  if (!runId) return;
  const kind = effectiveKind(q);
  let isCorrect = null;
  if (kind === 'choice') {
    const correctIds = (q.options || []).filter((o) => o.correct).map((o) => o.id);
    isCorrect = correctIds.includes(value) ? 1 : 0;
  }
  upsertAnswerStmt.run({
    runId,
    course,
    session: name,
    group: GROUP || null,
    qid: q.id,
    qtext: q.text,
    // Store the effective kind, not "widget": the archive is about the answer,
    // so report.js aggregates a choice-widget as choice with zero widget-awareness.
    qtype: kind,
    clientId,
    value,
    isCorrect,
    ts: new Date().toISOString(),
  });
}

const cur = () => (state.index >= 0 ? quiz.questions[state.index] : null);

function questionFor(isHost) {
  const q = cur();
  if (!q) return null;
  const out = {
    id: q.id,
    type: q.type,
    answer: q.type === 'widget' ? effectiveKind(q) : undefined,
    widget: widgetPublic(q),
    text: q.text,
    note: q.note || null,
    options: (q.options || []).map((o) => ({ id: o.id, text: o.text })),
    min: q.min,
    max: q.max,
  };
  const reveal = isHost || state.revealed;
  if (reveal) out.correct = (q.options || []).filter((o) => o.correct).map((o) => o.id);
  if (isHost) out.hint = q.hint || null;
  if (state.revealed) out.explain = q.explain || null;
  return out;
}

function stats(isHost) {
  const q = cur();
  if (!q) return null;
  const kind = effectiveKind(q); // a widget aggregates as the primitive kind it declares
  const given = answers.get(q.id) || new Map();
  const base = { answered: given.size, connected: students.size };
  if (!isHost && !state.revealed) return base; // students don't see the distribution before reveal
  if (kind === 'text') return { ...base, texts: [...given.values()].slice(0, 80) };
  if (kind === 'scale') {
    const counts = {};
    for (let i = q.min; i <= q.max; i++) counts[i] = 0;
    for (const v of given.values()) if (counts[v] !== undefined) counts[v]++;
    const nums = [...given.values()].map(Number).filter((n) => !isNaN(n));
    const avg = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : null;
    return { ...base, counts, avg };
  }
  const counts = {};
  (q.options || []).forEach((o) => (counts[o.id] = 0));
  for (const v of given.values()) if (counts[v] !== undefined) counts[v]++;
  return { ...base, counts };
}

const snapshot = (isHost) =>
  JSON.stringify({
    version: VERSION,
    title: quiz.title || name,
    group: GROUP || null,
    index: state.index,
    total: quiz.questions.length,
    revealed: state.revealed,
    autoReveal: state.autoReveal,
    question: questionFor(isHost),
    stats: stats(isHost),
    joinUrl,
  });

// The snapshot only has two shapes — host and guest — so serialize each at
// most once per broadcast and reuse it, instead of re-stringifying (and
// recomputing stats) for every connection. With N students that turns the
// per-answer cost from O(N) serializations into O(1); the writes stay O(N).
function broadcast() {
  let hostMsg = null;
  let guestMsg = null;
  for (const s of streams) {
    try {
      if (s.host) {
        if (hostMsg === null) hostMsg = 'data: ' + snapshot(true) + '\n\n';
        s.res.write(hostMsg);
      } else {
        if (guestMsg === null) guestMsg = 'data: ' + snapshot(false) + '\n\n';
        s.res.write(guestMsg);
      }
    } catch (_) {}
  }
}

// An edit from /edit lands here: swap the in-memory quiz without dropping the
// class on the floor. Answers live in a Map keyed by question id, so a question
// keeps its answers for as long as it keeps its id — which is exactly why the
// editor writes ids out explicitly (see editor.js) instead of leaning on
// position, which reordering would change underneath them.
function reloadQuiz(doc) {
  const wasOn = cur() ? cur().id : null;
  quiz = doc;
  resolveWidgetPackages(false); // a newly-referenced package may need resolving; missing ones just warn
  computeIsolation();           // an edit may add or drop the session's need for cross-origin isolation
  const live = new Set(quiz.questions.map((q) => q.id));
  for (const qid of [...answers.keys()]) if (!live.has(qid)) answers.delete(qid);
  // Stay on whatever question the class was looking at, wherever it just moved
  // to. Deleted out from under us (or never started) → fall back to idle rather
  // than to a dangling index.
  if (wasOn) state.index = quiz.questions.findIndex((q) => q.id === wasOn);
  else state.index = Math.min(state.index, quiz.questions.length - 1);
  if (state.index < 0) state.revealed = false;
  if (runId) {
    try {
      db.prepare('UPDATE runs SET title = ? WHERE id = ?').run(quiz.title || name, runId);
    } catch (_) {}
  }
  persistLiveState();
  broadcast(); // /host, /present and any open deck pick the edit up live
}

// What the editor needs to offer "after slide N" as a real choice. Marp is the
// source of truth in markdown, so it's countable here; a PDF's page count only
// exists once pdf.js has parsed it in the browser, so the editor asks the deck
// for that itself.
function deckSlideCount() {
  if (deckType !== 'marp') return null;
  try {
    return splitMarpSlides(fs.readFileSync(DECK_FILE, 'utf8')).slides.length;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- http
const send = (res, code, type, body, extra) => {
  res.writeHead(code, Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    // The teacher key rides in the URL (?key=); no-referrer stops it leaking to
    // any third party via the Referer header (e.g. images/CDNs in a slide).
    'Referrer-Policy': 'no-referrer',
  }, extra || {}));
  res.end(body);
};
// An answer is a few bytes; a whole questions.json is not. The cap stays tight
// for the student-facing routes and is raised explicitly for an editor save.
const readBody = (req, limit = 8000) =>
  new Promise((resolve) => {
    let b = '';
    // Destroying the request on an over-limit body means 'end' never fires, and
    // 'close'/'error' can arrive instead of a clean 'end' on a dropped socket —
    // so resolve on any terminal event. A settled Promise ignores later calls,
    // so the handler always continues (with {}) instead of awaiting forever.
    const done = () => {
      try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); }
    };
    req.on('data', (c) => {
      b += c;
      if (b.length > limit) { resolve({}); req.destroy(); }
    });
    req.on('end', done);
    req.on('close', () => resolve({}));
    req.on('error', () => resolve({}));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const isHost = url.searchParams.get('key') === KEY;

  // The student page opts into cross-origin isolation only when the session has
  // an isolate widget — otherwise COOP/COEP would needlessly constrain what an
  // ordinary widget (or future page resource) may load.
  if (p === '/') return send(res, 200, 'text/html; charset=utf-8', readAssetText('public/student.html'), SESSION_ISOLATE ? COOP_COEP : undefined);

  if (p === '/host') {
    if (!isHost) return send(res, 403, 'text/plain; charset=utf-8', 'Add ?key=...');
    return send(res, 200, 'text/html; charset=utf-8', readAssetText('public/host.html'));
  }

  // ---------------------------------------------------------------- report
  // The analytics report — the same DB report.js reads on the CLI, but as an
  // interactive, filterable web surface. It shows student answers, so it's
  // gated behind the teacher key exactly like /host and /edit. Its JSON model
  // (buildReport) is shared with the CLI so the two never drift.
  if (p === '/report' || p === '/report/') {
    if (!isHost) return send(res, 403, 'text/plain; charset=utf-8', 'Add ?key=... — the report is teacher-only.');
    return send(res, 200, 'text/html; charset=utf-8', readAssetText('public/report.html'));
  }
  if (p === '/report.css') return send(res, 200, 'text/css; charset=utf-8', readAssetText('public/report.css'));
  if (p === '/report.js') return send(res, 200, 'application/javascript; charset=utf-8', readAssetText('public/report.js'));
  if (p === '/api/report') {
    if (!isHost) return send(res, 403, 'application/json; charset=utf-8', '{"error":"forbidden"}');
    const model = buildReport(db, {
      course: url.searchParams.get('course') || null,
      session: url.searchParams.get('session') || null,
      group: url.searchParams.get('group') || null,
      contentDir: CONTENT_DIR,
    });
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(model));
  }

  // Stand-alone projector view for a questions-only session (no deck) — shows
  // the join QR, the answer counter, and the distribution after reveal. A
  // session with a deck uses /slides instead. View-only.
  if (p === '/present' || p === '/present/')
    return send(res, 200, 'text/html; charset=utf-8', readAssetText('public/present.html'));

  if (p === '/qr.svg') return send(res, 200, 'image/svg+xml', qrSvg);

  // Browsers auto-request /favicon.ico; answer quietly so it doesn't 404 on
  // every page (and clutter the console on the projector view).
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (p === '/embed.js') return send(res, 200, 'application/javascript; charset=utf-8', readAssetText('public/embed.js'));
  // CORP so a null-origin sandboxed widget can still load the SDK on a
  // cross-origin-isolated (COEP) student page.
  if (p === '/widget-sdk.js') return send(res, 200, 'application/javascript; charset=utf-8', readAssetText('packages/widget-sdk/index.js'), { 'Cross-Origin-Resource-Policy': 'cross-origin' });
  if (p === '/embed.css') return send(res, 200, 'text/css; charset=utf-8', readAssetText('public/embed.css'));

  // Self-hosted pdf.js (no CDN — works offline and inside a CSP).
  if (p === '/vendor/pdf.mjs') return send(res, 200, 'text/javascript; charset=utf-8', readAssetText('public/vendor/pdf.mjs'));
  if (p === '/vendor/pdf.worker.mjs') return send(res, 200, 'text/javascript; charset=utf-8', readAssetText('public/vendor/pdf.worker.mjs'));
  if (p === '/deck.pdf') {
    if (deckType !== 'pdf' || !pdfServePath) return send(res, 404, 'text/plain; charset=utf-8', deckError || 'no PDF deck');
    return send(res, 200, 'application/pdf', fs.readFileSync(pdfServePath));
  }

  if (p === '/slides' || p === '/slides/') {
    if (!deckType) return send(res, 404, 'text/plain; charset=utf-8', 'No deck (deck.marp.md or deck.pdf) for session "' + name + '"');
    // PDF deck: presik's own pdf.js viewer renders the pages and interleaves the
    // quiz steps, driven by the same /api/control as the Marp path.
    if (deckType === 'pdf') {
      if (!pdfServePath) return send(res, 501, 'text/plain; charset=utf-8', deckError || 'PDF deck not ready.');
      const cfg = quizConfig(isHost);
      cfg.pdf = '/deck.pdf';
      const html = readAssetText('public/deck.html').replace(QUIZ_CONFIG_MARKER, '<script>window.__PRESIK__=' + JSON.stringify(cfg) + ';</script>');
      return send(res, 200, 'text/html; charset=utf-8', html);
    }
    // Marp deck: build to HTML and inject the live config.
    if (!MARP_AVAILABLE)
      return send(res, 501, 'text/plain; charset=utf-8',
        'Marp slide-building isn\'t available in this build.\n' +
        'Use a PDF deck (deck.pdf) instead, or add Marp:  npm i @marp-team/marp-cli');
    try {
      const htmlPath = ensureSlideHtml();
      let html = fs.readFileSync(htmlPath, 'utf8');
      const cfgScript = '<script>window.__PRESIK__=' + JSON.stringify(quizConfig(isHost)) + ';</script>';
      html = html.replace(QUIZ_CONFIG_MARKER, cfgScript);
      return send(res, 200, 'text/html; charset=utf-8', html);
    } catch (e) {
      return send(res, 500, 'text/plain; charset=utf-8', 'Slide build error: ' + e.message);
    }
  }

  // static files next to the slides (images, join-qr.svg, etc.) — from the
  // session folder. Shared by /slides/ and by /widget/ (a widget question's
  // `src` bundle): both serve a path resolved strictly inside SESSION_DIR.
  if (p.startsWith('/slides/')) return serveSessionFile(res, p.slice('/slides/'.length));
  if (p.startsWith('/widget/')) return serveSessionFile(res, p.slice('/widget/'.length));
  // Vendored widget packages live at the content root, shared across sessions.
  if (p.startsWith('/widgetpkg/')) return serveFileFrom(res, WIDGETS_DIR, p.slice('/widgetpkg/'.length));

  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // ?embed=1 — this is the /slides deck's own live view (what the
    // projector shows), not a real student. Otherwise every open slides tab
    // (including the teacher's own) would count as "connected".
    const isEmbed = url.searchParams.get('embed') === '1';
    const entry = { res, host: isHost };
    streams.add(entry);
    if (!isHost && !isEmbed) students.add(entry);
    res.write('data: ' + snapshot(isHost) + '\n\n');
    const cleanup = () => {
      clearInterval(beat);
      streams.delete(entry);
      students.delete(entry);
      broadcast();
    };
    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        // the connection is dead, and 'close' may never arrive on some
        // mobile networks/proxies — clean up ourselves so the count doesn't
        // pile up stale entries.
        cleanup();
      }
    }, 25000);
    req.on('close', cleanup);
    broadcast();
    return;
  }

  if (p === '/api/answer' && req.method === 'POST') {
    const { qid, value, clientId } = await readBody(req);
    const q = cur();
    if (!q || q.id !== qid || state.revealed) return send(res, 409, 'application/json', '{"ok":false}');
    // Only accept a value that's actually a legal answer to this question —
    // a hand-crafted POST can't stuff the archive with junk that's counted in
    // the DB but never shows up in the distribution.
    const val = validateAnswer(q, value);
    if (val == null) return send(res, 422, 'application/json', '{"ok":false}');
    const cid = String(clientId == null ? '' : clientId).slice(0, 64);
    if (!cid) return send(res, 422, 'application/json', '{"ok":false}');
    const ip = clientIp(req);
    forgetIdleIps();
    if (!rateOk(ip) || !clientAllowed(ip, cid)) return send(res, 429, 'application/json', '{"ok":false}');
    if (!answers.has(qid)) answers.set(qid, new Map());
    answers.get(qid).set(cid, val);
    persistAnswer(q, cid, val);
    maybeAutoReveal();
    broadcast();
    return send(res, 200, 'application/json', '{"ok":true}');
  }

  if (p === '/api/control' && req.method === 'POST') {
    const body = await readBody(req);
    const { action, key, to } = body;
    if (key !== KEY) return send(res, 403, 'application/json', '{"ok":false}');
    const last = quiz.questions.length - 1;
    if (action === 'next' && state.index < last) (state.index++, (state.revealed = false));
    else if (action === 'prev' && state.index > -1) (state.index--, (state.revealed = false));
    else if (action === 'goto' && Number.isInteger(to) && to >= 0 && to <= last) (state.index = to, (state.revealed = false));
    // reveal can carry the target question, so the slides send a single atomic
    // request instead of a goto+reveal pair that could arrive out of order.
    else if (action === 'reveal') {
      // Must be a real array index: a string or fraction would make cur() return
      // undefined and blank the quiz (see the goto guard above).
      if (Number.isInteger(to) && to >= 0 && to <= last) state.index = to;
      state.revealed = true;
    }
    else if (action === 'auto') state.autoReveal = !!body.autoReveal; // /host toggle
    else if (action === 'clear') {
      const q = cur();
      if (q) {
        answers.delete(q.id);
        if (runId) db.prepare('DELETE FROM answers WHERE run_id = ? AND qid = ?').run(runId, q.id);
      }
      state.revealed = false;
    }
    else if (action === 'reset') {
      state.index = -1;
      state.revealed = false;
      answers.clear();
      if (runId) db.prepare('DELETE FROM answers WHERE run_id = ?').run(runId);
    }
    persistLiveState();
    broadcast();
    return send(res, 200, 'application/json', '{"ok":true}');
  }

  if (p === '/api/export') {
    if (!isHost) return send(res, 403, 'text/plain', 'no');
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(exportData(), null, 2));
  }

  // ---------------------------------------------------------------- editor
  // /edit is the authoring surface — same server, same teacher key. Students
  // can't reach it (they have no key), and it stays reachable while a class is
  // running on purpose: fixing a typo you only notice on the projector, mid
  // lecture, is exactly when you need it.
  if (p === '/edit' || p === '/edit/') {
    if (!isHost) return send(res, 403, 'text/plain; charset=utf-8', 'Add ?key=...');
    return send(res, 200, 'text/html; charset=utf-8', readAssetText('public/edit.html'));
  }
  if (p === '/edit.css') return send(res, 200, 'text/css; charset=utf-8', readAssetText('public/edit.css'));
  if (p === '/edit.js') return send(res, 200, 'application/javascript; charset=utf-8', readAssetText('public/edit.js'));
  if (p === '/edit.questions.js') return send(res, 200, 'application/javascript; charset=utf-8', readAssetText('public/edit.questions.js'));

  if (p.startsWith('/api/edit/')) {
    if (!isHost) return send(res, 403, 'application/json; charset=utf-8', '{"ok":false,"errors":["forbidden"]}');
    const json = (code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

    // Everything the editor needs to draw itself, in one round trip.
    if (p === '/api/edit/state' && req.method === 'GET') {
      const r = readQuestions(QUESTIONS_FILE, name);
      return json(200, {
        ok: r.ok !== false,
        version: VERSION,
        session: name,
        course,
        deck: { type: deckType, slides: deckSlideCount() },
        doc: r.doc || null,
        rev: r.rev || 0,
        isNew: !!r.isNew, // no questions.json on disk yet — the first save creates it
        errors: r.errors || [],
        warnings: r.warnings || [],
      });
    }

    if (p === '/api/edit/questions' && req.method === 'PUT') {
      const body = await readBody(req, 2e6); // a whole questions.json, not an answer
      const r = saveQuestions({ file: QUESTIONS_FILE, dataDir: DATA_DIR, sessionName: name, doc: body.doc, rev: body.rev });
      if (r.ok) reloadQuiz(r.doc);
      return json(r.ok ? 200 : r.conflict ? 409 : 422, r);
    }

    if (p === '/api/edit/history' && req.method === 'GET') return json(200, { ok: true, entries: listHistory(DATA_DIR, name, 'questions') });

    if (p === '/api/edit/history/entry' && req.method === 'GET') {
      const content = readHistory(DATA_DIR, name, 'questions', url.searchParams.get('id'));
      if (content == null) return json(404, { ok: false, errors: ['no such history entry'] });
      return json(200, { ok: true, content });
    }

    if (p === '/api/edit/restore' && req.method === 'POST') {
      const body = await readBody(req);
      const r = restoreQuestions({ file: QUESTIONS_FILE, dataDir: DATA_DIR, sessionName: name, id: body.id });
      if (r.ok) reloadQuiz(r.doc);
      return json(r.ok ? 200 : 422, r);
    }

    return json(404, { ok: false, errors: ['unknown editor endpoint'] });
  }

  send(res, 404, 'text/plain; charset=utf-8', 'not found');
});

function exportData() {
  return {
    course,
    session: name,
    title: quiz.title || name,
    group: GROUP || null,
    at: new Date().toISOString(),
    questions: quiz.questions.map((q) => {
      const given = [...(answers.get(q.id) || new Map()).values()];
      const row = { id: q.id, type: q.type, text: q.text, answered: given.length };
      if (effectiveKind(q) === 'text') row.texts = given;
      else {
        const counts = {};
        given.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
        row.counts = counts;
        row.correct = (q.options || []).filter((o) => o.correct).map((o) => o.id);
      }
      return row;
    }),
  };
}

// save results on exit — so exit tickets aren't lost
function saveAndExit() {
  if (runId) {
    try {
      db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run(new Date().toISOString(), runId);
    } catch (_) {}
  }
  const any = [...answers.values()].some((m) => m.size);
  if (any) {
    const dir = path.join(DATA_DIR, 'results');
    fs.mkdirSync(dir, { recursive: true });
    const slug = groupSlug(GROUP);
    const label = sessionSlug(name);
    const f = path.join(dir, label + (slug ? '-' + slug : '') + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json');
    fs.writeFileSync(f, JSON.stringify(exportData(), null, 2));
    console.log('\n  Results saved: ' + path.relative(process.cwd(), f));
  }
  process.exit(0);
}
process.on('SIGINT', saveAndExit);
process.on('SIGTERM', saveAndExit);

// ---------------------------------------------------------------- startup
function localIp() {
  // --host wins; otherwise pick the best real LAN address, skipping VPN /
  // Docker / virtual interfaces that the naive "first non-internal IPv4" would
  // wrongly advertise (leaving students with an unreachable join URL).
  return HOST_OVERRIDE || bestHostIp(os.networkInterfaces());
}

// `presik edit <session>` — hand the teacher the editor without making them
// copy a URL out of the banner. localhost, not the LAN address: this browser is
// on this machine by definition. Best-effort — a headless box just prints the
// URL like always.
function openBrowser(url) {
  // On Windows the opener is cmd's `start`, whose *first* quoted argument is the
  // window title — so the URL has to go second, behind an empty title (`start ""
  // <url>`), or a link with a `?key=` query opens a blank titled window instead.
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] :
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
    ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch (_) {}
}

async function setJoinUrl(url) {
  joinUrl = url;
  qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0b1118', light: '#ffffff' } });
  try {
    fs.mkdirSync(path.dirname(QR_FILE), { recursive: true });
    fs.writeFileSync(QR_FILE, qrSvg);
  } catch (e) {
    console.log('  (could not write QR to ' + QR_FILE + ': ' + e.message + ')');
  }
  broadcast();
}

function banner() {
  console.log('\n  presik v' + VERSION);
  console.log(
    '  ' + (quiz.title || name) + '  ·  session: ' + name + (course ? '  ·  course: ' + course : '') +
      '  ·  questions: ' + quiz.questions.length + (GROUP ? '  ·  group: ' + GROUP : '')
  );
  const base = joinUrl.replace(/\/$/, ''); // no trailing slash before the path we append
  console.log('\n  Students:  ' + joinUrl);
  console.log('  Teacher:   ' + base + '/host?key=' + KEY + '  (control + live view — keep private)');
  console.log('  Editor:    ' + base + '/edit?key=' + KEY + '  (write the questions — keep private)');
  console.log('  Report:    ' + base + '/report?key=' + KEY + '  (analytics across runs/groups/courses — keep private)');
  if (deckType === 'marp' && MARP_AVAILABLE) console.log('  Slides:    ' + base + '/slides?key=' + KEY + '  (without ?key= — view only, no control)');
  else if (deckType === 'pdf') console.log('  Slides:    ' + base + '/slides?key=' + KEY + '  (PDF deck; without ?key= — view only)');
  else if (deckType === 'marp') console.log('  Slides:    (deck.marp.md found, but Marp isn\'t in this build — use a PDF deck, or: npm i @marp-team/marp-cli)');
  if (!deckType) console.log('  Projector: ' + base + '/present  (QR + live results — questions-only session)');
  if (!KEY_GIVEN)
    console.log('\n  Key:       ' + KEY + '  (random this run; anyone with it controls the quiz — pin your own with --key)');
  console.log('\n  DB:        ' + path.relative(process.cwd(), DB_FILE) + '  (for analysis — presik-report)');
  // Settings that came from a file rather than from what you just typed —
  // otherwise a surprising port is a mystery instead of a lookup.
  if (CONFIG_FILES.length) console.log('  Config:    ' + CONFIG_FILES.join(', '));
  // If more than one plausible LAN address exists, students may be handed the
  // wrong one; tell the teacher how to override.
  if (!HOST_OVERRIDE && !TUNNEL) {
    const cands = rankHostIps(os.networkInterfaces()).filter((c) => c.score >= 4);
    if (cands.length > 1)
      console.log('  Note:      several network addresses found — if students can\'t reach the link, try --host ' + cands[1].address);
  }
  console.log('');
}

function resolveGroup() {
  return new Promise((resolve) => {
    if (GROUP) return resolve(String(GROUP).trim() || null);
    if (NO_GROUP || !process.stdin.isTTY) return resolve(null);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  Group/cohort name for this session (Enter — no name): ', (answer) => {
      rl.close();
      resolve(answer.trim() || null);
    });
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use — another presik/app is running there.');
    console.error('  Run this session on another port, e.g.:  presik ' + (sessionArg || '') + ' --port ' + (PORT + 1) + '\n');
  } else {
    console.error('\n  Server error: ' + e.message + '\n');
  }
  process.exit(1);
});

(async () => {
  GROUP = await resolveGroup();
  startRun();

  // Build the slides and convert the deck BEFORE we start listening. Both shell
  // out synchronously (marp-cli; osascript/soffice for a pptx/key deck), and a
  // conversion can take minutes — running them inside the listen callback would
  // freeze the event loop of an already-listening server, hanging every request
  // that arrived meanwhile. Doing them first only delays the (URL-less) socket,
  // and keeps any "install LibreOffice / export a PDF" message up front.
  if (deckType === 'marp' && MARP_AVAILABLE) {
    try {
      ensureSlideHtml();
    } catch (e) {
      console.error('\n  Slide build error (' + path.relative(CONTENT_DIR, DECK_FILE) + '): ' + e.message + '\n');
    }
  }
  if (convertSrc) {
    try {
      const r = ensureDeckPdf(convertSrc, CACHE_PDF);
      pdfServePath = r.path;
      if (r.converter !== 'cache') console.log('  Converted ' + path.basename(convertSrc) + ' → PDF via ' + r.converter);
    } catch (e) {
      deckError = e.message;
      console.error('\n  ' + e.message + '\n');
    }
  }

  server.listen(PORT, async () => {
    await setJoinUrl('http://' + localIp() + ':' + PORT + '/');

    if (OPEN_EDITOR) openBrowser('http://localhost:' + PORT + '/edit?key=' + encodeURIComponent(KEY));

    if (!TUNNEL) {
      banner();
      return;
    }

    console.log('\n  Bringing up a tunnel via cloudflared…');
    const cf = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:' + PORT], { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const scan = async (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !done) {
        done = true;
        await setJoinUrl(m[0] + '/');
        banner();
      }
    };
    cf.stdout.on('data', scan);
    cf.stderr.on('data', scan);
    cf.on('error', () => {
      done = true; // failed for good — don't also let the 15s "timed out" fallback fire a second banner
      console.log('  cloudflared not found — staying on the local network.');
      banner();
    });
    process.on('exit', () => cf.kill());
    setTimeout(() => {
      if (!done) {
        console.log('  Tunnel did not come up within 15s — staying on the local network.');
        banner();
      }
    }, 15000);
  });
})();
