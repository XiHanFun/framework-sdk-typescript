import { type InvocationContext, InvocationErrorCode, InvocationMessageKey, ItemKey } from '../invocation/index.ts';
import { type Middleware, middleware, PipelineBuilder, Placement, type Step } from '../pipeline/index.ts';
import { ErrorCode, ErrorInfo, FrameworkError, PipelineStage, Result } from '../primitives/index.ts';

import { type OperationContract, OperationErrorCode, OperationMessageKey } from './contract.ts';
import {
  decodePayload,
  encodeResponse,
  internalsOf,
  notFound,
  type OperationDescriptor,
  type OperationRegistry,
  type OperationRequest,
  type OperationResponse,
} from './registry.ts';

/** 对象袋里的键：当前操作、XGI 请求、解码好的请求、成功的响应对象与这次调用的终点 */
const descriptorKey = new ItemKey<OperationDescriptor>('operation.descriptor');
const requestKey = new ItemKey<OperationRequest>('operation.request');
const decodedKey = new ItemKey<{ readonly value: unknown }>('operation.decoded-request');
const responseKey = new ItemKey<{ readonly value: unknown }>('operation.response');
const terminalKey = new ItemKey<Step>('operation.terminal');

/**
 * 调用器内置步骤的归属：与 .NET 内核的内置中间件相同（RFC-0011 规则 10）
 */
export const KernelOwner = 'xihan.kernel.core';

/**
 * 调用器内置步骤的名字：与 .NET 内核的内置中间件同名，排序约束与打印按这些名字
 */
export const BuiltInStep = Object.freeze({
  /** Observe 阶段：把排在它之后抛出的异常翻译成失败 */
  Observe: 'ObserveMiddleware',
  /** Resilience 阶段：进入时核对截止时间 */
  Deadline: 'DeadlineMiddleware',
  /** Validate 阶段：原始调用在这里解码载荷 */
  Validation: 'ValidationMiddleware',
} as const);

/**
 * 返回当前调用的操作描述；管道里的中间件用
 */
export function findOperation(context: InvocationContext): OperationDescriptor | undefined {
  return context.findItem(descriptorKey);
}

/**
 * 返回当前调用的 XGI 请求；类型化调用只有 `id`
 */
export function findOperationRequest(context: InvocationContext): OperationRequest | undefined {
  return context.findItem(requestKey);
}

/**
 * 返回解码好的请求对象：原始调用在 Validate 阶段解码之后才有，类型化调用一开始就有（RFC-0011 规则 3）
 */
export function findDecodedRequest(context: InvocationContext): unknown {
  return context.findItem(decodedKey)?.value;
}

/**
 * 返回处理器成功产出的响应对象（RFC-0011 规则 3）；处理器执行之前或失败时为 `undefined`
 *
 * @remarks
 * 中间件看到的是编码之前的结果：XGI 入口在管道结束之后才把它编码成载荷（RFC-0011 规则 10「编码」）
 */
export function findOperationResponse(context: InvocationContext): unknown {
  return context.findItem(responseKey)?.value;
}

/**
 * 让操作经过完整管道执行（RFC-0011「调用器」）
 *
 * @remarks
 * 管道里加入三个内置步骤，位置与 .NET 内核的内置中间件相同（RFC-0011 规则 10，ADR-0236）：都按归属 `xihan.kernel.core`
 * 放在所在阶段的 `Beginning`，与同位置的其他中间件按 RFC-0004 的规则排序（归属的序数序，同归属按登记顺序，调用方的登记在前）：
 * - Observe：{@link BuiltInStep.Observe} 把排在它之后的中间件与处理器抛出的异常翻译成失败；排在它之前的
 *   （Ingress 阶段，或 Observe 阶段 `Beginning` 上归属排在 `xihan.kernel.core` 之前的，如缺省的 `app`）抛出的异常原样交给调用方。
 * - Resilience：{@link BuiltInStep.Deadline} 进入时截止时间已到即以 `KERNEL_TIMEOUT_001` + `kernel.invocation.deadline_before_start`
 *   结束，进入时不核对取消。
 * - Validate：{@link BuiltInStep.Validation} 把原始调用的载荷解码成请求，失败即 `KERNEL_VALIDATION_001`；类型化调用跳过。
 *
 * 管道的终点在 handle 阶段之后分派当前操作。描述、请求与终点放在上下文的对象袋里，派生上下文共享它们，
 * 所以一次调用用一个上下文，不要让并发的调用共用同一个
 */
export class OperationInvoker {
  /** 登记表 */
  readonly registry: OperationRegistry;
  readonly #step: Step;

  /**
   * 用登记表与管道构建调用器
   *
   * @param builder - 管道；缺省为空管道。调用器在它的复制上加入内置步骤，不改它
   * @throws {@link FrameworkError} 管道排序失败时，码为 `KERNEL_PIPELINE_00x`；管道里已有同名的内置步骤时为 `KERNEL_PIPELINE_003`
   */
  constructor(registry: OperationRegistry, builder?: PipelineBuilder) {
    this.registry = registry;
    this.#step = (builder ?? new PipelineBuilder())
      .clone()
      .useAt(observeStep, PipelineStage.Observe, Placement.Beginning, KernelOwner)
      .useAt(deadlineStep, PipelineStage.Resilience, Placement.Beginning, KernelOwner)
      .useAt(validationStep, PipelineStage.Validate, Placement.Beginning, KernelOwner)
      .build(dispatch);
  }

  /**
   * 执行一个 XGI 请求
   *
   * @remarks
   * 进入管道前只核对未登记（`KERNEL_NOTFOUND_001`）；截止时间、解码与异常翻译在管道里的内置步骤上（见类的说明）。
   * 管道以成功结束却没有响应（中间件以成功短路）返回 `KERNEL_UNEXPECTED_001` + `kernel.operation.no_response`（RFC-0011 规则 9）。
   * 管道结束之后才把响应编码成载荷（RFC-0011 规则 10「编码」）：数字按值模型写，非有限的浮点写不出；写不出时以
   * `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception` 结束，异常是 FrameworkError 时它的错误放进 `inner`，
   * 不抛给调用方，没有载荷
   *
   * @throws 排在 Observe 内置步骤之前的中间件抛出的异常原样传出
   */
  async invoke(context: InvocationContext, request: OperationRequest): Promise<OperationResponse> {
    const descriptor = this.registry.find(request.id);
    if (descriptor === undefined) {
      return { outcome: Result.fail(notFound(request.id)), payload: undefined };
    }
    const { handler } = internalsOf(descriptor);
    enter(context, descriptor, request, undefined, async (current) => {
      const decoded = current.findItem(decodedKey);
      if (decoded === undefined) {
        throw foreignContext();
      }
      const result = await handler(current, decoded.value);
      if (result.ok) {
        current.setItem(responseKey, { value: result.value });
      }
      return result.toVoid();
    });
    const outcome = await this.#step(context);
    if (!outcome.ok) {
      return { outcome, payload: undefined };
    }
    const response = context.findItem(responseKey);
    if (response === undefined) {
      return { outcome: Result.fail(noResponse(request.id)), payload: undefined };
    }
    const encoded = encodeResponse(response.value);
    return encoded.ok ? { outcome, payload: encoded.value } : { outcome: encoded.toVoid(), payload: undefined };
  }

  /**
   * 类型化入口：不经 JSON，直接以请求对象执行
   *
   * @remarks
   * 进入管道前按顺序核对：未登记返回 `KERNEL_NOTFOUND_001`，契约不是登记的那一份返回 `KERNEL_VALIDATION_002`（只带 `id`）。
   * Validate 阶段的解码跳过；中间件以成功短路、处理器没有执行时，没有响应可交，返回 `KERNEL_UNEXPECTED_001` + `kernel.operation.no_response`
   *
   * @throws 同 {@link OperationInvoker.invoke}
   */
  async invokeTyped<Req, Res>(
    context: InvocationContext,
    contract: OperationContract<Req, Res>,
    request: Req,
  ): Promise<Result<Res>> {
    const descriptor = this.registry.find(contract.id);
    if (descriptor === undefined) {
      return Result.fail(notFound(contract.id));
    }
    if (descriptor.contract !== contract) {
      // 只带操作 ID：类型名是实现语言的，各语言写不出同样的参数（RFC-0011「错误码」，ADR-0236）
      return Result.fail(
        ErrorInfo.validation(OperationErrorCode.TypeMismatch, OperationMessageKey.TypeMismatch, { id: contract.id }),
      );
    }
    const { handler } = internalsOf(descriptor);
    let result: Result<Res> | undefined;
    enter(context, descriptor, { id: contract.id }, { value: request }, async (current) => {
      const decoded = current.findItem(decodedKey);
      if (decoded === undefined) {
        throw foreignContext();
      }
      result = (await handler(current, decoded.value)) as Result<Res>;
      if (result.ok) {
        current.setItem(responseKey, { value: result.value });
      }
      return result.toVoid();
    });
    const outcome = await this.#step(context);
    if (!outcome.ok) {
      return Result.fail(outcome.error);
    }
    return result ?? Result.fail(noResponse(contract.id));
  }
}

/** 管道以成功结束而没有响应 */
function noResponse(id: string): ErrorInfo {
  return ErrorInfo.unexpected(OperationErrorCode.Unexpected, OperationMessageKey.NoResponse, { id });
}

/**
 * 进管道前把这次调用的描述、请求、类型化的请求与终点写进对象袋
 *
 * @remarks
 * 每次调用都重写终点并清掉上一次的解码结果与响应：同一个上下文上先后的调用不会用到上一次的终点或响应
 */
function enter(
  context: InvocationContext,
  descriptor: OperationDescriptor,
  request: OperationRequest,
  typed: { readonly value: unknown } | undefined,
  terminal: Step,
): void {
  context.setItem(descriptorKey, descriptor);
  context.setItem(requestKey, request);
  context.setItem(terminalKey, terminal);
  context.deleteItem(responseKey);
  if (typed === undefined) {
    context.deleteItem(decodedKey);
  } else {
    context.setItem(decodedKey, typed);
  }
}

/**
 * 管道的终点：执行这次调用的终点
 *
 * @remarks
 * 管道只经调用器进入，终点总在对象袋里；找不到说明有中间件把不是这次调用派生的上下文交给了下游，是中间件的缺陷
 */
async function dispatch(context: InvocationContext): Promise<Result<void>> {
  const terminal = context.findItem(terminalKey);
  if (terminal === undefined) {
    throw foreignContext();
  }
  return terminal(context);
}

function foreignContext(): FrameworkError {
  return new FrameworkError(
    ErrorCode.InvalidArgument,
    'A middleware passed a context that was not derived from this invocation to the next step.',
  );
}

/**
 * Observe 阶段的内置步骤：把下游抛出的异常翻译成失败（RFC-0011 规则 5）
 *
 * @remarks
 * 中止异常（调用的信号已触发、抛出的是它的原因或 AbortError / TimeoutError）按上下文的取消归因（RFC-0003 第 1 条），
 * 截止时间已触发即 `KERNEL_TIMEOUT_001`；其余异常是 `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception`，
 * 没有参数，与 .NET 的 Observe 阶段一样只在 FrameworkError 时带内部错误，不把异常消息写上线
 */
const observeStep: Middleware = middleware(BuiltInStep.Observe, async (context, next) => {
  try {
    return await next(context);
  } catch (error) {
    const cancellation = context.cancellation;
    if (cancellation !== undefined && isAbort(error, context.signal)) {
      return Result.fail(cancellation);
    }
    return Result.fail(
      ErrorInfo.unexpected(
        OperationErrorCode.Unexpected,
        InvocationMessageKey.UnhandledException,
        undefined,
        error instanceof FrameworkError ? error.toErrorInfo() : undefined,
      ),
    );
  }
});

/** 截止时间已过才进入 Resilience 阶段的失败（RFC-0011「错误码」） */
const deadlineBeforeStart = ErrorInfo.timeout(
  InvocationErrorCode.DeadlineExceeded,
  InvocationMessageKey.DeadlineBeforeStart,
);

/**
 * Resilience 阶段的内置步骤：进入时按时钟核对截止时间，已到即结束，后面的中间件与处理器不执行
 *
 * @remarks
 * 构造上下文时不做这项判断，进入时也不核对取消。途中的超时与取消按 RFC-0003 第 1 条归因，与 .NET 的 `DeadlineMiddleware` 相同：
 * 下游抛出的中止，截止信号已触发即 `KERNEL_TIMEOUT_001`，否则是调用方的取消 `KERNEL_CANCELLED_001`；下游把取消写成了
 * `KERNEL_CANCELLED_001` 结果而截止信号已触发的，按超时报告。取消与截止时间只经信号通知，这里不强行中止下游：
 * 不与信号赛跑、不丢弃处理器的 Promise，信号触发之后处理器照常返回结果的，调用以那个结果结束
 */
const deadlineStep: Middleware = middleware(BuiltInStep.Deadline, async (context, next) => {
  if (context.isExpired(Date.now())) {
    return Result.fail(deadlineBeforeStart);
  }
  let outcome: Result<void>;
  try {
    outcome = await next(context);
  } catch (error) {
    const cancellation = context.cancellation;
    if (cancellation !== undefined && isAbort(error, context.signal)) {
      return Result.fail(cancellation);
    }
    throw error;
  }
  const cancellation = context.cancellation;
  if (
    !outcome.ok &&
    outcome.error.code === InvocationErrorCode.Cancelled &&
    cancellation?.code === InvocationErrorCode.DeadlineExceeded
  ) {
    return Result.fail(cancellation);
  }
  return outcome;
});

/** Validate 阶段的内置步骤：原始调用在这里解码载荷（RFC-0011 规则 2）；类型化调用已有请求，跳过 */
const validationStep: Middleware = middleware(BuiltInStep.Validation, async (context, next) => {
  if (context.findItem(decodedKey) !== undefined) {
    return next(context);
  }
  const descriptor = context.findItem(descriptorKey);
  const request = context.findItem(requestKey);
  if (descriptor === undefined || request === undefined) {
    throw foreignContext();
  }
  const decoded = decodePayload(descriptor.contract.id, request.payload, internalsOf(descriptor).request);
  if (!decoded.ok) {
    return decoded.toVoid();
  }
  context.setItem(decodedKey, { value: decoded.value });
  return next(context);
});

/** 判断抛出的异常是不是这次调用的中止：信号的原因本身，或名为 AbortError / TimeoutError 的错误 */
function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (error === signal.reason) {
    return true;
  }
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'AbortError' || name === 'TimeoutError';
}
