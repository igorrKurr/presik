# Conventions: engine vs content

This document is the contract by which `presik` (the engine) finds and displays your content (slides and questions). Treat it as the single source of truth for the format; `README.md` links here instead of duplicating it.

## Two parts, two roles

| | Engine | Content |
|---|---|---|
| What it is | `server.js`, `db.js`, `report.js`, `bin/`, `public/` | your `deck.marp.md` + `questions.json` |
| Where it lives | in the `presik` package (`node_modules/` once installed) | anywhere on disk — your own folder, a separate repo, a USB stick |
| Who edits it | the package's authors (bugfixes, new features arrive via package updates) | you, for every new class |
| Versioned together? | no | no — content and engine are independent |

The engine never reads or writes anything class-specific outside the **content root** (the directory `presik` was run from, or `--dir <path>`).

## What a "session" is

**A session is any directory that contains `questions.json` and/or `deck.marp.md`.** You refer to it by its path relative to the content root — that's it, there are no other naming rules.

The exact same mechanism works at three scales:

```
# a single deck — the content root itself is the session
questions.json
deck.marp.md
                              → presik            (no argument — the one session is found and run automatically)

# one course, several classes
s01/questions.json
s01/deck.marp.md
s02/questions.json
s02/deck.marp.md
                              → presik s01
                              → presik s02

# several courses
web-dev/s01/questions.json
web-dev/s01/deck.marp.md
python-101/s01/questions.json
python-101/s02/questions.json
                              → presik web-dev/s01
                              → presik python-101/s02
```

There's no required `courses/` folder or course-marker file — folder depth and names are entirely yours; the engine just searches recursively for `questions.json`/`deck.marp.md` (up to 4 levels deep, skipping `node_modules`, `.git`, `.presik`, `public`, `templates`, and anything hidden).

With no argument, `presik`:
- if there's exactly one session **and** it's the root itself — runs it right away;
- otherwise — prints the list of sessions found (path + `title` from `questions.json`) and exits.

## Files inside a session

| File | Required | Who writes it | Purpose |
|---|---|---|---|
| `questions.json` | yes | you (by hand or via `/edit`) | the quiz definition — schema below |
| `presik.config.json` | no | you | per-session settings that override the root's — see "Settings file" |
| `deck.marp.md` | no | you | Marp slides; if present, `/slides` renders them |
| `deck.pdf` | no | you | a PDF deck; `/slides` renders it with the quiz interleaved |
| `deck.pptx` / `deck.key` | no | you | a PowerPoint / Keynote deck — presik converts it to PDF under the hood (cached), then treats it like `deck.pdf` |
| `deck.marp.html` | — | engine (automatic) | build artifact from `deck.marp.md`; don't edit, don't commit |
| `join-qr.svg` | — | engine (automatic) | QR with the current join link; rewritten every run |

A session's deck is `deck.marp.md`, `deck.pdf`, `deck.pptx`, or `deck.key` (precedence in that order: Marp wins, then a direct PDF, then a converted one). A deck without `questions.json` doesn't make sense (nothing to control). `questions.json` **without** a deck is a fully working mode — students and `/host` work fine, and the projector uses `/present` — there's just no `/slides`.

**Conversion & fidelity.** `.pptx`/`.key` are converted to PDF on startup and cached in `.presik/`; presik reconverts only when the source changes. To keep it faithful, presik uses the source app's **own** renderer when it's installed — Keynote for `.key`, PowerPoint for `.pptx` (pixel-perfect) — and falls back to **LibreOffice** otherwise (good, but fonts/effects can shift). If neither is available, presik tells you to install LibreOffice or export a PDF yourself and drop it in as `deck.pdf`. Either way, animations/builds flatten to their final state and embedded media is dropped (that's inherent to a static deck) — open `/slides` once before class to eyeball it.

## `questions.json` — schema

```json
{
  "title": "S01 — Class name",
  "questions": [
    {
      "id": "optional — generated as <session>-q<N> if omitted",
      "type": "choice | text | scale | widget",
      "text": "Question text",
      "note": "Clarification under the question (optional)",
      "options": [
        { "id": "a", "text": "Wrong option" },
        { "id": "b", "text": "Correct option", "correct": true }
      ],
      "min": 1,
      "max": 5,
      "slide": 6,
      "explain": "Shown to students, and on the slides, AFTER reveal",
      "hint": "Visible ONLY TO YOU (on /host): what to do with the result"
    }
  ]
}
```

- **`choice`** — options; more than one can be correct (`"correct": true`). Requires a non-empty `options`.
- **`text`** — free-form answer (cold open, exit ticket). No `options` needed.
- **`scale`** — a `min`..`max` scale (typically 1–5). The server computes the average.
- **`widget`** — an interactive front-end you supply (a richer form, a branching adventure, a small game). It runs **only on the student's phone**, in a sandboxed iframe, and reports **one** answer — see below.
- **`slide`** — *(PDF decks only)* the 1-based PDF page this question follows: the question and its result are inserted right after that page in the deck sequence. Omit it to keep a question out of the deck flow (still controllable from `/host`). Marp decks ignore `slide` — they place questions with inline markers instead (below).

### `widget` — your own interactive question

A widget supplies its own front-end but **borrows one of the three primitive contracts** for its answer, via `"answer": "choice" | "scale" | "text"`. That's the whole trick: a `choice`-widget is validated, revealed, archived and reported *exactly* like a `choice` question — only the phone runs the interactive part. The projector and `/host` show the ordinary distribution at reveal; nothing else in the engine needs to know a game was involved.

```json
{
  "type": "widget",
  "text": "Escape the dungeon — the gate you leave by is your answer.",
  "answer": "choice",
  "options": [
    { "id": "north", "text": "North gate" },
    { "id": "east",  "text": "East gate", "correct": true }
  ],
  "widget": {
    "srcdoc": "<!doctype html>… the whole game, inline …",
    "height": 460,
    "config": { "seed": 42, "lives": 3 }
  },
  "explain": "The east gate was the only safe exit."
}
```

- **`answer`** — the primitive kind the reported value is stored and graded as (`choice` needs `options`; `scale` needs `min`/`max`; `text` is free-form). Defaults to `choice`.
- **`widget.height`** — the iframe height on the phone, in px (80–2000).
- **`widget.config`** — an optional JSON object handed to the front-end verbatim at start.
- **`widget.isolate`** — opt into **cross-origin isolation** for an engine that needs threads / `SharedArrayBuffer`. When any widget in the session sets it, the student page is served with `COOP: same-origin` + `COEP: require-corp`, bundle docs assert `COEP` and their assets carry `CORP`, and the isolate widget's iframe runs with `allow-same-origin` (a **real origin**, so it can be `crossOriginIsolated`). That relaxes the sandbox — the widget can reach the page's origin — so `isolate` is **only** for a front-end you control (`src` / `package` / `url`, never inline `srcdoc`). A `url` widget must also send its own `COOP`/`COEP`. Leave it off unless your engine actually needs SharedArrayBuffer.

**Where the front-end comes from — exactly one of these `widget` keys.** A small thing can be inline; a real game is its own project (its own repo, build, tests, assets) and you reference its build output. All four load into the same sandbox and speak the same protocol — only *where the code lives* differs:

| Key | The front-end is… | Use it when |
|---|---|---|
| `srcdoc` | inline HTML, right in `questions.json` | a ≤~20-line form; a throwaway |
| `src` | a **built bundle** at a relative path in the session folder (e.g. `"widgets/dungeon/index.html"`; can't escape the folder) | the game's `dist/` is vendored into the content — **works fully offline** |
| `url` | a **self-hosted deployment** (`"https://games.example.edu/dungeon/v3/"`) | the game deploys itself (its own CI → a URL); needs the network in class |
| `dev` | the game's **dev server** (`"http://localhost:5173"`) | authoring with hot-reload; flip to `src`/`url` for class |
| `package` | a **vendored widget package** by name (`"dungeon-escape@3"`) | the recommended way to ship a real external game — see "Widget packages" below |

Because presik usually runs on a classroom LAN with no internet, **`src` (a vendored bundle) is the default for anything real** — the built artifact is copied into the content so class never depends on the network. `url` is there for online contexts. A game built with a bundler must emit **relative** asset paths (e.g. Vite `base: './'`) so it resolves when served under `/widget/…`; WebGL/wasm assets are served with correct MIME (`.wasm` → `application/wasm`, `.glb`, `.gltf`, `.ktx2`, …).

**The SDK — so a game never hand-rolls `postMessage`.** presik serves a tiny, dependency-free client at **`/widget-sdk.js`**:

```html
<script src="/widget-sdk.js"></script>
<script>
  const quiz = await PresikWidget.connect();   // does the ready/init handshake
  quiz.options;                                 // [{id,text?}, …]
  quiz.config;                                  // author config
  quiz.answer('east');                          // report the answer (gated server-side)
  quiz.on('reveal', q => paintWinner(q.correct));
</script>
```

A `srcdoc`/`src` widget loads it with `<script src="/widget-sdk.js">`; an **external project** installs it from GitHub Packages (`import PresikWidget from '@igorrkurr/presik-widget'`) so it builds and tests independently — see `packages/widget-sdk/`. That file also exports **`PresikWidget.mockHost(iframe, …)`** — a fake quiz host, so the game project can assert its integration (`host.answers` ⇢ what it reported) in its own CI, with no presik server involved.

### Widget packages — shipping an independently-built game

A real game is its own project (repo, build, tests, WebGL/wasm assets). You don't paste its code anywhere — you **vendor its build output** into the content, and reference it by name. This keeps the class **fully offline** while the game stays a separate, independently-versioned project.

**1. The game's build emits a `widget.json` manifest** at the root of its `dist/`:

```json
{
  "presikWidget": "1",
  "name": "dungeon-escape", "version": "3.2.0",
  "entry": "index.html",
  "answer": "choice",
  "options": [{ "id": "north" }, { "id": "east" }],
  "height": 480,
  "isolate": false
}
```

The manifest declares the answer contract and the **outcome ids the game can emit**; the quiz supplies the human labels and which is `correct`. `entry`/`height`/`isolate` become defaults the quiz inherits. (Build with **relative** asset paths — e.g. Vite `base: './'` — so assets resolve when served under `/widgetpkg/…`.)

**2. Vendor it once, with the CLI:**

```bash
presik widget add ../dungeon/dist         # copies dist → ./widgets/dungeon-escape@3.2.0/ (offline-ready)
presik widget add ../dungeon/dist --force  # overwrite an existing version
presik widget ls                            # list vendored packages
```

`add` reads the manifest for the name/version, copies the folder under `<content-root>/widgets/`, and prints the question snippet to paste.

**3. Reference it by name** (an exact version, a major range like `@3`, or bare name for the highest):

```json
{
  "type": "widget", "text": "Escape the dungeon.",
  "answer": "choice",
  "options": [{ "id": "north", "text": "North gate" }, { "id": "east", "text": "East gate", "correct": true }],
  "widget": { "package": "dungeon-escape@3", "config": { "seed": 42 } }
}
```

The server resolves the package at startup (a missing one refuses to launch — fail fast, not mid-class), serves it under `/widgetpkg/<name>@<version>/`, and — because a sandboxed widget runs at a **null origin** — serves its assets with `Access-Control-Allow-Origin: *` so the game can `fetch()` its own assets and wasm. Vendored packages live at the **content root** (`widgets/`), shared across every session, and are skipped by session discovery.

**The bridge (`postMessage`).** The sandboxed front-end and the student page speak a tiny protocol. The front-end has no access to the page, its storage, or the session — it can only send messages:

| Direction | Message | Meaning |
|---|---|---|
| widget → page | `{ presik: "ready" }` | booted; asks for its config + current state |
| page → widget | `{ presik: "init", answer, options, min, max, text, note, config, revealed, value, correct }` | sent once, in reply to `ready` |
| widget → page | `{ presik: "answer", value }` | the student's answer (an option `id`, a number, or text) |
| page → widget | `{ presik: "state", revealed, value, correct }` | reveal / value updates thereafter |

The reported `value` still passes through the **same validator** as a tapped button — a widget can only ever submit a *legal* answer for its declared kind, so untrusted front-end code can't stuff the archive. A minimal working widget (which the `/edit` "Widget" type seeds for you, and which doubles as the reference implementation) is ~20 lines: listen for `init`, draw the options, `postMessage` an `answer` on tap.

Because it's all just fields in `questions.json`, a widget is fully hand-authorable — `srcdoc`, `answer`, `options`, `config` and all — with no editor round-trip required. The `/edit` "Widget" card is a convenience over these same keys.

The file is validated at server startup — a JSON error or a malformed question stops the launch immediately, not in the middle of class. `presik new <session>` scaffolds a starting `questions.json` (and `deck.marp.md`, unless `--questions-only`) from `templates/` for you — see below.

## Placing questions in a deck — `"slide": N`

Placement is **the same for both deck kinds** and lives in `questions.json`, not in the deck: give a question a **`"slide": N`** (1-based) and presik shows it — and its result — right after that slide/page. Arrow keys walk `slide, slide, [question], [result], slide, …` in one synced sequence.

- **PDF deck** — presik renders the pages (pdf.js) and interleaves the quiz at the pages you chose.
- **Marp deck** — presik auto-generates the quiz marker slides from the `slide` numbers and builds them into your deck (native Marp/bespoke rendering; you write **no** markers). Slide numbers count every slide, including a `data-quiz-join` slide if you add one. If `N` exceeds the deck's slide count, the question is appended at the end (with a note at startup).

Questions **without** a `slide` don't appear in the deck at all — they're still runnable from `/host` (handy for an exit ticket).

### Optional: the join-QR slide (Marp only)

```markdown
---

<div data-quiz-join></div>

---
```

`data-quiz-join` is the one marker you may still hand-place: a large "Scan to join" QR, usually once near the start. (Question/result slides are generated for you from `slide`; PDF decks show a join QR in the corner automatically.)

For more on how the live quiz behaves on slides, arrow-key control, and "who sees what" — see `README.md`.

## Data the engine generates

Everything that isn't content, but gets produced while running, lives in one place — `<content-root>/.presik/` (created automatically, in `.gitignore`):

```
.presik/
  data.db          — shared SQLite database: all courses, sessions, groups, runs (runs/answers)
  results/         — a JSON snapshot of answers when the server stops (Ctrl+C), one per run
  history/<session>/ — previous versions of questions.json, kept by the /edit editor (50 per session)
```

The `runs`/`answers` tables have `course` and `session` columns derived from the session's path — so `report.js`/`presik-report` filters and compares both by session and by course, no matter how deeply the content is nested.

## Scaffolding a new session

`presik new <session>` (see `scaffold.js`) generates `questions.json` and `deck.marp.md` for a new session by copying `templates/questions.example.json` and `templates/deck.example.marp.md`, substituting the title. It never overwrites an existing `questions.json`/`deck.marp.md` — if either is already there, it errors out instead of touching them.

```bash
presik new s02                                # ./s02/questions.json + ./s02/deck.marp.md
presik new web-dev/s02 --title "S02 — Status codes"
presik new s02 --questions-only               # skip the deck, just the quiz
presik new s02 --dir <path>                   # content root isn't the current directory
```

## Optional flags (all override the default)

```bash
presik <session> --dir <path>     # content root isn't the current directory
presik <session> --port 8080
presik <session> --host 192.168.1.42  # advertised LAN address (default: auto-detected, skipping VPN/virtual)
presik <session> --key myword     # teacher key (default: random per run — see below)
presik <session> --group "3-A"    # group tag; without it — an interactive prompt in the terminal
presik <session> --no-group       # don't ask for a group name
presik <session> --tunnel         # public URL via cloudflared
presik <session> --qr path.svg    # where to write join-qr.svg (default — the session folder)
presik <session> --db path.db     # where the database is (default — .presik/data.db)
```

**The teacher key.** With no `--key`, presik generates a random key each run and prints it in the banner; the `/host` and `/slides` control links embed it. Because the project is public, a fixed default (there used to be `teach`) would let anyone on the network drive or reset a class — hence random. Pass `--key <word>` when you want a stable, memorable key (e.g. reused across a course); the links are only as private as you keep them.

## Settings file — `presik.config.json` (optional)

Typing the same flags every week gets old. Drop a **`presik.config.json`** at the content root and those flags become the defaults for the project:

```json
{
  "port": 8080,
  "key": "web-dev-2026",
  "group": "3-A"
}
```

A session can carry its own `presik.config.json` to override the root for that one session (e.g. a different port). The keys are exactly the flag names — `port`, `host`, `key`, `group`, `noGroup`, `tunnel`, `qr`, `db` — so there's nothing new to learn, and the values carry their JSON type (`"port": 8080`, `"tunnel": true`).

**Precedence — a flag always wins, so the command line never lies about what it's doing:**

```
CLI flag   >   <session>/presik.config.json   >   <root>/presik.config.json   >   built-in default
```

Notes:
- **`--dir` is the one setting a config file can't set** — it names where the content root (and so the config file itself) is found, which would be circular.
- **Relative `qr`/`db` paths in a config file resolve against that file's own directory**, not wherever you happen to run presik from — the file means the same thing regardless of your shell's cwd. (A path typed as a flag still resolves against the cwd, as you'd expect while typing it.)
- A `null` value reads as "not set", so a session file can defer a single key back to the root's value.
- The banner prints which config files were loaded, so a surprising port is a lookup, not a mystery.
- Unknown keys, wrong types, or a bad port stop the launch with a clear message — up front, not mid-class.

`presik.config.json` is settings only; it never contains questions or slides.

## The question editor — `/edit`

You can write `questions.json` by hand (the schema above is the whole contract), or edit it in a browser with a live, Google-Forms-style editor — whichever you prefer, on the same file. The editor is a **key-protected route on the normal server**, so students on the LAN can't reach it, and it stays available while a class is running (fixing a typo you only spot on the projector is exactly when you need it).

```bash
presik edit s01        # boots the server and opens the editor in your browser
presik edit s09        # a session with no questions.json yet? the editor opens blank
presik s01             # ...or just run normally — the banner prints the Editor URL
```

You can point `presik edit` at a session that doesn't have a `questions.json` yet (or a folder that doesn't exist at all): the editor opens on a blank quiz, and your **first save creates the file** — and its folder. It's the from-scratch path that doesn't need a template. (A plain `presik <session>` still needs a real `questions.json` to run — there'd be nothing to show a class.)

The banner shows it alongside the others:

```
  Editor:    http://192.168.1.5:3000/edit?key=ab12cd34   (write the questions — keep private)
```

How it behaves:

- **WYSIWYG cards** — one card per question, edited in place. An option row shows the circle the student taps; marking an option correct paints it the same green `/host` uses for the winning bar. Choice / text / scale is a one-tap switch, and switching away from *choice* keeps your options so switching back doesn't lose them.
- **Autosave** — changes write to `questions.json` about a second after you stop typing (`All changes saved` in the corner). Writes are **atomic** (a crash mid-save never leaves a half-written file) and keep the house formatting — one option per line — so the file still diffs cleanly and unknown keys like `_readme` survive untouched.
- **Ids are materialized on first save.** Answers are stored per question **id** (live and in the archive), so the editor writes each question's id into the file explicitly rather than leaning on position — that's what makes reordering safe, in the editor or later by hand. Editing a running session hot-reloads it: a question keeps its answers as long as it keeps its id.
- **Version history** — every save first snapshots the previous file under `.presik/history/<session>/` (at most one a minute, 50 kept). The "History" panel previews and restores any of them; restoring keeps the current version in the list, so it's undoable too. `Cmd/Ctrl+Z` undoes structural edits (add/delete/reorder/type).
- **Same validator as startup.** The editor refuses a save that the server would refuse to start on (duplicate id, an option-less choice question, `min ≥ max`), so the editor can't write a file that then won't launch. Half-typed questions just warn — they don't block the save.
- **Placement.** Each card's "Shows after slide N" writes the question's `"slide"` (see above); with no deck, the card says so and the question runs from `/host` only.

The editor is built as a shell with pluggable modules (Questions today), so a slide editor can arrive as a second tab on the same page without changing any of this.
