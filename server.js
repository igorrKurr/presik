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
const { groupSlug, bestHostIp, rankHostIps, validateAnswer } = require('./lib');

const ENGINE_DIR = __dirname;
const VERSION = require('./package.json').version;

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const FLAGS_WITH_VALUE = new Set(['dir', 'port', 'key', 'qr', 'db', 'group', 'host']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (FLAGS_WITH_VALUE.has(a.slice(2))) i++; // skip the flag's value too, not just the flag
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
const PORT = parseInt(opt('port', '3000'), 10);
const HOST_OVERRIDE = opt('host', null); // advertised LAN address (skip auto-detect)
// The teacher key controls the whole quiz (next/reveal/reset). "teach" used to
// be the default — but the project is public, so a known default means anyone
// on the network can hijack a class. Default is now random per run; --key
// still lets you pin a memorable one on purpose.
const KEY_GIVEN = opt('key', null);
const KEY = KEY_GIVEN || crypto.randomBytes(4).toString('hex');
// Only trust X-Forwarded-For when we're actually behind the cloudflared tunnel
// (all students then share Cloudflare's edge IP, so the real client IP is in
// the header). On a plain LAN we ignore it — otherwise a cheater could spoof
// the header to dodge the per-IP answer limits below.
const TRUST_PROXY = argv.includes('--tunnel');
const DATA_DIR = path.join(CONTENT_DIR, '.presik');
const DB_FILE = path.resolve(opt('db', path.join(DATA_DIR, 'data.db')));
let GROUP = opt('group', null);

// ---------------------------------------------------------------- content sessions
// A session is any directory that has deck.marp.md and/or questions.json in
// it. Its "name" is its path relative to the content root (POSIX-style), so
// the exact same code works whether it's a single deck at the root, a course
// with many sessions, or a root holding several courses — it's just a
// different path depth.
const SKIP_DIRS = new Set(['node_modules', '.git', '.presik', 'public', 'templates']);

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

function toSessionName(root, dir) {
  const rel = path.relative(root, dir);
  return (rel || '.').split(path.sep).join('/');
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

const QUESTIONS_FILE = path.join(SESSION_DIR, 'questions.json');
const DECK_FILE = path.join(SESSION_DIR, 'deck.marp.md');
const DECK_HTML = path.join(SESSION_DIR, 'deck.marp.html');
const QR_FILE = path.resolve(opt('qr', path.join(SESSION_DIR, 'join-qr.svg')));

if (!fs.existsSync(QUESTIONS_FILE)) {
  console.error('\n  Missing ' + path.relative(CONTENT_DIR, QUESTIONS_FILE) + '\n');
  console.error('  Every session is a directory with questions.json (and, optionally, deck.marp.md).');
  console.error('  Example — templates/questions.example.json.\n');
  process.exit(1);
}

let quiz;
try {
  quiz = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
} catch (e) {
  console.error('\n  Error in JSON (' + QUESTIONS_FILE + '):\n  ' + e.message + '\n');
  process.exit(1);
}
if (!Array.isArray(quiz.questions) || !quiz.questions.length) {
  console.error('\n  File has no "questions" array.\n');
  process.exit(1);
}
// validate the schema up front, not in the middle of class
quiz.questions.forEach((q, i) => {
  if (!q.id) q.id = name.replace(/\//g, '-') + '-q' + (i + 1);
  const t = (q.type = q.type || 'choice');
  if (!['choice', 'text', 'scale'].includes(t)) {
    console.error(`  Question ${q.id}: unknown type "${t}" (allowed: choice, text, scale)`);
    process.exit(1);
  }
  if (t === 'choice' && !(q.options || []).length) {
    console.error(`  Question ${q.id}: type=choice but has no options`);
    process.exit(1);
  }
  if (t === 'scale') {
    q.min = q.min || 1;
    q.max = q.max || 5;
  }
});

// ---------------------------------------------------------------- slides (Marp)
// Slides are the source of truth in deck.marp.md; deck.marp.html is a build
// artifact the server rebuilds itself whenever the .md is newer than the
// .html (or the .html doesn't exist yet).
// Run marp-cli's JS entry through the current node binary rather than the
// node_modules/.bin/marp shim: the shim is a shell script on macOS/Linux and
// a .cmd on Windows, and execFileSync on the extensionless name can't launch
// the .cmd — so the old approach silently broke slide builds on Windows.
const MARP_JS = path.join(ENGINE_DIR, 'node_modules', '@marp-team', 'marp-cli', 'marp-cli.js');
const deckExists = fs.existsSync(DECK_FILE);

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
      options: (q.options || []).map((o) => ({ id: o.id, text: o.text })),
      min: q.min,
      max: q.max,
    })),
  };
}

function ensureSlideHtml() {
  const stale = !fs.existsSync(DECK_HTML) || fs.statSync(DECK_FILE).mtimeMs > fs.statSync(DECK_HTML).mtimeMs;
  if (stale) {
    execFileSync(process.execPath, [MARP_JS, DECK_FILE, '-o', DECK_HTML, '--html', '--allow-local-files'], { stdio: 'inherit' });
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
// address; under --tunnel we key off the real client IP (X-Forwarded-For).
const MAX_CLIENTS_PER_IP = 12;
const RATE_BURST = 8; // answers per burst
const RATE_REFILL_MS = 400; // one token back every 400ms (~2.5/s sustained)
const clientsByIp = new Map(); // ip -> Set(clientId)
const rateByIp = new Map(); // ip -> { tokens, ts }

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'local';
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
  let isCorrect = null;
  if (q.type === 'choice') {
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
    qtype: q.type,
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
  const given = answers.get(q.id) || new Map();
  const base = { answered: given.size, connected: students.size };
  if (!isHost && !state.revealed) return base; // students don't see the distribution before reveal
  if (q.type === 'text') return { ...base, texts: [...given.values()].slice(0, 80) };
  if (q.type === 'scale') {
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

// ---------------------------------------------------------------- http
const send = (res, code, type, body) => {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    // The teacher key rides in the URL (?key=); no-referrer stops it leaking to
    // any third party via the Referer header (e.g. images/CDNs in a slide).
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
};
const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 8000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch (_) {
        resolve({});
      }
    });
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const isHost = url.searchParams.get('key') === KEY;

  if (p === '/') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ENGINE_DIR, 'public/student.html')));

  if (p === '/host') {
    if (!isHost) return send(res, 403, 'text/plain; charset=utf-8', 'Add ?key=...');
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ENGINE_DIR, 'public/host.html')));
  }

  if (p === '/qr.svg') return send(res, 200, 'image/svg+xml', qrSvg);

  if (p === '/embed.js') return send(res, 200, 'application/javascript; charset=utf-8', fs.readFileSync(path.join(ENGINE_DIR, 'public/embed.js')));
  if (p === '/embed.css') return send(res, 200, 'text/css; charset=utf-8', fs.readFileSync(path.join(ENGINE_DIR, 'public/embed.css')));

  if (p === '/slides' || p === '/slides/') {
    if (!deckExists) return send(res, 404, 'text/plain; charset=utf-8', 'No deck.marp.md for session "' + name + '"');
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

  // static files next to the slides (images, join-qr.svg, etc.) — from the session folder
  if (p.startsWith('/slides/')) {
    const rel = decodeURIComponent(p.slice('/slides/'.length));
    const filePath = path.join(SESSION_DIR, rel);
    if (!filePath.startsWith(SESSION_DIR + path.sep)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const type =
        {
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.html': 'text/html; charset=utf-8',
        }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      return send(res, 200, type, fs.readFileSync(filePath));
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  }

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
    else if (action === 'goto' && to >= 0 && to <= last) (state.index = to, (state.revealed = false));
    // reveal can carry the target question, so the slides send a single atomic
    // request instead of a goto+reveal pair that could arrive out of order.
    else if (action === 'reveal') {
      if (typeof to === 'number' && to >= 0 && to <= last) state.index = to;
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
      if (q.type === 'text') row.texts = given;
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
    const label = name.replace(/\//g, '-');
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
  console.log('\n  Students:  ' + joinUrl);
  console.log('  Teacher:   ' + joinUrl.replace(/\/$/, '') + '/host?key=' + KEY);
  if (deckExists) console.log('  Slides:    ' + joinUrl.replace(/\/$/, '') + '/slides?key=' + KEY + '  (without ?key= — view only, no control)');
  if (!KEY_GIVEN)
    console.log('\n  Key:       ' + KEY + '  (random this run; anyone with it controls the quiz — pin your own with --key)');
  console.log('\n  DB:        ' + path.relative(process.cwd(), DB_FILE) + '  (for analysis — presik-report)');
  // If more than one plausible LAN address exists, students may be handed the
  // wrong one; tell the teacher how to override.
  if (!HOST_OVERRIDE && !argv.includes('--tunnel')) {
    const cands = rankHostIps(os.networkInterfaces()).filter((c) => c.score >= 4);
    if (cands.length > 1)
      console.log('  Note:      several network addresses found — if students can\'t reach the link, try --host ' + cands[1].address);
  }
  console.log('');
}

function resolveGroup() {
  return new Promise((resolve) => {
    if (GROUP) return resolve(GROUP.trim() || null);
    if (has('no-group') || !process.stdin.isTTY) return resolve(null);
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

  server.listen(PORT, async () => {
    await setJoinUrl('http://' + localIp() + ':' + PORT + '/');

    if (deckExists) {
      try {
        ensureSlideHtml();
      } catch (e) {
        console.error('\n  Slide build error (' + path.relative(CONTENT_DIR, DECK_FILE) + '): ' + e.message + '\n');
      }
    }

    if (!has('tunnel')) {
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
