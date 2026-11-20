/**
 * YouSum - content script
 *
 * 在 YouTube 观看页注入浮层面板，负责：
 * 1. 提取视频字幕（双方案：页面数据 ytInitialPlayerResponse + timedtext API 兜底）
 * 2. 调用 Worker 代理层获取摘要（三种模式）
 * 3. 渲染结果面板
 *
 * 约定：DeepSeek API Key 只在 Worker 侧，扩展端只与自己的 Worker 通信。
 */

(() => {
  'use strict';

  // ==========================================================================
  // 配置
  // ==========================================================================

  /**
   * 摘要模式定义。
   * 注意：Worker 地址只在 background/service-worker.js 里配置一处，
   * 内容脚本通过消息与后台通信，不直接发起跨域请求。
   */
  const MODES = {
    brief: {
      key: 'brief',
      label: 'Brief',
      hint: '100 字速览',
    },
    detailed: {
      key: 'detailed',
      label: 'Detailed',
      hint: '完整要点',
    },
    timeline: {
      key: 'timeline',
      label: 'Timeline',
      hint: '时间戳大纲',
    },
  };

  /** 字幕最大字符数，超出则截断（控制 token 与成本） */
  const MAX_TRANSCRIPT_CHARS = 12000;

  // ==========================================================================
  // 工具函数
  // ==========================================================================

  /** 从 URL 中取 video id */
  function getVideoId() {
    const url = new URL(window.location.href);
    return url.searchParams.get('v') || '';
  }

  /** 从 URL 中取视频标题 */
  function getVideoTitle() {
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    if (titleEl) return titleEl.textContent.trim();
    const og = document.querySelector('meta[name="title"]');
    return og ? og.getAttribute('content').trim() : document.title.replace(/\s*-\s*YouTube$/, '').trim();
  }

  /** 带超时的 fetch */
  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 解析 timedtext 的 json3 格式。
   * 返回 [{ start: 秒, duration: 秒, text: '...' }]
   */
  function parseJson3(json) {
    const events = json?.events || [];
    const cues = [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      cues.push({
        start: (ev.tStartMs || 0) / 1000,
        duration: (ev.dDurationMs || 0) / 1000,
        text,
      });
    }
    return cues;
  }

  /** 解析 timedtext 的 XML 格式（fmt=srv3 等） */
  function parseXml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const out = [];
    doc.querySelectorAll('text').forEach((node) => {
      const start = parseFloat(node.getAttribute('start') || '0');
      const dur = parseFloat(node.getAttribute('dur') || '0');
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) out.push({ start, duration: dur, text });
    });
    return out;
  }

  /** 把字幕条目转成带时间戳的纯文本 */
  function cuesToText(cues) {
    return cues.map((c) => `[${formatTimestamp(c.start)}] ${c.text}`).join('\n');
  }

  /** 秒 -> mm:ss 或 h:mm:ss */
  function formatTimestamp(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  }

  // ==========================================================================
  // 字幕提取 —— 方案 A：页面数据
  // ==========================================================================

  /**
   * 从页面的 ytInitialPlayerResponse 中拿到字幕轨道列表。
   * 这是最可靠的方式，能拿到准确的 baseUrl（含签名参数）。
   */
  function getCaptionTracksFromPlayerResponse() {
    // YouTube 的 SPA 结构，player 可能在页面加载后才就绪
    const player =
      document.querySelector('#movie_player') ||
      document.querySelector('ytd-player') ||
      document.querySelector('#player-container');

    let response = null;

    // 方式 1：从 player 元素上直接取（最准）
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        response = player.getPlayerResponse();
      } catch (_) {
        response = null;
      }
    }

    // 方式 2：全局变量兜底
    if (!response && window.ytInitialPlayerResponse) {
      response = window.ytInitialPlayerResponse;
    }

    // 方式 3：页面上内嵌的 ytcfg / playerResponse
    if (!response) {
      const inline = document.querySelector('#movie_player script, ytd-player script');
      if (inline?.textContent) {
        try {
          const parsed = JSON.parse(inline.textContent);
          response = parsed.playerResponse || parsed;
        } catch (_) {
          response = null;
        }
      }
    }

    if (!response?.captions) return [];

    const renderer = response.captions?.playerCaptionsTracklistRenderer;
    const tracks = renderer?.captionTracks || [];
    if (!tracks.length) return [];

    // 优先手动字幕，其次英文，再其次任意；优先带翻译的轨道
    const scored = tracks
      .map((t) => {
        const lang = t.languageCode || '';
        const isAuto = t.kind === 'asr';
        const isTranslatable = !!t.isTranslatable;
        const isManualEn = !isAuto && lang.startsWith('en');
        const isManualZh = !isAuto && lang.startsWith('zh');
        let score = 0;
        if (isManualZh) score += 100;
        if (isManualEn) score += 90;
        if (!isAuto && isTranslatable) score += 40;
        if (!isAuto) score += 20;
        if (isTranslatable) score += 10;
        return { track: t, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored.map((s) => s.track);
  }

  // ==========================================================================
  // 字幕提取 —— 方案 B：timedtext API 兜底
  // ==========================================================================

  /**
   * 直接请求 timedtext 接口。方案 A 拿不到 baseUrl 时使用。
   * 注意：timedtext 需要正确参数，否则返回空。
   */
  async function fetchViaTimedtextApi(videoId) {
    const base = `https://www.youtube.com/api/timedtext?ie=UTF-8&v=${encodeURIComponent(videoId)}`;
    const langs = ['zh-Hans', 'zh-CN', 'zh', 'en', 'en-US'];

    for (const lang of langs) {
      for (const kind of ['', 'asr']) {
        const kindParam = kind ? `&kind=${kind}` : '';
        const url = `${base}&lang=${encodeURIComponent(lang)}${kindParam}&fmt=json3`;
        try {
          const res = await fetchWithTimeout(url, { credentials: 'omit' }, 10000);
          if (!res.ok) continue;
          const text = await res.text();
          if (!text || text.length < 10) continue;
          const cues = parseJson3(JSON.parse(text));
          if (cues.length) return cues;
        } catch (_) {
          // 单个语言失败不影响其他尝试
        }
      }
    }
    return [];
  }

  /**
   * 主入口：提取字幕，页面数据优先，timedtext API 兜底。
   */
  async function extractTranscript() {
    const videoId = getVideoId();
    if (!videoId) return { cues: [], source: null };

    // 方案 A：页面数据
    const tracks = getCaptionTracksFromPlayerResponse();
    for (const track of tracks) {
      const baseUrl = track.baseUrl;
      if (!baseUrl) continue;
      try {
        // 优先请求 json3，失败再试默认格式
        const json3Url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
        const res = await fetchWithTimeout(json3Url, { credentials: 'omit' }, 12000);
        if (res.ok) {
          const text = await res.text();
          let cues = [];
          if (text && text.trim().startsWith('{')) {
            cues = parseJson3(JSON.parse(text));
          } else if (text && text.trim().startsWith('<')) {
            cues = parseXml(text);
          }
          if (cues.length) return { cues, source: 'page' };
        }
      } catch (_) {
        // 继续尝试下一个轨道
      }
    }

    // 方案 B：timedtext API 兜底
    const cues = await fetchViaTimedtextApi(videoId);
    if (cues.length) return { cues, source: 'timedtext' };

    return { cues: [], source: null };
  }

  // ==========================================================================
  // 请求 Worker
  // ==========================================================================

  /**
   * 请求摘要。
   * 实际的网络请求交给 background service worker 发出（那里持有 API_URL），
   * 内容脚本只负责传参和渲染。
   */
  async function requestSummary({ transcript, mode, title, videoId }) {
    const res = await chrome.runtime.sendMessage({
      type: 'SUMMARIZE',
      transcript,
      mode,
      title,
      videoId,
    });
    if (!res) {
      throw new Error('扩展后台无响应，请重新加载扩展');
    }
    if (!res.ok) {
      throw new Error(res.error || '请求失败');
    }
    return res;
  }

  /** 查询剩余免费次数 */
  async function checkQuota() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_QUOTA' });
    return res || { remaining: 0, limit: 10 };
  }

  // ==========================================================================
  // UI
  // ==========================================================================

  const PANEL_ID = 'yousum-panel-root';

  function createPanel() {
    if (document.getElementById(PANEL_ID)) {
      return document.getElementById(PANEL_ID);
    }

    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.className = 'yousum-root';

    root.innerHTML = `
      <div class="yousum-fab" role="button" tabindex="0" aria-label="打开 YouSum 摘要面板" title="YouSum">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-13Zm2.5 0v13h11v-13h-11Z"/>
          <path fill="currentColor" d="M8.2 8.4a1 1 0 0 1 1.52-.85l6.1 3.6a1 1 0 0 1 0 1.7l-6.1 3.6a1 1 0 0 1-1.52-.85V8.4Z"/>
        </svg>
      </div>

      <aside class="yousum-panel" hidden>
        <header class="yousum-head">
          <div class="yousum-title">
            <span class="yousum-logo">YouSum</span>
            <span class="yousum-quota" data-quota></span>
          </div>
          <button class="yousum-close" type="button" aria-label="关闭">&times;</button>
        </header>

        <div class="yousum-modes" role="tablist">
          <button class="yousum-mode is-active" data-mode="brief" role="tab">Brief<em>100字</em></button>
          <button class="yousum-mode" data-mode="detailed" role="tab">Detailed<em>要点</em></button>
          <button class="yousum-mode" data-mode="timeline" role="tab">Timeline<em>时间戳</em></button>
        </div>

        <div class="yousum-body">
          <div class="yousum-status" data-status></div>
          <pre class="yousum-output" data-output hidden></pre>
        </div>

        <footer class="yousum-foot">
          <button class="yousum-run" type="button">生成摘要</button>
          <button class="yousum-copy" type="button" hidden>复制</button>
        </footer>
      </aside>
    `;

    document.documentElement.appendChild(root);
    bindPanel(root);
    return root;
  }

  function bindPanel(root) {
    const fab = root.querySelector('.yousum-fab');
    const panel = root.querySelector('.yousum-panel');
    const closeBtn = root.querySelector('.yousum-close');
    const runBtn = root.querySelector('.yousum-run');
    const copyBtn = root.querySelector('.yousum-copy');
    const statusEl = root.querySelector('[data-status]');
    const outputEl = root.querySelector('[data-output]');
    const quotaEl = root.querySelector('[data-quota]');

    let currentMode = 'brief';
    let lastResult = '';

    const setStatus = (text, kind = 'info') => {
      statusEl.textContent = text || '';
      statusEl.className = `yousum-status${text ? ` is-${kind}` : ''}`;
      statusEl.hidden = !text;
    };

    const showOutput = (text) => {
      lastResult = text || '';
      outputEl.textContent = lastResult;
      outputEl.hidden = !lastResult;
      copyBtn.hidden = !lastResult;
    };

    const refreshQuota = async () => {
      const q = await checkQuota();
      quotaEl.textContent = `今日剩余 ${q.remaining}/${q.limit}`;
      return q;
    };

    const toggle = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) refreshQuota();
    };

    fab.addEventListener('click', toggle);
    closeBtn.addEventListener('click', () => {
      panel.hidden = true;
    });

    root.querySelectorAll('.yousum-mode').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.yousum-mode').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        currentMode = btn.dataset.mode;
      });
    });

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(lastResult);
        const original = copyBtn.textContent;
        copyBtn.textContent = '已复制';
        setTimeout(() => {
          copyBtn.textContent = original;
        }, 1500);
      } catch (_) {
        setStatus('复制失败，请手动选择文本复制', 'error');
      }
    });

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.textContent = '生成中…';
      showOutput('');
      setStatus('正在提取字幕…');

      try {
        const videoId = getVideoId();
        if (!videoId) {
          throw new Error('未识别到视频 ID，请确认当前是 YouTube 视频页');
        }

        const quota = await checkQuota();
        if (quota.remaining <= 0) {
          throw new Error('今日免费次数已用完，明天再来～');
        }

        const { cues, source } = await extractTranscript();
        if (!cues.length) {
          setStatus(
            '没有找到该视频的字幕。可能是没有字幕轨、字幕尚未生成，或需要登录 YouTube。',
            'error'
          );
          return;
        }

        let transcript = cuesToText(cues);
        if (transcript.length > MAX_TRANSCRIPT_CHARS) {
          transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
          setStatus('字幕过长，已截取前部内容进行总结', 'warn');
        } else {
          setStatus(source === 'timedtext' ? '字幕已提取（备用通道）' : '字幕已提取，正在总结…');
        }

        const data = await requestSummary({
          transcript,
          mode: currentMode,
          title: getVideoTitle(),
          videoId,
        });

        showOutput(data.summary || '');
        setStatus('');
        await refreshQuota();
      } catch (err) {
        setStatus(err.message || '生成失败，请重试', 'error');
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = '生成摘要';
      }
    });

    refreshQuota();
  }

  // ==========================================================================
  // 启动
  // ==========================================================================

  function init() {
    if (!getVideoId()) return; // 非视频页不注入
    const root = createPanel();
    if (!root.dataset.ready) {
      root.dataset.ready = '1';
      // 初次进入自动展开一次，让用户知道扩展存在
      setTimeout(() => {
        const panel = root.querySelector('.yousum-panel');
        if (panel && panel.hidden) panel.hidden = false;
      }, 800);
    }
  }

  // 监听来自 background 的消息（点击扩展图标）
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'TOGGLE_PANEL') {
      const root = createPanel();
      const panel = root.querySelector('.yousum-panel');
      panel.hidden = !panel.hidden;
    }
    return false;
  });

  // YouTube 是 SPA，切视频不重载页面，需要重新判断
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      init();
    }
  }, 1000);

  init();
})();
