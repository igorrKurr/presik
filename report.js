#!/usr/bin/env node
// =====================================================================
//  Analysis across multiple classes, groups, and courses.
//  Reads the same SQLite database server.js writes answers to
//  (<content-root>/.presik/data.db by default).
//
//    presik-report                                 → list all runs
//    presik-report --session s01                    → per question: % correct, broken down by group
//    presik-report --session web-dev/s01             → session inside a course — same path as when running it
//    presik-report --course web-dev                  → all sessions of one course
//    presik-report --session s01 --group "3-A"        → just one group
//    presik-report --csv > answers.csv                  → all answers as CSV (for pandas/excel)
// =====================================================================
const path = require('path');
const fs = require('fs');
const { openDb } = require('./db');
const { parseArgs } = require('./lib');

const { opt, has } = parseArgs(process.argv.slice(2), ['dir', 'db', 'session', 'course', 'group']);

const CONTENT_DIR = path.resolve(opt('dir', process.cwd()));
const DB_FILE = path.resolve(opt('db', path.join(CONTENT_DIR, '.presik', 'data.db')));
if (!fs.existsSync(DB_FILE)) {
  console.error('\n  No database at ' + path.relative(process.cwd(), DB_FILE) + ' — the server hasn\'t run yet.\n');
  process.exit(1);
}
const db = openDb(DB_FILE);

const SESSION = opt('session', null);
const COURSE = opt('course', null);
const GROUP = opt('group', null);

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

if (has('csv')) {
  let sql = 'SELECT a.*, r.title, r.started_at AS run_started_at FROM answers a JOIN runs r ON r.id = a.run_id WHERE 1=1';
  const params = [];
  if (SESSION) (sql += ' AND a.session = ?'), params.push(SESSION);
  if (COURSE) (sql += ' AND a.course = ?'), params.push(COURSE);
  if (GROUP) (sql += ' AND a.group_name = ?'), params.push(GROUP);
  const rows = db.prepare(sql).all(...params);
  console.log(toCsv(rows));
  process.exit(0);
}

if (!SESSION) {
  console.log('\n  Content root: ' + CONTENT_DIR);
  console.log('  Runs:\n');
  let sql = `SELECT r.id, r.course, r.session, r.group_name, r.title, r.started_at, r.ended_at, COUNT(a.id) AS answers
             FROM runs r LEFT JOIN answers a ON a.run_id = r.id`;
  const params = [];
  if (COURSE) (sql += ' WHERE r.course = ?'), params.push(COURSE);
  sql += ' GROUP BY r.id ORDER BY r.started_at DESC';
  const runs = db.prepare(sql).all(...params);
  runs.forEach((r) => {
    const label = (r.course ? r.course + '/' : '') + r.session;
    console.log(
      '    #' + r.id + '  ' + r.started_at.slice(0, 16).replace('T', ' ') + '  ' + label.padEnd(20) + '  ' +
        (r.group_name || '—').padEnd(12) + '  answers: ' + r.answers + '  ' + (r.title || '')
    );
  });
  console.log('\n  Details for one session: presik-report --session ' + (runs[0] ? runs[0].session : 's01') + '\n');
  process.exit(0);
}

// ---- session details: per question — % correct, broken down by group
let sql = `
  SELECT a.qid, a.question_text, a.question_type, a.group_name,
         COUNT(*) AS answered,
         SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
         AVG(CASE WHEN a.question_type = 'scale' THEN CAST(a.value AS REAL) ELSE NULL END) AS avg_scale
  FROM answers a
  WHERE a.session = ?
`;
const params = [SESSION];
if (GROUP) (sql += ' AND a.group_name = ?'), params.push(GROUP);
sql += ' GROUP BY a.qid, a.group_name ORDER BY a.qid, a.group_name';

const rows = db.prepare(sql).all(...params);
if (!rows.length) {
  console.log('\n  No answers for session "' + SESSION + '"' + (GROUP ? ' / group "' + GROUP + '"' : '') + '.\n');
  process.exit(0);
}

console.log('\n  ' + SESSION + (GROUP ? '  ·  group: ' + GROUP : '  ·  all groups') + '\n');
let curQid = null;
for (const r of rows) {
  if (r.qid !== curQid) {
    curQid = r.qid;
    console.log('  ' + r.qid + '  ' + (r.question_text || '').slice(0, 80));
  }
  const group = (r.group_name || '—').padEnd(12);
  if (r.question_type === 'choice') {
    const pct = r.answered ? Math.round((r.correct / r.answered) * 100) : 0;
    console.log('      ' + group + '  correct: ' + r.correct + '/' + r.answered + '  (' + pct + '%)');
  } else if (r.question_type === 'scale') {
    console.log('      ' + group + '  average: ' + (r.avg_scale != null ? r.avg_scale.toFixed(2) : '—') + '  (n=' + r.answered + ')');
  } else {
    console.log('      ' + group + '  answers: ' + r.answered);
  }
}
console.log('');
