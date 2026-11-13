/**
 * 测试：运行时自举（P3-1）。
 *
 * 「装完即用」的前提是能安全地把 code-server 拿到本地。这条链路最危险的地方
 * 不是下载失败，而是**校验不过却仍然落位**——那等于让来路不明的字节变成
 * 可执行运行时。所以这里重点验证：
 *
 *   - 没配来源 → 明确报错，**不**偷偷下载未知二进制
 *   - 校验通过 → 解包 → 找到 entry → 落位
 *   - **校验不过 → 一个字节都不落位，且不动已有安装**
 *   - 解包后结构不符 → 失败，不落位
 *   - 失败时临时目录被清掉（安装包 200MB，留着会反复堆积）
 *
 * 网络与磁盘全部注入，纯离线。
 *
 * 用法：node test/runtime-bootstrap.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
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

const mod = await import(join(REPO, 'index.js'));
const { ensureRuntime, planRuntime } = mod;

/** 把 entry.js 放到 <root>/node_modules/code-server/out/node/entry.js */
function plantEntry(root) {
  const dir = join(root, 'node_modules', 'code-server', 'out', 'node');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'entry.js'), '// fake\n');
}

const tmpDirs = [];
function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'));
  tmpDirs.push(dir);
  return dir;
}

let exitCode = 0;
try {
  console.log('决策层：没有来源时明确报错，不偷偷下载');
  {
    const root = makeRoot();
    const plan = planRuntime({ runtimeDir: root });
    check('action=missing', plan.action === 'missing', JSON.stringify(plan));
    check('给出安装命令', plan.hint.includes('npm install code-server'), plan.hint);

    // 只有 URL 没有校验和 → 同样拒绝（不能下未知二进制）
    const plan2 = planRuntime({ runtimeDir: root, runtimeSource: 'https://x/y.tgz' });
    check('缺 SHA-256 也判 missing', plan2.action === 'missing', JSON.stringify(plan2));
  }

  console.log('已存在时直接 ready');
  {
    const root = makeRoot();
    plantEntry(root);
    const plan = planRuntime({ runtimeDir: root });
    check('action=ready', plan.action === 'ready', JSON.stringify(plan));
    check('entry 指向 entry.js', String(plan.entry).endsWith(join('out', 'node', 'entry.js')), plan.entry);
  }

  console.log('校验通过 → 解包 → 落位');
  {
    const root = makeRoot();
    const plan = planRuntime({
      runtimeDir: root,
      runtimeSource: 'https://example.test/cs.tgz',
      runtimeSha256: 'a'.repeat(64),
    });
    check('action=install', plan.action === 'install', JSON.stringify(plan));

    let fetched = null;
    const result = await ensureRuntime(
      { runtimeDir: root, runtimeSource: 'https://example.test/cs.tgz', runtimeSha256: 'a'.repeat(64) },
      {
      fetchToFile: async (url, dest) => { fetched = url; writeFileSync(dest, 'tarball'); },
      hashFile: async () => 'a'.repeat(64),
      extract: async (tarPath, dest) => { plantEntry(dest); },
      log: () => {},
    });

    check('下载用的是配置的 URL', fetched === 'https://example.test/cs.tgz', String(fetched));
    check('返回 installed', result.state === 'installed', JSON.stringify(result));
    check('落位后能找到 entry', Boolean(result.entry), String(result.entry));
    check('磁盘上确实装好了', existsSync(join(root, 'node_modules', 'code-server', 'out', 'node', 'entry.js')));
    check('临时目录已清理',
      readdirSync(root).every((n) => !n.startsWith('.download-')), readdirSync(root).join(','));
  }

  console.log('校验不过：一个字节都不落位');
  {
    const root = makeRoot();
    const result = await ensureRuntime(
      { runtimeDir: root, runtimeSource: 'https://example.test/cs.tgz', runtimeSha256: 'b'.repeat(64) },
      {
      fetchToFile: async (url, dest) => { writeFileSync(dest, 'tarball'); },
      hashFile: async () => 'c'.repeat(64), // 与期望不符
      extract: async () => { throw new Error('不该被调用'); },
      log: () => {},
    });

    check('返回 failed', result.state === 'failed', JSON.stringify(result));
    check('错误里说明校验失败', String(result.message).includes('SHA-256'), String(result.message));
    check('没有落位', !existsSync(join(root, 'node_modules')), readdirSync(root).join(','));
    check('临时目录已清理',
      readdirSync(root).every((n) => !n.startsWith('.download-')), readdirSync(root).join(','));
  }

  console.log('已有可用安装：不重复下载');
  {
    const root = makeRoot();
    plantEntry(root);
    let fetched = false;
    const result = await ensureRuntime(
      { runtimeDir: root, runtimeSource: 'https://example.test/cs.tgz', runtimeSha256: 'b'.repeat(64) },
      { fetchToFile: async () => { fetched = true; }, log: () => {} },
    );
    check('返回 ready', result.state === 'ready', JSON.stringify(result));
    check('没有触发下载', fetched === false);
  }

  console.log('发行包结构不符：不落位');
  {
    const root = makeRoot();
    const result = await ensureRuntime(
      { runtimeDir: root, runtimeSource: 'https://example.test/cs.tgz', runtimeSha256: 'e'.repeat(64) },
      {
        fetchToFile: async (url, dest) => { writeFileSync(dest, 'x'); },
        hashFile: async () => 'e'.repeat(64),
        extract: async (tarPath, dest) => { writeFileSync(join(dest, 'README'), 'hi'); },
        log: () => {},
      },
    );
    check('返回 failed', result.state === 'failed', JSON.stringify(result));
    check('提示结构不符', String(result.message).includes('out/node/entry.js'), String(result.message));
    check('没有落位', !existsSync(join(root, 'node_modules')), readdirSync(root).join(','));
  }

  console.log('落位失败：必须恢复旧安装，不能连带删掉');
  {
    const root = makeRoot();
    // 模拟「半个安装」：node_modules 在、entry 不在（上次安装中断留下的现场）。
    // 这是唯一会走到落位分支的场景——完整安装会直接被 planRuntime 判成 ready。
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'OLD-MARKER'), 'v1');
    const result = await ensureRuntime(
      { runtimeDir: root, runtimeSource: 'https://example.test/cs.tgz', runtimeSha256: 'a'.repeat(64) },
      {
        fetchToFile: async (url, dest) => { writeFileSync(dest, 'tarball'); },
        hashFile: async () => 'a'.repeat(64),
        extract: async (tarPath, dest) => { plantEntry(dest); },
        // 第二步 rename（staged → target）抛错，模拟落位失败
        rename: (from, to) => {
          if (String(to).endsWith(join('node_modules')) && String(from).includes('unpacked')) {
            throw new Error('EXDEV: 跨设备 rename 失败');
          }
          return renameSync(from, to);
        },
        log: () => {},
      },
    );
    check('返回 failed', result.state === 'failed', JSON.stringify(result));
    check('旧安装被恢复', existsSync(join(root, 'node_modules', 'OLD-MARKER')),
      (() => { try { return readdirSync(join(root, 'node_modules')).join(','); } catch { return '(node_modules 不存在)'; } })());
    check('失败的安装没有留下半成品',
      !existsSync(join(root, 'node_modules', 'code-server')),
      (() => { try { return readdirSync(join(root, 'node_modules')).join(','); } catch { return '(不存在)'; } })());
  }

  console.log('目录建不出来：返回 failed 而不是抛异常');
  {
    const root = makeRoot();
    const blocker = join(root, 'blocked');
    writeFileSync(blocker, 'I am a file');   // runtimeDir 指向文件 → mkdir 失败
    const result = await ensureRuntime(
      { runtimeDir: blocker, runtimeSource: 'https://example.test/cs.tgz', runtimeSha256: 'a'.repeat(64) },
      { log: () => {} },
    );
    check('返回 failed 而非抛出', result.state === 'failed', JSON.stringify(result));
    check('带出可读原因', Boolean(result.message), String(result.message));
  }

  console.log('下载失败：给可读错误');
  {
    const root = makeRoot();
    const result = await ensureRuntime(
      { runtimeDir: root, runtimeSource: 'https://example.test/cs.tgz', runtimeSha256: 'f'.repeat(64) },
      {
        fetchToFile: async () => { throw new Error('下载失败：HTTP 404'); },
        hashFile: async () => 'f'.repeat(64),
        extract: async () => {},
        log: () => {},
      },
    );
    check('返回 failed', result.state === 'failed', JSON.stringify(result));
    check('保留原始原因', String(result.message).includes('HTTP 404'), String(result.message));
  }
} catch (err) {
  failed += 1;
  console.log('  ✗ 用例抛错', err && err.stack ? err.stack : String(err));
} finally {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

exitCode = failed ? 1 : 0;
console.log(failed === 0 ? 'PASS: 运行时自举自洽' : `FAIL: ${failed} 项失败`);
process.exit(exitCode);