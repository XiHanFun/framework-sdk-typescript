/**
 * 在 Node 里读取清单文件
 *
 * @remarks
 * 单独的子路径 `xihan-framework/manifest/node`：主入口不引用 `node:fs`，浏览器与打包器里也能用
 *
 * @packageDocumentation
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ErrorInfo, Result } from '../primitives/index.ts';

import { type Manifest, ManifestErrorCode, ManifestMessageKey, readManifest } from './manifest.ts';

/** 文件不存在、路径里有一段不是目录、路径是目录：都按清单文件不存在报，与 .NET 的 `File.Exists` 一致 */
const missingCodes: readonly string[] = ['ENOENT', 'ENOTDIR', 'EISDIR'];

/** 严格的 UTF-8：与清单读取用的解码相同，坏字节不换成 U+FFFD；BOM 已按字节跳过，剩下的原样保留 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * 清单文件的内容：原文与读出的清单
 */
export interface ManifestSource {
  /**
   * 清单原文：文件的字节按严格的 UTF-8 解码，不带开头的 BOM
   *
   * @remarks
   * 插件握手时原样交给宿主的就是它（handshake.md §3 第 3 条）；与 {@link ManifestSource.manifest} 来自同一段字节
   */
  readonly text: string;
  /** 读出的清单 */
  readonly manifest: Manifest;
}

/**
 * 读取清单文件的字节，连同原文一起返回（RFC-0002 解析规则 2，ADR-0236）
 *
 * @remarks
 * 文件内容已经在内存里时用它，规则同 {@link readManifestSource}：开头的 UTF-8 BOM 跳过一次，其余同 {@link readManifest}，
 * 不是合法的 UTF-8 时为 `kernel.manifest.invalid_json`，不会把坏字节换成 U+FFFD 再读
 *
 * @param data - 清单文件的字节
 */
export function readManifestBytes(data: Uint8Array): Result<ManifestSource> {
  const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  const content = bom ? data.subarray(3) : data;
  const read = readManifest(content);
  if (!read.ok) {
    return Result.fail(read.error);
  }
  // 读取已经按严格的 UTF-8 解码过同一段字节，这里不会再失败：原文与清单逐字节对应
  return Result.ok(Object.freeze({ text: strictUtf8.decode(content), manifest: read.value }));
}

/**
 * 读取清单文件，连同原文一起返回（RFC-0002 解析规则 2，ADR-0236）
 *
 * @remarks
 * 文件按 UTF-8 读，开头的 UTF-8 BOM 跳过，其余同 {@link readManifest}：不是合法 UTF-8 时为 `kernel.manifest.invalid_json`。
 * 文件不存在为 `KERNEL_CAPABILITY_006` + `kernel.manifest.file_missing`，参数 `path` 是给出的路径（URL 换成文件路径）。
 * 插件运行时用它读插件目录里的清单：握手交出的原文与读出的清单出自同一次读取
 *
 * @throws 文件存在但读不出来（如没有权限）时，原样抛出文件系统的错误
 */
export async function readManifestSource(path: string | URL): Promise<Result<ManifestSource>> {
  let data: Uint8Array;
  try {
    data = await readFile(path);
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && missingCodes.includes(code)) {
      return Result.fail(
        ErrorInfo.create(ManifestErrorCode.Invalid, ManifestMessageKey.FileMissing, {
          path: typeof path === 'string' ? path : fileURLToPath(path),
        }),
      );
    }
    throw error;
  }
  return readManifestBytes(data);
}

/**
 * 读取清单文件（RFC-0002 解析规则 2，ADR-0236）
 *
 * @remarks
 * {@link readManifestSource} 只取清单的特例：文件按 UTF-8 读，开头的 UTF-8 BOM 跳过，不是合法 UTF-8 时为
 * `kernel.manifest.invalid_json`，文件不存在为 `KERNEL_CAPABILITY_006` + `kernel.manifest.file_missing`
 *
 * @throws 文件存在但读不出来（如没有权限）时，原样抛出文件系统的错误
 */
export async function readManifestFile(path: string | URL): Promise<Result<Manifest>> {
  const source = await readManifestSource(path);
  return source.ok ? Result.ok(source.value.manifest) : Result.fail(source.error);
}
