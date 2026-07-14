# presik

Live in-class quizzes, embedded directly into Marp slides. Students answer from their phones, slides on the projector show the question and the result, and arrow keys drive the presentation and the quiz at the same time.

The engine (server, slide build, analytics) and the content (a specific class's slides and questions) are separate things. Install the engine once, then just drop `deck.marp.md` + `questions.json` into a folder — and it works whether that's a single deck, a whole course, or several courses at once. Full format contract — `CONVENTIONS.md`.

## Install

```bash
npm install                    # inside the engine folder — once
npm link                       # makes the presik / presik-report commands available globally
```

(Or without `npm link` — run `node /path/to/engine/server.js ...` or `node /path/to/engine/report.js ...` directly.)

## Quick start

```bash
cd my-course/            # your content root: sessions with deck.marp.md + questions.json
presik                   # no argument — lists sessions (or runs it directly if there's only one)
presik s01               # runs the ./s01/ session
presik web-dev/s01       # a session can live at any depth — it's just a path
```

If a group name wasn't passed via `--group` and the terminal is interactive, the server asks right away:

```
  Group/cohort name for this session (Enter — no name):
```

Then the terminal shows the addresses:

```
  presik v3.0.0
  S1 — The Request's Journey  ·  session: s01  ·  questions: 9  ·  group: 3-A

  Students:  http://192.168.1.42:3000/
  Teacher:   http://192.168.1.42:3000/host?key=teach
  Slides:    http://192.168.1.42:3000/slides?key=teach  (without ?key= — view only, no control)

  DB:        .presik/data.db  (for analysis — presik-report)
```

Slides on the projector — **must be opened with `?key=...`**, otherwise arrow keys won't control the quiz (see below). The quiz isn't a separate page — it's embedded directly into the slides. `/host?key=...` doesn't control anything — it's just a live view synced with `/slides` (question, the `hint` field, distribution), handy to keep on your phone separate from the projector. The only action available there is "Clear answers for this question".

All flags (`--dir`, `--port`, `--key`, `--group`, `--tunnel`, `--qr`, `--db`) — in `CONVENTIONS.md`.

## Live quiz — part of the slides themselves

In `deck.marp.md` — three empty markers (plain raw HTML; the deck is always built with `--html`):

```markdown
---

<div data-quiz-join></div>

---

<div data-quiz-question="s1-fragment"></div>

---

<div data-quiz-reveal="s1-fragment"></div>

---
```

- `data-quiz-join` — a large "Scan to join" QR code. Placed once, wherever makes sense (typically right after the title slide, before the first question).
- `data-quiz-question="<id>"` — a full-screen slide with the question text (and options, for choice) plus an "Answer on your phone" prompt with a live answer counter. `<id>` is the `id` of a question in this session's `questions.json`.
- `data-quiz-reveal="<id>"` — the next slide: vote distribution, the correct answer (green), `explain`. Before reveal it shows a neutral "Coming up".
- Question/reveal slides always have a small QR in the corner — for latecomers.

**Arrow keys are the remote control, and the only place control happens.** With `/slides?key=...` open (with the teacher's key) and paging through the deck on the projector with arrow keys, activating a question slide makes it the current question, and activating a reveal slide shows the result. Going back hides the result again the same way. `/host` just silently follows along (via the same `/api/stream`) — there's nothing to control from there, so the two never drift out of sync. Reveal doesn't need everyone to answer first — even a single answer is enough to move on; if not everyone has answered, the result slide itself shows "Still answering: X of Y connected".

If `/slides` is opened **without** `?key=...` (say, by a student), the page only shows the current state (like `/`) and controls nothing — same as before reveal, nobody but the teacher sees the correct answer or the distribution.

On every startup, and again on every `/slides` request, the server checks whether `deck.marp.md` is newer than `deck.marp.html` and rebuilds it via a locally installed `marp-cli` if so. `deck.marp.html` is a build artifact — don't edit it by hand.

## If the network won't cooperate

University Wi-Fi often isolates clients, so phones can't see your laptop. Options:

- **Share a hotspot from your phone**, connect your laptop to it. Simplest, always works.
- **`presik s01 --tunnel`** — brings up a public `https://…trycloudflare.com` URL via [cloudflared](https://developers.cloudflare.com/cloudflare-tunnel/) and points the QR at it. Requires `cloudflared` installed; if it's missing, the server just stays on the local network.

## Control and result visibility

Until a reveal slide is activated, students **see neither the correct answer nor the vote distribution**. This is intentional: otherwise they vote with the majority, and you lose the exact signal this is for.

One student, one vote (an anonymous id in `localStorage`). They can change their mind up until reveal.

"Connected" only counts real students (`/`) — the `/slides` tab (including your own, on the projector or for previewing) doesn't count towards it. Dead connections (a phone losing network, a backgrounded tab) get cleaned up on a failed heartbeat, within ~25s at most — so the count doesn't accumulate "ghosts" over the course of a class.

## Results and analytics

- During class: the distribution on the teacher's screen.
- `GET /api/export?key=…` — JSON with all answers from the current run.
- When the server stops (`Ctrl+C`), answers also land in `.presik/results/<session>-<group>-<date>.json` — a handy one-off snapshot of a single class.
- Every answer is written immediately (not just on exit) to a shared SQLite database, `.presik/data.db` — one file for the whole content root, all courses/sessions/groups together.

Compare groups, sessions, or courses — `presik-report` (same database, no server needed):

```bash
presik-report                                   # list all runs
presik-report --session s01                      # per question in s01: % correct, broken down by group
presik-report --session web-dev/s01 --group "3-A"  # same path as when running the session
presik-report --course web-dev                    # all sessions of one course
presik-report --csv > answers.csv                  # all answers as CSV — for pandas/Excel/whatever
```

`.presik/` is in `.gitignore`: no personal data in a content repository (and there isn't any anyway — answers are anonymous).

## Your own class

Create a folder (e.g. `s02/`) and put a `questions.json` in it, following `templates/questions.example.json`. Want slides too — copy `templates/deck.example.marp.md` there as well, as `deck.marp.md` (its markers already match the example questions).

The full `questions.json` schema, session/course naming rules, what the engine generates, and every optional flag — `CONVENTIONS.md`.

### About the `hint` field

This is the main thing that sets this apart from a regular quiz. `hint` is visible **only to you**, on `/host`, under the distribution:

> *If a noticeable share picked 5xx on a question about 404 — that's the classic "404 = the server broke" confusion. Slow down here.*

The point isn't to grade anyone — it's to see, in ten seconds, whether it's safe to move on.
