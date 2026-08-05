/**
 * The trial runner — the vacuity gate, the arms, and nothing else.
 *
 * `runTrial` composes three modules that each know one thing: `./workspace.ts` knows how to
 * clone a seed and read back what happened to it, `./checks.ts` knows how to score an arm's
 * evidence, and `../command/campaign.ts` knows how to run one soldier through a harness and drain
 * its event stream. This file's whole job is ORDER: inspect the seed, refuse to run a vacuous
 * trial, materialize each arm from the identical base, run it through the same `runSoldier` a
 * campaign uses (a second spawn-and-drain loop here would be a second implementation to keep in
 * sync with the first, and this repo's standing rule is that two implementations plus a drift
 * test is worse than one), and turn what came back into a scored `ArmResult`.
 *
 * ## The vacuity gate
 *
 * A `job` check that already passes on the untouched seed measures nothing: every arm would score
 * full marks on it before a single token was spent, and the trial would report a result that says
 * nothing about the variable under test. So before any arm is spawned, ONE pristine copy of the
 * seed is materialized and the full check list is run against it. If any `job` check passes there,
 * the whole trial refuses — `vacuous` carries the evidence, `arms` stays empty, and no adapter is
 * ever called. `compliance` checks are exempt: passing on an untouched seed is their CORRECT
 * behaviour, because nothing was touched and so nothing was violated.
 *
 * ## The fail-soft archive
 *
 * The archive is an index over what happened, not the thing that happened. Registering an arm's
 * attempt can fail for reasons that have nothing to do with whether the arm's run itself is worth
 * having — a duplicate id, a locked database file — and losing an expensive, already-in-flight (or
 * already-finished) run to a bookkeeping error would be strictly worse than an archive row with a
 * gap in it. So every archive call in the per-arm path is caught, its message goes into that arm's
 * `errors`, and the run continues. The same reasoning, one level up, is why `collectEvidence`
 * itself (`./workspace.ts`) is written to never throw at all.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

import type {
  ArmMetrics,
  ArmResult,
  CheckExec,
  TrialArm,
  TrialResult,
  TrialSpec,
} from '../contracts/trial.ts';
import { scoreOf } from '../contracts/trial.ts';
import type {
  HarnessAdapter,
  ReasoningEffort,
  ResultEvent,
  SoldierEvent,
  SoldierStatus,
} from '../contracts/harness.ts';

import { buildSoldierSpec, runSoldier } from '../command/campaign.ts';
import { createCampaign } from '../archive/archive.ts';
import { claudeAdapter, createClaudeAdapter } from '../harness/claude.ts';

import { collectEvidence, inspectSeed, materializeArm } from './workspace.ts';
import { evaluateChecks, vacuousJobChecks } from './checks.ts';

// ---------------------------------------------------------------------------------------------
// The effort mirror — see the module doc and the drift test in test/trial-run.test.ts
// ---------------------------------------------------------------------------------------------

/**
 * Mirrors `CLAUDE_EFFORT` in `src/harness/claude.ts`, which is not exported. Duplicating it here
 * rather than importing it is the deliberate call: `runTrial` only ever spawns the `claude`
 * harness (`harness: 'claude'` is hard-coded in the spec it builds below), so it needs to know
 * what value the adapter actually sends on the wire in order to record `ArmResult.effectiveEffort`
 * honestly. `test/trial-run.test.ts` calls `buildClaudeArgs` once per `ReasoningEffort` and
 * asserts the value following `--effort` equals this table's value for the same key — that test is
 * the drift detector; a mirrored table with no test would be exactly the duplication this repo
 * forbids.
 */
export const TRIAL_EFFECTIVE_EFFORT: Record<ReasoningEffort, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

// ---------------------------------------------------------------------------------------------
// The default CommandCheck runner
// ---------------------------------------------------------------------------------------------

/**
 * The real process runner behind a `CommandCheck`. Shells out with `shell: true` deliberately —
 * `run` is the trial author's own command, trusted the same way a `package.json` script is (see
 * `CommandCheck` in `src/contracts/trial.ts`), and it is expected to use shell syntax (`&&`,
 * pipes) the way an npm script does.
 */
function defaultCheckExec(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
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
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export interface RunTrialOptions {
  spec: TrialSpec;
  /** Injected so tests never spawn a real CLI. Defaults to the real claude adapter. */
  adapter?: HarnessAdapter;
  /** Injected for CommandCheck execution. Defaults to a real child-process runner. */
  exec?: CheckExec;
  /** Absolute path used as the army home for permission building. Required. */
  home: string;
  /** Progress lines. Optional; the CLI passes a writer. */
  onProgress?: (line: string) => void;
  /** Injectable clock returning epoch millis, for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeProgress(onProgress: ((line: string) => void) | undefined, line: string): void {
  if (onProgress === undefined) return;
  try {
    onProgress(line);
  } catch {
    // A broken progress sink must never kill a run.
  }
}

const ARM_ID_RE = /[/\\]|\.\./;

/** Arm ids are minted by the trial author, not the model — still validated before they name a directory. */
function assertSafeArmId(id: string): void {
  if (id === '' || ARM_ID_RE.test(id) || id.startsWith('.')) {
    throw new Error(
      `trial arm id ${JSON.stringify(id)} is not filesystem-safe: it may not be empty, contain ` +
        '"/", "\\" or "..", or start with ".".',
    );
  }
}

function isResultEvent(event: SoldierEvent): event is ResultEvent {
  return event.type === 'result';
}

// ---------------------------------------------------------------------------------------------
// runTrial
// ---------------------------------------------------------------------------------------------

export async function runTrial(options: RunTrialOptions): Promise<TrialResult> {
  const spec = options.spec;
  const now = options.now ?? Date.now;
  // The default adapter only, and only when the trial itself minted it: an INJECTED adapter is
  // the caller's own (a test's fake, or a future CLI override) and reconfiguring it out from under
  // the caller would be surprising and unnecessary — the caller already had every chance to pass
  // its own `closeGraceMs`. `spec.armTimeoutMs` exists to raise the adapter's silent five-minute
  // ceiling (see the field's doc in `src/contracts/trial.ts`), so it is threaded through only on
  // the path that constructs the adapter in the first place.
  const adapter =
    options.adapter ??
    (spec.armTimeoutMs !== undefined
      ? createClaudeAdapter({ closeGraceMs: spec.armTimeoutMs })
      : claudeAdapter);
  const exec = options.exec ?? defaultCheckExec;
  const onProgress = options.onProgress;
  const home = options.home;

  const startedAt = new Date(now()).toISOString();
  const seedInfo = await inspectSeed(spec.seed);

  // ---- the vacuity gate, before anything is spawned --------------------------------------
  const seedCheckDir = path.join(spec.outDir, '_seed-check');
  await materializeArm(seedInfo, seedCheckDir);
  const seedEvidence = await collectEvidence(seedCheckDir, seedInfo.baseCommit, []);
  const seedCheckResults = await evaluateChecks(spec.checks, seedEvidence, exec);
  const vacuous = vacuousJobChecks(seedCheckResults);
  if (vacuous.length > 0) {
    return {
      title: spec.title,
      mode: spec.mode,
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      seed: seedInfo.seed,
      baseCommit: seedInfo.baseCommit,
      outDir: spec.outDir,
      arms: [],
      vacuous,
      ...(spec.armTimeoutMs !== undefined ? { armTimeoutMs: spec.armTimeoutMs } : {}),
    };
  }

  for (const arm of spec.arms) assertSafeArmId(arm.id);

  // ---- one campaign archive for the whole trial -------------------------------------------
  const archive = createCampaign(
    { archiveRoot: path.join(spec.outDir, 'archive') },
    { project: spec.seed, title: spec.title },
  );

  const runArm = async (arm: TrialArm): Promise<ArmResult> => {
    const armDir = path.join(spec.outDir, arm.id);
    const errors: string[] = [];
    let events: readonly SoldierEvent[] = [];
    let status: SoldierStatus | 'spawn-failed' = 'spawn-failed';
    let metrics: ArmMetrics = {
      wallMs: 0,
      harnessDurationMs: null,
      costUsd: null,
      turns: 0,
      toolCalls: 0,
      inputTokens: null,
      outputTokens: null,
    };

    safeProgress(onProgress, `arm ${arm.id}: starting`);

    try {
      await materializeArm(seedInfo, armDir);

      const armSpec = buildSoldierSpec({
        agentId: arm.id,
        rank: 'CAPTAIN',
        role: 'ENGINEER',
        harness: 'claude',
        model: arm.model,
        effort: arm.effort,
        cwd: armDir,
        orders: arm.orders,
        home,
        outputSchemaPath: path.join(import.meta.dirname, '../../schemas/report.v1.json'),
        fanOut: false,
      });

      try {
        archive.recordAgentAttempt({
          id: arm.id,
          rank: 'CAPTAIN',
          role: 'ENGINEER',
          harness: 'claude',
          model: arm.model,
          effort: arm.effort,
          sessionId: armSpec.sessionId,
          worktreePath: armDir,
        });
      } catch (error) {
        errors.push(`archive: ${errorMessage(error)}`);
      }

      const start = now();
      const run = await runSoldier(adapter, armSpec, archive);
      const wallMs = now() - start;

      events = run.events;
      status = run.status as SoldierStatus;
      errors.push(...run.errors);

      const lastResult = [...run.events].reverse().find(isResultEvent);
      metrics = {
        wallMs,
        harnessDurationMs: run.durationMs,
        costUsd: run.costUsd,
        turns: events.filter((event) => event.type === 'assistant_text').length,
        toolCalls: events.filter((event) => event.type === 'tool_use').length,
        inputTokens: lastResult?.usage?.inputTokens ?? null,
        outputTokens: lastResult?.usage?.outputTokens ?? null,
      };
    } catch (error) {
      status = 'spawn-failed';
      errors.push(errorMessage(error));
    }

    const evidence = await collectEvidence(armDir, seedInfo.baseCommit, events);
    const checks = await evaluateChecks(spec.checks, evidence, exec);

    const result: ArmResult = {
      arm,
      effectiveEffort: TRIAL_EFFECTIVE_EFFORT[arm.effort],
      workspace: evidence.workspace,
      status,
      metrics,
      checks,
      errors,
    };

    const job = scoreOf(result, 'job');
    const compliance = scoreOf(result, 'compliance');
    safeProgress(
      onProgress,
      `arm ${arm.id}: finished in ${(result.metrics.wallMs / 1000).toFixed(1)}s — ` +
        `job ${String(job.passed)}/${String(job.total)}, compliance ${String(compliance.passed)}/${String(compliance.total)}`,
    );

    return result;
  };

  const arms: ArmResult[] =
    spec.mode === 'serial'
      ? await (async () => {
          const out: ArmResult[] = [];
          for (const arm of spec.arms) out.push(await runArm(arm));
          return out;
        })()
      : await Promise.all(spec.arms.map((arm) => runArm(arm)));

  try {
    archive.close();
  } catch {
    // The archive is an index; a close failure at the very end costs nothing that matters.
  }

  return {
    title: spec.title,
    mode: spec.mode,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    seed: seedInfo.seed,
    baseCommit: seedInfo.baseCommit,
    outDir: spec.outDir,
    arms,
    vacuous: [],
    ...(spec.armTimeoutMs !== undefined ? { armTimeoutMs: spec.armTimeoutMs } : {}),
  };
}
