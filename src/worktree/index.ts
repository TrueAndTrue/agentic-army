/**
 * Provider selection.
 *
 * **There is one provider now.** treehouse was dropped as a dependency and warm pooling was
 * brought in-house (`cold.ts`), so the old job of this file — probe for a binary, fall back, and
 * make the downgrade visible — is gone with it. What is deliberately NOT gone is the
 * `WorktreeProvider` seam: it is the reason replacing treehouse was a swap rather than a rewrite,
 * and the next thing that wants to own worktrees (a devcontainer, a remote builder, a
 * copy-on-write snapshot on APFS or btrfs) will arrive through the same door.
 *
 * `WorktreeProviderId` still spells `'treehouse'` because `src/contracts/worktree.ts` is frozen.
 * Asking for it is not an error and not a downgrade — there is nothing to downgrade FROM — but it
 * is worth a warning, because a caller that asks for a provider it does not get should be told.
 */

import type { WorktreeProvider, WorktreeProviderId } from '../contracts/worktree.ts';
import { ColdWorktreeProvider } from './cold.ts';
import type { ColdWorktreeProviderOptions } from './cold.ts';

export * from './cold.ts';
export * from './hooks.ts';

/** A machine-readable note. `code` is stable; `message` is for humans. */
export interface WorktreeNote {
  level: 'info' | 'warn';
  code: 'provider-selected' | 'provider-forced' | 'provider-retired';
  message: string;
}

export interface WorktreeSelection {
  provider: WorktreeProvider;
  selected: WorktreeProviderId;
  /** What was asked for. Differs from `selected` only when a retired provider was requested. */
  preferred: WorktreeProviderId;
  note: WorktreeNote;
}

export interface SelectWorktreeProviderOptions {
  /**
   * Options for the pooled provider. Still named `cold` because that is the frozen provider id
   * and the key `src/command/campaign.ts` passes.
   */
  cold: ColdWorktreeProviderOptions;
  /** Defaults to `cold`, which is the only provider there is. */
  prefer?: WorktreeProviderId;
  /** Injection seam for tests and for a supervisor that already built its provider. */
  providers?: { cold?: WorktreeProvider };
}

/**
 * Pick a provider. Never throws and never probes a binary: the pool is pure git, so "is it
 * available" is "is git installed", which every other part of this system already assumes.
 */
export async function selectWorktreeProvider(
  options: SelectWorktreeProviderOptions,
): Promise<WorktreeSelection> {
  const preferred: WorktreeProviderId = options.prefer ?? 'cold';
  const provider = options.providers?.cold ?? new ColdWorktreeProvider(options.cold);

  if (preferred === 'treehouse') {
    return {
      provider,
      selected: 'cold',
      preferred,
      note: {
        level: 'warn',
        code: 'provider-retired',
        message:
          'treehouse was requested, but it is no longer a provider: pooling, warm reuse and ' +
          '`post_create` are implemented in-house now. Using the built-in pool, ' +
          'which is what `cold` names — leases are ABA-safe, trees hand out at detached HEAD, ' +
          'and dependency directories survive a release.',
      },
    };
  }

  return {
    provider,
    selected: 'cold',
    preferred,
    note: {
      level: 'info',
      code: preferred === 'cold' && options.prefer !== undefined ? 'provider-forced' : 'provider-selected',
      message:
        'pooled git worktrees: warm reuse with preserved dependency directories, `post_create` ' +
        'after provision and after every reset, ABA-safe conditional release.',
    },
  };
}
