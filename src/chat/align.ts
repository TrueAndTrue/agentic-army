/**
 * The mechanical alignment gate — the thing that stands between phase 1 and phase 2.
 *
 * ```
 *   ◇ alignment gate
 *     ✓ spec         seven fields, six required — all present
 *     ✓ criteria     3 commands, all executed against 6f1a2c3
 *         ✓ node --test                 exit 1 at base — a red criterion, baseline recorded
 *         ✓ npx tsc --noEmit            exit 0 at base — already green before any work
 *     ◇ begin phase 2? [y/N]
 * ```
 *
 * Three conditions, and phase 2 begins only when all three hold:
 *
 *   1. every REQUIRED spec field is non-empty, and
 *   2. the spec's verification commands EXECUTE against the base commit, even if they fail, and
 *   3. the human confirms with a keystroke.
 *
 * This module owns the first two. The third is in `src/chat/run.ts`, at the prompt, and it is
 * LAST on purpose: it confirms a gate that already passed rather than being the whole gate. What
 * it used to be — one keystroke on a printed objective — is exactly the shape this replaces.
 *
 * ## WHY CONDITION 2 EARNS ITS PLACE, TWICE
 *
 * **A criterion nobody has ever run is a criterion nobody has agreed to.** That is the incident
 * that put `src/verify/gate.ts` in this codebase: a commander wrote
 * `node expenses.js sample-expenses.json prints an aligned table` into `acceptance`, the Engineer
 * built `expenses.json` instead, the Inspector ran the CLI against the file that existed and
 * passed the branch, and the criterion — run verbatim afterwards — exits 1. And the sharper
 * version, measured: one campaign ran three Engineers for 37.6 minutes and $8.86, two of which
 * SUCCEEDED, and delivered nothing, because a `grep` in its `verify` list had been mangled into a
 * form that exits 2 against any file that has ever existed. Reading each command here costs
 * seconds and turns that into a fact available before a human has said yes.
 *
 * **And running them now gives phase 3 a baseline.** The readings are durable, timestamped, and
 * taken before any Engineer exists, so "this test was already failing" stops being an argument an
 * agent can make later — it is either in the record or it is not.
 *
 * ## THE DISTINCTION THIS GATE IS BUILT AROUND
 *
 * | at base | gate | why |
 * |---|---|---|
 * | exit 0 | **PASSES** | a criterion that is already green. Worth a line on screen, not a refusal |
 * | any other exit code | **PASSES**, with the baseline recorded | a red test is a legitimate starting point for work meant to turn it green. This is the NORMAL case: `node --test` should fail before the feature exists |
 * | 126 / 127 (`SHELL_CANNOT_EXECUTE`) | **FAILS** | a shell could not run it at all. It will not run after the Engineer either, so this campaign could never pass its own gate |
 * | no exit code at all | **FAILS** | the command never started, or nothing watched it finish |
 * | timed out | **FAILS** | `src/contracts/verify.ts` says it plainly: a non-zero exit says the work is wrong, a timeout says NOBODY FOUND OUT. A criterion nobody found the result of is a criterion nobody agreed to, which is condition 2 in one sentence |
 *
 * The first two rows and the last three are the whole design, and they are kept apart everywhere
 * — in `CommandReading.executed`, in `renderAlignment`'s glyphs, and in the reason string each
 * failure carries. Collapsing "failed" into "could not run" is the mistake that would make this
 * gate refuse every honest red test in existence.
 *
 * ## WHAT A SPEC WITH NO `verify` DOES
 *
 * It PASSES, loudly. `TechnicalSpec.verify` is the one optional field and forcing one would
 * produce `true` and a gate that is theatre. But the absence is REPORTED rather than assumed —
 * `noCommands` carries it outward, the screen says nothing was executed and phase 3 has no
 * baseline, and `AcceptanceResult.ran` says the same thing one phase later. An unrun check must
 * never look like a passed one.
 */

import type { TechnicalSpec } from '../contracts/spec.ts';
import { SPEC_FIELD_LABEL, SPEC_LIST_FIELDS } from '../contracts/spec.ts';
import type { SpecListField } from '../contracts/spec.ts';
import type { CommandRunner, VerifyBaseline } from '../contracts/verify.ts';
import { SHELL_CANNOT_EXECUTE } from '../contracts/verify.ts';
import { runVerifyBaseline } from '../verify/gate.ts';
import { runGit } from '../delivery/git.ts';
import type { Charset } from '../view/render.ts';
import { asciiFoldBlock, displayWidth, glyphsFor, wrapPlain } from '../view/render.ts';

/**
 * The fields condition 1 checks, in the order they are asked for and rendered.
 *
 * DERIVED from `SPEC_LIST_FIELDS` rather than typed out, so a seventh required field added to the
 * spec joins this gate by existing. `verify` is deliberately absent: it is the optional one, and
 * condition 2 is what it answers to.
 */
export const REQUIRED_SPEC_FIELDS: readonly ('objective' | SpecListField)[] = Object.freeze([
  'objective',
  ...SPEC_LIST_FIELDS,
]);

/**
 * Per-command ceiling for THIS gate, shorter than the acceptance gate's.
 *
 * `DEFAULT_VERIFY_TIMEOUT_MS` is 180 seconds and was sized for phase 3, where the gate runs inside
 * a campaign and nobody is waiting on it. Here a HUMAN is at a prompt with nothing started, and
 * four commands at 180 seconds is twelve minutes of a dead cursor.
 *
 * It is not shortened further, and that restraint is the interesting half: a shorter clock trades
 * a hang for a FALSE TIMEOUT on a slow but honest suite, and this module's own table says a
 * timeout means nobody found out — so it would refuse a legitimate criterion for being slow. The
 * real answer to a command that never finishes is `AlignmentInput.signal`, below, not a number.
 */
export const ALIGNMENT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Ceiling on the WHOLE gate, however many commands it holds.
 *
 * The per-command number bounds one command; this bounds the wait, which is the thing the human
 * actually experiences and the thing that multiplied. Four commands cost at most this rather than
 * four times the per-command ceiling, and a spec with ten verify commands costs the same as a spec
 * with two.
 */
export const ALIGNMENT_GATE_TIMEOUT_MS = 240_000;

/** Why one command did not clear condition 2. `null` when it did. */
export type NotExecuted = 'not-executable' | 'no-result' | 'timed-out';

/** What one verification command did against the base commit. */
export interface CommandReading {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  /**
   * The command RAN and something watched it finish.
   *
   * This is condition 2, per command, and it is deliberately not the same question as `passed`.
   * A command that executed and exited 3 has told this system something true about the base tree;
   * a command that exited 127 has told it nothing at all.
   */
  executed: boolean;
  /** Why not, when `executed` is false. Null otherwise. */
  reason: NotExecuted | null;
  /** Executed AND exited 0. Never a gate condition — see the table in the header. */
  passed: boolean;
  /** The distinct lines it printed, from `outputLines`. The baseline's evidence. */
  lines: readonly string[];
}

export interface AlignmentResult {
  /** Conditions 1 and 2. The keystroke is the caller's, and it comes after this. */
  passed: boolean;
  /** True when a spec was present at all. A dispatch with no spec cannot clear condition 1. */
  hasSpec: boolean;
  /** Required fields that are missing or blank, by their human-facing label. */
  missingFields: string[];
  /** One reading per verify command, in spec order. Empty when there were none. */
  readings: readonly CommandReading[];
  /** The spec named no `verify` commands. Passes, and is reported rather than assumed. */
  noCommands: boolean;
  /** The readings as `VerifyBaseline` rows — what phase 3 compares against and the archive keeps. */
  baseline: readonly VerifyBaseline[];
  /** The commit the readings were taken against, or null when it could not be read. */
  baseCommit: string | null;
}

export interface AlignmentInput {
  /** The spec the Commander proposed. Absent is a real state and fails condition 1. */
  spec?: TechnicalSpec;
  /** The project root, at the base commit. A scout holds no tree and neither does this. */
  cwd: string;
  /** Injected so a test never spawns. Defaults to the real `runCommand` via `runVerifyBaseline`. */
  run?: CommandRunner;
  /** Per-command ceiling. Defaults to `ALIGNMENT_COMMAND_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Ceiling on the whole gate. Defaults to `ALIGNMENT_GATE_TIMEOUT_MS`. */
  budgetMs?: number;
  /**
   * The human's way out.
   *
   * Ctrl-C at the gate used to reach nothing: the loop is inside this call rather than on a read,
   * so `abortLine` had no read to unblock and the session sat until every command's deadline. The
   * gate is the one thing in this file a human can be waiting on with nothing yet at stake, so it
   * is the one thing that has to be stoppable.
   */
  signal?: AbortSignal;
  /** One line per command as it finishes. Optional; a broken sink never fails a gate. */
  onProgress?: (line: string) => void;
  /** Override the base-commit read. Test seam; production runs `git rev-parse HEAD`. */
  readBaseCommit?: (cwd: string) => Promise<string | null>;
}

/** Every required field that is missing, blank, or an empty list — by label, for a human. */
export function missingSpecFields(spec: TechnicalSpec | undefined): string[] {
  if (spec === undefined) return REQUIRED_SPEC_FIELDS.map((field) => SPEC_FIELD_LABEL[field]);
  const missing: string[] = [];
  if (typeof spec.objective !== 'string' || spec.objective.trim() === '') {
    missing.push(SPEC_FIELD_LABEL.objective);
  }
  for (const field of SPEC_LIST_FIELDS) {
    const list = spec[field];
    // An empty list is the one shape that looks like an answer and is not — the same reading
    // `validateTechnicalSpec` gives it. A blank entry is no answer either: a list of one empty
    // string would otherwise clear a gate the human is about to approve on the strength of.
    if (!Array.isArray(list) || list.length === 0) {
      missing.push(SPEC_FIELD_LABEL[field]);
      continue;
    }
    if (list.every((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      missing.push(SPEC_FIELD_LABEL[field]);
    }
  }
  return missing;
}

/**
 * Why a reading did not clear condition 2, or `null`.
 *
 * Ordered so the most specific fact wins. A command killed at the deadline reports both
 * `timedOut` and a null exit code, and "nobody found out how long it needed" is more useful than
 * "there was no exit code".
 */
export function notExecutedReason(entry: VerifyBaseline): NotExecuted | null {
  if (entry.timedOut) return 'timed-out';
  if (entry.exitCode === null) return 'no-result';
  if (SHELL_CANNOT_EXECUTE.includes(entry.exitCode)) return 'not-executable';
  return null;
}

/** The one-line account of a failure, for the screen and for the archive. One wording, one place. */
export function describeNotExecuted(reason: NotExecuted): string {
  switch (reason) {
    case 'not-executable':
      return (
        'a shell could not execute it — exit 126 is found-but-not-executable and 127 is not-found. ' +
        'That is a fact about the command rather than about the work, and it will be just as true ' +
        'after an Engineer, so this campaign could never pass its own gate.'
      );
    case 'no-result':
      return (
        'it produced no exit code at all: the command never started, or nothing watched it ' +
        'finish. Nothing was measured, so nothing has been agreed to.'
      );
    case 'timed-out':
      return (
        'it was still running at the deadline. A non-zero exit says the work is wrong; a timeout ' +
        'says nobody found out — and a criterion nobody found the result of is a criterion nobody ' +
        'has agreed to.'
      );
  }
}

async function headCommit(cwd: string): Promise<string | null> {
  try {
    const result = await runGit(['rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 5_000 });
    const value = result.stdout.trim();
    return result.code === 0 && value !== '' ? value : null;
  } catch {
    // A repository with no commits yet, no git in PATH, a tree being rebased under us. None of
    // those is a reason the gate cannot run — the commands still execute or they do not. What is
    // lost is the label on the reading, which is recorded as unknown rather than invented.
    return null;
  }
}

/**
 * Run conditions 1 and 2. Never throws.
 *
 * Never throws for the same reason `runVerifyBaseline` does not: this runs while a human is
 * waiting at a prompt, holding nothing, and a gate that can abort a conversation which has not
 * started any work yet is worse than a gate that reports a failure. Every command runs, even
 * after an earlier one fails — a partial picture costs a whole round trip through the human to
 * discover the second problem.
 */
export async function runAlignmentGate(input: AlignmentInput): Promise<AlignmentResult> {
  const missingFields = missingSpecFields(input.spec);
  const commands = input.spec?.verify ?? [];
  const base = await (input.readBaseCommit ?? headCommit)(input.cwd);

  if (commands.length === 0) {
    return {
      passed: missingFields.length === 0,
      hasSpec: input.spec !== undefined,
      missingFields,
      readings: [],
      noCommands: true,
      baseline: [],
      baseCommit: base,
    };
  }

  // ONE SIGNAL, TWO REASONS TO FIRE: the human asked, or the whole gate ran past its budget. They
  // are joined here rather than passed down separately because everything below only needs to know
  // that it is over, and a second parameter would be a second thing every runner has to honour.
  const stop = new AbortController();
  const budgetMs = input.budgetMs ?? ALIGNMENT_GATE_TIMEOUT_MS;
  const deadline = setTimeout(() => {
    stop.abort();
  }, budgetMs);
  // Unref'd so a gate that finishes early never holds the process open on a timer nobody is
  // waiting for — the same rule every other timer in this codebase follows.
  if (typeof deadline.unref === 'function') deadline.unref();
  const relay = (): void => {
    stop.abort();
  };
  input.signal?.addEventListener('abort', relay, { once: true });
  if (input.signal?.aborted === true) stop.abort();

  let baseline: readonly VerifyBaseline[];
  try {
    baseline = await runVerifyBaseline({
      commands,
      cwd: input.cwd,
      ...(input.run === undefined ? {} : { run: input.run }),
      timeoutMs: input.timeoutMs ?? ALIGNMENT_COMMAND_TIMEOUT_MS,
      signal: stop.signal,
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    });
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', relay);
  }

  const readings: CommandReading[] = baseline.map((entry) => {
    const reason = notExecutedReason(entry);
    return {
      command: entry.command,
      exitCode: entry.exitCode,
      timedOut: entry.timedOut,
      executed: reason === null,
      reason,
      passed: reason === null && entry.exitCode === 0,
      lines: entry.lines,
    };
  });

  return {
    passed: missingFields.length === 0 && readings.every((reading) => reading.executed),
    hasSpec: input.spec !== undefined,
    missingFields,
    readings,
    noCommands: false,
    baseline,
    baseCommit: base,
  };
}

/** Every command that did not execute. The gate's only executable failure mode. */
export function inexecutableCommands(result: AlignmentResult): readonly CommandReading[] {
  return result.readings.filter((reading) => !reading.executed);
}

// ---------------------------------------------------------------------------------------------
// What a human sees
// ---------------------------------------------------------------------------------------------

/**
 * The block printed under the proposed spec, before the keystroke.
 *
 * ## Why the PASSING red test is spelled out rather than left silent
 *
 * The reader is about to approve a gate that has just run three commands and watched two of them
 * fail, and the whole design rests on their understanding that this is fine. A block that showed
 * only failures would leave them to infer it; a block that showed a red cross next to a red test
 * would teach them the opposite. So every command gets a row, the glyph says whether it RAN, and
 * the text says what it did — `exit 1 at base` next to a tick, which reads oddly for exactly one
 * screenful and then reads correctly forever.
 *
 * Two columns of glyph, and they answer two different questions: the left is condition 2 (did it
 * execute), the right is the reading (what did it say). Nothing here is coloured, because the
 * conversation is not, and a gate that is the only coloured thing on the screen is a gate that
 * looks like an error.
 */
export function renderAlignment(
  result: AlignmentResult,
  charset: Charset = 'unicode',
  width = 80,
): string {
  const g = glyphsFor(charset);
  // BOTH MARKS ARE THE SAME WIDTH AND BOTH END IN A SPACE. The ascii cross was `FAIL` with no
  // trailing space where the tick was `ok  ` with two, so every failing row rendered as
  // `FAILcriteria` and `FAIL\`node --test\`` — the one word a reader is scanning for, welded to the
  // thing it is about. Equal widths are what keeps the two columns lined up when a block has one
  // of each.
  const tick = charset === 'ascii' ? 'ok   ' : '✓ ';
  const cross = charset === 'ascii' ? 'FAIL ' : '✗ ';
  const lines: string[] = [];
  /**
   * A prose row, wrapped to the terminal and indented under its own heading.
   *
   * WRAPPED, and this is not a nicety. Found by driving the real binary under a pty at 100
   * columns: every explanatory sentence in this block went out as one `write` and the terminal
   * hard-broke it mid-word at its right edge, so `may field a / t most 4` appeared on two rows.
   * `src/view/prose.ts` ended exactly that defect on the commander's side of the conversation;
   * a screen where one speaker's paragraphs wrap and this block's shatter reads as broken
   * rendering rather than as a gate.
   */
  const prose = (marker: string, text: string): void => {
    // The floor is 8, not 20, and the difference shows at 40 columns. A marker here is up to 22
    // columns wide (`    ok   spec         `), so a floor of 20 handed the text more room than the
    // terminal had left and produced 42-column rows on a 40-column window — the very overrun this
    // helper exists to prevent, in the helper itself. Eight is the same floor `paintEntry` uses in
    // `src/chat/io.ts` for the same reason: a narrow window must still leave a word somewhere to
    // go. The guarantee this makes is exact — a row fits whenever the marker leaves 8 columns.
    const room = Math.max(8, width - displayWidth(marker));
    const pad = ' '.repeat(displayWidth(marker));
    wrapPlain(text, room).forEach((row, index) => {
      lines.push(`${index === 0 ? marker : pad}${row}`);
    });
  };

  lines.push('');
  lines.push(`  ${g.ranks.CAPTAIN} alignment gate`);

  // ---- condition 1 -------------------------------------------------------------------------
  // The label is the MARKER, so a wrapped row hangs under the text column rather than under the
  // glyph. Found on a pty at 80 columns: `commands are the optional seventh` came back to column
  // four and read as a second bullet under the tick it belonged to.
  if (result.missingFields.length === 0) {
    prose(
      `    ${tick}spec         `,
      `every required field answered (${String(REQUIRED_SPEC_FIELDS.length)} of them; ` +
        'verification commands are the optional seventh)',
    );
  } else if (!result.hasSpec) {
    prose(`    ${cross}spec         `, 'this dispatch carries no spec at all');
    prose(
      `    ${' '.repeat(displayWidth(cross))}             `,
      'Six questions decide whether a cheap worker can succeed, and none of them has been asked.',
    );
  } else {
    prose(
      `    ${cross}spec         `,
      `${String(result.missingFields.length)} required field(s) unanswered: ` +
        result.missingFields.join(', '),
    );
  }

  // ---- condition 2 -------------------------------------------------------------------------
  const at = result.baseCommit === null ? 'the base tree' : result.baseCommit;
  if (result.noCommands) {
    prose(`    ${tick}criteria     `, 'none — the spec named no verification commands');
    prose(
      `    ${' '.repeat(displayWidth(tick))}             `,
      'Nothing was executed, so phase 3 has no baseline and nothing here has been mechanically ' +
        'checked. That absence is recorded rather than read as "nothing needed checking".',
    );
  } else {
    const ran = result.readings.filter((reading) => reading.executed).length;
    const total = result.readings.length;
    prose(
      `    ${ran === total ? tick : cross}criteria     `,
      `${String(ran)} of ${String(total)} executed against ${at}`,
    );
    for (const reading of result.readings) {
      const mark = reading.executed ? tick : cross;
      // WRAPPED like every prose row above it, and for exactly the same reason. This row was the
      // one exception, on the reasoning that a command is short — and a realistic `verify` entry
      // is not: measured at 127 columns on terminals of 40, 60, 80 and 100, and confirmed on a pty
      // at 60 where rows of 94 and 77 columns were hard-broken mid-flag by the terminal. A command
      // longer than the window still overruns, because `wrapPlain` breaks on spaces and will not
      // invent one inside a token; what it no longer does is overrun on a command that had spaces
      // in it all along.
      prose(`      ${mark}`, `\`${reading.command}\``);
      prose('          ', describeReading(reading));
    }
  }

  lines.push('');
  // FOLDED A LINE AT A TIME. The glyphs above are chosen from the charset, but the SENTENCES are
  // prose written once for both charsets — they carry the dashes and quotes this codebase writes
  // in, and an ascii terminal renders those as mojibake or as nothing. `asciiFold` is the repo's
  // one answer to that, so this block gets the same one rather than a second table of
  // substitutions kept in step by a test.
  //
  // `asciiFoldBlock`, NOT `asciiFold`. `\n` is `0x0A`, which is outside `0x20..0x7e` and not in
  // `FOLD`, so folding the joined block mapped every row boundary to `?` and delivered the whole
  // gate as ONE 582-column row beginning `?  o alignment gate?    ok  spec...`. Every other caller
  // of `asciiFold` in this repo hands it a single line or a single glyph, which is why the hazard
  // sat here rather than there.
  const block = `${lines.join('\n')}\n`;
  return charset === 'ascii' ? asciiFoldBlock(block) : block;
}

/** One line saying what a command did. Exported so the archive record and the screen agree. */
export function describeReading(reading: CommandReading): string {
  if (reading.reason !== null) return describeNotExecuted(reading.reason);
  if (reading.passed) {
    return (
      'exit 0 at base — already green before any work. It is a real check and it will not be the ' +
      'one that proves the feature.'
    );
  }
  return (
    `exit ${String(reading.exitCode)} at base — a red criterion, which is the normal starting ` +
    'point. The reading is recorded, so phase 3 can tell a test that was already failing from one ' +
    'the work broke.'
  );
}

/**
 * Why the gate refused, as the sentences a human acts on. Empty when it passed.
 *
 * Separate from `renderAlignment` because the two are read at different moments and only one of
 * them is a decision: the block above is what a reader scans while the gate runs, and this is
 * what is said after it has refused and nothing is going to be dispatched.
 */
export function alignmentRefusals(result: AlignmentResult): string[] {
  const out: string[] = [];
  if (result.missingFields.length > 0) {
    out.push(
      result.hasSpec
        ? `the spec leaves ${result.missingFields.join(', ')} unanswered. Phase 2 begins on a full ` +
          'spec or it does not begin.'
        : 'this dispatch carries no spec. The six questions have not been asked, so there is ' +
          'nothing for phase 2 to be aligned with.',
    );
  }
  for (const reading of inexecutableCommands(result)) {
    out.push(`\`${reading.command}\` did not execute against the base commit: ${describeReading(reading)}`);
  }
  return out;
}
