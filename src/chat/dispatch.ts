/**
 * Dispatch from a conversation — the bridge between a commander's request and real work.
 *
 * ## There is one path to a worktree, and this is not a second one
 *
 * `runDispatch` calls `runCampaign`. Not a copy of it, not a trimmed version of it: the same
 * function `army campaign` calls, with the same review gate, the same permission choke point,
 * the same unconditional durability, the same lease settlement and the same ceiling clamp.
 *
 * That was a deliberate choice over factoring the attempt loop out into a shared helper. The
 * pieces chat would need are not a subset of a campaign — they are ALL of a campaign: lease a
 * tree, brief an Engineer, spawn an independent Inspector from the original orders, retry on a
 * fail, make the branch durable before returning the tree, then run the ladder up to the project
 * ceiling. A "shared core" extracted from that would have been the whole of `campaign.ts` with a
 * different name, and the second caller would have been the only reason it moved. Two
 * implementations plus a drift test is worse than one implementation; so is one implementation
 * that has been cut in half to look shared.
 *
 * What chat adds is above that line and nothing below it: who is allowed to name an objective,
 * and what is allowed back into the commander's window.
 *
 * ## The return path
 *
 * `factsFrom` is a WHITELIST projection, in the same spirit as the Inspector's brief being built
 * from supervisor-owned facts rather than from the party under review. A `CampaignResult` carries
 * notes, per-attempt records, delivery details, lease dispositions and two full schema returns.
 * Almost none of that belongs in a commanding agent's context, and the ones that do are named
 * here, one at a time, with the subordinate-written ones marked as such. Handing the result over
 * whole would mean every future field is classified by accident.
 */

import type { CampaignOptions, CampaignResult } from '../command/campaign.ts';
import { runCampaign } from '../command/campaign.ts';
import type { ArchiveConfig } from '../archive/archive.ts';
import type { Env } from '../config/paths.ts';
import type { Rung } from '../contracts/delivery.ts';
import type { TechnicalSpec } from '../contracts/spec.ts';
import type { GhStatus } from '../delivery/git.ts';
import type { HarnessAdapter, HarnessId } from '../contracts/harness.ts';
import type { WorktreeProviderId } from '../contracts/worktree.ts';
import type { ProgressListener } from '../view/progress.ts';

import type { DispatchOutcomeFacts } from './protocol.ts';
import { cappedFindings } from './protocol.ts';

/**
 * Everything a dispatch needs, and everything it can be told.
 *
 * `objective` is the only field a conversation contributes. Every other field is a session
 * setting, fixed before the first turn, read from the command line and the user's global config.
 * A `DispatchRequest` cannot carry any of them — see `protocol.ts` — so this signature is where
 * that separation stops being a convention and becomes the shape of a function.
 */
export interface DispatchInput {
  /** The objective, exactly as the human approved it. */
  objective: string;
  /**
   * The spec, when the approved dispatch carried one. Threaded straight through to
   * `runCampaign` as `options.spec` — exactly as `objective` is threaded, and for the same
   * reason: this is the human's approval, not a new indirection to keep in step with it.
   */
  spec?: TechnicalSpec;
  cwd: string;
  env: Env;
  home: string;
  requestedRung: Rung;
  maxAttempts: number;
  worktreeProvider?: WorktreeProviderId;
  worktreeRoot?: string;
  claudeBin?: string;
  codexBin?: string;
  adapters?: Partial<Record<HarnessId, HarnessAdapter>>;
  ghProbe?: () => Promise<GhStatus>;
  dbFactory?: ArchiveConfig['dbFactory'];
  timeoutMs?: number;
  /**
   * Narration, as it happens.
   *
   * A dispatch takes minutes and the conversation window is a blocked human staring at a cursor —
   * the same complaint the campaign command answered, arriving unchanged in the newer command.
   * The lifecycle is not chat's to invent: `runCampaign` already offers it, so this field is a
   * pass-through and nothing more. Absent, a dispatch is as silent as it always was.
   *
   * The listener a caller hands over must be one that cannot throw — see `guardedProgress`, which
   * is what `src/chat/run.ts` wraps its terminal sink in before it gets here.
   */
  onProgress?: ProgressListener;
}

/**
 * Make a listener that cannot end a dispatch.
 *
 * A progress listener is a terminal writer, and `write` throws EPIPE the moment the reader goes
 * away — `army chat < script | head` is enough. An exception raised in here would unwind out of
 * `runCampaign` through the one `finally` that settles a worktree lease, so a narration line
 * nobody is reading would be the reason a tree is stranded with an Engineer's branch inside it.
 *
 * `runCampaign` guards its own emissions for exactly this reason; this is the same guarantee at
 * the other end of the wire, for the emissions chat makes on its own account — the interrupt
 * refusal, most of all, which fires from a detached handler while the lease is held and would
 * otherwise surface as an unhandled rejection.
 */
export function guardedProgress(listener: ProgressListener): ProgressListener {
  return (event) => {
    try {
      listener(event);
    } catch {
      /* narration is never load-bearing */
    }
  };
}

/** Raise an Engineer, review it, deliver it — the campaign machinery, unmodified. */
export function runDispatch(input: DispatchInput): Promise<CampaignResult> {
  const options: CampaignOptions = {
    objective: input.objective,
    cwd: input.cwd,
    env: input.env,
    home: input.home,
    requestedRung: input.requestedRung,
    maxAttempts: input.maxAttempts,
    ...(input.spec === undefined ? {} : { spec: input.spec }),
    ...(input.worktreeProvider === undefined ? {} : { worktreeProvider: input.worktreeProvider }),
    ...(input.worktreeRoot === undefined ? {} : { worktreeRoot: input.worktreeRoot }),
    ...(input.claudeBin === undefined ? {} : { claudeBin: input.claudeBin }),
    ...(input.codexBin === undefined ? {} : { codexBin: input.codexBin }),
    ...(input.adapters === undefined ? {} : { adapters: input.adapters }),
    ...(input.ghProbe === undefined ? {} : { ghProbe: input.ghProbe }),
    ...(input.dbFactory === undefined ? {} : { dbFactory: input.dbFactory }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  };
  return runCampaign(options);
}

/**
 * The capped return, built field by field.
 *
 * `objective` comes from the CALLER — the string this process printed and a human confirmed —
 * not from anything the campaign read back. It matters because the objective is the one line the
 * commander will reason about next, and a report that could rewrite it would be able to move the
 * goalposts of the conversation itself, one dispatch at a time.
 *
 * `branch` is `result.branch`, which `armyBranch(taskId)` produced before any Engineer existed.
 * It is not `report.branch`, which is model-controlled free text; the campaign already looks at
 * that discrepancy in its own notes, where it belongs.
 */
export function factsFrom(result: CampaignResult, approvedObjective: string): DispatchOutcomeFacts {
  const last = result.attempts.at(-1) ?? null;
  const verdict = result.verdict ?? last?.verdict ?? null;
  const report = result.report ?? last?.report ?? null;
  return {
    campaignId: result.campaignId,
    objective: approvedObjective,
    branch: result.branch,
    outcome: result.outcome,
    verdict: verdict === null ? null : verdict.verdict,
    testsRun: verdict === null ? null : verdict.testsRun,
    deliveredRung: result.deliveredRung,
    ceiling: result.ceiling,
    attempts: result.attempts.length,
    engineerSummary: report === null ? null : report.summary,
    verdictSummary: verdict === null ? null : verdict.summary,
    findings: cappedFindings(verdict?.findings ?? report?.findings ?? []),
    archive: result.campaignRoot,
  };
}
