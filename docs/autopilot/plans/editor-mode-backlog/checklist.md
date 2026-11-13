# Checklist — 编辑器模式待办

> Track: `editor-mode-backlog`｜**本文件是进度权威来源**。
> 只有行首的 `- [ ]` / `- [x]` 会被 autopilot 解析；缩进的 Paths / Done when / Verify 仅为补充说明。
> 来源编号见 `brief.md` §二。估时单位为人日，属粗估。

---

## A 核心闭环（P0）

- [x] **P0-1 让 AI 改动可被看见（diff 审核）** · 3–5 人日 · 来源 S1
    - Paths: `sessions.js`、`extensions/local.dsh-editor-bridge-0.3.0/{extension.js,session-view.js,media/chat.js,media/chat.css}`
    - Done when: Agent 改动文件后，侧栏列出本轮改动文件，点击用原生 `vscode.diff` 打开「改动前 ↔ 改动后」
    - Verify: 隔离 DSH 实测通过 —— Agent 真改 `demo.txt` 后 `workspace/changes(seq=33)` 到达实时流，
      `summary` 返回 1 个文件 +1/−1，`diff` 返回真实 hunk，反推的 before 与原始内容逐行一致
    - Depends on: ~~DSH rewind 快照~~ → **已修正为 `ctx.workspaceChanges` 服务**
    - Note: 原 `Depends on` 方向有误。实测 `dsh-rewind-plugin` 只导出 Config/SnapshotStore/apply，
      未注册可供外部插件调用的服务，对外只有面向 Client UI 的两个路由，**不可复用**。
      真正可用的是 DSH 自己的 `workspaceChanges`（由 `dsh-web-app` 组成，与 sessionController 同级），
      `summary()` 给文件列表、`diff()` 给 hunks。且 `diff()` 只回 `before/after` 布尔值不回原文，
      故「改动前」内容由「磁盘当前内容 + hunks 反推」还原（`invertHunks`）。
      不做 restore —— DSH 侧已有 rewind 用户入口，不重复造。

---

## B 高频体验（P1）

- [ ] **P1-1 `@` 引用（文件 / 文件夹 / 符号）** · 2–3 人日 · 来源 S1
    - Paths: `media/chat.js`、`extension.js`、`package.json`
    - Done when: 输入框输入 `@` 触发 `showQuickPick` / `workspace.findFiles` 选文件，选中内容按预算截断后并入会话上下文
    - Verify: 引用一个未打开的文件提问，Agent 能读到其内容；预算上限不被突破
    - Depends on: 无

- [x] **P1-2 更多上下文入口（资源管理器 / 终端右键）** · 0.5–1 人日 · 来源 S1
    - Paths: `package.json`（commands/menus/activationEvents）、`extension.js`
    - Done when: 新增 `explorer/context`（按文件/目录分派、支持多选）与 `terminal/context` 三个命令
    - Verify: 菜单声明与 `registerCommand` 成对（静态断言覆盖）；终端读不到选区时给明确提示
    - Note: 只送 `@路径` 不送文件内容——Chat 是真实 Agent，自己会读文件，塞正文会浪费上下文预算
    - Note: 终端选区无公开 API，走 `workbench.action.terminal.copySelection` + 剪贴板，
      命令或剪贴板不可用时降级为提示

- [x] **P1-3 项目规则文件注入** · 1 人日 · 来源 S1
    - **调研结论（2026-11-13）**：DSH 的 `agent-instructions` 模块**已经原生加载**
      `AGENTS.md` / `CLAUDE.md`（含 `.local` 覆盖，按 `.git` 标记向上查找），
      且已组合进默认栈（`dsh-web-app/cordis.patch.yml:577`、`dsh-base/cordis.patch.yml`）。
      侧栏 Chat 是同一套 sessionController + cwd，因此**规则自动生效，无需我们注入**。
      自己再拼一份只会重复注入并打乱「项目 > 全局」的优先级。
    - Done when: 平台读不到的旧约定（`.cursorrules`、`.cursor/rules/*.mdc`、
      `.github/copilot-instructions.md`、`CODEBUDDY.md`）可一键导入 `AGENTS.md`
    - 实现: 新增命令 `dshEditorBridge.importRules`；只追加不覆盖、带 `<!-- dsh-import: ... -->`
      标记，重复执行幂等；已导入来源即使内容更新也不重写（避免覆盖用户手改）
    - Verify: `test/rules-import.test.mjs`（四种来源识别、保留既有内容、幂等、无文件提示）
    - Note: 原计划「Host 侧组装上下文注入」被否——那是重复实现平台能力

---

## C 正确性欠账（P2，均为改造后遗留，建议先做）

- [x] **P2-1 修复联调测试 `integration-chat.live.mjs`** · 0.5 人日 · 来源 S4
    - Paths: `test/integration-chat.live.mjs`
    - Done when: 不再引用已删除的 `/editor-chat/*`，改为走 `/editor-sessions/*` 验证真实会话链路
    - Verify: 探活用 `/editor-sessions/list`；「无 bridge.json / 端点不可达」时输出 SKIP 并 exit 0（已实测）
    - Note: 不只是换端点——旧用例断言的是 `models`/`delta`/`message.content`，
      新协议已改为 `sessionId`/parts/`append`，故整体按新协议重写

- [x] **P2-2 README 纠偏** · 0.3 人日 · 来源 S3
    - Paths: `README.md`（已知边界段 + 测试用例数）
    - Done when: 「侧栏 Chat 不带工具」改为「就是 DSH 真实 Agent 会话的第二个视图」；用例数改为 12
    - Verify: `grep` 全文无「不带工具、不共享」与旧用例数（已验，0 残留）

- [x] **P2-3 更新 `docs/research/gap-todo.md`** · 0.5 人日 · 来源 S1
    - Paths: `docs/research/gap-todo.md`
    - Done when: 顶部加时效声明；「一句话结论」与 MCP 段落标注失效并给出当前结论；指向 checklist 作为权威进度
    - Verify: 保留原始调研记录（用删除线+注解，不删原文）；失效结论处均有 ⚠️ 标注

- [x] **P2-4 补 Config schema 与参数校验** · 1–2 人日 · 来源 S2、S5
    - **不用 schemastery 的原因**：`@deepseek-ai/schemastery` 只在 DSH 应用顶层
      node_modules，本插件从 profile（软链仓库）加载，解析不到；直接 import 会让插件
      加载即崩，比缺 schema 严重。改用零依赖的 `CONFIG_SPEC` + `validateConfig()`。
    - 关键判断：**「目录不存在 / 二进制不可执行」是运行时状态，不是配置错误**——
      判成致命错误会让「运行时未安装 → 给安装指引」这条正常路径变成启动崩溃
      （`host-restart.test.mjs` 当时就是这么暴露的）。这类只告警。
    - Paths: `index.js`（`CONFIG_SPEC` / `validateConfig` / `apply` / `/editor-status`）
    - Done when: 用 schemastery / z 声明 `runtimeDir` / `upstreamHost` / `upstreamPort` / `nodeBin` / `workspaceDir` / `skipBuiltinExtensions` / `bridgeToken` 的类型与取值约束；非法配置在启动时给出明确错误而不是白屏
    - Verify: 传一个越界端口与非法 `nodeBin`，插件报出可读错误且 `/editor-status` 显示 `failed`；`npm test` 全绿
    - Depends on: 建议排在 P3-1 之前

---

## D 产品化（P3）

- [ ] **P3-1 运行时自动下载与校验（装完即用）** · 8–13 人日 · 来源 S2、S5
    - Paths: `index.js`（新 `ensureRuntime`）、`package.json`、`cordis.patch.yml`
    - Done when: 插件首次启动自动下载 code-server 指定版本并校验 SHA-256，落到插件自管目录；不再要求用户手动 `npm install code-server`
    - Verify: 删掉 `~/.dsh/editor-runtime/node_modules/code-server` 后重启 DSH，插件自动补齐并拉起工作台；断网时给出可操作提示而非白屏
    - Depends on: P2-4（schema）、跨平台 Node 兼容与 hardened runtime 签名
    - Note: **「装完即用」的唯一硬门槛**，也是 S2「无 Config schema、无运行时自动下载」的完整修复

- [ ] **P3-2 同源反代** · 5–8 人日 · 来源 S2
    - Paths: `index.js`（`registerUpgrade` / `proxyUpgrade`）
    - Done when: code-server 的多条动态 WebSocket 路径能通过 DSH 同源反代，iframe 不再直连回环
    - Verify: 关掉 `--trusted-origins '*'` 后工作台仍可用；WS 连接不 404
    - Depends on: 需先解决「`registerUpgrade` 仅支持 exact path」的冲突；保留 iframe 直连兜底
    - Note: 这是 S2 里唯一标注了明确技术障碍的项，动手前必须先做可行性验证

- [ ] **P3-3 Tab 补全** · 8–15 人日 · 来源 S1
    - Paths: `extension.js`（`registerInlineCompletionItemProvider`）、`sessions.js`（新增低延迟端点）
    - Done when: 行内 ghost text 补全，含 debounce / 取消 / 上下文预算 / 缓存
    - Verify: 在编辑器里打字百毫秒级出现建议，Tab 接受、Esc 取消；不影响主会话流
    - Depends on: **独立低延迟模型端点**，不能复用秒级的 `/editor-sessions/stream`
    - Note: 排 P3 不是因为不重要，而是它不影响「能不能用」，且前置条件未满足

---

## E 长尾（P4）

- [ ] **P4-1 codebase 语义检索** · 10–20 人日（关键词版 2–3 人日）· 来源 S1
    - Paths: `sessions.js`、`extension.js`（工具注册）
    - Done when: 先做本地关键词检索版（复用 DSH `grep`/`glob`），语义版等需求确认
    - Verify: Agent 能检索项目内符号；**不把用户代码传到第三方**
    - Depends on: P3-3 的低延迟链路可选复用；本地索引方案需调研
    - Note: Cursor 在云端、CodeBuddy 在本地 `codenexus`；本项目倾向本地

- [ ] **P4-2 MCP 接入** · 5–8 人日 · 来源 S1
    - Paths: `extension.js`、`package.json`
    - Done when: 编辑器 Chat 能接入 DSH 已有 MCP 资源服务
    - Verify: 通过 MCP 读一个外部资源并在会话里体现
    - Depends on: 无硬依赖，但 DSH 已支持 MCP，优先级可一直压后
    - Note: S1 原文「会打破纯对话边界」已过时——Chat 本就是 Agent

- [ ] **P4-3 NES（下一处编辑预测）** · 8–12 人日 · 来源 S1
    - Paths: `extension.js`（`nes.*` 命令族）
    - Done when: 预测并提示下一处可编辑位置
    - Verify: 改完一段代码后出现 NES 提示且可跳转
    - Depends on: **必须排在 P3-3 之后**（共用同一套低延迟链路）

---

## 明确不做（不计入 14 项待办）

- [x] **多窗口**：DSH 是单 `mainWindow` 架构，`setWindowOpenHandler` 拒绝新窗口；2026-11 已实测，非实现难度问题
- [x] **内联编辑 Cmd+K**：Cursor 官方已废弃，改为「选中代码 → 开 Agent」；本项目现有的「选中 → DSH Agents」与之等价
- [x] **用 VS Code 原生 Chat 扩展点**：CodeBuddy 也完全不用，路线一致
- [x] **调研报告里 12 条未验证项**：见 `cursor-codebuddy-editor-implementation.md` 第六节，不得当结论使用；Cursor 内部实现因应用已删除无法取证

---

## 进度

- 待办：7 项（P1×1、P3×3、P4×3）
- 已完成：7 项（P0-1、P1-2、P1-3、P2-1、P2-2、P2-3、P2-4）
- 明确不做：4 项（已勾选，仅作记录）
