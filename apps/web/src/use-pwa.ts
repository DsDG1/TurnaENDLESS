import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function usePwa() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const [ready, setReady] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(window.matchMedia('(display-mode: standalone)').matches);
  const [workerError, setWorkerError] = useState(false);
  const installEvent = useRef<InstallEvent | null>(null);
  const update = useRef<((reload?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    const connectivity = () => setOffline(!navigator.onLine);
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      installEvent.current = event as InstallEvent;
      setCanInstall(true);
    };
    const installedApp = () => {
      setInstalled(true);
      setCanInstall(false);
      installEvent.current = null;
    };
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', installedApp);
    if (import.meta.env.PROD) {
      update.current = registerSW({
        immediate: true,
        onOfflineReady: () => setReady(true),
        onNeedRefresh: () => setUpdateAvailable(true),
        onRegisterError: () => setWorkerError(true),
        onRegisteredSW: () => {
          void navigator.serviceWorker.ready.then((registration) => {
            if (registration.active && navigator.serviceWorker.controller) setReady(true);
          });
        },
      });
    }
    return () => {
      window.removeEventListener('online', connectivity);
      window.removeEventListener('offline', connectivity);
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', installedApp);
    };
  }, []);

  async function install(): Promise<boolean> {
    const event = installEvent.current;
    if (!event) return false;
    try {
      await event.prompt();
      const choice = await event.userChoice;
      return choice.outcome === 'accepted';
    } finally {
      installEvent.current = null;
      setCanInstall(false);
    }
  }

  return {
    offline, ready, workerError, canInstall, installed, updateAvailable, install,
    update: () => update.current?.(true),
  };
}
