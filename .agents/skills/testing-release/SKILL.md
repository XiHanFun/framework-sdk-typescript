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
pnpm test
pnpm generate
git status --porcelain -- src/plugin/gen   # 必须没有输出
```

- 先跑受影响的测试文件（`node --conditions=xihan-source --test test/<名>.test.ts`），再跑全部。
- 测试用 Node 内置的 `node:test`，不改用 vitest 或 jest；测试按包名自引用、经 `xihan-source` 条件加载源码，不必先构建。
- 插件一致性测试要 Go；缺 Go 时它失败，确实要跳过时设 `XIHAN_CONFORMANCE_REQUIRED=0`，并在结果里写明没跑。插件运行时的改动不能带着这个跳过交付，要在有 Go 的环境或 CI 上跑完。
- 不删测试、不放宽 Biome 或 tsconfig、不加忽略注释制造通过。

## 打包

仓库没有打包验证的脚本或 CI 步骤。`files` 只含 `dist`（去掉 `dist/.tsbuildinfo`），`dist` 由 `pnpm build`（`tsc -b`）生成；`package.json` 没有 `prepack` 或 `prepublishOnly` 钩子。看包内容时先构建，再核对 `exports` 的每个子路径在 `dist` 里都有 `.js` 与 `.d.ts`。

## 本机没有工具链时

Node 与 pnpm 是必需的（pnpm 版本取 `packageManager`）。没有 Go 只影响插件一致性测试，按上面的方式说明；其余门禁照跑。不改 CI 来迁就本机。

验证失败时保留输出作为证据，先查原因再改；发布前的步骤见 version-release。
