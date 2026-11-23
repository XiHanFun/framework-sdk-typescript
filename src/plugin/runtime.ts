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
import { type ManifestSource, readManifestBytes, readManifestSource } from '../manifest/node.ts';
import { OperationErrorCode, OperationInvoker, OperationRegistry } from '../operation/index.ts';
import { isAbort } from '../operation/invoker.ts';
import type { PipelineBuilder } from '../pipeline/index.ts';
import {
  canTransition,
  ErrorInfo,
  FrameworkError,
  FrameworkInfo,
  isServing,
  JsonMembers,
  type JsonObject,
  LifecycleState,
  Result,
  readJsonText,
  toJsonValue,
  writeJson,
} from '../primitives/index.ts';
import { checkCatalog, type PluginCatalog } from './catalog.ts';
import { ConfigurationSection } from './configuration.ts';
import {
  contextFromMetadata,
  type DeliveredEnvelope,
  fromProtoEnvelope,
  messageOf,
  tenantOf,
  toBytes,
  toProtoError,
  toProtoState,
  toStatus,
} from './conversion.ts';
import { type BoundEndpoint, bindEndpoint, callbackNetworks, defaultNetwork } from './endpoint.ts';
import { eventUnsubscribed, PluginReason, processFailed, processUnavailable, thrownTypeName } from './errors.ts';
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
  PluginProtocol,
  parseProtocolVersions,
  SubscriptionMode,
  selectHostEndpoint,
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
 * 可服务期间（Ready、Degraded）报 Ready、Degraded 或 Failed 会改变运行时的状态（Failed 之后不再回来），报其他状态的不改变；
 * 其余状态下运行时不调健康回调，以自己的状态为准（plugin/lifecycle.md §7.4）
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
 * `Configure` 下发的内容（plugin/lifecycle.md §2、§7.2）
 */
export interface PluginConfiguration {
  /** 清单 `contributes.config.section` 节的 JSON 对象，原样；没有声明配置节时为空对象 */
  readonly section: JsonObject;
  /** 同一个配置节的类型化读取：成员名不区分大小写，字符串叶子可读成数字与布尔 */
  readonly values: ConfigurationSection;
  /** 配置节的原文；宿主下发空串时为 `{}` */
  readonly text: string;
  /** 宿主授予的权限，原样；回调前的权限核对以它为准（invocation.md §5） */
  readonly grantedPermissions: readonly string[];
  /** 已解析的资源绑定：只含清单声明的 */
  readonly bindings: readonly PluginBinding[];
  /** 宿主为插件分配的可写工作目录 */
  readonly workDirectory: string;
}

/**
 * 停止回调的参数（plugin/lifecycle.md §7.5、§7.7）
 */
export interface PluginStop {
  /** `Stop` 的 `reason`（`shutdown`、`unload`、`restart`），原样；stdin 关闭或收到 SIGTERM 时为 `shutdown` */
  readonly reason: string;
  /** 留给停止回调的毫秒数：宽限期（或收尾的 3 秒）减去等在途调用用掉的 */
  readonly grace: number;
  /** 留给停止回调的时间到了即中止 */
  readonly signal: AbortSignal;
}

/**
 * 插件接入生命周期的回调；都可省略
 *
 * @remarks
 * 可恢复失败经 Result 返回，作为 `Status.error` 交给宿主；抛出的异常只把文本写进 stderr 日志，以
 * `PLUGINS_UNEXPECTED_001` + `plugins.process.failed` 返回，`reason` 是异常的简单类型名（lifecycle.md §7.6）
 */
export interface PluginHooks {
  /** `Configure` 时调用；失败即插件进入 Failed */
  readonly configure?: (configuration: PluginConfiguration) => Promise<Result<void>> | Result<void>;
  /** `Start` 时调用；成功之后（按健康进入 Ready 或 Degraded）接受调用，失败即插件进入 Failed */
  readonly start?: () => Promise<Result<void>> | Result<void>;
  /**
   * 停止时调用：在途调用已经结束或宽限已到，在这里释放资源
   *
   * @remarks
   * 启动回调成功过才调，进程里最多调一次；返回失败或抛出都照常退出
   */
  readonly stop?: (stop: PluginStop) => Promise<Result<void>> | Result<void>;
  /**
   * 给出当前健康
   *
   * @remarks
   * `Start` 成功后立即求一次，之后可服务期间每次 `Health` 与 `WatchHealth` 的定时都求一次；省略时 `Start` 成功后直接 Ready、
   * 没有健康项。抛出时这一次的结果是 Degraded，没有健康项
   */
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
  /** 订阅方式；省略同 `competing`，握手时总写出 `competing` 或 `broadcast` */
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
  /** 事件订阅；投递时按声明顺序依次交给匹配的订阅 */
  readonly subscriptions?: readonly PluginSubscription[];
  /** 交给宿主的消息目录；每份至少有 `en-US`。SDK 运行时自己的消息键由宿主提供，不随握手发送 */
  readonly catalogs?: readonly PluginCatalog[];
  /** 生命周期回调 */
  readonly hooks?: PluginHooks;
  /** 监听的网络类型；省略时 Windows 为 `npipe`、其他系统为 `unix` */
  readonly network?: EndpointNetwork;
  /** 监听地址；省略时自动生成（见 handshake.md §4）。`tcp` 只能是 `127.0.0.1:<端口>` */
  readonly address?: string;
  /** 环境变量；省略为 `process.env` */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 宿主保持打开的输入，读到结尾即收尾退出；省略为 `process.stdin` */
  readonly stdin?: NodeJS.ReadableStream;
  /** 只写握手行；省略为 `process.stdout` */
  readonly stdout?: LogTarget;
  /** 运行时的日志；省略时写 `process.stderr` */
  readonly logger?: PluginLogger;
  /** 可服务期间 `WatchHealth` 重新求健康回调的间隔（毫秒）；缺省 10000，即宿主 `HealthInterval` 的缺省值 */
  readonly healthInterval?: number;
  /**
   * 收尾到了时限让进程退出；省略为 `process.exit`
   *
   * @remarks
   * 运行时收尾之后不再留下让事件循环继续运行的句柄；作者的代码还让进程活着时，运行时在收尾完成 1 秒后以退出码 0 调它，
   * stdin 关闭或收到 SIGTERM 之后最迟 3 秒调它（lifecycle.md §7.5、§7.7）。在同一个进程里运行插件的测试传入自己的函数
   */
  readonly exit?: (code: number) => void;
}

/** 插件可以自报、并据此改变运行时状态的状态（plugin/lifecycle.md §7.4） */
const reportableStates: readonly LifecycleState[] = [
  LifecycleState.Ready,
  LifecycleState.Degraded,
  LifecycleState.Failed,
];

/** 不接受 `Stop` 的状态（lifecycle.md §7.1） */
const stopRefusedStates: readonly LifecycleState[] = [
  LifecycleState.Declared,
  LifecycleState.Draining,
  LifecycleState.Stopped,
];

/** `grace_seconds` 为 0 时的宽限（lifecycle.md §7.5） */
const defaultStopGrace = 5000;

/** stdin 关闭与 SIGTERM 之后到退出的时限（lifecycle.md §7.7） */
const shutdownLimit = 3000;

/** 收尾完成之后、进程还没退出时再等的毫秒数 */
const exitDelay = 1000;

/** gRPC 服务端优雅关闭等在途 RPC 的上限，之后强制关闭 */
const serverShutdownLimit = 1000;

/** 记过警告的未声明健康项名的上限：超出之后不再警告，集合不随健康回调报的名字无界增长（与 Go SDK 相同） */
const maxWarnedHealthItems = 256;

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
 * 依次：读清单并核对声明（插件、进程外、不贡献中间件、`primitives` 等于本 SDK 的原语层大版本，操作都在
 * `contributes.operations` 里，订阅合文法且（主题，类型）不重复，目录有 `en-US`），不合即在 stderr 记一条 `error` 日志、
 * 不监听、不写握手行并抛出（handshake.md §1）；读 handshake.md §1 的环境变量、按 §4 选回调端点并监听、向 stdout 写一行握手行，
 * 然后提供 Plugin 服务，直到 `Stop` 完成、stdin 关闭或收到 SIGTERM。每个 RPC 先按常数时间核对会话令牌，调用次序按
 * lifecycle.md §7。返回的 Promise 在服务停止、端点清理之后完成；之后不留下让进程继续运行的句柄。
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

  get serving(): boolean {
    return isServing(this.#state);
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

/** 监听之前备好的状态：清单与它的原文、调用器、宿主回调客户端与 gRPC 服务端 */
interface Prepared {
  readonly manifest: Manifest;
  /** 握手时原样交给宿主的清单原文：与 `manifest` 出自同一次读取 */
  readonly manifestText: string;
  readonly invoker: OperationInvoker;
  readonly host: Host;
  readonly server: Server;
}

/** 一个健康推送流：状态变化时推一条，收尾时结束 */
interface HealthWatcher {
  readonly push: () => void;
  readonly end: () => void;
}

/** 一次 `servePlugin` 的状态 */
class PluginRuntime {
  readonly #options: PluginOptions;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #logger: PluginLogger;
  readonly #exit: (code: number) => void;
  readonly #lifecycle = new Lifecycle();
  readonly #tenants = new TenantLedger();
  readonly #watchers = new Set<HealthWatcher>();
  /** 已经警告过的未声明健康项名，至多 {@link maxWarnedHealthItems} 个 */
  readonly #warnedItems = new Set<string>();
  /** 在途调用与投递的取消：停止时宽限到了、收尾时立即触发（lifecycle.md §7.5、§7.7） */
  readonly #inflight = new Set<AbortController>();
  readonly #idle: (() => void)[] = [];
  /** 清单 ID：读出清单之前为空串，只用在日志里 */
  #id = '';
  /** 监听之前备好的状态；备好之前为 `undefined` */
  #prepared: Prepared | undefined;
  #bound: BoundEndpoint | undefined;
  /** `Configure` 授予的权限 */
  #granted: ReadonlySet<string> = new Set();
  /** 最近一次健康回调的结果：可服务期间的推送带它的健康项 */
  #reported: PluginHealth | undefined;
  /** 启动回调成功过：停止时才调停止回调 */
  #started = false;
  /** 已经接受过一次 `Stop` */
  #stopAccepted = false;
  /** 已经收到 stdin 关闭或 SIGTERM */
  #shutdownRequested = false;
  /** 收尾的绝对时限（Unix 毫秒）：stdin 关闭或 SIGTERM 之后 3 秒 */
  #hardDeadline = Number.POSITIVE_INFINITY;
  #winding: Promise<Result<void>> | undefined;
  #shutdown: Promise<void> | undefined;
  #finish: () => void = () => {};
  #detach: () => void = () => {};

  constructor(options: PluginOptions) {
    this.#options = options;
    this.#env = options.env ?? process.env;
    this.#logger = options.logger ?? new PluginLogger(process.stderr);
    this.#exit = options.exit ?? ((code) => process.exit(code));
  }

  /**
   * 备好的状态：服务实现只在监听之后执行，那时它一定已经有了
   *
   * @remarks
   * 读不到是运行时自己的次序缺陷：抛出，不带着空值往下走
   */
  get #ready(): Prepared {
    const prepared = this.#prepared;
    if (prepared === undefined) {
      throw FrameworkError.invalidArgument('The plugin runtime serves nothing before it is prepared.');
    }
    return prepared;
  }

  async run(): Promise<void> {
    let listening: { readonly bound: BoundEndpoint; readonly line: string };
    try {
      listening = await this.#prepare();
    } catch (error) {
      // 拒绝启动：不监听、不写握手行，在 stderr 记一条 error 日志，宿主看到的是进程在握手之前退出（handshake.md §1、§5）
      this.#logger.error('the plugin cannot start', { plugin: this.#id, error });
      throw error;
    }
    const { bound, line } = listening;
    const done = new Promise<void>((resolve) => {
      this.#finish = resolve;
    });
    this.#watchInputs();
    // 握手行是 stdout 的第一行，握手完成之前不再写 stdout（handshake.md §2）
    (this.#options.stdout ?? process.stdout).write(`${line}\n`);
    this.#logger.information('listening', {
      plugin: this.#id,
      endpoint: `${bound.endpoint.network} ${bound.endpoint.address}`,
      instance: this.#env[PluginEnvironment.Instance] ?? '',
    });
    await done;
  }

  /** 读清单、核对声明与环境变量、监听端点，返回绑定的端点与握手行；任何一步不合即抛出，不写握手行 */
  async #prepare(): Promise<{ readonly bound: BoundEndpoint; readonly line: string }> {
    const source = await this.#readManifest();
    const { manifest } = source;
    this.#id = manifest.id;
    const registry = this.#options.registry ?? new OperationRegistry();
    this.#checkDeclarations(manifest, registry);
    const session = this.#env[PluginEnvironment.Session] ?? '';
    if (session === '') {
      throw FrameworkError.invalidArgument(`The environment variable '${PluginEnvironment.Session}' is required.`);
    }
    const invoker = new OperationInvoker(registry, this.#options.pipeline);
    const host = this.#readEnvironment(manifest, session);

    const server = new Server({ interceptors: [sessionInterceptor(session)] });
    server.addService(pb.PluginService, this.#service() as unknown as pb.PluginServer);
    // 绑定之前就备好：端点一绑定就可能有 RPC 进来
    this.#prepared = { manifest, manifestText: source.text, invoker, host, server };
    const bound = await bindEndpoint(server, this.#options.network ?? defaultNetwork(), this.#options.address);
    const line = formatHandshakeLine(bound.endpoint);
    if (line === undefined) {
      server.forceShutdown();
      bound.cleanup();
      throw FrameworkError.invalidArgument(
        `The endpoint '${bound.endpoint.address}' cannot be written as a handshake line.`,
      );
    }
    this.#bound = bound;
    return { bound, line };
  }

  /**
   * 清单的原文与读出的清单，两者出自同一次读取
   *
   * @remarks
   * 文件开头的 BOM 不是清单的一部分：宿主读文件时同样跳过它，握手交出的原文不带它（handshake.md §3 第 3 条）。
   * 省略清单时读插件目录（当前工作目录）里的文件，给的是字节时走同一个读取：按字节跳过 BOM、按严格的 UTF-8 解码，
   * 坏字节不换成 U+FFFD——换了之后握手交出的原文就与文件的字节不一致。给的是字符串时去掉开头的 U+FEFF
   */
  async #readSource(): Promise<Result<ManifestSource>> {
    const given = this.#options.manifest;
    if (given === undefined) {
      return readManifestSource(join(process.cwd(), ManifestFileName));
    }
    if (typeof given !== 'string') {
      return readManifestBytes(given);
    }
    const text = given.charCodeAt(0) === 0xfeff ? given.slice(1) : given;
    const read = readManifest(text);
    return read.ok ? Result.ok({ text, manifest: read.value }) : Result.fail(read.error);
  }

  /** 读清单并核对它描述的是进程外插件 */
  async #readManifest(): Promise<ManifestSource> {
    const read = await this.#readSource();
    if (!read.ok) {
      throw FrameworkError.fromErrorInfo(read.error);
    }
    const { manifest } = read.value;
    if (manifest.kind !== ManifestKind.Plugin || manifest.isolation !== PluginIsolation.OutOfProcess) {
      throw FrameworkError.invalidArgument(
        `The manifest '${manifest.id}' must describe a plugin with isolation 'out-of-process'.`,
      );
    }
    // 只有 Wasm 插件能贡献中间件：宿主在发现时拒绝写了 contributes.pipeline 的进程外插件（RFC-0017「范围」），这里在监听前就拒绝
    if ((manifest.contributes?.pipeline?.length ?? 0) > 0) {
      throw FrameworkError.invalidArgument(
        `The plugin '${manifest.id}' must not declare 'contributes.pipeline': only wasm plugins can contribute middleware.`,
      );
    }
    // 握手写清单的 primitives，宿主要求它等于自己的原语层大版本；本 SDK 只实现一个大版本（handshake.md §1、§3 第 2 条）
    if (String(manifest.primitives) !== FrameworkInfo.specVersion) {
      throw FrameworkError.invalidArgument(
        `The plugin '${manifest.id}' declares primitives '${manifest.primitives}', but this SDK implements primitives '${FrameworkInfo.specVersion}'.`,
      );
    }
    return read.value;
  }

  /** 握手只能细化清单里声明过的东西（handshake.md §1）：不合的声明在监听前拒绝，不等宿主在握手时拒绝 */
  #checkDeclarations(manifest: Manifest, registry: OperationRegistry): void {
    const declared = contributedOperations(manifest);
    // 登记表本身不收重复的操作 ID，这里只核对都在清单里
    for (const descriptor of registry.list()) {
      if (!declared.includes(descriptor.contract.id)) {
        throw FrameworkError.invalidArgument(
          `The operation '${descriptor.contract.id}' is not declared in 'contributes.operations' of '${manifest.id}'.`,
        );
      }
    }
    const pairs = new Set<string>();
    for (const subscription of this.#options.subscriptions ?? []) {
      const mode = subscription.mode ?? '';
      if (typeof subscription.handler !== 'function' || !isTopic(subscription.topic)) {
        throw FrameworkError.invalidArgument(
          `The subscription '${subscription.topic}' of '${manifest.id}' needs a valid topic and a handler.`,
        );
      }
      if (!isSubscriptionMode(mode)) {
        throw FrameworkError.invalidArgument(
          `The subscription '${subscription.topic}' of '${manifest.id}' has the mode '${mode}'; the mode must be empty, 'competing' or 'broadcast'.`,
        );
      }
      // 按（主题，类型）对去重而不看方式：同一对不能以两种方式各声明一次（handshake.md §3 第 5 条）
      const pair = writeJson([subscription.topic, subscription.messageType ?? '']);
      if (pairs.has(pair)) {
        throw FrameworkError.invalidArgument(
          `The subscription '${subscription.topic}' with the message type '${subscription.messageType ?? ''}' is declared more than once by '${manifest.id}'.`,
        );
      }
      pairs.add(pair);
    }
    for (const catalog of this.#options.catalogs ?? []) {
      checkCatalog(catalog);
    }
  }

  /** 读 handshake.md §1 的其余环境变量：只用于诊断的版本，以及宿主回调端点；返回连它的回调客户端 */
  #readEnvironment(manifest: Manifest, session: string): Host {
    const logger = this.#logger.with({ plugin: manifest.id });
    const versions = this.#env[PluginEnvironment.ProtocolVersions] ?? '';
    // 逐项严格读：空项（1,,2）不能当成 0，空白按 RFC-0001 的空白字符而不是 trim 的
    const listed = parseProtocolVersions(versions);
    if (listed === undefined) {
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
    // 取第一个本 SDK 能连的回调端点，之后不换；没有可用的项时照常服务，回调一律 plugins.host.unavailable（handshake.md §4）
    const address = this.#env[PluginEnvironment.HostAddress];
    const endpoint = selectHostEndpoint(address, callbackNetworks());
    if (endpoint === undefined) {
      logger.warning('no supported callback endpoint; callbacks to the host are unavailable', {
        address: address ?? '',
      });
    }
    const permissions = manifest.permissions ?? [];
    // 回调所需的权限既要在清单里声明、也要被宿主授予（invocation.md §5）
    const permitted = (permission: string) => permissions.includes(permission) && this.#granted.has(permission);
    return new Host(endpoint, session, manifest.id, this.#tenants, permitted);
  }

  /** stdin 读到结尾（或读出错）与 SIGTERM 都是收尾请求（lifecycle.md §7.7） */
  #watchInputs(): void {
    const stdin = this.#options.stdin ?? process.stdin;
    const close = () => this.#requestShutdown('stdin closed; stopping');
    const terminate = () => this.#requestShutdown('SIGTERM received; stopping');
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

  /**
   * 收尾请求（lifecycle.md §7.7）：可服务的进入 Draining，立即触发全部在途调用的取消并等它们，启动回调成功过的调一次停止回调
   * （`reason` 为 `shutdown`）；从收到起最多 3 秒，到时不论是否完成都以退出码 0 退出，正在处理的 `Stop` 同样受这个时限
   */
  #requestShutdown(message: string): void {
    // end、close 与 error 可能先后都到，Stop 之后也可能再到：只有第一个请求开始收尾
    if (this.#shutdownRequested || this.#shutdown !== undefined) {
      return;
    }
    this.#shutdownRequested = true;
    this.#hardDeadline = Date.now() + shutdownLimit;
    this.#logger.information(message, { plugin: this.#id });
    const timer = setTimeout(() => this.#exit(0), shutdownLimit);
    // 不让这个定时器拖住进程：收尾提前完成、事件循环空了，进程照常退出
    timer.unref();
    this.#abortInflight();
    void this.#wind('shutdown', shutdownLimit).then(() => this.#stop());
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
        // 应答送出之后再结束健康推送、停止服务：优雅停止要等包括这次 Stop 在内的在途 RPC 结束
        () => setImmediate(() => void this.#stop()),
      ),
      health: this.#unary((_call: Unary<pb.HealthRequest, pb.HealthResponse>) => this.#toProtoHealth(this.#evaluate())),
      watchHealth: (call: ServerWritableStream<pb.HealthRequest, pb.HealthResponse>) => this.#watchHealth(call),
      invoke: this.#unary((call: Unary<pb.InvokeRequest, pb.InvokeResponse>) => this.#invoke(call)),
      invokeStream: (call: ServerDuplexStream<pb.StreamFrame, pb.StreamFrame>) => this.#invokeStream(call),
      handleEvent: this.#unary((call: Unary<pb.HandleEventRequest, pb.HandleEventResponse>) => this.#handleEvent(call)),
    };
  }

  /** 把返回 Promise 的处理函数包成 grpc-js 的一元处理器；`after` 在成功的应答交给 grpc-js 之后执行 */
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

  /** 握手（handshake.md §3）：协商版本、报清单的原语层版本，交出清单原文、操作、订阅与作者自己的目录 */
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
    const { manifest, manifestText, invoker } = this.#ready;
    const response: pb.HandshakeResponse = {
      protocolVersion: selected,
      primitives: manifest.primitives,
      manifest: manifestText,
      sdk: { name: FrameworkInfo.sdkName, version: FrameworkInfo.sdkVersion, language: 'typescript' },
      // 只声明一元操作：流式操作等流式契约的 RFC（handshake.md §3 第 4 条）
      operations: invoker.registry.list().map((descriptor) => ({
        id: descriptor.contract.id,
        stability: descriptor.contract.stability,
        expose: [...descriptor.contract.expose],
        permission: descriptor.contract.permission ?? '',
        policy: descriptor.contract.policy ?? '',
        requestSchema: descriptor.schema?.request ?? '',
        responseSchema: descriptor.schema?.response ?? '',
        streaming: false,
      })),
      // 按声明的顺序写订阅，方式总是写出 competing 或 broadcast（handshake.md §3 第 5 条）
      subscriptions: (this.#options.subscriptions ?? []).map((subscription) => ({
        topic: subscription.topic,
        messageType: subscription.messageType ?? '',
        mode: subscription.mode || SubscriptionMode.Competing,
      })),
      // 只发作者自己的目录：SDK 运行时的消息键由宿主提供（handshake.md §3 第 6 条）
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

  /**
   * 配置（lifecycle.md §7.2）：空等同 `{}`；配置节必须通过共同的 JSON 读取检查且是对象，否则不调回调、进入 Failed
   */
  async #configure(request: pb.ConfigureRequest): Promise<pb.ConfigureResponse> {
    if (this.#lifecycle.state !== LifecycleState.Resolved) {
      throw statusError(grpcStatus.FAILED_PRECONDITION, 'Configure requires a completed handshake.');
    }
    const text = request.configuration === '' ? '{}' : request.configuration;
    const read = readJsonText(text);
    let outcome: Result<void>;
    if (!read.ok || !(read.root instanceof JsonMembers)) {
      outcome = Result.fail(processFailed(this.#id, 'configure', PluginReason.ConfigurationNotObject));
    } else {
      const section = toJsonValue(read.root) as JsonObject;
      this.#granted = new Set(request.grantedPermissions);
      const configuration: PluginConfiguration = Object.freeze({
        section,
        values: new ConfigurationSection(section),
        text,
        grantedPermissions: Object.freeze([...request.grantedPermissions]),
        bindings: Object.freeze(request.bindings.map((binding) => Object.freeze({ ...binding }))),
        workDirectory: request.workDirectory,
      });
      const hook = this.#options.hooks?.configure;
      outcome = hook === undefined ? Result.success() : await this.#runHook('configure', () => hook(configuration));
    }
    this.#settle(LifecycleState.Configured, outcome, 'configure failed');
    return { status: toStatus(outcome) };
  }

  /**
   * 启动（lifecycle.md §7.3）：启动回调成功后进入 Started，有健康回调时立即求一次、按结果进入 Ready、Degraded 或 Failed，
   * 没有健康回调即 Ready，然后才应答
   */
  async #start(): Promise<pb.StartResponse> {
    if (this.#lifecycle.state !== LifecycleState.Configured) {
      throw statusError(grpcStatus.FAILED_PRECONDITION, 'Start requires a successful Configure.');
    }
    const hook = this.#options.hooks?.start;
    const outcome = hook === undefined ? Result.success() : await this.#runHook('start', () => hook());
    this.#settle(LifecycleState.Started, outcome, 'start failed');
    if (outcome.ok) {
      this.#started = true;
      this.#becomeReady();
    }
    return { status: toStatus(outcome) };
  }

  /** `Start` 成功之后的第一次健康：回调报 Ready、Degraded 或 Failed 照办，抛出为 Degraded，报其他状态或没有回调为 Ready */
  #becomeReady(): void {
    const hook = this.#options.hooks?.health;
    if (hook === undefined) {
      this.#lifecycle.transition(LifecycleState.Ready);
      return;
    }
    const health = this.#callHealth(hook);
    const state = reportableStates.includes(health.state) ? health.state : LifecycleState.Ready;
    this.#lifecycle.transition(state, health.error);
  }

  /** 按结果迁移到下一个状态或 Failed */
  #settle(next: LifecycleState, outcome: Result<void>, message: string): void {
    if (outcome.ok) {
      this.#lifecycle.transition(next);
      return;
    }
    this.#lifecycle.transition(LifecycleState.Failed, outcome.error);
    this.#logger.error(message, { plugin: this.#id, code: outcome.error.code, reason: messageOf(outcome.error) });
  }

  /**
   * `Stop`（lifecycle.md §7.1、§7.5）：Declared、Draining、Stopped 与已经接受过一次 `Stop` 时以 `FailedPrecondition` 拒绝；
   * 其余按 {@link PluginRuntime.#wind} 收尾后应答，应答之后停止服务、退出
   */
  async #stopCall(request: pb.StopRequest): Promise<pb.StopResponse> {
    if (stopRefusedStates.includes(this.#lifecycle.state) || this.#stopAccepted) {
      throw statusError(
        grpcStatus.FAILED_PRECONDITION,
        `Stop is not accepted in the state '${this.#lifecycle.state}'.`,
      );
    }
    this.#stopAccepted = true;
    const grace = request.graceSeconds > 0 ? request.graceSeconds * 1000 : defaultStopGrace;
    const outcome = await this.#wind(request.reason, grace);
    return { status: toStatus(outcome) };
  }

  /** 收尾只做一次：`Stop` 与 stdin 关闭、SIGTERM 共用同一次收尾，先到的定下参数 */
  #wind(reason: string, grace: number): Promise<Result<void>> {
    this.#winding ??= this.#windOnce(reason, grace);
    return this.#winding;
  }

  /**
   * 收尾（lifecycle.md §7.5）：可服务的进入 Draining（拒绝新调用、推一次健康），等在途调用到宽限期，到时触发它们的取消、
   * 不再等；然后启动回调成功过的调停止回调（进程里最多一次）。启动回调没成功过的不调停止回调、照样应答 `ok`
   */
  async #windOnce(reason: string, grace: number): Promise<Result<void>> {
    const started = Date.now();
    // 启动成功过后进入 Failed 的不迁移状态，Started 只在 Start 应答之前出现
    if (this.#lifecycle.serving || this.#lifecycle.state === LifecycleState.Started) {
      this.#lifecycle.transition(LifecycleState.Draining);
    }
    this.#logger.information('stopping', { plugin: this.#id, reason, grace });
    if (!(await this.#whenIdle(Math.min(started + grace, this.#hardDeadline) - Date.now()))) {
      this.#logger.warning('in-flight calls did not finish within the grace period; cancelling them', {
        plugin: this.#id,
      });
      this.#abortInflight();
    }
    const hook = this.#options.hooks?.stop;
    if (!this.#started || hook === undefined) {
      return Result.success();
    }
    // 留给停止回调的时间：宽限期剩下的，收尾请求之后不超过 3 秒的时限
    const remaining = Math.max(1, Math.min(started + grace, this.#hardDeadline) - Date.now());
    const signal = AbortSignal.timeout(remaining);
    return this.#runHook('stop', () => hook(Object.freeze({ reason, grace: remaining, signal })));
  }

  /**
   * 停止服务：结束健康推送、关闭 gRPC 服务端、删私有目录、断开宿主、放开 stdin，进入 Stopped；只执行一次。
   * 之后进程还没退出时，1 秒后以退出码 0 退出
   */
  #stop(): Promise<void> {
    this.#shutdown ??= (async () => {
      await (this.#winding ?? Promise.resolve());
      this.#endWatchers();
      // 没有备好就没有服务端与宿主客户端要关
      const prepared = this.#prepared;
      if (prepared !== undefined) {
        const { server } = prepared;
        await new Promise<void>((resolve) => {
          // 优雅关闭等在途 RPC 结束；长流已经结束，仍有卡住的调用时到点强制关闭
          const timer = setTimeout(() => {
            server.forceShutdown();
            resolve();
          }, serverShutdownLimit);
          timer.unref();
          server.tryShutdown(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      this.#bound?.cleanup();
      prepared?.host.close();
      this.#detach();
      this.#lifecycle.transition(LifecycleState.Stopped);
      this.#logger.information('stopped', { plugin: this.#id });
      // 运行时自己不再留下句柄；作者的代码还让进程活着时，到点以退出码 0 退出（lifecycle.md §7.5）
      const timer = setTimeout(() => this.#exit(0), exitDelay);
      timer.unref();
      this.#finish();
    })();
    return this.#shutdown;
  }

  /** 执行一个生命周期回调：抛出的异常只把文本写进日志，作为 `PLUGINS_UNEXPECTED_001` 返回，`reason` 是简单类型名 */
  async #runHook(phase: string, hook: () => Promise<Result<void>> | Result<void>): Promise<Result<void>> {
    try {
      const outcome = await hook();
      if (outcome === null || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
        // 编程错误，与抛出同样处理：异常的类型就是 TypeError
        throw new TypeError(`The ${phase} hook did not return a Result.`);
      }
      return outcome;
    } catch (error) {
      this.#logger.error(`the ${phase} hook threw`, { plugin: this.#id, error });
      return Result.fail(processFailed(this.#id, phase, thrownTypeName(error)));
    }
  }

  /**
   * 当前健康（lifecycle.md §7.4）：可服务期间求一次健康回调再报，其余状态不调回调、报本地状态
   */
  #evaluate(): PluginHealth {
    const hook = this.#options.hooks?.health;
    if (hook !== undefined && this.#lifecycle.serving) {
      const health = this.#callHealth(hook);
      // 只有回调报的 Ready、Degraded、Failed 改变状态；迁移按原语层的表，Failed 之后不再回来
      if (reportableStates.includes(health.state) && health.state !== this.#lifecycle.state) {
        this.#lifecycle.transition(health.state, health.error);
      }
    }
    return this.#snapshot();
  }

  /** 求一次健康回调：未声明的健康项丢掉（同名只记一次 warning），抛出时这一次是 Degraded、没有健康项 */
  #callHealth(hook: () => PluginHealth): PluginHealth {
    let reported: PluginHealth;
    try {
      reported = hook();
      if (reported === null || typeof reported !== 'object') {
        throw new TypeError('The health hook did not return a health.');
      }
    } catch (error) {
      this.#logger.error('the health hook threw', { plugin: this.#id, error });
      reported = {
        state: LifecycleState.Degraded,
        items: [],
        error: processFailed(this.#id, 'health', thrownTypeName(error)),
      };
    }
    const declared = contributedHealth(this.#ready.manifest);
    const items = (reported.items ?? []).filter((item) => {
      if (declared.includes(item.name)) {
        return true;
      }
      // 宿主按清单核对健康项（lifecycle.md §4），未声明的不上报；同一个名字在进程里只警告一次。
      // 记过的名字有上限：健康回调可以每次报不同的名字，超出之后不再警告，集合不无界增长
      if (!this.#warnedItems.has(item.name) && this.#warnedItems.size < maxWarnedHealthItems) {
        this.#warnedItems.add(item.name);
        this.#logger.warning('health item is not declared in contributes.health', {
          plugin: this.#id,
          item: item.name,
        });
      }
      return false;
    });
    const health: PluginHealth = {
      state: reported.state,
      items,
      ...(reported.error === undefined ? {} : { error: reported.error }),
    };
    this.#reported = health;
    return health;
  }

  /** 不调回调的健康：状态是运行时的；可服务期间带最近一次回调的健康项与错误，其余状态没有健康项 */
  #snapshot(): PluginHealth {
    const state = this.#lifecycle.state;
    const reported = this.#lifecycle.serving ? this.#reported : undefined;
    const error = reported?.error ?? this.#lifecycle.error;
    return { state, items: reported?.items ?? [], ...(error === undefined ? {} : { error }) };
  }

  #toProtoHealth(health: PluginHealth): pb.HealthResponse {
    return {
      state: toProtoState(health.state),
      items: (health.items ?? []).map((item) => ({
        name: item.name,
        status: healthStatusValues[item.status] ?? pb.HealthStatus.HEALTH_STATUS_UNSPECIFIED,
        description: item.description ?? '',
      })),
      error: health.error === undefined ? undefined : toProtoError(health.error),
    };
  }

  /**
   * `WatchHealth`（lifecycle.md §7.4）：先推当前状态，之后状态、健康项或错误变化时推送；可服务期间按间隔重新求健康回调。
   * 进入 Draining 时推一次，应答 `Stop` 之后（或收尾时）结束流
   */
  #watchHealth(call: ServerWritableStream<pb.HealthRequest, pb.HealthResponse>): void {
    let last = '';
    const write = (health: PluginHealth) => {
      if (call.cancelled || call.writableEnded) {
        return;
      }
      const response = this.#toProtoHealth(health);
      // 按编码后的字节判断有没有变化：状态、健康项与错误任何一处变了都算
      const key = Buffer.from(pb.HealthResponse.encode(response).finish()).toString('base64');
      if (key !== last) {
        last = key;
        call.write(response);
      }
    };
    const push = () => write(this.#snapshot());
    const timer = setInterval(() => {
      if (this.#lifecycle.serving) {
        write(this.#evaluate());
      }
    }, this.#options.healthInterval ?? 10_000);
    timer.unref();
    let unwatch = () => {};
    const release = () => {
      clearInterval(timer);
      unwatch();
      this.#watchers.delete(watcher);
    };
    const watcher: HealthWatcher = {
      push,
      end: () => {
        push();
        release();
        if (!call.cancelled && !call.writableEnded) {
          call.end();
        }
      },
    };
    push();
    // 服务已经在停止：推完当前状态就结束，长流不能拖住优雅停止
    if (this.#shutdown !== undefined) {
      watcher.end();
      return;
    }
    unwatch = this.#lifecycle.watch(push);
    this.#watchers.add(watcher);
    call.on('cancelled', release);
  }

  #endWatchers(): void {
    for (const watcher of [...this.#watchers]) {
      watcher.end();
    }
  }

  /**
   * 执行一次调用或投递：构造调用上下文（元数据、gRPC 的取消与截止时间、宿主客户端），计入在途调用与租户
   */
  async #track<T>(
    call: ServerUnaryCall<unknown, unknown>,
    metadata: pb.InvocationMetadata | undefined,
    work: (context: InvocationContext) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (call.cancelled) {
      controller.abort();
    } else {
      call.once('cancelled', abort);
    }
    const deadline = call.getDeadline();
    const callDeadline =
      deadline instanceof Date ? deadline.getTime() : Number.isFinite(deadline) ? deadline : undefined;
    const context = contextFromMetadata(metadata, controller.signal, callDeadline);
    attachHost(context, this.#ready.host);
    const tenant = tenantOf(context);
    this.#inflight.add(controller);
    this.#tenants.enter(tenant);
    try {
      return await work(context);
    } finally {
      call.removeListener('cancelled', abort);
      this.#tenants.leave(tenant);
      this.#inflight.delete(controller);
      if (this.#inflight.size === 0) {
        for (const resolve of this.#idle.splice(0)) {
          resolve();
        }
      }
    }
  }

  /** 触发全部在途调用的取消信号（RFC-0003：只经信号通知，不强行中止处理器） */
  #abortInflight(): void {
    for (const controller of this.#inflight) {
      controller.abort();
    }
  }

  /** 等在途调用结束；超时返回假 */
  #whenIdle(timeout: number): Promise<boolean> {
    if (this.#inflight.size === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(0, timeout));
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * `Invoke`（invocation.md §1）：会话令牌之后依次核对，操作在握手声明里（否则 gRPC `Unimplemented`）、插件在可服务状态
   * （否则 `PLUGINS_UNAVAILABLE_001` + `plugins.process.unavailable`），然后还原上下文、经调用器与完整管道执行，空载荷等同 `{}`
   */
  async #invoke(call: ServerUnaryCall<pb.InvokeRequest, pb.InvokeResponse>): Promise<pb.InvokeResponse> {
    const request = call.request;
    const { invoker } = this.#ready;
    if (invoker.registry.find(request.operation) === undefined) {
      throw statusError(
        grpcStatus.UNIMPLEMENTED,
        `The operation '${request.operation}' is not provided by this plugin.`,
      );
    }
    if (!this.#lifecycle.serving) {
      return { status: toStatus(Result.fail(this.#unavailable())), payload: new Uint8Array() };
    }
    return this.#track(call, request.metadata, async (context) => {
      try {
        const response = await invoker.invoke(context, { id: request.operation, payload: request.payload });
        return { status: toStatus(response.outcome), payload: toBytes(response.payload) };
      } catch (error) {
        // 排在 Observe 内置步骤之前的中间件抛出的异常：调用方在进程外，交回未处理异常，不把异常消息写上线
        this.#logger.error('the invocation threw', { plugin: this.#id, operation: request.operation, error });
        return { status: toStatus(Result.fail(unhandled(error))), payload: new Uint8Array() };
      }
    });
  }

  /**
   * `InvokeStream`（invocation.md §1）：会话令牌之后读第一帧，流在第一帧之前结束或第一帧不是 `start` 时以 `InvalidArgument`
   * 结束，第一帧是 `start` 时以 `Unimplemented` 结束，不论操作是否声明、插件是否就绪
   *
   * @remarks
   * 流式操作的契约还没有定义（RFC-0017「非目标」），本 SDK 不实现流式调用、也不提供声明流式操作的 API
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
        answer(grpcStatus.UNIMPLEMENTED, 'This plugin does not implement streaming operations.');
      }
    });
    call.on('end', () => answer(grpcStatus.INVALID_ARGUMENT, 'The stream ended before its start frame.'));
  }

  /**
   * `HandleEvent`（invocation.md §4）：会话令牌之后依次核对
   *
   * @remarks
   * 没有信封或方式不是空、`competing`、`broadcast` 以 gRPC `InvalidArgument` 拒绝；按（主题，方式，类型）找订阅，一个也没有为
   * `KERNEL_NOTFOUND_001` + `plugins.event.unsubscribed`，不改交给另一种方式的处理器；不在可服务状态为
   * `PLUGINS_UNAVAILABLE_001`；然后还原上下文，匹配的订阅按声明顺序依次执行，第一个失败即终止并作为结果，
   * 处理器抛出为 `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception`（调用已中止时抛出的中止按取消归因）
   */
  async #handleEvent(
    call: ServerUnaryCall<pb.HandleEventRequest, pb.HandleEventResponse>,
  ): Promise<pb.HandleEventResponse> {
    const request = call.request;
    if (request.envelope === undefined || !isSubscriptionMode(request.mode)) {
      throw statusError(
        grpcStatus.INVALID_ARGUMENT,
        "A delivery needs an envelope and a mode that is empty, 'competing' or 'broadcast'.",
      );
    }
    const envelope = fromProtoEnvelope(request.envelope);
    const mode = (request.mode || SubscriptionMode.Competing) as SubscriptionMode;
    const handlers = (this.#options.subscriptions ?? []).filter(
      (subscription) =>
        subscription.topic === envelope.topic &&
        (subscription.mode || SubscriptionMode.Competing) === mode &&
        (!subscription.messageType || subscription.messageType === envelope.type),
    );
    if (handlers.length === 0) {
      const error = eventUnsubscribed(this.#id, envelope.topic, envelope.type, mode);
      return { status: toStatus(Result.fail(error)) };
    }
    if (!this.#lifecycle.serving) {
      return { status: toStatus(Result.fail(this.#unavailable())) };
    }
    const delivery: EventDelivery = Object.freeze({ attempt: request.attempt, mode });
    return this.#track(call, request.metadata, async (context) => {
      for (const subscription of handlers) {
        let outcome: Result<void>;
        try {
          outcome = await subscription.handler(context, envelope, delivery);
          if (outcome === null || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
            throw new TypeError('An event handler did not return a Result.');
          }
        } catch (error) {
          this.#logger.error('the event handler threw', { plugin: this.#id, topic: envelope.topic, error });
          const cancellation = context.cancellation;
          outcome = Result.fail(
            cancellation !== undefined && isAbort(error, context.signal) ? cancellation : unhandled(error),
          );
        }
        if (!outcome.ok) {
          return { status: toStatus(outcome) };
        }
      }
      return { status: toStatus(Result.success()) };
    });
  }

  /** 不在可服务状态：`PLUGINS_UNAVAILABLE_001` + `plugins.process.unavailable`，`state` 是此刻的状态名 */
  #unavailable(): ErrorInfo {
    return processUnavailable(this.#id, this.#lifecycle.state);
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

/**
 * 调用期间未处理的异常（RFC-0011 规则 5、10）：`KERNEL_UNEXPECTED_001`，没有参数，FrameworkError 的错误放进 `inner`
 */
function unhandled(error: unknown): ErrorInfo {
  return ErrorInfo.unexpected(
    OperationErrorCode.Unexpected,
    InvocationMessageKey.UnhandledException,
    undefined,
    error instanceof FrameworkError ? error.toErrorInfo() : undefined,
  );
}
