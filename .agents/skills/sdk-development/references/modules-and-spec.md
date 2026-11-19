# 模块、规范与向量

## 对照表

| 模块 | 子路径 | 规范 | 回放的向量（`spec/conformance/vectors/`） | 测试 |
| --- | --- | --- | --- | --- |
| `src/primitives` | `xihan-framework/primitives` | RFC-0001、RFC-0010「模板」与消息键、`conventions/error-codes.md`、`conventions/baggage-keys.md` | `primitives/error-codes.json`、`baggage-keys.json`、`json-text.json`、`kernel-messages.json`、`lifecycle-transitions.json`、`message-templates.json`、`wire-encoding.json` | `test/primitives.test.ts` |
| `src/manifest` | `xihan-framework/manifest`、`xihan-framework/manifest/node` | RFC-0002、`manifest/manifest.schema.json`、`conventions/capability-ids.md` | `manifest/manifests.json`、`primitives/capability-requirements.json` | `test/manifest.test.ts` |
| `src/invocation` | `xihan-framework/invocation` | RFC-0003、`conventions/baggage-keys.md` | `primitives/trace-context.json`、`baggage-keys.json` | `test/invocation.test.ts` |
| `src/pipeline` | `xihan-framework/pipeline` | RFC-0004 | `pipeline/ordering.json` | `test/pipeline.test.ts` |
| `src/operation` | `xihan-framework/operation` | RFC-0011、`conventions/operation-ids.md` | `operations/payload-reasons.json` | `test/operation.test.ts` |
| `src/plugin` | `xihan-framework/plugin` | RFC-0017、`plugin/` | 见 plugin-runtime 技能 | `test/plugin.test.ts`、`test/plugin-conformance.test.ts` |

确切的回放清单以 `test/conformance-vectors.test.ts` 的 `replayed`（行尾注释是回放它的测试文件）为准；认领的档要求哪些向量以 `spec/conformance/profiles.json` 为准。

## 导出与目录

- 一个子路径一个目录，入口 `index.ts`，以 `@packageDocumentation` 开头写模块说明，只重新导出公开的名字。
- 新增子路径：`src/<模块>/index.ts`，再在 `package.json` 的 `exports` 加一项，三个条件依次是 `xihan-source`（`./src/<模块>/index.ts`）、`types`（`./dist/<模块>/index.d.ts`）、`default`（`./dist/<模块>/index.js`）；测试按 `xihan-framework/<模块>` 自引用。
- 核心五块不引用 Node 专有模块，Node 的文件读取单独放在 `manifest/node.ts` 这样的子路径里；运行时零第三方依赖。
- 模块之间相对导入写 `.ts` 扩展名；跨模块的公开名字从对方的 `index.ts` 导入（`../primitives/index.ts`）。
- 内部用的导出标 `@internal`，不进 `index.ts`，别的模块从定义它的文件导入（如 `../primitives/whitespace.ts` 的 `isWhitespace`、`../invocation/context.ts` 的 `isDeadlineSignalled`）。

## 常见对齐点

- 线上 JSON：读取先过 `readJsonText` 的共同检查，写出用 `writeJson`；对象按文本顺序报错时用 `JsonMembers`，不转普通对象。
- 数字按值模型：整数、`bigint`、`Float64`、`JsonNumber` 的区分写在文档页「语言映射」。
- 空白按 RFC-0001「空白字符」的 25 个码位，不用 `\s` 与 `trim`。
- 正则整串匹配，不带 `m` 标志。
- 内核错误的码、键、参数与 en-US 模板照 `kernel-messages.json`；模板在 `primitives/built-in-messages.ts`。
- 管道的三个内置步骤与 .NET 内置中间件同名、同位置（归属 `xihan.kernel.core`、阶段 `Beginning`）。
- 截止时间与取消：归因看截止信号，调用方同时取消也报超时（RFC-0003 第 1 条）。
- 登记表有容量上限（`OperationRegistry.capacity`），满了按 `kernel.operation.registry_full` 报。
