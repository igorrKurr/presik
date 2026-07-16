// One SQLite database for the whole content root: all courses, all
// sessions, all groups, all server runs. Purpose is analysis "across
// multiple classes and courses" (report.js) AND crash/sleep recovery of the
// live run (server.js rehydrates its in-memory state from here on restart).
//
// Uses node:sqlite (built into Node — no native module to compile, no
// node-gyp, no ABI-mismatch crash after a Node upgrade). On Node 22.5–23.3
// it needs the --experimental-sqlite flag; bin/ re-execs with it (sqlite-guard.js).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 4000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course TEXT,
      session TEXT NOT NULL,
      group_name TEXT,
      title TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      cur_index INTEGER,
      revealed INTEGER
    );
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      course TEXT,
      session TEXT NOT NULL,
      group_name TEXT,
      qid TEXT NOT NULL,
      question_text TEXT,
      question_type TEXT,
      client_id TEXT NOT NULL,
      value TEXT NOT NULL,
      is_correct INTEGER,
      answered_at TEXT NOT NULL,
      UNIQUE(run_id, qid, client_id)
    );
    CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session);
    CREATE INDEX IF NOT EXISTS idx_answers_group ON answers(group_name);
    CREATE INDEX IF NOT EXISTS idx_answers_qid ON answers(qid);
    CREATE INDEX IF NOT EXISTS idx_answers_run ON answers(run_id);
  `);
  // Databases created by older versions quietly grow the schema.
  ensureColumn(db, 'runs', 'course', 'course TEXT');
  ensureColumn(db, 'answers', 'course', 'course TEXT');
  ensureColumn(db, 'runs', 'cur_index', 'cur_index INTEGER'); // live slide index (for resume)
  ensureColumn(db, 'runs', 'revealed', 'revealed INTEGER'); // live revealed flag (for resume)
  db.exec('CREATE INDEX IF NOT EXISTS idx_answers_course ON answers(course)');
  return db;
}

module.exports = { openDb };
