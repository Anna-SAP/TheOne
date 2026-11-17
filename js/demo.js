/*
 * THE ONE — 示例歌曲合成器
 *
 * 用加法合成现场“写”几首结构不同的短歌，既给没带音频的人试用，
 * 也给测试提供已知答案（速度、调、段落位置都是我们自己定的）。
 * 不依赖 DOM，浏览器和 Node 都能跑。
 */
(function (root) {
  'use strict';

  var SR = 22050;
  var SCALE = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] };

  function rng(seed) { // mulberry32
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  // 段落配方：和弦走向（音阶级数）、各声部音量、鼓型、主旋律动机 [拍, 级数, 时值]
  var KINDS = {
    intro:  { prog: [0, 5, 2, 6], progMajor: [0, 4, 5, 3], pad: 0.5, bass: 0, kick: [], snare: [], hat: 0, lead: null, gain: 0.45 },
    verse:  { prog: [0, 5, 2, 6], progMajor: [0, 4, 5, 3], pad: 0.35, bass: 0.5, bassDiv: 1, kick: [0, 2.5], snare: [1, 3], hat: 0.5, hatDiv: 2,
              lead: [[0, 0, 1], [1.5, 2, 0.5], [2, 1, 1], [3, 0, 1], [4, 2, 1], [5.5, 4, 0.5], [6, 2, 2]], leadOct: 0, leadAmp: 0.3, gain: 0.62 },
    chorus: { prog: [5, 6, 0, 0], progMajor: [3, 4, 0, 5], pad: 0.6, bass: 0.7, bassDiv: 2, kick: [0, 1, 2, 3], snare: [1, 3], hat: 0.8, hatDiv: 4,
              lead: [[0, 4, 0.5], [0.5, 4, 0.5], [1, 6, 1], [2, 4, 0.5], [2.5, 2, 0.5], [3, 4, 1], [4, 7, 1.5], [5.5, 6, 0.5], [6, 4, 1], [7, 2, 1]],
              leadOct: 1, leadAmp: 0.5, gain: 1 },
    bridge: { prog: [3, 4, 3, 4], progMajor: [5, 3, 1, 4], pad: 0.55, bass: 0.3, bassDiv: 1, kick: [], snare: [], hat: 0.3, hatDiv: 2,
              lead: [[0, 2, 2], [2, 3, 2], [4, 4, 2], [6, 3, 2]], leadOct: 0, leadAmp: 0.3, gain: 0.5 },
    loop:   { prog: [0, 0, 5, 6], pad: 0.4, bass: 0.7, bassDiv: 2, kick: [0, 1, 2, 3], snare: [1, 3], hat: 0.7, hatDiv: 4,
              lead: [[0, 0, 0.5], [1, 2, 0.5], [2, 0, 0.5], [3, 4, 0.5], [4, 0, 0.5], [5, 2, 0.5], [6, 0, 0.5], [7, 6, 0.5]], leadOct: 0, leadAmp: 0.35, gain: 0.9 }
  };

  /**
   * @param {{bpm:number, tonic:number, mode:'major'|'minor', sections:{kind:string,bars:number}[], seed?:number, drive?:number}} spec
   * @returns {{channels: Float32Array[], sampleRate: number, map: {kind:string,start:number,end:number}[]}}
   */
  function renderSong(spec) {
    var beat = 60 / spec.bpm, bar = beat * 4;
    var totalBars = spec.sections.reduce(function (a, s) { return a + s.bars; }, 0);
    var n = Math.ceil((totalBars * bar + 1.5) * SR);
    var L = new Float32Array(n), R = new Float32Array(n);
    var rand = rng(spec.seed || 1);
    var scale = SCALE[spec.mode];

    function degree(d, base) { // 音阶级数 → MIDI 音高
      var oct = Math.floor(d / 7), i = ((d % 7) + 7) % 7;
      return base + spec.tonic + scale[i] + 12 * oct;
    }

    function tone(t0, dur, freq, amp, harm, pan, attack, release) {
      var s0 = Math.floor(t0 * SR), len = Math.floor((dur + release) * SR);
      var gl = amp * Math.cos(pan * Math.PI / 2), gr = amp * Math.sin(pan * Math.PI / 2);
      var w = 2 * Math.PI * freq / SR;
      for (var i = 0; i < len && s0 + i < n; i++) {
        var t = i / SR;
        var env = t < attack ? t / attack : t > dur ? Math.max(0, 1 - (t - dur) / release) : 1;
        var v = 0;
        for (var h = 0; h < harm.length; h++) if (harm[h]) v += harm[h] * Math.sin(w * (h + 1) * i);
        v *= env;
        L[s0 + i] += v * gl; R[s0 + i] += v * gr;
      }
    }

    function kick(t0, amp) {
      var s0 = Math.floor(t0 * SR), len = Math.floor(0.28 * SR), ph = 0;
      for (var i = 0; i < len && s0 + i < n; i++) {
        var t = i / SR, f = 45 + 110 * Math.exp(-t * 28);
        ph += 2 * Math.PI * f / SR;
        var v = amp * Math.sin(ph) * Math.exp(-t * 11);
        L[s0 + i] += v; R[s0 + i] += v;
      }
    }

    function noise(t0, amp, decay, bright, pan) {
      var s0 = Math.floor(t0 * SR), len = Math.floor(decay * 5 * SR), prev = 0;
      var gl = Math.cos(pan * Math.PI / 2), gr = Math.sin(pan * Math.PI / 2);
      for (var i = 0; i < len && s0 + i < n; i++) {
        var x = rand() * 2 - 1;
        var v = bright ? x - prev : (x + prev) / 2; // 一阶高通 / 低通
        prev = x;
        v *= amp * Math.exp(-(i / SR) / decay);
        L[s0 + i] += v * gl; R[s0 + i] += v * gr;
      }
    }

    var map = [], t = 0;
    spec.sections.forEach(function (sec) {
      var k = KINDS[sec.kind], g = k.gain;
      map.push({ kind: sec.kind, start: t, end: t + sec.bars * bar });
      for (var b = 0; b < sec.bars; b++) {
        var bt = t + b * bar;
        var prog = spec.mode === 'major' && k.progMajor ? k.progMajor : k.prog;
        var root = prog[b % prog.length];
        // 铺底和弦：三和弦，左右略微错开
        [0, 2, 4].forEach(function (third, vi) {
          var f = hz(degree(root + third, 60));
          tone(bt, bar * 0.98, f * 0.997, g * k.pad * 0.11, [1, 0.5, 0.33, 0.2], 0.08 + 0.08 * vi, 0.08, 0.1);
          tone(bt, bar * 0.98, f * 1.003, g * k.pad * 0.11, [1, 0.5, 0.33, 0.2], 0.92 - 0.08 * vi, 0.08, 0.1);
        });
        if (k.bass) {
          var steps = 4 * (k.bassDiv / 2) || 1, sl = bar / steps;
          if (k.bassDiv === 1) { steps = 1; sl = bar; }
          for (var s = 0; s < steps; s++) tone(bt + s * sl, sl * 0.8, hz(degree(root, 36)), g * k.bass * 0.4, [1, 0.6, 0.3], 0.5, 0.005, 0.04);
        }
        k.kick.forEach(function (bp) { kick(bt + bp * beat, g * 0.85); });
        k.snare.forEach(function (bp) {
          noise(bt + bp * beat, g * 0.45, 0.05, false, 0.5);
          tone(bt + bp * beat, 0.03, 190, g * 0.25, [1], 0.5, 0.001, 0.08);
        });
        if (k.hat) {
          var hn = 4 * k.hatDiv;
          for (var h = 0; h < hn; h++) noise(bt + h * bar / hn, g * k.hat * (h % 2 ? 0.1 : 0.16), 0.012, true, h % 2 ? 0.35 : 0.65);
        }
        if (k.lead && b % 2 === 0) {
          k.lead.forEach(function (note) {
            if (note[0] >= sec.bars * 4 - b * 4) return;
            tone(bt + note[0] * beat, note[2] * beat * 0.9, hz(degree(note[1], 72 + 12 * k.leadOct)), g * k.leadAmp * 0.3,
              [1, 0, 0.4, 0, 0.2], 0.5, 0.01, 0.06);
          });
        }
      }
      t += sec.bars * bar;
    });

    // 总线：软削波 + 归一
    var drive = spec.drive || 1.2, peak = 0;
    for (var i = 0; i < n; i++) {
      L[i] = Math.tanh(L[i] * drive); R[i] = Math.tanh(R[i] * drive);
      var m = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (m > peak) peak = m;
    }
    var norm = 0.94 / (peak || 1);
    for (var j = 0; j < n; j++) { L[j] *= norm; R[j] *= norm; }
    return { channels: [L, R], sampleRate: SR, map: map };
  }

  // 三首性格不同的示例：一首结构完整，一首慢热，一首从头循环到尾
  var DEMOS = [
    { name: '示例 A · 霓虹心跳', bpm: 124, tonic: 9, mode: 'minor', seed: 11, drive: 1.3,
      sections: [{ kind: 'intro', bars: 2 }, { kind: 'verse', bars: 8 }, { kind: 'chorus', bars: 8 }, { kind: 'verse', bars: 8 },
                 { kind: 'chorus', bars: 8 }, { kind: 'bridge', bars: 4 }, { kind: 'chorus', bars: 8 }] },
    { name: '示例 B · 慢热', bpm: 92, tonic: 2, mode: 'major', seed: 23, drive: 0.9,
      sections: [{ kind: 'intro', bars: 8 }, { kind: 'verse', bars: 12 }, { kind: 'bridge', bars: 4 }, { kind: 'verse', bars: 8 },
                 { kind: 'chorus', bars: 6 }, { kind: 'bridge', bars: 4 }] },
    { name: '示例 C · 无限循环', bpm: 140, tonic: 4, mode: 'minor', seed: 37, drive: 2.6,
      sections: [{ kind: 'loop', bars: 52 }] }
  ];

  /** 16-bit PCM WAV 编码（测试时把合成结果写成真实文件用）。 */
  function encodeWav(channels, sampleRate) {
    var nCh = channels.length, len = channels[0].length;
    var buf = new ArrayBuffer(44 + len * nCh * 2), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + len * nCh * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * 2, true);
    v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, len * nCh * 2, true);
    var o = 44;
    for (var i = 0; i < len; i++) for (var c = 0; c < nCh; c++) {
      var x = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7FFF, true); o += 2;
    }
    return buf;
  }

  var api = { renderSong: renderSong, DEMOS: DEMOS, encodeWav: encodeWav };
  root.TheOne = root.TheOne || {};
  root.TheOne.demo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
