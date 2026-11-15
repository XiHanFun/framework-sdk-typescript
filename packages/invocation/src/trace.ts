/**
 * W3C Trace Context 的追踪标识
 */
export interface TraceContext {
  /** 追踪 ID：32 位小写十六进制，不全为零 */
  readonly traceId: string;
  /** Span ID（W3C 的 parent-id）：16 位小写十六进制，不全为零 */
  readonly spanId: string;
  /** 是否采样（trace-flags 的采样位 `01`） */
  readonly sampled: boolean;
}

/** W3C traceparent：version-traceid-spanid-flags */
const traceParentPattern = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;
const allZero = /^0+$/;

/**
 * 解析 W3C traceparent；不合法（格式不对、ID 全为零）时为 `undefined`
 */
export function parseTraceParent(traceParent: string): TraceContext | undefined {
  const match = traceParentPattern.exec(traceParent);
  if (match === null) {
    return undefined;
  }
  const [, , traceId = '', spanId = '', flags] = match;
  if (allZero.test(traceId) || allZero.test(spanId)) {
    return undefined;
  }
  return { traceId, spanId, sampled: flags === '01' };
}

/**
 * 格式化 W3C traceparent：`00-<trace-id>-<span-id>-<flags>`
 */
export function formatTraceParent(trace: TraceContext): string {
  return `00-${trace.traceId}-${trace.spanId}-${trace.sampled ? '01' : '00'}`;
}

/**
 * 判断追踪 ID 是否合法：32 位小写十六进制，不全为零
 */
export function isTraceId(traceId: string): boolean {
  return traceIdPattern.test(traceId) && !allZero.test(traceId);
}

/**
 * 判断 Span ID 是否合法：16 位小写十六进制，不全为零
 */
export function isSpanId(spanId: string): boolean {
  return spanIdPattern.test(spanId) && !allZero.test(spanId);
}

/**
 * 生成 32 位小写十六进制的追踪 ID
 */
export function newTraceId(): string {
  return randomHex(16);
}

/**
 * 生成 16 位小写十六进制的 Span ID
 */
export function newSpanId(): string {
  return randomHex(8);
}

/**
 * 生成 n 字节随机数的十六进制；用 Web Crypto，Node 与浏览器都有
 */
function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  // 全零的 ID 在 W3C 里不合法，概率可以忽略，但仍重抽一次以保证输出总是合法
  do {
    crypto.getRandomValues(buffer);
  } while (buffer.every((byte) => byte === 0));
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
