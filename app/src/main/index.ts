/**
 * Electron main: one window, the controller, and the IPC bridge between them.
 */

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, powerSaveBlocker, shell } from 'electron';
import { join } from 'node:path';

import type { AppEvent, Flow, Session, Settings } from '../shared/types.ts';
import { ElectronPage } from './browser/page.ts';
import { Controller } from './controller.ts';
import { loginShellPath } from './git.ts';
import { Store } from './store.ts';

// A separate home keeps everything separate, the window's own storage included, so a second copy
// of the app (or a test) never inherits the first one's state.
if (process.env['ARMY_APP_HOME'] !== undefined) app.setPath('userData', join(process.env['ARMY_APP_HOME'], 'chromium'));

let win: BrowserWindow | null = null;
let controller: Controller | null = null;
let quitting = false;

function emit(event: AppEvent): void {
  if (win !== null && !win.isDestroyed()) win.webContents.send('army:event', event);
}

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Agentic Army',
    backgroundColor: dark ? '#15171a' : '#f6f6f4',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Links in agent replies open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  if (process.env['ELECTRON_RENDERER_URL'] !== undefined) void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

function handle<A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(`army:${name}`, async (_e, ...args: unknown[]) => fn(...(args as A)));
}

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    const path = await loginShellPath();
    if (path !== null && path !== '') process.env['PATH'] = path;
  }
  const root = process.env['ARMY_APP_HOME'] ?? join(app.getPath('userData'), 'army');
  controller = new Controller({ store: new Store(root), emit, openPage: (show) => new ElectronPage(show) });
  const c = controller;
  nativeTheme.themeSource = c.settings.theme;

  handle('getState', () => c.getState());
  handle('addProject', async (path?: string) => {
    let target = path;
    if (target === undefined) {
      const pick = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Add a project folder' });
      if (pick.canceled || pick.filePaths[0] === undefined) return null;
      target = pick.filePaths[0];
    }
    return c.addProject(target);
  });
  handle('removeProject', (id: string) => c.removeProject(id));
  handle('createSession', (projectId: string) => c.createSession(projectId));
  handle('getSession', (id: string) => c.getSession(id));
  handle('renameSession', (id: string, title: string) => c.renameSession(id, title));
  handle('deleteSession', (id: string) => c.deleteSession(id));
  handle('setChat', (id: string, chat: Partial<Session['chat']>) => c.setChat(id, chat));
  handle('send', (id: string, text: string, flowId: string | null) => {
    // The reply streams back as events; the call itself returns as soon as the work is queued.
    void c.send(id, text, flowId).catch((err: unknown) => console.error(err));
  });
  handle('stop', (id: string) => c.stop(id));
  handle('getRun', (id: string) => c.getRun(id));
  handle('answer', (runId: string, qid: string, approve: boolean, text: string) => c.answer(runId, qid, approve, text));
  handle('stopRun', (id: string) => c.stopRun(id));
  handle('runDiff', (id: string) => c.runDiff(id));
  handle('mergeRun', (id: string) => c.mergeRun(id));
  handle('saveFlow', (f: Flow) => c.saveFlow(f));
  handle('deleteFlow', (id: string) => c.deleteFlow(id));
  handle('saveSettings', (s: Settings) => {
    nativeTheme.themeSource = s.theme;
    return c.saveSettings(s);
  });
  handle('doctor', () => c.doctor());
  handle('testJev', () => c.testJev());

  // macOS naps a background app and the agents it started with it: a claude turn stalled mid-request
  // every time the window was not in front. Hold the app awake while anything is working.
  let blocker: number | null = null;
  setInterval(() => {
    const busy = c.busy();
    if (busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!busy && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  }, 1000).unref();

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (e) => {
  if (quitting || controller === null) return;
  if (controller.busy() && process.env['ARMY_APP_NO_QUIT_CONFIRM'] !== '1') {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Stop them and quit', 'Keep working'],
      defaultId: 1,
      cancelId: 1,
      message: 'Agents are still working.',
      detail: 'Quitting stops every running chat and flow. Work already written stays on its run branch.',
    });
    if (choice === 1) {
      e.preventDefault();
      return;
    }
  }
  e.preventDefault();
  quitting = true;
  void controller.shutdown().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
