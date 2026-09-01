/**
 * `army campaign` — the vertical slice.
 *
 * ```
 * ☆ GENERAL (this process)
 *  └─ spawns   ─▶ ◈ MAJ·OVERSEER   claude, NO tree, Read/Grep/Glob/TodoWrite. --overseer only.
 *                      │ segments the feature into workstreams with declared file ownership
 *                      │ answers the questions climbing from below, or declines them
 *                      ▼
 *  └─ detaches ─▶ ◇ CPT·ENGINEER   one per workstream, concurrently, each with its own leased
 *                      │           worktree and its own army/<task-id> branch
 *                      │ reports "ready for inspection"
 *                      │ or reports BLOCKED with a question → it climbs to the OVERSEER and
 *                      │   then to a human, and the answer re-detaches an Engineer into the
 *                      │   same tree while every sibling workstream keeps running
 *                      ▼
 *  └─ merges   ─▶ the integration tree, by THIS process, never by a worker at any rank.
 *                      a conflict becomes a reconciliation workstream: a fresh engineer, its
 *                      own tree, briefed with both branches and the conflicted files
 *                      ▼
 *  └─ spawns   ─▶ ◇ CPT·INSPECTOR  codex, briefed from ORIGINAL ORDERS + the branch
 *                      FAIL → the GENERAL re-detaches an Engineer with the findings
 *                      PASS → durability, then the delivery ladder
 * ```
 *
 * ## A campaign with ONE workstream is the campaign that existed before workstreams
 *
 * With no `--overseer`, nothing is segmented: there is one workstream over the whole objective,
 * bound to the campaign's own task and its own `army/<task-id>` branch, and it carries the
 * acceptance gate and the Inspector exactly where it always did. No integration tree is opened
 * and no merge is attempted. That is not a compatibility shim, it is the same code with N = 1,
 * which is why "indistinguishable from today" is a property with a test on it rather than a hope.
 *
 * With several workstreams the two gates MOVE rather than multiply: the spec's `verify` commands
 * and the objective both describe the WHOLE feature, so running either against one workstream's
 * partial branch would fail every workstream by construction. Both run once, on the integrated
 * branch. Per-workstream inspectors are phase 3 and are not built here.
 *
 * This file composes; it does not reimplement. Worktrees come from `src/worktree`, processes from
 * `src/harness`, persistence from `src/archive`, landing from `src/delivery`, ceilings from
 * `src/config`, permission rules from `./permissions.ts`, the overseer's own decisions from
 * `./overseer.ts`, and every word a worker reads from `./orders.ts`.
 *
 * ## Four properties this file is responsible for, in descending order of how badly it hurts to
 * ## get them wrong
 *
 * 1. **The GENERAL spawns the Inspector, and briefs it from the original orders.** The
 *    Engineer's report is never an input to the Inspector's brief. Enforced in `orders.ts` by the
 *    shape of `InspectorBrief`; this file's only job is to call the right function.
 *
 * 2. **No lease is ever leaked, and there are now N of them plus the integration tree.** Every
 *    exit path — success, inspector fail, engineer crash, codex missing, an exception nobody
 *    predicted — settles EVERY tree this run took, through `settleLease` for a leased one and
 *    through durability-then-release for the integration tree. Each either comes back or is
 *    deliberately retained with the reason recorded. `LeaseDisposition` is on every `Workstream`
 *    and in the archive, `IntegrationDisposition` is on the result, so "we do not know what
 *    happened to a worktree" is not a reachable state.
 *
 *    Concurrency makes this harder in three specific ways, all handled where they arise: a
 *    workstream is recorded in `runs` BEFORE its lease is attempted, so a throw between the two
 *    cannot produce a tree nobody owns; the pool that runs the workstreams never rejects, because
 *    a rejected `Promise.all` would return to the `finally` while siblings were still writing to
 *    trees it is about to reset; and a workstream of SEVERAL both leases and settles its tree
 *    inside its own pool slot, so what the cap bounds is trees rather than only engineers.
 *
 *    That last one is settlement in two places, which is exactly the shape that leaks a tree, so
 *    there is only one function that settles: `settleWorkstreamTree`, serialised, idempotent
 *    through `WorkstreamState.settled`, and doing all the bookkeeping a settled tree owes rather
 *    than leaving half of it at whichever caller ran. The `finally` calls the same function for
 *    every tree, and settles the ones no slot got to.
 *
 * 3. **Durability before release, unconditionally.** A leased tree is reset and cleaned when
 *    it is returned, so work that exists only inside it is one release away from gone. Durability
 *    runs on the FAILURE paths too — an Inspector-failed branch is still a night's work, and rung
 *    0 means "your repo untouched", not "throw it away".
 *
 * 4. **Nothing but the capped report crosses back.** The GENERAL reads `Report` and
 *    `Verdict`, both schema-validated, and now also `Segmentation` and `OverseerAnswer`, which
 *    are schema-validated the same way. A segmentation is a model's plan for how a feature is cut
 *    up, and it becomes task ids and git branch names, so `validateSegmentation` is narrower than
 *    a report validator rather than looser. The transcripts go to `stream.jsonl` and are never
 *    read here.
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
 * - *"a blocked worker asks"* versus *"an agent is one attempt at a task"*. Resolved the same way,
 *   and deliberately through the same machinery: an answered question re-detaches a NEW Engineer
 *   against the SAME task in the SAME worktree, exactly as an Inspector FAIL does. There is one
 *   resumption path in this file and the ladder does not add a second. What it does add is that a
 *   question and its answer do not spend an attempt from the retry budget, because a human
 *   deciding something is not the agent failing. See the question ladder in the attempt loop.
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
import * as os from 'node:os';
import * as path from 'node:path';

import type { CampaignStatus, TaskRow } from '../contracts/archive.ts';
import { ANSWER_FILENAME, QUESTION_FILENAME } from '../contracts/archive.ts';
import type { PermissionPosture } from '../contracts/config.ts';
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
import type { PendingQuestion } from '../contracts/question.ts';
import { pendingQuestionFrom } from '../contracts/question.ts';
import type { Rank, Role } from '../contracts/ranks.ts';
import type { Report, Verdict } from '../contracts/report.ts';
import type { TechnicalSpec } from '../contracts/spec.ts';
import {
  REPORT_SCHEMA_PATH,
  SUMMARY_MAX_CHARS,
  VERDICT_SCHEMA_PATH,
  validateReport,
  validateVerdict,
} from '../contracts/report.ts';
import type { AcceptanceResult, CommandRunner } from '../contracts/verify.ts';
import { DEFAULT_VERIFY_TIMEOUT_MS, SHELL_CANNOT_EXECUTE } from '../contracts/verify.ts';
import type { VerifyBaseline } from '../contracts/verify.ts';
import type { Lease, ReleaseResult } from '../contracts/worktree.ts';
import { armyBranch } from '../contracts/worktree.ts';
import type { IntegrationTree, MergeOutcome } from '../contracts/integration.ts';
import type {
  LeaseDisposition,
  LeaseState,
  OpenIntegrationTree,
  OverlapClaim,
  Workstream,
  WorkstreamAttempt,
  WorkstreamPlan,
  WorkstreamStatus,
} from '../contracts/workstream.ts';
import {
  DEFAULT_MAX_CONCURRENT_WORKSTREAMS,
  LEASE_STATES,
  MAX_WORKSTREAMS,
  WORKSTREAM_ID_MAX_CHARS,
  WORKSTREAM_ID_RE,
  writtenPaths,
} from '../contracts/workstream.ts';

import {
  AgentIdInUseError,
  CampaignArchive,
  campaignIdFor,
  createCampaign,
  listCampaignIds,
} from '../archive/archive.ts';
import type { ArchiveConfig } from '../archive/archive.ts';
import { loadConfig, postureNotice } from '../config/load.ts';
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
import { runAcceptanceGate, runVerifyBaseline, unrunnableCommands } from '../verify/index.ts';
import { createClaudeAdapter } from '../harness/claude.ts';
import type { ClaudeAdapterOptions } from '../harness/claude.ts';
import { createCodexAdapter, isCodexSoldier } from '../harness/codex.ts';
import type { CodexAdapterOptions } from '../harness/codex.ts';
import { killSoldierTree } from '../harness/kill.ts';
import { installHint, invokedAs } from '../setup/checks.ts';
import {
  autoInitRepo,
  decideAutoInit,
  detachedFromEnclosingRepo,
  mainRootFromCommonDir,
} from '../setup/enlist.ts';
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
import { openIntegrationTree } from '../worktree/integration.ts';
import { selectWorktreeProvider } from '../worktree/index.ts';
import type { WorktreeProviderId } from '../contracts/worktree.ts';
import type { ProgressEvent, ProgressListener } from '../view/progress.ts';
// The one thing this file takes from the view layer that is not a type: the neutraliser for
// worker-authored text on its way to a terminal. See the note at the `pendingQuestionFrom` call.
import { sanitize } from '../view/progress.ts';
import { describeToolUse } from '../view/activity.ts';

import {
  briefInspectorFromAttempt,
  briefValidator,
  renderAdjudicationBrief,
  renderEngineerOrders,
  renderEngineerReportMd,
  renderOverseerQuestionBrief,
  renderSegmentationBrief,
  renderVerdictMd,
} from './orders.ts';
import type {
  AnsweredQuestion,
  OriginalOrders,
  ReconciliationBrief,
  WorkstreamBrief,
} from './orders.ts';
import { adjudicate, askOverseer, attributeOverlaps, segmentFeature } from './overseer.ts';
import type { FixDecision, OverseerRun, OverseerSpawn } from './overseer.ts';
import {
  INSPECTOR_TEST_WRITE_RULES,
  assertGlobalDenyIntact,
  assertInspectorWriteContained,
  assertNoFlagLikeRules,
  assertSubagentRosterSafe,
  assertWorktreeRootOutsideProtected,
  fileRunRules,
  inspectorWriteDeny,
  isTestPath,
  permissionsFor,
  subagentDeny,
  subagentRosterFor,
  verifyAllowRules,
} from './permissions.ts';

// ---------------------------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------------------------

/**
 * Re-exported from `src/contracts/workstream.ts`, where it moved when it stopped being one
 * campaign's answer and became one PER WORKSTREAM. Every importer in the tree still names it here.
 */
export { LEASE_STATES };
export type { LeaseState, LeaseDisposition };

export type CampaignNoteCode =
  | 'worktree-provider'
  | 'ceiling'
  | 'clamped'
  | 'permission-denied'
  | 'delivery'
  | 'durability'
  | 'lease'
  | 'inspector'
  /**
   * The `CPT·VALIDATOR`'s own line: the last unit of the campaign, judging the INTEGRATED branch
   * against the ORIGINAL ask. Separate from `inspector` because the two answer different questions
   * and a reader scanning for "was the assembled thing what I asked for" should not have to sort
   * one out of N slice reviews.
   */
  | 'validator'
  /**
   * A `CPT·INSPECTOR` wrote files, and which ones.
   *
   * Precondition 3 on `INSPECTOR_TEST_WRITE_RULES`: the verdict and the test authorship are
   * SEPARATE signals, so "it passed" and "it wrote the thing that passed" are separately visible to
   * whoever reads the campaign back. A reviewer that wrote outside the test paths is an `error` on
   * this code and its verdict is discarded.
   */
  | 'authorship'
  | 'engineer'
  /**
   * A `spec.verify` command failed against the Engineer's own branch, mechanically, before an
   * Inspector was spawned. See `src/verify/gate.ts` for the incident this exists for.
   */
  | 'acceptance'
  /**
   * The Inspector's verdict did not account for every numbered behaviour — missing, duplicated,
   * or out of range. See `behaviourCoverage`; this is a gap in the REVIEW, not the work.
   */
  | 'coverage'
  | 'retry'
  /**
   * A worker reported `blocked` with a question, and what became of it: raised, answered, or
   * dropped because nothing above it could take a question. See the question ladder in the
   * attempt loop.
   */
  | 'question'
  /**
   * A `MAJ·OVERSEER` cut the feature into workstreams, refused to, or was sent back because two
   * of its workstreams claimed the same file.
   */
  | 'segmentation'
  /** One workstream's lifecycle: launched, accepted, rejected, parked. */
  | 'workstream'
  /**
   * An engineer wrote a file its workstream never declared. A NOTIFICATION and never a refusal —
   * see `docs/main-flow.md`, "Segmentation is the plan, not a fence".
   */
  | 'overlap'
  /** The integration branch: a merge, a conflict, or a reconciliation workstream. */
  | 'integration'
  | 'aborted'
  /**
   * The campaign turned a bare directory into a repository before starting, the same way
   * `enlist` does. Recorded so `--json` and the final report say a repository now exists that
   * did not when the command was typed.
   */
  | 'auto-init'
  /**
   * How tightly this campaign's workers are confined — `PermissionPosture`. Raised on every
   * campaign, beside the delivery ceiling, because the two answer the same class of question:
   * what is this run allowed to do. `warn` under `unguarded` so a reader who did not choose it
   * sees it, `info` under `guarded` so a reader who did is not nagged.
   */
  | 'permissions';

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

/**
 * What became of the one integration tree, and what reached its branch.
 *
 * The same discipline `LeaseDisposition` is under and for the same reason: a tree whose fate
 * nobody recorded is the state property 2 of this file's header says must be unreachable, and an
 * integration tree is a tree. It is a SEPARATE type rather than a `LeaseDisposition` because it has
 * no lease id to report and carries the merge ledger instead, but its STATES are now deliberately
 * the same four words, because the thing that can happen to a tree does not depend on who leased
 * it.
 *
 * `not-held` is the newest of them and it is here for the reason it is on `LeaseDisposition`:
 * `IntegrationTree.release()` returned `void`, so this file wrote `state: 'released'` on the
 * strength of the call not throwing and narrated `integration tree released: <path>` for a path
 * that, in the stale-lease case, belongs to somebody else's holder. The contract now returns an
 * `IntegrationReleaseOutcome` and this records the disposition it actually got.
 */
export interface IntegrationDisposition {
  /** The branch accepted workstreams were merged onto. */
  branch: string;
  /** Absolute path of the integration worktree, or null if one was never opened. */
  path: string | null;
  /**
   * `never-opened` no integration tree was ever leased.
   * `released`     this run returned the tree.
   * `retained`     this run still HOLDS it, deliberately, because releasing it would have
   *                destroyed merged work no durable ref can reach.
   * `not-held`     this run neither returned it nor holds it: the lease went stale, the record was
   *                already gone, or the tree was. `reason` is the provider's own sentence, and the
   *                path must NOT be read as one this campaign returned.
   */
  state: 'never-opened' | 'released' | 'retained' | 'not-held';
  /** Always populated. For `retained`, what a human needs to recover the merged work. */
  reason: string;
  /** Workstream ids whose branches reached the integration branch, in merge order. */
  merged: readonly string[];
  /** Every merge git could not perform, with the files it named. */
  conflicts: readonly { workstreamId: string; files: readonly string[] }[];
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
  /**
   * The workstream this attempt belonged to.
   *
   * ALWAYS SET, including on a campaign nobody segmented, where it is the id of the single
   * workstream that covers the whole objective. An optional field here would mean two shapes of
   * the same record and a reader having to know which campaign produced which.
   */
  workstreamId: string;
  attempt: number;
  engineerAgentId: string;
  inspectorAgentId: string | null;
  report: Report | null;
  verdict: Verdict | null;
  /** Terminal disposition of the Engineer process, from the adapter. */
  engineerStatus: string;
  costUsd: number | null;
  /**
   * This attempt's acceptance-gate result. `null` when the Engineer never reported `done`, so
   * the gate was never a candidate to run at all — distinct from `{ ran: false, ... }`, which
   * means it WAS a candidate but `spec.verify` had no commands. See `runAcceptanceGate`.
   */
  acceptance: AcceptanceResult | null;
}

/**
 * One workstream while it is running: everything the campaign used to hold in its own locals when
 * there was only ever one line of work.
 *
 * INTERNAL, and not exported. `Workstream` in `src/contracts/workstream.ts` is what leaves this
 * module, and it is deliberately smaller: a lease handle, a live overlap set and a verify baseline
 * are working state, and putting them on the result would invite a caller to act on a lease this
 * process has already returned.
 */
interface WorkstreamState {
  plan: WorkstreamPlan;
  /** Every OTHER workstream in the plan, for the brief and for overlap attribution. */
  siblings: readonly WorkstreamPlan[];
  taskId: string;
  branch: string;
  worktree: string | null;
  lease: Lease | null;
  leaseDisposition: LeaseDisposition;
  baseCommit: string | null;
  verifyBaseline: readonly VerifyBaseline[];
  /**
   * Whether this workstream carries the campaign's ACCEPTANCE GATE.
   *
   * True for the single workstream of an unsegmented campaign, which is the whole campaign and
   * always was. False for one of several: `spec.verify` describes the WHOLE feature, so running it
   * against a partial branch would fail every workstream by construction. A segmented campaign
   * gates once, on the integrated branch.
   *
   * IT USED TO MEAN BOTH "gated" AND "reviewed", and the two turned out to have different answers
   * the moment inspectors went per-workstream: whether a partial branch can be MECHANICALLY CHECKED
   * against whole-feature commands (no) and whether it can be REVIEWED against its own slice (yes,
   * and that is the whole of this wave). Every workstream is now reviewed, which is why there is no
   * second flag: a boolean that is true at every call site is a knob that looks live and is not.
   */
  gated: boolean;
  status: WorkstreamStatus;
  /** This workstream's own ending, in the campaign's outcome vocabulary. */
  outcome: CampaignOutcome;
  attempts: WorkstreamAttempt[];
  overlaps: OverlapClaim[];
  /** Files already announced, so the live detector does not raise the same one on every edit. */
  announced: Set<string>;
  report: Report | null;
  verdict: Verdict | null;
  retriesExhausted: boolean;
  unverifiedBehaviours: number[];
  /** Set only for a workstream that exists to reconcile a merge conflict. */
  reconciliation: ReconciliationBrief | null;
  /**
   * The agent id minted for this workstream before its tree was leased.
   *
   * It is the LEASE HOLDER and attempt 1's engineer, which is one id doing two jobs on purpose:
   * an unsegmented campaign leases as `cpt-01` and runs `cpt-01` first, exactly as it did when
   * the holder was written out as `agentIdFor(1)` and the loop minted its own.
   */
  firstAgentId: string | null;
  /** True once this workstream's branch has reached the integration branch. */
  merged: boolean;
  /**
   * True once `leaseDisposition` is this tree's FINAL answer, so the campaign's `finally` leaves it
   * alone.
   *
   * A workstream that is one of several settles its own tree at the end of its own pool slot (see
   * `releaseWorkstreamTree`), and settling a released lease a second time would ask the pool about
   * a slot another workstream is by then holding.
   */
  settled: boolean;
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
  /**
   * The FIRST workstream's lease, which on an unsegmented campaign is the campaign's only one.
   *
   * Kept singular and kept first because every reader of a campaign result asks the same question
   * of it, and on the campaign shape that existed before workstreams there was one answer. A
   * segmented campaign has N of these plus the integration tree, and each is on `Workstream.lease`
   * below, so nothing is hidden by this field staying what it was. That sentence used to be a
   * claim about notes and the progress stream rather than about the result: the field it names now
   * exists, and "what happened to each tree" is answerable without reading prose.
   */
  lease: LeaseDisposition;
  /**
   * Every workstream this campaign ran, in the order they were planned, reconciliations last.
   *
   * One entry for a campaign nobody segmented, covering the whole objective. That is not a
   * courtesy: it is what makes "how did this campaign go" one question with one shape of answer
   * rather than two.
   */
  workstreams: Workstream[];
  /** The concurrency cap actually in force, after clamping. Reported so nobody has to guess. */
  maxConcurrentWorkstreams: number;
  /** The integration branch and what was merged onto it, or null when nothing was segmented. */
  integration: IntegrationDisposition | null;
  notes: CampaignNote[];
  /**
   * The acceptance gate's result for this campaign: the run on the INTEGRATED branch when it was
   * segmented, and the LAST attempt's otherwise. See `AttemptRecord.acceptance` for the full
   * per-attempt history. `null` only when no gate was ever a candidate to run at all.
   *
   * The two sources are exclusive rather than merged. A workstream of several is not judged on its
   * own partial branch, so its attempts carry no gate result to compete with the integrated one.
   *
   * `{ ran: false, ... }` is itself a reportable state, not an absence — a spec carrying no
   * `verify` commands (or no spec at all) leaves this here, and `renderCampaignResult` says so
   * rather than staying quiet. An unrun check must never read as a passed one; see the incident
   * `src/verify/gate.ts` exists for.
   */
  acceptance: AcceptanceResult | null;
  /**
   * 1-based behaviour indices the Inspector answered `not-verified` on the verdict that
   * DELIVERED this campaign. Empty whenever nothing is unverified, nothing was delivered, or the
   * campaign carried no spec with behaviours.
   *
   * NOT a failure — `not-verified` is the Inspector telling the truth about what it could not
   * check, and `behaviourCoverage` treats it as complete coverage on purpose. But it has to be
   * VISIBLE, so it travels here and `renderCampaignResult` names it: a human reading "delivered"
   * should also read how many behaviours were never actually checked.
   */
  unverifiedBehaviours: number[];
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
  /**
   * The technical spec, when the dispatch carried one. Absent means a free-text objective.
   *
   * The concurrent chat unit codes against exactly this name and shape — do not rename it. It is
   * threaded to `renderEngineerOrders` and `briefInspectorFromAttempt` verbatim, and it is what
   * `dispatchFor` reads to decide whether the ENGINEER needs `UNSPECIFIED_BRIEF_EFFORT`.
   */
  spec?: TechnicalSpec;
  /** Where the campaign was launched. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Turn a bare directory into a repository before refusing it, exactly as `enlist` does.
   * Default true; `--no-init` is the opt-out. See `resolveProjectRootOrInit` for the guards.
   */
  init?: boolean;
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
  /**
   * The acceptance gate's process runner. Injected so tests never spawn a process. Defaults to
   * the real runner (`runCommand`, via `runAcceptanceGate`'s own default).
   */
  verifyRun?: CommandRunner;
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
  /** Per-soldier wall-clock ceiling. Defaults to `DEFAULT_SOLDIER_TIMEOUT_MS`, on EVERY branch
   *  of `adapterFor` — see that constant for the field failure a claude-only gap caused. */
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
  /**
   * Put a blocked worker's question in front of a human, and return their answer.
   *
   * ## Absent is the default, and the default is what `army campaign` does today
   *
   * With no `askHuman`, a blocked report ends the attempt exactly as it always has. That is not an
   * oversight to be fixed later: `army campaign` runs headless in a script and overnight from a
   * launcher, and a supervisor that blocks forever on a keyboard nobody is sitting at is a hung
   * campaign holding a worktree lease. Silence has to be a legal answer, and the legal answer to
   * silence is the behaviour that existed before questions did.
   *
   * ## What a caller owes
   *
   * It may take as long as a human takes. The campaign is parked on it: the task is marked
   * `blocked`, the worktree stays leased with the branch inside it, and nothing else is running.
   *
   * Its resolved string is the ANSWER, verbatim, and it becomes part of the next Engineer's
   * orders. A blank one, or a rejection, both mean "no answer came back" and put the campaign on
   * the path it would have taken with no `askHuman` at all. Neither is an error worth ending a
   * campaign over: a human who walked away has not broken anything.
   *
   * It must never be a route back into a commanding model. `src/chat` reads the answer straight
   * off the terminal and hands it here, so no turn is taken, no authority is re-opened, and
   * answering a question cannot be a way to get a dispatch proposed. See `src/chat/session.ts`.
   */
  askHuman?: (question: PendingQuestion) => Promise<string>;
  /**
   * Answer SIGINT/SIGTERM by aborting the campaign CLEANLY: kill the in-flight soldier's whole
   * process tree, settle the archive (`aborted` / task `blocked`), run durability and the lease
   * release through the normal `finally`, and exit `128 + signal` (130 for Ctrl-C).
   *
   * OPT-IN, and `campaignCommand` is the caller that opts in. Default-off because `runCampaign`
   * is also driven from inside `army chat`, which owns its own terminal and its own signal
   * story — a library function quietly installing `process.on('SIGINT')` under a host that
   * already has one is how two handlers fight over one keypress.
   *
   * The field failure this exists for: Ctrl-C on a running campaign killed the supervisor in
   * milliseconds — exit 130, no message, no abort record, lease file left forever — while the
   * claude soldier, running with `--permission-mode dontAsk`, kept working until it noticed
   * stdin EOF. An agent with dontAsk permissions outliving its supervisor is the worst version
   * of an orphaned process, so the FIRST thing the handler does is kill the soldier's tree.
   */
  handleSignals?: boolean;
  /**
   * Abort this campaign from the HOST process, cleanly, without a signal.
   *
   * The same ending `handleSignals` gives Ctrl-C, reached by a different door: the in-flight
   * soldiers' process trees are killed, the abort is noted and recorded, and the campaign unwinds
   * through the one `finally` that settles the archive, runs durability and releases every lease.
   * Nothing calls `process.exit`, and the result comes back normally with `outcome: 'aborted'`.
   *
   * It exists because `army chat` cannot use `handleSignals`. Chat owns its own terminal and its
   * own Ctrl-C, which means "stop this answer" and must NOT come to mean "kill sixteen agents and
   * their worktrees", so stopping a campaign there is a typed `/stop`, and a typed command has no
   * signal to raise. Building a second stop path for it would mean a second thing that settles a
   * lease, which is the one property this file's header says must have exactly one implementation.
   *
   * Aborting BEFORE the campaign starts is honoured: the first checkpoint sees the signal already
   * set and unwinds immediately. Aborting after it has finished does nothing.
   */
  abortSignal?: AbortSignal;
  /**
   * Put a `MAJ·OVERSEER` over this campaign: it segments the feature into workstreams, and a
   * question climbing from an engineer reaches it before it reaches a human.
   *
   * ## OFF BY DEFAULT, and the default is what `army campaign` did before workstreams existed
   *
   * With this absent, no overseer is spawned, the campaign runs ONE workstream over the whole
   * objective, and every archive row, brief and note is the one it produced before. That is not
   * deference to old tests: an overseer is a whole model session spent before an engineer starts,
   * and a two-line objective in a repository of four files does not need a feature owner. Turning
   * it on is a decision about a feature's size, and the person who knows that is the one typing.
   *
   * What it does NOT change is the shape of the result. A campaign with an overseer that segments
   * into one workstream runs the identical path this option's absence runs, which is a property
   * with a test on it.
   */
  overseer?: boolean;
  /**
   * How many workstreams run at once. Clamped to 1..`MAX_WORKSTREAMS`; defaults to
   * `DEFAULT_MAX_CONCURRENT_WORKSTREAMS`.
   *
   * The cap is the whole of the budget control on fan-out. Every concurrent workstream is another
   * metered model session, another worktree out of a pool of sixteen, and another writer against
   * one SQLite index, so this multiplies the cost of a campaign while dividing only its wall
   * clock. The effective value is on the result and in a note, because a limit nobody can see is
   * a limit nobody checked.
   *
   * IT BOUNDS TREES AS WELL AS ENGINEERS, and only because a workstream leases its tree inside its
   * own pool slot and settles it at the end of the same one. The peak is this number plus the one
   * integration tree; at the default of three that is four of the pool's sixteen. It bounded
   * engineers alone while every tree was leased up front, and a campaign that needed one tree at a
   * time then refused itself for want of trees. The one number that does NOT follow the cap is the
   * absolute ceiling on trees this campaign can leave held, which is `MAX_WORKSTREAMS` plus its
   * reconciliations plus the integration tree, which is 16, the pool's whole default. It is
   * reachable only when every settlement RETAINS its tree because the work could not be made
   * durable. See `DEFAULT_MAX_CONCURRENT_WORKSTREAMS`.
   */
  maxConcurrentWorkstreams?: number;
  /**
   * How a segmented campaign obtains its integration tree.
   *
   * OPTIONAL, and the default is the real pooled implementation in `src/worktree/integration.ts`,
   * built from the provider this campaign already selected. A caller that passes nothing still
   * gets working integration, which is what `army campaign --overseer` and `army chat` both rely
   * on.
   *
   * The seam exists for the other direction: the module that DECIDES a merge and the module that
   * PERFORMS one stay swappable, and a test can drive every merge, conflict and reconciliation
   * path through a stand-in.
   */
  openIntegrationTree?: OpenIntegrationTree;
  /**
   * A scout's findings, for the overseer's segmentation brief.
   *
   * Nothing in this build spawns a scout. The field exists because the design says the overseer is
   * briefed with the spec AND the scout's findings, and a brief that quietly drops half of its
   * inputs is a brief that is wrong the day the other half arrives.
   */
  scoutFindings?: readonly string[];
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Question rounds one campaign may spend, whatever its retry budget is.
 *
 * A question does not charge the retry budget, so this is what keeps the attempt loop finite: an
 * Engineer that asks, is answered, and asks again would otherwise loop for as long as a human kept
 * typing. Three is chosen to match the default attempt budget rather than for any deeper reason,
 * and it is a constant rather than an option because there is no evidence yet about what a fourth
 * round is worth. A task that needs a fourth decision handed to it mid-flight is a task whose
 * brief was not finished, and the fix for that is a better spec, not a bigger allowance.
 */
export const MAX_QUESTION_ROUNDS = 3;

/**
 * How rarely a reasoning-token reading may be re-announced, and how much growth overrides that.
 *
 * The harness emits one of these roughly every 1.5 seconds for the entire duration of a reasoning
 * gap — 166 of them inside a single 248-second silence on the reference run. The interval keeps a
 * quiet stretch from repainting more often than a human can read; the token floor makes a sudden
 * burst visible before the interval is up, so the number moves when the work does.
 */
const THINKING_MIN_INTERVAL_MS = 2_000;
const THINKING_MIN_TOKENS = 250;
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
  /**
   * How tightly to confine this worker — `PermissionPosture` in `src/contracts/config.ts`.
   *
   * Optional and defaulting to `guarded`, matching `permissionsFor` and `SoldierSpec.posture`:
   * every call site that has not been taught about the posture builds the confined spec it built
   * before, and only a caller that has read the config can loosen one.
   */
  posture?: PermissionPosture;
  /**
   * The spec's `verify` commands, for a worker whose orders instruct it to run them.
   *
   * Each becomes an EXACT-match `Bash(<command>)` allow rule via `verifyAllowRules` — see that
   * function for the field failure this closes and why the human's approval of the spec is the
   * authorization for these exact strings.
   *
   * ## TWO ROLES, AND THE REFUSAL IS NARROWED RATHER THAN DROPPED
   *
   * The ENGINEER, whose orders tell it to run the commands before reporting done. And the
   * VALIDATOR, which exists to run them against the integrated branch and judge the result against
   * the original ask — a role that did not exist when this refusal was written, and whose reason
   * for holding the rules is the same reason the Engineer holds them.
   *
   * Still refused for everyone else, and the refusal now says the true thing rather than the
   * convenient one: the INSPECTOR is told the gate already ran them (so a rule would grant an
   * authority its brief tells it not to use), and every remaining role holds no shell at all. The
   * old wording — "every other role holds no shell to run them with" — became false the moment a
   * VALIDATOR held one, and a guard whose stated reason has stopped being true is a guard nobody
   * can reason about.
   */
  verifyCommands?: readonly string[];
  /**
   * The spec's `filesInScope`, for an ENGINEER whose orders now say it may run the runnable ones.
   *
   * Each runnable entry (`.js`/`.mjs`/`.cjs`/`.py`/`.sh`) becomes a PREFIX `Bash(<interpreter>
   * <file>:*)` allow rule via `fileRunRules` — see that function for the field failure this closes
   * (an Engineer denied every ad-hoc run of the file its own approved spec named) and why a spec
   * approved at dispatch is authorization for the files it names. ENGINEER only, same guard as
   * `verifyCommands`: the Inspector never runs anything the spec named, and the codex harness has
   * no per-tool rules to carry a prefix rule with anyway.
   */
  filesInScope?: readonly string[];
  /**
   * Issue this worker a roster of subordinates it may field as native subagents.
   *
   * OPT-IN, and default-off, which is the conservative direction: a worker with no roster is
   * pinned to a nesting cap of zero by the claude adapter, so "not asked for" and "not permitted"
   * are the same state rather than two states one of which is a default nobody chose. An INSPECTOR
   * is never given one — the review gate is one unit's independent judgement, and a reviewer that
   * fans out is a reviewer whose verdict is assembled from reports it did not gather.
   */
  fanOut?: boolean;
  /**
   * Issue this INSPECTOR the scoped test write, with its containment.
   *
   * INSPECTOR only, and refused for every other role, for the reason `ROLE_ALLOW.INSPECTOR` still
   * names no editor: this is a supervisor decision taken per spawn rather than a property of a
   * role. See `INSPECTOR_TEST_WRITE_RULES`.
   *
   * `containment` is what `inspectorWriteDeny` produced from the branch under review; it goes on
   * the DENY half, which both harnesses read and both postures carry byte-identically.
   *
   * It used to carry a second field, `validatorFollows`, and the removal is the point rather than
   * a tidy-up: a spawn cannot know whether a validator will run, so the flag was a literal `true`
   * whose refusal could never fire. Precondition 4 is now enforced at `commitInspectorTests`,
   * which is called after a validator has actually run and refuses without naming it.
   */
  testWrite?: {
    containment: readonly string[];
  };
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
  // Rank AND role. The rank has been on this input since the first spec was built; until it was
  // passed here it decided a label and a substrate and nothing about what the worker could do.
  const posture: PermissionPosture = input.posture ?? 'guarded';
  const { allow, deny } = permissionsFor(input.rank, input.role, input.home, posture);
  assertNoFlagLikeRules(allow, `${input.role} allow-list`);
  assertNoFlagLikeRules(deny, 'global deny-list');
  const who = `${input.agentId} (${input.rank}·${input.role})`;
  assertGlobalDenyIntact(deny, who);

  // ---- the spec's own verify commands, as exact allow rules -------------------------------
  //
  // AFTER `permissionsFor` and its guards, and ENGINEER-only by refusal: `assertCommanderLoadout`
  // and the rank narrowing both run inside `permissionsFor`, so rules appended here are rules
  // those guards never saw. Appending to the one role whose loadout already holds a scoped shell
  // widens nothing those guards protect; appending to any other role would be a back door past
  // them, so it throws instead. Deny still wins over allow in claude's engine, so the global
  // deny-list above is untouched by this and still holds.
  if (input.verifyCommands !== undefined) {
    if (input.role !== 'ENGINEER' && input.role !== 'VALIDATOR') {
      throw new Error(
        `refusing to spawn ${who}: verify-command allow rules belong to the ENGINEER, which is ` +
          'ordered to run them before reporting done, and to the VALIDATOR, which exists to run ' +
          'them against the integrated branch. The INSPECTOR is told the gate already ran them, ' +
          'and every remaining role holds no shell at all — widening one of those loadouts here ' +
          'would bypass the guards inside permissionsFor.',
      );
    }
    // Under `unguarded` the loadout already holds a bare `Bash`, so an exact-match grant for one
    // spelling of one command adds nothing and would only put back the noise this posture exists
    // to remove. Skipped rather than emitted-and-ignored: an allow-list that lists rules with no
    // effect is a list nobody can read for what it actually permits.
    if (posture === 'guarded') {
      for (const rule of verifyAllowRules(input.verifyCommands)) {
        if (!allow.includes(rule)) allow.push(rule);
      }
    }
  }

  // ---- the spec's own filesInScope, as run rules for the ones the Engineer may execute ----
  //
  // Same guard, same reasoning, as the verify-command block above: appended AFTER `permissionsFor`
  // so `assertCommanderLoadout` and rank narrowing never see these rules, and refused for any role
  // but ENGINEER rather than widened past those guards. `fileRunRules` already drops every entry
  // that has no runnable extension, so a spec's `.ts`/`.md`/`.json` files add nothing here.
  if (input.filesInScope !== undefined) {
    if (input.role !== 'ENGINEER') {
      throw new Error(
        `refusing to spawn ${who}: file-run allow rules are the ENGINEER's alone. No other role ` +
          'holds a shell to run a file with — widening another loadout here would bypass the ' +
          'guards inside permissionsFor.',
      );
    }
    // Same reasoning as the verify block above: a bare `Bash` already runs the file.
    if (posture === 'guarded') {
      for (const rule of fileRunRules(input.filesInScope)) {
        if (!allow.includes(rule)) allow.push(rule);
      }
    }
  }
  // ---- the INSPECTOR's scoped test write, and the deny that bounds it ---------------------
  //
  // BOTH HALVES, AND THE DENY IS THE ONE THAT MATTERS. The allow is emitted at BOTH postures,
  // unlike the verify and file-run rules above: those add nothing under `unguarded` because the
  // loadout already holds a bare `Bash`, whereas this loadout holds NO editor at either posture, so
  // a scoped `Edit(test/**)` is a real and strictly bounded grant under both. The deny half is
  // byte-identical under both postures by construction (`permissionsFor` only projects the allow),
  // which is precisely why precondition 1 says the containment has to live there.
  if (input.testWrite !== undefined) {
    if (input.role !== 'INSPECTOR') {
      throw new Error(
        `refusing to spawn ${who}: the scoped test write is the INSPECTOR's alone. The ENGINEER ` +
          'already writes its whole worktree, and every other role is defined by the absence of an ' +
          'editor — the OVERSEER and the VALIDATOR name the write tools on their deny half exactly ' +
          'so that a grant appearing here would be cancelled rather than honoured.',
      );
    }
    for (const rule of input.testWrite.containment) if (!deny.includes(rule)) deny.push(rule);
    for (const rule of INSPECTOR_TEST_WRITE_RULES) if (!allow.includes(rule)) allow.push(rule);
    assertInspectorWriteContained({
      allow,
      containment: input.testWrite.containment,
      who,
    });
    assertNoFlagLikeRules(input.testWrite.containment, 'inspector containment deny-list');
  }

  assertNoFlagLikeRules(allow, `${input.role} allow-list (with verify and file-run rules)`);

  // ---- the lower half of the org chart ---------------------------------------------------
  //
  // A roster is opt-in per spawn, and everything about it is decided HERE, in the one function
  // that builds a spec — the same reason the deny-list is built here rather than remembered at
  // each call site. A subordinate declared anywhere else would be a subordinate that never met
  // `assertSubagentRosterSafe`, and a native subagent inherits its parent's settings, so that is
  // precisely the unit whose rank would mean nothing.
  const roster = input.fanOut === true ? subagentRosterFor(input.rank, input.role) : [];
  if (roster.length > 0) {
    if (input.harness !== 'claude') {
      // Refuse rather than drop. `codex exec` has no subagent model to translate this to, and a
      // silently dropped roster is worse than an error: the campaign would brief a unit on a squad
      // it does not have, and the archive would record a fan-out that never happened.
      throw new Error(
        `refusing to spawn ${who}: it was issued a fan-out roster on the ${input.harness} ` +
          'harness, which has no native subagent model. There is nothing to translate this to ' +
          'and nothing to degrade it to — a dropped roster is a unit told it commands a squad ' +
          'that does not exist.',
      );
    }
    assertSubagentRosterSafe(roster, input.rank, allow, who);
    assertNoFlagLikeRules(
      roster.flatMap((def) => def.tools),
      'subagent roster',
    );
    // The spawn rule, on the wire. The roster says whom this unit MAY field; these rules say whom
    // it may not, by name, including the harness's own built-in agent types — measured to be the
    // only form the permission engine enforces for an agent type.
    const spawnDeny = subagentDeny(input.rank, input.role);
    assertNoFlagLikeRules(spawnDeny, 'subagent deny-list');
    for (const rule of spawnDeny) if (!deny.includes(rule)) deny.push(rule);
  }

  const spec: SoldierSpec = {
    agentId: input.agentId,
    rank: input.rank,
    role: input.role,
    harness: input.harness,
    cwd: input.cwd,
    sessionId: randomUUID(),
    allow,
    deny,
    posture,
    orders: input.orders,
  };
  if (roster.length > 0) spec.subagents = roster;
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
  /**
   * `permission_denials` from the harness. Each becomes a signal row — a denial is a breach.
   *
   * Allow-list misses only. A deny-rule refusal never appears in this array at all; see
   * `recordDenials` for what that costs and where the evidence does survive.
   */
  denials: unknown[];
  /** Adapter-level error messages, for a readable archive when nothing else survived. */
  errors: string[];
}

export interface RunSoldierHooks {
  /**
   * Handed the live soldier the moment it exists, BEFORE any orders are sent. This is how the
   * campaign's signal handler knows whose process tree to kill — a handler that only learns
   * about a soldier after `runSoldier` returns learns about it after the wait it needed to
   * interrupt.
   */
  onSpawn?: (soldier: Soldier) => void;

  /**
   * Every normalised event, as it arrives — the seam that makes a running soldier visible.
   *
   * ## Why this exists
   *
   * `src/contracts/harness.ts` already says of `Soldier.stream()`: "Single consumer: the
   * supervisor tees it to `stream.jsonl` (truth) and to the dashboard." Only the first half was
   * ever built. The pump below wrote 993 KB of tool calls, reasoning telemetry and permission
   * denials to disk while the human who started the campaign watched one static line for
   * twenty-seven minutes. This closes the claim rather than adding a feature.
   *
   * ## The contract a listener owes
   *
   * SYNCHRONOUS, FAST, AND NON-THROWING. This runs inside the loop draining the child's stdout, so
   * a listener that awaits, blocks or floods lets the OS pipe buffer fill and stalls the model
   * itself. At most one terminal write per call. Throwing is guarded here — see the call site —
   * but a listener that throws on every event is still a listener that does nothing.
   *
   * `runSoldier` calls this BEFORE the archive write, deliberately: the archive write is the one
   * that can fail and be recorded in `errors`, and a full disk must not also be the reason a
   * human's terminal goes quiet.
   */
  onEvent?: (event: SoldierEvent) => void;
}

export async function runSoldier(
  adapter: HarnessAdapter,
  spec: SoldierSpec,
  archive: CampaignArchive,
  hooks?: RunSoldierHooks,
): Promise<SoldierRun> {
  const events: SoldierEvent[] = [];
  const errors: string[] = [];
  const denials: unknown[] = [];
  let costUsd: number | null = null;

  const soldier: Soldier = await adapter.spawn(spec);
  hooks?.onSpawn?.(soldier);

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
      // Before the archive write, and in its own guard: a listener that throws must not be able to
      // divert this loop from the write that makes the run replayable, and an archive failure must
      // not be able to silence the terminal. Neither is worth the other.
      try {
        hooks?.onEvent?.(event);
      } catch {
        /* narration is never load-bearing — the same rule `progress` follows */
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
// Narrating a running soldier
// ---------------------------------------------------------------------------------------------

export interface ActivityTranslatorOptions {
  /** The unit these events belong to. Every emitted `ProgressEvent` carries it. */
  agentId: string;
  /** The worker's working directory, stripped from the front of the paths it names. */
  root: string;
  /** Where the translated events go. Called synchronously; must not throw. */
  emit: (event: ProgressEvent) => void;
  /** Injected clock, so the coalescing windows are deterministic in a test. */
  now?: () => number;
}

/**
 * Turn one soldier's raw event stream into the handful of moments worth narrating.
 *
 * ## Why the coalescing is the whole job
 *
 * The reference run produced 972 events for 107 tool calls: 662 of them were reasoning-token
 * deltas arriving roughly every 1.5 seconds, and 25 more were the worker updating its own task
 * list. Forwarding all of them would be a worse terminal than forwarding none. What a watching
 * human needs is (a) a line per real tool call, (b) a number that moves during the long silences
 * between them, and (c) anything that went wrong — and nothing else.
 *
 * ## Why bookkeeping tools produce no line
 *
 * `TaskCreate`/`TaskUpdate`/`ToolSearch` are the worker organising itself. On the reference run
 * they were 25 of 107 calls and arrived in bursts of nine, which is long enough to push the two
 * `Write`s around them off a short terminal. They are dropped rather than counted because the
 * reasoning heartbeat already proves the worker is alive during those seconds, which is the only
 * thing their presence was evidence of.
 *
 * ## Module-level, not a closure inside `runCampaign`
 *
 * It began life inside the campaign loop, where it could only be exercised by running a campaign.
 * The coalescing windows and the denial de-duplication are exactly the kind of state that is wrong
 * in ways an end-to-end run does not surface, so this takes its clock and its sink as arguments
 * and a test replays a real `stream.jsonl` through it.
 *
 * ## State is per agent
 *
 * An Engineer and an Inspector never run at once today, but this keys off nothing global, so the
 * day they do, two callers get two independent clocks rather than one shared one reporting
 * whichever unit spoke last.
 */
export function createActivityTranslator(
  options: ActivityTranslatorOptions,
): (event: SoldierEvent) => void {
  const { agentId, root, emit } = options;
  const now = options.now ?? ((): number => Date.now());
  /**
   * Announced calls, keyed by tool-use id.
   *
   * Two jobs: a result is only reported for a start that was actually announced, and a DENIAL is
   * reported with the call it refused. The harness's denial event carries a `tool_use_id` and a
   * tool name but not the arguments, so without this the most important line the feed can print
   * would name a tool and not the command.
   */
  const openCalls = new Map<string, string>();
  const reportedBlocks = new Set<string>();
  let reportedTokens = 0;
  let lastThinkingAt = 0;

  return (event: SoldierEvent): void => {
    switch (event.type) {
      case 'tool_use': {
        const action = describeToolUse(event.name, event.input, { root });
        if (action.bookkeeping) return;
        openCalls.set(event.toolUseId, action.target);
        emit({
          kind: 'unit-acting',
          agentId,
          toolUseId: event.toolUseId,
          tool: action.verb,
          target: action.target,
          depth: event.depth,
        });
        return;
      }

      case 'tool_result': {
        // Only for a call we actually announced. A result for a bookkeeping call has no start to
        // close, and reporting it would put an unexplained event in the roster's history.
        if (!openCalls.delete(event.toolUseId)) return;
        emit({ kind: 'unit-acted', agentId, toolUseId: event.toolUseId, isError: event.isError });
        return;
      }

      case 'unknown': {
        const raw = isRecord(event.raw) ? event.raw : {};
        if (event.harnessType === 'system/thinking_tokens') {
          // The CUMULATIVE figure, never the delta: a reader wants "how much thinking has gone
          // into this", and summing deltas here would drift from the harness's own count on every
          // dropped or coalesced event.
          const total = raw['estimated_tokens'];
          if (typeof total !== 'number' || !Number.isFinite(total)) return;
          const at = now();
          const quiet = at - lastThinkingAt >= THINKING_MIN_INTERVAL_MS;
          const grown = total - reportedTokens >= THINKING_MIN_TOKENS;
          if (!quiet && !grown) return;
          lastThinkingAt = at;
          reportedTokens = total;
          emit({ kind: 'unit-thinking', agentId, tokens: total });
          return;
        }
        // `system/permission_denied` is the LIVE denial. `permission_denial` is the same facts
        // replayed on the result event, which `recordDenials` already turns into signal rows —
        // five denials arrived twice on the reference run, and reporting both would show a reader
        // every refusal twice.
        if (event.harnessType === 'system/permission_denied') {
          const id = typeof raw['tool_use_id'] === 'string' ? raw['tool_use_id'] : '';
          if (id !== '' && reportedBlocks.has(id)) return;
          if (id !== '') reportedBlocks.add(id);
          emit({
            kind: 'unit-blocked',
            agentId,
            tool: typeof raw['tool_name'] === 'string' ? raw['tool_name'] : 'a tool',
            // The call as it was announced a moment ago. Empty when the denial names an id this
            // translator never saw — a bookkeeping tool, or a denial that arrived first.
            target: openCalls.get(id) ?? '',
            reason: typeof raw['message'] === 'string' ? raw['message'] : 'no reason given',
          });
        }
        return;
      }

      default:
        return;
    }
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

/**
 * `resolveProjectRoot`, with `enlist`'s auto-init in front of the refusal.
 *
 * The field transcript this exists for: `enlist` learned to turn a bare directory into a
 * repository, and then the very next thing the Commander typed — `army chat` in that same fresh
 * directory — refused with the sentence `enlist` had just been taught not to say. One CLI, one
 * policy: any command a user can point at a bare directory runs the same decide → init →
 * re-resolve sequence, built from the same two functions `enlist` uses, so the guards (never the
 * home directory, never a filesystem root) cannot drift between commands.
 *
 * `needs` finishes the refusal sentence — chat and campaign each name what they need a repository
 * FOR — and `onCreated` is where the `created a git repository in <dir>` line goes, because chat
 * owns a terminal and campaign owns a narration stream and this function must own neither.
 */
export async function resolveProjectRootOrInit(options: {
  cwd: string;
  /** `--no-init` turns this off; the refusal is then exactly the pre-auto-init one. */
  init: boolean;
  needs: string;
  onCreated: (dir: string) => void;
}): Promise<string> {
  const { cwd, init, needs, onCreated } = options;
  let project = await resolveProjectRoot(cwd);
  // `project !== null` is not the same question as "this directory belongs to that project" —
  // `git rev-parse` walks up, so a new folder inside any repository resolves to that repository.
  // See `detachedFromEnclosingRepo` for the campaign that leased a worktree of an entire home
  // directory because of it.
  const detached = project !== null && init && (await detachedFromEnclosingRepo(cwd));
  if (init && (project === null || detached)) {
    // `detached` means an enclosing project EXISTS and is usable; `project === null` means there
    // is nothing to fall back to. Every failure below therefore refuses in the second case and
    // falls back in the first — a directory git cannot initialise is a reason to work on the
    // enclosing repo the way this command always did, never a reason to end a campaign that
    // would otherwise run.
    const enclosing = project;
    const decision = decideAutoInit(cwd, os.homedir());
    if (decision.kind === 'refuse') {
      if (enclosing === null) {
        // The reason already carries its own instruction ("cd into the project directory…"), so
        // the fix restates the action rather than offering `git init` — a runnable command HERE
        // would be a command that initialises the exact directory the guard just protected.
        throw new CampaignSetupError(
          `${cwd} is not inside a git repository, and one will not be created here: ${decision.reason}`,
          doThis('cd into the project directory and run this again'),
        );
      }
    } else {
      const outcome = await autoInitRepo(decision.dir);
      if (!outcome.ok) {
        if (enclosing === null) {
          throw new CampaignSetupError(
            `${cwd} is not inside a git repository, and creating one failed: ${outcome.error}`,
            initRepoFix(cwd),
          );
        }
      } else {
        onCreated(decision.dir);
        // Re-derive rather than trust `decision.dir` — the real root goes through
        // `mainRootFromCommonDir` and realpath, and shortcutting that here is how this route
        // would silently diverge from every other route to a project root in this file.
        project = await resolveProjectRoot(cwd);
      }
    }
  }
  if (project === null) {
    // Both halves of the fix, on purpose. `git init` alone lands the reader on the NEXT refusal
    // — a repository with no commit cannot be leased from.
    throw new CampaignSetupError(`${cwd} is not inside a git repository. ${needs}`, initRepoFix(cwd));
  }
  return project;
}

// ---------------------------------------------------------------------------------------------
// Behaviour coverage — is the verdict answering the same numbered list the spec asked?
// ---------------------------------------------------------------------------------------------

export interface CoverageReport {
  /** 1-based behaviour indices with no entry in the verdict. */
  missing: number[];
  /** Indices named more than once. */
  duplicated: number[];
  /** Indices outside 1..N. */
  outOfRange: number[];
  /** Indices the Inspector answered `not-verified`. */
  unverified: number[];
  /** True when every index 1..N appears exactly once. */
  complete: boolean;
}

/**
 * Whether a `Verdict` accounted for every numbered behaviour in a spec.
 *
 * PURE — this is the incident on `Verdict.behaviours` (`src/contracts/report.ts`) made
 * checkable rather than merely asked for: a spec listed six behaviours, clause 2 was never
 * implemented, and the verdict came back `findings: []`, `verdict: pass` because nothing
 * anywhere counted the clauses that were answered against the clauses that existed. This
 * function is that count.
 *
 * A spec with no behaviours, a missing spec, or a null verdict all answer `complete: true` with
 * every list empty — there is nothing to account for, and inventing a failure out of the absence
 * of a spec would block every free-text campaign, which asked no numbered questions to skip.
 *
 * `not-verified` is deliberately NOT a gap: it counts toward `missing`'s complement (the index
 * IS present) and is instead surfaced separately, in `unverified`, because it is the Inspector
 * telling the truth about what it could not check rather than omitting the clause — see
 * `renderBehaviourAccounting` in `orders.ts`. An index that is simply absent from the verdict is
 * the one thing this function refuses to wave through.
 */
export function behaviourCoverage(
  spec: TechnicalSpec | undefined,
  verdict: Verdict | null,
): CoverageReport {
  const total = spec?.behaviours.length ?? 0;
  const empty: CoverageReport = {
    missing: [],
    duplicated: [],
    outOfRange: [],
    unverified: [],
    complete: true,
  };
  if (total === 0 || verdict === null) return empty;

  const entries = verdict.behaviours ?? [];
  const counts = new Map<number, number>();
  const outOfRangeSet = new Set<number>();
  const unverifiedSet = new Set<number>();
  for (const entry of entries) {
    if (entry.behaviour < 1 || entry.behaviour > total) {
      outOfRangeSet.add(entry.behaviour);
      continue;
    }
    counts.set(entry.behaviour, (counts.get(entry.behaviour) ?? 0) + 1);
    if (entry.status === 'not-verified') unverifiedSet.add(entry.behaviour);
  }

  const missing: number[] = [];
  const duplicated: number[] = [];
  for (let i = 1; i <= total; i += 1) {
    const count = counts.get(i) ?? 0;
    if (count === 0) missing.push(i);
    if (count > 1) duplicated.push(i);
  }
  const outOfRange = [...outOfRangeSet].sort((a, b) => a - b);
  const unverified = [...unverifiedSet].sort((a, b) => a - b);
  const complete = missing.length === 0 && duplicated.length === 0 && outOfRange.length === 0;
  return { missing, duplicated, outOfRange, unverified, complete };
}

// ---------------------------------------------------------------------------------------------
// The campaign
// ---------------------------------------------------------------------------------------------

export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
  // The command layer refuses a blank objective at parse time; this is the same refusal for every
  // OTHER route in — programmatic callers most of all. Field-reproduced: `army campaign ""`
  // slipped past the missing-objective check (it counts positionals, and `""` is one), archived a
  // campaign with no title, and — because no objective means no spec — escalated the Engineer to
  // `UNSPECIFIED_BRIEF_EFFORT`, the most expensive possible way to do nothing. Refused HERE,
  // before the archive exists, because there is no campaign to hang a note on: same class as the
  // not-a-git-repository refusal below, thrown with its own `fix`.
  if (options.objective.trim() === '') {
    throw new CampaignSetupError(
      'an objective is required — the one given is empty or whitespace-only',
      doThis(`pass a real objective: ${invokedAs()} campaign "add a multiply function to calc.js"`),
    );
  }
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

  const activityFor = (agentId: string, root: string): ((event: SoldierEvent) => void) =>
    createActivityTranslator({ agentId, root, emit: progress });

  const loaded = await loadConfig({ home, env });
  const config = loaded.config;
  // ONE read, at the top, shared by every spec this campaign builds. Reading it per spawn would
  // let an Engineer and the Inspector reviewing its work run under different confinements, and a
  // reviewer confined more tightly than the worker is exactly how the 2026-08-07 campaign shipped
  // three verdicts whose headline criterion no reviewer could execute.
  const posture = config.permissions.mode;

  const project = await resolveProjectRootOrInit({
    cwd,
    init: options.init ?? true,
    needs: 'A campaign needs a repository to lease a worktree of.',
    onCreated: (dir) => {
      const message = `created a git repository in ${dir}`;
      // Streamed directly rather than through `note`, which holds `info` back from the live
      // stream — but a repository now exists that did not when the command was typed, and that
      // must not wait for the final report to be said.
      progress({ kind: 'note', level: 'info', message });
      note('info', 'auto-init', message);
    },
  });

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

  // Next to the ceiling on purpose. The ceiling says how far the WORK may travel; this says how
  // tightly the WORKER is held while producing it. A reader looking for either is looking at the
  // same moment of the run, and a posture that only appeared in a config file would be a posture
  // nobody reads.
  note(posture === 'unguarded' ? 'warn' : 'info', 'permissions', postureNotice(posture));

  // ---- the archive ----------------------------------------------------------------------
  const archiveRoot = config.archiveRoot;
  const campaignId = options.campaignId ?? uniqueCampaignId(archiveRoot, options.objective);
  const archiveConfig: ArchiveConfig = {
    archiveRoot,
    // So the schema refusal on an index written by an older release names a command this reader
    // can paste. `src/archive/**` cannot resolve it; this layer already has.
    self: invokedAs(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.dbFactory === undefined ? {} : { dbFactory: options.dbFactory }),
  };
  const archive = createCampaign(archiveConfig, {
    id: campaignId,
    project,
    title: options.objective,
  });

  /**
   * WHERE THE ARCHIVE REFUSES A RE-RUN. Before this run's first append, not at its first soldier.
   *
   * `recordAgentAttempt` already refuses a duplicate agent id, and by the time this campaign got
   * there it had opened a task and appended four signals into an archive it does not own. Those
   * files are append-only — that is the point of them — so those rows could not be taken back, and
   * a reader of the first run's campaign saw a task and four status signals from a run that did
   * literally nothing. Measured: `tasks.jsonl` 7 → 9 lines, `signals.jsonl` 9 → 13.
   *
   * Append-only is exactly why the answer is "ask earlier" rather than "clean up after". There is
   * no cleaning up after; the only moment at which the extra rows can be prevented is before the
   * first one exists. So the availability of `cpt-01` — which is where every run collides, because
   * ids are minted from 01 — is asked here, one statement after the archive opens and one
   * statement before it is written to.
   *
   * The consequence, stated because it is a real behaviour change and not an accident: this
   * refusal THROWS out of `runCampaign` instead of coming back as an `aborted` result with a note.
   * It has to. A note is narrated into a campaign, and narrating anything is the thing being
   * prevented. That puts it in the same class as `${cwd} is not inside a git repository` above —
   * a setup-time refusal, reported by the throw and given its `fix:` line by the command layer —
   * which is the honest class for it: nothing started, so there is no campaign to report on.
   *
   * `AgentIdInUseError` carries the id, the campaign and the time the first attempt started, and
   * `src/command/index.ts` and `src/command/chat.ts` both key on that type for the `fix:` line, so
   * the reader loses nothing by the diagnosis moving.
   *
   * On refusal the archive handle is CLOSED — it used to leak — but the campaign's status is left
   * exactly as found: a collision here means the record belongs to some other run (finished, or
   * crashed mid-flight, or live right now under the same `--id`), and a run that wrote nothing has
   * no standing to end it. `close()` writes no rows, so the record stays byte-identical.
   */
  try {
    archive.assertAgentIdAvailable(agentIdFor(1));
  } catch (error) {
    try {
      archive.close();
    } catch {
      /* the refusal is the report; closing is hygiene */
    }
    throw error;
  }

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

  // ---- the setup window ------------------------------------------------------------------
  //
  // Everything between the archive opening and the main `try` used to be unprotected: a throw
  // from `createTask` or `appendSignal` exited `runCampaign` with the archive OPEN, `campaign.json`
  // frozen at `status: "active"` and the task `in_flight` forever — `view` then showed a phantom
  // live campaign nobody could end. The main `finally` cannot cover this window (it needs `task`
  // to exist), so the window closes itself: on a throw the campaign is marked and the archive
  // closed, then the original error is rethrown for the command layer to report.
  //
  // `aborted`, not `failed`, by the campaign's own convention: the cleanup `finally` below maps
  // outcome `aborted` — nothing was dispatched — to status `aborted` and the task to `blocked`;
  // `failed` claims soldiers ran and lost, which would be a lie here.
  const task = ((): TaskRow => {
    let created: TaskRow | null = null;
    try {
      created = archive.createTask({ title: options.objective, status: 'in_flight' });
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
      return created;
    } catch (error) {
      // Per-step guards, same rule as the main cleanup: a cleanup failure must not replace the
      // error the caller is owed. The status write keys on what the archive says NOW rather than
      // on `settledBeforeThisRun` alone, so a campaign another run already closed keeps its
      // record — same property the main `finally` protects.
      const guard = (fn: () => void): void => {
        try {
          fn();
        } catch {
          /* the setup error is the report; cleanup must not mask it */
        }
      };
      guard(() => {
        if (created !== null && archive.getTask(created.id)?.status === 'in_flight') {
          archive.updateTask(created.id, { status: 'blocked' });
        }
      });
      guard(() => {
        if (archive.getCampaign().status === 'active') archive.setCampaignStatus('aborted');
      });
      guard(() => archive.close());
      throw error;
    }
  })();
  const branch = armyBranch(task.id);
  const orders: OriginalOrders = { objective: options.objective, project, taskId: task.id };

  // Mutable campaign state, so the `finally` block can settle EVERY lease whatever happened.
  let provider: Awaited<ReturnType<typeof selectWorktreeProvider>>['provider'] | null = null;
  /**
   * Every workstream that got as far as existing, in launch order.
   *
   * THE `finally` ITERATES THIS, and that is the whole reason it is a campaign-level array rather
   * than a local in the launcher. Property 2 of this file's header says "we do not know what
   * happened to a worktree" must be unreachable, and concurrency does not weaken the property, it
   * multiplies the number of trees it has to hold for. A workstream is pushed here the moment it
   * has an identity, BEFORE its lease is attempted, so a throw between the two settles a
   * `never-acquired` disposition instead of leaving nothing to settle.
   */
  const runs: WorkstreamState[] = [];
  let integrationTree: IntegrationTree | null = null;
  let integration: IntegrationDisposition | null = null;
  const attempts: AttemptRecord[] = [];
  let outcome: CampaignOutcome = 'aborted';
  let finalReport: Report | null = null;
  let finalVerdict: Verdict | null = null;
  /**
   * The branch `runLadder` actually made durable, or null.
   *
   * Read by lease settlement to decide whether durability has already been established for a given
   * tree. It used to be the boolean `delivery !== null`, which was exactly right while a campaign
   * had one branch and is a real hazard with N: delivery pushes the INTEGRATION branch, and every
   * workstream branch is still one release away from gone. Naming the branch rather than the fact
   * is what keeps N-1 of them from being skipped.
   */
  let deliveredBranch: string | null = null;
  /**
   * The acceptance gate's result on the INTEGRATED branch, or null when this campaign never ran one
   * there.
   *
   * A segmented campaign's gate is not any attempt's: it runs once, on the branch every workstream
   * merged onto, because the spec's `verify` commands describe the whole feature. It had nowhere to
   * live, so `CampaignResult.acceptance` read `attempts[last].acceptance`, which on a segmented
   * campaign is always null, because no workstream of several is judged on its own branch. Every
   * segmented campaign therefore printed "acceptance not run, no `verify` commands were checked
   * mechanically" whether or not the gate had run and passed. It failed safe and it was still a lie
   * about the one line `src/verify/gate.ts` exists to make trustworthy.
   */
  let integratedAcceptance: AcceptanceResult | null = null;
  /**
   * Test files reviewers wrote, HELD OUT OF HISTORY by this process until a validator runs them.
   *
   * ## Why they are held rather than committed where they were written
   *
   * Precondition 4 on `INSPECTOR_TEST_WRITE_RULES` says a reviewer's tests are re-run by a
   * `CPT·VALIDATOR`, in a process the reviewer does not own. That used to be enforced by passing
   * `validatorFollows: true` into `assertInspectorWriteContained` at the moment the inspector was
   * spawned — a claim about a FUTURE, asserted at a call site, which is precisely the shape this
   * codebase's permission model exists to avoid. It could not be false, because nothing computed
   * it; and it was routinely wrong, because the validator is skipped whenever any workstream ends
   * other than delivered, integration fails, the gate never passes inside the validation budget,
   * or an abort lands in between. Two workstreams, one refusal, `maxAttempts: 1`: zero validators
   * ran, both inspectors held all 27 write rules, and a reviewer's test sat committed on a
   * durable branch under a note saying the validator would run it.
   *
   * So the DURABLE ARTEFACT NOW FOLLOWS THE FACT. Nothing a reviewer writes is committed where it
   * was written. The content is lifted out of the workstream tree, the tree is put back exactly
   * as if the tests were temporary, and the files are re-applied to the INTEGRATION tree for the
   * acceptance gate and the validator to run. They become history only after a validator has
   * actually produced a verdict on a tree containing them — and if none ever does, they are
   * withdrawn and nothing on any branch ever claimed otherwise. `commitInspectorTests` refuses to
   * run without the validator that ran them, so the rule is checked at the one moment it is
   * decidable rather than predicted three thousand lines earlier.
   */
  interface HeldReviewerTest {
    /** Repository-relative, as `dirtyPaths` reported it. */
    path: string;
    content: string;
    /** The reviewer that wrote it, and the branch it was reviewing. For the commit message. */
    agentId: string;
    branch: string;
  }
  const heldTests: HeldReviewerTest[] = [];

  /**
   * Test files a validator has actually run and this process then committed, in landing order.
   *
   * CAMPAIGN-LEVEL, because the unit that has to run them is campaign-level: the `CPT·VALIDATOR`
   * is told these paths by name, which is what turns precondition 4 from "they will be run
   * eventually" into an instruction with a file list attached.
   */
  const inspectorTests: string[] = [];

  /**
   * Take a reviewer's test files out of the tree it wrote them in, content and all.
   *
   * Reads BEFORE the discard, obviously, and caps each file: a reviewer holding an editor can
   * write a gigabyte, and this content is carried in memory across the whole campaign. Over the
   * cap the file is left out with a note rather than truncated, because half a test file is not
   * a test file. A file that cannot be read at all is left out the same way.
   */
  const holdReviewerTests = (input: {
    worktree: string;
    branch: string;
    files: readonly string[];
    agentId: string;
  }): string[] => {
    const taken: string[] = [];
    for (const file of input.files) {
      const full = path.join(input.worktree, file);
      let content: string;
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile() || stat.size > REVIEWER_TEST_MAX_BYTES) {
          note(
            'warn',
            'authorship',
            `\`${file}\` written by ${input.agentId} is ${
              stat.isFile() ? `${String(stat.size)} bytes` : 'not a regular file'
            } and is not carried forward. It goes with the worktree, unrun and uncommitted.`,
          );
          continue;
        }
        content = fs.readFileSync(full, 'utf8');
      } catch (error) {
        note(
          'warn',
          'authorship',
          `\`${file}\` written by ${input.agentId} could not be read back (${
            error instanceof Error ? error.message : String(error)
          }), so it is not carried forward.`,
        );
        continue;
      }
      // Last writer wins, and it is announced: two inspectors on two workstreams can both
      // decide the same file is where their test belongs, and silently keeping the first would
      // make a reviewer's work vanish with no record of which one is on the branch.
      const existing = heldTests.findIndex((entry) => entry.path === file);
      if (existing !== -1) {
        note(
          'warn',
          'authorship',
          `\`${file}\` was written by ${heldTests[existing]?.agentId ?? 'an earlier reviewer'} ` +
            `and is now written again by ${input.agentId}. The later one is what a validator ` +
            'runs; the earlier one is in its own agent directory in the archive.',
        );
        heldTests.splice(existing, 1);
      }
      heldTests.push({ path: file, content, agentId: input.agentId, branch: input.branch });
      taken.push(file);
    }
    return taken;
  };

  /** True once the held tests are sitting in the integration tree, uncommitted. */
  let heldApplied = false;

  /** Write every held test into the integration tree. Nothing is committed by this. */
  const applyHeldTests = (worktree: string): void => {
    if (heldTests.length === 0) return;
    for (const entry of heldTests) {
      const full = path.join(worktree, entry.path);
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, entry.content);
      } catch (error) {
        note(
          'warn',
          'authorship',
          `\`${entry.path}\` could not be applied to the integration tree (${
            error instanceof Error ? error.message : String(error)
          }), so no validator will run it.`,
        );
      }
    }
    heldApplied = true;
  };

  /**
   * Put the integration tree back as if the held tests had never been applied.
   *
   * Called on every path that leaves the validation loop WITHOUT committing them, and that is
   * not tidiness: durability refuses a dirty tree, so an uncommitted reviewer test left behind
   * is a merged branch that cannot be made durable and an integration tree retained forever.
   */
  const withdrawHeldTests = async (worktree: string): Promise<void> => {
    if (!heldApplied) return;
    heldApplied = false;
    await discardWorkerWrites(
      worktree,
      heldTests.map((entry) => entry.path),
    );
  };

  /**
   * Did anything change the held tests after they were applied?
   *
   * The one thing the reviewer's own authorship reading cannot see. `dirtyBefore` is taken with
   * the held tests already in the tree, so they are dirty on both sides of the difference and a
   * validator that rewrote the very test it was asked to run would appear to have written
   * nothing at all. This reads the bytes instead.
   */
  const tamperedHeldTests = (worktree: string): string[] => {
    const out: string[] = [];
    for (const entry of heldTests) {
      try {
        if (fs.readFileSync(path.join(worktree, entry.path), 'utf8') !== entry.content) {
          out.push(entry.path);
        }
      } catch {
        out.push(entry.path);
      }
    }
    return out;
  };
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
  /** Set only on the attempt that DELIVERS. See `CampaignResult.unverifiedBehaviours`. */
  let unverifiedBehaviours: number[] = [];
  let delivery: LadderResult | null = null;
  /** The status this campaign intends to record, then what the archive says it recorded. */
  let intendedStatus: CampaignStatus = 'aborted';
  /**
   * The concurrency cap in force, clamped once and reported.
   *
   * Computed OUT HERE rather than beside the launcher because it is on the result, and a campaign
   * that ended before it reached the launcher still has to be able to say what its cap was. A
   * budget number that only exists on the successful path is a budget number nobody can audit
   * after a failure.
   */
  const maxConcurrentReported = Math.min(
    MAX_WORKSTREAMS,
    Math.max(1, options.maxConcurrentWorkstreams ?? DEFAULT_MAX_CONCURRENT_WORKSTREAMS),
  );

  /**
   * A step of the settlement that may fail without taking the settlement down with it.
   *
   * Hoisted out of the `finally` because settlement itself is: a workstream of several settles at
   * the end of its own pool slot, and the archive write that records it has to be as unable to
   * throw there as it is here. See the comment above the cleanup block for the failure that made
   * every one of these individually guarded.
   */
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

  /**
   * Settlement, one workstream at a time, whoever asks for it, exactly once per tree.
   *
   * Two callers, the end of a pool slot and the campaign's `finally`, and everything a settled
   * tree owes a reader happens HERE rather than at one of them: the disposition, the archive row,
   * the `lease-settled` lifecycle line, and the workstream task's closing status. Leaving the
   * bookkeeping at the `finally` would mean an operator watching a long campaign saw three trees
   * leased and none returned until it ended, which is the shape of a pool that is leaking.
   *
   * SERIALISED, because `settleLease` pushes a branch to the army mirror and letting
   * `maxConcurrent` of them do that at once would put concurrent writers on one ref store for no
   * gain. This chain is not a lock on the trees; it is a queue on the settling, and settling is
   * seconds of git next to a model session.
   */
  let settlementQueue: Promise<unknown> = Promise.resolve();
  const settleWorkstreamTree = async (ws: WorkstreamState): Promise<void> => {
    if (ws.settled || ws.lease === null || provider === null) return;
    const lease = ws.lease;
    const settle = (): Promise<LeaseDisposition> =>
      settleLease({
        archive,
        provider: provider as NonNullable<typeof provider>,
        lease,
        branch: ws.branch,
        project,
        archiveRoot,
        baseCommit: ws.baseCommit,
        // NAMED, not `delivery !== null`. Delivery pushed exactly one branch, and on a
        // segmented campaign that is the integration branch: reading the boolean would skip
        // durability for every workstream branch and then release the trees holding them.
        alreadyDurable: deliveredBranch !== null && deliveredBranch === ws.branch,
        note,
      });
    // `then(fn, fn)`: a settlement that threw must not wedge the queue behind it. The next tree
    // is exactly the thing the campaign still has to settle.
    const run = settlementQueue.then(settle, settle);
    settlementQueue = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      ws.leaseDisposition = await run;
    } catch (error) {
      // settleLease guards its own steps; this is the backstop for anything it did not
      // anticipate. Fail closed: a tree whose state we could not determine is HELD.
      const message = error instanceof Error ? error.message : String(error);
      const reason =
        `settling the lease threw (${message}), so the tree is held rather than reset. ` +
        "Leaking a worktree is recoverable; destroying a night's work is not.";
      note('error', 'lease', `${reason} Worktree RETAINED at ${lease.path}.`, retainedTreeFix(lease.path));
      ws.leaseDisposition = {
        state: 'retained',
        path: lease.path,
        leaseId: lease.leaseId,
        reason,
      };
    }
    ws.settled = true;
    guard('recording the lease disposition', () =>
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        kind: 'status',
        body: cap(`lease ${ws.leaseDisposition.state}: ${ws.leaseDisposition.reason}`),
        artifact: ws.leaseDisposition.path,
      }),
    );
    // The last lifecycle line for this tree, and the one a reader most needs on a campaign that
    // ended badly: whether it was returned or is being held with their work still in it.
    progress({
      kind: 'lease-settled',
      state: ws.leaseDisposition.state,
      path: ws.leaseDisposition.path,
      reason: ws.leaseDisposition.reason,
    });
    guard('closing the workstream task', () => {
      if (ws.taskId === task.id) return;
      if (archive.getTask(ws.taskId)?.status === 'in_flight') {
        archive.updateTask(ws.taskId, {
          status: ws.outcome === 'delivered' ? 'done' : ws.outcome === 'aborted' ? 'blocked' : 'failed',
          branch: ws.branch,
        });
      }
    });
  };

  // ---- signals — Ctrl-C is an order, not an outage --------------------------------------------
  //
  // The handler does exactly two things, both safe in a signal context: it kills the in-flight
  // soldier's process tree (a `dontAsk` worker must never outlive its supervisor), and it records
  // which signal arrived. Everything else — the abort note, `aborted`/`blocked` in the archive,
  // durability, the lease release — happens by TRANSLATING the signal into the campaign's own
  // control flow: `throwIfInterrupted` throws through the main try into the one `finally` that
  // already knows how to settle a campaign. A `process.exit` in the handler would skip all of it,
  // which is precisely the field failure being fixed.
  let interruptedBy: NodeJS.Signals | null = null;
  /**
   * Every soldier in flight, whose trees the handler kills. Added by `runSoldier`'s `onSpawn`,
   * removed when the process is down.
   *
   * A SET RATHER THAN ONE SOLDIER, and the difference is the whole of what concurrency does to
   * this handler. It used to be a single variable, correct because an Engineer and an Inspector
   * never ran at once. With N workstreams it would hold whichever soldier spawned last and Ctrl-C
   * would leave N-1 `dontAsk` workers running against worktrees whose supervisor had gone, which
   * is the exact field failure the handler exists for, multiplied.
   */
  const liveSoldiers = new Set<Soldier>();
  /** Named so the abort note can say WHOSE trees were killed, after the set is emptied. */
  let killedSoldierIds: string[] = [];
  const handledSignals: readonly NodeJS.Signals[] =
    options.handleSignals === true ? (['SIGINT', 'SIGTERM'] as const) : [];
  const exitCodeForSignal = (signal: NodeJS.Signals): number =>
    128 + (signal === 'SIGTERM' ? 15 : 2);
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interruptedBy !== null) {
      // The SECOND signal. The user is insisting, and a graceful path that cannot be escaped is
      // a hang with better manners — so this one exits now, cleanup unfinished, with the
      // conventional code. The soldier tree is already dead from the first signal.
      process.exit(exitCodeForSignal(interruptedBy));
    }
    interruptedBy = signal;
    // EVERY tree, not the newest. See `liveSoldiers`. The set is copied first because
    // `killSoldierTree` is synchronous but the pumps draining those processes are not, and a
    // handler must not iterate a collection something else is removing from.
    killedSoldierIds = [...liveSoldiers].map((soldier) => soldier.id);
    for (const soldier of [...liveSoldiers]) killSoldierTree(soldier);
    progress({
      kind: 'note',
      level: 'warn',
      message:
        `${signal} received — ` +
        (killedSoldierIds.length === 0
          ? 'no soldier is in flight; '
          : `killing the process trees of ${killedSoldierIds.join(', ')}; `) +
        'aborting the campaign and settling the archive and every lease (press again to exit immediately)',
    });
  };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');

  /**
   * The host asked this campaign to stop. `army chat`'s `/stop`; see `CampaignOptions.abortSignal`.
   *
   * Deliberately the SAME two steps `onSignal` takes, in the same order, and then the same
   * translation into `throwIfInterrupted` below, because the expensive half of stopping a
   * campaign is not noticing that it should stop, it is settling sixteen worktrees afterwards, and
   * that half must have one implementation. What it does NOT share is `process.exit`: a signal's
   * second press is an escape hatch from a graceful path that cannot be escaped, and a host that
   * is still running its own event loop has no business being exited from in here.
   */
  let abortRequested = false;
  const onAbortRequest = (): void => {
    if (interruptedBy !== null || abortRequested) return;
    abortRequested = true;
    // Copied first, for the reason `onSignal` copies: `killSoldierTree` is synchronous but the
    // pumps draining those processes are not, and this must not iterate a set something else is
    // removing from.
    killedSoldierIds = [...liveSoldiers].map((soldier) => soldier.id);
    for (const soldier of [...liveSoldiers]) killSoldierTree(soldier);
    progress({
      kind: 'note',
      level: 'warn',
      message:
        'stop requested: ' +
        (killedSoldierIds.length === 0
          ? 'no soldier is in flight; '
          : `killing the process trees of ${killedSoldierIds.join(', ')}; `) +
        'aborting the campaign and settling the archive and every lease',
    });
  };

  /**
   * The signal, translated into the campaign's own abort path. Called at every point the attempt
   * loop comes back from an await long enough for a human to have pressed Ctrl-C during it.
   */
  const throwIfInterrupted = (during: string): void => {
    if (interruptedBy === null && !abortRequested) return;
    const line =
      `${interruptedBy === null ? 'stopped on request' : `interrupted by ${interruptedBy}`} ` +
      `during ${during}: ` +
      (killedSoldierIds.length === 0
        ? 'no soldier was in flight'
        : `the process trees of ${killedSoldierIds.join(', ')} were killed`) +
      '. The campaign is aborted; anything committed is made durable and every lease is settled below.';
    note(
      'error',
      'aborted',
      line,
      noFix(
        'nothing is broken — the campaign stopped because you asked it to. The worktree line ' +
          'below says what happened to the work.',
      ),
    );
    try {
      archive.appendSignal({ fromAgent: GENERAL_AGENT_ID, kind: 'status', body: cap(line) });
    } catch {
      /* the abort is the report; a failed signal row must not replace it */
    }
    outcome = 'aborted';
    throw new CampaignAborted(line);
  };

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
    // Installed INSIDE the try so the finally below is what uninstalls them, whatever happens.
    // One listener per signal, removed by reference; a campaign that crashes out of setup a line
    // later still cleans them up.
    if (handledSignals.includes('SIGINT')) process.on('SIGINT', onSigint);
    if (handledSignals.includes('SIGTERM')) process.on('SIGTERM', onSigterm);
    // Here for the same reason, and `once` because a second abort has nothing left to add. An
    // ALREADY-aborted signal fires the handler now rather than never: a host that decided to stop
    // before this call returned must not have that decision quietly dropped.
    if (options.abortSignal !== undefined) {
      if (options.abortSignal.aborted) onAbortRequest();
      else options.abortSignal.addEventListener('abort', onAbortRequest, { once: true });
    }

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

    // ---- who exists, and what they are called ---------------------------------------------
    //
    // TWO COUNTERS, because two ranks are minted here. One id space would put a MAJOR under a
    // `cpt-` id in every note, every signal row and every archive directory, and the archive's
    // whole value is that a reader can tell who did what. `agentIdFor` still mints `cpt-01`
    // first, so `assertAgentIdAvailable(agentIdFor(1))` above is still asking about the id a
    // re-run actually collides on.
    const engineerCounter = { next: 1 };
    const nextAgentId = (): string => agentIdFor(engineerCounter.next++);
    const overseerCounter = { next: 1 };
    const nextOverseerId = (): string =>
      `maj-${String(overseerCounter.next++).padStart(2, '0')}`;

    /**
     * Hold a soldier in `liveSoldiers` for exactly as long as its process is up.
     *
     * `liveSoldier = soldier` / `liveSoldier = null` was correct when one soldier ran at a time.
     * With N it has to be add and remove, and the remove has to name the soldier it added rather
     * than clearing the set, or one workstream finishing would take every sibling out of the
     * signal handler's reach. Each call site gets its own tracker, so the pairing is local and a
     * missed release costs one stale entry in a set the handler tolerates rather than a soldier
     * the handler cannot find.
     */
    const trackSoldier = (): { onSpawn: (soldier: Soldier) => void; release: () => void } => {
      const held = new Set<Soldier>();
      return {
        onSpawn: (soldier: Soldier): void => {
          held.add(soldier);
          liveSoldiers.add(soldier);
        },
        release: (): void => {
          for (const soldier of held) liveSoldiers.delete(soldier);
          held.clear();
        },
      };
    };

    /** Once per campaign, not once per workstream. See where it is emitted. */
    let watchHintShown = false;

    /**
     * The overseer whose SEGMENTATION this campaign is running, so an overlap is ADDRESSED rather
     * than broadcast.
     *
     * Null until a segmentation is accepted, and null forever on a campaign that never asked for
     * one or whose overseer produced nothing usable, in which case the notification goes to the
     * GENERAL, which is the truth: with no accepted segmentation, this process is the rank above
     * the engineer and it is the one being told.
     *
     * SET ONCE, FROM THE SEGMENTATION, and not by `spawnOverseer`. It used to be assigned by every
     * spawn, which was correct only while overseers were spawned one at a time: a campaign with
     * several workstreams answers several questions at once, so the variable held whichever
     * question-answering overseer happened to be spawned last and an overlap raised in that moment
     * was addressed to a `maj-NN` that had nothing to do with the plan the overlap is against. An
     * overlap is a fact about a SEGMENTATION, so it is addressed to the unit that wrote one, and
     * that unit is decided before any engineer exists and never changes afterwards.
     */
    let overseerAgentId: string | null = null;

    /** A worker-named path as a repository-relative one, where it can be made so. */
    const relativeToTree = (file: string, worktree: string | null): string => {
      const cleaned = file.replace(/^\.\//, '');
      if (worktree === null) return cleaned;
      const base = worktree.endsWith('/') ? worktree : `${worktree}/`;
      // A path that is NOT under the tree is left absolute on purpose. An engineer writing
      // outside its own lease is the single most interesting thing this detector can see, and
      // shortening it would hide exactly the half that makes it interesting.
      return cleaned.startsWith(base) ? cleaned.slice(base.length) : cleaned;
    };

    /**
     * Tell the overseer that a workstream wrote outside its declaration.
     *
     * A NOTIFICATION AND NEVER A REFUSAL. `docs/main-flow.md` is explicit: a fence around the
     * files an engineer may touch turns a solvable merge into a blocked workstream. Nothing here
     * stops a write, nothing here fails a workstream, and the engineer is never told.
     *
     * Called from two places with two different truths behind them, and each claim says which:
     * live, from a tool call, while every sibling is still running; and complete, from the branch
     * diff, once the process is down.
     */
    const announceOverlaps = (
      ws: WorkstreamState,
      files: readonly string[],
      source: OverlapClaim['source'],
      byAgent: string,
    ): void => {
      const fresh = attributeOverlaps({
        declaration: ws.plan.expectedFiles,
        siblings: ws.siblings,
        files: files.map((file) => relativeToTree(file, ws.worktree)),
        source,
        known: ws.announced,
      });
      for (const claim of fresh) {
        ws.announced.add(claim.file);
        ws.overlaps.push(claim);
        const owner =
          claim.declaredBy === null
            ? 'no workstream declared it'
            : `${claim.declaredBy} declared it`;
        note(
          'warn',
          'overlap',
          `${ws.plan.id} wrote ${claim.file}, which is outside its own declaration (${owner}). ` +
            `Seen ${claim.source === 'tool-use' ? 'live, from the tool call' : 'in the branch diff'}. ` +
            'This is announced, not refused.',
        );
        try {
          archive.appendSignal({
            fromAgent: byAgent,
            toAgent: overseerAgentId ?? GENERAL_AGENT_ID,
            kind: 'status',
            body: cap(`overlap: ${ws.plan.id} wrote ${claim.file} (${owner}, ${claim.source})`),
          });
        } catch {
          /* an overlap is a notification; a failed row must not end a live engineer */
        }
      }
    };

    /** The workstream, its slice and its siblings, as its engineer is told about them. */
    const workstreamBrief = (ws: WorkstreamState): WorkstreamBrief => ({
      id: ws.plan.id,
      slice: ws.plan.slice,
      expectedFiles: ws.plan.expectedFiles,
      siblings: ws.siblings.map((sibling) => ({
        id: sibling.id,
        slice: sibling.slice,
        expectedFiles: sibling.expectedFiles,
      })),
    });

    // ---- the MAJ·OVERSEER -------------------------------------------------------------
    //
    // ONE SPAWN PATH, and `src/command/overseer.ts` does not have it. That module decides; this
    // closure is how a decision becomes a process, and it goes through the same
    // `buildSoldierSpec` every other worker goes through, so an overseer cannot be built without
    // the global deny-list, the posture, the archive rows or the narration.
    const spawnOverseer: OverseerSpawn = async (input): Promise<OverseerRun> => {
      const agentId = nextOverseerId();
      // MAJOR, and `WRITES_FILES.MAJOR` is false, so `permissionsFor` subtracts every write-capable
      // tool from whatever the role asked for. `ROLE_ALLOW.OVERSEER` asks for none, which is the
      // stronger half: there is nothing to subtract.
      const target = dispatchFor(config, 'OVERSEER', options.spec !== undefined);
      const spec = buildSoldierSpec({
        agentId,
        rank: 'MAJOR',
        role: 'OVERSEER',
        harness: target.harness,
        ...(target.model === undefined ? {} : { model: target.model }),
        ...(target.effort === undefined ? {} : { effort: target.effort }),
        // The PRIMARY CHECKOUT, not a lease. An overseer holds no editor and no shell, so there
        // is nothing it can do to the tree it stands in, and giving it one of the pool's sixteen
        // slots to read from would spend a worktree on a reader.
        cwd: project,
        orders: input.orders,
        outputSchemaPath: input.outputSchemaPath,
        home,
        posture,
      });
      // ITS OWN CHILD TASK, the same way the review is a child task of the work rather than a
      // second attempt at it. Two reasons, and the first is mechanical: `agents` is unique on
      // (task_id, attempt), so an overseer recorded against the campaign task as attempt 1 would
      // collide with the engineer that is also attempt 1 of that task. The second is that a
      // reader of `army view` should see "segment the feature" and "answer cpt-01's question" as
      // things that happened, with the unit that did them underneath.
      const overseerTask = archive.createTask({
        parentTaskId: task.id,
        title:
          input.purpose === 'segmentation'
            ? `segment: ${cap(options.objective, 100)}`
            : input.purpose === 'adjudication'
              ? `adjudicate a refused branch (${agentId})`
              : `answer a question (${agentId})`,
        status: 'in_flight',
      });
      archive.recordAgentAttempt({
        id: agentId,
        taskId: overseerTask.id,
        parentAgentId: null,
        rank: 'MAJOR',
        role: 'OVERSEER',
        harness: spec.harness,
        model: spec.model ?? null,
        effort: spec.effort ?? null,
        sessionId: spec.sessionId,
        depth: 1,
        status: 'running',
        worktreePath: project,
        leaseId: null,
        orders: input.orders,
        attempt: 1,
      });
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        toAgent: agentId,
        kind: 'order',
        body: cap(`${input.purpose}: ${options.objective}`),
        artifact: `agents/${agentId}/orders.md`,
      });
      progress({
        kind: 'unit-dispatched',
        agentId,
        rank: 'MAJOR',
        role: 'OVERSEER',
        harness: spec.harness,
        attempt: 1,
      });
      const tracked = trackSoldier();
      const run = await runSoldier(adapterFor(options, spec.harness), spec, archive, {
        onSpawn: tracked.onSpawn,
        onEvent: activityFor(agentId, spec.cwd),
      });
      tracked.release();
      recordDenials(archive, agentId, run.denials, note);
      archive.finishAgent(agentId, {
        status: interruptedBy !== null ? 'interrupted' : run.status === 'ok' ? 'exited' : 'failed',
        exitCode: run.exitCode,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
      });
      archive.updateTask(overseerTask.id, {
        status: run.status === 'ok' && run.structured !== undefined ? 'done' : 'failed',
      });
      progress({
        kind: 'unit-returned',
        agentId,
        rank: 'MAJOR',
        role: 'OVERSEER',
        status: run.status,
        summary: null,
      });
      return { agentId, structured: run.structured, status: run.status, errors: run.errors };
    };

    // ---- how many workstreams, and how many at once ------------------------------------
    const maxConcurrent = maxConcurrentReported;

    /**
     * The whole objective as one workstream.
     *
     * THIS IS THE PRE-WORKSTREAM CAMPAIGN, expressed in the new vocabulary rather than kept as a
     * separate branch of control flow. Every path that cannot or should not segment resolves to
     * it: no overseer asked for, an overseer that returned nothing usable, a segmentation that
     * still collided after its correction round, and a segmented plan with no way to merge it.
     * One shape means the untouched behaviour is the behaviour a test exercises, rather than a
     * second implementation kept alongside it.
     */
    const wholeObjective: WorkstreamPlan = {
      id: 'ws-01',
      slice: options.objective,
      expectedFiles: options.spec?.filesInScope ?? [],
    };

    /**
     * How this campaign opens its integration tree, when it needs one.
     *
     * The default is the real pooled implementation, built HERE rather than at the command layer,
     * so `army campaign --overseer` and a campaign driven from `army chat` both get one without
     * either of them knowing that integration exists. It takes the provider this campaign already
     * selected, because a second provider would mean a second managed root and a second
     * `max_trees` that nothing reconciles with the first.
     *
     * `CampaignOptions.openIntegrationTree` overrides it, and that seam is what lets every merge,
     * conflict and reconciliation path be exercised without a second repository on disk.
     */
    const openIntegration: OpenIntegrationTree =
      options.openIntegrationTree ??
      ((input) =>
        openIntegrationTree({
          ...input,
          provider: selection.provider,
        }));

    let plans: WorkstreamPlan[] = [wholeObjective];
    if (options.overseer === true) {
      const segmentation = await segmentFeature({
        spawn: spawnOverseer,
        renderBrief: (previousRejection) =>
          renderSegmentationBrief({
            orders,
            ...(options.spec === undefined ? {} : { spec: options.spec }),
            ...(options.scoutFindings === undefined ? {} : { scoutFindings: options.scoutFindings }),
            maxWorkstreams: MAX_WORKSTREAMS,
            maxConcurrent,
            ...(previousRejection === undefined ? {} : { previousRejection }),
          }),
        checkpoint: throwIfInterrupted,
      });
      if (segmentation.kind === 'segmented') {
        plans = segmentation.segmentation.workstreams;
        // The unit that owns this plan, and therefore the unit an overlap against it is addressed
        // to. The LAST of them: a correction round produces a second overseer, and the plan being
        // run is the one it wrote.
        overseerAgentId = segmentation.agentIds[segmentation.agentIds.length - 1] ?? null;
        note(
          'info',
          'segmentation',
          `${segmentation.agentIds.join(', ')} cut this feature into ${String(plans.length)} ` +
            `workstream(s) in ${String(segmentation.rounds)} round(s): ` +
            cap(segmentation.segmentation.rationale, 160),
        );
        archive.appendSignal({
          fromAgent: segmentation.agentIds[segmentation.agentIds.length - 1] ?? GENERAL_AGENT_ID,
          toAgent: GENERAL_AGENT_ID,
          kind: 'report',
          body: cap(
            `segmentation: ${plans.map((plan) => plan.id).join(', ')} — ` +
              segmentation.segmentation.rationale,
          ),
        });
        for (const plan of plans) {
          note(
            'info',
            'segmentation',
            `${plan.id}: ${cap(plan.slice, 160)} (${
              plan.expectedFiles.length === 0
                ? 'no files declared'
                : plan.expectedFiles.join(', ')
            })`,
          );
        }
      } else {
        // NOT A FAILURE OF THE CAMPAIGN. An overseer that could not produce a workable plan has
        // cost this run one model session and its parallelism; the work still gets done, by one
        // engineer against the whole objective, exactly as it would have with no overseer at all.
        note(
          'warn',
          'segmentation',
          `${segmentation.reason} Running one workstream over the whole objective instead.`,
          noFix(
            'a segmentation that does not come back is not a fault in this machine, and running ' +
              'the campaign again would ask the same model the same question. The campaign ' +
              'continues unsegmented, which is what it did before workstreams existed.',
          ),
        );
        plans = [wholeObjective];
      }
      throwIfInterrupted('segmentation');
    }

    /**
     * Whether this campaign integrates, which is the one question that changes its shape.
     *
     * A campaign with ONE workstream does not open an integration tree, does not merge, gates and
     * reviews that workstream's own branch, and delivers it. That is today's campaign, reached by
     * the same code, which is what makes "a campaign that segments into one workstream is
     * indistinguishable from today" a property rather than a hope.
     */
    // There is no branch here for "segmented with no way to merge". `openIntegration` above always
    // resolves to something, and an opener that FAILS is caught where it is called, which is the
    // honest place for it: the failure is a fact about this machine at that moment rather than a
    // fact about the plan. What would be wrong is segmenting and then discovering there is
    // nothing to merge onto, because N branches whose work never meets costs N times what one
    // engineer costs and delivers a fraction of the feature.
    const segmented = plans.length > 1;
    if (segmented) {
      note(
        'info',
        'workstream',
        `${String(plans.length)} workstreams, at most ${String(maxConcurrent)} running at once. ` +
          'Each holds its own worktree and its own branch for as long as it runs.',
      );
    }

    // ---- what the acceptance commands do BEFORE anybody works ---------------------------
    //
    // Taken while the tree is at base, because that is the only moment it is: attempt 2 runs in
    // the same worktree with attempt 1's branch still checked out, so a reading taken inside the
    // loop would be a reading of the previous Engineer's work.
    //
    // The reason it is worth the seconds it costs is a measured one. A campaign ran three
    // Engineers for 37.6 minutes and $8.86 — two of which SUCCEEDED, with tests passing — and
    // delivered nothing, because one of its six verify commands had been mangled into
    // `sh -c 'grep -q \"\\\"dependencies\\\": {}\" package.json'`, which exits 2 against any file
    // that has ever existed. Nothing in the system could tell that from a failing test, so it
    // retried twice more against a foregone conclusion.
    //
    // TAKEN ONCE PER GATED TREE, and a segmented campaign gates exactly one: the integration tree.
    // The spec's verify commands describe the WHOLE feature, so running them against one
    // workstream's partial branch would fail every workstream by construction and deliver nothing.
    const verifyCommands = options.spec?.verify;
    const takeVerifyBaseline = async (cwd: string): Promise<readonly VerifyBaseline[]> => {
      if (verifyCommands === undefined || verifyCommands.length === 0) return [];
      throwIfInterrupted('the acceptance baseline');
      const baseline = await runVerifyBaseline({
        commands: verifyCommands,
        cwd,
        ...(options.verifyRun === undefined ? {} : { run: options.verifyRun }),
        timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
      });
      for (const entry of baseline) {
        if (entry.exitCode === 0 && !entry.timedOut) continue;
        // A verify command failing at base is the NORMAL case — `node --test` should fail before
        // the feature exists, and warning about it every time would train a reader to skip the
        // one line that matters. So this is `info`, except for the two exit codes with which a
        // shell says it could not run the thing at all.
        const cannotExecute =
          entry.exitCode !== null && SHELL_CANNOT_EXECUTE.includes(entry.exitCode);
        note(
          cannotExecute ? 'warn' : 'info',
          'acceptance',
          `baseline: \`${entry.command}\` exits ${entry.timedOut ? 'timeout' : String(entry.exitCode)} ` +
            `against the untouched tree${cannotExecute ? ' — a shell could not execute it' : ''}`,
          cannotExecute
            ? noFix(
                'exit 126/127 is a shell saying the command is not executable or not found, ' +
                  'which is a fact about the command rather than about the work. It will exit ' +
                  'the same way after the Engineer, so this campaign cannot pass its own gate. ' +
                  'Fix the command in the spec.',
              )
            : undefined,
        );
      }
      return baseline;
    };

    // ---- what happens to a test a reviewer writes ---------------------------------------
    //
    // "Whether tests it writes are permanent or temporary follows the repo": permanent when the
    // spec named verification commands AND this repository has a test directory, temporary
    // otherwise. Both halves are needed and neither is enough. Verification commands are what will
    // actually RUN the test after the reviewer is gone; a test directory is the convention that
    // says where a test belongs here. Missing either, a committed test is a file on a branch that
    // nothing executes and nobody expected, which is worse than one that dies with the worktree,
    // because it looks like coverage.
    //
    // Computed ONCE, before any reviewer exists, so every inspector in this campaign is told the
    // same thing about what becomes of its work.
    const testsArePermanent =
      (options.spec?.verify?.length ?? 0) > 0 && hasTestDirectory(project);


    /**
     * Put one reviewer's refusal to the overseer, or take the fail-safe.
     *
     * Returns null when there is nobody to ask, which is a campaign without an overseer or without
     * a segmentation. NULL IS NOT `retry`: it means no adjudication happened at all, so the caller
     * writes no note and no signal about a decision nobody made, and falls through to the retry
     * path it had before this rung existed. That distinction is what keeps an unsegmented campaign
     * byte-identical — a campaign that gained an `info` note saying "nothing adjudicated" would
     * have gained a line the campaign before this wave did not print.
     */
    const adjudicateRefusal = async (input: {
      verdict: Verdict;
      reviewer: 'INSPECTOR' | 'VALIDATOR';
      branch: string;
      workstream?: WorkstreamBrief;
      spent: number;
      budget: number;
    }): Promise<FixDecision | null> => {
      if (options.overseer !== true || !segmented) return null;
      return adjudicate({
        spawn: spawnOverseer,
        renderBrief: () =>
          renderAdjudicationBrief({
            orders,
            ...(options.spec === undefined ? {} : { spec: options.spec }),
            verdict: input.verdict,
            reviewer: input.reviewer,
            branch: input.branch,
            ...(input.workstream === undefined ? {} : { workstream: input.workstream }),
            spent: input.spent,
            budget: input.budget,
          }),
        checkpoint: throwIfInterrupted,
      });
    };

    // ---- one workstream, start to finish -------------------------------------------------
    //
    // THE ATTEMPT LOOP, UNCHANGED IN SUBSTANCE and now parameterised by which workstream it is
    // running. Everything it used to read off the campaign — the branch, the tree, the task, the
    // lease, the baseline — it now reads off `ws`, and everything it used to write back to the
    // campaign it writes onto `ws`. For a campaign with one workstream the two are the same
    // values they always were.
    //
    // `ws.judged` is the one genuinely new branch. A workstream that is the whole campaign
    // carries the acceptance gate and the Inspector, as it always did. A workstream that is one
    // of several stops when its engineer reports done, and the gate and the single Inspector run
    // once, on the integrated branch. That is what this wave's brief asks for, and it is also the
    // only reading that can pass: a partial branch fails commands that describe a whole feature.
    //
    // ITS TREE IS ALREADY LEASED WHEN THIS RUNS, and returned after it. See `runWorkstream` below,
    // which is the pool slot: acquire, run, settle.
    const runWorkstreamAttempts = async (ws: WorkstreamState): Promise<void> => {
      const worktree = ws.worktree;
      const lease = ws.lease;
      if (worktree === null || lease === null) return;
      const branch = ws.branch;
      const wsTaskId = ws.taskId;
      const baseCommit = ws.baseCommit;
      const verifyBaseline = ws.verifyBaseline;
      ws.status = 'running';

      // ---- the attempt loop -------------------------------------------------------------
      const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
      let previousVerdict: Verdict | undefined;
      /** Set only when the PREVIOUS attempt was failed by the acceptance gate. See CHANGE 1/3. */
      let previousAcceptance: AcceptanceResult | undefined;
      /** Set only when the PREVIOUS attempt's verdict left one or more behaviours unaccounted for. */
      let previousMissingBehaviours: number[] | undefined;
      /** Set only when the PREVIOUS attempt failed at the harness level. See the engineer branch. */
      let previousFailure: string | undefined;
      /**
       * Verify commands the PREVIOUS attempt could not move off their baseline reading.
       *
       * Carried across attempts because one such command is a bad attempt and two in a row is a bad
       * command — see where this is consumed.
       */
      let unchangedPreviously = new Set<string>();
      /** Set only for the attempt that RESUMES a blocked one. See the question ladder below. */
      let answeredQuestion: AnsweredQuestion | undefined;
      /**
       * Question rounds this campaign has already spent.
       *
       * A question does not cost an attempt (see the ladder below), so something else has to keep
       * the loop finite: without this, an Engineer that asks, is answered, and asks again runs
       * forever on a human's patience and the account's balance. This is that bound, and it is
       * per WORKSTREAM rather than per attempt because two questions in a row are the same
       * conversation whichever process asked them.
       *
       * PER WORKSTREAM, not per campaign, and the distinction only appeared when there were several.
       * A campaign with one workstream is unchanged. With three, a per-campaign bound would let the
       * first workstream to get going spend the whole allowance and leave its siblings unable to
       * ask anything, which turns a budget into a race. A sibling's questions are a different
       * conversation about a different slice, so they get their own three. The cost is that the
       * ceiling on interruptions is now `MAX_QUESTION_ROUNDS` times the number of workstreams, and
       * the concurrency cap is what bounds that number.
       */
      let questionRounds = 0;

      /**
       * ONE QUESTION, CLIMBING. This is the ladder, and it now has all three of its rungs.
       *
       * ```
       * ◇ CPT·ENGINEER  reports blocked, with a question
       *      │
       *      ▼
       * ◈ MAJ·OVERSEER  the feature owner. Answers what it owns, declines the rest.
       *      │          Absent on a campaign that asked for no overseer, in which case
       *      │          this rung is skipped and the ladder is the one it always was.
       *      ▼
       * ☆ YOU           askHuman, or nobody, in which case the attempt ends
       * ```
       *
       * ## Why the climb is a function and not an `await options.askHuman(...)` at the call site
       *
       * Because the rung above went in without the rung below noticing. The middle rung was
       * designed for and left as a marked joint before the `askHuman` call, taking the same
       * `PendingQuestion` and answering with a string or declining with null. Filling it changed
       * this function and nothing else: the human rung is untouched, and the only thing a human
       * observes is that fewer questions arrive.
       *
       * ## The fail-safe direction is UP
       *
       * Three things can happen at the middle rung and two of them are identical to the caller: an
       * overseer that declines and an overseer that could not be reached both leave the question
       * where it was, on its way to a human. Nothing here may turn a question into an answer it did
       * not get, because an answer from this rung is acted on and never reviewed again.
       *
       * ## The question travels along an edge that already exists
       *
       * No selector is resolved and none is built. An agent knows its parent, the parent here is
       * this process, and `to_agent` on the query row is that parent by id. See the `to_selector`
       * note in `src/contracts/archive.ts`: until there is a unit to address that nobody was told
       * the id of, a resolver has nothing to resolve.
       */
      /**
       * Who produced the last answer this climb returned: an overseer's agent id, or null for a
       * human's.
       *
       * A separate variable rather than a richer return type, because `climb` is called from exactly
       * one place and its shape is what let the middle rung be inserted without the human rung
       * changing. What this buys is that the `answer` signal in the archive names the unit that
       * actually decided, so `army view` shows a question settled one rank down as exactly that.
       */
      let answeredBy: string | null = null;
      const climb = async (pending: PendingQuestion): Promise<string | null> => {
        answeredBy = null;
        // ---- RUNG 1: the MAJ·OVERSEER. -----------------------------------------------------
        //
        // Only when this campaign has one. A campaign run without `--overseer` has no feature owner
        // to ask, and this process does not stand in for one: a supervisor that answered a design
        // question out of its own head would be a process inventing intent, which is the thing
        // every gate in this file exists to stop.
        //
        // The answer, when there is one, is recorded as an `answer` signal in `raiseQuestion` below
        // exactly as a human's is, so `isAnswered` cannot tell the two apart and neither can a
        // reader of `army view`. What DOES tell them apart is `from_agent`: a human's answer comes
        // from the GENERAL, an overseer's from `maj-NN`, and the note says which.
        if (options.overseer === true) {
          const verdict = await askOverseer({
            spawn: spawnOverseer,
            pending,
            renderBrief: () =>
              renderOverseerQuestionBrief({
                orders,
                ...(options.spec === undefined ? {} : { spec: options.spec }),
                pending,
                ...(segmented ? { workstream: workstreamBrief(ws) } : {}),
              }),
            checkpoint: throwIfInterrupted,
          });
          if (verdict.kind === 'answered') {
            note(
              'info',
              'question',
              `${verdict.agentId} answered ${pending.agentId} without troubling a human: ` +
                `${cap(verdict.rationale, 160)}`,
            );
            answeredBy = verdict.agentId;
            // Already neutralised: `askOverseer` sanitises at capture, which is where the model's
            // return crosses into this process. `validateOverseerAnswer` caps it and refuses a
            // newline, which stops a forged `##` heading and nothing else. This string rides into
            // an `orders.md` a human may `cat` and into the archive.
            return verdict.answer;
          }
          if (verdict.kind === 'declined') {
            note(
              'info',
              'question',
              `${verdict.agentId} would not settle ${pending.agentId}'s question and passed it on: ` +
                `${cap(verdict.rationale, 160)}`,
            );
          } else {
            note(
              'warn',
              'question',
              `${verdict.reason} The question climbs to a human unchanged.`,
              noFix(
                'nothing is lost: an overseer that cannot answer is the case this rung was built ' +
                  'to fall through, and the question is about to be put to you directly.',
              ),
            );
          }
        }

        // ---- RUNG 2: the human. -----------------------------------------------------------
        //
        // A DELIBERATE, ACCEPTED DIVERGENCE FROM THE PRE-LADDER HEADLESS PATH, so nobody fixes it
        // back: a headless campaign now writes one `query` signal that stays permanently unanswered,
        // plus the note below. Before the ladder it wrote neither. That extra row is kept because an
        // unanswered query in an append-only log is TRUE HISTORY — the worker really did ask, and
        // nobody was there — and an operator reading `army view` afterwards wants to know a campaign
        // stopped on a question rather than only that an attempt ended. Everything else about this
        // path is unchanged: no hang, no prompt, the block ends the attempt.
        if (options.askHuman === undefined) {
          note(
            'warn',
            'question',
            `nothing above ${pending.agentId} can take a question: this campaign was started with ` +
              'no way to reach a human, so the block ends the attempt.',
            doThis(
              `ask the same objective again from \`${invokedAs()} chat\`, where a question reaches ` +
                'you and your answer resumes the work in the same worktree. Running headless is ' +
                'the deliberate default here: a campaign started from a script must not hang ' +
                'waiting for a keyboard nobody is at.',
            ),
          );
          return null;
        }
        try {
          const answer = await options.askHuman(pending);
          const trimmed = answer.trim();
          // A blank answer is not an answer. Treated as silence rather than passed on, because an
          // empty ANSWER section in the next brief is worse than no section: it reads as a decision
          // that was taken and says nothing.
          return trimmed === '' ? null : trimmed;
        } catch (error) {
          // A human who walked away, a closed pipe, a terminal that went down. None of those is a
          // reason to end a campaign that is holding a lease and a branch: the block falls through
          // to the path it would have taken with no `askHuman` at all.
          note(
            'warn',
            'question',
            `the question from ${pending.agentId} could not be put to a human ` +
              `(${error instanceof Error ? error.message : String(error)}); the block ends the ` +
              'attempt.',
          );
          return null;
        }
      };

      /**
       * Raise one blocked report's question, park the work, and wait.
       *
       * Both halves of the round land in the archive as signals: a `query` from the agent to its
       * parent, and an `answer` carrying `in_reply_to`. Whether the round actually completed is then
       * read back with `isAnswered`, which is `ANSWERED_QUERY_SQL`: a query is answered iff a reply
       * row exists. That read is not ceremony: it is the difference between "we called askHuman and
       * got a string" and "the log says this was answered", and the log is what `army view` and a
       * crash-recovering operator will see. There is no state column to set and none is added.
       */
      const raiseQuestion = async (
        report: Report,
        question: string,
        engineerId: string,
        attempt: number,
      ): Promise<string | null> => {
        // SANITISED HERE, AT CAPTURE, and this is the only call site that builds a
        // `PendingQuestion`. Three worker-authored strings are about to be printed on a human's
        // terminal, and `cap` collapses `\s` runs, which does not touch ESC, BEL, backspace, NUL,
        // the C1 range or `U+202E`. A question beginning with an erase-display and a cursor-home
        // deletes the supervisor-owned rows naming the agent, the task and the branch, and paints
        // its own heading in their place — the marking erased by the string it marks.
        //
        // Capture rather than render, on purpose: one call covers the terminal block, the `query`
        // signal body, the note below and the artifact file, where sanitising at the render site
        // would cover only the first of the four. It is in THIS layer rather than in
        // `src/contracts/question.ts` because every file under `src/contracts/` imports nothing at
        // all — it is the bottom layer, and `sanitize` lives in `src/view/`, which imports FROM it.
        // Reaching down from here costs nothing: `src/command/` already reads the view layer.
        const pending = pendingQuestionFrom({
          campaignId,
          taskId: wsTaskId,
          objective: options.objective,
          agentId: engineerId,
          rank: 'CAPTAIN',
          role: 'ENGINEER',
          attempt,
          branch,
          question: sanitize(question),
          summary: sanitize(report.summary),
          findings: report.findings.map((finding) => ({
            ...finding,
            message: sanitize(finding.message),
          })),
        });
        // The body cap is 280 and a question may be 500, so the row alone is not the record. When it
        // does not fit, the whole thing goes to a file and `artifact` points at it, which is what
        // `src/contracts/archive.ts` says the column is for. Under the cap the body IS the record
        // and the artifact stays the report the question came out of.
        const questionArtifact =
          cap(pending.question) === pending.question
            ? `agents/${engineerId}/report.json`
            : archive.writeAgentText(engineerId, QUESTION_FILENAME, `${pending.question}\n`);
        const query = archive.appendSignal({
          fromAgent: engineerId,
          toAgent: GENERAL_AGENT_ID,
          kind: 'query',
          body: cap(pending.question),
          artifact: questionArtifact,
        });
        note(
          'warn',
          'question',
          `${engineerId} is blocked and is asking: ${cap(pending.question, 160)}`,
        );
        // PARKED, in the archive, for as long as the question is outstanding. `army view` and a
        // second terminal both read this, and a task sitting at `in_flight` while nothing is running
        // is the shape of a campaign that has hung. The tree stays leased on purpose: the branch and
        // its commits are what the resumed attempt builds on.
        //
        // The row as it stood is read FIRST, because "put it back" below has to mean the whole row.
        // It used to restore `status` alone, so an unanswered question detached the agent from the
        // task permanently and the archive recorded a failed task nobody had worked on.
        const parkedAgentId = archive.getTask(wsTaskId)?.agent_id ?? null;
        archive.updateTask(wsTaskId, { agentId: null, status: 'blocked' });
        // PARKED, and its siblings keep running. This is the whole of what parking costs with
        // several workstreams: the tree stays leased because the branch and its commits are what
        // the resumed attempt builds on, this workstream's own async function is suspended on the
        // await below, and the pool's other workers are untouched because nothing here holds a
        // lock, a queue position or a shared cursor. A workstream whose question is never answered
        // stays `parked` on the result, which is the honest ending for one.
        ws.status = 'parked';
        note('info', 'workstream', `${ws.plan.id} is parked on a question and holds ${worktree}.`);

        const answer = await climb(pending);
        if (answer === null) {
          // Nothing answered. Put the task back exactly as it was found — `agentId` included —
          // because the caller is about to fall through to the pre-ladder path and that path expects
          // the task it would have had if this block had never run.
          archive.updateTask(wsTaskId, { agentId: parkedAgentId, status: 'in_flight' });
          ws.status = 'running';
          return null;
        }
        // The other half of the same rule. The answer is acted on in full — it rides into the next
        // Engineer's brief uncapped — so recording a truncation would make the archive disagree with
        // what actually happened to the work.
        const answerArtifact =
          cap(answer) === answer ? null : archive.writeAgentText(engineerId, ANSWER_FILENAME, `${answer}\n`);
        archive.appendSignal({
          // The unit that actually decided. A human's answer comes from the GENERAL, because the
          // GENERAL is what put it in front of them; an overseer's comes from the overseer, so a
          // reader of the archive can see which questions never reached a person.
          fromAgent: answeredBy ?? GENERAL_AGENT_ID,
          toAgent: engineerId,
          kind: 'answer',
          inReplyTo: query.seq,
          body: cap(answer),
          artifact: answerArtifact,
        });
        if (!archive.isAnswered(query.seq)) {
          // The reply row did not land, so by the only definition of answered-ness this system has,
          // the question is still open. Resuming anyway would brief a fresh Engineer with an answer
          // no reader of the archive can find.
          note(
            'error',
            'question',
            `the answer to ${engineerId}'s question did not land in the archive, so the query is ` +
              'still open by the only test there is. Not resuming on an answer nothing recorded.',
            runThis(`${invokedAs()} rebuild ${quoteArg(campaignId)}`),
          );
          archive.updateTask(wsTaskId, { agentId: parkedAgentId, status: 'in_flight' });
          ws.status = 'running';
          return null;
        }
        note('info', 'question', `answered ${engineerId}'s question; resuming in the same worktree.`);
        archive.updateTask(wsTaskId, { agentId: null, status: 'in_flight' });
        ws.status = 'running';
        return answer;
      };

      /**
       * Attempts charged against `maxAttempts`, and the number every budget check below reads.
       *
       * SEPARATE FROM `attempt`, which counts processes and never goes backwards. They are equal on
       * every campaign that never asks a question, which is why nothing else in this loop had to
       * change. They diverge for exactly one reason, stated where they diverge.
       */
      let charged = 0;
      let attempt = 0;
      while (charged < maxAttempts) {
        attempt += 1;
        charged += 1;
        // A signal that landed between attempts (or before the first) must not dispatch a fresh
        // soldier into a campaign the user has already ended.
        throwIfInterrupted(`the gap before attempt ${String(attempt)}`);
        // Attempt 1 reuses the id the lease was taken under. See `WorkstreamState.firstAgentId`:
        // minting a fresh one here would leave the pool recording `cpt-01` as the holder of a tree
        // `cpt-02` is working in, which is exactly the confusion a lease holder exists to prevent.
        const engineerId = attempt === 1 && ws.firstAgentId !== null ? ws.firstAgentId : nextAgentId();
        const engineerOrders = renderEngineerOrders({
          orders,
          branch,
          worktree,
          attempt,
          ...(previousVerdict === undefined ? {} : { previousVerdict }),
          ...(previousAcceptance === undefined ? {} : { previousAcceptance }),
          ...(previousMissingBehaviours === undefined ? {} : { previousMissingBehaviours }),
          ...(previousFailure === undefined ? {} : { previousFailure }),
          ...(answeredQuestion === undefined ? {} : { answeredQuestion }),
          ...(options.spec === undefined ? {} : { spec: options.spec }),
          // ABSENT for an unsegmented campaign, which is what keeps its orders.md byte-identical
          // to the document it produced before workstreams existed.
          ...(segmented ? { workstream: workstreamBrief(ws) } : {}),
          ...(ws.reconciliation === null ? {} : { reconciliation: ws.reconciliation }),
        });
        // Cleared the moment it is spent, so an answer briefs exactly the ONE attempt it was
        // obtained for. A decision that kept riding into later attempts would be indistinguishable
        // from the spec, which a human approved, and it was not approved that way.
        answeredQuestion = undefined;

        const engineerTarget = dispatchFor(config, 'ENGINEER', options.spec !== undefined);
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
          posture,
          // Approved with the spec; see `BuildSpecInput.verifyCommands`.
          ...(options.spec?.verify === undefined ? {} : { verifyCommands: options.spec.verify }),
          // Approved with the spec; see `BuildSpecInput.filesInScope`.
          ...(options.spec?.filesInScope === undefined ? {} : { filesInScope: options.spec.filesInScope }),
          // The one unit here that decomposes: it holds the worktree, the branch and the report;
          // its subordinates read and answer. Claude-only; `buildSoldierSpec` refuses otherwise.
          fanOut: engineerTarget.harness === 'claude',
        });

        archive.recordAgentAttempt({
          id: engineerId,
          taskId: wsTaskId,
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
        // BEFORE the dispatch line, which reads better and used to be load-bearing: the sink once
        // started its ticker on `unit-dispatched` and stopped it on the next event of any kind, so
        // a hint emitted afterwards silently cancelled the Engineer's clock. That is no longer true
        // — `createProgressSink` now restarts the ticker after any printed event while a unit is
        // still in flight, because activity events print constantly and the old rule would have
        // killed the clock on the first tool call. The ordering is now taste, not a constraint.
        // ONCE PER CAMPAIGN, not once per workstream. `attempt === 1` alone was enough while a
        // campaign had one line of work; with N it would print the same hint N times in the first
        // second, which is how the one line that tells a reader what to do next becomes noise.
        if (!watchHintShown) {
          watchHintShown = true;
          progress({ kind: 'watch-hint', campaignId });
        }
        progress({
          kind: 'unit-dispatched',
          agentId: engineerId,
          rank: 'CAPTAIN',
          role: 'ENGINEER',
          harness: engineerSpec.harness,
          attempt,
        });

        // ---- LIVE OVERLAP DETECTION, at the moment of the write --------------------------
        //
        // THIS IS THE HONEST HALF OF "the overseer is told while both engineers are still running".
        // What the harness reports, event by event, is a tool NAME and its input, so an editing
        // tool's `file_path` is visible the instant the call is made and the announcement really is
        // live: the sibling workstreams are still running, and the claim lands in the archive
        // addressed to the overseer before this engineer's process is down.
        //
        // WHAT IT CANNOT SEE, said plainly rather than left for someone to discover: a shell. An
        // engineer holds `Bash`, and under the shipped `unguarded` posture it holds a bare one, so
        // `sed -i`, a redirect, a code generator or a formatter writes a file this listener never
        // hears about. `writtenPaths` returns nothing for a command line on purpose, because
        // guessing a file list out of one produces a detector that is wrong in both directions.
        //
        // The complete reading is the branch diff, taken when the process is down and every byte it
        // wrote is on the branch. Both feed the same ledger; each claim carries which one saw it.
        //
        // WHAT NOBODY CAN DO WITH IT YET, also said plainly: nothing redirects a RUNNING engineer.
        // `runSoldier` closes stdin immediately after the orders, and there is no channel back into
        // a live worker on either harness. So the overseer is TOLD live and ACTS at the next
        // decision it is actually asked to make, which is integration.
        const narrateEngineer = activityFor(engineerId, engineerSpec.cwd);
        const watchEngineer = (event: SoldierEvent): void => {
          narrateEngineer(event);
          if (event.type !== 'tool_use') return;
          const paths = writtenPaths(event.name, event.input);
          if (paths.length > 0) announceOverlaps(ws, paths, 'tool-use', engineerId);
        };
        const engineerTracker = trackSoldier();
        const engineerRun = await runSoldier(
          adapterFor(options, engineerSpec.harness),
          engineerSpec,
          archive,
          // The signal handler above kills every tree in `liveSoldiers`. Added before orders are
          // sent, removed as soon as the soldier is down — a handler must never kill a tree from a
          // PREVIOUS attempt, and with siblings running it must never miss one of theirs.
          {
            onSpawn: engineerTracker.onSpawn,
            onEvent: watchEngineer,
          },
        );
        engineerTracker.release();
        recordDenials(archive, engineerId, engineerRun.denials, note);

        const reportResult = validateReport(engineerRun.structured);
        const report = reportResult.ok ? reportResult.value : null;
        const record: AttemptRecord = {
          workstreamId: ws.plan.id,
          attempt,
          engineerAgentId: engineerId,
          inspectorAgentId: null,
          report,
          verdict: null,
          engineerStatus: engineerRun.status,
          costUsd: engineerRun.costUsd,
          acceptance: null,
        };
        attempts.push(record);
        // The per-workstream index into `attempts`. Written at the same point as the rich record so
        // the two cannot drift: one loop, one push each, one source of truth about how this attempt
        // ended.
        ws.attempts.push({
          attempt,
          engineerAgentId: engineerId,
          engineerStatus: engineerRun.status,
          reportStatus: report?.status ?? null,
        });

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
        // THE COMPLETE OVERLAP READING, taken with the process down and every byte it wrote on the
        // branch. It sees what the live detector cannot — anything a shell wrote — and it is the
        // reading integration is decided on. It arrives late, and late-and-true beats live-and-
        // hopeful: a workstream's neighbours are still running while its branch is being read, so
        // this is still an announcement rather than a post-mortem.
        announceOverlaps(
          ws,
          await branchFiles(worktree, branch, baseCommit),
          'branch-diff',
          engineerId,
        );
        archive.finishAgent(engineerId, {
          // `interrupted`, not `failed`, when the supervisor's own signal handler is what killed
          // it: a failure gets retried and diagnosed, an interruption was ordered. Same rule the
          // claude adapter applies on the wire (`claudeResultStatus` step 1) — our own knowledge
          // that we stopped it outranks how the process happened to die.
          status:
            interruptedBy !== null
              ? 'interrupted'
              : engineerRun.status === 'ok'
                ? 'exited'
                : 'failed',
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

        // AFTER the bookkeeping above, deliberately: the killed attempt's agent row, report.md,
        // diff and signals are all real evidence and all written before the abort unwinds. BEFORE
        // the retry branch below, equally deliberately: a soldier this campaign killed on the
        // user's order must not be diagnosed as a failure and retried with a fresh one.
        throwIfInterrupted(`attempt ${String(attempt)} (${engineerId})`);

        // ---- THE QUESTION LADDER --------------------------------------------------
        //
        // BEFORE the failure branch below, because until this block existed `blocked` fell into it
        // and a question was a terminal state: the raise half of the mechanism shipped with
        // `REPORT_STATUSES`, and nothing caught it. The acceptance gate only runs on `done`, so an
        // Engineer that stopped to ask got the same treatment as one that crashed.
        //
        // ## A question and its answer do NOT cost an attempt
        //
        // `maxAttempts` is the retry budget, and a retry is what follows a FAILURE: an Inspector
        // that rejected the work, a gate that refused it, a process that died. A human answering a
        // question is none of those. The Engineer did the right thing by stopping, and charging it
        // an attempt would mean the worker that asks gets fewer tries at the work than the one that
        // guesses, which is precisely the behaviour this whole path exists to encourage.
        //
        // The budget is the human's contract ("three Engineer attempts") and it is untouched: the
        // resumed attempt is still attempt N of N. What keeps the loop finite instead is
        // `MAX_QUESTION_ROUNDS`, a separate bound on a separate thing, so neither number has to
        // stand in for the other.
        //
        // The resumption itself invents nothing. It is the SAME machinery an Inspector FAIL already
        // drives, a new agent against the same task in the same worktree, briefed with what it
        // needs to know, for the reason on this file's header: a task is intent, an agent is one
        // process against it, and a retry is a new process. So the only thing this block does is
        // decide whether the loop goes round again and what rides in the brief.
        if (report !== null && engineerRun.status === 'ok' && report.status === 'blocked') {
          const question = report.question;
          if (question === undefined) {
            // A LEGAL, TERMINAL STATE, and reachable: `validateReport` accepts a blocked report with
            // no question, deliberately (see `Report.question`). The alternative was refusing the
            // whole report and losing the worker's summary, findings and branch along with it, which
            // costs more than it saves. So the block falls through to the pre-ladder path below —
            // the attempt ends, and everything the worker DID say is already in the archive.
            note(
              'warn',
              'question',
              `${engineerId} reported blocked with no question, so there is nothing to raise. Its ` +
                'account of where it got to is in the report; the attempt ends here.',
            );
          } else if (questionRounds >= MAX_QUESTION_ROUNDS) {
            note(
              'warn',
              'question',
              `${engineerId} is blocked and asking again, but this campaign has already spent its ` +
                `${String(MAX_QUESTION_ROUNDS)} question rounds. Treating the block as the end of ` +
                'the attempt.',
              noFix(
                'a task that needs a fourth decision handed down mid-flight is a task whose brief ' +
                  'was not finished before it started. The questions and answers are all in the ' +
                  `archive at ${archive.root}; re-dispatch with them folded into the spec.`,
              ),
            );
          } else {
            questionRounds += 1;
            const answer = await raiseQuestion(report, question, engineerId, attempt);
            // The human may have taken minutes to answer, and Ctrl-C during those minutes means the
            // same thing it means anywhere else in this loop.
            throwIfInterrupted(`the question raised by ${engineerId}`);
            if (answer !== null) {
              // WHO DECIDED travels with the answer, because the two documents that read it say
              // different things depending on it. `answeredBy` is the overseer's id when the middle
              // rung settled it and null when a human did. It is the same value the `answer`
              // signal is attributed to, so the brief and the archive cannot disagree about who
              // decided.
              answeredQuestion = {
                question,
                answer,
                source: answeredBy === null ? { from: 'human' } : { from: 'overseer', agentId: answeredBy },
              };
              // The one line where the two counters diverge. See the block above for why.
              charged -= 1;
              continue;
            }
          }
        }

        if (report === null || engineerRun.status !== 'ok' || report.status !== 'done') {
          const why =
            report === null
              ? `returned no valid report (adapter status ${engineerRun.status})`
              : `reported status ${report.status}`;
          const diagnosis = diagnoseSoldierFailure({
            role: 'Engineer',
            agentId: engineerId,
            harness: engineerSpec.harness,
            campaignRoot: archive.root,
            status: engineerRun.status,
            errors: engineerRun.errors,
            structuredArrived: report !== null,
          });
          ws.report = report;
          // A harness-level failure consumes AN ATTEMPT, not the campaign. The contract with the
          // human is `maxAttempts` — the commander says "three Engineer attempts" out loud — and
          // the field failure this rewrites was one timed-out process ending a campaign that had
          // two budgeted attempts left. Only the FINAL attempt failing this way ends the loop.
          if (charged >= maxAttempts) {
            // The budget is spent: the campaign stops because there is nothing left to try, which
            // is exactly what `retriesExhausted` reports (and what rung 3's merge gate reads).
            ws.retriesExhausted = true;
            note(
              'error',
              'engineer',
              `${engineerId} ${why}. Not sending this to inspection.`,
              diagnosis,
            );
            ws.outcome = 'engineer-failed';
            return;
          }
          note(
            'warn',
            'engineer',
            // `charged`, not `attempt`: after a question round the two differ, and the number a
            // reader is owed here is the one the budget is measured in.
            //
            // NAMED AS A BUDGET rather than as an ordinal, and that is the whole of the wording.
            // `unit-dispatched` prints `(claude, attempt 4)` — the fourth PROCESS — and this line
            // used to answer it with `Failing attempt 1 of 3`, which reads as a contradiction a
            // reader has to work out for themselves. Two numbers, two vocabularies: one counts
            // processes, one counts what is left of the budget, and a question round moves only the
            // first.
            `${engineerId} ${why}. Attempt budget: ${String(charged)} of ${String(maxAttempts)} spent.`,
            diagnosis,
          );
          note(
            'info',
            'retry',
            'retrying with a fresh Engineer against the same task; the previous attempt produced ' +
              'nothing reviewable.',
          );
          // One supervisor-written sentence into the next attempt's orders — the same channel
          // `previousAcceptance` uses, and the same direction of travel: the adapter's status, not
          // the dead Engineer's narrative.
          previousFailure =
            `attempt ${String(attempt)} ended with adapter status ${engineerRun.status} and ` +
            (report === null ? 'produced no report' : `reported status ${report.status}`);
          archive.updateTask(wsTaskId, { agentId: null, status: 'in_flight' });
          continue;
        }
        // This attempt came back whole, so no stale harness-failure line from an EARLIER attempt
        // may ride into a LATER retry brief (a gate or verdict retry would otherwise carry it).
        previousFailure = undefined;
        ws.report = report;
        archive.updateTask(wsTaskId, { branch });

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

        // ---- THE ACCEPTANCE GATE -------------------------------------------------
        //
        // SKIPPED FOR A WORKSTREAM OF SEVERAL, and only this half is skipped. `spec.verify`
        // describes the WHOLE feature, so running it against a fraction of one would fail every
        // workstream by construction and deliver nothing. It runs once, on the integrated branch.
        // The REVIEW below is not skipped: a slice can be reviewed against its own slice, which is
        // what this wave adds. See `WorkstreamState.gated`.
        //
        // BEFORE the Inspector, not after, and this ordering is the whole point of the change. Two
        // reasons, both worth writing down rather than assuming they are obvious:
        //
        //   1. A branch that fails commands the SPEC ITSELF named as proof of done is not ready
        //      for a human-grade review — it is reviewing an intermediate state as if it were the
        //      final one.
        //   2. The Inspector runs on a metered vendor account whose quota is the scarcest thing in
        //      this whole pipeline. Spending it on a branch a mechanical check already refutes is
        //      exactly the waste this ordering exists to prevent.
        //
        // See `src/verify/gate.ts` for the incident this module exists for: a criterion
        // (`node expenses.js sample-expenses.json prints an aligned table`) left in prose, never
        // executed by anything, satisfied by an Engineer under a different reading of it, and
        // passed by an Inspector that only read the diff. `runAcceptanceGate` is the thing that
        // actually runs it — only when the Engineer claimed `done`; a `blocked` or `failed` report
        // already failed this attempt above, and the gate would add nothing to that.
        //
        // `{ ran: false }` FOR A WORKSTREAM OF SEVERAL, and it is deliberately not written onto
        // `record.acceptance`: `CampaignResult.acceptance` reads the last attempt's, and the
        // integrated gate is the one that ran. A `ran: false` on the record would compete with it
        // and win, which is the lie `integratedAcceptance` was added to stop.
        const acceptance: AcceptanceResult = ws.gated
          ? await runAcceptanceGate({
              ...(options.spec?.verify === undefined ? {} : { commands: options.spec.verify }),
              cwd: worktree,
              ...(options.verifyRun === undefined ? {} : { run: options.verifyRun }),
              timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
              baseline: verifyBaseline,
              // Reuses the campaign's own progress channel rather than a bespoke one — a gate
              // command starting and finishing is exactly the kind of "is this still alive"
              // narration `ProgressEvent`'s `note` kind already exists for.
              onProgress: (line) => progress({ kind: 'note', level: 'info', message: line }),
            })
          : { ran: false, passed: false, outcomes: [] };
        if (ws.gated) record.acceptance = acceptance;

        // The gate runs real `spec.verify` processes and can take as long as a test suite does —
        // long enough to be the thing a human interrupts.
        throwIfInterrupted(`the acceptance gate for attempt ${String(attempt)}`);

        if (acceptance.ran && !acceptance.passed) {
          const failedCommands = acceptance.outcomes
            .filter((outcome) => !outcome.passed)
            .map((outcome) => outcome.command);
          note(
            'error',
            'acceptance',
            `${engineerId}'s branch failed its own acceptance commands (${failedCommands.join(', ')}). ` +
              'Not spending an Inspector on a branch a mechanical check already refutes.',
            noFix(
              `the commands are the spec's own, run against ${branch} exactly as written — that is ` +
                'a fact about the work, not an environment fault. The full output is in ' +
                `${archive.root}/agents/${engineerId}/report.md, and it is carried into the next ` +
                'Engineer attempt directly.',
            ),
          );
          previousAcceptance = acceptance;
          previousVerdict = undefined;
          previousMissingBehaviours = undefined;

          // ---- a gate that cannot be passed is not a verdict on the work ----------------------
          //
          // A command that failed IDENTICALLY against the untouched tree did not measure anything
          // the Engineer did. Retrying spends another Engineer to reach the same exit code, which
          // is what turned one malformed `grep` into 37.6 minutes and $8.86 across three attempts,
          // two of which had produced working, tested code.
          //
          // This does NOT relax the gate. The campaign still delivers nothing — `src/verify/gate.ts`
          // is explicit that a gate which has verified nothing returns `passed: false`, and passing
          // on the surviving commands would be exactly the "quietly reported the same shape as a
          // passing gate" failure that module exists to prevent. What changes is only WHO is told
          // to fix it: this is reported as a defect in the spec, to the human, instead of as a
          // verdict on an Engineer who cannot do anything about it.
          const unrunnable = unrunnableCommands(acceptance);
          for (const outcome of unrunnable) {
            note(
              'warn',
              'acceptance',
              `\`${outcome.command}\` failed identically with and without the work — it exited ` +
                `${outcome.timedOut ? 'timeout' : String(outcome.exitCode)} against the untouched ` +
                'tree too, so on this attempt it did not distinguish the work from its absence.',
              noFix(
                'either the command cannot pass at all — a malformed one defines a done nobody can ' +
                  'reach — or this attempt did not change what it measures. Both are worth your ' +
                  `eye before another Engineer is spent. Its output is: ${outcome.output.split('\n')[0]}`,
              ),
            );
          }

          // ---- twice is a pattern; once is a bad attempt ---------------------------------------
          //
          // A command that says the same thing with and without the work is EVIDENCE that it cannot
          // read the work, but on its own it is not proof: an Engineer that committed something
          // useless produces the identical reading, and that Engineer deserves the retry it would
          // otherwise have had. Two attempts in a row is where the two explanations separate —
          // a second Engineer failing to move the same command the same way is the command's fault.
          //
          // This does NOT relax the gate. The campaign still delivers nothing; `src/verify/gate.ts`
          // is explicit that a gate which verified nothing returns `passed: false`, and passing on
          // the surviving commands would be exactly the failure that module exists to prevent. What
          // changes is only who is told to fix it, and how much is spent finding out.
          const unchangedNow = new Set(unrunnable.map((o) => o.command));
          const unchangedTwice = [...unchangedNow].filter((c) => unchangedPreviously.has(c));
          unchangedPreviously = unchangedNow;

          if (unchangedTwice.length > 0) {
            ws.retriesExhausted = true;
            note(
              'error',
              'retry',
              // Budget vocabulary, matching the Engineer-failure note above and for the same
              // reason: `attempt` counts processes and `maxAttempts` bounds the budget, so putting
              // the two on either side of an `of` was comparing two different things.
              `stopping with the attempt budget at ${String(charged)} of ${String(maxAttempts)}: ` +
                `${unchangedTwice.map((c) => `\`${c}\``).join(', ')} failed identically on two ` +
                'consecutive attempts AND against the untouched tree. No Engineer has moved it, so ' +
                'the next one will not either.',
              noFix(
                'treat this as a defect in the spec rather than in the branch: a verify command ' +
                  'defines done, so one that never changes defines a done nobody can reach. Fix the ' +
                  `command and re-run. The branch ${branch} is durable and holds what was built — it ` +
                  'was never judged, because the thing meant to judge it never read it.',
              ),
            );
            ws.outcome = 'engineer-failed';
            return;
          }

          if (charged >= maxAttempts) {
            ws.retriesExhausted = true;
            note(
              'error',
              'retry',
              `the acceptance gate failed on ${String(maxAttempts)} attempt(s); the retry budget (a ` +
                'CPT may retry an Inspector fail, and this is the same budget) is exhausted. Not ' +
                'delivering.',
              noFix(
                'the commands the spec named still fail — that is a verdict on the work, not an ' +
                  `environment fault, so there is nothing to run. The output is in ${archive.root}` +
                  '/agents/*/report.md; the branch is durable and can be picked up by hand.',
              ),
            );
            ws.outcome = 'engineer-failed';
            return;
          }
          note(
            'info',
            'retry',
            'retrying with a fresh Engineer against the same task; the acceptance gate failed.',
          );
          archive.updateTask(wsTaskId, { agentId: null, status: 'in_flight' });
          continue;
        }
        // This attempt's gate either passed or never ran — either way, nothing about acceptance is
        // why a LATER attempt would be retried, so any stale failure from an EARLIER attempt must
        // not keep riding along into the next brief.
        previousAcceptance = undefined;

        // ---- ITS OWN INSPECTOR, ON ITS OWN BRANCH -------------------------------------------
        //
        // EVERY workstream gets one, which is what this wave changes. Before it, a workstream of
        // several was accepted the moment its engineer said done and the integrated result got the
        // single review — so a slice that was quietly wrong was reviewed once, mixed in with four
        // others, by a unit reading a diff five times the size.
        //
        // BRIEFED FROM THE WORKSTREAM'S OWN ORDERS AND DIFF, never from the engineer's account. The
        // brief is built from `ws.plan` (the OVERSEER's segmentation, written before this engineer
        // existed) and from `branch`/`baseCommit`, which this process issued. Property 1 of this
        // file's header does not weaken because there are now several inspectors: they all go
        // through `judgeBranch`, which is the one function that can build a reviewer's brief.
        //
        // THE TEST WRITE, granted here and only here, and only on a SEGMENTED campaign — which is
        // exactly the campaign whose branches merge onto a branch a `CPT·VALIDATOR` judges.
        // An unsegmented campaign fields no validator, so precondition 4 does not hold for it, and
        // `buildSoldierSpec` refuses the grant rather than trusting this call site to remember.
        const changedByEngineer = await branchFiles(worktree, branch, baseCommit);
        const judged = await judgeBranch({
          taskId: wsTaskId,
          branch,
          worktree,
          baseCommit,
          leaseId: lease.leaseId,
          round: attempt,
          ...(segmented ? { workstream: workstreamBrief(ws) } : {}),
          ...(segmented
            ? { testWrite: { changedFiles: changedByEngineer, permanent: testsArePermanent } }
            : {}),
        });
        const inspectorId = judged.inspectorId;
        // ---- PRECONDITION 4, AND WHY NOTHING IS COMMITTED HERE -------------------------------
        //
        // This block used to commit the reviewer's test paths onto the branch it reviewed, under a
        // note saying "The VALIDATOR runs them on the integrated branch". That note preceded the
        // fact rather than following it: the validator is skipped whenever any workstream ends
        // other than delivered, integration fails, the gate never passes inside the validation
        // budget, or an abort lands in between — and the durable branch kept the test and the
        // claim regardless.
        //
        // So the files are HELD instead. The content comes out of this tree, the tree goes back to
        // exactly the state a temporary test leaves it in, and the validation loop re-applies them
        // to the integration tree where a gate and a validator actually run them. See `heldTests`.
        // Permanence still follows the repo, not a preference: `testsArePermanent` is "the spec
        // named verification commands AND this repository has a test directory". Missing either,
        // nothing is carried at all, which is the honest outcome for a test nothing would ever run.
        if (judged.wrote.length > 0) {
          const held =
            judged.containment === 'clean' && testsArePermanent
              ? holdReviewerTests({ worktree, branch, files: judged.wrote, agentId: inspectorId })
              : [];
          if (held.length > 0) {
            note(
              'info',
              'authorship',
              `${held.map((f) => `\`${f}\``).join(', ')} written by ${inspectorId} are HELD out of ` +
                `history. They are NOT on ${branch}: a reviewer's tests become part of a branch ` +
                'only once a VALIDATOR has actually run them, which happens on the integrated ' +
                'branch and not before.',
            );
          }
          // EVERYTHING GOES BACK, held or not, before this tree can be handed to another engineer.
          // See `discardWorkerWrites`: a reviewer's file that survives into a retry stops being the
          // reviewer's and starts being the next engineer's commit.
          await discardWorkerWrites(worktree, judged.wrote);
        }
        record.inspectorAgentId = inspectorId;
        const verdict = judged.verdict;
        // On the record BEFORE the null check, exactly as it was when this block was inline: a
        // reviewer that came back with nothing still gets an attempt row saying so.
        record.verdict = verdict;
        if (verdict === null) {
          ws.outcome = 'inspector-unavailable';
          return;
        }

        ws.verdict = verdict;

        // ---- BEHAVIOUR COVERAGE --------------------------------------------------
        //
        // Checked BEFORE the pass/fail branch below, and it can override a `pass`. See
        // `behaviourCoverage`: an Inspector that skipped a numbered clause has not reviewed the
        // work, whatever it wrote in `verdict`. Because `not-verified` is available and explicitly
        // blessed as the honest answer, full coverage is always achievable without lying — so a
        // clause with no entry at all is a gap in the REVIEW, not a limitation the campaign should
        // tolerate quietly. This is the mechanism for the incident on `Verdict.behaviours`: a
        // verdict of `findings: []`, `verdict: pass` that never recorded clause 2 had gone
        // unconsidered.
        const coverage = judged.coverage;
        if (!coverage.complete) {
          const gaps: string[] = [];
          if (coverage.missing.length > 0) gaps.push(`missing: ${coverage.missing.join(', ')}`);
          if (coverage.duplicated.length > 0) gaps.push(`duplicated: ${coverage.duplicated.join(', ')}`);
          if (coverage.outOfRange.length > 0) {
            gaps.push(`out of range: ${coverage.outOfRange.join(', ')}`);
          }
          note(
            'error',
            'coverage',
            `${inspectorId}'s verdict does not account for every numbered behaviour (${gaps.join('; ')}). ` +
              `Treating this attempt as failed even though the verdict said ${verdict.verdict} — a ` +
              'clause with no entry looks identical to a clean bill of health, and this campaign ' +
              'refuses to trust that silently.',
            noFix(
              'the gap is in the REVIEW, not necessarily the work — the Inspector could have ' +
                'marked the clause `not-verified` and did not. There is no command that fixes a ' +
                `missing review entry. Its verdict is in ${archive.root}/agents/${inspectorId}/` +
                'report.md; a fresh Engineer attempt is retried, and a fresh Inspector reviews it.',
            ),
          );
          previousMissingBehaviours = coverage.missing;
          previousVerdict = verdict.verdict === 'fail' ? verdict : undefined;
          if (charged >= maxAttempts) {
            ws.retriesExhausted = true;
            note(
              'error',
              'retry',
              `behaviour coverage stayed incomplete for ${String(maxAttempts)} attempt(s); the ` +
                'retry budget is exhausted. Not delivering.',
              noFix(
                `the Inspector's own review is what is incomplete, and its findings are in ` +
                  `${archive.root}/agents/*/report.md; the branch is durable and can be picked up ` +
                  'by hand.',
              ),
            );
            ws.outcome = 'inspector-failed';
            return;
          }
          note(
            'info',
            'retry',
            'retrying with a fresh Engineer against the same task; behaviour coverage was incomplete.',
          );
          archive.updateTask(wsTaskId, { agentId: null, status: 'in_flight' });
          continue;
        }

        if (verdict.verdict === 'pass') {
          note('info', 'inspector', `${inspectorId} PASSED ${branch}: ${cap(verdict.summary, 120)}`);
          ws.outcome = 'delivered';
          // Coverage is complete here by construction (the branch above `continue`d otherwise), so
          // `unverified` is exactly the set a human reading "delivered" still needs to see.
          ws.unverifiedBehaviours = coverage.unverified;
          return;
        }

        note('warn', 'inspector', `${inspectorId} FAILED ${branch}: ${cap(verdict.summary, 120)}`);
        previousVerdict = verdict;
        previousMissingBehaviours = undefined;

        // ---- THE FIX LOOP: FINDINGS GO TO THE OVERSEER ---------------------------------------
        //
        // THE GAP WAVE 3 FLAGGED RATHER THAN HID, closed. An unsegmented campaign retried on an
        // Inspector FAIL; a segmented one had no per-workstream review to fail, so it ended
        // `inspector-failed` on the integrated branch with no route back to any engineer. Now
        // each workstream has its own reviewer, and a refusal has somewhere to go.
        //
        // The overseer either asks for another engineer against the same workstream, briefed with
        // the findings, or accepts the workstream. It is the feature owner, and this is the
        // decision it is actually placed to make: whether a finding is worth an attempt out of a
        // budget its siblings cannot replenish.
        //
        // NOT ASKED ON AN UNSEGMENTED CAMPAIGN. There is no overseer to ask, this process does not
        // stand in for one, and the answer with no overseer is `retry` — which is what the line
        // below already does. That is what keeps this campaign byte-identical.
        const fix = await adjudicateRefusal({
          verdict,
          reviewer: 'INSPECTOR',
          branch,
          ...(segmented ? { workstream: workstreamBrief(ws) } : {}),
          spent: charged,
          budget: maxAttempts,
        });
        if (fix !== null && fix.decision === 'accept') {
          note(
            'warn',
            'workstream',
            `${fix.by ?? GENERAL_AGENT_ID} OVERRULED ${inspectorId}'s refusal of ${ws.plan.id}: ` +
              `${cap(fix.rationale, 160)}. The branch integrates with the finding still in it, and ` +
              'the VALIDATOR sees the assembled result.',
          );
          archive.appendSignal({
            fromAgent: fix.by ?? GENERAL_AGENT_ID,
            toAgent: GENERAL_AGENT_ID,
            kind: 'status',
            body: cap(`adjudication: accept ${ws.plan.id} over ${inspectorId}'s fail — ${fix.rationale}`),
          });
          ws.outcome = 'delivered';
          ws.unverifiedBehaviours = coverage.unverified;
          return;
        }
        if (fix !== null) {
          archive.appendSignal({
            fromAgent: fix.by ?? GENERAL_AGENT_ID,
            toAgent: GENERAL_AGENT_ID,
            kind: 'status',
            body: cap(`adjudication: retry ${ws.plan.id} — ${fix.rationale}`),
          });
          note(
            'info',
            'workstream',
            `${fix.by === null ? 'nothing could adjudicate' : `${fix.by} adjudicated`} ` +
              `${inspectorId}'s refusal of ${ws.plan.id}: retry. ${cap(fix.rationale, 160)}`,
          );
        }
        if (charged >= maxAttempts) {
          // Recorded BEFORE the note and the break, so the flag is true from the instant the fact
          // is true rather than from the instant something happens to read it.
          ws.retriesExhausted = true;
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
          ws.outcome = 'inspector-failed';
          return;
        }
        note('info', 'retry', `retrying with a fresh Engineer against the same task.`);
        archive.updateTask(wsTaskId, { agentId: null, status: 'in_flight' });
      }

      // Falling out of the loop means the budget ran out with no branch above taking a decision.
      // Every path inside either returns or continues, so this is not reachable today; it is set
      // rather than left alone because the failure it guards is one-directional.
      // `retriesExhausted` is what rung 3's merge gate reads, and a stale `false` here would let
      // a merge through on evidence nobody produced.
      ws.retriesExhausted = true;
    };

    /**
     * Whether this machine has already been told it cannot give a reviewer its own vendor.
     *
     * ONCE PER CAMPAIGN. With per-workstream inspectors a segmented campaign fields N+1 reviewers,
     * and a downgrade is a fact about the MACHINE rather than about any one of them — repeating it
     * N times would turn the one line that says the review gate is weaker than it looks into part
     * of the scroll. Recorded the same way a retired worktree provider is: `warn`, with the reason.
     */
    let reviewerDowngradeShown = false;

    /**
     * THE REVIEW GATE, as one function, called from every place a branch is ever judged.
     *
     * An unsegmented campaign judges its one workstream's branch inside the attempt loop, exactly
     * where it always did. A segmented campaign now judges EACH workstream's branch as it finishes,
     * with an inspector briefed from that workstream's own slice and diff, and then the INTEGRATED
     * branch once, with a `CPT·VALIDATOR`. All of them go through here, so property 1 of this
     * file's header — the GENERAL spawns the reviewer and briefs it from the ORIGINAL ORDERS — has
     * one implementation rather than three that have to be kept saying the same thing. Property 1
     * does not weaken because there are now several inspectors; it is enforced in exactly one place
     * and that place is called more often.
     *
     * It DECIDES NOTHING about retries. It spawns, records, and hands back the verdict, its
     * coverage and what the reviewer wrote; whether a null verdict ends a workstream or a campaign,
     * and whether a `fail` is worth another Engineer, is the caller's question and the callers
     * answer it differently.
     */
    const judgeBranch = async (input: {
      /** The task the review hangs off as a child. */
      taskId: string;
      branch: string;
      worktree: string;
      baseCommit: string | null;
      /** The lease the reviewer's tree belongs to, or null for the integration tree. */
      leaseId: string | null;
      /** 1-based review round, for the brief and the task title. */
      round: number;
      /**
       * Which reviewer this is. An `INSPECTOR` reviews a diff; a `VALIDATOR` judges the integrated
       * result against the ORIGINAL ask, runs the spec's commands, and reads the gate's mechanical
       * output as evidence. Defaults to `INSPECTOR`, which is every call site that existed before.
       */
      role?: 'INSPECTOR' | 'VALIDATOR';
      /** The slice under review, when this branch is one workstream of several. */
      workstream?: WorkstreamBrief;
      /** VALIDATOR only: what merged onto this branch, and what the gate did to it. */
      validation?: {
        workstreams: readonly string[];
        acceptance: AcceptanceResult | null;
        inspectorTests: readonly string[];
      };
      /** INSPECTOR only: grant the scoped test write, contained against these changed files. */
      testWrite?: { changedFiles: readonly string[]; permanent: boolean };
    }): Promise<{
      inspectorId: string;
      verdict: Verdict | null;
      coverage: CoverageReport;
      /** Repository-relative paths the reviewer changed in its tree. Empty when it held no editor. */
      wrote: string[];
      /** Paths among them this role was not allowed to write. Non-empty means a breach. */
      strayed: string[];
      /**
       * Whether the reviewer stayed inside what it was allowed to write, or whether anyone knows.
       *
       * `clean` is the ONLY value on which the verdict survives, and the only one on which
       * anything the reviewer wrote may be kept.
       */
      containment: 'clean' | 'strayed' | 'unread';
    }> => {
      const { branch, worktree, taskId, baseCommit, leaseId, round } = input;
      const role: 'INSPECTOR' | 'VALIDATOR' = input.role ?? 'INSPECTOR';
      // ---- THE REVIEW GATE ----------------------------------------------------
      //
      // The GENERAL spawns the reviewer, briefed from `orders` — the ORIGINAL objective, held
      // verbatim since the command line — plus `branch`, which THIS process cut via
      // `armyBranch(taskId)` before the Engineer existed.
      //
      // Note what is NOT here: `report`. Neither `briefInspectorFromAttempt` nor `briefValidator`
      // has a parameter that can receive one. That is not politeness — an earlier version took the
      // report and projected it to a single "safe" field, and the projection had a hole:
      // `Report.branch` is model-controlled free text, so a hostile Engineer wrote a fake
      // "SUPPLEMENTARY BRIEF FROM THE GENERAL" into it and it reached the Inspector's orders.md and
      // the codex argv. A filter with one unclassified field is not a gate. See orders.ts.
      //
      // THE WORKSTREAM BRIEF IS NOT AN EXCEPTION TO THAT. `slice` and `expectedFiles` come from the
      // OVERSEER's segmentation, which was written before any engineer existed and is validated,
      // capped and sanitised at capture. The party under review could not have authored it.
      const inspectorId = nextAgentId();
      const inspectorBrief =
        role === 'VALIDATOR'
          ? briefValidator({
              orders,
              branch,
              worktree,
              ...(baseCommit === null ? {} : { baseCommit }),
              round,
              ...(options.spec === undefined ? {} : { spec: options.spec }),
              workstreams: input.validation?.workstreams ?? [],
              acceptance: input.validation?.acceptance ?? null,
              inspectorTests: input.validation?.inspectorTests ?? [],
            })
          : briefInspectorFromAttempt({
              orders,
              branch,
              worktree,
              ...(baseCommit === null ? {} : { baseCommit }),
              round,
              // Supervisor's own copy, never the Report's. See `SupervisorFacts` in orders.ts for
              // why this is a safe origin and `Report` is not.
              ...(options.spec === undefined ? {} : { spec: options.spec }),
              ...(input.workstream === undefined ? {} : { workstream: input.workstream }),
              ...(input.testWrite === undefined
                ? {}
                : { testWrite: { permanent: input.testWrite.permanent } }),
            });

      // A DIFFERENT VENDOR FROM THE ENGINEER, where this machine has one. `dispatchFor` alone
      // answers "where does a reviewer go"; it does not answer "is that actually a different
      // vendor from the worker under review", and on a machine configuring one provider the two
      // answers differ. See `reviewerDispatch` for the downgrade and why it is a note rather than
      // a refusal.
      const engineerHarness = dispatchFor(config, 'ENGINEER', options.spec !== undefined).harness;
      const reviewer = reviewerDispatch(config, role, engineerHarness, options.spec !== undefined);
      const inspectorTarget = reviewer.target;
      if (reviewer.downgraded && !reviewerDowngradeShown) {
        reviewerDowngradeShown = true;
        note(
          'warn',
          role === 'VALIDATOR' ? 'validator' : 'inspector',
          `only one harness (${engineerHarness}) is configured on this machine, so every reviewer ` +
            'runs on the same provider as the engineer whose work it is reviewing. The review ' +
            'still happens and still fails closed; what it no longer has is vendor independence, ' +
            'which is what the gate rests on when a model shares a blind spot with itself.',
          doThis(
            `configure a second provider in ${configPath(home)} under \`[[dispatch.rules]]\` — a ` +
              'reviewer on the other vendor is the whole reason the split exists.',
          ),
        );
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          kind: 'status',
          body: cap(`reviewer downgrade: only ${engineerHarness} is configured; no vendor split`),
        });
      }
      // TWO SPEC LITERALS RATHER THAN ONE WITH A `role` VARIABLE, and that is deliberate rather
      // than duplication nobody tidied. `spawnedRoles` in the contracts suite derives WHICH ROLES
      // THIS BUILD ACTUALLY FIELDS by reading `role: '<ROLE>',` out of `src/**`, and that derivation
      // is what makes `army --help`'s roster fail when a role starts or stops being spawned instead
      // of quietly outdating. A shorthand `role,` here would field a `CPT·VALIDATOR` that no
      // document in the repository knows about — which is exactly the drift the scanner exists to
      // catch, defeated by the one call site it was watching. The two branches also carry different
      // extras, and each now carries only its own.
      // The VALIDATOR's extra is `verifyCommands` — running the spec's commands against the
      // integrated branch is its whole job, and it is why the ENGINEER-only refusal inside
      // `buildSoldierSpec` was widened to exactly two roles rather than dropped. The INSPECTOR's is
      // `testWrite`, whose `validatorFollows` is precondition 4 checked at the one place a spec is
      // built rather than trusted to this call site.
      // Written out twice rather than built from a shared object literal, and that is the second
      // half of the same reason: the contracts suite reads each spec-builder call block
      // whole and checks that the reviewer is handed `cwd: worktree` — the tree the party under
      // review stood in — so a field hidden behind a spread would take the check with it.
      let inspectorSpec: SoldierSpec;
      if (role === 'VALIDATOR') {
        inspectorSpec = buildSoldierSpec({
          agentId: inspectorId,
          rank: 'CAPTAIN',
          role: 'VALIDATOR',
          harness: inspectorTarget.harness,
          ...(inspectorTarget.model === undefined ? {} : { model: inspectorTarget.model }),
          ...(inspectorTarget.effort === undefined ? {} : { effort: inspectorTarget.effort }),
          cwd: worktree,
          orders: inspectorBrief,
          outputSchemaPath: VERDICT_SCHEMA_PATH,
          home,
          posture,
          ...(options.spec?.verify === undefined ? {} : { verifyCommands: options.spec.verify }),
        });
      } else {
        inspectorSpec = buildSoldierSpec({
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
          posture,
          ...(input.testWrite === undefined
            ? {}
            : {
                testWrite: {
                  containment: inspectorWriteDeny(input.testWrite.changedFiles),
                },
              }),
        });
      }

      // Tasks nest. The review is a child task of the work, not a second attempt at it —
      // which is also what makes `army view` show the gate rather than hide it.
      const reviewTask = archive.createTask({
        parentTaskId: taskId,
        title:
          role === 'VALIDATOR'
            ? `validate ${branch} (round ${String(round)})`
            : `review ${branch} (round ${String(round)})`,
        status: 'in_flight',
      });
      archive.recordAgentAttempt({
        id: inspectorId,
        taskId: reviewTask.id,
        parentAgentId: null,
        rank: 'CAPTAIN',
        role,
        harness: inspectorSpec.harness,
        model: inspectorSpec.model ?? null,
        effort: inspectorSpec.effort ?? null,
        sessionId: inspectorSpec.sessionId,
        depth: 1,
        status: 'running',
        worktreePath: worktree,
        leaseId,
        orders: inspectorBrief,
        attempt: round,
      });
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        toAgent: inspectorId,
        kind: 'order',
        body: cap(
          role === 'VALIDATOR'
            ? `validate ${branch} against the original ask`
            : `review ${branch} against the original orders`,
        ),
        artifact: `agents/${inspectorId}/orders.md`,
      });
      progress({
        kind: 'unit-dispatched',
        agentId: inspectorId,
        rank: 'CAPTAIN',
        role,
        harness: inspectorSpec.harness,
        attempt: round,
      });

      // ---- WHAT WAS ALREADY DIRTY BEFORE THIS REVIEWER TOUCHED ANYTHING -------------------
      //
      // THE AUTHORSHIP READING IS A DIFFERENCE, NOT A SNAPSHOT, and this line is why. An Engineer
      // that reported `done` with uncommitted work still has that work sitting in the tree the
      // reviewer is about to stand in — that is a real and tested state (durability refuses and the
      // lease is RETAINED because of it). A snapshot taken afterwards would attribute the
      // Engineer's leftovers to the reviewer, discard a perfectly good verdict, and then, worse,
      // CLEAN THEM UP: the tree would be reset with the work gone and the lease released as if
      // nothing had been left behind.
      //
      // What the difference cannot see, stated rather than left to be found: a reviewer editing a
      // file the Engineer had ALREADY left dirty. That file is uncommitted, so it is not on the
      // branch under review and cannot reach one — the hazard this containment is about is a
      // reviewer changing what the branch says, and an uncommitted file says nothing.
      const dirtyBefore = await dirtyPaths(worktree);

      const inspectorTracker = trackSoldier();
      const inspectorRun = await runSoldier(
        adapterFor(options, inspectorSpec.harness),
        inspectorSpec,
        archive,
        // Same seam as the Engineer's: the signal handler kills whatever is in flight, and the
        // Inspector narrates its reading exactly as the Engineer narrates its writing. It is the
        // shorter of the two waits but not a short one, and it is the wait during which a reader
        // most wants to know whether anything is being RUN — see `Verdict.testsRun`.
        {
          onSpawn: inspectorTracker.onSpawn,
          onEvent: activityFor(inspectorId, inspectorSpec.cwd),
        },
      );
      inspectorTracker.release();
      recordDenials(archive, inspectorId, inspectorRun.denials, note);

      // ---- WHAT THE REVIEWER WROTE, read before its verdict is looked at ------------------
      //
      // PRECONDITION 3, AND THE ONLY HALF OF THE CONTAINMENT THAT HOLDS ON EVERY CONFIGURATION.
      // A reviewer holds no git, so everything it wrote is still uncommitted in its tree, and
      // `git status --porcelain` is the complete reading of it — modified, added, untracked alike.
      // It is taken for EVERY reviewer, editor or not: a reviewer that was granted nothing and
      // wrote something anyway is the single most interesting thing this reading can find, and a
      // check that only runs where a grant was issued cannot find it.
      //
      // WHAT EACH REVIEWER IS ALLOWED TO WRITE, in one expression, because the two roles differ
      // and the difference is the point. An INSPECTOR may write test paths: something runs them
      // afterwards. A VALIDATOR may write NOTHING — not even a test. It is the last agent of phase
      // 3, so a test it wrote would be executed only by the process whose verdict it supports,
      // which is precondition 4 inverted; and `ROLE_ALLOW.VALIDATOR` names no editor in the first
      // place, so anything at all in this reading is already a capability nobody granted it.
      const mayWrite = (file: string): boolean => role !== 'VALIDATOR' && isTestPath(file);
      const dirtyAfter = await dirtyPaths(worktree);
      const readable = dirtyBefore !== null && dirtyAfter !== null;
      const wrote =
        dirtyBefore === null || dirtyAfter === null
          ? []
          : dirtyAfter.filter((file) => !dirtyBefore.includes(file));
      const strayed = wrote.filter((file) => !mayWrite(file));
      /**
       * Whether the reviewer stayed inside what it was allowed to write — or whether anyone knows.
       *
       * Three values rather than a boolean because "it wrote outside its scope" and "the tree
       * could not be read" are different facts with the same consequence, and a reader owed an
       * explanation of a discarded verdict is owed the right one.
       */
      const containment: 'clean' | 'strayed' | 'unread' = !readable
        ? 'unread'
        : strayed.length > 0
          ? 'strayed'
          : 'clean';
      if (containment === 'unread') {
        note(
          'error',
          'authorship',
          `the authorship reading could not be taken in ${worktree} — \`git status\` failed, so ` +
            `there is no way to say what ${inspectorId} wrote. Its verdict is discarded: an ` +
            'unreadable tree is not a clean tree, and this reading is the only containment that ' +
            'holds on every harness at every posture.',
          noFix(
            'nothing here is a defect in the work. The branch was not reviewed, so it is treated ' +
              'as unreviewed; the tree is settled and made durable below exactly as it would ' +
              'have been.',
          ),
        );
      }
      if (wrote.length > 0) {
        // ITS OWN SIGNAL, next to and separate from the `report` signal below carrying the verdict.
        // "It passed" and "it wrote the thing that passed" are two facts and a reader must be able
        // to see them apart.
        archive.appendSignal({
          fromAgent: inspectorId,
          toAgent: GENERAL_AGENT_ID,
          kind: 'status',
          body: cap(`wrote ${String(wrote.length)} file(s): ${wrote.join(', ')}`),
        });
        note(
          strayed.length === 0 ? 'info' : 'error',
          'authorship',
          strayed.length === 0
            ? `${inspectorId} wrote ${wrote.map((f) => `\`${f}\``).join(', ')} — test paths, ` +
              'which is what it was granted.'
            : role === 'VALIDATOR'
              ? `${inspectorId} WROTE in the integrated tree (${strayed
                  .map((f) => `\`${f}\``)
                  .join(', ')}). A VALIDATOR is granted no editor and may write nothing at all, ` +
                'test paths included: it is the last agent of phase 3, so nothing runs after it ' +
                'and a test it wrote would be executed only by the run whose verdict it supports. ' +
                'Its verdict is discarded and the files are put back.'
              : `${inspectorId} wrote OUTSIDE the test paths (${strayed
                  .map((f) => `\`${f}\``)
                  .join(', ')}). Its verdict is discarded: a reviewer that edits the code under ` +
                'review can make its own verdict pass, and there is no way to tell from the verdict ' +
                'which one this was.',
          strayed.length === 0
            ? undefined
            : noFix(
                'nothing here is broken and there is no command to run. The branch was not ' +
                  'reviewed, so it is treated as unreviewed; the files the reviewer wrote are ' +
                  'discarded from the tree that holds them.',
              ),
        );
      }

      const verdictResult = validateVerdict(inspectorRun.structured);
      // ---- SANITISED AT CAPTURE ------------------------------------------------------------
      //
      // This is where a reviewer's prose crosses into this process, and it is the only such point
      // for a verdict. `summary` and every finding `message` are model-authored and land in a
      // `CampaignNote.message` (which `renderCampaignResult` prints RAW), in `report.md`, in a
      // signal body, and — on a retry — in the next Engineer's `orders.md`. `cap` collapses `\s`
      // runs and does not touch ESC, the C1 range or `U+202E`. One call here covers all five, which
      // is the discipline `pendingQuestionFrom` and `neutralised` already follow; sanitising at
      // each render site would cover whichever ones somebody remembered.
      const verdict: Verdict | null = verdictResult.ok
        ? {
            ...verdictResult.value,
            summary: sanitize(verdictResult.value.summary),
            findings: verdictResult.value.findings.map((finding) => ({
              ...finding,
              message: sanitize(finding.message),
            })),
          }
        : null;
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
        // Same rule as the Engineer's row above: an interruption was ordered, not suffered.
        status:
          interruptedBy !== null
            ? 'interrupted'
            : inspectorRun.status === 'ok'
              ? 'exited'
              : 'failed',
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
          role,
          verdict: verdict.verdict,
          testsRun: verdict.testsRun,
          summary: verdict.summary,
        });
      }
      else {
        // A reviewer that returned nothing still has to come BACK on the stream.
        //
        // Not a `verdict` event — the review gate fails closed, and printing a verdict line for a
        // verdict that does not exist is the one shape of this stream that could mislead. But
        // `unit-returned` claims nothing about the review; it says this unit finished, with this
        // adapter status, and here is the first thing it complained about. That is exactly what
        // the Engineer's own path already emits, and the Inspector was the only unit in the tree
        // that had no way of telling a watching terminal it had ended at all.
        //
        // The field report that forced this: a Codex Inspector hit its account's usage limit
        // twelve seconds in. The campaign refused to deliver, correctly, and said so in an error
        // note — but the note is a sentence, not a unit, so the last thing anyone saw ATTACHED to
        // cpt-02 was `dispatched`. The reasonable reading of that screen is that the Inspector
        // never ran, which is the reading it got, and the reason a working reviewer was diagnosed
        // as a broken install. An ended unit must look ended.
        progress({
          kind: 'unit-returned',
          agentId: inspectorId,
          rank: 'CAPTAIN',
          role,
          status: inspectorRun.status,
          // Model-controlled in general and adapter-controlled here; `renderProgressEvent`
          // sanitises and clips either way, which is why this hands over the raw string.
          summary: inspectorRun.errors[0] ?? null,
        });
      }

      // Same placement rule as the Engineer's check: after the review's own bookkeeping, before
      // a killed reviewer can be misread as `inspector-unavailable` and fail the gate closed.
      throwIfInterrupted(`the review of round ${String(round)} (${inspectorId})`);

      // WHICH NUMBERED BEHAVIOURS ARE THIS REVIEWER'S TO ACCOUNT FOR.
      //
      // `spec.behaviours` describes the WHOLE feature. A reviewer holding one workstream's partial
      // branch cannot answer most of them, and `renderInspectorBrief` does not even show it the
      // numbered list, so demanding complete coverage from it would fail every slice by
      // construction — the same arithmetic that keeps the acceptance gate off a partial branch.
      // Coverage is the VALIDATOR's, on the integrated branch, and the unsegmented campaign's own
      // inspector, which reviews the whole feature and always did.
      const accountable = input.workstream === undefined ? options.spec : undefined;

      if (verdict === null) {
        // A reviewer that produced nothing usable is NOT a pass. The reviewer runs on a
        // different vendor precisely so the gate is independent; treating its absence as
        // approval would make the gate a formality that fails open.
        const detail = inspectorRun.errors[0] ?? `adapter status ${inspectorRun.status}`;
        note(
          'error',
          role === 'VALIDATOR' ? 'validator' : 'inspector',
          `${inspectorId} produced no usable verdict (${detail}). Refusing to deliver unreviewed ` +
            'work — the review gate fails CLOSED.',
          diagnoseSoldierFailure({
            role: role === 'VALIDATOR' ? 'Validator' : 'Inspector',
            agentId: inspectorId,
            harness: inspectorSpec.harness,
            campaignRoot: archive.root,
            status: inspectorRun.status,
            errors: inspectorRun.errors,
            structuredArrived: false,
          }),
        );
        return {
          inspectorId,
          verdict: null,
          coverage: behaviourCoverage(accountable, null),
          wrote,
          strayed,
          containment,
        };
      }
      if (containment !== 'clean') {
        // THE CONTAINMENT, ENFORCED WHERE NO HARNESS CAN. On codex the whole worktree is writable
        // and the deny rules are reported `unenforceable`; under `unguarded` the reviewer holds a
        // bare `Bash` and could write with `sed -i` regardless of any editor. So the rule that
        // actually holds on the configuration this project SHIPS is this one: a reviewer that wrote
        // where it was not allowed to does not get a verdict, and neither does one whose tree could
        // not be read. Discarded rather than downgraded — a `fail` from a reviewer that was editing
        // the code is no more trustworthy than its `pass`.
        return {
          inspectorId,
          verdict: null,
          coverage: behaviourCoverage(accountable, null),
          wrote,
          strayed,
          containment,
        };
      }
      return {
        inspectorId,
        verdict,
        coverage: behaviourCoverage(accountable, verdict),
        wrote,
        strayed,
        containment,
      };
    };

    /**
     * ONE ENGINEER AGAINST THE INTEGRATED BRANCH, in the tree this process already holds.
     *
     * ## Why the fix happens here rather than back in a workstream's tree
     *
     * The defect a validator finds is one no single workstream's branch contains: every one of them
     * passed its own review on its own slice, and what is wrong is the assembled thing. Sending it
     * back to a workstream would point an engineer at a branch that does not have the problem.
     *
     * There is also a mechanical reason, and it is the sharper one. A workstream's tree is RETURNED
     * at the end of its own pool slot — that is what makes the concurrency cap bound trees — so
     * re-running one means leasing a fresh tree at the base commit, where `git checkout -B <branch>`
     * (which is what every engineer's orders say) would RESET that branch to base and destroy the
     * work it is supposed to be fixing. The integration tree is open, held by this process, and
     * already standing on the branch, so `-B` re-points it at its own HEAD and costs nothing.
     *
     * ## Its own task, and why
     *
     * `agents` is unique on (task_id, attempt), and the campaign task on a segmented campaign has
     * child tasks rather than engineer attempts of its own. A child task for the fix loop keeps
     * every attempt at the integrated branch under one heading in `army view`, which is what a
     * reader wants: "fix the integrated branch" with N attempts under it, not N loose engineers.
     *
     * Returns `ran: false` when the engineer produced nothing usable, which ends the loop — another
     * validation round would judge a branch nothing changed.
     */
    const fixIntegratedBranch = async (input: {
      tree: IntegrationTree;
      base: string | null;
      round: number;
      acceptance: AcceptanceResult;
      verdict?: Verdict;
      merged: readonly string[];
      taskId: string | null;
      attempt: number;
    }): Promise<{ ran: boolean; taskId: string }> => {
      const fixTaskId =
        input.taskId ??
        archive.createTask({
          parentTaskId: task.id,
          title: `fix the integrated branch (${input.tree.branch})`,
          status: 'in_flight',
        }).id;
      const engineerId = nextAgentId();
      const engineerOrders = renderEngineerOrders({
        orders,
        branch: input.tree.branch,
        worktree: input.tree.path,
        attempt: input.attempt,
        // Reviewer → reviewee, which is the direction the review gate exists to permit. This is
        // the VALIDATOR's own verdict, never any engineer's account of anything.
        ...(input.verdict === undefined ? {} : { previousVerdict: input.verdict }),
        ...(input.acceptance.ran && !input.acceptance.passed
          ? { previousAcceptance: input.acceptance }
          : {}),
        ...(options.spec === undefined ? {} : { spec: options.spec }),
        integrationFix: { workstreams: input.merged },
      });
      const engineerTarget = dispatchFor(config, 'ENGINEER', options.spec !== undefined);
      const engineerSpec = buildSoldierSpec({
        agentId: engineerId,
        rank: 'CAPTAIN',
        role: 'ENGINEER',
        harness: engineerTarget.harness,
        ...(engineerTarget.model === undefined ? {} : { model: engineerTarget.model }),
        ...(engineerTarget.effort === undefined ? {} : { effort: engineerTarget.effort }),
        cwd: input.tree.path,
        orders: engineerOrders,
        outputSchemaPath: REPORT_SCHEMA_PATH,
        home,
        posture,
        ...(options.spec?.verify === undefined ? {} : { verifyCommands: options.spec.verify }),
        ...(options.spec?.filesInScope === undefined ? {} : { filesInScope: options.spec.filesInScope }),
        fanOut: engineerTarget.harness === 'claude',
      });
      archive.recordAgentAttempt({
        id: engineerId,
        taskId: fixTaskId,
        parentAgentId: null,
        rank: 'CAPTAIN',
        role: 'ENGINEER',
        harness: engineerSpec.harness,
        model: engineerSpec.model ?? null,
        effort: engineerSpec.effort ?? null,
        sessionId: engineerSpec.sessionId,
        depth: 1,
        status: 'running',
        worktreePath: input.tree.path,
        // The integration tree is not leased from the pool. Null rather than a borrowed lease id,
        // for the reason the validator's row is null: a row naming a lease it does not hold sends a
        // crash-recovering operator into somebody else's tree.
        leaseId: null,
        orders: engineerOrders,
        attempt: input.attempt,
      });
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        toAgent: engineerId,
        kind: 'order',
        body: cap(`fix ${input.tree.branch} after validation round ${String(input.round)}`),
        artifact: `agents/${engineerId}/orders.md`,
      });
      progress({
        kind: 'unit-dispatched',
        agentId: engineerId,
        rank: 'CAPTAIN',
        role: 'ENGINEER',
        harness: engineerSpec.harness,
        attempt: input.attempt,
      });
      const tracked = trackSoldier();
      const run = await runSoldier(adapterFor(options, engineerSpec.harness), engineerSpec, archive, {
        onSpawn: tracked.onSpawn,
        onEvent: activityFor(engineerId, engineerSpec.cwd),
      });
      tracked.release();
      recordDenials(archive, engineerId, run.denials, note);

      const reportResult = validateReport(run.structured);
      const report = reportResult.ok ? reportResult.value : null;
      if (report !== null) {
        archive.writeReportJson(engineerId, report);
        archive.writeReportMd(engineerId, renderEngineerReportMd(engineerId, report));
      } else {
        archive.writeReportMd(
          engineerId,
          `# Report — ${engineerId}\n\nNo valid \`Report\` was returned.\n\n` +
            `**Adapter status:** ${run.status}\n`,
        );
      }
      await writeDiffFor(archive, engineerId, input.tree.path, input.tree.branch, input.base);
      archive.finishAgent(engineerId, {
        status: interruptedBy !== null ? 'interrupted' : run.status === 'ok' ? 'exited' : 'failed',
        exitCode: run.exitCode,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
      });
      archive.appendSignal({
        fromAgent: engineerId,
        toAgent: GENERAL_AGENT_ID,
        kind: 'report',
        body: cap(report?.summary ?? `no valid report (${run.status})`),
        artifact: report === null ? null : `agents/${engineerId}/report.json`,
      });
      progress({
        kind: 'unit-returned',
        agentId: engineerId,
        rank: 'CAPTAIN',
        role: 'ENGINEER',
        status: run.status,
        summary: report?.summary ?? null,
      });
      attempts.push({
        workstreamId: 'integration',
        attempt: input.attempt,
        engineerAgentId: engineerId,
        inspectorAgentId: null,
        report,
        verdict: null,
        engineerStatus: run.status,
        costUsd: run.costUsd,
        // The gate that judges this engineer's work runs at the TOP of the next validation round,
        // against the branch it left behind, so it belongs to that round rather than to this row.
        acceptance: null,
      });
      throwIfInterrupted(`the integration fix by ${engineerId}`);

      const ran = report !== null && run.status === 'ok' && report.status === 'done';
      if (!ran) {
        note(
          'error',
          'engineer',
          `${engineerId} did not fix the integrated branch (${
            report === null ? `no valid report, adapter status ${run.status}` : `reported ${report.status}`
          }). Not validating a branch nothing changed.`,
          diagnoseSoldierFailure({
            role: 'Engineer',
            agentId: engineerId,
            harness: engineerSpec.harness,
            campaignRoot: archive.root,
            status: run.status,
            errors: run.errors,
            structuredArrived: report !== null,
          }),
        );
        retriesExhausted = true;
      } else {
        note(
          'info',
          'retry',
          `${engineerId} worked on ${input.tree.branch} after the validator refused it; the gate ` +
            'and the validator run again on what it left.',
        );
      }
      archive.updateTask(fixTaskId, { status: ran ? 'in_flight' : 'failed', branch: input.tree.branch });
      return { ran, taskId: fixTaskId };
    };

    // ---- opening a workstream: a task and a branch. NOT a tree. --------------------------
    //
    // The `runs` push happens BEFORE anything else, and that ordering is property 2 of this file's
    // header holding under concurrency. A workstream that is in `runs` is a workstream the
    // `finally` settles; one that leased a tree and threw before being recorded would be a tree
    // nobody owns.
    //
    // NO LEASE IS TAKEN HERE, and that is the whole of the fix to a cap that bounded the wrong
    // thing. This used to acquire, in a sequential loop over every plan, before `runPool` started,
    // so `maxConcurrentWorkstreams` bounded how many ENGINEERS were alive while every workstream's
    // tree was already out of the pool. Four workstreams at cap 1 against a pool of two trees
    // failed two of them with `PoolExhaustedError` and integrated nothing, which is a campaign that
    // needed one tree at a time refusing itself for want of trees. The tree is now leased inside
    // the workstream's own pool slot, so an unstarted workstream holds nothing.
    const openWorkstream = (
      plan: WorkstreamPlan,
      opts: { gated: boolean; reconciliation?: ReconciliationBrief },
    ): WorkstreamState => {
      // The CAMPAIGN's own task when there is one line of work, a child task when there are
      // several. An unsegmented campaign therefore writes the same task rows, under the same id,
      // against the same `army/<task-id>` branch it always did.
      const wsTaskId = segmented
        ? archive.createTask({
            id: `${task.id}-${plan.id}`,
            parentTaskId: task.id,
            title: cap(plan.slice, 120),
            status: 'in_flight',
          }).id
        : task.id;
      const ws: WorkstreamState = {
        plan,
        siblings: plans.filter((other) => other.id !== plan.id),
        taskId: wsTaskId,
        branch: armyBranch(wsTaskId),
        worktree: null,
        lease: null,
        leaseDisposition: {
          state: 'never-acquired',
          path: null,
          leaseId: null,
          reason: 'no worktree was ever leased',
        },
        baseCommit: null,
        verifyBaseline: [],
        gated: opts.gated,
        status: 'planned',
        outcome: 'aborted',
        attempts: [],
        overlaps: [],
        announced: new Set<string>(),
        report: null,
        verdict: null,
        retriesExhausted: false,
        unverifiedBehaviours: [],
        reconciliation: opts.reconciliation ?? null,
        firstAgentId: null,
        merged: false,
        settled: false,
      };
      runs.push(ws);

      // Pre-minted HERE rather than at lease time, and used both as the lease holder and as
      // attempt 1's agent id. Minting costs nothing and holds nothing, so doing it in plan order
      // keeps `cpt-01` the first workstream's engineer whatever order the pool happens to start
      // them in. An unsegmented campaign therefore leases as `cpt-01` and runs `cpt-01` first,
      // exactly as it did when the holder was written out as `agentIdFor(1)`.
      ws.firstAgentId = nextAgentId();
      return ws;
    };

    /**
     * Lease this workstream's tree. Called from INSIDE its pool slot and nowhere else.
     *
     * Returns false when there is no tree to work in, having already said why. It throws only for
     * the unsegmented campaign, where one line of work with nowhere to do it is not a campaign.
     * That is the pre-workstream refusal, unchanged, now raised through `runPool`, which
     * re-raises it once every sibling has come home.
     */
    const acquireWorkstreamTree = async (ws: WorkstreamState): Promise<boolean> => {
      const holder = ws.firstAgentId ?? nextAgentId();
      ws.firstAgentId = holder;
      try {
        ws.lease = await (provider as NonNullable<typeof provider>).acquire(holder, project);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fix = await diagnoseAcquireFailure(error, project, home);
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          kind: 'status',
          body: cap(`worktree acquisition failed for ${ws.plan.id}: ${message}`),
        });
        ws.status = 'abandoned';
        if (!segmented) {
          // Exactly the pre-workstream refusal: one line of work with nowhere to do it is not a
          // campaign, and there is nothing to continue with.
          note('error', 'aborted', `could not lease a worktree: ${message}`, fix);
          outcome = 'aborted';
          throw new CampaignAborted(`could not lease a worktree of ${project}: ${message}`);
        }
        // With siblings there IS something to continue with, and a pool that ran out of slots
        // must not throw away the workstreams that did get one.
        note('error', 'workstream', `${ws.plan.id} could not lease a worktree: ${message}`, fix);
        return false;
      }
      ws.leaseDisposition = {
        state: 'retained',
        path: ws.lease.path,
        leaseId: ws.lease.leaseId,
        reason: 'campaign in flight',
      };
      ws.worktree = ws.lease.path;
      progress({ kind: 'worktree-leased', provider: selection.selected, path: ws.lease.path });
      ws.baseCommit =
        (await runGit(['rev-parse', 'HEAD'], { cwd: ws.worktree })).stdout.trim() || null;
      if (ws.gated) ws.verifyBaseline = await takeVerifyBaseline(ws.worktree);
      return true;
    };

    /**
     * Give a finished workstream's tree back at the end of its own pool slot.
     *
     * THIS IS WHAT MAKES THE CAP BOUND TREES. Without it a cap of 1 over four workstreams still
     * ends holding four trees, because nothing returned the first one before the second was asked
     * for, and a pool smaller than the segmentation refuses the campaign it is perfectly able to
     * run one slot at a time.
     *
     * ONLY for a workstream that is one of SEVERAL. The single workstream of an unsegmented
     * campaign carries the gate, the Inspector and DELIVERY, all of which run in its tree after
     * this point, so its lease is settled where it always was: in the `finally`, once.
     *
     * Nothing later needs a segmented workstream's tree. Its branch is a ref in the repository's
     * common store, so the integration merge, a reconciliation engineer's `git log`, and durability
     * all still reach it after the worktree holding it is gone.
     */
    const releaseWorkstreamTree = async (ws: WorkstreamState): Promise<void> => {
      if (ws.gated || ws.lease === null) return;
      await settleWorkstreamTree(ws);
    };

    /**
     * ONE POOL SLOT: lease a tree, run the workstream in it, give the tree back.
     *
     * The three are together HERE and nowhere else, which is what makes "the cap bounds leased
     * trees" a property of the pool rather than of remembering to pair two calls at four sites.
     * The `finally` is unconditional so an exception, an abort and a clean finish all return the
     * tree by the same route; `releaseWorkstreamTree` is a no-op for the unsegmented campaign,
     * whose tree the campaign's own `finally` settles after delivery has run in it.
     */
    const runWorkstream = async (ws: WorkstreamState): Promise<void> => {
      if (!(await acquireWorkstreamTree(ws))) return;
      try {
        await runWorkstreamAttempts(ws);
      } finally {
        await releaseWorkstreamTree(ws);
      }
    };

    /**
     * Run a queue of workstreams, at most `maxConcurrent` at a time.
     *
     * ## Why nothing in here is allowed to reject
     *
     * `src/trial/run.ts` fans out with a bare `Promise.all`, which is correct there: an arm owns a
     * disposable directory and losing the batch loses nothing that was not reproducible. Here each
     * entry holds a LEASE, and a rejected `Promise.all` returns to the caller while its siblings
     * are still writing to trees the `finally` is about to reset. So every failure is caught,
     * recorded on its own workstream, and re-raised only after every worker has come home.
     *
     * The cap is real work rather than decoration: `maxConcurrent` workers pull from one index, so
     * a cap of 2 over 5 workstreams runs 2, then 2, then 1, and never 5.
     */
    const runPool = async (queue: readonly WorkstreamState[]): Promise<void> => {
      let next = 0;
      let failure: unknown = null;
      let abort: CampaignAborted | null = null;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = next;
          next += 1;
          const ws = queue[index];
          if (ws === undefined) return;
          try {
            await runWorkstream(ws);
          } catch (error) {
            ws.status = 'abandoned';
            if (error instanceof CampaignAborted) {
              // A signal, or this campaign refusing itself: an unsegmented workstream that could
              // not lease a tree. Either way every sibling is about to see the same thing at its
              // own next checkpoint, and the campaign re-raises once the pool has drained.
              ws.outcome = 'aborted';
              abort ??= error;
              return;
            }
            ws.outcome = 'engineer-failed';
            failure ??= error;
            note(
              'error',
              'workstream',
              `${ws.plan.id} ended on an error nothing anticipated: ` +
                (error instanceof Error ? error.message : String(error)),
              noFix(
                `its tree is settled below like every other. What it managed to write is in ${archive.root}.`,
              ),
            );
          }
        }
      };
      const width = Math.max(1, Math.min(maxConcurrent, queue.length));
      await Promise.all(Array.from({ length: width }, () => worker()));
      // ORDER, ON PURPOSE, AND THE SIGNAL WINS.
      //
      // A workstream that failed while the user was pressing Ctrl-C loses its exception here and
      // survives as the error-level note the worker already wrote, plus its own archive rows. That
      // is the right way round and it is a decision rather than an accident of line order: the
      // signal is what ENDED this campaign, and it owes the caller `aborted` and exit `128 + n`,
      // which is what every shell and CI wrapper reads as "interrupted". Re-raising the workstream
      // error instead would report `engineer-failed` and exit 1 for a campaign the user stopped,
      // and would blame a worker for dying in a process that was being killed around it. Nothing
      // is lost: the failure is on the result, in the notes, and in `signals.jsonl`.
      throwIfInterrupted('the workstreams');
      // AFTER the drain, so the campaign's outer catch sees these with every tree already idle. An
      // abort still held at this line is NOT a signal, because `throwIfInterrupted` has already
      // dealt with every one of those, so it is a refusal this campaign made on its own and has
      // to leave through the same door rather than be swallowed by the pool that caught it.
      if (abort !== null) throw abort;
      if (failure !== null) throw failure;
    };

    // ---- launch --------------------------------------------------------------------------
    const opened: WorkstreamState[] = plans.map((plan) =>
      openWorkstream(plan, { gated: !segmented }),
    );
    // SEGMENTED ONLY, and that is the claim above about an unsegmented campaign being
    // byte-identical being made true rather than restated. One workstream over the whole objective
    // has exactly one branch, `result.branch` already is it, and this line was the single note such
    // a campaign gained that the campaign before workstreams did not print.
    if (segmented) {
      for (const ws of opened) note('info', 'workstream', `${ws.plan.id} → ${ws.branch}`);
    }
    await runPool(opened);

    // ---- integration -----------------------------------------------------------------------
    //
    // The supervising process performs every merge, exactly as it performs the rung 3 merge that
    // no worker may perform at any rank. The overseer decided WHICH workstreams exist and this
    // decides WHEN each lands, in acceptance order, incrementally rather than all at once: the
    // first conflict then surfaces after one workstream instead of after five.
    let integrationWorktree: string | null = null;
    /** The commit the integration branch is cut from. See where it is computed. */
    let integrationBase: string | null = null;
    /**
     * Whether integration got far enough to be worth judging.
     *
     * A SEPARATE FLAG rather than a test on `outcome`, and the difference is not cosmetic:
     * `outcome` starts life as `aborted` and stays there until something sets it, so
     * `outcome !== 'aborted'` reads as "nothing has gone wrong" and means "something has already
     * gone right". Written the first way, a campaign in which everything worked skipped its own
     * review and reported `aborted`.
     */
    let integrationFailed = false;
    if (segmented) {
      const accepted = opened.filter((ws) => ws.outcome === 'delivered');
      if (accepted.length !== opened.length) {
        note(
          'error',
          'integration',
          `${String(opened.length - accepted.length)} of ${String(opened.length)} workstreams did ` +
            'not produce work fit to integrate, so there is nothing whole to merge. Nothing is ' +
            'integrated and every branch is made durable below.',
          noFix(
            'the workstreams that failed each say why in their own notes above. Their branches ' +
              'hold whatever was built and are durable; there is no command that turns a partial ' +
              'feature into a whole one.',
          ),
        );
        outcome = 'engineer-failed';
        integrationFailed = true;
      } else {
        integration = {
          branch,
          path: null,
          state: 'never-opened',
          reason: 'the integration tree was never opened',
          merged: [],
          conflicts: [],
        };
        // THE COMMIT EVERY WORKSTREAM BRANCH WAS CUT FROM, read off the workstreams themselves and
        // never from `HEAD`. By the time this runs the engineers have been working for the length
        // of a model session, and the project's head may have moved under them: an integration
        // branch cut from a moved head makes the first merge a three-way merge against commits no
        // engineer has seen, and git reports the collision as a conflict belonging to whichever
        // workstream merged first. One engineer then wears a collision it never caused, and a
        // reconciliation workstream is pointed at the wrong two branches.
        //
        // A disagreement between workstreams is reported rather than averaged. It means the pool
        // handed out trees at different commits, which is a fact about the integration nobody
        // should have to infer from a strange conflict later.
        const bases = [...new Set(accepted.map((ws) => ws.baseCommit).filter((sha): sha is string => sha !== null))];
        integrationBase = bases[0] ?? null;
        if (bases.length > 1) {
          note(
            'warn',
            'integration',
            `the workstreams were cut from ${String(bases.length)} different base commits ` +
              `(${bases.map((sha) => sha.slice(0, 12)).join(', ')}). Cutting the integration ` +
              `branch from ${(integrationBase ?? '').slice(0, 12)}, which is the first of them.`,
          );
        }
        if (integrationBase === null) {
          note(
            'error',
            'integration',
            'no workstream could report the commit its branch was cut from, so there is no ' +
              'honest base to cut an integration branch from. Nothing was merged.',
            noFix(
              'every workstream branch is durable and holds its own work. An integration branch ' +
                'cut from a guess is worse than none.',
            ),
          );
          outcome = 'engineer-failed';
          integrationFailed = true;
        } else {
          try {
            integrationTree = await openIntegration({
              project,
              branch,
              holder: GENERAL_AGENT_ID,
              base: integrationBase,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            note(
              'error',
              'integration',
              `no integration tree could be opened (${message}), so nothing was merged.`,
              doctorFix(),
            );
            outcome = 'aborted';
            integrationFailed = true;
          }
        }
        if (integrationTree !== null) {
          integrationWorktree = integrationTree.path;
          integration = {
            branch: integrationTree.branch,
            path: integrationTree.path,
            state: 'retained',
            reason: 'campaign in flight',
            merged: [],
            conflicts: [],
          };
          progress({
            kind: 'note',
            level: 'info',
            message: `integration tree at ${integrationTree.path} on ${integrationTree.branch}`,
          });
          const merged: string[] = [];
          const conflicts: { workstreamId: string; files: readonly string[] }[] = [];
          const mergeOne = async (ws: WorkstreamState): Promise<MergeOutcome | null> => {
            throwIfInterrupted(`the merge of ${ws.plan.id}`);
            const tree = integrationTree as IntegrationTree;
            let result: MergeOutcome;
            try {
              result = await tree.merge(ws.branch);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              note('error', 'integration', `merging ${ws.branch} threw: ${message}`, doctorFix());
              return null;
            }
            archive.appendSignal({
              fromAgent: GENERAL_AGENT_ID,
              kind: 'status',
              body: cap(`merge ${ws.branch} -> ${tree.branch}: ${result.kind}`),
            });
            if (result.kind === 'merged' || result.kind === 'already-current') {
              ws.merged = true;
              merged.push(ws.plan.id);
              note(
                'info',
                'integration',
                `${ws.plan.id} (${ws.branch}) ${
                  result.kind === 'merged' ? `merged as ${result.commit.slice(0, 12)}` : 'was already integrated'
                }`,
              );
            } else {
              conflicts.push({ workstreamId: ws.plan.id, files: result.files });
              note(
                'warn',
                'integration',
                `${ws.plan.id} (${ws.branch}) conflicts with ${tree.branch} in ` +
                  `${result.files.join(', ')}. A fresh engineer reconciles it; nothing here ` +
                  'resolves a conflict by hand.',
              );
            }
            return result;
          };

          for (const ws of accepted) await mergeOne(ws);

          // ---- reconciliation ----------------------------------------------------------
          //
          // A conflict is a WORKSTREAM, not a merge strategy. Two engineers each wrote something
          // that passed its own gate, and choosing between them is a change to the code somebody
          // has to be accountable for. Resolving it here would produce a merge commit authored by
          // the supervisor, reviewed by nobody, in a tree no inspector was ever pointed at.
          const unresolved = conflicts.filter((conflict) =>
            accepted.some((ws) => ws.plan.id === conflict.workstreamId && !ws.merged),
          );
          if (unresolved.length > 0) {
            const fixes: WorkstreamState[] = [];
            for (const conflict of unresolved) {
              const source = accepted.find((ws) => ws.plan.id === conflict.workstreamId);
              if (source === undefined) continue;
              const plan: WorkstreamPlan = {
                id: reconciliationId(
                  conflict.workstreamId,
                  plans.map((other) => other.id),
                ),
                slice: cap(
                  `Reconcile ${source.branch} onto ${(integrationTree as IntegrationTree).branch}`,
                  200,
                ),
                expectedFiles: conflict.files,
              };
              plans.push(plan);
              const fix = openWorkstream(plan, {
                gated: false,
                reconciliation: {
                  ours: (integrationTree as IntegrationTree).branch,
                  theirs: source.branch,
                  theirsWorkstream: source.plan.id,
                  files: conflict.files,
                },
              });
              fixes.push(fix);
            }
            note(
              'info',
              'integration',
              `${String(fixes.length)} reconciliation workstream(s) launched. Each gets its own ` +
                'engineer and its own worktree, and its work reaches the integrated branch, where ' +
                'the acceptance gate and the one Inspector judge it alongside every other ' +
                "workstream's. No inspector stands in a reconciliation tree.",
            );
            await runPool(fixes);
            for (const fix of fixes) {
              if (fix.outcome !== 'delivered') {
                note(
                  'error',
                  'integration',
                  `${fix.plan.id} did not produce a reconciliation, so ${fix.reconciliation?.theirs ?? 'a branch'} ` +
                    'is not integrated.',
                  noFix(
                    'both branches are durable and hold their own work. Reconciling them is a ' +
                      'change to the code, so there is no command that does it.',
                  ),
                );
                continue;
              }
              const result = await mergeOne(fix);
              if (result !== null && result.kind !== 'conflict') {
                const source = accepted.find((ws) => ws.plan.id === fix.reconciliation?.theirsWorkstream);
                if (source !== undefined) source.merged = true;
              }
            }
          }

          integration = {
            ...integration,
            merged,
            conflicts,
          };
          const outstanding = accepted.filter((ws) => !ws.merged);
          if (outstanding.length > 0) {
            note(
              'error',
              'integration',
              `${outstanding.map((ws) => ws.plan.id).join(', ')} never reached ` +
                `${(integrationTree as IntegrationTree).branch}, so the integrated branch is not ` +
                'the whole feature. Not delivering a partial integration.',
              noFix(
                'every workstream branch is durable and holds its own work. What is missing is a ' +
                  'reconciliation, which is a change to the code rather than a command to run.',
              ),
            );
            outcome = 'engineer-failed';
            integrationFailed = true;
          }
        }
      }
    }

    // ---- the campaign's own gate and review ------------------------------------------------
    //
    // AN UNSEGMENTED CAMPAIGN HAS ALREADY DONE THIS, inside its one workstream, and this block is
    // skipped entirely for it — which is what keeps its behaviour byte-identical. A segmented one
    // does it here, once, on the integrated branch, because the spec's verify commands and the
    // objective both describe the WHOLE feature and no single workstream's branch is that.
    if (!segmented) {
      const only = opened[0];
      if (only !== undefined) {
        outcome = only.outcome;
        finalReport = only.report;
        finalVerdict = only.verdict;
        retriesExhausted = only.retriesExhausted;
        unverifiedBehaviours = only.unverifiedBehaviours;
      }
    } else if (
      integrationTree !== null &&
      !integrationFailed &&
      opened.every((ws) => ws.merged || ws.reconciliation !== null)
    ) {
      const tree = integrationTree;
      // The same commit the integration branch was cut from, so the validator diffs against the
      // point the work started rather than against wherever the project's head happens to be.
      const integratedBase = integrationBase;
      // Rung 3 reads the ENGINEER's status, and a segmented campaign has N of them. The honest
      // answer is the strictest one: a report is offered only when every workstream came back
      // `done`, and an absent report is read as `failed`, which refuses. Evidence that is
      // missing is never read as good news.
      finalReport = opened.every((ws) => ws.report?.status === 'done')
        ? opened[opened.length - 1]?.report ?? null
        : null;
      retriesExhausted = opened.some((ws) => ws.retriesExhausted);

      // ---- THE VALIDATION LOOP -------------------------------------------------------------
      //
      // gate → validator → (fix → gate → validator)*, bounded by `maxAttempts`.
      //
      // ## HOW THE TWO BUDGETS RELATE, AND WHY THEY DO NOT SHARE A POOL
      //
      // A WORKSTREAM's retries come out of `maxAttempts` spent on ITS OWN task, inside its own
      // attempt loop, exactly as an unsegmented campaign's do. THE CAMPAIGN's budget is the same
      // number spent on a different task: how many times the INTEGRATED result may be re-judged
      // after a validator refuses it. They multiply rather than share, and that is a decision:
      //
      //  - One shared pool across N concurrent workstreams turns a budget into a race. The first
      //    workstream to get going could spend the whole allowance and leave its siblings with
      //    none, which is the exact argument `MAX_QUESTION_ROUNDS` is already per-workstream for.
      //  - A workstream's task and the integrated feature are different tasks with different
      //    failures. A slice that needed three engineers has said nothing about whether the
      //    assembled feature will need a second look, and charging one against the other means a
      //    campaign that worked hard early cannot be corrected late.
      //  - The exposure is bounded and visible: at most `maxAttempts` engineers per workstream plus
      //    `maxAttempts` validation rounds, and `maxConcurrentWorkstreams` bounds how many of the
      //    first are ever alive at once. It is the same shape the question ladder already accepted.
      //
      // What they SHARE is the ending. When either is gone the campaign ends unsuccessfully — and
      // still lands its work durably, in the `finally` below, because durability is unconditional
      // and a failed night is still a night's work.
      const validationBudget = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
      /** Engineers spent fixing the INTEGRATED branch. Its own task, so its own attempt numbers. */
      let fixTaskId: string | null = null;
      let fixAttempts = 0;
      let validationRound = 0;
      let previousValidation: Verdict | undefined;

      while (validationRound < validationBudget) {
        validationRound += 1;
        throwIfInterrupted(`the gap before validation round ${String(validationRound)}`);
        const baseline = await takeVerifyBaseline(tree.path);
        // AFTER the baseline and BEFORE the gate, and the order is the whole point. A reviewer's
        // test applied before the baseline would be baselined as "already failing against the
        // untouched tree" and then excused by the gate for the rest of the campaign, which is the
        // one way a reviewer could write a test that can never fail. Applied after it, the test is
        // new work and the gate judges it as such — and the gate running it is the first of the two
        // independent executions precondition 4 is about.
        applyHeldTests(tree.path);
        const acceptance = await runAcceptanceGate({
          ...(options.spec?.verify === undefined ? {} : { commands: options.spec.verify }),
          cwd: tree.path,
          ...(options.verifyRun === undefined ? {} : { run: options.verifyRun }),
          timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
          baseline,
          onProgress: (line) => progress({ kind: 'note', level: 'info', message: line }),
        });
        // WHERE THE RESULT READS IT. A gate that ran and is not on the result is a gate the screen
        // reports as never having run. The LAST round's reading wins, which is the one that
        // describes the branch this campaign actually ends holding.
        integratedAcceptance = acceptance;
        throwIfInterrupted('the acceptance gate on the integrated branch');

        // ---- TWO QUESTIONS, AND THE GATE ONLY ANSWERS ONE ---------------------------------
        //
        // A failing gate still ends the round WITHOUT a validator, for the reason it does inside
        // the attempt loop: a branch that fails commands the SPEC ITSELF named as proof of done is
        // not ready for a human-grade judgement, and the validator runs on a metered account.
        // What CHANGED is what happens next — this used to be the end of the campaign, and now it
        // re-enters the fix loop under the remaining budget like any other refusal.
        if (acceptance.ran && !acceptance.passed) {
          const failed = acceptance.outcomes.filter((entry) => !entry.passed).map((e) => e.command);
          note(
            'error',
            'acceptance',
            `the integrated branch failed its own acceptance commands (${failed.join(', ')}). Not ` +
              'spending a VALIDATOR on a branch a mechanical check already refutes.',
            noFix(
              "the commands are the spec's own, run against the integrated branch exactly as " +
                'written — a fact about the work rather than an environment fault. It is carried ' +
                'into the next engineer directly, under whatever is left of the budget.',
            ),
          );
          outcome = 'engineer-failed';
          // The held tests come back out before anything else touches this tree. An engineer's
          // `git add -A` in the fix loop would sweep an uncommitted reviewer test onto the branch
          // under the engineer's name, which is precondition 3 — authorship separately visible —
          // false while still looking true. The next round re-applies them.
          await withdrawHeldTests(tree.path);
          if (validationRound >= validationBudget) break;
          const fixed = await fixIntegratedBranch({
            tree,
            base: integratedBase,
            round: validationRound,
            acceptance,
            ...(previousValidation === undefined ? {} : { verdict: previousValidation }),
            merged: integration?.merged ?? [],
            taskId: fixTaskId,
            attempt: fixAttempts + 1,
          });
          if (!fixed.ran) break;
          fixTaskId = fixed.taskId;
          fixAttempts += 1;
          continue;
        }

        // ---- THE VALIDATOR ---------------------------------------------------------------
        //
        // The last agent of phase 3, and the only one asked whether this is THE THING THAT WAS
        // ASKED FOR. Every branch that merged here was already reviewed on its own slice by its own
        // inspector, and the gate above has just answered "do the commands pass" mechanically. Both
        // of those are inputs to this unit rather than substitutes for it: the gate's own output
        // rides into the brief as evidence, and the question on top of it is the one no exit code
        // answers.
        const judged = await judgeBranch({
          taskId: task.id,
          branch: tree.branch,
          worktree: tree.path,
          baseCommit: integratedBase,
          // The integration tree is not leased from the pool, so there is no lease id to record
          // against its validator. Null rather than a borrowed one: an agent row naming a lease
          // it does not hold would send a crash-recovering operator to the wrong tree.
          leaseId: null,
          round: validationRound,
          role: 'VALIDATOR',
          validation: {
            workstreams: integration?.merged ?? [],
            acceptance,
            // PRECONDITION 4, NAMED. Tests a reviewer wrote, applied to this tree by the
            // supervisor and run now by a unit the reviewer does not own. They are NOT on the
            // branch yet: whether they ever are is decided a few lines below, by whether this
            // agent came back with a verdict at all.
            inspectorTests: heldTests.map((entry) => entry.path),
          },
        });

        // ---- THE VALIDATOR'S OWN CONTAINMENT ----------------------------------------------
        //
        // The same discipline every per-workstream reviewer gets, and it was missing here: this
        // call site read `verdict` and dropped `wrote` and `strayed` on the floor. Two reachable
        // consequences, both measured. A validator that wrote one non-test file had its verdict
        // correctly discarded inside `judgeBranch` and left the file in the tree, so the merged
        // work could never be made durable and the integration tree was `retained` forever. A
        // validator that wrote one scratch file on a TEST path strayed nothing, kept its `pass`,
        // and the campaign still ended `delivery-failed` with `deliveredRung: null`, because
        // `runLadder` refuses a dirty tree. One dropped file, and a validator saying the work is
        // fine could stop it being delivered and hold a pool slot for good.
        //
        // BEFORE `throwIfInterrupted`, because an interrupt must not be the reason a tree is left
        // dirty; the campaign still has to make the merged work durable on its way out.
        if (judged.wrote.length > 0) await discardWorkerWrites(tree.path, judged.wrote);
        // And the one thing the difference in `judgeBranch` cannot see: the held tests are dirty
        // on BOTH sides of it, so a validator that rewrote the test it was asked to run would
        // register as having written nothing. Read the bytes instead.
        const tampered = tamperedHeldTests(tree.path);
        if (tampered.length > 0) {
          note(
            'error',
            'authorship',
            `${judged.inspectorId} changed the reviewer tests it was asked to run (${tampered
              .map((f) => `\`${f}\``)
              .join(', ')}). Its verdict is discarded and none of those tests becomes history: a ` +
              'validator that can edit the test it is running is the whole hazard the reviewer ' +
              'grant was contained for, arriving one unit later.',
            noFix(
              'nothing here is a defect in the work. The integrated branch is made durable below ' +
                'and holds everything that merged; what it does not hold is a test nobody ' +
                'independent ever ran.',
            ),
          );
          await withdrawHeldTests(tree.path);
          finalVerdict = null;
          outcome = 'inspector-unavailable';
          break;
        }
        throwIfInterrupted('the validation of the integrated branch');
        finalVerdict = judged.verdict;

        if (judged.verdict === null) {
          // Fails CLOSED and does NOT re-enter the fix loop. There is nothing to fix: a validator
          // that produced no verdict has said nothing about the work, so another engineer would be
          // sent to address findings that do not exist.
          //
          // And the held tests go back out with it. A validator that produced no verdict is a
          // validator nobody can say ran anything, which is the exact condition precondition 4
          // names — so the tests it was supposed to run do not become history off the back of it.
          await withdrawHeldTests(tree.path);
          outcome = 'inspector-unavailable';
          break;
        }

        // ---- PRECONDITION 4, AT THE MOMENT IT IS DECIDABLE ---------------------------------
        //
        // A validator has now run, on a tree holding these files, and returned a verdict about
        // what it found. THAT is the fact the durable artefact was waiting for, and this is the
        // first line in the campaign that is allowed to write a reviewer's test into history.
        // The content comes from what was held rather than from what is on disk, so whatever else
        // stood in the tree, what lands is what the reviewer wrote. It happens on a `fail` as
        // well as a `pass`: the tests ran either way, and a branch that is about to be handed to
        // a fix engineer needs them committed or that engineer commits them itself.
        if (heldApplied && heldTests.length > 0) {
          const landed = await commitInspectorTests({
            worktree: tree.path,
            branch: tree.branch,
            files: heldTests.map((entry) => ({ path: entry.path, content: entry.content })),
            authors: [...new Set(heldTests.map((entry) => entry.agentId))],
            validatedBy: judged.inspectorId,
          });
          for (const file of landed) if (!inspectorTests.includes(file)) inspectorTests.push(file);
          if (landed.length > 0) {
            // Committed, so the tree is clean again and there is nothing left to withdraw. The
            // held list is emptied too: a later round must not re-apply what is already history.
            heldApplied = false;
            heldTests.length = 0;
            note(
              'info',
              'authorship',
              `${landed.map((f) => `\`${f}\``).join(', ')} committed onto ${tree.branch} after ` +
                `${judged.inspectorId} ran them there. A reviewer wrote them; a unit the reviewer ` +
                'does not own executed them before they became history.',
            );
          } else {
            note(
              'warn',
              'authorship',
              `the reviewer tests ${judged.inspectorId} ran could not be committed onto ` +
                `${tree.branch}. They are withdrawn rather than left uncommitted, because a dirty ` +
                'tree is a tree whose merged work cannot be made durable.',
            );
            await withdrawHeldTests(tree.path);
          }
        }
        const gaps: string[] = [];
        if (judged.coverage.missing.length > 0) gaps.push(`missing: ${judged.coverage.missing.join(', ')}`);
        if (judged.coverage.duplicated.length > 0) {
          gaps.push(`duplicated: ${judged.coverage.duplicated.join(', ')}`);
        }
        if (judged.coverage.outOfRange.length > 0) {
          gaps.push(`out of range: ${judged.coverage.outOfRange.join(', ')}`);
        }
        if (gaps.length > 0) {
          note(
            'error',
            'coverage',
            `${judged.inspectorId}'s verdict on the integrated branch does not account for every ` +
              `numbered behaviour (${gaps.join('; ')}). A clause with no entry looks identical to ` +
              'a clean bill of health, and this campaign refuses to trust that silently.',
            noFix(
              'the gap is in the REVIEW rather than necessarily the work — the validator could ' +
                'have marked the clause `not-verified` and did not. There is no command that ' +
                'fixes a missing review entry, and every workstream branch is durable.',
            ),
          );
          // NOT sent back to an engineer, and this is the one refusal that is not. An incomplete
          // accounting is a defect in the REVIEW, so a fresh engineer would be sent to fix a branch
          // nobody has established anything about. A second validator on the identical branch is
          // the only thing that could help, and spending the budget on that is how a campaign pays
          // twice for one model's formatting mistake.
          outcome = 'inspector-failed';
          break;
        }
        if (judged.verdict.verdict === 'pass') {
          note(
            'info',
            'validator',
            `${judged.inspectorId} PASSED ${tree.branch} against the original ask: ` +
              `${cap(judged.verdict.summary, 120)}`,
          );
          outcome = 'delivered';
          unverifiedBehaviours = judged.coverage.unverified;
          break;
        }

        note(
          'warn',
          'validator',
          `${judged.inspectorId} REFUSED ${tree.branch}: ${cap(judged.verdict.summary, 120)}. The ` +
            'commands may pass; this is the other question.',
        );
        outcome = 'inspector-failed';
        previousValidation = judged.verdict;

        // ---- BACK TO THE OVERSEER, THEN BACK TO AN ENGINEER --------------------------------
        const fix = await adjudicateRefusal({
          verdict: judged.verdict,
          reviewer: 'VALIDATOR',
          branch: tree.branch,
          spent: validationRound,
          budget: validationBudget,
        });
        if (fix !== null && fix.decision === 'accept') {
          note(
            'warn',
            'validator',
            `${fix.by ?? GENERAL_AGENT_ID} OVERRULED ${judged.inspectorId}'s refusal of the ` +
              `integrated branch: ${cap(fix.rationale, 160)}.`,
          );
          archive.appendSignal({
            fromAgent: fix.by ?? GENERAL_AGENT_ID,
            toAgent: GENERAL_AGENT_ID,
            kind: 'status',
            body: cap(`adjudication: accept the integrated branch over ${judged.inspectorId}'s fail — ${fix.rationale}`),
          });
          outcome = 'delivered';
          unverifiedBehaviours = judged.coverage.unverified;
          break;
        }
        if (fix !== null) {
          archive.appendSignal({
            fromAgent: fix.by ?? GENERAL_AGENT_ID,
            toAgent: GENERAL_AGENT_ID,
            kind: 'status',
            body: cap(`adjudication: retry the integrated branch — ${fix.rationale}`),
          });
        }
        if (validationRound >= validationBudget) {
          retriesExhausted = true;
          note(
            'error',
            'validator',
            `the VALIDATOR refused the integrated branch on ${String(validationBudget)} round(s); ` +
              'the campaign budget is exhausted. Not delivering.',
            noFix(
              'the validator judged the assembled work against the original ask on every round — ' +
                'that is a verdict, not an environment fault, so there is nothing to run. Its ' +
                `findings are in ${archive.root}/agents/*/report.md, and the integrated branch is ` +
                'made durable below and can be picked up by hand.',
            ),
          );
          break;
        }
        const fixed = await fixIntegratedBranch({
          tree,
          base: integratedBase,
          round: validationRound,
          acceptance,
          verdict: judged.verdict,
          merged: integration?.merged ?? [],
          taskId: fixTaskId,
          attempt: fixAttempts + 1,
        });
        if (!fixed.ran) break;
        fixTaskId = fixed.taskId;
        fixAttempts += 1;
      }
      // The fix task is left `in_flight` by every successful round, because the round after it is
      // what judges the work. Whichever way the loop ended, it is closed here: a task sitting at
      // `in_flight` while nothing is running is the shape of a campaign that has hung, and `view`
      // would show one.
      if (fixTaskId !== null && archive.getTask(fixTaskId)?.status === 'in_flight') {
        archive.updateTask(fixTaskId, {
          status: outcome === 'delivered' ? 'done' : 'failed',
          branch: tree.branch,
        });
      }
    }

    // ---- delivery ---------------------------------------------------------------------
    const deliveryBranch = segmented ? integrationTree?.branch ?? branch : opened[0]?.branch ?? branch;
    const deliveryWorktree = segmented ? integrationWorktree : opened[0]?.worktree ?? null;
    if (outcome === 'delivered' && finalVerdict !== null && deliveryWorktree !== null) {
      const worktree = deliveryWorktree;
      try {
        delivery = await runLadder({
          taskId: task.id,
          project,
          requested: requestedRung,
          config: config as DeliveryConfig,
          branch: deliveryBranch,
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
        // Named rather than inferred. Lease settlement asks "is THIS branch already durable", and
        // on a segmented campaign the answer is yes for one branch and no for the other N.
        deliveredBranch = deliveryBranch;
        progress({
          kind: 'delivered',
          rung: delivery.delivered,
          url: delivery.pr?.url ?? delivery.durability.target.url ?? null,
        });
        archive.updateTask(task.id, {
          status: 'done',
          deliveredRung: delivery.delivered,
          prUrl: delivery.pr?.url ?? null,
          branch: deliveryBranch,
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
        archive.updateTask(task.id, { status: 'failed', branch: deliveryBranch });
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
    // ---- durability, then the lease. Never the other way round. EVERY tree. -----------------
    //
    // N LEASES PLUS THE INTEGRATION TREE, and property 2 of this file's header is the same
    // property it always was: there is no exit path on which a tree's fate is unknown. What
    // changed is that "the lease" is now a loop, and a loop that stops early leaves the rest of
    // its trees held forever. So each workstream is settled inside its own guard, and a
    // settlement that throws marks THAT tree retained and moves to the next one.
    //
    // A workstream of SEVERAL has usually settled its own tree already, at the end of its own pool
    // slot, which is what keeps the cap a bound on trees and not only on engineers, and
    // `ws.settled` is how this loop knows not to ask the pool a second time about a slot somebody
    // else is holding by now. It still records the disposition, closes the task and emits the
    // lifecycle line for every one of them, so a reader sees the same account of every tree
    // whichever route settled it.
    for (const ws of runs) await settleWorkstreamTree(ws);

    // ---- the integration tree ---------------------------------------------------------------
    //
    // Same order and the same fail-closed rule as a lease: the merged branch is made durable
    // BEFORE the tree is released, and a tree whose work could not be made durable is HELD.
    // `retained` means this process deliberately did not call `release`, or called it and it
    // threw, and says which; `not-held` means it called it and the pool refused. The three are
    // distinguishable because `release` now reports what it did.
    if (integrationTree !== null && integration !== null) {
      const tree = integrationTree;
      // THE BACKSTOP FOR THE HELD TESTS, and it is here rather than in the loop because this
      // section runs on every exit path including the ones that threw out of it. A reviewer's test
      // that is still sitting uncommitted in this tree is a dirty tree, and a dirty tree is merged
      // work that cannot be made durable and an integration tree retained with somebody's night in
      // it. Idempotent: a no-op when they were committed, or never applied.
      await withdrawHeldTests(tree.path);
      let releasable = true;
      if (deliveredBranch !== tree.branch) {
        try {
          const target = await resolveDurabilityTarget({ project, archiveRoot, allowOrigin: false });
          const result = await ensureDurable({
            worktree: tree.path,
            branch: tree.branch,
            project,
            archiveRoot,
            target,
          });
          note(
            'info',
            'durability',
            `${tree.branch} is durable at ${result.target.kind} ${result.target.url} (${result.commit.slice(0, 12)}).`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          releasable = false;
          integration = {
            ...integration,
            state: 'retained',
            reason: `the merged work could not be made durable (${message}), so the tree is held rather than released.`,
          };
          note(
            'error',
            'integration',
            `${integration.reason} Integration tree RETAINED at ${tree.path}.`,
            retainedTreeFix(tree.path),
          );
        }
      }
      if (releasable) {
        try {
          // READ, NEVER ASSUMED. `release()` reports which of its three outcomes happened, and the
          // one that matters is `not-held`: the lease went stale, so `tree.path` is now another
          // holder's tree and reporting it as a path this campaign returned would send a
          // crash-recovering operator into somebody else's worktree and tell them a slot was freed
          // that was never this run's to free.
          const outcome = await tree.release();
          if (outcome.kind === 'not-held') {
            integration = {
              ...integration,
              state: 'not-held',
              reason: `the integration tree was neither returned nor is it held: ${outcome.reason}`,
            };
            note(
              'warn',
              'integration',
              `${integration.reason} The merged work is durable and reachable by ref; nothing here ` +
                'freed a pool slot.',
              noFix(
                'nothing is lost and nothing is leaked by this run. The branch is durable, and the ' +
                  'tree at that path belongs to whoever the message names.',
              ),
            );
          } else {
            integration = {
              ...integration,
              state: 'released',
              reason:
                outcome.kind === 'released'
                  ? 'the merged work is durable; the integration tree was returned'
                  : 'the merged work is durable; the integration tree had already been returned',
            };
            note('info', 'integration', `integration tree released: ${tree.path}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          integration = {
            ...integration,
            state: 'retained',
            reason: `releasing the integration tree failed: ${message}`,
          };
          note(
            'error',
            'integration',
            `${integration.reason} Integration tree RETAINED at ${tree.path}.`,
            retainedTreeFix(tree.path),
          );
        }
      }
      guard('recording the integration disposition', () => {
        const settled = integration as IntegrationDisposition;
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          kind: 'status',
          body: cap(`integration ${settled.state}: ${settled.reason}`),
          artifact: settled.path,
        });
      });
    }

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
    // LAST, so a second Ctrl-C during the settlement above still has its escape hatch. After
    // this line the process is back to Node's default signal behaviour.
    if (handledSignals.includes('SIGINT')) process.removeListener('SIGINT', onSigint);
    if (handledSignals.includes('SIGTERM')) process.removeListener('SIGTERM', onSigterm);
    // The host's controller outlives this call (a chat session reuses one per dispatch), so the
    // listener has to come off, or every dispatch of a long session leaves one behind.
    options.abortSignal?.removeEventListener('abort', onAbortRequest);
  }

  const campaignRoot = archive.root;
  const finalStatus = intendedStatus;
  const deliveredRung = delivery?.delivered ?? null;
  // THE GATE THAT ACTUALLY RAN, wherever it ran.
  //
  // A segmented campaign's gate runs once, on the integrated branch, and belongs to no attempt; an
  // unsegmented campaign's runs inside its one workstream and belongs to the last attempt. Reading
  // only the second is what made every segmented campaign print "acceptance not run". The two are
  // never both set: no workstream of several is judged on its own branch, so `record.acceptance`
  // stays null on all of them.
  //
  // `null` still means what it always meant, which is that no gate was ever a candidate to run,
  // and a segmented campaign that ended before integration lands there correctly.
  const acceptance = integratedAcceptance ?? attempts[attempts.length - 1]?.acceptance ?? null;

  // `outcome === 'delivered'` alone was enough while the only error-level DELIVERY note came from
  // `runLadder` throwing, which also set `outcome = 'delivery-failed'`. Rung 3 broke that pairing:
  // `merge-uncertain` is delivered — the pull request really is merged — AND an error, because
  // the command that merged it failed afterwards and a human has to go and look. Exiting 0 there
  // would tell a script everything is fine while the note on screen says it is not, which is the
  // safe-sounding half of "I could not do X so I did Y".
  const deliveryFailedLoudly = notes.some((n) => n.level === 'error' && n.code === 'delivery');
  // A signal-aborted campaign exits `128 + signal` — 130 for Ctrl-C — because that is the code
  // every shell and CI system already reads as "interrupted", and the cleanup this run now does
  // must not change what a wrapper script observes. Only when the signal is what ENDED it: a
  // signal that arrived during delivery and let the merge finish is still a delivery.
  const exitCode =
    interruptedBy !== null && outcome === 'aborted'
      ? exitCodeForSignal(interruptedBy)
      : outcome === 'delivered' && !deliveryFailedLoudly
        ? 0
        : 1;
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
    // The first workstream's, which on an unsegmented campaign is the campaign's only tree. The
    // `never-acquired` fallback is the value this field held before any lease was attempted, and
    // it is still the honest answer for a campaign that ended before one was.
    lease: runs[0]?.leaseDisposition ?? {
      state: 'never-acquired',
      path: null,
      leaseId: null,
      reason: 'no worktree was ever leased',
    },
    workstreams: runs.map((ws) => ({
      id: ws.plan.id,
      slice: ws.plan.slice,
      expectedFiles: ws.plan.expectedFiles,
      taskId: ws.taskId,
      branch: ws.branch,
      worktree: ws.worktree,
      // ITS OWN TREE'S DISPOSITION, on its own record. `lease` above is `runs[0]`'s and stays that
      // for every caller that already reads it; this is the one that answers the question for a
      // campaign with six of them. `settleWorkstreamTree` writes exactly one of these per
      // workstream and is the only thing that can, so a tree cannot be settled without its own
      // record saying how.
      lease: ws.leaseDisposition,
      // The running status, resolved to a terminal one. `running` and `planned` cannot survive
      // this point: the pool has drained, so a workstream still claiming to be running is a
      // workstream whose ending nobody recorded, which is the same class of lie as an unsettled
      // lease.
      status: terminalWorkstreamStatus(ws),
      attempts: ws.attempts,
      overlaps: ws.overlaps,
      reconciliation: ws.reconciliation !== null,
    })),
    maxConcurrentWorkstreams: maxConcurrentReported,
    integration,
    notes,
    acceptance,
    unverifiedBehaviours,
    exitCode,
  };
}

/**
 * A workstream's status once the pool has drained, derived from how it actually ended.
 *
 * `running` and `planned` are not terminal, and neither may appear on a result: a workstream still
 * claiming to be running after every worker has come home is a workstream whose ending nobody
 * recorded, which is the same class of lie as a lease with no disposition. `parked` is the one
 * status that is kept as it is found, because a workstream whose question was never answered
 * really did stop while parked, and that is what a reader needs to see.
 *
 * Exported so a test can hold the mapping still rather than inferring it from a campaign that
 * happens to take one path through it.
 */
export function terminalWorkstreamStatus(input: {
  status: WorkstreamStatus;
  outcome: CampaignOutcome;
  worktree: string | null;
}): WorkstreamStatus {
  if (input.status === 'parked') return 'parked';
  if (input.worktree === null) return 'abandoned';
  switch (input.outcome) {
    case 'delivered':
      return 'accepted';
    case 'inspector-failed':
    case 'engineer-failed':
    case 'inspector-unavailable':
      return 'rejected';
    default:
      // `aborted` and `delivery-failed`. Neither is a verdict on the work: one is a human ending
      // the campaign, the other is something that happened after this workstream was done with.
      return input.outcome === 'delivery-failed' ? 'accepted' : 'abandoned';
  }
}

/**
 * The id of the workstream that reconciles `source`'s failed merge.
 *
 * ## The suspicion, proven rather than guarded on faith
 *
 * This was `` `${source}-merge`.slice(0, 48) ``, and two source ids break it. A 47-character id
 * makes `<47>-merge` (53), which the slice cuts to 47 characters plus the hyphen: a trailing
 * separator, which `WORKSTREAM_ID_RE` refuses and which becomes a task id and then a git branch
 * name without anything looking at it again. A 48-character id is worse: the slice returns the
 * SOURCE ID UNCHANGED, so the reconciliation would claim its own source's task id
 * (`<campaign-task>-<id>`) and its own source's branch. `archive.createTask` validates neither, so
 * the first symptom would be two workstreams writing to one branch.
 *
 * So the truncation happens BEFORE the suffix rather than after it, any separator the cut exposes
 * is trimmed off, and a name that would collide with a workstream that already exists is numbered.
 * Exported so a test can hold the mapping still rather than reaching it through a 48-character
 * segmentation.
 */
export function reconciliationId(source: string, taken: readonly string[] = []): string {
  const suffix = '-merge';
  const trim = (text: string, room: number): string =>
    [...text].slice(0, room).join('').replace(/[-_]+$/, '');
  const base = trim(source, WORKSTREAM_ID_MAX_CHARS - suffix.length) || 'ws';
  let candidate = `${base}${suffix}`;
  for (let n = 2; taken.includes(candidate) && n < 100; n += 1) {
    const tag = `-${String(n)}`;
    candidate = `${trim(base, WORKSTREAM_ID_MAX_CHARS - suffix.length - tag.length) || 'ws'}${tag}${suffix}`;
  }
  // The construction above cannot produce a name the regex refuses, and this is the assertion that
  // says so out loud rather than the campaign discovering otherwise as a branch name. A campaign
  // holding N leases never ends on a control-flow throw, so the fallback is a legal name.
  return WORKSTREAM_ID_RE.test(candidate) ? candidate : `reconcile-${String(taken.length + 1)}`;
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
      `run \`${invokedAs()} doctor\` — its lease check says who holds each slot and whether any ` +
        'holder is dead (a crashed run\'s lease is reclaimed automatically on the next acquire). ' +
        `Then wait for a campaign on ${project} to finish and release its tree, or raise ` +
        `\`max_trees\` under \`[worktree]\` in ${configPath(home)}.`,
    );
  }
  // Anything else here is git or the filesystem refusing — `worktree add` failing, the pool root
  // unwritable, a git too old for `worktree`. All three are exactly what doctor checks, and
  // doctor then owes the exact command.
  return doctorFix();
}

interface SoldierFailure {
  /**
   * The unit, in the words a human reads. `Validator` joined the pair when the last reviewer of a
   * campaign started existing: a diagnosis that called it an Inspector would send a reader looking
   * for a slice review that never happened.
   */
  role: 'Engineer' | 'Inspector' | 'Validator';
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
  provider: {
    release(lease: Lease, opts?: { force?: boolean }): Promise<ReleaseResult>;
    id: string;
  };
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
 * it wins, because it is the one about to reset it.
 *
 * THE OUTCOME IS READ. `release` reports four things and only one of them means the tree came
 * back; this used to `await` it for its exceptions alone and then announce `worktree released`
 * regardless. The stale-lease case is the one that made that a real defect rather than an
 * imprecision: the slot has been re-leased, `lease.path` is another holder's Engineer's tree, and
 * the line this campaign wrote into `signals.jsonl` told an operator recovering from a crash that
 * it had returned it. Both halves of that are wrong — the tree was never returned by this run,
 * and the path names somebody else's work.
 *
 * So the no-op outcomes come back as `not-held`, at `warn`, carrying the PROVIDER'S OWN sentence
 * rather than a re-derivation of it: the provider is the only thing that knows who holds the slot
 * now, and it already puts that in `message`.
 *
 * What is deliberately NOT done: no `retainedTreeFix`. That fix tells a human where their work is
 * and how to inspect it, and for every one of these three outcomes the answer is "not there" —
 * pointing them at a path this run does not hold is worse than saying nothing. The work is
 * durable by the time this function runs; that is the whole precondition of calling it.
 */
async function releaseLease(input: SettleLeaseInput, why: string): Promise<LeaseDisposition> {
  const { lease, note, provider } = input;
  try {
    const result = await provider.release(lease);
    if (!result.released) {
      note('warn', 'lease', `worktree NOT released: ${result.message}`);
      return {
        state: 'not-held',
        path: lease.path,
        leaseId: lease.leaseId,
        reason: result.message,
      };
    }
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

/**
 * A reported denial writes a signal row — a permission denial IS a ceiling breach.
 *
 * THE ROW COUNT IS A FLOOR, NOT A TOTAL, and what is missing from it is the half a reader
 * most wants. Measured against claude 2.1.221: a tool call that MISSES THE ALLOW-LIST is
 * reported in `permission_denials` on the result line and reaches this function. A call that
 * HITS AN EXPLICIT DENY RULE is not — the refusal comes back only as `is_error` on that call's
 * `tool_result`, and `permission_denials` stays empty. The global deny-list is what holds the
 * ceiling against a squad member, so at depth >= 1 the breach this signal exists to raise is
 * exactly the breach it cannot see.
 *
 * That is the harness's behaviour and is not fixable here. What is fixable is the reading:
 * a signals file with no `permission denied` row means nothing was refused for missing the
 * allow-list. It does NOT mean nothing was refused, and it does not mean no ceiling was
 * breached. Anything that treats these rows as a clean bill of health — a reviewer scanning
 * the log, the `view` command's rendering of it, a future gate that refuses to deliver when a
 * breach was recorded — is drawing a conclusion the rows cannot carry. The evidence that a
 * subordinate was refused at depth is the `is_error` tool_result in `stream.jsonl`, which is
 * archived losslessly and is the only place it survives.
 *
 * ## The note is a sentence; the signal keeps the evidence
 *
 * The ARCHIVE row carries the raw denial object serialized, because the archive is evidence and
 * a projection of evidence is a loss. The NOTE — the line a human actually reads on a live
 * terminal — used to carry the same serialized object, and the field transcript shows what that
 * costs: `⚠ cpt-01 was denied: {"tool_name":"Bash","tool_use_id":"toolu_..."...}` scrolling past
 * a person trying to learn which command was refused. So the note extracts `tool_name` and, for
 * Bash, `tool_input.command` (other tools get their input keys, best-effort), capped at 160
 * characters. Exported for the unit test that pins both spellings.
 */
export function recordDenials(
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
    note('warn', 'permission-denied', `${agentId} ${describeDenial(denial)}`);
  }
  // Once per agent per campaign, not per denial — every agent id passes through here exactly
  // once, on its one run. The hint exists because the field Engineer retried one denied command
  // three times and timed out: the human watching needed the sentence more than the model did.
  if (denials.length > 0) {
    note(
      'warn',
      'permission-denied',
      'a denied command will not succeed on retry — the allow-list is fixed for the life of the agent',
    );
  }
}

/** `denied Bash: node --check webvitals.js` — the human-facing half of one denial. */
function describeDenial(denial: unknown): string {
  if (isRecord(denial) && typeof denial['tool_name'] === 'string') {
    const tool = denial['tool_name'];
    const input = denial['tool_input'];
    if (tool === 'Bash' && isRecord(input) && typeof input['command'] === 'string') {
      return `denied ${tool}: ${cap(input['command'], 160)}`;
    }
    if (isRecord(input) && Object.keys(input).length > 0) {
      // Best-effort for a non-Bash tool: the input KEYS say what kind of call it was without
      // betting on any one tool's schema.
      return `denied ${tool} (input: ${cap(Object.keys(input).join(', '), 160)})`;
    }
    return `denied ${tool}`;
  }
  // A shape this function does not recognise still gets reported, as it always was.
  return `was denied: ${cap(typeof denial === 'string' ? denial : JSON.stringify(denial))}`;
}

/**
 * Every repository-relative path a branch changed since it was cut.
 *
 * The AUTHORITATIVE answer to "what did this workstream touch", and the one the live tool-call
 * detector cannot give: it is what the commits actually contain, whichever tool put it there.
 * Best effort, like `writeDiffFor` beside it, and for the same reason — an overlap that could not
 * be computed is worth nothing next to a campaign that ended over a `git` exit code.
 */
async function branchFiles(
  worktree: string,
  branch: string,
  baseCommit: string | null,
): Promise<string[]> {
  const range = baseCommit === null ? branch : `${baseCommit}..${branch}`;
  const result = await runGit(['diff', '--name-only', range], { cwd: worktree });
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Every repository-relative path that is dirty in a worktree right now — modified, staged, added
 * or untracked.
 *
 * THE AUTHORSHIP READING, and the only one that works for a unit holding no git. An INSPECTOR
 * cannot commit, so nothing it wrote is on a branch and `branchFiles` cannot see it; what it wrote
 * is sitting in the tree. `--porcelain` is used rather than `--short` because its format is
 * guaranteed stable across git versions, and `-z` because a path with a space in it is a path this
 * check must not silently split in half — the file most worth catching is the one somebody named
 * awkwardly.
 *
 * A rename (`R  old -> new`) yields TWO NUL-separated fields, and both are recorded: a reviewer that
 * renamed the implementation touched the implementation, whichever half you look at.
 *
 * NULL IS "UNREADABLE", AND IT IS NOT THE SAME ANSWER AS "CLEAN". This used to return `[]` on a
 * non-zero `git status`, and the caller read that as "the reviewer wrote nothing" — which is the
 * fail-OPEN direction: a reviewer that could make `git status` exit non-zero would get no
 * authorship reading, no stray detection, and a verdict that stood. Nobody has demonstrated a
 * reachable trigger and it is closed anyway, because the whole reason this reading exists is that
 * it is the ONE half of the containment that holds on every harness at every posture, and a
 * containment with a fail-open hole in it is a containment whose worst case is the case it was
 * built for. An unreadable tree is not a clean tree, so the caller discards the verdict exactly as
 * it does for a stray, and says which of the two happened.
 */
async function dirtyPaths(worktree: string): Promise<string[] | null> {
  const result = await runGit(['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd: worktree,
  });
  if (result.code !== 0) return null;
  const out: string[] = [];
  // `XY <path>` NUL, and for a rename a second NUL-terminated field follows with the old path.
  const fields = result.stdout.split('\0').filter((entry) => entry !== '');
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i] as string;
    const status = entry.slice(0, 2);
    const file = entry.slice(3).trim();
    if (file !== '' && !out.includes(file)) out.push(file);
    if (status.startsWith('R') || status.startsWith('C')) {
      const source = fields[i + 1];
      i += 1;
      if (source !== undefined && source !== '' && !out.includes(source)) out.push(source);
    }
  }
  return out.sort();
}

/**
 * Does this repository keep its tests somewhere `TEST_PATH_GLOBS` would reach?
 *
 * Half of the permanence rule: `docs/main-flow.md` says a reviewer's tests are permanent "if the
 * spec named verification commands and the repo has a test directory". A DIRECTORY, deliberately,
 * and not "any file matching a test glob" — a repository with one stray `foo.test.js` and no test
 * directory has no convention for a reviewer to write into, and a test dropped somewhere nobody
 * runs is worse than one that goes with the worktree, because it looks permanent.
 */
function hasTestDirectory(project: string): boolean {
  for (const dir of ['test', 'tests', 'spec', '__tests__']) {
    try {
      if (fs.statSync(path.join(project, dir)).isDirectory()) return true;
    } catch {
      /* not there; try the next convention */
    }
  }
  return false;
}

/**
 * Commit the test paths a reviewer wrote onto the branch it reviewed. The SUPERVISOR does this.
 *
 * ## Why the supervisor and not the reviewer
 *
 * `ROLE_ALLOW.INSPECTOR` holds no git and never will: the branch under review is not the reviewer's
 * to move, and a reviewer that could commit could commit anything. So the reviewer writes files and
 * this process decides whether they become history — which is also the only way the "only test
 * paths" rule can be enforced at the moment it matters, because `git add <these paths>` cannot add
 * a path that is not in the list, whatever else is dirty in the tree.
 *
 * Best effort. A commit that fails leaves the tests in the worktree, which is exactly the
 * `permanent: false` outcome, and that is a degradation rather than a failure: nothing downstream
 * depends on these files existing, and the verdict that referenced them is already in the archive.
 */
/**
 * Put back everything a reviewer left in a worktree that this process did not commit.
 *
 * ## Why a temporary test has to actually be temporary
 *
 * "Otherwise they run and go with the worktree" is true at the END of a workstream, when the lease
 * is settled and the tree is reset. It is NOT true in between: a workstream that is retried runs
 * its next engineer in the SAME tree, and that engineer's `git add -A` would sweep up a reviewer's
 * scratch test and commit it under the engineer's name, onto the branch, in a campaign that decided
 * these tests were not permanent. The next inspector would then review a diff containing a test the
 * previous inspector wrote, attributed to the engineer, and precondition 3 — authorship being
 * separately visible — would be false while still looking true.
 *
 * It is also the cleanup for a reviewer that STRAYED. Those writes are edits to the implementation
 * under review sitting in the engineer's tree, and leaving them for the next engineer to commit is
 * the containment failing at the last moment.
 *
 * Both spellings, because a reviewer's file may be tracked (it edited an existing test) or
 * untracked (it wrote a new one), and neither command handles the other. Best effort: this runs
 * after the verdict is already recorded, and a tree that could not be cleaned is settled and reset
 * by the `finally` regardless.
 */
async function discardWorkerWrites(worktree: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return;
  await runGit(['checkout', '--', ...files], { cwd: worktree });
  await runGit(['clean', '-f', '-q', '--', ...files], { cwd: worktree });
}

export async function commitInspectorTests(input: {
  worktree: string;
  branch: string;
  /** Path AND content: what lands is what the reviewer wrote, not what is on disk now. */
  files: readonly { path: string; content: string }[];
  /** The reviewers that wrote them. For the commit message, so authorship is on the branch too. */
  authors: readonly string[];
  /**
   * The `CPT·VALIDATOR` that actually ran these files, in a process the reviewers do not own.
   *
   * PRECONDITION 4, CHECKED WHERE IT IS DECIDABLE. It used to be checked at spawn time, as
   * `validatorFollows: true` handed to `assertInspectorWriteContained` — a claim about a future
   * that nothing computed and that a campaign was routinely wrong about. A spawn cannot know
   * whether a validator will run; THIS function is called at the only moment anybody can, which is
   * after one has. So the refusal lives here, and it can actually fire.
   */
  validatedBy: string;
}): Promise<string[]> {
  if (input.files.length === 0) return [];
  if (input.validatedBy.trim() === '') {
    throw new Error(
      'refusing to commit reviewer-written tests onto ' +
        `${input.branch}: no VALIDATOR is named as having run them. Precondition 4 on ` +
        'INSPECTOR_TEST_WRITE_RULES is that tests a reviewer writes are run again in a process ' +
        'the reviewer does not own, and a commit is what makes them history. History follows the ' +
        'fact; it does not precede it.',
    );
  }
  const paths = input.files.map((file) => file.path);
  // Re-written from what was HELD, immediately before the add. Anything that stood in this tree
  // and edited one of these files loses; what becomes a commit is what the reviewer wrote.
  for (const file of input.files) {
    try {
      fs.mkdirSync(path.dirname(path.join(input.worktree, file.path)), { recursive: true });
      fs.writeFileSync(path.join(input.worktree, file.path), file.content);
    } catch {
      return [];
    }
  }
  const added = await runGit(['add', '--', ...paths], { cwd: input.worktree });
  if (added.code !== 0) return [];
  const committed = await runGit(
    [
      'commit',
      '--quiet',
      '-m',
      `army: tests written by ${input.authors.join(', ')} while reviewing ${input.branch}, ` +
        `run by ${input.validatedBy} before landing`,
    ],
    { cwd: input.worktree },
  );
  if (committed.code !== 0) return [];
  return paths;
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
 * The reasoning effort an ENGINEER is dispatched at when its orders carry no `TechnicalSpec`.
 *
 * ## Why this is an ESCALATION and not a downgrade
 *
 * A trial ran the same task at all five reasoning levels under two briefs carrying identical
 * constraints, differing only in whether the thinking had been done above. Under a COMPLETE brief
 * every effort level succeeded, including the lowest, in 1m12s for $0.29. Under a THIN brief six
 * of eight arms failed; the one that succeeded reliably was `xhigh`, at 9m42s and $1.64 — 8x the
 * time and 5.7x the cost of just writing the brief.
 *
 * The config's own default effort is moving to `low` in a concurrent unit — cheap, because a
 * spec is expected to carry the thinking. This constant is what happens when that expectation is
 * false: the worker has to do the thinking itself instead of executing someone else's, and it
 * needs the budget for it. Failing toward MORE reasoning when the brief is thin is the safe
 * direction, and it is what the trial's one reliably successful thin arm actually needed.
 */
export const UNSPECIFIED_BRIEF_EFFORT: ReasoningEffort = 'xhigh';

/**
 * The largest single test file this process will carry from a reviewer's tree to the validator's.
 *
 * A held test is content in memory for the length of a campaign, and the unit that wrote it holds
 * an editor. 512 KiB is two orders of magnitude above any test file in this repository and small
 * enough that a reviewer cannot make the supervisor its heap. Over the cap the file is left where
 * it was written, which is the `permanent: false` outcome the campaign already knows how to have.
 */
export const REVIEWER_TEST_MAX_BYTES = 512 * 1024;

/**
 * The static vendor split, read from the config's `rules[]` with the built-in default as
 * the fallback. Deliberately dumb: v1 matches by role, not by natural language, and the rules
 * array exists so the upgrade to quota-resolved candidates is a config change, not a rewrite.
 *
 * `hasSpec` is read for the ENGINEER only, and only to decide effort: a spec present means the
 * decisions were made upstream, so the configured effort — whatever it is, cheap or not — is left
 * alone; a spec absent overrides it to `UNSPECIFIED_BRIEF_EFFORT`, because the alternative is a
 * cheap worker silently answering questions nobody asked it. An INSPECTOR reviews the finished
 * branch against the objective regardless of how it got there, so `hasSpec` is not read for it —
 * passed through only so both call sites share one signature.
 */
export function dispatchFor(
  config: { dispatch: { rules: { when: string; use: { harness: HarnessId; model?: string; effort?: ReasoningEffort }[] }[] } },
  role: Role,
  hasSpec: boolean,
): { harness: HarnessId; model?: string; effort?: ReasoningEffort } {
  // The two REVIEWING roles go to the other vendor. `VALIDATOR` joins `INSPECTOR` here rather than
  // getting a branch of its own because the reason is identical and belongs to the pair: a reviewer
  // must not share the builder's blind spots, and the last reviewer of a campaign least of all.
  const wanted = role === 'INSPECTOR' || role === 'VALIDATOR' ? 'codex' : 'claude';
  let target: { harness: HarnessId; model?: string; effort?: ReasoningEffort } = { harness: wanted };
  for (const rule of config.dispatch.rules) {
    const candidate = rule.use[0];
    if (candidate !== undefined && candidate.harness === wanted) {
      target = candidate;
      break;
    }
  }
  if (role === 'ENGINEER' && !hasSpec) {
    return { ...target, effort: UNSPECIFIED_BRIEF_EFFORT };
  }
  return target;
}

/**
 * Every harness this machine's config actually names a target for.
 *
 * READ OFF `rules[].use[0].harness`, which is the only field `dispatchFor` reads, so "configured"
 * here means the same thing it means when a dispatch is resolved rather than something adjacent to
 * it. A machine whose config names one harness twice has one harness configured.
 */
export function configuredHarnesses(config: {
  dispatch: { rules: { use: { harness: HarnessId }[] }[] };
}): HarnessId[] {
  const out: HarnessId[] = [];
  for (const rule of config.dispatch.rules) {
    const candidate = rule.use[0];
    if (candidate !== undefined && !out.includes(candidate.harness)) out.push(candidate.harness);
  }
  return out;
}

/** The first configured target for one harness — the same read `dispatchFor` makes, by harness. */
function targetForHarness(
  config: { dispatch: { rules: { use: { harness: HarnessId; model?: string; effort?: ReasoningEffort }[] }[] } },
  harness: HarnessId,
): { harness: HarnessId; model?: string; effort?: ReasoningEffort } {
  for (const rule of config.dispatch.rules) {
    const candidate = rule.use[0];
    if (candidate !== undefined && candidate.harness === harness) return candidate;
  }
  return { harness };
}

/**
 * Where a reviewer runs, and whether this machine could actually give it a different vendor from
 * the worker it is reviewing.
 *
 * ## The rule, and the honest failure of it
 *
 * `docs/main-flow.md`: the inspector runs "on a different provider from the engineer where the
 * machine has one configured. If only one provider is configured the campaign continues and records
 * the downgrade as a note, the same way a retired worktree provider is recorded."
 *
 * So this returns the dispatch target AND `downgraded`, rather than silently resolving to whatever
 * `dispatchFor` had. A campaign in which reviewer and engineer share a vendor is still a campaign
 * worth running — a review by the same family of model catches plenty — but it is NOT the
 * independence the review gate's design rests on, and a reader is owed the difference. Reported
 * rather than inferred, for the reason `CodexConfinement.networkAccess` is: a caller reading a
 * decision is a caller that cannot get it subtly wrong.
 */
export function reviewerDispatch(
  config: { dispatch: { rules: { when: string; use: { harness: HarnessId; model?: string; effort?: ReasoningEffort }[] }[] } },
  role: 'INSPECTOR' | 'VALIDATOR',
  engineerHarness: HarnessId,
  hasSpec: boolean,
): { target: { harness: HarnessId; model?: string; effort?: ReasoningEffort }; downgraded: boolean } {
  const preferred = dispatchFor(config, role, hasSpec);
  // WHAT THE MACHINE CONFIGURES, not what `dispatchFor` would like. `dispatchFor` falls back to
  // `codex` for a reviewer whether or not any rule names one, which is the right default and the
  // wrong answer to "does this machine have a second provider": read that way, the downgrade could
  // never fire and the note the design asks for would be unreachable code.
  const other = configuredHarnesses(config).find((id) => id !== engineerHarness);
  if (other === undefined) {
    // The reviewer runs beside the worker it is reviewing. Its target is the one CONFIGURED for
    // that harness, never `preferred` with its harness swapped: `preferred` may carry a model id
    // that belongs to the vendor this machine does not have, and a claude process asked for
    // `gpt-5.5` fails at spawn rather than degrading.
    return { target: targetForHarness(config, engineerHarness), downgraded: true };
  }
  if (preferred.harness !== engineerHarness) return { target: preferred, downgraded: false };
  return { target: targetForHarness(config, other), downgraded: false };
}

/**
 * Wall-clock ceiling for one campaign soldier when the caller sets no `timeoutMs`.
 *
 * The claude adapter's own `closeGraceMs` default is 300s — a fine backstop for the short
 * sessions it was written for, and a silent hard wall for a campaign Engineer: `timeoutMs` was
 * only ever forwarded to codex, so every claude soldier still working at 300s was SIGTERMed
 * mid-task, burned an attempt, and ended the campaign `engineer-failed` with nothing to review.
 * The repo's own trial data (`TrialSpec.armTimeoutMs` in `src/contracts/trial.ts`) measured a
 * spec-less `xhigh` Engineer — the exact configuration `UNSPECIFIED_BRIEF_EFFORT` dispatches —
 * at 9m42s, so the 300s default GUARANTEED those campaigns died.
 *
 * 30 minutes is codex's own `CODEX_DEFAULTS.timeoutMs`, adopted rather than invented: it fits
 * the measured 9m42s worst case three times over, and one scale for both harnesses means an
 * Engineer's budget does not depend on which vendor the dispatch table picked. Threaded from
 * HERE, not changed in the adapters, whose defaults other consumers (chat's commander session,
 * the trial runner) still rely on.
 */
export const DEFAULT_SOLDIER_TIMEOUT_MS = 30 * 60_000;

/**
 * The options `adapterFor` hands the harness factory — every branch, one place.
 *
 * Split out and exported for the unit test that pins the ceiling onto ALL FOUR branches
 * (claude/codex, injected bin or not) without spawning anything. The bug this answers lived in
 * exactly the gap a spawning test cannot cover cheaply: `timeoutMs` reached codex-with-a-bin and
 * silently died on the way to every claude branch and the no-bin defaults.
 */
export function soldierAdapterSettings(
  options: Pick<CampaignOptions, 'timeoutMs' | 'claudeBin' | 'codexBin'>,
  harness: HarnessId,
): { claude: ClaudeAdapterOptions } | { codex: CodexAdapterOptions } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOLDIER_TIMEOUT_MS;
  if (harness === 'claude') {
    // `closeGraceMs` is the claude spelling of a work ceiling: `runSoldier` closes stdin right
    // after the orders, so the grace-before-SIGTERM window IS the soldier's whole working time.
    return {
      claude: {
        ...(options.claudeBin === undefined ? {} : { bin: options.claudeBin }),
        closeGraceMs: timeoutMs,
      },
    };
  }
  return {
    codex: {
      ...(options.codexBin === undefined ? {} : { bin: options.codexBin }),
      timeoutMs,
    },
  };
}

function adapterFor(options: CampaignOptions, harness: HarnessId): HarnessAdapter {
  const injected = options.adapters?.[harness];
  if (injected !== undefined) return injected;
  // Built per campaign rather than read from the adapter registry: the registry entries carry
  // the adapters' own defaults, and the campaign's soldier ceiling must ride along on every
  // branch. `ARMY_CLAUDE_BIN` / `ARMY_CODEX_BIN` are still honoured — the factories read them.
  const settings = soldierAdapterSettings(options, harness);
  return 'claude' in settings
    ? createClaudeAdapter(settings.claude)
    : createCodexAdapter(settings.codex);
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
