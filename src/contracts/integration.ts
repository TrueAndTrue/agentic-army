/**
 * Integration: the seam between deciding a merge and performing one.
 *
 * ## Why this is a contract and not a function in the overseer
 *
 * A `MAJ·OVERSEER` decides WHICH workstream integrates and WHEN. It never performs the merge, and
 * it holds no shell to perform one with (`ROLE_ALLOW.OVERSEER` is `Read`, `Grep`, `Glob`,
 * `TodoWrite`). The supervising process performs it, which is the same rule the rung 3 merge
 * already runs under: the merge is done by the process the human launched, never by a worker, at
 * any rank. This file is the shape of that instruction crossing from the party that decides to
 * the party that acts.
 *
 * ## The one property this seam owns
 *
 * **`merge` never resolves a conflict.** It reports one, with the files it could not reconcile,
 * and stops. Nothing in this module guesses at whose version of a function is right.
 *
 * That is not caution for its own sake. A conflict between two workstreams is two engineers who
 * both believed they owned a file, and the reconciliation is a change to the code that somebody
 * has to be accountable for. Resolving it here would produce a merge commit authored by the
 * supervisor, reviewed by nobody, in a tree no inspector was ever pointed at. So a `conflict`
 * outcome becomes a reconciliation WORKSTREAM: a fresh engineer, in its own worktree, briefed
 * with both branches and the conflicted files, whose output reaches the integrated branch and is
 * reviewed there, by the acceptance gate and the one inspector that judge every workstream's
 * work, alongside all of it. No inspector stands in a reconciliation tree, and none stands in any
 * other workstream's either. The expensive path is deliberate, because the cheap one produces a
 * merge commit authored by the supervisor that no review ever sees at all.
 *
 * A conflict whose resolution is a design decision rather than a mechanical merge is a question,
 * and climbs to the human on the ladder that already exists.
 */

/** What one merge attempt did. */
export type MergeOutcome =
  /** A commit was made. `commit` is the merge commit's sha. */
  | { kind: 'merged'; commit: string }
  /**
   * Nothing to do: the branch's tip is already an ancestor of the integration branch. A distinct
   * outcome from `merged` rather than a special case of it, because "we merged it" and "it was
   * already in" answer different questions when a campaign is reconstructed from the archive.
   */
  | { kind: 'already-current' }
  /**
   * Git could not reconcile the two sides. The tree is left CLEAN: the failed merge is aborted
   * before this is returned, so the integration branch is exactly where it was and the next
   * workstream in the order can still be attempted.
   */
  | {
      kind: 'conflict';
      /** Repository-relative paths, sorted, as git reported them. */
      files: readonly string[];
      /** The integration branch's tip at the moment of the attempt. */
      ours: string;
      /** The workstream branch's tip at the moment of the attempt. */
      theirs: string;
    };

/**
 * What `release` actually did.
 *
 * Deliberately not a boolean. "It did not come back" and "it was never ours to give back" are
 * different facts about the pool, and a caller writing a disposition into an audit log needs the
 * difference: the first is a tree still held, the second is a slot that belongs to someone else
 * and must not be reported as a path this campaign returned.
 *
 * NAMED FOR ITS TREE, and not `ReleaseOutcome`, because `src/contracts/worktree.ts` already exports
 * that name for the pool's own four-state string union. Both are re-exported through
 * `src/contracts/index.ts`, and two different types under one name there is a barrel that does not
 * compile, and, if it were resolved by picking a winner, a barrel whose consumers silently get
 * the other module's type.
 */
export type IntegrationReleaseOutcome =
  /** The tree went back to the pool. `path` is the tree that was returned. */
  | { kind: 'released'; path: string }
  /** Already released. A second call is not an error and is not a second return. */
  | { kind: 'already-released' }
  /**
   * The pool refused, or the lease was not ours. `reason` is for a human reading an audit log,
   * so it names what was refused rather than restating that something failed.
   */
  | { kind: 'not-held'; reason: string };

/**
 * One integration worktree, held for the length of a campaign.
 *
 * Obtained from the worktree provider like any other lease, and settled the same way. The
 * campaign's existing `settleLease` discipline applies: every exit path releases it or
 * deliberately retains it and says why, so "we do not know what happened to the integration tree"
 * stays unreachable.
 */
export interface IntegrationTree {
  /** Absolute path of the worktree. */
  readonly path: string;
  /** The branch workstreams are integrated onto. */
  readonly branch: string;

  /**
   * Merge one workstream branch onto the integration branch.
   *
   * Never resolves a conflict, never leaves the tree dirty, and never rewrites history. Safe to
   * call again for the same branch: a second call on an already-merged branch reports
   * `already-current` rather than making an empty commit.
   */
  merge(branch: string): Promise<MergeOutcome>;

  /**
   * Release the worktree, and SAY WHETHER IT CAME BACK.
   *
   * Idempotent, and safe to call after a failed merge. Durability is the caller's business and
   * runs BEFORE this, exactly as it does for an engineer's lease: a released tree is reset and
   * cleaned, so work that exists only inside one is one release away from gone.
   *
   * ## Why this returns a value, stated so nobody types it back to `void`
   *
   * It returned `Promise<void>` in the first draft of this file, and that single choice put a
   * hole in the campaign's second-hardest property. A release can fail to happen for reasons the
   * caller did not cause: the lease record is gone, or another holder has taken the slot since.
   * With no return value the implementation had nowhere to put that, so it swallowed it, and the
   * campaign wrote `state: 'released'` on the strength of the call not throwing. In the stale
   * case the path it then reported as returned belonged to somebody else's holder.
   *
   * That is the same defect `LeaseDisposition`'s `not-held` state was added to fix on the
   * engineer's side, reintroduced here by a type. "We do not know what happened to the worktree"
   * has to stay unreachable for THIS tree too, and a `void` return makes it reachable by
   * omission.
   */
  release(): Promise<IntegrationReleaseOutcome>;
}
