/**
 * Tests for the `army trial` CLI skin: `parseTrialSpec` (src/trial/spec.ts), `renderTrialResult`
 * / `renderTrialJson` (src/trial/report.ts), and `parseTrialArgs` / `trialCommand`
 * (src/command/trial.ts).
 *
 * `runTrial` itself — the orchestration — is exercised in `test/trial-run.test.ts`. Here it is
 * always a fake: `trialCommand` is driven through an injected `runTrial` that resolves instantly,
 * so every exit-code path (passing, a failed check, a vacuous refusal) is testable with no
 * harness spawned and no filesystem beyond a scratch directory this file owns and cleans up.
 *
 * Every home is INJECTED (`deps.home`), never resolved from the ambient environment —
 * `armyHome()` throws under the test runner by design, and this suite never touches
 * `~/.agentic-army`.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseTrialSpec, TRIAL_EFFORTS } from '../src/trial/spec.ts';
import { renderTrialResult } from '../src/trial/report.ts';
import { parseTrialArgs, trialCommand } from '../src/command/trial.ts';
import type { TrialCommandDeps } from '../src/command/trial.ts';
import type {
  ArmMetrics,
  ArmResult,
  CheckResult,
  TrialArm,
  TrialResult,
} from '../src/contracts/trial.ts';

// ===============================================================================================
// Scratch directories — every test file that touches disk owns its own cleanup.
// ===============================================================================================

const SCRATCH_DIRS: string[] = [];
function scratchDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `trial-cli-${label}-`));
  SCRATCH_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of SCRATCH_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes `spec.toml` (and, if given, `seed/`) into a fresh scratch dir; returns its path. */
function writeSpec(label: string, toml: string, opts: { seed?: boolean } = { seed: true }): string {
  const dir = scratchDir(label);
  const specPath = path.join(dir, 'spec.toml');
  fs.writeFileSync(specPath, toml, 'utf8');
  if (opts.seed !== false) fs.mkdirSync(path.join(dir, 'seed'));
  return specPath;
}

// ===============================================================================================
// parseTrialSpec
// ===============================================================================================

describe('parseTrialSpec', () => {
  const WORKED_EXAMPLE = `
title  = "calc bugfix"
seed   = "./seed"
model  = "claude-sonnet-5"
mode   = "concurrent"
efforts = ["minimal","low","medium","high","xhigh"]
orders  = "fix the off-by-one in calc.add and add a regression test"

[[checks]]
id = "tests-pass"
kind = "job"
type = "command"
run = "node --test"
expect_exit = 0

[[checks]]
id = "scope"
kind = "compliance"
type = "files-changed"
allow = ["calc.js"]
require = ["calc.js"]

[[checks]]
id = "no-install"
kind = "compliance"
type = "no-tool-use"
tool = "Bash"
matching = "npm install"

[[checks]]
id = "content"
kind = "compliance"
type = "file-content"
path = "calc.js"
contains = "export"

[[checks]]
id = "committed"
kind = "compliance"
type = "committed"
require_new_commit = true
require_clean = true
`;

  it('parses the full worked example', () => {
    const specPath = writeSpec('worked', WORKED_EXAMPLE);
    const outDir = '/tmp/does-not-matter';
    const { spec, warnings } = parseTrialSpec(WORKED_EXAMPLE, specPath, outDir);

    assert.deepEqual(warnings, []);
    assert.equal(spec.title, 'calc bugfix');
    assert.equal(spec.seed, path.join(path.dirname(specPath), 'seed'));
    assert.equal(spec.mode, 'concurrent');
    assert.equal(spec.outDir, outDir);
    assert.equal(spec.checks.length, 5);
    assert.ok(spec.checks.every((c) => typeof c.id === 'string' && c.id.length > 0));
  });

  it('five default arms in effort order, one per TRIAL_EFFORTS level', () => {
    const toml = `
title = "defaults"
seed = "./seed"
orders = "do the thing"
`;
    const specPath = writeSpec('defaults', toml);
    const { spec } = parseTrialSpec(toml, specPath, '/tmp/out');
    assert.deepEqual(
      spec.arms.map((a) => a.id),
      [...TRIAL_EFFORTS],
    );
    assert.ok(spec.arms.every((a) => a.ordersLabel === 'default'));
    assert.ok(spec.arms.every((a) => a.orders === 'do the thing'));
  });

  it('two briefs give ten arms with <effort>-<label> ids, effort-order then brief-order', () => {
    const dir = scratchDir('two-briefs');
    fs.mkdirSync(path.join(dir, 'seed'));
    fs.writeFileSync(path.join(dir, 'complete.md'), 'the complete brief, in full', 'utf8');
    const toml = `
title = "two briefs"
seed = "./seed"

[[briefs]]
label = "complete"
file  = "./complete.md"
[[briefs]]
label = "thin"
orders = "make the tests pass"
`;
    const specPath = path.join(dir, 'spec.toml');
    fs.writeFileSync(specPath, toml, 'utf8');
    const { spec } = parseTrialSpec(toml, specPath, '/tmp/out');

    assert.equal(spec.arms.length, 10);
    const expectedIds = TRIAL_EFFORTS.flatMap((e) => [`${e}-complete`, `${e}-thin`]);
    assert.deepEqual(
      spec.arms.map((a) => a.id),
      expectedIds,
    );
    const complete = spec.arms.find((a) => a.id === 'high-complete');
    assert.equal(complete?.orders, 'the complete brief, in full');
    const thin = spec.arms.find((a) => a.id === 'high-thin');
    assert.equal(thin?.orders, 'make the tests pass');
  });

  it('converts snake_case fields to camelCase', () => {
    const toml = `
title = "casing"
seed = "./seed"
orders = "do it"

[[checks]]
id = "cmd"
kind = "job"
type = "command"
run = "true"
expect_exit = 7

[[checks]]
id = "committed"
kind = "compliance"
type = "committed"
require_new_commit = true
require_clean = false
`;
    const specPath = writeSpec('casing', toml);
    const { spec } = parseTrialSpec(toml, specPath, '/tmp/out');

    const cmd = spec.checks.find((c) => c.id === 'cmd');
    assert.equal(cmd?.type, 'command');
    assert.equal((cmd as { expectExit?: number }).expectExit, 7);

    const committed = spec.checks.find((c) => c.id === 'committed');
    assert.equal((committed as { requireNewCommit?: boolean }).requireNewCommit, true);
    assert.equal((committed as { requireClean?: boolean }).requireClean, false);
  });

  it('resolves a relative seed against the SPEC FILE\'S directory, not the process cwd', () => {
    const dir = scratchDir('relseed');
    fs.mkdirSync(path.join(dir, 'seed'));
    const toml = `
title = "cwd trap"
seed = "./seed"
orders = "do it"
`;
    const specPath = path.join(dir, 'spec.toml');
    fs.writeFileSync(specPath, toml, 'utf8');

    const decoyCwd = scratchDir('relseed-decoy');
    const originalCwd = process.cwd();
    process.chdir(decoyCwd);
    let spec;
    try {
      ({ spec } = parseTrialSpec(toml, specPath, '/tmp/out'));
    } finally {
      process.chdir(originalCwd);
    }
    assert.equal(spec.seed, path.join(dir, 'seed'));
    assert.notEqual(spec.seed, path.join(decoyCwd, 'seed'));
  });

  it('parses a BOM-prefixed document', () => {
    const toml = `﻿title = "bom"\nseed = "./seed"\norders = "do it"\n`;
    const specPath = writeSpec('bom', toml);
    const { spec } = parseTrialSpec(toml, specPath, '/tmp/out');
    assert.equal(spec.title, 'bom');
  });

  // -----------------------------------------------------------------------------------------
  // Throws, each with the offending thing named in the message.
  // -----------------------------------------------------------------------------------------

  function specFor(body: string, label: string): { text: string; specPath: string } {
    const text = `title = "t"\nseed = "./seed"\n${body}\n`;
    return { text, specPath: writeSpec(label, text) };
  }

  it('throws on an unknown effort, naming it', () => {
    const { text, specPath } = specFor('orders = "x"\nefforts = ["ultra"]', 'bad-effort');
    assert.throws(() => parseTrialSpec(text, specPath, '/tmp/out'), /ultra/);
  });

  it('throws on an unknown check type, naming it', () => {
    const { text, specPath } = specFor(
      'orders = "x"\n[[checks]]\nid = "a"\nkind = "job"\ntype = "telepathy"\n',
      'bad-check-type',
    );
    assert.throws(() => parseTrialSpec(text, specPath, '/tmp/out'), /telepathy/);
  });

  it('throws on an unknown check kind, naming it', () => {
    const { text, specPath } = specFor(
      'orders = "x"\n[[checks]]\nid = "a"\nkind = "vibes"\ntype = "command"\nrun = "true"\n',
      'bad-check-kind',
    );
    assert.throws(() => parseTrialSpec(text, specPath, '/tmp/out'), /vibes/);
  });

  it('throws on a duplicate check id, naming it', () => {
    const { text, specPath } = specFor(
      'orders = "x"\n' +
        '[[checks]]\nid = "dup"\nkind = "job"\ntype = "command"\nrun = "true"\n' +
        '[[checks]]\nid = "dup"\nkind = "compliance"\ntype = "committed"\n',
      'dup-check-id',
    );
    assert.throws(() => parseTrialSpec(text, specPath, '/tmp/out'), /duplicate.*dup|dup.*duplicate/i);
  });

  it('throws on a duplicate arm id (two briefs sharing a label)', () => {
    const { text, specPath } = specFor(
      '[[briefs]]\nlabel = "x"\norders = "one"\n[[briefs]]\nlabel = "x"\norders = "two"\n',
      'dup-arm-id',
    );
    assert.throws(() => parseTrialSpec(text, specPath, '/tmp/out'), /duplicate arm id/);
  });

  it('throws on a brief with both orders and file', () => {
    const dir = scratchDir('both-orders-file');
    fs.mkdirSync(path.join(dir, 'seed'));
    fs.writeFileSync(path.join(dir, 'b.md'), 'text', 'utf8');
    const text =
      'title = "t"\nseed = "./seed"\n[[briefs]]\nlabel = "x"\norders = "one"\nfile = "./b.md"\n';
    const specPath = path.join(dir, 'spec.toml');
    fs.writeFileSync(specPath, text, 'utf8');
    assert.throws(() => parseTrialSpec(text, specPath, '/tmp/out'), /both/);
  });

  it('throws on a brief with neither orders nor file', () => {
    const { text, specPath } = specFor('[[briefs]]\nlabel = "x"\n', 'neither');
    assert.throws(() => parseTrialSpec(text, specPath, '/tmp/out'), /orders.*file|needs/i);
  });

  it('throws on an empty or whitespace-only brief', () => {
    const { text, specPath } = specFor('orders = "   "', 'empty-brief');
    assert.throws(() => parseTrialSpec(text, specPath, '/tmp/out'), /empty/);
  });

  it('throws on a missing seed', () => {
    const text = 'title = "t"\norders = "x"\n';
    const specPath = writeSpec('missing-seed', text);
    assert.throws(() => parseTrialSpec(text, specPath, '/tmp/out'), /seed/);
  });

  it('warns, but still parses, on an unknown key inside a check', () => {
    const { text, specPath } = specFor(
      'orders = "x"\n[[checks]]\nid = "a"\nkind = "job"\ntype = "command"\nrun = "true"\nfrobnicate = 1\n',
      'unknown-check-key',
    );
    const { spec, warnings } = parseTrialSpec(text, specPath, '/tmp/out');
    assert.equal(spec.checks.length, 1);
    assert.ok(warnings.some((w) => w.includes('frobnicate')), JSON.stringify(warnings));
  });

  // ---------------------------------------------------------------------------------------------
  // arm_timeout_ms — the per-arm wall-clock ceiling. Absent means "the adapter's own default";
  // present means real money is riding on the value, so anything short of a positive integer
  // throws rather than being coerced. See the field's doc in src/contracts/trial.ts.
  // ---------------------------------------------------------------------------------------------

  it('parses arm_timeout_ms to armTimeoutMs', () => {
    const { text, specPath } = specFor('orders = "x"\narm_timeout_ms = 600000', 'arm-timeout-ok');
    const { spec } = parseTrialSpec(text, specPath, '/tmp/out');
    assert.equal(spec.armTimeoutMs, 600000);
  });

  it('leaves armTimeoutMs undefined when arm_timeout_ms is absent', () => {
    const { text, specPath } = specFor('orders = "x"', 'arm-timeout-absent');
    const { spec } = parseTrialSpec(text, specPath, '/tmp/out');
    assert.equal(spec.armTimeoutMs, undefined);
  });

  for (const bad of ['0', '-1', '1.5', '"600000"', 'true']) {
    it(`throws on arm_timeout_ms = ${bad}, naming the key`, () => {
      const label = `arm-timeout-bad-${bad.replace(/[^a-z0-9]/gi, '')}`;
      const { text, specPath } = specFor(`orders = "x"\narm_timeout_ms = ${bad}`, label);
      assert.throws(() => parseTrialSpec(text, specPath, '/tmp/out'), /arm_timeout_ms/);
    });
  }
});

// ===============================================================================================
// renderTrialResult
// ===============================================================================================

function metrics(overrides: Partial<ArmMetrics> = {}): ArmMetrics {
  return {
    wallMs: 47_300,
    harnessDurationMs: 46_000,
    costUsd: 0.0812,
    turns: 3,
    toolCalls: 7,
    inputTokens: 100,
    outputTokens: 200,
    ...overrides,
  };
}

function trialArm(overrides: Partial<TrialArm> = {}): TrialArm {
  return {
    id: 'high',
    effort: 'high',
    model: 'claude-sonnet-5',
    orders: 'do the thing',
    ordersLabel: 'default',
    ...overrides,
  };
}

function checkResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return { id: 'chk', kind: 'job', type: 'command', passed: true, detail: '', ...overrides };
}

function armResult(overrides: Partial<ArmResult> = {}): ArmResult {
  return {
    arm: trialArm(),
    effectiveEffort: 'high',
    workspace: '/tmp/ws',
    status: 'ok',
    metrics: metrics(),
    checks: [checkResult()],
    errors: [],
    ...overrides,
  };
}

function trialResult(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    title: 'demo trial',
    mode: 'concurrent',
    startedAt: '2026-08-04T00:00:00.000Z',
    finishedAt: '2026-08-04T00:01:00.000Z',
    seed: '/tmp/seed',
    baseCommit: 'a'.repeat(40),
    outDir: '/tmp/out',
    arms: [armResult()],
    vacuous: [],
    ...overrides,
  };
}

describe('renderTrialResult', () => {
  it('prints the refusal and no table when vacuous', () => {
    const out = renderTrialResult(trialResult({ vacuous: ['tests-pass'], arms: [] }));
    assert.match(out, /tests-pass/);
    assert.match(out, /already pass/);
    // The table is never built at all — its header column names must not appear.
    assert.ok(!out.includes('sent'), out);
    assert.ok(!out.includes('tools'), out);
  });

  it('prints one row per arm for a normal result', () => {
    const out = renderTrialResult(
      trialResult({
        arms: [
          armResult({ arm: trialArm({ id: 'low' }), effectiveEffort: 'low' }),
          armResult({ arm: trialArm({ id: 'xhigh' }), effectiveEffort: 'xhigh' }),
        ],
      }),
    );
    assert.match(out, /\blow\b/);
    assert.match(out, /\bxhigh\b/);
  });

  it('formats wall clock: sub-60s with one decimal, 60s+ as Xm Ys', () => {
    const out = renderTrialResult(
      trialResult({
        arms: [
          armResult({ arm: trialArm({ id: 'a' }), metrics: metrics({ wallMs: 47_300 }) }),
          armResult({ arm: trialArm({ id: 'b' }), metrics: metrics({ wallMs: 72_000 }) }),
        ],
      }),
    );
    assert.match(out, /47\.3s/);
    assert.match(out, /1m12s/);
  });

  it('formats cost as $0.0812 or "-" when null', () => {
    const out = renderTrialResult(
      trialResult({
        arms: [
          armResult({ arm: trialArm({ id: 'a' }), metrics: metrics({ costUsd: 0.0812 }) }),
          armResult({ arm: trialArm({ id: 'b' }), metrics: metrics({ costUsd: null }) }),
        ],
      }),
    );
    assert.match(out, /\$0\.0812/);
    assert.match(out, /\bb\s.*-/s);
  });

  it('two arms with the same effectiveEffort print the identical-effort line', () => {
    const out = renderTrialResult(
      trialResult({
        arms: [
          armResult({ arm: trialArm({ id: 'minimal' }), effectiveEffort: 'low' }),
          armResult({ arm: trialArm({ id: 'low' }), effectiveEffort: 'low' }),
        ],
      }),
    );
    assert.match(out, /identical effort/);
    assert.match(out, /minimal/);
    assert.match(out, /\blow\b/);
  });

  it('a failing check prints its detail', () => {
    const out = renderTrialResult(
      trialResult({
        arms: [
          armResult({
            checks: [checkResult({ id: 'scope', kind: 'compliance', passed: false, detail: 'changed extra.txt' })],
          }),
        ],
      }),
    );
    assert.match(out, /scope/);
    assert.match(out, /compliance/);
    assert.match(out, /changed extra\.txt/);
  });

  it('names an arm whose status is not ok', () => {
    const out = renderTrialResult(
      trialResult({ arms: [armResult({ arm: trialArm({ id: 'timed-out' }), status: 'timeout' })] }),
    );
    assert.match(out, /timed-out/);
    assert.match(out, /timeout/);
  });

  it('prints the concurrent-mode caveat only in concurrent mode', () => {
    const concurrent = renderTrialResult(trialResult({ mode: 'concurrent' }));
    const serial = renderTrialResult(trialResult({ mode: 'serial' }));
    assert.match(concurrent, /concurrent mode/);
    assert.doesNotMatch(serial, /concurrent mode/);
  });

  it('a timed-out arm with a known armTimeoutMs prints the ceiling in seconds and the caveat', () => {
    const out = renderTrialResult(
      trialResult({
        armTimeoutMs: 600_000,
        arms: [armResult({ arm: trialArm({ id: 'timed-out' }), status: 'timeout' })],
      }),
    );
    assert.match(out, /600s/);
    assert.match(out, /CENSORED/);
  });

  it('a result with no timed-out arm prints neither the ceiling nor the caveat', () => {
    const out = renderTrialResult(trialResult({ armTimeoutMs: 600_000 }));
    assert.doesNotMatch(out, /600s/);
    assert.doesNotMatch(out, /CENSORED/);
  });
});

// ===============================================================================================
// parseTrialArgs
// ===============================================================================================

describe('parseTrialArgs', () => {
  it('--serial and --concurrent together is an error', () => {
    assert.throws(() => parseTrialArgs(['spec.toml', '--serial', '--concurrent']), /mutually exclusive/);
  });

  it('an unknown option names itself', () => {
    assert.throws(() => parseTrialArgs(['spec.toml', '--nope']), /unknown option --nope/);
  });

  it('a missing positional is an error', () => {
    assert.throws(() => parseTrialArgs([]), /spec file is required/);
  });

  it('--dry-run and --json set their flags', () => {
    const args = parseTrialArgs(['spec.toml', '--dry-run', '--json']);
    assert.equal(args.dryRun, true);
    assert.equal(args.json, true);
  });

  it('defaults dryRun and json to false, and mode to undefined', () => {
    const args = parseTrialArgs(['spec.toml']);
    assert.equal(args.dryRun, false);
    assert.equal(args.json, false);
    assert.equal(args.mode, undefined);
  });

  it('--serial and --concurrent each set mode', () => {
    assert.equal(parseTrialArgs(['spec.toml', '--serial']).mode, 'serial');
    assert.equal(parseTrialArgs(['spec.toml', '--concurrent']).mode, 'concurrent');
  });

  it('--out overrides the default outDir', () => {
    const args = parseTrialArgs(['spec.toml', '--out', '/tmp/custom-out']);
    assert.equal(args.outDir, path.resolve('/tmp/custom-out'));
  });

  it('defaults outDir to <cwd>/.army-trial/<spec basename, no extension>', () => {
    const args = parseTrialArgs(['some/dir/my-trial.toml']);
    assert.equal(args.outDir, path.join(process.cwd(), '.army-trial', 'my-trial'));
  });
});

// ===============================================================================================
// trialCommand — driven entirely through an injected `runTrial`
// ===============================================================================================

function writeMinimalSpec(): string {
  const dir = scratchDir('command');
  fs.mkdirSync(path.join(dir, 'seed'));
  const specPath = path.join(dir, 'spec.toml');
  fs.writeFileSync(specPath, 'title = "cli demo"\nseed = "./seed"\norders = "do it"\n', 'utf8');
  return specPath;
}

/** A collecting `WriteStream` for stdout/stderr assertions. */
function sink(): { write: (t: string) => void; text: () => string } {
  let text = '';
  return { write: (t: string) => void (text += t), text: () => text };
}

function baseDeps(overrides: Partial<TrialCommandDeps> = {}): { deps: TrialCommandDeps; out: ReturnType<typeof sink>; err: ReturnType<typeof sink> } {
  const out = sink();
  const err = sink();
  return {
    deps: { stdout: out, stderr: err, home: '/fake/home', ...overrides },
    out,
    err,
  };
}

describe('trialCommand', () => {
  it('--dry-run returns 0, prints the arm plan, and never calls runTrial', async () => {
    const specPath = writeMinimalSpec();
    let called = false;
    const { deps, out } = baseDeps({
      runTrial: async () => {
        called = true;
        throw new Error('must not be called under --dry-run');
      },
    });
    const code = await trialCommand([specPath, '--dry-run'], deps);
    assert.equal(code, 0);
    assert.equal(called, false);
    assert.match(out.text(), /high/); // one of the five default effort arms
    assert.match(out.text(), /orders=\d+ chars/);
  });

  it('a fully passing result returns 0 and writes result.json', async () => {
    const specPath = writeMinimalSpec();
    const outDir = scratchDir('out-pass');
    const result: TrialResult = trialResult({ arms: [armResult({ status: 'ok', checks: [checkResult({ passed: true })] })] });
    const { deps, out } = baseDeps({ runTrial: async () => result });
    const code = await trialCommand([specPath, '--out', outDir], deps);
    assert.equal(code, 0, out.text());

    const written = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8')) as TrialResult;
    assert.equal(written.title, result.title);
  });

  it('a failed check returns 1', async () => {
    const specPath = writeMinimalSpec();
    const outDir = scratchDir('out-fail');
    const result: TrialResult = trialResult({
      arms: [armResult({ status: 'ok', checks: [checkResult({ passed: false, detail: 'nope' })] })],
    });
    const { deps } = baseDeps({ runTrial: async () => result });
    const code = await trialCommand([specPath, '--out', outDir], deps);
    assert.equal(code, 1);
  });

  it('an arm that never reached status ok returns 1', async () => {
    const specPath = writeMinimalSpec();
    const outDir = scratchDir('out-status');
    const result: TrialResult = trialResult({ arms: [armResult({ status: 'timeout' })] });
    const { deps } = baseDeps({ runTrial: async () => result });
    const code = await trialCommand([specPath, '--out', outDir], deps);
    assert.equal(code, 1);
  });

  it('a vacuous result returns 2', async () => {
    const specPath = writeMinimalSpec();
    const outDir = scratchDir('out-vacuous');
    const result: TrialResult = trialResult({ vacuous: ['tests-pass'], arms: [] });
    const { deps, out } = baseDeps({ runTrial: async () => result });
    const code = await trialCommand([specPath, '--out', outDir], deps);
    assert.equal(code, 2, out.text());
    assert.ok(fs.existsSync(path.join(outDir, 'result.json')));
  });

  // F9: a mistyped spec path answered with `ENOENT: no such file or directory, open '…'` — a raw
  // errno where every other refusal in this CLI speaks a sentence. The errno is a debugging
  // artefact; the reader's mistake is the path, so the message leads with that.
  it('a missing spec file is a sentence, not a raw ENOENT', async () => {
    const missing = path.join(scratchDir('missing-spec'), 'missing.toml');
    const { deps, err } = baseDeps({
      runTrial: async () => {
        throw new Error('must not be called — there was no spec to run');
      },
    });
    const code = await trialCommand([missing], deps);
    assert.equal(code, 1);
    assert.match(err.text(), new RegExp(`no such file: ${missing.replace(/[/.]/g, '\\$&')}`));
    assert.doesNotMatch(err.text(), /ENOENT/);
  });

  it('a directory handed as the spec path is named as one, not as an errno', async () => {
    const dir = scratchDir('dir-as-spec');
    const { deps, err } = baseDeps({
      runTrial: async () => {
        throw new Error('must not be called');
      },
    });
    const code = await trialCommand([dir], deps);
    assert.equal(code, 1);
    assert.match(err.text(), /is a directory, not a spec file/);
    assert.doesNotMatch(err.text(), /EISDIR/);
  });

  it(
    'an unreadable spec file reports the OS sentence without the errno prefix',
    { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'chmod 0 is not a denial here' : false },
    async () => {
      const dir = scratchDir('unreadable-spec');
      const specPath = path.join(dir, 'spec.toml');
      fs.writeFileSync(specPath, 'title = "t"\n', 'utf8');
      fs.chmodSync(specPath, 0);
      try {
        const { deps, err } = baseDeps({
          runTrial: async () => {
            throw new Error('must not be called');
          },
        });
        const code = await trialCommand([specPath], deps);
        assert.equal(code, 1);
        assert.match(err.text(), /cannot read .*spec\.toml: permission denied/);
        assert.doesNotMatch(err.text(), /EACCES/);
      } finally {
        fs.chmodSync(specPath, 0o600);
      }
    },
  );

  it('a parse error is caught and reported on one line, returning 1', async () => {
    const dir = scratchDir('bad-spec');
    const specPath = path.join(dir, 'spec.toml');
    fs.writeFileSync(specPath, 'title = "t"\n', 'utf8'); // missing seed
    const { deps, err } = baseDeps({
      runTrial: async () => {
        throw new Error('must not be called — the spec never parsed');
      },
    });
    const code = await trialCommand([specPath, '--out', scratchDir('bad-spec-out')], deps);
    assert.equal(code, 1);
    assert.match(err.text(), /seed/);
  });
});
