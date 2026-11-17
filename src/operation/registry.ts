import { type InvocationContext, InvocationMessageKey } from '../invocation/index.ts';
import { AppOwner } from '../pipeline/index.ts';
import {
  ErrorCode,
  ErrorInfo,
  FrameworkError,
  isPlainObject,
  JsonPath,
  Result,
  readJsonText,
  writeJson,
} from '../primitives/index.ts';

import { checkContract, type OperationContract, OperationErrorCode, OperationMessageKey } from './contract.ts';
import { RequestDecodeError, RequestShape } from './request-shape.ts';

/**
 * 请求与响应的 JSON Schema（draft 2020-12）文本；两段都必须是 JSON 对象（RFC-0011）
 */
export interface OperationSchema {
  /** 请求的 Schema */
  readonly request: string;
  /** 响应的 Schema */
  readonly response: string;
}

/**
 * XGI 请求：操作 ID 与请求类型的 UTF-8 JSON
 */
export interface OperationRequest {
  /** 操作 ID */
  readonly id: string;
  /** 请求的 JSON 文本或 UTF-8 字节；没有或长度为零时等价于 `{}`，只有空白不是 JSON */
  readonly payload?: string | Uint8Array;
}

/**
 * XGI 响应：结果与成功时响应类型的 JSON
 */
export interface OperationResponse {
  /** 结果 */
  readonly outcome: Result<void>;
  /** 成功时响应的 JSON 文本；失败为 `undefined` */
  readonly payload: string | undefined;
}

/**
 * 处理一个操作：可恢复失败经 Result 返回，不抛异常；抛出的异常由调用器翻译为 `KERNEL_UNEXPECTED_001`
 */
export type OperationHandler<Req, Res> = (context: InvocationContext, request: Req) => Promise<Result<Res>>;

/**
 * 一次登记
 */
export interface OperationRegistration<Req, Res> {
  /** 契约 */
  readonly contract: OperationContract<Req, Res>;
  /** 处理器 */
  readonly handler: OperationHandler<Req, Res>;
  /** 请求的形状：XGI 调用按它解码 JSON 载荷（RFC-0011 规则 2） */
  readonly request: RequestShape<Req | null>;
  /** 请求与响应的 Schema */
  readonly schema?: OperationSchema;
  /** 归属：清单 ID，缺省为 `app` */
  readonly owner?: string;
}

/** 描述的内部入口：调用器用，不对外 */
interface Internals {
  readonly handler: OperationHandler<unknown, unknown>;
  readonly request: RequestShape<unknown>;
}

const internals = new WeakMap<OperationDescriptor, Internals>();

/**
 * 登记表里的一个操作：契约、Schema、归属与执行入口
 */
export class OperationDescriptor {
  /** 契约；就是登记时给出的那一份 */
  readonly contract: OperationContract;
  /** Schema */
  readonly schema: OperationSchema | undefined;
  /** 归属：清单 ID 或 `app` */
  readonly owner: string;

  /** @internal 用 {@link OperationRegistry.add} 创建 */
  constructor(registration: OperationRegistration<unknown, unknown>) {
    this.contract = registration.contract;
    this.schema = registration.schema === undefined ? undefined : Object.freeze({ ...registration.schema });
    this.owner = registration.owner ?? AppOwner;
    internals.set(this, { handler: registration.handler, request: registration.request });
    Object.freeze(this);
  }

  /**
   * 解码载荷、执行、编码响应；不经管道
   *
   * @remarks
   * 宿主端点已在管道里时用它。载荷不合法为 `KERNEL_VALIDATION_001`（见 {@link decodePayload}），响应无法编码为 JSON 时为 `KERNEL_UNEXPECTED_001`
   */
  async execute(context: InvocationContext, payload?: string | Uint8Array): Promise<OperationResponse> {
    const { handler, request: shape } = internalsOf(this);
    const request = decodePayload(this.contract.id, payload, shape);
    if (!request.ok) {
      return { outcome: request.toVoid(), payload: undefined };
    }
    const result = await handler(context, request.value);
    if (!result.ok) {
      return { outcome: result.toVoid(), payload: undefined };
    }
    const encoded = encodeResponse(result.value);
    return encoded.ok
      ? { outcome: Result.success(), payload: encoded.value }
      : { outcome: encoded.toVoid(), payload: undefined };
  }
}

/**
 * 取描述的内部入口
 *
 * @internal
 */
export function internalsOf(descriptor: OperationDescriptor): Internals {
  const entry = internals.get(descriptor);
  if (entry === undefined) {
    throw new FrameworkError(ErrorCode.InvalidArgument, 'The operation descriptor was not created by a registry.');
  }
  return entry;
}

/**
 * 操作登记表：ID 唯一，容量 {@link OperationRegistry.capacity}
 *
 * @remarks
 * 登记与查找都是同步的，检查与写入之间没有让出事件循环，不需要锁
 */
export class OperationRegistry {
  /** 登记表的容量（RFC-0011） */
  static readonly capacity = 10_000;

  readonly #descriptors = new Map<string, OperationDescriptor>();

  /**
   * 登记一个操作
   *
   * @throws {@link FrameworkError} 契约或参数不合法为 `PRIMITIVES_VALIDATION_001`，ID 重复为 `KERNEL_OPERATION_001`，
   * 登记表已满为 `KERNEL_OPERATION_002`
   */
  add<Req, Res>(registration: OperationRegistration<Req, Res>): OperationDescriptor {
    const { contract } = registration;
    checkContract(contract);
    if (typeof registration.handler !== 'function') {
      throw invalid(`The operation '${contract.id}' needs a handler function.`);
    }
    if (!(registration.request instanceof RequestShape)) {
      throw invalid(`The operation '${contract.id}' needs a request shape.`);
    }
    if (registration.owner !== undefined && (typeof registration.owner !== 'string' || registration.owner === '')) {
      throw invalid(`The owner of the operation '${contract.id}' must not be empty.`);
    }
    if (registration.schema !== undefined) {
      checkSchema(contract.id, 'request', registration.schema.request);
      checkSchema(contract.id, 'response', registration.schema.response);
    }
    // 配置期的两个错误以 FrameworkError 抛出，码、键与参数与宿主一致（RFC-0011「错误码」）
    const existing = this.#descriptors.get(contract.id);
    if (existing !== undefined) {
      throw FrameworkError.fromMessage(OperationErrorCode.Duplicate, OperationMessageKey.Duplicate, {
        id: contract.id,
        owner: existing.owner,
      });
    }
    // 容量是硬上限：登记表不随插件或配置无界增长
    if (this.#descriptors.size >= OperationRegistry.capacity) {
      throw FrameworkError.fromMessage(OperationErrorCode.RegistryFull, OperationMessageKey.RegistryFull, {
        capacity: OperationRegistry.capacity,
      });
    }
    const descriptor = new OperationDescriptor(registration as unknown as OperationRegistration<unknown, unknown>);
    this.#descriptors.set(contract.id, descriptor);
    return descriptor;
  }

  /**
   * 按 ID 取描述；没有时为 `undefined`
   */
  find(id: string): OperationDescriptor | undefined {
    return this.#descriptors.get(id);
  }

  /**
   * 按 ID 升序（码元序）列出全部描述
   */
  list(): readonly OperationDescriptor[] {
    return Object.freeze(
      [...this.#descriptors.values()].sort((left, right) =>
        left.contract.id < right.contract.id ? -1 : left.contract.id > right.contract.id ? 1 : 0,
      ),
    );
  }

  /** 已登记的操作数 */
  get size(): number {
    return this.#descriptors.size;
  }
}

/**
 * 操作未登记的失败
 *
 * @internal
 */
export function notFound(id: string): ErrorInfo {
  return ErrorInfo.notFound(OperationErrorCode.NotFound, OperationMessageKey.NotFound, { id });
}

/**
 * 解码载荷（RFC-0011 规则 2，ADR-0236）
 *
 * @remarks
 * 没有或长度为零的载荷等价于 `{}`。先过共同的 JSON 读取检查：语法错误（含 BOM、嵌套超过 64 层、非法 UTF-8、孤立的代理项）
 * 的 `reason` 一律是 `$`，任何一层有重复成员时是第一处重复的路径，先于其他问题；再按请求的形状在文本顺序里报第一处不符；
 * 最后构建请求，自定义形状报告的路径照用，请求是 `null`（如载荷是字面量 `null`）时为 `$`。失败都是 `KERNEL_VALIDATION_001`
 *
 * @internal
 */
export function decodePayload(
  id: string,
  payload: string | Uint8Array | undefined,
  shape: RequestShape<unknown>,
): Result<unknown> {
  const read = readJsonText(payload === undefined || payload.length === 0 ? '{}' : payload);
  if (!read.ok) {
    return invalidPayload(id, read.problem.path);
  }
  const problem = shape.check(read.root, JsonPath.root);
  if (problem !== undefined) {
    return invalidPayload(id, problem);
  }
  let request: unknown;
  try {
    request = shape.build(read.root, JsonPath.root);
  } catch (error) {
    if (error instanceof RequestDecodeError) {
      return invalidPayload(id, error.path.startsWith(JsonPath.root) ? error.path : JsonPath.root);
    }
    throw error;
  }
  // 请求与成功值一样不能为空：载荷是 null 时没有给出请求
  if (request === null || request === undefined) {
    return invalidPayload(id, JsonPath.root);
  }
  return Result.ok(request);
}

function invalidPayload(id: string, reason: string): Result<never> {
  return Result.fail(
    ErrorInfo.validation(OperationErrorCode.InvalidPayload, OperationMessageKey.InvalidPayload, { id, reason }),
  );
}

/**
 * 编码响应；值无法编码为 JSON（bigint、循环引用、函数）时是 `KERNEL_UNEXPECTED_001`
 *
 * @internal
 */
export function encodeResponse(value: unknown): Result<string> {
  try {
    return Result.ok(writeJson(value, { nonFinite: 'reject' }));
  } catch (error) {
    return Result.fail(
      ErrorInfo.unexpected(
        OperationErrorCode.Unexpected,
        InvocationMessageKey.UnhandledException,
        undefined,
        error instanceof FrameworkError ? error.toErrorInfo() : undefined,
      ),
    );
  }
}

function checkSchema(id: string, part: 'request' | 'response', schema: string): void {
  let parsed: unknown;
  try {
    parsed = typeof schema === 'string' ? JSON.parse(schema) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed)) {
    throw invalid(`The ${part} schema of the operation '${id}' must be a JSON object.`);
  }
}

function invalid(message: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, message);
}
