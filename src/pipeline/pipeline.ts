import type { InvocationContext } from '../invocation/index.ts';
import { FrameworkError, isPipelineStage, PipelineStage, pipelineStages, type Result } from '../primitives/index.ts';
import { compareOrdinal } from '../primitives/ordinal.ts';

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

/**
 * 一次登记
 *
 * @remarks
 * 顺序约束记在主体的登记上（与 .NET 一样），目标是中间件名，排序时才解析
 */
interface Registration {
  readonly middleware: Middleware;
  readonly descriptor: MiddlewareDescriptor;
  /** 登记序号，阶段内排序的最后一级 */
  readonly order: number;
  /** 要排在这些中间件之前 */
  readonly before: string[];
  /** 要排在这些中间件之后 */
  readonly after: string[];
}

/**
 * 收集中间件与顺序约束，按规范排序后构建管道（RFC-0004）
 *
 * @remarks
 * 排序：先阶段；阶段内先位置（Beginning 在前），再归属的码元序，再登记顺序；最后按约束做稳定拓扑排序。
 * 报错的时机照 .NET（RFC-0004 排序规则第 8 条）：重复登记、未知阶段、约束主体未登记或有歧义在登记时立即报；约束目标未登记、
 * 有歧义、跨阶段与成环在排序时（`describe`、`dump`、`build`）报。错误以 {@link FrameworkError} 抛出，
 * 消息是与 .NET 逐字相同的英文原文（ADR-0236），按名字登记的实例写成 `类型名[名字]`
 */
export class PipelineBuilder {
  readonly #registrations: Registration[] = [];

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
   * @throws {@link FrameworkError} 阶段未知（`KERNEL_PIPELINE_002`）、重复登记（`KERNEL_PIPELINE_003`）或其他参数不合法（`PRIMITIVES_VALIDATION_001`）时
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
      throw FrameworkError.invalidArgument('The instance name of a middleware must not be empty.');
    }
    return this.#add(middleware, instance, stage, placement ?? Placement.End, owner ?? AppOwner);
  }

  /**
   * 约束 `middleware` 在 `other` 之前
   *
   * @remarks
   * 两端都是中间件名：按名字登记的实例名，或没有名字、只登记一次的中间件的类型名（RFC-0004 排序规则第 7 条）；
   * 按名字登记的实例不能按类型名指到。约束主体 `middleware` 在声明时必须已登记；
   * 目标 `other` 在排序时解析，未登记、对应多个中间件或不在同一阶段都是 `KERNEL_PIPELINE_003`
   *
   * @throws {@link FrameworkError} 主体还没有登记或按名字有歧义时，码为 `KERNEL_PIPELINE_003`
   */
  before(middleware: string, other: string): this {
    requireByName(this.#registrations, middleware).before.push(other);
    return this;
  }

  /**
   * 约束 `middleware` 在 `other` 之后；名字的解析与 {@link PipelineBuilder.before} 相同
   *
   * @throws {@link FrameworkError} 主体还没有登记或按名字有歧义时，码为 `KERNEL_PIPELINE_003`
   */
  after(middleware: string, other: string): this {
    requireByName(this.#registrations, middleware).after.push(other);
    return this;
  }

  /**
   * 复制一份登记与约束都相同的构建器；之后两份各自登记，互不影响
   *
   * @remarks
   * 调用器在复制上加入自己的内置步骤，不改调用方的构建器（RFC-0011 规则 10）
   */
  clone(): PipelineBuilder {
    const copy = new PipelineBuilder();
    for (const registration of this.#registrations) {
      copy.#registrations.push({ ...registration, before: [...registration.before], after: [...registration.after] });
    }
    return copy;
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
      throw FrameworkError.invalidArgument('A middleware needs an invoke function.');
    }
    if (typeof middleware.name !== 'string' || middleware.name === '') {
      throw FrameworkError.invalidArgument('The name of a middleware must not be empty.');
    }
    if (!isPipelineStage(stage)) {
      throw unknownStage(String(stage));
    }
    if (placement !== Placement.Beginning && placement !== Placement.End) {
      throw FrameworkError.invalidArgument(
        `The placement '${String(placement)}' of '${middleware.name}' is not valid.`,
      );
    }
    if (typeof owner !== 'string' || owner === '') {
      throw FrameworkError.invalidArgument(`The owner of '${middleware.name}' must not be empty.`);
    }
    const display = instance === undefined ? middleware.name : `${middleware.name}[${instance}]`;
    // 重复登记在登记时立即报，不等到排序（RFC-0004 排序规则第 8 条，照 .NET）：同一类型的默认实例只登记一次，
    // 命名实例的名字在类型内唯一
    const duplicate = this.#registrations.some(
      ({ descriptor }) => descriptor.middleware === middleware.name && descriptor.instance === instance,
    );
    if (duplicate) {
      throw registrationError(
        instance === undefined
          ? `Middleware '${middleware.name}' is already registered; each middleware type may appear only once in a pipeline unless its instances are named.`
          : `Middleware '${middleware.name}' named '${instance}' is already registered; instance names must be unique within a type.`,
      );
    }
    this.#registrations.push({
      middleware,
      descriptor: Object.freeze({ stage, middleware: middleware.name, instance, owner, placement, display }),
      order: this.#registrations.length,
      before: [],
      after: [],
    });
    return this;
  }

  /** 按规则排序：先阶段；阶段内先位置，再归属，再登记顺序，最后按约束做稳定拓扑排序 */
  #sorted(): Registration[] {
    const result: Registration[] = [];
    for (const stage of pipelineStages) {
      // Array.prototype.sort 是稳定排序，比较到登记序号为止，基准次序完全确定
      const members = this.#registrations
        .filter((registration) => registration.descriptor.stage === stage)
        .sort(compareBase);
      result.push(...topologicalSort(stage, members, this.#registrations));
    }
    return result;
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
  const owners = compareOrdinal(left.descriptor.owner, right.descriptor.owner);
  if (owners !== 0) {
    return owners;
  }
  return left.order - right.order;
}

/**
 * 按名字找登记：按名字登记的实例按实例名，没有名字的按类型名（RFC-0004 排序规则第 7 条）；没有时为 `undefined`
 *
 * @throws {@link FrameworkError} 同一个名字对应多个登记时，码为 `KERNEL_PIPELINE_003`
 */
function findByName(registrations: readonly Registration[], name: string): Registration | undefined {
  let found: Registration | undefined;
  for (const registration of registrations) {
    const { instance, middleware } = registration.descriptor;
    if ((instance === undefined ? middleware : instance) !== name) {
      continue;
    }
    if (found !== undefined) {
      throw registrationError(
        `The middleware name '${name}' matches several registrations, so ordering constraints by name are ambiguous for it.`,
      );
    }
    found = registration;
  }
  return found;
}

/** 约束主体在声明时必须已登记且按名字唯一，登记时立即报（RFC-0004 排序规则第 8 条） */
function requireByName(registrations: readonly Registration[], name: string): Registration {
  const found = findByName(registrations, name);
  if (found === undefined) {
    throw registrationError(
      `Middleware '${name}' is not registered, so no ordering constraint can be declared for it.`,
    );
  }
  return found;
}

/** 约束的目标在排序时解析（RFC-0004 排序规则第 8 条）：未登记、对应多个中间件、跨阶段都是登记错误 */
function resolveTarget(
  registrations: readonly Registration[],
  source: Registration,
  target: string,
  stage: PipelineStage,
): Registration {
  const other = findByName(registrations, target);
  if (other === undefined) {
    throw registrationError(
      `The ordering constraint of middleware '${source.descriptor.display}' references unregistered middleware '${target}'.`,
    );
  }
  if (other.descriptor.stage !== stage) {
    throw registrationError(
      `Middleware '${source.descriptor.display}' (stage '${stage}') and '${target}' (stage '${other.descriptor.stage}') are not in the same stage, so no relative order can be declared between them.`,
    );
  }
  return other;
}

/**
 * 在基准次序上应用约束做稳定拓扑排序
 *
 * @remarks
 * 边按 .NET 的顺序建立：阶段内按基准次序逐个登记，先它的 before、再它的 after，目标在这时解析。
 * Kahn 算法，每次取基准次序里最靠前的无前驱节点：约束只调整必要的相对位置，其余保持基准次序（RFC-0004 排序规则第 5 条）；
 * 成环时按基准次序列出全部仍被卡住的中间件
 */
function topologicalSort(
  stage: PipelineStage,
  members: Registration[],
  registrations: readonly Registration[],
): Registration[] {
  const incoming = new Map<Registration, number>(members.map((member) => [member, 0]));
  const outgoing = new Map<Registration, Registration[]>(members.map((member) => [member, []]));
  const edge = (first: Registration, second: Registration): void => {
    outgoing.get(first)?.push(second);
    incoming.set(second, (incoming.get(second) ?? 0) + 1);
  };
  for (const member of members) {
    for (const target of member.before) {
      edge(member, resolveTarget(registrations, member, target, stage));
    }
    for (const target of member.after) {
      edge(resolveTarget(registrations, member, target, stage), member);
    }
  }
  const ordered: Registration[] = [];
  const remaining = [...members];
  while (remaining.length > 0) {
    const picked = remaining.findIndex((candidate) => (incoming.get(candidate) ?? 0) === 0);
    if (picked < 0) {
      const stuck = remaining.map((registration) => `'${registration.descriptor.display}'`).join(', ');
      throw new FrameworkError(
        PipelineErrorCode.Cycle,
        `Middleware ordering constraints in stage '${stage}' form a cycle: ${stuck}.`,
      );
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
  return new FrameworkError(PipelineErrorCode.UnknownStage, `Unknown pipeline stage '${name}'.`);
}
