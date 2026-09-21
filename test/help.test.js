const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { helpText, TOPICS } = require('../src/help');
const { CONFIG_SPEC } = require('../src/lib');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

test('helpText: every topic renders, aliases resolve, unknown is null', () => {
  for (const t of Object.keys(TOPICS)) assert.ok(helpText(t === 'overview' ? undefined : t).length > 100, t);
  assert.strictEqual(helpText('settings'), helpText('config'));
  assert.strictEqual(helpText('nope'), null);
});

test('helpText: every presik.config.json key is documented', () => {
  const text = helpText('config');
  for (const k of Object.keys(CONFIG_SPEC)) assert.match(text, new RegExp('^\\s+' + k + '\\s', 'm'), k);
});

test('cli: --help, help <topic>, <sub> --help, and --version exit 0 without starting a server', () => {
  const overview = run('--help');
  assert.strictEqual(overview.status, 0);
  assert.match(overview.stdout, /presik help run/);
  assert.match(run('help', 'report').stdout, /--csv/);
  assert.match(run('new', '--help').stdout, /--questions-only/);
  assert.match(run('export', '--help').stdout, /--with-quiz/);
  assert.match(run('s01', '-h').stdout, /--tunnel/);
  assert.match(run('--version').stdout, /^\d+\.\d+\.\d+/);
});

test('cli: an unknown help topic exits non-zero', () => {
  const r = run('help', 'nope');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /No help topic "nope"/);
});
