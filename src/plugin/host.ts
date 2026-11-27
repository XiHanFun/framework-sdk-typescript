import { credentials, Metadata, type ServiceError } from '@grpc/grpc-js';

import { isDeadlineSignalled } from '../invocation/context.ts';
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
  toStrictUtf8,
  unencodableBaggageKey,
} from './conversion.ts';
import {
  type CallbackRpc,
  callbackDenied,
  dataNotUtf8,
  GrpcCode,
  hostUnavailable,
  loneSurrogateBaggageReason,
  mapCallbackStatus,
  PluginReason,
  payloadNotUtf8,
  processFailed,
  resultCountReason,
  statusReason,
  tenantDenied,
} from './errors.ts';
import { HostClient, type InvokeResponse, type Envelope as ProtoEnvelope, type PublishResponse } from './gen/plugin.ts';
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

/**
 * `Host.Invoke` 发出的载荷字节（invocation.md §5，ADR-0312）
 *
 * @remarks
 * 字符串严格编码成 UTF-8，有孤立的代理项即本地失败、不发请求（`KERNEL_VALIDATION_001` + `kernel.operation.invalid_payload`，
 * `reason` 为 `$`），不像 `TextEncoder` 那样换成 U+FFFD 照发；字节原样发出、由宿主核对；没有载荷是空字节，宿主按 `{}` 处理
 */
function invokePayload(operation: string, payload: string | Uint8Array | undefined): Result<Uint8Array> {
  if (typeof payload !== 'string') {
    return Result.ok(toBytes(payload));
  }
  const bytes = toStrictUtf8(payload);
  return bytes === undefined ? Result.fail(payloadNotUtf8(operation)) : Result.ok(bytes);
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
 * 某个调用或投递的租户，否则 `plugins.callback.tenant_denied`；上下文的截止时间已过或已被取消时也不发请求，结果与
 * 映射表的 `DeadlineExceeded`、「`Cancelled`，取消信号已触发」两行相同；写进元数据 `baggage` 的已登记值有孤立的代理项时
 * 不发请求，`PLUGINS_UNEXPECTED_001` + `plugins.process.failed`（`phase` 为操作 ID 或 `publish`，ADR-0347）；最后，以字符串给出的
 * `Host.Invoke` 载荷编码不成 UTF-8 时不发请求，`kernel.operation.invalid_payload`（ADR-0312），以字符串给出的信封 `data`
 * 编码不成 UTF-8 的那一项不发出，`messaging.envelope.invalid`（ADR-0315）。每次回调都在元数据 `xihan-plugin-session` 里带会话令牌，
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
   * 元数据取自上下文：按 RFC-0003 写出的 traceparent、截止时间（UTC、七位小数）与已登记的 Baggage，`trace_state` 为空；
   * gRPC 调用的截止时间与上下文相同，调用方取消即取消回调。业务失败是宿主返回的 `Status.error`，按 invocation.md §3 的读入规则还原；
   * gRPC 失败按 invocation.md §5 的表换成原语层错误。字符串载荷在发出之前严格编码成 UTF-8：有孤立的代理项时不发请求，
   * 结果是 `KERNEL_VALIDATION_001` + `kernel.operation.invalid_payload`（`id` 为操作 ID，`reason` 为 `$`），排在权限、租户、
   * 截止时间与元数据的本地核对之后（ADR-0312、ADR-0347）；字节载荷原样发出，由宿主核对
   *
   * @param payload - 请求的 JSON 文本或 UTF-8 字节；缺省为空，宿主按 `{}` 处理
   */
  async invoke(
    context: InvocationContext,
    operation: string,
    payload?: string | Uint8Array,
  ): Promise<OperationResponse> {
    const reply = await this.#call<Uint8Array, InvokeResponse>(
      context,
      'invoke',
      operation,
      CallbackPermission.Invoke,
      () => invokePayload(operation, payload),
      (client, bytes, metadata, options, done) =>
        client.invoke({ operation, payload: bytes, metadata: metadataFromContext(context) }, metadata, options, done),
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
   * 本地的权限与上下文租户核对、截止时间已过或已被取消、元数据的 Baggage 有孤立的代理项（ADR-0347）、没有可用的回调端点
   * 都是整批的结果，每一项都是同一个错误。
   * 整批的核对都通过之后逐项编码：以字符串给出的 `data` 严格编码成 UTF-8，有孤立的代理项的那一项不发出，结果是
   * `MESSAGING_VALIDATION_002` + `messaging.envelope.invalid`（`reason` 为 `the data has a lone surrogate and cannot be encoded as UTF-8`），
   * 其余各项照常组成一次请求，结果放回各自原来的位置；每一项都编码不成时不发请求（ADR-0315）。信封的 `xihantenant`
   * 不在本地核对，由宿主逐项判定（宿主在它之前还核对发布器与主题，本地先判会改变错误的先后，invocation.md §5）。
   * 请求的 RPC 失败是发出的各项的结果；宿主返回的结果数与发出的信封数不同时，发出的每一项都是
   * `PLUGINS_UNEXPECTED_001` + `plugins.process.failed`（`phase` 为 `publish`）。上下文的信号在途中触发即取消这次请求，结果按上面的表归因
   */
  async publish(context: InvocationContext, envelopes: readonly Envelope[]): Promise<Result<void>[]> {
    if (envelopes.length === 0) {
      return [];
    }
    // 编码不读时钟、不连宿主，提前算好不改变核对的先后；结果在整批的核对之后才用到
    const encoded = envelopes.map(toProtoEnvelope);
    const batch = encoded.filter((envelope): envelope is ProtoEnvelope => envelope !== undefined);
    // #call 在整批的本地核对都通过之后才调用 prepare：没调用即整批不合，每一项都是整批的那个错误，不论 data 编不编得成
    const local = { checked: false };
    const reply = await this.#call<ProtoEnvelope[], PublishResponse>(
      context,
      'publish',
      'publish',
      CallbackPermission.Publish,
      () => {
        local.checked = true;
        return batch.length === 0 ? Result.fail(dataNotUtf8()) : Result.ok(batch);
      },
      (client, sent, metadata, options, done) =>
        client.publish({ envelopes: sent, metadata: metadataFromContext(context) }, metadata, options, done),
    );
    if (!reply.ok && !local.checked) {
      return envelopes.map(() => Result.fail(reply.error));
    }
    // 发出的各项的结果：请求失败（RPC 失败、客户端已关闭）时都是那个错误，结果数按实际发出的信封数核对
    let outcome: (index: number) => Result<void>;
    if (!reply.ok) {
      outcome = () => Result.fail(reply.error);
    } else if (reply.value.results.length !== batch.length) {
      const failure = processFailed(
        this.#pluginId,
        'publish',
        resultCountReason(reply.value.results.length, batch.length),
      );
      outcome = () => Result.fail(failure);
    } else {
      const results = reply.value.results;
      outcome = (index) => fromStatus(results[index], this.#pluginId, 'publish');
    }
    // 结果放回各自原来的位置；编码不成的那一项没有发出，是它自己的错误
    const notEncoded = dataNotUtf8();
    let sent = -1;
    return encoded.map((envelope) => {
      if (envelope === undefined) {
        return Result.fail(notEncoded);
      }
      sent += 1;
      return outcome(sent);
    });
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
   * 发出之前的本地核对（invocation.md §5），依次：① 有没有可用的回调端点（由 {@link Host.#call} 先核对，它要拿端点去连）；
   * 按宿主的顺序 ② 权限、③ 上下文的租户；④ 上下文的截止时间已过或已被取消，结果与映射表相应的一行相同
   * （截止时间已过按 `DeadlineExceeded`，已被取消按「`Cancelled`，取消信号已触发」）。都通过时为 `undefined`；
   * 之后 {@link Host.#call} 再核对 ⑤ 元数据的 Baggage 编得成 UTF-8（ADR-0347）、准备请求（⑥ 载荷或信封的 `data` 编码成 UTF-8），
   * 客户端已经关闭的最后按连不上宿主
   */
  #refusal(context: InvocationContext, rpc: CallbackRpc, operation: string, permission: string): ErrorInfo | undefined {
    if (!this.#permitted(permission)) {
      return callbackDenied(this.#pluginId, permission);
    }
    const tenant = tenantOf(context);
    if (tenant !== undefined && !this.#tenants.has(tenant)) {
      return tenantDenied(this.#pluginId, tenant);
    }
    const cancelled = context.signal.aborted;
    // 截止信号已触发也算截止时间已过：它的定时器按单调时钟，可能比墙上时钟先到
    if (isDeadlineSignalled(context) || context.isExpired(Date.now())) {
      return mapCallbackStatus(rpc, GrpcCode.DeadlineExceeded, '', cancelled, this.#pluginId, operation);
    }
    if (cancelled) {
      return mapCallbackStatus(rpc, GrpcCode.Cancelled, '', true, this.#pluginId, operation);
    }
    return undefined;
  }

  /**
   * 发出一次一元回调：带会话令牌与截止时间，调用方取消即取消回调
   *
   * @param prepare - 本地核对都通过之后准备请求的内容；失败即不发请求，结果就是它的错误
   */
  #call<Q, T>(
    context: InvocationContext,
    rpc: CallbackRpc,
    operation: string,
    permission: string,
    prepare: () => Result<Q>,
    start: (
      client: HostClient,
      request: Q,
      metadata: Metadata,
      options: { deadline?: Date },
      done: (error: ServiceError | null, value: T) => void,
    ) => { cancel(): void },
  ): Promise<Result<T>> {
    // 本地核对的第一项：没有可用的回调端点就不发请求；端点在这里取出，后面连接时用的就是核对过的这一个
    const endpoint = this.endpoint;
    if (endpoint === undefined) {
      return Promise.resolve(Result.fail(hostUnavailable(this.#pluginId, PluginReason.NoCallbackEndpoint)));
    }
    const refusal = this.#refusal(context, rpc, operation, permission);
    if (refusal !== undefined) {
      return Promise.resolve(Result.fail(refusal));
    }
    // 元数据排在截止时间之后、载荷与 data 的编码之前（ADR-0347）：权限、租户与截止时间是宿主会给出的错误，写不出请求是本地才有的；
    // 元数据是整个请求共用的，Host.Publish 里它是整批的结果。不先核对时写出器经 TextEncoder 把孤立的代理项换成 U+FFFD 照发，
    // 宿主收到的是另一个幂等键
    const unencodable = unencodableBaggageKey(context);
    if (unencodable !== undefined) {
      return Promise.resolve(
        Result.fail(processFailed(this.#pluginId, operation, loneSurrogateBaggageReason(unencodable))),
      );
    }
    // 权限、租户与截止时间之后才准备请求：载荷编码不成相当于宿主在管道的 Validate 阶段才发现的错误，信封的 data 编码不成
    // 相当于宿主逐项转换信封时的错误，都排在整批的核对之后（ADR-0312、ADR-0315）
    const request = prepare();
    if (!request.ok) {
      return Promise.resolve(Result.fail(request.error));
    }
    // 客户端已经关闭等于请求发不出去，与 RPC 报 Unavailable 同一行，所以排在准备请求之后
    if (this.#closed) {
      return Promise.resolve(
        Result.fail(hostUnavailable(this.#pluginId, statusReason(GrpcCode.Unavailable, 'the host client is closed'))),
      );
    }
    const metadata = new Metadata();
    metadata.set(PluginProtocol.sessionMetadataKey, this.#session);
    const options = context.deadline === undefined ? {} : { deadline: new Date(context.deadline) };
    return new Promise((resolve) => {
      const client = this.#connect(endpoint);
      const call = start(client, request.value, metadata, options, (error, value) => {
        context.signal.removeEventListener('abort', abort);
        if (error === null) {
          resolve(Result.ok(value));
          return;
        }
        // 只按表映射，不另按时钟或令牌改写结果：连接失败 grpc-js 报 Unavailable，到了截止时间报 DeadlineExceeded，
        // Cancelled 的两行看的是回调上下文自己的取消信号（invocation.md §5）
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
      // 调用方取消时取消回调；截止时间到了交给 gRPC 自己的截止时间（与上下文的相同），它报 DeadlineExceeded，
      // 这里抢先取消会让 grpc-js 报成 Cancelled。先看截止信号：它按单调时钟触发，墙上时钟可能还差一点才到截止时间，
      // 只按时钟判断会把截止时间当成调用方取消
      const abort = () => {
        if (!isDeadlineSignalled(context) && !context.isExpired(Date.now())) {
          call.cancel();
        }
      };
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
