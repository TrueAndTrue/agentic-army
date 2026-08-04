/**
 * How a value survives being pasted into a shell.
 *
 * ## Why this is its own module
 *
 * There were two implementations of this: `quoteArg` in `src/setup/fixes.ts`, which is correct,
 * and `quoteIfNeeded` in `src/setup/checks.ts`, which wrapped in DOUBLE quotes. Inside double
 * quotes POSIX still expands `$`, still runs a backtick, and still eats a backslash — so a path
 * containing any of those produced a `fix` line that runs something other than what it reads as,
 * and `mkdirFix` shipped that inside a command doctor invites the user to paste. This module
 * exists so there is one answer to the question, not two that agree on the easy cases.
 *
 * ## Why HERE, and not in `src/config/paths.ts`
 *
 * `paths.ts` is the obvious leaf — it is at the bottom of the import graph, both callers already
 * import it, and it is where this repo collapsed its duplicate path helpers. It is still the
 * wrong home, for three reasons:
 *
 *   1. Quoting is a fact about a SHELL, not about a filesystem. `paths.ts` answers "where does
 *      the config live" and "are these two strings the same directory" — questions whose answers
 *      depend on `realpath`, case-folding and the disk. Nothing here touches the disk, and the
 *      win32 branch below is about `cmd.exe`'s parser, not about Windows paths.
 *   2. Most of what goes through here is not a path. `src/command/campaign.ts` quotes a campaign
 *      id and a free-text OBJECTIVE with it. Putting that in a module named `paths` would make
 *      the module name a claim about its contents that its contents do not honour — the same
 *      class of defect this change exists to remove.
 *   3. `src/config/**` sits below `src/setup/**` and is deliberately kept ignorant of the CLI
 *      layer (see the note above `armyHome`). Rendering a command for a human to paste is a
 *      presentation concern of that layer; pushing it down into config inverts the layering to
 *      save one file.
 *
 * So: a new leaf, and a genuinely leaf one — it imports nothing at all, from anywhere, which is
 * what lets `checks.ts` reach it without the cycle that blocked importing `quoteArg` upward out
 * of `fixes.ts` (`fixes.ts` imports `invokedAs` from `checks.ts`).
 *
 * There is no second copy. `fixes.ts` re-exports this binding so its existing importers keep
 * working, and `checks.ts` imports it directly.
 */

/**
 * Characters that need no quoting in any POSIX shell and none in `cmd.exe` either.
 *
 * Conservative on purpose: everything outside this set gets quoted, so the cost of being wrong is
 * a pair of quotes nobody needed rather than a command that does something else.
 */
const BARE_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a value for the shell the reader is standing in.
 *
 * Left bare when it needs no quoting, because the overwhelmingly common case is a tidy absolute
 * path and `git -C /home/me/repo commit …` is what a person would type. POSIX gets SINGLE quotes
 * when it does need them: `"` interpolates `$`, backticks and `\`, so a path containing any of
 * those inside double quotes is a command that runs something other than what it reads as. Inside
 * single quotes nothing at all is special, and the one character that cannot appear — `'` itself —
 * is closed, escaped and reopened.
 */
export function quoteArg(value: string, platform: NodeJS.Platform = process.platform): string {
  if (value === '') return platform === 'win32' ? '""' : "''";
  if (BARE_SAFE.test(value)) return value;
  if (platform === 'win32') return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
