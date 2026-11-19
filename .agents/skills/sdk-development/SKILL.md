---
name: xihan-sdk-typescript-development
description: 设计、实现、重构或对齐 TypeScript SDK 的原语、清单、调用上下文、管道与操作契约时使用，适用于按规范与 .NET 参考实现补齐或修正行为、增删公开导出；进程外插件运行时用 plugin-runtime，门禁与发布分别用 testing-release、version-release。
---

# TypeScript SDK 开发

模块、规范、向量与测试的对照，以及导出与目录约定读 `references/modules-and-spec.md`。

## 先查事实

```bash
git status --short --branch
git log -5 --oneline
git -C spec log -1 --oneline
```

按顺序读：相关 RFC（`spec/rfcs/`）→ `spec/conventions/` 的登记表 → 对应向量（`spec/conformance/vectors/`）与 Go 规则实现（`spec/conformance/rules/`）→ 目标模块 `src/<模块>/` 与 `test/<模块>.test.ts`。只读与任务相关的部分；涉及取舍的背景在 XiHan.Framework 的 `plans/adr/`（规范里的「ADR-NNNN」）。

## 与 .NET 一致的做法

- 规范写死的行为与 .NET 逐字一致：错误码、消息键、参数、en-US 模板、管道错误消息原文、清单的读取顺序与写出排版、模板格式化、线上 JSON 编码。期望值以向量为准，向量由 .NET 算出。
- 规范列为宿主能力、语言 SDK 可以不提供的部分不实现：管道的运行期改动（`UseOwned` / `RemoveOwnedBy`）、Schema 校验、响应过滤与幂等回放还原响应（RFC-0004、RFC-0011 规则 10）。
- 语言差异（值模型的数字、对象顺序、请求的形状、清单模型）是本 SDK 自己的映射，写在文档页「语言映射」；改映射时同步那一节。
- 可恢复的失败返回 `Result`，编程错误抛 `FrameworkError`；取消与截止时间只经 `signal`。其余写法照 `AGENTS.md`「代码规范」。

## 规范没写到时

停下来，不自行选一种写法：写出 .NET 的实测行为、本 SDK 的现状与差异，提出规范文字（RFC 正文或向量），交给用户决定在 framework-spec 提交。顺序是 framework-spec 的 RFC → XiHan.Framework 的 ADR → 各 SDK；规范推送后再升 `spec/` 指针并实现。

## 完成条件

1. 行为与规范和 .NET 一致；相关向量都被回放，新回放的向量文件加进 `test/conformance-vectors.test.ts` 的 `replayed`。
2. `pnpm check`、`pnpm typecheck`、`pnpm test` 通过。
3. 公开导出经 `src/<模块>/index.ts`，带中文 TSDoc；只给内部用的标 `@internal`，不进入口。
4. 公开 API 或可观察行为变化时，同步 `../XiHan.Framework/docs/sdks/typescript.md` 的相应章节与「破坏性改动与迁移」；README 只在概览、安装或最小示例受影响时改，两份同步。
5. 一项能力或一个修复一个提交：`<type>(<scope>): <中文说明>`，scope 用模块名。
