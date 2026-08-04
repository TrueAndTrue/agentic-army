/**
 * `fix:` — the actionable half of a blocking outcome, shared by every command that owes one.
 *
 * ===========================================================================================
 * WHY THIS IS A MODULE AND NOT THREE STRINGS
 * ===========================================================================================
 *
 * `checks.ts` states the contract for `army doctor`:
 *
 *     ok        -> nothing
 *     degraded  -> what capability is lost
 *     blocking  -> the exact command that fixes it
 *
 * `doctor` and `enlist` honour it. `campaign` did not: it told a user that a repository with no
 * commits could not be leased, explained *why* in one sentence and *what to do* in none — and the
 * command that resolves it is a single line. That is the same defect three times over, so the
 * vocabulary lives in one place rather than being re-spelled at each site.
 *
 * ===========================================================================================
 * THE THIRD OUTCOME — `none` — AND WHY IT HAD TO EXIST
 * ===========================================================================================
 *
 * `CheckResult.fix` is a bare `string | undefined`, which offers exactly two states: a fix, or
 * silence. That shape is what let `mkdir -p "<file>"` ship — a fix that satisfied every "does it
 * have a fix" assertion and failed with `File exists` the moment anyone typed it.
 *
 * A supervisor has a case doctor does not: conditions with genuinely no command behind them. An
 * Inspector process that segfaulted is not an environment problem; nothing on this machine is
 * broken and there is nothing to install. Offering `army doctor` there would be inventing a fix,
 * and **a fix line that does not fix is worse than none** — the reader runs it, it reports
 * everything green, and now they doubt the diagnosis instead of the model.
 *
 * So there are three kinds, and the difference between them is a promise to the reader:
 *
 *   `command`  Paste it. Running it verbatim REMOVES the condition. Tests are expected to run
 *              these through a shell and re-check — a fix nobody has ever run is a promise
 *              nobody has kept.
 *   `manual`   A concrete action a human takes, which is not reducible to one command — because
 *              it needs a value only the human has (an `origin` URL), or a terminal, or a
 *              judgement call.
 *   `none`     Nothing here removes the condition. Says what IS known instead — usually where
 *              the evidence is. Never dressed up as a command.
 *
 * The rule for choosing: if you cannot picture a test that runs it and watches the condition
 * clear, it is not a `command`.
 */

import { invokedAs } from './checks.ts';
import { quoteArg } from './shell.ts';

// ---------------------------------------------------------------------------
// The type
// ---------------------------------------------------------------------------

export type Fix =
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'manual'; readonly instruction: string }
  | { readonly kind: 'none'; readonly because: string };

export const FIX_KINDS = ['command', 'manual', 'none'] as const;

/** Paste-and-run. Only for something that genuinely resolves the condition when executed. */
export function runThis(command: string): Fix {
  return { kind: 'command', command };
}

/** A concrete action that is not one command — needs a value, a terminal, or a decision. */
export function doThis(instruction: string): Fix {
  return { kind: 'manual', instruction };
}

/** Nothing resolves this from here. Say so, and say what is known. */
export function noFix(because: string): Fix {
  return { kind: 'none', because };
}

/**
 * One line, one spelling, everywhere. Callers own the indent; this owns the label — so a reader
 * who has learned what `fix:` means in `doctor` reads the same word in `campaign`.
 */
export function renderFix(fix: Fix): string {
  switch (fix.kind) {
    case 'command':
      return `fix: ${fix.command}`;
    case 'manual':
      return `fix: ${fix.instruction}`;
    case 'none':
      return `no fix: ${fix.because}`;
  }
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * Why `command` is not something a reader could actually paste, or null if it is fine.
 *
 * Exported rather than living in a test file because BOTH suites need it and two copies of a
 * regex is exactly the drift one implementation exists to prevent. It is a static screen only — it
 * cannot tell you a well-formed command resolves anything, which is what running it is for.
 */
export function unrunnableReason(command: string): string | null {
  if (command.trim() === '') return 'empty';
  if (/^\s*(Upgrade|Install|Run|Try|Please|You|First|Then|Make|Add|Ask)\b/i.test(command)) {
    return `prose, not a command: ${command}`;
  }
  if (/^\s*--/.test(command)) return `bare flag, not a command: ${command}`;
  return null;
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/**
 * `quoteArg` lives in `./shell.ts` now and is re-exported, not reimplemented.
 *
 * It moved because `src/setup/checks.ts` needed it and could not have it: `checks.ts` had its own
 * double-quoting `quoteIfNeeded`, which is wrong on `$`, backticks and `\`, and it could not
 * import the correct one from here because this module imports `invokedAs` from `checks.ts` — a
 * cycle. A leaf that imports nothing breaks the tie; see the header of `./shell.ts` for why that
 * leaf is a new one rather than `src/config/paths.ts`.
 *
 * Re-exported rather than moved-and-updated-everywhere so the callers outside this directory keep
 * the import they already have. It is one binding with two names to reach it, not two copies.
 */
export { quoteArg } from './shell.ts';

// ---------------------------------------------------------------------------
// The shared conditions
// ---------------------------------------------------------------------------

/**
 * "Does this repository have a commit yet?", spelled once.
 *
 * `enlist` asks it through `checks.probe` and `campaign` asks it through `delivery/git.runGit`;
 * they keep their own git seams, but they must not keep their own idea of the question. Exits
 * non-zero with no output on a repository that has never committed.
 */
export function headExistsArgs(repo: string): string[] {
  return ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD'];
}

/**
 * What a repository with no commits costs you, in the words of the thing that refuses.
 *
 * `enlist` prints it as a warning (registering a repo you are about to populate is legitimate,
 * so it must not block) and `campaign` prints it as the reason it aborted. Same fact, same
 * sentence, one definition.
 */
export const NO_COMMITS_IMPACT =
  'a campaign cannot lease a worktree until there is at least one commit — a leased tree is ' +
  'handed out at detached HEAD, and there is nothing to detach to.';

/** Give an empty repository the one commit a lease needs. Runnable; resolves the condition. */
export function initialCommitCommand(
  repo: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `git -C ${quoteArg(repo, platform)} commit --allow-empty -m init`;
}

export function initialCommitFix(repo: string, platform?: NodeJS.Platform): Fix {
  return runThis(initialCommitCommand(repo, platform));
}

/**
 * Turn a directory into a repository a campaign can actually fight in — repo AND first commit.
 *
 * Deliberately both halves. `git init` alone is what `enlist` suggests, and it is right there
 * because `enlist` is happy with an empty repository; suggesting only `git init` to someone whose
 * campaign just refused would walk them straight into the next refusal, which is the exact
 * ninety-second experience this module exists to end.
 */
export function initRepoFix(dir: string, platform?: NodeJS.Platform): Fix {
  const q = quoteArg(dir, platform);
  return runThis(`git -C ${q} init && git -C ${q} commit --allow-empty -m init`);
}

/**
 * Hand the reader over to `doctor`.
 *
 * Legitimate ONLY for a failure whose shape says "this machine", where doctor's own contract then
 * owes the exact command. It is not a catch-all: routing a model crash here would be inventing a
 * fix. Routed through `invokedAs()` so the suggestion is a command the reader can actually run.
 */
export function doctorFix(): Fix {
  return runThis(`${invokedAs()} doctor`);
}
