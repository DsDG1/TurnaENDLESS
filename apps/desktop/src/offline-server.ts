import { createServer } from 'node:http';
import { createStaticHandler } from './static.js';

export function createOfflineServer(directory: string) {
  const handlePage = createStaticHandler(directory);
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const port = address && typeof address !== 'string' ? address.port : 4175;
      const origin = `http://127.0.0.1:${port}`;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (request.headers.host !== `127.0.0.1:${port}` ||
        (request.headers.origin && request.headers.origin !== origin) ||
        request.headers['sec-fetch-site'] === 'cross-site') {
        response.writeHead(403).end();
      } else if ((request.url ?? '/').startsWith('/api/')) {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: '本地 AI 服务或存储不可用；仍可阅读本地内容。原有数据已保留，请检查用户数据目录后重启程序。' }));
      } else {
        await handlePage(request, response);
      }
    })().catch(() => response.end());
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
