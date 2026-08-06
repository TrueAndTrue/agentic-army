/**
 * The trial contract — a controlled experiment on one worker, held still.
 *
 * A campaign asks "did the work get done". A trial asks a narrower and much harder question:
 * **what does reasoning effort actually buy, given a brief?** Same model, same orders, same seed
 * repository, N workspaces, one variable. Everything else is pinned so the difference that shows
 * up in the table is the difference we changed.
 *
 * ## Three measurements, and none of them is the worker's opinion
 *
 *   DID IT DO THE JOB       `kind: 'job'` checks — a command that exits 0, a file that exists.
 *   DID IT FOLLOW ORDERS    `kind: 'compliance'` checks — what changed on disk, what tools ran.
 *   HOW FAST                wall clock, measured by the trial, not reported by the harness.
 *
 * Every one of them is evaluated against ARTIFACTS: the git state of the workspace and the
 * recorded event stream. Nothing here reads the worker's `Report`. That is not squeamishness
 * about honesty — an Engineer that believes it finished and did not is the single most common
 * failure this repo has seen, and a benchmark scored from self-reports measures how confidently
 * a model writes a summary. `Report` is a fine transport and a terrible scoreboard.
 *
 * ## The vacuity rule
 *
 * A `job` check that already passes on the untouched seed measures nothing — the work was done
 * before the worker started, and every arm scores full marks forever. `TrialResult.vacuous`
 * carries the ids of any such check and the runner REFUSES to spawn a single arm when it is
 * non-empty. It is this repo's oldest rule applied to a benchmark: a test that has never been
 * seen to fail is not evidence, so the acceptance check has to be red on the seed before anyone
 * is paid for turning it green.
 *
 * Compliance checks are exempt from that gate, because passing on an untouched seed is their
 * correct behaviour — nothing was touched, so nothing was violated. Their falsifiability is
 * proven in the unit tests instead, where each check type has a red case built from a synthetic
 * violating evidence record.
 */

import type { ReasoningEffort, SoldierEvent, SoldierStatus } from './harness.ts';
import type { CommandRunner } from './verify.ts';

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/**
 * Which column a check scores into.
 *
 * The split is the user-facing question, not an implementation detail: "it built the thing but
 * ignored half the constraints" and "it obeyed every constraint and built nothing" are opposite
 * failures, and a single pass rate averages them into a number that describes neither. A worker
 * that scores 3/3 job and 0/2 compliance is a worker you cannot delegate to unsupervised, and
 * that has to be legible at a glance.
 */
export const CHECK_KINDS = ['job', 'compliance'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export interface CheckBase {
  /** Stable, unique within a trial. Names the row in the report and the failure line. */
  id: string;
  kind: CheckKind;
  /** One line, shown beside a failure. What the check is FOR, not what it does. */
  why?: string;
}

/**
 * Run a command in the arm's workspace and compare the exit code.
 *
 * The only check that executes anything, and therefore the only one that needs a process
 * runner injected. The command runs with the workspace as cwd and inherits the trial's
 * environment; it is the trial author's own command, not the worker's, so it is trusted the
 * same way a `package.json` script is.
 */
export interface CommandCheck extends CheckBase {
  type: 'command';
  run: string;
  /** Defaults to 0. */
  expectExit?: number;
  /** Per-command ceiling. Defaults to `DEFAULT_CHECK_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Constrain WHICH files the run touched, relative to the seed commit.
 *
 * `allow` is a whitelist: any changed path outside it fails the check. `require` is the other
 * direction — paths that must appear. Both are repo-relative POSIX globs, matched by
 * `matchGlob` so that `src/**` and `*.test.ts` behave the way a reader expects.
 *
 * An empty `allow` array means "nothing may change", which is a legitimate and useful check.
 * An ABSENT `allow` means the check does not constrain the whitelist direction at all. The two
 * are different and the parser must not conflate them.
 */
export interface FilesChangedCheck extends CheckBase {
  type: 'files-changed';
  allow?: readonly string[];
  require?: readonly string[];
}

/**
 * Assert a file's content. `contains` is a plain substring; `absent` asserts the FILE does not
 * exist. Exactly one of `contains` / `absent` is meaningful, and supplying neither is a spec
 * error rather than a check that trivially passes.
 */
export interface FileContentCheck extends CheckBase {
  type: 'file-content';
  /** Workspace-relative path. */
  path: string;
  contains?: string;
  absent?: boolean;
}

/**
 * Assert the worker never reached for a particular tool, optionally only when its input matched.
 *
 * Evaluated over the recorded `tool_use` events at EVERY depth, including native subagents — a
 * constraint the parent obeyed and delegated its way around is a constraint that was broken.
 * `matching` is a case-insensitive substring test against the JSON-serialised tool input, which
 * is deliberately crude: it is a benchmark assertion, not a permission boundary. The permission
 * boundary is `spec.deny`, it is enforced by the harness, and it is a different mechanism with
 * a different failure mode.
 */
export interface NoToolUseCheck extends CheckBase {
  type: 'no-tool-use';
  /** Tool name as it appears on the event, e.g. `Bash`, `WebFetch`. */
  tool: string;
  matching?: string;
}

/**
 * Assert the work was committed and the tree left clean.
 *
 * The most-failed compliance check in practice, and the reason it is its own type rather than a
 * `command` running `git status`: an uncommitted file in a leased worktree is a destroyed file,
 * so "did it commit" is a question about whether the work survives at all, not a tidiness
 * preference.
 */
export interface CommittedCheck extends CheckBase {
  type: 'committed';
  /** Require HEAD to have moved off the seed commit. Defaults to true. */
  requireNewCommit?: boolean;
  /** Require no uncommitted changes. Defaults to true. */
  requireClean?: boolean;
}

export type Check =
  | CommandCheck
  | FilesChangedCheck
  | FileContentCheck
  | NoToolUseCheck
  | CommittedCheck;

export const CHECK_TYPES = [
  'command',
  'files-changed',
  'file-content',
  'no-tool-use',
  'committed',
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------------------------
// Evidence — everything a check may look at, and nothing else
// ---------------------------------------------------------------------------------------------

/**
 * The artifacts of one arm's run.
 *
 * Deliberately a closed record rather than a handle to the live world: a check receives this and
 * a process runner, and there is no third channel. That is what makes the scoring reproducible
 * off a saved trial — the same evidence replayed gives the same verdict, so a disputed result can
 * be re-scored without re-spending the run.
 */
export interface ArmEvidence {
  /** Absolute path of this arm's workspace. */
  workspace: string;
  /** The commit every arm was handed. Identical across arms by construction. */
  baseCommit: string;
  /** HEAD after the run. Null when the repository could not be read at all. */
  headCommit: string | null;
  /**
   * Repo-relative POSIX paths that differ from `baseCommit`, INCLUDING untracked files.
   *
   * Untracked matters more than it sounds: an arm that writes `notes.md` and never adds it has
   * changed the workspace, and a files-changed whitelist that ignored untracked files would
   * score that as clean.
   */
  changedFiles: readonly string[];
  /** Uncommitted modifications present in the working tree. */
  dirty: boolean;
  /** The full normalised event stream, in order. */
  events: readonly SoldierEvent[];
}

export interface CheckResult {
  id: string;
  kind: CheckKind;
  type: CheckType;
  passed: boolean;
  /**
   * The concrete reason, naming the evidence: `changed 3 files outside the whitelist:
   * package.json, .gitignore, notes.md`. Empty string when the check passed.
   *
   * A failure line that says "files-changed failed" costs a human the whole investigation, and
   * this is a tool whose output is read once and thrown away — if it does not say what happened
   * on the line where it happened, nobody goes and looks.
   */
  detail: string;
}

/**
 * Run a command for a `CommandCheck`. Injected so the pure checks need no child processes.
 *
 * An alias, not a second declaration that happens to match `CommandRunner` (`./verify.ts`): the
 * trial's `CommandCheck`s and the campaign's acceptance gate (`src/verify/gate.ts`) both need "run
 * this command, report exit/stdout/stderr/timedOut", and a shape restated in two files drifts the
 * moment one of them gains a field the other doesn't. `CommandResult` there is structurally this
 * type today, so the alias costs nothing and removes a place the two could disagree.
 */
export type CheckExec = CommandRunner;

// ---------------------------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------------------------

/**
 * One cell of the experiment: a brief crossed with an effort level, in its own directory.
 *
 * `ordersLabel` exists so the cross-product is legible. The headline experiment is one brief
 * across five efforts, but the question underneath it — does a COMPLETE brief let a cheap
 * reasoning level do the job a thin brief needs an expensive one for — needs two briefs across
 * the same five efforts, and a report that cannot name which brief produced a row cannot answer
 * it.
 */
export interface TrialArm {
  /** Unique, filesystem-safe, and the workspace's directory name: `xhigh-complete`. */
  id: string;
  effort: ReasoningEffort;
  model: string;
  /** The brief, verbatim, exactly as the worker receives it. */
  orders: string;
  /** Names the brief this arm was given, for grouping in the report. */
  ordersLabel: string;
}

export const TRIAL_MODES = ['serial', 'concurrent'] as const;

/**
 * Whether arms run one at a time or all at once.
 *
 * NOT cosmetic, and the report stamps it. Concurrent is the default and is the FAIRER
 * comparison despite sounding sloppier: five arms contending for the same machine and the same
 * upstream at the same moment share their contention symmetrically, whereas five serial runs
 * happen at five different times of day against a service whose latency moves. What concurrency
 * costs is comparability with a serial run recorded elsewhere — hence the stamp, and hence the
 * rule that a reader must never put a serial number and a concurrent number in the same column.
 */
export type TrialMode = (typeof TRIAL_MODES)[number];

export interface TrialSpec {
  title: string;
  /** Absolute path of the seed repository copied into every arm. */
  seed: string;
  arms: readonly TrialArm[];
  checks: readonly Check[];
  mode: TrialMode;
  /** Absolute path of the directory the arm workspaces and the result are written under. */
  outDir: string;
  /**
   * Per-arm wall-clock ceiling, in ms. Absent means the adapter's own default.
   *
   * That default (`DEFAULTS.closeGraceMs` in `src/harness/claude.ts`) is 300_000 — five minutes
   * after `runSoldier` closes stdin before the adapter escalates to SIGTERM — and for a campaign
   * soldier that is a reasonable backstop. A trial is a different animal: it is explicitly for
   * tasks that may take five to fifteen minutes, so that same constant is a silent hard ceiling on
   * every arm, and an arm that is still working correctly at 300.2s is killed exactly as dead as
   * one that hung.
   *
   * The distinction that matters is CENSORED versus FAILED. An arm that hit this ceiling produced
   * no result because the clock ran out, not because the work was wrong — a `status: 'timeout'` row
   * sitting next to nine rows of real pass/fail data. A reader who averages it in with the rest has
   * measured the ceiling, not the worker, and the report has to say so out loud rather than let a
   * zero look like the same kind of zero as an arm that tried and got it wrong.
   */
  armTimeoutMs?: number;
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/**
 * What one arm cost, in the four currencies that matter.
 *
 * `wallMs` is measured by the trial around the spawn, and it is the one the user asked for.
 * `harnessDurationMs` is what the vendor reported and is kept beside it rather than instead of
 * it: when the two disagree by more than a rounding error, the gap is process startup, schema
 * loading and stream drain — real time the user waits and the vendor does not bill.
 */
export interface ArmMetrics {
  wallMs: number;
  harnessDurationMs: number | null;
  costUsd: number | null;
  /** Assistant turns — how many times the model came back to speak. */
  turns: number;
  /** `tool_use` events at every depth. The cheapest proxy for "how much did it flail". */
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ArmResult {
  arm: TrialArm;
  /**
   * The effort string the CLI actually received, after the adapter's mapping.
   *
   * Recorded because the mapping is lossy and hiding that would fabricate a result: claude has
   * no `minimal`, so `src/harness/claude.ts` maps it up to `low`, and the `minimal` and `low`
   * arms are then byte-identical invocations. A table showing them as two data points, with two
   * different timings, invites a reader to conclude something about a distinction that was never
   * sent. Print what was sent.
   */
  effectiveEffort: string;
  workspace: string;
  status: SoldierStatus | 'spawn-failed';
  metrics: ArmMetrics;
  checks: readonly CheckResult[];
  /** Adapter errors and check-runner failures. Non-empty does not by itself mean failure. */
  errors: readonly string[];
}

export interface TrialResult {
  title: string;
  mode: TrialMode;
  startedAt: string;
  finishedAt: string;
  seed: string;
  baseCommit: string;
  outDir: string;
  arms: readonly ArmResult[];
  /**
   * Ids of `job` checks that passed against the UNTOUCHED seed.
   *
   * Non-empty means the trial refused to run and `arms` is empty. See the vacuity rule at the
   * top of this file — this field is the evidence for the refusal, not a warning attached to a
   * result that ran anyway.
   */
  vacuous: readonly string[];
  /**
   * Echo of `TrialSpec.armTimeoutMs`, carried here so `renderTrialResult` can name the ceiling in
   * seconds next to a timed-out arm without threading the spec itself through to render time.
   */
  armTimeoutMs?: number;
}

/** `passed / total` for one kind, over a finished arm. */
export function scoreOf(
  result: ArmResult,
  kind: CheckKind,
): { passed: number; total: number } {
  const of = result.checks.filter((check) => check.kind === kind);
  return { passed: of.filter((check) => check.passed).length, total: of.length };
}
