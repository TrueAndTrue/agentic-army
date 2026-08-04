/**
 * Where the global config lives, and how to tell two paths apart.
 *
 * Separate from `src/archive/paths.ts` on purpose: that module takes `archiveRoot` as a
 * parameter and never asks where it came from. Answering that question is this module's whole
 * job, and it has to happen before a config exists to tell you.
 *
 * It also owns the path-COMPARISON primitives, for a reason this repo demonstrated the hard way:
 * there were four near-identical `realpath`-then-compare helpers in this repo (`setup/checks.ts`,
 * `worktree/cold.ts`, `worktree/hooks.ts`, and the one the worktree-root guard needed), and the
 * question they answer — "are these two strings the same directory" — is the same question every
 * time. One of the copies compared `/tmp` against `/private/tmp` lexically and misclassified a
 * deny root. Two implementations plus a drift test is worse than one, so they live here: this is
 * the module that already knows what a path means, and it is at the bottom of the import graph
 * (node builtins plus `contracts/config.ts`), so every consumer can reach it without a cycle.
 */

import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GLOBAL_CONFIG_DIR_NAME, GLOBAL_CONFIG_FILE_NAME } from '../contracts/config.ts';

/** Escape hatch for tests and unusual setups. Read by `src/setup/checks.ts` too. */
export const HOME_ENV_VAR = 'AGENTIC_ARMY_HOME';

/**
 * Set by the node test runner in every process it spawns, and by nothing else.
 *
 * It is read here as a fact about the PROCESS rather than about the `env` argument, and that
 * distinction is the whole strength of the refusal below: a caller that hands `armyHome` a
 * curated dictionary — `{}`, or a hook overlay, or a fixture's env — is still inside a test
 * process, and its `os.homedir()` fallback still lands on the developer's real archive.
 * Keying the tripwire off the argument would let exactly those callers through.
 */
const TEST_RUNNER_ENV_VAR = 'NODE_TEST_CONTEXT';

export type Env = Record<string, string | undefined>;

/**
 * The army's home directory — `~/.agentic-army`, or `$AGENTIC_ARMY_HOME`.
 *
 * The ONE resolver. `homeDir()` in `src/setup/checks.ts` used to be a second implementation
 * kept "byte-for-byte equivalent" by a test; two modules disagreeing about where the config
 * lives is a bug where `army enlist` writes a ceiling that the campaign runner never reads —
 * a silent security failure, not a cosmetic one — so the copy delegates here instead.
 *
 * ## Under the test runner it REFUSES rather than defaulting
 *
 * With no override set, the fallback is `os.homedir()`, so every caller that omits one resolves
 * the DEVELOPER'S OWN archive: `~/.agentic-army`, the directory holding real campaign records
 * and the real ceiling. Code reached from here creates it, writes probe files into it, leases
 * worktrees beside it. Two doctor tests did precisely that for months and nobody saw it, because
 * nothing was asserted about the home and a probe file deleted a millisecond later leaves nothing
 * to notice; the defect had to be found by comparing the directory's mtime across a test run.
 *
 * The refusal was first put on `homeDir()` alone, which closed the doctor write path and left
 * this function — the resolver `src/cli.ts`, `src/view/**`, `src/config/load.ts` and the campaign
 * runner all use — defaulting exactly as before. So the property held on one path and nowhere
 * else. It lives here now, once, and `homeDir()` inherits it by calling this.
 *
 * A defaulted parameter cannot hold that line: the next caller forgets it the way those two did,
 * and forgetting is silent. Refusing is not. Nothing outside a test process is affected, and a
 * test that genuinely means the real home can still say so by setting the override to it — an
 * opt-in a reviewer can see in the diff.
 */
export function armyHome(env: Env = process.env): string {
  const override = env[HOME_ENV_VAR];
  if (override !== undefined && override.trim() !== '') return path.resolve(override);
  if (process.env[TEST_RUNNER_ENV_VAR] !== undefined) {
    throw new Error(
      `refusing to resolve the home directory from the ambient environment inside a test: ` +
        `${HOME_ENV_VAR} is unset, so this would resolve the developer's own archive — the real ` +
        `~/${GLOBAL_CONFIG_DIR_NAME} — and code downstream of here creates directories and writes ` +
        `probe files into whatever it is handed. Pass an explicit home (runChecks, runCampaign, ` +
        `loadConfig and the chat session all take one), or set ${HOME_ENV_VAR} to a temporary ` +
        `directory for this test.`,
    );
  }
  return path.join(os.homedir(), GLOBAL_CONFIG_DIR_NAME);
}

/** `<home>/config.toml`. */
export function configPath(home: string = armyHome()): string {
  return path.join(home, GLOBAL_CONFIG_FILE_NAME);
}

/**
 * Where the archive goes when `archive_root` is absent: the directory holding the config file.
 *
 * Not `armyHome()` — deriving it from the config's own location means a config moved somewhere
 * else (a test fixture, a second machine profile, a portable install) keeps its archive
 * alongside it instead of silently writing into `~/.agentic-army`.
 */
export function defaultArchiveRoot(configFilePath: string): string {
  return path.dirname(path.resolve(configFilePath));
}

/**
 * Resolve the `archive_root` TOML value against the config's own location.
 *
 * Anything that is not a non-blank string — absent, `null`, a number, a hand-edit gone wrong —
 * falls back to `defaultArchiveRoot`. A relative value resolves against the config directory,
 * because a relative path in a config file means "next to me", not "next to whatever directory
 * the user happened to run `army` from".
 */
export function resolveArchiveRoot(raw: unknown, configFilePath: string): string {
  const base = defaultArchiveRoot(configFilePath);
  if (typeof raw !== 'string' || raw.trim() === '') return base;
  return path.resolve(base, raw.trim());
}

// ---------------------------------------------------------------------------------------------
// The worktree pool root — a SIBLING of the home, never a child of it
// ---------------------------------------------------------------------------------------------

/** `~/.agentic-army` -> `~/.agentic-army-trees`. */
export const WORKTREES_DIR_SUFFIX = '-trees';

/**
 * Where leased worktrees live: `<home>-trees`, i.e. `~/.agentic-army-trees`.
 *
 * ## Why it is not under the home any more
 *
 * It was `<archiveRoot>/worktrees`, and that was a campaign that could not do any work. Every
 * worker's deny-list carries `protectedConfigGlobs()` — `[home, home/**, home/config.toml]` — as
 * Read, Grep, Glob, Write AND Edit denies, so an Engineer handed a lease under the home was
 * denied its own worktree and sat there unable to open a single file.
 *
 * The deny is not the thing that gives. It is absolute on purpose and stays that way, with no
 * carve-out and no narrowing to a list: `<home>/campaigns/<id>/agents/cpt-01/report.md` is the
 * Engineer's OWN account of its work, and the review gate requires the Inspector be briefed from
 * the original orders and the branch, never from that account. A worker that can read the archive
 * walks around the review gate with one file read. So the trees move out instead.
 *
 * ## Why it is derived from `home` and not from `archiveRoot`
 *
 * `archive_root` is a user-editable TOML value. Deriving the pool from it means a config that
 * points `archive_root` back inside the protected tree silently recreates the original bug. The
 * home is resolved from the SUPERVISOR's own environment and never accepted from a worker, so
 * deriving from it is the only derivation an untrusted input cannot steer. It also relocates
 * cleanly: `AGENTIC_ARMY_HOME=/tmp/x` gives `/tmp/x-trees`, which keeps the suite hermetic.
 */
export function worktreesRootFor(home: string): string {
  const resolved = path.resolve(home);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}${WORKTREES_DIR_SUFFIX}`);
}

/** `worktreesRootFor(armyHome(env))` — the form for callers that do not already hold a home. */
export function worktreesRoot(env: Env = process.env): string {
  return worktreesRootFor(armyHome(env));
}

// ---------------------------------------------------------------------------------------------
// Path comparison — the ONE implementation
// ---------------------------------------------------------------------------------------------

export type Platform = NodeJS.Platform;

/**
 * `realpath`, falling back to `resolve` when the path does not exist.
 *
 * The fallback is the whole point: callers ask this about paths that are allowed to be absent,
 * and throwing would make "not there yet" indistinguishable from "somewhere else".
 */
export function realpathOrResolve(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * `realpath` as far as the filesystem will go, then re-attach the part that does not exist yet.
 *
 * `realpathOrResolve` gives up entirely the moment the leaf is missing, which is wrong for a
 * directory nobody has created: `/tmp/x-trees` resolves to itself while `/tmp` resolves to
 * `/private/tmp`, so a containment test against a resolved deny root compares two different
 * spellings of the same place and answers "outside". That is exactly the misclassification this
 * repo already shipped once, and it fails OPEN — the guard says the pool is safe when it is not.
 */
export function resolveDeepest(target: string): string {
  let head = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(head);
      // Walked to the filesystem root without finding anything that exists. Not reachable on a
      // sane system; returning rather than looping is the point.
      if (parent === head) return path.resolve(target);
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * A path reduced to the form in which `===` means "same place".
 *
 * Separators are unified and a trailing one dropped, and CASE is folded on macOS and Windows,
 * whose filesystems are case-insensitive by default — `/usr/local/bin/army` and
 * `/usr/local/bin/ARMY` are one file there and two strings everywhere. Compare identities, not
 * spellings.
 *
 * Symlinks are NOT resolved here: whether to `realpath` is the caller's decision, because the
 * answer differs between "is this the same inode" and "which of these two names did the user
 * type". Callers that want both compose this with `realpathOrResolve` / `resolveDeepest`.
 */
export function normalizePathForCompare(target: string, platform: Platform = process.platform): string {
  const slashed = target.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' || platform === 'darwin' ? slashed.toLowerCase() : slashed;
}

/** Do these two strings name the same path, symlinks already resolved by the caller? */
export function samePath(a: string, b: string, platform: Platform = process.platform): boolean {
  return normalizePathForCompare(a, platform) === normalizePathForCompare(b, platform);
}

/**
 * Is `child` `ancestor`, or somewhere beneath it? Real paths, not strings.
 *
 * Both sides go through `resolveDeepest` first, so `/tmp/pool` inside `/private/tmp` is caught
 * on macOS and a root that does not exist yet is still placed correctly. The `/` guard on the
 * prefix test is what stops `/a/bc` from being reported as inside `/a/b`.
 */
export function isInsideOrEqual(child: string, ancestor: string, platform: Platform = process.platform): boolean {
  const c = normalizePathForCompare(resolveDeepest(child), platform);
  const a = normalizePathForCompare(resolveDeepest(ancestor), platform);
  // `normalizePathForCompare('/')` is '', so the filesystem root contains everything — correct,
  // and the reason the separator is appended rather than assumed to be already there.
  return c === a || c.startsWith(`${a}/`);
}
