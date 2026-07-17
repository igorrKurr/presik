// Pure, dependency-free helpers shared by the server and covered by tests
// (test/lib.test.js). Nothing here touches the network, the filesystem, or
// process state — so it's all trivially unit-testable.

// A session's name is its path relative to the content root, POSIX-style.
function toSessionName(root, dir, sep) {
  const path = require('path');
  sep = sep || path.sep;
  const rel = path.relative(root, dir);
  return (rel || '.').split(sep).join('/');
}

// Group/cohort → a filename-safe slug (used only for the results/*.json name).
function groupSlug(g) {
  return g ? g.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) : null;
}

// Interfaces that are technically "up" but never the address students can
// reach: VPNs (utun/tun/ppp), virtualization (vmnet/vboxnet/docker/bridge),
// Apple link-local service interfaces (awdl/llw), etc.
const VIRTUAL_IFACE = /^(utun|tun|tap|ppp|ipsec|vnic|vmnet|vboxnet|docker|br-|bridge|awdl|llw|gif|stf|ap\d)/i;

function isPrivateV4(addr) {
  return /^10\./.test(addr) || /^192\.168\./.test(addr) || /^172\.(1[6-9]|2\d|3[01])\./.test(addr);
}

// Pick the LAN address to advertise in the join URL / QR. The naive "first
// non-internal IPv4" breaks the moment a VPN or Docker is up, handing students
// an address nobody in the room can reach. Score real private-LAN interfaces
// highest; let --host override entirely (handled by the caller).
function rankHostIps(interfaces) {
  const cand = [];
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const a of addrs || []) {
      if (!a || a.internal) continue;
      const fam = a.family === 4 || a.family === 'IPv4';
      if (!fam) continue;
      let score = 0;
      if (isPrivateV4(a.address)) score += 4;
      if (!VIRTUAL_IFACE.test(name)) score += 2;
      if (/^en|^eth|^wl/i.test(name)) score += 1; // ethernet/wifi first
      cand.push({ address: a.address, name, score });
    }
  }
  cand.sort((x, y) => y.score - x.score);
  return cand;
}

function bestHostIp(interfaces) {
  const c = rankHostIps(interfaces);
  return c.length ? c[0].address : 'localhost';
}

// A student answer is only accepted if it's actually a legal answer to the
// current question — otherwise a hand-crafted POST could stuff the archive
// with junk values (counted in the DB, invisible in the distribution).
// Returns the normalized value to store, or null to reject.
function validateAnswer(q, rawValue) {
  if (q == null) return null;
  const value = String(rawValue == null ? '' : rawValue);
  if (q.type === 'choice') {
    const ids = (q.options || []).map((o) => o.id);
    return ids.includes(value) ? value : null;
  }
  if (q.type === 'scale') {
    if (!/^-?\d+$/.test(value.trim())) return null;
    const n = parseInt(value, 10);
    return n >= q.min && n <= q.max ? String(n) : null;
  }
  if (q.type === 'text') {
    const t = value.trim();
    return t.length ? t.slice(0, 600) : null;
  }
  return null;
}

// Build the combined navigation sequence for a PDF deck: each page, followed by
// the question+reveal steps of any questions placed on that page (1-based
// `slide`). Questions without a `slide` don't appear in the deck (controlled
// from /host only). Mirrors the inline builder in public/deck.html.
function buildDeckSteps(numPages, questions) {
  const bySlide = {};
  (questions || []).forEach((q, i) => {
    if (q && q.slide) (bySlide[q.slide] = bySlide[q.slide] || []).push(i);
  });
  const steps = [];
  for (let p = 1; p <= numPages; p++) {
    steps.push({ t: 'page', page: p });
    (bySlide[p] || []).forEach((qi) => {
      steps.push({ t: 'question', qi });
      steps.push({ t: 'reveal', qi });
    });
  }
  return steps;
}

module.exports = { toSessionName, groupSlug, rankHostIps, bestHostIp, isPrivateV4, validateAnswer, buildDeckSteps, VIRTUAL_IFACE };
