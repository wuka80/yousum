/**
 * YouSum - background service worker
 *
 * 职责：
 * 1. 接收内容脚本的摘要请求，转发到 Cloudflare Worker（AI 代理层）。
 * 2. 维护本地每日免费额度（10 次/天，无需登录），失败自动退还。
 * 3. 处理扩展图标点击，向当前标签页的浮层发消息。
 *
 * 为什么请求放在这里而不是内容脚本？
 * 内容脚本里的 fetch() 受页面 CORS 约束，容易在真实环境中失败；
 * 而后台 service worker 的请求以扩展身份发出，由 host_permissions 授权，
 * 不受页面 CORS 干扰。因此 API_URL 只在这里配置一处。
 *
 * 安全约定：
 * - DeepSeek API Key 只存在于 Cloudflare Worker 侧（wrangler secret），扩展端永不持有。
 * - 扩展端只认识自己的 Worker，不认识任何第三方 AI 接口。
 */

/**
 * Cloudflare Worker 地址。
 * 部署后替换为实际地址（见 DEPLOY.md 第 3 步）。
 */
const API_URL = 'https://yousum-proxy.YOUR-SUBDOMAIN.workers.dev';

/** 每天免费次数上限 */
const FREE_QUOTA_PER_DAY = 10;

/** 单次请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 45000;

/** 额度存储键 */
const USAGE_KEY = 'yousumUsage';

// ============================================================================
// 每日额度
// ============================================================================

/** 取本机时区的 YYYY-MM-DD，避免 UTC 跨日导致额度提前重置 */
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function readUsage() {
  const stored = await chrome.storage.local.get(USAGE_KEY);
  const usage = stored[USAGE_KEY];
  if (!usage || usage.date !== todayKey()) {
    return { date: todayKey(), count: 0 };
  }
  return { date: usage.date, count: usage.count || 0 };
}

async function writeUsage(usage) {
  await chrome.storage.local.set({ [USAGE_KEY]: usage });
}

async function getQuotaStatus() {
  const usage = await readUsage();
  return {
    used: usage.count,
    remaining: Math.max(0, FREE_QUOTA_PER_DAY - usage.count),
    limit: FREE_QUOTA_PER_DAY,
  };
}

async function consumeQuota() {
  const usage = await readUsage();
  if (usage.count >= FREE_QUOTA_PER_DAY) {
    return { ok: false, remaining: 0, limit: FREE_QUOTA_PER_DAY };
  }
  await writeUsage({ date: usage.date, count: usage.count + 1 });
  return { ok: true, remaining: FREE_QUOTA_PER_DAY - usage.count - 1, limit: FREE_QUOTA_PER_DAY };
}

async function refundQuota() {
  const usage = await readUsage();
  if (usage.count > 0) {
    await writeUsage({ date: usage.date, count: usage.count - 1 });
  }
}

// ============================================================================
// 与 Worker 通信
// ============================================================================

async function callWorker(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`服务返回了无法解析的响应 (HTTP ${res.status})`);
    }

    if (!res.ok) {
      throw new Error(data?.error || `服务返回错误 (HTTP ${res.status})`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('请求超时，请稍后再试或换一个较短的视频');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 消息路由
// ============================================================================

const handlers = {
  async GET_QUOTA() {
    return getQuotaStatus();
  },

  /** 摘要请求：先占额度，成功保留，失败退还 */
  async SUMMARIZE(message) {
    const quota = await consumeQuota();
    if (!quota.ok) {
      return {
        ok: false,
        code: 'QUOTA_EXCEEDED',
        error: `今日免费次数已用完（${FREE_QUOTA_PER_DAY} 次/天），明天再来～`,
        remaining: 0,
      };
    }

    try {
      const data = await callWorker({
        transcript: message?.transcript,
        mode: message?.mode,
        title: message?.title,
        videoId: message?.videoId,
      });
      return { ok: true, summary: data.summary, remaining: quota.remaining, limit: quota.limit };
    } catch (err) {
      await refundQuota();
      return {
        ok: false,
        code: 'UPSTREAM_ERROR',
        error: err.message || '请求失败',
        remaining: quota.remaining,
      };
    }
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, code: 'INTERNAL_ERROR', error: err.message }));
  return true; // 异步响应
});

// ============================================================================
// 图标点击 → 打开侧边浮层
// ============================================================================

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch {
    // 页面尚未注入内容脚本（例如非 YouTube 页面），忽略
  }
});
