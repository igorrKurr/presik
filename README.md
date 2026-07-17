# presik

Live in-class quizzes for interactive lectures. Students answer from their phones, the projector shows the question and then the result, and you keep the whole room in sync — either by embedding the quiz **directly into Marp slides** (arrow keys drive the slides *and* the quiz together), or by running your existing **PowerPoint / Keynote** deck as-is with a one-button control in your hand.

It runs **on your own machine, on the classroom network** — no accounts, no cloud, no student data leaving the room.

The engine (server, slide build, analytics) and your content (a class's slides and questions) are separate. Install the engine once, then drop a `questions.json` (and, optionally, a `deck.marp.md`) into a folder — it works whether that's a single quiz, a whole course, or several courses at once. Full format contract: [`CONVENTIONS.md`](CONVENTIONS.md).

---

## The mental model: three kinds of screen

The single most important thing to understand is that **different people look at different screens, and they are *not* meant to show the same thing.**

| Screen | URL | Who looks at it | On what device | What it shows | Can it control? |
|---|---|---|---|---|---|
| **Students** | `/` | each student | their own phone | the current question to answer; the result after you reveal | answer only |
| **Your cockpit** | `/host?key=…` | **you, privately** | your phone / tablet / laptop | the question, the live distribution **even before reveal**, your private `hint`, and the controls | **yes — you drive the quiz here** |
| **The room** | `/slides?key=…` | the whole class | the projector (or a Zoom screen-share) | your **deck** — Marp or a PDF — rendered with the quiz **interleaved into it**; **arrow keys drive slides and quiz together** | yes, via arrow keys |
| *(no deck)* | `/present` | the whole class | the projector | for a **questions-only** session: join QR, live counter, distribution after reveal | no (view-only) |

### Why `/host` and `/slides` aren't the same thing

They render some of the same things, but they have **opposite audiences and opposite rules** — that difference *is* the product:

- **`/slides` is for the room.** It deliberately **hides the distribution and the correct answer until you reveal** — otherwise students just vote with the visible majority and you lose the real signal. Opened without `?key=` it controls nothing.
- **`/host` is for you, and only you.** It shows the distribution **immediately** (that's how you decide whether it's safe to move on), it shows your private **`hint`**, and it has the **buttons** to run the quiz. You keep this in your hand. **Never put `/host` on the projector** — it would spoil the vote and leak your notes.

**presik owns the deck**, so the room's screen is always `/slides`, whatever your source format:

- **Marp deck (`deck.marp.md`)** → rendered to native HTML slides; presik inserts the quiz at the `slide` numbers.
- **PDF deck (`deck.pdf`)** → rendered by pdf.js, quiz interleaved at the pages you choose (a question's `"slide": N`). Export from Keynote/PowerPoint/Google Slides — or later, drop the `.pptx`/`.key` and presik converts it under the hood.

Because it's one fullscreen web page, the same `/slides` is what you put on the projector **or** screen-share in Zoom. So a class uses **three screens at once**: the room's `/slides`, your private `/host`, and every student's `/`.

---

## Install

Pick whichever fits — all three run the same engine:

**1. Single-file binary — no Node, no install.** Download the `presik` executable for your OS from Releases and run it:

```bash
chmod +x presik            # macOS/Linux (on Windows it's just presik.exe)
./presik                   # run it from a folder of sessions — commands below
```

It bundles its own runtime, so there's nothing to install — ideal for the PowerPoint/Keynote workflow. The only thing the binary leaves out is **Marp slide-building** (`/slides`); for that use a Node install below. `presik new` and `presik report` work from the binary too.

**2. npm / from source — needs Node 22.5+.** Includes Marp. (presik uses Node's built-in SQLite, so there's still nothing to compile — no C++ toolchain, no `node-gyp`.)

```bash
git clone <repo> && cd presik
npm install                # once
npm link                   # makes `presik` and `presik-report` global commands
```

(Or skip `npm link` and run `node server.js …` / `node report.js …` directly.)

**Build your own binary** (for the current OS — cross-compiling isn't supported):

```bash
npm run build              # → dist/presik  (or dist/presik.exe on Windows)
```

---

## Running it

```bash
cd my-course/          # your "content root": folders that hold questions.json (+ optional deck.marp.md)
presik                 # no argument: run the only session, or list what's available
presik s01             # run the ./s01/ session
presik web-dev/s01     # a session can live at any depth — it's just a path
```

Unless you pass `--group` (or `--no-group`), it first asks for a group/cohort name to tag this run's results:

```
  Group/cohort name for this session (Enter — no name):
```

Then it prints the addresses you'll open — this is your map for the whole class:

```
  presik v4.0.0
  S1 — The Request's Journey  ·  session: s01  ·  questions: 9  ·  group: 3-A

  Students:  http://192.168.1.42:3000/
  Teacher:   http://192.168.1.42:3000/host?key=85d39768   (control + live view — keep private)
  Slides:    http://192.168.1.42:3000/slides?key=85d39768 (without ?key= — view only, no control)

  Key:       85d39768   (random this run; anyone with it controls the quiz — pin your own with --key)

  DB:        .presik/data.db   (for analysis — presik-report)
```

- The **`Slides:` line appears when the session has a deck** — `deck.marp.md` (needs Marp) or `deck.pdf`. A **questions-only** session shows a `Projector:` line (`/present`) instead — a stand-alone view with the QR + live results.
- The **teacher key is random every run**. It's what stops anyone else on the Wi-Fi from driving or resetting your class, so treat the `/host` and `/slides` links as private. Want a stable one (e.g. reused across a course)? Pass `--key yourword`.
- If students get a link they can't reach (a VPN or Docker network can hijack the auto-detected address), pass `--host 192.168.x.x` with your real LAN address — the terminal hints at this when it sees more than one candidate.

All flags (`--dir`, `--port`, `--key`, `--host`, `--group`, `--tunnel`, `--qr`, `--db`) — see [`CONVENTIONS.md`](CONVENTIONS.md).

---

## Scenario A — a PowerPoint / Keynote deck (via PDF), step by step

You keep your slides in your usual app; presik renders them and interleaves the quiz, so **you present from presik** and everything stays in sync — same as Marp. For now you export a PDF once *(auto-conversion of `.pptx`/`.key` is on the roadmap)*.

### Set up once (before the class, at your desk)

1. **Create the session:**
   ```bash
   cd ~/courses/web-dev            # your content root
   presik new lecture-05 --questions-only --title "S5 — HTTP status codes"
   ```
2. **Export your slides to PDF** from PowerPoint/Keynote/Google Slides (File → Export/Print → PDF), and save it as **`lecture-05/deck.pdf`**.
3. **Edit `lecture-05/questions.json`** — write your questions, and give each a **`"slide": N`** = the 1-based PDF page it should follow. E.g. a question with `"slide": 6` appears right after page 6, then its result, then the deck continues at page 7. Format: [`CONVENTIONS.md`](CONVENTIONS.md).

### In class

4. **Start presik:**
   ```bash
   cd ~/courses/web-dev
   presik lecture-05 --group "3-A"      # or omit --group and type the name when asked
   ```
5. **Read the printed addresses.** Note the random **Key** in the `?key=…`.
6. **On the projector**, open the **`Slides:` URL** (`http://…/slides?key=…`) and press **`f`** for fullscreen. *(For a Zoom class, just screen-share this browser window instead of a projector — same thing; remote students answer via a `--tunnel` URL.)*
7. **On your phone**, open the **`Teacher:` URL** (`/host?key=…`) — to watch the live distribution and your private `hint`.
8. **Students** scan the join QR (shown in the corner of every slide, and full-screen on the quiz slides).
9. **Present with the arrow keys.** Your PDF pages show as slides; when you arrow onto a **question step** it goes live and phones light up; the next arrow **reveals** the result; the arrow after that continues your deck. One key drives slides *and* quiz.
10. **When class ends,** press **`Ctrl+C`**. Answers are saved; analyse later with `presik report`.

> **Fewer taps:** the **Auto-reveal** checkbox on `/host` reveals a question once everyone connected has answered — so you just arrow onto the question and it reveals itself when the room is in.

---

## Scenario B — a Marp deck, step by step

Here the quiz lives *inside* your Markdown slides, and **paging through them is the remote control** — no separate button to tap. Best if you already write slides in Markdown.

### Set up once (before the class)

1. **Scaffold a session with a deck:**
   ```bash
   cd ~/courses/web-dev
   presik new s01 --title "S1 — The request's journey"
   ```
   This makes `s01/questions.json` **and** `s01/deck.marp.md` (already wired to the example questions).
2. **Edit `s01/deck.marp.md`** — write your slides normally, in Markdown. **You don't place any quiz markers** — just slides.
3. **Edit `s01/questions.json`** — write your questions, and give each a **`"slide": N`** (the 1-based slide it should follow). presik inserts the question and its result right after slide N when it builds the deck. Same mechanism as a PDF deck — placement always lives in `questions.json`.

### In class

4. **Start presik:**
   ```bash
   cd ~/courses/web-dev
   presik s01 --group "3-A"
   ```
5. **Read the printed addresses.** (Because there's a deck, you now get a `Slides:` line.)
6. **On the projector computer**, open the **`Slides:` URL — with the `?key=…`** (`http://…/slides?key=…`) and put the browser in full-screen. Opening it *with* the key is what lets the arrow keys control the quiz.
7. **(Optional) On your phone**, open the **`Teacher:` URL** (`/host?key=…`) to watch the distribution and your private `hint` as you go. You don't need it to run the quiz — the slides do that — but the `hint` only shows here.
8. **Students** scan the join-QR slide (or the `Students:` URL).
9. **Present with the arrow keys**, as any slideshow. When you **arrow onto a question slide**, that question goes live and phones light up. When you **arrow onto its reveal slide**, the room sees the result. **Arrow back** hides it again. The slides and the quiz never drift — they're the same state underneath.
10. **When class ends,** press **`Ctrl+C`**. Answers are saved.

> You don't have to wait for everyone before revealing — one answer is enough to move on, and the reveal slide notes "Still answering: X of Y connected" if some haven't.

---

## How the screens stay in sync

There's one source of truth: the **server's current state** (which question is live, whether it's revealed). Every screen subscribes to it over a live stream (`/api/stream`) and updates instantly.

- **`/slides`** (Marp or PDF) walks a single sequence of steps — *slide, slide, [question], [reveal], slide…* — and as you arrow onto a question/reveal step it asks the server to make that question live / reveal it. (For Marp it reads the slide from the page's URL fragment; for a PDF it tracks the step directly — either way presik owns navigation.)
- **`/host` buttons** (and keys) ask the server to do the same things.
- Both go through the same control channel (`/api/control`, key-protected), so **they can be used together and never drift** — drive from the slides, or from `/host`, or both.

Only the teacher key can control. Opening `/slides` **without** `?key=` (say, a curious student) shows the room's view and controls nothing.

### Who sees what

| | before you reveal | after you reveal |
|---|---|---|
| **Students `/`** and **the room `/slides`** (no key) | the question only — **no** distribution, **no** correct answer | distribution + correct answer + `explain` |
| **You, `/host`** | question **+ live distribution** + your `hint` | same, plus correct answer marked |

This asymmetry is the whole point: the room can't vote with the majority, and you get the real signal in time to act on it.

**One phone, one vote** — an anonymous id in the phone's `localStorage`; students can change their answer until you reveal. It's browser-generated, so it isn't a hard identity: the server caps how many distinct ids and how fast answers can come from one device, which keeps casual double-voting out of the distribution — but it isn't tamper-proof, and isn't meant to be. This is formative feedback, not an exam.

**"Connected" counts only real students** (`/`). The projector (`/slides` or `/present`) and your `/host` don't inflate it. Dead connections (a phone off Wi-Fi, a backgrounded tab) drop within ~25s, so the count doesn't accumulate ghosts.

---

## If the network won't cooperate

University Wi-Fi often isolates clients, so phones can't reach your laptop. Options:

- **Share a hotspot from your phone** and connect your laptop to it. Simplest, always works.
- **`presik s01 --tunnel`** — brings up a public `https://…trycloudflare.com` URL via [cloudflared](https://developers.cloudflare.com/cloudflare-tunnel/) and points the QR at it. Needs `cloudflared` installed; if it's missing, presik just stays on the local network.

---

## Results and analytics

- **During class:** the distribution on your `/host` screen.
- **`GET /api/export?key=…`** — JSON of all answers in the current run.
- **On `Ctrl+C`:** answers are also written to `.presik/results/<session>-<group>-<date>.json` — a one-off snapshot of a single class.
- **Every answer is written immediately** to a shared SQLite database, `.presik/data.db` — one file for the whole content root (all courses/sessions/groups).
- Because answers **and the current position** are saved as they happen, **a crash or a laptop sleep isn't fatal**: restart `presik` on the same session and it **resumes** the run — same answers, same current question. (A clean `Ctrl+C` ends the run, so the *next* start is fresh.)

Compare groups, sessions, or courses with `presik-report` (reads the same database, no server needed):

```bash
presik-report                                      # list all runs
presik-report --session s01                        # per question: % correct, broken down by group
presik-report --session web-dev/s01 --group "3-A"  # one group
presik-report --course web-dev                     # all sessions of one course
presik-report --csv > answers.csv                  # everything as CSV — for pandas/Excel/…
```

(From the packaged binary, the same thing is `presik report …`.) `.presik/` is git-ignored — no data leaks into a content repo, and there's none to leak anyway: answers are anonymous.

---

## Making your own class

```bash
presik new s02                                 # scaffolds s02/questions.json + s02/deck.marp.md
presik new web-dev/s02 --title "S02 — Status codes"
presik new s02 --questions-only                # just the quiz, no Marp deck (for PowerPoint/Keynote)
```

It generates both files from templates — the example questions already carry `slide` numbers that match the template deck, ready to run as-is or edit. It won't overwrite an existing `questions.json`/`deck.marp.md`, so it's always safe to run.

The full `questions.json` schema (question types `choice` / `text` / `scale`), naming rules, and every flag — [`CONVENTIONS.md`](CONVENTIONS.md).

### The `hint` field — the thing that makes this worth it

`hint` is visible **only to you**, on `/host`, under the distribution:

> *If a noticeable share picked 5xx on a question about 404 — that's the classic "404 = the server broke" confusion. Slow down here.*

It's not about grading anyone. It's about seeing, in ten seconds, **whether it's safe to move on** — and knowing what to do if it isn't.
