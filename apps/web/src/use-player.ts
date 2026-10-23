import { useEffect, useMemo, useRef, useState } from 'react';
import { createSession, getScenes, projectSession, transition, type PlayerCommand, type PlayerSession } from '@endless/player';
import { GenerationRequestSchema, type ApiStatus, type GeneratedEpisode, type GenerationRequest } from '@endless/content';
import { contentHash } from '@endless/esl';
import { content } from './content/catalog.js';
import { SessionRepository } from './storage.js';
import { apiStatus, generateEpisode } from './api.js';

export function usePlayer() {
  const [session, setSession] = useState<PlayerSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [raw, setRaw] = useState<unknown>(null);
  const [library, setLibrary] = useState(content.pilot);
  const [generated, setGenerated] = useState<GeneratedEpisode[]>([]);
  const [ticket, setTicket] = useState<GenerationRequest | null>(null);
  const [generating, setGenerating] = useState(false);
  const [phase, setPhase] = useState('');
  const [api, setApi] = useState<ApiStatus | null>(null);
  const [apiError, setApiError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const repository = useRef<SessionRepository | null>(null);
  const current = useRef<PlayerSession | null>(null);
  const pending = useRef(false);
  const currentTicket = useRef<GenerationRequest | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    const storage = new SessionRepository();
    repository.current = storage;
    void Promise.all([storage.load(), storage.load('generation')]).then(([stored, savedTicket]) => {
      if (!active) return;
      setRaw(stored);
      const restored = content.restore(stored ?? createSession(content.pilot));
      if (savedTicket != null) {
        const parsed = GenerationRequestSchema.parse(savedTicket);
        if (contentHash(parsed.save) !== contentHash(content.snapshot(restored.session, restored.generated))) {
          throw new Error('生成任务与本地进度不匹配，原始数据已保留，请先备份');
        }
        currentTicket.current = parsed;
        setTicket(parsed);
        setPhase('上次生成任务已保留，可恢复等待，不会创建重复任务');
      }
      current.current = restored.session;
      setLibrary(restored.library);
      setGenerated(restored.generated);
      setSession(restored.session);
    }).catch((error: unknown) => {
      if (active) setFailure(error instanceof Error ? error.message : '无法恢复本地进度，原始存档已保留');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      controller.current?.abort();
      void storage.close().catch(() => {});
    };
  }, []);

  useEffect(() => { void refreshApi(); }, []);

  useEffect(() => {
    const clearKey = () => {
      setApiKey('');
      for (const input of document.querySelectorAll<HTMLInputElement>('[data-session-provider-key]')) input.value = '';
    };
    const restorePage = (event: PageTransitionEvent) => { if (event.persisted) clearKey(); };
    window.addEventListener('pagehide', clearKey);
    window.addEventListener('pageshow', restorePage);
    return () => {
      window.removeEventListener('pagehide', clearKey);
      window.removeEventListener('pageshow', restorePage);
    };
  }, []);

  const view = useMemo(() => session ? projectSession(session, library) : null, [session, library]);

  async function refreshApi() {
    try {
      setApi(await apiStatus());
      setApiError('');
    } catch (error) {
      setApi(null);
      setApiError(error instanceof Error ? error.message : '本机 AI 服务未连接');
    }
  }

  async function dispatch(command: PlayerCommand): Promise<boolean> {
    if (!current.current || !repository.current || pending.current || currentTicket.current) return false;
    pending.current = true;
    setSaving(true);
    setNotice('');
    try {
      const before = current.current;
      const next = transition(before, command, library);
      if (next !== before) await repository.current.save(content.snapshot(next, generated), before.revision);
      current.current = next;
      setSession(next);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作未保存，请重试');
      return false;
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  async function generate(): Promise<boolean> {
    if (!current.current || !repository.current || pending.current) return false;
    pending.current = true;
    setGenerating(true);
    setNotice('');
    const abort = new AbortController();
    controller.current = abort;
    const resuming = !!currentTicket.current;
    try {
      let input = currentTicket.current;
      if (!input) {
        content.plan(current.current, library);
        input = { requestId: crypto.randomUUID(), save: content.snapshot(current.current, generated) };
        input = await repository.current.reserveGeneration(input);
        current.current = input.save.session;
        setSession(input.save.session);
        currentTicket.current = input;
        setTicket(input);
      }
      setPhase('正在连接本机 AI 服务…');
      const result = await generateEpisode(input, setPhase, abort.signal, apiKey, resuming);
      if (abort.signal.aborted) return false;
      if (result.failed) {
        await repository.current.clearGeneration(input.requestId);
        currentTicket.current = null;
        setTicket(null);
        setNotice(result.message);
        setPhase(result.message);
        void refreshApi();
        return false;
      }
      const accepted = content.accept(result.document, input.save);
      const next = transition(accepted.session, { type: 'select', episode: result.document.batch.batch }, accepted.library);
      await repository.current.save(content.snapshot(next, accepted.generated), current.current.revision, input.requestId);
      current.current = next;
      currentTicket.current = null;
      setTicket(null);
      setLibrary(accepted.library);
      setGenerated(accepted.generated);
      setSession(next);
      setPhase('新一集已校验并保存到此设备');
      void refreshApi();
      return true;
    } catch (error) {
      if (!abort.signal.aborted) {
        setNotice(error instanceof Error ? error.message : '生成未完成。任务 ID 已保留，可恢复原任务');
        setPhase('任务已保留；恢复时会使用相同任务 ID，避免重复调用');
      }
      return false;
    } finally {
      if (controller.current === abort) {
        pending.current = false;
        setGenerating(false);
      }
    }
  }

  async function cancelGeneration() {
    const input = currentTicket.current;
    if (!input || !repository.current) return;
    controller.current?.abort();
    try {
      await repository.current.clearGeneration(input.requestId);
      currentTicket.current = null;
      setTicket(null);
      setPhase('已停止本地等待。服务端可能仍在生成；相同进度再次请求会复用已有任务');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法停止等待，请刷新重试');
    }
  }

  const readyForGeneration = !!view && library.episodes.every((episode) =>
    (view.episodes[episode.id]?.cursor ?? 0) >= getScenes(episode).length);
  const save = session ? content.snapshot(session, generated) : null;
  const canUseModel = !!api && (api.configured || (api.acceptsUserKey && !!apiKey.trim()));
  const learningNotes = useMemo(() => session ? content.learningNotes(session, library) : [], [session, library]);
  const nextWords = useMemo(() => {
    if (!session || !readyForGeneration) return [];
    try {
      return content.plan(session, library).brief.introduce.map((item) => ({ item, ...library.glossary[item] }));
    } catch {
      return [];
    }
  }, [session, library, readyForGeneration]);

  return {
    session, view, library, save, loading, failure, notice, saving, dispatch, raw,
    api, apiError, refreshApi, generate, generating, phase, ticket, cancelGeneration, readyForGeneration,
    apiKey, setApiKey, canUseModel,
    learningNotes, nextWords,
    busy: saving || !!ticket || generating,
  };
}
