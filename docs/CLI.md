# presik CLI reference

Every command, flag, setting and environment variable presik understands. For the content format (`questions.json`, decks, widgets) see [`CONVENTIONS.md`](../CONVENTIONS.md); for a guided walkthrough see the [README](../README.md).

The same information is available in the terminal:

```bash
presik help                # overview
presik help <topic>        # run · new · edit · export · widget · report · config
presik --help              # same as `presik help`
presik <command> --help    # same as `presik help <command>`
presik --version           # print the version (also -v)
```

**Contents**

- [Commands at a glance](#commands-at-a-glance)
- [`presik [<session>]` — run a class](#presik-session--run-a-class)
- [`presik new` — scaffold a session](#presik-new--scaffold-a-session)
- [`presik edit` — edit questions in the browser](#presik-edit--edit-questions-in-the-browser)
- [`presik export` — Marp deck to PDF](#presik-export--marp-deck-to-pdf)
- [`presik widget` — widget packages](#presik-widget--widget-packages)
- [`presik report` / `presik-report` — analytics](#presik-report--presik-report--analytics)
- [`presik.config.json` — saved settings](#presikconfigjson--saved-settings)
- [Environment variables](#environment-variables)
- [Exit codes](#exit-codes)

---

## Commands at a glance

| Command | What it does |
|---|---|
| `presik [<session>] [options]` | Run a session. With no session: run the content root if it's the only one, otherwise list every session found. |
| `presik new <session> [options]` | Scaffold `questions.json` (+ `deck.marp.md`) from the templates. |
| `presik edit <session> [options]` | Run the session with the browser question editor opened. |
| `presik export <session> [options]` | Export the Marp deck to PDF — quiz slides left out unless `--with-quiz`. |
| `presik widget add <dist> [options]` | Vendor a built widget bundle into `widgets/`. |
| `presik widget ls [options]` | List vendored widget packages. |
| `presik report [options]` | Analyse saved answers. Identical to `presik-report`. |
| `presik help [<topic>]` | Show help, optionally for one topic. |
| `presik --version`, `-v` | Print the version. |

**Content root.** Every command works relative to a *content root* — the current directory, or whatever `--dir <path>` points at. A *session* is any folder under it (at any depth) that contains `questions.json` and/or `deck.marp.md`; its name is its path, e.g. `s01` or `web-dev/s01`.

**Flag syntax.** Flags are `--name value` (space-separated; `--name=value` is not supported). A value can't start with `--`.

---

## `presik [<session>]` — run a class

```bash
presik [<session>] [options]
```

Starts the server for one session and prints the links to open: `Students:` (phones), `Teacher:` (`/host`, your private cockpit), `Slides:` (the projector, when the session has a deck) or `Projector:` (`/present`, questions-only sessions), and `Editor:`. Stop with `Ctrl+C` — answers are saved as they arrive, and a crashed run resumes on the next start.

A deck can be `deck.marp.md` (needs the Marp optional dependency — not in the single-file binary), `deck.pdf`, `deck.pptx` or `deck.key` (converted to PDF with PowerPoint/Keynote when installed, otherwise LibreOffice).

### Options

| Flag | Value | Default | Description |
|---|---|---|---|
| `--dir` | path | current directory | Content root. The only setting `presik.config.json` can't set. |
| `--port` | number | `3000` | HTTP port. If it's taken, presik suggests the next one. |
| `--host` | IP address | auto-detected | LAN address advertised in the links and QR. Auto-detection skips VPN/virtual interfaces; use this when students can't reach the printed link. |
| `--key` | word | random each run (12 hex chars) | Teacher key guarding `/host`, `/slides` control, `/report` and `/edit`. Pin one to reuse links across a course. 20 wrong guesses from one address lock that address out for 15 min. Never accepted through `--tunnel`. |
| `--group` | name | asked interactively | Group/cohort tag stored with every answer of this run. |
| `--no-group` | — | off | Don't ask for a group. (Also skipped automatically when stdin isn't a terminal.) |
| `--tunnel` | — | off | Expose a public `https://…lhr.life` URL via [localhost.run](https://localhost.run) (over `ssh`, nothing to install) and point the QR at it. The link appears once it's reachable; if the connection drops presik reconnects, and updates the QR if the address changed. If the tunnel can't come up, presik stays on the LAN. Only the student side answers through the tunnel: teacher pages and APIs return 403 there even with the key, so the printed teacher links use the LAN address. |
| `--tunnel=cloudflare` | — | — | The same via a `cloudflared` quick tunnel on `trycloudflare.com` (needs `cloudflared` on `PATH`). Some mobile carriers block `trycloudflare.com` — students' pages then just hang — which is why it isn't the default. |
| `--qr` | file path | `<session>/join-qr.svg` | Where to write the join-QR SVG. |
| `--db` | file path | `<content-root>/.presik/data.db` | SQLite database answers are written to. |
| `-h`, `--help` | — | — | Show help for this command. |

### Examples

```bash
presik                                   # run the only session, or list them
presik s01                               # run ./s01/
presik web-dev/s01 --group "3-A"         # nested session, tagged with a group
presik s01 --port 8080 --key myword      # fixed port and a memorable key
presik s01 --host 192.168.1.42           # advertise a specific LAN address
presik s01 --dir ~/courses/web-dev       # content root elsewhere
presik s01 --tunnel                      # students join over the internet (e.g. a Zoom class)
presik s01 --tunnel=cloudflare           # … via cloudflared instead of localhost.run
presik s01 --no-group --db /tmp/test.db  # a throwaway rehearsal
```

### Pages the server exposes

| Path | Audience | Notes |
|---|---|---|
| `/` | students | Answer on a phone. |
| `/host?key=…` | you | Live distribution before reveal, private `hint`, controls. Never project it. |
| `/slides?key=…` | the room | Deck with the quiz interleaved; arrow keys drive both. Without `?key=` it's view-only. |
| `/present` | the room | For questions-only sessions: join QR, live counter, results. |
| `/report?key=…` | you | Interactive analytics over the whole database. |
| `/edit?key=…` | you | The question editor. |
| `/api/export?key=…` | you | JSON of every answer in the current run. |

---

## `presik new` — scaffold a session

```bash
presik new <session> [options]
```

Creates `<session>/questions.json` and `<session>/deck.marp.md` from the built-in templates. The example questions already carry `slide` numbers that match the template deck. Refuses to overwrite either file if it exists.

| Flag | Value | Default | Description |
|---|---|---|---|
| `--title` | text | `S00 — <session>` | Quiz title written into `questions.json`. |
| `--questions-only` | — | off | Skip `deck.marp.md` — for PDF/PowerPoint/Keynote decks. |
| `--dir` | path | current directory | Content root. |

```bash
presik new s02
presik new web-dev/s02 --title "S02 — Status codes"
presik new lecture-05 --questions-only       # then drop lecture-05/deck.pptx in
```

---

## `presik edit` — edit questions in the browser

```bash
presik edit <session> [options]
```

Runs the normal server for `<session>` and opens `/edit` in your browser: a live editor for `questions.json` with autosave, drag-to-reorder, one-tap question-type switching, undo (`Cmd/Ctrl+Z`) and a restorable version history. The session folder and `questions.json` don't need to exist — the first save creates them, and a broken `questions.json` opens in the editor instead of stopping the launch.

Accepts every [run option](#options) (`--port`, `--key`, `--dir`, …).

```bash
presik edit s01
presik edit s09 --port 3001      # new session, alongside a running class on 3000
```

Details: [`CONVENTIONS.md` → The question editor](../CONVENTIONS.md#the-question-editor--edit).

---

## `presik export` — Marp deck to PDF

```bash
presik export <session> [options]
```

Renders `<session>/deck.marp.md` to a PDF with Marp — for handouts, uploading to an LMS, or presenting without presik. It uses the same Marp that builds `/slides`, so the PDF looks the same.

**Quiz slides are left out by default.** That covers questions placed with `"slide": N`, quiz markers written into the deck by hand (`<div data-quiz-question="…">` / `data-quiz-reveal`), and the join-QR slide — a QR pointing at a server that isn't running is useless on paper. A slide that contained nothing but a marker is dropped rather than exported blank.

**`--with-quiz`** swaps each quiz slide for a static version instead: a *Question* slide (text, note, and the options / scale range / "Open answer") and an *Answer* slide (the correct options and `explain`). The answer slide is skipped when there's nothing to show; the teacher-only `hint` is never included. Generated slides carry the Marp class `presik-quiz`, so a custom theme can style them.

| Flag | Value | Default | Description |
|---|---|---|---|
| `--with-quiz` | — | off | Include static question/answer slides. |
| `--out` | file path | `<session>/deck.marp.pdf` (`deck.marp.quiz.pdf` with `--with-quiz`) | Where to write the PDF. |
| `--open` | — | off | Open the PDF once written. |
| `--dir` | path | current directory | Content root. |

```bash
presik export s01                                  # slides only → s01/deck.marp.pdf
presik export s01 --with-quiz                      # + questions and answers → s01/deck.marp.quiz.pdf
presik export web-dev/s01 --out handout.pdf --open
```

Images work whether the deck links them relative to the session folder (`assets/fig.svg`) or through the server path presik serves them on (`/slides/assets/fig.svg`) — the export rewrites the latter to file paths, since there's no server behind a PDF.

Needs Chrome, Edge or Firefox (set `CHROME_PATH` if Marp can't find it) and the npm install — the single-file binary ships without Marp. For a PowerPoint/Keynote deck, the PDF presik converts on every run is in `.presik/cache/`; a `deck.pdf` is already a PDF.

---

## `presik widget` — widget packages

```bash
presik widget add <path-to-built-dist> [--force] [--dir <path>]
presik widget ls [--dir <path>]
```

Copies an independently-built interactive widget (a game, a simulation…) into `<content-root>/widgets/<name>@<version>/`, so a `widget` question can reference it by package name and the class runs fully offline. The bundle must have a `widget.json` manifest at its root.

| Subcommand / flag | Description |
|---|---|
| `add <dir>` | Vendor the built bundle in `<dir>`. |
| `ls` (alias `list`) | List vendored packages. |
| `--force` | With `add`: overwrite an already-installed version. |
| `--dir <path>` | Content root (default: current directory). |

```bash
presik widget add ../dungeon/dist
presik widget add ../dungeon/dist --force
presik widget ls
```

Manifest format: [`CONVENTIONS.md` → Widget packages](../CONVENTIONS.md#widget-packages--shipping-an-independently-built-game).

---

## `presik report` / `presik-report` — analytics

```bash
presik report [options]
presik-report [options]          # same thing, separate binary from the npm package
```

Reads the answers database directly — no server needed. With no `--session` it lists every run.

### Filters

| Flag | Value | Description |
|---|---|---|
| `--session` | session path | One session, the same path you ran it with (e.g. `web-dev/s01`). |
| `--course` | course name | Every session of one course. |
| `--group` | group name | One group/cohort. |

### Output modes

| Flag | Value | Description |
|---|---|---|
| *(none)* | — | Text: list of runs, or (with `--session`) % correct per question, broken down by group; average for `scale` questions. |
| `--csv` | — | Every matching answer as CSV on stdout. |
| `--html` | file (optional) | Standalone, offline copy of the interactive `/report` page. Default file: `presik-report-<label>.html`. |
| `--pdf` | file (optional) | The same visuals as PDF via a headless Chrome/Chromium. If none is found (or from the single-file binary), writes the `.html` instead and asks you to Print → Save as PDF. |
| `--open` | — | With `--html`/`--pdf`: open the file once written. |

### Location

| Flag | Value | Default |
|---|---|---|
| `--dir` | path | current directory |
| `--db` | file path | `<content-root>/.presik/data.db` |

### Examples

```bash
presik report                                          # list all runs
presik report --session s01                            # per question, by group
presik report --session web-dev/s01 --group "3-A"      # one group
presik report --course web-dev                         # a whole course
presik report --csv > answers.csv                      # everything, for pandas/Excel
presik report --session s01 --html report.html         # offline interactive report
presik report --session s01 --pdf report.pdf --open    # PDF, then open it
```

---

## `presik.config.json` — saved settings

Optional JSON file holding defaults for the [run options](#options), so you don't retype them every week. It can live at the content root (whole project) and/or inside a session folder (that session only).

| Key | Type | Equivalent flag |
|---|---|---|
| `port` | number | `--port` |
| `host` | string | `--host` |
| `key` | string | `--key` |
| `group` | string | `--group` |
| `noGroup` | boolean | `--no-group` |
| `tunnel` | `true`, `"localhost.run"` or `"cloudflare"` | `--tunnel[=…]` |
| `qr` | path | `--qr` |
| `db` | path | `--db` |

```json
{ "port": 8080, "key": "web-dev-2026", "group": "3-A" }
```

**Precedence:**

```
CLI flag  >  <session>/presik.config.json  >  <root>/presik.config.json  >  built-in default
```

- `--dir` can't be set in the file — it decides where the file is looked up.
- Relative `qr`/`db` paths resolve against the config file's own directory (a path typed as a flag resolves against the current directory).
- `null` means "not set", so a session file can defer a key back to the root file.
- Unknown keys, wrong types or an invalid port stop the launch with a message listing every problem.
- The startup banner shows which config files were loaded.

---

## Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `CHROME_PATH` | `report --pdf`, `export` | Chrome/Chromium/Edge binary to render the PDF with. |
| `PUPPETEER_EXECUTABLE_PATH` | `report --pdf` | Same as `CHROME_PATH`; checked first. |
| `NO_COLOR` | `help` | Disable bold/dim styling in help output. |
| `PRESIK_NODE_VERSION` | `npm run build` | Node version to download for the single-file binary when the local Node can't be used. |

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (including `help`, `--version`, and listing sessions). |
| `1` | Bad input or environment: unknown help topic, missing/invalid `questions.json`, no `deck.marp.md` or no Marp for `export`, invalid `presik.config.json`, session outside the content root, port in use, missing database for `report`, Node older than 22.5. |
