// Pure, dependency-free helpers shared by the server and covered by tests
// (test/lib.test.js). Nothing here touches the network, the filesystem, or
// process state — so it's all trivially unit-testable.

// A session's name is its path relative to the content root, POSIX-style — the
// same spelling on every OS, so slugs/URLs/ids don't drift by platform.
// path.relative yields "\" separators on Windows, so normalize either one.
function toSessionName(root, dir) {
  const path = require('path');
  const rel = path.relative(root, dir);
  return (rel || '.').split(/[\\/]/).join('/');
}

// A session name (a POSIX path like "web-dev/s01") → one filesystem-safe token.
// The results archive, the converted-PDF cache, the edit-history folder, and the
// generated question ids all key off this — so they agree on a single spelling
// instead of each re-inventing the "/ → -" rule.
function sessionSlug(name) {
  return String(name || 'session').replace(/\//g, '-') || 'session';
}

// Parse an argv already sliced past [node, script] into positionals plus `opt`
// / `has` lookups. `flagsWithValue` names the flags that consume the following
// token, so a value like the "s02" in `--dir s02` isn't mistaken for a
// positional. One parser for every entrypoint (server, scaffold, report), so
// they can't drift in how they read the command line.
function parseArgs(argv, flagsWithValue) {
  const valued = flagsWithValue instanceof Set ? flagsWithValue : new Set(flagsWithValue || []);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (valued.has(a.slice(2))) i++; // skip the flag's value too, not just the flag
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
  return { positional, opt, has };
}

// Group/cohort → a filename-safe slug (used only for the results/*.json name).
function groupSlug(g) {
  return g ? g.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) : null;
}

// Interfaces that are technically "up" but never the address students can
// reach: VPNs (utun/tun/ppp), virtualization (vmnet/vboxnet/docker/bridge),
// Apple link-local service interfaces (awdl/llw), etc.
const VIRTUAL_IFACE = /^(utun|tun|tap|ppp|ipsec|vnic|vmnet|vboxnet|docker|br-|bridge|awdl|llw|gif|stf|ap\d)/i;

function isPrivateV4(addr) {
  return /^10\./.test(addr) || /^192\.168\./.test(addr) || /^172\.(1[6-9]|2\d|3[01])\./.test(addr);
}

// Pick the LAN address to advertise in the join URL / QR. The naive "first
// non-internal IPv4" breaks the moment a VPN or Docker is up, handing students
// an address nobody in the room can reach. Score real private-LAN interfaces
// highest; let --host override entirely (handled by the caller).
function rankHostIps(interfaces) {
  const cand = [];
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const a of addrs || []) {
      if (!a || a.internal) continue;
      const fam = a.family === 4 || a.family === 'IPv4';
      if (!fam) continue;
      let score = 0;
      if (isPrivateV4(a.address)) score += 4;
      if (!VIRTUAL_IFACE.test(name)) score += 2;
      if (/^en|^eth|^wl/i.test(name)) score += 1; // ethernet/wifi first
      cand.push({ address: a.address, name, score });
    }
  }
  cand.sort((x, y) => y.score - x.score);
  return cand;
}

function bestHostIp(interfaces) {
  const c = rankHostIps(interfaces);
  return c.length ? c[0].address : 'localhost';
}

// The data contract a question answers to. A `widget` question supplies its own
// interactive front-end (a form, a canvas game…) but stores, validates, reveals
// and archives its answer as one of the three primitive kinds it declares via
// `answer`. Everywhere the engine used to branch on `q.type === 'choice'|…`, it
// branches on effectiveKind instead — so a choice-widget is graded, aggregated
// and reported exactly like a choice question, and only the phone runs the game.
function effectiveKind(q) {
  if (q == null) return null;
  return q.type === 'widget' ? q.answer || 'choice' : q.type;
}

// A student answer is only accepted if it's actually a legal answer to the
// current question — otherwise a hand-crafted POST could stuff the archive
// with junk values (counted in the DB, invisible in the distribution). For a
// widget this is also the trust boundary: the sandboxed game can only ever
// report a value, and that value has to survive this gate like any tapped one.
// Returns the normalized value to store, or null to reject.
function validateAnswer(q, rawValue) {
  if (q == null) return null;
  const value = String(rawValue == null ? '' : rawValue);
  const kind = effectiveKind(q);
  if (kind === 'choice') {
    const ids = (q.options || []).map((o) => o.id);
    return ids.includes(value) ? value : null;
  }
  if (kind === 'scale') {
    if (!/^-?\d+$/.test(value.trim())) return null;
    const n = parseInt(value, 10);
    return n >= q.min && n <= q.max ? String(n) : null;
  }
  if (kind === 'text') {
    const t = value.trim();
    return t.length ? t.slice(0, 600) : null;
  }
  return null;
}

// Choose which converters to try, in order, to turn a deck into a PDF — given
// which tools are available. Fidelity-first: the source app's own renderer
// (Keynote / PowerPoint) before LibreOffice (soffice). `.key` only converts via
// Keynote (macOS). Returns an ordered list of adapter names; empty = no way.
function pickConverters(ext, caps) {
  caps = caps || {};
  const e = String(ext || '').toLowerCase();
  const list = [];
  if (e === '.key') {
    if (caps.keynote) list.push('keynote');
  } else if (e === '.pptx' || e === '.ppt') {
    if (caps.powerpoint) list.push('powerpoint'); // native — pixel-perfect
    if (caps.soffice) list.push('soffice'); // good, not perfect
  }
  return list;
}

// Split a Marp markdown deck into its front-matter and slides. Slides are
// separated by a `---` line at the top level (not inside a ``` / ~~~ code
// fence); the leading `---`…`---` block is front-matter, not a separator.
function splitMarpSlides(md) {
  const lines = String(md).split(/\r?\n/);
  let front = '';
  let i = 0;
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    front = lines.slice(0, j + 1).join('\n'); // includes the closing ---
    i = j + 1;
  }
  const slides = [];
  let cur = [];
  let fence = null; // '`' or '~' while inside a fenced code block
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    const m = t.match(/^(`{3,}|~{3,})/);
    if (m) {
      const ch = m[1][0];
      if (fence === null) fence = ch;
      else if (ch === fence) fence = null;
      cur.push(lines[i]);
      continue;
    }
    if (fence === null && /^---\s*$/.test(t)) { slides.push(cur.join('\n')); cur = []; continue; }
    cur.push(lines[i]);
  }
  slides.push(cur.join('\n'));
  return { front, slides };
}

// Rewrite a Marp deck so each question with a `slide` gets an auto-generated
// question + reveal marker slide inserted right after that 1-based slide. The
// author writes no markers — placement lives in questions.json, unified with
// PDF decks. Questions without `slide` are left out (controlled from /host).
// `slidesFor(q)` returns the slides to insert for one question: by default the
// live markers embed.js fills in; `presik export --with-quiz` passes
// staticQuizSlides instead, since a PDF has no server to fill them.
const liveQuizMarkers = (q) => ['<div data-quiz-question="' + q.id + '"></div>', '<div data-quiz-reveal="' + q.id + '"></div>'];
function deriveMarpMarkdown(md, questions, slidesFor = liveQuizMarkers) {
  const placed = (questions || []).filter((q) => q && q.slide);
  if (!placed.length) return String(md); // nothing to inject → build as-is
  const { front, slides } = splitMarpSlides(md);
  const bySlide = {};
  placed.forEach((q) => { (bySlide[q.slide] = bySlide[q.slide] || []).push(q); });
  const marker = slidesFor;
  const chunks = [];
  for (let n = 1; n <= slides.length; n++) {
    chunks.push(slides[n - 1]);
    (bySlide[n] || []).forEach((q) => chunks.push(...marker(q)));
  }
  // Questions placed past the last slide append at the end.
  Object.keys(bySlide).map(Number).filter((n) => n > slides.length).sort((a, b) => a - b)
    .forEach((n) => bySlide[n].forEach((q) => chunks.push(...marker(q))));
  return (front ? front + '\n\n' : '') + chunks.join('\n\n---\n\n') + '\n';
}

// Author text dropped into generated Markdown must read literally — a `*`, `<`,
// `$` (Marp math) or `:smile:` (emoji) in a question would otherwise turn into
// formatting. CommonMark lets any ASCII punctuation be backslash-escaped.
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').replace(/[!-/:-@[-`{-~]/g, '\\$&');
}

// The static stand-in for one question's live slides, for a PDF export: a
// question slide (text, note, options / scale / open answer) and an answer
// slide (correct options, explain). The answer slide is skipped when there's
// nothing to reveal. `hint` is teacher-only and never appears.
function staticQuizSlides(q) {
  const kind = effectiveKind(q);
  const opts = q.options || [];
  const head = (label) => '<!-- _class: presik-quiz -->\n\n###### ' + label + '\n\n## ' + mdEscape(q.text);
  const body = [head('Question')];
  if (q.note) body.push('*' + mdEscape(q.note) + '*');
  if (kind === 'choice') body.push(opts.map((o) => '- ' + mdEscape(o.text || o.id)).join('\n'));
  else if (kind === 'scale') body.push('Scale: ' + q.min + ' – ' + q.max);
  else if (kind === 'text') body.push('*Open answer*');
  const slides = [body.join('\n\n')];

  const correct = kind === 'choice' ? opts.filter((o) => o.correct) : [];
  if (correct.length || q.explain) {
    const ans = [head('Answer')];
    if (correct.length) ans.push(correct.map((o) => '- **' + mdEscape(o.text || o.id) + '** ✓').join('\n'));
    if (q.explain) ans.push(mdEscape(q.explain));
    slides.push(ans.join('\n\n'));
  }
  return slides;
}

// The Markdown `presik export` hands to Marp. Quiz slides come from two places
// and both are handled: questions placed with "slide": N (deriveMarpMarkdown),
// and markers hand-written into older decks (<div data-quiz-question="id">…).
// withQuiz=false drops every quiz slide; withQuiz=true renders each one
// statically. The join-QR slide always goes — a QR to a server that isn't
// running is noise on paper. A slide left with nothing but comments/directives
// once its markers are gone is dropped rather than exported blank.
const QUIZ_MARKER = /<div\s+data-quiz-(join|question|reveal)(?:="([^"]*)")?\s*><\/div>/g;
function exportMarpMarkdown(md, questions, withQuiz) {
  const qs = questions || [];
  const byId = new Map(qs.map((q) => [q.id, q]));
  const derived = deriveMarpMarkdown(md, qs, withQuiz ? staticQuizSlides : () => []);
  const { front, slides } = splitMarpSlides(derived);
  const out = [];
  for (const slide of slides) {
    const body = slide.replace(QUIZ_MARKER, (m, kind, id) => {
      const q = withQuiz && kind !== 'join' ? byId.get(id) : null;
      if (!q) return '';
      const [question, answer] = staticQuizSlides(q);
      return '\n\n' + ((kind === 'question' ? question : answer) || '') + '\n\n';
    });
    if (body === slide || body.replace(/<!--[\s\S]*?-->/g, '').trim()) out.push(body);
  }
  return (front ? front + '\n\n' : '') + out.join('\n\n---\n\n') + '\n';
}

// Build the combined navigation sequence for a PDF deck: each page, followed by
// the question+reveal steps of any questions placed on that page (1-based
// `slide`). Questions without a `slide` don't appear in the deck (controlled
// from /host only). Mirrors the inline builder in public/deck.html.
function buildDeckSteps(numPages, questions) {
  const bySlide = {};
  (questions || []).forEach((q, i) => {
    if (q && q.slide) (bySlide[q.slide] = bySlide[q.slide] || []).push(i);
  });
  const steps = [];
  for (let p = 1; p <= numPages; p++) {
    steps.push({ t: 'page', page: p });
    (bySlide[p] || []).forEach((qi) => {
      steps.push({ t: 'question', qi });
      steps.push({ t: 'reveal', qi });
    });
  }
  return steps;
}

// ---------------------------------------------------------------- questions.json
// Validate and normalize a parsed questions.json. Returns the normalized quiz
// plus human-readable messages instead of exiting, so one validator serves both
// callers: the server prints the errors and refuses to start, the editor rejects
// the save and shows them on the card.
//
// errors block; warnings don't. That split exists because the editor saves as
// you type: a half-written question is normal for a few seconds and mustn't fail
// the save, while a duplicate id or an option-less choice question is broken in
// a way that would break class.
const QUESTION_TYPES = ['choice', 'text', 'scale', 'widget'];
// The three primitive data contracts a `widget` may declare via `answer` — the
// same kinds that exist as standalone types. A widget can't invent a fourth: its
// answer must reduce to something stats(), the archive and report.js understand.
const ANSWER_KINDS = ['choice', 'text', 'scale'];
// A widget's height on the phone, in CSS px. Clamped so a typo can't hand the
// student a 50,000px iframe (or a 1px one that hides the game).
const WIDGET_MIN_HEIGHT = 80;
const WIDGET_MAX_HEIGHT = 2000;
// A `src` bundle is resolved *inside* the session folder and served from there.
// Reject anything that could climb out of it (absolute paths, ".." segments,
// backslashes, URLs) before it ever reaches the filesystem or an <iframe>.
function isSafeWidgetSrc(src) {
  if (typeof src !== 'string' || !src.trim()) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return false; // no scheme, no protocol-relative
  if (src.startsWith('/') || src.startsWith('\\') || src.includes('\\')) return false;
  return !src.split('/').some((seg) => seg === '..' || seg === '.');
}
// A `url` (self-hosted deployment) or `dev` (the game's dev server, for authoring
// with hot-reload) points the sandboxed iframe at a remote origin. Only http(s)
// absolute URLs — the iframe still runs at a null origin, so the remote page gets
// no cookies/storage of its own and talks to the quiz only over postMessage.
function isRemoteWidgetUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return false;
  let parsed;
  try { parsed = new URL(u); } catch (_) { return false; }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}
// A `package` ref names a vendored widget package ("name" or "name@version")
// under <content-root>/widgets/. Only a bare name + optional version — never a
// path — so it can't point outside the widgets folder.
function isPackageRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return false;
  if (ref.includes('/') || ref.includes('\\') || ref.includes('..')) return false;
  return /^[a-z0-9][a-z0-9._-]*(@[0-9][0-9a-z.+-]*)?$/i.test(ref);
}
// The one-of source keys a widget descriptor may carry — checked as a group so
// exactly one wins. srcdoc = inline HTML; src = a built bundle in the session;
// url = a self-hosted deployment; dev = a dev server (authoring only);
// package = a vendored widget package resolved from <content-root>/widgets/.
const WIDGET_SOURCES = ['srcdoc', 'src', 'url', 'dev', 'package'];
// A scale is a row of buttons the class taps, not a number-entry box. Cap the
// span so a typo like "max": 2026 can't make stats() allocate a giant counts
// object on every broadcast (and every phone paint thousands of buttons). The
// editor's own preview stops at ~40 buttons for the same reason.
const SCALE_MAX_STEPS = 100;

// Validate the `widget` descriptor of a widget question in place. The front-end
// is either inline HTML (`srcdoc` — the whole game lives in questions.json) or a
// bundle file in the session folder (`src`); exactly one, and a `src` must stay
// inside the folder. `config` is opaque author data handed to the game at init.
function validateWidget(q, errors) {
  const w = q.widget;
  if (w == null || typeof w !== 'object' || Array.isArray(w)) {
    errors.push('Question ' + q.id + ': widget type needs a "widget" object ({ "srcdoc": "…" }, { "src": "file.html" }, { "url": "https://…" } or { "dev": "http://localhost:5173" })');
    return;
  }
  // Exactly one source. srcdoc/src/url/dev are alternatives, not a fallback
  // chain — two would be ambiguous about which the phone loads.
  const present = WIDGET_SOURCES.filter((k) => w[k] != null);
  if (present.length === 0) errors.push('Question ' + q.id + ': widget needs one of ' + WIDGET_SOURCES.join(', ') + ' (inline HTML, a bundle file, a URL, or a dev server)');
  else if (present.length > 1) errors.push('Question ' + q.id + ': widget has more than one source (' + present.join(', ') + ') — use exactly one');
  if (w.srcdoc != null && (typeof w.srcdoc !== 'string' || !w.srcdoc.trim())) errors.push('Question ' + q.id + ': widget "srcdoc" must be non-empty HTML');
  if (w.src != null && !isSafeWidgetSrc(w.src)) errors.push('Question ' + q.id + ': widget "src" must be a relative path inside the session folder (no "..", no URL)');
  if (w.url != null && !isRemoteWidgetUrl(w.url)) errors.push('Question ' + q.id + ': widget "url" must be an absolute http(s) URL');
  if (w.dev != null && !isRemoteWidgetUrl(w.dev)) errors.push('Question ' + q.id + ': widget "dev" must be an absolute http(s) URL (e.g. http://localhost:5173)');
  if (w.package != null && !isPackageRef(w.package)) errors.push('Question ' + q.id + ': widget "package" must be a name or name@version (e.g. "dungeon-escape@3"), no paths');
  if (w.height != null) {
    if (!Number.isInteger(w.height)) errors.push('Question ' + q.id + ': widget "height" must be a whole number of pixels');
    else if (w.height < WIDGET_MIN_HEIGHT || w.height > WIDGET_MAX_HEIGHT)
      errors.push('Question ' + q.id + ': widget "height" must be between ' + WIDGET_MIN_HEIGHT + ' and ' + WIDGET_MAX_HEIGHT + ' px');
  }
  if (w.isolate != null && typeof w.isolate !== 'boolean') errors.push('Question ' + q.id + ': widget "isolate" must be true or false');
  // Cross-origin isolation (threads / SharedArrayBuffer) needs the widget to run
  // at a real origin — which relaxes the sandbox and so is only for a front-end
  // you control (src/package/url), never inline srcdoc.
  if (w.isolate === true && w.srcdoc != null) errors.push('Question ' + q.id + ': widget "isolate" needs a src/package/url source, not inline "srcdoc" (isolation relaxes the sandbox — only for a front-end you control)');
  if (w.config != null && (typeof w.config !== 'object' || Array.isArray(w.config)))
    errors.push('Question ' + q.id + ': widget "config" must be a JSON object');
}

function normalizeQuiz(raw, sessionName) {
  const errors = [];
  const warnings = [];
  const bad = (quiz, msg) => ({ quiz, errors: [msg], warnings });
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
    return bad({ title: null, questions: [] }, 'questions.json must be a JSON object with a "questions" array.');
  if (!Array.isArray(raw.questions) || !raw.questions.length)
    return bad({ title: raw.title || null, questions: [] }, 'File has no "questions" array.');

  // An id is a question's identity — answers are stored under it, in the live
  // map and in the DB. Omitted ids fall back to position, which is why the
  // editor writes them out explicitly the first time it saves (see editor.js).
  const idBase = sessionSlug(sessionName);
  const seenIds = new Set();

  const questions = raw.questions.map((src, i) => {
    const q = Object.assign({}, src);
    q.id = String(q.id || idBase + '-q' + (i + 1));
    if (seenIds.has(q.id)) errors.push('Question ' + q.id + ': duplicate id — ids must be unique, answers are stored per id');
    seenIds.add(q.id);

    const t = (q.type = q.type || 'choice');
    if (!QUESTION_TYPES.includes(t)) {
      errors.push('Question ' + q.id + ': unknown type "' + t + '" (allowed: ' + QUESTION_TYPES.join(', ') + ')');
      return q;
    }
    if (!String(q.text == null ? '' : q.text).trim()) warnings.push('Question ' + q.id + ': no question text yet');

    // A widget declares which primitive contract its answer reduces to; the
    // options/scale checks below then run against that borrowed kind, so a
    // choice-widget is validated (and later graded) like a choice question.
    if (t === 'widget') {
      if (q.answer == null) q.answer = 'choice';
      if (!ANSWER_KINDS.includes(q.answer))
        errors.push('Question ' + q.id + ': widget "answer" must be one of ' + ANSWER_KINDS.join(', '));
      validateWidget(q, errors);
    }
    const kind = effectiveKind(q);

    // Options are normalized whenever they're present, not just for choice —
    // switching a question to text in the editor leaves them in place, so
    // switching back doesn't lose the answers you already typed.
    if (q.options != null) {
      if (!Array.isArray(q.options)) {
        errors.push('Question ' + q.id + ': "options" must be a list');
      } else {
        const seenOpt = new Set();
        q.options = q.options.map((o, j) => {
          const opt = Object.assign({}, o);
          opt.id = String(opt.id || String.fromCharCode(97 + j)); // a, b, c…
          if (seenOpt.has(opt.id)) errors.push('Question ' + q.id + ': duplicate option id "' + opt.id + '"');
          seenOpt.add(opt.id);
          if (!String(opt.text == null ? '' : opt.text).trim()) warnings.push('Question ' + q.id + ': option "' + opt.id + '" has no text');
          if (opt.correct) opt.correct = true;
          else delete opt.correct; // keep the file quiet: only correct options carry the flag
          return opt;
        });
      }
    }
    if (kind === 'choice' && !(Array.isArray(q.options) ? q.options : []).length)
      errors.push('Question ' + q.id + ': ' + (t === 'widget' ? 'widget answer=choice' : 'type=choice') + ' but has no options');

    if (kind === 'scale') {
      // `== null` rather than `||` so a 0-based scale (0..10) survives.
      if (q.min == null) q.min = 1;
      if (q.max == null) q.max = 5;
      if (!Number.isInteger(q.min) || !Number.isInteger(q.max)) errors.push('Question ' + q.id + ': "min"/"max" must be whole numbers');
      else if (q.min >= q.max) errors.push('Question ' + q.id + ': "min" (' + q.min + ') must be below "max" (' + q.max + ')');
      else if (q.max - q.min > SCALE_MAX_STEPS) errors.push('Question ' + q.id + ': scale range ' + q.min + '..' + q.max + ' is too wide (max ' + SCALE_MAX_STEPS + ' steps) — a scale is a handful of buttons, not a number-entry box');
    }

    // Optional deck placement: the question appears right after this 1-based
    // slide. Absent (rather than null) means "not in the deck" — keeps the key
    // out of the file the editor writes.
    if (q.slide == null) delete q.slide;
    else if (!Number.isInteger(q.slide) || q.slide < 1) errors.push('Question ' + q.id + ': "slide" must be a positive integer (page number)');

    return q;
  });

  return { quiz: Object.assign({}, raw, { title: raw.title || null, questions }), errors, warnings };
}

// ---------------------------------------------------------------- config file
// presik.config.json — optional, and deliberately nothing more than "the flags
// you'd have typed". Same keys as the flags, so there's one thing to learn; a
// flag always wins over the file, so a config file can never make a command line
// lie about what it's doing.
const CONFIG_FILE = 'presik.config.json';
const CONFIG_SPEC = {
  port: 'number',
  host: 'string',
  key: 'string',
  group: 'string',
  noGroup: 'boolean',
  tunnel: 'boolean',
  qr: 'path',
  db: 'path',
};
// --dir names the content root, and the config file is looked up *inside* the
// content root — so letting a config file set it would be circular.
const CONFIG_CLI_ONLY = new Set(['dir']);

function validateConfigObject(obj, where) {
  const at = where ? where + ': ' : '';
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return [at + 'must be a JSON object, e.g. { "port": 8080 }'];
  const errors = [];
  for (const [k, v] of Object.entries(obj)) {
    if (CONFIG_CLI_ONLY.has(k)) {
      errors.push(at + '"' + k + '" can only be set on the command line (--' + k + ')');
      continue;
    }
    const kind = CONFIG_SPEC[k];
    if (!kind) {
      errors.push(at + 'unknown setting "' + k + '" (known: ' + Object.keys(CONFIG_SPEC).join(', ') + ')');
      continue;
    }
    if (v === null) continue; // null reads as "not set" — lets a session file defer to the root's value
    if (kind === 'number') {
      if (typeof v !== 'number' || !Number.isInteger(v)) errors.push(at + '"' + k + '" must be a whole number');
      else if (k === 'port' && (v < 1 || v > 65535)) errors.push(at + '"port" must be between 1 and 65535');
    } else if (kind === 'boolean') {
      if (typeof v !== 'boolean') errors.push(at + '"' + k + '" must be true or false');
    } else if (typeof v !== 'string' || !v.trim()) {
      errors.push(at + '"' + k + '" must be a non-empty string');
    }
  }
  return errors;
}

// Later layers win key-by-key (root config, then session config); an absent or
// null value never overrides what a lower layer already set.
function mergeConfig(layers) {
  const out = {};
  for (const l of layers || []) for (const [k, v] of Object.entries(l || {})) if (v != null) out[k] = v;
  return out;
}

// ---------------------------------------------------------------- edit history
// Which history snapshots to delete to stay under `max`, oldest first. Names are
// timestamped (questions-2026-07-17T14-02-05.json), so lexical order is
// chronological order.
function historyToPrune(names, max) {
  const sorted = [...(names || [])].sort();
  return sorted.slice(0, Math.max(0, sorted.length - max));
}

module.exports = { toSessionName, sessionSlug, parseArgs, groupSlug, rankHostIps, bestHostIp, isPrivateV4, effectiveKind, validateAnswer, buildDeckSteps, splitMarpSlides, deriveMarpMarkdown, staticQuizSlides, exportMarpMarkdown, mdEscape, pickConverters, normalizeQuiz, validateConfigObject, mergeConfig, historyToPrune, isSafeWidgetSrc, isRemoteWidgetUrl, isPackageRef, CONFIG_FILE, CONFIG_SPEC, QUESTION_TYPES, ANSWER_KINDS, WIDGET_SOURCES, SCALE_MAX_STEPS, WIDGET_MAX_HEIGHT, VIRTUAL_IFACE };
