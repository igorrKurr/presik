// One SQLite database for the whole content root: all courses, all
// sessions, all groups, all server runs. Purpose is analysis "across
// multiple classes and courses" (report.js), not a replacement for the
// live in-class state (that stays in process memory — see server.js).
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course TEXT,
      session TEXT NOT NULL,
      group_name TEXT,
      title TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
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
  `);
  // databases created before "course" existed (multi-course root) quietly grow the schema
  ensureColumn(db, 'runs', 'course', 'course TEXT');
  ensureColumn(db, 'answers', 'course', 'course TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_answers_course ON answers(course)');
  return db;
}

module.exports = { openDb };
