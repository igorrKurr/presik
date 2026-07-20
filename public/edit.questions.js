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
  ];
  // Canonical key order, so a question the editor writes reads like one a person
  // wrote — questions.json stays a file you diff and hand-edit (CONVENTIONS.md).
  const ORDER = ['id', 'type', 'text', 'note', 'options', 'min', 'max', 'slide', 'explain', 'hint'];

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
  const set = (i, k, v) => {
    store.doc.questions[i][k] = v;
    commit(false); // a keystroke must not re-render: it would eat the cursor
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
    if (q.type === 'choice') bits.push((q.options || []).length + ' options');
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
              commit(false);
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
    else b.append(el('div', { class: 'text-prev', text: 'Students type an answer on their phone.' }));

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
