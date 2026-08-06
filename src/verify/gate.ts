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
  VerifyOutcome,
} from '../contracts/verify.ts';
import { DEFAULT_VERIFY_TIMEOUT_MS } from '../contracts/verify.ts';
import { runCommand } from './exec.ts';

/** The tail is where the failure is — see `output` below. */
const OUTPUT_TAIL_MAX_CHARS = 2000;

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
