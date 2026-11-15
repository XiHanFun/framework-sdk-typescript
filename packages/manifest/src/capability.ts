/** 清单 ID 文法 `xihan.<领域>.<名称>` */
const manifestIdPattern = /^xihan\.[a-z][a-z0-9]*\.[a-z][a-z0-9-]*$/;

/** 能力 ID 文法 `<领域>.<能力>` */
const capabilityIdPattern = /^[a-z][a-z0-9]*\.[a-z][a-z0-9-]*$/;

/** 能力声明文本 `id@version` */
const declarationPattern = /^([a-z][a-z0-9]*\.[a-z][a-z0-9-]*)@([1-9][0-9]*)$/;

/** 能力依赖文本 `id@[^]version[?]`（conventions/capability-ids.md） */
const requirementPattern = /^([a-z][a-z0-9]*\.[a-z][a-z0-9-]*)@(\^?)([1-9][0-9]*)(\??)$/;

/**
 * 提供的能力：能力 ID 与整数接口版本
 *
 * @remarks
 * 清单里版本写成数字字符串（`"1"`），模型里是数值
 */
export interface CapabilityDeclaration {
  /** 能力 ID `<领域>.<能力>` */
  readonly id: string;
  /** 接口版本，正整数 */
  readonly version: number;
}

/**
 * 依赖的能力：能力 ID、整数接口版本与是否可选
 *
 * @remarks
 * 依赖文本里的 `^N` 与 `N` 等价，模型里只记版本
 */
export interface CapabilityRequirement {
  /** 能力 ID `<领域>.<能力>` */
  readonly id: string;
  /** 接口版本，正整数 */
  readonly version: number;
  /** 是否可选；缺省为必需 */
  readonly optional?: boolean;
}

/**
 * 判断清单 ID 是否符合 `xihan.<领域>.<名称>`
 */
export function isManifestId(id: string): boolean {
  return manifestIdPattern.test(id);
}

/**
 * 判断能力 ID 是否符合 `<领域>.<能力>`
 */
export function isCapabilityId(id: string): boolean {
  return capabilityIdPattern.test(id);
}

/**
 * 返回清单 ID 或能力 ID 的领域段；都不合法时为 `undefined`
 */
export function idDomain(id: string): string | undefined {
  if (isManifestId(id)) {
    return id.split('.')[1];
  }
  return isCapabilityId(id) ? id.split('.')[0] : undefined;
}

/**
 * 解析能力声明文本 `id@version`；不合法时为 `undefined`
 */
export function parseCapabilityDeclaration(text: string): CapabilityDeclaration | undefined {
  const match = declarationPattern.exec(text);
  const version = match === null ? undefined : toVersion(match[2]);
  return match === null || version === undefined ? undefined : { id: match[1] ?? '', version };
}

/**
 * 解析能力依赖文本 `id@[^]version[?]`；不合法时为 `undefined`
 */
export function parseCapabilityRequirement(text: string): CapabilityRequirement | undefined {
  const match = requirementPattern.exec(text);
  const version = match === null ? undefined : toVersion(match[3]);
  return match === null || version === undefined
    ? undefined
    : { id: match[1] ?? '', version, optional: match[4] === '?' };
}

/**
 * 返回能力声明文本 `id@version`
 */
export function capabilityDeclarationText(declaration: CapabilityDeclaration): string {
  return `${declaration.id}@${declaration.version}`;
}

/**
 * 返回能力依赖文本 `id@version[?]`
 */
export function capabilityRequirementText(requirement: CapabilityRequirement): string {
  return `${requirement.id}@${requirement.version}${requirement.optional === true ? '?' : ''}`;
}

/**
 * 判断一个声明是否满足一个依赖：同一能力且同一接口版本
 */
export function isRequirementSatisfiedBy(
  requirement: CapabilityRequirement,
  declaration: CapabilityDeclaration,
): boolean {
  return requirement.id === declaration.id && requirement.version === declaration.version;
}

/**
 * 把十进制数字串转成版本；超出安全整数范围时为 `undefined`
 *
 * @internal
 */
export function toVersion(digits: string | undefined): number | undefined {
  const version = Number(digits);
  return Number.isSafeInteger(version) && version >= 1 ? version : undefined;
}

/**
 * 判断一个值是否是合法的接口版本：正的安全整数
 *
 * @internal
 */
export function isInterfaceVersion(version: unknown): version is number {
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 1;
}
