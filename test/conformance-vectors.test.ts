import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 本 SDK 认领的一致性档（RFC-0024「一致性档」，档表是 `spec/conformance/profiles.json`）
 *
 * @remarks
 * 只对认领的档负责：认领的档要求的向量都要回放或列为缺口，档表里其他档的向量不归本 SDK
 */
const claimedProfiles: readonly string[] = ['core', 'plugin'];

/**
 * 本 SDK 的测试回放的向量文件（相对 `spec/conformance/vectors/`，以 `/` 分隔）
 *
 * @remarks
 * 每一项都有测试读入并逐条核对，行尾注释是回放它的测试文件；新增回放时加进来，不再回放时删掉。
 * 回放认领的档以外的向量是允许的
 */
const replayed: readonly string[] = [
  'manifest/manifests.json', // manifest.test.ts
  'operations/payload-reasons.json', // operation.test.ts
  'pipeline/ordering.json', // pipeline.test.ts
  'plugin/binding-properties.json', // plugin.test.ts（reading；names、limits、delivery 与 json 是宿主一侧的）
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
  'primitives/operation-ids.json', // primitives.test.ts、operation.test.ts
  'primitives/trace-context.json', // invocation.test.ts
  'primitives/wire-encoding.json', // primitives.test.ts
];

/**
 * 缺口：认领的档要求、本 SDK 却没有回放的向量文件 → 不回放的理由
 *
 * @remarks
 * RFC-0024「实现钉规范」第 3 条要求 README 的「状态」一节逐条写出同样的缺口；目前没有
 */
const gaps: Readonly<Record<string, string>> = {};

/** 规范子模块里的一致性目录 */
const conformanceDirectory = fileURLToPath(new URL('../spec/conformance', import.meta.url));

/** 档表 `profiles.json` 里的一个档，只取用到的成员 */
interface Profile {
  /** 档名 */
  readonly id: string;
  /** 认领这个档必须回放的向量，相对 `conformance/vectors` */
  readonly vectors: readonly string[];
}

test('认领的档要求的每个向量要么被回放、要么列为缺口，回放的向量在规范里都存在（RFC-0024「一致性档」）', () => {
  const profilesFile = join(conformanceDirectory, 'profiles.json');
  assert.ok(existsSync(profilesFile), `${profilesFile} is missing; run \`git submodule update --init\``);
  const { profiles } = JSON.parse(readFileSync(profilesFile, 'utf8')) as { profiles: Profile[] };

  const undefinedProfiles = claimedProfiles.filter((id) => !profiles.some((profile) => profile.id === id));
  assert.deepEqual(
    undefinedProfiles,
    [],
    `claimed profiles that the spec does not define: ${undefinedProfiles.join(', ')}`,
  );
  // 一个向量可以属于多个档，认领的档要求的向量取并集
  const claimed = profiles.filter((profile) => claimedProfiles.includes(profile.id));
  const required = [...new Set(claimed.flatMap((profile) => profile.vectors))].sort();
  const uncovered = required.filter((file) => !replayed.includes(file) && !Object.hasOwn(gaps, file));
  assert.deepEqual(
    uncovered,
    [],
    `vector files of the claimed profiles that are neither replayed nor listed as gaps: ${uncovered.join(', ')}`,
  );
  const gapFiles = Object.keys(gaps).sort();
  const outside = gapFiles.filter((file) => !required.includes(file));
  assert.deepEqual(outside, [], `gaps outside the claimed profiles: ${outside.join(', ')}`);
  const replayedGaps = gapFiles.filter((file) => replayed.includes(file));
  assert.deepEqual(replayedGaps, [], `gaps that are replayed; remove them from gaps: ${replayedGaps.join(', ')}`);
  const missing = replayed.filter((file) => !existsSync(join(conformanceDirectory, 'vectors', file)));
  assert.deepEqual(missing, [], `replayed vector files that the spec does not have: ${missing.join(', ')}`);
});
