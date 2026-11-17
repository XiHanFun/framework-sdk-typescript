import { ErrorCode } from './error-code.ts';
import { FrameworkError } from './framework.ts';

/** 品牌字段的键：只存在于类型层面 */
declare const typedIdTag: unique symbol;

/**
 * 类型化标识（RFC-0001 TypedId）：底层值加一个只在类型层面存在的标签
 *
 * @remarks
 * 品牌类型（branded type）：运行期就是底层的字符串或数值，标签不上线，`JSON.stringify` 得到底层值的编码。
 * int64 超出 `Number.MAX_SAFE_INTEGER` 的标识用字符串承载
 *
 * @example
 * ```ts
 * type OrderId = TypedId<'order'>;
 * const id: OrderId = typedId<'order'>('o1');
 * ```
 */
export type TypedId<Tag, V extends string | number = string> = V & { readonly [typedIdTag]: Tag };

/**
 * 创建类型化标识
 *
 * @throws {@link FrameworkError} 值不是字符串或有限数值时
 */
export function typedId<Tag, V extends string | number = string>(value: V): TypedId<Tag, V> {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
    throw new FrameworkError(ErrorCode.InvalidArgument, 'A typed ID needs a string or a finite number.');
  }
  return value as TypedId<Tag, V>;
}
