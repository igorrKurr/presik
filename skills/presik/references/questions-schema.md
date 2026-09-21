# `questions.json` schema

The source of truth is `CONVENTIONS.md` in the presik repo; this is the condensed version for writing files.

## Top level

```json
{
  "title": "S03 — HTTP status codes",
  "questions": [ … ]
}
```

- `title` — shown in the banner and the session list.
- Unknown top-level keys (e.g. `"_readme"`) are preserved and ignored.

## Question fields

| Field | Types | Required | Meaning |
|---|---|---|---|
| `id` | all | no (recommended) | Stable identifier; answers are stored per id. Defaults to `<session>-q<N>` by position — set it explicitly so reordering is safe. Must be unique. |
| `type` | all | yes | `choice` · `text` · `scale` · `widget` |
| `text` | all | yes | The question. |
| `note` | all | no | Smaller clarification under the question. |
| `options` | `choice`, `widget` (choice) | yes for those | `[{ "id": "a", "text": "…", "correct": true }]`. Non-empty. Option ids unique within the question. More than one may be correct. |
| `min`, `max` | `scale`, `widget` (scale) | yes for those | Integers, `min < max` (typically 1–5). |
| `slide` | all | no | 1-based slide/page the question appears **after** in the deck (Marp or PDF/PPTX/Keynote). Omit to run it only from `/host`. If N exceeds the slide count, it's appended at the end. |
| `explain` | all | no | Shown to students and on the projector **after reveal**. |
| `hint` | all | no (strongly recommended) | Shown **only to the teacher** on `/host`: how to act on the result. |
| `answer` | `widget` | no (default `choice`) | Which primitive the widget's answer is graded as: `choice` · `scale` · `text`. |
| `widget` | `widget` | yes for widgets | Front-end descriptor — see below. |

Validation runs at startup (and on every save in `presik edit`). It rejects: invalid JSON, an unknown `type`, duplicate question or option ids, a `choice` without options, non-integer `min`/`max`, `min >= max`, a scale wider than 100 steps, a `slide` that isn't a positive integer, a widget with zero or several sources, `isolate` on a `srcdoc` widget, and a `package` widget that isn't vendored. Missing question/option text only warns.

## Examples

```json
{
  "title": "S03 — HTTP status codes",
  "questions": [
    {
      "id": "cold-open",
      "type": "text",
      "text": "What happens when you type a URL and press Enter?",
      "note": "No wrong answers yet — one sentence is fine.",
      "slide": 1,
      "hint": "Don't comment now. Read a few aloud at the end and compare.",
      "explain": "We'll trace the whole journey today."
    },
    {
      "id": "status-404",
      "type": "choice",
      "text": "A page returns 404. Whose problem is it most likely?",
      "slide": 6,
      "options": [
        { "id": "server", "text": "The server crashed" },
        { "id": "client", "text": "The client asked for something that doesn't exist", "correct": true },
        { "id": "network", "text": "The network dropped the request" }
      ],
      "explain": "4xx = the request was wrong; 5xx = the server failed handling a valid one.",
      "hint": "Many picked 'server'? That's the '404 = broken server' misconception — redo the 4xx/5xx slide."
    },
    {
      "id": "confidence-headers",
      "type": "scale",
      "text": "How confident are you reading response headers?",
      "min": 1,
      "max": 5,
      "slide": 9,
      "hint": "Average below 3 — do the live DevTools demo before moving on."
    },
    {
      "id": "exit-ticket",
      "type": "text",
      "text": "What's still unclear after today?",
      "hint": "Read before next class; open with the most common theme."
    }
  ]
}
```

## Widget questions

A widget is a custom front-end that runs **only on the student's phone** in a sandboxed iframe and reports one answer, validated as its `answer` kind. Exactly **one** source key in `widget`:

| Key | Value | Use for |
|---|---|---|
| `srcdoc` | inline HTML string | a tiny self-contained form |
| `src` | relative path inside the session folder, e.g. `"widgets/dungeon/index.html"` | a vendored build, works offline |
| `package` | `"name@version"`, `"name@3"` or `"name"` — installed via `presik widget add <dist>` | a real, separately-built game (recommended) |
| `url` | `https://…` | a self-hosted deployment (needs network in class) |
| `dev` | `http://localhost:5173` | authoring with hot reload only |

Other `widget` keys: `height` (px, 80–2000), `config` (any JSON object handed to the front-end), `isolate` (true only for engines needing SharedArrayBuffer; never with `srcdoc`).

```json
{
  "id": "maze",
  "type": "widget",
  "text": "Escape the maze — the gate you leave by is your answer.",
  "answer": "choice",
  "options": [
    { "id": "north", "text": "North gate" },
    { "id": "east", "text": "East gate", "correct": true }
  ],
  "widget": { "package": "dungeon-escape@3", "height": 480, "config": { "seed": 42 } },
  "explain": "Only the east gate had no dead end."
}
```

Inside the widget, use the SDK instead of raw `postMessage`:

```html
<script src="/widget-sdk.js"></script>
<script>
  const quiz = await PresikWidget.connect();  // quiz.options, quiz.config, quiz.min/max
  quiz.answer('east');                         // report one legal answer
  quiz.on('reveal', (q) => showCorrect(q.correct));
</script>
```

External projects install it with `npm i presik-widget`. A package's `dist/` must contain a `widget.json`:

```json
{ "presikWidget": "1", "name": "dungeon-escape", "version": "3.2.0", "entry": "index.html",
  "answer": "choice", "options": [{ "id": "north" }, { "id": "east" }], "height": 480 }
```

Build it with relative asset paths (Vite: `base: './'`).

## Marp deck notes

- Slides are separated by `---`; the leading front-matter block (`marp: true`, theme…) is not a slide.
- Don't write question/result slides — presik generates them from `slide` numbers.
- The one marker you may add by hand is a large join-QR slide: `<div data-quiz-join></div>` on its own slide (usually slide 1 or 2). It counts as a slide for `slide` numbering.
