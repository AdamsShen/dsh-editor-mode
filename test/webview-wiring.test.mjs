/**
 * 测试：webview 与扩展的接线自洽性（静态检查）。
 *
 * 这类错误（模板占位符没替换、菜单引用了不存在的命令、视图 id 与代码不一致）
 * 不会在 node --check 里暴露，但会直接导致侧栏空白或按钮点了没反应，
 * 所以用静态断言把它们挡在提交前。
 *
 * 用法：node test/webview-wiring.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..', 'extensions', 'local.dsh-editor-bridge-0.3.0');
const html = readFileSync(join(EXT, 'media', 'chat.html'), 'utf8');
const extensionSrc = readFileSync(join(EXT, 'extension.js'), 'utf8');
const chatSrc = readFileSync(join(EXT, 'media', 'chat.js'), 'utf8');
const cssSrc = readFileSync(join(EXT, 'media', 'chat.css'), 'utf8');
const manifest = JSON.parse(readFileSync(join(EXT, 'package.json'), 'utf8'));

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

console.log('模板占位符');
const placeholders = [...new Set([...html.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
check('chat.html 有占位符', placeholders.length > 0);
// 代码里是 /\{\{x\}\}/g 这种转义写法，去掉反斜杠后再比字面占位符。
const extensionUnescaped = extensionSrc.replace(/\\/g, '');
for (const name of placeholders) {
  check(
    `extension.js 替换了 {{${name}}}`,
    extensionUnescaped.includes(`{{${name}}}`),
    '模板里有但代码没替换 → webview 会拿到字面量 {{…}}',
  );
}

console.log('静态资源存在');
for (const file of ['chat.html', 'chat.css', 'chat.js', 'markdown.js', 'icon.svg']) {
  check(`media/${file} 存在`, existsSync(join(EXT, 'media', file)));
}
check('icon.svg 被 manifest 引用',
  JSON.stringify(manifest.contributes.viewsContainers).includes('media/icon.svg'));

console.log('右侧次级侧栏容器');
{
  const containers = manifest.contributes.viewsContainers || {};
  check('声明了 secondarySidebar 容器',
    Array.isArray(containers.secondarySidebar) && containers.secondarySidebar.length === 1,
    JSON.stringify(containers.secondarySidebar));
  const secondaryId = containers.secondarySidebar?.[0]?.id;
  const viewsInSecondary = (manifest.contributes.views || {})[secondaryId] || [];
  check('右侧容器里挂着 DSH Chat 视图',
    viewsInSecondary.some((v) => v.id === 'dshEditor.chat' && v.type === 'webview'),
    JSON.stringify(viewsInSecondary));
  const viewsInActivity = (manifest.contributes.views || {}).dshEditor || [];
  check('左侧结构保留（同一视图 id）',
    viewsInActivity.some((v) => v.id === 'dshEditor.chat'));
  check('两个容器的图标都存在', secondaryId && containers.secondarySidebar[0].icon);
}

console.log('manifest 与代码一致');
const viewIdInCode = /const VIEW_ID = '([^']+)'/.exec(extensionSrc)?.[1];
const viewIdInManifest = manifest.contributes.views.dshEditor?.[0]?.id;
check('视图 id 一致', viewIdInCode === viewIdInManifest, `${viewIdInCode} vs ${viewIdInManifest}`);

const commandIds = manifest.contributes.commands.map((c) => c.command);
check('所有命令都在代码里注册',
  commandIds.every((id) => extensionSrc.includes(`registerCommand('${id}'`)),
  commandIds.join(', '));

const menuCommands = [
  ...(manifest.contributes.menus?.['editor/context'] || []),
  ...(manifest.contributes.menus?.['view/title'] || []),
].map((item) => item.command);
// P1-2：资源管理器 / 终端入口 —— 菜单声明必须有对应实现
for (const [menu, cmd] of [
  ['explorer/context', 'dshEditorBridge.sendExplorerFiles'],
  ['explorer/context', 'dshEditorBridge.sendExplorerFolder'],
  ['terminal/context', 'dshEditorBridge.sendTerminalSelection'],
]) {
  const declared = (manifest.contributes.menus[menu] || []).some((m) => m.command === cmd);
  check(`${menu} 声明了 ${cmd.split('.')[1]}`, declared);
  check(`${cmd} 在代码里注册`, extensionSrc.includes(`registerCommand('${cmd}'`));
}
check('资源管理器入口按文件/目录分派',
  /explorerResourceIsFolder == (false|true)/.test(JSON.stringify(manifest.contributes.menus['explorer/context'])));
check('终端选区读到空内容时给提示', extensionSrc.includes('终端里没有选中内容'));

check('菜单只引用已声明的命令',
  menuCommands.every((id) => commandIds.includes(id)),
  menuCommands.join(', '));

check('activationEvents 覆盖视图与命令',
  ['onView:dshEditor.chat', ...commandIds.map((id) => `onCommand:${id}`)]
    .every((event) => manifest.activationEvents.includes(event)));

console.log('webview 与扩展消息协议');
const posted = [...new Set([...chatSrc.matchAll(/type:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]))];
const handled = [...new Set([...extensionSrc.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]))];
// 2026-11 协议（tab 条 + 历史覆盖层）：
//   - 会话切换/重命名；历史覆盖层用 listSessions(all) / searchSessions / openSession
//   - 模型选择与上下文开关并入会话本身；escalate 删除（Chat 本身就是 Agent）
for (const type of ['ready', 'send', 'stop', 'newChat', 'selectSession', 'renameSession', 'openFile',
  'listSessions', 'searchSessions', 'openSession', 'openChangeDiff']) {
  check(`webview 发出 ${type}，扩展有处理`, posted.includes(type) && handled.includes(type));
}
for (const type of ['state', 'append', 'reasoning', 'prefill', 'contextInfo', 'sessions', 'allSessions']) {
  check(`扩展会推 ${type}，webview 有处理`, chatSrc.includes(`case '${type}':`));
}

console.log('交互形态（对齐 CodeBuddy）');
check('顶部是 tab 条而非下拉框',
  chatSrc.includes('renderTabs') && !chatSrc.includes('id="session"') && html.includes('id="tabs"'),
  'tab 条应渲染到 #tabs，不再有 <select id=session>');
check('tab 不显示会话 id',
  !/sessionId\.slice|tab\.id\}\)[\s\S]{0,40}\.textContent/.test(chatSrc),
  'tab 标签只应来自标题或「新会话 N」');
check('历史是按钮触发的覆盖层',
  html.includes('id="history"') && html.includes('id="history-overlay"')
    && chatSrc.includes('showHistory'),
  '应有历史按钮 + 覆盖层 + showHistory');
check('覆盖层带返回按钮', html.includes('id="history-back"') && chatSrc.includes('historyBackBtn'));
check('已从 manifest 移除常驻历史视图',
  !JSON.stringify(manifest.contributes.views).includes('dshEditor.history'));

console.log('不会泄露 token 到 webview');
// P0-1：AI 改动 diff 审核
check('扩展注册了改动虚拟文档 provider',
  extensionSrc.includes('registerTextDocumentContentProvider') && extensionSrc.includes("DIFF_SCHEME"));
check('扩展用原生 vscode.diff 打开对比', extensionSrc.includes("'vscode.diff'"));
check('改动事件已接入扩展', extensionSrc.includes("type === 'workspace/changes'"));
check('扩展会拉改动列表', extensionSrc.includes('fetchChanges'));
check('扩展会拉单文件对比', extensionSrc.includes('fetchChangeDiff'));
check('历史折叠也会产出改动卡片', extensionSrc.includes('fillPendingChanges'));
check('webview 渲染改动卡片', chatSrc.includes('changesNode'));
check('改动卡片样式存在', cssSrc.includes('.changes-row'));
// 虚拟文档必须回收，否则长会话里累积整文件文本
check('虚拟文档有上限且会淘汰', extensionSrc.includes('DIFF_DOC_MAX') && extensionSrc.includes('rememberDiffDoc'));
check('文档关闭时释放', extensionSrc.includes('onDidCloseTextDocument'));
// 相对路径必须按「会话 cwd」解析，不能一律用当前工作区
check('相对路径按会话 cwd 解析', extensionSrc.includes('baseDirFor'));
check('key 用单调序号而非时间戳', extensionSrc.includes('diffDocSeq += 1'));
// 切行口径必须与 DSH 一致，否则 CRLF 文件会被一致性校验一律拒绝
check('切行走 splitLines 而非正则', extensionSrc.includes('sessionView.splitLines')
  && !/readFileSync\([^)]*\)\.split\(\/\\r\?/.test(extensionSrc));
check('after 侧用磁盘原文（不丢失末尾换行）', extensionSrc.includes('let afterText'));
// 并发加载：旧响应不得覆盖新列表（切 tab 快时会撞）
check('history 加载有代号守卫', extensionSrc.includes('historyGen')
  && extensionSrc.includes('me !== this.historyGen'));
check('过期加载结果被丢弃', /if \(me !== this\.historyGen\) return;/.test(extensionSrc));

// P1-1：@ 引用的消息通道两端必须成对，否则「选了但没插入」
check('webview 会发起 pickRef', chatSrc.includes("type: 'pickRef'"));
check('扩展处理 pickRef', extensionSrc.includes("case 'pickRef'"));
check('扩展回传 insertRef', extensionSrc.includes("type: 'insertRef'"));
check('webview 处理 insertRef', chatSrc.includes("case 'insertRef'"));
check('扩展有引用选择器', extensionSrc.includes('async pickReference('));
check('选择器含文件/目录/符号三类',
  extensionSrc.includes('findFiles(') && extensionSrc.includes('executeWorkspaceSymbolProvider'));


check('扩展没有把 token 放进 post 的消息',
  !/post\(\{[^}]*token/.test(extensionSrc),
  'token 只应在 Node 侧使用');

console.log(failed === 0 ? 'PASS: webview 接线自洽' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);