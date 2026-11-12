/**
 * 一次性跑完所有测试（`node test/run-all.mjs`）。
 *
 * 每个用例是独立进程：任何一个崩了都不影响其余用例的输出，
 * 也避免它们共享 globalThis（client-inject 会伪造 window）。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cases = readdirSync(HERE)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

const results = [];
for (const name of cases) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(HERE, name)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const ok = run.status === 0;
  const elapsed = Date.now() - started;
  results.push({ name, ok, elapsed });
  console.log(`\n=== ${name} ${ok ? '✓' : '✗'} (${elapsed}ms) ===`);
  process.stdout.write(run.stdout || '');
  if (run.stderr) process.stderr.write(run.stderr);
}

const failed = results.filter((r) => !r.ok);
console.log('\n────────────────────────────');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} (${r.elapsed}ms)`);
console.log(failed.length === 0
  ? `\nALL PASS (${results.length} 个用例)`
  : `\nFAILED: ${failed.map((r) => r.name).join(', ')}`);
process.exit(failed.length ? 1 : 0);