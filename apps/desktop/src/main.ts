import { app, BrowserWindow, dialog, session, utilityProcess } from 'electron';
import { join } from 'node:path';

app.setName('ENDLESS Test');
const testData = process.env.ENDLESS_DESKTOP_TEST_DATA;
app.setPath('userData', testData || join(app.getPath('appData'), 'ENDLESS-Test'));
const origin = 'http://127.0.0.1:4175';
let window: BrowserWindow | null = null;
let service: Electron.UtilityProcess | undefined;
let exiting = false;
let stopped = false;

function fail(message: string) {
  if (exiting) return;
  dialog.showErrorBox('ENDLESS 测试版启动失败', message);
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    exiting = true;
    if (!service || stopped) return;
    event.preventDefault();
    service.postMessage('shutdown');
    setTimeout(() => {
      service?.kill();
      stopped = true;
      app.quit();
    }, 3000).unref();
  });
  void app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: url.origin !== origin && !['blob:', 'data:', 'devtools:'].includes(url.protocol) });
    });
    const resources = app.isPackaged ? join(process.resourcesPath, 'app') : app.getAppPath();
    service = utilityProcess.fork(join(resources, 'service.mjs'), [resources, join(app.getPath('userData'), 'api')], {
      serviceName: 'ENDLESS local API',
      stdio: 'ignore',
    });
    const timeout = setTimeout(() => fail('本地服务启动超时。请检查用户数据目录权限；原有存档不会被重置。'), 30_000);
    service.once('exit', () => {
      stopped = true;
      clearTimeout(timeout);
      if (exiting) app.quit();
      else fail('本地服务已意外退出。请重新打开程序；中断的 AI 请求不会自动重发，存档不会被重置。');
    });
    service.on('message', (message: { type?: string; code?: string }) => {
      clearTimeout(timeout);
      if (message.type === 'failed') {
        fail(message.code === 'port-in-use'
          ? '本机 4175 端口已被占用。请关闭占用它的程序后重试；不会改用其他端口或连接未知服务。'
          : '本地服务启动失败。请检查用户数据目录权限和程序文件是否完整；原有存档不会被重置。');
      } else if (message.type === 'ready' && !exiting) {
        window = new BrowserWindow({
          title: 'ENDLESS · 测试版',
          width: 1280, height: 900, minWidth: 360, minHeight: 600,
          backgroundColor: '#f6f5f0', autoHideMenuBar: true, show: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event, url) => {
          if (new URL(url).origin !== origin) event.preventDefault();
        });
        window.webContents.on('will-attach-webview', (event) => event.preventDefault());
        window.once('ready-to-show', () => window?.show());
        void window.loadURL(origin).catch(() => fail('界面加载失败。请检查程序文件是否完整后重试。'));
      }
    });
  }).catch(() => fail('无法创建桌面窗口或本地服务。请检查运行环境和程序文件是否完整。'));
}
