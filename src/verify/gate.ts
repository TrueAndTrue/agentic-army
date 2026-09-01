/**
 * The acceptance gate — running a spec's `TechnicalSpec.verify` commands before an Inspector is
 * spent on the branch.
 *
 * This exists because of the incident documented on `TechnicalSpec.verify`
 * (`src/contracts/spec.ts`): a commander wrote a criterion into prose, the Engineer satisfied a
 * different reading of it, and the Inspector — which never ran the command, only read the diff —
 * passed the branch. Nothing in the system had ever executed the criterion. This module is the
 * thing that does, mechanically, before an Inspector's time is spent on a branch that would have
 * failed it.
 */

import type {
  AcceptanceResult,
  CommandRunner,
  VerifyBaseline,
  VerifyOutcome,
} from '../contracts/verify.ts';
import { DEFAULT_VERIFY_TIMEOUT_MS, SHELL_CANNOT_EXECUTE } from '../contracts/verify.ts';
import { sanitize } from '../view/progress.ts';
import { runCommand } from './exec.ts';

/** The tail is where the failure is — see `output` below. */
const OUTPUT_TAIL_MAX_CHARS = 2000;

/**
 * How many distinct output lines form a command's baseline reading.
 *
 * Capped so a command that complains once per file cannot make the comparison depend on how many
 * files happened to be present. Deduplicated for the same reason.
 */
const SIGNATURE_MAX_LINES = 40;

export interface AcceptanceGateInput {
  /** The spec's `verify` commands. Absent or empty means there is no gate to run. */
  commands?: readonly string[];
  /** The Engineer's worktree. Commands run with this as cwd. */
  cwd: string;
  /** Injected so tests never spawn. Defaults to `runCommand`. */
  run?: CommandRunner;
  /** Per-command ceiling. Defaults to DEFAULT_VERIFY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** One line per command, as it starts and as it finishes. Optional. */
  onProgress?: (line: string) => void;
  /**
   * What each command did against the untouched base tree, from `runVerifyBaseline`.
   *
   * Optional, and absence is never treated as agreement: a command with no baseline gets
   * `unchangedFromBaseline: false`, which is the reading that keeps every existing caller's
   * behaviour exactly as it was.
   */
  baseline?: readonly VerifyBaseline[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeProgress(onProgress: ((line: string) => void) | undefined, line: string): void {
  if (onProgress === undefined) return;
  try {
    onProgress(line);
  } catch {
    // A broken progress sink must never kill a run.
  }
}

/**
 * Prefer stderr when it carries anything — that is where a failing command says what went
 * wrong — and fall back to stdout otherwise. Capped at `OUTPUT_TAIL_MAX_CHARS`, keeping the LAST
 * characters rather than the first: a build log's useful line is at the bottom, and truncating
 * from the front would cut exactly the part a retry Engineer needs. Newlines are preserved
 * because this text is dropped into a markdown fenced block, not a table cell.
 */
function tailOutput(stdout: string, stderr: string): string {
  const raw = stderr.trim() !== '' ? stderr : stdout;
  const trimmed = raw.trim();
  if (trimmed.length <= OUTPUT_TAIL_MAX_CHARS) return trimmed;
  return `…${trimmed.slice(trimmed.length - OUTPUT_TAIL_MAX_CHARS)}`;
}

/**
 * What a command said, as a set of distinct lines two runs can be compared on.
 *
 * ## The whole difficulty is false EQUALITY, not false difference
 *
 * The comparison this feeds decides whether to tell a human their SPEC is broken instead of
 * telling an Engineer its BRANCH is. Getting that backwards blames the wrong thing on the one
 * screen where a person is deciding what to fix, so every judgement call here is made in the
 * direction of failing to notice rather than accusing wrongly.
 *
 * Two earlier shapes failed that test by matching too eagerly, and both were caught by the tests
 * beside this:
 *
 *   - The exit code alone. `node --test` exits 1 because no tests exist yet and exits 1 because
 *     an assertion failed. Completely different events, identical key.
 *   - The first two lines with digits masked. `tests 0 | fail 0` and `tests 9 | fail 1` both
 *     become `tests # | fail #`, which is the same collision wearing a disguise — and the counts
 *     were the entire content.
 *
 * A third failed the other way, by matching too strictly — see `saysNothingNew`, which is where
 * the comparison actually lives. Lines rather than a single blob because the useful relation
 * turned out to be containment, not equality.
 */
export function outputLines(stdout: string, stderr: string): string[] {
  const raw = stderr.trim() !== '' ? stderr : stdout;
  const seen = new Set(
    raw
      .split('\n')
      // NEUTRALISED AT CAPTURE, and this is the capture. These lines are UNTRUSTED PROCESS OUTPUT
      // — a test runner's ANSI colour, a compiler quoting a source file somebody else wrote — and
      // they do not stop at a comparison: `VerifyBaseline.lines` is written into `spec.json` in
      // the campaign archive and, when `planning.spec_to_repo` is on, into the repository, where a
      // human reads it with `cat`. `JSON.stringify` escapes C0 and leaves U+009B and U+202E, so
      // the file is not what makes them safe.
      //
      // It also makes the comparison steadier rather than weaker: `saysNothingNew` asks whether a
      // run said anything the baseline had not, and two runs whose only difference is a colour
      // sequence were saying the same thing all along.
      .map((line) => sanitize(line))
      .filter((line) => line !== ''),
  );
  // Deduplicated and capped. A command that prints the same complaint per file would otherwise
  // make the set size depend on how many files happened to be there.
  return [...seen].slice(0, SIGNATURE_MAX_LINES);
}

/**
 * Did this run say anything the baseline had not already said?
 *
 * SUBSET, not equality, and that asymmetry is the whole correction. Byte-identical output was the
 * obvious rule and it does not survive contact: the baseline runs against a tree where the work
 * does not exist yet, so a broken command legitimately says MORE at base than it does afterwards.
 * The field case is exactly that —
 *
 *     base : grep: {}": No such file or directory
 *            grep: package.json: No such file or directory      <- the file is not there yet
 *     after: grep: {}": No such file or directory
 *
 * — identical in the part that matters and different in the part that does not, so equality
 * reported "changed" for the one command this exists to catch.
 *
 * Subset keeps the safe direction. A genuine failure introduces a line the baseline never had
 * (`not ok 3 - crawl finds every heading`), so it is never a subset and is never blamed on the
 * spec. Saying strictly LESS than a tree with no work in it, while still failing the same way, is
 * the shape of a command that was never reading the work.
 */
export function saysNothingNew(before: readonly string[], after: readonly string[]): boolean {
  const seen = new Set(before);
  return after.every((line) => seen.has(line));
}

export interface VerifyBaselineInput {
  commands?: readonly string[];
  /** The leased worktree, at base — BEFORE any Engineer has touched it. */
  cwd: string;
  run?: CommandRunner;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
  /**
   * Stop, and stop the command that is running.
   *
   * The alignment gate runs this while a human waits at a prompt with nothing started, so it needs
   * a way out that is not the clock — four commands that never finish used to hold that human for
   * twelve minutes with no keystroke that reached anything. Every command still gets a ROW: an
   * abandoned one reports no exit code, which the gate already reads as "it has said nothing about
   * the work". Silence about a command that was never run would be the worse answer.
   */
  signal?: AbortSignal;
}

/**
 * Read what every verify command does against the untouched base tree.
 *
 * Run once per campaign, after the worktree is leased and before the first Engineer is dispatched.
 * Costs one pass over the commands; buys the ability to say, later, that a command failed the
 * same way before anybody did any work — and to say it in the seconds after a human approves a
 * dispatch rather than twenty-seven minutes into it.
 *
 * Never throws, for the same reason the gate does not: this is diagnostic, and a diagnostic that
 * can abort a campaign which has not started yet is worse than no diagnostic. A runner that throws
 * becomes a baseline entry whose line set records the throw.
 */
export async function runVerifyBaseline(input: VerifyBaselineInput): Promise<VerifyBaseline[]> {
  const commands = input.commands;
  if (commands === undefined || commands.length === 0) return [];

  const run = input.run ?? runCommand;
  const timeoutMs = input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

  const baseline: VerifyBaseline[] = [];
  for (const command of commands) {
    // Checked BEFORE each command as well as inside the runner: an abort that lands between two
    // commands must not start the next one, and a runner that ignores the signal (every injected
    // one in the tests does) still stops here.
    if (input.signal?.aborted === true) {
      baseline.push({
        command,
        exitCode: null,
        timedOut: false,
        lines: ['not run: the gate was stopped before this command started'],
      });
      continue;
    }
    try {
      const result = await run(command, input.cwd, timeoutMs, input.signal);
      baseline.push({
        command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        lines: outputLines(result.stdout, result.stderr),
      });
      safeProgress(
        input.onProgress,
        `baseline: \`${command}\` exited ${String(result.exitCode)} against the base tree`,
      );
    } catch (error) {
      baseline.push({
        command,
        exitCode: null,
        timedOut: false,
        lines: outputLines('', errorMessage(error)),
      });
    }
  }
  return baseline;
}

/**
 * Commands that could never have said anything about the work.
 *
 * Two ways in, and both are facts rather than judgements: the command exited 126/127 at base, so a
 * shell could not run it at all; or it failed at base and then failed IDENTICALLY afterwards, so
 * whatever it measures, it is not the difference the Engineer made.
 *
 * A command that PASSED after failing at base is the normal, healthy case and never appears here.
 */
export function unrunnableCommands(result: AcceptanceResult): readonly VerifyOutcome[] {
  return result.outcomes.filter((outcome) => outcome.unchangedFromBaseline);
}

/**
 * Run every command in `input.commands`, in order, and report whether the branch earned an
 * Inspector.
 *
 * No commands: return `{ ran: false, passed: false, outcomes: [] }` without spawning anything.
 * `passed` is `false` here, not `true` — a gate that never ran has verified nothing, and a caller
 * that reads `passed` in isolation (skipping the `ran` check) must never be told the work was
 * mechanically confirmed when it was never checked at all.
 *
 * Every command runs, even after an earlier one fails: this does NOT short-circuit. A campaign
 * that stops at the first failure hands back a partial picture, and the second failure — the one
 * that would have surfaced only after the first was fixed — costs a whole extra retry cycle to
 * discover. Running the full list once is what a single retry brief needs.
 */
export async function runAcceptanceGate(input: AcceptanceGateInput): Promise<AcceptanceResult> {
  const commands = input.commands;
  if (commands === undefined || commands.length === 0) {
    return { ran: false, passed: false, outcomes: [] };
  }

  const run = input.run ?? runCommand;
  const timeoutMs = input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

  // Keyed by command text, which is what `spec.verify` is a list of. A spec naming the same
  // command twice gets one baseline for both — they are the same command and cannot disagree.
  const baseline = new Map<string, VerifyBaseline>();
  for (const entry of input.baseline ?? []) baseline.set(entry.command, entry);

  /**
   * Did this command say the same thing before anybody did the work?
   *
   * Only ever consulted for a FAILING command. A command that passes has plainly distinguished
   * the work from its absence, whatever it did at base, and asking the question of it would be a
   * way to talk a passing check into looking suspicious.
   */
  const wasAlreadyFailing = (
    command: string,
    exitCode: number | null,
    lines: readonly string[],
  ): boolean => {
    const before = baseline.get(command);
    if (before === undefined) return false;
    // A shell that could not execute the command at base says so with 126/127, and no amount of
    // engineering changes that — the line comparison would usually catch it too, but naming the
    // codes makes the reason legible in a report.
    if (before.exitCode !== null && SHELL_CANNOT_EXECUTE.includes(before.exitCode)) return true;
    return before.exitCode === exitCode && saysNothingNew(before.lines, lines);
  };

  const outcomes: VerifyOutcome[] = [];
  for (const command of commands) {
    safeProgress(input.onProgress, `verify: starting \`${command}\``);
    try {
      const result = await run(command, input.cwd, timeoutMs);
      const passed = result.exitCode === 0 && !result.timedOut;
      outcomes.push({
        command,
        passed,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        output: tailOutput(result.stdout, result.stderr),
        unchangedFromBaseline:
          !passed &&
          wasAlreadyFailing(
            command,
            result.exitCode,
            outputLines(result.stdout, result.stderr),
          ),
      });
      safeProgress(input.onProgress, `verify: finished \`${command}\` — ${passed ? 'passed' : 'failed'}`);
    } catch (error) {
      // The injected runner throwing takes down a campaign that has already paid for an
      // Engineer, unless it is caught here and turned into an ordinary failed outcome.
      outcomes.push({
        command,
        passed: false,
        exitCode: null,
        timedOut: false,
        output: errorMessage(error),
        unchangedFromBaseline: wasAlreadyFailing(
          command,
          null,
          outputLines('', errorMessage(error)),
        ),
      });
      safeProgress(input.onProgress, `verify: finished \`${command}\` — failed (${errorMessage(error)})`);
    }
  }

  return {
    ran: true,
    passed: outcomes.every((outcome) => outcome.passed),
    outcomes,
  };
}

/**
 * The markdown block a retry Engineer reads.
 *
 * THE ONLY RENDERER for this shape — the campaign and the orders module both call this rather
 * than each formatting `AcceptanceResult` their own way, for the same reason `renderTechnicalSpec`
 * is the only spec renderer: two renderers kept in step by a test is worse than one.
 *
 * Empty string when there is nothing to say: a passed gate needs no remediation text, and a gate
 * that never ran (`!ran`) has no failures to list — that state is reported elsewhere, not here.
 */
export function renderAcceptanceFailure(result: AcceptanceResult): string {
  if (result.passed || !result.ran) return '';

  const failed = result.outcomes.filter((outcome) => !outcome.passed);
  const passed = result.outcomes.filter((outcome) => outcome.passed);

  const lines: string[] = ['## ACCEPTANCE FAILED', ''];
  for (const outcome of failed) {
    const exit = outcome.exitCode === null ? 'killed' : String(outcome.exitCode);
    lines.push(`### \`${outcome.command}\``);
    lines.push('');
    lines.push(`- exit code: ${exit}`);
    lines.push(`- timed out: ${String(outcome.timedOut)}`);
    lines.push('');
    lines.push('```');
    lines.push(outcome.output);
    lines.push('```');
    lines.push('');
  }
  if (passed.length > 0) {
    lines.push(`Passed (${String(passed.length)}): ${passed.map((outcome) => `\`${outcome.command}\``).join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
