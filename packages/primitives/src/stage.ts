/**
 * 管道的十一个阶段（RFC-0004）
 *
 * @remarks
 * 值是清单里的阶段名；名称与顺序是规范性内容
 */
export const PipelineStage = Object.freeze({
  Ingress: 'ingress',
  Observe: 'observe',
  Resilience: 'resilience',
  Authenticate: 'authenticate',
  Tenant: 'tenant',
  Authorize: 'authorize',
  Validate: 'validate',
  Idempotency: 'idempotency',
  Transaction: 'transaction',
  Handle: 'handle',
  Egress: 'egress',
} as const);

/**
 * 管道阶段之一
 */
export type PipelineStage = (typeof PipelineStage)[keyof typeof PipelineStage];

/**
 * 全部阶段，按执行顺序
 */
export const pipelineStages: readonly PipelineStage[] = Object.freeze([
  PipelineStage.Ingress,
  PipelineStage.Observe,
  PipelineStage.Resilience,
  PipelineStage.Authenticate,
  PipelineStage.Tenant,
  PipelineStage.Authorize,
  PipelineStage.Validate,
  PipelineStage.Idempotency,
  PipelineStage.Transaction,
  PipelineStage.Handle,
  PipelineStage.Egress,
]);

/**
 * 判断一个值是否是清单里的阶段名（小写）
 */
export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && (pipelineStages as readonly string[]).includes(value);
}

/**
 * 返回阶段的序号：ingress 为 0，egress 为 10
 */
export function pipelineStageOrdinal(stage: PipelineStage): number {
  return pipelineStages.indexOf(stage);
}
