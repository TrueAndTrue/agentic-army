/**
 * Render a `TrialResult` for a human reading a terminal, and for a machine reading a file.
 *
 * Plain ASCII only — no colour, no box-drawing, no Unicode ticks. This output is pasted into
 * issues and read over ssh, and both of those strip or mangle anything fancier than the 96
 * printable characters every terminal on earth agrees on.
 *
 * `renderTrialResult` is also where the report earns its keep as something other than a table: a
 * vacuous trial gets a refusal instead of a table full of full marks, and two arms that were sent
 * the identical `effectiveEffort` get a line saying so, because a reader comparing their numbers
 * would otherwise conclude something about effort that the harness never actually varied.
 */

import type { ArmResult, CheckKind, TrialResult } from '../contracts/trial.ts';
import { scoreOf } from '../contracts/trial.ts';

// ---------------------------------------------------------------------------------------------
// Cell formatting
// ---------------------------------------------------------------------------------------------

/** `1m12s` at or above 60s, `47.3s` below it. Never lets a rounded 59.95s read as `1m60s`. */
function formatWall(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  let minutes = Math.floor(totalSeconds / 60);
  let seconds = Math.round(totalSeconds - minutes * 60);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return `${String(minutes)}m${String(seconds)}s`;
}

function formatCost(usd: number | null): string {
  return usd === null ? '-' : `$${usd.toFixed(4)}`;
}

/** `2/3 ok` when every check of this kind passed, `2/3 FAIL` otherwise. Never a Unicode tick. */
function formatTally(score: { passed: number; total: number }): string {
  const base = `${String(score.passed)}/${String(score.total)}`;
  return score.passed === score.total ? `${base} ok` : `${base} FAIL`;
}

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

interface Row {
  arm: string;
  sent: string;
  job: string;
  orders: string;
  wall: string;
  tools: string;
  cost: string;
}

const COLUMNS: ReadonlyArray<keyof Row> = ['arm', 'sent', 'job', 'orders', 'wall', 'tools', 'cost'];
const HEADER: Row = { arm: 'arm', sent: 'sent', job: 'job', orders: 'orders', wall: 'wall', tools: 'tools', cost: 'cost' };

function rowOf(result: ArmResult): Row {
  return {
    arm: result.arm.id,
    sent: result.effectiveEffort,
    job: formatTally(scoreOf(result, 'job')),
    orders: formatTally(scoreOf(result, 'compliance')),
    wall: formatWall(result.metrics.wallMs),
    tools: String(result.metrics.toolCalls),
    cost: formatCost(result.metrics.costUsd),
  };
}

function renderTable(arms: readonly ArmResult[]): string[] {
  const rows = arms.map(rowOf);
  const widths = Object.fromEntries(
    COLUMNS.map((c) => [c, Math.max(HEADER[c].length, ...rows.map((r) => r[c].length))]),
  ) as Record<keyof Row, number>;
  const renderRow = (row: Row): string =>
    COLUMNS.map((c) => row[c].padEnd(widths[c])).join('  ').trimEnd();
  return [renderRow(HEADER), ...rows.map(renderRow)];
}

// ---------------------------------------------------------------------------------------------
// Failures, statuses, and the two disclosures the mode and the effort mapping owe the reader
// ---------------------------------------------------------------------------------------------

function renderFailures(result: ArmResult): string[] {
  const failed = result.checks.filter((check) => !check.passed);
  if (failed.length === 0) return [];
  const lines = [`${result.arm.id}:`];
  for (const check of failed) {
    lines.push(`  - ${check.id} (${check.kind as CheckKind}): ${check.detail}`);
  }
  return lines;
}

/**
 * Arms that were sent the IDENTICAL `effectiveEffort`, grouped rather than reported pair by
 * pair — three colliding arms get one line naming all three, not three lines repeating the same
 * effort. See `ArmResult.effectiveEffort`: the mapping is lossy (claude has no `minimal`), and a
 * reader who does not know that will read two different timings as evidence of a distinction the
 * harness never actually sent.
 */
function renderEffortCollisions(arms: readonly ArmResult[]): string[] {
  const byEffort = new Map<string, string[]>();
  for (const result of arms) {
    const ids = byEffort.get(result.effectiveEffort) ?? [];
    ids.push(result.arm.id);
    byEffort.set(result.effectiveEffort, ids);
  }
  const lines: string[] = [];
  for (const [effort, ids] of byEffort) {
    if (ids.length < 2) continue;
    lines.push(
      `${ids.join(', ')}: the harness sent the identical effort ${JSON.stringify(effort)} to each ` +
        'of these arms, so any difference between them is run-to-run variance, not a measured ' +
        'effect of effort.',
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------------------------

export function renderTrialResult(result: TrialResult): string {
  const lines: string[] = [];
  const armCount = result.arms.length;
  lines.push(`${result.title}  —  ${result.mode}  —  ${String(armCount)} arm${armCount === 1 ? '' : 's'}`);
  lines.push('');

  if (result.vacuous.length > 0) {
    lines.push('REFUSED — this trial would have measured nothing');
    lines.push('');
    for (const id of result.vacuous) lines.push(`  - ${id}`);
    lines.push('');
    lines.push(
      'These job checks already pass on the untouched seed: the work was done before a single ' +
        'arm ran, so the trial would have scored every arm full marks without measuring anything. ' +
        'The seed or the checks need to change before this trial can run.',
    );
    return `${lines.join('\n')}\n`;
  }

  lines.push(...renderTable(result.arms));
  lines.push('');

  const failureLines = result.arms.flatMap(renderFailures);
  if (failureLines.length > 0) {
    lines.push(...failureLines);
    lines.push('');
  }

  const notOk = result.arms.filter((r) => r.status !== 'ok');
  if (notOk.length > 0) {
    for (const r of notOk) lines.push(`${r.arm.id}: status ${r.status}`);
    lines.push('');
  }

  if (result.mode === 'concurrent') {
    lines.push(
      'concurrent mode: every arm shared a machine and an upstream at the same moment, so the ' +
        'wall column compares these arms against each other honestly but must not be compared ' +
        'against numbers from a serial run.',
    );
  }

  const collisionLines = renderEffortCollisions(result.arms);
  if (collisionLines.length > 0) {
    if (result.mode === 'concurrent') lines.push('');
    lines.push(...collisionLines);
  }

  return `${lines.join('\n')}\n`;
}

/** `JSON.stringify(result, null, 2)` plus a trailing newline. Nothing clever. */
export function renderTrialJson(result: TrialResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
