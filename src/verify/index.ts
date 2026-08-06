/**
 * The verify layer — running a command, and deciding whether a spec's acceptance was met.
 *
 * What each file covers:
 *   exec.ts   the single process runner, `runCommand` — shared by the trial's `CommandCheck`s
 *             and the acceptance gate below, because two process runners kept in step by a test
 *             is worse than one
 *   gate.ts   `runAcceptanceGate`, which runs a spec's `verify` commands against an Engineer's
 *             worktree, and `renderAcceptanceFailure`, the one renderer for what came back
 *
 * The contract both code against — `CommandResult`, `CommandRunner`, `VerifyOutcome`,
 * `AcceptanceResult` — lives in `src/contracts/verify.ts`, not here.
 */

export * from './exec.ts';
export * from './gate.ts';
