import { FrameworkError } from './framework.ts';
import { isMessageKey, type MessageArguments, MessageCatalog, tryFormatMessage } from './messages.ts';

/**
 * 原语层自己的消息键
 */
export const PrimitivesMessageKey = Object.freeze({
  /** 读取了未初始化的结果；TypeScript 没有零值，本 SDK 不产生它，只为与宿主共用的目录保留 */
  UninitializedResult: 'primitives.result.uninitialized',
} as const);

/**
 * SDK 自带的默认英文模板：原语层与内核里 SDK 会用到的消息键
 *
 * @remarks
 * 与 spec/conformance/vectors/primitives/kernel-messages.json 逐字相同（RFC-0011「错误码」，模板以 .NET 的 en-US 为准），
 * 含清单读取的 `kernel.manifest.*` 与 `primitives.manifest.*`（RFC-0002 解析规则 2，ADR-0236）
 */
export const builtInTemplates: Readonly<Record<string, string>> = Object.freeze({
  'primitives.result.uninitialized': 'The result is uninitialized: a default value is not a valid result.',
  'kernel.invocation.deadline_exceeded': 'The invocation exceeded its deadline.',
  'kernel.invocation.deadline_before_start': 'The invocation exceeded its deadline before it started.',
  'kernel.invocation.cancelled': 'The invocation was canceled.',
  'kernel.invocation.unhandled_exception': 'An unhandled exception occurred during the invocation.',
  'kernel.operation.unknown': "Operation '{id}' is not registered.",
  'kernel.operation.invalid_payload': "The payload of operation '{id}' is not valid: {reason}",
  'kernel.operation.type_mismatch':
    "Operation '{id}' was invoked with request or response types that do not match its registration.",
  'kernel.operation.no_response': "Operation '{id}' completed without producing a response.",
  'kernel.operation.duplicate': "Operation '{id}' is already registered by '{owner}'.",
  'kernel.operation.registry_full': 'The operation registry has reached its capacity of {capacity}.',
  'kernel.manifest.empty': 'The manifest is empty.',
  'kernel.manifest.file_missing': "Manifest file '{path}' does not exist.",
  'kernel.manifest.invalid': 'The manifest is not valid: {reason}',
  'kernel.manifest.invalid_json': 'The manifest is not valid JSON: {reason}',
  'primitives.manifest.duplicate_bindings':
    "Manifest '{id}' declares the same binding name more than once in 'bindings'.",
  'primitives.manifest.duplicate_provides':
    "Manifest '{id}' declares the same capability ID more than once in 'provides'.",
  'primitives.manifest.duplicate_requires':
    "Manifest '{id}' declares the same capability ID more than once in 'requires'.",
  'primitives.manifest.isolation_not_allowed':
    "Manifest '{id}' is not a plugin and must not declare 'isolation' or 'permissions'.",
  'primitives.manifest.isolation_required': "Plugin manifest '{id}' must declare 'isolation'.",
});

/**
 * 自带模板组成的 en-US 目录：原语层与内核的键
 *
 * @remarks
 * {@link ErrorInfo.message} 在进程默认解析器解析不出时退到已登记的内置模板，再退到描述：内置模板以这份目录的键起头，
 * SDK 的其他模块在加载时登记自己的键（插件运行时的 `plugins.*`）。宿主收到错误后按消息键用自己的目录翻译
 */
export const builtInMessages = new MessageCatalog({ 'en-US': builtInTemplates });

/**
 * 已登记的内置模板的上限：登记只来自 SDK 自己的模块，键数是固定的；有上限是为了登记表不可能无界增长
 *
 * @internal
 */
export const maxBuiltInTemplates = 1024;

/** 已登记的内置 en-US 模板：消息键 → 模板，以原语层与内核的键起头 */
const registered = new Map<string, string>(Object.entries(builtInTemplates));

/**
 * 登记一组内置的 en-US 模板：进程默认解析器解析不出这些键时，{@link ErrorInfo.message} 用它们
 *
 * @remarks
 * SDK 的模块在加载时登记自己的消息键（插件运行时登记 `plugins.*`），原语层不必认识每个模块的键，与 Go SDK 各包的
 * `RegisterDefaultTemplates` 相同。整组先核对再写入，失败时什么也不登记；同一个键再登记同样的模板什么也不做。
 * 登记是模块加载时的副作用，所在的文件要列进 `package.json` 的 `sideEffects`，打包器才不会把它摇掉
 *
 * @param templates - 消息键 → en-US 模板
 * @throws {@link FrameworkError} 键不合文法、模板不是字符串、同一个键已登记了不同的模板，或超过 {@link maxBuiltInTemplates} 时，
 * 码为 `PRIMITIVES_VALIDATION_001`
 *
 * @internal
 */
export function registerBuiltInTemplates(templates: Readonly<Record<string, string>>): void {
  const added = new Map<string, string>();
  for (const [key, template] of Object.entries(templates)) {
    if (!isMessageKey(key)) {
      throw FrameworkError.invalidArgument(`The message key '${key}' of a built-in template is not valid.`);
    }
    if (typeof template !== 'string') {
      throw FrameworkError.invalidArgument(`The built-in template of '${key}' must be a string.`);
    }
    const existing = registered.get(key);
    if (existing === undefined) {
      added.set(key, template);
    } else if (existing !== template) {
      // 两个模块给同一个键写了不同的文案：先加载的那个不能悄悄赢
      throw FrameworkError.invalidArgument(
        `The built-in template of '${key}' is already registered with another text.`,
      );
    }
  }
  if (registered.size + added.size > maxBuiltInTemplates) {
    throw FrameworkError.invalidArgument(
      `The built-in templates have reached their capacity of ${maxBuiltInTemplates}.`,
    );
  }
  for (const [key, template] of added) {
    registered.set(key, template);
  }
}

/**
 * 用已登记的内置 en-US 模板解析消息键；没有登记这个键或占位符缺值时为 `undefined`
 *
 * @internal
 */
export function resolveBuiltInMessage(key: string, args: MessageArguments | undefined): string | undefined {
  const template = registered.get(key);
  return template === undefined ? undefined : tryFormatMessage(template, args, 'en-US');
}
