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
 *  - **Rung 3 is unimplemented and REFUSES.** It does not quietly do rung 2 instead. "I could not
 *    do X so I did Y" is the exact failure an independent Inspector exists to catch; a
 *    delivery module must not commit it itself.
 *
 * The global deny-list is honoured structurally: every git call goes through `git.ts`, which
 * refuses `git push --force*` before spawning, and every gh call refuses `gh pr merge`.
 */

import { resolve } from 'node:path';

import type { DeliveryPlan, Rung } from '../contracts/delivery.ts';
import { effectiveRung, RUNG_LABEL } from '../contracts/delivery.ts';
import type { DeliveryDefaults, GlobalConfig } from '../contracts/config.ts';
import type { Verdict } from '../contracts/report.ts';
import { armyBranch } from '../contracts/worktree.ts';
import { ensureDurable, resolveDurabilityTarget } from './durability.ts';
import type { DurabilityResult } from './durability.ts';
import { gh, probeGh } from './git.ts';
import type { GhStatus } from './git.ts';

/** Rungs this module can actually execute. Rung 3 (merge) is deliberately absent. */
export const IMPLEMENTED_RUNGS = [0, 1, 2] as const;

export function isImplementedRung(rung: Rung): boolean {
  return (IMPLEMENTED_RUNGS as readonly number[]).includes(rung);
}

export type DeliveryNoteCode =
  | 'ceiling-missing'
  | 'ceiling-default'
  | 'clamped'
  | 'rung-unimplemented'
  | 'durability-mirror'
  | 'no-origin'
  | 'gh-unavailable'
  | 'gh-unauthenticated'
  | 'pr-opened'
  | 'review-posted'
  | 'review-not-posted';

/** Machine-readable, so a supervisor can turn it into a signal row unchanged. */
export interface DeliveryNote {
  level: 'info' | 'warn' | 'error';
  code: DeliveryNoteCode;
  message: string;
}

export class RungNotImplementedError extends Error {
  readonly rung: Rung;
  readonly plan: DeliveryPlan;
  constructor(rung: Rung, plan: DeliveryPlan) {
    super(
      `rung ${rung} (${RUNG_LABEL[rung]}) is not implemented. Refusing — a delivery module that ` +
        'quietly ships one rung lower than it was told to is indistinguishable from one that ' +
        'worked, and "I could not do X so I did Y" is precisely the failure the review gate ' +
        `exists to catch. Lower the request to ${RUNG_LABEL[2]} explicitly, or ` +
        'lower the project ceiling so the clamp is recorded on the plan.',
    );
    this.name = 'RungNotImplementedError';
    this.rung = rung;
    this.plan = plan;
  }
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
      level: 'error',
      code: 'rung-unimplemented',
      message: `rung 3 (${RUNG_LABEL[3]}) is not implemented; running this plan will refuse.`,
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
  /** Required to reach rung 2 in full — the review is half of what rung 2 means. */
  verdict?: Verdict;
  pr?: PullRequestInput;
  /**
   * Injectable so rung-2 capping is testable with no network and no GitHub account. Defaults to
   * the real probe, which does talk to the API via `gh auth status`.
   */
  ghProbe?: () => Promise<GhStatus>;
}

export interface LadderResult {
  plan: DeliveryPlan;
  /** The highest rung actually reached. May be below `plan.rung` — always with a note saying why. */
  delivered: Rung;
  durability: DurabilityResult;
  notes: DeliveryNote[];
  pr: { url: string; reviewPosted: boolean } | null;
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
    const status = await (input.ghProbe ?? (() => probeGh()))();
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
      const url = await gh(
        prCreateArgs(plan.branch, input.pr ?? defaultPullRequest(plan.taskId, plan.branch)),
        { cwd: plan.project },
      );
      delivered = 2;
      notes.push({ level: 'info', code: 'pr-opened', message: `opened ${url}` });

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
          await gh(prReviewArgs(url, input.verdict), { cwd: plan.project });
          reviewPosted = true;
          notes.push({
            level: 'info',
            code: 'review-posted',
            message: `Inspector verdict (${input.verdict.verdict}) posted as a review on ${url}.`,
          });
        } catch (error) {
          notes.push({
            level: 'warn',
            code: 'review-not-posted',
            message: `pull request opened, but posting the Inspector verdict failed: ${
              error instanceof Error ? error.message.split('\n')[0] : String(error)
            }`,
          });
        }
      }
      pr = { url, reviewPosted };
    }
  }

  return { plan, delivered, durability, notes, pr };
}

function defaultPullRequest(taskId: string, branch: string): PullRequestInput {
  return {
    title: `army: ${taskId}`,
    body: `Opened by agentic-army for task \`${taskId}\` from \`${branch}\` (rung 2).`,
  };
}
