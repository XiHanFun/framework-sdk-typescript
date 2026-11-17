import { InvocationContext } from '../invocation/index.ts';
import {
  BaggageKey,
  defaultLocale,
  ErrorInfo,
  isBaggageKeyRegistered,
  isErrorCode,
  isMessageKey,
  JsonMembers,
  type JsonObject,
  type LifecycleState,
  lifecycleStateOrdinal,
  Result,
  readJsonText,
  resolveMessage,
  toJsonValue,
  writeJson,
} from '../primitives/index.ts';
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
 * 码不合错误码文法时整个错误换成 `PLUGINS_UNEXPECTED_001` + `plugins.process.failed`（`phase` 为 `invoke`，
 * `reason` 为 `invalid error code '<code>'`）；消息键合文法的按键还原、不带文案，否则是自由文本错误，文案取 `text`，
 * 为空时取 `code`；`details` 为空、通不过共同 JSON 读取检查或不是对象时当作没有细节；`inner` 同此
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
  return ErrorInfo.literal(error.code, error.text === '' ? error.code : error.text, details, inner);
}

/** `details` 文本：空、语法错误、重复成员或不是对象都当作没有细节 */
function readDetails(text: string): JsonObject | undefined {
  if (text === '') {
    return undefined;
  }
  const read = readJsonText(text);
  return read.ok && read.root instanceof JsonMembers ? (toJsonValue(read.root) as JsonObject) : undefined;
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
 * 把宿主写来的 `Status` 还原为结果；失败却没有错误时为 `PLUGINS_UNEXPECTED_001` + `plugins.process.failed`
 * （`reason` 为 `the host reported a failure without an error`，invocation.md §3）
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
  for (const [key, value] of Object.entries(metadata?.baggage ?? {})) {
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
    baggage: { ...context.withoutUnregisteredBaggage().baggage },
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
  readonly data: Uint8Array;
  readonly extensions: Readonly<Record<string, string>>;
}

/**
 * 把信封编码为协议消息；规范版本与内容类型取缺省值
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
    extensions: { ...envelope.extensions },
  };
}

/**
 * 把协议消息还原为信封
 *
 * @internal
 */
export function fromProtoEnvelope(envelope: pb.Envelope): DeliveredEnvelope {
  return Object.freeze({
    topic: envelope.topic,
    id: envelope.id,
    source: envelope.source,
    type: envelope.type,
    specVersion: envelope.specVersion,
    subject: envelope.subject,
    time: envelope.time,
    dataContentType: envelope.dataContentType,
    data: envelope.data,
    extensions: Object.freeze({ ...envelope.extensions }),
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
