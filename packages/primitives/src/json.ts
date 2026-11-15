import { ErrorCode } from './error-code.ts';
import { FrameworkError } from './framework.ts';

/**
 * JSON 可表示的标量
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON 可表示的值
 *
 * @remarks
 * 错误的 `details` 与操作载荷都限定为它（RFC-0001「Details 只允许 JSON 可表示的值」）
 */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

/**
 * JSON 对象：键是字符串，值是 {@link JsonValue}
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * 判断一个值是否是普通对象：字面量或 `Object.create(null)` 创建的，不含类实例、数组与 Map
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 深拷贝并冻结一个 JSON 对象，对象的键按码元升序排列；不是 JSON 可表示的值抛出 {@link FrameworkError}
 *
 * @remarks
 * 键排序让线上编码确定，与 Go SDK 编码 `map[string]any` 时按键排序一致
 *
 * @param value - 要拷贝的值
 * @param path - 出错时报告的位置，如 `details`
 */
export function freezeJsonObject(value: unknown, path: string): JsonObject {
  if (!isPlainObject(value)) {
    throw notJson(path);
  }
  return freezeJson(value, path, new Set()) as JsonObject;
}

/**
 * 递归拷贝；`ancestors` 记录当前路径上的对象，用来拒绝循环引用
 */
function freezeJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      // NaN 与无穷大在 JSON 里会变成 null，不是可往返的值
      if (!Number.isFinite(value)) {
        throw notJson(path);
      }
      return value;
    case 'object':
      break;
    default:
      throw notJson(path);
  }
  if (value === null) {
    return null;
  }
  if (ancestors.has(value)) {
    throw new FrameworkError(ErrorCode.InvalidArgument, `The value at '${path}' contains a circular reference.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item, index) => freezeJson(item, `${path}[${index}]`, ancestors)));
    }
    if (!isPlainObject(value)) {
      throw notJson(path);
    }
    const copy: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      copy[key] = freezeJson(value[key], `${path}.${key}`, ancestors);
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function notJson(path: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, `The value at '${path}' is not a JSON value.`);
}
