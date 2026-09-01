/**
 * The `MAJ·OVERSEER` — the feature owner, and the middle rung of the question ladder.
 *
 * ```
 * ☆ GENERAL (this process)
 *  └─ spawns ─▶ ◈ MAJ·OVERSEER   claude, NO worktree, Read/Grep/Glob/TodoWrite
 *                   │  segments the feature into workstreams, schema-validated
 *                   │  answers a question climbing from an engineer, or declines
 *                   ▼
 *               the GENERAL acts on it: leases N trees, cuts N branches, merges
 * ```
 *
 * ## THIS MODULE SPAWNS NOTHING, AND THAT IS THE WHOLE SHAPE OF IT
 *
 * Every function here takes an `OverseerSpawn` callback and gets back a structured return. The
 * campaign supplies it, because the campaign owns `buildSoldierSpec`, the archive, the progress
 * stream and the signal handler, and a second spawn path would be a second place where a worker
 * could be built without a deny-list. The gain is not only tidiness: it means the DECISIONS in
 * this file (how many re-segmentations are worth paying for, what a duplicate claim is sent back
 * as, what happens when the overseer returns nothing usable) are testable without spawning
 * anything or leasing a worktree.
 *
 * It also breaks what would otherwise be an import cycle: `campaign.ts` imports this file, this
 * file imports no command module.
 *
 * ## What the overseer is allowed to be
 *
 * `ROLE_ALLOW.OVERSEER` is `Read`, `Grep`, `Glob`, `TodoWrite`, and `WRITES_FILES.MAJOR` is
 * `false`. No editor, no shell, no network, at any rank. The loadout was widened once, to give it
 * git prefixes so it could merge, and the widening was the mistake rather than the table: the
 * overseer decides which workstream merges and the supervising process performs the merge, exactly
 * as it already performs the rung 3 merge that no worker may perform at any rank. Nothing in this
 * file asks for more, and the two calls below both go through the campaign's one spec builder, so
 * there is no route by which one could.
 *
 * ## Two things the overseer is asked, and one it deliberately is not
 *
 * ASKED: segment the feature. ASKED: answer a question climbing from an engineer, or decline it.
 *
 * NOT ASKED: write the brief for a reconciliation engineer. The design says the overseer "writes
 * orders naming both branches and the conflict", and every value in those orders is a branch this
 * process cut or a file `git` reported. Spending a model call to produce a document whose every
 * field has to be supervisor-origin anyway would add a model to the one path where a model's
 * contribution can only be a fabrication. The supervisor mints the reconciliation workstream from
 * the conflict directly, and the overseer's decision is the one it actually owns: whether the
 * conflict is a merge at all or a question that climbs.
 */

import type { PendingQuestion } from '../contracts/question.ts';
import type { ValidationResult } from '../contracts/report.ts';
import type {
  AdjudicationDecision,
  OverseerAnswer,
  Segmentation,
  WorkstreamPlan,
} from '../contracts/workstream.ts';
import {
  ADJUDICATION_SCHEMA_PATH,
  OVERSEER_ANSWER_SCHEMA_PATH,
  SEGMENTATION_SCHEMA_PATH,
  claims,
  duplicateClaims,
  validateAdjudication,
  validateOverseerAnswer,
  validateSegmentation,
} from '../contracts/workstream.ts';
import type { OverlapClaim, OverlapSource } from '../contracts/workstream.ts';
// The one thing this module takes from the view layer that is not a type, for the same reason
// `campaign.ts` takes it: `src/contracts/**` imports nothing, so the neutraliser for
// worker-authored text lives in `src/view/` and is applied HERE, in `src/command/`, at capture.
import { sanitize } from '../view/progress.ts';

// ---------------------------------------------------------------------------------------------
// The seam the campaign supplies
// ---------------------------------------------------------------------------------------------

/** What one `MAJ·OVERSEER` process produced. Shaped like `SoldierRun`, minus what is not read. */
export interface OverseerRun {
  /** The agent id the campaign minted, so notes and signals can name who decided. */
  agentId: string;
  /** The parsed schema-constrained return, or undefined when none arrived. */
  structured: unknown;
  /** The adapter's terminal status. */
  status: string;
  errors: readonly string[];
}

/**
 * Spawn one overseer and drain it.
 *
 * The campaign implements this with the same `buildSoldierSpec` + `runSoldier` pair every other
 * worker goes through, so an overseer gets the global deny-list, the posture, the archive rows and
 * the progress narration for free, and cannot be built without them.
 */
export type OverseerSpawn = (input: {
  /** What it is being asked, for the archive and for the note a human reads. */
  purpose: OverseerPurpose;
  /** The rendered `orders.md`. */
  orders: string;
  /** The capped return's schema. */
  outputSchemaPath: string;
}) => Promise<OverseerRun>;

export const OVERSEER_PURPOSES = ['segmentation', 'question', 'adjudication'] as const;
export type OverseerPurpose = (typeof OVERSEER_PURPOSES)[number];

// ---------------------------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------------------------

/**
 * How many times a feature may be segmented before the campaign stops asking.
 *
 * Two: the plan, and one correction. The correction names the exact paths that collided, so a
 * model that cannot fix a named list in one pass is not going to fix it in a third, and the cost
 * of asking again is a whole model session against a repository it has to read from scratch. What
 * happens instead is the safe answer rather than no answer: the campaign falls back to ONE
 * workstream over the whole objective, which is exactly what it did before workstreams existed.
 */
export const MAX_SEGMENTATION_ROUNDS = 2;

/**
 * Neutralise every overseer-authored string in a validated segmentation, at CAPTURE.
 *
 * ## Why the validator is not enough, and why this is not in the validator
 *
 * `checkLine` in `src/contracts/workstream.ts` caps each string and refuses `\r\n`, which stops the
 * attack it was written for: a slice that opens a `##` section in an engineer's `orders.md` and
 * forges an instruction from the rank above. It permits everything else a terminal obeys: ESC and
 * the CSI sequences behind it, the C1 range, and `U+202E`. An ESC-bearing slice reached an
 * engineer's `orders.md` and a `CampaignNote.message`, and `renderCampaignResult` prints notes raw,
 * so an erase-display and a cursor-home deletes the supervisor-owned lines above it and paints its
 * own in their place.
 *
 * It is not in the validator because `src/contracts/**` imports nothing at all. It is the bottom
 * layer, and `sanitize` lives in `src/view/`, which imports FROM it. So the discipline wave 2
 * settled on for `PendingQuestion` applies unchanged: sanitise in `src/command/`, at the ONE point
 * of capture, so a single call covers the notes, the briefs, the archive rows, the task titles and
 * the result. Sanitising at each render site would cover whichever ones somebody remembered.
 *
 * Structure-preserving: it returns the same `ValidationResult` shape, and an invalid one straight
 * back, so the caller's control flow is untouched.
 */
function neutralised(
  result: ValidationResult<Segmentation>,
): ValidationResult<Segmentation> {
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      rationale: sanitize(result.value.rationale),
      workstreams: result.value.workstreams.map((plan) => ({
        // The id is `WORKSTREAM_ID_RE`-narrow already: lowercase alphanumerics and single
        // separators. There is nothing in it for a terminal to obey.
        id: plan.id,
        slice: sanitize(plan.slice),
        expectedFiles: plan.expectedFiles.map((file) => sanitize(file)),
      })),
    },
  };
}

export type SegmentationOutcome =
  | {
      kind: 'segmented';
      segmentation: Segmentation;
      /** Every overseer that was spawned to reach it, oldest first. */
      agentIds: string[];
      /** How many segmentation rounds were spent. 1 when the first plan was clean. */
      rounds: number;
    }
  | {
      kind: 'unavailable';
      /** One sentence a human can act on. The caller turns this into a note. */
      reason: string;
      agentIds: string[];
    };

export interface SegmentFeatureInput {
  spawn: OverseerSpawn;
  /** `renderSegmentationBrief`, already applied to everything but the rejection line. */
  renderBrief: (previousRejection?: string) => string;
  /** Called between rounds, so a caller can abort a campaign a human has ended. */
  checkpoint?: (during: string) => void;
}

/**
 * Ask a `MAJ·OVERSEER` to cut the feature into workstreams, and refuse a plan that collides.
 *
 * ## Why the collision check is here rather than in the validator
 *
 * `validateSegmentation` answers "is this a segmentation", and the answer to a malformed return is
 * to refuse it. `duplicateClaims` answers "is this a WORKABLE plan", and the answer to two
 * workstreams claiming `src/a.ts` is to hand the overseer that sentence and ask again. Collapsing
 * the two would give both conditions the same message, and only one of them has anything the model
 * can do about it.
 *
 * ## Why a bad plan is not a failed campaign
 *
 * Every failure here resolves to `unavailable`, and the caller's answer to `unavailable` is to run
 * one workstream over the whole objective. That is a real campaign that delivers real work, so an
 * overseer that crashes, times out, or answers off-schema costs the campaign a model session and
 * its parallelism, and never its result.
 */
export async function segmentFeature(input: SegmentFeatureInput): Promise<SegmentationOutcome> {
  const agentIds: string[] = [];
  let rejection: string | undefined;

  for (let round = 1; round <= MAX_SEGMENTATION_ROUNDS; round += 1) {
    input.checkpoint?.(`segmentation round ${String(round)}`);
    const run = await input.spawn({
      purpose: 'segmentation',
      orders: input.renderBrief(rejection),
      outputSchemaPath: SEGMENTATION_SCHEMA_PATH,
    });
    agentIds.push(run.agentId);
    input.checkpoint?.(`segmentation round ${String(round)} (${run.agentId})`);

    const validated = neutralised(validateSegmentation(run.structured));
    if (!validated.ok) {
      // A malformed return is not retried with a correction, because there is nothing specific to
      // correct: the model did not produce the shape, and re-asking the same question is how a
      // campaign spends three sessions on the same refusal. The fallback is one workstream.
      return {
        kind: 'unavailable',
        reason:
          `${run.agentId} returned no usable segmentation (adapter status ${run.status}): ` +
          `${validated.errors.slice(0, 3).join('; ')}`,
        agentIds,
      };
    }

    const collisions = duplicateClaims(validated.value.workstreams);
    if (collisions.length === 0) {
      return { kind: 'segmented', segmentation: validated.value, agentIds, rounds: round };
    }
    rejection = describeCollisions(collisions);
    if (round === MAX_SEGMENTATION_ROUNDS) {
      return {
        kind: 'unavailable',
        reason:
          `${run.agentId}'s segmentation still claims the same paths in two workstreams after ` +
          `${String(MAX_SEGMENTATION_ROUNDS)} rounds. ${rejection}`,
        agentIds,
      };
    }
  }

  // Unreachable: the loop returns on every path. Kept as a value rather than a throw because a
  // campaign holding N leases must never end on a control-flow assertion.
  return { kind: 'unavailable', reason: 'segmentation produced no plan', agentIds };
}

/** The sentence a re-segmentation is asked for with. Supervisor-written, from the file list. */
export function describeCollisions(
  collisions: readonly { file: string; workstreams: string[] }[],
): string {
  const items = collisions
    .slice(0, 10)
    .map((entry) => `\`${entry.file}\` is claimed by ${entry.workstreams.join(' and ')}`);
  const more = collisions.length > items.length ? ` (and ${String(collisions.length - items.length)} more)` : '';
  return `Two workstreams declared the same path, which is a planning error: ${items.join('; ')}${more}.`;
}

// ---------------------------------------------------------------------------------------------
// The middle rung of the question ladder
// ---------------------------------------------------------------------------------------------

export type OverseerVerdictOnQuestion =
  /** It decided. The string goes into the next engineer's orders. */
  | { kind: 'answered'; answer: string; rationale: string; agentId: string }
  /** It read the question and would not decide. The question climbs to the human unchanged. */
  | { kind: 'declined'; rationale: string; agentId: string }
  /** No overseer could be reached, or it returned nothing usable. The question climbs. */
  | { kind: 'unavailable'; reason: string; agentId: string | null };

export interface AskOverseerInput {
  spawn: OverseerSpawn;
  pending: PendingQuestion;
  /** `renderOverseerQuestionBrief`, already applied to everything this module does not decide. */
  renderBrief: () => string;
  checkpoint?: (during: string) => void;
}

/**
 * Put one climbing question to a `MAJ·OVERSEER`.
 *
 * ## Every failure sends the question UP, never down
 *
 * There are three ways this ends and two of them are the same for the caller: an overseer that
 * declines and an overseer that could not be reached both leave the question exactly where it was,
 * on its way to a human. That is the fail-safe direction, and it is the reason the rung could be
 * inserted into `climb()` without the human rung noticing: the only thing that changes for the
 * human is that fewer questions arrive.
 *
 * The direction that would be dangerous is the other one. An overseer that returned something
 * unparseable must never be read as "no answer needed", because the next engineer would be
 * resumed with nothing new and the block would repeat until the question rounds ran out.
 */
export async function askOverseer(input: AskOverseerInput): Promise<OverseerVerdictOnQuestion> {
  input.checkpoint?.(`the overseer's answer to ${input.pending.agentId}'s question`);
  const run = await input.spawn({
    purpose: 'question',
    orders: input.renderBrief(),
    outputSchemaPath: OVERSEER_ANSWER_SCHEMA_PATH,
  });
  input.checkpoint?.(`the overseer's answer to ${input.pending.agentId}'s question (${run.agentId})`);

  const validated = validateOverseerAnswer(run.structured);
  if (!validated.ok) {
    return {
      kind: 'unavailable',
      reason:
        `${run.agentId} returned no usable answer (adapter status ${run.status}): ` +
        `${validated.errors.slice(0, 3).join('; ')}`,
      agentId: run.agentId,
    };
  }
  // NEUTRALISED AT CAPTURE, the same discipline `neutralised` applies to a segmentation and for
  // the same reason: the rationale becomes a `CampaignNote.message` that `renderCampaignResult`
  // prints raw, and the answer becomes a quoted block in a fresh engineer's `orders.md`.
  const answer: OverseerAnswer = {
    answer: validated.value.answer === null ? null : sanitize(validated.value.answer),
    rationale: sanitize(validated.value.rationale),
  };
  if (answer.answer === null || answer.answer === '') {
    return { kind: 'declined', rationale: answer.rationale, agentId: run.agentId };
  }
  return { kind: 'answered', answer: answer.answer, rationale: answer.rationale, agentId: run.agentId };
}

// ---------------------------------------------------------------------------------------------
// The fix loop — who decides what a refusal costs
// ---------------------------------------------------------------------------------------------

/**
 * What the campaign does with a branch a reviewer refused.
 *
 * `by` is the overseer that decided, or null when nobody did and the fail-safe was taken. That
 * distinction is the whole reason this is a record rather than a bare string: a `retry` that an
 * overseer chose and a `retry` that happened because no overseer could be reached produce the same
 * next engineer, and only one of them is a decision. The archive is entitled to know which.
 */
export interface FixDecision {
  decision: AdjudicationDecision;
  /** One line, for the note, the archive row and the next engineer's brief. */
  rationale: string;
  by: string | null;
}

export interface AdjudicateInput {
  spawn: OverseerSpawn;
  /** `renderAdjudicationBrief`, already applied to everything this module does not decide. */
  renderBrief: () => string;
  checkpoint?: (during: string) => void;
}

/**
 * Put one reviewer's refusal to a `MAJ·OVERSEER` and get back retry or accept.
 *
 * ## EVERY FAILURE RESOLVES TO `retry`, AND THAT IS THE DIRECTION THAT MATTERS
 *
 * The two failure modes are not symmetrical here the way they are in `askOverseer`. There, an
 * overseer that could not be reached left the question climbing, which cost a wait. Here, an
 * overseer that could not be reached would — if the fail-safe went the other way — ACCEPT work a
 * reviewer refused, on the strength of a model crashing. So an unusable return is a `retry`: the
 * behaviour a campaign with no overseer at all already has, which is the floor this rung must never
 * fall below.
 *
 * `accept` is therefore the only outcome that requires a model to have said something valid and
 * meant it, and it is recorded with the id of the unit that said it.
 */
export async function adjudicate(input: AdjudicateInput): Promise<FixDecision> {
  input.checkpoint?.("the overseer's adjudication of a refused branch");
  const run = await input.spawn({
    purpose: 'adjudication',
    orders: input.renderBrief(),
    outputSchemaPath: ADJUDICATION_SCHEMA_PATH,
  });
  input.checkpoint?.(`the overseer's adjudication of a refused branch (${run.agentId})`);

  const validated = validateAdjudication(run.structured);
  if (!validated.ok) {
    return {
      decision: 'retry',
      rationale:
        `${run.agentId} returned no usable decision (adapter status ${run.status}): ` +
        `${validated.errors.slice(0, 3).join('; ')}. Retrying, which is what this campaign does ` +
        'with no overseer at all.',
      by: null,
    };
  }
  // NEUTRALISED AT CAPTURE, the same discipline `neutralised` and `askOverseer` apply: this
  // rationale becomes a `CampaignNote.message` that `renderCampaignResult` prints raw, and on a
  // retry it rides into a fresh engineer's `orders.md`.
  return {
    decision: validated.value.decision,
    rationale: sanitize(validated.value.rationale),
    by: run.agentId,
  };
}

// ---------------------------------------------------------------------------------------------
// Overlap attribution
// ---------------------------------------------------------------------------------------------

/**
 * Which of the files a workstream wrote were outside its own declaration, and who else claimed
 * them.
 *
 * PURE, and the reason it is pure is that both callers into it are on hot paths where a mistake is
 * expensive in different ways. One runs inside the loop draining a live engineer's stdout, where
 * anything slow stalls the model itself; the other runs once against a branch diff. Neither wants
 * a function that touches a disk, and both want the same answer.
 *
 * A workstream that declared NOTHING produces no overlaps, and that is not a bug being tolerated:
 * with no declaration there is nothing to be outside of, and reporting every file it wrote as an
 * overlap would bury the real ones. The campaign says separately that the declaration was empty,
 * so an empty overlap list is never read as a clean bill of health.
 */
export function attributeOverlaps(input: {
  /** The writing workstream's own declaration. */
  declaration: readonly string[];
  /** Every other workstream's id and declaration. */
  siblings: readonly Pick<WorkstreamPlan, 'id' | 'expectedFiles'>[];
  /** Repository-relative paths the workstream wrote. */
  files: readonly string[];
  source: OverlapSource;
  /** Files already announced for this workstream, so the same one is not raised twice. */
  known?: ReadonlySet<string>;
}): OverlapClaim[] {
  if (input.declaration.length === 0) return [];
  const out: OverlapClaim[] = [];
  const seen = new Set<string>(input.known ?? []);
  for (const raw of input.files) {
    const file = raw.replace(/^\.\//, '');
    if (file === '' || seen.has(file)) continue;
    if (claims(input.declaration, file)) continue;
    seen.add(file);
    const owner = input.siblings.find((sibling) => claims(sibling.expectedFiles, file));
    out.push({ file, source: input.source, declaredBy: owner?.id ?? null });
  }
  return out;
}
