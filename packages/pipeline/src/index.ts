/**
 * 固定阶段的执行管道（RFC-0004）：中间件按阶段贡献，排序确定、可打印、可测试
 *
 * @remarks
 * 中间件、步与终点都是异步的，返回 `Promise<Result<void>>`
 *
 * @packageDocumentation
 */

export {
  AppOwner,
  type Middleware,
  type MiddlewareDescriptor,
  middleware,
  PipelineBuilder,
  PipelineErrorCode,
  Placement,
  parseStage,
  type Step,
} from './pipeline.ts';
