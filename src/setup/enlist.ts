/**
 * `army enlist [--ceiling N]` — register the current repository with the army.
 *
 * ===========================================================================
 * SECURITY: why the ceiling lives in the GLOBAL config and never in the repo
 * ===========================================================================
 *
 * A project's delivery ceiling is written to `~/.agentic-army/config.toml`,
 * keyed by absolute path. It is never written into the repository it governs,
 * and the repository is never consulted for it.
 *
 * If the ceiling lived in the repo, then `git clone` would be an escalation
 * primitive: cloning somebody's repository would be enough for that repository
 * to grant itself merge rights on your machine. A committed
 * `.agentic-army.toml` saying `ceiling = 3` would be honoured by a tool that
 * read it, and the attack costs the author one file.
 *
 * So: the repo has no say. Only the human's own machine-local file does.
 *
 * ===========================================================================
 * WHAT THE CEILING IS, AND WHAT IT IS NOT
 * ===========================================================================
 *
 * The ceiling is a **guardrail against accident and prompt-driven drift**. It
 * is NOT a security boundary against a hostile agent that already has shell
 * access on your machine.
 *
 * Be clear about why, because an earlier version of this comment was not.
 * Raising a ceiling requires either a terminal or a direct edit of
 * `~/.agentic-army/config.toml`. The TTY test below is a real speed bump — it
 * stops the naive `army enlist --ceiling 3` — but `process.stdin.isTTY` only
 * answers "is fd 0 a character device", not "is a human present". Anything
 * that can run a command can also run `script`, `expect` or `python3 -c
 * 'import pty'` and get a terminal. Those ship by default nearly everywhere,
 * and an ENGINEER is granted exactly that capability.
 *
 * The boundary that actually holds is the permission layer, not this command:
 *
 *   **Every worker must be denied write access to `~/.agentic-army/**`, by
 *   every route — the CLI, $EDITOR, a shell redirect, `sed -i`, anything.**
 *
 * That deny rule is what makes both raise paths unreachable at once. A worker
 * that CAN write there can raise its own ceiling by editing the file directly,
 * at which point this command's refusal is decoration and the model collapses.
 * See `PROTECTED_CONFIG_GLOBS` in `./init.ts` — the list is exported so the
 * orchestrator can import it rather than re-derive a rule from memory.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { RUNG_MEANING, type Rung } from '../contracts/index.ts';
// Single source of truth for config surgery. This module owns CLI POLICY —
// what may be raised, by whom, and what the user is told — and none of the
// mechanism. `src/setup/**` depending on `src/config/**` is the correct
// direction; a second copy of the TOML editing is how CRLF handling and the
// clamp silently diverged before.
import { clampCeiling, formatProjectEntry, loadConfig, writeProjectCeiling } from '../config/load.ts';
import { armyHome, configPath } from '../config/paths.ts';
import { invokedAs, probe } from './checks.ts';
import {
  NO_COMMITS_IMPACT,
  headExistsArgs,
  initialCommitFix,
  renderFix,
} from './fixes.ts';
import { ensureConfig } from './init.ts';

// ---------------------------------------------------------------------------
// Rungs — the ladder itself is defined in contracts; this module
// only owns how it is parsed from argv and persisted to the global config.
// ---------------------------------------------------------------------------

export type { Rung };

export const DEFAULT_CEILING: Rung = 0;

export type CeilingParse = { ok: true; value: Rung } | { ok: false; error: string };

/**
 * Parse a `--ceiling` argument. Unlike `clampCeiling` this REJECTS rather than
 * clamps: a human typing `--ceiling 5` has misunderstood something and should
 * be told, not silently given 3.
 */
export function parseCeiling(raw: string | undefined): CeilingParse {
  if (raw === undefined || raw.trim() === '') {
    return { ok: false, error: '--ceiling needs a value: 0, 1, 2, or 3' };
  }
  const trimmed = raw.trim();
  // ONE refusal sentence for every bad value. `9` used to get "must be between 0 and 3" while
  // `banana` got "must be an integer 0..3" — two spellings for one rule read as two rules, and
  // the pair could drift apart because they were two sites.
  const n = /^-?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    return { ok: false, error: `--ceiling must be an integer 0..3, got ${JSON.stringify(trimmed)}` };
  }
  return { ok: true, value: n as Rung };
}

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

/**
 * `reason` lets a caller act on WHY the lookup failed without parsing `error`. `enlistCommand`
 * needs exactly that: auto-init is right for `no-repo` and wrong for the other three — creating a
 * repository because `git` timed out would be inventing consent nobody gave. `error` and `fix`
 * stay byte-for-byte what they were before this discriminator existed, so no existing output moves.
 */
export type RepoLookup =
  | { ok: true; root: string }
  | { ok: false; error: string; fix: string; reason: 'git-missing' | 'git-timeout' | 'no-repo' | 'git-silent' };

/**
 * Derive the MAIN repository root from git's common dir.
 *
 * This is the fix for a real escalation path. `git rev-parse --show-toplevel`
 * returns the *worktree* root, and inside a linked worktree that is a different
 * absolute path from the main checkout — so it becomes a brand-new key in
 * `[projects]`, with a brand-new ceiling, and the ratchet never fires because
 * there is nothing to ratchet against.
 *
 * That is not an exotic attack. Every Engineer gets its own worktree, so a
 * linked worktree is the normal working directory of every agent in the
 * system.
 *
 * `--git-common-dir` is shared by the main checkout and all of its linked
 * worktrees — it is the main repo's `.git` — so keying on it collapses them all
 * to one entry.
 *
 *   /repo/.git            (main checkout, or any worktree of it)  -> /repo
 *   /repo/bare.git        (bare repo: no worktree above it)       -> /repo/bare.git
 */
export function mainRootFromCommonDir(commonDir: string): string {
  const resolved = path.resolve(commonDir);
  return path.basename(resolved) === '.git' ? path.dirname(resolved) : resolved;
}

/** Collapse symlinks so two routes to the same repo cannot become two keys. */
async function physicalPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

export async function currentRepoRoot(): Promise<RepoLookup> {
  // Deliberately NOT --show-toplevel; see mainRootFromCommonDir above.
  let result = await probe('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], 5000);
  if (!result.found) {
    return { ok: false, error: 'git is not on PATH', fix: `${invokedAs()} doctor`, reason: 'git-missing' };
  }
  if (result.timedOut) {
    return { ok: false, error: 'git timed out', fix: `${invokedAs()} doctor`, reason: 'git-timeout' };
  }
  if (result.code !== 0) {
    // --path-format arrived in git 2.31 but our floor is 2.20 (worktree
    // support). Older git still answers --git-common-dir, just possibly with a
    // path relative to cwd, which path.resolve below handles.
    result = await probe('git', ['rev-parse', '--git-common-dir'], 5000);
  }
  if (result.code !== 0) {
    return {
      ok: false,
      error: `${process.cwd()} is not inside a git repository`,
      fix: 'cd into a repository first, or run `git init`',
      reason: 'no-repo',
    };
  }
  const commonDir = result.stdout.trim().split('\n')[0] ?? '';
  if (commonDir === '') {
    return { ok: false, error: 'git returned no repository root', fix: `${invokedAs()} doctor`, reason: 'git-silent' };
  }
  // git prints forward slashes even on Windows; path.resolve normalises so the
  // config key is the same string every time on a given machine.
  return { ok: true, root: await physicalPath(mainRootFromCommonDir(commonDir)) };
}

// ---------------------------------------------------------------------------
// Auto-init
// ---------------------------------------------------------------------------

/**
 * Whether `enlist` should turn a bare directory into a repository, or refuse and say why.
 *
 * A pure function so the two guards are testable without spawning git. Only two directories are
 * refused, deliberately narrow: a directory nested under `$HOME` is where every ordinary project
 * lives, and treating "under home" as dangerous would make the common case refuse.
 *
 *   - `os.homedir()` itself: `git init` there does not scope to a project, it scopes to
 *     everything the user owns. The first `git add .` or accidental commit would start pulling in
 *     unrelated directories underneath it.
 *   - a filesystem root: nothing meaningful is ever the repository root at `/` or `C:\`; landing
 *     here is a wrong `cd`, not an intentional new project.
 *
 * `home` is a parameter rather than read from `os.homedir()` internally so a test can point it at
 * a temp directory without touching the real one.
 */
export type AutoInitDecision = { kind: 'init'; dir: string } | { kind: 'refuse'; reason: string };

export function decideAutoInit(dir: string, home: string): AutoInitDecision {
  const resolvedDir = path.resolve(dir);
  const resolvedHome = path.resolve(home);
  if (resolvedDir === resolvedHome) {
    return {
      kind: 'refuse',
      reason:
        `${resolvedDir} is your home directory. Initialising a repository here would make every ` +
        `directory beneath ${resolvedHome} part of one repository, not just the project you meant ` +
        'to enlist. cd into the project directory first, or run `git init` there yourself.',
    };
  }
  const root = path.parse(resolvedDir).root;
  if (resolvedDir === root) {
    return {
      kind: 'refuse',
      reason:
        `${resolvedDir} is a filesystem root, not a project directory. Initialising a repository ` +
        'here is almost certainly the wrong directory. cd into the project directory first, or ' +
        'run `git init` there yourself.',
    };
  }
  return { kind: 'init', dir: resolvedDir };
}

/**
 * `git init` and the empty commit `campaign` needs, run through the same `probe` seam as every
 * other git call in this file. Both steps are reported so the caller can tell "no repository" (the
 * init failed, fatal) from "repository exists but nothing to detach a lease to" (the commit
 * failed, a warning `enlistCommand` already knows how to print). The usual cause of the second is
 * a machine with no `user.email` configured — real, and not a reason to refuse the enlistment.
 *
 * Deliberately does not `git add` anything first: an auto-init that swept up whatever was already
 * sitting in the directory would be a surprise commit of files the user never asked to track.
 */
export type AutoInitOutcome = { ok: true; committed: boolean } | { ok: false; error: string };

export async function autoInitRepo(dir?: string): Promise<AutoInitOutcome> {
  // `dir` exists for `chat` and `campaign`, whose `--cwd` need not be this process's working
  // directory. Without `-C`, their auto-init would land the repository wherever the CLI happened
  // to be launched from — a directory the user never pointed the command at. `enlist` keeps
  // calling with no argument, so its behaviour is byte-for-byte what it was.
  const at = dir === undefined ? [] : ['-C', dir];
  const init = await probe('git', [...at, 'init', '-q'], 5000);
  if (!init.found || init.timedOut || init.code !== 0) {
    const detail = init.stderr.trim();
    return { ok: false, error: `git init failed${detail === '' ? '' : `: ${detail}`}` };
  }
  const commit = await probe('git', [...at, 'commit', '--allow-empty', '-m', 'init'], 5000);
  return { ok: true, committed: !commit.timedOut && commit.code === 0 };
}

/**
 * Has this repository ever committed?
 *
 * WARN, NEVER BLOCK. Enlisting a repository you are about to populate is a legitimate and
 * ordinary thing to do — `git init && army enlist` before writing a line is exactly how a new
 * project starts — so refusing here would be wrong. But `enlist` knows enough to ask, and not
 * asking is why the Commander found out one command later, from `campaign`, in the form of an
 * abort.
 *
 * A tri-state on purpose. `false` is "git answered, and there is no HEAD"; `null` is "git could
 * not be asked" — a missing binary, a timeout — and a warning invented from a question that was
 * never answered is noise a user learns to skim past.
 */
export async function repoHasCommits(root: string): Promise<boolean | null> {
  const result = await probe('git', headExistsArgs(root), 5000);
  if (!result.found || result.timedOut || result.code === null) return null;
  return result.code === 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type EnlistArgs =
  | { ok: true; ceiling: Rung | null; init: boolean }
  | { ok: false; error: string };

export function parseEnlistArgs(argv: readonly string[]): EnlistArgs {
  let ceiling: Rung | null = null;
  let init = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--ceiling') {
      const parsed = parseCeiling(argv[i + 1]);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      ceiling = parsed.value;
      i += 1;
    } else if (arg.startsWith('--ceiling=')) {
      const parsed = parseCeiling(arg.slice('--ceiling='.length));
      if (!parsed.ok) return { ok: false, error: parsed.error };
      ceiling = parsed.value;
    } else if (arg === '--no-init') {
      init = false;
    } else if (arg.startsWith('-')) {
      return { ok: false, error: `unknown option ${arg}` };
    } else {
      return { ok: false, error: `unexpected argument ${JSON.stringify(arg)} — enlist takes no positional arguments` };
    }
  }
  return { ok: true, ceiling, init };
}

// ---------------------------------------------------------------------------
// The raise policy
// ---------------------------------------------------------------------------

/**
 * What `enlist` should do, given the recorded ceiling, the requested one, and
 * whether a human is actually present.
 *
 * The rule: **a ceiling may only be raised from a real terminal.** Lowering is
 * always allowed, from anywhere, because reducing blast radius is never the
 * dangerous direction.
 *
 * Scope this honestly. `process.stdin.isTTY` stops the naive path — a piped,
 * redirected or `setsid` invocation is refused — and it costs nothing. It is
 * not a human-detector: `script`, `expect` and `python3 -c 'import pty'` all
 * allocate a terminal, and all of them are one command away from anything
 * holding Bash. Treat this as a guardrail against accident and prompt-driven
 * drift, and rely on the `~/.agentic-army/**` write deny (see the module
 * docblock) for the actual boundary.
 *
 * An absent project counts as ceiling 0, so this applies to the FIRST
 * registration too. Otherwise a fresh repo reached before the human could be
 * enlisted straight at 3 with nothing to ratchet from.
 */
export type CeilingDecision =
  | { kind: 'register'; target: Rung }
  | { kind: 'raise'; target: Rung; from: Rung }
  | { kind: 'lower'; target: Rung; from: Rung }
  | { kind: 'unchanged'; target: Rung }
  | { kind: 'refused'; requested: Rung; from: Rung };

export function decideCeiling(
  existing: Rung | null,
  requested: Rung | null,
  interactive: boolean,
): CeilingDecision {
  // Fail closed: a project we have never seen has no authority, i.e. 0.
  const from = existing ?? DEFAULT_CEILING;
  const target: Rung = requested ?? existing ?? DEFAULT_CEILING;

  if (target > from) {
    if (!interactive) return { kind: 'refused', requested: target, from };
    return existing === null ? { kind: 'register', target } : { kind: 'raise', target, from };
  }
  if (existing === null) return { kind: 'register', target };
  if (target < from) return { kind: 'lower', target, from };
  return { kind: 'unchanged', target };
}

/**
 * Where this command's output goes, and whether a human is at the keyboard.
 *
 * An injection seam rather than a test-only convenience, and it replaced something actively
 * dangerous. The test for this command used to capture output by REASSIGNING
 * `process.stdout.write` for the duration of the call. `node:test` runs suites concurrently, so
 * that patch swallowed the test runner's OWN reporter output for whatever happened to be
 * running at the same time — silently deleting other suites' results from the report, and, worse,
 * turning a real assertion failure elsewhere into a bare `'test failed'` with no diagnostic.
 * A test harness that can hide a failure is not a harness.
 *
 * Defaults are the real streams and the real TTY, so `src/cli.ts` calls this exactly as before.
 */
export type EnlistDeps = {
  out?: (chunk: string) => void;
  err?: (chunk: string) => void;
  /** Defaults to `process.stdin.isTTY === true`. See `decideCeiling` for why this matters. */
  interactive?: boolean;
};

export async function enlistCommand(
  argv: readonly string[],
  deps: EnlistDeps = {},
): Promise<number> {
  const out = deps.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const err = deps.err ?? ((chunk: string) => void process.stderr.write(chunk));
  // Resolved once. Every string below names a command to type, and naming one the reader does
  // not have is the whole defect this replaced.
  const self = invokedAs();
  const args = parseEnlistArgs(argv);
  if (!args.ok) {
    // The Try-form every other subcommand refuses with — a Usage dump here was the one place in
    // the CLI where the same mistake earned a different grammar, and `--help` documents the
    // flags the old one-line usage omitted.
    err(`${self} enlist: ${args.error}\nTry \`${self} enlist --help\`.\n`);
    return 1;
  }

  let repo = await currentRepoRoot();
  if (!repo.ok && repo.reason === 'no-repo' && args.init) {
    const decision = decideAutoInit(process.cwd(), os.homedir());
    if (decision.kind === 'refuse') {
      err(`${self} enlist: ${decision.reason}\n`);
      return 1;
    }
    const outcome = await autoInitRepo();
    if (!outcome.ok) {
      err(`${self} enlist: ${outcome.error}\n`);
      return 1;
    }
    out(`\n  created a git repository in ${decision.dir}\n`);
    // Re-derive rather than trust `decision.dir`: the real root goes through
    // `mainRootFromCommonDir` and `fs.realpath`, and shortcutting that here is how it would
    // silently diverge from every other route to a repo root in this file.
    repo = await currentRepoRoot();
  }
  if (!repo.ok) {
    err(`${self} enlist: ${repo.error}\n  fix: ${repo.fix}\n`);
    return 1;
  }

  const home = armyHome();
  await ensureConfig(home);
  const cfgPath = configPath(home);

  let existing: Rung | null;
  try {
    const loaded = await loadConfig({ home });
    const policy = loaded.config.projects[repo.root];
    // clampCeiling on the way in as well: `loadConfig` already clamps, but the
    // decision below is the one that grants authority, so it reads defensively.
    existing = policy === undefined ? null : clampCeiling(policy.ceiling);
  } catch (e) {
    err(
      `${self} enlist: cannot read ${cfgPath} (${(e as Error).message}).\n` +
        '  Fix the file by hand; enlist will not rewrite a config it cannot parse.\n',
    );
    return 1;
  }

  const requested = args.ceiling;
  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  const decision = decideCeiling(existing, requested, interactive);

  if (decision.kind === 'refused') {
    err(
      `\n${self} enlist: refusing to raise the ceiling for ${repo.root} ` +
        `from ${decision.from} to ${decision.requested}.\n\n` +
        '  Raising a ceiling needs a terminal, and stdin here is not one.\n\n' +
        `  To raise it, edit ${cfgPath} by hand so the line reads:\n\n` +
        `      ${formatProjectEntry(repo.root, decision.requested)}\n\n` +
        '  Lowering is always allowed and needs no terminal.\n\n' +
        '  Note this refusal is a guardrail against accident, not a boundary against a\n' +
        '  process that already has shell access — a terminal is one command away. The\n' +
        '  boundary is denying workers write access to the config directory itself.\n\n',
    );
    return 1;
  }

  const target = decision.target;

  // The write itself is mechanism, and mechanism lives in src/config. It
  // verifies the edit round-trips before touching the file, so a corrupt
  // global config cannot take every project's ceiling down with it.
  try {
    await writeProjectCeiling(repo.root, target, { home });
  } catch (e) {
    err(`${self} enlist: ${(e as Error).message}\n`);
    return 1;
  }

  const verb = {
    register: 'enlisted',
    raise: 'ceiling raised for',
    lower: 'ceiling lowered for',
    unchanged: 'already enlisted',
  }[decision.kind];
  out(`\n  ${verb} ${repo.root}\n`);
  out(`  delivery ceiling ${target} — ${RUNG_MEANING[target]}\n`);
  out(`  recorded in ${cfgPath}\n`);
  if (target === 0 && requested === null && existing === null) {
    out(
      '\n  Defaulted to 0. A campaign here will commit to the army mirror and touch\n' +
        `  nothing in your repo. Raise it later with \`${self} enlist --ceiling N\` from a\n` +
        '  terminal, or by editing the config by hand.\n',
    );
  }

  // The repository is registered either way — this is the last thing said, not a gate. It goes to
  // `out` rather than `err` because the command SUCCEEDED and this is a fact about the thing it
  // just registered; splitting one outcome across two streams is how a reader loses half of it to
  // a redirect.
  if ((await repoHasCommits(repo.root)) === false) {
    out(
      `\n  ⚠ ${repo.root} has no commits yet.\n` +
        `    ${NO_COMMITS_IMPACT}\n` +
        `    ${renderFix(initialCommitFix(repo.root))}\n`,
    );
  }
  out('\n');
  return 0;
}
