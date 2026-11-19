---
name: xihan-sdk-typescript-commit-msg
description: 根据 TypeScript SDK 当前暂存区生成一行提交信息时使用，适用于「提交信息」「commit msg」「msg」或提交前概括 staged changes；只生成消息，不负责暂存、解决冲突或执行提交。
---

# TypeScript SDK 提交信息

1. 检查 `git status --short --branch`；存在冲突、merge 或 rebase 时先报告，不生成完成态消息。
2. 只读取 `git diff --cached --stat`、完整 staged diff 和最近 20 条提交。暂存区为空时不从未暂存内容猜测。
3. 将全部暂存变化归纳成一个意图，输出一行 Conventional Commit。

格式：`<type>(<scope>): <中文说明>`。type 使用 `feat`、`fix`、`refactor`、`perf`、`docs`、`style`、`test`、`build`、`ci`、`chore`、`revert`。

scope 用本仓库的模块名：`primitives`、`manifest`、`invocation`、`pipeline`、`operation`、`plugin`、`conformance`（向量覆盖与黑盒运行器的测试），或 `spec`（只升规范指针）、`docs`、`build`、`ci`。跨多个模块的同一修复取最主要的模块，不逐个罗列。

说明写使用者能看到的结果与原因；对齐规范的改动写上 RFC 或 ADR 编号，升了规范指针的写「规范指针升到 <短哈希>」。只升规范指针的提交照已有写法：`build(spec): 规范指针升到 <短哈希>（ADR-NNNN）`。删除、改名或改变公开导出、错误码、消息键与线上编码时使用 `!`。只要求消息时最终只输出一行标题，不附解释或候选列表。
