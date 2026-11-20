/**
 * YouSum - popup script
 *
 * 扩展弹窗：选择摘要模式 → 向内容脚本要摘要 → 安全渲染结果。
 *
 * 安全约定：
 * - 【XSS 防护 / 安全 DOM API】全部 UI 用 document.createElement + textContent 构建，
 *   不使用 innerHTML。AI 返回的摘要内容必定走 textContent，标签只会被当纯文本显示。
 * - 不在 popup 里直接请求 Worker，请求统一由 content script 发出，
 *   避免在多个上下文重复实现鉴权与错误处理。
 */

(() => {
  'use strict';

  /** 摘要模式（与 content script 保持一致） */
  const MODES = [
    { key: 'brief', label: 'Brief', hint: '100 words' },
    { key: 'detailed', label: 'Detailed', hint: 'Key points' },
    { key: 'timeline', label: 'Timeline', hint: 'Timestamps' },
  ];

  const app = document.getElementById('app');
  let currentMode = 'brief';
  let activeTabId = null;
  let busy = false;

  // ==========================================================================
  // DOM 工具
  // ==========================================================================

  function el(tag, options = {}) {
    const node = document.createElement(tag);
    if (options.text !== undefined && options.text !== null) {
      node.textContent = String(options.text);
    }
    if (options.className) node.className = options.className;
    if (options.attrs) {
      for (const [key, value] of Object.entries(options.attrs)) {
        node.setAttribute(key, String(value));
      }
    }
    if (options.children) {
      for (const child of options.children) {
        if (child) node.appendChild(child);
      }
    }
    return node;
  }

  // ==========================================================================
  // 状态显示
  // ==========================================================================

  const ui = {};

  function setStatus(text, kind = 'info') {
    if (!ui.status) return;
    ui.status.textContent = text || '';
    ui.status.className = `status${text ? ` is-${kind}` : ''}`;
    ui.status.hidden = !text;
  }

  function setQuota(remaining, limit) {
    if (!ui.quota) return;
    ui.quota.textContent = `Free today: ${remaining}/${limit}`;
  }

  function setOutput(text) {
    if (!ui.output) return;
    ui.output.textContent = text || '';
    ui.output.hidden = !text;
  }

  function setBusy(value) {
    busy = value;
    if (ui.run) {
      ui.run.disabled = value;
      ui.run.textContent = value ? 'Generating…' : 'Generate Summary';
    }
    if (ui.copy) ui.copy.disabled = value;
    for (const btn of ui.modeButtons || []) btn.disabled = value;
  }

  // ==========================================================================
  // 构建 UI（全部走 DOM API）
  // ==========================================================================

  function buildUI() {
    // ---- 头部 ----
    const brand = el('div', {
      className: 'brand',
      children: [el('span', { className: 'brand-mark' }), el('span', { text: 'YouSum' })],
    });

    ui.quota = el('span', { className: 'quota', text: 'Free today: —' });
    ui.status = el('div', { className: 'status', hidden: true });

    const head = el('header', {
      className: 'head',
      children: [brand, ui.quota],
    });

    // ---- 视频信息 ----
    ui.videoTitle = el('div', { className: 'video-title' });
    ui.videoMeta = el('div', { className: 'video-meta' });
    const video = el('div', {
      className: 'video',
      children: [ui.videoTitle, ui.videoMeta],
    });

    // ---- 模式选择 ----
    ui.modeButtons = [];
    const modeBox = el('div', { className: 'modes', attrs: { role: 'tablist' } });

    for (const mode of MODES) {
      const btn = el('button', {
        className: `mode${mode.key === currentMode ? ' is-active' : ''}`,
        attrs: { type: 'button', 'data-mode': mode.key, role: 'tab' },
        children: [
          el('span', { text: mode.label }),
          el('em', { text: mode.hint }),
        ],
      });
      btn.addEventListener('click', () => selectMode(mode.key));
      ui.modeButtons.push(btn);
      modeBox.appendChild(btn);
    }

    // ---- 输出区 ----
    ui.output = el('div', { className: 'output', hidden: true });

    // ---- 底部按钮 ----
    ui.run = el('button', { className: 'btn', text: 'Generate Summary', attrs: { type: 'button' } });
    ui.copy = el('button', { className: 'btn-ghost', text: 'Copy', attrs: { type: 'button' } });
    ui.copy.disabled = true;

    ui.run.addEventListener('click', generate);
    ui.copy.addEventListener('click', copyOutput);

    const foot = el('footer', { className: 'foot', children: [ui.run, ui.copy] });

    app.appendChild(head);
    app.appendChild(video);
    app.appendChild(modeBox);
    app.appendChild(ui.status);
    app.appendChild(ui.output);
    app.appendChild(foot);
  }

  function selectMode(key) {
    currentMode = key;
    for (const btn of ui.modeButtons) {
      btn.classList.toggle('is-active', btn.getAttribute('data-mode') === key);
    }
  }

  function showEmptyState(message) {
    const empty = el('div', {
      className: 'empty',
      children: [
        el('div', { className: 'empty-icon', text: '🎬' }),
        el('div', { text: message }),
      ],
    });
    app.appendChild(empty);
  }

  // ==========================================================================
  // 与内容脚本通信
  // ==========================================================================

  /** 匹配 YouTube 观看页 */
  function isYouTubeWatch(url) {
    return /^https:\/\/(www\.|m\.)?youtube\.com\/watch/.test(url || '');
  }

  /**
   * 找到要操作的标签页。
   *
   * 优先用当前窗口的活动标签页（用户直接在 YouTube 页点图标的常见情况）。
   * 如果当前标签页不是 YouTube 观看页，回退到最近打开的 YouTube 观看页 ——
   * 这样用户在别的标签页点图标也能对 YouTube 视频生成摘要。
   *
   * 注意：tabs.query 的 url 过滤条件需要 host_permissions 里有 youtube.com，
   * 本扩展已声明该权限。
   */
  async function findTargetTab() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && isYouTubeWatch(active.url)) return active;

    try {
      const watchTabs = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
      if (watchTabs && watchTabs.length) {
        // lastAccessed 越新越靠前
        watchTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        return watchTabs[0];
      }
    } catch (_) {
      // 没有 url 权限时会抛错，忽略即可
    }

    return active || null;
  }

  function sendToContent(type, payload) {
    return new Promise((resolve) => {
      if (!activeTabId) {
        resolve({ ok: false, error: 'No active tab' });
        return;
      }
      chrome.tabs.sendMessage(activeTabId, { type, ...(payload || {}) }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: 'No response from page' });
      });
    });
  }

  async function loadQuota() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_QUOTA' });
    if (res && typeof res.remaining === 'number') {
      setQuota(res.remaining, res.limit);
    }
  }

  async function init() {
    buildUI();

    const tab = await findTargetTab();
    activeTabId = tab ? tab.id : null;

    const quota = await chrome.runtime.sendMessage({ type: 'GET_QUOTA' });
    if (quota && typeof quota.remaining === 'number') {
      setQuota(quota.remaining, quota.limit);
    }

    if (!tab || !isYouTubeWatch(tab.url)) {
      ui.videoTitle.textContent = 'No YouTube video found';
      ui.videoMeta.textContent = 'Open a YouTube watch page, then click again.';
      ui.run.disabled = true;
      showEmptyState('Open a YouTube video and click the YouSum icon.');
      return;
    }

    const info = await sendToContent('GET_PAGE_INFO');
    if (info && info.ok) {
      ui.videoTitle.textContent = info.title || 'Untitled video';
      ui.videoMeta.textContent = info.isVideoPage ? 'Ready to summarize' : 'Not a video page';
    }
  }

  async function generate() {
    if (busy) return;

    setBusy(true);
    setStatus('Extracting captions…');
    setOutput('');

    try {
      const res = await sendToContent('GENERATE_SUMMARY', { mode: currentMode });

      if (!res || !res.ok) {
        setStatus((res && res.error) || 'Failed to generate summary', 'error');
        return;
      }

      // 【XSS 防护】摘要内容走 textContent，HTML 标签只会显示为纯文本
      setOutput(res.summary || '(empty summary)');

      const notes = [];
      if (res.truncated) notes.push('long transcript truncated');
      if (typeof res.remaining === 'number') setQuota(res.remaining, 10);
      setStatus(notes.length ? notes.join(' · ') : 'Done', notes.length ? 'warn' : 'ok');
    } catch (err) {
      setStatus(err?.message || 'Unexpected error', 'error');
    } finally {
      setBusy(false);
      ui.copy.disabled = !ui.output.textContent;
    }
  }

  async function copyOutput() {
    try {
      await navigator.clipboard.writeText(ui.output.textContent);
      const original = ui.copy.textContent;
      ui.copy.textContent = 'Copied';
      setTimeout(() => {
        ui.copy.textContent = original;
      }, 1400);
    } catch (_) {
      setStatus('Copy failed — select the text and copy manually', 'error');
    }
  }

  init();
})();
