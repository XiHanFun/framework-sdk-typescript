import { ErrorCode } from './error-code.ts';
import { FrameworkError } from './framework.ts';

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
 * 值为 `null` 写空串，不算缺值，`undefined` 算缺值。占位符可带 `:format`：可移植的 `D`、`X` / `x`、`F`、`N`
 * 按不变文化解释（如 `{count:D3}` 得 `007`，`F` 与 `N` 正好一半时取偶），其他说明符按无格式输出
 */
export function formatMessage(template: string, args?: MessageArguments): string {
  return render(template, args, false) as string;
}

/**
 * 用参数填充模板；有占位符缺参数时返回 `undefined`
 *
 * @remarks
 * 语言目录按它解析（RFC-0010「找不到键或占位符缺值即失败」），失败时调用方退回 {@link describe}
 */
export function tryFormatMessage(template: string, args?: MessageArguments): string | undefined {
  return render(template, args, true);
}

function render(template: string, args: MessageArguments | undefined, strict: boolean): string | undefined {
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
    text += (segment.format === undefined ? undefined : formatNumber(value, segment.format)) ?? display(value);
  }
  return text;
}

/** 可移植的格式说明符（RFC-0010「模板」）：D 整数补零、X / x 十六进制、F 定点、N 千分位 */
const numberFormatPattern = /^([DdFfNnXx])([0-9]{0,2})$/;

/**
 * 按可移植的格式说明符（不变文化）格式化数值；不支持的格式或值返回 `undefined`，调用方按无格式输出
 */
function formatNumber(value: unknown, format: string): string | undefined {
  const match = numberFormatPattern.exec(format);
  if (match === null || (typeof value !== 'number' && typeof value !== 'bigint')) {
    return undefined;
  }
  const specifier = (match[1] ?? '').toUpperCase();
  const precision = match[2] === '' || match[2] === undefined ? undefined : Number(match[2]);
  const integral = typeof value === 'bigint' || Number.isInteger(value);
  switch (specifier) {
    case 'D': {
      if (!integral) {
        return undefined;
      }
      const negative = value < 0;
      const digits = (negative ? -BigInt(value) : BigInt(value)).toString().padStart(precision ?? 1, '0');
      return negative ? `-${digits}` : digits;
    }
    case 'X': {
      // 负数的十六进制在 .NET 里是补码表示，与宽度有关；这里不猜，退回普通文本
      if (!integral || value < 0) {
        return undefined;
      }
      const digits = BigInt(value)
        .toString(16)
        .padStart(precision ?? 1, '0');
      return match[1] === 'X' ? digits.toUpperCase() : digits;
    }
    case 'F':
    case 'N':
      if (typeof value === 'number' && !Number.isFinite(value)) {
        return undefined;
      }
      return formatFixed(value, precision ?? 2, specifier === 'N');
    default:
      return undefined;
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
  const negative = value < 0;
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
 * 把参数值转成文本（RFC-0010「值的文本形式」）
 *
 * @remarks
 * 字符串原样；数值按 `String`，在 1e-4 ≤ |x| < 1e15 内正是不用指数的最短往返形式，整数值不带小数点；
 * 布尔写 `true` / `false`；`null` 写空串。规范不作规定的数组与对象按 JSON
 */
function display(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null) {
    return '';
  }
  if (value !== null && typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) {
        return json;
      }
    } catch {
      // 循环引用或 bigint 无法编码时退回 String，描述文本只给人看
    }
  }
  return String(value);
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
 * 值按 RFC-0010「值的文本形式」写；规范不规定参数的先后，这里按名字升序（与 Go 一致）；值为 `undefined` 的参数视为没有
 */
export function describe(key: string, args?: MessageArguments): string {
  if (args === undefined) {
    return key;
  }
  const names = Object.keys(args)
    .filter((name) => args[name] !== undefined)
    .sort();
  if (names.length === 0) {
    return key;
  }
  return `${key} (${names.map((name) => `${name}=${display(args[name])}`).join(', ')})`;
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
 * 模板按 {@link tryFormatMessage} 解析，占位符缺值视为解析失败
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
    const template = this.find(locale, key) ?? this.find(fallbackLocale, key);
    return template === undefined ? undefined : tryFormatMessage(template, args);
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
