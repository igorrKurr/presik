// =====================================================================
//  presik help — every command, flag, and setting, in one place.
//
//    presik help                 → overview: commands + where to look next
//    presik help <command>       → details for one command (run, new, edit, widget, report, config)
//    presik --help / -h          → same as `presik help`
//    presik <command> --help     → same as `presik help <command>`
//    presik --version / -v       → the version
//
// The long-form version of this lives in docs/CLI.md — keep the two in step
// when a flag is added (the flags themselves are parsed in server.js,
// scaffold.js, widget-cli.js and report.js).
// =====================================================================
const VERSION = require('../package.json').version;

// Colour only on a real terminal, and never when the user opted out.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (s) => (tty ? '\x1b[1m' + s + '\x1b[22m' : s);
const dim = (s) => (tty ? '\x1b[2m' + s + '\x1b[22m' : s);

// Rows of [left, right] → two aligned columns, indented under a heading.
function table(rows, indent = 4) {
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([l, r]) => ' '.repeat(indent) + l.padEnd(w) + '   ' + r).join('\n');
}
const section = (title, body) => '\n  ' + bold(title) + '\n' + body + '\n';

const DOCS_URL = 'https://github.com/igorrKurr/presik/blob/main/docs/CLI.md';
const COMMON_FOOTER = '\n  ' + dim('Full reference: ' + DOCS_URL) + '\n';

const TOPICS = {
  overview: () =>
    '\n  ' + bold('presik v' + VERSION) + ' — live in-class quizzes, interleaved into your slides\n' +
    section('Usage', table([
      ['presik [<session>] [options]', 'run a session (no session: run the only one, or list them)'],
      ['presik new <session> [options]', 'scaffold a new session from the templates'],
      ['presik edit <session> [options]', 'run the session with the browser question editor open'],
      ['presik widget <add|ls> [options]', 'vendor / list interactive widget packages'],
      ['presik report [options]', 'analyse saved answers (same as presik-report)'],
      ['presik help [<topic>]', 'this help, or details for one topic'],
      ['presik --version', 'print the version'],
    ])) +
    section('Help topics', table([
      ['presik help run', 'every flag for running a class (--port, --key, --tunnel, …)'],
      ['presik help new', 'scaffolding a session'],
      ['presik help edit', 'the browser question editor'],
      ['presik help widget', 'widget packages'],
      ['presik help report', 'analytics: text, CSV, HTML, PDF'],
      ['presik help config', 'presik.config.json — saving flags per project/session'],
    ])) +
    section('Quick start', table([
      ['presik new s01', 'make ./s01/questions.json + ./s01/deck.marp.md'],
      ['presik s01 --group "3-A"', 'run it; open the printed Slides:/Teacher: links'],
      ['presik report --session s01', 'afterwards: % correct per question, by group'],
    ])) +
    COMMON_FOOTER,

  run: () =>
    '\n  ' + bold('presik [<session>] [options]') + '  — run a class\n' +
    '\n  A session is any folder (at any depth under the content root) holding\n' +
    '  questions.json and, optionally, a deck: deck.marp.md, deck.pdf, deck.pptx or deck.key.\n' +
    '  With no <session>, presik runs the content root if it is the only session,\n' +
    '  otherwise it lists every session it finds.\n' +
    section('Options', table([
      ['--dir <path>', 'content root (default: current directory). Not settable in presik.config.json'],
      ['--port <n>', 'HTTP port (default: 3000)'],
      ['--host <ip>', 'LAN address to advertise (default: auto-detected, skipping VPN/virtual nets)'],
      ['--key <word>', 'teacher key for /host, /slides, /report, /edit (default: random each run)'],
      ['--group <name>', 'tag this run\'s results with a group/cohort (default: asked interactively)'],
      ['--no-group', 'don\'t ask for a group name'],
      ['--tunnel', 'public https URL via cloudflared (needs cloudflared installed)'],
      ['--qr <file.svg>', 'where to write the join QR (default: <session>/join-qr.svg)'],
      ['--db <file.db>', 'answers database (default: <content-root>/.presik/data.db)'],
      ['-h, --help', 'show this help'],
    ])) +
    section('Examples', table([
      ['presik', 'run the only session, or list them'],
      ['presik s01', 'run ./s01/'],
      ['presik web-dev/s01 --group "3-A"', 'nested session, tagged with a group'],
      ['presik s01 --port 8080 --key myword', 'fixed port and a memorable key'],
      ['presik s01 --dir ~/courses/web-dev', 'content root elsewhere'],
      ['presik s01 --tunnel', 'students join over the internet (e.g. Zoom)'],
    ])) +
    section('Pages it serves', table([
      ['/', 'students (phones)'],
      ['/host?key=…', 'your private cockpit: live distribution, hints, controls'],
      ['/slides?key=…', 'the projector: deck with the quiz interleaved; arrow keys drive both'],
      ['/present', 'projector view for a questions-only session'],
      ['/report?key=…', 'interactive analytics over the whole database'],
      ['/edit?key=…', 'the question editor'],
    ])) +
    '\n  Flags beat presik.config.json — see `presik help config`. Stop with Ctrl+C.\n' +
    COMMON_FOOTER,

  new: () =>
    '\n  ' + bold('presik new <session> [options]') + '  — scaffold a session\n' +
    '\n  Creates <session>/questions.json and <session>/deck.marp.md from the built-in\n' +
    '  templates. Never overwrites existing files.\n' +
    section('Options', table([
      ['--title "<text>"', 'quiz title (default: "S00 — <session>")'],
      ['--questions-only', 'skip deck.marp.md (bring your own PDF/PowerPoint/Keynote deck)'],
      ['--dir <path>', 'content root (default: current directory)'],
    ])) +
    section('Examples', table([
      ['presik new s02', './s02/questions.json + ./s02/deck.marp.md'],
      ['presik new web-dev/s02 --title "S02 — Status codes"', 'nested, custom title'],
      ['presik new lecture-05 --questions-only', 'quiz only; drop deck.pptx in next to it'],
    ])) +
    COMMON_FOOTER,

  edit: () =>
    '\n  ' + bold('presik edit <session> [options]') + '  — edit questions in the browser\n' +
    '\n  Starts the normal server and opens /edit: a live editor for questions.json with\n' +
    '  autosave, drag-to-reorder and version history. Works even when questions.json\n' +
    '  (or the folder) doesn\'t exist yet — the first save creates it.\n' +
    '  Accepts every option of `presik help run` (--port, --key, --dir, …).\n' +
    section('Examples', table([
      ['presik edit s01', 'edit ./s01/questions.json'],
      ['presik edit s09', 'no questions.json yet — opens blank'],
    ])) +
    COMMON_FOOTER,

  widget: () =>
    '\n  ' + bold('presik widget <add|ls> [options]') + '  — interactive widget packages\n' +
    '\n  Copies an independently-built widget (a game, a simulation…) into\n' +
    '  <content-root>/widgets/<name>@<version>/ so a question can reference it by name\n' +
    '  and the class runs offline. The bundle needs a widget.json manifest at its root.\n' +
    section('Subcommands', table([
      ['add <path-to-built-dist>', 'vendor a built bundle'],
      ['ls   (or list)', 'list vendored packages'],
    ])) +
    section('Options', table([
      ['--force', 'add: overwrite an already-installed version'],
      ['--dir <path>', 'content root (default: current directory)'],
    ])) +
    section('Examples', table([
      ['presik widget add ../dungeon/dist', 'vendor a bundle'],
      ['presik widget add ../dungeon/dist --force', 're-vendor the same version'],
      ['presik widget ls', 'what\'s installed'],
    ])) +
    COMMON_FOOTER,

  report: () =>
    '\n  ' + bold('presik report [options]') + '   ' + dim('(or: presik-report [options])') + '  — analyse answers\n' +
    '\n  Reads the answers database; no server needed. With no --session it lists all runs.\n' +
    section('Filters', table([
      ['--session <path>', 'one session, same path you ran it with (e.g. web-dev/s01)'],
      ['--course <name>', 'every session of one course'],
      ['--group <name>', 'one group/cohort'],
    ])) +
    section('Output', table([
      ['(default)', 'text: list of runs, or per-question % correct by group'],
      ['--csv', 'every matching answer as CSV on stdout'],
      ['--html [file]', 'standalone, offline interactive report (default: presik-report-<label>.html)'],
      ['--pdf [file]', 'same visuals as PDF via headless Chrome; falls back to .html'],
      ['--open', 'with --html/--pdf: open the file when written'],
    ])) +
    section('Location', table([
      ['--dir <path>', 'content root (default: current directory)'],
      ['--db <file.db>', 'database (default: <content-root>/.presik/data.db)'],
    ])) +
    section('Environment', table([
      ['CHROME_PATH', 'Chrome/Chromium binary for --pdf'],
      ['PUPPETEER_EXECUTABLE_PATH', 'same, takes precedence over CHROME_PATH'],
    ])) +
    section('Examples', table([
      ['presik report', 'list all runs'],
      ['presik report --session s01 --group "3-A"', 'one session, one group'],
      ['presik report --course web-dev', 'a whole course'],
      ['presik report --csv > answers.csv', 'everything, for pandas/Excel'],
      ['presik report --session s01 --pdf report.pdf --open', 'PDF, then open it'],
    ])) +
    COMMON_FOOTER,

  config: () =>
    '\n  ' + bold('presik.config.json') + '  — save flags per project or per session\n' +
    '\n  Optional JSON file at the content root and/or inside a session folder. Keys are\n' +
    '  the run flags; values keep their JSON type.\n' +
    section('Keys', table([
      ['port', 'number    same as --port'],
      ['host', 'string    same as --host'],
      ['key', 'string    same as --key'],
      ['group', 'string    same as --group'],
      ['noGroup', 'boolean   same as --no-group'],
      ['tunnel', 'boolean   same as --tunnel'],
      ['qr', 'path      same as --qr (relative to the config file)'],
      ['db', 'path      same as --db (relative to the config file)'],
    ])) +
    section('Precedence', '    CLI flag  >  <session>/presik.config.json  >  <root>/presik.config.json  >  default') +
    section('Example', '    { "port": 8080, "key": "web-dev-2026", "group": "3-A" }') +
    '\n  --dir can\'t be set here (it decides where the file is looked up). A null value\n' +
    '  means "not set", so a session file can defer to the root. Unknown keys or wrong\n' +
    '  types stop the launch with a clear message.\n' +
    COMMON_FOOTER,
};

// Words people reach for that mean an existing topic.
const ALIASES = { start: 'run', server: 'run', serve: 'run', widgets: 'widget', settings: 'config', 'presik.config.json': 'config' };

function helpText(topic) {
  if (!topic) return TOPICS.overview();
  const t = ALIASES[topic] || topic;
  return TOPICS[t] ? TOPICS[t]() : null;
}

// Print help for `topic` and exit. An unknown topic gets the overview plus a
// note, and a non-zero exit so a typo in a script doesn't pass silently.
function printHelp(topic) {
  const text = helpText(topic);
  if (text) {
    process.stdout.write(text + '\n');
    process.exit(0);
  }
  process.stderr.write('\n  No help topic "' + topic + '". Topics: ' + Object.keys(TOPICS).filter((k) => k !== 'overview').join(', ') + '\n');
  process.stdout.write(TOPICS.overview() + '\n');
  process.exit(1);
}

module.exports = { printHelp, helpText, TOPICS, VERSION };
