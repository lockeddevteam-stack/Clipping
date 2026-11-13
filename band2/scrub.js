/* Sleep scrubber: the night as stage bands with heart rate over it. Touch or drag anywhere and a
   cursor shows the exact time, stage and bpm; let go and it slides back. Two canvases: the night
   is drawn once, the cursor layer redraws on animation frames only while something moves.
   Data: { hrStart ms, hr: [bpm|null per minute from hrStart], start ms (sleep onset), end ms,
           blocks: [[stage, startMin from start, lenMin, ...]] } stage 0 awake 1 REM 2 light 3 deep */
(function (root) {
  'use strict';
  var STAGES = [
    { name: 'Awake', color: '#9C948E' }, { name: 'REM', color: '#B58BF5' },
    { name: 'Light', color: '#4E7DB8' }, { name: 'Deep', color: '#7B6DFF' }
  ];
  var HEART = '#FF375F';
  function clock(t) { var d = new Date(t), h = d.getHours(), m = d.getMinutes(); return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'am' : 'pm'); }
  function hm(min) { min = Math.round(min); var h = Math.floor(min / 60), m = min % 60; return h ? h + 'h ' + (m < 10 ? '0' : '') + m + 'm' : m + 'm'; }

  function SleepScrubber(el, opts) {
    this.el = el; this.opts = opts || {};
    el.classList.add('scrub');
    el.innerHTML =
      '<div class="scrub__read" aria-live="off"><span class="scrub__sum"></span><span class="scrub__at" hidden><b class="scrub__time"></b><i class="scrub__sw"></i><span class="scrub__stage"></span><b class="scrub__bpm"></b></span></div>' +
      '<div class="scrub__plot" tabindex="0" role="slider" aria-label="Scrub through the night" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
        '<canvas class="scrub__base"></canvas><canvas class="scrub__over"></canvas>' +
        '<div class="scrub__lanes" aria-hidden="true"><span>Awake</span><span>REM</span><span>Light</span><span>Deep</span></div>' +
        '<div class="scrub__empty" hidden></div></div>' +
      '<div class="scrub__ticks" aria-hidden="true"></div>';
    this.plot = el.querySelector('.scrub__plot');
    this.base = el.querySelector('.scrub__base'); this.over = el.querySelector('.scrub__over');
    this.sum = el.querySelector('.scrub__sum'); this.at = el.querySelector('.scrub__at');
    this.cx = null; this.target = null; this.alpha = 0; this.raf = 0; this.lastStage = -1;
    var self = this;
    this._resize = function () { self.layout(); };
    if (root.ResizeObserver) { this.ro = new ResizeObserver(this._resize); this.ro.observe(this.plot); } else root.addEventListener('resize', this._resize);
    var p = this.plot;
    p.addEventListener('pointerdown', function (e) {
      if (!self.d) return;
      self.down = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { p.setPointerCapture(e.pointerId); } catch (er) {}
      self.move(e.clientX);
    });
    p.addEventListener('pointermove', function (e) {
      if (self.down && e.pointerId === self.down.id) self.move(e.clientX);
      else if (!self.down && e.pointerType === 'mouse' && self.opts.hover) self.move(e.clientX);
    });
    var end = function (e) { if (self.down && (!e || e.pointerId === self.down.id)) { self.down = null; self.release(); } };
    p.addEventListener('pointerup', end); p.addEventListener('pointercancel', end);
    p.addEventListener('pointerleave', function (e) { if (!self.down && e.pointerType === 'mouse') self.release(); });
    p.addEventListener('keydown', function (e) {
      if (!self.d) return;
      var step = (e.shiftKey ? 30 : 5) * 60000 / self.msPerPx();
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); var x = self.cx == null ? (self.w + PADL) / 2 : self.cx; self.cx = null; self.target = null; self.moveLocal(Math.max(PADL, Math.min(self.w, x + (e.key === 'ArrowRight' ? step : -step)))); }
      if (e.key === 'Escape') self.release();
    });
    p.addEventListener('blur', function () { if (!self.down) self.release(); });
  }
  SleepScrubber.prototype.msPerPx = function () { return (this.t1 - this.t0) / Math.max(1, this.w - 46); };

  SleepScrubber.prototype.set = function (d) {
    this.d = d && Array.isArray(d.hr) && d.hrStart ? d : null;
    var empty = this.el.querySelector('.scrub__empty');
    if (!this.d) {
      empty.hidden = false; empty.textContent = (d && d.emptyText) || 'No night yet. Wear your band to bed.';
      this.sum.textContent = ''; this.at.hidden = true; this.layout(); return;
    }
    empty.hidden = true;
    var D = this.d;
    this.t0 = Number(D.hrStart); this.t1 = Math.max(Number(D.end) || 0, this.t0 + D.hr.length * 60000);
    // stage at each minute from hrStart (null where no stage is known)
    var n = Math.ceil((this.t1 - this.t0) / 60000), st = new Array(n).fill(null), off = Math.round((Number(D.start) - this.t0) / 60000);
    (D.blocks || []).forEach(function (b) { for (var i = 0; i < b[2]; i++) { var k = off + b[1] + i; if (k >= 0 && k < n) st[k] = b[0]; } });
    this.st = st;
    var vals = D.hr.filter(function (v) { return v != null && v > 0; });
    this.lo = vals.length ? Math.min.apply(null, vals) - 3 : 40; this.hi = vals.length ? Math.max.apply(null, vals) + 3 : 90;
    var sums = [0, 0, 0, 0]; (D.blocks || []).forEach(function (b) { sums[b[0]] += b[2]; });
    var asleep = sums[1] + sums[2] + sums[3];
    this.summary = (D.blocks && D.blocks.length ? hm(asleep) + ' asleep' : 'Stages need a longer night') + ' · ' + clock(D.start || this.t0) + ' to ' + clock(D.end || this.t1);
    this.sum.textContent = this.summary;
    this.plot.setAttribute('aria-valuetext', this.summary);
    this.layout();
  };

  SleepScrubber.prototype.layout = function () {
    var r = this.plot.getBoundingClientRect(), dpr = Math.min(3, root.devicePixelRatio || 1);
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height); this.dpr = dpr;
    [this.base, this.over].forEach(function (c) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); });
    this.drawBase(); this.ticks(); this.paint();
  };
  var PADL = 46;  // room for the lane names
  SleepScrubber.prototype.xOf = function (t) { return PADL + (t - this.t0) / (this.t1 - this.t0) * (this.w - PADL); };
  SleepScrubber.prototype.laneY = function (k) { var top = 8, H = this.h * 0.62 - top; return top + (k + 0.5) * H / 4; };
  SleepScrubber.prototype.hrY = function (v) { var top = this.h * 0.08, bot = this.h - 6; return bot - (v - this.lo) / (this.hi - this.lo || 1) * (bot - top); };

  SleepScrubber.prototype.drawBase = function () {
    var c = this.base.getContext('2d'), dpr = this.dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, this.w, this.h);
    if (!this.d) return;
    var self = this, D = this.d;
    // heart rate under the stages: a soft fill and a line, broken where there is no reading
    var hr = D.hr, path = [], seg = [];
    for (var m = 0; m < hr.length; m++) {
      if (hr[m] == null || hr[m] <= 0) { if (seg.length) path.push(seg); seg = []; continue; }
      seg.push([this.xOf(this.t0 + (m + 0.5) * 60000), this.hrY(hr[m])]);
    }
    if (seg.length) path.push(seg);
    path.forEach(function (s) {
      c.beginPath(); c.moveTo(s[0][0], self.h); s.forEach(function (p) { c.lineTo(p[0], p[1]); }); c.lineTo(s[s.length - 1][0], self.h); c.closePath();
      var gr = c.createLinearGradient(0, self.h * 0.1, 0, self.h); gr.addColorStop(0, 'rgba(255,55,95,.14)'); gr.addColorStop(1, 'rgba(255,55,95,0)');
      c.fillStyle = gr; c.fill();
      c.beginPath(); s.forEach(function (p, i) { if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); });
      c.strokeStyle = HEART; c.globalAlpha = 0.9; c.lineWidth = 1.5; c.lineJoin = 'round'; c.stroke(); c.globalAlpha = 1;
    });
    // lane guides
    c.strokeStyle = 'rgba(246,238,231,.07)'; c.lineWidth = 1;
    for (var k = 0; k < 4; k++) { var y = Math.round(this.laneY(k)) + 0.5; c.beginPath(); c.moveTo(PADL, y); c.lineTo(this.w, y); c.stroke(); }
    // stage runs: a bar in its lane, thin joins between lanes (a hypnogram)
    var runs = [], st = this.st;
    for (var i = 0; i < st.length;) { var j = i; while (j + 1 < st.length && st[j + 1] === st[i]) j++; if (st[i] != null) runs.push([st[i], i, j + 1]); i = j + 1; }
    var bh = Math.max(8, (this.h * 0.62 - 8) / 4 - 10);
    c.lineWidth = 1.5;
    for (var r = 1; r < runs.length; r++) {
      if (runs[r][1] !== runs[r - 1][2]) continue;
      var xj = this.xOf(this.t0 + runs[r][1] * 60000);
      var g = c.createLinearGradient(0, this.laneY(runs[r - 1][0]), 0, this.laneY(runs[r][0]));
      g.addColorStop(0, STAGES[runs[r - 1][0]].color); g.addColorStop(1, STAGES[runs[r][0]].color);
      c.strokeStyle = g; c.globalAlpha = 0.55; c.beginPath(); c.moveTo(xj, this.laneY(runs[r - 1][0])); c.lineTo(xj, this.laneY(runs[r][0])); c.stroke();
    }
    c.globalAlpha = 1;
    runs.forEach(function (run) {
      var x0 = self.xOf(self.t0 + run[1] * 60000), x1 = self.xOf(self.t0 + run[2] * 60000), y = self.laneY(run[0]) - bh / 2;
      c.fillStyle = STAGES[run[0]].color;
      rr(c, x0, y, Math.max(2, x1 - x0 - 0.5), bh, Math.min(4, bh / 2, (x1 - x0) / 2));
    });
  };
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); c.fill(); }

  SleepScrubber.prototype.ticks = function () {
    var box = this.el.querySelector('.scrub__ticks'); box.innerHTML = '';
    if (!this.d) return;
    var d = new Date(this.t0); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
    var span = (this.t1 - this.t0) / 3600000, every = span > 9 ? 3 : 2;
    for (var t = d.getTime(); t < this.t1 - 20 * 60000; t += 3600000) {
      if (new Date(t).getHours() % every) continue;
      var s = document.createElement('span'); s.style.left = this.xOf(t).toFixed(1) + 'px';
      var h = new Date(t).getHours(); s.textContent = (h % 12 || 12) + (h < 12 ? 'a' : 'p'); box.appendChild(s);
    }
  };

  SleepScrubber.prototype.read = function (x) {
    var t = this.t0 + (x - PADL) / (this.w - PADL) * (this.t1 - this.t0), m = Math.max(0, Math.min(this.st.length - 1, Math.floor((t - this.t0) / 60000)));
    var bpm = this.d.hr[m]; if (!(bpm > 0)) bpm = null;
    return { t: t, minute: m, stage: this.st[m], bpm: bpm };
  };
  SleepScrubber.prototype.move = function (clientX) { var r = this.plot.getBoundingClientRect(); this.moveLocal(Math.max(PADL, Math.min(this.w, clientX - r.left))); };
  SleepScrubber.prototype.moveLocal = function (x) {
    this.target = x; if (this.cx == null) this.cx = x;
    this.showing = true;
    var R = this.read(x);
    this.at.hidden = false; this.sum.hidden = true;
    this.el.querySelector('.scrub__time').textContent = clock(R.t);
    var sw = this.el.querySelector('.scrub__sw'), stEl = this.el.querySelector('.scrub__stage');
    sw.style.background = R.stage != null ? STAGES[R.stage].color : 'transparent'; sw.hidden = R.stage == null;
    stEl.textContent = R.stage != null ? STAGES[R.stage].name : 'No stage';
    this.el.querySelector('.scrub__bpm').textContent = R.bpm != null ? R.bpm + ' bpm' : 'No reading';
    this.plot.setAttribute('aria-valuenow', Math.round((x - PADL) / (this.w - PADL) * 100));
    this.plot.setAttribute('aria-valuetext', clock(R.t) + ', ' + (R.stage != null ? STAGES[R.stage].name : 'no stage') + ', ' + (R.bpm != null ? R.bpm + ' bpm' : 'no reading'));
    if (R.stage !== this.lastStage) { this.lastStage = R.stage; if (this.lastStage != null && this.opts.onTick) this.opts.onTick(R); }
    if (this.opts.onScrub) this.opts.onScrub(R);
    this.kick();
  };
  SleepScrubber.prototype.release = function () {
    if (!this.showing) return;
    this.showing = false; this.lastStage = -1;
    this.at.hidden = true; this.sum.hidden = false;
    this.plot.setAttribute('aria-valuetext', this.summary || '');
    if (this.opts.onScrub) this.opts.onScrub(null);
    this.kick();
  };
  SleepScrubber.prototype.kick = function () { var self = this; if (!this.raf) this.raf = root.requestAnimationFrame(function () { self.raf = 0; self.frame(); }); };
  SleepScrubber.prototype.frame = function () {
    // cursor eases toward the finger (a touch of smoothing, still within a frame or two) and fades
    if (this.target != null && this.cx != null) this.cx += (this.target - this.cx) * 0.55;
    var aim = this.showing ? 1 : 0; this.alpha += (aim - this.alpha) * (this.showing ? 0.5 : 0.22);
    if (!this.showing && this.alpha < 0.02) { this.alpha = 0; this.cx = null; this.target = null; }
    this.paint();
    if ((this.target != null && Math.abs(this.target - this.cx) > 0.3) || Math.abs(aim - this.alpha) > 0.02) this.kick();
  };
  SleepScrubber.prototype.paint = function () {
    var c = this.over.getContext('2d'), dpr = this.dpr || 1; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, this.w, this.h);
    if (!this.d || this.cx == null || this.alpha <= 0) return;
    var x = Math.round(this.cx) + 0.5, R = this.read(this.cx);
    c.globalAlpha = this.alpha;
    // dim everything outside a soft column around the cursor
    c.fillStyle = 'rgba(14,11,9,.32)'; c.fillRect(PADL, 0, Math.max(0, x - 1 - PADL), this.h); c.fillRect(x + 1, 0, this.w - x - 1, this.h);
    c.strokeStyle = 'rgba(246,238,231,.9)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, this.h); c.stroke();
    if (R.stage != null) { c.fillStyle = STAGES[R.stage].color; c.beginPath(); c.arc(x, this.laneY(R.stage), 6, 0, 7); c.fill(); c.strokeStyle = '#0E0B09'; c.lineWidth = 2; c.stroke(); }
    if (R.bpm != null) { var y = this.hrY(R.bpm); c.fillStyle = HEART; c.beginPath(); c.arc(x, y, 5, 0, 7); c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke(); }
    c.globalAlpha = 1;
  };
  SleepScrubber.prototype.destroy = function () { if (this.ro) this.ro.disconnect(); else root.removeEventListener('resize', this._resize); };

  SleepScrubber.STAGES = STAGES; SleepScrubber.clock = clock; SleepScrubber.hm = hm;
  root.SleepScrubber = SleepScrubber;
})(typeof window !== 'undefined' ? window : this);
