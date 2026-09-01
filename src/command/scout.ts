/**
 * The `CPT·SCOUT` — the unit that goes and finds out, and the ceilings on what it may spend.
 *
 * ```
 * ◆ COL·COMMANDER   proposes a recce; it cannot spawn one
 *  │
 * (a human keystroke)
 *  │
 * ☆ GENERAL (the supervising process) ── spawns ─▶ ◇ CPT·SCOUT   claude, NO WORKTREE,
 *                                                  │   Read/Grep/Glob/WebFetch/WebSearch
 *                                                  ├─ ▪ sgt-scout   at most SCOUT_MAX_SUBAGENTS,
 *                                                  └─ ▪ sgt-scout   depth 1, one process, one bill
 * ```
 *
 * ## THIS MODULE SPAWNS NOTHING
 *
 * Same shape as `src/command/overseer.ts`, and for the same reasons. Every function here takes a
 * `ScoutSpawn` callback and gets back a structured return, because the caller owns
 * `buildSoldierSpec`, the archive and the progress stream, and a second spawn path would be a
 * second place a worker could be built without a deny-list. It also means the decisions in this
 * file — what a malformed finding costs, what happens when the fan-out ceiling is crossed — are
 * testable without spawning anything.
 *
 * A MODEL NEVER SPAWNS ANYTHING. The Commander proposes a recce in its reply; the supervising
 * process spawns it, after a human has confirmed the question with a keystroke. That is the same
 * rule the dispatch path follows and it is not weakened here: a scout costs money and reads the
 * network, and "the model asked for it" is not authority.
 *
 * ## A SCOUT HOLDS NO WORKTREE
 *
 * Its `cwd` is the primary checkout, exactly as a `MAJ·OVERSEER`'s is. A lease exists to isolate
 * and recover a writing worker's changes; `ROLE_WRITES_FILES.SCOUT` is `false` and
 * `ROLE_ALLOW.SCOUT` names no editor, so there is nothing to isolate and nothing to recover. Said
 * out loud rather than left to be inferred from a missing `provider.acquire` call.
 *
 * ## The three ceilings, and which of them is a mechanism
 *
 *  - DEPTH: the harness's. `fanOut: true` makes `buildSoldierSpec` issue
 *    `subagentRosterFor('CAPTAIN', 'SCOUT')` and the claude adapter puts
 *    `maxSubagentDepth('CAPTAIN')` — 1, because `SPAWNS_UNITS.SERGEANT` is `false` — onto the
 *    child's environment. Measured on claude 2.1.221: at the cap the harness REMOVES the spawn
 *    tool rather than refusing the call, so the floor rank has nothing to attempt. Nothing in
 *    this file participates and nothing here can weaken it.
 *  - COUNT: THIS FILE'S, because nothing else can enforce it. A roster names who may be fielded
 *    and has no position for how many. `watchFanOut` counts distinct spawn identities off the
 *    normalised event stream and reports the crossing; the caller halts the process on it. The
 *    number is also in the orders, and the orders alone would be a request — this is the half
 *    that holds when the request is ignored.
 *  - COST: arithmetic, plus a clock, plus a session ledger. At the ceiling one recce is
 *    1 + `SCOUT_MAX_SUBAGENTS` model sessions inside one process inside `SCOUT_TIMEOUT_MS`.
 *    `costUsd` arrives on the `result` event, which for a one-shot worker is the last thing it
 *    emits, so nothing here can abort a running recce on spend — `refuseOnBudget` bounds the NEXT
 *    one instead, and says so rather than pretending to be a live limiter.
 *
 * ## The finding is worker-authored, and is neutralised HERE
 *
 * It lands in a `MAJ·OVERSEER`'s segmentation brief (`CampaignOptions.scoutFindings`), in an
 * `orders.md`, in a signal body and on a terminal that obeys escape bytes. `checkLine` in
 * `src/contracts/scout.ts` caps it and refuses newlines, which stops a forged `##` heading and
 * nothing else: ESC, the CSI sequences behind it, the C1 range and `U+202E` all pass. So the
 * discipline waves 2, 3 and 4 each settled on applies unchanged — sanitise ONCE, at capture, in
 * `src/command/`, because `src/contracts/**` imports nothing at all and `sanitize` lives in
 * `src/view/`, which imports from it. Sanitising at each render site would cover whichever ones
 * somebody remembered.
 */

import type { SoldierEvent } from '../contracts/harness.ts';
import type { ScoutFinding } from '../contracts/scout.ts';
import {
  SCOUT_FINDING_SCHEMA_PATH,
  SCOUT_MAX_SUBAGENTS,
  SCOUT_MODEL_SESSION_USD,
  SCOUT_SESSION_BUDGET_USD,
  validateScoutFinding,
} from '../contracts/scout.ts';
import type { ValidationResult } from '../contracts/report.ts';
import { sanitize } from '../view/progress.ts';

import { SPAWN_TOOLS } from './permissions.ts';

// ---------------------------------------------------------------------------------------------
// The seam the caller supplies
// ---------------------------------------------------------------------------------------------

/** What one `CPT·SCOUT` process produced. Shaped like `SoldierRun`, minus what is not read. */
export interface ScoutRun {
  /** The agent id the caller minted, so notes and signals can name who looked. */
  agentId: string;
  /** The parsed schema-constrained return, or undefined when none arrived. */
  structured: unknown;
  /** The adapter's terminal status. */
  status: string;
  errors: readonly string[];
  /**
   * How many subordinates it actually fielded, MEASURED off the event stream by `watchFanOut`.
   *
   * Never a number the model reported. Asking the party under a spending cap to declare its own
   * spending is not a cap.
   */
  subagentsFielded: number;
  /** True when the supervisor stopped the recce for crossing `SCOUT_MAX_SUBAGENTS`. */
  haltedForFanOut: boolean;
  /** SESSION-CUMULATIVE on claude — the last reported value, never a sum. Null when none came. */
  costUsd: number | null;
}

/**
 * Spawn one scout and drain it.
 *
 * The caller implements this with the same `buildSoldierSpec` + `runSoldier` pair every other
 * worker goes through, so a scout gets the global deny-list, the posture, the archive rows and the
 * progress narration for free, and cannot be built without them.
 */
export type ScoutSpawn = (input: {
  /** The one-line question, for the archive and for the note a human reads. */
  question: string;
  /** The rendered `orders.md`. */
  orders: string;
  /** The capped return's schema. */
  outputSchemaPath: string;
}) => Promise<ScoutRun>;

// ---------------------------------------------------------------------------------------------
// The count ceiling — the half the harness does not enforce
// ---------------------------------------------------------------------------------------------

/**
 * A running count of the subordinates one worker has fielded, off the normalised event stream.
 *
 * ## What is counted, and why it is a SET of ids rather than a tally
 *
 * A native subagent shows up in two places and neither is a single event: the parent emits a
 * `tool_use` naming one of `SPAWN_TOOLS` and carrying a `toolUseId`, and every line the
 * subordinate forwards arrives with that same id as `parentToolUseId`. Counting events would
 * count a chatty subordinate as a squad. Counting distinct IDENTITIES counts subordinates, and
 * the two sources agree on the identity by construction, so a union of them double-counts nothing
 * and misses neither half — which matters, because a harness that stops forwarding subagent text
 * would otherwise silently take the ceiling with it.
 *
 * `parentToolUseId` is counted AT ANY DEPTH rather than only at 1. The depth cap should make a
 * deeper level impossible; if it ever does not, the conservative reading is that the extra level
 * is more fan-out and not less.
 *
 * Pure and synchronous, because it runs inside the loop draining the child's stdout — the same
 * contract `RunSoldierHooks.onEvent` states.
 */
export interface FanOutWatch {
  /** Distinct subordinates seen so far. */
  readonly count: number;
  /** True once `observe` has reported the crossing. Set once and never cleared. */
  readonly halted: boolean;
  /**
   * Fold one event in. Returns `true` on the ONE call that takes the count past the ceiling, so
   * the caller halts exactly once rather than on every event after it.
   */
  observe(event: SoldierEvent): boolean;
}

export function watchFanOut(max: number = SCOUT_MAX_SUBAGENTS): FanOutWatch {
  const seen = new Set<string>();
  let halted = false;
  return {
    get count(): number {
      return seen.size;
    },
    get halted(): boolean {
      return halted;
    },
    observe(event: SoldierEvent): boolean {
      if (event.type === 'tool_use' && SPAWN_TOOLS.includes(event.name)) {
        seen.add(event.toolUseId);
      } else if (event.parentToolUseId !== null) {
        seen.add(event.parentToolUseId);
      }
      if (halted || seen.size <= max) return false;
      halted = true;
      return true;
    },
  };
}

/**
 * The one-line form, for the live narration. Supervisor-written, from the ceiling alone.
 *
 * Exported so the note, the terminal line and the test that pins the wording all say the same
 * thing — the rule `postureNotice` and `describeCollisions` already follow.
 */
export function fanOutHaltLine(max: number = SCOUT_MAX_SUBAGENTS): string {
  return `scout stopped — it fielded more than ${String(max)} subordinates`;
}

/**
 * The full account, for the block printed after the recce.
 *
 * TWO WORDINGS, and they are not a duplication to tidy up. The narration line above is emitted
 * from inside the loop draining the child's stdout, where `renderProgressEvent` clips a note to
 * `PROGRESS_SUMMARY_MAX` and does not wrap it — driven on a pty, this sentence came out truncated
 * mid-word with an ellipsis and hard-broken across three rows. A one-line channel gets a one-line
 * message; the paragraph goes where there is room for it.
 *
 * The narration deliberately quotes no count. The number at the moment of the crossing and the
 * number by the time the process was gone are different (events keep arriving through the kill),
 * and showing 5 in one place and 7 in another three rows later reads as a bug rather than as two
 * true readings of a moving thing. So the live line names the CEILING, which does not move, and
 * the block reports the final measurement.
 */
export function describeFanOutHalt(count: number, max: number = SCOUT_MAX_SUBAGENTS): string {
  return (
    `the scout fielded ${String(count)} subordinates, past the ceiling of ${String(max)}, and its ` +
    'process was killed. Every one of them runs inside that process and is billed to the same ' +
    'subscription, so an uncapped fan-out spends the budget before an Engineer has been raised. ' +
    'Anything it had already reported is above; a scout that had not answered yet returns nothing, ' +
    'which is what a ceiling that stops rather than asks actually costs.'
  );
}

// ---------------------------------------------------------------------------------------------
// The cost ledger — ex-post, and honest about it
// ---------------------------------------------------------------------------------------------

/**
 * Why this conversation will not pay for another recce, or `null` when it will.
 *
 * EX-POST BY CONSTRUCTION. `costUsd` reaches this process on the `result` event, which a one-shot
 * worker emits as the last thing it does, so there is no moment at which a running recce could be
 * cut off on spend. What this bounds is the NEXT one, which is the same shape as the campaign's
 * attempt budget and is the honest version of a cost ceiling here.
 */
/**
 * What the ledger is charged for a recce whose cost never arrived.
 *
 * `1 + subagentsFielded` model sessions at `SCOUT_MODEL_SESSION_USD` each: the scout's own, plus
 * one for every subordinate `watchFanOut` actually counted off the event stream. Measured rather
 * than reported, which is the same rule the count ceiling follows — asking the party under a
 * spending cap what it spent is not a cap.
 *
 * NOT CLAMPED to `SCOUT_MAX_SUBAGENTS`. A halt fires on the crossing and events keep arriving
 * through the kill, so the final count can be 5, 6 or 7 where the ceiling is 4; those sessions
 * opened and were billed whatever the ceiling said, and clamping would discount exactly the
 * runaway this number exists to make visible.
 *
 * Kept separate from `ScoutRun.costUsd`, which stays null: the archive records what the adapter
 * REPORTED and the ledger records what this conversation is CHARGED, and collapsing the two would
 * put an estimate into an audit trail.
 */
export function unreportedRecceUsd(subagentsFielded: number): number {
  const sessions = 1 + Math.max(0, subagentsFielded);
  // Rounded to the cent the estimate is quoted in — a ledger that accumulates binary fractions
  // prints `$0.27500000000000002` in a refusal a human is meant to act on.
  return Math.round(sessions * SCOUT_MODEL_SESSION_USD * 100) / 100;
}

export function refuseOnBudget(
  spentUsd: number,
  budgetUsd: number = SCOUT_SESSION_BUDGET_USD,
): string | null {
  if (spentUsd < budgetUsd) return null;
  return (
    `this conversation has already spent $${spentUsd.toFixed(2)} on reconnaissance, at or over the ` +
    `$${budgetUsd.toFixed(2)} ceiling. Nothing further is scouted. A conversation that has spent ` +
    'this much finding things out is one that should be dispatching an Engineer or asking a ' +
    'question, and the ceiling is what makes that a decision rather than a discovery on a bill.'
  );
}

// ---------------------------------------------------------------------------------------------
// The recce
// ---------------------------------------------------------------------------------------------

/**
 * Neutralise every scout-authored string in a validated finding, at CAPTURE.
 *
 * Structure-preserving, exactly as `neutralised` in `src/command/overseer.ts` is: same
 * `ValidationResult` shape out, an invalid result straight back, so the caller's control flow is
 * untouched. See the header for why this is not in the validator.
 */
function neutralised(result: ValidationResult<ScoutFinding>): ValidationResult<ScoutFinding> {
  // THE ERRORS TOO, and this half is the one that was missing. `validateScoutFinding` puts the
  // model's OWN KEY NAMES into `\`${key}: unknown property\``; `runRecce` joins the first three
  // into the `unavailable` reason and `src/chat/run.ts` writes it straight to the terminal and
  // into a signal body. That is the path taken PRECISELY when the scout's output could not be
  // trusted enough to parse, so it is the last place raw model bytes should reach a screen.
  //
  // `src/contracts/**` imports nothing at all and `sanitize` lives in `src/view/`, which imports
  // from it, so this cannot be done in the validator — the split is the one documented on
  // `neutralised` in `src/command/overseer.ts` and it is why both halves of the result are handled
  // here rather than one.
  if (!result.ok) return { ok: false, errors: result.errors.map((error) => sanitize(error)) };
  return {
    ok: true,
    value: {
      summary: sanitize(result.value.summary),
      findings: result.value.findings.map((entry) => sanitize(entry)),
      unknowns: result.value.unknowns.map((entry) => sanitize(entry)),
    },
  };
}

/**
 * What this recce costs the session ledger, in dollars.
 *
 * A SECOND NUMBER beside `costUsd`, not a repaired version of it, and the two answer different
 * questions. `costUsd` is what the adapter REPORTED and is null when nothing did — that is the
 * fact the archive records, and an estimate written there would be an estimate in an audit trail.
 * `chargedUsd` is what `refuseOnBudget` is asked about, and it is never null, because a guard that
 * treats "nobody told me" as "nothing" stops guarding on exactly the runs that spend the most.
 * See `unreportedRecceUsd` for the arithmetic and the measurement behind it.
 */
type RecceCharge = { costUsd: number | null; chargedUsd: number };

export type RecceOutcome =
  | ({
      kind: 'found';
      finding: ScoutFinding;
      agentId: string;
      /** Measured, not reported. */
      subagentsFielded: number;
      haltedForFanOut: boolean;
    } & RecceCharge)
  | ({
      kind: 'unavailable';
      /** One sentence a human can act on. The caller turns this into a note. */
      reason: string;
      agentId: string | null;
    } & RecceCharge);

export interface RecceInput {
  spawn: ScoutSpawn;
  /** The one-line question a human approved. */
  question: string;
  /** `renderScoutBrief`, already applied to everything this module does not decide. */
  renderBrief: () => string;
  /** What this conversation has already spent on reconnaissance. Default 0. */
  spentUsd?: number;
  /** Called around the spawn, so a caller can abort a conversation the human has ended. */
  checkpoint?: (during: string) => void;
}

/**
 * Send one scout, once.
 *
 * ## ONE ROUND, AND NO RETRY
 *
 * `segmentFeature` retries a COLLISION because a collision is a specific, nameable defect a model
 * can fix in one pass. There is no equivalent here. A scout that returned nothing usable did not
 * produce the shape, and re-asking the same question is how a conversation spends two model
 * sessions on the same refusal before anyone has looked at a line of code. The answer to an
 * unusable finding is to say so and carry on with none — the interrogation still happens, the
 * dispatch still happens, and the Commander is told it is working without one.
 *
 * ## A HALTED RECCE IS STILL A RECCE, WHEN THERE IS ONE
 *
 * Crossing the fan-out ceiling kills the process; it does not discard what already arrived. If the
 * scout had emitted a well-formed finding before the crossing it is returned, with
 * `haltedForFanOut` set so every reader downstream knows the search was cut short. Throwing that
 * away would mean the ceiling costs a whole session rather than its tail.
 *
 * Said honestly, because the reassuring version is the wrong way round: a unit that is still
 * fanning out has usually not answered yet, so the COMMON outcome of a halt is `unavailable` with
 * nothing to show. That is the price of a ceiling that stops instead of asking, and it is why the
 * number is four rather than one.
 */
export async function runRecce(input: RecceInput): Promise<RecceOutcome> {
  const refusal = refuseOnBudget(input.spentUsd ?? 0);
  if (refusal !== null) {
    // Nothing was spawned, so nothing is charged. This is the ONE branch where a zero is the
    // honest answer rather than a missing measurement.
    return { kind: 'unavailable', reason: refusal, agentId: null, costUsd: null, chargedUsd: 0 };
  }

  input.checkpoint?.('the scout');
  const run = await input.spawn({
    question: input.question,
    orders: input.renderBrief(),
    outputSchemaPath: SCOUT_FINDING_SCHEMA_PATH,
  });
  input.checkpoint?.(`the scout (${run.agentId})`);

  // A process ran either way. What it reported is `costUsd`; what the ledger is charged is this,
  // and the halted case — SIGKILLed before the `result` event, so `costUsd` is null — is exactly
  // the case where the two differ and exactly the case that spends the most.
  const charge: RecceCharge = {
    costUsd: run.costUsd,
    chargedUsd: run.costUsd ?? unreportedRecceUsd(run.subagentsFielded),
  };

  const validated = neutralised(validateScoutFinding(run.structured));
  if (!validated.ok) {
    return {
      kind: 'unavailable',
      reason:
        `${run.agentId} returned no usable finding (adapter status ${run.status}): ` +
        `${validated.errors.slice(0, 3).join('; ')}`,
      agentId: run.agentId,
      ...charge,
    };
  }

  return {
    kind: 'found',
    finding: validated.value,
    agentId: run.agentId,
    subagentsFielded: run.subagentsFielded,
    haltedForFanOut: run.haltedForFanOut,
    ...charge,
  };
}
