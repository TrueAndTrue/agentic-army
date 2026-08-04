/**
 * The war archive.
 *
 * A campaign is a DIRECTORY, and `campaign.db` is an index over it. Every mutation therefore
 * writes the file first-class and the row second: `appendSignal` appends to `signals.jsonl`
 * inside the same transaction that inserts the row, `appendEvent` appends to `stream.jsonl`
 * before recording its byte offset, and `rebuild.ts` can throw the database away and put it back.
 * If the two ever disagree, the file wins — that is what "SQLite is the index; files are truth"
 * has to mean operationally for it to mean anything at all.
 *
 * The API is SYNCHRONOUS. `node:sqlite` is a synchronous driver, the writes are small, and an
 * async facade over a sync core would buy nothing except the chance to interleave two writers
 * inside one process and reorder the log. `BEGIN IMMEDIATE` + `busy_timeout` is what makes
 * concurrent supervisor PROCESSES safe, and that mechanism is indifferent to promises.
 *
 * Three invariants this module refuses to break:
 *
 * - **signals is append-only.** There is no `updateSignal`, no `deleteSignal`, and the database
 *   itself rejects both (`schema.ts`). A query is answered iff an `answer` row exists with
 *   `in_reply_to = seq` — `isAnswered()` is a query, not a column.
 * - **A task may have no agent.** `queued` is a real state with no process, and every read
 *   path here handles `agent_id: null` as normal rather than as missing data.
 * - **Cost and timing are recorded, never inferred.** `finishAgent` writes exactly the numbers it
 *   is handed; a harness that reports no cost leaves NULL, and `ledger()` counts those separately
 *   instead of quietly treating them as zero.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AgentRow,
  AgentStatus,
  CampaignRow,
  CampaignStatus,
  EventRow,
  SignalKind,
  SignalRow,
  TaskRow,
  TaskStatus,
} from '../contracts/archive.ts';
import type { SoldierEvent, SoldierEventType, HarnessId } from '../contracts/harness.ts';
import type { Rank, Role } from '../contracts/ranks.ts';
import type { Rung } from '../contracts/delivery.ts';
import type { Report } from '../contracts/report.ts';

import type { Db, DbFactory, DbStatement } from './db.ts';
import { assertArchivePragmas, openDb } from './db.ts';

/**
 * Re-exported so the durability trade-off reaches anyone importing the archive without their
 * having to know `db.ts` exists. It is a printable sentence, not a comment, because it needs to
 * end up in command output and the README — see the note on the function itself, including why
 * it takes the caller's invocation prefix rather than importing `invokedAs()` upward.
 */
export { archiveDurabilityNote } from './db.ts';
import { ANSWERED_QUERY_SQL, applySchema } from './schema.ts';
import {
  agentDir,
  agentDirRelative,
  agentJsonPath,
  agentsDir,
  assertSafeSegment,
  campaignDbPath,
  campaignDir,
  campaignJsonPath,
  campaignsRoot,
  diffPath,
  ordersPath,
  agentArtifactRelative,
  reportJsonPath,
  reportMdPath,
  signalsJsonlPath,
  streamJsonlPath,
  tasksJsonlPath,
  CAMPAIGN_JSON_FILENAME,
} from './paths.ts';
import {
  DIFF_FILENAME,
  ORDERS_FILENAME,
  REPORT_JSON_FILENAME,
  REPORT_MD_FILENAME,
} from '../contracts/archive.ts';

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface ArchiveConfig {
  /** Absolute path of the war archive — `~/.agentic-army` in production. */
  archiveRoot: string;
  /** Swap the driver (`bun:sqlite`, `better-sqlite3`) without touching this file. */
  dbFactory?: DbFactory;
  /** Injectable clock. Returns ISO-8601. */
  now?: () => string;
}

function isoNow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export interface NewCampaign {
  /** Directory-safe and date-led. Derived from `title` + today when omitted. */
  id?: string;
  /** ABSOLUTE path of the project this campaign is fought in. */
  project: string;
  title: string;
  status?: CampaignStatus;
  createdAt?: string;
}

export interface NewTask {
  id?: string;
  parentTaskId?: string | null;
  title: string;
  status?: TaskStatus;
  /** Campaign-relative POSIX path. */
  ordersPath?: string | null;
}

export interface TaskPatch {
  title?: string;
  status?: TaskStatus;
  /** Explicit `null` clears the current attempt — which is a real state between retries. */
  agentId?: string | null;
  ordersPath?: string | null;
  branch?: string | null;
  deliveredRung?: Rung | null;
  prUrl?: string | null;
}

export interface NewAgentAttempt {
  /** Supervisor-minted — identity is spawner-owned, so this is required, never generated. */
  id: string;
  /** Null for an agent not bound to a task, e.g. a synthesist. */
  taskId?: string | null;
  parentAgentId?: string | null;
  rank: Rank;
  role: Role;
  harness: HarnessId;
  model?: string | null;
  effort?: string | null;
  sessionId: string;
  /** Structural spawn depth — NOT derived from rank. */
  depth?: number;
  status?: AgentStatus;
  worktreePath?: string | null;
  leaseId?: string | null;
  startedAt?: string;
  /** Written to `orders.md` and, when the agent has a task, recorded as the task's orders path. */
  orders?: string;
  /**
   * Override the attempt number. Normally computed as `tasks.attempts + 1` inside the same
   * transaction that increments it, which is what makes retries countable under concurrency.
   */
  attempt?: number;
}

/**
 * This campaign already has an agent under that id, so the attempt cannot be recorded.
 *
 * TYPED, and exported, for the same reason `campaign.ts` keys its diagnoses on typed errors and
 * typed note codes rather than on prose: the layer that owes the reader a `fix:` line has to be
 * able to RECOGNISE this condition, and recognising it by matching the words below would make
 * every rewording of them a silent regression. The message says what happened and what to do
 * because it is what the reader sees today; the class is what lets the answer improve.
 *
 * It names no command. `src/setup/**` sits above `src/archive/**` — the same layering that made
 * `archiveDurabilityNote` take the invocation as a parameter — so this file cannot resolve how
 * the reader invoked the tool, and a command it cannot spell correctly is a command it must not
 * spell at all.
 */
export class AgentIdInUseError extends Error {
  readonly agentId: string;
  readonly campaignId: string;
  /** When the attempt already holding the id started — the evidence that this is a re-run. */
  readonly startedAt: string;

  constructor(agentId: string, campaignId: string, startedAt: string) {
    super(
      `agent ${JSON.stringify(agentId)} is already recorded in campaign ` +
        `${JSON.stringify(campaignId)}, from an attempt that started ${startedAt}. Agent ids are ` +
        'minted from 01 on every run, so a run pointed at a campaign that already has agents ' +
        'collides on its first soldier and no retry of it can end differently. Nothing was ' +
        'written and the recorded attempt is untouched. Run this against a campaign id no ' +
        'campaign has used yet — omitting `--id` picks an unused one — and leave this campaign ' +
        'to be read.',
    );
    this.name = 'AgentIdInUseError';
    this.agentId = agentId;
    this.campaignId = campaignId;
    this.startedAt = startedAt;
  }
}

export interface AgentOutcome {
  status?: AgentStatus;
  endedAt?: string;
  exitCode?: number | null;
  /** Recorded verbatim from the harness's `result` event. Never estimated. */
  costUsd?: number | null;
  durationMs?: number | null;
  worktreePath?: string | null;
  leaseId?: string | null;
}

export interface NewSignal {
  fromAgent: string;
  toAgent?: string | null;
  /**
   * The symbolic half of addressing, and the honest description of it is short: `'chain'` is the
   * only value anything in this tree writes (`army campaign` opens with it). It is stored,
   * indexed and queryable, and that is where it stops — nothing expands a selector into a set of
   * recipients, so a selector is a LABEL on a row, never an address that reaches anybody.
   * `role:ENGINEER` and `owner:auth-schema` are the SHAPE the column is built for. See
   * `src/contracts/archive.ts` for what would trigger building the resolver.
   */
  toSelector?: string | null;
  kind: SignalKind;
  /** The `seq` of the `query` this answers. */
  inReplyTo?: number | null;
  /** Capped by the caller — anything large belongs in a file, pointed at by `artifact`. */
  body: string;
  artifact?: string | null;
  ts?: string;
}

export interface SignalFilter {
  kind?: SignalKind;
  fromAgent?: string;
  toAgent?: string;
  toSelector?: string;
  /** Exclusive — for the dashboard's incremental tail. */
  afterSeq?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------------------------

/** The campaign tree the UI renders. A node with `agents: []` is queued work. */
export interface TaskNode {
  task: TaskRow;
  /** Every attempt, oldest first. `task.agent_id` names the current one, and may be null. */
  agents: AgentRow[];
  children: TaskNode[];
}

export interface CampaignTree {
  campaign: CampaignRow;
  /** Root tasks — those with `parent_task_id: null`. */
  tasks: TaskNode[];
  /** Agents bound to no task (a synthesist, a campaign-level General). */
  agentsWithoutTask: AgentRow[];
}

/** One line of a `.jsonl` file that could not be parsed. Reported, never silently dropped. */
export interface DamagedLine {
  /** 1-based line number in the file. */
  line: number;
  /** Byte offset of the line's first byte, so a human can seek straight to it. */
  offset: number;
  bytes: number;
  reason: string;
}

/**
 * The result of replaying an agent's `stream.jsonl`.
 *
 * `damaged` is not optional and not a side channel: this file IS the post-hoc replay of a soldier
 * days later, and a replay that omits events without saying so is a worse failure
 * than one that reports the damage. Callers must hold the damage list to reach the events.
 */
export interface StreamReplay {
  events: SoldierEvent[];
  /** Empty on a healthy stream. Non-empty means the file lost lines — usually a crashed writer. */
  damaged: DamagedLine[];
}

/**
 * Every read the archive offers, and nothing that writes.
 *
 * `CampaignArchive` implements this, and `openCampaignReadOnly` returns it — so a read-only
 * consumer gets THE SAME METHODS, running the same SQL with the same ORDER BY clauses, rather
 * than hand-mirroring the orderings against the schema. Ordering is a real contract here
 * (`listTasks` is creation order with a `rowid` tiebreak, not alphabetical), and a second copy of
 * it in another module would drift the first time the tiebreak changed.
 *
 * The narrowing is the point: a consumer holding a `CampaignReader` cannot call `appendSignal`
 * because the type does not have it, not merely because the driver would throw. `db` is
 * deliberately absent too — exposing the handle would invite exactly the hand-written SQL this
 * interface exists to make unnecessary.
 */
export interface CampaignReader {
  readonly campaignId: string;
  /** Absolute path of `<archiveRoot>/campaigns/<campaign-id>`. */
  readonly root: string;

  getCampaign(): CampaignRow;

  getTask(id: string): TaskRow | undefined;
  /** Creation order — `created_at` then `rowid`. */
  listTasks(): TaskRow[];
  /** Pass `null` for the root level. Same ordering as `listTasks`. */
  childTasks(parentTaskId: string | null): TaskRow[];

  getAgent(id: string): AgentRow | undefined;
  /** Ordered by `started_at` then id. */
  listAgents(): AgentRow[];
  /** Every attempt at a task, oldest first. Empty for a queued task — not an error. */
  agentsForTask(taskId: string): AgentRow[];

  getSignal(seq: number): SignalRow | undefined;
  /** Ordered by `seq` — the total order of the signals bus. */
  listSignals(filter?: SignalFilter): SignalRow[];
  isAnswered(seq: number): boolean;
  answersTo(seq: number): SignalRow[];
  unansweredQueries(): SignalRow[];

  /** Ordered by `seq`. */
  listEvents(agentId?: string): EventRow[];
  readStream(agentId: string): StreamReplay;
  readReportJson(agentId: string): unknown;

  tree(): CampaignTree;
  ledger(): CampaignLedger;

  close(): void;
}

/**
 * Cost and wall-clock, summed from what harnesses actually reported. `agentsMissingCost` exists so
 * a total is never mistaken for a complete one — on a subscription the scarce resources are the
 * weekly limit and wall-clock, and a silently-zero line item hides both.
 */
export interface CampaignLedger {
  costUsd: number;
  durationMs: number;
  agents: number;
  agentsMissingCost: number;
  agentsMissingDuration: number;
}

// ---------------------------------------------------------------------------------------------
// Row mapping — sqlite hands back null-prototype objects; the archive returns plain ones
// ---------------------------------------------------------------------------------------------

type RawRow = Record<string, unknown>;

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`expected string, got ${typeof value}`);
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`expected number, got ${typeof value}`);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function toCampaignRow(raw: RawRow): CampaignRow {
  return {
    id: str(raw.id),
    project: str(raw.project),
    title: str(raw.title),
    status: str(raw.status) as CampaignStatus,
    created_at: str(raw.created_at),
    ended_at: nullableStr(raw.ended_at),
    root_dir: str(raw.root_dir),
  };
}

function toTaskRow(raw: RawRow): TaskRow {
  const rung = nullableNum(raw.delivered_rung);
  return {
    id: str(raw.id),
    campaign_id: str(raw.campaign_id),
    parent_task_id: nullableStr(raw.parent_task_id),
    title: str(raw.title),
    status: str(raw.status) as TaskStatus,
    agent_id: nullableStr(raw.agent_id),
    attempts: num(raw.attempts),
    orders_path: nullableStr(raw.orders_path),
    branch: nullableStr(raw.branch),
    delivered_rung: rung === null ? null : (rung as Rung),
    pr_url: nullableStr(raw.pr_url),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
  };
}

function toAgentRow(raw: RawRow): AgentRow {
  return {
    id: str(raw.id),
    campaign_id: str(raw.campaign_id),
    task_id: nullableStr(raw.task_id),
    parent_agent_id: nullableStr(raw.parent_agent_id),
    rank: str(raw.rank) as Rank,
    role: str(raw.role) as Role,
    harness: str(raw.harness) as HarnessId,
    model: nullableStr(raw.model),
    effort: nullableStr(raw.effort),
    session_id: str(raw.session_id),
    attempt: num(raw.attempt),
    depth: num(raw.depth),
    status: str(raw.status) as AgentStatus,
    worktree_path: nullableStr(raw.worktree_path),
    lease_id: nullableStr(raw.lease_id),
    dir: str(raw.dir),
    started_at: str(raw.started_at),
    ended_at: nullableStr(raw.ended_at),
    exit_code: nullableNum(raw.exit_code),
    cost_usd: nullableNum(raw.cost_usd),
    duration_ms: nullableNum(raw.duration_ms),
  };
}

function toSignalRow(raw: RawRow): SignalRow {
  return {
    seq: num(raw.seq),
    ts: str(raw.ts),
    from_agent: str(raw.from_agent),
    to_agent: nullableStr(raw.to_agent),
    to_selector: nullableStr(raw.to_selector),
    kind: str(raw.kind) as SignalKind,
    in_reply_to: nullableNum(raw.in_reply_to),
    body: str(raw.body),
    artifact: nullableStr(raw.artifact),
  };
}

function toEventRow(raw: RawRow): EventRow {
  return {
    seq: num(raw.seq),
    campaign_id: str(raw.campaign_id),
    agent_id: str(raw.agent_id),
    ts: str(raw.ts),
    type: str(raw.type) as SoldierEventType,
    offset: nullableNum(raw.offset),
    parent_tool_use_id: nullableStr(raw.parent_tool_use_id),
    depth: num(raw.depth),
    payload: str(raw.payload),
  };
}

// ---------------------------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------------------------

function writeFileAtomic(file: string, contents: string): void {
  // Temp-and-rename so a crash mid-write can never leave a half-written JSON object that rebuild
  // would then have to guess about. `fs.renameSync` maps to MoveFileEx(REPLACE_EXISTING) on
  // Windows, so overwriting an existing file is fine there too.
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, contents, 'utf8');
  fs.renameSync(temp, file);
}

/** Returns the byte offset the line was written at — `EventRow.offset`. */
function appendLine(file: string, jsonLine: string): number {
  const bytes = Buffer.from(`${jsonLine}\n`, 'utf8');
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {
    offset = 0;
  }
  // O_APPEND: the kernel places the write at the current end regardless of `offset`, so a racing
  // writer can never overwrite this line. `offset` is only ever stale if a writer bypassed the
  // transaction that serialises these calls.
  fs.appendFileSync(file, bytes);
  return offset;
}

/**
 * Parse a `.jsonl` file, REPORTING every line it could not use rather than dropping it silently.
 *
 * A torn final line is the expected shape of a crash, and refusing to open a campaign because of
 * one would be worse than useless. But a replay that quietly returns fewer events than the file
 * holds is worse still: the caller believes it has the whole story. So damage is data, and it
 * comes back with the events.
 */
function readJsonLines(file: string): { values: unknown[]; damaged: DamagedLine[] } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { values: [], damaged: [] };
    }
    throw error;
  }
  const values: unknown[] = [];
  const damaged: DamagedLine[] = [];
  const lines = text.split('\n');
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const byteLength = Buffer.byteLength(line, 'utf8');
    const lineStart = offset;
    offset += byteLength + 1; // + the LF that split() consumed
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch (error) {
      damaged.push({
        line: index + 1,
        offset: lineStart,
        bytes: byteLength,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { values, damaged };
}

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

function slug(text: string, max = 48): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s.length > 0 ? s : 'campaign';
}

/** `2026-08-02-take-hill-4` — directory-safe and date-led, per the contract's comment. */
export function campaignIdFor(title: string, when: Date = new Date()): string {
  const date = when.toISOString().slice(0, 10);
  return `${date}-${slug(title)}`;
}

function newTaskId(): string {
  return `t-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// ---------------------------------------------------------------------------------------------
// CampaignArchive
// ---------------------------------------------------------------------------------------------

export class CampaignArchive implements CampaignReader {
  readonly campaignId: string;
  /** Absolute path of `<archiveRoot>/campaigns/<campaign-id>`. */
  readonly root: string;
  readonly db: Db;
  /** False for a handle from `openCampaignReadOnly`. Every mutator checks it. */
  readonly writable: boolean;

  private readonly now: () => string;
  private readonly cache = new Map<string, DbStatement>();
  private closed = false;

  constructor(campaignId: string, root: string, db: Db, now: () => string, writable = true) {
    this.campaignId = campaignId;
    this.root = root;
    this.db = db;
    this.now = now;
    this.writable = writable;
  }

  // -- internals -----------------------------------------------------------------------------

  private stmt(sql: string): DbStatement {
    let s = this.cache.get(sql);
    if (s === undefined) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  /**
   * Guard every mutator on a read-only handle.
   *
   * SQLite already refuses the SQL, but three of the writers — `writeOrders`, `writeReportMd`,
   * `writeDiff` — touch only the filesystem and would sail straight past the driver. A read-only
   * archive that cannot write a row but can still overwrite `orders.md` would be a worse lie than
   * no read-only mode at all, so the check lives here rather than being delegated downwards.
   */
  private assertWritable(what: string): void {
    if (!this.writable) {
      throw new Error(
        `${what}: this campaign was opened read-only; ` +
          'use openCampaign() for a handle that may write',
      );
    }
  }

  // -- campaign ------------------------------------------------------------------------------

  getCampaign(): CampaignRow {
    const raw = this.stmt('SELECT * FROM campaigns WHERE id = ?').get<RawRow>([this.campaignId]);
    if (raw === undefined) throw new Error(`campaign ${this.campaignId} missing from its own index`);
    return toCampaignRow(raw);
  }

  setCampaignStatus(status: CampaignStatus, endedAt?: string | null): CampaignRow {
    this.assertWritable('setCampaignStatus');
    return this.db.transaction(() => {
      const ended =
        endedAt !== undefined
          ? endedAt
          : status === 'active'
            ? null
            : this.now();
      this.stmt('UPDATE campaigns SET status = ?, ended_at = ? WHERE id = ?').run([
        status,
        ended,
        this.campaignId,
      ]);
      const row = this.getCampaign();
      writeFileAtomic(campaignJsonPath(this.root), `${JSON.stringify(row, null, 2)}\n`);
      return row;
    });
  }

  // -- tasks ---------------------------------------------------------------------------------

  /**
   * Tasks nest. A task created with no agent and `status: 'queued'` is the normal case, not
   * a degenerate one — it is how unstarted work stays out of a commanding agent's context window.
   */
  createTask(input: NewTask): TaskRow {
    this.assertWritable('createTask');
    const id = input.id ?? newTaskId();
    const ts = this.now();
    return this.db.transaction(() => {
      if (input.parentTaskId != null && this.getTask(input.parentTaskId) === undefined) {
        throw new Error(`parent task ${input.parentTaskId} does not exist`);
      }
      this.stmt(
        `INSERT INTO tasks (id, campaign_id, parent_task_id, title, status, agent_id, attempts,
                            orders_path, branch, delivered_rung, pr_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, 0, ?, NULL, NULL, NULL, ?, ?)`,
      ).run([
        id,
        this.campaignId,
        input.parentTaskId ?? null,
        input.title,
        input.status ?? 'queued',
        input.ordersPath ?? null,
        ts,
        ts,
      ]);
      return this.persistTask(id);
    });
  }

  updateTask(id: string, patch: TaskPatch): TaskRow {
    this.assertWritable('updateTask');
    return this.db.transaction(() => {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      const push = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?`);
        params.push(value);
      };
      if (patch.title !== undefined) push('title', patch.title);
      if (patch.status !== undefined) push('status', patch.status);
      if (patch.agentId !== undefined) push('agent_id', patch.agentId);
      if (patch.ordersPath !== undefined) push('orders_path', patch.ordersPath);
      if (patch.branch !== undefined) push('branch', patch.branch);
      if (patch.deliveredRung !== undefined) push('delivered_rung', patch.deliveredRung);
      if (patch.prUrl !== undefined) push('pr_url', patch.prUrl);
      push('updated_at', this.now());
      params.push(id);
      const result = this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(params);
      if (result.changes === 0) throw new Error(`no such task ${id}`);
      return this.persistTask(id);
    });
  }

  /** Snapshot the row into `tasks.jsonl` (truth) and return it. Last line for an id wins. */
  private persistTask(id: string): TaskRow {
    const row = this.getTask(id);
    if (row === undefined) throw new Error(`no such task ${id}`);
    appendLine(tasksJsonlPath(this.root), JSON.stringify(row));
    return row;
  }

  getTask(id: string): TaskRow | undefined {
    const raw = this.stmt('SELECT * FROM tasks WHERE id = ?').get<RawRow>([id]);
    return raw === undefined ? undefined : toTaskRow(raw);
  }

  /**
   * Creation order. `rowid` is the tiebreak rather than `id`, because several tasks are routinely
   * created inside the same millisecond and task ids are opaque — ordering by id would shuffle a
   * plan into alphabetical nonsense. `rebuild.ts` replays `tasks.jsonl` in first-seen order, so
   * the rowids it assigns reproduce this same sequence.
   */
  listTasks(): TaskRow[] {
    return this.stmt('SELECT * FROM tasks WHERE campaign_id = ? ORDER BY created_at, rowid')
      .all<RawRow>([this.campaignId])
      .map(toTaskRow);
  }

  /** Pass `null` for the root level. */
  childTasks(parentTaskId: string | null): TaskRow[] {
    const sql =
      parentTaskId === null
        ? 'SELECT * FROM tasks WHERE campaign_id = ? AND parent_task_id IS NULL ORDER BY created_at, rowid'
        : 'SELECT * FROM tasks WHERE campaign_id = ? AND parent_task_id = ? ORDER BY created_at, rowid';
    const params = parentTaskId === null ? [this.campaignId] : [this.campaignId, parentTaskId];
    return this.stmt(sql).all<RawRow>(params).map(toTaskRow);
  }

  // -- agents --------------------------------------------------------------------------------

  /**
   * Record one ATTEMPT at a task. Creates `agents/<agent-id>/`, writes `orders.md` when given,
   * increments the task's attempt counter and points the task at this agent — all in one
   * transaction, so two supervisors retrying the same task cannot mint the same attempt number.
   */
  recordAgentAttempt(input: NewAgentAttempt): AgentRow {
    this.assertWritable('recordAgentAttempt');
    assertSafeSegment(input.id, 'agent id');
    this.assertIdUnused(input.id);
    this.assertNoCaseCollision(input.id);
    const startedAt = input.startedAt ?? this.now();
    const dirRel = agentDirRelative(input.id);
    const dirAbs = agentDir(this.root, input.id);

    return this.db.transaction(() => {
      const taskId = input.taskId ?? null;
      let attempt = input.attempt;
      if (taskId !== null) {
        const task = this.getTask(taskId);
        if (task === undefined) throw new Error(`no such task ${taskId}`);
        attempt = attempt ?? task.attempts + 1;
      }
      attempt = attempt ?? 1;

      fs.mkdirSync(dirAbs, { recursive: true });

      let ordersRel: string | null = null;
      if (input.orders !== undefined) {
        fs.writeFileSync(ordersPath(this.root, input.id), input.orders, 'utf8');
        ordersRel = agentArtifactRelative(input.id, ORDERS_FILENAME);
      }

      this.stmt(
        `INSERT INTO agents (id, campaign_id, task_id, parent_agent_id, rank, role, harness, model,
                             effort, session_id, attempt, depth, status, worktree_path, lease_id,
                             dir, started_at, ended_at, exit_code, cost_usd, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run([
        input.id,
        this.campaignId,
        taskId,
        input.parentAgentId ?? null,
        input.rank,
        input.role,
        input.harness,
        input.model ?? null,
        input.effort ?? null,
        input.sessionId,
        attempt,
        input.depth ?? 0,
        input.status ?? 'spawning',
        input.worktreePath ?? null,
        input.leaseId ?? null,
        dirRel,
        startedAt,
      ]);

      if (taskId !== null) {
        this.stmt(
          `UPDATE tasks SET agent_id = ?, attempts = ?, orders_path = COALESCE(?, orders_path),
                            updated_at = ? WHERE id = ?`,
        ).run([input.id, attempt, ordersRel, this.now(), taskId]);
        this.persistTask(taskId);
      }

      return this.persistAgent(input.id);
    });
  }

  /**
   * Close the books on an attempt. Cost and duration are written EXACTLY as supplied — the schema
   * carries these fields so a real number can be recorded, not so one can be guessed.
   */
  finishAgent(agentId: string, outcome: AgentOutcome): AgentRow {
    this.assertWritable('finishAgent');
    return this.db.transaction(() => {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      const push = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?`);
        params.push(value);
      };
      if (outcome.status !== undefined) push('status', outcome.status);
      if (outcome.exitCode !== undefined) push('exit_code', outcome.exitCode);
      if (outcome.costUsd !== undefined) push('cost_usd', outcome.costUsd);
      if (outcome.durationMs !== undefined) push('duration_ms', outcome.durationMs);
      if (outcome.worktreePath !== undefined) push('worktree_path', outcome.worktreePath);
      if (outcome.leaseId !== undefined) push('lease_id', outcome.leaseId);
      push('ended_at', outcome.endedAt ?? this.now());
      params.push(agentId);
      const result = this.db
        .prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`)
        .run(params);
      if (result.changes === 0) throw new Error(`no such agent ${agentId}`);
      return this.persistAgent(agentId);
    });
  }

  /** Mid-flight status/lease updates that are not the terminal outcome. */
  setAgentStatus(agentId: string, status: AgentStatus): AgentRow {
    this.assertWritable('setAgentStatus');
    return this.db.transaction(() => {
      const result = this.stmt('UPDATE agents SET status = ? WHERE id = ?').run([status, agentId]);
      if (result.changes === 0) throw new Error(`no such agent ${agentId}`);
      return this.persistAgent(agentId);
    });
  }

  /**
   * Ask, before writing anything, whether this run may mint `agentId` at all.
   *
   * THE ORDERING FIX. `recordAgentAttempt` refuses the duplicate, and refusing there is correct —
   * it is the write that would do the damage. But it is not the FIRST write of a run: by the time
   * a supervisor reaches its first soldier it has already opened a task and appended several
   * signals, and those files are append-only. A refused re-run therefore left a task row and four
   * status signals sitting in a campaign it did no work in, and a reader of that archive could not
   * tell them from the real run's. Measured on a two-attempt campaign: `tasks.jsonl` 7 → 9 lines,
   * `signals.jsonl` 9 → 13.
   *
   * The append-only guarantee is what forces the shape of the fix. Nothing may be rewritten and
   * nothing may be deleted, so the only place the extra rows can be prevented is BEFORE the first
   * one is written — which means the question has to be askable without attempting the write. That
   * is this method. `runCampaign` and `runChat` ask it the moment the archive is open and refuse
   * the whole run if the answer is no, so a refused re-run is byte-for-byte invisible in the
   * archive it was refused from.
   *
   * It is a pure read: it asks, it never inserts. `recordAgentAttempt` keeps both of its own
   * checks, because a caller that never asks must still not be able to overwrite an attempt.
   */
  assertAgentIdAvailable(agentId: string): void {
    this.assertIdUnused(agentId);
    this.assertNoCaseCollision(agentId);
  }

  /**
   * Refuse an agent id this campaign has already recorded, before SQLite does.
   *
   * The column is a primary key, so the duplicate was always rejected — as
   * `UNIQUE constraint failed: agents.id`, a sentence about a table the reader has never seen and
   * cannot act on. It reached them verbatim, because the layer above wraps an undiagnosed throw
   * in "no diagnosis, nothing to paste". The condition is not undiagnosable: agent ids are minted
   * from 01 on every run, so a run pointed at a campaign that already has agents collides on its
   * FIRST soldier, every time, with no sequence of retries that ends differently.
   *
   * Refused HERE and not one layer up in `createCampaign`, which stays idempotent on purpose:
   * re-opening a campaign to append signals, settle a lease or close out an attempt after a crash
   * is legitimate and must keep working. Only minting a duplicate agent id is the impossible
   * thing, so only that is refused — and refusing it with the reason and the way out is the
   * difference between a database error and something the reader can do.
   */
  private assertIdUnused(agentId: string): void {
    const existing = this.getAgent(agentId);
    if (existing === undefined) return;
    throw new AgentIdInUseError(agentId, this.campaignId, existing.started_at);
  }

  /**
   * Refuse an agent id that differs from an existing one only by case.
   *
   * `agents.id` is a case-SENSITIVE TEXT primary key, but `agents/<agent-id>/` is a directory on a
   * filesystem that on macOS and Windows is case-INSENSITIVE. So `cpt-03` and `CPT-03` would be
   * two rows sharing one directory: the second `agent.json` overwrites the first, and a rebuild
   * then recovers one agent and loses the other. Rejecting the collision at write time is the
   * only place the loss can still be prevented rather than merely reported.
   */
  private assertNoCaseCollision(agentId: string): void {
    const clash = this.stmt(
      'SELECT id FROM agents WHERE campaign_id = ? AND lower(id) = lower(?) AND id <> ?',
    ).get<{ id: string }>([this.campaignId, agentId, agentId]);
    if (clash !== undefined) {
      throw new Error(
        `agent id ${JSON.stringify(agentId)} collides case-insensitively with existing agent ` +
          `${JSON.stringify(clash.id)}; they would share one directory on macOS and Windows`,
      );
    }
  }

  private persistAgent(agentId: string): AgentRow {
    const row = this.getAgent(agentId);
    if (row === undefined) throw new Error(`no such agent ${agentId}`);
    fs.mkdirSync(agentDir(this.root, agentId), { recursive: true });
    writeFileAtomic(agentJsonPath(this.root, agentId), `${JSON.stringify(row, null, 2)}\n`);
    return row;
  }

  getAgent(id: string): AgentRow | undefined {
    const raw = this.stmt('SELECT * FROM agents WHERE id = ?').get<RawRow>([id]);
    return raw === undefined ? undefined : toAgentRow(raw);
  }

  listAgents(): AgentRow[] {
    return this.stmt('SELECT * FROM agents WHERE campaign_id = ? ORDER BY started_at, id')
      .all<RawRow>([this.campaignId])
      .map(toAgentRow);
  }

  /** Every attempt at a task, oldest first. Empty for a queued task — that is not an error. */
  agentsForTask(taskId: string): AgentRow[] {
    return this.stmt('SELECT * FROM agents WHERE task_id = ? ORDER BY attempt, started_at')
      .all<RawRow>([taskId])
      .map(toAgentRow);
  }

  // -- signals: APPEND ONLY --------------------------------------------------------------------

  /**
   * Append one row to the bus. There is no counterpart that mutates or removes one.
   *
   * Hand-written SQL is refused too — but by the combination of `schema.ts`'s triggers AND
   * `recursive_triggers=ON` from `db.ts`, not by the triggers alone: without that pragma SQLite
   * skips DELETE triggers on a REPLACE conflict, and `INSERT OR REPLACE INTO signals` would
   * rewrite a row with no error at all. `assertArchivePragmas` checks it on every open.
   */
  appendSignal(input: NewSignal): SignalRow {
    this.assertWritable('appendSignal');
    const ts = input.ts ?? this.now();
    return this.db.transaction(() => {
      const result = this.stmt(
        `INSERT INTO signals (ts, from_agent, to_agent, to_selector, kind, in_reply_to, body, artifact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run([
        ts,
        input.fromAgent,
        input.toAgent ?? null,
        input.toSelector ?? null,
        input.kind,
        input.inReplyTo ?? null,
        input.body,
        input.artifact ?? null,
      ]);
      const row: SignalRow = {
        seq: result.lastInsertRowid,
        ts,
        from_agent: input.fromAgent,
        to_agent: input.toAgent ?? null,
        to_selector: input.toSelector ?? null,
        kind: input.kind,
        in_reply_to: input.inReplyTo ?? null,
        body: input.body,
        artifact: input.artifact ?? null,
      };
      appendLine(signalsJsonlPath(this.root), JSON.stringify(row));
      return row;
    });
  }

  getSignal(seq: number): SignalRow | undefined {
    const raw = this.stmt('SELECT * FROM signals WHERE seq = ?').get<RawRow>([seq]);
    return raw === undefined ? undefined : toSignalRow(raw);
  }

  listSignals(filter: SignalFilter = {}): SignalRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.kind !== undefined) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.fromAgent !== undefined) {
      where.push('from_agent = ?');
      params.push(filter.fromAgent);
    }
    if (filter.toAgent !== undefined) {
      where.push('to_agent = ?');
      params.push(filter.toAgent);
    }
    if (filter.toSelector !== undefined) {
      where.push('to_selector = ?');
      params.push(filter.toSelector);
    }
    if (filter.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(filter.afterSeq);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const limit = filter.limit !== undefined ? ` LIMIT ${Math.trunc(filter.limit)}` : '';
    return this.db
      .prepare(`SELECT * FROM signals${clause} ORDER BY seq${limit}`)
      .all<RawRow>(params)
      .map(toSignalRow);
  }

  /**
   * THE answered-query computation. A query is answered iff an `answer` row exists with
   * `in_reply_to = seq`. No column, no mutation, no lost update.
   */
  isAnswered(seq: number): boolean {
    const row = this.stmt(ANSWERED_QUERY_SQL).get<{ answered: number }>([seq]);
    return (row?.answered ?? 0) === 1;
  }

  answersTo(seq: number): SignalRow[] {
    return this.stmt(
      "SELECT * FROM signals WHERE kind = 'answer' AND in_reply_to = ? ORDER BY seq",
    )
      .all<RawRow>([seq])
      .map(toSignalRow);
  }

  /** Queries with no answer row — computed, so it is correct the instant an answer lands. */
  unansweredQueries(): SignalRow[] {
    return this.stmt(
      `SELECT q.* FROM signals q
        WHERE q.kind = 'query'
          AND NOT EXISTS (
                SELECT 1 FROM signals a WHERE a.kind = 'answer' AND a.in_reply_to = q.seq
              )
        ORDER BY q.seq`,
    )
      .all<RawRow>()
      .map(toSignalRow);
  }

  // -- events / stream.jsonl -------------------------------------------------------------------

  /**
   * Append one `SoldierEvent` to `stream.jsonl` and index it.
   *
   * The JSONL line is the WHOLE normalised event including its `raw` field, which is what makes
   * the archive's second promise — post-hoc replay of any soldier, at any rank, days later —
   * actually hold. The database stores the same JSON in `payload`, so a row alone replays too,
   * but the file is what survives the index being deleted.
   */
  appendEvent(agentId: string, event: SoldierEvent): EventRow {
    return this.appendEvents(agentId, [event])[0] as EventRow;
  }

  appendEvents(agentId: string, events: readonly SoldierEvent[]): EventRow[] {
    this.assertWritable('appendEvents');
    if (events.length === 0) return [];
    const file = streamJsonlPath(this.root, agentId);
    return this.db.transaction(() => {
      if (this.getAgent(agentId) === undefined) throw new Error(`no such agent ${agentId}`);
      fs.mkdirSync(agentDir(this.root, agentId), { recursive: true });
      const out: EventRow[] = [];
      const insert = this.stmt(
        `INSERT INTO events (campaign_id, agent_id, ts, type, "offset", parent_tool_use_id, depth, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const event of events) {
        const payload = JSON.stringify(event);
        const offset = appendLine(file, payload);
        const result = insert.run([
          this.campaignId,
          agentId,
          event.ts,
          event.type,
          offset,
          event.parentToolUseId,
          event.depth,
          payload,
        ]);
        out.push({
          seq: result.lastInsertRowid,
          campaign_id: this.campaignId,
          agent_id: agentId,
          ts: event.ts,
          type: event.type,
          offset,
          parent_tool_use_id: event.parentToolUseId,
          depth: event.depth,
          payload,
        });
      }
      return out;
    });
  }

  /**
   * Replay from the FILE, not the index — this is the path that must work after a rebuild.
   *
   * Returns `{ events, damaged }` rather than a bare array so an unreadable line cannot pass for
   * an absent one. Check `damaged` before trusting the replay to be complete.
   *
   * THIS IS THE REPLAY READER, NOT A LIVE TAILER, and `army view` deliberately has its own
   * byte-offset tailer rather than calling this. That duplication is correct and should stay: a
   * replay reads a finished file, where an unparseable last line is damage to be reported. A
   * tailer reads a file being appended to right now, where the last line is usually just
   * INCOMPLETE — it must be held and re-read when the rest lands, never counted as damage and
   * never rendered. `readStream` collapses "torn" and "malformed" into `damaged` because after
   * the writer has exited the distinction no longer exists. Do not add tailing semantics here;
   * they would make the replay path wrong.
   */
  readStream(agentId: string): StreamReplay {
    const { values, damaged } = readJsonLines(streamJsonlPath(this.root, agentId));
    return { events: values as SoldierEvent[], damaged };
  }

  listEvents(agentId?: string): EventRow[] {
    const sql =
      agentId === undefined
        ? 'SELECT * FROM events WHERE campaign_id = ? ORDER BY seq'
        : 'SELECT * FROM events WHERE campaign_id = ? AND agent_id = ? ORDER BY seq';
    const params = agentId === undefined ? [this.campaignId] : [this.campaignId, agentId];
    return this.stmt(sql).all<RawRow>(params).map(toEventRow);
  }

  // -- the other files that are truth ----------------------------------------------------------

  /** All return the campaign-relative POSIX path, ready to be stored in a row or an `ArtifactRef`. */
  writeOrders(agentId: string, markdown: string): string {
    this.assertWritable('writeOrders');
    fs.mkdirSync(agentDir(this.root, agentId), { recursive: true });
    fs.writeFileSync(ordersPath(this.root, agentId), markdown, 'utf8');
    return agentArtifactRelative(agentId, ORDERS_FILENAME);
  }

  writeReportJson(agentId: string, report: Report): string {
    this.assertWritable('writeReportJson');
    fs.mkdirSync(agentDir(this.root, agentId), { recursive: true });
    writeFileAtomic(reportJsonPath(this.root, agentId), `${JSON.stringify(report, null, 2)}\n`);
    return agentArtifactRelative(agentId, REPORT_JSON_FILENAME);
  }

  readReportJson(agentId: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(reportJsonPath(this.root, agentId), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  writeReportMd(agentId: string, markdown: string): string {
    this.assertWritable('writeReportMd');
    fs.mkdirSync(agentDir(this.root, agentId), { recursive: true });
    fs.writeFileSync(reportMdPath(this.root, agentId), markdown, 'utf8');
    return agentArtifactRelative(agentId, REPORT_MD_FILENAME);
  }

  writeDiff(agentId: string, patch: string): string {
    this.assertWritable('writeDiff');
    fs.mkdirSync(agentDir(this.root, agentId), { recursive: true });
    fs.writeFileSync(diffPath(this.root, agentId), patch, 'utf8');
    return agentArtifactRelative(agentId, DIFF_FILENAME);
  }

  // -- read models -----------------------------------------------------------------------------

  /** The whole campaign, shaped for the read-only tree view in v1. */
  tree(): CampaignTree {
    const campaign = this.getCampaign();
    const tasks = this.listTasks();
    const agents = this.listAgents();

    const byTask = new Map<string, AgentRow[]>();
    const agentsWithoutTask: AgentRow[] = [];
    for (const agent of agents) {
      if (agent.task_id === null) {
        agentsWithoutTask.push(agent);
        continue;
      }
      const list = byTask.get(agent.task_id);
      if (list === undefined) byTask.set(agent.task_id, [agent]);
      else list.push(agent);
    }
    for (const list of byTask.values()) list.sort((a, b) => a.attempt - b.attempt);

    const nodes = new Map<string, TaskNode>();
    for (const task of tasks) {
      nodes.set(task.id, { task, agents: byTask.get(task.id) ?? [], children: [] });
    }
    const roots: TaskNode[] = [];
    for (const task of tasks) {
      const node = nodes.get(task.id) as TaskNode;
      const parent = task.parent_task_id === null ? undefined : nodes.get(task.parent_task_id);
      if (parent === undefined) roots.push(node);
      else parent.children.push(node);
    }
    return { campaign, tasks: roots, agentsWithoutTask };
  }

  /** Sum only what was reported. See `CampaignLedger`. */
  ledger(): CampaignLedger {
    const row = this.stmt(
      `SELECT COALESCE(SUM(cost_usd), 0)    AS cost,
              COALESCE(SUM(duration_ms), 0) AS duration,
              COUNT(*)                      AS agents,
              SUM(CASE WHEN cost_usd    IS NULL THEN 1 ELSE 0 END) AS missing_cost,
              SUM(CASE WHEN duration_ms IS NULL THEN 1 ELSE 0 END) AS missing_duration
         FROM agents WHERE campaign_id = ?`,
    ).get<RawRow>([this.campaignId]);
    return {
      costUsd: num(row?.cost ?? 0),
      durationMs: num(row?.duration ?? 0),
      agents: num(row?.agents ?? 0),
      agentsMissingCost: num(row?.missing_cost ?? 0),
      agentsMissingDuration: num(row?.missing_duration ?? 0),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.db.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Open / create
// ---------------------------------------------------------------------------------------------

function openIndex(campaignRoot: string, config: ArchiveConfig): Db {
  fs.mkdirSync(agentsDir(campaignRoot), { recursive: true });
  const factory = config.dbFactory ?? openDb;
  const db = factory(campaignDbPath(campaignRoot));
  // Before anything is written: a factory that dropped `recursive_triggers` would leave the
  // append-only bus rewritable, and nothing else in the system would notice.
  assertArchivePragmas(db);
  applySchema(db);
  return db;
}

/**
 * Reject a campaign id that differs from an existing one only by case — same reasoning as
 * `assertNoCaseCollision`, one level up: two campaigns would share one directory on macOS and
 * Windows, and the second would silently write its `campaign.json` over the first.
 */
function assertNoCampaignCaseCollision(archiveRoot: string, campaignId: string): void {
  const lower = campaignId.toLowerCase();
  for (const existing of listCampaignIds(archiveRoot)) {
    if (existing !== campaignId && existing.toLowerCase() === lower) {
      throw new Error(
        `campaign id ${JSON.stringify(campaignId)} collides case-insensitively with existing ` +
          `campaign ${JSON.stringify(existing)}; they would share one directory on macOS and Windows`,
      );
    }
  }
}

/**
 * Create a campaign directory and its index. Idempotent for an id that already exists: the
 * directory and schema are reused and the existing row returned, because `army` re-attaching to a
 * campaign after a crash must not be a destructive operation.
 */
export function createCampaign(config: ArchiveConfig, input: NewCampaign): CampaignArchive {
  const now = config.now ?? isoNow;
  const createdAt = input.createdAt ?? now();
  const id = assertSafeSegment(
    input.id ?? campaignIdFor(input.title, new Date(createdAt)),
    'campaign id',
  );
  assertNoCampaignCaseCollision(config.archiveRoot, id);
  const root = campaignDir(config.archiveRoot, id);
  fs.mkdirSync(agentsDir(root), { recursive: true });

  const db = openIndex(root, config);
  const archive = new CampaignArchive(id, root, db, now);

  db.transaction(() => {
    const existing = db.prepare('SELECT * FROM campaigns WHERE id = ?').get<RawRow>([id]);
    if (existing === undefined) {
      db.prepare(
        `INSERT INTO campaigns (id, project, title, status, created_at, ended_at, root_dir)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      ).run([id, input.project, input.title, input.status ?? 'active', createdAt, root]);
    }
    const row = archive.getCampaign();
    writeFileAtomic(campaignJsonPath(root), `${JSON.stringify(row, null, 2)}\n`);
  });

  return archive;
}

/** Attach to an existing campaign. Throws if there is no `campaigns` row for it. */
export function openCampaign(config: ArchiveConfig, campaignId: string): CampaignArchive {
  const root = campaignDir(config.archiveRoot, campaignId);
  if (!fs.existsSync(root)) throw new Error(`no such campaign directory: ${root}`);
  const db = openIndex(root, config);
  const archive = new CampaignArchive(campaignId, root, db, config.now ?? isoNow);
  archive.getCampaign();
  return archive;
}

/**
 * Attach to an existing campaign for READING ONLY. Returns a `CampaignReader`, so the writers are
 * not merely refused at runtime — they are not on the type.
 *
 * Read-only is enforced in three independent layers, because `army view` treats it as a safety
 * property rather than a hint: SQLite opens the file read-only and rejects every write itself;
 * `CampaignArchive.assertWritable` rejects the mutators before they run, which also covers
 * `writeOrders` / `writeReportMd` / `writeDiff` that touch only the filesystem and would
 * otherwise sail past the driver entirely; and the returned type omits them.
 *
 * Nothing in this path can create anything: no `mkdirSync`, no `applySchema`, no behavioural
 * probe — all three need writes, and a reader needs none of them. The four declarative pragma
 * checks still run; see `assertArchivePragmas` for exactly what read-only gives up and why it
 * costs nothing.
 *
 * ## KNOWN, BOUNDED EXCEPTION — a read-only open creates two files
 *
 * Opening a WAL database read-only MATERIALISES `campaign.db-shm` and `campaign.db-wal` if they
 * are not already present. SQLite needs the shared-memory index to read a WAL database at all,
 * and a read-only connection is not permitted to remove them on close, so they persist after the
 * handle is gone. Measured: `campaign.db-wal` is 0 bytes (no frames are ever appended) and
 * `campaign.db` is byte-identical before and after. No DATA is touched — but if you are reasoning
 * about the archive directory as immutable, or diffing it, or checksumming it, those two sidecar
 * files are the exception, and it is better known up front than discovered.
 */
export function openCampaignReadOnly(config: ArchiveConfig, campaignId: string): CampaignReader {
  const root = campaignDir(config.archiveRoot, campaignId);
  if (!fs.existsSync(root)) throw new Error(`no such campaign directory: ${root}`);
  const dbPath = campaignDbPath(root);
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `no campaign index at ${dbPath}; a read-only open cannot create one — ` +
        'run a rebuild first if the index was deleted',
    );
  }
  const factory = config.dbFactory ?? openDb;
  const db = factory(dbPath, { readOnly: true });
  assertArchivePragmas(db, 'readonly');
  const archive = new CampaignArchive(campaignId, root, db, config.now ?? isoNow, false);
  archive.getCampaign();
  return archive;
}

export function listCampaignIds(archiveRoot: string): string[] {
  const dir = campaignsRoot(archiveRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, CAMPAIGN_JSON_FILENAME)),
    )
    .map((entry) => entry.name)
    .sort();
}
