/**
 * 协议 `xihan.plugin.v1` 的常量与文法（RFC-0017，spec/plugin/handshake.md）
 */
export const PluginProtocol = Object.freeze({
  /** 本 SDK 实现的协议版本 */
  version: 1,
  /** 握手行格式版本（handshake.md §2）；与协议版本无关，只在行格式变化时递增 */
  handshakeLineVersion: 'xihan-plugin/1',
  /** 携带会话令牌的元数据键：宿主调用插件、插件回调宿主的每次 RPC 都带它（handshake.md §4） */
  sessionMetadataKey: 'xihan-plugin-session',
} as const);

/**
 * 宿主启动插件时下发的环境变量（handshake.md §1）
 */
export const PluginEnvironment = Object.freeze({
  /** 宿主支持的协议版本，逗号分隔、升序 */
  ProtocolVersions: 'XIHAN_PLUGIN_PROTOCOL_VERSIONS',
  /** 宿主的原语层大版本 */
  Primitives: 'XIHAN_PLUGIN_PRIMITIVES',
  /** 本次启动的会话令牌 */
  Session: 'XIHAN_PLUGIN_SESSION',
  /** 宿主回调端点 `<network> <address>` */
  HostAddress: 'XIHAN_PLUGIN_HOST_ADDRESS',
  /** 实例 ID */
  Instance: 'XIHAN_PLUGIN_INSTANCE',
  /** 宿主默认区域（BCP 47） */
  Locale: 'XIHAN_PLUGIN_LOCALE',
} as const);

/**
 * 插件运行时用到的插件协议错误码（RFC-0017「错误码」，conventions/error-codes.md）
 */
export const PluginErrorCode = Object.freeze({
  /** 回调被拒：会话令牌无效、权限未声明或未授予、带了宿主没有交给插件的租户 */
  CallbackDenied: 'PLUGINS_DENIED_002',
  /** 插件未就绪或正在停止，暂不接受调用 */
  Unavailable: 'PLUGINS_UNAVAILABLE_001',
  /** 配置、启动、停止或回调时的未预期失败 */
  Unexpected: 'PLUGINS_UNEXPECTED_001',
} as const);

/**
 * 插件运行时用到的消息键：与参考实现的插件协议目录同键同参数，文案见 {@link pluginMessages}
 */
export const PluginMessageKey = Object.freeze({
  /** 插件不可用，参数 `id`、`state` */
  Unavailable: 'plugins.process.unavailable',
  /** 插件在某一步失败，参数 `id`、`phase`、`reason` */
  Failed: 'plugins.process.failed',
  /** 回调所需的权限未声明或未授予，参数 `id`、`permission` */
  CallbackDenied: 'plugins.callback.denied',
  /** 回调带了宿主没有交给插件的租户，参数 `id`、`tenant` */
  TenantDenied: 'plugins.callback.tenant_denied',
  /** 会话令牌缺失或无效，没有参数 */
  SessionInvalid: 'plugins.callback.session_invalid',
} as const);

/**
 * 回调宿主所需的清单权限（invocation.md §5）
 */
export const CallbackPermission = Object.freeze({
  /** `Host.Invoke` */
  Invoke: 'capability:kernel.pipeline',
  /** `Host.Publish` */
  Publish: 'capability:messaging.queue',
} as const);

/**
 * 端点的网络类型（plugin.proto 的 `Endpoint.network`）
 */
export const EndpointNetwork = Object.freeze({
  /** Unix 域套接字 */
  Unix: 'unix',
  /** TCP，只用回环地址 */
  Tcp: 'tcp',
  /** Windows 命名管道 */
  NamedPipe: 'npipe',
} as const);

/**
 * 网络类型之一
 */
export type EndpointNetwork = (typeof EndpointNetwork)[keyof typeof EndpointNetwork];

/**
 * 一个本机 gRPC 端点
 */
export interface PluginEndpoint {
  /** 网络类型 */
  readonly network: EndpointNetwork;
  /** 套接字路径、`host:port` 或管道名 */
  readonly address: string;
}

/**
 * 订阅方式（RFC-0009「订阅方式」）
 */
export const SubscriptionMode = Object.freeze({
  /** 竞争消费：订阅了主题的宿主实例里只有一个收到；声明与投递里的空都同它 */
  Competing: 'competing',
  /** 广播：每个在线的宿主实例各收到一份，尽力而为、不进死信 */
  Broadcast: 'broadcast',
} as const);

/**
 * 订阅方式之一
 */
export type SubscriptionMode = (typeof SubscriptionMode)[keyof typeof SubscriptionMode];

/** 握手行文法（handshake.md §2），整串匹配 */
const handshakeLinePattern = /^xihan-plugin\/1 (unix|tcp|npipe) (\S+)$/;

/** TCP 的回环地址：`127.0.0.1:<port>` 或 `[::1]:<port>`，主机名不算（handshake.md §2） */
const loopbackPattern = /^(?:127\.0\.0\.1|\[::1\]):[0-9]+$/;

/** 主题文法（RFC-0009「信封」） */
const topicPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * 解析握手行；不合文法或 TCP 地址不是回环地址时为 `undefined`
 *
 * @remarks
 * 文法 `^xihan-plugin/1 (unix|tcp|npipe) (\S+)$`，向量见 spec/conformance/vectors/plugin/handshake-lines.json
 */
export function parseHandshakeLine(line: string): PluginEndpoint | undefined {
  const match = handshakeLinePattern.exec(line);
  if (match === null) {
    return undefined;
  }
  const network = match[1] as EndpointNetwork;
  const address = match[2] ?? '';
  if (network === EndpointNetwork.Tcp && !loopbackPattern.test(address)) {
    return undefined;
  }
  return { network, address };
}

/**
 * 写出握手行（不含结尾的换行）；写出的行总能按 {@link parseHandshakeLine} 读回
 *
 * @returns 握手行；端点写不成合法的行（地址含空白、TCP 地址不是回环地址）时为 `undefined`
 */
export function formatHandshakeLine(endpoint: PluginEndpoint): string | undefined {
  const line = `${PluginProtocol.handshakeLineVersion} ${endpoint.network} ${endpoint.address}`;
  return parseHandshakeLine(line) === undefined ? undefined : line;
}

/**
 * 解析 `<network> <address>`（环境变量 `XIHAN_PLUGIN_HOST_ADDRESS` 的格式）；不合法时为 `undefined`
 */
export function parseEndpoint(text: string): PluginEndpoint | undefined {
  const separator = text.indexOf(' ');
  if (separator < 0) {
    return undefined;
  }
  return parseHandshakeLine(`${PluginProtocol.handshakeLineVersion} ${text}`);
}

/**
 * 协商协议版本：宿主列表里最高的、本方也支持的版本（handshake.md §3 第 1 条）
 *
 * @returns 选定的版本；没有交集时为 `undefined`。向量见 spec/conformance/vectors/plugin/protocol-versions.json
 */
export function negotiateProtocolVersion(
  host: readonly number[],
  supported: readonly number[] = [PluginProtocol.version],
): number | undefined {
  let selected: number | undefined;
  for (const candidate of host) {
    if (supported.includes(candidate) && (selected === undefined || candidate > selected)) {
      selected = candidate;
    }
  }
  return selected;
}

/**
 * 判断主题是否符合 RFC-0009 的文法 `^[a-z0-9][a-z0-9._-]{0,127}$`
 */
export function isTopic(topic: string): boolean {
  return topicPattern.test(topic);
}

/**
 * 判断订阅方式是否合法：空、`competing` 或 `broadcast`（handshake.md §3 第 5 条）
 */
export function isSubscriptionMode(mode: string): boolean {
  return mode === '' || mode === SubscriptionMode.Competing || mode === SubscriptionMode.Broadcast;
}
