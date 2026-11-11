/**
 * DSH Editor Bridge —— VS Code 扩展（Node 扩展主机）。
 *
 * 作用：把当前文件/选区通过 HTTP POST 送到 DSH 插件的 /editor-bridge/push 端点，
 * 由 DSH Client 轮询取走并注入 Agents 输入框。
 *
 * 为什么用 HTTP 而不是 window.postMessage：
 *   code-server 的扩展运行在 Node 扩展主机（无 DOM），且 iframe(VS Code) 与
 *   DSH 父页面跨 origin；HTTP 到 DSH 回环端点是最可靠的单向通道。
 *
 * 连接参数由 Host 插件通过环境变量注入（spawn code-server 时）：
 *   DSH_BRIDGE_URL   —— http://127.0.0.1:<dsh-port>/editor-bridge/push
 *   DSH_BRIDGE_TOKEN —— 一次性随机 token，防止同机其它进程注入
 */

const vscode = require('vscode');
const http = require('node:http');
const https = require('node:https');

/** 格式化要送进 Agents 输入框的文本。 */
function formatPayload(file, line, text) {
  const loc = file ? `@${file}${line ? `:${line}` : ''}` : '';
  if (!text) return loc ? `请看一下 ${loc}` : '';
  return `${loc ? `${loc}\n` : ''}\`\`\`\n${text}\n\`\`\`\n`;
}

/** POST 到 DSH 桥接端点；失败只记日志，不打断用户操作。 */
function push(payload) {
  const url = process.env.DSH_BRIDGE_URL;
  const token = process.env.DSH_BRIDGE_TOKEN;
  if (!url || !token) return;
  try {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const body = JSON.stringify({
      token,
      file: payload.file,
      line: payload.line,
      text: payload.text,
    });
    const req = lib.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 3000,
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch { /* URL 非法时静默 */ }
}

/** 从当前活动编辑器收集文件、行号、选区文本。 */
function collect(includeSelection) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const doc = editor.document;
  const file = doc.uri.scheme === 'file' ? doc.uri.fsPath : doc.uri.toString();
  const sel = editor.selection;
  const line = sel ? sel.start.line + 1 : 1;
  const text = includeSelection && sel && !sel.isEmpty ? doc.getText(sel) : '';
  return { file, line, text };
}

function activate(context) {
  const send = (includeSelection) => {
    const data = collect(includeSelection);
    if (!data) {
      vscode.window.showInformationMessage('没有打开的编辑器');
      return;
    }
    const formatted = formatPayload(data.file, data.line, data.text);
    push({ file: data.file, line: data.line, text: formatted });
    vscode.window.setStatusBarMessage('已发送给 DSH Agents', 2000);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('dshEditorBridge.sendSelection', () => send(true)),
    vscode.commands.registerCommand('dshEditorBridge.sendFile', () => send(false)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
