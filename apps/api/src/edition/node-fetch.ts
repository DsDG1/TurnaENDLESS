/**
 * 安全抓取器的 Node 传输层（设计文档 §4.4）。
 *
 * `fetchSource` 只负责策略与逐跳校验，真正建立连接的是这里。三条要点：
 * 1. `host` 用**已校验的 IP**，`servername` 用原域名——连接固定，SNI 与证书校验仍然正确，
 *    DNS rebinding 在校验之后无法把连接改到别处。
 * 2. 不携带 Cookie、Authorization、本机 capability 或 provider Key；只发最小请求头。
 * 3. 读取阶段就按字节上限截断并销毁连接，不先收完再判断。
 *
 * 这个模块只在 `apps/api` 内使用，绝不进入共享包或浏览器。
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { FetchDeps, TransportRequest, TransportResponse } from './fetch-source.js';

export interface FetchRequestOptions {
  host: string;
  servername: string;
  port: 443;
  path: string;
  method: 'GET';
  headers: Record<string, string>;
  rejectUnauthorized: true;
  agent: false;
}

/** 纯函数：给定已校验的请求，产出固定到 IP 的 HTTPS 选项。 */
export function buildFetchRequestOptions(request: TransportRequest): FetchRequestOptions {
  const url = new URL(request.url);
  return {
    host: request.address,
    servername: request.hostHeader,
    port: 443,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: {
      host: request.hostHeader,
      accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en',
      'user-agent': 'EndlessEditionFetcher/1 (+local)',
      connection: 'close',
    },
    rejectUnauthorized: true,
    agent: false,
  };
}

function headerRecord(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    record[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return record;
}

export interface NodeFetchDepsOptions {
  /** 便于测试替换的真实解析器；默认用系统 DNS，返回全部 A/AAAA。 */
  lookup?: (host: string) => Promise<string[]>;
}

/** 生产用依赖：DNS 全量解析 + 固定 IP 的 HTTPS 请求。 */
export function createNodeFetchDeps(options: NodeFetchDepsOptions = {}): FetchDeps {
  const lookup = options.lookup ?? (async (host: string) => {
    const rows = await dnsLookup(host, { all: true, verbatim: true });
    return rows.map((row) => row.address);
  });
  return {
    lookup,
    request: (request: TransportRequest) => new Promise<TransportResponse>((resolve, reject) => {
      const client = httpsRequest(buildFetchRequestOptions(request), (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > request.maxBytes) {
            client.destroy(Object.assign(new Error('response too large'), { name: 'SizeError' }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: headerRecord(response.headers),
            body: Buffer.concat(chunks),
          });
        });
      });
      client.setTimeout(request.timeoutMs, () => {
        client.destroy(Object.assign(new Error('request timeout'), { name: 'TimeoutError' }));
      });
      client.on('error', reject);
      client.end();
    }),
  };
}
