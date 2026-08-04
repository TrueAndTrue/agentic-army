/**
 * The war archive's on-disk layout.
 *
 * ```
 * <archiveRoot>/campaigns/<campaign-id>/
 *   campaign.db            # the INDEX
 *   campaign.json          # truth: the CampaignRow
 *   tasks.jsonl            # truth: append-only log of TaskRow snapshots, last-wins
 *   signals.jsonl          # truth: append-only mirror of the signals table
 *   agents/<agent-id>/
 *     agent.json           # truth: the AgentRow
 *     orders.md
 *     report.json
 *     report.md
 *     stream.jsonl
 *     diff.patch
 * ```
 *
 * `campaign.json` / `tasks.jsonl` / `signals.jsonl` / `agent.json` exist for one reason: **SQLite
 * is the index; the files are truth**, and `rebuild-from-files` has to work from day one. The five
 * per-agent artefacts — `orders.md`, `report.json`, `report.md`, `stream.jsonl`, `diff.patch` —
 * carry no campaign, task, agent or signal state at all, so a rebuild from them alone would
 * silently produce an empty database. See `rebuild.ts`.
 *
 * WINDOWS. Every filesystem path is built with `node:path` — no string concatenation, no
 * forward-slash assumptions. Paths that get PERSISTED (`TaskRow.orders_path`, `AgentRow.dir`,
 * `ArtifactRef.ref`) are stored campaign-relative in POSIX form, because a row written on macOS
 * must still resolve when the archive is read on Windows. `resolveInCampaign` is the only way
 * back from a stored path to a real one.
 */

import * as path from 'node:path';

import {
  AGENTS_DIRNAME,
  CAMPAIGNS_DIRNAME,
  CAMPAIGN_DB_FILENAME,
  DIFF_FILENAME,
  MIRRORS_DIRNAME,
  ORDERS_FILENAME,
  REPORT_JSON_FILENAME,
  REPORT_MD_FILENAME,
  STREAM_JSONL_FILENAME,
} from '../contracts/archive.ts';

// ---------------------------------------------------------------------------------------------
// Filenames this module adds on top of the contract's
// ---------------------------------------------------------------------------------------------

/** Truth for `CampaignRow`. */
export const CAMPAIGN_JSON_FILENAME = 'campaign.json';
/** Truth for `TaskRow` — one JSON snapshot per line, last line for an id wins. */
export const TASKS_JSONL_FILENAME = 'tasks.jsonl';
/** Truth for `SignalRow` — append-only, mirrors the append-only table exactly. */
export const SIGNALS_JSONL_FILENAME = 'signals.jsonl';
/** Truth for `AgentRow`, inside the agent's own directory. */
export const AGENT_JSON_FILENAME = 'agent.json';

// ---------------------------------------------------------------------------------------------
// Identifier safety
// ---------------------------------------------------------------------------------------------

/**
 * Campaign and agent ids become directory names, so they are a path-traversal surface. Reject
 * anything that is not a plain single segment before it is ever handed to `path.join`.
 *
 * Deliberately stricter than the filesystem: `[A-Za-z0-9._-]`, no leading dot, no `..`, and no
 * Windows-reserved device name — the archive is shared across platforms, so an id that is legal
 * on one and illegal on another is a bug that only shows up on somebody else's machine.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export function isSafeSegment(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false;
  if (!SAFE_SEGMENT.test(id)) return false;
  if (id === '.' || id === '..') return false;
  if (id.endsWith('.')) return false;
  const stem = id.split('.')[0] ?? '';
  return !WINDOWS_RESERVED.has(stem.toLowerCase());
}

export function assertSafeSegment(id: string, what: string): string {
  if (!isSafeSegment(id)) {
    throw new Error(
      `${what} ${JSON.stringify(id)} is not a safe path segment: ` +
        'expected [A-Za-z0-9][A-Za-z0-9._-]* , not a Windows reserved device name',
    );
  }
  return id;
}

// ---------------------------------------------------------------------------------------------
// POSIX <-> native, for paths that are STORED
// ---------------------------------------------------------------------------------------------

/** Native relative path -> the POSIX form that goes into a row. */
export function toPosixRelative(nativeRelative: string): string {
  return nativeRelative.split(path.sep).join('/');
}

/** A stored POSIX-relative path -> an absolute native path under `campaignRoot`. */
export function resolveInCampaign(campaignRoot: string, posixRelative: string): string {
  const parts = posixRelative.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new Error(`refusing to resolve escaping path ${JSON.stringify(posixRelative)}`);
  }
  return path.resolve(campaignRoot, ...parts);
}

/** Absolute native path -> POSIX path relative to `campaignRoot`, for storage. */
export function relativeToCampaign(campaignRoot: string, absolute: string): string {
  return toPosixRelative(path.relative(campaignRoot, absolute));
}

// ---------------------------------------------------------------------------------------------
// Archive-level
// ---------------------------------------------------------------------------------------------

export function campaignsRoot(archiveRoot: string): string {
  return path.join(archiveRoot, CAMPAIGNS_DIRNAME);
}

/** `<archiveRoot>/mirrors` — the rung-0 durability target. */
export function mirrorsRoot(archiveRoot: string): string {
  return path.join(archiveRoot, MIRRORS_DIRNAME);
}

export function campaignDir(archiveRoot: string, campaignId: string): string {
  return path.join(campaignsRoot(archiveRoot), assertSafeSegment(campaignId, 'campaign id'));
}

// ---------------------------------------------------------------------------------------------
// Campaign-level — take the campaign ROOT, so they work on a directory opened by path alone
// ---------------------------------------------------------------------------------------------

export function campaignDbPath(campaignRoot: string): string {
  return path.join(campaignRoot, CAMPAIGN_DB_FILENAME);
}

export function campaignJsonPath(campaignRoot: string): string {
  return path.join(campaignRoot, CAMPAIGN_JSON_FILENAME);
}

export function tasksJsonlPath(campaignRoot: string): string {
  return path.join(campaignRoot, TASKS_JSONL_FILENAME);
}

export function signalsJsonlPath(campaignRoot: string): string {
  return path.join(campaignRoot, SIGNALS_JSONL_FILENAME);
}

export function agentsDir(campaignRoot: string): string {
  return path.join(campaignRoot, AGENTS_DIRNAME);
}

// ---------------------------------------------------------------------------------------------
// Agent-level
// ---------------------------------------------------------------------------------------------

/** `agents/cpt-03` — the POSIX-relative value that goes into `AgentRow.dir`. */
export function agentDirRelative(agentId: string): string {
  return `${AGENTS_DIRNAME}/${assertSafeSegment(agentId, 'agent id')}`;
}

export function agentDir(campaignRoot: string, agentId: string): string {
  return path.join(agentsDir(campaignRoot), assertSafeSegment(agentId, 'agent id'));
}

export function ordersPath(campaignRoot: string, agentId: string): string {
  return path.join(agentDir(campaignRoot, agentId), ORDERS_FILENAME);
}

export function reportJsonPath(campaignRoot: string, agentId: string): string {
  return path.join(agentDir(campaignRoot, agentId), REPORT_JSON_FILENAME);
}

export function reportMdPath(campaignRoot: string, agentId: string): string {
  return path.join(agentDir(campaignRoot, agentId), REPORT_MD_FILENAME);
}

export function streamJsonlPath(campaignRoot: string, agentId: string): string {
  return path.join(agentDir(campaignRoot, agentId), STREAM_JSONL_FILENAME);
}

export function diffPath(campaignRoot: string, agentId: string): string {
  return path.join(agentDir(campaignRoot, agentId), DIFF_FILENAME);
}

export function agentJsonPath(campaignRoot: string, agentId: string): string {
  return path.join(agentDir(campaignRoot, agentId), AGENT_JSON_FILENAME);
}

/** Stored form of an agent artifact, e.g. `agents/cpt-03/report.md` — for `ArtifactRef.ref`. */
export function agentArtifactRelative(agentId: string, filename: string): string {
  return `${agentDirRelative(agentId)}/${filename}`;
}
