# @xihan-framework/pipeline

十一阶段执行管道（RFC-0004）：`PipelineBuilder` 的 `use` / `useAt` / `useNamedInstance`、`before` / `after`、`describe` / `dump`、`build`；排序规则与错误码 `KERNEL_PIPELINE_00x` 与 Go SDK、.NET 参考实现一致。中间件与步都返回 `Promise<Result<void>>`。

```ts
import { middleware, PipelineBuilder, Placement } from '@xihan-framework/pipeline';
import { PipelineStage } from '@xihan-framework/primitives';

const builder = new PipelineBuilder().useAt(
  middleware('Audit', async (context, next) => next(context)),
  PipelineStage.Observe,
  Placement.End,
);
builder.dump(); // "observe      Audit\n"
```

说明见仓库 [README](https://github.com/XiHanFun/framework-sdk-typescript#readme)。
