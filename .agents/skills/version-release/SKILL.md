---
name: xihan-sdk-typescript-version-release
description: 为 TypeScript SDK 准备版本、修改 package.json 的 version、核对规范标签或把 npm 包 xihan-framework 发布出去时使用；不替用户选版本号，只有用户明确要求实际发布时才由用户用自己的 npm 凭据发布。
---

# TypeScript SDK 版本发布

## 事实

- 版本真源是 `package.json` 的 `version`；npm 包名是不带作用域的 `xihan-framework`，单包、子路径导出。
- 还没有发布到 npm；仓库没有发布工作流，也没有版本标签。本 SDK 自己的标签规则还没有约定，打不打、怎样命名由用户定。
- 包内容：`files` 只含 `dist`（去掉 `dist/.tsbuildinfo`），`dist` 由 `pnpm build` 生成；没有 `prepack` 或 `prepublishOnly` 钩子，发布前必须先构建。
- 规范标签（RFC-0024「实现钉规范」）：发预发布或正式版时 `spec/` 子模块必须正好在规范标签上；正式版只能钉规范的正式版标签 `vX.Y.Z`，预发布可以钉 `vX.Y.Z-rc.N`。规范还没有对应的标签时，先由用户在 framework-spec 打（同一提交另有 `conformance/vX.Y.Z`）。
- 成熟度（RFC-0024「成熟度」）：有钉在规范标签上的发布版之前是 Experimental；Stable 另要求认领的 `stable` 档没有缺口、钉的是规范正式版标签。

## 准备版本

每一步都在用户要求之后才做：

1. 工作区干净，在 `dev` 上，没有 merge、rebase 或冲突；版本号由用户给出。
2. 核对上一次发布（还没有发布时从头）以来的公开导出与可观察行为变化，文档页「破坏性改动与迁移」已写全（见 changelog-collect）。
3. 把 `spec/` 指到规范标签，跑全部门禁（见 testing-release），README「状态」与文档页「一致性」写的档与缺口与 `test/conformance-vectors.test.ts` 一致。
4. 改 `package.json` 的 `version`，`pnpm build`，核对 `dist` 覆盖 `exports` 的每个子路径。
5. 提交到 `dev`；推送与快进 `main` 只在用户明确要求时做，等 CI 全绿。

## 发布

只有用户明确要求才发布，由用户用自己的 npm 凭据在本机执行；agent 不登录 npm、不输入或保存令牌、不改 npm 配置。npm 上已发布的版本号不能再用，发错了只能发下一个号。发布后核对 npm 上的版本与包内容，失败就停下报告，不手改 `dist` 或包文件。
