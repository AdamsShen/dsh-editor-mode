# Checklist — 编辑器模式待办

> Track: `editor-mode-backlog`｜**本文件是进度权威来源**。
> 只有行首的 `- [ ]` / `- [x]` 会被 autopilot 解析；缩进的 Paths / Done when / Verify 仅为补充说明。
> 来源编号见 `brief.md` §二。估时单位为人日，属粗估。

---

## A 核心闭环（P0）

- [ ] **P0-1 让 AI 改动可被看见（diff 审核）** · 3–5 人日 · 来源 S1
    - Paths: `extensions/local.dsh-editor-bridge-0.3.0/extension.js`、`media/chat.js`、`media/chat.css`
    - Done when: Agent 改动文件后，侧栏能列出本轮改动文件，点击可用 `vscode.diff` 打开「改动前 ↔ 改动后」；不自建 restore（复用 DSH rewind 快照）
    - Verify: 在真实 DSH 里让 Agent 改一个文件，编辑器侧出现 diff 入口且能打开；离线用例覆盖「改动文件列表」的折叠逻辑
    - Depends on: 先只读探测 DSH rewind 快照的可读性与触发时机
    - Note: S1 原文说「AI 不能改代码」已过时；改造后 Agent 真的会改文件，这条缺口**更关键**

---

## B 高频体验（P1）

- [ ] **P1-1 `@` 引用（文件 / 文件夹 / 符号）** · 2–3 人日 · 来源 S1
    - Paths: `media/chat.js`、`extension.js`、`package.json`
    - Done when: 输入框输入 `@` 触发 `showQuickPick` / `workspace.findFiles` 选文件，选中内容按预算截断后并入会话上下文
    - Verify: 引用一个未打开的文件提问，Agent 能读到其内容；预算上限不被突破
    - Depends on: 无

- [ ] **P1-2 更多上下文入口（资源管理器 / 终端右键）** · 0.5–1 人日 · 来源 S1
    - Paths: `package.json`（`contributes.menus`）、`extension.js`
    - Done when: 新增 `explorer/context` 与终端选区命令，把文件/选区送入当前会话
    - Verify: 在资源管理器和终端右键能看到并成功触发；`test/webview-wiring.test.mjs` 仍全绿
    - Depends on: 无

- [ ] **P1-3 项目规则文件注入** · 1 人日 · 来源 S1
    - Paths: `sessions.js` 或 `index.js`（Host 侧组装上下文处）
    - Done when: 发消息时读取项目根 `AGENTS.md` 并按 DSH 既有优先级注入；Chat 能遵守本项目约定
    - Verify: 在 `AGENTS.md` 写一条明确规则，提问验证 Agent 遵守
    - Depends on: 需先按项目 skill 调研业内规则文件约定（`.cursor/rules` / `CODEBUDDY.md` / `AGENTS.md`）
    - Note: 收益/成本比最高，建议排在 P1 最前

---

## C 正确性欠账（P2，均为改造后遗留，建议先做）

- [ ] **P2-1 修复联调测试 `integration-chat.live.mjs`** · 0.5 人日 · 来源 S4
    - Paths: `test/integration-chat.live.mjs`
    - Done when: 不再引用已删除的 `/editor-chat/{send,models,abort}`，改为走 `/editor-sessions/{create,prompt,stream}` 验证真实会话链路
    - Verify: `node test/integration-chat.live.mjs` 在 DSH 运行时通过（或按设计明确跳过）
    - Depends on: 无
    - Note: 改造时只更新了 9 个离线用例，这个 live 测试被漏掉了；当前它跑不通

- [ ] **P2-2 README 纠偏** · 0.3 人日 · 来源 S3
    - Paths: `README.md:197`（「侧栏 Chat 不带工具、不共享 DSH 会话历史」）、`README.md:210`（「8 个用例」）
    - Done when: 改为「就是 DSH 真实 Agent 会话的第二个视图」与「9 个用例」；能力表与实际交互（tab 条 / 历史覆盖层 / 工具卡片）一致
    - Verify: 通读 README 无与 `package.json`、`extension.js` 矛盾的描述
    - Depends on: 无

- [ ] **P2-3 更新 `docs/research/gap-todo.md`** · 0.5 人日 · 来源 S1
    - Paths: `docs/research/gap-todo.md`
    - Done when: 修正「纯模型对话 / AI 不能改代码 / MCP 会打破边界」等过时结论；「已完成」的多会话与历史条目从待办移出；与 `checklist.md` 交叉引用
    - Verify: 该文档与 `cursor-codebuddy-editor-implementation.md` 的证据链仍自洽，不删原始调研记录
    - Depends on: 无

- [ ] **P2-4 补 Config schema 与参数校验** · 1–2 人日 · 来源 S2、S5
    - Paths: `index.js`（`apply`）、`cordis.patch.yml`
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

- 待办：14 项（P0×1、P1×3、P2×4、P3×3、P4×3）
- 已完成：0 项
- 明确不做：4 项（已勾选，仅作记录）
