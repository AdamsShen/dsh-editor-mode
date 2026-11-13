# P0-1 技术方案：让 AI 改动可被看见（diff 审核）

> 状态：**已实现并验证**（2026-11-12）｜由 `/autopilot-run` 触发，按项目 skill
> `research-before-editor-feature` 先调研、再出方案、用户判断后才动代码。
> 用户选择了**方案 B（原生 `vscode.diff`）**，并同意两项默认（冷会话明确提示、
> 修正清单 `Depends on`）。实施结果与相对本方案的偏离见文末「九、实施结果」。
> 核实时间：2026-11-12（Asia/Shanghai）。

## 一、清单里那条待办，前置假设需要修正

`docs/autopilot/plans/editor-mode-backlog/checklist.md` 的 P0-1 写的是：

> Done when: …点击可用 `vscode.diff` 打开「改动前 ↔ 改动后」；
> **不自建 restore（复用 DSH rewind 快照）**
> Depends on: 先只读探测 DSH rewind 快照的可读性与触发时机

**调研结论：这个前置假设方向不对，不需要碰 rewind。**

DSH 内核已经提供了成套的「改动记录 + 前后文本对比」能力，
`dsh-rewind-plugin` 是面向用户的回退 UI，不是给外部插件读快照的接口。
清单的 `Depends on` 应改为「复用 `ctx.workspaceChanges` 服务」。

## 二、一手证据（均已实测核实）

### 2.0 调研报告交叉印证

配套报告 `docs/research/ai-change-diff-review.md`（九章，383 行）独立核实了同一批事实，
并补了三条对本方案有决定性影响的结论：

1. **`dsh-rewind-plugin` 明确不可被外部插件复用**：它只导出
   `Config / SnapshotStore / apply / inject / name`，`inject = ['commands','tools','settings']`，
   未注册任何可供他人调用的 cordis 服务；对外只有 `/api/dsh-rewind/preview`、
   `/api/dsh-rewind/candidates` 两个 **Client UI 路由**（返回 rewind 候选，不是「某快照某文件内容」）。
   → **清单 P0-1 的 `Depends on` 必须改写。**
2. **DSH 自身已有完整的「AI 改动审阅」实现**（第 3 种业内实现，与本项目同源）：
   `dsh-workspace-changes` + Web 端的「改动文件卡片」+ 右侧栏 review tab
   （地址 `dsh-resource://changes-review/session/<id>/<seq>/<turn>`）。
   → 我们只需**复用**，不该重造。
3. **CodeBuddy 的做法是「自定义 scheme 虚拟文档 + `vscode.diff`/`vscode.changes`」**，
   其「改动前」内容来自自己的 checkpoint 服务而非 git；Cursor 则用
   `checkpoints/<id>/diffs/`（行级 diff JSON）+ `files/`（整文件快照）。
   → 两家都是「先有 before 内容，再喂给原生 diff」。而 DSH 的 `diff()`
   **已经直接给出 hunks**，我们不需要这一步。

> 报告同时列出 9 条明确未验证项（Cursor 侧栏 UI 映射、`agent-diff` provider 全文、
> CodeBuddy checkpoint 落盘格式、rewind 是否藏了 ctx 服务等），均未作为结论使用。
> 其中「`workspace-changes` 是否在 profile 启用」这一条已由本节 2.3 实测解决。

### 2.1 DSH 内置服务：`ctx.workspaceChanges`

`/tmp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh-workspace-changes/lib/index.js:1019`：

```js
ctx.provide("workspaceChanges", {
  summary: (sessionId, seq) => byId.get(sessionId)?.summary(seq),
  diff: (sessionId, seq, index, signal) => byId.get(sessionId)?.diff(seq, index, signal) ?? Promise.resolve(void 0)
});
```

| 方法 | 返回 | 出处 |
|---|---|---|
| `summary(sessionId, seq)` | `{turn, files:[{path,display,added,deleted,binary?,oversized?}], total, added, deleted}` | `dsh-client-ui-deliverables/lib/client.js` 的 `isChangesSummary` / `isChangedFile` |
| `diff(sessionId, seq, index, signal)` | `{kind:'text', path, display, before, after, hunks, coarse}` 或 `{kind:'binary'/'oversized'/'refusal'}` | `dsh-workspace-changes/lib/index.js` 的 `async diff(...)` |

`diff()` **已经把「改动前 / 改动后」两侧文本读出来并算好 hunk**（`compareText(before, after, …)`），
我们不需要自己存 before 内容、不需要自己造虚拟文档 scheme、不需要自建 checkpoint。

### 2.2 现成的 HTTP 路由（DSH Client 侧）

`dsh-client-ui-deliverables/lib/index.js:4-8` 定义、`:84` 通过 `ctx.connection.fetch.register` 注册：

| 路径 | 用途 |
|---|---|
| `GET /api/changes.summary?sessionId=&seq=` | 改动文件列表 |
| `GET /api/changes.diff?sessionId=&seq=&index=` | 单文件对比（hunks） |
| `GET|POST /api/changes.open?...` | 打开文件 / reveal |

handler 里调的就是 `ctx.workspaceChanges.summary(id, seq)` 与 `.diff(id, seq, index, signal)`。

### 2.3 `workspace/changes` 事件：**真实存在，但被我们的白名单过滤了**

隔离实例实测（Agent 用 write 工具真创建了 `/tmp/.../probe.txt`）：

- 会话历史 `page` 通路里**有 1 条** `workspace/changes`，`seq=27`，`data={"turn":1}`
- 实时 SSE 流里**没有**它

原因：`sessions.js:51` 的 `UI_EVENT_TYPES` 白名单**未包含** `workspace/changes`，
所以 `sessions.js:402` 的过滤把它丢了。事件本身只有 `{turn}`，文件列表必须按
`(sessionId, seq)` 去调 `workspaceChanges.summary()`。

> 这条是本方案的核心改动点：**把 `workspace/changes` 加入白名单**，
> 并把它的 `seq` 透给前端，前端才知道去哪取列表。

### 2.4 本项目的精确改动点

| 文件 | 行 | 现状 |
|---|---|---|
| `sessions.js` | 51 | `UI_EVENT_TYPES` 白名单缺 `workspace/changes` |
| `sessions.js` | 402 | 按白名单过滤 `session-event` |
| `extensions/.../extension.js` | 589 | `onStreamEvent` 的 `session-event` 分支，只处理 tool/turn/title |
| `extensions/.../media/chat.js` | — | 消息模型 `parts` 目前只有 `text` / `tool`，需新增 `changes` 类型 |
| `extensions/.../media/chat.css` | — | 需要改动文件列表的样式 |

## 三、拟采用的设计

### 3.1 数据流

```
Agent 改文件
  → DSH 追加 workspace/changes 事件 {seq, data:{turn}}
  → 【改动1】sessions.js 白名单放行，SSE 推 {type:'session-event', type:'workspace/changes', seq}
  → 【改动2】扩展侧收到后，向 Host 要改动列表
        GET /editor-sessions/changes?sessionId=&seq=      （新增端点）
        Host 内部调 ctx.get('workspaceChanges').summary(sessionId, seq)
  → 【改动3】前端把列表渲染成一条「本轮改动 N 个文件」卡片
  → 用户点某个文件
        GET /editor-sessions/changes/diff?sessionId=&seq=&index=   （新增端点）
        Host 调 .diff()，返回 hunks
  → 【改动4】用 vscode.diff 或自绘 hunk 视图打开对比
```

### 3.2 新增 Host 端点（复用现有 token + 回环鉴权）

| 端点 | 内部调用 | 返回 |
|---|---|---|
| `GET /editor-sessions/changes?sessionId=&seq=` | `workspaceChanges.summary()` | `{turn, files, total, added, deleted}` |
| `GET /editor-sessions/changes/diff?sessionId=&seq=&index=` | `workspaceChanges.diff()` | `{kind, path, display, hunks, …}` |

**降级**：`ctx.get('workspaceChanges')` 不可用时返回 `503` + 明确原因，
前端显示「DSH 未提供改动记录服务」，不静默失败（与现有会话桥一致）。

### 3.3 前端呈现（对齐 CodeBuddy 的形态）

在助手消息里插入一张 `changes` 卡片：

```
▸ 本轮改动 2 个文件  +18 −3
    sessions.js        +12 −2   [查看 diff]
    chat.js             +6 −1   [查看 diff]
```

点击「查看 diff」的两条可选路径（**需你选一个**）：

- **A（推荐）自绘 hunk 视图**：直接用 DSH 返回的 `hunks` 在 webview 里渲染成
  带 `+`/`-` 行的代码块。零新增 VS Code API 依赖，与现有工具卡片风格一致。
- **B 用 `vscode.diff`**：把 before/after 写成临时文件（或注册
  `TextDocumentContentProvider` 虚拟 scheme）再调原生 diff 命令。
  体验更「原生」，但要管理临时文件生命周期 / scheme 注册，改动面更大。

> 清单原文写的是「点击可用 `vscode.diff` 打开」，
> 但 DSH 的 `diff()` 已经返回结构化 hunks，自绘更省事且不引入临时文件。
> 这一处偏离需要你确认。

### 3.4 与「不自建 restore」的取舍

不做 checkout / restore —— DSH 侧已有 rewind 用户入口，不重复造。
我们只做「看」，不做「回退」。这与清单原意一致。

## 四、涉及的文件与改动范围

| 文件 | 改动 |
|---|---|
| `sessions.js` | 白名单加 `workspace/changes`；新增 2 个 changes 端点；导出 `__internals` 便于测试 |
| `index.js` | 无改动（会话桥已统一从 `sessions.js` 注册） |
| `extensions/.../extension.js` | `onStreamEvent` 新增 `workspace/changes` 分支；新增 2 个 HTTP 请求；`openDiff` 处理 |
| `extensions/.../session-view.js` | `foldEvents` 支持从历史里折叠出 changes 卡片（保证「刚聊完」和「重新打开」一致） |
| `extensions/.../media/chat.js` / `.css` | 新增 `changes` part 渲染与样式 |
| `test/session-bridge.test.mjs` | 新增白名单放行、两个端点契约、503 降级断言 |
| `test/fold-events.test.mjs` | 新增「从历史折叠 changes 卡片」断言 |
| `test/webview-wiring.test.mjs` / `tab-history-ui.test.mjs` | 新增消息协议断言 |
| `docs/autopilot/plans/editor-mode-backlog/checklist.md` | 修正 P0-1 的 `Depends on` 与 `Note` |

## 五、备选方案

| 方案 | 说明 | 取舍 |
|---|---|---|
| **直接用 `ctx.workspaceChanges`（本文推荐）** | Host 插件用 `ctx.get()` 拿服务 | 零 HTTP 转发、无新增鉴权面；**但要求该服务在本插件的 cordis 组合里可见**（已确认由 `dsh-web-app` 组成，见下） |
| 转发 `/api/changes.*` | 我们的 Host 代 Client 的 fetch 路由转发 | 需要复刻 DSH Client 的鉴权与坐标校验，多一层，不推荐 |
| 自己记录 before/after | 扩展监听文件变化自己存快照 | 与 DSH 已有能力重复，且拿不到「改动前」内容，不推荐 |

**服务可见性已核实**：`dsh-web-app/cordis.patch.yml:362-363` 组成了 `workspace-changes`，
与 `session-controller` 同属 web-app，因此我们的插件（依赖 `webServer`）能 `ctx.get('workspaceChanges')` 拿到。

## 六、风险与未知项

| 风险 | 影响 | 缓解 |
|---|---|---|
| `workspaceChanges.summary()` 只在**实时 recorder 存活期间**有数据 | 冷会话（重启后）可能返回 `undefined` | 端点返回 404 + 明确提示「该会话的改动记录已过期」，不假装空列表 |
| `diff()` 对超大/二进制文件返回 `oversized`/`binary` | 前端不能按 text 渲染 | 按 `kind` 分支，显示「文件过大/二进制，无法预览」 |
| DSH 版本升级改服务名或契约 | 端点失效 | 全部走 `ctx.get()` + 判空降级，不硬编码内部路径 |
| 调研报告里 Cursor / CodeBuddy 的未验证项 | 不能当结论 | 见 `ai-change-diff-review.md`（调研 agent 产出） |

## 七、验证标准（沿用清单）

1. 在真实 DSH 里让 Agent 改一个文件 → 编辑器侧栏出现「本轮改动 N 个文件」卡片
2. 点击某个文件能打开带 `+`/`-` 的对比视图
3. 离线用例覆盖：白名单放行、两个端点契约、503 降级、从历史折叠 changes 卡片
4. `node test/run-all.mjs` 全绿
5. 不引入临时文件泄漏、不把 token 传给 webview

## 八、需要拍板的 3 件事（已定）

1. **点击 diff 用 A 还是 B？** → 用户选 **B（原生 `vscode.diff`）**
2. **要不要做「冷会话无记录」的明确提示？** → 同意做
3. **是否同意修正清单 `Depends on`？** → 同意修正

---

## 九、实施结果（相对本方案的偏离与新增）

实施时比方案多做/改了几处，都来自实测发现问题，记录在此备查。

**采用 B 的代价与解法**：方案假设「用 DSH 的 hunks 直接喂原生 diff」，但实测
`workspaceChanges.diff()` 的 `before`/`after` 只是**布尔值**（该侧是否存在），
不回原文。原生 diff 需要两份完整文档，因此新增：

- `splitLines()`：按 DSH 的口径切行（只按 `\n` 切、保留 CRLF 的 `\r`）。
  口径不一致会让**所有 CRLF 文件**被误判成「被后续修改过」。
- `invertHunks()`：由「磁盘当前内容 + hunks」反推「改动前」内容。
- `hunksMatchContent()`：反推前先校验 hunks 与磁盘是否仍对齐。文件在该轮之后
  又被改过时**拒绝打开**并提示，而不是拼一份把两次改动混在一起的假 diff。

**方案里没预见到、实测才暴露的问题**：

| 问题 | 处理 |
|---|---|
| `workspace/changes` 被 `UI_EVENT_TYPES` 白名单过滤掉 | 加入白名单（事件只带 `{turn}`，文件列表另查） |
| `Number(null) === 0` 让缺失的 `seq`/`index` 绕过校验 | 抽 `nonNegativeInt()` 显式区分缺失/空/非法 |
| 改动卡片归属错误（事件晚于 `turn/end` 时挂到下一轮） | 折叠与实时两条路径都改为「回溯最近一条助手消息」 |
| 重连 `snapshot` 覆盖消息后 pending 卡片无人补全 | snapshot 分支也触发补全 |
| `history` 并发加载旧响应覆盖新列表 | 加 `historyGen` 代号 |
| 虚拟文档无限累积 | 上限 32 + 关闭释放 + 单调 key |
| `vscode.diff` 失败变成未处理的 Promise 拒绝 | 加 try + 用户可见提示 |

**验证**：隔离 DSH 实例实测（Agent 真改文件 → 事件到达 → summary/diff 返回真实
数据 → 反推的 before 与原始内容逐行一致）；离线用例 12 个全部覆盖实时与历史两条
链路，关键路径做过变异测验。
