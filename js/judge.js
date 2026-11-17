/*
 * THE ONE — 评分与判词
 *
 * 输入：每首歌的客观测量（analysis.js 的输出）。
 * 输出：七个维度的分数、总排名，以及一份只选一首的制作人判词。
 *
 * 判词里的每一句都由这批歌自己的测量值决定：数字、时间点、被点名的对手
 * 全部来自数据，没有任何一句是不看输入就能写出来的。
 */
(function (root) {
  'use strict';

  var DIMS = [
    { id: 'hook',    label: 'Hook 记忆点', weight: 0.26, blurb: '有没有一段会原样回来、让人记住的东西' },
    { id: 'payoff',  label: '爆点落差',    weight: 0.18, blurb: '进 hook 的那一下，能量抬得够不够' },
    { id: 'opening', label: '黄金开场',    weight: 0.16, blurb: '多快进入状态，多快亮出 hook' },
    { id: 'groove',  label: '律动',        weight: 0.14, blurb: '拍点稳不稳，身体跟不跟得上' },
    { id: 'sound',   label: '声音完成度',  weight: 0.10, blurb: '响度、动态、声场、高频是否到位' },
    { id: 'tonal',   label: '旋律调性',    weight: 0.08, blurb: '调性是否清晰，旋律有没有落脚点' },
    { id: 'form',    label: '结构效率',    weight: 0.08, blurb: '篇幅和高潮位置是否合理' }
  ];

  // ---------- 小工具 ----------

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function ramp(x, a, b) { return clamp((x - a) / (b - a), 0, 1); }
  /** 梯形：a→b 上升，b→c 满分，c→d 下降 */
  function trap(x, a, b, c, d) { return x <= b ? ramp(x, a, b) : 1 - ramp(x, c, d); }

  function time(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function n1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function n2(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function secs(x) { return x < 10 ? n1(x).replace(/\.0$/, '') : String(Math.round(x)); }
  function q(t) { return '《' + t.name + '》'; }
  function lufsStr(x) { return '−' + n1(Math.abs(x)); }
  function brightDb(f) {
    var hi = f.bands.presence + f.bands.air, lo = f.bands.low + f.bands.lowMid + f.bands.mid;
    return 10 * Math.log10((hi + 1e-6) / (lo + 1e-6));
  }
  function highShare(f) { return f.bands.presence + f.bands.air; }
  /** 进 hook（或全曲最大一次）的能量抬升，以及它发生的时间 */
  function payoffOf(f) {
    var global = 0.6 * f.lift.db;
    if (f.hook && f.hook.lift >= global) return { db: f.hook.lift, time: f.hook.liftTime, atHook: true };
    return { db: f.lift.db, eff: global, time: f.lift.time, atHook: false };
  }
  function effLift(f) { var p = payoffOf(f); return p.atHook ? p.db : p.eff; }

  // ---------- 评分 ----------

  function scoreTrack(f) {
    var h = f.hook, s = {};

    if (!h) s.hook = 6;
    else {
      var ret = [0, 22, 60, 86, 100][Math.min(4, h.returns)] / 100;
      s.hook = 100 * (0.5 * ret + 0.2 * trap(h.coverage, 0.06, 0.18, 0.5, 0.85) +
        0.15 * ramp(h.quality, 0.5, 0.9) + 0.15 * ramp(h.level, -1.5, 2.5));
    }

    s.payoff = 100 * (0.55 * ramp(effLift(f), 0.5, 6) + 0.25 * trap(f.lra, 1.5, 5, 11, 18) +
      0.2 * (h ? ramp(h.escalation, -1.5, 1.5) : 0.3));

    s.opening = 100 * (0.4 * (1 - ramp(f.intro, 3, 25)) + 0.6 * (h && h.returns >= 2 ? 1 - ramp(h.start, 20, 80) : 0));

    s.groove = 100 * (0.6 * ramp(f.pulse, 0.15, 0.72) + 0.25 * trap(f.onsetRate, 0.6, 1.8, 6, 9) +
      0.15 * trap(f.bpm, 55, 85, 150, 190));

    s.sound = 100 * (0.35 * trap(f.lufs, -24, -15, -7, -4) + 0.2 * trap(f.plr, 4, 7.5, 14, 20) +
      0.2 * (f.width == null ? 0.3 : trap(f.width, 0.004, 0.05, 0.4, 0.7)) + 0.25 * trap(brightDb(f), -28, -16, -5, -1));

    s.tonal = 100 * (0.75 * ramp(f.key.clarity, 0.5, 0.88) + 0.25 * ramp(f.key.penta, 0.42, 0.6));

    s.form = 100 * (0.7 * trap(f.duration, 60, 125, 225, 330) +
      0.3 * trap((f.peakWin.time + f.peakWin.len / 2) / f.duration, 0.15, 0.4, 0.92, 1.05));

    var total = 0;
    DIMS.forEach(function (d) { s[d.id] = Math.round(s[d.id] * 10) / 10; total += d.weight * s[d.id]; });
    return { scores: s, total: Math.round(total * 10) / 10 };
  }

  // ---------- 句子：对手在某个维度上弱在哪 ----------

  var weak = {
    hook: function (r, w, S, O) {
      var h = r.f.hook, wh = w.f.hook;
      if (!h) return S + '从头到尾没有一段会原样回来。没有重复就没有记忆点，听完哼不出来。';
      if (h.returns === 1 && h.coverage > 0.55) return S + '有 ' + pct(h.coverage) + ' 的时长在重复同一段素材，中间没有任何对比。那不是 hook，是背景循环，耳朵会自动把它关掉。';
      if (h.returns === 1) return S + '的主题只在 ' + time(h.start) + ' 那一带出现，之后再也没回来。只登场一次的旋律留不下来。';
      if (wh && h.returns < wh.returns) return S + '的重复段只登场 ' + h.returns + ' 次，比' + O + '少 ' + (wh.returns - h.returns) + ' 次。';
      if (wh && h.quality < wh.quality - 0.04) return S + '的重复段每次回来都走了样，重合度只有 ' + pct(h.quality) + '（' + O + '是 ' + pct(wh.quality) + '），听众抓不住一个固定的东西。';
      if (h.level < 0.3) return S + '的重复段' + (h.level < 0 ? '比全曲平均还轻 ' : '只比全曲平均响 ') + n1(Math.abs(h.level)) + ' dB，回来了也没被推到台前。';
      if (h.coverage < 0.15) return S + '的重复段加起来只占全曲 ' + pct(h.coverage) + '，露面太少，记不住。';
      return S + '的 hook 综合下来没有' + O + '扎实（' + Math.round(r.scores.hook) + ' 分对 ' + Math.round(w.scores.hook) + ' 分）。';
    },
    payoff: function (r, w, S, O) {
      var el = effLift(r.f), h = r.f.hook;
      if (r.f.lra < 3.5) return S + '全曲响度起伏只有 ' + n1(r.f.lra) + ' LU，最大的一次抬升 ' + n1(payoffOf(r.f).db) + ' dB。从头到尾一个力度，没有“来了”的那一下。';
      if (el < 2) return S + '进 hook 时响度只抬了 ' + n1(Math.max(0, el)) + ' dB，耳朵感觉不到换挡。';
      if (r.f.lra > 14) return S + '的起伏有 ' + n1(r.f.lra) + ' LU，大到散了架，轻的段落在手机外放里会直接消失。';
      if (h && h.escalation < -1) return S + '最后一次 hook 比第一次还轻 ' + n1(-h.escalation) + ' dB，越往后越泄气。';
      return S + '最大的抬升是 ' + n1(el) + ' dB，' + O + '是 ' + n1(effLift(w.f)) + ' dB。';
    },
    opening: function (r, w, S, O) {
      var h = r.f.hook && r.f.hook.returns >= 2 ? r.f.hook : null;
      var wh = w.f.hook && w.f.hook.returns >= 2 ? w.f.hook : null;
      if (r.f.intro >= 10 && r.f.intro > w.f.intro + 4) return S + '要铺 ' + secs(r.f.intro) + ' 秒才进入状态。现在的听众前 5 秒留不住，就没有后面了。';
      if (!h) return S + '开头不算慢，但后面没有一个值得等的段落，开得再快也没用。';
      if (h.start > 60) return S + '的 hook 到 ' + time(h.start) + ' 才第一次出现。一分钟过去了，底牌还没亮。';
      if (wh && h.start > wh.start + 6) return S + '的 hook 到 ' + time(h.start) + ' 才出现，比' + O + '晚了 ' + Math.round(h.start - wh.start) + ' 秒。';
      return S + '的开场比' + O + '慢（' + secs(r.f.intro) + ' 秒进入状态，hook 在 ' + time(h.start) + '）。';
    },
    groove: function (r, w, S, O) {
      var f = r.f;
      if (f.pulse < 0.28) return S + '的律动稳定度只有 ' + n2(f.pulse) + '（满分 1），拍点是糊的，身体找不到落脚的地方。';
      if (f.onsetRate < 1.4) return S + '每秒只有 ' + n1(f.onsetRate) + ' 个起音，节奏太空，撑不起律动。';
      if (f.onsetRate > 7) return S + '每秒 ' + n1(f.onsetRate) + ' 个起音，塞得太满，没有呼吸。';
      if (f.bpm < 70) return S + '只有 ≈' + Math.round(f.bpm) + ' BPM，慢到很难带动身体。';
      if (f.bpm > 172) return S + '跑到 ≈' + Math.round(f.bpm) + ' BPM，快到普通听众跟不上。';
      return S + '的律动稳定度是 ' + n2(f.pulse) + '，' + O + '是 ' + n2(w.f.pulse) + '。';
    },
    sound: function (r, w, S, O) {
      var f = r.f;
      if (f.lufs < -16) return S + '的整合响度只有 ' + lufsStr(f.lufs) + ' LUFS，放进歌单会比前后的歌小一截，第一印象就输了。';
      if (f.plr < 7) return S + '被压得太死，峰值响度比只剩 ' + n1(f.plr) + ' dB，鼓的冲击全没了，听久了累。';
      if (f.lufs > -6) return S + '推到了 ' + lufsStr(f.lufs) + ' LUFS，已经在失真边缘。';
      if (brightDb(f) < -19) return S + '2 kHz 以上的能量只占 ' + n1(highShare(f) * 100) + '%，听起来像隔着一扇门。';
      if (f.width != null && f.width < 0.03) return S + '几乎是单声道（声场宽度 ' + n1(f.width * 100) + '%），戴上耳机没有空间。';
      return S + '的声音完成度略逊（' + lufsStr(f.lufs) + ' LUFS，峰值响度比 ' + n1(f.plr) + ' dB）。';
    },
    tonal: function (r, w, S, O) {
      var k = r.f.key;
      if (k.clarity < 0.62) return S + '的调性清晰度只有 ' + n2(k.clarity) + '，和声在几个调之间游移，旋律没有家。';
      return S + '的调性（' + k.name + '，清晰度 ' + n2(k.clarity) + '）没有' + O + '立得住（' + n2(w.f.key.clarity) + '）。';
    },
    form: function (r, w, S, O) {
      var d = r.f.duration;
      if (d > 270) return S + '长达 ' + time(d) + '。完播率会替它做出判决。';
      if (d < 105) return S + '只有 ' + time(d) + '，还没展开就结束了。';
      var pos = (r.f.peakWin.time + r.f.peakWin.len / 2) / d;
      if (pos < 0.35) return S + '最响的一段落在全曲 ' + pct(pos) + ' 的位置，高潮给得太早，后面全在往下走。';
      return S + '的篇幅和高潮位置没有' + O + '合理（' + time(d) + '）。';
    }
  };

  // ---------- 句子：对手在某个维度上强在哪（让步用） ----------

  var strong = {
    hook: function (r) { var h = r.f.hook; return '重复段登场 ' + h.returns + ' 次，重合度 ' + pct(h.quality); },
    payoff: function (r) { return '最大抬升 ' + n1(payoffOf(r.f).db) + ' dB'; },
    opening: function (r) {
      var h = r.f.hook && r.f.hook.returns >= 2 ? r.f.hook : null;
      return secs(r.f.intro) + ' 秒进入状态' + (h ? '，' + time(h.start) + ' 就到 hook' : '');
    },
    groove: function (r) { return '稳定度 ' + n2(r.f.pulse) + '，≈' + Math.round(r.f.bpm) + ' BPM'; },
    sound: function (r) { return lufsStr(r.f.lufs) + ' LUFS，峰值响度比 ' + n1(r.f.plr) + ' dB'; },
    tonal: function (r) { return r.f.key.name + '，清晰度 ' + n2(r.f.key.clarity); },
    form: function (r) { return '全曲 ' + time(r.f.duration); }
  };

  // ---------- 句子：赢家为什么赢 ----------

  function tempoFeel(bpm) {
    if (bpm < 78) return '慢板，靠的是留白';
    if (bpm < 100) return '中速，走路的步子，最容易上口';
    if (bpm < 118) return '中快板，点头的速度';
    if (bpm < 134) return '舞池的速度，四四拍的甜区';
    if (bpm < 160) return '有冲劲，适合大场面';
    return '很快，要靠半拍的律动来听';
  }

  var win = {
    hook: function (w) {
      var h = w.f.hook, later = h.times.slice(1).map(time);
      var body = [
        '它在 ' + time(h.start) + ' 第一次出现，然后在 ' + later.join('、') + ' 原样回来。我说“原样”不是修辞：这几段的和声走向和配器层次，重合度是 ' + pct(h.quality) + '。',
        '这些段落加起来占全曲 ' + pct(h.coverage) + '，' +
          (h.coverage > 0.5 ? '重复得很狠，但中间留了对比，所以是洗脑而不是催眠。' : h.coverage < 0.2 ? '露面不多，但每次都准。' : '够你记住，又没到听腻的程度。') +
          (h.level > 0.5 ? '而且它比全曲平均响 ' + n1(h.level) + ' dB，每次回来都站在最前面。' : '')
      ];
      return {
        title: '一段 ' + secs(h.len) + ' 秒的 hook，全曲登场 ' + h.returns + ' 次',
        body: body,
        stats: [['登场次数', h.returns + ' 次'], ['首次出现', time(h.start)], ['占全曲', pct(h.coverage)], ['重合度', pct(h.quality)]]
      };
    },
    payoff: function (w) {
      var p = payoffOf(w.f), h = w.f.hook;
      var body = [
        '爆款都有一个让人抬头的瞬间。这首歌的那个瞬间在 ' + time(p.time) + '：' + (p.atHook ? '进 hook 的那一下' : '全曲最大的一次换挡') + '，响度直接抬了 ' + n1(p.db) + ' dB。',
        '全曲的响度起伏是 ' + n1(w.f.lra) + ' LU，有收有放。' +
          (h && h.escalation > 0.7 ? '最后一次 hook 比第一次还响 ' + n1(h.escalation) + ' dB，它知道把最重的一拳留到最后。' : '')
      ];
      return {
        title: time(p.time) + ' 那一下，响度抬了 ' + n1(p.db) + ' dB',
        body: body,
        stats: [['最大抬升', n1(p.db) + ' dB'], ['发生在', time(p.time)], ['响度起伏', n1(w.f.lra) + ' LU']]
      };
    },
    opening: function (w) {
      var h = w.f.hook && w.f.hook.returns >= 2 ? w.f.hook : null, f = w.f;
      var body = [
        (f.intro < 1 ? '第一秒就是满状态' : '第 ' + secs(f.intro) + ' 秒能量就到位了') +
          (h ? '，' + time(h.start) + ' hook 已经登场' + (h.start <= 30 ? '，还不到半分钟。' : h.start <= 45 ? '，四十五秒之内。' : '。') : '。'),
        '听众只给一首新歌几秒钟。它没有浪费其中任何一秒。'
      ];
      return {
        title: (f.intro < 1 ? '开口就是状态' : secs(f.intro) + ' 秒进入状态') + (h ? '，' + time(h.start) + ' 亮出 hook' : ''),
        body: body,
        stats: [['进入状态', secs(f.intro) + ' 秒']].concat(h ? [['首次 hook', time(h.start)]] : [])
      };
    },
    groove: function (w) {
      var f = w.f;
      return {
        title: '≈' + Math.round(f.bpm) + ' BPM，律动稳定度 ' + n2(f.pulse),
        body: [
          '速度 ≈' + Math.round(f.bpm) + ' BPM，' + tempoFeel(f.bpm) + '。律动稳定度 ' + n2(f.pulse) + '（满分 1），每秒 ' + n1(f.onsetRate) + ' 个起音，不空也不挤。',
          '身体比脑子先做决定。脚先动了，歌才会被循环播放。'
        ],
        stats: [['速度', '≈' + Math.round(f.bpm) + ' BPM'], ['律动稳定度', n2(f.pulse)], ['起音密度', n1(f.onsetRate) + ' 个/秒']]
      };
    },
    sound: function (w) {
      var f = w.f;
      return {
        title: lufsStr(f.lufs) + ' LUFS，已经是成品的声音',
        body: [
          '整合响度 ' + lufsStr(f.lufs) + ' LUFS，峰值响度比 ' + n1(f.plr) + ' dB' +
            (f.width != null ? '，声场宽度 ' + n1(f.width * 100) + '%' : '') + '，2 kHz 以上占 ' + n1(highShare(f) * 100) + '% 的能量。',
          '这组数字的意思是：把它直接放进流媒体歌单，不会被前后的歌压下去，也不会刺耳。'
        ],
        stats: [['整合响度', lufsStr(f.lufs) + ' LUFS'], ['峰值响度比', n1(f.plr) + ' dB']].concat(f.width != null ? [['声场宽度', n1(f.width * 100) + '%']] : [])
      };
    },
    tonal: function (w) {
      var k = w.f.key;
      return {
        title: '调性钉在 ' + k.name,
        body: [
          '我一耳朵就能报出它的调：' + k.name + '，调性清晰度 ' + n2(k.clarity) + '。' +
            (k.mode === 'minor' ? '小调的底色，带一点不甘心，这种情绪最容易出圈。' : '大调，明亮直给，适合大合唱。'),
          k.penta >= 0.55
            ? pct(k.penta) + ' 的音高能量落在五声音阶上。这是国风旋律的骨架，也是全世界最容易跟唱的五个音。'
            : '和声不乱跑，旋律的每个长音都有地方落。'
        ],
        stats: [['调', k.name], ['调性清晰度', n2(k.clarity)], ['五声音阶占比', pct(k.penta)]]
      };
    },
    form: function (w) {
      var f = w.f, pos = (f.peakWin.time + f.peakWin.len / 2) / f.duration;
      return {
        title: time(f.duration) + '，没有多余的一秒',
        body: [
          '全曲 ' + time(f.duration) + '，最响的一段落在 ' + pct(pos) + ' 的位置。',
          '篇幅在流媒体最舒服的区间里，高潮放在后半程，听完会想再来一遍。'
        ],
        stats: [['时长', time(f.duration)], ['最响段位置', '全曲 ' + pct(pos)]]
      };
    }
  };

  /** 这首歌走的是哪条路子：只根据量到的速度、调式、五声占比和落差来说 */
  function lane(f) {
    var bpm = Math.round(f.bpm), p = payoffOf(f);
    if (f.key.penta >= 0.58) return pct(f.key.penta) + ' 的音高能量落在五声音阶上，调性中心是 ' + f.key.name + '。这是国风旋律的骨架，换一套编曲放到任何市场都成立。';
    if (bpm >= 116 && bpm <= 136 && f.pulse >= 0.5) return '≈' + bpm + ' BPM，拍点稳定度 ' + n2(f.pulse) + '。这是舞曲的心跳，放进 EDM 和 K-pop 的歌单都不违和。';
    if (p.db >= 5 && f.lra >= 7) return '段落之间的落差有 ' + n1(p.db) + ' dB，全曲起伏 ' + n1(f.lra) + ' LU。这种大开大合是 K-pop 主打歌的打法。';
    if (bpm < 96) return '≈' + bpm + ' BPM 的' + (f.key.mode === 'minor' ? '小调' : '大调') + '慢歌。它不靠节奏靠旋律，这是华语抒情的路子。';
    return '≈' + bpm + ' BPM，' + f.key.name + '。它不依赖哪一种风格的套路，换什么编曲都立得住。';
  }

  var tagline = {
    hook: '听两遍就会哼。另外几首做不到。',
    payoff: '它有一个让人抬头的瞬间。',
    opening: '它不让听众等。',
    groove: '身体比脑子先认出它。',
    sound: '它已经是成品的声音。',
    tonal: '旋律有家可回，所以唱得出来。',
    form: '没有一秒是多余的。'
  };

  // ---------- 句子：进棚前要改的一处 ----------

  var advice = {
    hook: function (w) {
      var h = w.f.hook;
      if (!h) return '它现在没有一段真正会回来的 hook。挑出最好的 8 小节，让它至少出现三次。';
      if (h.returns < 3) return 'hook 现在只登场 ' + h.returns + ' 次。结尾再加一遍，三次是底线。';
      if (h.level < 0.5) return 'hook 只比全曲平均响 ' + n1(Math.max(0, h.level)) + ' dB。给它加一层和声或叠一轨，让它每次回来都站到最前面。';
      return 'hook 的数量已经够了，别再加。把 ' + time(h.start) + ' 这段的主旋律再往前推 1 dB。';
    },
    payoff: function (w) {
      return '进 hook 前一拍，把鼓和贝斯全部抽掉。现在那一下只抬了 ' + n1(Math.max(0, effLift(w.f))) + ' dB，我要它至少 3 dB。';
    },
    opening: function (w) {
      var h = w.f.hook && w.f.hook.returns >= 2 ? w.f.hook : null;
      if (w.f.intro > 6) return '前奏现在是 ' + secs(w.f.intro) + ' 秒，砍到 5 秒以内。';
      if (h && h.start > 35) return 'hook 到 ' + time(h.start) + ' 才出现。在最开头先放 4 小节 hook 当引子，再回主歌。';
      return '开场已经够快，保持。';
    },
    groove: function (w) {
      return '底鼓和贝斯重新对齐。律动稳定度现在是 ' + n2(w.f.pulse) + '，我要它到 0.5 以上。';
    },
    sound: function (w) {
      var f = w.f;
      if (f.lufs < -14) return '母带再推 ' + n1(-10 - f.lufs) + ' dB，到 −10 LUFS 附近。现在是 ' + lufsStr(f.lufs) + '，进歌单会吃亏。';
      if (f.plr < 7) return '限制器松开 2 dB。现在峰值响度比只有 ' + n1(f.plr) + ' dB，鼓被压扁了。';
      if (brightDb(f) < -16) return '8 kHz 以上提一点空气感。现在 2 kHz 以上只占 ' + n1(highShare(f) * 100) + '% 的能量，偏闷。';
      if (f.width != null && f.width < 0.05) return '把和声和铺底往两边摆。现在声场宽度只有 ' + n1(f.width * 100) + '%，几乎是单声道。';
      return '混音不用大动，母带时再检查一遍低频。';
    },
    tonal: function (w) {
      return '主旋律的长音落回主音和五级。调性清晰度现在是 ' + n2(w.f.key.clarity) + '，还可以更笃定。';
    },
    form: function (w) {
      var d = w.f.duration;
      if (d > 230) return '现在是 ' + time(d) + '，剪到 3 分 20 秒以内。第二段主歌砍一半。';
      if (d < 125) return '只有 ' + time(d) + '，偏短。再加一遍 hook 和一个 8 小节的桥段。';
      return '把全曲最响的一段往后挪，让高潮落在后半程。';
    }
  };

  // ---------- 汇总：排名 + 判词 ----------

  /**
   * @param {{id:string, name:string, f:object}[]} tracks 至少两首
   */
  function judge(tracks) {
    if (tracks.length < 2) throw new Error('至少要两首歌才有的比');
    var ranked = tracks.map(function (t) {
      var sc = scoreTrack(t.f);
      return { id: t.id, name: t.name, f: t.f, scores: sc.scores, total: sc.total };
    }).sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });
    ranked.forEach(function (t, i) { t.rank = i + 1; });

    var w = ranked[0], rivals = ranked.slice(1), second = rivals[0];
    var margin = Math.round((w.total - second.total) * 10) / 10;

    // 每个维度对胜负的贡献：权重 × (赢家分 − 对手平均分)
    var contrib = DIMS.map(function (d) {
      var avg = rivals.reduce(function (a, r) { return a + r.scores[d.id]; }, 0) / rivals.length;
      return { dim: d, adv: d.weight * (w.scores[d.id] - avg) };
    }).sort(function (a, b) { return b.adv - a.adv; });
    var top = contrib.filter(function (c) { return c.adv > 0.4; }).slice(0, 3);
    if (!top.length) top = contrib.slice(0, 1);
    // hook 理由需要一个真的 hook
    top = top.filter(function (c) { return c.dim.id !== 'hook' || (w.f.hook && w.f.hook.returns >= 2); });
    if (!top.length) top = contrib.filter(function (c) { return c.dim.id !== 'hook'; }).slice(0, 1);

    var reasons = top.map(function (c) {
      var id = c.dim.id, r = win[id](w);
      // 点名：先说第二名（如果它在这一项上确实输），再说这一项上最差的那首
      var foils = [];
      if (second.scores[id] < w.scores[id] - 3) foils.push(second);
      var worst = rivals.slice().sort(function (a, b) { return a.scores[id] - b.scores[id]; })[0];
      if (worst !== foils[0] && worst.scores[id] < w.scores[id] - 3) foils.push(worst);
      if (!foils.length) foils.push(worst);
      return {
        dim: id, label: c.dim.label, title: r.title, body: r.body, stats: r.stats,
        versus: foils.map(function (f) { return weak[id](f, w, q(f), '它'); })
      };
    });

    var verdicts = rivals.map(function (r) {
      var gaps = DIMS.map(function (d) { return { id: d.id, gap: d.weight * (w.scores[d.id] - r.scores[d.id]) }; });
      var flaw = gaps.slice().sort(function (a, b) { return b.gap - a.gap; })[0];
      var edge = gaps.slice().sort(function (a, b) { return a.gap - b.gap; })[0];
      var edgeDim = DIMS.filter(function (d) { return d.id === edge.id; })[0];
      var concession = edge.gap < -0.8 && (edge.id !== 'hook' || r.f.hook)
        ? '单论「' + edgeDim.label + '」，它比' + q(w) + '强（' + Math.round(r.scores[edge.id]) + ' 分对 ' + Math.round(w.scores[edge.id]) + ' 分：' + strong[edge.id](r) + '）。但'
        : '';
      var text = concession + weak[flaw.id](r, w, '它', q(w));
      if (r === second) text += margin < 3 ? '差距只有 ' + n1(margin) + ' 分，但第二就是第二。' : '所以它是第二，不是第一。';
      return { id: r.id, name: r.name, rank: r.rank, total: r.total, flawDim: flaw.id, text: text };
    });

    var weakest = DIMS.slice().sort(function (a, b) { return w.scores[a.id] - w.scores[b.id]; })[0];
    var others = rivals.length === 1 ? '另一首' : '另外 ' + rivals.length + ' 首';
    var labels = reasons.map(function (r) { return r.label; });
    var confidence = margin >= 8 ? '没有悬念。' : margin >= 3 ? '优势很明确。' : '这是险胜，但再听十遍我也不会改口。';

    return {
      ranked: ranked,
      winner: w,
      margin: margin,
      tagline: tagline[reasons[0].dim],
      opening: ranked.length + ' 首我都从头听到了尾。能红的只有一首：' + q(w) + '。' +
        '总分 ' + n1(w.total) + '，领先第二名' + q(second) + n1(margin) + ' 分。' + confidence,
      because: '它赢在「' + labels.join('」「') + '」这 ' + labels.length + ' 件事上。下面每一条都是从这几首歌的音频里量出来的，你可以自己点开听。',
      lane: lane(w.f),
      reasons: reasons,
      verdicts: verdicts,
      fix: { dim: weakest.id, label: weakest.label, score: w.scores[weakest.id], text: advice[weakest.id](w) },
      closing: '我的判断不改。把资源押在' + q(w) + '上，' + others + '不用再争了。'
    };
  }

  var api = { judge: judge, scoreTrack: scoreTrack, DIMS: DIMS, format: { time: time } };
  root.TheOne = root.TheOne || {};
  root.TheOne.judge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
