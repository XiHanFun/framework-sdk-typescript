/**
 * 换算成 UTC 之后（不计小数）允许的最早时刻：0001-01-01T00:00:00（RFC-0003 规则 8）
 *
 * @internal
 */
export const minDeadline = -62_135_596_800_000;

/**
 * 换算成 UTC 之后（不计小数）允许的最晚时刻：9999-12-31T23:59:59（RFC-0003 规则 8）
 *
 * @internal
 */
export const maxDeadline = 253_402_300_799_000;

/** 小数点之后的位与偏移：`(\.[0-9]{1,9})?([Zz]|[+-][0-9]{2}:[0-9]{2})`，整串匹配 */
const tailPattern = /^(?:\.([0-9]{1,9}))?(?:([Zz])|([+-])([0-9]{2}):([0-9]{2}))$/;

/**
 * 按截止时间文本的文法（RFC-0003 规则 8）严格读 `InvocationMetadata.deadline`，返回 UTC 的 Unix 毫秒；读不出（含空串）时为 `undefined`
 *
 * @remarks
 * 文法 `^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?([Zz]|[+-][0-9]{2}:[0-9]{2})\z`：
 * 年 0001–9999、月日按公历（含闰年）、时 00–23、分 00–59、秒 00–59（不认闰秒）、偏移的时 00–23 与分 00–59，
 * 换算成 UTC 之后（不计小数）在 0001-01-01T00:00:00 到 9999-12-31T23:59:59 之间。JavaScript 的时钟精度是毫秒，
 * 第三位之后的小数截断、不进位：截止时间只会比宿主给的早不到 1 毫秒。读不出的调用方当作没有截止时间。
 * 向量见 spec/conformance/vectors/plugin/deadlines.json
 *
 * @internal
 */
export function parseDeadline(text: string): number | undefined {
  // 固定部分 yyyy-MM-ddTHH:mm:ss 是 19 个字符，只认 ASCII 数字（全角数字等其他数字字符不算）
  if (
    text.length < 20 ||
    text[4] !== '-' ||
    text[7] !== '-' ||
    (text[10] !== 'T' && text[10] !== 't') ||
    text[13] !== ':' ||
    text[16] !== ':'
  ) {
    return undefined;
  }
  const year = digits(text, 0, 4);
  const month = digits(text, 5, 7);
  const day = digits(text, 8, 10);
  const hour = digits(text, 11, 13);
  const minute = digits(text, 14, 16);
  const second = digits(text, 17, 19);
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  if (hour === undefined || minute === undefined || second === undefined) {
    return undefined;
  }
  // Date 会把越界的日期进位成别的日子，所以每一段先按公历核对
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const tail = tailPattern.exec(text.slice(19));
  if (tail === null) {
    return undefined;
  }
  const [, fraction, zulu, sign, offsetHours = '', offsetMinutes = ''] = tail;
  let offset = 0;
  if (zulu === undefined) {
    const hours = Number(offsetHours);
    const minutes = Number(offsetMinutes);
    if (hours > 23 || minutes > 59) {
      return undefined;
    }
    offset = (hours * 60 + minutes) * 60_000 * (sign === '-' ? -1 : 1);
  }
  // setUTCFullYear 不像 Date.UTC 那样把 0–99 年当作 1900 年以后
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  // 范围按换算成 UTC 之后、不计小数的时刻判定，所以 9999-12-31T23:59:59.999999999Z 仍然合法
  const utc = date.getTime() - offset;
  if (utc < minDeadline || utc > maxDeadline) {
    return undefined;
  }
  // 只取前三位小数：多出的位截断不进位，不足三位按右补零
  return utc + (fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0')));
}

/**
 * 按 .NET 的 `O` 格式写出截止时间（invocation.md §2）：UTC、七位小数、`+00:00` 偏移
 *
 * @remarks
 * 毫秒之后的四位总是 `0000`；超出 0001-01-01 到 9999-12-31T23:59:59.999 的时刻按两端写出（早于下限的已经过期，
 * 晚于上限的等于没有截止时间），写出的文本总能按 {@link parseDeadline} 读回
 *
 * @internal
 */
export function formatDeadline(deadline: number): string {
  const clamped = Math.min(Math.max(Math.trunc(deadline), minDeadline), maxDeadline + 999);
  return `${new Date(clamped).toISOString().slice(0, 23)}0000+00:00`;
}

/**
 * 生效的截止时间（invocation.md §2）：元数据的 `deadline` 按 {@link parseDeadline} 读、读不出当作没有，
 * 与 gRPC 调用自身的截止时间取较早的一个；两者都没有时为 `undefined`
 *
 * @param metadata - 元数据里的 `deadline` 文本
 * @param grpc - gRPC 调用的截止时间（Unix 毫秒）；没有为 `undefined`
 *
 * @internal
 */
export function effectiveDeadline(metadata: string, grpc: number | undefined): number | undefined {
  const parsed = parseDeadline(metadata);
  if (parsed === undefined) {
    return grpc;
  }
  return grpc === undefined ? parsed : Math.min(parsed, grpc);
}

/** 读 `[start, end)` 一段全是 ASCII 数字的文本；有别的字符时为 `undefined` */
function digits(text: string, start: number, end: number): number | undefined {
  let value = 0;
  for (let index = start; index < end; index += 1) {
    const digit = text.charCodeAt(index) - 0x30;
    if (digit < 0 || digit > 9) {
      return undefined;
    }
    value = value * 10 + digit;
  }
  return value;
}

/** 公历某年某月的天数：四年一闰、百年不闰、四百年再闰 */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
