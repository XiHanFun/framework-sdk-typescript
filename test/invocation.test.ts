import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  cancellationOf,
  formatTraceParent,
  InvocationContext,
  InvocationErrorCode,
  InvocationMessageKey,
  ItemKey,
  isSpanId,
  isTraceId,
  newSpanId,
  newTraceId,
  parseTraceParent,
} from 'xihan-framework/invocation';
import { BaggageKey, ErrorCode, FrameworkError } from 'xihan-framework/primitives';

/** 等待信号中止；用一个会保持进程存活的定时器兜底，避免测试在定时器触发前退出 */
async function aborted(signal: AbortSignal, within = 2000): Promise<void> {
  if (signal.aborted) {
    return;
  }
  const keepAlive = setTimeout(() => {}, within);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the signal did not abort in time')), within);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  } finally {
    clearTimeout(keepAlive);
  }
}

function throwsInvalid(action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof FrameworkError && error.code === ErrorCode.InvalidArgument,
  );
}

test('新建时生成追踪、保留 Baggage', () => {
  const context = InvocationContext.create({ baggage: { [BaggageKey.Tenant]: 't1' } });
  assert.ok(isTraceId(context.traceId) && context.traceId.length === 32);
  assert.ok(isSpanId(context.spanId) && context.spanId.length === 16);
  assert.equal(context.tenant, 't1');
  assert.equal(context.principal, undefined);
  const derived = context.withBaggage(BaggageKey.Correlation, 'c1').withBaggage('xihan.feature-flag', 'on');
  assert.equal(derived.correlation, 'c1');
  assert.equal(context.correlation, undefined, 'derived baggage must not leak back');
  assert.equal(derived.findBaggage('xihan.feature-flag'), 'on');
  const stripped = derived.withoutUnregisteredBaggage();
  assert.equal(stripped.findBaggage('xihan.feature-flag'), undefined, 'unregistered keys are stripped');
  assert.equal(stripped.correlation, 'c1');
  assert.ok(Object.isFrozen(derived.baggage));

  const key = new ItemKey<number>('test.key');
  derived.setItem(key, 1);
  assert.equal(context.findItem(key), 1, 'items are shared between derived contexts');
  assert.equal(new ItemKey<number>('test.key').toString(), 'ItemKey(test.key)');
  assert.equal(context.findItem(new ItemKey<number>('test.key')), undefined, 'keys compare by identity');
  assert.ok(context.deleteItem(key) && !context.deleteItem(key));

  const parsed = parseTraceParent(context.traceParent);
  assert.deepEqual(parsed, { traceId: context.traceId, spanId: context.spanId, sampled: true });
  assert.ok(context.sampled && context.traceParent.endsWith('-01'), 'the root writes 01');
  assert.equal(derived.traceId, context.traceId);
  assert.equal(derived.signal, context.signal);
  assert.equal(context.cancellation, undefined, 'no error without cancellation');
  assert.ok(Object.isFrozen(context));
});

test('截止时间到点中止并翻译为 KERNEL_TIMEOUT_001', async () => {
  const context = InvocationContext.create({ timeout: 20 });
  assert.ok(context.hasDeadline);
  const remaining = context.remainingTime(Date.now());
  assert.ok(remaining !== undefined && remaining <= 20, `remaining ${remaining}`);
  await aborted(context.signal);
  const error = context.cancellation;
  assert.equal(error?.code, InvocationErrorCode.DeadlineExceeded);
  assert.equal(error?.messageKey, InvocationMessageKey.DeadlineExceeded);
  assert.equal(error?.kind, 'TIMEOUT');
  assert.equal((context.signal.reason as DOMException).name, 'TimeoutError', 'the raw abort reason is still available');
  assert.ok(context.isExpired(Date.now()));
  assert.equal(context.remainingTime(Date.now() + 1000), 0);
  assert.equal(InvocationContext.create().remainingTime(Date.now()), undefined);
  assert.ok(!InvocationContext.create().isExpired(Date.now()));
});

test('调用方取消翻译为 KERNEL_CANCELLED_001', async () => {
  const controller = new AbortController();
  const context = InvocationContext.create({ signal: controller.signal });
  assert.equal(cancellationOf(context.signal), undefined);
  controller.abort();
  await aborted(context.signal);
  assert.equal(context.cancellation?.code, InvocationErrorCode.Cancelled);
  assert.equal(context.cancellation?.messageKey, InvocationMessageKey.Cancelled);

  // 调用方先取消、截止时间还没到：报取消
  const caller = new AbortController();
  const withDeadline = InvocationContext.create({ signal: caller.signal, timeout: 1000 });
  caller.abort();
  assert.equal(withDeadline.cancellation?.code, InvocationErrorCode.Cancelled);
});

test('截止时间已触发即报超时，调用方同时取消也一样', async () => {
  const caller = new AbortController();
  const context = InvocationContext.create({ signal: caller.signal, timeout: 10 });
  await aborted(context.signal);
  caller.abort();
  assert.equal(context.cancellation?.code, InvocationErrorCode.DeadlineExceeded);

  // 调用方先取消，截止时间随后也到了：归因按截止信号，报超时（RFC-0004，ADR-0092）
  const early = new AbortController();
  const later = InvocationContext.create({ signal: early.signal, timeout: 15 });
  early.abort();
  assert.equal(later.cancellation?.code, InvocationErrorCode.Cancelled);
  await sleep(60);
  assert.equal(later.cancellation?.code, InvocationErrorCode.DeadlineExceeded);
});

test('截止时间的边界：已过期、超出定时器范围', async () => {
  const past = InvocationContext.create({ deadline: Date.now() - 1 });
  assert.ok(past.signal.aborted, 'a deadline in the past aborts at once');
  assert.equal(past.cancellation?.code, InvocationErrorCode.DeadlineExceeded);
  // 构造上下文时不判断开始前是否已过期（ADR-0235）：那由调用器在第一个中间件之前核对
  assert.equal(past.cancellation?.messageKey, InvocationMessageKey.DeadlineExceeded);
  assert.equal(past.cancellation?.message, 'The invocation exceeded its deadline.');

  // 超出定时器范围的截止时间不起定时器，调用期间不会到期，但按时钟仍可判断过期
  const far = Date.now() + 40 * 24 * 60 * 60 * 1000;
  const distant = InvocationContext.create({ deadline: far });
  await sleep(20);
  assert.ok(!distant.signal.aborted);
  assert.equal(distant.deadline, far);
  assert.ok(distant.isExpired(far));
  assert.equal(distant.cancellation, undefined);
});

test('W3C traceparent 的解析', () => {
  assert.ok(parseTraceParent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'));
  for (const bad of [
    '',
    '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331',
    '00-00000000000000000000000000000000-b7ad6b7169203331-01',
    '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01',
    '00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01',
  ]) {
    assert.equal(parseTraceParent(bad), undefined, `${bad} must not parse`);
  }
  const context = InvocationContext.create({
    traceParent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00',
  });
  assert.equal(context.traceId, '0af7651916cd43dd8448eb211c80319c');
  assert.equal(context.sampled, false, 'an unsampled upstream stays unsampled');
  assert.equal(context.traceParent, '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00');
  const ignored = InvocationContext.create({ traceParent: 'garbage' });
  assert.ok(isTraceId(ignored.traceId), 'an invalid traceparent is ignored');
  const explicit = InvocationContext.create({ trace: { traceId: newTraceId(), spanId: newSpanId(), sampled: false } });
  assert.equal(
    formatTraceParent({ traceId: explicit.traceId, spanId: explicit.spanId, sampled: explicit.sampled }),
    explicit.traceParent,
  );
  assert.ok(explicit.traceParent.endsWith('-00'));
  // 只给追踪不给采样位的创建方按上游已采样处理
  const given = InvocationContext.create({ trace: { traceId: newTraceId(), spanId: newSpanId() } });
  assert.ok(given.sampled && given.traceParent.endsWith('-01'));
});

test('traceparent 的解析与写出遵循向量：只认版本 00，标志只写采样位', () => {
  const url = new URL('../spec/conformance/vectors/primitives/trace-context.json', import.meta.url);
  const vectors = JSON.parse(readFileSync(url, 'utf8')) as {
    parse: { valid: { text: string; traceId: string; spanId: string; sampled: boolean }[]; invalid: string[] };
    format: { traceId: string; spanId: string; sampled: boolean | null; text: string }[];
  };
  for (const c of vectors.parse.valid) {
    assert.deepEqual(parseTraceParent(c.text), { traceId: c.traceId, spanId: c.spanId, sampled: c.sampled }, c.text);
    // 进上下文后只留采样位，写出 00 或 01
    const context = InvocationContext.create({ traceParent: c.text });
    assert.equal(context.traceId, c.traceId);
    assert.equal(context.spanId, c.spanId);
    assert.equal(context.traceParent, `00-${c.traceId}-${c.spanId}-${c.sampled ? '01' : '00'}`);
  }
  for (const text of vectors.parse.invalid) {
    assert.equal(parseTraceParent(text), undefined, `${JSON.stringify(text)} must not parse`);
    // 不合法的当作没有给出：生成新的追踪，作为根写出 01
    const context = InvocationContext.create({ traceParent: text });
    assert.ok(isTraceId(context.traceId) && !text.includes(context.traceId));
    assert.ok(context.traceParent.endsWith('-01'));
  }
  for (const c of vectors.format) {
    const trace =
      c.sampled === null
        ? { traceId: c.traceId, spanId: c.spanId }
        : { traceId: c.traceId, spanId: c.spanId, sampled: c.sampled };
    assert.equal(formatTraceParent(trace), c.text);
  }
  const root = InvocationContext.create();
  assert.ok(root.sampled && root.traceParent.endsWith('-01'), 'the root writes 01');
});

test('外部输入的 Baggage 丢弃不合的成员，程序内逐项派生给出不合的值是编程错误，幂等键除外', () => {
  const url = new URL('../spec/conformance/vectors/primitives/baggage-keys.json', import.meta.url);
  const { values } = JSON.parse(readFileSync(url, 'utf8')) as {
    values: { acceptable: string[]; unacceptable: string[] };
  };
  for (const value of values.acceptable) {
    assert.equal(InvocationContext.create({ baggage: { [BaggageKey.Tenant]: value } }).tenant, value);
    assert.equal(InvocationContext.create().withBaggage(BaggageKey.Correlation, value).correlation, value);
  }
  for (const value of values.unacceptable) {
    const context = InvocationContext.create({
      baggage: {
        [BaggageKey.Tenant]: value,
        [BaggageKey.Principal]: 'p1',
        [BaggageKey.IdempotencyKey]: value,
        'xihan.feature-flag': value,
      },
    });
    assert.equal(context.tenant, undefined, `${JSON.stringify(value)} is dropped`);
    assert.equal(context.principal, 'p1', 'the other members stay');
    assert.equal(context.idempotencyKey, value, 'the idempotency key is never dropped');
    assert.equal(context.findBaggage('xihan.feature-flag'), value, 'only registered keys are constrained');
    // 程序内逐项派生：抛出，不静默丢弃也不保留原值（ADR-0235）
    const origin = InvocationContext.create({ baggage: { [BaggageKey.Correlation]: 'c1' } });
    assert.throws(
      () => origin.withBaggage(BaggageKey.Correlation, value),
      (error: unknown) => error instanceof FrameworkError && error.code === ErrorCode.InvalidArgument,
    );
    assert.equal(origin.correlation, 'c1', 'the original context is untouched');
    assert.equal(
      origin.withBaggage(BaggageKey.IdempotencyKey, value).idempotencyKey,
      value,
      'the idempotency key is exempt',
    );
    assert.equal(origin.withBaggage('xihan.feature-flag', value).findBaggage('xihan.feature-flag'), value);
  }
});

test('不合法的 Baggage 键、追踪与互相冲突的选项是编程错误', () => {
  throwsInvalid(() => InvocationContext.create().withBaggage('tenant', 't1'));
  throwsInvalid(() => InvocationContext.create({ baggage: { 'xihan.Tenant': 't1' } }));
  throwsInvalid(() => InvocationContext.create({ baggage: { [BaggageKey.Tenant]: 1 as unknown as string } }));
  throwsInvalid(() => InvocationContext.create({ trace: { traceId: 'abc', spanId: newSpanId() } }));
  throwsInvalid(() => InvocationContext.create({ trace: { traceId: newTraceId(), spanId: '0000000000000000' } }));
  throwsInvalid(() => InvocationContext.create({ deadline: Date.now(), timeout: 1 }));
  throwsInvalid(() =>
    InvocationContext.create({ traceParent: '', trace: { traceId: newTraceId(), spanId: newSpanId() } }),
  );
  throwsInvalid(() => InvocationContext.create({ deadline: Number.NaN }));
});

test('把任意取消信号翻译成原语层错误', () => {
  assert.equal(cancellationOf(new AbortController().signal), undefined);
  assert.equal(cancellationOf(AbortSignal.abort())?.code, InvocationErrorCode.Cancelled);
  assert.equal(
    cancellationOf(AbortSignal.abort(new DOMException('late', 'TimeoutError')))?.code,
    InvocationErrorCode.DeadlineExceeded,
  );
  assert.equal(cancellationOf(AbortSignal.abort(new Error('boom')))?.code, InvocationErrorCode.Cancelled);
});

test('上下文的错误码与消息键与内核错误向量一致', () => {
  const url = new URL('../spec/conformance/vectors/primitives/kernel-messages.json', import.meta.url);
  const { messages } = JSON.parse(readFileSync(url, 'utf8')) as {
    messages: { code: string; key: string; arguments: string[]; template: string }[];
  };
  const expected = [
    [InvocationErrorCode.DeadlineExceeded, InvocationMessageKey.DeadlineExceeded],
    [InvocationErrorCode.DeadlineExceeded, InvocationMessageKey.DeadlineBeforeStart],
    [InvocationErrorCode.Cancelled, InvocationMessageKey.Cancelled],
  ];
  for (const [code, key] of expected) {
    const entry = messages.find((message) => message.key === key);
    assert.ok(entry, `${key} is in the vector`);
    assert.equal(entry.code, code);
    assert.deepEqual(entry.arguments, [], 'the invocation errors take no arguments');
  }
  // 没有配置目录时，错误的消息就是向量里的 en-US 模板
  const cancelled = cancellationOf(AbortSignal.abort());
  assert.equal(
    cancelled?.message,
    messages.find((message) => message.key === InvocationMessageKey.Cancelled)?.template,
  );
});

test('withSignal 派生的上下文在给出的信号或原上下文中止时都中止，共享截止时间、追踪、Baggage 与对象袋', () => {
  const caller = new AbortController();
  const extra = new AbortController();
  const context = InvocationContext.create({
    signal: caller.signal,
    deadline: Date.now() + 60_000,
    baggage: { [BaggageKey.Tenant]: 't1' },
  });
  const key = new ItemKey<string>('test.shared');
  context.setItem(key, 'before');
  const derived = context.withSignal(extra.signal);
  assert.notEqual(derived, context);
  assert.ok(Object.isFrozen(derived));
  assert.equal(derived.traceId, context.traceId);
  assert.equal(derived.spanId, context.spanId);
  assert.equal(derived.traceParent, context.traceParent);
  assert.equal(derived.deadline, context.deadline);
  assert.deepEqual(derived.baggage, { [BaggageKey.Tenant]: 't1' });
  // 对象袋是同一个
  assert.equal(derived.findItem(key), 'before');
  derived.setItem(key, 'after');
  assert.equal(context.findItem(key), 'after');

  // 给出的信号中止：派生的上下文中止，原上下文不受影响
  extra.abort();
  assert.ok(derived.signal.aborted);
  assert.equal(derived.cancellation?.code, InvocationErrorCode.Cancelled);
  assert.ok(!context.signal.aborted);
  assert.equal(context.cancellation, undefined);

  // 原上下文的调用方取消：派生的上下文也中止，取消只会收紧
  const other = context.withSignal(new AbortController().signal);
  assert.ok(!other.signal.aborted);
  caller.abort();
  assert.ok(context.signal.aborted && other.signal.aborted);
  assert.equal(other.cancellation?.code, InvocationErrorCode.Cancelled);
  // 派生可以接着派生，信号一路带下去
  assert.ok(other.withBaggage(BaggageKey.Correlation, 'c1').signal.aborted);

  // 已经中止的信号：派生出来就是中止的；以 TimeoutError 中止的按超时归因
  assert.ok(InvocationContext.create().withSignal(AbortSignal.abort()).signal.aborted);
  const timed = InvocationContext.create().withSignal(AbortSignal.abort(new DOMException('late', 'TimeoutError')));
  assert.equal(timed.cancellation?.code, InvocationErrorCode.DeadlineExceeded);
  // 截止时间照旧：截止信号已触发即报超时，给出的信号同时中止也一样
  const expired = InvocationContext.create({ deadline: Date.now() - 1 }).withSignal(AbortSignal.abort());
  assert.ok(expired.signal.aborted);
  assert.equal(expired.cancellation?.code, InvocationErrorCode.DeadlineExceeded);

  throwsInvalid(() => context.withSignal(undefined as unknown as AbortSignal));
  throwsInvalid(() => context.withSignal({ aborted: false } as unknown as AbortSignal));
});
