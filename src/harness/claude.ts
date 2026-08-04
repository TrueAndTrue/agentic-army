/**
 * The Claude adapter — the duplex one.
 *
 * ```
 * claude -p --input-format stream-json --output-format stream-json \
 *        --session-id <supervisor-minted-uuid> --forward-subagent-text
 * ```
 *
 * A long-lived process: the parent writes user messages to stdin, the child streams events on
 * stdout. **Pipes only — no PTY, no tmux.** That is the entire Windows story and nothing in here
 * may introduce a terminal dependency.
 *
 * AUTH — the two silent-breakage rules, both regression-tested in test/harness.test.ts:
 *   1. NEVER pass `--bare`. It skips OAuth/keychain reads and demands `ANTHROPIC_API_KEY`.
 *   2. Inherit the environment so the interactive OAuth login is inherited. `CLAUDE_CONFIG_DIR`
 *      rides along for free; we never inject a credential.
 *
 * Everything measured below was verified against claude 2.1.220 on 2026-08-02; the recorded
 * streams are in test/fixtures/claude-*.jsonl and the normalizer is pinned against them, so an
 * upstream wire-format change shows up as a failing test rather than as a silent data loss.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type {
  CloseResult,
  HarnessAdapter,
  ReasoningEffort,
  Soldier,
  SoldierEvent,
  SoldierSpec,
  SoldierStatus,
  TokenUsage,
} from '../contracts/harness.ts';
import type { JsonlLine } from './jsonl.ts';
import { createAsyncQueue, createJsonlFramer } from './jsonl.ts';

// ---------------------------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------------------------

/**
 * `--effort` accepts low|medium|high|xhigh|max; our normalised union also has `minimal`, which
 * claude does not take. The contract explicitly allows an adapter to map a level its CLI does not
 * accept — and mapping UP (minimal -> low) rather than dropping it keeps us on the right side of
 * firstmate's rule about never silently downgrading a reasoning class.
 */
const CLAUDE_EFFORT: Record<ReasoningEffort, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

export interface ClaudeArgsOptions {
  /** Read `outputSchemaPath` off disk. Injectable so the pure arg tests need no fixtures. */
  readFile?: (path: string) => string;
}

/**
 * Values from the spec land in argv positions where the CLI expects a VALUE. A value that begins
 * with `-` is parsed as a flag instead, which is a flag-injection hole — and `--allowedTools` is
 * variadic, so a `--bare` anywhere in `spec.allow` becomes a real `--bare` on the command line and
 * silently breaks subscription auth.
 *
 * Reject rather than sanitise: a spec that wants to pass `-x` as a tool name is already wrong, and
 * a loud throw at spawn time is much cheaper than a worker that quietly bills the wrong account.
 */
function assertNotFlagLike(field: string, value: string): void {
  if (value.startsWith('-')) {
    throw new Error(
      `SoldierSpec.${field} may not begin with "-" (got ${JSON.stringify(value)}): it would be parsed as a CLI flag`,
    );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `--session-id` must be a UUID; claude rejects anything else, and it is an argv slot. */
function assertUuid(field: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`SoldierSpec.${field} must be a UUID (got ${JSON.stringify(value)})`);
  }
}

/**
 * Build the argv for a duplex soldier. Pure, so the auth regression guards can assert on it
 * without spawning anything.
 */
export function buildClaudeArgs(spec: SoldierSpec, options?: ClaudeArgsOptions): string[] {
  const read = options?.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  // Every spec field that reaches an argv value slot is validated before it gets there.
  assertUuid('sessionId', spec.sessionId);
  if (spec.model !== undefined) assertNotFlagLike('model', spec.model);
  spec.allow.forEach((v, i) => assertNotFlagLike(`allow[${String(i)}]`, v));
  spec.deny.forEach((v, i) => assertNotFlagLike(`deny[${String(i)}]`, v));

  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // stream-json is only accepted alongside --verbose on the -p path.
    '--verbose',
    '--session-id',
    spec.sessionId,
    // Forwards nested subagent messages carrying parent_tool_use_id at every depth — this is what
    // lets the UI reconstruct the org chart. Verified: the forwarded record also carries a
    // top-level `subagent_type`.
    '--forward-subagent-text',
    // Nothing prompts. A denial becomes a signal row, i.e. a ceiling breach.
    '--permission-mode',
    'dontAsk',
  ];

  if (spec.model !== undefined && spec.model !== '') args.push('--model', spec.model);
  if (spec.effort !== undefined) args.push('--effort', CLAUDE_EFFORT[spec.effort]);
  if (spec.allow.length > 0) args.push('--allowedTools', ...spec.allow);
  if (spec.deny.length > 0) args.push('--disallowedTools', ...spec.deny);

  // The schema-capped return. Unlike codex's `--output-schema`, claude's `--json-schema`
  // takes the schema INLINE, so the contract's path has to be dereferenced here.
  if (spec.outputSchemaPath !== undefined && spec.outputSchemaPath !== '') {
    args.push('--json-schema', read(spec.outputSchemaPath));
  }

  return args;
}

/**
 * Credentials that must never be INJECTED into a claude worker.
 *
 * The asymmetry with codex is deliberate. `CLAUDE_CONFIG_DIR` is explicitly forwarded — the worker
 * belongs on the same credential store as the commander — so it is not on this list. What is
 * forbidden is handing the child an API key, which is exactly what `--bare` would then require and
 * what takes the whole campaign off the subscription.
 */
export const CLAUDE_ENV_FORBIDDEN = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * The child's environment.
 *
 * `process.env` is inherited wholesale — that inheritance IS the OAuth login, and stripping
 * it is how you end up with a worker that cannot authenticate. `spec.env` is the caller-controlled
 * injection vector, so it is the half that gets policed.
 */
export function buildClaudeEnv(
  spec: SoldierSpec,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const extra = spec.env ?? {};
  for (const key of CLAUDE_ENV_FORBIDDEN) {
    if (Object.hasOwn(extra, key)) {
      throw new Error(
        `SoldierSpec.env may not set ${key}: workers inherit the interactive OAuth login`,
      );
    }
  }
  return { ...base, ...extra };
}

// ---------------------------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function sum(...parts: (number | undefined)[]): number | undefined {
  const present = parts.filter((p): p is number => p !== undefined);
  return present.length === 0 ? undefined : present.reduce((a, b) => a + b, 0);
}

/**
 * Claude reports cache tokens DISJOINTLY from `input_tokens` (measured: input 10 / cache_read
 * 17476 on a turn whose prompt was three words), so the total is a straight sum. Codex does the
 * opposite — see `codex.ts`.
 */
function claudeUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const usage: TokenUsage = {};
  const input = num(raw['input_tokens']);
  const output = num(raw['output_tokens']);
  const cacheRead = num(raw['cache_read_input_tokens']);
  const cacheCreate = num(raw['cache_creation_input_tokens']);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cacheRead !== undefined) usage.cacheReadInputTokens = cacheRead;
  if (cacheCreate !== undefined) usage.cacheCreationInputTokens = cacheCreate;
  const total = sum(input, output, cacheRead, cacheCreate);
  if (total !== undefined) usage.totalTokens = total;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/**
 * The `terminal_reason` domain, lifted verbatim from claude 2.1.220's own bundle.
 *
 * PROVENANCE — this is an enumeration of someone else's internals, so it WILL drift. It was read
 * out of the shipped binary (`strings`), not guessed:
 *
 * ```js
 * j1_ = ["blocking_limit","rapid_refill_breaker","prompt_too_long","image_error","model_error",
 *        "api_error","malformed_tool_use_exhausted","aborted_streaming","aborted_tools",
 *        "stop_hook_prevented","hook_stopped","tool_deferred","max_turns",
 *        "background_requested","completed"]
 * W1_ = ["budget_exhausted","structured_output_retry_exhausted","tool_deferred_unavailable",
 *        "turn_setup_failed"]
 * fud = [...j1_, ...W1_]                       // the zod enum behind terminal_reason
 * function Wpt(e){ return e==="aborted_streaming" || e==="aborted_tools" }   // abort predicate
 * ```
 *
 * `Wpt` is claude's OWN answer to "was this turn aborted", and it has exactly two members. An
 * earlier version of this file handled `aborted_tools` (observed live) plus `interrupted` and
 * `cancelled` — two values that are not in the enum at all — while missing `aborted_streaming`,
 * which is real and arrives whenever the barge-in lands during streaming rather than during a
 * tool call. Which of the two you get is timing-dependent, so roughly half of all interrupts were
 * being filed as failures — and a failure gets retried, which means re-running work a human
 * deliberately stopped.
 *
 * The lesson is encoded in the code below: match the FAMILY (`aborted*`) rather than an
 * enumeration, and let the caller's own knowledge that it issued an interrupt override the string
 * entirely.
 */
export const CLAUDE_TERMINAL_ABORT = ['aborted_streaming', 'aborted_tools'] as const;

/** `Bxs(e)` in the bundle: the reasons claude itself classifies as genuine failures. */
export const CLAUDE_TERMINAL_ERROR = [
  'blocking_limit',
  'rapid_refill_breaker',
  'prompt_too_long',
  'image_error',
  'model_error',
  'api_error',
  'malformed_tool_use_exhausted',
  'structured_output_retry_exhausted',
  'tool_deferred_unavailable',
  'turn_setup_failed',
] as const;

/** Ceiling breaches rather than crashes: the work stopped because a budget ran out. */
export const CLAUDE_TERMINAL_CEILING = ['max_turns', 'budget_exhausted'] as const;

/** Neither an abort nor an error — the turn ended for an ordinary reason. */
export const CLAUDE_TERMINAL_OK = [
  'completed',
  'stop_hook_prevented',
  'hook_stopped',
  'tool_deferred',
  'background_requested',
] as const;

const ABORT_SET: ReadonlySet<string> = new Set(CLAUDE_TERMINAL_ABORT);
const ERROR_SET: ReadonlySet<string> = new Set(CLAUDE_TERMINAL_ERROR);
const CEILING_SET: ReadonlySet<string> = new Set(CLAUDE_TERMINAL_CEILING);
const OK_SET: ReadonlySet<string> = new Set(CLAUDE_TERMINAL_OK);

/**
 * True for every abort claude can report, including ones this version has never seen.
 *
 * The prefix test is deliberate. `aborted_streaming` and `aborted_tools` are the two that exist
 * today; a future `aborted_<something>` is far likelier than a brand-new word for the same idea,
 * and the cost of the two errors is wildly asymmetric — calling a stop a failure triggers a
 * retry of work the Commander halted, while calling a failure a stop merely under-reports.
 */
export function isClaudeAbortReason(terminalReason: string | undefined): boolean {
  if (terminalReason === undefined) return false;
  return ABORT_SET.has(terminalReason) || terminalReason.startsWith('aborted');
}

export interface ClaudeResultContext {
  /**
   * Did WE issue an interrupt that this turn could plausibly be answering?
   *
   * This is the authoritative signal and it outranks every string on the wire. If the supervisor
   * barged in and the turn then ended, the turn was interrupted — whatever reason claude reports,
   * and whether or not this version of the CLI uses a word we recognise.
   */
  interruptRequested?: boolean;
}

/**
 * Terminal disposition of a turn.
 *
 * Order matters and is chosen so the expensive mistake cannot happen:
 *   1. We asked for an interrupt -> `interrupted`, unconditionally.
 *   2. An `aborted*` family reason -> `interrupted`.
 *   3. A reason claude itself classifies -> that classification.
 *   4. An UNRECOGNISED reason -> `unknown`, resolved toward `interrupted` when an interrupt was in
 *      flight, and only then falling back to the subtype/`is_error` flags.
 *
 * Measured on a real interrupt: the aborted turn reports
 * `subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools"` — so
 * `terminal_reason` must be consulted BEFORE `is_error`, which alone would call it a failure.
 */
export function claudeResultStatus(
  rec: Record<string, unknown>,
  ctx?: ClaudeResultContext,
): SoldierStatus {
  const terminal = str(rec['terminal_reason']);

  // (1) Our own knowledge beats any string. If we barged in and the turn ended, it was stopped.
  if (ctx?.interruptRequested === true) return 'interrupted';

  // (2) The abort family.
  if (isClaudeAbortReason(terminal)) return 'interrupted';

  // (3) Claude's own classification of the reason.
  if (terminal !== undefined) {
    if (CEILING_SET.has(terminal)) return 'timeout';
    if (ERROR_SET.has(terminal)) return 'error';
    if (OK_SET.has(terminal)) return 'ok';
    // (4) falls through: an unrecognised reason is NOT assumed to be a failure.
  }

  const subtype = str(rec['subtype']);
  if (subtype === 'error_max_turns' || subtype === 'error_max_budget') return 'timeout';
  if (subtype !== undefined && subtype.startsWith('error')) return 'error';
  if (rec['is_error'] === true) return 'error';
  return 'ok';
}

export interface ClaudeNormalizerOptions {
  /**
   * Called when a `result` line is being classified, to ask whether an interrupt is outstanding.
   * A predicate rather than a flag because the adapter's answer changes turn by turn.
   */
  interruptRequested?: () => boolean;
}

export interface ClaudeNormalizer {
  /** Map one framed line onto zero or more normalised events. Never drops. */
  next(line: JsonlLine, receivedAt?: string): SoldierEvent[];
}

/** Bound on the tool-use -> depth table, so a very long session cannot leak. */
const DEPTH_TABLE_CAP = 8192;

/**
 * Stateful because `depth` is not on the wire.
 *
 * Claude gives us `parent_tool_use_id` and nothing else. Depth is recovered by remembering the
 * depth of the event that ISSUED each tool_use: anything whose `parent_tool_use_id` is that id
 * sits one level deeper. That reconstructs the whole org chart including a subagent that itself
 * spawns a subagent, which a flat `ptu === null ? 0 : 1` rule would flatten.
 */
export function createClaudeNormalizer(options?: ClaudeNormalizerOptions): ClaudeNormalizer {
  const childDepth = new Map<string, number>();
  const interruptRequested = options?.interruptRequested ?? ((): boolean => false);

  function remember(toolUseId: string, depth: number): void {
    childDepth.set(toolUseId, depth + 1);
    if (childDepth.size > DEPTH_TABLE_CAP) {
      const oldest = childDepth.keys().next();
      if (oldest.done !== true) childDepth.delete(oldest.value);
    }
  }

  function depthFor(parentToolUseId: string | null): number {
    if (parentToolUseId === null) return 0;
    return childDepth.get(parentToolUseId) ?? 1;
  }

  return {
    next(line: JsonlLine, receivedAt?: string): SoldierEvent[] {
      const ts = receivedAt ?? new Date().toISOString();

      // Non-JSON on stdout (a stray warning, a truncated line from a killed child). Never drop it.
      if (!line.ok) {
        return [
          {
            type: 'unknown',
            ts,
            raw: line.text,
            parentToolUseId: null,
            depth: 0,
            harnessType: 'noise',
          },
        ];
      }

      const rec = line.value;
      if (!isRecord(rec)) {
        return [{ type: 'unknown', ts, raw: rec, parentToolUseId: null, depth: 0 }];
      }

      const stamp = str(rec['timestamp']) ?? ts;
      const parentToolUseId = str(rec['parent_tool_use_id']) ?? null;
      const depth = depthFor(parentToolUseId);
      const base = { ts: stamp, raw: rec, parentToolUseId, depth };
      const kind = str(rec['type']);
      const subtype = str(rec['subtype']);
      const harnessType = subtype === undefined ? kind : `${kind ?? '?'}/${subtype}`;
      const unknown = (): SoldierEvent[] => [
        harnessType === undefined
          ? { type: 'unknown', ...base }
          : { type: 'unknown', ...base, harnessType },
      ];

      if (kind === 'system' && subtype === 'init') {
        const caps = rec['capabilities'];
        return [
          {
            type: 'ready',
            ...base,
            sessionId: str(rec['session_id']) ?? '',
            capabilities: Array.isArray(caps) ? caps.filter((c): c is string => typeof c === 'string') : [],
          },
        ];
      }

      if (kind === 'assistant' || kind === 'user') {
        const message = rec['message'];
        const content = isRecord(message) ? message['content'] : undefined;
        if (!Array.isArray(content)) return unknown();

        const subagentType = str(rec['subagent_type']);
        const events: SoldierEvent[] = [];

        for (const block of content) {
          if (!isRecord(block)) {
            events.push({ type: 'unknown', ...base, harnessType: `${kind}/block` });
            continue;
          }
          const blockType = str(block['type']);

          // `thinking` is folded into assistant_text deliberately: the contract has no thinking
          // variant, and the codex side folds `reasoning` the same way (see codex.ts), so the two
          // harnesses stay symmetric. The block type is still recoverable from `raw`.
          if (blockType === 'text' || blockType === 'thinking') {
            const text = str(block['text']) ?? str(block['thinking']) ?? '';
            if (kind === 'user') {
              // The echo of our own turn, or `[Request interrupted by user for tool use]`. There is
              // no user_text variant; keep it as unknown rather than passing it off as the
              // soldier's own words.
              events.push({ type: 'unknown', ...base, harnessType: 'user/text' });
              continue;
            }
            if (parentToolUseId !== null) {
              events.push(
                subagentType === undefined
                  ? { type: 'subagent_text', ...base, parentToolUseId, depth, text }
                  : { type: 'subagent_text', ...base, parentToolUseId, depth, text, subagentType },
              );
            } else {
              events.push({ type: 'assistant_text', ...base, text });
            }
            continue;
          }

          if (blockType === 'tool_use') {
            const toolUseId = str(block['id']) ?? '';
            if (toolUseId !== '') remember(toolUseId, depth);
            events.push({
              type: 'tool_use',
              ...base,
              name: str(block['name']) ?? '',
              toolUseId,
              input: block['input'],
            });
            continue;
          }

          if (blockType === 'tool_result') {
            events.push({
              type: 'tool_result',
              ...base,
              toolUseId: str(block['tool_use_id']) ?? '',
              isError: block['is_error'] === true,
              content: block['content'],
            });
            continue;
          }

          events.push({ type: 'unknown', ...base, harnessType: `${kind}/${blockType ?? 'block'}` });
        }

        return events.length === 0 ? unknown() : events;
      }

      if (kind === 'result') {
        const status = claudeResultStatus(rec, { interruptRequested: interruptRequested() });
        const events: SoldierEvent[] = [];

        // PERMISSION DENIALS — a permission denial IS a ceiling breach, i.e. a
        // first-class signal that the escalation ladder already knows how to route.
        //
        // Claude reports them as a `permission_denials` ARRAY on the result line, and the contract
        // has no variant for them, so every consumer was re-deriving them from `ResultEvent.raw` —
        // each with its own idea of the shape. Lifting them to one event per denial means the
        // archive can index them and the ladder can route them without anybody parsing `raw`.
        //
        // CONTRACT GAP, reported not patched: this belongs in the union as a
        // `PermissionDenialEvent`. Until then `unknown` + `harnessType` is the honest carrier —
        // it is not an error, and `raw` is the single denial rather than the whole result line.
        const denials = rec['permission_denials'];
        if (Array.isArray(denials)) {
          for (const denial of denials) {
            events.push({
              type: 'unknown',
              ts: stamp,
              raw: denial,
              parentToolUseId,
              depth,
              harnessType: 'permission_denial',
            });
          }
        }

        const cost = num(rec['total_cost_usd']);
        const duration = num(rec['duration_ms']);
        const usage = claudeUsage(rec['usage']);
        events.push({
          type: 'result',
          ...base,
          status,
          ...(cost === undefined ? {} : { costUsd: cost }),
          ...(duration === undefined ? {} : { durationMs: duration }),
          ...(usage === undefined ? {} : { usage }),
        });
        return events;
      }

      if (kind === 'control_response') {
        const response = rec['response'];
        const errorText = isRecord(response) ? str(response['error']) : undefined;
        if (errorText !== undefined) {
          return [{ type: 'error', ...base, message: errorText }];
        }
        return unknown();
      }

      return unknown();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------------------------

export interface ClaudeAdapterOptions {
  /**
   * Binary to spawn. Overridable because on Windows the shim may be `claude.cmd` and we refuse to
   * use `shell: true` — quoting an inline `--json-schema` through `cmd.exe` is a correctness
   * hazard. `ARMY_CLAUDE_BIN` overrides it out of band.
   */
  bin?: string;
  /** Grace period after stdin closes before we escalate to SIGTERM. */
  closeGraceMs?: number;
  /** Grace period after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  /** How long `interrupt()` waits for its `control_response` receipt. */
  interruptTimeoutMs?: number;
}

const DEFAULTS = {
  closeGraceMs: 300_000,
  killGraceMs: 5_000,
  interruptTimeoutMs: 30_000,
};

/** Ring-buffered stderr tail, so a spawn failure can be reported without unbounded memory. */
const STDERR_TAIL_CHARS = 4096;

export function createClaudeAdapter(options?: ClaudeAdapterOptions): HarnessAdapter {
  const bin = options?.bin ?? process.env['ARMY_CLAUDE_BIN'] ?? 'claude';
  const closeGraceMs = options?.closeGraceMs ?? DEFAULTS.closeGraceMs;
  const killGraceMs = options?.killGraceMs ?? DEFAULTS.killGraceMs;
  const interruptTimeoutMs = options?.interruptTimeoutMs ?? DEFAULTS.interruptTimeoutMs;

  return {
    id: 'claude',
    supportsDuplex: true,
    spawn(spec: SoldierSpec): Promise<Soldier> {
      // MUST REJECT, NOT THROW. `spawn` is typed `Promise<Soldier>`; `spawnClaude` reaches
      // `buildClaudeArgs`, which throws on a flag-like value or a non-UUID session id. A
      // synchronous throw from an async-typed method slips past every caller's `.catch()`.
      try {
        return Promise.resolve(spawnClaude(spec, bin, closeGraceMs, killGraceMs, interruptTimeoutMs));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

/** The default registry entry. */
export const claudeAdapter: HarnessAdapter = createClaudeAdapter();

function spawnClaude(
  spec: SoldierSpec,
  bin: string,
  closeGraceMs: number,
  killGraceMs: number,
  interruptTimeoutMs: number,
): Soldier {
  const args = buildClaudeArgs(spec);
  const queue = createAsyncQueue<SoldierEvent>();
  const framer = createJsonlFramer();
  const startedAt = process.hrtime.bigint();

  // Set when we issue an interrupt, cleared when the turn it stopped reports back. While it is
  // set, ANY terminal outcome for that turn is `interrupted` — see `claudeResultStatus`.
  let interruptPending = false;
  // Whether a turn is actually running. `interruptPending` may ONLY be armed while this is true:
  // the real CLI answers an interrupt with no turn in flight using a bare `control_response` and
  // NO `result`, so an unconditionally-armed flag would survive to misfile the next clean turn.
  let turnInFlight = false;
  const normalizer = createClaudeNormalizer({ interruptRequested: () => interruptPending });

  // Credentials are INHERITED, never injected. Inheriting process.env is what carries the
  // OAuth login (and CLAUDE_CONFIG_DIR, if the commander set one) into the worker.
  const env = buildClaudeEnv(spec);

  let child: ChildProcessWithoutNullStreams | null = null;
  let spawnError: Error | null = null;
  try {
    child = spawn(bin, args, {
      cwd: spec.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    spawnError = err instanceof Error ? err : new Error(String(err));
  }

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let processExited = spawnError !== null;
  let stdoutEnded = spawnError !== null;
  let closed = false;
  let lastCostUsd: number | undefined;
  let lastResultStatus: SoldierStatus | undefined;
  let sawFatalError = spawnError !== null;
  let escalation: 'none' | 'term' | 'kill' = 'none';
  let stderrTail = '';
  let capabilities: string[] | null = null;
  let resultCount = 0;
  let sentCount = 0;
  const pendingControl = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let closePromise: Promise<CloseResult> | null = null;

  function emit(event: SoldierEvent): void {
    if (event.type === 'result') {
      // The interrupt has been answered by this turn; the next one starts clean.
      // The turn has reported; both flags reset together.
      interruptPending = false;
      turnInFlight = false;
      resultCount += 1;
      lastResultStatus = event.status;
      // MEASURED: `total_cost_usd` is session-CUMULATIVE, not per-turn (turn 1 = $0.01705,
      // turn 2 = $0.02505 with turn 1's cache reads still counted). Summing would double-bill, so
      // the ledger takes the last value, not the total.
      if (event.costUsd !== undefined) lastCostUsd = event.costUsd;
    }
    if (event.type === 'ready' && capabilities === null) capabilities = event.capabilities;
    if (event.type === 'error') sawFatalError = true;
    queue.push(event);
  }

  /** An adapter-originated error (spawn failure, non-zero exit). `raw` is marked as synthetic. */
  function emitSynthetic(message: string): void {
    emit({
      type: 'error',
      ts: new Date().toISOString(),
      raw: { __source: 'agentic-army/claude-adapter', message },
      parentToolUseId: null,
      depth: 0,
      message,
    });
  }

  function maybeFinish(): void {
    if (processExited && stdoutEnded && !queue.ended) {
      for (const waiter of pendingControl.values()) {
        waiter.reject(new Error('claude soldier exited before the control response arrived'));
      }
      pendingControl.clear();
      queue.end();
    }
  }

  function handleLine(line: JsonlLine): void {
    // The control channel is consumed here AND republished as an event: `interrupt()` needs the
    // receipt, and the archive needs every line to reach stream.jsonl for replay.
    if (line.ok && isRecord(line.value) && line.value['type'] === 'control_response') {
      const response = line.value['response'];
      if (isRecord(response)) {
        const id = str(response['request_id']);
        const waiter = id === undefined ? undefined : pendingControl.get(id);
        if (waiter !== undefined && id !== undefined) {
          pendingControl.delete(id);
          if (str(response['subtype']) === 'success') waiter.resolve();
          else waiter.reject(new Error(str(response['error']) ?? 'control request failed'));
        }
        // Belt and braces for the leak. If the receipt lands while nothing is running, the CLI has
        // told us there was nothing to stop — and no `result` is coming to clear the flag, so it
        // must be disarmed here or the next clean turn inherits it.
        if (!turnInFlight) interruptPending = false;
      }
    }

    // A control_request FROM the child (e.g. a permission round-trip) would deadlock the turn if
    // nobody answers. `--permission-mode dontAsk` means we should never see one, but answering
    // with an error is strictly better than hanging forever.
    if (line.ok && isRecord(line.value) && line.value['type'] === 'control_request') {
      const id = str(line.value['request_id']);
      if (id !== undefined) {
        write(
          JSON.stringify({
            type: 'control_response',
            response: { subtype: 'error', request_id: id, error: 'unsupported by agentic-army' },
          }) + '\n',
        );
      }
    }

    for (const event of normalizer.next(line)) emit(event);
  }

  function write(payload: string): boolean {
    if (child === null || child.stdin.destroyed || child.stdin.writableEnded) return false;
    try {
      child.stdin.write(payload);
      return true;
    } catch {
      return false;
    }
  }

  if (child !== null) {
    const proc = child;
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const line of framer.push(chunk)) handleLine(line);
    });
    proc.stdout.on('end', () => {
      for (const line of framer.flush()) handleLine(line);
      stdoutEnded = true;
      maybeFinish();
    });
    proc.stdout.on('error', () => {
      stdoutEnded = true;
      maybeFinish();
    });
    // Claude's stderr is normally silent. Keep the tail so a spawn/auth failure is reportable, but
    // NEVER merge it into the JSONL stream.
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    proc.stderr.on('error', () => {});
    // A closed pipe on stdin is normal at teardown; it must not become an unhandled 'error'.
    proc.stdin.on('error', () => {});
    proc.on('error', (err: Error) => {
      emitSynthetic(`failed to spawn \`${bin}\`: ${err.message}`);
      processExited = true;
      stdoutEnded = true;
      maybeFinish();
    });
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal;
      processExited = true;
      if (code !== null && code !== 0 && !sawFatalError) {
        const tail = stderrTail.trim();
        emitSynthetic(`claude exited with code ${String(code)}${tail === '' ? '' : `: ${tail}`}`);
      } else if (silentlyDied()) {
        // EXIT 0 WITH NOTHING TO SHOW FOR IT. A worker that was given a turn and produced no
        // `result` did not do the work, whatever its exit code claims. Reporting that as `ok` puts
        // a fictitious success in the campaign ledger; for an INSPECTOR it would mean the
        // review gate passing a branch it never looked at.
        const tail = stderrTail.trim();
        emitSynthetic(
          `claude exited 0 after ${String(sentCount)} turn(s) without producing a result event ` +
            `(${String(resultCount)} results seen)${tail === '' ? '' : `: ${tail}`}`,
        );
      }
      maybeFinish();
    });
  } else {
    emitSynthetic(`failed to spawn \`${bin}\`: ${spawnError?.message ?? 'unknown error'}`);
    queue.end();
  }

  function elapsedMs(): number {
    return Number(process.hrtime.bigint() - startedAt) / 1e6;
  }

  /**
   * A turn was pushed and the process exited cleanly having never reported a result.
   *
   * Not the same as "closed without sending anything", which is a legitimate no-op — the
   * distinguishing fact is that work WAS requested.
   */
  function silentlyDied(): boolean {
    return sentCount > 0 && resultCount === 0;
  }

  function finalStatus(): SoldierStatus {
    if (escalation === 'kill') return 'killed';
    if (escalation === 'term') return 'timeout';
    if (lastResultStatus === 'interrupted') return 'interrupted';
    if (spawnError !== null) return 'error';
    if (exitSignal !== null) return 'killed';
    // Checked before the exit code, because exit 0 is exactly what makes this dangerous.
    if (silentlyDied()) return 'error';
    if (exitCode === 0) return lastResultStatus === 'error' ? 'error' : 'ok';
    if (exitCode === null) return 'error';
    return 'error';
  }

  const soldier: Soldier = {
    id: spec.agentId,
    spec,

    send(text: string): Promise<void> {
      if (closed) return Promise.reject(new Error(`soldier ${spec.agentId} is closed`));
      if (child === null || processExited) {
        return Promise.reject(new Error(`soldier ${spec.agentId} has no live process`));
      }
      const ok = write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
        }) + '\n',
      );
      if (ok) {
        sentCount += 1;
        turnInFlight = true;
      }
      return ok
        ? Promise.resolve()
        : Promise.reject(new Error(`soldier ${spec.agentId} stdin is closed`));
    },

    stream(): AsyncIterable<SoldierEvent> {
      return { [Symbol.asyncIterator]: () => queue.iterator() };
    },

    /**
     * VERIFIED (claude 2.1.220, 2026-08-02): writing
     * `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}` to stdin
     * aborts the in-flight turn. The child replies
     * `{"type":"control_response","response":{"subtype":"success","request_id":"<id>",
     *   "response":{"still_queued":[]}}}`, the running tool is rejected, a `result` arrives with
     * `terminal_reason:"aborted_tools"`, and the process STAYS ALIVE and accepts the next turn.
     * It is a stdin control message, not a signal — a signal would kill the soldier.
     */
    interrupt(): Promise<void> {
      if (closed || child === null || processExited) {
        return Promise.reject(new Error(`soldier ${spec.agentId} is not running`));
      }
      // The contract says an adapter without the capability must reject rather than pretend. Before
      // `system/init` lands we cannot know, so we attempt it and let the receipt decide.
      if (capabilities !== null && !capabilities.includes('interrupt_receipt_v1')) {
        return Promise.reject(
          new Error(
            `soldier ${spec.agentId} did not advertise interrupt_receipt_v1 (got: ${capabilities.join(', ')})`,
          ),
        );
      }
      const requestId = `army-interrupt-${randomUUID()}`;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingControl.delete(requestId);
          reject(new Error(`interrupt receipt timed out after ${String(interruptTimeoutMs)}ms`));
        }, interruptTimeoutMs);
        timer.unref?.();
        pendingControl.set(requestId, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        const ok = write(
          JSON.stringify({
            type: 'control_request',
            request_id: requestId,
            request: { subtype: 'interrupt' },
          }) + '\n',
        );
        // Armed on WRITE, not on receipt: the turn can terminate before the receipt is parsed, and
        // the classification must not depend on that race.
        //
        // ...but ONLY while a turn is actually running. Interrupting an idle soldier is a no-op
        // that the CLI acknowledges with a `control_response` and no `result`, so arming here
        // would leave the flag set until the NEXT turn's result — classifying a perfectly clean
        // `terminal_reason: "completed"` as `interrupted`. An interrupted turn is routed as a
        // deliberate stop, so that is a successful turn reported as one the Commander cancelled:
        // the exact inverse of the bug this flag was introduced to fix.
        if (ok && turnInFlight) interruptPending = true;
        if (!ok) {
          clearTimeout(timer);
          pendingControl.delete(requestId);
          reject(new Error(`soldier ${spec.agentId} stdin is closed`));
        }
      });
    },

    close(): Promise<CloseResult> {
      if (closePromise !== null) return closePromise;
      closed = true;
      closePromise = (async (): Promise<CloseResult> => {
        if (child === null) {
          return { exitCode: null, status: 'error', durationMs: elapsedMs() };
        }
        const proc = child;
        if (!processExited) {
          try {
            proc.stdin.end();
          } catch {
            /* already gone */
          }
          const exited = new Promise<void>((resolve) => {
            if (processExited) resolve();
            else proc.once('close', () => resolve());
          });
          const graceful = await raceTimeout(exited, closeGraceMs);
          if (!graceful) {
            escalation = 'term';
            proc.kill('SIGTERM');
            const hard = await raceTimeout(exited, killGraceMs);
            if (!hard) {
              escalation = 'kill';
              proc.kill('SIGKILL');
              await exited;
            }
          }
        }
        // Never leave a consumer parked on a stream that will not produce again.
        stdoutEnded = true;
        processExited = true;
        maybeFinish();
        const status = finalStatus();
        return {
          exitCode,
          status,
          durationMs: elapsedMs(),
          ...(lastCostUsd === undefined ? {} : { costUsd: lastCostUsd }),
        };
      })();
      return closePromise;
    },
  };

  return soldier;
}

async function raceTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  const result = await Promise.race([promise.then(() => true), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}
