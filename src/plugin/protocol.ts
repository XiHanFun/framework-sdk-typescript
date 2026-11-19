import { isWhitespace } from '../primitives/whitespace.ts';

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
  /** 宿主回调端点：一个或多个 `<network> <address>`，按宿主的偏好排序、以 `;` 分隔（handshake.md §4） */
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
  /** 插件不在可服务状态，或回调连不上宿主、没有可用的回调端点 */
  Unavailable: 'PLUGINS_UNAVAILABLE_001',
  /** 生命周期或健康回调抛出、配置节不是 JSON 对象、对方写来的错误不合法、没有对应的 gRPC 状态 */
  Unexpected: 'PLUGINS_UNEXPECTED_001',
} as const);

/**
 * SDK 运行时与宿主共用的消息键（plugin/invocation.md §8）：码、键与参数照 spec/conformance/vectors/plugin/plugin-messages.json，
 * 文案见 {@link pluginMessages}
 *
 * @remarks
 * `id` 一律是插件的清单 ID；错误的 `details` 就是这些参数，不另加成员
 */
export const PluginMessageKey = Object.freeze({
  /** 插件不在可服务状态（`PLUGINS_UNAVAILABLE_001`），参数 `id`、`state` */
  Unavailable: 'plugins.process.unavailable',
  /** 插件在某一步失败（`PLUGINS_UNEXPECTED_001`），参数 `id`、`phase`、`reason` */
  Failed: 'plugins.process.failed',
  /** 投递找不到订阅（`KERNEL_NOTFOUND_001`），参数 `id`、`topic`、`type`、`mode` */
  Unsubscribed: 'plugins.event.unsubscribed',
  /** 回调连不上宿主或没有可用的回调端点（`PLUGINS_UNAVAILABLE_001`），参数 `id`、`reason` */
  HostUnavailable: 'plugins.host.unavailable',
  /** 回调所需的权限未声明或未授予（`PLUGINS_DENIED_002`），参数 `id`、`permission` */
  CallbackDenied: 'plugins.callback.denied',
  /** 回调带了宿主没有交给插件的租户（`PLUGINS_DENIED_002`），参数 `id`、`tenant` */
  TenantDenied: 'plugins.callback.tenant_denied',
  /** 宿主拒绝了会话令牌（`PLUGINS_DENIED_002`），没有参数 */
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

/** 握手行格式版本 1 的前缀，含其后的一个空格（handshake.md §2） */
const handshakeLinePrefix = `${PluginProtocol.handshakeLineVersion} `;

/** 端点允许的网络类型（handshake.md §2） */
const endpointNetworks: readonly string[] = Object.values(EndpointNetwork);

/** 主题文法（RFC-0009「信封」） */
const topicPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** 文本里有没有握手行所说的空白（handshake.md §2，即 RFC-0001「空白字符」） */
function hasEndpointWhitespace(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isWhitespace(text.charCodeAt(index))) {
      return true;
    }
  }
  return false;
}

/**
 * 解析去掉行尾之后的握手行 `xihan-plugin/1 <network> <address>`（handshake.md §2）；不合文法时为 `undefined`
 *
 * @remarks
 * 前缀之后的部分同 {@link parseEndpoint}；文法整串匹配，结尾的换行不例外。
 * 向量见 spec/conformance/vectors/plugin/handshake-lines.json
 */
export function parseHandshakeLine(line: string): PluginEndpoint | undefined {
  return line.startsWith(handshakeLinePrefix) ? parseEndpoint(line.slice(handshakeLinePrefix.length)) : undefined;
}

/**
 * 写出握手行（不含结尾的换行）；写出的行总能按 {@link parseHandshakeLine} 读回
 *
 * @returns 握手行；端点写不成合法的行（地址为空或含空白、TCP 地址不是回环地址加端口）时为 `undefined`
 */
export function formatHandshakeLine(endpoint: PluginEndpoint): string | undefined {
  const line = `${handshakeLinePrefix}${endpoint.network} ${endpoint.address}`;
  return parseHandshakeLine(line) === undefined ? undefined : line;
}

/**
 * 解析一个端点 `<network> <address>`（handshake.md §2）；不合法时为 `undefined`
 *
 * @remarks
 * `network` 是 `unix`、`tcp` 或 `npipe`，与地址之间恰好一个空格；地址是一个或多个空白之外的字符（含非 ASCII 字母与 `;`）。
 * `tcp` 的地址必须是回环地址加端口：IPv4 是 `127.0.0.0/8` 里四段、不带前导零的点分十进制，IPv6 只认 `[::1]`，
 * 端口是 1–65535、不带正负号与前导零的十进制；主机名不算
 */
export function parseEndpoint(text: string): PluginEndpoint | undefined {
  const separator = text.indexOf(' ');
  if (separator < 0) {
    return undefined;
  }
  const network = text.slice(0, separator);
  const address = text.slice(separator + 1);
  if (!endpointNetworks.includes(network) || address === '' || hasEndpointWhitespace(address)) {
    return undefined;
  }
  if (network === EndpointNetwork.Tcp && !isLoopbackAddress(address)) {
    return undefined;
  }
  return { network: network as EndpointNetwork, address };
}

/**
 * 解析宿主回调端点列表 `XIHAN_PLUGIN_HOST_ADDRESS`（handshake.md §4）；不合法时为 `undefined`
 *
 * @remarks
 * 文法 `^(unix|tcp|npipe) <地址>(;(unix|tcp|npipe) <地址>)*\z`：每项同 {@link parseEndpoint} 且地址不含 `;`，
 * 任何一项不合法整个值就不合法，空串也不合法。向量见 spec/conformance/vectors/plugin/host-addresses.json
 */
export function parseHostAddresses(value: string): readonly PluginEndpoint[] | undefined {
  const endpoints: PluginEndpoint[] = [];
  // 按 ; 切开后地址里自然没有 ;；开头、结尾或连续的 ; 切出的空项在 parseEndpoint 里不合法
  for (const part of value.split(';')) {
    const endpoint = parseEndpoint(part);
    if (endpoint === undefined) {
      return undefined;
    }
    endpoints.push(endpoint);
  }
  return endpoints;
}

/**
 * 按 handshake.md §4 选回调端点：值合法时按顺序取第一个网络类型在 `supported` 里的项
 *
 * @returns 选中的端点；变量缺失（`undefined`）、不合法或没有可用的项时为 `undefined`，这时回调以
 * `PLUGINS_UNAVAILABLE_001` + `plugins.host.unavailable` 失败、不发请求
 */
export function selectHostEndpoint(
  value: string | undefined,
  supported: readonly EndpointNetwork[],
): PluginEndpoint | undefined {
  const endpoints = value === undefined ? undefined : parseHostAddresses(value);
  return endpoints?.find((endpoint) => supported.includes(endpoint.network));
}

/** tcp 端点的地址是不是回环地址加端口（handshake.md §2） */
function isLoopbackAddress(address: string): boolean {
  const separator = address.lastIndexOf(':');
  if (separator < 0) {
    return false;
  }
  const port = decimal(address.slice(separator + 1), 65535);
  if (port === undefined || port === 0) {
    return false;
  }
  const host = address.slice(0, separator);
  if (host === '[::1]') {
    return true;
  }
  // 只认四段写法：127.1、0177.0.0.1、2130706433、0x7f.0.0.1 这些操作系统也接受的写法一律不合法
  const segments = host.split('.');
  return (
    segments.length === 4 &&
    segments[0] === '127' &&
    segments.slice(1).every((segment) => decimal(segment, 255) !== undefined)
  );
}

/** 读不带正负号与前导零的十进制数（`0` 本身可以），只认 ASCII 数字；不合写法或超过 `limit` 时为 `undefined` */
function decimal(text: string, limit: number): number | undefined {
  if (text === '' || (text.length > 1 && text.startsWith('0'))) {
    return undefined;
  }
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    const digit = text.charCodeAt(index) - 0x30;
    if (digit < 0 || digit > 9) {
      return undefined;
    }
    value = value * 10 + digit;
    // 逐位比较上限：过长的数字不会失去精度
    if (value > limit) {
      return undefined;
    }
  }
  return value;
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
