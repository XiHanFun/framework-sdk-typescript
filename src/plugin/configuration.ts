import { Float64, isPlainObject, JsonNumber, type JsonObject, type JsonValue } from '../primitives/index.ts';
import { isJsonNumberText } from '../primitives/number-grammar.ts';

/**
 * 配置节的类型化读取（plugin/lifecycle.md §7.2）
 *
 * @remarks
 * 宿主的配置源是键值字符串（.NET 的 `IConfiguration`）：叶子一律写成 JSON 字符串、值为 null 的键写 `null`，
 * 子项名从 `0` 起连续的节写成数组（lifecycle.md §2）。所以这里按 `IConfiguration` 的习惯读：
 * - 成员名按 ASCII 不区分大小写匹配；大小写不同的同名成员取文本里的第一个。
 * - 读成数字时，字符串叶子按 JSON 数字的文法（不带空白、正号与前导零）、数字叶子原样。
 * - 读成布尔时，字符串叶子只认 `true`、`false`（ASCII 不区分大小写）、布尔叶子原样。
 * - 读成字符串时只认字符串叶子。
 * 成员缺失、为 `null` 或读不成目标类型时都为 `undefined`；要区分缺失与读不成，用 {@link ConfigurationSection.has}
 * 与 {@link ConfigurationSection.get}。原样的配置节在 {@link ConfigurationSection.value}
 */
export class ConfigurationSection {
  /** 这一节的 JSON 对象，原样 */
  readonly value: JsonObject;

  /**
   * @param value - 配置节的 JSON 对象
   */
  constructor(value: JsonObject) {
    this.value = value;
    Object.freeze(this);
  }

  /** 有没有这个成员（名字按 ASCII 不区分大小写） */
  has(name: string): boolean {
    return this.#find(name) !== undefined;
  }

  /** 取成员的 JSON 值，原样；没有时为 `undefined` */
  get(name: string): JsonValue | undefined {
    return this.#find(name)?.[1];
  }

  /** 子节：成员是对象时；否则为 `undefined` */
  section(name: string): ConfigurationSection | undefined {
    const value = this.get(name);
    return isPlainObject(value) ? new ConfigurationSection(value as JsonObject) : undefined;
  }

  /** 读成字符串：成员是字符串时；否则为 `undefined` */
  string(name: string): string | undefined {
    const value = this.get(name);
    return typeof value === 'string' ? value : undefined;
  }

  /** 读成数字：数字叶子，或合 JSON 数字文法的字符串叶子；否则为 `undefined` */
  number(name: string): number | undefined {
    const value = this.get(name);
    if (typeof value === 'string') {
      // 字符串叶子读成数字时只认 JSON 数字的文法（RFC 8259），与 JsonNumber 的原文共用一个判定
      return isJsonNumberText(value) ? Number(value) : undefined;
    }
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (value instanceof Float64) {
      return value.value;
    }
    return value instanceof JsonNumber ? Number(value.text) : undefined;
  }

  /** 读成布尔：布尔叶子，或 ASCII 不区分大小写的 `true`、`false` 字符串叶子；否则为 `undefined` */
  boolean(name: string): boolean | undefined {
    const value = this.get(name);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value !== 'string') {
      return undefined;
    }
    const lowered = asciiLower(value);
    return lowered === 'true' ? true : lowered === 'false' ? false : undefined;
  }

  /** 按 ASCII 不区分大小写找成员；值为 `null` 的成员算有，取值时为 `null` */
  #find(name: string): [string, JsonValue] | undefined {
    const wanted = asciiLower(name);
    for (const entry of Object.entries(this.value)) {
      if (asciiLower(entry[0]) === wanted) {
        return entry;
      }
    }
    return undefined;
  }
}

/** 只把 ASCII 的 A–Z 换成小写：不按区域、不碰其他字母（如土耳其语的 İ） */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}
