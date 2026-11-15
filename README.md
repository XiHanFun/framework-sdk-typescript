# XiHan Framework SDK for TypeScript

[XiHan Framework Spec](https://github.com/XiHanFun/framework-spec) 的 TypeScript 实现：原语层、清单、调用上下文、管道与操作契约。ADR-0004 把 TypeScript 定为 Go 之后的第二个 SDK，对接 XiHan.UI 与 MCP 生态，让前端与 Node 服务用同一套原语、清单与插件协议。形状与语义以 [framework-sdk-go](https://github.com/XiHanFun/framework-sdk-go) 的同名包为参照，参考实现是 .NET（[XiHan.Framework](https://github.com/XiHanFun/XiHan.Framework)）。规范以 submodule 放在 `spec/`，一致性由规范仓库的向量验证。

```bash
pnpm add @xihan-framework/primitives @xihan-framework/invocation @xihan-framework/pipeline @xihan-framework/operation
```

包还没有发布到 npm，发布前在本仓库的工作区里使用。全部是 ESM，运行时零第三方依赖，只用语言与平台内建的能力（`AbortSignal`、Web Crypto、`TextDecoder`、`Intl`）；除 `@xihan-framework/manifest/node` 外不引用 Node 专有模块，浏览器里也能用。

| 包 | 内容 | 规范 |
| --- | --- | --- |
| `@xihan-framework/primitives` | `ErrorInfo` / 错误码、`Result<T>`、`Maybe<T>`、`TypedId<Tag, V>`、`LifecycleState`、`PipelineStage`、`Stability`、Baggage 键、消息键与模板、`MessageCatalog`、`FrameworkError` | RFC-0001、RFC-0010、`conventions/` |
| `@xihan-framework/manifest` | `xihan.manifest.json` 的模型、按 Schema 读取、规范化输出与校验，能力声明与依赖文本；子路径 `./node` 读取文件 | RFC-0002、`manifest/manifest.schema.json` |
| `@xihan-framework/invocation` | `InvocationContext`：取消与截止时间（`AbortSignal`）、W3C 追踪、已登记的 Baggage、类型化对象袋；超时与取消翻译为 `KERNEL_TIMEOUT_001` / `KERNEL_CANCELLED_001` | RFC-0003 |
| `@xihan-framework/pipeline` | 十一阶段的 `PipelineBuilder`：`use` / `useAt` / `useNamedInstance`、`before` / `after`、`describe` / `dump`、`build`；排序规则与错误码 `KERNEL_PIPELINE_00x` | RFC-0004 |
| `@xihan-framework/operation` | `defineContract`、`OperationRegistry`、经完整管道执行的 `OperationInvoker`（XGI：JSON 请求与响应）与类型化入口 `invokeTyped` | RFC-0011 |

## 在 TypeScript 应用里用原语

```ts
import { InvocationContext } from '@xihan-framework/invocation';
import { defineContract, Expose, OperationInvoker, OperationRegistry } from '@xihan-framework/operation';
import { middleware, PipelineBuilder, Placement } from '@xihan-framework/pipeline';
import { BaggageKey, ErrorInfo, isPlainObject, type JsonValue, PipelineStage, Result } from '@xihan-framework/primitives';

interface CreateOrder { readonly quantity: number }
interface OrderCreated { readonly id: string; readonly quantity: number }

// 契约带请求与响应类型；运行期只有 ID、稳定性、暴露的协议与授权要求
const createOrder = defineContract<CreateOrder, OrderCreated>({ id: 'orders.create', expose: [Expose.Http] });

// 解码器把 JSON 载荷转成请求，不符时抛出，消息写路径；也可以直接用 Schema 库的解析函数
function decodeCreateOrder(value: JsonValue): CreateOrder {
  if (!isPlainObject(value) || typeof value.quantity !== 'number') throw new TypeError('$.quantity must be a number');
  return { quantity: value.quantity };
}

const registry = new OperationRegistry();
registry.add({
  contract: createOrder,
  decode: decodeCreateOrder,
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
```

`Result<T>`、`ErrorInfo`、`Maybe<T>` 的 JSON 编码与 .NET 参考实现一致（`{"ok":true,"value":…}` / `{"ok":false,"error":{…}}`，没有值的成功是 `{"ok":true}`），`JSON.stringify` 即得线上编码，`Result.fromJSON` / `ErrorInfo.fromJSON` / `Maybe.fromJSON` 还原；生命周期迁移表、管道阶段顺序、错误码、Baggage 键与能力依赖的文法都由 `spec/conformance/vectors` 验证。

## TypeScript 的形态

- 规范里的 `Error` 在这里叫 `ErrorInfo`，免得遮蔽全局的 `Error`；它不是异常，不 `throw`。可恢复失败经 `Result` 返回，参数非法、清单不合法、管道登记冲突这类编程错误抛出 `FrameworkError`（带 `code`，消息是英文句子）。
- `Result<T>` 与 `Maybe<T>` 是判别联合：`if (result.ok) result.value`、`if (maybe.hasValue) maybe.value`。成功值与 `Some` 的值不能为 `null` 或 `undefined`，没有值的成功是 `Result<void>`（`Result.success()`）。
- 枚举是冻结的常量对象加同名的字面量联合类型（`PipelineStage.Observe === 'observe'`），JSON 里就是名字；需要序号时用 `lifecycleStateOrdinal` 等函数。
- `TypedId<'order'>` 是品牌类型，运行期就是底层的字符串或数值，标签不上线。
- `InvocationContext` 不可变，`withBaggage` 等方法派生新的上下文；取消与截止时间是 `signal`（`AbortSignal.any` 合并调用方的信号与 `AbortSignal.timeout`），可以直接传给 `fetch` 等接口。截止信号已触发即报超时，调用方同时取消也一样（RFC-0003 第 1 条）。
- 中间件、步、处理器与调用器都返回 `Promise`。查找以 `find` 开头，没有时返回 `undefined`。

## 开发

需要 Node 24 与 pnpm 11。

```bash
git submodule update --init          # spec/
pnpm install
pnpm check                           # Biome：格式与静态检查
pnpm typecheck                       # tsc -b 构建全部包，再检查测试的类型
pnpm test                            # node:test，直接跑 TypeScript 源码
```

测试用 Node 内置的 `node:test` 而不是 vitest：不多一个开发依赖，Node 24 原生剥离类型，测试经包的自定义导出条件 `xihan-source` 直接加载各包的 TypeScript 源码，不必先构建，也就测到了各包的公开入口。源码只用可擦除的语法（`erasableSyntaxOnly`），以 `.ts` 扩展名互相导入，构建时改写为 `.js`。开发依赖只有 `typescript`、`@types/node` 与 `@biomejs/biome`。

## 状态

`v0.1.0`：原语、清单、调用上下文、管道与操作五个包可用。进程外插件运行时 `plugin`（`xihan.plugin.v1`，基于 `@grpc/grpc-js`）与远程 Provider 操作集（首个是 `caching.distributed@1`）在规划中，下一轮实现，届时用规范仓库的黑盒运行器 `xihan-conformance plugin --dir <产物目录>` 验证。管道的运行期改动（`UseOwned` / `RemoveOwnedBy`）、按实例名的顺序约束与幂等回放还原响应尚未提供。

## 参与

1. 先读 framework-spec 的 README 与各 RFC，再看 framework-sdk-go 的包划分。
2. 在本仓库开 Issue 认领要实现的包，一个包一个 PR，附向量测试。
3. 公开契约的变更不在 SDK 仓库里做：走 framework-spec 的 RFC 流程，再同步到各 SDK。

## 许可

[MIT](LICENSE)
