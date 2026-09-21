'use strict';
/**
 * cloudflared quick tunnel (`--tunnel`).
 *
 * cloudflared prints the https://….trycloudflare.com URL *before* the hostname
 * exists in DNS. Hand that URL out right away and a phone that scans the QR in
 * the gap gets NXDOMAIN — which its resolver (and the school/ISP one) then
 * caches for the zone's negative TTL, 30 minutes on trycloudflare.com. The
 * student sees "no connection" long after the tunnel is actually fine.
 *
 * So we only report the URL once it's reachable from outside: the hostname
 * resolves on public resolvers and a request through Cloudflare's edge reaches
 * this server. We never ask the system resolver — that would plant the very
 * negative cache entry on this machine we're trying to avoid.
 */
const dns = require('dns');
const https = require('https');
const { spawn } = require('child_process');

const URL_RE = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i;
const PUBLIC_DNS = ['1.1.1.1', '1.0.0.1', '8.8.8.8'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePublic(host) {
  const r = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
  r.setServers(PUBLIC_DNS);
  return r.resolve4(host);
}

// GET / through the edge, pinned to an IP we resolved ourselves. 530/502/1033
// from Cloudflare means the edge doesn't see our connector yet.
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
 * Start cloudflared for http://localhost:<port>.
 * Resolves { url, verified, proc } once the tunnel is reachable (verified), or
 * — if the checks can't confirm it in time (e.g. outbound DNS to 1.1.1.1 is
 * blocked) — with verified: false. Resolves { url: null, reason, log } when
 * cloudflared is missing, exits, or never prints a URL.
 */
function startTunnel(port, { urlTimeout = 30000, verifyTimeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const log = [];
    let settled = false;
    let alive = true;
    let url = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, proc: cf, log: log.slice(-15) });
    };

    // 127.0.0.1, not localhost: cloudflared may resolve localhost to ::1 first.
    const cf = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + port], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (buf) => {
      for (const line of String(buf).split('\n')) if (line.trim()) log.push(line.trim());
      if (log.length > 200) log.splice(0, log.length - 200);
      const m = !url && String(buf).match(URL_RE);
      // api.trycloudflare.com shows up in error messages — it's never our URL.
      if (m && m[1].toLowerCase() !== 'api.trycloudflare.com') {
        url = 'https://' + m[1] + '/';
        waitReachable(m[1], Date.now() + verifyTimeout, () => alive && !settled).then((ok) =>
          finish({ url, verified: ok })
        );
      }
    };
    cf.stdout.on('data', onData);
    cf.stderr.on('data', onData);
    cf.on('error', (e) =>
      finish({ url: null, reason: e.code === 'ENOENT' ? 'cloudflared not found' : 'cloudflared failed: ' + e.message })
    );
    cf.on('exit', (code) => {
      alive = false;
      finish({ url: null, reason: 'cloudflared exited (code ' + code + ')' });
    });
    setTimeout(() => {
      if (!url) finish({ url: null, reason: 'cloudflared gave no URL within ' + urlTimeout / 1000 + 's' });
    }, urlTimeout);
  });
}

module.exports = { startTunnel };
