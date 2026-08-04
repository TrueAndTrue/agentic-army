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
 * - The default requested rung is **2**, not the project ceiling. Rung 3 refuses by design
 *   (`RungNotImplementedError`), so defaulting to a ceiling of 3 would make every campaign on a
 *   fully-trusted project fail at the last step. Defaulting to 2 and clamping is the honest
 *   reading of the v1 scope's "rungs 0–2"; `--rung 3` still refuses, loudly, because that
 *   request is explicit.
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

import { CampaignArchive, campaignIdFor, createCampaign, listCampaignIds } from '../archive/archive.ts';
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
import type { DeliveryConfig, DeliveryNote, DeliveryNoteCode, LadderResult } from '../delivery/ladder.ts';
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
  delivery: LadderResult | null;
  lease: LeaseDisposition;
  notes: CampaignNote[];
  /** 0 only when the Inspector passed and delivery ran without an error-level note. */
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
  outputSchemaPath: string;
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
    outputSchemaPath: input.outputSchemaPath,
    allow,
    deny,
    orders: input.orders,
  };
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
  const note = (
    level: CampaignNote['level'],
    code: CampaignNoteCode,
    message: string,
    fix?: Fix,
  ): void => {
    notes.push({ level, code, message, ...(fix === undefined ? {} : { fix }) });
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

  const task = archive.createTask({ title: options.objective, status: 'in_flight' });
  const branch = armyBranch(task.id);
  const orders: OriginalOrders = { objective: options.objective, project, taskId: task.id };

  archive.appendSignal({
    fromAgent: GENERAL_AGENT_ID,
    toSelector: 'chain',
    kind: 'broadcast',
    body: cap(`campaign opened: ${options.objective}`),
  });
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
          ...(options.ghProbe === undefined ? {} : { ghProbe: options.ghProbe }),
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
      note(
        'error',
        'aborted',
        `campaign aborted: ${message}`,
        error instanceof CampaignSetupError
          ? error.fix
          : noFix(
              'the campaign hit a failure it does not have a diagnosis for, so nothing here is a ' +
                `command worth pasting. What it managed to write is in ${archive.root}.`,
            ),
      );
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
    guard('closing the task', () => {
      if (outcome !== 'delivered' && archive.getTask(task.id)?.status === 'in_flight') {
        archive.updateTask(task.id, {
          status: outcome === 'aborted' ? 'blocked' : 'failed',
          branch,
        });
      }
    });
    intendedStatus = outcome === 'delivered' ? 'done' : outcome === 'aborted' ? 'aborted' : 'failed';
    guard('closing the campaign', () => archive.setCampaignStatus(intendedStatus));
    // Read it back so the result reports what the archive actually says — but never let that
    // read be the reason a campaign has no result at all.
    guard('reading back the campaign status', () => {
      intendedStatus = archive.getCampaign().status;
    });
    guard('closing the archive', () => archive.close());
  }

  const campaignRoot = archive.root;
  const finalStatus = intendedStatus;
  const deliveredRung = delivery?.delivered ?? null;

  const exitCode = outcome === 'delivered' ? 0 : 1;
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
    case 'durability-mirror':
    case 'pr-opened':
    case 'review-posted':
      return undefined;
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
