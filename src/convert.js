// Convert a deck (deck.pptx / deck.key) to PDF under the hood, cached, so the
// PDF deck host can render it. Fidelity-first: use the source app's OWN renderer
// (Keynote / PowerPoint) for pixel-perfect output, and fall back to LibreOffice
// only when neither is present. The teacher can always export a PDF by hand and
// drop it in as deck.pdf — that path needs no tools at all.
//
// The actual conversions need the apps installed and (for Keynote/PowerPoint) a
// desktop session, so they can't run headless in CI — but which converter is
// chosen (pickConverters) is pure and unit-tested in test/lib.test.js.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pickConverters } = require('./lib');

function sofficePath() {
  const mac = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
  if (process.platform === 'darwin' && fs.existsSync(mac)) return mac;
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['soffice'], { stdio: 'ignore' }); return 'soffice'; } catch (_) {}
  return null;
}

function detectCaps() {
  const plat = process.platform;
  return {
    keynote: plat === 'darwin' && fs.existsSync('/Applications/Keynote.app'),
    // On Windows we can't cheaply probe PowerPoint/COM, so assume it and let the
    // adapter attempt-and-catch (falling back to soffice if it fails).
    powerpoint: (plat === 'darwin' && fs.existsSync('/Applications/Microsoft PowerPoint.app')) || plat === 'win32',
    soffice: sofficePath() != null,
  };
}

// ---- adapters: each throws on failure and writes `out` on success ----
function runKeynote(src, out) {
  const script = [
    'tell application "Keynote"',
    '  set doc to open POSIX file ' + JSON.stringify(src),
    '  export doc to POSIX file ' + JSON.stringify(out) + ' as PDF',
    '  close doc saving no',
    'end tell',
  ].join('\n');
  execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 180000 });
}
function runPowerPointMac(src, out) {
  const script = [
    'tell application "Microsoft PowerPoint"',
    '  set d to open ' + JSON.stringify(src),
    '  save d in ' + JSON.stringify(out) + ' as save as PDF',
    '  close d saving no',
    'end tell',
  ].join('\n');
  execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 180000 });
}
function runPowerPointWin(src, out) {
  // ppSaveAsPDF = 32
  const ps =
    '$p=New-Object -ComObject PowerPoint.Application;' +
    '$d=$p.Presentations.Open(' + psStr(src) + ',$true,$false,$false);' +
    '$d.SaveAs(' + psStr(out) + ',32);$d.Close();$p.Quit()';
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 180000 });
}
function runSoffice(src, out) {
  const soffice = sofficePath();
  if (!soffice) throw new Error('soffice not found');
  const outDir = path.dirname(out);
  execFileSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, src], { stdio: 'ignore', timeout: 180000 });
  const produced = path.join(outDir, path.basename(src, path.extname(src)) + '.pdf');
  if (produced !== out) { if (fs.existsSync(produced)) fs.renameSync(produced, out); }
}
function psStr(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function runAdapter(name, src, out) {
  if (name === 'keynote') return runKeynote(src, out);
  if (name === 'powerpoint') return process.platform === 'win32' ? runPowerPointWin(src, out) : runPowerPointMac(src, out);
  if (name === 'soffice') return runSoffice(src, out);
  throw new Error('unknown converter ' + name);
}

function noToolMsg(ext) {
  if (ext === '.key') return 'To convert a Keynote deck (.key) you need Keynote (macOS). Or export it to PDF yourself and save it as deck.pdf.';
  return 'To convert ' + ext + ' you need Microsoft PowerPoint or LibreOffice. Install LibreOffice (libreoffice.org) — or export to PDF yourself and save it as deck.pdf.';
}

// Ensure `out` is an up-to-date PDF of `src`, converting only when the source is
// newer (cache). Returns { path, converter }. Throws with an actionable message
// if no converter is available or all attempts fail.
function ensureDeckPdf(src, out) {
  const fresh = fs.existsSync(out) && fs.statSync(src).mtimeMs <= fs.statSync(out).mtimeMs;
  if (fresh) return { path: out, converter: 'cache' };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ext = path.extname(src).toLowerCase();
  const names = pickConverters(ext, detectCaps());
  if (!names.length) throw new Error(noToolMsg(ext));
  const errors = [];
  for (const name of names) {
    try {
      fs.rmSync(out, { force: true });
      runAdapter(name, src, out);
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out, converter: name };
      errors.push(name + ': produced no output');
    } catch (e) {
      errors.push(name + ': ' + (e && e.message ? e.message : e));
    }
  }
  throw new Error('Converting ' + path.basename(src) + ' to PDF failed.\n  ' + errors.join('\n  ') + '\n' + noToolMsg(ext));
}

module.exports = { ensureDeckPdf, detectCaps, sofficePath };
