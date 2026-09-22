'use strict';
/**
 * `--tunnel`: a public https URL for students off the local network.
 *
 * Two providers, both account-less:
 *
 *   localhost.run (default) — `ssh -R` to localhost.run. ssh ships with macOS,
 *     Linux and Windows 10+, so there is nothing to install. The free address
 *     can change when the connection drops; we reconnect and report the new one.
 *
 *   cloudflare (--tunnel=cloudflare) — a cloudflared quick tunnel on
 *     trycloudflare.com. Needs cloudflared installed. Some mobile carriers block
 *     trycloudflare.com outright (connections to it just hang), which is why it
 *     is no longer the default.
 *
 * Either way we only report a URL once it's reachable from outside: the host
 * resolves on public resolvers and a request through the provider's edge reaches
 * this server. For trycloudflare that matters — cloudflared prints the URL before
 * the hostname exists in DNS, and a phone that looks it up in that gap caches
 * NXDOMAIN for the zone's negative TTL (30 min). We never ask the system resolver
 * — that would plant the very negative cache entry on this machine we're trying
 * to avoid.
 */
const dns = require('dns');
const https = require('https');
const { spawn } = require('child_process');

const PROVIDERS = {
  'localhost.run': { label: 'localhost.run', bin: 'ssh' },
  cloudflare: { label: 'cloudflared', bin: 'cloudflared' },
};
const ALIASES = { lhr: 'localhost.run', localhostrun: 'localhost.run', cloudflared: 'cloudflare', trycloudflare: 'cloudflare' };
const DEFAULT_PROVIDER = 'localhost.run';

// true / "true" / "" (bare flag) → the default; a name → that provider; null → unknown.
function resolveProvider(v) {
  if (v === true || v === 'true' || v === '') return DEFAULT_PROVIDER;
  const k = String(v).trim().toLowerCase();
  if (PROVIDERS[k]) return k;
  return ALIASES[k] || null;
}

// The public URL in a provider's output, or null. trycloudflare's own API host
// shows up in cloudflared's error messages — it's never ours.
function parseTunnelUrl(provider, text) {
  if (provider === 'cloudflare') {
    const m = String(text).match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/i);
    return m && m[1].toLowerCase() !== 'api' ? m[0] + '/' : null;
  }
  // "abc123.lhr.life tunneled with tls termination, https://abc123.lhr.life"
  const m = String(text).match(/tunneled with tls termination, (https:\/\/[a-z0-9.-]+)/i);
  return m ? m[1] + '/' : null;
}

function spawnProvider(provider, port) {
  if (provider === 'cloudflare') {
    // 127.0.0.1, not localhost: cloudflared may resolve localhost to ::1 first.
    return spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + port], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn('ssh', [
    '-T',
    '-o', 'BatchMode=yes', // never stop to ask for a password/passphrase — there's no one to answer
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=20', // notice a dead connection within a minute and reconnect
    '-o', 'ServerAliveCountMax=3',
    '-R', '80:127.0.0.1:' + port,
    'nokey@localhost.run',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePublic(host) {
  const r = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
  r.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8']);
  return r.resolve4(host);
}

// GET / through the edge, pinned to an IP we resolved ourselves. A 5xx means
// the edge doesn't see our connector yet.
function probe(host, ip) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: ip, servername: host, headers: { host, 'user-agent': 'presik-tunnel-check' }, path: '/', timeout: 5000 },
      (res) => {
        res.resume();
        resolve(res.statusCode < 500);
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function waitReachable(host, deadline, isAlive) {
  while (Date.now() < deadline && isAlive()) {
    try {
      const ips = await resolvePublic(host);
      if (ips.length && (await probe(host, ips[0]))) return true;
    } catch (_) {}
    await sleep(1000);
  }
  return false;
}

/**
 * Start a tunnel to http://127.0.0.1:<port>.
 *
 * Resolves once with { url, verified } when the first URL is reachable (or with
 * verified: false if the checks can't confirm it in time), or with
 * { url: null, reason, log } when the tunnel can't be brought up.
 *
 * If the connection drops later, we reconnect: onDown(reason) when it goes,
 * onUrl(url, changed) when it's reachable again — on a new address, or not.
 * stop() ends the tunnel for good.
 */
function startTunnel(port, { provider = DEFAULT_PROVIDER, onUrl = () => {}, onDown = () => {}, urlTimeout = 30000, verifyTimeout = 60000 } = {}) {
  let proc = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (proc) proc.kill();
  };

  const first = new Promise((resolve) => {
    let settled = false;
    let currentUrl = null;
    let failures = 0;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const connect = () => {
      const log = [];
      let url = null;
      let alive = true;
      const cp = (proc = spawnProvider(provider, port));
      const onData = (buf) => {
        for (const line of String(buf).split('\n')) if (line.trim()) log.push(line.trim());
        if (log.length > 200) log.splice(0, log.length - 200);
        const found = !url && parseTunnelUrl(provider, buf);
        if (!found) return;
        url = found;
        const host = new URL(url).hostname;
        waitReachable(host, Date.now() + verifyTimeout, () => alive && !stopped).then((ok) => {
          if (!alive || stopped) return;
          failures = 0;
          if (!settled) {
            currentUrl = url;
            return finish({ url, verified: ok });
          }
          const changed = url !== currentUrl;
          currentUrl = url;
          onUrl(url, changed);
        });
      };
      cp.stdout.on('data', onData);
      cp.stderr.on('data', onData);
      cp.on('error', (e) => {
        alive = false;
        finish({
          url: null,
          reason: e.code === 'ENOENT' ? PROVIDERS[provider].bin + ' not found' : PROVIDERS[provider].label + ' failed: ' + e.message,
          log: log.slice(-15),
        });
      });
      cp.on('exit', (code) => {
        if (!alive || stopped) return; // already failed/killed on purpose — nothing to reconnect
        alive = false;
        if (!settled) {
          return finish({ url: null, reason: PROVIDERS[provider].label + ' exited (code ' + code + ')', log: log.slice(-15) });
        }
        // Up once already: a class is running on it, so keep trying rather than
        // quietly leaving students on a dead address. cloudflared can't come back
        // on the same URL either, but a new one beats none.
        failures++;
        onDown(PROVIDERS[provider].label + ' connection dropped (code ' + code + ') — reconnecting…');
        setTimeout(() => stopped || connect(), Math.min(30000, 2000 * failures));
      });
      setTimeout(() => {
        if (!url && alive && !settled) {
          alive = false;
          cp.kill();
          finish({ url: null, reason: PROVIDERS[provider].label + ' gave no URL within ' + urlTimeout / 1000 + 's', log: log.slice(-15) });
        }
      }, urlTimeout);
    };
    connect();
  });

  return { first, stop };
}

module.exports = { startTunnel, resolveProvider, parseTunnelUrl, PROVIDERS, DEFAULT_PROVIDER };
