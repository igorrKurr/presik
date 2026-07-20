#!/usr/bin/env node
// Node's SEA sets process.argv to [exePath, exePath, ...userArgs] — argv[1] is
// the executable again, mirroring the normal [node, script, ...userArgs]
// layout. So argv.slice(2) / argv[2] work identically whether run from source,
// npm, or the packaged binary; no argv fix-up is needed.
require('../sqlite-guard').ensureSqlite();

const cmd = process.argv[2];
if (cmd === 'new') require('../scaffold.js');
else if (cmd === 'report') { process.argv.splice(2, 1); require('../report.js'); } // drop "report", report.js parses the rest
// `presik edit <session>` is the ordinary server with the editor opened for you
// — one code path, so what you edit is never a different app from the one that
// runs the class. Swap the subcommand for a flag so server.js's parser sees a
// flag rather than a stray positional it would read as a session name.
else if (cmd === 'edit') { process.argv.splice(2, 1, '--edit'); require('../server.js'); }
else require('../server.js');
