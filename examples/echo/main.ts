/**
 * 回声插件的入口：宿主以插件目录为工作目录启动它，清单从工作目录里的 xihan.manifest.json 读
 *
 * @remarks
 * 从源码运行：`node --conditions=xihan-source examples/echo/main.ts`（Node 直接剥离类型）；
 * 宿主只继承少数环境变量，启动脚本要写出 node 与本文件的绝对路径
 */

import { servePlugin } from 'xihan-framework/plugin';

import { echoOptions } from './echo.ts';

try {
  await servePlugin(echoOptions());
} catch {
  // 配置错误（清单不合法、声明与清单不符、缺环境变量）在监听之前抛出，运行时已在 stderr 记了一条 error 日志：以非零码退出
  process.exitCode = 1;
}
