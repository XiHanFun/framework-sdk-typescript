import { credentials, Metadata, type ServiceError } from '@grpc/grpc-js';

import { type InvocationContext, ItemKey } from '../invocation/index.ts';
import type { OperationResponse } from '../operation/index.ts';
import { type ErrorInfo, Result } from '../primitives/index.ts';
import {
  type Envelope,
  fromBytes,
  fromStatus,
  metadataFromContext,
  tenantOf,
  toBytes,
  toProtoEnvelope,
} from './conversion.ts';
import {
  type CallbackRpc,
  callbackDenied,
  grpcUnavailable,
  hostUnavailable,
  mapCallbackStatus,
  PluginReason,
  processFailed,
  resultCountReason,
  statusReason,
  tenantDenied,
} from './errors.ts';
import { HostClient, type InvokeResponse, type PublishResponse } from './gen/plugin.ts';
import { CallbackPermission, type PluginEndpoint, PluginProtocol } from './protocol.ts';

/**
 * 宿主此刻交给插件处理的调用的租户（plugin/invocation.md §2、§5）
 *
 * @remarks
 * 计数而不是集合：同一租户可以同时有多个在途的调用，最后一个结束时才不再算交给了插件
 *
 * @internal
 */
export class TenantLedger {
  readonly #counts = new Map<string, number>();

  /** 一个带租户的调用开始 */
  enter(tenant: string | undefined): void {
    if (tenant !== undefined) {
      this.#counts.set(tenant, (this.#counts.get(tenant) ?? 0) + 1);
    }
  }

  /** 一个带租户的调用结束 */
  leave(tenant: string | undefined): void {
    if (tenant === undefined) {
      return;
    }
    const count = (this.#counts.get(tenant) ?? 0) - 1;
    if (count > 0) {
      this.#counts.set(tenant, count);
    } else {
      this.#counts.delete(tenant);
    }
  }

  /** 宿主此刻是否把这个租户的调用交给了插件 */
  has(tenant: string): boolean {
    return this.#counts.has(tenant);
  }
}

/** 调用上下文对象袋里放宿主客户端的键 */
const hostKey = new ItemKey<Host>('plugin.host');

/**
 * 取当前调用的宿主回调客户端；上下文不是插件运行时交给处理器的时为 `undefined`
 *
 * @remarks
 * 插件运行时在每次 `Invoke` 与事件投递的上下文里放入它；宿主没有给出可用的回调端点时也放入，这时回调以
 * `PLUGINS_UNAVAILABLE_001` + `plugins.host.unavailable` 失败（handshake.md §4）
 */
export function findHost(context: InvocationContext): Host | undefined {
  return context.findItem(hostKey);
}

/**
 * 把宿主客户端放进调用上下文
 *
 * @internal
 */
export function attachHost(context: InvocationContext, host: Host): void {
  context.setItem(hostKey, host);
}

/**
 * 宿主回调服务 `Host` 的客户端（plugin/invocation.md §5）
 *
 * @remarks
 * 回调端点按 handshake.md §4 取 `XIHAN_PLUGIN_HOST_ADDRESS` 里第一个本 SDK 能连的项，之后不换；没有可用的项时不发请求，
 * 回调以 `PLUGINS_UNAVAILABLE_001` + `plugins.host.unavailable`（`reason` 为 `no supported callback endpoint`）失败。
 * 发出之前在本地按宿主的顺序核对，与宿主给出同样的错误、不合即不发请求：所需权限既在清单 `permissions` 里、也在
 * `Configure` 的 `granted_permissions` 里，否则 `plugins.callback.denied`；上下文的 `xihan.tenant` 必须是插件此刻正在处理的
 * 某个调用或投递的租户，否则 `plugins.callback.tenant_denied`。每次回调都在元数据 `xihan-plugin-session` 里带会话令牌，
 * 宿主以插件身份执行（主体 ID 为清单 ID）。连接是惰性的，第一次回调才建立
 */
export class Host {
  /** 选中的宿主回调端点；没有可用的项时为 `undefined` */
  readonly endpoint: PluginEndpoint | undefined;
  readonly #session: string;
  readonly #pluginId: string;
  readonly #tenants: TenantLedger;
  readonly #permitted: (permission: string) => boolean;
  #client: HostClient | undefined;
  #closed = false;

  /**
   * @internal 由插件运行时创建
   *
   * @param permitted - 回调所需的权限是否既在清单里声明、又被宿主授予
   */
  constructor(
    endpoint: PluginEndpoint | undefined,
    session: string,
    pluginId: string,
    tenants: TenantLedger,
    permitted: (permission: string) => boolean,
  ) {
    this.endpoint = endpoint;
    this.#session = session;
    this.#pluginId = pluginId;
    this.#tenants = tenants;
    this.#permitted = permitted;
  }

  /**
   * 经宿主的完整管道调用一个操作（`Host.Invoke`，需要权限 `capability:kernel.pipeline`）
   *
   * @remarks
   * 元数据取自上下文：traceparent、截止时间（UTC、七位小数）与已登记的 Baggage，`trace_state` 为空；gRPC 调用的截止时间与
   * 上下文相同，上下文的信号触发即取消回调。业务失败是宿主返回的 `Status.error`，按 invocation.md §3 的读入规则还原；
   * gRPC 失败按 invocation.md §5 的表换成原语层错误
   *
   * @param payload - 请求的 JSON 文本或 UTF-8 字节；缺省为空，宿主按 `{}` 处理
   */
  async invoke(
    context: InvocationContext,
    operation: string,
    payload?: string | Uint8Array,
  ): Promise<OperationResponse> {
    const reply = await this.#call<InvokeResponse>(
      context,
      'invoke',
      operation,
      CallbackPermission.Invoke,
      (client, metadata, options, done) =>
        client.invoke(
          { operation, payload: toBytes(payload), metadata: metadataFromContext(context) },
          metadata,
          options,
          done,
        ),
    );
    if (!reply.ok) {
      return { outcome: Result.fail(reply.error), payload: undefined };
    }
    const outcome = fromStatus(reply.value.status, this.#pluginId, operation);
    return outcome.ok ? { outcome, payload: fromBytes(reply.value.payload) } : { outcome, payload: undefined };
  }

  /**
   * 经宿主的消息代理发布消息（`Host.Publish`，需要权限 `capability:messaging.queue`）
   *
   * @remarks
   * 批量：一次调用发出全部信封，结果与 `envelopes` 一一对应；空集合不发出调用、返回空数组，重复的信封照样逐项发出。
   * 本地的权限与上下文租户核对、没有可用的回调端点与 RPC 失败都是整批的结果，每一项都是同一个错误。信封的 `xihantenant`
   * 不在本地核对，由宿主逐项判定（宿主在它之前还核对发布器与主题，本地先判会改变错误的先后，invocation.md §5）。
   * 宿主返回的结果数与信封数不同时，每一项都是 `PLUGINS_UNEXPECTED_001` + `plugins.process.failed`（`phase` 为 `publish`）。
   * 上下文的信号在途中触发即取消整批，结果按上面的表归因
   */
  async publish(context: InvocationContext, envelopes: readonly Envelope[]): Promise<Result<void>[]> {
    if (envelopes.length === 0) {
      return [];
    }
    const reply = await this.#call<PublishResponse>(
      context,
      'publish',
      'publish',
      CallbackPermission.Publish,
      (client, metadata, options, done) =>
        client.publish(
          { envelopes: envelopes.map(toProtoEnvelope), metadata: metadataFromContext(context) },
          metadata,
          options,
          done,
        ),
    );
    if (!reply.ok) {
      return envelopes.map(() => Result.fail(reply.error));
    }
    const results = reply.value.results;
    if (results.length !== envelopes.length) {
      const failure = processFailed(this.#pluginId, 'publish', resultCountReason(results.length, envelopes.length));
      return envelopes.map(() => Result.fail(failure));
    }
    return results.map((status) => fromStatus(status, this.#pluginId, 'publish'));
  }

  /**
   * 断开与宿主的连接；之后的回调以 `PLUGINS_UNAVAILABLE_001` + `plugins.host.unavailable` 失败
   */
  close(): void {
    this.#closed = true;
    this.#client?.close();
    this.#client = undefined;
  }

  /**
   * 发出之前的本地核对：没有可用的端点，然后按宿主的顺序核对权限与租户（invocation.md §5），最后是已经关闭、
   * 上下文已经中止；都通过时为 `undefined`
   */
  #refusal(context: InvocationContext, permission: string): ErrorInfo | undefined {
    if (this.endpoint === undefined) {
      return hostUnavailable(this.#pluginId, PluginReason.NoCallbackEndpoint);
    }
    if (!this.#permitted(permission)) {
      return callbackDenied(this.#pluginId, permission);
    }
    const tenant = tenantOf(context);
    if (tenant !== undefined && !this.#tenants.has(tenant)) {
      return tenantDenied(this.#pluginId, tenant);
    }
    if (this.#closed) {
      return hostUnavailable(this.#pluginId, statusReason(grpcUnavailable, 'the host client is closed'));
    }
    // 已经中止的调用不再发出：发出去 gRPC 也只会立即以 Cancelled 或 DeadlineExceeded 结束
    return context.cancellation;
  }

  /** 发出一次一元回调：带会话令牌与截止时间，上下文的信号触发即取消 */
  #call<T>(
    context: InvocationContext,
    rpc: CallbackRpc,
    operation: string,
    permission: string,
    start: (
      client: HostClient,
      metadata: Metadata,
      options: { deadline?: Date },
      done: (error: ServiceError | null, value: T) => void,
    ) => { cancel(): void },
  ): Promise<Result<T>> {
    const refusal = this.#refusal(context, permission);
    if (refusal !== undefined) {
      return Promise.resolve(Result.fail(refusal));
    }
    const metadata = new Metadata();
    metadata.set(PluginProtocol.sessionMetadataKey, this.#session);
    const options = context.deadline === undefined ? {} : { deadline: new Date(context.deadline) };
    return new Promise((resolve) => {
      const client = this.#connect(this.endpoint as PluginEndpoint);
      const call = start(client, metadata, options, (error, value) => {
        context.signal.removeEventListener('abort', abort);
        if (error === null) {
          resolve(Result.ok(value));
          return;
        }
        // 连接失败 grpc-js 也报 Unavailable；取消看的是回调上下文自己的信号（invocation.md §5）
        const failure = mapCallbackStatus(
          rpc,
          error.code,
          error.details ?? '',
          context.signal.aborted,
          this.#pluginId,
          operation,
        );
        resolve(Result.fail(failure));
      });
      const abort = () => call.cancel();
      context.signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** 第一次回调时连接选中的宿主端点 */
  #connect(endpoint: PluginEndpoint): HostClient {
    if (this.#client === undefined) {
      // grpc-js 的 unix 解析器把路径原样交给 net：Unix 上是套接字路径，Windows 上 \\.\pipe\ 开头的路径是命名管道
      const target = endpoint.network === 'tcp' ? endpoint.address : `unix:${endpoint.address}`;
      this.#client = new HostClient(target, credentials.createInsecure());
    }
    return this.#client;
  }
}
