const test = require('node:test');
const assert = require('node:assert');
const { validateAnswer, groupSlug, rankHostIps, bestHostIp, toSessionName, buildDeckSteps } = require('../lib');

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
