import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { fileURLToPath } from 'node:url';

import {
  type ClientReadableStream,
  credentials,
  Metadata,
  Server,
  ServerCredentials,
  type ServerUnaryCall,
  type ServiceError,
  type sendUnaryData,
  status,
} from '@grpc/grpc-js';
import type { InvocationContext } from 'xihan-framework/invocation';
import { defineContract, Expose, OperationRegistry, RequestShape } from 'xihan-framework/operation';
import {
  CallbackPermission,
  defaultNetwork,
  type Envelope,
  findHost,
  formatHandshakeLine,
  HealthStatus,
  type LogTarget,
  loadCatalog,
  negotiateProtocolVersion,
  type PluginEndpoint,
  PluginErrorCode,
  PluginLogger,
  PluginMessageKey,
  type PluginOptions,
  PluginProtocol,
  parseEndpoint,
  parseHandshakeLine,
  pluginTemplates,
  SubscriptionMode,
  servePlugin,
} from 'xihan-framework/plugin';
import {
  BaggageKey,
  ErrorInfo,
  Float64,
  FrameworkError,
  type JsonValue,
  LifecycleState,
  lifecycleStateOrdinal,
  parseJson,
  placeholders,
  Result,
  writeJson,
} from 'xihan-framework/primitives';

// 协议的生成代码不是公开入口：测试直接加载它，扮演宿主调用插件、扮演宿主的回调服务
import * as pb from '../src/plugin/gen/plugin.ts';

/** 读取规范仓库的插件向量 */
function vector<T>(name: string): T {
  const url = new URL(`../spec/conformance/vectors/plugin/${name}`, import.meta.url);
  return parseJson(readFileSync(url)) as unknown as T;
}

/** 测试插件的会话令牌 */
const token = 'test-session-token-0123456789abcdefghijklmnopqrstuvwxyz';

/** 测试插件的清单 */
const manifest = `${JSON.stringify(
  {
    $schema: 'https://spec.xihanfun.com/manifest/v1.json',
    id: 'xihan.tests.probe',
    version: '1.0.0',
    primitives: '1',
    stability: 'experimental',
    kind: 'plugin',
    isolation: 'out-of-process',
    contributes: {
      operations: ['probes.context', 'probes.fail', 'probes.slow', 'probes.relay', 'probes.publish'],
      health: ['probe'],
    },
    permissions: [CallbackPermission.Invoke, CallbackPermission.Publish],
    entry: 'probe',
  },
  null,
  2,
)}\n`;

/** 一个可以从外面放行的闸门 */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** 测试插件的状态：处理器把看到的东西交给测试 */
interface Probe {
  /** 最近一次 probes.context 的上下文 */
  lastContext: InvocationContext | undefined;
  /** probes.slow 等它放行 */
  slow: ReturnType<typeof gate>;
  /** probes.slow 已经开始 */
  slowStarted: ReturnType<typeof gate>;
}

/** 测试插件的操作 */
function probeRegistry(probe: Probe): OperationRegistry {
  const registry = new OperationRegistry();
  registry.add({
    contract: defineContract<{ text?: string | null }, JsonValue>({ id: 'probes.context', expose: [Expose.Http] }),
    request: RequestShape.object({ text: RequestShape.string() }),
    schema: { request: '{"type":"object"}', response: '{"type":"object"}' },
    handler: async (context, request) => {
      probe.lastContext = context;
      return Result.ok({
        text: request?.text ?? null,
        tenant: context.tenant ?? null,
        principal: context.principal ?? null,
        correlation: context.correlation ?? null,
        baggage: { ...context.baggage },
        deadline: context.deadline ?? null,
        traceId: context.traceId,
        sampled: context.sampled,
        aborted: context.signal.aborted,
      });
    },
  });
  registry.add({
    contract: defineContract<unknown, never>({ id: 'probes.fail', expose: [], permission: 'probes.fail' }),
    request: RequestShape.object({}),
    handler: async () =>
      Result.fail(
        ErrorInfo.validation('PROBES_VALIDATION_001', 'probes.value.invalid', { min: 1, ratio: new Float64(2) }),
      ),
  });
  registry.add({
    contract: defineContract<unknown, { readonly done: boolean }>({ id: 'probes.slow', expose: [] }),
    request: RequestShape.object({}),
    handler: async () => {
      probe.slowStarted.open();
      await probe.slow.wait;
      return Result.ok({ done: true });
    },
  });
  registry.add({
    contract: defineContract<{ operation: string | null }, JsonValue>({ id: 'probes.relay', expose: [] }),
    request: RequestShape.object({ operation: RequestShape.required(RequestShape.string()) }),
    handler: async (context, request) => {
      const host = findHost(context);
      if (host === undefined) {
        return Result.fail(ErrorInfo.unavailable('PROBES_UNAVAILABLE_001', 'probes.host.unavailable'));
      }
      const response = await host.invoke(context, request?.operation ?? '', '{"x":1}');
      return response.outcome.ok
        ? Result.ok(response.payload ? parseJson(response.payload) : {})
        : Result.fail(response.outcome.error);
    },
  });
  registry.add({
    contract: defineContract<{ tenants: (string | null)[] | null }, JsonValue>({ id: 'probes.publish', expose: [] }),
    request: RequestShape.object({ tenants: RequestShape.required(RequestShape.array(RequestShape.string())) }),
    handler: async (context, request) => {
      const host = findHost(context);
      if (host === undefined) {
        return Result.fail(ErrorInfo.unavailable('PROBES_UNAVAILABLE_001', 'probes.host.unavailable'));
      }
      const envelopes: Envelope[] = (request?.tenants ?? []).map((tenant, index) => ({
        topic: 'probe.events',
        id: `e-${index}`,
        source: 'urn:test',
        type: 'probe.happened',
        data: '{}',
        ...(tenant === null ? {} : { extensions: { xihantenant: tenant } }),
      }));
      const results = await host.publish(context, envelopes);
      return Result.ok(results.map((result) => (result.ok ? 'ok' : result.error.code)));
    },
  });
  return registry;
}

/** 一个在本进程里运行的插件，以及扮演宿主的客户端 */
interface Launched {
  readonly endpoint: PluginEndpoint;
  readonly client: pb.PluginClient;
  readonly stdin: PassThrough;
  readonly served: Promise<void>;
  readonly logs: string[];
  readonly probe: Probe;
  /** 关闭客户端并让插件退出 */
  close(): Promise<void>;
}

/** 在本进程里启动测试插件（回环 TCP，各平台一样），读握手行并连上 */
async function launch(options: Partial<PluginOptions> = {}, env: Record<string, string> = {}): Promise<Launched> {
  const probe: Probe = { lastContext: undefined, slow: gate(), slowStarted: gate() };
  const stdin = new PassThrough();
  const logs: string[] = [];
  let output = '';
  const handshake = gate();
  const stdout: LogTarget = {
    write(text: string) {
      output += text;
      if (output.includes('\n')) {
        handshake.open();
      }
      return true;
    },
  };
  const served = servePlugin({
    manifest,
    registry: probeRegistry(probe),
    network: 'tcp',
    stdin,
    stdout,
    logger: new PluginLogger({ write: (text: string) => logs.push(text) }),
    env: { XIHAN_PLUGIN_SESSION: token, XIHAN_PLUGIN_PROTOCOL_VERSIONS: '1', XIHAN_PLUGIN_PRIMITIVES: '1', ...env },
    stopGrace: 2000,
    healthInterval: 50,
    ...options,
  });
  await Promise.race([handshake.wait, served]);
  const [line = '', ...rest] = output.split('\n');
  assert.deepEqual(rest, [''], 'nothing but the handshake line goes to stdout');
  const endpoint = parseHandshakeLine(line);
  assert.ok(endpoint !== undefined, `the handshake line '${line}' must follow the grammar`);
  const client = new pb.PluginClient(
    endpoint.network === 'tcp' ? endpoint.address : `unix:${endpoint.address}`,
    credentials.createInsecure(),
  );
  return {
    endpoint,
    client,
    stdin,
    served,
    logs,
    probe,
    async close() {
      client.close();
      stdin.end();
      await served;
    },
  };
}

/** 会话元数据；`session` 为 `null` 时不带 */
function sessionMetadata(session: string | null = token): Metadata {
  const metadata = new Metadata();
  if (session !== null) {
    metadata.set(PluginProtocol.sessionMetadataKey, session);
  }
  return metadata;
}

/** 把回调形态的一元调用换成 Promise */
function unary<T>(start: (done: (error: ServiceError | null, value: T) => void) => unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    start((error, value) => (error === null ? resolve(value) : reject(error)));
  });
}

/** 断言一个调用以给定的 gRPC 状态失败 */
async function rejectsWith(promise: Promise<unknown>, code: number): Promise<void> {
  await assert.rejects(promise, (error: ServiceError) => {
    assert.equal(error.code, code, error.details);
    return true;
  });
}

/** 宿主的握手请求 */
function handshakeRequest(versions: number[] = [1]): pb.HandshakeRequest {
  return pb.HandshakeRequest.fromPartial({
    protocolVersions: versions,
    primitives: 1,
    instanceId: 'test',
    host: { frameworkVersion: 'spec', sdk: 'test', sdkVersion: '0', application: 'test' },
    defaultLocale: 'en-US',
  });
}

/** 握手、配置并启动 */
async function startPlugin(client: pb.PluginClient, configuration = '{}'): Promise<pb.HandshakeResponse> {
  const handshake = await unary<pb.HandshakeResponse>((done) =>
    client.handshake(handshakeRequest(), sessionMetadata(), done),
  );
  const configured = await unary<pb.ConfigureResponse>((done) =>
    client.configure(
      pb.ConfigureRequest.fromPartial({ configuration, grantedPermissions: [], workDirectory: '.' }),
      sessionMetadata(),
      done,
    ),
  );
  assert.equal(configured.status?.ok, true);
  const started = await unary<pb.StartResponse>((done) => client.start({}, sessionMetadata(), done));
  assert.equal(started.status?.ok, true);
  return handshake;
}

/** 调用一个操作 */
function invoke(
  client: pb.PluginClient,
  operation: string,
  payload = '{}',
  metadata?: Partial<pb.InvocationMetadata>,
  session: string | null = token,
): Promise<pb.InvokeResponse> {
  return unary<pb.InvokeResponse>((done) =>
    client.invoke(
      pb.InvokeRequest.fromPartial({ operation, payload: new TextEncoder().encode(payload), metadata }),
      sessionMetadata(session),
      done,
    ),
  );
}

/** 响应载荷读成 JSON */
function payloadOf(response: pb.InvokeResponse): unknown {
  return JSON.parse(new TextDecoder().decode(response.payload));
}

/** 收集服务端流的消息，直到流结束或出错 */
function collect<T>(stream: ClientReadableStream<T>, onMessage?: (message: T, all: T[]) => void) {
  const messages: T[] = [];
  const ended = new Promise<ServiceError | undefined>((resolve) => {
    stream.on('data', (message: T) => {
      messages.push(message);
      onMessage?.(message, messages);
    });
    stream.on('error', (error: ServiceError) => resolve(error));
    stream.on('end', () => resolve(undefined));
  });
  return { messages, ended };
}

test('握手行与端点的文法遵循 handshake-lines.json', () => {
  const vectors = vector<{ valid: { line: string; network: string; address: string }[]; invalid: string[] }>(
    'handshake-lines.json',
  );
  for (const valid of vectors.valid) {
    const endpoint = parseHandshakeLine(valid.line);
    assert.deepEqual(endpoint, { network: valid.network, address: valid.address }, valid.line);
    assert.equal(formatHandshakeLine(endpoint), valid.line);
    assert.deepEqual(parseEndpoint(`${valid.network} ${valid.address}`), endpoint);
  }
  for (const invalid of vectors.invalid) {
    assert.equal(parseHandshakeLine(invalid), undefined, invalid);
  }
  // 结尾的换行不例外：文法整串匹配（RFC-0001「文法的匹配」）
  assert.equal(parseHandshakeLine('xihan-plugin/1 unix /run/plugin.sock\n'), undefined);
  assert.equal(formatHandshakeLine({ network: 'tcp', address: '10.0.0.5:1' }), undefined);
  assert.equal(parseEndpoint('unix'), undefined);
});

test('协议版本协商遵循 protocol-versions.json', () => {
  const vectors = vector<{ cases: { host: number[]; plugin: number[]; selected?: number; error?: string }[] }>(
    'protocol-versions.json',
  );
  for (const entry of vectors.cases) {
    assert.equal(negotiateProtocolVersion(entry.host, entry.plugin), entry.selected, JSON.stringify(entry));
  }
  assert.equal(negotiateProtocolVersion([1, 2, 3]), PluginProtocol.version);
});

test('每个 RPC 先核对会话令牌：缺失或不匹配以 Unauthenticated 结束、不执行（handshake.md §4）', async () => {
  const plugin = await launch();
  try {
    for (const session of [null, '', 'not-the-session-token', `${token}x`]) {
      await rejectsWith(
        unary((done) => plugin.client.handshake(handshakeRequest(), sessionMetadata(session), done)),
        status.UNAUTHENTICATED,
      );
      await rejectsWith(invoke(plugin.client, 'probes.context', '{}', undefined, session), status.UNAUTHENTICATED);
      const watch = collect(plugin.client.watchHealth({}, sessionMetadata(session)));
      assert.equal((await watch.ended)?.code, status.UNAUTHENTICATED);
      assert.equal(watch.messages.length, 0);
      const stream = plugin.client.invokeStream(sessionMetadata(session));
      const streamed = collect(stream);
      stream.write({ start: pb.InvokeRequest.fromPartial({ operation: 'probes.context' }) });
      assert.equal((await streamed.ended)?.code, status.UNAUTHENTICATED);
    }
    // 被拒的调用没有执行：插件仍在 Declared，带对令牌照常握手
    const response = await unary<pb.HandshakeResponse>((done) =>
      plugin.client.handshake(handshakeRequest(), sessionMetadata(), done),
    );
    assert.equal(response.protocolVersion, 1);
    // 两个令牌值也不行：只认恰好一个
    const doubled = sessionMetadata();
    doubled.add(PluginProtocol.sessionMetadataKey, token);
    await rejectsWith(
      unary((done) => plugin.client.health({}, doubled, done)),
      status.UNAUTHENTICATED,
    );
  } finally {
    await plugin.close();
  }
});

test('握手交出清单原文、操作声明、订阅与目录；没有共同版本时以 FailedPrecondition 拒绝', async () => {
  const subscriptions: PluginOptions['subscriptions'] = [
    { topic: 'probe.events', handler: async () => Result.success() },
    {
      topic: 'probe.events',
      messageType: 'probe.flush',
      mode: SubscriptionMode.Broadcast,
      handler: async () => Result.success(),
    },
  ];
  const catalogs = [{ name: 'probes', locales: { 'en-US': { 'probes.value.invalid': 'At least {min}.' } } }];
  const plugin = await launch({ subscriptions, catalogs });
  try {
    await rejectsWith(
      unary((done) => plugin.client.handshake(handshakeRequest([2, 3]), sessionMetadata(), done)),
      status.FAILED_PRECONDITION,
    );
    const response = await unary<pb.HandshakeResponse>((done) =>
      plugin.client.handshake(handshakeRequest([1, 2]), sessionMetadata(), done),
    );
    assert.equal(response.protocolVersion, 1);
    assert.equal(response.primitives, 1);
    // 清单原文原样交出（不含开头的 BOM），宿主据此与目录里的文件逐字段比较
    assert.equal(response.manifest, manifest);
    assert.deepEqual(response.sdk, { name: 'framework-sdk-typescript', version: '0.1.0', language: 'typescript' });
    assert.deepEqual(
      response.operations.map((operation) => operation.id),
      ['probes.context', 'probes.fail', 'probes.publish', 'probes.relay', 'probes.slow'],
    );
    const context = response.operations.find((operation) => operation.id === 'probes.context');
    assert.deepEqual(context, {
      id: 'probes.context',
      stability: 'stable',
      expose: ['http'],
      permission: '',
      policy: '',
      requestSchema: '{"type":"object"}',
      responseSchema: '{"type":"object"}',
      streaming: false,
    });
    assert.equal(response.operations.find((operation) => operation.id === 'probes.fail')?.permission, 'probes.fail');
    assert.deepEqual(response.subscriptions, [
      { topic: 'probe.events', messageType: '', mode: '' },
      { topic: 'probe.events', messageType: 'probe.flush', mode: 'broadcast' },
    ]);
    assert.deepEqual(response.catalogs, [
      { name: 'probes', locales: [{ locale: 'en-US', templates: { 'probes.value.invalid': 'At least {min}.' } }] },
    ]);
    // 握手只做一次
    await rejectsWith(
      unary((done) => plugin.client.handshake(handshakeRequest(), sessionMetadata(), done)),
      status.FAILED_PRECONDITION,
    );
  } finally {
    await plugin.close();
  }
});

test('生命周期按顺序：Configure 要先握手、Start 要先 Configure，启动之前的调用不可用', async () => {
  const plugin = await launch();
  try {
    const configure = pb.ConfigureRequest.fromPartial({ configuration: '{}' });
    await rejectsWith(
      unary((done) => plugin.client.configure(configure, sessionMetadata(), done)),
      status.FAILED_PRECONDITION,
    );
    await unary((done) => plugin.client.handshake(handshakeRequest(), sessionMetadata(), done));
    await rejectsWith(
      unary((done) => plugin.client.start({}, sessionMetadata(), done)),
      status.FAILED_PRECONDITION,
    );
    const early = await invoke(plugin.client, 'probes.context');
    assert.equal(early.status?.ok, false);
    assert.equal(early.status?.error?.code, PluginErrorCode.Unavailable);
    assert.equal(early.status?.error?.messageKey, PluginMessageKey.Unavailable);
    assert.deepEqual(JSON.parse(early.status?.error?.details ?? ''), { id: 'xihan.tests.probe', state: 'Resolved' });
    assert.equal(early.status?.error?.text, "Plugin 'xihan.tests.probe' is not available (state: Resolved).");
    const health = await unary<pb.HealthResponse>((done) => plugin.client.health({}, sessionMetadata(), done));
    assert.equal(health.state, lifecycleStateOrdinal(LifecycleState.Resolved));
  } finally {
    await plugin.close();
  }
});

test('配置节不是 JSON 对象、回调失败或抛出时 Configure 失败，插件进入 Failed', async () => {
  for (const [configuration, hooks, code] of [
    ['[1]', {}, PluginErrorCode.Unexpected],
    [
      '{"retries":"x"}',
      { configure: () => Result.fail(ErrorInfo.validation('PROBES_VALIDATION_002', 'probes.config.invalid')) },
      'PROBES_VALIDATION_002',
    ],
    [
      '{}',
      {
        configure: () => {
          throw new TypeError('secret detail');
        },
      },
      PluginErrorCode.Unexpected,
    ],
  ] as const) {
    const plugin = await launch({ hooks });
    try {
      await unary((done) => plugin.client.handshake(handshakeRequest(), sessionMetadata(), done));
      const configured = await unary<pb.ConfigureResponse>((done) =>
        plugin.client.configure(pb.ConfigureRequest.fromPartial({ configuration }), sessionMetadata(), done),
      );
      assert.equal(configured.status?.ok, false);
      assert.equal(configured.status?.error?.code, code);
      // 异常消息不上线
      assert.doesNotMatch(JSON.stringify(configured.status), /secret detail/);
      const health = await unary<pb.HealthResponse>((done) => plugin.client.health({}, sessionMetadata(), done));
      assert.equal(health.state, lifecycleStateOrdinal(LifecycleState.Failed));
      assert.equal(health.error?.code, code);
    } finally {
      await plugin.close();
    }
  }
});

test('Configure 把配置节、权限、绑定与工作目录交给回调', async () => {
  let seen: unknown;
  const plugin = await launch({
    hooks: {
      configure: (configuration) => {
        seen = configuration;
        return Result.success();
      },
    },
  });
  try {
    await unary((done) => plugin.client.handshake(handshakeRequest(), sessionMetadata(), done));
    const configured = await unary<pb.ConfigureResponse>((done) =>
      plugin.client.configure(
        pb.ConfigureRequest.fromPartial({
          configuration: '',
          grantedPermissions: [CallbackPermission.Invoke],
          bindings: [{ name: 'cache', type: 'cache:distributed', value: 'redis:6379' }],
          workDirectory: '/var/lib/probe',
        }),
        sessionMetadata(),
        done,
      ),
    );
    assert.equal(configured.status?.ok, true);
    assert.deepEqual(seen, {
      section: {},
      text: '{}',
      grantedPermissions: [CallbackPermission.Invoke],
      bindings: [{ name: 'cache', type: 'cache:distributed', value: 'redis:6379' }],
      workDirectory: '/var/lib/probe',
    });
  } finally {
    await plugin.close();
  }
});

test('Invoke 经调用器执行：成功的载荷、业务失败的错误编码、载荷不合法与未声明的操作', async () => {
  const plugin = await launch();
  try {
    await startPlugin(plugin.client);
    const ok = await invoke(plugin.client, 'probes.context', '{"text":"hi"}');
    assert.equal(ok.status?.ok, true);
    assert.equal((payloadOf(ok) as { text: string }).text, 'hi');
    // 空载荷等价于 {}
    assert.equal((await invoke(plugin.client, 'probes.context', '')).status?.ok, true);

    const failed = await invoke(plugin.client, 'probes.fail');
    assert.equal(failed.status?.ok, false);
    assert.equal(failed.payload.length, 0);
    // details 按值模型写出：整数值的浮点带小数点（RFC-0001「Result」）
    assert.deepEqual(failed.status?.error, {
      code: 'PROBES_VALIDATION_001',
      messageKey: 'probes.value.invalid',
      text: 'probes.value.invalid (min=1, ratio=2)',
      details: '{"min":1,"ratio":2.0}',
      inner: undefined,
    });

    const invalid = await invoke(plugin.client, 'probes.context', '{"text":1}');
    assert.equal(invalid.status?.error?.code, 'KERNEL_VALIDATION_001');
    assert.deepEqual(JSON.parse(invalid.status?.error?.details ?? ''), { id: 'probes.context', reason: '$.text' });

    // 未声明的操作是协议层失败，不是业务失败
    await rejectsWith(invoke(plugin.client, 'probes.missing'), status.UNIMPLEMENTED);
  } finally {
    await plugin.close();
  }
});

test('调用上下文从元数据还原：截止时间、追踪与只收已登记键的 Baggage（invocation.md §2，RFC-0003）', async () => {
  const plugin = await launch();
  try {
    await startPlugin(plugin.client);
    const deadline = new Date(Date.now() + 60_000);
    // 七位小数秒：多余的位截掉，只会提前不到 1 毫秒
    const text = `${deadline.toISOString().slice(0, 23)}4567Z`;
    const response = await invoke(plugin.client, 'probes.context', '{}', {
      traceParent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00',
      deadline: text,
      baggage: {
        [BaggageKey.Tenant]: 't1',
        [BaggageKey.Principal]: 'u1',
        [BaggageKey.Correlation]: 'bad\nvalue',
        'xihan.unregistered': 'dropped',
        other: 'dropped',
      },
    });
    const seen = payloadOf(response) as Record<string, unknown>;
    assert.equal(seen.tenant, 't1');
    assert.equal(seen.principal, 'u1');
    // 含控制字符的值丢弃，未登记的键丢弃（RFC-0003 第 3 条）
    assert.equal(seen.correlation, null);
    assert.deepEqual(seen.baggage, { [BaggageKey.Principal]: 'u1', [BaggageKey.Tenant]: 't1' });
    assert.equal(seen.deadline, deadline.getTime());
    assert.equal(seen.traceId, '0af7651916cd43dd8448eb211c80319c');
    assert.equal(seen.sampled, false);
    assert.equal(seen.aborted, false);

    // 没有元数据截止时间时取 gRPC 调用自己的截止时间
    const grpcDeadline = new Date(Date.now() + 30_000);
    const fallback = await unary<pb.InvokeResponse>((done) =>
      plugin.client.invoke(
        pb.InvokeRequest.fromPartial({ operation: 'probes.context', payload: new Uint8Array() }),
        sessionMetadata(),
        { deadline: grpcDeadline },
        done,
      ),
    );
    const fallbackDeadline = (payloadOf(fallback) as { deadline: number }).deadline;
    assert.ok(Math.abs(fallbackDeadline - grpcDeadline.getTime()) < 1000, `${fallbackDeadline}`);
  } finally {
    await plugin.close();
  }
});

test('事件按（主题，投递的方式）与类型交给处理器；找不到以这种方式声明的订阅时返回失败（invocation.md §4）', async () => {
  const delivered: string[] = [];
  const record = (name: string) => async (_context: InvocationContext, envelope: { readonly id: string }) => {
    delivered.push(`${name}:${envelope.id}`);
    return Result.success();
  };
  const plugin = await launch({
    subscriptions: [
      { topic: 'probe.events', handler: record('competing') },
      {
        topic: 'probe.events',
        messageType: 'probe.flush',
        mode: SubscriptionMode.Broadcast,
        handler: record('broadcast'),
      },
      {
        topic: 'probe.failing',
        handler: async () => Result.fail(ErrorInfo.unavailable('PROBES_UNAVAILABLE_002', 'probes.store.down')),
      },
    ],
  });
  try {
    await startPlugin(plugin.client);
    const deliver = (topic: string, type: string, mode: string, id: string) =>
      unary<pb.HandleEventResponse>((done) =>
        plugin.client.handleEvent(
          pb.HandleEventRequest.fromPartial({
            envelope: { topic, id, source: 'urn:test', type, specVersion: '1.0', data: new Uint8Array() },
            attempt: 1,
            mode,
          }),
          sessionMetadata(),
          done,
        ),
      );
    assert.equal((await deliver('probe.events', 'probe.flush', 'competing', '1')).status?.ok, true);
    assert.equal((await deliver('probe.events', 'probe.flush', 'broadcast', '2')).status?.ok, true);
    // 空同 competing
    assert.equal((await deliver('probe.events', 'probe.other', '', '3')).status?.ok, true);
    // 广播只声明了 probe.flush：别的类型不改交给竞争订阅
    const unmatched = await deliver('probe.events', 'probe.other', 'broadcast', '4');
    assert.equal(unmatched.status?.ok, false);
    assert.equal(unmatched.status?.error?.code, PluginErrorCode.Unexpected);
    assert.equal(unmatched.status?.error?.messageKey, PluginMessageKey.Failed);
    const failed = await deliver('probe.failing', 'x', 'competing', '5');
    assert.equal(failed.status?.error?.code, 'PROBES_UNAVAILABLE_002');
    assert.deepEqual(delivered, ['competing:1', 'broadcast:2', 'competing:3']);
  } finally {
    await plugin.close();
  }
});

test('Health 与 WatchHealth：先推当前状态，健康变化时再推，未声明的健康项不上报，停止时推 Draining 并结束', async () => {
  let health: { state: LifecycleState; status: HealthStatus } = {
    state: LifecycleState.Ready,
    status: HealthStatus.Healthy,
  };
  const plugin = await launch({
    hooks: {
      health: () => ({
        state: health.state,
        items: [
          { name: 'probe', status: health.status, description: 'probe item' },
          { name: 'undeclared', status: HealthStatus.Healthy },
        ],
      }),
    },
  });
  await startPlugin(plugin.client);
  const first = await unary<pb.HealthResponse>((done) => plugin.client.health({}, sessionMetadata(), done));
  assert.equal(first.state, lifecycleStateOrdinal(LifecycleState.Ready));
  assert.deepEqual(first.items, [
    { name: 'probe', status: pb.HealthStatus.HEALTH_STATUS_HEALTHY, description: 'probe item' },
  ]);
  assert.equal(plugin.logs.filter((line) => line.includes('undeclared')).length, 1);

  const changed = gate();
  const watch = collect(plugin.client.watchHealth({}, sessionMetadata()), (_message, all) => {
    if (all.length === 2) {
      changed.open();
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  health = { state: LifecycleState.Degraded, status: HealthStatus.Unhealthy };
  await changed.wait;
  assert.equal(watch.messages[0]?.state, lifecycleStateOrdinal(LifecycleState.Ready));
  assert.equal(watch.messages[1]?.state, lifecycleStateOrdinal(LifecycleState.Degraded));
  assert.equal(watch.messages[1]?.items[0]?.status, pb.HealthStatus.HEALTH_STATUS_UNHEALTHY);

  const stopped = await unary<pb.StopResponse>((done) =>
    plugin.client.stop({ graceSeconds: 1, reason: 'unload' }, sessionMetadata(), done),
  );
  assert.equal(stopped.status?.ok, true);
  assert.equal(await watch.ended, undefined);
  assert.equal(watch.messages.at(-1)?.state, lifecycleStateOrdinal(LifecycleState.Draining));
  await plugin.served;
  plugin.client.close();
});

test('Stop 拒绝新调用、在宽限内等在途调用，再调用停止回调，之后服务停止（lifecycle.md §5）', async () => {
  const stops: unknown[] = [];
  const plugin = await launch({
    hooks: {
      stop: (stop) => {
        stops.push({ reason: stop.reason, aborted: stop.signal.aborted });
        return Result.success();
      },
    },
  });
  await startPlugin(plugin.client);
  const slow = invoke(plugin.client, 'probes.slow');
  await plugin.probe.slowStarted.wait;
  const stopping = unary<pb.StopResponse>((done) =>
    plugin.client.stop({ graceSeconds: 5, reason: 'restart' }, sessionMetadata(), done),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rejected = await invoke(plugin.client, 'probes.context');
  assert.equal(rejected.status?.error?.code, PluginErrorCode.Unavailable);
  assert.deepEqual(JSON.parse(rejected.status?.error?.details ?? ''), { id: 'xihan.tests.probe', state: 'Draining' });
  assert.deepEqual(stops, [], 'the stop hook runs after the in-flight calls finish');
  plugin.probe.slow.open();
  assert.deepEqual(payloadOf(await slow), { done: true });
  assert.equal((await stopping).status?.ok, true);
  assert.deepEqual(stops, [{ reason: 'restart', aborted: false }]);
  await plugin.served;
  // stdin 随后关闭也不再收尾一次
  plugin.stdin.end();
  assert.equal(stops.length, 1);
  plugin.client.close();
});

test('stdin 关闭即停止服务，不留孤儿进程（handshake.md §1）', async () => {
  const plugin = await launch();
  await startPlugin(plugin.client);
  plugin.stdin.end();
  await plugin.served;
  assert.ok(plugin.logs.some((line) => line.includes('stdin closed')));
  await rejectsWith(invoke(plugin.client, 'probes.context'), status.UNAVAILABLE);
  plugin.client.close();
});

test('InvokeStream 核对帧序：第一帧不是 start 即 InvalidArgument；本 SDK 没有流式操作，start 以 Unimplemented 结束', async () => {
  const plugin = await launch();
  try {
    await startPlugin(plugin.client);
    for (const [frame, code] of [
      [{ chunk: new TextEncoder().encode('{}') }, status.INVALID_ARGUMENT],
      [{ start: pb.InvokeRequest.fromPartial({ operation: 'probes.context' }) }, status.UNIMPLEMENTED],
    ] as const) {
      const stream = plugin.client.invokeStream(sessionMetadata());
      const streamed = collect(stream);
      stream.write(frame);
      assert.equal((await streamed.ended)?.code, code);
    }
  } finally {
    await plugin.close();
  }
});

/** 扮演宿主的回调服务：记下收到的请求，按 `respond` 应答 */
async function fakeHost(respond: {
  invoke?: (request: pb.InvokeRequest) => pb.InvokeResponse | { code: number; details: string };
  publish?: (request: pb.PublishRequest) => pb.PublishResponse;
}) {
  const received: { method: string; session: unknown[]; request: pb.InvokeRequest | pb.PublishRequest }[] = [];
  const server = new Server();
  const service: pb.HostServer = {
    invoke: (
      call: ServerUnaryCall<pb.InvokeRequest, pb.InvokeResponse>,
      callback: sendUnaryData<pb.InvokeResponse>,
    ) => {
      received.push({
        method: 'invoke',
        session: call.metadata.get(PluginProtocol.sessionMetadataKey),
        request: call.request,
      });
      const reply = respond.invoke?.(call.request) ?? {
        status: { ok: true, error: undefined },
        payload: new Uint8Array(),
      };
      if ('code' in reply) {
        callback(reply);
      } else {
        callback(null, reply);
      }
    },
    publish: (
      call: ServerUnaryCall<pb.PublishRequest, pb.PublishResponse>,
      callback: sendUnaryData<pb.PublishResponse>,
    ) => {
      received.push({
        method: 'publish',
        session: call.metadata.get(PluginProtocol.sessionMetadataKey),
        request: call.request,
      });
      callback(
        null,
        respond.publish?.(call.request) ?? {
          results: call.request.envelopes.map(() => ({ ok: true, error: undefined })),
        },
      );
    },
  };
  server.addService(pb.HostService, service);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) =>
      error === null ? resolve(bound) : reject(error),
    ),
  );
  return { address: `tcp 127.0.0.1:${port}`, received, close: () => server.forceShutdown() };
}

test('回调带会话令牌与调用的上下文，宿主的业务失败原样返回（invocation.md §5）', async () => {
  const host = await fakeHost({
    invoke: (request) =>
      request.operation === 'orders.get'
        ? { status: { ok: true, error: undefined }, payload: new TextEncoder().encode('{"id":"o-1"}') }
        : {
            status: {
              ok: false,
              error: {
                code: 'ORDERS_NOTFOUND_001',
                messageKey: 'orders.order.missing',
                text: 'Missing.',
                details: '{"id":"o-2"}',
                inner: undefined,
              },
            },
            payload: new Uint8Array(),
          },
  });
  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  try {
    await startPlugin(plugin.client);
    const metadata = {
      traceParent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      traceState: 'vendor=1',
      baggage: { [BaggageKey.Tenant]: 't1', [BaggageKey.Correlation]: 'c1' },
    };
    const relayed = await invoke(plugin.client, 'probes.relay', '{"operation":"orders.get"}', metadata);
    assert.equal(relayed.status?.ok, true, JSON.stringify(relayed.status));
    assert.deepEqual(payloadOf(relayed), { id: 'o-1' });
    const [received] = host.received;
    assert.deepEqual(received?.session, [token]);
    const request = received?.request as pb.InvokeRequest;
    assert.equal(request.operation, 'orders.get');
    assert.equal(new TextDecoder().decode(request.payload), '{"x":1}');
    assert.equal(request.metadata?.traceParent.slice(0, 35), '00-0af7651916cd43dd8448eb211c80319c');
    assert.equal(request.metadata?.traceState, 'vendor=1');
    assert.deepEqual(request.metadata?.baggage, { [BaggageKey.Correlation]: 'c1', [BaggageKey.Tenant]: 't1' });

    const missing = await invoke(plugin.client, 'probes.relay', '{"operation":"orders.find"}', metadata);
    assert.deepEqual(missing.status?.error, {
      code: 'ORDERS_NOTFOUND_001',
      messageKey: 'orders.order.missing',
      text: 'Missing.',
      details: '{"id":"o-2"}',
      inner: undefined,
    });
  } finally {
    await plugin.close();
    host.close();
  }
});

test('回调只能带宿主随调用交给插件的租户：越界与调用结束后带租户的回调就地拒绝（invocation.md §5，ADR-0195）', async () => {
  const host = await fakeHost({});
  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  try {
    await startPlugin(plugin.client);
    await invoke(plugin.client, 'probes.context', '{}', { baggage: { [BaggageKey.Tenant]: 't1' } });
    const context = plugin.probe.lastContext as InvocationContext;
    const callback = findHost(context);
    assert.ok(callback !== undefined);
    // 调用已经结束：宿主此刻没有把 t1 的调用交给插件
    const late = await callback.invoke(context, 'orders.get');
    assert.equal(late.outcome.ok, false);
    assert.equal(!late.outcome.ok && late.outcome.error.code, PluginErrorCode.CallbackDenied);
    assert.equal(!late.outcome.ok && late.outcome.error.messageKey, PluginMessageKey.TenantDenied);
    assert.deepEqual(!late.outcome.ok && late.outcome.error.details, { id: 'xihan.tests.probe', tenant: 't1' });
    // 改写成别的租户同样就地拒绝
    const other = await callback.invoke(context.withBaggage(BaggageKey.Tenant, 't2'), 'orders.get');
    assert.equal(!other.outcome.ok && other.outcome.error.code, PluginErrorCode.CallbackDenied);
    assert.equal(host.received.length, 0, 'denied callbacks never reach the host');

    // 发布逐项判定：越界的那一项失败，其余照常发出
    const published = await invoke(plugin.client, 'probes.publish', '{"tenants":["t1",null,"t9"]}', {
      baggage: { [BaggageKey.Tenant]: 't1' },
    });
    assert.deepEqual(payloadOf(published), ['ok', 'ok', PluginErrorCode.CallbackDenied]);
    const publish = host.received.at(-1)?.request as pb.PublishRequest;
    assert.deepEqual(
      publish.envelopes.map((envelope) => [envelope.id, envelope.specVersion, envelope.dataContentType]),
      [
        ['e-0', '1.0', 'application/json'],
        ['e-1', '1.0', 'application/json'],
      ],
    );
  } finally {
    await plugin.close();
    host.close();
  }
});

test('回调的传输失败按映射表换成原语层错误（invocation.md §3，handshake.md §4）', async () => {
  let reply: { code: number; details: string } = { code: status.PERMISSION_DENIED, details: 'not granted' };
  const host = await fakeHost({ invoke: () => reply });
  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  try {
    await startPlugin(plugin.client);
    const expectations: [number, string, string | undefined, unknown][] = [
      [
        status.PERMISSION_DENIED,
        PluginErrorCode.CallbackDenied,
        PluginMessageKey.CallbackDenied,
        { id: 'xihan.tests.probe', permission: CallbackPermission.Invoke },
      ],
      [status.UNAUTHENTICATED, PluginErrorCode.CallbackDenied, PluginMessageKey.SessionInvalid, undefined],
      [status.UNIMPLEMENTED, 'KERNEL_NOTFOUND_001', 'kernel.operation.unknown', { id: 'orders.get' }],
      [
        status.INVALID_ARGUMENT,
        'KERNEL_VALIDATION_001',
        'kernel.operation.invalid_payload',
        { id: 'orders.get', reason: 'boom' },
      ],
      [status.DEADLINE_EXCEEDED, 'KERNEL_TIMEOUT_001', 'kernel.invocation.deadline_exceeded', undefined],
      [
        status.INTERNAL,
        PluginErrorCode.Unexpected,
        PluginMessageKey.Failed,
        { id: 'xihan.tests.probe', phase: 'Host.Invoke', reason: 'Internal: boom' },
      ],
    ];
    for (const [code, errorCode, key, details] of expectations) {
      reply = { code, details: code === status.PERMISSION_DENIED ? 'not granted' : 'boom' };
      const response = await invoke(plugin.client, 'probes.relay', '{"operation":"orders.get"}');
      const error = response.status?.error;
      assert.equal(error?.code, errorCode, String(code));
      assert.equal(error?.messageKey ?? '', key ?? '');
      assert.deepEqual(error?.details ? JSON.parse(error.details) : undefined, details);
    }
  } finally {
    await plugin.close();
    host.close();
  }
  // 宿主端点不可达：PLUGINS_UNAVAILABLE_001
  const unreachable = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: 'tcp 127.0.0.1:1' });
  try {
    await startPlugin(unreachable.client);
    const response = await invoke(unreachable.client, 'probes.relay', '{"operation":"orders.get"}');
    assert.equal(response.status?.error?.code, PluginErrorCode.Unavailable);
  } finally {
    await unreachable.close();
  }
});

test('声明与清单不符、清单不是进程外插件或缺会话令牌时，在监听之前抛出', async () => {
  const base = JSON.parse(manifest) as Record<string, unknown>;
  const cases: [Partial<PluginOptions>, Record<string, string>][] = [
    [{ manifest: JSON.stringify({ ...base, isolation: 'in-process' }) }, {}],
    [{ manifest: JSON.stringify({ ...base, kind: 'capability', isolation: undefined, permissions: undefined }) }, {}],
    [
      {
        manifest: JSON.stringify({
          ...base,
          contributes: { operations: [], pipeline: [{ middleware: 'Audit', stage: 'observe' }] },
        }),
      },
      {},
    ],
    [{ manifest: JSON.stringify({ ...base, contributes: { operations: ['probes.context'] } }) }, {}],
    [{ manifest: '{' }, {}],
    [{ subscriptions: [{ topic: 'Bad Topic', handler: async () => Result.success() }] }, {}],
    [
      {
        subscriptions: [
          { topic: 'probe.events', mode: 'fanout' as SubscriptionMode, handler: async () => Result.success() },
        ],
      },
      {},
    ],
    [
      {
        subscriptions: [
          { topic: 'probe.events', handler: async () => Result.success() },
          { topic: 'probe.events', mode: SubscriptionMode.Broadcast, handler: async () => Result.success() },
        ],
      },
      {},
    ],
    [{ catalogs: [{ name: 'probes', locales: { 'zh-CN': {} } }] }, {}],
    [{}, { XIHAN_PLUGIN_SESSION: '' }],
  ];
  for (const [options, env] of cases) {
    await assert.rejects(launch(options, env), FrameworkError, JSON.stringify(options));
  }
});

test('缺省端点：Unix 套接字放在新建的私有目录里（0700 / 0600），Windows 用命名管道（handshake.md §4）', async () => {
  const plugin = await launch({ network: defaultNetwork() });
  try {
    if (process.platform === 'win32') {
      assert.equal(plugin.endpoint.network, 'npipe');
      assert.match(plugin.endpoint.address, /^\\\\\.\\pipe\\xihan-plugin-[0-9a-f]{16}$/);
    } else {
      assert.equal(plugin.endpoint.network, 'unix');
      assert.equal(statSync(dirname(plugin.endpoint.address)).mode & 0o777, 0o700);
      assert.equal(statSync(plugin.endpoint.address).mode & 0o777, 0o600);
    }
    const handshake = await startPlugin(plugin.client);
    assert.equal(handshake.protocolVersion, 1);
  } finally {
    await plugin.close();
  }
  if (process.platform !== 'win32') {
    // 服务停止之后私有目录随之删除
    assert.throws(() => statSync(dirname(plugin.endpoint.address)), { code: 'ENOENT' });
  }
});

test('日志写成宿主能解析的 JSON 行：level、message 与作用域属性（invocation.md §6）', () => {
  const lines: string[] = [];
  const logger = new PluginLogger({ write: (text: string) => lines.push(text) }, { fields: { plugin: 'p' } });
  logger.debug('hidden');
  logger.information('hello', { count: 2n, error: new TypeError('bad'), level: 'ignored' });
  logger.with({ scope: 's' }).critical('down');
  assert.deepEqual(lines, [
    '{"level":"information","message":"hello","plugin":"p","count":2,"error":"TypeError: bad"}\n',
    '{"level":"critical","message":"down","plugin":"p","scope":"s"}\n',
  ]);
});

test('插件运行时的消息目录：10 种区域，键与占位符与 en-US 一致', () => {
  const locales = Object.keys(pluginTemplates);
  assert.deepEqual(locales.sort(), [
    'de-DE',
    'en-US',
    'es-ES',
    'fr-FR',
    'ja-JP',
    'ko-KR',
    'pt-BR',
    'ru-RU',
    'zh-CN',
    'zh-TW',
  ]);
  const english = pluginTemplates['en-US'] ?? {};
  assert.deepEqual(Object.keys(english).sort(), Object.values(PluginMessageKey).sort());
  for (const locale of locales) {
    const templates = pluginTemplates[locale] ?? {};
    assert.deepEqual(Object.keys(templates).sort(), Object.keys(english).sort(), locale);
    for (const [key, template] of Object.entries(templates)) {
      assert.deepEqual(placeholders(template).sort(), placeholders(english[key] ?? '').sort(), `${locale} ${key}`);
    }
  }
  // 示例插件的目录从文件读，至少有 en-US
  const catalog = loadCatalog('echots', fileURLToPath(new URL('../examples/echo/localization', import.meta.url)));
  assert.equal(catalog.name, 'echots');
  assert.ok(Object.hasOwn(catalog.locales, 'en-US'));
  assert.equal(writeJson(Object.keys(catalog.locales).sort()), '["en-US","zh-CN"]');
});
