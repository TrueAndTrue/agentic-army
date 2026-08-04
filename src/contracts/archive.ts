/**
 * The war archive.
 *
 * A central home keyed by project, so reports never pollute your repos:
 *
 * ```
 * ~/.agentic-army/campaigns/2026-08-02-take-hill-4/
 *   campaign.db            # agents, tasks, signals, events, timings, cost
 *   agents/cpt-03/
 *     orders.md            # cat-able
 *     report.json          # the schema-capped return
 *     report.md            # full findings
 *     stream.jsonl         # raw duplex output — live view AND full replay
 *     diff.patch
 * ```
 *
 * **SQLite is the index; files are truth.** A `rebuild-from-files` command must exist from day
 * one or that seam rots. Every row type below must therefore be reconstructible from the files
 * on disk alone — if a column cannot be, it does not belong here.
 *
 * Field names are snake_case because these are row shapes, mapped 1:1 onto SQL columns.
 * `node:sqlite` is functional but flagged experimental; keep it behind a thin interface so
 * `bun:sqlite` and `better-sqlite3` remain drop-ins.
 */

import type { Rank, Role } from './ranks.ts';
import type { HarnessId, SoldierEventType } from './harness.ts';
import type { Rung } from './delivery.ts';

/** `~/.agentic-army/campaigns/<campaign-id>/` */
export const CAMPAIGNS_DIRNAME = 'campaigns';
/** `~/.agentic-army/mirrors/<project>.git` — the rung-0 durability target. */
export const MIRRORS_DIRNAME = 'mirrors';
/** Per-campaign SQLite index. */
export const CAMPAIGN_DB_FILENAME = 'campaign.db';
/** Per-agent directory under `<campaign>/agents/<agent-id>/`. */
export const AGENTS_DIRNAME = 'agents';
/** Files that are truth. */
export const ORDERS_FILENAME = 'orders.md';
export const REPORT_JSON_FILENAME = 'report.json';
export const REPORT_MD_FILENAME = 'report.md';
export const STREAM_JSONL_FILENAME = 'stream.jsonl';
export const DIFF_FILENAME = 'diff.patch';

export const CAMPAIGN_STATUSES = ['active', 'done', 'failed', 'aborted'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * An agent is a process; a task is intent. `queued` is the load-bearing state — unstarted work
 * must live somewhere other than a commanding agent's context window.
 */
export const TASK_STATUSES = ['queued', 'in_flight', 'done', 'failed', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const AGENT_STATUSES = [
  'spawning',
  'running',
  'idle',
  'exited',
  'failed',
  'interrupted',
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** The signal kinds the bus carries: `order|report|query|answer|broadcast|status`. */
export const SIGNAL_KINDS = ['order', 'report', 'query', 'answer', 'broadcast', 'status'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface CampaignRow {
  /** Directory-safe and date-led: `2026-08-02-take-hill-4`. */
  id: string;
  /** Absolute path of the project this campaign is fought in. Keys into `GlobalConfig.projects`. */
  project: string;
  title: string;
  status: CampaignStatus;
  /** ISO-8601. */
  created_at: string;
  ended_at: string | null;
  /** Absolute path of the campaign directory in the archive. */
  root_dir: string;
}

/**
 * Tasks nest and live in the DB. A task with `agent_id: null` and `status: 'queued'` is
 * real work that no process has ever touched — that is the point of the table.
 */
export interface TaskRow {
  id: string;
  campaign_id: string;
  /** Null for the campaign's root task. */
  parent_task_id: string | null;
  title: string;
  status: TaskStatus;
  /** The agent id of the CURRENT attempt; null while queued or between retries. */
  agent_id: string | null;
  /** How many agents have attempted this task. An agent is one attempt at a task. */
  attempts: number;
  /** Path to the task's orders, relative to the campaign root. */
  orders_path: string | null;
  /** `army/<task-id>` once an Engineer cuts it. */
  branch: string | null;
  /** The highest delivery rung actually reached; null if nothing shipped yet. */
  delivered_rung: Rung | null;
  /** PR url once rung 2 is reached. */
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

/** One attempt at a task — a real process (or a native subagent of one). */
export interface AgentRow {
  /** Supervisor-minted: `cpt-03`. */
  id: string;
  campaign_id: string;
  /** Null for an agent not bound to a task (e.g. a synthesist). */
  task_id: string | null;
  parent_agent_id: string | null;
  rank: Rank;
  role: Role;
  harness: HarnessId;
  model: string | null;
  effort: string | null;
  /** The `--session-id` this agent was spawned with; `--resume` key after a crash. */
  session_id: string;
  /** 1-based attempt number for `task_id`. */
  attempt: number;
  /**
   * Spawn depth. Deliberately a SEPARATE column from `rank` — rank is assigned by the
   * spawner, depth is structural, and the gap between them is diagnostic.
   */
  depth: number;
  status: AgentStatus;
  /** Absolute path of the leased worktree; null for read-only roles. */
  worktree_path: string | null;
  /** Worktree lease id — required for an ABA-safe conditional return. See `Lease.leaseId`. */
  lease_id: string | null;
  /** Agent directory relative to the campaign root: `agents/cpt-03`. */
  dir: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
}

/**
 * The message bus. One append-only table; any inter-agent communication is a row.
 *
 * **INVARIANT: append-only. Never add a `state` column, and never UPDATE a row.**
 * A query is answered iff an `answer` row exists with `in_reply_to = seq`. Current state is
 * COMPUTED from the log, never stored. Nothing is ever mutated, so there is no lost update —
 * firstmate's hardest-won rule.
 *
 * `seq` is a total order and is never reused. `body` is capped; anything large goes to a file
 * and `artifact` points at it.
 *
 * Addressing: `to_agent` is an explicit id an agent is entitled to name (its own chain, plus
 * units a common ancestor attached to it); `to_selector` is `'chain'` / `'role:SCOUT'` /
 * `'owner:auth-schema'`, resolved and logged by the supervisor — because a depth-4 Private has
 * never seen the org chart and cannot know an id it was never told.
 *
 * Orders still flow strictly downward. The bus is requests and audit, not command — and it is
 * addressing and audit, NOT wake.
 */
export interface SignalRow {
  /** INTEGER PRIMARY KEY AUTOINCREMENT — total order, never reused. */
  seq: number;
  ts: string;
  from_agent: string;
  /** Explicit agent id… */
  to_agent: string | null;
  /** …or `chain` / `role:SCOUT` / `owner:auth-schema`. */
  to_selector: string | null;
  kind: SignalKind;
  /** REFERENCES signals(seq). An `answer` row's link back to its `query`. */
  in_reply_to: number | null;
  /** Capped. */
  body: string;
  /** Pointer to the big stuff. */
  artifact: string | null;
}

/**
 * The index over `stream.jsonl`. The FILE is truth — this row exists so the dashboard can seek
 * without replaying, and so `rebuild-from-files` can regenerate the whole table from the
 * jsonl on disk. `payload` is the serialized normalised `SoldierEvent`, including its `raw`
 * line, so a row alone is enough to replay.
 */
export interface EventRow {
  seq: number;
  campaign_id: string;
  agent_id: string;
  ts: string;
  type: SoldierEventType;
  /** Byte offset of the line in `stream.jsonl`, for seeking. Null if not tracked. */
  offset: number | null;
  /** Reconstructs the org chart including the native-subagent layer. */
  parent_tool_use_id: string | null;
  depth: number;
  /** JSON text of the full normalised `SoldierEvent`. */
  payload: string;
}
