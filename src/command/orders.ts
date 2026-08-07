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
        // True since Fix A: `verifyAllowRules` turns each approved verify command into an exact
        // Bash allow rule on this Engineer's own loadout. Without this sentence the field failure
        // repeats in miniature — a worker that has just read the loadout section believes bare
        // `node` is off-limits and skips the one check its orders told it to run.
        lines.push(
          'These exact commands are within your authority to run: each one was approved by a ' +
            'human with the spec and is on your Bash allow-list VERBATIM. Run them exactly as ' +
            'written — a variation (an added flag, a different path) is a different command and ' +
            'is not.',
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

  if (brief.spec !== undefined) {
    // Supervisor-owned and human-approved before the Engineer existed — never the reviewee's
    // narrative. See `InspectorBrief.spec`.
    lines.push(renderTechnicalSpec(brief.spec, '## THE SPEC THE WORK WAS ASKED AGAINST'));
    lines.push('');
    lines.push(...renderBehaviourAccounting(brief.spec));
  }

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
  lines.push('2. Run the test suite. If you cannot, say so and set `testsRun: false`.');
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
  return renderInspectorBrief(brief);
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
  lines.push('', '## Summary', '', report.summary, '', '## Findings', '');
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
