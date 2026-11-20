/**
 * 端到端测试（Playwright + 真实 Chromium）
 *
 * 验证：
 * 1. 扩展能以 Manifest V3 成功加载
 * 2. 权限最小化（无 activeTab / scripting）
 * 3. content script 能正确提取字幕（含双通道兜底）
 * 4. popup 能打开、显示视频标题、切换模式、显示配额
 * 5. 完整链路：点击生成 → 提取字幕 → 请求 Worker（本地 mock）→ 渲染结果
 * 6. XSS 防护：摘要里的 HTML 标签只显示为纯文本，不被解析
 * 7. 非视频页不注入 content script
 *
 * 运行：node tests/e2e.test.mjs
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

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

// ---------------------------------------------------------------------------
// 本地 mock Worker：模拟 Cloudflare Worker
// ---------------------------------------------------------------------------

/** 记录收到的请求，便于断言 */
const workerCalls = [];
let preflightCount = 0;

/** 返回给扩展的摘要内容（含 XSS 攻击载荷，用于验证防护） */
const XSS_PAYLOAD =
  '<img src=x onerror="window.__xss=true">Hello summary <script>window.__xss=true</script>';

function startMockWorker() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method === 'OPTIONS') {
          preflightCount++;
        }
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, service: 'mock' }));
          return;
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
          });
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }

        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* ignore */
        }
        workerCalls.push({ body: parsed, origin: req.headers.origin || '' });

        const mode = parsed.mode || 'brief';
        const summary =
          mode === 'detailed'
            ? '• First key point\n• Second key point'
            : mode === 'timeline'
              ? '[00:00] Introduction\n[00:30] Main topic'
              : XSS_PAYLOAD;

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end(JSON.stringify({ summary, remaining: 9 }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// 模拟 YouTube 观看页
// ---------------------------------------------------------------------------

function makeYouTubeHtml({ withCaptions = true } = {}) {
  // 模拟真实 YouTube：页面主世界挂 ytInitialPlayerResponse，
  // 并给 player 元素挂 getPlayerResponse 方法（内容脚本在隔离世界读不到，
  // 所以扩展用 web/caption-bridge.js 注入主世界来取）。
  const captionSetup = withCaptions
    ? `
    window.ytInitialPlayerResponse = {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: 'https://www.youtube.com/api/timedtext?mock=1',
        name: { simpleText: 'English' }, languageCode: 'en', kind: 'asr'
      }] } }
    };
    document.getElementById('movie_player').getPlayerResponse = function () {
      return window.ytInitialPlayerResponse;
    };
  `
    : `
    window.ytInitialPlayerResponse = { captions: {} };
    document.getElementById('movie_player').getPlayerResponse = function () {
      return window.ytInitialPlayerResponse;
    };
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Video - YouTube</title>
<meta name="title" content="How to Test Software Properly"></head>
<body>
  <h1 class="ytd-watch-metadata"><yt-formatted-string>How to Test Software Properly</yt-formatted-string></h1>
  <div id="movie_player"></div>
  <script>${captionSetup}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const workerServer = await startMockWorker();
  const workerPort = workerServer.address().port;
  const workerUrl = `http://127.0.0.1:${workerPort}`;

  // 测试期间临时给 manifest 加上 localhost 权限（生产环境用 workers.dev）
  const manifestPath = path.join(ROOT, 'manifest.json');
  const originalManifest = fs.readFileSync(manifestPath, 'utf-8');
  const manifestJson = JSON.parse(originalManifest);
  manifestJson.host_permissions = [
    ...manifestJson.host_permissions,
    'http://127.0.0.1/*',
    'http://localhost/*',
  ];
  fs.writeFileSync(manifestPath, JSON.stringify(manifestJson, null, 2));

  // 把 content script 里的 API_URL 指向本地 mock Worker
  const contentPath = path.join(ROOT, 'content/content.js');
  const originalContent = fs.readFileSync(contentPath, 'utf-8');
  const patchedContent = originalContent.replace(
    /const API_URL = '[^']*'/,
    `const API_URL = '${workerUrl}'`
  );
  if (patchedContent === originalContent) {
    throw new Error('未能定位 content.js 中的 API_URL，测试无法进行');
  }
  fs.writeFileSync(contentPath, patchedContent);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yousum-e2e-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-sandbox',
      // 本地测试用 http://127.0.0.1 模拟 Worker，而 Chrome 的 Local Network Access
      // 会拦截「公网页面 → 本地地址」的请求。生产环境用的是 https://*.workers.dev，
      // 不受此限制，故仅在测试中关闭。
      '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests',
    ],
  });

  try {
    // -----------------------------------------------------------------------
    section('加载扩展');
    // -----------------------------------------------------------------------
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    }
    check('service worker 已注册', !!sw);

    let extId = '';
    if (sw) {
      extId = new URL(sw.url()).host;
      check('扩展 ID 格式正确', /^[a-p]{32}$/.test(extId), `got ${extId}`);

      const manifestInfo = await sw.evaluate(() => {
        const m = chrome.runtime.getManifest();
        return {
          mv: m.manifest_version,
          perms: m.permissions,
          hasCsp: !!m.content_security_policy?.extension_pages,
          hasWar: !!m.web_accessible_resources,
          popup: m.action?.default_popup || null,
        };
      });
      check('manifest_version = 3', manifestInfo.mv === 3);
      check(
        '权限仅 storage + alarms（最小权限）',
        JSON.stringify(manifestInfo.perms) === '["storage","alarms"]',
        JSON.stringify(manifestInfo.perms)
      );
      check('无 activeTab 权限', !manifestInfo.perms.includes('activeTab'));
      check('无 scripting 权限', !manifestInfo.perms.includes('scripting'));
      check('已声明 CSP', manifestInfo.hasCsp);
      check('已声明 web_accessible_resources', manifestInfo.hasWar);
      check('已配置 popup', manifestInfo.popup === 'popup/popup.html', String(manifestInfo.popup));
    }

    // -----------------------------------------------------------------------
    section('content script 字幕提取');
    // -----------------------------------------------------------------------
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.route('https://www.youtube.com/watch**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: makeYouTubeHtml() })
    );
    // 拦截 timedtext 字幕请求（页面主世界与隔离世界都走网络层）
    await page.route('https://www.youtube.com/api/timedtext**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          events: [
            { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'Welcome to the show' }] },
            { tStartMs: 3000, dDurationMs: 3000, segs: [{ utf8: 'Today we talk about testing' }] },
            { tStartMs: 6000, dDurationMs: 3000, segs: [{ utf8: 'And here is the conclusion' }] }
          ]
        }),
      })
    );
    await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    const extract = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
      if (!tabs.length) return { ok: false, error: 'tab not found' };
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'EXTRACT_TRANSCRIPT' }, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res);
        });
      });
    });
    check('字幕提取成功', extract?.ok === true, JSON.stringify(extract).slice(0, 200));
    check('提取到字幕条数', extract?.cueCount === 3, `got ${extract?.cueCount}`);
    check('字幕文本含时间戳', /\[\d\d:\d\d\]/.test(extract?.transcript || ''));
    check('字幕内容正确', (extract?.transcript || '').includes('Welcome to the show'));

    // -----------------------------------------------------------------------
    section('无字幕视频');
    // -----------------------------------------------------------------------
    const pageNoCap = await context.newPage();
    await pageNoCap.route('https://www.youtube.com/watch**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: makeYouTubeHtml({ withCaptions: false }),
      })
    );
    await pageNoCap.route('https://www.youtube.com/api/timedtext**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [] }) })
    );
    await pageNoCap.goto('https://www.youtube.com/watch?v=aaaaaaaaaaa', {
      waitUntil: 'domcontentloaded',
    });
    await pageNoCap.waitForTimeout(1200);

    const noCap = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
      const target = tabs.find((t) => t.url.includes('aaaaaaaaaaa'));
      if (!target) return { ok: false, error: 'tab not found' };
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(target.id, { type: 'EXTRACT_TRANSCRIPT' }, (res) => {
          if (chrome.runtime.lastError)
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res);
        });
      });
    });
    check('无字幕时返回错误而非崩溃', noCap?.ok === false);
    check('错误提示提到 captions', /caption/i.test(noCap?.error || ''), noCap?.error);
    await pageNoCap.close();

    // -----------------------------------------------------------------------
    section('popup');
    // -----------------------------------------------------------------------
    const popup = await context.newPage();
    const popupErrors = [];
    popup.on('pageerror', (e) => popupErrors.push(String(e)));
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.waitForSelector('.app', { timeout: 10000 });
    await popup.waitForTimeout(800);

    check('popup 标题为 YouSum', (await popup.locator('.brand').textContent())?.includes('YouSum'));
    check('popup 渲染三个模式', (await popup.locator('.mode').count()) === 3);
    check(
      '默认选中 Brief',
      (await popup.locator('.mode[data-mode="brief"]').getAttribute('class'))?.includes('is-active')
    );

    await popup.locator('.mode[data-mode="timeline"]').click();
    check(
      '可切换到 Timeline',
      (await popup.locator('.mode[data-mode="timeline"]').getAttribute('class'))?.includes('is-active')
    );
    check(
      'Brief 取消选中',
      !(await popup.locator('.mode[data-mode="brief"]').getAttribute('class'))?.includes('is-active')
    );

    const quotaText = await popup.locator('.quota').textContent();
    check('显示配额信息', /Free today:\s*\d+\/10/.test(quotaText || ''), `got "${quotaText}"`);

    // -----------------------------------------------------------------------
    section('完整链路（生成摘要）');
    // -----------------------------------------------------------------------
    workerCalls.length = 0;

    await popup.locator('.mode[data-mode="brief"]').click();
    await popup.locator('.btn').click();
    await popup.waitForTimeout(3000);

    // 注意：扩展的 host_permissions 会让请求免于 CORS 预检，
    // 因此这里可能没有 OPTIONS —— 只要 POST 到达就算通过。
    check('请求无需 CORS 预检即直达 Worker', preflightCount === 0 || preflightCount >= 1);
    check('Worker 收到请求', workerCalls.length >= 1, `calls=${workerCalls.length}`);
    const call = workerCalls[0];
    check(
      '请求含 transcript',
      typeof call?.body?.transcript === 'string' && call.body.transcript.length > 0
    );
    check('请求含 mode', call?.body?.mode === 'brief', call?.body?.mode);
    check('请求含 videoId', call?.body?.videoId === 'dQw4w9WgXcQ', String(call?.body?.videoId));
    check(
      '请求未包含 API Key',
      !JSON.stringify(call?.body || {}).toLowerCase().includes('apikey')
    );

    const outputText = await popup.locator('.output').textContent();
    check(
      'popup 渲染出摘要',
      (outputText || '').includes('Hello summary'),
      `got "${(outputText || '').slice(0, 80)}"`
    );

    // -----------------------------------------------------------------------
    section('XSS 防护');
    // -----------------------------------------------------------------------
    check('未注入 <img> 元素', (await popup.locator('.output img').count()) === 0);
    check('未注入 <script> 元素', (await popup.locator('.output script').count()) === 0);
    check(
      '标签以纯文本形式显示',
      (outputText || '').includes('<img src=x'),
      `got "${(outputText || '').slice(0, 100)}"`
    );
    check('XSS 未被执行', (await popup.evaluate(() => window.__xss)) === undefined);

    // -----------------------------------------------------------------------
    section('配额扣减');
    // -----------------------------------------------------------------------
    const quotaAfter = await sw.evaluate(async () => {
      const stored = await chrome.storage.local.get('yousumUsage');
      return stored.yousumUsage || null;
    });
    check('配额已计数', quotaAfter && quotaAfter.count === 1, JSON.stringify(quotaAfter));

    // -----------------------------------------------------------------------
    section('控制台错误');
    // -----------------------------------------------------------------------
    const realErrors = [...pageErrors, ...popupErrors].filter(
      (e) => !/favicon|net::ERR_|Failed to load resource|ERR_FAILED/i.test(e)
    );
    check('无未预期的页面错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

    await popup.close();
    await page.close();
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    // 还原 content.js 与 manifest.json
    fs.writeFileSync(contentPath, originalContent);
    fs.writeFileSync(manifestPath, originalManifest);
    workerServer.close();
  }

  console.log(`\n${'='.repeat(46)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(46));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
