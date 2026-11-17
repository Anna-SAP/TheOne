/*
 * THE ONE — 音频测量引擎
 *
 * 输入一首歌的 PCM 采样，输出一组可复现的客观测量：
 * 响度（近似 ITU-R BS.1770 的 K 计权 LUFS）、节拍与律动稳定度、调性、
 * 频段平衡、声场宽度，以及基于自相似矩阵的“重复段落（hook）”检测。
 *
 * 这里只做测量，好坏判断（评分和判词）在 judge.js。
 * 唯一的例外是短视频切片：要在一段里挑出“最好用”的 5–10 秒，挑选本身就需要一把尺子，
 * 所以切片的五个分项在这里算好，judge.js 直接采用。
 * 不依赖 DOM，浏览器和 Node 都能跑。
 */
(function (root) {
  'use strict';

  var SR = 22050;      // 分析采样率
  var N = 2048;        // FFT 长度
  var HOP = 512;       // 帧移 ≈ 23 ms
  var FPS = SR / HOP;
  var CELL = 0.5;      // 结构分析的时间格（秒）
  var CHUNK = 0.1;     // 响度积分的最小块（秒）
  var NB = 32;         // 对数频带数
  var F_LO = 40, F_HI = 10500;

  // ---------- 基础工具 ----------

  function tick() {
    return new Promise(function (resolve) {
      if (typeof setImmediate === 'function') setImmediate(resolve);
      else setTimeout(resolve, 0);
    });
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    var a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    var i = (a.length - 1) * p;
    var lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function ramp(x, a, b) { return clamp((x - a) / (b - a), 0, 1); }
  function trap(x, a, b, c, d) { return x <= b ? ramp(x, a, b) : 1 - ramp(x, c, d); }

  /** 粗略重采样（盒式平均抗混叠 + 线性插值），只在浏览器无法直接按 22.05 kHz 解码时使用。 */
  function resample(x, from, to) {
    if (from === to) return x;
    var ratio = from / to;
    var n = Math.floor(x.length / ratio);
    var out = new Float32Array(n);
    if (ratio >= 1) {
      for (var i = 0; i < n; i++) {
        var a = i * ratio, b = Math.min(x.length, (i + 1) * ratio);
        var s = 0, c = 0;
        for (var j = Math.floor(a); j < b; j++) { s += x[j]; c++; }
        out[i] = c ? s / c : 0;
      }
    } else {
      for (var k = 0; k < n; k++) {
        var p = k * ratio, i0 = Math.floor(p), f = p - i0;
        out[k] = x[i0] * (1 - f) + (x[Math.min(x.length - 1, i0 + 1)] || 0) * f;
      }
    }
    return out;
  }

  // ---------- FFT（原位 radix-2） ----------

  var fftTables = null;
  function getFftTables() {
    if (fftTables) return fftTables;
    var rev = new Uint16Array(N), cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
    var bits = Math.log2(N);
    for (var i = 0; i < N; i++) {
      var r = 0;
      for (var b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      rev[i] = r;
    }
    for (var k = 0; k < N / 2; k++) {
      cos[k] = Math.cos(2 * Math.PI * k / N);
      sin[k] = Math.sin(2 * Math.PI * k / N);
    }
    var win = new Float32Array(N);
    for (var w = 0; w < N; w++) win[w] = 0.5 - 0.5 * Math.cos(2 * Math.PI * w / N);
    fftTables = { rev: rev, cos: cos, sin: sin, win: win };
    return fftTables;
  }

  function fft(re, im) {
    var t = getFftTables(), rev = t.rev, cos = t.cos, sin = t.sin;
    for (var i = 0; i < N; i++) {
      var j = rev[i];
      if (j > i) { var tr = re[i]; re[i] = re[j]; re[j] = tr; }
    }
    for (var size = 2; size <= N; size <<= 1) {
      var half = size >> 1, step = N / size;
      for (var s = 0; s < N; s += size) {
        for (var k = 0, ti = 0; k < half; k++, ti += step) {
          var a = s + k, b = a + half;
          var xr = re[b] * cos[ti] + im[b] * sin[ti];
          var xi = im[b] * cos[ti] - re[b] * sin[ti];
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  // ---------- 响度（K 计权） ----------

  function biquad(x, b0, b1, b2, a1, a2) {
    var y = new Float32Array(x.length);
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  /** BS.1770 的两级 K 计权：1.5 kHz 高架 +4 dB，再接 38 Hz 高通。 */
  function kWeight(x, sr) {
    var A = Math.pow(10, 4 / 40), w0 = 2 * Math.PI * 1500 / sr;
    var al = Math.sin(w0) / (2 * Math.SQRT1_2), c = Math.cos(w0), sq = 2 * Math.sqrt(A) * al;
    var a0 = (A + 1) - (A - 1) * c + sq;
    var y = biquad(x,
      A * ((A + 1) + (A - 1) * c + sq) / a0,
      -2 * A * ((A - 1) + (A + 1) * c) / a0,
      A * ((A + 1) + (A - 1) * c - sq) / a0,
      2 * ((A - 1) - (A + 1) * c) / a0,
      ((A + 1) - (A - 1) * c - sq) / a0);
    w0 = 2 * Math.PI * 38 / sr; al = Math.sin(w0) / (2 * 0.5); c = Math.cos(w0); a0 = 1 + al;
    return biquad(y, (1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0);
  }

  function toLufs(ms) { return ms > 1e-10 ? -0.691 + 10 * Math.log10(ms) : -100; }

  /** 返回每 100 ms 的 K 计权均方值前缀和，后面任何时间窗的响度都从这里取。 */
  function loudnessChunks(chans) {
    var len = Math.round(CHUNK * SR);
    var n = Math.floor(chans[0].length / len);
    var z = new Float64Array(n);
    for (var c = 0; c < chans.length; c++) {
      var y = kWeight(chans[c], SR);
      for (var i = 0; i < n; i++) {
        var s = 0, off = i * len;
        for (var j = 0; j < len; j++) { var v = y[off + j]; s += v * v; }
        z[i] += s / len;
      }
    }
    var pre = new Float64Array(n + 1);
    for (var k = 0; k < n; k++) pre[k + 1] = pre[k] + z[k];
    return { z: z, pre: pre, n: n };
  }

  /** 门限后的整合响度（400 ms 块、-70 LUFS 绝对门限、-10 LU 相对门限）。 */
  function integratedLufs(L) {
    var blocks = [];
    for (var i = 0; i + 4 <= L.n; i++) blocks.push((L.pre[i + 4] - L.pre[i]) / 4);
    var abs = blocks.filter(function (b) { return toLufs(b) > -70; });
    if (!abs.length) return -100;
    var mean = abs.reduce(function (a, b) { return a + b; }, 0) / abs.length;
    var rel = toLufs(mean) - 10;
    var kept = abs.filter(function (b) { return toLufs(b) > rel; });
    if (!kept.length) return toLufs(mean);
    return toLufs(kept.reduce(function (a, b) { return a + b; }, 0) / kept.length);
  }

  // ---------- 频谱一遍过：起音、色度、频带 ----------

  function buildBinMaps() {
    var half = N / 2;
    var band = new Int8Array(half + 1).fill(-1);
    var pcA = new Int8Array(half + 1).fill(-1), pcB = new Int8Array(half + 1), pcW = new Float32Array(half + 1);
    var share = new Int8Array(half + 1).fill(-1);
    var logSpan = Math.log(F_HI / F_LO);
    for (var k = 1; k <= half; k++) {
      var f = k * SR / N;
      if (f >= F_LO && f < F_HI) band[k] = Math.min(NB - 1, Math.floor(NB * Math.log(f / F_LO) / logSpan));
      if (f >= 110 && f <= 3500) {
        var pitch = 69 + 12 * Math.log2(f / 440);
        var lo = Math.floor(pitch);
        pcA[k] = ((lo % 12) + 12) % 12; pcB[k] = (pcA[k] + 1) % 12; pcW[k] = pitch - lo;
      }
      if (f >= 30 && f < F_HI) share[k] = f < 150 ? 0 : f < 500 ? 1 : f < 2000 ? 2 : f < 5000 ? 3 : 4;
    }
    return { band: band, pcA: pcA, pcB: pcB, pcW: pcW, share: share };
  }

  async function spectralPass(mono, nCells, onProgress) {
    var t = getFftTables(), maps = buildBinMaps();
    var nFrames = Math.max(0, Math.floor((mono.length - N) / HOP) + 1);
    var re = new Float32Array(N), im = new Float32Array(N);
    var onset = new Float32Array(nFrames), onsetLow = new Float32Array(nFrames);
    var prev = new Float32Array(NB), cur = new Float32Array(NB), bandPow = new Float32Array(NB);
    var cellChroma = new Float32Array(nCells * 12), cellBand = new Float32Array(nCells * 8);
    var cellCount = new Uint16Array(nCells);
    var chromaTotal = new Float64Array(12), shares = new Float64Array(5);
    var centNum = 0, centDen = 0;
    var half = N / 2, norm = 4 / N, lowBands = 0;
    var logSpan = Math.log(F_HI / F_LO);
    while (F_LO * Math.exp(logSpan * (lowBands + 1) / NB) < 150) lowBands++;

    for (var fr = 0; fr < nFrames; fr++) {
      var off = fr * HOP;
      for (var i = 0; i < N; i++) { re[i] = mono[off + i] * t.win[i]; im[i] = 0; }
      fft(re, im);
      bandPow.fill(0);
      var cell = Math.min(nCells - 1, Math.floor((off + half) / SR / CELL));
      var cc = cell * 12;
      for (var k = 1; k <= half; k++) {
        var mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
        var pw = mag * mag;
        var b = maps.band[k];
        if (b >= 0) bandPow[b] += pw;
        var s = maps.share[k];
        if (s >= 0) { shares[s] += pw; centNum += pw * k; centDen += pw; }
        if (maps.pcA[k] >= 0) {
          var w = maps.pcW[k];
          cellChroma[cc + maps.pcA[k]] += mag * (1 - w);
          cellChroma[cc + maps.pcB[k]] += mag * w;
        }
      }
      var flux = 0, fluxLow = 0;
      for (var bb = 0; bb < NB; bb++) {
        cur[bb] = Math.log(1 + 50 * Math.sqrt(bandPow[bb]));
        var d = cur[bb] - prev[bb];
        if (d > 0) { flux += d; if (bb <= lowBands) fluxLow += d; }
        prev[bb] = cur[bb];
        cellBand[cell * 8 + (bb >> 2)] += bandPow[bb];
      }
      onset[fr] = flux; onsetLow[fr] = fluxLow;
      cellCount[cell]++;
      if ((fr & 255) === 255) { if (onProgress) onProgress(fr / nFrames); await tick(); }
    }
    for (var c = 0; c < nCells; c++) {
      for (var p = 0; p < 12; p++) chromaTotal[p] += cellChroma[c * 12 + p];
      if (cellCount[c]) for (var q = 0; q < 8; q++) cellBand[c * 8 + q] /= cellCount[c];
    }
    var shareSum = shares.reduce(function (a, b) { return a + b; }, 0) || 1;
    return {
      onset: onset, onsetLow: onsetLow, cellChroma: cellChroma, cellBand: cellBand,
      chromaTotal: chromaTotal,
      shares: Array.prototype.map.call(shares, function (v) { return v / shareSum; }),
      centroidHz: centDen ? (centNum / centDen) * SR / N : 0
    };
  }

  // ---------- 节拍 ----------

  function rhythm(onset, onsetLow) {
    var n = onset.length;
    if (n < FPS * 8) return { bpm: 0, pulse: 0, onsetRate: 0, lowPulse: 0, env: null, period: 0 };
    // 去掉 1 秒滑动均值并半波整流，只留“冒头”的起音
    var env = new Float32Array(n), w = Math.round(FPS / 2), run = 0;
    var pre = new Float64Array(n + 1);
    for (var i = 0; i < n; i++) pre[i + 1] = pre[i] + onset[i];
    for (var t = 0; t < n; t++) {
      var a = Math.max(0, t - w), b = Math.min(n, t + w + 1);
      run = (pre[b] - pre[a]) / (b - a);
      env[t] = Math.max(0, onset[t] - run);
    }
    var minLag = Math.floor(FPS * 60 / 200), maxLag = Math.ceil(FPS * 60 / 55);
    var top = Math.min(n - 1, maxLag * 4 + 4);
    var ac = new Float32Array(top + 1), e0 = 0;
    for (var j = 0; j < n; j++) e0 += env[j] * env[j];
    if (e0 <= 0) return { bpm: 0, pulse: 0, onsetRate: 0, lowPulse: 0, env: null, period: 0 };
    for (var lag = 1; lag <= top; lag++) {
      var s = 0;
      for (var x = 0; x + lag < n; x++) s += env[x] * env[x + lag];
      ac[lag] = (s / e0) * (n / (n - lag));
    }
    function at(l) { return l <= top ? ac[l] : 0; }
    var best = minLag, bestScore = -1;
    for (var l = minLag; l <= maxLag; l++) {
      var comb = at(l) + 0.5 * at(2 * l) + 0.33 * at(3 * l) + 0.25 * at(4 * l);
      var oct = Math.log2((60 * FPS / l) / 120);
      var score = comb * Math.exp(-0.5 * (oct / 0.7) * (oct / 0.7));
      if (score > bestScore) { bestScore = score; best = l; }
    }
    // 在 4 倍周期处细化，把 BPM 的分辨率提高到 1% 以内
    var m = 4;
    while (m > 1 && best * m + 3 > top) m--;
    var c = best * m, pk = c;
    for (var d = c - 3; d <= c + 3; d++) if (d > 1 && d < top && ac[d] > ac[pk]) pk = d;
    var frac = 0;
    if (pk > 1 && pk < top) {
      var y0 = ac[pk - 1], y1 = ac[pk], y2 = ac[pk + 1], den = y0 - 2 * y1 + y2;
      if (den < 0) frac = clamp(0.5 * (y0 - y2) / den, -0.5, 0.5);
    }
    var period = (pk + frac) / m;

    // 起音密度：局部峰值计数
    var thr = 0.25 * percentile(env, 0.98), count = 0;
    for (var p = 3; p < n - 3; p++) {
      if (env[p] < thr) continue;
      var isPeak = true;
      for (var q = p - 3; q <= p + 3; q++) if (env[q] > env[p]) { isPeak = false; break; }
      if (isPeak) { count++; p += 2; }
    }
    var lowSum = 0, allSum = 0;
    for (var z = 0; z < n; z++) { lowSum += onsetLow[z]; allSum += onset[z]; }
    return {
      bpm: 60 * FPS / period,
      pulse: clamp(ac[best], 0, 1),
      onsetRate: count / (n / FPS),
      lowPulse: allSum ? lowSum / allSum : 0,
      env: env, period: period
    };
  }

  // ---------- 调性 ----------

  var KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  var NOTE = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

  function pearson(a, b, shift) {
    var n = a.length, ma = 0, mb = 0;
    for (var i = 0; i < n; i++) { ma += a[(i + shift) % n]; mb += b[i]; }
    ma /= n; mb /= n;
    var num = 0, da = 0, db = 0;
    for (var j = 0; j < n; j++) {
      var x = a[(j + shift) % n] - ma, y = b[j] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }

  function detectKey(chroma) {
    var best = { r: -2, tonic: 0, mode: 'major' };
    for (var t = 0; t < 12; t++) {
      var rM = pearson(chroma, KS_MAJOR, t), rm = pearson(chroma, KS_MINOR, t);
      if (rM > best.r) best = { r: rM, tonic: t, mode: 'major' };
      if (rm > best.r) best = { r: rm, tonic: t, mode: 'minor' };
    }
    var steps = best.mode === 'major' ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10];
    var sum = 0, penta = 0;
    for (var i = 0; i < 12; i++) sum += chroma[i];
    steps.forEach(function (s) { penta += chroma[(best.tonic + s) % 12]; });
    return {
      tonic: best.tonic, mode: best.mode,
      name: NOTE[best.tonic] + (best.mode === 'major' ? ' 大调' : ' 小调'),
      clarity: clamp(best.r, 0, 1),
      penta: sum ? penta / sum : 0
    };
  }

  // ---------- 结构：找出“会回来”的那一段 ----------

  /** 沿时间做 1-2-1 平滑，降低对半格错位和单个鼓点的敏感度。 */
  function smoothCells(src, nCells, dim) {
    var out = new Float32Array(src.length);
    for (var c = 0; c < nCells; c++) {
      var a = Math.max(0, c - 1), b = Math.min(nCells - 1, c + 1);
      for (var d = 0; d < dim; d++) out[c * dim + d] = (src[a * dim + d] + 2 * src[c * dim + d] + src[b * dim + d]) / 4;
    }
    return out;
  }

  /** 每格：去均值归一化的色度（和声）+ 相对频带电平（配器/能量），结构分析和切片共用。 */
  function cellFeatures(spec, nCells) {
    var chroma = smoothCells(spec.cellChroma, nCells, 12), band = smoothCells(spec.cellBand, nCells, 8);
    var ch = new Float32Array(nCells * 12), tb = new Float32Array(nCells * 8);
    var med = [];
    for (var b = 0; b < 8; b++) {
      var col = [];
      for (var c0 = 0; c0 < nCells; c0++) col.push(10 * Math.log10(band[c0 * 8 + b] + 1e-9));
      med.push(percentile(col, 0.5));
    }
    for (var c = 0; c < nCells; c++) {
      var m = 0, e = 0;
      for (var p = 0; p < 12; p++) m += chroma[c * 12 + p];
      m /= 12;
      for (var p2 = 0; p2 < 12; p2++) { var v = chroma[c * 12 + p2] - m; ch[c * 12 + p2] = v; e += v * v; }
      e = Math.sqrt(e);
      for (var p3 = 0; p3 < 12; p3++) ch[c * 12 + p3] = e > 1e-6 ? ch[c * 12 + p3] / e : 0;
      for (var q = 0; q < 8; q++) tb[c * 8 + q] = 10 * Math.log10(band[c * 8 + q] + 1e-9) - med[q];
    }
    return { ch: ch, tb: tb };
  }

  /** 两格之间的相似度 = 色度相关（和声） × 频带电平接近度（配器/能量） */
  function cellSim(F, i, j) {
    var dot = 0, dist = 0;
    for (var k = 0; k < 12; k++) dot += F.ch[i * 12 + k] * F.ch[j * 12 + k];
    for (var k2 = 0; k2 < 8; k2++) { var dd = F.tb[i * 8 + k2] - F.tb[j * 8 + k2]; dist += dd * dd; }
    return dot > 0 ? dot * Math.exp(-(dist / 8) / 50) : 0;
  }

  /**
   * 以每个长度为 W 的片段为参照，看全曲还有哪些地方和它“和声 + 配器”都对得上。
   * 对得上的区域连成片，中间隔着别的素材才算一次新的“登场”。
   * 得分最高的参照片段就是 hook。
   */
  function structure(F, nCells, W, loud, lufs) {
    if (nCells < W * 3) return null;
    var S = new Float32Array(nCells * nCells);
    for (var i = 0; i < nCells; i++) {
      for (var j = i; j < nCells; j++) {
        var sv = cellSim(F, i, j);
        S[i * nCells + j] = sv; S[j * nCells + i] = sv;
      }
    }
    // D(t,u)：两段长度为 W 的片段沿对角线的平均相似度
    var L = nCells - W + 1;
    var D = new Float32Array(L * L);
    for (var t = 0; t < L; t++) {
      for (var u = t; u < L; u++) {
        var val;
        if (t > 0) {
          val = D[(t - 1) * L + (u - 1)] + (S[(t + W - 1) * nCells + (u + W - 1)] - S[(t - 1) * nCells + (u - 1)]) / W;
        } else {
          val = 0;
          for (var w = 0; w < W; w++) val += S[w * nCells + (u + w)];
          val /= W;
        }
        D[t * L + u] = val; D[u * L + t] = val;
      }
    }

    var TAU = 0.5, GAP = Math.round(4 / CELL);
    function evaluate(t) {
      var row = t * L, bestP = 0, u;
      for (u = 0; u < L; u++) if (Math.abs(u - t) >= W && D[row + u] > bestP) bestP = D[row + u];
      if (bestP < TAU) return null;
      // 门槛跟着这段素材自己最好的一次重现走：只有“差不多一样”才算
      var thr = Math.max(TAU, 0.8 * bestP);
      var comps = [], covered = 0;
      for (u = 0; u < L; u++) {
        var self = u === t;
        if (!self && (Math.abs(u - t) < W / 2 || D[row + u] < thr)) continue;
        var last = comps[comps.length - 1], pv = self ? 0 : D[row + u];
        if (last && u <= last.end + GAP) { last.end = Math.max(last.end, u + W); if (pv > last.p) last.p = pv; }
        else comps.push({ start: u, end: u + W, p: pv });
      }
      var qs = 0, qn = 0;
      comps.forEach(function (cp) { covered += Math.min(cp.end, nCells) - cp.start; if (cp.p > 0) { qs += cp.p; qn++; } });
      var quality = qn ? qs / qn : 0;
      var energy = clamp(1 + (loud(t, t + W) - lufs) / 6, 0.5, 1.6);
      // “隔一段再回来”比“原地循环”值钱得多
      var weight = comps.length >= 2 ? comps.length : 0.6;
      return {
        score: Math.pow(weight, 0.8) * quality * energy,
        occ: comps.map(function (cp) { return cp.start; }),
        spans: comps.map(function (cp) { return [cp.start, Math.min(cp.end, nCells)]; }),
        returns: comps.length, coverage: covered / nCells, quality: quality
      };
    }
    var cands = new Array(L), best = -1;
    for (var t2 = 0; t2 < L; t2++) {
      cands[t2] = evaluate(t2);
      if (cands[t2] && (best < 0 || cands[t2].score > cands[best].score)) best = t2;
    }
    if (best < 0) return null;
    // 在得分相近的邻居里，取能量抬升最明显的那个起点，让片段对齐到段落入口
    var pick = best, bestLift = -Infinity;
    for (var t3 = Math.max(0, best - (W >> 1)); t3 <= Math.min(L - 1, best + (W >> 1)); t3++) {
      var cd = cands[t3];
      if (!cd || cd.score < 0.92 * cands[best].score || cd.returns < cands[best].returns) continue;
      var lf = t3 < 2 ? 0 : loud(t3, t3 + 8) - loud(Math.max(0, t3 - 8), t3);
      if (lf > bestLift) { bestLift = lf; pick = t3; }
    }
    return cands[pick];
  }

  // ---------- 短视频切片：在一段里挑出最好用的 5–10 秒 ----------

  var CLIP_WEIGHTS = { punch: 0.26, beat: 0.22, seam: 0.20, solid: 0.14, phone: 0.18 };

  /**
   * 切片是脱离整首歌单独使用的，所以这里只看片段自己：
   *   punch 起手     第一秒是不是就站住了（第一秒响度 vs 整段、起点有没有落在重音上）
   *   beat  卡点     片段内部的拍点清不清楚，画面能不能跟着切
   *   seam  循环接缝 播完跳回开头时接不接得上（长度取整小节，再比较“结尾之后”和“开头”）
   *   solid 不塌     中间有没有掉下去的空洞
   *   phone 手机外放 手机喇叭放得出来的频段（约 320 Hz–5 kHz）占多少能量
   * 这五项都不使用“回来几次”“等多久才出现”之类的全曲结构信息。
   */
  function clipScout(o) {
    var env = o.env, nFr = env ? env.length : 0;
    var ref = env ? percentile(env, 0.98) || 1 : 1;
    var bar = o.bpm > 0 ? 240 / o.bpm : 0, lens = [];
    for (var k = 1; bar > 0 && k * bar <= 10.001; k++) if (k * bar >= 5) lens.push({ len: k * bar, bars: k });
    if (!lens.length) lens = [6, 8, 10].map(function (l) { return { len: l, bars: null }; });

    function lufsAt(t0, t1) {
      var a = clamp(Math.round(t0 / CHUNK), 0, o.Lc.n), b = clamp(Math.round(t1 / CHUNK), 0, o.Lc.n);
      return b > a ? Math.max(-70, toLufs((o.Lc.pre[b] - o.Lc.pre[a]) / (b - a))) : -70;
    }

    function measure(s, len, bars) {
      var e = s + len, whole = lufsAt(s, e);
      var firstDb = lufsAt(s, s + 1) - whole;
      var f0 = Math.round(s * FPS), hit = 0, pulse = 0, hits = 0;
      var frS = clamp(Math.floor(s * FPS), 0, nFr), frE = clamp(Math.floor(e * FPS), 0, nFr);
      if (env) {
        for (var i = Math.max(0, f0 - 1); i <= Math.min(nFr - 1, f0 + 4); i++) if (env[i] > hit) hit = env[i];
        hit /= ref;
        var e0 = 0, P = Math.round(o.period);
        for (var j = frS; j < frE; j++) e0 += env[j] * env[j];
        for (var lag = Math.max(1, P - 1); P > 0 && e0 > 0 && lag <= P + 1; lag++) {
          var acc = 0, span = frE - frS;
          for (var x = frS; x + lag < frE; x++) acc += env[x] * env[x + lag];
          var ac = span > lag ? (acc / e0) * (span / (span - lag)) : 0;
          if (ac > pulse) pulse = ac;
        }
        for (var p = frS + 3; p < frE - 3; p++) {
          if (env[p] < 0.25 * ref) continue;
          var isPeak = true;
          for (var q = p - 3; q <= p + 3; q++) if (env[q] > env[p]) { isPeak = false; break; }
          if (isPeak) { hits++; p += 2; }
        }
      }
      var cs = clamp(Math.floor(s / CELL), 0, o.nCells - 1), ce = clamp(Math.floor(e / CELL), 0, o.nCells);
      var seamSim = ce + 1 < o.nCells && cs + 1 < o.nCells ? (cellSim(o.F, ce, cs) + cellSim(o.F, ce + 1, cs + 1)) / 2 : null;
      var jumpDb = Math.abs(lufsAt(e - 0.5, e) - lufsAt(s, s + 0.5));
      var dipDb = 0;
      for (var w = s; w + 1 <= e + 1e-6; w += 0.1) { var d = lufsAt(w, w + 1) - whole; if (d < dipDb) dipDb = d; }
      var mid = 0, all = 0;
      for (var c = cs; c < Math.max(ce, cs + 1) && c < o.nCells; c++) for (var b = 0; b < 8; b++) {
        var pw = o.cellBand[c * 8 + b];
        all += pw; if (b >= 3 && b <= 6) mid += pw;
      }
      var phoneDb = 10 * Math.log10((mid + 1e-12) / (all + 1e-12));
      var jumpScore = 1 - ramp(jumpDb, 1.5, 8);
      var parts = {
        punch: 0.6 * ramp(firstDb, -6, 0) + 0.4 * ramp(hit, 0.15, 0.8),
        beat: 0.7 * ramp(pulse, 0.1, 0.8) + 0.3 * trap(hits / len, 0.8, 2, 6, 9),
        seam: seamSim == null ? jumpScore : 0.6 * ramp(seamSim, 0.35, 0.95) + 0.4 * jumpScore,
        solid: ramp(dipDb, -8, -1),
        phone: ramp(phoneDb, -13, -2)
      };
      var score = 0;
      Object.keys(CLIP_WEIGHTS).forEach(function (key) { score += CLIP_WEIGHTS[key] * parts[key]; parts[key] = Math.round(parts[key] * 100); });
      return {
        start: Math.round(s * 100) / 100, len: Math.round(len * 100) / 100, bars: bars,
        score: Math.round(score * 1000) / 10, parts: parts,
        raw: { firstDb: firstDb, pulse: clamp(pulse, 0, 1), seamSim: seamSim, jumpDb: jumpDb, dipDb: dipDb, phoneDb: phoneDb, phoneShare: Math.pow(10, phoneDb / 10) }
      };
    }

    /** 在 [a, b] 秒之间找得分最高的切片。起点只取重音位置，长度只取整小节。 */
    function best(a, b) {
      var minLen = lens[0].len;
      a = clamp(a, 0, Math.max(0, o.duration - minLen));
      b = Math.min(o.duration, Math.max(b, a + minLen + 0.05));
      var starts = [a], peaks = [];
      for (var p = Math.max(3, Math.ceil(a * FPS)); env && p < Math.min(nFr - 3, Math.floor((b - minLen) * FPS)); p++) {
        if (env[p] < 0.2 * ref) continue;
        var isPeak = true;
        for (var q = p - 3; q <= p + 3; q++) if (env[q] > env[p]) { isPeak = false; break; }
        if (isPeak) peaks.push(p);
      }
      peaks.sort(function (x, y) { return env[y] - env[x]; });
      peaks.slice(0, 40).forEach(function (p) { starts.push(Math.max(a, p / FPS + 0.02)); });
      var top = null;
      starts.forEach(function (s) {
        lens.forEach(function (l) {
          if (s + l.len > b + 0.3 || s + l.len > o.duration) return;
          var m = measure(s, l.len, l.bars);
          if (!top || m.score > top.score) top = m;
        });
      });
      return top || measure(a, Math.min(minLen, o.duration - a), lens[0].bars);
    }

    return { best: best };
  }

  // ---------- 主流程 ----------

  /**
   * @param {{channels: Float32Array[], sampleRate: number}} input
   * @param {(fraction:number)=>void} [onProgress]
   */
  async function analyzeTrack(input, onProgress) {
    var chans = input.channels.slice(0, 2).map(function (c) { return resample(c, input.sampleRate, SR); });
    var n = chans[0].length;
    var duration = n / SR;
    if (duration < 15) throw new Error('太短了（不足 15 秒），听不出结构');

    var stereo = chans.length > 1;
    var mono = new Float32Array(n);
    var peak = 0, eM = 0, eS = 0, sumSq = 0;
    for (var i = 0; i < n; i++) {
      var l = chans[0][i], r = stereo ? chans[1][i] : l;
      var mid = (l + r) / 2, side = (l - r) / 2;
      mono[i] = mid; sumSq += mid * mid; eM += mid * mid; eS += side * side;
      var al = Math.abs(l), ar = Math.abs(r);
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
    }
    if (sumSq / n < 1e-9) throw new Error('这个文件几乎是静音');

    // 响度
    var Lc = loudnessChunks(chans);
    var lufs = integratedLufs(Lc);
    var per = Math.round(CELL / CHUNK);
    var nCells = Math.floor(Lc.n / per);
    function loud(c0, c1) { // 以“格”为单位的任意时间窗响度
      var a = clamp(Math.round(c0 * per), 0, Lc.n), b = clamp(Math.round(c1 * per), 0, Lc.n);
      return b > a ? Math.max(-70, toLufs((Lc.pre[b] - Lc.pre[a]) / (b - a))) : -70;
    }
    if (onProgress) onProgress(0.08);
    await tick();

    // 频谱（先把整体电平归一，让起音/频带特征与母带响度无关）
    var gain = 0.1 / Math.sqrt(sumSq / n);
    for (var g = 0; g < n; g++) mono[g] *= gain;
    var spec = await spectralPass(mono, nCells, function (f) { if (onProgress) onProgress(0.08 + 0.72 * f); });
    if (onProgress) onProgress(0.82);
    await tick();

    var rh = rhythm(spec.onset, spec.onsetLow);
    var key = detectKey(spec.chromaTotal);
    if (onProgress) onProgress(0.88);
    await tick();

    // 能量曲线：3 秒窗的短时响度
    var curve = new Float32Array(nCells);
    for (var c = 0; c < nCells; c++) curve[c] = loud(c - 3, c + 3);
    var active = Array.prototype.filter.call(curve, function (v) { return v > lufs - 20; });
    var lra = percentile(active, 0.95) - percentile(active, 0.10);

    // 进入状态的时间：响度第一次追上这首歌“正常工作”的下沿（活跃部分 30 分位再让 2 dB）
    var floor = percentile(active, 0.30) - 2;
    var intro = 0;
    for (var t = 0; t < nCells; t++) { if (loud(t, t + 4) >= floor) { intro = t * CELL; break; } }

    // 全曲最大的一次能量抬升（前后各 6 秒对比）
    var h = Math.min(12, Math.floor(nCells / 6));
    var lift = { db: 0, time: 0 };
    for (var u = h; u + h <= nCells; u++) {
      var before = loud(u - h, u);
      if (before < lufs - 30) continue; // 从静音里“抬升”不算
      var d = loud(u, u + h) - before;
      if (d > lift.db) lift = { db: d, time: u * CELL };
    }

    // 重复段落
    var W = Math.round(clamp(duration / 8, 4, 12) / CELL);
    var F = cellFeatures(spec, nCells);
    var st = structure(F, nCells, W, loud, lufs);
    if (onProgress) onProgress(0.97);
    await tick();

    var peakWin = { time: 0, db: -100 };
    for (var v = 0; v + W <= nCells; v++) {
      var lv = loud(v, v + W);
      if (lv > peakWin.db) peakWin = { time: v * CELL, db: lv };
    }

    var hook = null;
    if (st) {
      var lifts = st.occ.map(function (o) {
        var pre = Math.min(8, o);
        return pre >= 2 ? loud(o, o + W) - loud(o - pre, o) : 0;
      });
      hook = {
        start: st.occ[0] * CELL,
        len: W * CELL,
        times: st.occ.map(function (o) { return o * CELL; }),
        returns: st.returns,
        coverage: st.coverage,
        quality: st.quality,
        lift: Math.max.apply(null, lifts),
        liftTime: st.occ[lifts.indexOf(Math.max.apply(null, lifts))] * CELL,
        level: loud(st.occ[0], st.occ[0] + W) - lufs,
        escalation: loud(st.occ[st.occ.length - 1], st.occ[st.occ.length - 1] + W) - loud(st.occ[0], st.occ[0] + W)
      };
    }

    // 短视频切片：开头一段、hook 段各挑一条
    var scout = clipScout({ env: rh.env, period: rh.period, bpm: rh.bpm, Lc: Lc, F: F, cellBand: spec.cellBand, nCells: nCells, duration: duration });
    var firstSound = 0;
    for (var fs = 0; fs < Lc.n; fs++) { if (toLufs(Lc.z[fs]) > -60) { firstSound = fs * CHUNK; break; } }
    // 前奏切片的取材范围：开头 20 秒；如果第一次 hook 在这之前登场，就到 hook 为止
    var introEnd = firstSound + 20;
    if (hook && hook.returns >= 2 && hook.start - firstSound >= 10) introEnd = Math.min(introEnd, hook.start);
    var introClip = scout.best(firstSound, introEnd);
    // Hook 切片的取材范围：hook 的每一次登场；没有 hook 就取全曲最响的一段
    var spans = st ? st.spans.map(function (sp) { return [sp[0] * CELL, sp[1] * CELL]; }) : [[peakWin.time, peakWin.time + W * CELL]];
    var hookClip = null;
    spans.forEach(function (sp) {
      var cand = scout.best(Math.max(0, sp[0] - 0.5), Math.max(sp[1] + 0.5, sp[0] + 10.5));
      if (!hookClip || cand.score > hookClip.score) hookClip = cand;
    });
    hookClip.fromHook = !!st;
    if (onProgress) onProgress(0.99);
    await tick();

    // 波形缩略（显示用）
    var PK = 160, peaks = new Float32Array(PK), bucket = Math.floor(n / PK) || 1, pm = 0;
    for (var b = 0; b < PK; b++) {
      var mx = 0;
      for (var s = b * bucket, e = Math.min(n, s + bucket); s < e; s += 8) { var a = Math.abs(mono[s]); if (a > mx) mx = a; }
      peaks[b] = mx; if (mx > pm) pm = mx;
    }
    if (pm > 0) for (var k = 0; k < PK; k++) peaks[k] /= pm;

    var peakDb = 20 * Math.log10(peak || 1e-9);
    if (onProgress) onProgress(1);
    return {
      duration: duration,
      lufs: lufs,
      peakDb: peakDb,
      plr: peakDb - lufs,
      lra: lra,
      width: stereo ? eS / (eM + eS || 1) : null,
      bpm: rh.bpm, pulse: rh.pulse, onsetRate: rh.onsetRate, lowPulse: rh.lowPulse,
      bands: { low: spec.shares[0], lowMid: spec.shares[1], mid: spec.shares[2], presence: spec.shares[3], air: spec.shares[4] },
      centroidHz: spec.centroidHz,
      key: key,
      intro: intro,
      lift: lift,
      hook: hook,
      peakWin: { time: peakWin.time, len: W * CELL, level: peakWin.db - lufs },
      clips: { intro: introClip, hook: hookClip },
      curve: Array.prototype.slice.call(curve),
      cell: CELL,
      peaks: Array.prototype.slice.call(peaks)
    };
  }

  var api = { analyzeTrack: analyzeTrack, SAMPLE_RATE: SR, _internals: { detectKey: detectKey, rhythm: rhythm, kWeight: kWeight } };
  root.TheOne = root.TheOne || {};
  root.TheOne.analysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
