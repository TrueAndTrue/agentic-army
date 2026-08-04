/**
 * The delivery ladder.
 *
 * The rungs are PREFIXES, NOT ALTERNATIVES: 0 commit → 1 push → 2 pull request → 3 merge. Rung 2
 * therefore does everything rung 1 does and then some, which is why this module runs the ladder
 * from the bottom and reports the highest rung it actually reached.
 *
 * Three rules are load-bearing and each has a test:
 *
 *  - **The ceiling comes from the GLOBAL config, keyed by absolute project path, and NOTHING
 *    ELSE.** Never a file in the repository being worked on. A cloned repo that could ship its
 *    own ceiling would be handing whoever wrote it the right to open pull requests — or, at rung
 *    3, merge them — on your machine. A project absent from the config has no policy, and no
 *    policy fails closed at rung 0.
 *
 *  - **A clamp is never silent.** `effectiveRung` does the clamping; this module keeps
 *    `requested`, `ceiling` and `clamped` on the plan and emits a note, so a campaign shipping
 *    lower than it asked for is visible rather than mysterious.
 *
 *  - **Rung 3 MERGES ONLY AFTER A PASS, AND ONLY THE SUPERVISOR MERGES.** Every other outcome —
 *    a FAIL, a blocked Engineer, an exhausted retry budget, a missing verdict, a verdict that
 *    never reached the pull request, a host that says no — stops at rung 2 and says which one.
 *    It does not quietly do rung 2 and call it a merge: "I could not do X so I did Y" is the
 *    exact failure an independent Inspector exists to catch, and a delivery module must not
 *    commit it itself.
 *
 * The global deny-list is honoured structurally: every git call goes through `git.ts`, which
 * refuses `git push --force*` before spawning. `gh pr merge` is refused there too for every
 * caller that does not hold a `MergeAuthority` — an object minted from the ceiling and the
 * verdict, in this process, and never reachable from a worker's argv.
 */

import { resolve } from 'node:path';

import type { DeliveryPlan, Rung } from '../contracts/delivery.ts';
import { effectiveRung, RUNG_LABEL } from '../contracts/delivery.ts';
import type { DeliveryDefaults, GlobalConfig } from '../contracts/config.ts';
import type { ReportStatus, Verdict } from '../contracts/report.ts';
import { armyBranch } from '../contracts/worktree.ts';
import { ensureDurable, resolveDurabilityTarget } from './durability.ts';
import type { DurabilityResult } from './durability.ts';
import { CommandError, gh, grantMergeAuthority, prMergeArgs, probeGh } from './git.ts';
import type { GhOptions, GhStatus, MergeMethod } from './git.ts';

/**
 * Rungs this module can execute.
 *
 * Rung 3 is on the list, with a condition the other three do not have: the caller must also hand
 * over `RunLadderInput.merge`. A rung whose gate nobody wired is not a rung that ships, so a
 * rung-3 plan with no evidence attached refuses (see `RungNotImplementedError`) rather than
 * delivering rung 2 under a rung-3 heading.
 */
export const IMPLEMENTED_RUNGS = [0, 1, 2, 3] as const;

export function isImplementedRung(rung: Rung): boolean {
  return (IMPLEMENTED_RUNGS as readonly number[]).includes(rung);
}

export type DeliveryNoteCode =
  | 'ceiling-missing'
  | 'ceiling-default'
  | 'clamped'
  /**
   * A planned rung this module cannot execute. No rung reaches it today — `IMPLEMENTED_RUNGS`
   * covers the whole type — and it is retained because it is the structural answer if a rung is
   * ever added, and because the campaign's fix table keys on it.
   */
  | 'rung-unimplemented'
  | 'durability-mirror'
  | 'no-origin'
  | 'gh-unavailable'
  | 'gh-unauthenticated'
  | 'pr-opened'
  | 'review-posted'
  | 'review-not-posted'
  | 'merge-planned'
  | 'merged'
  | 'merge-noop'
  | 'merge-refused'
  | 'merge-blocked'
  | 'merge-uncertain';

/** Machine-readable, so a supervisor can turn it into a signal row unchanged. */
export interface DeliveryNote {
  level: 'info' | 'warn' | 'error';
  code: DeliveryNoteCode;
  message: string;
}

/**
 * A rung was planned that cannot be run — either by this module, or by THIS CALL SITE.
 *
 * The second case is the live one. Rung 3 needs evidence the ladder cannot obtain for itself:
 * whether the Engineer finished, and whether the retry budget ran out. A caller that asks for a
 * merge without supplying it has not implemented rung 3, and the honest answer is to refuse.
 * Delivering rung 2 instead would be the one failure this module exists to avoid, and inventing
 * the missing evidence would be worse.
 */
export class RungNotImplementedError extends Error {
  readonly rung: Rung;
  readonly plan: DeliveryPlan;
  constructor(rung: Rung, plan: DeliveryPlan, reason?: string) {
    super(
      `${reason ?? `rung ${rung} (${RUNG_LABEL[rung]}) is not implemented`}. Refusing — a ` +
        'delivery module that quietly ships one rung lower than it was told to is ' +
        'indistinguishable from one that worked, and "I could not do X so I did Y" is precisely ' +
        `the failure the review gate exists to catch. Lower the request to ${RUNG_LABEL[2]} ` +
        'explicitly, or lower the project ceiling so the clamp is recorded on the plan.',
    );
    this.name = 'RungNotImplementedError';
    this.rung = rung;
    this.plan = plan;
  }
}

/** Why a merge did or did not happen. Every value is a fact about the world, not an intention. */
export type MergeStatus =
  /** The host merged it, on this call. */
  | 'merged'
  /** It was already merged when we looked. Nothing to do, and not a failure. */
  | 'already-merged'
  /** A gate in this process said no: no PASS, no review on the PR, no Engineer `done`, … */
  | 'refused'
  /** The HOST said no: branch protection, required checks, required reviews, a conflict. */
  | 'blocked'
  /** The command failed and the pull request is merged anyway. A human needs to look. */
  | 'uncertain';

export interface MergeOutcome {
  status: MergeStatus;
  /** The pull request this concerns, when one was ever opened. */
  prUrl: string | null;
  /** The commit the merge was authorised for — the one the Inspector rendered its verdict on. */
  headCommit: string | null;
  /** One line: which gate refused, or what the host said. Never empty. */
  detail: string;
}

/**
 * The evidence rung 3 requires from its caller, on top of the ceiling and the verdict.
 *
 * Both fields are REQUIRED inside an optional object, deliberately. Omitting the object is a
 * legible "this call site does not do rung 3"; omitting a field would be a call site that thinks
 * it does. Absent evidence is never read as good news.
 */
export interface MergeRequest {
  /** The Engineer's final status. Only `done` merges — `blocked` and `failed` do not. */
  engineerStatus: ReportStatus;
  /** True when the campaign ran out of Engineer attempts. Only `false` merges. */
  retriesExhausted: boolean;
  /** How the host should merge. Default `squash`. */
  method?: MergeMethod;
}

// ---------------------------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------------------------

/**
 * The only fields the ladder is allowed to read. Notably NOTHING from the repository.
 * `delivery` is optional here so a caller with a partial config still type-checks; absent means
 * the same as absent in the file, which is 0.
 */
export type DeliveryConfig = Pick<GlobalConfig, 'archiveRoot' | 'projects'> & {
  delivery?: DeliveryDefaults;
};

export interface CeilingLookup {
  ceiling: Rung;
  /** False when the project has no policy of its own — the `delivery.default_ceiling` case. */
  known: boolean;
  /** Where the number came from, so a surprising rung can be traced to a line of config. */
  source: 'project' | 'default' | 'fail-closed';
}

/** A rung is 0..3 and an integer. Anything else is treated as absent, never rounded upward. */
function asRung(value: unknown): Rung | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > 3) return null;
  return value as Rung;
}

/**
 * The ceiling for an absolute project path.
 *
 * Order: the project's own policy, then `[delivery] default_ceiling`, then 0. Every step
 * validates and every failure resolves DOWNWARD — a malformed ceiling is not a reason to guess,
 * and `default_ceiling = 9` is not a licence to merge. Raising a ceiling is a deliberate edit
 * to `~/.agentic-army/config.toml`, made outside any conversation.
 */
export function projectCeiling(config: DeliveryConfig, project: string): CeilingLookup {
  const policy = config.projects[resolve(project)];
  if (policy !== undefined) {
    const ceiling = asRung(policy.ceiling);
    if (ceiling === null) return { ceiling: 0, known: true, source: 'fail-closed' };
    return { ceiling, known: true, source: 'project' };
  }
  const fallback = asRung(config.delivery?.defaultCeiling);
  if (fallback === null) return { ceiling: 0, known: false, source: 'fail-closed' };
  return { ceiling: fallback, known: false, source: 'default' };
}

export interface PlanDeliveryInput {
  taskId: string;
  /** Absolute project path — the key into the global config. */
  project: string;
  requested: Rung;
  config: DeliveryConfig;
  /** Defaults to `army/<task-id>`. */
  branch?: string;
}

export interface PlannedDelivery {
  plan: DeliveryPlan;
  notes: DeliveryNote[];
}

/**
 * Resolve the ceiling, clamp, and pick the durability target (creating the army mirror on demand
 * when there is nothing else to push to). Never executes anything.
 */
export async function planDelivery(input: PlanDeliveryInput): Promise<PlannedDelivery> {
  const project = resolve(input.project);
  const notes: DeliveryNote[] = [];

  const { ceiling, known, source } = projectCeiling(input.config, project);
  if (source === 'fail-closed') {
    notes.push({
      level: 'warn',
      code: 'ceiling-missing',
      message: known
        ? `${project} has a policy in the global config but its ceiling is not an integer rung ` +
          '0..3. Failing closed at rung 0 rather than guessing what was meant.'
        : `${project} has no entry in the global config and no usable \`[delivery] ` +
          'default_ceiling`, so it has no delivery policy. Failing closed at rung 0 (commit — ' +
          'durable in the army mirror, your repo untouched). Add it to ' +
          '`~/.agentic-army/config.toml` deliberately to raise it.',
    });
  } else if (source === 'default') {
    notes.push({
      level: 'warn',
      code: 'ceiling-default',
      message:
        `${project} has no entry of its own, so the global \`[delivery] default_ceiling\` of ` +
        `${ceiling} (${RUNG_LABEL[ceiling]}) applies. A per-project entry overrides it.`,
    });
  }

  const rung = effectiveRung(input.requested, ceiling);
  const clamped = input.requested > ceiling;
  if (clamped) {
    notes.push({
      level: 'warn',
      code: 'clamped',
      message:
        `requested rung ${input.requested} (${RUNG_LABEL[input.requested]}) exceeds the ceiling ` +
        `for ${project}, which is ${ceiling} (${RUNG_LABEL[ceiling]}). Delivering at rung ` +
        `${rung}. A campaign may go lower than its ceiling, never higher.`,
    });
  }
  if (rung === 3) {
    notes.push({
      level: 'info',
      code: 'merge-planned',
      message:
        `rung 3 (${RUNG_LABEL[3]}) is planned for ${project}, whose ceiling is 3. It runs only ` +
        'after an Inspector PASS that reached the pull request, with the Engineer done and the ' +
        'retry budget intact, and only if the host permits the merge. Anything else stops at ' +
        `rung 2 (${RUNG_LABEL[2]}) and says which.`,
    });
  }

  const durability = await resolveDurabilityTarget({
    project,
    archiveRoot: input.config.archiveRoot,
    // Rung 0 means "your repo untouched", so origin is only a durability target once the
    // campaign is cleared to push. Below that the army mirror carries it.
    allowOrigin: rung >= 1,
  });
  if (durability.kind === 'mirror') {
    notes.push({
      level: 'info',
      code: 'durability-mirror',
      message:
        `durability target is the army mirror at ${durability.url}. Work still leaves the ` +
        'ephemeral worktree before any lease is returned — durability is unconditional.',
    });
  }

  const plan: DeliveryPlan = {
    taskId: input.taskId,
    project,
    requested: input.requested,
    ceiling,
    rung,
    branch: input.branch ?? armyBranch(input.taskId),
    durability,
    clamped,
  };
  return { plan, notes };
}

// ---------------------------------------------------------------------------------------------
// pure argv builders — testable offline, which is the whole reason they are separate
// ---------------------------------------------------------------------------------------------

export interface PullRequestInput {
  title: string;
  body: string;
  /** Base branch. Omitted → gh uses the repository's default branch. */
  base?: string;
}

export function prCreateArgs(branch: string, pr: PullRequestInput): string[] {
  const args = ['pr', 'create', '--head', branch, '--title', pr.title, '--body', pr.body];
  if (pr.base !== undefined && pr.base !== '') args.push('--base', pr.base);
  return args;
}

/**
 * Always `--comment`, never `--approve` and never `--request-changes`.
 *
 * The Inspector verdict is posted as a review; that is not a licence to put a GitHub APPROVAL
 * on a pull request. An approval is a state change that branch protection and
 * auto-merge act on — it is a step toward rung 3 taken without anyone asking for rung 3.
 * A comment review carries the whole verdict and moves nothing.
 */
export function prReviewArgs(prRef: string, verdict: Verdict): string[] {
  return ['pr', 'review', prRef, '--comment', '--body', formatVerdictReview(verdict)];
}

export function formatVerdictReview(verdict: Verdict): string {
  const lines: string[] = [];
  lines.push(`**Inspector verdict: ${verdict.verdict.toUpperCase()}**`);
  lines.push('');
  lines.push(verdict.summary);
  if (verdict.findings.length > 0) {
    lines.push('');
    for (const finding of verdict.findings) {
      const where =
        finding.file === undefined
          ? ''
          : ` (${finding.file}${finding.line === undefined ? '' : `:${finding.line}`})`;
      lines.push(`- **${finding.severity}**${where}: ${finding.message}`);
    }
  }
  lines.push('');
  lines.push(
    verdict.testsRun
      ? `Tests were executed${verdict.testCommand === undefined ? '' : `: \`${verdict.testCommand}\``}.`
      : 'Tests were NOT executed — this verdict is from reading only.',
  );
  lines.push('');
  lines.push('_Posted by agentic-army (CPT·INSPECTOR). Not an approval._');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

export interface RunLadderInput extends PlanDeliveryInput {
  /** The leased worktree holding the branch. */
  worktree: string;
  /**
   * Required to reach rung 2 in full — the review is half of what rung 2 means — and the ONLY
   * thing that authorises rung 3. The verdict posted on the pull request and the verdict that
   * permits the merge are the same object: a merge can never rest on a judgement the reviewers
   * of that pull request cannot see.
   */
  verdict?: Verdict;
  pr?: PullRequestInput;
  /** Rung 3 only. Absent means this call site does not do rung 3, and a rung-3 plan refuses. */
  merge?: MergeRequest;
  /**
   * Injectable so rung-2 capping is testable with no network and no GitHub account. Defaults to
   * the real probe, which does talk to the API via `gh auth status`.
   */
  ghProbe?: () => Promise<GhStatus>;
  /**
   * The `gh` binary. Injectable for the same reason as `ghProbe`, and for one more: it is what
   * lets the rung-3 path be driven end to end — probe, create, review, view, merge — against a
   * stand-in on disk, so the gates are exercised rather than described. Defaults to `gh`.
   */
  ghBinary?: string;
}

export interface LadderResult {
  plan: DeliveryPlan;
  /** The highest rung actually reached. May be below `plan.rung` — always with a note saying why. */
  delivered: Rung;
  durability: DurabilityResult;
  notes: DeliveryNote[];
  pr: { url: string; reviewPosted: boolean } | null;
  /** Rung 3's answer. Null when rung 3 was never planned. */
  merge: MergeOutcome | null;
}

/**
 * Climb the ladder. Durability happens first and unconditionally, so the lease is safe to return
 * the moment this resolves — regardless of which rung was reached.
 */
export async function runLadder(input: RunLadderInput): Promise<LadderResult> {
  const { plan, notes } = await planDelivery(input);

  if (!isImplementedRung(plan.rung)) {
    throw new RungNotImplementedError(plan.rung, plan);
  }
  // BEFORE durability, exactly where the old rung-3 refusal was, so a caller that does not do
  // rung 3 sees the behaviour it always saw. Durability is not skipped by this: the campaign
  // that catches this error runs durability itself on every failure path, which is why the
  // refusal has never cost anyone their work.
  //
  // The evidence IS the trigger. There is no other way to enter the merge path below, so a
  // future edit that deleted this check could not silently start merging — it would stop
  // rung 3 from running at all, which is the direction a mistake here should fail in.
  const mergeRequest = plan.rung === 3 ? requireMergeEvidence(plan, input.merge) : undefined;
  const ghOptions: GhOptions = {
    cwd: plan.project,
    ...(input.ghBinary === undefined ? {} : { binary: input.ghBinary }),
  };

  // Rung 0 and the floor of every rung above it. Throws if the tree is dirty or the branch was
  // never cut — both are cases where releasing the lease would destroy work.
  const durability = await ensureDurable({
    worktree: input.worktree,
    branch: plan.branch,
    project: plan.project,
    archiveRoot: input.config.archiveRoot,
    target: plan.durability,
  });

  let delivered: Rung = 0;
  let pr: { url: string; reviewPosted: boolean } | null = null;

  if (plan.rung >= 1) {
    if (durability.target.kind === 'remote') {
      // The durability push IS the rung-1 push: push is durability. There is no second,
      // ceremonial push to origin.
      delivered = 1;
    } else {
      notes.push({
        level: 'warn',
        code: 'no-origin',
        message:
          `${plan.project} has no \`origin\` remote, so rung 1 (push — branch on origin) cannot ` +
          `be reached. Work is durable in the army mirror at ${durability.target.url}; delivered ` +
          'rung is 0.',
      });
    }
  }

  if (plan.rung >= 2 && delivered >= 1) {
    const status = await (input.ghProbe ?? (() => probeGh(ghOptions)))();
    if (!status.available || !status.authenticated) {
      notes.push({
        level: 'warn',
        code: status.available ? 'gh-unauthenticated' : 'gh-unavailable',
        message:
          `${status.reason ?? 'gh is unusable.'} Capping delivery at rung 1 (push). The branch ` +
          `\`${plan.branch}\` is on ${durability.target.remote}; open the pull request by hand, ` +
          'or authenticate gh and re-run.',
      });
    } else {
      const opened = await openOrAdopt(plan, input.pr, ghOptions);
      const url = opened.url;
      delivered = 2;
      notes.push({
        level: 'info',
        code: 'pr-opened',
        message: opened.adopted
          ? `adopted the pull request already open for \`${plan.branch}\`: ${url}. Nothing was ` +
            'opened twice.'
          : `opened ${url}`,
      });

      let reviewPosted = false;
      if (input.verdict === undefined) {
        notes.push({
          level: 'warn',
          code: 'review-not-posted',
          message:
            'no Inspector verdict was supplied, so the pull request carries no review. Rung 2 ' +
            'means "opened, Inspector verdict posted as a review" — half of it is missing.',
        });
      } else {
        try {
          await gh(prReviewArgs(url, input.verdict), ghOptions);
          reviewPosted = true;
          notes.push({
            level: 'info',
            code: 'review-posted',
            message: `Inspector verdict (${input.verdict.verdict}) posted as a review on ${url}.`,
          });
        } catch (error) {
          // `errorLine`, NOT `error.message.split('\n')[0]`. A `CommandError` from `git.ts`
          // formats its message as `<file> <argv…> exited <code>` and puts the host's own words
          // on the lines BELOW, so the first line is our own command — and for a review that
          // argv ends in `--body **Inspector verdict: PASS**`, so the note the operator reads
          // trailed off into the model's prose instead of saying why the host refused. The
          // reader needs the remote's answer; `errorLine` reaches into `result.stderr` for it.
          notes.push({
            level: 'warn',
            code: 'review-not-posted',
            message: `pull request opened, but posting the Inspector verdict failed: ${errorLine(
              error,
            )}`,
          });
        }
      }
      pr = { url, reviewPosted };
    }
  }

  let merge: MergeOutcome | null = null;
  if (mergeRequest !== undefined) {
    merge = await climbToMerge({
      plan,
      pr,
      delivered,
      headCommit: durability.commit,
      verdict: input.verdict,
      request: mergeRequest,
      gh: ghOptions,
    });
    // Only two of the five statuses are a merge. `uncertain` is one of them because the pull
    // request IS merged — the command that did it merely failed to say so — and reporting rung 2
    // for work that is on the base branch would be a lie in the safe-sounding direction.
    if (merge.status === 'merged' || merge.status === 'already-merged' || merge.status === 'uncertain') {
      delivered = 3;
    }
    notes.push(mergeNote(merge, plan.branch));
  }

  return { plan, delivered, durability, notes, pr, merge };
}

/**
 * The body a reviewer on the code host reads, and the one statement this module makes in public.
 *
 * The rung is READ OFF THE PLAN, never written as a literal. Opening the pull request IS rung 2,
 * so a literal `(rung 2)` was true for as long as 2 was the top of the ladder and became a lie
 * the day rung 3 shipped: a rung-3 campaign merges this very pull request minutes later, and the
 * merged pull request would still be describing itself as the rung below the one it delivered —
 * on a page humans and other reviewers read, which makes it the most public wrong sentence the
 * system can produce. `plan.rung` is the clamped, ceiling-checked number the ladder is actually
 * climbing, and "planned" is the honest qualifier at the moment the body is written: the merge
 * gate has not run yet, and this text must not promise an outcome no one has decided.
 */
function defaultPullRequest(plan: DeliveryPlan): PullRequestInput {
  return {
    title: `army: ${plan.taskId}`,
    body:
      `Opened by agentic-army for task \`${plan.taskId}\` from \`${plan.branch}\`. Planned ` +
      `delivery is rung ${plan.rung} (${RUNG_LABEL[plan.rung]}).`,
  };
}

/**
 * Open the pull request, or adopt the one that is already there.
 *
 * RE-RUNNING A CAMPAIGN IS AN ORDINARY THING TO DO, and `gh pr create` refuses when the branch
 * already has a pull request. Without this, the second run of a rung-3 campaign died at rung 2
 * with the merge never reached, which makes "the pull request is already merged" — a case rung 3
 * is explicitly required to handle — unreachable except by a race. So a create failure is
 * followed by ONE look for an existing pull request on this branch; finding one is a re-run, and
 * finding none re-throws the original failure untouched, because that is a different problem and
 * inventing a pull request would be worse than reporting it.
 */
async function openOrAdopt(
  plan: DeliveryPlan,
  pr: PullRequestInput | undefined,
  opts: GhOptions,
): Promise<{ url: string; adopted: boolean }> {
  try {
    const url = await gh(
      prCreateArgs(plan.branch, pr ?? defaultPullRequest(plan)),
      opts,
    );
    return { url, adopted: false };
  } catch (error) {
    const existing = await findPullRequest(plan.branch, opts);
    if (existing === null) throw error;
    return { url: existing, adopted: true };
  }
}

/** The pull request for `branch`, in any state, or null. Never throws — null means "no". */
async function findPullRequest(branch: string, opts: GhOptions): Promise<string | null> {
  try {
    const raw = await gh(
      ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'url'],
      opts,
    );
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first: unknown = parsed[0];
    if (typeof first !== 'object' || first === null) return null;
    const url = (first as Record<string, unknown>).url;
    return typeof url === 'string' && url !== '' ? url : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// rung 3 — merge
// ---------------------------------------------------------------------------------------------

/** Rung 3 with no evidence attached is a caller that has not implemented rung 3. Refuse. */
function requireMergeEvidence(plan: DeliveryPlan, merge: MergeRequest | undefined): MergeRequest {
  if (merge === undefined) {
    throw new RungNotImplementedError(
      3,
      plan,
      'rung 3 (merge) was planned, and this call site has not implemented it — it supplied no ' +
        'merge evidence, so there is nothing to fail closed on. `RunLadderInput.merge` must ' +
        "carry the Engineer's final status and whether the retry budget was exhausted",
    );
  }
  return merge;
}

interface MergeAttempt {
  plan: DeliveryPlan;
  pr: { url: string; reviewPosted: boolean } | null;
  delivered: Rung;
  /** The commit durability landed. This, and nothing else, is what may be merged. */
  headCommit: string;
  verdict: Verdict | undefined;
  request: MergeRequest;
  gh: GhOptions;
}

/**
 * The gates, then the host.
 *
 * ORDER IS DELIBERATE: everything decidable in this process is decided first, so a campaign that
 * was never going to merge does not announce itself to GitHub on the way to finding out. Each
 * gate returns `refused` with the reason in it; none of them falls through to a default that
 * merges, because there is no default that merges — the merge is the last statement in the
 * function and every path above it returns.
 *
 * IDEMPOTENCE AND PARTIAL FAILURE, decided here rather than left to the reader:
 *
 *  - **Already merged** → `already-merged`, delivered 3, no second merge attempted. Re-running a
 *    campaign whose merge landed is a no-op, not a conflict and not an error.
 *  - **The branch moved under us** → refused. `--match-head-commit` also pins it at the host, so
 *    even a commit that arrives between the check and the merge cannot land. A merge of work the
 *    Inspector never read is exactly the thing rung 3 must not do.
 *  - **The merge half-succeeded** — the host merged and the command still failed, which is what
 *    a dropped connection or a post-merge step failing looks like — → the pull request is
 *    re-read. Merged means `uncertain` (delivered 3, error-level note, a human should look);
 *    anything else means `blocked`. NO RETRY: retrying a merge whose outcome is unknown is how
 *    one merge becomes two.
 *  - **The branch was deleted underneath us** → whatever the host says, reported verbatim as
 *    `blocked`. The army does not recreate a ref someone deleted in order to merge it.
 */
async function climbToMerge(attempt: MergeAttempt): Promise<MergeOutcome> {
  const { plan, pr, headCommit, verdict, request } = attempt;
  const refuse = (detail: string): MergeOutcome => ({
    status: 'refused',
    prUrl: pr?.url ?? null,
    headCommit,
    detail,
  });

  // The ceiling is the authority. `effectiveRung` already guarantees this; it is asserted again
  // because a merge is the wrong place to trust an invariant that lives in another file.
  if (plan.ceiling !== 3) {
    return refuse(
      `the ceiling for ${plan.project} is ${plan.ceiling} (${RUNG_LABEL[plan.ceiling]}), not 3. ` +
        'Only a project ceiling of 3 can merge, and only a deliberate edit to the global config ' +
        'sets one.',
    );
  }
  if (pr === null || attempt.delivered < 2) {
    return refuse(
      'there is no pull request to merge — rung 2 was not reached, so rung 3 cannot be. The ' +
        'rungs are prefixes: a merge is the last step of a pull request, not an alternative to ' +
        'one.',
    );
  }
  if (verdict === undefined) {
    return refuse(
      'no Inspector verdict was supplied. A merge requires a PASS; a missing verdict is not a ' +
        'PASS, and it is not a reason to go and look for a more agreeable one.',
    );
  }
  if (verdict.verdict !== 'pass') {
    return refuse(
      `the Inspector verdict is ${verdict.verdict.toUpperCase()}: ${verdict.summary} The pull ` +
        'request stays open with that verdict on it, which is the correct outcome — a FAIL is ' +
        'information, not an obstacle.',
    );
  }
  if (!pr.reviewPosted) {
    return refuse(
      'the Inspector verdict could not be posted on the pull request, so rung 2 is incomplete ' +
        'and rung 3 does not start. Merging on a judgement nobody reviewing the pull request ' +
        'can see is a merge with no visible reason.',
    );
  }
  if (request.engineerStatus !== 'done') {
    return refuse(
      `the Engineer's final status is \`${request.engineerStatus}\`, not \`done\`. Work that ` +
        'stopped short does not merge, whatever an Inspector made of the fragment it read.',
    );
  }
  if (request.retriesExhausted) {
    return refuse(
      'the retry budget was exhausted. A campaign that ran out of attempts has not finished; it ' +
        'has stopped, and the two are not the same thing.',
    );
  }

  const authority = grantMergeAuthority({
    ceiling: plan.ceiling,
    verdict: verdict.verdict,
    prRef: pr.url,
    headCommit,
  });
  if (authority === null) {
    // Unreachable given the gates above, which is the point: the guard in `git.ts` is checked
    // independently of them, so the two would have to fail together for a merge to escape.
    return refuse(
      'no merge authority could be minted for this pull request, so `gh pr merge` is refused by ' +
        'the allow-list. Fail closed.',
    );
  }

  const before = await readPrState(pr.url, attempt.gh);
  if (before === null) {
    return {
      status: 'blocked',
      prUrl: pr.url,
      headCommit,
      detail:
        `the state of ${pr.url} could not be read, so there is nothing to decide from. A merge ` +
        'is not attempted against an unknown state.',
    };
  }
  if (before.state === 'MERGED') {
    return {
      status: 'already-merged',
      prUrl: pr.url,
      headCommit,
      detail: `${pr.url} was already merged. Nothing to do; rung 3 is idempotent.`,
    };
  }
  if (before.state !== 'OPEN') {
    return {
      status: 'blocked',
      prUrl: pr.url,
      headCommit,
      detail: `${pr.url} is ${before.state.toLowerCase()}, not open. A closed pull request is a ` +
        'decision someone made; it is not merged over.',
    };
  }
  if (before.headRefOid !== '' && before.headRefOid !== headCommit) {
    return refuse(
      `the pull request now points at ${before.headRefOid.slice(0, 12)}, but the Inspector ` +
        `passed ${headCommit.slice(0, 12)}. Something was pushed to the branch after the ` +
        'verdict; merging would land work nothing inspected.',
    );
  }

  try {
    const out = await gh(prMergeArgs(pr.url, headCommit, request.method ?? 'squash'), {
      ...attempt.gh,
      authority,
    });
    return {
      status: 'merged',
      prUrl: pr.url,
      headCommit,
      detail: firstLine(out) || `merged ${pr.url} at ${headCommit.slice(0, 12)}.`,
    };
  } catch (error) {
    const said = errorLine(error);
    const after = await readPrState(pr.url, attempt.gh);
    if (after !== null && after.state === 'MERGED') {
      return {
        status: 'uncertain',
        prUrl: pr.url,
        headCommit,
        detail:
          `the merge command failed (${said}) but ${pr.url} is merged. The merge landed and ` +
          'something after it did not. Nothing is retried: check the branch and the base by ' +
          'hand before running anything else against this pull request.',
      };
    }
    return {
      status: 'blocked',
      prUrl: pr.url,
      headCommit,
      detail:
        `the host refused the merge: ${said}. That is an answer, not an obstacle — branch ` +
        'protection, a required check, a required review or a conflict is the remote saying no, ' +
        'and it is honoured as stated. Nothing is forced and nothing is overridden.',
    };
  }
}

interface PrSnapshot {
  /** `OPEN` | `MERGED` | `CLOSED`, upper-cased. */
  state: string;
  /** May be empty when the host does not report one — which is treated as "cannot confirm". */
  headRefOid: string;
}

/**
 * Read a pull request's state. Returns null on ANY failure — a deleted branch, a repo that
 * moved, malformed JSON, gh falling over. The caller reads null as "unknown", and unknown never
 * merges.
 */
async function readPrState(prRef: string, opts: GhOptions): Promise<PrSnapshot | null> {
  try {
    const raw = await gh(['pr', 'view', prRef, '--json', 'state,headRefOid'], opts);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.state !== 'string' || record.state === '') return null;
    return {
      state: record.state.toUpperCase(),
      headRefOid: typeof record.headRefOid === 'string' ? record.headRefOid : '',
    };
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

/** What the host actually said, capped — a merge refusal is worth quoting, not paraphrasing. */
function errorLine(error: unknown): string {
  if (error instanceof CommandError) {
    const said = error.result.stderr.trim() || error.result.stdout.trim();
    return firstLine(said) || `exit ${String(error.result.code)}`;
  }
  return error instanceof Error ? firstLine(error.message) : String(error);
}

function mergeNote(outcome: MergeOutcome, branch: string): DeliveryNote {
  switch (outcome.status) {
    case 'merged':
      return {
        level: 'info',
        code: 'merged',
        message: `rung 3: merged \`${branch}\` — ${outcome.detail}`,
      };
    case 'already-merged':
      return { level: 'info', code: 'merge-noop', message: `rung 3: ${outcome.detail}` };
    case 'refused':
      return {
        level: 'warn',
        code: 'merge-refused',
        message: `rung 3 refused, delivered rung 2: ${outcome.detail}`,
      };
    case 'blocked':
      return {
        level: 'warn',
        code: 'merge-blocked',
        message: `rung 3 blocked by the host, delivered rung 2: ${outcome.detail}`,
      };
    case 'uncertain':
      return { level: 'error', code: 'merge-uncertain', message: `rung 3: ${outcome.detail}` };
  }
}
