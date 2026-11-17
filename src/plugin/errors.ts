import { InvocationErrorCode, InvocationMessageKey } from '../invocation/index.ts';
import { OperationErrorCode, OperationMessageKey } from '../operation/index.ts';
import { ErrorInfo } from '../primitives/index.ts';
import { CallbackPermission, PluginErrorCode, PluginMessageKey } from './protocol.ts';

/**
 * 写进 `reason` 参数的固定英文文本（plugin/invocation.md §8，plugin-messages.json 的 `reasons`）；不本地化
 *
 * @internal
 */
export const PluginReason = Object.freeze({
  /** `Configure` 的 `configuration` 不是 JSON 对象（lifecycle.md §7.2） */
  ConfigurationNotObject: 'the configuration is not a JSON object',
  /** `XIHAN_PLUGIN_HOST_ADDRESS` 缺失、不合法或没有插件能连的项（handshake.md §4） */
  NoCallbackEndpoint: 'no supported callback endpoint',
  /** 插件读宿主：`Status.ok` 为假却没有 `error`（invocation.md §3） */
  HostFailureWithoutError: 'the host reported a failure without an error',
} as const);

/**
 * 对方写来的错误码不合文法时的 `reason`（invocation.md §3）
 *
 * @internal
 */
export function invalidErrorCodeReason(code: string): string {
  return `invalid error code '${code}'`;
}

/**
 * `Host.Publish` 的结果数与信封数不同时的 `reason`（invocation.md §5）
 *
 * @internal
 */
export function resultCountReason(results: number, envelopes: number): string {
  return `the host returned ${results} results for ${envelopes} envelopes`;
}

/** gRPC 状态码 0–16 的 PascalCase 名字（invocation.md §3），下标即状态码 */
const grpcStatusNames: readonly string[] = Object.freeze([
  'OK',
  'Cancelled',
  'Unknown',
  'InvalidArgument',
  'DeadlineExceeded',
  'NotFound',
  'AlreadyExists',
  'PermissionDenied',
  'ResourceExhausted',
  'FailedPrecondition',
  'Aborted',
  'OutOfRange',
  'Unimplemented',
  'Internal',
  'Unavailable',
  'DataLoss',
  'Unauthenticated',
]);

/**
 * gRPC 状态码的 PascalCase 名字（invocation.md §3）；0–16 之外的状态码规范没有名字，写成十进制数
 *
 * @internal
 */
export function grpcStatusName(code: number): string {
  return grpcStatusNames[code] ?? String(code);
}

/**
 * `reason` 里的 `<状态名>: <说明>`（invocation.md §3）：说明原样取状态的消息，可以为空
 *
 * @internal
 */
export function statusReason(code: number, message: string): string {
  return `${grpcStatusName(code)}: ${message}`;
}

/**
 * 回调抛出时的 `reason`：异常的简单类型名（lifecycle.md §7.6）
 *
 * @remarks
 * 对象取构造函数的名字（`TypeError`、作者自己的异常类名），不带异常的文本，文本可能含路径、连接串，只写进 stderr 日志；
 * 没有构造函数名的对象写 `Object`。JavaScript 能抛出任何值：字符串、数字等原始值写对应的包装类型名（`String`、`Number`），
 * `null` 与 `undefined` 写它们自己
 *
 * @internal
 */
export function thrownTypeName(thrown: unknown): string {
  if (thrown === null) {
    return 'null';
  }
  switch (typeof thrown) {
    case 'object':
    case 'function': {
      const name = (thrown as { constructor?: { name?: unknown } }).constructor?.name;
      return typeof name === 'string' && name !== '' ? name : 'Object';
    }
    case 'string':
      return 'String';
    case 'number':
      return 'Number';
    case 'boolean':
      return 'Boolean';
    case 'bigint':
      return 'BigInt';
    case 'symbol':
      return 'Symbol';
    default:
      return 'undefined';
  }
}

/**
 * `PLUGINS_UNAVAILABLE_001` + `plugins.process.unavailable`：不在可服务状态时到达的调用与投递（lifecycle.md §7.3）
 *
 * @internal
 */
export function processUnavailable(id: string, state: string): ErrorInfo {
  return ErrorInfo.unavailable(PluginErrorCode.Unavailable, PluginMessageKey.Unavailable, { id, state });
}

/**
 * `PLUGINS_UNEXPECTED_001` + `plugins.process.failed`：`phase` 一律小写（`configure`、`start`、`stop`、`health`、
 * `invoke`、`publish`，或回调的操作 ID）
 *
 * @internal
 */
export function processFailed(id: string, phase: string, reason: string): ErrorInfo {
  return ErrorInfo.unexpected(PluginErrorCode.Unexpected, PluginMessageKey.Failed, { id, phase, reason });
}

/**
 * `KERNEL_NOTFOUND_001` + `plugins.event.unsubscribed`：投递找不到订阅（invocation.md §4），空方式写 `competing`
 *
 * @internal
 */
export function eventUnsubscribed(id: string, topic: string, type: string, mode: string): ErrorInfo {
  return ErrorInfo.notFound(OperationErrorCode.NotFound, PluginMessageKey.Unsubscribed, {
    id,
    topic,
    type,
    mode: mode === '' ? 'competing' : mode,
  });
}

/**
 * `PLUGINS_UNAVAILABLE_001` + `plugins.host.unavailable`：回调连不上宿主、没有可用的回调端点（invocation.md §5）
 *
 * @internal
 */
export function hostUnavailable(id: string, reason: string): ErrorInfo {
  return ErrorInfo.unavailable(PluginErrorCode.Unavailable, PluginMessageKey.HostUnavailable, { id, reason });
}

/**
 * `PLUGINS_DENIED_002` + `plugins.callback.denied`：回调所需的权限未声明或未授予（invocation.md §5）
 *
 * @internal
 */
export function callbackDenied(id: string, permission: string): ErrorInfo {
  return ErrorInfo.denied(PluginErrorCode.CallbackDenied, PluginMessageKey.CallbackDenied, { id, permission });
}

/**
 * `PLUGINS_DENIED_002` + `plugins.callback.tenant_denied`：回调带了不属于在途调用的租户（invocation.md §5）
 *
 * @internal
 */
export function tenantDenied(id: string, tenant: string): ErrorInfo {
  return ErrorInfo.denied(PluginErrorCode.CallbackDenied, PluginMessageKey.TenantDenied, { id, tenant });
}

/**
 * `PLUGINS_DENIED_002` + `plugins.callback.session_invalid`：宿主拒绝了会话令牌，没有参数
 *
 * @internal
 */
export function sessionInvalid(): ErrorInfo {
  return ErrorInfo.denied(PluginErrorCode.CallbackDenied, PluginMessageKey.SessionInvalid);
}

/**
 * 回调的两种 RPC（invocation.md §5）
 *
 * @internal
 */
export type CallbackRpc = 'invoke' | 'publish';

/** gRPC 状态码里映射表单独列出的几个（数值与 `@grpc/grpc-js` 的 `status` 相同；这里单列，换算不必加载 gRPC） */
const GrpcCode = Object.freeze({
  Cancelled: 1,
  InvalidArgument: 3,
  DeadlineExceeded: 4,
  PermissionDenied: 7,
  Unimplemented: 12,
  Unavailable: 14,
  Unauthenticated: 16,
} as const);

/**
 * gRPC 状态码 `Unavailable`：连接失败按它映射
 *
 * @internal
 */
export const grpcUnavailable = GrpcCode.Unavailable;

/**
 * 插件一侧回调的 gRPC 失败映射成错误（invocation.md §5 的表，向量 spec/conformance/vectors/plugin/callback-status.json）
 *
 * @param rpc - `invoke` 或 `publish`
 * @param code - gRPC 状态码；连接失败按 `Unavailable` 传入
 * @param message - 状态的消息，原样写进 `reason`
 * @param contextCancelled - 回调所在的调用上下文的取消信号是否已触发
 * @param pluginId - 插件的清单 ID
 * @param operation - `Host.Invoke` 的操作 ID；`Host.Publish` 不用
 *
 * @internal
 */
export function mapCallbackStatus(
  rpc: CallbackRpc,
  code: number,
  message: string,
  contextCancelled: boolean,
  pluginId: string,
  operation: string,
): ErrorInfo {
  switch (code) {
    case GrpcCode.Unauthenticated:
      return sessionInvalid();
    case GrpcCode.PermissionDenied:
      return callbackDenied(pluginId, rpc === 'invoke' ? CallbackPermission.Invoke : CallbackPermission.Publish);
    case GrpcCode.DeadlineExceeded:
      return ErrorInfo.timeout(InvocationErrorCode.DeadlineExceeded, InvocationMessageKey.DeadlineExceeded);
    case GrpcCode.Cancelled:
      // 只有调用方确实取消时才算取消，超时的归因交给插件自己管道里的截止时间步骤（RFC-0003）；
      // 调用方没有取消的 Cancelled 是连接被宿主或网络切断，与 Unavailable 同样处理
      return contextCancelled
        ? ErrorInfo.cancelled(InvocationErrorCode.Cancelled, InvocationMessageKey.Cancelled)
        : hostUnavailable(pluginId, statusReason(code, message));
    case GrpcCode.Unavailable:
      return hostUnavailable(pluginId, statusReason(code, message));
  }
  // Unimplemented 与 InvalidArgument 只对 Host.Invoke 有操作层面的含义；Host.Publish 的这两种状态落到最后一项
  if (rpc === 'invoke' && code === GrpcCode.Unimplemented) {
    return ErrorInfo.notFound(OperationErrorCode.NotFound, OperationMessageKey.NotFound, { id: operation });
  }
  if (rpc === 'invoke' && code === GrpcCode.InvalidArgument) {
    return ErrorInfo.validation(OperationErrorCode.InvalidPayload, OperationMessageKey.InvalidPayload, {
      id: operation,
      reason: message,
    });
  }
  return processFailed(pluginId, rpc === 'invoke' ? operation : 'publish', statusReason(code, message));
}
