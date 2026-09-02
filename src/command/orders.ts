/**
 * Orders and briefs — the review gate.
 *
 * ===============================================================================================
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 *
 *   The Inspector is briefed from the ORIGINAL ORDERS plus the BRANCH.
 *   It is never briefed from the Engineer's account of what it did.
 *
 * ===============================================================================================
 *
 * A reviewer briefed by the party under review only ever learns what that party chose to tell it,
 * and reviews against a goalpost the reviewee moved. The failure that matters most to catch is
 * *"I couldn't do X so I did Y instead"* — and an Inspector told "I implemented Y" will diligently
 * verify that Y works.
 *
 * Everything in this module is PURE: strings in, strings out. No filesystem, no clock, no
 * process. That is what lets the property above be tested directly rather than inferred from an
 * end-to-end run.
 *
 * ## How the rule is made structural rather than remembered
 *
 * `renderInspectorBrief` — the function that actually produces the text — accepts
 * `InspectorBrief`, a type with no field capable of holding narrative. There is no `report`, no
 * `summary`, no `findings`, no `notes`. A future edit that wanted to leak the Engineer's account
 * would have to widen that interface first, which is a visible act rather than an accident.
 *
 * `briefInspectorFromAttempt` is the adapter the orchestrator calls. It takes the whole `Report`
 * because that is what the caller is holding, and immediately projects it through
 * `inspectorFactsFrom`, which is a WHITELIST of exactly one field. The `Report` never reaches the
 * renderer.
 *
 *     Report ──inspectorFactsFrom──▶ InspectorFacts { branch } ──▶ renderInspectorBrief
 *        │                                                              ▲
 *        └────────────────── nothing else crosses ──────────────────────┘
 */

import type { PendingQuestion } from '../contracts/question.ts';
import type { Report, Verdict } from '../contracts/report.ts';
import { RUNG_LABEL } from '../contracts/delivery.ts';
import type { Rung } from '../contracts/delivery.ts';
import { renderTechnicalSpec, SPEC_FIELD_LABEL, SPEC_LIST_FIELDS } from '../contracts/spec.ts';
import type { TechnicalSpec } from '../contracts/spec.ts';
import type { AcceptanceResult } from '../contracts/verify.ts';
import { renderAcceptanceFailure } from '../verify/index.ts';
import { fileRunRules, splitVerifyCommands } from './permissions.ts';

// ---------------------------------------------------------------------------------------------
// The original orders — the campaign's own words, held verbatim
// ---------------------------------------------------------------------------------------------

/**
 * What the Commander asked for, exactly as typed.
 *
 * Held as its own type so that "the original orders" is a thing that can be passed around and
 * archived rather than a string that might have been paraphrased by whoever handled it last.
 * `objective` is never rewritten between the Engineer's brief and the Inspector's.
 */
export interface OriginalOrders {
  /** The `army campaign "<objective>"` argument, verbatim. */
  objective: string;
  /** Absolute path of the project. */
  project: string;
  /** The task these orders belong to. */
  taskId: string;
}

// ---------------------------------------------------------------------------------------------
// Engineer orders
// ---------------------------------------------------------------------------------------------

export interface EngineerOrdersInput {
  orders: OriginalOrders;
  /** The branch the Engineer must cut — a worktree arrives at DETACHED HEAD. */
  branch: string;
  /** Absolute path of the leased worktree. */
  worktree: string;
  /** 1-based. Attempt 2+ carries the previous verdict's findings. */
  attempt: number;
  /**
   * The Inspector's verdict on the PREVIOUS attempt, when this is a retry.
   *
   * This direction is fine and is the whole point of the gate: findings flow reviewer → reviewee.
   * It is the reverse direction — reviewee's narrative → reviewer — that is forbidden.
   */
  previousVerdict?: Verdict;
  /**
   * The acceptance gate's result from the previous attempt, when THAT was what failed it —
   * `spec.verify` commands run mechanically against the branch, before an Inspector was ever
   * spawned. See `src/verify/gate.ts`.
   *
   * Supervisor-origin, like `previousVerdict`: these are commands the SPEC named and a real
   * process actually ran, not the Engineer's account of anything. Rendered with the same
   * prominence as `previousVerdict`'s findings, because an attempt can fail for gate reasons,
   * verdict reasons, or both, and the retry brief has to carry whichever actually happened.
   */
  previousAcceptance?: AcceptanceResult;
  /**
   * 1-based behaviour indices the previous attempt's Inspector never gave a verdict entry for —
   * present only when incomplete behaviour coverage was (part of) why that attempt was retried.
   * Rendered against `spec.behaviours`, which travels in this same input, because an index with
   * no text next to it is not an instruction the Engineer can act on. See `behaviourCoverage` in
   * `campaign.ts`.
   */
  previousMissingBehaviours?: readonly number[];
  /**
   * One supervisor-written sentence about a previous attempt that failed at the HARNESS level —
   * a timeout, a crash, a report that never validated — rather than at a gate. Present only on a
   * retry after such a failure, the same way `previousAcceptance` rides only after a gate
   * failure: an attempt can end with no verdict and no gate output at all, and the fresh
   * Engineer inheriting that attempt's worktree deserves one line saying what became of its
   * predecessor, e.g. `attempt 1 ended with adapter status timeout and produced no report`.
   *
   * Supervisor-origin: composed by the campaign from the adapter's own status, never from
   * anything the previous Engineer wrote.
   */
  previousFailure?: string;
  /**
   * The commander's spec, when the dispatch carried one. Supervisor-origin, approved by a human
   * before this Engineer existed — the opposite direction from `previousVerdict` above, which is
   * why it is safe to render here in full. See `src/contracts/spec.ts` for what it buys.
   */
  spec?: TechnicalSpec;
  /**
   * A question a previous attempt raised, and the answer that came back down the chain.
   *
   * Present only on the attempt that RESUMES a blocked one, and it is the reason that attempt
   * exists at all. Both halves are needed and neither is enough: the answer alone reads as an
   * instruction with no context, and the question alone is what the campaign already refused to
   * act on.
   */
  answeredQuestion?: AnsweredQuestion;
  /**
   * The workstream this engineer owns, when the feature was segmented into more than one.
   *
   * Absent for a campaign that runs one engineer against the whole objective, which is what makes
   * a one-workstream campaign's orders byte-identical to the orders it produced before workstreams
   * existed.
   *
   * `slice` and every sibling's `slice` are OVERSEER-AUTHORED, which is one rank above this
   * engineer and below the human. They are safe to render for the same mechanical reason
   * `AnsweredQuestion.question` is: `validateSegmentation` refuses a newline in either, so a string
   * that reaches here cannot open a `##` section and forge an instruction from the rank above.
   */
  workstream?: WorkstreamBrief;
  /**
   * Both sides of a merge git could not reconcile, for the engineer that exists to reconcile them.
   *
   * ENTIRELY SUPERVISOR-ORIGIN: two branch names this process cut and a file list `git` reported.
   * The overseer decides that a reconciliation is needed and never performs one, because an
   * overseer that resolved a conflict by hand would be an overseer whose work nothing reviews.
   * See `src/contracts/integration.ts`.
   */
  reconciliation?: ReconciliationBrief;
  /**
   * This engineer is fixing the INTEGRATED branch after a `CPT·VALIDATOR` refused it.
   *
   * ENTIRELY SUPERVISOR-ORIGIN: a branch this process cut and the ids of the workstreams that
   * merged onto it. The findings themselves ride in `previousVerdict`, which is the reviewer →
   * reviewee direction the gate exists to permit; nothing here carries any engineer's account of
   * its own work.
   */
  integrationFix?: IntegrationFixBrief;
}

/** The integrated branch, and what merged onto it, for the engineer sent back to fix it. */
export interface IntegrationFixBrief {
  /** Workstream ids whose branches reached the integrated branch, in merge order. */
  workstreams: readonly string[];
}

/** One workstream, as its own engineer and its siblings' engineers are told about it. */
export interface WorkstreamBrief {
  id: string;
  /** This engineer's slice of the objective, in the overseer's words. One line. */
  slice: string;
  /** Repository-relative paths this workstream is EXPECTED to touch. A declaration, not a fence. */
  expectedFiles: readonly string[];
  /** Every other workstream running against this objective, so the seam is visible from both sides. */
  siblings: readonly { id: string; slice: string; expectedFiles: readonly string[] }[];
}

/** A merge conflict, handed to a fresh engineer in its own worktree. */
export interface ReconciliationBrief {
  /** The integration branch, as the supervisor cut it. */
  ours: string;
  /** The workstream branch that would not merge, as the supervisor cut it. */
  theirs: string;
  /** The workstream that produced `theirs`. */
  theirsWorkstream: string;
  /** Repository-relative paths git could not reconcile, as git reported them. */
  files: readonly string[];
}

/**
 * Who settled a question, which is the same thing as how much standing the answer has.
 *
 * NOT DERIVABLE FROM THE ANSWER, and that is why it is carried rather than inferred. A human's
 * answer and an overseer's arrive at this brief as the same shape of string through the same
 * function, and the two mean very different things: one is the authority the objective itself came
 * from, the other is a peer-rank model that read the same repository the engineer is standing in.
 */
export type AnswerSource =
  /** `askHuman`. The authority that approved the objective and the spec. */
  | { from: 'human' }
  /** A `MAJ·OVERSEER`, by agent id, which is the unit that owns this feature and cut it up. */
  | { from: 'overseer'; agentId: string };

/**
 * The two halves of one round of the question ladder, and who supplied the second.
 *
 * `question` is WORKER-AUTHORED, from a previous attempt's `Report.question`. It is single-line by
 * the time it gets here (`validateReport` refuses a newline in it) which is what makes it safe to
 * render into this markdown document: a worker string that cannot carry a `##` heading cannot
 * forge a section from the rank above. That is the same defence `SPEC_ENTRY_MAX_CHARS` is built
 * on, and the reason the cap lives in the contract rather than in a sanitiser here.
 *
 * `answer` from a HUMAN is read off a terminal. It is the one string in this brief that no
 * subordinate can write to, and it is not capped for exactly that reason: the caps in this system
 * bound what a model wrote, and this is the same authority the objective itself came from. It may
 * therefore span lines, so the renderer quotes it line by line, which keeps a pasted heading from
 * opening a section here by accident.
 *
 * `answer` from an OVERSEER is a model's, and is capped, single-line and sanitised before it gets
 * here, the same treatment every other overseer-authored string in this brief gets.
 *
 * `source` is the field this type was missing, and its absence was not cosmetic. Without it every
 * answer rendered as "the question climbed to a human, who answered it" and as "a DECISION TAKEN
 * ABOVE YOU, with the same standing as the spec", including the ones a human never saw. That hands
 * a peer-rank model's judgement the standing of a document a person approved.
 */
export interface AnsweredQuestion {
  question: string;
  answer: string;
  source: AnswerSource;
}

/**
 * The workstream section of an engineer's orders.
 *
 * ## Why the siblings are named
 *
 * An engineer told only its own slice cannot tell the difference between a file nobody is working
 * on and a file another engineer is in the middle of. Both are legal to write and they are not the
 * same event: the first is a declaration that was incomplete, the second is a merge somebody will
 * have to reconcile. Naming the siblings is what lets the worker say which one it just did.
 *
 * ## Why the declaration is not a rule
 *
 * `docs/main-flow.md`: "Segmentation is the plan, not a fence." A fence turns a solvable merge into
 * a blocked workstream, and a worker that believes its file list is a permission boundary will
 * report `blocked` on a one-line change to a neighbour's header. So the section says take it and
 * declare it, in those words, and the campaign announces the overlap either way.
 */
function renderWorkstreamSection(ws: WorkstreamBrief): string[] {
  const lines: string[] = [];
  lines.push(`## YOUR WORKSTREAM: \`${ws.id}\``);
  lines.push('');
  lines.push(
    'This objective was segmented into several workstreams, each with its own engineer, its own ' +
      'worktree and its own branch, all running right now. Yours is:',
  );
  lines.push('');
  lines.push(`> ${ws.slice}`);
  lines.push('');
  lines.push(
    'Build YOUR slice. The objective above is the whole feature and it is here so you can see ' +
      'what your half has to fit into, not so you can build all of it. Work another workstream ' +
      'has been given is work that will be done twice and merged badly.',
  );
  lines.push('');
  if (ws.expectedFiles.length > 0) {
    lines.push('The files this workstream is expected to touch:');
    lines.push('');
    for (const file of ws.expectedFiles) lines.push(`- \`${file}\``);
  } else {
    lines.push(
      'No file list was declared for this workstream, so there is nothing to compare your work ' +
        'against. Say in your report which files you changed.',
    );
  }
  lines.push('');
  if (ws.siblings.length > 0) {
    lines.push('The other workstreams, and what they own:');
    lines.push('');
    for (const sibling of ws.siblings) {
      const files =
        sibling.expectedFiles.length === 0
          ? 'no files declared'
          : sibling.expectedFiles.map((file) => `\`${file}\``).join(', ');
      lines.push(`- \`${sibling.id}\` — ${sibling.slice} (${files})`);
    }
    lines.push('');
  }
  lines.push(
    '**THIS IS A DECLARATION, NOT A FENCE.** If your slice genuinely needs a file another ' +
      'workstream owns, change it. Do not report `blocked` over it and do not build a worse ' +
      'version of the thing next door to avoid touching it. What you must NOT do is change it ' +
      'silently: name the file and the workstream that owns it as a `note` finding, so the ' +
      'overlap is reconciled at integration instead of discovered by a merge conflict.',
  );
  lines.push('');
  lines.push(
    'Your branch is merged onto an integration branch alongside your siblings\' branches. Two ' +
      'engineers editing one file is a merge somebody has to resolve, so keep your changes to it ' +
      'as small as the job allows.',
  );
  lines.push('');
  return lines;
}

/**
 * The reconciliation section: two branches, one conflict, one fresh engineer.
 *
 * Every value in it came from this process. `ours` and `theirs` are branches the supervisor cut,
 * and the file list is what `git` reported when the merge stopped. Nothing here is any engineer's
 * account of its own work, which is the same rule the Inspector's brief is built on: the party
 * whose merge failed does not get to write the instructions for the party fixing it.
 */
function renderReconciliationSection(reconciliation: ReconciliationBrief): string[] {
  const lines: string[] = [];
  assertSupervisorBranch(reconciliation.ours);
  assertSupervisorBranch(reconciliation.theirs);
  lines.push('## THIS IS A RECONCILIATION. YOU ARE NOT BUILDING THE FEATURE.');
  lines.push('');
  lines.push(
    `Two workstreams were built in parallel and git could not merge the second onto the first. ` +
      `Your whole job is to make \`${reconciliation.theirs}\` merge onto ` +
      `\`${reconciliation.ours}\` with both sides' intent intact.`,
  );
  lines.push('');
  lines.push(`- \`${reconciliation.ours}\` is the integration branch. It already holds work that was accepted.`);
  lines.push(
    `- \`${reconciliation.theirs}\` is workstream \`${reconciliation.theirsWorkstream}\`, which was ` +
      'also accepted and has not landed.',
  );
  lines.push('');
  lines.push('git could not reconcile these files:');
  lines.push('');
  for (const file of reconciliation.files) lines.push(`- \`${file}\``);
  lines.push('');
  lines.push(
    'Your tree arrives at detached HEAD like every other, so start from the integration branch ' +
      'rather than from the base commit. The section below tells you which branch to cut; cut it ' +
      `FROM \`${reconciliation.ours}\`, then merge \`${reconciliation.theirs}\` into it and ` +
      'resolve what git could not. A branch that already contains both sides fast-forwards onto ' +
      'the integration branch, which is what makes your work landable.',
  );
  lines.push('');
  lines.push(
    'Read BOTH sides before you write anything. `git log` and `git diff` reach both branches from ' +
      'this worktree. The failure mode here is picking a side: two engineers each wrote something ' +
      'that passed its own gate, so a resolution that deletes one of them is a feature half ' +
      'delivered with nothing to show that it was.',
  );
  lines.push('');
  lines.push(
    'If reconciling them is a design decision rather than a mechanical merge — the two ' +
      'implementations disagree about what the code should do, not about how to write it down — ' +
      'that is a question, not a merge. Report `blocked` with the question. Do not pick.',
  );
  lines.push('');
  return lines;
}

/**
 * The integration-fix section: one engineer, the whole merged feature, a validator's refusal.
 *
 * ## Why this is not a reconciliation and not an ordinary retry
 *
 * A reconciliation exists because git could not merge two branches. This exists because the merge
 * SUCCEEDED and the merged result is not what was asked for — which is a defect no single
 * workstream's branch contains, because each of them passed its own review. So the engineer is
 * pointed at the integrated branch rather than at a slice, and the branch it is standing on already
 * holds every workstream's work.
 *
 * It is deliberately told which workstreams merged. A defect in an integrated feature is usually in
 * the seam between two of them, and an engineer that does not know where the seams are will look
 * for it inside one file.
 */
function renderIntegrationFixSection(fix: IntegrationFixBrief, branch: string): string[] {
  const lines: string[] = [];
  assertSupervisorBranch(branch);
  lines.push('## THIS IS THE INTEGRATED BRANCH, AND A VALIDATOR REFUSED IT');
  lines.push('');
  lines.push(
    `\`${branch}\` already holds every workstream's work, merged. A \`CPT·VALIDATOR\` ran the ` +
      "spec's verification commands against it and judged the result against the ORIGINAL ask, and " +
      'it said no. Its findings are below.',
  );
  lines.push('');
  if (fix.workstreams.length > 0) {
    lines.push('What merged onto it, in the order it landed:');
    lines.push('');
    for (const id of fix.workstreams) lines.push(`- \`${id}\``);
    lines.push('');
    lines.push(
      'Each of those branches passed its own review on its own slice, so the defect is most ' +
        'likely in the SEAM between two of them rather than inside one. Read the merge before you ' +
        'read a file.',
    );
    lines.push('');
  }
  lines.push(
    'You are already on this branch: commit onto it. Do not cut a new one, do not revert a ' +
      "workstream, and do not delete somebody else's work to make a criterion pass — the validator " +
      'is asked whether this is the thing that was asked for, and a feature with a half removed is ' +
      'not.',
  );
  lines.push('');
  return lines;
}

function findingLines(verdict: Verdict): string[] {
  if (verdict.findings.length === 0) return ['- (no itemised findings were recorded)'];
  return verdict.findings.map((finding) => {
    const where =
      finding.file === undefined
        ? ''
        : ` [${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}]`;
    return `- **${finding.severity}**${where} ${finding.message}`;
  });
}

/** The Engineer's `orders.md`. Written to the archive before the process is spawned. */
export function renderEngineerOrders(input: EngineerOrdersInput): string {
  const { orders, branch, worktree, attempt } = input;
  const lines: string[] = [];

  lines.push(`# ORDERS — CPT·ENGINEER · ${orders.taskId}`);
  lines.push('');
  lines.push(`Attempt ${attempt}. Project: \`${orders.project}\`.`);
  lines.push('');
  lines.push('## OBJECTIVE');
  lines.push('');
  lines.push(orders.objective);
  lines.push('');

  // Directly under the objective, because for a segmented feature the slice is what NARROWS the
  // objective, and an engineer that reads the whole objective and then discovers its slice three
  // screens later has already started on somebody else's half.
  if (input.workstream !== undefined) lines.push(...renderWorkstreamSection(input.workstream));
  if (input.reconciliation !== undefined) {
    lines.push(...renderReconciliationSection(input.reconciliation));
  }
  if (input.integrationFix !== undefined) {
    lines.push(...renderIntegrationFixSection(input.integrationFix, branch));
  }

  // THE MOST IMPORTANT CONTENT IN THIS DOCUMENT, so it sits directly under the objective and
  // above every section of housekeeping below it. See `src/contracts/spec.ts`: a trial measured
  // that whether these six questions were answered upstream — not the Engineer's own reasoning
  // budget — was what separated a 1m12s pass from a 9m42s one.
  if (input.spec !== undefined) {
    lines.push(renderTechnicalSpec(input.spec));
    lines.push(
      'These decisions were made ABOVE you, before this attempt began, and a human approved ' +
        'them before you existed. They are not open for you to revisit: do not re-derive them, ' +
        'improve on them, or quietly substitute your own idea of a better one. If you believe ' +
        'one of them is WRONG, say so in your report as a finding — do not act on it silently. ' +
        'An Inspector reviews this branch against the objective either way, so a silent ' +
        'substitution is found regardless, and declaring it costs you nothing.',
    );
    lines.push('');
    // The mechanical half of acceptance. See `src/contracts/spec.ts`'s incident note: a
    // criterion left in prose was never executed by anything. These ARE executed, against your
    // branch, after you report done — running the grantable ones yourself first means you find
    // out about a failure before the gate does, instead of costing a whole retry to learn it.
    if (input.spec.verify !== undefined) {
      lines.push(
        `The \`${SPEC_FIELD_LABEL.verify}\` below are run against your branch mechanically ` +
          'after you report done, and each must exit 0.',
      );
      lines.push('');
      // ONE classifier, shared with `verifyAllowRules` (`./permissions.ts`) — a command
      // containing `)` cannot be carried as an exact Bash allow rule, field-confirmed on a live
      // campaign where every such command was denied. Telling the Engineer this split, rather
      // than letting it discover a rule that can never fire by being refused, is the whole point:
      // a worker that believes a listed command is within its authority will retry the denial
      // instead of reading its way to the fix, which is exactly the fifteen-denial flail this
      // section exists to close.
      const { grantable, ungrantable } = splitVerifyCommands(input.spec.verify);
      if (grantable.length > 0) {
        lines.push('Run them yourself, in this worktree, before you report done:');
        lines.push('');
        for (const command of grantable) lines.push(`- \`${command}\``);
        lines.push('');
        // `verifyAllowRules` turns each approved verify command into an exact Bash allow rule, so
        // the grant is real and this section has to say so — without it, a worker that has just
        // read the loadout section believes bare `node` is off-limits and skips the one check its
        // orders told it to run.
        //
        // What it may NOT do is promise the grant will fire. An exact-match rule matches the
        // command the worker TYPES, and a command that is not valid shell does not survive being
        // typed: measured in the field, a model handed
        // `sh -c 'grep -q \"\\\"dependencies\\\": {}\" package.json'` silently normalised the
        // escaping on its way out, missed the rule, and was denied — then denied again on the
        // literal form, across three attempts and eleven denial signals. The absolute guarantee
        // is what turned that into a retry loop: it contradicted the never-retry-a-denied-command
        // rule four lines below, and the worker believed the guarantee.
        lines.push(
          'These should be within your authority: each was approved by a human with the spec and ' +
            'is on your Bash allow-list as an exact match. Run them exactly as written — a ' +
            'variation (an added flag, a different path) is a different command and will not ' +
            'match. If one is DENIED anyway, that is a defect in the spec, not something for you ' +
            'to work around: do NOT retry it, do NOT re-escape it, and do NOT substitute your own ' +
            'spelling. The acceptance gate runs it for you regardless. Read what it checks, make ' +
            'that true, and record the denial as a finding so the defect is visible.',
        );
        lines.push('');
      }
      if (ungrantable.length > 0) {
        lines.push(
          'These cannot be granted to you — a harness rule-grammar limit on `)` inside a Bash ' +
            'rule means no allow rule for one of these can ever be written, on this or any spec. ' +
            'DO NOT ATTEMPT THEM: a denial is guaranteed, not a risk to weigh. The acceptance ' +
            'gate runs them, mechanically, after you report done — make them pass by reading ' +
            'them and fixing what they check, not by running them yourself:',
        );
        lines.push('');
        for (const command of ungrantable) lines.push(`- \`${command}\``);
        lines.push('');
      }
    }
  } else {
    lines.push('## NO SPEC WAS PROVIDED');
    lines.push('');
    lines.push(
      'This objective was dispatched as free text — none of the questions a spec would have ' +
        'answered for you were asked in advance. You will have to make the design decisions ' +
        'yourself: scope, acceptance, edge cases, the lot. Every decision you make in their ' +
        'place MUST be recorded in your report, one finding each, so the next attempt is not ' +
        'built on an assumption nobody else can see.',
    );
    lines.push('');
  }

  // ABOVE every account of what went wrong, because this is not one. A question that climbed to a
  // human and came back is the most load-bearing thing in this brief: the previous attempt stopped
  // rather than guessed, and this attempt exists to act on the answer. Rendering it under the
  // failure sections would file a decision from above under "what your predecessor got wrong".
  if (input.answeredQuestion !== undefined) {
    const source = input.answeredQuestion.source;
    lines.push('## YOUR PREDECESSOR ASKED A QUESTION, AND IT HAS BEEN ANSWERED');
    lines.push('');
    lines.push(
      source.from === 'human'
        ? 'The previous attempt in this worktree stopped and asked rather than guessing. It was ' +
            'right to. The question climbed to a human, who answered it, and you are that answer ' +
            'being acted on.'
        : 'The previous attempt in this worktree stopped and asked rather than guessing. It was ' +
            `right to. The question climbed to \`${source.agentId}\`, the MAJ·OVERSEER that owns ` +
            'this feature and cut it into workstreams, and it answered rather than passing the ' +
            'question on to a human. You are that answer being acted on.',
    );
    lines.push('');
    lines.push("The question, in your predecessor's own words:");
    lines.push('');
    lines.push(`> ${input.answeredQuestion.question}`);
    lines.push('');
    lines.push(
      source.from === 'human'
        ? 'The answer, from the human who owns this decision:'
        : `The answer, from \`${source.agentId}\`:`,
    );
    lines.push('');
    for (const line of input.answeredQuestion.answer.split('\n')) lines.push(`> ${line}`);
    lines.push('');
    // ---------------------------------------------------------------------------------------
    // TWO STANDINGS, AND THE ENGINEER IS TOLD WHICH ONE IT IS HOLDING.
    //
    // A human's answer comes from the authority that approved the objective and the spec, so it
    // has the spec's standing and is not open to argument. An overseer's is a decision by the unit
    // that owns this feature. That is real authority, and the reason the middle rung exists, but it
    // is not the spec, and the party that made it is another model that read the same repository
    // this engineer is standing in. Telling the engineer otherwise is how a peer's guess acquires a
    // human's authority, and neither of them would ever find out.
    //
    // MAY AN ENGINEER PUSH BACK ON AN OVERSEER'S ANSWER? Yes, and only in one way: by reporting
    // `blocked` again with a NEW question saying what is wrong with the answer, which climbs past
    // the overseer to the human. It may not quietly do something else instead. The cost of a
    // push-back is one question round; the cost of an engineer building on an answer it can see is
    // wrong, because it was told the answer was not to be questioned, is the whole workstream.
    // ---------------------------------------------------------------------------------------
    lines.push(
      source.from === 'human'
        ? 'This is a DECISION TAKEN ABOVE YOU, with the same standing as the spec: act on it, do ' +
            'not re-derive it, and do not ask it again. If it does not settle the block, say what ' +
            'is still missing in a NEW question and report `blocked` again rather than guessing.'
        : 'This is a DECISION BY THE UNIT THAT OWNS THIS FEATURE. It is not the spec and it was ' +
            'not made by a human. Act on it: it outranks your own preference, and re-deriving it ' +
            'or quietly doing something else is not open to you. What IS open to you is ' +
            'DISAGREEING OUT LOUD. If the answer is wrong, or contradicts the spec or the ' +
            'objective above, report `blocked` again with a NEW question saying exactly what is ' +
            'wrong with it. That question climbs past the overseer to the human. Disagreeing ' +
            'costs one question round; building on an answer you can see is wrong costs the ' +
            'workstream.',
    );
    lines.push('');
    lines.push(
      'This is the same worktree your predecessor worked in, so inspect `git status` and `git ' +
        'log` before assuming a clean slate.',
    );
    lines.push('');
  }

  // Same prominence as the gate and verdict sections below, and the same direction of travel:
  // this is the SUPERVISOR's account of what happened to the previous attempt, not the previous
  // Engineer's. One sentence, because that is all the campaign knows — a timed-out process left
  // no findings to itemise, and padding the line out would imply it did.
  if (input.previousFailure !== undefined) {
    lines.push('## YOUR PREVIOUS ATTEMPT DID NOT COMPLETE');
    lines.push('');
    lines.push(input.previousFailure);
    lines.push('');
    lines.push(
      'This is the same worktree that attempt worked in — inspect `git status` and `git log` ' +
        'before assuming a clean slate, and commit or build on whatever is already there.',
    );
    lines.push('');
  }

  if (input.previousVerdict !== undefined) {
    lines.push('## THE INSPECTOR FAILED YOUR PREVIOUS ATTEMPT');
    lines.push('');
    lines.push(input.previousVerdict.summary);
    lines.push('');
    lines.push(...findingLines(input.previousVerdict));
    lines.push('');
    lines.push(
      'Your branch and its commits are still here — this is the same worktree. Fix the findings ' +
        'above and commit again. Do NOT start over, and do NOT narrow the objective to whatever ' +
        'the findings happened to mention: the Inspector is briefed from the OBJECTIVE above, ' +
        'not from your report, so anything you quietly drop will fail again.',
    );
    lines.push('');
  }

  // Same prominence as `previousVerdict`'s findings above, and for the same reason: this is what
  // actually failed the previous attempt, before an Inspector was ever spawned on it. See the
  // incident on `TechnicalSpec.verify` — these are commands, they were RUN, not read, and every
  // one of them must exit 0.
  if (
    input.previousAcceptance !== undefined &&
    input.previousAcceptance.ran &&
    !input.previousAcceptance.passed
  ) {
    lines.push('## THE ACCEPTANCE GATE FAILED YOUR PREVIOUS ATTEMPT');
    lines.push('');
    lines.push(
      "These are the spec's own `verify` commands. They were RUN — mechanically, in your " +
        'worktree, before an Inspector was ever spawned — and at least one did not exit 0:',
    );
    lines.push('');
    lines.push(renderAcceptanceFailure(input.previousAcceptance).trim());
    lines.push('');
    lines.push(
      'Fix these before anything else. An Inspector is not spent on a branch that fails commands ' +
        'the spec itself named as proof of done.',
    );
    lines.push('');
  }

  // The behaviour-coverage incident, on the Engineer's side of the gate: a clause the previous
  // Inspector never gave a verdict entry for is not evidence it was implemented — it is evidence
  // the review skipped it, which this campaign refused to trust silently. Naming the index alone
  // is not an instruction; the text next to it, from `input.spec`, is.
  if (input.previousMissingBehaviours !== undefined && input.previousMissingBehaviours.length > 0) {
    lines.push('## THE PREVIOUS REVIEW DID NOT ACCOUNT FOR EVERY BEHAVIOUR');
    lines.push('');
    lines.push(
      "The Inspector's verdict on your previous attempt left one or more numbered behaviours " +
        'with no entry at all — not `met`, not `not-met`, not even `not-verified`. A clause with ' +
        'no entry looks identical to a clean bill of health, so this campaign refused to trust ' +
        'it and retried instead of delivering. These were never accounted for:',
    );
    lines.push('');
    for (const index of input.previousMissingBehaviours) {
      const text = input.spec?.behaviours[index - 1];
      lines.push(text === undefined ? `${String(index)}. (behaviour ${String(index)})` : `${String(index)}. ${text}`);
    }
    lines.push('');
    lines.push(
      'Make sure each one is genuinely implemented before this attempt reports done — the retry ' +
        'is reviewed against the same numbering.',
    );
    lines.push('');
  }

  // MEASURED on the first live run, and the reason this section exists: haiku ran
  // `git status && cat calc.js`, the `cat` half was outside the allow-list, the whole compound
  // command was denied, and the Engineer reported `blocked` rather than reaching for `Read`. The
  // permission layer did exactly what it should. What was missing was telling the worker
  // what it holds — a loadout it has to discover by being refused costs a turn every time, and
  // sometimes costs the whole attempt.
  lines.push('## YOUR TOOLS — read this before your first Bash call');
  lines.push('');
  lines.push(
    'You have `Read`, `Grep`, `Glob`, `Edit` and `Write`. Use them for everything to do with ' +
      'file contents. `Bash` is restricted to an allow-list: `git`, and the project\'s test, ' +
      'build, lint and typecheck commands. Nothing else.',
  );
  // One exception, and it is granted rather than discovered by refusal: the field failure this
  // sentence closes is an Engineer denied every ad-hoc run of a file its own approved spec named
  // — see `fileRunRules` in `./permissions.ts` for the rule this describes and why it is safe to
  // grant. Present only when the spec actually put a runnable file in scope; a sentence claiming
  // an authority the loadout does not hold is worse than no sentence.
  if (input.spec !== undefined && fileRunRules(input.spec.filesInScope).length > 0) {
    lines.push(
      'One exception: the files named in scope above with a runnable extension may be executed ' +
        'directly — `node <file>`, any arguments — which is granted, unlike arbitrary commands.',
    );
  }
  lines.push('');
  lines.push(
    '- `cat`, `ls`, `sed`, `grep`, `mkdir`, `rm` and friends are NOT available. `Read`, `Glob` ' +
      'and `Grep` do all of it, and `Write` creates files.',
  );
  lines.push(
    '- **A compound command is denied if ANY part of it is outside the allow-list.** ' +
      '`git status && cat calc.js` is refused as a whole, even though `git status` is fine. ' +
      'Run one command per Bash call.',
  );
  lines.push(
    '- A refusal is not a wall to report back about. It means you reached for the wrong tool: ' +
      'use `Read` instead of `cat`, and try again. Reporting `blocked` because Bash refused ' +
      '`cat` wastes the whole attempt.',
  );
  // MEASURED on the second live failure this section carries a scar from: an Engineer whose
  // verify command missed the allow-list retried the same denied command three times and timed
  // out. The bullet above says "try again" and means "with a different TOOL" — a worker under
  // pressure read it as "retry the command", so the distinction is now spelled out.
  lines.push(
    '- A permission denial is a fact about your loadout, not a transient error: the allow-list ' +
      'is fixed for the life of this process, so the SAME command will be denied every time. ' +
      'Never retry a denied command verbatim. If no allowed tool can do what a denied command ' +
      'did, and that blocks an acceptance criterion, stop and report `blocked`, naming the ' +
      'denied command in your summary.',
  );
  lines.push('');
  lines.push('## YOUR WORKING ENVIRONMENT');
  lines.push('');
  lines.push(`- You are in a leased worktree at \`${worktree}\`. Work only inside it.`);
  lines.push(
    `- The tree arrives at DETACHED HEAD. Your first act is \`git checkout -B ${branch}\`. ` +
      'If you skip it, your commits become unreachable the moment the lease is returned.',
  );
  lines.push('- Commit everything you change. An uncommitted file is a destroyed file here.');
  lines.push('- Do not push. Durability and delivery are handled above you.');
  lines.push('');

  // The downward clause. You may field SERGEANT subagents, and they are cheap for exactly one
  // reason: they run at low effort and take your brief on faith. An ambiguity you would have
  // asked a human about, a SERGEANT guesses at or drops — silently, because it has no channel to
  // ask. You owe it the completeness this brief owes you, or it fails the same way a thin brief
  // failed in the trial `UNSPECIFIED_BRIEF_EFFORT` is named for.
  lines.push('## IF YOU FIELD SUBORDINATES');
  lines.push('');
  lines.push(
    'You may field SERGEANT subagents to fan this work out. They run at LOW reasoning effort ' +
      "and are literal: anything your sub-brief leaves ambiguous is guessed at or missed, never " +
      'queried back to you. You owe each subordinate the same completeness this brief owes you ' +
      '— a named file scope, an explicit finish line, the edge cases spelled out, and any ' +
      'design decision already taken. The same six questions apply going down: ' +
      `${(['objective', ...SPEC_LIST_FIELDS] as const).map((field) => SPEC_FIELD_LABEL[field]).join(', ')}.`,
  );
  lines.push('');

  lines.push('## WHEN YOU ARE DONE');
  lines.push('');
  lines.push(
    'Return the schema-constrained report and nothing else. `status: "done"` means committed and ' +
      'ready for inspection; `blocked` means you could not proceed and need a decision; `failed` ' +
      'means you tried and it did not work.',
  );
  lines.push('');
  // The half of `blocked` that was missing until the ladder existed. The schema does NOT require
  // the question (`Report.question` says why: a conditional it cannot express, and a rejected
  // report loses the worker's whole account), so a `blocked` without one is legal and TERMINAL.
  // The brief says what the field buys and what its absence costs, both truthfully, rather than
  // threatening a rejection that does not happen.
  lines.push(
    '- **`blocked` is answered only if it carries a `question`.** That field is what gets you ' +
      'an answer: your question is put in front of a human, and a fresh attempt is started in ' +
      'THIS worktree, briefed with your question and their answer. One line, no newlines. State ' +
      'the decision and the options you can see. A `blocked` report with no question is ' +
      'accepted and is FINAL: nothing climbs, no further attempt starts, and only your ' +
      '`summary` and `findings` survive. So if you are going to stop, ask.',
  );
  lines.push(`- \`branch\` must be \`${branch}\`.`);
  lines.push('- `summary` is one line. `findings` is at most five items.');
  lines.push(
    '- If you could not do what the objective asked and did something else instead, SAY SO in ' +
      '`summary` and record it as a `blocker` finding. An independent Inspector reviews this ' +
      'branch against the original objective, so a substitution will be found either way; ' +
      'declaring it costs you nothing and hiding it costs a whole retry.',
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// THE REVIEW GATE
// ---------------------------------------------------------------------------------------------

/**
 * Facts about an attempt that the SUPERVISOR issued and therefore already knows.
 *
 * Every value here originated above the Engineer: `branch` is what `armyBranch(taskId)` produced
 * before the Engineer existed, `worktree` is what the provider leased, `baseCommit` is what the
 * tree was handed out at. None of it is read back from the reviewee.
 *
 * ## This type used to be a projection of `Report`, and that was the bug
 *
 * It carried one field, `branch`, and it took that field from `report.branch` whenever the
 * Engineer supplied one — with a comment asserting that a branch is "an identifier the supervisor
 * issued in the first place, not a claim about content". The comment was true of the VALUE the
 * supervisor issued and false of the value the code actually used. `Report.branch` is a model-
 * controlled string capped at 512 code points with no `pattern` behind it, so newlines and
 * markdown were legal, and a hostile Engineer could — and in review, did — write a whole
 * `## SUPPLEMENTARY BRIEF FROM THE GENERAL` section into it that reached the Inspector's
 * `orders.md` on disk and the codex prompt argv, instructing the reviewer to ignore the objective
 * and return `pass`.
 *
 * Everything else was correctly excluded. One unclassified field was enough, because the gate is
 * not a filter with a list of bad fields — it is a claim that NOTHING from the reviewee crosses.
 *
 * So the fix is not to sanitise `Report.branch`. It is to never read it. The supervisor cut that
 * branch; it has the value already. See `briefInspectorFromAttempt`, whose signature can no
 * longer receive a `Report` at all.
 */
export interface SupervisorFacts {
  /** `army/<task-id>`, exactly as the supervisor issued it. Never read back from a report. */
  branch: string;
}

/**
 * Keys of `Report` that carry the Engineer's NARRATIVE. None of them may reach the Inspector.
 *
 * `branch` is on this list. It is on it because the classification that matters is not "is this
 * field prose" but "is this field under the reviewee's control", and every property of `Report`
 * is. Exported so the test asserting the property names the same list this module reasons about.
 */
export const ENGINEER_NARRATIVE_KEYS = [
  'status',
  'summary',
  'findings',
  'artifacts',
  'costUsd',
  'branch',
] as const;

/**
 * A git branch name the supervisor is entitled to render into a brief.
 *
 * Deliberately narrow — narrower than git allows — because the only branches this system renders
 * are the ones it cut itself (`army/<task-id>`, where the task id is already a safe segment). The
 * point is not to sanitise; it is that if a future edit ever wires a model-controlled string into
 * this position, the brief THROWS instead of emitting it. The structural exclusion below is the
 * fix; this is the layer that fails loudly if the structure is ever undone.
 */
const SUPERVISOR_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,200}$/;

export function assertSupervisorBranch(branch: string): string {
  if (!SUPERVISOR_BRANCH_RE.test(branch) || branch.includes('..')) {
    throw new Error(
      `refusing to build an Inspector brief around branch ${JSON.stringify(branch.slice(0, 80))}: ` +
        'it is not a plain git ref of the shape this supervisor issues. A branch reaching this ' +
        'point that the supervisor did not cut means something reviewee-controlled has been ' +
        'wired into the brief, which is the one thing the review gate exists to prevent ' +
        '.',
    );
  }
  return branch;
}

/**
 * Everything `renderInspectorBrief` may be told.
 *
 * THERE IS NO FIELD HERE THAT CAN HOLD ANYTHING THE ENGINEER PRODUCED, and that absence is the
 * mechanism. Adding one is not a small edit — it is a change to the review gate, and it should
 * read like one in a diff.
 */
export interface InspectorBrief {
  orders: OriginalOrders;
  facts: SupervisorFacts;
  /** Absolute path of the tree the Inspector may read and run tests in. */
  worktree: string;
  /** Commit the branch was cut from, when known — the diff boundary. */
  baseCommit?: string;
  /** Review round, 1-based. Present so a second review can say so; carries no narrative. */
  round: number;
  /**
   * The commander's spec, when the dispatch carried one.
   *
   * SUPERVISOR-ORIGIN, not the reviewee's — a human approved it before the Engineer existed, so
   * including it does not violate the one rule this file exists to enforce. It strengthens the
   * review: an Inspector that knows the specified edge cases can check them by name instead of
   * guessing at what "the objective" implied.
   */
  spec?: TechnicalSpec;
  /**
   * The slice this branch is, when the feature was cut into several.
   *
   * OVERSEER-AUTHORED and therefore one rank above the reviewee, which is the same standing
   * `EngineerOrdersInput.workstream` rests on: `validateSegmentation` refuses a newline in a slice,
   * and `neutralised` strips the control range at capture, so a slice that reaches here cannot open
   * a `##` section. It is NOT the engineer's account of what it did — the engineer never saw this
   * plan until it was handed one, and could not have written it.
   *
   * Its presence changes what the reviewer is asked. A branch that is one workstream of several is
   * a FRACTION of the feature, so "does it do what the objective asked" is the wrong question to
   * put to it and `renderBehaviourAccounting` is withheld: the numbered behaviours describe the
   * whole feature and are the VALIDATOR's to account for, on the integrated branch.
   */
  workstream?: WorkstreamBrief;
  /**
   * This reviewer holds the scoped test write. Absent means it holds no editor, as before.
   *
   * See `INSPECTOR_TEST_WRITE_RULES` in `./permissions.ts` for the four preconditions and what each
   * is worth on each harness. `permanent` is the repo's own answer, not a preference: a spec that
   * named verification commands, in a repository that has a test directory, gets tests that land on
   * the branch; anything else runs them and lets them go with the worktree.
   */
  testWrite?: InspectorTestWrite;
}

export interface InspectorTestWrite {
  /** Test paths land on the branch (the supervisor commits them) rather than dying with the tree. */
  permanent: boolean;
}

/**
 * The numbered behaviour list and the accounting instructions that ride with it — Inspector-only,
 * and deliberately NOT the bullets `renderTechnicalSpec` already renders under `### Behaviours
 * and edge cases`. The number is the contract: `BehaviourVerdict.behaviour` is a 1-based index
 * into the spec's `behaviours`, so the Inspector has to see the same numbering the verdict is
 * checked against, not a restatement of it — a verdict that quotes a clause back is reviewing its
 * own paraphrase, and a paraphrase is exactly how clause 2 became "descending, no tie-break" in
 * the incident this whole mechanism exists for. See `src/contracts/report.ts`.
 */
function renderBehaviourAccounting(spec: TechnicalSpec): string[] {
  const lines: string[] = [];
  lines.push('## EVERY NUMBERED BEHAVIOUR NEEDS AN ANSWER');
  lines.push('');
  lines.push(
    'Numbered on purpose: `behaviours[].behaviour` in your verdict refers to a clause by this ' +
      'number, not by restating its text. A restated clause is a paraphrase, and a paraphrase is ' +
      'where a clause quietly turns into an easier one.',
  );
  lines.push('');
  spec.behaviours.forEach((entry, i) => lines.push(`${String(i + 1)}. ${entry}`));
  lines.push('');
  lines.push(
    'Return exactly one `behaviours` entry per number above. `not-verified` is the honest answer ' +
      'when you could not check something — it is NOT a failure, and it is strictly better than ' +
      'leaving the clause out: a clause you do not mention is a clause nobody knows was skipped, ' +
      'which looks identical to a clean bill of health and is the exact failure this field exists ' +
      'to make impossible.',
  );
  lines.push('');
  lines.push(
    '**THE TRAP THIS EXISTS FOR:** the Engineer wrote the tests as well as the code, so a green ' +
      'suite is not evidence a clause was implemented — its suite can only be blind in exactly ' +
      'the place its own code is blind. A behaviour with no test near it is precisely where to ' +
      'look, and the way to check one is to exercise it directly, not to re-run a suite that may ' +
      'never have touched it.',
  );
  lines.push('');
  if (spec.verify !== undefined) {
    lines.push(
      `The \`${SPEC_FIELD_LABEL.verify}\` were already run mechanically before this branch was ` +
        'fielded to you, and passed — you do not need to re-run them. Spend your time on the ' +
        'behaviours a shell command cannot check.',
    );
    lines.push('');
  }
  return lines;
}

/**
 * The slice a per-workstream review is about, and the three questions it changes.
 *
 * A reviewer handed one workstream's branch and the whole objective will fail it for the half it
 * was never asked to build. That is not a hypothetical failure mode: it is the arithmetic of
 * segmentation. So the slice is named, the siblings are named, and the reviewer is told in as many
 * words which questions are NOT its to answer — because a reviewer told only "review this" answers
 * every question it can think of, and the expensive ones here are the wrong ones.
 */
function renderReviewedSliceSection(ws: WorkstreamBrief): string[] {
  const lines: string[] = [];
  lines.push(`## THIS BRANCH IS ONE WORKSTREAM: \`${ws.id}\``);
  lines.push('');
  lines.push(
    'The objective above is the WHOLE feature. This branch is one slice of it, built by one ' +
      'engineer in its own worktree while its siblings were being built in theirs. The slice is:',
  );
  lines.push('');
  lines.push(`> ${ws.slice}`);
  lines.push('');
  if (ws.expectedFiles.length > 0) {
    lines.push('The files this workstream declared it would touch:');
    lines.push('');
    for (const file of ws.expectedFiles) lines.push(`- \`${file}\``);
    lines.push('');
    lines.push(
      'A DECLARATION, NOT A FENCE — a file outside it is legal and was announced separately. Read ' +
        'it as where to look first, never as a list of what you are allowed to have an opinion ' +
        'about.',
    );
    lines.push('');
  }
  if (ws.siblings.length > 0) {
    lines.push('The other workstreams, which are NOT on this branch:');
    lines.push('');
    for (const sibling of ws.siblings) {
      const files =
        sibling.expectedFiles.length === 0
          ? 'no files declared'
          : sibling.expectedFiles.map((file) => `\`${file}\``).join(', ');
      lines.push(`- \`${sibling.id}\` — ${sibling.slice} (${files})`);
    }
    lines.push('');
  }
  lines.push(
    '**DO NOT FAIL THIS BRANCH FOR NOT BEING THE WHOLE FEATURE.** Work listed above as another ' +
      "workstream's is missing here on purpose, and every branch merges onto one integration " +
      'branch afterwards, where a `CPT·VALIDATOR` runs the verification commands and judges the ' +
      'assembled result against the original ask. That question is asked, once, and it is not ' +
      'yours. Yours is whether THIS slice does what it was cut to do, correctly, and whether the ' +
      'seam it leaves for its siblings is one they can meet.',
  );
  lines.push('');
  return lines;
}

/**
 * The reviewer's editor: what it is for, where it reaches, and what happens to what it writes.
 *
 * ## Why a reviewer is told the bound rather than only given it
 *
 * On claude the scope is enforced and this section is a courtesy. On codex — which is where this
 * reviewer usually runs — the whole worktree is writable and no rule reaches inside it, so this
 * paragraph IS the bound as far as the harness is concerned. That is not left implicit: the section
 * says the supervisor reads back what was written and throws the verdict away if it strayed, which
 * is a mechanism rather than an appeal, and it is the same on both harnesses.
 */
function renderTestWriteSection(write: InspectorTestWrite): string[] {
  const lines: string[] = [];
  lines.push('## YOU MAY WRITE TESTS, AND ONLY TESTS');
  lines.push('');
  lines.push(
    'A test you write is worth more than a finding you describe, because it is the same claim in a ' +
      'form the next process can execute. So: write the test that exercises what you doubt, run ' +
      'it, and report what it did.',
  );
  lines.push('');
  lines.push(
    'Your editor reaches TEST PATHS ONLY — `test/`, `tests/`, `spec/`, `__tests__/`, and files ' +
      'named `*.test.*`, `*.spec.*`, `*_test.*` or `test_*.py` anywhere. Nothing else. Not the ' +
      'implementation, not a config file, not a fixture outside those paths.',
  );
  lines.push('');
  lines.push(
    '**THIS IS CHECKED AFTER YOU EXIT, MECHANICALLY, AND IT IS NOT A FORMALITY.** The supervisor ' +
      'reads every file changed in this worktree and compares it against that list. One ' +
      'non-test file and your verdict is DISCARDED — not downgraded, discarded — and the branch ' +
      'is treated as unreviewed. The reason is the obvious one: a reviewer that can edit the code ' +
      'can make its own verdict pass, and the only version of this grant that is worth having is ' +
      'one where that is impossible to get away with rather than merely discouraged.',
  );
  lines.push('');
  lines.push(
    write.permanent
      ? 'Tests you write here are HELD, not committed here. Nothing is committed in this tree. ' +
        'After you exit, the supervisor lifts the test files out of this worktree, puts the tree ' +
        'back as if you had written nothing, and applies them to the integrated branch, where the ' +
        'acceptance gate and a `CPT·VALIDATOR` run them in a process you do not own. They become ' +
        'history on that branch only after the validator returns a verdict; if none ever does, they ' +
        'are withdrawn. Write them to be read by someone who was not here.'
      : 'Tests you write here are TEMPORARY: this repository named no verification commands or has ' +
        'no test directory, so nothing will commit them and they go with the worktree. Write them ' +
        'anyway — running one is how you find out — and put what they proved in your findings, ' +
        'because the finding is the part that survives.',
  );
  lines.push('');
  lines.push(
    'A test that cannot fail proves nothing. Break the thing it guards, watch it go red, restore ' +
      'it. And `testsRun` still means the SUITE ran to completion under your own hand — a test you ' +
      'wrote and ran is not the suite.',
  );
  lines.push('');
  return lines;
}

/**
 * The Inspector's `orders.md`.
 *
 * Reads the original objective back verbatim and names the branch. It also tells the Inspector,
 * in as many words, that the Engineer's account has been withheld and why — because an Inspector
 * that does not know it is missing a summary will assume the summary was unremarkable, whereas
 * one that knows it was withheld on purpose will go and read the diff.
 */
export function renderInspectorBrief(brief: InspectorBrief): string {
  const { orders, facts, worktree, round } = brief;
  // Second layer, cheap: if the structural exclusion above is ever undone, this throws rather
  // than rendering a reviewee-controlled string into the reviewer's orders.
  assertSupervisorBranch(facts.branch);
  const lines: string[] = [];

  lines.push(`# ORDERS — CPT·INSPECTOR · ${orders.taskId}`);
  lines.push('');
  lines.push(`Review round ${round}. Project: \`${orders.project}\`.`);
  lines.push('');
  lines.push('## THE ORIGINAL OBJECTIVE');
  lines.push('');
  lines.push('This is what was ASKED FOR, verbatim, before any work was done:');
  lines.push('');
  lines.push(orders.objective);
  lines.push('');

  // Directly under the objective for the same reason the Engineer's slice is: the objective is the
  // whole feature and this branch is not, and a reviewer that reads one and then discovers the
  // other three screens later has already started failing a branch for not being the feature.
  if (brief.workstream !== undefined) {
    lines.push(...renderReviewedSliceSection(brief.workstream));
  }

  if (brief.spec !== undefined) {
    // Supervisor-owned and human-approved before the Engineer existed — never the reviewee's
    // narrative. See `InspectorBrief.spec`.
    lines.push(renderTechnicalSpec(brief.spec, '## THE SPEC THE WORK WAS ASKED AGAINST'));
    lines.push('');
    // WITHHELD FROM A SLICE REVIEW. `BehaviourVerdict.behaviour` indexes the WHOLE feature's
    // numbered behaviours, and a branch holding one workstream of several cannot answer most of
    // them — asking anyway would produce either a verdict full of `not-verified` or, worse, a
    // reviewer guessing. The VALIDATOR accounts for them, once, on the integrated branch, and
    // `behaviourCoverage` is applied there and only there.
    if (brief.workstream === undefined) lines.push(...renderBehaviourAccounting(brief.spec));
  }

  if (brief.testWrite !== undefined) lines.push(...renderTestWriteSection(brief.testWrite));

  lines.push('## WHAT YOU HAVE BEEN GIVEN, AND WHAT YOU HAVE NOT');
  lines.push('');
  lines.push(`- Branch: \`${facts.branch}\` in the worktree at \`${worktree}\`.`);
  if (brief.baseCommit !== undefined) {
    lines.push(`- The branch was cut from \`${brief.baseCommit}\`; diff against it.`);
  }
  lines.push(
    "- You have NOT been given the Engineer's report, summary, or findings. That is deliberate " +
      'and it is not an oversight. A reviewer briefed by the party under review only ever learns ' +
      'what that party chose to tell it, and ends up reviewing against a goalpost the reviewee ' +
      'moved.',
  );
  lines.push('');
  lines.push('## WHAT YOU ARE LOOKING FOR');
  lines.push('');
  lines.push(
    'The failure this gate exists to catch is **"I could not do X, so I did Y instead"**. Read ' +
      'the objective above, read the diff, and answer the question the objective actually asked ' +
      '— not the question the code appears to answer.',
  );
  lines.push('');
  lines.push('Specifically:');
  lines.push('1. Does the change do what the OBJECTIVE asked? Name anything it substituted.');
  lines.push(
    '2. Run the test suite. **A suite that did not finish did not run.** If any test errored ' +
      'for an environmental reason rather than a code reason — a sandbox denial, `EPERM`, a ' +
      'missing binary, no network, a port it could not bind — then you have not run the suite, ' +
      'however many other tests passed. Set `testsRun: false`, and name the specific failure and ' +
      'which criteria it left unverified in your summary.',
  );
  lines.push(
    '3. Can the new tests fail? Break the thing they guard, watch them go red, restore it. A ' +
      'test that cannot fail is worse than no test, because everything downstream inherits a ' +
      'false assurance. You have a disposable copy of the tree; use it and leave it dirty if ' +
      'you must, it is thrown away.',
  );
  lines.push('4. Is anything committed that should not be — secrets, generated files, debris?');
  lines.push('');
  lines.push('## YOUR VERDICT');
  lines.push('');
  lines.push(
    'Return the schema-constrained verdict and nothing else. `fail` if any finding is a ' +
      '`blocker`; `pass` otherwise. `testsRun` must be honest — `pass` with `testsRun: false` is ' +
      'a legitimate and distinguishable state, and claiming otherwise is the one thing you can ' +
      'do here that is worse than a wrong verdict.',
  );
  lines.push('');
  lines.push(
    '`testsRun: true` is a claim that the suite RAN TO COMPLETION under your own hand. It is ' +
      'not a claim that you tried, and "attempted, mostly passed, some errored on the ' +
      'environment" is `false`. This has been got wrong in the field: three reviewers in a row ' +
      'returned `testsRun: true` for a suite in which every socket-bound test died on `EPERM` ' +
      'before asserting anything, so the objective\'s headline criterion went unverified by ' +
      'anyone while the report said tests had run. Reporting `false` costs you nothing and costs ' +
      'the campaign one honest line; reporting `true` wrongly spends someone\'s trust on a ' +
      'measurement that does not exist.',
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Everything `briefInspectorFromAttempt` accepts — and, by construction, everything it CAN accept.
 *
 * The `?: never` fields are not decoration and they are not a lint. They are the encoded
 * principle: TypeScript's excess-property check catches an object literal that names an extra
 * field, but says nothing about a variable widened into the parameter, which is exactly how a
 * `Report` would get here in real code. Declaring the plausible names as `never` makes every one
 * of those spellings a compile error rather than a review question.
 *
 * The list is the names somebody would reach for while trying to be helpful. It is not a
 * blacklist of unsafe values — there is no safe value, because every property of `Report` is
 * written by the party under review.
 */
export interface InspectorBriefInput {
  /** The Commander's own words, held verbatim since the command line. */
  orders: OriginalOrders;
  /** `army/<task-id>` as the SUPERVISOR cut it. Never `report.branch`. */
  branch: string;
  /** The leased tree, from the worktree provider. */
  worktree: string;
  /** What the tree was handed out at, from `git rev-parse HEAD` before the Engineer ran. */
  baseCommit?: string;
  round: number;
  /**
   * The commander's spec, when the dispatch carried one. Take it from the SUPERVISOR's own copy
   * — `CampaignOptions.spec` — never from a `Report`. See `InspectorBrief.spec`: this is the one
   * field on this input that IS allowed to carry structured content, because it does not
   * originate from the party under review.
   */
  spec?: TechnicalSpec;
  /**
   * The slice this branch is, from the OVERSEER's segmentation — one rank above the reviewee, and
   * written before the reviewee existed. See `InspectorBrief.workstream`.
   */
  workstream?: WorkstreamBrief;
  /** Grant this reviewer the scoped test write. See `InspectorBrief.testWrite`. */
  testWrite?: InspectorTestWrite;

  // ---- structurally unreachable, on purpose -------------------------------------------------
  /** @deprecated Never. The Inspector is briefed from the original orders. */
  engineerReport?: never;
  /** @deprecated Never. */
  report?: never;
  /** @deprecated Never. */
  summary?: never;
  /** @deprecated Never. */
  findings?: never;
  /** @deprecated Never. */
  artifacts?: never;
  /** @deprecated Never. */
  status?: never;
}

/**
 * The orchestrator's entry point: original orders + supervisor-owned facts → the Inspector's brief.
 *
 * ## THIS FUNCTION CANNOT BE HANDED A `Report`
 *
 * That is the whole design. The previous version took one, promising to project it down to a
 * single safe field — and the projection turned out to have a hole, because `Report.branch` is
 * model-controlled free text and nobody had classified it as such. A filter with one unclassified
 * field is not a gate.
 *
 * Every argument below originated ABOVE the Engineer. There is no parameter through which a
 * future edit can pass the reviewee's output without first changing this signature, and changing
 * this signature reads like what it is.
 *
 * The supervisor still has `report.branch` and should still LOOK at it — a report naming a branch
 * other than the one it was told to cut is a real signal — but that comparison belongs in the
 * campaign's own notes, where the Inspector never sees it. See `campaign.ts`.
 */
export function briefInspectorFromAttempt(input: InspectorBriefInput): string {
  const brief: InspectorBrief = {
    orders: input.orders,
    facts: { branch: assertSupervisorBranch(input.branch) },
    worktree: input.worktree,
    round: input.round,
  };
  if (input.baseCommit !== undefined) brief.baseCommit = input.baseCommit;
  if (input.spec !== undefined) brief.spec = input.spec;
  if (input.workstream !== undefined) brief.workstream = input.workstream;
  if (input.testWrite !== undefined) brief.testWrite = input.testWrite;
  return renderInspectorBrief(brief);
}

// ---------------------------------------------------------------------------------------------
// THE VALIDATOR — the last question, and it is not the gate's question
// ---------------------------------------------------------------------------------------------

/**
 * Everything a `CPT·VALIDATOR` may be told, and — the same discipline `InspectorBrief` is under —
 * nothing that can hold a worker's account of its own work.
 *
 * There is no `report`, no `verdict`, no `findings`. What IS here beyond the Inspector's inputs is
 * `acceptance`: the mechanical output of commands the SPEC named and THIS process ran, which is
 * evidence rather than testimony. It is the one field that carries bytes a worker influenced, and
 * it does so the same way `EngineerOrdersInput.previousAcceptance` already does — through
 * `renderAcceptanceFailure`, which caps it.
 */
export interface ValidatorBrief {
  orders: OriginalOrders;
  facts: SupervisorFacts;
  /** The integration tree, where the commands are run. */
  worktree: string;
  /** The commit the integration branch was cut from — the diff boundary for the whole feature. */
  baseCommit?: string;
  /** 1-based validation round. A second round means a first one refused this branch. */
  round: number;
  spec?: TechnicalSpec;
  /** Workstream ids that merged onto this branch, in merge order. Supervisor-owned. */
  workstreams: readonly string[];
  /**
   * What the acceptance gate did on THIS branch, before this validator was spawned.
   *
   * `null` when no gate was ever a candidate — a spec with no `verify` commands, or no spec. That
   * is a reportable state and the brief says so, because a validator that assumes silence means
   * "passed" is the failure `src/verify/gate.ts` exists to prevent, one layer up.
   */
  acceptance: AcceptanceResult | null;
  /**
   * Test files a `CPT·INSPECTOR` wrote while reviewing a workstream, which the supervisor lifted
   * out of that tree and applied, UNCOMMITTED, to the tree this validator stands in.
   *
   * Precondition 4 on `INSPECTOR_TEST_WRITE_RULES`, made an instruction rather than a hope: a test
   * written by a reviewer has been run by exactly one process, and that process was the reviewer's
   * own. Naming the files is what turns "they get re-run eventually" into "run these". They are
   * not on any branch yet: `commitInspectorTests` runs after this validator returns a verdict, and
   * only then.
   */
  inspectorTests: readonly string[];
}

/**
 * The `CPT·VALIDATOR`'s `orders.md`.
 *
 * ## Two questions get asked at the end and they are not the same one
 *
 * The acceptance gate answers *do the commands pass*. This unit answers *is this the thing that was
 * asked for*. A gate cannot notice a feature that was renamed, a criterion that was satisfied by
 * deleting the thing it measured, or a spec clause nobody implemented and nobody wrote a command
 * for — it can only notice a non-zero exit. So the gate's output is handed over as EVIDENCE, and
 * the question put on top of it is the one no exit code answers.
 *
 * The distinction is also why the gate runs FIRST and its result is in the brief rather than being
 * left for this unit to discover: a validator that has to run the commands to find out whether they
 * pass spends its budget on a fact the supervisor already had, and a validator that is told they
 * passed and stops there has answered the gate's question twice and its own not at all.
 */
export function renderValidatorBrief(brief: ValidatorBrief): string {
  const { orders, facts, worktree, round } = brief;
  assertSupervisorBranch(facts.branch);
  const lines: string[] = [];

  lines.push(`# ORDERS — CPT·VALIDATOR · ${orders.taskId}`);
  lines.push('');
  lines.push(`Validation round ${round}. Project: \`${orders.project}\`.`);
  lines.push('');
  lines.push('## THE ORIGINAL OBJECTIVE');
  lines.push('');
  lines.push('This is what was ASKED FOR, verbatim, before any work was done:');
  lines.push('');
  lines.push(orders.objective);
  lines.push('');

  lines.push('## YOU ARE NOT AN INSPECTOR, AND THIS IS NOT A DIFF REVIEW');
  lines.push('');
  lines.push(
    'Every branch that merged here was already reviewed on its own slice by its own ' +
      '`CPT·INSPECTOR`. Re-reading those diffs line by line spends your budget on work that is ' +
      'done. You are the last unit to look at this, and the question you are here for is the one ' +
      'nobody below you was in a position to ask:',
  );
  lines.push('');
  lines.push('> **Is this the thing that was asked for?**');
  lines.push('');
  lines.push(
    'The failure that reaches you is the one that survives every earlier gate: each slice was ' +
      'correct, the commands exit 0, and the assembled feature is still not what the objective ' +
      'described — a seam nobody owned, a criterion satisfied by removing what it measured, a ' +
      'clause every workstream assumed belonged to a sibling.',
  );
  lines.push('');
  if (brief.workstreams.length > 0) {
    lines.push('What merged onto this branch, in the order it landed:');
    lines.push('');
    for (const id of brief.workstreams) lines.push(`- \`${id}\``);
    lines.push('');
  }

  if (brief.spec !== undefined) {
    lines.push(renderTechnicalSpec(brief.spec, '## THE SPEC THIS WAS ASKED AGAINST'));
    lines.push('');
    lines.push(...renderBehaviourAccounting(brief.spec));
  }

  lines.push('## THE MECHANICAL EVIDENCE');
  lines.push('');
  if (brief.acceptance === null || !brief.acceptance.ran) {
    lines.push(
      'The acceptance gate did NOT run on this branch: the spec named no verification commands. ' +
        'That is an absence, not a pass. Nothing has mechanically checked this work, so every ' +
        'claim about it is yours to establish by running something yourself.',
    );
    lines.push('');
  } else if (brief.acceptance.passed) {
    lines.push(
      "The spec's verification commands were run against this exact branch by the supervisor, " +
        'before you were spawned, and every one of them exited 0:',
    );
    lines.push('');
    for (const outcome of brief.acceptance.outcomes) lines.push(`- \`${outcome.command}\``);
    lines.push('');
    lines.push(
      '**A PASSING GATE IS NOT A PASSING VERDICT.** Those commands are what somebody thought to ' +
        'write down; the objective is what was wanted. Re-run them if you want to see it for ' +
        'yourself — they are on your allow-list — but the reason you are here is everything they ' +
        'do not cover.',
    );
    lines.push('');
  } else {
    lines.push(renderAcceptanceFailure(brief.acceptance));
    lines.push('');
    lines.push(
      'The gate already refuses this branch. Say so plainly and name what is actually wrong ' +
        'rather than re-deriving the exit code.',
    );
    lines.push('');
  }

  if (brief.inspectorTests.length > 0) {
    lines.push('## TESTS A REVIEWER WROTE, WHICH NOTHING BUT THE REVIEWER HAS RUN');
    lines.push('');
    lines.push(
      'A `CPT·INSPECTOR` wrote these while reviewing a workstream. The supervisor applied them ' +
        'to this tree; they are NOT committed, and whether they ever are is decided by whether you ' +
        'return a verdict. The process that wrote them is the only process that has ever executed ' +
        'them, which is exactly one process too few:',
    );
    lines.push('');
    for (const file of brief.inspectorTests) lines.push(`- \`${file}\``);
    lines.push('');
    lines.push(
      'RUN THEM. If one fails, that is a finding about the work. If one cannot fail — it asserts ' +
        'nothing, or asserts something that is true by construction — that is a finding about the ' +
        'review, and it is worth saying out loud, because a test that cannot fail is how a ' +
        'reviewer makes its own verdict pass.',
    );
    lines.push('');
  }

  lines.push('## WHAT YOU HAVE BEEN GIVEN, AND WHAT YOU HAVE NOT');
  lines.push('');
  lines.push(`- Branch: \`${facts.branch}\` in the worktree at \`${worktree}\`.`);
  if (brief.baseCommit !== undefined) {
    lines.push(`- The branch was cut from \`${brief.baseCommit}\`; diff against it for the whole feature.`);
  }
  lines.push(
    "- You have NOT been given any engineer's report, any inspector's verdict, or any summary of " +
      'what was done. That is deliberate. Every one of them was written by a party with an ' +
      'interest in this branch being accepted, and you are the unit that exists because those ' +
      'parties all said yes.',
  );
  lines.push('- You hold no editor. You do not fix what you find; you report it.');
  lines.push('');

  lines.push('## YOUR VERDICT');
  lines.push('');
  lines.push(
    'Return the schema-constrained verdict and nothing else. `fail` if any finding is a ' +
      '`blocker`; `pass` otherwise. A `fail` sends this back for another engineer under whatever ' +
      'is left of the campaign budget, so a `blocker` should be something that makes this NOT the ' +
      'thing that was asked for — not a preference about how it was written.',
  );
  lines.push('');
  lines.push(
    '`testsRun` must be honest, and it means the suite ran to completion under your own hand. A ' +
      'suite that did not finish did not run: a sandbox denial, `EPERM`, a missing binary, a port ' +
      'it could not bind — any of those and you have not run it, however many tests passed before ' +
      'it. Set `testsRun: false` and name what stopped you. `pass` with `testsRun: false` is a ' +
      'legitimate and distinguishable state; claiming otherwise spends someone\'s trust on a ' +
      'measurement that does not exist.',
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Everything `briefValidator` accepts, with the same `?: never` fields the Inspector's input has
 * and for the same reason: the plausible spellings of "let me just pass the report through" are
 * compile errors rather than review questions.
 */
export interface ValidatorBriefInput {
  orders: OriginalOrders;
  /** The integration branch, as the SUPERVISOR cut it. */
  branch: string;
  worktree: string;
  baseCommit?: string;
  round: number;
  spec?: TechnicalSpec;
  workstreams: readonly string[];
  acceptance: AcceptanceResult | null;
  inspectorTests: readonly string[];

  // ---- structurally unreachable, on purpose -------------------------------------------------
  /** @deprecated Never. A validator judges the branch, not an account of it. */
  report?: never;
  /** @deprecated Never. */
  verdict?: never;
  /** @deprecated Never. */
  summary?: never;
  /** @deprecated Never. */
  findings?: never;
}

export function briefValidator(input: ValidatorBriefInput): string {
  const brief: ValidatorBrief = {
    orders: input.orders,
    facts: { branch: assertSupervisorBranch(input.branch) },
    worktree: input.worktree,
    round: input.round,
    workstreams: input.workstreams,
    acceptance: input.acceptance,
    inspectorTests: input.inspectorTests,
  };
  if (input.baseCommit !== undefined) brief.baseCommit = input.baseCommit;
  if (input.spec !== undefined) brief.spec = input.spec;
  return renderValidatorBrief(brief);
}

// ---------------------------------------------------------------------------------------------
// THE CPT·SCOUT — the one unit that goes and finds out
// ---------------------------------------------------------------------------------------------

export interface ScoutBriefInput {
  /** The one-line question, exactly as a human approved it. */
  question: string;
  /** Absolute path of the primary checkout. A scout reads it; it holds no worktree of its own. */
  project: string;
  /** The archive id, so a note or a signal can be traced back to the conversation. */
  campaignId: string;
  /** `SCOUT_MAX_SUBAGENTS`. Stated, and separately measured — see `watchFanOut`. */
  maxSubagents: number;
  /** `SCOUT_TIMEOUT_MS`, in milliseconds. Rendered as minutes. */
  timeoutMs: number;
  /**
   * What the human and the Commander have settled so far, when there is any.
   *
   * SUPERVISOR-HELD: it is the objective a human typed, never a subordinate's account of
   * anything. Absent for a recce asked before the interrogation has produced a line, which is the
   * common case — a scout is usually sent BECAUSE nothing is settled yet.
   */
  context?: string;
}

/**
 * The `CPT·SCOUT`'s `orders.md`.
 *
 * ## What this brief is careful about
 *
 * A scout holds `Read`, `Grep`, `Glob`, `WebFetch` and `WebSearch`, NO EDITOR, NO SHELL and NO
 * WORKTREE. The last of those is the one worth stating, because every other unit this system
 * fields that touches a repository works in a leased tree, and a scout reading the primary
 * checkout would otherwise spend part of its window working out why `git status` is not available
 * and whether it is supposed to branch. It is not. It reads what is there and reports.
 *
 * The other thing it is careful about is the cost of a subordinate. Each one runs inside this
 * process at this process's effort and is billed to the same subscription, so the ceiling is
 * stated as arithmetic rather than as a preference — and the brief says out loud that the number
 * is enforced by measurement, because a ceiling a model believes is advisory is a ceiling.
 */
export function renderScoutBrief(input: ScoutBriefInput): string {
  const minutes = Math.round(input.timeoutMs / 60_000);
  const lines: string[] = [];
  lines.push(`# ORDERS — CPT·SCOUT · ${input.campaignId}`);
  lines.push('');
  lines.push(
    'You were sent to find something out, before anyone has been asked to build anything. ' +
      `Project: \`${input.project}\`.`,
  );
  lines.push('');
  lines.push('## THE QUESTION');
  lines.push('');
  // QUOTED, and that is not decoration. `SCOUT_QUESTION_MAX_CHARS` says a single line cannot open
  // a section, and pushing the question as its own line in a markdown document made that false:
  // a question beginning `## ` opened one, which is a forged instruction from the rank above in a
  // document whose whole authority is that this process wrote it. A blockquote marker cannot be
  // the first character of a heading, so `> ## do X` is a quoted line and nothing else, and the
  // defence no longer depends on the one-line rule meaning something it never meant.
  lines.push(`> ${input.question}`);
  lines.push('');

  if (input.context !== undefined && input.context.trim() !== '') {
    lines.push('## WHAT IS ALREADY SETTLED');
    lines.push('');
    lines.push(input.context.trim());
    lines.push('');
    lines.push(
      'That came from the human at the terminal. Do not re-open it and do not answer a different ' +
        'question because you found a more interesting one.',
    );
    lines.push('');
  }

  lines.push('## WHAT YOU HOLD, AND WHAT YOU DO NOT');
  lines.push('');
  lines.push('- `Read`, `Grep`, `Glob`, `WebFetch` and `WebSearch`. Read as widely as you need to.');
  lines.push(
    '- **No editor and no shell.** You change nothing, anywhere. This is what you were spawned ' +
      'with rather than a rule you are being asked to respect: reaching for one returns a denial.',
  );
  lines.push(
    '- **No worktree.** Every unit in this system that writes gets a leased checkout of its own; ' +
      'you are not one, so you have none. The path above is the primary checkout, read-only to ' +
      'you. Nothing you do needs a branch and nothing you find should be written down anywhere ' +
      'but in your return.',
  );
  lines.push(
    '- You do not spawn a process. You may field subordinates INSIDE this one — see below — and ' +
      'that is the whole of your fan-out.',
  );
  lines.push('');

  lines.push('## FANNING OUT, AND WHAT IT COSTS');
  lines.push('');
  lines.push(
    `You may field at most **${String(input.maxSubagents)}** subordinates, and they may field ` +
      'none of their own. Each runs inside this process, at this process\'s reasoning effort, ' +
      'billed to the same subscription — so the ceiling at maximum is ' +
      `${String(input.maxSubagents + 1)} model sessions spent before a single line of code has ` +
      'been written.',
  );
  lines.push('');
  lines.push(
    '**Both halves of that are enforced rather than requested.** The nesting depth is capped by ' +
      'the harness, which removes the spawn tool from a subordinate rather than refusing its ' +
      'call. The count is measured by the supervising process off your own event stream, and ' +
      'crossing it stops you mid-answer and reports what you had reached by then. Neither number ' +
      'is a suggestion and neither can be negotiated in this window.',
  );
  lines.push('');
  lines.push(
    'So fan out when the question genuinely splits into parts that can be investigated ' +
      'independently, and not to look thorough. **Nobody is a correct answer** for a question one ' +
      'reader can settle.',
  );
  lines.push('');
  lines.push(`You have about ${String(minutes)} minutes of wall clock. Spend them reading.`);
  lines.push('');

  lines.push('## WHAT TO RETURN');
  lines.push('');
  lines.push(
    'A single JSON object matching the schema you were given: a one-line `summary`, a `findings` ' +
      'list, and an `unknowns` list.',
  );
  lines.push('');
  lines.push(
    '`unknowns` is REQUIRED and it is the field this whole errand turns on. You were sent because ' +
      'nobody knew the answer. A report with no stated gaps is either a question that did not ' +
      'need asking or a gap you filled in yourself — and a gap filled in silently is exactly the ' +
      'failure the interrogation above you exists to prevent. Name what you could not settle. If ' +
      'you genuinely settled everything, say so in one entry.',
  );
  lines.push('');
  lines.push(
    'Every entry is ONE LINE. Your return is rendered into a markdown briefing for the unit that ' +
      'plans the work, so an entry carrying a newline could open a section and forge an ' +
      'instruction from the rank above; it is refused rather than repaired.',
  );
  lines.push('');
  lines.push(
    'Cite. A finding with a file and a line, or a URL, is something the next reader can check. A ' +
      'finding without one is a claim they have to take on trust from a unit that is about to ' +
      'stop existing.',
  );
  lines.push('');
  lines.push(
    'Dense, not long. Your commander cannot read a file — that is the whole reason you were sent ' +
      '— and every line you write costs it the context it needs to act on the rest.',
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// THE MAJ·OVERSEER — the two things it is ever asked
// ---------------------------------------------------------------------------------------------

/**
 * What the overseer is told before it segments a feature.
 *
 * Everything here originated above it: the objective as the human typed it, the spec the human
 * approved, and what a scout found. There is no field that can carry an engineer's account of
 * anything, and there is nothing for one to carry yet, because segmentation happens before a
 * single engineer exists.
 */
export interface SegmentationBriefInput {
  orders: OriginalOrders;
  spec?: TechnicalSpec;
  /**
   * A scout's written findings, when the campaign ran one.
   *
   * SUPERVISOR-HELD but MODEL-AUTHORED, which is the one thing in this brief that is both. A
   * scout is a CAPTAIN and the overseer is a MAJOR, so this is a subordinate's report climbing,
   * which is the direction that is always allowed.
   *
   * Filled by `army chat`, from a `CPT·SCOUT` a human confirmed before the interrogation — see
   * `runRecce` in `src/command/scout.ts`. Every string here has been through `sanitize` at
   * capture, which is what makes it safe to render into a document whose `##` headings carry
   * supervisor authority. `army campaign` still fills it with nothing, because a campaign takes
   * an objective off a command line and has no conversation in which to have asked for a recce.
   */
  scoutFindings?: readonly string[];
  /** The most workstreams this segmentation may contain. */
  maxWorkstreams: number;
  /** How many of them will actually run at once. The overseer should know it is not unbounded. */
  maxConcurrent: number;
  /**
   * Why the previous segmentation was sent back, when this is a re-segmentation.
   *
   * SUPERVISOR-WRITTEN, from `duplicateClaims`, never the overseer's own previous return. A model
   * re-reading its own last answer argues with it; a model reading a list of files two of its
   * workstreams both claimed fixes the list.
   */
  previousRejection?: string;
}

/**
 * The `MAJ·OVERSEER`'s `orders.md` for segmenting a feature.
 *
 * ## What this brief is careful about
 *
 * An overseer holds `Read`, `Grep`, `Glob` and `TodoWrite`. No editor, no shell, no network. That
 * is not a temporary shortage to be worked around and the brief says so, because a model that
 * believes it is meant to be building will spend its whole window discovering that it cannot.
 *
 * The other thing it is careful about is the cost of a slice. Every workstream this returns costs
 * a worktree, a metered model session and a merge, so "how many" is a spending decision the
 * overseer is making on someone else's behalf, and one workstream is a correct answer for a
 * feature that does not split.
 */
export function renderSegmentationBrief(input: SegmentationBriefInput): string {
  const { orders } = input;
  const lines: string[] = [];
  lines.push(`# ORDERS — MAJ·OVERSEER · ${orders.taskId}`);
  lines.push('');
  lines.push(`You own this feature. Project: \`${orders.project}\`.`);
  lines.push('');
  lines.push('## THE FEATURE');
  lines.push('');
  lines.push(orders.objective);
  lines.push('');

  if (input.spec !== undefined) {
    lines.push(renderTechnicalSpec(input.spec, '## THE SPEC A HUMAN APPROVED'));
    lines.push('');
    lines.push(
      'These decisions were made above you and a human approved them. Segment the work they ' +
        'describe. Do not re-scope it, do not improve on it, and do not add a workstream for ' +
        'something nobody asked for.',
    );
    lines.push('');
  }

  if (input.scoutFindings !== undefined && input.scoutFindings.length > 0) {
    lines.push('## WHAT THE SCOUT FOUND');
    lines.push('');
    for (const finding of input.scoutFindings) lines.push(`- ${finding}`);
    lines.push('');
  }

  if (input.previousRejection !== undefined) {
    lines.push('## YOUR PREVIOUS SEGMENTATION WAS SENT BACK');
    lines.push('');
    lines.push(input.previousRejection);
    lines.push('');
    lines.push(
      'Fix exactly that. Two workstreams cannot declare the same path: give the file to one of ' +
        'them, or merge the two workstreams, or split the file\'s work so the boundary falls ' +
        'somewhere real. Do not resolve it by deleting the declaration, which trades a problem ' +
        'that is visible now for a merge conflict that is not.',
    );
    lines.push('');
  }

  lines.push('## WHAT YOU HOLD, AND WHAT YOU DO NOT');
  lines.push('');
  lines.push(
    '- `Read`, `Grep`, `Glob` and `TodoWrite`. Read the repository as widely as you need to.',
  );
  lines.push(
    '- No editor, no shell, no network. Not an oversight and not a shortage to work around: a ' +
      'feature owner that can edit will edit, and then nothing above the engineers is reviewing ' +
      'what they did. You decide; the supervising process acts.',
  );
  lines.push(
    '- You do not spawn anyone. You return this plan and the process spawns one engineer per ' +
      'workstream, each in its own worktree on its own branch.',
  );
  lines.push('');

  lines.push('## HOW TO SEGMENT');
  lines.push('');
  lines.push(
    `At most ${String(input.maxWorkstreams)} workstreams, and at most ` +
      `${String(input.maxConcurrent)} of them run at a time. **One workstream is a correct answer** ` +
      'for a feature that does not split. Every extra workstream costs a worktree, a whole model ' +
      'session and a merge, so segment because the work genuinely separates, never to look ' +
      'thorough.',
  );
  lines.push('');
  lines.push('1. Read the code first. A plan drawn from the objective alone splits along the words in it rather than along the seams in the repository.');
  lines.push(
    '2. Cut along a real boundary: a module, a layer, a file set with one owner. A boundary two ' +
      'engineers have to negotiate across every hour is not a boundary.',
  );
  lines.push(
    '3. Declare the files or directories each workstream is expected to touch. **No path may ' +
      'appear in two workstreams.** That is checked mechanically before anyone is spawned, and a ' +
      'collision sends this plan back to you.',
  );
  lines.push(
    '4. Write each `slice` so it stands alone. It is the WHOLE of what its engineer is told to ' +
      'build, next to the objective and the spec. An engineer cannot ask you what you meant ' +
      'without stopping and costing a round trip.',
  );
  lines.push(
    '5. Assume the workstreams run at the same time and in any order. A workstream that only ' +
      'works if another one finished first is not a separate workstream: put them together.',
  );
  lines.push('');
  lines.push(
    'The declaration is not a fence. An engineer that needs a neighbour\'s file takes it and says ' +
      'so, and you reconcile at integration. What the declaration buys is that the collisions a ' +
      'plan could have avoided are found now, while they are free.',
  );
  lines.push('');
  lines.push('## YOUR RETURN');
  lines.push('');
  lines.push('Return the schema-constrained segmentation and nothing else.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** What the overseer is told when a question climbs to it from one of its engineers. */
export interface OverseerQuestionBriefInput {
  orders: OriginalOrders;
  spec?: TechnicalSpec;
  /**
   * The question, already projected and sanitised. See `src/contracts/question.ts`: the
   * supervisor-owned half and the worker-authored half are separated in the type, and this
   * renderer keeps them separate on the page.
   */
  pending: PendingQuestion;
  /** The asking engineer's workstream, when the feature was segmented. */
  workstream?: WorkstreamBrief;
}

/**
 * The `MAJ·OVERSEER`'s `orders.md` for one question climbing the ladder.
 *
 * ## The whole point of this rung, and the whole risk of it
 *
 * A question the overseer can answer never reaches the human, which is why the rank exists. A
 * question the overseer answers WRONGLY also never reaches the human, and nothing above it will
 * look at that answer again, because the answer rides into the next engineer's orders with the
 * same standing a human's would have. So the brief spends most of its length on the second half:
 * declining is free, deciding is not, and the model is told which questions are its to settle.
 */
export function renderOverseerQuestionBrief(input: OverseerQuestionBriefInput): string {
  const { orders, pending } = input;
  const lines: string[] = [];
  lines.push(`# ORDERS — MAJ·OVERSEER · ${orders.taskId}`);
  lines.push('');
  lines.push(
    `One of your engineers has stopped and is asking a question. Project: \`${orders.project}\`.`,
  );
  lines.push('');
  lines.push('## THE FEATURE YOU OWN');
  lines.push('');
  lines.push(orders.objective);
  lines.push('');
  if (input.spec !== undefined) {
    lines.push(renderTechnicalSpec(input.spec, '## THE SPEC A HUMAN APPROVED'));
    lines.push('');
  }
  if (input.workstream !== undefined) {
    lines.push(`## THE WORKSTREAM THAT ASKED: \`${input.workstream.id}\``);
    lines.push('');
    lines.push(`> ${input.workstream.slice}`);
    lines.push('');
    if (input.workstream.siblings.length > 0) {
      lines.push('Running alongside it:');
      lines.push('');
      for (const sibling of input.workstream.siblings) {
        lines.push(`- \`${sibling.id}\` — ${sibling.slice}`);
      }
      lines.push('');
    }
  }
  lines.push('## THE QUESTION');
  lines.push('');
  lines.push(
    `\`${pending.agentId}\` (${pending.rank}·${pending.role}), attempt ${String(pending.attempt)}, ` +
      `branch \`${pending.branch}\`. Everything below is ITS OWN WORDS, quoted:`,
  );
  lines.push('');
  lines.push(`> ${pending.question}`);
  lines.push('');
  lines.push('Its account of where it got to:');
  lines.push('');
  lines.push(`> ${pending.summary}`);
  if (pending.tried.length > 0) {
    lines.push('');
    lines.push('What it says it tried or ruled out:');
    lines.push('');
    for (const item of pending.tried) lines.push(`> ${item.severity}: ${item.message}`);
  }
  lines.push('');
  lines.push('## ANSWER IT, OR SAY YOU WILL NOT');
  lines.push('');
  lines.push(
    'You are the rung between that engineer and the human who asked for this feature. If you can ' +
      'settle this, the human never has to. If you cannot, say so and it reaches them unchanged, ' +
      'which costs a wait and nothing else.',
  );
  lines.push('');
  lines.push('ANSWER when the question is about the work you segmented:');
  lines.push('- which of two workstreams owns a file, a function, or a decision;');
  lines.push('- how this slice is meant to meet the one next to it;');
  lines.push('- something the spec above already settles and the engineer has not read closely enough;');
  lines.push('- a fact about this repository that `Read` and `Grep` can establish. Go and look.');
  lines.push('');
  lines.push('DECLINE — return `answer: null` — when:');
  lines.push('- the answer would change the objective or the spec. Those were approved by a human and you are not the human;');
  lines.push('- it is a product decision, a trade-off nobody has stated a preference between, or a cost somebody has to agree to;');
  lines.push('- two reasonable engineers would answer it differently and you cannot say which is right;');
  lines.push('- you would be guessing. A guess wearing your authority is worse than a question that waits.');
  lines.push('');
  lines.push(
    "Your answer, if you give one, goes into a fresh engineer's orders in the same worktree, " +
      'named as YOURS and labelled a decision by the unit that owns this feature, not as the ' +
      'spec, and not as a human\'s. The engineer is told to act on it and is also told it may ' +
      'report `blocked` again with a new question if your answer is wrong or contradicts the ' +
      'spec, and that question reaches the human. So answer as the feature owner and not as the ' +
      'last word: a wrong answer costs a round, and a guess dressed as the spec costs the ' +
      'workstream. One line.',
  );
  lines.push('');
  lines.push('Return the schema-constrained answer and nothing else.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * What the overseer is told when a reviewer has refused a branch and somebody has to decide what
 * happens next.
 *
 * ## Why the findings are allowed here and the engineer's report is not
 *
 * `verdict` is a REVIEWER's, and reviewer → reviewee is the direction the whole gate exists to
 * permit. This brief travels sideways-and-up rather than down: the overseer is being asked to
 * adjudicate between a reviewer and a workstream, and it cannot do that without the reviewer's
 * findings. What is still absent is the ENGINEER's account — there is no field on this input that
 * can hold one, exactly as with `InspectorBriefInput`.
 */
export interface AdjudicationBriefInput {
  orders: OriginalOrders;
  spec?: TechnicalSpec;
  /** The reviewer's refusal, in full. */
  verdict: Verdict;
  /** Which reviewer produced it. `INSPECTOR` reviewed a slice; `VALIDATOR` judged the whole. */
  reviewer: 'INSPECTOR' | 'VALIDATOR';
  /** The branch that was refused, as the supervisor cut it. */
  branch: string;
  /** The workstream under adjudication, when a slice is what was refused. */
  workstream?: WorkstreamBrief;
  /** Engineer attempts already spent on this work, and the budget they came out of. */
  spent: number;
  budget: number;

  // ---- structurally unreachable, on purpose -------------------------------------------------
  /** @deprecated Never. The reviewee does not argue its own case. */
  report?: never;
  /** @deprecated Never. */
  summary?: never;
}

/**
 * The `MAJ·OVERSEER`'s `orders.md` for one refusal.
 *
 * ## The decision is genuinely two-sided, and the brief says so
 *
 * `retry` is the default and the safe direction — it is what a campaign with no overseer does, and
 * what this system did before this rung existed. But it is not free: another engineer is another
 * metered session against a budget that is shared with nothing, and a reviewer that refused a
 * branch over a `minor` finding has not found a reason to spend one. So the overseer is asked the
 * question that neither the reviewer nor the supervisor is placed to answer: is this finding worth
 * what fixing it costs, given what is left.
 *
 * What it is NOT allowed to do is fix anything. It holds no editor and no shell, and the brief
 * repeats that, because a model holding findings and a repository it can read will otherwise spend
 * its window drafting the patch it cannot apply.
 */
export function renderAdjudicationBrief(input: AdjudicationBriefInput): string {
  const { orders, verdict } = input;
  assertSupervisorBranch(input.branch);
  const lines: string[] = [];
  lines.push(`# ORDERS — MAJ·OVERSEER · ${orders.taskId}`);
  lines.push('');
  lines.push(
    `A \`CPT·${input.reviewer}\` has REFUSED a branch and the decision about what happens next is ` +
      `yours. Project: \`${orders.project}\`.`,
  );
  lines.push('');
  lines.push('## THE FEATURE YOU OWN');
  lines.push('');
  lines.push(orders.objective);
  lines.push('');
  if (input.spec !== undefined) {
    lines.push(renderTechnicalSpec(input.spec, '## THE SPEC A HUMAN APPROVED'));
    lines.push('');
  }
  if (input.workstream !== undefined) {
    lines.push(`## THE WORKSTREAM THAT WAS REFUSED: \`${input.workstream.id}\``);
    lines.push('');
    lines.push(`> ${input.workstream.slice}`);
    lines.push('');
  }
  lines.push(
    input.reviewer === 'VALIDATOR'
      ? `## THE VALIDATOR'S REFUSAL — \`${input.branch}\` is the INTEGRATED branch`
      : `## THE INSPECTOR'S REFUSAL — \`${input.branch}\``,
  );
  lines.push('');
  lines.push(`> ${verdict.summary}`);
  lines.push('');
  lines.push(...findingLines(verdict));
  lines.push('');
  lines.push(
    verdict.testsRun
      ? 'It reports that it ran the suite to completion.'
      : '**It reports that it did NOT run the suite to completion.** A refusal from a reviewer ' +
        'that could not execute anything is a refusal about what it could read, which is worth ' +
        'less than one it could demonstrate — weigh it accordingly, in both directions.',
  );
  lines.push('');
  lines.push('## THE BUDGET');
  lines.push('');
  lines.push(
    `${String(input.spent)} of ${String(input.budget)} engineer attempts have been spent on this ` +
      'work. Another engineer costs one more, and there is no reserve behind it: when the budget ' +
      'is gone the campaign ends without delivering, whatever state the branch is in.',
  );
  lines.push('');
  lines.push('## RETRY, OR ACCEPT');
  lines.push('');
  lines.push('RETRY — send it back to a fresh engineer with these findings — when:');
  lines.push('- any finding is a `blocker`, or would be one if you read it as the feature owner;');
  lines.push('- the work does not do what the slice above says it should;');
  lines.push('- the reviewer found something the spec explicitly asked for and the branch does not have.');
  lines.push('');
  lines.push('ACCEPT — overrule the refusal — when:');
  lines.push('- every finding is a preference about style, naming, or structure that the spec does not settle;');
  lines.push('- the reviewer refused it for not being the whole feature, and it is one slice of several;');
  lines.push('- the finding is real but is another workstream\'s to fix, and saying so is cheaper than a retry here.');
  lines.push('');
  lines.push(
    'ACCEPTING IS NOT FREE AND NEITHER IS RETRYING. An accepted branch merges and reaches the ' +
      'validator with the finding still in it; a retried one spends an attempt that its siblings ' +
      'cannot get back. If you genuinely cannot tell, retry — that is what this campaign does with ' +
      'no overseer at all, and being no worse than the absence of your rank is the floor.',
  );
  lines.push('');
  lines.push(
    'You hold `Read`, `Grep` and `Glob` and nothing else. You cannot fix this and you are not ' +
      'being asked to: do not write the patch, do not describe the patch line by line, and do not ' +
      'ask another unit to apply one on your behalf. Say `retry` or `accept`, and say why in one ' +
      'line, because that line is what the next engineer reads.',
  );
  lines.push('');
  lines.push('Return the schema-constrained decision and nothing else.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// report.md — the full findings that do not fit in a capped return
// ---------------------------------------------------------------------------------------------

function renderFindings(findings: Report['findings']): string[] {
  if (findings.length === 0) return ['_No findings._'];
  return findings.map((finding) => {
    const where =
      finding.file === undefined
        ? ''
        : ` (\`${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}\`)`;
    return `- **${finding.severity}**${where}: ${finding.message}`;
  });
}

/** `report.md` for an Engineer attempt. */
export function renderEngineerReportMd(agentId: string, report: Report): string {
  const lines: string[] = [`# Report — ${agentId}`, ''];
  lines.push(`**Status:** ${report.status}`);
  if (report.branch !== undefined) lines.push(`**Branch:** \`${report.branch}\``);
  if (report.costUsd !== undefined) lines.push(`**Cost:** $${report.costUsd.toFixed(4)}`);
  lines.push('', '## Summary', '', report.summary, '');
  // Above the findings, because on a blocked report this is the whole point of the document: a
  // human opening `report.md` after the fact is looking for what was asked, and a question buried
  // under the itemised findings is a question they have to go and find.
  if (report.question !== undefined) {
    lines.push('## Question', '', `> ${report.question}`, '');
  }
  lines.push('## Findings', '');
  lines.push(...renderFindings(report.findings));
  lines.push('', '## Artifacts', '');
  lines.push(
    ...(report.artifacts.length === 0
      ? ['_None._']
      : report.artifacts.map(
          (artifact) =>
            `- \`${artifact.kind}\` ${artifact.ref}` +
            `${artifact.note === undefined ? '' : ` — ${artifact.note}`}`,
        )),
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** `report.md` for an Inspector verdict. */
export function renderVerdictMd(agentId: string, verdict: Verdict): string {
  const lines = [
    `# Verdict — ${agentId}`,
    '',
    `**Verdict:** ${verdict.verdict.toUpperCase()}`,
    `**Tests run:** ${verdict.testsRun ? 'yes' : 'NO'}${
      verdict.testCommand === undefined ? '' : ` (\`${verdict.testCommand}\`)`
    }`,
    '',
    '## Summary',
    '',
    verdict.summary,
    '',
    '## Findings',
    '',
    ...renderFindings(verdict.findings),
    '',
    ...renderBehaviourVerdicts(verdict.behaviours),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The per-behaviour accounting, in the file a human actually opens.
 *
 * MEASURED GAP, and the reason this exists. On the first live campaign to use the field, codex
 * returned all five determinations correctly — and none of them reached the archive. The JSON
 * artifact projects a `Verdict` into the cross-role `Report` shape, which has no room for them,
 * and this renderer stopped at `findings`. The accounting survived only inside an escaped string
 * in `stream.jsonl`.
 *
 * That is close to useless for the thing it was built for. The whole point of forcing one entry
 * per clause is that a human can see the clause nobody checked; a determination that exists but
 * cannot be read has not made anything visible. `not-verified` rows are called out separately
 * below the table for the same reason — they are the rows worth a second look, and a reader
 * scanning a table of fifteen will not find them.
 */
function renderBehaviourVerdicts(behaviours: Verdict['behaviours']): string[] {
  if (behaviours === undefined || behaviours.length === 0) return [];
  const lines: string[] = ['## Behaviours', ''];
  for (const entry of [...behaviours].sort((a, b) => a.behaviour - b.behaviour)) {
    lines.push(`- **${String(entry.behaviour)}. ${entry.status}** — ${entry.note}`);
  }
  lines.push('');
  const unverified = behaviours.filter((b) => b.status === 'not-verified').map((b) => b.behaviour);
  if (unverified.length > 0) {
    lines.push(
      `**${String(unverified.length)} behaviour(s) were NOT verified: ${unverified.sort((a, b) => a - b).join(', ')}.** ` +
        'A pass with unverified clauses is a pass on what was checked, not on the whole spec.',
    );
    lines.push('');
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The campaign's own summary line
// ---------------------------------------------------------------------------------------------

export function describeRung(rung: Rung): string {
  return `${rung} (${RUNG_LABEL[rung]})`;
}
