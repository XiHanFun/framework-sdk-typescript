import { type InspectOptionsStylized, inspect } from 'node:util';

import { writeJson } from '../primitives/index.ts';

/**
 * 一个已解析的资源绑定（plugin/lifecycle.md §2、§7.2）
 *
 * @remarks
 * 主值与属性值可能是凭据，不要写进日志、错误与其他诊断输出。运行时交出的绑定是冻结的普通对象，它的调试出口——`toJSON`
 * （`JSON.stringify` 与 {@link PluginLogger}）、`toString` 与 `util.inspect`（`console.log`）——只带绑定名、类型与属性名，
 * 不带主值与属性值；展开（`{ ...binding }`）或逐个成员拷出来的对象没有这层保护，单独打印 `properties` 也会带出值
 */
export interface PluginBinding {
  /** 绑定名：清单里的名字 */
  readonly name: string;
  /** 资源类型，如 `connection:relational` */
  readonly type: string;
  /** 主值：连接串或地址；来源只给了属性、没有给主值时为空串，不是错误 */
  readonly value: string;
  /**
   * 其余属性：属性名到属性值
   *
   * @remarks
   * 属性名区分大小写、原样交出（`accessKey` 与 `AccessKey` 是两项）；没有属性时是空表（按较早的规范实现的宿主不发这个字段，
   * 读到的也是空表），值为空的属性照样在表里，各项的先后没有含义。运行时不核对属性名的文法与上限，那是宿主的事。
   * 这张表是这次配置的一份拷贝
   */
  readonly properties: ReadonlyMap<string, string>;
}

/**
 * 绑定在调试出口里的样子：只有绑定名、类型与属性名
 *
 * @internal
 */
export interface BindingSummary {
  /** 绑定名 */
  readonly name: string;
  /** 资源类型 */
  readonly type: string;
  /** 属性名，按 UTF-16 码元升序：与别的 SDK 对同一个绑定写出同一份 JSON（属性名只有 ASCII，等于按字节） */
  readonly propertyNames: readonly string[];
}

/**
 * 造出运行时交给作者的绑定：四个成员照给，调试出口不带主值与属性值（lifecycle.md §7.2）
 *
 * @param properties - 属性名与属性值；拷贝一份，之后改动来源不影响这个绑定
 *
 * @internal
 */
export function deliveredBinding(
  name: string,
  type: string,
  value: string,
  properties: Iterable<readonly [string, string]>,
): PluginBinding {
  // 属性表用 Map 而不是普通对象：`__proto__` 是合文法的属性名，写进普通对象是空操作，会丢
  const binding: PluginBinding = { name, type, value, properties: new Map(properties) };
  const summary = (): BindingSummary => ({
    name,
    type,
    // 不按线上的先后：Go、Java、PHP 都按升序写，同一个绑定在六个 SDK 里得到同一份文本
    propertyNames: [...binding.properties.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  });
  // 调试出口是不可枚举的自有成员：绑定仍是普通对象，展开与逐成员比较只见上面四个成员；
  // JSON.stringify、日志、模板字符串与 console.log 取到的是这几个出口，写不出主值与属性值
  Object.defineProperties(binding, {
    toJSON: { value: summary },
    toString: { value: (): string => `PluginBinding(${writeJson(summary())})` },
    [inspect.custom]: {
      // 第一个参数是还剩几层，不限层数时为 null；层数用完只写一个记号
      value: (depth: number | null, options: InspectOptionsStylized): string => {
        if (depth !== null && depth < 0) {
          return options.stylize('[PluginBinding]', 'special');
        }
        // 摘要只有两层且大小有界，属性名总是写全：嵌在配置里打印时剩下的层数不够，名字也不该折叠成 [Array]
        return `PluginBinding ${inspect(summary(), { ...options, depth: null })}`;
      },
    },
  });
  return Object.freeze(binding);
}
