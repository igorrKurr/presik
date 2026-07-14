#!/usr/bin/env node
if (process.argv[2] === 'new') require('../scaffold.js');
else require('../server.js');
