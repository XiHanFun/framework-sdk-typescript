import { builtInMessages } from './built-in-messages.ts';
import { ErrorCode, ErrorKind, errorCodeDomain, errorCodeKind, invalidErrorCode, isErrorCode } from './error-code.ts';
import { FrameworkError } from './framework.ts';
import { freezeJsonObject, isPlainObject, type JsonObject } from './json.ts';
import { parseJson } from './json-text.ts';
import { describe, isMessageKey, resolveMessage } from './messages.ts';

/**
 * {@link ErrorInfo} 的线上编码（RFC-0001）
 *
 * @remarks
 * `message` 是发送端已解析的文案，`messageKey` 让接收端可以按自己的区域再翻译
 */
export interface ErrorInfoJson {
  readonly code: string;
  readonly message: string;
  readonly messageKey?: string;
  readonly details?: JsonObject;
  readonly inner?: ErrorInfoJson;
}

/**
 * 可恢复失败的描述（RFC-0001 Error）：错误码面向程序，消息键与参数面向人
 *
 * @remarks
 * 不可变，`with` 开头的方法返回新值。它不是异常，不用 `throw`：失败经 {@link Result} 返回。
 * 规范里叫 Error，在 TypeScript 里改名以免遮蔽全局的 `Error`
 */
export class ErrorInfo {
  /** 错误码 `<领域大写>_<KIND>_<NNN>` */
  readonly code: string;
  /** 消息键；{@link ErrorInfo.literal} 创建的为 `undefined` */
  readonly messageKey: string | undefined;
  /** 已解析的文案；未解析为 `undefined` */
  readonly text: string | undefined;
  /** 模板参数，也是结构化细节；只含 JSON 可表示的值（数字按值模型），键按升序、深度冻结 */
  readonly details: JsonObject | undefined;
  /** 内部错误 */
  readonly inner: ErrorInfo | undefined;

  private constructor(
    code: string,
    messageKey: string | undefined,
    text: string | undefined,
    details: JsonObject | undefined,
    inner: ErrorInfo | undefined,
  ) {
    this.code = code;
    this.messageKey = messageKey;
    this.text = text;
    this.details = details;
    this.inner = inner;
    Object.freeze(this);
  }

  /**
   * 用错误码与消息键创建错误
   *
   * @throws {@link FrameworkError} 码或键不合法、细节不是 JSON 可表示的值时，码为 `PRIMITIVES_VALIDATION_001`
   */
  static create(code: string, messageKey: string, details?: JsonObject, inner?: ErrorInfo): ErrorInfo {
    checkCode(code);
    if (!isMessageKey(messageKey)) {
      throw new FrameworkError(
        ErrorCode.InvalidArgument,
        `The message key '${messageKey}' must match <domain>.<segment>[.<segment>].`,
      );
    }
    return new ErrorInfo(code, messageKey, undefined, copyDetails(details), checkInner(inner));
  }

  /**
   * 用已解析的文案创建错误：线上还原与异常转换用，没有消息键
   *
   * @throws {@link FrameworkError} 码不合法或文案为空时
   */
  static literal(code: string, text: string, details?: JsonObject, inner?: ErrorInfo): ErrorInfo {
    checkCode(code);
    if (typeof text !== 'string' || text === '') {
      throw new FrameworkError(ErrorCode.InvalidArgument, 'A literal error needs a text.');
    }
    return new ErrorInfo(code, undefined, text, copyDetails(details), checkInner(inner));
  }

  /** 创建 VALIDATION 类错误；码的 KIND 段不是 VALIDATION 时抛出 {@link FrameworkError} */
  static validation(code: string, messageKey: string, details?: JsonObject): ErrorInfo {
    return ofKind(ErrorKind.Validation, code, messageKey, details, undefined);
  }

  /** 创建 NOTFOUND 类错误 */
  static notFound(code: string, messageKey: string, details?: JsonObject): ErrorInfo {
    return ofKind(ErrorKind.NotFound, code, messageKey, details, undefined);
  }

  /** 创建 CONFLICT 类错误 */
  static conflict(code: string, messageKey: string, details?: JsonObject): ErrorInfo {
    return ofKind(ErrorKind.Conflict, code, messageKey, details, undefined);
  }

  /** 创建 DENIED 类错误 */
  static denied(code: string, messageKey: string, details?: JsonObject): ErrorInfo {
    return ofKind(ErrorKind.Denied, code, messageKey, details, undefined);
  }

  /** 创建 UNAVAILABLE 类错误 */
  static unavailable(code: string, messageKey: string, details?: JsonObject): ErrorInfo {
    return ofKind(ErrorKind.Unavailable, code, messageKey, details, undefined);
  }

  /** 创建 TIMEOUT 类错误 */
  static timeout(code: string, messageKey: string, details?: JsonObject): ErrorInfo {
    return ofKind(ErrorKind.Timeout, code, messageKey, details, undefined);
  }

  /** 创建 CANCELLED 类错误 */
  static cancelled(code: string, messageKey: string, details?: JsonObject): ErrorInfo {
    return ofKind(ErrorKind.Cancelled, code, messageKey, details, undefined);
  }

  /**
   * 创建 UNEXPECTED 类错误，可带内部错误
   *
   * @remarks
   * 参数顺序与 {@link ErrorInfo.create} 一致：先细节、后内部错误（RFC-0001，ADR-0137）
   */
  static unexpected(code: string, messageKey: string, details?: JsonObject, inner?: ErrorInfo): ErrorInfo {
    return ofKind(ErrorKind.Unexpected, code, messageKey, details, inner);
  }

  /**
   * 从 JSON 文本还原
   *
   * @remarks
   * 先过共同的 JSON 读取检查（{@link readJsonText}，ADR-0236）：任何一层的重复成员都不合法，含 `details` 与 `inner` 的内部；
   * 细节里的数字按值模型读，64 位范围内的整数精确。其余规则同 {@link ErrorInfo.fromJSON}
   *
   * @throws {@link FrameworkError} 不是 JSON、有重复成员或不合读写规则时，码为 `PRIMITIVES_VALIDATION_001`
   */
  static parse(text: string | Uint8Array): ErrorInfo {
    return ErrorInfo.fromJSON(parseJson(text));
  }

  /**
   * 从线上编码还原
   *
   * @remarks
   * 读写规则见 RFC-0001「Result」：`code` 必填且合文法，`message` 必填且非空，成为 {@link ErrorInfo.text}；
   * `messageKey`、`details`、`inner` 可选，写了就必须合法，写成 `null` 不合法；未知成员忽略。
   * 已解析的值里看不出重复成员，从文本读取时用 {@link ErrorInfo.parse}
   *
   * @throws {@link FrameworkError} 不合规则时，码为 `PRIMITIVES_VALIDATION_001`
   */
  static fromJSON(value: unknown): ErrorInfo {
    if (!isPlainObject(value)) {
      throw invalidWire('An error on the wire must be a JSON object.');
    }
    const code = value.code;
    if (typeof code !== 'string' || !isErrorCode(code)) {
      throw invalidErrorCode(typeof code === 'string' ? code : String(code));
    }
    const message = value.message;
    if (typeof message !== 'string' || message === '') {
      throw invalidWire("The field 'message' of an error on the wire must be a string that is not empty.");
    }
    let messageKey: string | undefined;
    if (Object.hasOwn(value, 'messageKey')) {
      if (typeof value.messageKey !== 'string' || !isMessageKey(value.messageKey)) {
        throw invalidWire(`The message key '${String(value.messageKey)}' of an error on the wire is not valid.`);
      }
      messageKey = value.messageKey;
    }
    let details: JsonObject | undefined;
    if (Object.hasOwn(value, 'details')) {
      if (!isPlainObject(value.details)) {
        throw invalidWire("The field 'details' of an error on the wire must be a JSON object.");
      }
      details = freezeJsonObject(value.details, 'details');
    }
    const inner = Object.hasOwn(value, 'inner') ? ErrorInfo.fromJSON(value.inner) : undefined;
    return new ErrorInfo(code, messageKey, message, details, inner);
  }

  /** 错误码的 KIND 段 */
  get kind(): string {
    return errorCodeKind(this.code) ?? '';
  }

  /** 错误码的领域段 */
  get domain(): string {
    return errorCodeDomain(this.code) ?? '';
  }

  /**
   * 面向人的消息
   *
   * @remarks
   * 依次取：已解析文案；按进程默认区域解析的消息键（见 {@link setDefaultMessages}）；SDK 自带的英文模板
   * （{@link builtInMessages}）；`键 (参数)` 的描述。消息不参与程序判断
   */
  get message(): string {
    if (this.text !== undefined) {
      return this.text;
    }
    if (this.messageKey === undefined) {
      // 只有文案缺失的编程错误才会走到这里：工厂与线上还原都保证有文案或有键
      return this.code;
    }
    return (
      resolveMessage(this.messageKey, this.details) ??
      builtInMessages.resolve(this.messageKey, 'en-US', this.details) ??
      describe(this.messageKey, this.details)
    );
  }

  /**
   * 换错误码，保留键、文案、参数与内部错误
   *
   * @throws {@link FrameworkError} 新码不合法时
   */
  withCode(code: string): ErrorInfo {
    checkCode(code);
    return new ErrorInfo(code, this.messageKey, this.text, this.details, this.inner);
  }

  /**
   * 填入已解析的文案
   *
   * @throws {@link FrameworkError} 文案为空时
   */
  withText(text: string): ErrorInfo {
    if (typeof text !== 'string' || text === '') {
      throw new FrameworkError(ErrorCode.InvalidArgument, 'The text of an error must not be empty.');
    }
    return new ErrorInfo(this.code, this.messageKey, text, this.details, this.inner);
  }

  /**
   * 线上编码：字段顺序 `code`、`message`、`messageKey`、`details`、`inner`，没有的省略
   *
   * @remarks
   * 空的 `details` 省略，与 Go SDK 一致。细节里可以有 `bigint`、{@link Float64} 与非有限的浮点，
   * 写成文本用 {@link writeJson}：`JSON.stringify` 写不出 `bigint`，也分不出整数与整数值的浮点
   */
  toJSON(): ErrorInfoJson {
    const json: {
      code: string;
      message: string;
      messageKey?: string;
      details?: JsonObject;
      inner?: ErrorInfoJson;
    } = { code: this.code, message: this.message };
    if (this.messageKey !== undefined) {
      json.messageKey = this.messageKey;
    }
    if (this.details !== undefined && Object.keys(this.details).length > 0) {
      json.details = this.details;
    }
    if (this.inner !== undefined) {
      json.inner = this.inner.toJSON();
    }
    return json;
  }

  /** `码: 消息`，便于日志 */
  toString(): string {
    return `${this.code}: ${this.message}`;
  }
}

/** 创建错误并核对 KIND 段与工厂一致 */
function ofKind(
  kind: ErrorKind,
  code: string,
  messageKey: string,
  details: JsonObject | undefined,
  inner: ErrorInfo | undefined,
): ErrorInfo {
  const error = ErrorInfo.create(code, messageKey, details, inner);
  if (error.kind !== kind) {
    throw new FrameworkError(ErrorCode.InvalidArgument, `The error code '${code}' must have the kind ${kind}.`);
  }
  return error;
}

function checkCode(code: string): void {
  if (typeof code !== 'string' || !isErrorCode(code)) {
    throw invalidErrorCode(String(code));
  }
}

function checkInner(inner: ErrorInfo | undefined): ErrorInfo | undefined {
  if (inner !== undefined && !(inner instanceof ErrorInfo)) {
    throw new FrameworkError(ErrorCode.InvalidArgument, 'The inner error must be an ErrorInfo.');
  }
  return inner;
}

function copyDetails(details: JsonObject | undefined): JsonObject | undefined {
  return details === undefined ? undefined : freezeJsonObject(details, 'details');
}

function invalidWire(message: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, message);
}
