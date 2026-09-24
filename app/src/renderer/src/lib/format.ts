import type { AgentRole, NodeRunStatus, NodeType, RunStatus } from '../../../shared/types.ts';

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function duration(startIso: string, endIso?: string): string {
  const ms = (endIso === undefined ? Date.now() : Date.parse(endIso)) - Date.parse(startIso);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function usd(n: number | undefined): string {
  if (n === undefined || n === 0) return '';
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

export const ROLE_COLOR: Record<AgentRole, string> = {
  scout: 'var(--scout)',
  planner: 'var(--planner)',
  engineer: 'var(--engineer)',
  reviewer: 'var(--reviewer)',
  validator: 'var(--validator)',
};

export const TYPE_COLOR: Record<Exclude<NodeType, 'agent'>, string> = {
  start: 'var(--muted)',
  decide: 'var(--brass)',
  human: 'var(--human)',
  shell: 'var(--shell)',
  git: 'var(--git)',
  browser: 'var(--browser)',
  join: 'var(--muted)',
  end: 'var(--muted)',
};

export const TYPE_LABEL: Record<NodeType, string> = {
  start: 'Start',
  agent: 'Agent',
  decide: 'Jev decision',
  human: 'Your approval',
  shell: 'Command',
  git: 'Git',
  browser: 'Browser',
  join: 'Join',
  end: 'End',
};

export const NODE_STATUS_COLOR: Record<NodeRunStatus, string> = {
  idle: 'var(--line-strong)',
  queued: 'var(--faint)',
  running: 'var(--run)',
  waiting: 'var(--warn)',
  done: 'var(--ok)',
  failed: 'var(--bad)',
  skipped: 'var(--line-strong)',
  stopped: 'var(--faint)',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  waiting: 'Waiting on you',
  succeeded: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
};

export const RUN_STATUS_COLOR: Record<RunStatus, string> = {
  running: 'var(--run)',
  waiting: 'var(--warn)',
  succeeded: 'var(--ok)',
  failed: 'var(--bad)',
  stopped: 'var(--faint)',
};
