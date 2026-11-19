# 插件运行时的实现对照

## 文件

| 文件 | 内容 | 规范 |
| --- | --- | --- |
| `src/plugin/index.ts` | 子路径 `xihan-framework/plugin` 的公开入口 | RFC-0017 |
| `src/plugin/runtime.ts` | `servePlugin`、`PluginOptions` 与回调钩子；启动前的清单与声明核对、Plugin 服务的全部 RPC、生命周期状态机、健康与 `WatchHealth`、`Stop` 与收尾 | handshake.md §1、§3，lifecycle.md §7，invocation.md §1、§4 |
| `src/plugin/protocol.ts` | 协议常量、环境变量名、错误码与消息键、端点类型；`parseHandshakeLine`、`formatHandshakeLine`、`parseEndpoint`、`parseHostAddresses`、`selectHostEndpoint`、`negotiateProtocolVersion` | handshake.md §2、§3、§4 |
| `src/plugin/endpoint.ts` | 按平台监听：`defaultNetwork`、`callbackNetworks`、`bindEndpoint` | handshake.md §2、§4 |
| `src/plugin/session.ts` | 会话令牌的常数时间比较与拦截器 `sessionInterceptor` | handshake.md §4 |
| `src/plugin/host.ts` | 宿主回调客户端 `findHost` / `Host`（`Host.Invoke`、`Host.Publish`）、正在处理的租户 `TenantLedger` | invocation.md §5 |
| `src/plugin/conversion.ts` | proto 与 SDK 类型的互转：Error 与 Status 的写出与读入、`readDetails`、元数据与调用上下文、信封 | invocation.md §2、§3 |
| `src/plugin/deadline.ts` | `deadline` 的严格读法、写法与生效截止时间 | invocation.md §2 |
| `src/plugin/errors.ts` | 固定的 `reason` 文本、`plugins.*` 错误的构造、`thrownTypeName`、回调的 gRPC 状态映射 `mapCallbackStatus` | invocation.md §5、§8，lifecycle.md §7.6 |
| `src/plugin/configuration.ts` | 类型化读取 `ConfigurationSection` | lifecycle.md §7.2 |
| `src/plugin/catalog.ts` | 作者的消息目录 `loadCatalog` 与核对 | handshake.md §3，RFC-0010 |
| `src/plugin/messages.ts` | 运行时的消息目录 `pluginMessages`（10 种区域） | invocation.md §8 |
| `src/plugin/logger.ts` | stderr 结构化日志 `PluginLogger` | invocation.md §6 |
| `src/plugin/gen/plugin.ts` | ts-proto 生成的协议代码（不手改） | `plugin/plugin.proto` |

## 向量

`vectors/plugin/` 下由 `test/plugin.test.ts` 回放：`handshake-lines.json`、`host-addresses.json`、`deadlines.json`、`plugin-messages.json`、`callback-status.json`、`error-reading.json`、`protocol-versions.json`。`wasm-exports.json` 属于 `wasm` 档，不归本 SDK。

## 示例插件

`examples/echo`：`echo.ts` 定义四个操作（含故意崩溃、运行器排除的 `echoes.crash`）、一个订阅、健康项 `echo`、配置节与宿主回调（`echoes.relay` 经 `Host.Invoke`）；`main.ts` 是入口；`xihan.manifest.json` 是清单，`entry` 由测试按平台改写；`localization/` 是作者自己的目录。改运行时的可观察行为时先确认 echo 仍覆盖运行器的全部用例。

## 排查

- 握手失败：看 stderr 的 `error` 日志（启动前的核对不过不会写握手行），再看 stdout 第一行是不是握手行（Windows 的 `.cmd` 没写 `@echo off` 会回显命令）。
- 回调报 `plugins.host.unavailable`：先看启动时的 `warning`，再看 `XIHAN_PLUGIN_HOST_ADDRESS` 里有没有本平台 `@grpc/grpc-js` 能连的项。
- 截止时间与取消的归因：先看截止信号，不只读 `Date.now()`（定时器按单调时钟，可能比墙上时钟先到）。
