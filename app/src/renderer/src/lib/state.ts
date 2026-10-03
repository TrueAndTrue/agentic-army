/**
 * The window's copy of the app state. The main process owns the truth and pushes changes as
 * events; this module keeps the latest of each and lets components subscribe.
 */

import { useSyncExternalStore } from 'react';

import type { AppEvent, Api, DoctorReport, Flow, Project, Run, Session, SessionSummary, Settings, UpdateStatus } from '../../../shared/types.ts';

declare global {
  interface Window {
    api: Api;
  }
}

export const api = (): Api => window.api;

export type View =
  | { kind: 'home' }
  | { kind: 'session'; id: string }
  /** `draft` opens Draft with AI in place of the list. */
  | { kind: 'flows'; flowId: string | null; draft?: boolean }
  | { kind: 'settings'; section?: 'jev' | 'models' | 'machine' | 'stages' | 'tools' };

export interface State {
  ready: boolean;
  projects: Project[];
  sessions: SessionSummary[];
  flows: Flow[];
  settings: Settings | null;
  view: View;
  sessionById: Record<string, Session>;
  runById: Record<string, Run>;
  /** The run shown in the side panel, if any, and which tab it opens on. */
  panelRunId: string | null;
  panelTab: 'map' | 'steps' | 'changes';
  /** The last check of claude, codex, git and Jev. Null until the first one ends. */
  doctor: DoctorReport | null;
  doctorAt: number;
  /** A short message at the bottom of the window, for errors with nowhere else to go. */
  toast: { text: string; tone: 'info' | 'error' } | null;
  /** The updater's latest status, and the version whose "ready" notice you closed. */
  update: UpdateStatus | null;
  updateDismissed: string | null;
}

let state: State = {
  ready: false,
  projects: [],
  sessions: [],
  flows: [],
  settings: null,
  view: { kind: 'home' },
  sessionById: {},
  runById: {},
  panelRunId: null,
  panelTab: 'map',
  doctor: null,
  doctorAt: 0,
  toast: null,
  update: null,
  updateDismissed: null,
};

let checking: Promise<DoctorReport> | null = null;

/**
 * Check claude, codex, git and Jev. The answer is kept for a few minutes, so opening Settings does
 * not re-run a live Jev call and show "Checking…" every time; `force` checks again now.
 */
export function checkMachine(force = false): Promise<DoctorReport> {
  const s = getState();
  if (!force && s.doctor !== null && Date.now() - s.doctorAt < 5 * 60_000) return Promise.resolve(s.doctor);
  if (checking !== null && !force) return checking;
  const p = api()
    .doctor()
    .then((d) => {
      setState({ doctor: d, doctorAt: Date.now() });
      return d;
    })
    .finally(() => {
      if (checking === p) checking = null;
    });
  checking = p;
  return p;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, tone: 'info' | 'error' = 'error'): void {
  setState({ toast: { text, tone } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), 6000);
}

/** Add a folder as a project and open a session there. Adding one you have opens its latest session. */
export async function addProjectFlow(path?: string): Promise<void> {
  try {
    const known = new Set(getState().projects.map((p) => p.id));
    const p = await api().addProject(path);
    if (p === null) return;
    const latest = getState().sessions.find((x) => x.projectId === p.id);
    if (known.has(p.id) && latest !== undefined) {
      toast(`${p.name} is already here.`, 'info');
      await openSession(latest.id);
      return;
    }
    await newSession(p.id);
  } catch (err) {
    toast(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
  }
}

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

function applyTheme(settings: Settings | null): void {
  const mode = settings?.theme ?? 'system';
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}

export async function boot(): Promise<void> {
  const initial = await api().getState();
  const lastView = readLastView();
  setState({ ...initial, ready: true, view: lastView ?? { kind: 'home' } });
  applyTheme(initial.settings);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getState().settings));
  api().onEvent(onEvent);
  void api()
    .updateStatus()
    .then((update) => setState((s) => ({ update: s.update ?? update })));
  if (lastView?.kind === 'session') await openSession(lastView.id);
}

function onEvent(ev: AppEvent): void {
  switch (ev.type) {
    case 'session':
      setState((s) => ({ sessionById: { ...s.sessionById, [ev.session.id]: ev.session } }));
      break;
    case 'sessions':
      setState({ sessions: ev.sessions });
      break;
    case 'run':
      setState((s) => ({ runById: { ...s.runById, [ev.run.id]: ev.run } }));
      break;
    case 'flows':
      setState({ flows: ev.flows });
      break;
    case 'settings':
      setState({ settings: ev.settings });
      applyTheme(ev.settings);
      break;
    case 'projects':
      setState({ projects: ev.projects });
      break;
    case 'update':
      setState({ update: ev.update });
      break;
  }
}

const VIEW_KEY = 'army.view';

function readLastView(): View | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return raw === null ? null : (JSON.parse(raw) as View);
  } catch {
    return null;
  }
}

export function go(view: View): void {
  setState({ view });
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* storage is a convenience */
  }
}

export async function openSession(id: string): Promise<void> {
  const session = await api().getSession(id);
  if (session === null) {
    go({ kind: 'home' });
    return;
  }
  const runs: Record<string, Run> = {};
  await Promise.all(
    session.items.map(async (it) => {
      if (it.kind !== 'run') return;
      const r = await api().getRun(it.runId);
      if (r !== null) runs[r.id] = r;
    }),
  );
  setState((s) => ({ sessionById: { ...s.sessionById, [id]: session }, runById: { ...s.runById, ...runs }, panelRunId: null }));
  go({ kind: 'session', id });
}

/** A new session whose message box is set to run `flowId`, waiting for you to say the objective. */
export async function newFlowSession(projectId: string, flowId: string): Promise<void> {
  const s = await api().createSession(projectId);
  try {
    localStorage.setItem(`army.target.${s.id}`, flowId);
  } catch {
    /* the box falls back to chat */
  }
  setState((st) => ({ sessionById: { ...st.sessionById, [s.id]: s }, panelRunId: null }));
  go({ kind: 'session', id: s.id });
}

export async function newSession(projectId: string): Promise<void> {
  const s = await api().createSession(projectId);
  setState((st) => ({ sessionById: { ...st.sessionById, [s.id]: s }, panelRunId: null }));
  go({ kind: 'session', id: s.id });
}
