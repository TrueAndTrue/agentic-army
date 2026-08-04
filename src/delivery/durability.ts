/**
 * Durability. **Push is durability. PR and merge are delivery.**
 *
 * This module is the reason "stop at commit" is compatible with returning a lease. A leased
 * worktree is ephemeral: `release` resets and cleans it, so anything that exists only
 * inside it is one lease-return away from gone. Durability moves the branch to a real git ref
 * that outlives the tree — the project's `origin` when the campaign is allowed to touch it,
 * otherwise a bare mirror in the war archive that this module creates on demand.
 *
 * That is what makes the pool safe to drain and the overnight run safe to lose a process.
 *
 * ORDERING IS THE WHOLE POINT: durability first, release second. Never the other way round.
 * `hasUnlandedWork` is the predicate the worktree provider uses to enforce it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { DurabilityTarget } from '../contracts/delivery.ts';
import { MIRRORS_DIRNAME } from '../contracts/archive.ts';
import {
  countCommitsNotIn,
  git,
  ignoredPresent,
  listRefs,
  reflogCommits,
  remoteUrl,
  revParse,
  runGit,
  stashEntries,
  updateRef,
} from './git.ts';

/** The remote name reported for an army mirror. Never actually added to the user's config. */
export const MIRROR_REMOTE_NAME = 'army-mirror';
export const ORIGIN_REMOTE_NAME = 'origin';

/**
 * Local marker refs written after a successful durability push, in the repository's COMMON ref
 * store — so they survive `git worktree remove`. Two jobs:
 *
 *  1. they are the audit trail of "this commit reached a durable ref, at this time";
 *  2. they let `hasUnlandedWork` answer offline, with no remote round-trip, whether a lease is
 *     safe to return. A pushed-by-url ref creates no remote-tracking ref, so without this the
 *     release gate would have nothing local to look at.
 */
export const DURABLE_REF_PREFIX = 'refs/army/durable/';

/**
 * `army/take-hill-4` → `refs/army/durable/army-take-hill-4-<hash8>`.
 *
 * ONE FLAT SEGMENT, always suffixed with a digest of the exact branch name. Both properties are
 * load-bearing and neither is cosmetic:
 *
 *  - the digest makes it collision-free — `x` and `army/x` used to map to the same ref, so
 *    making one durable would silently vouch for the other;
 *  - the flattening avoids git's directory/file conflict — `army/a` and `army/a/b` cannot both
 *    exist as refs under a shared prefix, and that failure landed AFTER a successful push, which
 *    wedged the lease with its work already safe but the marker missing.
 */
export function durableRef(branch: string): string {
  const digest = createHash('sha1').update(branch).digest('hex').slice(0, 8);
  const slug = branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, 80);
  return `${DURABLE_REF_PREFIX}${slug === '' ? 'branch' : slug}-${digest}`;
}

/** Ref patterns that count as "this commit is no longer only in the ephemeral worktree". */
export const DURABLE_REF_PATTERNS = ['refs/remotes/', DURABLE_REF_PREFIX] as const;

export class DurabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurabilityError';
  }
}

// ---------------------------------------------------------------------------------------------
// mirror naming
// ---------------------------------------------------------------------------------------------

/**
 * `<archiveRoot>/mirrors/<name>-<hash8>.git`.
 *
 * Delivery writes this as `mirrors/<project>.git`; the 8-char digest of the ABSOLUTE project
 * path is added for the same reason `GlobalConfig.projects` is keyed by absolute path — two
 * checkouts that share a basename must not share a mirror, or `army/<task-id>` from one project
 * silently collides with the same branch name from the other.
 */
export function mirrorPathFor(project: string, archiveRoot: string): string {
  const absolute = resolve(project);
  const digest = createHash('sha1').update(absolute).digest('hex').slice(0, 8);
  const name = basename(absolute).replace(/[^A-Za-z0-9._-]/g, '_') || 'project';
  return join(resolve(archiveRoot), MIRRORS_DIRNAME, `${name}-${digest}.git`);
}

/** Create the bare mirror if it is not there yet. Idempotent. */
export async function ensureMirror(project: string, archiveRoot: string): Promise<string> {
  const path = mirrorPathFor(project, archiveRoot);
  if (existsSync(join(path, 'HEAD'))) return path;
  mkdirSync(path, { recursive: true });
  await git(['init', '--bare', '--quiet', path]);
  return path;
}

// ---------------------------------------------------------------------------------------------
// target resolution
// ---------------------------------------------------------------------------------------------

export interface DurabilityTargetOptions {
  /** Absolute path of the project (the primary checkout). */
  project: string;
  /** Absolute path of the war archive — mirrors live at `<archiveRoot>/mirrors/`. */
  archiveRoot: string;
  /**
   * May this task's work be pushed to the project's own `origin`?
   *
   * DEFAULTS TO FALSE — fail closed. `DeliveryPlan.durability` is documented as unaffected by
   * the rung, but the rung table defines rung 0 as "durable in the army mirror, YOUR
   * REPO UNTOUCHED" and rung 1 as "branch on origin". Pushing an `army/*` branch to the origin
   * of a repo whose ceiling the user deliberately pinned at 0 is exactly the blast-radius
   * escalation the ceiling exists to prevent, so origin is opt-in and the ladder opts in only
   * at rung >= 1. See the report accompanying this module.
   */
  allowOrigin?: boolean;
  /** Remote to consider the project's own. Defaults to `origin`. */
  originRemote?: string;
}

/**
 * Where this task's work will land. Always resolves to something — durability is not optional,
 * so "the project has no remote" is not a failure, it is a mirror.
 */
export async function resolveDurabilityTarget(
  opts: DurabilityTargetOptions,
): Promise<DurabilityTarget> {
  const project = resolve(opts.project);
  const remote = opts.originRemote ?? ORIGIN_REMOTE_NAME;
  if (opts.allowOrigin === true) {
    const url = await remoteUrl(project, remote);
    if (url !== null) return { kind: 'remote', remote, url };
  }
  const path = await ensureMirror(project, opts.archiveRoot);
  return { kind: 'mirror', remote: MIRROR_REMOTE_NAME, url: path };
}

// ---------------------------------------------------------------------------------------------
// the push
// ---------------------------------------------------------------------------------------------

export interface EnsureDurableOptions extends DurabilityTargetOptions {
  /** The leased worktree holding the commits. */
  worktree: string;
  /**
   * Directories the caller's release will preserve, on top of `DEFAULT_EXPENDABLE_IGNORED` —
   * `PooledLease.preserved` from the worktree provider. Untracked paths under these do not count
   * as a dirty tree; see the note on `ensureDurable`.
   */
  preserved?: readonly string[];
  /** `army/<task-id>` — the branch the Engineer cut inside the tree. */
  branch: string;
  /** Pre-resolved target, when the caller already planned one. */
  target?: DurabilityTarget;
}

export interface DurabilityResult {
  target: DurabilityTarget;
  branch: string;
  /** The commit that is now durable. */
  commit: string;
  /** The local marker ref written in the repository's common ref store. */
  ref: string;
  /** False when the remote already had this exact commit — still durable, just nothing to send. */
  pushed: boolean;
}

/**
 * Move `branch` out of the ephemeral worktree to a real ref, then record a local marker.
 *
 * Refuses a dirty tree: uncommitted or untracked files cannot be pushed, and `release` will
 * destroy them, so silently pushing "most of" the work would be worse than failing here.
 *
 * THE EXCEPTION IS REGENERABLE DIRECTORIES, and it has to be, or a warm pool cannot function in
 * a repository that does not `.gitignore` its dependency directory: `post_create` installs into
 * `node_modules`, `git status` reports `?? node_modules/`, durability refuses, a lease cannot be
 * released without durability, and the slot is stuck for that holder and every one after it.
 * Note the asymmetry that makes this safe: DURABILITY DESTROYS NOTHING. Its dirty check is a
 * courtesy — "you probably meant to commit this" — while the fail-closed gate that actually
 * guards against loss is `release`, which still refuses every one of these shapes. So the
 * default here is the `DEFAULT_EXPENDABLE_IGNORED` set, and a pooled caller may add its own
 * configured preserved directories on top.
 *
 * NEVER force-pushes. A non-fast-forward is an error the caller must resolve; it is not
 * something to bulldoze.
 */
export async function ensureDurable(opts: EnsureDurableOptions): Promise<DurabilityResult> {
  const worktree = resolve(opts.worktree);
  const { branch } = opts;

  const expendable = new Set([...DEFAULT_EXPENDABLE_IGNORED, ...(opts.preserved ?? [])]);
  const dirty = await dirtyStatusLines(worktree, expendable);
  if (dirty.length > 0) {
    throw new DurabilityError(
      `${worktree} has uncommitted or untracked changes (${dirty.slice(0, 5).join(', ')}). ` +
        'Commit them before durability: returning the lease resets and cleans the tree, so ' +
        'anything left here is destroyed.',
    );
  }

  const commit = await revParse(worktree, `refs/heads/${branch}`);
  if (commit === null) {
    throw new DurabilityError(
      `branch \`${branch}\` does not exist in ${worktree}. A leased worktree arrives at detached ` +
        'HEAD — the Engineer must cut its own branch before anything can be made durable.',
    );
  }

  const target = opts.target ?? (await resolveDurabilityTarget(opts));

  // Push by URL rather than by remote name so the user's repository config is never mutated:
  // a worktree shares `.git/config` with the primary checkout, and adding an `army-mirror`
  // remote there would be a write outside the leased tree.
  const push = await runGit(
    ['push', target.url, `refs/heads/${branch}:refs/heads/${branch}`],
    { cwd: worktree },
  );
  if (push.code !== 0) {
    throw new DurabilityError(
      `durability push of ${branch} to ${target.kind} ${target.url} failed (exit ${push.code}):\n` +
        (push.stderr.trim() || push.stdout.trim()),
    );
  }
  const pushed = !/Everything up-to-date/i.test(push.stderr + push.stdout);

  const ref = durableRef(branch);
  await updateRef(worktree, ref, commit);

  return { target, branch, commit, ref, pushed };
}

// ---------------------------------------------------------------------------------------------
// the release gate
// ---------------------------------------------------------------------------------------------

export interface UnlandedWork {
  /** True when returning the lease right now would destroy something. */
  unlanded: boolean;
  /** Uncommitted or untracked files — `release` deletes these outright. */
  dirty: boolean;
  /** `git status --porcelain`, capped, so the refusal can name what it is protecting. */
  dirtyPaths: string[];
  /**
   * Ignored-but-present files that are not obviously expendable build output. `clean -fdx`
   * deletes these and `git status` never mentions them.
   */
  preciousIgnored: string[];
  /** Commits reachable from this tree's work that no durable ref can reach. */
  unpushedCommits: number;
  /** What was examined: HEAD, this worktree's reflog, and stashes made from it. */
  candidates: string[];
  head: string | null;
  /** The durable refs used as the exclusion set. */
  durableRefs: string[];
  reason: string | null;
}

/**
 * Ignored paths a release may destroy without asking. Dependency and build output is
 * regenerable by definition — and treehouse's `post_create` warms exactly these, so treating
 * `node_modules/` as precious would deadlock the pool on the very thing the pool is for.
 * Matched per path SEGMENT, so `packages/api/dist/` matches too.
 */
export const DEFAULT_EXPENDABLE_IGNORED: readonly string[] = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.gradle',
  '.parcel-cache',
  '.cache',
  'coverage',
  '.tox',
  '.terraform',
  'Pods',
  'DerivedData',
  '.DS_Store',
];

export interface UnlandedWorkOptions {
  /** Extra path segments to treat as regenerable, on top of `DEFAULT_EXPENDABLE_IGNORED`. */
  expendableIgnored?: readonly string[];
  /**
   * Path segments THIS RELEASE WILL NOT DELETE — the warm pool's preserved dependency
   * directories. Distinct from `expendableIgnored`, which means "may be destroyed without
   * asking"; this means "will still be here afterwards", and it is the stronger statement.
   *
   * IT APPLIES TO BOTH LISTS, and the untracked half is the one that was missing. A preserved
   * directory that a repo does not `.gitignore` — plenty of repos never list `node_modules`
   * because they never commit near it — is invisible to `ignoredPresent` and shows up in
   * `git status --porcelain` as `?? node_modules/`. The pool preserves it across the reset, so
   * the NEXT holder inherits it, and an honest holder that branched, committed and landed its
   * work durably was refused release over a directory nothing was going to destroy. Refused
   * releases make the supervisor RETAIN the tree, so a bounded pool drains a slot at a time.
   *
   * ONLY UNTRACKED entries are exempted. `M vendor/dep.go` is a modification to a TRACKED file
   * and is real work — many Go repos commit `vendor/` — so it must go on blocking.
   *
   * The caller derives this from the one preserved set it passes to `git clean -e`, and
   * passes an empty list whenever the release will in fact destroy the tree.
   */
  preserved?: readonly string[];
  /**
   * `refs/stash` as it stood when the lease was acquired, so only entries pushed since then are
   * considered. `refs/stash` is a COMMON ref — a human's stash in the primary checkout is
   * visible from every worktree, and blocking on it would deadlock the pool on someone else's
   * half-finished afternoon.
   */
  stashBaseline?: string | null;
}

function isExpendable(entry: string, expendable: ReadonlySet<string>): boolean {
  return entry
    .split('/')
    .filter((segment) => segment !== '')
    .some((segment) => expendable.has(segment));
}

/**
 * `git status --porcelain`, less any UNTRACKED path whose segments are all-but-one expendable.
 *
 * THE SOLE IMPLEMENTATION of "which status lines count as work", shared by `ensureDurable` and
 * `inspectUnlandedWork` so the two can never disagree about whether a tree is clean — a
 * disagreement there means durability refuses a tree the release gate would have let go, or the
 * reverse, and either way the lease can never be returned honestly.
 */
export async function dirtyStatusLines(
  worktree: string,
  expendable: ReadonlySet<string>,
): Promise<string[]> {
  const status = await git(['status', '--porcelain'], { cwd: worktree });
  if (status === '') return [];
  return status.split('\n').filter((line) => {
    const untracked = untrackedPath(line);
    return untracked === null || !isExpendable(untracked, expendable);
  });
}

/**
 * The path of an UNTRACKED entry in `git status --porcelain`, or null for anything else.
 *
 * `?? path` is the only status code that means "this file is not in the index and not ignored".
 * Every other code (` M`, `A `, `D `, `UU`, …) describes a TRACKED path, which is work no
 * preserved-directory rule may wave through. A quoted path (`core.quotePath` escapes non-ASCII)
 * is deliberately returned as-is: it will not match a bare segment, so it keeps blocking, which
 * is the safe direction.
 */
function untrackedPath(line: string): string | null {
  return line.startsWith('?? ') ? line.slice(3) : null;
}

/**
 * Is there work in this tree that a `release` would destroy?
 *
 * `base` is the commit the worktree was handed out at, recorded by the provider at acquire time.
 * Commits at or below it belong to the repository, not to this lease.
 *
 * Three kinds of loss are checked, because the first version only checked one of them and
 * therefore did not do what it claimed:
 *
 *  1. **Uncommitted and untracked files** — `git status --porcelain`, less any UNTRACKED path
 *     under `opts.preserved`, which the release is keeping rather than destroying.
 *  2. **Ignored-but-present files** — invisible to `status`, deleted by `clean -fdx`. The
 *     permission layer exists partly to keep agents away from `.env` and credentials; destroying
 *     one silently is the wrong failure, so anything not obviously regenerable blocks the release.
 *  3. **Commits no durable ref can reach** — and NOT only from HEAD. Work committed on
 *     `army/<task>` while HEAD later moved elsewhere, or stashed, was previously reported
 *     landed. The per-worktree reflog is what makes the wider check attributable to THIS lease
 *     rather than to a sibling's branch.
 */
export async function inspectUnlandedWork(
  worktree: string,
  base: string | null,
  opts: UnlandedWorkOptions = {},
): Promise<UnlandedWork> {
  // A preserved directory is not "work this release would destroy" — the release is the thing
  // that keeps it. Untracked only; see `untrackedPath`.
  const preserved = new Set(opts.preserved ?? []);
  const dirtyPaths = (await dirtyStatusLines(worktree, preserved)).slice(0, 10);
  const dirty = dirtyPaths.length > 0;

  const expendable = new Set([
    ...DEFAULT_EXPENDABLE_IGNORED,
    ...(opts.expendableIgnored ?? []),
    // ONE INPUT, TWO LISTS. Anything that survives the release is expendable here by
    // definition, so the caller never maintains a second copy of its preserved set.
    ...preserved,
  ]);
  const preciousIgnored = (await ignoredPresent(worktree))
    .filter((entry) => !isExpendable(entry, expendable))
    .slice(0, 10);

  const head = await revParse(worktree, 'HEAD');
  const reflog = await reflogCommits(worktree);
  const reflogSet = new Set(reflog);

  // A stash entry belongs to this lease when BOTH hold: it was pushed after the lease was
  // acquired, and its first parent — the HEAD it was taken from — is a commit this worktree's
  // HEAD actually visited. Either test alone gives false positives, because the stash reflog is
  // shared across worktrees and every tree's reflog starts at the same base commit.
  const allStashes = await stashEntries(worktree);
  const baselineIndex =
    opts.stashBaseline === undefined || opts.stashBaseline === null
      ? -1
      : allStashes.findIndex((entry) => entry.sha === opts.stashBaseline);
  const freshStashes = baselineIndex === -1 ? allStashes : allStashes.slice(0, baselineIndex);
  const stashes = freshStashes
    .filter((entry) => entry.parents.some((parent) => reflogSet.has(parent)))
    .map((entry) => entry.sha);

  const candidates = [...new Set([...(head === null ? [] : [head]), ...reflog, ...stashes])];
  const durableRefs = await listRefs(worktree, DURABLE_REF_PATTERNS);
  const excludes = [...(base === null ? [] : [base]), ...durableRefs];
  const unpushedCommits = await countCommitsNotIn(worktree, candidates, excludes);

  const unlanded = dirty || unpushedCommits > 0 || preciousIgnored.length > 0;
  let reason: string | null = null;
  if (unlanded) {
    const parts: string[] = [];
    if (dirty) parts.push(`${dirtyPaths.length} uncommitted or untracked path(s)`);
    if (unpushedCommits > 0) {
      parts.push(`${unpushedCommits} commit(s) not reachable from any durable ref`);
    }
    if (preciousIgnored.length > 0) {
      parts.push(
        `${preciousIgnored.length} ignored-but-present file(s) that \`clean -fdx\` would delete ` +
          `(${preciousIgnored.slice(0, 3).join(', ')})`,
      );
    }
    reason =
      `${worktree} holds ${parts.join(', ')}. Durability must happen before release: ` +
      'returning the lease resets and cleans the tree, so this work would be destroyed.';
  }

  return {
    unlanded,
    dirty,
    dirtyPaths,
    preciousIgnored,
    unpushedCommits,
    candidates,
    head,
    durableRefs,
    reason,
  };
}

/** Convenience predicate over `inspectUnlandedWork`. */
export async function hasUnlandedWork(
  worktree: string,
  base: string | null,
  opts: UnlandedWorkOptions = {},
): Promise<boolean> {
  return (await inspectUnlandedWork(worktree, base, opts)).unlanded;
}
