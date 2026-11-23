# AGENTS.md

本文件约束在 framework-sdk-typescript 仓库内工作的 AI Agent。回答、文档与提交说明使用中文；代码标识、公开 API 和标准技术术语保持英文。

## 仓库概览

framework-sdk-typescript 是 XiHan Framework 的 TypeScript SDK，[XiHan Spec](https://github.com/XiHanFun/framework-spec) 的一个实现：原语层、清单、调用上下文、管道、操作契约与进程外插件运行时。它是后端 SDK，不要写成面向 XiHan.UI 或 MCP。参考实现是 .NET（XiHan.Framework），规范写死的行为与它一致，由规范仓库的一致性向量与黑盒运行器验证。整个 SDK 是一个不带作用域的 npm 包 `xihan-framework`，单包、按子路径导入（`xihan-framework/operation`、`xihan-framework/plugin`），没有根入口，全部是 ESM；核心五个模块运行时零第三方依赖，插件运行时 `xihan-framework/plugin` 只用于 Node，用 ts-proto 生成的协议代码与 `@grpc/grpc-js`，`@grpc/grpc-js` 与 `@bufbuild/protobuf` 是可选的 peerDependencies。

### 技术栈

| 技术 | 要求 | 用途 |
| --- | --- | --- |
| Node.js | CI 用 24，Ubuntu 上另跑下限 22；包的 `engines` 是 `>=22` | 运行与测试（原生剥离类型，直接跑 `.ts`） |
| pnpm | 11，以 `package.json` 的 `packageManager` 为准 | 包管理；`pnpm-workspace.yaml` 只是项目设置，不是多包工作区 |
| TypeScript | 5.x，以 `devDependencies` 为准；`tsconfig.base.json` 严格模式 | 源码、构建（`tsc -b`）与类型检查 |
| node:test | Node 内置 | 测试运行器 |
| Biome | 以 `devDependencies` 为准 | 格式与静态检查 |
| buf + ts-proto | 以 `devDependencies` 为准 | 从 `spec/plugin/plugin.proto` 生成 `src/plugin/gen` |
| @grpc/grpc-js + @bufbuild/protobuf | 可选 peerDependencies，开发依赖锁定版本 | 插件运行时的 gRPC 与 protobuf 编解码 |
| Go | 以 `spec/conformance/go.mod` 为准 | 运行规范的黑盒运行器 `xihan-conformance` |

## 开始前必须做

1. 按任务读取对应技能：原语、清单、调用上下文、管道、操作契约的设计与实现读取 `.agents/skills/sdk-development/SKILL.md`；进程外插件运行时、协议代码生成与黑盒运行器读取 `.agents/skills/plugin-runtime/SKILL.md`；门禁、测试与打包验证读取 `.agents/skills/testing-release/SKILL.md`；版本与 npm 发布读取 `.agents/skills/version-release/SKILL.md`；整理破坏性改动读取 `.agents/skills/changelog-collect/SKILL.md`；生成提交信息读取 `.agents/skills/commit-msg/SKILL.md`；准备 PR 读取 `.agents/skills/create-pr/SKILL.md`；回复 Issue 读取 `.agents/skills/issue-reply/SKILL.md`；审查测试读取 `.agents/skills/test-review/SKILL.md`。
2. 同时涉及多个职责时加载对应多个技能，不要一次读取无关资料。
3. 检查当前分支、`git status` 和最近提交；保留用户已有改动。`spec/` 是 submodule，先看 `git -C spec log -1 --oneline` 确认钉的规范提交。
4. 读相关规范章节，只读与任务相关的部分：原语 `spec/rfcs/0001-primitives.md`、清单 `spec/rfcs/0002-manifest.md` 与 `spec/manifest/manifest.schema.json`、调用上下文 `spec/rfcs/0003-invocation-context.md`、管道 `spec/rfcs/0004-pipeline-stages.md`、消息与模板 `spec/rfcs/0010-localization.md`、操作 `spec/rfcs/0011-operations.md`、插件 `spec/rfcs/0017-plugin-protocol.md` 与 `spec/plugin/handshake.md`、`lifecycle.md`、`invocation.md`、`plugin.proto`，版本与一致性档 `spec/rfcs/0024-versions-and-profiles.md` 与 `spec/conformance/profiles.json`，登记表 `spec/conventions/`，向量 `spec/conformance/vectors/`。
5. 阅读目标模块 `src/<模块>/`（入口 `index.ts`）、相邻实现与 `test/<模块>.test.ts`。
6. 先找已有实现：查已有的函数、类型、内部工具与测试，不重复建设；规范的 Go 规则实现 `spec/conformance/rules/` 可以对照。

## 目录结构

```text
/
├─ AGENTS.md
├─ .agents/skills/                        # 按开发、插件运行时、测试和发布分类的仓库技能
├─ .claude/skills -> ../.agents/skills    # Claude Code 技能兼容入口
├─ CLAUDE.md -> AGENTS.md                 # Claude Code 仓库指令入口
├─ .github/workflows/ci.yml               # 门禁：格式与静态检查、构建与类型检查、发布内容核对、测试、生成物核对
├─ .github/workflows/release.yml          # 发布：推送 v* 标签触发，核对后发布到 npm
├─ scripts/release-check.sh               # 发版核对：打标签之前与 release.yml 的 guard 都跑它
├─ scripts/pack-check.ts                  # 发布内容核对（pnpm check:pack）：CI 与 release.yml 在构建之后跑它
├─ spec/                                  # 规范（XiHanFun/framework-spec 的 submodule）：RFC、术语表、清单 Schema、插件协议、一致性档表、向量与黑盒运行器
├─ src/
│  ├─ primitives/                         # xihan-framework/primitives（RFC-0001、RFC-0010）
│  ├─ manifest/                           # xihan-framework/manifest；node.ts 是 xihan-framework/manifest/node
│  ├─ invocation/                         # xihan-framework/invocation（RFC-0003）
│  ├─ pipeline/                           # xihan-framework/pipeline（RFC-0004）
│  ├─ operation/                          # xihan-framework/operation（RFC-0011）
│  └─ plugin/                             # xihan-framework/plugin（RFC-0017）；gen/ 是生成并提交的协议代码
├─ test/                                  # node:test：每个模块一个文件，另有向量覆盖与插件一致性测试
├─ examples/echo/                         # 示例插件，也是黑盒运行器的被测插件
├─ biome.json                             # Biome 配置
├─ buf.gen.yaml                           # 协议代码生成配置
├─ tsconfig.base.json                     # 共用的编译选项
├─ tsconfig.json                          # 构建 src 到 dist
├─ tsconfig.test.json                     # 测试、示例与脚本的类型检查
└─ package.json                           # 包清单：exports、scripts、依赖
```

`dist/` 是构建输出，不提交。

## 常用命令

在仓库根执行：

| 任务 | 命令 |
| --- | --- |
| 初始化规范 | `git submodule update --init spec` |
| 安装 | `pnpm install --frozen-lockfile` |
| 格式与静态检查 | `pnpm check` |
| 自动修正格式 | `pnpm format` |
| 构建 | `pnpm build` |
| 构建与类型检查（含测试、示例与脚本） | `pnpm typecheck` |
| 核对发布内容（先构建） | `pnpm check:pack` |
| 测试 | `pnpm test` |
| 只跑一个测试文件 | `node --conditions=xihan-source --test test/<名>.test.ts` |
| 生成协议代码 | `pnpm generate` |
| 核对生成物 | `pnpm generate` 后 `git status --porcelain -- src/plugin/gen` 必须为空 |
| 全部门禁 | `pnpm install --frozen-lockfile && pnpm check && pnpm typecheck && pnpm check:pack && pnpm test`，再核对生成物 |
| 黑盒运行器 | `cd spec/conformance && go run ./cmd/xihan-conformance plugin --dir <插件目录> --exclude echoes.crash --sample 'echoes.create={"text":"hi"}'` |
| 发版核对 | `bash scripts/release-check.sh vX.Y.Z main`（打标签之前跑，联网取 `origin/main` 与规范的远端标签） |

插件一致性测试需要 Go，没有 Go 时它失败；确实要跳过时设 `XIHAN_CONFORMANCE_REQUIRED=0`，并在结果里说明。运行器的 Go 依赖经 `GOPROXY` 下载。

## 规范与一致性

- 规范是事实源，以 `spec/` 子模块钉的提交为准；本 SDK 与规范不一致时改本 SDK。
- .NET（XiHan.Framework）是参考实现，行为与它一致：错误码、消息键、参数与 en-US 模板、管道错误消息原文、清单的读取顺序与写出排版、模板格式化、线上 JSON 编码都逐字相同；向量的期望值由 .NET 算出。
- 向量回放：测试直接读 `spec/conformance/vectors/` 逐条核对，不手抄期望值。`test/conformance-vectors.test.ts` 按 RFC-0024 读 `spec/conformance/profiles.json`，认领的档（`claimedProfiles`：`core`、`plugin`）要求的每个向量要么在 `replayed` 里由某个测试回放，要么在 `gaps` 里列为缺口并写理由；缺口同时写进 README「状态」一节（RFC-0024「实现钉规范」第 3 条）与文档页「一致性」一节。
- 规范没写到的行为不自行发明：停下来报告差异（.NET 的实测行为、本 SDK 的现状），提出规范文字，在 framework-spec 提交。
- 公开契约的变化顺序：framework-spec 的 RFC → XiHan.Framework 的 ADR（`plans/adr`）→ 各 SDK。不在本仓库先改公开契约。
- 升规范指针：规范提交在 framework-spec 推送之后，`git -C spec fetch` 再 `git -C spec checkout <提交>`；跑全部门禁，规范在认领的档里新增的向量要回放或列为缺口；指针与随之修改的实现、测试同一个提交，说明里写「规范指针升到 <短哈希>」。发预发布或正式版时子模块必须正好在规范标签上。

## 代码规范

- 源码只用可擦除的语法（`erasableSyntaxOnly`：不用 `enum`、带值的 `namespace` 与参数属性），模块之间以 `.ts` 扩展名相对导入，构建时改写为 `.js`（`rewriteRelativeImportExtensions`）；类型导入写 `import type` 或 `type` 修饰（`verbatimModuleSyntax`）。
- `tsconfig.base.json` 的严格选项（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`noImplicitReturns` 等）不放宽；不用 `as any` 或非空断言掩盖非法状态。
- 格式与 lint 用 Biome（`biome.json`：两个空格缩进、单引号、行宽 120、recommended 规则），`spec`、Markdown 与 `src/plugin/gen` 不过 Biome；`.editorconfig` 规定 UTF-8、LF、末尾换行。不降低规则、不加忽略注释来过门禁。
- 文件名 kebab-case。每个模块的公开入口是 `src/<模块>/index.ts`，`package.json` 的 `exports` 每个子路径给 `xihan-source`（源码）、`types` 与 `default` 三个条件，不加根入口；只给内部用的导出标 `@internal`，不从 `index.ts` 导出。私有成员用 `#name` 私有字段。
- 文档注释：类型、函数、常量与成员（含内部的）都写中文 TSDoc：首句一句话，细节进 `@remarks`，引用用 `{@link …}`，会抛出的写 `@throws`，模块入口带 `@packageDocumentation`；句末不加「。」。方法内部的关键逻辑（排序与归因、平台差异、资源上限、安全核对的顺序）用中文 `//` 注释说明为什么，句末不加「。」。
- 枚举写成冻结的常量对象（`Object.freeze({ … } as const)`）加同名的字面量联合类型，JSON 里就是名字。
- 错误：规范的 Error 叫 `ErrorInfo`，不是异常、不 `throw`；可恢复的失败返回 `Result`。参数非法、管道登记冲突等编程错误抛 `FrameworkError`（带 `code`）。查找以 `find` 开头，没有时返回 `undefined`。
- 取消与截止时间只经 `InvocationContext.signal`（`AbortSignal`）传递；异步 API 返回 `Promise`，不与信号赛跑、不丢弃处理器的 Promise；超时与取消的归因按截止信号判断，不只读时钟。
- 面向人的文案：错误只带消息键与参数（如 `ErrorInfo.validation(code, key, details)`），文案在消息目录里；内置英文模板 `builtInMessages` 与插件运行时 10 种区域的 `pluginMessages` 逐字照规范向量与参考实现，新增键同时补全部区域并回放对应向量。
- 运行时英文：`FrameworkError` 的消息是英文句子，首字母大写、以句号结尾，标识符用单引号；stderr 日志消息、测试断言与夹具文本也用英文（小写开头、不加句号）；测试名用中文。
- 线上 JSON 用 `writeJson` 与 `readJsonText` / `parseJson`，不用 `JSON.stringify` 写线上编码；空白按 RFC-0001「空白字符」的 25 个码位（`src/primitives/whitespace.ts`），不用 `\s` 与 `trim`；正则按整串匹配，不带 `m` 标志。
- 不建无界集合：登记表等都有容量上限（如 `OperationRegistry.capacity`），超出时按规范报错。
- `src/plugin/gen` 是生成代码，不手改；改协议只能改规范的 `plugin.proto`，再 `pnpm generate`。

## 测试

- 改哪个模块，就在 `test/<模块>.test.ts` 添加或更新测试；测试按包名自引用（`xihan-framework/<模块>`），经导出条件 `xihan-source` 直接加载源码，测到的是公开入口，不必先构建。只有回放内部规则的向量（如 `src/plugin/conversion.ts`、`deadline.ts`、`errors.ts`）才直接导入 `src/` 下的文件。
- 规范有向量的行为用向量回放验证，新回放的向量文件加进 `test/conformance-vectors.test.ts` 的 `replayed`，并在行尾注释回放它的测试文件。
- 插件运行时用黑盒运行器在 Windows 与 Linux 上跑全部用例：`test/plugin-conformance.test.ts` 把 `examples/echo` 放进临时目录、生成启动脚本、核对用例全集；本机跑当前平台，另一平台看 CI 矩阵。
- 修缺陷先写能复现问题的测试，再改实现；与时间有关的缺陷要确定地造出先后（例如替换 `Date.now`），不靠长时间等待。
- 优先验证公开可观察行为、错误码与消息键、取消与截止时间、边界与容量。
- 不删测试、不放宽门禁、不把缺 Go 的跳过当作通过。

## 文档

- README.md（英文）与 README_cn.md（中文）只放概览、安装、一个最小示例与链接，两份内容同步；README「状态」一节写明钉的规范版本、认领的档与缺口（RFC-0024）。
- 详细文档在 XiHan.Framework 仓库的 `docs/sdks/typescript.md`（模块、示例、写一个插件、与宿主共用的行为、语言映射、设计取舍、一致性、破坏性改动与迁移）。本地克隆在 `../XiHan.Framework`，是另一个仓库，单独提交；构建在那个仓库根执行 `pnpm --dir docs build`，站内链接写 `/目录/页名`，死链会让构建失败。
- 文档正文不写版本号：包版本、规范提交哈希与测试数量都指向真源（`package.json`、`spec/` 子模块）。
- 改公开 API 或可观察行为时，同步文档页的相应章节与其中的「破坏性改动与迁移」，写明旧行为、新行为与迁移方式。

## 发布

- 版本真源是 `package.json` 的 `version`，`src/primitives/framework.ts` 的 `sdkVersion` 要与它相同；npm 包名是不带作用域的 `xihan-framework`。
- npm 上的首个版本已手动发布并配好可信发布者，之后的版本由工作流发布；目前只有预发布版，README 与文档页写着「目前只有预发布版」，首个正式版发布后改掉。标签写成 `v<版本>`，只从 `main` 打；推送 `v*` 标签触发 `.github/workflows/release.yml`：guard 跑 `scripts/release-check.sh`（标签在 `main` 上、标签号等于两处版本、规范钉在标签上），通过后构建并以 npm 可信发布（OIDC）发布；GitHub Release 与 XiHan.Framework 一样在标签推送后手动建。打标签之前先在本地跑同一份脚本。
- 首次发布要用户自己用 npm 凭据手动发一次，再在 npmjs.com 配可信发布者；agent 不登录 npm、不输入令牌。打标签与推送只在用户明确要求时执行，步骤见 `version-release` 技能。
- `files` 只含 `dist`（去掉 `dist/.tsbuildinfo`），`package.json` 没有 `prepack` 或 `prepublishOnly` 钩子，发布前要先 `pnpm build`（`release.yml` 会做）。源码不发布，所以构建不生成 `declarationMap` 与 `sourceMap`（它们会指向包里没有的 `src/`）；`pnpm check:pack`（`scripts/pack-check.ts`）按 `pnpm pack --dry-run` 核对 `exports` 的每个子路径都有 `.js` 与 `.d.ts`、`sideEffects` 列出的文件在包里、没有悬空的 map，CI 与 `release.yml` 都跑它。
- 发预发布或正式版时 `spec/` 子模块必须正好在规范标签上，正式版只能钉规范的正式版标签（RFC-0024「实现钉规范」）。

## 分支

- 日常提交在 `dev`。
- `main` 只在用户明确说「推送并快进 main」时由 `dev` 快进（`git fetch . dev:main`，不是快进就停下查）。
- CI（`.github/workflows/ci.yml`）在推送到 `main` 或 `dev`、以及指向这两个分支的 PR 上运行，也可手动触发（`workflow_dispatch`）；矩阵是 `ubuntu-latest` 与 `windows-latest`（Node 24），外加 `ubuntu-latest` 上的 Node 22（`engines` 的下限），生成物核对只在 Ubuntu 上跑；同一引用的新运行会取消旧运行。
- 发版工作流（`.github/workflows/release.yml`）只在推送 `v*` 标签、或手动运行时选中版本标签时运行，见「发布」与 `version-release` 技能。

## Git 与提交

- 使用 Conventional Commits：`<type>(<scope>): <中文说明>`，scope 用本仓库的模块名 `primitives`、`manifest`、`invocation`、`pipeline`、`operation`、`plugin`、`conformance`，或 `spec`、`docs`、`build`、`ci`。
- 一项能力或一个修复一个提交；实现、测试、README 与规范指针属于同一闭环时放在同一提交。
- 保留用户已有和无关改动；不 reset、checkout 或清理它们，只暂存自己的文件。
- 提交前检查 `git diff --check` 与相关门禁（至少 `pnpm check`、`pnpm typecheck`、`pnpm test`）。
- 不推送、不发布、不创建远程 PR，除非用户明确要求。

## 禁止事项

- 不在本仓库先改公开契约，不发明规范没写的行为。
- 不手改 `src/plugin/gen` 或 `dist`，不手改 `spec/` 子模块里的文件。
- 不给核心五个模块加第三方运行时依赖，不在它们里引用 Node 专有模块（`xihan-framework/manifest/node` 与 `xihan-framework/plugin` 除外）。
- 不让插件运行时以外的子路径加载 `@grpc/grpc-js` 或 `@bufbuild/protobuf`，不在公开类型里暴露 protobuf 类型。
- 不添加静默兜底、无限重试或无界集合。
- 不改用 vitest、jest 等测试框架，不删 `--conditions=xihan-source` 的自引用方式。
- 不猜测版本、包名或 CI 命令；以当前检出为准。
- 不提交 `.claude/worktrees/` 与 `.claude/settings.local.json`。
- 不运行发布或其他改变外部状态的命令，除非用户明确授权。
