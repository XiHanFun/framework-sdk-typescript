import { ErrorCode } from './error-code.ts';
import type { ErrorInfo } from './error-info.ts';
import { FrameworkError } from './framework.ts';
import { Float64, type JsonValue } from './json.ts';
import { Result } from './result.ts';

/**
 * 可能没有的值（RFC-0001 Maybe&lt;T&gt;）
 *
 * @remarks
 * 判别字段是 `hasValue`：`if (maybe.hasValue) maybe.value` 即可收窄。有值时值不能为 `null` 或 `undefined`。
 * 线上编码：有值为值本身，无值为 `null`
 */
export type Maybe<T> = Some<T> | None<T>;

/**
 * {@link Some} 与 {@link None} 共同的方法
 *
 * @remarks
 * 两者从同一个基类继承方法，`Maybe<T>` 联合上的方法调用才能解析成一个签名；不要直接继承它
 */
export abstract class MaybeBase<T> {
  /** 是否有值 */
  abstract readonly hasValue: boolean;

  /**
   * 返回值，无值时返回备选值
   */
  valueOr(fallback: T): T {
    return this.hasValue ? (this as unknown as Some<T>).value : fallback;
  }

  /**
   * 返回值
   *
   * @throws {@link FrameworkError} 无值时，码为 `PRIMITIVES_VALIDATION_001`
   */
  valueOrThrow(): T {
    if (!this.hasValue) {
      throw new FrameworkError(ErrorCode.InvalidArgument, 'The maybe has no value.');
    }
    return (this as unknown as Some<T>).value;
  }

  /**
   * 按有值或无值分别求值
   */
  match<U>(onSome: (value: T) => U, onNone: () => U): U {
    return this.hasValue ? onSome((this as unknown as Some<T>).value) : onNone();
  }

  /**
   * 变换有值的 Maybe；无值原样传递，变换得到 `null` 或 `undefined` 时为无值
   */
  map<U>(transform: (value: T) => U | null | undefined): Maybe<U> {
    return this.hasValue ? Maybe.from(transform((this as unknown as Some<T>).value)) : Maybe.none<U>();
  }

  /**
   * 把值交给返回 Maybe 的函数；无值原样传递
   */
  bind<U>(next: (value: T) => Maybe<U>): Maybe<U> {
    return this.hasValue ? next((this as unknown as Some<T>).value) : Maybe.none<U>();
  }

  /**
   * 把无值转成给定错误的失败
   */
  toResult(error: ErrorInfo): Result<T> {
    return this.hasValue ? Result.ok((this as unknown as Some<T>).value) : Result.fail(error);
  }

  /**
   * 线上编码：有值为值本身，无值为 `null`
   */
  toJSON(): unknown {
    if (!this.hasValue) {
      return null;
    }
    const value: unknown = (this as unknown as Some<T>).value;
    // JSON.stringify 不会再调用 toJSON 返回值自己的 toJSON，所以这里替它调用；Float64 原样交出，让 writeJson 仍按浮点写
    if (
      typeof value === 'object' &&
      value !== null &&
      !(value instanceof Float64) &&
      typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ) {
      return (value as { toJSON(): unknown }).toJSON();
    }
    return value;
  }
}

/**
 * 有值的 Maybe
 */
export class Some<T> extends MaybeBase<T> {
  /** 判别字段：有值 */
  readonly hasValue = true as const;
  /** 值 */
  readonly value: T;

  /** @internal 用 {@link Maybe.some} 创建 */
  constructor(value: T) {
    super();
    this.value = value;
    Object.freeze(this);
  }

  /** `Some(值)`，便于日志 */
  override toString(): string {
    return `Some(${String(this.value)})`;
  }
}

/**
 * 无值的 Maybe
 */
export class None<T> extends MaybeBase<T> {
  /** 判别字段：无值 */
  readonly hasValue = false as const;

  /** @internal 用 {@link Maybe.none} 取得 */
  constructor() {
    super();
    Object.freeze(this);
  }

  /** `None`，便于日志 */
  override toString(): string {
    return 'None';
  }
}

/** 无值只需要一个实例 */
const nothing = new None<never>();

/**
 * 创建与还原 {@link Maybe}
 */
export const Maybe = Object.freeze({
  /**
   * 创建有值的 Maybe
   *
   * @throws {@link FrameworkError} 值为 `null` 或 `undefined` 时；可能为空的值用 {@link Maybe.from}
   */
  some<T>(value: T): Maybe<T> {
    if (value === null || value === undefined) {
      throw new FrameworkError(ErrorCode.InvalidArgument, 'A maybe with a value needs a value that is not null.');
    }
    return new Some(value);
  },

  /**
   * 取得无值的 Maybe
   */
  none<T = never>(): Maybe<T> {
    return nothing as None<T>;
  },

  /**
   * 把可能为空的值转成 Maybe：`null` 与 `undefined` 为无值
   */
  from<T>(value: T | null | undefined): Maybe<T> {
    return value === null || value === undefined ? (nothing as None<T>) : new Some(value);
  },

  /**
   * 从线上编码还原：`null` 为无值，其他值交给 `decode` 转换
   *
   * @remarks
   * `decode` 抛出的异常原样传出
   */
  fromJSON<T>(json: JsonValue, decode: (value: JsonValue) => T): Maybe<T> {
    return json === null ? (nothing as None<T>) : Maybe.some(decode(json));
  },
});
