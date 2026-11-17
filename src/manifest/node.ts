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

/**
 * 读取清单文件（RFC-0002 解析规则 2，ADR-0236）
 *
 * @remarks
 * 文件按 UTF-8 读，开头的 UTF-8 BOM 跳过，其余同 {@link readManifest}：不是合法 UTF-8 时为 `kernel.manifest.invalid_json`。
 * 文件不存在为 `KERNEL_CAPABILITY_006` + `kernel.manifest.file_missing`，参数 `path` 是给出的路径（URL 换成文件路径）
 *
 * @throws 文件存在但读不出来（如没有权限）时，原样抛出文件系统的错误
 */
export async function readManifestFile(path: string | URL): Promise<Result<Manifest>> {
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
  const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  return readManifest(bom ? data.subarray(3) : data);
}
