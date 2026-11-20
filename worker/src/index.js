/**
 * YouSum - Cloudflare Worker AI 代理层
 *
 * 职责：
 * 1. 持有 DeepSeek API Key（通过 wrangler secret 注入，永不出现在代码里）
 * 2. 转发摘要请求，构造对应模式的 prompt
 * 3. 速率限制 + 超时保护 + 输入校验
 *
 * 部署：
 *   cd worker
 *   wrangler login
 *   wrangler secret put DEEPSEEK_API_KEY
 *   wrangler deploy
 */

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

/**
 * 允许的来源（静态白名单）。
 *
 * 请求由扩展的 background service worker 发出，Origin 头为
 * chrome-extension://<扩展ID>。同时保留 YouTube 域名，
 * 以防将来改为由内容脚本直接发起请求。
 *
 * 安全提醒：Origin 头可以被非浏览器客户端伪造，它不是真正的安全边界。
 * 真正的防线是下面的 IP 速率限制 + 每日上限。收紧 Origin 只是减少误用。
 */
const ALLOWED_ORIGINS = [
  'https://www.youtube.com',
  'https://*.youtube.com',
];

/**
 * 扩展 ID 锁定（可选，通过 wrangler secret 或 vars 配置）。
 *
 * 设置后（例如 ALLOWED_EXTENSION_ID = "abcdefghijklmnopqrstuvwxyzabcdef"），
 * 只有这个扩展能调用 Worker，其余扩展 origin 一律拒绝。
 * 不设置时，任何扩展 origin 都会被放行 —— 此时唯一的防线是速率限制。
 *
 * 正式上架后强烈建议锁定：wrangler secret put ALLOWED_EXTENSION_ID
 */
function extensionIdFromEnv(env) {
  const id = env && env.ALLOWED_EXTENSION_ID;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** 单次请求超时 */
const UPSTREAM_TIMEOUT_MS = 40000;

/** 单次请求允许的最大 transcript 长度 */
const MAX_TRANSCRIPT_CHARS = 20000;

/** 单次请求体最大字节数 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 速率限制配置。
 * - 单 IP 每分钟最多 REQUESTS_PER_MINUTE 次（防刷）
 * - 单 IP 每天最多 REQUESTS_PER_DAY 次（与扩展端 10 次免费额度对齐）
 */
const REQUESTS_PER_MINUTE = 12;
const REQUESTS_PER_DAY = 60;

/** 内存中的计数表：ip -> { minute: {count, resetAt}, day: {count, resetAt} } */
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
    return { allowed: false, reason: '请求过于频繁，请稍后再试', remaining: 0 };
  }
  if (bucket.day.count >= REQUESTS_PER_DAY) {
    return { allowed: false, reason: '今日调用次数已达上限，请明天再试', remaining: 0 };
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

const SYSTEM_PROMPT = `你是一个专业的视频内容分析师。你会收到一段 YouTube 视频的字幕（格式为 [mm:ss] 文本）。
请基于字幕内容输出摘要，要求：
1. 只使用字幕中出现的信息，不要臆造或补充外部知识。
2. 使用与字幕相同的语言输出（字幕是中文就输出中文，字幕是英文就输出英文）。
3. 直接输出结果，不要加前言或"以下是摘要"之类的开场白。
4. 不要使用 Markdown 标题符号（#）、代码块或表格。`;

const MODE_PROMPTS = {
  brief: `请写一份 100 字以内的极简摘要，概括视频的核心内容与结论。
要求：单段连续文本，不要分点，不要列表。字数控制在 80-120 字之间。`,

  detailed: `请写一份完整的要点总结。
要求：
- 以"• "开头的要点列表，每行一个要点。
- 每个要点是一句完整的话，控制在 15-40 字。
- 要点数量控制在 5-10 条，覆盖视频的主要论点、论据和结论。
- 按视频内容的原始顺序排列。`,

  timeline: `请写一份带时间戳的大纲。
要求：
- 每行一个条目，格式为 "[mm:ss] 内容"，时间戳取自字幕中的时间标记。
- 条目内容是对该时间段内容的简短概括（10-30 字）。
- 条目数量控制在 6-15 条，按时间顺序排列。
- 时间戳格式与字幕中出现的格式保持一致。`,
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
 * 判断来源是否在白名单内。支持三种写法：
 *   - 精确匹配：'https://www.youtube.com'
 *   - 子域通配：'https://*.youtube.com'
 *
 * 扩展 origin 的处理规则：
 *   - 设置了 ALLOWED_EXTENSION_ID → 只放行该扩展 ID
 *   - 未设置 → 放行任意 chrome-extension://（由速率限制兜底）
 */
function isOriginAllowed(origin, env) {
  if (!origin) return true; // 无 Origin 头（如 curl 健康检查）放行
  if (ALLOWED_ORIGINS.includes('*')) return true;

  // 扩展 origin
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
    return { ok: false, error: '请求体格式错误' };
  }
  const { transcript, mode, title, videoId } = body;

  if (!MODE_PROMPTS[mode]) {
    return { ok: false, error: `不支持的摘要模式: ${mode}` };
  }
  if (typeof transcript !== 'string' || !transcript.trim()) {
    return { ok: false, error: '字幕内容为空' };
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return { ok: false, error: '字幕内容过长' };
  }
  if (videoId !== undefined && videoId !== null && !/^[A-Za-z0-9_-]{11}$/.test(String(videoId))) {
    return { ok: false, error: '视频 ID 格式错误' };
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

/** 调用 DeepSeek */
async function callDeepSeek(env, { transcript, mode, title, videoId }) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const err = new Error('服务端未配置 DEEPSEEK_API_KEY');
    err.status = 500;
    throw err;
  }

  const userContent = [
    title ? `视频标题：${title}` : '',
    videoId ? `视频 ID：${videoId}` : '',
    '',
    '字幕：',
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
        max_tokens: mode === 'brief' ? 300 : mode === 'timeline' ? 1200 : 1000,
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
      const err = new Error(`AI 服务返回错误: ${String(detail).slice(0, 300)}`);
      err.status = res.status === 429 ? 429 : 502;
      throw err;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      const err = new Error('AI 服务返回了无法解析的响应');
      err.status = 502;
      throw err;
    }

    const summary = data?.choices?.[0]?.message?.content;
    if (typeof summary !== 'string' || !summary.trim()) {
      const err = new Error('AI 服务返回了空结果');
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
      const e = new Error('AI 服务响应超时');
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
      return json({ error: '请求体过大' }, 413, origin);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch (_) {
      return json({ error: 'JSON 解析失败' }, 400, origin);
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
