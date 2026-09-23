/**
 * ============================================================
 * K 兼容性自检（public/diag.js）
 * ============================================================
 * 纯静态能力探测页（/diag.html）的脚本。用途：
 * 老内核（iOS 微信、旧 WebView）上出问题时，让用户直接在出问题的浏览器里
 * 打开本页并截图 —— 一次就能看清"到底哪项能力缺失、会不会被拦"，不必反复靠猜。
 *
 * 【为什么必须外链】站点 CSP 是 `script-src 'self'`（见 server 的 helmet 配置），
 * 内联 <script> 会被直接拦截，所以本文件必须与 diag.html 分开。
 *
 * 【为什么不引任何库】它要在**功能受限**的环境里运行：任何依赖都可能正是缺失的那一项。
 * 全部用最原始的语法，保证能跑起来。
 *
 * 【门槛判据必须与 src/lib/compat.ts 保持一致】那份是应用真正用来拦截的判据
 * （core 缺 → 全站"版本过低"提示页；voice 缺 → 只影响语音页）。两边口径不一致
 * 会让用户看到自相矛盾的结果。改动任一处时同步另一处。
 * ============================================================
 */
(function () {
  'use strict';

  var uaEl = document.getElementById('ua');
  var verdictEl = document.getElementById('verdict');
  var outEl = document.getElementById('out');
  if (!uaEl || !verdictEl || !outEl) return;

  var ua = navigator.userAgent || '(无)';
  uaEl.textContent = ua;

  /** 安全求值：探测本身抛错也算"不可用"，并带上原因 */
  function probe(fn) {
    try {
      var v = fn();
      if (v === false || v === undefined || v === null) return { ok: false, detail: '' };
      if (v === true) return { ok: true, detail: '' };
      return { ok: true, detail: String(v) };
    } catch (e) {
      return { ok: false, detail: '探测抛错：' + (e && e.message ? e.message : String(e)) };
    }
  }

  /**
   * 每项 = [名称, 探测函数, 门槛级别]
   * 门槛级别：'core'（缺则整站拦截）/ 'voice'（缺则只影响语音）/ undefined（仅供参考）
   */
  var groups = [
    {
      title: '语音通话（WebRTC）',
      items: [
        [
          'RTCPeerConnection',
          function () {
            return typeof RTCPeerConnection === 'function';
          },
          'voice',
        ],
        [
          'webkitRTCPeerConnection',
          function () {
            return typeof window.webkitRTCPeerConnection === 'function';
          },
        ],
        [
          '新建 RTCPeerConnection 实例',
          function () {
            if (typeof RTCPeerConnection !== 'function') return false;
            var pc = new RTCPeerConnection();
            pc.close();
            return true;
          },
          'voice',
        ],
        [
          'navigator.mediaDevices',
          function () {
            return typeof navigator.mediaDevices === 'object';
          },
          'voice',
        ],
        [
          'getUserMedia（麦克风）',
          function () {
            return typeof navigator.mediaDevices.getUserMedia === 'function';
          },
          'voice',
        ],
        [
          'getDisplayMedia（屏幕共享）',
          function () {
            return typeof navigator.mediaDevices.getDisplayMedia === 'function';
          },
          'voice',
        ],
        [
          'MediaRecorder（录制）',
          function () {
            return typeof MediaRecorder === 'function';
          },
          'voice',
        ],
      ],
    },
    {
      title: '音频处理',
      items: [
        [
          'AudioContext',
          function () {
            var ctx = window.AudioContext || window.webkitAudioContext;
            return typeof ctx === 'function';
          },
          'voice',
        ],
        [
          '新建 AudioContext 实例',
          function () {
            var C = window.AudioContext || window.webkitAudioContext;
            if (typeof C !== 'function') return false;
            var ctx = new C();
            var rate = ctx.sampleRate + ' Hz';
            if (ctx.close) ctx.close();
            return rate;
          },
          'voice',
        ],
        [
          'AudioWorkletNode（降噪/录音）',
          function () {
            return typeof AudioWorkletNode === 'function';
          },
        ],
      ],
    },
    {
      title: '语音朗读（TTS，可选功能）',
      items: [
        [
          'speechSynthesis 对象存在',
          function () {
            return typeof window.speechSynthesis === 'object' && window.speechSynthesis !== null;
          },
        ],
        [
          'speechSynthesis.addEventListener',
          function () {
            return typeof (window.speechSynthesis && window.speechSynthesis.addEventListener) === 'function';
          },
        ],
        [
          'speechSynthesis.getVoices',
          function () {
            return typeof (window.speechSynthesis && window.speechSynthesis.getVoices) === 'function';
          },
        ],
        [
          'SpeechSynthesisUtterance 构造器',
          function () {
            return typeof SpeechSynthesisUtterance === 'function';
          },
        ],
      ],
    },
    {
      title: '布局与媒体查询',
      items: [
        [
          'matchMedia("(max-width: 768px)")',
          function () {
            return window.matchMedia('(max-width: 768px)').matches;
          },
        ],
        [
          '范围语法 matchMedia("(width<=768px)")',
          function () {
            return window.matchMedia('(width<=768px)').matches;
          },
        ],
        [
          '视口宽度 window.innerWidth',
          function () {
            return window.innerWidth + 'px（devicePixelRatio ' + window.devicePixelRatio + '）';
          },
        ],
      ],
    },
    {
      title: '存储与网络（核心能力）',
      items: [
        [
          'localStorage',
          function () {
            var k = '__diag__';
            localStorage.setItem(k, '1');
            localStorage.removeItem(k);
            return true;
          },
          'core',
        ],
        [
          'sessionStorage',
          function () {
            var k = '__diag__';
            sessionStorage.setItem(k, '1');
            sessionStorage.removeItem(k);
            return true;
          },
          'core',
        ],
        [
          'WebSocket',
          function () {
            return typeof WebSocket === 'function';
          },
          'core',
        ],
        [
          'fetch',
          function () {
            return typeof fetch === 'function';
          },
          'core',
        ],
        [
          'navigator.clipboard（复制链接）',
          function () {
            return typeof (navigator.clipboard && navigator.clipboard.writeText) === 'function';
          },
        ],
        [
          'IntersectionObserver（滚动加载）',
          function () {
            return typeof IntersectionObserver === 'function';
          },
        ],
      ],
    },
    {
      title: '运行环境',
      items: [
        [
          '安全上下文（HTTPS）',
          function () {
            return window.isSecureContext === true;
          },
          'core',
        ],
        [
          '生效的 theme',
          function () {
            return document.documentElement.getAttribute('data-theme') || '(未设置)';
          },
        ],
        [
          '是否深色模式',
          function () {
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? '深色' : '浅色';
          },
        ],
        [
          '屏幕尺寸',
          function () {
            return screen.width + '×' + screen.height;
          },
        ],
      ],
    },
  ];

  var coreMissing = [];
  var voiceMissing = [];
  var html = '';

  for (var g = 0; g < groups.length; g++) {
    var group = groups[g];
    html += '<h2>' + group.title + '</h2><table>';
    for (var i = 0; i < group.items.length; i++) {
      var item = group.items[i];
      var name = item[0];
      var gate = item[2];
      var res = probe(item[1]);
      if (!res.ok) {
        if (gate === 'core') coreMissing.push(name);
        else if (gate === 'voice') voiceMissing.push(name);
      }
      html +=
        '<tr><td class="mark ' +
        (res.ok ? 'yes">✓' : 'no">✗') +
        '</td><td>' +
        name +
        (gate ? ' <span class="detail">（' + (gate === 'core' ? '核心' : '语音') + '能力）</span>' : '') +
        (res.detail ? '<span class="detail">' + res.detail + '</span>' : '') +
        '</td></tr>';
    }
    html += '</table>';
  }

  // ---- 结论：与 src/lib/compat.ts 的门槛口径一致 ----
  var verdict;
  if (coreMissing.length > 0) {
    verdict =
      '<div class="verdict verdict-bad">' +
      '<div class="verdict-title">当前环境：不支持（版本过低）</div>' +
      '<div class="verdict-desc">缺少核心能力：' +
      coreMissing.join('、') +
      '<br>K 会直接显示「浏览器版本过低」提示页，不会加载应用。' +
      '请升级系统、升级微信/浏览器，或使用 K 官方 App。</div></div>';
  } else if (voiceMissing.length > 0) {
    verdict =
      '<div class="verdict verdict-warn">' +
      '<div class="verdict-title">当前环境：语音功能受限</div>' +
      '<div class="verdict-desc">看帖、聊天等其余功能正常；语音相关缺少：' +
      voiceMissing.join('、') +
      '<br>进入语音页时会看到对应提示。建议升级系统后重试以获得完整语音体验。</div></div>';
  } else {
    verdict =
      '<div class="verdict verdict-ok">' +
      '<div class="verdict-title">当前环境：完全支持</div>' +
      '<div class="verdict-desc">核心能力与语音能力均齐备，可以正常使用全部功能。</div></div>';
  }

  verdictEl.innerHTML = verdict;
  outEl.innerHTML = html;
})();
