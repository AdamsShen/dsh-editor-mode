# dsh-editor-mode

DSH（DeepSeek Harness）编辑器模式插件：安装后在右上角切换 **Agents 对话** 与 **内置 VS Code 编辑器**。

编辑器内核使用 [code-server](https://github.com/coder/code-server) 4.145.2（MIT），
以 iframe 嵌入 DSH 主窗口；**不修改 VS Code / code-server 源码**，改动全部在 DSH 插件层。

> 当前形态（路线 A）：**一个 DSH 窗口内切换标签页**，不是「一个应用多个独立窗口」。
> DSH 的 Electron 主进程是单窗口架构（`mainWindow` 单例、`setWindowOpenHandler` 拒绝新窗口），
> 插件无法开出第二个窗口；多窗口形态需要改 DSH 内核或 fork VSCodium。

## 目录结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：拉起并托管 code-server 子进程、`/editor-status` 状态端点、`/editor/*` 反代占位、进程组清理 |
| `client.js` | Client 半边：`main` 全屏面板（key=`editor`）、`sidebar.panellist` 入口图标、`conversation.session.header.utilities` 右上角分段控件 |
| `cordis.patch.yml` | Loader patch，插入 `editor-mode` 行并声明 config |
| `package.json` | bundle 清单 + `dsh.client` 声明 |
| `locale/*.json` | 中英文展示元数据 |
| `icon.svg` | 插件图标 |

## 安装

### 1. 准备运行时（当前阶段需手动）

插件不自带运行时下载，需要本地先装好 code-server：

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

在 DSH 中通过 `plugin_manager` 的 `install_bundle` 安装本目录：

```
install_bundle(target="/absolute/path/to/dsh-editor-mode")
```

或直接把本仓库加入 profile 的 `dsh.profile.bundles`。

### 3. 配置（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `runtimeDir` | `~/.dsh/editor-runtime` | code-server 安装目录 |
| `upstreamHost` | `127.0.0.1` | 回环监听地址 |
| `upstreamPort` | `3999` | 首选回环端口（1..65535）；被占用时自动探测后续空闲端口 |
| `nodeBin` | `''` | 指定 node 可执行文件；留空自动探测 |
| `workspaceDir` | `''` | 打开的项目目录；留空回退到 `~/dsh-editor-mode` |

### 4. 使用

**刷新 GUI 页面**（client 是静态 bundle，HMR 不会自动推给已连接页面），
然后点右上角的「编辑器」或左侧栏的「编辑器」图标；点「Agents」或「返回 Agents」回到对话。

编辑器工具栏：

| 按钮 | 作用 |
|---|---|
| **打开目录** | 调用 DSH 的目录选择器选项目目录；只改 iframe 的 `?folder=` 参数，**无需重启** code-server |
| **重载** | 强制重建 iframe |
| **返回 Agents** | 回到 DSH 对话 |

标题栏会显示当前打开的目录路径。端口在配置值被占用时会自动向后探测空闲端口
（`[配置值, 配置值+20)`），实际地址通过 `/editor-status` 返回给 Client，无需手动改配置。

## 已知边界

- **iframe 直连回环**，非同源反代：code-server 的 WebSocket 走多条动态路径，而 DSH
  `registerUpgrade` 只支持 exact path，当前阶段无法覆盖；同源反代留到后续阶段。
- 跨 origin 由 `--trusted-origins '*'` + `--auth none` 放行，仅监听 `127.0.0.1`。
- 无 Config schema、无运行时自动下载/校验、无崩溃自动重启、无编辑器↔Agent 消息桥。
- 全局快捷键、下载、扩展 webview 在 iframe 内可能有损耗。
- 右侧可见的 **Chat 面板来自 code-server 自带功能**，不是 DSH 的 Agents 会话；
  两者联动（选中代码发给 Agent、Agent 改文件回显）属于后续阶段。

## 许可

插件代码 MIT。code-server 为 Coder 的 MIT 项目，VS Code 部分遵循其各自许可；
本仓库**不分发** code-server 二进制，运行时由使用者自行安装。
