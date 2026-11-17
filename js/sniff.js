/*
 * THE ONE — 解码失败时的文件诊断
 *
 * 浏览器解不开一个文件时只会说“失败”。这里直接看文件的字节，
 * 判断它到底是什么：被 App 加密的缓存、带 DRM 的文件、浏览器不支持的编码、
 * 下载不完整，还是根本不是音频——然后告诉用户原因和下一步。
 * 不依赖 DOM，浏览器和 Node 都能跑。
 */
(function (root) {
  'use strict';

  function ascii(b, o, n) {
    var s = '';
    for (var i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function startsWith(b, bytes) {
    for (var i = 0; i < bytes.length; i++) if (b[i] !== bytes[i]) return false;
    return b.length >= bytes.length;
  }

  /** 前 64 KB 的字节熵（bit/字节）。压缩音频也很高，所以只在“没有任何文件头”时才用它下结论。 */
  function entropy(b) {
    var n = Math.min(b.length, 65536), hist = new Uint32Array(256), e = 0;
    if (!n) return 0;
    for (var i = 0; i < n; i++) hist[b[i]]++;
    for (var k = 0; k < 256; k++) if (hist[k]) { var p = hist[k] / n; e -= p * Math.log2(p); }
    return e;
  }

  var MP4_CODECS = {
    'mp4a': 'AAC', 'alac': 'Apple 无损（ALAC）', 'ac-3': '杜比 AC-3', 'ec-3': '杜比 E-AC-3', 'ac-4': '杜比 AC-4',
    'Opus': 'Opus', 'fLaC': 'FLAC', 'samr': 'AMR', 'sawb': 'AMR-WB', 'mha1': 'MPEG-H', 'mhm1': 'MPEG-H'
  };

  /** 走一遍 MP4 顶层 box，再在 moov 里找采样描述（stsd）里的编码和保护标记。 */
  function mp4Info(b) {
    var info = { moov: false, truncated: false, codecs: [], protected: false };
    var off = 0, moovStart = -1, moovEnd = -1;
    while (off + 8 <= b.length) {
      var size = u32(b, off), type = ascii(b, off + 4, 4);
      if (size === 1) size = off + 16 <= b.length ? u32(b, off + 12) : 0; // 64 位长度，只取低 32 位
      else if (size === 0) size = b.length - off;                         // 一直到文件末尾
      if (size < 8) break;
      if (off + size > b.length) info.truncated = true;
      if (type === 'moov') { info.moov = true; moovStart = off + 8; moovEnd = Math.min(b.length, off + size); }
      off += size;
    }
    for (var i = moovStart; moovStart >= 0 && i + 4 <= moovEnd; i++) {
      if (i + 20 <= moovEnd && b[i] === 0x73 && b[i + 1] === 0x74 && b[i + 2] === 0x73 && b[i + 3] === 0x64) { // 'stsd'
        var fourcc = ascii(b, i + 16, 4);
        if (fourcc === 'enca' || fourcc === 'drms') info.protected = true;
        else if (info.codecs.indexOf(fourcc) < 0) info.codecs.push(fourcc);
      } else if (b[i] === 0x73 && b[i + 1] === 0x69 && b[i + 2] === 0x6e && b[i + 3] === 0x66) { // 'sinf'
        info.protected = true;
      }
    }
    return info;
  }

  // 音乐 App 的加密缓存：扩展名 → 来源
  var APP_EXT = {
    ncm: '网易云音乐', qmc0: 'QQ 音乐', qmc3: 'QQ 音乐', qmcflac: 'QQ 音乐', qmcogg: 'QQ 音乐', mflac: 'QQ 音乐', mflac0: 'QQ 音乐',
    mgg: 'QQ 音乐', mgg1: 'QQ 音乐', kgm: '酷狗音乐', kgma: '酷狗音乐', vpr: '酷狗音乐', kwm: '酷我音乐'
  };

  function result(kind, message) { return { kind: kind, message: message }; }

  /**
   * @param {Uint8Array} b 文件的全部字节
   * @param {string} name 文件名（用来读扩展名）
   * @returns {{kind: string, message: string}}
   */
  function diagnose(b, name) {
    var ext = (/\.([^.]+)$/.exec(name || '') || [, ''])[1].toLowerCase();
    var EXT = ext ? ext.toUpperCase() : '音频';
    var convert = '转成 mp3 / wav 再试。';

    if (b.length < 16) return result('not-audio', '文件是空的或只有几个字节，不是音频。');

    // 音乐 App 的加密格式
    if (ascii(b, 0, 8) === 'CTENFDAM') return result('app-encrypted', '这是网易云音乐的加密缓存（ncm），只有它自己的客户端能播。请用未加密的 mp3 / flac / wav。');
    if (ascii(b, 0, 12) === 'yeelion-kuwo') return result('app-encrypted', '这是酷我音乐的加密缓存，只有它自己的客户端能播。请用未加密的 mp3 / flac / wav。');
    if (APP_EXT[ext]) return result('app-encrypted', '这是' + APP_EXT[ext] + '的加密缓存（.' + ext + '），只有它自己的客户端能播。请用未加密的 mp3 / flac / wav。');

    // MP4 / M4A
    if (ascii(b, 4, 4) === 'ftyp') {
      var m = mp4Info(b);
      if (!m.moov) return result('truncated', 'M4A 文件不完整：缺少索引信息（moov），多半是下载或导出中途断了。请重新获取这个文件。');
      if (m.protected) return result('drm', '这是带版权保护（DRM）的 M4A，浏览器不允许解码。请使用未加密的版本。');
      var bad = m.codecs.filter(function (c) { return MP4_CODECS[c] && c !== 'mp4a' && c !== 'Opus' && c !== 'fLaC'; })[0];
      if (bad === 'alac') return result('unsupported-codec', '编码是 Apple 无损（ALAC），这个浏览器不支持。换 Safari 打开，或转成 wav / flac / mp3。');
      if (bad) return result('unsupported-codec', '编码是' + MP4_CODECS[bad] + '，浏览器不支持。转成 AAC / mp3 / wav 再试。');
      if (m.truncated) return result('truncated', 'M4A 文件不完整：音频数据在中途被截断。请重新下载或导出。');
      return result('unknown', '文件结构是正常的 M4A，但这个浏览器没能解码。换最新版 Chrome / Edge / Safari，或' + convert);
    }

    // 其他常见容器
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') {
      var tag = ascii(b, 12, 4) === 'fmt ' ? b[20] | (b[21] << 8) : 1;
      if (tag !== 1 && tag !== 3 && tag !== 0xFFFE) return result('unsupported-codec', '这个 WAV 里装的是压缩编码（格式代码 ' + tag + '），浏览器不支持。导出为标准 PCM WAV 或 mp3 再试。');
      return result('unknown', '文件是 WAV，但这个浏览器没能解码，可能已损坏。重新导出一次再试。');
    }
    if (ascii(b, 0, 4) === 'FORM' && /^AIF[FC]$/.test(ascii(b, 8, 4))) return result('unsupported-codec', '这是 AIFF，只有 Safari 能直接解码。换 Safari 打开，或' + convert);
    if (startsWith(b, [0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11])) return result('unsupported-codec', '这是 WMA，浏览器不支持。' + convert);
    if (ascii(b, 0, 5) === '#!AMR') return result('unsupported-codec', '这是 AMR 录音，浏览器不支持。' + convert);
    if (ascii(b, 0, 4) === 'MThd') return result('not-audio', '这是 MIDI 乐谱，里面没有声音。请导出成 mp3 / wav 的成品音频。');
    if (ascii(b, 0, 4) === 'fLaC' || ascii(b, 0, 4) === 'OggS' || ascii(b, 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) {
      return result('unknown', '文件头是正常的音频格式，但这个浏览器没能解码，可能已损坏或不完整。重新下载，或' + convert);
    }

    // 没有任何已知的文件头
    if (entropy(b) > 7.9) {
      return result('scrambled', '这不是有效的 ' + EXT + '：文件里没有 ' + EXT + ' 的文件头，内容是加密或损坏的数据。先确认它能在普通播放器里播放；如果只有某个 App 能播，请从那个 App 导出为 mp3 / wav。');
    }
    return result('not-audio', '文件头不是任何已知的音频格式，扩展名可能被改过。请换成真正的 mp3 / wav / m4a。');
  }

  var api = { diagnose: diagnose };
  root.TheOne = root.TheOne || {};
  root.TheOne.sniff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
