/**
 * 在 Node 里读取清单文件
 *
 * @remarks
 * 单独的子路径 `@xihan-framework/manifest/node`：主入口不引用 `node:fs`，浏览器与打包器里也能用
 *
 * @packageDocumentation
 */

import { readFile } from 'node:fs/promises';

import { ErrorCode, FrameworkError } from '@xihan-framework/primitives';

import { type Manifest, readManifest } from './manifest.ts';

/**
 * 读取并校验清单文件
 *
 * @throws {@link FrameworkError} 文件读不出来或清单不合法时，码为 `PRIMITIVES_VALIDATION_001`
 */
export async function readManifestFile(path: string | URL): Promise<Manifest> {
  let data: Uint8Array;
  try {
    data = await readFile(path);
  } catch (cause) {
    throw new FrameworkError(ErrorCode.InvalidArgument, 'The manifest file could not be read.', { cause });
  }
  return readManifest(data);
}
