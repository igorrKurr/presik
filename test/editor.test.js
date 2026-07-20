// The editor writes a file people also hand-edit and commit — so these cover
// the promises that makes: house formatting, keys we don't own surviving, an id
// materialized before reordering can change it, no silent clobbering, and a
// history that makes every save undoable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formatQuestions, readQuestions, saveQuestions, restoreQuestions, listHistory } = require('../editor');

function session(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presik-editor-'));
  const file = path.join(dir, 'questions.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return { dir, file, dataDir: path.join(dir, '.presik'), name: 's01' };
}
const onDisk = (s) => JSON.parse(fs.readFileSync(s.file, 'utf8'));

test('formatQuestions: the house style — an option stays on one line', () => {
  const out = formatQuestions({
    title: 'T',
    _readme: ['a'],
    questions: [{ id: 'q1', type: 'choice', text: '?', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B', correct: true }] }],
  });
  assert.match(out, /^\s+\{ "id": "a", "text": "A" \},$/m);
  assert.match(out, /^\s+\{ "id": "b", "text": "B", "correct": true \}$/m);
  assert.ok(out.indexOf('"_readme"') < out.indexOf('"questions"'), '"questions" goes last');
  assert.ok(out.endsWith('\n'));
  assert.deepStrictEqual(JSON.parse(out).questions[0].options[1], { id: 'b', text: 'B', correct: true }); // still JSON
});

test('readQuestions: hands the editor a materialized id to hold on to', () => {
  const s = session({ title: 'T', questions: [{ type: 'text', text: 'one' }] });
  assert.strictEqual(readQuestions(s.file, s.name).doc.questions[0].id, 's01-q1');
});

test('saveQuestions: writes the id out, and keeps keys it does not own', () => {
  const s = session({ _readme: ['keep me'], title: 'T', questions: [{ type: 'text', text: 'one' }] });
  const first = readQuestions(s.file, s.name);
  const r = saveQuestions({ file: s.file, dataDir: s.dataDir, sessionName: s.name, doc: first.doc, rev: first.rev });
  assert.ok(r.ok, JSON.stringify(r.errors));
  // The id is now in the file: reordering these questions can no longer change
  // which answers belong to which question.
  assert.strictEqual(onDisk(s).questions[0].id, 's01-q1');
  assert.deepStrictEqual(onDisk(s)._readme, ['keep me']);
});

test('saveQuestions: a broken quiz is refused, and the file is left alone', () => {
  const s = session({ title: 'T', questions: [{ id: 'a', type: 'text', text: 'one' }] });
  const before = fs.readFileSync(s.file, 'utf8');
  const r = saveQuestions({
    file: s.file,
    dataDir: s.dataDir,
    sessionName: s.name,
    doc: { title: 'T', questions: [{ id: 'x', type: 'choice', text: 'no options here' }] },
    rev: null,
  });
  assert.ok(!r.ok);
  assert.match(r.errors.join(), /no options/);
  assert.strictEqual(fs.readFileSync(s.file, 'utf8'), before);
});

test('saveQuestions: refuses to clobber a file that moved under it', () => {
  const s = session({ title: 'T', questions: [{ type: 'text', text: 'one' }] });
  const first = readQuestions(s.file, s.name);
  const r = saveQuestions({ file: s.file, dataDir: s.dataDir, sessionName: s.name, doc: first.doc, rev: first.rev - 5000 });
  assert.ok(!r.ok && r.conflict);
  assert.match(r.errors.join(), /changed on disk/);
});

test('history: the previous version is snapshotted, and restoring is itself undoable', () => {
  const s = session({ title: 'v1', questions: [{ type: 'text', text: 'one' }] });
  const first = readQuestions(s.file, s.name);

  const v2 = JSON.parse(JSON.stringify(first.doc));
  v2.title = 'v2';
  assert.ok(saveQuestions({ file: s.file, dataDir: s.dataDir, sessionName: s.name, doc: v2, rev: first.rev }).ok);
  assert.strictEqual(onDisk(s).title, 'v2');

  // One entry, holding what the file was before the save.
  const hist = listHistory(s.dataDir, s.name, 'questions');
  assert.strictEqual(hist.length, 1);
  assert.ok(!isNaN(Date.parse(hist[0].at)), 'the stamp round-trips to a real date');

  const r = restoreQuestions({ file: s.file, dataDir: s.dataDir, sessionName: s.name, id: hist[0].id });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(onDisk(s).title, 'v1');
  // v2 was kept on the way past, so the restore can be walked back too.
  assert.ok(listHistory(s.dataDir, s.name, 'questions').length >= 2);
});

test('history: a made-up id cannot read outside the history folder', () => {
  const s = session({ title: 'T', questions: [{ type: 'text', text: 'one' }] });
  const r = restoreQuestions({ file: s.file, dataDir: s.dataDir, sessionName: s.name, id: '../../../../etc/passwd' });
  assert.ok(!r.ok);
  assert.match(r.errors.join(), /no such history entry/);
});
