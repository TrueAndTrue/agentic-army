/**
 * Worktree isolation.
 *
 * Only Engineers need a worktree; Scouts and Sentries are read-only against the primary
 * checkout and the Inspector attaches read-only to the Engineer's worktree (it must, to run
 * the tests there). That cuts worktree demand ~4x.
 *
 * treehouse is the strong default, but it sits behind this seam so it is not a hard dependency:
 * a cold-worktree fallback (`git worktree add` into a temp dir) implements the same interface.
 */

export const WORKTREE_PROVIDER_IDS = ['treehouse', 'cold'] as const;
export type WorktreeProviderId = (typeof WORKTREE_PROVIDER_IDS)[number];

/**
 * A held worktree. Maps 1:1 onto treehouse's
 * `treehouse get --lease --lease-holder <holder> --json` → `{path, lease_id, lease_holder, leased_at}`.
 *
 * `leaseId` is the ABA guard: `treehouse return --force --if-lease-id <id> <path>` refuses to
 * release a worktree that has since been re-acquired by someone else. A crash-recovering
 * supervisor MUST pass it, never a bare path.
 */
export interface Lease {
  /** Absolute path to the worktree root. Arrives at DETACHED HEAD — see `ARMY_BRANCH_PREFIX`. */
  path: string;
  /** Opaque token proving this holder still owns `path`. Required for a conditional return. */
  leaseId: string;
  /** The agent id that holds it, e.g. `cpt-03`. */
  leaseHolder: string;
  /** ISO-8601 acquisition time. */
  leasedAt: string;
  /** Which provider minted it — a lease is only releasable by its own provider. */
  provider: WorktreeProviderId;
}

/**
 * The isolation seam.
 *
 * TWO CONSEQUENCES OF THE TREEHOUSE MODEL, both load-bearing:
 *
 * 1. **Worktrees hand out at DETACHED HEAD.** `acquire` does not put you on a branch. The
 *    Engineer must cut `army/<task-id>` itself as its first act inside the tree
 *    (see `armyBranch`), or its commits are unreachable the moment the lease is returned.
 *
 * 2. **`release` does `reset --hard` + `clean -fdx`.** Returning a lease DESTROYS every
 *    uncommitted and untracked file in the tree. The caller must therefore be **fail-closed**:
 *    never return a lease while it holds unlanded work. Durability first (the branch reaches a
 *    real git ref, remote or army mirror), release second. If durability cannot be established,
 *    hold the lease and escalate; leaking a worktree is recoverable, destroying a night's work
 *    is not.
 */
export interface WorktreeProvider {
  readonly id: WorktreeProviderId;

  /**
   * Lease a worktree of `repoRoot` for `holder` (an agent id).
   * Resolves to a tree at detached HEAD, dependencies already warm via treehouse's
   * `post_create` hook (which runs after provision *and* after reset).
   */
  acquire(holder: string, repoRoot: string): Promise<Lease>;

  /**
   * Return the lease. Conditional on `lease.leaseId` — a stale lease is a no-op, not a
   * destructive release of someone else's tree.
   *
   * DESTRUCTIVE: resets and cleans the tree. See the fail-closed rule above.
   *
   * @param opts.force forward `--force`; still `--if-lease-id`-guarded. Use when the holder
   *        process is gone and its work is already durable.
   */
  release(lease: Lease, opts?: { force?: boolean }): Promise<void>;

  /** Probe — e.g. is the `treehouse` binary on PATH and a compatible version. */
  isAvailable(): Promise<boolean>;
}

/** Every branch the army cuts is namespaced, so a human can always `git branch -d 'army/*'`. */
export const ARMY_BRANCH_PREFIX = 'army/';

/**
 * The branch an Engineer must cut for a task, since the worktree arrives detached.
 * `armyBranch('take-hill-4') === 'army/take-hill-4'`.
 */
export function armyBranch(taskId: string): string {
  return `${ARMY_BRANCH_PREFIX}${taskId}`;
}
