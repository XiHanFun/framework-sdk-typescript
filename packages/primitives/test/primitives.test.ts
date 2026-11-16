import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  BaggageKey,
  builtInMessages,
  builtInTemplates,
  canTransition,
  describe,
  ErrorCode,
  ErrorInfo,
  errorCodeDomain,
  errorCodeKind,
  Float64,
  FrameworkError,
  FrameworkInfo,
  formatMessage,
  formatValue,
  isBaggageKeyRegistered,
  isBaggageKeyWellFormed,
  isBaggageValueAcceptable,
  isErrorCode,
  isIntegerNumber,
  isLifecycleState,
  isLocaleName,
  isMessageKey,
  isPipelineStage,
  isServing,
  isStability,
  isTerminal,
  JsonMembers,
  type JsonNode,
  JsonNumber,
  LifecycleState,
  lifecycleStateFromOrdinal,
  lifecycleStateOrdinal,
  lifecycleStates,
  Maybe,
  MessageCatalog,
  maxBaggageValueLength,
  maxInt64,
  maxJsonDepth,
  messageKeyDomain,
  minInt64,
  numberSymbols,
  PipelineStage,
  PrimitivesMessageKey,
  parseJson,
  pipelineStageOrdinal,
  pipelineStages,
  placeholders,
  positional,
  quoteJsonString,
  Result,
  readJsonText,
  registeredBaggageKeys,
  Stability,
  setDefaultMessages,
  stabilities,
  stabilityOrdinal,
  type TypedId,
  toJsonValue,
  tryFormatMessage,
  typedId,
  validateErrorCode,
  writeJson,
} from '@xihan-framework/primitives';

/**
 * 直接读取规范子模块里的一致性向量，不复制向量文件
 *
 * @remarks
 * 用本 SDK 的 parseJson 读：向量里的数字按值模型（9007199254740993 是整数，2.0 与 -0.0 是浮点），JSON.parse 分不出
 */
function vector<T>(name: string): T {
  const url = new URL(`../../../spec/conformance/vectors/primitives/${name}`, import.meta.url);
  return parseJson(readFileSync(url)) as unknown as T;
}

/**
 * 把 JSON 值换成按值模型比较的形状：整数与浮点分开，整数按十进制文本精确比较，对象按成员名比较、不看顺序
 */
function modelOf(value: unknown): unknown {
  if (typeof value === 'number') {
    return isIntegerNumber(value) ? { integer: String(value) } : { float: value };
  }
  if (typeof value === 'bigint') {
    return value >= minInt64 && value <= maxInt64 ? { integer: value.toString() } : { float: Number(value) };
  }
  if (value instanceof Float64 || value instanceof JsonNumber) {
    return { float: value.value };
  }
  if (Array.isArray(value)) {
    return value.map(modelOf);
  }
  if (typeof value === 'object' && value !== null) {
    return new Map(Object.entries(value).map(([name, member]) => [name, modelOf(member)]));
  }
  return value;
}

/** 断言抛出带指定错误码的 FrameworkError */
function throwsCode(action: () => unknown, code: string): FrameworkError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof FrameworkError, `expected a FrameworkError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  return caught;
}

test('错误码遵循向量', () => {
  const vectors = vector<{ valid: string[]; invalid: string[] }>('error-codes.json');
  for (const code of vectors.valid) {
    assert.ok(isErrorCode(code), `${code} must be valid`);
    assert.equal(validateErrorCode(code), code);
  }
  for (const code of vectors.invalid) {
    assert.ok(!isErrorCode(code), `${code} must be invalid`);
    throwsCode(() => validateErrorCode(code), ErrorCode.InvalidArgument);
  }
  assert.equal(errorCodeKind('PERSISTENCE_CONFLICT_001'), 'CONFLICT');
  assert.equal(errorCodeDomain('PERSISTENCE_CONFLICT_001'), 'PERSISTENCE');
  assert.equal(errorCodeKind('bad'), undefined);
});

test('Baggage 键遵循向量', () => {
  const vectors = vector<{
    wellFormed: string[];
    illFormed: string[];
    registered: string[];
    values: { acceptable: string[]; unacceptable: string[] };
  }>('baggage-keys.json');
  for (const key of vectors.wellFormed) {
    assert.ok(isBaggageKeyWellFormed(key), `${key} must be well-formed`);
  }
  for (const key of vectors.illFormed) {
    assert.ok(!isBaggageKeyWellFormed(key), `${key} must be ill-formed`);
  }
  assert.deepEqual([...registeredBaggageKeys], vectors.registered);
  for (const key of vectors.registered) {
    assert.ok(isBaggageKeyRegistered(key));
  }
  assert.ok(!isBaggageKeyRegistered('xihan.feature-flag'));
  assert.equal(BaggageKey.IdempotencyKey, 'xihan.idempotency-key');
  assert.ok(Object.isFrozen(registeredBaggageKeys));
  // 已登记键的值的约束（ADR-0204、ADR-0233）
  for (const value of vectors.values.acceptable) {
    assert.ok(isBaggageValueAcceptable(value), `${JSON.stringify(value)} must be acceptable`);
  }
  for (const value of vectors.values.unacceptable) {
    assert.ok(!isBaggageValueAcceptable(value), `${JSON.stringify(value)} must be unacceptable`);
  }
  assert.equal(maxBaggageValueLength, 256);
});

test('生命周期迁移遵循向量', () => {
  const vectors = vector<{ allowed: [string, string][] }>('lifecycle-transitions.json');
  const allowed = new Set(vectors.allowed.map(([from, to]) => `${from}->${to}`));
  for (const [from, to] of vectors.allowed) {
    assert.ok(isLifecycleState(from), `unknown state ${from}`);
    assert.ok(isLifecycleState(to), `unknown state ${to}`);
    assert.ok(canTransition(from, to), `${from} -> ${to} must be allowed`);
  }
  for (const from of lifecycleStates) {
    for (const to of lifecycleStates) {
      if (canTransition(from, to)) {
        assert.ok(allowed.has(`${from}->${to}`), `${from} -> ${to} is allowed by the SDK but absent from the vector`);
      }
    }
  }
  assert.ok(isServing(LifecycleState.Ready) && isServing(LifecycleState.Degraded));
  assert.ok(!isServing(LifecycleState.Started));
  assert.ok(isTerminal(LifecycleState.Stopped) && !isTerminal(LifecycleState.Failed));
  // 序号与插件协议的枚举一致
  assert.equal(lifecycleStateOrdinal(LifecycleState.Declared), 0);
  assert.equal(lifecycleStateOrdinal(LifecycleState.Failed), 8);
  assert.equal(lifecycleStateFromOrdinal(4), LifecycleState.Ready);
  assert.equal(lifecycleStateFromOrdinal(9), undefined);
  assert.equal(lifecycleStateFromOrdinal(1.5), undefined);
  assert.ok(!isLifecycleState('ready'));
  assert.equal(JSON.stringify({ state: LifecycleState.Draining }), '{"state":"Draining"}');
});

test('管道阶段的名称与顺序', () => {
  const names = [
    'ingress',
    'observe',
    'resilience',
    'authenticate',
    'tenant',
    'authorize',
    'validate',
    'idempotency',
    'transaction',
    'handle',
    'egress',
  ];
  assert.deepEqual([...pipelineStages], names);
  names.forEach((name, index) => {
    assert.ok(isPipelineStage(name));
    assert.equal(pipelineStageOrdinal(name as PipelineStage), index);
  });
  assert.ok(!isPipelineStage('Handle'), 'stage names are lowercase');
  assert.equal(PipelineStage.Transaction, 'transaction');
});

test('错误工厂核对 KIND 段', () => {
  const error = ErrorInfo.validation('ORDERS_VALIDATION_001', 'orders.quantity.invalid', { min: 1 });
  assert.equal(error.kind, 'VALIDATION');
  assert.equal(error.domain, 'ORDERS');
  assert.equal(error.message, 'orders.quantity.invalid (min=1)');
  assert.equal(error.toString(), 'ORDERS_VALIDATION_001: orders.quantity.invalid (min=1)');
  const mismatch = throwsCode(
    () => ErrorInfo.notFound('ORDERS_VALIDATION_001', 'orders.missing'),
    ErrorCode.InvalidArgument,
  );
  assert.equal(mismatch.message, "The error code 'ORDERS_VALIDATION_001' must have the kind NOTFOUND.");
  assert.equal(
    throwsCode(() => ErrorInfo.create('bad', 'orders.missing'), ErrorCode.InvalidArgument).message,
    "The error code 'bad' must match <DOMAIN>_<KIND>_<NNN>.",
  );
  assert.equal(
    throwsCode(() => ErrorInfo.create('ORDERS_NOTFOUND_001', 'Orders'), ErrorCode.InvalidArgument).message,
    "The message key 'Orders' must match <domain>.<segment>[.<segment>].",
  );
  assert.equal(
    throwsCode(() => ErrorInfo.literal('ORDERS_NOTFOUND_001', ''), ErrorCode.InvalidArgument).message,
    'A literal error needs a text.',
  );
  for (const [factory, code] of [
    [ErrorInfo.conflict, 'ORDERS_CONFLICT_001'],
    [ErrorInfo.denied, 'ORDERS_DENIED_001'],
    [ErrorInfo.unavailable, 'ORDERS_UNAVAILABLE_001'],
    [ErrorInfo.timeout, 'ORDERS_TIMEOUT_001'],
    [ErrorInfo.cancelled, 'ORDERS_CANCELLED_001'],
  ] as const) {
    assert.equal(factory(code, 'orders.failed').code, code);
  }
  const inner = ErrorInfo.literal('KERNEL_UNEXPECTED_001', 'boom');
  assert.equal(ErrorInfo.unexpected('ORDERS_UNEXPECTED_001', 'orders.failed', undefined, inner).inner, inner);
});

test('错误的细节只收 JSON 值、冻结并按键排序', () => {
  const details = { b: 1, a: { d: [1, 'x'], c: null } };
  const error = ErrorInfo.create('ORDERS_VALIDATION_001', 'orders.invalid', details);
  details.b = 2;
  assert.equal(error.details?.b, 1, 'details are copied');
  assert.ok(Object.isFrozen(error.details) && Object.isFrozen(error.details?.a));
  assert.deepEqual(Object.keys(error.details ?? {}), ['a', 'b']);
  assert.equal(JSON.stringify(error.details), '{"a":{"c":null,"d":[1,"x"]},"b":1}');
  // 数字按值模型保留：bigint、Float64 与非有限的浮点都可以放进细节，线上写法见 writeJson（ADR-0236）
  const numbers = ErrorInfo.create('ORDERS_VALIDATION_001', 'orders.invalid', {
    big: 9007199254740993n,
    two: new Float64(2),
    nan: Number.NaN,
  });
  assert.equal(writeJson(numbers.details), '{"big":9007199254740993,"nan":"NaN","two":2.0}');
  for (const bad of [{ when: new Date(0) }, { f: () => 1 }, { u: undefined }, { s: Symbol('s') }]) {
    throwsCode(
      () => ErrorInfo.create('ORDERS_VALIDATION_001', 'orders.invalid', bad as never),
      ErrorCode.InvalidArgument,
    );
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  throwsCode(
    () => ErrorInfo.create('ORDERS_VALIDATION_001', 'orders.invalid', cycle as never),
    ErrorCode.InvalidArgument,
  );
  assert.ok(Object.isFrozen(error));
});

test('错误消息经进程默认目录解析', (t) => {
  setDefaultMessages(
    new MessageCatalog({
      'en-US': { 'orders.missing': 'Order {id} was not found.' },
      'zh-CN': { 'orders.missing': '订单 {id} 不存在。', 'orders.partial': '缺 {absent}' },
    }),
    'zh-CN',
  );
  t.after(() => setDefaultMessages(undefined, 'en-US'));
  const error = ErrorInfo.notFound('ORDERS_NOTFOUND_001', 'orders.missing', { id: 42 });
  assert.equal(error.message, '订单 42 不存在。');
  assert.equal(error.withText('literal').message, 'literal', 'text wins');
  assert.equal(error.withCode('ORDERS_NOTFOUND_002').message, '订单 42 不存在。');
  // 占位符缺值时目录解析失败，退回描述（RFC-0010）
  assert.equal(ErrorInfo.create('ORDERS_VALIDATION_001', 'orders.partial').message, 'orders.partial');
  assert.equal(formatMessage('{0} of {count:D3}', { 0: 'a', count: 7 }), 'a of 007');
  assert.equal(formatMessage('{missing}'), '{missing}', 'missing placeholders stay');
  assert.equal(formatMessage('{missing:N2}'), '{missing:N2}');
  throwsCode(() => setDefaultMessages(undefined, 'not a locale'), ErrorCode.InvalidArgument);
});

test('消息目录：区域不区分大小写、回退到 en-US', () => {
  const catalog = new MessageCatalog({
    'en-US': { 'orders.missing': 'Order {id} was not found.', 'orders.only_english': 'English {0}' },
    'zh-CN': { 'orders.missing': '订单 {id} 不存在。' },
  });
  assert.equal(catalog.resolve('orders.missing', 'ZH-cn', { id: 1 }), '订单 1 不存在。');
  assert.equal(catalog.resolve('orders.only_english', 'zh-CN', positional('x')), 'English x');
  assert.equal(catalog.resolve('orders.unknown', 'zh-CN', undefined), undefined);
  assert.equal(catalog.resolve('orders.missing', 'zh-CN', undefined), undefined, 'a missing argument fails');
  assert.equal(catalog.find('zh-CN', 'orders.only_english'), undefined, 'find does not fall back');
  throwsCode(() => new MessageCatalog({ 'en-US': { Bad: 'x' } }), ErrorCode.InvalidArgument);
  throwsCode(() => new MessageCatalog({ english: {} }), ErrorCode.InvalidArgument);
  throwsCode(() => new MessageCatalog({ 'en-US': {}, 'en-us': {} }), ErrorCode.InvalidArgument);
});

test('消息键、区域名与模板文法', () => {
  for (const key of ['kernel.feature.start_failed', 'tenant_members.list.description', 'a.b', 'a1.b_2']) {
    assert.ok(isMessageKey(key), `${key} must be valid`);
  }
  for (const key of ['', 'kernel', 'Kernel.x', 'kernel.', '.kernel', 'kernel..x', 'kernel.1x', '_a.b', 'kernel.x-y']) {
    assert.ok(!isMessageKey(key), `${key} must be invalid`);
  }
  assert.equal(messageKeyDomain('tenant_members.list.title'), 'tenant_members');
  assert.equal(messageKeyDomain('bad'), undefined);
  for (const name of ['en-US', 'zh-Hans-CN', 'es-419', 'de']) {
    assert.ok(isLocaleName(name), name);
  }
  for (const name of [
    '',
    'e',
    'en_US',
    'english',
    'en-',
    `en-${'a'.repeat(8)}-${'b'.repeat(8)}-${'c'.repeat(8)}-${'d'.repeat(8)}`,
  ]) {
    assert.ok(!isLocaleName(name), name);
  }
  assert.deepEqual(placeholders('{a} {0} {a:N2} {{b}} {bad name} {_x}'), ['a', '0']);
  assert.equal(formatMessage('{{literal}} {a} }} {', { a: 1 }), '{literal} 1 } {');
  assert.equal(
    formatMessage('{n:N2} {n:F1} {big:X} {big:x4} {neg:D4} {f:D}', { n: 1234.5, big: 255, neg: -7, f: 1.5 }),
    '1,234.50 1234.5 FF 00ff -0007 1.5',
  );
  assert.equal(
    formatMessage('{when:yyyy-MM-dd} {flag} {list} {nil}', { when: 'today', flag: true, list: [1, 2], nil: null }),
    'today true [1,2] ',
  );
  assert.equal(tryFormatMessage('{a} {b}', { a: 1 }), undefined);
  assert.equal(tryFormatMessage('{a}', { a: 1 }), '1');
  assert.equal(describe('orders.failed'), 'orders.failed');
  assert.equal(describe('orders.failed', { b: 2, a: 'x', skipped: undefined }), 'orders.failed (a=x, b=2)');
});

test('消息键、模板格式化与 Describe 遵循向量', () => {
  const vectors = vector<{
    keys: { valid: string[]; invalid: string[] };
    format: {
      name: string;
      template: string;
      arguments: Record<string, unknown> | null;
      locale?: string;
      lenient: string;
      strict: string | null;
    }[];
    describe: { key: string; arguments: Record<string, unknown> | null; text: string }[];
  }>('message-templates.json');
  for (const key of vectors.keys.valid) {
    assert.ok(isMessageKey(key), `${key} must be valid`);
  }
  for (const key of vectors.keys.invalid) {
    assert.ok(!isMessageKey(key), `${key} must be invalid`);
  }
  // 向量的 null 参数表示没有参数；参数值按值模型的原类型交给格式化，locale 只决定小数点与分组符
  for (const c of vectors.format) {
    const args = c.arguments ?? undefined;
    assert.equal(formatMessage(c.template, args, c.locale), c.lenient, `${c.name} (lenient)`);
    assert.equal(tryFormatMessage(c.template, args, c.locale), c.strict ?? undefined, `${c.name} (strict)`);
    // 消息目录按命中的区域取数字符号
    const locale = c.locale ?? 'en-US';
    const catalog = new MessageCatalog({ [locale]: { 'vectors.template': c.template } });
    assert.equal(catalog.resolve('vectors.template', locale, args), c.strict ?? undefined, `${c.name} (catalog)`);
  }
  for (const c of vectors.describe) {
    assert.equal(describe(c.key, c.arguments ?? undefined), c.text, c.key);
  }
});

test('自带的英文模板与内核错误向量逐字相同', () => {
  const vectors = vector<{ messages: { code: string; key: string; arguments: string[]; template: string }[] }>(
    'kernel-messages.json',
  );
  for (const entry of vectors.messages) {
    assert.equal(builtInTemplates[entry.key], entry.template, entry.key);
    assert.equal(builtInMessages.find('en-US', entry.key), entry.template);
    assert.deepEqual(placeholders(entry.template), entry.arguments, `${entry.key} placeholders`);
    // 没有进程默认目录时，错误的消息就是自带模板填入参数
    const args = Object.fromEntries(entry.arguments.map((name) => [name, `<${name}>`]));
    const error = ErrorInfo.create(entry.code, entry.key, args);
    assert.equal(error.message, formatMessage(entry.template, args), entry.key);
  }
  assert.equal(PrimitivesMessageKey.UninitializedResult, 'primitives.result.uninitialized');
  // 自带模板之外的键退回描述；进程默认目录优先于自带模板
  assert.equal(ErrorInfo.create('ORDERS_NOTFOUND_001', 'orders.missing', { id: 1 }).message, 'orders.missing (id=1)');
});

test('FrameworkError 可以带与宿主共用的消息键与参数', () => {
  const error = FrameworkError.fromMessage('KERNEL_OPERATION_001', 'kernel.operation.duplicate', {
    id: 'orders.create',
    owner: 'app',
  });
  assert.equal(error.message, "Operation 'orders.create' is already registered by 'app'.");
  assert.equal(error.messageKey, 'kernel.operation.duplicate');
  assert.deepEqual(error.details, { id: 'orders.create', owner: 'app' });
  const info = error.toErrorInfo();
  assert.equal(info.messageKey, 'kernel.operation.duplicate');
  assert.equal(info.text, error.message);
  assert.deepEqual(JSON.parse(JSON.stringify(info)), {
    code: 'KERNEL_OPERATION_001',
    message: "Operation 'orders.create' is already registered by 'app'.",
    messageKey: 'kernel.operation.duplicate',
    details: { id: 'orders.create', owner: 'app' },
  });
  assert.equal(FrameworkError.fromMessage('ORDERS_OPERATION_001', 'orders.unknown_key').message, 'orders.unknown_key');
});

test('错误的线上编码', () => {
  const inner = ErrorInfo.literal('KERNEL_UNEXPECTED_001', 'boom');
  const error = ErrorInfo.unexpected('ORDERS_UNEXPECTED_001', 'orders.failed', { id: 'o1' }, inner);
  const data = JSON.stringify(error);
  assert.equal(
    data,
    '{"code":"ORDERS_UNEXPECTED_001","message":"orders.failed (id=o1)","messageKey":"orders.failed","details":{"id":"o1"},"inner":{"code":"KERNEL_UNEXPECTED_001","message":"boom"}}',
  );
  const decoded = ErrorInfo.fromJSON(JSON.parse(data));
  assert.equal(decoded.code, 'ORDERS_UNEXPECTED_001');
  assert.equal(decoded.text, 'orders.failed (id=o1)');
  assert.equal(decoded.messageKey, 'orders.failed');
  assert.equal(decoded.inner?.code, 'KERNEL_UNEXPECTED_001');
  assert.deepEqual(decoded.details, { id: 'o1' });
  throwsCode(() => ErrorInfo.fromJSON({ code: 'bad' }), ErrorCode.InvalidArgument);
  throwsCode(() => ErrorInfo.fromJSON({ code: 'ORDERS_CONFLICT_001', message: 1 }), ErrorCode.InvalidArgument);
  throwsCode(() => ErrorInfo.fromJSON('ORDERS_CONFLICT_001'), ErrorCode.InvalidArgument);
  // 空的 details 省略
  assert.equal(
    JSON.stringify(ErrorInfo.create('ORDERS_CONFLICT_001', 'orders.stale', {})),
    '{"code":"ORDERS_CONFLICT_001","message":"orders.stale","messageKey":"orders.stale"}',
  );
  // 可选成员写成 null 不合法，message 必填
  throwsCode(
    () => ErrorInfo.fromJSON({ code: 'ORDERS_CONFLICT_001', message: 'x', details: null }),
    ErrorCode.InvalidArgument,
  );
  throwsCode(() => ErrorInfo.fromJSON({ code: 'ORDERS_CONFLICT_001' }), ErrorCode.InvalidArgument);
});

/** 线上编码向量的一条样例 */
interface WireCase {
  readonly name: string;
  readonly kind?: 'value' | 'unit' | 'maybe';
  readonly json: unknown;
  readonly canonical?: unknown;
}

/** 按样例的 kind 从 JSON 文本读出一条 Result 编码 */
function readResult(wire: WireCase, text: string): unknown {
  switch (wire.kind) {
    case 'unit':
      return Result.parse(text);
    case 'maybe':
      return Result.parseMaybe(text, (value) => value);
    default:
      return Result.parse(text, (value) => value);
  }
}

/** 按样例的 kind 从已解析的值读出一条 Result 编码 */
function readResultValue(wire: WireCase): unknown {
  switch (wire.kind) {
    case 'unit':
      return Result.fromJSON(wire.json);
    case 'maybe':
      return Result.fromJSONMaybe(wire.json, (value) => value);
    default:
      return Result.fromJSON(wire.json, (value) => value);
  }
}

test('Result 与 Error 的线上编码遵循向量', () => {
  const vectors = vector<{
    results: { valid: WireCase[]; invalid: WireCase[] };
    errors: { valid: WireCase[]; invalid: WireCase[] };
  }>('wire-encoding.json');
  // 合法样例读得出，再写出时按值模型等于规范形式：整数精确、整数值的浮点仍是浮点；不比较成员顺序
  for (const wire of vectors.results.valid) {
    const expected = modelOf(wire.canonical ?? wire.json);
    assert.deepEqual(modelOf(parseJson(writeJson(readResult(wire, writeJson(wire.json))))), expected, wire.name);
    assert.deepEqual(modelOf(parseJson(writeJson(readResultValue(wire)))), expected, `${wire.name} (value)`);
  }
  for (const wire of vectors.results.invalid) {
    throwsCode(() => readResult(wire, writeJson(wire.json)), ErrorCode.InvalidArgument);
    throwsCode(() => readResultValue(wire), ErrorCode.InvalidArgument);
  }
  for (const wire of vectors.errors.valid) {
    const expected = modelOf(wire.canonical ?? wire.json);
    assert.deepEqual(modelOf(parseJson(writeJson(ErrorInfo.parse(writeJson(wire.json))))), expected, wire.name);
    assert.deepEqual(modelOf(parseJson(writeJson(ErrorInfo.fromJSON(wire.json)))), expected, `${wire.name} (value)`);
  }
  for (const wire of vectors.errors.invalid) {
    for (const read of [() => ErrorInfo.parse(writeJson(wire.json)), () => ErrorInfo.fromJSON(wire.json)]) {
      assert.throws(
        read,
        (error: unknown) => error instanceof FrameworkError && error.code === ErrorCode.InvalidArgument,
        wire.name,
      );
    }
  }
});

test('Result 的线上编码与组合', () => {
  const ok = Result.ok({ id: 'o1' });
  assert.equal(JSON.stringify(ok), '{"ok":true,"value":{"id":"o1"}}');
  const failed = Result.fail<{ id: string }>(ErrorInfo.literal('ORDERS_CONFLICT_001', 'stale'));
  const data = JSON.stringify(failed);
  assert.equal(data, '{"ok":false,"error":{"code":"ORDERS_CONFLICT_001","message":"stale"}}');
  const decoded = Result.fromJSON(JSON.parse(data), (value) => value);
  assert.ok(!decoded.ok);
  assert.equal(decoded.ok ? undefined : decoded.error.code, 'ORDERS_CONFLICT_001');
  const value = Result.fromJSON({ ok: true, value: 5 }, (raw) => Number(raw));
  assert.equal(value.valueOr(0), 5);
  // 没有值的成功只写 {"ok":true}；带了 value 即不合法，{} 与 null 也一样（RFC-0001「Result」）
  assert.equal(JSON.stringify(Result.success()), '{"ok":true}');
  assert.ok(Result.fromJSON({ ok: true }).ok);
  throwsCode(() => Result.fromJSON({ ok: true, value: {} }), ErrorCode.InvalidArgument);
  // 值类型是 Maybe 的结果：null 即无值，写出时也是 null
  const none = Result.fromJSONMaybe({ ok: true, value: null }, (raw) => String(raw));
  assert.ok(none.ok && !none.value.hasValue);
  assert.equal(JSON.stringify(Result.ok(Maybe.none())), '{"ok":true,"value":null}');
  throwsCode(() => Result.fromJSON({ ok: true }, (raw) => raw), ErrorCode.InvalidArgument);
  throwsCode(() => Result.fromJSON({ ok: false }), ErrorCode.InvalidArgument);
  throwsCode(() => Result.fromJSON({ value: 1 }), ErrorCode.InvalidArgument);
  // 成功值不能为空
  throwsCode(() => Result.ok(null), ErrorCode.InvalidArgument);
  throwsCode(() => Result.ok(undefined), ErrorCode.InvalidArgument);
  throwsCode(() => Result.fail(undefined as never), ErrorCode.InvalidArgument);
  const doubled = Result.ok(21).map((n) => n * 2);
  assert.ok(doubled.ok && doubled.value === 42);
  assert.ok(!failed.bind(() => Result.ok(1)).ok, 'bind propagates failures');
  assert.equal(failed.map((v) => v.id).valueOr('none'), 'none');
  assert.equal(
    failed.match(
      () => 'ok',
      (error) => error.code,
    ),
    'ORDERS_CONFLICT_001',
  );
  assert.equal(throwsCode(() => failed.valueOrThrow(), 'ORDERS_CONFLICT_001').message, 'stale');
  assert.ok(ok.toVoid().ok && !failed.toVoid().ok);
  assert.equal(String(Result.ok(1)), 'Ok(1)');
  assert.equal(String(failed), 'Fail(ORDERS_CONFLICT_001: stale)');
  assert.ok(Object.isFrozen(ok));
});

test('Maybe 的线上编码与组合', () => {
  assert.equal(JSON.stringify(Maybe.some('x')), '"x"');
  assert.equal(JSON.stringify(Maybe.none()), 'null');
  assert.equal(
    JSON.stringify({ m: Maybe.some(ErrorInfo.literal('ORDERS_NOTFOUND_001', 'gone')) }),
    '{"m":{"code":"ORDERS_NOTFOUND_001","message":"gone"}}',
  );
  assert.ok(!Maybe.fromJSON(null, (value) => value).hasValue, 'null decodes to none');
  assert.equal(Maybe.fromJSON(5, (value) => Number(value)).valueOr(0), 5, 'value decodes to some');
  const none = Maybe.none<number>();
  assert.ok(!none.toResult(ErrorInfo.literal('ORDERS_NOTFOUND_001', 'missing')).ok, 'none to result is a failure');
  assert.equal(Maybe.some(2).toResult(ErrorInfo.literal('ORDERS_NOTFOUND_001', 'missing')).valueOr(0), 2);
  assert.ok(!Maybe.from(null).hasValue && !Maybe.from(undefined).hasValue && Maybe.from(0).hasValue);
  assert.equal(
    Maybe.some(2)
      .map((n) => n + 1)
      .valueOr(0),
    3,
  );
  assert.ok(!Maybe.some(2).map(() => null).hasValue);
  assert.ok(!none.bind((n) => Maybe.some(n)).hasValue);
  assert.equal(
    none.match(
      () => 'some',
      () => 'none',
    ),
    'none',
  );
  assert.equal(throwsCode(() => none.valueOrThrow(), ErrorCode.InvalidArgument).message, 'The maybe has no value.');
  throwsCode(() => Maybe.some(null), ErrorCode.InvalidArgument);
  const some = Maybe.from('x');
  assert.ok(some.hasValue && some.value === 'x');
});

test('类型化标识编码为底层值', () => {
  type OrderId = TypedId<'order'>;
  const id: OrderId = typedId<'order'>('o1');
  assert.equal(JSON.stringify({ id }), '{"id":"o1"}');
  const decoded: OrderId = typedId<'order'>(JSON.parse('"o1"') as string);
  assert.equal(decoded, id);
  assert.equal(JSON.stringify(typedId<'line', number>(7)), '7');
  throwsCode(() => typedId<'order', number>(Number.POSITIVE_INFINITY), ErrorCode.InvalidArgument);
});

test('稳定性的名字', () => {
  for (const name of ['stable', 'preview', 'experimental', 'internal', 'deprecated']) {
    assert.ok(isStability(name), name);
  }
  assert.ok(!isStability('Stable'));
  assert.deepEqual([...stabilities], ['stable', 'preview', 'experimental', 'internal', 'deprecated']);
  assert.equal(stabilityOrdinal(Stability.Experimental), 2);
  assert.equal(JSON.stringify(Stability.Experimental), '"experimental"');
});

test('框架信息与 FrameworkError', () => {
  assert.equal(FrameworkInfo.name, 'XiHan Framework');
  assert.equal(FrameworkInfo.specVersion, '1');
  assert.equal(FrameworkInfo.sdkName, 'framework-sdk-typescript');
  assert.equal(FrameworkInfo.sdkVersion, '0.1.0');
  const cause = new Error('io');
  const error = new FrameworkError('KERNEL_PIPELINE_001', 'The constraints form a cycle.', { cause });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'FrameworkError');
  assert.equal(error.cause, cause);
  const info = error.toErrorInfo();
  assert.equal(info.code, 'KERNEL_PIPELINE_001');
  assert.equal(info.message, 'The constraints form a cycle.');
  assert.equal(info.messageKey, undefined);
  assert.equal(new FrameworkError('bad', 'x').toErrorInfo().code, ErrorCode.InvalidArgument);
});

test('JSON 写不出的数值：非数、无穷与 bigint', () => {
  assert.equal(
    formatMessage('{a} {b} {c} {d}', {
      a: Number.NaN,
      b: Number.POSITIVE_INFINITY,
      c: Number.NEGATIVE_INFINITY,
      d: -0,
    }),
    'NaN Infinity -Infinity -0',
  );
  assert.equal(formatMessage('{n:F2} {n:N0}', { n: Number.NaN }), 'NaN NaN', 'F and N fall back to the plain text');
  assert.equal(
    formatMessage('{big} {big:D25} {big:N0} {big:X}', { big: 1234567890123456789n }),
    '1234567890123456789 0000001234567890123456789 1,234,567,890,123,456,789 112210F47DE98115',
  );
  // 超出 64 位的 bigint 与超出安全整数的 number 按值模型是浮点：不认 D，写成浮点的文本
  assert.equal(
    formatMessage('{big} {big:D} {unsafe} {unsafe:D}', { big: 12345678901234567890n, unsafe: 2 ** 60 }),
    '1.2345678901234567E+19 1.2345678901234567E+19 1.152921504606847E+18 1.152921504606847E+18',
  );
  // 数组、对象、Map、Set 与语言自己的类型
  assert.equal(
    formatMessage('{a} {m} {s} {d} {nested}', {
      a: [1, new Float64(2), undefined],
      m: new Map<unknown, unknown>([
        ['b', 1],
        [2, 'x'],
      ]),
      s: new Set(['x']),
      d: new Date(0),
      nested: { z: { y: [] }, a: null },
    }),
    '[1,2,null] {"2":"x","b":1} ["x"] 1970-01-01T00:00:00.000Z {"a":null,"z":{"y":[]}}',
  );
  let deep: unknown = [];
  for (let depth = 0; depth < 64; depth += 1) {
    deep = [deep];
  }
  assert.equal(
    formatMessage('{v}', { v: deep }),
    `${'['.repeat(64)}null${']'.repeat(64)}`,
    'containers deeper than 64 levels are null',
  );
  assert.equal(numberSymbols('FR-fr').group, String.fromCharCode(0x202f));
  assert.equal(numberSymbols('it-IT'), numberSymbols());
  assert.equal(formatValue(1234.5, 'N1', numberSymbols('de-DE')), '1.234,5');
  assert.equal(describe('orders.line.invalid', { z: -0, a: 1e-7 }), 'orders.line.invalid (a=1E-07, z=-0)');
});

test('任何一层的重复成员名都不合法（wire-encoding.json 的 duplicates）', () => {
  const { duplicates } = vector<{
    duplicates: { name: string; target: 'result' | 'error'; kind?: 'value' | 'unit'; text: string }[];
  }>('wire-encoding.json');
  for (const c of duplicates) {
    const read = () => {
      if (c.target === 'error') {
        return ErrorInfo.parse(c.text);
      }
      return c.kind === 'unit' ? Result.parse(c.text) : Result.parse(c.text, (value) => value);
    };
    throwsCode(read, ErrorCode.InvalidArgument);
  }
  // 从文本读取的合法样例与从值读取的结果相同
  assert.equal(Result.parse('{"ok":true}').ok, true);
  assert.equal(Result.parse('{"ok":true,"value":1}', Number).valueOr(0), 1);
  assert.ok(!Result.parseMaybe('{"ok":true,"value":null}', String).valueOrThrow().hasValue);
  assert.equal(ErrorInfo.parse('{"code":"KERNEL_UNEXPECTED_001","message":"x"}').text, 'x');
  throwsCode(() => Result.parse('{"ok":'), ErrorCode.InvalidArgument);
});

test('parseJson 拒绝同一个对象里的重复成员', () => {
  // 不同层、不同对象、数组里的同名成员都不算重复
  assert.deepEqual(parseJson('{"a":{"a":1},"b":[{"a":1},{"a":2}],"c":"\\"a\\""}'), {
    a: { a: 1 },
    b: [{ a: 1 }, { a: 2 }],
    c: '"a"',
  });
  assert.deepEqual(parseJson('[{}, "a", {"a": []}]'), [{}, 'a', { a: [] }]);
  assert.equal(parseJson('"{\\"a\\":1,\\"a\\":2}"'), '{"a":1,"a":2}', 'names inside strings are not members');
  for (const text of ['{"a":1,"a":2}', '{"x":{"b":1,"b":2}}', '[{"a":1,"a":1}]', '{"a":1,"\u0061":2}', '{"":1,"":2}']) {
    assert.throws(() => parseJson(text), FrameworkError, text);
  }
  assert.throws(() => parseJson('{,}'), { message: 'The text is not valid JSON.' });
  assert.throws(() => parseJson('{"x":[{"b":1,"b":2}]}'), {
    message: "The member at '$.x[0].b' appears more than once in the same JSON object.",
  });
  // __proto__ 是普通成员，不改原型
  const proto = parseJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  assert.ok(Object.hasOwn(proto, '__proto__') && Object.getPrototypeOf(proto) === Object.prototype);
});

test('JSON 文本的共同读取检查遵循 json-text.json', () => {
  const { cases } = vector<{
    cases: { name: string; text?: string; hex?: string; expect: 'valid' | 'syntax' | 'duplicate'; path?: string }[];
  }>('json-text.json');
  for (const c of cases) {
    // 文本按 UTF-8 编码交给读取；有文本时也按字符串读一遍，两种入口结果相同
    const inputs: (string | Uint8Array)[] =
      c.hex === undefined ? [new TextEncoder().encode(c.text ?? ''), c.text ?? ''] : [Buffer.from(c.hex, 'hex')];
    for (const input of inputs) {
      const read = readJsonText(input);
      const label = `${c.name} (${typeof input === 'string' ? 'string' : 'bytes'})`;
      if (c.expect === 'valid') {
        assert.ok(read.ok, label);
      } else {
        assert.deepEqual(read.ok ? undefined : read.problem, { kind: c.expect, path: c.path ?? '$' }, label);
      }
    }
  }
  // 字符串入口里的原始孤立代理项不是合法的 Unicode
  assert.equal(readJsonText(`"${String.fromCharCode(0xd800)}"`).ok, false);
  assert.equal(readJsonText(`"${String.fromCharCode(0xdc00)}"`).ok, false);
  assert.equal(maxJsonDepth, 64);
});

test('数字按值模型读写', () => {
  const read = readJsonText('[1,-0,-0.0,2.0,1e2,1.5,9007199254740993,9223372036854775808,1e400,1e-400]');
  assert.ok(read.ok);
  const [one, zero, negativeZero, two, hundred, half, big, beyond, infinity, tiny] = read.root as JsonNode[];
  assert.equal(one, 1);
  assert.ok(Object.is(zero, 0), 'the integer writing -0 is the integer 0');
  assert.ok(Object.is(negativeZero, -0));
  assert.deepEqual([two, hundred], [new Float64(2), new Float64(100)]);
  assert.equal(half, 1.5);
  assert.equal(big, 9007199254740993n);
  // 换成数值再写出会变的数字保留原文：值模型里是浮点
  assert.deepEqual(beyond, new JsonNumber('9223372036854775808'), 'beyond 64 bits is a float with its text');
  assert.equal(Number(beyond), 2 ** 63);
  assert.deepEqual(infinity, new JsonNumber('1e400'));
  assert.equal(Number(infinity), Number.POSITIVE_INFINITY);
  assert.deepEqual(tiny, new JsonNumber('1e-400'));
  assert.equal(Number(tiny), 0);
  assert.equal(writeJson(read.root), '[1,0,-0.0,2.0,100.0,1.5,9007199254740993,9223372036854775808,1e400,1e-400]');
  // 有效数字比双精度多的保留原文，能往返的照常读成数值
  const precise = readJsonText(
    '[0.1000000000000000000001,0.30000000000000004,1E+17,100000000000000000.0,123456789012345678901234567890]',
  );
  assert.ok(precise.ok);
  assert.deepEqual(precise.root, [
    new JsonNumber('0.1000000000000000000001'),
    0.30000000000000004,
    1e17,
    1e17,
    new JsonNumber('123456789012345678901234567890'),
  ]);
  assert.equal(formatMessage('{v} {v:F2}', { v: new JsonNumber('1e400') }), 'Infinity Infinity');
  assert.equal(formatMessage('{v}', { v: [new JsonNumber('9223372036854775808')] }), '[9.223372036854776E+18]');
  assert.throws(() => new JsonNumber('01'), FrameworkError);
  // 类型化的值写不出非有限的浮点（RFC-0011 规则 2），JsonNumber 照原文
  assert.throws(() => writeJson({ ratio: Number.NaN }, { nonFinite: 'reject' }), TypeError);
  assert.throws(() => writeJson([new Float64(Number.POSITIVE_INFINITY)], { nonFinite: 'reject' }), TypeError);
  assert.equal(writeJson([new JsonNumber('1e400')], { nonFinite: 'reject' }), '[1e400]');
  assert.throws(() => writeJson(undefined), TypeError);
  assert.equal(
    writeJson([1, -0, 2, new Float64(2), 1e16, 1e17, 0.1, 2n ** 63n, -(2n ** 63n), Number.NaN, -Infinity]),
    '[1,-0.0,2,2.0,10000000000000000.0,1E+17,0.1,9.223372036854776E+18,-9223372036854775808,"NaN","-Infinity"]',
  );
  // 按文档顺序：整数样式的键在普通对象里会被提到前面，JsonMembers 保留原顺序
  const ordered = readJsonText('{"b":1,"2":2,"1":3}');
  assert.ok(ordered.ok && ordered.root instanceof JsonMembers);
  assert.deepEqual(
    ordered.root.entries.map(([name]) => name),
    ['b', '2', '1'],
  );
  assert.equal(writeJson(ordered.root), '{"b":1,"2":2,"1":3}');
  assert.equal(Object.keys(toJsonValue(ordered.root) as object).join(), '1,2,b');
  assert.equal(Number(new Float64(2)) + 1, 3);
  // JSON 字符串只转义必须转义的字符
  const slash = '\\';
  const control = String.fromCharCode(8, 12, 10, 13, 9, 1, 0x1f, 0x7f, 0xd800);
  const expected = ['"q', slash, '"b', slash, slash, '/'];
  for (const short of ['b', 'f', 'n', 'r', 't', 'u0001', 'u001f']) {
    expected.push(slash, short);
  }
  expected.push(String.fromCharCode(0x7f), slash, 'ud800', 'é"');
  assert.equal(quoteJsonString(`q"b${slash}/${control}é`), expected.join(''));
  assert.equal(writeJson({ s: '😀' }), '{"s":"😀"}', 'paired surrogates stay as they are');
});
