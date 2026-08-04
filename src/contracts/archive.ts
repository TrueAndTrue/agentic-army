/**
 * The war archive.
 *
 * A central home keyed by project, so reports never pollute your repos:
 *
 * ```
 * ~/.agentic-army/campaigns/2026-08-02-take-hill-4/
 *   campaign.db            # the INDEX: agents, tasks, signals, events, timings, cost
 *   campaign.json          # truth: the CampaignRow
 *   tasks.jsonl            # truth: append-only TaskRow snapshots, last line per id wins
 *   signals.jsonl          # truth: append-only mirror of the signals table
 *   agents/cpt-03/
 *     agent.json           # truth: the AgentRow
 *     orders.md            # cat-able
 *     report.json          # the schema-capped return
 *     report.md            # full findings
 *     stream.jsonl         # raw duplex output — live view AND full replay
 *     diff.patch
 * ```
 *
 * **SQLite is the index; files are truth.** `army rebuild` (`src/archive/rebuild.ts`) throws
 * `campaign.db` away and puts it back from `campaign.json`, `tasks.jsonl`, `signals.jsonl`,
 * `agents/<id>/agent.json` and `agents/<id>/stream.jsonl`, without ever reading the existing
 * database. Every row type below must therefore be reconstructible from the files on disk alone
 * — if a column cannot be, it does not belong here.
 *
 * THE FOUR TRUTH FILES ARE LISTED ABOVE ON PURPOSE. This block used to show only `campaign.db`
 * and the per-agent artifacts, which made the rebuild claim in the paragraph below unreadable:
 * it named files the layout it sits under did not contain. `test/contracts.test.ts` now fails if
 * any file `rebuild.ts` reads is missing from this comment, so the two cannot drift again.
 * Their names live in `src/archive/paths.ts` (`CAMPAIGN_JSON_FILENAME` and friends) rather than
 * here, because this module is row shapes and that one is paths.
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
/**
 * `~/.agentic-army/mirrors/<basename>-<sha1-8>.git` — the rung-0 durability target.
 *
 * The 8-char digest of the project's ABSOLUTE path is part of the name, not decoration, and the
 * spelling is `mirrorPathFor` in `src/delivery/durability.ts`. Two checkouts sharing a basename
 * — `~/work/api` and `~/oss/api` — would otherwise share one bare repo, and `army/<task-id>`
 * from one would collide with the identical branch name from the other.
 *
 * This comment used to name a bare basename with no digest, describing exactly the collision the
 * code goes out of its way not to have. The old spelling is not written out here even as a
 * counter-example: `test/contracts.test.ts` greps for it, and a disowned quote and a live claim
 * look identical to `grep`.
 */
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
  /**
   * The session id this agent was spawned with. Supervisor-minted, so identity never has to be
   * parsed out of the child's output — that part is true of every harness and is the reason the
   * column exists.
   *
   * IT IS NOT A RESUME KEY TODAY. The claude adapter passes it as `--session-id`; the codex
   * adapter has no analogue and records it for identity only, and nothing in this tree emits
   * `--resume` or `codex exec resume`. See the resume note in `src/contracts/harness.ts`.
   */
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
 * Addressing: `to_agent` is an explicit agent id, and that half runs — `army campaign` and
 * `army chat` both write real ids on real rows.
 *
 * `to_selector` is the symbolic half, and it is NOT RESOLVED YET. The column is written (the
 * campaign opens with `to_selector = 'chain'`), stored, indexed and queryable, and that is all:
 * nothing expands a selector into a set of recipients, so `'role:SCOUT'` and
 * `'owner:auth-schema'` are the shape the column is built for, not traffic it carries. Treat a
 * selector as a LABEL on a row today, not as an address that reaches anybody.
 *
 * WHAT WOULD TRIGGER BUILDING IT: the first agent that must address a unit whose id it was never
 * told — a depth-4 Private answering a broadcast, or any fan-out wider than the one chain a
 * campaign currently runs. Until a second concurrent unit exists to address, a resolver has
 * nothing to resolve, which is why the column ships ahead of it rather than the other way round.
 *
 * Orders still flow strictly downward. The bus is requests and audit, not command — and it is
 * addressing and audit, NOT wake.
 */
export interface SignalRow {
  /** INTEGER PRIMARY KEY AUTOINCREMENT — total order, never reused. */
  seq: number;
  ts: string;
  from_agent: string;
  /** Explicit agent id. The half that is delivered. */
  to_agent: string | null;
  /** The symbolic half — `chain` today, `role:…` / `owner:…` when a resolver exists. See above. */
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
