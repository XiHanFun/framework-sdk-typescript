import {
  Float64,
  hasToJSON,
  isIntegerNumber,
  JsonMembers,
  JsonNumber,
  maxInt64,
  maxJsonDepth,
  minInt64,
} from './json.ts';

/** 控制字符的短写 */
const shortEscapes: Readonly<Record<number, string>> = Object.freeze({
  8: '\\b',
  9: '\\t',
  10: '\\n',
  12: '\\f',
  13: '\\r',
});

/**
 * 写成 JSON 字符串（RFC-0010「模板」的 JSON 字符串写法，清单写出与线上编码用同一种）
 *
 * @remarks
 * 只转义必须转义的：`"` 与 `\` 加反斜杠；退格、换页、换行、回车、制表符写短写；其余 U+0000–U+001F 与孤立的代理项写成
 * 小写十六进制的 `\u001f`、`\ud800`；别的字符（含 `/`、U+007F–U+009F、U+2028 与非 ASCII）原样
 */
export function quoteJsonString(text: string): string {
  return quote(text, false);
}

/**
 * 写成 JSON 字符串，写法同 {@link quoteJsonString}；`rejectLoneSurrogates` 为真时遇到孤立的代理项抛出 `TypeError`，不写成转义
 */
function quote(text: string, rejectLoneSurrogates: boolean): string {
  let out = '"';
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    let replacement: string | undefined;
    if (code === 0x22) {
      replacement = '\\"';
    } else if (code === 0x5c) {
      replacement = '\\\\';
    } else if (code < 0x20) {
      replacement = shortEscapes[code] ?? unicodeEscape(code);
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = text.charCodeAt(index + 1);
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        // 成对的代理项是一个字符，原样写出
        index += 1;
        continue;
      }
      // 转义出的 \ud800 语法上合法，却不是 RFC-0001「JSON 文本」认的文本，读的一方都会拒绝：类型化的值在这里就写不出
      if (rejectLoneSurrogates) {
        throw new TypeError('The string has a lone surrogate, which cannot be written as JSON text.');
      }
      replacement = unicodeEscape(code);
    }
    if (replacement !== undefined) {
      out += text.slice(start, index) + replacement;
      start = index + 1;
    }
  }
  return `${out}${text.slice(start)}"`;
}

function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

/**
 * 浮点的文本形式（RFC-0010「值的文本形式」，照 .NET 10 的实测）
 *
 * @remarks
 * 1e-4 ≤ |x| < 1e17 或 x 为零时写最短往返的十进制、不用指数，整数值不带小数点；范围外写最短往返的有效数字加
 * `E`、总写的符号与至少两位的指数（`1E+17`、`9.9E-05`、`5E-324`）；负零写 `-0`，非数与无穷写 `NaN`、`Infinity`、`-Infinity`。
 * JavaScript 的 `String` 要到 1e21 与 1e-7 才换指数、负零写 `0`，所以另行处理
 */
export function floatText(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'Infinity' : '-Infinity';
  }
  if (value === 0) {
    return Object.is(value, -0) ? '-0' : '0';
  }
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-4 && magnitude < 1e17) {
    // 这个范围里 String 正是不用指数的最短往返形式
    return String(value);
  }
  // toExponential 不带参数时给出最短往返的有效数字，如 1.2345678901234568e+17
  const [digits = '', exponent = '0'] = value.toExponential().split('e');
  const sign = exponent.startsWith('-') ? '-' : '+';
  return `${digits}E${sign}${exponent.replace(/^[+-]/, '').padStart(2, '0')}`;
}

/**
 * 写成紧凑的 JSON 文本（线上编码，RFC-0001「Result」）
 *
 * @remarks
 * 规则同 `JSON.stringify`（先调用 `toJSON`，对象写自有的可枚举成员，`undefined`、函数与 symbol 在对象里省略、在数组里写 `null`），
 * 不同的是数字按值模型写，让对方读回同一个值（ADR-0236）：
 * - 整数（安全整数的 `number`、64 位范围内的 `bigint`）写十进制。
 * - 浮点按文本形式写，整数值的浮点补上 `.0`（`2.0`、`-0.0`、`1E+17` 原样），否则对方读成整数；
 *   非有限的浮点按 `options.nonFinite`：缺省写成字符串 `"NaN"`、`"Infinity"`、`"-Infinity"`（无类型的值，如错误细节），
 *   `reject` 时写不出（类型化的值，如操作的响应：不写成 `null` 或字符串，RFC-0011 规则 2）。
 * - {@link JsonNumber} 照原文写；只有上溢的（`1e400`）在缺省模式下按值模型写成字符串 `"Infinity"`。
 * - {@link JsonMembers} 按文档顺序写成员。字符串按 {@link quoteJsonString} 转义；孤立的代理项按 `options.loneSurrogates`：
 *   缺省写成 `\ud800` 这样的转义，`reject` 时写不出（操作的类型化响应，RFC-0011 规则 10 的「编码」，ADR-0318）。
 * - 嵌套层数与重复的成员名缺省不核对；`options.nesting`、`options.duplicateMembers` 为 `reject` 时，写出的文本超过
 *   {@link maxJsonDepth} 层或同一个对象里有重复的成员名即写不出（操作的类型化响应，ADR-0319）。
 *
 * @throws TypeError 与 `JSON.stringify` 一样，值没有 JSON 表示（顶层是 `undefined`、函数或 symbol）、有循环引用；
 * 或 `nonFinite` 为 `reject` 时遇到非有限的浮点，`loneSurrogates` 为 `reject` 时写出的字符串（成员名与值）有孤立的代理项，
 * `nesting` 为 `reject` 时嵌套超过 64 层，`duplicateMembers` 为 `reject` 时同一个对象里有重复的成员名
 */
export function writeJson(value: unknown, options?: JsonWriteOptions): string {
  const mode: WriteMode = {
    rejectNonFinite: options?.nonFinite === 'reject',
    rejectLoneSurrogates: options?.loneSurrogates === 'reject',
    maxDepth: options?.nesting === 'reject' ? maxJsonDepth : Number.POSITIVE_INFINITY,
    rejectDuplicateMembers: options?.duplicateMembers === 'reject',
  };
  const text = writeValue(value, new Set(), mode, 0);
  if (text === undefined) {
    throw new TypeError('The value has no JSON representation.');
  }
  return text;
}

/**
 * {@link writeJson} 的选项
 */
export interface JsonWriteOptions {
  /** 非有限的浮点：`string` 写成字符串（缺省），`reject` 写不出 */
  readonly nonFinite?: 'string' | 'reject';
  /**
   * 写出的字符串（成员名与值，含 {@link JsonMembers} 的成员名与 `toJSON` 交出的字符串）里孤立的代理项：`escape` 写成 `\ud800`
   * 这样的转义（缺省），`reject` 写不出
   *
   * @remarks
   * 转义出的孤立代理项语法上合法，却不是 RFC-0001「JSON 文本」认的文本，XiHan 读取 JSON 的一方都会拒绝。操作的类型化响应用
   * `reject`（RFC-0011 规则 10 的「编码」，ADR-0318），Result 与错误的线上编码、写给宿主的错误细节也用 `reject`
   * （RFC-0001「写出与转交」，ADR-0320）；RFC-0010 的模板与日志这类诊断文本照旧写成转义
   */
  readonly loneSurrogates?: 'escape' | 'reject';
  /**
   * 嵌套层数：`unbounded` 不核对（缺省），`reject` 时写出的文本超过 {@link maxJsonDepth} 层（最外层的对象或数组是第 1 层）写不出
   *
   * @remarks
   * 共同读取检查（RFC-0001「JSON 文本」）拒收超过 64 层的文本。层数从写出的根算起，`toJSON` 交出的值与读进来的任意 JSON
   * 也算在内；边写边数，超过即停，不先写完整段文本再读一遍。操作的类型化响应用 `reject`（RFC-0011 规则 10 的「编码」，ADR-0319）
   */
  readonly nesting?: 'unbounded' | 'reject';
  /**
   * 同一个对象里重复的成员名：`write` 照写（缺省），`reject` 写不出
   *
   * @remarks
   * 普通对象的自有键不会重复，只有 {@link JsonMembers}（直接作值、作成员或由 `toJSON` 交出）写得出重复的名字；只看写出的成员，
   * 值写不出而省略的不算，名字按 UTF-16 码元比较，与共同读取检查相同。操作的类型化响应用 `reject`（RFC-0011 规则 10 的「编码」，ADR-0319）
   */
  readonly duplicateMembers?: 'write' | 'reject';
}

/** {@link writeJson} 这一次写出的严格程度 */
interface WriteMode {
  /** 非有限的浮点写不出；也表示类型化的值，{@link JsonNumber} 照原文写 */
  readonly rejectNonFinite: boolean;
  /** 字符串里孤立的代理项写不出 */
  readonly rejectLoneSurrogates: boolean;
  /** 写得出的最深层数；不核对时是无穷 */
  readonly maxDepth: number;
  /** 同一个对象里重复的成员名写不出 */
  readonly rejectDuplicateMembers: boolean;
}

/**
 * 写出一个值；`depth` 是包着它的对象与数组的层数，根是 0
 */
function writeValue(input: unknown, ancestors: Set<object>, mode: WriteMode, depth: number): string | undefined {
  let value = input;
  // 与 JSON.stringify 一样先调用 toJSON；Maybe 这类包装的 toJSON 返回的值可能还有 toJSON，接着调用，直到得到普通值
  for (let rounds = 0; rounds < 8 && hasToJSON(value); rounds += 1) {
    const next = value.toJSON();
    if (next === value) {
      break;
    }
    value = next;
  }
  switch (typeof value) {
    case 'string':
      return quote(value, mode.rejectLoneSurrogates);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return isIntegerNumber(value) ? String(value) : floatWire(value, mode.rejectNonFinite);
    case 'bigint':
      return value >= minInt64 && value <= maxInt64 ? value.toString() : floatWire(Number(value), mode.rejectNonFinite);
    case 'object':
      break;
    default:
      return undefined;
  }
  if (value === null) {
    return 'null';
  }
  if (value instanceof Float64) {
    return floatWire(value.value, mode.rejectNonFinite);
  }
  if (value instanceof JsonNumber) {
    // 无类型的值按值模型：上溢的数字是无穷，写成字符串，与 .NET 读成 double 再写出相同；类型化的值（任意 JSON 的成员）照原文
    return mode.rejectNonFinite || Number.isFinite(value.value) ? value.text : floatWire(value.value, false);
  }
  if (ancestors.has(value)) {
    throw new TypeError('The value contains a circular reference.');
  }
  // 这个对象或数组是第 layer 层：进入之前就核对，超过即停，递归深度因此有界
  const layer = depth + 1;
  if (layer > mode.maxDepth) {
    throw new TypeError(
      `The value is nested deeper than ${maxJsonDepth} levels, which cannot be written as JSON text.`,
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item: unknown) => writeValue(item, ancestors, mode, layer) ?? 'null').join(',')}]`;
    }
    const entries = value instanceof JsonMembers ? value.entries : Object.entries(value);
    // Object.entries 交出的自有键不会重复（代理的 ownKeys 交出重复的键时引擎抛出），只有 JsonMembers 要记下写过的名字
    const written = mode.rejectDuplicateMembers && value instanceof JsonMembers ? new Set<string>() : undefined;
    const members: string[] = [];
    for (const [name, member] of entries) {
      const text = writeValue(member, ancestors, mode, layer);
      if (text !== undefined) {
        // 只核对写出的成员名：值写不出（undefined、函数）的成员整个省略，与 JSON.stringify 相同
        if (written !== undefined) {
          if (written.has(name)) {
            throw new TypeError('The object has a duplicate member name, which cannot be written as JSON text.');
          }
          written.add(name);
        }
        members.push(`${quote(name, mode.rejectLoneSurrogates)}:${text}`);
      }
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** 浮点的线上写法：非有限值写成字符串或写不出，整数值补上 `.0` */
function floatWire(value: number, reject: boolean): string {
  const text = floatText(value);
  if (!Number.isFinite(value)) {
    if (reject) {
      throw new TypeError(`The number ${text} has no JSON representation.`);
    }
    return `"${text}"`;
  }
  return /[.E]/.test(text) ? text : `${text}.0`;
}
