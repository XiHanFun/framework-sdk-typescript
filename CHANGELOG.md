# 更新日志 · XiHan Framework SDK for TypeScript

本文件记录 npm 包 `xihan-framework` 各版本中使用者可感知的变更，每条标注 **新增 / 修复 / 优化 / 调整 / 移除** 类别；仓库自身的 CI、测试与构建脚本不列入。迁移的细节见文档站 [TypeScript SDK](https://framework.docs.xihanfun.com/sdks/typescript) 的「破坏性改动与迁移」。

## 未发布

### 升级须知

- 已登记 Baggage 键的值有孤立的代理项时 `isBaggageValueAcceptable` 为假：外部输入丢弃这个成员，`withBaggage` 抛 `PRIMITIVES_VALIDATION_001`，从外部输入拼值之前先核对代理项成对（ADR-0321）
- `Result` 与 `ErrorInfo` 的线上编码改用 `writeJson(value, { loneSurrogates: 'reject', nesting: 'reject', duplicateMembers: 'reject' })`：有孤立代理项、从结果的根算起超过 64 层或重复成员时抛 `TypeError`，对方读不进的文本不再写出（ADR-0320）

### 变更

- **修复** 插件写给宿主的错误细节写不出（孤立的代理项、超过 64 层、重复成员）时这个错误不带细节、其余字段照写，不再写成 `\ud800` 这样的转义（ADR-0320）
- **调整** `examples/echo` 的 `events.list` 回显处理器拿到的信封（`envelopes`），黑盒运行器的用例 `event-envelope` 通过（ADR-0327）
- **调整** 规范指针升到 `6bd152b`（ADR-0320、ADR-0321、ADR-0327、ADR-0328）

## v0.2.0-rc.1（2026-11-21）

### 升级须知

- 首个对外版本，是预发布版：`pnpm add xihan-framework@0.2.0-rc.1`
- 钉在规范 `v1.0.0-rc.1`

### 变更

- **新增** 单个 ESM 包 `xihan-framework`，按子路径导入：`primitives`、`manifest`（读文件在 `manifest/node`）、`invocation`、`pipeline`、`operation`
- **新增** 进程外插件运行时 `xihan-framework/plugin`（`servePlugin` 与宿主回调客户端），`@grpc/grpc-js` 与 `@bufbuild/protobuf` 是可选的对等依赖
- **新增** 示例插件 `examples/echo`
