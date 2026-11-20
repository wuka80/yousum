/**
 * YouSum - 字幕桥接脚本（运行在页面 MAIN world）
 *
 * 为什么需要这个文件？
 * 内容脚本运行在 Chrome 的「隔离世界」里，读不到页面主世界的 JS 变量。
 * `window.ytInitialPlayerResponse` 和 `player.getPlayerResponse()` 在隔离世界里
 * 都是 undefined —— 这是 Chrome 的安全机制，无法绕过。
 *
 * 解决办法：把本脚本以 <script src="chrome-extension://<id>/web/caption-bridge.js">
 * 注入页面，它就在主世界里执行，能拿到播放器数据。
 * 之所以要声明 web_accessible_resources，就是为了让页面能加载这个扩展资源。
 *
 * 本脚本只做一件事：找到字幕轨并抓回来，通过 window.postMessage 交回内容脚本。
 * 它不读取用户信息、不发送任何数据到外部服务器。
 *
 * 安全约定：
 * - 只接受来自页面主世界的字幕轨，且必须经过主机的 https 白名单校验
 * - 回传数据带一次性 token，内容脚本只接受 token 匹配的响应
 * - 不使用 innerHTML，不执行任何远程代码
 */

(() => {
  'use strict';

  /** 允许的字幕主机白名单 */
  const ALLOWED_CAPTION_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];

  /** 尝试的字幕语言顺序 */
  const LANGS = ['en', 'en-US', 'zh-Hans', 'zh-CN', 'zh', 'ja', 'ko', 'es', 'fr', 'de'];

  /** 单次抓取超时 */
  const FETCH_TIMEOUT_MS = 12000;

  /** 读取注入时携带的 token */
  const token = document.currentScript?.dataset?.yousumToken || '';
  if (!token) return;

  // ==========================================================================
  // 工具
  // ==========================================================================

  function isAllowedCaptionUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      return ALLOWED_CAPTION_HOSTS.includes(parsed.hostname);
    } catch (_) {
      return false;
    }
  }

  function sanitizeText(text) {
    if (typeof text !== 'string') return '';
    return (
      text
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/[\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  function clamp(text, max) {
    return typeof text === 'string' && text.length > max ? text.slice(0, max) : text || '';
  }

  function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { credentials: 'omit', signal: controller.signal }).finally(() =>
      clearTimeout(timer)
    );
  }

  // ==========================================================================
  // 字幕解析
  // ==========================================================================

  function parseJson3(json) {
    const events = Array.isArray(json?.events) ? json.events : [];
    const cues = [];
    for (const ev of events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const raw = ev.segs.map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : '')).join('');
      const text = sanitizeText(raw);
      if (!text) continue;
      cues.push({
        start: (Number(ev.tStartMs) || 0) / 1000,
        duration: (Number(ev.dDurationMs) || 0) / 1000,
        text: clamp(text, 500),
      });
      if (cues.length >= 2000) break;
    }
    return cues;
  }

  function parseXml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (!doc || doc.querySelector('parsererror')) return [];
    const out = [];
    for (const node of doc.querySelectorAll('text')) {
      const text = sanitizeText(node.textContent || '');
      if (!text) continue;
      out.push({
        start: Number(node.getAttribute('start')) || 0,
        duration: Number(node.getAttribute('dur')) || 0,
        text: clamp(text, 500),
      });
      if (out.length >= 2000) break;
    }
    return out;
  }

  // ==========================================================================
  // 找字幕轨
  // ==========================================================================

  /** 从播放器响应里取字幕轨列表 */
  function getCaptionTracks() {
    let response = null;

    const player =
      document.querySelector('#movie_player') ||
      document.querySelector('ytd-player') ||
      document.querySelector('#player-container');

    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        response = player.getPlayerResponse();
      } catch (_) {
        response = null;
      }
    }

    if (!response && window.ytInitialPlayerResponse) {
      response = window.ytInitialPlayerResponse;
    }

    if (!response || !response.captions) return [];

    const renderer = response.captions?.playerCaptionsTracklistRenderer;
    const tracks = Array.isArray(renderer?.captionTracks) ? renderer.captionTracks : [];

    // 打分：人工翻译 > 人工原声 > 自动字幕
    return tracks
      .map((track) => {
        const lang = typeof track.languageCode === 'string' ? track.languageCode : '';
        const isAuto = track.kind === 'asr';
        let score = 0;
        if (track.isTranslatable === true) score += 100;
        if (!isAuto) score += 50;
        if (lang.startsWith('en')) score += 20;
        return { track, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((s) => s.track);
  }

  /** 方案 A：按字幕轨的 baseUrl 抓（最准，含签名参数） */
  async function fetchFromTracks() {
    for (const track of getCaptionTracks()) {
      const baseUrl = track && typeof track.baseUrl === 'string' ? track.baseUrl : '';
      if (!baseUrl || !isAllowedCaptionUrl(baseUrl)) continue;

      try {
        const sep = baseUrl.includes('?') ? '&' : '?';
        const res = await fetchWithTimeout(baseUrl + sep + 'fmt=json3');
        if (!res.ok) continue;
        const text = await res.text();
        if (!text) continue;

        const trimmed = text.trim();
        let cues = [];
        if (trimmed.startsWith('{')) {
          cues = parseJson3(JSON.parse(trimmed));
        } else if (trimmed.startsWith('<')) {
          cues = parseXml(trimmed);
        }
        if (cues.length) return { cues, source: 'page' };
      } catch (_) {
        // 换下一条轨道
      }
    }
    return { cues: [], source: null };
  }

  /** 方案 B：timedtext API 兜底 */
  async function fetchViaTimedtextApi(videoId) {
    for (const lang of LANGS) {
      for (const kind of ['', 'asr']) {
        const kindParam = kind ? `&kind=${kind}` : '';
        const url = `https://www.youtube.com/api/timedtext?ie=UTF-8&v=${encodeURIComponent(
          videoId
        )}&lang=${encodeURIComponent(lang)}${kindParam}&fmt=json3`;
        if (!isAllowedCaptionUrl(url)) continue;

        try {
          const res = await fetchWithTimeout(url);
          if (!res.ok) continue;
          const text = await res.text();
          if (!text || text.length < 10) continue;
          const cues = parseJson3(JSON.parse(text));
          if (cues.length) return { cues, source: 'timedtext' };
        } catch (_) {
          // 换下一个语言
        }
      }
    }
    return { cues: [], source: null };
  }

  // ==========================================================================
  // 入口
  // ==========================================================================

  async function run() {
    const videoId = new URL(window.location.href).searchParams.get('v') || '';
    const validId = /^[A-Za-z0-9_-]{11}$/.test(videoId);

    let result = { cues: [], source: null };

    if (validId) {
      const fromTracks = await fetchFromTracks();
      if (fromTracks.cues.length) {
        result = fromTracks;
      } else {
        result = await fetchViaTimedtextApi(videoId);
      }
    }

    window.postMessage({ __yousumCaption: true, token, ...result }, '*');
  }

  run();
})();
