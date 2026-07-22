/* presik analytics — render core + interactivity.
   The same code powers two data sources: window.__REPORT__ (baked by the CLI,
   static/offline) or a live fetch of /api/report (interactive, with filters).
   Charts are plain SVG/CSS — no library — reusing host.html's bar idea and the
   validated colorblind-safe series colors from report.css. */
(function () {
  'use strict';

  // ----- data source -----------------------------------------------------
  var STATIC = typeof window.__REPORT__ !== 'undefined' ? window.__REPORT__ : null;
  var KEY = new URL(location.href).searchParams.get('key') || '';
  var state = { model: STATIC, filters: {}, table: false };

  var app = document.getElementById('app');
  var tip = document.getElementById('tip');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
  function seriesColor(i) { return 'var(' + SERIES[i % SERIES.length] + ')'; }
  function pctText(p) { return p == null ? '—' : p + '%'; }

  // ----- fetch (live mode) ----------------------------------------------
  function load(filters) {
    state.filters = filters || {};
    app.innerHTML = '<div class="loading">Loading…</div>';
    var q = new URLSearchParams();
    if (KEY) q.set('key', KEY);
    ['course', 'session', 'group'].forEach(function (k) { if (state.filters[k]) q.set(k, state.filters[k]); });
    fetch('/api/report?' + q.toString())
      .then(function (r) { if (!r.ok) throw new Error(r.status === 403 ? 'Add ?key=… — the report is teacher-only.' : 'HTTP ' + r.status); return r.json(); })
      .then(function (m) { state.model = m; render(); })
      .catch(function (e) { app.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
  }

  // ----- tooltip ---------------------------------------------------------
  function bindTip(root) {
    root.querySelectorAll('[data-tip]').forEach(function (el) {
      el.addEventListener('mousemove', function (e) {
        tip.innerHTML = el.getAttribute('data-tip');
        tip.classList.add('on');
        var x = e.clientX + 14, y = e.clientY + 14;
        if (x + tip.offsetWidth > innerWidth) x = e.clientX - tip.offsetWidth - 14;
        tip.style.left = x + 'px'; tip.style.top = y + 'px';
      });
      el.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
    });
  }

  // ----- chart primitives ------------------------------------------------
  function tile(k, v, small, accent) {
    return '<div class="tile' + (accent ? ' accent' : '') + '"><div class="k">' + esc(k) + '</div>' +
      '<div class="v">' + (v == null ? '—' : esc(String(v))) + (small ? ' <small>' + esc(small) + '</small>' : '') + '</div></div>';
  }

  // one horizontal bar: kind ∈ 'correct' | 'wrong' | 'lead' | ''
  function bar(label, n, total, kind, tipHtml) {
    var pct = total ? Math.round((n / total) * 100) : 0;
    return '<div class="bar ' + kind + '"' + (tipHtml ? ' data-tip="' + esc(tipHtml) + '"' : '') + '>' +
      '<div class="lab"><span>' + esc(label) + '</span><span class="n">' + n + ' · ' + pct + '%</span></div>' +
      '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div></div>';
  }

  // correct% donut (SVG). p may be null.
  function donut(p, caption) {
    var r = 46, c = 2 * Math.PI * r, on = c * ((p || 0) / 100);
    var color = p == null ? 'var(--dim)' : p >= 70 ? 'var(--green)' : p >= 40 ? 'var(--amber)' : 'var(--red)';
    return '<div class="donut-wrap"><svg class="donut" width="120" height="120" viewBox="0 0 120 120">' +
      '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="var(--panel2)" stroke-width="12"/>' +
      '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="12" stroke-linecap="round"' +
      ' stroke-dasharray="' + on + ' ' + c + '" transform="rotate(-90 60 60)"/>' +
      '<text x="60" y="60" text-anchor="middle" dominant-baseline="central" fill="var(--txt)" font-size="26" font-weight="650">' + pctText(p) + '</text>' +
      '</svg><div class="donut-c">' + esc(caption || '') + '</div></div>';
  }

  // trend line over time (timeline points with .correctPct / .at)
  function sparkline(points, w, h) {
    w = w || 620; h = h || 130;
    var pad = 26, pts = points.filter(function (p) { return p.correctPct != null; });
    if (pts.length < 2) return '<div class="empty">Not enough graded runs for a trend yet.</div>';
    var xs = function (i) { return pad + (i / (pts.length - 1)) * (w - pad * 2); };
    var ys = function (v) { return h - pad - (v / 100) * (h - pad * 2); };
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + ys(p.correctPct).toFixed(1); }).join(' ');
    var svg = '<svg width="100%" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="max-width:' + w + 'px">';
    [0, 50, 100].forEach(function (g) { svg += '<line class="grid-line" x1="' + pad + '" y1="' + ys(g) + '" x2="' + (w - pad) + '" y2="' + ys(g) + '"/>' +
      '<text class="ax" x="2" y="' + (ys(g) + 4) + '">' + g + '%</text>'; });
    svg += '<path class="spark-line" d="' + line + '"/>';
    svg += pts.map(function (p, i) {
      var t = new Date(p.at).toISOString().slice(0, 10) + ' · ' + esc(p.session) + (p.group ? ' · ' + esc(p.group) : '') + ' — <b>' + p.correctPct + '%</b> (' + p.students + ' students)';
      return '<circle class="spark-dot" cx="' + xs(i) + '" cy="' + ys(p.correctPct) + '" r="4" data-tip="' + t + '"/>';
    }).join('');
    return svg + '</svg>';
  }

  // group-comparison bars. Each entry: { label, pct (0–100 bar width), sub,
  // valueText (what the number reads as — defaults to "<pct>%") }.
  function compareBars(items) {
    var legend = '<div class="legend">' + items.map(function (it, i) {
      return '<span><span class="swatch" style="background:' + seriesColor(i) + '"></span>' + esc(it.label) + '</span>';
    }).join('') + '</div>';
    var rows = items.map(function (it, i) {
      var v = it.pct == null ? 0 : it.pct;
      var txt = it.pct == null ? '—' : (it.valueText != null ? it.valueText : it.pct + '%');
      return '<div class="bar" data-tip="' + esc(it.label) + ' — <b>' + esc(txt) + '</b>' + (it.sub ? '<br>' + esc(it.sub) : '') + '">' +
        '<div class="lab"><span>' + esc(it.label) + '</span><span class="n">' + esc(txt) + '</span></div>' +
        '<div class="track"><div class="fill" style="width:' + v + '%;background:' + seriesColor(i) + '"></div></div></div>';
    }).join('');
    return legend + '<div class="bars">' + rows + '</div>';
  }

  function heatColor(p) {
    if (p == null) return null;
    // red → amber → green ramp by correctness
    var g = p >= 50 ? 'var(--green)' : 'var(--amber)';
    if (p < 25) g = 'var(--red)';
    return g;
  }
  function heatmap(hm) {
    var out = '<div class="heat"><table class="heat-t"><tr><th></th>' +
      hm.groups.map(function (g) { return '<th>' + esc(g) + '</th>'; }).join('') + '</tr>';
    var cellFor = {};
    hm.cells.forEach(function (c) { cellFor[c.qid + '|' + c.group] = c; });
    hm.questions.forEach(function (q) {
      out += '<tr><th class="q" title="' + esc(q.text) + '">' + esc(q.text.slice(0, 42)) + '</th>';
      hm.groups.forEach(function (g) {
        var c = cellFor[q.qid + '|' + g];
        if (!c || c.correctPct == null) out += '<td class="na">—</td>';
        else out += '<td style="background:' + heatColor(c.correctPct) + '" data-tip="' + esc(q.text) + '<br>Group <b>' + esc(g) + '</b>: ' + c.correctPct + '% correct (' + c.answered + ')">' + c.correctPct + '</td>';
      });
      out += '</tr>';
    });
    return out + '</table></div>';
  }

  // ----- controls (filter row, live mode only) ---------------------------
  function controls(m) {
    var el = document.getElementById('controls');
    if (STATIC) { el.innerHTML = ''; return; } // baked export: single fixed view
    var idx = m.index, f = m.filters;
    function sel(id, label, opts, cur) {
      return '<div class="ctl"><label for="' + id + '">' + label + '</label><select id="' + id + '">' +
        opts.map(function (o) { return '<option value="' + esc(o.v) + '"' + (o.v === (cur || '') ? ' selected' : '') + '>' + esc(o.t) + '</option>'; }).join('') +
        '</select></div>';
    }
    var courseOpts = [{ v: '', t: 'All courses' }].concat(idx.courses.map(function (c) { return { v: c, t: c }; }));
    var sessOpts = [{ v: '', t: f.course ? 'All sessions in course' : 'All sessions' }]
      .concat(idx.sessions.map(function (s) { return { v: s.session, t: s.title || s.session }; }));
    var groupOpts = [{ v: '', t: 'All groups' }].concat(idx.groups.map(function (g) { return { v: g, t: g }; }));
    var html = '';
    if (idx.courses.length) html += sel('fCourse', 'Course', courseOpts, f.course);
    html += sel('fSession', 'Session', sessOpts, f.session);
    if (idx.groups.length) html += sel('fGroup', 'Group', groupOpts, f.group);
    el.innerHTML = html + '<span class="grow"></span>';

    function on(id, key, clears) {
      var s = document.getElementById(id); if (!s) return;
      s.onchange = function () {
        var nf = Object.assign({}, state.filters);
        nf[key] = s.value || undefined;
        (clears || []).forEach(function (c) { nf[c] = undefined; });
        load(nf);
      };
    }
    on('fCourse', 'course', ['session', 'group']); // changing course resets narrower filters
    on('fSession', 'session', ['group']);
    on('fGroup', 'group', []);
  }

  // ----- section renderers ----------------------------------------------
  function kpis(m) {
    var s = m.summary, t = [];
    t.push(tile('Answers', s.answers));
    t.push(tile('Students', s.students));
    if (m.scope !== 'session') { if (s.courses) t.push(tile('Courses', s.courses)); t.push(tile('Sessions', s.sessions)); }
    if (s.groups) t.push(tile('Groups', s.groups));
    t.push(tile('Runs', s.runs));
    t.push(tile('Correct', pctText(s.correctPct), 'avg', true));
    return '<div class="tiles">' + t.join('') + '</div>';
  }

  function questionCard(q) {
    var meta = q.type === 'choice' ? pctText(q.correctPct) + ' correct · ' + q.answered + ' answered'
      : q.type === 'scale' ? 'avg ' + (q.avg == null ? '—' : q.avg) + ' · ' + q.answered + ' answered'
      : q.answered + ' answered';
    var h = '<div class="card"><div class="qhead"><span class="qt">' + esc(q.text) + '</span><span class="qmeta">' + esc(meta) + '</span></div>';

    if (state.table) { h += questionTable(q); return h + '</div>'; }

    if (q.type === 'choice') {
      var total = q.options.reduce(function (a, o) { return a + o.n; }, 0);
      var max = Math.max.apply(null, q.options.map(function (o) { return o.n; }).concat([0]));
      h += '<div class="bars">' + q.options.map(function (o) {
        var kind = o.correct ? 'correct' : (o.n === max && o.n > 0 && !q.options.some(function (x) { return x.correct; })) ? 'lead' : 'wrong';
        return bar(o.text, o.n, total, kind, esc(o.text) + (o.correct ? ' <b>(correct)</b>' : '') + '<br>' + o.n + ' of ' + total + ' · ' + o.pct + '%');
      }).join('') + '</div>';
    } else if (q.type === 'scale') {
      var tot = q.bins.reduce(function (a, b) { return a + b.n; }, 0);
      h += '<div class="bars">' + q.bins.map(function (b) {
        return bar(String(b.value), b.n, tot, '', 'Rating <b>' + b.value + '</b><br>' + b.n + ' of ' + tot);
      }).join('') + '</div>';
    } else {
      h += q.texts && q.texts.length
        ? '<div class="texts">' + q.texts.map(function (t) { return '<div>' + esc(t) + '</div>'; }).join('') + '</div>'
        : '<div class="empty">No text answers recorded.</div>';
    }
    // per-group breakdown when more than one group answered
    if (q.byGroup && q.byGroup.length > 1 && q.type !== 'text') {
      h += '<div style="margin-top:14px">' + compareBars(q.byGroup.map(function (g) {
        if (q.type === 'scale') {
          return { label: 'Group ' + g.group, pct: g.avg == null ? null : Math.round((g.avg / (q.max || 5)) * 100),
            valueText: g.avg == null ? '—' : 'avg ' + g.avg, sub: g.answered + ' answered' };
        }
        return { label: 'Group ' + g.group, pct: g.correctPct, sub: g.answered + ' answered' };
      })) + '</div>';
    }
    return h + '</div>';
  }

  function questionTable(q) {
    if (q.type === 'text') return '<table class="data"><tr><th>Answer</th></tr>' + (q.texts || []).map(function (t) { return '<tr><td>' + esc(t) + '</td></tr>'; }).join('') + '</table>';
    var rows = q.type === 'choice'
      ? q.options.map(function (o) { return '<tr><td>' + esc(o.text) + (o.correct ? ' ✓' : '') + '</td><td class="num">' + o.n + '</td><td class="num">' + o.pct + '%</td></tr>'; })
      : q.bins.map(function (b) { return '<tr><td>' + b.value + '</td><td class="num">' + b.n + '</td><td class="num"></td></tr>'; });
    return '<table class="data"><tr><th>Option</th><th class="num">n</th><th class="num">%</th></tr>' + rows.join('') + '</table>';
  }

  function renderSession(m) {
    var d = m.session, h = '';
    h += kpis(m);
    // headline: correct% donut + group comparison side by side
    h += '<section><h2 class="sec">Overview</h2><div class="card"><div class="donut-wrap">' +
      donut(m.summary.correctPct, 'average correct across graded questions') + '</div></div></section>';
    if (d.groups && d.groups.length > 1) {
      h += '<section><h2 class="sec">Groups compared</h2><div class="card">' +
        compareBars(d.groups.map(function (g) { return { label: 'Group ' + g.group, pct: g.correctPct, sub: g.students + ' students · ' + g.answered + ' answers' }; })) + '</div></section>';
    }
    if (d.heatmap) h += '<section><h2 class="sec">Correct % by question × group</h2><div class="card">' + heatmap(d.heatmap) + '</div></section>';
    h += '<section><h2 class="sec">Questions</h2>' + d.questions.map(questionCard).join('') + '</section>';
    return h;
  }

  function renderOverview(m) {
    var o = m.overview, h = kpis(m);
    if (o.timeline && o.timeline.length > 1) {
      h += '<section><h2 class="sec">Correct % over time</h2><div class="card">' + sparkline(o.timeline) + '</div></section>';
    }
    if (o.courses && o.courses.length > 1) {
      h += '<section><h2 class="sec">Courses</h2><div class="grid">' + o.courses.map(function (c) {
        return '<div class="card clickable" data-course="' + esc(c.course) + '"><div class="qhead"><span class="qt">' + esc(c.course) + '</span><span class="qmeta">' + pctText(c.correctPct) + '</span></div>' +
          '<div class="sub" style="margin:0">' + c.sessions + ' sessions · ' + c.students + ' students · ' + c.answers + ' answers</div></div>';
      }).join('') + '</div></section>';
    }
    if (o.sessions && o.sessions.length) {
      h += '<section><h2 class="sec">Sessions</h2>';
      if (state.table) {
        h += '<div class="card"><table class="data"><tr><th>Session</th><th>Course</th><th class="num">Students</th><th class="num">Answers</th><th class="num">Correct</th><th>Last run</th></tr>' +
          o.sessions.map(function (s) { return '<tr><td>' + esc(s.title) + '</td><td>' + esc(s.course || '—') + '</td><td class="num">' + s.students + '</td><td class="num">' + s.answers + '</td><td class="num">' + pctText(s.correctPct) + '</td><td>' + esc((s.lastAt || '').slice(0, 10)) + '</td></tr>'; }).join('') +
          '</table></div>';
      } else {
        h += '<div class="grid">' + o.sessions.map(function (s) {
          return '<div class="card clickable" data-session="' + esc(s.session) + '"><div class="qhead"><span class="qt">' + esc(s.title) + '</span><span class="qmeta">' + pctText(s.correctPct) + '</span></div>' +
            '<div class="sub" style="margin:0">' + (s.course ? esc(s.course) + ' · ' : '') + s.students + ' students · ' + s.answers + ' answers</div></div>';
        }).join('') + '</div>';
      }
      h += '</section>';
    }
    if (o.groups && o.groups.length > 1) {
      h += '<section><h2 class="sec">Groups compared</h2><div class="card">' +
        compareBars(o.groups.map(function (g) { return { label: 'Group ' + g.group, pct: g.correctPct, sub: g.students + ' students · ' + g.answers + ' answers' }; })) + '</div></section>';
    }
    return h;
  }

  // ----- top-level render ------------------------------------------------
  function render() {
    var m = state.model;
    if (!m) { app.innerHTML = '<div class="err">No data.</div>'; return; }
    document.getElementById('title').textContent =
      m.scope === 'session' ? (m.session ? m.session.title : 'Session') : m.scope === 'course' ? (m.filters.course || 'Course') : 'Analytics';
    document.getElementById('scope').textContent = m.scope;
    var scopeLine = m.scope === 'session'
      ? (m.session && m.session.course ? m.session.course + ' · ' : '') + (m.filters.session || '') + (m.filters.group ? ' · group ' + m.filters.group : '')
      : m.summary.sessions + ' sessions across ' + (m.summary.courses || 'no') + ' courses';
    document.getElementById('sub').textContent = scopeLine;
    controls(m);
    app.innerHTML = m.scope === 'session' ? renderSession(m) : renderOverview(m);
    bindTip(app);
    // drill-down: click a session/course card
    app.querySelectorAll('[data-session]').forEach(function (el) {
      el.onclick = function () { if (!STATIC) load({ course: state.filters.course, session: el.getAttribute('data-session') }); };
    });
    app.querySelectorAll('[data-course]').forEach(function (el) {
      el.onclick = function () { if (!STATIC) load({ course: el.getAttribute('data-course') }); };
    });
    document.getElementById('foot').textContent = 'Generated ' + new Date(m.generatedAt).toLocaleString() + (STATIC ? ' · exported report' : '');
  }

  // ----- chrome ----------------------------------------------------------
  document.getElementById('exportBtn').onclick = function () { window.print(); };
  document.getElementById('tableToggle').onclick = function () {
    state.table = !state.table;
    this.setAttribute('aria-pressed', state.table ? 'true' : 'false');
    render();
  };

  // ----- boot ------------------------------------------------------------
  // A live report can be deep-linked: ?session=…&group=… boots straight into
  // that view (also how drill-down updates the visible state).
  if (STATIC) { render(); }
  else {
    var sp = new URL(location.href).searchParams;
    load({ course: sp.get('course') || undefined, session: sp.get('session') || undefined, group: sp.get('group') || undefined });
  }
})();
