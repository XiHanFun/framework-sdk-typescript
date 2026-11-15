/**
 * 五级稳定性（RFC-0001）
 *
 * @remarks
 * 值是清单与协议里的小写名，JSON 编码即名字
 */
export const Stability = Object.freeze({
  Stable: 'stable',
  Preview: 'preview',
  Experimental: 'experimental',
  Internal: 'internal',
  Deprecated: 'deprecated',
} as const);

/**
 * 稳定性等级之一
 */
export type Stability = (typeof Stability)[keyof typeof Stability];

/**
 * 全部等级，按序号排列（与 .NET 枚举一致）
 */
export const stabilities: readonly Stability[] = Object.freeze([
  Stability.Stable,
  Stability.Preview,
  Stability.Experimental,
  Stability.Internal,
  Stability.Deprecated,
]);

/**
 * 判断一个值是否是稳定性名（小写）
 */
export function isStability(value: unknown): value is Stability {
  return typeof value === 'string' && (stabilities as readonly string[]).includes(value);
}

/**
 * 返回等级的序号：stable 为 0，deprecated 为 4
 */
export function stabilityOrdinal(stability: Stability): number {
  return stabilities.indexOf(stability);
}
