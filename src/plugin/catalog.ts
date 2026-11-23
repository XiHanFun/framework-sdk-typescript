import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FrameworkError,
  isLocaleName,
  isMessageKey,
  isPlainObject,
  MessageCatalog,
  parseJson,
} from '../primitives/index.ts';

/**
 * 插件在握手时交给宿主的一份消息目录（RFC-0010）：目录名与每种区域的键 → 模板
 *
 * @remarks
 * 宿主用它翻译插件返回的错误；至少要有 `en-US`（handshake.md §3 第 6 条）
 */
export interface PluginCatalog {
  /** 目录名；通常取清单 ID 的领域段 */
  readonly name: string;
  /** 区域 → 消息键 → 模板 */
  readonly locales: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * 从目录读取消息目录：每种区域一个文件 `<区域>.json`，内容是键 → 模板
 *
 * @remarks
 * 文件按 UTF-8 读、先过共同的 JSON 读取检查；不是 `.json` 的文件与子目录忽略
 *
 * @throws {@link FrameworkError} 目录读不出、文件不是键到字符串的对象、区域名或消息键不合法、没有 `en-US.json` 时，
 * 码为 `PRIMITIVES_VALIDATION_001`
 */
export function loadCatalog(name: string, directory: string): PluginCatalog {
  const locales: Record<string, Readonly<Record<string, string>>> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const locale = entry.name.slice(0, -'.json'.length);
    const parsed = parseJson(readFileSync(join(directory, entry.name)));
    if (!isLocaleName(locale) || !isPlainObject(parsed)) {
      throw FrameworkError.invalidArgument(
        `The catalog file '${entry.name}' must be named after a locale and hold a JSON object.`,
      );
    }
    const templates: Record<string, string> = {};
    for (const [key, template] of Object.entries(parsed)) {
      if (!isMessageKey(key) || typeof template !== 'string') {
        throw FrameworkError.invalidArgument(`The catalog file '${entry.name}' has an invalid entry '${key}'.`);
      }
      templates[key] = template;
    }
    locales[locale] = Object.freeze(templates);
  }
  const catalog: PluginCatalog = Object.freeze({ name, locales: Object.freeze(locales) });
  checkCatalog(catalog);
  return catalog;
}

/**
 * 核对一份目录：名字非空、区域名与消息键合法、有 `en-US`
 *
 * @internal
 */
export function checkCatalog(catalog: PluginCatalog): void {
  if (typeof catalog.name !== 'string' || catalog.name === '') {
    throw FrameworkError.invalidArgument('A message catalog needs a name.');
  }
  // 构造一遍内存目录：区域名、消息键、模板与大小写重复的区域按它的规则核对
  new MessageCatalog(catalog.locales);
  if (!Object.keys(catalog.locales).some((locale) => locale.toLowerCase() === 'en-us')) {
    throw FrameworkError.invalidArgument(`The message catalog '${catalog.name}' has no en-US templates.`);
  }
}
