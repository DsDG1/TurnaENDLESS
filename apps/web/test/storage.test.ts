import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createSession, restoreSession, transition } from '@endless/player';
import { SessionRepository } from '../src/storage.js';
import { content, library } from '../src/content/catalog.js';

describe('IndexedDB 原子存档', () => {
  it('保存并重新打开后可恢复场景进度与偏好', async () => {
    const factory = new IDBFactory();
    const repository = new SessionRepository(factory);
    expect(await repository.load()).toBeNull();
    const initial = createSession(library);
    const state = transition(initial, { type: 'text', large: true }, library);
    await repository.save(state, initial.revision);
    await repository.close();
    const reopened = new SessionRepository(factory);
    expect(restoreSession(await reopened.load(), library)).toEqual(state);
    await reopened.close();
  });

  it('并发窗口不能覆盖另一个窗口已保存的进度', async () => {
    const factory = new IDBFactory();
    const first = new SessionRepository(factory);
    const second = new SessionRepository(factory);
    const initial = createSession(library);
    const updated = transition(initial, { type: 'select', episode: 'pilot-2' }, library);
    await first.save(updated, initial.revision);
    await expect(second.save({ ...updated, current: 'pilot-3' }, initial.revision)).rejects.toThrow(/另一个窗口/);
    expect(restoreSession(await first.load(), library).current).toBe('pilot-2');
    await first.close();
    await second.close();
  });

  it('生成任务跨刷新保留，其他窗口不能在等待期间改写进度', async () => {
    const factory = new IDBFactory();
    const first = new SessionRepository(factory);
    const initial = createSession(library);
    const ticket = { requestId: crypto.randomUUID(), save: content.snapshot(initial, []) };
    const reserved = await first.reserveGeneration(ticket);
    const second = new SessionRepository(factory);
    expect(await second.load('generation')).toEqual(reserved);
    expect(reserved.save.revision).toBe(initial.revision + 1);
    const updated = transition(reserved.save.session, { type: 'text', large: true }, library);
    await expect(second.save(content.snapshot(updated, []), initial.revision)).rejects.toThrow(/另一个窗口/);
    await expect(second.save(content.snapshot(updated, []), reserved.save.revision)).rejects.toThrow(/生成任务/);
    await expect(second.reserveGeneration({ ...ticket, requestId: crypto.randomUUID() })).rejects.toThrow(/另一个窗口/);
    await first.save(content.snapshot(updated, []), reserved.save.revision, ticket.requestId);
    expect(await second.load('generation')).toBeNull();
    expect(content.restore(await second.load()).session).toEqual(updated);
    await first.close();
    await second.close();
  });

  it('取消后不能用旧任务提交结果，现有存档不被覆盖', async () => {
    const repository = new SessionRepository(new IDBFactory());
    const session = createSession(library);
    const ticket = { requestId: crypto.randomUUID(), save: content.snapshot(session, []) };
    const reserved = await repository.reserveGeneration(ticket);
    await repository.clearGeneration(ticket.requestId);
    await expect(repository.save(content.snapshot({ ...reserved.save.session, revision: 2 }, []), 1, ticket.requestId)).rejects.toThrow(/取消/);
    expect(content.restore(await repository.load()).session).toEqual(reserved.save.session);
    await repository.close();
  });
});
