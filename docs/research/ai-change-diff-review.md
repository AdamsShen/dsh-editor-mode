# AI 改动 diff 审核：业内实现调研

> **来源范围**：本报告只写能追溯到「一手来源」的结论。一手来源 = 本机已安装产物的真实文件（CodeBuddy CN 扩展包、Cursor 遗留 checkpoint 数据、code-server 打包的 VS Code 1.145.2 内核源码、DSH app.asar 内的类型/README/实现、dsh-rewind-plugin 源码）、本项目自身源码、以及官方文档 URL。未对二手博客/印象做推断。
>
> **未验证声明**：凡下文标注「未验证」的条目，表示在本次只读核查范围内没有找到可追溯的一手证据，不做结论、不凭印象补齐。特别地：本报告**不执行**任何被调研应用，不启动 CodeBuddy/Cursor/DSH/code-server，不修改任何被调研文件；唯一写入的是本报告自身。
>
> **只读声明与出处格式**：本地文本文件用 `绝对路径:行号`（可读多行文件）或 `绝对路径 @ 字节偏移（可 grep 字符串）`（单行 minified / asar 二进制）；在线文档用完整 URL。所有字节偏移基于本次读取时的原始文件字节，可用 `grep -oba '<字符串>'` 复核。
>
> 调研时间：2026-11-12。被测版本见各节。

---

## 一、结论摘要（8 条）

1. **CodeBuddy CN 用「自定义 scheme 虚拟文档 + `vscode.diff`/`vscode.changes` 多文件变更视图」两套机制展示 AI 改动**，且对老版本 VS Code 有 QuickPick 降级。"改动前"内容来自它自己的 checkpoint/版本服务（`CheckpointService` / `genie.getFileFullContent` / `genie.getFoldedBaseline` / `editCodeData.originalFileContent`），不是来自 git。出处：`/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/out/extension/index.js @ 19347261（"GENIE_DIFF_URI_SCHEME=\"genie-diff\""）`、`@ 8278563（"VSCodeChangesImpl"）`、`@ 3736197（"showFileChanges"）`、`@ 5683945（"saveFileChanges"）`、`@ 5061121（"DIFF_VIEW_URI_SCHEME"）`。

2. **CodeBuddy 的 `file-changes/` 目录既存 diff 文本也存全文**：每个 JSON 含 `diff`（SVN/unified `Index:` + `---...original` / `+++...modified` 格式）、`addedLines`/`removedLines`、`changeType`、`status`，以及 `ideState.editCodeData.originalFileContent`（改动前全文）和 `diffAreas[].originalCode`。出处：`~/Library/Application Support/CodeBuddy CN/User/globalStorage/tencent-cloud.coding-copilot/file-changes/e8dc5c51e2e345f39c2fc5029ea58ce1/CrossScenePkPanelService.java_2f5a8124.json`（字段名见正文二节）。

3. **Cursor 遗留 checkpoint：`diffs/` 存结构化行级 diff JSON（含 `addedLines`），`files/` 存该文件的整文件快照；本机样本里 `files/` 是「改动前/较早」全文，`diffs/` 的 `addedLines` 是「改动后/较新」内容**；多个 checkpoint 的 `files/` 为 0 字节（未捕获）。两侧不是简单 before/after 对称目录，且同一 checkpoint 内多个 UUID 文件的内容相同（重复快照）。出处：`~/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-retrieval/checkpoints/*/metadata.json`、`diffs/*`、`files/*`（正文三节逐文件列出）。

4. **VS Code 1.145.2 原生提供三个原语**：`vscode.diff`（left/right/title/options）、`vscode.changes`（title + `resourceList`，每项必须是长度 3 的 `[Uri, Uri|undefined|null, Uri|undefined|null]`）、`workspace.registerTextDocumentContentProvider(scheme, provider)`（可注册只读虚拟文档，scheme 不能是已保留 scheme，可 `onDidChange` 刷新）、`workspace.applyEdit(WorkspaceEdit)`。官方文档与本机内核源码互相印证。出处：`https://code.visualstudio.com/api/references/commands`、`/Users/xmly/.dsh/editor-runtime/node_modules/code-server/lib/vscode/out/vs/workbench/api/node/extensionHostProcess.js @ 1558604 / @ 1559080 / @ 1686176 / @ 2118433`。

5. **「扩展能否用自定义 scheme 注册只读虚拟文档再传给 `vscode.diff`」——可以，且这是 CodeBuddy 的真实做法**（`genie-diff` scheme 的 `provideTextDocumentContent` 直接把 URI query 的 base64 解码成文本返回，再作为 diff 的 original 侧）。官方文档明确虚拟文档是 readonly 且「wired into the open document logic」。出处：`index.js @ 19347261`、`https://code.visualstudio.com/api/extension-guides/virtual-documents`。

6. **本项目现有 SSE 流没有把 `workspace/changes` 透传给前端**：`sessions.js` 的 `UI_EVENT_TYPES` 白名单不含该事件；内核确实会发出 `workspace/changes` 事件（DSH 自有 `dsh-workspace-changes` 插件），数据形状只有 `{ turn: number }`，**不能直接撑起改动文件列表**，必须再走 Host 的认证摘要路由 `GET /api/changes.summary?sessionId=&seq=` 才能拿到 `files[]`。出处：`/Users/xmly/dsh-editor-mode/sessions.js:51-63, 397-408`；`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar @ 19201069（"'workspace/changes': { turn: number; }"）`、`@ 28720794（"/api/changes.summary"）`、`@ 124290134（"summary(sessionId, seq)"）`。

7. **DSH rewind 快照不能被外部插件直接读取**：`dsh-rewind-plugin` 只导出 `Config / DEFAULT_FILE_CHECKPOINTING_ENABLED / ENGINE_COMMAND / SnapshotStore / apply / inject / name / profileEntryKey`，`inject = ['commands','tools','settings']`，没有注册可供他人调用的 cordis 服务；它对外只暴露两个**面向 Client UI 的 HTTP 路由** `/api/dsh-rewind/preview`、`/api/dsh-rewind/candidates`（返回的是 rewind 候选/影响文件列表，不是「某快照某文件内容」），以及 `/rewind`、`/undo`、`/snapshot-auto-cleanup` 命令。结论：**不可直接复用**；如需 before 内容，应改用 DSH 自带的 `workspaceChanges` 服务（见第 6 条）或自行存 before。出处：`/Users/xmly/.dsh/profiles/desktop/node_modules/dsh-rewind-plugin/lib/index.js:1639, 1641-1642, 1773-1802, 2253-2260, 2290-2299`。

8. **DSH 自己已有一套完整「AI 改动审阅」实现（第 3 种业内实现，且与本项目同源）**：`dsh-workspace-changes` 插件用 git 工作树快照 + 文件工具编辑前后整文件拷贝生成 `WorkspaceChangesSummary` / `WorkspaceFileDiff`（hunks 三行上下文），Host 通过 `ctx.workspaceChanges.summary()/diff()` 与三条认证路由服务，Web 端有「改动文件卡片」和 `dsh-resource://changes-review/session/<id>/<seq>/<turn>` 右侧栏 review tab。本项目侧栏 Chat 是它的第二视图，最省力的兼容点是复用这些路由而非自建 restore。出处：app.asar `@ 143893618`（包 README）、`@ 124290134`（服务契约）、`@ 124654009`（类型）、`@ 28853855`（路由常量）、`@ 28691020`（卡片）、`@ 28698109`（review tab）。

---

## 二、CodeBuddy 实现（本地产物为证）

### 2.1 被测对象
- 扩展包：`/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/package.json` → `name=coding-copilot`, `publisher=Tencent-Cloud`, `version=3.10.0`, `engines.vscode=^1.70.2`（`package.json` 前若干字段，JSON 解析结果）。
- 主 bundle：`/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/out/extension/index.js`，22,070,782 字节、85 行（单行 minified）。以下用字节偏移 + 可 grep 字符串定位。
- 持久化目录：`~/Library/Application Support/CodeBuddy CN/User/globalStorage/tencent-cloud.coding-copilot/file-changes/`，本机实存 4537 个文件、约 100 MB（只读统计）。

### 2.2 机制一：`genie-diff` 自定义 scheme 虚拟文档
`index.js @ 19347261`（grep 字符串 `GENIE_DIFF_URI_SCHEME="genie-diff"`、`registerTextDocumentContentProvider`）：

```
ar.GENIE_DIFF_URI_SCHEME="genie-diff";
class GenieDiffContentProviderService{
  initialize(ctx){ ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("genie-diff", this)) }
  provideTextDocumentContent(uri){ return Buffer.from(uri.query,"base64").toString("utf-8") }
}
```

即：把「改动前全文」base64 进 URI 的 `query`，注册一个只读虚拟文档 provider，diff 的左侧直接用这个 `genie-diff:` URI。`@ 5061121` 另有常量 `ar.DIFF_VIEW_URI_SCHEME="genie-diff"`（用于内联 diff 区装饰）。

`index.js @ 3739689`（grep `showFileChanges: fold baseline`）展示了拼装 diff 三元组的过程：

```
const Fn = (stat.isFile()) ? Rn.uri : vscode.Uri.file(Sn);
const toGenieDiffUri = ir => Fn.with({scheme:"genie-diff", query: Buffer.from(ir).toString("base64")});
const Nn = toGenieDiffUri(Pn);           // 改动前全文 → 左侧虚拟文档
const jn = ... bn.content;               // 当前内容
const Kn = (stat.isFile()) ? Rn.uri : toGenieDiffUri(jn);  // 右侧：真实文件或虚拟文档
return [ vscode.Uri.file(Sn), Nn, Kn ];  // [文件路径, 改动前, 改动后]
```

`@ 656726`（grep `vscode.diff`、`openDiffEditor timed out`）是单文件入口：`commands.executeCommand("vscode.diff", Uri.parse("genie-diff:...").with({query: base64(original)}), gn, "<name>: Original ↔ Changes")`——**自定义 scheme 虚拟文档直接作为 `vscode.diff` 的 left 参数**，这是问题 3「能否注册只读虚拟文档再传给 vscode.diff」的直接实证。

### 2.3 机制二：`vscode.changes` / `_workbench.changes` 多文件变更视图
`index.js @ 8278563`（grep `VSCodeChangesImpl`、`_workbench.changes`、`vscode.changes`）：

```
class VSCodeChangesImpl {
  isLegacyVSCode(){ return parseFloat(vscode.version...) < 1.82 }
  async supportsNativeChanges(){ return (await commands.getCommands()).includes("vscode.changes") }
  async executeChanges(title, ar){
    const cmds = await getCommands();
    if (cmds.includes("_workbench.changes"))
      return commands.executeCommand("_workbench.changes", title, ar, {isTransient:true});
    if (cmds.includes("vscode.changes"))
      return commands.executeCommand("vscode.changes", title, ar);
    return this.executeChangesCompat(title, ar);   // 降级
  }
  async executeChangesCompat(...){   // 单文件 → vscode.diff；多文件 → createQuickPick 让用户选
    ... openSingleDiff → commands.executeCommand("vscode.diff", ar, tn, title)
  }
}
```

`@ 3741343`（grep `this.vscodeChanges.executeChanges`）确认 `showFileChanges` 把 `buildDiff` 得到的 `[filePath, beforeUri, afterUri][]` 交给它：`await this.vscodeChanges.executeChanges(l10n.t("CodeBuddy Changes"), gn)`。

降级路径（`@ 8279570` 起）在单文件时直接 `vscode.diff`，多文件时用 `window.createQuickPick()` 列出文件名让用户逐个打开（标题 `"CodeBuddy Changes (N 个文件)"`）。

### 2.4 「改动前」内容从哪来
不是 git，而是 CodeBuddy 自己的版本/checkpoint 与编辑会话状态：
- `@ 3736197`（grep `showFileChanges(ir,ar,tn)`）：`checkpointService.getAllVersions(ir).find(v => v.versionId===tn)`，`rn.filePaths` 给出本轮涉及文件；并用 `commands.getCommands(true).includes("genie.getFileFullContent")` 探测能否取全文。
- `@ 3738600`（grep `getHunkStates`、`genie.getFoldedBaseline`）：从 `editSessionStore.getHunkStates(...)` 取已保留 hunk，调用 `genie.getFoldedBaseline(uri, Pn, bn.content, keptHunkKeys)` 得到 `foldedOriginalContent`（即「把已接受 hunk 折叠掉后的基线全文」）；`fullOriginalContent !== fullNewContent` 时直接用 `fullOriginalContent`。
- `@ 5683945`（grep `saveFileChanges`、`genie.getEditCodeServiceData`）：`ideState` 由 `genie.getEditCodeServiceData(uri)` + `genie.getCommandBarState()` 组装，落盘。

`CheckpointService`（`@ 807155`、`@ 1723753`，grep `CheckpointService`）与 `CraftVersionController`/`VersionServiceFactory` 出现在依赖注入元数据里；`InlineChatAcceptCommand`（`@ 5558685`，grep `InlineChatAcceptCommand`）是内联对话「接受」命令，调用 `codeTaskManager.getTask(id).accept(CodeRangeUtils.parse(arg))`。另有 `agent-diff` scheme（`@ 18267792`，grep `DIFF_URI_SCHEME="agent-diff"`）：`generateDiffUri({conversationId,filePath,versionId}, "original"|"modified")` 生成 `agent-diff://<conversationId>/<filePath>?type=...&versionId=...`，并有 `parseDiffUri`/`generateDiffUriPair`——这是**按 checkpoint 版本号**取 before/after 的另一套 URI 约定（本次未验证其 provider 全文实现，见第八节）。

### 2.5 `file-changes/` 目录实际存了什么
目录结构：`<conversationId-32hex>/<原文件名>_<8hex>.json`（如 `e8dc5c51.../CrossScenePkPanelService.java_2f5a8124.json`）。`@ 5683945` 的 `saveFileChanges` 代码解释了文件名规则：`md5(filePath).slice(0,8)` + 清洗后的 basename，内容 `JSON.stringify(sn,null,2)`。

单个 JSON 的字段（读取 `.../CrossScenePkPanelService.java_2f5a8124.json` 解析）：

| 字段 | 类型/样例 | 含义 |
|---|---|---|
| `filePath` | 绝对路径字符串 | 被改文件 |
| `fileName` | `CrossScenePkPanelService.java` | 文件名 |
| `changeType` | `"delete"` | 变更类型 |
| `addedLines` / `removedLines` | `38` / `31` | 增删行数 |
| `status` | `"pending"` | 待审阅状态 |
| `diff` | 25078 字符字符串 | **diff 文本** |
| `versionId` | `"413"` | checkpoint 版本号 |
| `timestamp` | `1791457901322` | 毫秒时间戳 |
| `ideState` | 对象 | IDE 侧编辑状态 |

`diff` 字段开头（原文）：

```
Index: /Library/git-root/.../CrossScenePkPanelService.java
===================================================================
--- /Library/git-root/.../CrossScenePkPanelService.java	original
+++ /Library/git-root/.../CrossScenePkPanelService.java	modified
@@ -1,580 +0,0 @@
-package com.ximalaya...
```

即 **SVN/`diff -u` 风格 unified diff**（`--- ... original` / `+++ ... modified`），不是「纯全文」。

`ideState` 子结构：`{ editCodeData: { diffAreas: [...], originalFileContent: "..." }, commandBarState: { sortedDiffZoneIds, sortedDiffIds, isStreaming, diffIdx } }`；`diffAreas[0]` 含 `{ diffareaid, type:"DiffZone", originalCode:"package ...", startLine, endLine, _diffOfId }`。其中 `originalFileContent` / `diffAreas[].originalCode` 是**改动前全文/片段**。

结论：**`file-changes/` 同时存 diff 文本与改动前全文**（`diff` 字段 + `ideState.editCodeData.originalFileContent`），所以回答「存的是 diff 还是全文」= 两者都有；`readDiskFileChanges`（`@ 5689530`，grep `readDiskFileChanges`）会把这些 JSON 读回来聚合成 `{totalFiles, addedLines, removedLines}`。

---

## 三、Cursor 实现（本地 checkpoint 数据为证）

### 3.1 被测对象
`/Applications/Cursor.app` 已删除；遗留数据 `~/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-retrieval/checkpoints/` 实存 5 个 checkpoint、29 个文件、208 KB。每个 checkpoint 目录含 `metadata.json`、`files/`、`diffs/`（只读观察）。

### 3.2 `metadata.json` 形状
以 `1f59fae8-1912-4f88-b8e3-b3b4e53050e3/metadata.json` 为例（原文）：

```json
{"agentRequestId":"1f59fae8-...","requestFiles":[{"fsPath":"/Users/xmly/Agent-Hooks-详解与Claude-Code对比.md","fileUuid":"8d164b76-...","gitInfo":{"noRepoFound":true}}],"startTrackingDateUnixMilliseconds":1789010211835,"fileSizeBytes":31566,"workspaceId":"152820059117aad4f7375d44d0505c4d"}
```

5 个 checkpoint 的 `metadata.json` 均为：`agentRequestId`（=目录名）、`requestFiles[]`（`fsPath` / `fileUuid` / `gitInfo.noRepoFound=true`）、`startTrackingDateUnixMilliseconds`、`fileSizeBytes`、`workspaceId`。注意 `metadata.requestFiles[].fileUuid` 只列出一个 UUID，但 `files/` 和 `diffs/` 下常有多个 UUID 文件（含 `metadata` 未列出的），说明 UUID 是逐次快照/文件版本标识。

### 3.3 `diffs/` 是什么
每个 `diffs/<uuid>` 是 **UTF-8 JSON**（`file(1)` 判定 `JSON data`），字段：

```
fsPath, fileUuid, fileSizeBytes, numLines, diffChanges[], gitInfo, kind
```

- `kind`: 全为 `"KIND_MODIFIED"`（本机 12 个 diff 文件均如此）。
- `gitInfo`: `{"noRepoFound": true}`（本机样本全为无仓库）。
- `diffChanges[]`: 行级变更数组，每项键为
  `originalStartLineNumberOneIndexed`, `originalEndLineNumberExclusiveOneIndexed`,
  `modifiedStartLineNumberOneIndexed`, `modifiedEndLineNumberExclusiveOneIndexed`,
  `addedLines: string[]`, `tokenizedAddedLines: number[]`。
  例：`d45e434d.../diffs/015b886f...` 有 4 个 change，其中 `[0]` 是 `orig 2..3 → mod 2..3`，`addedLines[0]="""On usage-limit / network-error stop: ..."`；`[2]` 是 `orig 37..37 → mod 40..83`（大段新增）。

**没有 `removedLines` 字段**：本机样本只记录了 `addedLines`（新增/替换后的行），删除通过 `originalEnd...` 区间表达。diff 以「行号区间 + addedLines 数组 + tokenized 数字」的 JSON 格式存，不是 unified diff 文本，也不是文件全文。`tokenizedAddedLines` 是整数数组（如 `1000001, 1, 1000002, ...`），具体编码语义**未验证**。

### 3.4 `files/` 是什么、哪边是 before/after
`files/` 与 `diffs/` 用同一组 UUID 命名。本机 12 个 `files/` 成员中：9 个为 **0 字节**（空），3 个（`d45e434d...` 下）为 **1401 字节**。读取那个非空 `files/015b886f...`（1401 字节）得到的是**该 .py 文件的整文件文本**（`#!/usr/bin/env python3` 开头、54 行、`from __future__ import annotations` 等），不是 diff、不是 JSON。

对比同一 UUID 的 `diffs/015b886f...`：
- `files/` 中 docstring 为 `"""On usage-limit stop: after auto account switch, send 继续 in THIS chat only.`（**较早版本**）；
- `diffs/` 的 `diffChanges[0].addedLines[0]` 为 `"""On usage-limit / network-error stop: after auto account switch, send 继续 in THIS chat only.`（**较新/改动后版本**）。

因此可以判定（本机样本）：**`files/` 存的是改动前/较早的整文件快照，`diffs/` 的 `addedLines` 表达改动后内容**。但必须强调限制：
- 这是从「内容不一致」推断的（docstring 文本差异），不是从字段名直接读到 `before`/`after` 标签；**字段级语义标注未验证**。
- 9/12 的 `files/` 为空，说明「`files/` 必存 before 全文」并不成立，可能是仅在某些条件下捕获。
- 同一 checkpoint 内多个 UUID 的 `diffs/` 内容**逐字节相同**（如 `1f59fae8` 下两个 diff 均 40705 字节、`d45e434d` 下三个均 11549 字节），即重复快照，不是「一个 before 一个 after」的配对目录。

**回答 Q2**：`files/` = 整文件快照（本机非空样本为改动前/较早全文，多数为空）；`diffs/` = 结构化行级 diff JSON（`addedLines` 为改动后新增行）。哪边 before/after 不能仅凭目录名断定，本机证据支持「files/ 偏 before、diffs/ 偏 after」，但存在空文件与重复文件，标为部分验证。

---

## 四、VS Code 原生原语

被测内核：`/Users/xmly/.dsh/editor-runtime/node_modules/code-server/lib/vscode/package.json` → `"version": "1.145.2"`。源码在 `out/` 下为压缩 JS，以下用字节偏移定位。**官方文档**（均 HTTP 200 可达）：
- `https://code.visualstudio.com/api/references/vscode-api`（及 `.md`）
- `https://code.visualstudio.com/api/references/commands`
- `https://code.visualstudio.com/api/extension-guides/virtual-documents`

### 4.1 `vscode.diff`
- 官方命令表（`https://code.visualstudio.com/api/references/commands`）："`vscode.diff` - Opens the provided resources in the diff editor to compare their contents." 参数 `_left_`、`_right_`、`_title_`、`_options_ (optional)`。
- 内核注册：`out/vs/workbench/api/node/extensionHostProcess.js @ 1558604`（grep `new ze("vscode.diff"`）：`new ze("vscode.diff","_workbench.diff","Opens the provided resources...", [se.Uri.with("left"...), se.Uri.with("right"...), se.String.with("title").optional(), columnOrOptions.optional()], Be.Void)`。
- 实际 handler：`out/vs/code/browser/workbench/workbench.js @ 6731878`（grep `id:"vscode.diff"`）：`openEditor({original:{resource:Uri.from(e,true)}, modified:{resource:Uri.from(t,true)}, label, description, options})`。即 **left = original，right = modified**，两侧都必须是 `Uri`（`A.from(...,true)` 会从参数恢复 Uri）。
- 约束：`commands.executeCommand` 传编辑器命令参数时只允许基本类型 + `Position/Range/Uri/Location`（官方文档 `https://code.visualstudio.com/api/references/vscode-api` "commands.executeCommand" Note 1）。

### 4.2 `vscode.changes`（多文件变更视图）
- 官方命令表：`"vscode.changes - Opens a list of resources in the changes editor to compare their contents."` 参数 `_title_`、`_resourceList_`。
- 内核描述符：`extensionHostProcess.js @ 1559080-1559440`（grep `new ze("vscode.changes"`）：

```
new ze("vscode.changes","_workbench.changes","Opens a list of resources in the changes editor...",
  [ se.String.with("title"...),
    new se("resourceList","List of resources to compare", r=>{
        for(let t of r){ if(t.length!==3) return false;
          let [e,n,o]=t;
          if(!isUri(e) || !isUri(n)&&n!==undefined&&n!==null || !isUri(o)&&o!==undefined&&o!==null) return false }
        return true }, r=>r) ], Be.Void)
```

**约束（硬）**：`resourceList` 是数组，每一项**必须长度为 3**；第 1 个必须是 `Uri`；第 2、3 个必须是 `Uri` 或 `undefined`/`null`。这与 CodeBuddy `buildDiff` 返回的 `[Uri.file(path), beforeUri, afterUri]` 三元组完全对应（见 2.2/2.3）。命令在 workbench 侧的别名是 `_workbench.changes`（`workbench.js @ 6732783 / @ 6732843`），CodeBuddy 正是优先探测它并附 `{isTransient:true}`。

### 4.3 `TextDocumentContentProvider`（自定义 scheme 只读虚拟文档）
- 官方指南（`https://code.visualstudio.com/api/extension-guides/virtual-documents`）："The text document content provider API allows you to create **readonly** documents ... The API works by claiming an uri-scheme ... The scheme must be provided when registering a provider and **cannot change afterwards** ... A provider must only implement `provideTextDocumentContent` ... content providers are wired into the open document logic"；可用 `onDidChange` EventEmitter 刷新；虚拟文档会出现在 `workspace.textDocuments` 等事件中，扩展须检查 `scheme`。
- 内核：`extensionHostProcess.js @ 1686176`（grep `registerTextDocumentContentProvider`）：`if(Object.keys(z).indexOf(t)>=0) throw new Error("scheme '"+t+"' already registered")`——**不能注册已保留/已占用 scheme**；随后 `$registerTextContentProvider(handle, scheme)`；`onDidChange` 事件里若 `uri.scheme !== scheme` 会被忽略并告警。
- 回答「扩展能否用自定义 scheme 注册只读虚拟文档再传给 `vscode.diff`」：**能**。官方明确 readonly + 接入 open document 逻辑；CodeBuddy `genie-diff` 是本机实证（见 2.2）。

### 4.4 `WorkspaceEdit` / `applyEdit`
- 内核：`extensionHostProcess.js @ 2118433`（grep `applyEdit(S,C)`）：workspace 命名空间对象里 `applyEdit(S,C){ return EW.applyWorkspaceEdit(S,P,C) }`，`S` 为 `WorkspaceEdit`。`@ 1551691 / @ 1562550 / @ 2118463` 有 `WorkspaceEdit` 类定义。
- 官方文档 `https://code.visualstudio.com/api/references/vscode-api` 中 `workspace.applyEdit` 与 `WorkspaceEdit` 有签名（页面可见 "compiled from vscode.d.ts"）。本次未逐字抓取 `applyEdit` 完整 JSDoc，**其「一次性原子应用、跨文件、可含 createFile/renameFile/deleteFile」等语义细节未在本报告中作结论**，只确认内核存在该 API 且签名为 `applyEdit(edit: WorkspaceEdit, ...)`。

---

## 五、本项目现状核实（重点：事件流是否已有 workspace/changes）

### 5.1 SSE 白名单：确实把 `workspace/changes` 过滤掉了
`/Users/xmly/dsh-editor-mode/sessions.js:51-63`：

```js
const UI_EVENT_TYPES = new Set([
  'user/message', 'assistant/message', 'tool/call', 'tool/result',
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'session/title', 'approval/asked', 'approval/decided',
]);
```

`sessions.js:397-408`：

```js
} else if (type === 'event') {
  const event = frame.event ?? frame;
  const name = event?.type ?? '';
  if (UI_EVENT_TYPES.has(name)) {
    sse.write('session-event', { type: name, seq: event?.seq ?? null, data: event?.data ?? null });
  }
}
```

`type === 'event'` 的帧**只有命中白名单才写成 `session-event`**；未命中的持久事件被静默丢弃（注释 `:400-401` 说明是为了挡掉 `system/message` 里 19KB 系统提示）。`workspace/changes` 不在集合里 → **不透传给前端**。前端 `extension.js:589-635`（`case 'session-event'`）也只处理 `tool/call`、`tool/result`、`turn/end`、`session/title`，`default` 直接 break；`media/chat.js:484` 起的 `message` 监听同样没有 changes 分支。全仓 `grep -rn "workspace/changes|vscode.diff|TextDocumentContentProvider|vscode.changes"` 在源码中 0 处引用（仅 `session-ad1cea64-content.md`/计划文档里作为待办提到）。

结论：**本项目 SSE 流现在没有把 `workspace/changes` 透传给前端**；要展示改动列表，第一步是把该事件加入白名单（或另开通道）。

### 5.2 事件的数据形状：只有 `{turn}`，不能直接撑起文件列表
DSH 内核（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`，213,240,777 字节，只读按偏移检索）的类型声明给出精确形状：

- `@ 19201069`（grep `'workspace/changes': { turn: number; }`）：`SessionEventMap` 中 `'workspace/changes': { turn: number; }`，且 `SessionEventType = keyof SessionEventMap`。
- `@ 22304647`（grep `"workspace/changes"` 在 `KNOWN_EVENT_TYPES` 集合里）：该事件是已知持久事件类型之一。
- `@ 28724162`（grep `function isChangesEvent`）：`return isRecord(value) && Number.isSafeInteger(value.turn) && value.turn >= 1;`——校验器只要求 `turn`。
- `@ 143947662`（grep `this.session.append("workspace/changes", { turn: state.turn })`）：记录器实际 append 的就是 `{turn}`。

所以**事件本身不含文件路径、行数、diff**。改动文件列表必须按「事件 seq」向 Host 再取摘要：

- 路由常量 `@ 28720794 / @ 28853855`（grep `/api/changes.summary`）：`CHANGED_FILES_PATH="/api/changes.summary"`、`CHANGES_DIFF_PATH="/api/changes.diff"`、`CHANGES_OPEN_PATH="/api/changes.open"`；注册见 `@ 28856241`（`ctx.connection.fetch.register({path: CHANGED_FILES_PATH, methods:["GET"], ...})`）与 `@ 28856735`（`routes` 数组）。
- 客户端 URL 构造 `@ 28724500`（grep `changesSummaryUrl`）：`CHANGED_FILES_ROUTE?sessionId=&seq=<seq>`；diff 为 `...&index=<i>`（`@ 28724945`）。
- Host handler `@ 28860400`（grep `function handleChangesSummary`）：`ctx.workspaceChanges.summary(id, seq)` → `Response.json({turn, files, total, added, deleted})`；`undefined` 时 404。
- 服务契约 `@ 124290134`（grep `summary(sessionId: SessionId, seq: number)` 与 `diff(...)`）：
  - `summary(sessionId, seq): WorkspaceChangesSummary | undefined`
  - `diff(sessionId, seq, index, signal): Promise<WorkspaceFileDiff | undefined>`
- 类型 `@ 124654009`（grep `name: 'WorkspaceChangedFile'` / `WorkspaceChangesSummary` / `WorkspaceDiffHunk` / `WorkspaceFileDiff`）：

```
WorkspaceChangedFile { path, display, added, deleted, binary?: true, oversized?: true }
WorkspaceChangesSummary { turn, cwd, files: WorkspaceChangedFile[], total, added, deleted, snapshot?: {before, after} }
WorkspaceDiffHunk { oldStart, oldLines, newStart, newLines, lines: string[] }
WorkspaceFileDiff = {kind:'text', path, display, before, after, hunks: WorkspaceDiffHunk[], coarse:boolean}
                  | {kind:'binary', path, display} | {kind:'oversized', path, display}
```

**回答 Q4**：透传 = 否；形状 = `{turn:number}`，**不能直接**撑起改动文件列表，但「事件 seq + `/api/changes.summary`」可以拿到完整 `files[]`（含 path/display/added/deleted），再 `/api/changes.diff` 拿逐文件 hunks。这是本项目改造最省力的数据来源。

### 5.3 前端承接改动点（只读定位）
- `sessions.js:51` 白名单、`sessions.js:402` 过滤判断；
- `extensions/local.dsh-editor-bridge-0.3.0/extension.js:589` `case 'session-event'`；
- `extensions/local.dsh-editor-bridge-0.3.0/media/chat.js:484` `window.addEventListener('message', ...)`；
- `extensions/local.dsh-editor-bridge-0.3.0/sse.js` 是通用 SSE 解析（不支持也不排斥新事件名）。

---

## 六、DSH rewind 快照可复用性（关键前置）

被测：`/Users/xmly/.dsh/profiles/desktop/node_modules/dsh-rewind-plugin/`（`package.json` → `name=dsh-rewind-plugin`, `version=0.22.0`, `main=lib/index.js`, `exports` 含 `./client`, `./package.json`, `./locale/*`；peer 依赖大量 `@deepseek-ai/dsh-*`）。

### 6.1 对外暴露面：没有「读取某快照某文件内容」接口
- `lib/index.js:2290-2299` 导出：`Config, DEFAULT_FILE_CHECKPOINTING_ENABLED, ENGINE_COMMAND, SnapshotStore, apply, inject, name, profileEntryKey`。
- `lib/index.js:1639`：`var inject = ["commands", "tools", "settings"];`——**没有向 cordis 注册任何服务**（全文 grep `ctx.set`/`ctx.provide`/`service(` 无匹配，见检索记录），`inject` 只是声明它依赖哪些服务，不是它提供什么。
- 全文没有 `workspaceChanges` 字样；`SnapshotStore` 虽被导出（类定义 `lib/index.js:784` 起），但那是类本身，不是「外部插件通过 `ctx.get('...')` 可取到的实例」；本次**未验证** DSH 是否把该 store 以服务名挂进 ctx，也**未验证**外部插件可否 `import { SnapshotStore } from 'dsh-rewind-plugin'` 后直接读到别的会话正在用的临时快照目录（其目录 `SNAPSHOT_DIR_NAME="rewind-snapshots"` 在 `:774`，`versions/` 内文件名 `pathHash@vN` 在 `:559`）。

### 6.2 它对外只有「Client UI 用 HTTP 路由」和「命令」
- `lib/index.js:1641-1642`：`REWIND_PREVIEW_PATH="/api/dsh-rewind/preview"`、`REWIND_CANDIDATES_PATH="/api/dsh-rewind/candidates"`；注册于 `:2253-2260`（`connection.fetch.register`，`methods:["POST"]`）。
- `lib/index.js:1773-1802`（`createRewindQueryHandler`）：请求体 `{sessionId}`，`preview` 需 `{seq}`，返回 `previewImpact(...)`；`candidates` 返回 `listRewindCandidates(...)`。返回的是**rewind 候选与影响文件列表**（`previewImpact` 定义 `:1746`，`store.preview()` 见 `:947-954` 返回 `{files:[{path,action}], uncovered}`），**不是「某快照里某文件的 before/after 全文」**。
- 命令：`/rewind`、`/undo`、`snapshot-auto-cleanup`、`rewind-plugin`（内部引擎命令，`:2180` 起 `ctx.commands.register`）。均为「执行回退/清理」，不是读取接口。
- `lib/client.js:28-35` 导出 `apply, inject, name`，是纯 Client UI（注入 `uiConversation`、渲染 popover/action，见 `:764` 起 `NS="dsh-rewind"`、`installOn` 等），进一步印证这是「界面插件」而非「数据服务」。

### 6.3 结论与替代方案
**回答 Q5 / 前置结论**：`dsh-rewind-plugin` **不可直接复用**为「读取某会话某快照里某文件内容」的接口；它是 cordis 插件 + 命令 + 两条 Client UI HTTP 路由 + 纯 Client UI，没有可被 editor-mode 调用的 cordis service / command / 文件读取 API。标为「未验证 / 不可直接复用」（未验证项见第八节：是否有隐藏的 ctx 服务挂载、store 实例能否被外部拿到）。

替代方案（均有本次一手证据支撑）：
1. **首选：复用 DSH 自带 `workspaceChanges` 服务 + 三条认证路由**（第五节）。它专门做「每轮改动文件列表 + 逐文件 before/after hunks」，数据形状 `WorkspaceChangesSummary`/`WorkspaceFileDiff` 已定义，Host 端 `ctx.workspaceChanges.summary()/diff()` 与 `/api/changes.*` 路由已注册。副作用：只需在 editor-mode 的 SSE/HTTP 层转发这几个路由或把事件透传给 webview。
2. **自己存 before 内容**：CodeBuddy 的 `file-changes/` 做法（`diff` 文本 + `originalFileContent` 全文，见 2.5）或 DSH `dsh-workspace-changes` README 描述的「文件工具首次编辑前整文件拷贝 + 轮末再拷贝」（app.asar `@ 143894343`、`@ 143937732`）。
3. **git**：`dsh-workspace-changes` 在有仓库时用「轮初/轮末 git 工作树快照 diff」，`@ 143894343`、`@ 143898742` 明确说明其实现与「无仓库/无 git 时只列文件工具编辑」的限制。

---

## 七、共性归纳与对本项目的影响

### 7.1 三种（实为四种）实现对比

| 维度 | CodeBuddy CN（VS Code 扩展） | Cursor（本机遗留数据） | DSH 自带 `dsh-workspace-changes` + Web | VS Code 原生原语（共同底座） |
|---|---|---|---|---|
| 改动检测/存储 | 自有 checkpoint/version + `editCodeData.originalFileContent`；落盘 `file-changes/*.json`（unified diff + 全文） | `checkpoints/<id>/files/`（整文件快照）+ `diffs/`（行级 JSON `addedLines`） | git 工作树轮初/轮末快照 + 文件工具编辑前后整文件拷贝；临时目录，Session 存活期有效 | 无检测能力，只提供展示/编辑 API |
| 展示入口 | `genie-diff:` 虚拟文档 → `vscode.diff`；多文件 `vscode.changes`/`_workbench.changes`；老版 QuickPick 降级 | 未验证（Cursor.app 已删，无 UI 源码；官方 Agent Review 页见下） | 右侧栏 `changes-review` tab（`dsh-resource://changes-review/session/<id>/<seq>/<turn>`）+ 改动文件卡片 | `vscode.diff`(2 Uri)、`vscode.changes`(三元组列表)、`TextDocumentContentProvider`(readonly scheme)、`applyEdit` |
| 「改动前」来源 | 自有版本服务 / `genie.getFoldedBaseline` / `originalFileContent` | `files/` 整文件快照（部分为空） | `ctx.workspaceChanges.diff()` → 两棵快照树/两份拷贝 | 由调用方提供 left Uri 内容 |
| diff 数据形状 | unified diff 字符串 + 全文 | `diffChanges[]{行号区间, addedLines[], tokenizedAddedLines[]}` | `WorkspaceDiffHunk{oldStart,oldLines,newStart,newLines,lines[]}` + `binary/oversized/coarse` | 由编辑器内核计算 |
| 生命周期 | 持久化到 globalStorage | 持久化到 globalStorage | **仅 Host 进程内、Session 存活期**；Host 重启/会话释放后摘要与对比失效（app.asar `@ 143914578`、`@ 143903127`） | 无状态 |

Cursor 官方文档补充：`https://cursor.com/docs` 可达（HTTP 200），导航含 "Agent Review"；`https://cursor.com/docs/agent/agent-review` 可达，内容为「对本地改动跑一次专用 code review」，三种触发方式（自动/`/agent-review`/Source Control tab）、Quick/Deep 两种深度、读 `BUGBOT.md`。**但该页描述的是「跑代码审查」，不是「侧栏逐文件 diff 审阅 UI」**，与本机 `diffs/` 数据的直接 UI 映射**未验证**。

### 7.2 共性归纳（≥3 种实现共同点）
1. **「改动前内容」都要自己留一份**：CodeBuddy 存 `originalFileContent`、Cursor 存 `files/` 整文件、DSH 存两份整文件拷贝或 git 快照——没有一家靠「事后从 git 反推」单独完成（DSH 明确把 git 作为其中一条覆盖路径并用整文件拷贝补 git 覆盖不到的文件）。
2. **上层只用「三元组/两侧 Uri」对接编辑器**：CodeBuddy `buildDiff` 产出 `[filePath, before, after][]` 正好喂给 `vscode.changes` 的 `[Uri,Uri,Uri]` 约束；单文件走 `vscode.diff(left,right,title)`。
3. **自定义 scheme 只读虚拟文档是承接「内存中的 before 文本」的标准手段**：官方文档 + CodeBuddy `genie-diff` 双证。
4. **事件/摘要分离**：DSH 把 `workspace/changes` 设计成「只带 turn 的宣告事件」，重数据放 Host 路由按需取；CodeBuddy 则把重数据落盘 `file-changes/`。两者都避免把大 diff 塞进会话事件流。

### 7.3 与本项目现状的兼容点 / 冲突点
**兼容点**
- 本项目编辑器内核就是 VS Code 1.145.2（第四节），`vscode.diff`/`vscode.changes`/`TextDocumentContentProvider` 全部可用，无需改内核。
- 本项目侧栏 Chat 已是 DSH 真实会话的第二视图（`sessions.js` 的 `follow()` 帧已解包成 SSE），加一个事件类型 + 一个 webview 卡片是增量改动。
- DSH Host 已有 `workspaceChanges` 服务与 `/api/changes.*` 路由（第五节），且 `index.js` 里已有 `webServer.register`/反向代理与 `sseWriter`（`index.js:270-333, 455`），转发认证路由的技术路径存在。

**冲突点 / 需注意**
- **白名单冲突**：`sessions.js:51` 的 `UI_EVENT_TYPES` 当前挡掉 `workspace/changes`；且该白名单的注释明确是为「挡掉大 payload」设计的，直接把事件 `data` 透传没有意义（只有 `{turn}`），必须配套「按 seq 拉取摘要」的逻辑，否则前端拿到的仍不是文件列表。
- **生命周期冲突**：DSH 摘要/对比「只在本 Host 进程内随 Session 存活」（app.asar `@ 143914578`），本项目若把列表缓存到 webview，Host 重启后会 404，需要像官方实现那样「读取未完成时/Host 答复 gone 时不显示卡片」（`@ 28691020`）。
- **前置依赖落空**：计划文档 `docs/autopilot/plans/editor-mode-backlog/checklist.md:13` 写「不自建 restore（复用 DSH rewind 快照）」，但第六节证明 rewind **无外部可读接口**；该前置假设不成立，应改为复用 `workspaceChanges` 或自建 before 存储。
- **跨 origin/认证**：`/api/changes.summary` 等是「authenticated route」（`@ 28720794` 注释、`@ 28856241` 注册），本项目已有 `tokenFromRequest`/`loopbackOnly` 机制（`sessions.js:358`、`index.js`），转发时需保留认证坐标；本次**未验证**跨 origin iframe 下这些路由的令牌如何透传（列为未验证项）。
- **路由冲突教训**：项目 skill 记录「code-server 多条 WebSocket 动态路径与 DSH `registerUpgrade`（仅 exact path）冲突」，本次新增的是 HTTP GET 路由而非 WebSocket，不直接冲突，但仍需按 `webServer.register` 既有约定声明式注入（`inject=['webServer']`），不要在 `apply` 里 throw。

---

## 八、未验证项

以下在本次只读核查范围内**没有找到可靠一手证据**，明确不写结论：

1. **Cursor 侧栏 UI 如何渲染 `diffs/`**：`/Applications/Cursor.app` 已删除，无 UI 源码；官方 `https://cursor.com/docs/agent/agent-review` 只讲「跑 code review」，未建立与本机 `diffs/` 字段的 UI 映射。`files/` 的 `before/after` 字段级语义、空文件触发条件、`tokenizedAddedLines` 编码语义，均**未验证**（第三节仅给出基于内容差异的推断）。
2. **`agent-diff` scheme 的 provider 全文实现**：CodeBuddy bundle 中只找到 URI 生成/解析函数（`@ 18267792`），其 `provideTextDocumentContent` 如何按 `versionId` 取快照全文**未验证**。
3. **CodeBuddy `CheckpointService` 内部存储格式**：只见到 DI 元数据与 `getAllVersions/getHunkStates` 调用点，checkpoint 文件落盘格式**未验证**（`file-changes/` 是另一套 artifact 记录，不等同 checkpoint 本体）。
4. **rewind 是否有隐藏的 ctx 服务实例 / `SnapshotStore` 能否被外部 import 后读到活会话快照**：导出里有 `SnapshotStore` 类，但「DSH 是否把它挂成可取服务」「临时目录是否可被 editor-mode 进程直接读」**未验证**。结论仍按「不可直接复用」处理。
5. **`workspace.applyEdit` 的原子性/跨文件/资源操作语义**：只确认内核存在 `applyEdit(WorkspaceEdit)`（`@ 2118433`），未逐字抓取官方 JSDoc，细节不作结论。
6. **`vscode.changes` 在 code-server web 环境的实际可用性**：命令已注册（`workbench.js @ 6732783`），但「web 版 diff/changes editor 是否完整可用」本次未运行验证（只读要求禁止启动）。CodeBuddy 自己用 `getCommands().includes(...)` 运行时探测并降级，说明存在版本差异。
7. **`/api/changes.*` 路由的认证令牌如何经本项目跨 origin iframe 透传**：路由确认为 authenticated，但本项目 webview 与其回环代理之间的令牌链路**未验证**。
8. **官方 `https://code.visualstudio.com/api/references/vscode-api` 页面上 `TextDocumentContentProvider`/`WorkspaceEdit` 的逐字签名**：页面可达但内容截断，已用 `https://code.visualstudio.com/api/extension-guides/virtual-documents` 与本机内核源码交叉印证核心结论；逐字 JSDoc 未作为引用。
9. **DSH `dsh-workspace-changes` 是否在用户当前 profile 默认启用**：app.asar 内 README 写「The shipped Web bundle mounts this plugin」（`@ 143894343` 附近），但当前 profile 的启用状态、以及本项目 editor-mode 的 Host 进程是否加载了它，**未验证**（只读且未启动 DSH）。

---

## 九、参考来源

### 本机一手文件
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/package.json`（coding-copilot 3.10.0 / Tencent-Cloud / engines.vscode ^1.70.2）
- `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/out/extension/index.js`（22,070,782 B）：`@ 653858`（`Qn="genie-diff"`/`FileUtils`）、`@ 656726`（`vscode.diff` 单文件入口）、`@ 1188588`（`ReadonlyPlanProvider`）、`@ 1723753`（`CraftVersionController`/`CheckpointService` DI）、`@ 18245073`（`ProductTextDocumentContentProvider`, scheme `codebuddy`）、`@ 18267792`（`DIFF_URI_SCHEME="agent-diff"`）、`@ 3736197`（`showFileChanges`）、`@ 3738600`/`@ 3739689`（`genie.getFoldedBaseline`/`toGenieDiffUri`/三元组）、`@ 3741343`（`vscodeChanges.executeChanges`）、`@ 4912409`（`openDiffUtilsImp`/`vscode.diff`）、`@ 5061121`（`DIFF_VIEW_URI_SCHEME`）、`@ 5558685`（`InlineChatAcceptCommand`）、`@ 5683945`（`saveFileChanges`）、`@ 5689530`（`readDiskFileChanges`）、`@ 8278563`/`@ 8279570`（`VSCodeChangesImpl`/兼容路径）、`@ 17555408`（`genie.createDiffZoneFromVersion`）、`@ 19347261`（`GenieDiffContentProviderService`）、`@ 807155`（`CheckpointService` DI）
- `~/Library/Application Support/CodeBuddy CN/User/globalStorage/tencent-cloud.coding-copilot/file-changes/e8dc5c51e2e345f39c2fc5029ea58ce1/CrossScenePkPanelService.java_2f5a8124.json`（样本 JSON 字段与 `diff`/`ideState`）
- `~/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-retrieval/checkpoints/*/metadata.json`（5 个）、`*/diffs/*`（12 个 JSON）、`*/files/*`（12 个，9 空 3 非空）
- `/Users/xmly/.dsh/editor-runtime/node_modules/code-server/lib/vscode/package.json`（`1.145.2`）
- `/Users/xmly/.dsh/editor-runtime/node_modules/code-server/lib/vscode/out/vs/workbench/api/node/extensionHostProcess.js`：`@ 1558604`（`vscode.diff` 描述符）、`@ 1559080`（`vscode.changes` 描述符 + resourceList 校验）、`@ 1686176`（`registerTextDocumentContentProvider`）、`@ 2118433`（`applyEdit`）
- `/Users/xmly/.dsh/editor-runtime/node_modules/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js`：`@ 6731878`（`vscode.diff` handler）、`@ 6732783`/`@ 6732843`（`vscode.changes`/`_workbench.changes`）
- `/Users/xmly/dsh-editor-mode/sessions.js:51-63, 344-425`（`UI_EVENT_TYPES`、SSE 过滤）、`/Users/xmly/dsh-editor-mode/index.js:270-333, 455`（代理与 sseWriter）、`/Users/xmly/dsh-editor-mode/extensions/local.dsh-editor-bridge-0.3.0/extension.js:589-635`、`media/chat.js:484`、`sse.js`
- `/Users/xmly/dsh-editor-mode/docs/autopilot/plans/editor-mode-backlog/checklist.md:13`（既有计划里的「复用 DSH rewind 快照」假设）
- `/Users/xmly/.dsh/profiles/desktop/node_modules/dsh-rewind-plugin/package.json`、`lib/index.js:529-640, 774-800, 947-1000, 1639, 1641-1642, 1746, 1773-1802, 2125-2299`、`lib/client.js:28-35, 764-851`
- `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（213,240,777 B）：`@ 19201069`（`SessionEventMap` 的 `workspace/changes:{turn}`）、`@ 22304647`（`KNOWN_EVENT_TYPES`）、`@ 124290134`（`workspaceChanges` 服务契约）、`@ 124654009`/`@ 124655243`/`@ 124656471`（`WorkspaceChangedFile`/`WorkspaceChangesSummary`/`WorkspaceDiffHunk`/`WorkspaceFileDiff` 类型声明）、`@ 143893618-143905000`（`@deepseek-ai/dsh-workspace-changes` README）、`@ 143914578`/`@ 143903127`（生命周期限制）、`@ 143947662`（`session.append("workspace/changes",{turn})`）、`@ 28691020`/`@ 28708702`（改动文件卡片 README）、`@ 28693060`/`@ 28698109`（review tab）、`@ 28720794`/`@ 28853855`（路由常量）、`@ 28721309`/`@ 28724500`/`@ 28724945`（URL 构造）、`@ 28723023`/`@ 28724162`（`isHunk`/`isChangesEvent`）、`@ 28726153`（`changesReviewAddress`）、`@ 28856241`/`@ 28856735`（路由注册）、`@ 28860400`（`handleChangesSummary`）

### 官方文档（均为 HTTP 200 可达）
- `https://code.visualstudio.com/api/references/vscode-api` 与 `https://code.visualstudio.com/api/references/vscode-api.md`（编译自 `src/vscode-dts/vscode.d.ts`；`commands.executeCommand` 参数类型约束）
- `https://code.visualstudio.com/api/references/commands`（`vscode.diff`、`vscode.changes` 官方命令表）
- `https://code.visualstudio.com/api/extension-guides/virtual-documents`（`TextDocumentContentProvider` readonly、scheme 固定、`onDidChange`、虚拟文档出现在 `workspace.textDocuments`）
- `https://cursor.com/docs`（导航含 Agent Review）
- `https://cursor.com/docs/agent/agent-review`（Agent Review 的触发方式/深度/BUGBOT.md；**非** diff 侧栏 UI 规范）
