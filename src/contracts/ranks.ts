/**
 * Ranks and roles.
 *
 * Rank is authority. Role is branch of service. They are orthogonal: any role can hold any
 * rank. Rank is assigned by the spawner and MUST be strictly junior to the spawner's own rank
 * (`isStrictlyJuniorTo`) — it is never derived from depth. Depth and rank are separate columns
 * in the UI and the gap between them is diagnostic.
 */

/** Seniority order, most senior first. Index into this array IS the seniority number. */
export const RANK_ORDER = [
  'GENERAL',
  'COLONEL',
  'CAPTAIN',
  'SERGEANT',
  'PRIVATE',
] as const;

export type Rank = (typeof RANK_ORDER)[number];

export const ROLES = ['SCOUT', 'ENGINEER', 'INSPECTOR', 'SENTRY'] as const;

export type Role = (typeof ROLES)[number];

/**
 * Seniority index. Lower is more senior. GENERAL = 0 … PRIVATE = 4.
 * Never persist this number — persist the `Rank` string; the index is presentation/comparison
 * only and would silently change meaning if a rank were ever inserted.
 */
export const RANK_SENIORITY: Record<Rank, number> = {
  GENERAL: 0,
  COLONEL: 1,
  CAPTAIN: 2,
  SERGEANT: 3,
  PRIVATE: 4,
};

/** UI glyphs. */
export const RANK_GLYPH: Record<Rank, string> = {
  GENERAL: '☆', // ☆
  COLONEL: '◆', // ◆
  CAPTAIN: '◇', // ◇
  SERGEANT: '▪', // ▪
  PRIVATE: '·', // ·
};

/** Three-letter unit prefix used in labels: `CPT·ENGINEER · take-hill-4`. */
export const RANK_ABBREV: Record<Rank, string> = {
  GENERAL: 'GEN',
  COLONEL: 'COL',
  CAPTAIN: 'CPT',
  SERGEANT: 'SGT',
  PRIVATE: 'PVT',
};

export const SUBSTRATES = ['process', 'subagent'] as const;
export type Substrate = (typeof SUBSTRATES)[number];

/**
 * Substrate. Commanding ranks are real OS processes (durable, observable,
 * resumable); the cheap fan-out layer below them uses native Claude Code subagents (free depth).
 * A `subagent` rank has no session of its own on disk — it is reconstructed from the parent
 * process's stream via `--forward-subagent-text` + `parent_tool_use_id`.
 */
export const SUBSTRATE: Record<Rank, Substrate> = {
  GENERAL: 'process',
  COLONEL: 'process',
  CAPTAIN: 'process',
  SERGEANT: 'subagent',
  PRIVATE: 'subagent',
};

/**
 * Officers never edit files.
 *
 * This is simultaneously the context guard and the safety property: the ranks holding strategy
 * are structurally incapable of a bad `rm`. Enforced downstream by the permission allow-list
 *; this map is the single source of truth that generator consults.
 *
 * CAPTAIN is the lowest rank with a worktree and the highest rank that writes.
 */
export const WRITES_FILES: Record<Rank, boolean> = {
  GENERAL: false,
  COLONEL: false,
  CAPTAIN: true,
  SERGEANT: true,
  PRIVATE: true,
};

/** Roles that write files at all. Intersected with `WRITES_FILES` by rank. */
export const ROLE_WRITES_FILES: Record<Role, boolean> = {
  SCOUT: false,
  ENGINEER: true,
  INSPECTOR: false,
  SENTRY: false,
};

/** Only Engineers need a worktree. Inspectors attach read-only to the Engineer's. */
export const ROLE_NEEDS_WORKTREE: Record<Role, boolean> = {
  SCOUT: false,
  ENGINEER: true,
  INSPECTOR: false,
  SENTRY: false,
};

/**
 * True iff `child` is strictly junior to `parent` — the spawn rule.
 *
 * A rank may never spawn its own rank or above. Equal ranks are NOT junior, so this is a strict
 * comparison: `isStrictlyJuniorTo('CAPTAIN', 'CAPTAIN') === false`.
 *
 * Note it is legal to skip ranks: a GENERAL may detach a CAPTAIN directly without standing up a
 * ceremonial COLONEL.
 */
export function isStrictlyJuniorTo(child: Rank, parent: Rank): boolean {
  return RANK_SENIORITY[child] > RANK_SENIORITY[parent];
}

/**
 * The UI label for a unit: `CPT·ENGINEER · take-hill-4`.
 * Omit `taskId` for a unit not yet bound to a task (e.g. a GENERAL holding a campaign).
 */
export function formatUnit(rank: Rank, role: Role, taskId?: string): string {
  const unit = `${RANK_ABBREV[rank]}·${role}`;
  return taskId === undefined || taskId === '' ? unit : `${unit} · ${taskId}`;
}

/** `☆ GEN·ENGINEER` — the glyph-prefixed form for tree views. */
export function formatUnitWithGlyph(rank: Rank, role: Role, taskId?: string): string {
  return `${RANK_GLYPH[rank]} ${formatUnit(rank, role, taskId)}`;
}
