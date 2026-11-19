import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 本 SDK 的测试回放的向量文件（相对 `spec/conformance/vectors/`，以 `/` 分隔）
 *
 * @remarks
 * 每一项都有测试读入并逐条核对，行尾注释是回放它的测试文件；新增回放时加进来，不再回放时删掉
 */
const replayed: readonly string[] = [
  'manifest/manifests.json', // manifest.test.ts
  'operations/payload-reasons.json', // operation.test.ts
  'pipeline/ordering.json', // pipeline.test.ts
  'plugin/callback-status.json', // plugin.test.ts
  'plugin/deadlines.json', // plugin.test.ts
  'plugin/error-reading.json', // plugin.test.ts
  'plugin/handshake-lines.json', // plugin.test.ts
  'plugin/host-addresses.json', // plugin.test.ts
  'plugin/plugin-messages.json', // plugin.test.ts
  'plugin/protocol-versions.json', // plugin.test.ts
  'primitives/baggage-keys.json', // primitives.test.ts、invocation.test.ts
  'primitives/capability-requirements.json', // manifest.test.ts
  'primitives/error-codes.json', // primitives.test.ts
  'primitives/json-text.json', // primitives.test.ts
  'primitives/kernel-messages.json', // primitives.test.ts、invocation.test.ts、manifest.test.ts、operation.test.ts
  'primitives/lifecycle-transitions.json', // primitives.test.ts
  'primitives/message-templates.json', // primitives.test.ts
  'primitives/trace-context.json', // invocation.test.ts
  'primitives/wire-encoding.json', // primitives.test.ts
];

/** 显式豁免的向量文件：文件 → 不回放的理由 */
const exempted: Readonly<Record<string, string>> = {
  'plugin/wasm-exports.json': 'Wasm ABI exports are checked by hosts; this SDK has no Wasm plugin runtime.',
  'provider/caching-distributed.json': 'This SDK does not provide the caching.distributed@1 remote provider.',
  'security/webauthn.json': 'WebAuthn verification is host-side (RFC-0008); this SDK does not verify credentials.',
};

/** 规范子模块里的向量目录 */
const vectorsDirectory = fileURLToPath(new URL('../spec/conformance/vectors', import.meta.url));

test('规范的每个向量文件要么有测试回放，要么显式豁免并写明理由', () => {
  assert.ok(existsSync(vectorsDirectory), `${vectorsDirectory} is missing; run \`git submodule update --init\``);
  // 递归列出的路径按平台分隔，统一成 / 再与常量比较
  const present = readdirSync(vectorsDirectory, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.json'))
    .map((path) => path.split(sep).join('/'))
    .sort();
  const both = replayed.filter((file) => Object.hasOwn(exempted, file));
  assert.deepEqual(both, [], `vector files both replayed and exempted: ${both.join(', ')}`);
  const listed = [...replayed, ...Object.keys(exempted)].sort();
  const missing = listed.filter((file) => !present.includes(file));
  assert.deepEqual(missing, [], `listed vector files that the spec does not have: ${missing.join(', ')}`);
  const unlisted = present.filter((file) => !listed.includes(file));
  assert.deepEqual(unlisted, [], `spec vector files neither replayed nor exempted: ${unlisted.join(', ')}`);
});
