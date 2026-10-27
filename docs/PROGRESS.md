# 项目进度

## README 内容精简

- README 仅保留产品介绍、启动与使用说明、三张脱敏功能截图；移除参考项目清单、内部目录/API 结构、开发历程和实验记录。
- 产物：`README.md`；保留现有截图文件及相对引用，不改动应用代码。
- 验证：`git diff --check`；检查 README 的三个主要章节、图片文件存在及 PNG 文件头、`npm start` 对应的启动入口与可选依赖安装路径。
- 未完成项：无功能开发事项；本次仅修改文档，远端状态可用 `git ls-remote origin refs/heads/main` 与 `git rev-parse HEAD` 核对。

## 2026-10-27：发布到 GitHub

- AnyPkg 根目录已初始化为独立 Git 仓库，并推送到 `git@github.com:h824612113/AnyPkg.git` 的 `main` 分支。
- 初始功能提交：`3e5e45b`（`feat: publish AnyPkg application package aggregator`）；后续文档同步提交见远端历史。
- 提交包含源码、测试、README 功能截图和 Google Play 旁路所需公开资源；本机下载包、缓存、虚拟环境、工作记忆、日志、凭证文件和独立的 `gplaydl/` 子仓库均未提交。

### 验证命令

```bash
git status --short --branch
git ls-remote origin refs/heads/main
```

期望结果：工作区干净；远端 `main` 指向本地最新提交。

## 2026-10-27：README 功能截图

- 使用隔离的 Playwright 浏览器生成 README 截图：`output/playwright/search-results.png`、`output/playwright/direct-downloads.png`、`output/playwright/download-queue.png`。
- 账号状态、设备、后端路径和真实下载队列接口在页面加载前被 mock/拦截；队列图使用虚构任务；搜索结果只调用公开搜索接口。截图已人工查看，未发现账号信息。
- README 新增“功能界面”区域引用三张截图。
- 验证：Playwright 搜索到 14 张结果卡片；直下筛选显示 11 张；截图浏览器中账号均为未登录，设备和任务数据为脱敏示例。

## 2026-10-26：项目优化审查

### 本次结论

- 已修复重定向 SSRF：`openStream()` 现在会在初始请求和每一跳重定向前调用 URL 校验器；网页下载和下载队列统一使用公网地址校验。
- 已修复源超时不取消：`runSource()` 为每个源建立 `AbortController` 上下文，超时会主动销毁 `lib/net` 的请求/响应流。
- 非回环监听要求至少 32 字符的 `ANYPKG_REMOTE_TOKEN`；所有 HTTP 路由（含 MCP）校验 Bearer 或站点 Cookie。浏览器用一次性 `?token=` 换取 HttpOnly、SameSite=Strict Cookie 后会重定向清理 URL。
- 搜索、GitHub release、应用宝详情、APKPure、Flathub、Snapcraft、Apple 版本元数据、Winget 清单和网络 host 模式的内存缓存均有条目上限；并发搜索键也设有上限。
- 已增加根目录 `.gitignore`，避免缓存、下载包、虚拟环境和日志进入源码版本管理。

- 核心服务可启动，`/api/health` 返回正常；实测“微信”搜索 13 个源均正常返回状态，结果含应用宝等数据。
- 远程认证回归覆盖无令牌拒绝、Bearer、浏览器 Cookie 以及 MCP Bearer，均通过；新增 `npm run test:quota` 覆盖临界容量拒绝及隐藏临时分段文件计数。
- Node 下载队列的 Range 分段、非 Range 单流回退、断线续传和取消清理测试通过，三种下载 MD5 一致。
- `gplay-server` 的单流/分段断点续传测试通过。
- `.downloads` 采用不自动删除的容量策略：占用达到 10 GiB 后拒绝新的队列、Apple / Play 落盘和本地 CLI 下载；排队任务开始执行时会再检查，避免满额后才启动。已运行下载允许完成，手动清理后恢复。安装已有文件不受限制。健康接口暴露使用量和上限。
- 当前运行时目录仍位于项目目录：本次实测 `.downloads` 为 1,389,842,552 字节（约 1.29 GiB），`.cache` 约 45MB，`gplay-server/.venv` 约 54MB；通过 `.gitignore` 防止误提交，目录未迁移且现有文件未清理。
- `package.json` 声明 Node 20+：这是核心服务最低版本；Winget 可选源需要 Node 22+ 的 `node:sqlite`，Node 20 会跳过该源。README 已明确区分这两种能力。

### 验证命令

```bash
node --check server.js
for f in lib/*.js public/app.js scripts/*.js; do node --check "$f" || exit 1; done
npm run test:security
npm run test:timeout
npm run test:bind
npm run test:quota
npm run test:queue
env -u PYTHONPATH gplay-server/.venv/bin/python gplay-server/test_partials.py
env -u PYTHONPATH gplay-server/.venv/bin/python gplay-server/test_resume.py
```

期望结果：Node 语法检查通过；队列测试的 `range`、`norange`、`flaky` 三个场景 MD5 一致且取消后无残留；两个 Python 断点测试输出“全部通过”。

### 下一步建议

1. 后续可考虑拆分 3,800 行以上的 `server.js`，当前不在安全与缓存优化范围内。

### 完成状态

远程令牌认证、长期缓存上限、Node 20/22 能力说明、下载目录配额和全套回归测试已完成。策略不会自动删除现有文件；目录达到 10 GiB 后，新的落盘下载会收到容量错误，手动清理后可继续。健康接口实测 `downloadStorage.used=1389842552`、`limit=10737418240`，服务健康检查正常。
