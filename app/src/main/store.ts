/**
 * Everything the app keeps, as JSON files under one directory. Writes go to a temporary file and
 * are renamed into place, so a crash mid-write leaves the previous version rather than half a file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Flow, Project, Run, Session, Settings } from '../shared/types.ts';

export const DEFAULT_SETTINGS: Settings = {
  models: [
    { id: 'claude-opus', harness: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet', harness: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-fable', harness: 'claude', model: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'claude-haiku', harness: 'claude', model: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { id: 'codex-gpt55', harness: 'codex', model: 'gpt-5.5', label: 'GPT-5.5' },
  ],
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

export class Store {
  readonly root: string;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, () => void>();

  constructor(root: string) {
    this.root = root;
    for (const d of ['flows', 'sessions', 'runs', 'worktrees']) mkdirSync(join(root, d), { recursive: true });
  }

  get worktreeRoot(): string {
    return join(this.root, 'worktrees');
  }

  loadSettings(): Settings {
    const saved = readJson<Partial<Settings>>(join(this.root, 'settings.json'));
    const envKey = process.env['TYPESAFE_API_KEY'] ?? '';
    const merged: Settings = {
      ...DEFAULT_SETTINGS,
      ...(saved ?? {}),
      typesafe: { ...DEFAULT_SETTINGS.typesafe, ...(saved?.typesafe ?? {}) },
      stageDefaults: { ...DEFAULT_SETTINGS.stageDefaults, ...(saved?.stageDefaults ?? {}) },
    };
    if (merged.typesafe.apiKey === '' && envKey !== '') merged.typesafe = { ...merged.typesafe, apiKey: envKey };
    return merged;
  }

  saveSettings(s: Settings): void {
    writeJson(join(this.root, 'settings.json'), s);
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
