import { ErrorCode } from './error-code.ts';
import { FrameworkError } from './framework.ts';
import { isJsonNumberText } from './number-grammar.ts';
import { compareOrdinal } from './ordinal.ts';

/**
 * 值模型里值是整数的双精度浮点（RFC-0010「模板」的值模型，ADR-0236）
 *
 * @remarks
 * JavaScript 的 `number` 分不出 `2` 与 `2.0`：安全整数的 `number` 按值模型是整数，所以值恰好是整数的浮点要装进它，
 * 读写与格式化时才仍是浮点（`2.0` 写出仍是 `2.0`，`{v:D3}` 不补零）。JSON 里读到的 `2.0`、`1e2`、`0.0` 就是它；
 * 别的浮点（`1.5`、`-0`、非有限值、超出安全整数的值）直接是 `number`。`valueOf` 返回数值，`Number(v)` 与算术照常可用
 */
export class Float64 {
  /** 数值 */
  readonly value: number;

  /**
   * @param value - 数值；可以是任何双精度浮点
   */
  constructor(value: number) {
    if (typeof value !== 'number') {
      throw new FrameworkError(ErrorCode.InvalidArgument, 'A Float64 needs a number.');
    }
    this.value = value;
    Object.freeze(this);
  }

  /** 数值，让 `Number(v)`、`+v` 与算术可用 */
  valueOf(): number {
    return this.value;
  }

  /** 数值的 JavaScript 文本 */
  toString(): string {
    return String(this.value);
  }

  /**
   * `JSON.stringify` 写出数值本身
   *
   * @remarks
   * `JSON.stringify` 写不出浮点的身份（`2.0` 会写成 `2`）；线上编码用 {@link writeJson}
   */
  toJSON(): number {
    return this.value;
  }
}

/**
 * 保留原文的 JSON 数字（RFC-0011 规则 2，ADR-0236）
 *
 * @remarks
 * 读到的数字换成 `number`、`bigint` 或 {@link Float64} 再写出时，十进制值与原文不同的（上溢为无穷的 `1e400`、下溢为 0 的 `1e-400`、
 * 超出 64 位的整数、比双精度更多的有效数字），读取器保留原文：值模型里它是双精度浮点 {@link JsonNumber.value}，
 * 写出时照原文，任意 JSON 的成员写回时与读到的 JSON 值相等。`valueOf` 返回数值
 */
export class JsonNumber {
  /** 原文，符合 RFC 8259 的数字文法 */
  readonly text: string;

  /**
   * @param text - 数字的原文
   */
  constructor(text: string) {
    if (typeof text !== 'string' || !isJsonNumberText(text)) {
      throw new FrameworkError(ErrorCode.InvalidArgument, 'A JsonNumber needs the text of a JSON number.');
    }
    this.text = text;
    Object.freeze(this);
  }

  /** 最接近原文的双精度浮点；超出范围时是无穷或 0 */
  get value(): number {
    return Number(this.text);
  }

  /** 数值，让 `Number(v)` 与算术可用 */
  valueOf(): number {
    return this.value;
  }

  /** 原文 */
  toString(): string {
    return this.text;
  }

  /**
   * `JSON.stringify` 写出数值
   *
   * @remarks
   * 会失去原文，无穷还会写成 `null`；线上编码用 {@link writeJson}
   */
  toJSON(): number {
    return this.value;
  }
}

/**
 * 判断一个值写出前要不要先调用它的 `toJSON`
 *
 * @remarks
 * {@link Float64} 与 {@link JsonNumber} 也有 `toJSON`（给 `JSON.stringify` 用，返回 `number`），但不能经它写出：
 * 换成 `number` 就丢了浮点的身份与数字的原文。{@link writeJson} 与 `Maybe` 的 `toJSON` 共用这一个判定
 *
 * @internal
 */
export function hasToJSON(value: unknown): value is { toJSON(): unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Float64) &&
    !(value instanceof JsonNumber) &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}

/**
 * JSON 可表示的标量
 *
 * @remarks
 * 数字按值模型（RFC-0010「模板」）：安全整数的 `number` 与 64 位范围内的 `bigint` 是整数，其余 `number`、
 * 超出 64 位的 `bigint`、{@link Float64} 与 {@link JsonNumber} 是双精度浮点
 */
export type JsonPrimitive = string | number | bigint | Float64 | JsonNumber | boolean | null;

/**
 * JSON 可表示的值
 *
 * @remarks
 * 错误的 `details` 与 Result 的值都限定为它（RFC-0001「Details 只允许 JSON 可表示的值」）
 */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

/**
 * JSON 对象：键是字符串，值是 {@link JsonValue}
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * 保留文档顺序的 JSON 值：对象是 {@link JsonMembers}，数组是数组，标量同 {@link JsonPrimitive}
 *
 * @remarks
 * {@link readJsonText} 读出的树。JavaScript 对象把整数样式的键（`"1"`）提到前面，要按文本顺序报错的检查
 * （操作载荷、清单）用这棵树，不用普通对象
 */
export type JsonNode = JsonPrimitive | readonly JsonNode[] | JsonMembers;

/**
 * 保留文档顺序的 JSON 对象
 */
export class JsonMembers {
  /** 成员，按在文本里出现的顺序 */
  readonly entries: readonly (readonly [name: string, value: JsonNode])[];
  readonly #values: ReadonlyMap<string, JsonNode>;

  /**
   * @param entries - 成员；名字不重复
   */
  constructor(entries: readonly (readonly [name: string, value: JsonNode])[]) {
    this.entries = Object.freeze(entries.map((entry) => Object.freeze([entry[0], entry[1]] as const)));
    this.#values = new Map(this.entries);
    Object.freeze(this);
  }

  /** 成员数 */
  get size(): number {
    return this.entries.length;
  }

  /**
   * 是否有这个成员；名字区分大小写
   */
  has(name: string): boolean {
    return this.#values.has(name);
  }

  /**
   * 取成员的值；没有时为 `undefined`
   */
  get(name: string): JsonNode | undefined {
    return this.#values.get(name);
  }
}

/** 64 位有符号整数的下限 */
export const minInt64 = -(2n ** 63n);

/** 64 位有符号整数的上限 */
export const maxInt64 = 2n ** 63n - 1n;

/**
 * 判断一个 `number` 按值模型是不是整数：安全整数且不是负零
 *
 * @remarks
 * 负零只能来自浮点运算，按浮点；超出安全整数的 `number` 已经不精确，也按浮点（RFC-0010「模板」）
 */
export function isIntegerNumber(value: number): boolean {
  return Number.isSafeInteger(value) && !Object.is(value, -0);
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
 * 给对象定义一个可枚举的自有成员
 *
 * @remarks
 * 不用赋值：名为 `__proto__` 的成员赋值会改原型，不会成为成员
 */
export function defineMember(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * 深拷贝并冻结一个 JSON 对象，对象的键按码元升序排列；不是 JSON 可表示的值抛出 {@link FrameworkError}
 *
 * @remarks
 * 键排序让同一组细节总写出同一段文本，日志与测试可以逐字比较；接收方按 JSON 值比较、不看成员顺序（RFC-0001「Result」）。
 * 数字按值模型保留：`bigint`、{@link Float64} 与 {@link JsonNumber} 原样，
 * 非有限的浮点也可以放进细节，线上写成字符串 `NaN`、`Infinity`、`-Infinity`（RFC-0001「Result」，ADR-0236）
 *
 * @param value - 要拷贝的值；{@link JsonMembers} 转成普通对象
 * @param path - 出错时报告的位置，如 `details`
 */
export function freezeJsonObject(value: unknown, path: string): JsonObject {
  if (!isPlainObject(value) && !(value instanceof JsonMembers)) {
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
    case 'number':
    case 'bigint':
      return value;
    case 'object':
      break;
    default:
      throw notJson(path);
  }
  if (value === null || value instanceof Float64 || value instanceof JsonNumber) {
    return value;
  }
  if (ancestors.has(value)) {
    throw new FrameworkError(ErrorCode.InvalidArgument, `The value at '${path}' contains a circular reference.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item, index) => freezeJson(item, `${path}[${index}]`, ancestors)));
    }
    let members: [string, unknown][];
    if (value instanceof JsonMembers) {
      members = value.entries.map(([name, member]) => [name, member]);
    } else if (isPlainObject(value)) {
      members = Object.entries(value);
    } else {
      throw notJson(path);
    }
    const copy: Record<string, JsonValue> = {};
    for (const [name, member] of members.sort(([left], [right]) => compareOrdinal(left, right))) {
      defineMember(copy, name, freezeJson(member, `${path}.${name}`, ancestors));
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function notJson(path: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, `The value at '${path}' is not a JSON value.`);
}
