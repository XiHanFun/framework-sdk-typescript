/**
 * JSON 数字的文法（RFC 8259）：整数部分不带前导零，小数点与指数后至少一位；两个捕获组依次是小数部分与指数
 *
 * @remarks
 * 文法只写在这一处：整串匹配用 {@link isJsonNumberText}，JSON 读取器从文本中间扫描时用它建粘连（`y`）的正则。
 * 这个文件不导入别的模块：读取器在模块加载时就要用到文法，放在有循环导入的 json.ts 里会碰上还没初始化的绑定
 *
 * @internal
 */
export const jsonNumberGrammar = '-?(?:0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?';

/** 数字的文法，整串匹配 */
const numberTextPattern = new RegExp(`^(?:${jsonNumberGrammar})$`);

/**
 * 判断文本是否整串符合 JSON 数字的文法（RFC 8259）：不带空白、正号与前导零
 *
 * @remarks
 * `JsonNumber` 的原文与插件配置节里读成数字的字符串叶子都按它判断
 *
 * @internal
 */
export function isJsonNumberText(text: string): boolean {
  return numberTextPattern.test(text);
}
