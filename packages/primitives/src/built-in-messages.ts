import { MessageCatalog } from './messages.ts';

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
 * 与 spec/conformance/vectors/primitives/kernel-messages.json 逐字相同（RFC-0011「错误码」，模板以 .NET 的 en-US 为准）；
 * 清单读取的 `kernel.manifest.*` 与 `primitives.manifest.*` 不在向量里，取自 .NET 内核与原语层的语言文件（RFC-0002 解析规则 2）
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
 * 自带模板组成的 en-US 目录
 *
 * @remarks
 * {@link ErrorInfo.message} 在进程默认解析器解析不出时退到它，再退到描述；宿主收到错误后按消息键用自己的目录翻译
 */
export const builtInMessages = new MessageCatalog({ 'en-US': builtInTemplates });
