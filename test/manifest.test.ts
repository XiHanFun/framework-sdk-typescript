import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

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
  ManifestErrorCode,
  ManifestFileName,
  ManifestKind,
  ManifestMessageKey,
  ManifestRole,
  manifestSchemaUri,
  maxInterfaceVersion,
  PluginIsolation,
  parseCapabilityDeclaration,
  parseCapabilityRequirement,
  readManifest,
  validateManifest,
  writeManifest,
} from 'xihan-framework/manifest';
import { readManifestBytes, readManifestFile, readManifestSource } from 'xihan-framework/manifest/node';
import {
  ErrorCode,
  type ErrorInfo,
  FrameworkError,
  formatMessage,
  JsonMembers,
  type JsonNode,
  PipelineStage,
  type Result,
  readJsonText,
  Stability,
  toJsonValue,
  writeJson,
} from 'xihan-framework/primitives';

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

/** 规范的写出（RFC-0002「写出」）：成员按 Schema 顺序、列表与缺省值总写、两空格缩进、LF、末尾不换行 */
const echoWritten = `{
  "$schema": "https://spec.xihanfun.com/manifest/v1.json",
  "id": "xihan.samples.echo",
  "package": "EchoPlugin",
  "version": "5.0.0-preview.1",
  "primitives": "1",
  "stability": "experimental",
  "kind": "plugin",
  "role": "provider",
  "isolation": "out-of-process",
  "provides": [],
  "requires": [
    {
      "id": "kernel.plugins",
      "version": "1",
      "optional": false
    }
  ],
  "bindings": [],
  "contributes": {
    "pipeline": [],
    "operations": [
      "echoes.create",
      "echoes.relay",
      "echoes.crash",
      "events.list"
    ],
    "config": {
      "section": "XiHan:Echo"
    },
    "permissions": [],
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
  const url = new URL(`../spec/conformance/vectors/primitives/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

/** 读出成功的清单 */
function read(data: string | Uint8Array): Manifest {
  const result = readManifest(data);
  assert.ok(result.ok, result.ok ? '' : `expected a manifest, got ${result.error.toString()}`);
  return result.value;
}

/** 读出失败的错误：码总是 KERNEL_CAPABILITY_006 */
function rejection(data: string | Uint8Array): ErrorInfo {
  const result = readManifest(data);
  assert.ok(!result.ok, 'the manifest must be rejected');
  assert.equal(result.error.code, ManifestErrorCode.Invalid);
  return result.error;
}

/** 断言不合 Schema 的位置 */
function invalidAt(data: string, reason: string): void {
  const error = rejection(data);
  assert.equal(error.messageKey, ManifestMessageKey.Invalid, data);
  assert.deepEqual(error.details, { reason }, data);
}

test('读取插件清单并按规范的排版写出', () => {
  const manifest = read(echoManifest);
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
  // 读出的清单补齐缺省值
  assert.equal(manifest.role, ManifestRole.Provider);
  assert.deepEqual(manifest.requires?.[0], { id: 'kernel.plugins', version: 1, optional: false });
  assert.deepEqual(manifest.provides, []);
  assert.ok(!Object.hasOwn(manifest, '$schema'), '$schema is not part of the model');

  const written = writeManifest(manifest);
  assert.equal(written, echoWritten);
  assert.deepEqual(read(written), manifest);
  assert.equal(read(new TextEncoder().encode(echoManifest)).id, manifest.id);
  assert.equal(manifestSchemaUri, 'https://spec.xihanfun.com/manifest/v1.json');
});

test('缺省值与访问器', () => {
  const manifest = read(
    '{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"provider","role":"default","bindings":[{"name":"db","type":"connection:relational"},{"name":"cache","type":"cache:distributed","required":false}]}',
  );
  assert.equal(effectiveRole(manifest), ManifestRole.Default);
  assert.deepEqual([...effectiveActivation(manifest)], ['onStartup']);
  assert.deepEqual([...contributedOperations(manifest)], []);
  assert.equal(configSection(manifest), undefined);
  assert.ok(isBindingRequired(manifest.bindings?.[0] ?? { name: '', type: '' }));
  assert.ok(!isBindingRequired(manifest.bindings?.[1] ?? { name: '', type: '' }));
  // 程序里构造的清单可以不写可选成员：访问器与写出都按缺省值
  const built: Manifest = {
    id: 'xihan.a.b',
    version: '1.0.0',
    primitives: 1,
    stability: Stability.Stable,
    kind: ManifestKind.Capability,
    bindings: [{ name: 'db', type: 'queue' }],
  };
  assert.deepEqual([...effectiveActivation(built)], ['onStartup']);
  const again = read(writeManifest(built));
  assert.deepEqual(again.bindings, [{ name: 'db', type: 'queue', required: true }]);
  assert.deepEqual([...(again.activation ?? [])], ['onStartup']);
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
    assert.equal(configSection(read(template(section))), section);
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
    'XiHan:Caching\n',
  ]) {
    invalidAt(template(section), '$.contributes.config.section');
  }
});

test('贡献的权限码遵循宿主的文法，重复时报第二次出现的项', () => {
  const template = (codes: string) =>
    `{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"plugin","isolation":"out-of-process","contributes":{"permissions":${codes}}}`;
  for (const codes of [
    '[]',
    '["orders.read"]',
    '["sales.orders.read","sales.orders.write"]',
    '["echo2.items-v2.read"]',
  ]) {
    assert.ok(read(template(codes)).contributes !== undefined, codes);
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
  ]) {
    invalidAt(template(codes), '$.contributes.permissions[0]');
  }
  invalidAt(template('["orders.read","orders.read"]'), '$.contributes.permissions[1]');
  invalidAt(template('["orders.read","orders.write","orders.read"]'), '$.contributes.permissions[2]');
});

test('贡献的操作按操作 ID 文法校验', () => {
  const template = (operation: string) =>
    `{"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable","kind":"capability","contributes":{"operations":[${JSON.stringify(operation)}]}}`;
  for (const operation of ['orders.create', 'order-lines.list', 'tenant-members.list-online', 'v2items.get']) {
    assert.deepEqual([...contributedOperations(read(template(operation)))], [operation]);
  }
  // 以前的 Schema 放过了连字符结尾、连续连字符与段首连字符，ADR-0233 起与操作 ID 文法一致
  for (const operation of [
    'orders-.create',
    'orders.create-',
    'order--lines.list',
    'orders.-list',
    'orders',
    'Orders.create',
    'orders.create\n',
  ]) {
    invalidAt(template(operation), '$.contributes.operations[0]');
  }
});

test('按 Schema 逐项核对：位置是第一处问题的路径', () => {
  const base = '"id":"xihan.a.b","version":"1.0.0","stability":"stable","kind":"capability"';
  const cases: [string, string][] = [
    [`{${base}}`, '$.primitives'],
    [`{${base},"primitives":1}`, '$.primitives'],
    [`{${base},"primitives":"^1"}`, '$.primitives'],
    [`{${base},"primitives":"01"}`, '$.primitives'],
    [`{${base},"primitives":"+1"}`, '$.primitives'],
    [`{${base},"primitives":" 1"}`, '$.primitives'],
    [`{${base},"primitives":"99999999999999999999"}`, '$.primitives'],
    [`{${base},"primitives":"1","provides":[{"id":"a.b","version":"^1"}]}`, '$.provides[0].version'],
    [`{${base},"primitives":"1","requires":[{"id":"a.b","version":1}]}`, '$.requires[0].version'],
    [`{${base},"primitives":"1","requires":[{"id":"a.b","version":"^^1"}]}`, '$.requires[0].version'],
    [`{${base},"primitives":"1","role":null}`, '$.role'],
    [`{${base},"primitives":"1","role":""}`, '$.role'],
    [`{${base},"primitives":"1","requires":[{"id":"a.b","version":"1","optional":"yes"}]}`, '$.requires[0].optional'],
    [`{${base},"primitives":"1","requires":[{"id":"a.b","version":"1","range":"^1"}]}`, '$.requires[0].range'],
    [`{${base},"primitives":"1","contributes":{"routes":[]}}`, '$.contributes.routes'],
    [`{${base},"primitives":"1","contributes":{"config":{}}}`, '$.contributes.config.section'],
    [`{${base},"Primitives":"1"}`, '$.Primitives'],
    [
      `{${base},"primitives":"1","contributes":{"pipeline":[{"middleware":"x","stage":"middle"}]}}`,
      '$.contributes.pipeline[0].stage',
    ],
    [`{${base},"primitives":"1","contributes":{"health":["ok","Bad"]}}`, '$.contributes.health[1]'],
    [`{${base},"primitives":"1","bindings":[{"name":"Db","type":"connection:relational"}]}`, '$.bindings[0].name'],
    // 整数样式的成员名按文本顺序报，不按 JavaScript 对象的键序
    [`{"9":1,"1":2}`, '$.9'],
    ['[]', '$'],
    ['"manifest"', '$'],
  ];
  for (const [data, reason] of cases) {
    invalidAt(data, reason);
  }
  const optional = read(`{${base},"primitives":"1","requires":[{"id":"a.b","version":"^2","optional":true}]}`);
  assert.deepEqual(optional.requires?.[0], { id: 'a.b', version: 2, optional: true });
  assert.equal(read(`{${base},"primitives":"2147483647"}`).primitives, maxInterfaceVersion);
});

test('读取的前两步：JSON 文本与字面量 null', () => {
  for (const data of ['', '{', '{"id":"a",}', `${String.fromCharCode(0xfeff)}{}`, '{"id":"\\ud800"}']) {
    const error = rejection(data);
    assert.equal(error.messageKey, ManifestMessageKey.InvalidJson, JSON.stringify(data));
    assert.deepEqual(error.details, { reason: '$' });
  }
  const invalidUtf8 = rejection(new Uint8Array([0x7b, 0xff, 0x7d]));
  assert.equal(invalidUtf8.messageKey, ManifestMessageKey.InvalidJson);
  const duplicate = rejection('{"id":"a","provides":[{"id":"b","id":"c"}]}');
  assert.equal(duplicate.messageKey, ManifestMessageKey.InvalidJson);
  assert.deepEqual(duplicate.details, { reason: '$.provides[0].id' });
  const empty = rejection('null');
  assert.equal(empty.messageKey, ManifestMessageKey.Empty);
  assert.equal(empty.details, undefined);
  assert.equal(empty.message, 'The manifest is empty.');
  assert.equal(rejection('[]').message, 'The manifest is not valid: $');
});

test('跨字段约束按 Validate 的顺序报，参数只有清单 ID', () => {
  const base = '"id":"xihan.a.b","version":"1.0.0","primitives":"1","stability":"stable"';
  const cases: [string, string][] = [
    [`{${base},"kind":"plugin"}`, ManifestMessageKey.IsolationRequired],
    [`{${base},"kind":"capability","isolation":"wasm"}`, ManifestMessageKey.IsolationNotAllowed],
    [`{${base},"kind":"capability","permissions":["capability:x"]}`, ManifestMessageKey.IsolationNotAllowed],
    [
      `{${base},"kind":"capability","provides":[{"id":"a.b","version":"1"},{"id":"a.b","version":"2"}]}`,
      ManifestMessageKey.DuplicateProvides,
    ],
    [
      `{${base},"kind":"capability","requires":[{"id":"a.b","version":"1"},{"id":"a.b","version":"^1"}]}`,
      ManifestMessageKey.DuplicateRequires,
    ],
    [
      `{${base},"kind":"capability","bindings":[{"name":"db","type":"queue"},{"name":"db","type":"cache"}]}`,
      ManifestMessageKey.DuplicateBindings,
    ],
    // 插件没有隔离又重复提供：先报隔离
    [
      `{${base},"kind":"plugin","provides":[{"id":"a.b","version":"1"},{"id":"a.b","version":"2"}]}`,
      ManifestMessageKey.IsolationRequired,
    ],
  ];
  for (const [data, key] of cases) {
    const error = rejection(data);
    assert.equal(error.messageKey, key, data);
    assert.deepEqual(error.details, { id: 'xihan.a.b' });
  }
  assert.equal(rejection(`{${base},"kind":"plugin"}`).message, "Plugin manifest 'xihan.a.b' must declare 'isolation'.");
  const validation = validateManifest({
    id: 'xihan.a.b',
    version: '1.0.0',
    primitives: 1,
    stability: Stability.Stable,
    kind: ManifestKind.Plugin,
  });
  assert.ok(!validation.ok);
  assert.equal(validation.error.code, ErrorCode.InvalidArgument, 'Validate keeps the primitives code');
  // 只有 Wasm 插件能贡献中间件由宿主在发现时核对，读取清单时不核对（与 .NET 一致）
  const pipeline = read(
    `{${base},"kind":"plugin","isolation":"out-of-process","contributes":{"pipeline":[{"middleware":"audit","stage":"observe"}]}}`,
  );
  assert.equal(pipeline.contributes?.pipeline?.[0]?.stage, PipelineStage.Observe);
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
    assert.equal(parseCapabilityRequirement(text), undefined, `${JSON.stringify(text)} must not parse`);
  }
  const declaration = parseCapabilityDeclaration('caching.distributed@2');
  assert.ok(declaration);
  assert.equal(capabilityDeclarationText(declaration), 'caching.distributed@2');
  assert.equal(parseCapabilityDeclaration('caching.distributed@^2'), undefined);
  assert.equal(parseCapabilityDeclaration('caching.distributed@02'), undefined);
  assert.equal(parseCapabilityDeclaration('caching.distributed@2147483648'), undefined);
  const requirement = parseCapabilityRequirement('caching.distributed@^2?');
  assert.ok(requirement);
  assert.ok(isRequirementSatisfiedBy(requirement, declaration));
  assert.equal(capabilityRequirementText(requirement), 'caching.distributed@2?');
  const other = parseCapabilityDeclaration('caching.distributed@1');
  assert.ok(other && !isRequirementSatisfiedBy(requirement, other), 'versions must match');
});

test('从文件读取清单：跳过 UTF-8 BOM，文件不存在时报路径', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xihan-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, ManifestFileName);
  await writeFile(path, echoManifest);
  assert.equal(read(writeManifest(unwrap(await readManifestFile(path)))).id, 'xihan.samples.echo');
  assert.equal(unwrap(await readManifestFile(pathToFileURL(path))).id, 'xihan.samples.echo');
  // 文件开头的 UTF-8 BOM 跳过；文本入口不跳过
  const bom = join(directory, 'bom.json');
  await writeFile(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(echoManifest)]));
  assert.equal(unwrap(await readManifestFile(bom)).id, 'xihan.samples.echo');
  const twice = join(directory, 'twice.json');
  await writeFile(twice, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from('{}')]));
  assert.equal(failed(await readManifestFile(twice)).messageKey, ManifestMessageKey.InvalidJson);
  const invalid = join(directory, 'invalid.json');
  await writeFile(invalid, Buffer.from([0x7b, 0xff, 0x7d]));
  assert.equal(failed(await readManifestFile(invalid)).messageKey, ManifestMessageKey.InvalidJson);
  for (const missing of [join(directory, 'missing.json'), join(directory, ManifestFileName, 'x.json')]) {
    const error = failed(await readManifestFile(missing));
    assert.equal(error.code, ManifestErrorCode.Invalid);
    assert.equal(error.messageKey, ManifestMessageKey.FileMissing);
    assert.deepEqual(error.details, { path: missing });
    assert.equal(error.message, `Manifest file '${missing}' does not exist.`);
  }
  const folder = join(directory, 'folder');
  await mkdir(folder);
  assert.equal(failed(await readManifestFile(folder)).messageKey, ManifestMessageKey.FileMissing);
});

function unwrap<T>(result: Result<T>): T {
  assert.ok(result.ok, result.ok ? '' : result.error.toString());
  return result.value;
}

function failed<T>(result: Result<T>): ErrorInfo {
  assert.ok(!result.ok, 'expected a failure');
  return result.error;
}

/** kernel-messages.json 里清单读取的错误：键 → 码与 en-US 模板 */
const kernelTemplates = new Map(
  vector<{ messages: { code: string; key: string; template: string }[] }>('kernel-messages.json').messages.map(
    (message) => [message.key, message] as const,
  ),
);

test('清单的读取与写出遵循 manifests.json', () => {
  // 向量里的清单是 JSON 值，成员顺序就是文本顺序：按保留文档顺序的树读，再写成紧凑的文本交给读取
  const url = new URL('../spec/conformance/vectors/manifest/manifests.json', import.meta.url);
  const document = readJsonText(readFileSync(url));
  assert.ok(document.ok && document.root instanceof JsonMembers);
  const cases = (name: string) => document.root instanceof JsonMembers && (document.root.get(name) as JsonMembers[]);
  const valid = cases('valid') || [];
  const invalid = cases('invalid') || [];
  assert.ok(valid.length > 0 && invalid.length > 0);
  const textOf = (c: JsonMembers): string =>
    c.has('text') ? (c.get('text') as string) : writeJson(c.get('manifest') as JsonNode);
  for (const c of valid) {
    const name = c.get('name') as string;
    const manifest = read(textOf(c));
    const written = writeManifest(manifest);
    assert.equal(written, c.get('written'), name);
    assert.deepEqual(read(written), manifest, `${name} reads back the same manifest`);
  }
  for (const c of invalid) {
    const name = c.get('name') as string;
    const expected = toJsonValue(c.get('error') as JsonNode) as {
      code: string;
      messageKey: string;
      arguments: Record<string, string>;
    };
    const result = readManifest(textOf(c));
    assert.ok(!result.ok, `${name} must be rejected`);
    assert.equal(result.error.code, expected.code, name);
    assert.equal(result.error.messageKey, expected.messageKey, name);
    assert.deepEqual({ ...result.error.details }, expected.arguments, name);
    // 消息是 kernel-messages.json 的英文模板填入参数，与 .NET 相同（ADR-0236）
    const template = kernelTemplates.get(expected.messageKey);
    assert.equal(template?.code, expected.code, `${expected.messageKey} is a kernel message`);
    assert.equal(result.error.message, formatMessage(template?.template ?? '', expected.arguments), name);
  }
});

test('写出前核对程序里构造的清单', () => {
  const manifest: Manifest = {
    id: 'xihan.a.b',
    version: '1.0.0',
    primitives: 1,
    stability: Stability.Stable,
    kind: ManifestKind.Capability,
    activation: [],
  };
  // 写出的清单读不回来即抛出，码、键与参数与读取相同
  assert.throws(
    () => writeManifest(manifest),
    (error: unknown) =>
      error instanceof FrameworkError &&
      error.code === ManifestErrorCode.Invalid &&
      error.messageKey === ManifestMessageKey.Invalid &&
      error.details?.reason === '$.activation',
  );
  assert.throws(() => writeManifest({ ...manifest, activation: undefined, primitives: 0 } as never), {
    message: "The manifest member at '$.primitives' has the wrong type.",
  });
  assert.throws(() => writeManifest({ ...manifest, id: 5 } as never), FrameworkError);
  assert.throws(
    () => writeManifest({ id: 'xihan.a.b', version: '1.0.0', primitives: 1, stability: 'stable', kind: 'plugin' }),
    (error: unknown) => error instanceof FrameworkError && error.messageKey === ManifestMessageKey.IsolationRequired,
  );
});

test('读取清单文件连同原文：原文按严格的 UTF-8 解码、不带 BOM，与读出的清单来自同一段字节', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xihan-manifest-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bomBytes = Buffer.from([0xef, 0xbb, 0xbf]);
  const path = join(directory, ManifestFileName);
  await writeFile(path, Buffer.concat([bomBytes, Buffer.from(echoManifest)]));
  const source = unwrap(await readManifestSource(path));
  assert.equal(source.text, echoManifest, 'the text carries no BOM');
  assert.equal(source.manifest.id, 'xihan.samples.echo');
  assert.deepEqual(source.manifest, read(source.text), 'the manifest is what the text reads as');
  assert.ok(Object.isFrozen(source));
  assert.deepEqual(unwrap(await readManifestSource(pathToFileURL(path))), source);
  // readManifestFile 是它只取清单的特例
  assert.deepEqual(unwrap(await readManifestFile(path)), source.manifest);

  // 已经在内存里的文件内容走同一个解码：BOM 跳过一次，非 ASCII 原样
  const localized = echoManifest.replace('"entry": "EchoPlugin"', '"entry": "回声"');
  assert.notEqual(localized, echoManifest);
  assert.equal(unwrap(readManifestBytes(Buffer.from(localized))).text, localized);
  assert.equal(unwrap(readManifestBytes(Buffer.concat([bomBytes, Buffer.from(localized)]))).text, localized);
  assert.equal(
    failed(readManifestBytes(Buffer.concat([bomBytes, bomBytes, Buffer.from(echoManifest)]))).messageKey,
    ManifestMessageKey.InvalidJson,
    'only one BOM is skipped',
  );

  // 字符串值里的坏字节：宽松的解码会把它换成 U+FFFD、读出一份与文件字节不同的清单，这里按 JSON 文本不合法拒绝
  const bytes = Buffer.from(echoManifest);
  const corrupted = Buffer.from(bytes);
  corrupted[bytes.indexOf('EchoPlugin')] = 0xff;
  await writeFile(path, corrupted);
  for (const result of [readManifestBytes(corrupted), await readManifestSource(path), await readManifestFile(path)]) {
    const error = failed(result as Result<unknown>);
    assert.equal(error.code, ManifestErrorCode.Invalid);
    assert.equal(error.messageKey, ManifestMessageKey.InvalidJson);
    assert.deepEqual(error.details, { reason: '$' });
  }
  const missing = join(directory, 'missing.json');
  const absent = failed(await readManifestSource(missing));
  assert.equal(absent.messageKey, ManifestMessageKey.FileMissing);
  assert.deepEqual(absent.details, { path: missing });
});
