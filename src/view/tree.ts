/**
 * `army view` — rows in, renderable tree MODEL out.
 *
 * **This file is pure.** No filesystem, no clock, no `process.env`, no randomness. Everything it
 * needs arrives as an argument, including the current time. That is what makes the status ladder
 * testable at all — "is this unit busy?" is a question about a timestamp and a window, and a
 * function that reads `Date.now()` internally can only be tested by sleeping. It is also what
 * lets a future web dashboard reuse this exact model: `buildTree` is the only place that decides
 * what a campaign *means*, and it does not know a terminal exists.
 *
 * Three rules are load-bearing here and are implemented rather than commented:
 *
 * 1. **Rank and depth are separate columns, and the gap between them is diagnostic.**
 *    Rank is assigned by the spawner and must be strictly junior to it; it is never derived from
 *    depth. `rankDepthGap = depth - RANK_SENIORITY[rank]`. A ceremonial chain
 *    GEN(0)→COL(1)→CPT(2)→SGT(3)→PVT(4) gives a gap of 0 at every level. Skipping ranks — a
 *    General detaching a Captain directly for a two-file fix — gives a NEGATIVE gap, and is
 *    explicitly legal. A POSITIVE gap is not: it means the chain has more nesting levels than it
 *    consumed ranks, which can only happen if some spawn failed to go strictly junior. So
 *    `gap > 0` is flagged and `gap <= 0` is not, and the reader never has to compute it.
 *
 * 2. **Tasks and agents are different things.** A task with `agent_id: null` and
 *    `status: 'queued'` is real work no process has ever touched, and it must be VISIBLE — that
 *    is the entire reason the table exists. One task may have several attempts by different
 *    agents; every attempt gets its own row. Nothing here collapses a task into "its current
 *    agent", because doing so is exactly how unstarted work and failed retries disappear.
 *
 * 3. **Status is computed from the event stream, never stored.** `AgentRow.status` is a
 *    hint written by a supervisor that may itself have crashed; `stream.jsonl` is the log. The
 *    row is trusted only for TERMINAL facts it alone can know (the process exited, with what
 *    code); liveness is derived from events. Every verdict carries the `source` that produced it,
 *    and `unknown` is a first-class answer — a view that renders a confident `idle` for a unit it
 *    has no evidence about is worse than one that admits it does not know.
 */

import type {
  AgentRow,
  AgentStatus,
  CampaignRow,
  SignalRow,
  TaskRow,
  TaskStatus,
} from '../contracts/archive.ts';
import type { Rung } from '../contracts/delivery.ts';
import type { SoldierEvent, SoldierEventType, SoldierStatus } from '../contracts/harness.ts';
import type { Rank, Role } from '../contracts/ranks.ts';

import { RANK_SENIORITY, formatUnit } from '../contracts/ranks.ts';

// ---------------------------------------------------------------------------------------------
// Semantic unit state — firstmate's busy/idle distinction, plus an honest "don't know"
// ---------------------------------------------------------------------------------------------

/**
 * `unknown` is deliberately in this list and is deliberately not last-resort-equals-idle. Most of
 * the ways a campaign goes wrong (supervisor died, stream never opened, host slept) present as an
 * absence of evidence, and rendering that absence as `idle` turns the single most actionable
 * signal in the view into the most boring one.
 */
export const UNIT_STATES = ['busy', 'idle', 'unknown', 'dead'] as const;
export type UnitState = (typeof UNIT_STATES)[number];

/**
 * Every value `StateVerdict.source` can take, exhaustively.
 *
 * A closed union rather than a free string because the source is the audit trail for the verdict:
 * it has to be assertable in a test and greppable in a log, and "carry the source of that
 * determination rather than guessing silently" is not satisfied by a prose sentence that drifts.
 *
 * `agent-row:*` — the index knew something the stream cannot: the process is gone.
 * `stream:*`    — computed from the append-only event log.
 */
export const STATE_SOURCES = [
  'agent-row:failed',
  'agent-row:interrupted',
  'agent-row:exited',
  'agent-row:ended-at',
  'agent-row:spawning',
  'stream:error',
  'stream:missing',
  'stream:empty',
  'stream:bad-timestamp',
  'stream:stale',
  'stream:open-tool',
  'stream:recent-activity',
  'stream:turn-complete',
  'stream:quiet',
] as const;
export type StateSource = (typeof STATE_SOURCES)[number];

export interface StateVerdict {
  state: UnitState;
  /** WHICH rule fired. Shown in the view; asserted in tests. */
  source: StateSource;
  /** One short human-readable clause justifying the state, e.g. `Bash open`, `exit 1`. */
  detail: string;
  /** ISO-8601 timestamp the verdict is anchored to — the last evidence. Null when there is none. */
  since: string | null;
  /** Milliseconds between `since` and the injected clock. Null when `since` is null. */
  ageMs: number | null;
}

// ---------------------------------------------------------------------------------------------
// Stream digest — the distillation of stream.jsonl that the status ladder actually consumes
// ---------------------------------------------------------------------------------------------

export interface OpenTool {
  name: string;
  toolUseId: string;
  ts: string;
}

/**
 * What a whole `stream.jsonl` reduces to.
 *
 * It exists so that the model layer never has to hold every event of every agent in memory, and
 * so follow mode can fold new lines into an existing digest instead of re-reading from byte zero
 * on every poll. `digestStream` is pure and total: it is the same function for the live tail and
 * for a replay days later, which is the property that keeps those two code paths honest.
 */
export interface StreamDigest {
  agentId: string;
  /** Well-formed events folded in. */
  events: number;
  firstTs: string | null;
  lastTs: string | null;
  lastType: SoldierEventType | null;
  /** `tool_use` with no matching `tool_result`, oldest first. Non-empty means work in flight. */
  openTools: OpenTool[];
  /** Last assistant/subagent text, first line only — "what is it doing right now". */
  lastText: string | null;
  lastError: string | null;
  lastResultStatus: SoldierStatus | null;
  /** A `system/init` was seen, so the harness really came up. */
  ready: boolean;
  /** Deepest native-subagent nesting observed BELOW this process. 0 = no subagents. */
  maxDepth: number;
  /** Distinct `parent_tool_use_id` values at depth >= 1 — the native-subagent fan-out. */
  subagents: number;
  /** Lines that were present but unparseable. Counted, never rendered as a row. */
  malformed: number;
  /** The final line was half-written when we looked. Expected on a live tail; never fatal. */
  truncatedTail: boolean;
}

export function emptyDigest(agentId: string): StreamDigest {
  return {
    agentId,
    events: 0,
    firstTs: null,
    lastTs: null,
    lastType: null,
    openTools: [],
    lastText: null,
    lastError: null,
    lastResultStatus: null,
    ready: false,
    maxDepth: 0,
    subagents: 0,
    malformed: 0,
    truncatedTail: false,
  };
}

/** How much of a text event survives into the digest. Enough to read, not enough to wrap. */
const NOTE_MAX = 120;

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  const trimmed = line.trim();
  return trimmed.length > NOTE_MAX ? `${trimmed.slice(0, NOTE_MAX - 1)}…` : trimmed;
}

export interface DigestFlags {
  /** Lines the reader could not parse. */
  malformed?: number;
  /** The reader is holding a partial final line. */
  truncatedTail?: boolean;
  /** Fold into an existing digest — follow mode's incremental path. */
  base?: StreamDigest;
}

/**
 * Fold a batch of normalised events into a digest. Pure; incremental via `flags.base`.
 *
 * Open tool tracking is the interesting part: a `tool_use` whose `tool_result` has not arrived is
 * the single most reliable "this unit is working right now" signal a pipe-only harness gives us,
 * and it is strictly better than "an event happened recently" because a long `Bash` call can be
 * silent for minutes while genuinely running.
 */
export function digestStream(
  agentId: string,
  events: readonly SoldierEvent[],
  flags: DigestFlags = {},
): StreamDigest {
  const base = flags.base;
  const digest: StreamDigest =
    base === undefined
      ? emptyDigest(agentId)
      : { ...base, agentId, openTools: base.openTools.slice() };

  const open = new Map<string, OpenTool>();
  for (const tool of digest.openTools) open.set(tool.toolUseId, tool);
  const subagentParents = new Set<string>();

  for (const event of events) {
    // A row that does not even carry a `type` is not an event; it is a line that happened to be
    // JSON. Skip it rather than letting `undefined` propagate into the status ladder. The cast is
    // deliberate: this function is fed lines off disk, so the static type is a claim, not a fact.
    const kind = (event as { type?: unknown } | null | undefined)?.type;
    if (typeof kind !== 'string') {
      digest.malformed += 1;
      continue;
    }
    digest.events += 1;
    const ts = typeof event.ts === 'string' ? event.ts : null;
    if (ts !== null) {
      if (digest.firstTs === null) digest.firstTs = ts;
      digest.lastTs = ts;
    }
    digest.lastType = event.type;

    const depth = typeof event.depth === 'number' && Number.isFinite(event.depth) ? event.depth : 0;
    if (depth > digest.maxDepth) digest.maxDepth = depth;
    if (depth >= 1 && typeof event.parentToolUseId === 'string') {
      subagentParents.add(event.parentToolUseId);
    }

    switch (event.type) {
      case 'ready':
        digest.ready = true;
        break;
      case 'assistant_text':
      case 'subagent_text':
        if (typeof event.text === 'string' && event.text.trim().length > 0) {
          digest.lastText = firstLine(event.text);
        }
        break;
      case 'tool_use':
        if (typeof event.toolUseId === 'string') {
          open.set(event.toolUseId, {
            name: typeof event.name === 'string' ? event.name : 'tool',
            toolUseId: event.toolUseId,
            ts: ts ?? '',
          });
        }
        break;
      case 'tool_result':
        if (typeof event.toolUseId === 'string') open.delete(event.toolUseId);
        break;
      case 'result':
        digest.lastResultStatus = event.status;
        // A `result` ends a TURN, not the process (duplex). Any tool still open at that point
        // was reconciled by the harness, so the set is cleared rather than carried into the next
        // turn where it would read as permanent phantom work.
        open.clear();
        break;
      case 'error':
        digest.lastError = typeof event.message === 'string' ? firstLine(event.message) : 'error';
        break;
      default:
        break;
    }
  }

  digest.openTools = [...open.values()];
  digest.subagents = Math.max(digest.subagents, subagentParents.size);
  if (flags.malformed !== undefined) digest.malformed += flags.malformed;
  if (flags.truncatedTail !== undefined) digest.truncatedTail = flags.truncatedTail;
  return digest;
}

// ---------------------------------------------------------------------------------------------
// The status ladder
// ---------------------------------------------------------------------------------------------

/** An event this recent is proof of work. */
export const DEFAULT_BUSY_WITHIN_MS = 30_000;
/**
 * Silence longer than this is not proof of anything. Ten minutes rather than one because a single
 * `Bash` running a test suite legitimately emits nothing for a long time, and calling that `dead`
 * would be exactly the confident-looking lie this module refuses to tell.
 */
export const DEFAULT_STALE_AFTER_MS = 600_000;

export interface StateOptions {
  busyWithinMs?: number;
  staleAfterMs?: number;
}

function parseTs(ts: string | null | undefined): number | null {
  if (typeof ts !== 'string' || ts.length === 0) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function verdict(
  state: UnitState,
  source: StateSource,
  detail: string,
  since: string | null,
  ageMs: number | null,
): StateVerdict {
  return { state, source, detail, since, ageMs };
}

/**
 * Compute one unit's state. The ladder is ordered, first match wins, and every rung names itself.
 *
 * The ordering encodes one judgement worth stating out loud: the ROW wins for terminal facts and
 * the STREAM wins for everything else. A supervisor that recorded `exited` observed a real process
 * exit and no amount of stream evidence outranks that; but a row still saying `running` proves
 * only that nobody has written to it since, which is precisely what happens when the supervisor
 * is the thing that died. So `running` is never itself evidence of anything.
 */
export function computeUnitState(
  agent: AgentRow,
  digest: StreamDigest | undefined,
  nowMs: number,
  options: StateOptions = {},
): StateVerdict {
  const busyWithinMs = options.busyWithinMs ?? DEFAULT_BUSY_WITHIN_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  const endedMs = parseTs(agent.ended_at);
  const endedAge = endedMs === null ? null : nowMs - endedMs;

  // -- 1. terminal facts, which only the index can know -----------------------------------------
  if (agent.status === 'failed') {
    return verdict('dead', 'agent-row:failed', exitDetail(agent, 'failed'), agent.ended_at, endedAge);
  }
  if (agent.status === 'interrupted') {
    return verdict(
      'dead',
      'agent-row:interrupted',
      exitDetail(agent, 'interrupted'),
      agent.ended_at,
      endedAge,
    );
  }
  if (agent.status === 'exited') {
    return verdict('dead', 'agent-row:exited', exitDetail(agent, 'exited'), agent.ended_at, endedAge);
  }
  if (agent.ended_at !== null) {
    // The row was never moved off `running`/`idle`, but an end time was recorded. The end time is
    // the observation; the status is the bookkeeping that did not finish.
    return verdict('dead', 'agent-row:ended-at', exitDetail(agent, 'ended'), agent.ended_at, endedAge);
  }

  // -- 2. no log to compute from -----------------------------------------------------------------
  if (digest === undefined) {
    return verdict('unknown', 'stream:missing', 'no stream.jsonl', agent.started_at, ageOf(agent.started_at, nowMs));
  }
  if (digest.events === 0) {
    const source: StateSource = agent.status === 'spawning' ? 'agent-row:spawning' : 'stream:empty';
    const detail = agent.status === 'spawning' ? 'spawning, no events yet' : 'stream is empty';
    return verdict('unknown', source, detail, agent.started_at, ageOf(agent.started_at, nowMs));
  }

  const lastMs = parseTs(digest.lastTs);
  if (lastMs === null) {
    return verdict('unknown', 'stream:bad-timestamp', 'last event has no usable ts', null, null);
  }
  const age = nowMs - lastMs;

  // -- 3. the log says it broke ------------------------------------------------------------------
  if (digest.lastType === 'error') {
    return verdict('dead', 'stream:error', digest.lastError ?? 'error', digest.lastTs, age);
  }

  // -- 4. the log has gone quiet for long enough that nothing can be claimed ----------------------
  if (age > staleAfterMs) {
    const openNote = digest.openTools.length > 0 ? `${lastToolName(digest)} open, ` : '';
    return verdict('unknown', 'stream:stale', `${openNote}no events`, digest.lastTs, age);
  }

  // -- 5. positive evidence of work --------------------------------------------------------------
  if (digest.openTools.length > 0) {
    return verdict('busy', 'stream:open-tool', `${lastToolName(digest)} open`, digest.lastTs, age);
  }
  if (digest.lastType === 'result') {
    const status = digest.lastResultStatus ?? 'ok';
    return verdict('idle', 'stream:turn-complete', `turn ${status}`, digest.lastTs, age);
  }
  if (age <= busyWithinMs) {
    return verdict('busy', 'stream:recent-activity', digest.lastType ?? 'event', digest.lastTs, age);
  }
  return verdict('idle', 'stream:quiet', 'no work in flight', digest.lastTs, age);
}

function lastToolName(digest: StreamDigest): string {
  const tool = digest.openTools[digest.openTools.length - 1];
  return tool === undefined ? 'tool' : tool.name;
}

function ageOf(ts: string | null, nowMs: number): number | null {
  const ms = parseTs(ts);
  return ms === null ? null : nowMs - ms;
}

function exitDetail(agent: AgentRow, word: string): string {
  if (agent.exit_code !== null) return `${word}, exit ${agent.exit_code}`;
  return word;
}

// ---------------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------------

/** Everything `buildTree` needs. Rows exactly as the archive returns them; no IO happens here. */
export interface CampaignSnapshot {
  campaign: CampaignRow;
  tasks: readonly TaskRow[];
  agents: readonly AgentRow[];
  signals?: readonly SignalRow[];
  /** agentId -> digest. An agent absent from this map has no readable stream. */
  streams?: Readonly<Record<string, StreamDigest>>;
  /** Where the rows came from — shown in the footer so a reader knows what they are looking at. */
  source?: 'files' | 'db';
}

export interface UnitNode {
  kind: 'unit';
  agentId: string;
  rank: Rank;
  role: Role;
  taskId: string | null;
  attempt: number;
  /** Structural spawn depth, straight off the row. NEVER derived from rank. */
  depth: number;
  /** `RANK_SENIORITY[rank]`: GENERAL 0 … PRIVATE 4. Presentation only; never persisted. */
  rankSeniority: number;
  /** `depth - rankSeniority`. <= 0 is normal, > 0 means the chain outran its ranks. */
  rankDepthGap: number;
  /** True iff `rankDepthGap > 0`. Rendered as a marker so the reader never has to subtract. */
  gapAnomalous: boolean;
  /** `CPT·ENGINEER · take-hill-4` — `formatUnit` from contracts. */
  label: string;
  /** The same without the task id, for rows already nested under their task. */
  labelShort: string;
  /**
   * Whether the attempt number is worth showing. False for the only attempt at a task: `#1` on a
   * task nobody has retried is noise, and the column budget it costs is better spent on the id.
   * True the moment a task has been attempted more than once — which is exactly when the
   * "one task, several agents" distinction starts mattering.
   */
  showAttempt: boolean;
  harness: string;
  model: string | null;
  effort: string | null;
  /** The index's opinion. Kept so a reader can see where it disagrees with the computed state. */
  rowStatus: AgentStatus;
  state: StateVerdict;
  /** Native-subagent nesting seen in this unit's own stream. 0 when it spawned none. */
  streamDepth: number;
  subagents: number;
  /** Last thing it said, first line. Null when it has not spoken. */
  note: string | null;
  worktreePath: string | null;
  costUsd: number | null;
  startedAt: string;
  endedAt: string | null;
  truncatedTail: boolean;
  /** Native subagents / synthesists recorded as their own rows under this one. */
  children: UnitNode[];
}

export interface TaskNodeView {
  kind: 'task';
  taskId: string;
  title: string;
  status: TaskStatus;
  /** The CURRENT attempt, or null — queued, or between retries. Both are real states. */
  currentAgentId: string | null;
  /** `TaskRow.attempts`. May exceed `units.length` if an attempt's row was lost. */
  attempts: number;
  /** True iff no agent has ever attempted this task. Rendered explicitly, never elided. */
  neverAttempted: boolean;
  branch: string | null;
  prUrl: string | null;
  deliveredRung: Rung | null;
  updatedAt: string;
  ageMs: number | null;
  /** Every attempt, oldest first. Empty is normal and is the point of the task table. */
  units: UnitNode[];
  children: TaskNodeView[];
}

export type TreeNode = TaskNodeView | UnitNode;

export interface Anomaly {
  kind:
    | 'rank-depth-gap'
    | 'torn-stream'
    | 'missing-current-agent'
    | 'orphan-task-parent'
    | 'orphan-agent-parent';
  /** Task id or agent id. */
  subject: string;
  message: string;
}

export interface TreeSummary {
  tasks: number;
  queuedTasks: number;
  units: number;
  byState: Record<UnitState, number>;
  /** Ranks actually in play, most senior first. */
  ranks: Rank[];
  depthMin: number;
  depthMax: number;
  /** Deepest level including native subagents seen only in a stream. */
  depthMaxObserved: number;
  /** Signals of kind `query` with no `answer` row — COMPUTED, never stored. */
  openQueries: number;
  anomalies: Anomaly[];
}

export interface TreeModel {
  /** Schema version of this JSON. Bumped when the shape changes; `--json` consumers pin on it. */
  v: 1;
  /** ISO-8601 from the INJECTED clock, so `--json` output is reproducible in a test. */
  generatedAt: string;
  source: 'files' | 'db';
  campaign: {
    id: string;
    title: string;
    project: string;
    status: string;
    createdAt: string;
    endedAt: string | null;
    rootDir: string;
  };
  /** Units bound to no task — a campaign-level General, a synthesist. Rendered first. */
  unattached: UnitNode[];
  /** Root tasks, creation order. */
  tasks: TaskNodeView[];
  summary: TreeSummary;
}

export interface BuildTreeOptions extends StateOptions {
  /** The clock. Injected, never read from the environment — see the file header. */
  now: Date | string | number;
}

function toMs(now: Date | string | number): number {
  if (typeof now === 'number') return now;
  if (typeof now === 'string') {
    const parsed = Date.parse(now);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return now.getTime();
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Fold a snapshot into the model the renderer draws and `--json` emits.
 *
 * Shape of the tree: **tasks are the spine.** Attempts hang off their task, oldest first; a task
 * with no attempts still gets a row. An agent nests under another agent only when it is genuinely
 * inside that attempt — same task, or no task of its own — which is what puts the native-subagent
 * layer in the right place without letting a Captain's `parent_agent_id` yank it out from
 * under the task it is actually working on.
 */
export function buildTree(snapshot: CampaignSnapshot, options: BuildTreeOptions): TreeModel {
  const nowMs = toMs(options.now);
  const streams = snapshot.streams ?? {};
  const anomalies: Anomaly[] = [];

  const agentsById = new Map<string, AgentRow>();
  for (const agent of snapshot.agents) agentsById.set(agent.id, agent);

  const nodesById = new Map<string, UnitNode>();
  for (const agent of snapshot.agents) {
    const digest = streams[agent.id];
    const state = computeUnitState(agent, digest, nowMs, options);
    const seniority = RANK_SENIORITY[agent.rank];
    const gap = agent.depth - seniority;
    const node: UnitNode = {
      kind: 'unit',
      agentId: agent.id,
      rank: agent.rank,
      role: agent.role,
      taskId: agent.task_id,
      attempt: agent.attempt,
      depth: agent.depth,
      rankSeniority: seniority,
      rankDepthGap: gap,
      gapAnomalous: gap > 0,
      label: formatUnit(agent.rank, agent.role, agent.task_id ?? undefined),
      labelShort: formatUnit(agent.rank, agent.role),
      showAttempt: agent.attempt > 1,
      harness: agent.harness,
      model: agent.model,
      effort: agent.effort,
      rowStatus: agent.status,
      state,
      streamDepth: digest?.maxDepth ?? 0,
      subagents: digest?.subagents ?? 0,
      note: digest?.lastText ?? null,
      worktreePath: agent.worktree_path,
      costUsd: agent.cost_usd,
      startedAt: agent.started_at,
      endedAt: agent.ended_at,
      truncatedTail: digest?.truncatedTail ?? false,
      children: [],
    };
    nodesById.set(agent.id, node);
    if (node.gapAnomalous) {
      anomalies.push({
        kind: 'rank-depth-gap',
        subject: agent.id,
        message: `${agent.rank} at depth ${agent.depth} (+${gap}) — deeper than its rank allows`,
      });
    }
    if (node.truncatedTail) {
      anomalies.push({
        kind: 'torn-stream',
        subject: agent.id,
        message: 'stream.jsonl ends with a partially written record',
      });
    }
  }

  // -- attach units to their parent unit, where that is genuinely nesting and not the org chart --
  const rootUnits: UnitNode[] = [];
  for (const agent of snapshot.agents) {
    const node = nodesById.get(agent.id) as UnitNode;
    const parentId = agent.parent_agent_id;
    if (parentId === null) {
      rootUnits.push(node);
      continue;
    }
    const parent = agentsById.get(parentId);
    if (parent === undefined) {
      anomalies.push({
        kind: 'orphan-agent-parent',
        subject: agent.id,
        message: `parent_agent_id ${parentId} is not in this campaign`,
      });
      rootUnits.push(node);
      continue;
    }
    // Same task (or no task of its own) means it lives INSIDE that attempt. A different task means
    // it is a detachment, and the task spine owns it.
    if (agent.task_id === null || agent.task_id === parent.task_id) {
      (nodesById.get(parentId) as UnitNode).children.push(node);
    } else {
      rootUnits.push(node);
    }
  }
  for (const node of nodesById.values()) {
    node.children.sort((a, b) => a.attempt - b.attempt || cmp(a.agentId, b.agentId));
  }

  // -- tasks ------------------------------------------------------------------------------------
  const unitsByTask = new Map<string, UnitNode[]>();
  const unattached: UnitNode[] = [];
  for (const node of rootUnits) {
    if (node.taskId === null) {
      unattached.push(node);
      continue;
    }
    const list = unitsByTask.get(node.taskId);
    if (list === undefined) unitsByTask.set(node.taskId, [node]);
    else list.push(node);
  }
  for (const list of unitsByTask.values()) {
    list.sort((a, b) => a.attempt - b.attempt || cmp(a.agentId, b.agentId));
    if (list.length > 1) for (const node of list) node.showAttempt = true;
  }
  unattached.sort((a, b) => a.rankSeniority - b.rankSeniority || cmp(a.agentId, b.agentId));

  const taskNodes = new Map<string, TaskNodeView>();
  for (const task of snapshot.tasks) {
    const units = unitsByTask.get(task.id) ?? [];
    const updatedMs = parseTs(task.updated_at);
    taskNodes.set(task.id, {
      kind: 'task',
      taskId: task.id,
      title: task.title,
      status: task.status,
      currentAgentId: task.agent_id,
      attempts: task.attempts,
      neverAttempted: task.attempts === 0 && units.length === 0,
      branch: task.branch,
      prUrl: task.pr_url,
      deliveredRung: task.delivered_rung,
      updatedAt: task.updated_at,
      ageMs: updatedMs === null ? null : nowMs - updatedMs,
      units,
      children: [],
    });
    if (task.agent_id !== null && !agentsById.has(task.agent_id)) {
      anomalies.push({
        kind: 'missing-current-agent',
        subject: task.id,
        message: `current attempt ${task.agent_id} has no agent row`,
      });
    }
  }

  const rootTasks: TaskNodeView[] = [];
  for (const task of snapshot.tasks) {
    const node = taskNodes.get(task.id) as TaskNodeView;
    if (task.parent_task_id === null) {
      rootTasks.push(node);
      continue;
    }
    const parent = taskNodes.get(task.parent_task_id);
    if (parent === undefined) {
      anomalies.push({
        kind: 'orphan-task-parent',
        subject: task.id,
        message: `parent_task_id ${task.parent_task_id} is not in this campaign`,
      });
      rootTasks.push(node);
      continue;
    }
    parent.children.push(node);
  }

  // -- summary ----------------------------------------------------------------------------------
  const byState: Record<UnitState, number> = { busy: 0, idle: 0, unknown: 0, dead: 0 };
  const ranksSeen = new Set<Rank>();
  let depthMin = Number.POSITIVE_INFINITY;
  let depthMax = 0;
  let depthMaxObserved = 0;
  for (const node of nodesById.values()) {
    byState[node.state.state] += 1;
    ranksSeen.add(node.rank);
    if (node.depth < depthMin) depthMin = node.depth;
    if (node.depth > depthMax) depthMax = node.depth;
    const observed = node.depth + node.streamDepth;
    if (observed > depthMaxObserved) depthMaxObserved = observed;
  }
  if (!Number.isFinite(depthMin)) depthMin = 0;

  const ranks = [...ranksSeen].sort((a, b) => RANK_SENIORITY[a] - RANK_SENIORITY[b]);

  let queuedTasks = 0;
  for (const task of snapshot.tasks) if (task.status === 'queued') queuedTasks += 1;

  return {
    v: 1,
    generatedAt: toIso(nowMs),
    source: snapshot.source ?? 'files',
    campaign: {
      id: snapshot.campaign.id,
      title: snapshot.campaign.title,
      project: snapshot.campaign.project,
      status: snapshot.campaign.status,
      createdAt: snapshot.campaign.created_at,
      endedAt: snapshot.campaign.ended_at,
      rootDir: snapshot.campaign.root_dir,
    },
    unattached,
    tasks: rootTasks,
    summary: {
      tasks: snapshot.tasks.length,
      queuedTasks,
      units: nodesById.size,
      byState,
      ranks,
      depthMin,
      depthMax,
      depthMaxObserved,
      openQueries: countOpenQueries(snapshot.signals ?? []),
      anomalies,
    },
  };
}

/**
 * A query is answered iff an `answer` row exists with `in_reply_to = seq`. There is
 * no state column, so this is a computation and not a lookup — the same rule the archive applies
 * in SQL, applied here to the rows we already hold so the file-backed path needs no database.
 */
function countOpenQueries(signals: readonly SignalRow[]): number {
  const answered = new Set<number>();
  for (const signal of signals) {
    if (signal.kind === 'answer' && signal.in_reply_to !== null) answered.add(signal.in_reply_to);
  }
  let open = 0;
  for (const signal of signals) {
    if (signal.kind === 'query' && !answered.has(signal.seq)) open += 1;
  }
  return open;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Walking — shared by the renderer and by anything else that wants rows
// ---------------------------------------------------------------------------------------------

export interface WalkedRow {
  node: TreeNode;
  /**
   * One flag per ancestor level, true when that ancestor was the last of its siblings. Everything
   * a tree-drawing routine needs, with no glyphs baked in — the charset is the renderer's problem.
   */
  lastFlags: boolean[];
  /** True when this unit is drawn directly beneath the task it belongs to. */
  underOwnTask: boolean;
}

/** Depth-first, in render order: unattached units, then root tasks. Pure. */
export function walkTree(model: TreeModel): WalkedRow[] {
  const rows: WalkedRow[] = [];

  const pushUnit = (node: UnitNode, flags: boolean[], underOwnTask: boolean): void => {
    rows.push({ node, lastFlags: flags, underOwnTask });
    node.children.forEach((child, index) => {
      pushUnit(child, [...flags, index === node.children.length - 1], false);
    });
  };

  const pushTask = (node: TaskNodeView, flags: boolean[]): void => {
    rows.push({ node, lastFlags: flags, underOwnTask: false });
    const total = node.units.length + node.children.length;
    node.units.forEach((unit, index) => {
      pushUnit(unit, [...flags, index === total - 1], true);
    });
    node.children.forEach((child, index) => {
      pushTask(child, [...flags, node.units.length + index === total - 1]);
    });
  };

  const topLevel = model.unattached.length + model.tasks.length;
  model.unattached.forEach((unit, index) => {
    pushUnit(unit, [index === topLevel - 1], false);
  });
  model.tasks.forEach((task, index) => {
    pushTask(task, [model.unattached.length + index === topLevel - 1]);
  });

  return rows;
}
