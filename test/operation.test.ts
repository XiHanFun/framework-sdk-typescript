import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { InvocationContext, InvocationMessageKey } from 'xihan-framework/invocation';
import {
  BuiltInStep,
  defineContract,
  Expose,
  findDecodedRequest,
  findOperation,
  findOperationRequest,
  findOperationResponse,
  isOperationId,
  KernelOwner,
  type OperationContract,
  OperationErrorCode,
  OperationInvoker,
  OperationMessageKey,
  OperationRegistry,
  RequestDecodeError,
  RequestShape,
  type RequestShapeType,
} from 'xihan-framework/operation';
import { middleware, PipelineBuilder, PipelineErrorCode, Placement } from 'xihan-framework/pipeline';
import {
  BaggageKey,
  ErrorCode,
  ErrorInfo,
  Float64,
  FrameworkError,
  formatMessage,
  isPlainObject,
  JsonNumber,
  JsonPath,
  PipelineStage,
  Result,
  readJsonText,
  Stability,
} from 'xihan-framework/primitives';

interface CreateOrder {
  readonly quantity?: number;
}

interface OrderCreated {
  readonly id: string;
  readonly quantity: number;
}

/** 请求的形状：quantity 是可选的 32 位整数，没有给出时处理器按 0 处理 */
const createOrderShape = RequestShape.object({ quantity: RequestShape.int32() });

const createOrder = defineContract<CreateOrder, OrderCreated>({
  id: 'orders.create',
  stability: Stability.Stable,
  expose: [Expose.Http],
});

function newInvoker(builder?: PipelineBuilder): OperationInvoker {
  const registry = new OperationRegistry();
  registry.add({
    contract: createOrder,
    request: createOrderShape,
    handler: async (context, request) => {
      const quantity = request.quantity ?? 0;
      if (quantity <= 0) {
        return Result.fail(ErrorInfo.validation('ORDERS_VALIDATION_001', 'orders.quantity.invalid', { quantity }));
      }
      return Result.ok({ id: `o-${context.correlation ?? ''}`, quantity });
    },
    schema: { request: '{}', response: '{}' },
  });
  return new OperationInvoker(registry, builder);
}

function codeOf(outcome: Result<unknown>): string | undefined {
  return outcome.ok ? undefined : outcome.error.code;
}

function throwsCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof FrameworkError && error.code === code);
}

test('调用经过完整管道并编码响应', async () => {
  let seen: string | undefined;
  const builder = new PipelineBuilder().useAt(
    middleware('Observe', (context, next) => {
      seen = findOperation(context)?.contract.id;
      assert.equal(findOperationRequest(context)?.id, 'orders.create');
      return next(context);
    }),
    PipelineStage.Observe,
    Placement.End,
  );
  const invoker = newInvoker(builder);
  const context = InvocationContext.create({ baggage: { [BaggageKey.Correlation]: 'c1' } });

  const response = await invoker.invoke(context, { id: 'orders.create', payload: '{"quantity":2}' });
  assert.ok(response.outcome.ok);
  assert.equal(response.payload, '{"id":"o-c1","quantity":2}');
  assert.equal(seen, 'orders.create');
  assert.deepEqual(findOperationResponse(context), { id: 'o-c1', quantity: 2 });

  const failed = await invoker.invoke(InvocationContext.create(), { id: 'orders.create', payload: '{"quantity":0}' });
  assert.equal(codeOf(failed.outcome), 'ORDERS_VALIDATION_001');
  assert.equal(failed.payload, undefined);

  const missing = await invoker.invoke(InvocationContext.create(), { id: 'orders.missing' });
  assert.equal(codeOf(missing.outcome), OperationErrorCode.NotFound);
  assert.deepEqual(missing.outcome.ok ? undefined : missing.outcome.error.details, { id: 'orders.missing' });

  for (const payload of ['null', '[1]', '{', '{"quantity":"2"}']) {
    const invalid = await invoker.invoke(InvocationContext.create(), { id: 'orders.create', payload });
    assert.equal(codeOf(invalid.outcome), OperationErrorCode.InvalidPayload, `payload ${payload}`);
  }
  const empty = await invoker.invoke(InvocationContext.create(), { id: 'orders.create' });
  assert.equal(codeOf(empty.outcome), 'ORDERS_VALIDATION_001', 'an empty payload is {}');
  const zeroLength = await invoker.invoke(InvocationContext.create(), {
    id: 'orders.create',
    payload: new Uint8Array(),
  });
  assert.equal(codeOf(zeroLength.outcome), 'ORDERS_VALIDATION_001', 'a zero-length payload is {}');
  // 只有空白不是 JSON（RFC-0001「JSON 文本」）
  const blank = await invoker.invoke(InvocationContext.create(), { id: 'orders.create', payload: ' \n ' });
  assert.equal(codeOf(blank.outcome), OperationErrorCode.InvalidPayload, 'a blank payload is not JSON');
});

test('载荷不合法的细节：消息键、id 与只写结论的 reason', async () => {
  const invoker = newInvoker();
  const cases: [string | Uint8Array, string][] = [
    ['null', '$'],
    ['{"secret":', '$'],
    ['{"quantity":"2"}', '$.quantity'],
    [new Uint8Array([0x7b, 0xff, 0x7d]), '$'],
    [new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), '$'],
  ];
  for (const [payload, reason] of cases) {
    const response = await invoker.invoke(InvocationContext.create(), { id: 'orders.create', payload });
    assert.ok(!response.outcome.ok);
    const { error } = response.outcome;
    assert.equal(error.code, OperationErrorCode.InvalidPayload);
    assert.equal(error.messageKey, OperationMessageKey.InvalidPayload);
    assert.deepEqual(error.details, { id: 'orders.create', reason });
  }
  const bytes = await invoker.invoke(InvocationContext.create(), {
    id: 'orders.create',
    payload: new TextEncoder().encode('{"quantity":4}'),
  });
  assert.equal(bytes.payload, '{"id":"o-","quantity":4}');
});

test('类型化调用核对契约', async () => {
  const invoker = newInvoker();
  const context = InvocationContext.create({ baggage: { [BaggageKey.Correlation]: 'c2' } });
  const created = await invoker.invokeTyped(context, createOrder, { quantity: 3 });
  assert.ok(created.ok);
  assert.deepEqual(created.value, { id: 'o-c2', quantity: 3 });

  const impostor = defineContract<CreateOrder, string>({ id: 'orders.create', expose: [Expose.Http] });
  const mismatch = await invoker.invokeTyped(InvocationContext.create(), impostor, { quantity: 3 });
  assert.equal(codeOf(mismatch), OperationErrorCode.TypeMismatch);
  assert.ok(!mismatch.ok);
  assert.deepEqual(mismatch.error.details, { id: 'orders.create' });
  assert.equal(
    mismatch.error.message,
    "Operation 'orders.create' was invoked with request or response types that do not match its registration.",
  );

  const unknown = defineContract<CreateOrder, string>({ id: 'orders.unknown', expose: [] });
  assert.equal(
    codeOf(await invoker.invokeTyped(InvocationContext.create(), unknown, { quantity: 1 })),
    OperationErrorCode.NotFound,
  );

  const rejected = await invoker.invokeTyped(InvocationContext.create(), createOrder, { quantity: 0 });
  assert.equal(codeOf(rejected), 'ORDERS_VALIDATION_001');
});

test('同一个上下文上先后的调用互不串用终点与载荷', async () => {
  const invoker = newInvoker();
  const context = InvocationContext.create();
  assert.ok((await invoker.invokeTyped(context, createOrder, { quantity: 5 })).ok);
  const response = await invoker.invoke(context, { id: 'orders.create', payload: '{"quantity":6}' });
  assert.equal(response.payload, '{"id":"o-","quantity":6}');
  const failed = await invoker.invoke(context, { id: 'orders.create', payload: '{"quantity":0}' });
  assert.equal(failed.payload, undefined);
  assert.equal(findOperationResponse(context), undefined);
});

test('中间件的短路与派生上下文', async () => {
  const denied = ErrorInfo.denied('ORDERS_DENIED_001', 'orders.denied');
  const deny = new PipelineBuilder().useAt(
    middleware('Deny', async () => Result.fail(denied)),
    PipelineStage.Authorize,
  );
  const denying = newInvoker(deny);
  assert.equal(
    codeOf((await denying.invoke(InvocationContext.create(), { id: 'orders.create' })).outcome),
    'ORDERS_DENIED_001',
  );
  assert.equal(
    codeOf(await denying.invokeTyped(InvocationContext.create(), createOrder, { quantity: 1 })),
    'ORDERS_DENIED_001',
  );

  // 以成功短路：XGI 没有载荷，类型化调用没有响应可交
  const skip = new PipelineBuilder().useAt(
    middleware('Replay', async () => Result.success()),
    PipelineStage.Idempotency,
  );
  const skipping = newInvoker(skip);
  const skipped = await skipping.invoke(InvocationContext.create(), { id: 'orders.create', payload: '{"quantity":1}' });
  assert.ok(!skipped.outcome.ok);
  assert.equal(skipped.outcome.error.code, OperationErrorCode.Unexpected);
  assert.equal(skipped.outcome.error.messageKey, OperationMessageKey.NoResponse);
  assert.equal(skipped.outcome.error.message, "Operation 'orders.create' completed without producing a response.");
  assert.equal(skipped.payload, undefined);
  const typedSkip = await skipping.invokeTyped(InvocationContext.create(), createOrder, { quantity: 1 });
  assert.ok(!typedSkip.ok);
  assert.equal(typedSkip.error.code, OperationErrorCode.Unexpected);
  assert.equal(typedSkip.error.messageKey, OperationMessageKey.NoResponse);

  // 处理器拿到中间件派生的上下文
  const tenant = new PipelineBuilder().useAt(
    middleware('Correlate', (context, next) => next(context.withBaggage(BaggageKey.Correlation, 'derived'))),
    PipelineStage.Tenant,
  );
  const derived = await newInvoker(tenant).invoke(InvocationContext.create(), {
    id: 'orders.create',
    payload: '{"quantity":1}',
  });
  assert.equal(derived.payload, '{"id":"o-derived","quantity":1}');

  const cyclic = new PipelineBuilder()
    .useAt(
      middleware('A', (context, next) => next(context)),
      PipelineStage.Validate,
    )
    .useAt(
      middleware('B', (context, next) => next(context)),
      PipelineStage.Validate,
    )
    .before('A', 'B')
    .after('A', 'B');
  throwsCode(() => newInvoker(cyclic), PipelineErrorCode.Cycle);
});

test('管道结束之后才编码响应：数字按值模型写，写不出时是 unhandled_exception', async () => {
  const registry = new OperationRegistry();
  const contract = defineContract<{ readonly mode?: string | null }, unknown>({ id: 'numbers.get', expose: [] });
  registry.add({
    contract,
    request: RequestShape.object({ mode: RequestShape.string() }),
    handler: async (_context, request) => {
      switch (request.mode) {
        case 'nan':
          return Result.ok({ ratio: Number.NaN });
        case 'infinity':
          return Result.ok([new Float64(Number.NEGATIVE_INFINITY)]);
        case 'cycle': {
          const cycle: Record<string, unknown> = {};
          cycle.self = cycle;
          return Result.ok(cycle);
        }
        case 'framework':
          return Result.ok({
            toJSON: () => {
              throw new FrameworkError('NUMBERS_VALIDATION_001', 'The response cannot be written.');
            },
          });
        default:
          return Result.ok({ big: 9007199254740993n, two: new Float64(2), raw: new JsonNumber('1e400'), n: 2 });
      }
    },
  });
  // Egress 阶段的中间件看到的是编码之前的响应对象，载荷还没有写出
  const seen: unknown[] = [];
  const invoker = new OperationInvoker(
    registry,
    new PipelineBuilder().useAt(
      middleware('Inspect', async (context, next) => {
        const outcome = await next(context);
        seen.push(findOperationResponse(context));
        return outcome;
      }),
      PipelineStage.Egress,
    ),
  );
  const invoke = (mode?: string) =>
    invoker.invoke(InvocationContext.create(), {
      id: 'numbers.get',
      payload: mode === undefined ? '{}' : JSON.stringify({ mode }),
    });
  const written = await invoke();
  assert.ok(written.outcome.ok);
  assert.equal(written.payload, '{"big":9007199254740993,"two":2.0,"raw":1e400,"n":2}');
  assert.ok(seen.at(-1) !== undefined && typeof (seen.at(-1) as { big: unknown }).big === 'bigint');
  for (const mode of ['nan', 'infinity', 'cycle']) {
    const failed = await invoke(mode);
    assert.ok(!failed.outcome.ok, mode);
    assert.equal(failed.outcome.error.code, OperationErrorCode.Unexpected, mode);
    assert.equal(failed.outcome.error.messageKey, InvocationMessageKey.UnhandledException, mode);
    assert.equal(failed.outcome.error.inner, undefined, `${mode}: a serialization failure is not a framework error`);
    assert.equal(failed.payload, undefined, mode);
  }
  assert.ok(Number.isNaN((seen[1] as { ratio: number }).ratio), 'the middleware saw the response before encoding');
  const framework = await invoke('framework');
  assert.ok(!framework.outcome.ok);
  assert.equal(framework.outcome.error.inner?.code, 'NUMBERS_VALIDATION_001', 'a FrameworkError rides along as inner');
  // 类型化调用不编码：NaN 照常交给调用方
  const typed = await invoker.invokeTyped(InvocationContext.create(), contract, { mode: 'nan' });
  assert.ok(typed.ok && Number.isNaN((typed.value as { ratio: number }).ratio));
  // 不经管道执行时同样
  const descriptor = registry.find('numbers.get');
  assert.ok(descriptor);
  const direct = await descriptor.execute(InvocationContext.create(), '{"mode":"nan"}');
  assert.ok(!direct.outcome.ok);
  assert.equal(direct.outcome.error.messageKey, InvocationMessageKey.UnhandledException);
  assert.equal(direct.payload, undefined);
});

test('任意 JSON 的成员原样保留读到的值，写回时 JSON 值相等', async () => {
  const registry = new OperationRegistry();
  const contract = defineContract<unknown, unknown>({ id: 'echoes.create', expose: [] });
  registry.add({
    contract,
    request: RequestShape.object({ meta: RequestShape.json() }),
    handler: async (_context, request) => Result.ok((request as { meta: unknown }).meta),
  });
  const invoker = new OperationInvoker(registry);
  const meta =
    '{"big":1e400,"tiny":1e-400,"exact":9007199254740993,"beyond":123456789012345678901234567890,"two":2.0,"int":2,"precise":0.1000000000000000000001,"negativeZero":-0.0,"nested":[1E+17,{"x":null}]}';
  const response = await invoker.invoke(InvocationContext.create(), {
    id: 'echoes.create',
    payload: `{"meta":${meta}}`,
  });
  assert.ok(response.outcome.ok);
  // 数字照原文或按值模型写回：1e400 不是 null 也不是无穷，超出双精度的整数精确，2.0 仍是浮点
  assert.equal(response.payload, meta);
  const read = readJsonText(response.payload ?? '');
  const original = readJsonText(meta);
  assert.ok(read.ok && original.ok);
  assert.deepEqual(read.root, original.root, 'the JSON values are equal');
});

test('登记表拒绝重复、不合法的 ID 与契约', () => {
  const registry = new OperationRegistry();
  const handler = async () => Result.ok({});
  const request = RequestShape.object({});
  throwsCode(
    () => registry.add({ contract: { id: 'Orders.Create', stability: 'stable', expose: [] }, handler, request }),
    ErrorCode.InvalidArgument,
  );
  throwsCode(
    () => defineContract({ id: 'orders.create', expose: [], permission: 'p', policy: 'q' }),
    ErrorCode.InvalidArgument,
  );
  assert.throws(() => defineContract({ id: 'orders.create', expose: [], permission: 'p', policy: 'q' }), {
    message: "The operation 'orders.create' must declare either a permission or a policy.",
  });
  throwsCode(() => defineContract({ id: 'orders.create', expose: ['soap' as Expose] }), ErrorCode.InvalidArgument);
  throwsCode(
    () => defineContract({ id: 'orders.create', expose: [Expose.Http, Expose.Http] }),
    ErrorCode.InvalidArgument,
  );
  throwsCode(() => defineContract({ id: 'orders.create', expose: [], permission: '' }), ErrorCode.InvalidArgument);
  const contract = defineContract({ id: 'orders.create', expose: [] });
  assert.equal(contract.stability, Stability.Stable, 'stability defaults to stable');
  assert.ok(Object.isFrozen(contract) && Object.isFrozen(contract.expose));
  throwsCode(
    () => registry.add({ contract, handler, request, schema: { request: '[]', response: '{}' } }),
    ErrorCode.InvalidArgument,
  );
  throwsCode(() => registry.add({ contract, handler, request, owner: '' }), ErrorCode.InvalidArgument);
  throwsCode(() => registry.add({ contract, handler: undefined as never, request }), ErrorCode.InvalidArgument);
  throwsCode(() => registry.add({ contract, handler, request: (() => ({})) as never }), ErrorCode.InvalidArgument);
  assert.equal(registry.size, 0, 'rejected registrations are not kept');

  registry.add({ contract, handler, request });
  assert.throws(
    () => registry.add({ contract, handler, request }),
    (error: unknown) =>
      error instanceof FrameworkError &&
      error.code === OperationErrorCode.Duplicate &&
      error.message === "Operation 'orders.create' is already registered by 'app'." &&
      error.messageKey === OperationMessageKey.Duplicate,
  );
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.owner, 'app');
  assert.ok(isOperationId('order-lines.list'));
  assert.ok(!isOperationId('orders'));
  assert.ok(!isOperationId('orders.list-'));
});

test('登记表容量 10000，按 ID 升序列出', () => {
  assert.equal(OperationRegistry.capacity, 10_000);
  const registry = new OperationRegistry();
  const handler = async () => Result.ok({});
  const request = RequestShape.object({});
  for (let index = OperationRegistry.capacity - 1; index >= 0; index -= 1) {
    const contract: OperationContract = { id: `items${index}.list`, stability: Stability.Stable, expose: [] };
    registry.add({ contract, handler, request, owner: 'xihan.samples.bulk' });
  }
  assert.equal(registry.size, OperationRegistry.capacity);
  assert.throws(
    () => registry.add({ contract: { id: 'overflow.list', stability: 'stable', expose: [] }, handler, request }),
    (error: unknown) =>
      error instanceof FrameworkError &&
      error.code === OperationErrorCode.RegistryFull &&
      error.message === 'The operation registry has reached its capacity of 10000.' &&
      error.messageKey === OperationMessageKey.RegistryFull,
  );
  const ids = registry.list().map((descriptor) => descriptor.contract.id);
  assert.deepEqual(ids.slice(0, 3), ['items0.list', 'items1.list', 'items10.list']);
  assert.equal(registry.list()[0]?.owner, 'xihan.samples.bulk');
});

test('操作错误的码、键与参数与内核错误向量一致', async () => {
  const url = new URL('../spec/conformance/vectors/primitives/kernel-messages.json', import.meta.url);
  const { messages } = JSON.parse(readFileSync(url, 'utf8')) as {
    messages: { code: string; key: string; arguments: string[]; template: string }[];
  };
  const entry = (key: string) => {
    const found = messages.find((message) => message.key === key);
    assert.ok(found, `${key} is in the vector`);
    return found;
  };
  const pairs: [string, string][] = [
    [OperationErrorCode.NotFound, OperationMessageKey.NotFound],
    [OperationErrorCode.InvalidPayload, OperationMessageKey.InvalidPayload],
    [OperationErrorCode.TypeMismatch, OperationMessageKey.TypeMismatch],
    [OperationErrorCode.Unexpected, OperationMessageKey.NoResponse],
    [OperationErrorCode.Duplicate, OperationMessageKey.Duplicate],
    [OperationErrorCode.RegistryFull, OperationMessageKey.RegistryFull],
    [OperationErrorCode.Unexpected, InvocationMessageKey.UnhandledException],
  ];
  for (const [code, key] of pairs) {
    assert.equal(entry(key).code, code, key);
  }

  // 调用器产生的失败：参数名与向量一一对应，不配目录时消息是 en-US 模板填入参数
  const invoker = newInvoker();
  const failures = [
    (await invoker.invoke(InvocationContext.create(), { id: 'orders.missing' })).outcome,
    (await invoker.invoke(InvocationContext.create(), { id: 'orders.create', payload: 'null' })).outcome,
    await invoker.invokeTyped(
      InvocationContext.create(),
      defineContract<CreateOrder, OrderCreated>({ id: 'orders.create', expose: [] }),
      { quantity: 1 },
    ),
  ];
  for (const failure of failures) {
    assert.ok(!failure.ok);
    const { messageKey, details, message } = failure.error;
    const expected = entry(messageKey ?? '');
    assert.deepEqual(Object.keys(details ?? {}).sort(), [...expected.arguments].sort(), messageKey);
    assert.equal(message, formatMessage(expected.template, details), messageKey);
  }
});

test('抛出的异常翻译为失败：未处理的是 KERNEL_UNEXPECTED_001，中止按取消归因', async () => {
  const registry = new OperationRegistry();
  const contract = defineContract<{ readonly mode: string }, string>({ id: 'faults.raise', expose: [] });
  registry.add({
    contract,
    // 自定义形状：解码函数报告的路径照用
    request: RequestShape.custom((value, path) => {
      if (!isPlainObject(value) || typeof value.mode !== 'string') {
        throw new RequestDecodeError(JsonPath.member(path, 'mode'));
      }
      return { mode: value.mode };
    }),
    handler: async (context, request) => {
      switch (request.mode) {
        case 'framework':
          throw new FrameworkError('FAULTS_VALIDATION_001', 'The fault is configured wrong.');
        case 'abort':
          // 像 fetch 一样：信号中止后抛出它的原因
          await new Promise((resolve) => setTimeout(resolve, 30));
          context.signal.throwIfAborted();
          return Result.ok('late');
        default:
          throw new TypeError('secret detail that must not go on the wire');
      }
    },
  });
  const invoker = new OperationInvoker(registry);

  const plain = await invoker.invoke(InvocationContext.create(), { id: 'faults.raise', payload: '{"mode":"plain"}' });
  assert.ok(!plain.outcome.ok);
  assert.equal(plain.outcome.error.code, OperationErrorCode.Unexpected);
  assert.equal(plain.outcome.error.messageKey, InvocationMessageKey.UnhandledException);
  assert.equal(plain.outcome.error.message, 'An unhandled exception occurred during the invocation.');
  assert.equal(plain.outcome.error.inner, undefined, 'the exception message stays off the wire');
  assert.equal(plain.outcome.error.details, undefined, 'the unhandled exception error takes no arguments');
  assert.ok(!JSON.stringify(plain.outcome).includes('secret'));

  const framework = await invoker.invokeTyped(InvocationContext.create(), contract, { mode: 'framework' });
  assert.ok(!framework.ok);
  assert.equal(framework.error.code, OperationErrorCode.Unexpected);
  assert.equal(framework.error.inner?.code, 'FAULTS_VALIDATION_001', 'a FrameworkError rides along as the inner error');

  const caller = new AbortController();
  const pending = invoker.invoke(InvocationContext.create({ signal: caller.signal }), {
    id: 'faults.raise',
    payload: '{"mode":"abort"}',
  });
  caller.abort();
  const cancelled = await pending;
  assert.ok(!cancelled.outcome.ok);
  assert.equal(cancelled.outcome.error.code, 'KERNEL_CANCELLED_001');

  const timedOut = await invoker.invokeTyped(InvocationContext.create({ timeout: 5 }), contract, { mode: 'abort' });
  assert.ok(!timedOut.ok);
  assert.equal(timedOut.error.code, 'KERNEL_TIMEOUT_001');

  // 中间件抛出同样翻译
  const failing = new OperationInvoker(
    registry,
    new PipelineBuilder().useAt(
      middleware('Broken', async () => {
        throw new RangeError('boom');
      }),
      PipelineStage.Observe,
    ),
  );
  const broken = await failing.invoke(InvocationContext.create(), { id: 'faults.raise', payload: '{"mode":"plain"}' });
  assert.equal(codeOf(broken.outcome), OperationErrorCode.Unexpected);
  const decodeFailure = await invoker.invoke(InvocationContext.create(), { id: 'faults.raise', payload: '{"mode":1}' });
  assert.equal(decodeFailure.outcome.ok ? undefined : decodeFailure.outcome.error.details?.reason, '$.mode');
});

test('内置步骤的位置：只接住排在 Observe 内置步骤之后抛出的异常', async () => {
  const registry = new OperationRegistry();
  const contract = defineContract<Record<string, never>, string>({ id: 'faults.raise', expose: [] });
  registry.add({ contract, request: RequestShape.object({}), handler: async () => Result.ok('ok') });
  const throwing = (owner: string, stage: PipelineStage, placement: Placement) =>
    new OperationInvoker(
      registry,
      new PipelineBuilder().useAt(
        middleware('Broken', async () => {
          throw new RangeError('boom');
        }),
        stage,
        placement,
        owner,
      ),
    );
  // Ingress 阶段，与 Observe 阶段 Beginning 上归属排在 xihan.kernel.core 之前的：异常原样交给调用方
  for (const invoker of [
    throwing('app', PipelineStage.Ingress, Placement.End),
    throwing('app', PipelineStage.Observe, Placement.Beginning),
    throwing('xihan.a', PipelineStage.Observe, Placement.Beginning),
  ]) {
    await assert.rejects(invoker.invoke(InvocationContext.create(), { id: 'faults.raise' }), RangeError);
    await assert.rejects(invoker.invokeTyped(InvocationContext.create(), contract, {}), RangeError);
  }
  // 排在它之后的：翻译成 KERNEL_UNEXPECTED_001
  for (const invoker of [
    throwing('zeta.plugins', PipelineStage.Observe, Placement.Beginning),
    throwing('app', PipelineStage.Observe, Placement.End),
    throwing('app', PipelineStage.Handle, Placement.End),
  ]) {
    const response = await invoker.invoke(InvocationContext.create(), { id: 'faults.raise' });
    assert.equal(
      response.outcome.ok ? undefined : response.outcome.error.messageKey,
      'kernel.invocation.unhandled_exception',
    );
  }
  assert.equal(KernelOwner, 'xihan.kernel.core');
  assert.deepEqual(BuiltInStep, {
    Observe: 'ObserveMiddleware',
    Deadline: 'DeadlineMiddleware',
    Validation: 'ValidationMiddleware',
  });
  // 调用方的构建器不变；内置步骤可以作为约束的目标
  const seen: unknown[] = [];
  const builder = new PipelineBuilder()
    .useAt(
      middleware('Inspect', (context, next) => {
        seen.push(findDecodedRequest(context));
        return next(context);
      }),
      PipelineStage.Validate,
      Placement.Beginning,
    )
    .after('Inspect', BuiltInStep.Validation);
  const invoker = newInvoker(builder);
  assert.throws(() => builder.dump(), FrameworkError, 'the caller builder does not get the built-in steps');
  await invoker.invoke(InvocationContext.create(), { id: 'orders.create', payload: '{"quantity":2}' });
  await invoker.invokeTyped(InvocationContext.create(), createOrder, { quantity: 3 });
  assert.deepEqual(seen, [{ quantity: 2 }, { quantity: 3 }]);
  // 内置步骤同名的中间件是重复登记
  throwsCode(
    () =>
      newInvoker(
        new PipelineBuilder().useAt(
          middleware(BuiltInStep.Deadline, (c, n) => n(c)),
          PipelineStage.Handle,
        ),
      ),
    PipelineErrorCode.Registration,
  );
});

test('截止时间在 Resilience 阶段的内置步骤上核对，进入时不核对取消', async () => {
  const entered: string[] = [];
  const counting = (name: string) =>
    middleware(name, (context, next) => {
      entered.push(name);
      return next(context);
    });
  const builder = new PipelineBuilder()
    .useAt(counting('Ingress'), PipelineStage.Ingress)
    .useAt(counting('Observe'), PipelineStage.Observe)
    .useAt(counting('Authenticate'), PipelineStage.Authenticate);
  const invoker = newInvoker(builder);
  const late = InvocationContext.create({ deadline: Date.now() - 1 });
  const response = await invoker.invoke(late, { id: 'orders.create', payload: '{"quantity":1}' });
  assert.ok(!response.outcome.ok);
  assert.equal(response.outcome.error.code, 'KERNEL_TIMEOUT_001');
  assert.equal(response.outcome.error.messageKey, InvocationMessageKey.DeadlineBeforeStart);
  assert.equal(response.outcome.error.message, 'The invocation exceeded its deadline before it started.');
  const typed = await invoker.invokeTyped(late, createOrder, { quantity: 1 });
  assert.ok(!typed.ok);
  assert.equal(typed.error.messageKey, InvocationMessageKey.DeadlineBeforeStart);
  // Ingress 与 Observe 排在 Resilience 之前，照常执行；后面的阶段不执行
  assert.deepEqual(entered, ['Ingress', 'Observe', 'Ingress', 'Observe']);
  // 进管道前只核对未登记
  assert.equal(codeOf((await invoker.invoke(late, { id: 'orders.missing' })).outcome), OperationErrorCode.NotFound);
  // 截止时间先于解码：载荷不合法的调用在 Resilience 阶段就结束
  const invalid = await invoker.invoke(late, { id: 'orders.create', payload: '{' });
  assert.equal(
    invalid.outcome.ok ? undefined : invalid.outcome.error.messageKey,
    InvocationMessageKey.DeadlineBeforeStart,
  );
  // 还有时间的调用照常进管道
  entered.length = 0;
  const timely = await invoker.invoke(InvocationContext.create({ timeout: 1000 }), {
    id: 'orders.create',
    payload: '{"quantity":1}',
  });
  assert.ok(timely.outcome.ok);
  assert.deepEqual(entered, ['Ingress', 'Observe', 'Authenticate']);
  // 进入时不核对取消：已取消的调用照常执行，没有观察信号的处理器照常完成
  const cancelled = new AbortController();
  cancelled.abort();
  const running = await invoker.invoke(InvocationContext.create({ signal: cancelled.signal }), {
    id: 'orders.create',
    payload: '{"quantity":1}',
  });
  assert.ok(running.outcome.ok);
});

test('取消与截止时间只经信号通知，途中的取消在 Resilience 阶段归因', async () => {
  // 截止时间要留够余量，保证调用在它之前进入 Resilience 阶段：慢的 CI 上冷启动的第一次调用就要几毫秒，
  // 截止时间先到会以 deadline_before_start 结束，到不了处理器
  const deadline = 100;
  // 处理器等信号触发再往下走，截止时间一定在处理器执行途中到达，不靠固定的睡眠时长去赌
  const untilAborted = (signal: AbortSignal) =>
    signal.aborted
      ? Promise.resolve()
      : new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  const registry = new OperationRegistry();
  const contract = defineContract<{ readonly mode?: string | null }, string>({ id: 'slow.run', expose: [] });
  registry.add({
    contract,
    request: RequestShape.object({ mode: RequestShape.string() }),
    handler: async (context, request) => {
      await untilAborted(context.signal);
      switch (request.mode) {
        case 'written':
          // 把取消写成结果，不知道是哪个信号触发的
          return Result.fail(ErrorInfo.cancelled('KERNEL_CANCELLED_001', 'kernel.invocation.cancelled'));
        case 'thrown':
          context.signal.throwIfAborted();
          return Result.ok('late');
        default:
          // 不看信号的处理器照常返回
          return Result.ok('done');
      }
    },
  });
  // 排在 Resilience 之前的中间件看到的是结果，不是异常
  const observed: string[] = [];
  const invoker = new OperationInvoker(
    registry,
    new PipelineBuilder().useAt(
      middleware('Watch', async (context, next) => {
        try {
          const outcome = await next(context);
          observed.push(outcome.ok ? 'ok' : outcome.error.code);
          return outcome;
        } catch (error) {
          observed.push('thrown');
          throw error;
        }
      }),
      PipelineStage.Observe,
    ),
  );
  const run = (mode: string, options: Parameters<typeof InvocationContext.create>[0]) =>
    invoker.invoke(InvocationContext.create(options), { id: 'slow.run', payload: JSON.stringify({ mode }) });
  // 截止时间到了，处理器仍照常返回：调用以那个结果结束，不被强行中止
  const finished = await run('ignore', { timeout: deadline });
  assert.ok(finished.outcome.ok);
  assert.equal(finished.payload, '"done"');
  // 截止信号已触发时，写成结果的取消按超时报告
  const written = await run('written', { timeout: deadline });
  assert.equal(written.outcome.ok ? undefined : written.outcome.error.code, 'KERNEL_TIMEOUT_001');
  assert.equal(
    written.outcome.ok ? undefined : written.outcome.error.messageKey,
    'kernel.invocation.deadline_exceeded',
  );
  // 调用方取消、截止时间没到：写成结果的取消仍是取消
  const caller = new AbortController();
  const pending = run('written', { signal: caller.signal, timeout: 10_000 });
  caller.abort();
  assert.equal(((await pending).outcome as { error?: ErrorInfo }).error?.code, 'KERNEL_CANCELLED_001');
  // 抛出的中止在 Resilience 阶段就归因成结果
  const thrown = await run('thrown', { timeout: deadline });
  assert.equal(thrown.outcome.ok ? undefined : thrown.outcome.error.code, 'KERNEL_TIMEOUT_001');
  assert.deepEqual(observed, ['ok', 'KERNEL_TIMEOUT_001', 'KERNEL_CANCELLED_001', 'KERNEL_TIMEOUT_001']);
});

/** 向量的三个请求类型（payload-reasons.json 的 requests） */
const vectorShapes = {
  // 对象，成员值都是 32 位整数（整数字典）
  counts: RequestShape.record(RequestShape.int32()),
  // 对象：lines 是可选的数组，每项是对象，quantity 是可选的 32 位整数
  order: RequestShape.object({ lines: RequestShape.array(RequestShape.object({ quantity: RequestShape.int32() })) }),
  profile: RequestShape.object({
    name: RequestShape.required(RequestShape.string()),
    note: RequestShape.string(),
    count: RequestShape.int64(),
    ratio: RequestShape.float64(),
    flag: RequestShape.boolean(),
    tags: RequestShape.array(RequestShape.string()),
    scores: RequestShape.array(RequestShape.int64()),
    inner: RequestShape.object({ n: RequestShape.required(RequestShape.int64()) }),
    meta: RequestShape.json(),
  }),
};

test('载荷的解码遵循 payload-reasons.json', async () => {
  const url = new URL('../spec/conformance/vectors/operations/payload-reasons.json', import.meta.url);
  const vectors = JSON.parse(readFileSync(url, 'utf8')) as {
    requests: Record<keyof typeof vectorShapes, string>;
    cases: { name: string; request: keyof typeof vectorShapes; payload: string; reason: string | null }[];
  };
  assert.deepEqual(Object.keys(vectors.requests).sort(), Object.keys(vectorShapes).sort());
  const registry = new OperationRegistry();
  const decoded = new Map<string, unknown>();
  for (const [name, shape] of Object.entries(vectorShapes)) {
    registry.add({
      contract: defineContract<unknown, string>({ id: `${name}.update`, expose: [] }),
      request: shape,
      handler: async (_context, request) => {
        decoded.set(name, request);
        return Result.ok('ok');
      },
    });
  }
  const invoker = new OperationInvoker(registry);
  for (const c of vectors.cases) {
    // 载荷按 UTF-8 编码交给解码，与字符串入口结果相同
    for (const payload of [c.payload, new TextEncoder().encode(c.payload)]) {
      const response = await invoker.invoke(InvocationContext.create(), { id: `${c.request}.update`, payload });
      if (c.reason === null) {
        assert.ok(response.outcome.ok, c.name);
        assert.equal(response.payload, '"ok"');
      } else {
        assert.ok(!response.outcome.ok, c.name);
        assert.equal(response.outcome.error.code, OperationErrorCode.InvalidPayload, c.name);
        assert.equal(response.outcome.error.messageKey, OperationMessageKey.InvalidPayload, c.name);
        assert.deepEqual(response.outcome.error.details, { id: `${c.request}.update`, reason: c.reason }, c.name);
      }
    }
  }
});

test('按形状构建的请求', async () => {
  const registry = new OperationRegistry();
  const contract = defineContract<RequestShapeType<typeof vectorShapes.profile>, string>({
    id: 'profiles.update',
    expose: [],
  });
  let seen: unknown;
  registry.add({
    contract,
    request: vectorShapes.profile,
    handler: async (_context, request) => {
      seen = request;
      return Result.ok('ok');
    },
  });
  const invoker = new OperationInvoker(registry);
  const payload =
    '{"name":null,"x":1,"count":9223372036854775807,"ratio":5,"tags":["a",null],"scores":[1,-0],"inner":{"n":2},"meta":{"k":[1.0]},"flag":false}';
  assert.ok((await invoker.invoke(InvocationContext.create(), { id: 'profiles.update', payload })).outcome.ok);
  assert.deepEqual(seen, {
    name: null,
    count: 9223372036854775807n,
    ratio: 5,
    tags: ['a', null],
    scores: [1n, 0n],
    inner: { n: 2n },
    meta: { k: [new Float64(1)] },
    flag: false,
  });
  // 成员名 __proto__ 是普通成员
  const counts = new OperationRegistry();
  let record: unknown;
  counts.add({
    contract: defineContract<unknown, string>({ id: 'counts.update', expose: [] }),
    request: vectorShapes.counts,
    handler: async (_context, request) => {
      record = request;
      return Result.ok('ok');
    },
  });
  await new OperationInvoker(counts).invoke(InvocationContext.create(), {
    id: 'counts.update',
    payload: '{"__proto__":1,"2":2,"1":3}',
  });
  assert.ok(typeof record === 'object' && record !== null && Object.hasOwn(record, '__proto__'));
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  throwsCode(() => RequestShape.array(undefined as never), ErrorCode.InvalidArgument);
  throwsCode(() => RequestShape.object({ a: 1 as never }), ErrorCode.InvalidArgument);
  throwsCode(() => RequestShape.custom(undefined as never), ErrorCode.InvalidArgument);
});
