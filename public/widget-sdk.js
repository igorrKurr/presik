// presik widget SDK — the stable client interface a quiz widget codes against,
// so a game never hand-rolls postMessage. It's the whole protocol in one small,
// dependency-free file. Two ways to use it:
//
//   • local widget (srcdoc / a bundle served by presik):
//       <script src="/widget-sdk.js"></script>          → global PresikWidget
//   • an external game project with its own build/tests:
//       import PresikWidget from 'presik-widget'          → bundle this file
//
// The game side:
//   const quiz = await PresikWidget.connect();
//   quiz.config;                // author config from questions.json
//   quiz.options;               // [{id,text?}, …] the outcomes (choice kind)
//   quiz.answerKind;            // 'choice' | 'scale' | 'text'
//   quiz.answer('east');        // report the student's answer (goes through the
//                               //   same server-side gate as a tapped button)
//   quiz.on('reveal', q => …);  // fired when the teacher reveals (q.correct set)
//
// The host side (for the game project's OWN tests — no presik needed):
//   const host = PresikWidget.mockHost(iframe, { answer:'choice', options:[{id:'east'}] });
//   … drive the game …  assert.deepEqual(host.answers, ['east']);
(function (global) {
  var PROTOCOL = '1';

  // ---- client (runs inside the widget iframe) --------------------------------
  function connect() {
    return new Promise(function (resolve) {
      var listeners = {};
      var ready = false;
      var api = {
        protocol: PROTOCOL,
        config: null, options: [], answerKind: 'choice', text: '', note: null, min: undefined, max: undefined,
        revealed: false, value: null, correct: null,
        // Report the student's answer. `value` is an option id (choice), a number
        // (scale), or text — validated as the declared kind before it's counted.
        answer: function (value) { post({ presik: 'answer', value: value }); return api; },
        // Optional, ignored by the quiz today — for the game's own bookkeeping.
        progress: function (data) { post({ presik: 'progress', data: data }); return api; },
        // on('init'|'state'|'reveal', fn)
        on: function (evt, fn) { listeners[evt] = fn; return api; },
      };
      function post(msg) { global.parent.postMessage(msg, '*'); }
      function absorb(d) {
        if ('config' in d) api.config = d.config || null;
        if ('options' in d) api.options = d.options || [];
        if ('answer' in d) api.answerKind = d.answer || 'choice';
        if ('text' in d) api.text = d.text || '';
        if ('note' in d) api.note = d.note || null;
        if ('min' in d) api.min = d.min;
        if ('max' in d) api.max = d.max;
        api.revealed = !!d.revealed;
        api.value = d.value == null ? null : d.value;
        api.correct = d.correct || null;
      }
      global.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || typeof d !== 'object' || typeof d.presik !== 'string') return;
        if (d.presik === 'init') {
          absorb(d);
          if (!ready) { ready = true; resolve(api); }
          if (listeners.init) listeners.init(api);
        } else if (d.presik === 'state') {
          var wasRevealed = api.revealed;
          absorb(d);
          if (listeners.state) listeners.state(api);
          if (api.revealed && !wasRevealed && listeners.reveal) listeners.reveal(api);
        }
      });
      post({ presik: 'ready' }); // ask the quiz for our config + current state
    });
  }

  // ---- host mock (runs the quiz side, for tests) -----------------------------
  // Replies to the widget's `ready` with an `init` you specify, and records every
  // answer/progress the widget reports — so a game project can assert its quiz
  // integration in its own CI, with a plain iframe and no presik server.
  function mockHost(iframe, opts) {
    opts = opts || {};
    var win = function () { return iframe.contentWindow; };
    var host = {
      answers: [], progress: [],
      // Push a reveal (or any state change) to the widget after boot.
      state: function (st) {
        st = st || {};
        win().postMessage({ presik: 'state', revealed: !!st.revealed, value: st.value == null ? null : st.value, correct: st.correct || null }, '*');
        return host;
      },
    };
    global.addEventListener('message', function (e) {
      if (iframe && e.source !== win()) return; // only this widget
      var d = e.data;
      if (!d || typeof d !== 'object' || typeof d.presik !== 'string') return;
      if (d.presik === 'ready') {
        win().postMessage({ presik: 'init', answer: opts.answer || 'choice', options: opts.options || [],
          config: opts.config || null, text: opts.text || '', note: opts.note || null, min: opts.min, max: opts.max,
          revealed: false, value: null, correct: null }, '*');
      } else if (d.presik === 'answer') host.answers.push(d.value);
      else if (d.presik === 'progress') host.progress.push(d.data);
    });
    return host;
  }

  var PresikWidget = { connect: connect, mockHost: mockHost, PROTOCOL: PROTOCOL };
  if (typeof module !== 'undefined' && module.exports) module.exports = PresikWidget;
  global.PresikWidget = PresikWidget;
})(typeof window !== 'undefined' ? window : this);
