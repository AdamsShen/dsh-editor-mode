# 与 Cursor / CodeBuddy 的能力缺口与待办

> 基线：本文件写于 2026-11-12，对照 `cursor-codebuddy-editor-implementation.md` 的调研结论
> 与当前仓库代码。所有「已有」都有代码位置，「没有」都做过全量搜索取证。
> 仓库原先没有 `docs/` 约定，故与调研报告一起新建 `docs/research/`。
>
> **2026-11-13 更新**：本文件写于「侧栏 Chat 改为 DSH 真实 Agent 会话」之前，
> 其中「纯模型对话 / AI 不能改代码 / MCP 会打破纯对话边界」等结论**已失效**，
> 正文相应位置已加注。当前进度与权威清单见
> `docs/autopilot/plans/editor-mode-backlog/checklist.md`。

## 一、一句话结论

~~**核心交互闭环（选 → 问 → 改 → 看）我们缺最后一环「看」**：现在是纯模型对话，
AI 不能改代码~~

> **⚠️ 上面这段已失效（2026-11-13）**：侧栏 Chat 现在**就是 DSH 真实 Agent 会话**，
> 能读文件、跑命令、改代码，与 Agents 模式共用同一条会话；「看」这一环也已补上
> （`workspace/changes` 事件 + 原生 `vscode.diff` 打开改动前后对比）。
> 下表里「本项目」一列的若干状态因此同样过期，以 checklist 为准。

**当前真实结论**：核心闭环（选 → 问 → 改 → 看）已经打通。剩余 10 项属于
上下文入口、规则注入、产品化（运行时自管、同源反代）、补全与索引等增量
（进度以 checklist 为准，此处数字会随清单推进而过期）。

## 二、逐项对照

| 能力 | Cursor | CodeBuddy | 本项目 | 状态 |
|---|---|---|---|---|
| AI 侧栏（webview 形态） | 未验证（无包体） | ✓ 左侧 activitybar | ✓ **左侧 + 右侧** 双容器 | ✅ 超出 |
| 流式输出 | 未验证 | SSE → RxJS → postMessage | SSE → postMessage | ✅ 持平 |
| 多轮 + 按项目持久化 | ✓ | ✓ | ✓ `workspaceState` | ✅ 持平 |
| 模型接入 | BYOK（仅 chat，Tab 仍内置） | 部分（`CustomModel` 开关） | ✓ **直接复用 DSH 全部 provider** | ✅ 更优 |
| 中止生成 | ✓ | ✓ | ✓ 本地 + 上游双 abort | ✅ 持平 |
| 当前文件 / 选区上下文 | ✓ | ✓ | ✓ 路径+行号+选区+语言+目录 | ✅ 持平 |
| 侧栏放右侧 | 未验证 | ✗（只用左侧） | ✓ `secondarySidebar` | ✅ 超出 |
| **`@` 引用**（文件/文件夹/符号） | ✓ | ✓ | ✗ | ❌ **待办 P1** |
| **资源管理器 / 终端右键加入对话** | 未验证 | ✓ 含终端选区 3 个专用命令 | ✗ 仅编辑器右键 | ❌ **待办 P1** |
| **项目规则文件** | `.cursor/rules/*.mdc` + `AGENTS.md` | `CODEBUDDY.md` → `.codebuddy/` → `AGENTS.md` | ✗ | ❌ **待办 P1** |
| **AI 改动 diff / 审核** | ✓ checkpoint 快照 | ✓ `genie-diff` + `vscode.changes` | ✗ | ❌ **待办 P0** |
| 文件被外部改动后刷新 | ✓ | ✓ | △ VS Code 自带 watcher 兜底 | ⚪ 靠平台 |
| Tab 补全 | ✓ 招牌能力 | ✓ `InlineCompletionItemProvider` | ✗ | ❌ 待办 P3 |
| NES（下一处编辑预测） | Tab 内含 jump-in-file | ✓ 独立 `nes.*` 命令族 | ✗ | ❌ 待办 P4 |
| 内联编辑 Cmd+K | **已废弃** → 改为「带选区开 Agent」 | ✓ `Ctrl+I` inlineChat | ✗（但已有「选中→发给 Agent」，方向一致） | ⚪ 不追 |
| codebase 语义索引 | ✓ 云端（Merkle + 服务端 embedding） | ✓ 本地 `codenexus` 进程 | ✗ | ❌ 待办 P3 |
| MCP 接入 | ✓ `mcp.json` | ✓ 自研 + 市场 | ✗ | ❌ 待办 P4 |
| 多窗口 | 未验证 | ✓ Electron 多 BrowserWindow | ✗ | ⛔ 不可做 |
| 用 VS Code 原生 Chat 扩展点 | 未验证 | ✗ 完全不用 | ✗ 不用 | ⚪ 路线一致 |

**计数**：待办 8 项（P0×1、P1×3、P3×2、P4×2）；不做 1 项（多窗口）；不追 1 项（Cmd+K）。

## 三、一个重要的战略判断

调研发现 **Cursor 已经把 Cmd+K 内联编辑废弃**，改为「选中代码 → 开 Agent」
（官方原文：*Cmd+K used to open inline edit, which has been replaced by this workflow*）。

这意味着我们现有的「**选中代码 → 发给 DSH Agents**」不是简陋版，而是**与 Cursor 现行方向一致**。
所以「内联编辑」这一项不需要追，省下最多工期。真正该补的是它后面的「**改动可见性**」。

## 四、待办清单（按优先级）

### P0 — 让 AI 改动可被看见（核心闭环缺口）

**问题**：点「→ Agents」后，DSH Agent 在磁盘上改文件。VS Code 自带 watcher 会把干净 buffer
重载（这点不用我们做），但用户**看不到改了什么**，也无法审阅/回退。两家竞品都把这做成核心。

**拟做**：
1. Agent 改动前后，用 `vscode.diff` 打开「原文件 ↔ 现文件」对比
2. 或在侧栏 Chat 里列出「本轮改动的文件」，点击打开 diff
3. 不做 checkout/restore（DSH 侧有 rewind 快照，不重复造）

**依据**：CodeBuddy 用 `vscode.diff` + 虚拟 scheme `genie-diff`/`agent-diff`；Cursor 用
`checkpoints/<requestId>/{metadata.json,files/,diffs/}`。
**我们的优势**：DSH 已有 rewind-git / rewind-snapshots，可以直接读快照做 diff，不必自建 checkpoint。
**估**：3–5 天。**风险**：需要先确认 DSH rewind 快照的可读性与触发时机。

### P1-1 — `@` 引用（文件 / 文件夹 / 符号）

**现状**：上下文只有「当前活动编辑器」，无法引用别的文件。
**拟做**：输入框支持 `@` 触发 VS Code 的 `showQuickPick`/`workspace.findFiles` 选文件；
选中的文件内容按预算截断后并进上下文。
**估**：2–3 天。**风险**：上下文预算控制（现在单条正文上限 `BRIDGE_TEXT_LIMIT=8000`，须与 Host 的 `BRIDGE_TEXT_MAX` 一致）。

### P1-2 — 更多上下文入口

**现状**：只有 `editor/context` 两个命令。
**拟做**：`explorer/context`（右键文件夹/文件加入对话）、终端选区命令。
CodeBuddy 有 `addToChat`(Ctrl+Alt+I) 挂在 editor/explorer/terminal 三处 + 终端三个专用命令。
**估**：0.5–1 天（纯 manifest + 少量代码）。

### P1-3 — 项目规则文件

**现状**：Chat 不知道项目约定（我们自己在 `.dsh/skills` 写的规范它读不到）。
**拟做**：发消息时读取 `AGENTS.md` → 项目根，注入 system prompt；按 DSH 既有优先级。
CodeBuddy 的优先级链是 `CODEBUDDY.md` → `.codebuddy/CODEBUDDY.md` → `AGENTS.md`。
**估**：1 天。**收益**：立刻让 Chat 遵守本项目规范，成本极低。

### P3-1 — Tab 补全（大工程）

**为什么排 P3 不是 P0**：它不是「能不能用」的问题，而是「像不像 Cursor」的问题；
且需要**低延迟链路**（我们现在的 `/editor-chat/send` 是走完整 LLM 推理 + SSE，延迟在秒级，
补全要求百毫秒级），要单独设计：debounce、上下文预算、取消、缓存、行内 ghost text。
CodeBuddy 的做法是 `registerInlineCompletionItemProvider({pattern:"**"})`，
上下文 = 光标前后文本 + 缩进链，预算 4000 tok / suffix 20% / 当前文件 200 行。
**估**：8–15 天（含延迟调优）。**前置**：需要一个低延迟模型端点。

### P3-2 — codebase 语义检索（大工程）

**两家分歧点**：Cursor 在云端（Merkle 树 → 上传 → 服务端 embedding），
CodeBuddy 在本地（`codenexus` 独立进程 + `127.0.0.1` HTTP）。
**我们的选择**：倾向**本地**——DSH 的定位是本地优先，且我们无权把用户代码传到第三方。
可先用 DSH 已有的 `grep`/`glob` 做「关键词检索」兜底，语义检索后置。
**估**：10–20 天（若自建索引）。**建议**：先做关键词检索版（2–3 天），语义版等需求确认。

### P4-1 — MCP 接入

**现状（2026-11-13 更新）**：Chat 已是真实 Agent 会话，**本来就带工具**，
「会打破纯对话边界」的顾虑不再成立。MCP 的价值变为「让会话接入 DSH 已有的 MCP 资源服务」。
**建议**：**先不单独给 Chat 加 MCP**，让「→ Agents」走 DSH 的 MCP 能力即可（DSH 已支持 MCP 资源服务）。
**估**：若真要做，5–8 天。

### P4-2 — NES（下一处编辑预测）

Cursor 把它融进 Tab；CodeBuddy 是独立 `nes.*` 命令族 + `enableNextEditSuggestions`。
依赖 Tab 补全的同一套低延迟链路。**建议排在 P3-1 之后**，估 8–12 天。

### ⛔ 不可做 / ⚪ 不追

- **多窗口**：DSH Electron 是单 `mainWindow` 架构，`setWindowOpenHandler` 明确拒绝新窗口。
  插件无法开出第二个窗口——这是 2026-11 已实测确认的结论，不是实现难度问题。
- **内联编辑 Cmd+K**：Cursor 自己已废弃，且我们的「选中→Agent」与之等价。

## 五、建议的推进顺序

```
P1-3 规则文件（1 天，立刻见效）
  ↓
P1-2 右键入口（1 天，纯增量）
  ↓
P1-1 @ 引用（2-3 天，上下文能力质变）
  ↓
P0   AI 改动 diff（3-5 天，补上核心闭环）
  ↓
—— 到这里，「能用」已经完整 ——
  ↓
P3-2' 关键词检索版 codebase 搜索（2-3 天）
  ↓
P3-1 Tab 补全（8-15 天，需先解决延迟）
  ↓
P4-2 NES（8-12 天）
  ↓
P3-2  语义索引 / P4-1 MCP（视需求）
```

前四项合计 **7–10 天**，就能把「选→问→改→看」闭环补齐，达到与 CodeBuddy 同级的可用度
（除 Tab 补全外）。

## 六、本文件未覆盖的

- 未验证 Cursor 内部实现（应用已从本机删除，无包体）——见调研报告第六节
- 未做 Continue / Cline 开源对照
- 工作量是**基于现有代码量的粗估**，未经工程拆解验证