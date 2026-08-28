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
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCommand } from '../src/verify/exec.ts';
import {
  outputLines,
  saysNothingNew,
  renderAcceptanceFailure,
  runAcceptanceGate,
  runVerifyBaseline,
  unrunnableCommands,
} from '../src/verify/gate.ts';
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

  // `&` is POSIX shell syntax — cmd.exe reads it as "then", so this repro means nothing there.
  test(
    'a command that backgrounds a survivor still settles at the timeout, and the survivor dies',
    { skip: process.platform === 'win32' },
    async () => {
      // A unique sleep duration doubles as a pgrep-able marker for the orphan check below.
      const marker = String(3600 + Math.floor(Math.random() * 1000));

      // Race against a wall clock, because the failure mode under test is `runCommand` never
      // settling at all: the backgrounded child inherits the stdio pipes, killing only the shell
      // leaves them open, and 'close' waits on them forever. A test that just awaited would hang
      // with the bug instead of reporting it.
      const deadline = new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          reject(new Error('runCommand did not settle within 4s of a 500ms timeout'));
        }, 4000);
        t.unref();
      });
      const result = await Promise.race([
        runCommand(`sleep ${marker} & sleep ${marker}`, mkTmp('bg'), 500),
        deadline,
      ]);
      assert.equal(result.timedOut, true);
      assert.notEqual(result.exitCode, 0);

      // Settling is not enough — the kill must reach the backgrounded grandchild, or every timed-out
      // verify command leaks a live process into the machine. Brief pause so the kill lands before
      // we look.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const survivors = spawnSync('pgrep', ['-f', `sleep ${marker}`], { encoding: 'utf8' });
      assert.equal(
        survivors.stdout.trim(),
        '',
        `backgrounded process survived the timeout kill: pids ${survivors.stdout.trim()}`,
      );
    },
  );

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
      outcomes: [{ command: 'ok', passed: true, exitCode: 0, timedOut: false, output: '' , unchangedFromBaseline: false }],
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
        { command: 'good-one', passed: true, exitCode: 0, timedOut: false, output: '' , unchangedFromBaseline: false },
        { command: 'bad-one', passed: false, exitCode: 1, timedOut: false, output: 'exploded' , unchangedFromBaseline: false },
        { command: 'timeout-arm', passed: false, exitCode: null, timedOut: true, output: 'hung' , unchangedFromBaseline: false },
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

// ===============================================================================================
// THE BASELINE — telling a broken acceptance command from a failing branch
//
// The incident: a campaign ran three Engineers for 37.6 minutes and $8.86, two of which SUCCEEDED
// with tests passing, and delivered nothing. One of the spec's six verify commands had been
// mangled into `sh -c 'grep -q \"\\\"dependencies\\\": {}\" package.json'`, which exits 2 against
// any file that has ever existed. Nothing could tell that from a failing test, so the retry loop
// spent two more Engineers reaching the same exit code.
//
// The DANGEROUS direction here is false equality — calling a real failure a broken command, and
// telling a human their spec is at fault when their branch is. Most of what follows is that.
// ===============================================================================================

/** A runner that replays scripted results per command, in call order. */
function replayRunner(script: Record<string, Array<{ exitCode: number | null; stdout?: string; stderr?: string; timedOut?: boolean }>>): CommandRunner {
  const calls = new Map<string, number>();
  return (command) => {
    const n = calls.get(command) ?? 0;
    calls.set(command, n + 1);
    const entry = script[command]?.[n] ?? script[command]?.[script[command]!.length - 1];
    if (entry === undefined) throw new Error(`no scripted result for ${command} call ${String(n)}`);
    return Promise.resolve({
      exitCode: entry.exitCode,
      stdout: entry.stdout ?? '',
      stderr: entry.stderr ?? '',
      timedOut: entry.timedOut ?? false,
    });
  };
}

describe('the acceptance baseline', () => {
  const MANGLED = String.raw`sh -c 'grep -q \"\\\"dependencies\\\": {}\" package.json'`;
  const GREP_ERROR = 'grep: {}": No such file or directory\n';

  test('a command that fails identically with and without the work is flagged', async () => {
    // The field case, exactly: same exit code, same message, before and after.
    const run = replayRunner({ [MANGLED]: [{ exitCode: 2, stderr: GREP_ERROR }] });
    const baseline = await runVerifyBaseline({ commands: [MANGLED], cwd: '/w', run });
    const result = await runAcceptanceGate({ commands: [MANGLED], cwd: '/w', run, baseline });

    assert.equal(result.passed, false, 'the gate must still fail — nothing is being relaxed');
    assert.equal(result.outcomes[0]?.unchangedFromBaseline, true);
    assert.deepEqual(unrunnableCommands(result).map((o) => o.command), [MANGLED]);
  });

  test('a REAL test failure is never mistaken for a broken command', async () => {
    // The direction that must not go wrong. `node --test` exits 1 at base because no tests exist
    // and exits 1 afterwards because an assertion failed — identical exit codes, completely
    // different events. A signature built on the exit code alone would call this a spec defect and
    // tell the human their spec is broken when their branch is.
    const run = replayRunner({
      'node --test': [
        { exitCode: 1, stdout: 'tests 0\nfail 0\nno test files found\n' },
        { exitCode: 1, stdout: 'tests 9\nfail 1\nnot ok 3 - crawl finds every heading\n' },
      ],
    });
    const baseline = await runVerifyBaseline({ commands: ['node --test'], cwd: '/w', run });
    const result = await runAcceptanceGate({ commands: ['node --test'], cwd: '/w', run, baseline });

    assert.equal(result.passed, false);
    assert.equal(
      result.outcomes[0]?.unchangedFromBaseline,
      false,
      'a genuine test failure was blamed on the spec',
    );
    assert.deepEqual(unrunnableCommands(result), []);
  });

  test('a command that starts failing and then passes is the healthy case', async () => {
    // `node --test` SHOULD fail before the feature exists. Failing at base is normal and must
    // never, on its own, mean anything at all.
    const run = replayRunner({
      'node --test': [{ exitCode: 1, stdout: 'no test files\n' }, { exitCode: 0, stdout: 'pass 9\n' }],
    });
    const baseline = await runVerifyBaseline({ commands: ['node --test'], cwd: '/w', run });
    assert.equal(baseline[0]?.exitCode, 1, 'the baseline must record the ordinary failure');
    const result = await runAcceptanceGate({ commands: ['node --test'], cwd: '/w', run, baseline });
    assert.equal(result.passed, true);
    assert.equal(result.outcomes[0]?.unchangedFromBaseline, false);
  });

  test('a passing command is never interrogated about its baseline', async () => {
    // A command that passes has plainly distinguished the work from its absence. Asking the
    // question of it would be a way to talk a passing check into looking suspicious.
    const run = replayRunner({ 'true': [{ exitCode: 0 }] });
    const baseline = await runVerifyBaseline({ commands: ['true'], cwd: '/w', run });
    const result = await runAcceptanceGate({ commands: ['true'], cwd: '/w', run, baseline });
    assert.equal(result.outcomes[0]?.unchangedFromBaseline, false);
  });

  test('a shell that cannot execute the command at all is flagged whatever it says later', async () => {
    // 126 is found-but-not-executable, 127 is not-found. Neither is a check result.
    for (const code of [126, 127]) {
      const run = replayRunner({
        'nosuchtool --check': [
          { exitCode: code, stderr: 'nosuchtool: command not found\n' },
          { exitCode: 3, stderr: 'something else entirely\n' },
        ],
      });
      const baseline = await runVerifyBaseline({ commands: ['nosuchtool --check'], cwd: '/w', run });
      const result = await runAcceptanceGate({
        commands: ['nosuchtool --check'],
        cwd: '/w',
        run,
        baseline,
      });
      assert.equal(
        result.outcomes[0]?.unchangedFromBaseline,
        true,
        `exit ${String(code)} at base was not treated as unrunnable`,
      );
    }
  });

  test('no baseline means no claim — absence of evidence is never evidence', async () => {
    // Every caller that predates this passes no baseline, and must keep behaving exactly as it did.
    const run = replayRunner({ 'node --test': [{ exitCode: 1, stderr: 'boom\n' }] });
    const result = await runAcceptanceGate({ commands: ['node --test'], cwd: '/w', run });
    assert.equal(result.outcomes[0]?.unchangedFromBaseline, false);
    assert.deepEqual(unrunnableCommands(result), []);
  });

  test('the comparison is containment, and it leans toward reporting nothing', () => {
    // A broken command says the same thing every time — that is what makes it broken.
    const grep = ['grep: {}": No such file or directory'];
    assert.equal(saysNothingNew(grep, grep), true, 'a repeated identical failure did not match');

    // THE CORRECTION. The baseline runs against a tree where the work does not exist, so a broken
    // command legitimately says MORE at base than afterwards. Byte-equality reported "changed" for
    // the one command this exists to catch, and the end-to-end check caught it.
    const atBase = [
      'grep: {}": No such file or directory',
      'grep: package.json: No such file or directory',
    ];
    assert.equal(
      saysNothingNew(atBase, grep),
      true,
      'a command that lost only its missing-file complaint was called changed',
    );

    // The safe direction: a genuine failure introduces a line the baseline never had.
    assert.equal(
      saysNothingNew(['tests 0', 'fail 0', 'no test files found'], [
        'tests 9',
        'fail 1',
        'not ok 3 - crawl finds every heading',
      ]),
      false,
      'a real assertion failure was blamed on the spec',
    );
    // And containment is one-way: saying MORE than the baseline is always a change.
    assert.equal(saysNothingNew(grep, [...grep, 'not ok 1 - something new']), false);

    // `outputLines` dedupes and trims, so "how many files happened to be there" cannot decide it.
    assert.deepEqual(outputLines('', '  a  \n\n a \nb\n'), ['a', 'b']);
    // stderr wins when both are present — that is where a failing command says what went wrong.
    assert.deepEqual(outputLines('ignored', 'real\n'), ['real']);
    assert.deepEqual(outputLines('used when stderr is blank\n', '   '), ['used when stderr is blank']);
  });

  test('an empty verify list produces no baseline and spawns nothing', async () => {
    let calls = 0;
    const run: CommandRunner = () => {
      calls += 1;
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    };
    assert.deepEqual(await runVerifyBaseline({ commands: [], cwd: '/w', run }), []);
    assert.deepEqual(await runVerifyBaseline({ cwd: '/w', run }), []);
    assert.equal(calls, 0);
  });

  test('a runner that throws at baseline time does not abort the campaign', async () => {
    // The baseline runs before an Engineer exists. A diagnostic that can kill a campaign which
    // has not started yet is worse than no diagnostic.
    const run: CommandRunner = () => Promise.reject(new Error('spawn EACCES'));
    const baseline = await runVerifyBaseline({ commands: ['node --test'], cwd: '/w', run });
    assert.equal(baseline.length, 1);
    assert.match((baseline[0]?.lines ?? []).join(' '), /EACCES/u);
  });
});

// ===============================================================================================
// THE FIELD CASE, THROUGH A REAL SHELL
//
// This suite's rule is that gate tests never spawn — a gate test that shells out is testing the
// operating system. This one is the exception, deliberately: what makes the field command
// unrunnable IS a fact about the shell. `sh -c 'grep -q \"\\\"dependencies\\\": {}\" package.json'`
// has balanced quotes, contains no denied word, passes every static check the spec validator
// applies, and still exits 2 against every file that has ever existed. A fake runner asserting
// that would just be asserting the fixture I wrote.
// ===============================================================================================


describe('the mangled verify command, run for real', () => {
  const MANGLED = String.raw`sh -c 'grep -q \"\\\"dependencies\\\": {}\" package.json'`;
  const CLEAN = String.raw`sh -c 'grep -q "\"dependencies\": {}" package.json'`;
  // Stands in for the spec's test command. NOT `node --test`: this suite is itself running under
  // `node --test`, and a spawned `node --test` inherits NODE_TEST_CONTEXT from it, reports into
  // the parent's stream and stops exiting non-zero — so the inner failure silently looks like a
  // pass. `test/doctor.test.ts` scrubs the same variable when it spawns. The behaviour under test
  // here is the shell's, and this exercises it without the trap.
  const CHECK = 'node check.js';
  const COMMANDS = [MANGLED, CLEAN, CHECK];

  const PASSING = 'process.exit(0);\n';
  const FAILING = "console.error('crawl finds every heading: expected 4 got 3');\nprocess.exit(1);\n";

  function baseTree(label: string): string {
    // No package.json and no check.js: the tree exactly as an Engineer receives it.
    return mkTmp(label);
  }
  function doTheWork(dir: string, check: string): void {
    fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "dependencies": {},\n  "name": "x"\n}\n');
    fs.writeFileSync(path.join(dir, 'check.js'), check);
  }

  test('is caught, while the clean equivalent and the check both pass', async () => {
    const dir = baseTree('field-good');
    const baseline = await runVerifyBaseline({ commands: COMMANDS, cwd: dir, timeoutMs: 60_000 });
    // Both grep spellings fail at base, and so does the check — all three are ordinary and
    // expected, which is the whole reason failing-at-base can never mean anything on its own.
    assert.equal(baseline.every((b) => b.exitCode !== 0), true, 'the base tree should fail everything');

    doTheWork(dir, PASSING);
    const result = await runAcceptanceGate({ commands: COMMANDS, cwd: dir, timeoutMs: 60_000, baseline });
    const byCommand = new Map(result.outcomes.map((o) => [o.command, o]));

    assert.equal(byCommand.get(CLEAN)?.passed, true, 'the correctly-escaped command must pass');
    assert.equal(byCommand.get(CHECK)?.passed, true, 'the check must pass');
    assert.equal(byCommand.get(MANGLED)?.passed, false, 'the mangled command cannot pass, ever');
    assert.equal(
      byCommand.get(MANGLED)?.unchangedFromBaseline,
      true,
      'the command that cost three attempts and $8.86 was not detected',
    );
    // Nothing is relaxed. The gate still refuses — what changed is only who is told to fix it.
    assert.equal(result.passed, false, 'the gate must still fail closed');
    assert.deepEqual(unrunnableCommands(result).map((o) => o.command), [MANGLED]);
  });

  test('and a genuinely failing check beside it is still blamed on the branch', async () => {
    // The direction that must never go wrong: with the spec defect present AND a real failure,
    // the real failure must not be swept into "your spec is broken".
    const dir = baseTree('field-bad');
    const baseline = await runVerifyBaseline({ commands: COMMANDS, cwd: dir, timeoutMs: 60_000 });
    doTheWork(dir, FAILING);
    const result = await runAcceptanceGate({ commands: COMMANDS, cwd: dir, timeoutMs: 60_000, baseline });
    const byCommand = new Map(result.outcomes.map((o) => [o.command, o]));

    assert.equal(byCommand.get(CHECK)?.passed, false, 'the failing check must fail');
    assert.equal(
      byCommand.get(CHECK)?.unchangedFromBaseline,
      false,
      'a real failure was reported as an unrunnable command',
    );
    assert.deepEqual(unrunnableCommands(result).map((o) => o.command), [MANGLED]);
  });
});
