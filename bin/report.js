#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) require('../src/help.js').printHelp('report');
require('../src/sqlite-guard').ensureSqlite();
require('../src/report.js');
