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
  <a href="https://framework.docs.xihanfun.com"><b>Docs</b></a> ·
  <a href="#getting-started"><b>Getting Started</b></a> ·
  <a href="https://github.com/XiHanFun/framework-spec"><b>Specification</b></a> ·
  <a href="https://github.com/XiHanFun/XiHan.Framework"><b>Reference Implementation</b></a>
</p>

<p><b>English</b> | <a href="./README_cn.md">简体中文</a></p>

</div>

The TypeScript implementation of [XiHan Spec](https://github.com/XiHanFun/framework-spec): the primitives layer, manifests, the invocation context, the pipeline and operation contracts; the reference implementation is .NET ([XiHan.Framework](https://github.com/XiHanFun/XiHan.Framework)). The spec is included as a submodule in `spec/`, and conformance is verified against the spec repository's vectors.

## Modules

The whole SDK is a single npm package, `xihan-framework` (the same name as the packages on crates.io and PyPI), with each module imported by subpath (`xihan-framework/operation`); there is no root entry point. It is all ESM, with zero third-party runtime dependencies, using only capabilities built into the language and platform (`AbortSignal`, Web Crypto, `TextDecoder`, `Intl`). Apart from `xihan-framework/manifest/node`, it references no Node-specific modules, so it also works in the browser.

| Subpath | Contents | Spec |
| --- | --- | --- |
| `xihan-framework/primitives` | `ErrorInfo` / error codes, `Result<T>`, `Maybe<T>`, `TypedId<Tag, V>`, `LifecycleState`, `PipelineStage`, `Stability`, Baggage keys, message keys and templates, `MessageCatalog`, `FrameworkError` | RFC-0001, RFC-0010, `conventions/` |
| `xihan-framework/manifest` | The `xihan.manifest.json` model, schema-driven reading, normalized writing and validation, capability declarations and requirement text; reading files is in `xihan-framework/manifest/node` | RFC-0002, `manifest/manifest.schema.json` |
| `xihan-framework/invocation` | `InvocationContext`: cancellation and deadlines (`AbortSignal`), W3C tracing, registered Baggage, a typed item bag; timeouts and cancellation translated to `KERNEL_TIMEOUT_001` / `KERNEL_CANCELLED_001` | RFC-0003 |
| `xihan-framework/pipeline` | The eleven-stage `PipelineBuilder`: `use` / `useAt` / `useNamedInstance`, `before` / `after`, `describe` / `dump`, `build`; ordering rules and error codes `KERNEL_PIPELINE_00x` | RFC-0004 |
| `xihan-framework/operation` | `defineContract`, `OperationRegistry`, `OperationInvoker` running through the full pipeline (XGI: JSON request and response), and the typed entry point `invokeTyped` | RFC-0011 |

## Getting Started

```bash
pnpm add xihan-framework
```

Not yet published to npm; until then, use it from this repository.

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

The JSON encoding of `Result<T>`, `ErrorInfo` and `Maybe<T>` matches the .NET reference implementation (`{"ok":true,"value":…}` / `{"ok":false,"error":{…}}`; a success without a value is `{"ok":true}`). Write with `writeJson`, and restore from text with `Result.parse` / `Result.parseMaybe` / `ErrorInfo.parse` (the `fromJSON` family takes already-parsed values, so it cannot see duplicate members or tell `2` from `2.0`). The JSON text check, wire encoding, template formatting, kernel errors, manifest reading and writing, payload decoding, pipeline ordering, the lifecycle transition table, error codes, Baggage keys and values, `traceparent` and the capability requirement grammar are all verified by `spec/conformance/vectors`.

## Behavior Shared with the Host

The following behavior is fixed by the spec (ADR-0233, ADR-0235, ADR-0236) and is identical across the language SDKs and the .NET host:

- **JSON text** (RFC-0001 "JSON text"): the wire encoding of Result and Error, operation payloads and manifests all pass the shared JSON text check in `readJsonText` first. Syntax follows RFC 8259 (no comments, trailing commas, `NaN`, leading zeros, plus signs or multiple root values; empty text and whitespace-only text are not JSON either, and a leading BOM is a syntax error), nesting is at most 64 levels deep, strings must be valid Unicode (strict UTF-8, with no raw control characters, invalid escapes or lone surrogates), and no level may contain duplicate member names (compared after unescaping, so `"a"` and `"\u0061"` are duplicates). A syntax error takes precedence wherever it occurs, with the position written only as `$`; a duplicate member reports the path of the first duplicate (`$.a[0].b`).
- **Reading and writing Result and Error** (RFC-0001 "Result"): a success without a value is written only as `{"ok":true}`, and reading rejects it if `value` is present, as it does `{}` and `null`; for a success with a value, `value` is required and cannot be `null` (when the value type is Maybe, use `Result.fromJSONMaybe`, where `null` means no value). An Error's `message` is required and non-empty; `messageKey`, `details` and `inner` must be valid when present, and writing them as `null` is invalid; unknown members are ignored. Numbers round-trip by the value model: integers within the 64-bit range are exact (9007199254740993 does not become 9007199254740992), integer-valued floats are written as `2.0`, `-0.0`, `1E+17`, and non-finite floats are written as the strings `"NaN"`, `"Infinity"`, `"-Infinity"`.
- **Templates** (RFC-0010 "Templates"): `{{` / `}}` are escapes; an argument value of `null` writes an empty string and does not count as missing, while `undefined` counts as missing. Values are first mapped to the value model (null, Boolean, string, 64-bit integer, double-precision float, array, object): arrays and objects are written as compact JSON, with object members in UTF-16 code unit order of their names, nested numbers that do not vary by locale, and containers deeper than 64 levels written as `null`. Only specifiers matching `^[DdFfNnXx][0-9]{0,2}$` are recognized (`D`, `F` and `N` are case-insensitive, `X` / `x` sets the case of hexadecimal digits, and the precision is at most two digits and may have leading zeros); `E2`, `G`, `0.00`, `yyyy`, `D100` and anything containing spaces are all treated as no format. `D` and `X` apply only to integers, `X` only to non-negative integers, and `F` and `N` to integers and floats; where a specifier does not apply, no format is used. `F` and `N` round the exact decimal expansion of the value, with ties to even (0.125 with `F2` gives `0.12`, 2.675 gives `2.67`), write all integer digits, and keep the minus sign both for negative numbers that round to zero and for negative zero. Floats in 1e-4 ≤ |x| < 1e17 are written as the shortest round-trip decimal, and outside that range as `1E+17`, `9.9E-05`, `5E-324`; negative zero is written as `-0`, alongside `NaN`, `Infinity` and `-Infinity`. A locale changes only the decimal point and group separator, taken from the spec's fixed table (de-DE, es-ES and pt-BR use `,` and `.`, fr-FR uses `,` and U+202F, ru-RU uses `,` and U+00A0, and all others, as well as no locale, use the invariant culture); locale names are case-insensitive. The decimal point applies to unformatted floats (including the mantissa of exponent forms) and to `F` and `N`; the group separator applies only to `N`. `formatMessage`, `tryFormatMessage` and `formatValue` take a locale, and `MessageCatalog` takes the symbols from the locale it matched. `Describe` arguments are ordered by the ordinal order of their names, independent of locale. Message keys are at most 128 characters long.
- **Kernel errors** (RFC-0011 "Error codes"): codes, message keys, arguments and en-US templates follow `kernel-messages.json`. The SDK ships this set of English templates (`builtInMessages`, plus `kernel.manifest.*` and `primitives.manifest.*` for manifest reading), which `ErrorInfo.message` uses when the process default catalog cannot resolve a key; on receiving an error, the host translates it by key with its own catalog. `kernel.operation.type_mismatch` carries only `id`. Duplicate registration at configuration time and a full registry are thrown as `FrameworkError`, which likewise carries `messageKey` and `details`.
- **Invoker** (RFC-0011 rules 2, 5, 9 and 10): before entering the pipeline, the invoker checks only for an unregistered operation (`KERNEL_NOTFOUND_001`); typed invocations also check the contract (`KERNEL_VALIDATION_002`). The pipeline has three built-in steps with the same names and positions as the .NET kernel's built-in middleware, all placed at the `Beginning` of their stage under the owner `xihan.kernel.core` (`BuiltInStep`, `KernelOwner`) and ordered with other middleware at the same position by the ordinal order of their owners. In the Observe stage, `ObserveMiddleware` translates exceptions thrown by anything ordered after it into `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception` (an abort thrown once the invocation has been aborted is attributed to cancellation), while exceptions thrown by anything ordered before it (in the Ingress stage, or at the Observe stage's `Beginning` with an owner ordered before it, such as the default `app`) propagate unchanged from `invoke` to the caller. In the Resilience stage, `DeadlineMiddleware` returns `KERNEL_TIMEOUT_001` + `kernel.invocation.deadline_before_start` if the deadline has already passed on entry; it does not check cancellation on entry, and attributes what happens along the way as .NET does: an abort thrown downstream becomes a timeout or cancellation result, and a `KERNEL_CANCELLED_001` written as a result after the deadline signal has fired is reported as a timeout. In the Validate stage, `ValidationMiddleware` decodes the payload of raw invocations and is skipped for typed invocations. When the pipeline completes successfully without a response, the result is `KERNEL_UNEXPECTED_001` + `kernel.operation.no_response`. The XGI entry point encodes the response into a payload only after the pipeline finishes, and middleware sees the object before encoding through `findOperationResponse`. Numbers are written by the value model; when non-finite floats (typed values are not written as `null` or strings) or circular references cannot be written, the invocation ends with `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception`, with the FrameworkError placed in `inner`, nothing thrown to the caller and no payload. Cancellation and deadlines are signaled only through `signal` (RFC-0003 rule 1): the invoker does not race the signal or discard the handler's Promise, and if the handler returns a result as usual after the signal fires, the invocation ends with that result.
- **Payload decoding** (RFC-0011 rule 2): a zero-length payload is equivalent to `{}`, while whitespace alone is not JSON. The payload first passes the shared check (a syntax error has `reason` `$`, a duplicate member has its path), then the first problem is reported in text order against the request shape: member names are case-sensitive, unknown members are ignored, numbers are not read from strings, integers reject `1.0` and `1e2` and do not match when out of range, and floats accept integer notation and overflow to infinity; strings, arrays, objects and arbitrary JSON accept `null`, while integers, floats and Booleans do not; a missing required member is reported with the path of its enclosing object when that object ends (`$`, `$.inner`), and a `null` value counts as present. Payload text is compared as JSON values; whitespace, escapes and number notation are not part of the contract. Members of arbitrary JSON type keep the value as read and are written back as an equal JSON value (`1e400` does not become `null` or infinity, integers beyond double precision stay exact, and the difference between `2.0` and `2` is kept).
- **Invocation context** (RFC-0003, conventions/baggage-keys.md): when the value of a registered Baggage key is empty, longer than 256 UTF-16 code units or contains control characters, constructing a context from a set of Baggage (external input) drops that member, while deriving item by item with `withBaggage` throws an argument error; the idempotency key is exempt in both cases. `traceparent` accepts only version `00` and lowercase hexadecimal, all-zero IDs are invalid, an invalid value is treated as absent, sampling looks only at the lowest bit of the flags, only `00` or `01` is written, and a root invocation with no upstream writes `01`.
- **Pipeline** (RFC-0004 ordering rules 7 and 8): both ends of `before` / `after` are middleware names: the instance name for an instance registered by name, or the type name for middleware that has no name and is registered only once (an instance registered by name cannot be referenced by its type name). Duplicate registration, unknown stages, and a constraint subject that is unregistered or ambiguous are reported immediately at registration; a constraint target that is unregistered or ambiguous, cross-stage constraints and cycles are reported during ordering. Error messages are the original English text, word for word identical to .NET; an instance registered by name is written as `TypeName[name]`, and a cycle lists every middleware still blocked, in baseline order.
- **Manifest** (RFC-0002 parsing rule 2 and "Writing"): `readManifest` returns `Result<Manifest>`, always with error code `KERNEL_CAPABILITY_006`, and reports the first problem in this order: JSON text (`kernel.manifest.invalid_json`, with `reason` `$` or the path of the first duplicate) → the literal `null` (`kernel.manifest.empty`) → item-by-item checks against the schema (`kernel.manifest.invalid`, with `reason` the path of the first problem: members in text order, each checked in turn for being outside the schema, `null`, type and value, and once an object's members are checked, missing members reported in `required` order) → cross-field constraints (`primitives.manifest.*`, with `id` as the only argument). Interface versions have no leading zeros and do not exceed 2147483647, and only `requires[].version` may carry a single `^`; middleware names have at least one character, `contributes.health` matches `^[a-z][a-z0-9.-]*$`, and a duplicated contributed permission code is reported at its second occurrence. `readManifestFile` skips a leading UTF-8 BOM, and a missing file is `kernel.manifest.file_missing` (argument `path`); `readManifest` does not skip a BOM in the text it receives. `writeManifest` follows the spec's layout exactly: two-space indentation, LF, no trailing newline, lists always written, default values written out, and strings escaping only the characters that must be escaped. That only Wasm plugins may contribute middleware is checked by the host at discovery, not when the manifest is read.
- **Grammar matching** (RFC-0001 "Grammar matching"): grammars such as message keys, error codes, Baggage keys, manifest and capability IDs, operation IDs and `traceparent` all use whole-string matching, with no exception for a trailing newline. In JavaScript, `$` without the `m` flag matches only the end of the input, and none of this SDK's regular expressions use `m`, so they match whole strings by nature.

## Language Mapping

The spec requires each SDK to document how its language's values map to the value model and how request types are declared (RFC-0010 "Templates", RFC-0011 rule 2).

- **Numbers**: a `number` that is a safe integer (except negative zero) and a `bigint` within the 64-bit range are integers; any other `number` (fractions, negative zero, `NaN`, infinities, values beyond the safe integer range), a `bigint` beyond 64 bits, and `Float64` are double-precision floats. A `number` cannot tell `2` from `2.0`, so a float whose value happens to be an integer is wrapped in `Float64` (`new Float64(2)`; `Number(v)` and arithmetic work as usual).
- **JSON numbers as read**: integer notation (no decimal point or exponent) within the 64-bit range is an integer, read as `number` for safe integers and as `bigint` otherwise, with `-0` read as the integer `0`; everything else is a float, read as `Float64` when the value happens to be a safe integer (`2.0`, `1e2`, `0.0`) and as `number` otherwise (`-0.0` is negative zero). A number whose decimal value would differ from the original text once converted to a numeric value and written back (`1e400`, `1e-400`, integers beyond 64 bits, more significant digits than a double holds) is read as a `JsonNumber` that keeps the original text: it is a float in the value model (`Number(v)` overflows to infinity and underflows to 0) and is written as the original text, so members of arbitrary JSON are written back as an equal JSON value.
- **Writing**: `writeJson` follows the rules of `JSON.stringify` (calling `toJSON` first, and likewise throwing `TypeError` when a value cannot be written), except that numbers follow the value model: integers are written in decimal, floats in text form with `.0` appended to integer values, and `JsonNumber` as its original text (in the default mode, an overflowing one is written as `"Infinity"` by the value model). Non-finite values are written as strings by default (untyped values, such as error details) and cannot be written with `{ nonFinite: 'reject' }` (typed values, such as operation responses). `JSON.stringify` cannot write `bigint`, and it also writes `2.0` as `2` and `NaN` as `null`, so do not use it for wire encoding.
- **Object order**: JavaScript objects move integer-like keys (`"1"`) to the front. Checks that report errors in text order (payloads, manifests) use the `JsonMembers` read by `readJsonText`, which keeps document order; `toJsonValue` converts it into a plain object. A member named `__proto__` is an ordinary member and does not change the prototype.
- **Other values in templates**: strings are used as is; arrays, typed arrays, `Set` and other iterables are arrays; plain objects, `JsonMembers` and `Map` are objects (`Map` keys are written as names in their text form); a nested `undefined` is written as `null`; `Date` is written as `toISOString()`; class instances, symbols and functions are written as `String(value)`. Text produced by the language itself does not carry across languages, so a plugin that needs cross-language formatting converts such values to strings first.
- **Request shapes**: `RequestShape` is the counterpart of .NET serialization metadata. `string()` reads as `string | null` (accepting `null`); `boolean()`, `int32()` (`number`), `int64()` (`bigint`) and `float64()` (`number`) do not accept `null`; `array(item)`, `record(value)`, `object(members)` and `json()` accept `null`. Object members are optional by default and are absent from the result when not given; `RequestShape.required(shape)` declares a required member, which only has to be present, with a `null` value counting as present. `RequestShape.custom(decode)` is the counterpart of a custom converter: the shape check skips it and it converts during construction, and when it throws `RequestDecodeError(path)`, that path is used (built with `JsonPath` downward from the given position). `RequestShapeType<typeof S>` extracts the type a shape reads.
- **Manifest model**: the `Manifest` read by `readManifest` fills in default values (`role`, `activation`, the lists, `requires[].optional`, `bindings[].required`), matching the .NET `Manifest`; `$schema` is not part of the model, and `manifestSchemaUri` is always written. A manifest constructed in code may omit optional members; `writeManifest` reads its output back with `readManifest` to check it, and throws a `FrameworkError` with the same code, key and arguments if it cannot be read back.

## Design

- The spec's `Error` is called `ErrorInfo` here so that it does not shadow the global `Error`; it is not an exception and is never thrown. Recoverable failures are returned through `Result` (including manifests that cannot be read and invalid payloads), while programming errors such as invalid arguments, a manifest constructed in code that cannot be written, or pipeline registration conflicts throw `FrameworkError` (with a `code`, and an English sentence as the message).
- `Result<T>` and `Maybe<T>` are discriminated unions: `if (result.ok) result.value`, `if (maybe.hasValue) maybe.value`. Success values and `Some` values cannot be `null` or `undefined`; a success without a value is `Result<void>` (`Result.success()`).
- Enums are frozen constant objects plus a literal union type of the same name (`PipelineStage.Observe === 'observe'`), and appear as their names in JSON; use functions such as `lifecycleStateOrdinal` when an ordinal is needed.
- `TypedId<'order'>` is a branded type: at run time it is just the underlying string or number, and the tag never goes on the wire.
- `InvocationContext` is immutable, and methods such as `withBaggage` derive a new context. Cancellation and deadlines are a `signal` (`AbortSignal.any` combining the caller's signal with `AbortSignal.timeout`), which can be passed directly to APIs such as `fetch`. Once the deadline signal has fired, a timeout is reported, even if the caller cancels at the same time (RFC-0003 rule 1).
- Middleware, steps, handlers and the invoker all return a `Promise`. Lookups start with `find` and return `undefined` when nothing is found.

## Development

Requires Node 24 and pnpm 11.

```bash
git submodule update --init          # spec/
pnpm install
pnpm check                           # Biome: formatting and static checks
pnpm typecheck                       # tsc -b build, then type-check the tests
pnpm test                            # node:test, running the TypeScript sources directly
```

Tests use Node's built-in `node:test` rather than vitest: it adds no development dependency, Node 24 strips types natively, and the tests self-reference the package by name (`xihan-framework/<module>`), loading the TypeScript sources directly through the custom export condition `xihan-source`, so no build is needed first and the public entry point of each subpath is what gets tested. The sources use only erasable syntax (`erasableSyntaxOnly`) and import each other with the `.ts` extension, rewritten to `.js` at build time. The only development dependencies are `typescript`, `@types/node` and `@biomejs/biome`.

## Status

ADR-0004 makes TypeScript the second SDK after Go. `v0.1.0`: five modules are available: primitives, manifest, invocation context, pipeline and operation. The out-of-process plugin runtime `plugin` (`xihan.plugin.v1`, based on `@grpc/grpc-js`) and the remote provider operation sets (starting with `caching.distributed@1`) are planned and will be implemented in the next round, then verified with the spec repository's black-box runner `xihan-conformance plugin --dir <artifact-dir>`. This SDK does not provide the parts the spec lists as host capabilities that language SDKs may omit: runtime changes to the pipeline (`UseOwned` / `RemoveOwnedBy`), schema validation, response filtering, and restoring the response on idempotent replay (RFC-0004, RFC-0011 rule 10).

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

[Issues](https://github.com/XiHanFun/framework-sdk-typescript/issues) and pull requests are welcome.

1. Start with the README and the relevant RFCs of framework-spec.
2. Open an issue in this repository to claim the module you want to implement; one pull request per module, with vector tests.
3. Changes to public contracts are not made in the SDK repositories: they go through the framework-spec RFC process and are then synced to each SDK.

## License

[MIT](./LICENSE) © 2021-Present XiHanFun and contributors.
