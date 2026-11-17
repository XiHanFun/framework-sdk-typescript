import { InvocationContext, InvocationErrorCode, InvocationMessageKey, ItemKey } from '../invocation/index.ts';
import { OperationErrorCode, OperationMessageKey } from '../operation/index.ts';
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
import type * as pb from './gen/plugin.ts';
import { pluginMessages } from './messages.ts';
import { PluginErrorCode, PluginMessageKey } from './protocol.ts';

/** 上游的 W3C tracestate：调用上下文不解析它，回调时原样带回宿主 */
export const traceStateKey = new ItemKey<string>('plugin.trace-state');

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
 * 错误的文案：已解析的文案优先，其次进程默认目录、插件运行时自己的目录，最后是 {@link ErrorInfo.message} 的回退链
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
 * 把原语层错误编码为协议的 `Error`（plugin/invocation.md §3）
 *
 * @remarks
 * 字段与 RFC-0001 的 JSON 编码一一对应：`text` 是已解析的文案，`details` 是按值模型写出的 JSON 对象文本，空的细节不写
 *
 * @internal
 */
export function toProtoError(error: ErrorInfo, locale?: string): pb.Error {
  const details = error.details;
  return {
    code: error.code,
    messageKey: error.messageKey ?? '',
    text: messageOf(error, locale),
    details: details === undefined || Object.keys(details).length === 0 ? '' : writeJson(details),
    inner: error.inner === undefined ? undefined : toProtoError(error.inner, locale),
  };
}

/**
 * 把协议的 `Error` 还原为原语层错误
 *
 * @remarks
 * 码不合文法时换成 `PLUGINS_UNEXPECTED_001` + `plugins.process.failed`，原码写进 `reason`；消息键不合文法时按 Literal 还原，
 * 文案为空时以码作文案；`details` 不是 JSON 对象时当作没有细节
 *
 * @internal
 */
export function fromProtoError(error: pb.Error, pluginId: string, phase: string): ErrorInfo {
  if (!isErrorCode(error.code)) {
    return ErrorInfo.unexpected(PluginErrorCode.Unexpected, PluginMessageKey.Failed, {
      id: pluginId,
      phase,
      reason: `invalid error code '${error.code}'`,
    });
  }
  const details = readDetails(error.details);
  const inner = error.inner === undefined ? undefined : fromProtoError(error.inner, pluginId, phase);
  if (error.messageKey !== '' && isMessageKey(error.messageKey)) {
    const keyed = ErrorInfo.create(error.code, error.messageKey, details, inner);
    return error.text === '' ? keyed : keyed.withText(error.text);
  }
  return ErrorInfo.literal(error.code, error.text === '' ? error.code : error.text, details, inner);
}

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
export function toStatus(result: Result<unknown>, locale?: string): pb.Status {
  return result.ok ? { ok: true, error: undefined } : { ok: false, error: toProtoError(result.error, locale) };
}

/**
 * 把协议的 `Status` 还原为结果；失败却没有错误时为 `PLUGINS_UNEXPECTED_001`
 *
 * @internal
 */
export function fromStatus(status: pb.Status | undefined, pluginId: string, phase: string): Result<void> {
  if (status?.ok === true) {
    return Result.success();
  }
  if (status?.error === undefined) {
    return Result.fail(
      ErrorInfo.unexpected(PluginErrorCode.Unexpected, PluginMessageKey.Failed, {
        id: pluginId,
        phase,
        reason: 'the status carries no error',
      }),
    );
  }
  return Result.fail(fromProtoError(status.error, pluginId, phase));
}

/** RFC 3339 的时间文本：日期、`T`、时间、可选的小数秒、`Z` 或时区偏移 */
const rfc3339Pattern =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2})[Tt]([0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]+))?([Zz]|[+-][0-9]{2}:[0-9]{2})$/;

/**
 * 解析 RFC 3339 时间为 Unix 毫秒；不合文法时为 `undefined`
 *
 * @remarks
 * 小数秒只取到毫秒、多余的位截掉：截止时间只会提前不到 1 毫秒，不会比宿主给的晚
 *
 * @internal
 */
export function parseRfc3339(text: string): number | undefined {
  const match = rfc3339Pattern.exec(text);
  if (match === null) {
    return undefined;
  }
  const [, date = '', time = '', fraction, zone = ''] = match;
  const milliseconds = fraction === undefined ? '' : `.${fraction.slice(0, 3).padEnd(3, '0')}`;
  const value = Date.parse(`${date}T${time}${milliseconds}${zone.toUpperCase()}`);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 从协议的上下文元数据还原调用上下文（plugin/invocation.md §2，RFC-0003）
 *
 * @remarks
 * - 截止时间取元数据的 `deadline`（RFC 3339 UTC），没有或读不出时取 gRPC 调用自己的截止时间；二者按规范相同。
 * - 追踪取 `trace_parent`，不合法的当作没给（RFC-0003 第 7 条）；`trace_state` 放进对象袋，回调时带回。
 * - Baggage 只收已登记的键（RFC-0003 第 3 条：载体入站只收已登记的键），值不合约束的成员丢弃。
 * - `signal` 是这次 gRPC 调用的取消
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
  const deadline = (metadata?.deadline ? parseRfc3339(metadata.deadline) : undefined) ?? callDeadline;
  const context = InvocationContext.create({
    signal,
    baggage,
    ...(deadline === undefined ? {} : { deadline }),
    ...(metadata?.traceParent ? { traceParent: metadata.traceParent } : {}),
  });
  if (metadata?.traceState) {
    context.setItem(traceStateKey, metadata.traceState);
  }
  return context;
}

/**
 * 把调用上下文编码为协议的上下文元数据：追踪、截止时间与已登记的 Baggage（RFC-0003 第 3 条，出站只写已登记的键）
 *
 * @internal
 */
export function metadataFromContext(context: InvocationContext): pb.InvocationMetadata {
  return {
    traceParent: context.traceParent,
    traceState: context.findItem(traceStateKey) ?? '',
    deadline: context.deadline === undefined ? '' : new Date(context.deadline).toISOString(),
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
export function fromProtoEnvelope(envelope: pb.Envelope | undefined): DeliveredEnvelope {
  return Object.freeze({
    topic: envelope?.topic ?? '',
    id: envelope?.id ?? '',
    source: envelope?.source ?? '',
    type: envelope?.type ?? '',
    specVersion: envelope?.specVersion ?? '',
    subject: envelope?.subject ?? '',
    time: envelope?.time ?? '',
    dataContentType: envelope?.dataContentType ?? '',
    data: envelope?.data ?? new Uint8Array(),
    extensions: Object.freeze({ ...envelope?.extensions }),
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
 * 回调失败时 gRPC 状态到原语层错误的映射（plugin/invocation.md §3 的映射表，handshake.md §4）
 *
 * @remarks
 * 调用方的信号已触发、gRPC 报 `Cancelled` 或 `DeadlineExceeded` 时按上下文归因（截止信号已触发即超时，RFC-0003 第 1 条）；
 * `Unauthenticated` 与 `PermissionDenied` 是 `PLUGINS_DENIED_002`；`Unimplemented` 与 `InvalidArgument` 是操作未登记与载荷不合法；
 * 其余按传输失败
 *
 * @internal
 */
export function fromGrpcStatus(
  status: { readonly code: number; readonly details: string },
  call: {
    readonly context: InvocationContext;
    readonly pluginId: string;
    readonly phase: string;
    readonly target: string;
    readonly permission: string;
  },
): ErrorInfo {
  const cancellation = call.context.cancellation;
  switch (status.code) {
    case GrpcCode.Cancelled:
      return (
        cancellation ?? transport(PluginErrorCode.Unavailable, call.pluginId, call.phase, 'Cancelled', status.details)
      );
    case GrpcCode.DeadlineExceeded:
      return (
        cancellation ?? ErrorInfo.timeout(InvocationErrorCode.DeadlineExceeded, InvocationMessageKey.DeadlineExceeded)
      );
    case GrpcCode.Unavailable:
      return transport(PluginErrorCode.Unavailable, call.pluginId, call.phase, 'Unavailable', status.details);
    case GrpcCode.Unauthenticated:
      return ErrorInfo.denied(PluginErrorCode.CallbackDenied, PluginMessageKey.SessionInvalid);
    case GrpcCode.PermissionDenied:
      return ErrorInfo.denied(PluginErrorCode.CallbackDenied, PluginMessageKey.CallbackDenied, {
        id: call.pluginId,
        permission: call.permission,
      });
    case GrpcCode.Unimplemented:
      return ErrorInfo.notFound(OperationErrorCode.NotFound, OperationMessageKey.NotFound, { id: call.target });
    case GrpcCode.InvalidArgument:
      return ErrorInfo.validation(OperationErrorCode.InvalidPayload, OperationMessageKey.InvalidPayload, {
        id: call.target,
        reason: status.details,
      });
    default:
      return transport(
        PluginErrorCode.Unexpected,
        call.pluginId,
        call.phase,
        grpcCodeName(status.code),
        status.details,
      );
  }
}

/** 传输层失败：码按映射表，文案是插件运行时的 `plugins.process.failed`，`reason` 是 gRPC 状态与它的说明 */
function transport(code: string, pluginId: string, phase: string, status: string, details: string): ErrorInfo {
  const reason = details === '' ? status : `${status}: ${details}`;
  return ErrorInfo.create(code, PluginMessageKey.Failed, { id: pluginId, phase, reason });
}

/**
 * gRPC 状态码（与 `@grpc/grpc-js` 的 `status` 相同的数值）；这里单列，换算不必加载 gRPC
 *
 * @internal
 */
export const GrpcCode = Object.freeze({
  Ok: 0,
  Cancelled: 1,
  Unknown: 2,
  InvalidArgument: 3,
  DeadlineExceeded: 4,
  NotFound: 5,
  AlreadyExists: 6,
  PermissionDenied: 7,
  ResourceExhausted: 8,
  FailedPrecondition: 9,
  Aborted: 10,
  OutOfRange: 11,
  Unimplemented: 12,
  Internal: 13,
  Unavailable: 14,
  DataLoss: 15,
  Unauthenticated: 16,
} as const);

function grpcCodeName(code: number): string {
  for (const [name, value] of Object.entries(GrpcCode)) {
    if (value === code) {
      return name;
    }
  }
  return `code ${code}`;
}

/**
 * 当前调用的租户；没有时为 `undefined`
 *
 * @internal
 */
export function tenantOf(context: InvocationContext): string | undefined {
  return context.findBaggage(BaggageKey.Tenant);
}
