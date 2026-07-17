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

// Split a Marp markdown deck into its front-matter and slides. Slides are
// separated by a `---` line at the top level (not inside a ``` / ~~~ code
// fence); the leading `---`…`---` block is front-matter, not a separator.
function splitMarpSlides(md) {
  const lines = String(md).split(/\r?\n/);
  let front = '';
  let i = 0;
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    front = lines.slice(0, j + 1).join('\n'); // includes the closing ---
    i = j + 1;
  }
  const slides = [];
  let cur = [];
  let fence = null; // '`' or '~' while inside a fenced code block
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    const m = t.match(/^(`{3,}|~{3,})/);
    if (m) {
      const ch = m[1][0];
      if (fence === null) fence = ch;
      else if (ch === fence) fence = null;
      cur.push(lines[i]);
      continue;
    }
    if (fence === null && /^---\s*$/.test(t)) { slides.push(cur.join('\n')); cur = []; continue; }
    cur.push(lines[i]);
  }
  slides.push(cur.join('\n'));
  return { front, slides };
}

// Rewrite a Marp deck so each question with a `slide` gets an auto-generated
// question + reveal marker slide inserted right after that 1-based slide. The
// author writes no markers — placement lives in questions.json, unified with
// PDF decks. Questions without `slide` are left out (controlled from /host).
function deriveMarpMarkdown(md, questions) {
  const placed = (questions || []).filter((q) => q && q.slide);
  if (!placed.length) return String(md); // nothing to inject → build as-is
  const { front, slides } = splitMarpSlides(md);
  const bySlide = {};
  placed.forEach((q) => { (bySlide[q.slide] = bySlide[q.slide] || []).push(q); });
  const marker = (q) => ['<div data-quiz-question="' + q.id + '"></div>', '<div data-quiz-reveal="' + q.id + '"></div>'];
  const chunks = [];
  for (let n = 1; n <= slides.length; n++) {
    chunks.push(slides[n - 1]);
    (bySlide[n] || []).forEach((q) => chunks.push(...marker(q)));
  }
  // Questions placed past the last slide append at the end.
  Object.keys(bySlide).map(Number).filter((n) => n > slides.length).sort((a, b) => a - b)
    .forEach((n) => bySlide[n].forEach((q) => chunks.push(...marker(q))));
  return (front ? front + '\n\n' : '') + chunks.join('\n\n---\n\n') + '\n';
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

module.exports = { toSessionName, groupSlug, rankHostIps, bestHostIp, isPrivateV4, validateAnswer, buildDeckSteps, splitMarpSlides, deriveMarpMarkdown, VIRTUAL_IFACE };
