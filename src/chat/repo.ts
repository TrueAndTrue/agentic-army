/**
 * Where the human is standing — the repository state behind the status bar.
 *
 * ## Why this is separate from `src/delivery/git.ts`
 *
 * That module answers questions the delivery ladder is allowed to act on, and its helpers throw:
 * `isClean` calls `git`, which raises `CommandError` on a non-zero exit, because a ladder that
 * cannot read the working copy must refuse to deliver rather than guess. This module answers the
 * same questions for a *decoration*, and has the opposite obligation — **nothing here may ever
 * throw, and nothing here may ever block a session.** A missing `git`, a repository being
 * rebased under us, an NFS mount that has gone away: each of those is a reason for a segment of
 * the status bar to read `unknown`, and none of them is a reason a conversation does not start.
 *
 * So every probe is individually guarded and individually timed out, `null` means "could not be
 * read" everywhere, and the whole read is one `Promise.all` of independent probes rather than a
 * sequence that a single slow answer can stall.
 *
 * ## Why it is read more than once
 *
 * A dispatch commits, branches and sometimes pushes. A branch name captured at session start is
 * a lie for the rest of the session — which is the specific way a status bar becomes worse than
 * no status bar, because a stale fact is read with the same confidence as a fresh one. The caller
 * re-reads after every dispatch; `readRepoState` is cheap enough (five short git invocations,
 * concurrent) that it could be read far more often than that.
 */

import { REPO_UNKNOWN, type RepoState } from '../view/chrome.ts';
import { currentBranch, porcelainStatus, runGit } from '../delivery/git.ts';

export type { RepoState } from '../view/chrome.ts';

/**
 * How long any one probe may take before the status bar simply says it does not know.
 *
 * Short on purpose, and much shorter than `git.ts`'s 120s default: this runs while a human is
 * waiting to type, and a `git status` on a huge repository with a cold cache is a real thing.
 * The answer to a slow probe is a dimmer status bar, never a slower prompt.
 */
export const REPO_PROBE_TIMEOUT_MS = 3_000;

export interface ReadRepoOptions {
  timeoutMs?: number;
}

/** Run one probe, swallowing absolutely everything. `null` on any failure at all. */
async function probe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    // Including `MissingBinaryError` — a machine without git in PATH gets a status bar without a
    // branch on it, which is exactly right and is not news the session has to deliver.
    return null;
  }
}

/**
 * Everything the chrome knows about the working copy. Never rejects.
 *
 * `dir` is the project root, not the process's cwd: a session started from a subdirectory is
 * still a session about the repository, and the two disagree about `git status --porcelain`
 * because that command reports relative to where it was run.
 */
export async function readRepoState(dir: string, options: ReadRepoOptions = {}): Promise<RepoState> {
  const timeoutMs = options.timeoutMs ?? REPO_PROBE_TIMEOUT_MS;
  const opts = { cwd: dir, timeoutMs };

  const [branch, head, dirty, upstream] = await Promise.all([
    probe(() => currentBranch(dir)),
    probe(async () => {
      const result = await runGit(['rev-parse', '--short', 'HEAD'], opts);
      return result.code === 0 ? result.stdout.trim() : null;
    }),
    probe(async () => {
      const status = await porcelainStatus(dir);
      // `''` splits to `['']`, which would count an empty working copy as one dirty path.
      return status === '' ? 0 : status.split('\n').filter((line) => line.trim() !== '').length;
    }),
    probe(async () => {
      // Probed BEFORE counting, because `rev-list @{upstream}..HEAD` on a branch with no upstream
      // exits non-zero and `commitsAhead` reports that as 0 — so a branch that has never been
      // pushed would render identically to one that is perfectly in sync, which is the opposite
      // of what the reader needs to know.
      const result = await runGit(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        opts,
      );
      return result.code === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null;
    }),
  ]);

  // One invocation for both numbers. `--left-right --count` on a symmetric difference prints
  // `<behind>\t<ahead>` — left is what the upstream has and we do not.
  const divergence =
    upstream === null
      ? null
      : await probe(async () => {
          const result = await runGit(
            ['rev-list', '--left-right', '--count', `${upstream}...HEAD`],
            opts,
          );
          if (result.code !== 0) return null;
          const [behind, ahead] = result.stdout.trim().split(/\s+/u).map((n) => Number.parseInt(n, 10));
          if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
          return { behind: behind as number, ahead: ahead as number };
        });

  return {
    ...REPO_UNKNOWN,
    branch,
    head,
    dirty,
    ahead: divergence?.ahead ?? null,
    behind: divergence?.behind ?? null,
  };
}
