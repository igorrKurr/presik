---
name: presik
description: Create, run and analyse live in-class quizzes with presik — students answer on their phones while the projector shows slides (Marp, PDF, PowerPoint or Keynote) with the quiz interleaved. Use when the user wants to write or edit a presik questions.json, turn lecture material or a slide deck into quiz questions, scaffold a session or course, place questions after specific slides, run a class (ports, teacher key, groups, tunnel), set up presik.config.json, vendor a widget, export a Marp deck to PDF with or without quiz slides, or read results with presik report / presik-report. Triggers on "presik", "questions.json", "in-class quiz", "live quiz for my lecture", "clicker questions", "exit ticket", "quiz in my slides", "export my slides to PDF".
---

# presik

presik is a local CLI (`npm i -g presik`, `npx presik`, or a single-file binary) that runs a live quiz server on the teacher's machine. The **engine** is the CLI; the **content** is plain files in a folder the user owns. Your job is almost always to write or fix content files and tell the user which command to run.

Always confirm the facts with the installed CLI instead of memory when in doubt: `presik help`, `presik help <run|new|edit|export|widget|report|config>`. The full reference is `docs/CLI.md` in the presik repo.

## Core model

- **Content root** — the directory presik runs in (or `--dir <path>`). Answers go to `<root>/.presik/data.db`.
- **Session** — any folder under the root (up to 4 levels deep) holding `questions.json` and optionally a deck. Its name is its relative path: `s01`, `web-dev/s01`.
- **Deck** (optional, first match wins): `deck.marp.md` → `deck.pdf` → `deck.pptx` → `deck.key`. Without a deck, the projector uses `/present`.
- **Three screens**: students at `/`, the teacher's private cockpit at `/host?key=…` (live distribution *before* reveal, private `hint`), the room's projector at `/slides?key=…` (hides results until reveal; arrow keys drive slides and quiz together).

## Workflow: build a session from lecture material

1. **Scaffold** (or create files directly if presik isn't installed where you are):
   ```bash
   presik new <session> --title "S03 — Title"          # questions.json + deck.marp.md
   presik new <session> --questions-only               # user brings a PDF/PPTX/Keynote deck
   ```
   `new` refuses to overwrite existing files — edit those in place instead.
2. **Write `questions.json`** following [references/questions-schema.md](references/questions-schema.md). Read it before writing questions — it has the exact fields, validation rules, and widget format.
3. **Place questions** with `"slide": N` — the 1-based slide/page the question appears *after*. This works the same for Marp and PDF/PPTX/Keynote decks; don't hand-write quiz marker slides in Marp. Count slides in `deck.marp.md` by `---` separators (the front-matter block is not a slide). Omit `slide` for questions run only from `/host` (e.g. an exit ticket).
4. **Validate** by starting it: `presik <session> --no-group`. presik validates `questions.json` and `presik.config.json` at startup and exits with a clear message on any problem — fix and retry. Stop it with Ctrl+C once the banner prints. (Mind that this is a long-running server; run it in the background or ask the user to run it.)
5. **Tell the user how to run class** (see below).

## Writing good presik questions

presik is for *formative* feedback — finding out whether it's safe to move on — not grading. Aim for:

- **3–8 questions per 45–90 min class**, spread across the deck at the points where a misconception would derail what comes next.
- **`choice` distractors that are real misconceptions**, not filler. Each wrong option should correspond to a specific wrong mental model.
- **A `hint` on every question** — the teacher-only note that says what to *do* with the result: "If >30% pick c, they think 404 means the server crashed — go back to slide 7." This is presik's most valuable field; never leave it generic.
- **`explain`** — one or two sentences shown to everyone after reveal: why the right answer is right.
- A `text` **cold open** near slide 1 and/or an exit ticket with no `slide`; a `scale` confidence check (1–5) before a hard section.
- Short question text — it's read on a phone and a projector. Keep option text under ~80 characters.
- Stable, readable `id`s (`http-404`, `cold-open`) — answers are stored per id, so changing an id later splits the history.

## Running a class

```bash
presik <session> --group "3-A"            # prints Students/Teacher/Slides/Editor links
presik <session> --key web-dev-2026       # stable teacher key instead of a random one
presik <session> --port 8080 --host 192.168.1.42
presik <session> --tunnel                 # public URL via localhost.run over ssh (remote/Zoom students)
presik <session> --tunnel=cloudflare      # … via cloudflared instead (some carriers block trycloudflare.com)
# With --tunnel, teacher pages (/host, /edit, /report, slides control) work only on the laptop/LAN — never through the tunnel.
presik edit <session>                     # browser editor for questions.json
presik export <session>                   # Marp deck → PDF, quiz slides left out
presik export <session> --with-quiz       # … with static question + answer slides (no hints)
```

- Projector: open the `Slides:` link **with** `?key=`, press `f` for fullscreen. Teacher's phone: the `Teacher:` link. Never put `/host` on the projector.
- Phones can't reach the laptop (isolated campus Wi-Fi)? Suggest a phone hotspot or `--tunnel`. Wrong address advertised (VPN/Docker)? `--host <real LAN IP>`.
- Recurring flags go into `presik.config.json` at the root or in a session folder — keys `port`, `host`, `key`, `group`, `noGroup`, `tunnel`, `qr`, `db`. A CLI flag always wins over the file; `--dir` can't be set there.
- Marp decks need the Node install (Marp is an optional dependency, absent in the single-file binary). PPTX/Keynote conversion uses PowerPoint/Keynote if installed, else LibreOffice.

## Analysing results

```bash
presik report                                     # list all runs
presik report --session s01                       # % correct per question, by group
presik report --course web-dev --group "3-A"
presik report --csv > answers.csv                 # raw answers for pandas/Excel
presik report --session s01 --html report.html    # offline interactive report
presik report --session s01 --pdf report.pdf      # needs Chrome (CHROME_PATH); falls back to .html
```

`presik-report` is the same command. When asked to interpret results, run the text or CSV form and connect low-scoring questions to their `hint`s and the misconceptions their distractors encode.

## Don'ts

- Don't edit `deck.marp.html`, `.deck.build.md`, `join-qr.svg` or anything in `.presik/` — they're generated.
- Don't put settings in `questions.json` or questions in `presik.config.json`.
- Don't use `srcdoc` widgets with `"isolate": true` — isolation is only for `src`/`package`/`url` widgets.
- Don't hand-write the Marp CLI to make a PDF of a presik deck — `presik export` also strips (or renders) the quiz slides, which raw Marp would leave as empty placeholders.
- Don't invent flags. If unsure, run `presik help <topic>`.
