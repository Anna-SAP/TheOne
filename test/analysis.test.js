'use strict';
// 用已知答案的合成歌曲检验测量引擎：速度、段落位置、响度都是我们自己定的。
const test = require('node:test');
const assert = require('node:assert/strict');
const analysis = require('../js/analysis.js');
const demo = require('../js/demo.js');

const cache = new Map();
async function analyzed(i) {
  if (!cache.has(i)) {
    const song = demo.renderSong(demo.DEMOS[i]);
    cache.set(i, { song, f: await analysis.analyzeTrack(song) });
  }
  return cache.get(i);
}
const starts = (song, kind) => song.map.filter(s => s.kind === kind).map(s => s.start);

test('1 kHz 满幅正弦的整合响度约为 −3 LUFS（BS.1770 的定义）', async () => {
  const sr = 22050, x = new Float32Array(sr * 20);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * 997 * i / sr);
  const f = await analysis.analyzeTrack({ channels: [x], sampleRate: sr });
  assert.ok(Math.abs(f.lufs - (-3.01)) < 0.4, `lufs=${f.lufs}`);
  assert.equal(f.width, null, '单声道文件没有声场宽度');
});

test('速度：三首示例的 BPM 误差都在 1 以内', async () => {
  for (let i = 0; i < demo.DEMOS.length; i++) {
    const { f } = await analyzed(i);
    assert.ok(Math.abs(f.bpm - demo.DEMOS[i].bpm) < 1, `${demo.DEMOS[i].name}: ${f.bpm}`);
  }
});

test('hook：示例 A 的三次副歌入口全部命中（±2.5 秒）', async () => {
  const { song, f } = await analyzed(0);
  const chorus = starts(song, 'chorus');
  assert.equal(f.hook.returns, chorus.length);
  f.hook.times.forEach((t, i) => assert.ok(Math.abs(t - chorus[i]) <= 2.5, `第 ${i + 1} 次：${t} vs ${chorus[i]}`));
  assert.ok(f.hook.quality > 0.85);
  assert.ok(f.hook.lift > 3, '进副歌应当有明显抬升');
});

test('hook：从头循环到尾的示例 C 只算一次登场，而且几乎占满全曲', async () => {
  const { f } = await analyzed(2);
  assert.equal(f.hook.returns, 1);
  assert.ok(f.hook.coverage > 0.85, `coverage=${f.hook.coverage}`);
  assert.ok(f.lra < 2, '循环曲没有响度起伏');
});

test('开场：示例 A 几秒内进入状态，示例 B 要等前奏结束', async () => {
  const a = await analyzed(0), b = await analyzed(1);
  assert.ok(a.f.intro <= starts(a.song, 'verse')[0] + 1.5, `A intro=${a.f.intro}`);
  assert.ok(Math.abs(b.f.intro - starts(b.song, 'verse')[0]) <= 2.5, `B intro=${b.f.intro}`);
});

test('调性：示例 A（A 小调）被识别为 A 小调或它的关系大调 C', async () => {
  const { f } = await analyzed(0);
  const ok = (f.key.tonic === 9 && f.key.mode === 'minor') || (f.key.tonic === 0 && f.key.mode === 'major');
  assert.ok(ok, f.key.name);
});

test('太短或静音的文件会给出明确的错误', async () => {
  await assert.rejects(analysis.analyzeTrack({ channels: [new Float32Array(22050 * 5).fill(0.1)], sampleRate: 22050 }), /太短/);
  await assert.rejects(analysis.analyzeTrack({ channels: [new Float32Array(22050 * 20)], sampleRate: 22050 }), /静音/);
});

test('非 22.05 kHz 的输入会先降采样，结果一致', async () => {
  const sr = 44100, x = new Float32Array(sr * 20);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * 997 * i / sr);
  const f = await analysis.analyzeTrack({ channels: [x], sampleRate: sr });
  assert.ok(Math.abs(f.duration - 20) < 0.1);
  assert.ok(Math.abs(f.lufs - (-3.01)) < 0.6, `lufs=${f.lufs}`);
});
