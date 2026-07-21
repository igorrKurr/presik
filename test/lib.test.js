const test = require('node:test');
const assert = require('node:assert');
const { parsePackageRef, versionSatisfies, pickPackageDir } = require('../widgets');
const { validateAnswer, effectiveKind, isSafeWidgetSrc, isRemoteWidgetUrl, isPackageRef, groupSlug, sessionSlug, parseArgs, rankHostIps, bestHostIp, toSessionName, buildDeckSteps, splitMarpSlides, deriveMarpMarkdown, pickConverters, normalizeQuiz, validateConfigObject, mergeConfig, historyToPrune } = require('../lib');

test('validateAnswer: choice accepts only real option ids', () => {
  const q = { type: 'choice', options: [{ id: 'a' }, { id: 'b' }] };
  assert.strictEqual(validateAnswer(q, 'a'), 'a');
  assert.strictEqual(validateAnswer(q, 'b'), 'b');
  assert.strictEqual(validateAnswer(q, 'zzz'), null); // junk that would pollute the archive
  assert.strictEqual(validateAnswer(q, ''), null);
  assert.strictEqual(validateAnswer(q, null), null);
});

test('validateAnswer: scale enforces the numeric range', () => {
  const q = { type: 'scale', min: 1, max: 5 };
  assert.strictEqual(validateAnswer(q, '3'), '3');
  assert.strictEqual(validateAnswer(q, 3), '3'); // number coerced
  assert.strictEqual(validateAnswer(q, '1'), '1');
  assert.strictEqual(validateAnswer(q, '5'), '5');
  assert.strictEqual(validateAnswer(q, '0'), null);
  assert.strictEqual(validateAnswer(q, '6'), null);
  assert.strictEqual(validateAnswer(q, 'x'), null);
  assert.strictEqual(validateAnswer(q, '3.5'), null);
});

test('validateAnswer: text trims, rejects empty, caps length', () => {
  const q = { type: 'text' };
  assert.strictEqual(validateAnswer(q, '  hi  '), 'hi');
  assert.strictEqual(validateAnswer(q, '   '), null);
  assert.strictEqual(validateAnswer(q, 'x'.repeat(1000)).length, 600);
});

test('validateAnswer: a widget answers to its declared kind, not to "widget"', () => {
  // choice-widget — the sandboxed game can only report a legal option id
  const wc = { type: 'widget', answer: 'choice', options: [{ id: 'north' }, { id: 'east' }] };
  assert.strictEqual(validateAnswer(wc, 'east'), 'east');
  assert.strictEqual(validateAnswer(wc, 'cheat'), null); // game can't stuff junk past the gate
  // scale-widget — same numeric range gate as a plain scale
  const ws = { type: 'widget', answer: 'scale', min: 0, max: 3 };
  assert.strictEqual(validateAnswer(ws, '2'), '2');
  assert.strictEqual(validateAnswer(ws, '9'), null);
  // no explicit answer defaults to choice
  assert.strictEqual(effectiveKind({ type: 'widget' }), 'choice');
  assert.strictEqual(effectiveKind({ type: 'scale' }), 'scale');
});

test('isSafeWidgetSrc: only a relative path that stays inside the session folder', () => {
  assert.ok(isSafeWidgetSrc('widgets/dungeon/index.html'));
  assert.ok(isSafeWidgetSrc('game.html'));
  assert.ok(!isSafeWidgetSrc('../secrets.json'));
  assert.ok(!isSafeWidgetSrc('/etc/passwd'));
  assert.ok(!isSafeWidgetSrc('https://evil.example/x'));
  assert.ok(!isSafeWidgetSrc('a/../../b'));
  assert.ok(!isSafeWidgetSrc(''));
});

test('isRemoteWidgetUrl: only absolute http(s) URLs', () => {
  assert.ok(isRemoteWidgetUrl('https://games.example.edu/dungeon/v3/'));
  assert.ok(isRemoteWidgetUrl('http://localhost:5173'));
  assert.ok(!isRemoteWidgetUrl('widgets/game/index.html'));
  assert.ok(!isRemoteWidgetUrl('ftp://x/y'));
  assert.ok(!isRemoteWidgetUrl('javascript:alert(1)'));
  assert.ok(!isRemoteWidgetUrl(''));
});

test('isPackageRef: a name or name@version, never a path', () => {
  assert.ok(isPackageRef('dungeon-escape'));
  assert.ok(isPackageRef('dungeon-escape@3'));
  assert.ok(isPackageRef('dungeon_escape@3.2.0-beta.1'));
  assert.ok(!isPackageRef('../x'));
  assert.ok(!isPackageRef('a/b'));
  assert.ok(!isPackageRef('has..dots'));
  assert.ok(!isPackageRef(''));
});

test('widget packages: ref parsing + version resolution picks the highest match', () => {
  assert.deepStrictEqual(parsePackageRef('game@3.2.0'), { name: 'game', version: '3.2.0' });
  assert.deepStrictEqual(parsePackageRef('game'), { name: 'game', version: null });
  // prefix satisfaction: "3" and "3.2" are ranges, an exact version matches itself
  assert.ok(versionSatisfies('3.2.0', '3'));
  assert.ok(versionSatisfies('3.2.0', '3.2'));
  assert.ok(!versionSatisfies('30.0.0', '3'));
  assert.ok(versionSatisfies('3.2.0', null));
  const dirs = ['game@3.1.0', 'game@3.2.5', 'game@2.9.0', 'other@1.0.0'];
  assert.strictEqual(pickPackageDir(dirs, 'game'), 'game@3.2.5');       // highest overall
  assert.strictEqual(pickPackageDir(dirs, 'game@3'), 'game@3.2.5');      // highest under 3
  assert.strictEqual(pickPackageDir(dirs, 'game@3.1.0'), 'game@3.1.0');  // exact
  assert.strictEqual(pickPackageDir(dirs, 'game@9'), null);              // nothing satisfies
  assert.strictEqual(pickPackageDir(dirs, 'missing'), null);
});

test('normalizeQuiz: a widget can be sourced from a vendored package', () => {
  const err = normalizeQuiz({ questions: [{ type: 'widget', text: 'a', answer: 'choice',
    options: [{ id: 'east', text: 'E', correct: true }], widget: { package: 'dungeon-escape@3' } }] }, 's01').errors;
  assert.deepStrictEqual(err, []);
  const bad = normalizeQuiz({ questions: [{ type: 'widget', text: 'a', answer: 'text', widget: { package: '../evil' } }] }, 's01').errors;
  assert.match(bad.join(' '), /"package" must be a name or name@version/);
});

test('normalizeQuiz: a valid widget passes, borrowing its answer kind for grading', () => {
  const r = normalizeQuiz({ questions: [{
    type: 'widget', text: 'Escape', answer: 'choice',
    options: [{ id: 'north', text: 'North' }, { id: 'east', text: 'East', correct: true }],
    widget: { srcdoc: '<canvas></canvas>', height: 460, config: { seed: 1 } },
  }] }, 's01');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.quiz.questions[0].answer, 'choice');
});

test('normalizeQuiz: widget errors on what would actually break a class', () => {
  const err = (q) => normalizeQuiz({ questions: [].concat(q) }, 's01').errors.join(' | ');
  assert.match(err({ type: 'widget', text: 'a', widget: { srcdoc: 'x' }, answer: 'bogus' }), /answer.*must be one of/);
  assert.match(err({ type: 'widget', text: 'a', answer: 'choice', widget: { srcdoc: 'x' } }), /answer=choice.*no options/);
  assert.match(err({ type: 'widget', text: 'a', answer: 'text' }), /needs a "widget" object/);
  assert.match(err({ type: 'widget', text: 'a', answer: 'text', widget: {} }), /needs one of srcdoc, src, url, dev/);
  assert.match(err({ type: 'widget', text: 'a', answer: 'text', widget: { srcdoc: 'x', src: 'y.html' } }), /more than one source/);
  assert.match(err({ type: 'widget', text: 'a', answer: 'text', widget: { src: '../x.html' } }), /must be a relative path/);
  assert.match(err({ type: 'widget', text: 'a', answer: 'text', widget: { url: 'not-a-url' } }), /"url" must be an absolute http/);
  assert.match(err({ type: 'widget', text: 'a', answer: 'text', widget: { dev: 'ftp://x' } }), /"dev" must be an absolute http/);
  assert.match(err({ type: 'widget', text: 'a', answer: 'text', widget: { srcdoc: 'x', isolate: 'yes' } }), /"isolate" must be true or false/);
  assert.match(err({ type: 'widget', text: 'a', answer: 'text', widget: { srcdoc: 'x', height: 99999 } }), /"height" must be between/);
  // each source is valid on its own
  const ok = (w) => normalizeQuiz({ questions: [{ type: 'widget', text: 'a', answer: 'text', widget: w }] }, 's01').errors;
  assert.deepStrictEqual(ok({ srcdoc: '<p>x' }), []);
  assert.deepStrictEqual(ok({ src: 'widgets/g/index.html' }), []);
  assert.deepStrictEqual(ok({ url: 'https://games.example.edu/dungeon/v3/' }), []);
  assert.deepStrictEqual(ok({ dev: 'http://localhost:5173', isolate: true }), []);
});

test('groupSlug: filename-safe, capped, nullable', () => {
  assert.strictEqual(groupSlug('3-A'), '3-A');
  assert.strictEqual(groupSlug('  Group 1 / cohort  '), 'Group-1-cohort');
  assert.strictEqual(groupSlug(null), null);
  assert.strictEqual(groupSlug(''), null);
  assert.strictEqual(groupSlug('x'.repeat(100)).length, 40);
});

test('rankHostIps: prefers real LAN over VPN/virtual, and localhost fallback', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
    utun3: [{ address: '10.8.0.2', family: 'IPv4', internal: false }], // VPN
    'bridge100': [{ address: '10.0.0.1', family: 'IPv4', internal: false }],
  };
  assert.strictEqual(bestHostIp(ifaces), '192.168.1.42');
  const ranked = rankHostIps(ifaces);
  assert.strictEqual(ranked[0].address, '192.168.1.42');
  assert.ok(ranked.every((c) => c.address !== '127.0.0.1')); // internal excluded
  assert.strictEqual(bestHostIp({}), 'localhost');
});

test('rankHostIps: handles numeric family (Node os module form)', () => {
  const ifaces = { en0: [{ address: '10.1.2.3', family: 4, internal: false }] };
  assert.strictEqual(bestHostIp(ifaces), '10.1.2.3');
});

test('toSessionName: POSIX path relative to root, "." for the root itself', () => {
  assert.strictEqual(toSessionName('/a', '/a/s01', '/'), 's01');
  assert.strictEqual(toSessionName('/a', '/a/web-dev/s01', '/'), 'web-dev/s01');
  assert.strictEqual(toSessionName('/a', '/a', '/'), '.');
});

test('buildDeckSteps: interleaves question+reveal after each placed page', () => {
  const qs = [{ id: 'q1', slide: 2 }, { id: 'q2', slide: 3 }, { id: 'q3' }]; // q3 has no slide → not in the deck
  assert.deepStrictEqual(buildDeckSteps(4, qs), [
    { t: 'page', page: 1 },
    { t: 'page', page: 2 }, { t: 'question', qi: 0 }, { t: 'reveal', qi: 0 },
    { t: 'page', page: 3 }, { t: 'question', qi: 1 }, { t: 'reveal', qi: 1 },
    { t: 'page', page: 4 },
  ]);
});

test('buildDeckSteps: multiple questions on one page keep questions.json order', () => {
  const steps = buildDeckSteps(1, [{ id: 'a', slide: 1 }, { id: 'b', slide: 1 }]);
  assert.deepStrictEqual(steps.map((s) => s.t + (s.qi ?? '')), ['page', 'question0', 'reveal0', 'question1', 'reveal1']);
});

test('splitMarpSlides: front-matter + separators, ignoring code fences', () => {
  const md = '---\nmarp: true\n---\n\n# One\n\n---\n\n# Two\n```\n---\n```\n\n---\n\n# Three';
  const { front, slides } = splitMarpSlides(md);
  assert.match(front, /marp: true/);
  assert.strictEqual(slides.length, 3);
  assert.match(slides[0], /# One/);
  assert.match(slides[1], /# Two/);
  assert.match(slides[1], /---/); // the --- inside the fence stayed inside slide 2
  assert.match(slides[2], /# Three/);
});

test('deriveMarpMarkdown: inserts question+reveal after the placed slide', () => {
  const md = '---\nmarp: true\n---\n\n# One\n\n---\n\n# Two';
  const out = deriveMarpMarkdown(md, [{ id: 'q1', slide: 1 }]);
  const iOne = out.indexOf('# One'), iQ = out.indexOf('data-quiz-question="q1"'), iR = out.indexOf('data-quiz-reveal="q1"'), iTwo = out.indexOf('# Two');
  assert.ok(iOne < iQ && iQ < iR && iR < iTwo, 'markers land between slide One and Two, question before reveal');
  assert.strictEqual(splitMarpSlides(out).slides.length, 4); // One, question, reveal, Two
});

test('deriveMarpMarkdown: no placed questions → unchanged', () => {
  const md = '---\nmarp: true\n---\n\n# One';
  assert.strictEqual(deriveMarpMarkdown(md, [{ id: 'q1' }]), md);
});

test('normalizeQuiz: fills in the ids and defaults the schema promises', () => {
  const r = normalizeQuiz(
    { title: 't', questions: [{ type: 'choice', text: 'q', options: [{ id: 'a', text: 'A' }] }, { type: 'scale', text: 's' }] },
    'web-dev/s01'
  );
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.quiz.questions[0].id, 'web-dev-s01-q1'); // session path → id prefix
  assert.strictEqual(r.quiz.questions[1].min, 1);
  assert.strictEqual(r.quiz.questions[1].max, 5);
});

test('normalizeQuiz: errors only on what would actually break a class', () => {
  const err = (q) => normalizeQuiz({ questions: [].concat(q) }, 's01').errors.join(' | ');
  assert.match(err([{ id: 'x', type: 'text', text: 'a' }, { id: 'x', type: 'text', text: 'b' }]), /duplicate id/);
  assert.match(err({ type: 'choice', text: 'a' }), /no options/);
  assert.match(err({ type: 'poll', text: 'a' }), /unknown type/);
  assert.match(err({ type: 'text', text: 'a', slide: 0 }), /positive integer/);
  assert.match(err({ type: 'scale', text: 'a', min: 5, max: 2 }), /below/);
  assert.match(normalizeQuiz({ questions: [] }, 's01').errors.join(), /no "questions" array/);
});

test('normalizeQuiz: a half-typed question warns, but still saves', () => {
  // The editor saves as you type — an empty question for a few seconds is
  // normal and must not fail the write.
  const r = normalizeQuiz({ questions: [{ type: 'text', text: '   ' }] }, 's01');
  assert.deepStrictEqual(r.errors, []);
  assert.match(r.warnings.join(), /no question text/);
});

test('normalizeQuiz: a 0-based scale survives ("0" is a bound, not "unset")', () => {
  const r = normalizeQuiz({ questions: [{ type: 'scale', text: 'a', min: 0, max: 10 }] }, 's01');
  assert.strictEqual(r.quiz.questions[0].min, 0);
});

test('normalizeQuiz: a runaway scale range is rejected (would flood stats/render)', () => {
  const err = (q) => normalizeQuiz({ questions: [].concat(q) }, 's01').errors.join(' | ');
  assert.match(err({ type: 'scale', text: 'a', min: 1, max: 2026 }), /too wide/);
  // 100 steps exactly is fine; the tiny common ranges obviously are.
  assert.deepStrictEqual(normalizeQuiz({ questions: [{ type: 'scale', text: 'a', min: 0, max: 100 }] }, 's01').errors, []);
  assert.deepStrictEqual(normalizeQuiz({ questions: [{ type: 'scale', text: 'a', min: 1, max: 5 }] }, 's01').errors, []);
});

test('normalizeQuiz: keeps the file quiet — only correct options flagged, no slide:null', () => {
  const r = normalizeQuiz(
    { questions: [{ type: 'choice', text: 'a', slide: null, options: [{ id: 'a', text: 'A', correct: false }, { id: 'b', text: 'B', correct: true }] }] },
    's01'
  );
  assert.ok(!('correct' in r.quiz.questions[0].options[0]));
  assert.strictEqual(r.quiz.questions[0].options[1].correct, true);
  assert.ok(!('slide' in r.quiz.questions[0]));
});

test('normalizeQuiz: top-level keys it does not know about survive (e.g. _readme)', () => {
  const r = normalizeQuiz({ _readme: ['x'], title: 't', questions: [{ type: 'text', text: 'a' }] }, 's01');
  assert.deepStrictEqual(r.quiz._readme, ['x']);
});

test('validateConfigObject: types, unknown keys, and the CLI-only ones', () => {
  assert.deepStrictEqual(validateConfigObject({ port: 8080, key: 'w', tunnel: true, qr: 'a.svg' }, 'f'), []);
  assert.deepStrictEqual(validateConfigObject({ group: null }, 'f'), []); // null reads as "not set"
  assert.match(validateConfigObject({ port: '8080' }, 'f').join(), /whole number/);
  assert.match(validateConfigObject({ port: 99999 }, 'f').join(), /between 1 and 65535/);
  assert.match(validateConfigObject({ tunnel: 'yes' }, 'f').join(), /true or false/);
  assert.match(validateConfigObject({ nope: 1 }, 'f').join(), /unknown setting/);
  assert.match(validateConfigObject({ dir: '/x' }, 'f').join(), /command line/); // would be circular
  assert.match(validateConfigObject([], 'f').join(), /JSON object/);
});

test('mergeConfig: later layers win key-by-key, null never overrides', () => {
  assert.deepStrictEqual(mergeConfig([{ port: 1, key: 'a' }, { port: 2 }]), { port: 2, key: 'a' });
  assert.deepStrictEqual(mergeConfig([{ key: 'a' }, { key: null }]), { key: 'a' });
  assert.deepStrictEqual(mergeConfig([]), {});
});

test('historyToPrune: drops the oldest past the cap, keeps order chronological', () => {
  const n = ['questions-2026-01-01T00-00-01-000.json', 'questions-2026-01-01T00-00-02-000.json', 'questions-2026-01-01T00-00-03-000.json'];
  assert.deepStrictEqual(historyToPrune(n, 2), [n[0]]);
  assert.deepStrictEqual(historyToPrune(n, 5), []);
  assert.deepStrictEqual(historyToPrune([], 5), []);
});

test('pickConverters: fidelity-first ordering, per format and tool availability', () => {
  // .key → Keynote only
  assert.deepStrictEqual(pickConverters('.key', { keynote: true, soffice: true }), ['keynote']);
  assert.deepStrictEqual(pickConverters('.key', { keynote: false, soffice: true }), []); // soffice can't do .key
  // .pptx → PowerPoint before LibreOffice
  assert.deepStrictEqual(pickConverters('.pptx', { powerpoint: true, soffice: true }), ['powerpoint', 'soffice']);
  assert.deepStrictEqual(pickConverters('.pptx', { powerpoint: false, soffice: true }), ['soffice']);
  assert.deepStrictEqual(pickConverters('.pptx', {}), []);
  // already-PDF / unknown → nothing to convert
  assert.deepStrictEqual(pickConverters('.pdf', { soffice: true }), []);
});

test('sessionSlug: POSIX path → one filesystem-safe token', () => {
  assert.strictEqual(sessionSlug('s01'), 's01');
  assert.strictEqual(sessionSlug('web-dev/s01'), 'web-dev-s01');
  assert.strictEqual(sessionSlug('a/b/c'), 'a-b-c');
  assert.strictEqual(sessionSlug(''), 'session'); // never empty — it names files
  assert.strictEqual(sessionSlug(null), 'session');
});

test('parseArgs: positionals, valued flags, and opt/has lookups', () => {
  const a = parseArgs(['s01', '--dir', 'x/y', '--tunnel', 'extra'], ['dir', 'port']);
  // "x/y" is --dir's value, so it isn't a positional; "s01" and "extra" are.
  assert.deepStrictEqual(a.positional, ['s01', 'extra']);
  assert.strictEqual(a.opt('dir', null), 'x/y');
  assert.strictEqual(a.has('tunnel'), true);
  assert.strictEqual(a.has('nope'), false);
  assert.strictEqual(a.opt('port', 3000), 3000); // absent → default
});

test('parseArgs: a flag with no value reads as absent, not as the next flag', () => {
  const a = parseArgs(['--key', '--tunnel'], ['key']);
  assert.strictEqual(a.opt('key', null), null); // --tunnel isn't --key's value
  assert.strictEqual(a.has('tunnel'), true);
  assert.deepStrictEqual(a.positional, []);
});
