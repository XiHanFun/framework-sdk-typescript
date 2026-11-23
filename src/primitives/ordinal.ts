/**
 * 按 UTF-16 码元比较两个字符串（序数比较），返回负数、零或正数
 *
 * @remarks
 * 规范里的「码元序」「序数顺序」都是它，与 .NET 的 `StringComparison.Ordinal` 相同：不按区域，也不按码点
 * （代理对的码元 0xD800–0xDFFF 排在 U+E000–U+FFFF 之前）。字符串的 `<` 正是逐码元比较；`localeCompare` 按区域，不能用。
 * 错误细节的键、模板里对象成员的名字、描述的参数、登记表的列出与管道归属的排序共用这一个
 *
 * @internal
 */
export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
