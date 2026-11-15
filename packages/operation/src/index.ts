/**
 * 操作契约与 XGI 消息（RFC-0011）
 *
 * @remarks
 * 业务以操作为单位声明，调用器让它经过完整管道并在 handle 阶段执行；请求与响应用 JSON 编解码，JSON 是 XGI 的规范编码
 *
 * @packageDocumentation
 */

export {
  defineContract,
  Expose,
  isOperationId,
  type OperationContract,
  type OperationContractInit,
  OperationErrorCode,
  OperationMessageKey,
} from './contract.ts';
export {
  findOperation,
  findOperationRequest,
  findOperationResponsePayload,
  OperationInvoker,
} from './invoker.ts';
export {
  OperationDescriptor,
  type OperationHandler,
  type OperationRegistration,
  OperationRegistry,
  type OperationRequest,
  type OperationResponse,
  type OperationSchema,
  type RequestDecoder,
} from './registry.ts';
