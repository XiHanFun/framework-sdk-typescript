---
name: xihan-sdk-typescript-changelog-collect
description: 收集 TypeScript SDK 两个引用之间使用者可感知的变化，写进 XiHan.Framework 文档站 docs/sdks/typescript.md 的「破坏性改动与迁移」时使用；不改版本、不打标签，也不发布 npm 包。
---

# TypeScript SDK 变更整理

## 事实源

- 用户指定的起止引用；没指定时先列出最近的版本提交（仓库还没有标签）与当前 HEAD，请用户确认。
- 范围内的提交、实际 diff、`src/*/index.ts` 的导出变化、`package.json` 的 `exports`、`engines` 与 `peerDependencies`。
- 规范指针的变化：`git diff <起> <止> -- spec` 得到前后两个规范提交，再看规范 `spec/CHANGELOG.md` 对应的条目。
- 文档页 `../XiHan.Framework/docs/sdks/typescript.md` 的「破坏性改动与迁移」一节现有的写法。

## 收录规则

- 只收录 npm 使用者与插件作者可感知的变化：公开导出的增删改、错误码、消息键与参数、线上编码、插件协议的行为、默认值、运行环境与依赖。
- 纯测试、CI、内部重构与生成代码的重新生成不收录，除非改变了包内容或用法。
- 每条写旧行为、新行为与调用方怎么改，写明子路径与 API 名；对应规范修订的写上 RFC 与 ADR 编号。
- 同一底层修复跨多个模块的合并成一条；只有影响不同时才拆开。
- 条目不写包版本与提交哈希（文档正文不写版本号）。

文档页在另一个仓库（XiHan.Framework），在那边单独提交；本技能不改 `package.json` 的版本、不构建、不发布。
