import { FrameworkError } from './framework.ts';

/** 操作 ID 文法 `<resource>.<verb>`（conventions/operation-ids.md；清单 Schema 自 ADR-0233 起与它相同） */
const operationIdPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * 操作 ID 的最大长度（conventions/operation-ids.md、RFC-0011「操作 ID」，与 .NET 的 `OperationId.MaxLength` 相同）
 *
 * @remarks
 * 文法只含 ASCII 字符，字符数、UTF-16 码元数与 UTF-8 字节数是同一个数（ADR-0276）
 */
export const maxOperationIdLength = 128;

/**
 * 判断操作 ID 是否符合 `<resource>.<verb>` 且不超过 {@link maxOperationIdLength} 个字符
 *
 * @remarks
 * 资源与动词都是小写字母开头、连字符分隔的小写字母数字段，中间一个点（conventions/operation-ids.md）。
 * 操作契约与清单的 `contributes.operations` 共用这一条规则：超过上限的 ID 别处都合文法也不合法
 */
export function isOperationId(id: string): boolean {
  // 先看长度：超长的输入不必交给正则
  return id.length <= maxOperationIdLength && operationIdPattern.test(id);
}

/**
 * 校验操作 ID 并原样返回
 *
 * @throws {@link FrameworkError} 操作 ID 不合法时，码为 `PRIMITIVES_VALIDATION_001`
 */
export function validateOperationId(id: string): string {
  if (typeof id !== 'string' || !isOperationId(id)) {
    throw FrameworkError.invalidArgument(
      `The operation ID '${id}' must match <resource>.<verb> and be at most ${maxOperationIdLength} characters long.`,
    );
  }
  return id;
}
