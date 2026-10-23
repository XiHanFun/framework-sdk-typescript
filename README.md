# XiHan Framework SDK for TypeScript

> **占位仓库，尚未开始实现。** 规范在 [framework-spec](https://github.com/XiHanFun/framework-spec)，参考实现是 .NET（[XiHan.Framework](https://github.com/XiHanFun/XiHan.Framework) 的 `next/`），第二语言 Go 的实现在 [framework-sdk-go](https://github.com/XiHanFun/framework-sdk-go)，可以作为本 SDK 的形状参照。

ADR-0004 把 TypeScript 定为 Go 之后的第二个 SDK：对接 XiHan.UI 与 MCP 生态，让前端与 Node 服务用同一套原语、清单与插件协议。

## 计划内容

按规范逐包实现，每个包都要通过 framework-spec 的一致性向量（`conformance/vectors/`）：

| 包 | 内容 | 规范 |
| --- | --- | --- |
| primitives | `Error` / 错误码、`Result`、`Maybe`、类型化标识、生命周期状态、管道阶段、稳定性、Baggage 键、消息键与模板 | RFC-0001、RFC-0010、`conventions/` |
| manifest | `xihan.manifest.json` 的模型、读取与校验，能力声明与依赖文本 | RFC-0002、`manifest/manifest.schema.json` |
| invocation | 调用上下文：取消与截止时间、W3C 追踪、已登记的 Baggage | RFC-0003 |
| pipeline | 十一阶段管道：登记、顺序约束、稳定拓扑排序、打印 | RFC-0004 |
| operation | 操作契约、登记表、经完整管道执行的调用器（XGI JSON） | RFC-0011 |
| plugin | 进程外插件运行时（`xihan.plugin.v1`，@grpc/grpc-js） | RFC-0017、`plugin/` |
| caching 等远程 Provider | 子系统能力的操作集（首个是 `caching.distributed@1`） | RFC-0019、`provider/` |

插件实现用规范仓库的黑盒运行器验证：`xihan-conformance plugin --dir <产物目录>`。

## 包名

npm 组织 `xihan-framework` 已注册（2026-10-23），scope 下的包名只有组织成员能发布，不需要占位发布。npm scope `@xihan-framework`：`@xihan-framework/primitives`、`@xihan-framework/plugin` 等。领域词与规范术语表（`conventions/vocabulary.md`）一致，只换本语言的大小写风格。

## 成熟度

Reference（.NET）、Stable（通过全部向量）、Experimental（部分向量）、Community（社区维护）。本仓库当前：**规划中**。

## 参与

1. 先读 framework-spec 的 README 与各 RFC，再看 framework-sdk-go 的包划分。
2. 在本仓库开 Issue 认领要实现的包，一个包一个 PR，附向量测试。
3. 公开契约的变更不在 SDK 仓库里做：走 framework-spec 的 RFC 流程，再同步到各 SDK。

## 许可

[MIT](LICENSE)
