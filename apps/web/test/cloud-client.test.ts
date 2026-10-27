import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_API_PREFIX, CLOUD_LIMITS } from '@endless/cloud-contracts';
import { CloudApi, CloudFailure } from '../src/cloud/client.js';

/** 客户端只依赖共享契约：这里用最小合法响应证明请求形状与错误分类，不模拟业务。 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const capabilities = {
  protocol: 'endless-cloud/1',
  features: {
    accounts: true, sessions: true, devices: true, workspaces: true, import: true, objects: true,
    sync: false, generation: false, credits: false, billing: false, payments: false, exports: false, edition: false,
  },
  contracts: { workspace: 'endless-workspace/1' },
  limits: { ...CLOUD_LIMITS },
};

const failure = (code: string, retryAction = 'resolve_conflict') => json({
  error: { code, category: 'contract', safeMessage: '存档基线已变化', correlationId: 'corr-12345678', retryAction },
}, 409);

afterEach(() => vi.unstubAllGlobals());

const api = (fetcher: typeof fetch) => new CloudApi(fetcher);

describe('云客户端请求形状', () => {
  it('同源 Cookie、no-store，不带页面 Key，也不把幂等键塞进查询串', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(capabilities));
    expect((await api(fetcher).capabilities()).features.import).toBe(true);
    const [path, options] = fetcher.mock.calls[0]!;
    expect(path).toBe(`${CLOUD_API_PREFIX}/capabilities`);
    expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    expect(new Headers(options!.headers).has('idempotency-key')).toBe(false);
    expect(new Headers(options!.headers).has('x-endless-provider-key')).toBe(false);
    expect(String(path)).not.toContain('?');
  });

  it('导入走 octet-stream 原始字节并携带幂等键；超限在上传前就拒绝', async () => {
    const preview = {
      id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), sourceLocalId: 'local-1', sourceProfileId: 'profile-1',
      sourceRepositoryRevision: 3, sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), objectId: crypto.randomUUID(),
      size: 12, counts: { entries: 3, revisions: 3, branches: 1, volumes: 0, checkpoints: 0, tickets: 0, management: 0 },
      eventCount: 5, pendingLocalTickets: 0, sourceKinds: ['bundled'], relationship: 'new', state: 'ready',
      validationBinding: 'c'.repeat(64), copyPolicy: 'endless-cloud-copy/1', expiresAt: new Date().toISOString(),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ preview }));
    const bytes = new TextEncoder().encode('{"format":"endless-backup"}');
    expect((await api(fetcher).preview(bytes.buffer as ArrayBuffer, 'idem-key-0001')).id).toBe(preview.id);
    const [path, options] = fetcher.mock.calls[0]!;
    expect(path).toBe(`${CLOUD_API_PREFIX}/workspaces/import-previews`);
    expect(options).toMatchObject({ method: 'POST', body: bytes.buffer });
    expect(new Headers(options!.headers).get('content-type')).toBe('application/octet-stream');
    expect(new Headers(options!.headers).get('idempotency-key')).toBe('idem-key-0001');

    const huge = vi.fn<typeof fetch>();
    await expect(api(huge).preview(new ArrayBuffer(CLOUD_LIMITS.uploadObjectBytes + 1), 'idem-key-0002'))
      .rejects.toMatchObject({ code: 'STORAGE_QUOTA' });
    expect(huge).not.toHaveBeenCalled();
  });

  it('阅读恢复只发送已确认前缀，使用同源会话与 no-store，不上传存档正文', async () => {
    const workspaceId = crypto.randomUUID(), streamId = `brn_${crypto.randomUUID()}`;
    const input = { workspaceId, cloudVersion: '0', streams: [{ streamId, branchId: streamId, eventSeq: 0, lastEventId: null }] };
    const boot = { workspaceId, streams: input.streams, changeSeq: 0, cloudVersion: '0', cursor: 'head', origin: { cursor: 'origin', streams: input.streams } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(boot));
    expect(await api(fetcher).recoverSync(input)).toEqual(boot);
    const [path, options] = fetcher.mock.calls[0]!;
    expect(path).toBe(`${CLOUD_API_PREFIX}/sync/recover`);
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(input) });
    expect(new Headers(options!.headers).has('x-endless-provider-key')).toBe(false);
  });
});

describe('云客户端错误分类', () => {
  it('稳定错误码与下一步来自信封，客户端不解析服务端文案', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(failure('BASIS_CHANGED'));
    await expect(api(fetcher).preview(new ArrayBuffer(8), 'idem-key-0003')).rejects.toMatchObject({
      code: 'BASIS_CHANGED', retryAction: 'resolve_conflict', correlationId: 'corr-12345678',
    });
  });

  it('网络失败、非 JSON 与 401 分别可辨，不会伪装成业务结论', async () => {
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('failed to fetch'));
    await expect(api(offline).me()).rejects.toMatchObject({ code: 'NETWORK' });

    const html = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    await expect(api(html).me()).rejects.toBeInstanceOf(CloudFailure);
    await expect(api(html).me()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });

    const unauthorized = vi.fn<typeof fetch>().mockResolvedValue(failure('UNAUTHENTICATED', 'retry_read'));
    await expect(api(unauthorized).me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('响应与契约不一致时拒绝采用，而不是尽力猜测', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ workspaces: [{ id: 'not-a-uuid' }] }));
    await expect(api(fetcher).workspaces()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
