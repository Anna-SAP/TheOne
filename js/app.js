/*
 * THE ONE — 界面
 * 上传 → 逐首解码与测量 → 调 judge 出判词 → 渲染判决页（含可试听的片段）。
 */
(function () {
  'use strict';

  var T = window.TheOne;
  var analysis = T.analysis, judge = T.judge, demo = T.demo;
  var fmtTime = judge.format.time;

  var MAX_TRACKS = 12, MAX_BYTES = 200 * 1024 * 1024, MAX_SECONDS = 15 * 60;
  var SVG = 'http://www.w3.org/2000/svg';

  var state = { tracks: [], busy: false, seq: 0 };

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    upload: $('stage-upload'), verdict: $('stage-verdict'), drop: $('drop'), input: $('file-input'),
    queue: $('queue'), note: $('queue-note'), start: $('btn-start'), clear: $('btn-clear'), demo: $('btn-demo'),
    criteria: $('criteria-list')
  };

  // ---------- DOM 小工具 ----------

  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (kid) { if (kid) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid); });
    return node;
  }
  function s(tag, attrs) {
    var node = document.createElementNS(SVG, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k]; else node.setAttribute(k, attrs[k]);
    });
    return node;
  }

  // ---------- 队列 ----------

  function setNote(text, isError) {
    el.note.textContent = text || '';
    el.note.classList.toggle('is-error', !!isError);
  }

  function addFiles(fileList) {
    if (state.busy) return;
    var added = 0, skipped = [];
    Array.prototype.forEach.call(fileList, function (file) {
      var looksAudio = /^audio\//.test(file.type) || /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|aif|aiff|wma|webm)$/i.test(file.name);
      if (!looksAudio) { skipped.push(file.name + '（不是音频）'); return; }
      if (file.size > MAX_BYTES) { skipped.push(file.name + '（超过 200 MB）'); return; }
      if (state.tracks.some(function (t) { return t.file && t.file.name === file.name && t.file.size === file.size; })) return;
      if (state.tracks.length >= MAX_TRACKS) { skipped.push(file.name + '（最多 ' + MAX_TRACKS + ' 首）'); return; }
      state.tracks.push({ id: 't' + (++state.seq), name: file.name.replace(/\.[^.]+$/, '').trim() || file.name, file: file, status: 'queued', progress: 0 });
      added++;
    });
    if (added) dropVerdict();
    setNote(skipped.length ? '没有加入：' + skipped.join('、') : '', skipped.length > 0);
    renderQueue();
  }

  /** 队列一变，旧判决就作废 */
  function dropVerdict() {
    stopPlayback();
    el.verdict.hidden = true;
    el.verdict.textContent = '';
  }

  function statusText(t) {
    if (t.status === 'queued') return t.file ? (t.file.size / 1048576).toFixed(1) + ' MB，等待中' : '合成示例，等待中';
    if (t.status === 'decoding') return t.file ? '解码中…' : '合成中…';
    if (t.status === 'analyzing') return '正在听… ' + Math.round(t.progress * 100) + '%';
    if (t.status === 'error') return t.error;
    var f = t.f;
    return fmtTime(f.duration) + ' · ≈' + Math.round(f.bpm) + ' BPM · ' + f.key.name + ' · −' + Math.abs(f.lufs).toFixed(1) + ' LUFS';
  }

  function drawWave(canvas, peaks) {
    var dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 300, hgt = 28;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
    var c = canvas.getContext('2d');
    c.scale(dpr, dpr);
    c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--mark').trim() || '#888';
    var step = w / peaks.length;
    for (var i = 0; i < peaks.length; i++) {
      var bh = Math.max(1, peaks[i] * hgt);
      c.fillRect(i * step, (hgt - bh) / 2, Math.max(1, step - 1), bh);
    }
  }

  function renderQueue() {
    el.queue.textContent = '';
    state.tracks.forEach(function (t, i) {
      var meta = h('span', { class: 'q-meta num' + (t.status === 'error' ? ' is-error' : ''), text: statusText(t) });
      var row = h('li', { class: 'q-row', 'data-id': t.id }, [
        h('span', { class: 'q-idx num', text: String(i + 1).padStart(2, '0') }),
        h('span', { class: 'q-name', text: t.name }),
        state.busy ? null : h('button', { class: 'q-remove', type: 'button', 'aria-label': '移除 ' + t.name, text: '移除', onclick: function () {
          state.tracks = state.tracks.filter(function (x) { return x !== t; });
          dropVerdict();
          renderQueue();
        } }),
        meta
      ]);
      if (t.status === 'decoding' || t.status === 'analyzing') {
        var fill = h('i');
        fill.style.width = Math.round(t.progress * 100) + '%';
        row.appendChild(h('span', { class: 'q-bar' }, [fill]));
      }
      if (t.status === 'done') {
        var cv = h('canvas', { class: 'q-wave', 'aria-hidden': 'true' });
        row.appendChild(cv);
        requestAnimationFrame(function () { drawWave(cv, t.f.peaks); });
      }
      t.row = row; t.metaEl = meta;
      el.queue.appendChild(row);
    });
    var n = state.tracks.length;
    el.start.disabled = state.busy || n < 2;
    el.start.textContent = state.busy ? '正在听…' : n >= 2 ? '开始听这 ' + n + ' 首' : n === 1 ? '再加一首才有的比' : '开始听';
    el.clear.hidden = state.busy || n === 0;
    el.demo.disabled = state.busy;
    el.drop.classList.toggle('is-busy', state.busy);
    el.input.disabled = state.busy;
  }

  function updateRow(t) {
    if (!t.row) return;
    t.metaEl.textContent = statusText(t);
    var fill = t.row.querySelector('.q-bar > i');
    if (fill) fill.style.width = Math.round(t.progress * 100) + '%';
  }

  // ---------- 解码 ----------

  function decodeWith(ctx, buf) {
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(buf, resolve, reject);
      if (p && p.catch) p.catch(reject);
    });
  }

  async function decodeFile(file) {
    var buf = await file.arrayBuffer();
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) throw new Error('这个浏览器不支持音频解码');
    var ctx;
    // 直接让浏览器按 22.05 kHz 解码；不支持就按 44.1 kHz 解，再由分析引擎降采样
    try { ctx = new Offline(2, analysis.SAMPLE_RATE, analysis.SAMPLE_RATE); }
    catch (e) { ctx = new Offline(2, 44100, 44100); }
    var audio;
    try { audio = await decodeWith(ctx, buf); }
    catch (e) {
      // 解码会把缓冲区清空，所以重新读一遍字节，看看这个文件到底是什么
      var why = null;
      try { why = T.sniff.diagnose(new Uint8Array(await file.arrayBuffer()), file.name); } catch (e2) { /* 读不了就用通用提示 */ }
      throw new Error(why ? why.message : '浏览器解不开这个文件，换成 mp3 / wav / m4a 再试');
    }
    if (audio.duration > MAX_SECONDS) throw new Error('超过 15 分钟，这不是一首歌的长度');
    var channels = [];
    for (var c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(audio.getChannelData(c));
    return { channels: channels, sampleRate: audio.sampleRate };
  }

  // ---------- 主流程 ----------

  function nextFrame() { return new Promise(function (r) { setTimeout(r, 30); }); }

  async function run() {
    if (state.busy || state.tracks.length < 2) return;
    state.busy = true;
    stopPlayback();
    el.verdict.hidden = true;
    state.tracks.forEach(function (t) { if (t.status !== 'done') { t.status = 'queued'; t.progress = 0; t.error = null; } });
    renderQueue();

    for (var i = 0; i < state.tracks.length; i++) {
      var t = state.tracks[i];
      if (t.status === 'done') continue;
      setNote('正在听第 ' + (i + 1) + ' / ' + state.tracks.length + ' 首：' + t.name);
      try {
        t.status = 'decoding'; renderQueue(); await nextFrame();
        var pcm = t.spec ? demo.renderSong(t.spec) : await decodeFile(t.file);
        if (t.spec) t.pcm = pcm;
        t.status = 'analyzing'; renderQueue();
        t.f = await analysis.analyzeTrack(pcm, function (p) { t.progress = p; updateRow(t); });
        t.status = 'done';
      } catch (err) {
        t.status = 'error';
        t.error = (err && err.message) || '分析失败';
      }
      renderQueue();
      await nextFrame();
    }

    state.busy = false;
    var ok = state.tracks.filter(function (t) { return t.status === 'done'; });
    renderQueue();
    if (ok.length < 2) {
      setNote('能听的不足两首，没法比。每个文件为什么听不了写在它下面，换掉它们再试。', true);
      return;
    }
    var failed = state.tracks.length - ok.length;
    setNote(failed ? '有 ' + failed + ' 首没能听，判决只在其余 ' + ok.length + ' 首之间做出。' : '听完了。判决在下面。', failed > 0);
    renderVerdict(judge.judge(ok.map(function (t) { return { id: t.id, name: t.name, f: t.f }; })));
  }

  function loadDemo() {
    if (state.busy) return;
    state.tracks = demo.DEMOS.map(function (d) {
      return { id: 't' + (++state.seq), name: d.name, spec: d, status: 'queued', progress: 0 };
    });
    setNote('');
    renderQueue();
    run();
  }

  // ---------- 试听 ----------

  var player = { ctx: null, source: null, btn: null, cache: null, token: 0 };

  function stopPlayback() {
    player.token++;
    if (player.source) { try { player.source.onended = null; player.source.stop(); } catch (e) { /* 已停止 */ } }
    player.source = null;
    if (player.btn) { player.btn.classList.remove('is-playing', 'is-loading'); player.btn.setAttribute('aria-pressed', 'false'); }
    player.btn = null;
  }

  async function bufferFor(track) {
    if (player.cache && player.cache.id === track.id) return player.cache.buffer;
    var buffer;
    if (track.pcm) {
      buffer = player.ctx.createBuffer(track.pcm.channels.length, track.pcm.channels[0].length, track.pcm.sampleRate);
      track.pcm.channels.forEach(function (ch, i) { buffer.getChannelData(i).set(ch); });
    } else {
      buffer = await decodeWith(player.ctx, await track.file.arrayBuffer());
    }
    player.cache = { id: track.id, buffer: buffer }; // 只留一首，控制内存
    return buffer;
  }

  async function togglePlay(track, start, len, btn) {
    var same = player.btn === btn;
    stopPlayback();
    if (same) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!player.ctx) player.ctx = new Ctx();
    if (player.ctx.state === 'suspended') player.ctx.resume();
    var token = player.token;
    player.btn = btn;
    btn.classList.add('is-loading');
    try {
      var buffer = await bufferFor(track);
      if (token !== player.token) return;
      var src = player.ctx.createBufferSource(), gain = player.ctx.createGain(), now = player.ctx.currentTime;
      len = Math.min(len, Math.max(0.5, buffer.duration - start));
      src.buffer = buffer;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(1, now + 0.04);
      gain.gain.setValueAtTime(1, now + len - 0.25);
      gain.gain.linearRampToValueAtTime(0, now + len);
      src.connect(gain); gain.connect(player.ctx.destination);
      src.onended = function () { if (player.source === src) stopPlayback(); };
      src.start(now, start, len);
      player.source = src;
      btn.classList.remove('is-loading');
      btn.classList.add('is-playing');
      btn.setAttribute('aria-pressed', 'true');
    } catch (e) {
      stopPlayback();
    }
  }

  function trackById(id) { return state.tracks.filter(function (t) { return t.id === id; })[0]; }

  function playButton(id, start, len, label) {
    var btn = h('button', { class: 'play', type: 'button', 'aria-pressed': 'false', text: (label ? label + ' ' : '') + fmtTime(start) + '–' + fmtTime(start + len) });
    btn.addEventListener('click', function () { togglePlay(trackById(id), start, len, btn); });
    return btn;
  }

  /** 这首歌最值得点开听的一段：有真正回归的 hook 就听 hook，否则听最响的一段 */
  function bestClip(r) {
    var hk = r.f.hook;
    if (hk && hk.returns >= 2) return { start: hk.start, len: hk.len, label: '听它的 hook' };
    if (hk) return { start: hk.start, len: hk.len, label: '听它循环的那一段' };
    return { start: r.f.peakWin.time, len: r.f.peakWin.len, label: '听它最响的一段' };
  }

  // ---------- 能量曲线 ----------

  var Y_MAX = 6, Y_MIN = -18;

  function energyChart(host, r, opts) {
    host.classList.add('chart');
    var tip = h('div', { class: 'tip', hidden: '' });
    var f = r.f;

    function draw() {
      var W = Math.max(240, host.clientWidth), H = opts.height;
      var m = { l: 34, r: 10, t: opts.small ? 16 : 22, b: 20 };
      var pw = W - m.l - m.r, ph = H - m.t - m.b;
      var xMax = opts.xMax || f.duration;
      var x = function (t) { return m.l + pw * t / xMax; };
      var y = function (db) { return m.t + ph * (Y_MAX - Math.max(Y_MIN, Math.min(Y_MAX, db))) / (Y_MAX - Y_MIN); };
      var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': r.name + ' 的能量曲线：短时响度相对全曲平均的变化' });
      var color = opts.accent ? 'var(--accent)' : 'var(--mark)';

      // 网格
      (opts.small ? [0, -12] : [6, 0, -6, -12, -18]).forEach(function (db) {
        svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: y(db), y2: y(db), stroke: 'var(--rule)', 'stroke-width': 1 }));
        svg.appendChild(s('text', { x: m.l - 6, y: y(db) + 4, 'text-anchor': 'end', text: (db > 0 ? '+' : db < 0 ? '−' : '') + Math.abs(db) }));
      });
      var step = xMax <= 150 ? 30 : xMax <= 420 ? 60 : 120;
      if (opts.small && W < 420) step *= 2;
      for (var tt = 0; tt <= xMax; tt += step) {
        svg.appendChild(s('text', { x: x(tt), y: H - 5, 'text-anchor': tt === 0 ? 'start' : 'middle', text: fmtTime(tt) }));
      }

      // hook 的每次登场：可点击试听的色带
      var bands = f.hook ? f.hook.times.map(function (t0, i) { return { t: t0, len: f.hook.len, label: String(i + 1) }; })
        : [{ t: f.peakWin.time, len: f.peakWin.len, label: '最响' }];
      bands.forEach(function (b) {
        var x0 = x(b.t), x1 = x(Math.min(f.duration, b.t + b.len));
        var hit = s('rect', { x: x0, y: m.t, width: Math.max(2, x1 - x0), height: ph, fill: 'transparent', class: 'hit', tabindex: 0, role: 'button',
          'aria-label': '播放 ' + r.name + ' ' + fmtTime(b.t) + ' 起的 ' + Math.round(b.len) + ' 秒' });
        var go = function () { togglePlay(trackById(r.id), b.t, b.len, hit); };
        hit.addEventListener('click', go);
        hit.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
        svg.appendChild(hit);
        svg.appendChild(s('rect', { x: x0, y: m.t, width: Math.max(2, x1 - x0 - 2), height: ph, class: 'band', 'pointer-events': 'none' }));
        svg.appendChild(s('text', { x: x0 + 4, y: m.t - 5, class: 'band-label', text: b.label }));
      });

      // 曲线
      var pts = [], cell = f.cell;
      for (var i = 0; i < f.curve.length; i++) pts.push([x(i * cell), y(f.curve[i] - f.lufs)]);
      var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
      var base = y(Y_MIN);
      svg.appendChild(s('path', { d: line + 'L' + pts[pts.length - 1][0].toFixed(1) + ' ' + base + 'L' + pts[0][0].toFixed(1) + ' ' + base + 'Z', fill: color, 'fill-opacity': 0.1, 'pointer-events': 'none' }));
      svg.appendChild(s('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'pointer-events': 'none' }));

      // 最大抬升的标注
      if (opts.mark) {
        var mt = opts.mark.time + 3, idx = Math.min(f.curve.length - 1, Math.round(mt / cell));
        var mx = x(idx * cell), my = y(f.curve[idx] - f.lufs), right = mx > W * 0.7;
        svg.appendChild(s('circle', { cx: mx, cy: my, r: 5, fill: color, stroke: 'var(--bg)', 'stroke-width': 2, 'pointer-events': 'none' }));
        svg.appendChild(s('text', { x: mx + (right ? -10 : 10), y: Math.max(m.t + 12, my - 10), 'text-anchor': right ? 'end' : 'start', class: 'lift-label', text: opts.mark.label }));
      }

      // 悬停读数
      var cross = s('line', { y1: m.t, y2: m.t + ph, stroke: 'var(--ink-3)', 'stroke-width': 1, visibility: 'hidden', 'pointer-events': 'none' });
      svg.appendChild(cross);
      svg.addEventListener('pointermove', function (ev) {
        var box = svg.getBoundingClientRect(), px = ev.clientX - box.left;
        var t = (px - m.l) / pw * xMax;
        if (t < 0 || t > f.duration) { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
        var ci = Math.min(f.curve.length - 1, Math.max(0, Math.round(t / cell)));
        var db = f.curve[ci] - f.lufs;
        cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
        tip.hidden = false;
        tip.textContent = fmtTime(t) + ' · ' + (db >= 0 ? '+' : '−') + Math.abs(db).toFixed(1) + ' dB';
        tip.style.left = Math.min(W - 60, Math.max(60, px)) + 'px';
        tip.style.top = m.t + 'px';
      });
      svg.addEventListener('pointerleave', function () { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });

      host.textContent = '';
      host.appendChild(svg);
      host.appendChild(tip);
    }

    draw();
    if (window.ResizeObserver) {
      var last = host.clientWidth;
      new ResizeObserver(function () { if (Math.abs(host.clientWidth - last) > 4) { last = host.clientWidth; stopPlayback(); draw(); } }).observe(host);
    }
  }

  // ---------- 判决页 ----------

  function voice(text) { return h('p', { class: 'voice', text: text }); }

  function dimBars(v, dimId, label) {
    var box = h('div', { class: 'bars', role: 'img', 'aria-label': label + ' 各首得分：' + v.ranked.map(function (r) { return r.name + ' ' + Math.round(r.scores[dimId]); }).join('，') });
    box.appendChild(h('span', { class: 'bars-cap', text: '「' + label + '」得分（0–100）' }));
    v.ranked.slice().sort(function (a, b) { return b.scores[dimId] - a.scores[dimId]; }).forEach(function (r) {
      var one = r === v.winner, fill = h('span', { class: 'bar-fill' + (one ? ' is-one' : '') });
      fill.style.width = Math.max(0, Math.min(100, r.scores[dimId])) + '%';
      box.appendChild(h('span', { class: 'bar-name' + (one ? ' is-one' : ''), text: r.name, title: r.name }));
      box.appendChild(h('span', { class: 'bar-track' }, [fill]));
      box.appendChild(h('span', { class: 'bar-val', text: String(Math.round(r.scores[dimId])) }));
    });
    return box;
  }

  function renderVerdict(v) {
    var root = el.verdict, w = v.winner, clip = bestClip(w);
    var xMax = Math.max.apply(null, v.ranked.map(function (r) { return r.f.duration; }));
    root.textContent = '';

    // 1. THE ONE
    root.appendChild(h('div', { class: 'one' }, [h('div', { class: 'wrap' }, [
      h('span', { class: 'one-eyebrow', text: 'THE ONE' }),
      h('h2', { class: 'one-name', text: w.name }),
      h('p', { class: 'one-tag', text: v.tagline }),
      h('div', { class: 'one-row' }, [
        h('div', { class: 'one-score' }, [h('b', { text: w.total.toFixed(1) }), h('span', { text: '爆款指数 / 100' })]),
        playButton(w.id, clip.start, clip.len, clip.label)
      ])
    ])]));

    var body = h('div', { class: 'wrap' });
    root.appendChild(body);

    // 2. 制作人陈述
    body.appendChild(h('div', { class: 'statement' }, [voice(v.opening), voice(v.because), voice(v.lane)]));

    // 3. 赢家的能量曲线
    var big = h('div');
    var hk = w.f.hook;
    body.appendChild(h('section', { class: 'block' }, [
      h('div', { class: 'block-head' }, [
        h('h2', { text: '它的能量曲线' }),
        h('p', { text: '短时响度相对全曲平均的变化，单位 dB。' + (hk ? '色带是 hook 的每一次登场，点一下就能听。' : '色带是全曲最响的一段，点一下就能听。') })
      ]),
      big
    ]));

    // 4. 理由
    var reasons = h('ol', { class: 'reasons' });
    v.reasons.forEach(function (r, i) {
      reasons.appendChild(h('li', { class: 'reason' }, [
        h('span', { class: 'reason-no num', 'aria-hidden': 'true', text: String(i + 1) }),
        h('div', { class: 'reason-body' }, [
          h('span', { class: 'reason-label', text: '理由 ' + (i + 1) + ' · ' + r.label }),
          h('h3', { text: r.title })
        ].concat(r.body.map(voice)).concat([
          h('dl', { class: 'stats' }, r.stats.map(function (st) { return h('div', { class: 'stat' }, [h('dt', { text: st[0] }), h('dd', { text: st[1] })]); })),
          h('ul', { class: 'versus' }, r.versus.map(function (t) { return h('li', { text: t }); })),
          dimBars(v, r.dim, r.label)
        ]))
      ]));
    });
    body.appendChild(h('section', { class: 'block' }, [
      h('div', { class: 'block-head' }, [h('h2', { text: '为什么是它' })]),
      reasons
    ]));

    // 4b. 短视频切片
    body.appendChild(clipSection(v));

    // 5. 落选的歌
    var rivals = h('ol', { class: 'rivals' }), charts = [];
    v.verdicts.forEach(function (rv) {
      var r = v.ranked.filter(function (x) { return x.id === rv.id; })[0], rc = bestClip(r), host = h('div');
      charts.push([host, r]);
      rivals.appendChild(h('li', { class: 'rival' }, [
        h('div', { class: 'rival-text' }, [
          h('div', { class: 'rival-head' }, [
            h('span', { class: 'rival-rank num', text: '#' + rv.rank }),
            h('span', { class: 'rival-name', text: rv.name }),
            h('span', { class: 'rival-score num', text: rv.total.toFixed(1) })
          ]),
          voice(rv.text),
          h('div', {}, [playButton(r.id, rc.start, rc.len, rc.label)])
        ]),
        h('figure', { class: 'rival-chart' }, [h('figcaption', { text: '能量曲线（同一刻度）' }), host])
      ]));
    });
    body.appendChild(h('section', { class: 'block' }, [
      h('div', { class: 'block-head' }, [
        h('h2', { text: v.verdicts.length === 1 ? '另一首为什么不是' : '另外 ' + v.verdicts.length + ' 首为什么不是' }),
        h('p', { text: '每首的能量曲线和上面那张用同一把尺子画：纵轴都是 −18 到 +6 dB，横轴都按最长的那首来排。' })
      ]),
      rivals
    ]));

    // 6. 要改的一处
    body.appendChild(h('section', { class: 'block' }, [
      h('div', { class: 'block-head' }, [h('h2', { text: '进棚前我只改一处' })]),
      h('div', { class: 'fix' }, [
        h('span', { class: 'fix-label', text: '它最弱的一项 · ' + v.fix.label + ' ' + Math.round(v.fix.score) + ' 分' }),
        voice(v.fix.text)
      ])
    ]));

    // 7. 全部分数
    var firstClip = judge.DIMS.filter(function (d) { return d.group === 'clip'; })[0];
    var head = h('tr', {}, [h('th', { scope: 'col', text: '歌曲' })].concat(judge.DIMS.map(function (d) {
      return h('th', { scope: 'col', class: d === firstClip ? 'grp' : '' }, [d.label, h('span', { class: 'wt', text: Math.round(d.weight * 100) + '%' })]);
    })).concat([h('th', { scope: 'col', class: 'grp', text: '总分' })]));
    var rows = v.ranked.map(function (r) {
      return h('tr', { class: r === w ? 'is-one' : '' }, [h('td', { text: r.rank + '. ' + r.name })].concat(judge.DIMS.map(function (d) {
        return h('td', { class: d === firstClip ? 'grp' : '', text: String(Math.round(r.scores[d.id])) });
      })).concat([h('td', { class: 'total grp', text: r.total.toFixed(1) })]));
    });
    body.appendChild(h('section', { class: 'block' }, [
      h('div', { class: 'block-head' }, [h('h2', { text: '完整记分表' }), h('p', { text: '每项 0–100 分，表头是它在总分里的权重。前七项看整首歌，后两项看剪下来的切片。' })]),
      h('div', { class: 'table-scroll' }, [h('table', { class: 'scores' }, [h('thead', {}, [head]), h('tbody', {}, rows)])])
    ]));

    // 8. 收尾
    body.appendChild(h('div', { class: 'closing' }, [
      voice(v.closing),
      h('span', { class: 'sign', text: '—— THE ONE 试听室 · 制作人独家判断' }),
      h('button', { class: 'btn btn-ghost', type: 'button', text: '换一批歌再来', onclick: reset })
    ]));

    root.hidden = false;
    var p = payoffLabel(w);
    energyChart(big, w, { height: window.innerWidth < 600 ? 220 : 280, accent: true, mark: p });
    charts.forEach(function (c) { energyChart(c[0], c[1], { height: 130, small: true, xMax: xMax }); });
    root.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  // ---------- 短视频切片 ----------

  function clipCard(r, kind, name) {
    var c = r.f.clips[kind];
    var meters = h('div', { class: 'meters' });
    judge.clip.readout(c).forEach(function (m) {
      var fill = h('span', { class: 'bar-fill is-one' });
      fill.style.width = m.score + '%';
      meters.appendChild(h('span', { class: 'meter-label', text: m.label, title: m.blurb }));
      meters.appendChild(h('span', { class: 'bar-track' }, [fill]));
      meters.appendChild(h('span', { class: 'bar-val', text: String(m.score) }));
      meters.appendChild(h('span', { class: 'meter-text', text: m.text }));
    });
    return h('div', { class: 'clip-card' }, [
      h('div', { class: 'clip-head' }, [
        h('span', { class: 'clip-name', text: name }),
        h('span', { class: 'clip-score num', text: String(Math.round(c.score)) })
      ]),
      h('p', { class: 'clip-where num', text: judge.clip.range(c) + ' · ' + c.len.toFixed(1) + ' 秒' + (c.bars ? ' · ' + c.bars + ' 小节' : '') }),
      kind === 'hook' && !c.fromHook ? h('p', { class: 'clip-note', text: '这首歌没有会回来的 hook，取的是全曲最响的一段。' }) : null,
      h('div', {}, [playButton(r.id, c.start, c.len, '听这条切片')]),
      meters
    ]);
  }

  function clipSection(v) {
    var w = v.winner;
    var head = h('tr', {}, [
      h('th', { scope: 'col', text: '歌曲' }), h('th', { scope: 'col', text: '前奏切片' }), h('th', { scope: 'col', text: '分' }),
      h('th', { scope: 'col', text: 'Hook 切片' }), h('th', { scope: 'col', text: '分' })
    ]);
    var rows = v.ranked.map(function (r) {
      var a = r.f.clips.intro, b = r.f.clips.hook;
      return h('tr', { class: r === w ? 'is-one' : '' }, [
        h('td', { text: r.rank + '. ' + r.name }),
        h('td', {}, [playButton(r.id, a.start, a.len, '')]), h('td', { class: 'total', text: String(Math.round(a.score)) }),
        h('td', {}, [playButton(r.id, b.start, b.len, '')]), h('td', { class: 'total', text: String(Math.round(b.score)) })
      ]);
    });
    return h('section', { class: 'block' }, [
      h('div', { class: 'block-head' }, [
        h('h2', { text: '剪下来的那几秒' }),
        h('p', { text: '每首歌在开头和 hook 段里各挑出最好用的 5–10 秒：长度取整小节，起点落在重音上。打分只看片段自己的五件事：起手、卡点、循环接缝、不塌、手机外放。hook 回来几次、要等多久才出现，归「Hook 记忆点」和「黄金开场」管，这里不重复计。' })
      ]),
      h('div', { class: 'clips' }, [clipCard(w, 'intro', '前奏切片'), clipCard(w, 'hook', 'Hook 切片')]),
      h('div', { class: 'table-scroll' }, [h('table', { class: 'scores clips-table' }, [
        h('caption', { text: '每一首该剪哪两段' }), h('thead', {}, [head]), h('tbody', {}, rows)
      ])])
    ]);
  }

  function payoffLabel(w) {
    var f = w.f, global = 0.6 * f.lift.db;
    if (f.hook && f.hook.lift >= global && f.hook.lift >= 1) return { time: f.hook.liftTime, label: '+' + f.hook.lift.toFixed(1) + ' dB' };
    if (f.lift.db >= 1) return { time: f.lift.time, label: '+' + f.lift.db.toFixed(1) + ' dB' };
    return null;
  }

  function reset() {
    stopPlayback();
    player.cache = null;
    state.tracks = [];
    el.verdict.hidden = true;
    el.verdict.textContent = '';
    setNote('');
    renderQueue();
    el.upload.scrollIntoView({ block: 'start' });
  }

  // ---------- 事件 ----------

  [['song', '整首歌'], ['clip', '剪下来的那几秒']].forEach(function (g) {
    el.criteria.appendChild(h('li', { class: 'criteria-group', text: g[1] }));
    judge.DIMS.filter(function (d) { return d.group === g[0]; }).forEach(function (d) {
      el.criteria.appendChild(h('li', {}, [h('b', { text: d.label }), h('em', { text: Math.round(d.weight * 100) + '%' }), h('span', { text: d.blurb })]));
    });
  });

  el.input.addEventListener('change', function () { addFiles(el.input.files); el.input.value = ''; });
  ['dragenter', 'dragover'].forEach(function (type) {
    el.drop.addEventListener(type, function (ev) { ev.preventDefault(); if (!state.busy) el.drop.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    el.drop.addEventListener(type, function (ev) { ev.preventDefault(); el.drop.classList.remove('is-over'); });
  });
  el.drop.addEventListener('drop', function (ev) { if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files); });
  // 拖偏了也别让浏览器直接打开文件
  window.addEventListener('dragover', function (ev) { ev.preventDefault(); });
  window.addEventListener('drop', function (ev) { ev.preventDefault(); });

  el.start.addEventListener('click', run);
  el.clear.addEventListener('click', reset);
  el.demo.addEventListener('click', loadDemo);

  renderQueue();
})();
