/**
 * Tests for `src/trial/workspace.ts` and `src/trial/run.ts` — arm materialisation, evidence
 * collection, and the trial runner that composes them with `runSoldier`.
 *
 * Every test passes an explicit `home` and an explicit `outDir` under `os.tmpdir()`. `armyHome()`
 * throws under the test runner by design (`src/config/paths.ts`) precisely so a test cannot
 * accidentally resolve — and write into — the developer's real `~/.agentic-army`; nothing here
 * ever calls it.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { collectEvidence, inspectSeed, materializeArm } from '../src/trial/workspace.ts';
import { TRIAL_EFFECTIVE_EFFORT, runTrial } from '../src/trial/run.ts';
import type { Check, TrialArm, TrialSpec } from '../src/contracts/trial.ts';
import { REASONING_EFFORTS } from '../src/contracts/harness.ts';
import type {
  CloseResult,
  HarnessAdapter,
  Soldier,
  SoldierEvent,
  SoldierSpec,
} from '../src/contracts/harness.ts';
import { buildSoldierSpec } from '../src/command/campaign.ts';
import { buildClaudeArgs } from '../src/harness/claude.ts';

// ===============================================================================================
// Scaffolding
// ===============================================================================================

const TMP_ROOTS: string[] = [];

function mkTmp(label: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `trial-run-${label}-`));
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

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Trial Test',
  GIT_AUTHOR_EMAIL: 'test@trial.invalid',
  GIT_COMMITTER_NAME: 'Trial Test',
  GIT_COMMITTER_EMAIL: 'test@trial.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

/** A seed repository with one commit — the only honest starting point for a trial. */
function makeSeed(label = 'seed'): string {
  const dir = mkTmp(label);
  git(dir, 'init', '--quiet', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'base');
  return dir;
}

/** Null when HEAD is detached — `symbolic-ref` exits non-zero there. */
function symbolicHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function headOf(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

// ---------------------------------------------------------------------------------------------
// A scripted Soldier / HarnessAdapter — no real CLI is ever spawned in this file.
// ---------------------------------------------------------------------------------------------

function baseEventFields(): { ts: string; raw: unknown; parentToolUseId: null; depth: 0 } {
  return { ts: new Date().toISOString(), raw: {}, parentToolUseId: null, depth: 0 };
}

/** A couple of tool/text events plus a terminal `result`, the shape `runSoldier` expects. */
function scriptedEvents(): SoldierEvent[] {
  return [
    { ...baseEventFields(), type: 'ready', sessionId: randomUUID(), capabilities: [] },
    { ...baseEventFields(), type: 'assistant_text', text: 'looking around' },
    {
      ...baseEventFields(),
      type: 'tool_use',
      name: 'Bash',
      toolUseId: 'tool-1',
      input: { command: 'echo hi' },
    },
    { ...baseEventFields(), type: 'tool_result', toolUseId: 'tool-1', isError: false, content: 'hi' },
    { ...baseEventFields(), type: 'assistant_text', text: 'done' },
    {
      ...baseEventFields(),
      type: 'result',
      status: 'ok',
      costUsd: 0.02,
      durationMs: 5,
      usage: { inputTokens: 11, outputTokens: 22 },
    },
  ];
}

class ScriptedSoldier implements Soldier {
  readonly id: string;
  readonly spec: SoldierSpec;
  readonly #events: SoldierEvent[];

  constructor(spec: SoldierSpec, events: SoldierEvent[]) {
    this.id = spec.agentId;
    this.spec = spec;
    this.#events = events;
  }

  async send(_text: string): Promise<void> {
    /* scripted — nothing to send anywhere */
  }

  async *stream(): AsyncIterable<SoldierEvent> {
    for (const event of this.#events) yield event;
  }

  async interrupt(): Promise<void> {
    /* not exercised */
  }

  async close(): Promise<CloseResult> {
    return { exitCode: 0, status: 'ok' };
  }
}

interface FakeAdapterHandle {
  adapter: HarnessAdapter;
  spawnCount: number;
}

/**
 * `script` decides per-spec what happens: return events for a scripted run, or throw to simulate
 * a spawn failure for that one arm.
 */
function makeFakeAdapter(script: (spec: SoldierSpec) => SoldierEvent[]): FakeAdapterHandle {
  const handle: FakeAdapterHandle = {
    spawnCount: 0,
    adapter: {
      id: 'claude',
      supportsDuplex: true,
      async spawn(spec: SoldierSpec): Promise<Soldier> {
        handle.spawnCount += 1;
        const events = script(spec);
        return new ScriptedSoldier(spec, events);
      },
    },
  };
  return handle;
}

function arm(overrides: Partial<TrialArm> & { id: string }): TrialArm {
  return {
    effort: 'medium',
    model: 'claude-sonnet-5',
    orders: 'do the thing',
    ordersLabel: 'default brief',
    ...overrides,
  };
}

// ===============================================================================================
// inspectSeed
// ===============================================================================================

describe('inspectSeed', () => {
  test('throws on a directory that is not a git repository', async () => {
    const dir = mkTmp('not-a-repo');
    await assert.rejects(() => inspectSeed(dir), /git rev-parse HEAD.*failed|not.*repository/is);
  });

  test('returns a 40-hex base commit for a real repository', async () => {
    const seed = makeSeed('inspect');
    const info = await inspectSeed(seed);
    assert.equal(info.seed, fs.realpathSync(seed));
    assert.match(info.baseCommit, /^[0-9a-f]{40}$/);
    assert.equal(info.baseCommit, headOf(seed));
  });
});

// ===============================================================================================
// materializeArm
// ===============================================================================================

describe('materializeArm', () => {
  test('produces a detached HEAD at the seed base commit', async () => {
    const seed = makeSeed('materialize-ok');
    const info = await inspectSeed(seed);
    const armDir = path.join(mkTmp('materialize-ok-out'), 'arm-a');

    await materializeArm(info, armDir);

    assert.equal(symbolicHead(armDir), null, 'HEAD must be detached');
    assert.equal(headOf(armDir), info.baseCommit);
  });

  test('throws when the target directory already exists', async () => {
    const seed = makeSeed('materialize-exists');
    const info = await inspectSeed(seed);
    const outDir = mkTmp('materialize-exists-out');
    const armDir = path.join(outDir, 'arm-a');
    fs.mkdirSync(armDir, { recursive: true });

    await assert.rejects(() => materializeArm(info, armDir), /already exists/);
  });
});

// ===============================================================================================
// collectEvidence
// ===============================================================================================

describe('collectEvidence', () => {
  test('reports an untracked file as changed and the tree as dirty', async () => {
    const seed = makeSeed('evidence-untracked');
    const info = await inspectSeed(seed);
    const armDir = path.join(mkTmp('evidence-untracked-out'), 'arm-a');
    await materializeArm(info, armDir);

    fs.writeFileSync(path.join(armDir, 'notes.md'), 'never added\n');

    const evidence = await collectEvidence(armDir, info.baseCommit, []);
    assert.ok(evidence.changedFiles.includes('notes.md'));
    assert.equal(evidence.dirty, true);
    assert.equal(evidence.headCommit, info.baseCommit);
  });

  test('reports a committed file cleanly, with HEAD moved off the base commit', async () => {
    const seed = makeSeed('evidence-committed');
    const info = await inspectSeed(seed);
    const armDir = path.join(mkTmp('evidence-committed-out'), 'arm-a');
    await materializeArm(info, armDir);

    fs.writeFileSync(path.join(armDir, 'new.txt'), 'committed content\n');
    git(armDir, 'add', '-A');
    git(armDir, 'commit', '--quiet', '-m', 'add new.txt');

    const evidence = await collectEvidence(armDir, info.baseCommit, []);
    assert.ok(evidence.changedFiles.includes('new.txt'));
    assert.equal(evidence.dirty, false);
    assert.notEqual(evidence.headCommit, info.baseCommit);
    assert.equal(evidence.headCommit, headOf(armDir));
  });
});

// ===============================================================================================
// runTrial — the vacuity gate
// ===============================================================================================

describe('runTrial — vacuity gate', () => {
  test('a job check that already passes on the untouched seed refuses to spawn a single arm', async () => {
    const seed = makeSeed('vacuous');
    const home = mkTmp('vacuous-home');
    const outDir = mkTmp('vacuous-out');
    const handle = makeFakeAdapter(() => scriptedEvents());

    const checks: Check[] = [
      { id: 'readme-exists', kind: 'job', type: 'file-content', path: 'README.md', contains: '# seed' },
    ];
    const spec: TrialSpec = {
      title: 'vacuous trial',
      seed,
      arms: [arm({ id: 'arm-a' }), arm({ id: 'arm-b' })],
      checks,
      mode: 'concurrent',
      outDir,
    };

    const result = await runTrial({ spec, home, adapter: handle.adapter });

    assert.deepEqual(result.arms, []);
    assert.deepEqual(result.vacuous, ['readme-exists']);
    assert.equal(handle.spawnCount, 0, 'no arm may be spawned when the trial is vacuous');
  });
});

// ===============================================================================================
// runTrial — a full run
// ===============================================================================================

describe('runTrial — arms', () => {
  test('a two-arm run against a fake adapter produces distinct workspaces and finite wall times', async () => {
    const seed = makeSeed('two-arm');
    const home = mkTmp('two-arm-home');
    const outDir = mkTmp('two-arm-out');
    const handle = makeFakeAdapter(() => scriptedEvents());

    const spec: TrialSpec = {
      title: 'two-arm trial',
      seed,
      arms: [arm({ id: 'arm-a', effort: 'low' }), arm({ id: 'arm-b', effort: 'high' })],
      checks: [],
      mode: 'concurrent',
      outDir,
    };

    const progress: string[] = [];
    const result = await runTrial({
      spec,
      home,
      adapter: handle.adapter,
      onProgress: (line) => progress.push(line),
    });

    assert.equal(result.vacuous.length, 0);
    assert.equal(result.arms.length, 2);
    assert.equal(handle.spawnCount, 2);

    const workspaces = result.arms.map((r) => r.workspace);
    assert.notEqual(workspaces[0], workspaces[1]);
    for (const armResult of result.arms) {
      assert.ok(fs.existsSync(armResult.workspace), `${armResult.workspace} should exist`);
      assert.equal(armResult.status, 'ok');
      assert.ok(
        Number.isFinite(armResult.metrics.wallMs) && armResult.metrics.wallMs >= 0,
        'wallMs must be a finite non-negative number',
      );
      assert.equal(armResult.metrics.turns, 2);
      assert.equal(armResult.metrics.toolCalls, 1);
      assert.equal(armResult.metrics.inputTokens, 11);
      assert.equal(armResult.metrics.outputTokens, 22);
    }
    assert.ok(progress.some((line) => line.includes('starting')));
    assert.ok(progress.some((line) => line.includes('finished')));
  });

  test('one arm whose adapter throws on spawn yields spawn-failed without rejecting the trial', async () => {
    const seed = makeSeed('one-fails');
    const home = mkTmp('one-fails-home');
    const outDir = mkTmp('one-fails-out');
    const handle = makeFakeAdapter((spec) => {
      if (spec.agentId === 'bad-arm') throw new Error('simulated spawn failure');
      return scriptedEvents();
    });

    const spec: TrialSpec = {
      title: 'one-fails trial',
      seed,
      arms: [arm({ id: 'good-arm' }), arm({ id: 'bad-arm' })],
      checks: [],
      mode: 'serial',
      outDir,
    };

    const result = await runTrial({ spec, home, adapter: handle.adapter });

    assert.equal(result.arms.length, 2);
    const good = result.arms.find((r) => r.arm.id === 'good-arm');
    const bad = result.arms.find((r) => r.arm.id === 'bad-arm');
    assert.ok(good);
    assert.ok(bad);
    assert.equal(good?.status, 'ok');
    assert.equal(bad?.status, 'spawn-failed');
    assert.ok(bad?.errors.some((message) => message.includes('simulated spawn failure')));
  });
});

// ===============================================================================================
// The --effort drift detector
// ===============================================================================================

test('TRIAL_EFFECTIVE_EFFORT agrees with what the claude adapter actually sends as --effort', () => {
  const home = mkTmp('effort-home');
  for (const effort of REASONING_EFFORTS) {
    const spec = buildSoldierSpec({
      agentId: 'cpt-01',
      rank: 'CAPTAIN',
      role: 'ENGINEER',
      harness: 'claude',
      cwd: '/tmp/does-not-need-to-exist',
      orders: 'x',
      home,
      effort,
    });
    const args = buildClaudeArgs(spec);
    const flagIndex = args.indexOf('--effort');
    assert.notEqual(flagIndex, -1, `--effort missing from argv for ${effort}`);
    assert.equal(
      args[flagIndex + 1],
      TRIAL_EFFECTIVE_EFFORT[effort],
      `TRIAL_EFFECTIVE_EFFORT[${effort}] has drifted from CLAUDE_EFFORT`,
    );
  }
});

