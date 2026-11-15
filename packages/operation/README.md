# @xihan-framework/operation

操作契约与 XGI（RFC-0011）：`defineContract`、`OperationRegistry`（ID 唯一，容量 10000）、经完整管道执行的 `OperationInvoker`（XGI：JSON 请求与响应）与类型化入口 `invokeTyped`。处理器返回 `Promise<Result<Res>>`。

```ts
import { defineContract, Expose, OperationInvoker, OperationRegistry } from '@xihan-framework/operation';
import { Result } from '@xihan-framework/primitives';

const createOrder = defineContract<CreateOrder, OrderCreated>({ id: 'orders.create', expose: [Expose.Http] });
const registry = new OperationRegistry();
registry.add({ contract: createOrder, decode: parseCreateOrder, handler: async (context, request) => Result.ok(create(request)) });
const response = await new OperationInvoker(registry).invoke(context, { id: 'orders.create', payload: '{"quantity":2}' });
```

说明见仓库 [README](https://github.com/XiHanFun/framework-sdk-typescript#readme)。
