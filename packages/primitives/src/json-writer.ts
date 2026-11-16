import { ErrorCode } from './error-code.ts';
import { FrameworkError } from './framework.ts';
import { Float64, isIntegerNumber, JsonMembers, maxInt64, minInt64 } from './json.ts';

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
 *   非有限的浮点写成字符串 `"NaN"`、`"Infinity"`、`"-Infinity"`。
 * - {@link JsonMembers} 按文档顺序写成员。字符串按 {@link quoteJsonString} 转义。
 *
 * @throws {@link FrameworkError} 值没有 JSON 表示（顶层是 `undefined`、函数或 symbol）或有循环引用时，码为 `PRIMITIVES_VALIDATION_001`
 */
export function writeJson(value: unknown): string {
  const text = writeValue(value, new Set());
  if (text === undefined) {
    throw new FrameworkError(ErrorCode.InvalidArgument, 'The value has no JSON representation.');
  }
  return text;
}

function writeValue(input: unknown, ancestors: Set<object>): string | undefined {
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
      return quoteJsonString(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return isIntegerNumber(value) ? String(value) : floatWire(value);
    case 'bigint':
      return value >= minInt64 && value <= maxInt64 ? value.toString() : floatWire(Number(value));
    case 'object':
      break;
    default:
      return undefined;
  }
  if (value === null) {
    return 'null';
  }
  if (value instanceof Float64) {
    return floatWire(value.value);
  }
  if (ancestors.has(value)) {
    throw new FrameworkError(ErrorCode.InvalidArgument, 'The value contains a circular reference.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item: unknown) => writeValue(item, ancestors) ?? 'null').join(',')}]`;
    }
    const entries = value instanceof JsonMembers ? value.entries : Object.entries(value);
    const members: string[] = [];
    for (const [name, member] of entries) {
      const text = writeValue(member, ancestors);
      if (text !== undefined) {
        members.push(`${quoteJsonString(name)}:${text}`);
      }
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function hasToJSON(value: unknown): value is { toJSON(): unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Float64) &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}

/** 浮点的线上写法：非有限值写成字符串，整数值补上 `.0` */
function floatWire(value: number): string {
  const text = floatText(value);
  if (!Number.isFinite(value)) {
    return `"${text}"`;
  }
  return /[.E]/.test(text) ? text : `${text}.0`;
}
