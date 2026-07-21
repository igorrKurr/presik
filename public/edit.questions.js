// The questions editor: one card per question, edited in place. The card is the
// preview — an option row shows the circle the student will tap, a scale shows
// the buttons, correct answers go green (the same green /host paints the winning
// bar). There's no separate "preview" mode because the thing you're looking at
// is already the thing.
//
// Registered as a module on the shell (edit.js), which owns the document, the
// autosave and the undo stack.
(function () {
  const { el } = window.PresikEditor;
  const TYPES = [
    { id: 'choice', label: 'Choice', blurb: 'Tap ✓ to mark the correct answer — more than one can be correct.' },
    { id: 'text', label: 'Text', blurb: 'A free-form answer: cold opens, exit tickets.' },
    { id: 'scale', label: 'Scale', blurb: 'A range, e.g. confidence 1–5. The result shows the average.' },
    { id: 'widget', label: 'Widget', blurb: 'An interactive front-end (a form, a game…) that reports one answer. Author its data here; build the front-end as raw HTML in the box below.' },
  ];
  const ANSWER_KINDS = [['choice', 'Choice'], ['scale', 'Scale'], ['text', 'Text']];
  const WIDGET_SOURCES = ['srcdoc', 'src', 'url', 'dev']; // mirrors lib.js — one of these per widget
  // Canonical key order, so a question the editor writes reads like one a person
  // wrote — questions.json stays a file you diff and hand-edit (CONVENTIONS.md).
  const ORDER = ['id', 'type', 'answer', 'text', 'note', 'options', 'min', 'max', 'widget', 'slide', 'explain', 'hint'];

  // A working default widget: it renders the choice options as buttons, reports
  // the tapped one, and greens the correct one after reveal. It doubles as the
  // reference for the postMessage contract — copy it, then make it a real game.
  const STARTER_SRCDOC = [
    '<!doctype html><meta charset="utf-8">',
    '<style>body{margin:0;font:16px system-ui;background:#1b2634;color:#f1f5f9;padding:16px}',
    'button{display:block;width:100%;margin:0 0 8px;padding:14px;border-radius:10px;border:1px solid #223041;background:#10161f;color:inherit;font:inherit;text-align:left;cursor:pointer}',
    'button.correct{border-color:#4ade80}</style>',
    '<div id="root">Loading…</div>',
    '<script>',
    'var Q=null;',
    'onmessage=function(e){var d=e.data||{};',
    ' if(d.presik==="init"){Q=d;draw();}',
    ' if(d.presik==="state"&&Q){Q.revealed=d.revealed;Q.correct=d.correct;draw();}};',
    'function draw(){var r=document.getElementById("root");r.innerHTML="";',
    ' (Q.options||[]).forEach(function(o){var b=document.createElement("button");b.textContent=o.text||o.id;',
    '  if(Q.revealed&&Q.correct&&Q.correct.indexOf(o.id)>=0)b.className="correct";',
    '  b.onclick=function(){parent.postMessage({presik:"answer",value:o.id},"*");};r.appendChild(b);});}',
    'parent.postMessage({presik:"ready"},"*");',
    '</scr' + 'ipt>',
  ].join('\n');

  let ctx, store, list, openIdx = 0, dragFrom = null, wantFocus = false;

  // Drop empty optionals rather than writing "note": "" into the file, and put
  // the keys back in canonical order after an edit appended a new one.
  function canon(q) {
    const out = {};
    for (const k of ORDER) if (q[k] !== undefined && q[k] !== null && q[k] !== '') out[k] = q[k];
    for (const k of Object.keys(q)) if (!ORDER.includes(k) && q[k] != null) out[k] = q[k]; // keys we don't know about survive
    return out;
  }
  function commit(redraw) {
    store.doc.questions = store.doc.questions.map(canon);
    store.touch(redraw);
  }
  // A keystroke changes one question — canon just that one rather than rebuilding
  // every question object on the array, so typing stays cheap in a long quiz.
  // Structural edits (add/delete/reorder/type) use commit() and re-canon all.
  function commitAt(i, redraw) {
    store.doc.questions[i] = canon(store.doc.questions[i]);
    store.touch(redraw);
  }
  const set = (i, k, v) => {
    store.doc.questions[i][k] = v;
    commitAt(i, false); // a keystroke must not re-render: it would eat the cursor
  };

  // An id is identity — answers are stored under it, live and in the archive. A
  // new question gets one right now, in the same shape the server would have
  // generated (<session>-qN), instead of inheriting one from its position later
  // and having reordering silently change it.
  function newId() {
    const base = String(ctx.state.session || 'session').replace(/\//g, '-');
    const taken = new Set(store.doc.questions.map((q) => q.id));
    for (let n = store.doc.questions.length + 1; ; n++) if (!taken.has(base + '-q' + n)) return base + '-q' + n;
  }
  function newOptId(q) {
    const taken = new Set((q.options || []).map((o) => o.id));
    for (let i = 0; ; i++) {
      const id = i < 26 ? String.fromCharCode(97 + i) : 'o' + (i + 1);
      if (!taken.has(id)) return id;
    }
  }

  const short = (s) => {
    const t = String(s || '').trim();
    return t.length > 40 ? t.slice(0, 40) + '…' : t || 'untitled question';
  };
  const grow = (t) => {
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 'px';
  };

  // ---------------------------------------------------------------- edits
  function add() {
    ctx.pushUndo('add question', store);
    store.doc.questions.push({ id: newId(), type: 'choice', text: '', options: [{ id: 'a', text: '' }, { id: 'b', text: '' }] });
    openIdx = store.doc.questions.length - 1;
    wantFocus = true;
    commit(true);
  }
  function dup(i) {
    ctx.pushUndo('duplicate question', store);
    const copy = JSON.parse(JSON.stringify(store.doc.questions[i]));
    copy.id = newId(); // a copy is a new question, so it needs its own identity
    store.doc.questions.splice(i + 1, 0, copy);
    openIdx = i + 1;
    commit(true);
  }
  function del(i) {
    ctx.pushUndo('delete question', store);
    const [gone] = store.doc.questions.splice(i, 1);
    if (openIdx >= store.doc.questions.length) openIdx = store.doc.questions.length - 1;
    commit(true);
    ctx.toast('Deleted “' + short(gone.text) + '”', { label: 'Undo', fn: ctx.undo });
  }
  function move(i, d) {
    const to = i + d;
    if (to < 0 || to >= store.doc.questions.length) return;
    ctx.pushUndo('reorder', store);
    const qs = store.doc.questions;
    [qs[i], qs[to]] = [qs[to], qs[i]];
    openIdx = to;
    wantFocus = true;
    commit(true);
  }
  function setType(i, type) {
    const q = store.doc.questions[i];
    if (q.type === type) return;
    ctx.pushUndo('question type', store);
    q.type = type;
    // Options are kept when you switch away from choice, so switching back
    // doesn't cost you the answers you already typed.
    if (type === 'choice' && !(q.options || []).length) q.options = [{ id: 'a', text: '' }, { id: 'b', text: '' }];
    if (type === 'scale') {
      if (q.min == null) q.min = 1;
      if (q.max == null) q.max = 5;
    }
    if (type === 'widget') {
      if (q.answer == null) q.answer = 'choice';
      seedAnswerKind(q, q.answer);
      if (q.widget == null) q.widget = { srcdoc: STARTER_SRCDOC };
    }
    commit(true);
  }
  // The fields the borrowed answer kind needs to be valid — shared by switching
  // to a widget and by switching a widget's answer kind.
  function seedAnswerKind(q, kind) {
    if (kind === 'choice' && !(q.options || []).length) q.options = [{ id: 'a', text: '' }, { id: 'b', text: '' }];
    if (kind === 'scale') { if (q.min == null) q.min = 1; if (q.max == null) q.max = 5; }
  }
  function setAnswerKind(i, kind) {
    const q = store.doc.questions[i];
    if ((q.answer || 'choice') === kind) return;
    ctx.pushUndo('widget answer kind', store);
    q.answer = kind;
    seedAnswerKind(q, kind);
    commit(true);
  }
  // A keystroke inside the srcdoc/src field: mutate in place, no re-render (it
  // would eat the cursor), same as editing question text.
  function widgetField(i, k, v) {
    const q = store.doc.questions[i];
    q.widget = q.widget || {};
    q.widget[k] = v;
    commitAt(i, false);
  }
  function widgetMode(w) { return WIDGET_SOURCES.find((k) => w && w[k] != null) || 'srcdoc'; }
  function setWidgetMode(i, mode) {
    const q = store.doc.questions[i];
    const w = (q.widget = q.widget || {});
    if (widgetMode(w) === mode) return;
    ctx.pushUndo('widget source', store);
    WIDGET_SOURCES.forEach((k) => { if (k !== mode) delete w[k]; }); // one source at a time
    if (w[mode] == null) w[mode] = mode === 'srcdoc' ? STARTER_SRCDOC : '';
    commit(true);
  }
  function setWidgetHeight(i, raw) {
    const q = store.doc.questions[i];
    const w = (q.widget = q.widget || {});
    ctx.pushUndo('widget height', store);
    if (!String(raw).trim()) delete w.height;
    else {
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 80 || n > 2000) { ctx.toast('Height must be between 80 and 2000 px.'); return render(store.doc); }
      w.height = n;
    }
    commit(true);
  }
  function setWidgetConfig(i, raw) {
    const q = store.doc.questions[i];
    const w = (q.widget = q.widget || {});
    const t = String(raw).trim();
    let val;
    if (t) {
      try { val = JSON.parse(t); } catch (_) { ctx.toast('Config has to be valid JSON.'); return render(store.doc); }
      if (val == null || typeof val !== 'object' || Array.isArray(val)) { ctx.toast('Config must be a JSON object, e.g. { "level": 2 }.'); return render(store.doc); }
    }
    ctx.pushUndo('widget config', store);
    if (val === undefined) delete w.config; else w.config = val;
    commit(true);
  }
  function setScale(i, k, raw) {
    const q = store.doc.questions[i];
    const n = parseInt(raw, 10);
    const next = Object.assign({}, q, { [k]: n });
    // Caught here rather than at save time: the server would reject min >= max,
    // and a save that fails while you type is a worse way to learn that.
    if (!Number.isInteger(n) || next.min >= next.max) {
      ctx.toast('“From” has to be below “to”.');
      return render(store.doc);
    }
    // Mirror the server's SCALE_MAX_STEPS cap: a scale is a row of buttons, not
    // a number-entry box, so reject a runaway range before it reaches the file.
    if (next.max - next.min > 100) {
      ctx.toast('That range is too wide — a scale is a handful of buttons (max 100 steps).');
      return render(store.doc);
    }
    ctx.pushUndo('scale range', store);
    q[k] = n;
    commit(true);
  }
  function setSlide(i, raw) {
    const q = store.doc.questions[i];
    const n = parseInt(raw, 10);
    ctx.pushUndo('slide placement', store);
    if (!String(raw).trim() || !Number.isInteger(n) || n < 1) delete q.slide;
    else {
      q.slide = n;
      const total = ctx.state.deck && ctx.state.deck.slides;
      if (total && n > total) ctx.toast('The deck has ' + total + ' slides — this one will appear at the end.');
    }
    commit(true);
  }
  function addOption(i) {
    ctx.pushUndo('add option', store);
    const q = store.doc.questions[i];
    q.options = q.options || [];
    q.options.push({ id: newOptId(q), text: '' });
    commit(true);
  }
  function delOption(i, j) {
    ctx.pushUndo('remove option', store);
    store.doc.questions[i].options.splice(j, 1);
    commit(true);
  }
  function toggleCorrect(i, j) {
    ctx.pushUndo('correct answer', store);
    const o = store.doc.questions[i].options[j];
    if (o.correct) delete o.correct;
    else o.correct = true;
    commit(true);
  }

  // ---------------------------------------------------------------- render
  function summaryOf(q) {
    const bits = [];
    if (q.type === 'widget') bits.push('widget · answers as ' + (q.answer || 'choice'));
    else if (q.type === 'choice') bits.push((q.options || []).length + ' options');
    else if (q.type === 'scale') bits.push('scale ' + q.min + '–' + q.max);
    else bits.push('free text');
    bits.push(q.slide ? 'after slide ' + q.slide : 'not in the deck');
    return bits.join(' · ');
  }

  function head(q, i, open) {
    const kids = [
      el('span', { class: 'grip', text: '⠿', title: 'Drag to reorder (or Alt+↑/↓)' }),
      el('span', { class: 'qnum', text: String(i + 1) }),
    ];
    if (open) {
      kids.push(el('div', { class: 'sum' }));
    } else {
      const t = String(q.text || '').trim();
      kids.push(
        el(
          'div',
          { class: 'sum' },
          t ? el('span', { text: t }) : el('span', { class: 'untitled', text: 'Untitled question' }),
          el('div', { class: 'sub', text: summaryOf(q) })
        )
      );
      if (!t) kids.push(el('span', { class: 'warn-dot', text: '●', title: 'No question text yet' }));
    }
    kids.push(el('span', { class: 'badge', text: q.type }));
    return el(
      'header',
      {
        class: 'card-head',
        onClick: (e) => {
          if (e.target.closest('.grip')) return;
          openIdx = open ? -1 : i;
          render(store.doc);
        },
      },
      kids
    );
  }

  function options(q, i) {
    const wrap = el('div', { class: 'opts' });
    (q.options || []).forEach((o, j) => {
      wrap.append(
        el(
          'div',
          { class: 'opt' + (o.correct ? ' ok' : '') },
          el('span', { class: 'dot' }),
          el('input', {
            class: 'field',
            value: o.text || '',
            placeholder: 'Option ' + (j + 1),
            onInput: (e) => {
              store.doc.questions[i].options[j].text = e.target.value;
              commitAt(i, false);
            },
          }),
          el('button', { class: 'iconbtn' + (o.correct ? ' ok' : ''), text: '✓', title: 'Mark as correct', onClick: () => toggleCorrect(i, j) }),
          el('button', {
            class: 'iconbtn danger',
            text: '✕',
            title: 'Remove option',
            disabled: (q.options || []).length < 2, // a choice question needs at least one option to be answerable
            onClick: () => delOption(i, j),
          })
        )
      );
    });
    wrap.append(el('button', { class: 'addopt', text: '+ Add option', onClick: () => addOption(i) }));
    return wrap;
  }

  function scale(q, i) {
    const num = (k) => el('input', { class: 'num', type: 'number', value: String(q[k]), onChange: (e) => setScale(i, k, e.target.value) });
    const prev = el('div', { class: 'scale-prev' });
    for (let v = q.min; v <= q.max && v - q.min < 40; v++) prev.append(el('span', { text: String(v) }));
    return el(
      'div',
      {},
      el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'From' }), num('min'), el('span', { class: 'lbl', text: 'to' }), num('max')),
      prev
    );
  }

  // The widget's data contract: which primitive kind its answer is stored and
  // graded as. Choosing "choice" reuses the very same option rows (with the ✓
  // correct toggle) a plain choice question has — so a game's outcomes are
  // authored exactly like ordinary answers.
  function answerKindPicker(q, i) {
    return el(
      'div',
      { class: 'row' },
      el('span', { class: 'lbl', text: 'Answer stored as' }),
      el('div', { class: 'seg' }, ANSWER_KINDS.map(([id, label]) =>
        el('button', { class: (q.answer || 'choice') === id ? 'on' : '', text: label, onClick: () => setAnswerKind(i, id) })))
    );
  }
  const WIDGET_MODES = [
    ['srcdoc', 'Inline HTML', '<!doctype html> … your interactive question'],
    ['src', 'Bundle file', 'widgets/game/index.html'],
    ['url', 'URL', 'https://games.example.edu/dungeon/v3/'],
    ['dev', 'Dev server', 'http://localhost:5173'],
  ];
  const WIDGET_MODE_HINT = {
    srcdoc: 'Inline HTML — fine for a small form; a big game belongs in a bundle, URL, or dev server.',
    src: 'A built bundle in the session folder — copy your game’s dist/ here (works fully offline).',
    url: 'A self-hosted deployment — the game builds and deploys on its own; needs the network in class.',
    dev: 'Your game’s dev server — hot-reload while authoring, then switch to a bundle or URL for class.',
  };
  function widgetEditor(q, i) {
    const w = q.widget || {};
    const mode = widgetMode(w);
    const seg = el('div', { class: 'seg' }, WIDGET_MODES.map(([id, label]) =>
      el('button', { class: id === mode ? 'on' : '', text: label, onClick: () => setWidgetMode(i, id) })));
    const height = el('input', { class: 'num', type: 'number', placeholder: '420', value: w.height != null ? String(w.height) : '', onChange: (e) => setWidgetHeight(i, e.target.value) });
    const ph = (WIDGET_MODES.find(([id]) => id === mode) || [])[2] || '';
    const source = mode === 'srcdoc'
      ? el('textarea', { class: 'field mono', rows: 8, placeholder: ph, text: w.srcdoc || '', onInput: (e) => { widgetField(i, 'srcdoc', e.target.value); grow(e.target); } })
      : el('input', { class: 'field mono', value: w[mode] || '', placeholder: ph, onInput: (e) => widgetField(i, mode, e.target.value) });
    return el(
      'div',
      { class: 'extras' },
      el('label', { class: 'extra-lbl', text: 'Widget front-end — talks to the quiz over postMessage (see /widget-sdk.js)' }),
      el('div', { class: 'row' }, seg, el('span', { class: 'lbl', text: 'height' }), height),
      source,
      el('div', { class: 'hintline', text: WIDGET_MODE_HINT[mode] }),
      el('label', { class: 'extra-lbl', text: 'Config (optional) — JSON handed to the widget at start' }),
      el('textarea', { class: 'field mono', rows: 2, placeholder: '{ }', text: w.config ? JSON.stringify(w.config) : '', onChange: (e) => setWidgetConfig(i, e.target.value) }),
      el('div', { class: 'hintline', text: 'It reports one value; it’s validated as the answer kind above, then revealed and archived like any answer of that kind.' })
    );
  }

  function area(q, i, key, placeholder, cls) {
    return el('textarea', {
      class: 'field ' + (cls || ''),
      rows: 1,
      placeholder,
      text: q[key] || '',
      onInput: (e) => {
        set(i, key, e.target.value);
        grow(e.target);
      },
    });
  }

  function foot(q, i) {
    const deck = ctx.state.deck || {};
    let pick;
    if (!deck.type) {
      pick = el('div', { class: 'slidepick' }, el('span', { class: 'lbl', text: 'No deck here — questions run from /host' }));
    } else {
      pick = el(
        'div',
        { class: 'slidepick' },
        el('span', { class: 'lbl', text: 'Shows after slide' }),
        el('input', {
          class: 'num',
          type: 'number',
          min: '1',
          placeholder: '—',
          value: q.slide != null ? String(q.slide) : '',
          onChange: (e) => setSlide(i, e.target.value),
        }),
        deck.slides ? el('span', { class: 'lbl', text: 'of ' + deck.slides }) : null,
        q.slide == null ? el('span', { class: 'lbl', text: '· not in the deck' }) : null
      );
    }
    return el(
      'div',
      { class: 'card-foot' },
      pick,
      el('div', { class: 'spacer' }),
      el('button', { class: 'iconbtn', text: 'Duplicate', onClick: () => dup(i) }),
      el('button', { class: 'iconbtn danger', text: 'Delete', onClick: () => del(i) })
    );
  }

  function body(q, i) {
    const type = TYPES.find((t) => t.id === q.type) || TYPES[0];
    const b = el(
      'div',
      { class: 'card-body' },
      area(q, i, 'text', 'Question', 'q-text'),
      area(q, i, 'note', 'Description (optional) — shown under the question', 'q-note'),
      el(
        'div',
        { class: 'row' },
        el('div', { class: 'seg' }, TYPES.map((t) => el('button', { class: t.id === q.type ? 'on' : '', text: t.label, onClick: () => setType(i, t.id) })))
      ),
      el('div', { class: 'hintline', text: type.blurb })
    );
    if (q.type === 'choice') b.append(options(q, i));
    else if (q.type === 'scale') b.append(scale(q, i));
    else if (q.type === 'widget') {
      const kind = q.answer || 'choice';
      b.append(answerKindPicker(q, i));
      if (kind === 'choice') b.append(options(q, i));
      else if (kind === 'scale') b.append(scale(q, i));
      else b.append(el('div', { class: 'text-prev', text: 'The widget collects a free-text answer.' }));
      b.append(widgetEditor(q, i));
    } else b.append(el('div', { class: 'text-prev', text: 'Students type an answer on their phone.' }));

    b.append(
      el(
        'div',
        { class: 'extras' },
        el('label', { class: 'extra-lbl', text: 'Explanation — shown after the reveal' }),
        area(q, i, 'explain', 'Why the answer is what it is'),
        el('label', { class: 'extra-lbl', text: 'Teacher note — only you see this, on /host' }),
        area(q, i, 'hint', 'What to do with this result', 'hint-field')
      )
    );
    b.append(foot(q, i));
    return b;
  }

  function card(q, i) {
    const open = i === openIdx;
    const c = el('article', { class: 'card' + (open ? ' open' : ''), 'data-i': String(i) }, head(q, i, open));
    if (open) c.append(body(q, i));

    // draggable is switched on only from the grip: a permanently draggable card
    // would make selecting text inside its fields start a drag instead.
    c.querySelector('.grip').addEventListener('pointerdown', () => c.setAttribute('draggable', 'true'));
    c.addEventListener('dragstart', (e) => {
      dragFrom = i;
      c.classList.add('drag');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    c.addEventListener('dragend', () => {
      c.classList.remove('drag');
      c.removeAttribute('draggable');
      if (dragFrom != null) {
        dragFrom = null;
        render(store.doc); // dropped outside the list — put the DOM back the way the model says
      }
    });
    c.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      move(i, e.key === 'ArrowUp' ? -1 : 1);
    });
    return c;
  }

  function render(doc) {
    list.textContent = '';
    if (!doc.questions.length) {
      list.append(el('div', { class: 'empty', text: 'No questions yet. Add the first one — students can answer it from their phones the moment you run the session.' }));
    }
    doc.questions.forEach((q, i) => list.append(card(q, i)));
    list.querySelectorAll('textarea.field').forEach(grow); // needs to be in the DOM to measure
    if (wantFocus) {
      wantFocus = false;
      const t = list.querySelector('.card.open .q-text');
      if (t) {
        t.focus();
        t.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  // Reorder by dragging: the card follows the pointer live, and the model is
  // read back from the DOM order on drop.
  function wireList() {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragged = list.querySelector('.card.drag');
      if (!dragged) return;
      const after = [...list.querySelectorAll('.card:not(.drag)')].find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      if (after) list.insertBefore(dragged, after);
      else list.append(dragged);
    });
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragFrom == null) return;
      const order = [...list.querySelectorAll('.card')].map((c) => Number(c.dataset.i));
      const from = dragFrom;
      dragFrom = null;
      if (order.every((v, k) => v === k)) return render(store.doc); // dropped where it started
      ctx.pushUndo('reorder', store);
      store.doc.questions = order.map((old) => store.doc.questions[old]);
      openIdx = order.indexOf(from);
      commit(true);
    });
  }

  window.PresikEditor.register({
    id: 'questions',
    label: 'Questions',
    mount(node, c) {
      ctx = c;
      store = c.store;
      list = el('div', { class: 'qlist' });
      wireList();
      node.append(list, el('button', { class: 'add', text: '+ Add question', onClick: add }));
      store.sub(render);
      render(store.doc);
    },
  });
})();
