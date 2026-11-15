/**
 * 已登记的 Baggage 键（conventions/baggage-keys.md）
 */
export const BaggageKey = Object.freeze({
  /** 当前租户 ID */
  Tenant: 'xihan.tenant',
  /** 当前主体 ID */
  Principal: 'xihan.principal',
  /** 业务关联 ID */
  Correlation: 'xihan.correlation',
  /** 幂等键 */
  IdempotencyKey: 'xihan.idempotency-key',
  /** 请求文化（BCP 47） */
  Locale: 'xihan.locale',
} as const);

/** 键格式 `xihan.<name>`：小写，连字符分隔 */
const baggageKeyPattern = /^xihan\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * 已登记的键，按登记顺序
 */
export const registeredBaggageKeys: readonly string[] = Object.freeze([
  BaggageKey.Tenant,
  BaggageKey.Principal,
  BaggageKey.Correlation,
  BaggageKey.IdempotencyKey,
  BaggageKey.Locale,
]);

/**
 * 判断键是否符合 `xihan.<name>`
 */
export function isBaggageKeyWellFormed(key: string): boolean {
  return baggageKeyPattern.test(key);
}

/**
 * 判断键是否已登记
 */
export function isBaggageKeyRegistered(key: string): boolean {
  return registeredBaggageKeys.includes(key);
}
