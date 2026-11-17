# XiHan Framework SDK for TypeScript

[XiHan Framework Spec](https://github.com/XiHanFun/framework-spec) 的 TypeScript 实现：原语层、清单、调用上下文、管道与操作契约。ADR-0004 把 TypeScript 定为 Go 之后的第二个 SDK。形状与语义以 [framework-sdk-go](https://github.com/XiHanFun/framework-sdk-go) 的同名包为参照，参考实现是 .NET（[XiHan.Framework](https://github.com/XiHanFun/XiHan.Framework)）。规范以 submodule 放在 `spec/`，一致性由规范仓库的向量验证。

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
import {
  defineContract,
  Expose,
  OperationInvoker,
  OperationRegistry,
  RequestShape,
  type RequestShapeType,
} from '@xihan-framework/operation';
import { middleware, PipelineBuilder, Placement } from '@xihan-framework/pipeline';
import { BaggageKey, ErrorInfo, PipelineStage, Result, writeJson } from '@xihan-framework/primitives';

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
const wire = writeJson(typed); // 线上编码：数字按值模型写，不用 JSON.stringify
```

`Result<T>`、`ErrorInfo`、`Maybe<T>` 的 JSON 编码与 .NET 参考实现一致（`{"ok":true,"value":…}` / `{"ok":false,"error":{…}}`，没有值的成功是 `{"ok":true}`）。写出用 `writeJson`，`Result.parse` / `Result.parseMaybe` / `ErrorInfo.parse` 从文本还原（`fromJSON` 系列收已解析的值，看不出重复成员，也分不出 `2` 与 `2.0`）；JSON 文本的读取检查、线上编码、模板格式化、内核错误、清单的读写、载荷的解码、管道排序、生命周期迁移表、错误码、Baggage 键与值、`traceparent`、能力依赖的文法都由 `spec/conformance/vectors` 验证。

## 与宿主共用的线上细节

以下行为按规范（ADR-0233、ADR-0235、ADR-0236）定死，各语言 SDK 与 .NET 宿主相同：

- **JSON 文本**（RFC-0001「JSON 文本」）：Result 与 Error 的线上编码、操作载荷与清单都先过 `readJsonText` 的共同检查。语法按 RFC 8259（没有注释、尾逗号、`NaN`、前导零、正号、多个根值，空文本与只有空白也不是 JSON，开头的 BOM 是语法错误），嵌套不超过 64 层，字符串必须是合法的 Unicode（严格的 UTF-8，没有原始控制字符、非法转义与孤立的代理项），任何一层都不能有重复的成员名（按转义还原后比较，`"a"` 与 `"\u0061"` 重复）。语法错误不论在哪里都优先，位置只写 `$`；重复成员写第一处重复的路径（`$.a[0].b`）。
- **Result 与 Error 的读写**（RFC-0001「Result」）：无值成功只写 `{"ok":true}`，读取时带了 `value` 即拒绝，`{}` 与 `null` 也一样；有值成功的 `value` 必填、不能是 `null`（值类型是 Maybe 时用 `Result.fromJSONMaybe`，`null` 即无值）。Error 的 `message` 必填且非空，`messageKey`、`details`、`inner` 写了就必须合法，写成 `null` 不合法；未知成员忽略。数字按值模型往返：64 位范围内的整数精确（9007199254740993 不会变成 9007199254740992），整数值的浮点写成 `2.0`、`-0.0`、`1E+17`，非有限的浮点写成字符串 `"NaN"`、`"Infinity"`、`"-Infinity"`。
- **模板**（RFC-0010「模板」）：`{{` / `}}` 转义；参数值为 `null` 写空串、不算缺值，`undefined` 算缺值。值先归到值模型（空、布尔、字符串、64 位整数、双精度浮点、数组、对象）：数组与对象写成紧凑的 JSON，对象成员按名字的 UTF-16 码元序，嵌套的数字不随区域变化，超过 64 层的容器写 `null`。说明符只认 `^[DdFfNnXx][0-9]{0,2}$`（`D`、`F`、`N` 不区分大小写，`X` / `x` 定十六进制的大小写，精度至多两位、可有前导零），`E2`、`G`、`0.00`、`yyyy`、`D100`、带空格的一律按无格式；`D` 与 `X` 只用于整数，`X` 只用于非负整数，`F` 与 `N` 用于整数与浮点，不适用时按无格式。`F` 与 `N` 按值的精确十进制展开舍入、正好一半时取偶（0.125 写 `F2` 得 `0.12`，2.675 得 `2.67`），写出全部整数位，负数舍入成零与负零都保留负号。浮点在 1e-4 ≤ |x| < 1e17 内写最短往返的十进制，范围外写 `1E+17`、`9.9E-05`、`5E-324`，负零写 `-0`，另有 `NaN`、`Infinity`、`-Infinity`。区域只改小数点与分组符，取规范的固定表（de-DE、es-ES、pt-BR 是 `,` 与 `.`，fr-FR 是 `,` 与 U+202F，ru-RU 是 `,` 与 U+00A0，其余与不给区域按不变文化），区域名不区分大小写；小数点用在无格式的浮点（含指数的尾数）与 `F`、`N` 上，分组符只用在 `N` 上。`formatMessage`、`tryFormatMessage` 与 `formatValue` 带区域，`MessageCatalog` 按命中的区域取符号。`Describe` 的参数按名字的序数顺序排列，与区域无关。消息键最长 128 个字符。
- **内核错误**（RFC-0011「错误码」）：码、消息键、参数与 en-US 模板照 `kernel-messages.json`，SDK 自带这组英文模板（`builtInMessages`，另有清单读取的 `kernel.manifest.*` 与 `primitives.manifest.*`），`ErrorInfo.message` 在进程默认目录解析不出时用它；宿主收到错误后按键用自己的目录翻译。`kernel.operation.type_mismatch` 只带 `id`。配置期的重复登记与登记表已满以 `FrameworkError` 抛出，同样带 `messageKey` 与 `details`。
- **调用器**（RFC-0011 规则 2、5、9、10）：进入管道前只核对未登记（`KERNEL_NOTFOUND_001`），类型化调用再核对契约（`KERNEL_VALIDATION_002`）。管道里有三个内置步骤，与 .NET 内核的内置中间件同名、同位置，都按归属 `xihan.kernel.core` 放在所在阶段的 `Beginning`（`BuiltInStep`、`KernelOwner`），与同位置的其他中间件按归属的序数序排序：Observe 阶段的 `ObserveMiddleware` 把排在它之后抛出的异常翻译为 `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception`（调用已中止时抛出的中止按取消归因），排在它之前的（Ingress 阶段，或 Observe 阶段 `Beginning` 上归属排在它之前的，如缺省的 `app`）抛出的异常原样从 `invoke` 抛给调用方；Resilience 阶段的 `DeadlineMiddleware` 进入时截止时间已到即 `KERNEL_TIMEOUT_001` + `kernel.invocation.deadline_before_start`，进入时不核对取消，途中照 .NET 归因：下游抛出的中止成为超时或取消的结果，截止信号已触发时写成结果的 `KERNEL_CANCELLED_001` 按超时报告；Validate 阶段的 `ValidationMiddleware` 解码原始调用的载荷，类型化调用跳过。管道以成功结束而没有响应时返回 `KERNEL_UNEXPECTED_001` + `kernel.operation.no_response`。XGI 入口在管道结束之后才把响应编码成载荷，中间件经 `findOperationResponse` 看到编码之前的对象；数字按值模型写，非有限的浮点（类型化的值不写成 `null` 或字符串）与循环引用写不出时以 `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception` 结束，FrameworkError 放进 `inner`，不抛给调用方，没有载荷。取消与截止时间只经 `signal` 通知（RFC-0003 第 1 条）：调用器不与信号赛跑、不丢弃处理器的 Promise，信号触发之后处理器照常返回结果的，调用以那个结果结束。
- **载荷的解码**（RFC-0011 规则 2）：长度为零的载荷等价于 `{}`，只有空白不是 JSON。先过共同检查（语法错误的 `reason` 是 `$`，重复成员是它的路径），再按请求的形状在文本顺序里报第一处问题：成员名区分大小写，未知成员忽略，数字不从字符串读，整数不接受 `1.0` 与 `1e2`、超出范围即不符，浮点接受整数写法、上溢为无穷；字符串、数组、对象与任意 JSON 接受 `null`，整数、浮点、布尔不接受；必填成员缺少时在所在对象结束时报该对象的路径（`$`、`$.inner`），值为 `null` 也算出现。载荷的文本按 JSON 值比较，空白、转义与数字的写法不是契约；任意 JSON 类型的成员原样保留读到的值，写回时 JSON 值相等（`1e400` 不变成 `null` 或无穷，超出双精度的整数精确，`2.0` 与 `2` 的区别保留）。
- **调用上下文**（RFC-0003、conventions/baggage-keys.md）：已登记 Baggage 键的值为空、超过 256 个 UTF-16 码元或含控制字符时，由一组 Baggage 构造上下文（外部输入）丢弃该成员，`withBaggage` 逐项派生则抛出参数错误，幂等键两种情形都例外；`traceparent` 只认版本 `00` 与小写十六进制、全零的标识不合法，不合法的当作没给，采样只看标志的最低位，写出时只写 `00` 或 `01`，没有上游的根调用写 `01`。
- **管道**（RFC-0004 排序规则第 7、8 条）：`before` / `after` 的两端是中间件名：按名字登记的实例名，或没有名字、只登记一次的中间件的类型名（按名字登记的实例不能按类型名指到）；重复登记、未知阶段、约束主体未登记或有歧义在登记时立即报，约束目标未登记、有歧义、跨阶段与成环在排序时报。错误消息是与 .NET 逐字相同的英文原文，按名字登记的实例写成 `类型名[名字]`，成环时按基准次序列出全部仍被卡住的中间件。
- **清单**（RFC-0002 解析规则 2 与「写出」）：`readManifest` 返回 `Result<Manifest>`，错误码都是 `KERNEL_CAPABILITY_006`，按 JSON 文本（`kernel.manifest.invalid_json`，`reason` 是 `$` 或第一处重复的路径）→ 字面量 `null`（`kernel.manifest.empty`）→ 按 Schema 逐项核对（`kernel.manifest.invalid`，`reason` 是第一处问题的路径：成员按文本顺序，每个成员依次查 Schema 之外的成员、`null`、类型、取值，对象的成员查完后按 `required` 的顺序报缺少的成员）→ 跨字段约束（`primitives.manifest.*`，参数只有 `id`）的顺序报第一处。接口版本不带前导零、不超过 2147483647，只有 `requires[].version` 可带一个 `^`；中间件名至少一个字符，`contributes.health` 符合 `^[a-z][a-z0-9.-]*$`，贡献的权限码重复时报第二次出现的项。`readManifestFile` 跳过开头的 UTF-8 BOM，文件不存在为 `kernel.manifest.file_missing`（参数 `path`）；`readManifest` 收的文本不跳过 BOM。`writeManifest` 的排版逐字照规范：两个空格缩进、LF、末尾不换行、列表总写、缺省值写出、字符串只转义必须转义的字符。只有 Wasm 插件能贡献中间件由宿主在发现时核对，读清单时不核对。
- **文法的匹配**（RFC-0001「文法的匹配」）：消息键、错误码、Baggage 键、清单与能力 ID、操作 ID、`traceparent` 等文法都按整串匹配，结尾的换行不例外。JavaScript 的 `$` 在没有 `m` 标志时只匹配输入的末尾，本 SDK 的正则都不带 `m`，所以天然是整串匹配。

## 值模型与语言相关的映射

规范要求各 SDK 写明本语言的值怎样归到值模型、请求类型怎样声明（RFC-0010「模板」、RFC-0011 规则 2）。

- **数字**：安全整数的 `number`（负零除外）与 64 位范围内的 `bigint` 是整数；其余 `number`（小数、负零、`NaN`、无穷、超出安全整数的值）、超出 64 位的 `bigint` 与 `Float64` 是双精度浮点。`number` 分不出 `2` 与 `2.0`，所以值恰好是整数的浮点装进 `Float64`（`new Float64(2)`，`Number(v)` 与算术照常可用）。
- **读到的 JSON 数字**：整数写法（没有小数点与指数）且在 64 位范围内是整数，安全整数读成 `number`，其余读成 `bigint`，`-0` 读成整数 `0`；其余是浮点，值恰好是安全整数（`2.0`、`1e2`、`0.0`）时读成 `Float64`，否则读成 `number`（`-0.0` 是负零）。换成数值再写出时十进制值与原文不同的（`1e400`、`1e-400`、超出 64 位的整数、多于双精度的有效数字）读成保留原文的 `JsonNumber`：值模型里是浮点（`Number(v)` 上溢为无穷、下溢为 0），写出时照原文，所以任意 JSON 的成员写回时 JSON 值相等。
- **写出**：`writeJson` 按 `JSON.stringify` 的规则写（先调用 `toJSON`，写不出时同样抛 `TypeError`），只是数字按值模型：整数写十进制，浮点写文本形式并给整数值补 `.0`，`JsonNumber` 照原文（缺省模式下上溢的按值模型写成 `"Infinity"`）；非有限值缺省写成字符串（无类型的值，如错误细节），`{ nonFinite: 'reject' }` 时写不出（类型化的值，如操作的响应）。`JSON.stringify` 写不出 `bigint`，也会把 `2.0` 写成 `2`、把 `NaN` 写成 `null`，线上编码不要用它。
- **对象的顺序**：JavaScript 对象把整数样式的键（`"1"`）提到前面。要按文本顺序报错的检查（载荷、清单）用 `readJsonText` 读出的 `JsonMembers`，它保留文档顺序；`toJsonValue` 转成普通对象。名为 `__proto__` 的成员是普通成员，不改原型。
- **模板里的其他值**：字符串原样；数组、类型化数组、`Set` 与其他可迭代对象是数组；普通对象、`JsonMembers` 与 `Map` 是对象（`Map` 的键按文本形式写成名字）；嵌套的 `undefined` 写 `null`；`Date` 写 `toISOString()`；类实例、symbol 与函数写 `String(value)`。这些语言自己的文本不跨语言，插件要跨语言格式化时先转成字符串。
- **请求的形状**：`RequestShape` 相当于 .NET 的序列化元数据。`string()` 读成 `string | null`（接受 `null`）；`boolean()`、`int32()`（`number`）、`int64()`（`bigint`）、`float64()`（`number`）不接受 `null`；`array(item)`、`record(value)`、`object(members)` 与 `json()` 接受 `null`。对象成员缺省是可选的，没有给出时不出现在结果里；`RequestShape.required(shape)` 声明必填，只要求出现，值为 `null` 也算出现。`RequestShape.custom(decode)` 相当于自定义转换器：形状核对跳过它，构建时转换，抛出 `RequestDecodeError(path)` 时取它的路径（用 `JsonPath` 从给出的位置往下拼）。`RequestShapeType<typeof S>` 取出形状读出的类型。
- **清单的模型**：`readManifest` 读出的 `Manifest` 补齐缺省值（`role`、`activation`、各列表、`requires[].optional`、`bindings[].required`），与 .NET 的 `Manifest` 一致；`$schema` 不在模型里，写出时总写 `manifestSchemaUri`。程序里构造的清单可以不写可选成员，`writeManifest` 写出后按 `readManifest` 再读一遍核对，读不回来即抛出带同样码、键与参数的 `FrameworkError`。

## TypeScript 的形态

- 规范里的 `Error` 在这里叫 `ErrorInfo`，免得遮蔽全局的 `Error`；它不是异常，不 `throw`。可恢复失败经 `Result` 返回（含读不出来的清单与不合法的载荷），参数非法、程序里构造的清单写不出、管道登记冲突这类编程错误抛出 `FrameworkError`（带 `code`，消息是英文句子）。
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

`v0.1.0`：原语、清单、调用上下文、管道与操作五个包可用。进程外插件运行时 `plugin`（`xihan.plugin.v1`，基于 `@grpc/grpc-js`）与远程 Provider 操作集（首个是 `caching.distributed@1`）在规划中，下一轮实现，届时用规范仓库的黑盒运行器 `xihan-conformance plugin --dir <产物目录>` 验证。规范列为宿主能力、语言 SDK 可以不提供的部分本 SDK 不提供：管道的运行期改动（`UseOwned` / `RemoveOwnedBy`）、Schema 校验、响应过滤与幂等回放还原响应（RFC-0004、RFC-0011 规则 10）。

## 参与

1. 先读 framework-spec 的 README 与各 RFC，再看 framework-sdk-go 的包划分。
2. 在本仓库开 Issue 认领要实现的包，一个包一个 PR，附向量测试。
3. 公开契约的变更不在 SDK 仓库里做：走 framework-spec 的 RFC 流程，再同步到各 SDK。

## 许可

[MIT](LICENSE)
