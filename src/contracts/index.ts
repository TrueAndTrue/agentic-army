/**
 * The shared type layer. Every other module codes against this and nothing else.
 *
 * Erasable-syntax only: these files are run directly by `node` (Node 24 native type stripping)
 * and compiled with `tsc` only at publish time. That means NO `enum`, NO `namespace`, NO
 * decorators, NO constructor parameter properties; every type-only import must say
 * `import type`; every relative import must carry an explicit `.ts` extension. Node strips
 * per-file with no cross-file analysis, so a missing `import type` is a runtime crash, not a
 * type error.
 *
 * What each file covers:
 *   ranks.ts     authority, branch of service, who may spawn whom, who may write
 *   harness.ts   the four-verb adapter contract and the neutral event stream
 *   report.ts    the schema-capped return — the context guard
 *   spec.ts      the technical spec a commander owes a cheap worker
 *   archive.ts   row shapes; append-only signals; SQLite indexes, files are truth
 *   worktree.ts  leases, detached HEAD, destructive release
 *   delivery.ts  the rung ladder and the ceiling clamp
 *   config.ts    dispatch rules and per-project ceilings
 */

export * from './ranks.ts';
export * from './harness.ts';
export * from './report.ts';
export * from './spec.ts';
export * from './archive.ts';
export * from './worktree.ts';
export * from './delivery.ts';
export * from './config.ts';
