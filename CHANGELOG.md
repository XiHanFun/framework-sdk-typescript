# 更新日志 · XiHan Framework SDK for TypeScript

本页记录 npm 包 `xihan-framework` 各版本中使用者可感知的变更，每条标注 **新增 / 修复 / 优化 / 调整 / 移除** 类别；仓库自身的 CI、测试与构建脚本不列入。版本号见 `package.json`，详细说明见文档站 [TypeScript SDK](https://framework.docs.xihanfun.com/sdks/typescript) 的「破坏性改动与迁移」。

## 未发布

### 升级须知

- `Envelope.time` 由 `string` 改为 `Date`，`DeliveredEnvelope.time` 由 `string`（空串为没有）改为 `Date | undefined`：发布处把 `time: date.toISOString()` 改成 `time: date`，原先判空串的改判 `undefined`（ADR-0306）
- `PluginBinding` 新增 `properties`，运行时交出的绑定的 `JSON.stringify` 与 `console.log` 不再带 `value`：自己用对象字面量构造 `PluginBinding` 的补上 `properties: new Map()`，要主值的直接读 `binding.value`（ADR-0285）
- `DeliveredEnvelope` 新增 `dataSchema`（空串是没有）：自己构造它（如测试里直接调处理器）的补上 `dataSchema: ''`（ADR-0305）
- 超过 128 个字符的操作 ID 不再合法，`defineContract`、`OperationRegistry.add` 抛 `FrameworkError`，读清单为 `kernel.manifest.invalid`：把 ID 缩到 128 个字符以内，按消息文本匹配的改按错误码（ADR-0276）
- `PluginHooks.configure` 与 `start` 多了参数 `{ signal }`：自己调用钩子的代码（包装钩子的装饰器）把这个参数转交下去
- `OperationHandler` 与 `EventHandler` 的返回类型放宽为 `Result | Promise<Result>`：自己调用处理器的代码用 `await` 接结果
- `servePlugin` 按严格的 UTF-8 读清单，坏字节拒绝启动；省略 `manifest` 而文件不存在时抛 `FrameworkError`（`kernel.manifest.file_missing`）：清单存成 UTF-8，按 `ENOENT` 判断的改看错误码
- `ErrorInfo.create` 收到非字符串的消息键抛 `FrameworkError`，原先是 `TypeError`：按 `TypeError` 接的改接 `FrameworkError`
- `Maybe#toJSON()` 对 `JsonNumber` 原样交出，`JSON.stringify(Maybe.some(jsonNumber))` 写成对象：线上编码用 `writeJson`
- 导入 `xihan-framework/plugin` 之后，`ErrorInfo#message` 对 `plugins.*` 键给出英文文案：按文本匹配的地方改为按错误码或消息键
- `Host.invoke` 的字符串载荷、`Host.publish` 信封的字符串 `data` 与处理器以字符串交回的应答严格编码成 UTF-8，有孤立的代理项时在本地失败、不发出（`kernel.operation.invalid_payload`、`messaging.envelope.invalid`、`kernel.invocation.unhandled_exception`）：要发出的文本先换成合法的字符串或 UTF-8 字节（ADR-0312、ADR-0315）
- 操作的响应有孤立的代理项、嵌套超过 64 层或同一个对象里有重复成员时以 `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception` 失败、没有载荷：外部文本先用 `isWellFormed` / `toWellFormed` 核对或替换，`JsonMembers` 用不重复的名字（ADR-0318、ADR-0319）
- `Result` 与 `ErrorInfo` 的线上编码改用 `writeJson(value, { loneSurrogates: 'reject', nesting: 'reject', duplicateMembers: 'reject' })`：有孤立代理项、从结果的根算起超过 64 层或重复成员时抛 `TypeError`，对方读不进的文本不再写出（ADR-0320）
- 已登记 Baggage 键的值有孤立的代理项时 `isBaggageValueAcceptable` 为假：外部输入丢弃这个成员，`withBaggage` 抛 `PRIMITIVES_VALIDATION_001`，从外部输入拼值之前先核对代理项成对（ADR-0321）

### 变更

- **新增** `PluginBinding.properties`：`Configure` 下发的绑定属性交给配置回调（ADR-0285）
- **新增** `Envelope.dataSchema` 与 `DeliveredEnvelope.dataSchema`：发布与投递原样带上 CloudEvents `dataschema`（ADR-0305）
- **新增** `PluginOptions.signal`、`PluginHookOptions` 与 `InvocationContext.withSignal`：调用方能停掉同进程里的插件，钩子与派生上下文接到取消信号
- **新增** `new OperationRegistry({ capacity })`：登记表的容量可以在构造时给出
- **新增** `JsonWriteOptions` 的 `loneSurrogates`、`nesting` 与 `duplicateMembers`，缺省不变（ADR-0318、ADR-0319）
- **新增** `maxOperationIdLength`、`validateOperationId`、`validateMessageKey`、`Result.toJSON`、`FrameworkError.invalidArgument` 与 `fromErrorInfo`
- **修复** 宿主写来的信封 `time` 读不出时投递以 `InvalidArgument` 拒绝；错误细节里的孤立代理项当作没有细节（ADR-0301、ADR-0306）
- **修复** 插件写给宿主的错误细节写不出（孤立的代理项、超过 64 层、重复成员）时这个错误不带细节、其余字段照写，不再写成 `\ud800` 这样的转义（ADR-0320）
- **修复** `Maybe` 包着的大整数 `JsonNumber` 照原文写出，不再按浮点丢精度
- **修复** `result.valueOrThrow()` 抛出的 `FrameworkError` 带上 `messageKey`、`details` 与 `cause`
- **修复** `XIHAN_PLUGIN_PROTOCOL_VERSIONS` 的空项不再读成 0，不合文法的项都记 `warning`
- **调整** 清单 `activation` 里 `onEvent:` 的模式可以带下划线（ADR-0276）
- **调整** 绑定的 `toJSON` 与调试输出里属性名按 UTF-16 码元升序，与其他 SDK 写出同一份文本
- **调整** 插件写给宿主的错误文案（含内部错误的）里每个孤立的代理项写成一个 U+FFFD，由 SDK 显式替换、不取决于 protobuf 库的缺省（ADR-0339）
- **调整** 发布的包不再带 `.js.map` / `.d.ts.map`，`sideEffects` 改为列出 `plugin/messages`
- **调整** `examples/echo` 的 `events.list` 回显处理器拿到的信封（`envelopes`），黑盒运行器的用例 `event-envelope` 通过（ADR-0327）
- **调整** 规范指针升到规范 `73a82f1`

## v0.2.0-rc.1（2026-11-21）

- **新增** 首个对外预发布版，发布到 npm：单个 ESM 包按子路径导入原语、清单、调用上下文、管道、操作契约与进程外插件运行时（`xihan-framework/plugin`），钉规范 `v1.0.0-rc.1`，认领一致性档 `core` 与 `plugin`
