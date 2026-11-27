<div align="center">

<h1>XiHan Framework SDK for TypeScript</h1>

<h3>与 .NET 宿主相同的原语、清单与管道，由同一套一致性向量验证</h3>

<p>
  <a href="https://github.com/XiHanFun/framework-sdk-typescript/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/XiHanFun/framework-sdk-typescript/ci.yml?branch=main&style=flat-square&label=CI" /></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" />
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/XiHanFun/framework-sdk-typescript?style=flat-square&color=green" /></a>
  <a href="https://github.com/XiHanFun/framework-sdk-typescript/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/XiHanFun/framework-sdk-typescript?style=flat-square&logo=github&label=Stars&color=1f6feb" /></a>
</p>

<p>
  <a href="https://framework.docs.xihanfun.com/sdks/typescript"><b>文档</b></a> ·
  <a href="#快速开始"><b>快速开始</b></a> ·
  <a href="https://github.com/XiHanFun/framework-spec"><b>规范</b></a> ·
  <a href="https://github.com/XiHanFun/XiHan.Framework"><b>参考实现</b></a>
</p>

<p><a href="./README.md">English</a> | <b>简体中文</b></p>

</div>

[XiHan Spec](https://github.com/XiHanFun/framework-spec) 的 TypeScript 实现：原语层、清单、调用上下文、管道、操作契约与进程外插件运行时；参考实现是 .NET（[XiHan.Framework](https://github.com/XiHanFun/XiHan.Framework)）。规范以 submodule 放在 `spec/`，一致性由规范仓库的向量验证。

## 模块

整个 SDK 是一个 ESM 包 `xihan-framework`，各模块按子路径导入，没有根入口。核心五块运行时零第三方依赖；插件运行时只用于 Node。

| 子路径 | 内容 |
| --- | --- |
| `xihan-framework/primitives` | 错误与错误码、`Result<T>`、`Maybe<T>`、类型化标识、生命周期状态、管道阶段、Baggage 键、消息键、模板与目录 |
| `xihan-framework/manifest` | `xihan.manifest.json` 的读取、写出与校验；读取文件在 `xihan-framework/manifest/node` |
| `xihan-framework/invocation` | `InvocationContext`：取消与截止时间、W3C 追踪与已登记的 Baggage |
| `xihan-framework/pipeline` | 十一阶段的 `PipelineBuilder` 与它的排序规则 |
| `xihan-framework/operation` | 操作契约、登记表与经完整管道执行的调用器 |
| `xihan-framework/plugin` | 进程外插件运行时 `servePlugin` 与宿主回调客户端 |

## 安装

```bash
pnpm add xihan-framework
```

写插件时另装可选的 peer 依赖：`pnpm add @grpc/grpc-js @bufbuild/protobuf`。目前只有预发布版，正式版之前公开 API 还可能调整；版本列表见 [Releases](https://github.com/XiHanFun/framework-sdk-typescript/releases)。

## 快速开始

```ts
import { InvocationContext } from 'xihan-framework/invocation';
import {
  defineContract,
  Expose,
  OperationInvoker,
  OperationRegistry,
  RequestShape,
  type RequestShapeType,
} from 'xihan-framework/operation';
import { middleware, PipelineBuilder, Placement } from 'xihan-framework/pipeline';
import { BaggageKey, ErrorInfo, PipelineStage, Result } from 'xihan-framework/primitives';

// 请求的形状：调用器按它在文本顺序里核对载荷并构建请求（RFC-0011 规则 2）
const CreateOrder = RequestShape.object({ quantity: RequestShape.required(RequestShape.int32()) });
type CreateOrder = NonNullable<RequestShapeType<typeof CreateOrder>>; // { quantity: number }
interface OrderCreated { readonly id: string; readonly quantity: number }

// 契约带请求与响应类型；运行期只有 ID、稳定性、暴露的协议与授权要求
const createOrder = defineContract<CreateOrder, OrderCreated>({ id: 'orders.create', expose: [Expose.Http] });

const registry = new OperationRegistry();
registry.add({
  contract: createOrder,
  request: CreateOrder,
  handler: async (context, request) =>
    request.quantity > 0
      ? Result.ok({ id: `o-${context.tenant}`, quantity: request.quantity })
      : Result.fail(ErrorInfo.validation('ORDERS_VALIDATION_001', 'orders.quantity.invalid', { min: 1 })),
});

const builder = new PipelineBuilder().useAt(
  middleware('Audit', async (context, next) => next(context)),
  PipelineStage.Observe,
  Placement.End,
);
const invoker = new OperationInvoker(registry, builder);

const context = InvocationContext.create({ timeout: 2000, baggage: { [BaggageKey.Tenant]: 't1' } });
const response = await invoker.invoke(context, { id: 'orders.create', payload: '{"quantity":2}' });
// response.outcome.ok === true，response.payload === '{"id":"o-t1","quantity":2}'
const typed = await invoker.invokeTyped(context, createOrder, { quantity: 3 }); // Result<OrderCreated>
// 线上编码：数字按值模型写，不用 JSON.stringify；写出对方读不进的文本时抛 FrameworkError
const wire = Result.write(typed);
```

## 文档

| 去处 | 内容 |
| --- | --- |
| [TypeScript SDK](https://framework.docs.xihanfun.com/sdks/typescript) | 模块、示例、写一个插件、与宿主共用的行为、语言映射、设计取舍、一致性、破坏性改动与迁移 |
| [进程外插件](https://framework.docs.xihanfun.com/plugins/out-of-process) | 插件协议 `xihan.plugin.v1` 与 .NET 宿主怎样运行插件 |
| [规范与多语言](https://framework.docs.xihanfun.com/appendix/spec) | 规范怎样组织、一致性档与各语言 SDK |
| [XiHan Spec](https://github.com/XiHanFun/framework-spec) | RFC、术语表、协议映射、一致性向量与黑盒运行器 |

## 状态

成熟度是 Experimental：已有钉在规范 rc 标签上的预发布版，到 Stable 还要钉在规范正式版标签上的发布版。认领的一致性档：`core` 与 `plugin`（RFC-0024）；缺口：无；钉的规范版本：`spec/` 子模块指向的提交。流式操作、Wasm 载体与远程 Provider 的插件侧尚未提供。细节见[文档页](https://framework.docs.xihanfun.com/sdks/typescript)。

## 生态

| 项目 | 说明 |
| --- | --- |
| [framework-spec](https://github.com/XiHanFun/framework-spec) | XiHan Spec：RFC、术语表、协议映射与一致性向量 |
| [XiHan.Framework](https://github.com/XiHanFun/XiHan.Framework) | .NET 参考实现 |
| [framework-sdk-go](https://github.com/XiHanFun/framework-sdk-go) | Go SDK |
| [framework-sdk-rust](https://github.com/XiHanFun/framework-sdk-rust) | Rust SDK |
| [framework-sdk-java](https://github.com/XiHanFun/framework-sdk-java) | Java SDK |
| [framework-sdk-python](https://github.com/XiHanFun/framework-sdk-python) | Python SDK |
| [framework-sdk-php](https://github.com/XiHanFun/framework-sdk-php) | PHP SDK |

## 参与

欢迎提交 [Issue](https://github.com/XiHanFun/framework-sdk-typescript/issues) 与 Pull Request。公开契约的变更先走 framework-spec 的 RFC 流程，再同步到各 SDK。开发约定、门禁与发布流程见 [AGENTS.md](./AGENTS.md)。

## 许可证

[MIT](./LICENSE) © 2021-Present XiHanFun and contributors。
