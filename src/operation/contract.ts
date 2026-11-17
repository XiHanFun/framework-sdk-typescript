import { ErrorCode, FrameworkError, isStability, Stability } from '../primitives/index.ts';

/**
 * 内核登记的操作错误码
 */
export const OperationErrorCode = Object.freeze({
  /** 操作未登记 */
  NotFound: 'KERNEL_NOTFOUND_001',
  /** 操作载荷不合法：非 JSON、`null` 或与请求类型不符 */
  InvalidPayload: 'KERNEL_VALIDATION_001',
  /** 类型化调用的请求或响应类型与登记不符 */
  TypeMismatch: 'KERNEL_VALIDATION_002',
  /** 调用期间的意外：管道以成功结束而没有响应，或未处理的异常 */
  Unexpected: 'KERNEL_UNEXPECTED_001',
  /** 操作 ID 重复登记（配置期） */
  Duplicate: 'KERNEL_OPERATION_001',
  /** 操作登记表已满（配置期） */
  RegistryFull: 'KERNEL_OPERATION_002',
} as const);

/**
 * 操作错误的消息键：SDK 与宿主共用（RFC-0011「错误码」，spec/conformance/vectors/primitives/kernel-messages.json）
 */
export const OperationMessageKey = Object.freeze({
  /** 未登记，参数 `id` */
  NotFound: 'kernel.operation.unknown',
  /** 载荷不合法，参数 `id`、`reason`（只写出错位置的 JSON 路径） */
  InvalidPayload: 'kernel.operation.invalid_payload',
  /** 类型不符，参数只有 `id`：类型名是实现语言的，不上线（ADR-0236） */
  TypeMismatch: 'kernel.operation.type_mismatch',
  /** 管道以成功结束而没有响应，参数 `id` */
  NoResponse: 'kernel.operation.no_response',
  /** 操作 ID 重复登记，参数 `id`、`owner` */
  Duplicate: 'kernel.operation.duplicate',
  /** 登记表已满，参数 `capacity` */
  RegistryFull: 'kernel.operation.registry_full',
} as const);

/**
 * 操作可以暴露的协议（plugin.proto 的 `expose`）
 */
export const Expose = Object.freeze({
  Http: 'http',
  Grpc: 'grpc',
  Mcp: 'mcp',
  CommandLine: 'commandline',
  Ai: 'ai',
} as const);

/**
 * 协议之一
 */
export type Expose = (typeof Expose)[keyof typeof Expose];

const exposeValues: readonly string[] = Object.values(Expose);

/** 操作 ID 文法 `<resource>.<verb>`（conventions/operation-ids.md） */
const operationIdPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * 判断操作 ID 是否符合 `<resource>.<verb>`
 */
export function isOperationId(id: string): boolean {
  return operationIdPattern.test(id);
}

/** 只在类型层面携带请求与响应类型 */
declare const requestType: unique symbol;
declare const responseType: unique symbol;

/**
 * 操作契约：ID、稳定性、暴露的协议与授权要求（`permission` 与 `policy` 二选一）
 *
 * @remarks
 * 类型参数只在类型层面存在，让类型化调用在编译期核对请求与响应类型；
 * 运行期按对象标识核对：类型化调用要用登记时的同一份契约，否则是 `KERNEL_VALIDATION_002`
 */
export interface OperationContract<Req = unknown, Res = unknown> {
  /** 操作 ID `<resource>.<verb>` */
  readonly id: string;
  /** 稳定性 */
  readonly stability: Stability;
  /** 暴露的协议；空表示不对外发布 */
  readonly expose: readonly Expose[];
  /** 权限码 */
  readonly permission?: string;
  /** 策略名 */
  readonly policy?: string;
  /** @internal 请求类型 */
  readonly [requestType]?: Req;
  /** @internal 响应类型 */
  readonly [responseType]?: Res;
}

/**
 * 定义契约的输入
 */
export interface OperationContractInit {
  /** 操作 ID `<resource>.<verb>` */
  readonly id: string;
  /** 稳定性；缺省为 `stable`（RFC-0011） */
  readonly stability?: Stability;
  /** 暴露的协议；必须写明，空数组表示不对外发布 */
  readonly expose: readonly Expose[];
  /** 权限码；与 `policy` 二选一 */
  readonly permission?: string;
  /** 策略名；与 `permission` 二选一 */
  readonly policy?: string;
}

/**
 * 定义一份类型化的契约
 *
 * @example
 * ```ts
 * const createOrder = defineContract<CreateOrder, OrderCreated>({ id: 'orders.create', expose: [Expose.Http] });
 * ```
 *
 * @throws {@link FrameworkError} ID 不合法、同时声明权限码与策略、暴露的协议不合法时，码为 `PRIMITIVES_VALIDATION_001`
 */
export function defineContract<Req, Res>(init: OperationContractInit): OperationContract<Req, Res> {
  const contract: OperationContract<Req, Res> = {
    id: init.id,
    stability: init.stability ?? Stability.Stable,
    expose: Object.freeze([...init.expose]),
    ...(init.permission === undefined ? {} : { permission: init.permission }),
    ...(init.policy === undefined ? {} : { policy: init.policy }),
  };
  checkContract(contract);
  return Object.freeze(contract);
}

/**
 * 核对契约
 *
 * @internal
 */
export function checkContract(contract: OperationContract): void {
  if (typeof contract !== 'object' || contract === null) {
    throw invalid('An operation contract must be an object.');
  }
  const { id } = contract;
  if (typeof id !== 'string' || !isOperationId(id)) {
    throw invalid(`The operation ID '${id}' must match <resource>.<verb>.`);
  }
  if (contract.permission !== undefined && contract.policy !== undefined) {
    throw invalid(`The operation '${id}' must declare either a permission or a policy.`);
  }
  for (const [field, value] of [
    ['permission', contract.permission],
    ['policy', contract.policy],
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || value === '')) {
      throw invalid(`The ${field} of the operation '${id}' must not be empty.`);
    }
  }
  if (!isStability(contract.stability)) {
    throw invalid(`The stability of the operation '${id}' is not valid.`);
  }
  if (!Array.isArray(contract.expose)) {
    throw invalid(`The operation '${id}' must list the protocols it is exposed to.`);
  }
  const seen = new Set<string>();
  for (const protocol of contract.expose) {
    if (!exposeValues.includes(protocol)) {
      throw invalid(`The operation '${id}' cannot be exposed to '${protocol}'.`);
    }
    if (seen.has(protocol)) {
      throw invalid(`The operation '${id}' lists '${protocol}' more than once.`);
    }
    seen.add(protocol);
  }
}

function invalid(message: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, message);
}
