import { FrameworkError } from './framework.ts';

/** 操作 ID 文法 `<resource>.<verb>`（conventions/operation-ids.md；清单 Schema 自 ADR-0233 起与它相同） */
const operationIdPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * 判断操作 ID 是否符合 `<resource>.<verb>`
 *
 * @remarks
 * 资源与动词都是小写字母开头、连字符分隔的小写字母数字段，中间一个点（conventions/operation-ids.md）。
 * 操作契约与清单的 `contributes.operations` 共用这一个文法
 */
export function isOperationId(id: string): boolean {
  return operationIdPattern.test(id);
}

/**
 * 校验操作 ID 并原样返回
 *
 * @throws {@link FrameworkError} 操作 ID 不合法时，码为 `PRIMITIVES_VALIDATION_001`
 */
export function validateOperationId(id: string): string {
  if (typeof id !== 'string' || !isOperationId(id)) {
    throw FrameworkError.invalidArgument(`The operation ID '${id}' must match <resource>.<verb>.`);
  }
  return id;
}
