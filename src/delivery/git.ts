/**
 * Thin git / `gh` helpers — blast radius and delivery.
 *
 * Deliberately thin: no repo abstraction, no caching, no state. Everything above this file
 * (durability, the ladder, the cold worktree provider) shells out through here so that the global
 * deny-list is enforced in EXACTLY ONE PLACE and cannot be forgotten at a call site.
 *
 * Erasable syntax only — this file is executed directly by `node`.
 */

import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------------------------
// process plumbing
// ---------------------------------------------------------------------------------------------

export interface ExecResult {
  file: string;
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Overlaid on `process.env`. Tests use it for a deterministic identity and hermetic config. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Two minutes. A push to a slow remote is legitimate; an interactive prompt is not. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Never let a credential helper open a GUI or block on a tty: an agent has no hands. A missing
 * credential must be a fast non-zero exit the caller can report, not a wedged process.
 */
const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
};

export class MissingBinaryError extends Error {
  readonly binary: string;
  constructor(binary: string) {
    super(`\`${binary}\` was not found on PATH.`);
    this.name = 'MissingBinaryError';
    this.binary = binary;
  }
}

export class CommandError extends Error {
  readonly result: ExecResult;
  constructor(message: string, result: ExecResult) {
    super(message);
    this.name = 'CommandError';
    this.result = result;
  }
}

/** A global deny-list hit. Thrown before the process is spawned — the command never runs. */
export class DeniedCommandError extends Error {
  readonly command: string;
  readonly rule: string;
  constructor(command: string, rule: string) {
    super(`Denied by the global deny-list: ${command} — ${rule}`);
    this.name = 'DeniedCommandError';
    this.command = command;
    this.rule = rule;
  }
}

function run(file: string, args: readonly string[], opts: RunOptions = {}): Promise<ExecResult> {
  const argv = [...args];
  return new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...NON_INTERACTIVE_ENV, ...opts.env },
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new MissingBinaryError(file));
          return;
        }
        let code = 0;
        if (error !== null) {
          const raw: unknown = (error as unknown as { code?: unknown }).code;
          code = typeof raw === 'number' ? raw : 1;
        }
        resolve({ file, args: argv, code, stdout: out, stderr: err });
      },
    );
  });
}

/** Exported so the treehouse adapter can shell out through the same non-interactive plumbing. */
export function runBinary(
  file: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<ExecResult> {
  return run(file, args, opts);
}

function describe(result: ExecResult): string {
  const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(0, 6).join('\n');
  return `${result.file} ${result.args.join(' ')} exited ${result.code}${detail ? `\n${detail}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// the global deny-list — enforced before spawn, no override, every role
// ---------------------------------------------------------------------------------------------

/**
 * SCOPE, stated plainly because other units build against this function:
 *
 * `assertGitAllowed` is an ALLOW-LIST for `git push` and a narrow allow-list for git's global
 * flags. It is NOT a general capability model for git — it does not stop `git reset --hard`,
 * `git clean`, or `git branch -D`, because the global permission rules do not name those and the
 * worktree provider legitimately needs destructive local verbs. What it does guarantee is that no
 * argv passed through `runGit` can force-push, delete a remote ref, hand the remote an arbitrary
 * payload, or inject config on the way past.
 *
 * A deny-list was the first attempt and it was wrong: `--` made `+refspec` invisible, bundled
 * short flags (`-uf`) hid `-f`, and `--receive-pack=` was never considered. Enumerating what is
 * forbidden loses to anyone with a git manpage. Enumerating what is PERMITTED does not.
 */

/** Every flag `git push` may carry. All are boolean, so no argument consumes a value. */
const PUSH_ALLOWED_FLAGS = new Set([
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '--porcelain',
  '--atomic',
  '--no-verify',
  '-u',
  '--set-upstream',
  '--progress',
  '--no-progress',
  '--thin',
  '--no-thin',
  '-4',
  '--ipv4',
  '-6',
  '--ipv6',
]);

/** Flags whose whole purpose is to overwrite or delete a ref, named so the refusal can say why. */
const PUSH_FORCE_FLAGS = new Set([
  '-f',
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--delete',
  '-d',
  '--prune',
]);

/** Global flags permitted before the subcommand. `-C` takes a value; the rest are boolean. */
const GLOBAL_VALUE_FLAGS = new Set(['-C', '--git-dir', '--work-tree']);
const GLOBAL_BOOL_FLAGS = new Set(['--no-pager', '--literal-pathspecs', '--no-replace-objects']);

/** `-uf` → `['-u', '-f']`; `--force-with-lease=main` → `['--force-with-lease']`. */
function expandFlag(arg: string): string[] {
  if (arg.startsWith('--')) return [arg.split('=')[0]!];
  // A short-flag cluster. git's parse-options accepts `-uf` as `-u -f`.
  return arg
    .slice(1)
    .split('')
    .map((char) => `-${char}`);
}

export function assertGitAllowed(args: readonly string[]): void {
  const printable = `git ${args.join(' ')}`;
  const deny = (rule: string): never => {
    throw new DeniedCommandError(printable, rule);
  };

  // ---- global flags, up to the subcommand -----------------------------------------------
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) break;
    const name = arg.split('=')[0]!;
    if (name === '-c' || name === '--config-env') {
      deny(
        '`git -c` / `--config-env` can rewrite any config for one command — including ' +
          '`protocol.ext.allow`, which turns a remote URL into arbitrary command execution. ' +
          'Denied outright; pass configuration through the environment of a specific call site.',
      );
    }
    if (GLOBAL_VALUE_FLAGS.has(name)) {
      if (!arg.includes('=')) index += 1;
      continue;
    }
    if (GLOBAL_BOOL_FLAGS.has(name)) continue;
    deny(
      `\`${name}\` is not on the allow-list of git global flags. Unknown flags are denied rather ` +
        'than waved through, because the flag nobody thought about is the one that gets used.',
    );
  }

  const subcommand = args[index];
  const rest = args.slice(index + 1);

  // ---- operand checks that apply to every subcommand ------------------------------------
  for (const arg of rest) {
    if (/^(ext|ftp|ftps)::/i.test(arg)) {
      deny(
        `\`${arg.slice(0, 24)}…\` is a git transport helper URL; \`ext::\` in particular executes ` +
          'a shell command. Denied for every subcommand.',
      );
    }
  }

  if (subcommand !== 'push') return;

  // ---- push ------------------------------------------------------------------------------
  // `--` separates flags from operands. It does NOT make an operand safe: `+refspec` after `--`
  // is still a force-push, which is exactly the bypass this rewrite closes. So operands are
  // checked for force semantics wherever they appear, before or after the separator.
  const denyForce = (flag: string): never =>
    deny(
      `\`${flag}\` overwrites or deletes a ref on the remote. Every force variant of git push is ` +
        'denied globally, for every role, with no override — it is the one git operation ' +
        'that destroys history someone else already has, which is why it sits on the ' +
        'Commander’s own line and nowhere below it.',
    );

  let operandsOnly = false;
  for (const arg of rest) {
    if (arg === '--') {
      operandsOnly = true;
      continue;
    }

    // POSITION-INDEPENDENT force checks. Whether git would read this token as a flag or as a
    // refspec is not the question — the guard refuses it either way, so a change in git's
    // parsing cannot turn a safe argv into a force-push.
    if (PUSH_FORCE_FLAGS.has(arg.split('=')[0]!)) denyForce(arg.split('=')[0]!);
    if (arg.startsWith('+')) {
      deny(
        `\`${arg}\` is a force-push spelled as a refspec: a leading \`+\` means "update even if ` +
          'not a fast-forward". Denied wherever it appears in the argv, including after `--`.',
      );
    }

    if (operandsOnly || !arg.startsWith('-') || arg === '-') continue;
    for (const flag of expandFlag(arg)) {
      if (PUSH_FORCE_FLAGS.has(flag)) denyForce(flag);
      if (!PUSH_ALLOWED_FLAGS.has(flag)) {
        deny(
          `\`${flag}\` is not on the git push allow-list. Flags such as \`--receive-pack=\` and ` +
            '`--push-option` hand an arbitrary payload to the far end, so anything not ' +
            'explicitly permitted is refused.',
        );
      }
    }
  }
}

/**
 * `gh` is an ALLOW-LIST — the Inspector's finding was that a deny-list cannot win here, and it
 * is right: `gh pr --repo O/R merge N` puts flags before the subcommand, and `gh api -X PUT
 * repos/O/R/pulls/N/merge` never says "merge" as a subcommand at all. Both got past a matcher
 * that looked at leading positionals.
 *
 * So: the argv is parsed the way cobra parses it (flags with their values consumed), the
 * resulting command path must be one this module actually needs, and every flag must be
 * permitted for that command. Unknown flag, unknown command, or a `pr review` that is not a
 * comment → refused. `gh api` is not on the list at all, which is what closes the whole class.
 */
const GH_FLAG_TAKES_VALUE: Record<string, boolean> = {
  '--repo': true,
  '-R': true,
  '--head': true,
  '--base': true,
  '-B': true,
  '--title': true,
  '-t': true,
  '--body': true,
  '-b': true,
  '--json': true,
  '--jq': true,
  '-q': true,
  '--limit': true,
  '-L': true,
  '--state': true,
  '-s': true,
  '--draft': false,
  '-d': false,
  '--comment': false,
  '--version': false,
};

const GH_ALLOWED_COMMANDS: Record<string, readonly string[]> = {
  'auth status': [],
  'pr create': ['--head', '--base', '-B', '--title', '-t', '--body', '-b', '--draft', '-d', '--repo', '-R'],
  'pr view': ['--json', '--jq', '-q', '--repo', '-R'],
  'pr list': ['--json', '--jq', '-q', '--repo', '-R', '--head', '--base', '-B', '--limit', '-L', '--state', '-s'],
  'pr review': ['--comment', '--body', '-b', '--repo', '-R'],
};

export function assertGhAllowed(args: readonly string[]): void {
  const printable = `gh ${args.join(' ')}`;
  const deny = (rule: string): never => {
    throw new DeniedCommandError(printable, rule);
  };

  const flags: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    const name = arg.split('=')[0]!;
    const takesValue = GH_FLAG_TAKES_VALUE[name];
    if (takesValue === undefined) {
      deny(
        `\`${name}\` is not on the gh flag allow-list. Unknown flags are refused because a flag ` +
          'that is silently ignored here is a flag gh will happily act on — `-X PUT` being the ' +
          'example that mattered.',
      );
    }
    flags.push(name);
    // A value never counts as a positional, which is what made `gh pr --repo O/R merge N` look
    // like `pr merge` to cobra while looking like `pr O/R merge` to a naive scanner.
    if (takesValue === true && !arg.includes('=')) i += 1;
  }

  if (positional.length === 0) {
    if (flags.length === 1 && flags[0] === '--version') return;
    deny('a gh invocation with no subcommand is not on the allow-list.');
  }

  const two = positional.slice(0, 2).join(' ');
  const one = positional[0]!;
  const command = GH_ALLOWED_COMMANDS[two] !== undefined ? two : one;
  const allowedFlags = GH_ALLOWED_COMMANDS[command];
  if (allowedFlags === undefined) {
    deny(
      `\`gh ${command}\` is not on the allow-list. This module needs exactly ` +
        `${Object.keys(GH_ALLOWED_COMMANDS).map((c) => `\`gh ${c}\``).join(', ')} — and nothing ` +
        'else, notably not `gh pr merge` (rung 3, denied globally) and not `gh api`, which can ' +
        'reach the merge endpoint by URL without ever naming it.',
    );
  }
  for (const flag of flags) {
    if (!allowedFlags.includes(flag)) {
      deny(`\`${flag}\` is not permitted for \`gh ${command}\`.`);
    }
  }
  if (command === 'pr review' && !flags.includes('--comment')) {
    deny(
      'a pull-request review must be `--comment`. An approval (or a request for changes) is a ' +
        'state change that branch protection and auto-merge act on — a step toward rung 3 that ' +
        'nobody asked for. The army posts the Inspector verdict; it does not vote.',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

/** Run git. Never throws on a non-zero exit — inspect `result.code`. */
export async function runGit(args: readonly string[], opts: RunOptions = {}): Promise<ExecResult> {
  assertGitAllowed(args);
  return run('git', args, opts);
}

/** Run git and throw `CommandError` on a non-zero exit. Returns trimmed stdout. */
export async function git(args: readonly string[], opts: RunOptions = {}): Promise<string> {
  const result = await runGit(args, opts);
  if (result.code !== 0) throw new CommandError(describe(result), result);
  return result.stdout.trim();
}

export async function gitAvailable(): Promise<boolean> {
  try {
    const result = await run('git', ['--version'], { timeoutMs: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

/** Absolute path of the repository's top level, or null when `dir` is not inside a repo. */
export async function repoToplevel(dir: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function revParse(cwd: string, rev: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', rev], { cwd });
  return result.code === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null;
}

/** `git status --porcelain` — empty means no modifications AND no untracked files. */
export async function porcelainStatus(cwd: string): Promise<string> {
  return git(['status', '--porcelain'], { cwd });
}

export async function isClean(cwd: string): Promise<boolean> {
  return (await porcelainStatus(cwd)) === '';
}

/** True when HEAD is not on a branch — the state every leased worktree arrives in. */
export async function isDetachedHead(cwd: string): Promise<boolean> {
  const result = await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd });
  return result.code !== 0;
}

/** Current branch name, or null at detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** URL of a remote, or null when the remote does not exist. */
export async function remoteUrl(cwd: string, remote: string): Promise<string | null> {
  const result = await runGit(['remote', 'get-url', remote], { cwd });
  return result.code === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null;
}

/** Number of commits reachable from `head` but not from `base`. */
export async function commitsAhead(cwd: string, base: string, head: string): Promise<number> {
  const result = await runGit(['rev-list', '--count', `${base}..${head}`], { cwd });
  if (result.code !== 0) return 0;
  const n = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Refs (under `patterns`) from which `commit` is reachable. This is how "is this work landed
 * somewhere that survives the worktree" is answered without guessing.
 */
export async function refsContaining(
  cwd: string,
  commit: string,
  patterns: readonly string[],
): Promise<string[]> {
  const result = await runGit(
    ['for-each-ref', '--format=%(refname)', `--contains=${commit}`, ...patterns],
    { cwd },
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export async function updateRef(cwd: string, ref: string, commit: string): Promise<void> {
  await git(['update-ref', ref, commit], { cwd });
}

/** Every ref under `patterns`, whether or not it contains anything in particular. */
export async function listRefs(cwd: string, patterns: readonly string[]): Promise<string[]> {
  const result = await runGit(['for-each-ref', '--format=%(refname)', ...patterns], { cwd });
  if (result.code !== 0) return [];
  return result.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

/**
 * Every commit this worktree's HEAD has ever pointed at.
 *
 * `logs/HEAD` is PER-WORKTREE, which makes it the one precise answer to "what was done in this
 * tree" — precise enough not to blame a lease for a sibling lease's branch, and complete enough
 * to catch work whose branch HEAD has since moved away from. Empty when reflogs are disabled, in
 * which case the caller degrades to HEAD alone.
 */
export async function reflogCommits(cwd: string, ref = 'HEAD'): Promise<string[]> {
  const result = await runGit(['reflog', 'show', '--format=%H', ref], { cwd });
  if (result.code !== 0) return [];
  return [...new Set(result.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== ''))];
}

/** Stash entries with their parents, so an entry can be attributed to the tree that made it. */
export async function stashEntries(
  cwd: string,
): Promise<{ sha: string; parents: string[] }[]> {
  const result = await runGit(['stash', 'list', '--format=%H %P'], { cwd });
  if (result.code !== 0) return [];
  const out: { sha: string; parents: string[] }[] = [];
  for (const line of result.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/).filter((p) => p !== '');
    if (parts.length === 0) continue;
    out.push({ sha: parts[0]!, parents: parts.slice(1) });
  }
  return out;
}

/**
 * Ignored files that are actually present. `git status --porcelain` cannot see these, which is
 * why an approved release used to delete a `.env` written inside a worktree without a word.
 * `--directory` collapses a wholly-ignored tree to one entry, so `node_modules/` is one line
 * rather than forty thousand.
 */
export async function ignoredPresent(cwd: string): Promise<string[]> {
  const result = await runGit(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'],
    { cwd },
  );
  if (result.code !== 0) return [];
  return result.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

/**
 * How many commits are reachable from `candidates` but from none of `excludes`.
 * This is the "is any of this work still only here?" question, asked in one traversal.
 */
export async function countCommitsNotIn(
  cwd: string,
  candidates: readonly string[],
  excludes: readonly string[],
): Promise<number> {
  if (candidates.length === 0) return 0;
  const args = ['rev-list', '--count', ...candidates];
  if (excludes.length > 0) args.push('--not', ...excludes);
  const result = await runGit(args, { cwd });
  if (result.code !== 0) return 0;
  const n = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------------------------

export interface GhStatus {
  available: boolean;
  authenticated: boolean;
  /** Why not, in one line, so a rung-2 cap can explain itself instead of just happening. */
  reason: string | null;
}

export interface GhProbeOptions extends RunOptions {
  binary?: string;
}

/**
 * Probe `gh`. NOTE: `gh auth status` talks to the API, so this is the one function in the module
 * that can touch the network — the ladder takes it as an injectable so its capping logic is
 * testable offline.
 */
export async function probeGh(opts: GhProbeOptions = {}): Promise<GhStatus> {
  const binary = opts.binary ?? 'gh';
  try {
    // Even the probe goes through the allow-list, so there is no gh invocation in this module
    // that is not checked. A guard with one unchecked call site is a guard with a hole in it.
    assertGhAllowed(['--version']);
    const version = await run(binary, ['--version'], { ...opts, timeoutMs: opts.timeoutMs ?? 15_000 });
    if (version.code !== 0) {
      return { available: false, authenticated: false, reason: `\`${binary} --version\` failed.` };
    }
  } catch (error) {
    if (error instanceof MissingBinaryError) {
      return {
        available: false,
        authenticated: false,
        reason: `\`${binary}\` is not installed, so a pull request cannot be opened.`,
      };
    }
    throw error;
  }
  assertGhAllowed(['auth', 'status']);
  const auth = await run(binary, ['auth', 'status'], { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 });
  if (auth.code !== 0) {
    const line = (auth.stderr.trim() || auth.stdout.trim()).split('\n')[0] ?? '';
    return {
      available: true,
      authenticated: false,
      reason: `\`${binary}\` is installed but not authenticated${line ? `: ${line}` : '.'}`,
    };
  }
  return { available: true, authenticated: true, reason: null };
}

/** Run gh and throw on a non-zero exit. Returns trimmed stdout. */
export async function gh(args: readonly string[], opts: GhProbeOptions = {}): Promise<string> {
  assertGhAllowed(args);
  const result = await run(opts.binary ?? 'gh', args, opts);
  if (result.code !== 0) throw new CommandError(describe(result), result);
  return result.stdout.trim();
}
