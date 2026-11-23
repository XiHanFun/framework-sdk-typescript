/**
 * 核对发布内容：`pnpm pack --dry-run` 列出的文件就是会发布到 npm 的文件
 *
 * @remarks
 * 用法：先 `pnpm build`，再 `pnpm check:pack`（即 `node scripts/pack-check.ts`）。CI 在构建之后跑它，release.yml 在发布之前跑它。
 * 核对四件事，不通过时逐条写出原因并以退出码 1 结束：
 * 1. `package.json` 的 `exports` 每个子路径的 `types` 是包里的 `.d.ts`、`default` 是包里的 `.js`
 *    （`xihan-source` 指向源码，只在本仓库里用，不要求进包）；
 * 2. `sideEffects` 列出的 `dist` 文件在包里，写错路径时打包器会把模块加载时的登记摇掉；
 * 3. 包里的 source map（`.map`）引用的源文件都在包里：指向没有发布的 `src/` 的 map 是悬空的；
 * 4. 构建信息 `.tsbuildinfo` 不进包
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根 */
const root = fileURLToPath(new URL('..', import.meta.url));

/** `package.json` 里用到的成员 */
interface PackageManifest {
  readonly exports?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly sideEffects?: boolean | readonly string[];
}

/** `pnpm pack --dry-run --json` 的输出里用到的成员 */
interface PackResult {
  readonly files: readonly { readonly path: string }[];
}

/** source map 里用到的成员 */
interface SourceMap {
  readonly sourceRoot?: string;
  readonly sources?: readonly string[];
}

/** 去掉开头的 `./`，与打包列表里的路径同一种写法 */
function packed(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//, '');
}

/** 列出会进包的文件：相对包根、以 `/` 分隔 */
function listPackedFiles(): Set<string> {
  // pnpm 在 Windows 上是 .cmd，要经 shell 才能启动；命令是固定的字符串，没有外来输入
  const pack = spawnSync('pnpm pack --dry-run --json', { cwd: root, shell: true, encoding: 'utf8' });
  if (pack.status !== 0) {
    throw new Error(`pnpm pack --dry-run 失败（退出码 ${pack.status}）：\n${pack.stdout}\n${pack.stderr}`);
  }
  // JSON 之前可能有 pnpm 的提示行
  const start = pack.stdout.indexOf('{');
  const result = JSON.parse(start < 0 ? '' : pack.stdout.slice(start)) as PackResult;
  return new Set(result.files.map((file) => packed(file.path)));
}

/** 逐项核对，返回不通过的原因 */
function check(manifest: PackageManifest, files: ReadonlySet<string>): string[] {
  const problems: string[] = [];

  // 1. 每个子路径的类型声明与入口
  const subpaths = Object.entries(manifest.exports ?? {});
  if (subpaths.length === 0) {
    problems.push('package.json 没有 exports。');
  }
  for (const [subpath, conditions] of subpaths) {
    for (const [condition, extension] of [
      ['types', '.d.ts'],
      ['default', '.js'],
    ] as const) {
      const target = conditions[condition];
      if (target === undefined) {
        problems.push(`exports["${subpath}"] 没有 ${condition} 条件。`);
      } else if (!target.endsWith(extension)) {
        problems.push(`exports["${subpath}"].${condition}（${target}）不是 ${extension} 文件。`);
      } else if (!files.has(packed(target))) {
        problems.push(
          `exports["${subpath}"].${condition}（${target}）不在包里；先 pnpm build，再看 package.json 的 files。`,
        );
      }
    }
  }

  // 2. sideEffects 列出的构建产物
  for (const entry of Array.isArray(manifest.sideEffects) ? manifest.sideEffects : []) {
    const path = packed(entry);
    if (path.startsWith('dist/') && !path.includes('*') && !files.has(path)) {
      problems.push(`sideEffects 列出的 ${entry} 不在包里。`);
    }
  }

  // 3. source map 引用的源文件
  for (const path of files) {
    if (!path.endsWith('.map')) {
      continue;
    }
    const map = JSON.parse(readFileSync(join(root, path), 'utf8')) as SourceMap;
    const missing = (map.sources ?? [])
      .map((source) => posix.normalize(posix.join(posix.dirname(path), map.sourceRoot ?? '', source)))
      .filter((source) => !files.has(source));
    if (missing.length > 0) {
      problems.push(
        `${path} 引用的 ${missing.join('、')} 不在包里：map 是悬空的。发布的构建不生成 map（tsconfig.base.json）；` +
          '这是旧构建留下的文件时，删掉 dist 重新 pnpm build。',
      );
    }
  }

  // 4. 构建信息
  for (const path of files) {
    if (path.endsWith('.tsbuildinfo')) {
      problems.push(`${path} 不该进包：package.json 的 files 要排除它。`);
    }
  }
  return problems;
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest;
const files = listPackedFiles();
const problems = check(manifest, files);
if (problems.length > 0) {
  for (const problem of problems) {
    // 在 GitHub Actions 里写成错误标注，与 release-check.sh 相同
    console.error(process.env.GITHUB_ACTIONS ? `::error::${problem}` : `不通过：${problem}`);
  }
  process.exit(1);
}
console.log(
  `通过：包里有 ${files.size} 个文件，exports 的 ${Object.keys(manifest.exports ?? {}).length} 个子路径都有 .js 与 .d.ts，没有悬空的 map`,
);
