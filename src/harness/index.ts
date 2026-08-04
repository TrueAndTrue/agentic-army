/**
 * The adapter registry.
 *
 * Everything above this file is harness-neutral. Dispatch resolves a rule to a
 * `{ harness, model, effort }` triple; this module turns the `harness` half of that into a live
 * `Soldier`. Adding a third vendor is a new entry in `ADAPTERS` plus a widened `HarnessId` —
 * nothing above the seam changes.
 *
 * The caller's sequence is deliberately identical for both harnesses, one-shot or duplex:
 *
 * ```ts
 * const soldier = await spawnSoldier(spec);
 * const pump = (async () => { for await (const e of soldier.stream()) archive.write(e); })();
 * await soldier.send(spec.orders);
 * const result = await soldier.close();
 * await pump;
 * ```
 */

import type { HarnessAdapter, HarnessId, Soldier, SoldierSpec } from '../contracts/harness.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';

export const ADAPTERS: Record<HarnessId, HarnessAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

/** Throws on an unknown id rather than returning undefined — a bad dispatch is a bug, not a state. */
export function getAdapter(id: HarnessId): HarnessAdapter {
  const adapter = ADAPTERS[id];
  if (adapter === undefined) {
    throw new Error(`unknown harness \`${String(id)}\`; expected one of ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return adapter;
}

/** Dispatch by `spec.harness`. The one entry point a supervisor needs. */
export function spawnSoldier(spec: SoldierSpec): Promise<Soldier> {
  return getAdapter(spec.harness).spawn(spec);
}

export {
  createJsonlFramer,
  framedLines,
  parseJsonl,
  createAsyncQueue,
} from './jsonl.ts';
export type { JsonlLine, JsonlFramer, JsonlFramerOptions, AsyncQueue } from './jsonl.ts';

export {
  buildClaudeArgs,
  buildClaudeEnv,
  claudeAdapter,
  claudeResultStatus,
  createClaudeAdapter,
  createClaudeNormalizer,
  isClaudeAbortReason,
  CLAUDE_ENV_FORBIDDEN,
  CLAUDE_TERMINAL_ABORT,
  CLAUDE_TERMINAL_CEILING,
  CLAUDE_TERMINAL_ERROR,
  CLAUDE_TERMINAL_OK,
} from './claude.ts';
export type {
  ClaudeAdapterOptions,
  ClaudeArgsOptions,
  ClaudeNormalizer,
  ClaudeNormalizerOptions,
  ClaudeResultContext,
} from './claude.ts';

export {
  assertCodexSpecArgSafe,
  buildCodexArgs,
  buildCodexEnv,
  buildCodexEnvDetailed,
  isForwardableCodexEnvKey,
  codexBreachMessage,
  codexConfinement,
  CODEX_ENV_ALLOW,
  CODEX_ENV_FORBIDDEN,
  codexAdapter,
  codexThreadId,
  createCodexAdapter,
  createCodexNormalizer,
  isCodexSoldier,
} from './codex.ts';
export type {
  CodexAdapterOptions,
  CodexArgsOptions,
  CodexConfinement,
  CodexEnvResult,
  CodexNormalizer,
  CodexNormalizerOptions,
  CodexSoldier,
} from './codex.ts';
