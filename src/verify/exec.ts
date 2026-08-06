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
 */

import { spawn } from 'node:child_process';

import type { CommandRunner } from '../contracts/verify.ts';

export const runCommand: CommandRunner = (command, cwd, timeoutMs) => {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, { cwd, shell: true });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    child.on('close', (code) => finish(code));
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(null);
    });
  });
};
