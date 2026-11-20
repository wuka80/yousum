# 推广文案

首发用文案的备选库。原则：**先说用户获得了什么，别急着说技术**。

---

## Product Hunt

**名称**

```
YouSum - AI YouTube Video Summaries
```

**一句话**

```
Summarize any YouTube video in one click — brief, detailed, or timestamped.
```

**分类**

```
Productivity
```

**Tagline（60 字符内）**

```
Skip the video. Get the gist.
```

**详细介绍**

```
YouTube videos are long. Your time isn't.

YouSum turns any YouTube video into a summary you can actually read — three ways:

→ Brief — the whole video in 100 words
→ Detailed — the key points, pulled out and listed
→ Timeline — an outline with timestamps, so you can jump straight to the part you care about

WHY IT WORKS BETTER

Most summarizers transcribe audio and hope for the best. YouSum reads YouTube's own caption track instead. That's the difference between "probably right" and "actually right."

Two extraction paths run automatically — if the page data isn't available, it falls back to the timedtext API. Most videos with captions just work.

NO ACCOUNT, NO EMAIL, NO WAITING

10 free summaries a day. No sign-up. No dashboard. Click the button, read the answer.

PRIVACY YOU CAN VERIFY

The AI key lives on a server you control — it's not in the extension package. No browsing history. No tracking. No profiles. The only thing stored on your device is a counter of how many times you've clicked today.

OPEN SOURCE

MIT licensed. Read every line, run it yourself, or self-host the backend in about five minutes.

Chrome desktop only — extensions don't run on mobile.

↑ If it saves you time, an upvote genuinely helps an independent project get seen. And a review goes a long way.
```

---

## Reddit

### r/SideProject

**标题**

```
I built a Chrome extension that summarizes YouTube videos into 100-word briefs, key points, or timestamped outlines
```

**正文**

```
Hey r/SideProject — I just shipped YouSum, an open-source Chrome extension for summarizing YouTube videos.

It does three things:
- Brief: the whole video in ~100 words
- Detailed: 5-10 key points
- Timeline: an outline with [mm:ss] timestamps so you can jump to any moment

The technical bit I'm most happy with: it reads YouTube's native caption track rather than doing ASR. So accuracy is a lot better than you'd get from transcribing audio. There are two extraction paths (page data first, timedtext API as fallback) since YouTube's internals shift around.

Privacy model: the DeepSeek key lives in a Cloudflare Worker, not in the extension bundle. Nothing is tracked. The only local storage is "how many times did you click today."

10 free summaries/day, no account required.

GitHub: [link]
Chrome Web Store: [link]

Would love feedback on the output formats — especially if you have a use case where one of the three modes doesn't fit what you need.
```

### r/ChromeExtensions

**标题**

```
YouSum — open source YouTube summarizer (no account, key not in the bundle)
```

**正文**

```
Built a Manifest V3 extension that summarizes YouTube videos on the watch page.

Three modes: Brief (100 words), Detailed (key points), Timeline (timestamped outline).

Two design decisions worth mentioning:

1. Captions over ASR — it pulls YouTube's own caption track, so it isn't guessing at what's being said. Dual extraction path (page data + timedtext fallback) keeps it working across YouTube's internal changes.

2. The API key isn't in the extension. It lives in a Cloudflare Worker you deploy yourself, which also handles rate limiting. Nobody can scrape your key out of the bundle because it's not there.

Rate limiting is per-IP on the Worker side, so if you self-host you can adjust the limits to fit your own budget.

MIT licensed, ~1000 lines of vanilla JS + a Worker. No build step.

Repo: [link]
```

### r/selfhosted

**标题**

```
Self-hosted YouTube summarizer: Chrome extension + your own Cloudflare Worker + DeepSeek
```

**正文**

```
If you'd rather not send your watch history to someone else's summarizer service:

YouSum is an open-source Chrome extension plus a ~300-line Cloudflare Worker. You deploy the Worker, put your own DeepSeek key in it as a secret, and point the extension at your URL.

- Extension: vanilla JS, no build step, MIT
- Worker: rate limiting, request timeout, input validation
- Key: wrangler secret, never in the repo or the extension bundle

Setup is about five minutes: wrangler deploy, wrangler secret put DEEPSEEK_API_KEY, paste your URL into two constants in the extension.

Repo: [link]
```

---

## 一句话推广语备选

- "Skip the video. Get the gist."
- "100 words instead of 40 minutes."
- "Your tabs are open. Your time is finite."
- "Timestamped summaries, not 40-minute commitments."
- "Read the video before you watch the video."

---

## 首发节奏建议

| 时间 | 动作 | 渠道 |
|------|------|------|
| D-1 | 写好产品页 + 隐私政策上线（GitHub Pages） | GitHub |
| D0 上午 | Product Hunt 提交 | Product Hunt |
| D0 中午 | r/SideProject + r/ChromeExtensions | Reddit |
| D0 晚上 | Show HN | Hacker News |
| D0 晚上 | 社交媒体发截图对比图 | Twitter / X / 即刻 |
| D+1 | 回应所有评论，收集反馈 | 全部 |
| D+3 | 按反馈更新，发布 v0.1.1 | GitHub Releases |

**HN 注意**：Show HN 的评论区会挑刺，常见攻击点是"AI 摘要就是幻觉"和"凭什么信任你"。
提前准备回答：
- 幻觉 → "读的是官方字幕不是 ASR，模型被明确要求只用字幕里的信息"
- 信任 → "API key 在你自己的 Worker 里，源码全开，不信任我就不用"

---

## 截图建议

对比图最有说服力：

```
左：YouTube 视频 + 进度条 47:23
右：YouSum 面板 → Brief 输出 98 字
```

三张一组：
1. Brief 输出
2. Detailed 要点列表
3. Timeline 时间轴

---

## 变现转化文案（Pro 上线后）

```
YouSum Pro — $5/month

Unlimited summaries
Priority queue (no rate limit)
Custom summary length & style
Save & organize summaries
API access for your own scripts

Free tier stays at 10/day. Forever.
```

> 付费点建议只放在「无限次」和「自定义」上，隐私这类卖点做不到付费，别浪费笔墨。
