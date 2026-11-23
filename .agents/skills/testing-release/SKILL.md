---
name: xihan-sdk-typescript-testing-release
description: 运行或排查 TypeScript SDK 的门禁、测试、向量覆盖、生成物核对与发布前的包内容核对时使用，适用于 pnpm 脚本、node:test、Biome、tsc、CI 矩阵和黑盒运行器；不负责实现普通功能，版本与 npm 发布见 version-release。
---

# TypeScript SDK 测试与验证

先读 `references/gates.md`，再以当前 `.github/workflows/ci.yml` 与 `package.json` 的 `scripts` 为事实源。

## 标准验证

在仓库根执行，与 CI 同序：

```bash
git submodule update --init spec
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm check:pack
pnpm test
pnpm generate
git status --porcelain -- src/plugin/gen   # 必须没有输出
```

- 先跑受影响的测试文件（`node --conditions=xihan-source --test test/<名>.test.ts`），再跑全部。
- 测试用 Node 内置的 `node:test`，不改用 vitest 或 jest；测试按包名自引用、经 `xihan-source` 条件加载源码，不必先构建。
- 插件一致性测试要 Go；缺 Go 时它失败，确实要跳过时设 `XIHAN_CONFORMANCE_REQUIRED=0`，并在结果里写明没跑。插件运行时的改动不能带着这个跳过交付，要在有 Go 的环境或 CI 上跑完。
- 不删测试、不放宽 Biome 或 tsconfig、不加忽略注释制造通过。

## 打包

`pnpm check:pack`（`scripts/pack-check.ts`）核对发布内容，CI 在构建之后、`release.yml` 在发布之前跑它：按 `pnpm pack --dry-run` 列出的文件，`exports` 的每个子路径都有 `.js` 与 `.d.ts`，`sideEffects` 列出的 `dist` 文件在包里，包里的 map 引用的源文件也在包里，`.tsbuildinfo` 不进包。`files` 只含 `dist`（去掉 `dist/.tsbuildinfo`），`dist` 由 `pnpm build`（`tsc -b`）生成，不生成 `declarationMap` 与 `sourceMap`（源码不发布）；`package.json` 没有 `prepack` 或 `prepublishOnly` 钩子，所以先构建再核对。本机的 `dist` 里有旧构建留下的 `.map` 时核对不过：删掉 `dist` 重新构建。

## 本机没有工具链时

Node 与 pnpm 是必需的（pnpm 版本取 `packageManager`）。没有 Go 只影响插件一致性测试，按上面的方式说明；其余门禁照跑。不改 CI 来迁就本机。

验证失败时保留输出作为证据，先查原因再改；发布前的步骤见 version-release。
