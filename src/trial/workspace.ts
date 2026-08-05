/**
 * Arm workspaces — cloning the seed, and reading back what an arm did to it.
 *
 * A trial's whole premise is a controlled experiment: every arm has to start from a
 * byte-identical base so that whatever differs in the report is the variable under test and
 * nothing else. That premise only holds if the base is real — a commit that actually exists, in
 * a repository that actually exists — which is why `inspectSeed` refuses outright rather than
 * `git init`-ing something for the caller. A synthesised base is not a base; it is this tool
 * quietly deciding what "identical" means.
 *
 * `materializeArm` clones with `--no-hardlinks` and immediately detaches HEAD at the seed's
 * commit, the same starting condition a leased worktree gives a campaign Engineer. Nothing here
 * shares an object store with the seed or with a sibling arm — five arms mutating a shared
 * `.git` concurrently is not five independent experiments, it is a race.
 *
 * `collectEvidence` is the one function in this module that must never throw. It runs after the
 * expensive part — an arm has already spent real time and real money — and a git command that
 * fails at THAT point (a corrupted index, a detached HEAD git does not like, whatever) must
 * degrade to an empty/null/false answer rather than take the run's evidence down with it. Losing
 * a result to a bookkeeping error here would be strictly worse than reporting a possibly-partial
 * one.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { ArmEvidence } from '../contracts/trial.ts';
import type { SoldierEvent } from '../contracts/harness.ts';

const execFileAsync = promisify(execFile);

/**
 * Run `git` with an argv array, never a shell string.
 *
 * The only process helper in this module, on purpose: a shell string built from a workspace path
 * is how a space in a directory name becomes a silent bug, and `execFile` with an argv array
 * never constructs one.
 */
async function git(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return { stdout, stderr };
}

export interface SeedInfo {
  seed: string;
  baseCommit: string;
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Resolve a seed directory and read the commit every arm will start from.
 *
 * Throws, rather than repairing, when `seed` is not a git repository or has no commits — see the
 * module doc for why that is the only honest answer.
 */
export async function inspectSeed(seed: string): Promise<SeedInfo> {
  const resolved = path.resolve(seed);
  let stdout: string;
  try {
    stdout = (await git(['rev-parse', 'HEAD'], resolved)).stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${resolved} cannot be used as a trial seed: \`git rev-parse HEAD\` failed (${detail}). ` +
        'A trial\'s whole premise is that every arm starts from a byte-identical base, and there ' +
        'is no honest way to synthesise that from a directory that is not a git repository or ' +
        'has no commits. Run `git init` and create at least one commit inside ' +
        `${resolved} yourself, then re-run the trial — this tool will not do it for you.`,
    );
  }
  const baseCommit = stdout.trim();
  if (!COMMIT_RE.test(baseCommit)) {
    throw new Error(
      `${resolved}: \`git rev-parse HEAD\` returned ${JSON.stringify(baseCommit)}, which is not ` +
        'a 40-hex commit. Refusing to use it as a trial base commit.',
    );
  }
  return { seed: resolved, baseCommit };
}

/**
 * Clone the seed into a fresh arm directory, detached at the seed's exact commit.
 *
 * `--shared=false` combined with `--no-hardlinks` is not a valid clone invocation; the flag this
 * function needs is just `--no-hardlinks`, which forces a full copy of the object store instead
 * of hardlinking into the seed's — the arm must be able to outlive, and diverge from, the seed
 * without either repository's objects being touched by the other.
 */
export async function materializeArm(seed: SeedInfo, armDir: string): Promise<void> {
  const resolvedArmDir = path.resolve(armDir);
  if (fs.existsSync(resolvedArmDir)) {
    throw new Error(
      `refusing to materialize an arm at ${resolvedArmDir}: it already exists. Callers must mint ` +
        'fresh directories for each arm.',
    );
  }
  const parent = path.dirname(resolvedArmDir);
  fs.mkdirSync(parent, { recursive: true });

  await git(['clone', '--no-hardlinks', '--quiet', '--', seed.seed, resolvedArmDir], parent);
  await git(['checkout', '--quiet', '--detach', seed.baseCommit], resolvedArmDir);
  // A commit cannot fail on a machine with no global git identity configured.
  await git(['config', 'user.email', 'trial@agentic-army.invalid'], resolvedArmDir);
  await git(['config', 'user.name', 'Trial Arm'], resolvedArmDir);
}

function normalizeChangedPath(raw: string): string {
  return raw.trim().replace(/\\/g, '/');
}

function addNonEmptyLines(into: Set<string>, output: string): void {
  for (const line of output.split('\n')) {
    const normalized = normalizeChangedPath(line);
    if (normalized !== '') into.add(normalized);
  }
}

/**
 * Read back what an arm's workspace looks like now, as the closed evidence record checks run
 * against. MUST NOT throw — see the module doc.
 */
export async function collectEvidence(
  armDir: string,
  baseCommit: string,
  events: readonly SoldierEvent[],
): Promise<ArmEvidence> {
  const workspace = path.resolve(armDir);

  let headCommit: string | null = null;
  try {
    const trimmed = (await git(['rev-parse', 'HEAD'], workspace)).stdout.trim();
    headCommit = trimmed === '' ? null : trimmed;
  } catch {
    headCommit = null;
  }

  const changed = new Set<string>();
  try {
    addNonEmptyLines(changed, (await git(['diff', '--name-only', baseCommit, '--'], workspace)).stdout);
  } catch {
    /* degrade gracefully */
  }
  try {
    addNonEmptyLines(changed, (await git(['diff', '--name-only', '--'], workspace)).stdout);
  } catch {
    /* degrade gracefully */
  }
  try {
    addNonEmptyLines(changed, (await git(['diff', '--name-only', '--cached', '--'], workspace)).stdout);
  } catch {
    /* degrade gracefully */
  }
  try {
    addNonEmptyLines(
      changed,
      (await git(['ls-files', '--others', '--exclude-standard'], workspace)).stdout,
    );
  } catch {
    /* degrade gracefully */
  }

  let dirty = false;
  try {
    const status = (await git(['status', '--porcelain', '--untracked-files=all'], workspace)).stdout;
    dirty = status.trim() !== '';
  } catch {
    dirty = false;
  }

  return {
    workspace,
    baseCommit,
    headCommit,
    changedFiles: [...changed].sort(),
    dirty,
    events,
  };
}
