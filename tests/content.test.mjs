/**
 * 内容脚本纯函数测试
 *
 * 覆盖字幕解析、时间戳格式化、文本清理、URL 注入防护等关键逻辑。
 * 从 content/content.js 中提取同源实现，保证与线上代码一致。
 *
 * 运行：node tests/content.test.mjs
 */

// ---------------------------------------------------------------------------
// 与 content/content.js 一致的实现
// ---------------------------------------------------------------------------

const MAX_CUE_CHARS = 500;
const MAX_CUES = 2000;
const ALLOWED_CAPTION_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];

function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/[\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function clamp(text, max) {
  if (typeof text !== 'string') return '';
  return text.length > max ? text.slice(0, max) : text;
}

function isValidVideoId(videoId) {
  return typeof videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(videoId);
}

function isAllowedCaptionUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_CAPTION_HOSTS.includes(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function formatTimestamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

function parseJson3(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const cues = [];
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.segs)) continue;
    const raw = ev.segs.map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : '')).join('');
    const text = sanitizeText(raw);
    if (!text) continue;
    cues.push({
      start: (Number(ev.tStartMs) || 0) / 1000,
      duration: (Number(ev.dDurationMs) || 0) / 1000,
      text: clamp(text, MAX_CUE_CHARS),
    });
    if (cues.length >= MAX_CUES) break;
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
  check('非数字归零', formatTimestamp('abc') === '00:00');
  check('undefined 归零', formatTimestamp(undefined) === '00:00');
}

// ---------------------------------------------------------------------------
section('parseJson3');
// ---------------------------------------------------------------------------
{
  const json = {
    events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
      { tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: '\n' }, { utf8: 'Second line' }] },
      { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: '   ' }] },
      { tStartMs: 5000, dDurationMs: 1000 },
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
  check('events 非数组返回空数组', parseJson3({ events: 'oops' }).length === 0);
  check('seg 非字符串被忽略', parseJson3({ events: [{ segs: [{ utf8: 123 }] }] }).length === 0);
}
{
  const long = parseJson3({ events: [{ tStartMs: 0, segs: [{ utf8: 'x'.repeat(999) }] }] });
  check('单条字幕被截断到 500 字符', long[0].text.length === MAX_CUE_CHARS, `got ${long[0].text.length}`);
}
{
  const many = parseJson3({
    events: Array.from({ length: 2500 }, (_, i) => ({ tStartMs: i * 100, segs: [{ utf8: `line ${i}` }] })),
  });
  check('字幕条数被限制在 2000', many.length === MAX_CUES, `got ${many.length}`);
}

// ---------------------------------------------------------------------------
section('sanitizeText（控制字符防护）');
// ---------------------------------------------------------------------------
{
  check('HTML 标签原样保留为纯文本', sanitizeText('<b>bold</b>') === '<b>bold</b>');
  check('移除零宽字符', sanitizeText('a\u200Bb') === 'ab');
  check('移除 BOM', sanitizeText('\uFEFFabc') === 'abc');
  check('移除控制字符', sanitizeText('a\u0000b\u001Fc') === 'abc');
  check('保留正常 Unicode（中文/emoji）', sanitizeText('你好 🎉') === '你好 🎉');
  check('压缩多余空白', sanitizeText('a   b \n c') === 'a b c');
  check('非字符串返回空串', sanitizeText(null) === '');
  check('去首尾空白', sanitizeText('  hi  ') === 'hi');
}

// ---------------------------------------------------------------------------
section('isValidVideoId（URL 注入防护）');
// ---------------------------------------------------------------------------
{
  check('合法 11 位 id 通过', isValidVideoId('dQw4w9WgXcQ') === true);
  check('含下划线通过', isValidVideoId('abc_def-gh1') === true);
  check('长度不足拒绝', isValidVideoId('short') === false);
  check('长度超长拒绝', isValidVideoId('a'.repeat(12)) === false);
  check('含斜杠拒绝', isValidVideoId('abc/def1234') === false);
  check('含空格拒绝', isValidVideoId('abc def123') === false);
  check('含引号拒绝', isValidVideoId(`abc'def1234`) === false);
  check('非字符串拒绝', isValidVideoId(null) === false);
  check('数字类型拒绝', isValidVideoId(12345678901) === false);
}

// ---------------------------------------------------------------------------
section('isAllowedCaptionUrl（URL 注入防护）');
// ---------------------------------------------------------------------------
{
  check('允许 youtube.com', isAllowedCaptionUrl('https://www.youtube.com/api/timedtext?v=x') === true);
  check('允许 m.youtube.com', isAllowedCaptionUrl('https://m.youtube.com/api/timedtext') === true);
  check('拒绝 http', isAllowedCaptionUrl('http://www.youtube.com/api/timedtext') === false);
  check('拒绝非 YouTube 主机', isAllowedCaptionUrl('https://evil.com/steal') === false);
  check('拒绝伪造后缀域名', isAllowedCaptionUrl('https://youtube.com.evil.com/x') === false);
  check('拒绝前缀伪造', isAllowedCaptionUrl('https://evilyoutube.com/x') === false);
  check('拒绝 javascript: 协议', isAllowedCaptionUrl('javascript:alert(1)') === false);
  check('拒绝 data: 协议', isAllowedCaptionUrl('data:text/html,<script>') === false);
  check('拒绝非法 URL', isAllowedCaptionUrl('not a url') === false);
  check('拒绝空串', isAllowedCaptionUrl('') === false);
  check('拒绝 file: 协议', isAllowedCaptionUrl('file:///etc/passwd') === false);
}

// ---------------------------------------------------------------------------
section('cuesToText');
// ---------------------------------------------------------------------------
{
  const cues = [
    { start: 0, duration: 2, text: 'first' },
    { start: 65, duration: 2, text: 'second' },
    { start: 3725, duration: 2, text: 'third' },
  ];
  const text = cuesToText(cues);
  const lines = text.split('\n');
  check('每条字幕一行', lines.length === 3);
  check('首行带时间戳', lines[0] === '[00:00] first', `got "${lines[0]}"`);
  check('分钟时间戳正确', lines[1] === '[01:05] second', `got "${lines[1]}"`);
  check('小时时间戳正确', lines[2] === '[1:02:05] third', `got "${lines[2]}"`);
  check('空数组返回空串', cuesToText([]) === '');
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(46));
process.exit(failed > 0 ? 1 : 0);
