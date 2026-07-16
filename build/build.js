#!/usr/bin/env node
// Build a single-file `presik` executable for THIS OS/arch using Node's
// built-in Single Executable Application support. Cross-compiling isn't
// supported — run this on each target OS (see .github/workflows/release.yml).
//
//   npm run build   →   dist/presik   (or dist/presik.exe on Windows)
//
// Steps: bundle everything (incl. the qrcode dep) into one CJS file with
// esbuild → generate the SEA blob (which also embeds the HTML/template assets
// listed in sea-config.json) → copy the node runtime → inject the blob with
// postject → re-sign on macOS.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');
const { inject } = require('postject');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const plat = process.platform;
const exeName = 'presik' + (plat === 'win32' ? '.exe' : '');
const OUT = path.join(DIST, exeName);
const BUNDLE = path.join(DIST, 'bundle.cjs');
const BLOB = path.join(DIST, 'sea-prep.blob');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });
}

// SEA injection needs a node binary that carries the fuse sentinel. Some
// distributions (notably Homebrew) strip it, so fall back to the matching
// official nodejs.org build — which is also what release CI should use for
// reproducibility. Override the version with PRESIK_NODE_VERSION.
async function runtimeNode() {
  const has = (p) => { try { return fs.readFileSync(p).includes(Buffer.from(FUSE)); } catch (_) { return false; } };
  if (has(process.execPath)) return process.execPath;

  const ver = process.env.PRESIK_NODE_VERSION || process.version; // e.g. v24.10.0
  const osName = { darwin: 'darwin', linux: 'linux', win32: 'win' }[plat];
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
  if (!osName || !arch) throw new Error('unsupported platform ' + plat + '/' + process.arch);
  const ext = plat === 'win32' ? 'zip' : 'tar.gz';
  const base = 'node-' + ver + '-' + osName + '-' + arch;
  const cache = path.join(DIST, '.runtime');
  fs.mkdirSync(cache, { recursive: true });
  const nodeBin = plat === 'win32' ? path.join(cache, base, 'node.exe') : path.join(cache, base, 'bin', 'node');
  if (!has(nodeBin)) {
    const archive = path.join(cache, base + '.' + ext);
    console.log('• current node lacks the SEA fuse — fetching official Node ' + ver + '…');
    await download('https://nodejs.org/dist/' + ver + '/' + base + '.' + ext, archive);
    execFileSync('tar', ['-xf', archive, '-C', cache], { stdio: 'inherit' }); // tar handles .tar.gz and .zip (Win10+)
  }
  if (!has(nodeBin)) throw new Error('fetched Node still has no SEA fuse: ' + nodeBin);
  return nodeBin;
}

(async () => {
  fs.mkdirSync(DIST, { recursive: true });

  console.log('• bundling with esbuild…');
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'bin', 'cli.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node' + process.versions.node.split('.')[0],
    outfile: BUNDLE,
    logLevel: 'warning',
    // node: builtins (http, fs, node:sqlite, node:sea, …) stay external
    // automatically for platform:node. Marp is never required, only spawned,
    // so it's not pulled in.
  });

  console.log('• generating SEA blob (with embedded assets)…');
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(ROOT, 'build', 'sea-config.json')], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const nodeSrc = await runtimeNode();
  console.log('• copying node runtime → ' + exeName);
  fs.rmSync(OUT, { force: true }); // a prior read-only copy would block overwrite
  fs.copyFileSync(nodeSrc, OUT);
  fs.chmodSync(OUT, 0o755); // the source node may be read-only (0555); postject must be able to write
  if (plat === 'darwin') { try { execFileSync('codesign', ['--remove-signature', OUT]); } catch (_) {} }

  console.log('• injecting blob with postject…');
  await inject(OUT, 'NODE_SEA_BLOB', fs.readFileSync(BLOB), {
    sentinelFuse: FUSE,
    machoSegmentName: plat === 'darwin' ? 'NODE_SEA' : undefined,
  });

  if (plat === 'darwin') { try { execFileSync('codesign', ['--sign', '-', OUT]); } catch (_) {} }
  if (plat !== 'win32') fs.chmodSync(OUT, 0o755);

  const mb = (fs.statSync(OUT).size / 1e6).toFixed(0);
  console.log('\n✓ built ' + path.relative(process.cwd(), OUT) + '  (' + mb + ' MB)');
  console.log('  Try it:  cd into a folder of sessions and run  ' + (plat === 'win32' ? OUT : './' + path.relative(process.cwd(), OUT)));
})().catch((e) => { console.error('\nBuild failed: ' + e.message + '\n'); process.exit(1); });
