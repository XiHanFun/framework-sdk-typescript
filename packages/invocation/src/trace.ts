/**
 * W3C Trace Context 的追踪标识
 */
export interface TraceContext {
  /** 追踪 ID：32 位小写十六进制，不全为零 */
  readonly traceId: string;
  /** Span ID（W3C 的 parent-id）：16 位小写十六进制，不全为零 */
  readonly spanId: string;
  /**
   * trace-flags，0–255；没有时表示没有上游，这次调用是链路的根（RFC-0003 第 7 条）
   *
   * @remarks
   * 是否采样只看最低位，其余位原样保留、不解释
   */
  readonly flags?: number | undefined;
}

/** W3C traceparent：version-traceid-spanid-flags */
const traceParentPattern = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;
const allZero = /^0+$/;

/** 没有上游、又没有采样器时写出的标志：按已采样传下去，由下游的采样器决定（RFC-0003 第 7 条「写出」） */
const rootFlags = 0x01;

/**
 * 解析 W3C traceparent；不合法（格式不对、版本是 `ff`、ID 全为零）时为 `undefined`
 */
export function parseTraceParent(traceParent: string): TraceContext | undefined {
  const match = traceParentPattern.exec(traceParent);
  if (match === null) {
    return undefined;
  }
  const [, version, traceId = '', spanId = '', flags = ''] = match;
  if (version === 'ff' || allZero.test(traceId) || allZero.test(spanId)) {
    return undefined;
  }
  return { traceId, spanId, flags: Number.parseInt(flags, 16) };
}

/**
 * 格式化 W3C traceparent：`00-<trace-id>-<span-id>-<flags>`
 *
 * @remarks
 * 标志总是两位十六进制：没有标志（根调用）写 `01`，上游给的标志（含 `00`）原样写出
 */
export function formatTraceParent(trace: TraceContext): string {
  const flags = (trace.flags ?? rootFlags).toString(16).padStart(2, '0');
  return `00-${trace.traceId}-${trace.spanId}-${flags}`;
}

/**
 * 判断标志是否表示采样：只看最低位；没有标志按已采样
 */
export function isSampled(flags: number | undefined): boolean {
  return ((flags ?? rootFlags) & 0x01) === 0x01;
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
