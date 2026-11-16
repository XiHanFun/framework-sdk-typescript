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

/**
 * 解析 JSON 文本，并拒绝同一层的重复成员名
 *
 * @remarks
 * `JSON.parse` 遇到重复成员时悄悄取最后一个；Result、Error 与清单里同一层的重复成员名不合法（RFC-0001「Result」、
 * RFC-0002 解析规则 2，ADR-0235），所以在语法检查通过之后再按词法查一遍
 *
 * @throws {@link FrameworkError} 不是合法的 JSON 或有重复成员时，码为 `PRIMITIVES_VALIDATION_001`，语法错误在 `cause` 里
 */
export function parseJson(text: string): JsonValue {
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch (cause) {
    throw new FrameworkError(ErrorCode.InvalidArgument, 'The text is not valid JSON.', { cause });
  }
  const duplicate = findDuplicateMember(text);
  if (duplicate !== undefined) {
    throw new FrameworkError(
      ErrorCode.InvalidArgument,
      `The member '${duplicate}' appears more than once in the same JSON object.`,
    );
  }
  return value;
}

/**
 * 在已通过语法检查的 JSON 文本里找同一层重复的成员名；没有时为 `undefined`
 *
 * @remarks
 * 只需跟踪嵌套：对象层记成员名，数组层不记；对象里 `{` 与 `,` 之后的字符串是成员名。
 * 成员名按解码后的文本比较，`"a"` 与 `"a"` 是同一个
 */
function findDuplicateMember(text: string): string | undefined {
  const scopes: (Set<string> | undefined)[] = [];
  let expectName = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '"') {
      let end = index + 1;
      while (text.charAt(end) !== '"') {
        end += text.charAt(end) === '\\' ? 2 : 1;
      }
      if (expectName) {
        const name = JSON.parse(text.slice(index, end + 1)) as string;
        const scope = scopes.at(-1);
        if (scope?.has(name) === true) {
          return name;
        }
        scope?.add(name);
        expectName = false;
      }
      index = end;
    } else if (char === '{') {
      scopes.push(new Set());
      expectName = true;
    } else if (char === '[') {
      scopes.push(undefined);
      expectName = false;
    } else if (char === '}' || char === ']') {
      scopes.pop();
      expectName = false;
    } else if (char === ',') {
      expectName = scopes.at(-1) !== undefined;
    }
  }
  return undefined;
}

function notJson(path: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, `The value at '${path}' is not a JSON value.`);
}
