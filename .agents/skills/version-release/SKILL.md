---
name: xihan-sdk-typescript-version-release
description: 为 TypeScript SDK 准备版本、修改 package.json 的 version、核对规范标签或把 npm 包 xihan-framework 发布出去时使用；不替用户选版本号，只有用户明确要求实际发布时才由用户用自己的 npm 凭据发布。
---

# TypeScript SDK 版本发布

## 事实

- 版本真源是 `package.json` 的 `version`；`src/primitives/framework.ts` 的 `sdkVersion`（插件握手时上报的 SDK 版本）必须与它相同。npm 包名是不带作用域的 `xihan-framework`，单包、子路径导出。
- 还没有发布到 npm。标签写成 `v<版本>`（如 `v0.1.0`、`v0.1.0-rc.1`，与其他 SDK 相同），推送 `v*` 标签由 `.github/workflows/release.yml` 发布。
- 包内容：`files` 只含 `dist`（去掉 `dist/.tsbuildinfo`），`dist` 由 `pnpm build` 生成；没有 `prepack` 或 `prepublishOnly` 钩子，发布前必须先构建。
- 规范标签（RFC-0024「实现钉规范」）：发预发布或正式版时 `spec/` 子模块必须正好在规范标签上；正式版只能钉规范的正式版标签 `vX.Y.Z`，预发布可以钉 `vX.Y.Z-rc.N`。规范还没有对应的标签时，先由用户在 framework-spec 打（同一提交另有 `conformance/vX.Y.Z`）。
- 成熟度（RFC-0024「成熟度」）：有钉在规范标签上的发布版之前是 Experimental；Stable 另要求认领的 `stable` 档没有缺口、钉的是规范正式版标签。

## 发版核对与工作流

- `scripts/release-check.sh <标签> [<提交>]` 核对要打标签的那个提交（缺省为标签指向的提交，标签还没打时为 `HEAD`）：① 标签是 `v<语义化版本>`；② 提交在 `origin/main` 的历史里，预发布与正式版都只从 `main` 发；③ 标签号等于 `package.json` 的 `version` 与 `sdkVersion`；④ `spec/` 正好在规范标签上。它要联网取 `origin/main` 与规范仓库的远端标签。
- 推送 `v*` 标签触发 `.github/workflows/release.yml`：guard 用同一份脚本复核，不通过就不发布；通过后 `pnpm build` 并 `npm publish`（预发布用 dist-tag `next`，正式版 `latest`；版本已在 npm 上就跳过）。工作流不建 GitHub Release，与 XiHan.Framework 相同，标签推送后手动建（见「发布」）。
- 认证走 npm 可信发布（OIDC），仓库里没有 npm 令牌。npm 只能给已经存在的包配可信发布者，所以首次发布前要用户自己做两件事：在本机用自己的 npm 凭据手动 `npm publish` 首个版本；再到 npmjs.com 的包设置里加可信发布者（组织 `XiHanFun`、仓库 `framework-sdk-typescript`、工作流 `release.yml`、环境留空）。agent 不登录 npm、不输入或保存令牌、不改 npm 配置。

## 准备版本

每一步都在用户要求之后才做：

1. 工作区干净，在 `dev` 上，没有 merge、rebase 或冲突；版本号由用户给出。
2. 核对上一次发布（还没有发布时从头）以来的公开导出与可观察行为变化，文档页「破坏性改动与迁移」已写全（见 changelog-collect）。
3. 把 `spec/` 指到规范标签，跑全部门禁（见 testing-release），README「状态」与文档页「一致性」写的档与缺口与 `test/conformance-vectors.test.ts` 一致。
4. 改 `package.json` 的 `version` 与 `sdkVersion`，`pnpm build`，核对 `dist` 覆盖 `exports` 的每个子路径。
5. 提交到 `dev`；推送与快进 `main` 只在用户明确要求时做，等 CI 全绿。

## 发布

只有用户明确要求才打标签：

1. 跑 `bash scripts/release-check.sh vX.Y.Z main`，全部通过才往下走；不通过就停下报告。
2. `git tag -a vX.Y.Z -m "vX.Y.Z" main`，再 `git push origin vX.Y.Z`，用用户自己的权限。
3. 等 `release.yml` 跑完，核对 npm 上的版本、dist-tag 与包内容。失败就停下报告，不手改 `dist` 或包文件。
4. 用户要建 GitHub Release 时：`gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <正文>`，预发布加 `--prerelease`，正文写钉的规范标签与这一版的变化，与 XiHan.Framework 相同。

npm 上已发布的版本号不能再用，发错了只能发下一个号。guard 不通过时没有发布，删掉标签、改正之后重打即可。
