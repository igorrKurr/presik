const test = require('node:test');
const assert = require('node:assert');
const { resolveProvider, parseTunnelUrl, DEFAULT_PROVIDER } = require('../src/tunnel');

test('resolveProvider: bare --tunnel is localhost.run; names and aliases; unknown → null', () => {
  assert.strictEqual(DEFAULT_PROVIDER, 'localhost.run');
  assert.strictEqual(resolveProvider(true), 'localhost.run');
  assert.strictEqual(resolveProvider('true'), 'localhost.run'); // npm_config_tunnel from `npm run x --tunnel`
  assert.strictEqual(resolveProvider(''), 'localhost.run'); // `--tunnel=`
  assert.strictEqual(resolveProvider('cloudflare'), 'cloudflare');
  assert.strictEqual(resolveProvider('Cloudflared'), 'cloudflare');
  assert.strictEqual(resolveProvider('lhr'), 'localhost.run');
  assert.strictEqual(resolveProvider('ngrok'), null);
});

test('parseTunnelUrl: localhost.run — only the tunnel line, not the banner links', () => {
  const banner =
    'To set up and manage custom domains go to https://admin.localhost.run/\n' +
    'More details at https://localhost.run/docs/custom-domains\n';
  assert.strictEqual(parseTunnelUrl('localhost.run', banner), null);
  assert.strictEqual(
    parseTunnelUrl('localhost.run', 'd9ae2cc17e66f5.lhr.life tunneled with tls termination, https://d9ae2cc17e66f5.lhr.life\n'),
    'https://d9ae2cc17e66f5.lhr.life/'
  );
});

test('parseTunnelUrl: cloudflare — the quick-tunnel host, never api.trycloudflare.com', () => {
  assert.strictEqual(
    parseTunnelUrl('cloudflare', 'INF |  https://jury-cached-shopping-prediction.trycloudflare.com   |'),
    'https://jury-cached-shopping-prediction.trycloudflare.com/'
  );
  assert.strictEqual(parseTunnelUrl('cloudflare', 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"'), null);
});
