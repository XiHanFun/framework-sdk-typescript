import {
  ErrorCode,
  ErrorInfo,
  FrameworkError,
  isPipelineStage,
  JsonMembers,
  type JsonNode,
  JsonPath,
  type PipelineStage,
  quoteJsonString,
  Result,
  readJsonText,
  type Stability,
  stabilities,
} from '@xihan-framework/primitives';

import {
  type CapabilityDeclaration,
  type CapabilityRequirement,
  isCapabilityId,
  isInterfaceVersion,
  isManifestId,
  isVersionText,
} from './capability.ts';

/**
 * 清单文件名
 */
export const ManifestFileName = 'xihan.manifest.json';

/**
 * 写出的 `$schema`（RFC-0002「写出」）
 */
export const manifestSchemaUri = 'https://spec.xihanfun.com/manifest/v1.json';

/**
 * 读取清单失败的错误码：与宿主共用（RFC-0002 解析规则 2，ADR-0236）
 */
export const ManifestErrorCode = Object.freeze({
  /** 清单读不出来、不合 Schema 或不合跨字段约束 */
  Invalid: 'KERNEL_CAPABILITY_006',
} as const);

/**
 * 读取清单失败的消息键：与宿主共用（RFC-0002 解析规则 2，ADR-0236）
 */
export const ManifestMessageKey = Object.freeze({
  /** 不是 JSON 或有重复成员，参数 `reason`：语法错误为 `$`，重复成员为第一处重复的路径 */
  InvalidJson: 'kernel.manifest.invalid_json',
  /** 根是字面量 `null`，没有参数 */
  Empty: 'kernel.manifest.empty',
  /** 不合 Schema，参数 `reason`：第一处问题的路径 */
  Invalid: 'kernel.manifest.invalid',
  /** 清单文件不存在，参数 `path` */
  FileMissing: 'kernel.manifest.file_missing',
  /** 插件没有声明 `isolation`，参数 `id` */
  IsolationRequired: 'primitives.manifest.isolation_required',
  /** 非插件声明了 `isolation` 或 `permissions`，参数 `id` */
  IsolationNotAllowed: 'primitives.manifest.isolation_not_allowed',
  /** `provides` 的能力 ID 重复，参数 `id` */
  DuplicateProvides: 'primitives.manifest.duplicate_provides',
  /** `requires` 的能力 ID 重复，参数 `id` */
  DuplicateRequires: 'primitives.manifest.duplicate_requires',
  /** `bindings` 的名字重复，参数 `id` */
  DuplicateBindings: 'primitives.manifest.duplicate_bindings',
} as const);

/**
 * 清单种类
 */
export const ManifestKind = Object.freeze({
  Capability: 'capability',
  Provider: 'provider',
  Plugin: 'plugin',
  Host: 'host',
  Protocol: 'protocol',
} as const);

/**
 * 清单种类之一
 */
export type ManifestKind = (typeof ManifestKind)[keyof typeof ManifestKind];

/**
 * Provider 角色：`default` 在没有显式 Provider 时被选中
 */
export const ManifestRole = Object.freeze({
  Provider: 'provider',
  Default: 'default',
} as const);

/**
 * Provider 角色之一
 */
export type ManifestRole = (typeof ManifestRole)[keyof typeof ManifestRole];

/**
 * 插件隔离级别
 */
export const PluginIsolation = Object.freeze({
  InProcess: 'in-process',
  Wasm: 'wasm',
  OutOfProcess: 'out-of-process',
} as const);

/**
 * 插件隔离级别之一
 */
export type PluginIsolation = (typeof PluginIsolation)[keyof typeof PluginIsolation];

/**
 * 需要宿主注入的资源
 */
export interface Binding {
  /** 绑定名 `^[a-z][a-z0-9-]*$` */
  readonly name: string;
  /** 资源类型，如 `connection:relational`、`cache:distributed`、`queue` */
  readonly type: string;
  /** 是否必需；缺省为必需 */
  readonly required?: boolean;
}

/**
 * 贡献的一个中间件
 */
export interface PipelineContribution {
  /** 中间件名，至少一个字符 */
  readonly middleware: string;
  /** 所在阶段 */
  readonly stage: PipelineStage;
  /** 排在这些中间件之前 */
  readonly before?: readonly string[];
  /** 排在这些中间件之后 */
  readonly after?: readonly string[];
}

/**
 * 贡献的配置节：领域节 `XiHan:<领域>`，可再带一层或多层 PascalCase 子节（RFC-0002「配置节」）
 */
export interface ConfigContribution {
  /** 配置节，如 `XiHan:Caching:Redis` */
  readonly section: string;
  /** 配置的 JSON Schema 文本 */
  readonly schema?: string;
}

/**
 * 贡献点
 */
export interface Contributions {
  /** 中间件；插件里只有 Wasm 插件能贡献，宿主在发现时核对 */
  readonly pipeline?: readonly PipelineContribution[];
  /** 操作 ID `<resource>.<verb>` */
  readonly operations?: readonly string[];
  /** 配置节 */
  readonly config?: ConfigContribution;
  /**
   * 此包定义的权限码（RFC-0008 文法：小写、点分、至少两段，如 `orders.read`），不重复
   *
   * @remarks
   * 插件的由宿主在登记它的代理操作时一并登记（plugin/invocation.md §1）
   */
  readonly permissions?: readonly string[];
  /** 健康项 `^[a-z][a-z0-9.-]*$` */
  readonly health?: readonly string[];
}

/**
 * 一份清单 `xihan.manifest.json`（RFC-0002，Schema 见 spec/manifest/manifest.schema.json）
 *
 * @remarks
 * 只做数据与格式校验；收集、解析与求解是宿主的职责。接口版本（`primitives`、`provides[].version`、`requires[].version`）
 * 在清单里写成数字字符串，模型里是数值。程序里构造时可选成员可以不写；{@link readManifest} 读出的清单补齐缺省值
 * （`role`、`activation`、各列表、`requires[].optional`、`bindings[].required`），与 .NET 的 `Manifest` 一致。
 * `$schema` 不在模型里：读取时只核对它是字符串，写出时总写 {@link manifestSchemaUri}
 */
export interface Manifest {
  /** 清单 ID `xihan.<领域>.<名称>` */
  readonly id: string;
  /** 所属包 ID */
  readonly package?: string;
  /** SemVer 版本 */
  readonly version: string;
  /** 依赖的原语层大版本 */
  readonly primitives: number;
  /** 稳定性 */
  readonly stability: Stability;
  /** 种类 */
  readonly kind: ManifestKind;
  /** Provider 角色；缺省为 `provider` */
  readonly role?: ManifestRole;
  /** 隔离级别；插件必填，非插件不得声明 */
  readonly isolation?: PluginIsolation;
  /** 提供的能力 */
  readonly provides?: readonly CapabilityDeclaration[];
  /** 依赖的能力 */
  readonly requires?: readonly CapabilityRequirement[];
  /** 需要宿主注入的资源 */
  readonly bindings?: readonly Binding[];
  /** 贡献点 */
  readonly contributes?: Contributions;
  /** 激活事件；缺省为 `onStartup`，写了就至少一项 */
  readonly activation?: readonly string[];
  /** 插件所需权限，宿主配置授予；非插件不得声明 */
  readonly permissions?: readonly string[];
  /** 入口 */
  readonly entry?: string;
}

/** 激活事件的缺省值 */
const startupOnly: readonly string[] = Object.freeze(['onStartup']);
const none: readonly string[] = Object.freeze([]);

/**
 * 读取清单 JSON（RFC-0002 解析规则 2，ADR-0236）
 *
 * @remarks
 * 按规范的顺序逐步核对，每一步只报第一处问题，错误码都是 `KERNEL_CAPABILITY_006`：
 * 1. JSON 文本：过共同的读取检查（{@link readJsonText}）。不是 JSON 为 `kernel.manifest.invalid_json`，`reason` 为 `$`；
 *    有重复成员时同一个键，`reason` 为第一处重复的路径。文本按原样检查，开头的 BOM 是语法错误（读文件时跳过 BOM 见 `./node`）。
 * 2. 根是字面量 `null`：`kernel.manifest.empty`，没有参数。
 * 3. 形状：按 Schema 逐项核对，第一处问题为 `kernel.manifest.invalid`，`reason` 是该处的路径。成员按文本顺序，
 *    每个成员依次查 Schema 之外的成员 → `null` → 类型 → 取值，对象与数组进到里面再查；对象的成员查完后按 `required` 的顺序报缺少的成员。
 * 4. 跨字段约束：{@link validateManifest}，保留它的消息键与参数。
 *
 * 读出的清单补齐缺省值并深度冻结
 */
export function readManifest(json: string | Uint8Array): Result<Manifest> {
  const read = readJsonText(json);
  if (!read.ok) {
    return failure(ManifestMessageKey.InvalidJson, { reason: read.problem.path });
  }
  if (read.root === null) {
    return failure(ManifestMessageKey.Empty);
  }
  const problem = read.root instanceof JsonMembers ? checkObject(read.root, rootShape, JsonPath.root) : JsonPath.root;
  if (problem !== undefined) {
    return failure(ManifestMessageKey.Invalid, { reason: problem });
  }
  // 形状已核对，转换不会再失败
  const manifest = deepFreeze(convert(read.root as JsonMembers));
  const validation = validateManifest(manifest);
  return validation.ok ? Result.ok(manifest) : Result.fail(validation.error.withCode(ManifestErrorCode.Invalid));
}

/**
 * 写出清单 JSON（RFC-0002「写出」，ADR-0236）
 *
 * @remarks
 * 排版是规范的一部分，各语言逐字相同：两个空格缩进，换行只用 LF，末尾不换行，成员名与值之间是 `: `；空数组写 `[]`，
 * 非空数组每项一行；成员按 Schema 的顺序，没有值的可选成员（`package`、`isolation`、`config`、`config.schema`、`entry`）不写，
 * 其余总写（`role` 缺省写 `provider`，`activation` 缺省写 `["onStartup"]`，`optional` 缺省写 `false`，`required` 缺省写 `true`）；
 * `$schema` 总写 {@link manifestSchemaUri}；字符串只转义必须转义的字符（{@link quoteJsonString}）。
 * 写出之后按 {@link readManifest} 再读一遍核对，不写出读不回来的清单
 *
 * @throws {@link FrameworkError} 清单不合法时：成员的类型不对为 `PRIMITIVES_VALIDATION_001`，
 * 再读失败时为读取的错误码、消息键与参数
 */
export function writeManifest(manifest: Manifest): string {
  const text = write(manifest);
  const read = readManifest(text);
  if (!read.ok) {
    const { error } = read;
    throw new FrameworkError(error.code, error.message, {
      ...(error.messageKey === undefined ? {} : { messageKey: error.messageKey }),
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  return text;
}

/**
 * 核对跨字段约束（RFC-0002 解析规则 2 第 4 步，与 .NET 的 `Manifest.Validate` 相同）
 *
 * @remarks
 * 按这个顺序报第一处：插件没有 `isolation`（`primitives.manifest.isolation_required`）；非插件写了 `isolation` 或 `permissions`
 * （`isolation_not_allowed`）；`provides` 的能力 ID 重复（`duplicate_provides`）；`requires` 的能力 ID 重复（`duplicate_requires`）；
 * `bindings` 的名字重复（`duplicate_bindings`）。错误码是 `PRIMITIVES_VALIDATION_001`，参数只有 `id`（清单 ID）；
 * {@link readManifest} 把码换成 `KERNEL_CAPABILITY_006`。单个成员的格式由读取时的形状核对负责，这里不查
 */
export function validateManifest(manifest: Manifest): Result<void> {
  const plugin = manifest.kind === ManifestKind.Plugin;
  let key: string | undefined;
  if (plugin && manifest.isolation === undefined) {
    key = ManifestMessageKey.IsolationRequired;
  } else if (!plugin && (manifest.isolation !== undefined || (manifest.permissions?.length ?? 0) > 0)) {
    key = ManifestMessageKey.IsolationNotAllowed;
  } else if (hasDuplicates((manifest.provides ?? []).map((declaration) => declaration.id))) {
    key = ManifestMessageKey.DuplicateProvides;
  } else if (hasDuplicates((manifest.requires ?? []).map((requirement) => requirement.id))) {
    key = ManifestMessageKey.DuplicateRequires;
  } else if (hasDuplicates((manifest.bindings ?? []).map((binding) => binding.name))) {
    key = ManifestMessageKey.DuplicateBindings;
  }
  return key === undefined
    ? Result.success()
    : Result.fail(ErrorInfo.validation(ErrorCode.InvalidArgument, key, { id: manifest.id }));
}

/**
 * 返回角色，缺省为 `provider`
 */
export function effectiveRole(manifest: Manifest): ManifestRole {
  return manifest.role ?? ManifestRole.Provider;
}

/**
 * 返回激活事件，缺省为 `["onStartup"]`
 */
export function effectiveActivation(manifest: Manifest): readonly string[] {
  return manifest.activation ?? startupOnly;
}

/**
 * 判断是否在宿主启动时激活
 */
export function activatesOnStartup(manifest: Manifest): boolean {
  return effectiveActivation(manifest).includes('onStartup');
}

/**
 * 返回贡献的操作 ID；没有贡献时为空数组
 */
export function contributedOperations(manifest: Manifest): readonly string[] {
  return manifest.contributes?.operations ?? none;
}

/**
 * 返回贡献的健康项；没有贡献时为空数组
 */
export function contributedHealth(manifest: Manifest): readonly string[] {
  return manifest.contributes?.health ?? none;
}

/**
 * 返回贡献的配置节；没有时为 `undefined`
 */
export function configSection(manifest: Manifest): string | undefined {
  return manifest.contributes?.config?.section;
}

/**
 * 判断绑定是否必需；缺省为必需
 */
export function isBindingRequired(binding: Binding): boolean {
  return binding.required ?? true;
}

function failure(messageKey: string, details?: Record<string, string>): Result<Manifest> {
  return Result.fail(ErrorInfo.create(ManifestErrorCode.Invalid, messageKey, details));
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/** Schema 里一个值的形状 */
type ValueShape =
  | { readonly kind: 'string'; readonly accepts?: (text: string) => boolean }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'object'; readonly object: ObjectShape }
  | { readonly kind: 'array'; readonly item: ValueShape; readonly nonEmpty?: boolean; readonly unique?: boolean };

/** Schema 里一个对象的形状：允许的成员（区分大小写）与按 Schema 顺序的必填成员 */
interface ObjectShape {
  readonly members: ReadonlyMap<string, ValueShape>;
  readonly required: readonly string[];
}

const semverPattern = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const activationPattern = /^(onStartup|onOperation:[a-z0-9.*-]+|onEvent:[a-z0-9.*-]+)$/;
/** `.` 不匹配换行，与 .NET 一致：权限里有换行不合法 */
const permissionPattern = /^(net\.outbound|fs\.read|fs\.write|capability):.+$/;
const bindingNamePattern = /^[a-z][a-z0-9-]*$/;
const bindingTypePattern = /^[a-z]+(:[a-z]+)?$/;
/** 操作 ID 文法 `<resource>.<verb>`（conventions/operation-ids.md；Schema 自 ADR-0233 起与它相同） */
const operationPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const sectionPattern = /^XiHan:[A-Z][A-Za-z0-9]*(:[A-Z][A-Za-z0-9]*)*$/;
const healthPattern = /^[a-z][a-z0-9.-]*$/;
const permissionCodePattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

const anyText: ValueShape = { kind: 'string' };
const flag: ValueShape = { kind: 'boolean' };

function text(accepts: (value: string) => boolean): ValueShape {
  return { kind: 'string', accepts };
}

function matches(pattern: RegExp): ValueShape {
  return text((value) => pattern.test(value));
}

function list(item: ValueShape, options?: { readonly nonEmpty?: boolean; readonly unique?: boolean }): ValueShape {
  return { kind: 'array', item, ...options };
}

function shape(members: Record<string, ValueShape>, required: readonly string[]): ObjectShape {
  return { members: new Map(Object.entries(members)), required };
}

function object(members: Record<string, ValueShape>, required: readonly string[]): ValueShape {
  return { kind: 'object', object: shape(members, required) };
}

function oneOf(values: readonly string[]): ValueShape {
  return text((value) => values.includes(value));
}

/** 按 manifest.schema.json 建出的根对象形状 */
const rootShape: ObjectShape = shape(
  {
    $schema: anyText,
    id: text(isManifestId),
    package: anyText,
    version: matches(semverPattern),
    primitives: text(isVersionText),
    stability: oneOf(stabilities),
    kind: oneOf(Object.values(ManifestKind)),
    role: oneOf(Object.values(ManifestRole)),
    isolation: oneOf(Object.values(PluginIsolation)),
    provides: list(object({ id: text(isCapabilityId), version: text(isVersionText) }, ['id', 'version'])),
    requires: list(
      object(
        {
          id: text(isCapabilityId),
          // 只有依赖的版本可以带一个 ^
          version: text((value) => isVersionText(value.startsWith('^') ? value.slice(1) : value)),
          optional: flag,
        },
        ['id', 'version'],
      ),
    ),
    bindings: list(
      object({ name: matches(bindingNamePattern), type: matches(bindingTypePattern), required: flag }, [
        'name',
        'type',
      ]),
    ),
    contributes: object(
      {
        pipeline: list(
          object(
            {
              middleware: text((value) => value.length > 0),
              stage: text(isPipelineStage),
              before: list(anyText),
              after: list(anyText),
            },
            ['middleware', 'stage'],
          ),
        ),
        operations: list(matches(operationPattern)),
        config: object({ section: matches(sectionPattern), schema: anyText }, ['section']),
        permissions: list(matches(permissionCodePattern), { unique: true }),
        health: list(matches(healthPattern)),
      },
      [],
    ),
    activation: list(matches(activationPattern), { nonEmpty: true }),
    permissions: list(matches(permissionPattern)),
    entry: anyText,
  },
  ['id', 'version', 'primitives', 'stability', 'kind'],
);

/** 检查一个对象：成员按文本顺序，查完后按 Schema 的顺序查缺少的成员；返回第一处问题的路径 */
function checkObject(node: JsonMembers, objectShape: ObjectShape, path: string): string | undefined {
  for (const [name, value] of node.entries) {
    const memberPath = JsonPath.member(path, name);
    const member = objectShape.members.get(name);
    if (member === undefined) {
      return memberPath;
    }
    const problem = checkValue(value, member, memberPath);
    if (problem !== undefined) {
      return problem;
    }
  }
  // 缺少的成员在对象的成员都查完之后才查
  const missing = objectShape.required.find((name) => !node.has(name));
  return missing === undefined ? undefined : JsonPath.member(path, missing);
}

/** 检查一个值：Schema 里没有哪个成员或数组项能取 `null` */
function checkValue(value: JsonNode, valueShape: ValueShape, path: string): string | undefined {
  if (value === null) {
    return path;
  }
  switch (valueShape.kind) {
    case 'string':
      return typeof value === 'string' && (valueShape.accepts?.(value) ?? true) ? undefined : path;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : path;
    case 'object':
      return value instanceof JsonMembers ? checkObject(value, valueShape.object, path) : path;
    case 'array': {
      if (!Array.isArray(value) || (valueShape.nonEmpty === true && value.length === 0)) {
        return path;
      }
      // 不得重复的字符串数组：先核对这一项本身，再看它是否与前面的项重复，重复时报第二次出现的位置
      const seen = valueShape.unique === true ? new Set<string>() : undefined;
      for (const [index, item] of (value as readonly JsonNode[]).entries()) {
        const itemPath = JsonPath.index(path, index);
        const problem = checkValue(item, valueShape.item, itemPath);
        if (problem !== undefined) {
          return problem;
        }
        if (seen !== undefined) {
          if (seen.has(item as string)) {
            return itemPath;
          }
          seen.add(item as string);
        }
      }
      return undefined;
    }
  }
}

/** 把已核对形状的 JSON 转成清单，补齐缺省值 */
function convert(root: JsonMembers): Manifest {
  const textOf = (node: JsonMembers, name: string): string | undefined => node.get(name) as string | undefined;
  const texts = (node: JsonMembers | undefined, name: string): string[] => [
    ...((node?.get(name) as readonly string[] | undefined) ?? []),
  ];
  const objects = (node: JsonMembers | undefined, name: string): JsonMembers[] => [
    ...((node?.get(name) as readonly JsonMembers[] | undefined) ?? []),
  ];
  const contributes = root.get('contributes') as JsonMembers | undefined;
  const config = contributes?.get('config') as JsonMembers | undefined;
  const manifest: Record<string, unknown> = { id: textOf(root, 'id') };
  optional(manifest, 'package', textOf(root, 'package'));
  manifest.version = textOf(root, 'version');
  manifest.primitives = Number(textOf(root, 'primitives'));
  manifest.stability = textOf(root, 'stability');
  manifest.kind = textOf(root, 'kind');
  manifest.role = textOf(root, 'role') ?? ManifestRole.Provider;
  optional(manifest, 'isolation', textOf(root, 'isolation'));
  manifest.provides = objects(root, 'provides').map((item) => ({
    id: textOf(item, 'id'),
    version: Number(textOf(item, 'version')),
  }));
  manifest.requires = objects(root, 'requires').map((item) => ({
    id: textOf(item, 'id'),
    version: Number((textOf(item, 'version') ?? '').replace(/^\^/, '')),
    optional: (item.get('optional') as boolean | undefined) ?? false,
  }));
  manifest.bindings = objects(root, 'bindings').map((item) => ({
    name: textOf(item, 'name'),
    type: textOf(item, 'type'),
    required: (item.get('required') as boolean | undefined) ?? true,
  }));
  const contributions: Record<string, unknown> = {
    pipeline: objects(contributes, 'pipeline').map((item) => ({
      middleware: textOf(item, 'middleware'),
      stage: textOf(item, 'stage'),
      before: texts(item, 'before'),
      after: texts(item, 'after'),
    })),
    operations: texts(contributes, 'operations'),
  };
  if (config !== undefined) {
    const section: Record<string, unknown> = { section: textOf(config, 'section') };
    optional(section, 'schema', textOf(config, 'schema'));
    contributions.config = section;
  }
  contributions.permissions = texts(contributes, 'permissions');
  contributions.health = texts(contributes, 'health');
  manifest.contributes = contributions;
  manifest.activation = root.has('activation') ? texts(root, 'activation') : [...startupOnly];
  manifest.permissions = texts(root, 'permissions');
  optional(manifest, 'entry', textOf(root, 'entry'));
  return manifest as unknown as Manifest;
}

function optional(target: Record<string, unknown>, name: string, value: unknown): void {
  if (value !== undefined) {
    target[name] = value;
  }
}

/** 按规范排版写 JSON：只覆盖清单用到的写法（对象、字符串列表、对象列表、字符串与布尔），与 .NET 的写出逐字相同 */
class IndentedWriter {
  #text = '';
  /** 每一层是否已写过成员或项 */
  readonly #written: boolean[] = [];

  startObject(): this {
    this.#text += '{';
    this.#written.push(false);
    return this;
  }

  endObject(): void {
    this.#close('}');
  }

  member(name: string): this {
    this.#beforeItem();
    this.#text += `${quoteJsonString(name)}: `;
    return this;
  }

  string(value: string): void {
    this.#text += quoteJsonString(value);
  }

  boolean(value: boolean): void {
    this.#text += value ? 'true' : 'false';
  }

  strings(values: readonly string[]): void {
    if (values.length === 0) {
      this.#text += '[]';
      return;
    }
    this.#text += '[';
    this.#written.push(false);
    for (const value of values) {
      this.#beforeItem();
      this.#text += quoteJsonString(value);
    }
    this.#close(']');
  }

  objects<T>(values: readonly T[], members: (writer: IndentedWriter, value: T) => void): void {
    if (values.length === 0) {
      this.#text += '[]';
      return;
    }
    this.#text += '[';
    this.#written.push(false);
    for (const value of values) {
      this.#beforeItem();
      this.startObject();
      members(this, value);
      this.endObject();
    }
    this.#close(']');
  }

  toString(): string {
    return this.#text;
  }

  /** 成员或列表项之前：逗号、换行与缩进 */
  #beforeItem(): void {
    if (this.#written.pop() === true) {
      this.#text += ',';
    }
    this.#written.push(true);
    this.#text += `\n${'  '.repeat(this.#written.length)}`;
  }

  /** 结束一层：有内容时换行并按外层缩进 */
  #close(bracket: string): void {
    if (this.#written.pop() === true) {
      this.#text += `\n${'  '.repeat(this.#written.length)}`;
    }
    this.#text += bracket;
  }
}

/** 按 Schema 的顺序写出；成员的 JavaScript 类型不对时抛出，取值留给再读核对 */
function write(manifest: Manifest): string {
  if (typeof manifest !== 'object' || manifest === null) {
    throw invalidModel('$');
  }
  const writer = new IndentedWriter();
  writer.startObject();
  writer.member('$schema').string(manifestSchemaUri);
  writer.member('id').string(textField(manifest.id, '$.id'));
  if (manifest.package !== undefined) {
    writer.member('package').string(textField(manifest.package, '$.package'));
  }
  writer.member('version').string(textField(manifest.version, '$.version'));
  writer.member('primitives').string(versionField(manifest.primitives, '$.primitives'));
  writer.member('stability').string(textField(manifest.stability, '$.stability'));
  writer.member('kind').string(textField(manifest.kind, '$.kind'));
  writer.member('role').string(textField(manifest.role ?? ManifestRole.Provider, '$.role'));
  if (manifest.isolation !== undefined) {
    writer.member('isolation').string(textField(manifest.isolation, '$.isolation'));
  }
  writer.member('provides').objects(listField(manifest.provides, '$.provides'), (w, declaration) => {
    w.member('id').string(textField(declaration.id, '$.provides[].id'));
    w.member('version').string(versionField(declaration.version, '$.provides[].version'));
  });
  writer.member('requires').objects(listField(manifest.requires, '$.requires'), (w, requirement) => {
    w.member('id').string(textField(requirement.id, '$.requires[].id'));
    w.member('version').string(versionField(requirement.version, '$.requires[].version'));
    w.member('optional').boolean(flagField(requirement.optional ?? false, '$.requires[].optional'));
  });
  writer.member('bindings').objects(listField(manifest.bindings, '$.bindings'), (w, binding) => {
    w.member('name').string(textField(binding.name, '$.bindings[].name'));
    w.member('type').string(textField(binding.type, '$.bindings[].type'));
    w.member('required').boolean(flagField(binding.required ?? true, '$.bindings[].required'));
  });
  const contributes = manifest.contributes ?? {};
  writer.member('contributes').startObject();
  writer.member('pipeline').objects(listField(contributes.pipeline, '$.contributes.pipeline'), (w, item) => {
    w.member('middleware').string(textField(item.middleware, '$.contributes.pipeline[].middleware'));
    w.member('stage').string(textField(item.stage, '$.contributes.pipeline[].stage'));
    w.member('before').strings(textsField(item.before, '$.contributes.pipeline[].before'));
    w.member('after').strings(textsField(item.after, '$.contributes.pipeline[].after'));
  });
  writer.member('operations').strings(textsField(contributes.operations, '$.contributes.operations'));
  if (contributes.config !== undefined) {
    writer.member('config').startObject();
    writer.member('section').string(textField(contributes.config.section, '$.contributes.config.section'));
    if (contributes.config.schema !== undefined) {
      writer.member('schema').string(textField(contributes.config.schema, '$.contributes.config.schema'));
    }
    writer.endObject();
  }
  writer.member('permissions').strings(textsField(contributes.permissions, '$.contributes.permissions'));
  writer.member('health').strings(textsField(contributes.health, '$.contributes.health'));
  writer.endObject();
  writer.member('activation').strings(textsField(manifest.activation ?? startupOnly, '$.activation'));
  writer.member('permissions').strings(textsField(manifest.permissions, '$.permissions'));
  if (manifest.entry !== undefined) {
    writer.member('entry').string(textField(manifest.entry, '$.entry'));
  }
  writer.endObject();
  return writer.toString();
}

function textField(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw invalidModel(path);
  }
  return value;
}

function flagField(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalidModel(path);
  }
  return value;
}

function versionField(value: unknown, path: string): string {
  if (!isInterfaceVersion(value)) {
    throw invalidModel(path);
  }
  return String(value);
}

function listField<T>(value: readonly T[] | undefined, path: string): readonly T[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidModel(path);
  }
  return value;
}

function textsField(value: readonly string[] | undefined, path: string): readonly string[] {
  return listField(value, path).map((item) => textField(item, `${path}[]`));
}

function invalidModel(path: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, `The manifest member at '${path}' has the wrong type.`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
