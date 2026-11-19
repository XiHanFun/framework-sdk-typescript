---
name: xihan-sdk-typescript-create-pr
description: 为 TypeScript SDK 准备、审查或创建 Pull Request 时使用，适用于生成 PR 标题与正文、比较分支或执行 gh pr create；普通代码审查与测试审查不使用。
---

# TypeScript SDK 创建 PR

## 前置检查

- 检查分支、上游、工作区、merge / rebase 和冲突；非正常分支状态不创建 PR。
- base 默认 `dev`，不默认改成 `main`；`main` 只由 `dev` 快进。
- 用 `git log <base>..HEAD`、`git diff --stat <base>...HEAD` 和完整 diff 审查整条分支。
- 核对公开导出（`src/*/index.ts`、`package.json` 的 `exports`）、规范指针、向量回放、README 两份是否同步、文档页是否需要另一个仓库的配套提交。
- 一个模块一个 PR，附向量测试；改公开契约的要先有 framework-spec 的 RFC。

## PR 内容

仓库没有 PR 模板，正文按下面几段写：

- **关联 Issue**：`Closes #<编号>`；没有就写「无」。
- **变更说明**：使用者可感知的结果与原因，对齐规范的写 RFC / ADR 编号。
- **影响范围**：涉及的子路径（`xihan-framework/<模块>`），以及规范指针、协议生成代码、示例插件。
- **自测**：只写实际跑过的命令与结果（`pnpm check`、`pnpm typecheck`、`pnpm test`、生成物核对、黑盒运行器在哪个平台上跑过）。
- **破坏性变更**：公开导出、错误码、消息键、线上编码或插件行为的变化与迁移方式；没有就写「无」。文档页「破坏性改动与迁移」的配套改动写明在哪个提交。

标题使用 Conventional Commit 形态，说明使用者可感知的结果。

只要草稿时不写远程。明确要求创建 PR 时才允许推送当前分支并执行 `gh pr create`；禁止 force push、合并或改写其他远端分支。创建后返回 PR 链接。
