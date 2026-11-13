/**
 * 测试：插件配置校验（P2-4）。
 *
 * 目标：非法配置在**启动时**就以可读方式报出来，而不是拖到 spawn 阶段
 * 变成"白屏 + 日志里一句 spawn ENOENT"。
 *
 * 覆盖：
 *   - 缺省值填充（合法配置不报错）
 *   - 端口越界 / 非整数
 *   - 监听地址带了协议或路径
 *   - nodeBin 不可执行
 *   - runtimeDir 不存在
 *   - workspaceDir 非绝对路径
 *   - skipBuiltinExtensions 形状不对
 *   - bridgeToken 太短
 *   - **一次报全部问题**（不是报一个就停）
 *
 * 用法：node test/config-validation.test.mjs
 */
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..');

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ✓', name);
  else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

const { validateConfig } = await import(join(REPO, 'index.js'));

console.log('合法配置：填默认值、不报错');
{
  const { value, errors } = validateConfig({});
  check('无错误', errors.length === 0, JSON.stringify(errors));
  check('端口默认 3999', value.upstreamPort === 3999, String(value.upstreamPort));
  check('监听地址默认回环', value.upstreamHost === '127.0.0.1', value.upstreamHost);
  check('默认跳过 copilot-chat',
    Array.isArray(value.skipBuiltinExtensions)
      && value.skipBuiltinExtensions.includes('GitHub.copilot-chat'),
    JSON.stringify(value.skipBuiltinExtensions));
}

console.log('端口');
{
  for (const bad of [0, 65536, -1, 3.14, 'abc']) {
    const { errors } = validateConfig({ upstreamPort: bad });
    check(`端口 ${JSON.stringify(bad)} 被拒`, errors.some((e) => e.includes('upstreamPort')), JSON.stringify(errors));
  }
  const { value, errors } = validateConfig({ upstreamPort: '8080' });
  check('数字字符串被接受并转成数字', errors.length === 0 && value.upstreamPort === 8080, JSON.stringify(value));
}

console.log('监听地址');
{
  for (const bad of ['http://127.0.0.1', '127.0.0.1/x', 'a b']) {
    const { errors } = validateConfig({ upstreamHost: bad });
    check(`地址 ${JSON.stringify(bad)} 被拒`, errors.some((e) => e.includes('upstreamHost')), JSON.stringify(errors));
  }
}

console.log('可执行文件与目录');
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-cfg-'));
  try {
    const plain = join(tmp, 'not-exec.txt');
    writeFileSync(plain, 'x');
    chmodSync(plain, 0o644);
    // 不可执行只告警：运行时可能还没装，那是状态问题不是配置笔误
    let r = validateConfig({ nodeBin: plain });
    check('不可执行的 nodeBin 不阻断启动', r.errors.length === 0, JSON.stringify(r.errors));
    check('不可执行的 nodeBin 给出告警',
      r.warnings.some((w) => w.includes('nodeBin')), JSON.stringify(r.warnings));

    const exe = join(tmp, 'node');
    writeFileSync(exe, '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    r = validateConfig({ nodeBin: exe });
    check('可执行的 nodeBin 无告警', r.errors.length === 0 && r.warnings.length === 0, JSON.stringify(r.warnings));

    r = validateConfig({ nodeBin: 'relative/node' });
    check('相对 nodeBin 被拒', r.errors.some((e) => e.includes('nodeBin')), JSON.stringify(r.errors));

    // 目录不存在 = 运行时还没装，是正常状态，不能判成配置错误
    r = validateConfig({ runtimeDir: join(tmp, 'nope') });
    check('不存在的 runtimeDir 不阻断启动', r.errors.length === 0, JSON.stringify(r.errors));

    r = validateConfig({ runtimeDir: '~/editor-runtime' });
    check('~ 开头的 runtimeDir 被接受', r.errors.length === 0, JSON.stringify(r.errors));

    r = validateConfig({ runtimeDir: 'rel/dir' });
    check('相对 runtimeDir 被拒', r.errors.some((e) => e.includes('runtimeDir')), JSON.stringify(r.errors));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('路径与列表');
{
  const r1 = validateConfig({ workspaceDir: 'relative/dir' });
  check('相对 workspaceDir 被拒', r1.errors.some((e) => e.includes('workspaceDir')), JSON.stringify(r1.errors));

  const r0 = validateConfig({ workspaceDir: '~/proj' });
  check('~ 开头被接受', r0.errors.length === 0, JSON.stringify(r0.errors));

  const r2 = validateConfig({ workspaceDir: '/abs/dir' });
  check('绝对 workspaceDir 被接受', r2.errors.length === 0, JSON.stringify(r2.errors));

  const r3 = validateConfig({ skipBuiltinExtensions: 'GitHub.copilot-chat' });
  check('非数组被拒', r3.errors.some((e) => e.includes('skipBuiltinExtensions')), JSON.stringify(r3.errors));

  const r4 = validateConfig({ skipBuiltinExtensions: ['no-dot'] });
  check('非法扩展 id 被拒', r4.errors.some((e) => e.includes('skipBuiltinExtensions')), JSON.stringify(r4.errors));

  const r5 = validateConfig({ skipBuiltinExtensions: ['a.b', 'c.d'] });
  check('合法扩展 id 被接受', r5.errors.length === 0, JSON.stringify(r5.errors));
}

console.log('token 与对象');
{
  // 短 token 只是「不够强」，不能判成致命错误：否则原本能跑的配置会突然起不来
  const r1 = validateConfig({ bridgeToken: 'short' });
  check('过短 token 不阻断启动', r1.errors.length === 0, JSON.stringify(r1.errors));
  check('过短 token 给出告警', r1.warnings.some((w) => w.includes('bridgeToken')), JSON.stringify(r1.warnings));
  check('过短 token 仍然生效', r1.value.bridgeToken === 'short', JSON.stringify(r1.value));

  const r2 = validateConfig({ bridgeToken: '0123456789abcdef' });
  check('16 字符 token 无告警', r2.errors.length === 0 && r2.warnings.length === 0, JSON.stringify(r2.warnings));

  const r3 = validateConfig({ editorSettings: ['x'] });
  check('数组冒充对象被拒', r3.errors.some((e) => e.includes('editorSettings')), JSON.stringify(r3.errors));

  const r4 = validateConfig({ editorSettings: { 'workbench.colorTheme': 'Dark' } });
  check('对象被接受', r4.errors.length === 0, JSON.stringify(r4.errors));
}

console.log('一次报全部问题，而不是报一个就停');
{
  const { errors } = validateConfig({
    upstreamPort: 70000,
    upstreamHost: 'http://x',
    workspaceDir: 'rel',
  });
  check('报出 3 条', errors.length === 3, JSON.stringify(errors));
  const fields = ['upstreamPort', 'upstreamHost', 'workspaceDir'];
  check('每条都能定位到字段', fields.every((f) => errors.some((e) => e.startsWith(`${f}:`))),
    JSON.stringify(errors));
}

console.log('未声明的键原样保留');
{
  const { value, errors } = validateConfig({ futureOption: 42 });
  check('不因未知键报错', errors.length === 0, JSON.stringify(errors));
  check('未知键被保留', value.futureOption === 42, JSON.stringify(value));
}

console.log('非对象输入');
{
  const { errors } = validateConfig(null);
  check('null 被拒', errors.length === 1, JSON.stringify(errors));
}

console.log('apply()：非法配置抛错且可被 /editor-status 读到');
{
  const mod = await import(join(REPO, 'index.js'));
  let thrown = '';
  try {
    mod.apply({ logger: { warn() {} } }, { upstreamPort: 0 });
  } catch (err) {
    thrown = String(err?.message || err);
  }
  check('抛出了错误', thrown.length > 0);
  check('错误里列出全部问题', thrown.includes('upstreamPort') && thrown.includes('配置有'), thrown);
  check('记录到 lastConfigError 供状态路由读取',
    String(mod.apply.lastConfigError || '').includes('upstreamPort'), mod.apply.lastConfigError);

  // 合法配置不应写入错误
  mod.apply.lastConfigError = 'stale';
  try { mod.apply({ logger: { warn() {} } }, { upstreamPort: 4000 }); } catch { /* 后续装配失败与环境有关 */ }
  check('合法配置清空错误', !mod.apply.lastConfigError, mod.apply.lastConfigError);
}

console.log(failed === 0 ? 'PASS: 配置校验自洽' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);