/**
 * Electron main: one window, the controller, and the IPC bridge between them.
 */

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, powerSaveBlocker, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AppEvent, Flow, Session, Settings } from '../shared/types.ts';
import { ElectronPage } from './browser/page.ts';
import { Controller } from './controller.ts';
import { startFlowBridge } from './flowTools.ts';
import { loginShellPath } from './git.ts';
import { Store } from './store.ts';
import { Updater } from './updater.ts';

// A separate home keeps everything separate, the window's own storage included, so a second copy
// of the app (or a test) never inherits the first one's state.
if (process.env['ARMY_APP_HOME'] !== undefined) app.setPath('userData', join(process.env['ARMY_APP_HOME'], 'chromium'));

let win: BrowserWindow | null = null;
/**
 * The e2e suite sets ARMY_APP_HIDDEN=1: the window never shows and the app stays out of the Dock,
 * so a test run does not take focus from whatever you are doing. Playwright drives it all the same.
 */
const HIDDEN = process.env['ARMY_APP_HIDDEN'] === '1';
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
      // A hidden window still has to run its timers and paint, or the tests driving it stall.
      backgroundThrottling: !HIDDEN,
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (!HIDDEN) win.once('ready-to-show', () => win?.show());
  // Links in agent replies open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window only ever shows the app. A link that would navigate it, even to a file, is
  // stopped: a file link from an agent once left the window on a blank error page.
  const own = process.env['ELECTRON_RENDERER_URL'] ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href;
  win.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] === own.split('#')[0]) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  if (process.env['ELECTRON_RENDERER_URL'] !== undefined) void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

/**
 * A link from a reply. Web links go to the browser. A path, the way agents write them
 * (`src/cart.js:9`, `/abs/cart.js`, `file:///abs/cart.js#L9`), opens in the app macOS uses for
 * that file, resolved against the project; a path that is not there is left alone.
 */
async function openLink(href: string, base?: string): Promise<{ ok: boolean; message: string }> {
  if (/^(https?|mailto):/i.test(href)) {
    await shell.openExternal(href);
    return { ok: true, message: '' };
  }
  let path = href;
  try {
    if (href.startsWith('file:')) path = fileURLToPath(href);
  } catch {
    return { ok: false, message: `Could not read the link ${href}.` };
  }
  path = decodeURIComponent(path.replace(/#.*$/, '')).replace(/:\d+(:\d+)?$/, '');
  const full = isAbsolute(path) ? path : resolvePath(base ?? '', path);
  if (!existsSync(full)) return { ok: false, message: `${path} is not there.` };
  const err = await shell.openPath(full);
  return err === '' ? { ok: true, message: '' } : { ok: false, message: err };
}

function handle<A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(`army:${name}`, async (_e, ...args: unknown[]) => fn(...(args as A)));
}

void app.whenReady().then(async () => {
  if (HIDDEN) app.dock?.hide();
  // A packaged app takes its icon from the bundle; a dev run is Electron's own app, so set it here.
  else if (!app.isPackaged) app.dock?.setIcon(join(__dirname, '../../build/icon.png'));
  if (process.platform === 'darwin') {
    const path = await loginShellPath();
    if (path !== null && path !== '') process.env['PATH'] = path;
  }
  const root = process.env['ARMY_APP_HOME'] ?? join(app.getPath('userData'), 'army');
  // Web searches go through Chromium's network stack, in a session of their own with no link to the
  // app window's or the browser step's cookies.
  const web = session.fromPartition('persist:army-web');
  const webFetch = ((input: string | URL | Request, init?: RequestInit) => web.fetch(input as string, init)) as typeof fetch;
  controller = new Controller({ store: new Store(root), emit, openPage: (show) => new ElectronPage(show && !HIDDEN), fetch: webFetch });
  const c = controller;
  // Chat agents reach the start_flow tool through this. If it cannot start, chats still work.
  try {
    c.attachBridge(await startFlowBridge(root, c.flowTools));
  } catch (err) {
    console.error('The start_flow tool is unavailable:', err);
  }
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
  handle('openLink', (href: string, base?: string) => openLink(href, base));
  handle('projectHealth', (id: string) => c.projectHealth(id));
  handle('setUpGit', (id: string) => c.setUpGit(id));
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
  handle('answerFlowRequest', (sessionId: string, requestId: string, approve: boolean, objective: string) => c.answerFlowRequest(sessionId, requestId, approve, objective));
  handle('runDiff', (id: string) => c.runDiff(id));
  handle('mergeRun', (id: string) => c.mergeRun(id));
  handle('saveFlow', (f: Flow) => c.saveFlow(f));
  handle('deleteFlow', (id: string) => c.deleteFlow(id));
  handle('saveSettings', (s: Settings) => {
    nativeTheme.themeSource = s.theme;
    return c.saveSettings(s);
  });
  handle('doctor', () => c.doctor());
  handle('refreshModels', () => c.refreshModels());
  handle('testJev', () => c.testJev());
  handle('connectJev', (sessionId: string, itemId: string, apiKey: string | null) => c.connectJev(sessionId, itemId, apiKey));

  const updater = new Updater((update) => emit({ type: 'update', update }));
  handle('updateStatus', () => updater.get());
  handle('checkForUpdates', () => updater.check());
  handle('installUpdate', () => updater.install());
  updater.start();

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
