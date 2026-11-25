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
  type LifecycleState,
  lifecycleStateOrdinal,
  Result,
  readJsonText,
  resolveMessage,
  toJsonValue,
  writeJson,
} from '../primitives/index.ts';
import { isBlank } from '../primitives/whitespace.ts';
import { effectiveDeadline, formatDeadline } from './deadline.ts';
import { invalidErrorCodeReason, PluginReason, processFailed } from './errors.ts';
import type * as pb from './gen/plugin.ts';
import { pluginMessages } from './messages.ts';

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/**
 * 把字符串或字节换成 UTF-8 字节
 *
 * @internal
 */
export function toBytes(value: string | Uint8Array | undefined): Uint8Array {
  if (value === undefined) {
    return new Uint8Array();
  }
  return typeof value === 'string' ? utf8.encode(value) : value;
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
 * `details` 是按值模型写出的 JSON 对象文本，没有或为空时为空串；`inner` 同样写出
 *
 * @internal
 */
export function toProtoError(error: ErrorInfo): pb.Error {
  const details = error.details;
  return {
    code: error.code,
    messageKey: error.messageKey ?? '',
    text: error.messageKey === undefined ? error.message : '',
    details: details === undefined || Object.keys(details).length === 0 ? '' : writeJson(details),
    inner: error.inner === undefined ? undefined : toProtoError(error.inner),
  };
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
  /** CloudEvents `time`（RFC 3339） */
  readonly time?: string;
  /** CloudEvents `datacontenttype`；发布时缺省为 `application/json` */
  readonly dataContentType?: string;
  /**
   * CloudEvents `dataschema`（数据遵循的模式，URI）；省略或空串表示没有
   *
   * @remarks
   * 原样写给宿主、原样交给处理器（invocation.md §4，ADR-0305）：SDK 不裁剪、不核对 URI 语法，只有空白的值由宿主拒绝那一项
   */
  readonly dataSchema?: string;
  /** CloudEvents `data`：字节，或按 UTF-8 编码的文本 */
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
  readonly time: string;
  readonly dataContentType: string;
  /** 宿主写来的 `data_schema`，空串表示没有 */
  readonly dataSchema: string;
  readonly data: Uint8Array;
  readonly extensions: Readonly<Record<string, string>>;
}

/**
 * 把信封编码为协议消息；规范版本与内容类型取缺省值，`dataSchema` 原样写进 `data_schema`（没有即空串）
 *
 * @internal
 */
export function toProtoEnvelope(envelope: Envelope): pb.Envelope {
  return {
    topic: envelope.topic,
    id: envelope.id,
    source: envelope.source,
    type: envelope.type,
    specVersion: envelope.specVersion || '1.0',
    subject: envelope.subject ?? '',
    time: envelope.time ?? '',
    dataContentType: envelope.dataContentType || 'application/json',
    data: toBytes(envelope.data),
    extensions: new Map(Object.entries(envelope.extensions ?? {})),
    dataSchema: envelope.dataSchema ?? '',
  };
}

/**
 * 把协议消息还原为信封；`data_schema` 原样交出（空串即没有）
 *
 * @internal
 */
export function fromProtoEnvelope(envelope: pb.Envelope): DeliveredEnvelope {
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
    time: envelope.time,
    dataContentType: envelope.dataContentType,
    dataSchema: envelope.dataSchema,
    data: envelope.data,
    extensions: Object.freeze(extensions),
  });
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
