'use strict';
// 解码失败时，应用要能说清楚这个文件到底是什么。
const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnose } = require('../js/sniff.js');

const str = s => [...s].map(c => c.charCodeAt(0));
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (type, payload = []) => [...u32(8 + payload.length), ...str(type), ...payload];
const bytes = (...parts) => Uint8Array.from(parts.flat());
function noise(n, seed = 7) { // 确定性的伪随机字节
  const out = new Uint8Array(n);
  let a = seed >>> 0;
  for (let i = 0; i < n; i++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; out[i] = a >>> 24; }
  return out;
}
// 最小的 moov：trak/mdia/minf/stbl/stsd，里面一条指定编码的采样描述
const stsd = (fourcc, extra = []) => box('stsd', [0, 0, 0, 0, ...u32(1), ...box(fourcc, new Array(28).fill(0)), ...extra]);
const moov = (fourcc, extra) => box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd(fourcc, extra))))));
const ftyp = box('ftyp', [...str('M4A '), 0, 0, 0, 0, ...str('M4A mp42isom')]);

test('没有任何文件头的高熵数据：判为加密或损坏，并点出扩展名', () => {
  const r = diagnose(noise(200000), 'Create.m4a');
  assert.equal(r.kind, 'scrambled');
  assert.match(r.message, /不是有效的 M4A/);
  assert.match(r.message, /加密或损坏/);
});

test('M4A 里是 ALAC：说明编码不支持，并给出 Safari / 转码两条路', () => {
  const r = diagnose(bytes(ftyp, moov('alac'), box('mdat', [...noise(4000)])), 'song.m4a');
  assert.equal(r.kind, 'unsupported-codec');
  assert.match(r.message, /ALAC/);
  assert.match(r.message, /Safari/);
});

test('M4A 带 DRM（enca 或 sinf）：判为版权保护', () => {
  assert.equal(diagnose(bytes(ftyp, moov('enca')), 'a.m4a').kind, 'drm');
  assert.equal(diagnose(bytes(ftyp, moov('mp4a', box('sinf', [0, 0, 0, 0]))), 'a.m4p').kind, 'drm');
});

test('M4A 没有 moov：判为文件不完整', () => {
  const r = diagnose(bytes(ftyp, box('mdat', [...noise(4000)])), 'a.m4a');
  assert.equal(r.kind, 'truncated');
  assert.match(r.message, /不完整/);
});

test('结构正常的 AAC M4A：不乱下结论，只建议换浏览器或转码', () => {
  const r = diagnose(bytes(ftyp, moov('mp4a'), box('mdat', [...noise(4000)])), 'a.m4a');
  assert.equal(r.kind, 'unknown');
  assert.match(r.message, /结构是正常的 M4A/);
});

test('moov 在文件末尾（常见的未优化 M4A）也能读到编码', () => {
  const r = diagnose(bytes(ftyp, box('mdat', [...noise(4000)]), moov('ec-3')), 'a.m4a');
  assert.equal(r.kind, 'unsupported-codec');
  assert.match(r.message, /杜比/);
});

test('音乐 App 的加密缓存：按文件头或扩展名认出来源', () => {
  assert.match(diagnose(bytes(str('CTENFDAM'), [...noise(500)]), 'x.mp3').message, /网易云音乐/);
  assert.match(diagnose(noise(5000), 'x.mgg').message, /QQ 音乐/);
  assert.equal(diagnose(noise(5000), 'x.kgm').kind, 'app-encrypted');
});

test('其他情况：WMA、AIFF、MIDI、改了扩展名的文本、空文件', () => {
  assert.match(diagnose(bytes([0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11], [...noise(100)]), 'a.wma').message, /WMA/);
  assert.match(diagnose(bytes(str('FORM'), u32(100), str('AIFF'), [...noise(100)]), 'a.aiff').message, /Safari/);
  assert.equal(diagnose(bytes(str('MThd'), [...noise(100)]), 'a.mid').kind, 'not-audio');
  assert.equal(diagnose(bytes(str('hello, this is a text file. '.repeat(40))), 'a.mp3').kind, 'not-audio');
  assert.equal(diagnose(new Uint8Array(4), 'a.mp3').kind, 'not-audio');
});

test('压缩编码的 WAV 与正常 PCM WAV 区分开', () => {
  const wav = tag => bytes(str('RIFF'), [0, 0, 0, 0], str('WAVE'), str('fmt '), [16, 0, 0, 0], [tag & 255, tag >> 8], new Array(30).fill(0));
  assert.equal(diagnose(wav(2), 'a.wav').kind, 'unsupported-codec');
  assert.equal(diagnose(wav(1), 'a.wav').kind, 'unknown');
});
