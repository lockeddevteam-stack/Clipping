/* Band v2 core. Pure logic, no DOM: band frames, motion parsing, filters, the step counter,
   the rep counter and a motion synthesizer for testing. Runs in the page and in Node.

   Motion layouts are hypotheses until checked on the real band (see LAYOUTS). The parser
   picks a layout by packet length, checks the numbers look like a wrist (about 1 g of
   gravity), and logs anything it does not know so it can be added later. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BandCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- frames ----------
  function crc8(b) { var c = 0; for (var i = 0; i < b.length; i++) { c ^= b[i]; for (var k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; } return c; }
  var T = (function () { var t = new Uint32Array(256); for (var i = 0; i < 256; i++) { var c = i; for (var k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function i16(b, o) { var v = b[o] | (b[o + 1] << 8); return v & 0x8000 ? v - 0x10000 : v; }
  function le32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
  function hex(b, n) { var s = ''; n = Math.min(b.length, n == null ? b.length : n); for (var i = 0; i < n; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function unhex(s) { var o = new Array(s.length >> 1); for (var i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; }

  /* Opcodes this app may send. Anything else is refused here, so a typo can never reach the band.
     Never: 0x19 erase, 0x1D reboot, 0x99 / 0x9A persistent saves. */
  var SAFE_OPS = { 0x0B: 'clock', 0x0E: 'hr broadcast', 0x14: 'stop history', 0x16: 'send history', 0x17: 'ack batch',
    0x21: 'read pointer', 0x22: 'data range', 0x23: 'hello', 0x3F: 'raw motion (R10/R11 realtime)', 0x43: 'alarm', 0x4C: 'name', 0x6A: 'imu (refused by this band)' };
  var NEVER = [0x19, 0x1D, 0x99, 0x9A];
  function isSafeOp(op) { return NEVER.indexOf(op) < 0 && Object.prototype.hasOwnProperty.call(SAFE_OPS, op); }

  /* [AA][u16 len][crc8(len)][inner padded to 4][crc32(inner)], inner = [23][seq][op][args] */
  function packet(seq, op, args) {
    if (!isSafeOp(op)) throw new Error('refused opcode 0x' + op.toString(16));
    var p = [0x23, seq & 255, op].concat(args || []);
    while (p.length % 4) p.push(0);
    var len = p.length + 4, lb = [len & 255, len >> 8], c = crc32(p);
    return [0xAA].concat(lb, [crc8(lb)], p, le32(c));
  }
  /* Wraps an inner payload the way the band does (used by the simulator and tests). */
  function wrap(inner) {
    inner = inner.slice(); while (inner.length % 4) inner.push(0);
    var len = inner.length + 4, lb = [len & 255, len >> 8], c = crc32(inner);
    return [0xAA].concat(lb, [crc8(lb)], inner, le32(c));
  }

  /* Joins notifications back into packets. Strict for normal packets (length and CRC must check).
     Long motion packets get a tolerant path: the documented R10 frame declares 1,924 but carries
     1,917, so a strict reader would wait forever and swallow the next packet. When a declared
     length over 1,200 does not close with a good CRC, the packet is cut at the next valid header
     (or after 250 ms of quiet) and returned with crcOk false. */
  function Reassembler() { this.buf = []; this.lastAt = 0; this.stats = { ok: 0, tolerant: 0, dropped: 0 }; }
  Reassembler.prototype.feed = function (bytes, now) {
    var buf = this.buf, out = [];
    now = now == null ? Date.now() : now;
    if (buf.length && now - this.lastAt > 250) this._flushLong(out);
    this.lastAt = now;
    for (var i = 0; i < bytes.length; i++) buf.push(bytes[i]);
    for (;;) {
      var s = buf.indexOf(0xAA);
      if (s < 0) { if (buf.length) this.stats.dropped += buf.length; buf.length = 0; break; }
      if (s > 0) { this.stats.dropped += s; buf.splice(0, s); }
      if (buf.length < 4) break;
      if (crc8([buf[1], buf[2]]) !== buf[3]) { buf.shift(); this.stats.dropped++; continue; }
      var len = buf[1] | (buf[2] << 8);
      if (len < 5 || len > 4096) { buf.shift(); this.stats.dropped++; continue; }
      var total = 4 + len;
      if (len > 1200) {
        // tolerant: look for the next valid header after a plausible body
        var cut = this._nextHeader(1200);
        if (buf.length >= total) {
          var inner0 = buf.slice(4, total - 4);
          if (crc32(inner0) === u32(buf, total - 4) && (cut < 0 || cut >= total)) { out.push({ inner: inner0, crcOk: true }); this.stats.ok++; buf.splice(0, total); continue; }
        }
        if (cut > 0 && cut < total + 64) { out.push({ inner: buf.slice(4, cut), crcOk: false, declared: len }); this.stats.tolerant++; buf.splice(0, cut); continue; }
        if (buf.length >= total + 64) { out.push({ inner: buf.slice(4, total - 4), crcOk: false, declared: len }); this.stats.tolerant++; buf.splice(0, total); continue; }
        break;
      }
      if (buf.length < total) break;
      var inner = buf.slice(4, total - 4);
      if (crc32(inner) === u32(buf, total - 4)) { out.push({ inner: inner, crcOk: true }); this.stats.ok++; }
      else this.stats.dropped += total;
      buf.splice(0, total);
    }
    if (buf.length > 16384) { this.stats.dropped += buf.length; buf.length = 0; }
    return out;
  };
  Reassembler.prototype._nextHeader = function (from) {
    var b = this.buf;
    for (var i = from; i + 3 < b.length; i++) {
      if (b[i] !== 0xAA || crc8([b[i + 1], b[i + 2]]) !== b[i + 3]) continue;
      var l = b[i + 1] | (b[i + 2] << 8);
      if (l >= 5 && l <= 4096) return i;
    }
    return -1;
  };
  Reassembler.prototype._flushLong = function (out) {
    var b = this.buf;
    if (b.length > 1200 && b[0] === 0xAA) { out.push({ inner: b.slice(4, b.length), crcOk: false, declared: b[1] | (b[2] << 8), flushed: true }); this.stats.tolerant++; }
    else this.stats.dropped += b.length;
    b.length = 0;
  };
  Reassembler.prototype.flush = function () { var out = []; if (this.buf.length) this._flushLong(out); return out; };

  // ---------- motion layouts (hypotheses) ----------
  /* legacy-r10: NOOP project, firmware 41.17.6.0. Offsets are absolute in the whole frame
     (the 4-byte AA header counts), so in the inner payload they sit 4 earlier. Which base is
     right is decided per session by gravity: the base whose accel magnitude is nearest 1 g wins.
     v1-0x33: what the v1 app expected from 0x6A (refused by this band); kept for completeness. */
  var LAYOUTS = [
    { name: 'legacy-r10', test: function (n) { return n >= 1288 && n <= 1960; }, n: 100,
      accel: [89, 289, 489], gyro: [692, 892, 1092], bases: [-4, 0, -3, -5], aScale: 1 / 4096, gScale: 2000 / 32768 },
    { name: 'v1-0x33', test: function (n, t) { return t === 0x33 && n >= 84 && n <= 120; }, n: 10,
      accel: [24, 44, 64], gyro: null, bases: [0], aScale: 1 / 4096, gScale: 0 }
  ];

  function MotionParser() {
    this.base = {};          // layout name -> chosen base shift
    this.unknown = {};       // "type/ver/len" -> count
    this.seen = 0; this.parsed = 0;
    this.log = [];           // last unknown packets (hex head) for the Lab view
  }
  function axes(inner, L, shift) {
    var o = { ax: [], ay: [], az: [], gx: [], gy: [], gz: [] }, keys = ['ax', 'ay', 'az'], gk = ['gx', 'gy', 'gz'];
    for (var a = 0; a < 3; a++) {
      var off = L.accel[a] + shift;
      for (var i = 0; i < L.n; i++) o[keys[a]].push(i16(inner, off + 2 * i) * L.aScale);
      if (L.gyro) { var go = L.gyro[a] + shift; for (var j = 0; j < L.n; j++) o[gk[a]].push(i16(inner, go + 2 * j) * L.gScale); }
    }
    return o;
  }
  function gravityFit(o) {
    var s = 0, n = o.ax.length;
    for (var i = 0; i < n; i++) s += Math.sqrt(o.ax[i] * o.ax[i] + o.ay[i] * o.ay[i] + o.az[i] * o.az[i]);
    return Math.abs(s / Math.max(1, n) - 1);
  }
  /* How jagged the axes are (g per sample). A wrong offset of a sample or two pulls the next
     axis's first values onto the end of this one: a jump the right offset does not have. Gravity
     alone cannot tell a 2-sample shift apart, this can. */
  function roughness(o) {
    var t = 0, n = o.ax.length;
    [o.ax, o.ay, o.az].forEach(function (a) { for (var i = 1; i < n; i++) t += Math.abs(a[i] - a[i - 1]); });
    return t / Math.max(1, n);
  }
  /* Returns { layout, crcOk, t, n, ax, ay, az, gx, gy, gz } or null (and logs the packet).
     The offset is settled by the first 6 good frames (lowest total of gravity misfit plus
     roughness), then kept; a run of implausible frames reopens the question. */
  MotionParser.prototype.parse = function (pk, now) {
    var inner = pk.inner || pk, t0 = inner[0];
    this.seen++;
    for (var k = 0; k < LAYOUTS.length; k++) {
      var L = LAYOUTS[k];
      if (!L.test(inner.length, t0)) continue;
      var maxOff = Math.max.apply(null, L.accel.concat(L.gyro || [])) + 2 * L.n;
      var fixed = this.base[L.name], bases = fixed != null ? [fixed] : L.bases, best = null;
      var votes = this.votes = this.votes || {}, v = votes[L.name] = votes[L.name] || { n: 0, sum: {} };
      for (var b = 0; b < bases.length; b++) {
        if (maxOff + bases[b] > inner.length) continue;
        var o = axes(inner, L, bases[b]), fit = gravityFit(o), score = fit + roughness(o);
        if (fixed == null && fit <= 0.6) v.sum[bases[b]] = (v.sum[bases[b]] || 0) + score;
        if (!best || score < best.score) best = { o: o, fit: fit, score: score, base: bases[b] };
      }
      if (!best) continue;
      if (best.fit > 0.6) {
        this.bad = (this.bad || 0) + 1;
        if (fixed != null && this.bad >= 10) { delete this.base[L.name]; votes[L.name] = { n: 0, sum: {} }; this.bad = 0; }
        this._unknown(inner, 'implausible ' + L.name); return null;
      }
      this.bad = 0;
      if (fixed == null && ++v.n >= 6) {
        var pick = null; Object.keys(v.sum).forEach(function (x) { if (pick == null || v.sum[x] < v.sum[pick]) pick = x; });
        this.base[L.name] = Number(pick);
      }
      this.parsed++;
      var r = best.o; r.layout = L.name; r.base = best.base; r.crcOk = pk.crcOk !== false; r.n = L.n; r.t = now == null ? Date.now() : now;
      return r;
    }
    this._unknown(inner);
    return null;
  };
  MotionParser.prototype._unknown = function (inner, why) {
    var key = '0x' + (inner[0] || 0).toString(16) + '/' + (inner[1] || 0) + '/' + inner.length;
    this.unknown[key] = (this.unknown[key] || 0) + 1;
    if (this.unknown[key] <= 3) { this.log.push({ key: key, why: why || 'unknown', head: hex(inner, 48) }); if (this.log.length > 60) this.log.shift(); }
  };

  /* v25 history record (0x2F, version 25, 76 bytes): motion without heart rate. Layout unverified.
     Hypothesis: u32 band time at [7] like v24, int16 samples after it. Returned raw plus two readings
     (interleaved xyz and planar) so the Lab can show which one looks like gravity. */
  function parseV25(inner) {
    if (!inner || inner[0] !== 0x2F || inner[1] !== 25) return null;
    var t = u32(inner, 7), ints = [];
    for (var o = 11; o + 1 < inner.length; o += 2) ints.push(i16(inner, o));
    var tri = Math.floor(ints.length / 3), inter = [], planar = [];
    for (var i = 0; i < tri; i++) {
      inter.push([ints[3 * i], ints[3 * i + 1], ints[3 * i + 2]]);
      planar.push([ints[i], ints[tri + i], ints[2 * tri + i]]);
    }
    var mag = function (v) { var s = 0; v.forEach(function (x) { s += Math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]); }); return v.length ? s / v.length : 0; };
    return { bandTime: t, len: inner.length, ints: ints, interleavedMag: mag(inter), planarMag: mag(planar) };
  }

  // ---------- signal tools ----------
  /* Biquad (RBJ cookbook), streaming. */
  function Biquad(type, fs, f0, q) {
    var w = 2 * Math.PI * f0 / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * (q || Math.SQRT1_2)), b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = al; b1 = 0; b2 = -al; }
    a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
    this.b = [b0 / a0, b1 / a0, b2 / a0]; this.a = [a1 / a0, a2 / a0]; this.z = [0, 0];
  }
  Biquad.prototype.step = function (x) {
    var y = this.b[0] * x + this.z[0];
    this.z[0] = this.b[1] * x - this.a[0] * y + this.z[1];
    this.z[1] = this.b[2] * x - this.a[1] * y;
    return y;
  };
  /* Band-pass as high-pass then low-pass (wider and flatter than a single biquad). */
  function BandPass(fs, lo, hi) { this.h = new Biquad('hp', fs, lo); this.l = new Biquad('lp', fs, hi); this.h2 = new Biquad('hp', fs, lo); this.l2 = new Biquad('lp', fs, hi); }
  BandPass.prototype.step = function (x) { return this.l2.step(this.l.step(this.h2.step(this.h.step(x)))); };

  /* Turns frames of n samples at an unknown rate into a steady 50 Hz stream. The rate is measured
     from frame arrival (samples / second over the last ~5 s), so the counters never depend on a
     guessed sample rate. */
  var FS = 50;
  function Resampler(fsGuess) { this.fsIn = fsGuess || 0; this.hist = []; this.acc = 0; this.prev = null; }
  Resampler.prototype.rate = function (n, t) {
    this.hist.push([t, n]);
    while (this.hist.length > 2 && t - this.hist[0][0] > 5000) this.hist.shift();
    if (this.hist.length >= 3) {
      var span = (t - this.hist[0][0]) / 1000, sum = 0;
      for (var i = 1; i < this.hist.length; i++) sum += this.hist[i][1];
      if (span > 0.4) this.fsIn = sum / span;
    }
    return this.fsIn;
  };
  /* rows: array of sample vectors at fsIn. Calls emit(vec) at 50 Hz with linear interpolation. */
  Resampler.prototype.push = function (rows, fsIn, emit) {
    var step = fsIn / FS;
    for (var i = 0; i < rows.length; i++) {
      var cur = rows[i];
      if (!this.prev) { this.prev = cur; emit(cur); this.acc = step; continue; }
      while (this.acc <= 1) {
        var f = this.acc, v = [];
        for (var k = 0; k < cur.length; k++) v.push(this.prev[k] + (cur[k] - this.prev[k]) * f);
        emit(v); this.acc += step;
      }
      this.acc -= 1; this.prev = cur;
    }
  };

  // ---------- step counter ----------
  /* Accel magnitude, band-passed 0.6 to 3.5 Hz. A step is a peak above an adaptive threshold
     (40% of the recent peak level, never under 0.04 g), at least 0.28 s after the last one.
     Steps only count once 4 land in a row at a walking or running cadence (0.3 to 2 s apart),
     so arm waves and a single bump do not add steps. */
  function StepCounter(opts) {
    opts = opts || {};
    this.bp = new BandPass(FS, 0.6, 3.5);
    this.minGap = Math.round((opts.minGap || 0.28) * FS); this.maxGap = Math.round((opts.maxGap || 2.0) * FS);
    this.floor = opts.floor || 0.04; this.need = opts.need || 4;
    this.i = 0; this.last = -1e9; this.level = 0.15; this.pending = 0; this.steps = 0; this.y1 = 0; this.y2 = 0; this.cadence = 0;
  }
  StepCounter.prototype.push = function (ax, ay, az) {
    var m = Math.sqrt(ax * ax + ay * ay + az * az), got = 0;
    if (this.m0 == null) this.m0 = m;
    var y = this.bp.step(m - this.m0);
    this.i++;
    // peak at y1
    if (this.i > FS && this.y1 > this.y2 && this.y1 >= y) {
      var th = Math.max(this.floor, this.level * 0.4), gap = this.i - 1 - this.last;
      if (this.y1 > th && gap >= this.minGap) {
        this.level = this.level * 0.8 + this.y1 * 0.2;
        if (gap > this.maxGap) this.pending = 0;
        this.pending++;
        if (gap <= this.maxGap) this.cadence = FS / gap * 60;
        this.last = this.i - 1;
        if (this.pending === this.need) { got = this.need; }
        else if (this.pending > this.need) got = 1;
      }
    }
    if (this.i - this.last > this.maxGap && this.pending) { this.pending = 0; this.cadence = 0; }
    this.level = Math.max(this.floor, this.level * 0.9995);
    this.y2 = this.y1; this.y1 = y;
    this.steps += got;
    return got;
  };

  // ---------- rep counter ----------
  /* Per-exercise presets. signal: which wrist motion carries the rep.
       tilt  = forearm rotates (curl, raise): gravity's direction in the band changes a lot, so the
               slow part (0.15 to 1.6 Hz) of the axis with the most swing tracks the lift.
       lift  = forearm stays upright, the wrist travels (press, row, squat): same band, smaller swing,
               so a lower threshold.
     minAmp: the smallest swing that counts (tilt: g of gravity shift; lift: metres of travel). refractory: the fastest rep (s).
     maxRep: a pause longer than this (s) restarts the count of which axis to follow.
     countable false: the wrist barely moves, so the page asks for the number instead. */
  var EXERCISES = [
    { id: 'curl', name: 'Bicep curl', signal: 'tilt', minAmp: 0.45, refractory: 0.9, maxRep: 7, band: [0.15, 1.6], countable: true },
    { id: 'hammer', name: 'Hammer curl', signal: 'tilt', minAmp: 0.45, refractory: 0.9, maxRep: 7, band: [0.15, 1.6], countable: true },
    { id: 'press', name: 'Shoulder press', signal: 'lift', minAmp: 0.12, refractory: 0.9, maxRep: 7, band: [0.15, 1.0], countable: true },
    { id: 'row', name: 'Row', signal: 'lift', minAmp: 0.12, refractory: 0.9, maxRep: 7, band: [0.15, 1.0], countable: true },
    { id: 'raise', name: 'Lateral raise', signal: 'tilt', minAmp: 0.35, refractory: 1.0, maxRep: 7, band: [0.15, 1.6], countable: true },
    { id: 'squat', name: 'Back squat', signal: 'lift', minAmp: 0.10, refractory: 1.2, maxRep: 9, band: [0.12, 0.8], countable: true, note: 'Bar on your back: the band feels your whole body go down and up. Worth a try.' },
    { id: 'lunge', name: 'Lunge', signal: 'lift', minAmp: 0.08, refractory: 1.2, maxRep: 9, band: [0.12, 0.8], countable: true, note: 'Counts each step down. Keep the arm with the band still.' },
    { id: 'legext', name: 'Leg extension', countable: false },
    { id: 'legcurl', name: 'Leg curl', countable: false },
    { id: 'legpress', name: 'Leg press', countable: false }
  ];
  function exercise(id) { for (var i = 0; i < EXERCISES.length; i++) if (EXERCISES[i].id === id) return EXERCISES[i]; return null; }

  /* Three filtered axes.
     tilt: low-passed only (gravity's direction is the signal, so no high-pass that rings).
     lift: the wrist's own acceleration, band-passed, then integrated twice into travel (metres),
           so one rep is one bump instead of a wobble of accelerations.
     The three axes are reduced to one signal along the direction the motion mostly runs (its
     principal axis), so how the band sits on the wrist does not matter.
     Counting is a zigzag: a turn is confirmed once the signal has come back by delta from its
     extreme, delta being half the smallest swing that counts, or 45% of the recent typical rep
     once there is one. Small wobbles never reach delta. The first confirmed leg fixes which way
     is "out" (it depends on how the band sits); a rep counts when the leg back is confirmed, so
     it lands while the weight comes down, like a person counts. A refractory period stops one rep
     counting twice. */
  function RepCounter(ex, opts) {
    opts = opts || {};
    this.ex = typeof ex === 'string' ? exercise(ex) : ex;
    if (!this.ex || !this.ex.countable) throw new Error('not countable');
    var b = this.ex.band, tilt = this.ex.signal !== 'travel';
    this.f = [0, 1, 2].map(function () { return tilt ? new Biquad('lp', FS, b[1]) : new BandPass(FS, b[0], b[1]); });
    this.f2 = tilt ? [0, 1, 2].map(function () { return new Biquad('lp', FS, b[1]); }) : null;
    this.pre = []; this.vel = [0, 0, 0]; this.pos = [0, 0, 0]; this.leak = Math.exp(-1 / (1.5 * FS));
    this.win = []; this.W = 4 * FS;
    this.axis = -1; this.i = 0; this.last = -1e9; this.reps = 0; this.amp = 0;
    this.dir = 0; this.ext = 0; this.extAt = 0; this.pol = 0; this.legs = []; this.lastTurn = 0;
    this.refr = Math.round(this.ex.refractory * FS);
    this.minAmp = this.ex.minAmp * (opts.sensitivity || 1);
    this.trace = opts.trace ? [] : null;
  }
  /* Principal axis of a set of 3-vectors (power iteration on the covariance). */
  function principal(win, seed) {
    var n = win.length; if (n < 10) return null;
    var m = [0, 0, 0], c = [0, 0, 0, 0, 0, 0], i;
    for (i = 0; i < n; i++) { m[0] += win[i][0]; m[1] += win[i][1]; m[2] += win[i][2]; }
    m[0] /= n; m[1] /= n; m[2] /= n;
    for (i = 0; i < n; i++) {
      var a = win[i][0] - m[0], b = win[i][1] - m[1], d = win[i][2] - m[2];
      c[0] += a * a; c[1] += a * b; c[2] += a * d; c[3] += b * b; c[4] += b * d; c[5] += d * d;
    }
    var v = seed ? seed.slice() : [0.577, 0.577, 0.577];
    for (var k = 0; k < 12; k++) {
      var w = [c[0] * v[0] + c[1] * v[1] + c[2] * v[2], c[1] * v[0] + c[3] * v[1] + c[4] * v[2], c[2] * v[0] + c[4] * v[1] + c[5] * v[2]];
      var L = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
      if (!(L > 1e-12)) return null;
      v = [w[0] / L, w[1] / L, w[2] / L];
    }
    return v;
  }
  RepCounter.prototype.push = function (ax, ay, az) {
    // filters start from where the wrist rests (mean of the first 0.2 s), so gravity switching on
    // or one noisy first sample is not read as a move
    if (!this.x0) {
      this.pre.push([ax, ay, az]);
      if (this.pre.length < 10) return 0;
      var mx = [0, 0, 0]; this.pre.forEach(function (v) { mx[0] += v[0] / 10; mx[1] += v[1] / 10; mx[2] += v[2] / 10; });
      this.x0 = mx; var pre = this.pre, got0 = 0; this.pre = [];
      for (var p = 0; p < pre.length; p++) got0 += this.push(pre[p][0], pre[p][1], pre[p][2]);
      return got0;
    }
    var x = [ax - this.x0[0], ay - this.x0[1], az - this.x0[2]], y = [];
    for (var a = 0; a < 3; a++) {
      var v = this.f[a].step(x[a]);
      if (this.f2) { y.push(this.f2[a].step(v)); continue; }
      // lift: acceleration (m/s2) integrated twice with a leak (about 1.5 s) into travel in metres
      this.vel[a] = this.vel[a] * this.leak + v * 9.81 / FS;
      this.pos[a] = this.pos[a] * this.leak + this.vel[a] / FS;
      y.push(this.pos[a]);
    }
    this.i++;
    this.win.push(y); if (this.win.length > this.W) this.win.shift();
    // the direction the motion mostly runs along (principal axis of the last 4 s), kept pointing
    // the same way as before so the signal never flips sign
    if (this.i % 5 === 0 || !this.u) {
      var u = principal(this.win, this.u);
      if (u) { if (this.u && u[0] * this.u[0] + u[1] * this.u[1] + u[2] * this.u[2] < 0) u = [-u[0], -u[1], -u[2]]; this.u = u; }
    }
    var U = this.u || [0, 0, 1], s = y[0] * U[0] + y[1] * U[1] + y[2] * U[2], got = 0;
    this.amp = this.legs.length ? this.legs[this.legs.length - 1] : 0;
    var typ = this.legs.length ? this.legs.slice().sort(function (p, q) { return p - q; })[this.legs.length >> 1] : 0;
    var delta = Math.max(this.minAmp / 2, 0.45 * typ, 0.3 * (this.bigLeg || 0));
    if (this.dir === 0) {
      if (Math.abs(s - this.ext) >= delta) { this.dir = s > this.ext ? 1 : -1; this.ext = s; this.extAt = this.i; }
    } else if (this.dir * (s - this.ext) > 0) { this.ext = s; this.extAt = this.i; }
    else if (this.dir * (this.ext - s) >= delta) {
      // the leg that just ended went this.dir; it is confirmed now
      var legDir = this.dir, size = Math.abs(this.ext - (this.turnVal == null ? 0 : this.turnVal));
      this.turnVal = this.ext;
      if (size > (this.bigLeg || 0) && this.reps < 2) this.bigLeg = size;
      var e = Math.abs(this.ext), can = size >= this.minAmp && this.i - this.last >= this.refr;
      if (this.pol === 0) {
        // the first turn of a set: provisionally the "out" side
        this.pol = legDir; this.firstExt = e; this.turns = 1; this.firstCounted = can;
        if (can) { this.reps++; got = 1; this.last = this.i; }
      } else if (this.turns === 1 && legDir !== this.pol && (e > 1.3 * this.firstExt || !this.firstCounted)) {
        // the second turn went further from rest than the first: that side is "out" (a press starts
        // with a short push one way, then the big move the other way)
        this.turns = 2; this.pol = legDir;
        if (!this.firstCounted && can) { this.reps++; got = 1; this.last = this.i; }
      } else {
        this.turns++;
        if (legDir === this.pol && size >= this.minAmp * 0.6) { this.legs.push(size); if (this.legs.length > 5) this.legs.shift(); }
        if (legDir === this.pol && can) { this.reps++; got = 1; this.last = this.i; }
      }
      this.dir = -legDir; this.ext = s; this.extAt = this.i; this.lastTurn = this.i;
    }
    // a long pause: the next move starts a fresh cycle, whichever way it goes
    if (this.pol !== 0 && this.i - this.lastTurn > this.ex.maxRep * FS && this.i - this.extAt > this.ex.maxRep * FS) { this.pol = 0; this.dir = 0; this.turnVal = s; this.ext = s; }
    if (this.trace) this.trace.push([s, delta, got]);
    return got;
  };

  // ---------- synthesizer (tests, harness, demos) ----------
  function rng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function gauss(r) { var u = r() || 1e-9, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  /* Wrist motion at fs Hz. kind: curl, hammer, raise (forearm rotates), press, row, squat, lunge
     (wrist travels), legext, legcurl, legpress (wrist still), walk, rest.
     Returns { fs, rows: [[ax,ay,az,gx,gy,gz]...] (g, dps), reps: [times s] }. */
  function synth(kind, o) {
    o = o || {};
    var fs = o.fs || 200, reps = o.reps == null ? 10 : o.reps, period = o.period || 2.4, jitter = o.jitter == null ? 0.15 : o.jitter;
    var noise = o.noise == null ? 0.02 : o.noise, lead = o.lead == null ? 2 : o.lead, tail = o.tail == null ? 2 : o.tail, r = rng(o.seed || 7);
    var tilt0 = o.tilt0 == null ? 0.35 : o.tilt0;     // starting forearm angle (rad)
    var spec = {
      curl: { rot: 2.1, axis: 'x', trans: 0 }, hammer: { rot: 1.9, axis: 'x', trans: 0 }, raise: { rot: 1.3, axis: 'y', trans: 0 },
      press: { rot: 0.18, axis: 'x', trans: 0.45 }, row: { rot: 0.3, axis: 'y', trans: 0.38 },
      squat: { rot: 0.05, axis: 'x', trans: 0.55 }, lunge: { rot: 0.06, axis: 'x', trans: 0.45 },
      legext: { rot: 0.01, axis: 'x', trans: 0.004 }, legcurl: { rot: 0.01, axis: 'x', trans: 0.004 }, legpress: { rot: 0.015, axis: 'x', trans: 0.01 }
    }[kind];
    var rows = [], times = [], t = 0, dt = 1 / fs;
    function still(sec) { for (var i = 0; i < sec * fs; i++) { rows.push(sample(tilt0, 0, 0)); t += dt; } }
    function sample(th, om, lin) {
      // gravity in the band frame after rotating by th about the spec axis; lin = vertical accel (g)
      var g = [0, 0, 1];
      if (!spec || spec.axis === 'x') g = [0, Math.sin(th), Math.cos(th)]; else g = [Math.sin(th), 0, Math.cos(th)];
      var ax = g[0] * (1 + lin) + noise * gauss(r), ay = g[1] * (1 + lin) + noise * gauss(r), az = g[2] * (1 + lin) + noise * gauss(r);
      var w = om * 180 / Math.PI;
      return spec && spec.axis === 'y' ? [ax, ay, az, noise * 20 * gauss(r), w, noise * 20 * gauss(r)] : [ax, ay, az, w, noise * 20 * gauss(r), noise * 20 * gauss(r)];
    }
    if (kind === 'walk' || kind === 'run') {
      var cad = o.cadence || (kind === 'run' ? 2.7 : 1.8), n = o.steps || 40, ampW = kind === 'run' ? 0.9 : 0.35;
      still(lead);
      for (var s = 0; s < n; s++) {
        var per = (1 / cad) * (1 + jitter * 0.3 * (r() - 0.5));
        times.push(t + per * 0.25);
        for (var i = 0; i < per * fs; i++) {
          var ph = i / (per * fs), lin = ampW * Math.sin(2 * Math.PI * ph) + 0.15 * ampW * Math.sin(4 * Math.PI * ph);
          var sw = 0.5 * Math.sin(Math.PI * (s + ph));     // arm swing, one swing per two steps
          rows.push(sample(tilt0 + sw, 0.5 * Math.PI * cad * Math.cos(Math.PI * (s + ph)), lin)); t += dt;
        }
      }
      still(tail);
      return { fs: fs, rows: rows, reps: times };
    }
    if (kind === 'rest' || !spec) { still(o.seconds || 10); return { fs: fs, rows: rows, reps: [] }; }
    still(lead);
    for (var k = 0; k < reps; k++) {
      var p = period * (1 + jitter * (r() - 0.5)), amp = 1 + 0.25 * (r() - 0.5);
      if (o.fatigue) p *= 1 + 0.04 * k;
      for (var j = 0; j < p * fs; j++) {
        var ph2 = j / (p * fs);
        // concentric up in 40% of the rep, a short hold, lowering in the rest
        var x = ph2 < 0.4 ? (1 - Math.cos(Math.PI * ph2 / 0.4)) / 2 : ph2 < 0.5 ? 1 : (1 + Math.cos(Math.PI * (ph2 - 0.5) / 0.5)) / 2;
        var dx = ph2 < 0.4 ? Math.PI / 0.4 / 2 * Math.sin(Math.PI * ph2 / 0.4) : ph2 < 0.5 ? 0 : -Math.PI / 0.5 / 2 * Math.sin(Math.PI * (ph2 - 0.5) / 0.5);
        var ddx = ph2 < 0.4 ? (Math.PI / 0.4) * (Math.PI / 0.4) / 2 * Math.cos(Math.PI * ph2 / 0.4) : ph2 < 0.5 ? 0 : -(Math.PI / 0.5) * (Math.PI / 0.5) / 2 * Math.cos(Math.PI * (ph2 - 0.5) / 0.5);
        var th = tilt0 + spec.rot * amp * x, om = spec.rot * amp * dx / p;
        var lin2 = spec.trans * amp * ddx / (p * p) * 0.1;   // vertical accel from the wrist travelling
        rows.push(sample(th, om, lin2)); t += dt;
      }
      times.push(t);
      if (o.restBetween) still(o.restBetween);
    }
    still(tail);
    return { fs: fs, rows: rows, reps: times };
  }
  /* Encodes 100 rows into a legacy-r10 inner payload (the layout under test). */
  function encodeR10(rows, seq) {
    var L = LAYOUTS[0], inner = new Array(1913).fill(0), base = -4;
    inner[0] = 0x2B; inner[1] = 10; inner[2] = seq & 255;
    for (var a = 0; a < 3; a++) for (var i = 0; i < 100; i++) {
      var v = rows[i] ? Math.max(-32768, Math.min(32767, Math.round(rows[i][a] / L.aScale))) : 0, o = L.accel[a] + base + 2 * i;
      inner[o] = v & 255; inner[o + 1] = (v >> 8) & 255;
      var g = rows[i] ? Math.max(-32768, Math.min(32767, Math.round(rows[i][3 + a] / L.gScale))) : 0, og = L.gyro[a] + base + 2 * i;
      inner[og] = g & 255; inner[og + 1] = (g >> 8) & 255;
    }
    return inner;
  }
  /* A whole band frame as the hypothesis says it arrives: declared 1,924, carrying 1,917. */
  function frameR10(rows, seq) {
    var inner = encodeR10(rows, seq), len = 1924, lb = [len & 255, len >> 8];
    return [0xAA].concat(lb, [crc8(lb)], inner);   // 4 + 1913 = 1917 bytes, no valid CRC
  }

  /* Runs a recording (rows at fs) through the resampler and a counter. Used by tests and the harness. */
  function countRows(rows, fs, counter) {
    var R = new Resampler(fs), events = [], n = 0;
    R.push(rows, fs, function (v) { n++; if (counter.push(v[0], v[1], v[2])) events.push(n / FS); });
    return events;
  }

  return {
    crc8: crc8, crc32: crc32, u32: u32, i16: i16, le32: le32, hex: hex, unhex: unhex,
    SAFE_OPS: SAFE_OPS, NEVER: NEVER, isSafeOp: isSafeOp, packet: packet, wrap: wrap, Reassembler: Reassembler,
    LAYOUTS: LAYOUTS, MotionParser: MotionParser, parseV25: parseV25,
    Biquad: Biquad, BandPass: BandPass, Resampler: Resampler, FS: FS,
    StepCounter: StepCounter, RepCounter: RepCounter, EXERCISES: EXERCISES, exercise: exercise,
    synth: synth, encodeR10: encodeR10, frameR10: frameR10, countRows: countRows, rng: rng
  };
});
