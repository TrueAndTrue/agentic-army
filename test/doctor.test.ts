/**
 * Tests for the pure logic behind `army doctor`, `army init` and `army enlist`.
 *
 * Almost everything here is hermetic: no subprocess, no dependence on what
 * happens to be installed. Every check is driven by an injected probe result,
 * because a test that passes only on a machine with `gh` installed is not a
 * test of the classifier — it is a test of the laptop.
 *
 * The two exceptions are at the bottom, and they are deliberate. Worktree key
 * collapsing and process-group cleanup are properties of how we drive real
 * subprocesses, and a stub cannot demonstrate either. Both skip cleanly rather
 * than fail when their prerequisite is missing.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { parse as parseToml } from 'smol-toml';
import ts from 'typescript';

import { killProcessTree, probe, resolveBinary, spawnProbeChild } from '../src/setup/checks.ts';
import { currentRepoRoot, decideCeiling, enlistCommand, mainRootFromCommonDir } from '../src/setup/enlist.ts';
import { initialCommitCommand, quoteArg, unrunnableReason } from '../src/setup/fixes.ts';
import { openNodeSqliteDb } from '../src/archive/db.ts';

import {
  BIN_NAME,
  MIN_CLAUDE,
  MIN_GIT,
  MIN_NODE,
  PACKAGE_NAME,
  classifyApiKey,
  classifyClaude,
  classifyCodex,
  classifyGh,
  classifyGit,
  classifyHome,
  classifyNode,
  classifySqlite,
  classifyStaleWorktreePool,
  classifyWorktreePool,
  compareVersions,
  countOutcomes,
  detectInvocation,
  invokedAs,
  exitCodeFor,
  formatVersion,
  inspectLegacyWorktreePool,
  inspectWritableDir,
  installHint,
  homeDir,
  legacyWorktreePoolDir,
  parseVersion,
  resolveBinarySync,
  satisfiesMinimum,
  stubProbe,
  worktreePoolDir,
  worstOutcome,
  type CheckResult,
} from '../src/setup/checks.ts';

import { parseDoctorArgs, wrap } from '../src/setup/doctor.ts';
import { PROTECTED_CONFIG_GLOBS, defaultConfigToml, protectedConfigGlobs } from '../src/setup/init.ts';
import { DEFAULT_CEILING, parseCeiling, parseEnlistArgs, type Rung } from '../src/setup/enlist.ts';

/**
 * A throwaway directory to hand anything that runs the REAL checks.
 *
 * `runChecks` inspects the home it is given, and inspecting means writing: `inspectWritableDir`
 * proves writability by creating `.army-write-probe-<pid>` and removing it, because
 * `access(W_OK)` lies on some network shares. Two tests in this file used to call
 * `runChecks(2000)` and let the home default, which pointed that probe at the developer's own
 * `~/.agentic-army` on every run of the suite.
 *
 * The directory exists before it is handed over, so the probe takes the branch it takes on a
 * real machine rather than the "not there yet, is the parent writable" branch — the check under
 * test is the one that writes.
 */
const SCRATCH_HOMES: string[] = [];
function scratchHome(label: string): string {
  const dir = fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), `army-${label}-`));
  SCRATCH_HOMES.push(dir);
  return dir;
}
after(() => {
  for (const dir of SCRATCH_HOMES) fs.rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// Version parsing — the thing most likely to silently misbehave
// ===========================================================================

describe('parseVersion', () => {
  const cases: Array<[string, string | null]> = [
    // The real shapes each of these tools actually prints.
    ['2.1.220 (Claude Code)', '2.1.220'],
    ['git version 2.53.0', '2.53.0'],
    ['codex-cli 0.142.5', '0.142.5'],
    ['gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli/releases/tag/v2.96.0', '2.96.0'],
    ['v24.14.1', '24.14.1'],
    ['24.14.1', '24.14.1'],
    // Odd but legal shapes.
    ['1.2', '1.2.0'],
    ['3.0.0-beta.4', '3.0.0'],
    ['sometool version 0.4.1+abcdef', '0.4.1'],
    ['git version 2.53.0.windows.1', '2.53.0'],
    ['  \n  2.1.219  \n ', '2.1.219'],
    // Nothing version-shaped.
    ['', null],
    ['command not found', null],
    ['built 2026-07-02', null],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)} -> ${String(expected)}`, () => {
      const parsed = parseVersion(input);
      assert.equal(parsed === null ? null : formatVersion(parsed), expected);
    });
  }

  it('rejects non-strings', () => {
    assert.equal(parseVersion(null), null);
    assert.equal(parseVersion(undefined), null);
  });

  it('does not read a date as a version', () => {
    assert.equal(parseVersion('released 2026-07-02'), null);
  });
});

describe('compareVersions', () => {
  const v = (s: string) => {
    const parsed = parseVersion(s);
    assert.ok(parsed !== null, `expected ${s} to parse`);
    return parsed;
  };

  it('orders by major, then minor, then patch', () => {
    assert.ok(compareVersions(v('2.0.0'), v('1.99.99')) > 0);
    assert.ok(compareVersions(v('1.2.0'), v('1.10.0')) < 0);
    assert.ok(compareVersions(v('2.1.219'), v('2.1.220')) < 0);
    assert.equal(compareVersions(v('2.1.220'), v('2.1.220')), 0);
  });

  it('compares numerically, not lexically', () => {
    // The bug this exists to prevent: "2.1.9" > "2.1.10" as strings.
    assert.ok(compareVersions(v('2.1.9'), v('2.1.10')) < 0);
    assert.ok(compareVersions(v('2.1.220'), v('2.1.99')) > 0);
  });
});

describe('satisfiesMinimum', () => {
  it('accepts the exact floor', () => {
    assert.equal(satisfiesMinimum('2.1.219 (Claude Code)', MIN_CLAUDE), true);
  });
  it('rejects one patch below the floor', () => {
    assert.equal(satisfiesMinimum('2.1.218 (Claude Code)', MIN_CLAUDE), false);
  });
  it('accepts above the floor', () => {
    assert.equal(satisfiesMinimum('2.1.220 (Claude Code)', MIN_CLAUDE), true);
    assert.equal(satisfiesMinimum('3.0.0', MIN_CLAUDE), true);
  });
  it('treats an unreadable version as not meeting the floor', () => {
    assert.equal(satisfiesMinimum('who knows', MIN_CLAUDE), false);
    assert.equal(satisfiesMinimum(null, MIN_CLAUDE), false);
  });
  it('handles the node and git floors', () => {
    assert.equal(satisfiesMinimum('v24.14.1', MIN_NODE), true);
    assert.equal(satisfiesMinimum('v18.20.4', MIN_NODE), false);
    assert.equal(satisfiesMinimum('git version 2.53.0', MIN_GIT), true);
    assert.equal(satisfiesMinimum('git version 2.19.1', MIN_GIT), false);
  });
});

// ===========================================================================
// Classification — exactly three outcomes, each owing the user something
// ===========================================================================

const versionProbe = (stdout: string) => stubProbe({ found: true, code: 0, stdout });
const absent = () => stubProbe({ found: false, error: 'not found on PATH' });
const timedOut = () => stubProbe({ found: true, timedOut: true, error: 'hard timeout' });

describe('classifyNode', () => {
  it('is ok on a supported node', () => {
    const r = classifyNode('24.14.1');
    assert.equal(r.outcome, 'ok');
    assert.equal(r.version, '24.14.1');
  });
  it('blocks below 20 and names the fix', () => {
    const r = classifyNode('18.20.4', 'darwin');
    assert.equal(r.outcome, 'blocking');
    assert.ok(r.fix !== undefined && r.fix.length > 0);
  });
  it('blocks on an unparseable version rather than assuming the best', () => {
    assert.equal(classifyNode('¯\\_(ツ)_/¯').outcome, 'blocking');
  });
});

describe('classifyGit', () => {
  it('is ok at 2.53.0', () => {
    assert.equal(classifyGit(versionProbe('git version 2.53.0')).outcome, 'ok');
  });
  it('blocks when absent, with an install command', () => {
    const r = classifyGit(absent(), 'darwin');
    assert.equal(r.outcome, 'blocking');
    assert.equal(r.fix, installHint('git', 'darwin'));
  });
  it('blocks below the worktree floor', () => {
    const r = classifyGit(versionProbe('git version 2.19.1'));
    assert.equal(r.outcome, 'blocking');
    assert.match(r.note ?? '', /worktree/i);
  });
  it('blocks on timeout instead of hanging the verdict', () => {
    assert.equal(classifyGit(timedOut()).outcome, 'blocking');
  });
});

describe('classifyClaude', () => {
  it('is ok at 2.1.220', () => {
    const r = classifyClaude(versionProbe('2.1.220 (Claude Code)'));
    assert.equal(r.outcome, 'ok');
    assert.equal(r.version, '2.1.220');
  });
  it('is ok exactly at the floor', () => {
    assert.equal(classifyClaude(versionProbe('2.1.219 (Claude Code)')).outcome, 'ok');
  });
  it('blocks one patch below the floor and explains why the floor exists', () => {
    const r = classifyClaude(versionProbe('2.1.218 (Claude Code)'));
    assert.equal(r.outcome, 'blocking');
    assert.match(r.note ?? '', /forward-subagent-text/);
    assert.ok(r.fix !== undefined);
  });
  it('blocks when absent', () => {
    assert.equal(classifyClaude(absent()).outcome, 'blocking');
  });
  it('reads the version off stderr if that is where it went', () => {
    const r = classifyClaude(stubProbe({ found: true, code: 0, stderr: '2.1.220 (Claude Code)' }));
    assert.equal(r.outcome, 'ok');
  });
});

describe('classifyApiKey', () => {
  it('is ok when unset — that is the correct state', () => {
    assert.equal(classifyApiKey(undefined).outcome, 'ok');
    assert.equal(classifyApiKey('').outcome, 'ok');
    assert.equal(classifyApiKey('   ').outcome, 'ok');
  });

  it('degrades loudly when set, naming the capability lost', () => {
    const r = classifyApiKey('sk-ant-api03-AAAABBBBCCCCDDDD');
    assert.equal(r.outcome, 'degraded');
    assert.ok(r.impact !== undefined);
    // The point is not "a key is set" but "your subscription is being bypassed".
    assert.match(r.impact, /subscription/i);
    assert.match(r.impact, /bill/i);
  });

  it('never prints the whole key', () => {
    const key = 'sk-ant-api03-SUPERSECRETVALUE1234';
    const r = classifyApiKey(key);
    assert.ok(!r.found.includes(key));
    assert.ok(!r.found.includes('SUPERSECRETVALUE'));
  });

  it('masks short values completely', () => {
    assert.match(classifyApiKey('abc').found, /\*\*\*\*/);
  });
});

describe('classifyCodex', () => {
  it('degrades when absent, naming cross-vendor review as the loss', () => {
    const r = classifyCodex(absent(), null);
    assert.equal(r.outcome, 'degraded');
    assert.match(r.impact ?? '', /blind spot|independen/i);
  });
  it('is ok when present and logged in', () => {
    const r = classifyCodex(versionProbe('codex-cli 0.142.5'), versionProbe('Logged in using ChatGPT'));
    assert.equal(r.outcome, 'ok');
    assert.equal(r.version, '0.142.5');
    assert.match(r.found, /Logged in using ChatGPT/);
  });
  it('degrades when present but not logged in', () => {
    const r = classifyCodex(
      versionProbe('codex-cli 0.142.5'),
      stubProbe({ found: true, code: 1, stdout: 'Not logged in' }),
    );
    assert.equal(r.outcome, 'degraded');
    assert.match(r.note ?? '', /codex login/);
  });
  it('stays ok when login status could not be determined', () => {
    assert.equal(classifyCodex(versionProbe('codex-cli 0.142.5'), null).outcome, 'ok');
    assert.equal(classifyCodex(versionProbe('codex-cli 0.142.5'), timedOut()).outcome, 'ok');
  });
});

describe('classifyGh', () => {
  it('degrades when absent and says delivery is capped at rung 1', () => {
    const r = classifyGh(absent(), null);
    assert.equal(r.outcome, 'degraded');
    assert.match(r.impact ?? '', /rung 1/);
  });
  it('degrades when present but unauthenticated', () => {
    const r = classifyGh(versionProbe('gh version 2.96.0 (2026-07-02)'), stubProbe({ found: true, code: 1 }));
    assert.equal(r.outcome, 'degraded');
    assert.match(r.impact ?? '', /rung 1/);
    assert.match(r.note ?? '', /gh auth login/);
  });
  it('is ok when present and authenticated', () => {
    const r = classifyGh(
      versionProbe('gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli'),
      stubProbe({ found: true, code: 0, stderr: 'Logged in to github.com' }),
    );
    assert.equal(r.outcome, 'ok');
    assert.equal(r.version, '2.96.0');
  });
});

describe('classifyWorktreePool', () => {
  const base = { dir: '/home/x/.agentic-army/worktrees', error: null };

  it('is ok when it exists and is writable', () => {
    assert.equal(
      classifyWorktreePool({ ...base, exists: true, writable: true, creatable: true }).outcome,
      'ok',
    );
  });

  it('is ok when absent but creatable — the pool is made on first use', () => {
    const r = classifyWorktreePool({ ...base, exists: false, writable: false, creatable: true });
    assert.equal(r.outcome, 'ok');
  });

  it('BLOCKS when it cannot be written, because there is no reduced mode without a worktree', () => {
    // Not degraded. Every Engineer and every Inspector needs its own tree, so a
    // pool root that cannot be written is a machine that cannot field a single agent.
    const r = classifyWorktreePool({ ...base, exists: true, writable: false, creatable: false });
    assert.equal(r.outcome, 'blocking');
    assert.ok((r.fix ?? '').length > 0);
  });

  it('blocks when it cannot be created either', () => {
    const r = classifyWorktreePool({
      ...base,
      exists: false,
      writable: false,
      creatable: false,
      error: 'EACCES',
    });
    assert.equal(r.outcome, 'blocking');
    assert.match(r.found, /EACCES/);
  });
});

describe('the treehouse check is gone', () => {
  // treehouse was dropped as a dependency: pooling, hooks and warm reuse are in-house now. The
  // check outlived the dependency for a while and emitted a ⚠ that no action could ever clear —
  // which does not inform anyone, it just teaches them to skim past warnings. This test exists
  // so it cannot be reinstated by a merge.
  const checks = fs.readFileSync(new URL('../src/setup/checks.ts', import.meta.url), 'utf8');

  it('checks.ts no longer probes for, classifies, or offers to install treehouse', () => {
    // Scoped to code rather than prose: the docblock on `classifyWorktreePool` explains what it
    // replaced and why, and that explanation is the reason the check will not creep back.
    assert.doesNotMatch(checks, /classifyTreehouse/);
    assert.doesNotMatch(checks, /probe\(\s*'treehouse'/);
    assert.doesNotMatch(checks, /go install github\.com\/\S*treehouse/);
    assert.doesNotMatch(checks, /'treehouse'/);
  });

  it('doctor reports no check with a treehouse id', async () => {
    const { runChecks } = await import('../src/setup/checks.ts');
    const report = await runChecks(2000, scratchHome('treehouse'));
    assert.ok(!report.checks.some((c) => c.id === ('treehouse' as never)));
    // And the replacement is present, because removing the check without adding the real
    // precondition would just be deleting coverage.
    assert.ok(report.checks.some((c) => c.id === 'worktree-pool'));
  });

  it('the config template does not tell the user to install anything extra', () => {
    assert.doesNotMatch(defaultConfigToml(), /treehouse/i);
  });

  it('the README does not list treehouse as an optional capability', () => {
    const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.doesNotMatch(readme, /treehouse/i);
    // And the install story it now promises must be the whole install story.
    assert.match(readme, /npm install -g agentic-army/);
  });
});

// ===========================================================================
// The pool root is a SIBLING of the army home, and that is a security property
//
// It was `<home>/worktrees`, which made every campaign a no-op on a real machine: every worker's
// deny-list carries `protectedConfigGlobs(home)` as Read/Grep/Glob/Write/Edit denies, so the
// Engineer was denied its own leased worktree and could not open a single file.
//
// The deny is not what gives. `<home>/campaigns/<id>/agents/cpt-01/report.md` is the Engineer's
// OWN account of its work, and the review gate requires the Inspector be briefed from the orders
// and the branch and never from that account — a worker that can read the archive walks around
// the review gate with one file read. So the trees moved out, and these tests pin that they
// stayed out.
// ===========================================================================

describe('worktreePoolDir', () => {
  it('is a SIBLING of the army home, not a directory inside it', () => {
    assert.equal(worktreePoolDir('/tmp/army-home'), '/tmp/army-home-trees');
    // The specific thing that broke: not under the home.
    assert.ok(!worktreePoolDir('/tmp/army-home').startsWith('/tmp/army-home/'));
  });

  it('relocates with AGENTIC_ARMY_HOME, so the suite never leases inside the real home', async () => {
    const { armyHome, worktreesRoot, worktreesRootFor } = await import('../src/config/paths.ts');
    const env = { AGENTIC_ARMY_HOME: '/tmp/x' };
    assert.equal(worktreesRoot(env), '/tmp/x-trees');
    assert.equal(worktreesRoot(env), worktreesRootFor(armyHome(env)));
    // Derived from the HOME, never from `archive_root`: that value is user-editable TOML, and a
    // config pointing it back inside the protected tree would silently restore the original bug.
    assert.equal(worktreesRootFor('/tmp/x/'), '/tmp/x-trees');
  });

  it('is NOT matched by protectedConfigGlobs — the whole point of the move', () => {
    const home = '/tmp/army-home';
    const pool = worktreePoolDir(home);
    for (const glob of protectedConfigGlobs(home)) {
      const base = glob.replace(/\/\*\*$/, '');
      assert.ok(
        pool !== base && !pool.startsWith(`${base}/`),
        `the pool root ${pool} is inside the denied glob ${glob}; an Engineer leased a tree ` +
          'there would be denied Read on its own worktree',
      );
    }
    // And the old location IS matched, so the assertion above is not vacuous.
    const old = legacyWorktreePoolDir(home);
    assert.ok(
      protectedConfigGlobs(home).some((g) => old.startsWith(`${g.replace(/\/\*\*$/, '')}/`)),
      'the old location is no longer denied, so this test proves nothing',
    );
  });
});

describe('the pool left at the old location is not silently orphaned', () => {
  /** A legacy pool with `n` leased trees, each registered against `repo`. */
  function makeLegacyPool(trees: Array<{ slug: string; slot: string; repo: string | null }>): string {
    const home = fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), 'army-stale-'));
    const pool = legacyWorktreePoolDir(home);
    fs.mkdirSync(nodePath.join(pool, 'trees'), { recursive: true });
    for (const { slug, slot, repo } of trees) {
      const dir = nodePath.join(pool, 'trees', slug, slot);
      fs.mkdirSync(dir, { recursive: true });
      if (repo !== null) {
        fs.writeFileSync(nodePath.join(dir, '.git'), `gitdir: ${repo}/.git/worktrees/${slot}\n`);
      }
    }
    return home;
  }

  const homes: string[] = [];
  after(() => {
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  });
  function tmpHome(trees: Parameters<typeof makeLegacyPool>[0]): string {
    const home = makeLegacyPool(trees);
    homes.push(home);
    return home;
  }

  it('is quiet when there is nothing at the old location', async () => {
    const home = fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), 'army-clean-'));
    homes.push(home);
    const state = await inspectLegacyWorktreePool(legacyWorktreePoolDir(home));
    assert.equal(state.exists, false);
    assert.equal(classifyStaleWorktreePool(state).outcome, 'ok');
  });

  it('finds the leased trees AND the repositories they are still registered in', async () => {
    // The real report from the machine this was found on: a live worktree at
    // <home>/worktrees/trees/army-demo-1fd7ec6d/wt-01, registered in ~/…/army-demo. After the
    // move nothing manages that path, so `git worktree list` in that repo names a directory the
    // army has forgotten about. Naming the repo is what makes the fix runnable.
    const home = tmpHome([
      { slug: 'army-demo-1fd7ec6d', slot: 'wt-01', repo: '/home/me/army-demo' },
      { slug: 'army-demo-1fd7ec6d', slot: 'wt-02', repo: '/home/me/army-demo' },
      { slug: 'other-0badcafe', slot: 'wt-01', repo: '/home/me/other' },
    ]);
    const state = await inspectLegacyWorktreePool(legacyWorktreePoolDir(home));

    assert.equal(state.exists, true);
    assert.equal(state.trees.length, 3);
    assert.deepEqual(state.repos, ['/home/me/army-demo', '/home/me/other']);

    const r = classifyStaleWorktreePool(state);
    assert.equal(r.outcome, 'degraded');
    assert.equal(r.id, 'stale-worktree-pool');
    assert.ok((r.impact ?? '').length > 20, 'a degraded result owes the reader what it costs');
    assert.match(r.found, /3 leased tree/);
    assert.match(r.found, /army-demo/);

    // The fix is `git worktree remove` WITHOUT --force, chained with &&, then the delete. That
    // ordering is the safety argument: `remove` refuses on a tree with uncommitted changes and
    // the chain stops before `rm -rf`, so doctor never suggests deleting unlanded work.
    const fix = r.fix ?? '';
    assert.doesNotMatch(fix, /--force|-f\b/);
    assert.equal(fix.split(' && ').length, 4);
    assert.match(fix, /^git worktree remove /);
    assert.ok(fix.endsWith(`rm -rf ${legacyWorktreePoolDir(home)}`), fix);
    for (const tree of state.trees) assert.ok(fix.includes(tree), `${tree} is not in the fix`);
  });

  it('still reports a pool whose trees carry no .git file', async () => {
    const home = tmpHome([{ slug: 'orphan-deadbeef', slot: 'wt-01', repo: null }]);
    const state = await inspectLegacyWorktreePool(legacyWorktreePoolDir(home));
    assert.deepEqual(state.repos, []);
    assert.equal(classifyStaleWorktreePool(state).outcome, 'degraded');
  });

  it('reports a bare leftover directory with no trees/ in it', async () => {
    const home = fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), 'army-bare-'));
    homes.push(home);
    fs.mkdirSync(legacyWorktreePoolDir(home), { recursive: true });
    const state = await inspectLegacyWorktreePool(legacyWorktreePoolDir(home));
    assert.equal(state.exists, true);
    assert.deepEqual(state.trees, []);
    const r = classifyStaleWorktreePool(state);
    assert.equal(r.outcome, 'degraded');
    assert.equal(r.fix, `rm -rf ${legacyWorktreePoolDir(home)}`);
  });

  it('never creates or removes anything — doctor stays safe to run anywhere', async () => {
    const home = tmpHome([{ slug: 'a-1', slot: 'wt-01', repo: '/home/me/a' }]);
    const before = fs.readdirSync(nodePath.join(legacyWorktreePoolDir(home), 'trees', 'a-1'));
    await inspectLegacyWorktreePool(legacyWorktreePoolDir(home));
    assert.deepEqual(fs.readdirSync(nodePath.join(legacyWorktreePoolDir(home), 'trees', 'a-1')), before);
    assert.equal(fs.existsSync(worktreePoolDir(home)), false, 'inspecting created the new pool');
  });

  it('runChecks reports the check by id', async () => {
    const { runChecks } = await import('../src/setup/checks.ts');
    const report = await runChecks(2000, scratchHome('stale-pool'));
    assert.ok(report.checks.some((c) => c.id === 'stale-worktree-pool'));
  });

  it('the terminal actually prints the command, not just --json', async () => {
    // A check that describes a problem and then hides its own answer in `--json` is a check the
    // reader cannot act on. `fix` used to be rendered for blocking results only, and this is the
    // first degraded result that carries one.
    const { renderCheck } = await import('../src/setup/doctor.ts');
    const r = classifyStaleWorktreePool({
      dir: '/x/worktrees',
      exists: true,
      trees: ['/x/worktrees/trees/repo-abc/wt-01'],
      repos: ['/home/me/repo'],
    });
    assert.equal(r.outcome, 'degraded');
    const rendered = renderCheck(r, false, 100).join('\n');
    assert.match(rendered, /fix: {2}git worktree remove \/x\/worktrees\/trees\/repo-abc\/wt-01/);
    assert.ok(rendered.includes(r.fix ?? ''), `the fix was truncated:\n${rendered}`);
    // An `ok` result never prints a fix line, whatever it carries.
    const fine = classifyStaleWorktreePool({ dir: '/x/worktrees', exists: false, trees: [], repos: [] });
    assert.doesNotMatch(renderCheck(fine, false, 100).join('\n'), /fix:/);
  });
});

describe('inspectWritableDir', () => {
  it('calls a directory creatable when its PARENT does not exist yet either', async () => {
    // The regression this exists for: on a clean machine the pool root is <home>/worktrees and
    // <home> has not been created yet, so testing only the immediate parent yields ENOENT —
    // "cannot be created" — and `army doctor` blocks a first-ever `army init` on a machine with
    // nothing wrong with it. `mkdir -p` asks whether the nearest EXISTING ancestor is writable,
    // and so must this.
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-deep-'));
    try {
      const deep = nodePath.join(tmp, 'home', 'worktrees');
      const state = await inspectWritableDir(deep);
      assert.equal(state.exists, false);
      assert.equal(state.creatable, true, `should be creatable, got error: ${state.error ?? ''}`);
      assert.equal(classifyWorktreePool(state).outcome, 'ok');
      // And nothing was created just by asking.
      assert.equal(fs.existsSync(nodePath.join(tmp, 'home')), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT call a path creatable when an ancestor is a regular file', async () => {
    // `AGENTIC_ARMY_HOME` pointing at a file. `fs.access(W_OK)` answers "you may write this
    // inode" and says nothing about what kind of inode it is, so a writable regular file passed
    // and `<file>/worktrees` was reported OK — a path that can never exist. The `home` check
    // blocks independently so the exit code was still right, but a green line that is false is
    // worse than a missing one, because it is a claim the reader acts on.
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-file-'));
    try {
      const notADir = nodePath.join(tmp, 'home');
      fs.writeFileSync(notADir, 'i am a file, not a directory');
      const state = await inspectWritableDir(nodePath.join(notADir, 'worktrees'));
      assert.equal(state.creatable, false, 'a file ancestor must never read as creatable');
      const check = classifyWorktreePool(state);
      assert.equal(check.outcome, 'blocking');
      assert.match(check.found, /not a directory/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still blocks when an existing ancestor refuses writes', async function () {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-ro-'));
    try {
      const locked = nodePath.join(tmp, 'locked');
      fs.mkdirSync(locked, { mode: 0o500 });
      const state = await inspectWritableDir(nodePath.join(locked, 'home', 'worktrees'));
      assert.equal(state.creatable, false, 'a read-only ancestor must not read as creatable');
      assert.equal(classifyWorktreePool(state).outcome, 'blocking');
    } finally {
      fs.chmodSync(nodePath.join(tmp, 'locked'), 0o700);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('classifyHome', () => {
  const base = { dir: '/home/x/.agentic-army', error: null };
  it('is ok when it exists and is writable', () => {
    assert.equal(classifyHome({ ...base, exists: true, writable: true, creatable: true }).outcome, 'ok');
  });
  it('is ok when absent but creatable, and names init the way THIS user must type it', () => {
    const r = classifyHome({ ...base, exists: false, writable: false, creatable: true });
    assert.equal(r.outcome, 'ok');
    assert.ok(
      (r.note ?? '').includes(`${invokedAs()} init`),
      `note should suggest the runnable form, got: ${r.note ?? ''}`,
    );
  });
  it('blocks when it cannot be created, with a fix', () => {
    const r = classifyHome({ ...base, exists: false, writable: false, creatable: false, error: 'EACCES' });
    assert.equal(r.outcome, 'blocking');
    assert.ok((r.fix ?? '').length > 0);
  });
  it('blocks when it exists but is read-only', () => {
    assert.equal(
      classifyHome({ ...base, exists: true, writable: false, creatable: false }).outcome,
      'blocking',
    );
  });
});

describe('classifySqlite', () => {
  it('is ok when importable', () => {
    assert.equal(classifySqlite(true).outcome, 'ok');
  });
  it('blocks when not, with a fix', () => {
    const r = classifySqlite(false, 'No such built-in module');
    assert.equal(r.outcome, 'blocking');
    assert.ok((r.fix ?? '').length > 0);
  });
});

// ---------------------------------------------------------------------------
// The contract every check must honour
// ---------------------------------------------------------------------------

describe('outcome contract', () => {
  const everyShape: CheckResult[] = [
    classifyNode('18.0.0'),
    classifyNode('24.14.1'),
    classifyGit(absent()),
    classifyGit(versionProbe('git version 2.53.0')),
    classifyClaude(absent()),
    classifyClaude(versionProbe('2.1.218')),
    classifyClaude(versionProbe('2.1.220')),
    classifyApiKey(undefined),
    classifyApiKey('sk-ant-whatever-1234'),
    classifyCodex(absent(), null),
    classifyCodex(versionProbe('codex-cli 0.142.5'), versionProbe('Logged in')),
    classifyGh(absent(), null),
    classifyGh(versionProbe('gh version 2.96.0'), stubProbe({ found: true, code: 0 })),
    classifyHome({ dir: '/x', exists: false, writable: false, creatable: false, error: null }),
    classifyHome({ dir: '/x', exists: true, writable: true, creatable: true, error: null }),
    classifyWorktreePool({ dir: '/x/worktrees', exists: false, writable: false, creatable: false, error: null }),
    classifyWorktreePool({ dir: '/x/worktrees', exists: true, writable: true, creatable: true, error: null }),
    classifyStaleWorktreePool({ dir: '/x/worktrees', exists: false, trees: [], repos: [] }),
    classifyStaleWorktreePool({ dir: '/x/worktrees', exists: true, trees: [], repos: [] }),
    classifyStaleWorktreePool({
      dir: '/x/worktrees',
      exists: true,
      trees: ['/x/worktrees/trees/repo-abc/wt-01'],
      repos: ['/home/me/repo'],
    }),
    classifySqlite(false),
    classifySqlite(true),
  ];

  it('only ever produces the three defined outcomes', () => {
    for (const r of everyShape) {
      assert.ok(['ok', 'degraded', 'blocking'].includes(r.outcome), `${r.id}: ${r.outcome}`);
    }
  });

  it('every degraded result says what capability is lost', () => {
    for (const r of everyShape.filter((x) => x.outcome === 'degraded')) {
      assert.ok(r.impact !== undefined && r.impact.length > 20, `${r.id} has no impact text`);
    }
  });

  it('every blocking result carries a command to run', () => {
    for (const r of everyShape.filter((x) => x.outcome === 'blocking')) {
      assert.ok(r.fix !== undefined && r.fix.length > 0, `${r.id} has no fix command`);
    }
  });

  it('no blocking fix is a flag fragment or an instruction dressed as a command', () => {
    // "Upgrade Node, or run with --experimental-sqlite: node --experimental-sqlite" satisfied
    // "has a fix" and could not be run by anyone. A fix nobody ran is a fix nobody tested.
    //
    // The screen itself is `unrunnableReason` in `src/setup/fixes.ts` rather than a pair of
    // regexes local to this file. `campaign` owes the identical guarantee, and two copies of a
    // predicate is exactly the drift a standing order on this project exists to prevent: two
    // implementations plus a drift test is worse than one, because the second copy is always the
    // one that misses the case the first one learned.
    for (const r of everyShape.filter((x) => x.outcome === 'blocking')) {
      assert.equal(unrunnableReason(r.fix ?? ''), null, `${r.id}: ${String(unrunnableReason(r.fix ?? ''))}`);
    }
  });

  it('every result reports what was actually found', () => {
    for (const r of everyShape) {
      assert.ok(r.found.length > 0, `${r.id} has no found text`);
    }
  });
});

describe('a blocking fix must actually resolve the thing it is offered for', () => {
  // The contract says blocking owes the EXACT command that resolves it. The only way to
  // know a command resolves anything is to run it and re-check. `mkdir -p "<file>"` satisfied
  // every static assertion above and failed with "File exists" the moment anyone typed it.
  const skip = process.platform === 'win32' ? 'POSIX shell fixes; Windows emits different ones' : false;

  it('the fix for a directory blocked by a regular file works when run', { skip }, async () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-fixrun-'));
    try {
      const home = nodePath.join(tmp, 'home');
      fs.writeFileSync(home, 'a file sitting where the archive home belongs');
      const target = nodePath.join(home, 'worktrees');

      const before = classifyWorktreePool(await inspectWritableDir(target));
      assert.equal(before.outcome, 'blocking');

      // Run the emitted command verbatim, exactly as the user would paste it.
      const run = spawnSync('/bin/sh', ['-c', before.fix ?? ''], { encoding: 'utf8' });
      assert.equal(run.status, 0, `the fix failed: ${run.stderr}`);

      // And the check it was offered for now passes. Either half alone proves nothing.
      const after = classifyWorktreePool(await inspectWritableDir(target));
      assert.equal(after.outcome, 'ok', `still blocking after the fix: ${after.found}`);
      assert.ok(fs.existsSync(`${home}.bak`), 'the displaced file must be preserved, never deleted');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the fix for a missing, unwritable-parent directory works when run', { skip }, async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-fixrun2-'));
    try {
      const target = nodePath.join(tmp, 'home');
      fs.mkdirSync(target, { mode: 0o500 });
      const before = classifyHome(await inspectWritableDir(target));
      assert.equal(before.outcome, 'blocking');

      const run = spawnSync('/bin/sh', ['-c', before.fix ?? ''], { encoding: 'utf8' });
      assert.equal(run.status, 0, `the fix failed: ${run.stderr}`);

      const after = classifyHome(await inspectWritableDir(target));
      assert.equal(after.outcome, 'ok', `still blocking after the fix: ${after.found}`);
    } finally {
      try {
        fs.chmodSync(nodePath.join(tmp, 'home'), 0o700);
      } catch {
        /* already fixed by the command under test */
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('aggregation', () => {
  const ok = classifyNode('24.14.1');
  const degraded = classifyGh(absent(), null);
  const blocking = classifyGit(absent());

  it('picks the worst outcome', () => {
    assert.equal(worstOutcome([ok, ok]), 'ok');
    assert.equal(worstOutcome([ok, degraded]), 'degraded');
    assert.equal(worstOutcome([ok, degraded, blocking]), 'blocking');
    assert.equal(worstOutcome([]), 'ok');
  });

  it('counts each outcome', () => {
    assert.deepEqual(countOutcomes([ok, degraded, degraded, blocking]), {
      ok: 1,
      degraded: 2,
      blocking: 1,
    });
  });

  it('exits 0 for degraded and 1 only for blocking — degraded must not fail CI', () => {
    assert.equal(exitCodeFor([ok, degraded, degraded]), 0);
    assert.equal(exitCodeFor([ok, blocking]), 1);
    assert.equal(exitCodeFor([]), 0);
  });
});

describe('installHint', () => {
  it('is platform specific rather than "install git"', () => {
    assert.notEqual(installHint('git', 'win32'), installHint('git', 'darwin'));
    assert.match(installHint('git', 'win32'), /winget/);
    assert.match(installHint('gh', 'darwin'), /brew/);
    assert.match(installHint('claude', 'linux'), /npm install -g/);
  });
});

describe('doctor arg parsing', () => {
  it('defaults to human output', () => {
    assert.deepEqual(parseDoctorArgs([]), { json: false, timeoutMs: 5000 });
  });
  it('accepts --json and both --timeout spellings', () => {
    assert.equal(parseDoctorArgs(['--json']).json, true);
    assert.equal(parseDoctorArgs(['--timeout', '250']).timeoutMs, 250);
    assert.equal(parseDoctorArgs(['--timeout=250']).timeoutMs, 250);
  });
  it('ignores nonsense timeouts rather than spawning with timeout NaN', () => {
    assert.equal(parseDoctorArgs(['--timeout', 'soon']).timeoutMs, 5000);
    assert.equal(parseDoctorArgs(['--timeout=-5']).timeoutMs, 5000);
  });
});

describe('wrap', () => {
  it('wraps to width and indents every line', () => {
    const lines = wrap('one two three four five six seven eight', 30, '    ');
    assert.ok(lines.length > 1);
    for (const l of lines) {
      assert.ok(l.startsWith('    '));
      assert.ok(l.length <= 30);
    }
  });
  it('handles a single long word without looping forever', () => {
    assert.deepEqual(wrap('supercalifragilistic', 10, '  '), ['  supercalifragilistic']);
  });
});

// ===========================================================================
// Delivery ceilings — the security-critical arithmetic
// ===========================================================================

describe('parseCeiling', () => {
  it('accepts 0..3', () => {
    for (const n of [0, 1, 2, 3]) {
      const r = parseCeiling(String(n));
      assert.ok(r.ok);
      assert.equal(r.value, n);
    }
  });

  it('rejects rather than clamps, so a typo is not silently honoured', () => {
    for (const bad of ['4', '-1', '10', 'two', '', '  ', '2.5', undefined]) {
      const r = parseCeiling(bad);
      assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it('tolerates surrounding whitespace', () => {
    const r = parseCeiling('  2 ');
    assert.ok(r.ok);
    assert.equal(r.value, 2);
  });
});

describe('parseEnlistArgs', () => {
  it('defaults to no explicit ceiling', () => {
    assert.deepEqual(parseEnlistArgs([]), { ok: true, ceiling: null });
  });
  it('accepts both --ceiling spellings', () => {
    assert.deepEqual(parseEnlistArgs(['--ceiling', '2']), { ok: true, ceiling: 2 });
    assert.deepEqual(parseEnlistArgs(['--ceiling=3']), { ok: true, ceiling: 3 });
  });
  it('rejects out-of-range and unknown flags', () => {
    assert.equal(parseEnlistArgs(['--ceiling', '4']).ok, false);
    assert.equal(parseEnlistArgs(['--wat']).ok, false);
    assert.equal(parseEnlistArgs(['some-repo']).ok, false);
  });
});

// ===========================================================================
// TOML round-tripping
// ===========================================================================

describe('default config', () => {
  const toml = defaultConfigToml();
  const parsed = parseToml(toml) as Record<string, any>;

  it('is valid TOML', () => {
    assert.equal(typeof parsed, 'object');
  });

  it('declares a schema version and a commit-only default ceiling', () => {
    assert.equal(parsed['version'], 1);
    assert.equal(parsed['delivery'].default_ceiling, 0);
  });

  it('carries the static vendor split verbatim, in rules[] form', () => {
    const rules = parsed['dispatch'].rules as Array<Record<string, any>>;
    assert.equal(rules.length, 2);

    assert.equal(rules[0].when, 'Any change to any file.');
    // Effort is `low` — a measured default, not a quota downgrade — conditional on the
    // complete-spec guarantee described in the rule's own `why`. See DEFAULT_DISPATCH in
    // src/config/load.ts, which this file is pinned byte-compatible with.
    assert.deepEqual(rules[0].use, [{ harness: 'claude', model: 'claude-sonnet-5', effort: 'low' }]);
    assert.equal(
      rules[0].why,
      'Engineers build on Claude. Effort is low by measured default, not by economy: a complete ' +
        'spec produced byte-identical output at low and xhigh, 4x cheaper and 4x faster. A brief ' +
        'dispatched without a complete spec never sees this value — UNSPECIFIED_BRIEF_EFFORT in ' +
        "campaign.ts's dispatchFor escalates it to xhigh first.",
    );

    assert.equal(rules[1].when, 'An Engineer has claimed done and its branch needs review.');
    assert.deepEqual(rules[1].use, [{ harness: 'codex', model: 'gpt-5.5', effort: 'high' }]);
    assert.equal(rules[1].why, "Reviewer must not share the builder's blind spots.");
  });

  it('uses single-entry arrays so quota-resolved dispatch is a config change', () => {
    for (const rule of parsed['dispatch'].rules as Array<Record<string, any>>) {
      assert.ok(Array.isArray(rule.use));
    }
  });

  it('has an empty [projects] table ready for enlist', () => {
    assert.deepEqual(parsed['projects'], {});
  });

  it('explains itself — the comments are the reason this is TOML', () => {
    assert.match(toml, /SECURITY/);
    assert.match(toml, /blind spots/);
  });

  it('states the raise policy accurately rather than overclaiming', () => {
    // This comment previously asserted that raising was ALWAYS a file edit,
    // which was false — `army enlist --ceiling N` could do it. Now it must
    // describe both routes and the condition on each.
    assert.match(toml, /real TTY/);
    assert.match(toml, /editing this file directly/);
    assert.match(toml, /LOWERING is always allowed/);
    assert.doesNotMatch(toml, /Nothing in the running system may raise one: not an agent/);
  });

  it('documents AGENTIC_ARMY_HOME, and that a worker must never supply it', () => {
    assert.match(toml, /AGENTIC_ARMY_HOME/);
    assert.match(toml, /NEVER accept this value from a worker/);
  });

  it('explains that entries key on the main repo, not a worktree', () => {
    assert.match(toml, /linked worktree cannot register itself/);
  });
});

describe('decideCeiling', () => {
  const TTY = true;
  const PIPE = false;

  it('refuses every raise when stdin is not a terminal', () => {
    // The whole point: an agent holding Bash can type any command it likes,
    // but it cannot manufacture a controlling terminal.
    assert.deepEqual(decideCeiling(0, 3, PIPE), { kind: 'refused', requested: 3, from: 0 });
    assert.deepEqual(decideCeiling(1, 2, PIPE), { kind: 'refused', requested: 2, from: 1 });
    assert.deepEqual(decideCeiling(2, 3, PIPE), { kind: 'refused', requested: 3, from: 2 });
  });

  it('refuses a raise on a brand-new project too', () => {
    // The residual hole: an agent reaching a fresh repo before the human does.
    // An unknown project is ceiling 0, so asking for anything above that is a
    // raise like any other.
    assert.deepEqual(decideCeiling(null, 3, PIPE), { kind: 'refused', requested: 3, from: 0 });
    assert.deepEqual(decideCeiling(null, 1, PIPE), { kind: 'refused', requested: 1, from: 0 });
  });

  it('allows a raise from a real terminal', () => {
    assert.deepEqual(decideCeiling(0, 3, TTY), { kind: 'raise', target: 3, from: 0 });
    assert.deepEqual(decideCeiling(null, 2, TTY), { kind: 'register', target: 2 });
  });

  it('always allows lowering, terminal or not', () => {
    assert.deepEqual(decideCeiling(3, 1, PIPE), { kind: 'lower', target: 1, from: 3 });
    assert.deepEqual(decideCeiling(3, 0, PIPE), { kind: 'lower', target: 0, from: 3 });
    assert.deepEqual(decideCeiling(2, 1, TTY), { kind: 'lower', target: 1, from: 2 });
  });

  it('registers a new project at 0 without a terminal', () => {
    // Plain `army enlist` must keep working from a script; it grants nothing.
    assert.deepEqual(decideCeiling(null, null, PIPE), { kind: 'register', target: 0 });
    assert.deepEqual(decideCeiling(null, 0, PIPE), { kind: 'register', target: 0 });
  });

  it('is a no-op when the request matches what is recorded', () => {
    assert.deepEqual(decideCeiling(2, 2, PIPE), { kind: 'unchanged', target: 2 });
    assert.deepEqual(decideCeiling(2, null, PIPE), { kind: 'unchanged', target: 2 });
  });

  it('never returns a target above what was asked for or already held', () => {
    for (const existing of [null, 0, 1, 2, 3] as Array<Rung | null>) {
      for (const requested of [null, 0, 1, 2, 3] as Array<Rung | null>) {
        for (const interactive of [true, false]) {
          const d = decideCeiling(existing, requested, interactive);
          if (d.kind === 'refused') {
            assert.equal(interactive, false, 'refusals only happen without a TTY');
            continue;
          }
          const ceiling = requested ?? existing ?? 0;
          assert.equal(d.target, ceiling);
          if (!interactive) {
            assert.ok(d.target <= (existing ?? 0), `non-interactive raise leaked: ${JSON.stringify(d)}`);
          }
        }
      }
    }
  });
});

// ===========================================================================
// Worktree key collapsing — every Engineer gets its own worktree, so this
// is the normal environment of every agent, not an edge case.
// ===========================================================================

describe('mainRootFromCommonDir', () => {
  it('maps a .git directory to its parent — the main worktree root', () => {
    assert.equal(mainRootFromCommonDir('/code/repo1/.git'), nodePath.resolve('/code/repo1'));
  });

  it('maps the SAME common dir a linked worktree reports to the SAME root', () => {
    // This is the fix. `git rev-parse --git-common-dir` answers with the main
    // repo's .git from inside any linked worktree, so both collapse to one key
    // — whereas --show-toplevel would have produced /code/wt1 and handed the
    // worktree its own independent ceiling.
    const fromMain = mainRootFromCommonDir('/code/repo1/.git');
    const fromWorktree = mainRootFromCommonDir('/code/repo1/.git');
    assert.equal(fromMain, fromWorktree);
    assert.notEqual(fromWorktree, nodePath.resolve('/code/wt1'));
  });

  it('leaves a bare repo alone — there is no worktree above it', () => {
    assert.equal(mainRootFromCommonDir('/code/mirror.git'), nodePath.resolve('/code/mirror.git'));
  });

  it('normalises relative and untidy paths', () => {
    assert.equal(mainRootFromCommonDir('/code/repo1/./.git'), nodePath.resolve('/code/repo1'));
    assert.equal(mainRootFromCommonDir('/code/repo1/sub/../.git'), nodePath.resolve('/code/repo1'));
  });
});

const gitPath = await resolveBinary('git');

describe('worktree and main checkout resolve to one config key', { skip: gitPath === null ? 'git not on PATH' : false }, () => {
  it('reports the main repo root from inside a linked worktree', async () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-wt-'));
    const cwd = process.cwd();
    try {
      const repo = nodePath.join(tmp, 'repo1');
      fs.mkdirSync(repo);
      const git = (args: string[], at: string): void => {
        execFileSync('git', args, { cwd: at, stdio: 'ignore' });
      };
      git(['init', '-q'], repo);
      git(['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
      const worktree = nodePath.join(tmp, 'wt1');
      git(['worktree', 'add', '-q', worktree, '-b', 'wt1'], repo);

      process.chdir(repo);
      const fromMain = await currentRepoRoot();
      process.chdir(worktree);
      const fromWorktree = await currentRepoRoot();

      assert.ok(fromMain.ok && fromWorktree.ok, 'both lookups should succeed');
      assert.equal(fromMain.root, fromWorktree.root);
      // And specifically: it is the MAIN root, not the worktree path.
      assert.equal(fromWorktree.root, fs.realpathSync(repo));
      assert.notEqual(fromWorktree.root, fs.realpathSync(worktree));
    } finally {
      process.chdir(cwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// A timed-out probe must take its grandchildren with it
// ===========================================================================

/**
 * WHY THIS SUITE LOOKS LIKE THIS — read before "simplifying" it.
 *
 * The original test spawned a wrapper script that forks a grandchild and records its pid, gave
 * `probe` a 400ms timeout, and then asserted the grandchild was dead. It failed roughly one run
 * in six, and the diagnosis on file — a race between `process.kill(-pid)` and the grandchild
 * being reparented into the group — was wrong. On POSIX a forked child inherits its parent's
 * process group atomically at fork; there is no window to lose.
 *
 * The real race was upstream of the kill. Measured on this machine, a freshly written shell
 * script takes p50 132ms and up to 208ms in a quiet loop just to start and reach its second
 * line — macOS re-validates a newly created executable on first exec. The test was asserting
 * that the wrapper would win a wall-clock footrace against a 400ms timer, and under a loaded
 * event loop it sometimes did not. When it lost, the group was killed before the pid file was
 * ever written and the test failed on `wrapper should have recorded its grandchild pid`.
 *
 * A longer timeout would only have made the race rarer, which is worse than leaving it: a test
 * guarding process cleanup that fails occasionally teaches everyone to re-run instead of look.
 *
 * The fix removes the race instead of shrinking it. **The kill is triggered by an observation,
 * not by a clock**: the test waits until it has seen the grandchild come up, and only then kills.
 * Both halves go through the exact functions the product uses — `spawnProbeChild` for the spawn
 * options (`detached` is what makes `kill(-pid)` mean anything) and `killProcessTree` for the
 * kill — so this cannot pass while the real timeout path is broken.
 *
 * The bounded waits below are readiness waits on a real precondition, not retried assertions. If
 * one runs out, the test fails and says which precondition never held.
 */
describe(
  'a probe timeout takes the whole process tree with it',
  { skip: process.platform === 'win32' ? 'POSIX process groups; Windows uses taskkill /T' : false },
  () => {
    /** Poll until `condition` holds. Returns false if it never did within `limitMs`. */
    async function until(condition: () => boolean, limitMs = 10_000): Promise<boolean> {
      const deadline = Date.now() + limitMs;
      while (Date.now() < deadline) {
        if (condition()) return true;
        await new Promise((r) => setTimeout(r, 5));
      }
      return condition();
    }

    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    it('kills the grandchild, not just the direct child', async () => {
      const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-kill-'));
      const pidFile = nodePath.join(tmp, 'grandchild.pid');
      const wrapper = nodePath.join(tmp, 'faketool');
      let child: ReturnType<typeof spawnProbeChild> | null = null;
      try {
        // A wrapper that spawns a grandchild and hangs — exactly how `claude` and friends are
        // commonly installed. Killing only the direct child leaves the `sleep` running after
        // doctor has returned. The pid is published via a rename so the test can never read a
        // half-written file: the path either does not exist or holds the complete number.
        fs.writeFileSync(
          wrapper,
          `#!/bin/sh\nsleep 120 &\necho $! > "${pidFile}.tmp"\nmv "${pidFile}.tmp" "${pidFile}"\nsleep 120\n`,
          { mode: 0o755 },
        );

        // Resolve and spawn through the product's own code path.
        const resolved = await resolveBinary(wrapper);
        assert.ok(resolved !== null, 'the fixture should resolve as an executable');
        child = spawnProbeChild(resolved, ['--version']);
        // Drain, or the pipes fill and the wrapper blocks on write instead of on sleep.
        child.stdout?.resume();
        child.stderr?.resume();

        // RENDEZVOUS. Nothing is killed until the tree we are about to assert on exists.
        const published = await until(() => fs.existsSync(pidFile));
        assert.ok(published, 'the wrapper never published its grandchild pid — fixture never ran');

        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        assert.ok(Number.isInteger(pid) && pid > 0, `bad pid: ${pid}`);
        assert.ok(await until(() => alive(pid)), `grandchild ${pid} was never alive`);

        // Only now, with the grandchild provably running, the kill under test.
        killProcessTree(child);

        // SIGKILL delivery is asynchronous, so the death is awaited rather than assumed. This is
        // waiting for an event that either happens or does not — not retrying an assertion.
        const died = await until(() => !alive(pid));
        assert.ok(died, `grandchild pid ${pid} survived killProcessTree — only the child was killed`);
      } finally {
        // Cleanup must NOT go through the function under test. When `killProcessTree` is the
        // thing that is broken, using it here would leave the fixture's `sleep` processes alive
        // holding our pipes, and a failing test would wedge the runner instead of reporting.
        if (child?.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
        }
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('wires that killer into the timeout, rather than killing only the direct child', async () => {
      const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-timeout-'));
      const wrapper = nodePath.join(tmp, 'faketool');
      try {
        // The grandchild INHERITS stdout, so it holds the pipe open. `runResolved` settles on
        // 'close', which fires only once every writer is gone:
        //   whole group killed -> close fires at once      -> `terminated by SIGKILL`
        //   only the child killed -> grandchild holds pipe -> falls through to `hard timeout`
        // So this reads the wiring off an observable outcome, with no pid and no process table.
        //
        // The grandchild sleeps 30s, not 120s: long enough that nothing plausible lets it exit
        // before the 1.4s hard backstop (so the discrimination above is real), short enough that
        // a BROKEN build reports a failure in seconds instead of wedging the runner for two
        // minutes. The unsafe direction here would be a false pass, never a false failure.
        fs.writeFileSync(wrapper, '#!/bin/sh\nsleep 30 &\necho ready\nsleep 30\n', { mode: 0o755 });

        const timeoutMs = 400;
        const result = await probe(wrapper, ['--version'], timeoutMs);

        assert.equal(result.timedOut, true, 'the probe should have timed out');
        assert.notEqual(
          result.error,
          'hard timeout',
          'the soft timeout did not clear the process tree — something still held the pipes open',
        );
        assert.match(result.error ?? '', /SIGKILL/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('closes stdin so a tool that reads it is not misreported as hung', async () => {
      const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-stdin-'));
      const wrapper = nodePath.join(tmp, 'faketool');
      try {
        // `codex exec` blocks forever on an open stdin pipe. With stdin set to
        // 'ignore' this reads EOF immediately and answers.
        fs.writeFileSync(wrapper, '#!/bin/sh\ncat >/dev/null\necho "faketool 0.9.9"\n', { mode: 0o755 });

        // The assertions below are exact outcomes, not a wall-clock threshold. `timedOut` is
        // false if and only if the tool answered before the deadline, which is the whole claim;
        // the previous `elapsed < 2000` was an arbitrary number that could only ever become a
        // second race as machines change.
        const result = await probe(wrapper, ['--version'], 3000);

        assert.equal(result.timedOut, false, 'should not have burned the timeout waiting on stdin');
        assert.equal(result.code, 0);
        assert.match(result.stdout, /0\.9\.9/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);

// ===========================================================================
// The ExperimentalWarning must not leak — and nothing else may be muted.
//
// `node:sqlite` warns on load. `army init` used to open with that warning, above
// its own header, which reads like a crash on the very first command anyone runs.
//
// The dangerous fix is a global mute. These run in a CHILD process, because the
// property is about what Node writes to a real stderr at process level, and
// because this file's own process may already have the filter installed by an
// earlier import — which would make an in-process assertion prove nothing.
// ===========================================================================

describe('node:sqlite warning containment', () => {
  /** Run a snippet with our checks module loaded, and report what reached each stream. */
  function runChild(source: string): { code: number | null; stdout: string; stderr: string } {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-warn-'));
    try {
      const file = nodePath.join(tmp, 'probe.ts');
      fs.writeFileSync(file, source, 'utf8');
      const res = spawnSync(process.execPath, [file], {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      return { code: res.status, stdout: res.stdout, stderr: res.stderr };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const checksUrl = new URL('../src/setup/checks.ts', import.meta.url).href;

  it('swallows the SQLite ExperimentalWarning entirely', () => {
    const r = runChild(
      `import { canImportSqlite } from ${JSON.stringify(checksUrl)};\n` +
        `const result = await canImportSqlite();\n` +
        `if (!result.ok) throw new Error('node:sqlite did not import: ' + result.error);\n`,
    );
    assert.equal(r.code, 0, `child failed: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning/, 'the SQLite warning reached stderr');
    assert.doesNotMatch(r.stderr, /SQLite is an experimental feature/);
    // And it must not have been redirected onto stdout either — `--json` lives there.
    assert.equal(r.stdout, '', `unexpected stdout: ${r.stdout}`);
  });

  it('still lets a DeprecationWarning through', () => {
    // The failure mode this guards is a global mute: `process.removeAllListeners('warning')`
    // with nothing put back, which silences the SQLite warning and every future warning with it.
    const r = runChild(
      `import { canImportSqlite } from ${JSON.stringify(checksUrl)};\n` +
        `await canImportSqlite();\n` +
        `process.emitWarning('shed roof is rusting', 'DeprecationWarning');\n`,
    );
    assert.equal(r.code, 0, `child failed: ${r.stderr}`);
    assert.match(r.stderr, /DeprecationWarning/);
    assert.match(r.stderr, /shed roof is rusting/);
  });

  it('still lets an UNRELATED ExperimentalWarning through', () => {
    // Matching on the warning NAME alone would swallow this one too. The filter has to key on
    // the message as well, or the next experimental feature we adopt goes silent.
    const r = runChild(
      `import { canImportSqlite } from ${JSON.stringify(checksUrl)};\n` +
        `await canImportSqlite();\n` +
        `process.emitWarning('WebSockets are experimental', 'ExperimentalWarning');\n`,
    );
    assert.equal(r.code, 0, `child failed: ${r.stderr}`);
    assert.match(r.stderr, /ExperimentalWarning/);
    assert.match(r.stderr, /WebSockets are experimental/);
  });

  it('a warning emitted BEFORE the filter is installed is untouched', () => {
    // The filter captures Node's listeners and re-invokes them. If it instead replaced them,
    // ordering would matter and this would regress silently.
    const r = runChild(
      `process.emitWarning('early bird', 'DeprecationWarning');\n` +
        `const { canImportSqlite } = await import(${JSON.stringify(checksUrl)});\n` +
        `await canImportSqlite();\n` +
        `process.emitWarning('late bird', 'DeprecationWarning');\n`,
    );
    assert.equal(r.code, 0, `child failed: ${r.stderr}`);
    assert.match(r.stderr, /early bird/);
    assert.match(r.stderr, /late bird/);
  });

  it('`init` on a clean home emits no warning at all — the reported defect', () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-init-'));
    try {
      const cli = nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.ts');
      const res = spawnSync(process.execPath, [cli, 'init', '--skip-doctor'], {
        encoding: 'utf8',
        env: { ...process.env, AGENTIC_ARMY_HOME: nodePath.join(tmp, 'home'), NODE_OPTIONS: '' },
      });
      assert.equal(res.status, 0, `init failed: ${res.stderr}`);
      assert.doesNotMatch(res.stderr, /ExperimentalWarning/);
      assert.doesNotMatch(res.stderr, /trace-warnings/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // EVERY ROUTE, not the one that was checked.
  //
  // `army doctor`'s own sqlite line promises the reader: "that warning is
  // filtered — and only that one — so it never reaches your terminal." That is
  // a claim about the PROCESS, so it is only true if every route into
  // `node:sqlite` filters. There were three, and the tests above drove one.
  //
  // The one nobody drove was `openReadOnlyDb` in `src/view/live.ts`, which
  // built its own `createRequire` and filtered nothing — so `army view
  // --source db` leaked the warning while doctor was on screen promising it
  // could not. That is the promise this describe block exists to keep, failing
  // on the very command whose output makes the promise.
  //
  // Table-driven, so adding a route means adding a row here rather than
  // remembering to. The parser guard after it is what catches the person who
  // forgets — it fails on a load site that does not filter, whether or not
  // anyone thought to add the row.
  // =========================================================================

  const liveUrl = new URL('../src/view/live.ts', import.meta.url).href;
  const dbUrl = new URL('../src/archive/db.ts', import.meta.url).href;

  /** An existing SQLite file for the read-only route, built by the parent, whose stderr is not under test. */
  function seedDb(): { file: string; cleanup: () => void } {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-ro-'));
    const file = nodePath.join(tmp, 'campaign.db');
    const db = openNodeSqliteDb(file);
    db.exec('CREATE TABLE t (a INTEGER);');
    db.close();
    return { file, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  }

  const ROUTES: ReadonlyArray<{ name: string; source: (dbFile: string) => string }> = [
    {
      name: 'canImportSqlite — `army doctor`',
      source: () =>
        `import { canImportSqlite } from ${JSON.stringify(checksUrl)};\n` +
        `const r = await canImportSqlite();\n` +
        `if (!r.ok) throw new Error(String(r.error));\n`,
    },
    {
      name: 'openNodeSqliteDb — the archive writer',
      source: (dbFile) =>
        `import { openNodeSqliteDb } from ${JSON.stringify(dbUrl)};\n` +
        `const db = openNodeSqliteDb(${JSON.stringify(dbFile)});\n` +
        `db.close();\n`,
    },
    {
      name: 'openReadOnlyDb — `army view --source db`',
      source: (dbFile) =>
        `import { openReadOnlyDb } from ${JSON.stringify(liveUrl)};\n` +
        `const db = openReadOnlyDb(${JSON.stringify(dbFile)});\n` +
        `db.close();\n`,
    },
  ];

  for (const route of ROUTES) {
    it(`route is silent: ${route.name}`, () => {
      const seeded = seedDb();
      try {
        const r = runChild(route.source(seeded.file));
        assert.equal(r.code, 0, `child failed: ${r.stderr}`);
        assert.doesNotMatch(
          r.stderr,
          /ExperimentalWarning/,
          `${route.name} leaked the SQLite warning that doctor promises is filtered:\n${r.stderr}`,
        );
        assert.doesNotMatch(r.stderr, /SQLite is an experimental feature/);
        assert.equal(r.stdout, '', `unexpected stdout: ${r.stdout}`);
      } finally {
        seeded.cleanup();
      }
    });

    it(`route still lets other warnings through: ${route.name}`, () => {
      // The cheap way to pass the test above is a global mute, and a global mute is a worse bug
      // than the leak — it hides the next deprecation from everyone. Paired with every route, so
      // a fourth route cannot buy silence with `removeAllListeners`.
      const seeded = seedDb();
      try {
        const r = runChild(
          `${route.source(seeded.file)}process.emitWarning('shed roof is rusting', 'DeprecationWarning');\n`,
        );
        assert.equal(r.code, 0, `child failed: ${r.stderr}`);
        assert.match(r.stderr, /shed roof is rusting/, `${route.name} muted an unrelated warning`);
      } finally {
        seeded.cleanup();
      }
    });
  }

  /**
   * The rows above are a list someone has to maintain. This is the guard that does not need one.
   *
   * It parses every source under `src/` and finds each place `node:sqlite` is actually LOADED —
   * `require('node:sqlite')` or `import('node:sqlite')`, matched on the syntax tree rather than
   * by grep so a mention in a comment or a doc block is not a hit and a load spread over two
   * lines still is. Every module holding one must also call `installWarningFilter`.
   *
   * This is the assertion that was missing. The leak did not ship because someone disagreed about
   * whether the warning should be filtered; it shipped because a third load site was added and
   * nothing in the suite knew to look at it.
   */
  it('every module that loads node:sqlite installs the filter', () => {
    const srcRoot = nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), '..', 'src');

    const filesUnder = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(full);
        return entry.name.endsWith('.ts') ? [full] : [];
      });

    /** Loads of `node:sqlite`, and calls to the filter, as the parser sees them. */
    function inspect(source: ts.SourceFile): { loads: number[]; filters: number } {
      const loads: number[] = [];
      let filters = 0;
      const lineOf = (node: ts.Node): number =>
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const [arg] = node.arguments;
          if (
            arg !== undefined &&
            ts.isStringLiteralLike(arg) &&
            arg.text === 'node:sqlite'
          ) {
            loads.push(lineOf(node));
          }
          if (ts.isIdentifier(node.expression) && node.expression.text === 'installWarningFilter') {
            filters += 1;
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(source);
      return { loads, filters };
    }

    const offenders: string[] = [];
    let loadSites = 0;
    for (const file of filesUnder(srcRoot)) {
      const parsed = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const { loads, filters } = inspect(parsed);
      loadSites += loads.length;
      if (loads.length > 0 && filters === 0) {
        const rel = nodePath.relative(nodePath.join(srcRoot, '..'), file);
        offenders.push(`${rel}:${loads.join(',')} loads node:sqlite without calling installWarningFilter`);
      }
    }

    // PINNED. A guard that silently finds nothing is a guard that has stopped guarding, and a
    // refactor that renames the specifier is exactly how that happens quietly.
    assert.ok(
      loadSites >= 3,
      `expected at least the three known node:sqlite load sites, found ${loadSites} — the detector has gone blind`,
    );
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });
});

// ===========================================================================
// A printed command must mean what it reads as — asked of a real shell.
//
// `checks.ts` used to render paths through a `quoteIfNeeded` that wrapped them
// in DOUBLE quotes. Inside double quotes POSIX still expands `$`, still runs a
// backtick and still eats a `\`, so `mkdir -p "<dir>"` for a home containing
// any of those is a line that reads as one directory and creates another —
// inside a command doctor invites the reader to paste, and whose sibling in
// `classifyStaleWorktreePool` ends in `rm -rf`.
//
// A unit test comparing strings cannot settle this. The disagreement is
// between our idea of quoting and the SHELL's, so the shell is the one asked:
// every case below goes through a real `/bin/sh`, and the assertion is on what
// the filesystem looks like afterwards.
// ===========================================================================

describe(
  'runs through a real /bin/sh',
  { skip: process.platform === 'win32' ? 'POSIX shell quoting; cmd.exe is a different grammar' : false },
  () => {
    /** Hand `sh` one quoted word and ask what it made of it. Nothing is executed but `printf`. */
    function wordFromShell(quoted: string): string {
      const res = spawnSync('/bin/sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
      assert.equal(res.status, 0, `sh refused the line \`printf '%s' ${quoted}\`: ${res.stderr}`);
      return res.stdout;
    }

    /**
     * Names that separate "quoted" from "quoted correctly".
     *
     * Each one is a real thing a directory can be called and each one is rewritten by a shell if
     * it is wrapped in double quotes: `$` interpolates, a backtick substitutes a command, `\`
     * escapes the next character, and `!` is history expansion in an interactive shell.
     */
    const NASTY = [
      'plain',
      '/tmp/a b',
      '/tmp/$HOME',
      '/tmp/`id`',
      '/tmp/a\\b',
      '/tmp/"double"',
      "/tmp/it's",
      '/tmp/$(id) `id` "q" \\ ! & ; | > <',
      '/tmp/a b $USER `hostname`',
    ];

    for (const value of NASTY) {
      it(`sh reads back exactly what we quoted: ${JSON.stringify(value)}`, () => {
        assert.equal(wordFromShell(quoteArg(value, 'linux')), value);
      });
    }

    it('the OLD double-quote rendering is one the shell disagrees with', () => {
      // The control. Without this the suite could pass while `quoteArg` had quietly become the
      // broken version again and every "correct" assertion above was measuring nothing.
      const doubled = (v: string): string => (/[\s"']/.test(v) ? `"${v}"` : v);
      const victim = '/tmp/$HOME `id` dir';
      assert.notEqual(
        wordFromShell(doubled(victim)),
        victim,
        'the old renderer survived a real shell — then this whole section proves nothing',
      );
      assert.equal(wordFromShell(quoteArg(victim, 'linux')), victim);
    });

    /**
     * The end-to-end claim, on the one fix doctor prints that WRITES.
     *
     * The line is generated by `classifyHome` exactly as `army doctor` prints it, executed by
     * `/bin/sh` exactly as pasting it would, and then the filesystem is asked whether the
     * directory that appeared is the directory that was on screen.
     */
    it('doctor’s `mkdir` fix creates the directory it displays, and only that one', () => {
      const parent = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-quote-'));
      try {
        // `$`, a backtick and a space, as required — plus the `HOME` and `id` that make an
        // unquoted or double-quoted rendering land somewhere else entirely.
        const dir = nodePath.join(parent, 'war $HOME `id` archive');

        const result = classifyHome({
          dir,
          exists: true,
          writable: false,
          creatable: false,
          error: null,
        });
        assert.equal(result.outcome, 'blocking');
        const fix = result.fix;
        assert.ok(typeof fix === 'string' && fix.length > 0, 'the blocking home check must offer a fix');

        // The directory is displayed to the reader inside this line. Read it out of the line
        // itself, so what is asserted is what a person would have seen.
        assert.ok(fix.includes(dir), `the fix does not contain the path it is about:\n${fix}`);

        const res = spawnSync('/bin/sh', ['-c', fix], { encoding: 'utf8' });
        assert.equal(res.status, 0, `the fix doctor printed failed in a real shell:\n${fix}\n${res.stderr}`);

        assert.ok(
          fs.statSync(dir).isDirectory(),
          `the fix ran but did not create the directory it named:\n${fix}`,
        );
        // And nothing ELSE appeared. An expanded `$HOME` or an executed backtick shows up as a
        // second, differently-named entry — the failure mode the string assertions cannot see.
        assert.deepEqual(
          fs.readdirSync(parent),
          ['war $HOME `id` archive'],
          'the shell created something other than, or as well as, the displayed directory',
        );
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });

    it('the `mv` branch moves the blocker it names, not a path the shell invented', () => {
      const parent = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-quote-mv-'));
      try {
        const blocker = nodePath.join(parent, 'a $USER `id` file');
        const dir = nodePath.join(blocker, 'home');
        fs.writeFileSync(blocker, 'not a directory', 'utf8');

        const fix = classifyHome({
          dir,
          exists: false,
          writable: false,
          creatable: false,
          error: null,
          blockedBy: blocker,
        }).fix;
        assert.ok(typeof fix === 'string');

        const res = spawnSync('/bin/sh', ['-c', fix], { encoding: 'utf8' });
        assert.equal(res.status, 0, `the fix failed in a real shell:\n${fix}\n${res.stderr}`);

        // `.bak` holds the original bytes — proof `mv` was pointed at the file that was named,
        // and that the `.bak` safety argument survives a name the shell would rewrite.
        assert.equal(fs.readFileSync(`${blocker}.bak`, 'utf8'), 'not a directory');
        assert.ok(fs.statSync(dir).isDirectory(), 'the home was not created after the blocker moved');
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });

    it('the stale-pool fix names the trees it displays, through the shell', () => {
      // This fix ends in `rm -rf`, so it is NOT executed. What is checked is the part that makes
      // running it safe: the shell must split the line into exactly the words doctor displayed.
      const dir = '/tmp/army $HOME `id` pool';
      const tree = `${dir}/trees/app-1/wt-01`;
      const fix = classifyStaleWorktreePool({ dir, exists: true, trees: [tree], repos: [] }).fix;
      assert.ok(typeof fix === 'string');

      const args = fix.split(' && ');
      assert.equal(args.length, 2, fix);
      assert.equal(wordFromShell((args[0] as string).replace('git worktree remove ', '')), tree);
      assert.equal(wordFromShell((args[1] as string).replace('rm -rf ', '')), dir);
    });
  },
);

// ===========================================================================
// Never print a command the reader cannot run.
// ===========================================================================

describe('detectInvocation', () => {
  // A fully synthetic context: no PATH lookup, no filesystem, no ambient npm variables. Every
  // branch is reachable from any machine, including the Windows ones none of us have.
  const base = {
    cwd: '/work/agentic-army',
    platform: 'linux' as NodeJS.Platform,
    env: {} as NodeJS.ProcessEnv,
    resolve: () => null,
    realpath: (p: string) => p,
  };

  it('uses `army` when the bin on PATH is this very install', () => {
    const r = detectInvocation({
      ...base,
      argv1: '/usr/lib/node_modules/agentic-army/dist/cli.js',
      resolve: () => '/usr/bin/army',
      // POSIX npm links bins with a symlink, so both realpath to the same file.
      realpath: () => '/usr/lib/node_modules/agentic-army/dist/cli.js',
    });
    assert.equal(r.form, 'army');
    assert.equal(r.command, BIN_NAME);
  });

  it('uses `army` on Windows, where a .cmd shim cannot be realpath-matched', () => {
    const r = detectInvocation({
      ...base,
      platform: 'win32',
      argv1: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\agentic-army\\dist\\cli.js',
      cwd: 'C:\\work',
      resolve: () => 'C:\\Users\\x\\AppData\\Roaming\\npm\\army.cmd',
      realpath: (p: string) => p, // shims never match, which is exactly the case being covered
    });
    assert.equal(r.form, 'army');
    assert.equal(r.command, BIN_NAME);
  });

  it('uses `npx agentic-army` when running out of the npx cache', () => {
    const r = detectInvocation({
      ...base,
      argv1: '/home/u/.npm/_npx/2f3a/node_modules/agentic-army/dist/cli.js',
    });
    assert.equal(r.form, 'npx');
    assert.equal(r.command, `npx ${PACKAGE_NAME}`);
  });

  it('uses npx when npm says so, even without the cache path', () => {
    const r = detectInvocation({
      ...base,
      argv1: '/tmp/somewhere/dist/cli.js',
      env: { npm_command: 'exec' },
    });
    assert.equal(r.form, 'npx');
  });

  it('prefers npx over a global `army` that is a DIFFERENT install', () => {
    // `npx agentic-army@x` deliberately runs a version other than the installed one. Telling the
    // reader to type `army` would silently send them to the other binary.
    const r = detectInvocation({
      ...base,
      argv1: '/home/u/.npm/_npx/2f3a/node_modules/agentic-army/dist/cli.js',
      resolve: () => '/usr/bin/army',
      realpath: (p: string) => p,
    });
    assert.equal(r.form, 'npx');
  });

  it('uses the npm script form when it is running as one', () => {
    const r = detectInvocation({
      ...base,
      argv1: '/work/agentic-army/src/cli.ts',
      env: { npm_lifecycle_event: 'dev', npm_lifecycle_script: 'node src/cli.ts' },
    });
    assert.equal(r.form, 'npm-script');
    assert.equal(r.command, 'npm run dev --');
  });

  it('names the right package manager', () => {
    for (const [agent, expected] of [
      ['pnpm/9.1.0 npm/? node/v24.0.0', 'pnpm run dev --'],
      ['yarn/1.22.22 npm/? node/v24.0.0', 'yarn run dev --'],
      ['npm/10.8.0 node/v24.0.0', 'npm run dev --'],
    ] as Array<[string, string]>) {
      const r = detectInvocation({
        ...base,
        argv1: '/work/agentic-army/src/cli.ts',
        env: {
          npm_lifecycle_event: 'dev',
          npm_lifecycle_script: 'node src/cli.ts',
          npm_config_user_agent: agent,
        },
      });
      assert.equal(r.command, expected);
    }
  });

  it('does NOT claim the npm script form when the script is not us', () => {
    // npm_lifecycle_event is inherited by every descendant. A `node src/cli.ts init` invoked
    // from inside `npm run build` must not be told to re-run itself as `npm run build --`.
    const r = detectInvocation({
      ...base,
      argv1: '/work/agentic-army/src/cli.ts',
      env: { npm_lifecycle_event: 'build', npm_lifecycle_script: 'tsc -p tsconfig.build.json' },
    });
    assert.equal(r.form, 'node-script');
    assert.equal(r.command, 'node src/cli.ts');
  });

  it('echoes back `node src/cli.ts` for a plain checkout — the reported defect', () => {
    const r = detectInvocation({ ...base, argv1: '/work/agentic-army/src/cli.ts' });
    assert.equal(r.form, 'node-script');
    assert.equal(r.command, 'node src/cli.ts');
  });

  it('falls back to an absolute path when the script is outside the working directory', () => {
    const r = detectInvocation({ ...base, cwd: '/elsewhere', argv1: '/work/agentic-army/src/cli.ts' });
    assert.equal(r.command, 'node /work/agentic-army/src/cli.ts');
  });

  it('quotes a path containing spaces so the suggestion can be pasted', () => {
    const r = detectInvocation({ ...base, cwd: '/elsewhere', argv1: '/My Code/army/src/cli.ts' });
    // SINGLE quotes, not double. This used to demand `"…"`, which is right only for a path whose
    // only problem is whitespace; the moment the path also holds a `$` or a backtick, double
    // quotes let the shell rewrite it. The case below is the one that made the difference visible,
    // and `runs through a real /bin/sh` proves it against the shell rather than against a string.
    assert.equal(r.command, "node '/My Code/army/src/cli.ts'");
  });

  it('quotes a path the shell would otherwise expand — `$`, backtick, backslash', () => {
    const r = detectInvocation({
      ...base,
      cwd: '/elsewhere',
      argv1: '/work/$HOME `id` \\x/src/cli.ts',
    });
    // Whatever the quoting, the payload must survive verbatim inside it. Under the old
    // double-quoting this line read `node "/work/$HOME `id` \x/src/cli.ts"`, which a shell turns
    // into a different path AND a command substitution.
    assert.equal(r.command, "node '/work/$HOME `id` \\x/src/cli.ts'");
  });

  it('ignores an `army` on PATH that is some other program entirely', () => {
    // A checkout, plus an unrelated binary called `army`. Not the dangerous shape — see below.
    const r = detectInvocation({
      ...base,
      argv1: '/work/agentic-army/src/cli.ts',
      resolve: () => '/usr/bin/army',
      realpath: (p: string) => p,
    });
    assert.equal(r.form, 'node-script');
    assert.equal(r.command, 'node /work/agentic-army/src/cli.ts');
  });

  // =========================================================================================
  // The dangerous shape: WE are an installed copy, and someone ELSE owns `army` on PATH.
  //
  // The previous version of this suite believed it covered this and did not: every case it drove
  // used a checkout path for argv[1], so the installed-copy branch — the only one that printed a
  // bare `army` on the strength of the NAME alone — was never entered. Suggesting `army` here
  // does not fail; it silently runs a different program than the one that printed the line.
  // =========================================================================================
  const INSTALLED = '/usr/local/lib/node_modules/agentic-army/dist/cli.js';

  it('refuses `army` when an installed copy is shadowed by a FOREIGN binary of that name', () => {
    const r = detectInvocation({
      ...base,
      cwd: '/home/u',
      argv1: INSTALLED,
      // A stale global from another prefix, earlier on PATH. Different file, different package.
      resolve: () => '/opt/someone-else/bin/army',
      realpath: (p: string) => p,
    });
    assert.notEqual(r.form, 'army');
    assert.notEqual(r.command, 'army');
    assert.equal(r.command, `node ${INSTALLED}`);
    assert.match(r.reason, /different army|owns that name/i);
  });

  it('still says `army` when the PATH shim symlinks to this very install', () => {
    const r = detectInvocation({
      ...base,
      argv1: INSTALLED,
      resolve: () => '/usr/local/bin/army',
      // npm links bins with a symlink on POSIX: realpath collapses shim and target to one file.
      realpath: (p: string) => (p === '/usr/local/bin/army' ? INSTALLED : p),
    });
    assert.equal(r.form, 'army');
    assert.equal(r.command, 'army');
  });

  it('says `army` when the launcher is a COPY inside our own package directory', () => {
    const r = detectInvocation({
      ...base,
      argv1: INSTALLED,
      resolve: () => '/usr/local/lib/node_modules/agentic-army/bin/army',
      realpath: (p: string) => p,
    });
    assert.equal(r.form, 'army');
  });

  it('matches case-insensitively on macOS, where two spellings are one file', () => {
    // Compare identities, not spellings. `realpath` does not normalise case, and darwin is
    // case-insensitive, so a string compare would call this install a stranger and print a
    // needless absolute path.
    const r = detectInvocation({
      ...base,
      platform: 'darwin',
      argv1: INSTALLED,
      resolve: () => '/usr/local/bin/army',
      realpath: (p: string) =>
        p === '/usr/local/bin/army' ? INSTALLED.toUpperCase() : p,
    });
    assert.equal(r.form, 'army');
  });

  it('says `army` on Windows when the .cmd shim sits in this install prefix', () => {
    const script = 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\agentic-army\\dist\\cli.js';
    const r = detectInvocation({
      ...base,
      platform: 'win32',
      cwd: 'C:\\work',
      argv1: script,
      resolve: () => 'C:\\Users\\x\\AppData\\Roaming\\npm\\army.cmd',
      realpath: (p: string) => p, // a batch shim cannot be realpathed to its target
    });
    assert.equal(r.form, 'army');
  });

  it('refuses `army` on Windows when the shim belongs to a DIFFERENT prefix', () => {
    // Same evidence shape as the passing Windows case, opposite answer. Without this, the
    // win32 branch would be a blanket "any army will do" and the finding would only be half fixed.
    const script = 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\agentic-army\\dist\\cli.js';
    const r = detectInvocation({
      ...base,
      platform: 'win32',
      cwd: 'C:\\work',
      argv1: script,
      resolve: () => 'C:\\Tools\\other\\army.cmd',
      realpath: (p: string) => p,
    });
    assert.notEqual(r.form, 'army');
    assert.match(r.command, /cli\.js/);
  });

  it('never returns an empty command', () => {
    for (const argv1 of [undefined, '', '/x/cli.js', '/work/agentic-army/src/cli.ts']) {
      const r = detectInvocation({ ...base, argv1 });
      assert.ok(r.command.trim().length > 0);
      assert.ok(r.reason.length > 0);
    }
  });
});

// ===========================================================================
// WHAT COUNTS AS A COMMAND — READ, NOT RETYPED
//
// Two guards below have to know which words after `army` mean "something to
// type": the subprocess check on the CLI's own output, and the repo-wide scan
// of every string in `src/**`. Both spelled the set out by hand as
// `doctor|init|enlist|campaign|view|rebuild`, and both went stale the moment a
// seventh command landed. `chat` shipped; neither list heard about it; a
// hardcoded `army chat …` in a printed string would have walked through the
// pair of them without a sound. A guard that enumerates by hand goes stale the
// day the thing it guards grows, and it fails OPEN — silently widening the
// hole it exists to close.
//
// So the set is read from the file that dispatches on it. `src/cli.ts` cannot
// be imported: its last statement runs `run(process.argv.slice(2))` at the top
// level, so importing it from a test would execute the CLI against the test
// runner's own argv and set a failing `process.exitCode` for the whole suite.
// It is parsed instead — with the same TypeScript parser the source guard
// already uses, and for the same reason: only the syntax tree can tell a
// registry from a paragraph about one.
//
// Three sources, unioned, so a command cannot hide in any of them: the keys of
// `COMMAND_HELP`, the members of `SELF_DOCUMENTING`, and the `case` labels of
// the switch in `run()`. The reading is then checked against the CLI's own
// `commands:` line at runtime (see `an unknown command names the commands that
// DO exist`), so a mistake here cannot quietly shrink either guard.
// ===========================================================================

const CLI_SOURCE = nodePath.join(
  nodePath.dirname(new URL(import.meta.url).pathname),
  '..',
  'src',
  'cli.ts',
);

type CliRegistries = {
  /** Keys of `COMMAND_HELP` — the commands whose help text `src/cli.ts` owns. */
  help: string[];
  /** Members of `SELF_DOCUMENTING` — the commands that carry their own `--help`. */
  selfDocumenting: string[];
  /** `case '…':` in `run()`'s switch — what the file actually dispatches on. */
  dispatched: string[];
};

function readCliRegistries(file: string): CliRegistries {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  const found: CliRegistries = { help: [], selfDocumenting: [], dispatched: [] };

  /** Every string literal under a node — how `new Set([...])` gives up its members. */
  const stringsUnder = (node: ts.Node | undefined): string[] => {
    const out: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isStringLiteralLike(n)) out.push(n.text);
      ts.forEachChild(n, walk);
    };
    if (node !== undefined) walk(node);
    return out;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'COMMAND_HELP') {
        const init = node.initializer;
        if (init !== undefined && ts.isObjectLiteralExpression(init)) {
          for (const property of init.properties) {
            const name = property.name;
            if (name === undefined) continue;
            if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) found.help.push(name.text);
          }
        }
      }
      if (node.name.text === 'SELF_DOCUMENTING') {
        found.selfDocumenting.push(...stringsUnder(node.initializer));
      }
    }
    if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)) {
      found.dispatched.push(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const CLI_REGISTRIES = readCliRegistries(CLI_SOURCE);

/** Every command `src/cli.ts` documents or routes. Sorted, so comparisons are order-free. */
const CLI_COMMANDS = [
  ...new Set([
    ...CLI_REGISTRIES.help,
    ...CLI_REGISTRIES.selfDocumenting,
    ...CLI_REGISTRIES.dispatched,
  ]),
].sort();

/**
 * A command name, or a global flag: the words that make what precedes them an instruction.
 *
 * Longest first, so `--help` is never half-matched by `-h` sitting earlier in the alternation.
 */
const COMMAND_WORDS = [...CLI_COMMANDS, 'help', '--help', '--version', '-h', '-v'].sort(
  (a, b) => b.length - a.length,
);

describe('the command set both guards use is read from src/cli.ts, not typed out', () => {
  it('finds both registries and the switch', () => {
    assert.ok(
      CLI_REGISTRIES.help.length >= 4,
      `COMMAND_HELP was not read: ${JSON.stringify(CLI_REGISTRIES.help)}`,
    );
    assert.ok(
      CLI_REGISTRIES.selfDocumenting.length >= 3,
      `SELF_DOCUMENTING was not read: ${JSON.stringify(CLI_REGISTRIES.selfDocumenting)}`,
    );
    assert.ok(
      CLI_REGISTRIES.dispatched.length >= 7,
      `run()'s switch was not read: ${JSON.stringify(CLI_REGISTRIES.dispatched)}`,
    );
  });

  it('the two registries and the switch describe the same set of commands', () => {
    // Not a restatement of the line above. A command routed by the switch but in neither
    // registry has no `--help` at all, and one in a registry that the switch never reaches is
    // documented and unreachable. Either is a defect, and either would also mean the derived
    // set is bigger than what the CLI can actually be asked to do.
    assert.deepEqual(
      [...CLI_REGISTRIES.help, ...CLI_REGISTRIES.selfDocumenting].sort(),
      [...CLI_REGISTRIES.dispatched].sort(),
    );
  });

  it('grows with the file — `chat` is in it, and it was in neither hand-written list', () => {
    assert.ok(
      CLI_COMMANDS.includes('chat'),
      `the derived set missed a command src/cli.ts routes: ${JSON.stringify(CLI_COMMANDS)}`,
    );
  });
});

// ===========================================================================
// TWO MACHINES, BOTH BUILT BY THE TEST
//
// These are the only tests in this file that drive the real CLI as a child
// process, and they are where hermeticity was quietly lost. `invokedAs()` asks
// what `army` resolves to on PATH, and the child inherited the developer's. On
// a machine where this checkout has been `npm link`ed, the global `army`
// resolves to `dist/cli.js` — provably NOT the `src/cli.ts` now executing — so
// the CLI correctly refused to advertise a bare `army` and printed an
// unambiguous absolute path instead. Five assertions here demanded the literal
// `node src/cli.ts` and failed. The product was right; the tests were reading
// the laptop, and they only ever passed on a laptop with nothing installed.
//
// This repo has already paid for an ambient test once: `npm test` used to
// execute the developer's real `~/.agentic-army` hooks, 31 times a run.
//
// So the child's PATH is CONSTRUCTED, and both answers are exercised on
// purpose rather than one of them being whatever the machine happened to say:
//
//   CHECKOUT   nothing named `army` on PATH at all. The reader typed
//              `node src/cli.ts`; that is what has to come back.
//   INSTALLED  an `army` on PATH that symlinks to the very script running —
//              the shape `npm i -g` and `npm link` leave behind. Here `army`
//              is the correct answer and printing a path would be the defect.
//
// Neither was covered deliberately before: one was ambient, the other absent.
// ===========================================================================

describe('no command suggests a binary the reader may not have', () => {
  const repoRoot = nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), '..');

  /** Everything the child process is allowed to know about the machine it is running on. */
  type World = {
    /** Reads as the machine, in test titles. */
    name: string;
    /** Which of `FORMS` is correct here — the one form every printed command must use. */
    form: string;
    /** The exact prefix the CLI must print. */
    self: string;
    /** argv[1] for the child: the script this reader's `node` is pointed at. */
    script: string;
    /** The ONLY directory on the child's PATH. */
    binDir: string;
  };

  const roots: string[] = [];
  function scratch(tag: string): string {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `army-${tag}-`));
    roots.push(root);
    return root;
  }
  after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * A PATH holding exactly what this world's reader has, and nothing else.
   *
   * `node` is always on it: every suggestion in the CHECKOUT world begins with it, and the tests
   * below RUN what the CLI printed rather than take its word for it.
   */
  function binDirWith(root: string, army: string | null): string {
    const bin = nodePath.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(process.execPath, nodePath.join(bin, 'node'));
    if (army !== null) fs.symlinkSync(army, nodePath.join(bin, BIN_NAME));
    return bin;
  }

  const checkout: World = (() => {
    const root = scratch('checkout');
    return {
      name: 'a checkout with nothing installed',
      form: 'node <script>',
      // `cwd` is the repo, so `detectInvocation` shortens the script to the relative form — the
      // one that survives being pasted back into the same shell.
      self: `node ${nodePath.join('src', 'cli.ts')}`,
      script: nodePath.join(repoRoot, 'src', 'cli.ts'),
      binDir: binDirWith(root, null),
    };
  })();

  const installed: World = (() => {
    const root = scratch('installed');
    /*
     * What a global install actually leaves behind: a launcher on PATH that is a SYMLINK to the
     * script it runs, so `realpath` collapses the two to one file. That identity — not the name
     * `army` — is the whole of what `isSameInstall` accepts.
     *
     * The launcher cannot be a symlink straight to `src/cli.ts`: PATH resolution requires an
     * executable file and a checked-out source file is mode 644. Nor can it be a shell shim,
     * because a shim is a DIFFERENT file from the script and would be classified — correctly —
     * as a foreign `army`. So it is a two-line entry point that imports the real CLI, and the
     * PATH entry symlinks to that. The child is `node <entry>`; the PATH `army` is the same
     * file; the CLI underneath is the same code the other world runs.
     */
    const entry = nodePath.join(root, 'cli.mjs');
    fs.writeFileSync(
      entry,
      `#!/usr/bin/env node\nimport ${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)};\n`,
      'utf8',
    );
    fs.chmodSync(entry, 0o755);
    return {
      name: 'a global install of this very checkout',
      form: BIN_NAME,
      self: BIN_NAME,
      script: entry,
      binDir: binDirWith(root, entry),
    };
  })();

  const WORLDS = [checkout, installed];

  /**
   * The child's whole environment, built rather than inherited.
   *
   * Nothing from this shell reaches it. Not PATH, which is the point. Not the `npm_lifecycle_*`
   * pair that `npm test` exports and that would otherwise have the CLI report the npm-script
   * form under `npm test` and the node-script form under a bare `node --test`. And not HOME:
   * `~/.agentic-army` is the developer's real archive and no test may go near it.
   */
  function envFor(world: World, home: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: world.binDir,
      HOME: home,
      TMPDIR: home,
      AGENTIC_ARMY_HOME: nodePath.join(home, 'archive'),
    };
    if (process.platform === 'win32') {
      // Windows cannot start a process without these, and PATHEXT is how a bin is found there.
      for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
    }
    return env;
  }

  type Run = { code: number | null; out: string; err: string };

  function runIn(world: World, exe: string, argv: string[]): Run {
    const res = spawnSync(exe, argv, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: envFor(world, scratch('home')),
    });
    return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
  }

  /** Drive the CLI the way this world's reader has it installed. */
  function cli(world: World, args: string[]): Run {
    return runIn(world, process.execPath, [world.script, ...args]);
  }

  /**
   * A printed command line, back into argv.
   *
   * `checks.ts` now renders through `quoteArg`, which emits SINGLE quotes on POSIX, so this is the
   * inverse of that. It used to only understand double quotes, which is what `quoteIfNeeded`
   * emitted — and it would have silently split `'/My Code/cli.ts'` into two argv entries the day
   * the emitter changed, i.e. it agreed with the emitter's bug rather than with a shell.
   *
   * It is still a hand-rolled parser and therefore still only evidence about THIS suite's idea of
   * quoting. The claim that the printed line means what it reads as is settled by handing it to a
   * real `/bin/sh` — see `runs through a real /bin/sh` further down this file.
   */
  function argvOf(printed: string): string[] {
    const tokens = printed.match(/'(?:[^']|'\\'')*'|"[^"]*"|\S+/g) ?? [];
    return tokens.map((token) =>
      token.startsWith("'") && token.endsWith("'") && token.length >= 2
        ? token.slice(1, -1).replaceAll(`'\\''`, "'")
        : token.replace(/^"(.*)"$/, '$1'),
    );
  }

  /**
   * Type what the CLI told the reader to type, and see whether it runs.
   *
   * The old assertion said `USAGE is not runnable` and checked a SPELLING — it never ran
   * anything, and the spelling it demanded was only correct on a machine with no global install.
   * Both halves are done properly here: the first word is resolved against the READER's PATH,
   * which is what typing it does, and then the resolved program is executed.
   */
  function runsAsPrinted(world: World, printed: string, extra: string[]): Run {
    const argv = argvOf(printed);
    const head = argv[0] ?? '';
    const exe = resolveBinarySync(head, { PATH: world.binDir }, process.platform);
    assert.ok(exe !== null, `\`${head}\` does not resolve on this reader's PATH: ${printed}`);
    return runIn(world, exe, [...argv.slice(1), ...extra]);
  }

  /**
   * The invocation forms this CLI can print. Exactly one of them is right on a given machine.
   *
   * The command words come from `CLI_COMMANDS`, which is read out of `src/cli.ts` — the hand
   * enumeration that used to sit here listed six of the seven.
   */
  const FORMS: ReadonlyArray<{ label: string; head: string }> = [
    { label: BIN_NAME, head: BIN_NAME },
    { label: 'node <script>', head: String.raw`node\s+(?:"[^"]*cli\.ts"|\S*cli\.ts)` },
  ];

  /** The one form legal in every world: a heading, which NAMES the command. */
  const HEADING_ONLY = /^army [a-z]+ — /;

  function mentionsACommand(head: string): RegExp {
    return new RegExp(`(^|[^\\w./@-])(?:${head})(:|\\s+(?:${COMMAND_WORDS.join('|')})(?![\\w-]))`);
  }

  /**
   * Every line that names a command names it in THIS reader's form.
   *
   * The predecessor could only say "not `army`", which is half the property — and the half that
   * happens to hold on a laptop with nothing installed. On a machine where `army` IS this
   * install, `army` is the right answer and a hardcoded `node src/cli.ts` is the defect. Stated
   * as what it always meant, it holds in both directions: no form the reader did not invoke.
   */
  function assertOwnFormOnly(world: World, text: string, what: string): void {
    const offenders: string[] = [];
    for (const line of text.split('\n')) {
      if (HEADING_ONLY.test(line.trim())) continue;
      for (const form of FORMS) {
        if (form.label !== world.form && mentionsACommand(form.head).test(line)) {
          offenders.push(`${form.label}  ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${what} names a command in a form this reader cannot run (expected \`${world.self}\`):\n${text}`,
    );
  }

  /** The part of a USAGE line a reader can paste: everything before the first placeholder. */
  function pasteableUsage(text: string, what: string): string {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.trim() === 'USAGE');
    assert.ok(at >= 0, `${what} has no USAGE section:\n${text}`);
    const usage = lines.slice(at + 1).find((line) => line.trim() !== '');
    assert.ok(usage !== undefined, `${what} has an empty USAGE section:\n${text}`);
    return usage.trim().replace(/\s+(?:[[<]|"<).*$/, '');
  }

  for (const world of WORLDS) {
    describe(world.name, () => {
      it('is the machine this test built, not the one the suite is running on', () => {
        // The whole reason the five failures below were possible. Assert the constructed PATH
        // says what the test decided it says, BEFORE trusting anything the child prints.
        const found = resolveBinarySync(BIN_NAME, { PATH: world.binDir }, process.platform);
        if (world.form === BIN_NAME) {
          assert.ok(found !== null, `no ${BIN_NAME} on the PATH this world constructed`);
          assert.equal(
            fs.realpathSync(found),
            fs.realpathSync(world.script),
            `the ${BIN_NAME} on PATH is not the script under test, so this is the wrong world`,
          );
        } else {
          assert.equal(found, null, `an ${BIN_NAME} leaked onto the constructed PATH: ${String(found)}`);
        }

        // And whatever the CLI is about to call itself, that thing runs.
        const r = runsAsPrinted(world, world.self, ['--version']);
        assert.equal(r.code, 0, `\`${world.self} --version\` did not run: ${r.err}`);
        assert.match(r.out, /^\d+\.\d+\.\d+/);
      });

      it('`init` suggests the next step in the reader’s own form', () => {
        const r = cli(world, ['init', '--skip-doctor']);
        assert.equal(r.code, 0, `init failed: ${r.err}`);
        assert.ok(
          r.out.includes(`${world.self} enlist`),
          `init does not offer a runnable \`enlist\`:\n${r.out}`,
        );
        assertOwnFormOnly(world, r.out, 'init');
      });

      it('an unknown command names the commands that DO exist, in the reader’s own form', () => {
        const r = cli(world, ['frobnicate']);
        assert.equal(r.code, 1);
        assert.match(r.err, /unknown command "frobnicate"/);
        assert.ok(
          r.err.split('\n').some((line) => line.startsWith(`${world.self}: `)),
          `reported as something else:\n${r.err}`,
        );
        assert.ok(r.err.includes(`Try \`${world.self} --help\``), `no next step:\n${r.err}`);
        // "You are wrong" and nothing about being right is half an error message. This is also
        // where the parsed registries meet reality: the set read out of `src/cli.ts` and the set
        // the running CLI advertises have to be the same set, or one of the two guards below is
        // quietly guarding a stale list.
        const listed = /^\s*commands: (.+)$/m.exec(r.err)?.[1]?.split(', ') ?? [];
        assert.deepEqual(
          [...listed].sort(),
          CLI_COMMANDS,
          `the unknown-command error and src/cli.ts disagree about what exists:\n${r.err}`,
        );
        assertOwnFormOnly(world, r.err, 'the unknown-command error');
      });

      it('an unknown top-level OPTION routes too', () => {
        const r = cli(world, ['--nope']);
        assert.equal(r.code, 1);
        assert.match(r.err, /unknown option --nope/);
        assert.ok(r.err.includes(`Try \`${world.self} --help\``), `no next step:\n${r.err}`);
        assertOwnFormOnly(world, r.err, 'the unknown-option error');
      });

      it('every `rebuild` parse error routes, and each one says what to try', () => {
        for (const [args, expected] of [
          [['rebuild', '--archive'], /--archive expects a path/],
          [['rebuild', '--nope'], /unknown option --nope/],
          [['rebuild', 'a', 'b'], /unexpected argument "b"/],
        ] as Array<[string[], RegExp]>) {
          const r = cli(world, args);
          assert.equal(r.code, 1, `${args.join(' ')} did not fail: ${r.out}`);
          assert.match(r.err, expected);
          assert.ok(
            r.err.includes(`Try \`${world.self} rebuild --help\``),
            `no next step:\n${r.err}`,
          );
          assertOwnFormOnly(world, r.err, `\`${args.join(' ')}\``);
        }
      });

      it('the FIRST RUN block is three commands this reader can actually paste', () => {
        const r = cli(world, ['--help']);
        assert.equal(r.code, 0);
        const firstRun = r.out.slice(r.out.indexOf('FIRST RUN'));
        for (const step of ['doctor', 'init', 'enlist']) {
          // Runnable has two halves, and each is proved somewhere it can be proved cheaply:
          // that `step` is a command this CLI routes (the derived set), and that `world.self`
          // followed by a command actually executes (the USAGE test below runs all seven).
          assert.ok(CLI_COMMANDS.includes(step), `FIRST RUN offers \`${step}\`, which is not a command`);
          assert.ok(
            firstRun.includes(`${world.self} ${step}`),
            `FIRST RUN does not offer a runnable \`${step}\`:\n${firstRun}`,
          );
        }
        assertOwnFormOnly(world, r.out, 'the top-level help');
      });

      it('each command’s own --help prints a USAGE line that actually runs', () => {
        // Every command, from the derived set — the hand-written loop that used to be here ran
        // six of the seven, and the one it skipped was `chat`.
        for (const command of CLI_COMMANDS) {
          const r = cli(world, [command, '--help']);
          assert.equal(r.code, 0, `${command} --help failed: ${r.err}`);

          const printed = pasteableUsage(r.out, `\`${command} --help\``);
          // It routes...
          assert.equal(
            printed,
            `${world.self} ${command}`,
            `\`${command} --help\` USAGE names another invocation:\n${printed}`,
          );
          // ...and it RUNS, which is the thing the old assertion only claimed to check. What it
          // printed, pasted back, has to reach this same help.
          const again = runsAsPrinted(world, printed, ['--help']);
          assert.equal(again.code, 0, `\`${printed}\` does not run: ${again.err}`);
          assert.ok(
            again.out.includes('USAGE'),
            `\`${printed} --help\` printed no USAGE of its own:\n${again.out}`,
          );

          assertOwnFormOnly(world, r.out, `\`${command} --help\``);
        }
      });
    });
  }
});

// ===========================================================================
// THE REPO-WIDE GUARD — the test that has to stop this recurring a fifth time
//
// `invokedAs()` has now been retrofitted onto `src/setup/**`, `src/command/**`, `src/cli.ts`,
// `src/view/index.ts`, `src/config/load.ts` and `src/archive/db.ts` — four separate passes, each
// one finding sites the previous pass did not, because each pass looked where it was already
// standing. The property is not "these files are clean"; it is "NO source file hardcodes a
// command suggestion", and only something that reads all of them can hold it.
//
// It is a PARSER, not a grep. A regex over raw file text cannot tell a printed
// string from a doc comment, and this codebase's comments discuss `army doctor` constantly and
// legitimately. So every `src/**/*.ts` is parsed with the TypeScript compiler and only STRING
// AND TEMPLATE LITERAL text is examined — the bytes that can actually reach a terminal. A
// template's `${invokedAs()} doctor` never trips it, because the literal fragment is ` doctor`.
// ===========================================================================

describe('no source file hardcodes a command the reader may not be able to run', () => {
  const srcRoot = nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), '..', 'src');

  type Offence = { file: string; line: number; text: string };

  /**
   * A bare `army` that reads as something to TYPE.
   *
   * Either the tool identifying itself (`army: unknown command`, `army view: …`) or a suggestion
   * (`army doctor`, `Try \`army --help\``). Both must be the form the reader actually invoked.
   * `~/.agentic-army`, `army/t-1` branches and `agentic-army` are excluded by the leading class.
   *
   * The command words are `COMMAND_WORDS`, read out of `src/cli.ts` rather than retyped here.
   * They used to be six literals in this regex, and `chat` was not among them: a printed
   * `army chat …` was invisible to the guard whose entire job is to see it. An eighth command
   * now cannot be added without this pattern growing to cover it.
   */
  const BARE_ARMY = new RegExp(
    `(^|[^\\w./@-])army(:|\\s+(?:${COMMAND_WORDS.join('|')})\\b)`,
  );

  /**
   * The one documented exception, stated by `src/command/index.ts` and followed by `src/cli.ts`
   * and `src/view/index.ts`: a help HEADING names the command, it does not tell you to run it.
   * `army campaign — run one objective end to end` is a title, and rewriting it to
   * `node src/cli.ts campaign — …` would be renaming the command, not routing a suggestion.
   */
  const HEADING = /^\s*army [a-z]+ — /;

  /**
   * Sites that are allowed to spell `army`, each with the reason.
   *
   * An allow-list, not a weakened pattern: an entry is visible in review and is
   * PINNED — the test below fails if an entry stops matching anything, so a fix elsewhere cannot
   * leave a stale exemption sitting here implying a defect that is gone.
   *
   * `contains` is matched against the TRIMMED offending line, and scoped to one file, so a loose
   * fragment cannot excuse an unrelated site somewhere else in the tree.
   */
  const ALLOWED: ReadonlyArray<{ file: string; contains: string; why: string }> = [
    {
      file: 'delivery/ladder.ts',
      contains: 'army:',
      why: 'a pull-request TITLE prefix. The product’s name on a PR someone else will read, not a command anyone types.',
    },
    {
      file: 'command/permissions.ts',
      contains: 'is satisfiable by anything that can spawn a pty',
      why: 'names the command as the SUBJECT of a sentence about what its TTY gate is worth. Not an instruction.',
    },
    {
      file: 'config/load.ts',
      contains: 'Added by `army enlist` from inside a repo',
      why: 'a comment written INTO ~/.agentic-army/config.toml. That file outlives the process that wrote it and is read from any shell, so baking this session’s `node src/cli.ts` into it would be a claim about a context that no longer applies. The installed spelling is the only stable one there.',
    },
    {
      file: 'config/load.ts',
      contains: 'Raising a ceiling takes either a terminal',
      why: 'same persisted config comment.',
    },
    {
      file: 'setup/init.ts',
      contains: 'Written by `army init`',
      why: 'the same persisted config.toml template, at its source.',
    },
    {
      file: 'setup/init.ts',
      contains: 'Added by `army enlist` from inside a repo',
      why: 'the same persisted config.toml template.',
    },
    {
      file: 'setup/init.ts',
      contains: 'a human at a terminal running',
      why: 'the same persisted config.toml template.',
    },
    {
      file: 'setup/init.ts',
      contains: 'The TTY test stops the naive',
      why: 'the same persisted config.toml template.',
    },
    // ---------------------------------------------------------------------------------------
    // `src/view/live.ts` used to hold the last two entries in this list, both marked DEFECT: a
    // fix line reading `army rebuild`, and follow mode's own `army view:` banner. They are gone
    // — `ReaderOptions.self` and `FollowOptions.self` are now required parameters, threaded from
    // the same `ViewDeps.self` every refusal in `runView` already used, so the file has no way
    // to name a command at all. Both entries were deleted here only after the pin below was
    // watched to fail on each of them in turn.
    // ---------------------------------------------------------------------------------------
  ];

  /**
   * Every string and template fragment in a parsed source, with the line it starts on.
   *
   * ONE implementation, shared by the real scan and by the self-test below — a second copy for
   * the fixture is exactly the drift a second implementation causes, and it would be the copy that
   * disagreed with the one doing the work.
   */
  function literalsOfSource(source: ts.SourceFile): Array<{ line: number; text: string }> {
    const out: Array<{ line: number; text: string }> = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        out.push({ line, text: node.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  }

  function parseFile(file: string): ts.SourceFile {
    return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  }

  function literalsOf(file: string): Array<{ line: number; text: string }> {
    return literalsOfSource(parseFile(file));
  }

  /**
   * Syntax errors from the parse, or [].
   *
   * `parseDiagnostics` is not in the public typings, hence the cast. It is here because of a
   * hole this guard fell into the first time it was exercised: a file that does not PARSE yields
   * zero string literals, and zero literals is indistinguishable from zero violations. The guard
   * went green on a source file that had a hardcoded suggestion in it — it just could not see it.
   * That is precisely the vacuous pass a guard must never become, so it is asserted, not assumed.
   */
  function syntaxErrorsIn(source: ts.SourceFile): readonly ts.Diagnostic[] {
    return (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  }

  function tsFilesUnder(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) return tsFilesUnder(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  /** The detector, over one file's literals. Shared by the real scan and by its own self-test. */
  function offencesIn(relative: string, literals: ReadonlyArray<{ line: number; text: string }>): Offence[] {
    const found: Offence[] = [];
    for (const literal of literals) {
      for (const line of literal.text.split('\n')) {
        if (BARE_ARMY.test(line) && !HEADING.test(line)) {
          found.push({ file: relative, line: literal.line, text: line.trim() });
        }
      }
    }
    return found;
  }

  const files = tsFilesUnder(srcRoot).sort();
  const offences = files.flatMap((file) =>
    offencesIn(nodePath.relative(srcRoot, file).split(nodePath.sep).join('/'), literalsOf(file)),
  );

  // =========================================================================================
  // CAN THIS TEST FAIL?
  //
  // Two ways it could pass while proving nothing: the scan finds no files, or the detector
  // never fires. Both are asserted against directly, so the guard is falsifiable on every run
  // rather than only on the day someone remembers to hand-plant a violation.
  // =========================================================================================
  it('actually reads the sources it claims to guard', () => {
    assert.ok(files.length > 25, `only ${files.length} source files scanned`);
    const literals = files.flatMap((f) => literalsOf(f));
    assert.ok(literals.length > 500, `only ${literals.length} string literals found`);
    // The four files this sweep was aimed at must be among them, by name.
    for (const expected of ['cli.ts', 'view/index.ts', 'config/load.ts', 'archive/db.ts']) {
      const wanted = nodePath.join(srcRoot, ...expected.split('/'));
      assert.ok(files.includes(wanted), `${expected} was not scanned`);
    }
  });

  it('every file actually parsed — an unparsed file has no literals and hides its own defects', () => {
    const broken = files
      .filter((f) => syntaxErrorsIn(parseFile(f)).length > 0)
      .map((f) => nodePath.relative(srcRoot, f));
    assert.deepEqual(broken, [], 'the scan saw no strings in these files, so it guarded nothing');
    // And no file is silently empty of literals for some other reason.
    for (const file of files) {
      if (literalsOf(file).length === 0) {
        assert.ok(
          !/["'`]/.test(fs.readFileSync(file, 'utf8')),
          `${nodePath.relative(srcRoot, file)} has quotes but the parser found no literals`,
        );
      }
    }
  });

  it('the detector fires on a planted suggestion, and not on a routed one', () => {
    // Both halves matter. A detector that never fires passes the scan vacuously; one that fires
    // on `${invokedAs()} doctor`, on a comment, or on `~/.agentic-army` would have been softened
    // into uselessness by the first false positive.
    const sample = ts.createSourceFile(
      'planted.ts',
      [
        'const a = `Try \\`army --help\\`.`;',
        'const b = `${self} doctor`;',
        'const c = "army doctor";',
        '// army doctor — this is a COMMENT and must not count',
        'const d = "~/.agentic-army/config.toml";',
        'const e = "army/t-1";',
        'const f = "agentic-army";',
        'const g = "army campaign — run one objective";',
      ].join('\n'),
      ts.ScriptTarget.ESNext,
      true,
    );

    const found = offencesIn('planted.ts', literalsOfSource(sample)).map((o) => o.text);
    assert.deepEqual(
      found.sort(),
      ['Try `army --help`.', 'army doctor'].sort(),
      `the detector is not detecting what it claims to: ${JSON.stringify(found)}`,
    );
  });

  it('every hardcoded `army` left in src is on the allow-list, with a reason', () => {
    const unexplained = offences.filter(
      (o) => !ALLOWED.some((a) => a.file === o.file && o.text.includes(a.contains)),
    );
    assert.deepEqual(
      unexplained.map((o) => `${o.file}:${o.line}  ${o.text}`),
      [],
      'a hardcoded `army …` reached a printable string. Route it through `invokedAs()` — see the ' +
        'block above it in src/setup/checks.ts — or, if it is genuinely not an instruction, add ' +
        'it to ALLOWED here with the reason.',
    );
  });

  it('no allow-list entry has gone stale', () => {
    // Without this, fixing `src/view/live.ts` would leave an entry here that quietly excuses a
    // defect that no longer exists — and the next real one to land on that line would be waved
    // through by it. An exemption has to expire when the thing it excuses does.
    for (const entry of ALLOWED) {
      assert.ok(entry.why.trim().length > 20, `no reason given for ${entry.file}: ${entry.contains}`);
      assert.ok(
        offences.some((o) => o.file === entry.file && o.text.includes(entry.contains)),
        `stale exemption — nothing in ${entry.file} matches ${JSON.stringify(entry.contains)} ` +
          'any more. Delete it.',
      );
    }
  });
});

// ===========================================================================
// THE REPO-WIDE GUARD — nothing may cite the internal design document
//
// The document that this codebase was built from is kept internal and is not in the checkout.
// It used to be cited 496 times across 47 files, in comments, in doc blocks, in test names, and
// — worst — in strings that `army doctor` prints to a terminal. Every one of those pointed the
// reader at something they cannot open, which is the same defect as a fix line naming a command
// they cannot run: it looks like help and resolves to nothing.
//
// The property is not "these files are clean"; it is "NO file under src/ or test/ cites it", and
// only something that reads all of them can hold that.
//
// It is a PARSER, not a grep, for the same reason the guard above is. But this one is the
// MIRROR of that guard. Up there, comments are the false positives to be excluded, because this
// codebase discusses `army doctor` in prose constantly and legitimately. Here comments are where
// nearly every citation lived, so both are examined — string and template literal text via the
// syntax tree, and comments via the compiler's own comment ranges, never a line regex. A line
// regex cannot tell a citation in a comment from the same run of characters inside a string
// literal, and it cannot report which of the two it found.
// ===========================================================================

describe('nothing in the tree cites the internal design document', () => {
  const repoRoot = nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), '..');

  type Citation = { file: string; line: number; where: 'string' | 'comment'; text: string };

  /**
   * The document's name, or a section mark.
   *
   * Written as a REGEX LITERAL rather than assembled from strings on purpose: a regex literal is
   * neither a string literal nor a comment, so the detector below cannot see its own pattern and
   * does not need an exemption to describe itself. `\bDESIGN\b` is case-sensitive because the
   * lowercase word is ordinary English ("by design", "the design has to survive Windows") and
   * only the shouted form was ever used as a citation.
   */
  const CITATION = /\bDESIGN\b|§/;

  /**
   * Sites allowed to spell a citation, each with the reason.
   *
   * An allow-list, not a weakened pattern: an entry is visible in review and is PINNED — the
   * test below fails if an entry stops matching anything, so deleting the fixture it excuses
   * cannot leave a stale exemption sitting here waving through the next real one.
   *
   * `contains` is matched against the TRIMMED offending line and scoped to one file, so a loose
   * fragment cannot excuse an unrelated site somewhere else in the tree.
   */
  const CITATION_ALLOWED: ReadonlyArray<{ file: string; contains: string; why: string }> = [
    {
      file: 'test/doctor.test.ts',
      contains: 'planted for this guard',
      why: 'the self-test fixture below. A detector that has never been watched to fire is not a detector, so the citations it fires on have to exist somewhere — and this is the one place they can exist without pointing a reader anywhere.',
    },
  ];

  /** Every string and template fragment in a parsed source, with the line it starts on. */
  function literalsOfSource(source: ts.SourceFile): Array<{ line: number; text: string }> {
    const out: Array<{ line: number; text: string }> = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        out.push({ line, text: node.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  }

  /**
   * Every comment in a parsed source, with the line each one starts on.
   *
   * The recursion is over `getChildren()`, not `forEachChild()`, and that is the whole trick.
   * `forEachChild` visits only named nodes, so a comment that is leading trivia of a bare TOKEN
   * — the `}` of an otherwise empty block, or the end-of-file token — belongs to nothing it
   * visits and is silently skipped. Both shapes occur in this repo, and a guard that cannot see
   * a comment cannot guard it. `getChildren()` yields the tokens too, so every comment in the
   * file is leading or trailing trivia of something this walk reaches; `seen` dedupes the
   * overlap. The empty-block and end-of-file cases are asserted below rather than assumed.
   */
  function commentsOfSource(source: ts.SourceFile): Array<{ line: number; text: string }> {
    const full = source.getFullText();
    const seen = new Set<number>();
    const out: Array<{ line: number; text: string }> = [];
    const take = (ranges: readonly ts.CommentRange[] | undefined): void => {
      for (const range of ranges ?? []) {
        if (seen.has(range.pos)) continue;
        seen.add(range.pos);
        out.push({
          line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
          text: full.slice(range.pos, range.end),
        });
      }
    };
    const visit = (node: ts.Node): void => {
      take(ts.getLeadingCommentRanges(full, node.getFullStart()));
      take(ts.getTrailingCommentRanges(full, node.getEnd()));
      for (const child of node.getChildren(source)) visit(child);
    };
    visit(source);
    return out;
  }

  function parseSource(file: string, text: string): ts.SourceFile {
    return ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  }

  /**
   * Syntax errors from the parse, or [].
   *
   * `parseDiagnostics` is not in the public typings, hence the cast. It is here for the same
   * reason it is on the guard above, and the hole is worse for this one: a file that does not
   * PARSE yields zero string literals AND zero comments, and zero of each is indistinguishable
   * from zero violations. The guard would go green on a file it could not read a word of. That
   * is a vacuous pass, so it is asserted, not assumed.
   */
  function syntaxErrorsIn(source: ts.SourceFile): readonly ts.Diagnostic[] {
    return (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  }

  function sourceFilesUnder(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFilesUnder(full);
      return /\.(ts|mjs)$/.test(entry.name) ? [full] : [];
    });
  }

  /**
   * The detector, over one parsed source. Shared by the real scan and by its own self-test — a
   * second copy for the fixture is the drift a single implementation exists to prevent, and it
   * would be the copy that disagreed with the one doing the work.
   *
   * A comment's line number is exact: comment text is verbatim source, so the offending line
   * inside a forty-line doc block is reported, not the line the block opens on.
   */
  function citationsIn(relative: string, source: ts.SourceFile): Citation[] {
    const found: Citation[] = [];
    for (const literal of literalsOfSource(source)) {
      for (const line of literal.text.split('\n')) {
        if (CITATION.test(line)) {
          found.push({ file: relative, line: literal.line, where: 'string', text: line.trim() });
        }
      }
    }
    for (const comment of commentsOfSource(source)) {
      comment.text.split('\n').forEach((line, offset) => {
        if (CITATION.test(line)) {
          found.push({
            file: relative,
            line: comment.line + offset,
            where: 'comment',
            text: line.trim(),
          });
        }
      });
    }
    return found;
  }

  const scanned = ['src', 'test']
    .flatMap((dir) => sourceFilesUnder(nodePath.join(repoRoot, dir)))
    .sort();

  const parsed = scanned.map((file) => ({
    file,
    relative: nodePath.relative(repoRoot, file).split(nodePath.sep).join('/'),
    source: parseSource(file, fs.readFileSync(file, 'utf8')),
  }));

  const citations = parsed.flatMap((entry) => citationsIn(entry.relative, entry.source));

  // =========================================================================================
  // CAN THIS TEST FAIL?
  //
  // Three ways it could pass while proving nothing: the scan finds no files, the parse fails
  // and yields nothing to look at, or the detector never fires. All three are asserted
  // directly, so the guard is falsifiable on every run rather than only on the day someone
  // remembers to hand-plant a citation.
  // =========================================================================================
  it('actually reads the sources it claims to guard', () => {
    assert.ok(scanned.length > 40, `only ${scanned.length} files scanned`);
    const literals = parsed.flatMap((e) => literalsOfSource(e.source));
    const comments = parsed.flatMap((e) => commentsOfSource(e.source));
    assert.ok(literals.length > 500, `only ${literals.length} string literals found`);
    assert.ok(comments.length > 500, `only ${comments.length} comments found`);
    // Both trees, by name — a scan that quietly covered only one of them would look identical.
    for (const expected of ['src/setup/checks.ts', 'src/cli.ts', 'test/doctor.test.ts', 'test/fixtures/fake-claude.mjs']) {
      assert.ok(
        parsed.some((e) => e.relative === expected),
        `${expected} was not scanned`,
      );
    }
  });

  it('every file actually parsed — an unparsed file has no comments and hides its own citations', () => {
    const broken = parsed
      .filter((e) => syntaxErrorsIn(e.source).length > 0)
      .map((e) => `${e.relative}: ${ts.flattenDiagnosticMessageText(syntaxErrorsIn(e.source)[0]?.messageText, ' ')}`);
    assert.deepEqual(broken, [], 'the scan read nothing in these files, so it guarded nothing');
  });

  it('the comment reader sees the comments a node walk would miss', () => {
    // An empty block and the end of the file are the two places `forEachChild` cannot reach.
    // If either regresses, the guard goes quiet on exactly the comments nobody re-reads.
    const sample = parseSource(
      'shapes.ts',
      [
        '/** a file header */',
        'function f(): void {',
        '  // alone inside an otherwise empty block',
        '}',
        'const x = 1; // trailing on a statement',
        '// after the last statement in the file',
      ].join('\n'),
    );
    const found = commentsOfSource(sample).map((c) => c.text);
    for (const expected of [
      '/** a file header */',
      '// alone inside an otherwise empty block',
      '// trailing on a statement',
      '// after the last statement in the file',
    ]) {
      assert.ok(found.includes(expected), `the comment reader missed ${JSON.stringify(expected)}`);
    }
  });

  it('the detector fires on a planted citation in a comment and in a string, and names the line', () => {
    // Both halves matter. A detector that never fires passes the scan vacuously; one that fired
    // on ordinary prose or on a pattern in code would have been softened into uselessness by the
    // first false positive.
    const sample = parseSource(
      'planted.ts',
      [
        '// a citation DESIGN §8 in a comment — planted for this guard',
        'const a = "denied to every worker (DESIGN §8) — planted for this guard";',
        'const b = "no citation here, just a sentence about the design";',
        '/* a block comment naming DESIGN.md — planted for this guard */',
        'const c = /DESIGN/; // a pattern in CODE, planted for this guard',
      ].join('\n'),
    );

    const found = citationsIn('planted.ts', sample).map((o) => `${o.file}:${o.line} ${o.where}`);
    assert.deepEqual(
      found.sort(),
      ['planted.ts:1 comment', 'planted.ts:2 string', 'planted.ts:4 comment'].sort(),
      `the detector is not detecting what it claims to: ${JSON.stringify(found)}`,
    );
  });

  it('no comment or printable string in src/ or test/ cites it', () => {
    const unexplained = citations.filter(
      (o) => !CITATION_ALLOWED.some((a) => a.file === o.file && o.text.includes(a.contains)),
    );
    assert.deepEqual(
      unexplained.map((o) => `${o.file}:${o.line}  (${o.where})  ${o.text}`),
      [],
      'a reference to the internal design document — its name, or a section mark — reached a ' +
        'comment or a printable string. The reader does not have that document, so the reference ' +
        'resolves to nothing. State the reason in the sentence instead of citing it.',
    );
  });

  it('no citation exemption has gone stale', () => {
    for (const entry of CITATION_ALLOWED) {
      assert.ok(entry.why.trim().length > 20, `no reason given for ${entry.file}: ${entry.contains}`);
      assert.ok(
        citations.some((o) => o.file === entry.file && o.text.includes(entry.contains)),
        `stale exemption — nothing in ${entry.file} matches ${JSON.stringify(entry.contains)} ` +
          'any more. Delete it.',
      );
    }
  });

  it('the shipped JSON schemas do not cite it either', () => {
    // `schemas/` is in `package.json#files`, and these `description` strings are not decoration:
    // the files are handed to claude as `--json-schema` and to codex as `--output-schema`, so
    // the text goes into a model's context on every structured return. A parser again, not a
    // grep — `JSON.parse` and a walk of the string VALUES, so a key name could never be mistaken
    // for prose. A file that fails to parse yields no strings, which is the same vacuous pass as
    // an unparsed source, so the parse is inside the assertion rather than assumed.
    const dir = nodePath.join(repoRoot, 'schemas');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    assert.ok(files.length > 0, 'no schema files were scanned');

    const offending: string[] = [];
    for (const name of files) {
      const walk = (value: unknown): void => {
        if (typeof value === 'string') {
          if (CITATION.test(value)) offending.push(`schemas/${name}  ${value.slice(0, 120)}`);
        } else if (Array.isArray(value)) {
          value.forEach(walk);
        } else if (value !== null && typeof value === 'object') {
          Object.values(value).forEach(walk);
        }
      };
      walk(JSON.parse(fs.readFileSync(nodePath.join(dir, name), 'utf8')));
    }
    assert.deepEqual(offending, [], 'a shipped schema description cites a document no reader has');
  });

  it('the shipped README does not cite it either', () => {
    // README.md is in `package.json#files` and the design document is not, so a citation there
    // is guaranteed to be unresolvable for every reader who installs this package. Markdown has
    // no parse to hang this off — the whole file is prose, so the whole file is checked.
    const readme = nodePath.join(repoRoot, 'README.md');
    const offending = fs
      .readFileSync(readme, 'utf8')
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter((entry) => CITATION.test(entry.text));
    assert.deepEqual(
      offending.map((entry) => `README.md:${entry.line}  ${entry.text.trim()}`),
      [],
      'README.md ships to users who will never have the design document',
    );
  });
});

// ===========================================================================
// JSON consumers must never read a title that contradicts the finding
// ===========================================================================

// ===========================================================================
// `army enlist` end to end on a CRLF config — the live Windows blocker.
//
// A hand-edited config on Windows has CRLF endings. The duplicated TOML
// surgery this module used to carry failed to match `[projects]\r`, appended a
// SECOND table, and then the round-trip guard refused every write forever:
// correct, fail-closed, and completely unusable — the user could not even
// LOWER a ceiling. This exercises the real command against such a file.
// ===========================================================================

describe(
  'enlist on a CRLF config',
  { skip: gitPath === null ? 'git not on PATH' : false },
  () => {
    type Run = { code: number; out: string; err: string };

    /**
     * Drive the real command, capturing its output through its OWN seam.
     *
     * This used to reassign `process.stdout.write` and `process.stderr.write` for the duration
     * of the call. `node:test` runs suites concurrently, so that patch also captured the test
     * RUNNER's reporter output for anything else in flight — deleting whole suites from the
     * report and reducing a genuine assertion failure elsewhere to a bare `'test failed'` with
     * no diagnostic. It cost real debugging time before it was spotted, and the only reason it
     * was spotted is that the swallowed suites made the test count wrong.
     *
     * Nothing global is written now. `interactive` is passed rather than patched onto
     * `process.stdin`, so two tests can never disagree about whether a human is present.
     */
    async function runEnlist(repo: string, home: string, argv: string[], tty: boolean): Promise<Run> {
      const cwd = process.cwd();
      const prevHome = process.env['AGENTIC_ARMY_HOME'];
      let out = '';
      let err = '';
      try {
        process.env['AGENTIC_ARMY_HOME'] = home;
        process.chdir(repo);
        const code = await enlistCommand(argv, {
          out: (s) => {
            out += s;
          },
          err: (s) => {
            err += s;
          },
          interactive: tty,
        });
        return { code, out, err };
      } finally {
        process.chdir(cwd);
        if (prevHome === undefined) delete process.env['AGENTIC_ARMY_HOME'];
        else process.env['AGENTIC_ARMY_HOME'] = prevHome;
      }
    }

    it('registers, lowers, and refuses to raise — all against CRLF', async () => {
      const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-crlf-'));
      try {
        const home = nodePath.join(tmp, 'home');
        fs.mkdirSync(home, { recursive: true });
        // The whole config, every line CRLF, exactly as a Windows edit leaves it.
        fs.writeFileSync(
          nodePath.join(home, 'config.toml'),
          defaultConfigToml().split('\n').join('\r\n'),
          'utf8',
        );

        const repo = nodePath.join(tmp, 'repo');
        fs.mkdirSync(repo);
        execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });

        const read = (): string => fs.readFileSync(nodePath.join(home, 'config.toml'), 'utf8');
        const projectTables = (t: string): number =>
          t.split('\n').filter((l) => /^\s*\[projects\]\s*\r?$/.test(l)).length;

        // 1. register
        const reg = await runEnlist(repo, home, [], false);
        assert.equal(reg.code, 0, `register failed: ${reg.err}`);
        assert.equal(projectTables(read()), 1, 'a second [projects] table was appended');
        assert.doesNotThrow(() => parseToml(read()), 'config stopped parsing after register');

        // 2. raise from a terminal
        const raise = await runEnlist(repo, home, ['--ceiling', '3'], true);
        assert.equal(raise.code, 0, `raise failed: ${raise.err}`);
        assert.equal((parseToml(read()) as any).projects[fs.realpathSync(repo)].ceiling, 3);

        // 3. lower with no terminal — must work, this is the case that was bricked
        const lower = await runEnlist(repo, home, ['--ceiling', '1'], false);
        assert.equal(lower.code, 0, `lower failed: ${lower.err}`);
        assert.equal((parseToml(read()) as any).projects[fs.realpathSync(repo)].ceiling, 1);

        // 4. raise with no terminal — must be refused
        const refused = await runEnlist(repo, home, ['--ceiling', '3'], false);
        assert.equal(refused.code, 1);
        assert.match(refused.err, /refusing to raise/);
        assert.equal((parseToml(read()) as any).projects[fs.realpathSync(repo)].ceiling, 1);

        // The file is still CRLF and still has exactly one [projects].
        assert.equal(projectTables(read()), 1);
        assert.ok(read().includes('\r\n'), 'CRLF endings were destroyed');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);

// ===========================================================================
// `enlist` on a repository that has never committed.
//
// It registered one happily, and the user found out one command later — from
// `campaign`, as an abort. `enlist` knew enough to ask and did not.
//
// WARN, NEVER BLOCK: `git init && army enlist` before writing a line is a
// legitimate way to start a project, and refusing it would be wrong.
//
// Driven as the REAL command in a child process. `enlistCommand` reads
// the repository from `process.cwd()` and the home from `process.env`, so an
// in-process version would have to `chdir` and patch the environment — global
// state a test must never touch, because it silently changes what every
// concurrently-running suite sees.
// ===========================================================================

describe(
  'enlist notices a repository with no commits',
  { skip: gitPath === null ? 'git not on PATH' : false },
  () => {
    const CLI = nodePath.join(
      nodePath.dirname(new URL(import.meta.url).pathname),
      '..',
      'src',
      'cli.ts',
    );

    type Run = { code: number | null; out: string; err: string };

    function runCli(args: string[], cwd: string, home: string): Run {
      const res = spawnSync(process.execPath, [CLI, ...args], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENTIC_ARMY_HOME: home,
          NODE_OPTIONS: '',
          // A real machine has a git identity; these stand in for the global config a user has
          // and a temp directory does not. Nothing else about the emitted command is changed.
          GIT_AUTHOR_NAME: 'Army Test',
          GIT_AUTHOR_EMAIL: 'test@army.invalid',
          GIT_COMMITTER_NAME: 'Army Test',
          GIT_COMMITTER_EMAIL: 'test@army.invalid',
        },
      });
      return { code: res.status, out: res.stdout, err: res.stderr };
    }

    function emptyRepo(tmp: string): string {
      const repo = nodePath.join(tmp, 'repo');
      fs.mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
      return fs.realpathSync(repo);
    }

    it('warns, does not block, and the command it prints actually works', () => {
      const tmp = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-nocommit-')));
      try {
        const home = nodePath.join(tmp, 'home');
        const repo = emptyRepo(tmp);

        const before = runCli(['enlist'], repo, home);

        // 1. It still enlisted. A warning, not a refusal.
        assert.equal(before.code, 0, `enlist blocked instead of warning:\n${before.err}`);
        assert.match(before.out, /enlisted/);
        assert.match(
          fs.readFileSync(nodePath.join(home, 'config.toml'), 'utf8'),
          new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          'the repository was warned about but never registered',
        );

        // 2. It said what is lost, and it said it in terms of the thing that will refuse.
        assert.match(before.out, /has no commits yet/);
        assert.match(before.out, /cannot lease a worktree until there is at least one commit/);

        // 3. It gave a command — and this is the half that used to be missing everywhere.
        const fixLine = before.out.split('\n').find((l) => l.trim().startsWith('fix: '));
        assert.ok(fixLine !== undefined, `no fix line in enlist's output:\n${before.out}`);
        const command = fixLine.trim().slice('fix: '.length);
        assert.equal(unrunnableReason(command), null, `unrunnable fix: ${command}`);

        // 4. Run it VERBATIM, exactly as the reader would paste it, and watch the warning clear.
        //    Either half alone proves nothing: a well-formed command that resolves nothing is the
        //    `mkdir -p "<file>"` defect, and a cleared condition nobody reproduced is a guess.
        const run = spawnSync('/bin/sh', ['-c', command], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Army Test',
            GIT_AUTHOR_EMAIL: 'test@army.invalid',
            GIT_COMMITTER_NAME: 'Army Test',
            GIT_COMMITTER_EMAIL: 'test@army.invalid',
          },
        });
        assert.equal(run.status, 0, `the fix failed: ${run.stderr}`);

        const after = runCli(['enlist'], repo, home);
        assert.equal(after.code, 0, after.err);
        assert.doesNotMatch(
          after.out,
          /has no commits yet/,
          'still warning after running the command it told us to run',
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('says nothing about commits on a repository that has one', () => {
      const tmp = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-hascommit-')));
      try {
        const home = nodePath.join(tmp, 'home');
        const repo = emptyRepo(tmp);
        execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], {
          cwd: repo,
          stdio: 'ignore',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Army Test',
            GIT_AUTHOR_EMAIL: 'test@army.invalid',
            GIT_COMMITTER_NAME: 'Army Test',
            GIT_COMMITTER_EMAIL: 'test@army.invalid',
          },
        });

        const run = runCli(['enlist'], repo, home);
        assert.equal(run.code, 0, run.err);
        assert.doesNotMatch(run.out, /has no commits/, 'warned about a repository that has commits');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('the emitted command is built for the repository root, not the working directory', () => {
      // The warning fires from a subdirectory too, and the command has to name the ROOT — a
      // `git -C <subdir> commit` would work by accident here and stop working the day the
      // subdirectory is the one thing that is not a repository.
      const tmp = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'army-subdir-')));
      try {
        const home = nodePath.join(tmp, 'home');
        const repo = emptyRepo(tmp);
        const sub = nodePath.join(repo, 'packages', 'inner');
        fs.mkdirSync(sub, { recursive: true });

        const run = runCli(['enlist'], sub, home);
        assert.equal(run.code, 0, run.err);
        assert.match(run.out, /has no commits yet/);
        assert.ok(
          run.out.includes(initialCommitCommand(repo)),
          `expected the fix to name ${quoteArg(repo)}, got:\n${run.out}`,
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);

// ===========================================================================
// The claim audit.
//
// An earlier version of this code asserted, in four places, that a spawned
// worker "can never satisfy the TTY test". That is false — `script`, `expect`
// and `python3 -c 'import pty'` all hand a terminal to anything holding Bash.
// These tests exist so the false claim cannot come back by a copy-paste.
// ===========================================================================

const OWNED_PROSE_FILES = ['../src/setup/enlist.ts', '../src/setup/init.ts', '../src/cli.ts', '../README.md'];

/** Phrases that are false, in any of our user-facing or explanatory text. */
const FALSE_CLAIMS: Array<[string, RegExp]> = [
  ['worker can never pass the TTY test', /can never satisfy the TTY test/i],
  ['worker is a pipe on both ends, therefore cannot', /pipe on both ends[^.]*can never/i],
  ['nothing non-interactive can raise, full stop', /never satisfy the TTY test however/i],
  ['raising is always a file edit', /Raising a ceiling is a deliberate human edit to (?:this|config)/i],
  ['escalation path unreachable from the conversation', /escalation path is\s+\*?\s*deliberately not reachable/i],
];

describe('no module claims the TTY gate is a boundary', () => {
  for (const rel of OWNED_PROSE_FILES) {
    const text = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

    for (const [label, pattern] of FALSE_CLAIMS) {
      it(`${rel} does not claim: ${label}`, () => {
        assert.doesNotMatch(text, pattern);
      });
    }

    it(`${rel} says what actually holds the line instead`, () => {
      // Whatever the wording, each file must point at the deny rule rather
      // than leave the TTY check looking sufficient on its own.
      assert.match(
        text,
        /\.agentic-army/,
        'should name the config directory that must be denied to workers',
      );
    });
  }

  it('the config template tells the user both raise routes', () => {
    const toml = defaultConfigToml();
    assert.match(toml, /terminal/i);
    assert.match(toml, /editing this file directly|edit this file/i);
    for (const [label, pattern] of FALSE_CLAIMS) {
      assert.doesNotMatch(toml, pattern, `config template still claims: ${label}`);
    }
  });

  it('the config template names the deny rule as the real boundary', () => {
    const toml = defaultConfigToml();
    assert.match(toml, /guardrail/i);
    assert.match(toml, /deny|denied/i);
  });
});

describe('the config template documents hooks, and the rule that makes them safe', () => {
  const toml = defaultConfigToml();

  it('states that hooks are read ONLY from this file, never from a repository', () => {
    // The same hole as a repo-supplied delivery ceiling. A hook is arbitrary command execution,
    // so a repo-supplied one makes `git clone` remote code execution. The config is where a
    // person is standing when they decide to add one, so the warning has to be here.
    assert.match(toml, /post_create/);
    assert.match(toml, /pre_destroy/);
    assert.match(toml, /never from a repository/i);
    assert.match(toml, /arbitrary command execution/i);
    // And it must connect the rule to the ceiling rule rather than restating it in isolation.
    assert.match(toml, /same hole/i);
  });

  /**
   * Every TOML key the loaders actually read, DERIVED from the loaders.
   *
   * The previous version of this was a hand-written list of four names, which meant it could
   * only ever catch the two mistakes I had already made. A freshly invented `max_agents = 8`
   * documented under `[worktree]` sailed through it — which is the exact failure the check
   * exists to prevent, since a config comment nothing reads is worse than no comment: it gets
   * followed, and silently does nothing.
   *
   * So the allowed set is read out of the source that does the reading. Bracket access on a
   * parsed TOML table is how both loaders consume it, and there is no other route.
   */
  function keysReadBy(...files: string[]): Set<string> {
    const keys = new Set<string>();
    for (const rel of files) {
      const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
      for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*\[\s*'([a-z][a-z0-9_]*)'\s*\]/g)) {
        keys.add(m[1] as string);
      }
    }
    return keys;
  }

  /** Assignment-shaped lines, commented or live, inside the worktree/hooks region only. */
  function documentedKeys(): string[] {
    const start = toml.indexOf('# [worktree] —');
    const end = toml.indexOf('# [[dispatch.rules]]');
    assert.ok(start >= 0 && end > start, 'could not locate the worktree region of the template');
    const region = toml.slice(start, end);
    return [...region.matchAll(/^#?\s{0,6}([a-z][a-z0-9_]*)\s*=/gm)].map((m) => m[1] as string);
  }

  it('documents only keys the loaders actually read — derived, not pinned', () => {
    const allowed = keysReadBy('../src/worktree/hooks.ts', '../src/config/load.ts');
    // Sanity floor: if the derivation silently stopped working, every key would "pass".
    for (const known of ['max_trees', 'post_create', 'pre_destroy', 'ceiling']) {
      assert.ok(allowed.has(known), `derivation failed — ${known} not found in the loaders`);
    }

    const documented = documentedKeys();
    assert.ok(documented.length >= 4, `expected several documented keys, got ${documented.join(', ')}`);
    for (const key of documented) {
      assert.ok(
        allowed.has(key),
        `config template documents \`${key}\`, which no loader reads — ` +
          `known keys: ${[...allowed].sort().join(', ')}`,
      );
    }
  });

  it('that derivation rejects an invented key — the case the pinned list let through', () => {
    // A guard is only worth having if it has been seen to fail. This drives the exact scenario
    // the previous hand-written version passed.
    const allowed = keysReadBy('../src/worktree/hooks.ts', '../src/config/load.ts');
    assert.ok(!allowed.has('max_agents'), 'max_agents must not be a real key');
    assert.ok(!allowed.has('max_slots'), 'max_slots must not be a real key');
  });

  it('does not resurrect the two keys that were invented once already', () => {
    assert.doesNotMatch(toml, /\bmax_slots\b/);
    assert.doesNotMatch(toml, /\[worktree\.hooks\]/);
  });

  it('keeps [projects] last so enlist can append without disturbing a comment', () => {
    const tables = [...toml.matchAll(/^\[+([a-z.]+)\]+$/gm)].map((m) => m[1]);
    assert.equal(tables[tables.length - 1], 'projects', `table order: ${tables.join(', ')}`);
  });
});

describe('PROTECTED_CONFIG_GLOBS', () => {
  it('is exported so the orchestrator imports a constant, not a memory', () => {
    assert.ok(Array.isArray(PROTECTED_CONFIG_GLOBS));
    assert.ok(PROTECTED_CONFIG_GLOBS.length > 0);
    assert.ok(Object.isFrozen(PROTECTED_CONFIG_GLOBS));
  });

  it('covers the directory as well as everything under it', () => {
    // Covering only `**` would leave creating config.toml where none exists,
    // and replacing the directory itself, both permitted.
    assert.ok(PROTECTED_CONFIG_GLOBS.some((g) => g.endsWith('/**')));
    assert.ok(PROTECTED_CONFIG_GLOBS.some((g) => !g.endsWith('/**')));
  });

  it('covers the AGENTIC_ARMY_HOME override, not just the default path', () => {
    assert.ok(PROTECTED_CONFIG_GLOBS.some((g) => g.includes('AGENTIC_ARMY_HOME')));
    assert.ok(PROTECTED_CONFIG_GLOBS.some((g) => g.includes('.agentic-army')));
  });

  it('resolves to absolute paths with no shell expansion left to do', () => {
    const resolved = protectedConfigGlobs('/tmp/army-home');
    for (const g of resolved) {
      assert.ok(nodePath.isAbsolute(g.replace(/\/\*\*$/, '')), `not absolute: ${g}`);
      assert.ok(!g.includes('~'), `unexpanded ~: ${g}`);
      assert.ok(!g.includes('$'), `unexpanded var: ${g}`);
    }
    assert.ok(resolved.some((g) => g.endsWith('config.toml')));
  });
});

describe('check titles match reality', () => {
  it('does not title the API key check "not set" when it IS set', () => {
    const set = classifyApiKey('sk-ant-api03-AAAABBBBCCCCDDDD');
    assert.equal(set.outcome, 'degraded');
    assert.doesNotMatch(set.title, /not set/);
    assert.match(set.title, /is set/);

    const unset = classifyApiKey(undefined);
    assert.equal(unset.outcome, 'ok');
    assert.match(unset.title, /not set/);
  });

  it('keeps `id` stable across states so machines can key on it', () => {
    assert.equal(classifyApiKey(undefined).id, classifyApiKey('sk-ant-x').id);
    assert.equal(classifyApiKey(undefined).id, 'anthropic-api-key');
  });
});

// ===========================================================================
// FIXTURE HYGIENE — a recorded fixture must not carry the recorder's machine
//
// Every `.jsonl` under `test/fixtures/` is a TRANSCRIPT of a live session, because recording one
// is the only honest way to get a fixture that matches what the harness really emits. That is
// also why this keeps happening: the first line of a claude session is a `system/init` frame
// that inventories the recording machine — its home directory, the MCP servers it had connected,
// the skills and slash commands and plugins it had installed, the memory files it had loaded —
// and a straight `>` into a fixture file commits all of it. It has been scrubbed by hand twice.
// The third time nobody will remember, because the person recording the fixture will be in the
// middle of something else and will have no idea any of this history exists.
//
// So the message below is written for THAT reader: it names the file, the line, what was found,
// and what to replace it with. A guard that only says "leak detected" hands the problem back.
//
// THE DETECTION RULE, stated once:
//
//   1. HOME PATHS — `/Users/<name>`, `/home/<name>`, `C:\Users\<name>`, and the `-Users-<name>-`
//      form Claude Code mangles a cwd into for its scratchpad directory. Flagged unless `<name>`
//      is one of the placeholders a scrubbed fixture is supposed to use. Additionally, the
//      running machine's OWN home is matched literally, which covers the case where a real
//      account happens to be named like a placeholder.
//   2. ENVIRONMENT INVENTORY — the keys `mcp_servers`, `slash_commands`, `skills`, `plugins`,
//      `memory_paths` carrying CONTENT. Empty (`[]`, `{}`, `null`) is the scrubbed form and is
//      the only accepted one. Checked structurally against the parsed JSON of each line, so a
//      key name appearing inside a string value can never be mistaken for the field.
//   3. MCP TOOL NAMES — any `mcp__<server>__<tool>` token. These name servers the recorder had
//      connected and appear in `tools` arrays and in tool-use blocks, which is a place the
//      inventory check does not look.
//   4. CREDENTIALS — an `sk-ant-…` token. Cheap, and the one leak class that is not merely
//      embarrassing.
//
// What it deliberately does NOT do: flag ordinary fixture content. Tool names, agent names,
// session uuids, model ids, token counts, file paths under `/private/tmp` or `/tmp`, and prose
// that happens to use the words "skills" or "plugins" are all legitimate and all pass.
// ===========================================================================

describe('no fixture carries the environment of the machine that recorded it', () => {
  const repoRoot = nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), '..');
  const fixturesDir = nodePath.join(repoRoot, 'test', 'fixtures');

  type LeakKind = 'home-path' | 'environment-inventory' | 'mcp-tool' | 'credential';
  type Leak = { file: string; line: number; kind: LeakKind; found: string };

  /**
   * Account names a scrubbed fixture is allowed to spell.
   *
   * Deliberately short. Every entry is a name no real machine in this project has, and adding to
   * it is how the guard gets neutered — the rule is "replace the account name", not "add yours
   * here". `runner` and `ci` are NOT on it: a fixture carrying a CI home is still a fixture
   * carrying somebody's home.
   */
  const PLACEHOLDER_ACCOUNTS = new Set(['example', 'user', 'someone', 'test', 'you']);

  /**
   * Home-path shapes. Three, because a home directory reaches a transcript three different ways:
   * verbatim in a `cwd`, escaped inside a JSON string on Windows, and mangled into a single
   * path segment by Claude Code's own scratchpad naming (`-Users-alice-projects-thing`).
   *
   * The mangled form's capture excludes `-`, since `-` is the separator there; the POSIX and
   * Windows forms capture up to their own separator and may contain `-`.
   */
  const HOME_SHAPES: ReadonlyArray<{ what: string; re: RegExp }> = [
    { what: 'posix home', re: /(?:\/Users|\/home)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g },
    { what: 'windows home', re: /[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9][A-Za-z0-9._-]*)/g },
    { what: 'mangled home', re: /-Users-([A-Za-z0-9][A-Za-z0-9._]*)/g },
  ];

  /** Fields of the `system/init` frame that inventory the recording machine. */
  const INVENTORY_KEYS = ['mcp_servers', 'slash_commands', 'skills', 'plugins', 'memory_paths'];

  /**
   * The same five keys, for a line that did not parse as JSON. The lookahead accepts exactly the
   * three scrubbed spellings and nothing else, so `"skills":[]` passes and `"skills":["x"]` does
   * not. The structural check below is the authoritative one; this only covers what it cannot
   * reach.
   */
  const INVENTORY_TEXT = new RegExp(
    `"(${INVENTORY_KEYS.join('|')})"\\s*:\\s*(?!\\[\\s*\\]|\\{\\s*\\}|null)`,
    'g',
  );

  const MCP_TOOL = /\bmcp__[A-Za-z0-9_.-]+/g;
  const CREDENTIAL = /\bsk-ant-[A-Za-z0-9_-]{8,}/g;

  /**
   * The running machine's own home, when its account name is not already a placeholder.
   *
   * Null on a machine whose account IS named like a placeholder — there the structural rule
   * already permits the string, and matching it literally would fail a correctly scrubbed
   * fixture. Losing the extra coverage on such a machine is the right trade: the structural rule
   * is the one that runs everywhere.
   */
  const OWN_HOME: string | null = (() => {
    const home = os.homedir();
    const account = nodePath.basename(home);
    return PLACEHOLDER_ACCOUNTS.has(account.toLowerCase()) ? null : home;
  })();

  /** Non-empty means the field carries the recorder's environment. `null` is scrubbed. */
  function carriesContent(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }

  /** Every inventory key carrying content anywhere in a parsed line, however deeply nested. */
  function inventoryLeaks(parsed: unknown): string[] {
    const found: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (INVENTORY_KEYS.includes(key) && carriesContent(child)) {
          found.push(`${key}: ${JSON.stringify(child).slice(0, 120)}`);
        }
        walk(child);
      }
    };
    walk(parsed);
    return found;
  }

  /**
   * The detector, over the text of one file. Shared by the real scan and by the self-test below,
   * so the fixture that proves it fires and the scan that keeps the tree clean can never drift
   * apart.
   *
   * `.jsonl` lines that parse are examined structurally for the inventory keys and textually for
   * everything else; a line that does not parse falls back to the text pattern for all four, so
   * a malformed line cannot become a hiding place.
   */
  function leaksIn(relative: string, text: string): Leak[] {
    const found: Leak[] = [];
    const jsonl = relative.endsWith('.jsonl');

    text.split('\n').forEach((raw, index) => {
      const line = index + 1;
      const add = (kind: LeakKind, what: string): void => {
        found.push({ file: relative, line, kind, found: what });
      };

      for (const shape of HOME_SHAPES) {
        shape.re.lastIndex = 0;
        for (const match of raw.matchAll(shape.re)) {
          const account = match[1] ?? '';
          if (PLACEHOLDER_ACCOUNTS.has(account.toLowerCase())) continue;
          add('home-path', `${shape.what} ${match[0]}`);
        }
      }
      if (OWN_HOME !== null && raw.includes(OWN_HOME)) {
        add('home-path', `this machine's home directory ${OWN_HOME}`);
      }

      for (const match of raw.matchAll(MCP_TOOL)) add('mcp-tool', match[0]);
      for (const match of raw.matchAll(CREDENTIAL)) add('credential', match[0]);

      let parsed: unknown;
      let parsedOk = false;
      if (jsonl && raw.trim().length > 0) {
        try {
          parsed = JSON.parse(raw);
          parsedOk = true;
        } catch {
          parsedOk = false;
        }
      }
      if (parsedOk) {
        for (const leak of inventoryLeaks(parsed)) add('environment-inventory', leak);
      } else {
        for (const match of raw.matchAll(INVENTORY_TEXT)) {
          add('environment-inventory', `${match[1]} carries content`);
        }
      }
    });

    return found;
  }

  /**
   * What the person who trips this has to do. Printed IN the assertion message, because they are
   * mid-task, they did not know any of this was a rule, and the fix is not guessable from the
   * word "leak".
   */
  const HOW_TO_SCRUB = [
    'A fixture under test/fixtures/ carries the environment of the machine that recorded it.',
    'Recording is how these files are meant to be made, so this is not your mistake — but the',
    'recording has to be scrubbed before it is committed. In every offending line:',
    '',
    '  home paths          replace the account name with `example`, everywhere it appears —',
    '                      including the `-Users-<you>-…` form inside a scratchpad path.',
    '  mcp_servers         set to []',
    '  slash_commands      set to []',
    '  skills              set to []',
    '  plugins             set to []',
    '  memory_paths        set to {}',
    '  mcp__* tool names   drop them from `tools` arrays, and drop any frame that calls one.',
    '  sk-ant-… tokens     remove, and rotate the key.',
    '',
    'The fixture stays valid: nothing under test/ asserts on any of these fields.',
  ].join('\n');

  function fixtureFilesUnder(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = nodePath.join(dir, entry.name);
      return entry.isDirectory() ? fixtureFilesUnder(full) : [full];
    });
  }

  const scanned = fixtureFilesUnder(fixturesDir).sort();
  const read = scanned.map((file) => ({
    relative: nodePath.relative(repoRoot, file).split(nodePath.sep).join('/'),
    text: fs.readFileSync(file, 'utf8'),
  }));

  // =========================================================================================
  // CAN THIS TEST FAIL?
  //
  // Three vacuous passes to rule out: the scan finds no files, the `.jsonl` lines do not parse
  // (so the structural half sees nothing), and the detector never fires on anything. All three
  // are asserted, so the guard is falsifiable on every run.
  // =========================================================================================
  it('actually reads every fixture it claims to guard', () => {
    assert.ok(scanned.length >= 8, `only ${scanned.length} fixture files scanned`);
    for (const expected of [
      'test/fixtures/claude-subagent.jsonl',
      'test/fixtures/claude-duplex.jsonl',
      'test/fixtures/codex-run.jsonl',
      'test/fixtures/fake-claude.mjs',
    ]) {
      assert.ok(
        read.some((entry) => entry.relative === expected),
        `${expected} was not scanned`,
      );
    }
    // A directory walk, not a hard-coded list: whatever is added next is guarded without
    // anybody remembering to add it here.
    assert.ok(
      read.some((entry) => entry.relative.endsWith('.jsonl')),
      'no transcript fixture was scanned, and transcripts are the only ones that leak',
    );
  });

  it('the transcript lines parse, so the structural half of the rule is actually running', () => {
    const unparsed: string[] = [];
    let lines = 0;
    for (const entry of read) {
      if (!entry.relative.endsWith('.jsonl')) continue;
      entry.text.split('\n').forEach((raw, index) => {
        if (raw.trim().length === 0) return;
        lines += 1;
        try {
          JSON.parse(raw);
        } catch {
          unparsed.push(`${entry.relative}:${index + 1}`);
        }
      });
    }
    assert.ok(lines > 100, `only ${lines} transcript lines seen`);
    assert.deepEqual(unparsed, [], 'these lines are invisible to the structural inventory check');
  });

  it('the detector fires on every leak class, and names the file, the line and the field', () => {
    // A realistic `system/init` frame, of exactly the shape that has twice been committed
    // unscrubbed, plus the two leak classes that live outside that frame.
    const planted = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: '/Users/alice/code/agentic-army',
        tools: ['Read', 'mcp__datadog-mcp__search_datadog_logs'],
        mcp_servers: [{ name: 'datadog-mcp', status: 'connected' }],
        slash_commands: ['ship-it', 'standup'],
        skills: ['diagnose', 'handoff'],
        plugins: [{ name: 'acme-tools', path: '/Users/alice/.claude/plugins/cache/acme' }],
        memory_paths: { user: '/Users/alice/.claude/CLAUDE.md' },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: '/private/tmp/claude-501/-Users-alice-code-agentic-army/abc/scratchpad',
      }),
      JSON.stringify({ type: 'note', token: 'sk-ant-api03-AAAABBBBCCCCDDDD' }),
    ].join('\n');

    const found = leaksIn('test/fixtures/planted.jsonl', planted);
    const kinds = new Set(found.map((leak) => leak.kind));
    for (const kind of ['home-path', 'environment-inventory', 'mcp-tool', 'credential']) {
      assert.ok(kinds.has(kind as LeakKind), `the detector missed ${kind}: ${JSON.stringify(found)}`);
    }

    // Every inventory field individually, so a rule that happened to catch one of them is not
    // mistaken for a rule that catches all five.
    //
    // SPELLED OUT, not iterated over `INVENTORY_KEYS`. Looping the constant under test was a
    // vacuous pass and was watched to be one: deleting `memory_paths` from `INVENTORY_KEYS`
    // deleted it from the assertion at the same time, so the detector went blind to a whole leak
    // class and this test stayed green. A guard's own fixture may not be derived from the thing
    // it guards.
    const fields = found.filter((leak) => leak.kind === 'environment-inventory').map((leak) => leak.found);
    for (const key of ['mcp_servers', 'slash_commands', 'skills', 'plugins', 'memory_paths']) {
      assert.ok(
        fields.some((entry) => entry.startsWith(`${key}:`)),
        `${key} carrying content was not reported: ${JSON.stringify(fields)}`,
      );
    }
    // And the constant itself, member for member, so shrinking it is a red test rather than a
    // silently narrower rule.
    assert.deepEqual(
      [...INVENTORY_KEYS].sort(),
      ['mcp_servers', 'memory_paths', 'plugins', 'skills', 'slash_commands'],
      'the set of environment-inventory fields changed',
    );

    // Line numbers, because "somewhere in this file" is not actionable in a 68-line transcript.
    assert.ok(
      found.some((leak) => leak.line === 2 && leak.found.includes('-Users-alice')),
      'the mangled scratchpad form was missed, or reported on the wrong line',
    );
    assert.ok(
      found.some((leak) => leak.line === 3 && leak.kind === 'credential'),
      'the credential was missed, or reported on the wrong line',
    );
    assert.ok(found.every((leak) => leak.file === 'test/fixtures/planted.jsonl'));
  });

  it('the detector is silent on a correctly scrubbed transcript and on ordinary content', () => {
    // The other half. A rule broad enough to fail on legitimate fixture content would be turned
    // off within a week, so the shapes that must NOT fire are pinned here.
    const clean = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: '/private/tmp/claude-501/-Users-example-organizations-personal-agentic-army/e8/scratchpad',
        tools: ['Task', 'Bash', 'Read', 'Write', 'WebSearch'],
        mcp_servers: [],
        slash_commands: [],
        skills: [],
        plugins: [],
        memory_paths: {},
        model: 'claude-haiku-4-5-20251001',
        session_id: 'a8ef720b-df10-4684-bde5-3d2deeb95e5b',
        agents: ['claude', 'Explore', 'general-purpose'],
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will check which skills and plugins are installed.' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/calc.py' } },
          ],
        },
      }),
      JSON.stringify({ type: 'item.completed', item: { command: '/bin/zsh -lc ls' } }),
    ].join('\n');

    assert.deepEqual(
      leaksIn('test/fixtures/clean.jsonl', clean),
      [],
      'the rule is too broad — it fails on legitimate fixture content',
    );
  });

  it('no fixture in the tree carries recorder-environment leakage', () => {
    const leaks = read.flatMap((entry) => leaksIn(entry.relative, entry.text));
    assert.deepEqual(
      leaks.map((leak) => `${leak.file}:${leak.line}  [${leak.kind}]  ${leak.found}`),
      [],
      HOW_TO_SCRUB,
    );
  });
});

// ===========================================================================
// HERMETICITY — this file must not touch the developer's real ~/.agentic-army
//
// `test/command.test.ts` and `test/chat.test.ts` each audit ONE entry point: a campaign, and a
// chat session. Both were green while `npm test` wrote into the real `~/.agentic-army` on every
// run, because the write was not on either path. It came from here — two tests called
// `runChecks(2000)`, let the home default to the ambient one, and `inspectWritableDir` proved
// that directory writable the only way that is honest on a network share: by creating
// `.army-write-probe-<pid>` in it and removing it again.
//
// So the audit had a hole with two sides, and both are closed below.
//
//   REACH. It observed one entry point and nothing else in the suite. The audit at the bottom of
//   this section instruments THIS WHOLE FILE — it runs every test in it under the tripwire and
//   reports what the process touched — so a call site that reaches for the ambient home is
//   caught wherever in the file it is written, and by the guard rather than by a person
//   noticing a directory's mtime moved.
//
//   APIS. The patch list carried `writeFileSync`, `appendFileSync` and `mkdirSync` and no way to
//   remove anything at all. `fs.promises.rm` — the second half of the write probe — went
//   unobserved, as did rename, copy, truncate and every other mutation. That list now lives in
//   `test/fixtures/fs-audit.mjs`, covers creation, mutation and removal on both the sync and the
//   promises APIs, and records the API name beside the path so a hit says what happened to it.
//
// The child processes below deliberately run with `NODE_TEST_CONTEXT` cleared. `homeDir()`
// refuses to resolve the ambient home under the test runner, which is the mechanism that stops
// this defect being written again — but if that refusal were also active in here, the audit
// would be proving the tripwire rather than the code, and would stay green if the tripwire were
// removed tomorrow. Cleared, the ambient home is genuinely reachable in the audited process,
// so a hit means the code really would have written there.
// ===========================================================================

/** The tripwire itself, and the module URL every runner below imports it from. */
const FS_AUDIT_MODULE = pathToFileURL(
  nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), 'fixtures', 'fs-audit.mjs'),
).href;

/** Run a generated ESM script in a child, and hand back what it printed. */
function runAuditChild(
  source: string,
  args: string[],
  env: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
  const dir = scratchHome('audit');
  const runner = nodePath.join(dir, 'runner.mjs');
  fs.writeFileSync(runner, source, 'utf8');
  const result = spawnSync(process.execPath, [runner, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env, ARMY_FS_AUDIT: FS_AUDIT_MODULE, NODE_TEST_CONTEXT: undefined },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('the fs tripwire the hermeticity audits are built on', () => {
  // A detector nobody has watched fire is not a detector. Every audit below reports the ABSENCE
  // of hits, and absence is exactly what a broken detector also reports — so the first thing to
  // establish is that it fires, on a removal as well as on a write, since the removal is the
  // half the previous patch list could not see.
  const PROBE = String.raw`
const audit = await import(process.env.ARMY_FS_AUDIT);
const [root, outFile] = process.argv.slice(2);
const fs = await import('node:fs');
const fsp = await import('node:fs/promises');
fs.writeFileSync(root + '/sync.txt', 'x');
fs.renameSync(root + '/sync.txt', root + '/moved.txt');
fs.rmSync(root + '/moved.txt');
await fsp.writeFile(root + '/probe.txt', '');
await fsp.rm(root + '/probe.txt', { force: true });
// Outside the root: this runner's own source. It must pass straight through unrecorded, or
// the tripwire is a "did anything happen" detector rather than a "did it happen HERE" one.
fs.readFileSync(process.argv[1], 'utf8');
fs.writeFileSync(outFile, JSON.stringify(audit.hitList()));
`;

  it('records the write, the rename and BOTH deletions, and nothing outside the root', () => {
    const root = scratchHome('tripwire');
    const out = nodePath.join(scratchHome('tripwire-out'), 'hits.json');
    const child = runAuditChild(PROBE, [root, out], {
      ARMY_AUDIT_ROOTS: JSON.stringify([root]),
      ARMY_AUDIT_HOME: undefined,
    });
    assert.equal(child.status, 0, `the probe never finished: ${child.stderr}`);

    const hits = JSON.parse(fs.readFileSync(out, 'utf8')) as string[];
    const apis = hits.map((hit) => hit.split(' ')[0]);
    for (const api of ['writeFileSync', 'renameSync', 'rmSync', 'writeFile', 'rm']) {
      assert.ok(apis.includes(api), `the tripwire did not record ${api}: ${JSON.stringify(hits)}`);
    }
    // `renameSync` names two paths and both are recorded — moving a protected file out is a
    // delete from the root, and recording only the source would call that a read.
    assert.equal(hits.filter((hit) => hit.startsWith('renameSync ')).length, 2, JSON.stringify(hits));
    for (const hit of hits) {
      assert.ok(hit.includes(root + '/'), `a path outside the audited root was recorded: ${hit}`);
    }
  });

  it('refuses to run at all when it has been given nothing to protect', () => {
    // The one failure mode a green audit cannot distinguish from success: an empty root list
    // matches nothing, records nothing, and passes. It has to be an error, not a default.
    const child = runAuditChild(
      'await import(process.env.ARMY_FS_AUDIT);\n',
      [],
      { ARMY_AUDIT_HOME: undefined, ARMY_AUDIT_ROOTS: undefined },
    );
    assert.notEqual(child.status, 0, 'an audit with no protected roots started up quite happily');
    assert.match(child.stderr, /ARMY_AUDIT_HOME/);
  });
});

describe('doctor confines itself to the home it was given', () => {
  const RUNNER = String.raw`
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [home, outFile] = process.argv.slice(2);

const audit = await import(process.env.ARMY_FS_AUDIT);

const { runChecks } = await import(process.env.ARMY_CHECKS_MODULE);
let ids = [];
let home_outcome = null;
let error = null;
try {
  const report = await runChecks(2000, home);
  ids = report.checks.map((c) => c.id);
  home_outcome = (report.checks.find((c) => c.id === 'home') ?? {}).outcome ?? null;
} catch (e) {
  error = String(e && e.message);
}
require('node:fs').writeFileSync(outFile, JSON.stringify({ ids, home_outcome, error, hits: audit.hitList() }, null, 2));
`;

  it('runs every check against a temporary home and touches nothing under the real one', () => {
    const home = scratchHome('doctor-run');
    const out = nodePath.join(scratchHome('doctor-out'), 'audit.json');
    const child = runAuditChild(RUNNER, [home, out], {
      ARMY_AUDIT_HOME: os.homedir(),
      ARMY_CHECKS_MODULE: pathToFileURL(nodePath.resolve('src/setup/checks.ts')).href,
      AGENTIC_ARMY_HOME: undefined,
    });
    assert.equal(child.status, 0, `the audited doctor run exited ${String(child.status)}: ${child.stderr}`);

    const audit = JSON.parse(fs.readFileSync(out, 'utf8')) as {
      ids: string[];
      home_outcome: string | null;
      error: string | null;
      hits: string[];
    };
    assert.equal(audit.error, null, 'the audited doctor run threw');
    // The checks that touch a directory must actually have run, or the audit is of nothing.
    for (const id of ['home', 'worktree-pool', 'stale-worktree-pool']) {
      assert.ok(audit.ids.includes(id), `the ${id} check did not run: ${JSON.stringify(audit.ids)}`);
    }
    // And the write probe must have taken its writing branch. An `ok` home is only reachable by
    // creating the probe file in that directory and removing it again.
    assert.equal(audit.home_outcome, 'ok', 'the home check never reached the write probe');

    assert.deepEqual(
      audit.hits,
      [],
      'doctor touched the developer\'s real home while inspecting a temporary one. It writes a ' +
        'probe file to prove writability, so a read here is the least of it:\n  ' +
        audit.hits.join('\n  '),
    );
  });
});

/**
 * Set in the child that runs this file under the tripwire, and read to skip the three audits in
 * this section when it does.
 *
 * Without it the last one recurses forever. With it, a `skip` rather than a deletion: the child
 * runs everything else in the file exactly as the suite does, which is the point — the audit is
 * of this file's real behaviour, not of a reduced copy of it.
 */
const AUDITING_THIS_FILE = process.env['ARMY_HERMETIC_AUDIT_CHILD'] !== undefined;

describe('this whole file, run under the tripwire', { skip: AUDITING_THIS_FILE }, () => {
  /**
   * Import the test file. `node:test` schedules and runs it in an ordinary node process exactly
   * as it does under the runner, so this is the suite's own behaviour rather than a re-enactment
   * of it. The hits are written on `exit`, once everything has finished.
   */
  const RUNNER = String.raw`
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const outFile = process.argv[2];

const audit = await import(process.env.ARMY_FS_AUDIT);

process.on('exit', () => {
  require('node:fs').writeFileSync(outFile, JSON.stringify({ hits: audit.hitList() }, null, 2));
});

await import(process.env.ARMY_AUDIT_TEST_FILE);
`;

  it('touches ZERO paths under the real ~/.agentic-army, ~/.ssh or ~/.aws', () => {
    const out = nodePath.join(scratchHome('file-audit'), 'audit.json');
    const child = runAuditChild(RUNNER, [out], {
      ARMY_AUDIT_HOME: os.homedir(),
      ARMY_AUDIT_TEST_FILE: pathToFileURL(new URL(import.meta.url).pathname).href,
      ARMY_HERMETIC_AUDIT_CHILD: '1',
      // Unset, so the ambient home is genuinely reachable inside the audited process. Setting it
      // would relocate every default and the audit would pass without proving anything.
      AGENTIC_ARMY_HOME: undefined,
    });

    // ===================================================================================
    // CAN THIS TEST FAIL?
    //
    // Four ways it could pass while proving nothing, so all four are asserted rather than
    // assumed: the child never ran the file, it ran a handful of tests instead of all of them,
    // its tests were CANCELLED rather than run — a cancelled run still prints `fail 0` — or it
    // failed outright and the empty hit list is just the shape of a process that stopped early.
    // ===================================================================================
    const count = (label: string): number => {
      const found = new RegExp(`^ℹ ${label} (\\d+)$`, 'm').exec(child.stdout);
      assert.ok(found !== null, `the child printed no ${label} line:\n${child.stderr}`);
      return Number(found[1]);
    };
    assert.ok(count('tests') > 200, `the child ran only ${String(count('tests'))} tests`);
    assert.equal(count('fail'), 0, `tests failed inside the audited run:\n${child.stdout.slice(-4000)}`);
    assert.equal(count('cancelled'), 0, 'tests were cancelled inside the audited run');
    assert.equal(child.status, 0, `the audited run exited ${String(child.status)}: ${child.stderr}`);

    const audit = JSON.parse(fs.readFileSync(out, 'utf8')) as { hits: string[] };
    assert.deepEqual(
      audit.hits,
      [],
      'a test in this file touched the developer\'s real ~/.agentic-army. Every check here takes ' +
        'the directory it inspects as an argument — pass a temporary one. Each line below is the ' +
        'fs API that did it and the path it was given:\n  ' +
        audit.hits.join('\n  '),
    );
  });
});

/**
 * The mechanism, guarded.
 *
 * Skipped inside the audit child, and the reason is the point: that child runs with
 * `NODE_TEST_CONTEXT` cleared precisely so the refusal is DISARMED and the audit observes what
 * the code would really do. A test of the refusal has nothing to watch there.
 */
describe('a test cannot resolve the home from the ambient environment', { skip: AUDITING_THIS_FILE }, () => {
  it('homeDir() refuses under the test runner, and names the way to opt in', () => {
    // The precondition. If something upstream had set the override, the refusal below would be
    // untested and this whole guard would pass for the wrong reason.
    assert.equal(process.env['AGENTIC_ARMY_HOME'], undefined);
    assert.ok(process.env['NODE_TEST_CONTEXT'] !== undefined, 'this is not running under the runner');
    assert.throws(() => homeDir(), /refusing to resolve the home directory/);
  });

  it('and answers normally the moment a test says which directory it means', () => {
    const dir = scratchHome('explicit');
    process.env['AGENTIC_ARMY_HOME'] = dir;
    try {
      assert.equal(homeDir(), dir);
    } finally {
      delete process.env['AGENTIC_ARMY_HOME'];
    }
  });

  it('outside the runner it still defaults, so the real command is untouched', () => {
    // The cost of a tripwire in shipped code is that it might fire in the field. It cannot:
    // `NODE_TEST_CONTEXT` is set by the node test runner in the processes it spawns and by
    // nothing else, and this child has neither it nor the override.
    const child = runAuditChild(
      String.raw`
const { homeDir } = await import(process.env.ARMY_CHECKS_MODULE);
process.stdout.write(homeDir());
`,
      [],
      {
        ARMY_CHECKS_MODULE: pathToFileURL(nodePath.resolve('src/setup/checks.ts')).href,
        ARMY_AUDIT_HOME: os.homedir(),
        AGENTIC_ARMY_HOME: undefined,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, nodePath.join(os.homedir(), '.agentic-army'));
  });
});
