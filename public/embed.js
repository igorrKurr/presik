// Live quiz — not a separate panel, part of the slides themselves.
// The author drops empty markers into .marp.md:
//   <div data-quiz-join></div>                    — big QR "join"
//   <div data-quiz-question="qid"></div>           — question slide
//   <div data-quiz-reveal="qid"></div>             — result slide
// This script fills them with live content (via /api/stream) and, if the
// page was opened with ?key=... (the teacher), also drives the quiz: when
// arrow keys on the projector activate a question slide, it becomes the
// current question; when a reveal slide is activated, the result is shown.
// So paging through slides with arrow keys is itself the remote control.
(function () {
  var CFG = window.__PRESIK__ || {};
  var QMAP = {};
  var QORDER = (CFG.questions || []).map(function (q) {
    QMAP[q.id] = q;
    return q.id;
  });
  var last = null; // latest state snapshot from /api/stream

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function bar(pct) {
    return '<div class="quiz-bar"><div class="quiz-bar-fill" style="width:' + pct + '%"></div></div>';
  }

  function joinBlock(size) {
    var url = (last && last.joinUrl) || '';
    return (
      '<div class="quiz-join quiz-join-' + size + '">' +
      '<img src="/qr.svg" alt="Join QR code">' +
      (size === 'lg' ? '<div class="quiz-join-title">Scan to join</div>' : '') +
      (url ? '<div class="quiz-join-url">' + esc(url) + '</div>' : '') +
      '</div>'
    );
  }

  function renderJoinSlot(el) {
    el.innerHTML =
      '<div class="quiz-slide quiz-join-slide">' +
      joinBlock('lg') +
      '<div class="quiz-join-note">Keep this page open until the end of class</div>' +
      '</div>';
  }

  function renderQuestionSlot(el, qid) {
    var qdef = QMAP[qid];
    if (!qdef) {
      el.innerHTML = '';
      return;
    }
    var active = !!(last && last.question && last.question.id === qid);
    var st = (active && last.stats) || {};
    var html = '<div class="quiz-slide quiz-question-slide' + (active ? '' : ' quiz-pending') + '">';
    html += '<div class="quiz-kicker">Question' + (active ? ' ' + (QORDER.indexOf(qid) + 1) + ' / ' + QORDER.length : '') + '</div>';
    html += '<div class="quiz-question-text">' + esc(qdef.text) + '</div>';
    if (qdef.note) html += '<div class="quiz-note">' + esc(qdef.note) + '</div>';
    if (qdef.type === 'choice' && qdef.options.length) {
      html += '<ul class="quiz-options-list">' + qdef.options.map(function (o) { return '<li>' + esc(o.text) + '</li>'; }).join('') + '</ul>';
    }
    if (active) {
      html +=
        '<div class="quiz-cta"><div class="quiz-cta-title">Answer on your phone</div>' +
        '<div class="quiz-progress">Answered: ' + (st.answered || 0) + ' · connected: ' + (st.connected || 0) + '</div></div>';
    } else {
      html += '<div class="quiz-cta quiz-muted">Coming up</div>';
    }
    html += joinBlock('sm');
    html += '</div>';
    el.innerHTML = html;
  }

  function renderRevealSlot(el, qid) {
    var qdef = QMAP[qid];
    if (!qdef) {
      el.innerHTML = '';
      return;
    }
    var active = !!(last && last.question && last.question.id === qid);
    var revealed = active && last.revealed;
    var st = (revealed && last.stats) || {};
    var html = '<div class="quiz-slide quiz-reveal-slide' + (revealed ? '' : ' quiz-pending') + '">';
    html += '<div class="quiz-kicker">Result</div>';
    html += '<div class="quiz-question-text">' + esc(qdef.text) + '</div>';
    if (!revealed) {
      html += '<div class="quiz-cta quiz-muted">Coming up</div>';
    } else if (qdef.type === 'choice') {
      var counts = st.counts || {};
      var total = Object.keys(counts).reduce(function (a, k) { return a + counts[k]; }, 0) || 1;
      var correctIds = last.question.correct || [];
      html +=
        '<div class="quiz-opts">' +
        qdef.options
          .map(function (o) {
            var c = counts[o.id] || 0;
            var pct = Math.round((c / total) * 100);
            var isCorrect = correctIds.indexOf(o.id) >= 0;
            return (
              '<div class="quiz-opt' + (isCorrect ? ' quiz-correct' : '') + '">' +
              '<div class="quiz-opt-row"><span>' + esc(o.text) + '</span><span>' + c + ' · ' + pct + '%</span></div>' +
              bar(pct) +
              '</div>'
            );
          })
          .join('') +
        '</div>';
    } else if (qdef.type === 'scale') {
      var counts2 = st.counts || {};
      var keys = Object.keys(counts2);
      var maxc = Math.max.apply(null, [1].concat(keys.map(function (k) { return counts2[k]; })));
      html +=
        '<div class="quiz-opts">' +
        keys
          .map(function (k) {
            var c = counts2[k];
            var pct = Math.round((c / maxc) * 100);
            return '<div class="quiz-opt"><div class="quiz-opt-row"><span>' + esc(k) + '</span><span>' + c + '</span></div>' + bar(pct) + '</div>';
          })
          .join('') +
        '</div>' +
        (st.avg ? '<div class="quiz-note">Average: ' + esc(st.avg) + '</div>' : '');
    } else if (qdef.type === 'text') {
      var texts = st.texts || [];
      html +=
        '<div class="quiz-texts">' +
        (texts.length
          ? texts.slice(0, 14).map(function (t) { return '<div class="quiz-text-item">' + esc(t) + '</div>'; }).join('')
          : '<div class="quiz-muted">No answers yet</div>') +
        '</div>';
    }
    if (revealed && st.connected > st.answered) {
      html += '<div class="quiz-progress">Still answering: ' + (st.connected - st.answered) + ' of ' + st.connected + ' connected</div>';
    }
    if (revealed && last.question.explain) html += '<div class="quiz-explain">' + esc(last.question.explain) + '</div>';
    html += '</div>';
    el.innerHTML = html;
  }

  function renderAll() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-quiz-join]'), renderJoinSlot);
    Array.prototype.forEach.call(document.querySelectorAll('[data-quiz-question]'), function (el) {
      renderQuestionSlot(el, el.getAttribute('data-quiz-question'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-quiz-reveal]'), function (el) {
      renderRevealSlot(el, el.getAttribute('data-quiz-reveal'));
    });
  }

  function connect() {
    // Always without ?key= — even for the teacher, slides on the projector
    // must behave like the audience: correct answer and distribution stay
    // hidden until reveal, regardless of who's driving navigation.
    // embed=1 — this is the slides tab itself, not a real student, so it
    // shouldn't count towards "connected".
    var es = new EventSource('/api/stream?embed=1');
    es.onmessage = function (e) {
      try {
        last = JSON.parse(e.data);
      } catch (_) {
        return;
      }
      renderAll();
    };
  }

  // ---- driving the quiz via slide arrow keys (only if ?key= is present) ----
  function control(body) {
    fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ key: CFG.key }, body)),
    }).catch(function () {});
  }

  var lastActivatedKey = null;
  function handleActivate(section) {
    var qEl = section.querySelector('[data-quiz-question]');
    var rEl = section.querySelector('[data-quiz-reveal]');
    var key = qEl ? 'q:' + qEl.getAttribute('data-quiz-question') : rEl ? 'r:' + rEl.getAttribute('data-quiz-reveal') : null;
    if (!key || key === lastActivatedKey) return;
    lastActivatedKey = key;
    if (qEl) {
      var idx = QORDER.indexOf(qEl.getAttribute('data-quiz-question'));
      if (idx >= 0) control({ action: 'goto', to: idx });
    } else if (rEl) {
      var ridx = QORDER.indexOf(rEl.getAttribute('data-quiz-reveal'));
      if (ridx >= 0) control({ action: 'goto', to: ridx });
      control({ action: 'reveal' });
    }
  }

  function watchNavigation() {
    if (!CFG.isHost || !CFG.key) return;
    // Marp/bespoke wraps each slide in <svg><foreignObject><section>...</section></foreignObject></svg>
    // and puts the "bespoke-marp-active" class on the <svg> itself, not the
    // <section> — so we watch the whole deck container, not individual sections.
    var parent = document.querySelector('.bespoke-marp-parent') || document.body;
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName !== 'class') return;
        var el = m.target;
        if (el.classList && el.classList.contains('bespoke-marp-active')) handleActivate(el);
      });
    });
    mo.observe(parent, { attributes: true, attributeFilter: ['class'], subtree: true });
    var active = parent.querySelector('.bespoke-marp-active');
    if (active) handleActivate(active);
  }

  function mount() {
    renderAll();
    connect();
    watchNavigation();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
