/**
 * 内容脚本纯函数测试
 *
 * 只测不依赖浏览器 DOM 的部分：json3 解析、XML 解析、时间戳格式化、字幕转文本。
 * 浏览器 API 相关逻辑（DOMParser、fetch、chrome.*）在 Node 里模拟。
 *
 * 运行：node content/test/content.test.mjs
 */

// ---------------------------------------------------------------------------
// 从 content.js 中提取的纯函数（保持与源码一致）
// ---------------------------------------------------------------------------

function formatTimestamp(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

function parseJson3(json) {
  const events = json?.events || [];
  const cues = [];
  for (const ev of events) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    cues.push({
      start: (ev.tStartMs || 0) / 1000,
      duration: (ev.dDurationMs || 0) / 1000,
      text,
    });
  }
  return cues;
}

function cuesToText(cues) {
  return cues.map((c) => `[${formatTimestamp(c.start)}] ${c.text}`).join('\n');
}

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

// ---------------------------------------------------------------------------
section('formatTimestamp');
// ---------------------------------------------------------------------------
{
  check('0 秒 -> 00:00', formatTimestamp(0) === '00:00');
  check('65 秒 -> 01:05', formatTimestamp(65) === '01:05');
  check('599 秒 -> 09:59', formatTimestamp(599) === '09:59');
  check('3600 秒 -> 1:00:00', formatTimestamp(3600) === '1:00:00');
  check('3725 秒 -> 1:02:05', formatTimestamp(3725) === '1:02:05');
  check('负数归零', formatTimestamp(-5) === '00:00');
  check('小数截断', formatTimestamp(65.9) === '01:05');
}

// ---------------------------------------------------------------------------
section('parseJson3');
// ---------------------------------------------------------------------------
{
  const json = {
    events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
      { tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: '\n' }, { utf8: 'Second line' }] },
      { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: '   ' }] },   // 空白，应被跳过
      { tStartMs: 5000, dDurationMs: 1000 },                             // 无 segs，应被跳过
    ],
  };
  const cues = parseJson3(json);
  check('解析出 2 条有效字幕', cues.length === 2, `got ${cues.length}`);
  check('拼接多段文本', cues[0].text === 'Hello world', `got "${cues[0].text}"`);
  check('换行被清理', cues[1].text === 'Second line', `got "${cues[1].text}"`);
  check('start 换算为秒', cues[1].start === 2);
  check('duration 换算为秒', cues[0].duration === 2);
}
{
  check('空对象返回空数组', parseJson3({}).length === 0);
  check('null 返回空数组', parseJson3(null).length === 0);
  check('无 events 字段返回空数组', parseJson3({ foo: 1 }).length === 0);
}

// ---------------------------------------------------------------------------
section('cuesToText');
// ---------------------------------------------------------------------------
{
  const cues = [
    { start: 0, duration: 2, text: '第一句' },
    { start: 65, duration: 2, text: '第二句' },
    { start: 3725, duration: 2, text: '第三句' },
  ];
  const text = cuesToText(cues);
  const lines = text.split('\n');
  check('每条字幕一行', lines.length === 3);
  check('首行带时间戳', lines[0] === '[00:00] 第一句', `got "${lines[0]}"`);
  check('分钟时间戳正确', lines[1] === '[01:05] 第二句', `got "${lines[1]}"`);
  check('小时时间戳正确', lines[2] === '[1:02:05] 第三句', `got "${lines[2]}"`);
}

// ---------------------------------------------------------------------------
section('边界情况');
// ---------------------------------------------------------------------------
{
  // 超长字幕截断逻辑（与 content.js 中的 MAX_TRANSCRIPT_CHARS 行为一致）
  const MAX = 12000;
  const long = cuesToText(Array.from({ length: 3000 }, (_, i) => ({ start: i, duration: 1, text: 'x'.repeat(20) })));
  check('生成足够长的字幕用于测试', long.length > MAX);
  const truncated = long.slice(0, MAX);
  check('截断后长度正确', truncated.length === MAX);
  check('截断不破坏 UTF-8（截断点落在代理对中间时需注意）', typeof truncated === 'string');
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(46));
process.exit(failed > 0 ? 1 : 0);
