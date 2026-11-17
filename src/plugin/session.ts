import { createHash, timingSafeEqual } from 'node:crypto';

import {
  type Metadata,
  ResponderBuilder,
  ServerInterceptingCall,
  type ServerInterceptor,
  ServerListenerBuilder,
  status,
} from '@grpc/grpc-js';

import { PluginProtocol } from './protocol.ts';

/**
 * 按常数时间比较两个令牌
 *
 * @remarks
 * 先各取 SHA-256 再比较摘要：逐字节短路的比较会从耗时里泄露令牌的前缀，长度不同时直接返回也会泄露长度
 *
 * @internal
 */
export function sameToken(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * 判断调用元数据是否带了本次会话的令牌：只认恰好一个字符串值
 *
 * @internal
 */
export function hasSessionToken(metadata: Metadata, token: string): boolean {
  const values = metadata.get(PluginProtocol.sessionMetadataKey);
  const [value] = values;
  // 没有令牌的守卫一律拒绝：空令牌说明宿主没有下发，不能当作谁都能调
  return token !== '' && values.length === 1 && typeof value === 'string' && sameToken(value, token);
}

/**
 * 会话守卫：宿主每次调用 Plugin 服务（含 Handshake 与流式调用）都在元数据 `xihan-plugin-session` 里带
 * `XIHAN_PLUGIN_SESSION`，缺失或不匹配以 `Unauthenticated` 结束、不进入服务实现（handshake.md §4，ADR-0202）
 *
 * @remarks
 * 作为服务端拦截器在收到元数据时核对：令牌不对的调用碰不到生命周期与操作，本机别的进程连上端点也冒充不了宿主
 *
 * @internal
 */
export function sessionInterceptor(token: string): ServerInterceptor {
  return (_method, call) => {
    const listener = new ServerListenerBuilder()
      .withOnReceiveMetadata((metadata, next) => {
        if (hasSessionToken(metadata, token)) {
          next(metadata);
        } else {
          call.sendStatus({ code: status.UNAUTHENTICATED, details: 'The plugin session token is missing or invalid.' });
        }
      })
      .build();
    const responder = new ResponderBuilder().withStart((next) => next(listener)).build();
    return new ServerInterceptingCall(call, responder);
  };
}
