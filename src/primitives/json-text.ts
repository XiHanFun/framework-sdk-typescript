import { ErrorCode } from './error-code.ts';
import { FrameworkError } from './framework.ts';
import {
  defineMember,
  Float64,
  isIntegerNumber,
  JsonMembers,
  type JsonNode,
  JsonNumber,
  type JsonValue,
  maxInt64,
  minInt64,
} from './json.ts';
import { JsonPath } from './json-path.ts';
import { floatText } from './json-writer.ts';
import { jsonNumberGrammar } from './number-grammar.ts';

/**
 * JSON 文本的嵌套上限：最外层的对象或数组是第 1 层（RFC-0001「JSON 文本」）
 */
export const maxJsonDepth = 64;

/**
 * JSON 文本没有通过共同读取检查的原因
 *
 * @remarks
 * 语法错误（RFC 8259 之外的写法、BOM、嵌套超过 64 层、非法 UTF-8、孤立的代理项）的位置只写 `$`，各语言的解析器报的位置不同；
 * 重复成员写第一处重复（第二次出现的成员）的路径，写法同 {@link JsonPath}
 */
export type JsonTextProblem =
  | { readonly kind: 'syntax'; readonly path: '$' }
  | { readonly kind: 'duplicate'; readonly path: string };

/**
 * {@link readJsonText} 的结果：通过时是保留文档顺序的树，否则是第一处问题
 */
export type JsonTextRead =
  | { readonly ok: true; readonly root: JsonNode }
  | { readonly ok: false; readonly problem: JsonTextProblem };

/** 严格的 UTF-8：坏字节、过长编码与编码成 UTF-8 的代理项都失败；保留 BOM，让它按语法错误拒绝 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const syntaxProblem: JsonTextProblem = Object.freeze({ kind: 'syntax', path: JsonPath.root });

/** 读取器内部的语法错误：不是 Error，不收集调用栈 */
const invalid: unique symbol = Symbol('invalid JSON text');

/** 数字的文法（RFC 8259，写在 number-grammar.ts）：粘连匹配，从读取位置起扫描；捕获组是小数部分与指数 */
const numberPattern = new RegExp(jsonNumberGrammar, 'y');

const hexPattern = /^[0-9A-Fa-f]{4}$/;

/** 数字文本的各部分：符号、整数部分、小数部分与指数 */
const decimalPattern = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

/**
 * 数字文本的十进制值，写成可比较的规范形式：符号、去掉首尾零的有效数字与十的幂，零只保留符号
 *
 * @remarks
 * `2.0` 与 `2`、`1e2` 与 `100` 的规范形式相同；指数用 bigint，`1e99999999999999999999` 也不溢出
 */
function decimalKey(text: string): string {
  const match = decimalPattern.exec(text);
  if (match === null) {
    return text;
  }
  const [, sign = '', integer = '', fraction = '', exponent = '0'] = match;
  const digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (digits === '') {
    return `${sign}0`;
  }
  const significant = digits.replace(/0+$/, '');
  const scale = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  return `${sign}${significant}e${scale}`;
}

/**
 * 读取 JSON 文本并做共同的读取检查（RFC-0001「JSON 文本」，ADR-0236）
 *
 * @remarks
 * Result 与 Error 的线上编码、操作载荷与清单都先过这一遍：
 * - 语法按 RFC 8259：没有注释、尾逗号、单引号、`NaN`、前导零、正号与多个根值，空文本与只有空白也不是 JSON；开头的 BOM 是语法错误。
 * - 嵌套不超过 64 层；字符串与成员名必须是合法的 Unicode：字节按严格的 UTF-8 解码，文本里没有原始的控制字符与孤立的代理项，
 *   转义只用 RFC 8259 的那几种，`\uD800`–`\uDBFF` 后必须紧跟低代理项的转义。
 * - 任何一层都不能有重复的成员名，名字按转义还原后逐个 UTF-16 码元比较。
 * - 语法错误不论在哪里都优先于重复成员。
 *
 * 数字按值模型读：整数写法（没有小数点与指数）且在 64 位范围内是整数，安全整数是 `number`、其余是 `bigint`，`-0` 是整数 0；
 * 其余是双精度浮点，值恰好是安全整数（`2.0`、`1e2`）时是 {@link Float64}，否则是 `number`，`-0.0` 是负零。
 * 换成数值再写出时十进制值与原文不同的（`1e400`、`1e-400`、超出 64 位的整数、比双精度更多的有效数字）是保留原文的 {@link JsonNumber}，
 * 值模型里它是浮点，上溢为无穷、下溢为 0
 *
 * @param input - JSON 文本，或它的 UTF-8 字节
 */
export function readJsonText(input: string | Uint8Array): JsonTextRead {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = strictUtf8.decode(input);
    } catch {
      return { ok: false, problem: syntaxProblem };
    }
  }
  const reader = new Reader(text);
  let root: JsonNode;
  try {
    reader.skipWhitespace();
    root = reader.value(JsonPath.root, 0);
    reader.skipWhitespace();
    if (reader.index < text.length) {
      throw invalid;
    }
  } catch (error) {
    if (error === invalid) {
      return { ok: false, problem: syntaxProblem };
    }
    throw error;
  }
  return reader.duplicate === undefined
    ? { ok: true, root }
    : { ok: false, problem: Object.freeze({ kind: 'duplicate', path: reader.duplicate }) };
}

/**
 * 读取 JSON 文本，返回普通的 JSON 值
 *
 * @remarks
 * 先做 {@link readJsonText} 的共同检查；对象成员按文本顺序定义（整数样式的键仍会被 JavaScript 提到前面），
 * 名为 `__proto__` 的成员是普通成员，不改原型
 *
 * @throws {@link FrameworkError} 没有通过检查时，码为 `PRIMITIVES_VALIDATION_001`
 */
export function parseJson(input: string | Uint8Array): JsonValue {
  const read = readJsonText(input);
  if (!read.ok) {
    throw read.problem.kind === 'syntax'
      ? new FrameworkError(ErrorCode.InvalidArgument, 'The text is not valid JSON.')
      : new FrameworkError(
          ErrorCode.InvalidArgument,
          `The member at '${read.problem.path}' appears more than once in the same JSON object.`,
        );
  }
  return toJsonValue(read.root);
}

/**
 * 把保留文档顺序的树转成普通的 JSON 值：{@link JsonMembers} 成为普通对象，其余原样
 */
export function toJsonValue(node: JsonNode): JsonValue {
  if (node instanceof JsonMembers) {
    const object: Record<string, JsonValue> = {};
    for (const [name, value] of node.entries) {
      defineMember(object, name, toJsonValue(value));
    }
    return object;
  }
  if (Array.isArray(node)) {
    return node.map(toJsonValue);
  }
  return node as JsonValue;
}

/** 递归下降的读取器：语法错误抛出 {@link invalid}，重复成员只记第一处并继续读，让后面的语法错误优先 */
class Reader {
  readonly text: string;
  index = 0;
  /** 第一处重复成员的路径 */
  duplicate: string | undefined;

  constructor(text: string) {
    this.text = text;
  }

  skipWhitespace(): void {
    const { text } = this;
    while (this.index < text.length) {
      const code = text.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
        return;
      }
      this.index += 1;
    }
  }

  /**
   * 读一个值
   *
   * @param path - 这个值的路径；已经找到重复成员时不再需要，传空串
   * @param depth - 所在容器的层数，根为 0
   */
  value(path: string, depth: number): JsonNode {
    switch (this.text.charCodeAt(this.index)) {
      case 0x7b:
        return this.object(path, depth + 1);
      case 0x5b:
        return this.array(path, depth + 1);
      case 0x22:
        return this.string();
      case 0x74:
        return this.literal('true', true);
      case 0x66:
        return this.literal('false', false);
      case 0x6e:
        return this.literal('null', null);
      default:
        return this.number();
    }
  }

  object(path: string, depth: number): JsonMembers {
    if (depth > maxJsonDepth) {
      throw invalid;
    }
    this.index += 1;
    const entries: [string, JsonNode][] = [];
    const names = new Set<string>();
    this.skipWhitespace();
    if (this.text.charCodeAt(this.index) === 0x7d) {
      this.index += 1;
      return new JsonMembers(entries);
    }
    for (;;) {
      if (this.text.charCodeAt(this.index) !== 0x22) {
        throw invalid;
      }
      const name = this.string();
      const memberPath = this.duplicate === undefined ? JsonPath.member(path, name) : '';
      if (names.has(name)) {
        this.duplicate ??= memberPath;
      } else {
        names.add(name);
      }
      this.skipWhitespace();
      if (this.text.charCodeAt(this.index) !== 0x3a) {
        throw invalid;
      }
      this.index += 1;
      this.skipWhitespace();
      entries.push([name, this.value(memberPath, depth)]);
      if (this.close(0x7d)) {
        return new JsonMembers(entries);
      }
    }
  }

  array(path: string, depth: number): JsonNode[] {
    if (depth > maxJsonDepth) {
      throw invalid;
    }
    this.index += 1;
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.text.charCodeAt(this.index) === 0x5d) {
      this.index += 1;
      return items;
    }
    for (;;) {
      items.push(this.value(this.duplicate === undefined ? JsonPath.index(path, items.length) : '', depth));
      if (this.close(0x5d)) {
        return items;
      }
    }
  }

  /** 一项之后：遇到结束符返回 true，遇到逗号跳到下一项返回 false，其余是语法错误 */
  close(end: number): boolean {
    this.skipWhitespace();
    const code = this.text.charCodeAt(this.index);
    this.index += 1;
    if (code === end) {
      return true;
    }
    if (code !== 0x2c) {
      throw invalid;
    }
    this.skipWhitespace();
    return false;
  }

  literal<T extends boolean | null>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.index)) {
      throw invalid;
    }
    this.index += word.length;
    return value;
  }

  number(): number | bigint | Float64 | JsonNumber {
    numberPattern.lastIndex = this.index;
    const match = numberPattern.exec(this.text);
    if (match === null) {
      throw invalid;
    }
    const [digits] = match;
    this.index += digits.length;
    if (match[1] === undefined && match[2] === undefined) {
      // 整数写法：64 位范围内是整数，BigInt('-0') 是 0n，负零的整数写法读成 0
      const integer = BigInt(digits);
      if (integer >= minInt64 && integer <= maxInt64) {
        const value = Number(integer);
        return Number.isSafeInteger(value) ? value : integer;
      }
    }
    const value = Number(digits);
    // 写回时与原文的十进制值不同就保留原文（RFC-0011 规则 2：任意 JSON 的成员写回时 JSON 值相等）
    if (!Number.isFinite(value) || decimalKey(floatText(value)) !== decimalKey(digits)) {
      return new JsonNumber(digits);
    }
    return isIntegerNumber(value) ? new Float64(value) : value;
  }

  string(): string {
    const { text } = this;
    let index = this.index + 1;
    let start = index;
    let result = '';
    for (;;) {
      if (index >= text.length) {
        throw invalid;
      }
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        this.index = index + 1;
        return result + text.slice(start, index);
      }
      if (code === 0x5c) {
        result += text.slice(start, index);
        const [unescaped, length] = this.escape(index);
        result += unescaped;
        index += length;
        start = index;
        continue;
      }
      if (code < 0x20) {
        throw invalid;
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        // 文本里的代理项必须成对；孤立的不是合法的 Unicode
        const next = text.charCodeAt(index + 1);
        if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) {
          throw invalid;
        }
        index += 2;
        continue;
      }
      index += 1;
    }
  }

  /** 读一个转义，返回还原的文本与占用的长度 */
  escape(index: number): [string, number] {
    switch (this.text.charCodeAt(index + 1)) {
      case 0x22:
        return ['"', 2];
      case 0x5c:
        return ['\\', 2];
      case 0x2f:
        return ['/', 2];
      case 0x62:
        return ['\b', 2];
      case 0x66:
        return ['\f', 2];
      case 0x6e:
        return ['\n', 2];
      case 0x72:
        return ['\r', 2];
      case 0x74:
        return ['\t', 2];
      case 0x75: {
        const unit = this.hex(index + 2);
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw invalid;
        }
        if (unit < 0xd800 || unit > 0xdbff) {
          return [String.fromCharCode(unit), 6];
        }
        // 高代理项的转义后必须紧跟低代理项的转义
        if (this.text.charCodeAt(index + 6) !== 0x5c || this.text.charCodeAt(index + 7) !== 0x75) {
          throw invalid;
        }
        const low = this.hex(index + 8);
        if (low < 0xdc00 || low > 0xdfff) {
          throw invalid;
        }
        return [String.fromCharCode(unit, low), 12];
      }
      default:
        throw invalid;
    }
  }

  hex(index: number): number {
    const digits = this.text.slice(index, index + 4);
    if (!hexPattern.test(digits)) {
      throw invalid;
    }
    return Number.parseInt(digits, 16);
  }
}
