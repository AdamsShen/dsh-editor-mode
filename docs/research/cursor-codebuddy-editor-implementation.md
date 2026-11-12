# Cursor 与 CodeBuddy 编辑器 AI 实现调研

> 说明：本仓库原先没有 `docs` 约定，故新建 `docs/research/` 存放本次调研。
>
> **调研时间**：2026-11-12（Asia/Shanghai）
>
> **来源范围**：① 本机已安装 **CodeBuddy CN** 产物的真实文件（最硬证据，优先于文档）；② 本机 **Cursor 遗留数据目录**（`/Applications/Cursor.app` 已被删除，但 `~/Library/Application Support/Cursor` 与 `~/.cursor` 完整保留，仍属一手证据）；③ 本机 VS Code 内核（code-server 打包的 vscode 1.145.2）源码；④ Cursor 官方文档 / 官方博客；⑤ VS Code 官方 Extension API（以内核源码为准）。
>
> **证据标注约定**：
> - 本地文件：`绝对路径:行号`。压缩后的 JS bundle（CodeBuddy 的 `out/extension/index.js` 是 84 行、首行约 3.87 MB 的 minified 产物）行号意义有限，故额外给出**字节偏移**与**可直接 grep 命中的字符串**，便于复现。
> - 在线文档：完整 URL，并注明实际抓取成功的 URL（发生重定向会显式说明）。
> - **未验证**项集中在「六、未验证 / 存疑项」，不混入结论。
> - 本调研**全程只读**，未启动任何被调研应用，未执行其代码。

**关于版本时效的声明**：抓取时 cursor.com 的文档与定价页已更新到 2026 年形态（模型列表含 Grok 4.7 / Composer 2.5、订阅为 "The X Subscription"）。因此凡是「Cmd+K 内联编辑已废弃」这类与旧认知冲突的结论，都是**当前官网原文**，不是我的推断。

---

## 一、结论摘要

1. **CodeBuddy 的 AI 是一个被 `builtInExtensions` 钉死的内置扩展，不是内核改造**：`product.json` 的 `builtInExtensions` 里显式写了 `{name:"genie", version:"0.2.4", repo:"https://github.com/tencent/coding-copilot"}`；扩展包名 `coding-copilot`，publisher `Tencent-Cloud`，随包实际版本 `3.10.0`，`activationEvents: ["*"]`。（`/Applications/CodeBuddy CN.app/Contents/Resources/app/product.json:103` 起；`.../extensions/genie/package.json:3-7,46-52`）
2. **侧栏是"平台原生容器 + 自有 webview"**：`viewsContainers.activitybar` 放**左侧活动栏**（容器 id `coding-copilot-chat`），`views` 用 `type: "webview"`（视图 id `coding-copilot.webviews.chat`）。**没有**放到右侧 `secondarySidebar`——尽管 VS Code 本身支持该位置。（`.../genie/package.json:73-89`；`workbench.js:1224`）
3. **CodeBuddy 完全不用 VS Code 原生 AI 扩展点**：`contributes` 中没有 `chatParticipants` / `chatAgents` / `languageModelTools` / `languageModelChatProviders` / `mcpServerDefinitionProviders`；Chat、Inline Chat、MCP、Skills、补全全部自研。对比之下这些扩展点在 VS Code 内核里都真实存在。（`.../genie/package.json` contributes 键集合；`workbench.js:657,705,714,3010`）
4. **CodeBuddy 的 webview 通信是「自研 JSON-RPC 代理 + 少量明文消息」两层**：业务走 `RPCProviderImpl` → `RPCImpl.getProxy(服务Symbol)`（通道号 `ch1`、`ch2`…，日志前缀 `[json-rpc]`），另有 9 个 `{type:"..."}` 常量专管启动/心跳/加载重试。（`.../out/extension/index.js` 偏移 2480902、9893758、6583056）
5. **CodeBuddy 的代码库索引在本地**：由独立 `codenexus` 进程提供，扩展通过 `http://127.0.0.1:<port>` 访问（`new HttpClient({baseURL: ...})`），有 `codebaseIndex(fsPaths, force)`、文件数上限、状态轮询、僵尸进程清理。**Cursor 相反：索引在服务端**——客户端算 Merkle 树，把文件上送到服务端做 embedding，并用 simhash 在服务端向量库复用同事索引。（`.../index.js` 偏移 8299087；https://cursor.com/blog/secure-codebase-indexing）
6. **CodeBuddy 的 AI 改动可视化走 `vscode.diff` + 自定义虚拟文档 scheme**（`genie-diff` / `agent-diff`），多文件走 `vscode.changes` / `_workbench.changes`；Cursor 走**本地 checkpoint 快照**（每个请求一个 `checkpoints/<agentRequestId>/`，内含 `metadata.json` + `files/` + `diffs/`），两者都不靠"静默 WorkspaceEdit"。（`.../index.js` 偏移 4949125、623489、8074541；`~/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-retrieval/checkpoints/`）
7. **Cursor 的 Cmd+K 内联编辑已被官方废弃**：官网原文「Cmd+K used to open inline edit, which has been replaced by this workflow」——现在 Cmd+K / Cmd+L 是"把选中代码带进 Agent 面板"；Agent 面板快捷键是 **Cmd+I / Ctrl+I**。（https://cursor.com/help/ai-features/agent，由 `/help/ai-features/inline-edit` 重定向而来）
8. **Tab 补全与 NES 在两家都是平台 inline 补全机制的产物**：CodeBuddy 用 `registerInlineCompletionItemProvider({pattern:"**"})` + Tab/ESC 的 `when: inlineSuggestionVisible`；Cursor Tab 是同名交互（灰字、Tab 接受、Esc 拒绝、Ctrl+→ 逐词接受、jump-in-file、跨文件 portal），但 Cursor 的实现细节无本地产物可验，仅有官方文档。（`.../index.js` 偏移 10864146；https://cursor.com/help/ai-features/tab）

---

## 二、CodeBuddy 实现（本地产物为证）

### 2.0 安装形态与"如何被强制启用"

- 真实安装只有一处：`/Applications/CodeBuddy CN.app`。另一个 `/Applications/CodeBuddy.app` 是**空壳**（`Contents` 下无内容），且不存在 `/Applications/CodeBuddy.app/Contents/Resources/app/extensions/`。
- 应用身份：`name: "CodeBuddy CN"`、`version: "1.106.1"`、`main: "./out/main.js"`；`out/main.js` 中 `BrowserWindow` 命中 42 次、`openNewWindow` 2 次 → Electron 多窗口。（`/Applications/CodeBuddy CN.app/Contents/Resources/app/package.json`）
- **强制启用方式 = `builtInExtensions`**（这就是"类似 product.json 的 builtInExtensions"的答案）：

```json
// /Applications/CodeBuddy CN.app/Contents/Resources/app/product.json:103 起
"builtInExtensions": [ ... ,
  { "name": "genie", "version": "0.2.4",
    "repo": "https://github.com/tencent/coding-copilot",
    "metadata": { "id": "Tencent-Cloud",
      "publisherId": { "publisherId": "tencent-cloud", "publisherName": "Tencent-Cloud" } } } ]
```

  即：`genie` 被钉在 `0.2.4`，来源仓库 `tencent/coding-copilot`，publisher 已验证。注意**磁盘上的 `package.json` 版本是 `3.10.0`**，与 product.json 里钉的 `0.2.4` 不一致——说明 product.json 的 `version` 字段在此构建里不用于校验（**未验证**其确切语义，见第六节）。
- 同一 `product.json`：`version: "1.106.1"`、`commit: "b4c35ed08ffb428910211608831a314565c1256e"`、`date: "2026-09-04T17:20:23.326Z"`、`quality: "stable"`，`extensionsGallery` 指向 **open-vsx.org**（不是微软 marketplace）。
- 端点：`/Applications/CodeBuddy CN.app/Contents/Resources/app/product-ide-cn.json:250` → `"genieEndpoint": "https://copilot.tencent.com"`。
- `genie` 扩展**自带一份 305 KB / 984 行的 `product.json`**，是产品行为的真正配置源，运行时通过虚拟只读文档 `codebuddy:/product.json` 暴露（`PRODUCT_SCHEME="codebuddy"`，`out/extension/index.js` 行 69，偏移 17776421）。这意味着配置可被服务端下发覆盖（`ProductManager` 有 `onDidChange`）。

### 2.1 扩展清单与贡献点

`/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/package.json`

| 项 | 值 | 行号 |
|---|---|---|
| `name` | `coding-copilot` | 3 |
| `publisher` | `Tencent-Cloud` | 4 |
| `version` | `3.10.0` | 7 |
| `activationEvents` | `["*"]` | 46-47 |
| `main` | `out/extension/index.js` | 52 |
| `enabledApiProposals` | `inlineCompletionsAdditions`, `findFiles2`, `terminalSelection`, `findTextInFiles`, `terminalExecuteCommandEvent`, `textDocumentChangeReason`, `extensionsAny` | 54-62 |
| `capabilities` | `{"codeActionProvider": "true"}` | 63 附近 |
| `contributes` 键集合 | `authentication`, `viewsContainers`, `views`, `icons`, `iconFonts`, `submenus`, `commands`(36 个), `keybindings`(12 个), `configuration`(32 个属性), `menus` | 67 起 |

**关键否定结论**：`contributes` 中**不存在** `languageModelTools`、`languageModelToolSets`、`chatParticipants`、`chatAgents`、`chatSessions`、`chatPromptFiles`、`chatSkills`、`mcpServerDefinitionProviders`、`languageModelChatProviders`。即 CodeBuddy 没有使用 VS Code 1.9x 引入的任何原生 Chat / LM / MCP 扩展点。

`authentication`（`:67`）注册了自有认证 provider：`{"label":"TencentCloud","id":"codingcopilot"}`，并用 `productFeatures.UseNativeAuth/VSCodeAuthProvider` 控制是否走原生 Auth API。

`enabledApiProposals` 中唯一与 AI 直接相关的是 `inlineCompletionsAdditions`，用途是**部分接受补全**（`handleDidPartiallyAcceptCompletionItem`，见 2.4）。

内部拆分体现在 `dependencies`（均为 `0.0.0` 私有包）：`@genie/plugin-completion`、`@genie/agent-inline-chat`、`@genie/agent-core`、`@genie/agent-remote`、`@genie/agent-terminal`、`@genie/agent-scm`、`@genie/context`、`@genie/knowledge-base`、`@genie/models`、`@genie/enterprise-policy`、`@genie/plugin-chat`。

### 2.2 侧栏注册方式

```json
// /Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/package.json:73-90
"viewsContainers": {
  "activitybar": [
    { "id": "coding-copilot-chat", "title": "CodeBuddy", "icon": "resources/copilot.svg" }
  ]
},
"views": {
  "coding-copilot-chat": [
    { "id": "coding-copilot.webviews.chat", "name": "", "type": "webview", "initialSize": 1 }
  ]
}
```

- **容器 id**：`coding-copilot-chat`
- **视图 id**：`coding-copilot.webviews.chat`
- 形态：`activitybar`（左侧）+ `type: "webview"`，**不是**原生 tree，**不是**原生 chat，**没有**用 `secondarySidebar`（右侧）。
- 运行时注册（`out/extension/index.js` 行 66，偏移 16261224）：
  `window.registerWebviewViewProvider(CHAT_VIEW_ID, this, { webviewOptions: { retainContextWhenHidden: true } })`
- 常量定义（`out/extension/index.js` 行 10，偏移 6583056）：
  `CHAT_WEBVIEW_TYPE = "coding-copilot.webviews.chat"`、`CHAT_WEBVIEW_TITLE = "CodeBuddy"`；
  另有 `PLUGIN_MARKETPLACE_WEBVIEW_TYPE = "coding-copilot.webviews.pluginMarketplace"`（标题 `CodeBuddy Market`），走 `createWebviewPanel`，是**编辑器标签页**形态而非侧栏（偏移 1091805）。
- 视图标题栏按钮：`view/title` 菜单挂了 `startNewChat`、`chatHistory`、`codebuddy.settings.show`、`copy.userID`、`logout` 等，`when: view == coding-copilot.webviews.chat`。
- 同一份 webview UI 复用到非 VS Code 宿主。代码注释明确写了通道解析优先级（`out/extension/index.js` 偏移 10946401 附近）：
  > `window.vs`（已缓存）→ `acquireVsCodeApi()`（VS Code 容器注入）→ `window.parent`（JetBrains/JCEF 由 Java 注入的 bridge；Visual Studio/WebView2 同理）

  注释还提到 issue #96585：通道解析必须惰性且排在 `addEventListener` 之后，否则 JCEF 下按钮变死像素。

### 2.3 消息与流式

**分层结论**：不是"一堆裸 message type"，而是「一层自研 JSON-RPC 代理（业务） + 9 个明文消息（生命周期）」。

#### (1) RPC 层（业务）

- 依赖注入容器绑定 `MessageConnection`，`RPCProviderImpl.provide()` 用它构造 `RPCImpl`；`MessageConnection` 未注入时直接抛错。（`out/extension/index.js` 行 1，偏移 2480902）
- 服务用 `Symbol` 标识，通过 `impl.getProxy(服务Symbol)` 得到强类型代理；`RPCImpl` 构造时取 `nextRpcChannelId()`（生成 `ch1`、`ch2`…）并 `registerRpcChannel({impl, channel})`；日志前缀 `[json-rpc]`。底层是 vscode-jsonrpc 风格的 `createProxyIdentifier`（`IdentifierUtils`）。（偏移 315437 / 9893758）
- 服务符号清单（偏移 13750462）：`ChatService`、`ChatStreamReceiver`、`ChatViewService`、`MigurationSettingService`、`FileTreeService`、`CheckpointViewService`、`ActivityViewService`、`PlanTaskViewService`、`AgentDispatcher`、`ToolService`、`CheckpointService`、`FileService`、`PlanTaskService`、`ImageService`、`BillingService`、`FCPTraceService`。两侧各持一半，是对称服务。
- 真实调用示例：
  - `requireChatRpc(provider).getProxy(ChatViewService).activatePage({path:"/settings", state:{tabKey}})`
  - `.clear()`
  - `.activatePage({path:"/", action:{timestamp, extra:{prefillOnly:true, prefillContentBlocks}}})`
  （偏移 9610646、16264705、1677733 附近）
- 通道有明确的**就绪/重建状态机**：`ensureRpc()`、`forceResolveWithRetry()`、`waitUntilRpcReady()`、`needsChannelRebuild()`、`rebuildChannel()`、`decideChannelRebuild()`、`CHANNEL_REBUILD_MAX_ATTEMPTS`、`lastChannelRebuildAt`、`channelRebuildAttempts`，失败会 `reportChannelRebuildExhausted`。（偏移 16264705 起）
  这说明它不是一次性 `postMessage`，而是带重连/节流/去重的**会话通道**。

#### (2) 明文消息层（启动 / 存活）

全部 9 个常量（`out/extension/index.js` 行 10，偏移 6583056 起）：

| 常量 | 字面值 |
|---|---|
| `CHAT_WEBVIEW_BOOT_NOTICE_MESSAGE_TYPE` | `__cb_boot_notice__` |
| `CHAT_WEBVIEW_PAGE_SCRIPT_READY_ACK_MESSAGE_TYPE` | `__cb_page_script_ready_ack__` |
| `CHAT_WEBVIEW_WAKE_MESSAGE_TYPE` | `__cb_first_frame_wake__` |
| `CHAT_WEBVIEW_HEARTBEAT_MESSAGE_TYPE` | `genie-chat-webview-heartbeat` |
| `CHAT_WEBVIEW_LOAD_RETRY_MESSAGE_TYPE` | `genie-chat-load-retry` |
| `CHAT_WEBVIEW_LOAD_RETRY_ARMED_MESSAGE_TYPE` | `genie-chat-load-retry-armed` |
| `CHAT_WEBVIEW_PAGE_RESOURCE_LOAD_FAILED_MESSAGE_TYPE` | `genie-chat-page-resource-load-failed` |
| `PLUGIN_MARKETPLACE_VISIBILITY_MESSAGE_TYPE` | `plugin-marketplace-visibility` |
| `PLUGIN_MARKETPLACE_RESOURCE_CHANGED_MESSAGE_TYPE` | `plugin-marketplace-resource-changed` |

形式为 `{type:"..."}`，例如 `onDidReceiveMessage(m => { if (m && m.type === "queryLicenseExpired") ... })`（偏移 1520897 附近）。方向双向，载体仍是 `webview.postMessage` / `acquireVsCodeApi().postMessage`。

#### (3) 流式约定

- **模型侧**：打包 Vercel AI SDK —— `streamText`（22 次）、`generateText`（7 次）、`openaiCompatibleProvider`、`createNormalizedFetch`、`normalizeOpenAICompatibleSseDataLine`（`out/extension/index.js` 行 1，偏移 3722838）。即 **OpenAI 兼容 HTTP + SSE**，逐行解析 `data:`。
- **Agent 侧**：`AgentDispatcher.dispatch(...)` 返回 **RxJS Observable**，消费方 `subscribe({next, error, complete})`。
- **内联聊天落到编辑器**：`InlineChatIDEServiceImpl.request()` 里
  `...dispatch({agent:"inline-chat", agentContext:{variables:[{name:"userContext", value:{input, activeCode, language}}, {name:"systemInfo", value}]}})`
  然后 `ar.subscribe({next: chunk => { 累加文本; ir.stream?.write(nn) }, error, complete: () => ir.stream?.end()})`。（偏移 9805142）
- 三段式总结：**模型 SSE → 扩展内 Observable → 通过 RPC/回调推给 webview，或 `stream.write()` 写进编辑器侧的流**。

#### (4) 前端产物

`out/webviews/`（16 MB），入口 `out/webviews/index.html`；分包形如 `runtime.c555fa378f7653ed4d03.js`、`components.ebc7c804.chunk.js`、`runtime-shims.*.js`、`vendors-mermaid.*`、`vendors-katex.*`、`vendors-hljs.*` → React + Mermaid + KaTeX + highlight.js 技术栈。

### 2.4 上下文与编辑回写

#### (a) Tab 补全 / NES —— 用平台 `InlineCompletionItemProvider`

- 注册：`vscode.languages.registerInlineCompletionItemProvider({pattern:"**"}, this)`，实现 `provideInlineCompletionItems`。存在两个实现：
  - 标准路径：`if (!ProposalsUtils.enabled())` 时注册（偏移 10864146）
  - proposed 路径：`if (ProposalsUtils.enabled())` 时注册（`InlineCompletionProposedProviderImpl`，偏移 19664791）
- 请求上下文对象字段（偏移 10864146 附近，随请求下发）：
  `textBeforeCursor`、`textAfterCursor`、`intent`、`indent`、`parentIndent`、`nextIndent`、`nextLine`、`preIndent`、`preLine`、`prefetching`、`trace`、`position`、`document`、`partiallyPrefix`、`partiallyTelemetryId`
  → 取**光标前后文本 + 缩进/换行结构**，不是整文件。
- 上下文预算（`.../genie/product.json:524-535`）：
  `sensitivity: "medium"`、`maxInputTokens: 4000`、`maxInputCharacters: 10000`、`suffixPercent: 0.2`（后缀只占 20%）、`currentFileMaxLines: 200`、`nesPredictionMaxLines: 4`、`stopWords: ["\n\n", "// "]`。
- 部分接受来自 proposal `inlineCompletionsAdditions`：`handleDidPartiallyAcceptCompletionItem`（偏移 19664791）。
- 键位（`package.json` keybindings 段）：

  | 命令 | 键 | when |
  |---|---|---|
  | `completions.accept.all` | `tab` | `... && inlineSuggestionVisible && !editorTabMovesFocus && ...` |
  | `completions.accept.line` | `ctrl+down` | `editorTextFocus && !editorReadonly && inlineSuggestionVisible` |
  | `completions.accept.word` | `ctrl+right` | 同上 |
  | `completions.dismiss` | `escape` | 同上 |
  | `completions.trigger` | `alt+\` | `editorTextFocus && !editorReadonly` |
  | `nes.accept.all` | `tab` | `codingcopilot.predictionShow` |
  | `nes.dismiss` | `escape` | `codingcopilot.predictionShow` |
  | `nes.trigger` | `ctrl+shift+enter` | — |

- 开关：`codingcopilot.enableNextEditSuggestions`（默认 `true`）、`enableAutoCompletions`、`enableCompletionLanguage`、`generationPreference`（`intelligentMode` / `oneLineMode`，后者"每次只生成一行"）、`selectedCompletionModel`；对应 `productFeatures`: `InlineCompletions: true`、`NesCompletions: true`、`NesCompletionsPrefetching: true`、`CursorPositonPrefetching: true`、`CompletionsPrefetching: true`、`NESNativeRenderer: true`、`CompletionsRelatedSnippets: true`、`MultiStepCompletions: true`。

#### (b) 内联编辑（Cmd+K 类 = `⌘+I`）

- **独立命令**：`tencentcloud.codingcopilot.ide.inlineChat.start`，title `开始 IDE 内联聊天`，键位 `ctrl+i`，`when: editorTextFocus`。（`package.json:408-409`；`package.nls.zh-cn.json:29`）
- macOS 上按 VS Code 的 `ctrl→cmd` 约定显示为 `⌘+I`，代码内也硬编码了提示文案：
  `"darwin"===process.platform ? "⌘+I" : "Ctrl+I"`，`getAddToChatShortcutText()` 为 `Ctrl+⌘+I`（偏移 1517393）。
- **不用** VS Code 原生 Inline Chat，自研一整套类：
  `InlineChatIDE`、`InlineChatIDEService`、`InlineChatIDEProvider`、`InlineChatIDEDecorationProvider`、`InlineChatPromptProvider`、`InlineChatIntentRecognition`、`InlineChatAcceptCommand`、`InlineChatRejectCommand`、`InlineChatRetryCommand`（另有 `*NearCommand` 变体）。
- **输入提示用装饰器渲染幽灵文本**（这就是"是否用装饰器"的答案）：
  `window.createTextEditorDecorationType({ isWholeLine: true, after: { color: new ThemeColor("editorGhostText.foreground"), margin: "0 0 0 1em", fontStyle: "italic" } })`，文案 `"⌘+I to Inline Chat, Ctrl+⌘+I to Add to Chat"` / `"⌘+I to Edit Selection, ..."`（偏移 1517393）。
- 生成走 `inline-chat` agent（见 2.3 第 3 点）。
- 配置：`enableInlineChat`（默认 `true`）、`enableInlineChatAutoFormatCode`、`enableInlineChatShortcutsTip`、`enableInlineChatIDEShortcutsTip`、`toolbarOnSelection`（默认 `false`，"选中文本时显示工具栏"）；`productFeatures`: `InlineChatIDE: true`、`InlineChat: false`。（`package.nls.zh-cn.json:58-62`；`product.json:815`）

#### (c) 上下文注入

- **项目记忆 / 规则文件**按固定顺序读取并包进 `<project_guidance>`（`getProjectGuidance`，`out/extension/index.js` 行 66，偏移 13383374）：
  1. `CODEBUDDY.md`
  2. `.codebuddy/CODEBUDDY.md`
  3. `AGENTS.md`

  > <project_guidance>
  > The project guidance below is generated by the CodeBuddy IDE's AI after scanning the entire project and is stored in the workspace root <file>.
  > ...
  > </project_guidance>

- 其它结构化上下文块：`<git_status>`（默认截断 1500 字符，超出写 `[... Result too long, omitted]`）、`<project_structure>`；规则相关有 `<rules>`、`<always_applied_user_rules>`、`<always_applied_integration_rules>`，配 `read_rules` / `read_rules_result` 工具与 `rules_triggered` 事件；命令 `tencentcloud.codingcopilot.rules.manage`（"规则管理"）与 `rules.show`。
- **技能/规则扫描目录**（`.../genie/product.json:910`，`skillScanDirs`）：`.codebuddy`、`.workbuddy`、`.claude`、`.agents`、`.openclaw`。
- **选中代码入上下文**：命令 `tencentcloud.codingcopilot.addToChat`（`Ctrl+Alt+I`，title"添加到 CodeBuddy 对话"），挂在 `editor/context`、`editor/title/context`、`explorer/context`；终端选中另有 `addTerminalSelectionToChat` / `explainTerminalSelection` / `fixTerminalSelection`（`terminal/context`，键位 `ctrl+alt+i` when `terminalFocus && codingcopilot.authenticated`）。
- **代码库语义检索**：工具 `codebase_search`，metadata 明确写 "semantic search that finds code by meaning, not exact text"，参数 `query` / `path`（绝对路径）/ `limit`（默认 10，上限 100），`riskLevel:"low"`、`type:"read"`；`fullExecute` 转调 `codebaseManager.codebaseSearch(query, path, limit)` 并回 `type:"codebase_search_result"`。（偏移 15674283）
- **索引本地还是云端 → 本地**，证据链：
  - `CodenexusManager` 用 `new HttpClient({ baseURL: "http://127.0.0.1:" + port })` 访问本机回环服务，`codebaseIndex(fsPaths, force)` 走同一客户端；有 `_codenexusEnabled` 灰度开关、`_codenexusInitPromise`、`startIndexPolling`、`DEFAULT_INDEX_SLEEP_TIME`、`DEFAULT_INDEX_WORKSPACE_MAX_FILES_NUM`（文件数超限则跳过索引并记录 `_expectedNotIndexReason`）。（`out/extension/index.js` 行 10，偏移 8299087 起）
  - 进程管理痕迹：`findCodenexusProcesses`、`pgrep -f codenexus`、`killZombieCodenexusProcesses`、`codenexus.exe`（Windows）、`codenexusPort` 相关逻辑。
  - 本地 AST 能力：`out/extension/wasm/` 有 `tree-sitter.wasm` + `tree-sitter-{c,cpp,go,java,javascript,python,ruby,tsx,typescript}.wasm`。
- **本地库痕迹**：bundle 内 `sqlite` 命中 23 次（含 SQLite 相关字符串），但**"语义索引是否用本地向量库"未验证**（我没有找到可确证的向量库落盘路径；`codebaseIndex` 只是把文件路径交给本地 codenexus 进程）。见第六节。
- 索引就绪门控：`isCodebaseReady` 为真且 `productFeatures.DisableCodebase` 为假时才注册 `CODEBASE_SEARCH` 工具（偏移 1677733）。
- 设置项自述："启用代码库搜索工具。启用后，Agent 可以使用语义搜索在整个代码库中查找相关代码。"（`package.nls.zh-cn.json:97`）；`codingcopilot.enableLsp` 同理（"Agent 可以使用跳转定义、查找引用等语言智能功能"）。
- 工具注册表全貌（偏移 1677733，按 `productFeatures` 条件注册）：`SEARCH_CONTENT`(rg)、`WRITE_TO_FILE`、`REPLACE_IN_FILE`、`DELETE_FILES`、`EXECUTE_COMMAND`、`CONNECT_CLOUD_SERVICE`、`PREVIEW_URL`、`WEB_FETCH`、`USE_SKILL`、`READ_RULES`、`WEB_SEARCH`、`CODEBASE_SEARCH`、MCP 资源读取。

#### (d) AI 改动回写编辑器

- **评审视图 = `vscode.diff` + 自定义虚拟文档 scheme**（不是写临时文件）：
  - scheme 常量：`DIFF_VIEW_URI_SCHEME = "genie-diff"`（偏移 4949125）、`DIFF_URI_SCHEME = "agent-diff"`（偏移 17798951）、`GENIE_DIFF_URI_SCHEME = "genie-diff"`（偏移 18876124）、`IMAGE_ASSET_REF_SCHEME = "codebuddy-asset://"`、`AUTO_DIFF_PATH_PREFIX = "auto/"`（偏移 14551359）。
  - 打开逻辑（偏移 623489）：构造
    `vscode.Uri.parse(`${SCHEME}:${path}`).with({ query: base64(原始内容), fragment: fsPath })`
    后 `commands.executeCommand("vscode.diff", 原始Uri, 修改后Uri, `${name}: ${l10n.t("Original ↔ Changes")}`)`，并监听 `onDidChangeActiveTextEditor` 等目标编辑器，**10 秒超时**报错。
  - 原始内容由 `workspace.registerTextDocumentContentProvider(scheme, provider)` 提供（3 处注册：偏移 1140521、17776717、18876254）。其中 `17776717` 那处是 `PRODUCT_SCHEME = "codebuddy"` 的 `codebuddy:/product.json`；`1140521` 那处是 Plan 模式的 `ReadonlyPlanProvider`（`/PLAN.md`，把 plan md + todolist 合成虚拟文档）。
- **多文件改动走平台多文件 diff**（偏移 8074541）：
  优先 `_workbench.changes` → 回退 `vscode.changes` → 再回退自实现 `executeChangesCompat`（单文件直接 `vscode.diff`；多文件先弹 QuickPick 让用户选文件，`label: $(diff) <文件名>`，`description: 相对路径`）。
- **Accept / Reject**：内联聊天有独立 `InlineChatAcceptCommand` / `InlineChatRejectCommand` / `InlineChatRetryCommand`；落盘侧有 `CheckpointService` / `CheckpointViewService`（检查点，用于回滚）。
- **写文件工具双实现**（按 `productFeatures.WriteAndReplaceToolIDE` 切换，偏移 1677733）：
  真 → `IDEWriteToFileTool` / `IDEReplaceInFileTool`；假 → `PluginWriteToFileTool` / `PluginReplaceFileTool`。即"IDE 内语义化编辑"与"纯文件写"两套。
- `WorkspaceEdit` + `workspace.applyEdit` 确实在用（`WorkspaceEdit` 命中 6 次、`applyEdit` 17 次，偏移 624846 / 624998），用于常规编辑落地；**可视化的 AI 改动审核**用上面的 diff 方案。

#### (e) 模型接入

- 网关：`product.json:430-432` → `productName: "CodeBuddy"`、`endpoint: "https://copilot.tencent.com"`、`stagingEndpoint`、`deploymentType: "SaaS"`；`getEndPoint()` 返回 `ProductManager.getEndpoint() + "/v2"`，UA 为 `CodeBuddyIDE/<version>`（偏移 5638168）。
- 协议：**OpenAI 兼容**（Vercel AI SDK 的 `doGenerate` 打 `url({path:"/chat/completions"})`，偏移 6751462；SSE 行规范化函数见 2.3）。
- 内置模型清单随包发布（`product.json:262` 起，共 10 条）：`Claude-3.7-Sonnet`(`default-1.1`)、`Claude-4.0-Sonnet`(`default-1.2`, 200k 输入/24k 输出)、`Kimi-K2`、`hunyuan-3b`、`hunyuan-7b-dense`、`codewise-7b-021`、`codewise-navi-v1-2-taco`、`codewise-nes-a4-005-taco`、`completion-gf`、`Hunyuan Image V3`；`vendor` 为不透明单字母（`e` / `f` / `j` / `tencent`）。
- **BYOK 的真实形态**：`productFeatures.CustomModel` 为真时注入可配置模型模板
  `[{ id: "deepseek", name: "deepseek", vendor: "user", configurable: true }]`，
  并从 `extensionContext.globalState` 的 `ModelSettingsKey` 读回：`apiKey`、`baseUri`、`model`、`type`；`ollama` 分支只用 `baseUri` + `model`（本地模型）。（偏移 3142022）
- 判定"用户自定义模型"：`"user" === model.vendor || !!model.configurable || tags.includes(...)`；自定义模型 key 错误有专用错误码 `AGENT_INVALID_API_KEY_ERROR`（偏移 3530821、40545 附近）。
- 企业策略开关：`EnableEnterpriseCustomModelPolicy`、`CustomModelsJSON`、`CustomModelIdPrefix`、`EnableEnterpriseSkillUploadPolicy`、`EnableLicenseExpirationCheck`。
- **没有** `languageModelChatProviders` 之类原生贡献点；模型接入完全在扩展内部实现。

#### (f) MCP / Skills / 子代理

- **MCP 自研**：命令 `tencentcloud.codingcopilot.mcpMarket`（`MCP 市场`，`package.nls.zh-cn.json:21`）、`McpRegisterServerCommand` / `McpUnregisterServerCommand`；`config.mcpSchemaUrl = "codebuddycn://codebuddy-ide/mcp"`（自定义 URL scheme 用于一键安装，`product.json:493`）；`productFeatures.DynamicAddWebSearch`、`McpUnregisterServerCommand` 等。
- 依赖官方 MCP SDK（`request({method:"tasks/get"})`、`tasks/result`、`tasks/list`、`tasks/cancel` 等，偏移 4939390 附近）。
- 内置 4 个 integration-mcp 包：`integration-mcp/{anydev,eop,tcb,lighthouse}`。
- **Skills**：`productFeatures.Skills`、`USE_SKILL` 工具、`builtInSkillMarketplaces`、`builtInMarketPlugins`(9)、`skillScanDirs`(5)、`SkillSecurityScan` + `skillSecurityAppKey`；内置技能实体在 `out/extension/builtin/`（`buddy-multimodal-generation`、`lsp-code-analysis`、`skill-creator`）与 `out/extension/wecom-skills/`（企业微信相关）。
- **子代理**：`product.json:883` `builtInSubagents` 内置 `code-explorer`，其 YAML front matter：
  `tools: search_file, search_content, read_file, list_files, read_lints, codebase_search, lsp`、`agentMode: agentic`、`enabledAutoRun: true`。
- **Agent 角色**（`product.json:44` `agents`，14 个）：`craft`(13 工具)、`ask`(6 工具)、`plan`(13 工具)、`CodeCompletion`、`CodeCompletionNes`、`CommitMessage`、`RemoteAgentProxy`、`InlineChat`、`agent`、`chat`、`enhance prompt`、`generate title`、`inline-chat`（`product.json:244`）、`terminal`。
- `tools` 段内置 `semantic_search`（`product.json` 中 `tools` 仅 1 条，描述为自然语言检索工作区代码/注释）。

### 2.5 多窗口

- Electron 多窗口确认：`out/main.js` 中 `BrowserWindow` 42 次、`openNewWindow` 2 次；app `package.json` 的 `main: "./out/main.js"`。
- 会话可开独立窗口：命令 `tencentcloud.codingcopilot.chat.newWindowOpen`（`%command.chat.newWindowOpen%`）+ 服务符号 `NewWindowOpenChatService` + `ChatWebviewPanelManagerImpl.create()` 里的 `window.createWebviewPanel(viewType, title, viewColumn, {retainContextWhenHidden:true})`（`enableCommandUris: true`，`localResourceRoots` 限定到扩展目录，`iconPath = resources/copilot.svg`）。（`package.json` commands 段；`out/extension/index.js` 偏移 6583075、1091805）
- 窗口存活：`onDidChangeWindowState` + `windowFocused` + webview 心跳（偏移 16261224）；还有 `tencentcloud.codingcopilot.reloadAllWindows`。
- **"一个窗口 = 一个 workspace folder"这个具体对应关系未验证**（见第六节）。

---

## 三、Cursor 实现（官方文档 + 本机遗留数据为证）

> 前置说明：`/Applications/Cursor.app` **已不存在**，无法像 CodeBuddy 那样直接读包体。因此 Cursor 的**内部实现细节（webview / 原生 panel、IPC 协议、是否 fork 内核）无一手证据**，本节结论全部来自 cursor.com 官方文档/官方博客，以及本机遗留的 Cursor 数据目录（真实落盘格式）。

### 3.1 Tab 补全

来源：https://cursor.com/help/ai-features/tab（实际抓取成功 URL；`/docs/tab` 会 302 到该页）

- 定位："Tab is Cursor's AI-powered autocomplete. It suggests code as you type, based on your recent edits, surrounding code, and linter errors."
- 呈现："Suggestions appear as grayed-out text ahead of your cursor."（灰字幽灵文本）
- 交互：
  - 接受全文：`Tab`
  - 拒绝：`Esc` 或继续输入
  - **逐词接受**：Mac `Cmd+→` / Win-Linux `Ctrl+→`
- 能力：可跨多行修改、补 import、做"协调编辑"（coordinated edits across related code）。
- **jump-in-file**：接受后再按 `Tab`，预测下一个编辑位置并跳过去。
- **跨文件**：能预测跨文件编辑，"a portal window appears at the bottom of the editor"。
- 开关粒度：全局 / 按文件类型（markdown、JSON 等）/ 临时 snooze；快捷键可改，命令名为 `Accept Cursor Tab Suggestions`。

> 注：文档没有说明 Tab 用哪个 API。Cursor 是 VS Code 分支，`InlineCompletionItemProvider` 是平台既有机制，但**"Cursor Tab 具体是否走该 provider"未验证**。

### 3.2 Inline Edit / Cmd+K

来源：https://cursor.com/help/ai-features/agent（由 `/help/ai-features/inline-edit` **重定向**而来）

**这是本次调研最需要纠正的一条旧认知**，原文：

> Select the code, then press `Cmd/Ctrl + L` or `Cmd/Ctrl + K` on Mac (`Ctrl + L` or `Ctrl + K` on Windows/Linux). Agent opens with those lines referenced in the input, ready for your instructions. **`CmdCtrl + K` used to open inline edit, which has been replaced by this workflow.**

即：
- 独立的「Cmd+K 内联编辑浮层」**已不存在**；
- `Cmd+K` / `Cmd+L` 现在的语义是「把选区带进 Agent 面板」；
- Agent 面板本身是 `Cmd+I` / `Ctrl+I`（"Access in sidepane with `Cmd+I`/`Ctrl+I`"，https://cursor.com/docs/agent/overview）。

对照：CodeBuddy 仍然保留了独立的 `⌘+I` 内联聊天浮层（见 2.4b）。两家在"内联编辑入口"上的取舍已经分叉。

### 3.3 Agent / Composer

来源：https://cursor.com/docs/agent/overview 、https://cursor.com/help/ai-features/agent

- Agent 三要素（官方口径）：Instructions（system prompt + rules）、Tools、Model；"Cursor's agent orchestrates these components for each model we support, tuning instructions and tools specifically for every frontier model"。
- 工具清单：搜索文件/目录、Web、Fetch Rules、读文件（含 `.png/.jpg/.gif/.webp/.svg` 图片，交给 vision 模型）、编辑文件（"Suggest edits to files and apply them automatically"）、跑 shell（默认用第一个 terminal profile）、Browser（截图/交互/验证视觉变更）、图像生成（默认存到项目 `assets/`）、Ask questions（等待回答期间继续读文件/改文件/跑命令）。
- 工具调用次数："There is no limit on the number of tool calls Agent can make during a task."
- **四种模式**（`/help/ai-features/agent` 表格）：Agent（可改文件）、Ask（只读）、Plan（批准后改）、Debug（可改）；`Shift+Tab` 循环切换；"Each mode uses its own context, so switching modes starts a fresh context window."
- **Checkpoints**：Agent 在重大改动前自动建快照；点击时间线任意 checkpoint 可预览并 restore；"Restoring a checkpoint reverts files only; it does not remove messages."；"**Checkpoints are stored locally and separate from Git.**"
- 并行/委派：subagents（`/docs/subagents`），自定义 subagent 放 `.cursor/agents/` 的 markdown。
- 队列消息：agent 忙时可排队，可拖拽排序。
- 会话检索：conversation search 作为 agent 工具存在。
- Projects：更大任务用 Project，"a coordinator agent plans the work and delegates it to other agents"。
- **Composer 的当前位置**：在 https://cursor.com/docs/models-and-pricing 中，`Composer 2.5` 出现在**模型列表**（`/docs/models/cursor-composer-2-5`）与"Cursor models"定价表里，属于 Cursor 自研模型；当前文档**没有**把 "Composer" 描述为一个独立的编辑器面板。旧的「Composer 多文件编辑面板」形态在现行文档中**未验证**。

### 3.4 上下文与 codebase indexing

来源：https://cursor.com/blog/secure-codebase-indexing（官方博客，2026-01-27）、https://cursor.com/blog/semsearch（官方博客，2025-11-06）

**索引在服务端，客户端只算 Merkle 树**——原文关键句：

- "Cursor builds its first view of a codebase using a **Merkle tree**, which lets it detect exactly which files and directories have changed without reprocessing everything. The Merkle tree features a cryptographic hash of every file, along with hashes of each folder that are based on the hashes of its children."
- "Cursor compares those hashes to **the server's version** to see exactly where the two Merkle trees diverge. Entries whose hashes differ get synced. ... **Any entry missing on the client is deleted from the server, and any entry missing on the server is added.**"
- "**The indexing pipeline above uploads every file when a codebase is new to Cursor.**"
- "When a file changes, Cursor splits it into **syntactic chunks**. These chunks are converted into the **embeddings** that enable semantic search. Creating embeddings is the expensive step, which is why Cursor does it **asynchronously in the background**." + "Cursor caches embeddings by chunk content."
- 索引复用：客户端算 `simhash` 上送，服务端"uses it as a vector to search in a **vector database** composed of all the other current simhashes ... in the same team (or from the same user)"，命中阈值则用同事的索引作初始索引。
- 权限证明：客户端上传完整 Merkle 树，服务端把每个加密路径存成 "content proofs"，搜索时按客户端树过滤——"If the client can't prove it has a file, the result is dropped."
- 收益数据（官方）：median repo time-to-first-query 7.87s → 525ms；p90 2.82min → 1.87s；p99 4.03h → 21s。
- 语义检索价值（semsearch 博客）：平均 +12.5% 答题准确率（6.5%–23.5% 视模型）；大仓（1000+ 文件）代码留存 +2.6%；无语义检索时"dissatisfied follow-up requests" +2.2%。embedding 模型是 Cursor 自训，"uses agent sessions as training data ... train our embedding model to align its similarity scores with these LLM-generated rankings"。

**与 CodeBuddy 的直接对比**：Cursor 的索引是**云端（文件上送 + 服务端 embedding/向量库）**；CodeBuddy 是**本地 `codenexus` 进程 + `127.0.0.1` 回环 HTTP**（见 2.4c）。这是两家最本质的架构分歧之一。

**`@` 引用**：本轮抓取到的 Cursor 官方页面（docs/agent/overview、help/ai-features/agent、docs/rules、docs/mcp）均**未**给出 `@` 符号的规范说明。Cursor 的 `@` 语义因此**未验证**，见第六节。
（对照 FYI，非 Cursor 证据：本机 VS Code 内置 Copilot Chat 的输入框提示是 "type `#` for adding context"，见 `.../lib/vscode/extensions/copilot/package.json` 的 `chatSessions[].inputPlaceholder` —— 说明"符号唤起上下文"在不同产品里符号选择并不统一。）

**本机遗留证据（真实落盘）**：
- `~/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-retrieval/` 下**只有 `checkpoints/`**，没有本地向量索引目录 → 与"索引在服务端"一致（本地只留 checkpoint）。
- `~/Library/Application Support/Cursor/User/globalStorage/conversation-search.db`（+ `-shm` / `-wal`）→ 会话检索是**本地 SQLite**。
- `~/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-agent-worker/agent-cli/cursor-agent-2026.09.08-6caf4ff-94575-1788939388891.tar.gz` → agent worker/CLI 被下载到本地执行。

### 3.5 模型接入 / BYOK

来源：https://cursor.com/help/models-and-usage/api-keys

- 入口：**Cursor Settings > Models**，逐个 provider 粘贴 key 并 Save。
- 支持 provider：**OpenAI、Anthropic、Google、Azure OpenAI、AWS Bedrock**（Bedrock 用 access key/secret，或 dashboard 配 IAM role）。
- **关键限制**："Custom API keys **only work with chat models**. **Tab completion continues using Cursor's built-in models.**"
- **关键架构事实**："Your API key is not stored on our servers. It is **sent to our backend with every request because all requests are routed through Cursor's servers for final prompt building.** The key is transmitted over encrypted connections and is not persisted after the request completes."
  → 即使 BYOK，请求仍过 Cursor 服务端拼 prompt（这也解释了为什么 codebase index 必须在服务端）。
- 计费：个人计划用自己的 key 不消耗 included usage；Teams/Enterprise 仍可能收 `Cursor Token Rate`（$0.25 / 百万 token）。
- 隐私：用自己 key 时 Cursor 的 Zero Data Retention **不适用**，按所选 provider 的隐私政策。
- 套餐层面（https://cursor.com/docs/models-and-pricing）：Free/Plus **不含** "your own API keys"；Premium 及以上才有第三方模型与自带 key；Teams/Enterprise 另有 `Cursor Router`。

### 3.6 Rules / MCP

**Rules**（https://cursor.com/docs/rules）：

- 四类：**Project Rules**（`.cursor/rules`，纳入版本控制）、**User Rules**（全局）、**Team Rules**（dashboard 管理，Team/Enterprise）、**AGENTS.md**（markdown 形式，`.cursor/rules` 的简版替代）。
- 文件形态：Project rules 必须是 `.cursor/rules` 下的 **`.mdc`**；"A plain `.md` file in `.cursor/rules` is **ignored** by the rules system because it has no frontmatter to specify `description`, `globs`, and `alwaysApply`."
- 生效矩阵（官方表格）：

  | `alwaysApply` | `description` | `globs` | 行为 |
  |---|---|---|---|
  | `true` | — | — | 总是包含 |
  | `false` | — | 有 | 匹配文件进入上下文时自动附加 |
  | `false` | 有 | 无 | Agent 读描述，判断相关才拉入 |
  | `false` | 无 | 无 | 仅在 chat 里 `@` 提到时包含 |

- 注入位置："rule contents are included at the **start of the model context**"。
- 模式覆盖：Project/User/Team rules 在 Agent、Ask、Plan、Debug 四种模式下都生效。

**MCP**（https://cursor.com/docs/mcp）：

- 配置：Customize 页面一键装，或 `mcp.json`；`{"mcpServers": {"server-name": {"command":"npx","args":[...],"env":{...}}}}`。
- 三种 transport（官方表格）：**`stdio`**（本地、Cursor 管理、单用户、shell command）、**`SSE`**（本地/远程、URL、OAuth）、**`Streamable HTTP`**（本地/远程、URL、OAuth）。
- 协议能力：Tools / Prompts / Resources / **Roots** / **Elicitation** / **Apps**（MCP Apps 扩展，工具可返回交互 UI）；并明确"progressive enhancement"——宿主不支持则退回普通 MCP 响应。
- 生态：Cursor Marketplace、`cursor.directory`、team marketplace（团队分发）。

**本机遗留证据**：`~/.cursor/mcp.json`（权限 `-rw-------`）结构为单键 `mcpServers`，实测条目分两类——`{command,args,env}`（stdio）与 `{url}`（HTTP/SSE），例如 `rea`（command/args/env）、`xima_ai_search`（url）、`cursorRules`（url）。**这与官方文档的 transport 表格一一对应**，可视为该格式的硬证据。

另：`~/.cursor/hooks.json` 存在（`{"version":1,"hooks":{"stop":[{"command":"./hooks/continue-on-usage-limit.py","timeout":60,"loop_limit":null}]}}`），对应官方 Hooks（`/docs/hooks`）；`~/.cursor/plans/*.plan.md` 对应 Plan 模式；`~/.cursor/plugins/{cache,local,marketplaces}` 对应 Plugins 体系；`~/.cursor/projects/<slug>/` 每个项目一个目录。

---

## 四、VS Code 原生提供了什么（区分自研 vs 平台能力）

依据：本机 VS Code 内核 `/Users/xmly/.dsh/editor-runtime/node_modules/code-server/lib/vscode/`，版本 `1.145.2`（`product.json` 的 `version`，`commit` 见同文件）。

### 4.1 `viewsContainers` 只有三个合法位置，视图类型只有两种

`out/vs/code/browser/workbench/workbench.js:1224`：

```js
Wzr = { type:"object", properties: {
          activitybar:{...}, panel:{...}, secondarySidebar:{...}
        }, additionalProperties: !1 }
```

- 合法位置：**`activitybar`（左）、`panel`（底部）、`secondarySidebar`（右）**，其它键直接非法（`additionalProperties:false`）。
- `views` 的 `type` 枚举：`["tree","webview"]`（同文件 `:1224`，`enum:["tree","webview"]`）。
- 结论：**「把 Chat 放右侧」是平台原生能力（`secondarySidebar`）**。CodeBuddy 选了 `activitybar`，属于产品选择而非平台限制。

### 4.2 原生 AI 扩展点确实存在（且有官方内置实现可对照）

`workbench.js` 中的扩展点注册：

| 扩展点 | 位置 |
|---|---|
| `languageModelChatProviders` | `workbench.js:657` |
| `languageModelTools` | `workbench.js:705` |
| `languageModelToolSets` / `mcpServerDefinitionProviders` / `chatSkills` / `chatAgents` / `chatInstructions` / `chatPromptFiles` / `chatPlugins` | `workbench.js:714`（同一数组 `aPr`） |
| `chatParticipants` | `workbench.js:3010` |
| `chatSessions` | `workbench.js`（258 处命中，工作台原生 chat 会话面） |

最有力的对照物：内核自带 `extensions/copilot/`（`package.json`：`name: copilot-chat`、`publisher: GitHub`、`version: 0.73.0`），其 `contributes` 键为：

`languageModelTools`(35 条) / `languageModelToolSets`(6) / `chatParticipants`(9) / `languageModelChatProviders` / `interactiveSession` / `mcpServerDefinitionProviders`(1) / `chatSessions`(2) / `chatAgents`(0) / `chatPromptFiles`(7) / `chatSkills`(12) / `viewsContainers`(activitybar: `copilot-chat`, `context-inspector`) / `configurationDefaults` / `terminalQuickFixes` / `walkthroughs` …

即：**微软官方的 Copilot Chat 走的是原生 `chatParticipants` + `languageModelTools` + `mcpServerDefinitionProviders` 路线，UI 由工作台渲染**；而 CodeBuddy 走的是**自绘 webview** 路线（`viewsContainers` + `type:webview`），一个原生 AI 扩展点都没用。这是判断"自研 vs 平台能力"的分水岭。

### 4.3 平台还提供了什么（作用于两家产品的共同底座）

- `vscode.window.registerWebviewViewProvider` / `createWebviewPanel` / `retainContextWhenHidden` —— 侧栏与面板承载（CodeBuddy 直用）。
- `vscode.languages.registerInlineCompletionItemProvider` —— Tab 补全底座（CodeBuddy 直用；Cursor 大概率同源，未验证）。
- `vscode.commands.executeCommand("vscode.diff", ...)` + `workspace.registerTextDocumentContentProvider` —— 虚拟文档 diff（CodeBuddy 直用，scheme `genie-diff`）。
- `vscode.changes` / `_workbench.changes` —— 多文件 diff 视图（CodeBuddy 直用）。
- `workspace.applyEdit` + `WorkspaceEdit` —— 编辑落地（CodeBuddy 直用）。
- `createTextEditorDecorationType`（`after` + `editorGhostText.foreground`）—— 幽灵提示/行内提示（CodeBuddy 直用做 inline chat 提示条）。
- `authentication` 扩展点 + `vscode.authentication` —— 认证（CodeBuddy 注册自有 provider `codingcopilot`）。

---

## 五、能力矩阵

| 能力 | Cursor | CodeBuddy | VS Code 原生 | 证据 |
|---|---|---|---|---|
| **AI 侧栏注册方式** | 官方文档只写 "sidepane"，Cmd+I；**内部实现未验证**（无包体） | `viewsContainers.activitybar` + `views{type:"webview"}`，容器 `coding-copilot-chat`，视图 `coding-copilot.webviews.chat` | `viewsContainers` 支持 `activitybar`/`panel`/`secondarySidebar`；`views.type` ∈ `tree`/`webview` | `genie/package.json:73-89`；`workbench.js:1224`；https://cursor.com/docs/agent/overview |
| **右侧栏（secondarySidebar）** | 未验证 | ✗ 用左侧 activitybar | ✓ 原生支持 | `workbench.js:1224` |
| **原生 Chat 扩展点** | 未验证（分支产品，可能自改） | ✗ 完全不用 `chatParticipants`/`chatAgents` | ✓ `chatParticipants`/`chatAgents`/`chatSessions`/`languageModelTools` | `genie/package.json` contributes；`workbench.js:714,3010`；`extensions/copilot/package.json` |
| **webview 消息协议** | 未验证 | 自研 JSON-RPC 代理（`getProxy(服务Symbol)`，channel `ch1…`，日志 `[json-rpc]`）+ 9 个 `{type}` 生命周期消息；双向 `postMessage` | 只提供 `onDidReceiveMessage`/`postMessage` 原语 | `index.js` 偏移 2480902/9893758/6583056 |
| **流式方式** | 未验证 | Vercel AI SDK + OpenAI 兼容 SSE（`normalizeOpenAICompatibleSseDataLine`）→ 扩展内 RxJS Observable → `stream.write()`/RPC 推 webview | 无约定（宿主无关） | `index.js` 偏移 3722838/9805142 |
| **Tab 补全 API** | 官方文档描述行为（灰字、Tab/Esc/Ctrl+→、jump-in-file、跨文件 portal）；具体 API 未验证 | `registerInlineCompletionItemProvider({pattern:"**"})` + `provideInlineCompletionItems`（标准/Proposed 双实现） | `InlineCompletionItemProvider` + `inlineCompletionsAdditions`(proposal) | `index.js` 偏移 10864146/19664791；https://cursor.com/help/ai-features/tab |
| **Tab 上下文** | "recent edits, surrounding code, linter errors" | 光标前后文本 + 缩进链（parentIndent/nextIndent/nextLine/preLine）+ 预算 4000 tok / suffix 20% / 当前文件 200 行 | 由扩展自取 | `index.js` 偏移 10864146；`product.json:524-535` |
| **NES（下一处编辑预测）** | 未单列（Tab 内含 jump-in-file） | ✓ 独立 `nes.*` 命令族 + `codingcopilot.predictionShow` 上下文键 + `enableNextEditSuggestions` | 平台无 NES 概念（Copilot 自带 `nextEditSuggestions.*`） | `genie/package.json` keybindings；`workbench.js`（copilot 配置项） |
| **内联编辑（Cmd+K 类）** | **已废弃**：Cmd+K 改为"带选区开 Agent"（官方原文） | ✓ 独立命令 `ide.inlineChat.start` = `Ctrl/⌘+I`，自研装饰器幽灵提示 + `inline-chat` agent + Accept/Reject/Retry | 有原生 Inline Chat（Copilot 用）；也可自绘 | https://cursor.com/help/ai-features/agent；`genie/package.json:408`；`index.js` 偏移 1517393/9805142 |
| **AI 改动回写/审核** | Diff view + **本地 checkpoint**（`checkpoints/<agentRequestId>/{metadata.json,files/,diffs/}`），可 restore | `vscode.diff` + 虚拟文档 scheme `genie-diff`/`agent-diff`；多文件 `vscode.changes`/`_workbench.changes`；`CheckpointService` | `vscode.diff`/`TextDocumentContentProvider`/`WorkspaceEdit`/`applyEdit` 均为原生原语 | `~/…/anysphere.cursor-retrieval/checkpoints/*/metadata.json`；`index.js` 偏移 4949125/623489/8074541 |
| **上下文注入：当前文件/选区** | 选区 → `Cmd+K`/`Cmd+L` 带入 Agent | `addToChat`（`Ctrl+Alt+I`）挂 editor/explorer/terminal 右键；终端选中三个专用命令 | 提供 `editor/context` 等菜单点 | `genie/package.json` commands/menus；https://cursor.com/help/ai-features/agent |
| **上下文注入：项目规则文件** | `.cursor/rules/**.mdc`（frontmatter `description`/`globs`/`alwaysApply`）+ `AGENTS.md` + User/Team rules | `CODEBUDDY.md` → `.codebuddy/CODEBUDDY.md` → `AGENTS.md`，包进 `<project_guidance>` | 无内置规则文件约定 | https://cursor.com/docs/rules；`index.js` 偏移 13383374 |
| **codebase 索引位置** | **云端**：客户端 Merkle 树 → 上传文件 → 服务端 embedding + 向量库 + simhash 复用 | **本地**：`codenexus` 进程，扩展走 `http://127.0.0.1:<port>` | 无内置索引（原生有 workspace search） | https://cursor.com/blog/secure-codebase-indexing；`index.js` 偏移 8299087 |
| **语义检索工具** | 自训 embedding 模型，`codebase_search` 类工具（semsearch 博客称 "semantic search"） | 工具 `codebase_search`（"semantic search ... not exact text"）+ `semantic_search` | 无 | `index.js` 偏移 15674283；`product.json:70`；semsearch 博客 |
| **模型接入 / BYOK** | ✓ Settings>Models 填 key（OpenAI/Anthropic/Google/Azure/Bedrock）；**仅 chat 生效，Tab 仍用内置模型**；请求仍过 Cursor 服务端拼 prompt | 部分：`productFeatures.CustomModel` + `vendor:"user"` 模板（`deepseek` / `ollama`），存 `globalState`（apiKey/baseUri/model）；默认全走网关 `copilot.tencent.com` | 提供 `languageModelChatProviders` 扩展点（两产品都未用） | https://cursor.com/help/models-and-usage/api-keys；`index.js` 偏移 3142022；`workbench.js:657` |
| **MCP 接入形式** | `mcp.json`（`mcpServers`）+ Customize 页 + marketplace；transport: stdio / SSE / Streamable HTTP；支持 Roots/Elicitation/Apps | 自研（`mcpSchemaUrl: codebuddycn://codebuddy-ide/mcp`、MCP 市场、`McpRegister*Command`、官方 MCP SDK、4 个内置 integration-mcp） | ✓ `mcpServerDefinitionProviders` 扩展点 | `~/.cursor/mcp.json`；https://cursor.com/docs/mcp；`product.json:493`；`workbench.js:714` |
| **多窗口** | 未验证（Cloud Agents / Agents Window 是另一形态） | Electron 多 `BrowserWindow`；`chat.newWindowOpen` + `NewWindowOpenChatService`；webview panel 用 `ViewColumn.Beside` | 原生支持多窗口/多 root workspace | `app/package.json`；`index.js` 偏移 1091805；`out/main.js`（BrowserWindow 42 次） |

---

## 六、未验证 / 存疑项

按"没查到就写没查到"的原则列出，**不要**把它们当成结论使用：

1. **Cursor 的内部实现细节全部未验证**：侧栏是原生 panel 还是 webview、IPC/消息协议、是否 fork 自 VS Code 的哪个 commit、是否使用 `InlineCompletionItemProvider`、Composer 面板是否还存在。原因：`/Applications/Cursor.app` 已被删除，无包体可读。
2. **Cursor 的 `@` 引用语义未验证**：本轮抓取的官方页面（docs/agent/overview、help/ai-features/agent、docs/rules、docs/mcp）均未给出 `@` 符号的规范说明。旧域名 `docs.cursor.com` 本轮**未**抓取（cursor.com 可达，无需换源）。
3. **Cursor 的 changelog 未抓取**：任务点名 `https://cursor.com/changelog`，本轮为控制篇幅跳过了，仅用 docs/help/blog。因此"某能力何时引入/何时移除"的时间线未验证。
4. **CodeBuddy `productFeatures` 的运行态取值未验证**：`.../genie/product.json` 只是随包默认值，服务端可覆盖（`ProductManager.onDidChange`、`codebuddy:/product.json` 是"当前生效配置"的只读投影）。本调研按要求**不启动应用**，故拿不到运行态。
5. **`productFeatures.Codebase: false` 与 `enableCraftCodeBase` 默认 `true` 的冲突未解释**：`codebase_search` 工具真实存在且由 `isCodebaseReady && !DisableCodebase` 门控，但全局 `Codebase: false` 的语义（是否指旧版索引通道）未验证。
6. **CodeBuddy 本地语义索引是否落盘为向量库未验证**：只确证了"本地 codenexus 进程 + 127.0.0.1 HTTP + 文件级索引调用"，bundle 内 `sqlite` 有命中但无法确证是向量/索引存储；`faiss`/`lancedb` 命中为 0。
7. **CodeBuddy 内建模型清单只是随包静态快照**，服务端实际可用模型集合未验证；`vendor` 单字母（`e`/`f`/`j`）对应的真实 provider 未验证。
8. **CodeBuddy product.json 中 `genie` 版本 `0.2.4` 与磁盘 `3.10.0` 不一致的确切原因未验证**（可能该字段仅用于内置扩展的更新/校验元数据）。
9. **CodeBuddy 多窗口与 workspace 的对应关系未验证**（是否严格"一窗口一 folder"、是否支持多 root 的 per-window 语义）。
10. **CodeBuddy 的 `InlineChatAcceptCommand` 具体落盘路径未验证**（是 `WorkspaceEdit` 还是自定义 stream 写入；我只确认了 `applyEdit` 与 diff 两套机制都存在）。
11. **Cursor checkpoint 中 `files/` 与 `diffs/` 的语义未验证**：实测同目录下 `files/<fileUuid>` 为 0 字节、`diffs/<fileUuid>` 约 40 KB，`metadata.json` 有 `requestFiles[].fileUuid`/`gitInfo`/`workspaceId`/`fileSizeBytes`；但"哪一侧是改动前/改动后"我没有依据，故不下结论。
12. **Continue / Cline 开源对照未做**：任务把它们列为"辅助，可选"，本轮因本地证据与官方文档已足以回答问题，未抓取其 `package.json`。若需要"通用做法 vs 专有做法"的第三方对照，需补做。

---

## 七、参考来源

### A. 本地文件（一手，最硬）

**CodeBuddy（`/Applications/CodeBuddy CN.app`）**

- `/Applications/CodeBuddy CN.app/Contents/Resources/app/package.json`（app 身份：`CodeBuddy CN` 1.106.1，`main: ./out/main.js`）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/product.json`（`:103` `builtInExtensions` 含 `genie@0.2.4`；`version: 1.106.1`；`extensionsGallery` → open-vsx）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/product-ide.json`、`product-ide-cn.json`（`:250` `genieEndpoint`）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/out/main.js`（Electron 主进程）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/package.json`（`:3-7` 身份；`:46-52` 激活与入口；`:54-62` proposals；`:73-89` 容器/视图；`:408` inlineChat 命令）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/package.nls.zh-cn.json`（`:21,23,29,30,44,58-62,97,106` 官方中文说明）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/product.json`（`:44` agents；`:244` inline-chat；`:262` models；`:430-432` 端点；`:482` knowledgeBases；`:493` mcpSchemaUrl；`:524-535` completion 预算；`:776` productFeatures；`:815` InlineChatIDE；`:883` builtInSubagents；`:910` skillScanDirs）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/out/extension/index.js`（minified，84 行；按字节偏移引用：2480902 RPC、9893758 channel、6583056 消息常量、16261224 webview 注册、10864146/19664791 补全 provider、1517393 装饰器、9805142 inline chat、1677733 工具注册、15674283 codebase_search、8299087 codenexus、13383374 project guidance、4949125/623489/8074541 diff、3142022 自定义模型、5638168 端点、17776421 codebuddy:/product.json）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/out/webviews/`（前端产物）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/out/extension/wasm/`（tree-sitter）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/out/extension/builtin/`、`wecom-skills/`
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/integration-mcp/{anydev,eop,tcb,lighthouse}`

**Cursor（本机遗留数据，`/Applications/Cursor.app` 已删除）**

- `/Users/xmly/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-retrieval/checkpoints/<uuid>/{metadata.json,diffs/,files/}`
- `/Users/xmly/Library/Application Support/Cursor/User/globalStorage/{anysphere.cursor-agent-worker,anysphere.cursor-mcp,anysphere.cursor-commits}/`
- `/Users/xmly/Library/Application Support/Cursor/User/globalStorage/conversation-search.db`
- `/Users/xmly/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- `/Users/xmly/Library/Application Support/Cursor/User/settings.json`
- `/Users/xmly/.cursor/mcp.json`、`hooks.json`、`argv.json`、`cli-config.json`、`ide_state.json`
- `/Users/xmly/.cursor/plans/*.plan.md`、`/Users/xmly/.cursor/plugins/{cache,local,marketplaces}`
- `/Users/xmly/.cursor/extensions/`（含 `anysphere.cursorpyright`、`anysphere.remote-containers`、`anysphere.remote-ssh` 等 Cursor 品牌扩展）

**VS Code 内核（`code-server` 打包，vscode 1.145.2）**

- `/Users/xmly/.dsh/editor-runtime/node_modules/code-server/lib/vscode/product.json`（`builtInExtensions`(3)、`defaultChatAgent: GitHub.copilot/chat`、`builtInExtensionsEnabledWithAutoUpdates: ["GitHub.copilot-chat"]`、`aiConfig`）
- `/Users/xmly/.dsh/editor-runtime/node_modules/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js`
  - `:1224` `viewsContainers` schema（`activitybar`/`panel`/`secondarySidebar`，`additionalProperties:false`）与 `views.type` 枚举 `["tree","webview"]`
  - `:657` `languageModelChatProviders`；`:705` `languageModelTools`；`:714` `languageModelToolSets`/`mcpServerDefinitionProviders`/`chatSkills`/`chatAgents`/`chatInstructions`/`chatPromptFiles`/`chatPlugins`；`:3010` `chatParticipants`
- `/Users/xmly/.dsh/editor-runtime/node_modules/code-server/lib/vscode/extensions/copilot/package.json`（`copilot-chat` / `GitHub` / `0.73.0`，原生 AI 扩展点参考实现）

### B. 在线（官方一手）

| 用途 | 实际抓取成功的 URL | 备注 |
|---|---|---|
| Cursor 文档首页 | https://cursor.com/docs | HTTP 200 |
| Agent 总览（Cmd+I、工具、checkpoint、模式的另一版本） | https://cursor.com/docs/agent/overview | HTTP 200；`/docs/agent/tools` 会指回本页 `#tools` |
| Agent 帮助页（**Cmd+K 废弃原文**、模式表、选区入 Agent） | https://cursor.com/help/ai-features/agent | HTTP 200；由 `/help/ai-features/inline-edit` **重定向**而来 |
| Tab 补全 | https://cursor.com/help/ai-features/tab | HTTP 200；`/docs/tab` 会重定向到此 |
| Rules | https://cursor.com/docs/rules | HTTP 200 |
| MCP | https://cursor.com/docs/mcp | HTTP 200 |
| BYOK / API keys | https://cursor.com/help/models-and-usage/api-keys | HTTP 200 |
| 模型与定价 | https://cursor.com/docs/models-and-pricing | HTTP 200 |
| 索引架构（Merkle/simhash/向量库/content proofs） | https://cursor.com/blog/secure-codebase-indexing | 官方博客，2026-01-27 |
| 语义检索价值与自训 embedding | https://cursor.com/blog/semsearch | 官方博客，2025-11-06 |

> 未使用 `/docs/account/api-keys`（HTTP 404）等猜测路径；未使用 `docs.cursor.com` 旧域名（无需换源）。二手博客/公众号一律未采用。