/**
 * The adapter contract. Four verbs: `send`, `stream`, `interrupt`, `close`.
 *
 * This is the seam that makes multi-vendor structural rather than aspirational. Everything
 * above this file is harness-neutral; everything harness-specific (claude's
 * `-p --input-format stream-json`, codex's `app-server` / `exec --json`) lives below it.
 *
 * | Harness | Duplex                             | One-shot     | Structured out    | Resume        |
 * |---------|------------------------------------|--------------|-------------------|---------------|
 * | claude  | `-p --input-format stream-json`     | `-p`         | `--json-schema`   | `--resume`    |
 * | codex   | `app-server` (stdio)                | `exec --json`| `--output-schema` | `exec resume` |
 *
 * THE RESUME COLUMN IS VENDOR CAPABILITY, NOT SHIPPED BEHAVIOUR. Nothing in this tree emits
 * `--resume` or `codex exec resume`; a crashed soldier is re-attempted as a fresh agent, not
 * resumed. The column stays because it is what the seam has to be able to express, and because
 * the two spellings differ enough that discovering it late would be a rewrite — but no caller
 * should read it as "resume works today". What it takes to make it true is written on
 * `SoldierSpec.sessionId`.
 *
 * AUTH: workers inherit the interactive OAuth login. Forward `CLAUDE_CONFIG_DIR`; never
 * set `ANTHROPIC_API_KEY` and NEVER pass `--bare` — it skips the keychain and silently breaks
 * subscription auth.
 */

import type { Rank, Role } from './ranks.ts';

export const HARNESS_IDS = ['claude', 'codex'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * Reasoning effort, normalised across vendors. Dispatch uses `xhigh` (claude) and `high`
 * (codex). Adapters map or drop values their CLI does not accept — this union is the superset,
 * not a promise that every harness honours every level.
 *
 * NEVER downgrade the reasoning class to conserve quota (firstmate's hardest dispatch rule):
 * report that the strongest-class choice cannot proceed instead.
 */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * A subordinate a worker may field as a native subagent, with the loadout it may field it WITH.
 *
 * A native subagent is not a process and has no argv of its own: it runs inside its parent and
 * inherits its parent's permission settings. So this declaration is the only channel through which
 * a subordinate's rank can narrow anything, and it is built by `subagentRosterFor` in
 * `src/command/permissions.ts` from the same `narrowToRank` that builds the parent's own list.
 * That module is also where the measured table of what the harness does and does not enforce lives;
 * read it before trusting any field here to be a boundary.
 */
export interface SubagentDefinition {
  /** The `subagent_type` a parent names to field one: `sgt-engineer`. */
  name: string;
  /** Authority. Must be strictly junior to the fielding worker's rank. */
  rank: Rank;
  /** Branch of service, inherited from the worker that fields it. */
  role: Role;
  /** Shown to the fielding model when it chooses whom to send. */
  description: string;
  /** The subordinate's system prompt. */
  prompt: string;
  /**
   * Tool NAMES, never rules. There is no position in a subagent declaration for the
   * `Bash(git:*)` form, so a scoped shell cannot be expressed here — which is one of the reasons
   * the ranks on this substrate hold no shell at all.
   */
  tools: string[];
}

/** Everything a spawner decides about a soldier before the process exists. */
export interface SoldierSpec {
  /** Supervisor-minted, stable, human-legible: `cpt-03`. Identity is spawner-owned. */
  agentId: string;
  /** Authority. Must be strictly junior to the spawner's rank (`isStrictlyJuniorTo`). */
  rank: Rank;
  /** Branch of service — decides tool loadout, write access, output schema, default model. */
  role: Role;
  harness: HarnessId;
  /** Vendor model id, e.g. `claude-sonnet-5`, `gpt-5.5`. Adapter default when absent. */
  model?: string;
  effort?: ReasoningEffort;
  /**
   * Working directory. For an ENGINEER this is its leased worktree; for an INSPECTOR it is the
   * Engineer's worktree attached read-only; otherwise the primary checkout.
   */
  cwd: string;
  /**
   * Supervisor-minted UUID. Its ONE live job is identity: the spawner knows what it spawned
   * without parsing an id out of the child's output, and it is written to `AgentRow.session_id`.
   * A UUID rather than a free string because claude validates the flag's format.
   *
   * NOT HARNESS-NEUTRAL, despite reading like it. `src/harness/claude.ts` passes it as
   * `--session-id` and claude echoes it back on `system/init`. `src/harness/codex.ts` has no
   * analogue — the thread id is CODEX-minted and arrives on the first line as
   * `thread.started.thread_id` — so for a codex soldier this value is carried and recorded but
   * never reaches the process, and the `sessionId` on its `ready` event is the codex thread id,
   * not this.
   *
   * NOT A RESUME KEY EITHER, today: nothing emits `--resume` or `codex exec resume`. Making
   * resume real needs the codex thread id persisted alongside this (the adapter already exposes
   * it) and a supervisor that reattaches instead of re-attempting; the trigger is a campaign long
   * enough that losing a crashed agent's context costs more than re-running it, which a
   * single-task campaign is not.
   */
  sessionId: string;
  /**
   * Path to a JSON Schema FILE (see `REPORT_SCHEMA_PATH` / `VERDICT_SCHEMA_PATH`).
   *
   * VERIFIED ASYMMETRY, absorbed by the adapters:
   *   codex  `--output-schema <FILE>`   — takes the path directly.
   *   claude `--json-schema <JSON>`     — takes INLINE JSON. Passing a path fails with
   *                                       "--json-schema is not valid JSON". The claude
   *                                       adapter must read the file and inline its contents.
   *
   * The schema files themselves are already written to satisfy both CLIs: no `$schema` key
   * (claude cannot resolve the 2020-12 meta-schema URI) and OpenAI strict mode — every property
   * in `required` at every level, optional properties nullable (codex 400s otherwise).
   */
  outputSchemaPath?: string;
  /** Role allow-list. Enforced with `--permission-mode dontAsk`; nothing prompts. */
  allow: string[];
  /** Global deny-list. No override, at any rank. A denial writes a signal row (ceiling breach). */
  deny: string[];
  /** Extra environment. Credentials are INHERITED, never injected — see the auth note above. */
  env?: Record<string, string>;

  /**
   * The subordinates this worker may field as native subagents, each with its own narrowed loadout.
   *
   * NOT HARNESS-NEUTRAL, and the asymmetry is total rather than a matter of degree. A native
   * subagent inherits its parent's permission settings, so this is the ONLY channel by which a
   * subordinate's rank narrows anything — see `SubagentDefinition` in `src/command/permissions.ts`
   * for what was measured to hold and what was not. `src/harness/claude.ts` emits it as `--agents`.
   * `codex exec` has no subagent model at all, so there is nothing to translate and nothing to
   * degrade to: `buildSoldierSpec` refuses to build a codex spec carrying a roster rather than
   * dropping it, because a dropped roster is a unit that reports a squad it never had.
   *
   * Absent or empty means this worker fields nobody, which is not the same as "unset": the claude
   * adapter pins the nesting cap to zero for a worker with no roster, so an empty roster is an
   * enforced absence rather than a default.
   */
  subagents?: readonly SubagentDefinition[];

  /**
   * The orders themselves. ALWAYS present — the caller resolves `orders.md` before spawning.
   *
   * This was a `{ordersPath} | {orders}` union so that "at least one" was enforced by the type.
   * It is a plain required field now because every consumer of `Soldier.spec` had to narrow the
   * union before it could read the briefing, which is a permanent tax on every adapter to catch
   * a mistake that happens once, at the single call site that builds the spec.
   */
  orders: string;
  /**
   * Where `orders` was read from, when it came from a file. Provenance only — the archive wants
   * it (`TaskRow.orders_path`) and a human wants something cat-able. Never re-read by an adapter.
   */
  ordersPath?: string;
}

/** Terminal disposition of a soldier process, normalised across harnesses. */
export const SOLDIER_STATUSES = ['ok', 'error', 'interrupted', 'timeout', 'killed'] as const;
export type SoldierStatus = (typeof SOLDIER_STATUSES)[number];

/** Best-effort token accounting; every field optional because vendors report different shapes. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
}

/**
 * Fields carried by EVERY normalised event, whatever its `type`.
 *
 * `raw` is the load-bearing one. `stream.jsonl` is both the dashboard's live view AND a full
 * post-hoc replay of any soldier days later — which only holds if normalisation is lossless. So
 * every event keeps the original parsed JSON line, and anything unrecognised becomes an `unknown`
 * event rather than being dropped.
 *
 * `parentToolUseId` + `depth` are on the base rather than only on the nested variants: they are
 * what reconstructs the org chart including the native-subagent layer, and a consumer
 * writing an index row should not have to narrow the union to learn where an event sat in the
 * tree. Top-level events carry `parentToolUseId: null`, `depth: 0`.
 */
export interface SoldierEventBase {
  /** ISO-8601. Adapter-stamped on receipt when the harness does not supply one. */
  ts: string;
  /** The original parsed JSON line, verbatim. Never normalise this away. */
  raw: unknown;
  /** `parent_tool_use_id` from `--forward-subagent-text`; null at the top level. */
  parentToolUseId: string | null;
  /** 0 for the soldier process itself; 1+ for each native-subagent nesting level. */
  depth: number;
}

/** `system/init`. Advertises capabilities such as `interrupt_receipt_v1`. */
export interface ReadyEvent extends SoldierEventBase {
  type: 'ready';
  /** Echoed back by the harness; should equal `spec.sessionId`. Mismatch is a bug worth logging. */
  sessionId: string;
  /** e.g. `['interrupt_receipt_v1']` — gate `interrupt()` on this. */
  capabilities: string[];
}

export interface AssistantTextEvent extends SoldierEventBase {
  type: 'assistant_text';
  text: string;
}

export interface ToolUseEvent extends SoldierEventBase {
  type: 'tool_use';
  name: string;
  toolUseId: string;
  /** Tool input, shape unknown at this layer. */
  input?: unknown;
}

export interface ToolResultEvent extends SoldierEventBase {
  type: 'tool_result';
  /** Correlates back to the `ToolUseEvent` with the same id. */
  toolUseId: string;
  isError: boolean;
  content?: unknown;
}

/**
 * Text forwarded from a nested agent at any depth (`--forward-subagent-text`, needs claude
 * >=2.1.211 for the flag and >=2.1.219 for nested depth). `parentToolUseId` is non-null by
 * construction — it is the edge in the org chart.
 */
export interface SubagentTextEvent extends SoldierEventBase {
  type: 'subagent_text';
  text: string;
  parentToolUseId: string;
  /** Always >= 1. */
  depth: number;
  /** The `subagent_type` if the harness reports it. */
  subagentType?: string;
}

/** End of a turn / run. Cost and duration are the campaign's ledger inputs. */
export interface ResultEvent extends SoldierEventBase {
  type: 'result';
  status: SoldierStatus;
  costUsd?: number;
  durationMs?: number;
  usage?: TokenUsage;
}

export interface ErrorEvent extends SoldierEventBase {
  type: 'error';
  message: string;
}

/**
 * A line we parsed but do not model. NEVER drop a line: an unmodelled event still replays,
 * still indexes, and is how we notice a harness changed its wire format.
 */
export interface UnknownEvent extends SoldierEventBase {
  type: 'unknown';
  /** The harness's own type/subtype string, if it had one — useful for triage. */
  harnessType?: string;
}

/** Harness-neutral normalised stream event. Discriminate on `type`. */
export type SoldierEvent =
  | ReadyEvent
  | AssistantTextEvent
  | ToolUseEvent
  | ToolResultEvent
  | SubagentTextEvent
  | ResultEvent
  | ErrorEvent
  | UnknownEvent;

export type SoldierEventType = SoldierEvent['type'];

/** Runtime mirror of `SoldierEventType`, for validation and archive indexing. */
export const SOLDIER_EVENT_TYPES = [
  'ready',
  'assistant_text',
  'tool_use',
  'tool_result',
  'subagent_text',
  'result',
  'error',
  'unknown',
] as const;

export interface CloseResult {
  /** Process exit code; null when the process was signalled or never materialised. */
  exitCode: number | null;
  status: SoldierStatus;
  costUsd?: number;
  durationMs?: number;
}

/**
 * A live soldier. Long-lived headless duplex process: the parent writes user messages to
 * stdin, the child streams events to stdout. Pipes only — no PTY, no tmux, so Windows works.
 */
export interface Soldier {
  /** Equals `spec.agentId`. */
  readonly id: string;
  readonly spec: SoldierSpec;

  /** Push a turn onto the soldier's stdin. Rejects if the process has closed. */
  send(text: string): Promise<void>;

  /**
   * The normalised event stream. Single consumer: the supervisor tees it to `stream.jsonl`
   * (truth) and to the dashboard. Ends when the process exits.
   */
  stream(): AsyncIterable<SoldierEvent>;

  /**
   * Barge in mid-turn. Only meaningful when the `ready` event advertised
   * `interrupt_receipt_v1`; adapters without it should reject rather than pretend.
   */
  interrupt(): Promise<void>;

  /** Close stdin and wait for exit. Idempotent. */
  close(): Promise<CloseResult>;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  /**
   * False for a turn-based harness (codex `exec --json`), in which case `send` is valid only
   * once before `close` and `interrupt` rejects. Codex duplex (`app-server`) is unverified.
   */
  readonly supportsDuplex: boolean;
  spawn(spec: SoldierSpec): Promise<Soldier>;
}
