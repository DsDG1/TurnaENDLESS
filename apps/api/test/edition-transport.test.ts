import { describe, expect, it } from 'vitest';
import { buildFetchRequestOptions, createNodeFetchDeps } from '../src/edition/node-fetch.js';

const request = {
  url: 'https://example.com/a/b?x=1',
  address: '93.184.216.34',
  hostHeader: 'example.com',
  timeoutMs: 20_000,
  maxBytes: 2 * 1024 * 1024,
};

describe('抓取传输层（M3）', () => {
  it('连接固定到已校验 IP，SNI 与 Host 仍是原域名', () => {
    const options = buildFetchRequestOptions(request);
    expect(options.host).toBe('93.184.216.34');
    expect(options.servername).toBe('example.com');
    expect(options.headers.host).toBe('example.com');
    expect(options.port).toBe(443);
    expect(options.path).toBe('/a/b?x=1');
    expect(options.method).toBe('GET');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.agent).toBe(false);
  });

  it('不携带 Cookie、Authorization、capability 或 provider Key', () => {
    const { headers } = buildFetchRequestOptions(request);
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    for (const forbidden of ['cookie', 'authorization', 'x-endless-token', 'x-endless-provider-key', 'referer']) {
      expect(names).not.toContain(forbidden);
    }
    expect(JSON.stringify(headers)).not.toMatch(/sk-|bearer/i);
  });

  it('DNS 解析返回全部地址，供逐跳私网校验使用', async () => {
    const deps = createNodeFetchDeps({ lookup: async () => ['93.184.216.34', '2606:2800:220:1::1'] });
    await expect(deps.lookup('example.com')).resolves.toEqual(['93.184.216.34', '2606:2800:220:1::1']);
  });
});
