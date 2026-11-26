# 门禁与测试

## 门禁清单

| CI 步骤 | 命令 | 配置 | 失败时 |
| --- | --- | --- | --- |
| 安装依赖 | `pnpm install --frozen-lockfile` | `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（依赖的安装脚本一律不跑） | 锁文件与清单不一致时用 `pnpm install` 更新锁文件并一起提交 |
| 格式与静态检查 | `pnpm check`（`biome check .`） | `biome.json`：两个空格缩进、单引号、行宽 120、recommended；排除 `spec`、`**/*.md`、`src/plugin/gen` | `pnpm format` 修格式，lint 问题改代码 |
| 构建与类型检查 | `pnpm typecheck`（`tsc -b && tsc -p tsconfig.test.json`） | `tsconfig.base.json`、`tsconfig.json`（`src` → `dist`）、`tsconfig.test.json`（`test`、`examples`、`scripts`，带 `customConditions: ["xihan-source"]`） | 改代码，不放宽编译选项 |
| 核对发布内容 | `pnpm check:pack`（`node scripts/pack-check.ts`，要先构建） | `package.json` 的 `exports`、`files`、`sideEffects` | 子路径缺 `.js` 或 `.d.ts` 看构建与 `files`；有悬空的 map 时删掉 `dist` 重新构建 |
| 测试 | `pnpm test`（`node --conditions=xihan-source --test "test/*.test.ts"`） | `test/` | 先单独跑失败的文件定位 |
| 核对插件协议的生成代码（只在 Ubuntu） | `pnpm generate` 后 `git status --porcelain -- src/plugin/gen` 为空 | `buf.gen.yaml` | `.proto` 改了却没重新生成：`pnpm generate` 并提交生成物 |

CI 矩阵：`ubuntu-latest` 与 `windows-latest`，Node 24，外加 `ubuntu-latest` 上的 Node 22（`engines` 的下限）；pnpm 取 `packageManager`；Go 取 `spec/conformance/go.mod`；检出带 submodule。触发：推送到 `main` 或 `dev`、指向它们的 PR、手动 `workflow_dispatch`；同一引用的新运行取消旧运行。

## 测试文件

| 文件 | 覆盖 |
| --- | --- |
| `test/primitives.test.ts` | 原语：错误码、操作 ID、Baggage 键、生命周期迁移、管道阶段、错误与细节、JSON 文本、线上编码、模板与消息目录 |
| `test/manifest.test.ts` | 清单的读取、写出、能力依赖文法 |
| `test/invocation.test.ts` | 调用上下文：追踪、Baggage、截止时间与取消的归因 |
| `test/pipeline.test.ts` | 管道的登记、排序与错误 |
| `test/operation.test.ts` | 操作契约、登记表、调用器、载荷解码 |
| `test/plugin.test.ts` | 插件运行时（在本进程里起插件）与 `vectors/plugin/` 的回放 |
| `test/plugin-conformance.test.ts` | 示例插件 echo 交给规范的黑盒运行器，跑全部用例 |
| `test/conformance-vectors.test.ts` | 向量覆盖：认领的档要求的向量要么被回放、要么列为缺口 |

## 向量覆盖测试的维护

- `claimedProfiles`：本 SDK 认领的档，现为 `core`、`plugin`。改认领的档要同步 README「状态」与文档页「一致性」。
- `replayed`：被测试回放的向量文件，行尾注释写回放它的测试文件；新增回放加一行，不再回放就删掉。
- `gaps`：认领的档要求、却没有回放的向量 → 理由。README「状态」逐条写同样的缺口（RFC-0024「实现钉规范」第 3 条）。
- 规范在认领的档里新增向量时这个测试失败：回放它，或列为缺口并写理由。

## 黑盒运行器

```bash
cd spec/conformance
go run ./cmd/xihan-conformance plugin --dir <插件目录> --config '{"greeting":"hello"}' \
  --sample 'echoes.create={"text":"hi"}' --exclude echoes.crash --envelopes events.list
```

`--json` 输出 JSON、`--quiet` 不转发插件的 stderr、`--envelopes <操作>` 指明回显处理器拿到的信封的操作（用例 `event-envelope`，没给即跳过）、`--case <名>` 只跑指定用例、`--timeout` 改每一步的截止时间。退出码 `0` 全部通过（含跳过）、`1` 有用例失败、`2` 参数或目录错误。运行器的 Go 依赖经 `GOPROXY` 下载。
