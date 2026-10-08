/**
 * Everything the app keeps, as JSON files under one directory. Writes go to a temporary file and
 * are renamed into place, so a crash mid-write leaves the previous version rather than half a file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Flow, Project, Run, Session, Settings } from '../shared/types.ts';
import { log } from './log.ts';
import { CLAUDE_MODELS } from './models.ts';

export const DEFAULT_SETTINGS: Settings = {
  // codex's current models join these from its own list when the app starts; see models.ts.
  models: [...CLAUDE_MODELS, { id: 'codex-gpt55', harness: 'codex', model: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], source: 'codex' }],
  stageDefaults: {
    scout: { modelId: 'claude-sonnet', effort: 'high' },
    planner: { modelId: 'claude-opus', effort: 'high' },
    engineer: { modelId: 'claude-sonnet', effort: 'xhigh' },
    reviewer: { modelId: 'codex-gpt55', effort: 'high' },
    validator: { modelId: 'codex-gpt55', effort: 'high' },
  },
  chatDefault: { modelId: 'claude-sonnet', effort: 'high' },
  typesafe: { apiKey: '', model: 'jev-latest', baseUrl: 'https://api.typesafe.ai' },
  posture: 'unguarded',
  claudeBin: '',
  codexBin: '',
  theme: 'system',
};

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, file);
}

/**
 * How the keys in settings.json are kept encrypted at rest. The app passes Electron's safeStorage,
 * which on macOS keeps its own key in the login Keychain. Unit tests and live scripts run in plain
 * Node, where there is no safeStorage, and pass nothing: the keys are then read and written as
 * they always were.
 */
export interface Secrets {
  available(): boolean;
  /** Plain text in, base64 out. */
  encrypt(plain: string): string;
  /** Base64 in, plain text out. Throws when this machine's Keychain cannot open it. */
  decrypt(sealed: string): string;
}

/** Marks an encrypted value in settings.json, so a plain key from an older version is told apart. */
export const ENCRYPTED = 'encrypted:';

export class Store {
  readonly root: string;
  private readonly secrets: Secrets | null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, () => void>();

  constructor(root: string, opts: { secrets?: Secrets } = {}) {
    this.root = root;
    this.secrets = opts.secrets ?? null;
    for (const d of ['flows', 'sessions', 'runs', 'worktrees']) mkdirSync(join(root, d), { recursive: true });
  }

  private canEncrypt(): boolean {
    try {
      return this.secrets?.available() === true;
    } catch {
      return false;
    }
  }

  /**
   * A key as settings.json holds it, in the clear. One that cannot be decrypted, from a settings
   * file copied off another Mac or after the Keychain item was reset, counts as no key, so the
   * usual "add a key" card and Settings field take over instead of a crash.
   */
  private open(stored: string | undefined, what: string): { key: string; plain: boolean } {
    if (stored === undefined || stored === '') return { key: '', plain: false };
    if (!stored.startsWith(ENCRYPTED)) return { key: stored, plain: true };
    if (this.secrets === null || !this.canEncrypt()) {
      log.warn(`settings.json holds an encrypted ${what}, and this process has no way to decrypt it. Treating it as no key.`);
      return { key: '', plain: false };
    }
    try {
      return { key: this.secrets.decrypt(stored.slice(ENCRYPTED.length)), plain: false };
    } catch (err) {
      log.warn(`The ${what} in settings.json could not be decrypted (${err instanceof Error ? err.message : String(err)}), so the app treats it as no key. Paste the key again in Settings.`);
      return { key: '', plain: false };
    }
  }

  private seal(key: string | undefined): string | undefined {
    if (key === undefined || key === '' || this.secrets === null || !this.canEncrypt()) return key;
    try {
      return `${ENCRYPTED}${this.secrets.encrypt(key)}`;
    } catch (err) {
      // Losing the key you just pasted would be worse than keeping it the way older versions did.
      log.error('Could not encrypt a key, so it is saved unencrypted this time', err);
      return key;
    }
  }

  get worktreeRoot(): string {
    return join(this.root, 'worktrees');
  }

  loadSettings(): Settings {
    const saved = readJson<Partial<Settings>>(join(this.root, 'settings.json'));
    const envKey = process.env['TYPESAFE_API_KEY'] ?? '';
    const typesafe = this.open(saved?.typesafe?.apiKey, 'TypeSafe key');
    const brave = this.open(saved?.braveApiKey, 'Brave key');
    const merged: Settings = {
      ...DEFAULT_SETTINGS,
      ...(saved ?? {}),
      typesafe: { ...DEFAULT_SETTINGS.typesafe, ...(saved?.typesafe ?? {}), apiKey: typesafe.key },
      stageDefaults: { ...DEFAULT_SETTINGS.stageDefaults, ...(saved?.stageDefaults ?? {}) },
    };
    if (saved?.braveApiKey !== undefined) merged.braveApiKey = brave.key;
    // A key an older version saved in the clear is encrypted now, before anything else reads the file.
    if ((typesafe.plain || brave.plain) && this.canEncrypt()) {
      this.saveSettings(merged);
      log.info('Moved the keys in settings.json into encrypted storage.');
    }
    // The environment fills in a missing key after the rewrite, so it is not written to disk just
    // for being set where the app started.
    if (merged.typesafe.apiKey === '' && envKey !== '') merged.typesafe = { ...merged.typesafe, apiKey: envKey };
    return merged;
  }

  saveSettings(s: Settings): void {
    const typesafe = this.seal(s.typesafe.apiKey) ?? '';
    const brave = this.seal(s.braveApiKey);
    writeJson(join(this.root, 'settings.json'), { ...s, typesafe: { ...s.typesafe, apiKey: typesafe }, ...(brave === undefined ? {} : { braveApiKey: brave }) });
  }

  loadProjects(): Project[] {
    return readJson<Project[]>(join(this.root, 'projects.json')) ?? [];
  }

  saveProjects(p: Project[]): void {
    writeJson(join(this.root, 'projects.json'), p);
  }

  private loadDir<T>(dir: string): T[] {
    const out: T[] = [];
    for (const f of readdirSync(join(this.root, dir))) {
      if (!f.endsWith('.json')) continue;
      const v = readJson<T>(join(this.root, dir, f));
      if (v !== null) out.push(v);
    }
    return out;
  }

  loadFlows(): Flow[] {
    return this.loadDir<Flow>('flows');
  }

  saveFlow(f: Flow): void {
    writeJson(join(this.root, 'flows', `${f.id}.json`), f);
  }

  deleteFlow(id: string): void {
    rmSync(join(this.root, 'flows', `${id}.json`), { force: true });
  }

  loadSessions(): Session[] {
    return this.loadDir<Session>('sessions');
  }

  loadRun(id: string): Run | null {
    return readJson<Run>(join(this.root, 'runs', `${id}.json`));
  }

  loadRuns(): Run[] {
    return this.loadDir<Run>('runs');
  }

  /** Streaming output changes a session many times a second; disk sees it at most twice a second. */
  saveSessionSoon(s: Session): void {
    this.soon(`s:${s.id}`, () => writeJson(join(this.root, 'sessions', `${s.id}.json`), s));
  }

  saveRunSoon(r: Run): void {
    this.soon(`r:${r.id}`, () => writeJson(join(this.root, 'runs', `${r.id}.json`), r));
  }

  deleteSession(id: string, runIds: string[]): void {
    this.cancel(`s:${id}`);
    rmSync(join(this.root, 'sessions', `${id}.json`), { force: true });
    for (const r of runIds) {
      this.cancel(`r:${r}`);
      rmSync(join(this.root, 'runs', `${r}.json`), { force: true });
    }
  }

  private cancel(key: string): void {
    const t = this.timers.get(key);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(key);
    this.pending.delete(key);
  }

  private soon(key: string, write: () => void): void {
    this.pending.set(key, write);
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const w = this.pending.get(key);
        this.pending.delete(key);
        w?.();
      }, 500),
    );
  }

  /** Write everything still waiting. Called on quit. */
  flush(): void {
    for (const [key, t] of this.timers) {
      clearTimeout(t);
      this.pending.get(key)?.();
    }
    this.timers.clear();
    this.pending.clear();
  }

  exists(): boolean {
    return existsSync(this.root);
  }
}
