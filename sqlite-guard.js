// node:sqlite is built into Node, but on Node 22.5–23.3 it lives behind the
// --experimental-sqlite flag. Rather than make users remember the flag, we
// transparently re-exec the process once with it. Node 23.4+ / 24 LTS need
// nothing. Older than 22.5 has no node:sqlite at all → clear upgrade message.
function ensureSqlite() {
  try {
    require('node:sqlite');
    return; // available directly, or we're already the re-exec'd child
  } catch (_) {
    if (process.env.PRESIK_SQLITE_REEXEC) {
      console.error('\n  presik needs Node 22.5 or newer (for built-in SQLite).');
      console.error('  Your Node: ' + process.version + '  →  please upgrade Node.\n');
      process.exit(1);
    }
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, ['--experimental-sqlite', ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, PRESIK_SQLITE_REEXEC: '1' },
    });
    process.exit(r.status == null ? 1 : r.status);
  }
}

module.exports = { ensureSqlite };
