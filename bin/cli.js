#!/usr/bin/env node
// Node's SEA sets process.argv to [exePath, exePath, ...userArgs] — argv[1] is
// the executable again, mirroring the normal [node, script, ...userArgs]
// layout. So argv.slice(2) / argv[2] work identically whether run from source,
// npm, or the packaged binary; no argv fix-up is needed.
const args = process.argv.slice(2);
const cmd = args[0];
const SUBCOMMANDS = new Set(['new', 'edit', 'widget', 'report']);

// Help and version are answered before the SQLite check, so they work even on
// a Node too old to run a class. `presik help <topic>`, `presik --help`, and
// `presik <subcommand> --help` all land in help.js; for a plain run
// (`presik s01 --help`) the topic is "run".
if (cmd === '--version' || cmd === '-v') {
  console.log(require('../src/help.js').VERSION);
  process.exit(0);
}
if (cmd === 'help') require('../src/help.js').printHelp(args[1]);
if (args.includes('--help') || args.includes('-h')) {
  require('../src/help.js').printHelp(SUBCOMMANDS.has(cmd) ? cmd : cmd && !cmd.startsWith('-') ? 'run' : undefined);
}

require('../src/sqlite-guard').ensureSqlite();

if (cmd === 'new') require('../src/scaffold.js');
else if (cmd === 'widget') require('../src/widget-cli.js'); // presik widget add/ls — widget-cli.js parses the rest
else if (cmd === 'report') { process.argv.splice(2, 1); require('../src/report.js'); } // drop "report", report.js parses the rest
// `presik edit <session>` is the ordinary server with the editor opened for you
// — one code path, so what you edit is never a different app from the one that
// runs the class. Swap the subcommand for a flag so server.js's parser sees a
// flag rather than a stray positional it would read as a session name.
else if (cmd === 'edit') { process.argv.splice(2, 1, '--edit'); require('../src/server.js'); }
else require('../src/server.js');
