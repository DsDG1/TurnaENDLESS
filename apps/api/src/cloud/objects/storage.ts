import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CLOUD_LIMITS } from '@endless/cloud-contracts';
import { storageUnavailable } from '../errors.js';

export interface ObjectStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  read(key: string, limit: number): Promise<Buffer>;
  signDownload(key: string): Promise<{ url: string; expiresAt: string }>;
}

export interface S3ObjectConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: S3ObjectConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint, region: config.region, forcePathStyle: true, maxAttempts: 1,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket, Key: key, Body: bytes, ContentLength: bytes.length,
        ContentType: 'application/json', CacheControl: 'private, no-store',
        IfNoneMatch: '*', ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
        ServerSideEncryption: 'AES256',
      }), { abortSignal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) {
        const existing = await this.read(key, bytes.length);
        if (existing.equals(bytes)) return;
      }
      throw storageUnavailable();
    }
  }

  async read(key: string, limit: number): Promise<Buffer> {
    let body: { destroy(error?: Error): void } | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      body?.destroy(new Error('object read deadline'));
    }, 10_000);
    timer.unref();
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }), {
        abortSignal: controller.signal,
      });
      const stream = result.Body as AsyncIterable<Uint8Array> & { destroy(): void } | undefined;
      if (!stream) throw storageUnavailable();
      body = stream;
      if (result.ContentEncoding && result.ContentEncoding !== 'identity') throw storageUnavailable();
      const bound = Math.min(limit, CLOUD_LIMITS.uploadObjectBytes);
      if (!Number.isSafeInteger(bound) || bound < 1 || (result.ContentLength !== undefined && result.ContentLength > bound)) {
        throw storageUnavailable();
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > bound) throw storageUnavailable();
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, size);
    } catch {
      body?.destroy();
      throw storageUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  async signDownload(key: string): Promise<{ url: string; expiresAt: string }> {
    try {
      const signingDate = new Date();
      const url = await getSignedUrl(this.client, new GetObjectCommand({
        Bucket: this.config.bucket, Key: key,
        ResponseContentType: 'application/octet-stream', ResponseContentDisposition: 'attachment',
        ResponseCacheControl: 'private, no-store',
      }), { expiresIn: 60, signingDate });
      return { url, expiresAt: new Date(Math.floor(signingDate.getTime() / 1000) * 1000 + 60_000).toISOString() };
    } catch {
      throw storageUnavailable();
    }
  }

  close(): void {
    this.client.destroy();
  }
}
