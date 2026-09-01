/**
 * The single process runner behind `CommandRunner` (`src/contracts/verify.ts`).
 *
 * Two callers need it: the trial harness's `CommandCheck`s, which score an arm against the
 * author's own command, and the campaign's acceptance gate (`./gate.ts`), which runs the
 * commander's `spec.verify` commands before an Inspector is spent on a branch. Both used to spawn
 * their own copy — this one started life as `defaultCheckExec` in `src/trial/run.ts` — and two
 * process runners kept byte-identical by a test is worse than one, so it lives here, below both,
 * moved verbatim rather than reimplemented.
 *
 * Shells out with `shell: true` deliberately: the command is the trial author's or the
 * commander's own, trusted the same way a `package.json` script is, and is expected to use shell
 * syntax (`&&`, pipes) the way an npm script does.
 *
 * The timeout handling mirrors `runResolved` in `src/setup/checks.ts` — the doctor's probe runner
 * solved this first, and this module inherited its bug before inheriting its fix. `kill()` on the
 * shell alone leaves any grandchild (a dev server, a `cmd &`) holding the stdio pipes, and a
 * promise that resolves on 'close' then never resolves at all — which hangs the campaign while
 * the worktree lease is held. Hence: detached spawn + `killProcessTree`, and a hard backstop that
 * settles the promise and destroys our pipe ends even if something survives the kill.
 */

import { spawn } from 'node:child_process';

import type { CommandRunner } from '../contracts/verify.ts';
import { killProcessTree } from '../setup/checks.ts';

/**
 * How long after the deadline kill the runner waits for 'close' before settling anyway. Long
 * enough for a killed tree's pipes to drain normally, short enough that a verify command can
 * never stall a campaign past its own timeout by more than this.
 */
const HARD_BACKSTOP_GRACE_MS = 1000;

export const runCommand: CommandRunner = (command, cwd, timeoutMs, signal) => {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd,
      shell: true,
      // Own process group (POSIX), so the deadline kill can reach the whole subtree instead of
      // just the shell. `killProcessTree` handles Windows via taskkill, no group needed there.
      detached: process.platform !== 'win32',
    });

    const timers: NodeJS.Timeout[] = [];
    let unlisten: (() => void) | null = null;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      // Removed rather than left on the signal: one `AbortSignal` covers every command in a gate,
      // so a listener per command that is never taken off accumulates for the length of the run
      // and keeps a reference to a child that has already gone.
      if (unlisten !== null) unlisten();
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('close', (code) => finish(code));
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(null);
    });

    // The caller changed its mind — a human pressed Ctrl-C at the alignment gate. The same kill
    // the deadline performs, WITHOUT `timedOut`: nothing timed out, somebody asked it to stop, and
    // the two readings are told apart everywhere else in this system. 'close' reports whatever the
    // command had said by then.
    if (signal !== undefined) {
      if (signal.aborted) {
        killProcessTree(child);
      } else {
        const onAbort = (): void => {
          killProcessTree(child);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        unlisten = (): void => {
          signal.removeEventListener('abort', onAbort);
        };
      }
    }

    // Soft deadline: kill the tree and let 'close' report whatever was captured.
    const soft = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    // Hard backstop: if something still holds the pipes open after the kill, settle anyway.
    // Settling alone is not enough — a survivor keeps Node's event loop alive through the
    // still-referenced pipe sockets — so our ends are destroyed and the child unreferenced,
    // making the guarantee about the caller's process, not merely this promise.
    const hard = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish(null);
    }, timeoutMs + HARD_BACKSTOP_GRACE_MS);

    // Unref'd so a fast, well-behaved command never has these timers holding the process open.
    soft.unref();
    hard.unref();
    timers.push(soft, hard);
  });
};
