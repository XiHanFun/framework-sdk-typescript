import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  activatesOnStartup,
  capabilityDeclarationText,
  capabilityRequirementText,
  configSection,
  contributedHealth,
  contributedOperations,
  effectiveActivation,
  effectiveRole,
  idDomain,
  isBindingRequired,
  isRequirementSatisfiedBy,
  type Manifest,
  ManifestFileName,
  ManifestKind,
  ManifestRole,
  PluginIsolation,
  parseCapabilityDeclaration,
  parseCapabilityRequirement,
  readManifest,
  writeManifest,
} from '@xihan-framework/manifest';
import { readManifestFile } from '@xihan-framework/manifest/node';
import { ErrorCode, FrameworkError, PipelineStage, Stability } from '@xihan-framework/primitives';

const echoManifest = `{
  "$schema": "https://spec.xihanfun.com/manifest/v1.json",
  "id": "xihan.samples.echo",
  "package": "EchoPlugin",
  "version": "5.0.0-preview.1",
  "primitives": "1",
  "stability": "experimental",
  "kind": "plugin",
  "isolation": "out-of-process",
  "requires": [ { "id": "kernel.plugins", "version": "1" } ],
  "contributes": {
    "operations": [ "echoes.create", "echoes.relay", "echoes.crash", "events.list" ],
    "config": { "section": "XiHan:Echo" },
    "health": [ "echo" ]
  },
  "permissions": [ "capability:kernel.pipeline" ],
  "activation": [ "onStartup" ],
  "entry": "EchoPlugin"
}`;

/** 规范化输出：字段按 Schema 顺序、两空格缩进，与 Go 的 json.MarshalIndent 逐字一致 */
const echoCanonical = `{
  "$schema": "https://spec.xihanfun.com/manifest/v1.json",
  "id": "xihan.samples.echo",
  "package": "EchoPlugin",
  "version": "5.0.0-preview.1",
  "primitives": "1",
  "stability": "experimental",
  "kind": "plugin",
  "isolation": "out-of-process",
  "requires": [
    {
      "id": "kernel.plugins",
      "version": "1"
    }
  ],
  "contributes": {
    "operations": [
      "echoes.create",
      "echoes.relay",
      "echoes.crash",
      "events.list"
    ],
    "config": {
      "section": "XiHan:Echo"
    },
    "health": [
      "echo"
    ]
  },
  "activation": [
    "onStartup"
  ],
  "permissions": [
    "capability:kernel.pipeline"
  ],
  "entry": "EchoPlugin"
}`;

/** 直接读取规范子模块里的一致性向量，不复制向量文件 */
function vector<T>(name: string): T {
  const url = new URL(`../../../spec/conformance/vectors/primitives/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

function rejection(data: string): FrameworkError | undefined {
  try {
    readManifest(data);
    return undefined;
  } catch (error) {
    assert.ok(error instanceof FrameworkError, `expected a FrameworkError, got ${String(error)}`);
    assert.equal(error.code, ErrorCode.InvalidArgument);
    return error;
  }
}

test('读取插件清单', () => {
  const manifest = readManifest(echoManifest);
  assert.equal(manifest.id, 'xihan.samples.echo');
  assert.equal(manifest.kind, ManifestKind.Plugin);
  assert.equal(manifest.isolation, PluginIsolation.OutOfProcess);
  assert.equal(manifest.primitives, 1);
  assert.equal(manifest.stability, Stability.Experimental);
  assert.equal(manifest.requires?.length, 1);
  assert.equal(capabilityRequirementText(manifest.requires?.[0] ?? { id: '', version: 0 }), 'kernel.plugins@1');
  assert.equal(contributedOperations(manifest).length, 4);
  assert.equal(configSection(manifest), 'XiHan:Echo');
  assert.equal(contributedHealth(manifest).length, 1);
  assert.ok(activatesOnStartup(manifest));
  assert.equal(effectiveRole(manifest), ManifestRole.Provider);
  assert.equal(idDomain(manifest.id), 'samples');
  assert.equal(idDomain('caching.distributed'), 'caching');
  assert.equal(idDomain('Bad'), undefined);
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.requires?.[0]));

  const written = writeManifest(manifest);
  assert.equal(written, echoCanonical);
  const again = readManifest(written);
  assert.equal(again.id, manifest.id);
  assert.equal(again.requires?.[0]?.version, 1);
  assert.deepEqual(again, manifest);
  assert.equal(readManifest(new TextEncoder().encode(echoManifest)).id, manifest.id);
});

test('缺省值与访问器', () => {
  const manifest = readManifest(
    '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"provider","role":"default","bindings":[{"name":"db","type":"connection:relational"},{"name":"cache","type":"cache:distributed","required":false}],"activation":[]}',
  );
  assert.equal(effectiveRole(manifest), ManifestRole.Default);
  assert.deepEqual([...effectiveActivation(manifest)], ['onStartup']);
  assert.deepEqual([...contributedOperations(manifest)], []);
  assert.equal(configSection(manifest), undefined);
  assert.ok(isBindingRequired(manifest.bindings?.[0] ?? { name: '', type: '' }));
  assert.ok(!isBindingRequired(manifest.bindings?.[1] ?? { name: '', type: '' }));
  // 空数组与缺省值省略，显式写出的 required: false 保留
  assert.equal(
    JSON.stringify(JSON.parse(writeManifest(manifest))),
    '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"provider","role":"default","bindings":[{"name":"db","type":"connection:relational"},{"name":"cache","type":"cache:distributed","required":false}]}',
  );
  assert.equal(ManifestFileName, 'xihan.manifest.json');
});

test('配置节可以带子节', () => {
  const template = (section: string) =>
    `{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","contributes":{"config":{"section":${JSON.stringify(section)}}}}`;
  for (const section of [
    'XiHan:Caching',
    'XiHan:Caching:Redis',
    'XiHan:Protocols:CloudEvents',
    'XiHan:ObjectStorage:SignedUrls',
    'XiHan:A:B2:C',
  ]) {
    assert.equal(configSection(readManifest(template(section))), section);
  }
  for (const section of [
    'Orders',
    'XiHan',
    'XiHan:',
    'XiHan:caching',
    'XiHan:Caching:',
    'XiHan:Caching::Redis',
    'XiHan:Caching:redis',
    'XiHan:Caching:Re-dis',
    'xihan:Caching',
    'XiHan:Caching:Redis:',
  ]) {
    assert.ok(rejection(template(section)), `${section} must be rejected`);
  }
});

test('贡献的权限码遵循宿主的文法', () => {
  const template = (codes: string) =>
    `{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"plugin","isolation":"out-of-process","contributes":{"permissions":${codes}}}`;
  for (const codes of [
    '[]',
    '["orders.read"]',
    '["sales.orders.read","sales.orders.write"]',
    '["echo2.items-v2.read"]',
  ]) {
    assert.ok(readManifest(template(codes)).contributes !== undefined, codes);
  }
  for (const codes of [
    '["orders"]',
    '["Orders.read"]',
    '["orders.Read"]',
    '["orders..read"]',
    '["orders.read."]',
    '[".orders.read"]',
    '["1orders.read"]',
    '["orders.1read"]',
    '["orders_x.read"]',
    '["orders:read"]',
    '["orders.read","orders.read"]',
    '["orders.read","orders.write","orders.read"]',
  ]) {
    assert.ok(rejection(template(codes)), `${codes} must be rejected`);
  }
});

test('拒绝不合法的清单', () => {
  const cases: Record<string, string> = {
    'unknown field':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","extra":1}',
    'bad id': '{"id":"a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability"}',
    'bad version': '{"id":"xihan.a.b","version":"1.0","primitives":"1","stability":"stable","kind":"capability"}',
    'bad primitives': '{"id":"xihan.a.b","version":"1.0.0","primitives":"0","stability":"stable","kind":"capability"}',
    'bad stability': '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"solid","kind":"capability"}',
    'bad kind': '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"thing"}',
    'plugin needs isolation':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"plugin"}',
    'non-plugin isolation':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","isolation":"wasm"}',
    'non-plugin permissions':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","permissions":["capability:x"]}',
    'duplicate provides':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","provides":[{"id":"a.b","version":"1"},{"id":"a.b","version":"2"}]}',
    'duplicate requires':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","requires":[{"id":"a.b","version":"1"},{"id":"a.b","version":"^1"}]}',
    'bad activation':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"plugin","isolation":"wasm","activation":["onBoot"]}',
    'bad permission':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"plugin","isolation":"wasm","permissions":["sudo"]}',
    'bad operation':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","contributes":{"operations":["Orders.Create"]}}',
    'bad section':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","contributes":{"config":{"section":"Orders"}}}',
    'bad stage':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","contributes":{"pipeline":[{"middleware":"x","stage":"middle"}]}}',
    'bad binding':
      '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","bindings":[{"name":"Db","type":"connection:relational"}]}',
  };
  for (const [name, data] of Object.entries(cases)) {
    assert.ok(rejection(data), `${name} must be rejected`);
  }
});

test('按 Schema 解码：类型、必填字段与接口版本的写法', () => {
  const base = '"id":"xihan.a.b","version":"1.0.0","stability":"stable","kind":"capability"';
  const cases: Record<string, string> = {
    'not JSON': '{',
    'not an object': '[]',
    'missing primitives': `{${base}}`,
    'numeric primitives': `{${base},"primitives":1}`,
    'caret primitives': `{${base},"primitives":"^1"}`,
    'caret provided version': `{${base},"primitives":"1","provides":[{"id":"a.b","version":"^1"}]}`,
    'numeric required version': `{${base},"primitives":"1","requires":[{"id":"a.b","version":1}]}`,
    'null role': `{${base},"primitives":"1","role":null}`,
    'string optional': `{${base},"primitives":"1","requires":[{"id":"a.b","version":"1","optional":"yes"}]}`,
    'unknown requirement field': `{${base},"primitives":"1","requires":[{"id":"a.b","version":"1","range":"^1"}]}`,
    'unknown contribution field': `{${base},"primitives":"1","contributes":{"routes":[]}}`,
    'config without section': `{${base},"primitives":"1","contributes":{"config":{}}}`,
    'oversized version': `{${base},"primitives":"99999999999999999999"}`,
  };
  for (const [name, data] of Object.entries(cases)) {
    const error = rejection(data);
    assert.ok(error, `${name} must be rejected`);
    assert.equal(error.message, 'The manifest is not valid JSON for the schema.', name);
    assert.ok(error.cause instanceof Error, `${name} carries the cause`);
  }
  assert.ok(rejection(`{${base},"primitives":"1","role":""}`), 'an empty role is not in the enum');
  assert.throws(() => readManifest(new Uint8Array([0x7b, 0xff, 0x7d])), FrameworkError, 'invalid UTF-8 is rejected');
  const optional = readManifest(`{${base},"primitives":"1","requires":[{"id":"a.b","version":"^2","optional":true}]}`);
  assert.deepEqual(optional.requires?.[0], { id: 'a.b', version: 2, optional: true });
});

test('能力依赖文本遵循向量', () => {
  const vectors = vector<{
    valid: { input: string; id: string; version: number; optional: boolean }[];
    invalid: string[];
  }>('capability-requirements.json');
  for (const c of vectors.valid) {
    const requirement = parseCapabilityRequirement(c.input);
    assert.deepEqual(requirement, { id: c.id, version: c.version, optional: c.optional }, c.input);
  }
  for (const text of vectors.invalid) {
    assert.equal(parseCapabilityRequirement(text), undefined, `${text} must not parse`);
  }
  const declaration = parseCapabilityDeclaration('caching.distributed@2');
  assert.ok(declaration);
  assert.equal(capabilityDeclarationText(declaration), 'caching.distributed@2');
  assert.equal(parseCapabilityDeclaration('caching.distributed@^2'), undefined);
  const requirement = parseCapabilityRequirement('caching.distributed@^2?');
  assert.ok(requirement);
  assert.ok(isRequirementSatisfiedBy(requirement, declaration));
  assert.equal(capabilityRequirementText(requirement), 'caching.distributed@2?');
  const other = parseCapabilityDeclaration('caching.distributed@1');
  assert.ok(other && !isRequirementSatisfiedBy(requirement, other), 'versions must match');
});

test('只有 Wasm 插件能贡献中间件', () => {
  const template = (kind: string, isolation: string, pipeline: string) =>
    `{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"${kind}"${isolation},"contributes":{"pipeline":${pipeline}}}`;
  const audit = '[{"middleware":"audit","stage":"observe"},{"middleware":"tenant-guard","stage":"tenant"}]';
  for (const isolation of [PluginIsolation.OutOfProcess, PluginIsolation.InProcess]) {
    const error = rejection(template(ManifestKind.Plugin, `,"isolation":"${isolation}"`, audit));
    assert.ok(error, `a ${isolation} plugin contributing middleware must be rejected`);
    for (const fragment of ["'xihan.a.b'", "'contributes.pipeline'", 'audit, tenant-guard', isolation]) {
      assert.ok(
        error.message.includes(fragment),
        `the message for ${isolation} must mention ${fragment}: ${error.message}`,
      );
    }
  }
  const accepted: Record<string, string> = {
    'wasm plugin': template(ManifestKind.Plugin, ',"isolation":"wasm"', audit),
    capability: template(ManifestKind.Capability, '', audit),
    provider: template(ManifestKind.Provider, '', audit),
    'out-of-process, empty list': template(ManifestKind.Plugin, ',"isolation":"out-of-process"', '[]'),
    'in-process, empty list': template(ManifestKind.Plugin, ',"isolation":"in-process"', '[]'),
  };
  for (const [name, data] of Object.entries(accepted)) {
    assert.doesNotThrow(() => readManifest(data), name);
  }
  // 写出同样核对：不生成宿主会拒绝的清单
  const written: Manifest = {
    id: 'xihan.a.b',
    version: '1.0.0',
    primitives: 1,
    stability: Stability.Stable,
    kind: ManifestKind.Plugin,
    isolation: PluginIsolation.OutOfProcess,
    contributes: { pipeline: [{ middleware: 'audit', stage: PipelineStage.Observe }] },
  };
  assert.throws(() => writeManifest(written), FrameworkError);
});

test('从文件读取清单', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xihan-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, ManifestFileName);
  await writeFile(path, echoManifest);
  assert.equal((await readManifestFile(path)).id, 'xihan.samples.echo');
  await assert.rejects(readManifestFile(join(directory, 'missing.json')), (error: unknown) => {
    assert.ok(error instanceof FrameworkError);
    assert.equal(error.code, ErrorCode.InvalidArgument);
    assert.equal(error.message, 'The manifest file could not be read.');
    return true;
  });
});
