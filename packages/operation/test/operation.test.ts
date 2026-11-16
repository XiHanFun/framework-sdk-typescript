import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { InvocationContext, InvocationMessageKey } from '@xihan-framework/invocation';
import {
  defineContract,
  Expose,
  findOperation,
  findOperationRequest,
  findOperationResponsePayload,
  isOperationId,
  JsonPath,
  type OperationContract,
  OperationErrorCode,
  OperationInvoker,
  OperationMessageKey,
  OperationRegistry,
  RequestDecodeError,
} from '@xihan-framework/operation';
import { middleware, PipelineBuilder, PipelineErrorCode, Placement } from '@xihan-framework/pipeline';
import {
  BaggageKey,
  ErrorCode,
  ErrorInfo,
  FrameworkError,
  formatMessage,
  isPlainObject,
  type JsonValue,
  PipelineStage,
  Result,
  Stability,
} from '@xihan-framework/primitives';

interface CreateOrder {
  readonly quantity: number;
}

interface OrderCreated {
  readonly id: string;
  readonly quantity: number;
}

/** 手写解码器：与 Go 的 json.Unmarshal 一样，缺省字段取零值，类型不符时报路径 */
function decodeCreateOrder(value: JsonValue): CreateOrder {
  if (!isPlainObject(value)) {
    throw new RequestDecodeError('$', '$ must be an object');
  }
  const quantity = value.quantity ?? 0;
  if (typeof quantity !== 'number') {
    throw new RequestDecodeError('$.quantity', '$.quantity must be a number');
  }
  return { quantity };
}

const createOrder = defineContract<CreateOrder, OrderCreated>({
  id: 'orders.create',
  stability: Stability.Stable,
  expose: [Expose.Http],
});

function newInvoker(builder?: PipelineBuilder): OperationInvoker {
  const registry = new OperationRegistry();
  registry.add({
    contract: createOrder,
    decode: decodeCreateOrder,
    handler: async (context, request) => {
      if (request.quantity <= 0) {
        return Result.fail(
          ErrorInfo.validation('ORDERS_VALIDATION_001', 'orders.quantity.invalid', { quantity: request.quantity }),
        );
      }
      return Result.ok({ id: `o-${context.correlation ?? ''}`, quantity: request.quantity });
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
  assert.equal(findOperationResponsePayload(context), '{"id":"o-c1","quantity":2}');

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
  const blank = await invoker.invoke(InvocationContext.create(), { id: 'orders.create', payload: ' \n ' });
  assert.equal(codeOf(blank.outcome), 'ORDERS_VALIDATION_001', 'a blank payload is {}');
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
  assert.equal(findOperationResponsePayload(context), undefined);
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

test('响应无法编码为 JSON 时是 KERNEL_UNEXPECTED_001', async () => {
  const registry = new OperationRegistry();
  const contract = defineContract<Record<string, never>, { big: bigint }>({ id: 'numbers.get', expose: [] });
  registry.add({ contract, decode: () => ({}), handler: async () => Result.ok({ big: 1n }) });
  const descriptor = registry.find('numbers.get');
  assert.ok(descriptor);
  const response = await descriptor.execute(InvocationContext.create());
  assert.ok(!response.outcome.ok);
  assert.equal(response.outcome.error.code, 'KERNEL_UNEXPECTED_001');
  assert.match(response.outcome.error.message, /^The response of 'numbers\.get' could not be encoded: /);
});

test('登记表拒绝重复、不合法的 ID 与契约', () => {
  const registry = new OperationRegistry();
  const handler = async () => Result.ok({});
  const decode = () => ({});
  throwsCode(
    () => registry.add({ contract: { id: 'Orders.Create', stability: 'stable', expose: [] }, handler, decode }),
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
    () => registry.add({ contract, handler, decode, schema: { request: '[]', response: '{}' } }),
    ErrorCode.InvalidArgument,
  );
  throwsCode(() => registry.add({ contract, handler, decode, owner: '' }), ErrorCode.InvalidArgument);
  throwsCode(() => registry.add({ contract, handler: undefined as never, decode }), ErrorCode.InvalidArgument);
  assert.equal(registry.size, 0, 'rejected registrations are not kept');

  registry.add({ contract, handler, decode });
  assert.throws(
    () => registry.add({ contract, handler, decode }),
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
  const decode = () => ({});
  for (let index = OperationRegistry.capacity - 1; index >= 0; index -= 1) {
    const contract: OperationContract = { id: `items${index}.list`, stability: Stability.Stable, expose: [] };
    registry.add({ contract, handler, decode, owner: 'xihan.samples.bulk' });
  }
  assert.equal(registry.size, OperationRegistry.capacity);
  assert.throws(
    () => registry.add({ contract: { id: 'overflow.list', stability: 'stable', expose: [] }, handler, decode }),
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
  const url = new URL('../../../spec/conformance/vectors/primitives/kernel-messages.json', import.meta.url);
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
    decode: (value) => {
      if (!isPlainObject(value) || typeof value.mode !== 'string') {
        throw new RequestDecodeError('$.mode');
      }
      return { mode: value.mode };
    },
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
});

test('截止时间已过才开始的调用在第一个中间件之前结束', async () => {
  let entered = 0;
  const builder = new PipelineBuilder().useAt(
    middleware('Count', (context, next) => {
      entered += 1;
      return next(context);
    }),
    PipelineStage.Ingress,
  );
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
  assert.equal(entered, 0, 'the pipeline does not run');
  // 未登记的操作仍先报未登记
  assert.equal(codeOf((await invoker.invoke(late, { id: 'orders.missing' })).outcome), OperationErrorCode.NotFound);
  // 还有时间的调用照常进管道
  assert.ok(
    (
      await invoker.invoke(InvocationContext.create({ timeout: 1000 }), {
        id: 'orders.create',
        payload: '{"quantity":1}',
      })
    ).outcome.ok,
  );
  assert.equal(entered, 1);
});

/** 向量的整数字典：成员值都是整数 */
function decodeCounts(value: JsonValue): Record<string, number> {
  if (!isPlainObject(value)) {
    throw new RequestDecodeError(JsonPath.root);
  }
  const counts: Record<string, number> = {};
  for (const [name, count] of Object.entries(value)) {
    if (typeof count !== 'number' || !Number.isInteger(count)) {
      throw new RequestDecodeError(JsonPath.member(JsonPath.root, name));
    }
    counts[name] = count;
  }
  return counts;
}

/** 向量的订单：lines 是数组，每项是对象，quantity 是整数；缺少成员不算类型不符（规范不作规定） */
function decodeOrder(value: JsonValue): { readonly lines: readonly { readonly quantity: number }[] } {
  if (!isPlainObject(value)) {
    throw new RequestDecodeError(JsonPath.root);
  }
  const linesPath = JsonPath.member(JsonPath.root, 'lines');
  const lines = value.lines ?? [];
  if (!Array.isArray(lines)) {
    throw new RequestDecodeError(linesPath);
  }
  return {
    lines: lines.map((line, index) => {
      const linePath = JsonPath.index(linesPath, index);
      if (!isPlainObject(line)) {
        throw new RequestDecodeError(linePath);
      }
      const quantity = line.quantity ?? 0;
      if (typeof quantity !== 'number' || !Number.isInteger(quantity)) {
        throw new RequestDecodeError(JsonPath.member(linePath, 'quantity'));
      }
      return { quantity };
    }),
  };
}

test('载荷不合法的 reason 遵循 payload-reasons.json', async () => {
  const url = new URL('../../../spec/conformance/vectors/operations/payload-reasons.json', import.meta.url);
  const vectors = JSON.parse(readFileSync(url, 'utf8')) as {
    cases: { name: string; request: 'counts' | 'order'; payload: string; reason: string }[];
    syntaxErrors: { request: 'counts' | 'order'; payload: string }[];
  };
  const registry = new OperationRegistry();
  const contracts = {
    counts: defineContract<Record<string, number>, string>({ id: 'counts.update', expose: [] }),
    order: defineContract<{ readonly lines: readonly { readonly quantity: number }[] }, string>({
      id: 'orders.place',
      expose: [],
    }),
  };
  registry.add({ contract: contracts.counts, decode: decodeCounts, handler: async () => Result.ok('ok') });
  registry.add({ contract: contracts.order, decode: decodeOrder, handler: async () => Result.ok('ok') });
  const invoker = new OperationInvoker(registry);
  const reasonOf = async (request: 'counts' | 'order', payload: string) => {
    const response = await invoker.invoke(InvocationContext.create(), { id: contracts[request].id, payload });
    assert.ok(!response.outcome.ok, payload);
    assert.equal(response.outcome.error.code, OperationErrorCode.InvalidPayload);
    assert.equal(response.outcome.error.messageKey, OperationMessageKey.InvalidPayload);
    return response.outcome.error.details?.reason;
  };
  for (const c of vectors.cases) {
    assert.equal(await reasonOf(c.request, c.payload), c.reason, c.name);
  }
  for (const c of vectors.syntaxErrors) {
    const reason = await reasonOf(c.request, c.payload);
    assert.ok(typeof reason === 'string' && reason.startsWith('$'), `${c.payload} gives ${String(reason)}`);
  }
  // 合法的载荷照常执行
  const ok = await invoker.invoke(InvocationContext.create(), {
    id: 'orders.place',
    payload: '{"lines":[{"quantity":2}]}',
  });
  assert.equal(ok.payload, '"ok"');
});
