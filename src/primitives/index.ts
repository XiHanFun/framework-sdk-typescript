/**
 * XiHan Framework 原语层（RFC-0001）的 TypeScript 形态
 *
 * @remarks
 * 错误与错误码、Result、Maybe、类型化标识、生命周期状态、管道阶段、稳定性、Baggage 键与消息原语。
 * 零依赖、只增不改；语义与线上编码和 .NET 参考实现一致，由 framework-spec 的一致性向量验证
 *
 * @packageDocumentation
 */

export {
  BaggageKey,
  isBaggageKeyRegistered,
  isBaggageKeyWellFormed,
  isBaggageValueAcceptable,
  maxBaggageValueLength,
  registeredBaggageKeys,
} from './baggage.ts';
export { builtInMessages, builtInTemplates, PrimitivesMessageKey } from './built-in-messages.ts';
export {
  ErrorCode,
  ErrorKind,
  errorCodeDomain,
  errorCodeKind,
  isErrorCode,
  validateErrorCode,
} from './error-code.ts';
export { ErrorInfo, type ErrorInfoJson } from './error-info.ts';
export { FrameworkError, type FrameworkErrorOptions, FrameworkInfo } from './framework.ts';
export {
  defineMember,
  Float64,
  freezeJsonObject,
  isIntegerNumber,
  isPlainObject,
  JsonMembers,
  type JsonNode,
  JsonNumber,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  maxInt64,
  maxJsonDepth,
  minInt64,
} from './json.ts';
export { JsonPath } from './json-path.ts';
export {
  type JsonTextProblem,
  type JsonTextRead,
  parseJson,
  readJsonText,
  toJsonValue,
} from './json-text.ts';
export { floatText, type JsonWriteOptions, quoteJsonString, writeJson } from './json-writer.ts';
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
  formatValue,
  isLocaleName,
  isMessageKey,
  type MessageArguments,
  MessageCatalog,
  type MessageResolver,
  maxMessageKeyLength,
  messageKeyDomain,
  type NumberSymbols,
  numberSymbols,
  placeholders,
  positional,
  resolveMessage,
  setDefaultMessages,
  tryFormatMessage,
  validateMessageKey,
} from './messages.ts';
export { isOperationId, maxOperationIdLength, validateOperationId } from './operation-id.ts';
export { Fail, Ok, Result, ResultBase, type ResultJson } from './result.ts';
export { isStability, Stability, stabilities, stabilityOrdinal } from './stability.ts';
export { isPipelineStage, PipelineStage, pipelineStageOrdinal, pipelineStages } from './stage.ts';
export { type TypedId, typedId } from './typed-id.ts';
