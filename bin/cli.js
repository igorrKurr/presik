#!/usr/bin/env node
// Node's SEA sets process.argv to [exePath, exePath, ...userArgs] — argv[1] is
// the executable again, mirroring the normal [node, script, ...userArgs]
// layout. So argv.slice(2) / argv[2] work identically whether run from source,
// npm, or the packaged binary; no argv fix-up is needed.
require('../sqlite-guard').ensureSqlite();

const cmd = process.argv[2];
if (cmd === 'new') require('../scaffold.js');
else if (cmd === 'report') { process.argv.splice(2, 1); require('../report.js'); } // drop "report", report.js parses the rest
else require('../server.js');
