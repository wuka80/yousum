# 部署指南

从零到上架的完整流程。全程约 30–60 分钟（审核等待另计 1–3 天）。

---

## 第 1 步：注册 DeepSeek 并获取 API Key

1. 打开 https://platform.deepseek.com 注册（国内手机号即可）。
2. 登录后进入「API keys」页面，创建一个新的 key，**复制保存**（只显示一次）。
3. 进入「充值」页面，充值 **¥10** 起步。DeepSeek 按 token 计费，个人使用 ¥10 可以跑很久。

> 定价参考（2026 年）：`deepseek-chat` 输入约 ¥1/百万 tokens，输出约 ¥2/百万 tokens。一次摘要调用（12000 字符字幕 ≈ 4000 tokens 输入 + 300 tokens 输出）约 ¥0.005。**10 次/天 ≈ ¥0.05/天**。

---

## 第 2 步：部署 Cloudflare Worker

需要 Cloudflare 账号（免费版即可）。

```bash
cd worker
npm install
wrangler login          # 浏览器授权，一次性
```

### 2.1 设置 API Key（secret）

```bash
wrangler secret put DEEPSEEK_API_KEY
# 粘贴第 1 步复制的 key，回车确认
```

> `wrangler secret` 存的是加密后的环境变量，代码里看不到明文。不要把它写进任何文件。

### 2.2 部署

```bash
wrangler deploy
```

输出会包含你的 Worker 地址：

```
Published yousum-proxy (2.34 sec)
  https://yousum-proxy.YOUR-SUBDOMAIN.workers.dev
```

**记下这个地址。**

### 2.3 验证

```bash
curl https://yousum-proxy.YOUR-SUBDOMAIN.workers.dev/health
# 期望：{"ok":true,"service":"yousum-proxy"}
```

---

## 第 3 步：把 Worker 地址填进扩展

**只需改一处**（网络请求由 content script 发出，API_URL 约在 340 行处）：

| 文件 | 位置 |
|------|------|
| `content/content.js` | `const API_URL = ...`（约 340 行） |

```js
const API_URL = 'https://yousum-proxy.YOUR-SUBDOMAIN.workers.dev';
```

> **重要**：还要确认 `manifest.json` 的 `host_permissions` 里包含你的 Worker 域名。
> content script 的 `fetch()` 以**页面来源**（`https://www.youtube.com`）发起，
> Chrome 会用扩展的 host_permissions 判断是否放行 —— 没有对应域名会被直接拦截，
> 表现为 `Failed to fetch`。
>
> 默认已包含 `https://*.workers.dev/*`。如果你用自己的域名，需要手动加一条。

---

## 第 4 步：锁定扩展 ID（可选）

Worker 默认放行任意 `chrome-extension://` 来源。这不是真正的安全边界（Origin 头可被伪造），
但锁定后能挡住其他扩展的误用。

> 注意：主流程请求由 content script 发出，Origin 是 YouTube 页面来源；
> 这个开关主要防的是「其他扩展直接调用你的 Worker 刷额度」。

**上架拿到正式扩展 ID 后**，执行：

```bash
cd worker
wrangler secret put ALLOWED_EXTENSION_ID
# 粘贴你的扩展 ID（32 位小写字母），如 abcdefghijklmnopqrstuvwxyzabcdef
```

扩展 ID 在 `chrome://extensions/` 的扩展卡片上能看到。

锁定后只有这个扩展能调用 Worker，其他扩展 origin 一律 403。

> 调试期（未上架）扩展 ID 每次加载可能变化，此时先不锁定，等上架后再锁。

---

## 第 5 步：本地测试

1. 打开 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `yousum/` 目录
4. 打开任意 YouTube 视频页，点右上角红色按钮 → 「生成摘要」

**测试用例建议**：

| 场景 | 视频类型 | 预期 |
|------|---------|------|
| 中文字幕 | 中文 vlog | Brief 输出中文、约 100 字 |
| 英文字幕 | English talk | Brief 输出英文 |
| 无字幕 | 纯音乐 MV | 提示「没有找到该视频的字幕」 |
| 模式切换 | 同一视频点三次 | 三种输出格式明显不同 |

---

## 第 6 步：推送到 GitHub

```bash
cd yousum
git init
git add .
git commit -m "feat: YouSum v0.1.0 - Chrome 扩展 MVP"
git branch -M main
git remote add origin https://github.com/wuka80/yousum.git
git push -u origin main
```

> 仓库地址来自项目规划，若换了用户名请同步改 `remote`。

推送前建议确认 `.gitignore` 已排除敏感文件（`worker/.dev.vars` 存放本地密钥，**绝不能提交**）。

---

## 第 7 步：打包提交 Chrome Web Store

### 7.1 打包

用打包脚本（推荐，会自动排除测试与文档并校验 manifest）：

```bash
cd yousum
python tools/build.py
```

打包内容：`manifest.json` / `background/` / `content/` / `popup/` / `web/` / `icons/`。
`web/caption-bridge.js` **必须包含在内** —— 它是字幕提取的桥接脚本，缺了扩展就抓不到字幕。

打包后**必须验证**：`chrome://extensions/` → 加载已解压 → 但这次选 zip 解压后的目录，确认功能一致。

### 7.2 提交审核

1. 打开 https://chrome.google.com/webstore/devconsole
2. 注册开发者账号，**一次性注册费 $5**（信用卡支付）
3. 「添加新商品」→ 上传 `yousum-extension-test.zip`
4. 填写商店信息（文案见 [STORE_LISTING.md](STORE_LISTING.md)）
5. 隐私实践：复制 [PRIVACY.md](PRIVACY.md) 的内容并填入对应网址
6. 提交审核

**审核周期**：通常 1–3 个工作日。

### 7.3 常见驳回原因与对策

| 驳回原因 | 对策 |
|---------|------|
| 权限申请过宽 | `host_permissions` 只保留 `*.youtube.com/*`，已在 manifest 中限制 |
| 隐私政策缺失 | 必须提供可公开访问的隐私政策 URL |
| 功能描述不清 | 商店描述里明确说明"从视频字幕生成摘要" |
| 远程代码 | Chrome MV3 禁止远程代码，本项目所有代码均打包在 zip 内 |

---

## 第 8 步：推广

文案见 [PROMOTION.md](PROMOTION.md)。首发渠道：

- Reddit `r/SideProject`、`r/ChromeExtensions`、`r/selfhosted`
- Product Hunt
- Hacker News Show HN（准备好被评论区挑刺，建议先发到 r/SideProject 预热）

---

## 成本与运维

| 项目 | 费用 |
|------|------|
| DeepSeek API | 约 ¥1–5/月（按 10 次/天估） |
| Cloudflare Workers | 免费额度内为 $0 |
| Chrome Web Store | $5 一次性 |
| **合计** | **< $5/月** |

Worker 免费额度：100,000 请求/天，对个人项目绰绰有余。

---

## 回滚与排错

**Worker 部署了坏版本？**

```bash
cd worker
wrangler deployments list      # 查看历史版本
wrangler rollback <version-id> # 回滚
```

**查看线上报错：**

```bash
cd worker
wrangler tail                  # 实时日志
```

**彻底重新部署：**

```bash
cd worker
wrangler delete                # 删除 Worker
wrangler deploy                # 重新部署（secret 需重新设置）
```
