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

/**
 * COMMANDER is the branch of service that only ever talks.
 *
 * It exists because `army chat` needs a soldier whose loadout is ONE INERT TOOL — no Read, no
 * Grep, no Edit, no Bash — and a loadout is chosen by role. Reusing SCOUT would have handed it
 * Read/Grep/Glob/WebFetch, which is precisely the capability that burns a commanding agent's
 * window one file at a time; reusing ENGINEER would have handed it a shell. Neither is a
 * commanding agent, and the difference is not a matter of prompting.
 *
 * ONE INERT TOOL, AND NOT ZERO — the distinction is the reverse of what it looks like.
 * `ROLE_ALLOW.COMMANDER` in `src/command/permissions.ts` is `['TodoWrite']`, and that entry must
 * never be taken out in the name of tidying: `buildClaudeArgs` emits `--allowedTools` only when
 * the list has something in it, so an allow-list holding zero rules drops the flag altogether,
 * and a claude worker spawned without that flag inherits the harness default — which is every
 * tool there is. The emptiest allow-list this codebase can spell is therefore the MOST PERMISSIVE
 * spec it can send, which is why `assertAllowListNonEmpty` refuses that spec at spawn time for
 * every worker, and why `assertCommanderLoadout` refuses a COMMANDER that has additionally grown
 * a rule touching the filesystem, a shell or the network. `TodoWrite` writes a checklist into a
 * context window and never a byte onto disk; it is what keeps the flag on the command line and
 * every other tool off it.
 *
 * A COMMANDER delegates and reads capped reports. That is its whole tool loadout, and because
 * the loadout is derived from this value rather than asserted in a briefing, it is a property of
 * the process rather than a request made of the model.
 */
export const ROLES = ['SCOUT', 'ENGINEER', 'INSPECTOR', 'SENTRY', 'COMMANDER'] as const;

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
 * are structurally incapable of a bad `rm`.
 *
 * `permissionsFor` in `src/command/permissions.ts` reads this map on every spawn and subtracts
 * the write-capable tools — Edit, Write, NotebookEdit and the shell — from the loadout of any
 * rank whose entry is `false`, whatever its role asked for, and names them on the deny half as
 * well. Flip an entry here and the tools a worker of that rank receives change; there is no
 * second copy to keep in step and no generator to re-run.
 *
 * CAPTAIN is the highest rank that writes.
 */
export const WRITES_FILES: Record<Rank, boolean> = {
  GENERAL: false,
  COLONEL: false,
  CAPTAIN: true,
  SERGEANT: true,
  PRIVATE: true,
};

/**
 * Roles that write files at all — meaning HOLD Edit/Write/NotebookEdit, not "cannot cause a byte
 * to change". An INSPECTOR runs `npm test` in a writable tree and is `false` here regardless,
 * because the review gate's independence comes from it never holding an editing tool.
 *
 * Intersected with `WRITES_FILES` by rank in `writesFiles` below. Checked against the loadout it
 * describes on every spawn: `permissionsFor` refuses a role whose `ROLE_ALLOW` entry disagrees
 * with this map, in either direction, so the two cannot drift apart in silence.
 */
export const ROLE_WRITES_FILES: Record<Role, boolean> = {
  SCOUT: false,
  ENGINEER: true,
  INSPECTOR: false,
  SENTRY: false,
  COMMANDER: false,
};

/**
 * Whether a unit of this rank and role holds a tool that puts bytes on disk — the intersection
 * rule, in one place.
 *
 * Rank narrows; it never widens. A role asks for a loadout and its rank subtracts from it, so a
 * COLONEL·ENGINEER writes nothing even though every ENGINEER asks to, and no rank can hand an
 * INSPECTOR an Edit tool the role never asked for.
 */
export function writesFiles(rank: Rank, role: Role): boolean {
  return WRITES_FILES[rank] && ROLE_WRITES_FILES[role];
}

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
