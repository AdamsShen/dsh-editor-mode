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
const EXT = join(HERE, '..', 'extensions', 'local.dsh-editor-bridge-0.2.0');
const html = readFileSync(join(EXT, 'media', 'chat.html'), 'utf8');
const extensionSrc = readFileSync(join(EXT, 'extension.js'), 'utf8');
const chatSrc = readFileSync(join(EXT, 'media', 'chat.js'), 'utf8');
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
check('菜单只引用已声明的命令',
  menuCommands.every((id) => commandIds.includes(id)),
  menuCommands.join(', '));

check('activationEvents 覆盖视图与命令',
  ['onView:dshEditor.chat', ...commandIds.map((id) => `onCommand:${id}`)]
    .every((event) => manifest.activationEvents.includes(event)));

console.log('webview 与扩展消息协议');
const posted = [...new Set([...chatSrc.matchAll(/type:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]))];
const handled = [...new Set([...extensionSrc.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]))];
for (const type of ['ready', 'send', 'stop', 'selectModel', 'toggleContext', 'newChat', 'escalate', 'refreshModels']) {
  check(`webview 发出 ${type}，扩展有处理`, posted.includes(type) && handled.includes(type));
}
for (const type of ['state', 'delta', 'reasoning', 'prefill', 'contextInfo']) {
  check(`扩展会推 ${type}，webview 有处理`, chatSrc.includes(`case '${type}':`));
}

console.log('不会泄露 token 到 webview');
check('扩展没有把 token 放进 post 的消息',
  !/post\(\{[^}]*token/.test(extensionSrc),
  'token 只应在 Node 侧使用');

console.log(failed === 0 ? 'PASS: webview 接线自洽' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);