import {
  ErrorCode,
  FrameworkError,
  isPipelineStage,
  isPlainObject,
  isStability,
  type PipelineStage,
  parseJson,
  type Stability,
} from '@xihan-framework/primitives';

import {
  type CapabilityDeclaration,
  type CapabilityRequirement,
  isCapabilityId,
  isInterfaceVersion,
  isManifestId,
  toVersion,
} from './capability.ts';

/**
 * 清单文件名
 */
export const ManifestFileName = 'xihan.manifest.json';

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
  /** 中间件名 */
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
  /** 中间件；插件里只有 Wasm 插件能贡献 */
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
  /** 健康项 */
  readonly health?: readonly string[];
}

/**
 * 一份清单 `xihan.manifest.json`（RFC-0002，Schema 见 spec/manifest/manifest.schema.json）
 *
 * @remarks
 * 只做数据与格式校验；收集、解析与求解是宿主的职责。字段顺序与 Schema 一致，
 * 接口版本（`primitives`、`provides[].version`、`requires[].version`）在清单里写成数字字符串，模型里是数值
 */
export interface Manifest {
  /** Schema 地址 */
  readonly $schema?: string;
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
  /** 激活事件；缺省为 `onStartup` */
  readonly activation?: readonly string[];
  /** 插件所需权限，宿主配置授予；非插件不得声明 */
  readonly permissions?: readonly string[];
  /** 入口 */
  readonly entry?: string;
}

const semverPattern = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const activationPattern = /^(onStartup|onOperation:[a-z0-9.*-]+|onEvent:[a-z0-9.*-]+)$/;
const permissionPattern = /^(net\.outbound|fs\.read|fs\.write|capability):.+$/;
const bindingNamePattern = /^[a-z][a-z0-9-]*$/;
const bindingTypePattern = /^[a-z]+(:[a-z]+)?$/;
/** 操作 ID 文法 `<resource>.<verb>`（RFC-0002 解析规则 2、conventions/operation-ids.md；Schema 自 ADR-0233 起与它相同） */
const operationPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const sectionPattern = /^XiHan:[A-Z][A-Za-z0-9]*(:[A-Z][A-Za-z0-9]*)*$/;
const healthPattern = /^[a-z][a-z0-9.-]*$/;
const permissionCodePattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** Schema 里的接口版本：正整数的数字串；依赖的版本可以带 `^` */
const versionTextPattern = /^[1-9][0-9]*$/;
const rangeTextPattern = /^\^?([1-9][0-9]*)$/;

const manifestKinds: readonly string[] = Object.values(ManifestKind);
const manifestRoles: readonly string[] = Object.values(ManifestRole);
const pluginIsolations: readonly string[] = Object.values(PluginIsolation);

/** 激活事件的缺省值 */
const startupOnly: readonly string[] = Object.freeze(['onStartup']);
const none: readonly string[] = Object.freeze([]);

/**
 * 解析并校验清单 JSON
 *
 * @remarks
 * 按 Schema 解码：未知字段、类型不对（含 `null`）与接口版本不是数字串都算失败；之后按 {@link validateManifest} 校验。
 * 返回的清单深度冻结
 *
 * @throws {@link FrameworkError} 码为 `PRIMITIVES_VALIDATION_001`；解码失败的具体原因在 `cause` 里
 */
export function readManifest(json: string | Uint8Array): Manifest {
  let manifest: Manifest;
  try {
    const text = typeof json === 'string' ? json : new TextDecoder('utf-8', { fatal: true }).decode(json);
    // parseJson 另查同一层的重复成员名：JSON.parse 会悄悄取最后一个（RFC-0002 解析规则 2）
    manifest = decodeManifest(parseJson(text));
  } catch (cause) {
    throw new FrameworkError(ErrorCode.InvalidArgument, 'The manifest is not valid JSON for the schema.', { cause });
  }
  validateManifest(manifest);
  return deepFreeze(manifest);
}

/**
 * 输出规范化的清单 JSON
 *
 * @remarks
 * 两空格缩进、字段按 Schema 顺序、缺省值与空数组省略、末尾没有换行，与 Go SDK 的 `manifest.Write` 一致
 *
 * @throws {@link FrameworkError} 清单不合法时
 */
export function writeManifest(manifest: Manifest): string {
  validateManifest(manifest);
  return JSON.stringify(canonical(manifest), null, 2);
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

/**
 * 校验格式与跨字段约束
 *
 * @remarks
 * 插件必须声明隔离，非插件不得声明隔离或权限，只有 Wasm 插件可以贡献中间件，提供、依赖、绑定与权限码不得重复
 *
 * @throws {@link FrameworkError} 码为 `PRIMITIVES_VALIDATION_001`
 */
export function validateManifest(manifest: Manifest): void {
  const { id } = manifest;
  if (typeof id !== 'string' || !isManifestId(id)) {
    throw invalid(`The manifest ID '${id}' must match xihan.<domain>.<name>.`);
  }
  if (typeof manifest.version !== 'string' || !semverPattern.test(manifest.version)) {
    throw invalid(`The version '${manifest.version}' of '${id}' must be a semantic version.`);
  }
  if (!isInterfaceVersion(manifest.primitives)) {
    throw invalid(`The primitives version of '${id}' must be a positive integer.`);
  }
  if (!isStability(manifest.stability)) {
    throw invalid(`The stability of '${id}' is not valid.`);
  }
  if (!manifestKinds.includes(manifest.kind)) {
    throw invalid(`The kind '${manifest.kind}' of '${id}' is not valid.`);
  }
  if (manifest.role !== undefined && !manifestRoles.includes(manifest.role)) {
    throw invalid(`The role '${manifest.role}' of '${id}' is not valid.`);
  }
  if (manifest.isolation !== undefined && !pluginIsolations.includes(manifest.isolation)) {
    throw invalid(`The isolation '${manifest.isolation}' of '${id}' is not valid.`);
  }
  const plugin = manifest.kind === ManifestKind.Plugin;
  if (plugin && manifest.isolation === undefined) {
    throw invalid(`The plugin '${id}' must declare its isolation.`);
  }
  if (!plugin && manifest.isolation !== undefined) {
    throw invalid(`'${id}' is not a plugin and must not declare an isolation.`);
  }
  if (!plugin && (manifest.permissions?.length ?? 0) > 0) {
    throw invalid(`'${id}' is not a plugin and must not declare permissions.`);
  }

  // 提供、依赖与绑定各自按 ID 或名字去重
  const provided = new Set<string>();
  for (const declaration of manifest.provides ?? []) {
    if (!isCapabilityId(declaration.id) || !isInterfaceVersion(declaration.version)) {
      throw invalid(`The provided capability '${declaration.id}' of '${id}' is not valid.`);
    }
    if (provided.has(declaration.id)) {
      throw invalid(`'${id}' provides '${declaration.id}' more than once.`);
    }
    provided.add(declaration.id);
  }
  const required = new Set<string>();
  for (const requirement of manifest.requires ?? []) {
    if (!isCapabilityId(requirement.id) || !isInterfaceVersion(requirement.version)) {
      throw invalid(`The required capability '${requirement.id}' of '${id}' is not valid.`);
    }
    if (required.has(requirement.id)) {
      throw invalid(`'${id}' requires '${requirement.id}' more than once.`);
    }
    required.add(requirement.id);
  }
  const bound = new Set<string>();
  for (const binding of manifest.bindings ?? []) {
    if (!bindingNamePattern.test(binding.name) || !bindingTypePattern.test(binding.type)) {
      throw invalid(`The binding '${binding.name}' (${binding.type}) of '${id}' is not valid.`);
    }
    if (bound.has(binding.name)) {
      throw invalid(`'${id}' declares the binding '${binding.name}' more than once.`);
    }
    bound.add(binding.name);
  }
  // 激活事件至少一项：空数组不合法，缺省（不写）才是 onStartup（RFC-0002 解析规则 2，ADR-0235）
  if (manifest.activation !== undefined && manifest.activation.length === 0) {
    throw invalid(`The activation of '${id}' must list at least one event; leave it out for the default onStartup.`);
  }
  for (const event of manifest.activation ?? []) {
    if (!activationPattern.test(event)) {
      throw invalid(`The activation event '${event}' of '${id}' is not valid.`);
    }
  }
  for (const permission of manifest.permissions ?? []) {
    if (!permissionPattern.test(permission)) {
      throw invalid(`The permission '${permission}' of '${id}' is not valid.`);
    }
  }
  if (manifest.contributes !== undefined) {
    validateContributions(manifest.contributes, id);
    // 只有 Wasm 插件能贡献中间件（RFC-0017「范围」）：进程外与进程内插件写了 contributes.pipeline，
    // .NET 宿主在发现或加载时以 PLUGINS_VALIDATION_001 拒绝；读清单时同样拒绝，不让作者以为中间件生效了、等到宿主那里才失败
    const pipeline = manifest.contributes.pipeline ?? [];
    if (plugin && manifest.isolation !== PluginIsolation.Wasm && pipeline.length > 0) {
      const names = pipeline.map((contribution) => contribution.middleware).join(', ');
      throw invalid(
        `The plugin '${id}' with isolation '${manifest.isolation}' must not declare 'contributes.pipeline' (${names}): only wasm plugins can contribute middleware.`,
      );
    }
  }
}

function validateContributions(contributions: Contributions, id: string): void {
  for (const contribution of contributions.pipeline ?? []) {
    if (typeof contribution.middleware !== 'string' || contribution.middleware === '') {
      throw invalid(`A pipeline contribution of '${id}' has no middleware name.`);
    }
    if (!isPipelineStage(contribution.stage)) {
      throw invalid(`The pipeline contribution '${contribution.middleware}' of '${id}' has an unknown stage.`);
    }
  }
  for (const operation of contributions.operations ?? []) {
    if (!operationPattern.test(operation)) {
      throw invalid(`The operation '${operation}' of '${id}' must match <resource>.<verb>.`);
    }
  }
  if (contributions.config !== undefined && !sectionPattern.test(contributions.config.section)) {
    throw invalid(
      `The configuration section '${contributions.config.section}' of '${id}' must match XiHan:<Domain> or XiHan:<Domain>:<Section>..., with PascalCase segments.`,
    );
  }
  // 插件定义的权限码由宿主在登记代理操作时一并登记（plugin/invocation.md §1）：不合文法或重复的码，
  // 宿主在发现时拒绝整个插件；读清单时同样拒绝，不让它等到宿主那里才失败
  const codes = new Set<string>();
  for (const code of contributions.permissions ?? []) {
    if (!permissionCodePattern.test(code)) {
      throw invalid(
        `The permission code '${code}' in 'contributes.permissions' of '${id}' must be a lowercase dot-separated code with at least two segments, such as 'orders.read'.`,
      );
    }
    if (codes.has(code)) {
      throw invalid(`The permission code '${code}' appears more than once in 'contributes.permissions' of '${id}'.`);
    }
    codes.add(code);
  }
  for (const health of contributions.health ?? []) {
    if (!healthPattern.test(health)) {
      throw invalid(`The health item '${health}' of '${id}' is not valid.`);
    }
  }
}

function invalid(message: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, message);
}

/** 按 Schema 解码时的一处不符；作为 FrameworkError 的 cause 交出 */
class SchemaMismatch extends Error {
  override readonly name = 'SchemaMismatch';
}

type Fields = Record<string, unknown>;

/** 取对象，并拒绝 Schema 之外的字段（additionalProperties: false） */
function object(value: unknown, path: string, allowed: readonly string[]): Fields {
  if (!isPlainObject(value)) {
    throw new SchemaMismatch(`'${path}' must be a JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new SchemaMismatch(`'${path}' has the unknown field '${key}'.`);
    }
  }
  return value;
}

function has(fields: Fields, key: string): boolean {
  return Object.hasOwn(fields, key);
}

function text(fields: Fields, key: string, path: string): string {
  const value = fields[key];
  if (typeof value !== 'string') {
    throw new SchemaMismatch(`'${path}.${key}' must be a string.`);
  }
  return value;
}

function flag(fields: Fields, key: string, path: string): boolean {
  const value = fields[key];
  if (typeof value !== 'boolean') {
    throw new SchemaMismatch(`'${path}.${key}' must be a boolean.`);
  }
  return value;
}

function list<T>(fields: Fields, key: string, path: string, item: (value: unknown, path: string) => T): T[] {
  const value = fields[key];
  if (!Array.isArray(value)) {
    throw new SchemaMismatch(`'${path}.${key}' must be an array.`);
  }
  return value.map((entry, index) => item(entry, `${path}.${key}[${index}]`));
}

function texts(fields: Fields, key: string, path: string): string[] {
  return list(fields, key, path, (value, at) => {
    if (typeof value !== 'string') {
      throw new SchemaMismatch(`'${at}' must be a string.`);
    }
    return value;
  });
}

/** 接口版本：Schema 里是数字串；只有依赖的版本可以带 `^`（`^N` 与 `N` 等价） */
function version(fields: Fields, key: string, path: string, range: boolean): number {
  const raw = text(fields, key, path);
  const match = (range ? rangeTextPattern : versionTextPattern).exec(raw);
  const parsed = match === null ? undefined : toVersion(range ? match[1] : match[0]);
  if (parsed === undefined) {
    throw new SchemaMismatch(
      `'${path}.${key}' must be a positive integer in a string${range ? ', optionally prefixed with ^' : ''}, got '${raw}'.`,
    );
  }
  return parsed;
}

const manifestFields = [
  '$schema',
  'id',
  'package',
  'version',
  'primitives',
  'stability',
  'kind',
  'role',
  'isolation',
  'provides',
  'requires',
  'bindings',
  'contributes',
  'activation',
  'permissions',
  'entry',
] as const;

const requiredManifestFields = ['id', 'version', 'primitives', 'stability', 'kind'] as const;

/** 按 Schema 把 JSON 值解码成清单模型；枚举值与文法留给 validateManifest */
function decodeManifest(value: unknown): Manifest {
  const fields = object(value, '$', manifestFields);
  for (const key of requiredManifestFields) {
    if (!has(fields, key)) {
      throw new SchemaMismatch(`'$' is missing the required field '${key}'.`);
    }
  }
  const manifest: Record<string, unknown> = {};
  for (const key of manifestFields) {
    if (!has(fields, key)) {
      continue;
    }
    switch (key) {
      case 'primitives':
        manifest[key] = version(fields, key, '$', false);
        break;
      case 'provides':
        manifest[key] = list(fields, key, '$', (entry, at) => {
          const declaration = object(entry, at, ['id', 'version']);
          return { id: text(declaration, 'id', at), version: version(declaration, 'version', at, false) };
        });
        break;
      case 'requires':
        manifest[key] = list(fields, key, '$', decodeRequirement);
        break;
      case 'bindings':
        manifest[key] = list(fields, key, '$', decodeBinding);
        break;
      case 'contributes':
        manifest[key] = decodeContributions(fields[key], '$.contributes');
        break;
      case 'activation':
      case 'permissions':
        manifest[key] = texts(fields, key, '$');
        break;
      default:
        manifest[key] = text(fields, key, '$');
    }
  }
  return manifest as unknown as Manifest;
}

function decodeRequirement(entry: unknown, at: string): CapabilityRequirement {
  const fields = object(entry, at, ['id', 'version', 'optional']);
  const requirement = { id: text(fields, 'id', at), version: version(fields, 'version', at, true) };
  return has(fields, 'optional') ? { ...requirement, optional: flag(fields, 'optional', at) } : requirement;
}

function decodeBinding(entry: unknown, at: string): Binding {
  const fields = object(entry, at, ['name', 'type', 'required']);
  const binding = { name: text(fields, 'name', at), type: text(fields, 'type', at) };
  return has(fields, 'required') ? { ...binding, required: flag(fields, 'required', at) } : binding;
}

function decodeContributions(value: unknown, path: string): Contributions {
  const fields = object(value, path, ['pipeline', 'operations', 'config', 'permissions', 'health']);
  const contributions: Record<string, unknown> = {};
  if (has(fields, 'pipeline')) {
    contributions.pipeline = list(fields, 'pipeline', path, (entry, at) => {
      const item = object(entry, at, ['middleware', 'stage', 'before', 'after']);
      const contribution: Record<string, unknown> = {
        middleware: text(item, 'middleware', at),
        stage: text(item, 'stage', at),
      };
      for (const key of ['before', 'after']) {
        if (has(item, key)) {
          contribution[key] = texts(item, key, at);
        }
      }
      return contribution;
    });
  }
  for (const key of ['operations', 'permissions', 'health']) {
    if (has(fields, key)) {
      contributions[key] = texts(fields, key, path);
    }
  }
  if (has(fields, 'config')) {
    const at = `${path}.config`;
    const config = object(fields.config, at, ['section', 'schema']);
    if (!has(config, 'section')) {
      throw new SchemaMismatch(`'${at}' is missing the required field 'section'.`);
    }
    contributions.config = has(config, 'schema')
      ? { section: text(config, 'section', at), schema: text(config, 'schema', at) }
      : { section: text(config, 'section', at) };
  }
  return contributions as Contributions;
}

/** 规范化输出的对象：字段按 Schema 顺序，空字符串、空数组与缺省值省略（与 Go 的 omitempty 一致） */
function canonical(manifest: Manifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  setText(out, '$schema', manifest.$schema);
  out.id = manifest.id;
  setText(out, 'package', manifest.package);
  out.version = manifest.version;
  out.primitives = String(manifest.primitives);
  out.stability = manifest.stability;
  out.kind = manifest.kind;
  setText(out, 'role', manifest.role);
  setText(out, 'isolation', manifest.isolation);
  setList(
    out,
    'provides',
    manifest.provides?.map((declaration) => ({ id: declaration.id, version: String(declaration.version) })),
  );
  setList(
    out,
    'requires',
    manifest.requires?.map((requirement) =>
      requirement.optional === true
        ? { id: requirement.id, version: String(requirement.version), optional: true }
        : { id: requirement.id, version: String(requirement.version) },
    ),
  );
  setList(
    out,
    'bindings',
    manifest.bindings?.map((binding) =>
      binding.required === undefined
        ? { name: binding.name, type: binding.type }
        : { name: binding.name, type: binding.type, required: binding.required },
    ),
  );
  if (manifest.contributes !== undefined) {
    const contributes = manifest.contributes;
    const contributions: Record<string, unknown> = {};
    setList(
      contributions,
      'pipeline',
      contributes.pipeline?.map((contribution) => {
        const item: Record<string, unknown> = { middleware: contribution.middleware, stage: contribution.stage };
        setList(item, 'before', contribution.before);
        setList(item, 'after', contribution.after);
        return item;
      }),
    );
    setList(contributions, 'operations', contributes.operations);
    if (contributes.config !== undefined) {
      const config: Record<string, unknown> = { section: contributes.config.section };
      setText(config, 'schema', contributes.config.schema);
      contributions.config = config;
    }
    setList(contributions, 'permissions', contributes.permissions);
    setList(contributions, 'health', contributes.health);
    out.contributes = contributions;
  }
  setList(out, 'activation', manifest.activation);
  setList(out, 'permissions', manifest.permissions);
  setText(out, 'entry', manifest.entry);
  return out;
}

function setText(out: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined && value !== '') {
    out[key] = value;
  }
}

function setList(out: Record<string, unknown>, key: string, value: readonly unknown[] | undefined): void {
  if (value !== undefined && value.length > 0) {
    out[key] = value;
  }
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
