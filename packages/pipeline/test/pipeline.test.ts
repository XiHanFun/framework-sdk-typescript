import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

  // 重复登记在登记时立即报（RFC-0004 排序规则第 8 条）；被拒的登记不留下
  const duplicate = new PipelineBuilder().useAt(noop('A'), PipelineStage.Validate);
  assert.equal(
    codeOf(() => duplicate.useAt(noop('A'), PipelineStage.Handle)),
    PipelineErrorCode.Registration,
  );
  assert.equal(duplicate.describe().length, 1);

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
  // 主体按类型名有歧义：声明时就报
  builder.useAt(noop('Other'), PipelineStage.Observe);
  assert.equal(
    codeOf(() => builder.before('Guard', 'Other')),
    PipelineErrorCode.Registration,
  );
  // 目标按类型名有歧义：排序时报
  builder.before('Other', 'Guard');
  assert.equal(
    codeOf(() => builder.describe()),
    PipelineErrorCode.Registration,
  );
  const twice = new PipelineBuilder().useNamedInstance('guard-a', noop('Guard'), PipelineStage.Observe);
  assert.throws(() => twice.useNamedInstance('guard-a', noop('Guard'), PipelineStage.Observe), {
    message: "The middleware 'Guard[guard-a]' is registered more than once.",
  });
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

test('复制的构建器与原来的互不影响', () => {
  const original = new PipelineBuilder()
    .useAt(noop('A'), PipelineStage.Validate)
    .useAt(noop('B'), PipelineStage.Validate)
    .before('B', 'A');
  const copy = original.clone().useAt(noop('C'), PipelineStage.Observe, Placement.Beginning, 'xihan.kernel.core');
  assert.equal(original.dump(), 'validate     B\nvalidate     A\n');
  assert.equal(copy.dump(), 'observe      C\nvalidate     B\nvalidate     A\n');
  // 复制保留重复登记的核对
  assert.equal(
    codeOf(() => copy.useAt(noop('A'), PipelineStage.Handle)),
    PipelineErrorCode.Registration,
  );
});

test('次序约束可以按实例名声明，主体在声明时必须已登记', () => {
  const builder = new PipelineBuilder()
    .useNamedInstance('guard-a', noop('Guard'), PipelineStage.Observe, Placement.End, 'xihan.plugins.a')
    .useNamedInstance('guard-b', noop('Guard'), PipelineStage.Observe, Placement.End, 'xihan.plugins.b')
    .useAt(noop('Audit'), PipelineStage.Observe, Placement.End, 'app')
    .after('guard-a', 'guard-b')
    .before('Audit', 'guard-b');
  assert.equal(builder.dump(), 'observe      Audit\nobserve      Guard[guard-b]\nobserve      Guard[guard-a]\n');

  // 主体没有登记：声明时就报，不等到排序
  assert.equal(
    codeOf(() => new PipelineBuilder().before('Missing', 'Other')),
    PipelineErrorCode.Registration,
  );
  assert.throws(() => new PipelineBuilder().useAt(noop('A'), PipelineStage.Validate).after('Missing', 'A'), {
    message: "The middleware 'Missing' must be registered before it declares an ordering constraint.",
  });

  // 只登记一次的类型按类型名也能指到，即使它是命名实例
  const single = new PipelineBuilder()
    .useNamedInstance('only', noop('Lonely'), PipelineStage.Validate)
    .useAt(noop('First'), PipelineStage.Validate)
    .before('Lonely', 'First');
  assert.deepEqual(
    single.describe().map((descriptor) => descriptor.display),
    ['Lonely[only]', 'First'],
  );

  // 同一个名字既是实例名又是另一个类型名：有歧义
  const clash = new PipelineBuilder()
    .useNamedInstance('Audit', noop('Guard'), PipelineStage.Observe)
    .useAt(noop('Audit'), PipelineStage.Observe)
    .useAt(noop('Trace'), PipelineStage.Observe)
    .before('Trace', 'Audit');
  assert.throws(() => clash.describe(), {
    message:
      "The name 'Audit' refers to several middleware (Guard[Audit], Audit); ordering constraints by it are ambiguous.",
  });
});

/** ordering.json 的一步：按名字登记一个实例，或一条按名字的约束 */
type OrderingStep =
  | { readonly use: string; readonly stage: string; readonly placement: 'beginning' | 'end'; readonly owner: string }
  | { readonly before: readonly [string, string] }
  | { readonly after: readonly [string, string] };

/** 回放时按名字登记的实例都用这个类型名，向量 Dump 里的 {type} 换成它 */
const vectorType = 'VectorMiddleware';

function apply(builder: PipelineBuilder, step: OrderingStep): void {
  if ('use' in step) {
    builder.useNamedInstance(
      step.use,
      noop(vectorType),
      step.stage as PipelineStage,
      step.placement === 'beginning' ? Placement.Beginning : Placement.End,
      step.owner,
    );
  } else if ('before' in step) {
    builder.before(step.before[0], step.before[1]);
  } else {
    builder.after(step.after[0], step.after[1]);
  }
}

test('排序、打印与报错时机遵循 pipeline/ordering.json', () => {
  const url = new URL('../../../spec/conformance/vectors/pipeline/ordering.json', import.meta.url);
  const vectors = JSON.parse(readFileSync(url, 'utf8')) as {
    cases: { name: string; steps: OrderingStep[]; dump: string }[];
    errors: { name: string; steps: OrderingStep[]; error: string; at: number | 'sort' }[];
  };
  for (const c of vectors.cases) {
    const builder = new PipelineBuilder();
    for (const step of c.steps) {
      apply(builder, step);
    }
    assert.equal(builder.dump(), c.dump.replaceAll('{type}', vectorType), c.name);
  }
  for (const c of vectors.errors) {
    const builder = new PipelineBuilder();
    // 期望在第 at 步报错的，前面各步都必须成功；at 为 sort 的，登记全部成功、在排序时报
    c.steps.forEach((step, index) => {
      if (index === c.at) {
        assert.equal(
          codeOf(() => apply(builder, step)),
          c.error,
          `${c.name} at step ${index}`,
        );
      } else if (c.at === 'sort' || index < c.at) {
        apply(builder, step);
      }
    });
    if (c.at === 'sort') {
      for (const sort of [
        () => builder.describe(),
        () => builder.dump(),
        () => builder.build(async () => Result.success()),
      ]) {
        assert.equal(codeOf(sort), c.error, `${c.name} when sorting`);
      }
    }
  }
});
