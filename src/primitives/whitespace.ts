/**
 * 判断一个 UTF-16 码元是不是规范所说的空白（RFC-0001「空白字符」）
 *
 * @remarks
 * 25 个码位：U+0009–U+000D、U+0020、U+0085、U+00A0、U+1680、U+2000–U+200A、U+2028、U+2029、U+202F、U+205F、U+3000，
 * 即 Unicode 的 White_Space，与 .NET 的 `char.IsWhiteSpace` 和正则 `\s` 相同。Error 的文案、插件握手行与回调端点都用它。
 * JavaScript 的 `\s` 与 `String.prototype.trim` 不含 U+0085、却含 U+FEFF，不能直接用；这些字符都在基本平面里，
 * 逐个码元比较与按码点比较结果相同
 *
 * @internal
 */
export function isWhitespace(unit: number): boolean {
  return (
    (unit >= 0x09 && unit <= 0x0d) ||
    unit === 0x20 ||
    unit === 0x85 ||
    unit === 0xa0 ||
    unit === 0x1680 ||
    (unit >= 0x2000 && unit <= 0x200a) ||
    unit === 0x2028 ||
    unit === 0x2029 ||
    unit === 0x202f ||
    unit === 0x205f ||
    unit === 0x3000
  );
}

/**
 * 文本是否为空或只有空白（RFC-0001「空白字符」）：Error 的文案不能是这样
 *
 * @internal
 */
export function isBlank(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (!isWhitespace(text.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}
