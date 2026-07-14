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
| `questions.json` | yes | you | the quiz definition — schema below |
| `deck.marp.md` | no | you | Marp slides; if present, `/slides` appears |
| `deck.marp.html` | — | engine (automatic) | build artifact from `deck.marp.md`; don't edit, don't commit |
| `join-qr.svg` | — | engine (automatic) | QR with the current join link; rewritten every run |

`deck.marp.md` without `questions.json` doesn't make sense (nothing to show on `/host`, nothing to control). `questions.json` without `deck.marp.md` is a fully working mode: students and `/host` work fine, there's just no `/slides`.

## `questions.json` — schema

```json
{
  "title": "S01 — Class name",
  "questions": [
    {
      "id": "optional — generated as <session>-q<N> if omitted",
      "type": "choice | text | scale",
      "text": "Question text",
      "note": "Clarification under the question (optional)",
      "options": [
        { "id": "a", "text": "Wrong option" },
        { "id": "b", "text": "Correct option", "correct": true }
      ],
      "min": 1,
      "max": 5,
      "explain": "Shown to students, and on the slides, AFTER reveal",
      "hint": "Visible ONLY TO YOU (on /host): what to do with the result"
    }
  ]
}
```

- **`choice`** — options; more than one can be correct (`"correct": true`). Requires a non-empty `options`.
- **`text`** — free-form answer (cold open, exit ticket). No `options` needed.
- **`scale`** — a `min`..`max` scale (typically 1–5). The server computes the average.

The file is validated at server startup — a JSON error or a malformed question stops the launch immediately, not in the middle of class. A starter example — `templates/questions.example.json`.

## `deck.marp.md` — live quiz markers

Three `<div>` markers (plain raw HTML — the deck is always built with `--html`), each on its own Marp slide (between `---`):

```markdown
---

<div data-quiz-join></div>

---

<div data-quiz-question="<id of a question from questions.json>"></div>

---

<div data-quiz-reveal="<the same id>"></div>

---
```

- `data-quiz-join` — a large "Scan to join" QR code. Optional, usually once near the start of the deck, before the first question.
- `data-quiz-question="<id>"` — a full-screen slide with the question; on the projector, the `→` arrow that lands on it makes that question current.
- `data-quiz-reveal="<id>"` — the result slide; the arrow that lands on it shows the result.

`<id>` must match the `id` of a question in this session's `questions.json` (explicit or auto-generated — if you don't set `id` by hand, check what it ended up being during startup validation). Questions without a matching slide pair (question+reveal) simply don't appear on the projector — control them via `/host` only, if needed.

For more on how the live quiz behaves on slides, arrow-key control, and "who sees what" — see `README.md`.

## Data the engine generates

Everything that isn't content, but gets produced while running, lives in one place — `<content-root>/.presik/` (created automatically, in `.gitignore`):

```
.presik/
  data.db          — shared SQLite database: all courses, sessions, groups, runs (runs/answers)
  results/         — a JSON snapshot of answers when the server stops (Ctrl+C), one per run
```

The `runs`/`answers` tables have `course` and `session` columns derived from the session's path — so `report.js`/`presik-report` filters and compares both by session and by course, no matter how deeply the content is nested.

## Optional flags (all override the default)

```bash
presik <session> --dir <path>     # content root isn't the current directory
presik <session> --port 8080
presik <session> --key myword     # teacher key (default "teach")
presik <session> --group "3-A"    # group tag; without it — an interactive prompt in the terminal
presik <session> --no-group       # don't ask for a group name
presik <session> --tunnel         # public URL via cloudflared
presik <session> --qr path.svg    # where to write join-qr.svg (default — the session folder)
presik <session> --db path.db     # where the database is (default — .presik/data.db)
```
