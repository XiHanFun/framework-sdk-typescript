import { credentials, Metadata, type ServiceError } from '@grpc/grpc-js';

import { type InvocationContext, ItemKey } from '../invocation/index.ts';
import type { OperationResponse } from '../operation/index.ts';
import { ErrorInfo, Result } from '../primitives/index.ts';
import {
  type Envelope,
  fromBytes,
  fromGrpcStatus,
  fromStatus,
  GrpcCode,
  metadataFromContext,
  tenantOf,
  toBytes,
  toProtoEnvelope,
} from './conversion.ts';
import { HostClient, type InvokeResponse, type PublishResponse } from './gen/plugin.ts';
import {
  CallbackPermission,
  type PluginEndpoint,
  PluginErrorCode,
  PluginMessageKey,
  PluginProtocol,
} from './protocol.ts';

/** CloudEvents 扩展属性里的租户（RFC-0009「信封」） */
const tenantExtension = 'xihantenant';

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
 * 取当前调用的宿主回调客户端；宿主没有下发回调端点时为 `undefined`
 *
 * @remarks
 * 插件运行时在每次 `Invoke` 与事件投递的上下文里放入它
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
 * 每次回调都在元数据 `xihan-plugin-session` 里带会话令牌，宿主以插件身份执行（主体 ID 为清单 ID）。
 * 租户只能是宿主随调用交给插件的那一个：上下文或信封带的租户不是宿主此刻交给插件处理的某个调用的租户时，
 * 回调不发出，就地以 `PLUGINS_DENIED_002` + `plugins.callback.tenant_denied` 失败；宿主收到越界的租户同样拒绝。
 * 连接是惰性的，第一次回调才建立
 */
export class Host {
  /** 宿主回调端点 */
  readonly endpoint: PluginEndpoint;
  readonly #session: string;
  readonly #pluginId: string;
  readonly #tenants: TenantLedger;
  #client: HostClient | undefined;
  #closed = false;

  /** @internal 由插件运行时创建 */
  constructor(endpoint: PluginEndpoint, session: string, pluginId: string, tenants: TenantLedger) {
    this.endpoint = endpoint;
    this.#session = session;
    this.#pluginId = pluginId;
    this.#tenants = tenants;
  }

  /**
   * 经宿主的完整管道调用一个操作（`Host.Invoke`，需要权限 `capability:kernel.pipeline`）
   *
   * @remarks
   * 元数据取自上下文：追踪、截止时间与已登记的 Baggage；gRPC 调用的截止时间与上下文相同，上下文的信号触发即取消回调。
   * 业务失败是宿主返回的 `Status.error`；传输失败按映射表换成原语层错误（plugin/invocation.md §3）
   *
   * @param payload - 请求的 JSON 文本或 UTF-8 字节；缺省为空，宿主按 `{}` 处理
   */
  async invoke(
    context: InvocationContext,
    operation: string,
    payload?: string | Uint8Array,
  ): Promise<OperationResponse> {
    const denied = this.#deniedTenant(tenantOf(context));
    if (denied !== undefined) {
      return { outcome: Result.fail(denied), payload: undefined };
    }
    const reply = await this.#call<InvokeResponse>(
      context,
      'Host.Invoke',
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
    const outcome = fromStatus(reply.value.status, this.#pluginId, 'Host.Invoke');
    return outcome.ok ? { outcome, payload: fromBytes(reply.value.payload) } : { outcome, payload: undefined };
  }

  /**
   * 经宿主的消息代理发布消息（`Host.Publish`，需要权限 `capability:messaging.queue`）
   *
   * @remarks
   * 批量：一次调用发出全部信封，结果与 `envelopes` 一一对应；空集合不发出调用。上下文的租户越界时每一项都失败；
   * 信封的 `xihantenant` 扩展越界的那一项失败，其余照常发出（plugin/invocation.md §5）。传输失败时每一项都是同一个失败；
   * 宿主返回的结果少于发出的信封时，缺的项为 `PLUGINS_UNEXPECTED_001`
   */
  async publish(context: InvocationContext, envelopes: readonly Envelope[]): Promise<Result<void>[]> {
    const results: (Result<void> | undefined)[] = envelopes.map(() => undefined);
    const contextDenied = this.#deniedTenant(tenantOf(context));
    const sent: number[] = [];
    envelopes.forEach((envelope, index) => {
      const denied = contextDenied ?? this.#deniedTenant(envelope.extensions?.[tenantExtension]);
      if (denied === undefined) {
        sent.push(index);
      } else {
        results[index] = Result.fail(denied);
      }
    });
    if (sent.length > 0) {
      const reply = await this.#call<PublishResponse>(
        context,
        'Host.Publish',
        'Host.Publish',
        CallbackPermission.Publish,
        (client, metadata, options, done) =>
          client.publish(
            {
              envelopes: sent.map((index) => toProtoEnvelope(envelopes[index] as Envelope)),
              metadata: metadataFromContext(context),
            },
            metadata,
            options,
            done,
          ),
      );
      sent.forEach((index, position) => {
        if (!reply.ok) {
          results[index] = Result.fail(reply.error);
          return;
        }
        const status = reply.value.results[position];
        results[index] =
          status === undefined
            ? Result.fail(
                ErrorInfo.unexpected(PluginErrorCode.Unexpected, PluginMessageKey.Failed, {
                  id: this.#pluginId,
                  phase: 'Host.Publish',
                  reason: 'the host returned fewer results than envelopes',
                }),
              )
            : fromStatus(status, this.#pluginId, 'Host.Publish');
      });
    }
    return results.map((result) => result ?? Result.success());
  }

  /**
   * 断开与宿主的连接；之后的回调以 `PLUGINS_UNAVAILABLE_001` 失败
   */
  close(): void {
    this.#closed = true;
    this.#client?.close();
    this.#client = undefined;
  }

  /** 租户越界时的失败；没带租户或租户已交给插件时为 `undefined` */
  #deniedTenant(tenant: string | undefined): ErrorInfo | undefined {
    if (tenant === undefined || this.#tenants.has(tenant)) {
      return undefined;
    }
    return ErrorInfo.denied(PluginErrorCode.CallbackDenied, PluginMessageKey.TenantDenied, {
      id: this.#pluginId,
      tenant,
    });
  }

  /** 发出一次一元回调：带会话令牌与截止时间，上下文的信号触发即取消 */
  #call<T>(
    context: InvocationContext,
    phase: string,
    target: string,
    permission: string,
    start: (
      client: HostClient,
      metadata: Metadata,
      options: { deadline?: Date },
      done: (error: ServiceError | null, value: T) => void,
    ) => { cancel(): void },
  ): Promise<Result<T>> {
    const describe = { context, pluginId: this.#pluginId, phase, target, permission };
    const cancellation = context.cancellation;
    if (cancellation !== undefined) {
      return Promise.resolve(Result.fail(cancellation));
    }
    if (this.#closed) {
      return Promise.resolve(
        Result.fail(fromGrpcStatus({ code: GrpcCode.Unavailable, details: 'the host client is closed' }, describe)),
      );
    }
    const metadata = new Metadata();
    metadata.set(PluginProtocol.sessionMetadataKey, this.#session);
    const options = context.deadline === undefined ? {} : { deadline: new Date(context.deadline) };
    return new Promise((resolve) => {
      const call = start(this.#connect(), metadata, options, (error, value) => {
        context.signal.removeEventListener('abort', abort);
        resolve(error === null ? Result.ok(value) : Result.fail(fromGrpcStatus(error, describe)));
      });
      const abort = () => call.cancel();
      context.signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** 第一次回调时连接宿主端点 */
  #connect(): HostClient {
    if (this.#client === undefined) {
      // grpc-js 的 unix 解析器把路径原样交给 net：Unix 上是套接字路径，Windows 上 \\.\pipe\ 开头的路径是命名管道
      const target = this.endpoint.network === 'tcp' ? this.endpoint.address : `unix:${this.endpoint.address}`;
      this.#client = new HostClient(target, credentials.createInsecure());
    }
    return this.#client;
  }
}
