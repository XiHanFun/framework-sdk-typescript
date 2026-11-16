import {
  type InvocationContext,
  InvocationErrorCode,
  InvocationMessageKey,
  ItemKey,
} from '@xihan-framework/invocation';
import { PipelineBuilder, type Step } from '@xihan-framework/pipeline';
import { ErrorCode, ErrorInfo, FrameworkError, Result } from '@xihan-framework/primitives';

import { type OperationContract, OperationErrorCode, OperationMessageKey } from './contract.ts';
import {
  internalsOf,
  notFound,
  type OperationDescriptor,
  type OperationRegistry,
  type OperationRequest,
  type OperationResponse,
} from './registry.ts';

/** 对象袋里的键：当前操作、XGI 请求、成功的响应载荷与这次调用的终点 */
const descriptorKey = new ItemKey<OperationDescriptor>('operation.descriptor');
const requestKey = new ItemKey<OperationRequest>('operation.request');
const responseKey = new ItemKey<string>('operation.response-payload');
const terminalKey = new ItemKey<Step>('operation.terminal');

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
 * 返回 handle 阶段写回的响应载荷；调用成功之前或失败时为 `undefined`
 */
export function findOperationResponsePayload(context: InvocationContext): string | undefined {
  return context.findItem(responseKey);
}

/**
 * 让操作经过完整管道执行（RFC-0011「调用器」）
 *
 * @remarks
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
   * @param builder - 管道；缺省为空管道
   * @throws {@link FrameworkError} 管道排序失败时，码为 `KERNEL_PIPELINE_00x`
   */
  constructor(registry: OperationRegistry, builder?: PipelineBuilder) {
    this.registry = registry;
    this.#step = (builder ?? new PipelineBuilder()).build(dispatch);
  }

  /**
   * 执行管道，把抛出的异常翻译成失败（RFC-0011 规则 5）
   *
   * @remarks
   * 中止异常（调用的信号已触发、抛出的是它的原因或 AbortError / TimeoutError）按上下文的取消归因，
   * 截止时间已触发即 `KERNEL_TIMEOUT_001`；其余异常是 `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception`，
   * 与 .NET 的 Observe 阶段一样只在 FrameworkError 时带内部错误，不把异常消息写上线
   */
  async #run(context: InvocationContext): Promise<Result<void>> {
    try {
      return await this.#step(context);
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
  }

  /**
   * 执行一个 XGI 请求
   *
   * @remarks
   * 未登记返回 `KERNEL_NOTFOUND_001`，截止时间已过才开始返回 `KERNEL_TIMEOUT_001` + `kernel.invocation.deadline_before_start`，
   * 都不进管道；否则经完整管道执行。管道以成功结束却没有响应（中间件以成功短路）
   * 返回 `KERNEL_UNEXPECTED_001` + `kernel.operation.no_response`（RFC-0011 规则 9）；中间件或处理器抛出的异常翻译为失败，
   * 不抛出（规则 5）
   */
  async invoke(context: InvocationContext, request: OperationRequest): Promise<OperationResponse> {
    const descriptor = this.registry.find(request.id);
    if (descriptor === undefined) {
      return { outcome: Result.fail(notFound(request.id)), payload: undefined };
    }
    if (startedTooLate(context)) {
      return { outcome: Result.fail(deadlineBeforeStart), payload: undefined };
    }
    enter(context, descriptor, request, async (current) => {
      const response = await descriptor.execute(current, request.payload);
      if (response.outcome.ok && response.payload !== undefined) {
        current.setItem(responseKey, response.payload);
      }
      return response.outcome;
    });
    const outcome = await this.#run(context);
    if (!outcome.ok) {
      return { outcome, payload: undefined };
    }
    const payload = context.findItem(responseKey);
    return payload === undefined
      ? { outcome: Result.fail(noResponse(request.id)), payload: undefined }
      : { outcome, payload };
  }

  /**
   * 类型化入口：不经 JSON，直接以请求对象执行
   *
   * @remarks
   * 要用登记时的同一份契约：契约不是登记的那一份返回 `KERNEL_VALIDATION_002`，未登记返回 `KERNEL_NOTFOUND_001`。
   * 中间件以成功短路、处理器没有执行时，没有响应可交，返回 `KERNEL_UNEXPECTED_001` + `kernel.operation.no_response`（RFC-0011 规则 9）；
   * 抛出的异常同 {@link OperationInvoker.invoke} 翻译为失败
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
      // TypeScript 的类型参数在运行期不存在，没有类型名可写：expected / actual 只给人看，写明是哪一份契约
      return Result.fail(
        ErrorInfo.validation(OperationErrorCode.TypeMismatch, OperationMessageKey.TypeMismatch, {
          id: contract.id,
          expected: 'the registered contract',
          actual: 'another contract object',
        }),
      );
    }
    if (startedTooLate(context)) {
      return Result.fail(deadlineBeforeStart);
    }
    const { handler } = internalsOf(descriptor);
    let result: Result<Res> | undefined;
    enter(context, descriptor, { id: contract.id }, async (current) => {
      result = (await handler(current, request)) as Result<Res>;
      return result.toVoid();
    });
    const outcome = await this.#run(context);
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
 * 进管道前把这次调用的描述、请求与终点写进对象袋
 *
 * @remarks
 * 每次调用都重写终点并清掉上一次的响应载荷：同一个上下文上先后的调用不会用到上一次的终点或载荷
 */
function enter(
  context: InvocationContext,
  descriptor: OperationDescriptor,
  request: OperationRequest,
  terminal: Step,
): void {
  context.setItem(descriptorKey, descriptor);
  context.setItem(requestKey, request);
  context.setItem(terminalKey, terminal);
  context.deleteItem(responseKey);
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
    throw new FrameworkError(
      ErrorCode.InvalidArgument,
      'A middleware passed a context that was not derived from this invocation to the next step.',
    );
  }
  return terminal(context);
}

/** 判断抛出的异常是不是这次调用的中止：信号的原因本身，或名为 AbortError / TimeoutError 的错误 */
function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (error === signal.reason) {
    return true;
  }
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** 截止时间已过才开始的调用的失败（RFC-0011「错误码」） */
const deadlineBeforeStart = ErrorInfo.timeout(
  InvocationErrorCode.DeadlineExceeded,
  InvocationMessageKey.DeadlineBeforeStart,
);

/**
 * 截止时间在调用开始前是否已过
 *
 * @remarks
 * SDK 没有截止时间中间件，由调用器在第一个中间件执行之前按时钟核对，已到即结束、管道不执行（RFC-0011 规则 10，ADR-0235）
 */
function startedTooLate(context: InvocationContext): boolean {
  return context.isExpired(Date.now());
}
