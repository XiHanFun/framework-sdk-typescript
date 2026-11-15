import { type InvocationContext, ItemKey } from '@xihan-framework/invocation';
import { PipelineBuilder, type Step } from '@xihan-framework/pipeline';
import { ErrorCode, ErrorInfo, Result } from '@xihan-framework/primitives';

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
   * 执行一个 XGI 请求
   *
   * @remarks
   * 未登记返回 `KERNEL_NOTFOUND_001`，不进管道；否则经完整管道执行。中间件或处理器抛出的异常原样传出
   */
  async invoke(context: InvocationContext, request: OperationRequest): Promise<OperationResponse> {
    const descriptor = this.registry.find(request.id);
    if (descriptor === undefined) {
      return { outcome: Result.fail(notFound(request.id)), payload: undefined };
    }
    enter(context, descriptor, request, async (current) => {
      const response = await descriptor.execute(current, request.payload);
      if (response.outcome.ok && response.payload !== undefined) {
        current.setItem(responseKey, response.payload);
      }
      return response.outcome;
    });
    const outcome = await this.#step(context);
    return outcome.ok ? { outcome, payload: context.findItem(responseKey) } : { outcome, payload: undefined };
  }

  /**
   * 类型化入口：不经 JSON，直接以请求对象执行
   *
   * @remarks
   * 要用登记时的同一份契约：契约不是登记的那一份返回 `KERNEL_VALIDATION_002`，未登记返回 `KERNEL_NOTFOUND_001`。
   * 中间件以成功短路、处理器没有执行时，没有响应可交，返回 `PRIMITIVES_VALIDATION_002`
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
      return Result.fail(
        ErrorInfo.validation(OperationErrorCode.TypeMismatch, OperationMessageKey.TypeMismatch, { id: contract.id }),
      );
    }
    const { handler } = internalsOf(descriptor);
    let result: Result<Res> | undefined;
    enter(context, descriptor, { id: contract.id }, async (current) => {
      result = (await handler(current, request)) as Result<Res>;
      return result.toVoid();
    });
    const outcome = await this.#step(context);
    if (!outcome.ok) {
      return Result.fail(outcome.error);
    }
    return (
      result ?? Result.fail(ErrorInfo.literal(ErrorCode.UninitializedResult, 'The result has not been initialized.'))
    );
  }
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

/** 管道的终点：执行这次调用的终点；不是经调用器进入的管道没有要执行的操作 */
async function dispatch(context: InvocationContext): Promise<Result<void>> {
  const terminal = context.findItem(terminalKey);
  if (terminal === undefined) {
    return Result.fail(ErrorInfo.notFound(OperationErrorCode.NotFound, OperationMessageKey.NotFound));
  }
  return terminal(context);
}
