/**
 * Tests for `src/trial/checks.ts` — the scoring layer for `army trial`.
 *
 * Every check type carries a passing case AND a failing one: a check that has never been seen to
 * go red is not a check, it is decoration. The `command` cases never spawn a real process — they
 * drive a fake `CheckExec` — because a suite that shells out to prove an exit-code comparison is
 * testing the operating system, not this module.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { evaluateCheck, evaluateChecks, matchGlob, vacuousJobChecks } from '../src/trial/checks.ts';
import type {
  ArmEvidence,
  Check,
  CheckExec,
  CheckResult,
  CommandCheck,
  CommittedCheck,
  FileContentCheck,
  FilesChangedCheck,
  NoToolUseCheck,
} from '../src/contracts/trial.ts';
import { DEFAULT_CHECK_TIMEOUT_MS } from '../src/contracts/trial.ts';
import type { SoldierEvent } from '../src/contracts/harness.ts';

/** A baseline `ArmEvidence`, overridden per test. Nothing here touches the real filesystem. */
function evidence(overrides: Partial<ArmEvidence> = {}): ArmEvidence {
  return {
    workspace: '/does/not/exist',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    changedFiles: [],
    dirty: false,
    events: [],
    ...overrides,
  };
}

/** A `tool_use` `SoldierEvent`, with the fields a check actually reads defaulted sanely. */
function toolUseEvent(overrides: {
  name?: string;
  input?: unknown;
  depth?: number;
  parentToolUseId?: string | null;
}): SoldierEvent {
  return {
    ts: '2026-08-04T00:00:00.000Z',
    raw: {},
    parentToolUseId: overrides.parentToolUseId ?? null,
    depth: overrides.depth ?? 0,
    type: 'tool_use',
    name: overrides.name ?? 'Bash',
    toolUseId: randomUUID(),
    input: overrides.input,
  };
}

/** Fails loudly if called — for check types that must never touch the process runner. */
const dummyExec: CheckExec = async () => {
  throw new Error('exec must not be called for this check type');
};

// ===============================================================================================
// matchGlob
// ===============================================================================================

describe('matchGlob', () => {
  const cases: ReadonlyArray<[string, string, boolean]> = [
    ['src/a.ts', 'src/*.ts', true],
    ['src/x/a.ts', 'src/*.ts', false],
    ['src/x/a.ts', 'src/**', true],
    ['a.ts', '**/*.ts', true],
    ['x/a.ts', '**/*.ts', true],
    // The regex-escape regression: a bare `.` in the pattern must stay a literal dot.
    ['pkgXjson', 'pkg.json', false],
    ['pkg.json', 'pkg.json', true],
    ['a.ts', '?.ts', true],
    ['ab.ts', '?.ts', false],
    ['src/a.ts', 'test/*.ts', false],
  ];

  for (const [candidate, pattern, expected] of cases) {
    test(`${candidate} vs ${pattern} -> ${expected}`, () => {
      assert.equal(matchGlob(candidate, pattern), expected);
    });
  }

  test('comparison is case-sensitive', () => {
    assert.equal(matchGlob('README.md', 'readme.md'), false);
  });
});

// ===============================================================================================
// command
// ===============================================================================================

describe('evaluateCheck / command', () => {
  const check: CommandCheck = { id: 'build', kind: 'job', type: 'command', run: 'npm run build' };

  test('passes when the exit code matches the (default) expectation', async () => {
    const exec: CheckExec = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    const r = await evaluateCheck(check, evidence(), exec);
    assert.deepEqual(r, { id: 'build', kind: 'job', type: 'command', passed: true, detail: '' });
  });

  test('a non-default expectExit is honoured', async () => {
    const c: CommandCheck = { ...check, expectExit: 3 };
    const exec: CheckExec = async () => ({ exitCode: 3, stdout: '', stderr: '', timedOut: false });
    const r = await evaluateCheck(c, evidence(), exec);
    assert.equal(r.passed, true);
  });

  test('fails on a mismatched exit code, naming expected, actual and the stderr tail', async () => {
    const exec: CheckExec = async () => ({
      exitCode: 1,
      stdout: 'irrelevant stdout',
      stderr: 'a'.repeat(500) + 'THE_TAIL',
      timedOut: false,
    });
    const r = await evaluateCheck(check, evidence(), exec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /expected 0/);
    assert.match(r.detail, /exited 1/);
    assert.ok(r.detail.includes('THE_TAIL'), 'must carry the tail of stderr');
    assert.equal(r.detail.includes('irrelevant stdout'), false, 'stderr must win over stdout when present');
    assert.ok(r.detail.length < 600, 'the tail must be capped, not the whole 500+ char buffer');
  });

  test('a null exit code renders as the word null, not a stringified object', async () => {
    const exec: CheckExec = async () => ({ exitCode: null, stdout: 'out', stderr: '', timedOut: false });
    const r = await evaluateCheck(check, evidence(), exec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /exited null/);
  });

  test('falls back to the stdout tail when stderr is empty', async () => {
    const exec: CheckExec = async () => ({
      exitCode: 1,
      stdout: 'from stdout',
      stderr: '',
      timedOut: false,
    });
    const r = await evaluateCheck(check, evidence(), exec);
    assert.ok(r.detail.includes('from stdout'));
  });

  test('collapses newlines in the tail so the detail stays one line', async () => {
    const exec: CheckExec = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'line1\nline2\nline3',
      timedOut: false,
    });
    const r = await evaluateCheck(check, evidence(), exec);
    assert.equal(r.detail.includes('\n'), false);
    assert.ok(r.detail.includes('line1 / line2 / line3'));
  });

  test('a timeout fails without comparing exit codes, and names the default ceiling', async () => {
    const exec: CheckExec = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: true });
    const r = await evaluateCheck(check, evidence(), exec);
    assert.equal(r.passed, false);
    assert.equal(r.detail, `\`npm run build\` timed out after ${DEFAULT_CHECK_TIMEOUT_MS}ms`);
  });

  test('a custom timeoutMs is forwarded to exec and reflected in the timeout detail', async () => {
    const c: CommandCheck = { ...check, timeoutMs: 50 };
    let seenMs = -1;
    const exec: CheckExec = async (_run, _cwd, ms) => {
      seenMs = ms;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: true };
    };
    const r = await evaluateCheck(c, evidence(), exec);
    assert.equal(seenMs, 50);
    assert.match(r.detail, /50ms/);
  });

  test('the workspace and command are forwarded to exec verbatim', async () => {
    let seenRun = '';
    let seenCwd = '';
    const exec: CheckExec = async (run, cwd) => {
      seenRun = run;
      seenCwd = cwd;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    await evaluateCheck(check, evidence({ workspace: '/arms/xhigh' }), exec);
    assert.equal(seenRun, 'npm run build');
    assert.equal(seenCwd, '/arms/xhigh');
  });

  test('a rejecting exec is caught and turned into a failed check, not a thrown error', async () => {
    const exec: CheckExec = async () => {
      throw new Error('spawn ENOENT');
    };
    const r = await evaluateCheck(check, evidence(), exec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /spawn ENOENT/);
  });
});

// ===============================================================================================
// files-changed
// ===============================================================================================

describe('evaluateCheck / files-changed', () => {
  test('allow: [] fails when a file changed', async () => {
    const check: FilesChangedCheck = { id: 'no-touch', kind: 'compliance', type: 'files-changed', allow: [] };
    const r = await evaluateCheck(check, evidence({ changedFiles: ['notes.md'] }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /notes\.md/);
  });

  test('ABSENT allow passes against the exact same evidence', async () => {
    const check: FilesChangedCheck = { id: 'no-constraint', kind: 'compliance', type: 'files-changed' };
    const r = await evaluateCheck(check, evidence({ changedFiles: ['notes.md'] }), dummyExec);
    assert.equal(r.passed, true);
    assert.equal(r.detail, '');
  });

  test('a non-empty allow passes when every changed file matches a pattern', async () => {
    const check: FilesChangedCheck = { id: 'src-only', kind: 'compliance', type: 'files-changed', allow: ['src/**'] };
    const r = await evaluateCheck(check, evidence({ changedFiles: ['src/a.ts', 'src/b/c.ts'] }), dummyExec);
    assert.equal(r.passed, true);
  });

  test('a non-empty allow fails and lists violators, capped at 8 with a +N more suffix', async () => {
    const files = Array.from({ length: 10 }, (_, i) => `bad-${i}.txt`);
    const check: FilesChangedCheck = { id: 'src-only', kind: 'compliance', type: 'files-changed', allow: ['src/**'] };
    const r = await evaluateCheck(check, evidence({ changedFiles: files }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /changed 10 file\(s\) outside the whitelist/);
    assert.match(r.detail, /\(\+2 more\)/);
  });

  test('require passes when every required pattern was matched', async () => {
    const check: FilesChangedCheck = { id: 'must-log', kind: 'compliance', type: 'files-changed', require: ['CHANGELOG.md'] };
    const r = await evaluateCheck(check, evidence({ changedFiles: ['CHANGELOG.md'] }), dummyExec);
    assert.equal(r.passed, true);
  });

  test('require fails and names the pattern that never matched', async () => {
    const check: FilesChangedCheck = { id: 'must-test', kind: 'compliance', type: 'files-changed', require: ['test/**'] };
    const r = await evaluateCheck(check, evidence({ changedFiles: ['CHANGELOG.md'] }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /required path\(s\) never changed: test\/\*\*/);
  });

  test('allow and require failing together are joined with "; "', async () => {
    const check: FilesChangedCheck = {
      id: 'both',
      kind: 'compliance',
      type: 'files-changed',
      allow: ['src/**'],
      require: ['test/**'],
    };
    const r = await evaluateCheck(check, evidence({ changedFiles: ['bad.txt'] }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /outside the whitelist/);
    assert.match(r.detail, /never changed/);
    assert.ok(r.detail.includes('; '));
  });

  test('never calls exec', async () => {
    const check: FilesChangedCheck = { id: 'x', kind: 'compliance', type: 'files-changed', allow: [] };
    await assert.doesNotReject(evaluateCheck(check, evidence({ changedFiles: [] }), dummyExec));
  });
});

// ===============================================================================================
// file-content
// ===============================================================================================

describe('evaluateCheck / file-content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `army-trial-checks-${randomUUID()}-`));
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello world\nsecond line\n');

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('contains passes when the file exists and holds the substring', async () => {
    const check: FileContentCheck = { id: 'has-hello', kind: 'compliance', type: 'file-content', path: 'README.md', contains: 'hello world' };
    const r = await evaluateCheck(check, evidence({ workspace: dir }), dummyExec);
    assert.deepEqual(r, { id: 'has-hello', kind: 'compliance', type: 'file-content', passed: true, detail: '' });
  });

  test('contains fails when the file exists but lacks the substring', async () => {
    const check: FileContentCheck = { id: 'has-goodbye', kind: 'compliance', type: 'file-content', path: 'README.md', contains: 'goodbye' };
    const r = await evaluateCheck(check, evidence({ workspace: dir }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /does not contain/);
  });

  test('contains fails when the file does not exist', async () => {
    const check: FileContentCheck = { id: 'missing', kind: 'compliance', type: 'file-content', path: 'nope.md', contains: 'x' };
    const r = await evaluateCheck(check, evidence({ workspace: dir }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /nope\.md does not exist/);
  });

  test('absent passes when the file does not exist', async () => {
    const check: FileContentCheck = { id: 'must-not-exist', kind: 'compliance', type: 'file-content', path: 'gone.md', absent: true };
    const r = await evaluateCheck(check, evidence({ workspace: dir }), dummyExec);
    assert.equal(r.passed, true);
  });

  test('absent fails when the file exists, naming its size', async () => {
    const check: FileContentCheck = { id: 'must-not-exist2', kind: 'compliance', type: 'file-content', path: 'README.md', absent: true };
    const r = await evaluateCheck(check, evidence({ workspace: dir }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /exists \(\d+ bytes\)/);
  });

  test('neither contains nor absent is a malformed check, not a silent pass', async () => {
    const check: FileContentCheck = { id: 'bad', kind: 'compliance', type: 'file-content', path: 'README.md' };
    const r = await evaluateCheck(check, evidence({ workspace: dir }), dummyExec);
    assert.equal(r.passed, false);
    assert.equal(r.detail, 'malformed check: needs `contains` or `absent: true`');
  });

  test('absent: false with no contains is ALSO malformed, not a silent pass', async () => {
    const check: FileContentCheck = { id: 'bad2', kind: 'compliance', type: 'file-content', path: 'README.md', absent: false };
    const r = await evaluateCheck(check, evidence({ workspace: dir }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /malformed check/);
  });

  test('the workspace-escape guard fails for a path that walks out via ../../', async () => {
    const check: FileContentCheck = { id: 'escape', kind: 'compliance', type: 'file-content', path: '../../etc/hosts', contains: 'x' };
    const r = await evaluateCheck(check, evidence({ workspace: dir }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /path escapes the workspace: \.\.\/\.\.\/etc\/hosts/);
  });
});

// ===============================================================================================
// no-tool-use
// ===============================================================================================

describe('evaluateCheck / no-tool-use', () => {
  test('passes when the tool never appears in the event stream', async () => {
    const check: NoToolUseCheck = { id: 'no-webfetch', kind: 'compliance', type: 'no-tool-use', tool: 'WebFetch' };
    const r = await evaluateCheck(check, evidence({ events: [toolUseEvent({ name: 'Bash' })] }), dummyExec);
    assert.equal(r.passed, true);
    assert.equal(r.detail, '');
  });

  test('fails when the tool ran, naming the count and the first offending input', async () => {
    const check: NoToolUseCheck = { id: 'no-webfetch', kind: 'compliance', type: 'no-tool-use', tool: 'WebFetch' };
    const ev = evidence({ events: [toolUseEvent({ name: 'WebFetch', input: { url: 'https://x' } })] });
    const r = await evaluateCheck(check, ev, dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /^WebFetch ran 1 time\(s\): /);
    assert.ok(r.detail.includes('https://x'));
  });

  test('matching is a case-insensitive substring test against the serialised input', async () => {
    const check: NoToolUseCheck = { id: 'no-push', kind: 'compliance', type: 'no-tool-use', tool: 'Bash', matching: 'GIT PUSH' };
    const missed = evidence({ events: [toolUseEvent({ name: 'Bash', input: { command: 'git status' } })] });
    const hit = evidence({ events: [toolUseEvent({ name: 'Bash', input: { command: 'git push origin main' } })] });
    assert.equal((await evaluateCheck(check, missed, dummyExec)).passed, true);
    const r = await evaluateCheck(check, hit, dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /matching "GIT PUSH"/);
  });

  test('a violation at depth 2 with a non-null parentToolUseId is still caught', async () => {
    const check: NoToolUseCheck = { id: 'no-bash-deep', kind: 'compliance', type: 'no-tool-use', tool: 'Bash' };
    const ev = evidence({
      events: [
        toolUseEvent({ name: 'Bash', depth: 2, parentToolUseId: 'toolu_parent', input: { command: 'rm -rf /' } }),
      ],
    });
    const r = await evaluateCheck(check, ev, dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /^Bash ran 1 time\(s\)/);
  });

  test('non tool_use events never count as a violation', async () => {
    const check: NoToolUseCheck = { id: 'no-bash', kind: 'compliance', type: 'no-tool-use', tool: 'Bash' };
    const readyEvent: SoldierEvent = {
      ts: '2026-08-04T00:00:00.000Z',
      raw: {},
      parentToolUseId: null,
      depth: 0,
      type: 'ready',
      sessionId: randomUUID(),
      capabilities: [],
    };
    const r = await evaluateCheck(check, evidence({ events: [readyEvent] }), dummyExec);
    assert.equal(r.passed, true);
  });
});

// ===============================================================================================
// committed
// ===============================================================================================

describe('evaluateCheck / committed', () => {
  test('passes with defaults when HEAD moved and the tree is clean', async () => {
    const check: CommittedCheck = { id: 'committed', kind: 'compliance', type: 'committed' };
    const r = await evaluateCheck(check, evidence({ baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), dirty: false }), dummyExec);
    assert.equal(r.passed, true);
  });

  test('fails when HEAD is still the seed commit, naming its short hash', async () => {
    const check: CommittedCheck = { id: 'committed', kind: 'compliance', type: 'committed' };
    const base = 'deadbeef11223344556677889900aabbccddeeff';
    const r = await evaluateCheck(check, evidence({ baseCommit: base, headCommit: base, dirty: false }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /still the seed commit deadbeef — nothing was committed/);
  });

  test('fails when HEAD could not be read', async () => {
    const check: CommittedCheck = { id: 'committed', kind: 'compliance', type: 'committed' };
    const r = await evaluateCheck(check, evidence({ headCommit: null }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /HEAD could not be read/);
  });

  test('fails when the tree is dirty', async () => {
    const check: CommittedCheck = { id: 'committed', kind: 'compliance', type: 'committed' };
    const r = await evaluateCheck(check, evidence({ baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), dirty: true }), dummyExec);
    assert.equal(r.passed, false);
    assert.match(r.detail, /uncommitted changes/);
  });

  test('both failures are joined with "; "', async () => {
    const check: CommittedCheck = { id: 'committed', kind: 'compliance', type: 'committed' };
    const base = 'a'.repeat(40);
    const r = await evaluateCheck(check, evidence({ baseCommit: base, headCommit: base, dirty: true }), dummyExec);
    assert.equal(r.passed, false);
    assert.ok(r.detail.includes('; '));
    assert.match(r.detail, /seed commit/);
    assert.match(r.detail, /uncommitted changes/);
  });

  test('requireNewCommit: false skips the HEAD-moved requirement', async () => {
    const check: CommittedCheck = { id: 'committed', kind: 'compliance', type: 'committed', requireNewCommit: false };
    const base = 'a'.repeat(40);
    const r = await evaluateCheck(check, evidence({ baseCommit: base, headCommit: base, dirty: false }), dummyExec);
    assert.equal(r.passed, true);
  });

  test('requireClean: false skips the dirty-tree requirement', async () => {
    const check: CommittedCheck = { id: 'committed', kind: 'compliance', type: 'committed', requireClean: false };
    const r = await evaluateCheck(check, evidence({ baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), dirty: true }), dummyExec);
    assert.equal(r.passed, true);
  });
});

// ===============================================================================================
// unknown check type — reachable at runtime off a parsed file, even though the union is exhaustive
// ===============================================================================================

describe('evaluateCheck / an unrecognised type from a parsed file', () => {
  test('fails loudly, naming the unknown type, rather than throwing or silently passing', async () => {
    const bogus = { id: 'mystery', kind: 'job', type: 'from-the-future' } as unknown as Check;
    const r = await evaluateCheck(bogus, evidence(), dummyExec);
    assert.equal(r.passed, false);
    assert.equal(r.id, 'mystery');
    assert.equal(r.kind, 'job');
    assert.equal(r.detail, 'unknown check type "from-the-future"');
  });
});

// ===============================================================================================
// evaluateChecks — order and sequencing
// ===============================================================================================

describe('evaluateChecks', () => {
  test('returns results in the same order the checks were given', async () => {
    const checks: Check[] = [
      { id: 'a', kind: 'compliance', type: 'files-changed', allow: [] },
      { id: 'b', kind: 'compliance', type: 'committed' },
      { id: 'c', kind: 'compliance', type: 'file-content', path: 'x', absent: true },
    ];
    const ev = evidence({ workspace: os.tmpdir(), changedFiles: [] });
    const results = await evaluateChecks(checks, ev, dummyExec);
    assert.deepEqual(results.map((r) => r.id), ['a', 'b', 'c']);
  });

  test('runs command checks sequentially — a slow first check blocks a fast second one', async () => {
    // If this ran through Promise.all, 'fast' would resolve before 'slow' and land first in
    // `order`. Sequential execution can only ever produce ['slow', 'fast'].
    const order: string[] = [];
    const checks: CommandCheck[] = [
      { id: 'slow', kind: 'job', type: 'command', run: 'slow' },
      { id: 'fast', kind: 'job', type: 'command', run: 'fast' },
    ];
    const exec: CheckExec = async (run) => {
      if (run === 'slow') await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(run);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const results = await evaluateChecks(checks, evidence(), exec);
    assert.deepEqual(order, ['slow', 'fast']);
    assert.deepEqual(results.map((r) => r.passed), [true, true]);
  });
});

// ===============================================================================================
// vacuousJobChecks
// ===============================================================================================

describe('vacuousJobChecks', () => {
  test('reports a passing job check and omits a passing compliance check', () => {
    const results: CheckResult[] = [
      { id: 'builds', kind: 'job', type: 'command', passed: true, detail: '' },
      { id: 'tests-pass', kind: 'job', type: 'command', passed: false, detail: 'x' },
      { id: 'no-secrets', kind: 'compliance', type: 'no-tool-use', passed: true, detail: '' },
    ];
    assert.deepEqual(vacuousJobChecks(results), ['builds']);
  });

  test('returns nothing when no job check passed', () => {
    const results: CheckResult[] = [{ id: 'builds', kind: 'job', type: 'command', passed: false, detail: 'x' }];
    assert.deepEqual(vacuousJobChecks(results), []);
  });

  test('preserves order across multiple passing job checks', () => {
    const results: CheckResult[] = [
      { id: 'z', kind: 'job', type: 'command', passed: true, detail: '' },
      { id: 'a', kind: 'job', type: 'command', passed: true, detail: '' },
    ];
    assert.deepEqual(vacuousJobChecks(results), ['z', 'a']);
  });
});
