/**
 * The window's copy of the app state. The main process owns the truth and pushes changes as
 * events; this module keeps the latest of each and lets components subscribe.
 */

import { useSyncExternalStore } from 'react';

import type { AppEvent, Api, Flow, Project, Run, Session, SessionSummary, Settings } from '../../../shared/types.ts';

declare global {
  interface Window {
    api: Api;
  }
}

export const api = (): Api => window.api;

export type View =
  | { kind: 'home' }
  | { kind: 'session'; id: string }
  | { kind: 'flows'; flowId: string | null }
  | { kind: 'settings' };

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
};

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

export async function newSession(projectId: string): Promise<void> {
  const s = await api().createSession(projectId);
  setState((st) => ({ sessionById: { ...st.sessionById, [s.id]: s }, panelRunId: null }));
  go({ kind: 'session', id: s.id });
}
