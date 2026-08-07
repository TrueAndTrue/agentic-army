/**
 * The abort seam: killing a soldier's WHOLE process tree, immediately.
 *
 * `Soldier.close()` is the polite path — stdin EOF, a grace window, then SIGTERM — and its grace
 * window is the soldier's entire working budget (30 minutes for a campaign Engineer), which makes
 * it useless as a response to Ctrl-C. The field failure this file exists for: SIGINT on a running
 * campaign ended the supervisor in milliseconds and left the claude soldier — running with
 * `--permission-mode dontAsk` — alive until it happened to notice stdin EOF. An agent with
 * dontAsk permissions outliving its supervisor is the worst version of an orphaned child.
 *
 * Both adapters therefore spawn their children DETACHED on POSIX (a process group of their own,
 * same pattern as `spawnProbeChild` and `src/verify/exec.ts`) and expose `killTree()`, which
 * SIGKILLs the group via `killProcessTree` — so a soldier's own grandchildren (an MCP server, a
 * shell it left running, anything that ignores SIGTERM) die with it. Detaching also takes the
 * soldier OUT of the terminal's foreground group, which is deliberate: Ctrl-C now reaches the
 * supervisor alone, and the supervisor decides what happens to its troops rather than the
 * terminal racing it.
 *
 * The method lives on the concrete soldier objects, not on the `Soldier` contract — the same
 * structural-widening pattern as `CodexSoldier.outputText`: a caller typed against the contract
 * is unaffected, and a caller that needs the kill narrows through `killSoldierTree`.
 */

import type { Soldier } from '../contracts/harness.ts';

export interface KillableSoldier extends Soldier {
  /** SIGKILL the soldier's whole process group, now. Idempotent; safe after exit. */
  killTree(): void;
}

export function isKillableSoldier(soldier: Soldier): soldier is KillableSoldier {
  return typeof (soldier as Partial<KillableSoldier>).killTree === 'function';
}

/** Kill if the seam exists. True when a kill was actually issued. */
export function killSoldierTree(soldier: Soldier): boolean {
  if (!isKillableSoldier(soldier)) return false;
  soldier.killTree();
  return true;
}
