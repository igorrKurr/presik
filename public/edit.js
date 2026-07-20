// The editor shell: the chrome (title, save status, history, tabs) and the
// write-behind to disk. It knows nothing about questions — that lives in
// edit.questions.js and registers itself as a module. A slide editor becomes a
// second module: same shell, same save pipeline, one more tab.
//
//   PresikEditor.register({ id, label, mount(node, ctx) })
//
// ctx gives a module: state (the /api/edit/state bootstrap), store (the session
// document + its autosave), createStore (for a document of its own), and the
// shared el/toast/pushUndo helpers.
(function () {
  const SAVE_DEBOUNCE_MS = 700;
  const KEY = new URL(location.href).searchParams.get('key');
  const $ = (sel) => document.querySelector(sel);

  // Build DOM rather than assemble HTML strings: question text, options and
  // teacher notes are author input, and going through textContent means there's
  // no escaping to forget.
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n[k.toLowerCase()] = v;
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }

  async function api(path, opts) {
    const sep = path.includes('?') ? '&' : '?';
    let res;
    try {
      res = await fetch('/api/edit/' + path + sep + 'key=' + encodeURIComponent(KEY), opts);
    } catch (e) {
      return { ok: false, status: 0, body: { errors: ['the server is not reachable — is presik still running?'] } };
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_) {}
    return { ok: res.ok, status: res.status, body: body || {} };
  }

  // ---------------------------------------------------------------- status
  function status(text, isErr) {
    const s = $('#save');
    s.textContent = text;
    s.classList.toggle('err', !!isErr);
  }

  let toastTimer = null;
  function toast(msg, action) {
    const t = $('#toast');
    t.textContent = '';
    t.append(el('span', { text: msg }));
    if (action) t.append(el('button', { text: action.label, onClick: () => { t.hidden = true; action.fn(); } }));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), action ? 8000 : 2600);
  }

  function banner(msg, actions) {
    const b = $('#banner');
    b.textContent = '';
    b.append(el('span', { text: msg }));
    (actions || []).forEach((a) => b.append(el('button', { class: 'ghost', text: a.label, onClick: a.fn })));
    b.hidden = false;
  }
  const hideBanner = () => ($('#banner').hidden = true);

  // ---------------------------------------------------------------- store
  // A document the editor owns: its current value, the disk revision it came
  // from, and a debounced write-behind. `rev` is the file's mtime — if the file
  // moves under us (you also have it open in vim), the save is refused rather
  // than silently winning, and you get to choose.
  function createStore(opts) {
    const s = { doc: opts.doc, rev: opts.rev, subs: [], timer: null, saving: false, queued: false, blocked: false };
    s.sub = (fn) => s.subs.push(fn);
    s.emit = () => s.subs.forEach((f) => f(s.doc));

    // Call after mutating s.doc. redraw=true for structural edits; a keystroke
    // passes false, because re-rendering the field you're typing in would eat
    // your cursor.
    s.touch = (redraw) => {
      if (redraw) s.emit();
      if (s.blocked) return;
      clearTimeout(s.timer);
      status('Saving…');
      s.timer = setTimeout(() => s.flush(), SAVE_DEBOUNCE_MS);
    };

    s.flush = async (force) => {
      clearTimeout(s.timer);
      if (s.saving) { s.queued = true; return; } // coalesce: finish this write, then send the latest
      s.saving = true;
      const r = await api(opts.endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: s.doc, rev: force ? null : s.rev }),
      });
      s.saving = false;

      if (r.status === 409) {
        s.blocked = true;
        status('Not saved', true);
        banner('questions.json changed on disk since you opened it.', [
          { label: 'Load the file', fn: () => location.reload() },
          { label: 'Keep my version', fn: () => { s.blocked = false; hideBanner(); s.flush(true); } },
        ]);
        return;
      }
      if (!r.ok) {
        status('Not saved', true);
        banner((r.body.errors || ['could not save']).join(' · '));
        return;
      }
      s.rev = r.body.rev;
      hideBanner();
      if (s.queued) { s.queued = false; return s.flush(); }
      status('All changes saved');
    };
    return s;
  }

  // ---------------------------------------------------------------- undo
  // Undo covers *structural* edits — add, delete, duplicate, reorder, type
  // change. Typing is left to the browser's own undo inside the field, which is
  // what your fingers already expect; snapshotting every keystroke would fight it.
  const undos = [];
  function pushUndo(label, store) {
    undos.push({ label, store, snap: JSON.stringify(store.doc) });
    if (undos.length > 60) undos.shift();
  }
  function undo() {
    const u = undos.pop();
    if (!u) return;
    u.store.doc = JSON.parse(u.snap);
    u.store.touch(true);
    toast('Undid: ' + u.label);
  }
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return; // native undo owns the field
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  });

  // ---------------------------------------------------------------- history
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's') + ' ago';
  function ago(iso) {
    const secs = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (secs < 90) return 'just now';
    const mins = secs / 60;
    if (mins < 60) return plural(Math.round(mins), 'minute');
    const hours = mins / 60;
    if (hours < 24) return plural(Math.round(hours), 'hour');
    return plural(Math.round(hours / 24), 'day');
  }

  async function openHistory(store) {
    $('#drawer').hidden = false;
    $('#scrim').hidden = false;
    const list = $('#historyList');
    list.textContent = 'Loading…';
    const r = await api('history');
    const entries = (r.body && r.body.entries) || [];
    list.textContent = '';
    if (!entries.length) {
      list.append(el('div', { class: 'hempty', text: 'No earlier versions yet. The first one is written the next time you change something — the file as it is right now is kept, so you can always come back to it.' }));
      return;
    }
    entries.forEach((e) => {
      const peek = el('div', { class: 'meta' });
      const item = el(
        'div',
        { class: 'hitem' },
        el('div', { class: 'when', text: ago(e.at) }),
        el('div', { class: 'meta', text: new Date(e.at).toLocaleString() }),
        peek,
        el(
          'div',
          { class: 'acts' },
          el('button', {
            class: 'ghost',
            text: 'Preview',
            onClick: async () => {
              const p = await api('history/entry?id=' + encodeURIComponent(e.id));
              if (!p.ok) return (peek.textContent = 'could not read this version');
              try {
                const d = JSON.parse(p.body.content);
                peek.textContent = '“' + (d.title || 'untitled') + '” · ' + (d.questions || []).length + ' questions';
              } catch (_) {
                peek.textContent = 'this version is not valid JSON';
              }
            },
          }),
          el('button', {
            class: 'ghost',
            text: 'Restore',
            onClick: async () => {
              if (!confirm('Restore this version?\n\nThe version you have now is kept in the history, so this is undoable.')) return;
              const r2 = await api('restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: e.id }) });
              if (!r2.ok) return toast('Could not restore: ' + ((r2.body.errors || [])[0] || 'unknown error'));
              store.doc = r2.body.doc;
              store.rev = r2.body.rev;
              store.emit();
              closeHistory();
              status('All changes saved');
              toast('Restored the version from ' + ago(e.at));
            },
          })
        )
      );
      list.append(item);
    });
  }
  function closeHistory() {
    $('#drawer').hidden = true;
    $('#scrim').hidden = true;
  }

  // ---------------------------------------------------------------- modules
  const modules = [];
  window.PresikEditor = {
    el,
    register(mod) {
      modules.push(mod);
    },
  };

  // ---------------------------------------------------------------- boot
  async function boot() {
    const pane = $('#pane');
    const r = await api('state');
    const st = r.body;
    if (r.status === 403) {
      pane.textContent = '';
      pane.append(el('div', { class: 'loading', text: 'This link needs the teacher key — open the Editor URL from the terminal banner.' }));
      return;
    }
    if (!st || !st.doc) {
      pane.textContent = '';
      pane.append(el('div', { class: 'loading', text: (st && (st.errors || [])[0]) || 'Could not read questions.json.' }));
      return;
    }
    if ((st.errors || []).length) banner('questions.json has a problem: ' + st.errors.join(' · '));

    // The session document. The shell owns it because the session's title lives
    // in it and the title is shell chrome; a module that edits a file of its own
    // (deck.marp.md, later) makes its own store with ctx.createStore.
    const store = createStore({ endpoint: 'questions', doc: st.doc, rev: st.rev });

    $('#crumb').textContent = st.course ? st.course + ' / ' + st.session.split('/').pop() : st.session;
    $('#hostLink').href = '/host?key=' + encodeURIComponent(KEY);
    if (st.deck && st.deck.type) {
      $('#deckLink').hidden = false;
      $('#deckLink').href = '/slides?key=' + encodeURIComponent(KEY);
    }

    const title = $('#title');
    title.value = store.doc.title || '';
    title.oninput = () => {
      store.doc.title = title.value.trim() ? title.value : null;
      store.touch(false);
    };
    store.sub((doc) => {
      if (document.activeElement !== title) title.value = doc.title || '';
    });

    $('#historyBtn').onclick = () => openHistory(store);
    $('#drawerClose').onclick = closeHistory;
    $('#scrim').onclick = closeHistory;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeHistory();
      // Cmd/Ctrl+S is muscle memory even when a file saves itself — honour it as
      // "save right now" rather than letting the browser offer to save the page.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); store.flush(); }
    });
    // A close with an unsent keystroke still in the debounce window would lose
    // it — flush on the way out.
    window.addEventListener('beforeunload', () => {
      if (store.timer) store.flush();
    });

    const ctx = { state: st, store, api, el, toast, banner, status, pushUndo, undo, createStore };

    const tabs = $('#tabs');
    function show(mod) {
      pane.textContent = '';
      [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.id === mod.id));
      mod.mount(pane, ctx);
    }
    if (modules.length > 1) {
      tabs.hidden = false;
      modules.forEach((m) => tabs.append(el('button', { 'data-id': m.id, text: m.label, onClick: () => show(m) })));
    }
    if (modules.length) show(modules[0]);
    // A fresh session has no questions.json yet — the file appears on the first
    // save, so don't claim it's already saved.
    status(st.isNew ? 'New session — add a question to create questions.json' : 'All changes saved');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
