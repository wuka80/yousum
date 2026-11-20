/**
 * 安全审计测试
 *
 * 对照交接文档「已修复15个问题」清单，逐项静态检查代码。
 * 这些检查能防止后续改动不小心把修复回退掉。
 *
 * 运行：node tests/security.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const manifest = JSON.parse(read('manifest.json'));
const contentJs = read('content/content.js');
const popupJs = read('popup/popup.js');
const popupHtml = read('popup/popup.html');
const bgJs = read('background/service-worker.js');
const workerJs = read('worker/src/index.js');

/** 去掉注释后再检查，避免注释里的说明文字造成误判 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const contentCode = stripComments(contentJs);
const popupCode = stripComments(popupJs);
const bgCode = stripComments(bgJs);
const workerCode = stripComments(workerJs);

// ---------------------------------------------------------------------------
section('XSS 防护 / 安全 DOM API');
// ---------------------------------------------------------------------------
{
  check('content.js 无 innerHTML', !contentCode.includes('innerHTML'));
  check('content.js 无 outerHTML', !contentCode.includes('outerHTML'));
  check('content.js 无 insertAdjacentHTML', !contentCode.includes('insertAdjacentHTML'));
  check('content.js 无 document.write', !contentCode.includes('document.write'));
  check('content.js 使用 createElement', contentCode.includes('document.createElement'));
  check('content.js 使用 textContent', contentCode.includes('textContent'));

  check('popup.js 无 innerHTML', !popupCode.includes('innerHTML'));
  check('popup.js 无 insertAdjacentHTML', !popupCode.includes('insertAdjacentHTML'));
  check('popup.js 使用 createElement', popupCode.includes('document.createElement'));
  check('popup.js 使用 textContent', popupCode.includes('textContent'));

  check('popup.html 无内联 <script>', !/<script(?![^>]*\bsrc=)/i.test(popupHtml));
  check('popup.html 无内联 onclick 等事件属性', !/\son[a-z]+\s*=/i.test(popupHtml));
}

// ---------------------------------------------------------------------------
section('危险 API 全面排查');
// ---------------------------------------------------------------------------
{
  const files = {
    'content/content.js': contentCode,
    'popup/popup.js': popupCode,
    'background/service-worker.js': bgCode,
    'worker/src/index.js': workerCode,
  };
  for (const [name, code] of Object.entries(files)) {
    check(`${name} 无 eval()`, !/\beval\s*\(/.test(code));
    check(`${name} 无 new Function`, !/new\s+Function\s*\(/.test(code));
    check(`${name} 无 setTimeout 字符串形式`, !/setTimeout\s*\(\s*['"`]/.test(code));
  }
}

// ---------------------------------------------------------------------------
section('URL 注入防护');
// ---------------------------------------------------------------------------
{
  check('存在 videoId 白名单校验', /function isValidVideoId/.test(contentCode));
  check('videoId 正则限定 11 位安全字符', /\[A-Za-z0-9_\-\]\{11\}/.test(contentCode));
  check('存在字幕 URL 主机白名单', /function isAllowedCaptionUrl/.test(contentCode));
  check('字幕 URL 强制 https', /protocol !== 'https:'/.test(contentCode));
  check('videoId 拼接进 URL 时做了 encodeURIComponent', contentCode.includes('encodeURIComponent'));
  check('Worker 侧也校验 videoId 格式', /\[A-Za-z0-9_\-\]\{11\}/.test(workerCode));
}

// ---------------------------------------------------------------------------
section('MV3 合规');
// ---------------------------------------------------------------------------
{
  check('manifest_version = 3', manifest.manifest_version === 3);
  check('已移除 activeTab 权限', !manifest.permissions.includes('activeTab'));
  check('已移除 scripting 权限', !manifest.permissions.includes('scripting'));
  check('已移除 tabs 权限', !manifest.permissions.includes('tabs'));
  check(
    '权限最小化（仅 storage + alarms）',
    JSON.stringify(manifest.permissions) === '["storage","alarms"]',
    JSON.stringify(manifest.permissions)
  );
  check('声明了 CSP', !!manifest.content_security_policy?.extension_pages);
  check('CSP 含 script-src self', /script-src 'self'/.test(manifest.content_security_policy.extension_pages));
  check('CSP 含 object-src self', /object-src 'self'/.test(manifest.content_security_policy.extension_pages));
  check('声明了 web_accessible_resources', Array.isArray(manifest.web_accessible_resources));
  check('background 用 type: module', manifest.background.type === 'module');
  check('无 remote code（无 externally_connectable）', !manifest.externally_connectable);
  check('无 Chrome App 废弃字段', !manifest.app && !manifest.manifest_version2);
}

// ---------------------------------------------------------------------------
section('Service Worker 用 alarms 替代 setInterval');
// ---------------------------------------------------------------------------
{
  check('background 使用 chrome.alarms', bgCode.includes('chrome.alarms'));
  check('background 监听 onAlarm', bgCode.includes('chrome.alarms.onAlarm'));
  check('background 无 setInterval', !/setInterval\s*\(/.test(bgCode));
  check('background 无 setTimeout 定时轮询', !/setTimeout\s*\(\s*function|setTimeout\s*\(\s*\(\)\s*=>/.test(bgCode));
}

// ---------------------------------------------------------------------------
section('Worker 超时保护与密钥隔离');
// ---------------------------------------------------------------------------
{
  check('Worker 使用 AbortController', workerCode.includes('AbortController'));
  check('Worker 有超时常量', /UPSTREAM_TIMEOUT_MS\s*=\s*\d+/.test(workerCode));
  check('超时触发 abort()', /controller\.abort\(\)/.test(workerCode));
  check('Worker 用 secret 读 key（env.DEEPSEEK_API_KEY）', workerCode.includes('env.DEEPSEEK_API_KEY'));
  check('代码里没有硬编码 api key', !/sk-[a-zA-Z0-9]{16,}/.test(workerCode));
  check('扩展端代码不含 api key', !/sk-[a-zA-Z0-9]{16,}/.test(contentCode + popupCode + bgCode));
  check('扩展端不直连 DeepSeek', !contentCode.includes('api.deepseek.com') && !popupCode.includes('api.deepseek.com'));
}

// ---------------------------------------------------------------------------
section('速率限制与输入校验');
// ---------------------------------------------------------------------------
{
  check('Worker 有每分钟限流', /REQUESTS_PER_MINUTE/.test(workerCode));
  check('Worker 有每日限流', /REQUESTS_PER_DAY/.test(workerCode));
  check('Worker 限制请求体大小', /MAX_BODY_BYTES/.test(workerCode));
  check('Worker 限制 transcript 长度', /MAX_TRANSCRIPT_CHARS/.test(workerCode));
  check('Worker 校验 mode 白名单', /hasOwnProperty\.call\(MODE_PROMPTS/.test(workerCode));
  check('Worker 有 CORS 白名单', /isOriginAllowed/.test(workerCode));
}

// ---------------------------------------------------------------------------
section('本地存储与隐私');
// ---------------------------------------------------------------------------
{
  check('额度存 chrome.storage.local', bgCode.includes('chrome.storage.local'));
  check('额度按本地时区日期计算', /getFullYear\(\)/.test(bgCode));
  check('不收集浏览历史（无 history 权限）', !manifest.permissions.includes('history'));
  check(
    'host_permissions 含 YouTube',
    manifest.host_permissions.some((h) => h.includes('youtube.com')),
    JSON.stringify(manifest.host_permissions)
  );
  check(
    'host_permissions 含 Worker 域名（content script 跨域请求必需）',
    manifest.host_permissions.some((h) => h.includes('workers.dev')),
    JSON.stringify(manifest.host_permissions)
  );
  check(
    'host_permissions 无第三方追踪域名',
    manifest.host_permissions.every((h) => /youtube\.com|workers\.dev/.test(h)),
    JSON.stringify(manifest.host_permissions)
  );
}

// ---------------------------------------------------------------------------
section('输出语言策略（多语言字幕 → 英文摘要）');
// ---------------------------------------------------------------------------
{
  check('system prompt 要求英文输出', /Write the summary in English/i.test(workerCode));
  check('system prompt 禁止外部知识', /ONLY information that appears in the captions/i.test(workerCode));
  check('system prompt 禁止 Markdown 标题', /Do not use Markdown headings/i.test(workerCode));
}

// ---------------------------------------------------------------------------
section('资源引用完整性');
// ---------------------------------------------------------------------------
{
  for (const p of ['manifest.json', 'popup/popup.html', 'popup/popup.js', 'popup/popup.css', 'content/content.js', 'background/service-worker.js', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png', 'worker/src/index.js']) {
    check(`${p} 存在`, fs.existsSync(path.join(ROOT, p)));
  }
  check('manifest 引用的图标文件都存在', Object.values(manifest.icons).every((f) => fs.existsSync(path.join(ROOT, f))));
  check('popup.html 引用 popup.js', popupHtml.includes('popup.js'));
  check('popup.html 引用 popup.css', popupHtml.includes('popup.css'));
  check('已移除不再使用的 content.css', !fs.existsSync(path.join(ROOT, 'content/content.css')));
  check('manifest 不再引用 content.css', !JSON.stringify(manifest).includes('content.css'));
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(46));
process.exit(failed > 0 ? 1 : 0);
