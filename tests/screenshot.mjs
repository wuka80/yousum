/**
 * 商店素材截图生成
 *
 * 输出截图供 Chrome Web Store 提交与文档使用：
 * - YouTube 页面（展示使用场景）
 * - popup 三种模式各一张
 * - 深色模式一张
 *
 * 运行：node tests/screenshot.mjs
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT_DIR = path.join(ROOT, 'screenshots');

const MOCK_YOUTUBE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>How to Learn Programming - YouTube</title>
  <meta name="title" content="How to Learn Programming: The Complete Guide">
  <style>
    body { margin:0; font-family: Arial, sans-serif; background:#0f0f0f; color:#f1f1f1; }
    .yt-header { display:flex; align-items:center; gap:20px; padding:12px 20px; background:#000; }
    .yt-logo { font-weight:bold; font-size:20px; color:#ff0000; }
    .yt-search { flex:1; max-width:420px; height:32px; background:#222; border-radius:16px; }
    .yt-body { display:flex; padding:20px; gap:20px; }
    .yt-player { width:660px; height:371px; background:#000; border-radius:12px; display:flex;
                 align-items:center; justify-content:center; color:#555; font-size:13px; }
    .yt-info h1 { font-size:20px; margin:0 0 12px; }
    .yt-info p { color:#aaa; font-size:13px; }
    .yt-chips { display:flex; gap:8px; margin-top:16px; }
    .chip { background:#272727; padding:6px 12px; border-radius:16px; font-size:13px; }
  </style>
</head>
<body>
  <div class="yt-header">
    <span class="yt-logo">▶ YouTube</span>
    <div class="yt-search"></div>
  </div>
  <div class="yt-body">
    <div class="yt-player">Video player</div>
    <div class="yt-info">
      <h1 class="ytd-watch-metadata"><yt-formatted-string>How to Learn Programming: The Complete Guide</yt-formatted-string></h1>
      <p>1.2M views · 3 days ago</p>
      <div class="yt-chips"><span class="chip">Programming</span><span class="chip">Beginners</span><span class="chip">Career</span></div>
    </div>
  </div>
  <div id="movie_player"></div>
  <script>
    window.ytInitialPlayerResponse = {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: 'https://www.youtube.com/api/timedtext?mock=1',
        name: { simpleText: 'English' }, languageCode: 'en', kind: 'asr'
      }] } }
    };
    document.getElementById('movie_player').getPlayerResponse = function () {
      return window.ytInitialPlayerResponse;
    };
  </script>
</body>
</html>`;

const SUMMARY_BRIEF = `This video lays out a practical path to learning programming: start with fundamentals, then build through hands-on projects rather than passive tutorials. It emphasizes consistency over intensity, learning to read error messages early, and building small projects that force you to apply what you just read. The speaker argues that debugging is the real skill that separates people who code from people who have only copied code, and recommends treating every error message as a lesson rather than a failure.`;

const SUMMARY_DETAILED = `• Learning to code is mostly about tolerance for confusion — every beginner spends hours on problems that later look trivial.
• Fundamentals first: syntax and data structures matter more than picking a "hot" language.
• Build real projects early, because reading tutorials is passive and projects force retrieval.
• Reading error messages carefully is the single highest-leverage beginner habit.
• Consistency beats intensity: short daily practice outperforms occasional long sessions.
• Debugging is the core skill; experienced developers are just faster at the same loop.
• Ask good questions and search effectively instead of pasting code into a chatbot.
• Build something you want to show other people, since motivation sustains long projects.`;

const SUMMARY_TIMELINE = `[00:00] Introduction: why most beginners quit learning programming
[01:45] The fundamentals that actually matter: syntax, data structures, control flow
[04:20] Why passive tutorial watching does not work
[07:10] Building small projects to force real understanding
[10:30] How to read error messages without panicking
[13:55] Debugging as the core skill of professional development
[17:20] Consistency versus intensity: picking a sustainable pace
[20:45] Asking better questions and searching effectively
[23:10] Staying motivated when the progress stops being fun
[25:30] Closing thoughts and recommended next steps`;

async function startMockWorker() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          });
          res.end();
          return;
        }
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* ignore */
        }
        const mode = parsed.mode || 'brief';
        const summary =
          mode === 'detailed'
            ? SUMMARY_DETAILED
            : mode === 'timeline'
              ? SUMMARY_TIMELINE
              : SUMMARY_BRIEF;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ summary, remaining: 9 }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const workerServer = await startMockWorker();
  const workerPort = workerServer.address().port;
  const workerUrl = `http://127.0.0.1:${workerPort}`;

  // 临时 patch：API_URL 指向 mock + 授权 localhost
  const manifestPath = path.join(ROOT, 'manifest.json');
  const originalManifest = fs.readFileSync(manifestPath, 'utf-8');
  const manifestJson = JSON.parse(originalManifest);
  manifestJson.host_permissions = [
    ...manifestJson.host_permissions,
    'http://127.0.0.1/*',
    'http://localhost/*',
  ];
  fs.writeFileSync(manifestPath, JSON.stringify(manifestJson, null, 2));

  const contentPath = path.join(ROOT, 'content/content.js');
  const originalContent = fs.readFileSync(contentPath, 'utf-8');
  fs.writeFileSync(
    contentPath,
    originalContent.replace(/const API_URL = '[^']*'/, `const API_URL = '${workerUrl}'`)
  );

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yousum-shot-'));
  const LAUNCH_ARGS = [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-sandbox',
    '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests',
  ];

  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: LAUNCH_ARGS,
    });

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;

    // YouTube 页面（展示使用场景）
    const page = await context.newPage();
    await page.route('https://www.youtube.com/watch**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_YOUTUBE })
    );
    await page.route('https://www.youtube.com/api/timedtext**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          events: [
            { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'Welcome back to the channel' }] },
            { tStartMs: 3000, dDurationMs: 3000, segs: [{ utf8: 'Today we talk about learning programming' }] },
            { tStartMs: 6000, dDurationMs: 3000, segs: [{ utf8: 'And the conclusion of the talk' }] }
          ],
        }),
      })
    );
    await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT_DIR, '01-youtube-page.png') });
    console.log('saved 01-youtube-page.png');

    // popup —— 三种模式
    for (const [mode, file] of [
      ['brief', '02-popup-brief.png'],
      ['detailed', '03-popup-detailed.png'],
      ['timeline', '04-popup-timeline.png'],
    ]) {
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 380, height: 620 });
      await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
      await popup.waitForSelector('.app', { timeout: 10000 });
      await popup.waitForTimeout(500);

      await popup.locator(`.mode[data-mode="${mode}"]`).click();
      await popup.locator('.btn').click();
      await popup.waitForTimeout(1500);

      await popup.screenshot({ path: path.join(OUT_DIR, file) });
      console.log('saved', file);
      await popup.close();
    }

    await context.close();

    // 深色模式
    const ctx2 = await chromium.launchPersistentContext(
      fs.mkdtempSync(path.join(os.tmpdir(), 'yousum-dark-')),
      {
        channel: 'chromium',
        headless: true,
        viewport: { width: 380, height: 620 },
        colorScheme: 'dark',
        args: LAUNCH_ARGS,
      }
    );
    let [sw2] = ctx2.serviceWorkers();
    if (!sw2) sw2 = await ctx2.waitForEvent('serviceworker', { timeout: 15000 });
    const extId2 = new URL(sw2.url()).host;

    const darkPage = await ctx2.newPage();
    await darkPage.route('https://www.youtube.com/watch**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_YOUTUBE })
    );
    await darkPage.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      waitUntil: 'domcontentloaded',
    });
    await darkPage.waitForTimeout(1000);

    const darkPopup = await ctx2.newPage();
    await darkPopup.setViewportSize({ width: 380, height: 620 });
    await darkPopup.goto(`chrome-extension://${extId2}/popup/popup.html`);
    await darkPopup.waitForSelector('.app', { timeout: 10000 });
    await darkPopup.waitForTimeout(1200);
    await darkPopup.screenshot({ path: path.join(OUT_DIR, '05-popup-dark.png') });
    console.log('saved 05-popup-dark.png');
    await ctx2.close();
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.writeFileSync(manifestPath, originalManifest);
    fs.writeFileSync(contentPath, originalContent);
    workerServer.close();
  }

  console.log(`\n截图输出目录: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
