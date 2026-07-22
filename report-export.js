// Turn an analytics model (report-data.js) into the *same* page the web report
// renders, but standalone — CSS and JS inlined, the model baked into
// window.__REPORT__ — so the file opens offline with identical visuals. And,
// when a headless Chrome can be found, straight to PDF from that same HTML.
//
// PDF reuses puppeteer-core, which is already present as a marp-cli dependency
// (no new install). It carries no browser of its own, so we locate one the way
// convert.js locates LibreOffice: known install paths + env override. If none is
// found (e.g. the packaged binary, which ships neither Marp nor puppeteer), we
// fall back to writing the HTML and telling the user to print it — PDF stays an
// optional convenience, never a hard requirement.
const fs = require('fs');
const { readAssetText } = require('./assets');

// Bake the model into report.html with its CSS/JS inlined. `</script>` inside
// student free-text would otherwise close the data block early, so escape `<`.
function renderStandalone(model) {
  const css = readAssetText('public/report.css');
  const js = readAssetText('public/report.js');
  const data = JSON.stringify(model).replace(/</g, '\\u003c');
  return readAssetText('public/report.html')
    .replace('<link rel="stylesheet" href="/report.css">', '<style>\n' + css + '\n</style>')
    .replace('<!--PRESIK_REPORT-->', '<script>window.__REPORT__=' + data + ';</script>')
    .replace('<script src="/report.js"></script>', '<script>\n' + js + '\n</script>');
}

// A Chrome/Chromium/Edge/Brave executable, or null. Env wins, then the usual
// per-OS install locations, then PATH.
function findChrome() {
  const { execFileSync } = require('child_process');
  for (const e of [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH]) {
    if (e && fs.existsSync(e)) return e;
  }
  const plat = process.platform;
  const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const cands = plat === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ] : plat === 'win32' ? [
    pf + '\\Google\\Chrome\\Application\\chrome.exe',
    pf86 + '\\Google\\Chrome\\Application\\chrome.exe',
    pf + '\\Microsoft\\Edge\\Application\\msedge.exe',
    pf86 + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
  ];
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  if (plat !== 'win32') {
    for (const n of ['google-chrome', 'chromium', 'chromium-browser']) {
      try { return execFileSync('which', [n], { encoding: 'utf8' }).trim(); } catch (_) {}
    }
  }
  return null;
}

// Render the standalone HTML to a PDF. Resolves { ok:true } on success, or
// { ok:false, htmlFile } when no browser is available (HTML written as fallback).
async function writePdf(file, model) {
  const html = renderStandalone(model);
  // puppeteer-core is external to the packaged binary (build.js) — so a missing
  // browser OR a missing module both land on the same graceful HTML fallback.
  let puppeteer = null;
  const exe = findChrome();
  if (exe) { try { puppeteer = require('puppeteer-core'); } catch (_) { puppeteer = null; } }
  if (!exe || !puppeteer) {
    const htmlFile = file.replace(/\.pdf$/i, '') + '.html';
    fs.writeFileSync(htmlFile, html);
    return { ok: false, htmlFile };
  }
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: file, printBackground: true, format: 'A4',
      margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
  } finally {
    await browser.close();
  }
  return { ok: true };
}

// Best-effort "open this file in the default app" — mirrors server.js's opener.
function openFile(file) {
  const { spawn } = require('child_process');
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [file]] :
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] :
    ['xdg-open', [file]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch (_) {}
}

module.exports = { renderStandalone, findChrome, writePdf, openFile };
