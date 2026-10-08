/**
 * Updates from GitHub Releases through electron-updater. A packaged, signed app checks shortly after
 * launch and every six hours, downloads in the background, and tells the window when the new
 * version is ready; it installs on Restart, or on the next quit.
 */

import { app } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { UpdateState, UpdateStatus } from '../shared/types.ts';
import { offReason, plainUpdateError, readFeed, readSigning, type Feed, type Signing } from './updateRules.ts';

const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 6 * 60 * 60_000;

type AppUpdater = (typeof import('electron-updater'))['autoUpdater'];

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function devVersion(): string {
  const pkg = readText(join(__dirname, '../../package.json'));
  return pkg === null ? app.getVersion() : ((JSON.parse(pkg) as { version?: string }).version ?? app.getVersion());
}

/** How the running .app is signed. codesign prints its report on stderr and exits 1 when unsigned. */
function bundleSigning(): Promise<Signing> {
  // The executable sits at Agentic Army.app/Contents/MacOS/Agentic Army.
  const bundle = resolve(app.getPath('exe'), '../../..');
  return new Promise((done) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], (_err, stdout, stderr) => done(readSigning(`${stdout}\n${stderr}`)));
  });
}

export class Updater {
  private status: UpdateStatus;
  private readonly feed: Feed | null;
  private updater: Promise<AppUpdater> | null = null;

  constructor(private readonly emit: (status: UpdateStatus) => void) {
    // A dev run is Electron started on out/main, which has no package.json, so app.getVersion()
    // would give Electron's own version there.
    const version = app.isPackaged ? app.getVersion() : devVersion();
    // electron-builder writes the feed into Resources/app-update.yml from `build.publish`.
    this.feed = readFeed(app.isPackaged ? readText(join(process.resourcesPath, 'app-update.yml')) : null);
    const off = offReason({ packaged: app.isPackaged, hidden: process.env['ARMY_APP_HIDDEN'] === '1', feed: this.feed });
    this.status = off === null ? { version, state: 'idle' } : { version, state: 'off', reason: off };
  }

  get(): UpdateStatus {
    return this.status;
  }

  start(): void {
    if (this.status.state === 'off') return;
    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref();
    setInterval(() => void this.check(), EVERY_MS).unref();
  }

  /** Check now. Resolves when the check is done; a download carries on in the background. */
  async check(): Promise<UpdateStatus> {
    const busy = ['off', 'checking', 'downloading', 'ready'];
    if (busy.includes(this.status.state)) return this.status;
    this.set({ state: 'checking' });
    try {
      const u = await this.load();
      await u.checkForUpdates();
    } catch (err) {
      this.fail(err);
    }
    return this.status;
  }

  /** Quit and relaunch on the new version. The app's own quit still stops running agents first. */
  async install(): Promise<void> {
    if (this.status.state !== 'ready') return;
    (await this.load()).quitAndInstall();
  }

  private set(next: UpdateState): void {
    this.status = { version: this.status.version, ...next };
    this.emit(this.status);
  }

  private fail(err: unknown): void {
    this.set({ state: 'error', reason: plainUpdateError(err instanceof Error ? err.message : String(err), this.feed) });
  }

  /**
   * electron-updater loads on the first check, so a dev or test run never touches it. A copy that
   * is not signed with a Developer ID still checks, but does not download: Squirrel.Mac would fetch
   * the update and then refuse to install it, and the status would end on an error you cannot fix.
   */
  private load(): Promise<AppUpdater> {
    this.updater ??= (async () => {
      const { default: pkg } = await import('electron-updater');
      const u = pkg.autoUpdater;
      const signed = process.platform !== 'darwin' || (await bundleSigning()) === 'certificate';
      u.autoDownload = signed;
      u.autoInstallOnAppQuit = true;
      u.on('checking-for-update', () => this.set({ state: 'checking' }));
      u.on('update-not-available', () => this.set({ state: 'current', checkedAt: Date.now() }));
      u.on('update-available', (info) => {
        if (signed) this.set({ state: 'downloading', next: info.version, percent: 0 });
        else
          this.set({
            state: 'manual',
            next: info.version,
            url: `https://github.com/${this.feed!.owner}/${this.feed!.repo}/releases/latest`,
            reason: 'This copy is not signed with a Developer ID, so macOS will not let it replace itself.',
          });
      });
      u.on('download-progress', (p) => {
        if (this.status.state === 'downloading') this.set({ state: 'downloading', next: this.status.next, percent: Math.floor(p.percent) });
      });
      u.on('update-downloaded', (info) => this.set({ state: 'ready', next: info.version }));
      u.on('error', (err) => this.fail(err));
      return u;
    })();
    return this.updater;
  }
}
