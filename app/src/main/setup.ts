/**
 * Finding claude and codex on a Mac that just installed them. The app reads your login shell's
 * PATH when it starts, which misses a CLI installed after that, and misses one whose installer put
 * it in a folder the shell profile does not list yet (Claude Code's goes to ~/.local/bin).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { loginShellPath } from './git.ts';

/** Where the claude installer, Homebrew and npm put command-line tools. */
function usualDirs(): string[] {
  const home = homedir();
  return [join(home, '.local/bin'), join(home, '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global/bin')];
}

/** Add the usual install folders that exist to the end of PATH, so the shell's own order still wins. */
export function addUsualDirs(): void {
  const have = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d !== '');
  const extra = usualDirs().filter((d) => !have.includes(d) && existsSync(d));
  if (extra.length > 0) process.env['PATH'] = [...have, ...extra].join(delimiter);
}

/**
 * Read the login shell's PATH again, then add the usual folders. "Check again" runs this, so a CLI
 * installed while the app was open is found without a restart.
 */
export async function refreshPath(): Promise<void> {
  if (process.platform === 'darwin') {
    const path = await loginShellPath();
    if (path !== null && path !== '') process.env['PATH'] = path;
  }
  addUsualDirs();
}
