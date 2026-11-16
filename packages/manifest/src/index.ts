/**
 * 清单 `xihan.manifest.json` 的模型（RFC-0002，Schema 见 spec/manifest/manifest.schema.json）
 *
 * @remarks
 * 只做数据与格式校验；收集、解析与求解是宿主的职责。读取失败经 Result 返回，错误码与消息键与宿主一致（RFC-0002 解析规则 2）；
 * 读取文件在子路径 `@xihan-framework/manifest/node`
 *
 * @packageDocumentation
 */

export {
  type CapabilityDeclaration,
  type CapabilityRequirement,
  capabilityDeclarationText,
  capabilityRequirementText,
  idDomain,
  isCapabilityId,
  isManifestId,
  isRequirementSatisfiedBy,
  maxInterfaceVersion,
  parseCapabilityDeclaration,
  parseCapabilityRequirement,
} from './capability.ts';
export {
  activatesOnStartup,
  type Binding,
  type ConfigContribution,
  type Contributions,
  configSection,
  contributedHealth,
  contributedOperations,
  effectiveActivation,
  effectiveRole,
  isBindingRequired,
  type Manifest,
  ManifestErrorCode,
  ManifestFileName,
  ManifestKind,
  ManifestMessageKey,
  ManifestRole,
  manifestSchemaUri,
  type PipelineContribution,
  PluginIsolation,
  readManifest,
  validateManifest,
  writeManifest,
} from './manifest.ts';
