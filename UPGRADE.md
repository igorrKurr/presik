# From v2 → v3.0.0: engine separated from content

v3 changes the structure of content files (not the questions/slides themselves, but where they live) so a single engine can serve one deck, one course, or several courses the same way. This is a breaking layout change — old paths no longer work.

## What to rename

| Was (v2) | Now (v3) |
|---|---|
| `questions/s01.json` | `s01/questions.json` |
| `slides/s01-<anything>.marp.md` | `s01/deck.marp.md` |
| `slides/s01-<anything>.marp.html` | `s01/deck.marp.html` (rebuilds itself) |
| `slides/join-qr.svg` | `s01/join-qr.svg` (rewrites itself) |
| `data/lecture-quiz.db` | `.presik/data.db` (old database is picked up — the schema grows itself) |
| `results/*.json` | `.presik/results/*.json` |
| `questions/_template.json` | `templates/questions.example.json` |
| `node server.js s01` | `presik s01` (after `npm link`), or as before — `node server.js s01` |

The `<id>` used in `data-quiz-question`/`data-quiz-reveal` markers in `.marp.md` doesn't change — it was always the `id` of a question in `questions.json`, that file just now lives alongside the deck instead of in a separate `questions/` folder.

Full contract for the new layout — `CONVENTIONS.md`.

---

# What to do to get it working (v1 → v2.0.0)

The error `TypeError: qr.svg is not a function` means you still have files from
the previous, unfinished version.

## In your `~/dev/viti/techweb` folder

1. **Delete the old files:**

   ```bash
   rm -f server.js qr.js
   ```

   `qr.js` isn't needed at all anymore — QR generation now comes from the `qrcode` package.

2. **Drop in the files from this version** (`server.js`, `package.json`, `public/`,
   `questions/`, `README.md`).

3. **Install the dependency:**

   ```bash
   npm install
   ```

4. **Run it:**

   ```bash
   node server.js s01
   ```

   The first line of output should be:

   ```
   lecture-quiz v2.0.0
   ```

   If you don't see the version — you're running the old file.

## How to check the version going forward

- in the terminal at startup: `lecture-quiz v2.0.0`;
- on the teacher's screen — under the QR, in small print;
- in the `VERSION` file.

## What changed in v2.0.0

- **Fixed startup.** Removed the custom QR generator (`qr.js`), which had two
  bugs; now uses the `qrcode` package.
- **QR is built automatically** from the current address and written to
  `../slides/join-qr.svg`. The slide always links to this file the same way —
  only the file's contents change.
- **`--tunnel`** — a public address via `cloudflared`, QR points at it directly.
- **Works for any class:** `node server.js` with no arguments shows the
  list of sessions; questions live in `questions/<session>.json`; there's a
  `questions/_template.json`.
- **New `scale` question type** (a 1–5 scale, shows the average) alongside
  `choice` and `text`.
- **JSON validated at startup** — an error in the questions file surfaces
  immediately, not in the middle of class.
- **Results are saved** to `results/` on `Ctrl+C`.
