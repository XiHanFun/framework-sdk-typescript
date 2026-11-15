import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { InvocationContext } from '@xihan-framework/invocation';
import {
  AppOwner,
  type Middleware,
  middleware,
  PipelineBuilder,
  PipelineErrorCode,
  Placement,
  parseStage,
} from '@xihan-framework/pipeline';
import { BaggageKey, ErrorCode, ErrorInfo, FrameworkError, PipelineStage, Result } from '@xihan-framework/primitives';

/** 记录进入与离开的中间件；进入下游前让出一次事件循环，核对异步链按顺序展开 */
function recording(name: string, log: string[]): Middleware {
  return middleware(name, async (context, next) => {
    log.push(`${name}:before`);
    await sleep(1);
    const outcome = await next(context);
    log.push(`${name}:after`);
    return outcome;
  });
}

const noop = (name: string): Middleware => middleware(name, (context, next) => next(context));

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof FrameworkError, `expected a FrameworkError, got ${String(error)}`);
    return error.code;
  }
}

test('顺序依次按阶段、位置、归属与登记顺序', async () => {
  const log: string[] = [];
  const builder = new PipelineBuilder()
    .useAt(recording('Egress', log), PipelineStage.Egress, Placement.End, 'app')
    .useAt(recording('ObserveLate', log), PipelineStage.Observe, Placement.End, 'xihan.b')
    .useAt(recording('ObserveEarly', log), PipelineStage.Observe, Placement.Beginning, 'xihan.z')
    .useAt(recording('ObserveA', log), PipelineStage.Observe, Placement.End, 'xihan.a')
    .use(recording('Transaction', log));
  assert.equal(
    builder.dump(),
    'observe      ObserveEarly\nobserve      ObserveA\nobserve      ObserveLate\ntransaction  Transaction\negress       Egress\n',
  );
  const step = builder.build(async () => {
    log.push('terminal');
    return Result.success();
  });
  const outcome = await step(InvocationContext.create());
  assert.ok(outcome.ok);
  assert.deepEqual(log, [
    'ObserveEarly:before',
    'ObserveA:before',
    'ObserveLate:before',
    'Transaction:before',
    'Egress:before',
    'terminal',
    'Egress:after',
    'Transaction:after',
    'ObserveLate:after',
    'ObserveA:after',
    'ObserveEarly:after',
  ]);
  const [first] = builder.describe();
  assert.deepEqual(first, {
    stage: 'observe',
    middleware: 'ObserveEarly',
    instance: undefined,
    owner: 'xihan.z',
    placement: 'Beginning',
    display: 'ObserveEarly',
  });
});

test('打印格式：阶段名占 12 列后空一格', () => {
  const builder = new PipelineBuilder()
    .useAt(noop('Auth'), PipelineStage.Authenticate)
    .useAt(noop('Deadline'), PipelineStage.Resilience, Placement.Beginning, 'xihan.kernel');
  assert.equal(builder.dump(), 'resilience   Deadline\nauthenticate Auth\n');
  assert.equal(new PipelineBuilder().dump(), '', 'an empty pipeline prints nothing');
  assert.equal(new PipelineBuilder().use(noop('A')).describe()[0]?.owner, AppOwner);
});

test('约束在阶段内调整顺序', () => {
  const builder = new PipelineBuilder()
    .useAt(noop('A'), PipelineStage.Validate, Placement.End, 'app')
    .useAt(noop('B'), PipelineStage.Validate, Placement.End, 'app')
    .useAt(noop('C'), PipelineStage.Validate, Placement.End, 'app')
    .before('C', 'A')
    .after('B', 'C');
  assert.deepEqual(
    builder.describe().map((descriptor) => descriptor.middleware),
    ['C', 'A', 'B'],
  );
  // 约束只调整必要的相对位置，其余保持基准次序
  const minimal = new PipelineBuilder()
    .useAt(noop('A'), PipelineStage.Validate)
    .useAt(noop('B'), PipelineStage.Validate)
    .useAt(noop('C'), PipelineStage.Validate)
    .useAt(noop('D'), PipelineStage.Validate)
    .after('A', 'C');
  assert.deepEqual(
    minimal.describe().map((descriptor) => descriptor.middleware),
    ['B', 'C', 'A', 'D'],
  );
});

test('拒绝成环与不合法的约束', () => {
  const cycle = new PipelineBuilder()
    .useAt(noop('A'), PipelineStage.Validate, Placement.End, 'app')
    .useAt(noop('B'), PipelineStage.Validate, Placement.End, 'app')
    .before('A', 'B')
    .before('B', 'A');
  assert.equal(
    codeOf(() => cycle.describe()),
    PipelineErrorCode.Cycle,
  );
  assert.throws(() => cycle.dump(), { message: "The ordering constraints in stage 'validate' form a cycle." });

  const unregistered = new PipelineBuilder().useAt(noop('A'), PipelineStage.Validate).before('A', 'Missing');
  assert.equal(
    codeOf(() => unregistered.describe()),
    PipelineErrorCode.Registration,
  );
  assert.throws(() => unregistered.describe(), {
    message: "The ordering constraint references the unregistered middleware 'Missing'.",
  });

  const crossStage = new PipelineBuilder()
    .useAt(noop('A'), PipelineStage.Validate)
    .useAt(noop('B'), PipelineStage.Egress)
    .before('A', 'B');
  assert.equal(
    codeOf(() => crossStage.describe()),
    PipelineErrorCode.Registration,
  );

  const duplicate = new PipelineBuilder()
    .useAt(noop('A'), PipelineStage.Validate)
    .useAt(noop('A'), PipelineStage.Validate);
  assert.equal(
    codeOf(() => duplicate.describe()),
    PipelineErrorCode.Registration,
  );
  assert.equal(
    codeOf(() => duplicate.build(async () => Result.success())),
    PipelineErrorCode.Registration,
  );

  assert.equal(
    codeOf(() => parseStage('middle')),
    PipelineErrorCode.UnknownStage,
  );
  assert.equal(parseStage('handle'), PipelineStage.Handle);
  assert.equal(
    codeOf(() => new PipelineBuilder().build(undefined as never)),
    PipelineErrorCode.Registration,
  );
});

test('登记时核对参数', () => {
  const builder = new PipelineBuilder();
  assert.equal(
    codeOf(() => builder.useAt(noop('A'), 'middle' as PipelineStage)),
    PipelineErrorCode.UnknownStage,
  );
  assert.equal(
    codeOf(() => builder.useAt(noop(''), PipelineStage.Validate)),
    ErrorCode.InvalidArgument,
  );
  assert.equal(
    codeOf(() => builder.useAt(noop('A'), PipelineStage.Validate, Placement.End, '')),
    ErrorCode.InvalidArgument,
  );
  assert.equal(
    codeOf(() => builder.useAt(noop('A'), PipelineStage.Validate, 'Middle' as Placement)),
    ErrorCode.InvalidArgument,
  );
  assert.equal(
    codeOf(() => builder.useNamedInstance('', noop('A'), PipelineStage.Validate)),
    ErrorCode.InvalidArgument,
  );
  assert.equal(
    codeOf(() => builder.use({ name: 'A' } as Middleware)),
    ErrorCode.InvalidArgument,
  );
  assert.equal(builder.describe().length, 0, 'rejected registrations are not kept');
});

test('命名实例彼此独立，但按类型的约束有歧义', () => {
  const log: string[] = [];
  const builder = new PipelineBuilder()
    .useNamedInstance('guard-a', recording('Guard', log), PipelineStage.Observe, Placement.End, 'xihan.plugins.a')
    .useNamedInstance('guard-b', recording('Guard', log), PipelineStage.Observe, Placement.End, 'xihan.plugins.b');
  assert.equal(builder.dump(), 'observe      Guard[guard-a]\nobserve      Guard[guard-b]\n');
  assert.equal(builder.describe()[1]?.instance, 'guard-b');
  builder.useAt(noop('Other'), PipelineStage.Observe).before('Guard', 'Other');
  assert.equal(
    codeOf(() => builder.describe()),
    PipelineErrorCode.Registration,
  );
  const twice = new PipelineBuilder()
    .useNamedInstance('guard-a', noop('Guard'), PipelineStage.Observe)
    .useNamedInstance('guard-a', noop('Guard'), PipelineStage.Observe);
  assert.throws(() => twice.describe(), { message: "The middleware 'Guard[guard-a]' is registered more than once." });
});

test('短路跳过下游', async () => {
  const log: string[] = [];
  const denied = ErrorInfo.denied('ORDERS_DENIED_001', 'orders.denied');
  const builder = new PipelineBuilder()
    .useAt(
      middleware('Deny', async () => Result.fail(denied)),
      PipelineStage.Authorize,
    )
    .useAt(recording('Handle', log), PipelineStage.Handle);
  const step = builder.build(async () => Result.success());
  const outcome = await step(InvocationContext.create());
  assert.ok(!outcome.ok);
  assert.equal(outcome.ok ? undefined : outcome.error.code, 'ORDERS_DENIED_001');
  assert.deepEqual(log, []);
});

test('中间件把派生的上下文交给下游；已构建的管道不受之后的登记影响', async () => {
  const seen: (string | undefined)[] = [];
  const builder = new PipelineBuilder().useAt(
    middleware('Tenant', (context, next) => next(context.withBaggage(BaggageKey.Tenant, 't1'))),
    PipelineStage.Tenant,
  );
  const step = builder.build(async (context) => {
    seen.push(context.tenant);
    return Result.success();
  });
  builder.useAt(
    middleware('Late', async () => Result.fail(ErrorInfo.literal('ORDERS_UNEXPECTED_001', 'late'))),
    PipelineStage.Observe,
  );
  const outcome = await step(InvocationContext.create());
  assert.ok(outcome.ok);
  assert.deepEqual(seen, ['t1']);
  assert.equal(builder.describe().length, 2);
});
