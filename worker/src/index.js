/**
 * YouSum - Cloudflare Worker AI 代理层
 *
 * 职责：
 * 1. 持有 DeepSeek API Key（通过 wrangler secret 注入，永不出现在代码里）
 * 2. 转发摘要请求，按模式构造 prompt
 * 3. 速率限制 + 超时保护 + 输入校验
 *
 * 安全约定（对应安全审查修复项）：
 * - 【隐藏 API Key】API Key 只存在于 Worker 的 secret 里，扩展包内不含任何密钥。
 * - 【超时保护】对上游 DeepSeek 调用加 AbortController 超时，避免请求悬挂。
 * - 【输入校验】校验 mode / transcript / videoId，限制请求体大小与 transcript 长度。
 * - 【速率限制】按 IP 限流（可选 KV 持久化），防止刷额度。
 * - 【CORS 白名单】只放行扩展与 YouTube 来源。
 *
 * 部署：
 *   cd worker
 *   npm install
 *   wrangler login
 *   wrangler secret put DEEPSEEK_API_KEY
 *   wrangler deploy
 */

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

/**
 * 允许的来源（静态白名单）。
 *
 * 请求由扩展的 content script 发出，Origin 头为页面来源（YouTube）。
 * 同时保留扩展 origin，以防后续改为 popup/background 直接请求。
 *
 * 安全提醒：Origin 头可以被非浏览器客户端伪造，它不是真正的安全边界。
 * 真正的防线是下面的 IP 速率限制 + 每日上限。
 */
const ALLOWED_ORIGINS = [
  'https://www.youtube.com',
  'https://*.youtube.com',
  'chrome-extension://*',
];

/** 单次请求超时（毫秒）—— 防止上游卡死导致 Worker 长时间占用 */
const UPSTREAM_TIMEOUT_MS = 40000;

/** 单次请求允许的最大 transcript 长度 */
const MAX_TRANSCRIPT_CHARS = 20000;

/** 单次请求体最大字节数 */
const MAX_BODY_BYTES = 256 * 1024;

/** 模型最大输出 tokens */
const MAX_OUTPUT_TOKENS = {
  brief: 400,
  detailed: 1200,
  timeline: 1600,
};

/**
 * 速率限制配置。
 * - 单 IP 每分钟最多 REQUESTS_PER_MINUTE 次（防刷）
 * - 单 IP 每天最多 REQUESTS_PER_DAY 次（与扩展端 10 次免费额度对齐）
 */
const REQUESTS_PER_MINUTE = 12;
const REQUESTS_PER_DAY = 60;

/** 内存中的计数表：ip -> { minute: {...}, day: {...} } */
const rateBuckets = new Map();

/**
 * 可选：绑定 KV 后使用持久化计数（免费版每天 1000 次写入，够用）。
 * 未绑定 KV 时自动降级为内存计数。
 */
function getKv(env) {
  return env && env.RATE_LIMITER && env.RATE_LIMITER.get ? env.RATE_LIMITER : null;
}

function clientIp(request) {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;
  return request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}

function bucketKey(ip) {
  return `rl:${ip}`;
}

function emptyBucket() {
  const now = Date.now();
  return {
    minute: { count: 0, resetAt: now + 60_000 },
    day: { count: 0, resetAt: now + 86_400_000 },
  };
}

/**
 * 递增并检查速率限制。
 * 返回 { allowed: boolean, reason?: string, remaining: number }
 */
async function checkRateLimit(request, env) {
  const ip = clientIp(request);
  const kv = getKv(env);
  const now = Date.now();

  let bucket;
  if (kv) {
    const raw = await kv.get(bucketKey(ip));
    bucket = raw ? JSON.parse(raw) : emptyBucket();
  } else {
    bucket = rateBuckets.get(ip) || emptyBucket();
  }

  // 重置过期窗口
  if (bucket.minute.resetAt <= now) {
    bucket.minute = { count: 0, resetAt: now + 60_000 };
  }
  if (bucket.day.resetAt <= now) {
    bucket.day = { count: 0, resetAt: now + 86_400_000 };
  }

  if (bucket.minute.count >= REQUESTS_PER_MINUTE) {
    return { allowed: false, reason: 'Too many requests. Please try again in a minute.', remaining: 0 };
  }
  if (bucket.day.count >= REQUESTS_PER_DAY) {
    return { allowed: false, reason: 'Daily limit reached. Please try again tomorrow.', remaining: 0 };
  }

  bucket.minute.count += 1;
  bucket.day.count += 1;

  if (kv) {
    await kv.put(bucketKey(ip), JSON.stringify(bucket), { expirationTtl: 86_400 });
  } else {
    rateBuckets.set(ip, bucket);
    // 简单清理，避免内存无限增长
    if (rateBuckets.size > 1000) {
      const cutoff = now - 86_400_000;
      for (const [k, v] of rateBuckets) {
        if (v.day.resetAt < cutoff) rateBuckets.delete(k);
      }
    }
  }

  return { allowed: true, remaining: REQUESTS_PER_DAY - bucket.day.count };
}

// ============================================================================
// Prompt 构造
// ============================================================================

/**
 * 基础 system prompt。
 *
 * 关键点：产品面向海外市场，**无论字幕是什么语言，输出统一用英文**。
 * 这是交接文档明确要求的能力：「支持多语言字幕 → 输出英文摘要」。
 */
const SYSTEM_PROMPT = `You are a professional video content analyst. You receive the captions of a YouTube video, formatted as [mm:ss] text lines.

Rules:
1. Use ONLY information that appears in the captions. Never invent facts, never add outside knowledge, never guess what was said.
2. Write the summary in English, even if the captions are in another language. Translate meaning, do not transcribe.
3. Output the summary directly. No preamble, no "Here's a summary", no meta commentary.
4. Do not use Markdown headings (#), code blocks, or tables. Plain text only.
5. Keep the tone neutral and factual.`;

/** 各模式的指令 */
const MODE_PROMPTS = {
  brief: `Write a brief summary of about 100 words (roughly 80-120 words).
Requirements:
- One continuous paragraph. No bullet points, no lists.
- Cover the core topic and the main takeaway.
- Plain prose only.`,

  detailed: `Write a detailed summary of the key points.
Requirements:
- A bulleted list, one point per line, each line starting with "• ".
- Each point is a complete sentence of roughly 15-40 words.
- 5 to 10 points covering the main arguments, evidence, and conclusions.
- Keep the original order of the video.`,

  timeline: `Write a timestamped outline of the video.
Requirements:
- One entry per line in the format "[mm:ss] content".
- Use the timestamps that appear in the captions.
- Each entry is a short description of that segment (roughly 10-30 words).
- Between 6 and 15 entries, in chronological order.
- Match the timestamp format used in the captions.`,
};

// ============================================================================
// 请求处理
// ============================================================================

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/**
 * 扩展 ID 锁定（可选，通过 wrangler secret 配置）。
 *
 * 设置后（例如 ALLOWED_EXTENSION_ID = "abcdefghijklmnopqrstuvwxyzabcdef"），
 * 只有这个扩展的 origin 能调用 Worker，其他扩展 origin 一律拒绝。
 * 不设置时放行任意 chrome-extension://（此时唯一防线是速率限制）。
 *
 * 注意：主流程的请求由 content script 发出，Origin 是 YouTube 页面来源；
 * 这个开关主要防的是「其他扩展直接调用你的 Worker 刷额度」。
 *
 * 正式上架后建议锁定：wrangler secret put ALLOWED_EXTENSION_ID
 */
function extensionIdFromEnv(env) {
  const id = env && env.ALLOWED_EXTENSION_ID;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * 判断来源是否在白名单内。支持三种写法：
 *   - 精确匹配：'https://www.youtube.com'
 *   - 子域通配：'https://*.youtube.com'
 *   - 协议通配：'chrome-extension://*'
 */
function isOriginAllowed(origin, env) {
  if (!origin) return true; // 无 Origin 头（如 curl 健康检查）放行
  if (ALLOWED_ORIGINS.includes('*')) return true;

  // 扩展 origin：锁定后只放行指定 ID
  if (origin.startsWith('chrome-extension://')) {
    const pinnedId = extensionIdFromEnv(env);
    if (!pinnedId) return true; // 未锁定，放行
    return origin === `chrome-extension://${pinnedId}`;
  }

  return ALLOWED_ORIGINS.some((pattern) => {
    if (pattern === origin) return true;
    if (!pattern.includes('*')) return false;

    const [scheme, rest] = pattern.split('://');
    if (!origin.startsWith(`${scheme}://`)) return false;

    const originHost = origin.slice(scheme.length + 3).split('/')[0];
    const patternHost = rest.split('/')[0];

    if (patternHost === '*') return true;

    const hostRegex = new RegExp(`^${patternHost.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')}$`);
    return hostRegex.test(originHost);
  });
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
    },
  });
}

/** 校验请求体 */
function validateBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Malformed request body' };
  }
  const { transcript, mode, title, videoId } = body;

  if (!Object.prototype.hasOwnProperty.call(MODE_PROMPTS, mode)) {
    return { ok: false, error: `Unsupported summary mode: ${mode}` };
  }
  if (typeof transcript !== 'string' || !transcript.trim()) {
    return { ok: false, error: 'Transcript is empty' };
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return { ok: false, error: 'Transcript is too long' };
  }
  if (videoId !== undefined && videoId !== null && videoId !== '') {
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId))) {
      return { ok: false, error: 'Invalid video ID' };
    }
  }
  return {
    ok: true,
    data: {
      transcript,
      mode,
      title: typeof title === 'string' ? title.slice(0, 200) : '',
      videoId: videoId ? String(videoId) : '',
    },
  };
}

/** 调用 DeepSeek（带超时保护） */
async function callDeepSeek(env, { transcript, mode, title, videoId }) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const err = new Error('Server is missing DEEPSEEK_API_KEY');
    err.status = 500;
    throw err;
  }

  const userContent = [
    title ? `Video title: ${title}` : '',
    videoId ? `Video ID: ${videoId}` : '',
    '',
    'Captions:',
    transcript,
  ]
    .filter(Boolean)
    .join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: `${SYSTEM_PROMPT}\n\n${MODE_PROMPTS[mode]}` },
          { role: 'user', content: userContent },
        ],
        temperature: mode === 'timeline' ? 0.2 : 0.4,
        max_tokens: MAX_OUTPUT_TOKENS[mode] || 800,
        stream: false,
      }),
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message || j?.message || text;
      } catch (_) {
        /* 保留原始文本 */
      }
      const err = new Error(`AI service error: ${String(detail).slice(0, 300)}`);
      err.status = res.status === 429 ? 429 : 502;
      throw err;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      const err = new Error('AI service returned an unreadable response');
      err.status = 502;
      throw err;
    }

    const summary = data?.choices?.[0]?.message?.content;
    if (typeof summary !== 'string' || !summary.trim()) {
      const err = new Error('AI service returned an empty result');
      err.status = 502;
      throw err;
    }

    return {
      summary: summary.trim(),
      usage: data?.usage || null,
      model: data?.model || DEEPSEEK_MODEL,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('AI service timed out');
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 入口
// ============================================================================

export default {
  async fetch(request, env) {
    // Origin 头可能不存在（如 curl、服务端探测），此时用 null 表示"无来源"
    const origin = request.headers.get('Origin');

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 健康检查（放在方法校验之前，且不消耗速率额度）
    if (new URL(request.url).pathname === '/health') {
      return json({ ok: true, service: 'yousum-proxy' }, 200, origin);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method Not Allowed' }, 405, origin);
    }

    if (!isOriginAllowed(origin, env)) {
      return json({ error: 'Origin not allowed' }, 403, origin);
    }

    // 速率限制
    const limit = await checkRateLimit(request, env);
    if (!limit.allowed) {
      return json({ error: limit.reason, code: 'RATE_LIMITED' }, 429, origin);
    }

    // 读取并校验请求体
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: 'Request body too large' }, 413, origin);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch (_) {
      return json({ error: 'Invalid JSON' }, 400, origin);
    }

    const check = validateBody(body);
    if (!check.ok) {
      return json({ error: check.error, code: 'INVALID_INPUT' }, 400, origin);
    }

    // 转发给 DeepSeek
    try {
      const result = await callDeepSeek(env, check.data);
      return json({ ...result, remaining: limit.remaining }, 200, origin);
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.message, code: 'UPSTREAM_ERROR' }, status, origin);
    }
  },
};
