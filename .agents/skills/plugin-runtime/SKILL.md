---
name: xihan-sdk-typescript-plugin-runtime
description: 实现、修正或排查 TypeScript SDK 的进程外插件运行时 xihan-framework/plugin 时使用，适用于握手、生命周期、调用、事件投递、宿主回调、端点与平台差异、协议代码生成和黑盒运行器；原语与操作契约本身用 sdk-development，门禁命令用 testing-release。
---

# TypeScript SDK 插件运行时

规范章节与实现文件的逐项对照读 `references/runtime-map.md`。

## 规范位置

- `spec/rfcs/0017-plugin-protocol.md`：总纲与非目标（流式操作的契约还没有定义）。
- `spec/plugin/handshake.md`：§1 启动与环境变量、§2 握手行与端点、§3 Handshake 调用、§4 会话令牌与回调端点。
- `spec/plugin/lifecycle.md` §7（插件一侧）：调用次序、配置、启动与就绪、健康、停止、回调抛出时的 `reason`、stdin 关闭与 SIGTERM。
- `spec/plugin/invocation.md`：§1 代理操作、§2 上下文映射、§3 错误映射、§4 事件投递、§5 回调、§6 日志、§8 运行时的消息键。
- `spec/plugin/plugin.proto`；向量 `spec/conformance/vectors/plugin/`；运行器用例表在 `spec/conformance/README.md`「黑盒运行器」。

## 协议代码

`src/plugin/gen/plugin.ts` 由 `pnpm generate` 从 `spec/plugin/plugin.proto` 生成并提交（`buf.gen.yaml`：本地插件 ts-proto，`outputServices=grpc-js`、`enumsAsLiterals=true`、`outputJsonMethods=false`、`importSuffix=.js`），不手改。生成代码不过 Biome、照常类型检查；CI 在 Ubuntu 上重新生成，`git status --porcelain -- src/plugin/gen` 不为空即失败。生成代码不是公开入口，`xihan-framework/plugin` 的公开类型不暴露 protobuf 类型；`@grpc/grpc-js` 与 `@bufbuild/protobuf` 只由这个子路径加载。

## 平台差异

- 插件自己的端点：Linux 与 macOS 是 Unix 域套接字，放在 `mkdtemp` 新建的私有目录（`0700`，套接字 `0600`，停止后删除；路径含空白时改放 `/tmp`，仍不行用回环 TCP）；Windows 是命名管道（Node 在 Windows 上没有 Unix 域套接字）；`network: 'tcp'` 只绑定 `127.0.0.1`。
- 命名管道：Node 的 libuv 既给不了访问控制表，也不能拒绝远程客户端（不设 `PIPE_REJECT_REMOTE_CLIENTS`），管道用缺省安全描述符，隔离靠会话令牌；需要只接受本机连接的改用回环 TCP。
- 回调端点：取 `XIHAN_PLUGIN_HOST_ADDRESS` 里第一个 `@grpc/grpc-js` 能连的项、之后不换；实测 Windows 能连命名管道与回环 TCP、连不上 Unix 域套接字，其他系统能连 Unix 域套接字与回环 TCP。
- 启动脚本：Unix 是带 shebang、可执行的 sh 脚本（用 `exec` 让 node 替换 sh，SIGTERM 与 stdin 关闭直接到插件进程）；Windows 是 `.cmd`，开头 `@echo off`，免得命令回显到 stdout 挡在握手行前面。宿主只继承少数环境变量，脚本写出 node 与入口的绝对路径。
- 收尾：stdin 读到结尾与 SIGTERM 都按 §7.7 处理，最多 3 秒以退出码 0 退出；在同一进程里跑插件的测试用 `exit` 选项接住退出。

## 黑盒运行器

- `pnpm test` 里的 `test/plugin-conformance.test.ts` 把 `examples/echo` 放进临时目录、按平台写清单的 `entry` 与启动脚本，在 `spec/conformance` 里 `go run ./cmd/xihan-conformance plugin --dir <目录> --json --quiet --config '{"greeting":"hello"}' --sample … --exclude echoes.crash`，核对用例全集并要求全部通过。
- 需要 Go（版本取 `spec/conformance/go.mod`）；缺 Go 默认失败，只有 `XIHAN_CONFORMANCE_REQUIRED=0` 才跳过。运行器的 Go 依赖经 `GOPROXY` 下载，国内网络可设 `GOPROXY=https://goproxy.cn,direct` 与 `GOSUMDB=sum.golang.google.cn`。
- 只跑某个用例：手动运行时加 `--case <名>`（可重复）；用例名与含义见运行器 README。
- Windows 与 Linux 都要通过：本机跑当前平台，另一平台看 CI 矩阵。

## 完成条件

1. 行为对齐规范的对应章节；`vectors/plugin/` 里相关向量被 `test/plugin.test.ts` 回放。
2. echo 通过运行器的全部用例；新增运行器用例时 `allCases` 同步。
3. 运行时只用规范的七个 `plugins.*` 消息键，`pluginMessages` 的 10 种区域逐字取自参考实现。
4. 同步文档页的「写一个插件」与「与宿主共用的行为 / 插件协议」两节。
