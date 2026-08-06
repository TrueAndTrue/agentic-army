/**
 * Tests for `src/verify/exec.ts` and `src/verify/gate.ts` — the single process runner and the
 * acceptance gate built on it.
 *
 * `runCommand` tests spawn real, tiny processes (`node -e '...'`) because the whole point of the
 * module is what actually happens to a spawned child; `runAcceptanceGate` tests never spawn —
 * they drive an injected `CommandRunner` fake, because a gate test that shells out is testing the
 * operating system, not the sequencing and truncation logic this file owns.
 *
 * Every directory used here is minted under `os.tmpdir()` and removed in `after()`. Nothing calls
 * `armyHome()` or otherwise resolves `~/.agentic-army` — this suite must never touch it.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCommand } from '../src/verify/exec.ts';
import { renderAcceptanceFailure, runAcceptanceGate } from '../src/verify/gate.ts';
import type { CommandRunner } from '../src/contracts/verify.ts';
import type { AcceptanceResult } from '../src/contracts/verify.ts';

// ===============================================================================================
// Scaffolding
// ===============================================================================================

const TMP_ROOTS: string[] = [];

function mkTmp(label: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `verify-${label}-`));
  TMP_ROOTS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ===============================================================================================
// runCommand
// ===============================================================================================

describe('runCommand', () => {
  test('exit 0 is captured, with stdout', async () => {
    const result = await runCommand('node -e "console.log(\'hi\')"', mkTmp('exit0'), 5000);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout.trim(), 'hi');
  });

  test('a non-zero exit is captured', async () => {
    const result = await runCommand('node -e "process.exit(7)"', mkTmp('exit7'), 5000);
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
  });

  test('stderr is captured separately from stdout', async () => {
    const result = await runCommand(
      'node -e "console.log(\'out-line\'); console.error(\'err-line\')"',
      mkTmp('streams'),
      5000,
    );
    assert.equal(result.stdout.trim(), 'out-line');
    assert.equal(result.stderr.trim(), 'err-line');
  });

  test('a command that outlives its timeout is killed and reported as timedOut', async () => {
    const result = await runCommand(
      'node -e "setTimeout(() => {}, 60000)"',
      mkTmp('timeout'),
      300,
    );
    assert.equal(result.timedOut, true);
  });

  test('cwd is honoured', async () => {
    const dir = mkTmp('cwd');
    const real = fs.realpathSync(dir);
    const result = await runCommand('node -e "console.log(process.cwd())"', dir, 5000);
    assert.equal(result.stdout.trim(), real);
  });
});

// ===============================================================================================
// runAcceptanceGate
// ===============================================================================================

/** A `CommandRunner` fake that counts calls and answers from a script, keyed by call index. */
function scriptedRunner(
  answers: ReadonlyArray<
    | { exitCode: number | null; stdout?: string; stderr?: string; timedOut?: boolean }
    | { reject: string }
  >,
): { run: CommandRunner; calls: () => number } {
  let count = 0;
  const run: CommandRunner = async (command, cwd, timeoutMs) => {
    const i = count;
    count += 1;
    const answer = answers[i];
    if (answer === undefined) throw new Error(`scriptedRunner: no answer for call ${String(i)}`);
    if ('reject' in answer) throw new Error(answer.reject);
    return {
      exitCode: answer.exitCode,
      stdout: answer.stdout ?? '',
      stderr: answer.stderr ?? '',
      timedOut: answer.timedOut ?? false,
    };
  };
  return { run, calls: () => count };
}

describe('runAcceptanceGate', () => {
  test('no commands: ran false, passed false, no outcomes, runner never called', async () => {
    const { run, calls } = scriptedRunner([]);
    const result = await runAcceptanceGate({ cwd: mkTmp('none'), run });
    assert.deepEqual(result, { ran: false, passed: false, outcomes: [] });
    assert.equal(calls(), 0);
  });

  test('empty array: same as absent', async () => {
    const { run, calls } = scriptedRunner([]);
    const result = await runAcceptanceGate({ cwd: mkTmp('empty'), commands: [], run });
    assert.deepEqual(result, { ran: false, passed: false, outcomes: [] });
    assert.equal(calls(), 0);
  });

  test('all pass: ran true, passed true, one outcome per command, in order', async () => {
    const { run } = scriptedRunner([
      { exitCode: 0, stdout: 'a-out' },
      { exitCode: 0, stdout: 'b-out' },
    ]);
    const result = await runAcceptanceGate({
      cwd: mkTmp('allpass'),
      commands: ['cmd-a', 'cmd-b'],
      run,
    });
    assert.equal(result.ran, true);
    assert.equal(result.passed, true);
    assert.equal(result.outcomes.length, 2);
    assert.equal(result.outcomes[0]?.command, 'cmd-a');
    assert.equal(result.outcomes[1]?.command, 'cmd-b');
    assert.ok(result.outcomes.every((o) => o.passed));
  });

  test('the second of three fails: all three still run, gate fails', async () => {
    const { run, calls } = scriptedRunner([
      { exitCode: 0 },
      { exitCode: 1, stderr: 'boom' },
      { exitCode: 0 },
    ]);
    const result = await runAcceptanceGate({
      cwd: mkTmp('midfail'),
      commands: ['first', 'second', 'third'],
      run,
    });
    assert.equal(calls(), 3);
    assert.equal(result.passed, false);
    assert.equal(result.ran, true);
    assert.equal(result.outcomes[0]?.passed, true);
    assert.equal(result.outcomes[1]?.passed, false);
    assert.equal(result.outcomes[2]?.passed, true);
  });

  test('a timing-out command fails the gate', async () => {
    const { run } = scriptedRunner([{ exitCode: 0, timedOut: true }]);
    const result = await runAcceptanceGate({ cwd: mkTmp('timeout'), commands: ['slow'], run });
    assert.equal(result.passed, false);
    assert.equal(result.outcomes[0]?.timedOut, true);
    assert.equal(result.outcomes[0]?.passed, false);
  });

  test('an injected runner that rejects produces a failed outcome carrying the message, and does not reject', async () => {
    const { run } = scriptedRunner([{ reject: 'spawn EACCES' }]);
    const result = await runAcceptanceGate({ cwd: mkTmp('reject'), commands: ['boom'], run });
    assert.equal(result.ran, true);
    assert.equal(result.passed, false);
    assert.equal(result.outcomes[0]?.passed, false);
    assert.equal(result.outcomes[0]?.exitCode, null);
    assert.match(result.outcomes[0]?.output ?? '', /spawn EACCES/);
  });

  test('output tail: an 8000-character stderr is truncated to 2000 and keeps the END', async () => {
    // 6000 'x's, then a 2000-char tail made of 'y's ending in a marker — so the LAST 2000
    // characters contain no 'x' at all if (and only if) the truncation kept the end.
    const long = 'x'.repeat(6000) + 'y'.repeat(1986) + 'THE-END-MARKER';
    assert.equal(long.length, 8000);
    const { run } = scriptedRunner([{ exitCode: 1, stderr: long }]);
    const result = await runAcceptanceGate({ cwd: mkTmp('tail'), commands: ['loud'], run });
    const output = result.outcomes[0]?.output ?? '';
    assert.equal(output.length, 2001); // capped content + leading ellipsis
    assert.ok(output.startsWith('…'));
    assert.ok(output.endsWith('THE-END-MARKER'));
    assert.ok(!output.includes('x'));
  });

  test('stderr is preferred over stdout when both are non-empty', async () => {
    const { run } = scriptedRunner([{ exitCode: 1, stdout: 'stdout-text', stderr: 'stderr-text' }]);
    const result = await runAcceptanceGate({ cwd: mkTmp('prefer'), commands: ['both'], run });
    assert.equal(result.outcomes[0]?.output, 'stderr-text');
  });

  test('stdout is used when stderr is blank', async () => {
    const { run } = scriptedRunner([{ exitCode: 1, stdout: 'stdout-only', stderr: '   ' }]);
    const result = await runAcceptanceGate({ cwd: mkTmp('stdout-only'), commands: ['one'], run });
    assert.equal(result.outcomes[0]?.output, 'stdout-only');
  });
});

// ===============================================================================================
// renderAcceptanceFailure
// ===============================================================================================

describe('renderAcceptanceFailure', () => {
  test('returns empty string for a passed gate', () => {
    const result: AcceptanceResult = {
      ran: true,
      passed: true,
      outcomes: [{ command: 'ok', passed: true, exitCode: 0, timedOut: false, output: '' }],
    };
    assert.equal(renderAcceptanceFailure(result), '');
  });

  test('returns empty string when the gate did not run', () => {
    const result: AcceptanceResult = { ran: false, passed: false, outcomes: [] };
    assert.equal(renderAcceptanceFailure(result), '');
  });

  test('names every failed command, not the passing ones, and renders null exit as killed', () => {
    // The command name is deliberately NOT "killed" or similar — a substring assertion on the
    // rendered output must be checking the actual exit-code line, not getting a free pass from
    // the command's own name.
    const result: AcceptanceResult = {
      ran: true,
      passed: false,
      outcomes: [
        { command: 'good-one', passed: true, exitCode: 0, timedOut: false, output: '' },
        { command: 'bad-one', passed: false, exitCode: 1, timedOut: false, output: 'exploded' },
        { command: 'timeout-arm', passed: false, exitCode: null, timedOut: true, output: 'hung' },
      ],
    };
    const rendered = renderAcceptanceFailure(result);
    assert.ok(rendered.includes('`bad-one`'));
    assert.ok(rendered.includes('exploded'));
    assert.ok(rendered.includes('`timeout-arm`'));
    assert.ok(rendered.includes('hung'));
    assert.ok(rendered.includes('exit code: killed'));
    // The passing command is named once, in the summary line, and not given a full section.
    assert.ok(rendered.includes('good-one'));
    assert.ok(!rendered.includes('### `good-one`'));
  });
});
