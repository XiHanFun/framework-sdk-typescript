/** 成员名含其中任一字符时写成 `['名字']`（RFC-0011 规则 2，照 System.Text.Json 的实测） */
const bracketed = /[. '/"[\]()\\\t\n\r\f\b\u0085\u2028\u2029]/;

/**
 * 载荷错误路径的写法（RFC-0011 规则 2，ADR-0235）
 *
 * @remarks
 * 解码器报告出错位置时用它拼路径，交给 {@link RequestDecodeError}：从 `$` 起，成员写 `.名字`，数组下标写 `[i]`；
 * 成员名含 `.`、空格、`'`、`/`、`"`、`[`、`]`、`(`、`)`、`\`、制表、换行、回车、换页、退格、U+0085、U+2028、U+2029
 * 之一时写 `['名字']`，名字原样、不转义；空的成员名写成 `$.`
 *
 * @example
 * ```ts
 * JsonPath.member(JsonPath.index(JsonPath.member(JsonPath.root, 'lines'), 1), 'quantity'); // $.lines[1].quantity
 * JsonPath.member(JsonPath.root, 'unit price'); // $['unit price']
 * ```
 */
export const JsonPath = Object.freeze({
  /** 根：载荷是 `null`、不是对象或根上就不合时的路径 */
  root: '$',

  /**
   * 成员的路径
   */
  member(parent: string, name: string): string {
    return bracketed.test(name) ? `${parent}['${name}']` : `${parent}.${name}`;
  },

  /**
   * 数组元素的路径
   */
  index(parent: string, index: number): string {
    return `${parent}[${index}]`;
  },
});
