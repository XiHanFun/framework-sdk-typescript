/**
 * 回声插件 echo：用本 SDK 写的进程外插件示例，也是黑盒运行器一致性测试的被测插件
 *
 * @remarks
 * 能力覆盖运行器的全部用例：四个操作（含一个故意崩溃、测试时排除的 `echoes.crash`）、一个事件订阅、健康项 `echo`、
 * 配置节 `XiHan:Echo` 与宿主回调（`echoes.relay` 经 `Host.Invoke` 调用宿主的操作）
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineContract, Expose, OperationRegistry, RequestShape } from 'xihan-framework/operation';
import {
  findHost,
  HealthStatus,
  loadCatalog,
  type PluginConfiguration,
  type PluginOptions,
} from 'xihan-framework/plugin';
import {
  ErrorInfo,
  type JsonValue,
  LifecycleState,
  MessageCatalog,
  parseJson,
  Result,
  Stability,
  setDefaultMessages,
  writeJson,
} from 'xihan-framework/primitives';

/** 插件自己的错误码与消息键 */
export const EchoErrorCode = Object.freeze({
  /** 配置节不合法 */
  InvalidConfiguration: 'ECHOTS_VALIDATION_001',
  /** `echoes.create` 的文本为空 */
  TextMissing: 'ECHOTS_VALIDATION_002',
  /** 宿主没有下发回调端点 */
  HostUnavailable: 'ECHOTS_UNAVAILABLE_001',
} as const);

/** 插件自己的消息键：模板在 localization/ 里 */
export const EchoMessageKey = Object.freeze({
  InvalidConfiguration: 'echots.configuration.invalid',
  TextMissing: 'echots.text.missing',
  HostUnavailable: 'echots.host.unavailable',
} as const);

/** 记住的事件 ID 与信封各至多这么多条：插件不让状态无界增长 */
const maxRememberedEvents = 100;

/** 处理器在一次投递里拿到的信封：ID 与 `dataschema`（没有时为 `null`），黑盒运行器的用例 `event-envelope` 读它（invocation.md §7） */
interface ReceivedEnvelope {
  readonly id: string;
  readonly dataSchema: string | null;
}

/** `echoes.create` 的请求：`text` 必填 */
const CreateRequest = RequestShape.object({ text: RequestShape.required(RequestShape.string()) });

/** `echoes.relay` 的请求：经宿主调用 `operation`，载荷是任意 JSON */
const RelayRequest = RequestShape.object({
  operation: RequestShape.required(RequestShape.string()),
  payload: RequestShape.json(),
});

/** 没有成员的请求 */
const EmptyRequest = RequestShape.object({});

/** `echoes.create` 的响应：回声文本、配置里的问候语与上下文里的租户、主体、关联 ID */
interface CreateResponse {
  readonly text: string;
  readonly greeting?: string;
  readonly tenant?: string;
  readonly principal?: string;
  readonly correlation?: string;
}

/**
 * 组装回声插件的运行时选项；每次调用都是一个新的插件实例
 */
export function echoOptions(): PluginOptions {
  const catalog = loadCatalog('echots', join(dirname(fileURLToPath(import.meta.url)), 'localization'));
  // 让插件这一侧的 ErrorInfo.message 也能按自己的消息键解析
  setDefaultMessages(new MessageCatalog(catalog.locales), 'en-US');

  let greeting: string | undefined;
  const events: string[] = [];
  const envelopes: ReceivedEnvelope[] = [];
  const registry = new OperationRegistry();

  registry.add({
    contract: defineContract<{ text: string | null }, CreateResponse>({
      id: 'echoes.create',
      stability: Stability.Experimental,
      expose: [Expose.Http, Expose.Mcp],
    }),
    request: CreateRequest,
    schema: {
      request: '{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}',
      response:
        '{"type":"object","properties":{"text":{"type":"string"},"greeting":{"type":"string"},"tenant":{"type":"string"},"principal":{"type":"string"},"correlation":{"type":"string"}},"required":["text"]}',
    },
    handler: async (context, request) => {
      // 文本为空是业务失败：宿主用握手时拿到的目录翻译它
      if (request === null || !request.text) {
        return Result.fail(
          ErrorInfo.validation(EchoErrorCode.TextMissing, EchoMessageKey.TextMissing, { operation: 'echoes.create' }),
        );
      }
      return Result.ok({
        text: request.text,
        ...(greeting === undefined ? {} : { greeting }),
        ...(context.tenant === undefined ? {} : { tenant: context.tenant }),
        ...(context.principal === undefined ? {} : { principal: context.principal }),
        ...(context.correlation === undefined ? {} : { correlation: context.correlation }),
      });
    },
  });

  registry.add({
    contract: defineContract<{ operation: string | null; payload?: JsonValue }, JsonValue>({
      id: 'echoes.relay',
      stability: Stability.Experimental,
      expose: [Expose.Http],
    }),
    request: RelayRequest,
    handler: async (context, request) => {
      // 插件运行时总在上下文里放入宿主客户端；宿主没有给出可用的回调端点时回调以 plugins.host.unavailable 失败
      const host = findHost(context);
      if (host === undefined) {
        return Result.fail(ErrorInfo.unavailable(EchoErrorCode.HostUnavailable, EchoMessageKey.HostUnavailable));
      }
      // 原样转发：上下文里的租户是宿主随这次调用交给插件的，回调只能带它
      const response = await host.invoke(context, request?.operation ?? '', writeJson(request?.payload ?? {}));
      if (!response.outcome.ok) {
        return Result.fail(response.outcome.error);
      }
      return Result.ok(response.payload ? parseJson(response.payload) : {});
    },
  });

  registry.add({
    contract: defineContract<unknown, never>({ id: 'echoes.crash', stability: Stability.Experimental, expose: [] }),
    request: EmptyRequest,
    // 故意让进程异常退出而不应答：宿主应记为崩溃并按退避重启；一致性测试以 --exclude 排除它
    handler: async () => process.exit(3),
  });

  registry.add({
    contract: defineContract<
      unknown,
      { readonly ids: readonly string[]; readonly envelopes: readonly ReceivedEnvelope[] }
    >({
      id: 'events.list',
      stability: Stability.Experimental,
      expose: [Expose.Http],
    }),
    request: EmptyRequest,
    handler: async () => Result.ok({ ids: [...events], envelopes: [...envelopes] }),
  });

  return {
    registry,
    catalogs: [catalog],
    subscriptions: [
      {
        topic: 'echo.events',
        // 至少一次投递：按信封 ID 去重，处理器才是幂等的
        handler: async (_context, envelope) => {
          if (!events.includes(envelope.id)) {
            events.push(envelope.id);
            events.splice(0, Math.max(0, events.length - maxRememberedEvents));
          }
          // 每次投递都记，按收到的先后，只留最近的若干条
          envelopes.push({ id: envelope.id, dataSchema: envelope.dataSchema === '' ? null : envelope.dataSchema });
          envelopes.splice(0, Math.max(0, envelopes.length - maxRememberedEvents));
          return Result.success();
        },
      },
    ],
    hooks: {
      configure: (configuration: PluginConfiguration) => {
        // 成员名不区分大小写（宿主的配置源是 IConfiguration）：Greeting 与 greeting 是同一项
        const value = configuration.values.get('greeting');
        if (value !== undefined && value !== null && typeof value !== 'string') {
          return Result.fail(
            ErrorInfo.validation(EchoErrorCode.InvalidConfiguration, EchoMessageKey.InvalidConfiguration, {
              reason: "'greeting' must be a string",
            }),
          );
        }
        greeting = configuration.values.string('greeting') || undefined;
        return Result.success();
      },
      health: () => ({
        state: LifecycleState.Ready,
        items: [{ name: 'echo', status: HealthStatus.Healthy }],
      }),
    },
  };
}
