/**
 * Worktree lifecycle hooks — isolation, blast radius, and where a hook may come from.
 *
 * ===========================================================================================
 * A HOOK IS ARBITRARY COMMAND EXECUTION. IT IS READ FROM THE USER'S GLOBAL CONFIG AND FROM
 * NOWHERE ELSE. THAT IS THE ONE PROPERTY THIS FILE EXISTS TO HOLD.
 * ===========================================================================================
 *
 * `post_create = ["pnpm install --frozen-lockfile"]` is a command that runs on your machine the
 * moment an agent leases a tree. If that line could be read out of the repository being worked
 * on — a `treehouse.toml`, a `package.json` field, an `.agentic-army.toml`, anything committed —
 * then `git clone` would be remote code execution, and it would cost the repo's author nothing.
 * This is the identical hole delivery ceilings closed by being keyed by absolute path and
 * stored only in the user's global config, and treehouse's own documentation draws the same
 * line ("lifecycle hooks are ignored in repo-level config for safety"), so it is a known trap
 * rather than a hypothetical one.
 *
 * Consequently — and this list is written as what is TRUE, not as what was intended. An earlier
 * version of this header claimed "no parameter anywhere in this module can point it at a repo"
 * while `opts.env.AGENTIC_ARMY_HOME` did exactly that, forwarded straight from
 * `ColdWorktreeProviderOptions.env`, and an Inspector demonstrated it executing a
 * repo-committed `config.toml`. The comment is why nobody looked. So:
 *
 *  - EXACTLY ONE FILE IS READ, and its path is FIXED WHEN THE PROVIDER IS CONSTRUCTED by
 *    `resolveHookConfigFile()` — the single resolver, which every caller must go through.
 *    `loadWorktreePoolConfig` takes that resolved absolute path and has no `home`, no `env`, and
 *    nothing derived from the project: there is no argument to it that can move the file.
 *  - THE ONLY TWO INPUTS to that resolution are the `home` constructor option and, when it is
 *    absent, the REAL `process.env` (via `armyHome`, i.e. `$AGENTIC_ARMY_HOME` else `~`). A
 *    caller-supplied environment bag is never consulted, so no amount of forwarding can relocate
 *    the config. `home` carries the same trust rule the config file states for
 *    `AGENTIC_ARMY_HOME` itself: it comes from the COMMANDER's own environment and must never be
 *    accepted from a worker, a campaign file, or a repository.
 *  - BELT AND BRACES FOR CHILDREN: `sanitizeProviderEnv` strips the variables that could relocate
 *    army config out of any caller-supplied overlay, so a hook — or an `army` invoked by a hook —
 *    cannot be pointed at a repo either. The provider sanitises once, in its constructor, so the
 *    stripped bag is the only one that exists downstream.
 *  - Hooks are keyed by ABSOLUTE PROJECT PATH, resolved through `--git-common-dir` so that a
 *    linked worktree collapses onto its main repo. Every Engineer is handed a worktree, so
 *    keying on `--show-toplevel` would mean each leased tree looked like a different project.
 *
 * WHAT ELSE EXECUTES, so this file is an honest enumeration: a repository's own `.git/hooks/*`.
 * `post-checkout` fires on provision and on every warm reset — at acquire AND at release, where
 * a destroy-on-release pool fired it once per acquire. The threat model still holds (git never
 * clones hooks, so they are not attacker-supplied content the way a committed `treehouse.toml`
 * is), but "a warm pool runs your post-checkout hook more often" is a fact an operator is
 * entitled to read here rather than discover.
 *
 * Everything else here is failure reporting. A hook that fails is NOT swallowed and does NOT
 * abort the lease: see `HookOutcome` and the note on `PooledLease.hooks` in `cold.ts`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { armyHome, configPath, realpathOrResolve } from '../config/paths.ts';
import type { Env } from '../config/paths.ts';
import { MissingBinaryError, runBinary, runGit } from '../delivery/git.ts';

// ---------------------------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------------------------

export const HOOK_NAMES = ['post_create', 'pre_destroy'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/**
 * One command from the config.
 *
 * TOML permits two spellings, and the difference is not cosmetic:
 *
 *   post_create = ["pnpm install --frozen-lockfile"]      # a string: goes through a shell
 *   post_create = [["pnpm", "install", "--frozen-lockfile"]]  # an argv: no shell at all
 *
 * The argv form is what a program should write — no quoting, no word splitting, no `$IFS`. The
 * string form is what a person will write, and refusing it would just push people to write
 * `["sh", "-c", "..."]` themselves, which is the same thing with worse errors. Both are the
 * user's own file, i.e. exactly as trusted as their shell rc; the adversarial input this module
 * defends against is the REPOSITORY, and the repository is never read.
 */
export interface HookCommand {
  /** Printable form, used in every message and in `HookRun`. */
  display: string;
  /** argv when the entry was an array; null when the entry must go through a shell. */
  argv: readonly string[] | null;
}

/** What one command did. `code === null` means it never started (e.g. the binary is missing). */
export interface HookRun {
  hook: HookName;
  command: string;
  code: number | null;
  ok: boolean;
  durationMs: number;
  /** Tail of stdout+stderr, capped. The point is to name the cause without shipping a log file. */
  output: string;
  /** Set when the process could not be started at all. */
  error?: string;
}

/**
 * The result of running one hook list. Structured on purpose: this is what lands on the `Lease`
 * (`post_create`) and on the `ReleaseResult` (`pre_destroy`) so that a caller can decide what a
 * warm-up failure means for its task instead of finding out from a broken tree.
 */
export interface HookOutcome {
  hook: HookName;
  /** True when every command exited 0 — and vacuously true when there were none. */
  ok: boolean;
  ran: HookRun[];
  /** The first command that failed, or null. */
  failure: HookRun | null;
  /** Commands after the failure that were not attempted. */
  skipped: number;
  /** Absolute path of the config file the commands came from, or null when there were none. */
  source: string | null;
}

export function emptyOutcome(hook: HookName, source: string | null = null): HookOutcome {
  return { hook, ok: true, ran: [], failure: null, skipped: 0, source };
}

// ---------------------------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------------------------

/**
 * Directories a warm release must NOT delete — the whole point of pooling a worktree.
 *
 * THE RULE THAT PICKED THIS LIST: preserve a directory only if it is a regenerable *input* —
 * something a hook reconstructs from a lockfile or manifest, invalidated by content rather than
 * by timestamp. Never preserve a build *output*, because a build output is what the next task's
 * tests will load, serve, or ship, and a stale copy of it is indistinguishable from a correct
 * one until it is wrong.
 *
 * Kept: dependency installs (`node_modules`, `.venv`, `venv`, `vendor`) and content-addressed
 * tool caches (`.gradle`, `.turbo`, `__pycache__`, `.mypy_cache`, `.ruff_cache`, `.pytest_cache`).
 *
 * Dropped, deliberately, and each for a reason:
 *  - `dist`, `build`, `out` — the artifact under test. A file from a source file that has since
 *    been deleted survives a rebuild and gets imported.
 *  - `.next`, `.nuxt`, `.svelte-kit` — served by a dev/test server. `.next/cache` alone would be
 *    worth keeping, but `git clean`'s exclude patterns are directory-granular here and getting a
 *    nested carve-out subtly wrong fails silently in the dangerous direction.
 *  - `target` — Cargo would be safe (fingerprint-keyed, and the single biggest warm win there),
 *    but `target/` is also Maven's output directory, where `target/classes` holds compiled
 *    classes that `java -cp target/classes` will actually load. The directory name cannot tell
 *    the two apart and the wrong guess means "the run tested code that is no longer in the
 *    repo". A Cargo user opts in with one line: `preserve = ["target"]`.
 *  - `coverage`, `.terraform` — output and state respectively; neither is a cache.
 *
 * Matched by `git clean -e <name>`, i.e. gitignore syntax with no slash, so a nested
 * `packages/api/node_modules` is preserved too.
 */
export const DEFAULT_PRESERVED_DEPS: readonly string[] = [
  'node_modules',
  '.venv',
  'venv',
  'vendor',
  '__pycache__',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
  '.gradle',
  '.turbo',
];

/**
 * treehouse capped at `max_trees = 16` and that number is a good one: a tree is a full checkout
 * plus a warm `node_modules`, so the bound is really a disk bound.
 */
export const DEFAULT_MAX_TREES = 16;

/**
 * Fifteen minutes. `runBinary`'s two-minute default is sized for a git push; a cold
 * `pnpm install` on a monorepo is exactly the 1–3 minutes the pool exists to amortise, and a first
 * install with a cold package store is longer still.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 900_000;

/** Bytes of stdout+stderr kept per hook run. Enough to name a cause, not enough to be a log. */
const OUTPUT_TAIL = 4000;

// ---------------------------------------------------------------------------------------------
// the project key
// ---------------------------------------------------------------------------------------------

/**
 * The absolute path that keys `[projects]`, resolved the only way a delivery ceiling can safely
 * be keyed: `--git-common-dir`, never `--show-toplevel`, so every linked worktree of a repo
 * collapses onto the repo itself.
 *
 * DUPLICATE by necessity: `resolveProjectRoot` in `src/command/campaign.ts` computes the same
 * thing, and this module must not depend on the command layer (the command layer composes this
 * one). The right home for it is `src/delivery/git.ts` or `src/config`, neither of which this
 * unit owns — recorded in the report rather than fixed by a second copy that can drift silently.
 */
export async function projectKeyFor(dir: string): Promise<string | null> {
  let result = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: dir,
  });
  if (result.code !== 0) result = await runGit(['rev-parse', '--git-common-dir'], { cwd: dir });
  if (result.code !== 0) return null;
  const commonDir = result.stdout.trim().split('\n')[0] ?? '';
  if (commonDir === '') return null;
  const absolute = path.resolve(dir, commonDir);
  // `<root>/.git` -> `<root>`; a bare repo's common dir IS the root.
  const root = path.basename(absolute) === '.git' ? path.dirname(absolute) : absolute;
  // `root` is already `path.resolve`d, so `realpathOrResolve`'s fallback is exactly `root`.
  return realpathOrResolve(root);
}

// ---------------------------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------------------------

/** Everything the pool reads from the user's global config for one project. */
export interface WorktreePoolConfig {
  /** Absolute path of the file that was read (or would have been). */
  source: string;
  /** False when there is no config file yet — hooks are then empty, which is the safe answer. */
  exists: boolean;
  postCreate: HookCommand[];
  preDestroy: HookCommand[];
  /** Concurrent trees per repository. */
  maxTrees: number;
  /** Directory names a warm release preserves. */
  preserve: string[];
  /** False disables warm reuse entirely: a release DESTROYS the tree instead of resetting it. */
  warm: boolean;
  hookTimeoutMs: number;
  /** Settings the user wrote that are NOT in effect. Never silently dropped. */
  warnings: string[];
}

/**
 * THE SINGLE RESOLVER for the hook-config path. Call it once, at construction, and keep the
 * answer: an immutable absolute path cannot be relocated later by anything.
 *
 * `home` is an army home DIRECTORY and never a repository — same trust rule as
 * `AGENTIC_ARMY_HOME` (commander's own environment; never a worker, a campaign file or a repo).
 * When it is absent the REAL `process.env` is read here, at the one place that is allowed to.
 */
export function resolveHookConfigFile(home?: string): string {
  return configPath(home === undefined ? armyHome(process.env) : path.resolve(home));
}

/**
 * Variables that could relocate army config, stripped from any caller-supplied environment
 * overlay before it reaches git or a hook.
 *
 * This is a deny-list, and an allow-list is the shape to prefer where the input is adversarial —
 * but an allow-list over environment variables is not workable (a hook legitimately needs PATH,
 * package-manager caches, CI variables, anything). What makes THIS list enumerable rather than
 * "the spellings I thought of" is that it is derived from the two functions that compute the
 * path: `armyHome()` reads `AGENTIC_ARMY_HOME`, and its fallback `os.homedir()` reads `HOME` on
 * POSIX and `USERPROFILE`/`HOMEDRIVE`+`HOMEPATH` on Windows.
 *
 * `test/worktree.test.ts` DERIVES the first half from the source of `src/config/paths.ts` and
 * the second by observing `os.homedir()` in a child process, so adding an input to either
 * without adding it here fails. An earlier version of this sentence claimed the test "pins the
 * pair" when the test merely iterated this list and could not have detected it falling behind:
 * a guard that cannot fail is not a guard, and this was the ninth of those found on this project.
 *
 * Note that stripping is defence for CHILD processes: the provider's own config path is resolved
 * before any of this bag exists, so the overlay could not move it in any case. Note also what it
 * COSTS — a caller can no longer hand hooks a sandboxed `HOME`, which is a legitimate thing to
 * want. That is why `sanitizeProviderEnv` reports what it removed instead of doing it silently.
 */
export const CONFIG_RELOCATING_ENV_VARS: readonly string[] = [
  'AGENTIC_ARMY_HOME',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
];

export interface SanitizedEnv {
  /** The overlay, minus anything that could relocate the config. */
  env: Record<string, string | undefined> | undefined;
  /** What was removed, so the caller can be TOLD rather than left to notice. */
  stripped: string[];
}

/**
 * Strip `CONFIG_RELOCATING_ENV_VARS` from an overlay, and say what was stripped.
 *
 * Removing a variable a caller deliberately set is a capability taken away — a sandboxed `HOME`
 * for hooks is a reasonable thing to ask for, and it no longer works. Doing that silently is how
 * someone spends an afternoon on it, so the removal is reported: see `strippedEnv` and the
 * warning the provider raises on `PooledLease.warnings`.
 */
export function sanitizeProviderEnv(
  env: Record<string, string | undefined> | undefined,
): SanitizedEnv {
  if (env === undefined) return { env: undefined, stripped: [] };
  const clean: Record<string, string | undefined> = { ...env };
  const stripped: string[] = [];
  for (const name of CONFIG_RELOCATING_ENV_VARS) {
    if (Object.hasOwn(clean, name)) {
      stripped.push(name);
      delete clean[name];
    }
  }
  return { env: clean, stripped };
}

/** The warning a caller sees when its overlay lost variables. Exported so the wording is pinned. */
export function strippedEnvWarning(stripped: readonly string[]): string {
  return (
    `${stripped.join(', ')} ${stripped.length === 1 ? 'was' : 'were'} removed from the ` +
    'environment passed to git and to lifecycle hooks. Those variables decide which config file ' +
    'hooks are read from, so honouring them from a caller-supplied bag would let a repository ' +
    'point the pool at its own `config.toml`. The cost is real: hooks run under ' +
    'the real HOME, so a sandboxed HOME cannot be delivered this way — use the `home` option for ' +
    'the config location, or a wrapper command for the sandbox.'
  );
}

function isTable(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

/** U+FEFF — see the note in `src/config/load.ts`; Windows editors write one and TOML rejects it. */
const BOM = '﻿';

function parseHookList(raw: unknown, where: string, warnings: string[]): HookCommand[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`${where}: expected an array of commands; ignoring it (no hook will run)`);
    return [];
  }
  const out: HookCommand[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry === 'string') {
      if (entry.trim() === '') {
        warnings.push(`${where}[${index}]: empty command, ignored`);
        continue;
      }
      out.push({ display: entry, argv: null });
      continue;
    }
    if (Array.isArray(entry) && entry.every((part) => typeof part === 'string')) {
      const argv = (entry as string[]).filter((part) => part !== '');
      if (argv.length === 0) {
        warnings.push(`${where}[${index}]: empty argv, ignored`);
        continue;
      }
      out.push({ display: argv.join(' '), argv });
      continue;
    }
    warnings.push(
      `${where}[${index}]: expected a command string or an array of argv strings, got ` +
        `${JSON.stringify(entry)}; ignored`,
    );
  }
  return out;
}

function parsePositiveInt(raw: unknown, where: string, warnings: string[]): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
    warnings.push(`${where}: expected a positive integer, got ${JSON.stringify(raw)}; ignoring it`);
    return null;
  }
  return Math.floor(raw);
}

/**
 * Is `entry` a pattern for which "preserved ⊆ expendable" actually holds?
 *
 * THE SUBSET RELATION IS NOT FREE. `git clean -e` speaks full gitignore syntax — `bazel-out/`,
 * `*.cache`, `build/*.o`, `!keep`, `/anchored` — but the release gate's expendable check
 * (`isExpendable` in `delivery/durability.ts`) compares whole path SEGMENTS. Every pattern the
 * first understands and the second does not is a file that survives the reset and then blocks
 * every future release of that slot: permanent force-only release, i.e. the same pool drain as
 * the reflog, arriving through a config key users were invited to set.
 *
 * So a preserve entry must be a BARE PATH SEGMENT — the one form both sides agree on exactly
 * (`git clean -e node_modules` matches a `node_modules` at any depth; the segment check matches
 * `packages/api/node_modules/` at any depth). Everything else is REJECTED at config-load time
 * with a warning that names the reason, which fails in the safe direction: the directory is not
 * preserved (slower), and the gate goes on treating it normally (correct).
 *
 * Rejected deliberately: anything containing `/` after one optional trailing slash (anchors and
 * nested paths), glob metacharacters, `!` anywhere in the entry (negation, which would
 * UN-preserve — rejected at any position, not only leading, because the check is a character
 * class), and `.`/`..`.
 */
export function isSupportedPreservePattern(entry: string): boolean {
  const trimmed = entry.trim().replace(/\/$/, '');
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return false;
  if (/[/\\]/.test(trimmed)) return false;
  if (/[*?[\]!]/.test(trimmed)) return false;
  return true;
}

/** Normalise a supported pattern to the bare segment both `git clean` and the gate agree on. */
export function normalizePreservePattern(entry: string): string {
  return entry.trim().replace(/\/$/, '');
}

function parsePreserveList(raw: unknown, where: string, warnings: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')) {
    warnings.push(`${where}: expected an array of directory names; ignoring it`);
    return [];
  }
  const out: string[] = [];
  for (const entry of raw as string[]) {
    if (entry.trim() === '') continue;
    if (!isSupportedPreservePattern(entry)) {
      warnings.push(
        `${where}: ${JSON.stringify(entry)} is not a plain directory name, so it is IGNORED. ` +
          '`git clean` would honour it but the release gate matches whole path segments, and a ' +
          'file preserved by one and unknown to the other survives every reset and then blocks ' +
          'every release of that tree. Use a bare name like "bazel-out" — it matches at any ' +
          'depth — rather than a path, a glob, or a negation.',
      );
      continue;
    }
    out.push(normalizePreservePattern(entry));
  }
  return out;
}

/**
 * Does this `[projects]` key name this project?
 *
 * String equality after `resolve`, plus a `realpath` attempt so that a config written against
 * `/tmp/x` still matches a repo git reports as `/private/tmp/x`. A key that is not absolute is
 * ignored outright, because a relative or bare-name key is claimable by any directory that
 * happens to share it.
 *
 * EXACT equality, deliberately — this is the one comparison in the repo that does NOT go through
 * `samePath`, and the difference is case folding. `samePath` folds case on macOS and Windows,
 * which is right when asking "is this the same inode"; here the key selects a DELIVERY CEILING,
 * and widening what a key matches widens what it can authorise. It costs nothing to be strict:
 * `realpath` already returns the filesystem's own casing, so a key that names a real directory
 * matches it whatever the user typed. Only a key naming a directory that does not exist is
 * case-sensitive, and such a key authorises nothing anyway.
 */
function keyMatchesProject(key: string, project: string): boolean {
  if (!path.isAbsolute(key)) return false;
  const resolved = path.resolve(key);
  // `realpathOrResolve` falls back to `resolve`, which is `resolved` — already ruled out above.
  return resolved === project || realpathOrResolve(resolved) === project;
}

/**
 * Read the pool's settings for one project.
 *
 * `project` MUST already be a `projectKeyFor()` result, and `source` MUST come from
 * `resolveHookConfigFile()`. Note what this signature CANNOT express: there is no `home`, no
 * environment and nothing derived from `project`, so no argument to this function can change
 * which file it reads. That is the whole security property, enforced by the type rather than by
 * a comment asking people to be careful.
 *
 * Reads one file and no other; a missing file, an unparseable file, or a file with nothing to
 * say all resolve to "no hooks", which is the fail-closed direction — the cost is a slow tree,
 * and the cost of the other direction is running someone else's command.
 */
export async function loadWorktreePoolConfig(
  project: string,
  source: string,
): Promise<WorktreePoolConfig> {
  const warnings: string[] = [];
  const base: WorktreePoolConfig = {
    source,
    exists: false,
    postCreate: [],
    preDestroy: [],
    maxTrees: DEFAULT_MAX_TREES,
    preserve: [...DEFAULT_PRESERVED_DEPS],
    warm: true,
    hookTimeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    warnings,
  };

  let text: string;
  try {
    text = await fs.readFile(source, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      warnings.push(`cannot read ${source}: ${err.message}; running with no hooks`);
    }
    return base;
  }
  base.exists = true;

  let data: Record<string, unknown>;
  try {
    data = parseToml(text.startsWith(BOM) ? text.slice(BOM.length) : text) as Record<
      string,
      unknown
    >;
  } catch (e) {
    // Deliberately NOT a throw. `loadConfig` throws here because an unreadable file must not
    // silently take every delivery ceiling to 0 without saying so; the failure direction for a
    // hook is the opposite — "no hook ran" is safe, and wedging the pool over a stray quote is
    // not. The warning is the whole obligation.
    warnings.push(
      `${source} is not valid TOML (${(e as Error).message}); running with no hooks and default ` +
        'pool settings. Fix it by hand — nothing in it is in effect.',
    );
    return base;
  }

  // ---- [worktree] — machine-wide defaults -----------------------------------------------
  const worktree = data['worktree'];
  if (worktree !== undefined && !isTable(worktree)) {
    warnings.push('worktree: expected a table; ignoring it');
  } else if (isTable(worktree)) {
    const maxTrees = parsePositiveInt(worktree['max_trees'], 'worktree.max_trees', warnings);
    if (maxTrees !== null) base.maxTrees = maxTrees;
    const timeout = parsePositiveInt(
      worktree['hook_timeout_ms'],
      'worktree.hook_timeout_ms',
      warnings,
    );
    if (timeout !== null) base.hookTimeoutMs = timeout;
    const warm = worktree['warm'];
    if (typeof warm === 'boolean') base.warm = warm;
    else if (warm !== undefined) warnings.push('worktree.warm: expected true or false; ignoring it');
    // ADDITIVE, never a replacement. Someone adding `target` for a Cargo repo must not silently
    // stop preserving `node_modules` — the failure would look like "warm pooling does nothing".
    base.preserve = [
      ...new Set([
        ...base.preserve,
        ...parsePreserveList(worktree['preserve'], 'worktree.preserve', warnings),
      ]),
    ];
  }

  // ---- [projects."<abs path>"] — per project, and the ONLY place hooks may live ----------
  const projects = data['projects'];
  if (projects !== undefined && !isTable(projects)) {
    warnings.push('projects: expected a table; no project has hooks');
    return base;
  }
  if (!isTable(projects)) return base;

  for (const [key, value] of Object.entries(projects)) {
    if (!keyMatchesProject(key, project)) continue;
    if (!isTable(value)) {
      warnings.push(`projects.${JSON.stringify(key)}: expected a table; ignoring its hooks`);
      continue;
    }
    const where = `projects.${JSON.stringify(key)}`;
    base.postCreate = parseHookList(value['post_create'], `${where}.post_create`, warnings);
    base.preDestroy = parseHookList(value['pre_destroy'], `${where}.pre_destroy`, warnings);

    const maxTrees = parsePositiveInt(value['max_trees'], `${where}.max_trees`, warnings);
    if (maxTrees !== null) base.maxTrees = maxTrees;
    const timeout = parsePositiveInt(value['hook_timeout_ms'], `${where}.hook_timeout_ms`, warnings);
    if (timeout !== null) base.hookTimeoutMs = timeout;
    const warm = value['warm'];
    if (typeof warm === 'boolean') base.warm = warm;
    else if (warm !== undefined) {
      warnings.push(`${where}.warm: expected true or false; ignoring it`);
    }
    base.preserve = [
      ...new Set([
        ...base.preserve,
        ...parsePreserveList(value['preserve'], `${where}.preserve`, warnings),
      ]),
    ];
    break;
  }

  return base;
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

export interface RunHooksOptions {
  hook: HookName;
  /** The worktree. Hooks run HERE — `pnpm install` has to land in the tree it is warming. */
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  source?: string | null;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= OUTPUT_TAIL ? trimmed : `…${trimmed.slice(-OUTPUT_TAIL)}`;
}

/** `sh -c` on POSIX, `cmd.exe /d /s /c` on Windows — this has to survive Windows. */
function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env['COMSPEC'] ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

/**
 * Run a hook list sequentially in `cwd`.
 *
 * SEQUENTIAL and STOP-ON-FAILURE. Sequential because the second command routinely depends on the
 * first (`pnpm install` then `pnpm build`); stop-on-failure because running a build against a
 * failed install produces a second, more confusing error that buries the first.
 *
 * Never throws. Every failure — non-zero exit, missing binary, timeout — comes back as data, so
 * the caller can attach it to the lease and decide.
 */
export async function runHooks(
  commands: readonly HookCommand[],
  opts: RunHooksOptions,
): Promise<HookOutcome> {
  const outcome = emptyOutcome(opts.hook, opts.source ?? null);
  for (const [index, command] of commands.entries()) {
    const started = Date.now();
    const spawn = command.argv === null
      ? shellFor(command.display)
      : { file: command.argv[0]!, args: [...command.argv.slice(1)] };

    let run: HookRun;
    try {
      const result = await runBinary(spawn.file, spawn.args, {
        cwd: opts.cwd,
        env: opts.env,
        timeoutMs: opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      });
      run = {
        hook: opts.hook,
        command: command.display,
        code: result.code,
        ok: result.code === 0,
        durationMs: Date.now() - started,
        output: tail(`${result.stdout}\n${result.stderr}`),
      };
    } catch (error) {
      const message = error instanceof MissingBinaryError ? error.message : String(error);
      run = {
        hook: opts.hook,
        command: command.display,
        code: null,
        ok: false,
        durationMs: Date.now() - started,
        output: '',
        error: message,
      };
    }

    outcome.ran.push(run);
    if (!run.ok) {
      outcome.ok = false;
      outcome.failure = run;
      outcome.skipped = commands.length - index - 1;
      return outcome;
    }
  }
  return outcome;
}

/** The `ARMY_*` variables every hook can rely on. */
export function hookEnv(fields: {
  hook: HookName;
  worktree: string;
  project: string;
  leaseId: string;
  leaseHolder: string;
  slot: number;
  warm: boolean;
}): Record<string, string> {
  return {
    ARMY_HOOK: fields.hook,
    ARMY_WORKTREE: fields.worktree,
    ARMY_PROJECT: fields.project,
    ARMY_LEASE_ID: fields.leaseId,
    ARMY_LEASE_HOLDER: fields.leaseHolder,
    ARMY_SLOT: String(fields.slot),
    /** `1` when the tree was reused with its dependencies intact, `0` for a fresh checkout. */
    ARMY_WARM: fields.warm ? '1' : '0',
  };
}
