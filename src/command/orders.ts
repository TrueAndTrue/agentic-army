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
  ];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// The campaign's own summary line
// ---------------------------------------------------------------------------------------------

export function describeRung(rung: Rung): string {
  return `${rung} (${RUNG_LABEL[rung]})`;
}
