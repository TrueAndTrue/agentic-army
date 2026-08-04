/**
 * The pooled worktree provider.
 *
 * THE ONE PROVIDER. treehouse was dropped as a dependency and warm pooling was brought in-house.
 * The file keeps the name `cold.ts` and the id `cold`, and the reason is a decision rather than an
 * obstacle: `cold` is an INPUT. It is what `--provider` accepts on a command line and what
 * `Lease.provider` carries on every live lease, so renaming it invalidates a shipped flag and
 * every lease in flight to buy a better adjective. The name is a lie in exactly one respect —
 * trees are handed back WARM — and that is the whole feature, so it is stated here, at the top,
 * where the name is read. See `WORKTREE_PROVIDER_IDS` in `src/contracts/worktree.ts`.
 *
 * Four guarantees, none of which may regress:
 *
 *  1. **Detached HEAD on hand-out.** The tree never arrives on a branch, so an Engineer must cut
 *     `army/<task-id>` itself (see `armyBranch`) or its commits are unreachable the moment the
 *     lease is returned.
 *
 *  2. **ABA-safe conditional release.** A lease record file per slot plays the part
 *     the retired tool's `--if-lease-id` flag played — the guard here is a comparison against
 *     that file, not a flag on any command line: a stale lease id is a NO-OP, never a destructive
 *     release of a tree someone else has since acquired — and that holds under `force` too.
 *     Slots are REUSED (releasing frees `wt-03`, the next acquire hands `wt-03` back out with a
 *     fresh lease id), which is what makes the guard load-bearing rather than theoretical.
 *
 *  3. **Fail-closed release.** Returning a lease is destructive, so it refuses by default
 *     whenever the tree holds work no durable ref can reach. Leaking a worktree is
 *     recoverable; destroying a night's work is not.
 *
 *  4. **WARM REUSE — the point of pooling.** Release used to run `reset --hard` + `clean -fdx`,
 *     which deletes `node_modules`, which means every task pays the 1–3 minute dependency
 *     install the pool exists to avoid. A warm release instead resets tracked content to the
 *     base commit and cleans everything untracked EXCEPT the regenerable dependency directories
 *     (`git clean -ffdx -e node_modules -e .venv …`, see `DEFAULT_PRESERVED_DEPS`). The next
 *     holder gets a tree that is pristine in tracked content and still populated, and its
 *     `post_create` hook — `pnpm install --frozen-lockfile` — runs incrementally instead of cold.
 *
 * THE SAFETY INTERACTION, stated once because it is easy to get subtly wrong: the release gate
 * blocks on ignored-but-present files that `clean -fdx` would silently delete, but must NOT
 * block on the dependency directories a warm release deliberately keeps. Those two lists are not
 * maintained separately — the preserved set is PASSED to the gate, as its `preserved` argument,
 * and the gate unions it with `expendableIgnored` internally.
 *
 * That is only half of it, and the missing half was a real hole: `git clean -e` speaks full
 * gitignore syntax while the gate matches whole path segments, so `preserve = ["bazel-out/"]` or
 * `["*.cache"]` was honoured by the reset and unknown to the gate — a file that survives every
 * reset and blocks every release of that slot, i.e. permanent force-only release. The subset
 * relation is therefore enforced at BOTH ends: preserve entries that the two cannot agree on
 * exactly are rejected at config-load time (`isSupportedPreservePattern`), so what reaches
 * `git clean -e` is always a bare segment the gate matches identically. A `secret.env` is in
 * neither list and still blocks by name.
 *
 * WHAT EXECUTES DURING A LEASE CYCLE, enumerated because a pool that reuses trees changes it:
 * the configured `post_create` / `pre_destroy` (user's global config only — `hooks.ts`), and the
 * REPOSITORY'S OWN `.git/hooks/post-checkout`, which now fires on provision and on every warm
 * reset — at acquire and again at release, where a destroy-on-release pool fired it once per
 * acquire. Git never clones hooks, so this is not attacker-supplied content; it is a frequency
 * change an operator should be able to read rather than discover.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { realpathOrResolve } from '../config/paths.ts';
import type {
  Lease,
  ReleaseOutcome,
  ReleaseResult as ContractReleaseResult,
  WorktreeProvider,
  WorktreeProviderId,
} from '../contracts/worktree.ts';
import { gitAvailable, repoToplevel, revParse, runGit } from '../delivery/git.ts';
import { inspectUnlandedWork } from '../delivery/durability.ts';
import type { UnlandedWork } from '../delivery/durability.ts';
import {
  DEFAULT_MAX_TREES,
  emptyOutcome,
  hookEnv,
  loadWorktreePoolConfig,
  projectKeyFor,
  resolveHookConfigFile,
  runHooks,
  sanitizeProviderEnv,
  strippedEnvWarning,
} from './hooks.ts';
import type { HookOutcome, WorktreePoolConfig } from './hooks.ts';

/** Everything needed to release a tree from a cold start, after the holder process is gone. */
export interface ColdLeaseRecord {
  leaseId: string;
  leaseHolder: string;
  leasedAt: string;
  /** Absolute path of the worktree. */
  path: string;
  /** Absolute path of the repository this tree belongs to. */
  repoRoot: string;
  /** The `[projects]` key — `--git-common-dir`, so a linked worktree collapses onto its repo. */
  projectKey?: string;
  /** Pool slot — the unit that gets reused, and therefore the unit ABA is about. */
  slot: number;
  /** Commit the tree was handed out at. Anything past it belongs to this lease. */
  base: string;
  /**
   * `refs/stash` at acquisition, or null. `refs/stash` is shared by every worktree of a
   * repository, so this is what separates "the agent stashed something" from "a human had a
   * stash sitting there all along".
   */
  stashBase?: string | null;
}

export interface ColdWorktreeProviderOptions {
  /** Managed root. Trees live at `<root>/trees/…`, lease records at `<root>/leases/…`. */
  root: string;
  /**
   * Hard cap on concurrent trees per repository. Overrides `[worktree] max_trees` from the
   * user's global config; when neither is set the cap is `DEFAULT_MAX_TREES` (16).
   */
  maxSlots?: number;
  /**
   * Overlaid on `process.env` for every git invocation and every hook.
   *
   * SANITISED ON THE WAY IN. `CONFIG_RELOCATING_ENV_VARS` are stripped in the constructor, so
   * this bag cannot point this provider — or an `army` a hook invokes — at a config file other
   * than the one below. It used to be forwarded verbatim into the hook-config resolver, which
   * made `env: { AGENTIC_ARMY_HOME: '<repo>' }` enough to execute a repo-committed
   * `post_create`; the resolver no longer takes an environment at all.
   */
  env?: Record<string, string | undefined>;
  /**
   * The army home DIRECTORY, which is where lifecycle hooks are read from and the ONLY place
   * they may come from (`src/worktree/hooks.ts`). Never a repository path — it carries the same
   * trust rule as `AGENTIC_ARMY_HOME`: the commander's own environment, never a worker or a repo.
   * Resolved to an absolute `config.toml` path ONCE, at construction.
   */
  home?: string;
  /**
   * Extra ignored path segments a release may destroy without asking, on top of
   * `DEFAULT_EXPENDABLE_IGNORED` and the preserved dependency set. Anything else that is
   * ignored-but-present blocks the release, because `clean -fdx` deletes it and `git status`
   * never mentions it.
   */
  expendableIgnored?: readonly string[];
}

export class ColdWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColdWorktreeError';
  }
}

/**
 * Every slot for a repository is leased.
 *
 * THE POLICY, and it is a decision rather than a limitation: acquire FAILS FAST. It does not
 * queue, it does not block, and it never creates a tree beyond the cap.
 *
 *  - *Beyond the cap* is out because the cap is really a disk bound — a tree is a full checkout
 *    plus a warm `node_modules` — and silently exceeding it turns "the pool is busy" into "the
 *    volume is full", which fails somewhere else, later, for someone else.
 *  - *Blocking* is out because an invisible wait is indistinguishable from a hang: the supervisor
 *    would have a worker parked on a lease it cannot see, with no signal row and no timeout it
 *    chose. Backpressure that the scheduler can see beats backpressure it cannot.
 *
 * So the pool reports exhaustion as a typed error with the cap in it, and the layer that knows
 * task priorities decides whether to wait, shed, or raise `max_trees`.
 */
export class PoolExhaustedError extends ColdWorktreeError {
  readonly maxTrees: number;
  readonly repoRoot: string;
  constructor(repoRoot: string, maxTrees: number) {
    super(
      `all ${maxTrees} worktree slots for ${repoRoot} are leased. The pool fails fast rather than ` +
        'queueing, so this is backpressure the scheduler can see: release a lease, or raise ' +
        '`max_trees` in [worktree] (or in that project\'s entry) in the global config.',
    );
    this.name = 'PoolExhaustedError';
    this.maxTrees = maxTrees;
    this.repoRoot = repoRoot;
  }
}

/**
 * Thrown by `release` when returning the lease would destroy work. This is the fail-closed rule
 * made unmissable: the caller must either establish durability or pass `force`.
 */
export class UnlandedWorkError extends Error {
  readonly lease: Lease;
  readonly detail: UnlandedWork;
  constructor(lease: Lease, detail: UnlandedWork) {
    super(
      `${detail.reason ?? `${lease.path} holds unlanded work.`} ` +
        'Run durability first (delivery/durability.ts), or release with `{ force: true }` if the ' +
        'work is already durable elsewhere.',
    );
    this.name = 'UnlandedWorkError';
    this.lease = lease;
    this.detail = detail;
  }
}

/**
 * A lease, plus everything provisioning learned. `Lease` is the contract's shape and has no
 * room for any of this, so the provider returns a structural widening: a caller typed against
 * `Lease` is unaffected, a caller that wants the diagnostics narrows to `PooledLease`.
 *
 * **HOOK FAILURE POLICY lives here.** A failed `post_create` does NOT fail `acquire` and is NOT
 * swallowed. The tree is real, isolated, at detached HEAD and correctly leased — the isolation
 * guarantee is intact and only the WARM-UP failed, so destroying a usable tree would be a
 * needless second failure. Equally, saying nothing is how the next Engineer inherits a tree with
 * no `node_modules` and spends its budget blaming its own task. So the outcome is data:
 * `lease.hooks.ok === false`, with the failing command, its exit code and a tail of its output.
 * The caller decides — proceed, or `release()` and escalate.
 */
export interface PooledLease extends Lease {
  /** Pool slot. The directory is zero-padded — slot 1 is `wt-01`. */
  slot: number;
  /** True when this tree was reused with its dependency directories intact. */
  warm: boolean;
  /**
   * `post_create`, run on EVERY acquire — provisioned or warm. NOT on release: the warm reset
   * happens there and only `pre_destroy` runs with it, so the tree is warmed for its next holder
   * by that holder's own acquire. Never throws; always here.
   */
  hooks: HookOutcome;
  /** The dependency directories this tree's releases will preserve. */
  preserved: string[];
  /**
   * Everything the pool wants this caller to know: settings in the global config that are NOT in
   * effect (a rejected `preserve` pattern, a malformed hook list) and variables stripped from the
   * environment overlay. Without this they existed only on a `settingsFor()` call nobody makes.
   */
  warnings: string[];
}

export interface ReleaseOptions {
  /**
   * Skip the unlanded-work gate. The lease-id comparison is NOT skipped — force buys past
   * "this tree holds work", never past "this tree is not yours", so a stale lease stays a no-op.
   * Use when the holder process is gone and its work is already durable.
   */
  force?: boolean;
  /**
   * Destroy the tree instead of returning it warm. For a tree suspected of being poisoned, or
   * to reclaim disk. The next acquire of the slot then pays a full checkout and a cold install.
   */
  discard?: boolean;
}

/**
 * The contract's release result, plus what pooling learned on the way out.
 *
 * The same structural widening `PooledLease` is: `outcome`, `released` and `message` are the
 * contract, and a caller typed against `WorktreeProvider` sees only those. The three extra fields
 * are pool-specific — whether the tree came back warm, which dependency directories survived it,
 * and what `pre_destroy` did — and exist because a warm release that silently fell back to
 * destroying the tree is a 1–3 minute install the next holder pays and nobody predicted.
 */
export interface ReleaseResult extends ContractReleaseResult {
  /** True when the tree was kept and reset warm; false when it was destroyed. */
  warm: boolean;
  /** Dependency directories the warm reset preserved. Empty when the tree was destroyed. */
  preserved: string[];
  /** `pre_destroy`, run before the reset. Null when there was no tree to run it in. */
  hooks: HookOutcome | null;
}

const LEASES_DIRNAME = 'leases';
const TREES_DIRNAME = 'trees';
const LOCKS_DIRNAME = 'locks';

/** How long to wait for another acquirer to finish touching `.git/worktrees`. */
const LOCK_TIMEOUT_MS = 30_000;
/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 120_000;

function slugFor(repoRoot: string): string {
  const digest = createHash('sha1').update(repoRoot).digest('hex').slice(0, 8);
  const name = basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, '_') || 'repo';
  return `${name}-${digest}`;
}

function readRecord(file: string): ColdLeaseRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Partial<ColdLeaseRecord>;
    if (typeof record.leaseId !== 'string' || typeof record.path !== 'string') return null;
    return parsed as ColdLeaseRecord;
  } catch {
    return null;
  }
}

export class ColdWorktreeProvider implements WorktreeProvider {
  readonly id: WorktreeProviderId = 'cold';

  readonly root: string;
  /** Explicit override of the pool cap. `null` means "whatever the global config says". */
  readonly maxSlots: number | null;
  readonly #env: Record<string, string | undefined> | undefined;
  readonly #expendableIgnored: readonly string[] | undefined;
  /**
   * The one file hooks may come from, resolved here and never again. An immutable absolute path
   * is what makes "no argument can relocate the config" a fact about the object rather than a
   * request to callers.
   */
  readonly hookConfigFile: string;
  /**
   * Variables removed from `options.env` because they choose which config file hooks come from.
   * Surfaced rather than silent: it takes away a caller's ability to run hooks under a sandboxed
   * `HOME`, and a capability that disappears without a word is one somebody debugs for an hour.
   */
  readonly strippedEnv: readonly string[];

  constructor(options: ColdWorktreeProviderOptions) {
    this.root = resolve(options.root);
    this.maxSlots = options.maxSlots ?? null;
    // Sanitise ONCE, so the stripped bag is the only one that exists downstream — git, hooks and
    // anything either of them spawns. Filtering at each use site would be a rule to remember.
    const sanitized = sanitizeProviderEnv(options.env);
    this.#env = sanitized.env;
    this.strippedEnv = sanitized.stripped;
    this.hookConfigFile = resolveHookConfigFile(options.home);
    this.#expendableIgnored = options.expendableIgnored;
  }

  /** The pooled provider needs nothing but git. */
  async isAvailable(): Promise<boolean> {
    return gitAvailable();
  }

  get leasesDir(): string {
    return join(this.root, LEASES_DIRNAME);
  }

  /** Every lease this root currently believes is held. The crash-recovery entry point. */
  listLeases(): ColdLeaseRecord[] {
    if (!existsSync(this.leasesDir)) return [];
    const out: ColdLeaseRecord[] = [];
    for (const name of readdirSync(this.leasesDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const record = readRecord(join(this.leasesDir, name));
      if (record !== null) out.push(record);
    }
    return out;
  }

  /**
   * The pool's settings for a repository, exactly as an `acquire` would read them: hooks, cap,
   * preserved set, and every warning about a setting that is NOT in effect.
   */
  async settingsFor(repoRoot: string): Promise<WorktreePoolConfig> {
    const toplevel = (await repoToplevel(resolve(repoRoot))) ?? resolve(repoRoot);
    const projectKey = (await projectKeyFor(toplevel)) ?? toplevel;
    return this.#poolConfig(projectKey);
  }

  async #poolConfig(projectKey: string): Promise<WorktreePoolConfig> {
    const config = await loadWorktreePoolConfig(projectKey, this.hookConfigFile);
    if (this.strippedEnv.length > 0) config.warnings.push(strippedEnvWarning(this.strippedEnv));
    if (this.maxSlots !== null) config.maxTrees = this.maxSlots;
    if (!config.warm) config.preserve = [];
    return config;
  }

  // -------------------------------------------------------------------------------------------
  // acquire
  // -------------------------------------------------------------------------------------------

  async acquire(holder: string, repoRoot: string): Promise<PooledLease> {
    if (holder.trim() === '') {
      throw new ColdWorktreeError('a lease needs a holder — the agent id that owns the tree.');
    }
    const toplevel = await repoToplevel(resolve(repoRoot));
    if (toplevel === null) {
      throw new ColdWorktreeError(`${resolve(repoRoot)} is not inside a git repository.`);
    }
    const base = await revParse(toplevel, 'HEAD');
    if (base === null) {
      throw new ColdWorktreeError(
        `${toplevel} has no commits, so there is nothing to hand out at detached HEAD.`,
      );
    }

    const projectKey = (await projectKeyFor(toplevel)) ?? toplevel;
    const settings = await this.#poolConfig(projectKey);

    const stashBase = await revParse(toplevel, 'refs/stash');
    const slug = slugFor(toplevel);
    mkdirSync(this.leasesDir, { recursive: true });
    mkdirSync(join(this.root, TREES_DIRNAME, slug), { recursive: true });

    const leasedAt = new Date().toISOString();
    const leaseId = randomUUID();

    for (let slot = 1; slot <= settings.maxTrees; slot++) {
      const file = this.#leaseFile(slug, slot);
      const path = join(this.root, TREES_DIRNAME, slug, `wt-${String(slot).padStart(2, '0')}`);
      const record: ColdLeaseRecord = {
        leaseId,
        leaseHolder: holder,
        leasedAt,
        path,
        repoRoot: toplevel,
        projectKey,
        slot,
        base,
        stashBase,
      };
      // `wx` makes claiming a slot atomic against another process racing for the same one.
      try {
        writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }

      let warm = false;
      try {
        warm = await this.#withRepoLock(slug, () =>
          this.#provision(toplevel, path, base, settings.preserve),
        );
      } catch (error) {
        try {
          unlinkSync(file);
        } catch {
          /* the slot leaks rather than the error being masked */
        }
        throw error;
      }

      // HOOKS RUN OUTSIDE THE REPO LOCK. `pnpm install` takes minutes; holding the lock that
      // serialises `.git/worktrees` for that long would turn a pool of 16 into a pool of 1.
      const hooks =
        settings.postCreate.length === 0
          ? emptyOutcome('post_create', settings.exists ? settings.source : null)
          : await runHooks(settings.postCreate, {
              hook: 'post_create',
              cwd: path,
              timeoutMs: settings.hookTimeoutMs,
              source: settings.source,
              env: {
                ...this.#env,
                ...hookEnv({
                  hook: 'post_create',
                  worktree: path,
                  project: projectKey,
                  leaseId,
                  leaseHolder: holder,
                  slot,
                  warm,
                }),
              },
            });

      const lease: PooledLease = {
        path,
        leaseId,
        leaseHolder: holder,
        leasedAt,
        provider: this.id,
        slot,
        warm,
        hooks,
        preserved: [...settings.preserve],
        warnings: [...settings.warnings],
      };
      return lease;
    }

    throw new PoolExhaustedError(toplevel, settings.maxTrees);
  }

  /**
   * Serialise everything that mutates `.git/worktrees` for one repository.
   *
   * `git worktree prune` walks that directory and reads `commondir` out of every entry — while a
   * concurrent `git worktree add` is halfway through creating one. That race really fires: it
   * failed roughly 5% of 10-way concurrent acquires with
   * `failed to read .git/worktrees/wt-NN/commondir`. A lock directory is used rather than a file
   * because `mkdir` is atomic on every filesystem that matters, including over NFS and on
   * Windows, and the design has to survive Windows.
   */
  async #withRepoLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const dir = join(this.root, LOCKS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, `${slug}.lock`);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
            // The holder died. Leaking a lock forever would drain the pool as surely as any bug.
            rmSync(lock, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue; // it vanished under us; try to take it
        }
        if (Date.now() > deadline) {
          throw new ColdWorktreeError(
            `timed out after ${LOCK_TIMEOUT_MS}ms waiting for ${lock}. If no acquire is running, ` +
              'remove that directory.',
          );
        }
        await sleep(5 + Math.floor(Math.random() * 15));
      }
    }

    try {
      return await fn();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  /**
   * Put a tree at DETACHED HEAD on `base`, reusing the slot's existing tree when there is a
   * healthy one. Returns true when the tree was reused warm.
   *
   * The reset happens HERE as well as at release time, and that redundancy is deliberate: the
   * release-time reset keeps idle pool trees pristine for whoever looks at them, but only the
   * acquire-time reset can point the tree at the base commit this lease is actually being handed
   * out at, and only it can guarantee the tree is clean regardless of what touched it while it
   * sat idle.
   *
   * MUST be called under `#withRepoLock`.
   */
  async #provision(
    repoRoot: string,
    path: string,
    base: string,
    preserve: readonly string[],
  ): Promise<boolean> {
    if (existsSync(path)) {
      if (await this.#isReusable(repoRoot, path)) {
        try {
          await this.#resetTree(path, base, preserve);
          return true;
        } catch {
          // A tree that will not reset is not a tree worth arguing with: destroy it and pay for
          // a cold checkout rather than hand out something in an unknown state.
        }
      }
      // Debris from a crash, a foreign directory, or a tree that refused to reset. The lease
      // record is the source of truth for "held", so an unowned tree here is safe to remove.
      await runGit(['worktree', 'remove', '--force', path], { cwd: repoRoot, env: this.#env });
      rmSync(path, { recursive: true, force: true });
    }
    mkdirSync(dirname(path), { recursive: true });

    const add = (): Promise<{ code: number; stderr: string; stdout: string }> =>
      runGit(['worktree', 'add', '--detach', path, base], { cwd: repoRoot, env: this.#env });

    const first = await add();
    if (first.code === 0) return false;

    // Prune ONLY here. The unconditional prune this replaced was the race: it ran on every
    // acquire, whether or not anything was stale, and it is the operation that trips over a
    // half-built worktree. The one case that genuinely needs it is a registration whose
    // directory is gone — which git tells us about, so we can wait to be told.
    if (/already (registered|exists|used)|missing but already registered/i.test(first.stderr)) {
      await runGit(['worktree', 'prune'], { cwd: repoRoot, env: this.#env });
      const retry = await add();
      if (retry.code === 0) return false;
      throw new ColdWorktreeError(
        `could not create a worktree at ${path} even after pruning a stale registration:\n` +
          (retry.stderr.trim() || retry.stdout.trim()),
      );
    }
    throw new ColdWorktreeError(
      `could not create a worktree at ${path}:\n${first.stderr.trim() || first.stdout.trim()}`,
    );
  }

  /**
   * Is the directory sitting in this slot a linked worktree OF THIS REPOSITORY?
   *
   * Both halves matter. "It is a git worktree" alone would let a pool root copied between repos,
   * or a repo that has been re-`init`ed, hand out a tree whose objects have nothing to do with
   * the base commit being requested.
   */
  async #isReusable(repoRoot: string, path: string): Promise<boolean> {
    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], {
      cwd: path,
      env: this.#env,
    });
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return false;
    const toplevel = await repoToplevel(path);
    if (toplevel === null || realpathOrResolve(toplevel) !== realpathOrResolve(path)) return false;
    const mine = await projectKeyFor(path);
    const theirs = await projectKeyFor(repoRoot);
    return mine !== null && theirs !== null && mine === theirs;
  }

  /**
   * THE WARM RESET. Tracked content back to `base` at detached HEAD; everything untracked gone
   * EXCEPT `preserve`; and the tree's memory of the last holder erased.
   *
   * Four details, each of which has a reason:
   *
   *  - **`--detach`**, always. An idle pool tree that still had `army/take-hill-4` checked out
   *    would make `git branch -d army/take-hill-4` fail in the user's own repo with "checked out
   *    at …", i.e. the pool would hold the user's branches hostage.
   *  - **`clean -ffdx`**, two `f`s. One `f` leaves a nested repository (a fixture someone cloned
   *    into the tree) in place, and it would then be inherited, silently, by the next task.
   *  - **`-e <name>`** with no slash, so a nested `packages/api/node_modules` is preserved too.
   *    `-x` disables the standard ignore rules but explicitly KEEPS the `-e` ones, which is what
   *    makes "delete everything ignored except the dependencies" expressible in one command.
   *  - **the per-worktree reflog is expired.** THE POOL-DRAIN FIX, and the one that only exists
   *    because trees are now reused. `logs/HEAD` under `.git/worktrees/<slot>/` is what makes the
   *    release gate able to see work whose branch HEAD has moved away — it is precise
   *    exactly because it used to mean "what THIS lease did", which was true only while a tree
   *    died with its holder. Carried across a reuse it means "what every holder of this slot ever
   *    did", so a later holder that committed, landed its work durably and left a clean tree was
   *    refused release over somebody else's abandoned commit; the supervisor then RETAINS the
   *    tree and the bounded pool drains a slot at a time until nothing can be acquired.
   *
   *    This is the shape of bug `stashBase` was invented for — a signal that outlives a lease —
   *    and it is fixed at the SOURCE rather than by teaching one consumer to ignore part of its
   *    input: after this call the reflog once again means "this lease", so every reader of it is
   *    correct, including the ones nobody has written yet. Nothing is lost by it: the gate has
   *    already ruled on the previous holder's work (or been forced past), and a commit that was
   *    made on `army/<task>` is still reachable from that branch ref, which outlives the tree.
   */
  async #resetTree(path: string, base: string, preserve: readonly string[]): Promise<void> {
    const checkout = await runGit(['checkout', '--force', '--detach', base], {
      cwd: path,
      env: this.#env,
    });
    if (checkout.code !== 0) {
      throw new ColdWorktreeError(
        `could not reset ${path} to ${base}:\n${checkout.stderr.trim() || checkout.stdout.trim()}`,
      );
    }
    const reset = await runGit(['reset', '--hard'], { cwd: path, env: this.#env });
    if (reset.code !== 0) {
      throw new ColdWorktreeError(
        `could not reset the index of ${path}:\n${reset.stderr.trim() || reset.stdout.trim()}`,
      );
    }
    const args = ['clean', '-ffdx'];
    for (const entry of preserve) args.push('-e', entry);
    const clean = await runGit(args, { cwd: path, env: this.#env });
    if (clean.code !== 0) {
      throw new ColdWorktreeError(
        `could not clean ${path}:\n${clean.stderr.trim() || clean.stdout.trim()}`,
      );
    }
    // Last, so that the reset's own `checkout` entries go too and the tree is handed over with
    // no history but the one its next holder writes. A failure here is fatal to the WARM path on
    // purpose: `#provision` and `release` both fall back to destroying the tree, and a cold
    // checkout has an empty reflog by construction — so the invariant holds either way.
    const expire = await runGit(['reflog', 'expire', '--expire=now', 'HEAD'], {
      cwd: path,
      env: this.#env,
    });
    if (expire.code !== 0) {
      throw new ColdWorktreeError(
        `could not expire the per-worktree reflog of ${path}, so the next holder would inherit ` +
          `this one's history and be refused release over it:\n` +
          (expire.stderr.trim() || expire.stdout.trim()),
      );
    }
  }

  #leaseFile(slug: string, slot: number): string {
    return join(this.leasesDir, `${slug}-${String(slot).padStart(2, '0')}.json`);
  }

  #findLeaseFile(path: string): string | null {
    if (!existsSync(this.leasesDir)) return null;
    const target = resolve(path);
    for (const name of readdirSync(this.leasesDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const file = join(this.leasesDir, name);
      const record = readRecord(file);
      if (record !== null && resolve(record.path) === target) return file;
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // release
  // -------------------------------------------------------------------------------------------

  /**
   * Contract entry point.
   *
   * ONE METHOD. There used to be two: a `release` that returned `void` to satisfy the contract,
   * and a `tryRelease` beside it that returned the outcome — so the honest answer existed and the
   * contract pointed every caller at the one that threw it away. Now that the contract returns a
   * result, the second method has nothing left to add, and two spellings of one operation is how
   * the next caller ends up on the lossy one.
   *
   * Throws `UnlandedWorkError` when returning the lease would destroy work, and `ColdWorktreeError`
   * for a lease this provider did not mint. Everything else — including the ABA refusal — comes
   * back as a `ReleaseResult`, because a stale lease is an ordinary thing for a crash-recovering
   * supervisor to find and ordinary outcomes are returned, not thrown.
   */
  async release(lease: Lease, opts?: ReleaseOptions): Promise<ReleaseResult> {
    if (lease.provider !== this.id) {
      throw new ColdWorktreeError(
        `lease ${lease.leaseId} was minted by \`${lease.provider}\`; a lease is only releasable ` +
          `by its own provider (this is \`${this.id}\`).`,
      );
    }

    const noop = (outcome: ReleaseOutcome, message: string): ReleaseResult => ({
      outcome,
      released: false,
      warm: false,
      preserved: [],
      hooks: null,
      message,
    });

    const file = this.#findLeaseFile(lease.path);
    if (file === null) {
      return noop(
        'no-record',
        `no lease record for ${lease.path}; nothing to release. The tree was already returned, ` +
          'or it belongs to a different managed root.',
      );
    }
    const record = readRecord(file);
    if (record === null || record.leaseId !== lease.leaseId) {
      // THE ABA GUARD. The slot has been re-leased since this lease was minted, so this release
      // would destroy someone else's tree. Refuse, quietly and without touching anything.
      return noop(
        'stale-lease',
        `lease ${lease.leaseId} is stale: ${lease.path} is now held by ` +
          `${record === null ? 'an unreadable record' : `${record.leaseHolder} (${record.leaseId})`}. ` +
          'Refusing to release a tree this lease no longer owns.',
      );
    }

    const projectKey = record.projectKey ?? record.repoRoot;
    const settings = await this.#poolConfig(projectKey);

    if (!existsSync(record.path)) {
      unlinkSync(file);
      return noop('missing-tree', `${record.path} is already gone; lease record cleared.`);
    }

    // Decided BEFORE the gate, because the gate's whole question is "would this release destroy
    // something", and the honest answer depends on which release this is. A discarding or
    // `warm = false` release destroys the tree, so nothing is exempt from it.
    const keepWarm = settings.warm && opts?.discard !== true;

    if (opts?.force !== true) {
      const detail = await inspectUnlandedWork(record.path, record.base, {
        // ONE PRESERVED SET, PASSED ONCE. The gate applies it to BOTH lists it can
        // appear in: ignored-but-present (a repo that gitignores `node_modules`) and UNTRACKED
        // (a repo that does not — `?? node_modules/`). The untracked half is the one that was
        // missing, and it drained the pool exactly like the reflog did: the preserved directory
        // is inherited by every later holder, so an honest holder that landed its work durably
        // was refused release over a directory nothing was going to delete.
        //
        // The relation holds for every entry because `settings.preserve` contains only bare
        // segments — patterns `git clean -e` would honour but this gate cannot match are
        // rejected at load, with a warning, rather than silently creating a tree that can never
        // be released without force.
        preserved: keepWarm ? settings.preserve : [],
        expendableIgnored: this.#expendableIgnored ?? [],
        stashBaseline: record.stashBase ?? null,
      });
      if (detail.unlanded) throw new UnlandedWorkError(lease, detail);
    }

    // `pre_destroy` runs while the tree still has its contents, and its failure NEVER blocks the
    // release: a cleanup command that exits 1 must not leak a pool slot. It is reported instead.
    const hooks =
      settings.preDestroy.length === 0
        ? emptyOutcome('pre_destroy', settings.exists ? settings.source : null)
        : await runHooks(settings.preDestroy, {
            hook: 'pre_destroy',
            cwd: record.path,
            timeoutMs: settings.hookTimeoutMs,
            source: settings.source,
            env: {
              ...this.#env,
              ...hookEnv({
                hook: 'pre_destroy',
                worktree: record.path,
                project: projectKey,
                leaseId: record.leaseId,
                leaseHolder: record.leaseHolder,
                slot: record.slot,
                warm: keepWarm,
              }),
            },
          });

    let warm = false;
    if (keepWarm) {
      try {
        await this.#withRepoLock(slugFor(record.repoRoot), () =>
          this.#resetTree(record.path, record.base, settings.preserve),
        );
        warm = true;
      } catch {
        // Fall back to destroying it. The gate above already authorised destruction, so this is
        // a downgrade in speed, never in safety.
        await this.#destroy(record);
      }
    } else {
      await this.#destroy(record);
    }

    unlinkSync(file);
    return {
      outcome: 'released',
      released: true,
      warm,
      preserved: warm ? [...settings.preserve] : [],
      hooks,
      message: warm
        ? `released ${record.path} (slot ${record.slot}) held by ${record.leaseHolder}; kept warm ` +
          `(preserving ${settings.preserve.length} dependency director${settings.preserve.length === 1 ? 'y' : 'ies'}).`
        : `released ${record.path} (slot ${record.slot}) held by ${record.leaseHolder}; tree destroyed.`,
    };
  }

  /**
   * Remove every tree in this repository's pool that no lease holds.
   *
   * Warm trees are not free — they hold a checkout plus a dependency install each — so there has
   * to be a way to reclaim the disk without deleting the pool root out from under a live lease.
   * Held slots are skipped, not waited for.
   */
  async evictIdle(repoRoot: string): Promise<string[]> {
    const toplevel = await repoToplevel(resolve(repoRoot));
    if (toplevel === null) return [];
    const slug = slugFor(toplevel);
    const dir = join(this.root, TREES_DIRNAME, slug);
    if (!existsSync(dir)) return [];
    const held = new Set(this.listLeases().map((record) => resolve(record.path)));
    const removed: string[] = [];
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (held.has(resolve(path))) continue;
      await this.#destroy({ path, repoRoot: toplevel });
      removed.push(path);
    }
    return removed;
  }

  async #destroy(record: Pick<ColdLeaseRecord, 'path' | 'repoRoot'>): Promise<void> {
    await this.#withRepoLock(slugFor(record.repoRoot), async () => {
      // `--force` here is about the filesystem, not about policy: the fail-closed gate above has
      // already decided whether this tree may die.
      const removed = await runGit(['worktree', 'remove', '--force', record.path], {
        cwd: record.repoRoot,
        env: this.#env,
      });
      if (removed.code === 0) return;
      // A clean `remove` already deregisters, so prune is only for the path that resisted it.
      rmSync(record.path, { recursive: true, force: true });
      await runGit(['worktree', 'prune'], { cwd: record.repoRoot, env: this.#env });
    });
  }
}
