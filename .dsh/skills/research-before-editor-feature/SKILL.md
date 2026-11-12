---
name: research-before-editor-feature
description: 为 DSH 编辑器能力做功能实现前，先调研业内同类实现并产出技术方案交用户判断；涉及编辑器内核集成、侧栏 Chat、选中代码联动、内联 diff、模式切换等改动时使用。小型改动可自行判断是否跳过调研。
alwaysApply: true
---

# 功能实现前先调研业内方案

本项目（dsh-editor-mode）给 **DeepSeek Harness（DSH）** 增加「编辑器模式」：
DSH 单窗口内切换 Agents 对话与内置 VS Code，并在编辑器侧栏提供用 DSH 自己模型驱动的 Chat。

**功能实现（新增能力、模块改造、交互变更）开始编码前**，原则上必须遵守以下流程。

---

## 流程

### 1. 联网调研

用调研类 skill 检索业内同类问题的实现方案。

**本机实际可用的调研工具**（通过 `skill` 工具加载，名字必须精确）：

| 用途 | Skill | 说明 |
|---|---|---|
| 一手来源调研（首选） | `research` | mattpocock/skills，795.5K 安装、MIT、零依赖。起后台 agent 读官方文档/源码/规范，逐条标出处，产出仓库内 md |
| 通用联网调研 | `agent-reach` | 覆盖中英文社区、技术博客、GitHub、社交/视频平台，15 个平台多后端路由 |
| 发现还有什么可用 | `find-skills` | 不确定有没有更合适的调研 skill 时先查（`npx skills find <关键词>`） |

**不存在时降级**：本机未安装 `Deep Research` / `Gemini Deep Research` / `research-analyzer` /
`github-search` / `RAG_search` 时，**不要**在方案里假装用过它们。直接用：

- `web_search`：快速事实、多个来源交叉
- `web_fetch`：需要读某篇文章/某个仓库 README 的完整内容

**选型实测记录（2026-11，避免重复调研）**：skills.sh 上安装量最高的「deep research」类
skill **基本都要第三方付费 API Key**，本机都没有，装了也跑不了：

| Skill | 安装量 | 阻断点 |
|---|---|---|
| `firecrawl/firecrawl-workflows@firecrawl-deep-research` | 36K | 需 Firecrawl API Key |
| `parallel-web/parallel-agent-skills@parallel-deep-research` | 16.1K | 需 `parallel-cli` + Parallel Key |
| `tavily-ai/skills@tavily-research` | 24K | 需 `tvly` + Tavily Key |
| `101-skills/superpowers@web-search` | 128K | 需 `belt`/inference.sh 账号；且同内容在 5 个 owner 下镜像，安装量不可信 |
| `199-biotechnologies/claude-deep-research-skill@deep-research` | 10.4K | 无需 Key（纯标准库），但要出正式报告时再装 |

另：`langchain-ai/deepagents@web-research` 在 skills.sh 有页面且标 3.9K 安装，但**上游仓库
并不存在该 skill**（只有 `textual-screenshot`），`npx skills use` 直接报 no matching skill。
**不要只看安装量就下结论，装之前先用 `npx skills use` 预览真实内容。**

**硬性要求**：

- 优先直接调用 skill 自带命令，不要先手工拼一堆 `web_search`。
- 调研结论必须来自**真实检索结果**，不得凭既有印象编造「业内做法」。
- skill 执行失败或无结果时，明确写「该方向未检索到有效资料」，不得用推测填充。
- 结果保留来源链接。

### 2. 归纳共性

对比 **至少 2–3 种**实现，归纳大多数方案采用的通用模式（架构分层、进程与生命周期管理、
状态同步、消息/事件模型、面板嵌入方式等），并注明：

- 与本项目现有约定的**兼容点**
- 与本项目现有约定的**冲突点**

### 3. 给出技术方案

方案至少包含：

1. **业内主流做法摘要**（附来源链接）
2. **本项目拟采用的设计**（与主流做法的异同及原因）
3. **涉及的文件与改动范围**
4. **备选方案**（如有，说明取舍）
5. **风险与未知项**

### 4. 等用户判断

方案先交给用户，**由用户判断是否实现、如何实现**。未获确认前不得动手写代码。

用户明确说「直接实现，不用调研」时才可跳过。

---

## 本项目实际技术栈（调研对标方向）

| 层 | 本项目 | 调研时对标 |
|---|---|---|
| 插件框架 | Cordis（`ctx.get`、`ctx.effect`、slots 体系） | VS Code Extension API、JetBrains 插件、Electron 插件宿主 |
| Host 侧 | Node/Electron 进程，`webServer.register` 挂路由 | 语言服务器、反向代理、子进程托管 |
| 编辑器内核 | code-server 4.145.2（VS Code Web） | VS Code Web/VSCodium、Monaco 独立嵌入、CodeMirror 6 |
| Client 侧 | React，`window.__ModuleLoader__` bundle | 各 IDE 的前端插件沙箱 |
| 面板嵌入 | 跨 origin iframe（直连回环） | Electron `<webview>`、同源反代、自定义 scheme |
| Chat 侧栏 | VS Code webview（`viewsContainers` + `type: webview`） | Cursor / CodeBuddy / Copilot Chat / Continue / Cline |

**编辑器能力是本项目的调研主战场**：编辑器内核集成、侧栏 Chat、选中代码 → Agent、
内联 diff、Agents/编辑器模式切换、进程托管与崩溃恢复。多 Agent 协作编排只在
「编辑器与 Agent 联调」相关时才顺带调研，不作为必查项。

---

## 豁免判断（小型改动）

以下情况**由 AI 自行判断**是否调研，可直接实现：

- 改动范围小（单文件或少数几个文件）
- 无设计取舍
- 不影响既有契约/接口/数据结构/用户可见行为

例：小型 bug 修复、文案调整、局部样式或参数微调、补测试。

**但**：涉及设计取舍或影响面扩大的，一律走完整调研流程。**拿不准时倾向于走调研**。

---

## 注意事项

- 方案陈述中用 `文件路径:行号` 定位现有代码，便于用户对照。
- 优先参考与上表技术栈相近、或被广泛验证的实现。
- 本项目已沉淀的关键教训（调研与方案时不要重蹈）：
  - DSH 的 Host 半边是 Cordis 插件，**服务依赖必须声明式**（`export const inject = ['webServer']`），
    在 `apply` 里直接 `throw` 会让该行永久不激活且被桌面端吞掉。
  - 改 `index.js`（Host）**必须重启 DSH**，热重载不会重新 import 主入口。
  - code-server 的多条 WebSocket 动态路径与 DSH `registerUpgrade`（仅 exact path）冲突，
    这是「同源反代」至今未做的根因。
