import { builtInMessages } from './built-in-messages.ts';
import { ErrorCode, isErrorCode } from './error-code.ts';
import { ErrorInfo } from './error-info.ts';
import { freezeJsonObject, type JsonObject } from './json.ts';
import { describe, isMessageKey } from './messages.ts';

/**
 * 框架信息（RFC-0001 FrameworkInfo）
 */
export const FrameworkInfo = Object.freeze({
  /** 框架名 */
  name: 'XiHan Framework',
  /** 本 SDK 实现的原语层大版本 */
  specVersion: '1',
  /** 插件握手时上报的 SDK 名 */
  sdkName: 'framework-sdk-typescript',
  /** 本 SDK 的版本 */
  sdkVersion: '0.1.0',
  /** SDK 仓库地址 */
  repository: 'https://github.com/XiHanFun/framework-sdk-typescript',
  /** 文档地址 */
  documentation: 'https://framework.docs.xihanfun.com',
} as const);

/**
 * {@link FrameworkError} 的选项
 */
export interface FrameworkErrorOptions extends ErrorOptions {
  /** 消息键：与宿主共用的错误（如操作 ID 重复登记）带上它，接收方可以按自己的目录翻译 */
  readonly messageKey?: string;
  /** 模板参数 */
  readonly details?: JsonObject;
}

/**
 * 配置或编程错误（RFC-0001 FrameworkException）
 *
 * @remarks
 * 带错误码，消息是英文、不本地化；参数非法、清单不合法、管道登记冲突这类编程错误以它抛出。
 * 可恢复的业务失败用 {@link ErrorInfo} 与 {@link Result}，不用它
 */
export class FrameworkError extends Error {
  /** 错误名，便于日志区分 */
  override readonly name = 'FrameworkError';
  /** 错误码 `<领域大写>_<KIND>_<NNN>` */
  readonly code: string;
  /** 消息键；只有与宿主共用的错误才有 */
  readonly messageKey: string | undefined;
  /** 模板参数；只有与宿主共用的错误才有 */
  readonly details: JsonObject | undefined;

  /**
   * 创建配置或编程错误
   *
   * @param code - 错误码
   * @param message - 面向开发者的英文句子，标识符加单引号
   * @param options - 可带底层原因 `cause`，以及与宿主共用的消息键与参数
   */
  constructor(code: string, message: string, options?: FrameworkErrorOptions) {
    super(message, options);
    this.code = code;
    this.messageKey = options?.messageKey;
    this.details = options?.details === undefined ? undefined : freezeJsonObject(options.details, 'details');
  }

  /**
   * 用消息键与参数创建：消息是 SDK 自带的英文模板填入参数（RFC-0011「错误码」）
   *
   * @remarks
   * 配置期与宿主共用的错误（操作 ID 重复登记、登记表已满）以它抛出，码、键与参数与宿主一致
   */
  static fromMessage(code: string, messageKey: string, details?: JsonObject): FrameworkError {
    const message = builtInMessages.resolve(messageKey, 'en-US', details) ?? describe(messageKey, details);
    return new FrameworkError(code, message, details === undefined ? { messageKey } : { messageKey, details });
  }

  /**
   * 转成可上线的 {@link ErrorInfo}
   *
   * @remarks
   * 有消息键时带上键与参数，文案就是本错误的消息；没有时是 Literal。线上的 `code` 必须合文法（RFC-0001「Result」），
   * 码不合法时换成原语参数非法的 `PRIMITIVES_VALIDATION_001`
   */
  toErrorInfo(): ErrorInfo {
    const code = isErrorCode(this.code) ? this.code : ErrorCode.InvalidArgument;
    if (this.messageKey !== undefined && isMessageKey(this.messageKey)) {
      return ErrorInfo.create(code, this.messageKey, this.details).withText(this.message);
    }
    return ErrorInfo.literal(code, this.message, this.details);
  }
}
