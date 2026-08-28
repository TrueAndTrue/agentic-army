/**
 * Running a command in a workspace and reporting what happened.
 *
 * One shape, two callers. The trial harness has scored `CommandCheck`s this way since it was
 * written; the campaign now needs the same thing to run a spec's acceptance commands before an
 * Inspector is spent on the branch. Two process runners kept in step by a test is worse than one,
 * so the type lives here — below both — and `CheckExec` in `src/contracts/trial.ts` is an alias
 * for it rather than a second declaration that happens to match today.
 *
 * `exitCode` is nullable because a process killed by a signal has none, and `timedOut` is separate
 * from a non-zero exit for the same reason a timeout is not a test failure: one says the work is
 * wrong, the other says nobody found out.
 */

export interface CommandResult {
  /** Null when the process was signalled rather than exiting on its own. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the runner killed it at the deadline. Distinct from a non-zero exit. */
  timedOut: boolean;
}

/**
 * Run `command` with `cwd` as the working directory, killed after `timeoutMs`.
 *
 * Injected everywhere it is used, so the pure layers above never spawn a process in a unit test.
 */
export type CommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<CommandResult>;

/** Default ceiling for one acceptance command. A build plus a suite fits inside this. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 180_000;

/**
 * Exit codes a POSIX shell reserves for "I could not run that at all".
 *
 * 126 is found-but-not-executable, 127 is not-found. Neither is a check result — a command that
 * exits 126 or 127 has said nothing about the work it was supposed to be checking. Kept here
 * rather than in the gate because the baseline reader and the gate both have to agree on it.
 */
export const SHELL_CANNOT_EXECUTE: readonly number[] = [126, 127];

/**
 * What a verify command did BEFORE the work it exists to check.
 *
 * ## Why a campaign takes this reading at all
 *
 * A spec's `verify` commands define done. A command that cannot pass — because it is malformed,
 * or names a tool that is not installed, or was mangled on its way into the spec — therefore
 * defines a done that can never be reached, and the campaign spends every attempt it has
 * discovering that. Measured in the field: one campaign ran three Engineers for 37.6 minutes and
 * $8.86, two of which SUCCEEDED, and delivered nothing, because
 * `sh -c 'grep -q \"\\\"dependencies\\\": {}\" package.json'` exits 2 against any file on earth.
 *
 * Reading each command against the untouched base tree costs seconds and turns that into a fact
 * available before the first Engineer is spawned: this command already fails, here is its output.
 *
 * ## What it is NOT
 *
 * Not a classifier, and not a licence to skip anything. A command failing at base is usually
 * CORRECT — `node --test` should fail before the feature exists. The reading is only ever compared
 * against the same command's result after the work, and the comparison reports a fact ("identical
 * before and after") rather than a judgement about whose fault it is.
 */
export interface VerifyBaseline {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  /**
   * The distinct lines this command printed, deduplicated and capped.
   *
   * A SET rather than a blob, because the useful relation is containment: the baseline runs
   * against a tree where the work does not exist, so a broken command legitimately says MORE at
   * base than it does afterwards. See `saysNothingNew` in `src/verify/gate.ts`.
   */
  lines: readonly string[];
}

/** What one acceptance command did. */
export interface VerifyOutcome {
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /**
   * The tail of the command's output, for the failure line and the retry brief.
   *
   * Capped, and stderr preferred over stdout when both are present: the retry Engineer needs to
   * know WHAT failed, and an untruncated test log would crowd out the orders it is attached to.
   */
  output: string;
  /**
   * This command failed IDENTICALLY before the Engineer existed.
   *
   * Not "the spec is wrong" — this module does not get to decide that. It is the narrower,
   * checkable statement that the command produced the same exit code and the same output against
   * the untouched base tree, and therefore did not distinguish the work from its absence. A gate
   * made of such commands cannot be made to pass by doing the work, so retrying is spending money
   * on a foregone conclusion.
   *
   * `false` when no baseline was taken. Absence of evidence is never evidence here.
   */
  unchangedFromBaseline: boolean;
}

/**
 * The acceptance gate's result.
 *
 * `ran: false` is a real and important state, not an absence. A spec that carried no `verify`
 * commands has not been mechanically checked at all, and a campaign that quietly reported the
 * same shape as a passing gate would be claiming a check it never performed. Every consumer has
 * to be able to tell "nothing to run" from "everything ran and passed".
 */
export interface AcceptanceResult {
  ran: boolean;
  passed: boolean;
  outcomes: readonly VerifyOutcome[];
}
