/**
 * Worktree isolation.
 *
 * ONE LEASE PER CAMPAIGN, HELD BY TWO WORKERS. `src/command/campaign.ts` calls `acquire` exactly
 * once and hands the SAME `lease.path` to the Engineer's spawn and to the Inspector's — one
 * writable tree, one `leaseId`, no second acquisition anywhere in the tree. The Inspector's tree
 * is not attenuated and could not be: it runs the suite there, and a suite writes — caches,
 * coverage, build output, the mutations mutation testing needs.
 *
 * What keeps the Inspector off the branch is its LOADOUT, not the filesystem. `ROLE_ALLOW` gives
 * an INSPECTOR no Edit, no Write and no NotebookEdit (`src/command/permissions.ts`), so the
 * independence of the review gate is a property of the permission set on the command line rather
 * than of the tree the worker is standing in. Do not go looking for a mount flag that enforces
 * it; there is not one, and a comment claiming otherwise would send the next reader hunting.
 *
 * Scouts and Sentries, when something spawns one, work against the primary checkout and lease
 * nothing. Nothing in the current slice spawns either of those two
 * (`src/command/permissions.ts` says so where their allow-lists are defined), so that half is the
 * rule the seam is built to, not a description of traffic it carries today.
 *
 * ONE PROVIDER IMPLEMENTS THIS TODAY: the pooled git-worktree provider in `src/worktree/cold.ts`.
 * The seam is not vestigial — it is why replacing the original external tool was a swap rather
 * than a rewrite, and the next thing that wants to own worktrees (a devcontainer, a remote
 * builder, a copy-on-write snapshot on APFS or btrfs) arrives through the same door.
 */

/**
 * Provider ids.
 *
 * `'treehouse'` is RETIRED and nothing implements it. It stays a member on purpose, and the
 * reason is worth stating because "an id nobody implements" otherwise reads as an oversight:
 * `--provider` accepts these tokens from a command line, and `selectWorktreeProvider` answers a
 * request for `treehouse` with a `provider-retired` note explaining that pooling, warm reuse and
 * `post_create` are in-house now. Delete the member and that request stops being a recognised
 * name with an explanation and becomes an unrecognised token with a usage error. Keeping it is
 * what lets the retirement be SAID.
 *
 * `'cold'` is the pooled provider, and the name is a fossil: it named a provider that destroyed
 * every tree on release, and the provider now reuses trees WARM with their dependency directories
 * intact. The token is not renamed because it is an input — it is what `--provider` accepts and
 * what `Lease.provider` carries on every live lease — and a better adjective is not worth
 * invalidating a shipped flag. What the name cannot carry, this comment does.
 */
export const WORKTREE_PROVIDER_IDS = ['treehouse', 'cold'] as const;
export type WorktreeProviderId = (typeof WORKTREE_PROVIDER_IDS)[number];

/**
 * A held worktree.
 *
 * `leaseId` is the ABA guard: a conditional return refuses to release a worktree that has since
 * been re-acquired by someone else. A crash-recovering supervisor MUST pass it, never a bare path.
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
 * How a release ended. Exactly one of these is true of every `release` call that did not throw.
 *
 * Only `released` did anything. The other three are the no-op cases, and they are DISTINCT
 * because a caller recovering from a crash acts differently on each:
 *
 *   `released`     the tree was returned. This holder no longer has it and no longer owes it.
 *   `stale-lease`  the slot has been re-leased since this lease was minted, so releasing would
 *                  have destroyed SOMEBODY ELSE's tree. Refused. The path in the lease now
 *                  belongs to another holder and must not be reported as this one's.
 *   `no-record`    no lease record for that path: already returned, or it belongs to a different
 *                  managed root. Nothing to do, and nothing was done.
 *   `missing-tree` the record was there and the tree was not. The record is cleared; nothing was
 *                  destroyed because there was nothing left to destroy.
 */
export const RELEASE_OUTCOMES = ['released', 'stale-lease', 'no-record', 'missing-tree'] as const;
export type ReleaseOutcome = (typeof RELEASE_OUTCOMES)[number];

/**
 * What `release` reports.
 *
 * It used to report `void`, which collapsed all four outcomes above into "it did not throw" —
 * and the only caller in this tree acted on exactly that, so a stale lease and a lease that
 * genuinely came back were both narrated to the operator as `worktree released`. That is the
 * worst of the four to get wrong: it names a path that now belongs to another holder.
 *
 * Minimal on purpose. A provider that learns more on the way out returns a WIDER object — the
 * pooled provider adds whether the tree was kept warm, which dependency directories survived and
 * what `pre_destroy` did — and a caller typed against this interface is unaffected.
 */
export interface ReleaseResult {
  outcome: ReleaseOutcome;
  /**
   * True only for `released`. False for every no-op outcome, where nothing was destroyed.
   *
   * Derivable from `outcome`, and carried anyway: the one question most callers have is "is the
   * tree mine to stop worrying about", and a boolean they cannot get subtly wrong is worth more
   * than the byte it costs.
   */
  released: boolean;
  /** Why, in a sentence fit to show an operator. Names the other holder when there is one. */
  message: string;
}

/**
 * The isolation seam.
 *
 * TWO CONSEQUENCES, both load-bearing:
 *
 * 1. **Worktrees hand out at DETACHED HEAD.** `acquire` does not put you on a branch. The
 *    Engineer must cut `army/<task-id>` itself as its first act inside the tree
 *    (see `armyBranch`), or its commits are unreachable the moment the lease is returned.
 *
 * 2. **`release` is DESTRUCTIVE to uncommitted work.** Returning a lease resets the tree to the
 *    commit it was handed out at and cleans it. A provider may keep regenerable dependency
 *    directories — the pooled one does, and that warm reuse is the point of pooling — but no
 *    caller may rely on ANY file surviving a release. The caller must therefore be
 *    **fail-closed**: never return a lease while it holds unlanded work. Durability first (the
 *    branch reaches a real git ref, remote or army mirror), release second. If durability cannot
 *    be established, hold the lease and escalate; leaking a worktree is recoverable, destroying a
 *    night's work is not.
 */
export interface WorktreeProvider {
  readonly id: WorktreeProviderId;

  /**
   * Lease a worktree of `repoRoot` for `holder` (an agent id).
   * Resolves to a tree at detached HEAD, dependencies already warm where the provider can manage
   * it, with its `post_create` hook run on EVERY acquire — the one that provisions a tree and
   * the ones that hand back a warm one alike.
   */
  acquire(holder: string, repoRoot: string): Promise<Lease>;

  /**
   * Return the lease, and say which of the four things happened.
   *
   * Conditional on `lease.leaseId` — a stale lease is a no-op, not a destructive release of
   * someone else's tree — so the ABA case is a RESULT, not an exception: it is an ordinary thing
   * for a crash-recovering supervisor to hit, and ordinary outcomes are returned, not thrown.
   *
   * Throwing is reserved for "the caller must decide something": a tree holding work no durable
   * ref can reach, or a lease handed to the wrong provider.
   *
   * DESTRUCTIVE on the `released` path. See the fail-closed rule above.
   *
   * @param opts.force skip the unlanded-work gate. The LEASE-ID guard is not skipped — force
   *        buys past "this tree holds work", never past "this tree is not yours", so a stale
   *        lease is still a no-op under it. Use when the holder process is gone and its work is
   *        already durable.
   */
  release(lease: Lease, opts?: { force?: boolean }): Promise<ReleaseResult>;

  /** Probe — e.g. is everything this provider shells out to present and a compatible version. */
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
