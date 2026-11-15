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
  isSampled,
  isSpanId,
  isTraceId,
  newSpanId,
  newTraceId,
  parseTraceParent,
} from '@xihan-framework/invocation';
import { BaggageKey, ErrorCode, FrameworkError } from '@xihan-framework/primitives';

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
  assert.deepEqual(parsed, { traceId: context.traceId, spanId: context.spanId, flags: 0x01 });
  assert.equal(context.traceFlags, undefined, 'a context without an upstream is the root');
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
  assert.equal(past.cancellation?.messageKey, InvocationMessageKey.DeadlineBeforeStart);
  assert.equal(past.cancellation?.message, 'The invocation exceeded its deadline before it started.');

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
    formatTraceParent({ traceId: explicit.traceId, spanId: explicit.spanId, flags: explicit.traceFlags }),
    explicit.traceParent,
  );
  assert.ok(explicit.traceParent.endsWith('-00'));
  // 只给追踪不给采样位的创建方按上游已采样处理
  const given = InvocationContext.create({ trace: { traceId: newTraceId(), spanId: newSpanId() } });
  assert.equal(given.traceFlags, 0x01);
});

test('trace-flags：只看最低位判断采样，其余位原样写出，根调用写 01', () => {
  const upstream = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331';
  const flagged = InvocationContext.create({ traceParent: `${upstream}-03` });
  assert.equal(flagged.traceFlags, 0x03);
  assert.ok(flagged.sampled);
  assert.equal(flagged.traceParent, `${upstream}-03`, 'the bits other than sampled are kept');
  const unsampled = InvocationContext.create({ traceParent: `${upstream}-02` });
  assert.ok(!unsampled.sampled);
  assert.equal(unsampled.withBaggage(BaggageKey.Tenant, 't1').traceParent, `${upstream}-02`);
  assert.equal(parseTraceParent(`ff-${upstream.slice(3)}-01`), undefined, 'version ff is invalid');
  assert.equal(
    formatTraceParent({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' }),
    `${upstream}-01`,
  );
  assert.ok(isSampled(undefined) && isSampled(0x01) && !isSampled(0x00) && !isSampled(0x02));
});

test('已登记键的值不合约束时在构造与派生上下文时丢弃，幂等键除外', () => {
  const url = new URL('../../../spec/conformance/vectors/primitives/baggage-keys.json', import.meta.url);
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
    // 派生时同样丢弃，原有的值也不留
    const derived = InvocationContext.create({ baggage: { [BaggageKey.Correlation]: 'c1' } }).withBaggage(
      BaggageKey.Correlation,
      value,
    );
    assert.equal(derived.correlation, undefined);
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
  const url = new URL('../../../spec/conformance/vectors/primitives/kernel-messages.json', import.meta.url);
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
