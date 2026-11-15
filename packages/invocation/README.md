# @xihan-framework/invocation

调用上下文（RFC-0003）：取消与截止时间（`AbortSignal`）、W3C 追踪、已登记的 Baggage 与类型化对象袋；超时与取消翻译为 `KERNEL_TIMEOUT_001` / `KERNEL_CANCELLED_001`。上下文不可变，`with` 开头的方法派生新的上下文。

```ts
import { InvocationContext } from '@xihan-framework/invocation';
import { BaggageKey } from '@xihan-framework/primitives';

const context = InvocationContext.create({ timeout: 2000, baggage: { [BaggageKey.Tenant]: 't1' } });
await fetch(url, { signal: context.signal });
context.cancellation; // 截止时间到了是 KERNEL_TIMEOUT_001
```

说明见仓库 [README](https://github.com/XiHanFun/framework-sdk-typescript#readme)。
