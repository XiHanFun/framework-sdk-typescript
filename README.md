<div align="center">

<h1>XiHan Framework SDK for TypeScript</h1>

<h3>The same primitives, manifests and pipeline as the .NET host, verified by shared conformance vectors</h3>

<p>
  <a href="https://github.com/XiHanFun/framework-sdk-typescript/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/XiHanFun/framework-sdk-typescript/ci.yml?branch=main&style=flat-square&label=CI" /></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" />
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/XiHanFun/framework-sdk-typescript?style=flat-square&color=green" /></a>
  <a href="https://github.com/XiHanFun/framework-sdk-typescript/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/XiHanFun/framework-sdk-typescript?style=flat-square&logo=github&label=Stars&color=1f6feb" /></a>
</p>

<p>
  <a href="https://framework.docs.xihanfun.com/sdks/typescript"><b>Docs</b></a> ·
  <a href="#quick-start"><b>Quick Start</b></a> ·
  <a href="https://github.com/XiHanFun/framework-spec"><b>Specification</b></a> ·
  <a href="https://github.com/XiHanFun/XiHan.Framework"><b>Reference Implementation</b></a>
</p>

<p><b>English</b> | <a href="./README_cn.md">简体中文</a></p>

</div>

The TypeScript implementation of [XiHan Spec](https://github.com/XiHanFun/framework-spec): the primitives layer, manifests, the invocation context, the pipeline, operation contracts and the out-of-process plugin runtime; the reference implementation is .NET ([XiHan.Framework](https://github.com/XiHanFun/XiHan.Framework)). The spec is included as a submodule in `spec/`, and conformance is verified against the spec repository's vectors.

## Modules

The whole SDK is a single ESM package, `xihan-framework`, with each module imported by subpath and no root entry point. The five core modules have zero third-party runtime dependencies; the plugin runtime is for Node only.

| Subpath | Contents |
| --- | --- |
| `xihan-framework/primitives` | Errors and error codes, `Result<T>`, `Maybe<T>`, typed IDs, lifecycle states, pipeline stages, Baggage keys, message keys, templates and catalogs |
| `xihan-framework/manifest` | Reading, writing and validating `xihan.manifest.json`; reading files is in `xihan-framework/manifest/node` |
| `xihan-framework/invocation` | `InvocationContext`: cancellation and deadlines, W3C tracing and registered Baggage |
| `xihan-framework/pipeline` | The eleven-stage `PipelineBuilder` and its ordering rules |
| `xihan-framework/operation` | Operation contracts, the registry and the invoker running through the full pipeline |
| `xihan-framework/plugin` | The out-of-process plugin runtime `servePlugin` and the host callback client |

## Install

```bash
pnpm add xihan-framework
```

Writing a plugin also needs the optional peer dependencies: `pnpm add @grpc/grpc-js @bufbuild/protobuf`. Only prereleases are published so far, and the public API may still change before the first stable release; versions are listed under [Releases](https://github.com/XiHanFun/framework-sdk-typescript/releases).

## Quick Start

```ts
import { InvocationContext } from 'xihan-framework/invocation';
import {
  defineContract,
  Expose,
  OperationInvoker,
  OperationRegistry,
  RequestShape,
  type RequestShapeType,
} from 'xihan-framework/operation';
import { middleware, PipelineBuilder, Placement } from 'xihan-framework/pipeline';
import { BaggageKey, ErrorInfo, PipelineStage, Result, writeJson } from 'xihan-framework/primitives';

// The request shape: the invoker checks the payload against it in text order and builds the request (RFC-0011 rule 2)
const CreateOrder = RequestShape.object({ quantity: RequestShape.required(RequestShape.int32()) });
type CreateOrder = NonNullable<RequestShapeType<typeof CreateOrder>>; // { quantity: number }
interface OrderCreated { readonly id: string; readonly quantity: number }

// The contract carries the request and response types; at run time it holds only the ID, stability, exposed protocols and authorization requirements
const createOrder = defineContract<CreateOrder, OrderCreated>({ id: 'orders.create', expose: [Expose.Http] });

const registry = new OperationRegistry();
registry.add({
  contract: createOrder,
  request: CreateOrder,
  handler: async (context, request) =>
    request.quantity > 0
      ? Result.ok({ id: `o-${context.tenant}`, quantity: request.quantity })
      : Result.fail(ErrorInfo.validation('ORDERS_VALIDATION_001', 'orders.quantity.invalid', { min: 1 })),
});

const builder = new PipelineBuilder().useAt(
  middleware('Audit', async (context, next) => next(context)),
  PipelineStage.Observe,
  Placement.End,
);
const invoker = new OperationInvoker(registry, builder);

const context = InvocationContext.create({ timeout: 2000, baggage: { [BaggageKey.Tenant]: 't1' } });
const response = await invoker.invoke(context, { id: 'orders.create', payload: '{"quantity":2}' });
// response.outcome.ok === true, response.payload === '{"id":"o-t1","quantity":2}'
const typed = await invoker.invokeTyped(context, createOrder, { quantity: 3 }); // Result<OrderCreated>
const wire = writeJson(typed); // Wire encoding: numbers are written by the value model, not with JSON.stringify
```

## Documentation

The documentation site is in Chinese.

| Where | Contents |
| --- | --- |
| [TypeScript SDK](https://framework.docs.xihanfun.com/sdks/typescript) | Modules, examples, writing a plugin, behavior shared with the host, language mapping, design, conformance, breaking changes and migration |
| [Out-of-process plugins](https://framework.docs.xihanfun.com/plugins/out-of-process) | The plugin protocol `xihan.plugin.v1` and how the .NET host runs plugins |
| [Specification and languages](https://framework.docs.xihanfun.com/appendix/spec) | How the spec is organized, conformance profiles and the language SDKs |
| [XiHan Spec](https://github.com/XiHanFun/framework-spec) | RFCs, vocabulary, protocol mappings, conformance vectors and the black-box runner |

## Status

The maturity is Experimental: there is a prerelease pinned to a spec rc tag, and Stable also needs a release pinned to a formal spec tag. Claimed conformance profiles: `core` and `plugin` (RFC-0024); gaps: none; pinned spec version: the commit the `spec/` submodule points to. Streaming operations, the Wasm carrier and the plugin side of remote Providers are not provided yet. Details are on the [documentation page](https://framework.docs.xihanfun.com/sdks/typescript).

## Ecosystem

| Project | Description |
| --- | --- |
| [framework-spec](https://github.com/XiHanFun/framework-spec) | XiHan Spec: RFCs, vocabulary, protocol mappings and conformance vectors |
| [XiHan.Framework](https://github.com/XiHanFun/XiHan.Framework) | The .NET reference implementation |
| [framework-sdk-go](https://github.com/XiHanFun/framework-sdk-go) | Go SDK |
| [framework-sdk-rust](https://github.com/XiHanFun/framework-sdk-rust) | Rust SDK |
| [framework-sdk-java](https://github.com/XiHanFun/framework-sdk-java) | Java SDK |
| [framework-sdk-python](https://github.com/XiHanFun/framework-sdk-python) | Python SDK |
| [framework-sdk-php](https://github.com/XiHanFun/framework-sdk-php) | PHP SDK |

## Contributing

[Issues](https://github.com/XiHanFun/framework-sdk-typescript/issues) and pull requests are welcome. Changes to public contracts go through the framework-spec RFC process first and are then synced to each SDK. Development conventions, gates and the release process are in [AGENTS.md](./AGENTS.md).

## License

[MIT](./LICENSE) © 2021-Present XiHanFun and contributors.
