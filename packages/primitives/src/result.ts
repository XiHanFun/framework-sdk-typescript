import { ErrorCode } from './error-code.ts';
import { ErrorInfo, type ErrorInfoJson } from './error-info.ts';
import { FrameworkError } from './framework.ts';
import { isPlainObject, type JsonValue } from './json.ts';

/**
 * 成功或失败（RFC-0001 Result / Result&lt;T&gt;）：成功带值，失败带 {@link ErrorInfo}，二者互斥
 *
 * @remarks
 * 判别字段是 `ok`：`if (result.ok) result.value` 即可收窄。成功值不能为 `null` 或 `undefined`；
 * 没有值的成功是 `Result<void>`，由 {@link Result.success} 创建。
 * 线上编码与 .NET 参考实现一致：`{"ok":true,"value":…}`、没有值时 `{"ok":true}`、失败 `{"ok":false,"error":{…}}`
 */
export type Result<T> = Ok<T> | Fail<T>;

/**
 * {@link Ok} 与 {@link Fail} 共同的方法
 *
 * @remarks
 * 两者从同一个基类继承方法，`Result<T>` 联合上的方法调用才能解析成一个签名；不要直接继承它
 */
export abstract class ResultBase<T> {
  /** 是否成功 */
  abstract readonly ok: boolean;

  /**
   * 返回成功值，失败时返回备选值
   */
  valueOr(fallback: T): T {
    return this.ok ? (this as unknown as Ok<T>).value : fallback;
  }

  /**
   * 返回成功值
   *
   * @throws {@link FrameworkError} 失败时，码与消息取自失败的错误
   */
  valueOrThrow(): T {
    if (this.ok) {
      return (this as unknown as Ok<T>).value;
    }
    const error = (this as unknown as Fail<T>).error;
    throw new FrameworkError(error.code, error.message);
  }

  /**
   * 按成功或失败分别求值
   */
  match<U>(onOk: (value: T) => U, onFail: (error: ErrorInfo) => U): U {
    return this.ok ? onOk((this as unknown as Ok<T>).value) : onFail((this as unknown as Fail<T>).error);
  }

  /**
   * 把成功值变换成另一种类型；失败原样传递
   *
   * @throws {@link FrameworkError} 变换返回 `null` 或 `undefined` 时（成功值不能为空）
   */
  map<U>(transform: (value: T) => U): Result<U> {
    return this.ok ? Result.ok(transform((this as unknown as Ok<T>).value)) : (this as unknown as Fail<U>);
  }

  /**
   * 把成功值交给返回 Result 的函数；失败原样传递
   */
  bind<U>(next: (value: T) => Result<U>): Result<U> {
    return this.ok ? next((this as unknown as Ok<T>).value) : (this as unknown as Fail<U>);
  }

  /**
   * 丢掉值，只保留成功与否
   */
  toVoid(): Result<void> {
    return this.ok ? Result.success() : (this as unknown as Fail<void>);
  }
}

/**
 * 成功的结果
 */
export class Ok<T> extends ResultBase<T> {
  /** 判别字段：成功 */
  readonly ok = true as const;
  /** 成功值；`Result<void>` 的为 `undefined` */
  readonly value: T;

  /** @internal 用 {@link Result.ok} 或 {@link Result.success} 创建 */
  constructor(value: T) {
    super();
    this.value = value;
    Object.freeze(this);
  }

  /** `Ok(值)`，便于日志 */
  override toString(): string {
    return `Ok(${String(this.value)})`;
  }
}

/**
 * 失败的结果
 */
export class Fail<T> extends ResultBase<T> {
  /** 判别字段：失败 */
  readonly ok = false as const;
  /** 失败原因 */
  readonly error: ErrorInfo;

  /** @internal 用 {@link Result.fail} 创建 */
  constructor(error: ErrorInfo) {
    super();
    this.error = error;
    Object.freeze(this);
  }

  /** `Fail(码: 消息)`，便于日志 */
  override toString(): string {
    return `Fail(${this.error.toString()})`;
  }
}

/**
 * {@link Result} 的线上编码
 */
export type ResultJson =
  | { readonly ok: true; readonly value?: JsonValue }
  | { readonly ok: false; readonly error: ErrorInfoJson };

/** 没有值的成功只需要一个实例 */
const succeeded: Ok<void> = new Ok<void>(undefined);

/**
 * 创建与还原 {@link Result}
 */
export const Result = Object.freeze({
  /**
   * 创建带值的成功结果
   *
   * @throws {@link FrameworkError} 值为 `null` 或 `undefined` 时；没有值的成功用 {@link Result.success}
   */
  ok<T>(value: T): Result<T> {
    if (value === null || value === undefined) {
      throw new FrameworkError(
        ErrorCode.InvalidArgument,
        'A successful result needs a value; use Result.success() for a result without one.',
      );
    }
    return new Ok(value);
  },

  /**
   * 创建没有值的成功结果
   */
  success(): Result<void> {
    return succeeded;
  },

  /**
   * 创建失败结果
   *
   * @throws {@link FrameworkError} 没有给出 {@link ErrorInfo} 时
   */
  fail<T = never>(error: ErrorInfo): Result<T> {
    if (!(error instanceof ErrorInfo)) {
      throw new FrameworkError(ErrorCode.InvalidArgument, 'A failed result needs an error.');
    }
    return new Fail<T>(error);
  },

  fromJSON,
});

/**
 * 从线上编码还原没有值的结果；成功时线上的 `value` 忽略
 *
 * @throws {@link FrameworkError} 不是 `{"ok":…}` 形态或失败没有错误时
 */
function fromJSON(json: unknown): Result<void>;
/**
 * 从线上编码还原带值的结果，成功值交给 `decode` 转换
 *
 * @throws {@link FrameworkError} 形态不对、成功没有值或失败没有错误时；`decode` 抛出的异常原样传出
 */
function fromJSON<T>(json: unknown, decode: (value: JsonValue) => T): Result<T>;
function fromJSON<T>(json: unknown, decode?: (value: JsonValue) => T): Result<T> | Result<void> {
  if (!isPlainObject(json) || typeof json.ok !== 'boolean') {
    throw new FrameworkError(
      ErrorCode.InvalidArgument,
      "A result on the wire must be a JSON object with a boolean 'ok'.",
    );
  }
  if (json.ok) {
    if (decode === undefined) {
      return succeeded;
    }
    const value = json.value ?? undefined;
    if (value === undefined) {
      throw new FrameworkError(ErrorCode.InvalidArgument, 'A successful result on the wire needs a value.');
    }
    return Result.ok(decode(value as JsonValue));
  }
  const error = json.error ?? undefined;
  if (error === undefined) {
    throw new FrameworkError(ErrorCode.InvalidArgument, 'A failed result on the wire needs an error.');
  }
  return Result.fail<T>(ErrorInfo.fromJSON(error));
}
