/**
 * YouSum - content script
 *
 * 在 YouTube 观看页负责：
 * 1. 提取视频字幕（双方案：页面数据 ytInitialPlayerResponse + timedtext API 兜底）
 * 2. 调用 Cloudflare Worker 代理层获取摘要（三种模式）
 * 3. 通过消息与 popup 协作，把结果交给 popup 展示
 *
 * 安全约定（对应安全审查修复项）：
 * - 【XSS 防护 / 安全 DOM API】本文件不使用 innerHTML / outerHTML / insertAdjacentHTML /
 *   document.write。所有 UI 均通过 document.createElement + textContent 构造，
 *   AI 返回的文本一律走 textContent，杜绝标签注入。
 * - 【URL 注入防护】videoId 用严格白名单正则校验后才拼进 URL；
 *   字幕 baseUrl 必须是 https 且主机属于 YouTube 白名单，否则拒绝请求。
 * - 【最小权限】不申请 activeTab / scripting 权限，只在 manifest 声明的
 *   YouTube 域名下运行。
 * - DeepSeek API Key 只存在于 Worker 侧，扩展端永不持有。
 */

(() => {
  'use strict';

  // ==========================================================================
  // 常量配置
  // ==========================================================================

  /** 摘要模式定义 */
  const MODES = {
    brief: {
      key: 'brief',
      label: 'Brief',
      hint: '100-word brief',
    },
    detailed: {
      key: 'detailed',
      label: 'Detailed',
      hint: 'Key points',
    },
    timeline: {
      key: 'timeline',
      label: 'Timeline',
      hint: 'Timestamps',
    },
  };

  /** 字幕最大字符数，超出则截断（控制 token 与成本） */
  const MAX_TRANSCRIPT_CHARS = 12000;

  /** 单条字幕最大字符数，防止异常超长片段撑爆请求体 */
  const MAX_CUE_CHARS = 500;

  /** 字幕条数上限 */
  const MAX_CUES = 2000;

  /** 请求超时（毫秒） */
  const REQUEST_TIMEOUT_MS = 45000;

  /** 字幕接口超时（毫秒） */
  const CAPTION_TIMEOUT_MS = 12000;

  /** 允许请求字幕的 YouTube 主机白名单（URL 注入防护） */
  const ALLOWED_CAPTION_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];

  // ==========================================================================
  // 安全工具函数
  // ==========================================================================

  /** 允许设置的属性白名单，杜绝 on* 事件属性注入 */
  const ALLOWED_ATTRS = new Set([
    'aria-label',
    'aria-hidden',
    'aria-live',
    'aria-pressed',
    'role',
    'tabindex',
    'title',
    'type',
    'data-mode',
    'data-testid',
  ]);

  /**
   * 创建元素并安全地设置文本。
   * 始终使用 textContent，绝不拼接 HTML —— 这是 XSS 防护的核心。
   */
  function el(tag, options = {}) {
    const node = document.createElement(tag);
    if (options.text !== undefined && options.text !== null) {
      node.textContent = String(options.text);
    }
    if (options.className) {
      node.className = options.className;
    }
    if (options.attrs) {
      for (const [key, value] of Object.entries(options.attrs)) {
        if (ALLOWED_ATTRS.has(key)) {
          node.setAttribute(key, String(value));
        }
      }
    }
    if (options.children) {
      for (const child of options.children) {
        if (child) node.appendChild(child);
      }
    }
    return node;
  }

  /**
   * 校验 YouTube video id。
   * 只允许 11 位 [A-Za-z0-9_-]，杜绝把任意字符串拼进 URL（URL 注入防护）。
   */
  function isValidVideoId(videoId) {
    return typeof videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(videoId);
  }

  /**
   * 校验字幕 URL。
   * 必须是 https，且主机属于 YouTube 白名单 —— 防止页面被注入恶意 baseUrl
   * 导致扩展把数据发到攻击者服务器。
   */
  function isAllowedCaptionUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      return ALLOWED_CAPTION_HOSTS.includes(parsed.hostname);
    } catch (_) {
      return false;
    }
  }

  /**
   * 清理字幕文本中的控制字符与零宽字符。
   * 这些字符可能用于绕过内容过滤或干扰日志，统一移除。
   */
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

  /** 限制字符串长度 */
  function clamp(text, max) {
    if (typeof text !== 'string') return '';
    return text.length > max ? text.slice(0, max) : text;
  }

  // ==========================================================================
  // 字幕提取
  // ==========================================================================

  /** 从 URL 中取 video id */
  function getVideoId() {
    try {
      const url = new URL(window.location.href);
      const id = url.searchParams.get('v');
      return isValidVideoId(id) ? id : '';
    } catch (_) {
      return '';
    }
  }

  /** 取视频标题（仅用于展示，不参与 URL 构造） */
  function getVideoTitle() {
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    if (titleEl) {
      const text = sanitizeText(titleEl.textContent || '');
      if (text) return clamp(text, 200);
    }
    const og = document.querySelector('meta[name="title"]');
    if (og) {
      const text = sanitizeText(og.getAttribute('content') || '');
      if (text) return clamp(text, 200);
    }
    return clamp(sanitizeText(document.title.replace(/\s*-\s*YouTube$/, '')), 200);
  }

  /** 把字幕条目转成带时间戳的纯文本 */
  function cuesToText(cues) {
    return cues.map((c) => `[${formatTimestamp(c.start)}] ${c.text}`).join('\n');
  }

  /** 秒 -> mm:ss 或 h:mm:ss */
  function formatTimestamp(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  }

  /**
   * 方案 B：隔离世界内直接请求 timedtext API。
   * 桥接脚本被页面 CSP 拦截时的兜底路径。
   */
  async function fetchViaTimedtextApi(videoId) {
    const langs = ['en', 'en-US', 'zh-Hans', 'zh-CN', 'zh', 'ja', 'ko', 'es', 'fr', 'de'];

    for (const lang of langs) {
      for (const kind of ['', 'asr']) {
        const kindParam = kind ? `&kind=${kind}` : '';
        // videoId 已经过白名单校验，这里再次编码，杜绝 URL 注入
        const url = `https://www.youtube.com/api/timedtext?ie=UTF-8&v=${encodeURIComponent(
          videoId
        )}&lang=${encodeURIComponent(lang)}${kindParam}&fmt=json3`;

        if (!isAllowedCaptionUrl(url)) continue;

        try {
          const res = await fetchWithTimeout(url, { credentials: 'omit' }, CAPTION_TIMEOUT_MS);
          if (!res.ok) continue;
          const text = await res.text();
          if (!text || text.length < 10) continue;
          const cues = parseJson3(JSON.parse(text));
          if (cues.length) return cues;
        } catch (_) {
          // 换下一个语言
        }
      }
    }
    return [];
  }

  /**
   * 解析 timedtext 的 json3 格式。
   * 返回 [{ start: 秒, duration: 秒, text: '...' }]
   */
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
        text: clamp(text, MAX_CUE_CHARS),
      });
      if (cues.length >= MAX_CUES) break;
    }
    return cues;
  }

  /**
   * 通过 MAIN world 桥接脚本提取字幕。
   *
   * 关键点：内容脚本运行在隔离世界，读不到 window.ytInitialPlayerResponse，
   * 也拿不到 player.getPlayerResponse()（都是 undefined）。
   * 所以要把 web/caption-bridge.js 注入页面主世界去取数据，
   * 再通过 window.postMessage 把字幕传回隔离世界。
   *
   * 之所以要声明 web_accessible_resources，就是为了让页面能加载这个脚本。
   */
  function extractViaBridge() {
    return new Promise((resolve) => {
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        script.remove();
        resolve(result);
      };

      const onMessage = (event) => {
        // 只接受同窗口发来的、token 匹配的响应
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.__yousumCaption !== true || data.token !== token) return;
        finish({
          cues: Array.isArray(data.cues) ? data.cues : [],
          source: typeof data.source === 'string' ? data.source : null,
        });
      };

      window.addEventListener('message', onMessage);

      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('web/caption-bridge.js');
      script.dataset.yousumToken = token;
      script.async = false;
      script.addEventListener('load', () => {
        // 脚本已加载；若它没能回报结果（例如页面 CSP 拦截），超时兜底
        setTimeout(() => finish({ cues: [], source: null }), CAPTION_TIMEOUT_MS + 3000);
      });
      script.addEventListener('error', () => finish({ cues: [], source: null }));

      // 注入到 <html> 下，确保在页面 CSP 生效范围内执行
      (document.head || document.documentElement).appendChild(script);
    });
  }

  /**
   * 主入口：提取字幕。
   * 方案 A：MAIN world 桥接（页面数据 + timedtext 双通道，由桥接脚本内部完成）
   * 方案 B：隔离世界内直接请求 timedtext API（兜底）
   */
  async function extractTranscript() {
    const videoId = getVideoId();
    if (!isValidVideoId(videoId)) return { cues: [], source: null };

    // 方案 A：MAIN world 桥接
    const bridged = await extractViaBridge();
    if (bridged.cues.length) return bridged;

    // 方案 B：隔离世界直接请求 timedtext API
    const cues = await fetchViaTimedtextApi(videoId);
    if (cues.length) return { cues, source: 'timedtext' };

    return { cues: [], source: null };
  }

  // ==========================================================================
  // Worker 通信
  // ==========================================================================

  /**
   * Cloudflare Worker 地址。
   *
   * 部署后把实际地址填到这里（约 340 行处）。
   * Worker 侧持有 DeepSeek API Key，并做速率限制与超时保护。
   */
  const API_URL = 'https://yousum-proxy.YOUR-SUBDOMAIN.workers.dev';

  /** 带超时的 fetch */
  async function fetchWithTimeout(url, options = {}, timeoutMs = CAPTION_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 请求摘要 */
  async function requestSummary({ transcript, mode, title, videoId }) {
    const res = await fetchWithTimeout(
      `${API_URL}/summarize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: clamp(transcript, MAX_TRANSCRIPT_CHARS),
          mode,
          title: clamp(title, 200),
          videoId,
        }),
      },
      REQUEST_TIMEOUT_MS
    );

    let data;
    try {
      data = await res.json();
    } catch (_) {
      throw new Error(`Service returned an unreadable response (HTTP ${res.status})`);
    }

    if (!res.ok) {
      throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
    }
    return data;
  }

  // ==========================================================================
  // 消息处理（popup ↔ content script）
  // ==========================================================================

  const handlers = {




    /** 返回当前页面的视频信息 */
    async GET_PAGE_INFO() {
      return {
        ok: true,
        videoId: getVideoId(),
        title: getVideoTitle(),
        isVideoPage: isValidVideoId(getVideoId()),
      };
    },

    /** 提取字幕并返回 */
    async EXTRACT_TRANSCRIPT() {
      const videoId = getVideoId();
      if (!isValidVideoId(videoId)) {
        return { ok: false, error: 'Not a valid YouTube video page' };
      }
      const { cues, source } = await extractTranscript();
      if (!cues.length) {
        return {
          ok: false,
          error:
            'No captions found for this video. It may have no caption track, or the captions are still being generated.',
        };
      }
      return {
        ok: true,
        source,
        cueCount: cues.length,
        transcript: cuesToText(cues),
      };
    },

    /** 提取字幕并请求摘要，一次完成 */
    async GENERATE_SUMMARY(message) {
      const mode = MODES[message?.mode] ? message.mode : 'brief';
      const videoId = getVideoId();
      if (!isValidVideoId(videoId)) {
        return { ok: false, error: 'Not a valid YouTube video page' };
      }

      const { cues, source } = await extractTranscript();
      if (!cues.length) {
        return {
          ok: false,
          error:
            'No captions found for this video. It may have no caption track, or the captions are still being generated.',
        };
      }

      let transcript = cuesToText(cues);
      let truncated = false;
      if (transcript.length > MAX_TRANSCRIPT_CHARS) {
        transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
        truncated = true;
      }

      // 字幕就绪，此时才占用额度（提取失败不消耗次数）
      const quota = await chrome.runtime.sendMessage({ type: 'QUOTA_CONSUME' });
      if (!quota || !quota.ok) {
        return {
          ok: false,
          code: 'QUOTA_EXCEEDED',
          error: 'You have used all 10 free summaries for today. Come back tomorrow.',
          remaining: 0,
        };
      }

      try {
        const data = await requestSummary({
          transcript,
          mode,
          title: getVideoTitle(),
          videoId,
        });

        return {
          ok: true,
          summary: typeof data.summary === 'string' ? data.summary : '',
          mode,
          source,
          truncated,
          cueCount: cues.length,
          remaining: typeof quota.remaining === 'number' ? quota.remaining : null,
        };
      } catch (err) {
        // 请求失败退还额度
        await chrome.runtime.sendMessage({ type: 'QUOTA_REFUND' }).catch(() => {});
        throw err;
      }
    },
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return false;
    handler(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || 'Unexpected error' }));
    return true; // 异步响应
  });

  // YouTube 是 SPA，切视频不重载页面
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
    }
  }, 1000);
})();
