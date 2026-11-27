import { InvocationContext } from '../invocation/index.ts';
import {
  BaggageKey,
  defaultLocale,
  defineMember,
  ErrorInfo,
  Float64,
  isBaggageKeyRegistered,
  isErrorCode,
  isMessageKey,
  isPlainObject,
  JsonMembers,
  JsonNumber,
  type JsonObject,
  type JsonValue,
  type JsonWriteOptions,
  type LifecycleState,
  lifecycleStateOrdinal,
  Result,
  readJsonText,
  resolveMessage,
  toJsonValue,
  writeJson,
} from '../primitives/index.ts';
import { isBlank } from '../primitives/whitespace.ts';
import { effectiveDeadline, formatDeadline, parseDeadline } from './deadline.ts';
import { invalidErrorCodeReason, PluginReason, processFailed } from './errors.ts';
import type * as pb from './gen/plugin.ts';
import { pluginMessages } from './messages.ts';

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/**
 * 原样交出字节；没有时是空字节
 *
 * @remarks
 * 只收字节：要发出的字符串一律经 {@link toStrictUtf8}，不经 `TextEncoder` 把孤立的代理项换成 U+FFFD（ADR-0315）
 *
 * @internal
 */
export function toBytes(value: Uint8Array | undefined): Uint8Array {
  return value ?? new Uint8Array();
}

/**
 * 把字符串严格编码成 UTF-8（RFC-0001「JSON 文本」的写出与转交，ADR-0312、ADR-0315）；有孤立的代理项、编码不成时为 `undefined`
 *
 * @remarks
 * `TextEncoder` 把孤立的代理项换成 U+FFFD 照样编码，得到的是另一份文本，所以先逐个码元核对代理项成对。
 * 不用 `String.prototype.isWellFormed`：Node 22 有它，但构建的 `lib` 是 ES2023，类型里没有
 *
 * @internal
 */
export function toStrictUtf8(text: string): Uint8Array | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) {
      // 高代理项之后必须紧跟低代理项，成对的跳过低代理项；单独的低代理项与末尾的高代理项都编码不成
      const next = text.charCodeAt(index + 1);
      if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) {
        return undefined;
      }
      index += 1;
    }
  }
  return utf8.encode(text);
}

/**
 * 把 UTF-8 字节换成字符串；不合法的序列换成 U+FFFD
 *
 * @internal
 */
export function fromBytes(value: Uint8Array): string {
  return utf8Decoder.decode(value);
}

/**
 * 错误在插件这一侧的文案（日志用）：已解析的文案优先，其次进程默认目录、插件运行时自己的目录，最后是
 * {@link ErrorInfo.message} 的回退链
 *
 * @internal
 */
export function messageOf(error: ErrorInfo, locale: string = defaultLocale()): string {
  if (error.text !== undefined || error.messageKey === undefined) {
    return error.message;
  }
  return (
    resolveMessage(error.messageKey, error.details) ??
    pluginMessages.resolve(error.messageKey, locale, error.details) ??
    error.message
  );
}

/**
 * 把原语层错误编码为协议的 `Error`（plugin/invocation.md §3「写出」）
 *
 * @remarks
 * `code`、`message_key` 原样；带消息键的错误 `text` 留空，由宿主按目录翻译成调用方的语言（RFC-0010），
 * 不按任何区域在插件里渲染，作者用 `withText` 填进去的文案也不写；只有自由文本错误（{@link ErrorInfo.literal}）写 `text`。
 * `details` 是按值模型写出的 JSON 对象文本，没有或为空时为空串，写不出时也为空串（见 {@link writeDetails}）；`inner` 同样写出。
 * `text` 里孤立的代理项换成 U+FFFD（见 {@link scrubText}）
 *
 * @internal
 */
export function toProtoError(error: ErrorInfo): pb.Error {
  return {
    code: error.code,
    messageKey: error.messageKey ?? '',
    text: error.messageKey === undefined ? scrubText(error.message) : '',
    details: writeDetails(error.details),
    inner: error.inner === undefined ? undefined : toProtoError(error.inner),
  };
}

/** 孤立的代理项：带 `u` 标志时成对的代理项是一个码点、不属于 `Cs`，匹配到的只有孤立的 */
const loneSurrogate = /\p{Cs}/gu;

/**
 * 把错误文案里孤立的代理项换成 U+FFFD（invocation.md §3「写出 `Error` 的文案」，ADR-0339）
 *
 * @remarks
 * 文案是自由文本，不拒绝写出：每个孤立的代理项是 Unicode §3.9 的一个最大子部分，换一个 U+FFFD，成对的照抄，长度不变，
 * 与 .NET 的 `Encoding.UTF8` 相同。二进制写出经 `TextEncoder` 本来也是这样换，这里显式换掉，不依赖 protobuf 库的缺省，
 * 换一种写法（如 JSON 写成 `\ud800` 转义）也不变。不用 `String.prototype.toWellFormed`：构建的 `lib` 是 ES2023，类型里没有
 */
function scrubText(text: string): string {
  return text.replace(loneSurrogate, '\uFFFD');
}

/** 写错误细节的选项：孤立的代理项、超过 64 层与重复的成员名写不出，非有限的浮点仍按值模型写成字符串 */
const detailsWriteOptions: JsonWriteOptions = Object.freeze({
  nonFinite: 'string',
  loneSurrogates: 'reject',
  nesting: 'reject',
  duplicateMembers: 'reject',
});

/**
 * 写 `Error.details`：没有或为空时为空串
 *
 * @remarks
 * 写不出时这个错误不带细节、为空串，其余字段照写（invocation.md §3「写出」、RFC-0001「写出与转交」，ADR-0320）：细节里的字符串
 * （成员名与值）有孤立的代理项，或写出的文本没过共同检查（嵌套超过 64 层、重复的成员名）。不写成 `\ud800` 这样的转义：宿主读到
 * 这样的细节也当作没有，两边看到的相同；内部错误的细节各自核对
 */
function writeDetails(details: JsonObject | undefined): string {
  if (details === undefined || Object.keys(details).length === 0) {
    return '';
  }
  try {
    return writeJson(details, detailsWriteOptions);
  } catch (error) {
    // writeJson 写不出时抛 TypeError：细节不带出去，错误照常交给宿主；别的异常不是写不出，照常抛出
    if (error instanceof TypeError) {
      return '';
    }
    throw error;
  }
}

/**
 * 把宿主写来的 `Error` 还原为原语层错误（plugin/invocation.md §3「读入」）
 *
 * @remarks
 * 码不合错误码文法时整个错误换成 `PLUGINS_UNEXPECTED_001` + `plugins.process.failed`（`phase` 一律为 `invoke`，
 * `Host.Publish` 的结果也一样；`reason` 为 `invalid error code '<code>'`；原来的 `inner` 丢掉）；消息键合文法的按键还原、
 * 不取 `text`，否则是自由文本错误，文案取 `text`，为空或只有空白（RFC-0001「空白字符」）时取 `code`；`details` 按
 * {@link readDetails} 读；`inner` 同此。
 * 向量见 spec/conformance/vectors/plugin/error-reading.json
 *
 * @internal
 */
export function fromProtoError(error: pb.Error, pluginId: string): ErrorInfo {
  if (!isErrorCode(error.code)) {
    return processFailed(pluginId, 'invoke', invalidErrorCodeReason(error.code));
  }
  const details = readDetails(error.details);
  const inner = error.inner === undefined ? undefined : fromProtoError(error.inner, pluginId);
  if (error.messageKey !== '' && isMessageKey(error.messageKey)) {
    return ErrorInfo.create(error.code, error.messageKey, details, inner);
  }
  return ErrorInfo.literal(error.code, isBlank(error.text) ? error.code : error.text, details, inner);
}

/**
 * 读 `Error.details` 的 JSON 文本（invocation.md §3）：为空、只有空白、是空对象、通不过共同 JSON 读取检查、不是对象，
 * 或任何一层有读成双精度会溢出（±∞）的数时当作没有细节
 *
 * @remarks
 * 数按值模型读：64 位范围内整数写法的数是整数，其余是双精度，下溢的读成 0、超出 64 位的整数读成双精度。共同读取检查为写回时
 * 不变而保留原文的 `JsonNumber`，在这里换成双精度，与宿主读成 double 的值相同；只有空白的文本在共同读取检查里是语法错误
 *
 * @internal
 */
export function readDetails(text: string): JsonObject | undefined {
  if (text === '') {
    return undefined;
  }
  const read = readJsonText(text);
  // 空对象与没有细节相同
  if (!read.ok || !(read.root instanceof JsonMembers) || read.root.size === 0) {
    return undefined;
  }
  const details = detailValue(toJsonValue(read.root));
  return details === overflow ? undefined : (details as JsonObject);
}

/** {@link detailValue} 遇到溢出的数时的结果 */
const overflow = Symbol('overflow');

/** 把读出的值换成值模型：保留原文的数换成双精度，数组与对象逐项换算；任何一层有溢出的数时为 `overflow` */
function detailValue(value: JsonValue): JsonValue | typeof overflow {
  if (value instanceof JsonNumber) {
    const number = Number(value.text);
    if (!Number.isFinite(number)) {
      return overflow;
    }
    // 值恰好是整数的双精度装进 Float64：写回时仍是浮点（1E+20、0.0），与宿主读成 double 再写出相同
    return Number.isInteger(number) ? new Float64(number) : number;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const converted = detailValue(item);
      if (converted === overflow) {
        return overflow;
      }
      items.push(converted);
    }
    return items;
  }
  if (isPlainObject(value)) {
    const members: Record<string, JsonValue> = {};
    for (const [name, item] of Object.entries(value as JsonObject)) {
      const converted = detailValue(item);
      if (converted === overflow) {
        return overflow;
      }
      // 不用赋值：名为 __proto__ 的成员赋值会改原型
      defineMember(members, name, converted);
    }
    return members;
  }
  return value;
}

/**
 * 把结果编码为协议的 `Status`
 *
 * @internal
 */
export function toStatus(result: Result<unknown>): pb.Status {
  return result.ok ? { ok: true, error: undefined } : { ok: false, error: toProtoError(result.error) };
}

/**
 * 把宿主写来的 `Status` 还原为结果；失败却没有错误、或整个 `status` 缺失时为 `PLUGINS_UNEXPECTED_001` +
 * `plugins.process.failed`（`reason` 为 `the host reported a failure without an error`，invocation.md §3）
 *
 * @param phase - 没有错误时写进 `phase`：`Host.Invoke` 为操作 ID，`Host.Publish` 为 `publish`
 *
 * @internal
 */
export function fromStatus(status: pb.Status | undefined, pluginId: string, phase: string): Result<void> {
  if (status?.ok === true) {
    return Result.success();
  }
  if (status?.error === undefined) {
    return Result.fail(processFailed(pluginId, phase, PluginReason.HostFailureWithoutError));
  }
  return Result.fail(fromProtoError(status.error, pluginId));
}

/**
 * 从协议的上下文元数据还原调用上下文（plugin/invocation.md §2，RFC-0003）
 *
 * @remarks
 * - 截止时间：`deadline` 按严格文法读、读不出当作没有，与 gRPC 调用自身的截止时间取较早的一个。
 * - 追踪：`trace_parent` 按 RFC-0003 的文法取，不合文法即没有父 Span、生成新的追踪；`trace_state` 不进上下文。
 * - Baggage 只保留已登记的键，值不合约束的成员丢弃（RFC-0003 第 3 条）；`xihan.principal` 原样交给作者。
 * - `signal` 是这次调用的取消：gRPC 取消，以及停止时宽限到了、收尾时立即触发的取消（lifecycle.md §7.5、§7.7）
 *
 * @internal
 */
export function contextFromMetadata(
  metadata: pb.InvocationMetadata | undefined,
  signal: AbortSignal,
  callDeadline: number | undefined,
): InvocationContext {
  const baggage: Record<string, string> = {};
  for (const [key, value] of metadata?.baggage ?? []) {
    if (isBaggageKeyRegistered(key) && typeof value === 'string') {
      baggage[key] = value;
    }
  }
  const deadline = effectiveDeadline(metadata?.deadline ?? '', callDeadline);
  return InvocationContext.create({
    signal,
    baggage,
    ...(deadline === undefined ? {} : { deadline }),
    ...(metadata?.traceParent ? { traceParent: metadata.traceParent } : {}),
  });
}

/**
 * 把调用上下文编码为回调的上下文元数据（plugin/invocation.md §5）
 *
 * @remarks
 * `trace_parent` 是当前 Span 的 traceparent；`deadline` 按 §2 的写法（UTC、七位小数、`+00:00`），没有截止时间为空；
 * `baggage` 只写已登记的键（RFC-0003 第 3 条）；`trace_state` 为空
 *
 * @internal
 */
export function metadataFromContext(context: InvocationContext): pb.InvocationMetadata {
  return {
    traceParent: context.traceParent,
    traceState: '',
    deadline: context.deadline === undefined ? '' : formatDeadline(context.deadline),
    baggage: new Map(Object.entries(context.withoutUnregisteredBaggage().baggage)),
  };
}

/**
 * 一条 CloudEvents 1.0 消息（RFC-0009）：plugin.proto 的 `Envelope` 平铺成的属性
 */
export interface Envelope {
  /** 主题 */
  readonly topic: string;
  /** CloudEvents `id` */
  readonly id: string;
  /** CloudEvents `source` */
  readonly source: string;
  /** CloudEvents `type` */
  readonly type: string;
  /** CloudEvents `specversion`；发布时缺省为 `1.0` */
  readonly specVersion?: string;
  /** CloudEvents `subject` */
  readonly subject?: string;
  /**
   * CloudEvents `time`；省略或 `undefined` 表示没有
   *
   * @remarks
   * 发布时换算成 UTC 写成 RFC 3339：以 `Z` 结尾，秒的小数部分去掉末尾的 0、全为 0 时不写小数点，
   * 最多三位（`Date` 只到毫秒）。SDK 不在本地核对：年份不在 0001–9999 之间的时刻照 `toISOString` 的写法写出（`0000-…`、
   * 扩展年份 `+010000-…`），`Invalid Date` 写成它的文本，都由宿主以 `messaging.envelope.invalid_time` 拒绝那一项
   * （invocation.md §4，ADR-0293）
   */
  readonly time?: Date | undefined;
  /** CloudEvents `datacontenttype`；发布时缺省为 `application/json` */
  readonly dataContentType?: string;
  /**
   * CloudEvents `dataschema`（数据遵循的模式，URI）；省略或空串表示没有
   *
   * @remarks
   * 原样写给宿主、原样交给处理器（invocation.md §4，ADR-0305）：SDK 不裁剪、不核对 URI 语法，只有空白的值由宿主拒绝那一项
   */
  readonly dataSchema?: string;
  /**
   * CloudEvents `data`：字节，或按 UTF-8 编码的文本
   *
   * @remarks
   * 文本发布时严格编码成 UTF-8：有孤立的代理项时那一项不发出，在本地以 `MESSAGING_VALIDATION_002` + `messaging.envelope.invalid`
   * 失败，不换成 U+FFFD 照发；字节原样发出（invocation.md §5，ADR-0315）
   */
  readonly data?: Uint8Array | string;
  /** 扩展属性，如 `xihantenant`、`traceparent` */
  readonly extensions?: Readonly<Record<string, string>>;
}

/**
 * 投递给插件的消息：协议里的每个属性都在，`data` 是字节
 */
export interface DeliveredEnvelope extends Envelope {
  readonly specVersion: string;
  readonly subject: string;
  /**
   * 宿主写来的 `time` 读成的时刻；空串（没有时间）是 `undefined`
   *
   * @remarks
   * 按规范的时间文法读（invocation.md §4，与截止时间同一条，RFC-0003 规则 8）：带偏移的换算成 UTC，不认闰秒 `60`，小数一到九位。
   * `Date` 只到毫秒，第三位之后的小数截断、不进位（`…59.999999999Z` 读成 `…59.999Z`）；读不出的投递以 gRPC `InvalidArgument` 拒绝，
   * 不交给处理器
   */
  readonly time: Date | undefined;
  readonly dataContentType: string;
  /** 宿主写来的 `data_schema`，空串表示没有 */
  readonly dataSchema: string;
  readonly data: Uint8Array;
  readonly extensions: Readonly<Record<string, string>>;
}

/**
 * 把信封编码为协议消息；规范版本与内容类型取缺省值，`dataSchema` 原样写进 `data_schema`（没有即空串）
 *
 * @remarks
 * 字符串的 `data` 严格编码成 UTF-8，有孤立的代理项、编码不成时整个信封为 `undefined`，由 `Host.publish` 让那一项在本地失败
 * （plugin/invocation.md §5，ADR-0315）；字节的 `data` 原样写出，没有即空字节
 *
 * @internal
 */
export function toProtoEnvelope(envelope: Envelope): pb.Envelope | undefined {
  const data = typeof envelope.data === 'string' ? toStrictUtf8(envelope.data) : toBytes(envelope.data);
  if (data === undefined) {
    return undefined;
  }
  return {
    topic: envelope.topic,
    id: envelope.id,
    source: envelope.source,
    type: envelope.type,
    specVersion: envelope.specVersion || '1.0',
    subject: envelope.subject ?? '',
    time: envelope.time === undefined ? '' : formatEnvelopeTime(envelope.time),
    dataContentType: envelope.dataContentType || 'application/json',
    data,
    extensions: new Map(Object.entries(envelope.extensions ?? {})),
    dataSchema: envelope.dataSchema ?? '',
  };
}

/**
 * 把宿主写来的协议消息还原为信封：`time` 按 {@link readEnvelopeTime} 读，`data_schema` 原样交出（空串即没有）；
 * `time` 读不出时为 `undefined`
 *
 * @internal
 */
export function fromProtoEnvelope(envelope: pb.Envelope): DeliveredEnvelope | undefined {
  const time = readEnvelopeTime(envelope.time);
  if (time === null) {
    return undefined;
  }
  const extensions: Record<string, string> = {};
  for (const [name, value] of envelope.extensions) {
    extensions[name] = value;
  }
  return Object.freeze({
    topic: envelope.topic,
    id: envelope.id,
    source: envelope.source,
    type: envelope.type,
    specVersion: envelope.specVersion,
    subject: envelope.subject,
    time,
    dataContentType: envelope.dataContentType,
    dataSchema: envelope.dataSchema,
    data: envelope.data,
    extensions: Object.freeze(extensions),
  });
}

/**
 * 读宿主写来的 `Envelope.time`（invocation.md §4）：空串是没有（`undefined`），否则按截止时间文本的文法（RFC-0003 规则 8）读成
 * {@link Date}；读不出（不合文法或越界）时为 `null`
 *
 * @remarks
 * 与 {@link parseDeadline} 同一个读法：`Date` 只到毫秒，第三位之后的小数截断、不进位
 *
 * @internal
 */
export function readEnvelopeTime(text: string): Date | undefined | null {
  if (text === '') {
    return undefined;
  }
  const milliseconds = parseDeadline(text);
  return milliseconds === undefined ? null : new Date(milliseconds);
}

/**
 * 写出信封的时刻（invocation.md §4）：换算成 UTC、以 `Z` 结尾，秒的小数部分去掉末尾的 0、全为 0 时不写小数点
 *
 * @remarks
 * 各语言的 SDK 对同一时刻写出同一份文本（精度以内），`Date` 最多写三位小数。不核对范围：`toISOString` 对 0000–9999 以外的年份
 * 写成扩展年份（`+010000-…`），`Invalid Date` 没有时刻、写成 `String(time)`，都照写，由宿主逐项核对时拒绝那一项，
 * 不改变它与其余核对的先后（ADR-0293）
 *
 * @internal
 */
export function formatEnvelopeTime(time: Date): string {
  if (Number.isNaN(time.getTime())) {
    return String(time);
  }
  // toISOString 总是 UTC、三位小数、以 Z 结尾
  const text = time.toISOString();
  const dot = text.lastIndexOf('.');
  const fraction = text.slice(dot + 1, -1).replace(/0+$/, '');
  return fraction === '' ? `${text.slice(0, dot)}Z` : `${text.slice(0, dot + 1)}${fraction}Z`;
}

/**
 * 生命周期状态的协议数值：与原语层的序号相同（plugin.proto 的 `LifecycleState`，RFC-0001）
 *
 * @internal
 */
export function toProtoState(state: LifecycleState): pb.LifecycleState {
  return lifecycleStateOrdinal(state) as pb.LifecycleState;
}

/**
 * 当前调用的租户；没有时为 `undefined`
 *
 * @internal
 */
export function tenantOf(context: InvocationContext): string | undefined {
  return context.findBaggage(BaggageKey.Tenant);
}
