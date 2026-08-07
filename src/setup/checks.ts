/**
 * Environment checks for `army doctor`.
 *
 * Every failure mode in this system is environmental, so this module is
 * deliberately the most paranoid code in the package:
 *
 *   - The *classification* half is pure. Every `classify*` function takes an
 *     already-collected probe result and returns a verdict, so the interesting
 *     logic is unit-testable without caring what happens to be installed on the
 *     machine running the tests.
 *   - The *probing* half never hangs. Every subprocess has a soft timeout that
 *     SIGKILLs the whole process group and a hard backstop that settles the
 *     promise, closes our end of the pipes and unrefs the child — so a stray
 *     grandchild cannot keep the CLI alive after it has already reported. No
 *     call ever goes through a shell on POSIX.
 *   - It works on Windows. Binaries are located by walking PATH/PATHEXT
 *     ourselves rather than shelling out to `which`/`where`, and a resolved
 *     `.cmd`/`.bat` shim is invoked through cmd.exe because Node refuses to
 *     spawn those without a shell.
 *
 * Exactly three outcomes, and each one owes the user something specific:
 *   ok        -> nothing
 *   degraded  -> what capability is lost
 *   blocking  -> the exact command that fixes it
 *
 * This module also owns `invokedAs()` — see the block above it. Every command that suggests a
 * next step routes through it, because a suggestion the reader cannot run is worse than none.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { installWarningFilter } from '../archive/db.ts';
// Static rather than lazy, and deliberately so: `src/cli.ts` already pulls `config/load.ts` in
// through `enlist.ts` before any command runs, so this import adds nothing to doctor's startup.
import { CONFIG_FIX_BY_HAND, parseConfig } from '../config/load.ts';
import {
  armyHome,
  configPath,
  normalizePathForCompare as normalizePath,
  realpathOrResolve,
  samePath,
  worktreesRootFor,
} from '../config/paths.ts';
// The pool's OWN parser and its OWN liveness rule, imported rather than re-implemented: two
// readers of one on-disk lease format is how doctor and the acquire path end up disagreeing
// about whether a slot is held. `cold.ts` pulls in nothing heavier than `delivery/git`, which
// this module's probes conceptually sit beside anyway.
import { leaseLiveness, readLeaseRecord } from '../worktree/cold.ts';
import type { ColdLeaseRecord, LeaseLivenessVerdict } from '../worktree/cold.ts';

import { quoteArg } from './shell.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The only three verdicts a check may return. */
export type Outcome = 'ok' | 'degraded' | 'blocking';

export type CheckId =
  | 'node'
  | 'git'
  | 'claude'
  | 'anthropic-api-key'
  | 'codex'
  | 'gh'
  | 'worktree-pool'
  | 'stale-worktree-pool'
  | 'worktree-leases'
  | 'home'
  | 'config'
  | 'sqlite';

export type CheckResult = {
  id: CheckId;
  title: string;
  outcome: Outcome;
  /** What we actually observed. Always populated. */
  found: string;
  /** degraded only: the capability that is lost. Required by contract. */
  impact?: string;
  /** blocking only: the exact command to run. Required by contract. */
  fix?: string;
  /** Extra colour — reference to the design section, caveats, etc. */
  note?: string;
  /** Parsed version, when the check had one. */
  version?: string;
};

export type ProbeResult = {
  /** Did the binary resolve on PATH at all? */
  found: boolean;
  /** Absolute path we resolved to, if any. */
  path: string | null;
  /** Process exit code. null if it never ran or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn-level failure message, if any. */
  error: string | null;
};

export type Version = { major: number; minor: number; patch: number };

// ---------------------------------------------------------------------------
// Minimum versions — every one of these is load-bearing, see the note on each.
// ---------------------------------------------------------------------------

export const MIN_NODE = '20.0.0';
/** `git worktree` is only usable from 2.20 onward. */
export const MIN_GIT = '2.20.0';
/**
 * 2.1.211 introduced `--forward-subagent-text`; 2.1.219 is the first version
 * that forwards it at *every* nesting depth, which is what makes the whole org
 * chart reconstructible from one stream. Below that floor the
 * supervisor silently loses everything under a Sergeant.
 */
export const MIN_CLAUDE = '2.1.219';

// ---------------------------------------------------------------------------
// Version parsing / comparison — pure, and the single most tested thing here.
// ---------------------------------------------------------------------------

const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/;

/**
 * Pull a version out of whatever a CLI decided to print. Handles all of:
 *   "2.1.220 (Claude Code)"      -> 2.1.220
 *   "git version 2.53.0"         -> 2.53.0
 *   "codex-cli 0.142.5"          -> 0.142.5
 *   "gh version 2.96.0 (2026-07-02)\nhttps://..." -> 2.96.0
 *   "v24.14.1"                   -> 24.14.1
 *   "1.2"                        -> 1.2.0
 *   "3.0.0-beta.4"               -> 3.0.0
 * Returns null when there is no version-shaped token at all.
 */
export function parseVersion(raw: string | null | undefined): Version | null {
  if (typeof raw !== 'string') return null;
  const m = VERSION_RE.exec(raw);
  if (m === null) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = m[3] === undefined ? 0 : Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Standard comparator: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * True when `raw` parses to a version >= `minimum`. False when it does not
 * parse — an unreadable version is treated as "does not meet the floor",
 * because guessing optimistically here is how you end up debugging a silently
 * truncated agent tree three days later.
 */
export function satisfiesMinimum(raw: string | null | undefined, minimum: string): boolean {
  const got = parseVersion(raw);
  const min = parseVersion(minimum);
  if (got === null || min === null) return false;
  return compareVersions(got, min) >= 0;
}

// ---------------------------------------------------------------------------
// Outcome aggregation
// ---------------------------------------------------------------------------

export function worstOutcome(results: readonly CheckResult[]): Outcome {
  if (results.some((r) => r.outcome === 'blocking')) return 'blocking';
  if (results.some((r) => r.outcome === 'degraded')) return 'degraded';
  return 'ok';
}

export function countOutcomes(results: readonly CheckResult[]): Record<Outcome, number> {
  const counts: Record<Outcome, number> = { ok: 0, degraded: 0, blocking: 0 };
  for (const r of results) counts[r.outcome] += 1;
  return counts;
}

/** 0 when nothing is blocking, 1 otherwise. Doctor is CI-usable. */
export function exitCodeFor(results: readonly CheckResult[]): 0 | 1 {
  return results.some((r) => r.outcome === 'blocking') ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Install hints — platform aware, because "install git" is not a command.
// ---------------------------------------------------------------------------

type Platform = NodeJS.Platform;

export function installHint(tool: CheckId, platform: Platform = process.platform): string {
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  switch (tool) {
    case 'node':
      if (win) return 'winget install --id OpenJS.NodeJS.LTS';
      if (mac) return 'brew install node    # or: https://nodejs.org/en/download';
      return 'https://nodejs.org/en/download';
    case 'git':
      if (win) return 'winget install --id Git.Git';
      if (mac) return 'xcode-select --install    # or: brew install git';
      return 'sudo apt-get install git    # or your distro equivalent';
    case 'claude':
      return 'npm install -g @anthropic-ai/claude-code@latest';
    case 'codex':
      return 'npm install -g @openai/codex@latest';
    case 'gh':
      if (win) return 'winget install --id GitHub.cli';
      if (mac) return 'brew install gh';
      return 'https://github.com/cli/cli#installation';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// How the user actually invoked us
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 * Never print a command the reader cannot run.
 * ===========================================================================
 *
 * Every suggestion in this package used to be hardcoded `army …`. That is right for exactly one
 * audience — someone who has already run `npm i -g agentic-army` — and wrong for every path the
 * README actually advertises first:
 *
 *     npx agentic-army doctor          # "Try it without installing"
 *     npm run dev -- doctor            # the documented development loop
 *     node src/cli.ts init             # a checkout, no install at all
 *
 * In all three the tool printed `Next: run \`army enlist\``, and `army` was not on PATH. A
 * first-run experience that ends in `command not found` is worse than no suggestion at all,
 * because the reader's next move is to doubt the install rather than the message.
 *
 * So the form is DERIVED, from signals that cannot lie about what is on this machine, rather
 * than assumed. Priority order below; the first match wins, and each rule is only allowed to
 * fire on evidence that the corresponding command would genuinely work.
 */
export type InvocationForm = 'army' | 'npx' | 'npm-script' | 'node-script';

export type Invocation = {
  form: InvocationForm;
  /** The exact prefix to print, e.g. `army`, `npx agentic-army`, `node src/cli.ts`. */
  command: string;
  /** Why this form was chosen — surfaced by `army doctor --json`, and by tests. */
  reason: string;
};

/** Everything `detectInvocation` reads. Injected whole so tests never depend on the ambient shell. */
export type InvocationContext = {
  /** `process.argv[1]` — the script Node was pointed at. */
  argv1?: string | undefined;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: Platform;
  /** Defaults to `resolveBinarySync`. */
  resolve?: (name: string, env: NodeJS.ProcessEnv, platform: Platform) => string | null;
  /** Defaults to `fs.realpathSync`, falling back to the input on failure. */
  realpath?: (target: string) => string;
};

/** The npm `bin` name and package name. Kept together so a rename cannot desync the two forms. */
export const BIN_NAME = 'army';
export const PACKAGE_NAME = 'agentic-army';

/** Index of the `node_modules/<PACKAGE_NAME>` segment pair, or -1. */
function packageSegment(scriptPath: string): { parts: string[]; index: number } {
  const parts = scriptPath.split(/[\\/]/);
  const i = parts.lastIndexOf('node_modules');
  return { parts, index: i >= 0 && parts[i + 1] === PACKAGE_NAME ? i : -1 };
}

/** `/…/node_modules/agentic-army/dist/cli.js` — i.e. we are running from an installed copy. */
function isInstalledCopy(scriptPath: string): boolean {
  return packageSegment(scriptPath).index >= 0;
}

/** `…/node_modules/agentic-army/dist/cli.js` -> `…/node_modules/agentic-army`, else null. */
function packageRootOf(scriptPath: string): string | null {
  const { parts, index } = packageSegment(scriptPath);
  return index < 0 ? null : parts.slice(0, index + 2).join('/');
}

/**
 * ===========================================================================================
 * Is the `army` on PATH THIS install, or somebody else's?
 * ===========================================================================================
 *
 * Matching on the NAME is not good enough, and shipping that was the bug. A stale global from
 * six months ago, a colleague's fork, or an unrelated program called `army` all resolve on PATH,
 * and printing a bare `army` in front of a suggestion then sends the reader to a DIFFERENT
 * binary than the one that printed it. That is worse than `command not found`, because it
 * appears to work.
 *
 * So identity is resolved, not assumed, by three pieces of evidence in decreasing strength:
 *
 *  1. **Same file after `realpath`.** npm links bins with a symlink on POSIX, so a genuine
 *     global or `npm link` install resolves to exactly the script now executing. Exact, and it
 *     covers the overwhelming majority of real installs.
 *  2. **The launcher lives inside our own package directory** — some installers copy rather than
 *     symlink, and a copy inside `node_modules/agentic-army/` is still unambiguously ours.
 *  3. **Windows shim layout.** npm writes `army.cmd` / `army.ps1` next to the `node_modules`
 *     holding the package, and `realpath` cannot follow a batch shim to its target, so the
 *     layout is the only evidence available. Deliberately gated to win32: on POSIX this
 *     directory relationship does not hold (`<prefix>/bin/army` vs `<prefix>/lib/node_modules`)
 *     and admitting it there would only re-open the hole rule 1 already closes properly.
 *
 * Anything else is somebody else's binary, and the caller must fall back to a path form.
 */
function isSameInstall(
  binOnPath: string,
  scriptPath: string,
  platform: Platform,
  realpath: (target: string) => string,
): boolean {
  const bin = realpath(binOnPath);
  const script = realpath(scriptPath);

  if (samePath(bin, script, platform)) return true;

  const pkg = packageRootOf(script);
  if (pkg === null) return false;

  const binNorm = normalizePath(bin, platform);
  if (binNorm.startsWith(`${normalizePath(pkg, platform)}/`)) return true;

  if (platform === 'win32') {
    const { parts, index } = packageSegment(script);
    const prefix = parts.slice(0, index).join('/');
    const binDir = bin.split(/[\\/]/).slice(0, -1).join('/');
    if (prefix !== '' && samePath(binDir, prefix, platform)) return true;
  }

  return false;
}

/**
 * npx leaves a cache directory in the path (`~/.npm/_npx/<hash>/node_modules/.bin/army`) and,
 * since npm 7, sets `npm_command=exec`. Either is conclusive; neither is set by a plain install.
 */
function looksLikeNpx(scriptPath: string, env: NodeJS.ProcessEnv): boolean {
  if (scriptPath.split(/[\\/]/).includes('_npx')) return true;
  if (env['npm_command'] === 'exec') return true;
  const execPath = env['npm_execpath'];
  return execPath !== undefined && /(^|[\\/])npx(\.[a-z]+)?$/i.test(execPath);
}

/** `npm` / `pnpm` / `yarn`, from whichever of the two agent variables is present. */
function packageManager(env: NodeJS.ProcessEnv): string {
  const agent = env['npm_config_user_agent'] ?? '';
  if (agent.startsWith('pnpm')) return 'pnpm';
  if (agent.startsWith('yarn')) return 'yarn';
  const execPath = env['npm_execpath'] ?? '';
  if (/pnpm/i.test(execPath)) return 'pnpm';
  if (/yarn/i.test(execPath)) return 'yarn';
  return 'npm';
}

/**
 * Are we running as the body of the npm script named by `npm_lifecycle_event`?
 *
 * `npm_lifecycle_event` alone is NOT sufficient and getting this wrong is easy: it is inherited
 * by every descendant, so a `node src/cli.ts init` buried inside `npm run build` would otherwise
 * be told to re-run itself as `npm run build --`. `npm_lifecycle_script` carries the script's
 * actual text, so requiring it to mention the file we are executing removes the false positive.
 */
function npmScriptFor(scriptPath: string, env: NodeJS.ProcessEnv, p: path.PlatformPath): string | null {
  const event = env['npm_lifecycle_event'];
  const script = env['npm_lifecycle_script'];
  if (event === undefined || event === '' || script === undefined) return null;
  const base = p.basename(scriptPath);
  if (base !== '' && script.includes(base)) return event;
  // A global-style install run through a script: the script invokes the bin by name.
  if (new RegExp(`(^|\\s)${BIN_NAME}(\\s|$)`).test(script)) return event;
  return null;
}

/**
 * Work out the command prefix that will actually run on this machine, right now.
 *
 * Pure with respect to its context argument, so every branch is testable without installing
 * anything, setting an env var, or owning a Windows box.
 */
export function detectInvocation(ctx: InvocationContext = {}): Invocation {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const cwd = ctx.cwd ?? process.cwd();
  const resolve = ctx.resolve ?? resolveBinarySync;
  const realpath = ctx.realpath ?? realpathOrResolve;
  const argv1 = ctx.argv1 ?? process.argv[1];

  // Path SEMANTICS follow the target platform, not the host running this code. `C:\…` is an
  // absolute path on Windows and a relative one everywhere else, so resolving a Windows path
  // with POSIX rules silently prefixes it with the current directory and every subsequent
  // comparison is against a path that does not exist. On a real machine `platform` is
  // `process.platform` and this is a no-op; it is what makes the Windows branches testable —
  // and therefore what makes them true rather than merely written down.
  const p: path.PlatformPath = platform === 'win32' ? path.win32 : path.posix;

  // Embedded, bundled, or a REPL: no script to point at, so name the bin and hope. This is the
  // only branch that guesses, and it is unreachable from any supported invocation.
  if (argv1 === undefined || argv1 === '') {
    return { form: 'army', command: BIN_NAME, reason: 'no script path in argv' };
  }

  const scriptPath = p.resolve(argv1);
  const onPath = resolve(BIN_NAME, env, platform);

  // 1. npx. Checked before the PATH lookup: `npx agentic-army` works whether or not a global
  //    `army` exists, and if one does exist it may well be a different version than the one
  //    currently running, so echoing the user's own form is both safer and more truthful.
  if (looksLikeNpx(scriptPath, env)) {
    return {
      form: 'npx',
      command: `npx ${PACKAGE_NAME}`,
      reason: 'running from the npx cache',
    };
  }

  // 2. `army` on PATH, and it is provably THIS install — never merely a binary of that name.
  //    See `isSameInstall`: a foreign `army` earlier on PATH must not be advertised, because the
  //    reader would then run a different program than the one that printed the suggestion.
  const shadowed = onPath !== null && !isSameInstall(onPath, scriptPath, platform, realpath);
  if (onPath !== null && !shadowed) {
    return {
      form: 'army',
      command: BIN_NAME,
      reason: `${BIN_NAME} resolves on PATH to this install (${onPath})`,
    };
  }

  // 3. An npm/pnpm/yarn script. `--` is mandatory: without it the package manager eats the flags.
  const event = npmScriptFor(scriptPath, env, p);
  if (event !== null) {
    const pm = packageManager(env);
    return {
      form: 'npm-script',
      // `yarn run x -- args` is the portable spelling across yarn 1 and berry.
      command: `${pm} run ${event} --`,
      reason: `running as the \`${event}\` script of ${pm}`,
    };
  }

  // 4. Anything else — a checkout, or an installed copy whose name is taken on PATH by someone
  //    else's binary. Echo back a path that can only mean this program.
  //
  //    Relative when the script is under the working directory, because that is how it was typed
  //    and it survives being pasted into the same shell. ABSOLUTE whenever another `army` is
  //    shadowing us: that is precisely the situation where an ambiguous command is dangerous, so
  //    the suggestion is made unambiguous even at the cost of a long line.
  const relative = p.relative(cwd, scriptPath);
  const useRelative =
    !shadowed && relative !== '' && !relative.startsWith('..') && !p.isAbsolute(relative);
  return {
    form: 'node-script',
    command: `node ${quoteArg(useRelative ? relative : scriptPath, platform)}`,
    reason: shadowed
      ? `a different ${BIN_NAME} owns that name on PATH (${String(onPath)}), so the full path is ` +
        'the only unambiguous way to name this install'
      : 'invoked as a script path, with no install to shorten it to',
  };
}

let cachedInvocation: Invocation | null = null;

/**
 * The command prefix to print in front of every suggested next step.
 *
 * Memoised: nothing that feeds it can change within a process, and it is called from render
 * paths that run per line. Exported for `src/cli.ts`, whose help text has the same obligation.
 */
export function invokedAs(): string {
  cachedInvocation ??= detectInvocation();
  return cachedInvocation.command;
}

/**
 * The full verdict, including WHY that form was chosen.
 *
 * `army doctor --json` is the place a confused user's paste actually lands, and "which form did
 * it think I was using, and on what evidence" is the first question when a suggestion looks
 * wrong. Cheap to expose; expensive to reconstruct from a screenshot.
 */
export function invocation(): Invocation {
  cachedInvocation ??= detectInvocation();
  return cachedInvocation;
}

// ---------------------------------------------------------------------------
// Classifiers — PURE. Tests drive these with stub probes.
// ---------------------------------------------------------------------------

/** Convenience for tests and for callers assembling a partial probe. */
export function stubProbe(patch: Partial<ProbeResult> = {}): ProbeResult {
  return {
    found: false,
    path: null,
    code: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    error: null,
    ...patch,
  };
}

/** Combined output. Some CLIs print their version to stderr. */
function output(p: ProbeResult): string {
  return `${p.stdout}\n${p.stderr}`.trim();
}

function missingBinary(p: ProbeResult): boolean {
  return !p.found || p.timedOut || (p.code !== 0 && parseVersion(output(p)) === null);
}

export function classifyNode(nodeVersion: string, platform: Platform = process.platform): CheckResult {
  const v = parseVersion(nodeVersion);
  const base = { id: 'node' as const, title: 'node >= 20' };
  if (v === null) {
    return {
      ...base,
      outcome: 'blocking',
      found: `unparseable version ${JSON.stringify(nodeVersion)}`,
      fix: installHint('node', platform),
    };
  }
  if (!satisfiesMinimum(nodeVersion, MIN_NODE)) {
    return {
      ...base,
      outcome: 'blocking',
      found: formatVersion(v),
      version: formatVersion(v),
      fix: installHint('node', platform),
      note: `agentic-army requires Node >= ${MIN_NODE}.`,
    };
  }
  return { ...base, outcome: 'ok', found: formatVersion(v), version: formatVersion(v) };
}

export function classifyGit(p: ProbeResult, platform: Platform = process.platform): CheckResult {
  const base = { id: 'git' as const, title: `git >= ${MIN_GIT}` };
  if (missingBinary(p)) {
    return {
      ...base,
      outcome: 'blocking',
      found: p.timedOut ? 'timed out' : 'not found on PATH',
      fix: installHint('git', platform),
      note: 'Worktrees are how Engineers get isolation. Nothing runs without git.',
    };
  }
  const raw = output(p);
  const v = parseVersion(raw);
  if (v === null || !satisfiesMinimum(raw, MIN_GIT)) {
    return {
      ...base,
      outcome: 'blocking',
      found: v === null ? `unrecognised output: ${raw.split('\n')[0] ?? ''}` : formatVersion(v),
      version: v === null ? undefined : formatVersion(v),
      fix: installHint('git', platform),
      note: `git worktree needs >= ${MIN_GIT}.`,
    };
  }
  return { ...base, outcome: 'ok', found: formatVersion(v), version: formatVersion(v) };
}

export function classifyClaude(p: ProbeResult, platform: Platform = process.platform): CheckResult {
  const base = { id: 'claude' as const, title: `claude >= ${MIN_CLAUDE}` };
  if (missingBinary(p)) {
    return {
      ...base,
      outcome: 'blocking',
      found: p.timedOut ? 'timed out' : 'not found on PATH',
      fix: installHint('claude', platform),
      note: 'Engineers and Scouts are Claude processes.',
    };
  }
  const raw = output(p);
  const v = parseVersion(raw);
  if (v === null) {
    return {
      ...base,
      outcome: 'blocking',
      found: `unrecognised output: ${raw.split('\n')[0] ?? ''}`,
      fix: installHint('claude', platform),
    };
  }
  if (!satisfiesMinimum(raw, MIN_CLAUDE)) {
    return {
      ...base,
      outcome: 'blocking',
      found: formatVersion(v),
      version: formatVersion(v),
      fix: installHint('claude', platform),
      note:
        `Below ${MIN_CLAUDE}, --forward-subagent-text does not forward at nested depth, ` +
        'so every agent under a Sergeant vanishes from the stream.',
    };
  }
  return { ...base, outcome: 'ok', found: formatVersion(v), version: formatVersion(v) };
}

/**
 * The quiet killer. An ANTHROPIC_API_KEY in the environment is not an error and
 * nothing will fail loudly — Claude Code will simply prefer it over the OAuth
 * credential store and bill the key. You find out at the end of the month.
 */
export function classifyApiKey(value: string | undefined): CheckResult {
  const id = 'anthropic-api-key' as const;
  if (value === undefined || value.trim() === '') {
    // Title states what is actually true, not what we wish were true: a
    // machine consumer reading `title` must never get the inverse of `found`.
    return {
      id,
      title: 'ANTHROPIC_API_KEY not set',
      outcome: 'ok',
      found: 'not set (correct — OAuth subscription is used)',
    };
  }
  const masked = value.length <= 8 ? '****' : `${value.slice(0, 7)}…${value.slice(-4)}`;
  return {
    id,
    title: 'ANTHROPIC_API_KEY is set — subscription billing bypassed',
    outcome: 'degraded',
    found: `set (${masked})`,
    impact:
      'Subscription billing. Every worker inherits this variable, and Claude Code prefers an ' +
      'API key over the OAuth credential store — so each spawned soldier is billed to the key ' +
      'at API rates instead of drawing on your subscription quota. Nothing fails; nothing warns; ' +
      'you find out on the invoice. Workers are meant to draw on the OAuth subscription login, ' +
      'which is also why we never pass --bare.',
    note:
      process.platform === 'win32'
        ? 'Fix: remove it from this shell with `set ANTHROPIC_API_KEY=` (PowerShell: ' +
          '`Remove-Item Env:ANTHROPIC_API_KEY`) and delete it from your user environment variables.'
        : 'Fix: `unset ANTHROPIC_API_KEY` in this shell, and remove the export from your ' +
          '~/.zshrc / ~/.bashrc / ~/.profile so it does not come back.',
  };
}

export function classifyCodex(
  p: ProbeResult,
  login: ProbeResult | null,
  platform: Platform = process.platform,
): CheckResult {
  const base = { id: 'codex' as const, title: 'codex present' };
  if (missingBinary(p)) {
    return {
      ...base,
      outcome: 'degraded',
      found: p.timedOut ? 'timed out' : 'not found on PATH',
      impact:
        'Cross-vendor review independence. Inspectors and Sentries dispatch to codex ' +
        '; without it every Inspector falls back to the same vendor that wrote ' +
        'the code, so the reviewer shares the builder’s blind spots. You also lose the ' +
        'second quota pool, roughly halving the force you can field.',
      note: `Install: ${installHint('codex', platform)}`,
    };
  }
  const raw = output(p);
  const v = parseVersion(raw);
  const version = v === null ? raw.split('\n')[0] ?? 'present' : formatVersion(v);

  if (login !== null && login.found) {
    const loginOut = output(login);
    // ---------------------------------------------------------------------------------------
    // "not logged in" is only ever reported when codex actually SAID it. This check used to
    // read EVERY non-zero login probe as a logged-out session — a probe killed by the timeout's
    // SIGKILL, a fork that transiently failed under load, a network hiccup inside
    // `codex login status` — and so it flip-flopped between "Logged in" and "not logged in" on
    // machines whose auth never changed. A probe that did not answer is uncertainty, and
    // uncertainty gets its own words; dressing it as a definitive verdict is what trains a user
    // to ignore this line on the day the session really has expired.
    // ---------------------------------------------------------------------------------------
    if (!login.timedOut && login.code === 0) {
      const first = loginOut.split('\n').find((l) => l.trim() !== '') ?? 'logged in';
      return {
        ...base,
        outcome: 'ok',
        found: `${version} — ${first.trim()}`,
        version: v === null ? undefined : formatVersion(v),
      };
    }
    if (!login.timedOut && /not logged in|logged out/i.test(loginOut)) {
      return {
        ...base,
        outcome: 'degraded',
        found: `${version} — not logged in`,
        version: v === null ? undefined : formatVersion(v),
        impact:
          'Inspectors cannot run. codex is installed but unauthenticated, so cross-vendor review ' +
          ' will fail at spawn time rather than at doctor time.',
        note: 'Fix: `codex login`',
      };
    }
    const how = login.timedOut
      ? 'login status check timed out'
      : `login status could not be determined${login.code === null ? '' : ` (exit ${String(login.code)})`}`;
    return {
      ...base,
      outcome: 'degraded',
      found: `${version} — ${how}`,
      version: v === null ? undefined : formatVersion(v),
      impact:
        'Uncertainty, not a verdict: `codex login status` did not answer, so whether Inspectors ' +
        'can dispatch is unknown. Nothing here says your session expired.',
      note:
        'Run `codex login status` yourself; if this machine is just slow, raise the probe budget ' +
        'with `--timeout <ms>`.',
    };
  }

  return {
    ...base,
    outcome: 'ok',
    found: `${version} (login status not determined)`,
    version: v === null ? undefined : formatVersion(v),
  };
}

export function classifyGh(
  version: ProbeResult,
  auth: ProbeResult | null,
  platform: Platform = process.platform,
): CheckResult {
  const base = { id: 'gh' as const, title: 'gh present and authenticated' };
  const cappedAtRung1 =
    'Delivery is capped at rung 1 (push). Rung 2 (pull request) and rung 3 (merge) both go ' +
    'through `gh`, so campaigns will still commit and push, but nothing will be ' +
    'opened or merged for you.';

  if (missingBinary(version)) {
    return {
      ...base,
      outcome: 'degraded',
      found: version.timedOut ? 'timed out' : 'not found on PATH',
      impact: cappedAtRung1,
      note: `Install: ${installHint('gh', platform)}`,
    };
  }
  const raw = output(version);
  const v = parseVersion(raw);
  const shown = v === null ? raw.split('\n')[0] ?? 'present' : formatVersion(v);

  if (auth === null || auth.timedOut || auth.code !== 0) {
    return {
      ...base,
      outcome: 'degraded',
      found: auth !== null && auth.timedOut ? `${shown} — auth check timed out` : `${shown} — not authenticated`,
      version: v === null ? undefined : formatVersion(v),
      impact: cappedAtRung1,
      note: 'Fix: `gh auth login`',
    };
  }
  return {
    ...base,
    outcome: 'ok',
    found: `${shown} — authenticated`,
    version: v === null ? undefined : formatVersion(v),
  };
}

export type DirState = {
  dir: string;
  exists: boolean;
  writable: boolean;
  /** Whether the parent directory is writable, i.e. can we create it. */
  creatable: boolean;
  error: string | null;
  /**
   * An existing path — `dir` itself or an ancestor — that is NOT a directory and therefore makes
   * `dir` impossible to create. Carried explicitly because the FIX depends on it: `mkdir -p`
   * cannot resolve this, and emitting `mkdir -p` anyway hands the user a command that fails.
   */
  blockedBy?: string | null;
};

/** Historical name for `DirState`, kept so callers outside this module do not churn. */
export type HomeState = DirState;

/**
 * A command that ACTUALLY resolves the problem, which is the whole obligation a blocking outcome
 * carries. Two genuinely different situations were being given one answer:
 *
 *   - the directory is missing or unwritable  -> `mkdir -p` + `chmod` is right;
 *   - something that is NOT a directory is sitting on the path -> `mkdir -p` fails with
 *     "File exists", and the user is left holding a command that does not work.
 *
 * The second case moves the offender aside rather than deleting it. Doctor is diagnostic; it
 * must never hand out a command that destroys a file the user may care about, and `.bak` is
 * recoverable where `rm` is not.
 *
 * Every interpolation goes through `quoteArg`, and this line is the reason that matters most in
 * this file. It is the one fix doctor prints that is a WRITE, it is aimed at a directory the user
 * chose the name of, and it is offered to be pasted. Hand-written `"…"` around it — which is what
 * this used to do — leaves `$`, a backtick and `\` live inside the quotes, so a home at
 * `$HOME/army stuff` created a DIFFERENT directory than the one on screen, and a backtick made it
 * run a command. `.bak` was the safety argument for `mv`; it is not a safety argument for `mv`
 * pointed somewhere else.
 */
function mkdirFix(state: DirState, platform: Platform = process.platform): string {
  const win = platform === 'win32';
  const q = (value: string): string => quoteArg(value, platform);
  const dir = q(state.dir);
  const blocker = state.blockedBy ?? null;
  if (blocker !== null) {
    return win
      ? `move ${q(blocker)} ${q(`${blocker}.bak`)} && mkdir ${dir}`
      : `mv ${q(blocker)} ${q(`${blocker}.bak`)} && mkdir -p ${dir}`;
  }
  return win ? `mkdir ${dir}` : `mkdir -p ${dir} && chmod u+rwx ${dir}`;
}

export function classifyHome(state: DirState): CheckResult {
  const base = { id: 'home' as const, title: 'war archive home is writable' };
  if (state.exists && state.writable) {
    return { ...base, outcome: 'ok', found: `${state.dir} (exists, writable)` };
  }
  if (!state.exists && state.creatable) {
    return {
      ...base,
      outcome: 'ok',
      found: `${state.dir} (absent, parent is writable)`,
      note: `Will be created by \`${invokedAs()} init\`.`,
    };
  }
  // When a non-directory is in the way, `reason` already names it; appending `error` as well
  // just says the same sentence twice on a line the user is trying to read quickly.
  const blocked = state.blockedBy != null;
  const reason = state.exists
    ? 'exists but is not writable'
    : blocked
      ? `cannot be created — ${String(state.blockedBy)} exists and is not a directory`
      : 'cannot be created';
  const detail = blocked || state.error === null ? '' : `: ${state.error}`;
  return {
    ...base,
    outcome: 'blocking',
    found: `${state.dir} — ${reason}${detail}`,
    fix: mkdirFix(state),
    note: 'The war archive lives here so reports never pollute your repos.',
  };
}

/** What `inspectConfig` found at `<home>/config.toml`. */
export type ConfigState = {
  file: string;
  /** False when there is no config yet — the pre-`init` state, which is fine. */
  present: boolean;
  /** The read or parse failure, verbatim. null when the file is absent or parses. */
  error: string | null;
};

/**
 * `config.toml` must parse when it exists.
 *
 * This check exists because doctor said "Ready. Full capability." over a config that `enlist`
 * and `campaign` both refused to run against — and a corrupt config is exactly the state a user
 * runs doctor to diagnose. A missing file stays ok: that is the pre-`init` state, not a defect.
 *
 * Blocking, not degraded: every delivery ceiling lives in this file, so nothing that reads one
 * will run until it parses. The fix is `CONFIG_FIX_BY_HAND` — the same sentence the refusing
 * commands print — rather than a pasteable command, because no command repairs hand-broken TOML
 * and inventing one would be worse than saying so.
 */
export function classifyConfig(state: ConfigState): CheckResult {
  const base = { id: 'config' as const, title: 'config.toml parses' };
  if (!state.present) {
    return {
      ...base,
      outcome: 'ok',
      found: `${state.file} (absent)`,
      note: `Will be created by \`${invokedAs()} init\`.`,
    };
  }
  if (state.error === null) {
    return { ...base, outcome: 'ok', found: `${state.file} (parses)` };
  }
  return {
    ...base,
    outcome: 'blocking',
    // The first line carries the diagnosis; a parser's multi-line caret excerpt belongs in
    // `--json`, not wrapped to a terminal column.
    found: state.error.split('\n')[0] ?? state.error,
    fix: CONFIG_FIX_BY_HAND,
    note:
      'Every delivery ceiling and dispatch rule lives in this file, so enlist and campaign ' +
      'refuse to run against it in this state for the same reason.',
  };
}

/**
 * The worktree pool root has to be creatable and writable.
 *
 * This replaced a `treehouse present` check. treehouse was dropped as a dependency: pooling,
 * hooks and warm reuse are ours now, so there is no external binary to look
 * for — and a ⚠ that no action can ever clear is not a warning, it is training people to skim
 * past warnings. What *is* still environmental is this directory: every Engineer and every
 * Inspector works in a leased worktree, so a pool root that cannot be written is not a
 * degradation, it is a machine that cannot field a single agent.
 *
 * Hence blocking rather than degraded. There is no reduced mode to fall back to.
 */
export function classifyWorktreePool(state: DirState): CheckResult {
  const base = { id: 'worktree-pool' as const, title: 'worktree pool root is writable' };
  if (state.exists && state.writable) {
    return { ...base, outcome: 'ok', found: `${state.dir} (exists, writable)` };
  }
  if (!state.exists && state.creatable) {
    return {
      ...base,
      outcome: 'ok',
      found: `${state.dir} (absent, parent is writable)`,
      note: 'Created on the first campaign that leases a tree.',
    };
  }
  // When a non-directory is in the way, `reason` already names it; appending `error` as well
  // just says the same sentence twice on a line the user is trying to read quickly.
  const blocked = state.blockedBy != null;
  const reason = state.exists
    ? 'exists but is not writable'
    : blocked
      ? `cannot be created — ${String(state.blockedBy)} exists and is not a directory`
      : 'cannot be created';
  const detail = blocked || state.error === null ? '' : `: ${state.error}`;
  return {
    ...base,
    outcome: 'blocking',
    found: `${state.dir} — ${reason}${detail}`,
    fix: mkdirFix(state),
    note:
      'Every Engineer and every Inspector works in its own leased worktree, so ' +
      'nothing can be fielded without this directory. `archive_root` in config.toml moves it.',
  };
}

/**
 * A worktree pool left behind at `<home>/worktrees`, the location trees used to live in.
 *
 * Trees moved to the sibling `<home>-trees` because everything under the home is denied to every
 * worker, so an Engineer leased a tree at the old location could not read its own files. Nothing
 * manages the old location any more — which is precisely why this check exists. Those directories
 * are REGISTERED git worktrees of the user's own repositories: `git worktree list` in each of them
 * still names a path the army has forgotten about, and the next `git worktree add` in a repo whose
 * admin entries are stale can fail on a slot name that looks taken. Silently orphaning them would
 * be leaving the user's repositories in a state this package created and then abandoned.
 *
 * Degraded, not blocking: nothing is prevented, and the machine fields agents perfectly well. But
 * it is a ⚠ that a single pasted command clears, which is the bar a warning has to meet.
 *
 * The offered fix is `git worktree remove` WITHOUT `--force`, chained with `&&`. That is
 * deliberate and it is the whole safety argument: `remove` refuses on a tree with uncommitted
 * changes, and the `&&` chain then stops before the final `rm -rf`, so a pool still holding
 * unlanded work is left exactly where it is rather than deleted by a command doctor suggested.
 */
export function classifyStaleWorktreePool(state: LegacyPoolState): CheckResult {
  const base = {
    id: 'stale-worktree-pool' as const,
    title: 'no worktree pool left at the old location',
  };
  if (!state.exists) {
    return { ...base, outcome: 'ok', found: `${state.dir} (absent — trees live in the sibling)` };
  }

  // `quoteArg`, not a hand-written pair of double quotes: this chain ends in `rm -rf`, and a
  // pool directory whose name contains a backtick or a `$` would otherwise expand between the
  // line the user reads and the line the shell runs.
  const removals = state.trees.map((tree) => `git worktree remove ${quoteArg(tree)}`);
  const fix = [...removals, `rm -rf ${quoteArg(state.dir)}`].join(' && ');

  if (state.trees.length === 0) {
    return {
      ...base,
      outcome: 'degraded',
      found: `${state.dir} (exists, no leased trees in it)`,
      impact:
        'Nothing is broken, but this directory is left over from a version that kept worktrees ' +
        'inside the army home. Nothing writes to it any more, so whatever it reports is stale.',
      fix,
      note: 'Trees now live in the sibling directory, outside the region workers are denied.',
    };
  }

  const repoList =
    state.repos.length === 0
      ? 'no repository (they carry no `.git` file, so nothing is registered)'
      : state.repos.join(', ');
  return {
    ...base,
    outcome: 'degraded',
    found: `${state.dir} — ${String(state.trees.length)} leased tree(s), registered in ${repoList}`,
    impact:
      'These are registered git worktrees of your own repositories, and nothing manages this ' +
      'location any more: `git worktree list` in each repo still names a path the army has ' +
      'forgotten about, and it will never be reused, reset or released.',
    fix,
    note:
      'Worktrees moved to the sibling directory because everything under the army home is denied ' +
      'to every worker, so an agent leased a tree here could not read its own files. ' +
      '`git worktree remove` refuses on a tree with uncommitted changes, and the `&&` stops the ' +
      'delete — check those trees by hand rather than forcing it.',
  };
}

// ---------------------------------------------------------------------------
// Worktree leases — is the pool holding slots for processes that no longer exist?
// ---------------------------------------------------------------------------

/** One lease record, judged. `holder` is the agent id; the pid is inside `record`. */
export type JudgedLease = {
  file: string;
  holder: string;
  path: string;
  verdict: LeaseLivenessVerdict;
  reason: string;
};

export type WorktreeLeasesState = {
  /** `<pool>/leases` — where the records live. */
  dir: string;
  exists: boolean;
  leases: JudgedLease[];
  /** `.json` files present that did not parse as lease records. They hold slots forever. */
  unreadable: number;
};

/**
 * Read every lease record in the pool and judge each one with the pool's own liveness rule.
 *
 * READ-ONLY, like every doctor probe. Reclaiming is the acquire path's job (`cold.ts` releases a
 * stale lease through the real release gate on the next acquire); this check exists because until
 * that acquire happens the pool is a directory of opaque JSON, and "why is the pool exhausted"
 * was unanswerable without reading it by hand.
 */
export async function inspectWorktreeLeases(
  poolRoot: string = worktreePoolDir(),
): Promise<WorktreeLeasesState> {
  const dir = path.join(poolRoot, 'leases');
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return { dir, exists: false, leases: [], unreadable: 0 };
  }
  const leases: JudgedLease[] = [];
  let unreadable = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const record: ColdLeaseRecord | null = readLeaseRecord(file);
    if (record === null) {
      unreadable += 1;
      continue;
    }
    const liveness = leaseLiveness(record);
    leases.push({
      file,
      holder: record.leaseHolder,
      path: record.path,
      verdict: liveness.verdict,
      reason: liveness.reason,
    });
  }
  return { dir, exists: true, leases, unreadable };
}

/**
 * `ok` when the pool holds nothing, or only leases whose processes are alive. Anything else is
 * `degraded` — never blocking, because nothing is PREVENTED (the pool still hands out every free
 * slot, and stale leases are reclaimed by the next acquire) — but a slot held by the dead is
 * capacity a reader deserves to see before `PoolExhaustedError` makes them come looking.
 */
export function classifyWorktreeLeases(state: WorktreeLeasesState): CheckResult {
  const base = { id: 'worktree-leases' as const, title: 'worktree pool leases' };
  const counts: Record<LeaseLivenessVerdict, number> = { live: 0, stale: 0, foreign: 0, unknown: 0 };
  for (const lease of state.leases) counts[lease.verdict] += 1;
  const total = state.leases.length + state.unreadable;

  if (!state.exists || total === 0) {
    return { ...base, outcome: 'ok', found: `${state.dir} (no leases)` };
  }
  const parts = [`${counts.live} live`];
  if (counts.stale > 0) parts.push(`${counts.stale} stale`);
  if (counts.foreign > 0) parts.push(`${counts.foreign} foreign-host`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} without a pid`);
  if (state.unreadable > 0) parts.push(`${state.unreadable} unreadable`);
  const found = `${state.dir} — ${total} lease(s): ${parts.join(', ')}`;

  if (counts.live === state.leases.length && state.unreadable === 0) {
    return { ...base, outcome: 'ok', found };
  }

  const dead = state.leases.filter((lease) => lease.verdict === 'stale');
  const held = dead.map((lease) => `${lease.holder} (${lease.path})`).join(', ');
  const impactParts: string[] = [];
  if (dead.length > 0) {
    impactParts.push(
      `${dead.length} pool slot(s) are held by processes that no longer exist${held === '' ? '' : `: ${held}`}. ` +
        'They are unavailable until the next campaign acquires a tree of the same repository, ' +
        'which reclaims them automatically through the release gate.',
    );
  }
  if (counts.foreign > 0 || counts.unknown > 0 || state.unreadable > 0) {
    impactParts.push(
      `${counts.foreign + counts.unknown + state.unreadable} lease(s) cannot be judged from ` +
        'this machine (taken on another host, no recorded pid, or unreadable) and are NEVER ' +
        'reclaimed automatically — each permanently holds a slot until dealt with by hand.',
    );
  }
  return {
    ...base,
    outcome: 'degraded',
    found,
    impact: impactParts.join(' '),
    note:
      'A lease record outliving its process is what a SIGKILLed campaign leaves behind. ' +
      'Reclamation goes through the real release path, so a dead holder\'s unlanded work still ' +
      'blocks its slot — that lease will keep showing here, and the record file names the tree ' +
      'holding the work. Only delete a record by hand once you are certain its holder is gone ' +
      'and its tree holds nothing you want.',
  };
}

export function classifySqlite(
  ok: boolean,
  error?: string | null,
  platform: Platform = process.platform,
): CheckResult {
  const base = { id: 'sqlite' as const, title: 'node:sqlite importable' };
  if (ok) {
    return {
      ...base,
      outcome: 'ok',
      found: 'importable',
      note:
        'node:sqlite is flagged experimental and warns on load; that warning is filtered — and ' +
        'only that one — so it never reaches your terminal.',
    };
  }
  return {
    ...base,
    outcome: 'blocking',
    found: `import failed${error === undefined || error === null ? '' : `: ${error}`}`,
    // Not `node --experimental-sqlite`. That was never a command anyone could run — it is a
    // flag with no script, and on a Node built WITHOUT SQLite it changes nothing at all, which
    // is the only situation this branch is reached in. Upgrading is the actual resolution.
    fix: installHint('node', platform),
    note:
      'campaign.db is the index for the whole war archive. node:sqlite ships from ' +
      'Node 22.5; a Node compiled without SQLite support cannot run agentic-army, and no flag ' +
      'adds it back.',
  };
}

// ---------------------------------------------------------------------------
// Probing — impure, Windows-aware, and structurally incapable of hanging.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env['PATH'] ?? env['Path'] ?? env['path'] ?? '';
  return raw
    .split(path.delimiter)
    .map((d) => d.replace(/^"(.*)"$/, '$1').trim())
    .filter((d) => d !== '');
}

function pathExtensions(env: NodeJS.ProcessEnv, platform: Platform): string[] {
  if (platform !== 'win32') return [''];
  const raw = env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  const exts = raw.split(';').map((e) => e.trim()).filter((e) => e !== '');
  // Also allow an exact match (someone put `foo` with no extension on PATH).
  return ['', ...exts];
}

/**
 * Every path a bare binary name could resolve to, in the order the OS would try them.
 *
 * The single source of PATH/PATHEXT semantics here: the async and sync resolvers below differ
 * only in which `fs` call tests a candidate, never in which candidates they consider. Two
 * resolvers disagreeing about PATHEXT order would mean `army doctor` and `invokedAs()` reaching
 * different conclusions about the same machine.
 */
function binaryCandidates(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string[] {
  if (name.includes('/') || name.includes('\\')) return [path.resolve(name)];
  const out: string[] = [];
  for (const dir of pathEntries(env)) {
    for (const ext of pathExtensions(env, platform)) out.push(path.join(dir, name + ext));
  }
  return out;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true; // X_OK is meaningless on Windows
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutableFileSync(candidate: string, platform: Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  if (platform === 'win32') return true; // X_OK is meaningless on Windows
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate a binary without shelling out. `which` does not exist on Windows and
 * `where` is not on every PATH, so we do what they do: walk PATH, and on
 * Windows try each PATHEXT suffix.
 */
export async function resolveBinary(name: string): Promise<string | null> {
  for (const candidate of binaryCandidates(name)) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * `resolveBinary`, synchronously.
 *
 * Exists for `invokedAs()`, which must answer "does `army` actually resolve here?" from inside
 * synchronous render paths. A handful of `statSync` calls, once per process — cheaper than
 * threading a promise through every string that mentions a command.
 */
export function resolveBinarySync(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string | null {
  for (const candidate of binaryCandidates(name, env, platform)) {
    if (isExecutableFileSync(candidate, platform)) return candidate;
  }
  return null;
}

type RawRun = { code: number | null; stdout: string; stderr: string; error: string | null; timedOut: boolean };

const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Kill a probe and everything it spawned.
 *
 * `child.kill()` signals one pid. Half these tools are wrapper scripts — a
 * `claude` shim that execs the real binary, a `.cmd` that calls node — so the
 * process actually burning the timeout is usually a *grandchild*, and killing
 * only the direct child leaves it running after doctor has returned.
 *
 * On POSIX the child is spawned `detached`, which makes it a process-group
 * leader with pgid == pid, so `process.kill(-pid)` reaches the whole subtree.
 * On Windows there are no process groups, so we hand the job to `taskkill /T`.
 *
 * EXPORTED so the property can be tested for what it is. Proving "a timed-out
 * probe takes its grandchildren with it" needs the kill to happen at a moment
 * the test chooses — after it has watched the grandchild come up — and a kill
 * on a wall-clock timer cannot offer that. See `test/doctor.test.ts`.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        /* taskkill missing: fall through to the direct kill below */
      });
      killer.unref();
    } catch {
      /* ignore */
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group may already be gone, or the child never became a leader.
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Spawn a probe child exactly as a real probe does.
 *
 * Split out of `runResolved` so that the process-cleanup test drives the SAME spawn options the
 * product uses. A test that re-declared `detached: true` for itself would keep passing after
 * someone dropped it here, and `detached` is the entire reason `process.kill(-pid)` works.
 *
 * `file` must already be resolved (see `resolveBinary`).
 */
export function spawnProbeChild(file: string, args: readonly string[]): ChildProcess {
  // Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980 hardening),
  // so those — and only those — go through cmd.exe. `file` is a path we resolved
  // ourselves and every arg is a literal in this file, so there is no injection
  // surface; the quotes are purely for paths containing spaces.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  const target = needsShell ? `"${file}"` : file;

  return spawn(target, args as string[], {
    // stdin is /dev/null, never a pipe we forget to close. A probe that
    // inherits or is handed an open stdin can block forever waiting for
    // input that is never coming — `codex exec` does exactly this, and
    // burns the entire timeout producing nothing.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: needsShell,
    // Own process group, so a timeout can kill the whole subtree (POSIX).
    detached: process.platform !== 'win32',
    env: process.env,
  });
}

function runResolved(file: string, args: readonly string[], timeoutMs: number): Promise<RawRun> {
  return new Promise<RawRun>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ChildProcess | null = null;

    const timers: NodeJS.Timeout[] = [];
    const done = (r: RawRun): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve(r);
    };

    try {
      child = spawnProbeChild(file, args);
    } catch (e) {
      done({ code: null, stdout: '', stderr: '', error: String(e), timedOut: false });
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
    });

    child.on('error', (err: Error) => {
      done({ code: null, stdout, stderr, error: err.message, timedOut });
    });

    // 'close' rather than 'exit': it fires once the stdio streams are drained,
    // so we never truncate output from a process that has already exited.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      done({
        code,
        stdout,
        stderr,
        error: signal === null ? null : `terminated by ${signal}`,
        timedOut,
      });
    });

    // Soft deadline: kill the tree and let 'close' report whatever we captured.
    const soft = setTimeout(() => {
      timedOut = true;
      if (child !== null) killProcessTree(child);
    }, timeoutMs);

    // Hard backstop: if something still holds the pipes open after the kill,
    // settle anyway. This is what makes "doctor never hangs" a guarantee rather
    // than an expectation.
    //
    // Settling the promise is NOT sufficient on its own, and this was a real hole. If a
    // grandchild survives the kill it still holds the read end of these pipes, and Node keeps
    // the event loop alive for a referenced socket that has not seen EOF — so `army doctor`
    // would print its report and then sit there, for as long as the stray process lived, having
    // already returned. Destroying our end and unreferencing the child means the guarantee is
    // about the PROCESS exiting, not merely about this promise resolving.
    const hard = setTimeout(() => {
      timedOut = true;
      if (child !== null) {
        killProcessTree(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      done({ code: null, stdout, stderr, error: 'hard timeout', timedOut: true });
    }, timeoutMs + 1000);

    soft.unref?.();
    hard.unref?.();
    timers.push(soft, hard);
  });
}

/**
 * Run `<name> <args>` and report what happened. Never throws, never hangs.
 * Resolves the binary on PATH first so a missing tool is reported as "not
 * found" rather than as an opaque ENOENT.
 */
export async function probe(
  name: string,
  args: readonly string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult> {
  const resolved = await resolveBinary(name);
  if (resolved === null) {
    return stubProbe({ found: false, error: `${name} not found on PATH` });
  }
  const run = await runResolved(resolved, args, timeoutMs);
  return {
    found: true,
    path: resolved,
    code: run.code,
    stdout: run.stdout,
    stderr: run.stderr,
    timedOut: run.timedOut,
    error: run.error,
  };
}

// ---------------------------------------------------------------------------
// Home directory
// ---------------------------------------------------------------------------

/**
 * The war archive root — `~/.agentic-army`, or `$AGENTIC_ARMY_HOME`.
 *
 * Delegates to `src/config/paths.ts`, which is the single source of truth.
 * This was a second implementation kept "byte-for-byte equivalent" by a test;
 * two modules disagreeing about where the config lives is a silent security
 * failure — `army enlist` writes a ceiling the campaign runner never reads —
 * so the copy is gone rather than pinned.
 *
 * UNDER THE TEST RUNNER IT REFUSES rather than defaulting, and that refusal is NOT implemented
 * here. It lives in `armyHome`, because this module is not the only door: `src/cli.ts`,
 * `src/view/**`, `src/config/load.ts` and the campaign runner reach the same ambient home
 * through `armyHome` directly, and a refusal written only here held the property on the doctor's
 * write path and on no other. A second copy would also be free to drift — this repo has already
 * watched two inline copies of one audit diverge until the same defect failed in one file and
 * was invisible in the other — so there is exactly one, and this function inherits it by calling.
 *
 * Why the doctor is where it was noticed: `inspectWritableDir` proves writability by writing a
 * real probe file and deleting it — deliberately, because `access(W_OK)` lies on some network
 * shares — so any code path that reaches it with an ambiently-resolved home MUTATES the
 * developer's own archive directory. Two tests did exactly that for months by calling
 * `runChecks(2000)` and letting the home default.
 */
export function homeDir(): string {
  return armyHome(process.env);
}

/**
 * Where leased worktrees live: `<home>-trees`, matching what `army campaign` actually passes to
 * the provider. Doctor runs before any config exists, so it deliberately does NOT load one — it
 * reports the default location and says so in the note when it complains.
 *
 * A SIBLING of the home, not a child of it. `<home>/worktrees` is denied to every worker by
 * `protectedConfigGlobs()`, so an Engineer leased a tree there could not read its own files.
 * Derived from the home rather than `archive_root` so a user-editable TOML value cannot steer
 * it back inside the denied region — see `worktreesRootFor` for the whole argument.
 */
export function worktreePoolDir(home: string = homeDir()): string {
  return worktreesRootFor(home);
}

/**
 * Where leased worktrees USED to live, before they moved to the sibling.
 *
 * Kept solely so `army doctor` can find a pool left behind by an older version. Those trees are
 * registered git worktrees of the user's real repositories, and nothing manages that location
 * any more — silently orphaning them would leave `git worktree list` in every affected repo
 * pointing at a directory the army has forgotten about.
 */
export function legacyWorktreePoolDir(home: string = homeDir()): string {
  return path.join(home, 'worktrees');
}

export async function inspectWritableDir(dir: string): Promise<DirState> {
  let exists = false;
  try {
    const stat = await fs.stat(dir);
    exists = stat.isDirectory();
    if (!exists) {
      return {
        dir,
        exists: false,
        writable: false,
        creatable: false,
        error: 'path exists but is not a directory',
        blockedBy: dir,
      };
    }
  } catch {
    exists = false;
  }

  if (exists) {
    // Probe writability for real. fs.access(W_OK) lies on some network shares.
    const probeFile = path.join(dir, `.army-write-probe-${process.pid}`);
    try {
      await fs.writeFile(probeFile, '');
      await fs.rm(probeFile, { force: true });
      return { dir, exists: true, writable: true, creatable: true, error: null };
    } catch (e) {
      return { dir, exists: true, writable: false, creatable: false, error: (e as Error).message };
    }
  }

  // Not there yet: could it be created? That means asking the question `mkdir -p` asks — is the
  // nearest EXISTING ancestor writable — not "is my immediate parent writable".
  //
  // The difference is not academic. It was found when the pool was `<home>/worktrees`, whose
  // parent does not exist either on a clean machine because `<home>` has not been created yet;
  // it still bites with the pool at `<home>-trees`, because `AGENTIC_ARMY_HOME` may name a path
  // several levels deep and every one of those levels is absent on a first run. Testing the
  // immediate parent returns ENOENT, which reads as "cannot be created", which would make
  // `army doctor` block a first-ever `army init` on a perfectly good machine — a worse failure
  // than the one this check exists to catch.
  //
  // Deliberately does NOT create anything: doctor must stay safe to run anywhere.
  let ancestor = path.dirname(path.resolve(dir));
  for (;;) {
    try {
      // BOTH questions, in this order. `access(W_OK)` on its own says "you may write this
      // inode" and says nothing about what KIND of inode it is — so a writable regular file
      // answered yes, and `<some-file>/worktrees` was reported creatable and green. A green
      // line that is false is worse than a missing one: it is a claim the user acts on.
      const stat = await fs.stat(ancestor);
      if (!stat.isDirectory()) {
        return {
          dir,
          exists: false,
          writable: false,
          creatable: false,
          error: `${ancestor} exists but is not a directory, so ${dir} can never be created`,
          blockedBy: ancestor,
        };
      }
      await fs.access(ancestor, fsConstants.W_OK);
      return { dir, exists: false, writable: false, creatable: true, error: null };
    } catch (e) {
      // Distinguish "not there yet, keep walking" from "there and refusing us".
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { dir, exists: false, writable: false, creatable: false, error: (e as Error).message };
      }
      const next = path.dirname(ancestor);
      if (next === ancestor) {
        // Walked to the filesystem root without finding anything. Not reachable on a sane
        // system; returning rather than looping is the point.
        return {
          dir,
          exists: false,
          writable: false,
          creatable: false,
          error: `no existing ancestor of ${dir} is writable`,
        };
      }
      ancestor = next;
    }
  }
}

export async function inspectHome(dir: string = homeDir()): Promise<DirState> {
  return inspectWritableDir(dir);
}

/**
 * Read and parse `<home>/config.toml`, reporting rather than throwing.
 *
 * READ-ONLY like every other probe here, and it deliberately reuses `parseConfig` — the same
 * parser every refusing command goes through — so doctor and `enlist` can never disagree about
 * whether a given file parses.
 */
export async function inspectConfig(home: string = homeDir()): Promise<ConfigState> {
  const file = configPath(home);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { file, present: false, error: null };
    // Exists but unreadable — as blocking as unparseable, and for the same reason.
    return { file, present: true, error: `cannot read ${file}: ${err.message}` };
  }
  try {
    parseConfig(text, file);
    return { file, present: true, error: null };
  } catch (e) {
    return { file, present: true, error: (e as Error).message };
  }
}

/** What is left behind at the old pool location, if anything. */
export type LegacyPoolState = {
  dir: string;
  exists: boolean;
  /** Leased trees found under `<dir>/trees/<slug>/wt-NN`, sorted. */
  trees: string[];
  /** Repositories those trees are still registered against — deduped, sorted. */
  repos: string[];
};

/** `gitdir: /path/to/repo/.git/worktrees/wt-01` -> `/path/to/repo`. */
function repoOfLinkedWorktree(gitFileText: string): string | null {
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(gitFileText)?.[1];
  if (gitdir === undefined) return null;
  const repo = /^(.*)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/.exec(gitdir)?.[1];
  return repo === undefined || repo === '' ? null : repo;
}

/**
 * Look for a worktree pool left at the location this package used before the move.
 *
 * READ-ONLY, like every other doctor probe: it never removes, prunes or creates anything. The
 * trees it finds are registered git worktrees of the user's own repositories, so what to do
 * about them is a decision with the user's uncommitted work on the other side of it.
 */
export async function inspectLegacyWorktreePool(
  dir: string = legacyWorktreePoolDir(),
): Promise<LegacyPoolState> {
  const empty: LegacyPoolState = { dir, exists: false, trees: [], repos: [] };
  try {
    if (!(await fs.stat(dir)).isDirectory()) return empty;
  } catch {
    return empty;
  }

  const trees: string[] = [];
  const repos = new Set<string>();
  const treesRoot = path.join(dir, 'trees');
  let slugs: string[] = [];
  try {
    slugs = (await fs.readdir(treesRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // No `trees/` at all: the directory is leftover scaffolding, not a live pool.
    return { dir, exists: true, trees: [], repos: [] };
  }

  for (const slug of slugs) {
    let slots: string[] = [];
    try {
      slots = (await fs.readdir(path.join(treesRoot, slug), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const slot of slots) {
      const tree = path.join(treesRoot, slug, slot);
      trees.push(tree);
      try {
        const repo = repoOfLinkedWorktree(await fs.readFile(path.join(tree, '.git'), 'utf8'));
        if (repo !== null) repos.add(repo);
      } catch {
        // A tree with no `.git` file is not registered anywhere; it is just a directory.
      }
    }
  }

  return { dir, exists: true, trees: trees.sort(), repos: [...repos].sort() };
}

// ---------------------------------------------------------------------------
// node:sqlite — importable, and silent about it
// ---------------------------------------------------------------------------

/**
 * Can this Node open the archive index at all?
 *
 * The filter goes in BEFORE the import, because the warning fires on load — which is also why
 * this is a lazy dynamic `import` and not a hoisted one.
 *
 * `installWarningFilter` used to be a hand-mirrored copy of the archive's, kept here because the
 * archive's was module-private and its own comment said to delete this one the day it was
 * exported. That day is today: it is imported now, so there is one filter and it is impossible
 * for this route and the archive's to disagree about what gets swallowed.
 *
 * The import direction is the safe one — `src/setup/**` sits above `src/archive/**`, and `db.ts`
 * imports nothing but `node:module`, so nothing is pulled in by reaching for it.
 */
export async function canImportSqlite(): Promise<{ ok: boolean; error: string | null }> {
  installWarningFilter();
  try {
    await import('node:sqlite');
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export type DoctorReport = {
  ok: boolean;
  outcome: Outcome;
  counts: Record<Outcome, number>;
  checks: CheckResult[];
  homeDir: string;
  /** How this process was invoked, and on what evidence — see `detectInvocation`. */
  invokedAs: Invocation;
  elapsedMs: number;
};

/**
 * Run every check concurrently. They are all independent subprocess spawns;
 * serialising them would make `army doctor` feel broken (~8 × process startup).
 * Result order is fixed regardless of completion order.
 *
 * `home` is threaded through every directory check rather than each one reaching for
 * `homeDir()` on its own, so the whole report is about ONE directory and a caller can say which.
 * The default is the ambient home, which is what the real command wants and what a test cannot
 * have: `homeDir()` refuses under the test runner, so omitting this argument there is a loud
 * failure rather than a write into the developer's archive.
 */
export async function runChecks(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  home: string = homeDir(),
): Promise<DoctorReport> {
  const started = Date.now();
  const platform = process.platform;

  const gitCheck = async (): Promise<CheckResult> =>
    classifyGit(await probe('git', ['--version'], timeoutMs), platform);

  const claudeCheck = async (): Promise<CheckResult> =>
    classifyClaude(await probe('claude', ['--version'], timeoutMs), platform);

  const codexCheck = async (): Promise<CheckResult> => {
    const version = await probe('codex', ['--version'], timeoutMs);
    // Only ask about login if the binary is actually there; `codex login status`
    // is cheap but there is no point paying for it against a missing binary.
    const login = version.found ? await probe('codex', ['login', 'status'], timeoutMs) : null;
    return classifyCodex(version, login, platform);
  };

  const ghCheck = async (): Promise<CheckResult> => {
    const version = await probe('gh', ['--version'], timeoutMs);
    const auth = version.found ? await probe('gh', ['auth', 'status'], timeoutMs) : null;
    return classifyGh(version, auth, platform);
  };

  const homeCheck = async (): Promise<CheckResult> => classifyHome(await inspectHome(home));

  const configCheck = async (): Promise<CheckResult> => classifyConfig(await inspectConfig(home));

  const worktreePoolCheck = async (): Promise<CheckResult> =>
    classifyWorktreePool(await inspectWritableDir(worktreePoolDir(home)));

  const staleWorktreePoolCheck = async (): Promise<CheckResult> =>
    classifyStaleWorktreePool(await inspectLegacyWorktreePool(legacyWorktreePoolDir(home)));

  const worktreeLeasesCheck = async (): Promise<CheckResult> =>
    classifyWorktreeLeases(await inspectWorktreeLeases(worktreePoolDir(home)));

  const sqliteCheck = async (): Promise<CheckResult> => {
    const r = await canImportSqlite();
    return classifySqlite(r.ok, r.error);
  };

  const checks = await Promise.all([
    Promise.resolve(classifyNode(process.versions.node, platform)),
    gitCheck(),
    claudeCheck(),
    Promise.resolve(classifyApiKey(process.env['ANTHROPIC_API_KEY'])),
    codexCheck(),
    ghCheck(),
    homeCheck(),
    configCheck(),
    worktreePoolCheck(),
    staleWorktreePoolCheck(),
    worktreeLeasesCheck(),
    sqliteCheck(),
  ]);

  return {
    ok: exitCodeFor(checks) === 0,
    outcome: worstOutcome(checks),
    counts: countOutcomes(checks),
    checks,
    homeDir: home,
    invokedAs: invocation(),
    elapsedMs: Date.now() - started,
  };
}
