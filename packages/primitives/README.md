# @xihan-framework/primitives

XiHan Framework 原语层（RFC-0001、RFC-0010）的 TypeScript 形态：`ErrorInfo` 与错误码、`Result<T>`、`Maybe<T>`、`TypedId`、生命周期状态、管道阶段、稳定性、Baggage 键、消息键与模板、`FrameworkError`。运行时零依赖。

```ts
import { ErrorInfo, Result } from '@xihan-framework/primitives';

const failed: Result<number> = Result.fail(ErrorInfo.validation('ORDERS_VALIDATION_001', 'orders.quantity.invalid', { min: 1 }));
JSON.stringify(failed); // {"ok":false,"error":{"code":"ORDERS_VALIDATION_001",…}}
```

说明见仓库 [README](https://github.com/XiHanFun/framework-sdk-typescript#readme)。
