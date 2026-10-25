import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { closeServer, listenLoopback } from './fixtures.js';

export const S3_CREDENTIALS = { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret-for-tests-only' };
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function authentic(request: IncomingMessage, url: URL, body: Buffer): boolean {
  const presigned = url.searchParams.has('X-Amz-Signature');
  const authorization = request.headers.authorization ?? '';
  const credential = presigned ? url.searchParams.get('X-Amz-Credential') : /Credential=([^, ]+)/.exec(authorization)?.[1];
  const headers = presigned ? url.searchParams.get('X-Amz-SignedHeaders') : /SignedHeaders=([^, ]+)/.exec(authorization)?.[1];
  const signature = presigned ? url.searchParams.get('X-Amz-Signature') : /Signature=([a-f0-9]+)/.exec(authorization)?.[1];
  if (!credential || !headers || !signature) return false;
  const [access, date, region, service, terminal] = credential.split('/');
  if (access !== S3_CREDENTIALS.accessKeyId || service !== 's3' || terminal !== 'aws4_request') return false;
  const timestamp = presigned ? url.searchParams.get('X-Amz-Date') : request.headers['x-amz-date'];
  if (typeof timestamp !== 'string') return false;
  if (presigned) {
    const at = Date.parse(timestamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    const expires = Number(url.searchParams.get('X-Amz-Expires'));
    if (!Number.isFinite(at) || expires < 1 || expires > 60 || Date.now() > at + expires * 1000 || at > Date.now() + 30_000) return false;
  }
  const payloadHash = presigned ? url.searchParams.get('X-Amz-Content-Sha256') ?? 'UNSIGNED-PAYLOAD' : request.headers['x-amz-content-sha256'];
  if (typeof payloadHash !== 'string' || (!presigned && payloadHash !== hash(body))) return false;
  const query = [...url.searchParams].filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => [encode(key), encode(value)]).sort(([a, av], [b, bv]) => a! < b! ? -1 : a! > b! ? 1 : av! < bv! ? -1 : av! > bv! ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('&');
  const canonicalHeaders = headers.split(';').map((name) => {
    const value = request.headers[name];
    return `${name}:${(Array.isArray(value) ? value.join(',') : value ?? '').trim().replace(/\s+/g, ' ')}\n`;
  }).join('');
  const canonical = [request.method, url.pathname, query, canonicalHeaders, headers, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${S3_CREDENTIALS.secretAccessKey}`, date!), region!), service!), 'aws4_request');
  const expected = hmac(key, `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).toString('hex');
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export async function fakeObjectStorage() {
  const objects = new Map<string, Buffer>();
  const calls: { method: string; key: string }[] = [];
  const faults = { put: false, putAfterSave: false, get: false, oversized: false, chunkedOversized: false, compressed: false, stall: false };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const key = decodeURIComponent(url.pathname);
      if (!authentic(request, url, body)) {
        response.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        return;
      }
      calls.push({ method: request.method!, key });
      if (request.method === 'PUT') {
        if (faults.put) { response.writeHead(503).end('<Error><Code>ServiceUnavailable</Code></Error>'); return; }
        if (request.headers['if-none-match'] !== '*') { response.writeHead(400).end(); return; }
        if (request.headers['x-amz-server-side-encryption'] !== 'AES256') { response.writeHead(400).end(); return; }
        if (objects.has(key)) { response.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>'); return; }
        if (request.headers['x-amz-checksum-sha256'] !== createHash('sha256').update(body).digest('base64')) {
          response.writeHead(400).end('<Error><Code>BadDigest</Code></Error>');
          return;
        }
        objects.set(key, Buffer.from(body));
        if (faults.putAfterSave) { response.writeHead(503).end('<Error><Code>ServiceUnavailable</Code></Error>'); return; }
        response.writeHead(200, { ETag: `"${hash(body)}"` }).end();
        return;
      }
      if (request.method === 'GET') {
        if (faults.get) { response.writeHead(503).end('<Error><Code>ServiceUnavailable</Code></Error>'); return; }
        const stored = objects.get(key);
        if (!stored) { response.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'); return; }
        const bytes = faults.oversized || faults.chunkedOversized ? Buffer.alloc(2_097_153) : stored;
        response.writeHead(200, {
          'Content-Type': url.searchParams.get('response-content-type') ?? 'application/json',
          ...(faults.chunkedOversized ? {} : { 'Content-Length': bytes.length }),
          ...(faults.compressed ? { 'Content-Encoding': 'gzip' } : {}),
          'Cache-Control': url.searchParams.get('response-cache-control') ?? 'no-store',
          'Content-Disposition': url.searchParams.get('response-content-disposition') ?? 'attachment',
        });
        if (faults.stall) { response.flushHeaders(); return; }
        response.end(bytes);
        return;
      }
      response.writeHead(405).end();
    })().catch(() => { response.writeHead(500).end(); });
  });
  const port = await listenLoopback(server);
  return { endpoint: `http://127.0.0.1:${port}`, objects, calls, faults, close: () => closeServer(server) };
}
