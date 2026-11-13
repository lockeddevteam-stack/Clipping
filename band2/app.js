/* LOCKED Band v2: the page the Band app shows. Today, Sleep, Live set, Steps, Lab.
   Everything the band does goes through window.Band (bridge.js); the counting is BandCore (core.js). */
(function () {
  'use strict';
  var C = window.BandCore, B = window.Band, VERSION = '2.0.1';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var app = $('#app');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function keep(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var clock = SleepScrubber.clock, hm = SleepScrubber.hm;
  function ago(t) { if (!t) return 'never'; var m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }
  function mmss(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  var S = {
    tab: load('lkb2.tab', 'today'), status: {}, view: load('lkb2.view', null), viewAt: load('lkb2.viewAt', 0), viewErr: null,
    nightIdx: 0, hrLive: [], set: null, ex: load('lkb2.ex', 'curl'), sets: load('lkb2.sets', []), steps: null, tune: load('lkb2.tune', true),
    sound: load('lkb2.sound', true), lab: { motion: false, capture: false, frames: [], sent: 0 }, msg: null
  };

  // ---------- motion session: raw channel -> packets -> samples at 50 Hz ----------
  var M = null;
  function startMotion(onSample) {
    stopMotion();
    M = { R: new C.Reassembler(), P: new C.MotionParser(), Rs: new C.Resampler(), sinks: [onSample], raw: [], frames: 0, crcBad: 0, v25: 0, v25last: null,
          started: Date.now(), lastFrame: 0, hz: 0, layout: null, base: null };
    M.off = B.on('raw', function (d) {
      if (!M) return;
      d.items.forEach(function (it) {
        if (M.raw.length < 20000) M.raw.push(it);
        if (it[1] !== '0005') return;
        var pk = M.R.feed(C.unhex(it[2]), it[0]);
        pk.forEach(function (p) { handle(p, it[0]); });
      });
    });
    return B.subscribe(['0005', '0004']).then(function () { return B.motion(true); });
  }
  function handle(p, t) {
    if (p.inner[0] === 0x2F && p.inner[1] === 25) { M.v25++; M.v25last = C.parseV25(p.inner); return; }
    var m = M.P.parse(p, t);
    if (!m) return;
    M.frames++; if (!m.crcOk) M.crcBad++; M.layout = m.layout; M.base = m.base; M.lastFrame = t;
    var fs = M.Rs.rate(m.n, t) || 200; M.hz = fs;
    var rows = []; for (var i = 0; i < m.n; i++) rows.push([m.ax[i], m.ay[i], m.az[i]]);
    M.Rs.push(rows, fs, function (v) { M.sinks.forEach(function (f) { if (f) f(v); }); });
  }
  function stopMotion() {
    if (!M) return Promise.resolve();
    var m = M; M = null; if (m.off) m.off();
    return B.motion(false).catch(function () {}).then(function () { return B.subscribe(S.lab.capture ? ['0003', '0004', '0005', '0007'] : []); }).then(function () { return m; });
  }

  // ---------- sound per rep ----------
  var AC = null;
  function beep(f) {
    if (!S.sound) return;
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      var o = AC.createOscillator(), g = AC.createGain(); o.frequency.value = f || 880; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, AC.currentTime); g.gain.exponentialRampToValueAtTime(0.25, AC.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + 0.14);
      o.connect(g); g.connect(AC.destination); o.start(); o.stop(AC.currentTime + 0.16);
    } catch (e) {}
  }

  // ---------- data ----------
  function refresh(force) {
    if (!force && S.view && Date.now() - S.viewAt < 5 * 60000) return Promise.resolve();
    return B.server({ action: 'view', hours: 24, tz_offset_min: -new Date().getTimezoneOffset() }).then(function (j) {
      if (!j || !j.ok) throw new Error('bad');
      S.view = j; S.viewAt = Date.now(); S.viewErr = null; keep('lkb2.view', j); keep('lkb2.viewAt', S.viewAt); render();
    }, function (e) {
      var off = /offline|timeout/.test(String(e && e.message));
      S.viewErr = off ? (S.view ? 'offline' : 'none') : (S.view ? 'offline' : 'missing'); render();
    });
  }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayRow(i) { var ds = (S.view && S.view.days) || []; return ds[i] || null; }
  function nights() { return ((S.view && S.view.days) || []).filter(function (d) { return d.night && Array.isArray(d.night.hr); }); }

  // ---------- render ----------
  var TABS = [
    ['today', 'Today', '<path d="M3 12h4l3-8 4 16 3-8h4"/>'],
    ['sleep', 'Sleep', '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'],
    ['lift', 'Live set', '<path d="M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10"/>'],
    ['steps', 'Steps', '<path d="M8 3c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5zM16 9c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5zM6 17h4M14 21h4"/>'],
    ['lab', 'Lab', '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>']
  ];
  function tabs() {
    $('#tabs').innerHTML = TABS.map(function (t) {
      return '<button class="tab" role="tab" aria-selected="' + (S.tab === t[0]) + '" data-tab="' + t[0] + '" data-testid="tab-' + t[0] + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + t[2] + '</svg>' + t[1] + '</button>';
    }).join('');
  }
  var scrubber = null;
  function render() {
    tabs();
    if (scrubber && S.tab !== 'sleep') { scrubber.destroy(); scrubber = null; }
    var h = S.msg ? '<div class="msg msg--' + S.msg[0] + '" role="status">' + esc(S.msg[1]) + '</div>' : '';
    if (S.tab === 'today') h += viewToday();
    else if (S.tab === 'sleep') h += viewSleep();
    else if (S.tab === 'lift') h += viewLift();
    else if (S.tab === 'steps') h += viewSteps();
    else h += viewLab();
    app.innerHTML = h;
    if (S.tab === 'today') drawToday();
    if (S.tab === 'sleep') mountSleep();
    if (S.tab === 'lift' && S.set && S.set.phase === 'run') drawTrace();
  }

  function bandCard() {
    var st = S.status, on = st.state === 'connected', bpm = st.bpm || (S.hrLive.length ? S.hrLive[S.hrLive.length - 1][1] : null);
    var where = { connected: 'Connected', connecting: 'Connecting…', scanning: 'Looking for your band…', lost: 'Out of range', idle: 'Not connected', off: 'Bluetooth is off' }[st.state] || 'Not connected';
    return '<div class="card" data-testid="band-card"><div class="row"><span class="dot' + (on ? ' on' : st.state === 'connecting' ? ' mid' : '') + '"></span>' +
      '<div class="grow"><b>' + esc(st.name || 'Your band') + '</b><div class="small faint">' + where + (st.battery != null ? ' · ' + st.battery + '% battery' : '') + '</div></div>' +
      (bpm && on ? '<span class="bpm" data-testid="live-bpm"><svg class="heart" viewBox="0 0 24 24" fill="#FF375F"><path d="M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11z"/></svg>' + bpm + '<small>bpm</small></span>' : '') +
      '</div>' + (B.mode === 'web' && !on ? '<button class="btn btn--go" style="margin-top:14px" data-act="connect">Connect your band</button>' : '') + '</div>';
  }
  function viewToday() {
    var r = dayRow(0), rec = r && r.recovery != null ? r.recovery : null, col = rec == null ? 'rgba(246,238,231,.1)' : rec >= 67 ? '#4CD38A' : rec >= 34 ? '#FFC857' : '#FF5A5F';
    var C2 = 2 * Math.PI * 50, st = S.status;
    var h = '<div class="lab">' + esc(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })) + '</div><h1>Today</h1>' + bandCard();
    h += setupCard();
    if (!S.view && S.viewErr === 'none') h += '<div class="msg msg--warn">Your numbers need a connection the first time. Live heart rate works without one.</div>';
    else if (!S.view && S.viewErr === 'missing') h += '<div class="msg msg--warn" data-testid="view-missing">Your scores show here soon. Live heart rate, Live set and Steps already work.</div>';
    else if (S.viewErr === 'offline') h += '<div class="msg msg--warn">Offline. Showing what you had ' + esc(ago(S.viewAt)) + '.</div>';
    h += '<div class="card hero" data-testid="recovery"><div class="dial"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" fill="none" stroke="rgba(246,238,231,.08)" stroke-width="10"/>' +
      (rec != null ? '<circle cx="60" cy="60" r="50" fill="none" stroke="' + col + '" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + (C2 * rec / 100).toFixed(1) + ' ' + C2.toFixed(1) + '"/>' : '') +
      '</svg><b>' + (rec != null ? rec + '<small>%</small>' : '–') + '<small>Recovery</small></b></div>' +
      '<div class="grid4 grow">' + kv('HRV', r && r.hrv, 'ms') + kv('Resting', r && r.rhr, 'bpm') + kv('Sleep', r && r.sleep_min ? hm(r.sleep_min) : null, '') + kv('Strain', r && r.strain != null ? Number(r.strain).toFixed(1) : null, '') + '</div></div>';
    h += '<h2>Heart rate today</h2><div class="card"><canvas class="chart" id="hrc" data-testid="hr-today"></canvas><div class="axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>Now</span></div></div>';
    if (B.mode !== 'web') {
      h += '<h2>History</h2><div class="card"><div class="row"><div class="grow"><b>' + (st.syncing ? esc(st.phase || 'Syncing…') : 'Synced ' + esc(ago(st.lastSync))) + '</b>' +
        '<div class="small faint">' + (st.upTo ? 'LOCKED has your band up to ' + esc(clock(st.upTo)) : 'Your band keeps about a week. The app reads it each time it connects.') + (st.queued ? ' · ' + st.queued + ' min waiting to upload' : '') + '</div></div>' +
        '<button class="btn btn--sm" data-act="sync"' + (st.syncing || st.state !== 'connected' ? ' disabled' : '') + ' data-testid="sync">Sync now</button></div>' +
        (st.note ? '<div class="small muted" style="margin-top:10px" data-testid="sync-note">' + esc(st.note) + '</div>' : '') + '</div>';
    }
    return h;
  }
  /* First run inside the app: find the band, then link it to LOCKED with the six-digit code. */
  function setupCard() {
    var st = S.status;
    if (B.mode !== 'native') return '';
    if (st.paired === false) {
      var list = (st.found || []).map(function (f) { return '<button class="btn" style="margin-top:8px" data-act="pick" data-v="' + esc(f.id) + '">' + esc(f.name) + '</button>'; }).join('');
      return '<div class="card" data-testid="setup-band"><b>Find your band</b><p class="small muted" style="margin:6px 0 12px">Close the WHOOP app and keep the band close to your phone.</p>' +
        (st.state === 'scanning' ? '<div class="small faint">Looking\u2026</div>' : '<button class="btn btn--go" data-act="scan">Look for my band</button>') + list + '</div>';
    }
    if (st.linked === false) {
      return '<div class="card" data-testid="setup-link"><b>Link to LOCKED</b><p class="small muted" style="margin:6px 0 12px">In LOCKED: Profile, Wearables, Connect. Type the six digits here.</p>' +
        '<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="width:100%;height:52px;border-radius:14px;border:1px solid var(--line);background:rgba(246,238,231,.05);color:var(--text);font:800 26px var(--num);text-align:center;letter-spacing:.3em">' +
        '<button class="btn btn--go" style="margin-top:10px" data-act="link">Link</button></div>';
    }
    return '';
  }
  function kv(k, v, u) { return '<span class="kv"><em>' + k + '</em><b>' + (v != null && v !== '' ? esc(v) + (u ? '<small>' + u + '</small>' : '') : '–') + '</b></span>'; }
  function drawToday() {
    var c = $('#hrc'); if (!c) return;
    var r = c.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1); c.width = r.width * dpr; c.height = r.height * dpr;
    var g = c.getContext('2d'); g.scale(dpr, dpr);
    var d0 = new Date(); d0.setHours(0, 0, 0, 0); var t0 = d0.getTime(), t1 = Date.now();
    var pts = ((S.view && S.view.hr) || []).filter(function (p) { return p[0] >= t0; }).concat(S.hrLive.filter(function (p) { return p[0] >= t0; }));
    if (!pts.length) { g.fillStyle = 'rgba(246,238,231,.42)'; g.font = '15px -apple-system,system-ui'; g.textAlign = 'center'; g.fillText('Nothing yet today', r.width / 2, r.height / 2); return; }
    var vs = pts.map(function (p) { return p[1]; }), lo = Math.min.apply(null, vs) - 5, hi = Math.max.apply(null, vs) + 5;
    var X = function (t) { return (t - t0) / (t1 - t0) * r.width; }, Y = function (v) { return r.height - 4 - (v - lo) / (hi - lo) * (r.height - 8); };
    g.beginPath(); var pen = false, last = 0;
    pts.forEach(function (p) { if (pen && p[0] - last > 10 * 60000) pen = false; pen ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])); pen = true; last = p[0]; });
    g.strokeStyle = '#FF375F'; g.lineWidth = 1.5; g.lineJoin = 'round'; g.stroke();
    g.fillStyle = 'rgba(246,238,231,.42)'; g.font = '600 10px ui-monospace,Menlo'; g.textAlign = 'left'; g.fillText(Math.round(hi - 5), 2, 11); g.fillText(Math.round(lo + 5), 2, r.height - 6);
  }

  function viewSleep() {
    var ns = nights(), i = Math.min(S.nightIdx, Math.max(0, ns.length - 1)), d = ns[i];
    var h = '<div class="lab">Sleep</div><h1>' + (d ? (i === 0 && d.day === today() ? 'Last night' : esc(new Date(d.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long' })) + ' night') : 'Sleep') + '</h1>';
    if (S.viewErr === 'offline') h += '<div class="msg msg--warn">Offline. Showing what you had ' + esc(ago(S.viewAt)) + '.</div>';
    h += '<div class="nightnav"><button class="nav" data-act="night" data-v="' + (i + 1) + '"' + (i + 1 < ns.length ? '' : ' disabled') + ' aria-label="Night before">‹</button>' +
      '<b>' + (d ? esc(new Date(d.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })) : '') + '</b>' +
      '<button class="nav" data-act="night" data-v="' + (i - 1) + '"' + (i > 0 ? '' : ' disabled') + ' aria-label="Night after">›</button></div>';
    h += '<div class="card"><div id="scrub" data-testid="scrub"></div>';
    if (d && d.night.blocks && d.night.blocks.length) {
      h += '<div class="legend">' + [[3, 'Deep', 'var(--deep)'], [1, 'REM', 'var(--rem)'], [2, 'Light', 'var(--light)'], [0, 'Awake', 'var(--awake)']].map(function (x) {
        return '<span><i style="background:' + x[2] + '"></i><b>' + hm(sum(d.night.blocks, [x[0]])) + '</b><em>' + x[1] + '</em></span>'; }).join('') + '</div>';
    }
    h += '</div><p class="small faint" style="text-align:center">Touch and drag across the night to see any minute.</p>';
    return h;
  }
  function sum(bl, ks) { return (bl || []).reduce(function (s, b) { return s + (ks.indexOf(b[0]) >= 0 ? Number(b[2]) : 0); }, 0); }
  function mountSleep() {
    var ns = nights(), d = ns[Math.min(S.nightIdx, Math.max(0, ns.length - 1))];
    if (scrubber) scrubber.destroy();
    scrubber = new SleepScrubber($('#scrub'), { hover: true, onTick: function () { B.haptic('light'); } });
    scrubber.set(d ? d.night : { emptyText: S.view ? 'No night yet. Wear your band to bed.' : 'Your nights show here once the app is online.' });
  }

  // ---------- live set ----------
  function viewLift() {
    var st = S.set;
    if (st && st.phase === 'run') return viewSetRun(st);
    if (st && st.phase === 'done') return viewSetDone(st);
    var ex = C.exercise(S.ex);
    var h = '<div class="lab">Live set</div><h1>Pick a lift</h1>';
    var tile = function (e) { return '<button class="ex" aria-pressed="' + (S.ex === e.id) + '" data-act="ex" data-v="' + e.id + '" data-testid="ex-' + e.id + '">' + esc(e.name) + '<span>' + (e.countable ? (e.signal === 'tilt' ? 'Counts from your wrist' : e.id === 'squat' || e.id === 'lunge' ? 'Worth a try' : 'Counts from your wrist') : 'You enter the reps') + '</span></button>'; };
    h += '<div class="exgrid">' + C.EXERCISES.filter(function (e) { return e.countable && e.signal; }).map(tile).join('') + '</div>';
    h += '<h2>Legs</h2><div class="exgrid">' + C.EXERCISES.filter(function (e) { return !e.countable; }).map(tile).join('') + '</div>';
    if (ex && !ex.countable) h += '<div class="msg msg--warn" style="margin-top:12px" data-testid="no-count">Your wrist barely moves on a ' + esc(ex.name.toLowerCase()) + ', so the band can’t count it. Start the set for time and heart rate, then enter your reps.</div>';
    else if (ex && ex.note) h += '<div class="msg msg--good" style="margin-top:12px">' + esc(ex.note) + '</div>';
    h += '<div style="margin-top:14px"><button class="btn btn--go" data-act="start" data-testid="start-set">Start set</button></div>';
    if (S.sets.length) h += '<h2>Recent sets</h2><div class="card list" data-testid="sets">' + S.sets.slice(0, 6).map(function (s) {
      return '<div><b class="num" style="width:44px;font-size:22px">' + s.reps + '</b><div class="grow"><b>' + esc(s.name) + '</b><div class="small faint">' + esc(new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + ' · ' + mmss(s.seconds) + (s.hrAvg ? ' · ' + s.hrAvg + ' bpm avg' : '') + (s.detected != null && s.detected !== s.reps ? ' · band counted ' + s.detected : '') + '</div></div></div>';
    }).join('') + '</div>';
    return h;
  }
  function ringSvg(frac) {
    var c = 2 * Math.PI * 46;
    return '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="none" stroke="rgba(246,238,231,.08)" stroke-width="4"/><circle id="ringarc" cx="50" cy="50" r="46" fill="none" stroke="#FF7A1A" stroke-width="4" stroke-linecap="round" stroke-dasharray="' + (c * frac).toFixed(1) + ' ' + c.toFixed(1) + '"/></svg>';
  }
  function viewSetRun(st) {
    var countable = st.ex.countable;
    var h = '<div class="lab">' + esc(st.ex.name) + '</div><h1>' + (countable ? 'Lift' : 'Your set') + '</h1>';
    if (st.noMotion) h += '<div class="msg msg--warn" data-testid="no-motion">No motion from the band yet. Keep going and count in your head, you can fix the number at the end.</div>';
    h += '<div class="ring">' + ringSvg((st.reps % 10) / 10) + '<div class="pulse" id="pulse"></div><div class="mid">' +
      (countable ? '<div class="big" id="reps" data-testid="reps" aria-live="polite">' + st.reps + '</div><div class="unit">' + (st.reps === 1 ? 'rep' : 'reps') + '</div>' : '<div class="big" style="font-size:72px" id="clock">' + mmss((Date.now() - st.started) / 1000) + '</div><div class="unit">on the clock</div>') +
      '</div></div>';
    h += '<div class="card trio"><span class="kv"><em>Time</em><b class="num" id="t-time">' + mmss((Date.now() - st.started) / 1000) + '</b></span><span class="kv"><em>Heart</em><b class="num" id="t-hr" style="color:var(--heart)">' + (st.hr.length ? st.hr[st.hr.length - 1] : '–') + '</b></span><span class="kv"><em>Peak</em><b class="num" id="t-max">' + (st.hr.length ? Math.max.apply(null, st.hr) : '–') + '</b></span></div>';
    if (countable) h += '<div class="card"><div class="small faint">Wrist motion</div><canvas class="trace" id="trace"></canvas></div>';
    h += '<button class="btn btn--stop" data-act="stop" data-testid="stop-set">Stop set</button>';
    return h;
  }
  function viewSetDone(st) {
    var hrAvg = st.hr.length ? Math.round(st.hr.reduce(function (a, b) { return a + b; }, 0) / st.hr.length) : null;
    var h = '<div class="lab">' + esc(st.ex.name) + '</div><h1>Set done</h1>';
    h += '<div class="card"><div class="small faint" style="text-align:center;margin-bottom:8px">' + (st.ex.countable ? 'How many did you do?' : 'Enter your reps') + '</div>' +
      '<div class="stepper"><button data-act="adj" data-v="-1" aria-label="One fewer">−</button><output id="final" data-testid="final-reps">' + st.final + '</output><button data-act="adj" data-v="1" aria-label="One more">+</button></div>' +
      (st.ex.countable ? '<div class="small faint" style="text-align:center;margin-top:8px" data-testid="detected">The band counted ' + st.reps + '</div>' : '') + '</div>';
    h += '<div class="card trio"><span class="kv"><em>Time</em><b class="num">' + mmss(st.seconds) + '</b></span><span class="kv"><em>Avg heart</em><b class="num">' + (hrAvg || '–') + '</b></span><span class="kv"><em>Peak</em><b class="num">' + (st.hr.length ? Math.max.apply(null, st.hr) : '–') + '</b></span></div>';
    if (st.ex.countable) h += '<div class="card toggle"><div class="grow"><b>Help tune the counter</b><div class="small faint">Sends this set’s wrist motion with your number, so counting gets better.</div></div><button class="switch" role="switch" aria-checked="' + S.tune + '" data-act="tune" aria-label="Help tune the counter"></button></div>';
    h += '<button class="btn btn--go" data-act="save" data-testid="save-set">Save set</button><button class="btn" style="margin-top:10px" data-act="discard">Discard</button>';
    return h;
  }
  function startSet() {
    var ex = C.exercise(S.ex);
    var st = S.set = { phase: 'run', ex: ex, reps: 0, hr: [], started: Date.now(), counter: ex.countable ? new C.RepCounter(ex) : null, sig: [], samples: 0, noMotion: false };
    st.hrOff = B.on('hr', function (d) { if (S.set === st && d.bpm) { st.hr.push(d.bpm); var e = $('#t-hr'); if (e) e.textContent = d.bpm; var m = $('#t-max'); if (m) m.textContent = Math.max.apply(null, st.hr); } });
    st.tick = setInterval(function () {
      if (S.set !== st) return;
      var s = (Date.now() - st.started) / 1000, e = $('#t-time'); if (e) e.textContent = mmss(s); var c = $('#clock'); if (c) c.textContent = mmss(s);
      if (ex.countable && !st.samples && s > 6 && !st.noMotion) { st.noMotion = true; render(); }
    }, 250);
    render();
    startMotion(function (v) {
      if (S.set !== st || !st.counter) return;
      st.samples++; if (st.noMotion) { st.noMotion = false; render(); }
      st.sig.push(v); if (st.sig.length > 300) st.sig.shift();
      if (st.counter.push(v[0], v[1], v[2])) { st.reps++; rep(st); }
    }).catch(function () { st.noMotion = true; render(); });
    B.haptic('rigid');
  }
  function rep(st) {
    var e = $('#reps'); if (e) { e.textContent = st.reps; e.classList.remove('pop'); void e.offsetWidth; e.classList.add('pop'); var u = e.nextElementSibling; if (u) u.textContent = st.reps === 1 ? 'rep' : 'reps'; }
    var p = $('#pulse'); if (p) { p.classList.remove('go'); void p.offsetWidth; p.classList.add('go'); }
    var a = $('#ringarc'); if (a) { var c = 2 * Math.PI * 46; a.setAttribute('stroke-dasharray', (c * ((st.reps % 10) || 10) / 10).toFixed(1) + ' ' + c.toFixed(1)); }
    B.haptic('light'); beep(st.reps % 5 ? 880 : 1175);
  }
  var traceRaf = 0;
  function drawTrace() {
    if (traceRaf) return;
    var loop = function () {
      traceRaf = 0;
      var st = S.set, c = $('#trace'); if (!st || st.phase !== 'run' || !c) return;
      var r = c.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
      var g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
      var sig = st.sig; if (sig.length > 2) {
        ['#FF7A1A', '#4CD38A', '#7B6DFF'].forEach(function (col, a) {
          g.beginPath(); sig.forEach(function (v, i) { var x = i / 299 * r.width, y = r.height / 2 - (v[a] - sig[sig.length - 1][a] * 0) * r.height * 0.32; i ? g.lineTo(x, y) : g.moveTo(x, y); });
          g.strokeStyle = col; g.globalAlpha = 0.85; g.lineWidth = 1.4; g.stroke();
        });
        g.globalAlpha = 1;
      }
      traceRaf = requestAnimationFrame(loop);
    };
    traceRaf = requestAnimationFrame(loop);
  }
  function stopSet() {
    var st = S.set; if (!st) return;
    clearInterval(st.tick); if (st.hrOff) st.hrOff();
    st.seconds = (Date.now() - st.started) / 1000; st.final = st.reps; st.phase = 'done';
    stopMotion().then(function (m) { st.raw = m ? m.raw : []; st.meta = m ? { layout: m.layout, base: m.base, hz: Math.round(m.hz), frames: m.frames, crcBad: m.crcBad } : {}; });
    B.haptic('success'); render();
  }
  function saveSet() {
    var st = S.set; if (!st) return;
    var hrAvg = st.hr.length ? Math.round(st.hr.reduce(function (a, b) { return a + b; }, 0) / st.hr.length) : null;
    var rec = { at: st.started, ex: st.ex.id, name: st.ex.name, reps: st.final, detected: st.ex.countable ? st.reps : null, seconds: Math.round(st.seconds), hrAvg: hrAvg, hrMax: st.hr.length ? Math.max.apply(null, st.hr) : null };
    S.sets.unshift(rec); S.sets = S.sets.slice(0, 200); keep('lkb2.sets', S.sets);
    var send = st.ex.countable && S.tune && st.raw && st.raw.length;
    S.set = null;
    S.msg = ['good', rec.reps + ' ' + (rec.reps === 1 ? 'rep' : 'reps') + ' saved.'];
    if (send) {
      var frames = st.raw.slice(0, 19000).map(function (x) { return [x[0], x[2]]; });
      B.capture({ kind: 'liveset', exercise: rec.ex, counted: rec.reps, detected: rec.detected, startedAt: rec.at, seconds: rec.seconds, hr: st.hr.slice(0, 600), motion: st.meta, label: 'I did ' + rec.reps + ' reps of ' + rec.name.toLowerCase() }, frames)
        .then(function () { S.msg = ['good', rec.reps + ' ' + (rec.reps === 1 ? 'rep' : 'reps') + ' saved. Thanks, that helps the counter.']; render(); }, function () {});
    }
    render(); setTimeout(function () { if (S.msg && S.msg[0] === 'good') { S.msg = null; render(); } }, 4000);
  }

  // ---------- steps ----------
  function viewSteps() {
    var s = S.steps;
    var h = '<div class="lab">Experiment</div><h1>Steps</h1>';
    if (!s) return h + '<div class="card"><p class="muted" style="margin:0 0 14px">Walk with the band on and see if it counts like you do. Count your own steps, then compare.</p><button class="btn btn--go" data-act="steps-start" data-testid="steps-start">Start walking</button></div>';
    if (s.phase === 'run') return h + '<div class="ring">' + ringSvg(Math.min(1, s.count / 100)) + '<div class="mid"><div class="big" id="steps" data-testid="steps">' + s.count + '</div><div class="unit">steps</div><div class="sub" id="cad">' + (s.cad ? Math.round(s.cad) + ' a minute' : ' ') + '</div></div></div>' +
      '<button class="btn btn--stop" data-act="steps-stop" data-testid="steps-stop">Stop</button>';
    return h + '<div class="card"><div class="small faint" style="text-align:center;margin-bottom:8px">How many did you count?</div><div class="stepper"><button data-act="sadj" data-v="-1" aria-label="One fewer">−</button><output>' + s.final + '</output><button data-act="sadj" data-v="1" aria-label="One more">+</button></div>' +
      '<div class="small faint" style="text-align:center;margin-top:8px">The band counted ' + s.count + ' in ' + mmss(s.seconds) + '</div></div><button class="btn btn--go" data-act="steps-save">Save</button><button class="btn" style="margin-top:10px" data-act="steps-discard">Discard</button>';
  }
  function stepsStart() {
    var s = S.steps = { phase: 'run', count: 0, cad: 0, started: Date.now(), sc: new C.StepCounter() };
    render();
    startMotion(function (v) {
      if (S.steps !== s) return;
      var n = s.sc.push(v[0], v[1], v[2]);
      if (n) { s.count += n; s.cad = s.sc.cadence; var e = $('#steps'); if (e) e.textContent = s.count; var c = $('#cad'); if (c) c.textContent = Math.round(s.cad) + ' a minute'; }
    });
  }

  // ---------- lab ----------
  function viewLab() {
    var m = M, L = S.lab;
    var h = '<div class="lab">For working out the band</div><h1>Lab</h1>';
    h += '<div class="card"><div class="toggle"><div class="grow"><b>Motion stream</b><div class="small faint">Raw motion from the band, about twice a second. Turns itself off after 10 minutes.</div></div><button class="switch" role="switch" aria-checked="' + !!(m && L.motion) + '" data-act="lab-motion" aria-label="Motion stream" data-testid="lab-motion"></button></div>' +
      '<div class="toggle"><div class="grow"><b>Capture</b><div class="small faint">Saves everything the band sends while on, so the motion layout can be checked.</div></div><button class="switch" role="switch" aria-checked="' + L.capture + '" data-act="lab-capture" aria-label="Capture" data-testid="lab-capture"></button></div>' +
      '<input id="caplabel" placeholder="What you are doing, e.g. 10 curls" style="width:100%;height:46px;border-radius:12px;border:1px solid var(--line);background:rgba(246,238,231,.05);color:var(--text);font:16px var(--sans);padding:0 12px;margin-top:6px" value="' + esc(L.label || '') + '"></div>';
    h += '<h2>What the band sends</h2><div class="card mono" data-testid="lab-stats" id="labstats">' + labStats() + '</div>';
    if (B.mode === 'native') h += '<h2>On this phone</h2><div class="card mono" id="phonelog" data-testid="lab-log">' + esc((S.lab.log || []).slice(-30).join('\n')).replace(/\n/g, '<br>') + '</div>';
    h += '<div class="small faint" style="text-align:center">Page ' + VERSION + ' · ' + esc(B.mode) + (S.status.version ? ' · app ' + esc(S.status.version) : '') + '</div>';
    return h;
  }
  function labStats() {
    var m = M, L = S.lab;
    if (!m) return 'Motion stream is off.' + (L.sent ? '<br>Captured and sent: ' + L.sent + ' pieces.' : '');
    var unk = Object.keys(m.P.unknown).map(function (k) { return k + ' ×' + m.P.unknown[k]; }).join(', ') || 'none';
    return 'frames ' + m.frames + ' · layout ' + (m.layout || 'none yet') + (m.base != null ? ' (offset ' + m.base + ')' : '') + '<br>rate ' + (m.hz ? m.hz.toFixed(0) + ' samples/s' : '–') + ' · checksum failed ' + m.crcBad +
      '<br>packets ok ' + m.R.stats.ok + ' · cut by length ' + m.R.stats.tolerant + ' · bytes dropped ' + m.R.stats.dropped +
      '<br>history motion (v25) ' + m.v25 + (m.v25last ? ' · mean size, interleaved ' + Math.round(m.v25last.interleavedMag) + ' / planar ' + Math.round(m.v25last.planarMag) : '') +
      '<br>unknown: ' + esc(unk) + (m.P.log.length ? '<br>last unknown: ' + esc(m.P.log[m.P.log.length - 1].head) : '') + (L.capture ? '<br>capturing: ' + (L.frames.length + L.sent) + ' pieces' : '');
  }
  var capOff = null, capTimer = 0;
  function setCapture(v) {
    S.lab.capture = v;
    if (capOff) { capOff(); capOff = null; }
    clearInterval(capTimer);
    if (v) {
      B.subscribe(['0003', '0004', '0005', '0007']);
      S.lab.started = Date.now();
      capOff = B.on('raw', function (d) { d.items.forEach(function (it) { S.lab.frames.push([it[0], it[2]]); }); if (S.lab.frames.length >= 600) shipCapture(); });
      capTimer = setInterval(shipCapture, 120000);
    } else { shipCapture(); if (!M) B.subscribe([]); }
  }
  function shipCapture() {
    var f = S.lab.frames; if (!f.length) return;
    S.lab.frames = [];
    var lbl = ($('#caplabel') || {}).value || S.lab.label || '';
    B.capture({ kind: 'lab', label: lbl, startedAt: S.lab.started, seconds: Math.round((Date.now() - S.lab.started) / 1000), motion: M ? { layout: M.layout, base: M.base, hz: Math.round(M.hz) } : null }, f)
      .then(function () { S.lab.sent += f.length; if (S.tab === 'lab') { var e = $('#labstats'); if (e) e.innerHTML = labStats(); } }, function () { S.lab.frames = f.concat(S.lab.frames).slice(0, 5000); });
  }
  setInterval(function () {
    if (S.tab !== 'lab') return;
    var e = $('#labstats'); if (e) e.innerHTML = labStats();
    if (B.mode === 'native' && !(Date.now() % 5000 < 1000)) return;
    if (B.mode === 'native') B.stored('log').then(function (d) { S.lab.log = (d && d.lines) || []; var l = $('#phonelog'); if (l) l.innerHTML = esc(S.lab.log.slice(-30).join('\n')).replace(/\n/g, '<br>'); }, function () {});
  }, 1000);

  // ---------- events ----------
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-tab],[data-act]'); if (!t) return;
    if (t.dataset.tab) {
      if (S.set && S.set.phase === 'run' && t.dataset.tab !== 'lift') return;   // a running set keeps the screen
      S.tab = t.dataset.tab; keep('lkb2.tab', S.tab); S.msg = null; render(); window.scrollTo(0, 0); return;
    }
    var a = t.dataset.act, v = t.dataset.v;
    if (a === 'scan') B.scan();
    if (a === 'pick') B.pick(v);
    if (a === 'link') {
      var code = (($('#code') || {}).value || '').replace(/\D/g, '');
      if (code.length !== 6) { S.msg = ['warn', 'The code is six digits. Make one in LOCKED.']; render(); return; }
      B.pair(code).then(function () { S.msg = ['good', 'Linked to LOCKED.']; B.status().then(function (st) { S.status = st; render(); refresh(true); }); },
        function () { S.msg = ['bad', 'That code didn\u2019t work. Make a new one in LOCKED.']; render(); });
    }
    if (a === 'connect') B.connect().catch(function () { S.msg = ['warn', 'Couldn’t reach your band. Keep it close and try again.']; render(); });
    if (a === 'sync') B.sync().then(function () { refresh(true); }, function () { S.msg = ['warn', 'Sync stopped. What arrived is saved.']; render(); });
    if (a === 'night') { S.nightIdx = Number(v); render(); }
    if (a === 'ex') { S.ex = v; keep('lkb2.ex', v); render(); }
    if (a === 'start') startSet();
    if (a === 'stop') stopSet();
    if (a === 'adj' && S.set) { S.set.final = Math.max(0, S.set.final + Number(v)); $('#final').textContent = S.set.final; }
    if (a === 'tune') { S.tune = !S.tune; keep('lkb2.tune', S.tune); t.setAttribute('aria-checked', S.tune); }
    if (a === 'save') saveSet();
    if (a === 'discard') { S.set = null; render(); }
    if (a === 'steps-start') stepsStart();
    if (a === 'steps-stop' && S.steps) { S.steps.phase = 'done'; S.steps.final = S.steps.count; S.steps.seconds = (Date.now() - S.steps.started) / 1000; stopMotion().then(function (m) { if (S.steps) S.steps.raw = m ? m.raw : []; }); render(); }
    if (a === 'sadj' && S.steps) { S.steps.final = Math.max(0, S.steps.final + Number(v)); render(); }
    if (a === 'steps-save' && S.steps) {
      var s = S.steps; S.steps = null; S.msg = ['good', 'Saved. Thanks, that helps the step counter.'];
      if (s.raw && s.raw.length) B.capture({ kind: 'steps', counted: s.final, detected: s.count, startedAt: s.started, seconds: Math.round(s.seconds), label: 'I walked ' + s.final + ' steps' }, s.raw.slice(0, 19000).map(function (x) { return [x[0], x[2]]; })).catch(function () {});
      render();
    }
    if (a === 'steps-discard') { S.steps = null; render(); }
    if (a === 'lab-motion') { if (M) { S.lab.motion = false; stopMotion().then(render); } else { S.lab.motion = true; startMotion(null).then(render, render); render(); } }
    if (a === 'lab-capture') { S.lab.label = ($('#caplabel') || {}).value || ''; setCapture(!S.lab.capture); render(); }
  });

  // ---------- live feed ----------
  B.on('status', function (st) { S.status = Object.assign({}, S.status, st); if (S.tab === 'today' && !(S.set && S.set.phase === 'run')) render(); });
  B.on('hr', function (d) {
    if (!d.bpm) return;
    S.status.bpm = d.bpm;
    var mk = Math.floor(d.t / 60000) * 60000, last = S.hrLive[S.hrLive.length - 1];
    if (last && last[0] === mk) { last[2] += d.bpm; last[3]++; last[1] = Math.round(last[2] / last[3]); } else S.hrLive.push([mk, d.bpm, d.bpm, 1]);
    if (S.hrLive.length > 1500) S.hrLive.shift();
    var e = $('[data-testid="live-bpm"]'); if (e && e.lastChild) e.childNodes[1].textContent = d.bpm;
  });
  /* a new page version is on the phone: take it now unless something is running */
  function busy() { return (S.set && S.set.phase !== 'pick') || (S.steps && S.steps.phase === 'run') || !!M; }
  B.on('update', function () { if (!busy()) location.reload(); else S.updateReady = true; });
  setInterval(function () { if (S.updateReady && !busy()) location.reload(); }, 5000);
  document.addEventListener('visibilitychange', function () { if (document.hidden && M && !(S.set && S.set.phase === 'run')) stopMotion(); });
  window.addEventListener('pagehide', function () { if (M) stopMotion(); if (S.lab.capture) shipCapture(); });

  B.status().then(function (st) { S.status = st || {}; render(); });
  render(); refresh();
  setInterval(function () { refresh(); }, 5 * 60000);
  window.__app = { S: S, render: render, motion: function () { return M; } };
})();
