import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { format, inspect } from 'node:util';

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
import { InvocationContext } from 'xihan-framework/invocation';
import { defineContract, Expose, OperationRegistry, RequestShape } from 'xihan-framework/operation';
import {
  CallbackPermission,
  ConfigurationSection,
  defaultNetwork,
  type Envelope,
  findHost,
  formatHandshakeLine,
  HealthStatus,
  type LogTarget,
  loadCatalog,
  negotiateProtocolVersion,
  type PluginConfiguration,
  type PluginEndpoint,
  PluginErrorCode,
  type PluginHealth,
  PluginLogger,
  PluginMessageKey,
  type PluginOptions,
  PluginProtocol,
  parseEndpoint,
  parseHandshakeLine,
  parseHostAddresses,
  pluginTemplates,
  SubscriptionMode,
  selectHostEndpoint,
  servePlugin,
} from 'xihan-framework/plugin';
import {
  BaggageKey,
  ErrorInfo,
  Float64,
  FrameworkError,
  formatMessage,
  JsonNumber,
  type JsonObject,
  type JsonValue,
  LifecycleState,
  lifecycleStateOrdinal,
  parseJson,
  placeholders,
  Result,
  writeJson,
} from 'xihan-framework/primitives';

// 协议的生成代码与内部规则函数不是公开入口：测试直接加载它们，扮演宿主调用插件、扮演宿主的回调服务、回放向量
import { fromProtoError, fromStatus } from '../src/plugin/conversion.ts';
import { effectiveDeadline, formatDeadline, parseDeadline } from '../src/plugin/deadline.ts';
import {
  callbackDenied,
  eventUnsubscribed,
  hostUnavailable,
  invalidErrorCodeReason,
  mapCallbackStatus,
  PluginReason,
  processFailed,
  processUnavailable,
  resultCountReason,
  sessionInvalid,
  statusReason,
  tenantDenied,
  thrownTypeName,
} from '../src/plugin/errors.ts';
import * as pb from '../src/plugin/gen/plugin.ts';

/** 读取规范仓库的插件向量 */
function vector<T>(name: string): T {
  const url = new URL(`../spec/conformance/vectors/plugin/${name}`, import.meta.url);
  return parseJson(readFileSync(url)) as unknown as T;
}

/** 包清单里的版本：握手上报的 SDK 版本以它为准 */
const packageVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/** 测试插件的会话令牌 */
const token = 'test-session-token-0123456789abcdefghijklmnopqrstuvwxyz';

/** 测试插件的清单 ID */
const pluginId = 'xihan.tests.probe';

/** 测试插件的清单对象 */
const manifestObject = {
  $schema: 'https://spec.xihanfun.com/manifest/v1.json',
  id: pluginId,
  version: '1.0.0',
  primitives: '1',
  stability: 'experimental',
  kind: 'plugin',
  isolation: 'out-of-process',
  contributes: {
    operations: ['probes.context', 'probes.fail', 'probes.slow', 'probes.wait', 'probes.relay', 'probes.publish'],
    health: ['probe'],
  },
  permissions: [CallbackPermission.Invoke, CallbackPermission.Publish],
  entry: 'probe',
};

/** 测试插件的清单原文 */
const manifest = `${JSON.stringify(manifestObject, null, 2)}\n`;

/** 一个可以从外面放行的闸门 */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** 等一会儿 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 测试插件的状态：处理器把看到的东西交给测试 */
interface Probe {
  /** 最近一次 probes.context 的上下文 */
  lastContext: InvocationContext | undefined;
  /** probes.slow 等它放行，不理会取消 */
  slow: ReturnType<typeof gate>;
  /** probes.slow 已经开始 */
  slowStarted: ReturnType<typeof gate>;
  /** probes.wait 已经开始 */
  waitStarted: ReturnType<typeof gate>;
  /** probes.wait 看到取消的时刻 */
  abortedAt: number | undefined;
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
    contract: defineContract<{ kind?: string | null }, never>({
      id: 'probes.fail',
      expose: [],
      permission: 'probes.fail',
    }),
    request: RequestShape.object({ kind: RequestShape.string() }),
    handler: async (_context, request) => {
      switch (request?.kind) {
        case 'literal':
          return Result.fail(ErrorInfo.literal('PROBES_VALIDATION_003', 'A literal failure.'));
        case 'text':
          return Result.fail(
            ErrorInfo.validation('PROBES_VALIDATION_004', 'probes.value.texted').withText('Rendered.'),
          );
        case 'inner':
          return Result.fail(
            ErrorInfo.unexpected(
              'PROBES_UNEXPECTED_001',
              'probes.value.outer',
              undefined,
              ErrorInfo.literal('PROBES_VALIDATION_005', 'Inner.'),
            ),
          );
        default:
          return Result.fail(
            ErrorInfo.validation('PROBES_VALIDATION_001', 'probes.value.invalid', { min: 1, ratio: new Float64(2) }),
          );
      }
    },
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
    contract: defineContract<unknown, never>({ id: 'probes.wait', expose: [] }),
    request: RequestShape.object({}),
    handler: async (context) => {
      probe.waitStarted.open();
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) {
          resolve();
        }
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      probe.abortedAt = Date.now();
      return Result.fail(context.cancellation as ErrorInfo);
    },
  });
  registry.add({
    contract: defineContract<{ operation: string | null }, JsonValue>({ id: 'probes.relay', expose: [] }),
    request: RequestShape.object({ operation: RequestShape.required(RequestShape.string()) }),
    handler: async (context, request) => {
      const host = findHost(context);
      assert.ok(host !== undefined, 'the runtime always attaches the host client');
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
      assert.ok(host !== undefined, 'the runtime always attaches the host client');
      const envelopes: Envelope[] = (request?.tenants ?? []).map((tenant, index) => ({
        topic: 'probe.events',
        id: `e-${index}`,
        source: 'urn:test',
        type: 'probe.happened',
        data: '{}',
        ...(tenant === null ? {} : { extensions: { xihantenant: tenant } }),
      }));
      const results = await host.publish(context, envelopes);
      return Result.ok(results.map((result) => (result.ok ? 'ok' : describeError(result.error))));
    },
  });
  return registry;
}

/** 错误的码、键与细节，便于比较 */
function describeError(error: ErrorInfo): JsonValue {
  return { code: error.code, key: error.messageKey ?? null, details: (error.details ?? null) as JsonValue };
}

/** 一个在本进程里运行的插件，以及扮演宿主的客户端 */
interface Launched {
  readonly endpoint: PluginEndpoint;
  readonly client: pb.PluginClient;
  readonly stdin: PassThrough;
  readonly served: Promise<void>;
  readonly logs: string[];
  readonly probe: Probe;
  /** 运行时要求进程退出的记录 */
  readonly exits: { code: number; at: number }[];
  /** 关闭客户端并让插件退出 */
  close(): Promise<void>;
}

/** 在本进程里启动测试插件（回环 TCP，各平台一样），读握手行并连上 */
async function launch(options: Partial<PluginOptions> = {}, env: Record<string, string> = {}): Promise<Launched> {
  const probe: Probe = {
    lastContext: undefined,
    slow: gate(),
    slowStarted: gate(),
    waitStarted: gate(),
    abortedAt: undefined,
  };
  const stdin = new PassThrough();
  const logs: string[] = [];
  const exits: { code: number; at: number }[] = [];
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
    healthInterval: 50,
    exit: (code) => exits.push({ code, at: Date.now() }),
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
    exits,
    async close() {
      client.close();
      stdin.end();
      await served;
    },
  };
}

/** 会话元数据；`session` 为 `null` 时不带，数组时带多个值 */
function sessionMetadata(session: string | null | readonly string[] = token): Metadata {
  const metadata = new Metadata();
  for (const value of session === null ? [] : typeof session === 'string' ? [session] : session) {
    metadata.add(PluginProtocol.sessionMetadataKey, value);
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

/** 握手 */
function handshake(client: pb.PluginClient): Promise<pb.HandshakeResponse> {
  return unary<pb.HandshakeResponse>((done) => client.handshake(handshakeRequest(), sessionMetadata(), done));
}

/** Configure；缺省授予清单声明的全部权限 */
function configure(
  client: pb.PluginClient,
  configuration = '{}',
  granted: readonly string[] = manifestObject.permissions,
): Promise<pb.ConfigureResponse> {
  return unary<pb.ConfigureResponse>((done) =>
    client.configure(
      pb.ConfigureRequest.fromPartial({ configuration, grantedPermissions: [...granted], workDirectory: '.' }),
      sessionMetadata(),
      done,
    ),
  );
}

/** Start */
function start(client: pb.PluginClient): Promise<pb.StartResponse> {
  return unary<pb.StartResponse>((done) => client.start({}, sessionMetadata(), done));
}

/** Stop */
function stop(client: pb.PluginClient, graceSeconds = 5, reason = 'unload'): Promise<pb.StopResponse> {
  return unary<pb.StopResponse>((done) => client.stop({ graceSeconds, reason }, sessionMetadata(), done));
}

/** Health */
function health(client: pb.PluginClient): Promise<pb.HealthResponse> {
  return unary<pb.HealthResponse>((done) => client.health({}, sessionMetadata(), done));
}

/** 握手、配置并启动 */
async function startPlugin(
  client: pb.PluginClient,
  configuration = '{}',
  granted: readonly string[] = manifestObject.permissions,
): Promise<pb.HandshakeResponse> {
  const handshaken = await handshake(client);
  assert.equal((await configure(client, configuration, granted)).status?.ok, true);
  assert.equal((await start(client)).status?.ok, true);
  return handshaken;
}

/** 调用一个操作 */
function invoke(
  client: pb.PluginClient,
  operation: string,
  payload = '{}',
  metadata?: Partial<pb.InvocationMetadata>,
  session: string | null = token,
  deadline?: Date,
): Promise<pb.InvokeResponse> {
  return unary<pb.InvokeResponse>((done) =>
    client.invoke(
      pb.InvokeRequest.fromPartial({ operation, payload: new TextEncoder().encode(payload), metadata }),
      sessionMetadata(session),
      deadline === undefined ? {} : { deadline },
      done,
    ),
  );
}

/** 投递一条消息 */
function deliver(
  client: pb.PluginClient,
  topic: string,
  type: string,
  mode: string,
  id = 'm-1',
): Promise<pb.HandleEventResponse> {
  return unary<pb.HandleEventResponse>((done) =>
    client.handleEvent(
      pb.HandleEventRequest.fromPartial({
        envelope: { topic, id, source: 'urn:test', type, specVersion: '1.0', data: new Uint8Array() },
        attempt: 1,
        mode,
      }),
      sessionMetadata(),
      done,
    ),
  );
}

/** 响应载荷读成 JSON */
function payloadOf(response: pb.InvokeResponse): unknown {
  return JSON.parse(new TextDecoder().decode(response.payload));
}

/** 断言状态是带消息键的失败：码与键相等、`text` 为空（invocation.md §3）、`details` 按 JSON 值相等 */
function assertFailure(
  statusValue: pb.Status | undefined,
  code: string,
  key: string,
  details: Record<string, string> | undefined,
  what = '',
): void {
  assert.equal(statusValue?.ok, false, what);
  const error = statusValue?.error;
  assert.equal(error?.code, code, what);
  assert.equal(error?.messageKey, key, what);
  assert.equal(error?.text, '', `${what}: an error with a message key leaves text empty`);
  assert.deepEqual(error?.details ? JSON.parse(error.details) : undefined, details, what);
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

/** 打开一个 InvokeStream，发出 `first`（`undefined` 为不发帧就关闭发送方向），返回结束的状态码 */
async function streamEndsWith(client: pb.PluginClient, first: pb.StreamFrame | undefined): Promise<number> {
  const stream = client.invokeStream(sessionMetadata());
  const streamed = collect(stream);
  if (first === undefined) {
    stream.end();
  } else {
    stream.write(first);
  }
  const ended = await streamed.ended;
  stream.end();
  return ended?.code ?? status.OK;
}

/** 日志行里级别为 `level`、消息含 `text` 的行数 */
function logged(logs: readonly string[], level: string, text: string): number {
  return logs.filter((line) => line.includes(`"level":"${level}"`) && line.includes(text)).length;
}

// ── 向量 ───────────────────────────────────────────────────────────────────────

test('握手行与端点的文法遵循 handshake-lines.json：空白字符集与 tcp 回环地址的写法（handshake.md §2）', () => {
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
    assert.equal(parseHandshakeLine(invalid), undefined, JSON.stringify(invalid));
  }
  // 结尾的换行不例外：文法整串匹配；U+FEFF 不是规范的空白，可以出现在地址里
  assert.equal(parseHandshakeLine('xihan-plugin/1 unix /run/plugin.sock\n'), undefined);
  assert.deepEqual(parseHandshakeLine(`xihan-plugin/1 unix /a${String.fromCharCode(0xfeff)}b`)?.network, 'unix');
  assert.equal(formatHandshakeLine({ network: 'tcp', address: '10.0.0.5:1' }), undefined);
  assert.equal(formatHandshakeLine({ network: 'unix', address: '/tmp/a b/plugin.sock' }), undefined);
  assert.equal(parseEndpoint('unix'), undefined);
});

test('宿主回调端点列表与选择遵循 host-addresses.json（handshake.md §4）', () => {
  const vectors = vector<{
    valid: { value: string; entries: { network: string; address: string }[] }[];
    invalid: string[];
    selection: {
      value: string | null;
      supported: PluginEndpoint['network'][];
      selected: { network: string; address: string } | null;
    }[];
  }>('host-addresses.json');
  for (const valid of vectors.valid) {
    assert.deepEqual(parseHostAddresses(valid.value), valid.entries, valid.value);
  }
  for (const invalid of vectors.invalid) {
    assert.equal(parseHostAddresses(invalid), undefined, JSON.stringify(invalid));
  }
  for (const selection of vectors.selection) {
    assert.deepEqual(
      selectHostEndpoint(selection.value ?? undefined, selection.supported),
      selection.selected ?? undefined,
      JSON.stringify(selection),
    );
  }
});

/** 向量里纳秒精度的 UTC 时刻换成 Unix 毫秒：多出的小数截断（与 JavaScript 的时钟精度一致） */
function utcMilliseconds(text: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{9})Z$/.exec(text);
  assert.ok(match !== null, text);
  const [, year, month, day, hour, minute, second, fraction] = match.map(Number) as number[];
  const date = new Date(0);
  date.setUTCFullYear(year as number, (month as number) - 1, day as number);
  date.setUTCHours(hour as number, minute as number, second as number, 0);
  return date.getTime() + Math.trunc((fraction as number) / 1_000_000);
}

test('截止时间的读法、生效的截止时间与写法遵循 deadlines.json（invocation.md §2）', () => {
  const vectors = vector<{
    valid: { text: string; utc: string }[];
    invalid: string[];
    effective: { metadata: string; grpc: string | null; expected: string | null }[];
    written: { utc: string; text: string }[];
  }>('deadlines.json');
  for (const valid of vectors.valid) {
    assert.equal(parseDeadline(valid.text), utcMilliseconds(valid.utc), valid.text);
  }
  for (const invalid of [...vectors.invalid, '']) {
    assert.equal(parseDeadline(invalid), undefined, JSON.stringify(invalid));
  }
  for (const entry of vectors.effective) {
    const grpc = entry.grpc === null ? undefined : utcMilliseconds(entry.grpc);
    const expected = entry.expected === null ? undefined : utcMilliseconds(entry.expected);
    assert.equal(effectiveDeadline(entry.metadata, grpc), expected, JSON.stringify(entry));
  }
  for (const written of vectors.written) {
    // 毫秒之后的小数在 JavaScript 里没有：比较前把期望的七位小数截到三位
    const expected = `${written.text.slice(0, 23)}0000+00:00`;
    assert.equal(formatDeadline(utcMilliseconds(written.utc)), expected, written.utc);
    assert.equal(parseDeadline(expected), utcMilliseconds(written.utc));
  }
  // 超出范围的时刻按两端写出，总能读回
  assert.equal(formatDeadline(Number.MAX_SAFE_INTEGER), '9999-12-31T23:59:59.9990000+00:00');
  assert.equal(formatDeadline(-Number.MAX_SAFE_INTEGER), '0001-01-01T00:00:00.0000000+00:00');
});

test('运行时的消息键、参数、错误码、en-US 模板与固定的 reason 遵循 plugin-messages.json（invocation.md §8）', () => {
  const vectors = vector<{
    messages: { code: string; key: string; arguments: string[]; template: string }[];
    reasons: { key: string; reason: string }[];
  }>('plugin-messages.json');
  const english = pluginTemplates['en-US'] ?? {};
  // SDK 自带的目录恰好是规范的这些键，没有自造的键
  assert.deepEqual(Object.keys(english).sort(), vectors.messages.map((message) => message.key).sort());
  assert.deepEqual(Object.values(PluginMessageKey).sort(), Object.keys(english).sort());
  /** 每个键在运行时里的构造：参数取自己的名字作值 */
  const factories: Record<string, (values: Record<string, string>) => ErrorInfo> = {
    'plugins.process.unavailable': (v) => processUnavailable(v.id as string, v.state as string),
    'plugins.process.failed': (v) => processFailed(v.id as string, v.phase as string, v.reason as string),
    'plugins.event.unsubscribed': (v) =>
      eventUnsubscribed(v.id as string, v.topic as string, v.type as string, v.mode as string),
    'plugins.host.unavailable': (v) => hostUnavailable(v.id as string, v.reason as string),
    'plugins.callback.denied': (v) => callbackDenied(v.id as string, v.permission as string),
    'plugins.callback.tenant_denied': (v) => tenantDenied(v.id as string, v.tenant as string),
    'plugins.callback.session_invalid': () => sessionInvalid(),
  };
  for (const message of vectors.messages) {
    assert.equal(english[message.key], message.template, message.key);
    assert.deepEqual(placeholders(message.template).sort(), [...message.arguments].sort(), message.key);
    const values = Object.fromEntries(message.arguments.map((name) => [name, `${name}-value`]));
    const error = (factories[message.key] as (values: Record<string, string>) => ErrorInfo)(values);
    assert.equal(error.code, message.code, message.key);
    assert.equal(error.messageKey, message.key);
    // details 就是这些参数，不另加成员
    assert.deepEqual(error.details ?? {}, values, message.key);
  }
  const reasons = vectors.reasons.map((entry) => `${entry.key} ${entry.reason}`);
  for (const reason of [
    `plugins.process.failed ${PluginReason.ConfigurationNotObject}`,
    `plugins.process.failed ${invalidErrorCodeReason('{code}')}`,
    `plugins.process.failed ${PluginReason.HostFailureWithoutError}`,
    `plugins.process.failed ${resultCountReason('{results}' as unknown as number, '{envelopes}' as unknown as number)}`,
    `plugins.host.unavailable ${PluginReason.NoCallbackEndpoint}`,
  ]) {
    assert.ok(reasons.includes(reason), reason);
  }
  assert.equal(statusReason(13, 'boom'), 'Internal: boom');
  assert.equal(statusReason(0, ''), 'OK: ');
  assert.equal(statusReason(42, 'x'), '42: x');
});

/** callback-status.json 的一项 */
interface CallbackCase {
  readonly rpc: 'invoke' | 'publish';
  readonly status: string;
  readonly statusCode: number;
  readonly message: string;
  readonly contextCancelled: boolean;
  readonly code: string;
  readonly key: string;
  readonly details: Record<string, string> | null;
}

test('回调失败的 gRPC 状态映射遵循 callback-status.json 的全部用例（invocation.md §5）', () => {
  const vectors = vector<{ pluginId: string; operation: string; cases: CallbackCase[] }>('callback-status.json');
  for (const entry of vectors.cases) {
    const error = mapCallbackStatus(
      entry.rpc,
      entry.statusCode,
      entry.message,
      entry.contextCancelled,
      vectors.pluginId,
      vectors.operation,
    );
    const what = JSON.stringify(entry);
    assert.equal(error.code, entry.code, what);
    assert.equal(error.messageKey, entry.key, what);
    assert.deepEqual(error.details, entry.details ?? undefined, what);
  }
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

// ── 启动与握手 ────────────────────────────────────────────────────────────────

test('声明与清单不符时不监听、不写握手行，在 stderr 记一条 error 日志并抛出（handshake.md §1）', async () => {
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
    // primitives 必须等于本 SDK 的原语层大版本
    [{ manifest: JSON.stringify({ ...base, primitives: '2' }) }, {}],
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
    // tcp 只写 127.0.0.1:<端口>
    [{ address: '[::1]:0' }, {}],
  ];
  for (const [options, env] of cases) {
    const logs: string[] = [];
    let stdout = '';
    await assert.rejects(
      servePlugin({
        manifest,
        registry: probeRegistry({
          lastContext: undefined,
          slow: gate(),
          slowStarted: gate(),
          waitStarted: gate(),
          abortedAt: undefined,
        }),
        network: 'tcp',
        stdin: new PassThrough(),
        stdout: {
          write(text: string) {
            stdout += text;
            return true;
          },
        },
        logger: new PluginLogger({ write: (text: string) => logs.push(text) }),
        env: { XIHAN_PLUGIN_SESSION: token, ...env },
        exit: () => assert.fail('a refused start must not exit by itself'),
        ...options,
      }),
      FrameworkError,
      JSON.stringify(options),
    );
    assert.equal(stdout, '', 'no handshake line');
    assert.equal(logged(logs, 'error', 'the plugin cannot start'), 1, JSON.stringify(options));
  }
});

test('每个 RPC 先核对会话令牌：缺失、不匹配或不止一个值都以 Unauthenticated 结束、不执行（handshake.md §4）', async () => {
  const plugin = await launch();
  try {
    for (const session of [null, '', 'not-the-session-token', `${token}x`, [token, 'wrong'], ['wrong', token]]) {
      await rejectsWith(
        unary((done) => plugin.client.handshake(handshakeRequest(), sessionMetadata(session), done)),
        status.UNAUTHENTICATED,
      );
      // 令牌先于次序核对：没握手的 Configure 也是 Unauthenticated
      await rejectsWith(
        unary((done) => plugin.client.configure(pb.ConfigureRequest.fromPartial({}), sessionMetadata(session), done)),
        status.UNAUTHENTICATED,
      );
      const watch = collect(plugin.client.watchHealth({}, sessionMetadata(session)));
      assert.equal((await watch.ended)?.code, status.UNAUTHENTICATED);
      assert.equal(watch.messages.length, 0);
      // 流式调用读第一帧之前就核对令牌
      const stream = plugin.client.invokeStream(sessionMetadata(session));
      const streamed = collect(stream);
      stream.write({ chunk: new Uint8Array() });
      assert.equal((await streamed.ended)?.code, status.UNAUTHENTICATED);
    }
    // 两个都对也不行：只认恰好一个值
    await rejectsWith(
      unary((done) => plugin.client.health({}, sessionMetadata([token, token]), done)),
      status.UNAUTHENTICATED,
    );
    // 被拒的调用没有执行：插件仍在 Declared，带对令牌照常握手
    assert.equal((await handshake(plugin.client)).protocolVersion, 1);
  } finally {
    await plugin.close();
  }
});

test('握手交出清单的 primitives、去掉 BOM 的清单原文、一元操作、写出方式的订阅与作者自己的目录（handshake.md §3）', async () => {
  const subscriptions: PluginOptions['subscriptions'] = [
    { topic: 'probe.events', handler: async () => Result.success() },
    {
      topic: 'probe.events',
      messageType: 'probe.flush',
      mode: SubscriptionMode.Broadcast,
      handler: async () => Result.success(),
    },
    { topic: 'probe.other', mode: SubscriptionMode.Competing, handler: async () => Result.success() },
  ];
  const catalogs = [{ name: 'probes', locales: { 'en-US': { 'probes.value.invalid': 'At least {min}.' } } }];
  const plugin = await launch({ subscriptions, catalogs, manifest: `${String.fromCharCode(0xfeff)}${manifest}` });
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
    // 清单原文原样交出，去掉开头的 BOM，宿主据此与目录里的文件逐字段比较
    assert.equal(response.manifest, manifest);
    // 上报的版本就是包的版本：真源是 package.json，测试里不写死版本号
    assert.deepEqual(response.sdk, {
      name: 'framework-sdk-typescript',
      version: packageVersion,
      language: 'typescript',
    });
    assert.deepEqual(
      response.operations.map((operation) => operation.id),
      ['probes.context', 'probes.fail', 'probes.publish', 'probes.relay', 'probes.slow', 'probes.wait'],
    );
    assert.ok(response.operations.every((operation) => !operation.streaming));
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
    // 按声明顺序，方式总是写出
    assert.deepEqual(response.subscriptions, [
      { topic: 'probe.events', messageType: '', mode: 'competing' },
      { topic: 'probe.events', messageType: 'probe.flush', mode: 'broadcast' },
      { topic: 'probe.other', messageType: '', mode: 'competing' },
    ]);
    // 只有作者的目录：SDK 运行时的 plugins.* 不随握手发送
    assert.deepEqual(response.catalogs, [
      {
        name: 'probes',
        locales: [{ locale: 'en-US', templates: new Map([['probes.value.invalid', 'At least {min}.']]) }],
      },
    ]);
  } finally {
    await plugin.close();
  }
});

// ── 生命周期 ──────────────────────────────────────────────────────────────────

test('调用次序不在表里的以 FailedPrecondition 拒绝、状态不变（lifecycle.md §7.1）', async () => {
  const plugin = await launch();
  try {
    const expectRefused = async (call: Promise<unknown>, state: LifecycleState) => {
      await rejectsWith(call, status.FAILED_PRECONDITION);
      assert.equal((await health(plugin.client)).state, lifecycleStateOrdinal(state));
    };
    await expectRefused(configure(plugin.client), LifecycleState.Declared);
    await expectRefused(start(plugin.client), LifecycleState.Declared);
    await expectRefused(stop(plugin.client), LifecycleState.Declared);
    await handshake(plugin.client);
    await expectRefused(handshake(plugin.client), LifecycleState.Resolved);
    await expectRefused(start(plugin.client), LifecycleState.Resolved);
    assert.equal((await configure(plugin.client)).status?.ok, true);
    await expectRefused(configure(plugin.client), LifecycleState.Configured);
    assert.equal((await start(plugin.client)).status?.ok, true);
    await expectRefused(start(plugin.client), LifecycleState.Ready);
    await expectRefused(configure(plugin.client), LifecycleState.Ready);
    // 停止中再 Stop
    const slow = invoke(plugin.client, 'probes.slow');
    await plugin.probe.slowStarted.wait;
    const stopping = stop(plugin.client, 5);
    await delay(50);
    await expectRefused(stop(plugin.client), LifecycleState.Draining);
    plugin.probe.slow.open();
    await slow;
    assert.equal((await stopping).status?.ok, true);
    await plugin.served;
  } finally {
    await plugin.close();
  }
});

test('配置节：空等同 {}，不是 JSON 对象时不调回调、进入 Failed；回调失败带原错误，抛出时 reason 是简单类型名（lifecycle.md §7.2、§7.6）', async () => {
  class SecretLeak extends Error {}
  let calls = 0;
  const cases: [string, PluginOptions['hooks'], string, string, Record<string, string> | undefined][] = [
    ['[1]', {}, PluginErrorCode.Unexpected, PluginMessageKey.Failed, undefined],
    ['{"a":', {}, PluginErrorCode.Unexpected, PluginMessageKey.Failed, undefined],
    ['{"a":1,"a":2}', {}, PluginErrorCode.Unexpected, PluginMessageKey.Failed, undefined],
    ['"text"', {}, PluginErrorCode.Unexpected, PluginMessageKey.Failed, undefined],
    [
      '{"retries":"x"}',
      { configure: () => Result.fail(ErrorInfo.validation('PROBES_VALIDATION_002', 'probes.config.invalid')) },
      'PROBES_VALIDATION_002',
      'probes.config.invalid',
      undefined,
    ],
    [
      '{}',
      {
        configure: () => {
          throw new TypeError('secret detail');
        },
      },
      PluginErrorCode.Unexpected,
      PluginMessageKey.Failed,
      { id: pluginId, phase: 'configure', reason: 'TypeError' },
    ],
    [
      '{}',
      {
        configure: () => {
          throw new SecretLeak('secret detail');
        },
      },
      PluginErrorCode.Unexpected,
      PluginMessageKey.Failed,
      { id: pluginId, phase: 'configure', reason: 'SecretLeak' },
    ],
  ];
  for (const [configuration, hooks, code, key, details] of cases) {
    const counted = {
      ...hooks,
      // 包一层计数：参数原样转交，含带取消信号的第二个参数
      configure: (...args: Parameters<NonNullable<NonNullable<PluginOptions['hooks']>['configure']>>) => {
        calls += 1;
        return hooks?.configure?.(...args) ?? Result.success();
      },
    };
    calls = 0;
    const plugin = await launch({ hooks: counted });
    try {
      await handshake(plugin.client);
      const configured = await configure(plugin.client, configuration);
      const expected =
        details ??
        (code === PluginErrorCode.Unexpected
          ? { id: pluginId, phase: 'configure', reason: 'the configuration is not a JSON object' }
          : undefined);
      assertFailure(configured.status, code, key, expected, configuration);
      // 配置节不是对象时不调回调
      assert.equal(calls, hooks?.configure === undefined ? 0 : 1, configuration);
      // 异常文本只进 stderr 日志
      assert.doesNotMatch(JSON.stringify(configured.status), /secret detail/);
      const reported = await health(plugin.client);
      assert.equal(reported.state, lifecycleStateOrdinal(LifecycleState.Failed));
      assert.equal(reported.error?.code, code);
      // 启动回调没成功过：Stop 不调停止回调，应答 ok
      assert.equal((await stop(plugin.client)).status?.ok, true);
      await plugin.served;
    } finally {
      await plugin.close();
    }
  }
});

test('Configure 把配置节、类型化读取、权限、绑定与工作目录交给回调', async () => {
  let seen: Parameters<NonNullable<NonNullable<PluginOptions['hooks']>['configure']>>[0] | undefined;
  const plugin = await launch({
    hooks: {
      configure: (configuration) => {
        seen = configuration;
        return Result.success();
      },
    },
  });
  try {
    await handshake(plugin.client);
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
    assert.ok(seen !== undefined);
    assert.deepEqual(seen.section, {});
    assert.ok(seen.values instanceof ConfigurationSection);
    assert.equal(seen.text, '{}');
    assert.deepEqual(seen.grantedPermissions, [CallbackPermission.Invoke]);
    // 请求里没有 properties（按较早的规范实现的宿主不发）：属性是空表，不是没有这个成员
    assert.deepEqual(seen.bindings, [
      { name: 'cache', type: 'cache:distributed', value: 'redis:6379', properties: new Map() },
    ]);
    assert.equal(seen.workDirectory, '/var/lib/probe');
  } finally {
    await plugin.close();
  }
});

/** 启动一个记下配置回调参数的测试插件并握手 */
async function launchConfigurable(): Promise<{ plugin: Launched; seen: () => PluginConfiguration | undefined }> {
  let seen: PluginConfiguration | undefined;
  const plugin = await launch({
    hooks: {
      configure: (configuration) => {
        seen = configuration;
        return Result.success();
      },
    },
  });
  await handshake(plugin.client);
  return { plugin, seen: () => seen };
}

/** Configure，请求是给定的字节原样：不经本 SDK 的编码，插件一侧用生成的 ConfigureRequest 解码 */
function configureBytes(client: pb.PluginClient, bytes: Uint8Array): Promise<pb.ConfigureResponse> {
  const method = pb.PluginService.configure;
  return unary<pb.ConfigureResponse>((done) =>
    client.makeUnaryRequest(
      method.path,
      (value: Uint8Array) => Buffer.from(value),
      method.responseDeserialize,
      bytes,
      sessionMetadata(),
      // 没有错误时总有响应：缺了就按空的响应处理，下面对 status 的断言会失败
      (error, value) => done(error, value ?? pb.ConfigureResponse.create()),
    ),
  );
}

test('Configure 交出的绑定连同属性遵循 binding-properties.json 的 reading：宿主写出的字节原样进来（lifecycle.md §7.2）', async () => {
  const vectors = vector<{
    reading: {
      name: string;
      hex: string;
      bindings: { name: string; type: string; value: string; properties: Record<string, string> }[];
    }[];
  }>('binding-properties.json');
  assert.ok(vectors.reading.length > 0);
  for (const entry of vectors.reading) {
    const { plugin, seen } = await launchConfigurable();
    try {
      const bytes = Buffer.from(entry.hex, 'hex');
      assert.equal(bytes.length * 2, entry.hex.length, entry.name);
      // 生成的消息类型读得出这些字节，绑定的个数与先后和期望的相同
      assert.deepEqual(
        pb.ConfigureRequest.decode(bytes).bindings.map((binding) => binding.name),
        entry.bindings.map((binding) => binding.name),
        entry.name,
      );
      assert.equal((await configureBytes(plugin.client, bytes)).status?.ok, true, entry.name);
      // 绑定按先后逐项比较；属性表按属性名比较，各项的先后没有含义
      assert.deepEqual(
        seen()?.bindings,
        entry.bindings.map((binding) => ({
          name: binding.name,
          type: binding.type,
          value: binding.value,
          properties: new Map(Object.entries(binding.properties)),
        })),
        entry.name,
      );
    } finally {
      await plugin.close();
    }
  }
});

test('绑定的属性原样交出：属性名区分大小写、__proto__ 这样的名字不丢，不核对文法与上限，交出的是冻结的拷贝（lifecycle.md §7.2）', async () => {
  // 属性名里有对象原型上的名字、只差大小写的两项、纯数字的名字、不合下发文法的名字与空值
  const odd = new Map([
    ['__proto__', 'proto'],
    ['constructor', 'ctor'],
    ['toString', 'text'],
    ['hasOwnProperty', 'own'],
    ['accessKey', 'lower'],
    ['AccessKey', 'upper'],
    ['8080', 'digits'],
    ['.hidden', 'dot'],
    ['user name', 'space'],
    ['empty', ''],
  ]);
  // 超过宿主一侧的上限（64 个属性、名字 253 个字符）：那是宿主的事，SDK 照交
  const many = new Map<string, string>(Array.from({ length: 100 }, (_, index) => [`p${index}`, String(index)]));
  many.set('n'.repeat(300), 'long');
  const request = pb.ConfigureRequest.fromPartial({
    configuration: '{}',
    bindings: [
      { name: 'db', type: 'connection:relational', value: '', properties: odd },
      { name: 'many', type: 'queue', value: 'amqp://mq.internal', properties: many },
    ],
  });
  const { plugin, seen } = await launchConfigurable();
  try {
    const configured = await unary<pb.ConfigureResponse>((done) =>
      plugin.client.configure(request, sessionMetadata(), done),
    );
    // 主值为空不是错误
    assert.equal(configured.status?.ok, true);
    const bindings = seen()?.bindings ?? [];
    assert.deepEqual(bindings, [
      { name: 'db', type: 'connection:relational', value: '', properties: odd },
      { name: 'many', type: 'queue', value: 'amqp://mq.internal', properties: many },
    ]);
    const [db] = bindings;
    assert.ok(db !== undefined);
    assert.equal(db.properties.size, odd.size);
    assert.equal(db.properties.get('__proto__'), 'proto');
    assert.equal(db.properties.get('accessKey'), 'lower');
    assert.equal(db.properties.get('AccessKey'), 'upper');
    assert.equal(db.properties.get('accesskey'), undefined);
    assert.equal(db.properties.get('empty'), '');
    assert.equal(db.properties.has('missing'), false);
    // 交出的是冻结的对象与一份拷贝：作者改不动绑定，改自己手里的表也不影响别处
    assert.ok(Object.isFrozen(bindings));
    assert.ok(Object.isFrozen(db));
    assert.notEqual(db.properties, odd);
    // 展开得到的只有四个成员：调试出口不可枚举，不混进拷贝与逐成员的比较
    assert.deepEqual(Object.keys(db), ['name', 'type', 'value', 'properties']);
  } finally {
    await plugin.close();
  }
});

test('绑定的调试出口只带绑定名、类型与属性名，不带主值与属性值，运行时的日志也不带（lifecycle.md §7.2）', async () => {
  const secrets = ['postgres://app:hunter2@db.internal/app', 'app-user-7f3a', 's3cret-9d1c'];
  const [value = '', username = '', password = ''] = secrets;
  const request = pb.ConfigureRequest.fromPartial({
    configuration: '{}',
    bindings: [
      {
        name: 'db',
        type: 'connection:relational',
        value,
        properties: new Map([
          ['username', username],
          ['password', password],
        ]),
      },
    ],
  });
  const { plugin, seen } = await launchConfigurable();
  try {
    assert.equal(
      (await unary<pb.ConfigureResponse>((done) => plugin.client.configure(request, sessionMetadata(), done))).status
        ?.ok,
      true,
    );
    const configuration = seen();
    const [binding] = configuration?.bindings ?? [];
    assert.ok(configuration !== undefined && binding !== undefined);
    // 作者照常读得到值
    assert.equal(binding.value, value);
    assert.equal(binding.properties.get('password'), password);

    const lines: string[] = [];
    const logger = new PluginLogger({ write: (text: string) => lines.push(text) });
    logger.information('configured', { binding, bindings: configuration.bindings });
    const outputs: Record<string, string> = {
      'JSON.stringify(binding)': JSON.stringify(binding),
      'JSON.stringify(configuration)': JSON.stringify(configuration),
      'writeJson(binding)': writeJson(binding),
      'String(binding)': String(binding),
      'template literal': `${binding}`,
      'inspect(binding)': inspect(binding),
      'inspect(binding, colors)': inspect(binding, { colors: true }),
      'inspect(configuration)': inspect(configuration),
      'inspect(configuration, depth: null, showHidden)': inspect(configuration, { depth: null, showHidden: true }),
      'format(%s %o %O %j)': format('%s %o %O %j', binding, binding, binding, binding),
      PluginLogger: lines.join(''),
      'runtime logs': plugin.logs.join(''),
    };
    for (const [exit, text] of Object.entries(outputs)) {
      for (const secret of secrets) {
        assert.ok(!text.includes(secret), `${exit} must not carry '${secret}': ${text}`);
      }
    }
    // 绑定名、类型与属性名都在
    for (const exit of ['JSON.stringify(binding)', 'String(binding)', 'inspect(binding)', 'inspect(configuration)']) {
      for (const expected of ['db', 'connection:relational', 'username', 'password']) {
        assert.ok(outputs[exit]?.includes(expected), `${exit} must carry '${expected}': ${outputs[exit]}`);
      }
    }
    assert.equal(
      outputs['JSON.stringify(binding)'],
      '{"name":"db","type":"connection:relational","propertyNames":["username","password"]}',
    );
    assert.equal(outputs['String(binding)'], `PluginBinding(${outputs['JSON.stringify(binding)']})`);
    assert.equal(
      inspect(binding, { breakLength: Number.POSITIVE_INFINITY }),
      "PluginBinding { name: 'db', type: 'connection:relational', propertyNames: [ 'username', 'password' ] }",
    );
    // 层数用完时只写一个记号
    assert.equal(inspect([binding], { depth: 0 }), '[ [PluginBinding] ]');
  } finally {
    await plugin.close();
  }
});

test('配置节的类型化读取：成员名 ASCII 不区分大小写，字符串叶子按 JSON 数字文法读成数字、按 true/false 读成布尔（lifecycle.md §7.2）', () => {
  const section = new ConfigurationSection(
    parseJson(
      '{"Retries":"3","ratio":"-1.5e2","Big":12,"leading":"03","plus":"+3","spaced":" 3","hex":"0x10","Enabled":"True","off":"FALSE","yes":"yes","flag":true,"Name":"echo","none":null,"Db":{"Port":"5432"},"list":["a","b"]}',
    ) as JsonObject,
  );
  assert.equal(section.number('retries'), 3);
  assert.equal(section.number('RETRIES'), 3);
  assert.equal(section.number('ratio'), -150);
  assert.equal(section.number('big'), 12);
  for (const name of ['leading', 'plus', 'spaced', 'hex', 'name', 'none', 'missing', 'db']) {
    assert.equal(section.number(name), undefined, name);
  }
  assert.equal(section.boolean('enabled'), true);
  assert.equal(section.boolean('off'), false);
  assert.equal(section.boolean('flag'), true);
  assert.equal(section.boolean('yes'), undefined);
  assert.equal(section.string('name'), 'echo');
  assert.equal(section.string('retries'), '3');
  assert.equal(section.string('big'), undefined);
  assert.equal(section.has('NONE'), true);
  assert.equal(section.get('none'), null);
  assert.equal(section.has('missing'), false);
  assert.equal(section.section('db')?.number('port'), 5432);
  assert.equal(section.section('name'), undefined);
  assert.deepEqual(section.get('list'), ['a', 'b']);
  // 只按 ASCII 换大小写：不按区域把 K（开尔文符号）之类当作 k
  assert.equal(new ConfigurationSection({ k: '1' }).number(String.fromCharCode(0x212a)), undefined);
});

test('Start：成功后立即求一次健康再应答，按结果进入 Ready、Degraded 或 Failed；没有健康回调即 Ready（lifecycle.md §7.3）', async () => {
  const outcomes: [PluginOptions['hooks'], LifecycleState, number][] = [
    [{}, LifecycleState.Ready, 0],
    [{ health: () => ({ state: LifecycleState.Degraded }) }, LifecycleState.Degraded, 1],
    [{ health: () => ({ state: LifecycleState.Failed }) }, LifecycleState.Failed, 1],
    // 报其他状态的不算问题：Start 应答之后总是 Ready、Degraded 或 Failed
    [{ health: () => ({ state: LifecycleState.Started }) }, LifecycleState.Ready, 1],
    [
      {
        health: () => {
          throw new RangeError('boom');
        },
      },
      LifecycleState.Degraded,
      1,
    ],
  ];
  for (const [hooks, expected, healthCalls] of outcomes) {
    let calls = 0;
    const hook = hooks?.health;
    const plugin = await launch({
      hooks:
        hook === undefined
          ? {}
          : {
              health: () => {
                calls += 1;
                return hook();
              },
            },
    });
    try {
      await handshake(plugin.client);
      await configure(plugin.client);
      const started = await start(plugin.client);
      assert.equal(started.status?.ok, true);
      assert.equal(calls, healthCalls, expected);
      // 应答之前就进了这个状态：Invoke 立即可用或不可用
      const response = await invoke(plugin.client, 'probes.context');
      if (expected === LifecycleState.Failed) {
        assertFailure(response.status, PluginErrorCode.Unavailable, PluginMessageKey.Unavailable, {
          id: pluginId,
          state: 'Failed',
        });
      } else {
        assert.equal(response.status?.ok, true, expected);
      }
    } finally {
      await plugin.close();
    }
  }
});

test('启动失败、抛出时进入 Failed，reason 是简单类型名；只有 Ready 与 Degraded 可服务（lifecycle.md §7.3）', async () => {
  const failing = await launch({
    hooks: {
      start: () => {
        throw new SyntaxError('secret detail');
      },
    },
  });
  try {
    await handshake(failing.client);
    await configure(failing.client);
    const started = await start(failing.client);
    assertFailure(started.status, PluginErrorCode.Unexpected, PluginMessageKey.Failed, {
      id: pluginId,
      phase: 'start',
      reason: 'SyntaxError',
    });
    assert.equal((await health(failing.client)).state, lifecycleStateOrdinal(LifecycleState.Failed));
    assertFailure(
      (await invoke(failing.client, 'probes.context')).status,
      PluginErrorCode.Unavailable,
      PluginMessageKey.Unavailable,
      { id: pluginId, state: 'Failed' },
    );
  } finally {
    await failing.close();
  }
});

test('Invoke 依次核对：未声明的操作 Unimplemented、不可服务时 plugins.process.unavailable、然后经调用器（invocation.md §1）', async () => {
  const plugin = await launch();
  try {
    await handshake(plugin.client);
    await configure(plugin.client);
    // 未声明先于就绪
    await rejectsWith(invoke(plugin.client, 'probes.missing'), status.UNIMPLEMENTED);
    const early = await invoke(plugin.client, 'probes.context');
    assertFailure(early.status, PluginErrorCode.Unavailable, PluginMessageKey.Unavailable, {
      id: pluginId,
      state: 'Configured',
    });
    assert.equal(early.payload.length, 0);
    await start(plugin.client);
    const ok = await invoke(plugin.client, 'probes.context', '{"text":"hi"}');
    assert.equal(ok.status?.ok, true);
    assert.equal((payloadOf(ok) as { text: string }).text, 'hi');
    // 空载荷等价于 {}
    assert.equal((await invoke(plugin.client, 'probes.context', '')).status?.ok, true);
    const invalid = await invoke(plugin.client, 'probes.context', '{"text":1}');
    assertFailure(invalid.status, 'KERNEL_VALIDATION_001', 'kernel.operation.invalid_payload', {
      id: 'probes.context',
      reason: '$.text',
    });
    await rejectsWith(invoke(plugin.client, 'probes.missing'), status.UNIMPLEMENTED);
  } finally {
    await plugin.close();
  }
});

test('写出 Error：带消息键的 text 留空，只有自由文本写 text，details 是 JSON 对象文本，inner 照写（invocation.md §3）', async () => {
  const plugin = await launch();
  try {
    await startPlugin(plugin.client);
    const keyed = await invoke(plugin.client, 'probes.fail');
    assert.equal(keyed.payload.length, 0);
    // details 按值模型写出：整数值的浮点带小数点（RFC-0001「Result」）
    assert.deepEqual(keyed.status?.error, {
      code: 'PROBES_VALIDATION_001',
      messageKey: 'probes.value.invalid',
      text: '',
      details: '{"min":1,"ratio":2.0}',
      inner: undefined,
    });
    assert.deepEqual((await invoke(plugin.client, 'probes.fail', '{"kind":"literal"}')).status?.error, {
      code: 'PROBES_VALIDATION_003',
      messageKey: '',
      text: 'A literal failure.',
      details: '',
      inner: undefined,
    });
    // 作者用 withText 填的文案也不写：宿主按调用方的语言翻译
    assert.equal((await invoke(plugin.client, 'probes.fail', '{"kind":"text"}')).status?.error?.text, '');
    assert.deepEqual((await invoke(plugin.client, 'probes.fail', '{"kind":"inner"}')).status?.error, {
      code: 'PROBES_UNEXPECTED_001',
      messageKey: 'probes.value.outer',
      text: '',
      details: '',
      inner: { code: 'PROBES_VALIDATION_005', messageKey: '', text: 'Inner.', details: '', inner: undefined },
    });
  } finally {
    await plugin.close();
  }
});

test('调用上下文：trace_parent 按文法取、trace_state 不进上下文、Baggage 只留已登记的键，截止时间严格读并取较早者（invocation.md §2）', async () => {
  const plugin = await launch();
  try {
    await startPlugin(plugin.client);
    const deadline = Date.now() + 60_000;
    // 七位小数：多余的位截掉，只会提前不到 1 毫秒
    const text = `${formatDeadline(deadline).slice(0, 23)}4567+00:00`;
    const response = await invoke(plugin.client, 'probes.context', '{}', {
      traceParent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00',
      traceState: 'vendor=1',
      deadline: text,
      baggage: new Map([
        [BaggageKey.Tenant, 't1'],
        [BaggageKey.Principal, 'u1'],
        [BaggageKey.Correlation, 'bad\nvalue'],
        ['xihan.unregistered', 'dropped'],
        ['other', 'dropped'],
      ]),
    });
    const seen = payloadOf(response) as Record<string, unknown>;
    assert.equal(seen.tenant, 't1');
    assert.equal(seen.principal, 'u1');
    // 含控制字符的值丢弃，未登记的键丢弃（RFC-0003 第 3 条）
    assert.equal(seen.correlation, null);
    assert.deepEqual(seen.baggage, { [BaggageKey.Principal]: 'u1', [BaggageKey.Tenant]: 't1' });
    assert.equal(seen.deadline, Math.trunc(deadline));
    assert.equal(seen.traceId, '0af7651916cd43dd8448eb211c80319c');
    assert.equal(seen.sampled, false);
    assert.equal(seen.aborted, false);

    // 不合文法的 traceparent 当作没有父 Span：生成新的追踪
    const orphan = payloadOf(
      await invoke(plugin.client, 'probes.context', '{}', {
        traceParent: '00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01',
      }),
    ) as { traceId: string };
    assert.notEqual(orphan.traceId, '0af7651916cd43dd8448eb211c80319c');

    const deadlineOf = async (metadata: string, grpc: Date | undefined) =>
      (
        payloadOf(await invoke(plugin.client, 'probes.context', '{}', { deadline: metadata }, token, grpc)) as {
          deadline: number | null;
        }
      ).deadline;
    const grpc = new Date(Date.now() + 30_000);
    // 读不出（含宽松的写法）当作没有：取 gRPC 调用自己的截止时间
    for (const loose of ['', 'not-a-deadline', new Date(Date.now() + 10_000).toISOString().replace('T', ' ')]) {
      const fallback = await deadlineOf(loose, grpc);
      assert.ok(fallback !== null && Math.abs(fallback - grpc.getTime()) < 1000, `${loose} ${fallback}`);
    }
    // 两者都有时取较早的
    const earlier = Date.now() + 10_000;
    assert.equal(await deadlineOf(formatDeadline(earlier), grpc), earlier);
    const later = Date.now() + 90_000;
    const effective = await deadlineOf(formatDeadline(later), grpc);
    assert.ok(effective !== null && effective < later && Math.abs(effective - grpc.getTime()) < 1000);
    // 都没有就没有截止时间
    assert.equal(await deadlineOf('', undefined), null);
  } finally {
    await plugin.close();
  }
});

test('Health：Start 之前报本地状态、不调回调；可服务期间每次求一次，只有 Ready、Degraded、Failed 改变状态（lifecycle.md §7.4）', async () => {
  let calls = 0;
  let reported: PluginHealth = { state: LifecycleState.Ready };
  const plugin = await launch({
    hooks: {
      health: () => {
        calls += 1;
        if (reported.state === LifecycleState.Declared) {
          throw new EvalError('secret detail');
        }
        return {
          ...reported,
          items: [
            { name: 'probe', status: HealthStatus.Healthy, description: 'probe item' },
            { name: 'undeclared', status: HealthStatus.Healthy },
          ],
        };
      },
    },
  });
  try {
    for (const [step, state] of [
      [async () => {}, LifecycleState.Declared],
      [() => handshake(plugin.client), LifecycleState.Resolved],
      [() => configure(plugin.client), LifecycleState.Configured],
    ] as const) {
      await step();
      const local = await health(plugin.client);
      assert.equal(local.state, lifecycleStateOrdinal(state));
      assert.deepEqual(local.items, []);
    }
    assert.equal(calls, 0, 'the health hook is not called before Start');
    await start(plugin.client);
    assert.equal(calls, 1);
    const first = await health(plugin.client);
    assert.equal(calls, 2, 'every Health asks the hook once while serving');
    assert.equal(first.state, lifecycleStateOrdinal(LifecycleState.Ready));
    assert.deepEqual(first.items, [
      { name: 'probe', status: pb.HealthStatus.HEALTH_STATUS_HEALTHY, description: 'probe item' },
    ]);
    await health(plugin.client);
    // 未声明的健康项丢掉，同一个名字只记一条 warning
    assert.equal(logged(plugin.logs, 'warning', 'undeclared'), 1);

    // 报其他状态的不改变状态
    reported = { state: LifecycleState.Draining };
    assert.equal((await health(plugin.client)).state, lifecycleStateOrdinal(LifecycleState.Ready));
    // 抛出：这一次是 Degraded，带 plugins.process.failed、没有健康项
    reported = { state: LifecycleState.Declared };
    const thrown = await health(plugin.client);
    assert.equal(thrown.state, lifecycleStateOrdinal(LifecycleState.Degraded));
    assert.deepEqual(thrown.items, []);
    assert.deepEqual(thrown.error, {
      code: PluginErrorCode.Unexpected,
      messageKey: PluginMessageKey.Failed,
      text: '',
      details: writeJson({ id: pluginId, phase: 'health', reason: 'EvalError' }),
      inner: undefined,
    });
    reported = { state: LifecycleState.Ready };
    assert.equal((await health(plugin.client)).state, lifecycleStateOrdinal(LifecycleState.Ready));
    // Failed 之后不再回来，也不再调回调
    reported = { state: LifecycleState.Failed, error: ErrorInfo.unavailable('PROBES_UNAVAILABLE_003', 'probes.down') };
    const failed = await health(plugin.client);
    assert.equal(failed.state, lifecycleStateOrdinal(LifecycleState.Failed));
    assert.equal(failed.error?.code, 'PROBES_UNAVAILABLE_003');
    reported = { state: LifecycleState.Ready };
    const before = calls;
    assert.equal((await health(plugin.client)).state, lifecycleStateOrdinal(LifecycleState.Failed));
    assert.equal(calls, before);
  } finally {
    await plugin.close();
  }
});

test('WatchHealth：先推当前状态，按间隔重新求健康、变化时推送，进入 Draining 推一次，应答 Stop 之后结束流（lifecycle.md §7.4）', async () => {
  let state: LifecycleState = LifecycleState.Ready;
  let itemStatus: HealthStatus = HealthStatus.Healthy;
  const plugin = await launch({
    hooks: {
      health: () => ({ state, items: [{ name: 'probe', status: itemStatus }] }),
    },
  });
  await startPlugin(plugin.client);
  const events: string[] = [];
  const changed = gate();
  const watch = collect(plugin.client.watchHealth({}, sessionMetadata()), (message, all) => {
    events.push(`push:${message.state}`);
    if (all.length === 3) {
      changed.open();
    }
  });
  await delay(120);
  itemStatus = HealthStatus.Degraded;
  await delay(120);
  state = LifecycleState.Degraded;
  await changed.wait;
  assert.equal(watch.messages[0]?.state, lifecycleStateOrdinal(LifecycleState.Ready));
  assert.equal(watch.messages[1]?.items[0]?.status, pb.HealthStatus.HEALTH_STATUS_DEGRADED);
  assert.equal(watch.messages[2]?.state, lifecycleStateOrdinal(LifecycleState.Degraded));

  const stopped = stop(plugin.client, 1, 'unload').then((response) => {
    events.push('stop');
    return response;
  });
  void watch.ended.then(() => events.push('end'));
  assert.equal((await stopped).status?.ok, true);
  assert.equal(await watch.ended, undefined);
  assert.equal(watch.messages.at(-1)?.state, lifecycleStateOrdinal(LifecycleState.Draining));
  // 流在应答 Stop 之后才结束
  assert.ok(events.indexOf('stop') < events.indexOf('end'), events.join(' '));
  await plugin.served;
  plugin.client.close();
});

// ── 停止与收尾 ────────────────────────────────────────────────────────────────

test('Stop：拒绝新调用、在宽限内等在途调用，再调停止回调（reason 原样），之后服务停止（lifecycle.md §7.5）', async () => {
  const stops: unknown[] = [];
  const plugin = await launch({
    hooks: {
      stop: (value) => {
        stops.push({ reason: value.reason, aborted: value.signal.aborted });
        return Result.success();
      },
    },
  });
  await startPlugin(plugin.client);
  const slow = invoke(plugin.client, 'probes.slow');
  await plugin.probe.slowStarted.wait;
  const stopping = stop(plugin.client, 5, 'restart');
  await delay(50);
  assertFailure(
    (await invoke(plugin.client, 'probes.context')).status,
    PluginErrorCode.Unavailable,
    PluginMessageKey.Unavailable,
    { id: pluginId, state: 'Draining' },
  );
  assert.deepEqual(stops, [], 'the stop hook runs after the in-flight calls finish');
  plugin.probe.slow.open();
  assert.deepEqual(payloadOf(await slow), { done: true });
  assert.equal((await stopping).status?.ok, true);
  assert.deepEqual(stops, [{ reason: 'restart', aborted: false }]);
  await plugin.served;
  // stdin 随后关闭也不再收尾一次，停止回调最多调一次
  plugin.stdin.end();
  await delay(20);
  assert.equal(stops.length, 1);
  // 进程还活着时运行时在 1 秒后以退出码 0 退出
  await delay(1100);
  assert.deepEqual(
    plugin.exits.map((exit) => exit.code),
    [0],
  );
  plugin.client.close();
});

test('Stop：宽限到了触发在途调用的取消、不再等；grace_seconds 为 0 按 5 秒（lifecycle.md §7.5）', async () => {
  for (const [graceSeconds, expected] of [
    [1, 1000],
    [0, 5000],
  ] as const) {
    let stoppedAt = 0;
    const plugin = await launch({
      hooks: {
        stop: () => {
          stoppedAt = Date.now();
          return Result.success();
        },
      },
    });
    await startPlugin(plugin.client);
    const waiting = invoke(plugin.client, 'probes.wait');
    await plugin.probe.waitStarted.wait;
    const began = Date.now();
    const stopped = await stop(plugin.client, graceSeconds);
    assert.equal(stopped.status?.ok, true);
    const abortedAfter = (plugin.probe.abortedAt ?? 0) - began;
    assert.ok(abortedAfter >= expected - 50 && abortedAfter < expected + 1000, `${graceSeconds}: ${abortedAfter}`);
    // 取消触发之后不再等，接着调停止回调
    assert.ok(stoppedAt - began >= expected - 50, `${graceSeconds}: ${stoppedAt - began}`);
    assertFailure((await waiting).status, 'KERNEL_CANCELLED_001', 'kernel.invocation.cancelled', undefined);
    await plugin.served;
    plugin.client.close();
  }
});

test('Stop：启动没成功过的不调停止回调；启动成功后 Failed 的照样调；停止回调失败或抛出写进 status、照常退出（lifecycle.md §7.5）', async () => {
  // 握手之后直接 Stop
  let stops = 0;
  const early = await launch({
    hooks: {
      stop: () => {
        stops += 1;
        return Result.success();
      },
    },
  });
  await handshake(early.client);
  assert.equal((await stop(early.client, 0)).status?.ok, true);
  await early.served;
  assert.equal(stops, 0);
  early.client.close();

  // 健康报 Failed 之后：不迁移状态，调停止回调
  const failed = await launch({
    hooks: {
      health: () => ({ state: LifecycleState.Failed }),
      stop: () => Result.fail(ErrorInfo.unavailable('PROBES_UNAVAILABLE_004', 'probes.release.failed')),
    },
  });
  await startPlugin(failed.client);
  assert.equal((await health(failed.client)).state, lifecycleStateOrdinal(LifecycleState.Failed));
  const failure = await stop(failed.client);
  assertFailure(failure.status, 'PROBES_UNAVAILABLE_004', 'probes.release.failed', undefined);
  await failed.served;
  failed.client.close();

  const throwing = await launch({
    hooks: {
      stop: () => {
        throw new URIError('secret detail');
      },
    },
  });
  await startPlugin(throwing.client);
  const thrown = await stop(throwing.client);
  assertFailure(thrown.status, PluginErrorCode.Unexpected, PluginMessageKey.Failed, {
    id: pluginId,
    phase: 'stop',
    reason: 'URIError',
  });
  await throwing.served;
  throwing.client.close();
});

test('stdin 关闭与 SIGTERM：进入 Draining、立即取消在途调用并等它们，调一次停止回调（reason 为 shutdown）（lifecycle.md §7.7）', async () => {
  for (const trigger of ['stdin', 'SIGTERM'] as const) {
    const stops: string[] = [];
    const sigtermBefore = process.listeners('SIGTERM');
    const plugin = await launch({
      hooks: {
        stop: (value) => {
          stops.push(value.reason);
          return Result.success();
        },
      },
    });
    await startPlugin(plugin.client);
    const waiting = invoke(plugin.client, 'probes.wait');
    await plugin.probe.waitStarted.wait;
    const began = Date.now();
    if (trigger === 'stdin') {
      plugin.stdin.end();
    } else {
      // 只调运行时自己的监听器：测试运行器也可能监听 SIGTERM
      for (const listener of process.listeners('SIGTERM').filter((item) => !sigtermBefore.includes(item))) {
        listener('SIGTERM');
      }
    }
    assertFailure((await waiting).status, 'KERNEL_CANCELLED_001', 'kernel.invocation.cancelled', undefined);
    assert.ok((plugin.probe.abortedAt ?? 0) - began < 500, 'in-flight calls are cancelled immediately');
    await plugin.served;
    assert.deepEqual(stops, ['shutdown'], trigger);
    assert.equal(logged(plugin.logs, 'information', trigger === 'stdin' ? 'stdin closed' : 'SIGTERM received'), 1);
    await rejectsWith(invoke(plugin.client, 'probes.context'), status.UNAVAILABLE);
    plugin.client.close();
  }

  // 启动之前收到：不迁移状态、不调停止回调
  let stops = 0;
  const early = await launch({
    hooks: {
      stop: () => {
        stops += 1;
        return Result.success();
      },
    },
  });
  await handshake(early.client);
  await configure(early.client);
  early.stdin.end();
  await early.served;
  assert.equal(stops, 0);
  early.client.close();
});

test('收尾从收到请求起最多 3 秒：在途调用不理会取消时到点以退出码 0 退出，进行中的 Stop 同样受限（lifecycle.md §7.7）', async () => {
  for (const withStop of [false, true]) {
    const plugin = await launch();
    await startPlugin(plugin.client);
    const slow = invoke(plugin.client, 'probes.slow');
    await plugin.probe.slowStarted.wait;
    if (withStop) {
      void stop(plugin.client, 30).catch(() => {});
      await delay(50);
    }
    const began = Date.now();
    plugin.stdin.end();
    await delay(3200);
    const [exit] = plugin.exits;
    assert.equal(exit?.code, 0, `withStop=${withStop}`);
    assert.ok(exit !== undefined && exit.at - began >= 2900 && exit.at - began < 3300, `${exit?.at} ${began}`);
    // 测试里没有真的退出：放行卡住的调用，让服务停下来
    plugin.probe.slow.open();
    await slow.catch(() => {});
    await plugin.served;
    plugin.client.close();
  }
});

// ── 流式与投递 ────────────────────────────────────────────────────────────────

test('InvokeStream：第一帧之前结束或第一帧不是 start 为 InvalidArgument，start 一律 Unimplemented，不论声明与就绪（invocation.md §1）', async () => {
  const plugin = await launch();
  try {
    const frames: [pb.StreamFrame | undefined, number][] = [
      [undefined, status.INVALID_ARGUMENT],
      [{ chunk: new TextEncoder().encode('{}') }, status.INVALID_ARGUMENT],
      [{ end: { ok: true, error: undefined } }, status.INVALID_ARGUMENT],
      [{ start: pb.InvokeRequest.fromPartial({ operation: 'probes.context' }) }, status.UNIMPLEMENTED],
      [{ start: pb.InvokeRequest.fromPartial({ operation: 'probes.missing' }) }, status.UNIMPLEMENTED],
    ];
    // 握手之前与启动之后都一样
    for (const phase of ['declared', 'ready']) {
      if (phase === 'ready') {
        await startPlugin(plugin.client);
      }
      for (const [frame, code] of frames) {
        assert.equal(await streamEndsWith(plugin.client, frame), code, `${phase} ${JSON.stringify(frame)}`);
      }
    }
  } finally {
    await plugin.close();
  }
});

test('HandleEvent：信封与方式先核对，找不到订阅为 plugins.event.unsubscribed，再看就绪；匹配的订阅按声明顺序依次执行（invocation.md §4）', async () => {
  const delivered: string[] = [];
  const record =
    (name: string, outcome: () => Result<void> = () => Result.success()) =>
    async (_context: InvocationContext, envelope: { readonly id: string }) => {
      delivered.push(`${name}:${envelope.id}`);
      return outcome();
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
      { topic: 'probe.events', messageType: 'probe.twice', handler: record('typed') },
      {
        topic: 'probe.failing',
        handler: record('first', () =>
          Result.fail(ErrorInfo.unavailable('PROBES_UNAVAILABLE_002', 'probes.store.down')),
        ),
      },
      { topic: 'probe.failing', messageType: 'x', handler: record('second') },
      {
        topic: 'probe.throwing',
        handler: async () => {
          throw new FrameworkError('PROBES_VALIDATION_009', 'Broken.');
        },
      },
    ],
  });
  try {
    await handshake(plugin.client);
    await configure(plugin.client);
    // 订阅先于就绪：找不到订阅的投递在 Start 之前也报 unsubscribed，空方式写 competing
    assertFailure(
      (await deliver(plugin.client, 'nobody.listens', 'some.type', '')).status,
      'KERNEL_NOTFOUND_001',
      PluginMessageKey.Unsubscribed,
      { id: pluginId, topic: 'nobody.listens', type: 'some.type', mode: 'competing' },
    );
    assertFailure(
      (await deliver(plugin.client, 'probe.events', 'probe.flush', 'competing')).status,
      PluginErrorCode.Unavailable,
      PluginMessageKey.Unavailable,
      { id: pluginId, state: 'Configured' },
    );
    for (const mode of ['bogus', 'Competing']) {
      await rejectsWith(deliver(plugin.client, 'probe.events', 'x', mode), status.INVALID_ARGUMENT);
    }
    await rejectsWith(
      unary((done) =>
        plugin.client.handleEvent(pb.HandleEventRequest.fromPartial({ mode: 'competing' }), sessionMetadata(), done),
      ),
      status.INVALID_ARGUMENT,
    );
    await start(plugin.client);

    assert.equal((await deliver(plugin.client, 'probe.events', 'probe.flush', 'competing', '1')).status?.ok, true);
    assert.equal((await deliver(plugin.client, 'probe.events', 'probe.flush', 'broadcast', '2')).status?.ok, true);
    // 空同 competing；两个竞争订阅都匹配时按声明顺序都执行
    assert.equal((await deliver(plugin.client, 'probe.events', 'probe.twice', '', '3')).status?.ok, true);
    // 广播只声明了 probe.flush：别的类型不改交给竞争订阅
    assertFailure(
      (await deliver(plugin.client, 'probe.events', 'probe.other', 'broadcast', '4')).status,
      'KERNEL_NOTFOUND_001',
      PluginMessageKey.Unsubscribed,
      { id: pluginId, topic: 'probe.events', type: 'probe.other', mode: 'broadcast' },
    );
    // 第一个失败即结果，后面的不执行
    assertFailure(
      (await deliver(plugin.client, 'probe.failing', 'x', 'competing', '5')).status,
      'PROBES_UNAVAILABLE_002',
      'probes.store.down',
      undefined,
    );
    assert.deepEqual(delivered, ['competing:1', 'broadcast:2', 'competing:3', 'typed:3', 'first:5']);
    // 处理器抛出：未处理异常，FrameworkError 的错误放进 inner
    const thrown = await deliver(plugin.client, 'probe.throwing', 'x', 'competing');
    assert.equal(thrown.status?.error?.code, 'KERNEL_UNEXPECTED_001');
    assert.equal(thrown.status?.error?.messageKey, 'kernel.invocation.unhandled_exception');
    assert.equal(thrown.status?.error?.inner?.code, 'PROBES_VALIDATION_009');
  } finally {
    await plugin.close();
  }
});

// ── 回调 ─────────────────────────────────────────────────────────────────────

/** 扮演宿主的回调服务收到的一次请求 */
interface Received {
  readonly method: string;
  readonly session: unknown[];
  readonly deadline: Date | number;
  readonly request: pb.InvokeRequest | pb.PublishRequest;
}

/** 扮演宿主的回调服务：记下收到的请求，按 `respond` 应答；`target` 缺省为回环 TCP 上系统分配的端口 */
async function fakeHost(
  respond: {
    invoke?: (
      request: pb.InvokeRequest,
    ) => pb.InvokeResponse | { code: number; details: string } | Promise<pb.InvokeResponse>;
    publish?: (request: pb.PublishRequest) => pb.PublishResponse | { code: number; details: string };
  },
  target = '127.0.0.1:0',
) {
  const received: Received[] = [];
  const server = new Server();
  const answer = <T>(pending: T | { code: number; details: string } | Promise<T>, callback: sendUnaryData<T>) => {
    void Promise.resolve(pending).then((reply) => {
      if (typeof reply === 'object' && reply !== null && 'code' in reply) {
        callback(reply as { code: number; details: string });
      } else {
        callback(null, reply as T);
      }
    });
  };
  const service: pb.HostServer = {
    invoke: (
      call: ServerUnaryCall<pb.InvokeRequest, pb.InvokeResponse>,
      callback: sendUnaryData<pb.InvokeResponse>,
    ) => {
      received.push({
        method: 'invoke',
        session: call.metadata.get(PluginProtocol.sessionMetadataKey),
        deadline: call.getDeadline(),
        request: call.request,
      });
      answer(
        respond.invoke?.(call.request) ?? { status: { ok: true, error: undefined }, payload: new Uint8Array() },
        callback,
      );
    },
    publish: (
      call: ServerUnaryCall<pb.PublishRequest, pb.PublishResponse>,
      callback: sendUnaryData<pb.PublishResponse>,
    ) => {
      received.push({
        method: 'publish',
        session: call.metadata.get(PluginProtocol.sessionMetadataKey),
        deadline: call.getDeadline(),
        request: call.request,
      });
      answer(
        respond.publish?.(call.request) ?? {
          results: call.request.envelopes.map(() => ({ ok: true, error: undefined })),
        },
        callback,
      );
    },
  };
  server.addService(pb.HostService, service);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(target, ServerCredentials.createInsecure(), (error, bound) =>
      error === null ? resolve(bound) : reject(error),
    ),
  );
  return { address: `tcp 127.0.0.1:${port}`, received, close: () => server.forceShutdown() };
}

test('回调端点：取第一个本 SDK 能连的项；没有可用的项时照常服务、启动时记 warning，回调为 plugins.host.unavailable 且不发请求（handshake.md §4）', async () => {
  const windows = process.platform === 'win32';
  // 本平台连不上的项排在前面：Windows 上的 Unix 域套接字、其他系统上的命名管道
  const unsupported = windows ? 'unix C:/nowhere/host.sock' : 'npipe \\\\.\\pipe\\xihan-nowhere';
  const host = await fakeHost({
    invoke: () => ({ status: { ok: true, error: undefined }, payload: new TextEncoder().encode('{"via":"tcp"}') }),
  });
  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: `${unsupported};${host.address}` });
  try {
    await startPlugin(plugin.client);
    const relayed = await invoke(plugin.client, 'probes.relay', '{"operation":"orders.get"}');
    assert.deepEqual(payloadOf(relayed), { via: 'tcp' });
    assert.equal(logged(plugin.logs, 'warning', 'no supported callback endpoint'), 0);
  } finally {
    await plugin.close();
    host.close();
  }

  // 本平台的本地端点排在 tcp 前面时取它：Windows 上的命名管道、其他系统上的 Unix 域套接字
  const directory = mkdtempSync(join(tmpdir(), 'xihan-host-'));
  const local = windows ? `\\\\.\\pipe\\xihan-host-${process.pid}` : join(directory, 'host.sock');
  const localHost = await fakeHost(
    {
      invoke: () => ({ status: { ok: true, error: undefined }, payload: new TextEncoder().encode('{"via":"local"}') }),
    },
    `unix:${local}`,
  );
  const preferred = await launch(
    {},
    { XIHAN_PLUGIN_HOST_ADDRESS: `${windows ? 'npipe' : 'unix'} ${local};tcp 127.0.0.1:1` },
  );
  try {
    await startPlugin(preferred.client);
    assert.deepEqual(payloadOf(await invoke(preferred.client, 'probes.relay', '{"operation":"orders.get"}')), {
      via: 'local',
    });
  } finally {
    await preferred.close();
    localHost.close();
    rmSync(directory, { recursive: true, force: true });
  }

  for (const address of [undefined, '', 'unix /tmp/a;', 'tcp 10.0.0.1:50123', unsupported]) {
    const plugin = await launch({}, address === undefined ? {} : { XIHAN_PLUGIN_HOST_ADDRESS: address });
    try {
      assert.equal(logged(plugin.logs, 'warning', 'no supported callback endpoint'), 1, String(address));
      await startPlugin(plugin.client);
      assertFailure(
        (await invoke(plugin.client, 'probes.relay', '{"operation":"orders.get"}')).status,
        PluginErrorCode.Unavailable,
        PluginMessageKey.HostUnavailable,
        { id: pluginId, reason: 'no supported callback endpoint' },
        String(address),
      );
      const published = payloadOf(await invoke(plugin.client, 'probes.publish', '{"tenants":[null,null]}'));
      const failure = {
        code: PluginErrorCode.Unavailable,
        key: PluginMessageKey.HostUnavailable,
        details: { id: pluginId, reason: 'no supported callback endpoint' },
      };
      assert.deepEqual(published, [failure, failure]);
    } finally {
      await plugin.close();
    }
  }
});

test('回调带会话令牌与调用上下文的元数据：traceparent、七位小数的截止时间、已登记的 Baggage、空的 trace_state，gRPC 截止时间相同（invocation.md §5）', async () => {
  const host = await fakeHost({
    invoke: () => ({ status: { ok: true, error: undefined }, payload: new TextEncoder().encode('{"id":"o-1"}') }),
  });
  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  try {
    await startPlugin(plugin.client);
    const deadline = Date.now() + 60_000;
    const relayed = await invoke(plugin.client, 'probes.relay', '{"operation":"orders.get"}', {
      traceParent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      traceState: 'vendor=1',
      deadline: formatDeadline(deadline),
      baggage: new Map([
        [BaggageKey.Tenant, 't1'],
        [BaggageKey.Correlation, 'c1'],
        ['xihan.unregistered', 'x'],
      ]),
    });
    assert.equal(relayed.status?.ok, true, JSON.stringify(relayed.status));
    assert.deepEqual(payloadOf(relayed), { id: 'o-1' });
    const [received] = host.received;
    assert.deepEqual(received?.session, [token]);
    const request = received?.request as pb.InvokeRequest;
    assert.equal(request.operation, 'orders.get');
    assert.equal(new TextDecoder().decode(request.payload), '{"x":1}');
    assert.match(request.metadata?.traceParent ?? '', /^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/);
    assert.equal(request.metadata?.traceState, '');
    assert.equal(request.metadata?.deadline, formatDeadline(deadline));
    assert.match(request.metadata?.deadline ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}\+00:00$/);
    assert.deepEqual(
      request.metadata?.baggage,
      new Map([
        [BaggageKey.Correlation, 'c1'],
        [BaggageKey.Tenant, 't1'],
      ]),
    );
    const grpcDeadline = received?.deadline;
    const grpcMilliseconds = grpcDeadline instanceof Date ? grpcDeadline.getTime() : Number(grpcDeadline);
    assert.ok(Math.abs(grpcMilliseconds - deadline) < 50, `${grpcMilliseconds} ${deadline}`);
  } finally {
    await plugin.close();
    host.close();
  }
});

test('回调的本地核对按宿主的顺序：权限要声明且授予，租户要属于在途调用；Host.Publish 整批，信封的 xihantenant 交给宿主（invocation.md §5）', async () => {
  const host = await fakeHost({});
  // 清单没有声明权限：宿主授予了也不放行
  const undeclared = JSON.stringify({ ...manifestObject, permissions: undefined });
  const cases: [Partial<PluginOptions>, readonly string[]][] = [
    [{ manifest: undeclared }, manifestObject.permissions],
    [{}, []],
  ];
  for (const [options, granted] of cases) {
    const plugin = await launch(options, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
    try {
      await startPlugin(plugin.client, '{}', granted);
      assertFailure(
        (await invoke(plugin.client, 'probes.relay', '{"operation":"orders.get"}')).status,
        PluginErrorCode.CallbackDenied,
        PluginMessageKey.CallbackDenied,
        { id: pluginId, permission: CallbackPermission.Invoke },
      );
      const denied = {
        code: PluginErrorCode.CallbackDenied,
        key: PluginMessageKey.CallbackDenied,
        details: { id: pluginId, permission: CallbackPermission.Publish },
      };
      assert.deepEqual(payloadOf(await invoke(plugin.client, 'probes.publish', '{"tenants":[null,"t9"]}')), [
        denied,
        denied,
      ]);
    } finally {
      await plugin.close();
    }
  }
  assert.equal(host.received.length, 0, 'denied callbacks never reach the host');

  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  try {
    await startPlugin(plugin.client);
    await invoke(plugin.client, 'probes.context', '{}', { baggage: new Map([[BaggageKey.Tenant, 't1']]) });
    const context = plugin.probe.lastContext as InvocationContext;
    const callback = findHost(context);
    assert.ok(callback !== undefined);
    // 调用已经结束：宿主此刻没有把 t1 的调用交给插件
    const late = await callback.invoke(context, 'orders.get');
    assert.deepEqual(!late.outcome.ok && describeError(late.outcome.error), {
      code: PluginErrorCode.CallbackDenied,
      key: PluginMessageKey.TenantDenied,
      details: { id: pluginId, tenant: 't1' },
    });
    const other = await callback.invoke(context.withBaggage(BaggageKey.Tenant, 't2'), 'orders.get');
    assert.equal(!other.outcome.ok && other.outcome.error.messageKey, PluginMessageKey.TenantDenied);
    const lateBatch = await callback.publish(context, [{ topic: 'probe.events', id: '1', source: 's', type: 't' }]);
    assert.equal(!lateBatch[0]?.ok && lateBatch[0]?.error.messageKey, PluginMessageKey.TenantDenied);
    assert.deepEqual(await callback.publish(context, []), []);
    assert.equal(host.received.length, 0, 'denied callbacks never reach the host');

    // 信封的 xihantenant 不在本地核对：全部发给宿主逐项判定
    const published = await invoke(plugin.client, 'probes.publish', '{"tenants":["t1",null,"t9"]}', {
      baggage: new Map([[BaggageKey.Tenant, 't1']]),
    });
    assert.deepEqual(payloadOf(published), ['ok', 'ok', 'ok']);
    const publish = host.received.at(-1)?.request as pb.PublishRequest;
    assert.deepEqual(
      publish.envelopes.map((envelope) => [
        envelope.id,
        envelope.specVersion,
        envelope.extensions.get('xihantenant') ?? '',
      ]),
      [
        ['e-0', '1.0', 't1'],
        ['e-1', '1.0', ''],
        ['e-2', '1.0', 't9'],
      ],
    );
    assert.equal(publish.metadata?.baggage.get(BaggageKey.Tenant), 't1');
  } finally {
    await plugin.close();
    host.close();
  }
});

test('回调的 gRPC 失败经真实的调用按 callback-status.json 映射；Publish 的 RPC 失败与结果数不符每项同一个错误（invocation.md §5）', async () => {
  const vectors = vector<{ cases: CallbackCase[] }>('callback-status.json');
  let reply: { code: number; details: string } = { code: status.INTERNAL, details: '' };
  const host = await fakeHost({ invoke: () => reply, publish: () => reply });
  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  try {
    await startPlugin(plugin.client);
    // 调用方的取消无法从宿主一侧触发：只跑没有取消的用例，取消的用例由映射函数的回放覆盖
    for (const entry of vectors.cases.filter((item) => !item.contextCancelled)) {
      reply = { code: entry.statusCode, details: entry.message };
      const what = JSON.stringify(entry);
      // 向量里的插件 ID 与操作换成测试插件的
      const details =
        entry.details === null
          ? undefined
          : Object.fromEntries(
              Object.entries(entry.details).map(([name, value]) => [
                name,
                value === 'xihan.acme.echo' ? pluginId : value,
              ]),
            );
      if (entry.rpc === 'invoke') {
        const response = await invoke(plugin.client, 'probes.relay', '{"operation":"orders.create"}');
        assertFailure(response.status, entry.code, entry.key, details, what);
      } else {
        const published = payloadOf(await invoke(plugin.client, 'probes.publish', '{"tenants":[null,null]}'));
        const failure = { code: entry.code, key: entry.key, details: details ?? null };
        assert.deepEqual(published, [failure, failure], what);
      }
    }
  } finally {
    await plugin.close();
    host.close();
  }

  // 结果数与信封数不同
  const short = await fakeHost({ publish: () => ({ results: [{ ok: true, error: undefined }] }) });
  const counted = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: short.address });
  try {
    await startPlugin(counted.client);
    const failure = {
      code: PluginErrorCode.Unexpected,
      key: PluginMessageKey.Failed,
      details: { id: pluginId, phase: 'publish', reason: 'the host returned 1 results for 3 envelopes' },
    };
    assert.deepEqual(payloadOf(await invoke(counted.client, 'probes.publish', '{"tenants":[null,null,null]}')), [
      failure,
      failure,
      failure,
    ]);
  } finally {
    await counted.close();
    short.close();
  }

  // 连接失败按 Unavailable
  const unreachable = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: 'tcp 127.0.0.1:1' });
  try {
    await startPlugin(unreachable.client);
    const response = await invoke(unreachable.client, 'probes.relay', '{"operation":"orders.get"}');
    assert.equal(response.status?.error?.code, PluginErrorCode.Unavailable);
    assert.equal(response.status?.error?.messageKey, PluginMessageKey.HostUnavailable);
    assert.match(JSON.parse(response.status?.error?.details ?? '{}').reason, /^Unavailable: /);
  } finally {
    await unreachable.close();
  }
});

test('读入宿主写来的 Error：码不合文法换成 plugins.process.failed，键合文法按键、否则自由文本，details 与 inner 不合当作没有（invocation.md §3）', async () => {
  let error: pb.Error | undefined;
  let results: pb.Status[] | undefined;
  const host = await fakeHost({
    invoke: () => ({ status: { ok: false, error }, payload: new Uint8Array() }),
    publish: (request) => ({
      results: results ?? request.envelopes.map(() => ({ ok: false, error })),
    }),
  });
  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  const relay = async () => (await invoke(plugin.client, 'probes.relay', '{"operation":"orders.get"}')).status?.error;
  const protoError = (fields: Partial<pb.Error>): pb.Error => ({
    code: 'ORDERS_NOTFOUND_001',
    messageKey: '',
    text: '',
    details: '',
    inner: undefined,
    ...fields,
  });
  try {
    await startPlugin(plugin.client);
    error = protoError({ code: 'bad code', messageKey: 'orders.order.missing' });
    assert.deepEqual(await relay(), {
      code: PluginErrorCode.Unexpected,
      messageKey: PluginMessageKey.Failed,
      text: '',
      details: writeJson({ id: pluginId, phase: 'invoke', reason: "invalid error code 'bad code'" }),
      inner: undefined,
    });
    // 键合文法按键处理：宿主写来的文案不留，再写回宿主时 text 为空
    error = protoError({ messageKey: 'orders.order.missing', text: 'Missing.', details: '{"id":"o-2"}' });
    assert.deepEqual(await relay(), protoError({ messageKey: 'orders.order.missing', details: '{"id":"o-2"}' }));
    error = protoError({ messageKey: 'Not A Key', text: 'Missing.' });
    assert.deepEqual(await relay(), protoError({ text: 'Missing.' }));
    error = protoError({ messageKey: 'Not A Key' });
    assert.deepEqual(await relay(), protoError({ text: 'ORDERS_NOTFOUND_001' }));
    for (const details of ['[1]', '{"a":', '{"a":1,"a":2}', '"x"', '{}', '  ', '{"n":[1e400]}']) {
      error = protoError({ messageKey: 'orders.order.missing', details });
      assert.equal((await relay())?.details, '', details);
    }
    error = protoError({
      messageKey: 'orders.order.missing',
      inner: protoError({ code: 'nope', messageKey: 'orders.inner' }),
    });
    assert.deepEqual((await relay())?.inner, {
      code: PluginErrorCode.Unexpected,
      messageKey: PluginMessageKey.Failed,
      text: '',
      details: writeJson({ id: pluginId, phase: 'invoke', reason: "invalid error code 'nope'" }),
      inner: undefined,
    });
    // ok 为假却没有 error：phase 是操作 ID 或 publish
    error = undefined;
    assert.deepEqual(JSON.parse((await relay())?.details ?? ''), {
      id: pluginId,
      phase: 'orders.get',
      reason: 'the host reported a failure without an error',
    });
    results = [
      { ok: true, error: undefined },
      { ok: false, error: undefined },
    ];
    assert.deepEqual(payloadOf(await invoke(plugin.client, 'probes.publish', '{"tenants":[null,null]}')), [
      'ok',
      {
        code: PluginErrorCode.Unexpected,
        key: PluginMessageKey.Failed,
        details: { id: pluginId, phase: 'publish', reason: 'the host reported a failure without an error' },
      },
    ]);
  } finally {
    await plugin.close();
    host.close();
  }
});

/** error-reading.json 里线上 Error 的字段 */
interface VectorProtoError {
  readonly code: string;
  readonly message_key: string;
  readonly text: string;
  readonly details: string;
  readonly inner?: VectorProtoError;
}

/** error-reading.json 里读入后的错误 */
interface VectorDecoded {
  readonly code: string;
  readonly key: string | null;
  readonly text: string | null;
  readonly details: JsonObject | null;
  readonly inner: VectorDecoded | null;
}

/** 向量的线上 Error 换成协议消息 */
function toProto(error: VectorProtoError): pb.Error {
  return {
    code: error.code,
    messageKey: error.message_key,
    text: error.text,
    details: error.details,
    inner: error.inner === undefined ? undefined : toProto(error.inner),
  };
}

/** 细节按 JSON 值比较：各种数（number、bigint、Float64、JsonNumber）都换成 number */
function plainDetails(value: unknown): unknown {
  if (typeof value === 'bigint' || value instanceof Float64) {
    return Number(value instanceof Float64 ? value.value : value);
  }
  if (value instanceof JsonNumber) {
    return Number(value.text);
  }
  if (Array.isArray(value)) {
    return value.map(plainDetails);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, plainDetails(item)]));
  }
  return value;
}

/** 读入后的错误换成向量的形状 */
function decodedOf(error: ErrorInfo): VectorDecoded {
  return {
    code: error.code,
    key: error.messageKey ?? null,
    text: error.messageKey === undefined ? (error.text ?? null) : null,
    details: (plainDetails(error.details ?? null) ?? null) as JsonObject | null,
    inner: error.inner === undefined ? null : decodedOf(error.inner),
  };
}

test('读入宿主写来的 Error 遵循 error-reading.json：cases 与插件一侧的 statusWithoutError（invocation.md §3）', () => {
  const vectors = vector<{
    pluginId: string;
    cases: { name: string; error: VectorProtoError; expected: VectorDecoded }[];
    statusWithoutError: { reader: string; rpc?: string; operation?: string | null; expected: VectorDecoded }[];
  }>('error-reading.json');
  for (const entry of vectors.cases) {
    const decoded = decodedOf(fromProtoError(toProto(entry.error), vectors.pluginId));
    assert.deepEqual(decoded, plainDetails(entry.expected), entry.name);
  }
  // 宿主读插件的那几项不归 SDK：插件只读宿主写来的结果
  const pluginSide = vectors.statusWithoutError.filter((entry) => entry.reader === 'plugin');
  assert.equal(pluginSide.length, 2);
  for (const entry of pluginSide) {
    const phase = entry.rpc === 'publish' ? 'publish' : (entry.operation ?? '');
    for (const status of [{ ok: false, error: undefined }, undefined]) {
      // ok 为假却没有 error，整个 status 缺失也一样
      const read = fromStatus(status, vectors.pluginId, phase);
      assert.ok(!read.ok);
      assert.deepEqual(decodedOf(read.error), plainDetails(entry.expected), JSON.stringify(entry));
    }
  }
  // 读成的双精度写回时仍是浮点
  const underflow = fromProtoError(
    toProto(vectors.cases.find((entry) => entry.name.includes('下溢'))?.error as VectorProtoError),
    vectors.pluginId,
  );
  assert.equal(writeJson(underflow.details ?? {}), '{"id":"a","n":0.0}');
});

test('回调发出前依次核对：端点、权限、租户，最后截止时间已过或已被取消也不发请求，结果同映射表（invocation.md §5）', async () => {
  const host = await fakeHost({});
  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  try {
    await startPlugin(plugin.client);
    await invoke(plugin.client, 'probes.context');
    const callback = findHost(plugin.probe.lastContext as InvocationContext);
    assert.ok(callback !== undefined);
    const expired = InvocationContext.create({ deadline: Date.now() - 1000 });
    const controller = new AbortController();
    controller.abort();
    const cancelled = InvocationContext.create({ signal: controller.signal });
    const outcomeOf = async (context: InvocationContext) => {
      const response = await callback.invoke(context, 'orders.get');
      return !response.outcome.ok && describeError(response.outcome.error);
    };
    assert.deepEqual(await outcomeOf(expired), {
      code: 'KERNEL_TIMEOUT_001',
      key: 'kernel.invocation.deadline_exceeded',
      details: null,
    });
    assert.deepEqual(await outcomeOf(cancelled), {
      code: 'KERNEL_CANCELLED_001',
      key: 'kernel.invocation.cancelled',
      details: null,
    });
    const batch = await callback.publish(expired, [{ topic: 'probe.events', id: '1', source: 's', type: 't' }]);
    assert.equal(!batch[0]?.ok && batch[0]?.error.code, 'KERNEL_TIMEOUT_001');
    // 租户先于截止时间
    const foreign = await outcomeOf(expired.withBaggage(BaggageKey.Tenant, 't9'));
    assert.equal(foreign && (foreign as { key: string }).key, PluginMessageKey.TenantDenied);
    assert.equal(host.received.length, 0, 'nothing is sent');
  } finally {
    await plugin.close();
  }
  // 权限先于截止时间与取消
  const denied = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  try {
    await startPlugin(denied.client, '{}', []);
    await invoke(denied.client, 'probes.context');
    const callback = findHost(denied.probe.lastContext as InvocationContext);
    const response = await callback?.invoke(InvocationContext.create({ deadline: Date.now() - 1000 }), 'orders.get');
    assert.equal(
      response && !response.outcome.ok && response.outcome.error.messageKey,
      PluginMessageKey.CallbackDenied,
    );
  } finally {
    await denied.close();
    host.close();
  }
});

test('回调途中到了截止时间按 DeadlineExceeded、调用方取消按 Cancelled 映射，不另按时钟改写（invocation.md §5）', async () => {
  const host = await fakeHost({
    invoke: () =>
      delay(1000).then(() => ({ status: { ok: true, error: undefined }, payload: new TextEncoder().encode('{}') })),
  });
  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  try {
    await startPlugin(plugin.client);
    await invoke(plugin.client, 'probes.context');
    const callback = findHost(plugin.probe.lastContext as InvocationContext);
    assert.ok(callback !== undefined);
    const timedOut = await callback.invoke(InvocationContext.create({ timeout: 200 }), 'orders.get');
    assert.deepEqual(!timedOut.outcome.ok && describeError(timedOut.outcome.error), {
      code: 'KERNEL_TIMEOUT_001',
      key: 'kernel.invocation.deadline_exceeded',
      details: null,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const cancelled = await callback.invoke(
      InvocationContext.create({ signal: controller.signal, timeout: 30_000 }),
      'orders.get',
    );
    assert.deepEqual(!cancelled.outcome.ok && describeError(cancelled.outcome.error), {
      code: 'KERNEL_CANCELLED_001',
      key: 'kernel.invocation.cancelled',
      details: null,
    });
    assert.equal(host.received.length, 2, 'both callbacks were sent');
  } finally {
    await plugin.close();
    host.close();
  }
});

test('截止信号比墙上时钟先到时回调仍按 DeadlineExceeded：发出前与途中都看截止信号，不只读时钟（invocation.md §5）', async () => {
  const host = await fakeHost({
    invoke: () =>
      delay(1000).then(() => ({ status: { ok: true, error: undefined }, payload: new TextEncoder().encode('{}') })),
  });
  const plugin = await launch({}, { XIHAN_PLUGIN_HOST_ADDRESS: host.address });
  const realNow = Date.now;
  // 截止信号的定时器按单调时钟触发，墙上时钟可能还没到截止时间：创建上下文时让 Date.now 超前，
  // 截止时间就比定时器晚，确定地造出「信号已触发、时钟未到」的先后
  const createAhead = (lead: number, options: Parameters<typeof InvocationContext.create>[0]) => {
    Date.now = () => realNow() + lead;
    try {
      return InvocationContext.create(options);
    } finally {
      Date.now = realNow;
    }
  };
  try {
    await startPlugin(plugin.client);
    await invoke(plugin.client, 'probes.context');
    const callback = findHost(plugin.probe.lastContext as InvocationContext);
    assert.ok(callback !== undefined);
    const expected = { code: 'KERNEL_TIMEOUT_001', key: 'kernel.invocation.deadline_exceeded', details: null };
    // 发出前：信号已触发而墙上时钟离截止时间还有 1 秒，本地核对就按截止时间已过拒绝
    const signalled = createAhead(5000, { deadline: realNow() + 1000 });
    assert.ok(signalled.signal.aborted && !signalled.isExpired(Date.now()));
    const refused = await callback.invoke(signalled, 'orders.get');
    assert.deepEqual(!refused.outcome.ok && describeError(refused.outcome.error), expected);
    assert.equal(host.received.length, 0, 'nothing is sent');
    // 途中：信号在 200 毫秒触发，墙上时钟要到 300 毫秒才到截止时间，不能抢先取消回调
    const timedOut = await callback.invoke(createAhead(100, { timeout: 200 }), 'orders.get');
    assert.deepEqual(!timedOut.outcome.ok && describeError(timedOut.outcome.error), expected);
    assert.equal(host.received.length, 1, 'the callback was sent');
  } finally {
    Date.now = realNow;
    await plugin.close();
    host.close();
  }
});

// ── 端点、日志与目录 ──────────────────────────────────────────────────────────

test('缺省端点：Unix 套接字放在新建的私有目录里（0700 / 0600），Windows 用命名管道；地址不含空白（handshake.md §2、§4）', async () => {
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
    const handshaken = await startPlugin(plugin.client);
    assert.equal(handshaken.protocolVersion, 1);
  } finally {
    await plugin.close();
  }
  if (process.platform !== 'win32') {
    // 服务停止之后私有目录随之删除
    assert.throws(() => statSync(dirname(plugin.endpoint.address)), { code: 'ENOENT' });
    // 临时目录含空白时退到 /tmp：握手行的地址不能含空白
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = '/tmp/with space';
    try {
      const spaced = await launch({ network: defaultNetwork() });
      assert.match(spaced.endpoint.address, /^\/tmp\/xihan-plugin-[^/\s]+\/plugin\.sock$/);
      await spaced.close();
    } finally {
      if (previous === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previous;
      }
    }
  }
  // tcp 只写 127.0.0.1:<端口>
  const tcp = await launch({ network: 'tcp', address: '127.0.0.1:0' });
  assert.match(tcp.endpoint.address, /^127\.0\.0\.1:[1-9][0-9]*$/);
  await tcp.close();
});

test('回调抛出时 reason 是异常的简单类型名，不带文本（lifecycle.md §7.6）', () => {
  class OrdersUnavailable extends Error {}
  assert.equal(thrownTypeName(new TypeError('x')), 'TypeError');
  assert.equal(thrownTypeName(new OrdersUnavailable('x')), 'OrdersUnavailable');
  assert.equal(thrownTypeName(new FrameworkError('PROBES_VALIDATION_001', 'x')), 'FrameworkError');
  assert.equal(thrownTypeName(Object.create(null)), 'Object');
  assert.equal(thrownTypeName('text'), 'String');
  assert.equal(thrownTypeName(42), 'Number');
  assert.equal(thrownTypeName(null), 'null');
  assert.equal(thrownTypeName(undefined), 'undefined');
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

// ── 清单的读取、内置模板与启动时的核对 ─────────────────────────────────────────

/** 以给定的选项启动、预期被拒绝：不监听、不写握手行，返回抛出的错误与日志 */
async function refused(
  options: Partial<PluginOptions>,
  env: Record<string, string> = {},
  manifestFromFile = false,
): Promise<{ error: unknown; logs: string[] }> {
  const logs: string[] = [];
  const stdin = new PassThrough();
  let started = false;
  let error: unknown;
  try {
    await servePlugin({
      // 省略 manifest 时运行时读工作目录里的清单文件
      ...(manifestFromFile ? {} : { manifest }),
      network: 'tcp',
      stdin,
      stdout: {
        // 没有被拒绝、写出了握手行：关掉 stdin 让插件收尾，测试以断言失败结束而不是挂住
        write: () => {
          started = true;
          stdin.end();
          return true;
        },
      },
      logger: new PluginLogger({ write: (text: string) => logs.push(text) }),
      env: { XIHAN_PLUGIN_SESSION: token, ...env },
      exit: () => {},
      ...options,
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(!started, 'a refused start must not write the handshake line');
  assert.ok(error !== undefined, 'the start must be refused');
  return { error, logs };
}

test('清单按严格的 UTF-8 读，握手交出的原文与读出的清单出自同一段字节：坏字节拒绝启动，BOM 按字节跳过，文件不存在报路径（handshake.md §3 第 3 条）', async (t) => {
  const bytes = Buffer.from(manifest);
  // entry 的值里放一个坏字节：宽松的解码会把它换成 U+FFFD、照常握手，交给宿主的原文就与文件的字节不一致了
  const corrupted = Buffer.from(bytes);
  corrupted[bytes.lastIndexOf('probe')] = 0xff;
  const { error } = await refused({ manifest: corrupted });
  assert.ok(error instanceof FrameworkError, String(error));
  assert.equal(error.code, 'KERNEL_CAPABILITY_006');
  assert.equal(error.messageKey, 'kernel.manifest.invalid_json');
  assert.deepEqual(error.details, { reason: '$' });

  // 字节形式的清单开头的 BOM 按字节跳过，握手交出的原文不带它
  const plugin = await launch({ manifest: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) });
  try {
    assert.equal((await handshake(plugin.client)).manifest, manifest);
  } finally {
    await plugin.close();
  }

  // 省略 manifest 时读工作目录里的清单文件，与 readManifestSource 同一条路径：没有文件是清单读取的错误，不是文件系统的异常
  const directory = mkdtempSync(join(tmpdir(), 'xihan-plugin-manifest-'));
  const previous = process.cwd();
  t.after(() => {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  });
  process.chdir(directory);
  const missing = (await refused({}, {}, true)).error;
  assert.ok(missing instanceof FrameworkError, String(missing));
  assert.equal(missing.code, 'KERNEL_CAPABILITY_006');
  assert.equal(missing.messageKey, 'kernel.manifest.file_missing');
  writeFileSync(join(directory, 'xihan.manifest.json'), corrupted);
  const invalid = (await refused({}, {}, true)).error;
  assert.ok(
    invalid instanceof FrameworkError && invalid.messageKey === 'kernel.manifest.invalid_json',
    String(invalid),
  );
});

test('只导入 xihan-framework/plugin 就登记了运行时的 en-US 模板：plugins.* 的 error.message 是模板填入参数，不是「键 (参数)」', () => {
  const vectors = vector<{ messages: { code: string; key: string; arguments: string[]; template: string }[] }>(
    'plugin-messages.json',
  );
  // 另起一个进程：除了公开入口什么都不加载，登记只能来自导入 xihan-framework/plugin 的副作用
  const script = `
    import { PluginMessageKey } from 'xihan-framework/plugin';
    import { ErrorInfo } from 'xihan-framework/primitives';
    const messages = JSON.parse(process.argv[1]);
    const rendered = messages.map((entry) =>
      ErrorInfo.create(entry.code, entry.key, Object.fromEntries(entry.arguments.map((name) => [name, '<' + name + '>']))).message,
    );
    process.stdout.write(JSON.stringify({ keys: Object.values(PluginMessageKey).length, rendered }));
  `;
  const child = spawnSync(
    process.execPath,
    ['--conditions=xihan-source', '--input-type=module', '-e', script, JSON.stringify(vectors.messages)],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout) as { keys: number; rendered: string[] };
  assert.equal(output.keys, vectors.messages.length);
  for (const [index, entry] of vectors.messages.entries()) {
    const args = Object.fromEntries(entry.arguments.map((name) => [name, `<${name}>`]));
    assert.equal(output.rendered[index], formatMessage(entry.template, args), entry.key);
  }
  // 本进程也导入了插件入口：回调失败的错误读 message 就是文案
  assert.equal(
    hostUnavailable('xihan.tests.probe', 'no supported callback endpoint').message,
    "Plugin 'xihan.tests.probe' cannot reach the host: no supported callback endpoint",
  );
});

test('宿主的协议版本列表只作诊断：逐项是不带符号的十进制数，空项、小数与十六进制都记一条 warning；项两端的空白按 RFC-0001 的空白字符', async () => {
  const warning = 'the host did not pass a valid protocol version list';
  const space = String.fromCharCode(0x85);
  const cases: [string, number][] = [
    ['1', 0],
    ['1,2', 0],
    ['1, 2', 0],
    [`${space}1${space},2`, 0],
    // 空项以前被读成 0，整个列表当成合法的
    ['1,,2', 1],
    ['1,', 1],
    [',1', 1],
    ['', 1],
    [' ', 1],
    ['1,x', 1],
    ['+1', 1],
    ['-1', 1],
    ['1.0', 1],
    ['1e0', 1],
    ['0x1', 1],
    ['1 2', 1],
    ['4294967296', 1],
    // U+FEFF 不是规范的空白，trim 却会去掉它
    [`${String.fromCharCode(0xfeff)}1`, 1],
  ];
  for (const [versions, expected] of cases) {
    // 监听地址不合法：环境变量读完之后才拒绝启动，不必真的监听
    const { logs } = await refused({ address: '[::1]:0' }, { XIHAN_PLUGIN_PROTOCOL_VERSIONS: versions });
    assert.equal(logged(logs, 'warning', warning), expected, JSON.stringify(versions));
  }
  // 列表合法但没有本 SDK 支持的版本是另一条 warning
  const { logs } = await refused({ address: '[::1]:0' }, { XIHAN_PLUGIN_PROTOCOL_VERSIONS: '2,3' });
  assert.equal(logged(logs, 'warning', warning), 0);
  assert.equal(logged(logs, 'warning', 'the host supports no protocol version of this SDK'), 1);
});

test('未声明的健康项同一个名字只警告一次，记过的名字有上限：超出之后不再警告，集合不随回调报的名字增长（lifecycle.md §7.4）', async () => {
  let round = 0;
  const plugin = await launch({
    hooks: {
      health: () => {
        round += 1;
        // 每一轮都报一批没见过的名字，外加一个每轮都有的
        const items = Array.from({ length: 200 }, (_, index) => ({
          name: `undeclared-${round}-${index}`,
          status: HealthStatus.Healthy,
        }));
        return { state: LifecycleState.Ready, items: [{ name: 'again', status: HealthStatus.Healthy }, ...items] };
      },
    },
  });
  try {
    await startPlugin(plugin.client);
    const warned = () => logged(plugin.logs, 'warning', 'health item is not declared in contributes.health');
    assert.equal(warned(), 201, 'the first evaluation warns once per name');
    const reported = await health(plugin.client);
    assert.deepEqual(reported.items, [], 'undeclared items are never reported');
    assert.equal(warned(), 256, 'names are remembered up to the limit');
    await health(plugin.client);
    await health(plugin.client);
    assert.equal(warned(), 256, 'no more warnings and no more names once the limit is reached');
    assert.equal(plugin.logs.filter((line) => line.includes('"item":"again"')).length, 1);
  } finally {
    await plugin.close();
  }
});

test('事件处理器可以同步返回 Result：成功、失败与同步抛出都与返回 Promise 的处理器一样（invocation.md §4）', async () => {
  const plugin = await launch({
    subscriptions: [
      { topic: 'sync.ok', handler: () => Result.success() },
      {
        topic: 'sync.failing',
        handler: () => Result.fail(ErrorInfo.unavailable('PROBES_UNAVAILABLE_002', 'probes.store.down')),
      },
      {
        topic: 'sync.throwing',
        handler: () => {
          throw new TypeError('broken');
        },
      },
    ],
  });
  try {
    await startPlugin(plugin.client);
    assert.equal((await deliver(plugin.client, 'sync.ok', 'probe.happened', '')).status?.ok, true);
    assertFailure(
      (await deliver(plugin.client, 'sync.failing', 'probe.happened', '')).status,
      'PROBES_UNAVAILABLE_002',
      'probes.store.down',
      undefined,
    );
    assertFailure(
      (await deliver(plugin.client, 'sync.throwing', 'probe.happened', '')).status,
      'KERNEL_UNEXPECTED_001',
      'kernel.invocation.unhandled_exception',
      undefined,
    );
  } finally {
    await plugin.close();
  }
});

// ── 取消信号 ──────────────────────────────────────────────────────────────────

test('PluginOptions.signal：调用方的信号中止即按 stdin 关闭与 SIGTERM 同样收尾，servePlugin 的 Promise 随之完成（lifecycle.md §7.7）', async () => {
  const controller = new AbortController();
  const stops: string[] = [];
  const plugin = await launch({
    signal: controller.signal,
    hooks: {
      stop: (value) => {
        stops.push(value.reason);
        return Result.success();
      },
    },
  });
  await startPlugin(plugin.client);
  const waiting = invoke(plugin.client, 'probes.wait');
  await plugin.probe.waitStarted.wait;
  const began = Date.now();
  controller.abort();
  assertFailure((await waiting).status, 'KERNEL_CANCELLED_001', 'kernel.invocation.cancelled', undefined);
  assert.ok((plugin.probe.abortedAt ?? 0) - began < 500, 'in-flight calls are cancelled immediately');
  await plugin.served;
  assert.deepEqual(stops, ['shutdown']);
  assert.equal(logged(plugin.logs, 'information', 'abort signal received; stopping'), 1);
  await rejectsWith(invoke(plugin.client, 'probes.context'), status.UNAVAILABLE);
  plugin.client.close();

  // 启动之前就已中止的信号：握手行照写，随即收尾；没启动过，不调停止回调
  let early = 0;
  const aborted = await launch({
    signal: AbortSignal.abort(),
    hooks: {
      stop: () => {
        early += 1;
        return Result.success();
      },
    },
  });
  await aborted.served;
  assert.equal(early, 0);
  assert.equal(logged(aborted.logs, 'information', 'abort signal received; stopping'), 1);
  aborted.client.close();

  // 正常停止之后信号再中止什么也不做：监听已经摘掉
  const late = new AbortController();
  const stopped = await launch({ signal: late.signal });
  await startPlugin(stopped.client);
  assert.equal((await stop(stopped.client)).status?.ok, true);
  await stopped.served;
  late.abort();
  assert.equal(logged(stopped.logs, 'information', 'abort signal received; stopping'), 0);
  stopped.client.close();
});

test('configure 与 start 钩子收到 { signal }：宿主取消那次调用或运行时开始收尾时中止；不收参数的钩子照常工作', async () => {
  // 运行时开始收尾：正在执行的启动回调得到通知
  const seen: { configure?: AbortSignal; start?: AbortSignal } = {};
  const startEntered = gate();
  const plugin = await launch({
    hooks: {
      configure: (_configuration, { signal }) => {
        seen.configure = signal;
        return Result.success();
      },
      start: async ({ signal }) => {
        seen.start = signal;
        startEntered.open();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return Result.fail(ErrorInfo.cancelled('KERNEL_CANCELLED_001', 'kernel.invocation.cancelled'));
      },
    },
  });
  await handshake(plugin.client);
  assert.equal((await configure(plugin.client)).status?.ok, true);
  assert.ok(seen.configure instanceof AbortSignal && !seen.configure.aborted, 'a finished hook was never cancelled');
  const starting = start(plugin.client);
  await startEntered.wait;
  assert.ok(seen.start instanceof AbortSignal && !seen.start.aborted);
  plugin.stdin.end();
  assertFailure((await starting).status, 'KERNEL_CANCELLED_001', 'kernel.invocation.cancelled', undefined);
  assert.ok(seen.start.aborted);
  await plugin.served;
  plugin.client.close();

  // 宿主取消 Configure 调用：正在执行的配置回调得到通知
  const configureEntered = gate();
  const configureAborted = gate();
  const cancelled = await launch({
    hooks: {
      configure: async (_configuration, { signal }) => {
        configureEntered.open();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        configureAborted.open();
        return Result.success();
      },
    },
  });
  try {
    await handshake(cancelled.client);
    const call = cancelled.client.configure(
      pb.ConfigureRequest.fromPartial({ configuration: '{}', workDirectory: '.' }),
      sessionMetadata(),
      () => {},
    );
    await configureEntered.wait;
    call.cancel();
    await configureAborted.wait;
  } finally {
    await cancelled.close();
  }

  // 不收参数的钩子照常工作
  let started = 0;
  const plain = await launch({
    hooks: {
      configure: () => Result.success(),
      start: () => {
        started += 1;
        return Result.success();
      },
    },
  });
  try {
    await startPlugin(plain.client);
    assert.equal(started, 1);
  } finally {
    await plain.close();
  }
});
