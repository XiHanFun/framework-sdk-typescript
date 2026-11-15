/**
 * XiHan Framework 原语层（RFC-0001）的 TypeScript 形态
 *
 * @remarks
 * 错误与错误码、Result、Maybe、类型化标识、生命周期状态、管道阶段、稳定性、Baggage 键与消息原语。
 * 零依赖、只增不改；语义与线上编码和 .NET 参考实现一致，由 framework-spec 的一致性向量验证
 *
 * @packageDocumentation
 */

export { BaggageKey, isBaggageKeyRegistered, isBaggageKeyWellFormed, registeredBaggageKeys } from './baggage.ts';
export {
  ErrorCode,
  ErrorKind,
  errorCodeDomain,
  errorCodeKind,
  isErrorCode,
  validateErrorCode,
} from './error-code.ts';
export { ErrorInfo, type ErrorInfoJson } from './error-info.ts';
export { FrameworkError, FrameworkInfo } from './framework.ts';
export { isPlainObject, type JsonObject, type JsonPrimitive, type JsonValue } from './json.ts';
export {
  canTransition,
  isLifecycleState,
  isServing,
  isTerminal,
  LifecycleState,
  lifecycleStateFromOrdinal,
  lifecycleStateOrdinal,
  lifecycleStates,
} from './lifecycle.ts';
export { Maybe, MaybeBase, None, Some } from './maybe.ts';
export {
  defaultLocale,
  describe,
  formatMessage,
  isLocaleName,
  isMessageKey,
  type MessageArguments,
  MessageCatalog,
  type MessageResolver,
  maxMessageKeyLength,
  messageKeyDomain,
  placeholders,
  positional,
  resolveMessage,
  setDefaultMessages,
  tryFormatMessage,
} from './messages.ts';
export { Fail, Ok, Result, ResultBase, type ResultJson } from './result.ts';
export { isStability, Stability, stabilities, stabilityOrdinal } from './stability.ts';
export { isPipelineStage, PipelineStage, pipelineStageOrdinal, pipelineStages } from './stage.ts';
export { type TypedId, typedId } from './typed-id.ts';
