# Context Reader

个人自用的英语电子书阅读 PWA，主要在 iPhone 上使用。React + TypeScript + epub.js，数据存在本机 IndexedDB，并通过自己的服务端在多台设备之间云同步。

- 导入无加密 EPUB / TXT（可一次多选），目录跳转、跨章连续滚动、字号、浅色/护眼/深色、自动记住阅读位置
- 文件名形如 `01 - 书名.epub` 的书自动归成一个系列，按序号排列，并提示接下来该读哪一本
- 长按选中单词或句子 → 底部弹窗：翻译、AI 讲解（句意 / 关键短语 / 语法，译文默认隐藏）、英文朗读、收藏
- 查过的词会在正文里标出来（所有书通用），点一下就能回看释义；每本书有生词本，读进下一章时提示回顾上一章的生词
- 收藏按书和章节分组；翻卡复习只有「认识 / 不认识」，标为认识的词不再标记
- 听读：从屏幕上第一句开始连续朗读，当前句高亮并自动跟随，可暂停、前后跳句、调语速
- 已导入的书可离线阅读；翻译和讲解结果会存在本地，离线也能再看
- 云同步：书籍、进度、收藏、生词、AI 结果自动同步到自己的服务端（Cloudflare 上用 D1 + R2），其他设备填同一个口令即可接着读；其他设备导入的书第一次打开时自动下载
- 学习记录（进度、收藏、AI 结果）也可以手动导出为 JSON，并在新设备上恢复

## 启动

需要 Node 20 以上。

```bash
npm install
```

把 `.env.example` 复制为 `.env`，填写四项：

| 变量 | 说明 |
| --- | --- |
| `ACCESS_TOKEN` | 个人访问口令，自己定一串长随机字符 |
| `AI_BASE_URL` | 模型服务地址，OpenAI 兼容格式，写到 `/v1` 这一层 |
| `AI_MODEL` | 模型名称 |
| `AI_API_KEY` | 模型服务的 API Key |

开发（前端和 `/api` 接口在同一个进程里）：

```bash
npm run dev
```

电脑上打开 `http://localhost:5173`。然后在 App 的「设置」里填入同一个访问口令，点「测试连接」。

不配置 `.env` 也能用，只是翻译和 AI 讲解不可用，阅读、朗读、收藏都不受影响。

### 用 iPhone 在局域网里调试

`npm run dev` 会打印一个 `Network` 地址（如 `http://192.168.1.5:5173`），手机和电脑在同一 Wi-Fi 下，用 Safari 打开即可测试导入、选词、弹窗和位置恢复。

局域网是 http，**没有 service worker**，所以这种方式测不了离线和「添加到主屏幕」后的完整体验，那部分需要部署到 HTTPS 后再测。

## 部署

两种方式任选其一，接口逻辑是同一份（`server/core.mjs`）。

### 方式一：Cloudflare Pages（推荐，免费、自带 HTTPS）

页面由 Pages 托管，`/api` 由 `functions/api/` 里的 Pages Functions 提供。

0. 在 Cloudflare 后台开通 **R2**（左侧菜单 R2 对象存储 → 开通；免费额度 10 GB，开通时需要绑定付款方式），然后创建云同步用的存储桶和数据库。数据库 ID 填进 `wrangler.toml` 的 `database_id`：

```bash
npx wrangler r2 bucket create context-reader-books
```

```bash
npx wrangler d1 create context-reader
```

1. 注册 Cloudflare 账号，在本机登录（会打开浏览器授权）：

```bash
npx wrangler login
```

2. 第一次发布（会自动创建名为 `context-reader` 的项目，之后每次更新也是这条命令）：

```bash
npm run cf:deploy
```

3. 设置四个环境变量（每条命令会提示粘贴值，值不会写进代码仓库）：

```bash
npx wrangler pages secret put ACCESS_TOKEN
```

```bash
npx wrangler pages secret put AI_BASE_URL
```

```bash
npx wrangler pages secret put AI_MODEL
```

```bash
npx wrangler pages secret put AI_API_KEY
```

也可以在 Cloudflare 后台 → Workers & Pages → context-reader → 设置 → 变量和机密 里填。**改完环境变量后要再运行一次 `npm run cf:deploy` 才生效。**

4. 打开命令输出的 `https://context-reader.pages.dev`（或在后台「自定义域」绑定自己的域名），在 App 设置里填访问口令并「测试连接」。

注意：

- 在国内访问 `*.pages.dev` 经常不稳定，建议绑定自己的域名。
- Cloudflare 从离用户最近的节点访问模型服务，国内用户通常走香港节点。OpenAI、Anthropic 等不对该地区开放的服务可能拒绝请求，DeepSeek 等国内服务不受影响。
- 本地模拟 Cloudflare 环境：把 `.env` 里的四项复制到 `.dev.vars`，然后运行 `npm run cf:dev`，打开 `http://localhost:8788`。

### 方式二：Node 服务 / Docker

一个 Node 进程同时提供页面和接口，没有其他依赖：

```bash
npm run build
```

```bash
npm start
```

默认端口 8787（可用 `PORT` 修改）。要点：

- **必须是 HTTPS**，否则 iPhone 上不能离线、也不能作为 PWA 正常工作。放在任何自带 HTTPS 的 Node 托管平台上，或者自己的服务器前面加一层 Caddy / Nginx 反向代理即可。
- 环境变量在托管平台的面板里设置，或者在服务器上放 `.env` 文件。API Key 只存在于服务端，不会进入前端代码。
- 也可以用仓库里的 `Dockerfile`：

```bash
docker build -t context-reader .
```

```bash
docker run -d -p 8787:8787 --env-file .env -v reader-data:/app/data context-reader
```

Node 方式的云同步数据存在 `data/` 目录（可用 `SYNC_DIR` 修改，设为 `off` 关闭云同步），Docker 部署时记得像上面那样挂载数据卷，否则重建容器会丢失。

如果前端和接口不在同一个域名下，在服务端设置 `ALLOWED_ORIGIN=前端地址`，并在 App 设置里的「服务地址」填接口地址。同域部署时这两项都不用管。

## 添加到 iPhone 主屏幕

1. 用 **Safari** 打开部署后的 HTTPS 地址
2. 点底部的分享按钮 → 「添加到主屏幕」
3. 之后从主屏幕图标打开，在「设置」里填访问口令，再导入书籍

注意：主屏幕 App 和 Safari 里的网页是**两份独立的数据**。请在主屏幕 App 里导入书，不要先在 Safari 里导入再添加。开启云同步后，换域名或换设备时填同一个访问口令，数据会自动同步回来。

导入书籍：把 EPUB / TXT 存到「文件」App（或 iCloud Drive），在书架点右上角的 `+` 选择即可。

## 真机验证清单

以下几项已在桌面浏览器的手机视口里验证过，但 iOS 的触摸选择行为只有真机才能确认，建议第一次用时按顺序过一遍：

1. **文字选择**：EPUB 和 TXT 各开一本，长按一个单词 → 出现系统选区和底部弹窗；拖动选区两端的手柄扩成一句话 → 弹窗里的原文跟着更新
2. **弹窗操作**：依次点 翻译、AI 讲解（再点「显示译文」）、朗读、收藏；点按钮后弹窗不应自己关掉；点正文空白处关闭弹窗
3. **选区靠近屏幕底部**时，正文应自动上滚，不被弹窗挡住
4. **位置恢复**：读到某一章中间 → 上滑退出 App → 在多任务里划掉 → 重新打开，应直接回到那本书的同一位置
5. **离线**：开飞行模式后打开 App，书架和已导入的书能正常读；翻译会提示离线，之前查过的内容仍能显示
6. **目录、字号、主题**：改字号后停留在原来的段落
7. **连续滚动**：读到章末继续上滑，下一章应直接接上；在章首往回滑，能回到上一章末尾，画面不应跳动

8. **生词标记**：查过一个词后，正文里它应带下划线；点下划线的词直接弹出之前的释义（需要 iOS 17.2 以上，更旧的系统不显示标记，其余功能不受影响）
9. **听读**：点顶部耳机图标开始，当前句应高亮并随朗读滚动；锁屏或切到后台后朗读会停，回来点「继续」

已知情况：长按选中文字时，iOS 自带的「拷贝 / 查询 / 翻译」气泡菜单也会出现在选区上方，这是系统行为，网页无法关闭，和底部弹窗互不影响。

## 说明

- **隐私**：翻译和讲解只发送选中的文字和它所在的那一段（最多约 500 字符）。
- **EPUB 内的脚本**会在渲染前被移除。
- **系列**：系列名取自这批书内标题里出现最多的名字，可在系列页右上角改名；单本书可在「⋯」里改所属系列和序号。
- **书籍文件**不要放进 `public/`（会被当成网站内容发布）。项目目录里的 `*.epub`、`*.txt` 已被 `.gitignore` 和 `.dockerignore` 排除。
- **删除书籍**只删书的文件，进度和收藏保留；重新导入同一个文件会接着上次的位置。
- **备份**不含书籍文件和访问口令。
- 字号、主题、口令等设置保存在 localStorage；书籍、进度、收藏、AI 结果保存在 IndexedDB。

## 目录结构

```
server/api.mjs      AI 接口（口令校验、提示词、调用模型）
server/index.mjs    生产环境入口：静态文件 + /api
src/pages/          书架、阅读、设置
src/components/     EpubView（epub.js）、TxtView、StudySheet（选词弹窗）
src/lib/            IndexedDB、导入、AI 请求、朗读、备份
vite.config.ts      开发时挂载 /api；构建时生成 service worker
```
