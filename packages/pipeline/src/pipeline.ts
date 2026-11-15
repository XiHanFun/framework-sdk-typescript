import type { InvocationContext } from '@xihan-framework/invocation';
import {
  ErrorCode,
  FrameworkError,
  isPipelineStage,
  PipelineStage,
  pipelineStages,
  type Result,
} from '@xihan-framework/primitives';

/**
 * 内核登记的管道错误码
 */
export const PipelineErrorCode = Object.freeze({
  /** 中间件顺序约束成环 */
  Cycle: 'KERNEL_PIPELINE_001',
  /** 阶段名未知 */
  UnknownStage: 'KERNEL_PIPELINE_002',
  /** 中间件重复登记，或顺序约束引用了未登记、跨阶段或有多个实例的中间件 */
  Registration: 'KERNEL_PIPELINE_003',
} as const);

/**
 * 应用自己登记的中间件的归属
 */
export const AppOwner = 'app';

/**
 * 管道里的一步：中间件调用它进入下游
 *
 * @remarks
 * 可恢复失败经 Result 返回；中间件可以传入派生的上下文（如多带一个 Baggage）
 */
export type Step = (context: InvocationContext) => Promise<Result<void>>;

/**
 * 一个中间件
 *
 * @remarks
 * `name` 是类型名，排序约束与打印用；`invoke` 可以在进入下游前后做事，也可以不调 `next` 而短路
 */
export interface Middleware {
  /** 类型名 */
  readonly name: string;
  /** 执行中间件 */
  invoke(context: InvocationContext, next: Step): Promise<Result<void>>;
}

/**
 * 用名字与函数创建中间件
 */
export function middleware(
  name: string,
  invoke: (context: InvocationContext, next: Step) => Promise<Result<void>>,
): Middleware {
  return Object.freeze({ name, invoke });
}

/**
 * 中间件在阶段内的位置：`Beginning` 在前
 */
export const Placement = Object.freeze({
  Beginning: 'Beginning',
  End: 'End',
} as const);

/**
 * 阶段内位置之一
 */
export type Placement = (typeof Placement)[keyof typeof Placement];

/**
 * 一个已排序的中间件的描述
 */
export interface MiddlewareDescriptor {
  /** 所在阶段 */
  readonly stage: PipelineStage;
  /** 类型名 */
  readonly middleware: string;
  /** 按名登记的实例名；默认实例为 `undefined` */
  readonly instance: string | undefined;
  /** 归属：清单 ID 或 `app` */
  readonly owner: string;
  /** 阶段内位置 */
  readonly placement: Placement;
  /** 打印名：类型名，命名实例为 `类型名[实例名]` */
  readonly display: string;
}

/** 一次登记 */
interface Registration {
  readonly middleware: Middleware;
  readonly descriptor: MiddlewareDescriptor;
  /** 登记序号，阶段内排序的最后一级 */
  readonly order: number;
}

/** 一条顺序约束：first 在 second 之前，都是中间件名（实例名或类型名） */
interface Constraint {
  readonly first: string;
  readonly second: string;
}

/**
 * 收集中间件与顺序约束，按规范排序后构建管道（RFC-0004）
 *
 * @remarks
 * 排序：先阶段；阶段内先位置（Beginning 在前），再归属的码元序，再登记顺序；最后按约束做稳定拓扑排序。
 * 登记时核对参数，约束的主体在声明时必须已登记，目标在排序时（`describe`、`dump`、`build`）解析，错误以 {@link FrameworkError} 抛出
 */
export class PipelineBuilder {
  readonly #registrations: Registration[] = [];
  readonly #constraints: Constraint[] = [];

  /**
   * 登记中间件到 transaction 阶段末尾（RFC-0004 排序规则第 1 条）
   */
  use(middleware: Middleware): this {
    return this.useAt(middleware, PipelineStage.Transaction, Placement.End, AppOwner);
  }

  /**
   * 登记中间件到指定阶段
   *
   * @param placement - 阶段内位置，缺省为 `End`
   * @param owner - 归属，缺省为 `app`
   * @throws {@link FrameworkError} 阶段未知（`KERNEL_PIPELINE_002`）或其他参数不合法（`PRIMITIVES_VALIDATION_001`）时
   */
  useAt(middleware: Middleware, stage: PipelineStage, placement?: Placement, owner?: string): this {
    return this.#add(middleware, undefined, stage, placement ?? Placement.End, owner ?? AppOwner);
  }

  /**
   * 按名字登记同一类型的另一个实例（RFC-0004 排序规则第 7 条）；名字在类型内唯一
   *
   * @throws {@link FrameworkError} 参数不合法时
   */
  useNamedInstance(
    instance: string,
    middleware: Middleware,
    stage: PipelineStage,
    placement?: Placement,
    owner?: string,
  ): this {
    if (typeof instance !== 'string' || instance === '') {
      throw invalid('The instance name of a middleware must not be empty.');
    }
    return this.#add(middleware, instance, stage, placement ?? Placement.End, owner ?? AppOwner);
  }

  /**
   * 约束 `middleware` 在 `other` 之前
   *
   * @remarks
   * 两端都是中间件名：命名实例的实例名，或类型名（RFC-0004 排序规则第 7 条）。约束主体 `middleware` 在声明时必须已登记；
   * 目标 `other` 在排序时解析，未登记、对应多个中间件或不在同一阶段都是 `KERNEL_PIPELINE_003`
   *
   * @throws {@link FrameworkError} 主体还没有登记时，码为 `KERNEL_PIPELINE_003`
   */
  before(middleware: string, other: string): this {
    this.#checkSubject(middleware);
    this.#constraints.push({ first: middleware, second: other });
    return this;
  }

  /**
   * 约束 `middleware` 在 `other` 之后；名字的解析与 {@link PipelineBuilder.before} 相同
   *
   * @throws {@link FrameworkError} 主体还没有登记时，码为 `KERNEL_PIPELINE_003`
   */
  after(middleware: string, other: string): this {
    this.#checkSubject(middleware);
    this.#constraints.push({ first: other, second: middleware });
    return this;
  }

  /** 约束主体在声明时必须已登记；有歧义的名字留到排序时与目标一起报 */
  #checkSubject(name: string): void {
    if (matching(this.#registrations, name).length === 0) {
      throw registrationError(`The middleware '${name}' must be registered before it declares an ordering constraint.`);
    }
  }

  /**
   * 返回排序后的中间件描述
   *
   * @throws {@link FrameworkError} 约束成环（`KERNEL_PIPELINE_001`）或登记冲突（`KERNEL_PIPELINE_003`）时
   */
  describe(): readonly MiddlewareDescriptor[] {
    return Object.freeze(this.#sorted().map((registration) => registration.descriptor));
  }

  /**
   * 按 `xihan pipeline` 的格式打印：一行一个中间件，阶段名左对齐占 12 列、空一格后接打印名
   *
   * @throws {@link FrameworkError} 同 {@link PipelineBuilder.describe}
   */
  dump(): string {
    return this.describe()
      .map((descriptor) => `${descriptor.stage.padEnd(12)} ${descriptor.display}\n`)
      .join('');
  }

  /**
   * 构建管道
   *
   * @remarks
   * 按构建时的登记排序；之后再登记的中间件不影响已构建的管道
   *
   * @param terminal - handle 阶段之后的终点，通常是操作分派
   * @throws {@link FrameworkError} 没有终点或排序失败时
   */
  build(terminal: Step): Step {
    if (typeof terminal !== 'function') {
      throw registrationError('The pipeline needs a terminal step.');
    }
    let next = terminal;
    const sorted = this.#sorted();
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const { middleware } = sorted[index] as Registration;
      const downstream = next;
      next = (context) => middleware.invoke(context, downstream);
    }
    return next;
  }

  #add(
    middleware: Middleware,
    instance: string | undefined,
    stage: PipelineStage,
    placement: Placement,
    owner: string,
  ): this {
    if (typeof middleware?.invoke !== 'function') {
      throw invalid('A middleware needs an invoke function.');
    }
    if (typeof middleware.name !== 'string' || middleware.name === '') {
      throw invalid('The name of a middleware must not be empty.');
    }
    if (!isPipelineStage(stage)) {
      throw unknownStage(String(stage));
    }
    if (placement !== Placement.Beginning && placement !== Placement.End) {
      throw invalid(`The placement '${String(placement)}' of '${middleware.name}' is not valid.`);
    }
    if (typeof owner !== 'string' || owner === '') {
      throw invalid(`The owner of '${middleware.name}' must not be empty.`);
    }
    const display = instance === undefined ? middleware.name : `${middleware.name}[${instance}]`;
    this.#registrations.push({
      middleware,
      descriptor: Object.freeze({ stage, middleware: middleware.name, instance, owner, placement, display }),
      order: this.#registrations.length,
    });
    return this;
  }

  /** 按规则排序：先阶段；阶段内先位置，再归属，再登记顺序，最后按约束做稳定拓扑排序 */
  #sorted(): Registration[] {
    this.#checkDuplicates();
    // 约束按中间件名引用（实例名或类型名）：未登记、对应多个中间件、跨阶段都是登记错误
    const resolved: [Registration, Registration][] = this.#constraints.map(({ first, second }) => {
      const before = single(this.#registrations, first);
      const after = single(this.#registrations, second);
      if (before.descriptor.stage !== after.descriptor.stage) {
        throw registrationError(`The ordering constraint between '${first}' and '${second}' crosses stages.`);
      }
      return [before, after];
    });

    const result: Registration[] = [];
    for (const stage of pipelineStages) {
      // Array.prototype.sort 是稳定排序，比较到登记序号为止，基准次序完全确定
      const members = this.#registrations
        .filter((registration) => registration.descriptor.stage === stage)
        .sort(compareBase);
      result.push(...topologicalSort(stage, members, resolved));
    }
    return result;
  }

  /** 同一类型的默认实例只登记一次，命名实例的名字在类型内唯一 */
  #checkDuplicates(): void {
    const seen = new Set<string>();
    for (const { descriptor } of this.#registrations) {
      const key = `${descriptor.middleware}\u0000${descriptor.instance ?? ''}`;
      if (seen.has(key)) {
        throw registrationError(`The middleware '${descriptor.display}' is registered more than once.`);
      }
      seen.add(key);
    }
  }
}

/**
 * 解析清单里的阶段名
 *
 * @throws {@link FrameworkError} 阶段未知时，码为 `KERNEL_PIPELINE_002`
 */
export function parseStage(name: string): PipelineStage {
  if (!isPipelineStage(name)) {
    throw unknownStage(name);
  }
  return name;
}

/** 阶段内的基准次序：位置、归属的码元序（与 .NET 的序数比较一致）、登记顺序 */
function compareBase(left: Registration, right: Registration): number {
  if (left.descriptor.placement !== right.descriptor.placement) {
    return left.descriptor.placement === Placement.Beginning ? -1 : 1;
  }
  if (left.descriptor.owner !== right.descriptor.owner) {
    return left.descriptor.owner < right.descriptor.owner ? -1 : 1;
  }
  return left.order - right.order;
}

/**
 * 名字对应的登记：实例名等于它的命名实例，与类型名等于它的登记
 *
 * @remarks
 * 只登记了一次的类型按类型名也能指到（含只有一个命名实例的）；同一类型有多个实例时按类型名会指到多个
 */
function matching(registrations: readonly Registration[], name: string): Registration[] {
  return registrations.filter(({ descriptor }) => descriptor.instance === name || descriptor.middleware === name);
}

/** 按名字取唯一的登记；没有或对应多个中间件都是登记错误 */
function single(registrations: readonly Registration[], name: string): Registration {
  const found = matching(registrations, name);
  if (found.length === 0) {
    throw registrationError(`The ordering constraint references the unregistered middleware '${name}'.`);
  }
  if (found.length > 1) {
    const displays = found.map((registration) => registration.descriptor.display).join(', ');
    throw registrationError(
      `The name '${name}' refers to several middleware (${displays}); ordering constraints by it are ambiguous.`,
    );
  }
  return found[0] as Registration;
}

/**
 * 在基准次序上应用约束做稳定拓扑排序
 *
 * @remarks
 * Kahn 算法，每次取基准次序里最靠前的无前驱节点：约束只调整必要的相对位置，其余保持基准次序（RFC-0004 排序规则第 5 条）
 */
function topologicalSort(
  stage: PipelineStage,
  members: Registration[],
  constraints: readonly [Registration, Registration][],
): Registration[] {
  const inStage = new Set(members);
  const incoming = new Map<Registration, number>();
  const outgoing = new Map<Registration, Registration[]>();
  for (const [first, second] of constraints) {
    // 约束已核对过同阶段，只需挑出本阶段的
    if (!inStage.has(first)) {
      continue;
    }
    outgoing.set(first, [...(outgoing.get(first) ?? []), second]);
    incoming.set(second, (incoming.get(second) ?? 0) + 1);
  }
  const ordered: Registration[] = [];
  const remaining = [...members];
  while (remaining.length > 0) {
    const picked = remaining.findIndex((candidate) => (incoming.get(candidate) ?? 0) === 0);
    if (picked < 0) {
      throw new FrameworkError(PipelineErrorCode.Cycle, `The ordering constraints in stage '${stage}' form a cycle.`);
    }
    const [node] = remaining.splice(picked, 1) as [Registration];
    ordered.push(node);
    for (const successor of outgoing.get(node) ?? []) {
      incoming.set(successor, (incoming.get(successor) ?? 0) - 1);
    }
  }
  return ordered;
}

function registrationError(message: string): FrameworkError {
  return new FrameworkError(PipelineErrorCode.Registration, message);
}

function unknownStage(name: string): FrameworkError {
  return new FrameworkError(PipelineErrorCode.UnknownStage, `'${name}' is not a pipeline stage.`);
}

function invalid(message: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, message);
}
