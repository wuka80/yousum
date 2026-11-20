# YouSum

**AI YouTube 视频摘要 Chrome 扩展** — 在观看页一键生成视频摘要，支持极简速览、要点总结、时间戳大纲三种模式。

---

## 功能

| 模式 | 说明 | 输出 |
|------|------|------|
| **Brief** | 100 字速览 | 单段连续文本，80–120 字 |
| **Detailed** | 完整要点 | 5–10 条要点列表 |
| **Timeline** | 时间戳大纲 | 6–15 条 `[mm:ss] 内容` |

- **双通道字幕提取**：优先从页面数据（`ytInitialPlayerResponse`）取字幕轨，失败时自动降级到 `timedtext` API。
- **零登录**：每天免费 10 次，不需要注册账号。
- **密钥零暴露**：DeepSeek API Key 只存在于 Cloudflare Worker，扩展端永远拿不到。
- **成本可控**：Worker 免费额度足够个人使用，月成本 < $5。

---

## 项目结构

```
yousum/
├── manifest.json              # Manifest V3 清单
├── background/
│   └── service-worker.js      # 后台服务：每日额度管理、图标点击
├── content/
│   ├── content.js             # 内容脚本：字幕提取 + 面板 UI + 请求 Worker
│   └── content.css            # 浮层面板样式
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── worker/                    # Cloudflare Worker（AI 代理层）
│   ├── src/index.js
│   ├── wrangler.toml
│   └── package.json
├── tools/
│   └── make_icons.py          # 图标生成脚本
├── README.md
├── DEPLOY.md                  # 部署指南
├── STORE_LISTING.md           # Chrome Web Store 上架文案
├── PRIVACY.md                 # 隐私政策
└── PROMOTION.md               # 推广文案
```

---

## 架构

```
┌─────────────────┐
│  YouTube 观看页  │
│                 │
│  content.js     │──① 提取字幕（页面数据 → timedtext 兜底）
│  （浮层面板）    │        │
└─────────────────┘        │ ② chrome.runtime.sendMessage
                           ▼
                ┌──────────────────────┐
                │ background           │──③ 扣每日额度
                │ service-worker.js    │
                │ （持有 Worker 地址）   │    API_URL 只在这里配置
                └──────────┬───────────┘
                           │ ④ POST /summarize {transcript, mode, title, videoId}
                           │    （只传文本给自家 Worker，不含任何密钥）
                           ▼
                ┌──────────────────────┐
                │ Cloudflare           │──⑤ 校验 + 速率限制 + 超时保护
                │ Worker 代理层         │    （持有 DEEPSEEK_API_KEY）
                └──────────┬───────────┘
                           │ ⑥ POST api.deepseek.com/chat/completions
                           ▼
                      ┌─────────┐
                      │ DeepSeek │──⑦ 返回摘要 → 回传面板
                      └─────────┘
```

**为什么需要 Worker？** 扩展包会被用户下载，任何写在前端代码里的 API Key 都能被扒出来。Worker 让密钥留在服务端，同时还能做限流和成本兜底。

**为什么请求放在 background 而不是内容脚本？** 内容脚本的 `fetch()` 受页面 CORS 约束，容易在真实环境失败。放到 background service worker 里，请求以扩展身份发出，由 `host_permissions` 授权，不受页面 CORS 干扰。

---

## 本地加载测试

1. 按 [DEPLOY.md](DEPLOY.md) 部署 Worker，拿到 Worker 地址。
2. 把地址填入 `background/service-worker.js` 顶部的 `API_URL`（**只有这一处**）。
3. 打开 `chrome://extensions/` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择本目录。
4. 打开任意 YouTube 视频页，右上角会出现红色 YouSum 按钮，点击展开面板。

> 也可以直接加载 `yousum-extension-test.zip`（纯扩展文件，无需解压）。

---

## 配置项

| 位置 | 常量 | 默认值 | 说明 |
|------|------|--------|------|
| `background/service-worker.js` | `API_URL` | 占位符 | **必须改**：Worker 地址 |
| `background/service-worker.js` | `FREE_QUOTA_PER_DAY` | `10` | 每日免费次数 |
| `content/content.js` | `MAX_TRANSCRIPT_CHARS` | `12000` | 送入模型的字幕最大字符数 |
| `worker/src/index.js` | `ALLOWED_ORIGINS` | YouTube 域名 | 静态来源白名单 |
| `worker/src/index.js` | `ALLOWED_EXTENSION_ID` | 未设置 | **建议设置**：锁定扩展 ID |
| `worker/src/index.js` | `REQUESTS_PER_MINUTE` | `12` | 单 IP 每分钟上限 |
| `worker/src/index.js` | `REQUESTS_PER_DAY` | `60` | 单 IP 每天上限 |
| `worker/src/index.js` | `DEEPSEEK_MODEL` | `deepseek-chat` | 使用的模型 |

---

## 测试

```bash
npm install               # 安装 playwright（仅 e2e 需要）

node tests/worker.test.mjs    # 44 项：参数校验、速率限制、Origin 白名单、prompt 构造、错误处理
node tests/content.test.mjs   # 22 项：字幕解析、时间戳格式化、边界情况
node tests/e2e.test.mjs       # 23 项：真实 Chromium 加载扩展，验证注入/UI/模式切换/额度
```

E2E 需要完整 Chromium（headless shell 不支持加载扩展）：

```bash
npx playwright install chromium
```

生成界面截图（可用于商店素材）：

```bash
node tests/screenshot.mjs    # 输出到 screenshots/
```

打包测试包：

```bash
python tools/build.py        # 生成 ../yousum-extension-test.zip
```


---

## 重新生成图标

```bash
pip install pillow
python tools/make_icons.py
```

---

## 常见问题

**Q: 提示「没有找到该视频的字幕」**
A: 部分视频没有字幕轨，或自动字幕还没生成。也可能是 YouTube 要求登录。试试手动带字幕的视频。

**Q: 报 429 / 请求过于频繁**
A: 触发了 Worker 速率限制，等一分钟再试。

**Q: 报「服务端未配置 DEEPSEEK_API_KEY」**
A: 没执行 `wrangler secret put DEEPSEEK_API_KEY`，或部署到了错误的 environment。

**Q: 手机上能用吗**
A: 不能。Chrome 扩展只在 PC 桌面版 Chrome 运行。

---

## 许可证

MIT
