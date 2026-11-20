/**
 * 截图脚本：渲染扩展浮层面板并存为 PNG
 * 用于人工检查视觉效果。
 *
 * 运行：node tests/screenshot.mjs
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT_DIR = path.join(ROOT, 'screenshots');

const MOCK_YOUTUBE = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>如何学习编程 - YouTube</title>
  <meta name="title" content="如何学习编程：从零到一的完整指南">
  <style>
    body { margin:0; font-family: Arial, sans-serif; background:#0f0f0f; color:#f1f1f1; }
    .yt-header { display:flex; align-items:center; gap:20px; padding:12px 20px; background:#000; }
    .yt-logo { font-weight:bold; font-size:20px; color:#ff0000; }
    .yt-search { flex:1; max-width:420px; height:32px; background:#222; border-radius:16px; }
    .yt-body { display:flex; padding:20px; gap:20px; }
    .yt-player { width:640px; height:360px; background:#000; border-radius:12px; display:flex;
                 align-items:center; justify-content:center; color:#555; font-size:13px; }
    .yt-info h1 { font-size:20px; margin:0 0 12px; }
    .yt-info p { color:#aaa; font-size:13px; }
  </style>
</head>
<body>
  <div class="yt-header">
    <span class="yt-logo">▶ YouTube</span>
    <div class="yt-search"></div>
  </div>
  <div class="yt-body">
    <div class="yt-player">视频播放器</div>
    <div class="yt-info">
      <h1 class="ytd-watch-metadata"><yt-formatted-string>如何学习编程：从零到一的完整指南</yt-formatted-string></h1>
      <p>128 万次观看 · 3 天前</p>
    </div>
  </div>
  <div id="movie_player"></div>
  <script>
    window.ytInitialPlayerResponse = {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: 'https://www.youtube.com/api/timedtext?mock=1',
        name: { simpleText: 'Chinese' }, languageCode: 'zh-Hans', kind: 'asr'
      }] } }
    };
  </script>
</body>
</html>`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yousum-shot-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-sandbox',
    ],
  });

  const page = await context.newPage();
  await page.route('https://www.youtube.com/watch**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_YOUTUBE })
  );
  await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#yousum-panel-root', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // 截整页
  await page.screenshot({ path: path.join(OUT_DIR, 'panel-full.png') });
  console.log('saved panel-full.png');

  // 只截浮层面板
  const panel = page.locator('.yousum-panel');
  await panel.screenshot({ path: path.join(OUT_DIR, 'panel.png') });
  console.log('saved panel.png');

  // 切到 Detailed 模式再截一张
  await page.locator('.yousum-mode[data-mode="detailed"]').click();
  await page.waitForTimeout(300);
  await panel.screenshot({ path: path.join(OUT_DIR, 'panel-detailed.png') });
  console.log('saved panel-detailed.png');

  // Timeline 模式
  await page.locator('.yousum-mode[data-mode="timeline"]').click();
  await page.waitForTimeout(300);
  await panel.screenshot({ path: path.join(OUT_DIR, 'panel-timeline.png') });
  console.log('saved panel-timeline.png');

  await context.close();

  // 深色模式截图
  const ctx2 = await chromium.launchPersistentContext(
    fs.mkdtempSync(path.join(os.tmpdir(), 'yousum-dark-')),
    {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 800 },
      colorScheme: 'dark',
      args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-sandbox'],
    }
  );
  const darkPage = await ctx2.newPage();
  await darkPage.route('https://www.youtube.com/watch**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_YOUTUBE })
  );
  await darkPage.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
  await darkPage.waitForSelector('#yousum-panel-root', { timeout: 10000 });
  await darkPage.waitForTimeout(1500);
  await darkPage.locator('.yousum-panel').screenshot({ path: path.join(OUT_DIR, 'panel-dark.png') });
  console.log('saved panel-dark.png');
  await ctx2.close();

  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log(`\n截图输出目录: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
