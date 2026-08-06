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
