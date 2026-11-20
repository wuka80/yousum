/**
 * Worker 逻辑测试（不调用真实 DeepSeek）
 *
 * 用 mock fetch 验证：参数校验、速率限制、CORS、上游错误处理、三种模式的 prompt 构造。
 *
 * 运行：node worker/test/worker.test.mjs
 */

import worker from '../worker/src/index.js';

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

/** 记录被 mock 的调用 */
const calls = [];
let mockBehavior = { status: 200, body: { summary: 'mock summary' } };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const { status, body } = mockBehavior;
  if (status !== 200) {
    return new Response(JSON.stringify({ error: { message: 'upstream boom' } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

const env = { DEEPSEEK_API_KEY: 'sk-test-key' };

function makeRequest(body, { method = 'POST', origin = 'https://www.youtube.com', path = '/summarize' } = {}) {
  const url = `https://yousum-proxy.test${path}`;
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'CF-Connecting-IP': '1.2.3.4',
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

const validBody = {
  transcript: '[00:00] hello world\n[00:05] this is a test',
  mode: 'brief',
  title: 'Test Video',
  videoId: 'dQw4w9WgXcQ',
};

// ---------------------------------------------------------------------------
section('健康检查');
// ---------------------------------------------------------------------------
{
  const res = await worker.fetch(new Request('https://yousum-proxy.test/health'), env);
  const data = await res.json();
  check('GET /health 返回 200', res.status === 200);
  check('返回 ok:true', data.ok === true);
}

// ---------------------------------------------------------------------------
section('参数校验');
// ---------------------------------------------------------------------------
{
  calls.length = 0;
  const res = await worker.fetch(makeRequest({ ...validBody, mode: 'bogus' }), env);
  const data = await res.json();
  check('非法 mode 返回 400', res.status === 400);
  check('错误码 INVALID_INPUT', data.code === 'INVALID_INPUT');
  check('未调用上游', calls.length === 0);
}
{
  const res = await worker.fetch(makeRequest({ ...validBody, transcript: '   ' }), env);
  check('空字幕返回 400', res.status === 400);
}
{
  const res = await worker.fetch(makeRequest({ ...validBody, videoId: 'bad!!id' }), env);
  check('非法 videoId 返回 400', res.status === 400);
}
{
  const res = await worker.fetch(makeRequest({ ...validBody, transcript: 'x'.repeat(30000) }), env);
  check('超长字幕返回 400', res.status === 400);
}
{
  const res = await worker.fetch(makeRequest(validBody, { method: 'GET' }), env);
  check('非 POST 返回 405', res.status === 405);
}

// ---------------------------------------------------------------------------
section('正常请求与 prompt 构造');
// ---------------------------------------------------------------------------
{
  calls.length = 0;
  mockBehavior = {
    status: 200,
    body: {
      choices: [{ message: { content: '  这是摘要内容。  ' } }],
      usage: { total_tokens: 123 },
      model: 'deepseek-chat',
    },
  };

  const res = await worker.fetch(makeRequest(validBody), env);
  const data = await res.json();

  check('返回 200', res.status === 200);
  check('摘要去除首尾空白', data.summary === '这是摘要内容。', `got: ${JSON.stringify(data.summary)}`);
  check('调用了 DeepSeek', calls.length === 1 && calls[0].url.includes('api.deepseek.com'));
  check('携带 API Key', calls[0].init.headers.Authorization === 'Bearer sk-test-key');

  const payload = JSON.parse(calls[0].init.body);
  check('model 为 deepseek-chat', payload.model === 'deepseek-chat');
  check('system prompt 含 brief 指令', /100 words/.test(payload.messages[0].content));
  check('user prompt 含字幕', payload.messages[1].content.includes('hello world'));
  check('user prompt 含标题', payload.messages[1].content.includes('Test Video'));
  check('brief 模式 max_tokens 较小', payload.max_tokens === 400);
  check('system prompt 要求英文输出', /Write the summary in English/i.test(payload.messages[0].content));
  check('system prompt 禁止外部知识', /ONLY information that appears in the captions/i.test(payload.messages[0].content));
  check('非流式', payload.stream === false);
}

// ---------------------------------------------------------------------------
section('三种模式的 prompt 差异');
// ---------------------------------------------------------------------------
{
  for (const [mode, expectToken, expectPattern] of [
    ['brief', 400, /100 words/],
    ['detailed', 1200, /bulleted list/],
    ['timeline', 1600, /timestamped outline/],
  ]) {
    calls.length = 0;
    mockBehavior = { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };
    await worker.fetch(makeRequest({ ...validBody, mode }), env);
    const payload = JSON.parse(calls[0].init.body);
    check(`${mode} 模式 prompt 正确`, expectPattern.test(payload.messages[0].content));
    check(`${mode} 模式 max_tokens=${expectToken}`, payload.max_tokens === expectToken);
  }
}

// ---------------------------------------------------------------------------
section('上游错误处理');
// ---------------------------------------------------------------------------
{
  mockBehavior = { status: 429, body: {} };
  const res = await worker.fetch(makeRequest(validBody), env);
  const data = await res.json();
  check('上游 429 透传为 429', res.status === 429);
  check('返回 UPSTREAM_ERROR', data.code === 'UPSTREAM_ERROR');
  check('错误信息包含上游内容', /upstream boom/.test(data.error));
}
{
  mockBehavior = { status: 500, body: {} };
  const res = await worker.fetch(makeRequest(validBody), env);
  check('上游 500 映射为 502', res.status === 502);
}

// ---------------------------------------------------------------------------
section('速率限制');
// ---------------------------------------------------------------------------
{
  // 用独立 IP 避免受前面测试影响
  const req = () =>
    new Request('https://yousum-proxy.test/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc', 'CF-Connecting-IP': '9.9.9.9' },
      body: JSON.stringify(validBody),
    });

  mockBehavior = { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };
  let limited = false;
  for (let i = 0; i < 20; i++) {
    const res = await worker.fetch(req(), env);
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  check('连续请求触发 429', limited);
}

// ---------------------------------------------------------------------------
section('CORS');
// ---------------------------------------------------------------------------
{
  const res = await worker.fetch(
    new Request('https://yousum-proxy.test/summarize', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc' } }),
    env
  );
  check('OPTIONS 返回 204', res.status === 204);
  check('带 Access-Control-Allow-Origin', !!res.headers.get('Access-Control-Allow-Origin'));
}

// ---------------------------------------------------------------------------
section('Origin 白名单');
// ---------------------------------------------------------------------------
{
  // 默认白名单为 youtube.com：内容脚本的 fetch 以页面来源发出
  const call = (origin) =>
    worker.fetch(
      new Request('https://yousum-proxy.test/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': `8.8.8.${origin.length}` },
        body: JSON.stringify(validBody),
      }),
      env
    );

  const yt = await call('https://www.youtube.com');
  check('允许 youtube.com', yt.status === 200);

  const ytM = await call('https://m.youtube.com');
  check('允许 youtube 子域', ytM.status === 200);

  const evil = await call('https://evil.example.com');
  check('拒绝陌生来源', evil.status === 403, `got ${evil.status}`);
  const evilData = await evil.json();
  check('错误码含 Origin not allowed', /Origin not allowed/.test(evilData.error));

  // 未锁定扩展 ID 时，任意扩展 origin 都放行（速率限制兜底）
  const ext = await call('chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef');
  check('未锁定时放行扩展 origin', ext.status === 200);

  // 无 Origin 头（curl / 健康检查）应放行
  const noOrigin = await worker.fetch(
    new Request('https://yousum-proxy.test/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '8.8.8.201' },
      body: JSON.stringify(validBody),
    }),
    env
  );
  check('无 Origin 头放行', noOrigin.status === 200, `got ${noOrigin.status}`);
}

// ---------------------------------------------------------------------------
section('扩展 ID 锁定');
// ---------------------------------------------------------------------------
{
  const pinnedEnv = { DEEPSEEK_API_KEY: 'sk-test-key', ALLOWED_EXTENSION_ID: 'aaaabbbbccccddddeeeeffffgggghhhh' };

  const callPinned = (origin, ip) =>
    worker.fetch(
      new Request('https://yousum-proxy.test/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip },
        body: JSON.stringify(validBody),
      }),
      pinnedEnv
    );

  const mine = await callPinned('chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh', '4.4.4.1');
  check('放行已锁定的扩展', mine.status === 200, `got ${mine.status}`);

  const other = await callPinned('chrome-extension://zzzzyyyyxxxxwwwwvvvvuuuutttttssss', '4.4.4.2');
  check('拒绝其他扩展', other.status === 403, `got ${other.status}`);

  const curlNoOrigin = await worker.fetch(
    new Request('https://yousum-proxy.test/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '4.4.4.3' },
      body: JSON.stringify(validBody),
    }),
    pinnedEnv
  );
  check('锁定后无 Origin 头仍放行（服务端调用）', curlNoOrigin.status === 200);
}

// ---------------------------------------------------------------------------
section('缺少 API Key');
// ---------------------------------------------------------------------------
{
  mockBehavior = { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };

  // 用独立 IP，避免触发前面测试累积的速率限制
  const reqNoKey = () =>
    new Request('https://yousum-proxy.test/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc', 'CF-Connecting-IP': '5.5.5.5' },
      body: JSON.stringify(validBody),
    });

  const res3 = await worker.fetch(reqNoKey(), {});
  const data = await res3.json();
  check('无 key 返回 500', res3.status === 500);
  check('错误信息提示配置 key', /DEEPSEEK_API_KEY/.test(data.error));

  // 同样的请求带上 key 应成功
  const res4 = await worker.fetch(reqNoKey(), env);
  check('有 key 时返回 200', res4.status === 200);
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(46));

globalThis.fetch = realFetch;
process.exit(failed > 0 ? 1 : 0);
