import { describe, expect, it } from 'vitest';
import { cloudHash, parseRoute } from '../src/cloud/routes.js';
import { cloudNamespace } from '../src/cloud/local.js';

/**
 * 深链解析：云副本的三层 ID 必须完整、合法才会落到云阅读。
 * 缺一个就回云端页说明情况——不猜「大概是哪个副本」。
 */

const deployment = crypto.randomUUID();
const account = crypto.randomUUID();
const workspaceId = crypto.randomUUID();

describe('路由解析', () => {
  it('游客页面按原样识别，未知或空 hash 落在首页', () => {
    expect(parseRoute('#home')).toEqual({ shell: 'local', page: 'home' });
    expect(parseRoute('#watch')).toEqual({ shell: 'local', page: 'watch' });
    expect(parseRoute('#settings')).toEqual({ shell: 'local', page: 'settings' });
    expect(parseRoute('#cloud')).toEqual({ shell: 'local', page: 'cloud' });
    expect(parseRoute('')).toEqual({ shell: 'local', page: 'home' });
    expect(parseRoute('#unknown')).toEqual({ shell: 'local', page: 'home' });
  });

  it('三个 ID 齐全时进入云阅读，命名空间由它们推出', () => {
    const route = parseRoute(`#cloud-read/${deployment}/${account}/${workspaceId}`);
    expect(route.shell).toBe('cloud');
    if (route.shell !== 'cloud') return;
    expect(route.page).toBe('home');
    expect(route.target.namespace).toBe(cloudNamespace(deployment, account, workspaceId));
    expect(route.target.workspaceId).toBe(workspaceId);
  });

  it('云阅读包含已接入的回收站页，Edition 与设置回落到首页', () => {
    const base = `#cloud-read/${deployment}/${account}/${workspaceId}`;
    const pageOf = (hash: string) => parseRoute(hash).page;
    expect(pageOf(`${base}/watch`)).toBe('watch');
    expect(pageOf(`${base}/progress`)).toBe('progress');
    expect(pageOf(`${base}/library`)).toBe('library');
    expect(pageOf(`${base}/settings`)).toBe('home');
    expect(pageOf(`${base}/edition`)).toBe('home');
    expect(pageOf(`${base}/cloud`)).toBe('home');
  });

  it('缺 ID、非 UUID 或多余段都不进入云阅读，回云端页说明，而不是假装打开某个副本', () => {
    expect(parseRoute(`#cloud-read/${deployment}/${account}`)).toEqual({ shell: 'local', page: 'cloud' });
    expect(parseRoute(`#cloud-read/${deployment}/${account}/not-a-uuid`)).toEqual({ shell: 'local', page: 'cloud' });
    expect(parseRoute('#cloud-read/a/b/c')).toEqual({ shell: 'local', page: 'cloud' });
    expect(parseRoute(`#cloud-read/${deployment}/${account}/${workspaceId}/watch/extra`).shell).toBe('cloud');
  });

  it('末尾斜杠不影响解析', () => {
    const route = parseRoute(`#cloud-read/${deployment}/${account}/${workspaceId}/watch/`);
    expect(route.shell).toBe('cloud');
    expect(route.page).toBe('watch');
  });
});

describe('深链生成', () => {
  it('首页不带页名，阅读页带页名；非阅读页一律回落首页', () => {
    const target = { deploymentId: deployment, accountId: account, workspaceId };
    expect(cloudHash(target)).toBe(`cloud-read/${deployment}/${account}/${workspaceId}`);
    expect(cloudHash(target, 'watch')).toBe(`cloud-read/${deployment}/${account}/${workspaceId}/watch`);
    expect(cloudHash(target, 'library')).toBe(`cloud-read/${deployment}/${account}/${workspaceId}/library`);
  });

  it('生成的链接能被同一个解析器读回来', () => {
    const route = parseRoute(`#${cloudHash({ deploymentId: deployment, accountId: account, workspaceId }, 'progress')}`);
    expect(route).toMatchObject({ shell: 'cloud', page: 'progress' });
  });
});
