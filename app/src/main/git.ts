/**
 * Git for runs. A run that needs to write gets its own worktree on a branch `army/run-<id>`, cut
 * from the project's HEAD. Nothing touches the project's checkout until you merge.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { DiffResult, GitConfig, ProjectHealth, Run } from '../shared/types.ts';

export interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string): Promise<Exec> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function must(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export async function isRepo(path: string): Promise<boolean> {
  return (await git(['rev-parse', '--is-inside-work-tree'], path)).stdout.trim() === 'true';
}

export async function currentBranch(path: string): Promise<string | null> {
  const r = await git(['symbolic-ref', '--short', '-q', 'HEAD'], path);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** What a flow needs from a project folder, and what it found there. */
export async function projectHealth(path: string): Promise<ProjectHealth> {
  if (!existsSync(path)) return { exists: false, git: 'none', dirty: 0 };
  if (!(await isRepo(path))) return { exists: true, git: 'none', dirty: 0 };
  const head = await git(['rev-parse', '--verify', 'HEAD'], path);
  const dirty = (await git(['status', '--porcelain'], path)).stdout.split('\n').filter((l) => l.trim() !== '').length;
  return { exists: true, git: head.code === 0 ? 'ok' : 'no-commits', dirty };
}

/**
 * Make a folder a repository flows can branch from: `git init` if it is not one, then one commit
 * of what is there. Only when you press the button that says so.
 */
export async function setUpGit(path: string): Promise<void> {
  if (!(await isRepo(path))) await must(['init', '-q'], path);
  await must(['add', '-A'], path);
  const r = await git(['commit', '-q', '--allow-empty', '-m', 'Start tracking this folder'], path);
  if (r.code !== 0) throw new Error(`git commit failed: ${(r.stderr || r.stdout).trim()}. Set your name and email with "git config --global user.name" and "user.email", then try again.`);
}

/** Create the run's worktree if it has none yet, and return its path. */
export async function ensureWorkspace(run: Run, projectPath: string, root: string): Promise<{ path: string; notice?: string }> {
  if (run.worktreePath !== undefined && existsSync(run.worktreePath)) return { path: run.worktreePath };
  if (!(await isRepo(projectPath))) {
    throw new Error(`${projectPath} is not a git repository. A node that writes needs one, so the run can work on its own branch. Run "git init" there and commit once, or set the node's workspace to Project.`);
  }
  const head = await git(['rev-parse', '--verify', 'HEAD'], projectPath);
  if (head.code !== 0) throw new Error(`${projectPath} has no commits yet. Commit once so a run has something to branch from.`);
  const baseRef = (await currentBranch(projectPath)) ?? head.stdout.trim();
  const branch = `army/run-${run.id.slice(-8)}`;
  const path = join(root, run.id);
  mkdirSync(root, { recursive: true });
  await must(['worktree', 'add', '-b', branch, path, 'HEAD'], projectPath);
  run.worktreePath = path;
  run.branch = branch;
  run.baseRef = baseRef;
  return { path };
}

async function commitAll(cwd: string, message: string): Promise<boolean> {
  await must(['add', '-A'], cwd);
  const staged = await git(['diff', '--cached', '--quiet'], cwd);
  if (staged.code === 0) return false;
  await must(['commit', '-q', '--no-verify', '-m', message], cwd);
  return true;
}

/**
 * Seal a finished run: commit what is left in its worktree, remove the worktree, and keep the
 * branch if it holds any work. A branch with nothing on it is deleted.
 */
export async function finalizeWorkspace(run: Run, projectPath: string): Promise<void> {
  if (run.worktreePath === undefined || run.branch === undefined) return;
  if (existsSync(run.worktreePath)) {
    try {
      await commitAll(run.worktreePath, `${run.flowName}: work its agents left uncommitted`);
    } catch {
      /* a commit that fails leaves the files in the tree; removal below reports it */
    }
    await git(['worktree', 'remove', '--force', run.worktreePath], projectPath);
  }
  run.worktreePath = undefined;
  const ahead = await git(['rev-list', '--count', `${run.baseRef ?? 'HEAD'}..${run.branch}`], projectPath);
  if (ahead.code === 0 && ahead.stdout.trim() === '0') {
    await git(['branch', '-D', run.branch], projectPath);
    run.branch = undefined;
  }
}

const PATCH_LIMIT = 200_000;

export async function runDiff(run: Run, projectPath: string): Promise<DiffResult> {
  if (run.branch === undefined) return { stat: '', patch: '', truncated: false };
  const base = run.baseRef ?? 'HEAD';
  let stat: string;
  let patch: string;
  if (run.worktreePath !== undefined && existsSync(run.worktreePath)) {
    // Include what is not committed yet. `add -N` makes new files show without staging content.
    await git(['add', '-A', '-N'], run.worktreePath);
    const mergeBase = (await git(['merge-base', base, 'HEAD'], run.worktreePath)).stdout.trim() || base;
    stat = (await git(['diff', '--stat', mergeBase], run.worktreePath)).stdout;
    patch = (await git(['diff', mergeBase], run.worktreePath)).stdout;
  } else {
    stat = (await git(['diff', '--stat', `${base}...${run.branch}`], projectPath)).stdout;
    patch = (await git(['diff', `${base}...${run.branch}`], projectPath)).stdout;
  }
  const truncated = patch.length > PATCH_LIMIT;
  // Keep the leading space on each line: it is what lines the file columns up.
  return { stat: stat.replace(/^\n+/, '').trimEnd(), patch: truncated ? patch.slice(0, PATCH_LIMIT) : patch, truncated };
}

/** Merge the run's branch into the branch it was cut from, in the project checkout. */
export async function mergeRun(run: Run, projectPath: string, message: string): Promise<{ ok: boolean; message: string }> {
  if (run.branch === undefined) return { ok: false, message: 'This run changed no files, so there is nothing to merge.' };
  if (run.worktreePath !== undefined && existsSync(run.worktreePath)) {
    await commitAll(run.worktreePath, message);
  }
  const current = await currentBranch(projectPath);
  if (run.baseRef !== undefined && current !== run.baseRef) {
    return { ok: false, message: `Your checkout is on ${current ?? 'a detached HEAD'}, and this run branched from ${run.baseRef}. Switch back to ${run.baseRef} to merge.` };
  }
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'], projectPath)).stdout.trim();
  if (dirty !== '') return { ok: false, message: `Your checkout has uncommitted changes. Commit or stash them, then merge.` };
  const r = await git(['merge', '--no-ff', '-m', message, run.branch], projectPath);
  if (r.code !== 0) {
    await git(['merge', '--abort'], projectPath);
    const files = (r.stdout + r.stderr).split('\n').flatMap((l) => /CONFLICT .* in (.+)$/.exec(l)?.[1] ?? []);
    return {
      ok: false,
      message:
        `The merge conflicted${files.length === 0 ? '' : ` in ${files.join(', ')}`}, so the app undid it and your checkout is as it was. ` +
        `To resolve it, run "git merge ${run.branch}" in the project and fix the conflicts, or ask the chat here to do that.`,
    };
  }
  run.merged = true;
  return { ok: true, message: `Merged ${run.branch} into ${current ?? 'HEAD'}.` };
}

/** The Git node. */
export async function gitNode(run: Run, config: GitConfig, message: string, projectPath: string): Promise<{ ok: boolean; output: string }> {
  if (run.worktreePath === undefined || !existsSync(run.worktreePath)) {
    return { ok: false, output: 'No node has written to the run workspace yet, so there is nothing for git to act on.' };
  }
  try {
    if (config.action === 'diff') {
      const d = await runDiff(run, projectPath);
      return { ok: true, output: d.patch === '' ? 'No changes.' : `${d.stat}\n\n${d.patch.slice(0, 40_000)}` };
    }
    if (config.action === 'commit') {
      const made = await commitAll(run.worktreePath, message);
      return { ok: true, output: made ? `Committed on ${run.branch ?? 'the run branch'}: ${message}` : 'Nothing to commit.' };
    }
    const res = await mergeRun(run, projectPath, message);
    return { ok: res.ok, output: res.message };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

const SHELL_OUTPUT_LIMIT = 60_000;

/** Run a command through the login shell, killing its whole process group on timeout or stop. */
export function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const shell = process.env['SHELL'] ?? '/bin/zsh';
    const child = spawn(shell, ['-lc', command], { cwd, detached: true, env: process.env });
    let output = '';
    const take = (b: Buffer) => {
      output += b.toString();
      if (output.length > SHELL_OUTPUT_LIMIT * 2) output = output.slice(-SHELL_OUTPUT_LIMIT);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `Could not start the command: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      const tail = output.length > SHELL_OUTPUT_LIMIT ? `…\n${output.slice(-SHELL_OUTPUT_LIMIT)}` : output;
      resolve({ code, output: tail });
    });
  });
}

/** Apps started from the Dock get a minimal PATH. Borrow the login shell's so claude and codex resolve. */
export function loginShellPath(): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env['SHELL'] ?? '/bin/zsh';
    execFile(shell, ['-ilc', 'printf "__PATH__%s__END__" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      if (err !== null) return resolve(null);
      const m = /__PATH__(.*)__END__/s.exec(String(stdout));
      resolve(m?.[1] ?? null);
    });
  });
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
