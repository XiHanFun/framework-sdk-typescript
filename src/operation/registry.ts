import { type InvocationContext, InvocationMessageKey } from '../invocation/index.ts';
import { AppOwner } from '../pipeline/index.ts';
import {
  ErrorInfo,
  FrameworkError,
  isPlainObject,
  JsonPath,
  Result,
  readJsonText,
  writeJson,
} from '../primitives/index.ts';
import { compareOrdinal } from '../primitives/ordinal.ts';

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
 *
 * @remarks
 * 可以直接返回 Result，也可以返回它的 Promise：不做异步的事的处理器不必写成 `async`
 */
export type OperationHandler<Req, Res> = (
  context: InvocationContext,
  request: Req,
) => Result<Res> | Promise<Result<Res>>;

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
    throw FrameworkError.invalidArgument('The operation descriptor was not created by a registry.');
  }
  return entry;
}

/**
 * {@link OperationRegistry} 的选项
 */
export interface OperationRegistryOptions {
  /** 容量上限，至少为 1 的整数；缺省为 {@link OperationRegistry.capacity} */
  readonly capacity?: number;
}

/**
 * 操作登记表：ID 唯一，容量有界（缺省 {@link OperationRegistry.capacity}）
 *
 * @remarks
 * 登记与查找都是同步的，检查与写入之间没有让出事件循环，不需要锁
 */
export class OperationRegistry {
  /** 登记表的缺省容量（RFC-0011） */
  static readonly capacity = 10_000;

  /** 这张登记表的容量：满了之后登记以 `KERNEL_OPERATION_002` 失败，参数 `capacity` 就是它 */
  readonly capacity: number;

  readonly #descriptors = new Map<string, OperationDescriptor>();

  /**
   * 创建登记表
   *
   * @param options - 可给出容量；缺省为 {@link OperationRegistry.capacity}，与 .NET 的 `OperationRegistry.DefaultCapacity` 相同
   * @throws {@link FrameworkError} 容量不是至少为 1 的整数时，码为 `PRIMITIVES_VALIDATION_001`
   */
  constructor(options: OperationRegistryOptions = {}) {
    const capacity = options.capacity ?? OperationRegistry.capacity;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw FrameworkError.invalidArgument('The capacity of an operation registry must be an integer of at least 1.');
    }
    this.capacity = capacity;
  }

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
      throw FrameworkError.invalidArgument(`The operation '${contract.id}' needs a handler function.`);
    }
    if (!(registration.request instanceof RequestShape)) {
      throw FrameworkError.invalidArgument(`The operation '${contract.id}' needs a request shape.`);
    }
    if (registration.owner !== undefined && (typeof registration.owner !== 'string' || registration.owner === '')) {
      throw FrameworkError.invalidArgument(`The owner of the operation '${contract.id}' must not be empty.`);
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
    if (this.#descriptors.size >= this.capacity) {
      throw FrameworkError.fromMessage(OperationErrorCode.RegistryFull, OperationMessageKey.RegistryFull, {
        capacity: this.capacity,
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
      [...this.#descriptors.values()].sort((left, right) => compareOrdinal(left.contract.id, right.contract.id)),
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
 * 编码响应（RFC-0011 规则 10 的「编码」）；写不出时是 `KERNEL_UNEXPECTED_001` + `kernel.invocation.unhandled_exception`
 *
 * @remarks
 * 写不出：非有限的浮点、循环引用、没有 JSON 表示的值，以及写不成合法 JSON 文本的字符串——成员名与值里孤立的代理项不写成
 * `\ud800` 这样的转义交给宿主（ADR-0318）。写出的整段文本还要过 RFC-0001「JSON 文本」的共同检查（ADR-0319）：嵌套超过 64 层
 * （从响应的根算起，`toJSON` 交出的与读进来的任意 JSON 也算）或同一个对象里有重复的成员名（`JsonMembers` 写得出）同样写不出。
 * 这些都由 `writeJson` 边写边核对，不先写完再读一遍：语法、数字与 Unicode 本来就由它保证，深度与成员名靠计数与每个
 * `JsonMembers` 一个名字集合，开销与写出本身同阶。`toJSON` 抛出的 {@link FrameworkError} 放进 `inner`，`writeJson` 的
 * `TypeError` 不带
 *
 * @internal
 */
export function encodeResponse(value: unknown): Result<string> {
  try {
    return Result.ok(
      writeJson(value, {
        nonFinite: 'reject',
        loneSurrogates: 'reject',
        nesting: 'reject',
        duplicateMembers: 'reject',
      }),
    );
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
    throw FrameworkError.invalidArgument(`The ${part} schema of the operation '${id}' must be a JSON object.`);
  }
}
