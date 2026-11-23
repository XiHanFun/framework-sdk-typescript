/**
 * 进程外插件运行时（RFC-0017，spec/plugin/）：协议 `xihan.plugin.v1`
 *
 * @remarks
 * 只用于 Node：基于 `@grpc/grpc-js` 与 `@bufbuild/protobuf`（可选的 peerDependencies），其余子路径不依赖它们。
 * {@link servePlugin} 读宿主下发的环境变量、监听本机端点、向 stdout 写握手行，以 gRPC 服务端提供 Plugin 服务：
 * 握手、配置、启停、健康与健康推送、操作调用与事件投递，调用次序、就绪、停止与收尾按 plugin/lifecycle.md §7；操作就是
 * `xihan-framework/operation` 登记表里的操作，`Invoke` 经调用器与完整管道执行。插件经 {@link findHost} 取到宿主回调客户端，
 * 带会话令牌回调 `Host.Invoke` 与 `Host.Publish`，回调端点取 `XIHAN_PLUGIN_HOST_ADDRESS` 里第一个能连的项（handshake.md §4）
 *
 * @packageDocumentation
 */

export { loadCatalog, type PluginCatalog } from './catalog.ts';
export { ConfigurationSection } from './configuration.ts';
export type { DeliveredEnvelope, Envelope } from './conversion.ts';
export { defaultNetwork } from './endpoint.ts';
export { findHost, Host } from './host.ts';
export { LogLevel, type LogTarget, PluginLogger, type PluginLoggerOptions } from './logger.ts';
export { pluginMessages, pluginTemplates } from './messages.ts';
export {
  CallbackPermission,
  EndpointNetwork,
  formatHandshakeLine,
  isSubscriptionMode,
  isTopic,
  negotiateProtocolVersion,
  type PluginEndpoint,
  PluginEnvironment,
  PluginErrorCode,
  PluginMessageKey,
  PluginProtocol,
  parseEndpoint,
  parseHandshakeLine,
  parseHostAddresses,
  SubscriptionMode,
  selectHostEndpoint,
} from './protocol.ts';
export {
  type EventDelivery,
  type EventHandler,
  HealthStatus,
  type PluginBinding,
  type PluginConfiguration,
  type PluginHealth,
  type PluginHealthItem,
  type PluginHookOptions,
  type PluginHooks,
  type PluginOptions,
  type PluginStop,
  type PluginSubscription,
  servePlugin,
} from './runtime.ts';
