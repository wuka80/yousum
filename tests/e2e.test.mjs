/**
 * 扩展端到端测试（Playwright + 真实 Chromium）
 *
 * 验证：
 * 1. 扩展能以 Manifest V3 成功加载（无 manifest 错误）
 * 2. service worker 正常注册
 * 3. 在模拟的 YouTube 页面上，浮层面板正确注入并渲染
 * 4. 三种模式可切换
 * 5. 额度显示正确
 *
 * 运行：node tests/e2e.test.mjs
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

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

// 模拟一个 YouTube 观看页，提供最小化的页面结构与字幕轨
const MOCK_YOUTUBE = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>测试视频 - YouTube</title>
  <meta name="title" content="测试视频：如何学习编程">
</head>
<body>
  <h1 class="ytd-watch-metadata"><yt-formatted-string>测试视频：如何学习编程</yt-formatted-string></h1>
  <div id="movie_player"></div>
  <div id="content"></div>
  <script>
    // 模拟 ytInitialPlayerResponse，含一条字幕轨
    window.ytInitialPlayerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?mock=1',
              name: { simpleText: 'Chinese' },
              languageCode: 'zh-Hans',
              kind: 'asr'
            }
          ]
        }
      }
    };
    // 拦截字幕请求，返回一段 json3 格式字幕
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (url && url.includes('/api/timedtext')) {
        return new Response(JSON.stringify({
          events: [
            { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: '大家好' }, { utf8: '，今天聊如何学习编程' }] },
            { tStartMs: 3000, dDurationMs: 3000, segs: [{ utf8: '第一步是先打好基础' }] },
            { tStartMs: 6000, dDurationMs: 3000, segs: [{ utf8: '第二步是动手实践' }] },
            { tStartMs: 9000, dDurationMs: 3000, segs: [{ utf8: '第三步是持续复盘' }] }
          ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch.call(window, input, init);
    };
  </script>
</body>
</html>`;

async function main() {
  const extensionPath = ROOT;

  section('加载扩展');
  // -------------------------------------------------------------------------
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yousum-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // 用完整 Chromium（而非 headless shell）—— shell 不支持加载扩展
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
  });

  // 等待 service worker 就绪
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  }
  check('service worker 已注册', !!worker, worker ? '' : '(超时)');

  if (worker) {
    const extId = new URL(worker.url()).host;
    check('扩展 ID 格式正确', /^[a-p]{32}$/.test(extId), `got ${extId}`);

    // 检查 manifest 解析无错
    const manifestOk = await worker.evaluate(() => {
      try {
        const m = chrome.runtime.getManifest();
        return !!(m && m.manifest_version === 3 && m.content_scripts?.length > 0);
      } catch (_) {
        return false;
      }
    });
    check('manifest 解析正常 (MV3 + content_scripts)', manifestOk);
  }

  section('页面注入与 UI');
  // -------------------------------------------------------------------------
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  // 用 youtube.com 的 URL 触发 content_scripts 的 matches 规则
  await page.route('https://www.youtube.com/watch**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_YOUTUBE })
  );

  await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const rootExists = await page.locator('#yousum-panel-root').count();
  check('浮层根节点已注入', rootExists === 1, `count=${rootExists}`);

  if (rootExists === 1) {
    check('FAB 按钮存在', (await page.locator('.yousum-fab').count()) === 1);
    check('面板存在', (await page.locator('.yousum-panel').count()) === 1);
    check('面板默认展开', !(await page.locator('.yousum-panel').isHidden()));

    section('模式切换');
    // -------------------------------------------------------------------------
    const modeCount = await page.locator('.yousum-mode').count();
    check('三种模式按钮齐全', modeCount === 3, `count=${modeCount}`);

    const modeLabels = await page.locator('.yousum-mode').allTextContents();
    check('含 Brief 模式', modeLabels.some((t) => t.includes('Brief')));
    check('含 Detailed 模式', modeLabels.some((t) => t.includes('Detailed')));
    check('含 Timeline 模式', modeLabels.some((t) => t.includes('Timeline')));

    // 默认选中 Brief
    const briefActive = await page.locator('.yousum-mode[data-mode="brief"]').getAttribute('class');
    check('默认选中 Brief', briefActive.includes('is-active'));

    // 切到 Timeline
    await page.locator('.yousum-mode[data-mode="timeline"]').click();
    const timelineActive = await page.locator('.yousum-mode[data-mode="timeline"]').getAttribute('class');
    check('点击后切换到 Timeline', timelineActive.includes('is-active'));
    const briefInactive = await page.locator('.yousum-mode[data-mode="brief"]').getAttribute('class');
    check('Brief 取消选中', !briefInactive.includes('is-active'));

    section('额度显示');
    // -------------------------------------------------------------------------
    const quotaText = await page.locator('[data-quota]').textContent();
    check('显示今日剩余额度', /今日剩余\s*\d+\/\d+/.test(quotaText || ''), `got "${quotaText}"`);
    check('额度上限为 10', /\/10$/.test((quotaText || '').trim()), `got "${quotaText}"`);

    section('交互');
    // -------------------------------------------------------------------------
    // 点击 FAB 应收起面板
    await page.locator('.yousum-fab').click();
    await page.waitForTimeout(300);
    check('FAB 点击可收起面板', await page.locator('.yousum-panel').isHidden());

    await page.locator('.yousum-fab').click();
    await page.waitForTimeout(300);
    check('再次点击可展开面板', !(await page.locator('.yousum-panel').isHidden()));

    // 点击"生成摘要" —— Worker 未部署，应给出友好错误而不是崩溃
    await page.locator('.yousum-run').click();
    await page.waitForTimeout(3000);

    const statusText = await page.locator('[data-status]').textContent();
    check('未部署 Worker 时显示错误提示', (statusText || '').length > 0, `got "${statusText}"`);
    check(
      '错误提示未暴露堆栈',
      !/at\s+\w+\s+\(|Error:\s*\{/.test(statusText || ''),
      `got "${statusText}"`
    );

    const btnEnabled = await page.locator('.yousum-run').isEnabled();
    check('请求结束后按钮恢复可用', btnEnabled);
  }

  section('非视频页');
  // -------------------------------------------------------------------------
  const page2 = await context.newPage();
  await page2.route('https://www.youtube.com/feed/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>feed</body></html>' })
  );
  await page2.goto('https://www.youtube.com/feed/subscriptions', { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(1200);
  const injectedOnFeed = await page2.locator('#yousum-panel-root').count();
  check('非视频页不注入浮层', injectedOnFeed === 0, `count=${injectedOnFeed}`);

  section('控制台错误');
  // -------------------------------------------------------------------------
  const realErrors = errors.filter(
    (e) => !/favicon|net::ERR_|Failed to load resource/i.test(e)
  );
  check('无未预期的控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });

  console.log(`\n${'='.repeat(46)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(46));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
