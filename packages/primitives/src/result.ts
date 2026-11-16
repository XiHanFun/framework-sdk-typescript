import { ErrorCode } from './error-code.ts';
import { ErrorInfo, type ErrorInfoJson } from './error-info.ts';
import { FrameworkError } from './framework.ts';
import { isPlainObject, type JsonValue, parseJson } from './json.ts';
import { Maybe } from './maybe.ts';

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

  /**
   * 从线上编码还原值类型为 Maybe 的结果：`value` 必填，`null` 即无值，其他值交给 `decode` 转换
   *
   * @throws {@link FrameworkError} 不合 RFC-0001「Result」的读写规则时；`decode` 抛出的异常原样传出
   */
  fromJSONMaybe<T>(json: unknown, decode: (value: JsonValue) => T): Result<Maybe<T>> {
    return read(json, (wire) => {
      if (!Object.hasOwn(wire, 'value')) {
        throw invalidWire('A successful result on the wire needs a value.');
      }
      const value = wire.value as JsonValue;
      return Result.ok(value === null ? Maybe.none<T>() : Maybe.some(decode(value)));
    });
  },

  parse,

  /**
   * 从 JSON 文本还原值类型为 Maybe 的结果；同一层的重复成员名不合法，其余规则同 {@link Result.fromJSONMaybe}
   *
   * @throws {@link FrameworkError} 不是 JSON、有重复成员或不合读写规则时
   */
  parseMaybe<T>(text: string, decode: (value: JsonValue) => T): Result<Maybe<T>> {
    return Result.fromJSONMaybe(parseJson(text), decode);
  },
});

/**
 * 从 JSON 文本还原没有值的结果
 *
 * @remarks
 * 同一层的重复成员名不合法（`JSON.parse` 会悄悄取最后一个，ADR-0235）；其余规则同 {@link Result.fromJSON}
 *
 * @throws {@link FrameworkError} 不是 JSON、有重复成员或不合读写规则时
 */
function parse(text: string): Result<void>;
/**
 * 从 JSON 文本还原带值的结果，成功值交给 `decode` 转换
 *
 * @throws {@link FrameworkError} 不是 JSON、有重复成员或不合读写规则时；`decode` 抛出的异常原样传出
 */
function parse<T>(text: string, decode: (value: JsonValue) => T): Result<T>;
function parse<T>(text: string, decode?: (value: JsonValue) => T): Result<T> | Result<void> {
  const json = parseJson(text);
  return decode === undefined ? fromJSON(json) : fromJSON(json, decode);
}

/**
 * 从线上编码还原没有值的结果
 *
 * @remarks
 * 读写规则见 RFC-0001「Result」：无值成功只能是 `{"ok":true}`，带了 `value`（含 `{}` 与 `null`）即不合法；
 * 成功不能带 `error`，失败必须带 `error`、不能带 `value`；未知成员忽略
 *
 * @throws {@link FrameworkError} 不合规则时，码为 `PRIMITIVES_VALIDATION_001`
 */
function fromJSON(json: unknown): Result<void>;
/**
 * 从线上编码还原带值的结果，成功值交给 `decode` 转换
 *
 * @remarks
 * 有值成功的 `value` 必填且不能是 `null`；值类型是 Maybe 时用 {@link Result.fromJSONMaybe}
 *
 * @throws {@link FrameworkError} 不合规则时；`decode` 抛出的异常原样传出
 */
function fromJSON<T>(json: unknown, decode: (value: JsonValue) => T): Result<T>;
function fromJSON<T>(json: unknown, decode?: (value: JsonValue) => T): Result<T> | Result<void> {
  if (decode === undefined) {
    return read<void>(json, (wire) => {
      if (Object.hasOwn(wire, 'value')) {
        throw invalidWire("A successful result without a value must not carry 'value' on the wire.");
      }
      return succeeded;
    });
  }
  return read<T>(json, (wire) => {
    if (!Object.hasOwn(wire, 'value')) {
      throw invalidWire('A successful result on the wire needs a value.');
    }
    if (wire.value === null) {
      throw invalidWire('The value of a successful result on the wire must not be null.');
    }
    return Result.ok(decode(wire.value as JsonValue));
  });
}

/** 读出外层：`ok` 必填且是布尔，成功与失败互斥地带 `value` 或 `error`；成功的值交给 `success` 处理 */
function read<T>(json: unknown, success: (wire: Record<string, unknown>) => Result<T>): Result<T> {
  if (!isPlainObject(json) || typeof json.ok !== 'boolean') {
    throw invalidWire("A result on the wire must be a JSON object with a boolean 'ok'.");
  }
  if (json.ok) {
    if (Object.hasOwn(json, 'error')) {
      throw invalidWire("A successful result on the wire must not carry 'error'.");
    }
    return success(json);
  }
  if (Object.hasOwn(json, 'value')) {
    throw invalidWire("A failed result on the wire must not carry 'value'.");
  }
  if (!Object.hasOwn(json, 'error')) {
    throw invalidWire('A failed result on the wire needs an error.');
  }
  return Result.fail<T>(ErrorInfo.fromJSON(json.error));
}

function invalidWire(message: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, message);
}
