// The editor's side of the content files: read, validate, write, and keep a
// short history so a save is never a one-way door.
//
// questions.json stays a file people read, hand-edit, and commit — the editor is
// another way in, not a takeover. So: writes keep the formatting the examples
// use, unknown keys survive a round-trip, and every write is atomic and
// snapshotted first.
const fs = require('fs');
const path = require('path');
const { normalizeQuiz, historyToPrune } = require('./lib');

const HISTORY_MAX = 50; // snapshots kept per file, oldest pruned
// The editor saves a second or so after you stop typing. Without coalescing,
// writing one question would bury the history under fifty snapshots of a
// sentence being typed — so a snapshot is only taken if the newest one has had
// time to become a different thought.
const SNAPSHOT_GAP_MS = 60 * 1000;

// ---------------------------------------------------------------- formatting
const key = (k) => JSON.stringify(k);

// Re-indent a JSON.stringify block so it sits at `indent` inside the document.
function block(value, indent) {
  return JSON.stringify(value, null, 2).split('\n').join('\n' + indent);
}

// An option is one idea; it reads as one line. JSON.stringify(…, 2) would give
// it four.
function fmtOption(o) {
  const parts = Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => key(k) + ': ' + JSON.stringify(v));
  return '{ ' + parts.join(', ') + ' }';
}

function fmtQuestion(q, indent) {
  const lines = Object.entries(q)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      if (k === 'options' && Array.isArray(v)) {
        const opts = v.map((o) => indent + '    ' + fmtOption(o)).join(',\n');
        return indent + '  ' + key(k) + ': [\n' + opts + '\n' + indent + '  ]';
      }
      return indent + '  ' + key(k) + ': ' + block(v, indent + '  ');
    });
  return indent + '{\n' + lines.join(',\n') + '\n' + indent + '}';
}

// Serialize the document the way templates/questions.example.json is written:
// 2-space indent, one option per line, "questions" last. Top-level keys the
// editor doesn't know about (e.g. "_readme") pass straight through in place.
function formatQuestions(doc) {
  const lines = Object.keys(doc)
    .filter((k) => k !== 'questions' && doc[k] !== undefined && doc[k] !== null)
    .map((k) => '  ' + key(k) + ': ' + block(doc[k], '  '));
  const qs = (doc.questions || []).map((q) => fmtQuestion(q, '    ')).join(',\n');
  lines.push('  "questions": [\n' + qs + '\n  ]');
  return '{\n' + lines.join(',\n') + '\n}\n';
}

// ---------------------------------------------------------------- history
const slug = (sessionName) => String(sessionName || 'session').replace(/\//g, '-') || 'session';
const historyDir = (dataDir, sessionName) => path.join(dataDir, 'history', slug(sessionName));
// Milliseconds, not seconds: a restore snapshots the current file and then
// writes, and at one-second granularity those two can collide on the same name.
// Every stamp is the same length, so lexical order is chronological order —
// which is what listHistory and historyToPrune both lean on.
const stamp = (d) => d.toISOString().replace(/[:.]/g, '-').replace(/Z$/, ''); // 2026-07-17T14-02-05-123

function stampToIso(s) {
  const [d, t] = String(s).split('T');
  if (!t) return null;
  const p = t.split('-');
  if (p.length < 3) return null;
  return d + 'T' + p[0] + ':' + p[1] + ':' + p[2] + '.' + (p[3] || '000') + 'Z';
}

// Newest first — that's the order the panel shows them in.
function listHistory(dataDir, sessionName, file) {
  const dir = historyDir(dataDir, sessionName);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  return names
    .filter((n) => n.startsWith(file + '-') && n.endsWith('.json'))
    .sort()
    .reverse()
    .map((n) => {
      let size = 0;
      try {
        size = fs.statSync(path.join(dir, n)).size;
      } catch (_) {}
      return { id: n, at: stampToIso(n.slice(file.length + 1, -5)), size };
    })
    .filter((e) => e.at);
}

function readHistory(dataDir, sessionName, file, id) {
  // `id` arrives from the browser — keep it to a name this function generated,
  // so it can't walk out of the history folder.
  if (!/^[\w.-]+$/.test(String(id)) || !String(id).startsWith(file + '-')) return null;
  try {
    return fs.readFileSync(path.join(historyDir(dataDir, sessionName), id), 'utf8');
  } catch (_) {
    return null;
  }
}

// Snapshot content *before* it's overwritten: history holds the previous
// versions, the file on disk is the current one.
function snapshot(dataDir, sessionName, file, content, force) {
  const dir = historyDir(dataDir, sessionName);
  const entries = listHistory(dataDir, sessionName, file);
  const newest = entries[0];
  if (newest) {
    if (!force && Date.now() - Date.parse(newest.at) < SNAPSHOT_GAP_MS) return null;
    try {
      if (fs.readFileSync(path.join(dir, newest.id), 'utf8') === content) return null; // nothing changed since
    } catch (_) {}
  }
  fs.mkdirSync(dir, { recursive: true });
  // wx fails rather than overwrites, so two snapshots in the same millisecond
  // (a restore force-snapshots, then saves) can't land on the same name and
  // lose one. Bump the stamp by a ms until it's free — still chronological.
  let base = Date.now();
  let nm;
  for (;;) {
    nm = file + '-' + stamp(new Date(base)) + '.json';
    try {
      fs.writeFileSync(path.join(dir, nm), content, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      base++;
    }
  }
  for (const old of historyToPrune(
    fs.readdirSync(dir).filter((n) => n.startsWith(file + '-') && n.endsWith('.json')),
    HISTORY_MAX
  )) {
    try {
      fs.unlinkSync(path.join(dir, old));
    } catch (_) {}
  }
  return nm;
}

// ---------------------------------------------------------------- read / write
// tmp + rename in the same directory: rename is atomic, so a crash mid-save
// leaves either the old file or the new one — never half a questions.json that
// won't parse at the start of class.
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const revOf = (file) => {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch (_) {
    return 0;
  }
};

// The editor gets the *normalized* document: ids materialized, defaults filled.
// That's what makes reordering safe — see saveQuestions.
function readQuestions(file, sessionName) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, errors: ['could not read questions.json — ' + e.message] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, rev: revOf(file), errors: ['questions.json is not valid JSON — ' + e.message] };
  }
  const { quiz, errors, warnings } = normalizeQuiz(raw, sessionName);
  return { ok: true, doc: quiz, rev: revOf(file), errors, warnings };
}

// `rev` is the mtime the editor loaded. If the file moved under us — you edited
// it in vim, or a second tab is open — the save is refused rather than silently
// clobbering the other change.
function saveQuestions({ file, dataDir, sessionName, doc, rev }) {
  const cur = revOf(file);
  if (rev != null && cur && Math.round(rev) !== cur) return { ok: false, conflict: true, rev: cur, errors: ['questions.json changed on disk since you opened it'] };

  const { quiz, errors, warnings } = normalizeQuiz(doc, sessionName);
  if (errors.length) return { ok: false, errors, warnings };

  const text = formatQuestions(quiz);
  let prev = null;
  try {
    prev = fs.readFileSync(file, 'utf8');
  } catch (_) {}
  if (prev === text) return { ok: true, unchanged: true, rev: cur, doc: quiz, warnings };

  if (prev != null) snapshot(dataDir, sessionName, 'questions', prev, false);
  writeAtomic(file, text);
  return { ok: true, rev: revOf(file), doc: quiz, warnings };
}

// Restoring is just another save — of older content. The current version is
// force-snapshotted first, so "restore" is itself undoable.
function restoreQuestions({ file, dataDir, sessionName, id }) {
  const content = readHistory(dataDir, sessionName, 'questions', id);
  if (content == null) return { ok: false, errors: ['no such history entry'] };
  let raw;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    return { ok: false, errors: ['that snapshot is not valid JSON — ' + e.message] };
  }
  try {
    const prev = fs.readFileSync(file, 'utf8');
    snapshot(dataDir, sessionName, 'questions', prev, true);
  } catch (_) {}
  return saveQuestions({ file, dataDir, sessionName, doc: raw, rev: null });
}

module.exports = { readQuestions, saveQuestions, restoreQuestions, listHistory, readHistory, formatQuestions, writeAtomic, revOf, HISTORY_MAX };
