/**
 * 调用上下文（RFC-0003）：取消与截止时间、W3C 追踪、已登记的 Baggage 与请求作用域对象袋
 *
 * @remarks
 * 取消与截止时间基于 `AbortSignal`（`AbortSignal.any` / `AbortSignal.timeout`），不绑定任何协议
 *
 * @packageDocumentation
 */

export {
  cancellationOf,
  InvocationContext,
  type InvocationContextOptions,
  InvocationErrorCode,
  InvocationMessageKey,
  ItemKey,
} from './context.ts';
export {
  formatTraceParent,
  isSampled,
  isSpanId,
  isTraceId,
  newSpanId,
  newTraceId,
  parseTraceParent,
  type TraceContext,
} from './trace.ts';
