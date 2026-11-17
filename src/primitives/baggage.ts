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

/**
 * 已登记键的值按 UTF-16 码元计的最大长度（conventions/baggage-keys.md）
 */
export const maxBaggageValueLength = 256;

/**
 * 判断已登记键的值能否进入调用上下文：非空、按 UTF-16 码元计最多 256、不含 U+0000–U+001F 与 U+007F–U+009F
 *
 * @remarks
 * 规则见 conventions/baggage-keys.md（ADR-0204、ADR-0233）；`xihan.idempotency-key` 不按这条丢弃，由幂等阶段校验
 */
export function isBaggageValueAcceptable(value: string): boolean {
  // 字符串长度就是 UTF-16 码元数，基本多文种平面以外的字符算两个，与 .NET、Java 一致
  if (value === '' || value.length > maxBaggageValueLength) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    // 控制字符的范围与 .NET 的 char.IsControl 相同；换行写进关联 ID 能伪造日志行
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) {
      return false;
    }
  }
  return true;
}
