/**
 * `army campaign` — the vertical slice.
 *
 * ```
 * ☆ GENERAL (this process)
 *  └─ detaches ─▶ ◇ CPT·ENGINEER   claude, leased worktree, cuts army/<task-id>, commits
 *                      │ reports "ready for inspection"
 *  └─ spawns   ─▶ ◇ CPT·INSPECTOR  codex, briefed from ORIGINAL ORDERS + the branch
 *                      FAIL → the GENERAL re-detaches an Engineer with the findings
 *                      PASS → durability, then the delivery ladder
 * ```
 *
 * This file composes; it does not reimplement. Worktrees come from `src/worktree`, processes from
 * `src/harness`, persistence from `src/archive`, landing from `src/delivery`, ceilings from
 * `src/config`, permission rules from `./permissions.ts`, and every word a worker reads from
 * `./orders.ts`.
 *
 * ## Four properties this file is responsible for, in descending order of how badly it hurts to
 * ## get them wrong
 *
 * 1. **The GENERAL spawns the Inspector, and briefs it from the original orders.** The
 *    Engineer's report is never an input to the Inspector's brief. Enforced in `orders.ts` by the
 *    shape of `InspectorBrief`; this file's only job is to call the right function.
 *
 * 2. **The lease is never leaked.** Every exit path — success, inspector fail, engineer crash,
 *    codex missing, an exception nobody predicted — passes through `settleLease`, which either
 *    releases the tree or deliberately retains it and says why. `LeaseDisposition` is on the
 *    result and in the archive, so "we do not know what happened to the worktree" is not a
 *    reachable state.
 *
 * 3. **Durability before release, unconditionally.** A leased tree is reset and cleaned when
 *    it is returned, so work that exists only inside it is one release away from gone. Durability
 *    runs on the FAILURE paths too — an Inspector-failed branch is still a night's work, and rung
 *    0 means "your repo untouched", not "throw it away".
 *
 * 4. **Nothing but the capped report crosses back.** The GENERAL reads `Report` and
 *    `Verdict`, both schema-validated. The transcripts go to `stream.jsonl` and are never read
 *    here.
 *
 * ## Two requirements that conflicted, resolved — see the report accompanying this module
 *
 * - *"FAIL → GENERAL resumes the Engineer with findings"* versus *"an agent is one attempt
 *   at a task"*. Resolved in favour of the second, because a task is intent and an agent is one
 *   process against it, so a retry is a NEW agent against the SAME task: each attempt gets its
 *   own id, session, archive directory and `agent.json`, working in the SAME worktree so the
 *   branch and its commits carry forward. "Resumes" is satisfied in substance — the next
 *   Engineer inherits the tree and is briefed with the findings — and the archive stays honest
 *   about how many processes actually ran. It also survives an Engineer that crashed, which
 *   resuming a dead process does not.
 *
 * - The default requested rung is **2**, not the project ceiling. A merge is not something a
 *   campaign should back into because the project happens to permit one: rung 3 is asked for, by
 *   name, on the command line. Defaulting to 2 and clamping keeps the ceiling a cap rather than a
 *   target, and a project at ceiling 3 that never passes `--rung 3` opens pull requests exactly
 *   as it did before.
 *
 * ## Rung 3, and what this file owes it
 *
 * `runLadder` will not merge for a caller that cannot produce the evidence: `RunLadderInput.merge`
 * carries the Engineer's final status and whether the retry budget was exhausted, and a rung-3
 * plan without it refuses outright (`RungNotImplementedError`). This file is that caller, and the
 * two fields come from `mergeEvidence` — read off this campaign's own state, never asserted as
 * literals. A gate whose input is a constant is a gate that cannot fire, and one that cannot fire
 * is indistinguishable from one that was deleted.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CampaignStatus } from '../contracts/archive.ts';
import type { Rung } from '../contracts/delivery.ts';
import { RUNG_LABEL } from '../contracts/delivery.ts';
import type {
  HarnessAdapter,
  HarnessId,
  ReasoningEffort,
  Soldier,
  SoldierEvent,
  SoldierSpec,
} from '../contracts/harness.ts';
import type { Rank, Role } from '../contracts/ranks.ts';
import type { Report, Verdict } from '../contracts/report.ts';
import {
  REPORT_SCHEMA_PATH,
  SUMMARY_MAX_CHARS,
  VERDICT_SCHEMA_PATH,
  validateReport,
  validateVerdict,
} from '../contracts/report.ts';
import type { Lease } from '../contracts/worktree.ts';
import { armyBranch } from '../contracts/worktree.ts';

import {
  AgentIdInUseError,
  CampaignArchive,
  campaignIdFor,
  createCampaign,
  listCampaignIds,
} from '../archive/archive.ts';
import type { ArchiveConfig } from '../archive/archive.ts';
import { loadConfig } from '../config/load.ts';
import { armyHome, configPath, worktreesRootFor } from '../config/paths.ts';
import type { Env } from '../config/paths.ts';
import {
  DurabilityError,
  ensureDurable,
  inspectUnlandedWork,
  resolveDurabilityTarget,
} from '../delivery/durability.ts';
import { runGit } from '../delivery/git.ts';
import type { GhStatus } from '../delivery/git.ts';
import type {
  DeliveryConfig,
  DeliveryNote,
  DeliveryNoteCode,
  LadderResult,
  MergeRequest,
} from '../delivery/ladder.ts';
import { RungNotImplementedError, projectCeiling, runLadder } from '../delivery/ladder.ts';
import { createClaudeAdapter } from '../harness/claude.ts';
import { createCodexAdapter, isCodexSoldier } from '../harness/codex.ts';
import { getAdapter } from '../harness/index.ts';
import { installHint, invokedAs } from '../setup/checks.ts';
import { mainRootFromCommonDir } from '../setup/enlist.ts';
import type { Fix } from '../setup/fixes.ts';
import {
  doThis,
  doctorFix,
  headExistsArgs,
  initRepoFix,
  initialCommitFix,
  noFix,
  quoteArg,
  runThis,
} from '../setup/fixes.ts';
import { PoolExhaustedError, UnlandedWorkError } from '../worktree/cold.ts';
import { selectWorktreeProvider } from '../worktree/index.ts';
import type { WorktreeProviderId } from '../contracts/worktree.ts';
import type { ProgressEvent, ProgressListener } from '../view/progress.ts';

import {
  briefInspectorFromAttempt,
  renderEngineerOrders,
  renderEngineerReportMd,
  renderVerdictMd,
} from './orders.ts';
import type { OriginalOrders } from './orders.ts';
import {
  assertGlobalDenyIntact,
  assertNoFlagLikeRules,
  assertWorktreeRootOutsideProtected,
  permissionsFor,
} from './permissions.ts';

// ---------------------------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------------------------

/**
 * What became of the worktree. There is no fourth value, and in particular there is no "unknown":
 * release is destructive, so a supervisor that cannot say what it did to a tree has already
 * failed the only safety property that matters there.
 */
export const LEASE_STATES = ['never-acquired', 'released', 'retained'] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

export interface LeaseDisposition {
  state: LeaseState;
  path: string | null;
  leaseId: string | null;
  /** Always populated. For `retained`, this is what a human needs in order to recover the work. */
  reason: string;
}

export type CampaignNoteCode =
  | 'worktree-provider'
  | 'ceiling'
  | 'clamped'
  | 'permission-denied'
  | 'delivery'
  | 'durability'
  | 'lease'
  | 'inspector'
  | 'engineer'
  | 'retry'
  | 'aborted';

export interface CampaignNote {
  level: 'info' | 'warn' | 'error';
  code: CampaignNoteCode;
  message: string;
  /**
   * What to do about it. Required by contract on every `error` note, and carried on the `warn`
   * notes that have a real answer.
   *
   * The contract is `src/setup/checks.ts`'s: a blocking outcome owes the exact command that
   * resolves it. It is on the NOTE rather than reconstructed by the renderer from the message,
   * because deriving it later means pattern-matching prose the site already knew the truth about
   * — the standing order to prefer a parser to a pattern. `kind: 'none'` is a positive statement
   * that nothing resolves this, not an omission; see `src/setup/fixes.ts`.
   */
  fix?: Fix;
}

export const CAMPAIGN_OUTCOMES = [
  'delivered',
  'inspector-failed',
  'engineer-failed',
  'inspector-unavailable',
  'delivery-failed',
  'aborted',
] as const;
export type CampaignOutcome = (typeof CAMPAIGN_OUTCOMES)[number];

/** One Engineer attempt and the review it received. Ordered oldest first. */
export interface AttemptRecord {
  attempt: number;
  engineerAgentId: string;
  inspectorAgentId: string | null;
  report: Report | null;
  verdict: Verdict | null;
  /** Terminal disposition of the Engineer process, from the adapter. */
  engineerStatus: string;
  costUsd: number | null;
}

export interface CampaignResult {
  campaignId: string;
  campaignRoot: string;
  project: string;
  taskId: string;
  branch: string;
  status: CampaignStatus;
  outcome: CampaignOutcome;
  attempts: AttemptRecord[];
  report: Report | null;
  verdict: Verdict | null;
  requestedRung: Rung;
  ceiling: Rung;
  /** The rung actually reached, or null if nothing was delivered. */
  deliveredRung: Rung | null;
  /**
   * True when the campaign stopped because it had no Engineer attempts left.
   *
   * NOT "the last attempt was attempt `maxAttempts`" — a PASS on the final attempt spent the
   * whole budget and finished, which is a different thing from running out of it. This is the
   * value rung 3's retry gate reads (see `mergeEvidence`), reported rather than kept private so
   * the gate's input is something a test can hold still and look at.
   */
  retriesExhausted: boolean;
  delivery: LadderResult | null;
  lease: LeaseDisposition;
  notes: CampaignNote[];
  /**
   * 0 only when the Inspector passed AND delivery ran without an error-level note.
   *
   * The second clause is not decoration. A rung-3 merge that landed and then failed is
   * `delivered` — the work is on the base branch — and still an error, because something after
   * the merge did not happen and nobody knows what. That campaign exits non-zero.
   */
  exitCode: number;
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export interface WriteStream {
  write(text: string): unknown;
  isTTY?: boolean;
}

export interface CampaignOptions {
  /** The `army campaign "<objective>"` argument, verbatim. Never paraphrased downstream. */
  objective: string;
  /** Where the campaign was launched. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Highest rung to attempt, before the project ceiling clamps it. Defaults to 2. */
  requestedRung?: Rung;
  /**
   * Total Engineer attempts, including the first. A CPT has the authority to retry an
   * Inspector fail; this is that budget, made explicit and configurable rather than a constant
   * somebody has to go and find.
   */
  maxAttempts?: number;
  /** Commander's own environment. NEVER accept `AGENTIC_ARMY_HOME` from a worker. */
  env?: Env;
  /** Override the army home. Test seam; production reads `env`. */
  home?: string;
  /** Force a worktree provider. Defaults to whatever `selectWorktreeProvider` picks. */
  worktreeProvider?: WorktreeProviderId;
  /**
   * Managed root for cold worktrees. Defaults to `<home>-trees`, i.e. `~/.agentic-army-trees`.
   *
   * A SIBLING of the army home, not a child of it, and derived from `home` rather than
   * `archiveRoot` — see `worktreesRootFor`. Whatever is passed here is checked by
   * `assertWorktreeRootOutsideProtected` before a single tree is leased.
   */
  worktreeRoot?: string;
  campaignId?: string;
  /** Binaries. Test seam — the fakes go here, so no test ever spawns a real model. */
  claudeBin?: string;
  codexBin?: string;
  /** Full adapter override, for a test that needs to model a harness that is not installed. */
  adapters?: Partial<Record<HarnessId, HarnessAdapter>>;
  /** Injected so rung-2 behaviour is testable with no network and no GitHub account. */
  ghProbe?: () => Promise<GhStatus>;
  /**
   * The `gh` binary the delivery ladder spawns. Defaults to `gh` on PATH.
   *
   * `ghProbe` alone cannot reach rung 3: it answers the availability question and nothing else,
   * so every command AFTER the probe — create, review, view, merge — still went to the real
   * binary. This is the seam that lets the whole merge path run against a stand-in executable and
   * a bare repository on this disk, with no network and no GitHub account, which is the only way
   * the gates get exercised rather than described.
   */
  ghBinary?: string;
  /**
   * Swap the archive's SQLite driver. `ArchiveConfig` exposes this so `bun:sqlite` and
   * `better-sqlite3` stay drop-ins; forwarding it here means a campaign is not the one place that
   * hard-codes `node:sqlite`. It is also how the cleanup-path tests force an archive write to
   * throw at a chosen moment.
   */
  dbFactory?: ArchiveConfig['dbFactory'];
  stdout?: WriteStream;
  stderr?: WriteStream;
  now?: () => string;
  /** Per-soldier wall-clock ceiling. */
  timeoutMs?: number;
  /**
   * Narration, as it happens.
   *
   * A campaign takes minutes and used to print nothing until it was over, so the only feedback a
   * blocked human got was a cursor. The lifecycle was never missing — `signals.jsonl` had it all
   * along — it was simply never offered to the one caller with a person waiting on it.
   *
   * OPTIONAL, and silent when absent: `src/chat` drives the same `runCampaign` through
   * `runDispatch` and renders its own frame around it, so a campaign that nobody passed a
   * listener to must behave exactly as it did before. Every emission is guarded, because a
   * listener writing to a closed pipe must not be able to end a campaign that is holding a lease.
   */
  onProgress?: ProgressListener;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_REQUESTED_RUNG: Rung = 2;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function cap(text: string, max = SUMMARY_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function agentIdFor(n: number): string {
  return `cpt-${String(n).padStart(2, '0')}`;
}

/** The GENERAL's signal identity. Not an `agents` row — it is this CLI process, not a soldier. */
export const GENERAL_AGENT_ID = 'gen-01';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the first JSON object out of a model's final message.
 *
 * Both CLIs are under a schema, so the normal case is that `text` IS the object. The fence and
 * brace-scan fallbacks exist because a schema constrains the CONTENT, not whether a model
 * wrapped it in ```json — and losing a valid report to a code fence would fail an attempt that
 * actually succeeded.
 */
export function parseStructured(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const candidates: string[] = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (isRecord(value)) return value;
    } catch {
      /* try the next shape */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Spec construction — the single choke point for permissions
// ---------------------------------------------------------------------------------------------

export interface BuildSpecInput {
  agentId: string;
  rank: Rank;
  role: Role;
  harness: HarnessId;
  model?: string;
  effort?: ReasoningEffort;
  cwd: string;
  orders: string;
  ordersPath?: string;
  /**
   * The capped-return schema, when this worker has one.
   *
   * Optional because a COMMANDER does not. Every worker that goes away and comes back returns a
   * `Report` or a `Verdict`, and the schema is what makes that return a bounded transport rather
   * than a transcript. A commander never goes away — it is a conversation, and its replies are
   * read by a human on a terminal, so constraining them to a JSON object would put the schema in
   * the one position where it buys nothing and costs the whole reason the session is live.
   *
   * The bound that matters for a commander is on what comes back INTO it, and that is enforced
   * on the subordinates' side, where the schema already is.
   */
  outputSchemaPath?: string;
  /** Resolved army home, so the deny-list carries absolute globs as well as `~`-relative ones. */
  home: string;
}

/**
 * Build a `SoldierSpec`, and refuse to build one whose deny-list has lost the protected-config
 * block.
 *
 * THIS IS THE ONLY PLACE IN THE SLICE THAT CONSTRUCTS A SPEC. That is deliberate: the permission
 * boundary is only a boundary if it is on every worker, and "remember to add the deny list" is
 * exactly the kind of rule that survives right up until the day someone adds a fourth role in a
 * hurry.
 */
export function buildSoldierSpec(input: BuildSpecInput): SoldierSpec {
  const { allow, deny } = permissionsFor(input.role, input.home);
  assertNoFlagLikeRules(allow, `${input.role} allow-list`);
  assertNoFlagLikeRules(deny, 'global deny-list');
  assertGlobalDenyIntact(deny, `${input.agentId} (${input.rank}·${input.role})`);

  const spec: SoldierSpec = {
    agentId: input.agentId,
    rank: input.rank,
    role: input.role,
    harness: input.harness,
    cwd: input.cwd,
    sessionId: randomUUID(),
    allow,
    deny,
    orders: input.orders,
  };
  if (input.outputSchemaPath !== undefined) spec.outputSchemaPath = input.outputSchemaPath;
  if (input.model !== undefined && input.model !== '') spec.model = input.model;
  if (input.effort !== undefined) spec.effort = input.effort;
  if (input.ordersPath !== undefined) spec.ordersPath = input.ordersPath;
  return spec;
}

// ---------------------------------------------------------------------------------------------
// Running one soldier
// ---------------------------------------------------------------------------------------------

export interface SoldierRun {
  events: SoldierEvent[];
  status: string;
  exitCode: number | null;
  /**
   * SESSION-CUMULATIVE on claude, so this is the LAST reported value, never a sum. Null when the
   * harness reported none — codex has no cost field at all, and inventing one would put a fiction
   * in the campaign ledger.
   */
  costUsd: number | null;
  durationMs: number | null;
  /** The parsed schema-constrained return, or undefined when the run produced none. */
  structured: unknown;
  /** `permission_denials` from the harness. Each becomes a signal row — a denial is a breach. */
  denials: unknown[];
  /** Adapter-level error messages, for a readable archive when nothing else survived. */
  errors: string[];
}

async function runSoldier(
  adapter: HarnessAdapter,
  spec: SoldierSpec,
  archive: CampaignArchive,
): Promise<SoldierRun> {
  const events: SoldierEvent[] = [];
  const errors: string[] = [];
  const denials: unknown[] = [];
  let costUsd: number | null = null;

  const soldier: Soldier = await adapter.spawn(spec);

  // Tee the stream to `stream.jsonl` LOSSLESSLY. An archive write that throws must not kill
  // a live soldier — the run is the expensive thing; the index is rebuildable from the file, and
  // the file is what we are trying to write.
  const pump = (async (): Promise<void> => {
    for await (const event of soldier.stream()) {
      events.push(event);
      if (event.type === 'error') errors.push(event.message);
      if (event.type === 'result') {
        if (event.costUsd !== undefined) costUsd = event.costUsd;
        if (isRecord(event.raw) && Array.isArray(event.raw['permission_denials'])) {
          denials.push(...(event.raw['permission_denials'] as unknown[]));
        }
      }
      try {
        archive.appendEvent(spec.agentId, event);
      } catch (error) {
        errors.push(
          `archive write failed for ${spec.agentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  })();

  try {
    await soldier.send(spec.orders);
  } catch (error) {
    errors.push(`send failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const close = await soldier.close();
  await pump;

  // Structured return. Codex hands it back as a file (`--output-schema` + `-o`); claude puts the
  // final text on the `result` event. The adapters absorb the asymmetry; this reads whichever
  // arrived, and falls back to the last assistant message for either.
  let structuredText: string | undefined;
  if (isCodexSoldier(soldier) && soldier.outputText !== null) {
    structuredText = soldier.outputText;
  }
  if (structuredText === undefined) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i] as SoldierEvent;
      if (event.type === 'result' && isRecord(event.raw)) {
        const text = event.raw['result'];
        if (typeof text === 'string' && text.trim() !== '') {
          structuredText = text;
          break;
        }
      }
    }
  }
  if (structuredText === undefined) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i] as SoldierEvent;
      if (event.type === 'assistant_text' && event.text.trim() !== '') {
        structuredText = event.text;
        break;
      }
    }
  }

  return {
    events,
    status: close.status,
    exitCode: close.exitCode,
    costUsd: costUsd ?? close.costUsd ?? null,
    durationMs: close.durationMs ?? null,
    structured: structuredText === undefined ? undefined : parseStructured(structuredText),
    denials,
    errors,
  };
}

// ---------------------------------------------------------------------------------------------
// Project resolution
// ---------------------------------------------------------------------------------------------

/**
 * The absolute path that keys `[projects]` in the global config.
 *
 * `--git-common-dir`, NOT `--show-toplevel`: a ceiling is keyed by one absolute path per
 * repository. Every Engineer works in a linked worktree, so keying on the worktree root would
 * give each one its own project entry and its own ceiling — the standard working environment of
 * every agent that writes code would be an escalation path.
 */
export async function resolveProjectRoot(cwd: string): Promise<string | null> {
  let result = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (result.code !== 0) {
    result = await runGit(['rev-parse', '--git-common-dir'], { cwd });
  }
  if (result.code !== 0) return null;
  const commonDir = result.stdout.trim().split('\n')[0] ?? '';
  if (commonDir === '') return null;
  const root = mainRootFromCommonDir(path.resolve(cwd, commonDir));
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

// ---------------------------------------------------------------------------------------------
// The campaign
// ---------------------------------------------------------------------------------------------

export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
  const env: Env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const home = options.home ?? armyHome(env);
  const notes: CampaignNote[] = [];
  /**
   * Flipped once `campaign-opened` has been narrated.
   *
   * Notes raised BEFORE that — the delivery-ceiling note is the only one — are held back from the
   * live stream rather than printed out of order in front of the line that says which campaign
   * this is. They are not lost: every note, at every level, is on the result and in the final
   * report. What the stream owes is the lifecycle, in order.
   */
  let opened = false;
  const note = (
    level: CampaignNote['level'],
    code: CampaignNoteCode,
    message: string,
    fix?: Fix,
  ): void => {
    notes.push({ level, code, message, ...(fix === undefined ? {} : { fix }) });
    // `info` notes are the running commentary the final report exists to collect; streaming them
    // too would bury the eight lifecycle lines a waiting reader is actually looking for.
    if (opened && level !== 'info') progress({ kind: 'note', level, message });
  };

  /**
   * Narrate one moment, and never let the narration be why a campaign ends.
   *
   * A listener is a terminal writer. `process.stdout.write` throws EPIPE when the reader has gone
   * — `army campaign … | head` is enough — and an exception here would unwind through the attempt
   * loop into the `finally`, which is the one path that settles a lease. A progress line is worth
   * less than a worktree, so it is worth exactly nothing when it fails.
   */
  const progress = (event: ProgressEvent): void => {
    if (options.onProgress === undefined) return;
    try {
      options.onProgress(event);
    } catch {
      /* narration is never load-bearing */
    }
  };

  const loaded = await loadConfig({ home, env });
  const config = loaded.config;

  const project = await resolveProjectRoot(cwd);
  if (project === null) {
    // Both halves of the fix, on purpose. `git init` alone lands you on the NEXT refusal — the
    // one this whole change exists because the Commander hit it ninety seconds later.
    throw new CampaignSetupError(
      `${cwd} is not inside a git repository. A campaign needs a repository to lease a worktree of.`,
      initRepoFix(cwd),
    );
  }

  const ceilingLookup = projectCeiling(config as DeliveryConfig, project);
  const ceiling = ceilingLookup.ceiling;
  const requestedRung = options.requestedRung ?? DEFAULT_REQUESTED_RUNG;
  note(
    ceilingLookup.source === 'project' ? 'info' : 'warn',
    'ceiling',
    `delivery ceiling for ${project} is ${ceiling} (${RUNG_LABEL[ceiling]}), from ${ceilingLookup.source}.`,
    // Only when it did NOT come from a deliberate per-project entry. Telling someone how to
    // change a setting they already chose is noise, and this line prints on every campaign.
    ceilingLookup.source === 'project' ? undefined : enlistCeilingFix(project, home),
  );

  // ---- the archive ----------------------------------------------------------------------
  const archiveRoot = config.archiveRoot;
  const campaignId = options.campaignId ?? uniqueCampaignId(archiveRoot, options.objective);
  const archiveConfig: ArchiveConfig = {
    archiveRoot,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.dbFactory === undefined ? {} : { dbFactory: options.dbFactory }),
  };
  const archive = createCampaign(archiveConfig, {
    id: campaignId,
    project,
    title: options.objective,
  });

  /**
   * Whether THIS run is the one entitled to write this campaign's terminal status.
   *
   * `createCampaign` is idempotent on purpose — re-attaching to a campaign after a crash must not
   * be destructive — so `--id` pointed at a campaign that has already been fought hands this run a
   * live handle to somebody else's finished record. The cleanup block below always ran
   * `setCampaignStatus`, unconditionally, which meant a second run that did NO WORK AT ALL (it
   * collides on `cpt-01` and aborts before a soldier exists) rewrote the first run's
   * `campaign.json` from `done` to `aborted` with a fresh `ended_at`. The files are truth and the
   * index is a rebuildable view of them; a run that wrote nothing must not be able to overwrite
   * what another run delivered.
   *
   * The test is the status the campaign had when this run ATTACHED, not whether the row was
   * freshly inserted, and that distinction is the whole point:
   *
   *   `active`  — either the row this call just inserted, or a campaign interrupted mid-flight.
   *               Both are ours to settle: closing out a crashed attempt and releasing its lease
   *               is exactly the re-attachment idempotence exists for, and it still works.
   *   anything  — `done` / `aborted` / `failed`. Somebody already ended this campaign and wrote
   *   else       the record. Nothing this run does may edit it.
   *
   * Note what is NOT skipped when this is false: the lease is still settled, the disposition is
   * still recorded as a signal, the task this run created is still closed, and the archive is
   * still closed. This run's own rows are its own to write. Only the campaign-level verdict —
   * the one row that belongs to the run that actually fought it — is left alone.
   */
  const settledBeforeThisRun = archive.getCampaign().status !== 'active';

  const task = archive.createTask({ title: options.objective, status: 'in_flight' });
  const branch = armyBranch(task.id);
  const orders: OriginalOrders = { objective: options.objective, project, taskId: task.id };

  archive.appendSignal({
    fromAgent: GENERAL_AGENT_ID,
    toSelector: 'chain',
    kind: 'broadcast',
    body: cap(`campaign opened: ${options.objective}`),
  });
  opened = true;
  progress({ kind: 'campaign-opened', campaignId, title: options.objective });
  for (const warning of loaded.warnings) {
    archive.appendSignal({
      fromAgent: GENERAL_AGENT_ID,
      kind: 'status',
      body: cap(`config: ${warning}`),
    });
  }

  // Mutable campaign state, so the `finally` block can settle the lease whatever happened.
  let lease: Lease | null = null;
  let provider: Awaited<ReturnType<typeof selectWorktreeProvider>>['provider'] | null = null;
  let leaseDisposition: LeaseDisposition = {
    state: 'never-acquired',
    path: null,
    leaseId: null,
    reason: 'no worktree was ever leased',
  };
  const attempts: AttemptRecord[] = [];
  let outcome: CampaignOutcome = 'aborted';
  let finalReport: Report | null = null;
  let finalVerdict: Verdict | null = null;
  /**
   * Whether this campaign ran out of Engineer attempts. Rung 3's second gate reads it.
   *
   * STATE, not an inference made at the delivery site. Today the exhausted branch below sets this
   * and immediately stops the campaign, so delivery only ever sees `false` — which is exactly why
   * writing `false` at the call site would be wrong. That would encode the current control flow as
   * a fact, and the next edit that lets an exhausted campaign reach delivery would merge it
   * without anything going red. Recorded where the budget is actually spent, the gate keeps
   * working through that edit instead of quietly dying in it.
   *
   * Note also what this is NOT: `attempt >= maxAttempts`. A PASS on the final attempt used the
   * whole budget and did not run out of it — the campaign finished. Exhausted means the campaign
   * stopped because there was nothing left to try.
   */
  let retriesExhausted = false;
  let delivery: LadderResult | null = null;
  let baseCommit: string | null = null;
  /** The status this campaign intends to record, then what the archive says it recorded. */
  let intendedStatus: CampaignStatus = 'aborted';

  const recordNoteSignals = (from: string, list: readonly { level: string; message: string }[]): void => {
    for (const item of list) {
      archive.appendSignal({
        fromAgent: from,
        toAgent: GENERAL_AGENT_ID,
        kind: 'status',
        body: cap(`${item.level}: ${item.message}`),
      });
    }
  };

  try {
    // ---- worktree ---------------------------------------------------------------------
    // `home` and `env` are threaded EXPLICITLY, and that is the whole point of these two lines.
    //
    // The worktree pool reads `<home>/config.toml` for its `post_create` lifecycle hooks, and a
    // hook is arbitrary command execution. `ColdWorktreeProviderOptions.home` defaults to
    // `$AGENTIC_ARMY_HOME` or `~/.agentic-army` — so a campaign that forwarded `home` to
    // `loadConfig` and nowhere else resolved its ceilings from the temp home and its HOOKS from
    // the developer's real one. Under `npm test` that meant the suite would run whatever
    // `post_create` the developer had configured, thirty-one times.
    //
    // Same shape as the review-gate blocker in `orders.ts`: a value the supervisor owns was
    // allowed to be defaulted from somewhere else. The supervisor knows its home. It passes it.
    //
    // The pool root is a SIBLING of the home (`~/.agentic-army-trees`), not `<archiveRoot>/
    // worktrees`. It used to be the latter, and that campaign could not do any work: every
    // worker's deny-list carries `protectedConfigGlobs(home)` as Read/Grep/Glob/Write/Edit
    // denies, so the Engineer was denied its own leased tree. The deny stays absolute — it is
    // what keeps the Inspector's brief independent of the Engineer's own report.md — so
    // the trees moved out instead, and the assertion below refuses to start if anything (an
    // override, an `archive_root` pointed back inside the home) puts them back.
    const worktreeRoot = options.worktreeRoot ?? worktreesRootFor(home);
    assertWorktreeRootOutsideProtected(worktreeRoot, home);
    const selection = await selectWorktreeProvider({
      cold: {
        root: worktreeRoot,
        home,
        env,
      },
      ...(options.worktreeProvider === undefined ? {} : { prefer: options.worktreeProvider }),
    });
    provider = selection.provider;
    note(selection.note.level, 'worktree-provider', selection.note.message);
    archive.appendSignal({
      fromAgent: GENERAL_AGENT_ID,
      kind: 'status',
      body: cap(`worktree provider: ${selection.selected} — ${selection.note.message}`),
    });

    const engineerCounter = { next: 1 };
    const nextAgentId = (): string => agentIdFor(engineerCounter.next++);

    try {
      lease = await provider.acquire(agentIdFor(1), project);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      note(
        'error',
        'aborted',
        `could not lease a worktree: ${message}`,
        await diagnoseAcquireFailure(error, project, home),
      );
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        kind: 'status',
        body: cap(`worktree acquisition failed: ${message}`),
      });
      outcome = 'aborted';
      throw new CampaignAborted(`could not lease a worktree of ${project}: ${message}`);
    }

    leaseDisposition = {
      state: 'retained',
      path: lease.path,
      leaseId: lease.leaseId,
      reason: 'campaign in flight',
    };
    progress({ kind: 'worktree-leased', provider: selection.selected, path: lease.path });
    const worktree = lease.path;
    baseCommit = (await runGit(['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim() || null;

    // ---- the attempt loop -------------------------------------------------------------
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    let previousVerdict: Verdict | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const engineerId = nextAgentId();
      const engineerOrders = renderEngineerOrders({
        orders,
        branch,
        worktree,
        attempt,
        ...(previousVerdict === undefined ? {} : { previousVerdict }),
      });

      const engineerTarget = dispatchFor(config, 'ENGINEER');
      const engineerSpec = buildSoldierSpec({
        agentId: engineerId,
        rank: 'CAPTAIN',
        role: 'ENGINEER',
        harness: engineerTarget.harness,
        ...(engineerTarget.model === undefined ? {} : { model: engineerTarget.model }),
        ...(engineerTarget.effort === undefined ? {} : { effort: engineerTarget.effort }),
        cwd: worktree,
        orders: engineerOrders,
        outputSchemaPath: REPORT_SCHEMA_PATH,
        home,
      });

      archive.recordAgentAttempt({
        id: engineerId,
        taskId: task.id,
        parentAgentId: null,
        rank: 'CAPTAIN',
        role: 'ENGINEER',
        harness: engineerSpec.harness,
        model: engineerSpec.model ?? null,
        effort: engineerSpec.effort ?? null,
        sessionId: engineerSpec.sessionId,
        depth: 1,
        status: 'running',
        worktreePath: worktree,
        leaseId: lease.leaseId,
        orders: engineerOrders,
        attempt,
      });
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        toAgent: engineerId,
        kind: 'order',
        body: cap(options.objective),
        artifact: `agents/${engineerId}/orders.md`,
      });
      // At DISPATCH time, not at the end: the hint is only worth printing while there is still
      // something to watch. It is emitted once — repeating it before every unit would turn the
      // one line that tells the reader what to do next into part of the noise.
      //
      // BEFORE the dispatch line, not after, and that ordering is load-bearing. The sink starts
      // its elapsed ticker on `unit-dispatched` and stops it on the next event of any kind, so a
      // hint emitted afterwards would silently cancel the ticker for the Engineer — the single
      // longest wait in the campaign, and the exact minutes this whole change exists to fill.
      if (attempt === 1) progress({ kind: 'watch-hint', campaignId });
      progress({
        kind: 'unit-dispatched',
        agentId: engineerId,
        rank: 'CAPTAIN',
        role: 'ENGINEER',
        harness: engineerSpec.harness,
        attempt,
      });

      const engineerRun = await runSoldier(
        adapterFor(options, engineerSpec.harness),
        engineerSpec,
        archive,
      );
      recordDenials(archive, engineerId, engineerRun.denials, note);

      const reportResult = validateReport(engineerRun.structured);
      const report = reportResult.ok ? reportResult.value : null;
      const record: AttemptRecord = {
        attempt,
        engineerAgentId: engineerId,
        inspectorAgentId: null,
        report,
        verdict: null,
        engineerStatus: engineerRun.status,
        costUsd: engineerRun.costUsd,
      };
      attempts.push(record);

      if (report !== null) {
        archive.writeReportJson(engineerId, report);
        archive.writeReportMd(engineerId, renderEngineerReportMd(engineerId, report));
      } else {
        archive.writeReportMd(
          engineerId,
          `# Report — ${engineerId}\n\nNo valid \`Report\` was returned.\n\n` +
            `**Adapter status:** ${engineerRun.status}\n\n` +
            (reportResult.ok
              ? ''
              : `**Schema errors:**\n\n${reportResult.errors.map((e) => `- ${e}`).join('\n')}\n\n`) +
            (engineerRun.errors.length === 0
              ? ''
              : `**Adapter errors:**\n\n${engineerRun.errors.map((e) => `- ${e}`).join('\n')}\n`),
        );
      }
      await writeDiffFor(archive, engineerId, worktree, branch, baseCommit);
      archive.finishAgent(engineerId, {
        status: engineerRun.status === 'ok' ? 'exited' : 'failed',
        exitCode: engineerRun.exitCode,
        costUsd: engineerRun.costUsd,
        durationMs: engineerRun.durationMs,
      });
      archive.appendSignal({
        fromAgent: engineerId,
        toAgent: GENERAL_AGENT_ID,
        kind: 'report',
        body: cap(report?.summary ?? `no valid report (${engineerRun.status})`),
        artifact: report === null ? null : `agents/${engineerId}/report.json`,
      });
      progress({
        kind: 'unit-returned',
        agentId: engineerId,
        rank: 'CAPTAIN',
        role: 'ENGINEER',
        status: engineerRun.status,
        // Model-controlled prose. `renderProgressEvent` sanitises and clips it; this hands over
        // the raw field rather than a pre-formatted line so the renderer stays the only place
        // that decides what a terminal is allowed to receive.
        summary: report?.summary ?? null,
      });

      if (report === null || engineerRun.status !== 'ok' || report.status !== 'done') {
        const why =
          report === null
            ? `returned no valid report (adapter status ${engineerRun.status})`
            : `reported status ${report.status}`;
        note(
          'error',
          'engineer',
          `${engineerId} ${why}. Not sending this to inspection.`,
          diagnoseSoldierFailure({
            role: 'Engineer',
            agentId: engineerId,
            harness: engineerSpec.harness,
            campaignRoot: archive.root,
            status: engineerRun.status,
            errors: engineerRun.errors,
            structuredArrived: report !== null,
          }),
        );
        finalReport = report;
        outcome = 'engineer-failed';
        break;
      }
      finalReport = report;
      archive.updateTask(task.id, { branch });

      // The Engineer claiming a branch other than the one it was told to cut is exactly the
      // "I could not do X so I did Y" signal, so the supervisor LOOKS at it — here, in its own
      // notes, capped, where the Inspector will never see it. It is not used to build anything.
      if (report.branch !== undefined && report.branch !== branch) {
        const claim = cap(report.branch, 120);
        note(
          'warn',
          'engineer',
          `${engineerId} reported branch ${JSON.stringify(claim)}, but it was told to cut ` +
            `${branch}. Reviewing ${branch} — the branch this supervisor issued — regardless.`,
        );
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          kind: 'status',
          body: cap(`branch mismatch: issued ${branch}, reported ${claim}`),
        });
      }

      // ---- THE REVIEW GATE ----------------------------------------------------
      //
      // The GENERAL spawns the Inspector, briefed from `orders` — the ORIGINAL objective, held
      // verbatim since the command line — plus `branch`, which THIS process cut via
      // `armyBranch(task.id)` before the Engineer existed.
      //
      // Note what is NOT here: `report`. `briefInspectorFromAttempt` has no parameter that can
      // receive it. That is not politeness — the previous version took the report and projected
      // it to a single "safe" field, and the projection had a hole: `Report.branch` is
      // model-controlled free text, so a hostile Engineer wrote a fake "SUPPLEMENTARY BRIEF FROM
      // THE GENERAL" into it and it reached the Inspector's orders.md and the codex argv. A
      // filter with one unclassified field is not a gate. See orders.ts.
      const inspectorId = nextAgentId();
      record.inspectorAgentId = inspectorId;
      const inspectorBrief = briefInspectorFromAttempt({
        orders,
        branch,
        worktree,
        ...(baseCommit === null ? {} : { baseCommit }),
        round: attempt,
      });

      const inspectorTarget = dispatchFor(config, 'INSPECTOR');
      const inspectorSpec = buildSoldierSpec({
        agentId: inspectorId,
        rank: 'CAPTAIN',
        role: 'INSPECTOR',
        harness: inspectorTarget.harness,
        ...(inspectorTarget.model === undefined ? {} : { model: inspectorTarget.model }),
        ...(inspectorTarget.effort === undefined ? {} : { effort: inspectorTarget.effort }),
        cwd: worktree,
        orders: inspectorBrief,
        outputSchemaPath: VERDICT_SCHEMA_PATH,
        home,
      });

      // Tasks nest. The review is a child task of the work, not a second attempt at it —
      // which is also what makes `army view` show the gate rather than hide it.
      const reviewTask = archive.createTask({
        parentTaskId: task.id,
        title: `review ${branch} (round ${String(attempt)})`,
        status: 'in_flight',
      });
      archive.recordAgentAttempt({
        id: inspectorId,
        taskId: reviewTask.id,
        parentAgentId: null,
        rank: 'CAPTAIN',
        role: 'INSPECTOR',
        harness: inspectorSpec.harness,
        model: inspectorSpec.model ?? null,
        effort: inspectorSpec.effort ?? null,
        sessionId: inspectorSpec.sessionId,
        depth: 1,
        status: 'running',
        worktreePath: worktree,
        leaseId: lease.leaseId,
        orders: inspectorBrief,
        attempt,
      });
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        toAgent: inspectorId,
        kind: 'order',
        body: cap(`review ${branch} against the original orders`),
        artifact: `agents/${inspectorId}/orders.md`,
      });
      progress({
        kind: 'unit-dispatched',
        agentId: inspectorId,
        rank: 'CAPTAIN',
        role: 'INSPECTOR',
        harness: inspectorSpec.harness,
        attempt,
      });

      const inspectorRun = await runSoldier(
        adapterFor(options, inspectorSpec.harness),
        inspectorSpec,
        archive,
      );
      recordDenials(archive, inspectorId, inspectorRun.denials, note);

      const verdictResult = validateVerdict(inspectorRun.structured);
      const verdict = verdictResult.ok ? verdictResult.value : null;
      record.verdict = verdict;
      if (verdict !== null) {
        archive.writeReportJson(inspectorId, {
          status: verdict.verdict === 'pass' ? 'done' : 'failed',
          summary: verdict.summary,
          findings: verdict.findings,
          artifacts: [{ kind: 'branch', ref: branch }],
        });
        archive.writeReportMd(inspectorId, renderVerdictMd(inspectorId, verdict));
      } else {
        archive.writeReportMd(
          inspectorId,
          `# Verdict — ${inspectorId}\n\nNo valid \`Verdict\` was returned.\n\n` +
            `**Adapter status:** ${inspectorRun.status}\n\n` +
            (verdictResult.ok
              ? ''
              : `**Schema errors:**\n\n${verdictResult.errors.map((e) => `- ${e}`).join('\n')}\n\n`) +
            (inspectorRun.errors.length === 0
              ? ''
              : `**Adapter errors:**\n\n${inspectorRun.errors.map((e) => `- ${e}`).join('\n')}\n`),
        );
      }
      archive.finishAgent(inspectorId, {
        status: inspectorRun.status === 'ok' ? 'exited' : 'failed',
        exitCode: inspectorRun.exitCode,
        costUsd: inspectorRun.costUsd,
        durationMs: inspectorRun.durationMs,
      });
      archive.appendSignal({
        fromAgent: inspectorId,
        toAgent: GENERAL_AGENT_ID,
        kind: 'report',
        body: cap(verdict === null ? `no valid verdict (${inspectorRun.status})` : `${verdict.verdict}: ${verdict.summary}`),
        artifact: verdict === null ? null : `agents/${inspectorId}/report.json`,
      });

      archive.updateTask(reviewTask.id, {
        status: verdict === null ? 'failed' : 'done',
        branch,
      });
      if (verdict !== null) {
        progress({
          kind: 'verdict',
          agentId: inspectorId,
          rank: 'CAPTAIN',
          role: 'INSPECTOR',
          verdict: verdict.verdict,
          testsRun: verdict.testsRun,
          summary: verdict.summary,
        });
      }
      // A reviewer that returned nothing is narrated by the error note below, not by a `verdict`
      // event: the review gate fails CLOSED, and printing a verdict line for a verdict that does
      // not exist is the one shape of this stream that could mislead.

      if (verdict === null) {
        // A reviewer that produced nothing usable is NOT a pass. The Inspector runs on a
        // different vendor precisely so the gate is independent; treating its absence as
        // approval would make the gate a formality that fails open.
        const detail = inspectorRun.errors[0] ?? `adapter status ${inspectorRun.status}`;
        note(
          'error',
          'inspector',
          `${inspectorId} produced no usable verdict (${detail}). Refusing to deliver unreviewed ` +
            'work — the review gate fails CLOSED.',
          diagnoseSoldierFailure({
            role: 'Inspector',
            agentId: inspectorId,
            harness: inspectorSpec.harness,
            campaignRoot: archive.root,
            status: inspectorRun.status,
            errors: inspectorRun.errors,
            structuredArrived: false,
          }),
        );
        outcome = 'inspector-unavailable';
        break;
      }

      finalVerdict = verdict;
      if (verdict.verdict === 'pass') {
        note('info', 'inspector', `${inspectorId} PASSED ${branch}: ${cap(verdict.summary, 120)}`);
        outcome = 'delivered';
        break;
      }

      note('warn', 'inspector', `${inspectorId} FAILED ${branch}: ${cap(verdict.summary, 120)}`);
      previousVerdict = verdict;
      if (attempt >= maxAttempts) {
        // Recorded BEFORE the note and the break, so the flag is true from the instant the fact
        // is true rather than from the instant something happens to read it.
        retriesExhausted = true;
        note(
          'error',
          'retry',
          `the Inspector failed ${String(maxAttempts)} attempt(s); the retry budget (a CPT may ` +
            'retry an Inspector fail) is exhausted. Not delivering.',
          // Deliberately not `--attempts N`. A reviewer that rejected the work every time is
          // making a judgement about the work, and handing the reader a knob that reruns the
          // same thing harder is the "fix that does not fix" this sweep is about.
          noFix(
            'the Inspector rejected the work on every attempt — that is a verdict, not an ' +
              `environment fault, so there is nothing to run. Its findings are in ${archive.root}` +
              '/agents/*/report.md; the branch is durable and can be picked up by hand.',
          ),
        );
        outcome = 'inspector-failed';
        break;
      }
      note('info', 'retry', `retrying with a fresh Engineer against the same task.`);
      archive.updateTask(task.id, { agentId: null, status: 'in_flight' });
    }

    // ---- delivery ---------------------------------------------------------------------
    if (outcome === 'delivered' && finalVerdict !== null) {
      try {
        delivery = await runLadder({
          taskId: task.id,
          project,
          requested: requestedRung,
          config: config as DeliveryConfig,
          branch,
          worktree,
          verdict: finalVerdict,
          // Rung 3's evidence. Supplied on EVERY delivery, not only when rung 3 was requested:
          // the ladder reads it if and only if the clamped plan is rung 3, so gating it here
          // would put the decision of whether the gate runs in two places instead of one.
          merge: mergeEvidence(finalReport, retriesExhausted),
          ...(options.ghProbe === undefined ? {} : { ghProbe: options.ghProbe }),
          ...(options.ghBinary === undefined ? {} : { ghBinary: options.ghBinary }),
        });
        for (const deliveryNote of delivery.notes) {
          note(
            deliveryNote.level,
            deliveryNote.code === 'clamped' ? 'clamped' : 'delivery',
            deliveryNote.message,
            // Keyed on the TYPED code the ladder already emits, never on its prose. `ladder.ts`
            // is another unit's file and its wording is free to change; `DeliveryNoteCode` is the
            // contract between us.
            fixForDeliveryNote(deliveryNote.code, { project, objective: options.objective, home }),
          );
        }
        recordNoteSignals(GENERAL_AGENT_ID, delivery.notes as readonly DeliveryNote[]);
        progress({
          kind: 'delivered',
          rung: delivery.delivered,
          url: delivery.pr?.url ?? delivery.durability.target.url ?? null,
        });
        archive.updateTask(task.id, {
          status: 'done',
          deliveredRung: delivery.delivered,
          prUrl: delivery.pr?.url ?? null,
          branch,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        note(
          'error',
          'delivery',
          `delivery failed: ${message}`,
          diagnoseDeliveryFailure(error, { project, objective: options.objective, home }),
        );
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          kind: 'status',
          body: cap(`delivery failed: ${message}`),
        });
        outcome = 'delivery-failed';
        archive.updateTask(task.id, { status: 'failed', branch });
      }
    }
  } catch (error) {
    if (!(error instanceof CampaignAborted)) {
      const message = error instanceof Error ? error.message : String(error);
      note('error', 'aborted', `campaign aborted: ${message}`, diagnoseAbort(error, archive.root));
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        kind: 'status',
        body: cap(`campaign aborted: ${message}`),
      });
    }
    if (outcome === 'delivered') outcome = 'aborted';
  } finally {
    // ===========================================================================================
    // CLEANUP. A cleanup path that can throw is a cleanup path that does not run.
    //
    // Every step below is INDIVIDUALLY guarded, and this is not defensive habit — review forced
    // the failure by deleting a leased worktree's `.git` after the Engineer had committed.
    // `inspectUnlandedWork` calls `git()`, which throws on a non-zero exit; it was the one call
    // in here that was not wrapped; `runCampaign` rejected out of its own `finally`; and the
    // result was the state this module's own types say cannot exist — a lease neither released
    // nor marked retained, a pool slot held forever, `setCampaignStatus` and `close()` never
    // reached, and `campaign.json` frozen at `status: "active"`.
    //
    // So: the disposition is always decided, the archive is always closed, and a step that fails
    // becomes a note rather than an escape hatch.
    // ===========================================================================================
    const guard = (what: string, fn: () => void): void => {
      try {
        fn();
      } catch (error) {
        note(
          'error',
          'aborted',
          `${what} failed during cleanup: ${error instanceof Error ? error.message : String(error)}`,
          // Every one of these is a write to the SQLite index, and the files are truth — so
          // there IS an exact command, and this is the one place where the durability note below
          // is more than trivia.
          runThis(`${invokedAs()} rebuild ${quoteArg(campaignId)}`),
        );
      }
    };

    // ---- durability, then the lease. Never the other way round. -----------------
    if (lease !== null && provider !== null) {
      try {
        leaseDisposition = await settleLease({
          archive,
          provider,
          lease,
          branch,
          project,
          archiveRoot,
          baseCommit,
          alreadyDurable: delivery !== null,
          note,
        });
      } catch (error) {
        // settleLease guards its own steps; this is the backstop for anything it did not
        // anticipate. Fail closed: a tree whose state we could not determine is HELD.
        const message = error instanceof Error ? error.message : String(error);
        const reason =
          `settling the lease threw (${message}), so the tree is held rather than reset. ` +
          'Leaking a worktree is recoverable; destroying a night\'s work is not.';
        note('error', 'lease', `${reason} Worktree RETAINED at ${lease.path}.`, retainedTreeFix(lease.path));
        leaseDisposition = {
          state: 'retained',
          path: lease.path,
          leaseId: lease.leaseId,
          reason,
        };
      }
    }

    guard('recording the lease disposition', () =>
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        kind: 'status',
        body: cap(`lease ${leaseDisposition.state}: ${leaseDisposition.reason}`),
        artifact: leaseDisposition.path,
      }),
    );
    // The last lifecycle line, and the one a reader most needs on a campaign that ended badly:
    // whether the tree was returned or is being held with their work still in it.
    progress({
      kind: 'lease-settled',
      state: leaseDisposition.state,
      path: leaseDisposition.path,
      reason: leaseDisposition.reason,
    });
    guard('closing the task', () => {
      if (outcome !== 'delivered' && archive.getTask(task.id)?.status === 'in_flight') {
        archive.updateTask(task.id, {
          status: outcome === 'aborted' ? 'blocked' : 'failed',
          branch,
        });
      }
    });
    intendedStatus = outcome === 'delivered' ? 'done' : outcome === 'aborted' ? 'aborted' : 'failed';
    // Only for a campaign this run is entitled to close. See `settledBeforeThisRun`: a campaign
    // that had already ended before this run attached keeps the verdict of the run that earned it.
    if (!settledBeforeThisRun) {
      guard('closing the campaign', () => archive.setCampaignStatus(intendedStatus));
    }
    // Read it back so the result reports what the archive actually says — which for a campaign
    // this run left alone is the OTHER run's status, and that is the honest answer: `status` is
    // the campaign's, `outcome` is this run's. Never let that read be the reason a campaign has
    // no result at all.
    guard('reading back the campaign status', () => {
      intendedStatus = archive.getCampaign().status;
    });
    guard('closing the archive', () => archive.close());
  }

  const campaignRoot = archive.root;
  const finalStatus = intendedStatus;
  const deliveredRung = delivery?.delivered ?? null;

  // `outcome === 'delivered'` alone was enough while the only error-level DELIVERY note came from
  // `runLadder` throwing, which also set `outcome = 'delivery-failed'`. Rung 3 broke that pairing:
  // `merge-uncertain` is delivered — the pull request really is merged — AND an error, because
  // the command that merged it failed afterwards and a human has to go and look. Exiting 0 there
  // would tell a script everything is fine while the note on screen says it is not, which is the
  // safe-sounding half of "I could not do X so I did Y".
  const deliveryFailedLoudly = notes.some((n) => n.level === 'error' && n.code === 'delivery');
  const exitCode = outcome === 'delivered' && !deliveryFailedLoudly ? 0 : 1;
  return {
    campaignId,
    campaignRoot,
    project,
    taskId: task.id,
    branch,
    status: finalStatus,
    outcome,
    attempts,
    report: finalReport,
    verdict: finalVerdict,
    requestedRung,
    ceiling,
    deliveredRung,
    retriesExhausted,
    delivery,
    lease: leaseDisposition,
    notes,
    exitCode,
  };
}

/** Thrown to unwind to the `finally` without also logging a second "aborted" note. */
class CampaignAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignAborted';
  }
}

/**
 * A refusal that happens BEFORE there is a campaign to put a note on, carrying its own fix.
 *
 * `runCampaign` throws this when it cannot even open an archive — no repository, so no project
 * key, no campaign id, no `campaign.json`. There is nowhere to hang a `CampaignNote`, and the
 * message reaches the user through `campaignCommand`'s catch and nothing else. Carrying the `Fix`
 * on the error is what keeps that path inside the same contract as every other refusal, rather
 * than being the one place a bare sentence escapes.
 */
export class CampaignSetupError extends Error {
  readonly fix: Fix;
  constructor(message: string, fix: Fix) {
    super(message);
    this.name = 'CampaignSetupError';
    this.fix = fix;
  }
}

// ---------------------------------------------------------------------------------------------
// Diagnosis — what to DO about each way this can end
// ---------------------------------------------------------------------------------------------
//
// Every function here answers one question: is there a command that removes this condition?
//
// Two rules, and they are the whole discipline:
//
//   1. ASK, DO NOT PATTERN-MATCH. `diagnoseAcquireFailure` gets a message string it could regex
//      for "has no commits" — and pattern-matching is how you ship a classifier
//      that works for the spellings you thought of. It runs `git rev-parse --verify HEAD`
//      instead: the real question, answered by the thing that owns the answer. Everything else
//      keys off a TYPED error or a typed code.
//
//   2. `noFix` IS AN ANSWER. A crashed model is not an environment fault; pointing it at
//      `army doctor` would produce a clean report and leave the reader doubting the diagnosis
//      rather than the crash. Where nothing resolves it, say so and say where the evidence is.

/** The tree is HELD, which means nothing was destroyed — say where the work is. */
function retainedTreeFix(worktree: string): Fix {
  const q = quoteArg(worktree);
  return doThis(
    `nothing was destroyed — the work is still in ${worktree}. Inspect it with ` +
      `\`git -C ${q} status\` and \`git -C ${q} log --oneline\`, then commit or discard it. ` +
      'The pool will not hand that slot out again while the lease is held.',
  );
}

/**
 * `--id` pointed at a campaign that already has an agent under the id this run is minting.
 *
 * Keyed on `AgentIdInUseError`, which `src/archive/archive.ts` exports for precisely this — the
 * layer that owes the reader a `fix:` line has to be able to RECOGNISE the condition, and
 * recognising it by matching the words in the message would make every rewording of them a silent
 * regression. Shared by `campaign` and by `chat` because it is one condition with one answer; the
 * only thing that differs is which subcommand the reader types again.
 *
 * `manual`, and both of the other two kinds are wrong here for a stated reason:
 *
 *   not `none`     — `none` is a positive claim that NOTHING removes the condition. Something
 *                    does: run again under a campaign id no campaign has used. Saying "no fix" to
 *                    a reader who is one flag away from succeeding is the dishonest half of a
 *                    diagnosis that already knows the answer.
 *   not `command`  — the one missing value is WHICH id, and that is the reader's to choose; a
 *                    line we could paste would have to invent it. A `command` also promises that
 *                    running it verbatim clears the condition, and the only such line here starts
 *                    a whole fresh campaign — minutes of model time — which is not something to
 *                    hand someone as a paste-and-run.
 */
export function agentIdInUseFix(error: AgentIdInUseError, subcommand: 'campaign' | 'chat'): Fix {
  return doThis(
    `re-run \`${invokedAs()} ${subcommand}\` under a campaign id nothing has used yet — pass a ` +
      `different \`--id\`, or drop \`--id\` and one is minted for you. Campaign ${error.campaignId} ` +
      `already holds ${error.agentId} from an attempt that started ${error.startedAt}; it keeps ` +
      `its own record, and \`${invokedAs()} view ${quoteArg(error.campaignId)}\` reads it back.`,
  );
}

/**
 * What to do about a campaign that ended in the outer catch, whatever threw.
 *
 * The `none` branch is the honest answer for a genuinely undiagnosed throw and stays. What it may
 * NOT do is absorb errors that arrive carrying a diagnosis — it used to swallow every non-setup
 * error, and `AgentIdInUseError` walked straight into it: a condition with a known cause, a known
 * reason no retry helps, and a known way out, printed under "nothing here is a command worth
 * pasting". `none` is a positive claim, so a `none` that is not true is a worse lie than silence.
 *
 * Ordered by specificity, and every branch keys on a TYPE. New diagnosable throws are added here;
 * the `none` at the end shrinks as they are.
 */
function diagnoseAbort(error: unknown, campaignRoot: string): Fix {
  if (error instanceof CampaignSetupError) return error.fix;
  if (error instanceof AgentIdInUseError) return agentIdInUseFix(error, 'campaign');
  return noFix(
    'the campaign hit a failure it does not have a diagnosis for, so nothing here is a ' +
      `command worth pasting. What it managed to write is in ${campaignRoot}.`,
  );
}

/** Set (or change) this project's delivery ceiling. Needs a terminal to RAISE — hence `manual`. */
function enlistCeilingFix(project: string, home: string): Fix {
  return doThis(
    `run \`${invokedAs()} enlist --ceiling N\` from inside ${project} (raising needs a real ` +
      `terminal), or add the entry to ${configPath(home)} by hand.`,
  );
}

/**
 * Why the pool could not hand out a tree, and what to type about it.
 *
 * The interesting case is the one the Commander hit: `git init` with no commit. `cold.ts` reports
 * it as prose inside a `ColdWorktreeError`, so rather than matching that prose we ask git whether
 * the repository has a HEAD at all — which is both the actual precondition and immune to `cold.ts`
 * rewording its message.
 */
async function diagnoseAcquireFailure(error: unknown, project: string, home: string): Promise<Fix> {
  const head = await runGit(headExistsArgs(project), { cwd: project });
  if (head.code !== 0) {
    return initialCommitFix(project);
  }
  if (error instanceof PoolExhaustedError) {
    return doThis(
      `wait for a campaign on ${project} to finish and release its tree, or raise \`max_trees\` ` +
        `under \`[worktree]\` in ${configPath(home)}.`,
    );
  }
  // Anything else here is git or the filesystem refusing — `worktree add` failing, the pool root
  // unwritable, a git too old for `worktree`. All three are exactly what doctor checks, and
  // doctor then owes the exact command.
  return doctorFix();
}

interface SoldierFailure {
  role: 'Engineer' | 'Inspector';
  agentId: string;
  harness: HarnessId;
  campaignRoot: string;
  status: string;
  errors: readonly string[];
  /** Whether a schema-valid structured return arrived at all. */
  structuredArrived: boolean;
}

/**
 * A worker that did not come back with something usable.
 *
 * The one genuinely environmental sub-case is separated structurally, not by reading the error
 * text: the harness adapter reports `spawn-failed` when the binary could not be started at all,
 * and THAT has an install command behind it. Everything else — a crash mid-run, a model that
 * answered off-schema, a worker that reported `blocked` — is the model's behaviour, not this
 * machine's, and gets `noFix` naming the transcript. That is the case the brief called out
 * explicitly, and it is where inventing `army doctor` would do active harm.
 */
function diagnoseSoldierFailure(failure: SoldierFailure): Fix {
  const { agentId, campaignRoot, role, status } = failure;
  const spawnFailed =
    status === 'spawn-failed' || failure.errors.some((e) => /\bENOENT\b|spawn .* ENOENT/.test(e));
  if (spawnFailed) {
    const hint = installHint(failure.harness === 'codex' ? 'codex' : 'claude');
    return runThis(hint === '' ? `${invokedAs()} doctor` : hint);
  }
  if (failure.structuredArrived) {
    return noFix(
      `the ${role} stopped deliberately and said why — that is a decision, not a fault this ` +
        `machine can clear. Its reasons are in ${campaignRoot}/agents/${agentId}/report.md.`,
    );
  }
  return noFix(
    `the ${role} process ended \`${status}\` without a usable return. Nothing about this machine ` +
      `is implicated, so there is no command to run. Its full transcript is in ` +
      `${campaignRoot}/agents/${agentId}/stream.jsonl.`,
  );
}

/**
 * The evidence rung 3 requires from this call site, read off the campaign's own state.
 *
 * Exported so a test can hold the derivation still and check it, rather than only observing the
 * merge that happens to come out the other end. Both arguments are values the campaign tracked as
 * it ran; NEITHER field is a literal, and the reason is worth stating once in the place it
 * applies. `runLadder` refuses a merge when the Engineer is not `done` or the retry budget is
 * spent. If this function answered `'done'` and `false` unconditionally, both refusals would be
 * unreachable from here — the checks would still be in `ladder.ts`, still read as protection, and
 * protect nothing, which is strictly worse than not having them, because a dead gate is a gate
 * everyone stops thinking about.
 *
 * A missing report is the interesting case. It cannot happen on today's delivery path — a
 * campaign only reaches delivery through a `done` report and a PASS — but "cannot happen" is a
 * claim about control flow, and this function's job is to be right without one. No report means
 * no Engineer status, and an absent status is not a `done` status: it is reported as `failed`,
 * which refuses. Evidence that is missing is never read as good news.
 */
export function mergeEvidence(report: Report | null, retriesExhausted: boolean): MergeRequest {
  return { engineerStatus: report?.status ?? 'failed', retriesExhausted };
}

interface DeliveryContext {
  project: string;
  objective: string;
  home: string;
}

/** Re-run this exact campaign, capped at a rung that exists. */
function rerunAtRung(ctx: DeliveryContext, rung: Rung): Fix {
  return runThis(
    `${invokedAs()} campaign ${quoteArg(ctx.objective)} --rung ${String(rung)}`,
  );
}

/**
 * A fix for each note the ladder can emit, keyed on its typed `DeliveryNoteCode`.
 *
 * `info` codes get nothing: "opened <url>" is not a problem and a fix line under it would train
 * the reader to skim past the ones that are.
 */
function fixForDeliveryNote(code: DeliveryNoteCode, ctx: DeliveryContext): Fix | undefined {
  switch (code) {
    case 'ceiling-missing':
    case 'ceiling-default':
    case 'clamped':
      return enlistCeilingFix(ctx.project, ctx.home);
    case 'rung-unimplemented':
      return rerunAtRung(ctx, 2);
    case 'no-origin':
      return doThis(
        `give ${ctx.project} an \`origin\` to push to — \`git -C ${quoteArg(ctx.project)} remote ` +
          'add origin <url>\` — or leave it at rung 0, where the army mirror already holds the work.',
      );
    case 'gh-unavailable': {
      const hint = installHint('gh');
      return hint.startsWith('http') ? doThis(`install the GitHub CLI: ${hint}`) : runThis(hint);
    }
    case 'gh-unauthenticated':
      return runThis('gh auth login');
    case 'review-not-posted':
      return doThis(
        'the pull request is open but carries no Inspector review — post the verdict from ' +
          '`report.md` on it by hand, or re-run once `gh` can write reviews.',
      );
    // ---- rung 3 ------------------------------------------------------------------------
    //
    // Keyed on the code, like everything above it, so the ladder's prose stays free to change.
    // That means ONE fix has to serve every reason behind `merge-refused` — there are eight of
    // them and they share no command — so it points at the note it sits directly under, which
    // names the gate and is rendered on the line above. What it must not do is offer a re-run:
    // every refusal reason is a fact about this campaign's work, and running the same campaign
    // again changes none of them.
    case 'merge-refused':
      return doThis(
        'nothing merged, and nothing is broken. A gate in this process said no and the note ' +
          'above names which one — the pull request is open with the Inspector verdict on it, ' +
          'exactly as rung 2 leaves it. Read the reason, decide whether you agree, and merge it ' +
          'yourself if you do. Re-running the campaign will reach the same gate.',
      );
    case 'merge-blocked':
      return doThis(
        `the remote refused the merge and the note above quotes it verbatim. That is the host's ` +
          'answer — branch protection, a required check still running or failed, a required ' +
          'review, or a conflict with the base branch. Resolve it on the pull request itself; ' +
          'nothing here can, and nothing here will force it.',
      );
    case 'merge-uncertain':
      return doThis(
        'the pull request is MERGED and the command that merged it failed afterwards, so this ' +
          'campaign cannot say what else did or did not happen. Look before you act: check the ' +
          'base branch has the commit named in the note above, and check whether the branch was ' +
          'deleted. Do NOT re-run this campaign against that pull request — a second merge is ' +
          'the one outcome worth avoiding here.',
      );
    // `merge-planned` announces an intention, `merged` and `merge-noop` an accomplished one.
    // None is a problem, and a fix line under a success trains the reader to skim past the ones
    // that are.
    case 'merge-planned':
    case 'merged':
    case 'merge-noop':
    case 'durability-mirror':
    case 'pr-opened':
    case 'review-posted':
      return undefined;
    default: {
      // `DeliveryNoteCode` is the contract between this file and `ladder.ts`, and a contract that
      // only one side is obliged to satisfy is a wish. A new code added there stops compiling
      // here until it has been given a fix — or explicitly listed above as one that needs none —
      // which is the whole reason this table keys on the code and not on the message.
      const unhandled: never = code;
      void unhandled;
      return undefined;
    }
  }
}

/** `runLadder` threw. Only `RungNotImplementedError` has a command behind it. */
function diagnoseDeliveryFailure(error: unknown, ctx: DeliveryContext): Fix {
  if (error instanceof RungNotImplementedError) return rerunAtRung(ctx, 2);
  if (error instanceof DurabilityError) {
    return noFix(
      'delivery refused to run because the work could not be made durable first. The ' +
        'worktree is retained — see the lease note below for where it is.',
    );
  }
  return doctorFix();
}

// ---------------------------------------------------------------------------------------------
// Lease settlement — the one thing every exit path shares
// ---------------------------------------------------------------------------------------------

interface SettleLeaseInput {
  archive: CampaignArchive;
  provider: { release(lease: Lease, opts?: { force?: boolean }): Promise<void>; id: string };
  lease: Lease;
  branch: string;
  project: string;
  archiveRoot: string;
  /** Commit the tree was handed out at. Anything past it belongs to this lease. */
  baseCommit: string | null;
  /** True when `runLadder` already pushed. Durability is not repeated. */
  alreadyDurable: boolean;
  note: (level: CampaignNote['level'], code: CampaignNoteCode, message: string, fix?: Fix) => void;
}

/**
 * Make the work durable, then return the tree — or keep the tree and say so.
 *
 * DURABILITY IS UNCONDITIONAL AND RUNS ON FAILURE PATHS TOO. An Inspector-failed branch is still
 * work; rung 0 means "your repo untouched", not "discard it". So even a campaign that
 * ends badly pushes its branch to the army mirror before anything destructive happens.
 *
 * If durability cannot be established — a dirty tree, no branch, a push that fails — the lease is
 * RETAINED, deliberately, with the reason recorded. Leaking a worktree is recoverable; destroying
 * a night's work is not.
 */
async function settleLease(input: SettleLeaseInput): Promise<LeaseDisposition> {
  const { archive, provider, lease, branch, project, archiveRoot, note } = input;

  if (!input.alreadyDurable) {
    // Is there anything here worth protecting? A crashed Engineer that never cut a branch leaves
    // a clean tree, and holding one of those is not caution — it is a leaked worktree dressed up
    // as one. `inspectUnlandedWork` is the provider's own predicate, so the question this asks is
    // exactly the question `release` will ask before it refuses.
    //
    // IT CALLS `git()`, WHICH THROWS ON A NON-ZERO EXIT. A worktree whose `.git` has gone, a
    // corrupt index, a disk that filled — any of them lands here. Unwrapped, this one call threw
    // straight out of `runCampaign`'s `finally` and the lease was never settled at all. Wrapped,
    // an indeterminate tree fails CLOSED: we cannot prove it is empty, so we keep it.
    let unlanded: Awaited<ReturnType<typeof inspectUnlandedWork>>;
    try {
      unlanded = await inspectUnlandedWork(lease.path, input.baseCommit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason =
        `could not determine whether ${lease.path} holds unlanded work (${message}). ` +
        'Releasing runs `reset --hard` + `clean -fdx`, so a tree whose contents cannot be ' +
        'established is held, not destroyed.';
      note('error', 'lease', `${reason} Worktree RETAINED.`, retainedTreeFix(lease.path));
      return { state: 'retained', path: lease.path, leaseId: lease.leaseId, reason };
    }

    if (!unlanded.unlanded) {
      note(
        'info',
        'durability',
        `${lease.path} holds nothing that a release would destroy — no branch commits, no dirty ` +
          'files. Nothing to make durable.',
      );
      return releaseLease(input, 'the tree held no unlanded work');
    }

    try {
      const target = await resolveDurabilityTarget({ project, archiveRoot, allowOrigin: false });
      const result = await ensureDurable({
        worktree: lease.path,
        branch,
        project,
        archiveRoot,
        target,
      });
      note(
        'info',
        'durability',
        `${branch} is durable at ${result.target.kind} ${result.target.url} (${result.commit.slice(0, 12)}).`,
      );
      // The work is already durable at this point. An archive write that fails must not undo
      // that fact by throwing us onto the retain path.
      try {
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          kind: 'status',
          body: cap(`durable: ${branch} -> ${result.target.url}`),
        });
      } catch (error) {
        note(
          'warn',
          'durability',
          `${branch} is durable but the signal row could not be written: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason =
        error instanceof DurabilityError
          ? `durability failed, so the tree is held rather than reset: ${message}`
          : `durability could not be established: ${message}`;
      note('error', 'lease', `${reason} Worktree RETAINED at ${lease.path}.`, retainedTreeFix(lease.path));
      return { state: 'retained', path: lease.path, leaseId: lease.leaseId, reason };
    }
  }

  return releaseLease(input, 'work is durable; the tree was returned to the pool');
}

/**
 * Return the tree, or keep it and say why.
 *
 * The provider is fail-closed and refuses to destroy unlanded work. A refusal here is
 * therefore a SECOND opinion on the durability step above, from the code that owns the tree — and
 * it wins, because it is the one about to run `reset --hard` + `clean -fdx`.
 */
async function releaseLease(input: SettleLeaseInput, why: string): Promise<LeaseDisposition> {
  const { lease, note, provider } = input;
  try {
    await provider.release(lease);
    note('info', 'lease', `worktree released: ${lease.path}`);
    return { state: 'released', path: lease.path, leaseId: lease.leaseId, reason: why };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      error instanceof UnlandedWorkError
        ? `the provider refused to release: ${message}`
        : `release failed: ${message}`;
    note('error', 'lease', `${reason} Worktree RETAINED at ${lease.path}.`, retainedTreeFix(lease.path));
    return { state: 'retained', path: lease.path, leaseId: lease.leaseId, reason };
  }
}

// ---------------------------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------------------------

/** A denied action writes a signal row — a permission denial IS a ceiling breach. */
function recordDenials(
  archive: CampaignArchive,
  agentId: string,
  denials: readonly unknown[],
  note: (level: CampaignNote['level'], code: CampaignNoteCode, message: string) => void,
): void {
  for (const denial of denials) {
    const body = cap(typeof denial === 'string' ? denial : JSON.stringify(denial));
    archive.appendSignal({
      fromAgent: agentId,
      toAgent: GENERAL_AGENT_ID,
      kind: 'status',
      body: `permission denied: ${body}`,
    });
    note('warn', 'permission-denied', `${agentId} was denied: ${body}`);
  }
}

/** `git diff <base>..<branch>` into `diff.patch`. Best effort — a missing diff is not a failure. */
async function writeDiffFor(
  archive: CampaignArchive,
  agentId: string,
  worktree: string,
  branch: string,
  baseCommit: string | null,
): Promise<void> {
  const range = baseCommit === null ? branch : `${baseCommit}..${branch}`;
  const result = await runGit(['diff', '--no-color', range], { cwd: worktree });
  archive.writeDiff(
    agentId,
    result.code === 0
      ? result.stdout
      : `# no diff available for ${range}\n# git exited ${String(result.code)}\n${result.stderr}\n`,
  );
}

/**
 * The static vendor split, read from the config's `rules[]` with the built-in default as
 * the fallback. Deliberately dumb: v1 matches by role, not by natural language, and the rules
 * array exists so the upgrade to quota-resolved candidates is a config change, not a rewrite.
 */
function dispatchFor(
  config: { dispatch: { rules: { when: string; use: { harness: HarnessId; model?: string; effort?: ReasoningEffort }[] }[] } },
  role: Role,
): { harness: HarnessId; model?: string; effort?: ReasoningEffort } {
  const wanted = role === 'INSPECTOR' ? 'codex' : 'claude';
  for (const rule of config.dispatch.rules) {
    const target = rule.use[0];
    if (target !== undefined && target.harness === wanted) return target;
  }
  return { harness: wanted };
}

function adapterFor(options: CampaignOptions, harness: HarnessId): HarnessAdapter {
  const injected = options.adapters?.[harness];
  if (injected !== undefined) return injected;
  if (harness === 'claude' && options.claudeBin !== undefined) {
    return createClaudeAdapter({ bin: options.claudeBin });
  }
  if (harness === 'codex' && options.codexBin !== undefined) {
    const codexOptions: { bin: string; timeoutMs?: number } = { bin: options.codexBin };
    if (options.timeoutMs !== undefined) codexOptions.timeoutMs = options.timeoutMs;
    return createCodexAdapter(codexOptions);
  }
  return getAdapter(harness);
}

/**
 * A campaign id that is not already taken.
 *
 * `createCampaign` is idempotent for an existing id — deliberately, so re-attaching after a crash
 * is not destructive — which means two campaigns with the same objective on the same day would
 * silently share a directory and interleave their agents. Suffix instead.
 */
function uniqueCampaignId(archiveRoot: string, title: string): string {
  const base = campaignIdFor(title);
  const taken = new Set(listCampaignIds(archiveRoot).map((id) => id.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}`;
}
