/**
 * YouSum - background service worker
 *
 * 职责：
 * 1. 维护本地每日免费额度（10 次/天，无需登录），失败自动退还
 * 2. 用 chrome.alarms 触发每日额度重置
 *
 * 安全约定（对应安全审查修复项）：
 * - 【Service Worker 用 alarms 替代 setInterval】MV3 的 service worker 随时可能被挂起，
 *   setInterval 不可靠。这里用 chrome.alarms 做定时任务，唤醒后必然执行。
 * - 【最小权限】只申请 storage，不申请 tabs / activeTab / scripting。
 * - DeepSeek API Key 只存在于 Cloudflare Worker 侧，扩展端永不持有。
 */

/** 每天免费次数上限 */
const FREE_QUOTA_PER_DAY = 10;

/** 额度存储键 */
const USAGE_KEY = 'yousumUsage';

/** 每日重置闹钟名称 */
const DAILY_RESET_ALARM = 'yousum-daily-reset';

// ============================================================================
// 每日额度
// ============================================================================

/**
 * 取本机时区的 YYYY-MM-DD。
 * 用本地时区而非 UTC，避免跨时区用户在午夜前后额度被提前重置或延后重置。
 */
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

/** 占用一次额度；已用尽则返回 ok:false */
async function consumeQuota() {
  const usage = await readUsage();
  if (usage.count >= FREE_QUOTA_PER_DAY) {
    return { ok: false, remaining: 0, limit: FREE_QUOTA_PER_DAY };
  }
  await writeUsage({ date: usage.date, count: usage.count + 1 });
  return {
    ok: true,
    remaining: FREE_QUOTA_PER_DAY - usage.count - 1,
    limit: FREE_QUOTA_PER_DAY,
  };
}

/** 请求失败时退还额度 */
async function refundQuota() {
  const usage = await readUsage();
  if (usage.count > 0) {
    await writeUsage({ date: usage.date, count: usage.count - 1 });
  }
}

// ============================================================================
// 每日重置闹钟（用 alarms 替代 setInterval）
// ============================================================================

/**
 * 安排每日 0 点重置额度。
 *
 * 严格说额度是「按日期惰性重置」的（读取时发现日期变了就当作新的一天），
 * 这个闹钟只是把存储里的旧记录清掉，避免残留数据。
 * 惰性判断才是真正的正确性来源，闹钟只是善后。
 */
async function scheduleDailyReset() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);

  await chrome.alarms.clear(DAILY_RESET_ALARM);
  await chrome.alarms.create(DAILY_RESET_ALARM, {
    when: nextMidnight.getTime(),
    periodInMinutes: 24 * 60,
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== DAILY_RESET_ALARM) return;
  await writeUsage({ date: todayKey(), count: 0 });
  await scheduleDailyReset();
});

// service worker 启动时（安装 / 唤醒）确保闹钟存在
chrome.runtime.onInstalled.addListener(() => {
  scheduleDailyReset();
});
chrome.runtime.onStartup.addListener(() => {
  scheduleDailyReset();
});

// ============================================================================
// 消息路由
// ============================================================================

const handlers = {
  async GET_QUOTA() {
    return getQuotaStatus();
  },

  async QUOTA_CONSUME() {
    return consumeQuota();
  },

  async QUOTA_REFUND() {
    await refundQuota();
    return getQuotaStatus();
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
