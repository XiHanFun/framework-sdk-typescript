import { FrameworkError } from './framework.ts';

/**
 * 原语层登记的错误码
 */
export const ErrorCode = Object.freeze({
  /** 原语参数非法：空 Code、空消息键、清单跨字段约束等 */
  InvalidArgument: 'PRIMITIVES_VALIDATION_001',
  /** 使用了未初始化的 Result */
  UninitializedResult: 'PRIMITIVES_VALIDATION_002',
} as const);

/**
 * 错误码的 KIND 段（conventions/error-codes.md）
 *
 * @remarks
 * 领域可以自定义其他 KIND，所以错误码的 KIND 段类型是 `string`，这里只列出约定的八种
 */
export const ErrorKind = Object.freeze({
  Validation: 'VALIDATION',
  NotFound: 'NOTFOUND',
  Conflict: 'CONFLICT',
  Denied: 'DENIED',
  Unavailable: 'UNAVAILABLE',
  Timeout: 'TIMEOUT',
  Cancelled: 'CANCELLED',
  Unexpected: 'UNEXPECTED',
} as const);

/**
 * 约定的 KIND 段之一
 */
export type ErrorKind = (typeof ErrorKind)[keyof typeof ErrorKind];

/** 错误码文法 `<领域大写>_<KIND>_<NNN>` */
const errorCodePattern = /^[A-Z][A-Z0-9]*_[A-Z][A-Z0-9]*_[0-9]{3}$/;

/**
 * 判断错误码是否符合 `<领域大写>_<KIND>_<NNN>`
 */
export function isErrorCode(code: string): boolean {
  return errorCodePattern.test(code);
}

/**
 * 校验错误码并原样返回
 *
 * @throws {@link FrameworkError} 错误码不合法时，码为 `PRIMITIVES_VALIDATION_001`
 */
export function validateErrorCode(code: string): string {
  if (!isErrorCode(code)) {
    throw invalidErrorCode(code);
  }
  return code;
}

/**
 * 返回错误码的 KIND 段；不合法时为 `undefined`
 */
export function errorCodeKind(code: string): string | undefined {
  return isErrorCode(code) ? code.split('_')[1] : undefined;
}

/**
 * 返回错误码的领域段；不合法时为 `undefined`
 */
export function errorCodeDomain(code: string): string | undefined {
  return isErrorCode(code) ? code.split('_')[0] : undefined;
}

/**
 * 错误码不合法的编程错误
 *
 * @internal
 */
export function invalidErrorCode(code: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, `The error code '${code}' must match <DOMAIN>_<KIND>_<NNN>.`);
}
