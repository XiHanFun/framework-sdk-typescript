# @xihan-framework/manifest

`xihan.manifest.json`（RFC-0002）的模型、按 Schema 读取、规范化输出与校验，能力声明与依赖文本。运行时只依赖 `@xihan-framework/primitives`；读取文件在子路径 `@xihan-framework/manifest/node`。

```ts
import { readManifest, writeManifest } from '@xihan-framework/manifest';
import { readManifestFile } from '@xihan-framework/manifest/node';

const manifest = await readManifestFile('xihan.manifest.json');
writeManifest(manifest); // 两空格缩进、字段按 Schema 顺序
```

说明见仓库 [README](https://github.com/XiHanFun/framework-sdk-typescript#readme)。
