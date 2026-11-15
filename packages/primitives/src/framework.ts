import { ErrorCode, isErrorCode } from './error-code.ts';
import { ErrorInfo } from './error-info.ts';

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

  /**
   * 创建配置或编程错误
   *
   * @param code - 错误码
   * @param message - 面向开发者的英文句子，标识符加单引号
   * @param options - 可带底层原因 `cause`
   */
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }

  /**
   * 转成可上线的 {@link ErrorInfo}：没有消息键，文案就是本错误的消息
   *
   * @remarks
   * 码不合法时用 `PRIMITIVES_VALIDATION_001`，与 Go SDK 的 `ToError` 一致
   */
  toErrorInfo(): ErrorInfo {
    const code = isErrorCode(this.code) ? this.code : ErrorCode.InvalidArgument;
    return ErrorInfo.literal(code, this.message);
  }
}
