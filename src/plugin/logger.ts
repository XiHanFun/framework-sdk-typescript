import { defineMember, writeJson } from '../primitives/index.ts';

/**
 * 日志级别：宿主按这些名字转成自己的级别（plugin/invocation.md §6）
 */
export const LogLevel = Object.freeze({
  Trace: 'trace',
  Debug: 'debug',
  Information: 'information',
  Warning: 'warning',
  Error: 'error',
  Critical: 'critical',
} as const);

/**
 * 日志级别之一
 */
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** 级别由低到高 */
const levels: readonly LogLevel[] = Object.values(LogLevel);

/**
 * 日志写到哪里：只要有 `write(text)`，`process.stderr` 即可
 */
export interface LogTarget {
  /** 写一段文本 */
  write(text: string): unknown;
}

/**
 * {@link PluginLogger} 的选项
 */
export interface PluginLoggerOptions {
  /** 最低级别；低于它的不写，缺省为 `information` */
  readonly level?: LogLevel;
  /** 每一行都带的作用域属性 */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/**
 * 把日志写成宿主能解析的结构化行（plugin/invocation.md §6）
 *
 * @remarks
 * 一行一个 JSON 对象：`level`、`message`，其余成员是作用域属性；宿主把以 `{` 开头、能解析为对象的 stderr 行
 * 按结构化日志处理。stdout 只用于握手行，插件日志一律写 stderr
 */
export class PluginLogger {
  readonly #target: LogTarget;
  readonly #minimum: number;
  readonly #fields: Readonly<Record<string, unknown>>;

  /**
   * @param target - 日志写到哪里，通常是 `process.stderr`
   */
  constructor(target: LogTarget, options: PluginLoggerOptions = {}) {
    this.#target = target;
    this.#minimum = levels.indexOf(options.level ?? LogLevel.Information);
    this.#fields = Object.freeze({ ...options.fields });
    Object.freeze(this);
  }

  /**
   * 派生一个多带几个作用域属性的日志器
   */
  with(fields: Readonly<Record<string, unknown>>): PluginLogger {
    return new PluginLogger(this.#target, {
      level: levels[this.#minimum] ?? LogLevel.Information,
      fields: { ...this.#fields, ...fields },
    });
  }

  /**
   * 写一行；级别低于最低级别时什么也不写
   */
  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void {
    if (levels.indexOf(level) < this.#minimum) {
      return;
    }
    const line: Record<string, unknown> = { level, message };
    for (const [name, value] of Object.entries({ ...this.#fields, ...fields })) {
      // level 与 message 是宿主认的两个成员，作用域属性不能覆盖它们，也不能写出重复的成员名
      if (name !== 'level' && name !== 'message') {
        defineMember(line, name, loggable(value));
      }
    }
    let text: string;
    try {
      text = writeJson(line);
    } catch {
      // 写不出的属性（循环引用等）不该让日志丢掉：只留级别与消息
      text = writeJson({ level, message });
    }
    this.#target.write(`${text}\n`);
  }

  /** 写 trace 级别 */
  trace(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log(LogLevel.Trace, message, fields);
  }

  /** 写 debug 级别 */
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log(LogLevel.Debug, message, fields);
  }

  /** 写 information 级别 */
  information(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log(LogLevel.Information, message, fields);
  }

  /** 写 warning 级别 */
  warning(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log(LogLevel.Warning, message, fields);
  }

  /** 写 error 级别 */
  error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log(LogLevel.Error, message, fields);
  }

  /** 写 critical 级别 */
  critical(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log(LogLevel.Critical, message, fields);
  }
}

/** 异常写成 `名字: 消息`；`JSON.stringify` 会把它写成 `{}` */
function loggable(value: unknown): unknown {
  return value instanceof Error ? `${value.name}: ${value.message}` : value;
}
