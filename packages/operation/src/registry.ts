import type { InvocationContext } from '@xihan-framework/invocation';
import { AppOwner } from '@xihan-framework/pipeline';
import {
  ErrorCode,
  ErrorInfo,
  FrameworkError,
  isPlainObject,
  type JsonValue,
  Result,
} from '@xihan-framework/primitives';

import { checkContract, type OperationContract, OperationErrorCode, OperationMessageKey } from './contract.ts';

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
  /** 请求的 JSON 文本或 UTF-8 字节；没有或只有空白时等价于 `{}` */
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
 * 处理一个操作：可恢复失败经 Result 返回，不抛异常
 */
export type OperationHandler<Req, Res> = (context: InvocationContext, request: Req) => Promise<Result<Res>>;

/**
 * 把已解析的 JSON 载荷转成请求类型
 *
 * @remarks
 * 载荷与请求类型不符时抛出，消息就是 `KERNEL_VALIDATION_001` 细节里的 `reason`：只写路径与原因（如 `$.quantity must be a number`），
 * 不带目标类型名（RFC-0011 规则 2）。可以直接用 Schema 库的解析函数
 */
export type RequestDecoder<Req> = (value: JsonValue) => Req;

/**
 * 一次登记
 */
export interface OperationRegistration<Req, Res> {
  /** 契约 */
  readonly contract: OperationContract<Req, Res>;
  /** 处理器 */
  readonly handler: OperationHandler<Req, Res>;
  /** 请求解码器：XGI 调用用它把 JSON 载荷转成请求 */
  readonly decode: RequestDecoder<Req>;
  /** 请求与响应的 Schema */
  readonly schema?: OperationSchema;
  /** 归属：清单 ID，缺省为 `app` */
  readonly owner?: string;
}

/** 描述的内部入口：调用器用，不对外 */
interface Internals {
  readonly handler: OperationHandler<unknown, unknown>;
  readonly decode: RequestDecoder<unknown>;
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
    internals.set(this, { handler: registration.handler, decode: registration.decode });
    Object.freeze(this);
  }

  /**
   * 解码载荷、执行、编码响应；不经管道
   *
   * @remarks
   * 宿主端点已在管道里时用它。载荷不合法为 `KERNEL_VALIDATION_001`，响应无法编码为 JSON 时为 `KERNEL_UNEXPECTED_001`
   */
  async execute(context: InvocationContext, payload?: string | Uint8Array): Promise<OperationResponse> {
    const { handler, decode } = internalsOf(this);
    const request = decodePayload(this.contract.id, payload, decode);
    if (!request.ok) {
      return { outcome: request.toVoid(), payload: undefined };
    }
    const result = await handler(context, request.value);
    if (!result.ok) {
      return { outcome: result.toVoid(), payload: undefined };
    }
    const encoded = encodeResponse(this.contract.id, result.value);
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
    if (typeof registration.decode !== 'function') {
      throw invalid(`The operation '${contract.id}' needs a request decoder.`);
    }
    if (registration.owner !== undefined && (typeof registration.owner !== 'string' || registration.owner === '')) {
      throw invalid(`The owner of the operation '${contract.id}' must not be empty.`);
    }
    if (registration.schema !== undefined) {
      checkSchema(contract.id, 'request', registration.schema.request);
      checkSchema(contract.id, 'response', registration.schema.response);
    }
    if (this.#descriptors.has(contract.id)) {
      throw new FrameworkError(OperationErrorCode.Duplicate, `The operation '${contract.id}' is already registered.`);
    }
    // 容量是硬上限：登记表不随插件或配置无界增长
    if (this.#descriptors.size >= OperationRegistry.capacity) {
      throw new FrameworkError(
        OperationErrorCode.RegistryFull,
        `The operation registry is full (${OperationRegistry.capacity} operations).`,
      );
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

/** 严格的 UTF-8：坏字节即失败；保留 BOM，让带 BOM 的载荷与 Go 一样按非 JSON 拒绝 */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** 解码载荷：空等价于 `{}`；非 UTF-8、非 JSON、`null` 或解码器拒绝都是 `KERNEL_VALIDATION_001` */
function decodePayload(
  id: string,
  payload: string | Uint8Array | undefined,
  decode: RequestDecoder<unknown>,
): Result<unknown> {
  let text: string;
  try {
    text = payload === undefined ? '' : typeof payload === 'string' ? payload : utf8.decode(payload);
  } catch {
    return invalidPayload(id, 'the payload is not valid UTF-8');
  }
  if (text.trim() === '') {
    text = '{}';
  }
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    // 不带解析器的报错原文：它会引用载荷片段，原因只写结论
    return invalidPayload(id, 'the payload is not valid JSON');
  }
  if (value === null) {
    return invalidPayload(id, 'the payload is null');
  }
  let request: unknown;
  try {
    request = decode(value);
  } catch (error) {
    return invalidPayload(id, error instanceof Error ? error.message : String(error));
  }
  // 请求与成功值一样不能为空：解码器返回空值说明载荷没有给出请求
  if (request === null || request === undefined) {
    return invalidPayload(id, 'the decoder produced no request');
  }
  return Result.ok(request);
}

function invalidPayload(id: string, reason: string): Result<never> {
  return Result.fail(
    ErrorInfo.validation(OperationErrorCode.InvalidPayload, OperationMessageKey.InvalidPayload, { id, reason }),
  );
}

/** 编码响应；值无法编码为 JSON（bigint、循环引用、函数）时是 `KERNEL_UNEXPECTED_001` */
function encodeResponse(id: string, value: unknown): Result<string> {
  let reason: string;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) {
      return Result.ok(json);
    }
    reason = 'the value has no JSON representation';
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  return Result.fail(
    ErrorInfo.literal('KERNEL_UNEXPECTED_001', `The response of '${id}' could not be encoded: ${reason}`),
  );
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
