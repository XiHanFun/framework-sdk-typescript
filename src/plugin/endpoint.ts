import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Server, ServerCredentials } from '@grpc/grpc-js';

import { ErrorCode, FrameworkError } from '../primitives/index.ts';
import { EndpointNetwork, type PluginEndpoint } from './protocol.ts';

/** 回环地址加端口，端口可以是 0（由系统分配） */
const loopbackListenPattern = /^(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/;

/**
 * 本平台缺省的网络类型：Windows 用命名管道，其他系统用 Unix 域套接字
 *
 * @remarks
 * Node 在 Windows 上把套接字路径当作命名管道（libuv），没有 Unix 域套接字可用；两种都比回环 TCP 窄，
 * TCP 同机的其他用户连得上，隔离只靠令牌（handshake.md §4）
 */
export function defaultNetwork(): EndpointNetwork {
  return process.platform === 'win32' ? EndpointNetwork.NamedPipe : EndpointNetwork.Unix;
}

/**
 * 一个已绑定的端点
 *
 * @internal
 */
export interface BoundEndpoint {
  /** 写进握手行的端点 */
  readonly endpoint: PluginEndpoint;
  /** 服务停止之后调用：删掉本进程新建的私有目录；其余情况什么也不做 */
  readonly cleanup: () => void;
}

/**
 * 按 handshake.md §4 把 gRPC 服务端绑定到本机端点
 *
 * @remarks
 * - `unix`：没给地址时，套接字放进本进程新建的私有目录（`mkdtemp`：名字随机、权限 `0700`、只新建不复用，
 *   别人抢先建好的同名目录或指向别处的链接不会被拿来用），套接字文件绑定后收紧为 `0600`。
 * - `npipe`：没给地址时取随机的管道名；libuv 以第一个实例创建管道，同名管道已经存在即绑定失败，不会接上别人的管道。
 *   管道用 Windows 的缺省安全描述符：当前用户、管理员与 SYSTEM 可读写，其他用户只能只读打开，发不出请求。
 * - `tcp`：只绑定回环地址；没给地址时为 `127.0.0.1` 上系统分配的端口。
 *
 * @internal
 */
export async function bindEndpoint(
  server: Server,
  network: EndpointNetwork,
  address: string | undefined,
): Promise<BoundEndpoint> {
  switch (network) {
    case EndpointNetwork.Unix: {
      if (process.platform === 'win32') {
        throw invalid("Unix domain sockets are not available to Node.js on Windows; use 'npipe' or 'tcp'.");
      }
      let directory: string | undefined;
      let path = address;
      if (path === undefined) {
        directory = mkdtempSync(join(tmpdir(), 'xihan-plugin-'));
        // mkdtemp 已按 0700 创建；再设一次，不依赖 umask 与平台的缺省
        chmodSync(directory, 0o700);
        path = join(directory, 'plugin.sock');
      }
      const created = directory;
      const cleanup = () => {
        if (created !== undefined) {
          rmSync(created, { recursive: true, force: true });
        }
      };
      try {
        await bind(server, `unix:${path}`);
        chmodSync(path, 0o600);
      } catch (error) {
        cleanup();
        throw error;
      }
      return { endpoint: { network, address: path }, cleanup };
    }
    case EndpointNetwork.NamedPipe: {
      if (process.platform !== 'win32') {
        throw invalid("Named pipes are only available on Windows; use 'unix' or 'tcp'.");
      }
      const pipe = address ?? `\\\\.\\pipe\\xihan-plugin-${randomBytes(8).toString('hex')}`;
      // grpc-js 的 unix 解析器把路径原样交给 net，Windows 上 net 把 \\.\pipe\ 开头的路径当作命名管道
      await bind(server, `unix:${pipe}`);
      return { endpoint: { network, address: pipe }, cleanup: () => {} };
    }
    case EndpointNetwork.Tcp: {
      const match = loopbackListenPattern.exec(address ?? '127.0.0.1:0');
      if (match === null) {
        throw invalid(`The tcp address '${address}' must be a loopback address with a port.`);
      }
      const host = match[1] ?? '127.0.0.1';
      const port = await bind(server, `${host}:${match[2] ?? '0'}`);
      return { endpoint: { network, address: `${host}:${port}` }, cleanup: () => {} };
    }
    default:
      throw invalid(`The endpoint network '${String(network)}' is not supported.`);
  }
}

/** `bindAsync` 的 Promise 形态，返回绑定的端口 */
function bind(server: Server, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync(target, ServerCredentials.createInsecure(), (error, port) => {
      if (error === null) {
        resolve(port);
      } else {
        reject(
          new FrameworkError(ErrorCode.InvalidArgument, `The plugin could not listen on '${target}'.`, {
            cause: error,
          }),
        );
      }
    });
  });
}

function invalid(message: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, message);
}
