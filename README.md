# dsh-editor-mode

DSH（DeepSeek Harness）编辑器模式插件：安装后在右上角切换 **Agents 对话** 与 **内置 VS Code 编辑器**，
并且在编辑器侧栏里直接和 **DSH 里配置的那个模型** 对话。

编辑器内核使用 [code-server](https://github.com/coder/code-server) 4.145.2（MIT），
以 iframe 嵌入 DSH 主窗口；**不修改 VS Code / code-server 源码**，改动全部在 DSH 插件层。

> 当前形态（路线 A）：**一个 DSH 窗口内切换标签页**，不是「一个应用多个独立窗口」。
> DSH 的 Electron 主进程是单窗口架构（`mainWindow` 单例、`setWindowOpenHandler` 拒绝新窗口），
> 插件无法开出第二个窗口；多窗口形态需要改 DSH 内核或 fork VSCodium。

## 目录结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：托管 code-server 进程、`/editor-status`、`/editor-bridge/*` 选区桥、`/editor/*` 反代、进程组清理、端口自动探测 |
| `sessions.js` | 会话桥：把 `/editor-sessions/*` 搬到 DSH 的 `sessionController`（会话即真实 Agent） |
| `client.js` | Client 半边：`main` 全屏面板（key=`editor`）、侧栏图标、右上角分段控件、选区轮询与输入框注入 |
| `extensions/local.dsh-editor-bridge-0.2.0/` | 随包发布的 VS Code 扩展：侧栏 Chat（webview）+ 选区发给 Agents |
| `extensions/…/sse.js` | SSE 增量解析（可单测） |
| `extensions/…/media/markdown.js` | 侧栏 Markdown 渲染（纯函数，可单测） |
| `cordis.patch.yml` | Loader patch，插入 `editor-mode` 行并声明 config |
| `test/` | 离线单测 + 真实 DSH 联调脚本 |

## 安装

### 1. 准备运行时（当前阶段需手动）

```bash
mkdir -p ~/.dsh/editor-runtime && cd ~/.dsh/editor-runtime
npm init -y
npm install code-server@4.145.2
```

> **Node 版本**：code-server 4.145.2 要求 Node 24。本机 DSH 自带 node v24 带
> hardened runtime，会拒绝加载 `argon2` 原生模块（Team ID 不匹配），因此插件
> 固定使用系统 node（`/usr/local/bin/node` 等）并设 `FORCE_NODE_VERSION=24`
> 绕过版本门禁。生产版需自带兼容 node 或重签原生模块。

### 2. 安装 bundle

在 DSH 中通过 `plugin_manager` 的 `install_bundle` 安装本目录，或直接把本仓库
加入 profile 的 `dsh.profile.bundles`（本机为 `link:` 依赖，改源码后重启即生效）。

### 3. 配置（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `runtimeDir` | `~/.dsh/editor-runtime` | code-server 安装目录；也是 `bridge.json` 的落盘位置 |
| `upstreamHost` | `127.0.0.1` | 回环监听地址 |
| `upstreamPort` | `3999` | 首选回环端口（1..65535）；被占用时自动探测后续空闲端口 |
| `nodeBin` | `''` | 指定 node 可执行文件；留空自动探测 |
| `workspaceDir` | `''` | 打开的项目目录；留空回退到 `~/dsh-editor-mode` |
| `bridgeToken` | `''` | 桥接 / 对话端点 token；留空每次启动随机生成 |
| `userDataDir` | `~/.dsh/editor-runtime/user-data` | code-server 独立 user-data-dir（不污染全局配置） |
| `editorSettings` | `{}` | 覆盖写入编辑器的默认设置 |
| `skipBuiltinExtensions` | `['GitHub.copilot-chat']` | 不加载的内置扩展；设成 `[]` 可恢复 code-server 默认行为 |
| `editorSettings`（继续） | — | 默认写入 `chat.disableAIFeatures: true`，防止核心聊天视图留下空壳 |

## 三块能力

### 一、Agents / 编辑器 模式切换

刷新 GUI 后点右上角「编辑器」或左侧栏「编辑器」图标；点「Agents」或「返回 Agents」回到对话。

编辑器工具栏：

| 按钮 | 作用 |
|---|---|
| **打开目录** | 调 DSH 目录选择器；只改 iframe 的 `?folder=`，**无需重启** code-server |
| **重载** | 强制重建 iframe |
| **返回 Agents** | 回到 DSH 对话 |

端口被占用时自动向后探测（`[配置值, 配置值+20)`），实际地址由 `/editor-status` 返回。

### 二、编辑器侧栏 Chat（用 DSH 的模型）

编辑器里多一个 **DSH Chat** 视图，两个入口都指向同一份对话：

- **左侧活动栏** DSH 图标（`viewsContainers.activitybar`）
- **右侧次级侧栏** DSH 图标（`viewsContainers.secondarySidebar`）—— 就是原先被 GitHub Copilot Chat
  占掉的那块位置，现在由 DSH Chat 接管

形态与 Cursor / CodeBuddy 一致（`type: webview` 视图，不碰 workbench 源码）。同一视图 id 挂两个容器时，
VS Code 各给一个宿主实例；点「打开 DSH Chat」命令会优先聚焦当前可见的那一侧，不会平白把另一侧也展开。

**模型来源**：会话用的就是 DSH 当前会话的模型，不需要另配（`sessionController` 决定）。旧的 `/editor-chat/models` 读的是 DSH 自己的适配器注册表与
`agentDefaultModel.currentSelection()`，所以下拉里就是你在 DSH 设置里配的那套
provider / 模型（含自定义 endpoint），默认值就是 DSH 当前选定的模型；
**插件不新增任何模型配置，也不保存任何 API Key**。

**链路**：

```
webview (media/chat.js)
  ⇅ postMessage
扩展 Node 侧 (extension.js)  ──HTTP/SSE──▶  DSH Host /editor-sessions/{prompt,stream}
                                              ⇣
                                         ctx.llm.stream()
                                              ⇣
                                   你在 DSH 配置的 provider
```

**能力**：

| 功能 | 说明 |
|---|---|
| 流式回答 | SSE 逐字推送；思考内容单独折叠显示 |
| 上下文 | 「带上下文」勾选时，把当前文件相对路径、行号、语言、选区代码附到最后一条提问 |
| 多轮 | 对话历史随请求带上（上限 40 条），按项目持久化在 `workspaceState` |
| 模型切换 | 顶栏下拉按 provider 分组，选择按项目记住 |
| 停止 | 「停止」同时 abort 本地请求与 DSH 上游生成（实测 finish=aborted） |
| 会话切换 | 顶部下拉列出最近会话，可与 DSH Agents 双向切换同一条会话 |
| 历史面板 | 另一个视图，列出**全部工作区**的会话，按今天/昨天/近 7 天分组，可搜索 |
| 复制 | 整条回复 / 单个代码块一键复制 |

**定位（2026-11 变更）**：侧栏 Chat **就是 DSH 真实 Agent 会话的第二个视图**，
默认带工具（能读文件、跑命令、改代码），与在 Agents 模式里对话是同一条会话。
这是「双模式 X」：两个视图共用一份会话，切走再回来历史一致。

### 三、选区 → DSH Agents

命令面板 / 编辑器右键菜单：

| 命令 | 作用 |
|---|---|
| **发送给 DSH Agents（当前选区）** | 文件路径 + 行号 + 选中代码送进 Agents 输入框 |
| **发送给 DSH Agents（当前文件）** | 只发送文件路径引用 |
| **在 DSH Chat 中询问选中代码** | 把选区连同「这段代码在做什么」填进侧栏 Chat 输入框（不自动发送） |

链路：`扩展 POST /editor-bridge/push` → Host 有界队列 → Client 每 1.5s 轮询
`/editor-bridge/pending` → 切回 Agents → 追加到输入框草稿。

## 端点与鉴权

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /editor-status` | DSH 会话 cookie | 端口/目录/状态 |
| `GET /editor-sessions/list` | 回环 + token | 全部工作区会话 |
| `GET /editor-sessions/search` | 回环 + token | 跨会话搜索 |
| `POST /editor-sessions/create` | 回环 + token | 新建会话 |
| `POST /editor-sessions/prompt` | 回环 + token | 发送消息 |
| `POST /editor-sessions/cancel` | 回环 + token | 停止本回合 |
| `POST /editor-sessions/rename` | 回环 + token | 重命名 |
| `GET /editor-sessions/history` | 回环 + token | 历史页（含冷会话） |
| `GET /editor-sessions/stream` | 回环 + token | SSE：snapshot / session-event / assistant-chunk |
| `POST /editor-bridge/push` | 回环 + token | 选区入队 |
| `GET /editor-bridge/pending` | DSH 会话 cookie | 选区出队 |
| `/editor/*` | DSH 会话 cookie | HTTP 反代占位 |

扩展从环境变量 `DSH_EDITOR_BASE` / `DSH_EDITOR_TOKEN`（以及
`DSH_BRIDGE_URL` / `DSH_BRIDGE_TOKEN`）取通道；env 缺失时回退读
`<runtimeDir>/bridge.json`（权限 0600，DSH 每次启动重写）。token 只在 Node 侧使用，
**不会进入 webview**（有测试守住）。

## 测试

```bash
node test/run-all.mjs            # 离线单测（5 个用例）
node test/integration-chat.live.mjs   # 真实 DSH + 真实模型的端到端联调
```

| 用例 | 覆盖 |
|---|---|
| `client-inject.test.mjs` | 每个槽的 inject 回调在真实执行路径下不抛错（白屏回归） |
| `session-bridge.test.mjs` | `/editor-sessions/*` 鉴权、各接口收敛、follow 三类帧→SSE、服务缺失 503 |
| `fold-events.test.mjs` | 会话事件折叠：工具卡片、失败态、turn 收尾、过滤 DSH 注入的伪用户消息 |
| `sse.test.mjs` | 逐字节切分、CRLF、多行 data、无尾随空行的最后一条 |
| `markdown.test.mjs` | XSS 转义、未闭合代码块、列表/标题/引用 |
| `webview-wiring.test.mjs` | 模板占位符、命令/视图 id、消息协议两端对齐、token 不外泄 |
| `host-late-service.test.mjs` | webServer 晚于插件就绪时仍能装配（旧实现在此永久不激活） |
| `host-restart.test.mjs` | 崩溃退避曲线、重启上限、运行时缺失不重试 |
| `integration-chat.live.mjs` | 假 vscode 加载扩展 → 真 DSH → 真模型 → postMessage 回 webview |

## 已知边界

- **iframe 直连回环**，非同源反代：code-server 的 WebSocket 走多条动态路径，而 DSH
  `registerUpgrade` 只支持 exact path；跨 origin 由 `--trusted-origins '*'` + `--auth none`
  放行，仅监听 `127.0.0.1`。
- 无 Config schema、无运行时自动下载/校验。
- code-server **崩溃会自动重启**（指数退避 1s→30s，上限 5 次，成功后计数归零）。
  重启中 / 失败时 `/editor-status` 返回 `status: restarting|failed` 与 `error`，
  面板会显示对应提示并自动探活，恢复后自己重建 iframe。运行时未安装这类配置问题不重试。
- **`webServer` 是声明式依赖**（`export const inject = ['webServer']`），另有轮询兜底：
  cordis 可能在本插件之后才就绪 `webserver`，旧实现直接 throw 会让这一行永久不激活，
  现象是全站 `/editor*` 404、code-server 不起，而桌面端把该错误吞进 stderr。
  `test/host-late-service.test.mjs` 守住了这条。
- 全局快捷键、下载、扩展 webview 在 iframe 内可能有损耗。
- code-server 发行包内置的 GitHub Copilot Chat **不再加载**（`VSCODE_SKIP_BUILTIN_EXTENSIONS`，
  由 `skipBuiltinExtensions` 配置控制）。它占的右侧 Chat 面板由 DSH Chat 侧栏替代；
  注意 `github.copilot.enable:false` 只能关补全，关不掉那个视图。
- 侧栏 Chat 不带工具、不共享 DSH 会话历史（它是独立线程）；需要 Agent 能力请走「→ Agents」。
- 输入框注入依赖 `conversation.input` facade 的 `setDraft`，DSH 升级若改契约需同步适配。
- **不要直接访问未在 `inject` 声明的 cordis 服务**（如 `ctx.uiWorkspace`）：会抛
  `Service not found`，且错误发生在槽渲染时，表现为编辑器面板整片白屏。
  一律用 `ctx.get(name)`，它对未提供的服务返回 `undefined` 而不抛错。
  `test/client-inject.test.mjs` 会真实执行每个槽的 inject 回调来守住这条。

## 开发注意

**改 Host 半边（`index.js`）后必须重启 DSH**，热重载不会重新 import 主入口。
只改 `client.js` 则刷新 GUI 页面即可；只改 VS Code 扩展（`extensions/**`）需重启 code-server。

改完先跑：

```bash
node test/run-all.mjs             # 离线单测（8 个用例）
node test/integration-chat.live.mjs   # 真实 DSH + 真实模型
```

### 与 DSH 会话 API 对接时踩过的坑（2026-11，DSH 0.2.2-rc.1）

都是实测出来的真实行为，不是猜测，改动前请先看：

1. **`address` 是 `{kind:'session', sessionId}`**，不是 `{kind:'session', id}`。
   写错时 DSH 报 `failed to observe session "undefined"`。
2. **`follow()` 必须显式传 `assistantStream: true`**，否则只有持久事件、
   没有文字增量帧，表现是「一直转圈但不出字」。
3. **历史页必须传 `beforeSeq`**。不传时 DSH 的 `paginate` 会返回空页
   （`cursor` 正常、`records` 为空）。另注意 `Number(null) === 0`：
   把「没传」误当成 `beforeSeq=0` 同样拿到空页。
4. **历史与快照里的数据在 `records` 里**，每项是 `{type:'event', event}`，
   直接读 `events` 永远是空数组。
5. **`user/message` 的内容在 `data.content`**，而 `assistant/message` 在
   `data.message.content`；两者形状不同。
6. **DSH 会把运行时上下文/技能目录/时间快照也写成 `user/message`**，
   `source.kind` 分别是 `runtime-context` / `skill-catalog` / `time-context`，
   渲染前必须按 `source.kind === 'user'` 过滤，否则界面全是噪音。

## 许可

插件代码 MIT。code-server 为 Coder 的 MIT 项目，VS Code 部分遵循其各自许可；
本仓库**不分发** code-server 二进制，运行时由使用者自行安装。