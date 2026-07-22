# @igorrkurr/presik-widget

Client SDK for building **presik** quiz widgets — interactive question front-ends
(a richer form, a branching adventure, a small game) that run in a sandboxed
iframe on the student's phone and report **one answer** to the quiz over
`postMessage`. See the widget contract in the main repo's `CONVENTIONS.md`.

You don't need this package for a tiny inline widget — presik serves the same
file at `/widget-sdk.js`, so a `srcdoc`/bundle widget can just
`<script src="/widget-sdk.js"></script>`. Install it when your game is its own
project with a build and tests.

## Install

The package is published to **GitHub Packages**, so point the `@igorrkurr` scope
at that registry (`.npmrc`):

```
@igorrkurr:registry=https://npm.pkg.github.com
```

```bash
npm install @igorrkurr/presik-widget
```

## Use (the game side)

```js
import PresikWidget from '@igorrkurr/presik-widget';

const quiz = await PresikWidget.connect();   // does the ready/init handshake
quiz.config;        // author config from questions.json (e.g. { seed: 42 })
quiz.options;       // [{ id, text? }, …] — the outcomes (for the 'choice' kind)
quiz.answerKind;    // 'choice' | 'scale' | 'text'

quiz.answer('east');                          // report the student's answer
quiz.on('reveal', (q) => paintWinner(q.correct));  // teacher revealed the result
```

The reported value goes through the **same server-side gate** as a tapped
button, so it must be a legal answer for the declared kind.

## Test your integration (the host side)

`mockHost` is a fake quiz host, so your game's own CI can assert what it reports
with a plain iframe and no presik server:

```js
import PresikWidget from '@igorrkurr/presik-widget';

const host = PresikWidget.mockHost(iframe, { answer: 'choice', options: [{ id: 'east' }] });
// … drive the game so the player exits east …
assert.deepEqual(host.answers, ['east']);
host.state({ revealed: true, correct: ['east'] }); // push a reveal to the widget
```

## Ship the game to a quiz

Build to a self-contained `dist/` with relative asset paths (Vite `base: './'`),
add a `widget.json` manifest, and vendor it:

```bash
presik widget add ./dist    # → questions.json references it as { "package": "<name>" }
```

Zero dependencies. UMD: `import`, `require`, or a global `PresikWidget` via
`<script>`.
