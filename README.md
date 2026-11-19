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

The TypeScript implementation of [XiHan Spec](https://github.com/XiHanFun/framework-spec): the primitives layer, manifests, the invocation context, the pipeline, operation contracts and the out-of-process plugin runtime; the reference implementation is .NET ([XiHan.Framework](https://github.com/XiHanFun/XiHan.Framework)). The spec is included as a submodule in `spec/`, and conformance is verified against the spec repository's vectors.

## Modules

The whole SDK is a single npm package, `xihan-framework` (the same name as the packages on crates.io and PyPI), with each module imported by subpath (`xihan-framework/operation`); there is no root entry point. It is all ESM. The five core modules have zero third-party runtime dependencies, using only capabilities built into the language and platform (`AbortSignal`, Web Crypto, `TextDecoder`, `Intl`), and apart from `xihan-framework/manifest/node` they reference no Node-specific modules, so they also work in the browser. The out-of-process plugin runtime `xihan-framework/plugin` is for Node only and depends on `@grpc/grpc-js` and `@bufbuild/protobuf`: they are optional peerDependencies that you install yourself when you write a plugin, and the other subpaths never load them.

| Subpath | Contents | Spec |
| --- | --- | --- |
| `xihan-framework/primitives` | `ErrorInfo` / error codes, `Result<T>`, `Maybe<T>`, `TypedId<Tag, V>`, `LifecycleState`, `PipelineStage`, `Stability`, Baggage keys, message keys and templates, `MessageCatalog`, `FrameworkError` | RFC-0001, RFC-0010, `conventions/` |
| `xihan-framework/manifest` | The `xihan.manifest.json` model, schema-driven reading, normalized writing and validation, capability declarations and requirement text; reading files is in `xihan-framework/manifest/node` | RFC-0002, `manifest/manifest.schema.json` |
| `xihan-framework/invocation` | `InvocationContext`: cancellation and deadlines (`AbortSignal`), W3C tracing, registered Baggage, a typed item bag; timeouts and cancellation translated to `KERNEL_TIMEOUT_001` / `KERNEL_CANCELLED_001` | RFC-0003 |
| `xihan-framework/pipeline` | The eleven-stage `PipelineBuilder`: `use` / `useAt` / `useNamedInstance`, `before` / `after`, `describe` / `dump`, `build`; ordering rules and error codes `KERNEL_PIPELINE_00x` | RFC-0004 |
| `xihan-framework/operation` | `defineContract`, `OperationRegistry`, `OperationInvoker` running through the full pipeline (XGI: JSON request and response), and the typed entry point `invokeTyped` | RFC-0011 |
| `xihan-framework/plugin` | The out-of-process plugin runtime `servePlugin` (protocol `xihan.plugin.v1`): handshake, configuration (typed reading with `ConfigurationSection`), start and stop, health and health push, `Invoke` and event delivery; the host callback client `findHost` (`Host.Invoke`, `Host.Publish`), structured stderr logging with `PluginLogger`, and message catalogs with `loadCatalog`; Node only | RFC-0017, `plugin/` |

## Getting Started

```bash
pnpm add xihan-framework
pnpm add @grpc/grpc-js @bufbuild/protobuf   # only needed to write a plugin
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

### Write a Plugin

A plugin is a child process started by the host: the manifest `xihan.manifest.json`, the launch entry and the plugin code live in the plugin directory, and the host starts the manifest's `entry` with the plugin directory as its working directory. `servePlugin` reads the manifest in the working directory and the environment variables passed by the host, listens on a local endpoint, writes the handshake line to stdout, and then serves until `Stop`, stdin closing or SIGTERM.

```ts
import { defineContract, Expose, OperationRegistry, RequestShape } from 'xihan-framework/operation';
import { findHost, HealthStatus, servePlugin } from 'xihan-framework/plugin';
import { ErrorInfo, LifecycleState, Result } from 'xihan-framework/primitives';

const registry = new OperationRegistry();
registry.add({
  contract: defineContract<{ text: string | null }, { text: string }>({ id: 'echoes.create', expose: [Expose.Http] }),
  request: RequestShape.object({ text: RequestShape.required(RequestShape.string()) }),
  handler: async (context, request) =>
    request?.text
      ? Result.ok({ text: request.text })
      : Result.fail(ErrorInfo.validation('ECHOTS_VALIDATION_002', 'echots.text.missing', { operation: 'echoes.create' })),
});

await servePlugin({
  registry, // Invoke runs through the invoker and the full pipeline; every operation ID must be listed in the manifest's contributes.operations
  subscriptions: [{ topic: 'echo.events', handler: async (context, envelope) => Result.success() }],
  catalogs: [{ name: 'echots', locales: { 'en-US': { 'echots.text.missing': 'The text of {operation} is required.' } } }],
  hooks: {
    // configuration.section is the manifest's contributes.config.section; values.number('retries') etc. read it the IConfiguration way
    configure: (configuration) => Result.success(),
    health: () => ({ state: LifecycleState.Ready, items: [{ name: 'echo', status: HealthStatus.Healthy }] }),
  },
});
// Calling back the host from a handler: await findHost(context)?.invoke(context, 'orders.get', '{"id":"o-1"}')
```

Manifest essentials:

- `kind` is `plugin`, `isolation` is `out-of-process` and `primitives` is `1`; `contributes.pipeline` must not be written (only Wasm plugins can contribute middleware). When the declarations do not match the manifest, `servePlugin` logs one `error` line to stderr and throws before listening, without writing a handshake line.
- `entry` is an executable relative to the plugin directory, and on Windows the host appends `.exe` when it has no extension. A Node plugin uses a launch script: on Unix an executable sh script with a shebang, on Windows a `.cmd` (starting with `@echo off`, so commands are not echoed to stdout). The host passes on only a few environment variables (handshake.md §1), so the script spells out the absolute paths of node and the entry point and does not rely on variables such as `NODE_PATH`.
- Operations go in `contributes.operations`, health items in `contributes.health`, and the configuration section in `contributes.config.section`; calling back the host requires declaring `capability:kernel.pipeline` (`Host.Invoke`) or `capability:messaging.queue` (`Host.Publish`) in `permissions`.
- Write nothing to stdout after the handshake line; log to stderr with `PluginLogger`.

The plugin's own endpoint by platform: on Linux and macOS, a Unix domain socket in a private directory newly created by the process (`mkdtemp`, directory `0700`, socket `0600`, removed after stopping; when the temporary directory's path contains whitespace it moves to `/tmp`, and failing that to loopback TCP, because the address in the handshake line cannot contain whitespace); on Windows, a named pipe `\\.\pipe\xihan-plugin-<random>` (Node has no Unix domain sockets on Windows); with `network: 'tcp'`, only `127.0.0.1` is bound and the handshake line writes `127.0.0.1:<port>`.

Access control of the named pipe (handshake.md §4): Node's libuv provides neither of the two: it can neither give the pipe an access control list nor reject remote clients (it does not set `PIPE_REJECT_REMOTE_CLIENTS`). The pipe therefore uses the default Windows security descriptor: the current user, administrators and SYSTEM can read and write, other users can only open it read-only and cannot send requests, and isolation relies on the session token just as with loopback TCP. If only local connections may be accepted, use loopback TCP instead (`network: 'tcp'`).

The host's callback endpoint (handshake.md §4): `XIHAN_PLUGIN_HOST_ADDRESS` holds one or more endpoints ordered by the host's preference and separated by `;`, the last one always loopback TCP. This SDK takes the first entry that `@grpc/grpc-js` can connect to and never switches: measured on Windows it connects to named pipes and loopback TCP but not to Unix domain sockets, and on other systems to Unix domain sockets and loopback TCP. So on Windows callbacks go over the named pipe when the host offers one, and over loopback TCP when the entries in front are ones this SDK cannot connect to. When the variable is missing, invalid or has no entry it can connect to, the plugin still serves, logs one `warning` to stderr at startup, and every callback fails with `PLUGINS_UNAVAILABLE_001` + `plugins.host.unavailable` (`reason` `no supported callback endpoint`) without sending a request; `findHost` always finds a client in the contexts the plugin runtime hands to handlers.

The contract for streaming operations is not yet defined (RFC-0017 "Non-goals"), so plugins declare only unary operations, and `InvokeStream` ends with `InvalidArgument` or `Unimplemented` after reading the first frame. Time limits for winding down: `Stop` waits for in-flight calls within the grace period the host gives (5 seconds when it is 0); stdin closing and SIGTERM cancel in-flight calls at once and exit with code 0 after at most 3 seconds (lifecycle.md §7.5, §7.7).

Verify with the spec repository's black-box runner (requires Go, run inside the spec submodule):

```bash
cd spec/conformance
go run ./cmd/xihan-conformance plugin --dir <plugin-dir> --config '{"greeting":"hello"}' \
  --sample 'echoes.create={"text":"hi"}' --exclude echoes.crash
```

The complete example is in `examples/echo`: four operations (including `echoes.crash`, which crashes on purpose and is excluded during verification), one subscription, a health item, configuration and a host callback. `test/plugin-conformance.test.ts` puts it in a temporary directory, generates the launch script and runs all 14 cases with the runner.

## Behavior Shared with the Host

The following behavior is fixed by the spec (ADR-0233, ADR-0235, ADR-0236, ADR-0237) and is identical across the language SDKs and the .NET host:

- **JSON text** (RFC-0001 "JSON text"): the wire encoding of Result and Error, operation payloads and manifests all pass the shared JSON text check in `readJsonText` first. Syntax follows RFC 8259 (no comments, trailing commas, `NaN`, leading zeros, plus signs or multiple root values; empty text and whitespace-only text are not JSON either, and a leading BOM is a syntax error), nesting is at most 64 levels deep, strings must be valid Unicode (strict UTF-8, with no raw control characters, invalid escapes or lone surrogates), and no level may contain duplicate member names (compared after unescaping, so `"a"` and `"\u0061"` are duplicates). A syntax error takes precedence wherever it occurs, with the position written only as `$`; a duplicate member reports the path of the first duplicate (`$.a[0].b`).
- **Reading and writing Result and Error** (RFC-0001 "Result"): a success without a value is written only as `{"ok":true}`, and reading rejects it if `value` is present, as it does `{}` and `null`; for a success with a value, `value` is required and cannot be `null` (when the value type is Maybe, use `Result.fromJSONMaybe`, where `null` means no value). An Error's `message` is required and must contain a character other than whitespace, so empty and whitespace-only messages are invalid; whitespace is the 25 code points fixed by RFC-0001 "Whitespace", not JavaScript's `\s` or `trim`, which lack U+0085 but include U+FEFF. `ErrorInfo.literal` and `withText` likewise throw `FrameworkError` for empty or whitespace-only text. `messageKey`, `details` and `inner` must be valid when present, and writing them as `null` is invalid; unknown members are ignored. Numbers round-trip by the value model: integers within the 64-bit range are exact (9007199254740993 does not become 9007199254740992), integer-valued floats are written as `2.0`, `-0.0`, `1E+17`, and non-finite floats are written as the strings `"NaN"`, `"Infinity"`, `"-Infinity"`.
- **Templates** (RFC-0010 "Templates"): `{{` / `}}` are escapes; an argument value of `null` writes an empty string and does not count as missing, while `undefined` counts as missing. Values are first mapped to the value model (null, Boolean, string, 64-bit integer, double-precision float, array, object): arrays and objects are written as compact JSON, with object members in UTF-16 code unit order of their names, nested numbers that do not vary by locale, and containers deeper than 64 levels written as `null`. Only specifiers matching `^[DdFfNnXx][0-9]{0,2}$` are recognized (`D`, `F` and `N` are case-insensitive, `X` / `x` sets the case of hexadecimal digits, and the precision is at most two digits and may have leading zeros); `E2`, `G`, `0.00`, `yyyy`, `D100` and anything containing spaces are all treated as no format. `D` and `X` apply only to integers, `X` only to non-negative integers, and `F` and `N` to integers and floats; where a specifier does not apply, no format is used. `F` and `N` round the exact decimal expansion of the value, with ties to even (0.125 with `F2` gives `0.12`, 2.675 gives `2.67`), write all integer digits, and keep the minus sign both for negative numbers that round to zero and for negative zero. Floats in 1e-4 ≤ |x| < 1e17 are written as the shortest round-trip decimal, and outside that range as `1E+17`, `9.9E-05`, `5E-324`; negative zero is written as `-0`, alongside `NaN`, `Infinity` and `-Infinity`. A locale changes only the decimal point and group separator, taken from the spec's fixed table (de-DE, es-ES and pt-BR use `,` and `.`, fr-FR uses `,` and U+202F, ru-RU uses `,` and U+00A0, and all others, as well as no locale, use the invariant culture); locale names are case-insensitive. The decimal point applies to unformatted floats (including the mantissa of exponent forms) and to `F` and `N`; the group separator applies only to `N`. `formatMessage`, `tryFormatMessage` and `formatValue` take a locale, and `MessageCatalog` takes the symbols from the locale it matched. `Describe` arguments are ordered by the ordinal order of their names, independent of locale. Message keys are at most 128 characters long.
- **Kernel errors** (RFC-0011 "Error codes"): codes, message keys, arguments and en-US templates follow `kernel-messages.json`. The SDK ships this set of English templates (`builtInMessages`, plus `kernel.manifest.*` and `primitives.manifest.*` for manifest reading), which `ErrorInfo.message` uses when the process default catalog cannot resolve a key; on receiving an error, the host translates it by key with its own catalog. `kernel.operation.type_mismatch` carries only `id`. Duplicate registration at configuration time and a full registry are thrown as `FrameworkError`, which likewise carries `messageKey` and `details`.
- **Invoker** (RFC-0011 rules 2, 5, 9 and 10): before entering the pipeline, the invoker checks only for an unregistered operation (`KERNEL_NOTFOUND_001`); typed invocations also check the contract (`KERNEL_VALIDATION_002`). The pipeline has three built-in steps with the same names and positions as the .NET kernel's built-in middleware, all placed at the `Beginning` of their stage under the owner `xihan.kernel.core` (`BuiltInStep`, `KernelOwner`) and ordered with other middleware at the same position by the ordinal order of their owners. In the Observe stage, `ObserveMiddleware` translates exceptions thrown by anything ordered after it into `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception` (an abort thrown once the invocation has been aborted is attributed to cancellation), while exceptions thrown by anything ordered before it (in the Ingress stage, or at the Observe stage's `Beginning` with an owner ordered before it, such as the default `app`) propagate unchanged from `invoke` to the caller. In the Resilience stage, `DeadlineMiddleware` returns `KERNEL_TIMEOUT_001` + `kernel.invocation.deadline_before_start` if the deadline has already passed on entry; it does not check cancellation on entry, and attributes what happens along the way as .NET does: an abort thrown downstream becomes a timeout or cancellation result, and a `KERNEL_CANCELLED_001` written as a result after the deadline signal has fired is reported as a timeout. In the Validate stage, `ValidationMiddleware` decodes the payload of raw invocations and is skipped for typed invocations. When the pipeline completes successfully without a response, the result is `KERNEL_UNEXPECTED_001` + `kernel.operation.no_response`. The XGI entry point encodes the response into a payload only after the pipeline finishes, and middleware sees the object before encoding through `findOperationResponse`. Numbers are written by the value model; when non-finite floats (typed values are not written as `null` or strings) or circular references cannot be written, the invocation ends with `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception`, with the FrameworkError placed in `inner`, nothing thrown to the caller and no payload. Cancellation and deadlines are signaled only through `signal` (RFC-0003 rule 1): the invoker does not race the signal or discard the handler's Promise, and if the handler returns a result as usual after the signal fires, the invocation ends with that result.
- **Payload decoding** (RFC-0011 rule 2): a zero-length payload is equivalent to `{}`, while whitespace alone is not JSON. The payload first passes the shared check (a syntax error has `reason` `$`, a duplicate member has its path), then the first problem is reported in text order against the request shape: member names are case-sensitive, unknown members are ignored, numbers are not read from strings, integers reject `1.0` and `1e2` and do not match when out of range, and floats accept integer notation and overflow to infinity; strings, arrays, objects and arbitrary JSON accept `null`, while integers, floats and Booleans do not; a missing required member is reported with the path of its enclosing object when that object ends (`$`, `$.inner`), and a `null` value counts as present. Payload text is compared as JSON values; whitespace, escapes and number notation are not part of the contract. Members of arbitrary JSON type keep the value as read and are written back as an equal JSON value (`1e400` does not become `null` or infinity, integers beyond double precision stay exact, and the difference between `2.0` and `2` is kept).
- **Invocation context** (RFC-0003, conventions/baggage-keys.md): when the value of a registered Baggage key is empty, longer than 256 UTF-16 code units or contains control characters, constructing a context from a set of Baggage (external input) drops that member, while deriving item by item with `withBaggage` throws an argument error; the idempotency key is exempt in both cases. `traceparent` accepts only version `00` and lowercase hexadecimal, all-zero IDs are invalid, an invalid value is treated as absent, sampling looks only at the lowest bit of the flags, only `00` or `01` is written, and a root invocation with no upstream writes `01`.
- **Pipeline** (RFC-0004 ordering rules 7 and 8): both ends of `before` / `after` are middleware names: the instance name for an instance registered by name, or the type name for middleware that has no name and is registered only once (an instance registered by name cannot be referenced by its type name). Duplicate registration, unknown stages, and a constraint subject that is unregistered or ambiguous are reported immediately at registration; a constraint target that is unregistered or ambiguous, cross-stage constraints and cycles are reported during ordering. Error messages are the original English text, word for word identical to .NET; an instance registered by name is written as `TypeName[name]`, and a cycle lists every middleware still blocked, in baseline order.
- **Manifest** (RFC-0002 parsing rule 2 and "Writing"): `readManifest` returns `Result<Manifest>`, always with error code `KERNEL_CAPABILITY_006`, and reports the first problem in this order: JSON text (`kernel.manifest.invalid_json`, with `reason` `$` or the path of the first duplicate) → the literal `null` (`kernel.manifest.empty`) → item-by-item checks against the schema (`kernel.manifest.invalid`, with `reason` the path of the first problem: members in text order, each checked in turn for being outside the schema, `null`, type and value, and once an object's members are checked, missing members reported in `required` order) → cross-field constraints (`primitives.manifest.*`, with `id` as the only argument). Interface versions have no leading zeros and do not exceed 2147483647, and only `requires[].version` may carry a single `^`; middleware names have at least one character, `contributes.health` matches `^[a-z][a-z0-9.-]*$`, and a duplicated contributed permission code is reported at its second occurrence. `readManifestFile` skips a leading UTF-8 BOM, and a missing file is `kernel.manifest.file_missing` (argument `path`); `readManifest` does not skip a BOM in the text it receives. `writeManifest` follows the spec's layout exactly: two-space indentation, LF, no trailing newline, lists always written, default values written out, and strings escaping only the characters that must be escaped. That only Wasm plugins may contribute middleware is checked by the host at discovery, not when the manifest is read.
- **Grammar matching** (RFC-0001 "Grammar matching"): grammars such as message keys, error codes, Baggage keys, manifest and capability IDs, operation IDs and `traceparent` all use whole-string matching, with no exception for a trailing newline. In JavaScript, `$` without the `m` flag matches only the end of the input, and none of this SDK's regular expressions use `m`, so they match whole strings by nature.
- **Plugin protocol** (RFC-0017, `plugin/`, ADR-0237):
  - Session token: every RPC (including Handshake and streaming calls) first checks the metadata `xihan-plugin-session` in constant time; a missing token, a mismatch or more than one value (even if one of them is right) ends the call with `Unauthenticated` without running it. The token is checked before anything else, including reading the first frame of a streaming call and the call order check (handshake.md §4, ADR-0202).
  - Startup: before listening and writing the handshake line, the manifest and the declarations are checked (handshake.md §1): `kind` is `plugin`, `isolation` is `out-of-process`, there is no `contributes.pipeline`, `primitives` equals this SDK's primitives major version `1`, every operation is in `contributes.operations` (the registry itself rejects duplicate IDs), subscription topics match the grammar, modes are empty, `competing` or `broadcast` and no (topic, type) pair repeats, and each catalog has `en-US`. Otherwise one `error` log line goes to stderr and `FrameworkError` is thrown, without listening or writing a handshake line. Health items come from the health hook at run time; those outside the manifest's `contributes.health` are dropped when reported (see below).
  - Handshake line and endpoints (handshake.md §2): whitespace in an address is RFC-0001 "Whitespace", the set of .NET's regex `\s` (U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000; JavaScript's `\s` lacks U+0085 but includes U+FEFF, so code units are compared one by one), and every other character (including non-ASCII paths) may appear in an address; `tcp` accepts only four-part dotted decimal in `127.0.0.0/8` without leading zeros, or `[::1]`, with a port 1–65535 without sign or leading zeros. Addresses this SDK generates contain no whitespace, and `tcp` is always written as `127.0.0.1:<port>`. `parseHandshakeLine`, `parseEndpoint`, `parseHostAddresses` and `selectHostEndpoint` replay `handshake-lines.json` and `host-addresses.json`.
  - Handshake (handshake.md §3): the highest version in the host's list that both sides support is selected, `FailedPrecondition` when there is none; `primitives` is the manifest's value, `manifest` is the manifest text without a leading BOM, only unary operations are declared (with their schemas), subscriptions are written in declaration order with `mode` always `competing` or `broadcast`, and `catalogs` holds only the author's catalogs: the runtime's own `plugins.*` keys are provided by the host and not sent with the handshake.
  - Call order (lifecycle.md §7.1): `Handshake` is accepted only in Declared, `Configure` only in Resolved and `Start` only in Configured; `Stop` is refused in Declared, Draining and Stopped and once a `Stop` has been accepted. Anything not in the table is refused with `FailedPrecondition`, does nothing and leaves the state unchanged. `Health`, `WatchHealth`, `Invoke`, `InvokeStream` and `HandleEvent` are accepted in any state.
  - Configuration (§7.2): an empty `configuration` equals `{}`; text that fails the shared JSON reading check or is not an object fails with `PLUGINS_UNEXPECTED_001` + `plugins.process.failed` (`phase` `configure`, `reason` `the configuration is not a JSON object`) without calling the configure hook, and the plugin enters Failed. `PluginConfiguration.section` is the section as is, and `values` is the typed reader `ConfigurationSection`: member names match ASCII case-insensitively, `number` reads string leaves by the JSON number grammar, `boolean` accepts only `true` and `false` (ASCII case-insensitive), and a value that cannot be read is `undefined`. A failure returned by the configure hook enters Failed with that error.
  - Start and readiness (§7.3): once the start hook succeeds the plugin enters Started; with a health hook it asks it once right away and enters Ready, Degraded or Failed by the result (any other reported state counts as Ready, a throw as Degraded), without one it enters Ready; only then is Start answered. Only Ready and Degraded serve: calls and deliveries in any other state get `PLUGINS_UNAVAILABLE_001` + `plugins.process.unavailable` (`state` is the state name, such as `Configured`, `Draining` or `Failed`).
  - Health (§7.4): before Start the local state (Declared, Resolved, Configured) is reported with no health items and the hook is not called; while serving, every `Health` asks the health hook once, and only the Ready, Degraded and Failed it reports change the state (Failed never comes back, and the hook is no longer called); health items outside the manifest are dropped with one `warning` per name; when the hook throws, that result is Degraded with `error` `plugins.process.failed` (`phase` `health`) and no health items, the state also moves to Degraded, and later results decide the state as usual. `WatchHealth` pushes the current state first, pushes again when the state, the health items or the error change, asks the hook again every 10 seconds while serving (`healthInterval`), pushes once on entering Draining, and ends the stream after `Stop` is answered.
  - Stop (§7.5): if the start hook never succeeded (Resolved, Configured, or Failed before that), the stop hook is not called and `ok` is answered; Started, Ready and Degraded enter Draining, reject new calls and wait for in-flight calls up to the grace period (`grace_seconds` 0 means 5 seconds), then trigger the cancellation signals of the calls still running without waiting further, call the stop hook (with `reason` as given), answer and enter Stopped; a plugin that entered Failed after a successful start keeps its state and still gets the stop hook. The stop hook is called at most once per process; a failure it returns or throws goes into `StopResponse.status`, and the process exits with code 0 either way.
  - Winding down (§7.7): reaching the end of stdin (or a read error) and SIGTERM are both shutdown requests: a serving plugin enters Draining, the cancellation signals of all in-flight calls are triggered at once and the runtime waits for them, and if the start hook succeeded and the stop hook has not been called it is called once (`reason` `shutdown`); at most 3 seconds after the request the process exits with code 0 whether or not this has finished, and a `Stop` in progress is held to the same 3 seconds. After winding down the runtime leaves no handles of its own; if the author's code still keeps the process alive, it exits with code 0 after 1 second. Tests that run a plugin in their own process catch that through the `exit` option.
  - `reason` of a throwing hook (§7.6): when a lifecycle or health hook throws, the error carries no exception text (the text only goes to the stderr log); `reason` is the simple type name of the exception: the constructor's name (`TypeError`, the author's own exception class), the wrapper type name for a thrown primitive (`String`, `Number`), and `null` or `undefined` as such.
  - `Invoke` (invocation.md §1): after the session token, an operation not in the handshake declarations ends with gRPC `Unimplemented`, a plugin that does not serve answers `plugins.process.unavailable`, then the context is restored per §2 and the call runs through the invoker and the full pipeline; an empty payload equals `{}`. `InvokeStream` reads the first frame: a stream that ends before it, or a first frame that is not `start`, ends with `InvalidArgument`, and a `start` ends with `Unimplemented`, whether or not the operation is declared or the plugin is ready; this SDK provides no API for streaming operations.
  - Invocation context (invocation.md §2): `trace_parent` is taken by the RFC-0003 grammar, and an invalid value means no parent span; `trace_state` does not enter the context and is written empty on callbacks; only registered Baggage keys are kept, with `xihan.principal` passed to the author as is; `deadline` is read by the strict grammar (years 0001–9999, Gregorian month days, no leap second, within range after conversion to UTC), an unreadable value counts as absent, and the effective deadline is the earlier of it and the gRPC deadline. JavaScript's clock resolution is milliseconds, so digits after the third are truncated, not rounded. Callbacks write `deadline` in UTC with seven fractional digits and `+00:00` (zeros after the milliseconds), and the gRPC deadline of the call equals it. `deadlines.json` is replayed.
  - Writing and reading Error (invocation.md §3): an error with a message key is written with an empty `text` so that the host translates it into the caller's language, and a text the author set with `withText` is not written either; only a free-text error (`ErrorInfo.literal`) writes `text`; `details` is the JSON object text written by the value model, empty when there are none; `inner` is written as well. An error written by the host is read as follows: an invalid code replaces the whole error with `plugins.process.failed` (`phase` `invoke`, `reason` `invalid error code '<code>'`); a valid key is restored by key without keeping the host's text, otherwise it is a free-text error (`text`, or the code when it is empty or only whitespace); with an invalid code `phase` is always `invoke` (results of `Host.Publish` too) and the original `inner` is dropped; `details` that are empty, only whitespace, the empty object `{}`, fail the shared JSON reading check, are not an object, or hold at any depth a number that overflows a double (±∞) count as absent, while a number that underflows reads as 0 and an integer beyond 64 bits reads as a double (still written back as a float), and `inner` likewise; `ok` false without `error`, or a missing `status` altogether, is `plugins.process.failed` (`phase` the operation ID or `publish`, `reason` `the host reported a failure without an error`). `error-reading.json` is replayed.
  - `HandleEvent` (invocation.md §4): session token → no envelope, or a mode other than empty, `competing` or `broadcast`, is gRPC `InvalidArgument` → subscriptions are looked up by (topic, mode, type), and none at all is `KERNEL_NOTFOUND_001` + `plugins.event.unsubscribed` (`id`, `topic`, `type`, `mode`, with an empty mode written as `competing`), never handed to a handler of the other mode → a plugin that does not serve answers `plugins.process.unavailable` → the context is restored and the matching subscriptions run one after another in declaration order, the first failure ending the delivery as its result; a throwing handler is `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception` (an abort thrown after the call was aborted is attributed to cancellation, and a FrameworkError's error goes into `inner`).
  - Callbacks (invocation.md §5): before sending, `Host.Invoke` and `Host.Publish` check locally in the host's order and send nothing on failure: the required permission (`capability:kernel.pipeline`, `capability:messaging.queue`) must be both in the manifest's `permissions` and in Configure's `granted_permissions`, otherwise `PLUGINS_DENIED_002` + `plugins.callback.denied`; the context's `xihan.tenant` must be the tenant of a call or delivery the plugin is handling right now (a background callback after the call has ended does not qualify), otherwise `plugins.callback.tenant_denied` (ADR-0195); last, nothing is sent either when the callback context's deadline has passed or it has been cancelled, with the same result as the matching row of the mapping table (a passed deadline as `DeadlineExceeded`, a cancellation as "`Cancelled`, cancellation signal triggered"). Whether an endpoint is available comes before all of these. `Host.Publish` is a batch: these two checks, a missing endpoint and an RPC failure are results for the whole batch (the same error for every item), while an envelope's `xihantenant` is not checked locally but left to the host item by item; when the number of results differs from the number of envelopes every item is `plugins.process.failed` (`phase` `publish`). The metadata comes from the surrounding invocation context (the traceparent the context writes by RFC-0003, the same way as for other carriers; the deadline, registered Baggage, an empty `trace_state`) along with the session token. gRPC statuses are mapped only by the table in §5, without rewriting results by the clock or the signal (replaying `callback-status.json`): a context reaching its deadline is left to the gRPC deadline, which reports `DeadlineExceeded`, and a callback is cancelled only when the caller cancels; `Unauthenticated` is `plugins.callback.session_invalid`, `PermissionDenied` is `plugins.callback.denied`, `DeadlineExceeded` is `KERNEL_TIMEOUT_001`, `Cancelled` after the caller cancelled is `KERNEL_CANCELLED_001`, `Cancelled` without cancellation, `Unavailable` and connection failures are `PLUGINS_UNAVAILABLE_001` + `plugins.host.unavailable` (`reason` `<status name>: <message>`), `Unimplemented` and `InvalidArgument` of `Host.Invoke` are `kernel.operation.unknown` and `kernel.operation.invalid_payload`, and everything else is `plugins.process.failed` (`phase` the operation ID or `publish`).
  - Logs and message keys: logs go to stderr, one JSON object per line: `level` (`trace` / `debug` / `information` / `warning` / `error` / `critical`), `message`, and the remaining members as scope properties (invocation.md §6). The runtime uses only the spec's seven message keys (invocation.md §8: `plugins.process.unavailable`, `plugins.process.failed`, `plugins.event.unsubscribed`, `plugins.host.unavailable`, `plugins.callback.denied`, `plugins.callback.tenant_denied`, `plugins.callback.session_invalid`), and `details` are exactly the template arguments with no extra members; the catalog `pluginMessages` carries the reference implementation's 10 locales, used only for local rendering and logs on the plugin side, and replays `plugin-messages.json`.

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
- The plugin protocol code is generated by ts-proto from `spec/plugin/plugin.proto` into `src/plugin/gen`: messages are encoded and decoded with the wire runtime of `@bufbuild/protobuf`, service definitions go straight to `@grpc/grpc-js`, and enums are generated as frozen constant objects, so Node still strips the types and runs it directly. The generated code is not a public entry point, and the types of `xihan-framework/plugin` (`Envelope`, `PluginHealth`, `PluginConfiguration` and so on) do not expose protobuf types. Lifecycle hooks and event handlers return a `Result`; the text of an exception they throw only goes to the log, never on the wire: lifecycle and health hooks return `plugins.process.failed` (with the simple type name as `reason`), and event handlers return an unhandled exception.

## Development

Requires Node 24 and pnpm 11; the plugin conformance test also needs Go (version in `spec/conformance/go.mod`) and fails without it; to skip it on purpose, set `XIHAN_CONFORMANCE_REQUIRED=0`.

```bash
git submodule update --init          # spec/
pnpm install
pnpm check                           # Biome: formatting and static checks
pnpm typecheck                       # tsc -b build, then type-check the tests
pnpm test                            # node:test, running the TypeScript sources directly
pnpm generate                        # regenerate src/plugin/gen from spec/plugin/plugin.proto (buf + ts-proto)
```

Tests use Node's built-in `node:test` rather than vitest: it adds no development dependency, Node 24 strips types natively, and the tests self-reference the package by name (`xihan-framework/<module>`), loading the TypeScript sources directly through the custom export condition `xihan-source`, so no build is needed first and the public entry point of each subpath is what gets tested. The sources use only erasable syntax (`erasableSyntaxOnly`) and import each other with the `.ts` extension, rewritten to `.js` at build time. The development dependencies are `typescript`, `@types/node`, `@biomejs/biome`, the plugin runtime's `@grpc/grpc-js` and `@bufbuild/protobuf` (also optional peerDependencies), and `@bufbuild/buf` and `ts-proto` for generating the protocol code; the generated code skips Biome (`biome.json` excludes `src/plugin/gen`) but is type-checked as usual, and CI regenerates it and checks that it matches what is committed. `test/plugin-conformance.test.ts` runs `go run ./cmd/xihan-conformance` in `spec/conformance`, and the runner's Go dependencies are downloaded through `GOPROXY`. `test/conformance-vectors.test.ts` checks the vectors against the profiles this SDK claims in `spec/conformance/profiles.json` (RFC-0024): when the spec adds a vector to a claimed profile it fails until the vector is replayed or listed as a gap with a reason.

## Status

ADR-0004 makes TypeScript the second SDK after Go. `v0.1.0`: five modules are available: primitives, manifest, invocation context, pipeline and operation; the out-of-process plugin runtime `plugin` (`xihan.plugin.v1`, based on `@grpc/grpc-js`) is available, and the example plugin echo passes all 14 cases of the spec repository's black-box runner `xihan-conformance plugin` (on Windows and Linux). The contract for streaming operations is not yet defined (RFC-0017 "Non-goals"), so this SDK does not implement streaming calls, and `InvokeStream` ends with `InvalidArgument` or `Unimplemented` after reading the first frame. The remote provider operation sets (such as `caching.distributed@1`) are still not provided. This SDK does not provide the parts the spec lists as host capabilities that language SDKs may omit: runtime changes to the pipeline (`UseOwned` / `RemoveOwnedBy`), schema validation, response filtering, and restoring the response on idempotent replay (RFC-0004, RFC-0011 rule 10).

Conformance (RFC-0024):

- Pinned spec version: commit `93d75d7` (the spec has no tags yet; the first is planned as `v1.0.0-rc.1`).
- Claimed profiles: `core` and `plugin`.
- Gaps: none.

Until there is a release pinned to a spec tag, the maturity is Experimental.

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
