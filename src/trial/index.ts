/**
 * The trial layer — a controlled experiment on one worker, held still.
 *
 * A campaign asks whether the work got done. A trial asks what a variable is WORTH: same model,
 * same brief, same seed commit, one directory per arm, one thing changed. The contract it codes
 * against is `src/contracts/trial.ts`, which is where the reasoning about scoring lives.
 *
 * What each file covers:
 *   spec.ts       the trial file on disk, parsed into arms and checks
 *   workspace.ts  minting one identical workspace per arm, and reading back what changed
 *   checks.ts     scoring, over artifacts only — never over the worker's own report
 *   run.ts        the vacuity gate, arm execution, and the metrics
 *   report.ts     the table a human reads, and the caveats it is obliged to print
 *
 * The one thing worth knowing before reading any of it: nothing here scores a run from the
 * `Report` the worker returned. A worker that believes it finished and did not is the most
 * common failure this repo has recorded, so the evidence is the git state of the workspace and
 * the recorded event stream. `Report` is a good transport and a useless scoreboard.
 */

export * from './spec.ts';
export * from './workspace.ts';
export * from './checks.ts';
export * from './run.ts';
export * from './report.ts';
