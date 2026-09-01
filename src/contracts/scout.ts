/**
 * The scout's return, and the ceilings on what one recce may cost.
 *
 * ## What a scout is
 *
 * A `CPT·SCOUT` is the one unit in this system that goes and finds out. It reads the repository
 * and the web, it may split a question across native subagents, and it hands back prose. It
 * NEVER WRITES: `ROLE_ALLOW.SCOUT` is `Read`, `Grep`, `Glob`, `WebFetch` and `WebSearch`, and
 * `ROLE_WRITES_FILES.SCOUT` is `false`, so a scout holds no editor at any rank.
 *
 * **A SCOUT HOLDS NO WORKTREE.** It is spawned with the primary checkout as its `cwd`, exactly as
 * a `MAJ·OVERSEER` is, and for the same reason: a lease exists so that a writing worker's changes
 * are isolated and recoverable, and a unit that cannot write has nothing to isolate. Stated here
 * rather than left to be worked out from the absence of a lease call, because "which units hold a
 * tree" is a question a reader of this system asks constantly and the answer for this one is a
 * flat no.
 *
 * ## Why the return is a schema and not a transcript
 *
 * The finding rides into a `MAJ·OVERSEER`'s segmentation brief (`scoutFindings` on
 * `SegmentationBriefInput`) and is printed to a human on a terminal. It is therefore
 * WORKER-AUTHORED TEXT crossing into a document that carries supervisor authority and onto a
 * screen that obeys escape bytes — the same two hazards `Report.summary` and `Segmentation.slice`
 * carry, and it gets the same two answers: capped and single-line HERE, neutralised at capture in
 * `src/command/scout.ts`. `src/contracts/**` imports nothing, so `sanitize` cannot live here; the
 * split is deliberate and is documented on `neutralised` in `src/command/overseer.ts`.
 *
 * ## The ceilings, and what they are worth
 *
 * A research agent that fans out without a ceiling is the unbounded-tree problem the campaign cap
 * already solved, and it burns the budget before an Engineer has been spent. Three bounds, and
 * they are worth different amounts:
 *
 *  - DEPTH is enforced by the harness. `buildSoldierSpec` issues the roster,
 *    `subagentRosterFor('CAPTAIN', 'SCOUT')` names `sgt-scout` and `pvt-scout`, and
 *    `subagentDepthEnv` puts `maxSubagentDepth('CAPTAIN')` — which is 1, because `SPAWNS_UNITS`
 *    makes SERGEANT the floor — onto the child's environment. Measured on claude 2.1.221: at the
 *    cap the harness removes the spawn tool from the subordinate rather than refusing the call.
 *    Nothing in this file is needed for that and nothing here can weaken it.
 *  - COUNT is enforced by the SUPERVISOR, here, because nothing else can. A roster says who may be
 *    fielded and has no position for how many. `SCOUT_MAX_SUBAGENTS` is a ceiling the orders state
 *    and `src/command/scout.ts` measures off the event stream, halting the recce when it is
 *    crossed. A number in a briefing alone would be a request.
 *  - COST is bounded by the arithmetic of the two above plus a wall clock. One recce is at most
 *    1 + `SCOUT_MAX_SUBAGENTS` model sessions, all inside one process, all inside
 *    `SCOUT_TIMEOUT_MS`. There is no per-token meter to abort on: claude reports `costUsd` on the
 *    `result` event, which for a one-shot worker arrives when it is already over. So the honest
 *    ex-post bound is `SCOUT_SESSION_BUDGET_USD`, which refuses a FURTHER recce in the same
 *    conversation once cumulative spend crosses it — the same shape as the campaign attempt
 *    budget, and stated as what it is rather than dressed up as a live limiter.
 */

import type { ValidationResult } from './report.ts';
import { SUMMARY_MAX_CHARS } from './report.ts';

import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Caps on the question and the answer
// ---------------------------------------------------------------------------------------------

/**
 * One line, and the same cap the objective carries.
 *
 * A scout's question is read back verbatim into its `orders.md`, which is a markdown document with
 * `##` headings — so the cap and the newline refusal keep it to a size and a shape a human can
 * approve at a glance, which is the same defence `OBJECTIVE_MAX_CHARS` and `SPEC_ENTRY_MAX_CHARS`
 * are.
 *
 * WHAT IT DOES NOT DO is stop the question opening a section. This comment used to claim that "a
 * single line cannot open a section" and the claim was simply wrong: `## do X` is one line and it
 * is a heading. `renderScoutBrief` is what makes it true, by quoting the question into a
 * blockquote, and the correction is recorded here because a comment asserting a property nothing
 * enforces is worse than no comment — it is the reason nobody looked.
 */
export const SCOUT_QUESTION_MAX_CHARS = 500;

/** Per-entry ceiling on the finding's lists. One readable line, not a paragraph. */
export const FINDING_ENTRY_MAX_CHARS = 500;

/**
 * Entries per list.
 *
 * The finding is prepended to an overseer's segmentation brief and printed in full to a human, so
 * it is paid for twice. Twenty dense lines is a real briefing; two hundred is a transcript with a
 * schema around it.
 */
export const FINDING_MAX_ENTRIES = 20;

// ---------------------------------------------------------------------------------------------
// The ceilings on one recce
// ---------------------------------------------------------------------------------------------

/**
 * How many native subagents one `CPT·SCOUT` may field before the supervisor halts it.
 *
 * FOUR, and the number is a spending decision rather than a guess about how many a question
 * splits into. Each subagent runs inside the scout's own process and is billed to the same
 * subscription, so the ceiling at maximum is five model sessions for a unit that has not yet
 * produced a line of code. A scout that needs more than four parallel lines of enquiry is being
 * asked a question that should have been two dispatches.
 *
 * ENFORCED BY MEASUREMENT, not by the harness: see `SCOUT_MAX_SUBAGENTS` in the header above.
 */
export const SCOUT_MAX_SUBAGENTS = 4;

/**
 * Wall clock for one recce, in milliseconds.
 *
 * Ten minutes. It is a third of `DEFAULT_SOLDIER_TIMEOUT_MS`, and deliberately so: an Engineer is
 * measured at 9m42s in this repo's own trial data and needs the full half hour, whereas a scout
 * that has been reading for ten minutes has either found the answer or is not going to. On claude
 * this arrives as `closeGraceMs`, which is the whole of a one-shot worker's working time because
 * `runSoldier` closes stdin immediately after the orders.
 *
 * This is the ONE ceiling that stops a running recce on the clock rather than on an event, which
 * is why it is here and not left to the adapter's 300s default.
 */
export const SCOUT_TIMEOUT_MS = 10 * 60_000;

/**
 * Cumulative recce spend, in dollars, after which a conversation asks for no more scouts.
 *
 * EX-POST, and the distinction is the whole honesty of this constant. `costUsd` reaches this
 * process on the `result` event, which for a one-shot worker is the last thing it emits, so no
 * amount of arithmetic here can stop a recce that is already running from finishing. What it does
 * stop is the next one: a conversation that has spent this much finding things out is a
 * conversation that should be dispatching an Engineer or asking the human a question.
 */
export const SCOUT_SESSION_BUDGET_USD = 5;

/**
 * What one model session in a recce is charged when nobody reported what it cost.
 *
 * MEASURED, in this repository, on two real runs: a recce that fielded one subordinate — two model
 * sessions, the scout and it — reported `costUsd` of $0.11 on its `result` event, which is $0.055
 * a session. The number is a floor with a real reading behind it rather than a guess, and it is
 * stated to two decimals because that is the precision the reading had.
 *
 * ## Why an estimate exists at all
 *
 * `costUsd` arrives on the `result` event, which a one-shot worker emits last. A recce HALTED for
 * crossing the fan-out ceiling is SIGKILLed before that event, so its cost is `null` — and the
 * ledger, which added nothing for a null, charged nothing for the single most expensive thing a
 * conversation can do: five model sessions, one per subordinate plus the scout. Measured: the
 * 7-subordinate run reported null and the 1-subordinate run reported $0.11, so the run that spent
 * seven times as much was the one that spent, on the record, nothing.
 *
 * The direction of the error is chosen deliberately. Overcharging costs a conversation one recce
 * it could have afforded; undercharging costs the budget `refuseOnBudget` exists to hold, and does
 * it precisely on the runs that spent the most. So an unreported recce is charged for the sessions
 * that were MEASURED to have opened — 1 for the scout plus one per subordinate `watchFanOut`
 * counted — rather than for zero or for a flat maximum.
 */
export const SCOUT_MODEL_SESSION_USD = 0.055;

// ---------------------------------------------------------------------------------------------
// The finding
// ---------------------------------------------------------------------------------------------

/**
 * What a scout hands back.
 *
 * `unknowns` is REQUIRED and that is the field worth defending. A scout is sent because nobody
 * knows the answer, and a report with no stated gaps is either a question that did not need
 * asking or a model that filled the gaps in silently — which is the exact failure the spec
 * interrogation exists to prevent one layer up. A scout that genuinely determined everything says
 * so in one entry, the same convention `validateTechnicalSpec` uses for an empty list.
 *
 * There is deliberately NO field for how many subordinates were fielded. That number is measured
 * off the event stream by the supervisor; asking the model for it would be asking the party under
 * a spending cap to report its own spending.
 */
export interface ScoutFinding {
  /** One line. The answer to the question it was sent with. */
  summary: string;
  /** The evidence: what it found, and where. */
  findings: readonly string[];
  /** What it could not determine, named rather than guessed at. */
  unknowns: readonly string[];
}

export const SCOUT_FINDING_SCHEMA_PATH = fileURLToPath(
  new URL('../../schemas/scout-finding.v1.json', import.meta.url),
);

const REQUIRED_KEYS = ['summary', 'findings', 'unknowns'] as const;

function isPlainObject(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

function checkLine(value: unknown, max: number, path: string, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${path}: expected string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    errors.push(`${path}: is blank`);
    return undefined;
  }
  if (/[\r\n]/.test(trimmed)) {
    errors.push(`${path}: contains a newline, and this text is rendered into a markdown briefing`);
    return undefined;
  }
  if (trimmed.length > max) {
    errors.push(`${path}: is ${String(trimmed.length)} characters, over the ${String(max)} cap`);
    return undefined;
  }
  return trimmed;
}

function checkList(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array of strings`);
    return [];
  }
  if (value.length === 0) {
    // The same reading `validateTechnicalSpec` gives an empty list: it is indistinguishable from
    // never having answered. A scout with nothing to say in a field says that in one entry.
    errors.push(`${path}: is empty. If there is genuinely nothing here, say so in one entry.`);
    return [];
  }
  if (value.length > FINDING_MAX_ENTRIES) {
    errors.push(
      `${path}: has ${String(value.length)} entries, over the ${String(FINDING_MAX_ENTRIES)} cap. ` +
        'This briefing is carried into a segmentation and printed to a human; it is paid for twice.',
    );
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const line = checkLine(value[i], FINDING_ENTRY_MAX_CHARS, `${path}[${String(i)}]`, errors);
    if (line !== undefined) out.push(line);
  }
  return out;
}

/**
 * Validate an untrusted value as a `ScoutFinding`.
 *
 * Refuses rather than repairs, the standing philosophy of every validator in `src/contracts/**`.
 * A malformed finding is a recce that produced nothing usable, and the caller's answer to that is
 * to say so and carry on with no findings — never to invent a field the scout did not fill.
 */
export function validateScoutFinding(u: unknown): ValidationResult<ScoutFinding> {
  const errors: string[] = [];
  if (!isPlainObject(u)) return { ok: false, errors: ['finding: expected object'] };

  for (const key of REQUIRED_KEYS) {
    if (u[key] === undefined || u[key] === null) errors.push(`${key}: required`);
  }
  for (const key of Object.keys(u)) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(key)) {
      errors.push(`${key}: unknown property`);
    }
  }

  const summary = checkLine(u['summary'], SUMMARY_MAX_CHARS, 'summary', errors);
  const findings = checkList(u['findings'], 'findings', errors);
  const unknowns = checkList(u['unknowns'], 'unknowns', errors);

  if (errors.length > 0 || summary === undefined) return { ok: false, errors };
  return { ok: true, value: { summary, findings, unknowns } };
}

/**
 * The finding as the lines an overseer's brief and a terminal both read.
 *
 * THE ONLY RENDERER, the same rule `renderTechnicalSpec` follows: what a human is shown and what
 * a `MAJ·OVERSEER` is briefed with have to be the same bytes, or the human approved something
 * else. `CampaignOptions.scoutFindings` is a flat string list, so this is what fills it.
 */
export function scoutFindingLines(finding: ScoutFinding): string[] {
  return [
    finding.summary,
    ...finding.findings,
    ...finding.unknowns.map((entry) => `could not determine: ${entry}`),
  ];
}
