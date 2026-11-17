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

test('记分表有九项：七项看整首歌，两项看切片', () => {
  assert.equal(DIMS.length, 9);
  assert.deepEqual(DIMS.filter(d => d.group === 'clip').map(d => d.id), ['introClip', 'hookClip']);
  // 原有七项之间的相对比例不变（各自按 77% 缩放后取整）
  const old = { hook: 26, payoff: 18, opening: 16, groove: 14, sound: 10, tonal: 8, form: 8 };
  for (const d of DIMS.filter(d => d.group === 'song')) assert.equal(Math.round(d.weight * 100), Math.round(old[d.id] * 0.77), d.id);
});

test('切片分只取决于切片自己：改掉全曲的 hook 结构，两项切片分不变', async () => {
  const { scoreTrack } = require('../js/judge.js');
  const f = (await tracks())[0].f;
  const base = scoreTrack(f).scores;
  assert.equal(base.introClip, f.clips.intro.score);
  assert.equal(base.hookClip, f.clips.hook.score);
  const altered = scoreTrack({ ...f, intro: 40, hook: { ...f.hook, returns: 1, coverage: 0.9, start: 90 } }).scores;
  assert.notEqual(altered.hook, base.hook);
  assert.notEqual(altered.opening, base.opening);
  assert.equal(altered.introClip, base.introClip);
  assert.equal(altered.hookClip, base.hookClip);
});

test('两首歌只有切片不同时：理由就是切片，并带着时间范围和具体读数', async () => {
  const f = (await tracks())[0].f;
  const worse = {
    intro: { ...f.clips.intro, score: 40, parts: { ...f.clips.intro.parts, punch: 15 }, raw: { ...f.clips.intro.raw, firstDb: -5.2 } },
    hook: { ...f.clips.hook, score: 55, parts: { ...f.clips.hook.parts, phone: 8 }, raw: { ...f.clips.hook.raw, phoneShare: 0.06 } }
  };
  const v = judge([{ id: 'a', name: '原版', f }, { id: 'b', name: '改版', f: { ...f, clips: worse } }]);
  assert.equal(v.winner.name, '原版');
  assert.deepEqual(v.reasons.map(r => r.dim).sort(), ['hookClip', 'introClip']);
  const hookReason = v.reasons.find(r => r.dim === 'hookClip');
  assert.match(hookReason.title, /^Hook 切片：\d+:\d\d–\d+:\d\d/);
  assert.match(hookReason.versus[0], /《改版》的 Hook 切片（.+）手机喇叭放得出来的频段只占 6% 的能量/);
  const introReason = v.reasons.find(r => r.dim === 'introClip');
  assert.match(introReason.versus[0], /第一秒比整段轻 5\.2 dB/);
  assert.match(v.verdicts[0].text, /切片/);
});
