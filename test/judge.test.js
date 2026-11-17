'use strict';
// 判词必须：只选一首、点名对手、引用这批歌自己的数字。
const test = require('node:test');
const assert = require('node:assert/strict');
const analysis = require('../js/analysis.js');
const demo = require('../js/demo.js');
const { judge, DIMS } = require('../js/judge.js');

let tracksPromise;
function tracks() {
  if (!tracksPromise) tracksPromise = Promise.all(demo.DEMOS.map(async d => ({ id: d.name, name: d.name, f: await analysis.analyzeTrack(demo.renderSong(d)) })));
  return tracksPromise;
}

test('权重加起来是 1', () => {
  assert.ok(Math.abs(DIMS.reduce((a, d) => a + d.weight, 0) - 1) < 1e-9);
});

test('只选一首：结构完整的示例 A 胜出，且与上传顺序无关', async () => {
  const t = await tracks();
  const v1 = judge(t), v2 = judge(t.slice().reverse());
  assert.equal(v1.winner.name, demo.DEMOS[0].name);
  assert.equal(v2.winner.name, v1.winner.name);
  assert.deepEqual(v2.ranked.map(r => r.name), v1.ranked.map(r => r.name));
  assert.equal(v1.ranked.filter(r => r.rank === 1).length, 1);
});

test('每条理由都点名了对手，并带着赢家自己的测量值', async () => {
  const v = judge(await tracks());
  const rivals = v.ranked.slice(1).map(r => r.name);
  assert.ok(v.reasons.length >= 1 && v.reasons.length <= 3);
  for (const r of v.reasons) {
    assert.ok(r.versus.length >= 1);
    assert.ok(r.versus.every(line => rivals.some(n => line.includes(n))), r.versus.join(' / '));
    assert.ok(/\d/.test(r.title + r.body.join('')), '理由里应当有具体数字');
    assert.ok(r.stats.length >= 1);
  }
  const hook = v.reasons.find(r => r.dim === 'hook');
  assert.ok(hook, '示例 A 的首要优势应当是 hook');
  const h = v.winner.f.hook;
  assert.ok(hook.title.includes(String(h.returns)));
});

test('落选的每一首都有一句针对它自己的判词', async () => {
  const v = judge(await tracks());
  assert.equal(v.verdicts.length, v.ranked.length - 1);
  const texts = v.verdicts.map(x => x.text);
  assert.equal(new Set(texts).size, texts.length, '不同的歌不应得到同一句话');
  const loop = v.verdicts.find(x => x.name.includes('循环'));
  assert.match(loop.text, /9\d%/, '循环曲的问题应当用它自己的覆盖率来说');
});

test('换一批歌，判词跟着变', async () => {
  const t = await tracks();
  const full = judge(t), pair = judge([t[1], t[2]]);
  assert.notEqual(pair.winner.name, full.winner.name);
  assert.notEqual(pair.reasons[0].title, full.reasons[0].title);
  assert.ok(pair.opening.includes('2 首'));
});

test('少于两首不判', () => {
  assert.throws(() => judge([{ id: 'a', name: 'a', f: {} }]), /至少/);
});
