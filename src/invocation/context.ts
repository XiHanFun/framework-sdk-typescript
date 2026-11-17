import {
  BaggageKey,
  ErrorCode,
  ErrorInfo,
  FrameworkError,
  isBaggageKeyRegistered,
  isBaggageKeyWellFormed,
  isBaggageValueAcceptable,
} from '../primitives/index.ts';

import { formatTraceParent, isSpanId, isTraceId, newSpanId, newTraceId, parseTraceParent } from './trace.ts';

/**
 * 内核登记的、与调用上下文有关的错误码
 */
export const InvocationErrorCode = Object.freeze({
  /** 调用超过截止时间 */
  DeadlineExceeded: 'KERNEL_TIMEOUT_001',
  /** 调用在截止时间到达之前被调用方取消 */
  Cancelled: 'KERNEL_CANCELLED_001',
} as const);

/**
 * 与调用上下文有关的消息键
 */
export const InvocationMessageKey = Object.freeze({
  /** 超时 */
  DeadlineExceeded: 'kernel.invocation.deadline_exceeded',
  /** 进入 Resilience 阶段时截止时间已过；由调用器在这个阶段的内置步骤上按时钟核对（RFC-0011 规则 10） */
  DeadlineBeforeStart: 'kernel.invocation.deadline_before_start',
  /** 取消 */
  Cancelled: 'kernel.invocation.cancelled',
  /** 调用期间发生未处理的异常（KERNEL_UNEXPECTED_001，没有参数） */
  UnhandledException: 'kernel.invocation.unhandled_exception',
} as const);

/** 定时器能表示的最长延迟（2^31 - 1 毫秒，约 24.8 天）；更长的延迟 Node 会改成 1 毫秒立即触发 */
const maxTimerDelay = 2_147_483_647;

const deadlineExceeded = ErrorInfo.timeout(InvocationErrorCode.DeadlineExceeded, InvocationMessageKey.DeadlineExceeded);
const cancelled = ErrorInfo.cancelled(InvocationErrorCode.Cancelled, InvocationMessageKey.Cancelled);

/** 只在类型层面区分条目值的类型 */
declare const itemValue: unique symbol;

/**
 * 对象袋的类型化键：按对象标识区分，名字只用于调试
 *
 * @example
 * ```ts
 * const currentUser = new ItemKey<User>('app.current-user');
 * context.setItem(currentUser, user);
 * context.findItem(currentUser); // User | undefined
 * ```
 */
export class ItemKey<T> {
  /** 调试用的名字 */
  readonly name: string;
  declare readonly [itemValue]?: (value: T) => T;

  /**
   * 创建一个键；同名的两个键是不同的键
   */
  constructor(name: string) {
    this.name = name;
    Object.freeze(this);
  }

  /** 调试用 */
  toString(): string {
    return `ItemKey(${this.name})`;
  }
}

/**
 * 新建调用上下文的选项
 */
export interface InvocationContextOptions {
  /** 调用方的取消信号；中止即取消这次调用 */
  readonly signal?: AbortSignal;
  /** 绝对截止时间（Unix 毫秒，UTC）；与 `timeout` 二选一 */
  readonly deadline?: number;
  /** 相对超时（毫秒），从创建时起算；与 `deadline` 二选一 */
  readonly timeout?: number;
  /** 上游的 W3C traceparent；不合法时忽略并生成新的追踪（RFC-0003 第 7 条）；与 `trace` 二选一 */
  readonly traceParent?: string;
  /** 显式给出的追踪；不合法是编程错误；没给 `sampled` 时按上游已采样处理（RFC-0003 第 7 条）；与 `traceParent` 二选一 */
  readonly trace?: { readonly traceId: string; readonly spanId: string; readonly sampled?: boolean };
  /** Baggage（外部输入）；键必须符合 `xihan.<name>`，已登记键的值不合约束的成员丢弃（幂等键除外） */
  readonly baggage?: Readonly<Record<string, string>>;
}

/** 派生上下文之间共享或复制的状态 */
interface State {
  readonly signal: AbortSignal;
  /** 截止时间自己的信号：归因只看它是否已触发（RFC-0004「Resilience 阶段」） */
  readonly deadlineSignal: AbortSignal | undefined;
  readonly deadline: number | undefined;
  readonly traceId: string;
  readonly spanId: string;
  /** 采样位；没有时这次调用是链路的根 */
  readonly sampled: boolean | undefined;
  readonly baggage: Readonly<Record<string, string>>;
  /** 对象袋：派生上下文共享同一个 */
  readonly items: Map<object, unknown>;
}

/**
 * 一次调用的上下文（RFC-0003）：取消与截止时间、W3C 追踪、已登记的 Baggage 与请求作用域对象袋
 *
 * @remarks
 * 不可变：`with` 开头的方法派生新的上下文。派生上下文共享取消信号、截止时间、追踪与对象袋，Baggage 按值复制。
 * 不绑定任何协议，载体映射由协议适配器与插件运行时实现
 */
export class InvocationContext {
  readonly #state: State;

  private constructor(state: State) {
    this.#state = state;
    Object.freeze(this);
  }

  /**
   * 创建上下文
   *
   * @remarks
   * 没有给出追踪时生成新的追踪 ID 与 Span ID，标志为空（写出时为 `01`）；有截止时间时到点中止 {@link InvocationContext.signal}
   *
   * @throws {@link FrameworkError} 选项互相冲突、追踪不合法、Baggage 键不合法时，码为 `PRIMITIVES_VALIDATION_001`
   */
  static create(options: InvocationContextOptions = {}): InvocationContext {
    if (options.deadline !== undefined && options.timeout !== undefined) {
      throw invalid("Set either 'deadline' or 'timeout' of an invocation context, not both.");
    }
    if (options.trace !== undefined && options.traceParent !== undefined) {
      throw invalid("Set either 'trace' or 'traceParent' of an invocation context, not both.");
    }
    const deadline = options.timeout === undefined ? options.deadline : Date.now() + options.timeout;
    if (deadline !== undefined && !Number.isFinite(deadline)) {
      throw invalid('The deadline of an invocation context must be a finite number of milliseconds.');
    }
    const trace = resolveTrace(options);
    const delay = deadline === undefined ? undefined : deadline - Date.now();
    const deadlineSignal = delay === undefined ? undefined : timerSignal(delay);
    const signals = [options.signal, deadlineSignal].filter((signal) => signal !== undefined);
    return new InvocationContext({
      // 截止时间与取消并存：任一触发都中止这次调用（RFC-0003 第 1 条）
      signal: signals.length > 1 ? AbortSignal.any(signals) : (signals[0] ?? new AbortController().signal),
      deadlineSignal,
      deadline,
      ...trace,
      baggage: copyBaggage(options.baggage ?? {}),
      items: new Map(),
    });
  }

  /** 取消信号：调用方取消或截止时间到达时中止 */
  get signal(): AbortSignal {
    return this.#state.signal;
  }

  /** 绝对截止时间（Unix 毫秒，UTC）；没有时为 `undefined` */
  get deadline(): number | undefined {
    return this.#state.deadline;
  }

  /** 是否有截止时间 */
  get hasDeadline(): boolean {
    return this.#state.deadline !== undefined;
  }

  /**
   * 判断在给定时刻是否已过截止时间；没有截止时间时为假
   *
   * @param now - 当前时刻（Unix 毫秒），由调用方给出以便注入时钟
   */
  isExpired(now: number): boolean {
    return this.#state.deadline !== undefined && now >= this.#state.deadline;
  }

  /**
   * 返回到截止时间的剩余毫秒数，已过期为 0；没有截止时间时为 `undefined`
   *
   * @param now - 当前时刻（Unix 毫秒）
   */
  remainingTime(now: number): number | undefined {
    return this.#state.deadline === undefined ? undefined : Math.max(0, this.#state.deadline - now);
  }

  /** 追踪 ID：32 位小写十六进制 */
  get traceId(): string {
    return this.#state.traceId;
  }

  /** Span ID：16 位小写十六进制 */
  get spanId(): string {
    return this.#state.spanId;
  }

  /**
   * 是否采样
   *
   * @remarks
   * 上游的采样位（标志的最低位）；没有上游的根调用没有采样器，按已采样传下去，为 `true`
   */
  get sampled(): boolean {
    return this.#state.sampled ?? true;
  }

  /**
   * 写出的 W3C traceparent
   *
   * @remarks
   * 版本是 `00`，标志只写采样位：`00` 或 `01`，根调用写 `01`（RFC-0003 第 7 条「写出」）
   */
  get traceParent(): string {
    return formatTraceParent(this.#state);
  }

  /** Baggage：冻结的对象 */
  get baggage(): Readonly<Record<string, string>> {
    return this.#state.baggage;
  }

  /**
   * 取一个 Baggage 值；没有时为 `undefined`
   */
  findBaggage(key: string): string | undefined {
    return Object.hasOwn(this.#state.baggage, key) ? this.#state.baggage[key] : undefined;
  }

  /**
   * 派生一个多一个 Baggage 键值的上下文
   *
   * @remarks
   * 进程内可以带格式合法的未登记键，它们不出进程（RFC-0003 第 3 条）。程序内逐项派生给已登记的键一个不合约束的值
   * （见 {@link isBaggageValueAcceptable}）是编程错误，抛出而不是静默丢弃，与键不合文法时一样；幂等键例外
   * （conventions/baggage-keys.md，ADR-0235）。外部输入在 {@link InvocationContext.create} 里丢弃不合的成员
   *
   * @throws {@link FrameworkError} 键不符合 `xihan.<name>`、值不是字符串或已登记键的值不合约束时，码为 `PRIMITIVES_VALIDATION_001`
   */
  withBaggage(key: string, value: string): InvocationContext {
    checkBaggageMember(key, value);
    if (isBaggageKeyRegistered(key) && key !== BaggageKey.IdempotencyKey && !isBaggageValueAcceptable(value)) {
      // 值可能含控制字符，不写进消息
      throw invalid(
        `The baggage value of '${key}' must not be empty, longer than 256 UTF-16 code units or contain control characters.`,
      );
    }
    const baggage = Object.freeze({ ...this.#state.baggage, [key]: value });
    return new InvocationContext({ ...this.#state, baggage });
  }

  /**
   * 派生一个只保留已登记键的上下文：载体出站前剥离未登记键（RFC-0003 第 3 条）
   */
  withoutUnregisteredBaggage(): InvocationContext {
    const baggage = Object.fromEntries(
      Object.entries(this.#state.baggage).filter(([key]) => isBaggageKeyRegistered(key)),
    );
    return new InvocationContext({ ...this.#state, baggage: Object.freeze(baggage) });
  }

  /** 当前租户 ID；没有时为 `undefined` */
  get tenant(): string | undefined {
    return this.findBaggage(BaggageKey.Tenant);
  }

  /** 当前主体 ID；没有时为 `undefined` */
  get principal(): string | undefined {
    return this.findBaggage(BaggageKey.Principal);
  }

  /** 业务关联 ID；没有时为 `undefined` */
  get correlation(): string | undefined {
    return this.findBaggage(BaggageKey.Correlation);
  }

  /** 幂等键；没有时为 `undefined` */
  get idempotencyKey(): string | undefined {
    return this.findBaggage(BaggageKey.IdempotencyKey);
  }

  /** 请求文化（BCP 47）；没有时为 `undefined` */
  get locale(): string | undefined {
    return this.findBaggage(BaggageKey.Locale);
  }

  /**
   * 在对象袋里放一个值
   *
   * @remarks
   * 派生上下文共享对象袋；值不跨进程传播。一次调用用一个上下文，不要让并发的调用共用同一个
   */
  setItem<T>(key: ItemKey<T>, value: T): void {
    this.#state.items.set(key, value);
  }

  /**
   * 从对象袋里取一个值；没有时为 `undefined`
   */
  findItem<T>(key: ItemKey<T>): T | undefined {
    return this.#state.items.get(key) as T | undefined;
  }

  /**
   * 从对象袋里去掉一个值，返回原先是否有它
   */
  deleteItem<T>(key: ItemKey<T>): boolean {
    return this.#state.items.delete(key);
  }

  /**
   * 把取消与超时翻译成原语层错误；未中止时为 `undefined`
   *
   * @remarks
   * 截止时间已触发即 `KERNEL_TIMEOUT_001`，调用方同时取消也一样（RFC-0003 第 1 条、RFC-0004「Resilience 阶段」）；
   * 截止时间没有触发而调用方已取消为 `KERNEL_CANCELLED_001`。只看信号，不读时钟
   */
  get cancellation(): ErrorInfo | undefined {
    if (this.#state.deadlineSignal?.aborted === true) {
      return deadlineExceeded;
    }
    return cancellationOf(this.#state.signal);
  }
}

/**
 * 把一个取消信号翻译成原语层错误；未中止时为 `undefined`
 *
 * @remarks
 * 中止原因是 `TimeoutError`（`AbortSignal.timeout` 或上游截止时间）为 `KERNEL_TIMEOUT_001`，其他原因为 `KERNEL_CANCELLED_001`
 */
export function cancellationOf(signal: AbortSignal): ErrorInfo | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  return isTimeoutReason(signal.reason) ? deadlineExceeded : cancelled;
}

function isTimeoutReason(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && (reason as { name?: unknown }).name === 'TimeoutError';
}

/**
 * 截止时间自己的信号
 *
 * @remarks
 * 已过期的立即中止；超出定时器范围的不起定时器，等同于调用期间不会到期（与 .NET DeadlineMiddleware 的处理一致，ADR-0203），
 * 否则 Node 会把它改成 1 毫秒后触发。`AbortSignal.timeout` 的定时器不阻止进程退出，调用结束后也不留下要清理的资源
 */
function timerSignal(delay: number): AbortSignal | undefined {
  if (delay <= 0) {
    return AbortSignal.abort(new DOMException('The invocation exceeded its deadline.', 'TimeoutError'));
  }
  return delay > maxTimerDelay ? undefined : AbortSignal.timeout(Math.ceil(delay));
}

/**
 * 追踪的来源（RFC-0003 第 7 条）
 *
 * @remarks
 * 显式给出的追踪没给 `sampled` 按上游已采样处理；合法的 traceparent 取它的 ID 与采样位；不合法的当作没给，
 * 都没有时生成 ID，采样位为空，这次调用是根
 */
function resolveTrace(options: InvocationContextOptions): Pick<State, 'traceId' | 'spanId' | 'sampled'> {
  if (options.trace !== undefined) {
    const { traceId, spanId, sampled = true } = options.trace;
    if (!isTraceId(traceId)) {
      throw invalid(`The trace ID '${traceId}' must be 32 lowercase hexadecimal digits that are not all zero.`);
    }
    if (!isSpanId(spanId)) {
      throw invalid(`The span ID '${spanId}' must be 16 lowercase hexadecimal digits that are not all zero.`);
    }
    return { traceId, spanId, sampled };
  }
  const parsed = options.traceParent === undefined ? undefined : parseTraceParent(options.traceParent);
  return parsed === undefined
    ? { traceId: newTraceId(), spanId: newSpanId(), sampled: undefined }
    : { traceId: parsed.traceId, spanId: parsed.spanId, sampled: parsed.sampled };
}

/**
 * 把一组外部输入的 Baggage 复制并冻结
 *
 * @remarks
 * 键不合格式、值不是字符串是编程错误；已登记键的值不合约束（空、超过 256 个 UTF-16 码元、含控制字符）的成员丢弃，
 * 与 W3C Baggage 忽略不合法的成员一致（conventions/baggage-keys.md）。幂等键例外：丢了它重复的调用会执行两次，
 * 不合法的幂等键由幂等阶段以校验错误拒绝
 */
function copyBaggage(baggage: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(baggage)) {
    checkBaggageMember(key, value);
    if (isBaggageKeyRegistered(key) && key !== BaggageKey.IdempotencyKey && !isBaggageValueAcceptable(value)) {
      continue;
    }
    copy[key] = value;
  }
  return Object.freeze(copy);
}

/** 键不合 `xihan.<name>`、值不是字符串在任何入口都是编程错误 */
function checkBaggageMember(key: string, value: unknown): void {
  if (!isBaggageKeyWellFormed(key)) {
    throw invalid(`The baggage key '${key}' must match xihan.<name>.`);
  }
  if (typeof value !== 'string') {
    throw invalid(`The baggage value of '${key}' must be a string.`);
  }
}

function invalid(message: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, message);
}
