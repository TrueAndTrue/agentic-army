/**
 * The integration worktree: one tree per campaign, one merge per accepted workstream.
 *
 * `src/contracts/integration.ts` states the property this file implements and it is the only
 * property worth reading twice: **a merge never resolves a conflict.** Everything below exists to
 * make that survivable rather than merely true, because "we refuse to resolve it" is only useful
 * if the refusal leaves the campaign able to carry on. So a conflicted attempt is ABORTED before
 * `conflict` is returned, verified restored, and the next workstream in the overseer's order is
 * attempted against an integration branch that is byte for byte where it was.
 *
 * ## Where the integration branch is cut from, and what it costs
 *
 * FROM THE CAMPAIGN'S BASE COMMIT, never from the project's current head. `base` is a required
 * option with no default for exactly that reason: a caller that cannot name the commit its
 * campaign was planned against does not have a campaign, and defaulting to `HEAD` would make the
 * choice silently and differently on every run.
 *
 * The case that decides it is the human who commits to `main` while a campaign is running. Every
 * workstream branch was cut from the campaign base, so an integration branch cut from the moved
 * head turns the FIRST merge into a three-way merge against the human's unrelated commits. A
 * collision there is reported as a conflict of that workstream, which brands one engineer with a
 * collision it had no part in and sends a reconciliation workstream after the wrong two branches.
 * Cutting from the base also keeps the campaign reproducible: the sequence of outcomes is a
 * function of the campaign's own inputs, so an archive that says "workstream 3 conflicted" means
 * the same thing tomorrow.
 *
 * THE CONSEQUENCE, stated rather than discovered: the integration branch can finish a campaign
 * BEHIND the project. It is not a merge into the project and this module never performs one.
 * Landing it is a later, separate act, and that is where a collision with the human's own commits
 * surfaces: once, against the campaign's whole output, attributable to no single workstream.
 *
 * ## Why every merge makes a commit
 *
 * `--no-ff`, always. Git offers three shapes for a successful merge (already an ancestor, a
 * fast-forward, a real merge commit) and this file collapses the last two on purpose:
 *
 *  - `MergeOutcome.merged` carries a `commit`, and a fast-forward makes none. The field would
 *    have to carry the workstream's own tip instead, so one field would mean "the commit that
 *    integrated this" on one path and "the commit that was integrated" on the other.
 *  - With a merge commit per workstream, "which commit integrated workstream N" and "back
 *    workstream N out" are both answered by a first-parent walk. Under fast-forwards the first
 *    workstream to integrate is indistinguishable from the base history.
 *
 * The first shape is NOT collapsed, because the contract names it: an ancestor tip is detected
 * before git is asked to merge anything, which is also what keeps a second merge of an
 * already-merged branch from making an empty commit.
 *
 * ## Concurrency: what is guaranteed, and by what
 *
 * WITHIN THIS PROCESS, calls are SERIALISED, not rejected. `merge` and `release` queue behind
 * each other on one chain, so two workstreams that finish in the same tick integrate one after
 * the other. Rejecting the second would push a queue into every caller, and workstreams finishing
 * at once is the normal case rather than a caller bug.
 *
 * ACROSS PROCESSES, exclusion is git's and it is real: a branch may be checked out in exactly one
 * worktree, so a second supervisor that opens the same integration branch is refused by
 * `git checkout` at open time and told so. That is enforcement rather than convention, which is
 * why there is no lock file here; a second lock would only be a second thing to leak.
 *
 * ## What this file does not do
 *
 * It does not push, and it does not make the integration branch durable. The branch lives in the
 * repository's common ref store and therefore outlives the tree, but a local branch is not a
 * durable ref by this project's definition (`DURABLE_REF_PATTERNS`), so `release` is refused by
 * the pool's fail-closed gate until the caller has run durability over it. That refusal is the
 * design working: it is the same rule an engineer's lease lives under.
 */

import { resolve } from 'node:path';

import type {
  IntegrationReleaseOutcome,
  IntegrationTree,
  MergeOutcome,
} from '../contracts/integration.ts';
import type { Lease, WorktreeProvider } from '../contracts/worktree.ts';
import { ARMY_BRANCH_PREFIX } from '../contracts/worktree.ts';
import { currentBranch, repoToplevel, revParse, runGit } from '../delivery/git.ts';
import type { ExecResult } from '../delivery/git.ts';

export class IntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationError';
  }
}

/**
 * `army/integration-<campaign-id>`.
 *
 * FLAT, with a hyphen rather than a slash, for the reason `durableRef` flattens too: git cannot
 * hold `army/integration` and `army/integration/x` as refs at the same time, and a campaign whose
 * id happens to match a task id would then make one of the two uncreatable. The remaining
 * collision is a task literally named `integration-<campaign-id>`, which is a name no task
 * generator produces and which `openIntegrationTree` would refuse anyway, because the branch would
 * not contain the campaign base.
 */
export function integrationBranch(campaignId: string): string {
  return `${ARMY_BRANCH_PREFIX}integration-${campaignId}`;
}

export interface OpenIntegrationTreeOptions {
  /**
   * The pool. INJECTED rather than constructed here: the campaign already chose one through
   * `selectWorktreeProvider`, and a second provider built in this file would mean a second managed
   * root and a second `max_trees` cap that nothing reconciles with the first.
   */
  provider: WorktreeProvider;
  /** The agent id that owns the tree. This is what a doctor's lease listing prints. */
  holder: string;
  /** The primary checkout. Any path inside the repository; the pool resolves the top level. */
  project: string;
  /** The branch workstreams are integrated onto. See `integrationBranch` for the naming. */
  branch: string;
  /**
   * The commit the campaign was planned against, and the commit the integration branch is cut
   * from. Required, and deliberately not defaulted to `HEAD`; see the header.
   */
  base: string;
  /**
   * Overlaid on `process.env` for every git invocation this module makes. The provider sanitises
   * and carries its own copy for the calls it makes; this is the same overlay for the calls made
   * here, so a hermetic caller is hermetic all the way down rather than only as far as the pool.
   */
  env?: Record<string, string | undefined>;
}

/**
 * `IntegrationTree`, plus what leasing learned.
 *
 * The same structural widening `PooledLease` is: a caller typed against the contract sees `path`,
 * `branch`, `merge` and `release`, and a supervisor that wants to know whether `post_create`
 * failed in this particular tree narrows to this.
 *
 * `release` REPORTS what it did. It used to return `void` because the contract said so, and the
 * knowledge existed here all along: `#released` was set from `ReleaseResult.released` and read by
 * nothing, so the campaign wrote `state: 'released'` on the strength of the call not throwing and
 * printed a path that, for a stale lease, belongs to another holder. The pool's four outcomes are
 * folded into the contract's three: `released` is the one that returned a tree, and `stale-lease`,
 * `no-record` and `missing-tree` are all `not-held`, carrying the provider's own sentence about
 * which one happened and who holds the tree now.
 */
export class PooledIntegrationTree implements IntegrationTree {
  readonly path: string;
  readonly branch: string;
  /** The campaign base the branch was cut from. Every merge is a descendant of it. */
  readonly base: string;
  readonly lease: Lease;

  readonly #provider: WorktreeProvider;
  readonly #env: Record<string, string | undefined> | undefined;
  /** One chain for `merge` and `release` alike. See the concurrency note in the header. */
  #queue: Promise<unknown> = Promise.resolve();
  #released = false;

  constructor(input: {
    provider: WorktreeProvider;
    lease: Lease;
    branch: string;
    base: string;
    env?: Record<string, string | undefined>;
  }) {
    this.#provider = input.provider;
    this.lease = input.lease;
    this.path = input.lease.path;
    this.branch = input.branch;
    this.base = input.base;
    this.#env = input.env;
  }

  /** True once the lease has actually come back. A refused or failed release leaves it false. */
  get released(): boolean {
    return this.#released;
  }

  merge(branch: string): Promise<MergeOutcome> {
    return this.#serial(() => this.#merge(branch));
  }

  release(): Promise<IntegrationReleaseOutcome> {
    return this.#serial<IntegrationReleaseOutcome>(async () => {
      // Idempotent, and the second call says so rather than claiming a second return. A caller
      // that released and then released again has not freed two trees.
      if (this.#released) return { kind: 'already-released' };
      const result = await this.#provider.release(this.lease);
      this.#released = result.released;
      if (result.released) return { kind: 'released', path: this.path };
      // The provider distinguishes `stale-lease`, `no-record` and `missing-tree`. What a reader
      // DOES about all three is identical (nothing: the tree is not this holder's to give back)
      // and the difference between them is a sentence, which the provider already wrote.
      return { kind: 'not-held', reason: result.message };
    });
  }

  /**
   * Run `fn` after everything already queued, whether that finished or threw. A failed merge must
   * not wedge the chain: the tree is restored by then, and the next workstream is exactly the
   * thing the campaign still wants to try.
   */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #merge(branch: string): Promise<MergeOutcome> {
    if (this.#released) {
      throw new IntegrationError(
        `the integration tree at ${this.path} has been released, so \`${branch}\` cannot be ` +
          'merged onto it. A released tree is reset and cleaned; the branch it was holding still ' +
          'exists as a ref, but nothing is standing in it.',
      );
    }

    // The branch has to be a LOCAL BRANCH, resolved through `refs/heads/`. A bare name would let
    // a tag, a remote-tracking ref or an abbreviated sha through, and "we merged what you named"
    // is not the same promise as "we merged that workstream's branch".
    const theirs = await revParse(this.path, `refs/heads/${branch}`);
    if (theirs === null) {
      throw new IntegrationError(
        `there is no branch \`${branch}\` in ${this.path}. A workstream that never cut a branch ` +
          'has nothing to integrate, and that is a fact about the workstream rather than a merge ' +
          'outcome, so it is raised here instead of being reported as one.',
      );
    }

    const on = await currentBranch(this.path);
    if (on !== this.branch) {
      throw new IntegrationError(
        `${this.path} is on ${on === null ? 'a detached HEAD' : `\`${on}\``}, not the integration ` +
          `branch \`${this.branch}\`. Something moved this tree out from under the campaign; ` +
          'merging from here would land the work somewhere nobody is reading.',
      );
    }
    const ours = await revParse(this.path, 'HEAD');
    if (ours === null) {
      throw new IntegrationError(`HEAD does not resolve in ${this.path}.`);
    }

    // THE `already-current` CHECK, and the reason a second merge makes no empty commit. It also
    // absorbs three cases that would otherwise each need naming: a branch whose tip IS the
    // integration tip, a branch that committed nothing of its own and still sits on the campaign
    // base, and a request to merge the integration branch into itself.
    if (await this.#isAncestor(theirs, ours)) return { kind: 'already-current' };

    // Captured BEFORE the attempt so that restoration is judged against the tree that was
    // actually here. A `post_create` hook that touches a tracked lockfile leaves a modification
    // this module did not make and must not claim to have cleaned up.
    const dirtyBefore = await this.#trackedDirty();

    const merged = await this.#git([
      'merge',
      '--no-ff',
      // Signing is a credential prompt waiting to happen, and an agent has no hands: a repository
      // with `commit.gpgsign = true` would wedge or fail every integration merge on a machine
      // whose key needs a passphrase. The same reasoning as `GIT_ASKPASS=echo` in delivery/git.ts.
      '--no-gpg-sign',
      '--no-edit',
      '-m',
      `integrate ${branch} into ${this.branch}`,
      theirs,
    ]);

    if (merged.code === 0) {
      const commit = await revParse(this.path, 'HEAD');
      if (commit === null || commit === ours) {
        throw new IntegrationError(
          `\`git merge --no-ff\` of ${branch} reported success in ${this.path} without moving ` +
            `${this.branch} off ${ours.slice(0, 12)}. The tree is in a state this module cannot ` +
            'describe, so it refuses to report an outcome for it.',
        );
      }
      return { kind: 'merged', commit };
    }

    // ORDER MATTERS: the conflicted paths are read out of the index while the index still holds
    // them, and only then is the merge undone.
    const files = await this.#unmergedPaths();
    await this.#restore(ours, dirtyBefore, merged);

    if (files.length > 0) return { kind: 'conflict', files, ours, theirs };

    // A failed merge with NOTHING unmerged is not a conflict, and reporting one would brief a
    // reconciliation engineer with an empty list of files to reconcile. Two real shapes land
    // here, both verified against git rather than read off a manual page: `refusing to merge
    // unrelated histories` (exit 128, no MERGE_HEAD, nothing to abort), and a `pre-merge-commit`
    // hook that exits non-zero (exit 1, MERGE_HEAD present, the merge computed and left
    // uncommitted, which is why `#restore` runs before this throw rather than after it).
    throw new IntegrationError(
      `merging ${branch} into ${this.branch} failed in ${this.path} with no conflicted paths ` +
        `(exit ${merged.code}), so it is not a conflict two engineers can be asked to ` +
        `reconcile. The tree has been restored to ${ours.slice(0, 12)}. git said:\n` +
        (merged.stderr.trim() || merged.stdout.trim()),
    );
  }

  /**
   * Undo a failed merge and PROVE it. The contract promises the next workstream can still be
   * attempted, and a promise nobody checks is how "the tree is clean" becomes false three merges
   * later with no record of which one broke it.
   *
   * `git merge --abort` failing is not itself fatal: it exits 128 with `There is no merge to
   * abort` for a merge that never got as far as writing `MERGE_HEAD`, which is precisely the case
   * where there is nothing to undo. What is fatal is the tree not being back where it started.
   */
  async #restore(ours: string, dirtyBefore: readonly string[], failure: ExecResult): Promise<void> {
    await this.#git(['merge', '--abort']);
    if (await this.#isRestored(ours, dirtyBefore)) return;

    // The abort could not put it back. `reset --hard` to the recorded tip is the same destruction
    // the pool's own release performs, and it is authorised here for the same reason: everything
    // it destroys was written by the merge attempt this method exists to undo.
    await this.#git(['reset', '--hard', ours]);
    if (await this.#isRestored(ours, dirtyBefore)) return;

    throw new IntegrationError(
      `a failed merge in ${this.path} could not be undone: \`${this.branch}\` is not back at ` +
        `${ours.slice(0, 12)} with the working tree it had. The campaign must stop here rather ` +
        'than integrate the next workstream onto a half-merged branch. The merge that failed ' +
        `said:\n${failure.stderr.trim() || failure.stdout.trim()}`,
    );
  }

  async #isRestored(ours: string, dirtyBefore: readonly string[]): Promise<boolean> {
    if ((await currentBranch(this.path)) !== this.branch) return false;
    if ((await revParse(this.path, 'HEAD')) !== ours) return false;
    const now = await this.#trackedDirty();
    return now.length === dirtyBefore.length && now.every((line, i) => line === dirtyBefore[i]);
  }

  /**
   * Conflicted paths, from the index rather than from a diff.
   *
   * `ls-files --unmerged` answers for every conflict class that leaves stage entries, including
   * the ones a content diff has nothing to say about: a BINARY file (git writes ours into the
   * worktree, warns `Cannot merge binary files` and leaves no `<<<<<<<` markers anywhere, so the
   * path is the only evidence there is), a modify/delete, and a conflicted submodule gitlink.
   * `-z` because a repository is allowed to contain a path with a newline in it.
   */
  async #unmergedPaths(): Promise<string[]> {
    const result = await this.#git(['ls-files', '--unmerged', '-z']);
    if (result.code !== 0) return [];
    const paths = new Set<string>();
    for (const entry of result.stdout.split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab === -1) continue;
      paths.add(entry.slice(tab + 1));
    }
    return [...paths].sort();
  }

  /**
   * `git status --porcelain`, TRACKED ONLY.
   *
   * Untracked is excluded on purpose and it is not laziness: this is a pool tree, so it is warm,
   * so `node_modules` is sitting in it and a repository that does not gitignore its dependency
   * directory would otherwise look permanently dirty and refuse every merge. Untracked files do
   * not participate in a merge in any case; git refuses only over content it would overwrite.
   */
  async #trackedDirty(): Promise<string[]> {
    const result = await this.#git(['status', '--porcelain', '--untracked-files=no']);
    if (result.code !== 0) {
      throw new IntegrationError(
        `could not read the status of ${this.path}:\n${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result.stdout.split('\n').filter((line) => line.trim() !== '');
  }

  async #isAncestor(maybeAncestor: string, descendant: string): Promise<boolean> {
    const result = await this.#git(['merge-base', '--is-ancestor', maybeAncestor, descendant]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new IntegrationError(
      `\`git merge-base --is-ancestor\` failed in ${this.path} (exit ${result.code}):\n` +
        (result.stderr.trim() || result.stdout.trim()),
    );
  }

  #git(args: readonly string[]): Promise<ExecResult> {
    return runGit(args, { cwd: this.path, env: this.#env });
  }
}

/**
 * Lease a tree and put the integration branch in it.
 *
 * Two shapes, and the difference between them is the whole of resume:
 *
 *  - the branch does not exist yet, so it is CUT from `base`;
 *  - the branch exists, so it is CHECKED OUT and the campaign carries on from whatever it already
 *    integrated. It is checked first for containing `base`, because a branch of that name that
 *    does not descend from this campaign's base belongs to a different campaign (or to a human),
 *    and continuing onto it would merge workstreams into a stranger's history.
 */
export async function openIntegrationTree(
  options: OpenIntegrationTreeOptions,
): Promise<PooledIntegrationTree> {
  const { provider, holder, branch, env } = options;
  const project = resolve(options.project);

  const toplevel = await repoToplevel(project);
  if (toplevel === null) {
    throw new IntegrationError(`${project} is not inside a git repository.`);
  }
  await assertUsableBranchName(branch, toplevel, env);

  const base = await revParse(toplevel, options.base);
  if (base === null) {
    throw new IntegrationError(
      `the campaign base \`${options.base}\` does not resolve in ${toplevel}. The integration ` +
        'branch is cut from the campaign base rather than from the project head, so an ' +
        'unresolvable base is a campaign that cannot be integrated at all.',
    );
  }

  const lease = await provider.acquire(holder, toplevel);
  try {
    const existing = await revParse(lease.path, `refs/heads/${branch}`);
    if (existing === null) {
      // The pool hands trees out at detached HEAD on the project's head, which is not necessarily
      // `base`, so the start point is named explicitly. It is the one place the two commits are
      // allowed to differ without anybody having to notice.
      const cut = await runGit(['checkout', '-b', branch, base], { cwd: lease.path, env });
      if (cut.code !== 0) {
        throw new IntegrationError(
          `could not cut \`${branch}\` at ${base.slice(0, 12)} in ${lease.path}:\n` +
            (cut.stderr.trim() || cut.stdout.trim()),
        );
      }
    } else {
      const contains = await runGit(['merge-base', '--is-ancestor', base, existing], {
        cwd: lease.path,
        env,
      });
      if (contains.code !== 0) {
        throw new IntegrationError(
          `\`${branch}\` already exists at ${existing.slice(0, 12)} and does not contain this ` +
            `campaign's base ${base.slice(0, 12)}. That branch belongs to something else; ` +
            'integrating onto it would merge these workstreams into a history they were never ' +
            'cut from. Pick another integration branch, or delete that one deliberately.',
        );
      }
      const checkout = await runGit(['checkout', branch], { cwd: lease.path, env });
      if (checkout.code !== 0) {
        // The exclusion that makes cross-process concurrency safe, arriving as an error message.
        // git refuses to check a branch out in a second worktree, so a second supervisor for the
        // same campaign is stopped here rather than discovered later by its merge commits
        // interleaving with somebody else's.
        throw new IntegrationError(
          `could not check out \`${branch}\` in ${lease.path}:\n` +
            (checkout.stderr.trim() || checkout.stdout.trim()),
        );
      }
    }
    return new PooledIntegrationTree({ provider, lease, branch, base, env });
  } catch (error) {
    // Setup closes what it opened. The tree holds no work at this point (the branch ref, if it was
    // cut, survives the release in the repository's common ref store), so a leaked slot here would
    // be a pool that drains by one on every failed open.
    try {
      await provider.release(lease);
    } catch {
      /* the original failure is the one worth raising; a retained tree is recoverable */
    }
    throw error;
  }
}

/**
 * Refuse a branch name git would not accept, and refuse one that looks like a flag.
 *
 * The leading-dash check is FIRST and is not decoration: every other check hands the name to git,
 * and `-` is where an argument stops being an operand. `check-ref-format` is asked about
 * `refs/heads/<name>` rather than `--branch <name>`, because the `--branch` form EXPANDS shorthand
 * like `@{-1}`, which would quietly turn a validation into a resolution.
 */
async function assertUsableBranchName(
  branch: string,
  cwd: string,
  env: Record<string, string | undefined> | undefined,
): Promise<void> {
  if (branch.trim() === '' || branch.startsWith('-')) {
    throw new IntegrationError(
      `\`${branch}\` is not usable as an integration branch: a branch name may not be empty or ` +
        'begin with a dash, because git would read it as a flag rather than as a ref.',
    );
  }
  const check = await runGit(['check-ref-format', `refs/heads/${branch}`], { cwd, env });
  if (check.code !== 0) {
    throw new IntegrationError(
      `\`${branch}\` is not a valid branch name (\`git check-ref-format refs/heads/${branch}\` ` +
        `exited ${check.code}).`,
    );
  }
}
