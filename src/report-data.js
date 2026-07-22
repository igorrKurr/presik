// The analytics model — one pure function that turns the answers/runs tables
// (db.js) into a JSON shape both the web report (server.js `/api/report`) and
// the CLI (`report.js --html/--pdf`) render, so the two never drift.
//
// It is *adaptive*: given the current filter it decides a `scope` —
//   • 'session'  a single session is selected → per-question drill-down
//   • 'course'   one course, several sessions → sessions compared over time
//   • 'all'      everything → courses/sessions overview
// and fills only the section that scope needs. The render layer draws whatever
// sections are present, so one deck, one course, or a whole program all get a
// sensible best-fit view from the same code.
//
// DB-first: everything here works off the recorded answers alone, so any
// historical run reports without its questions.json. When that file *is* still
// on disk we enrich choice options with their label text and mark the correct
// one — otherwise we fall back to the raw option id + is_correct, exactly like
// the original text report did.
const fs = require('fs');
const path = require('path');

// round to a whole percent, or null when there's nothing to divide by
function pct(correct, total) {
  return total ? Math.round((correct / total) * 100) : null;
}

// Best-effort read of a session's questions.json for nicer labels. `session` is
// a path relative to the content root (e.g. "web-dev/s01"), same as everywhere
// else, so the file sits at <contentDir>/<session>/questions.json.
function loadQuiz(contentDir, session) {
  if (!contentDir || !session) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(contentDir, session, 'questions.json'), 'utf8'));
    const byId = {};
    for (const q of doc.questions || []) byId[q.id] = q;
    return { title: doc.title, byId };
  } catch (_) {
    return null; // no file (old run, moved content) — labels come from the DB
  }
}

// A WHERE clause + params shared by every query, built from the active filter.
function scopeWhere({ course, session, group }) {
  const cond = [];
  const params = [];
  if (course) (cond.push('course = ?'), params.push(course));
  if (session) (cond.push('session = ?'), params.push(session));
  if (group) (cond.push('group_name = ?'), params.push(group));
  return { where: cond.length ? ' WHERE ' + cond.join(' AND ') : '', params };
}

// The dropdowns the filter row needs: every course, the sessions (optionally
// narrowed to the chosen course), and the groups present under the current filter.
function buildIndex(db, filters) {
  const courses = db.prepare(
    "SELECT DISTINCT course FROM runs WHERE course IS NOT NULL AND course <> '' ORDER BY course"
  ).all().map((r) => r.course);

  const sParams = [];
  let sSql = 'SELECT session, course, MAX(title) AS title, COUNT(*) AS runs, MAX(started_at) AS last_at FROM runs';
  if (filters.course) (sSql += ' WHERE course = ?'), sParams.push(filters.course);
  sSql += ' GROUP BY session, course ORDER BY last_at DESC';
  const sessions = db.prepare(sSql).all(...sParams);

  const { where, params } = scopeWhere({ course: filters.course, session: filters.session });
  const groups = db.prepare(
    'SELECT DISTINCT group_name FROM answers' + where + (where ? ' AND' : ' WHERE') + " group_name IS NOT NULL AND group_name <> '' ORDER BY group_name"
  ).all(...params).map((r) => r.group_name);

  return { courses, sessions, groups };
}

// The KPI tiles for whatever is currently in view.
function buildSummary(db, filters) {
  const { where, params } = scopeWhere(filters);
  const a = db.prepare(
    `SELECT COUNT(*) AS answers,
            COUNT(DISTINCT client_id) AS students,
            COUNT(DISTINCT session) AS sessions,
            COUNT(DISTINCT CASE WHEN course IS NOT NULL AND course <> '' THEN course END) AS courses,
            COUNT(DISTINCT CASE WHEN group_name IS NOT NULL AND group_name <> '' THEN group_name END) AS groups,
            SUM(CASE WHEN question_type = 'choice' AND is_correct IS NOT NULL THEN 1 ELSE 0 END) AS graded,
            SUM(CASE WHEN question_type = 'choice' AND is_correct = 1 THEN 1 ELSE 0 END) AS correct
     FROM answers` + where
  ).get(...params);
  const rw = scopeWhere({ course: filters.course, session: filters.session });
  const runs = db.prepare('SELECT COUNT(*) AS n FROM runs' + rw.where).get(...rw.params).n;
  return {
    runs,
    sessions: a.sessions || 0,
    courses: a.courses || 0,
    groups: a.groups || 0,
    students: a.students || 0,
    answers: a.answers || 0,
    correctPct: pct(a.correct, a.graded),
  };
}

// ---- 'all' / 'course' scope: sessions and courses compared -----------------
function buildOverview(db, filters) {
  const { where, params } = scopeWhere({ course: filters.course, group: filters.group });

  const sessions = db.prepare(
    `SELECT session, MAX(course) AS course,
            COUNT(*) AS answers, COUNT(DISTINCT client_id) AS students,
            SUM(CASE WHEN question_type='choice' AND is_correct IS NOT NULL THEN 1 ELSE 0 END) AS graded,
            SUM(CASE WHEN question_type='choice' AND is_correct=1 THEN 1 ELSE 0 END) AS correct,
            MIN(answered_at) AS first_at, MAX(answered_at) AS last_at
     FROM answers` + where + ' GROUP BY session ORDER BY last_at DESC'
  ).all(...params).map((s) => ({
    session: s.session,
    course: s.course || null,
    title: (loadQuiz(filters.contentDir, s.session) || {}).title || s.session,
    answers: s.answers,
    students: s.students,
    correctPct: pct(s.correct, s.graded),
    firstAt: s.first_at,
    lastAt: s.last_at,
  }));

  const courses = db.prepare(
    `SELECT course,
            COUNT(DISTINCT session) AS sessions, COUNT(*) AS answers,
            COUNT(DISTINCT client_id) AS students,
            SUM(CASE WHEN question_type='choice' AND is_correct IS NOT NULL THEN 1 ELSE 0 END) AS graded,
            SUM(CASE WHEN question_type='choice' AND is_correct=1 THEN 1 ELSE 0 END) AS correct
     FROM answers WHERE course IS NOT NULL AND course <> ''` + (filters.group ? ' AND group_name = ?' : '') +
     ' GROUP BY course ORDER BY course'
  ).all(...(filters.group ? [filters.group] : [])).map((c) => ({
    course: c.course,
    sessions: c.sessions,
    answers: c.answers,
    students: c.students,
    correctPct: pct(c.correct, c.graded),
  }));

  const groups = db.prepare(
    `SELECT group_name AS grp, COUNT(*) AS answers, COUNT(DISTINCT client_id) AS students,
            SUM(CASE WHEN question_type='choice' AND is_correct IS NOT NULL THEN 1 ELSE 0 END) AS graded,
            SUM(CASE WHEN question_type='choice' AND is_correct=1 THEN 1 ELSE 0 END) AS correct
     FROM answers` + where + (where ? ' AND' : ' WHERE') + " group_name IS NOT NULL AND group_name <> ''" +
     ' GROUP BY group_name ORDER BY group_name'
  ).all(...params).map((g) => ({ group: g.grp, answers: g.answers, students: g.students, correctPct: pct(g.correct, g.graded) }));

  // One point per run: the trend line / sparkline over time.
  const rw = scopeWhere({ course: filters.course, group: filters.group });
  const timeline = db.prepare(
    `SELECT r.id, r.session, r.group_name AS grp, r.started_at,
            (SELECT COUNT(*) FROM answers a WHERE a.run_id = r.id) AS answers,
            (SELECT COUNT(DISTINCT client_id) FROM answers a WHERE a.run_id = r.id) AS students,
            (SELECT SUM(CASE WHEN a.question_type='choice' AND a.is_correct=1 THEN 1 ELSE 0 END) FROM answers a WHERE a.run_id = r.id) AS correct,
            (SELECT SUM(CASE WHEN a.question_type='choice' AND a.is_correct IS NOT NULL THEN 1 ELSE 0 END) FROM answers a WHERE a.run_id = r.id) AS graded
     FROM runs r` + rw.where + ' ORDER BY r.started_at'
  ).all(...rw.params)
    .filter((r) => r.answers > 0)
    .map((r) => ({ at: r.started_at, session: r.session, group: r.grp, answers: r.answers, students: r.students, correctPct: pct(r.correct, r.graded) }));

  return { courses, sessions, groups, timeline };
}

// ---- 'session' scope: the per-question drill-down ---------------------------
function buildSession(db, filters) {
  const quiz = loadQuiz(filters.contentDir, filters.session);
  const { where, params } = scopeWhere(filters);

  // Every recorded answer for the session, in question order, so we can build
  // distributions/averages/text lists and the per-group split in one pass.
  const rows = db.prepare(
    `SELECT qid, question_text, question_type, group_name, client_id, value, is_correct
     FROM answers` + where + ' ORDER BY qid'
  ).all(...params);

  const order = [];
  const q = {};
  for (const r of rows) {
    if (!q[r.qid]) {
      order.push(r.qid);
      const def = quiz && quiz.byId[r.qid];
      q[r.qid] = {
        qid: r.qid,
        text: (def && def.text) || r.question_text || r.qid,
        type: r.question_type,
        answered: 0,
        graded: 0,
        correct: 0,
        counts: {},        // value → n  (choice/scale distribution)
        texts: [],         // free-text answers
        _def: def || null,
        _groups: {},       // group → { answered, graded, correct, sum, n }
      };
    }
    const item = q[r.qid];
    item.answered++;
    if (r.question_type === 'text') {
      if (r.value != null && r.value !== '') item.texts.push(r.value);
    } else {
      item.counts[r.value] = (item.counts[r.value] || 0) + 1;
    }
    if (r.is_correct != null) { item.graded++; if (r.is_correct === 1) item.correct++; }

    const g = (item._groups[r.group_name || ''] ||= { answered: 0, graded: 0, correct: 0, sum: 0, n: 0 });
    g.answered++;
    if (r.is_correct != null) { g.graded++; if (r.is_correct === 1) g.correct++; }
    if (r.question_type === 'scale') { const v = Number(r.value); if (!Number.isNaN(v)) { g.sum += v; g.n++; } }
  }

  const questions = order.map((qid) => {
    const item = q[qid];
    const def = item._def;
    const out = { qid, text: item.text, type: item.type, answered: item.answered, correctPct: pct(item.correct, item.graded) };

    if (item.type === 'choice') {
      // Prefer the authored options (keeps zero-pick options and their order);
      // fall back to whatever values were actually recorded.
      const opts = def && def.options
        ? def.options.map((o) => ({ id: o.id, text: o.text, correct: !!o.correct }))
        : Object.keys(item.counts).map((id) => ({ id, text: id, correct: false }));
      const total = opts.reduce((s, o) => s + (item.counts[o.id] || 0), 0);
      out.options = opts.map((o) => ({ ...o, n: item.counts[o.id] || 0, pct: total ? Math.round(((item.counts[o.id] || 0) / total) * 100) : 0 }));
    } else if (item.type === 'scale') {
      const min = def && def.min != null ? def.min : Math.min(...Object.keys(item.counts).map(Number), 0);
      const max = def && def.max != null ? def.max : Math.max(...Object.keys(item.counts).map(Number), 5);
      out.min = min; out.max = max;
      out.bins = [];
      let sum = 0, n = 0;
      for (let v = min; v <= max; v++) { const c = item.counts[v] || 0; out.bins.push({ value: v, n: c }); sum += v * c; n += c; }
      out.avg = n ? +(sum / n).toFixed(2) : null;
    } else {
      out.texts = item.texts;
    }

    out.byGroup = Object.entries(item._groups)
      .filter(([g]) => g !== '')
      .map(([g, v]) => ({ group: g, answered: v.answered, correctPct: pct(v.correct, v.graded), avg: v.n ? +(v.sum / v.n).toFixed(2) : null }))
      .sort((a, b) => a.group.localeCompare(b.group));
    return out;
  });

  // Group totals across the whole session (for the group-comparison view).
  const gAgg = {};
  for (const r of rows) {
    const g = r.group_name || '';
    if (g === '') continue;
    const it = (gAgg[g] ||= { answered: 0, graded: 0, correct: 0, students: new Set() });
    it.answered++; it.students.add(r.client_id);
    if (r.is_correct != null) { it.graded++; if (r.is_correct === 1) it.correct++; }
  }
  const groups = Object.entries(gAgg)
    .map(([g, v]) => ({ group: g, answered: v.answered, students: v.students.size, correctPct: pct(v.correct, v.graded) }))
    .sort((a, b) => a.group.localeCompare(b.group));

  // question × group correct% grid — only meaningful with >1 group.
  const heatmap = groups.length > 1 ? {
    groups: groups.map((g) => g.group),
    questions: questions.filter((qq) => qq.type === 'choice').map((qq) => ({ qid: qq.qid, text: qq.text })),
    cells: [],
  } : null;
  if (heatmap) {
    for (const qq of questions) {
      if (qq.type !== 'choice') continue;
      for (const bg of qq.byGroup) heatmap.cells.push({ qid: qq.qid, group: bg.group, correctPct: bg.correctPct, answered: bg.answered });
    }
  }

  const title = (quiz && quiz.title) || (db.prepare('SELECT title FROM runs WHERE session = ? ORDER BY started_at DESC LIMIT 1').get(filters.session) || {}).title || filters.session;
  const course = (db.prepare('SELECT course FROM runs WHERE session = ? AND course IS NOT NULL LIMIT 1').get(filters.session) || {}).course || null;
  return { course, session: filters.session, title, questions, groups, heatmap };
}

// The one entry point. `filters` = { course, session, group, contentDir }.
function buildReport(db, filters = {}) {
  const f = {
    course: filters.course || null,
    session: filters.session || null,
    group: filters.group || null,
    contentDir: filters.contentDir || null,
  };
  const index = buildIndex(db, f);

  // Decide scope. An explicit session wins. Otherwise: a course with sessions →
  // 'course'; a single session in the whole DB collapses to 'session'; else 'all'.
  let scope;
  let session = f.session;
  if (f.session) scope = 'session';
  else if (f.course) scope = 'course';
  else if (index.sessions.length === 1) { scope = 'session'; session = index.sessions[0].session; }
  else scope = 'all';

  const effective = { ...f, session };
  const model = {
    generatedAt: new Date().toISOString(),
    scope,
    filters: { course: f.course, session, group: f.group },
    index,
    summary: buildSummary(db, effective),
  };
  if (scope === 'session') model.session = buildSession(db, effective);
  else model.overview = buildOverview(db, effective);
  return model;
}

module.exports = { buildReport };
