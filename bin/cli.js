#!/usr/bin/env node
require('../sqlite-guard').ensureSqlite();
if (process.argv[2] === 'new') require('../scaffold.js');
else require('../server.js');
