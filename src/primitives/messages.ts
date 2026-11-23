import { ErrorCode } from './error-code.ts';
import { FrameworkError } from './framework.ts';
import { Float64, isIntegerNumber, isPlainObject, JsonMembers, JsonNumber, maxInt64, minInt64 } from './json.ts';
import { floatText, quoteJsonString } from './json-writer.ts';
import { compareOrdinal } from './ordinal.ts';

/**
 * 模板参数：占位符名到值；位置参数的键是 `"0"`、`"1"`…
 */
export type MessageArguments = Readonly<Record<string, unknown>>;

/** 消息键文法（RFC-0001、RFC-0010，2026-10-28 起首段也允许下划线） */
const messageKeyPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** 消息键的最大长度（RFC-0010「消息键」，与 .NET 的 `MessageTemplate.MaxKeyLength` 相同） */
export const maxMessageKeyLength = 128;

/** 占位符名文法：按名字或按位置 */
const placeholderNamePattern = /^([A-Za-z][A-Za-z0-9_]*|[0-9]+)$/;

/** 区域名文法（RFC-0010） */
const localeNamePattern = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** 区域名的最大长度（RFC-0010 `LocaleName.MaxLength`） */
const localeNameMaxLength = 35;

/** 默认区域，也是语言文件的基准 */
const fallbackLocale = 'en-US';

/**
 * 判断消息键是否符合 `<domain>.<segment>[.<segment>…]`，各段 `[a-z][a-z0-9_]*`，最长 128 个字符
 */
export function isMessageKey(key: string): boolean {
  return key.length <= maxMessageKeyLength && messageKeyPattern.test(key);
}

/**
 * 校验消息键并原样返回
 *
 * @throws {@link FrameworkError} 消息键不合法时，码为 `PRIMITIVES_VALIDATION_001`
 */
export function validateMessageKey(key: string): string {
  if (typeof key !== 'string' || !isMessageKey(key)) {
    throw FrameworkError.invalidArgument(`The message key '${key}' must match <domain>.<segment>[.<segment>].`);
  }
  return key;
}

/**
 * 返回消息键的领域段（第一个点之前）；不合法时为 `undefined`
 */
export function messageKeyDomain(key: string): string | undefined {
  return isMessageKey(key) ? key.slice(0, key.indexOf('.')) : undefined;
}

/**
 * 判断区域名是否合法：`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$`，最长 35 个字符
 */
export function isLocaleName(name: string): boolean {
  return name.length <= localeNameMaxLength && localeNamePattern.test(name);
}

/** 模板的一段：字面文本，或一个占位符 */
type Segment =
  | { readonly literal: string }
  | { readonly literal?: undefined; readonly name: string; readonly format: string | undefined };

/**
 * 把模板切成字面段与占位符段
 *
 * @remarks
 * 规则与 .NET `MessageTemplate` 一致：`{{`、`}}` 是转义的花括号；`{` 后没有闭合的 `}`，
 * 或花括号里不是合法的占位符名，都按字面文本保留
 */
function parse(template: string): Segment[] {
  const segments: Segment[] = [];
  let literal = '';
  let index = 0;
  while (index < template.length) {
    const char = template.charAt(index);
    if ((char === '{' || char === '}') && template.charAt(index + 1) === char) {
      literal += char;
      index += 2;
      continue;
    }
    if (char !== '{') {
      literal += char;
      index += 1;
      continue;
    }
    const end = template.indexOf('}', index + 1);
    if (end < 0) {
      literal += template.slice(index);
      break;
    }
    const body = template.slice(index + 1, end);
    const separator = body.indexOf(':');
    const name = separator < 0 ? body : body.slice(0, separator);
    if (!placeholderNamePattern.test(name)) {
      literal += template.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (literal !== '') {
      segments.push({ literal });
      literal = '';
    }
    segments.push({ name, format: separator < 0 ? undefined : body.slice(separator + 1) });
    index = end + 1;
  }
  if (literal !== '') {
    segments.push({ literal });
  }
  return segments;
}

/**
 * 列出模板里的占位符名，按出现顺序、去重
 */
export function placeholders(template: string): string[] {
  const names: string[] = [];
  for (const segment of parse(template)) {
    if (segment.literal === undefined && !names.includes(segment.name)) {
      names.push(segment.name);
    }
  }
  return names;
}

/**
 * 用参数填充模板；缺参数的占位符原样保留
 *
 * @remarks
 * 规则见 RFC-0010「模板」：`{name}` 取命名参数，`{0}` 取位置参数（见 {@link positional}），`{{`、`}}` 是转义的花括号；
 * 值为 `null` 写空串，不算缺值，`undefined` 算缺值。值先归到值模型（见 {@link formatValue}），
 * 占位符可带 `:format`：只认 `D`、`X` / `x`、`F`、`N` 加至多两位精度（如 `{count:D3}` 得 `007`，`F` 与 `N` 正好一半时取偶），
 * 其余说明符一律按无格式写出
 *
 * @param locale - 区域名，只决定小数点与分组符（见 {@link numberSymbols}）；缺省按不变文化
 */
export function formatMessage(template: string, args?: MessageArguments, locale?: string): string {
  return render(template, args, false, numberSymbols(locale)) as string;
}

/**
 * 用参数填充模板；有占位符缺参数时返回 `undefined`
 *
 * @remarks
 * 语言目录按它解析（RFC-0010「找不到键或占位符缺值即失败」），失败时调用方退回 {@link describe}
 *
 * @param locale - 区域名，只决定小数点与分组符；缺省按不变文化
 */
export function tryFormatMessage(template: string, args?: MessageArguments, locale?: string): string | undefined {
  return render(template, args, true, numberSymbols(locale));
}

function render(
  template: string,
  args: MessageArguments | undefined,
  strict: boolean,
  symbols: NumberSymbols,
): string | undefined {
  let text = '';
  for (const segment of parse(template)) {
    if (segment.literal !== undefined) {
      text += segment.literal;
      continue;
    }
    const value = args === undefined || !Object.hasOwn(args, segment.name) ? undefined : args[segment.name];
    if (value === undefined) {
      if (strict) {
        return undefined;
      }
      text += segment.format === undefined ? `{${segment.name}}` : `{${segment.name}:${segment.format}}`;
      continue;
    }
    text += formatValue(value, segment.format, symbols);
  }
  return text;
}

/**
 * 区域的数字符号：小数点与分组符（RFC-0010「模板」，ADR-0236）
 */
export interface NumberSymbols {
  /** 小数点 */
  readonly decimal: string;
  /** 分组符 */
  readonly group: string;
}

/** 不变文化的符号，也是表外区域的符号 */
const invariantSymbols: NumberSymbols = Object.freeze({ decimal: '.', group: ',' });

/** 规范里的固定表（.NET 10 的 ICU 实测）；en-US、zh-CN、zh-TW、ja-JP、ko-KR 与不变文化相同，不必列出 */
const localeSymbols: ReadonlyMap<string, NumberSymbols> = new Map([
  ['de-de', Object.freeze({ decimal: ',', group: '.' })],
  ['es-es', Object.freeze({ decimal: ',', group: '.' })],
  ['pt-br', Object.freeze({ decimal: ',', group: '.' })],
  // 窄不换行空格 U+202F
  ['fr-fr', Object.freeze({ decimal: ',', group: String.fromCharCode(0x202f) })],
  // 不换行空格 U+00A0
  ['ru-ru', Object.freeze({ decimal: ',', group: String.fromCharCode(0xa0) })],
]);

/**
 * 返回区域的数字符号
 *
 * @remarks
 * 区域名不区分大小写；de-DE、es-ES、pt-BR 是 `,` 与 `.`，fr-FR 是 `,` 与 U+202F，ru-RU 是 `,` 与 U+00A0，
 * 其余区域与不给区域都按不变文化（`.` 与 `,`）。负号、`NaN` 与 `Infinity` 不随区域变化
 */
export function numberSymbols(locale?: string): NumberSymbols {
  return (locale === undefined ? undefined : localeSymbols.get(locale.toLowerCase())) ?? invariantSymbols;
}

/** 可移植的格式说明符（RFC-0010「模板」）：字母后至多两位精度，可有前导零 */
const specifierPattern = /^([DdFfNnXx])([0-9]{0,2})$/;

/** 解析后的说明符：D、F、N 不区分大小写，X 与 x 定十六进制的大小写 */
interface Specifier {
  readonly letter: 'D' | 'F' | 'N' | 'X' | 'x';
  readonly precision: number | undefined;
}

function parseSpecifier(format: string | undefined): Specifier | undefined {
  const match = format === undefined ? null : specifierPattern.exec(format);
  if (match === null) {
    return undefined;
  }
  const raw = match[1] ?? '';
  const letter = raw === 'x' ? 'x' : (raw.toUpperCase() as Specifier['letter']);
  return { letter, precision: match[2] === '' || match[2] === undefined ? undefined : Number(match[2]) };
}

/** 值模型里的值（RFC-0010「模板」）：语言自己的类型已经换成文本 */
type ModelValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'integer'; readonly value: bigint }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'array'; readonly items: readonly unknown[] }
  | { readonly kind: 'object'; readonly members: readonly (readonly [string, unknown])[] };

const nullValue: ModelValue = Object.freeze({ kind: 'null' });

/**
 * 把 JavaScript 的值归到值模型（RFC-0010「模板」，ADR-0236）
 *
 * @remarks
 * - `null` 与 `undefined` 是空；安全整数的 `number`（负零除外）与 64 位范围内的 `bigint` 是整数，
 *   其余 `number`、超出 64 位的 `bigint`、{@link Float64} 与 {@link JsonNumber} 是浮点。
 * - 数组、类型化数组、`Set` 与其他可迭代对象是数组；普通对象、{@link JsonMembers} 与 `Map` 是对象，`Map` 的键按文本形式写成名字。
 * - `Date` 写 `toISOString()`（无效日期写 `Invalid Date`），其余（类实例、symbol、函数）写 `String(value)`
 */
function modelOf(value: unknown): ModelValue {
  switch (typeof value) {
    case 'undefined':
      return nullValue;
    case 'boolean':
      return { kind: 'boolean', value };
    case 'string':
      return { kind: 'string', value };
    case 'number':
      return isIntegerNumber(value) ? { kind: 'integer', value: BigInt(value) } : { kind: 'float', value };
    case 'bigint':
      return value >= minInt64 && value <= maxInt64
        ? { kind: 'integer', value }
        : { kind: 'float', value: Number(value) };
    case 'object':
      break;
    default:
      return { kind: 'string', value: String(value) };
  }
  if (value === null) {
    return nullValue;
  }
  if (value instanceof Float64 || value instanceof JsonNumber) {
    return { kind: 'float', value: value.value };
  }
  if (value instanceof JsonMembers) {
    return { kind: 'object', members: value.entries };
  }
  if (Array.isArray(value)) {
    return { kind: 'array', items: value };
  }
  if (isPlainObject(value)) {
    return { kind: 'object', members: Object.entries(value) };
  }
  if (value instanceof Map) {
    return {
      kind: 'object',
      members: [...value].map(([name, member]: [unknown, unknown]) => [
        typeof name === 'string' ? name : formatValue(name, undefined, invariantSymbols),
        member,
      ]),
    };
  }
  if (value instanceof Date) {
    return { kind: 'string', value: Number.isNaN(value.getTime()) ? String(value) : value.toISOString() };
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return { kind: 'array', items: Array.from(value as unknown as ArrayLike<unknown>) };
  }
  if (typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    return { kind: 'array', items: [...(value as Iterable<unknown>)] };
  }
  return { kind: 'string', value: String(value) };
}

/**
 * 把一个值写成模板里的文本（RFC-0010「模板」与「值的文本形式」）
 *
 * @remarks
 * 值先归到值模型：空写空串，布尔写 `true` / `false`，字符串原样，整数十进制，浮点按 {@link floatText}；
 * 数组与对象写成紧凑的 JSON（对象成员按名字的 UTF-16 码元序，数字不随区域变化，超过 64 层的容器写 `null`）。
 * 说明符：`D` 与 `X` 只用于整数，`X` 只用于非负整数，`F` 与 `N` 用于整数与浮点，不适用时按无格式写出。
 * 区域的小数点用在无格式的浮点与 `F`、`N` 上，分组符只用在 `N` 上
 *
 * @param format - 占位符的说明符，`:` 之后的部分；没有时为 `undefined`
 * @param symbols - 数字符号，见 {@link numberSymbols}
 */
export function formatValue(value: unknown, format: string | undefined, symbols: NumberSymbols): string {
  const model = modelOf(value);
  switch (model.kind) {
    case 'null':
      return '';
    case 'boolean':
      return model.value ? 'true' : 'false';
    case 'string':
      return model.value;
    case 'integer':
      return localize(formatInteger(model.value, parseSpecifier(format)), symbols);
    case 'float':
      return localize(formatFloat(model.value, parseSpecifier(format)), symbols);
    default:
      return jsonText(model, 1);
  }
}

function formatInteger(value: bigint, specifier: Specifier | undefined): string {
  switch (specifier?.letter) {
    case 'D': {
      const digits = (value < 0n ? -value : value).toString().padStart(specifier.precision ?? 1, '0');
      return value < 0n ? `-${digits}` : digits;
    }
    case 'X':
    case 'x': {
      // 负数没有可移植的十六进制写法（.NET 按类型宽度写补码），按无格式写出
      if (value < 0n) {
        return value.toString();
      }
      const digits = value.toString(16).padStart(specifier.precision ?? 1, '0');
      return specifier.letter === 'X' ? digits.toUpperCase() : digits;
    }
    case 'F':
    case 'N':
      return formatFixed(value, specifier.precision ?? 2, specifier.letter === 'N');
    default:
      return value.toString();
  }
}

function formatFloat(value: number, specifier: Specifier | undefined): string {
  const fixed = specifier?.letter === 'F' || specifier?.letter === 'N';
  // 无穷与非数写 F、N 时与无格式相同；D 与 X 不用于浮点
  return fixed && Number.isFinite(value)
    ? formatFixed(value, specifier.precision ?? 2, specifier.letter === 'N')
    : floatText(value);
}

/** 不变文化的文本换成区域的符号：`.` 是小数点，`,` 是分组符，两者同时替换 */
function localize(text: string, symbols: NumberSymbols): string {
  if (symbols === invariantSymbols || (symbols.decimal === '.' && symbols.group === ',')) {
    return text;
  }
  let localized = '';
  for (const char of text) {
    localized += char === '.' ? symbols.decimal : char === ',' ? symbols.group : char;
  }
  return localized;
}

/** 数组与对象写成 JSON 时的层数上限：再深的容器写 `null` */
const maxTextDepth = 64;

/** 值在数组与对象里的 JSON 文本；`depth` 是这个值若是容器时所在的层数，最外层为 1 */
function jsonText(model: ModelValue, depth: number): string {
  switch (model.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return model.value ? 'true' : 'false';
    case 'string':
      return quoteJsonString(model.value);
    case 'integer':
      return model.value.toString();
    case 'float':
      return floatText(model.value);
    case 'array':
      return depth > maxTextDepth
        ? 'null'
        : `[${model.items.map((item) => jsonText(modelOf(item), depth + 1)).join(',')}]`;
    case 'object': {
      if (depth > maxTextDepth) {
        return 'null';
      }
      // Array.prototype.sort 是稳定排序：同名成员保持原顺序；名字按 UTF-16 码元比较
      const members = [...model.members].sort(([left], [right]) => compareOrdinal(left, right));
      return `{${members.map(([name, member]) => `${quoteJsonString(name)}:${jsonText(modelOf(member), depth + 1)}`).join(',')}}`;
    }
  }
}

/**
 * 定点格式：按值的精确十进制展开舍入到 `digits` 位小数，正好一半时取偶（RFC-0010「模板」）
 *
 * @remarks
 * 不能用 `toFixed`（一半时进位），也不能用 Intl 的 halfEven：ICU 按最短往返的十进制串舍入，
 * 2.675 的二进制值略小于 2.675，按精确值应得 2.67，ICU 却当成正好一半得 2.68
 */
function formatFixed(value: number | bigint, digits: number, grouping: boolean): string {
  // 负数舍入成零时保留负号，负零也写负号（RFC-0010「模板」，照 .NET）
  const negative = value < 0 || Object.is(value, -0);
  const { numerator, scale } = exactDecimal(value);
  // 值 = numerator / 10^scale；乘以 10^digits 后按一半取偶舍入成整数
  let units: bigint;
  if (scale <= digits) {
    units = numerator * 10n ** BigInt(digits - scale);
  } else {
    const divisor = 10n ** BigInt(scale - digits);
    const quotient = numerator / divisor;
    const twiceRemainder = (numerator % divisor) * 2n;
    const roundUp = twiceRemainder > divisor || (twiceRemainder === divisor && quotient % 2n === 1n);
    units = roundUp ? quotient + 1n : quotient;
  }
  const text = units.toString().padStart(digits + 1, '0');
  const integer = text.slice(0, text.length - digits);
  const fraction = text.slice(text.length - digits);
  const grouped = grouping ? integer.replace(/\B(?=(\d{3})+$)/g, ',') : integer;
  return `${negative ? '-' : ''}${grouped}${digits > 0 ? `.${fraction}` : ''}`;
}

/**
 * 把数值的绝对值写成 numerator / 10^scale 的精确形式
 *
 * @remarks
 * 有限的 double 都是 m × 2^e：e < 0 时 m / 2^-e = m × 5^-e / 10^-e，所以十进制展开是有限且精确的
 */
function exactDecimal(value: number | bigint): { numerator: bigint; scale: number } {
  if (typeof value === 'bigint') {
    return { numerator: value < 0n ? -value : value, scale: 0 };
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  // 非规格化数没有隐含的最高位，指数固定为 -1074
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = biased === 0 ? -1074 : biased - 1075;
  return exponent >= 0
    ? { numerator: mantissa << BigInt(exponent), scale: 0 }
    : { numerator: mantissa * 5n ** BigInt(-exponent), scale: -exponent };
}

/**
 * 把位置参数转成以 `"0"`、`"1"`… 为键的参数表
 */
export function positional(...values: unknown[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  values.forEach((value, index) => {
    args[String(index)] = value;
  });
  return args;
}

/**
 * 在没有文案时描述一个消息：`键 (k=v, ...)`，参数按名字升序；没有参数时只有键
 *
 * @remarks
 * 值按 RFC-0010「值的文本形式」写，与区域无关，数组与对象写成紧凑的 JSON（见 {@link formatValue}）；
 * 参数按名字的序数（UTF-16 码元）顺序排列（ADR-0235）；值为 `undefined` 的参数视为没有
 */
export function describe(key: string, args?: MessageArguments): string {
  if (args === undefined) {
    return key;
  }
  const names = Object.keys(args)
    .filter((name) => args[name] !== undefined)
    // 规范要求的序数顺序：按 UTF-16 码元比较
    .sort(compareOrdinal);
  if (names.length === 0) {
    return key;
  }
  return `${key} (${names.map((name) => `${name}=${formatValue(args[name], undefined, invariantSymbols)}`).join(', ')})`;
}

/**
 * 按区域把消息键解析成已格式化的文案（RFC-0010 `IMessageResolver`）
 */
export interface MessageResolver {
  /**
   * 返回文案；没有该键、没有该区域或占位符缺值时返回 `undefined`
   */
  resolve(key: string, locale: string, args: MessageArguments | undefined): string | undefined;
}

/**
 * 一份内存消息目录：区域 → 消息键 → 模板
 *
 * @remarks
 * 区域名不区分大小写（RFC-0010）；请求的区域没有该键时回退到 `en-US`。
 * 模板按 {@link tryFormatMessage} 解析，数字符号取命中的区域（回退时是 `en-US`），占位符缺值视为解析失败
 */
export class MessageCatalog implements MessageResolver {
  /** 小写区域名 → 消息键 → 模板 */
  readonly #templates: ReadonlyMap<string, ReadonlyMap<string, string>>;

  /**
   * 创建消息目录
   *
   * @param templates - 区域 → 消息键 → 模板
   * @throws {@link FrameworkError} 区域名或消息键不合法、同一区域写了两次（大小写不同）时
   */
  constructor(templates: Readonly<Record<string, Readonly<Record<string, string>>>>) {
    const locales = new Map<string, ReadonlyMap<string, string>>();
    for (const [locale, entries] of Object.entries(templates)) {
      if (!isLocaleName(locale)) {
        throw new FrameworkError(
          ErrorCode.InvalidArgument,
          `The catalog locale '${locale}' is not a valid locale name.`,
        );
      }
      const normalized = locale.toLowerCase();
      if (locales.has(normalized)) {
        throw new FrameworkError(
          ErrorCode.InvalidArgument,
          `The catalog declares the locale '${locale}' more than once.`,
        );
      }
      const keys = new Map<string, string>();
      for (const [key, template] of Object.entries(entries)) {
        if (!isMessageKey(key)) {
          throw new FrameworkError(
            ErrorCode.InvalidArgument,
            `The catalog locale '${locale}' has the invalid message key '${key}'.`,
          );
        }
        if (typeof template !== 'string') {
          throw new FrameworkError(
            ErrorCode.InvalidArgument,
            `The template of '${key}' in '${locale}' must be a string.`,
          );
        }
        keys.set(key, template);
      }
      locales.set(normalized, keys);
    }
    this.#templates = locales;
  }

  /**
   * 解析消息键；请求的区域没有该键时回退到 `en-US`
   */
  resolve(key: string, locale: string, args: MessageArguments | undefined): string | undefined {
    const template = this.find(locale, key);
    if (template !== undefined) {
      return tryFormatMessage(template, args, locale);
    }
    const fallback = this.find(fallbackLocale, key);
    return fallback === undefined ? undefined : tryFormatMessage(fallback, args, fallbackLocale);
  }

  /**
   * 返回某个区域里某个键的模板；没有时为 `undefined`，不回退
   */
  find(locale: string, key: string): string | undefined {
    return this.#templates.get(locale.toLowerCase())?.get(key);
  }
}

/** 进程默认的解析器与区域（RFC-0001 `MessageScope.Default`） */
let defaultResolver: MessageResolver | undefined;
let currentDefaultLocale = fallbackLocale;

/**
 * 设置进程默认的消息解析器与区域
 *
 * @remarks
 * {@link ErrorInfo.message} 在没有已解析文案时按它解析；传 `undefined` 去掉解析器
 *
 * @throws {@link FrameworkError} 区域名不合法时
 */
export function setDefaultMessages(resolver: MessageResolver | undefined, locale: string): void {
  if (!isLocaleName(locale)) {
    throw new FrameworkError(ErrorCode.InvalidArgument, `The locale '${locale}' is not a valid locale name.`);
  }
  defaultResolver = resolver;
  currentDefaultLocale = locale;
}

/**
 * 返回进程默认区域，未设置时为 `en-US`
 */
export function defaultLocale(): string {
  return currentDefaultLocale;
}

/**
 * 用进程默认解析器解析消息键；没有解析器或解析失败时返回 `undefined`
 */
export function resolveMessage(key: string, args?: MessageArguments): string | undefined {
  return defaultResolver?.resolve(key, currentDefaultLocale, args);
}
