/* LOCKED Band (web). Does the Band iPhone app's job from a browser that can use Bluetooth (Bluefy on iPhone).
   Reads the WHOOP 4.0's own stored history (one record a second: heart rate, beat-to-beat timing) and sends it
   to LOCKED, where the same engine as the app scores sleep, recovery, strain and calories.

   Band protocol (WHOOP 4.0, as documented by OpenStrap, our own decoder):
     frame   = [AA][u16 len][crc8(len)][inner padded to 4][crc32(inner)]
     command = inner [23][seq][opcode][args...]   reply = [24][seq][opcode][?][status]...
     history : SEND_HISTORICAL_DATA 0x16 [00] -> records 0x2F (v24: u32 secs @7, HR @17, rr count @18, rr int16 @19)
               batches end with METADATA 0x31 sub 2 (token = inner[13..21]) -> ack 0x17 [01 + token] -> next batch
               METADATA sub 3 = all sent. A batch is acked ONLY after LOCKED saved it, so nothing is lost.
   Commands this page sends: reads (hello, name, data range, alarm, clock), heart-rate broadcast on, both motion
   streams off, history start, history ack. Nothing that erases, trims by hand, reboots or changes settings. */
(function () {
  'use strict';
  var SUPA = 'https://fwimdnukebbrwpwdyjbv.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3aW1kbnVrZWJicndwd2R5amJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyMDI5MjEsImV4cCI6MjA5Mzc3ODkyMX0.WCSGk0I1yDkqcH8e0cfzEExQDmD7pd7JUhFn7soQ8E4';
  var FN = SUPA + '/functions/v1/band-web';
  var SVC = '61080001-8d6d-82b8-614a-1c8cb0f8dcc6', CMD = '61080002-8d6d-82b8-614a-1c8cb0f8dcc6';
  var LISTEN = ['61080003-8d6d-82b8-614a-1c8cb0f8dcc6', '61080004-8d6d-82b8-614a-1c8cb0f8dcc6', '61080005-8d6d-82b8-614a-1c8cb0f8dcc6', '61080007-8d6d-82b8-614a-1c8cb0f8dcc6'];
  var SKEY = 'lkband.session', LAST = 'lkband.last';
  var NIGHT_EVERY = 15 * 60 * 1000;

  // ---------- frames ----------
  function crc8(b) { var c = 0; for (var i = 0; i < b.length; i++) { c ^= b[i]; for (var k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; } return c; }
  var T = (function () { var t = new Uint32Array(256); for (var i = 0; i < 256; i++) { var c = i; for (var k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  var seq = 0;
  function packet(op, args) {
    seq = (seq + 1) & 0xff;
    var p = [0x23, seq, op].concat(args || []);
    while (p.length % 4) p.push(0);
    var len = p.length + 4, lb = [len & 0xff, len >> 8], c = crc32(p);
    return new Uint8Array([0xAA].concat(lb, [crc8(lb)], p, [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff]));
  }
  function Reassembler() { this.buf = []; }
  Reassembler.prototype.feed = function (bytes) {
    var buf = this.buf, out = [];
    for (var i = 0; i < bytes.length; i++) buf.push(bytes[i]);
    for (;;) {
      var s = buf.indexOf(0xAA); if (s < 0) { buf.length = 0; break; } if (s > 0) buf.splice(0, s);
      if (buf.length < 4) break;
      if (crc8([buf[1], buf[2]]) !== buf[3]) { buf.shift(); continue; }
      var len = buf[1] | (buf[2] << 8);
      if (len < 5 || len > 4096) { buf.shift(); continue; }
      var total = 4 + len; if (buf.length < total) break;
      var inner = buf.slice(4, total - 4);
      var got = (buf[total - 4] | (buf[total - 3] << 8) | (buf[total - 2] << 16) | (buf[total - 1] << 24)) >>> 0;
      if (crc32(inner) === got) { out.push(inner); buf.splice(0, total); } else buf.shift();
    }
    if (buf.length > 16384) buf.length = 0;
    return out;
  };
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function i16(b, o) { var v = b[o] | (b[o + 1] << 8); return v & 0x8000 ? v - 0x10000 : v; }
  var HR_AT = { 7: 27, 9: 17, 12: 17, 18: 14, 24: 17 };

  // ---------- state ----------
  var S = {
    view: 'boot', msg: null, email: '', usePw: false, busy: false,
    dev: null, cmd: null, name: '', battery: null, bpm: null, connected: false,
    sync: null, last: null, night: false, nightTimer: null, lock: null, clockOff: 0
  };
  try { S.last = JSON.parse(localStorage.getItem(LAST) || 'null'); } catch (e) {}
  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');

  // ---------- account ----------
  function session() {
    try { var s = JSON.parse(localStorage.getItem(SKEY) || 'null'); if (s && s.access_token) return s; } catch (e) {}
    // inside LOCKED itself: its own sign-in, while it is still fresh
    try {
      var l = JSON.parse(localStorage.getItem('lk_session') || 'null');
      if (l && l.access_token && (!l.expires_at || l.expires_at * 1000 > Date.now() + 120000)) return { access_token: l.access_token, expires_at: l.expires_at, borrowed: true };
    } catch (e) {}
    return null;
  }
  function keep(d) {
    var s = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600), email: d.user && d.user.email };
    try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch (e) {}
    return s;
  }
  function auth(path, body) {
    return fetch(SUPA + '/auth/v1/' + path, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); });
  }
  function token() {
    var s = session(); if (!s) return Promise.resolve(null);
    if (!s.expires_at || s.expires_at * 1000 > Date.now() + 90000 || !s.refresh_token) return Promise.resolve(s.access_token);
    return auth('token?grant_type=refresh_token', { refresh_token: s.refresh_token }).then(function (r) {
      if (r.ok && r.j.access_token) return keep(r.j).access_token;
      try { localStorage.removeItem(SKEY); } catch (e) {}
      return null;
    });
  }
  function api(body) {
    return token().then(function (t) {
      if (!t) throw { code: 'signed_out' };
      return fetch(FN, { method: 'POST', headers: { apikey: ANON, authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw { code: j.error || 'http_' + r.status }; return j; }); },
          function () { throw { code: 'offline' }; });
    });
  }

  // ---------- views ----------
  function render() {
    var v = S.view, h = '';
    if (v === 'boot') h = '';
    else if (v === 'nobt') {
      h = '<div class="view"><div class="top"><div class="lab">LOCKED · Band</div><h1>Open this in Bluefy</h1><p class="sub">Safari can\'t talk to your band. Bluefy is a free browser that can.</p></div>' +
        '<div class="card"><ol class="steps"><li><i>1</i><span>Get <b>Bluefy – Web BLE Browser</b> from the App Store.</span></li><li><i>2</i><span>Open this page in it.</span></li></ol></div>' +
        '<div class="copyrow" id="url">' + esc(location.href) + '</div><button class="btn btn--soft" id="copy">Copy link</button></div>';
    } else if (v === 'signin') {
      h = '<div class="view"><div class="top"><div class="lab">LOCKED · Band</div><h1>Sign in to LOCKED</h1><p class="sub">Your band\'s data goes to your LOCKED account.</p></div>' +
        '<form class="card form" id="f1" novalidate><label for="em">Email</label><input id="em" type="email" autocomplete="email" inputmode="email" autocapitalize="off" value="' + esc(S.email) + '" placeholder="you@example.com">' +
        (S.usePw ? '<label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password">' : '') + '</form>' + msg() +
        '<div class="spacer"></div><button class="btn btn--go" id="go"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'One moment…' : S.usePw ? 'Sign in' : 'Email me a code') + '</button>' +
        '<button class="link" id="mode">' + (S.usePw ? 'Use a code instead' : 'Use my password instead') + '</button></div>';
    } else if (v === 'code') {
      h = '<div class="view"><div class="top"><div class="lab">LOCKED · Band</div><h1>Check your email</h1><p class="sub">We emailed <b>' + esc(S.email) + '</b>. Type the six-digit code. If the email has a sign-in link instead, don\'t open it: press and hold it, tap Copy Link, and paste it here.</p></div>' +
        '<form class="card form" id="f2" novalidate><label for="cd">Code or link</label><input id="cd" autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="123456 or paste the link"></form>' + msg() +
        '<div class="spacer"></div><button class="btn btn--go" id="verify"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Checking…' : 'Sign in') + '</button><button class="link" id="back">Use a different email</button></div>';
    } else if (v === 'connect') {
      h = '<div class="view"><div class="top"><div class="lab">LOCKED · Band</div><h1>Connect your band</h1><p class="sub">Your band keeps everything it measured. This fills LOCKED in, from the last time it synced.</p></div>' +
        '<div class="card"><ol class="steps"><li><i>1</i><span>Close the Band app if it\'s open.</span></li><li><i>2</i><span>Tap <b>Connect</b> and pick your WHOOP.</span></li>' +
        '<li><i>3</i><span>Not in the list? Take it off, then tap the top <b>hard with two fingers</b> until the side light pulses blue, and try again.</span></li></ol></div>' + msg() +
        '<div class="spacer"></div><button class="btn btn--go" id="conn">Connect</button><button class="link" id="all">Show every device</button>' +
        '<button class="link link--quiet" id="out">Sign out</button></div>';
    } else if (v === 'connecting') {
      h = '<div class="view center"><div class="spin"></div><div class="lab">Connecting</div><p class="sub">Keep your band close to your phone.</p></div>';
    } else if (v === 'main') {
      h = '<div class="view"><div class="top"><div class="lab">LOCKED · Band</div></div>' + bandCard() + syncCard() + msg() +
        '<div class="spacer"></div>' +
        '<button class="btn btn--go" id="sync"' + (S.sync && S.sync.running ? ' disabled' : '') + '>' + (S.sync && S.sync.running ? 'Syncing…' : 'Sync now') + '</button>' +
        '<button class="btn btn--soft" id="night">Record tonight</button>' +
        '<p class="foot">Record tonight keeps the screen on and syncs every 15 minutes. Plug your phone in.</p>' +
        '<a class="link" href="' + lockedUrl() + '">Open LOCKED</a></div>';
    } else if (v === 'night') {
      h = '<div class="nightv" id="wake"><div class="nclock" id="nclock">' + clock(new Date()) + '</div>' +
        '<div class="nline"><span class="ndot' + (S.connected ? '' : ' off') + '"></span><span id="nstat">' + nightStatus() + '</span></div>' +
        '<div class="nbpm" id="nbpm">' + (S.bpm ? S.bpm + ' bpm' : '') + '</div><div class="nhint">Tap to wake</div></div>';
    }
    app.innerHTML = h;
    bind();
  }
  function lockedUrl() { return /locked/.test(location.host) ? '/' : 'https://locked-seven.vercel.app/'; }
  function msg() { return S.msg ? '<div class="msg msg--' + S.msg[0] + '" role="status">' + S.msg[1] + (S.detail ? '<div class="diag">' + esc(S.detail) + '</div>' : '') + '</div>' : ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clock(d) { var h = d.getHours(), m = d.getMinutes(); return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m; }
  function when(ms) {
    if (!ms) return '';
    var d = new Date(ms), now = new Date(), t = clock(d) + (d.getHours() < 12 ? ' am' : ' pm');
    if (d.toDateString() === now.toDateString()) return t;
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'yesterday ' + t;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + t;
  }
  function dur(sec) { var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return h ? h + ' h ' + m + ' m' : m + ' m'; }
  function bandCard() {
    return '<div class="card band"><span class="dot' + (S.connected ? '' : ' off') + '"></span><div class="bmeta"><b>' + esc(S.name || 'WHOOP') + '</b><span>' +
      (S.connected ? 'Connected' : 'Not connected') + (S.battery != null ? ' · ' + S.battery + '% battery' : '') + '</span></div>' +
      '<div class="hr"' + (S.bpm ? '' : ' hidden') + ' id="hrbox"><b id="bpm">' + (S.bpm || '') + '</b><span>bpm</span></div></div>';
  }
  function syncCard() {
    var s = S.sync;
    if (s && s.running) {
      var got = s.secs ? dur(s.secs) : '';
      return '<div class="card sync"><div class="lab" style="color:var(--accent)">Getting your band\'s history</div>' +
        '<div class="bar"><i id="barf" style="width:' + Math.round((s.pct || 0.04) * 100) + '%"></i></div>' +
        '<div class="sline"><span id="sgot">' + (got ? got + ' received' : 'Starting…') + '</span><span id="ssaved">' + (s.savedTo ? 'saved to ' + when(s.savedTo) : '') + '</span></div></div>';
    }
    if (S.last && S.last.to) {
      return '<div class="card sync"><div class="lab">Up to date</div><div class="big">' + when(S.last.to) + '</div>' +
        '<div class="sline"><span>Last synced ' + when(S.last.at) + '</span><span>' + (S.last.secs ? dur(S.last.secs) + ' added' : '') + '</span></div></div>';
    }
    return '<div class="card sync"><div class="lab">Not synced yet</div><p class="sub" style="margin:6px 0 0">Tap Sync now. The first one can take a few minutes if the band has days to catch up on.</p></div>';
  }
  function nightStatus() {
    if (S.sync && S.sync.running) return 'Syncing';
    if (!S.connected) return 'Band not connected';
    return S.last && S.last.at ? 'Recording · synced ' + when(S.last.at) : 'Recording';
  }

  function bind() {
    on('copy', 'click', function () { var t = location.href; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { $('copy').textContent = 'Copied'; }, function () {}); });
    on('go', 'click', signIn); on('f1', 'submit', function (e) { e.preventDefault(); signIn(); });
    on('mode', 'click', function () { S.usePw = !S.usePw; S.msg = null; keepEmail(); render(); });
    on('verify', 'click', verify); on('f2', 'submit', function (e) { e.preventDefault(); verify(); });
    on('cd', 'input', function (e) { var v = e.target.value.trim(); if (/^\d{6}$/.test(v) || /token=|access_token=/.test(v)) verify(); });
    on('back', 'click', function () { S.view = 'signin'; S.msg = null; render(); });
    on('conn', 'click', function () { connect(false); }); on('all', 'click', function () { connect(true); });
    on('out', 'click', function () { try { localStorage.removeItem(SKEY); } catch (e) {} S.view = 'signin'; S.msg = null; render(); });
    on('sync', 'click', function () { startSync(); });
    on('night', 'click', nightOn);
    on('wake', 'click', nightOff);
  }
  function on(id, ev, f) { var e = $(id); if (e) e.addEventListener(ev, f); }
  function keepEmail() { var e = $('em'); if (e) S.email = e.value.trim(); }

  // ---------- sign in ----------
  function signIn() {
    keepEmail();
    if (!/^\S+@\S+\.\S+$/.test(S.email)) { S.msg = ['bad', 'Enter the email you use for LOCKED.']; return render(); }
    S.busy = true; S.msg = null; render();
    if (S.usePw) {
      var pw = ($('pw') || {}).value || '';
      return auth('token?grant_type=password', { email: S.email, password: pw }).then(function (r) {
        S.busy = false;
        if (r.ok && r.j.access_token) { keep(r.j); return afterSignIn(); }
        S.msg = ['bad', r.status === 429 ? 'Too many tries. Wait a minute, or use a code.' : 'That email and password don\'t match. If you never set a password, use a code.']; render();
      }, net);
    }
    auth('otp', { email: S.email, create_user: false }).then(function (r) {
      S.busy = false;
      if (r.ok) { S.view = 'code'; S.msg = null; render(); var c = $('cd'); if (c) c.focus(); return; }
      S.msg = ['bad', r.status === 429 ? 'That\'s a lot of codes. Wait a minute, then try again.' : 'No LOCKED account uses that email.']; render();
    }, net);
  }
  // A pasted link works too: the email's own link (token in it) or the page it opened (session in it).
  function fromLink(t) {
    var m = /[#&?]access_token=([^&]+)/.exec(t), rt = /[#&?]refresh_token=([^&]+)/.exec(t), ex = /[#&?]expires_in=(\d+)/.exec(t);
    if (m) return { session: { access_token: decodeURIComponent(m[1]), refresh_token: rt ? decodeURIComponent(rt[1]) : null, expires_in: ex ? +ex[1] : 3600 } };
    var tk = /[?&]token(?:_hash)?=([^&#]+)/.exec(t), ty = /[?&]type=([^&#]+)/.exec(t);
    if (tk) return { hash: decodeURIComponent(tk[1]), type: ty ? decodeURIComponent(ty[1]) : 'magiclink' };
    return null;
  }
  function verify() {
    var c = (($('cd') || {}).value || '').trim();
    var L = /^\d{6}$/.test(c) ? null : fromLink(c);
    if (L && L.session) { keep(L.session); return afterSignIn(); }
    if (!L && !/^\d{6}$/.test(c)) { S.msg = ['bad', 'Type the six-digit code, or paste the whole link from the email.']; return render(); }
    S.busy = true; S.msg = null; render();
    auth('verify', L ? { type: L.type === 'signup' ? 'signup' : 'magiclink', token_hash: L.hash } : { type: 'email', email: S.email, token: c }).then(function (r) {
      S.busy = false;
      if (r.ok && r.j.access_token) { keep(r.j); return afterSignIn(); }
      S.msg = ['bad', L ? 'That link has expired or was already used. Go back, get a new one, and paste it without opening it.' : 'That code didn\'t work. Check it, or go back and get a new one.']; render();
    }, net);
  }
  function net() { S.busy = false; S.msg = ['bad', 'No connection. Check your signal and try again.']; render(); }
  function afterSignIn() {
    api({ action: 'status' }).then(function (j) {
      if (j.band && !j.band.linked) S.msg = ['warn', 'Your account has no band set up yet. Set it up in LOCKED (Profile, then Wearables) once, then come back.'];
      if (j.band && j.band.last_minute && !(S.last && S.last.to)) S.last = { to: Date.parse(j.band.last_minute) + 60000, at: j.band.last_sync ? Date.parse(j.band.last_sync) : null };
      S.view = 'connect'; render();
    }, function (e) { if (e.code === 'signed_out') { S.view = 'signin'; return render(); } S.view = 'connect'; render(); });
  }

  // ---------- band ----------
  var pending = {}, reasm = {};
  function send(op, args, wait) {
    var c = S.cmd; if (!c) return Promise.resolve(null);
    var p = packet(op, args), sq = seq;
    var w = c.properties && c.properties.write && c.writeValueWithResponse ? c.writeValueWithResponse(p)
      : c.writeValueWithoutResponse ? c.writeValueWithoutResponse(p) : c.writeValue(p);
    if (!wait) return w.then(function () { return null; }, function () { return null; });
    return new Promise(function (res) {
      pending[sq] = res;
      setTimeout(function () { if (pending[sq]) { delete pending[sq]; res(null); } }, 2000);
      w.catch(function () { if (pending[sq]) { delete pending[sq]; res(null); } });
    });
  }
  function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function connect(all) {
    S.msg = null;
    var opt = all ? { acceptAllDevices: true, optionalServices: [SVC, 'heart_rate', 'battery_service'] }
      : { filters: [{ services: [SVC] }, { namePrefix: 'WHOOP' }, { namePrefix: 'Whoop' }], optionalServices: [SVC, 'heart_rate', 'battery_service'] };
    navigator.bluetooth.requestDevice(opt).then(function (d) {
      S.dev = d; S.name = d.name || 'WHOOP'; S.view = 'connecting'; render();
      d.addEventListener('gattserverdisconnected', lost);
      return link();
    }).then(function () {
      S.view = 'main'; render();
      startSync();
    }).catch(function (e) {
      if (e && e.name === 'NotFoundError') { S.view = 'connect'; return render(); }
      S.view = 'connect';
      S.msg = ['bad', 'Couldn\'t connect. Take the band off, tap the top hard with two fingers until the side light pulses blue, then tap Connect again.'];
      render();
    });
  }
  function link() {
    return S.dev.gatt.connect().then(function (g) {
      return g.getPrimaryService(SVC).then(function (svc) {
        return Promise.all([svc.getCharacteristic(CMD)].concat(LISTEN.map(function (u) { return svc.getCharacteristic(u).catch(function () { return null; }); })));
      }).then(function (cs) {
        S.cmd = cs[0];
        return Promise.all(cs.slice(1).map(function (ch, i) {
          if (!ch) return null;
          var u = LISTEN[i]; reasm[u] = new Reassembler();
          ch.addEventListener('characteristicvaluechanged', function (e) { onData(u, e.target.value); });
          return ch.startNotifications().catch(function () {});
        }));
      }).then(function () {
        S.connected = true;
        extras(g);
        // safe settings first: both motion streams off, live heart rate on
        return send(0x6A, [0]).then(function () { return send(0x3F, [0]); }).then(function () { return send(0x0E, [1]); })
          .then(function () { return send(0x0B, [], true); }).then(function (r) {
            if (r && r.length >= 9) { var sec = u32(r, 5); if (sec > 1.6e9 && sec < 2.2e9) { var off = Date.now() - sec * 1000; S.clockOff = Math.abs(off) > 60000 ? off : 0; } }
          });
      });
    });
  }
  function extras(g) {
    g.getPrimaryService('battery_service').then(function (s) { return s.getCharacteristic('battery_level'); }).then(function (c) { return c.readValue(); })
      .then(function (v) { S.battery = v.getUint8(0); if (S.view === 'main') render(); }).catch(function () {});
    g.getPrimaryService('heart_rate').then(function (s) { return s.getCharacteristic('heart_rate_measurement'); }).then(function (c) {
      c.addEventListener('characteristicvaluechanged', function (e) {
        var d = e.target.value, f = d.getUint8(0), bpm = (f & 1) ? d.getUint16(1, true) : d.getUint8(1);
        if (bpm > 25 && bpm < 240) { S.bpm = bpm; var a = $('bpm'), b = $('hrbox'), n = $('nbpm'); if (a) a.textContent = bpm; if (b) b.hidden = false; if (n) n.textContent = bpm + ' bpm'; }
      });
      return c.startNotifications();
    }).catch(function () {});
  }
  function lost() {
    S.connected = false; S.cmd = null;
    if (S.sync && S.sync.running) endSync(false, ['warn', 'Your band disconnected. What was already saved is in LOCKED; the rest stays on the band for next time.']);
    if (S.night) { var s = $('nstat'); if (s) s.textContent = nightStatus(); retryLink(); }
    else if (S.view === 'main') render();
  }
  function retryLink() {
    if (!S.night || S.connected || !S.dev) return;
    setTimeout(function () { if (S.night && !S.connected) link().then(function () { var s = $('nstat'); if (s) s.textContent = nightStatus(); }, retryLink); }, 20000);
  }

  // ---------- history ----------
  // what the band said, for a sync that gets nothing
  var DG = { replies: [], types: {}, raw: [] };
  function hx(a, n) { var s = ''; for (var i = 0; i < Math.min(a.length, n); i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16); return s; }
  function onData(u, v) {
    var b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength), pk = reasm[u].feed(b);
    for (var i = 0; i < pk.length; i++) {
      var q = pk[i], k = u.slice(7, 8) + ':' + hx([q[0]], 1);
      DG.types[k] = (DG.types[k] || 0) + 1;
      if (q[0] === 0x24) DG.replies.push(hx([q[2]], 1) + '=' + (q.length > 4 ? q[4] : '?'));
      if (DG.raw.length < 60 && q[0] !== 0x2F) DG.raw.push([Date.now(), u.slice(7, 8) + hx(q, 200)]);
      if (q[0] === 0x24 && pending[q[1]]) { var f = pending[q[1]]; delete pending[q[1]]; f(q); continue; }
      if (!S.sync || !S.sync.running) continue;
      if (q[0] === 0x2F) record(q);
      else if (q[0] === 0x31) meta(q);
    }
  }
  function record(q) {
    var s = S.sync; s.seen = Date.now();
    var ver = q[1], at = HR_AT[ver];
    if (at == null || q.length < Math.max(at + 1, 20)) return;
    var hr = q[at], t = u32(q, 7) * 1000 + S.clockOff;
    if (!(t > Date.now() - 30 * 864e5 && t < Date.now() + 36e5)) return;
    if (hr && (hr < 25 || hr > 230)) hr = 0;
    var mk = Math.floor(t / 60000) * 60000, m = s.mins[mk];
    if (!m) { m = s.mins[mk] = { bpm: new Array(60).fill(0), rr: [] }; }
    m.bpm[Math.floor(t / 1000) % 60] = hr;
    if ((ver === 24 || ver === 12) && q[18] <= 4) for (var i = 0; i < q[18] && 19 + 2 * i + 2 <= q.length; i++) { var r = i16(q, 19 + 2 * i); if (r >= 250 && r <= 2500) m.rr.push(r); }
    s.n++; if (!s.first || t < s.first) s.first = t; if (!s.lastT || t > s.lastT) s.lastT = t;
    if (s.n % 120 === 0) progress();
  }
  function meta(q) {
    var s = S.sync, sub = q[2]; s.seen = Date.now();
    if (sub === 2 && q.length >= 21) {
      var tok = q.slice(13, 21);
      s.chain = s.chain.then(function () { return flush(false); }).then(function (ok) {
        if (ok) return send(0x17, [0x01].concat(tok));
        endSync(false, ['bad', 'Couldn\'t save to LOCKED just now. Nothing is lost: your band keeps it until the next sync.']);
      });
    } else if (sub === 3) {
      s.chain = s.chain.then(function () { return flush(true); }).then(function (ok) { endSync(ok); });
    }
  }
  function startSync() {
    if (!S.cmd || (S.sync && S.sync.running)) return;
    S.msg = null; S.detail = null; DG = { replies: [], types: {}, raw: [] };
    S.sync = { running: true, mins: {}, n: 0, secs: 0, first: 0, lastT: 0, savedTo: 0, days: {}, seen: Date.now(), chain: Promise.resolve(), started: Date.now() };
    if (S.view === 'main') render();
    var s = S.sync;
    send(0x23, [0], true).then(function () { return pause(120); }).then(function () { return send(0x4C, [0], true); })
      .then(function () { return pause(120); }).then(function () { return send(0x22, [0], true); })
      .then(function () { return pause(120); }).then(function () { return send(0x43, [1], true); })
      .then(function () { return pause(120); }).then(function () { return send(0x16, [0], true); });
    (function watch() {
      if (S.sync !== s || !s.running) return;
      // the band went quiet: whatever arrived is saved (but not acked, so it comes again next time)
      if (Date.now() - s.seen > 25000) {
        if (!s.n) return endSync(false, ['warn', 'Your band didn\'t send its history. What it did say went to Claude to work out why.']);
        s.chain.then(function () { return flush(true); }).then(function (ok) { endSync(ok); }); return;
      }
      setTimeout(watch, 2000);
    })();
  }
  function progress() {
    var s = S.sync; if (!s) return;
    s.secs = s.n;
    var span = s.lastT && s.first ? (s.lastT - s.first) : 0, sinceLast = s.first && S.last && S.last.to ? Date.now() - Math.min(S.last.to, s.first) : 0;
    s.pct = sinceLast ? Math.min(0.97, span / sinceLast) : Math.min(0.9, s.n / 86400);
    var g = $('sgot'), f = $('barf'), sv = $('ssaved');
    if (g) g.textContent = dur(s.secs) + ' received';
    if (f) f.style.width = Math.round(Math.max(0.04, s.pct) * 100) + '%';
    if (sv) sv.textContent = s.savedTo ? 'saved to ' + when(s.savedTo) : '';
  }
  function tz() { return -new Date().getTimezoneOffset(); }
  function dayOf(ms) { var d = new Date(ms); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  // Sends every finished minute (and, at the end, every minute) to LOCKED in chunks. Resolves true when all saved.
  function flush(final) {
    var s = S.sync, keys = Object.keys(s.mins).map(Number).sort(function (a, b) { return a - b; });
    if (!keys.length) return final ? score(s) : Promise.resolve(true);
    var rows = keys.map(function (k) {
      var m = s.mins[k], d = new Date(k);
      s.days[dayOf(k)] = 1; if (d.getHours() >= 18) s.days[dayOf(k + 864e5)] = 1;
      return [k, m.bpm, m.rr.slice(0, 300)];
    });
    var chunks = []; for (var i = 0; i < rows.length; i += 240) chunks.push(rows.slice(i, i + 240));
    var dev = { name: S.name || 'Whoop', model: 'WHOOP 4.0', battery: S.battery, connected: true, last_seen: Date.now() };
    var p = Promise.resolve(true);
    chunks.forEach(function (c, i) {
      p = p.then(function (ok) {
        if (!ok) return false;
        var last = final && i === chunks.length - 1;
        return tryApi({ minutes: c, device: dev, score: last ? { days: Object.keys(s.days).sort().slice(-7), tz_offset_min: tz() } : undefined }).then(function () {
          c.forEach(function (r) { delete s.mins[r[0]]; });
          s.savedTo = Math.max(s.savedTo, c[c.length - 1][0] + 60000); progress();
          return true;
        }, function (e) { s.err = e; return false; });
      });
    });
    return p;
  }
  function score(s) { return tryApi({ score: { days: Object.keys(s.days).sort().slice(-7), tz_offset_min: tz() } }).then(function () { return true; }, function () { return true; }); }
  function tryApi(body, n) {
    n = n || 0;
    return api(body).catch(function (e) {
      if (e.code === 'slow_down' && n < 5) return pause(2000).then(function () { return tryApi(body, n + 1); });
      if (e.code === 'offline' && n < 3) return pause(4000).then(function () { return tryApi(body, n + 1); });
      throw e;
    });
  }
  function report() {
    var t = []; for (var k in DG.types) t.push(k + 'x' + DG.types[k]);
    var line = 'band said: ' + DG.replies.slice(-12).join(' ') + ' · heard ' + (t.join(' ') || 'nothing');
    fetch('https://fwimdnukebbrwpwdyjbv.supabase.co/functions/v1/steptest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ counted: 0, detected: 0, device: 'band-web ' + (S.name || ''), note: 'syncdiag ' + line,
        frames: DG.raw.length ? DG.raw.map(function (r) { return [r[0], r[1].replace(/[^0-9a-f]/g, '') || '00']; }) : [[Date.now(), '00']] }) }).catch(function () {});
    return line;
  }
  function endSync(ok, m) {
    var s = S.sync; if (!s || !s.running) return;
    s.running = false;
    if (!s.n) S.detail = report();
    if (ok !== false && s.savedTo) {
      S.last = { to: s.savedTo, at: Date.now(), secs: s.n };
      try { localStorage.setItem(LAST, JSON.stringify(S.last)); } catch (e) {}
    }
    if (s.err && s.err.code === 'signed_out') { S.view = 'signin'; S.msg = ['warn', 'Sign in again to keep syncing.']; return render(); }
    if (s.err && s.err.code === 'no_band') m = ['warn', 'Your account has no band set up yet. Set it up in LOCKED (Profile, then Wearables) once, then sync again.'];
    S.msg = m || null;
    if (S.view === 'main') render();
    var st = $('nstat'); if (st) st.textContent = nightStatus();
  }

  // ---------- night ----------
  function nightOn() {
    S.night = true; S.view = 'night'; render();
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { S.lock = l; }, function () {}); } catch (e) {}
    S.nightTimer = setInterval(function () {
      var c = $('nclock'); if (c) c.textContent = clock(new Date());
      if (S.connected && !(S.sync && S.sync.running) && (!S.last || Date.now() - (S.last.at || 0) > NIGHT_EVERY)) startSync();
    }, 30000);
  }
  function nightOff() {
    S.night = false; clearInterval(S.nightTimer);
    try { if (S.lock) S.lock.release(); } catch (e) {} S.lock = null;
    S.view = S.connected ? 'main' : 'connect'; render();
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && S.night && navigator.wakeLock) { try { navigator.wakeLock.request('screen').then(function (l) { S.lock = l; }, function () {}); } catch (e) {} }
  });

  // ---------- start ----------
  if (!navigator.bluetooth) S.view = 'nobt';
  else if (!session()) S.view = 'signin';
  else { S.view = 'connect'; afterSignIn(); }
  render();
})();
