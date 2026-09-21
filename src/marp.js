// Where marp-cli lives, shared by the server (/slides builds) and `presik export`.
//
// Run marp-cli's JS entry through the current node binary rather than the
// node_modules/.bin/marp shim: the shim is a shell script on macOS/Linux and
// a .cmd on Windows, and execFileSync on the extensionless name can't launch
// the .cmd — so the old approach silently broke slide builds on Windows.
// Resolve it rather than joining a path under the engine root: when presik is
// installed as a dependency, npm HOISTS marp-cli to the consumer's top-level
// node_modules, so <engine>/node_modules/@marp-team/… doesn't exist and the old
// existsSync check reported "no Marp" on a perfectly good install.
// require.resolve walks the whole node_modules chain, so it finds Marp whether
// it's hoisted, nested, or installed globally alongside presik.
//
// Marp is an optionalDependency: a normal install gets it, but it's absent from
// the packaged single-file binary and from an install run with --omit=optional.
// MARP_JS is null then, and callers degrade (or explain) instead of crashing.
let MARP_JS = null;
try {
  MARP_JS = require.resolve('@marp-team/marp-cli/marp-cli.js');
} catch (_) {}

module.exports = { MARP_JS, MARP_AVAILABLE: MARP_JS !== null };
