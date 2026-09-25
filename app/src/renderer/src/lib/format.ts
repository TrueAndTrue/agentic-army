import type { AgentRole, NodeRunStatus, NodeType, RunStatus, TokenCount } from '../../../shared/types.ts';

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function duration(startIso: string, endIso?: string): string {
  const ms = (endIso === undefined ? Date.now() : Date.parse(endIso)) - Date.parse(startIso);
  // A Jev call takes a third of a second; "0s" said nothing about it.
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 41, 8.2k, 26k, 1.4M: short enough for a header, exact below 1,000. */
export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "26k in, 89% cached, 41 out", or '' when the CLI reported nothing. */
export function tokenLine(t: TokenCount | undefined): string {
  if (t === undefined || t.input + t.output === 0) return '';
  const share = t.input === 0 ? 0 : Math.round((t.cached / t.input) * 100);
  return `${count(t.input)} in${share > 0 ? `, ${share}% cached` : ''}, ${count(t.output)} out`;
}

/** The exact numbers, for the hover. */
export function tokenDetail(t: TokenCount | undefined): string {
  if (t === undefined) return '';
  const n = (x: number) => x.toLocaleString('en-US');
  const lines = [`Read ${n(t.input)} tokens, ${n(t.cached)} of them from the cache.`, `Wrote ${n(t.output)} tokens.`];
  if (t.context !== undefined) lines.push(`The context held ${n(t.context)} tokens at the end.`);
  return lines.join('\n');
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
  flow: 'var(--brass)',
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
  flow: 'Run flow',
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
