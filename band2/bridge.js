/* The page's one door to the band. Three ways in, same calls and events:
     native  inside the Band iPhone app (WKWebView): window.webkit.messageHandlers.band
     web     a browser with Web Bluetooth (Bluefy): live heart rate, raw channels, motion on/off
     sim     anywhere else, or ?sim=1: a simulated band that replays motion, for testing on a desktop

   Calls (all return promises):
     status()                       -> { mode, state, name, battery, bpm, syncing, phase, queued, lastSync, upTo, version }
     motion(on)                     raw motion stream: 0x3F [1] on, [0] off (native also turns it off by itself after 10 min)
     subscribe(channels)            raw notifications of these channels ('0003','0004','0005','0007') come as 'raw' events
     send(op, args)                 any opcode on the safe list (BandCore.SAFE_OPS); everything else is refused
     sync()                         history sync now (native only)
     stored(what)                   the phone's own data: 'queue' (minutes waiting), 'log' (last lines)
     server(body)                   band-web with this phone's band key, e.g. { action: 'view' }
     capture(meta, frames)          labelled raw frames to the steptest store (for checking layouts)
     haptic(kind)                   'light' | 'success' | 'rigid'
     native only: scan(), pick(id), pair(code) (six digits from LOCKED), checkUpdate(), reload()
   Events (on(type, fn)): 'status', 'hr' {bpm, rr, t}, 'raw' {items: [[t, ch, hex]]}, 'update' {version} */
(function (root) {
  'use strict';
  var C = root.BandCore;
  var L = {};
  function emit(type, d) { (L[type] || []).forEach(function (f) { try { f(d); } catch (e) { console.error(e); } }); }
  function on(type, f) { (L[type] = L[type] || []).push(f); return function () { L[type] = L[type].filter(function (g) { return g !== f; }); }; }

  // ---------- native ----------
  function Native() {
    var n = 0, wait = {};
    root.BandBridge = root.BandBridge || {};
    root.BandBridge.receive = function (m) {
      if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { return; } }
      if (!m) return;
      if (m.type === 'reply') { var w = wait[m.id]; if (w) { delete wait[m.id]; m.ok ? w[0](m.data) : w[1](new Error(m.error || 'failed')); } return; }
      emit(m.type, m);
    };
    function call(cmd, args) {
      return new Promise(function (res, rej) {
        var id = ++n; wait[id] = [res, rej];
        setTimeout(function () { if (wait[id]) { delete wait[id]; rej(new Error('timeout')); } }, cmd === 'sync' ? 600000 : cmd === 'server' || cmd === 'capture' ? 60000 : 15000);
        root.webkit.messageHandlers.band.postMessage({ id: id, cmd: cmd, args: args || {} });
      });
    }
    return {
      mode: 'native',
      status: function () { return call('status'); },
      motion: function (v) { return call('motion', { on: !!v }); },
      subscribe: function (ch) { return call('subscribe', { channels: ch || [] }); },
      send: function (op, args) { if (!C.isSafeOp(op)) return Promise.reject(new Error('refused')); return call('send', { op: op, args: args || [] }); },
      sync: function () { return call('sync'); },
      stored: function (what) { return call('stored', { what: what }); },
      server: function (body) { return call('server', { body: body }); },
      capture: function (meta, frames) { return call('capture', { meta: meta, frames: frames }); },
      haptic: function (k) { return call('haptic', { kind: k }).catch(function () {}); },
      connect: function () { return call('connect'); },
      scan: function () { return call('scan'); },
      pick: function (id) { return call('pick', { id: id }); },
      pair: function (code) { return call('pair', { code: code }); },
      checkUpdate: function () { return call('checkUpdate'); },
      reload: function () { return call('reload'); }
    };
  }

  // ---------- Web Bluetooth (Bluefy) ----------
  function Web() {
    var SVC = '61080001-8d6d-82b8-614a-1c8cb0f8dcc6', CMD = '61080002-8d6d-82b8-614a-1c8cb0f8dcc6', base = '-8d6d-82b8-614a-1c8cb0f8dcc6';
    var S = { state: 'idle', name: '', battery: null, bpm: null, dev: null, cmd: null, seq: 0, subs: {}, buf: [], timer: 0 };
    function status() { return { mode: 'web', state: S.state, name: S.name, battery: S.battery, bpm: S.bpm, syncing: false }; }
    function flush() { S.timer = 0; if (S.buf.length) { emit('raw', { items: S.buf }); S.buf = []; } }
    function write(op, args) {
      if (!S.cmd) return Promise.reject(new Error('not connected'));
      S.seq = (S.seq + 1) & 255;
      var p = new Uint8Array(C.packet(S.seq, op, args || []));
      return (S.cmd.writeValueWithResponse ? S.cmd.writeValueWithResponse(p) : S.cmd.writeValue(p));
    }
    function connect() {
      if (!navigator.bluetooth) return Promise.reject(new Error('no bluetooth'));
      S.state = 'connecting'; emit('status', status());
      return navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'WHOOP' }], optionalServices: [SVC, 'battery_service', 'heart_rate'] }).then(function (d) {
        S.dev = d; S.name = d.name || 'WHOOP';
        d.addEventListener('gattserverdisconnected', function () { S.state = 'lost'; S.cmd = null; emit('status', status()); });
        return d.gatt.connect();
      }).then(function (g) {
        return g.getPrimaryService(SVC).then(function (svc) {
          return svc.getCharacteristic(CMD).then(function (c) { S.cmd = c; return Promise.all(['61080003', '61080004', '61080005', '61080007'].map(function (u) {
            return svc.getCharacteristic(u + base).then(function (ch) {
              ch.addEventListener('characteristicvaluechanged', function (e) {
                var k = u.slice(4); if (!S.subs[k]) return;
                var v = new Uint8Array(e.target.value.buffer, e.target.value.byteOffset, e.target.value.byteLength);
                S.buf.push([Date.now(), k, C.hex(v)]); if (!S.timer) S.timer = setTimeout(flush, 80);
              });
              return ch.startNotifications();
            }).catch(function () {});
          })); });
        }).then(function () {
          g.getPrimaryService('heart_rate').then(function (s) { return s.getCharacteristic('heart_rate_measurement'); }).then(function (c) {
            c.addEventListener('characteristicvaluechanged', function (e) {
              var b = new Uint8Array(e.target.value.buffer), bpm = (b[0] & 1) ? b[1] | (b[2] << 8) : b[1];
              if (bpm > 25 && bpm < 240) { S.bpm = bpm; emit('hr', { bpm: bpm, rr: [], t: Date.now() }); }
            });
            return c.startNotifications();
          }).catch(function () {});
          g.getPrimaryService('battery_service').then(function (s) { return s.getCharacteristic('battery_level'); }).then(function (c) { return c.readValue(); })
            .then(function (v) { S.battery = v.getUint8(0); emit('status', status()); }).catch(function () {});
          // safe defaults: motion streams off, heart-rate broadcast on
          return write(0x3F, [0]).then(function () { return write(0x0E, [1]); });
        });
      }).then(function () { S.state = 'connected'; emit('status', status()); return status(); }, function (e) { S.state = 'idle'; emit('status', status()); throw e; });
    }
    root.addEventListener('pagehide', function () { if (S.cmd) write(0x3F, [0]).catch(function () {}); });
    var no = function () { return Promise.reject(new Error('needs the Band app')); };
    return {
      mode: 'web', connect: connect,
      status: function () { return Promise.resolve(status()); },
      motion: function (v) { return write(0x3F, [v ? 1 : 0]); },
      subscribe: function (ch) { S.subs = {}; (ch || []).forEach(function (k) { S.subs[k] = 1; }); return Promise.resolve(); },
      send: function (op, args) { if (!C.isSafeOp(op)) return Promise.reject(new Error('refused')); return write(op, args); },
      sync: no, stored: no, server: no, capture: function (meta, frames) { return postCapture(meta, frames); },
      haptic: function () { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} return Promise.resolve(); }
    };
  }
  /* Straight to the steptest store (write-only, no key). Used outside the app. */
  function postCapture(meta, frames) {
    return fetch('https://fwimdnukebbrwpwdyjbv.supabase.co/functions/v1/steptest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'band2 ' + (meta.device || ''), note: 'capture ' + JSON.stringify(meta).slice(0, 560), counted: meta.counted || 0, detected: meta.detected || 0,
        startedAt: meta.startedAt, seconds: meta.seconds, frames: frames }) }).then(function (r) { return r.json(); });
  }

  // ---------- simulated band ----------
  /* Replays motion as real R10 frames, cut into 182-byte notifications, so the reassembler and the
     parser run exactly as they would on the band. Script: setScript({ kind, reps, period, ... }) or
     setRecording(rows, fs). Without a script it sends a still wrist. */
  function Sim() {
    var S = { state: 'connected', bpm: 62, motion: false, subs: {}, script: null, rows: null, fs: 200, pos: 0, seq: 0, timer: 0, hrTimer: 0, t0: Date.now() };
    function status() { return { mode: 'sim', state: S.state, name: 'Simulated band', battery: 78, bpm: S.bpm, syncing: false, queued: 0, lastSync: Date.now() - 42 * 60000, upTo: Date.now() - 45 * 60000, version: 'sim' }; }
    function load() {
      if (S.script) { var s = C.synth(S.script.kind, S.script); S.rows = s.rows; S.fs = s.fs; S.truth = s.reps; }
      else if (!S.rows) { var r = C.synth('rest', { seconds: 600 }); S.rows = r.rows; S.fs = r.fs; }
      S.pos = 0;
    }
    function tick() {
      if (!S.motion) return;
      if (!S.rows || S.pos + 100 > S.rows.length) { S.script = null; S.rows = null; load(); }
      var f = C.frameR10(S.rows.slice(S.pos, S.pos + 100), S.seq++); S.pos += 100;
      if (S.subs['0005']) {
        var items = [], t = Date.now();
        for (var o = 0; o < f.length; o += 182) items.push([t, '0005', C.hex(f.slice(o, o + 182))]);
        emit('raw', { items: items });
      }
      S.timer = setTimeout(tick, 100 / S.fs * 1000 / (S.speed || 1));
    }
    S.hrTimer = setInterval(function () {
      var busy = S.motion && S.script ? 1 : 0;
      S.bpm = Math.round((busy ? 104 : 63) + 4 * Math.sin(Date.now() / 7000) + (Math.random() - 0.5) * 2);
      emit('hr', { bpm: S.bpm, rr: [Math.round(60000 / S.bpm)], t: Date.now() });
    }, 1000);
    return {
      mode: 'sim',
      status: function () { return Promise.resolve(status()); },
      motion: function (v) { S.motion = !!v; clearTimeout(S.timer); if (v) { if (!S.rows) load(); tick(); } return Promise.resolve(); },
      subscribe: function (ch) { S.subs = {}; (ch || []).forEach(function (k) { S.subs[k] = 1; }); return Promise.resolve(); },
      send: function (op) { return C.isSafeOp(op) ? Promise.resolve() : Promise.reject(new Error('refused')); },
      sync: function () { emit('status', Object.assign(status(), { syncing: true, phase: 'Getting your band’s history' })); return new Promise(function (r) { setTimeout(function () { emit('status', status()); r({ ok: true, minutes: 0 }); }, 1500); }); },
      stored: function (what) { return Promise.resolve(what === 'log' ? { lines: ['sim: nothing stored'] } : { minutes: 0 }); },
      server: function (body) { return Promise.resolve(body && body.action === 'view' ? simView() : { ok: true }); },
      capture: function (meta, frames) { S.captured = (S.captured || []).concat([{ meta: meta, n: frames.length }]); root.__simCaptured = S.captured; return Promise.resolve({ ok: true, id: S.captured.length }); },
      haptic: function () { root.__haptics = (root.__haptics || 0) + 1; return Promise.resolve(); },
      connect: function () { return Promise.resolve(status()); },
      // test hooks
      setScript: function (o) { S.script = o; S.rows = null; load(); S.truth = S.truth || []; return S.truth; },
      setRecording: function (rows, fs) { S.script = null; S.rows = rows; S.fs = fs || 200; S.pos = 0; },
      setSpeed: function (x) { S.speed = x; }
    };
  }

  /* A believable account for the simulator: 8 days, last night with stages and per-minute heart
     rate, today's heart rate so far. Deterministic. */
  function simView() {
    var r = C.rng(11), now = Date.now(), day = function (o) { var d = new Date(now - o * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    var days = [];
    for (var i = 0; i < 8; i++) days.push({ day: day(i), recovery: [71, 58, 44, 66, 80, 52, 63, 69][i], hrv: [64, 55, 47, 60, 72, 51, 58, 62][i], rhr: [52, 55, 58, 53, 50, 56, 54, 53][i],
      sleep_min: [432, 401, 365, 448, 470, 390, 420, 455][i], sleep_need_min: 480, strain: [6.2, 13.4, 9.8, 15.1, 7.7, 11.2, 12.6, 8.4][i], calories: 2400 + i * 37, resp: 14.6 });
    var night = simNight(r, now);
    days[0].night = night;
    var hr = [], d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    for (var t = d0.getTime(); t < now - 60000; t += 60000) {
      var h = (t - d0.getTime()) / 3600000, base = h < 6.5 ? 54 : h < 7 ? 66 : 72 + 6 * Math.sin(h / 2);
      if (h > 9 && h < 10.1) base = 128 + 22 * Math.sin((h - 9) * 9);
      hr.push([t, Math.round(base + (r() - 0.5) * 6)]);
    }
    return { ok: true, days: days, hr: hr, band: { linked: true, last_sync: new Date(now - 42 * 60000).toISOString() } };
  }
  function simNight(r, now) {
    var d = new Date(now); d.setHours(-1, 4, 0, 0);
    var start = d.getTime(), inBed = start - 14 * 60000;
    var plan = [[2, 20], [3, 45], [2, 25], [1, 15], [2, 30], [3, 35], [2, 15], [0, 5], [2, 30], [1, 25], [2, 35], [3, 15], [2, 20], [1, 35], [0, 10], [2, 25], [1, 40], [0, 5]];
    var blocks = [], off = 0;
    plan.forEach(function (p) { blocks.push([p[0], off, p[1]]); off += p[1]; });
    var hr = [], n = 14 + off;
    for (var m = 0; m < n; m++) {
      var k = m - 14, st = 2; blocks.forEach(function (b) { if (k >= b[1] && k < b[1] + b[2]) st = b[0]; });
      var drift = 58 - 8 * Math.min(1, m / 240) + 3 * Math.max(0, (m - 360) / 120);
      var v = drift + { 0: 9, 1: 5, 2: 0, 3: -4 }[k < 0 ? 0 : st] + (r() - 0.5) * 3;
      hr.push(m > 200 && m < 207 ? null : Math.round(v));   // a short gap: the band lost contact
    }
    return { inBed: inBed, hrStart: inBed, start: start, end: start + off * 60000, hr: hr, blocks: blocks };
  }

  function pick() {
    var q = /[?&]sim=1/.test(root.location ? root.location.search : '');
    if (!q && root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.band) return Native();
    if (!q && root.navigator && root.navigator.bluetooth) return Web();
    return Sim();
  }
  var api = pick();
  api.on = on; api.emit = emit; api.simView = simView;
  root.Band = api;
})(typeof window !== 'undefined' ? window : this);
