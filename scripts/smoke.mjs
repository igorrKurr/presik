// Smoke-test a built presik binary: scaffold a tiny PDF-deck session, run the
// binary (no node_modules on its path), and check it serves the deck viewer and
// the embedded pdf.js assets. Catches a broken SEA build or a missing asset.
//
//   node scripts/smoke.mjs [path-to-binary]   (defaults to dist/presik[.exe])
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Absolute — the child runs with cwd set to the temp session dir below.
const bin = resolve(process.argv[2] || join('dist', process.platform === 'win32' ? 'presik.exe' : 'presik'));

const dir = mkdtempSync(join(tmpdir(), 'presik-smoke-'));
mkdirSync(join(dir, 'lec'));
writeFileSync(join(dir, 'lec', 'deck.pdf'), makePdf(2));
writeFileSync(
  join(dir, 'lec', 'questions.json'),
  JSON.stringify({ title: 'smoke', questions: [{ id: 'q1', type: 'choice', text: 'Q?', slide: 1, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B', correct: true }] }] })
);

const PORT = 3900 + Math.floor(Math.random() * 90);
const KEY = 'smoke';
const base = `http://127.0.0.1:${PORT}`;
const child = spawn(bin, ['lec', '--no-group', '--key', KEY, '--port', String(PORT)], { cwd: dir, stdio: 'ignore' });
child.on('error', (e) => { console.error('✗ could not launch ' + bin + ': ' + e.message); process.exit(1); });

const routes = [`/slides?key=${KEY}`, '/deck.pdf', '/vendor/pdf.mjs', '/vendor/pdf.worker.mjs', '/embed.css', '/'];

try {
  await waitFor(`${base}/`, 25000);
  for (const r of routes) {
    const res = await fetch(base + r);
    if (!res.ok) throw new Error(`${r} → HTTP ${res.status}`);
  }
  console.log(`✓ smoke: ${bin} serves the deck viewer + embedded pdf.js assets`);
  done(0);
} catch (e) {
  console.error('✗ smoke failed: ' + e.message);
  done(1);
}

function done(code) { try { child.kill('SIGKILL'); } catch (_) {} process.exit(code); }
async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const res = await fetch(url); if (res.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('binary did not start listening within ' + ms + 'ms');
}

// Minimal valid multi-page PDF ("Slide N" per page) — no dependencies.
function makePdf(pages) {
  const parts = [];
  const pageObjs = [], contentIds = [];
  let n = 2;
  for (let i = 1; i <= pages; i++) { pageObjs.push(++n); contentIds.push(++n); }
  const fontId = ++n;
  parts[1] = '<</Type/Catalog/Pages 2 0 R>>';
  parts[2] = `<</Type/Pages/Kids[${pageObjs.map((k) => k + ' 0 R').join(' ')}]/Count ${pages}>>`;
  for (let i = 0; i < pages; i++) {
    parts[pageObjs[i]] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 960 540]/Contents ${contentIds[i]} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`;
    const s = `BT /F1 60 Tf 80 260 Td (Slide ${i + 1}) Tj ET`;
    parts[contentIds[i]] = `<</Length ${s.length}>>\nstream\n${s}\nendstream`;
  }
  parts[fontId] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';
  let out = '%PDF-1.4\n';
  const off = [];
  for (let i = 1; i < parts.length; i++) { off[i] = Buffer.byteLength(out); out += `${i} 0 obj\n${parts[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${parts.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < parts.length; i++) out += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<</Size ${parts.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return out;
}
