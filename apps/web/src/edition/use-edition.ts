import { useCallback, useEffect, useRef, useState } from 'react';
import { edition } from '@endless/content';
import {
  EditionRepository, notifyEditionChange, watchEditionChanges, type EditionStore,
} from './storage.js';
import samplePublication from './sample-publication.json';

/** 随包附带的离线样刊（自有文本，已通过全部验收）。 */
export const SAMPLE_PUBLICATION = samplePublication as unknown as edition.EditionPublicationPackage;

/**
 * Edition 的本地状态：所有写操作都走仓库的一个事务，
 * 失败时保留原有内容并在界面上说明，而不是静默重置。
 */
export function useEditionStore() {
  const repository = useRef<EditionRepository | null>(null);
  if (!repository.current) repository.current = new EditionRepository();
  const [store, setStore] = useState<EditionStore | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setStore(await repository.current!.load());
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    return watchEditionChanges(() => void reload());
  }, [reload]);

  const run = useCallback(async <T,>(work: (repo: EditionRepository) => Promise<T>, message = ''): Promise<T | null> => {
    setBusy(true);
    setError('');
    try {
      const result = await work(repository.current!);
      setStore(await repository.current!.load());
      notifyEditionChange();
      if (message) setNotice(message);
      return result;
    } catch (cause) {
      setError((cause as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { store, error, notice, busy, reload, run, setNotice, setError };
}
