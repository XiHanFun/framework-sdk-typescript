import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ManifestFileName, readManifest, writeManifest } from 'xihan-framework/manifest';

/** 运行器 `--json` 输出的一项（spec/conformance/README.md） */
interface CaseResult {
  readonly case: string;
  readonly passed: boolean;
  readonly skipped: boolean;
  readonly message?: string;
  readonly durationMs: number;
}

/** 黑盒运行器的全部用例 */
const allCases = [
  'handshake',
  'refusal',
  'session',
  'lifecycle',
  'order',
  'unknown-operation',
  'declared-operations',
  'unavailable',
  'event',
  'unsubscribed',
  'stream',
  'configuration',
  'stop-early',
  'stdin',
];

const conformanceDirectory = fileURLToPath(new URL('../spec/conformance', import.meta.url));
const exampleDirectory = fileURLToPath(new URL('../examples/echo', import.meta.url));

/** 运行一个命令，收集输出；超时即终止 */
function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * 把 echo 放进插件目录：清单的 `entry` 按平台写，启动脚本写出 node 与入口的绝对路径
 *
 * @remarks
 * 宿主只继承 handshake.md §1 列出的环境变量，启动脚本不能依赖 NODE_PATH 之类：node 用当前进程的可执行文件，
 * 以 `--conditions=xihan-source` 直接加载 TypeScript 源码。清单逐字段与握手时交出的一致，因为运行时读的就是这个文件
 */
async function preparePlugin(directory: string): Promise<void> {
  const windows = process.platform === 'win32';
  // Windows 上没有扩展名时宿主补 .exe，脚本要写明 .cmd
  const entry = windows ? 'echo.cmd' : 'echo';
  const read = readManifest(await readFile(join(exampleDirectory, ManifestFileName)));
  assert.ok(read.ok, 'the example manifest must be valid');
  await writeFile(join(directory, ManifestFileName), writeManifest({ ...read.value, entry }));
  const main = join(exampleDirectory, 'main.ts');
  const script = join(directory, entry);
  if (windows) {
    // @echo off：cmd 不把命令回显到 stdout，stdout 的第一行才是握手行
    await writeFile(script, `@echo off\r\n"${process.execPath}" --conditions=xihan-source "${main}"\r\n`);
  } else {
    // exec 让 node 替换 sh：SIGTERM 与 stdin 关闭直接到插件进程
    await writeFile(script, `#!/bin/sh\nexec "${process.execPath}" --conditions=xihan-source "${main}"\n`);
    chmodSync(script, 0o755);
  }
}

test('echo 插件通过规范黑盒运行器的全部用例（spec/conformance：xihan-conformance plugin）', {
  timeout: 600_000,
}, async (t) => {
  const go = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (go.error !== undefined || go.status !== 0) {
    // 缺 Go 默认失败，否则门禁会静默变绿；确实要跳过时显式设 XIHAN_CONFORMANCE_REQUIRED=0
    if (process.env.XIHAN_CONFORMANCE_REQUIRED === '0') {
      t.skip('go is not on PATH and XIHAN_CONFORMANCE_REQUIRED=0: the black-box runner of the spec runs with Go');
      return;
    }
    assert.fail(
      'go is not on PATH: the black-box runner of the spec runs with Go; install Go (https://go.dev/dl/) or set XIHAN_CONFORMANCE_REQUIRED=0 to skip this test',
    );
  }
  const directory = await mkdtemp(join(tmpdir(), 'xihan-echo-ts-'));
  try {
    await preparePlugin(directory);
    // 运行器从规范子模块运行，版本与锁定的规范一致
    const { code, stdout, stderr } = await run(
      'go',
      [
        'run',
        './cmd/xihan-conformance',
        'plugin',
        '--dir',
        directory,
        '--json',
        '--quiet',
        '--config',
        '{"greeting":"hello"}',
        '--sample',
        'echoes.create={"text":"conformance"}',
        '--exclude',
        'echoes.crash',
      ],
      conformanceDirectory,
      540_000,
    );
    let results: CaseResult[];
    try {
      results = JSON.parse(stdout) as CaseResult[];
    } catch {
      assert.fail(`the runner did not print JSON (exit ${code}):\n${stdout}\n${stderr}`);
    }
    for (const result of results) {
      t.diagnostic(`${result.case}: ${result.passed ? 'passed' : 'failed'} in ${result.durationMs}ms`);
    }
    assert.deepEqual(
      results.map((result) => result.case),
      allCases,
    );
    const failed = results.filter((result) => !result.passed || result.skipped);
    assert.deepEqual(failed, [], 'every case must pass without being skipped');
    assert.equal(code, 0, stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
