/**
 * Token counts, the way both CLIs report them once they are put in the same terms. The app runs
 * on your claude and codex logins, so tokens are what a turn really spends; a dollar figure would
 * be what the same turn costs at API prices, which nobody paid.
 */

import type { TokenCount } from './types.ts';

export function addTokens(a: TokenCount | undefined, b: TokenCount | undefined): TokenCount | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  // Context is a level, not an amount: the later turn's reading is the one that holds.
  const context = b.context ?? a.context;
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, ...(context === undefined ? {} : { context }) };
}

/**
 * One turn's tokens from codex's running total. codex counts from the start of the conversation
 * (measured: a resumed turn that wrote 5 tokens reported output 10), so a resumed turn subtracts
 * the total it last saw. A total below the last one means a new conversation, so it stands alone.
 */
export function tokensSince(total: TokenCount, before: TokenCount | undefined): TokenCount {
  if (before === undefined || total.input < before.input || total.output < before.output) return total;
  return { input: total.input - before.input, cached: Math.max(0, total.cached - before.cached), output: total.output - before.output };
}
