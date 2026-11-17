import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  status as grpcStatus,
  Server,
  type ServerDuplexStream,
  type ServerUnaryCall,
  type ServerWritableStream,
  type sendUnaryData,
} from '@grpc/grpc-js';

import { type InvocationContext, InvocationMessageKey } from '../invocation/index.ts';
import {
  contributedHealth,
  contributedOperations,
  type Manifest,
  ManifestFileName,
  ManifestKind,
  PluginIsolation,
  readManifest,
} from '../manifest/index.ts';
import { OperationErrorCode, OperationInvoker, OperationRegistry } from '../operation/index.ts';
import type { PipelineBuilder } from '../pipeline/index.ts';
import {
  canTransition,
  defaultLocale,
  ErrorCode,
  ErrorInfo,
  FrameworkError,
  FrameworkInfo,
  isLocaleName,
  isPlainObject,
  type JsonObject,
  LifecycleState,
  parseJson,
  Result,
  writeJson,
} from '../primitives/index.ts';
import { checkCatalog, type PluginCatalog } from './catalog.ts';
import {
  contextFromMetadata,
  type DeliveredEnvelope,
  fromProtoEnvelope,
  tenantOf,
  toBytes,
  toProtoError,
  toProtoState,
  toStatus,
} from './conversion.ts';
import { type BoundEndpoint, bindEndpoint, defaultNetwork } from './endpoint.ts';
import * as pb from './gen/plugin.ts';
import { attachHost, Host, TenantLedger } from './host.ts';
import { type LogTarget, PluginLogger } from './logger.ts';
import {
  type EndpointNetwork,
  formatHandshakeLine,
  isSubscriptionMode,
  isTopic,
  negotiateProtocolVersion,
  PluginEnvironment,
  PluginErrorCode,
  PluginMessageKey,
  PluginProtocol,
  parseEndpoint,
  SubscriptionMode,
} from './protocol.ts';
import { sessionInterceptor } from './session.ts';

/**
 * 健康项的状态（plugin.proto 的 `HealthStatus`）
 */
export const HealthStatus = Object.freeze({
  Healthy: 'Healthy',
  Degraded: 'Degraded',
  Unhealthy: 'Unhealthy',
} as const);

/**
 * 健康项状态之一
 */
export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

/**
 * 一个健康项；名字须在清单 `contributes.health` 里声明（plugin/lifecycle.md §4）
 */
export interface PluginHealthItem {
  /** 健康项名 */
  readonly name: string;
  /** 状态 */
  readonly status: HealthStatus;
  /** 说明 */
  readonly description?: string;
}

/**
 * 插件自报的健康
 *
 * @remarks
 * 运行中（Started、Ready、Degraded）报 Ready、Degraded 或 Failed 会改变运行时的状态；停止与失败之后以运行时的状态为准。
 * 插件可自报的状态只有 Started、Ready、Degraded、Draining、Failed（plugin/lifecycle.md §1）
 */
export interface PluginHealth {
  /** 自报的状态 */
  readonly state: LifecycleState;
  /** 健康项；未在清单声明的不上报 */
  readonly items?: readonly PluginHealthItem[];
  /** Degraded 或 Failed 的原因 */
  readonly error?: ErrorInfo;
}

/**
 * 一个已解析的资源绑定
 */
export interface PluginBinding {
  /** 绑定名 */
  readonly name: string;
  /** 资源类型，如 `connection:relational` */
  readonly type: string;
  /** 连接串或地址 */
  readonly value: string;
}

/**
 * `Configure` 下发的内容（plugin/lifecycle.md §2）
 */
export interface PluginConfiguration {
  /** 清单 `contributes.config.section` 节的 JSON 对象；没有声明配置节时为空对象 */
  readonly section: JsonObject;
  /** 配置节的原文；宿主下发空串时为 `{}` */
  readonly text: string;
  /** 宿主授予的权限：等于清单 `permissions` */
  readonly grantedPermissions: readonly string[];
  /** 已解析的资源绑定：只含清单声明的 */
  readonly bindings: readonly PluginBinding[];
  /** 宿主为插件分配的可写工作目录 */
  readonly workDirectory: string;
}

/**
 * `Stop` 的参数（plugin/lifecycle.md §5）
 */
export interface PluginStop {
  /** `shutdown`、`unload`、`restart`；stdin 关闭或收到 SIGTERM 时为 `shutdown` */
  readonly reason: string;
  /** 宽限（毫秒） */
  readonly grace: number;
  /** 宽限到期时中止 */
  readonly signal: AbortSignal;
}

/**
 * 插件接入生命周期的回调；都可省略
 *
 * @remarks
 * 可恢复失败经 Result 返回，作为 `Status.error` 交给宿主；抛出的异常记日志，以 `PLUGINS_UNEXPECTED_001` +
 * `plugins.process.failed` 返回，不把异常消息写上线
 */
export interface PluginHooks {
  /** `Configure` 时调用；失败即插件进入 Failed */
  readonly configure?: (configuration: PluginConfiguration) => Promise<Result<void>> | Result<void>;
  /** `Start` 时调用；成功之后接受调用 */
  readonly start?: () => Promise<Result<void>> | Result<void>;
  /** 停止时调用：在途调用已经完成或宽限已到，在这里释放资源 */
  readonly stop?: (stop: PluginStop) => Promise<Result<void>> | Result<void>;
  /** 给出当前健康；省略时按运行时自己的状态上报、没有健康项，`Start` 成功后直接报 Ready */
  readonly health?: () => PluginHealth;
}

/**
 * 一次投递的附加信息
 */
export interface EventDelivery {
  /** 投递次数，从 1 起 */
  readonly attempt: number;
  /** 这次投递的订阅方式 */
  readonly mode: SubscriptionMode;
}

/**
 * 处理一条投递的消息：可恢复失败经 Result 返回，由宿主的消息代理按重试与死信策略处理；处理器必须幂等（至少一次投递）
 */
export type EventHandler = (
  context: InvocationContext,
  envelope: DeliveredEnvelope,
  delivery: EventDelivery,
) => Promise<Result<void>>;

/**
 * 一个事件订阅与它的处理器
 *
 * @remarks
 * 同一（主题，类型）对只能声明一次，不能以两种方式各声明一次（handshake.md §3 第 5 条）
 */
export interface PluginSubscription {
  /** 主题（RFC-0009 文法） */
  readonly topic: string;
  /** 只处理该 CloudEvents `type` 的消息；省略或空表示主题下全部 */
  readonly messageType?: string;
  /** 订阅方式；省略同 `competing` */
  readonly mode?: SubscriptionMode;
  /** 处理器 */
  readonly handler: EventHandler;
}

/**
 * {@link servePlugin} 的选项
 */
export interface PluginOptions {
  /** 清单原文；省略时读插件目录（当前工作目录）里的 `xihan.manifest.json`。握手时原样交给宿主，必须与目录里的文件一致 */
  readonly manifest?: string | Uint8Array;
  /** 插件服务的操作；每个 ID 都必须出现在清单 `contributes.operations` 里 */
  readonly registry?: OperationRegistry;
  /** 插件里的管道；`Invoke` 经它与调用器的内置步骤执行。省略时只有内置步骤 */
  readonly pipeline?: PipelineBuilder;
  /** 事件订阅 */
  readonly subscriptions?: readonly PluginSubscription[];
  /** 交给宿主的消息目录；每份至少有 `en-US` */
  readonly catalogs?: readonly PluginCatalog[];
  /** 生命周期回调 */
  readonly hooks?: PluginHooks;
  /** 监听的网络类型；省略时 Windows 为 `npipe`、其他系统为 `unix` */
  readonly network?: EndpointNetwork;
  /** 监听地址；省略时自动生成（见 handshake.md §4） */
  readonly address?: string;
  /** 环境变量；省略为 `process.env` */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 宿主保持打开的输入，关闭即退出；省略为 `process.stdin` */
  readonly stdin?: NodeJS.ReadableStream;
  /** 只写握手行；省略为 `process.stdout` */
  readonly stdout?: LogTarget;
  /** 运行时的日志；省略时写 `process.stderr` */
  readonly logger?: PluginLogger;
  /** 宿主没给宽限（`grace_seconds` 为 0）、stdin 关闭或收到 SIGTERM 时等待在途调用的毫秒数；缺省 5000 */
  readonly stopGrace?: number;
  /** `WatchHealth` 轮询健康回调的间隔（毫秒）；缺省 1000 */
  readonly healthInterval?: number;
}

/** 插件可以自报、并据此改变运行时状态的状态（plugin/lifecycle.md §1） */
const reportableStates: readonly LifecycleState[] = [
  LifecycleState.Ready,
  LifecycleState.Degraded,
  LifecycleState.Failed,
];

/** 接受调用的状态：`Start` 成功之后、停止之前 */
const servingStates: readonly LifecycleState[] = [
  LifecycleState.Started,
  LifecycleState.Ready,
  LifecycleState.Degraded,
];

/** 健康项状态的协议数值 */
const healthStatusValues: Readonly<Record<HealthStatus, pb.HealthStatus>> = {
  Healthy: pb.HealthStatus.HEALTH_STATUS_HEALTHY,
  Degraded: pb.HealthStatus.HEALTH_STATUS_DEGRADED,
  Unhealthy: pb.HealthStatus.HEALTH_STATUS_UNHEALTHY,
};

/**
 * 以进程外插件的身份运行（RFC-0017，spec/plugin/）
 *
 * @remarks
 * 依次：读清单并核对声明（插件、进程外、不贡献中间件，操作都在 `contributes.operations` 里，订阅合文法且不重复，目录有 `en-US`）、
 * 读 handshake.md §1 的环境变量、按 §4 监听、向 stdout 写一行握手行，然后提供 Plugin 服务，直到 `Stop` 完成、stdin 关闭或收到 SIGTERM。
 * 每个 RPC 先按常数时间核对会话令牌。返回的 Promise 在服务停止、端点清理之后完成；之后不留下让进程继续运行的句柄。
 * 握手行之后不要向 stdout 写任何东西，日志写 stderr
 *
 * @throws {@link FrameworkError} 清单不合法或不是进程外插件、声明与清单不符、`XIHAN_PLUGIN_SESSION` 缺失、监听失败时
 */
export async function servePlugin(options: PluginOptions = {}): Promise<void> {
  const runtime = new PluginRuntime(options);
  return runtime.run();
}

/** 生命周期状态机：迁移按原语层的合法迁移表核对，变化时通知健康订阅者 */
class Lifecycle {
  #state: LifecycleState = LifecycleState.Declared;
  #error: ErrorInfo | undefined;
  readonly #listeners = new Set<() => void>();

  get state(): LifecycleState {
    return this.#state;
  }

  get error(): ErrorInfo | undefined {
    return this.#error;
  }

  is(states: readonly LifecycleState[]): boolean {
    return states.includes(this.#state);
  }

  /** 迁移到新状态；不合法的迁移什么也不做，返回假 */
  transition(to: LifecycleState, error?: ErrorInfo): boolean {
    if (!canTransition(this.#state, to)) {
      return false;
    }
    this.#state = to;
    this.#error = error;
    // 通知放到微任务里：订阅者会重新计算健康，计算里又可能迁移状态，同步通知会重入
    for (const listener of this.#listeners) {
      queueMicrotask(listener);
    }
    return true;
  }

  watch(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** 一次 `servePlugin` 的状态 */
class PluginRuntime {
  readonly #options: PluginOptions;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #logger: PluginLogger;
  readonly #lifecycle = new Lifecycle();
  readonly #tenants = new TenantLedger();
  readonly #watchers = new Set<() => void>();
  readonly #warnedItems = new Set<string>();
  readonly #idle: (() => void)[] = [];
  #manifestText = '';
  #manifest: Manifest | undefined;
  #invoker: OperationInvoker | undefined;
  #server: Server | undefined;
  #bound: BoundEndpoint | undefined;
  #host: Host | undefined;
  #locale = defaultLocale();
  #inflight = 0;
  #draining: Promise<Result<void>> | undefined;
  #shutdown: Promise<void> | undefined;
  #finish: () => void = () => {};
  #detach: () => void = () => {};

  constructor(options: PluginOptions) {
    this.#options = options;
    this.#env = options.env ?? process.env;
    this.#logger = options.logger ?? new PluginLogger(process.stderr);
  }

  get #id(): string {
    return this.#manifest?.id ?? '';
  }

  get #stopGrace(): number {
    return this.#options.stopGrace ?? 5000;
  }

  async run(): Promise<void> {
    const manifest = this.#readManifest();
    this.#manifest = manifest;
    const registry = this.#options.registry ?? new OperationRegistry();
    this.#checkDeclarations(manifest, registry);
    const session = this.#env[PluginEnvironment.Session] ?? '';
    if (session === '') {
      throw invalid(`The environment variable '${PluginEnvironment.Session}' is required.`);
    }
    this.#invoker = new OperationInvoker(registry, this.#options.pipeline);
    this.#readEnvironment(manifest, session);

    const logger = this.#logger.with({ plugin: manifest.id });
    const server = new Server({ interceptors: [sessionInterceptor(session)] });
    server.addService(pb.PluginService, this.#service() as unknown as pb.PluginServer);
    this.#server = server;
    const bound = await bindEndpoint(server, this.#options.network ?? defaultNetwork(), this.#options.address);
    this.#bound = bound;
    const line = formatHandshakeLine(bound.endpoint);
    if (line === undefined) {
      server.forceShutdown();
      bound.cleanup();
      throw invalid(`The endpoint '${bound.endpoint.address}' cannot be written as a handshake line.`);
    }

    const done = new Promise<void>((resolve) => {
      this.#finish = resolve;
    });
    this.#watchInputs();
    // 握手行是 stdout 的第一行，握手完成之前不再写 stdout（handshake.md §2）
    (this.#options.stdout ?? process.stdout).write(`${line}\n`);
    logger.information('listening', {
      endpoint: `${bound.endpoint.network} ${bound.endpoint.address}`,
      instance: this.#env[PluginEnvironment.Instance] ?? '',
    });
    await done;
  }

  /** 读清单并核对它描述的是进程外插件 */
  #readManifest(): Manifest {
    const raw = this.#options.manifest ?? readFileSync(join(process.cwd(), ManifestFileName));
    let text = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
    // 文件开头的 BOM 不是清单的一部分：宿主读文件时同样跳过它（RFC-0002 解析规则 2）
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    const read = readManifest(text);
    if (!read.ok) {
      const { error } = read;
      throw new FrameworkError(error.code, error.message, {
        ...(error.messageKey === undefined ? {} : { messageKey: error.messageKey }),
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }
    const manifest = read.value;
    if (manifest.kind !== ManifestKind.Plugin || manifest.isolation !== PluginIsolation.OutOfProcess) {
      throw invalid(`The manifest '${manifest.id}' must describe a plugin with isolation 'out-of-process'.`);
    }
    // 只有 Wasm 插件能贡献中间件：宿主在发现时拒绝写了 contributes.pipeline 的进程外插件（RFC-0017「范围」），这里在监听前就拒绝
    if ((manifest.contributes?.pipeline?.length ?? 0) > 0) {
      throw invalid(
        `The plugin '${manifest.id}' must not declare 'contributes.pipeline': only wasm plugins can contribute middleware.`,
      );
    }
    this.#manifestText = text;
    return manifest;
  }

  /** 握手只能细化清单里声明过的东西（RFC-0017「握手」）：不合的声明在监听前拒绝，不等宿主在握手时拒绝 */
  #checkDeclarations(manifest: Manifest, registry: OperationRegistry): void {
    const declared = contributedOperations(manifest);
    for (const descriptor of registry.list()) {
      if (!declared.includes(descriptor.contract.id)) {
        throw invalid(
          `The operation '${descriptor.contract.id}' is not declared in 'contributes.operations' of '${manifest.id}'.`,
        );
      }
    }
    const pairs = new Set<string>();
    for (const subscription of this.#options.subscriptions ?? []) {
      const mode = subscription.mode ?? '';
      if (typeof subscription.handler !== 'function' || !isTopic(subscription.topic)) {
        throw invalid(
          `The subscription '${subscription.topic}' of '${manifest.id}' needs a valid topic and a handler.`,
        );
      }
      if (!isSubscriptionMode(mode)) {
        throw invalid(
          `The subscription '${subscription.topic}' of '${manifest.id}' has the mode '${mode}'; the mode must be empty, 'competing' or 'broadcast'.`,
        );
      }
      // 按（主题，类型）对去重而不看方式：同一对不能以两种方式各声明一次（handshake.md §3 第 5 条）
      const pair = writeJson([subscription.topic, subscription.messageType ?? '']);
      if (pairs.has(pair)) {
        throw invalid(
          `The subscription '${subscription.topic}' with the message type '${subscription.messageType ?? ''}' is declared more than once by '${manifest.id}'.`,
        );
      }
      pairs.add(pair);
    }
    for (const catalog of this.#options.catalogs ?? []) {
      checkCatalog(catalog);
    }
  }

  /** 读 handshake.md §1 的其余环境变量：宿主回调端点、区域，以及只用于诊断的版本 */
  #readEnvironment(manifest: Manifest, session: string): void {
    const logger = this.#logger.with({ plugin: manifest.id });
    const versions = this.#env[PluginEnvironment.ProtocolVersions] ?? '';
    const listed = versions.split(',').map((part) => Number(part.trim()));
    if (versions === '' || listed.some((version) => !Number.isSafeInteger(version) || version < 0)) {
      logger.warning('the host did not pass a valid protocol version list', { versions });
    } else if (negotiateProtocolVersion(listed) === undefined) {
      logger.warning('the host supports no protocol version of this SDK; the handshake will be refused', { versions });
    }
    const primitives = this.#env[PluginEnvironment.Primitives];
    if (primitives !== undefined && primitives !== String(manifest.primitives)) {
      logger.warning("the host's primitives version differs from the manifest; the host will reject the handshake", {
        host: primitives,
        plugin: manifest.primitives,
      });
    }
    const locale = this.#env[PluginEnvironment.Locale];
    if (locale !== undefined && isLocaleName(locale)) {
      this.#locale = locale;
    }
    const address = this.#env[PluginEnvironment.HostAddress];
    if (address !== undefined && address !== '') {
      const endpoint = parseEndpoint(address);
      if (endpoint === undefined) {
        logger.warning('the host callback address is not valid; callbacks are unavailable', { address });
      } else {
        this.#host = new Host(endpoint, session, manifest.id, this.#tenants);
      }
    }
  }

  /** stdin 关闭即退出，不留孤儿进程（handshake.md §1）；SIGTERM 同样是立即收尾退出的请求（lifecycle.md §5） */
  #watchInputs(): void {
    const stdin = this.#options.stdin ?? process.stdin;
    // end、close 与 error 可能先后都到，Stop 之后也可能再到：只有第一个请求开始收尾
    const request = (message: string) => {
      if (this.#shutdown === undefined) {
        this.#logger.information(message, { plugin: this.#id });
        void this.#stop('shutdown', this.#stopGrace);
      }
    };
    const close = () => request('stdin closed; stopping');
    const terminate = () => request('SIGTERM received; stopping');
    const drain = () => {};
    stdin.on('data', drain);
    stdin.once('end', close);
    stdin.once('close', close);
    stdin.once('error', close);
    stdin.resume();
    process.once('SIGTERM', terminate);
    this.#detach = () => {
      stdin.removeListener('data', drain);
      stdin.removeListener('end', close);
      stdin.removeListener('close', close);
      stdin.removeListener('error', close);
      process.removeListener('SIGTERM', terminate);
      stdin.pause();
      // 进程自己的 stdin 句柄会让事件循环一直活着，服务停止之后关掉它
      if (stdin === process.stdin) {
        process.stdin.destroy();
      }
    };
  }

  /** Plugin 服务的实现：grpc-js 的回调形态 */
  #service(): Record<string, unknown> {
    type Unary<Req, Res> = ServerUnaryCall<Req, Res>;
    return {
      handshake: this.#unary((call: Unary<pb.HandshakeRequest, pb.HandshakeResponse>) => this.#handshake(call.request)),
      configure: this.#unary((call: Unary<pb.ConfigureRequest, pb.ConfigureResponse>) => this.#configure(call.request)),
      start: this.#unary((_call: Unary<pb.StartRequest, pb.StartResponse>) => this.#start()),
      stop: this.#unary(
        (call: Unary<pb.StopRequest, pb.StopResponse>) => this.#stopCall(call.request),
        // 应答送出之后再停止服务：优雅停止要等包括这次 Stop 在内的在途 RPC 结束
        (call) => setImmediate(() => void this.#stop(call.request.reason || 'shutdown', 0)),
      ),
      health: this.#unary((_call: Unary<pb.HealthRequest, pb.HealthResponse>) => this.#healthResponse()),
      watchHealth: (call: ServerWritableStream<pb.HealthRequest, pb.HealthResponse>) => this.#watchHealth(call),
      invoke: this.#unary((call: Unary<pb.InvokeRequest, pb.InvokeResponse>) => this.#invoke(call)),
      invokeStream: (call: ServerDuplexStream<pb.StreamFrame, pb.StreamFrame>) => this.#invokeStream(call),
      handleEvent: this.#unary((call: Unary<pb.HandleEventRequest, pb.HandleEventResponse>) => this.#handleEvent(call)),
    };
  }

  /** 把返回 Promise 的处理函数包成 grpc-js 的一元处理器；`after` 在应答交给 grpc-js 之后执行 */
  #unary<Req, Res>(
    handle: (call: ServerUnaryCall<Req, Res>) => Promise<Res> | Res,
    after?: (call: ServerUnaryCall<Req, Res>) => void,
  ) {
    return (call: ServerUnaryCall<Req, Res>, callback: sendUnaryData<Res>) => {
      Promise.resolve()
        .then(() => handle(call))
        .then(
          (response) => {
            callback(null, response);
            after?.(call);
          },
          (error: unknown) => callback(this.#rpcError(error)),
        );
    };
  }

  /** 处理器抛出的状态错误原样作为 gRPC 状态；其余是服务实现自己的缺陷，记日志、以 `Internal` 结束，不把异常消息写上线 */
  #rpcError(error: unknown): StatusError {
    if (error instanceof StatusError) {
      return error;
    }
    this.#logger.error('the plugin failed to handle a call', { plugin: this.#id, error });
    return new StatusError(grpcStatus.INTERNAL, 'The plugin failed to handle the call.');
  }

  /** 握手（handshake.md §3）：协商版本、报原语层版本，交出清单原文、操作、订阅与目录 */
  #handshake(request: pb.HandshakeRequest): pb.HandshakeResponse {
    if (this.#lifecycle.state !== LifecycleState.Declared) {
      throw statusError(grpcStatus.FAILED_PRECONDITION, 'The plugin has already completed its handshake.');
    }
    const selected = negotiateProtocolVersion(request.protocolVersions);
    if (selected === undefined) {
      throw statusError(
        grpcStatus.FAILED_PRECONDITION,
        `No common protocol version: the host supports [${request.protocolVersions.join(', ')}], the plugin supports [${PluginProtocol.version}].`,
      );
    }
    if (isLocaleName(request.defaultLocale)) {
      this.#locale = request.defaultLocale;
    }
    const manifest = this.#manifest as Manifest;
    const response: pb.HandshakeResponse = {
      protocolVersion: selected,
      primitives: manifest.primitives,
      manifest: this.#manifestText,
      sdk: { name: FrameworkInfo.sdkName, version: FrameworkInfo.sdkVersion, language: 'typescript' },
      operations: (this.#invoker as OperationInvoker).registry.list().map((descriptor) => ({
        id: descriptor.contract.id,
        stability: descriptor.contract.stability,
        expose: [...descriptor.contract.expose],
        permission: descriptor.contract.permission ?? '',
        policy: descriptor.contract.policy ?? '',
        requestSchema: descriptor.schema?.request ?? '',
        responseSchema: descriptor.schema?.response ?? '',
        streaming: false,
      })),
      subscriptions: (this.#options.subscriptions ?? []).map((subscription) => ({
        topic: subscription.topic,
        messageType: subscription.messageType ?? '',
        mode: subscription.mode ?? '',
      })),
      catalogs: (this.#options.catalogs ?? []).map((catalog) => ({
        name: catalog.name,
        locales: Object.entries(catalog.locales).map(([locale, templates]) => ({
          locale,
          templates: { ...templates },
        })),
      })),
    };
    this.#lifecycle.transition(LifecycleState.Resolved);
    this.#logger.information('handshake completed', {
      plugin: this.#id,
      protocolVersion: selected,
      host: request.host?.sdk ?? '',
      instance: request.instanceId,
    });
    return response;
  }

  /** 配置（lifecycle.md §2）：配置节必须是 JSON 对象，交给回调；失败即 Failed */
  async #configure(request: pb.ConfigureRequest): Promise<pb.ConfigureResponse> {
    if (this.#lifecycle.state !== LifecycleState.Resolved) {
      throw statusError(grpcStatus.FAILED_PRECONDITION, 'Configure requires a completed handshake.');
    }
    const text = request.configuration === '' ? '{}' : request.configuration;
    let section: unknown;
    try {
      section = parseJson(text);
    } catch {
      section = undefined;
    }
    let outcome: Result<void>;
    if (!isPlainObject(section)) {
      outcome = Result.fail(this.#failure('Configure', 'the configuration is not a JSON object'));
    } else {
      const configuration: PluginConfiguration = Object.freeze({
        section: section as JsonObject,
        text,
        grantedPermissions: Object.freeze([...request.grantedPermissions]),
        bindings: Object.freeze(request.bindings.map((binding) => Object.freeze({ ...binding }))),
        workDirectory: request.workDirectory,
      });
      const hook = this.#options.hooks?.configure;
      outcome = hook === undefined ? Result.success() : await this.#runHook('Configure', () => hook(configuration));
    }
    this.#settle(LifecycleState.Configured, outcome, 'configure failed');
    return { status: toStatus(outcome, this.#locale) };
  }

  /** 启动（lifecycle.md §2）：成功后接受调用；没有健康回调的插件直接报 Ready（lifecycle.md §1） */
  async #start(): Promise<pb.StartResponse> {
    if (this.#lifecycle.state !== LifecycleState.Configured) {
      throw statusError(grpcStatus.FAILED_PRECONDITION, 'Start requires a successful Configure.');
    }
    const hook = this.#options.hooks?.start;
    const outcome = hook === undefined ? Result.success() : await this.#runHook('Start', () => hook());
    this.#settle(LifecycleState.Started, outcome, 'start failed');
    if (outcome.ok && this.#options.hooks?.health === undefined) {
      this.#lifecycle.transition(LifecycleState.Ready);
    }
    return { status: toStatus(outcome, this.#locale) };
  }

  /** 按结果迁移到下一个状态或 Failed */
  #settle(next: LifecycleState, outcome: Result<void>, message: string): void {
    if (outcome.ok) {
      this.#lifecycle.transition(next);
      return;
    }
    this.#lifecycle.transition(LifecycleState.Failed, outcome.error);
    this.#logger.error(message, { plugin: this.#id, code: outcome.error.code, reason: outcome.error.message });
  }

  /** `Stop`（lifecycle.md §5）：进入 Draining、拒绝新调用、在宽限内等在途调用、释放资源，然后应答 */
  async #stopCall(request: pb.StopRequest): Promise<pb.StopResponse> {
    const grace = request.graceSeconds > 0 ? request.graceSeconds * 1000 : this.#stopGrace;
    const outcome = await this.#drain(request.reason || 'shutdown', grace);
    return { status: toStatus(outcome, this.#locale) };
  }

  /** 收尾只做一次：`Stop` 与随后的停止服务、stdin 关闭、SIGTERM 共用同一次收尾 */
  #drain(reason: string, grace: number): Promise<Result<void>> {
    this.#draining ??= this.#drainOnce(reason, grace);
    return this.#draining;
  }

  /** 进入 Draining（拒绝新调用）、结束健康推送、在宽限内等在途调用，再调用停止回调释放资源 */
  async #drainOnce(reason: string, grace: number): Promise<Result<void>> {
    const started = Date.now();
    this.#lifecycle.transition(LifecycleState.Draining);
    this.#endWatchers();
    this.#logger.information('stopping', { plugin: this.#id, reason, grace });
    if (!(await this.#whenIdle(grace))) {
      this.#logger.warning('in-flight calls did not finish within the grace period', { plugin: this.#id });
    }
    const hook = this.#options.hooks?.stop;
    if (hook === undefined) {
      return Result.success();
    }
    const remaining = Math.max(0, grace - (Date.now() - started));
    const signal = AbortSignal.timeout(Math.max(1, remaining));
    return this.#runHook('Stop', () => hook(Object.freeze({ reason, grace: remaining, signal })));
  }

  /** 停止服务：先收尾（见 {@link #drain}），再优雅关闭 gRPC 服务端、删私有目录、断开宿主、放开 stdin；只执行一次 */
  #stop(reason: string, grace: number): Promise<void> {
    this.#shutdown ??= (async () => {
      await this.#drain(reason, grace);
      const server = this.#server as Server;
      await new Promise<void>((resolve) => {
        // 优雅关闭等在途 RPC 结束；长流已在收尾时结束，仍有卡住的调用时 1 秒后强制关闭
        const timer = setTimeout(() => {
          server.forceShutdown();
          resolve();
        }, 1000);
        timer.unref();
        server.tryShutdown(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.#bound?.cleanup();
      this.#host?.close();
      this.#detach();
      this.#lifecycle.transition(LifecycleState.Stopped);
      this.#logger.information('stopped', { plugin: this.#id });
      this.#finish();
    })();
    return this.#shutdown;
  }

  /** 执行一个生命周期回调：抛出的异常记日志，作为 `PLUGINS_UNEXPECTED_001` 返回 */
  async #runHook(phase: string, hook: () => Promise<Result<void>> | Result<void>): Promise<Result<void>> {
    try {
      const outcome = await hook();
      if (outcome === null || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
        return Result.fail(this.#failure(phase, 'the hook did not return a Result'));
      }
      return outcome;
    } catch (error) {
      this.#logger.error(`the ${phase} hook threw`, { plugin: this.#id, error });
      return Result.fail(this.#failure(phase, 'an unhandled exception occurred'));
    }
  }

  /** `PLUGINS_UNEXPECTED_001` + `plugins.process.failed` */
  #failure(phase: string, reason: string): ErrorInfo {
    return ErrorInfo.unexpected(PluginErrorCode.Unexpected, PluginMessageKey.Failed, { id: this.#id, phase, reason });
  }

  /** 插件不可用（未启动、正在停止或已失败）：`PLUGINS_UNAVAILABLE_001` */
  #unavailable(): ErrorInfo {
    return ErrorInfo.unavailable(PluginErrorCode.Unavailable, PluginMessageKey.Unavailable, {
      id: this.#id,
      state: this.#lifecycle.state,
    });
  }

  /** 当前健康：见 {@link PluginHealth} */
  #health(): PluginHealth {
    const hook = this.#options.hooks?.health;
    const serving = this.#lifecycle.is(servingStates);
    if (hook === undefined || !(serving || this.#lifecycle.state === LifecycleState.Draining)) {
      return this.#runtimeHealth([]);
    }
    let reported: PluginHealth;
    try {
      reported = hook();
    } catch (error) {
      this.#logger.warning('the health hook threw', { plugin: this.#id, error });
      return this.#runtimeHealth([]);
    }
    const declared = contributedHealth(this.#manifest as Manifest);
    const items = (reported.items ?? []).filter((item) => {
      if (declared.includes(item.name)) {
        return true;
      }
      // 宿主按清单核对健康项（lifecycle.md §4），未声明的不上报；同一个名字只警告一次
      if (!this.#warnedItems.has(item.name)) {
        this.#warnedItems.add(item.name);
        this.#logger.warning('health item is not declared in contributes.health', {
          plugin: this.#id,
          item: item.name,
        });
      }
      return false;
    });
    if (serving && reportableStates.includes(reported.state) && reported.state !== this.#lifecycle.state) {
      this.#lifecycle.transition(reported.state, reported.error);
    }
    const error = reported.error ?? this.#lifecycle.error;
    return { state: this.#lifecycle.state, items, ...(error === undefined ? {} : { error }) };
  }

  #runtimeHealth(items: readonly PluginHealthItem[]): PluginHealth {
    const error = this.#lifecycle.error;
    return { state: this.#lifecycle.state, items, ...(error === undefined ? {} : { error }) };
  }

  #healthResponse(): pb.HealthResponse {
    return this.#toProtoHealth(this.#health());
  }

  #toProtoHealth(health: PluginHealth): pb.HealthResponse {
    return {
      state: toProtoState(health.state),
      items: (health.items ?? []).map((item) => ({
        name: item.name,
        status: healthStatusValues[item.status] ?? pb.HealthStatus.HEALTH_STATUS_UNSPECIFIED,
        description: item.description ?? '',
      })),
      error: health.error === undefined ? undefined : toProtoError(health.error, this.#locale),
    };
  }

  /** `WatchHealth`：先推当前状态，之后状态或健康项变化时各推一条；停止时推最后一条并结束流 */
  #watchHealth(call: ServerWritableStream<pb.HealthRequest, pb.HealthResponse>): void {
    let last = '';
    const push = () => {
      if (call.cancelled || call.writableEnded) {
        return;
      }
      const response = this.#healthResponse();
      // 按编码后的字节判断有没有变化：状态、健康项与错误任何一处变了都算
      const key = Buffer.from(pb.HealthResponse.encode(response).finish()).toString('base64');
      if (key !== last) {
        last = key;
        call.write(response);
      }
    };
    const timer = setInterval(push, this.#options.healthInterval ?? 1000);
    timer.unref();
    let unwatch = () => {};
    const release = () => {
      clearInterval(timer);
      unwatch();
      this.#watchers.delete(end);
    };
    // 长流不能拖住优雅停止：收尾时推最后一条（Draining）并结束
    const end = () => {
      push();
      release();
      if (!call.cancelled && !call.writableEnded) {
        call.end();
      }
    };
    push();
    if (this.#shutdown !== undefined || this.#lifecycle.state === LifecycleState.Draining) {
      end();
      return;
    }
    unwatch = this.#lifecycle.watch(push);
    this.#watchers.add(end);
    call.on('cancelled', release);
  }

  #endWatchers(): void {
    for (const end of [...this.#watchers]) {
      end();
    }
  }

  /** 在途调用计数：Draining 时等它们完成 */
  async #track<T>(tenant: string | undefined, work: () => Promise<T>): Promise<T> {
    this.#inflight += 1;
    this.#tenants.enter(tenant);
    try {
      return await work();
    } finally {
      this.#tenants.leave(tenant);
      this.#inflight -= 1;
      if (this.#inflight === 0) {
        for (const resolve of this.#idle.splice(0)) {
          resolve();
        }
      }
    }
  }

  /** 等在途调用完成；超时返回假 */
  #whenIdle(timeout: number): Promise<boolean> {
    if (this.#inflight === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeout);
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** 为一次调用或投递构造调用上下文：元数据、gRPC 的取消与截止时间，并放入宿主客户端 */
  #context(call: ServerUnaryCall<unknown, unknown>, metadata: pb.InvocationMetadata | undefined): InvocationContext {
    const controller = new AbortController();
    if (call.cancelled) {
      controller.abort();
    } else {
      call.once('cancelled', () => controller.abort());
    }
    const deadline = call.getDeadline();
    const callDeadline =
      deadline instanceof Date ? deadline.getTime() : Number.isFinite(deadline) ? deadline : undefined;
    const context = contextFromMetadata(metadata, controller.signal, callDeadline);
    if (this.#host !== undefined) {
      attachHost(context, this.#host);
    }
    return context;
  }

  /** `Invoke`：未声明的操作以 `Unimplemented` 结束；未就绪或正在停止为 `PLUGINS_UNAVAILABLE_001`；其余经调用器与完整管道 */
  async #invoke(call: ServerUnaryCall<pb.InvokeRequest, pb.InvokeResponse>): Promise<pb.InvokeResponse> {
    const request = call.request;
    const invoker = this.#invoker as OperationInvoker;
    if (invoker.registry.find(request.operation) === undefined) {
      throw statusError(
        grpcStatus.UNIMPLEMENTED,
        `The operation '${request.operation}' is not provided by this plugin.`,
      );
    }
    if (!this.#lifecycle.is(servingStates)) {
      return { status: toStatus(Result.fail(this.#unavailable()), this.#locale), payload: new Uint8Array() };
    }
    const context = this.#context(call, request.metadata);
    return this.#track(tenantOf(context), async () => {
      try {
        const response = await invoker.invoke(context, { id: request.operation, payload: request.payload });
        return { status: toStatus(response.outcome, this.#locale), payload: toBytes(response.payload) };
      } catch (error) {
        // 排在 Observe 内置步骤之前的中间件抛出的异常：调用方在进程外，交回未处理异常，不把异常消息写上线
        this.#logger.error('the invocation threw', { plugin: this.#id, operation: request.operation, error });
        return {
          status: toStatus(Result.fail(unhandled()), this.#locale),
          payload: new Uint8Array(),
        };
      }
    });
  }

  /**
   * `InvokeStream`：先核对帧序，第一帧不是 `start` 即 `InvalidArgument`（plugin/invocation.md §1）
   *
   * @remarks
   * 流式操作的契约还没有定义（RFC-0017「非目标」），本 SDK 不登记流式操作，所以合法的 `start` 一律以 `Unimplemented` 结束
   */
  #invokeStream(call: ServerDuplexStream<pb.StreamFrame, pb.StreamFrame>): void {
    let answered = false;
    const answer = (code: number, details: string) => {
      if (!answered) {
        answered = true;
        call.emit('error', statusError(code, details));
      }
    };
    call.on('data', (frame: pb.StreamFrame) => {
      if (frame.start === undefined) {
        answer(grpcStatus.INVALID_ARGUMENT, 'The first frame of a stream must be start.');
      } else {
        answer(
          grpcStatus.UNIMPLEMENTED,
          `The streaming operation '${frame.start.operation}' is not provided by this plugin.`,
        );
      }
    });
    call.on('end', () => answer(grpcStatus.INVALID_ARGUMENT, 'The stream ended before its start frame.'));
  }

  /**
   * `HandleEvent`（plugin/invocation.md §4）：按（主题，投递的方式）找订阅，再看类型
   *
   * @remarks
   * 只交给以这种方式声明、`messageType` 为空或等于信封 `type` 的订阅，按声明顺序依次执行，第一个失败即投递结果；
   * 找不到以这种方式声明的订阅时返回失败，不改交给另一种方式的处理器
   */
  async #handleEvent(
    call: ServerUnaryCall<pb.HandleEventRequest, pb.HandleEventResponse>,
  ): Promise<pb.HandleEventResponse> {
    if (!this.#lifecycle.is(servingStates)) {
      return { status: toStatus(Result.fail(this.#unavailable()), this.#locale) };
    }
    const request = call.request;
    const envelope = fromProtoEnvelope(request.envelope);
    const mode = request.mode === '' ? SubscriptionMode.Competing : request.mode;
    const handlers = (this.#options.subscriptions ?? []).filter(
      (subscription) =>
        subscription.topic === envelope.topic &&
        (subscription.mode || SubscriptionMode.Competing) === mode &&
        (!subscription.messageType || subscription.messageType === envelope.type),
    );
    if (handlers.length === 0) {
      const reason = `no '${mode}' subscription matches the topic '${envelope.topic}' and the type '${envelope.type}'`;
      return { status: toStatus(Result.fail(this.#failure('HandleEvent', reason)), this.#locale) };
    }
    const context = this.#context(call, request.metadata);
    const delivery: EventDelivery = Object.freeze({ attempt: request.attempt, mode: mode as SubscriptionMode });
    return this.#track(tenantOf(context), async () => {
      for (const subscription of handlers) {
        let outcome: Result<void>;
        try {
          outcome = await subscription.handler(context, envelope, delivery);
        } catch (error) {
          this.#logger.error('the event handler threw', { plugin: this.#id, topic: envelope.topic, error });
          outcome = Result.fail(context.cancellation ?? unhandled());
        }
        if (!outcome.ok) {
          return { status: toStatus(outcome, this.#locale) };
        }
      }
      return { status: toStatus(Result.success(), this.#locale) };
    });
  }
}

/** 带 gRPC 状态码的错误：grpc-js 的处理器回调与流的 `error` 事件按 `code` 与 `details` 写出状态 */
class StatusError {
  readonly code: number;
  readonly details: string;

  constructor(code: number, details: string) {
    this.code = code;
    this.details = details;
  }
}

function statusError(code: number, details: string): StatusError {
  return new StatusError(code, details);
}

/** 调用期间未处理的异常（KERNEL_UNEXPECTED_001，没有参数） */
function unhandled(): ErrorInfo {
  return ErrorInfo.unexpected(OperationErrorCode.Unexpected, InvocationMessageKey.UnhandledException);
}

function invalid(message: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, message);
}
