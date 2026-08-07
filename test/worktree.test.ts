/**
 * Worktree isolation and warm pooling.
 *
 * Real git, real repositories, real bare repos acting as remotes, real child processes for the
 * lifecycle hooks. No network, no GitHub account, no treehouse — treehouse is gone; pooling is
 * ours now, so everything asserted here is asserted about something that actually ran.
 *
 * The two properties this file exists to protect, above all the others:
 *
 *  1. **A release keeps the dependencies.** Amortising a dependency install that takes one to
 *     three minutes is the entire reason there is a pool, and `warm reuse survives a release` is
 *     the test that proves the feature exists at all.
 *  2. **A hook is arbitrary command execution and may only come from the user's global config.**
 *     `repo-local hook definitions NEVER run` plants seven of them and instruments the canary so
 *     that "nothing ran" cannot pass for the wrong reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Lease } from '../src/contracts/worktree.ts';
import type { SoldierEvent, SoldierSpec } from '../src/contracts/index.ts';
import { armyBranch } from '../src/contracts/worktree.ts';
import { createClaudeAdapter } from '../src/harness/index.ts';
import {
  assertWorktreeRootOutsideProtected,
  permissionsFor,
} from '../src/command/permissions.ts';
import { worktreesRootFor } from '../src/config/paths.ts';
import {
  CONFIG_RELOCATING_ENV_VARS,
  ColdWorktreeProvider,
  ColdWorktreeError,
  DEFAULT_MAX_TREES,
  DEFAULT_PRESERVED_DEPS,
  PoolExhaustedError,
  isSupportedPreservePattern,
  leaseLiveness,
  normalizePreservePattern,
  pidAlive,
  readLeaseRecord,
  UnlandedWorkError,
  selectWorktreeProvider,
} from '../src/worktree/index.ts';
import type { ColdLeaseRecord } from '../src/worktree/index.ts';
import { DEFAULT_EXPENDABLE_IGNORED, inspectUnlandedWork } from '../src/delivery/durability.ts';
import { ensureDurable, durableRef } from '../src/delivery/durability.ts';

// ---------------------------------------------------------------------------------------------
// hermetic git: no global config, no system config, a fixed identity, no credential prompts.
// The modules under test merge `process.env` into every git invocation, so setting it here
// covers both the library and the raw git calls this file makes.
// ---------------------------------------------------------------------------------------------

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'army-worktree-')));
const EMPTY_GITCONFIG = join(ROOT, 'gitconfig');
writeFileSync(EMPTY_GITCONFIG, '');

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
  GIT_CONFIG_SYSTEM: EMPTY_GITCONFIG,
  GIT_AUTHOR_NAME: 'Army Test',
  GIT_AUTHOR_EMAIL: 'army@example.invalid',
  GIT_COMMITTER_NAME: 'Army Test',
  GIT_COMMITTER_EMAIL: 'army@example.invalid',
  GIT_AUTHOR_DATE: '2026-08-02T09:00:00+00:00',
  GIT_COMMITTER_DATE: '2026-08-02T09:00:00+00:00',
  GIT_TERMINAL_PROMPT: '0',
  // No test may fall back to the developer's real `~/.agentic-army/config.toml` — a hook there
  // would run for real. Every provider under test is given an explicit `home`, and this is the
  // belt to that pair of braces.
  AGENTIC_ARMY_HOME: join(ROOT, 'nonexistent-home'),
});

process.on('exit', () => {
  rmSync(ROOT, { recursive: true, force: true });
});

let caseCounter = 0;
function caseDir(label: string): string {
  caseCounter += 1;
  const dir = join(ROOT, `${String(caseCounter).padStart(2, '0')}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
}

/** The branch HEAD points at, or null when HEAD is detached — `symbolic-ref` exits 1 there. */
function symbolicHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** A repository with one commit. Anything less cannot hand out a worktree at all. */
function repoWithCommit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# hill\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '--quiet', '-m', 'base');
  return dir;
}

function fakeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    path: join(ROOT, 'nowhere'),
    leaseId: 'lease-0',
    leaseHolder: 'cpt-99',
    leasedAt: new Date().toISOString(),
    provider: 'cold',
    ...overrides,
  };
}

/**
 * A global config directory — the ONLY place a hook may legally come from. Returns the `home`
 * to hand the provider, so no test can accidentally exercise the real one.
 */
function armyHomeWith(dir: string, toml: string): string {
  const home = join(dir, 'army-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), toml);
  return home;
}

/** TOML string literal for a path or a command, escaped the way `config.toml` needs it. */
function q(value: string): string {
  return JSON.stringify(value);
}

function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

// ---------------------------------------------------------------------------------------------
// acquire — the detached-HEAD hand-out
// ---------------------------------------------------------------------------------------------

test('acquire hands out a worktree at DETACHED HEAD with a unique lease id', async () => {
  const dir = caseDir('acquire');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  const head = sh(repo, 'rev-parse', 'HEAD');
  const a = await provider.acquire('cpt-01', repo);
  const b = await provider.acquire('cpt-02', repo);

  for (const lease of [a, b]) {
    assert.equal(lease.provider, 'cold');
    assert.ok(existsSync(lease.path), `${lease.path} must exist`);
    assert.equal(sh(lease.path, 'rev-parse', 'HEAD'), head);
    // THE ISOLATION PROPERTY: a lease is handed out at DETACHED HEAD, never on a branch. The
    // Engineer must cut `army/<task-id>` itself.
    assert.equal(sh(lease.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
    assert.equal(symbolicHead(lease.path), null, 'HEAD must not be a symbolic ref');
    assert.ok(!Number.isNaN(Date.parse(lease.leasedAt)), 'leasedAt must be ISO-8601');
    assert.equal(lease.warm, false, 'a slot handed out for the first time is a cold checkout');
    assert.equal(lease.hooks.ok, true, 'no hooks configured is a vacuous success');
    assert.deepEqual(lease.hooks.ran, []);
  }

  assert.notEqual(a.path, b.path, 'concurrent leases must not share a tree');
  assert.notEqual(a.leaseId, b.leaseId, 'lease ids must be unique');
  assert.equal(a.leaseHolder, 'cpt-01');
  assert.equal(b.leaseHolder, 'cpt-02');
  assert.equal(a.slot, 1);
  assert.equal(b.slot, 2);
  assert.equal(provider.listLeases().length, 2);
});

test('acquire refuses a directory that is not a git repository, and a repo with no commits', async () => {
  const dir = caseDir('acquire-refusals');
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  const plain = join(dir, 'plain');
  mkdirSync(plain, { recursive: true });
  await assert.rejects(() => provider.acquire('cpt-01', plain), ColdWorktreeError);

  const empty = join(dir, 'empty');
  mkdirSync(empty, { recursive: true });
  sh(empty, 'init', '--quiet', '-b', 'main');
  await assert.rejects(() => provider.acquire('cpt-01', empty), ColdWorktreeError);
});

// ---------------------------------------------------------------------------------------------
// WARM REUSE — the entire point of a pool
// ---------------------------------------------------------------------------------------------

test('warm reuse: a release preserves node_modules and resets everything else', async () => {
  const dir = caseDir('warm-headline');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  writeFileSync(join(repo, 'README.md'), '# hill\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '--quiet', '-m', 'base');
  const archiveRoot = join(dir, 'archive');
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  const first = await provider.acquire('cpt-01', repo);
  assert.equal(first.warm, false, 'the first hand-out of a slot is cold');
  assert.ok(
    first.preserved.includes('node_modules'),
    'the lease must say what its release will keep',
  );

  // The expensive thing: a dependency install. 1–3 minutes on a real monorepo.
  mkdirSync(join(first.path, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(first.path, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n');
  writeFileSync(join(first.path, 'node_modules', '.install-stamp'), 'install-1\n');
  // A build output, which must NOT survive: a stale `dist/` is what the next task's tests load.
  mkdirSync(join(first.path, 'dist'), { recursive: true });
  writeFileSync(join(first.path, 'dist', 'bundle.js'), 'stale build\n');

  // Real tracked work, made durable so the fail-closed gate is satisfied honestly.
  const branch = armyBranch('warm-1');
  sh(first.path, 'checkout', '--quiet', '-b', branch);
  writeFileSync(join(first.path, 'hill.txt'), 'taken\n');
  writeFileSync(join(first.path, 'README.md'), '# hill\nedited\n');
  sh(first.path, 'add', '-A');
  sh(first.path, 'commit', '--quiet', '-m', 'take the hill');
  await ensureDurable({ worktree: first.path, branch, project: repo, archiveRoot });
  // And an untracked scratch file, which a release is allowed to destroy.
  writeFileSync(join(first.path, 'scratch.txt'), 'notes\n');

  const released = await provider.release(first, { force: true });
  assert.equal(released.outcome, 'released');
  assert.equal(released.warm, true, 'a release must keep the tree, not delete it');
  assert.ok(released.preserved.includes('node_modules'));
  assert.ok(existsSync(first.path), 'THE POINT: the tree survives its own release');

  const second = await provider.acquire('cpt-02', repo);
  assert.equal(second.path, first.path, 'precondition: the slot was reused');
  assert.equal(second.warm, true, 'and reused WARM');

  // ---- THE HEADLINE ASSERTION ----------------------------------------------------------
  assert.ok(
    existsSync(join(second.path, 'node_modules', 'left-pad', 'index.js')),
    'node_modules must survive a release, or the pool buys nothing at all',
  );
  assert.equal(
    readFileSync(join(second.path, 'node_modules', '.install-stamp'), 'utf8'),
    'install-1\n',
    'and survive INTACT — a re-created empty directory would be a cold install wearing a hat',
  );

  // ---- and the tree is otherwise pristine ----------------------------------------------
  assert.equal(sh(second.path, 'status', '--porcelain'), '', 'tracked content is clean');
  assert.equal(symbolicHead(second.path), null, 'handed out detached again');
  assert.equal(sh(second.path, 'rev-parse', 'HEAD'), sh(repo, 'rev-parse', 'HEAD'));
  assert.equal(existsSync(join(second.path, 'hill.txt')), false, "the last holder's commit is gone");
  assert.equal(existsSync(join(second.path, 'scratch.txt')), false, 'untracked scratch is gone');
  assert.equal(
    existsSync(join(second.path, 'dist', 'bundle.js')),
    false,
    'a build output is NOT preserved: a stale artifact poisons the run that loads it',
  );
  assert.equal(readFileSync(join(second.path, 'README.md'), 'utf8'), '# hill\n', 'tracked edit reverted');

  // The branch the first holder cut is deletable, because the idle tree was left DETACHED.
  // A tree parked on `army/warm-1` would make this fail with "checked out at …".
  sh(repo, 'branch', '-D', branch);
});

test('warm reuse survives repetition, and `warm = false` opts out of it entirely', async () => {
  const dir = caseDir('warm-repeat');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'README.md'), '# hill\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '--quiet', '-m', 'base');

  const warmProvider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });
  let lease = await warmProvider.acquire('cpt-01', repo);
  mkdirSync(join(lease.path, 'node_modules'), { recursive: true });
  writeFileSync(join(lease.path, 'node_modules', 'dep.js'), 'dep\n');
  const treePath = lease.path;

  for (let round = 1; round <= 3; round++) {
    await warmProvider.release(lease);
    lease = await warmProvider.acquire(`cpt-0${round + 1}`, repo);
    assert.equal(lease.path, treePath, `round ${round}: same slot`);
    assert.equal(lease.warm, true, `round ${round}: still warm`);
    assert.ok(
      existsSync(join(lease.path, 'node_modules', 'dep.js')),
      `round ${round}: dependencies must survive EVERY release, not just the first`,
    );
  }
  await warmProvider.release(lease);

  // `warm = false` is the escape hatch for someone who does not trust reuse. It must actually
  // clean, or the setting is a lie.
  const home = armyHomeWith(dir, '[worktree]\nwarm = false\n');
  const coldProvider = new ColdWorktreeProvider({ root: join(dir, 'pool-cold'), home });
  const cold = await coldProvider.acquire('cpt-09', repo);
  mkdirSync(join(cold.path, 'node_modules'), { recursive: true });
  writeFileSync(join(cold.path, 'node_modules', 'dep.js'), 'dep\n');
  assert.deepEqual(cold.preserved, [], 'nothing is preserved when warm is off');
  const releasedCold = await coldProvider.release(cold);
  assert.equal(releasedCold.warm, false);
  assert.equal(existsSync(cold.path), false, 'warm = false destroys the tree, as it used to');
});

/**
 * REGRESSION — THE POOL DRAIN. A warm slot used to inherit the previous holder's per-worktree
 * reflog, and the release gate reads that reflog to find work whose branch HEAD has moved away.
 * So a later holder that committed, landed its work durably and left a clean tree was refused
 * release for a commit that was not its own; `campaign` then RETAINS the tree, and the bounded
 * pool drains one slot at a time until nothing can be acquired.
 *
 * The reflog is the same shape of bug `stashBase` was invented for — a signal that outlives a
 * lease — and the fix is applied at the boundary rather than at one consumer: every input the
 * gate reads must describe THIS lease.
 */
test('a warm slot does not inherit the previous holder\'s reflog — the pool must not drain', async () => {
  const dir = caseDir('reflog-drain');
  const repo = repoWithCommit(join(dir, 'repo'));
  const archiveRoot = join(dir, 'archive');
  const provider = new ColdWorktreeProvider({
    root: join(dir, 'pool'),
    maxSlots: 1,
    home: join(dir, 'home'),
  });

  // Holder 1 does everything right: cuts a branch, commits, makes it durable, releases clean.
  const first = await provider.acquire('cpt-01', repo);
  const branch = armyBranch('drain-1');
  sh(first.path, 'checkout', '--quiet', '-b', branch);
  writeFileSync(join(first.path, 'hill.txt'), 'taken\n');
  sh(first.path, 'add', '-A');
  sh(first.path, 'commit', '--quiet', '-m', 'take the hill');
  await ensureDurable({ worktree: first.path, branch, project: repo, archiveRoot });
  assert.equal((await provider.release(first)).outcome, 'released');

  // Holder 2 inherits the slot. Its own work is trivial and entirely durable.
  const second = await provider.acquire('cpt-02', repo);
  assert.equal(second.path, first.path, 'precondition: the same slot, warm');
  assert.equal(second.warm, true);
  assert.equal(sh(second.path, 'status', '--porcelain'), '', 'and it is clean');

  const detail = await inspectUnlandedWork(second.path, sh(repo, 'rev-parse', 'HEAD'));
  assert.deepEqual(
    detail.candidates.filter((sha) => sha !== sh(repo, 'rev-parse', 'HEAD')),
    [],
    "the gate must see nothing but this lease's own base — no ghost of cpt-01",
  );

  const releasedSecond = await provider.release(second);
  assert.equal(
    releasedSecond.outcome,
    'released',
    "a clean lease must not be refused for the PREVIOUS holder's commit",
  );

  // And it must not degrade: the same slot, cycle after cycle, each holder leaving work behind
  // in a different shape — durable, force-abandoned, and clean.
  for (let cycle = 1; cycle <= 4; cycle++) {
    const lease = await provider.acquire(`cpt-1${cycle}`, repo);
    assert.equal(lease.path, first.path, `cycle ${cycle}: still one slot`);
    const cycleBranch = armyBranch(`drain-cycle-${cycle}`);
    sh(lease.path, 'checkout', '--quiet', '-b', cycleBranch);
    writeFileSync(join(lease.path, `work-${cycle}.txt`), 'work\n');
    sh(lease.path, 'add', '-A');
    sh(lease.path, 'commit', '--quiet', '-m', `cycle ${cycle}`);
    if (cycle % 2 === 0) {
      // An abandoned lease: forced out with work that never became durable. This is the case
      // that poisons the slot for everyone after it if the reflog carries over.
      await provider.release(lease, { force: true });
    } else {
      await ensureDurable({ worktree: lease.path, branch: cycleBranch, project: repo, archiveRoot });
      const result = await provider.release(lease);
      assert.equal(result.outcome, 'released', `cycle ${cycle}: a durable lease releases cleanly`);
    }
  }

  // The pool is still usable after all of that, which is the property that actually matters.
  const final = await provider.acquire('cpt-99', repo);
  assert.equal(final.path, first.path);
  const releasedFinal = await provider.release(final);
  assert.equal(releasedFinal.outcome, 'released', 'the slot survived every previous holder');
  assert.equal(provider.listLeases().length, 0, 'and the pool is not drained');
});

/**
 * REGRESSION — THE SAME DRAIN THROUGH THE UNTRACKED LIST. Plenty of repositories never
 * `.gitignore` their dependency directory, because nothing in them ever commits near it. In one
 * of those, a preserved `node_modules` is invisible to `ignoredPresent` and shows up in
 * `git status --porcelain` as `?? node_modules/`. The pool preserves it across the reset, so
 * every later holder inherits it — and an honest holder that branched, committed and landed its
 * work durably was refused release over a directory nothing was going to delete. A refusal makes
 * the supervisor RETAIN the tree, so the bounded pool drains a slot at a time.
 *
 * The rule that fixes it is one sentence: THE GATE MUST NOT BLOCK ON WHAT THE RELEASE WILL NOT
 * DESTROY — applied to both lists a preserved directory can appear in, from the one preserved
 * set the reset is given.
 */
test('an untracked preserved directory never blocks a release — the pool must not drain', async () => {
  const dir = caseDir('untracked-preserved');
  // NOTE THE ABSENT `.gitignore`. That is the whole variable.
  const repo = repoWithCommit(join(dir, 'repo'));
  const archiveRoot = join(dir, 'archive');
  const provider = new ColdWorktreeProvider({
    root: join(dir, 'pool'),
    maxSlots: 1,
    home: join(dir, 'home'),
  });

  const first = await provider.acquire('cpt-01', repo);
  mkdirSync(join(first.path, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(first.path, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n');
  writeFileSync(join(first.path, 'node_modules', '.install-stamp'), 'install-1\n');
  assert.equal(
    sh(first.path, 'status', '--porcelain'),
    '?? node_modules/',
    'precondition: untracked, NOT ignored — invisible to the ignored-files half of the gate',
  );
  assert.equal(
    (await provider.release(first)).outcome,
    'released',
    'even the first holder must not need force for a directory the release is keeping',
  );

  // Several cycles, each holder doing everything right, none of them allowed to need force.
  for (let cycle = 1; cycle <= 5; cycle++) {
    const lease = await provider.acquire(`cpt-1${cycle}`, repo);
    assert.equal(lease.path, first.path, `cycle ${cycle}: one slot, reused`);
    assert.equal(lease.warm, true, `cycle ${cycle}: warm`);
    assert.equal(
      sh(lease.path, 'status', '--porcelain'),
      '?? node_modules/',
      `cycle ${cycle}: the inherited directory is still there and still untracked`,
    );

    const branch = armyBranch(`untracked-${cycle}`);
    sh(lease.path, 'checkout', '--quiet', '-b', branch);
    writeFileSync(join(lease.path, `work-${cycle}.txt`), 'honest work\n');
    sh(lease.path, 'add', `work-${cycle}.txt`);
    sh(lease.path, 'commit', '--quiet', '-m', `cycle ${cycle}`);
    await ensureDurable({ worktree: lease.path, branch, project: repo, archiveRoot });

    const released = await provider.release(lease);
    assert.equal(
      released.outcome,
      'released',
      `cycle ${cycle}: an honest holder must NEVER need force because of an inherited dependency`,
    );
    assert.equal(released.warm, true);
    assert.equal(
      readFileSync(join(lease.path, 'node_modules', '.install-stamp'), 'utf8'),
      'install-1\n',
      `cycle ${cycle}: and the dependencies are still the ones installed at the start`,
    );
  }
  assert.equal(provider.listLeases().length, 0, 'the pool is not drained');

  // THE OTHER DIRECTION, so the exemption is not a hole. Only UNTRACKED paths are waived, and
  // only for the preserved set: real work still blocks, including work inside a preserved
  // directory once it is tracked, and including a release that will actually destroy the tree.
  const guard = await provider.acquire('cpt-90', repo);
  writeFileSync(join(guard.path, 'notes.md'), 'a night of work\n');
  await assert.rejects(() => provider.release(guard), (error: unknown) => {
    assert.ok(error instanceof UnlandedWorkError);
    assert.deepEqual(error.detail.dirtyPaths, ['?? notes.md'], 'the preserved dir is not in it');
    return true;
  });
  rmSync(join(guard.path, 'notes.md'));

  // A TRACKED file under a preserved directory is real work — many Go repos commit `vendor/` —
  // so a modification to one must go on blocking even though the directory is preserved.
  sh(guard.path, 'add', '-f', join('node_modules', '.install-stamp'));
  sh(guard.path, 'commit', '--quiet', '-m', 'this repo commits its deps');
  writeFileSync(join(guard.path, 'node_modules', '.install-stamp'), 'edited by hand\n');
  await assert.rejects(() => provider.release(guard), (error: unknown) => {
    assert.ok(error instanceof UnlandedWorkError);
    // `git()` trims, so the first porcelain line arrives without its leading status space.
    assert.deepEqual(error.detail.dirtyPaths, ['M node_modules/.install-stamp']);
    return true;
  });

  // And a release that really will destroy the tree exempts nothing.
  sh(guard.path, 'checkout', '--', 'node_modules/.install-stamp');
  writeFileSync(join(guard.path, 'node_modules', 'fresh.js'), 'untracked again\n');
  await assert.rejects(
    () => provider.release(guard, { discard: true }),
    (error: unknown) => {
      assert.ok(error instanceof UnlandedWorkError);
      assert.ok(error.detail.dirtyPaths.some((line) => line.includes('node_modules')));
      return true;
    },
  );
  await provider.release(guard, { force: true, discard: true });
});

test('the warm reset removes untracked debris, including a nested repository', async () => {
  const dir = caseDir('warm-clean');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  const first = await provider.acquire('cpt-01', repo);
  mkdirSync(join(first.path, 'scratch', 'deep'), { recursive: true });
  writeFileSync(join(first.path, 'scratch', 'deep', 'note.txt'), 'debris\n');
  // A nested repository: `clean -fdx` (one f) leaves this behind and the next task inherits it.
  const nested = join(first.path, 'nested');
  mkdirSync(nested, { recursive: true });
  sh(nested, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(nested, 'file.txt'), 'nested\n');

  // Untracked debris is exactly what the fail-closed gate protects, so this needs `force` —
  // which is the caller saying "I know, destroy it".
  await assert.rejects(() => provider.release(first), UnlandedWorkError);
  await provider.release(first, { force: true });
  const second = await provider.acquire('cpt-02', repo);
  assert.equal(second.path, first.path);
  assert.equal(existsSync(join(second.path, 'scratch')), false, 'untracked directories go');
  assert.equal(existsSync(nested), false, 'a nested repository goes too — `-ff`, not `-f`');
  assert.equal(sh(second.path, 'status', '--porcelain'), '');
});

// ---------------------------------------------------------------------------------------------
// warm preservation vs the ignored-files gate — the two must agree, in both directions
// ---------------------------------------------------------------------------------------------

test('preserved dependency directories never block a release; an unexpected ignored file still does', async () => {
  const dir = caseDir('gate-agreement');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\nvendor/\ndist/\n*.env\n');
  writeFileSync(join(repo, 'README.md'), '# hill\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '--quiet', '-m', 'base');
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  // `vendor` is in the PRESERVED set but NOT in `DEFAULT_EXPENDABLE_IGNORED`. It is the case
  // that proves the two lists are wired together rather than maintained in parallel: if the
  // provider did not pass its preserved set to the gate, this release would block forever and
  // a Go repo would deadlock the pool.
  assert.ok(DEFAULT_PRESERVED_DEPS.includes('vendor'));
  assert.ok(
    !DEFAULT_EXPENDABLE_IGNORED.includes('vendor'),
    'precondition: the gate does not know about `vendor` on its own',
  );

  const first = await provider.acquire('cpt-07', repo);
  mkdirSync(join(first.path, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(first.path, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n');
  mkdirSync(join(first.path, 'vendor', 'github.com'), { recursive: true });
  writeFileSync(join(first.path, 'vendor', 'github.com', 'dep.go'), 'package dep\n');
  mkdirSync(join(first.path, 'dist'), { recursive: true });
  writeFileSync(join(first.path, 'dist', 'bundle.js'), 'built\n');
  assert.equal(sh(first.path, 'status', '--porcelain'), '', 'ignored files are invisible to status');

  const released = await provider.release(first);
  assert.equal(released.outcome, 'released');
  assert.ok(existsSync(join(first.path, 'vendor', 'github.com', 'dep.go')), 'and it is preserved');

  // A secret written inside the tree is a different matter: a release deletes it, `status` never
  // mentions it, and the global deny-list exists partly to keep agents away from this exact file.
  const second = await provider.acquire('cpt-08', repo);
  writeFileSync(join(second.path, 'secret.env'), 'TOKEN=hunter2\n');
  assert.equal(sh(second.path, 'status', '--porcelain'), '');

  await assert.rejects(
    () => provider.release(second),
    (error: unknown) => {
      assert.ok(error instanceof UnlandedWorkError);
      assert.equal(error.detail.dirty, false);
      assert.deepEqual(error.detail.preciousIgnored, ['secret.env']);
      assert.match(error.message, /secret\.env/);
      return true;
    },
  );
  assert.ok(existsSync(join(second.path, 'secret.env')), 'the refusal must destroy nothing');
  assert.ok(
    existsSync(join(second.path, 'node_modules', 'left-pad', 'index.js')),
    'and the warm dependencies from the previous holder are still there',
  );

  // Forcing is still available, and still explicit.
  await provider.release(second, { force: true });

  // The other direction of the same coupling: with `warm = false` nothing is preserved, so an
  // ignored `vendor/` IS at risk from the release and the gate correctly starts blocking again.
  const home = armyHomeWith(dir, '[worktree]\nwarm = false\n');
  const strict = new ColdWorktreeProvider({ root: join(dir, 'pool-strict'), home });
  const third = await strict.acquire('cpt-10', repo);
  mkdirSync(join(third.path, 'vendor'), { recursive: true });
  writeFileSync(join(third.path, 'vendor', 'dep.go'), 'package dep\n');
  await assert.rejects(
    () => strict.release(third),
    (error: unknown) => {
      assert.ok(error instanceof UnlandedWorkError);
      assert.deepEqual(error.detail.preciousIgnored, ['vendor/']);
      return true;
    },
  );
  await strict.release(third, { force: true });
});

// ---------------------------------------------------------------------------------------------
// lifecycle hooks — and the rule that they may come only from the user's global config
// ---------------------------------------------------------------------------------------------

test('post_create runs in the worktree, on provision AND on every warm reset', async () => {
  const dir = caseDir('post-create');
  const repo = repoWithCommit(join(dir, 'repo'));
  const log = join(dir, 'post-create.log');
  const home = armyHomeWith(
    dir,
    `[projects.${q(repo)}]\n` +
      `post_create = [${q(`printf '%s %s %s\\n' "$ARMY_WARM" "$PWD" "$ARMY_LEASE_HOLDER" >> ${log}`)}]\n`,
  );
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home });

  const first = await provider.acquire('cpt-01', repo);
  assert.equal(first.hooks.ok, true, first.hooks.failure?.output ?? '');
  assert.equal(first.hooks.ran.length, 1);
  assert.equal(first.hooks.ran[0]?.code, 0);
  assert.equal(first.hooks.source, join(home, 'config.toml'), 'the source must be nameable');

  await provider.release(first);
  const second = await provider.acquire('cpt-02', repo);
  await provider.release(second);
  const third = await provider.acquire('cpt-03', repo);
  await provider.release(third);

  const lines = readLines(log);
  assert.equal(lines.length, 3, 'once per acquire: after the checkout AND after every warm reset');
  assert.deepEqual(
    lines.map((line) => line.split(' ')[0]),
    ['0', '1', '1'],
    'ARMY_WARM tells the hook whether it is installing from scratch or incrementally',
  );
  for (const line of lines) {
    // `pnpm install --frozen-lockfile` has to land in the tree it is warming.
    assert.equal(line.split(' ')[1], first.path, 'hooks run IN the worktree directory');
  }
  assert.deepEqual(
    lines.map((line) => line.split(' ')[2]),
    ['cpt-01', 'cpt-02', 'cpt-03'],
  );
});

test('a post_create failure is reported on the lease, not swallowed and not fatal', async () => {
  const dir = caseDir('hook-failure');
  const repo = repoWithCommit(join(dir, 'repo'));
  const marker = join(dir, 'second-ran');
  const home = armyHomeWith(
    dir,
    `[projects.${q(repo)}]\n` +
      `post_create = [${q('echo "install failed"; exit 3')}, ${q(`touch ${marker}`)}]\n`,
  );
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home });

  // NOT a rejection. The tree is real, isolated and correctly leased; only the warm-up failed.
  const lease = await provider.acquire('cpt-01', repo);
  assert.equal(lease.hooks.ok, false);
  assert.equal(lease.hooks.failure?.code, 3);
  assert.match(lease.hooks.failure?.output ?? '', /install failed/);
  assert.equal(lease.hooks.skipped, 1, 'a build after a failed install only buries the real error');
  assert.equal(existsSync(marker), false);

  // …and the tree is still usable, which is why failing the acquire would have been wrong.
  assert.ok(existsSync(join(lease.path, 'README.md')));
  assert.equal(symbolicHead(lease.path), null);
  await provider.release(lease);

  // A command that cannot start at all is the same kind of news, with a different shape.
  const missing = armyHomeWith(
    join(dir, 'missing'),
    `[projects.${q(repo)}]\npost_create = [["army-absent-binary-6f1c2d", "--version"]]\n`,
  );
  const other = new ColdWorktreeProvider({ root: join(dir, 'pool2'), home: missing });
  const second = await other.acquire('cpt-02', repo);
  assert.equal(second.hooks.ok, false);
  assert.equal(second.hooks.failure?.code, null, 'it never ran, so there is no exit code to report');
  assert.match(second.hooks.failure?.error ?? '', /not found on PATH/);
  await other.release(second);
});

test('pre_destroy runs before the reset, and its failure never leaks the slot', async () => {
  const dir = caseDir('pre-destroy');
  const repo = repoWithCommit(join(dir, 'repo'));
  const log = join(dir, 'pre-destroy.log');
  const home = armyHomeWith(
    dir,
    `[projects.${q(repo)}]\n` +
      `pre_destroy = [${q(`printf '%s %s\\n' "$ARMY_HOOK" "$(cat about-to-die.txt)" >> ${log}`)}, ` +
      `${q('exit 7')}]\n`,
  );
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home });

  const lease = await provider.acquire('cpt-01', repo);
  writeFileSync(join(lease.path, 'about-to-die.txt'), 'still-here\n');

  const released = await provider.release(lease, { force: true });
  assert.equal(released.outcome, 'released', 'a failing cleanup command must not leak a pool slot');
  assert.equal(released.warm, true);
  assert.equal(released.hooks?.ok, false);
  assert.equal(released.hooks?.failure?.code, 7);
  assert.deepEqual(
    readLines(log),
    ['pre_destroy still-here'],
    'pre_destroy sees the tree with its contents still in place',
  );
  assert.equal(provider.listLeases().length, 0, 'the slot is free');
  assert.equal(
    existsSync(join(lease.path, 'about-to-die.txt')),
    false,
    'and the reset happened anyway',
  );
});

/**
 * THE SECURITY TEST. A `post_create` hook is arbitrary command execution, so reading one out of
 * the repository would make `git clone` remote code execution — the identical hole closed for
 * delivery ceilings by keying them on absolute path in the user's own config, and the one
 * treehouse's own documentation warns about.
 *
 * INSTRUMENTATION, because "nothing ran" must not be able to pass for the wrong reason:
 *   - every planted command appends its own tag to ONE shared canary file, so a hit is loud;
 *   - a CONTROL hook with the same shape lives in the user's global config and MUST appear in
 *     that same file. If the runner were broken, or the canary path wrong, or the shell missing,
 *     the control assertion goes red and the test cannot report a false pass;
 *   - the planted files are committed, so they are present in the leased tree as well as the
 *     repo, and the tree is acquired twice (cold, then warm) so both provisioning paths are
 *     covered;
 *   - AND the environment overlay is planted too. That is the hole that was actually open: the
 *     provider forwarded `options.env` into the hook-config resolver, so
 *     `env: { AGENTIC_ARMY_HOME: '<repo>' }` was a second override that executed a
 *     repo-committed `config.toml`, while the header claimed no such parameter existed. The
 *     file plants alone would never have caught it, so they are not the whole test any more.
 */
test('repo-local hook definitions NEVER run — only the user global config may define hooks', async () => {
  const dir = caseDir('repo-hooks');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '--quiet', '-b', 'main');
  const canary = join(dir, 'canary.log');
  const fire = (tag: string): string => `printf '%s\\n' ${tag} >> ${canary}`;

  // Seven plausible spellings of "the repo tells your machine what to run". None may fire.
  const planted: Record<string, string> = {
    // The one the environment overlay would have pointed at: `configPath('<repo>')`.
    'config.toml': `[projects.${q(repo)}]\npost_create = [${q(fire('repo-root-config-toml'))}]\n`,
    'treehouse.toml': `[hooks]\npost_create = [${q(fire('treehouse-toml'))}]\n`,
    '.treehouse.toml': `[hooks]\npost_create = [${q(fire('dot-treehouse-toml'))}]\n`,
    '.agentic-army.toml': `[worktree]\npost_create = [${q(fire('repo-agentic-army-toml'))}]\n`,
    'agentic-army.toml': `[worktree]\npost_create = [${q(fire('bare-agentic-army-toml'))}]\n`,
    // The sneakiest: the same basename and relative path as the real global config.
    '.agentic-army/config.toml':
      `[projects.${q(repo)}]\npost_create = [${q(fire('repo-dot-agentic-army-config'))}]\n`,
    '.army/hooks.toml': `post_create = [${q(fire('army-hooks-toml'))}]\n`,
    'package.json': JSON.stringify(
      {
        name: 'hostile',
        agenticArmy: { post_create: [fire('package-json-field')] },
        worktree: { post_create: [fire('package-json-worktree')] },
        scripts: { postinstall: fire('package-json-postinstall') },
      },
      null,
      2,
    ),
  };
  for (const [file, contents] of Object.entries(planted)) {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), contents);
  }
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '--quiet', '-m', 'a repository that would like to run commands on your machine');

  // THE CONTROL: the same mechanism, in the only place it is allowed to live.
  const home = armyHomeWith(dir, `[projects.${q(repo)}]\npost_create = [${q(fire('global'))}]\n`);
  // EVERY environment variable that could relocate army config, aimed straight at the repo —
  // exactly how the hole was demonstrated. The provider must resolve its config file from `home`
  // and the real process environment, and strip these from the bag it forwards to git and hooks.
  const hostileEnv: Record<string, string> = {};
  for (const name of CONFIG_RELOCATING_ENV_VARS) hostileEnv[name] = repo;
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home, env: hostileEnv });
  assert.equal(
    provider.hookConfigFile,
    join(home, 'config.toml'),
    'the config path is fixed at construction, and the overlay cannot move it',
  );

  const first = await provider.acquire('cpt-01', repo);
  assert.equal(first.hooks.ok, true, first.hooks.failure?.output ?? 'the control hook must run');
  await provider.release(first);
  const second = await provider.acquire('cpt-02', repo); // the warm path, same question
  assert.equal(second.warm, true);
  await provider.release(second);

  const fired = readLines(canary);
  assert.deepEqual(
    fired,
    ['global', 'global'],
    'the ONLY thing that may run is the hook from the user\'s own global config',
  );
  // Belt and braces: the planted files really are there and really are readable, so "nothing
  // fired" is a statement about the provider and not about a mis-planted fixture.
  for (const file of Object.keys(planted)) {
    assert.ok(existsSync(join(repo, file)), `${file} must exist for this test to mean anything`);
    assert.ok(existsSync(join(first.path, file)), `${file} must be present in the leased tree too`);
  }
  assert.equal(fired.length, 2, 'exactly one control firing per acquire');

  // THE EXPLOIT AS IT ACTUALLY LANDED: no `home` at all — which is how `campaign.ts` builds the
  // provider — and a hostile `AGENTIC_ARMY_HOME` in the forwarded env, aimed at the repo whose
  // `config.toml` is committed above. The resolver must read the REAL process environment.
  const noHome = new ColdWorktreeProvider({
    root: join(dir, 'pool-no-home'),
    env: { AGENTIC_ARMY_HOME: repo, HOME: repo },
  });
  // The execution check comes FIRST, so that a regression here reads as "the repo's command ran"
  // rather than as a path mismatch. That is the failure anyone needs to see.
  const exploit = await noHome.acquire('cpt-04', repo);
  await noHome.release(exploit, { force: true });
  assert.deepEqual(
    readLines(canary),
    ['global', 'global'],
    'a repo-committed config.toml must not execute, however the environment is aimed',
  );
  assert.equal(
    noHome.hookConfigFile,
    join(process.env['AGENTIC_ARMY_HOME'] ?? '', 'config.toml'),
    'with no `home`, the path comes from the real environment — never the forwarded bag',
  );

  // And the stripping really happened, so a nested `army` run by a hook cannot be relocated
  // either. `ARMY_WORKTREE` proves the surrounding env was still delivered.
  const envLog = join(dir, 'env.log');
  const envHome = armyHomeWith(
    join(dir, 'env-probe'),
    `[projects.${q(repo)}]\n` +
      `post_create = [${q(`printf '%s|%s|%s\\n' "\${AGENTIC_ARMY_HOME-unset}" "\${MARKER-unset}" "$ARMY_WORKTREE" >> ${envLog}`)}]\n`,
  );
  const sanitised = new ColdWorktreeProvider({
    root: join(dir, 'pool2'),
    home: envHome,
    env: { ...hostileEnv, MARKER: 'kept' },
  });
  const probe = await sanitised.acquire('cpt-03', repo);
  await sanitised.release(probe, { force: true });
  const [line] = readLines(envLog);
  const [seenHome, seenMarker, seenWorktree] = (line ?? '').split('|');
  assert.notEqual(seenHome, repo, 'the hostile AGENTIC_ARMY_HOME must not reach the hook');
  assert.equal(seenHome, process.env['AGENTIC_ARMY_HOME'], 'the real one is what a child sees');
  assert.equal(seenMarker, 'kept', 'and stripping is surgical: other variables still arrive');
  assert.equal(seenWorktree, probe.path);
});

/**
 * "PRESERVED ⊆ EXPENDABLE, BY CONSTRUCTION" was true only for bare segments. `git clean -e`
 * speaks full gitignore syntax; the release gate matches whole path SEGMENTS. Any pattern the
 * first honours and the second cannot see is a file that survives every reset and then blocks
 * every release of that slot — permanent force-only release, arriving through a config key users
 * were invited to set. So the two are made to agree at BOTH ends: what cannot be matched
 * identically by both is rejected at load, loudly.
 */
test('preserve patterns the release gate cannot match are rejected, not silently honoured', async () => {
  const dir = caseDir('preserve-patterns');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '*.cache\nbazel-out/\n');
  writeFileSync(join(repo, 'README.md'), '# hill\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '--quiet', '-m', 'base');

  // The claim, checked against the shipped defaults rather than asserted about them.
  for (const entry of DEFAULT_PRESERVED_DEPS) {
    assert.ok(isSupportedPreservePattern(entry), `${entry} must be matchable by both sides`);
    assert.equal(normalizePreservePattern(entry), entry, `${entry} is already normal form`);
  }

  const rejected = ['*.cache', 'build/*.o', 'packages/api/node_modules', '!node_modules',
    '../OUTSIDE', '/', '/anchored', '.', '..', 'a\\b'];
  for (const entry of rejected) {
    assert.equal(isSupportedPreservePattern(entry), false, `${entry} must be rejected`);
  }
  // A trailing slash is the one form that IS normalisable: `bazel-out/` and `bazel-out` mean the
  // same directory to `git clean`, and the bare segment is what the gate can match.
  assert.ok(isSupportedPreservePattern('bazel-out/'));
  assert.equal(normalizePreservePattern('bazel-out/'), 'bazel-out');

  const home = armyHomeWith(
    dir,
    `[worktree]\npreserve = [${rejected.map(q).join(', ')}, "bazel-out/"]\n`,
  );
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home });
  const settings = await provider.settingsFor(repo);

  assert.equal(
    settings.warnings.length,
    rejected.length,
    `one warning per rejected pattern:\n${settings.warnings.join('\n')}`,
  );
  assert.ok(settings.warnings.every((w) => w.includes('blocks every release')));
  assert.deepEqual(
    settings.preserve.filter((entry) => !DEFAULT_PRESERVED_DEPS.includes(entry)),
    ['bazel-out'],
    'only the normalisable one survives, in its normal form',
  );
  for (const entry of settings.preserve) {
    assert.ok(isSupportedPreservePattern(entry), `${entry} reached git clean unvalidated`);
  }

  // End to end. `bazel-out/` normalised, so both sides agree: preserved by the reset, invisible
  // to the gate. That is the pattern doing what the user asked.
  const lease = await provider.acquire('cpt-01', repo);
  mkdirSync(join(lease.path, 'bazel-out'), { recursive: true });
  writeFileSync(join(lease.path, 'bazel-out', 'artifact'), 'built\n');
  const releasedFirst = await provider.release(lease);
  assert.equal(releasedFirst.outcome, 'released', 'a preserved directory must never block');
  assert.ok(existsSync(join(lease.path, 'bazel-out', 'artifact')), 'and it survives the reset');

  // `*.cache` was REJECTED, so `foo.cache` is not preserved and gets no special standing: it is
  // an unexpected ignored file, and the gate asks about it exactly as it asks about `secret.env`.
  // Fail-closed is the right direction here — but the point is that it is TEMPORARY. One forced
  // release deletes the file and the slot is immediately normal again.
  //
  // Honouring the pattern instead is what would be permanent: the file would survive every reset
  // and the gate would never learn to match it, so every release of that tree, forever, would
  // need `force`. That is the drain this finding was about.
  const second = await provider.acquire('cpt-02', repo);
  writeFileSync(join(second.path, 'foo.cache'), 'cached\n');
  assert.equal(sh(second.path, 'status', '--porcelain'), '', 'ignored, so status is quiet');
  await assert.rejects(
    () => provider.release(second),
    (error: unknown) => {
      assert.ok(error instanceof UnlandedWorkError);
      assert.deepEqual(error.detail.preciousIgnored, ['foo.cache']);
      return true;
    },
  );
  const forced = await provider.release(second, { force: true });
  assert.equal(forced.warm, true);
  assert.equal(existsSync(join(second.path, 'foo.cache')), false, 'the reset cleaned it');

  // THE PROPERTY: the slot is not poisoned. The next holder releases normally, no force.
  const third = await provider.acquire('cpt-03', repo);
  assert.equal(third.path, lease.path);
  assert.equal(
    (await provider.release(third)).outcome,
    'released',
    'a rejected pattern must not leave the slot permanently force-only',
  );
  assert.ok(existsSync(join(third.path, 'bazel-out', 'artifact')), 'and bazel-out is still warm');
});

/**
 * A test guarding a safety property does not count until it has been seen to fail, and that is
 * the reason this test exists in this shape: the version it replaces iterated
 * `CONFIG_RELOCATING_ENV_VARS` and asked whether each entry was stripped — which is a tautology.
 * An Inspector added a new input to `armyHome()` and the whole suite stayed green, while a
 * comment of mine claimed the test "pinned the pair". It did not.
 *
 * So the expected set is DERIVED from the things that actually resolve the config path:
 *   - every environment key `src/config/paths.ts` reads, parsed out of its source;
 *   - and `os.homedir()`'s own inputs, observed by running it in a child process.
 * Add a new input to either and this goes red without anyone remembering to update a list.
 */
test('the config-relocating strip list cannot fall behind what resolves the config', async () => {
  const pathsModule = new URL('../src/config/paths.ts', import.meta.url);
  const pathsSource = readFileSync(pathsModule, 'utf8');

  // Resolve `env['X']`, `process.env['X']`, `env[X]` and `env.X`. An identifier is looked up as
  // a `const X = '…'` in the same file; anything that CANNOT be resolved fails the test rather
  // than being skipped, because an unreadable read is exactly the one that would slip through.
  const reads = [...pathsSource.matchAll(/(?:process\.)?env(?:\[([^\]]+)\]|\.([A-Za-z_$][\w$]*))/g)];
  assert.ok(reads.length > 0, 'the parser must find the reads it is meant to check');

  const derived = new Set<string>();
  for (const match of reads) {
    const raw = (match[1] ?? match[2] ?? '').trim();
    const quoted = /^['"`](.*)['"`]$/.exec(raw);
    if (quoted !== null) {
      derived.add(quoted[1]!);
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(raw)) {
      const constant = new RegExp(`\\b${raw}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`).exec(pathsSource);
      assert.ok(constant !== null, `cannot resolve \`env[${raw}]\` — teach this parser or inline it`);
      derived.add(constant![1]!);
      continue;
    }
    assert.fail(`unparseable environment read \`env[${raw}]\` in src/config/paths.ts`);
  }

  assert.ok(derived.has('AGENTIC_ARMY_HOME'), 'sanity: the known override must be derived, not assumed');

  // Being READ by `src/config/paths.ts` is not the same as being able to RELOCATE the config,
  // and the difference arrived the day `armyHome` started reading `NODE_TEST_CONTEXT` — the
  // tripwire that makes it refuse inside the test runner instead of resolving the developer's
  // own archive. That variable can make the resolver throw; it cannot make it answer somewhere
  // else, and stripping it from a hook overlay would protect nothing.
  //
  // So which is which is OBSERVED rather than declared. Naming the exception in a list here is
  // precisely the tautology this test was rewritten to escape: the list would be updated by
  // whoever added the read, which is whoever would have got it wrong. Each derived name is set
  // to a sentinel PATH in a child, and `armyHome`'s own answer decides. Answer moves to the
  // sentinel -> it relocates the config -> it must be stripped.
  let relocating = 0;
  for (const name of derived) {
    const sentinel = join(ROOT, `sentinel-${name}`);
    const childEnv: Record<string, string | undefined> = { ...process.env };
    // Cleared so the observation is of the resolver rather than of the tripwire, and so a
    // stray override in the developer's shell cannot answer for the variable under test.
    delete childEnv['NODE_TEST_CONTEXT'];
    delete childEnv['AGENTIC_ARMY_HOME'];
    childEnv[name] = sentinel;

    const observed = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { armyHome } = await import(${JSON.stringify(pathsModule.href)});
try { process.stdout.write(armyHome()); } catch { process.stdout.write('<refused>'); }`,
      ],
      { encoding: 'utf8', env: childEnv, stdio: ['ignore', 'pipe', 'ignore'] },
    );

    if (observed.includes(sentinel)) {
      relocating += 1;
      assert.ok(
        CONFIG_RELOCATING_ENV_VARS.includes(name),
        `src/config/paths.ts reads ${name} and setting it moved the resolved home to ${observed}, ` +
          'so it relocates the config and MUST be stripped',
      );
    } else {
      assert.notEqual(
        observed,
        '',
        `the child observing ${name} printed nothing; the observation, not the variable, is broken`,
      );
    }
  }
  assert.ok(
    relocating > 0,
    'no derived variable was observed to move the resolved home — the observation is broken, ' +
      'and a broken observation exempts every variable it looks at',
  );

  // `os.homedir()` is native, so its inputs are observed rather than parsed. This is what makes
  // `HOME` provably a config-relocating variable on this platform rather than a guess.
  const sentinel = join(ROOT, 'sentinel-home');
  const homedirVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const observed = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(require("node:os").homedir())'],
    { encoding: 'utf8', env: { ...process.env, [homedirVar]: sentinel } },
  ).trim();
  assert.equal(observed, sentinel, `os.homedir() follows $${homedirVar} on this platform`);
  assert.ok(
    CONFIG_RELOCATING_ENV_VARS.includes(homedirVar),
    `${homedirVar} steers os.homedir(), which is armyHome()'s fallback, so it must be stripped`,
  );
  // The other platform's inputs cannot be observed here. They are pinned as a list because the
  // strip set must be platform-independent — a config written on one OS must not be a hole on
  // another — and this is the one part of the pair that is asserted rather than derived.
  for (const name of ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
    assert.ok(CONFIG_RELOCATING_ENV_VARS.includes(name), `${name} is a Windows homedir input`);
  }
});

test('a capability removed by sanitising is reported, not silently taken away', async () => {
  const dir = caseDir('strip-warning');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({
    root: join(dir, 'pool'),
    home: join(dir, 'home'),
    // A legitimate ask: run hooks under a sandboxed HOME. It cannot be honoured — HOME steers
    // the config location — but the caller has to be TOLD, not left to notice.
    env: { HOME: join(dir, 'sandbox'), NOT_A_PROBLEM: 'kept' },
  });

  assert.deepEqual(provider.strippedEnv, ['HOME']);
  const lease = await provider.acquire('cpt-01', repo);
  const warning = lease.warnings.find((line) => line.includes('HOME'));
  assert.ok(warning !== undefined, `nothing told the caller: ${JSON.stringify(lease.warnings)}`);
  assert.match(warning, /sandboxed HOME cannot be delivered this way/, 'name the lost capability');
  assert.match(warning, /`home` option/, 'and the way to get what they wanted');
  await provider.release(lease);

  // A provider whose overlay is innocent says nothing, so the warning stays meaningful.
  const quiet = new ColdWorktreeProvider({
    root: join(dir, 'pool2'),
    home: join(dir, 'home'),
    env: { NOT_A_PROBLEM: 'kept' },
  });
  assert.deepEqual(quiet.strippedEnv, []);
  const quietLease = await quiet.acquire('cpt-02', repo);
  assert.deepEqual(quietLease.warnings, []);
  await quiet.release(quietLease);
});

test('a hook config that is wrong is reported, not silently ignored', async () => {
  const dir = caseDir('hook-warnings');
  const repo = repoWithCommit(join(dir, 'repo'));
  const home = armyHomeWith(
    dir,
    `[worktree]\nmax_trees = 0\n\n[projects.${q(repo)}]\npost_create = "not an array"\npre_destroy = [42]\n`,
  );
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home });

  const settings = await provider.settingsFor(repo);
  assert.deepEqual(settings.postCreate, []);
  assert.deepEqual(settings.preDestroy, []);
  assert.equal(settings.maxTrees, DEFAULT_MAX_TREES, 'a nonsense cap falls back to the default');
  assert.equal(settings.warnings.length, 3, settings.warnings.join('\n'));
  assert.ok(settings.warnings.some((w) => w.includes('post_create')));
  assert.ok(settings.warnings.some((w) => w.includes('pre_destroy')));
  assert.ok(settings.warnings.some((w) => w.includes('max_trees')));

  // An unparseable config does not wedge the pool: no hooks, and a warning that says so.
  const broken = armyHomeWith(join(dir, 'broken'), 'this is not = = toml\n');
  const other = new ColdWorktreeProvider({ root: join(dir, 'pool2'), home: broken });
  const settings2 = await other.settingsFor(repo);
  assert.deepEqual(settings2.postCreate, []);
  assert.ok(settings2.warnings.some((w) => w.includes('not valid TOML')));
  const lease = await other.acquire('cpt-01', repo);
  assert.equal(lease.hooks.ok, true);
  await other.release(lease);
});

// ---------------------------------------------------------------------------------------------
// pool sizing
// ---------------------------------------------------------------------------------------------

test('concurrent acquires never hand out the same tree, and the pool has a ceiling', async () => {
  const dir = caseDir('concurrency');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({
    root: join(dir, 'pool'),
    maxSlots: 3,
    home: join(dir, 'home'),
  });

  const leases = await Promise.all([
    provider.acquire('cpt-01', repo),
    provider.acquire('cpt-02', repo),
    provider.acquire('cpt-03', repo),
  ]);
  assert.equal(new Set(leases.map((l) => l.path)).size, 3, 'slot claiming must be atomic');
  assert.equal(new Set(leases.map((l) => l.leaseId)).size, 3);

  await assert.rejects(() => provider.acquire('cpt-04', repo), ColdWorktreeError, 'pool exhausted');

  await provider.release(leases[1]!);
  const recycled = await provider.acquire('cpt-04', repo);
  assert.equal(recycled.path, leases[1]!.path);
});

test('pool exhaustion fails fast with the cap in it, and creates nothing beyond it', async () => {
  const dir = caseDir('exhaustion');
  const repo = repoWithCommit(join(dir, 'repo'));
  const home = armyHomeWith(dir, `[projects.${q(repo)}]\nmax_trees = 2\n`);
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home });

  const held = [await provider.acquire('cpt-01', repo), await provider.acquire('cpt-02', repo)];

  await assert.rejects(
    () => provider.acquire('cpt-03', repo),
    (error: unknown) => {
      assert.ok(error instanceof PoolExhaustedError);
      assert.ok(error instanceof ColdWorktreeError, 'still the module error type callers catch');
      assert.equal(error.maxTrees, 2);
      assert.match(error.message, /max_trees/, 'the refusal must say how to raise the cap');
      assert.match(error.message, /fails fast rather than queueing/, 'and what it chose not to do');
      return true;
    },
  );

  const trees = join(dir, 'pool', 'trees');
  const slug = readdirSync(trees)[0]!;
  assert.equal(readdirSync(join(trees, slug)).length, 2, 'no tree is created beyond the cap');
  assert.equal(provider.listLeases().length, 2, 'and no slot is leaked by the refusal');

  await provider.release(held[0]!);
  const third = await provider.acquire('cpt-03', repo);
  assert.equal(third.path, held[0]!.path, 'a release is what makes room, immediately');
  await provider.release(third);
  await provider.release(held[1]!);

  assert.equal(DEFAULT_MAX_TREES, 16, "the default matches treehouse's max_trees");
});

/**
 * REGRESSION. An unconditional `git worktree prune` on every acquire raced a concurrent
 * `git worktree add`: prune reads `.git/worktrees/<name>/commondir` out of an entry that is
 * still being written, and roughly 5% of 10-way concurrent acquires died with
 * `failed to read .git/worktrees/wt-NN/commondir`. Ten ways, three rounds, thirty trees —
 * and now rounds 2 and 3 exercise the WARM path, which is the one that reuses a registration.
 */
test('10-way concurrent acquire/release survives repetition — the prune race', async () => {
  const dir = caseDir('prune-race');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({
    root: join(dir, 'pool'),
    maxSlots: 10,
    home: join(dir, 'home'),
  });
  const holders = Array.from({ length: 10 }, (_unused, i) => `cpt-${String(i).padStart(2, '0')}`);

  for (let round = 1; round <= 3; round++) {
    const leases = await Promise.all(holders.map((holder) => provider.acquire(holder, repo)));
    assert.equal(new Set(leases.map((l) => l.path)).size, 10, `round ${round}: distinct trees`);
    for (const lease of leases) {
      assert.ok(existsSync(join(lease.path, 'README.md')), `round ${round}: ${lease.path} is a tree`);
      assert.equal(symbolicHead(lease.path), null, `round ${round}: detached`);
      assert.equal(lease.warm, round > 1, `round ${round}: cold once, warm thereafter`);
    }
    await Promise.all(leases.map((lease) => provider.release(lease)));
    assert.equal(provider.listLeases().length, 0, `round ${round}: all slots freed`);
    // The trees stay registered between rounds — that is what warm means — and the registration
    // list must stay exactly as large as the pool, or something is leaking entries.
    assert.equal(
      sh(repo, 'worktree', 'list').split('\n').length,
      11,
      `round ${round}: the primary checkout plus ten warm pool trees`,
    );
  }

  // And the disk is reclaimable without touching a live lease.
  const evicted = await provider.evictIdle(repo);
  assert.equal(evicted.length, 10);
  assert.equal(sh(repo, 'worktree', 'list').split('\n').length, 1, 'only the primary remains');
});

// ---------------------------------------------------------------------------------------------
// ABA — the guard treehouse got from `--if-lease-id`, now ours
// ---------------------------------------------------------------------------------------------

test('releasing frees the slot, and the slot is re-leased with a fresh lease id', async () => {
  const dir = caseDir('slot-reuse');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  const first = await provider.acquire('cpt-01', repo);
  await provider.release(first);
  assert.ok(existsSync(first.path), 'a warm release keeps the tree');
  assert.equal(provider.listLeases().length, 0, 'but the slot is free');

  const second = await provider.acquire('cpt-02', repo);
  // Slot reuse is what makes the ABA guard load-bearing rather than theoretical.
  assert.equal(second.path, first.path);
  assert.notEqual(second.leaseId, first.leaseId);
});

test('a stale lease id must NOT destroy a worktree that has since been re-acquired', async () => {
  const dir = caseDir('aba');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  const stale = await provider.acquire('cpt-01', repo);
  await provider.release(stale);
  const current = await provider.acquire('cpt-02', repo);
  assert.equal(current.path, stale.path, 'precondition: the slot was reused');

  // The new holder's work must be there afterwards, or "no-op" is an untested word.
  writeFileSync(join(current.path, 'in-progress.txt'), 'cpt-02 is working\n');

  // A crash-recovering supervisor replays the lease it still remembers.
  const outcome = await provider.release(stale);
  assert.equal(outcome.outcome, 'stale-lease');
  assert.equal(outcome.released, false);
  assert.match(outcome.message, /stale/i);

  assert.ok(existsSync(current.path), "cpt-02's tree must survive cpt-01's stale release");
  assert.equal(sh(current.path, 'rev-parse', 'HEAD'), sh(repo, 'rev-parse', 'HEAD'));
  const leases = provider.listLeases();
  assert.equal(leases.length, 1);
  assert.equal(leases[0]?.leaseId, current.leaseId);
  assert.equal(leases[0]?.leaseHolder, 'cpt-02');

  // The contract entry point is also a silent no-op, not a throw and not a destruction — and
  // that holds for every shape of stale, fabricated, empty and foreign lease id, WITH `force`.
  for (const attack of [
    stale,
    { ...stale, force: false },
    fakeLease({ path: current.path, leaseId: 'fabricated' }),
    fakeLease({ path: current.path, leaseId: '' }),
    fakeLease({ path: current.path, leaseId: current.leaseId.toUpperCase() }),
  ]) {
    await provider.release(attack as Lease);
    await provider.release(attack as Lease, { force: true });
    await provider.release(attack as Lease, { force: true, discard: true });
  }
  assert.ok(existsSync(current.path), 'even a FORCED, DISCARDING stale release must not touch it');
  assert.equal(
    readFileSync(join(current.path, 'in-progress.txt'), 'utf8'),
    'cpt-02 is working\n',
    "and cpt-02's uncommitted work is still exactly where it left it",
  );
  assert.equal(provider.listLeases().length, 1, 'and the live lease record is untouched');
});

test('releasing an unknown path is a no-op, and a foreign provider lease is refused', async () => {
  const dir = caseDir('foreign');
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  const unknown = await provider.release(fakeLease({ path: join(dir, 'not-a-lease') }));
  assert.equal(unknown.outcome, 'no-record');
  assert.equal(unknown.released, false);

  await assert.rejects(
    () => provider.release(fakeLease({ provider: 'treehouse' })),
    ColdWorktreeError,
    'a lease is only releasable by the provider that minted it',
  );
});

// ---------------------------------------------------------------------------------------------
// fail-closed release — durability first: a lease never goes back while it holds unlanded work
// ---------------------------------------------------------------------------------------------

test('release refuses by default when the tree holds uncommitted work', async () => {
  const dir = caseDir('dirty');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });
  const lease = await provider.acquire('cpt-03', repo);

  writeFileSync(join(lease.path, 'notes.md'), 'a night of work\n');

  await assert.rejects(
    () => provider.release(lease),
    (error: unknown) => {
      assert.ok(error instanceof UnlandedWorkError);
      assert.equal(error.detail.dirty, true);
      assert.ok(error.detail.dirtyPaths.length > 0);
      assert.match(error.message, /force/, 'the refusal must say how to override it');
      return true;
    },
  );
  assert.ok(existsSync(join(lease.path, 'notes.md')), 'a refused release must destroy nothing');
});

test('release refuses commits no durable ref can reach; forced release is possible and distinct', async () => {
  const dir = caseDir('unlanded-commits');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });
  const lease = await provider.acquire('cpt-03', repo);

  const branch = armyBranch('take-hill-4');
  sh(lease.path, 'checkout', '--quiet', '-b', branch);
  writeFileSync(join(lease.path, 'hill.txt'), 'taken\n');
  sh(lease.path, 'add', '-A');
  sh(lease.path, 'commit', '--quiet', '-m', 'take the hill');

  await assert.rejects(
    () => provider.release(lease),
    (error: unknown) => {
      assert.ok(error instanceof UnlandedWorkError);
      assert.equal(error.detail.dirty, false);
      assert.equal(error.detail.unpushedCommits, 1);
      assert.deepEqual(error.detail.durableRefs, []);
      return true;
    },
  );
  assert.ok(existsSync(join(lease.path, 'hill.txt')), 'the commit and its files are untouched');

  // Forcing is a separate, explicit act — for when the holder process is gone and the work is
  // already durable elsewhere.
  const forced = await provider.release(lease, { force: true });
  assert.equal(forced.outcome, 'released');
  assert.equal(forced.released, true);
  assert.equal(existsSync(join(lease.path, 'hill.txt')), false, 'the reset really happened');
  assert.equal(provider.listLeases().length, 0);
});

test('the gate looks past HEAD: commits on the army branch count even after HEAD moves away', async () => {
  const dir = caseDir('head-moved-away');
  const repo = repoWithCommit(join(dir, 'repo'));
  const archiveRoot = join(dir, 'archive');
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });
  const lease = await provider.acquire('cpt-05', repo);
  const base = sh(repo, 'rev-parse', 'HEAD');
  const branch = armyBranch('wandering-head');

  sh(lease.path, 'checkout', '--quiet', '-b', branch);
  writeFileSync(join(lease.path, 'work.txt'), 'a night of it\n');
  sh(lease.path, 'add', '-A');
  sh(lease.path, 'commit', '--quiet', '-m', 'work');
  const tip = sh(lease.path, 'rev-parse', 'HEAD');

  // HEAD wanders back to where the tree was handed out. A HEAD-only gate now sees nothing
  // ahead of base and calls the lease safe to return — with the commit still nowhere durable.
  sh(lease.path, 'checkout', '--quiet', '--detach', base);
  assert.equal(sh(lease.path, 'rev-parse', 'HEAD'), base);
  assert.equal(sh(lease.path, 'status', '--porcelain'), '');

  await assert.rejects(
    () => provider.release(lease),
    (error: unknown) => {
      assert.ok(error instanceof UnlandedWorkError);
      assert.equal(error.detail.dirty, false, 'nothing is dirty; the commit is the loss');
      assert.ok(error.detail.unpushedCommits > 0);
      assert.ok(error.detail.candidates.includes(tip), 'the reflog is what makes it visible');
      return true;
    },
  );

  // Once that branch is durable, the same release is allowed.
  await ensureDurable({ worktree: lease.path, branch, project: repo, archiveRoot });
  const released = await provider.release(lease);
  assert.equal(released.outcome, 'released');
});

test('a stash taken in the tree blocks release; a stash from elsewhere does not', async () => {
  const dir = caseDir('stash');
  const repo = repoWithCommit(join(dir, 'repo'));
  const archiveRoot = join(dir, 'archive');
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  // A human's pre-existing stash, made in the primary checkout, has nothing to do with any lease.
  writeFileSync(join(repo, 'README.md'), '# hill\nhuman edit\n');
  sh(repo, 'stash', 'push', '--quiet', '-m', 'human wip');
  assert.equal(sh(repo, 'stash', 'list').split('\n').length, 1);

  // A lease that does its job and stashes nothing releases normally, despite the human's stash
  // being visible from inside its tree.
  const innocent = await provider.acquire('cpt-06', repo);
  const branchA = armyBranch('stash-innocent');
  sh(innocent.path, 'checkout', '--quiet', '-b', branchA);
  writeFileSync(join(innocent.path, 'done.txt'), 'committed\n');
  sh(innocent.path, 'add', '-A');
  sh(innocent.path, 'commit', '--quiet', '-m', 'done');
  await ensureDurable({ worktree: innocent.path, branch: branchA, project: repo, archiveRoot });
  assert.equal(sh(innocent.path, 'stash', 'list').split('\n').length, 1, 'the human stash is visible');
  const releasedInnocent = await provider.release(innocent);
  assert.equal(
    releasedInnocent.outcome,
    'released',
    "another worktree's stash must not hold this lease hostage",
  );

  // A lease that DOES stash is a different matter: `git status` goes quiet, but the work is
  // real and no durable ref can reach it.
  const guilty = await provider.acquire('cpt-07', repo);
  const branchB = armyBranch('stash-guilty');
  sh(guilty.path, 'checkout', '--quiet', '-b', branchB);
  writeFileSync(join(guilty.path, 'done.txt'), 'committed\n');
  sh(guilty.path, 'add', '-A');
  sh(guilty.path, 'commit', '--quiet', '-m', 'done');
  await ensureDurable({ worktree: guilty.path, branch: branchB, project: repo, archiveRoot });

  writeFileSync(join(guilty.path, 'wip.txt'), 'half a thought\n');
  sh(guilty.path, 'stash', 'push', '--quiet', '--include-untracked', '-m', 'agent wip');
  assert.equal(sh(guilty.path, 'status', '--porcelain'), '', 'precondition: status sees nothing');

  await assert.rejects(
    () => provider.release(guilty),
    (error: unknown) => {
      assert.ok(error instanceof UnlandedWorkError);
      assert.equal(error.detail.dirty, false);
      assert.ok(error.detail.unpushedCommits > 0, 'the stash commit is unlanded work');
      return true;
    },
  );
  await provider.release(guilty, { force: true });
});

// ---------------------------------------------------------------------------------------------
// the property the whole design rests on
// ---------------------------------------------------------------------------------------------

test('round trip: acquire → branch → commit → durability → release, and the commit survives the tree', async () => {
  const dir = caseDir('round-trip');
  const repo = repoWithCommit(join(dir, 'repo'));
  const archiveRoot = join(dir, 'archive');
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  const lease = await provider.acquire('cpt-03', repo);
  const branch = armyBranch('take-hill-4');

  // The tree arrived detached, so the Engineer cuts its own branch.
  sh(lease.path, 'checkout', '--quiet', '-b', branch);
  writeFileSync(join(lease.path, 'hill.txt'), 'taken\n');
  sh(lease.path, 'add', '-A');
  sh(lease.path, 'commit', '--quiet', '-m', 'take the hill');
  const sha = sh(lease.path, 'rev-parse', 'HEAD');

  // Before durability, releasing is refused. This ordering IS the design.
  await assert.rejects(() => provider.release(lease), UnlandedWorkError);

  const durability = await ensureDurable({ worktree: lease.path, branch, project: repo, archiveRoot });
  assert.equal(durability.target.kind, 'mirror', 'no origin, so the army mirror carries it');
  assert.equal(durability.commit, sha);
  assert.equal(durability.pushed, true);
  assert.equal(durability.ref, durableRef(branch));
  assert.equal(sh(repo, 'rev-parse', durability.ref), sha, 'the marker ref lives in the repo');

  // Now the same release that was refused a moment ago is allowed — no force needed.
  const released = await provider.release(lease);
  assert.equal(released.outcome, 'released');
  assert.equal(existsSync(join(lease.path, 'hill.txt')), false, 'the tree no longer holds the work');

  // THE PROPERTY: the work is in the bare mirror, and the ephemeral tree is irrelevant to it.
  const mirror = durability.target.url;
  assert.ok(existsSync(join(mirror, 'HEAD')), 'the mirror is a real bare repo');
  assert.equal(sh(mirror, 'rev-parse', `refs/heads/${branch}`), sha);
  assert.equal(sh(mirror, 'show', `${sha}:hill.txt`), 'taken');
  assert.equal(sh(mirror, 'rev-parse', '--is-bare-repository'), 'true');

  // Durability survives the tree being destroyed outright, too.
  const again = await provider.acquire('cpt-04', repo);
  await provider.release(again, { discard: true });
  assert.equal(existsSync(again.path), false, 'discard destroys the tree');
  assert.equal(sh(mirror, 'rev-parse', `refs/heads/${branch}`), sha, 'the work is still durable');
});

test('durability is idempotent and refuses a tree with no branch cut', async () => {
  const dir = caseDir('durability-edges');
  const repo = repoWithCommit(join(dir, 'repo'));
  const archiveRoot = join(dir, 'archive');
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });
  const lease = await provider.acquire('cpt-04', repo);
  const branch = armyBranch('no-branch-yet');

  // Still detached: the Engineer never cut its branch, so there is nothing to make durable.
  await assert.rejects(
    () => ensureDurable({ worktree: lease.path, branch, project: repo, archiveRoot }),
    /does not exist/,
  );

  sh(lease.path, 'checkout', '--quiet', '-b', branch);
  writeFileSync(join(lease.path, 'a.txt'), 'a\n');
  sh(lease.path, 'add', '-A');
  sh(lease.path, 'commit', '--quiet', '-m', 'a');

  const first = await ensureDurable({ worktree: lease.path, branch, project: repo, archiveRoot });
  assert.equal(first.pushed, true);
  const second = await ensureDurable({ worktree: lease.path, branch, project: repo, archiveRoot });
  assert.equal(second.pushed, false, 'nothing new to send, still durable');
  assert.equal(second.commit, first.commit);

  await provider.release(lease);
});

// ---------------------------------------------------------------------------------------------
// provider selection — one provider, and the seam that outlived treehouse
// ---------------------------------------------------------------------------------------------

test('selection yields the pooled provider, and says what it is', async () => {
  const dir = caseDir('selection');
  const selection = await selectWorktreeProvider({ cold: { root: join(dir, 'pool') } });

  assert.equal(selection.selected, 'cold');
  assert.equal(selection.preferred, 'cold');
  assert.equal(selection.provider.id, 'cold');
  assert.ok(selection.provider instanceof ColdWorktreeProvider);
  assert.equal(selection.note.level, 'info');
  assert.equal(selection.note.code, 'provider-selected');
  assert.match(selection.note.message, /warm/, 'the caller must learn what it got');
  assert.match(selection.note.message, /post_create/);
});

test('asking for treehouse is not an error, and not silent', async () => {
  const dir = caseDir('selection-treehouse');
  const selection = await selectWorktreeProvider({
    cold: { root: join(dir, 'pool') },
    prefer: 'treehouse',
  });

  // There is nothing to downgrade FROM any more — pooling is in-house — but a caller that asked
  // for a provider it did not get is told so.
  assert.equal(selection.selected, 'cold');
  assert.equal(selection.preferred, 'treehouse');
  assert.equal(selection.note.level, 'warn');
  assert.equal(selection.note.code, 'provider-retired');
  assert.match(selection.note.message, /no longer a provider/);
});

test('the pooled provider can be demanded explicitly, and is available wherever git is', async () => {
  const dir = caseDir('selection-forced');
  const selection = await selectWorktreeProvider({
    cold: { root: join(dir, 'pool') },
    prefer: 'cold',
  });
  assert.equal(selection.selected, 'cold');
  assert.equal(selection.note.code, 'provider-forced');
  assert.equal(selection.note.level, 'info');
  assert.equal(await selection.provider.isAvailable(), true);
});

// ---------------------------------------------------------------------------------------------
// CAN A WORKER ACTUALLY USE THE TREE IT WAS LEASED?
//
// This is the question 621 green tests never asked. The permission tests asserted that the deny
// globs were EMITTED. Nothing asserted that a worker could still WORK with them applied — and on
// a real machine an Engineer was leased a tree under `~/.agentic-army`, where Read, Grep, Glob,
// Write and Edit are all denied, and could not create a single file. The suite stayed green
// because `test/fixtures/fake-claude.mjs` never read its own `--allowedTools` argv.
//
// So these two tests run the whole chain for real: the real pool-root derivation, a real git
// worktree, the real `permissionsFor()` argv, the real claude adapter, and a fake that refuses
// what the argv tells it to refuse. The first proves a worker can work; the second points the
// pool back inside the protected tree and proves the same run fails. Neither is worth anything
// without the other: the positive alone can pass because the fake is toothless, and the negative
// alone can pass because the fake is broken.
// ---------------------------------------------------------------------------------------------

const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

/** The file the fake's default work routine writes into its cwd. */
const WORK_FILE = 'engineer-work.txt';

interface WorkRun {
  events: SoldierEvent[];
  /** One entry per `permission_denials` row the harness reported, tool name only. */
  deniedTools: string[];
  /** Tools whose `tool_result` came back clean. */
  usedTools: string[];
}

/**
 * Spawn an ENGINEER against the fake in its tool-using mode, in `cwd`, under `deny`/`allow`, and
 * report what it managed to do. `FAKE_CLAUDE_MODE` is set around the spawn rather than globally
 * so no other test in this file inherits a tool-using harness.
 */
async function runEngineer(cwd: string, home: string): Promise<WorkRun> {
  const permissions = permissionsFor('CAPTAIN', 'ENGINEER', home);
  const spec: SoldierSpec = {
    agentId: 'cpt-01',
    rank: 'CAPTAIN',
    role: 'ENGINEER',
    harness: 'claude',
    cwd,
    sessionId: '9f2b7c1a-0d44-4e6b-8f10-2c5d7a3e9b64',
    allow: permissions.allow,
    deny: permissions.deny,
    orders: 'take hill 4',
  };

  const saved = process.env['FAKE_CLAUDE_MODE'];
  process.env['FAKE_CLAUDE_MODE'] = 'work';
  const events: SoldierEvent[] = [];
  try {
    const adapter = createClaudeAdapter({ bin: FAKE_CLAUDE, closeGraceMs: 2000, killGraceMs: 500 });
    const soldier = await adapter.spawn(spec);
    // Wait for the turn's own `result`, not for a stopwatch. A fixed sleep here is a flake on a
    // loaded machine and, worse, a fixed sleep that is TOO SHORT reads as "the worker produced
    // nothing" — which is the exact symptom this pair of tests exists to distinguish from a
    // permission lockout.
    let turnDone: () => void = () => {};
    const finished = new Promise<void>((r) => (turnDone = r));
    const pump = (async () => {
      for await (const event of soldier.stream()) {
        events.push(event);
        if (event.type === 'result') turnDone();
      }
    })();
    await soldier.send(spec.orders);
    await Promise.race([finished, new Promise((r) => setTimeout(r, 10_000))]);
    await soldier.close();
    await pump;
  } finally {
    if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
    else process.env['FAKE_CLAUDE_MODE'] = saved;
  }

  const deniedTools = events
    .filter((e) => e.type === 'unknown' && e.harnessType === 'permission_denial')
    .map((e) => ((e as { raw?: unknown }).raw as { tool_name?: string }).tool_name ?? '?');

  const byId = new Map<string, string>();
  for (const e of events) if (e.type === 'tool_use') byId.set(e.toolUseId, e.name);
  const usedTools = events
    .filter((e): e is Extract<SoldierEvent, { type: 'tool_result' }> => e.type === 'tool_result')
    .filter((e) => !e.isError)
    .map((e) => byId.get(e.toolUseId) ?? '?');

  return { events, deniedTools, usedTools };
}

const PATH_TOOLS = ['Glob', 'Write', 'Read', 'Grep', 'Edit'];

test(
  'an ENGINEER leased a tree from the derived pool root can actually read and write it',
  { skip: process.platform === 'win32' ? 'POSIX shebang fake' : false },
  async () => {
    const dir = caseDir('engineer-can-work');
    const repo = repoWithCommit(join(dir, 'repo'));
    const home = join(dir, '.agentic-army');
    mkdirSync(home, { recursive: true });

    // The REAL derivation, not a path this test picked. If `worktreesRootFor` is ever changed
    // back to something under the home, this test is the one that notices.
    const poolRoot = worktreesRootFor(home);
    assertWorktreeRootOutsideProtected(poolRoot, home);

    const provider = new ColdWorktreeProvider({ root: poolRoot, home });
    const lease = await provider.acquire('cpt-01', repo);

    const run = await runEngineer(lease.path, home);

    // THE PROPERTY, in the only form that cannot be faked: bytes on disk, in the leased tree.
    const written = join(lease.path, WORK_FILE);
    assert.ok(existsSync(written), `the Engineer created nothing in ${lease.path}`);
    assert.match(readFileSync(written, 'utf8'), /engineer was here/);
    assert.match(readFileSync(written, 'utf8'), /and edited it/, 'Edit ran too, not just Write');

    // And git agrees the file landed inside the worktree rather than somewhere adjacent.
    assert.match(sh(lease.path, 'status', '--porcelain'), new RegExp(`\\?\\? ${WORK_FILE}`));

    assert.deepEqual(run.deniedTools, [], 'a worker in its own tree must be denied nothing');
    assert.deepEqual(
      run.usedTools,
      PATH_TOOLS,
      'every path tool an Engineer holds must work inside its lease',
    );
    assert.ok(
      run.events.some((e) => e.type === 'result' && e.status === 'ok'),
      'the turn itself must complete',
    );

    await provider.release(lease, { force: true });
  },
);

test(
  'the SAME run fails when the pool is pointed back inside the protected tree',
  { skip: process.platform === 'win32' ? 'POSIX shebang fake' : false },
  async () => {
    const dir = caseDir('engineer-locked-out');
    const repo = repoWithCommit(join(dir, 'repo'));
    const home = join(dir, '.agentic-army');
    mkdirSync(home, { recursive: true });

    // The shipped bug, spelled out: the pool defaulted to `<archiveRoot>/worktrees` and
    // `archiveRoot` defaults to the army home. Every worker denies that whole region.
    const poolRoot = join(home, 'worktrees');
    assert.throws(
      () => assertWorktreeRootOutsideProtected(poolRoot, home),
      /denied Read, Grep, Glob, Write and Edit/,
      'the guard that now prevents this must still refuse it',
    );

    // The guard is deliberately bypassed here — this test is what the world looked like before
    // it existed, and its whole job is to show that the lockout is now VISIBLE to the suite.
    const provider = new ColdWorktreeProvider({ root: poolRoot, home });
    const lease = await provider.acquire('cpt-01', repo);
    assert.ok(lease.path.startsWith(home), 'sanity: the lease really is inside the protected tree');

    const run = await runEngineer(lease.path, home);

    // TOTAL LOCKOUT. Not a degraded run — every path tool the Engineer holds is refused, and the
    // filesystem is untouched. This is exactly what the user saw, and what 621 tests missed.
    assert.deepEqual(run.deniedTools, PATH_TOOLS, 'every path tool must be denied, not just some');
    assert.deepEqual(run.usedTools, [], 'nothing may succeed inside a region every rule denies');
    assert.equal(
      existsSync(join(lease.path, WORK_FILE)),
      false,
      'a denied tool must not touch the filesystem — a denial that still writes proves nothing',
    );

    // The denial rows carry the real CLI's shape, so the archive and the escalation ladder get
    // something they can route rather than a boolean.
    const denial = run.events.find(
      (e) => e.type === 'unknown' && e.harnessType === 'permission_denial',
    );
    const raw = (denial as { raw?: Record<string, unknown> } | undefined)?.raw ?? {};
    assert.deepEqual(Object.keys(raw).sort(), ['tool_input', 'tool_name', 'tool_use_id']);
    assert.match(String(raw['tool_use_id']), /^toolu_/);

    await provider.release(lease, { force: true });
  },
);

// ---------------------------------------------------------------------------------------------
// STALE LEASES — a crash must not drain the pool forever
//
// Field-reproduced: SIGKILL a campaign mid-flight and its lease record file survives in
// <root>/leases/ with nothing left alive to release it. Before acquire-time reclamation every
// crash permanently consumed a slot, `--id` re-attachment was refused (cpt-01 already recorded),
// and the pool ran dry one death at a time. The tests below hold the whole policy still: a
// provably dead holder is reclaimed THROUGH the real release path, and everything the machine
// cannot judge — a live pid, another host, a record with no pid, an unreadable file, unlanded
// work — is conservatively left exactly where it is.
// ---------------------------------------------------------------------------------------------

/** A pid that demonstrably exists no longer: a real child, already exited when we return. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(typeof child.pid === 'number' && child.pid > 0, 'spawnSync must yield a pid');
  return child.pid;
}

/** The record file behind a lease, found the same way `release` finds it — by tree path. */
function leaseFileFor(provider: ColdWorktreeProvider, treePath: string): string {
  for (const name of readdirSync(provider.leasesDir)) {
    const file = join(provider.leasesDir, name);
    if (readLeaseRecord(file)?.path === treePath) return file;
  }
  throw new Error(`no lease record found for ${treePath}`);
}

/** Rewrite a lease record in place, keeping every field the patch does not name. */
function patchLease(file: string, patch: Partial<ColdLeaseRecord>): void {
  const record = readLeaseRecord(file);
  assert.ok(record !== null, `${file} must hold a readable record`);
  writeFileSync(file, `${JSON.stringify({ ...record, ...patch }, null, 2)}\n`);
}

test('a lease record carries the supervisor pid and host, and leaseLiveness judges each shape', async () => {
  const dir = caseDir('lease-pid');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool'), home: join(dir, 'home') });

  const lease = await provider.acquire('cpt-01', repo);
  const record = readLeaseRecord(leaseFileFor(provider, lease.path));
  assert.ok(record !== null);
  // The SUPERVISOR's pid — the process whose death orphans the lease — not the soldier's.
  assert.equal(record.pid, process.pid);
  assert.equal(record.host, hostname());

  // The four verdicts, each from the record shape that produces it.
  assert.equal(leaseLiveness(record).verdict, 'live');
  assert.equal(leaseLiveness({ ...record, pid: deadPid() }).verdict, 'stale');
  assert.equal(leaseLiveness({ ...record, host: 'somewhere-else' }).verdict, 'foreign');
  assert.equal(leaseLiveness({ leaseHolder: 'cpt-01' }).verdict, 'unknown');

  // pidAlive is `process.kill(pid, 0)` semantics: a live pid answers true, a dead one false,
  // and pid 1 — EPERM for a normal user, deliverable for root — answers true either way,
  // because EPERM proves existence and reading it as death would reclaim a live lease.
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid()), false);
  assert.equal(pidAlive(1), true);

  await provider.release(lease);
});

test('acquire reclaims a dead-pid lease through the real release path — a crash no longer drains the pool', async () => {
  const dir = caseDir('lease-reclaim');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({
    root: join(dir, 'pool'),
    maxSlots: 1,
    home: join(dir, 'home'),
  });

  // A campaign takes the only slot and is SIGKILLed: nothing releases, the record survives.
  const crashed = await provider.acquire('cpt-01', repo);
  const file = leaseFileFor(provider, crashed.path);
  patchLease(file, { pid: deadPid() });

  // The next campaign's acquire reclaims the slot instead of failing the pool dry.
  const next = await provider.acquire('cpt-01', repo);
  assert.equal(next.path, crashed.path, 'the reclaimed slot is the one the crash was holding');
  assert.notEqual(next.leaseId, crashed.leaseId, 'a reclaim mints a fresh lease, never revives one');
  assert.equal(provider.listLeases().length, 1, 'exactly one lease exists afterwards');
  assert.equal(readLeaseRecord(file)?.leaseId, next.leaseId);

  // The dead run's lease is now stale by the ABA guard: replaying it must be a no-op.
  const replay = await provider.release(crashed);
  assert.equal(replay.outcome, 'stale-lease');
  assert.equal(replay.released, false);
  assert.ok(existsSync(next.path), "the new holder's tree survives the dead run's replayed release");

  await provider.release(next);
});

test('acquire never reclaims a lease it cannot judge: live pid, foreign host, missing pid, unreadable record', async () => {
  const dir = caseDir('lease-conservative');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({
    root: join(dir, 'pool'),
    maxSlots: 1,
    home: join(dir, 'home'),
  });

  const held = await provider.acquire('cpt-01', repo);
  const file = leaseFileFor(provider, held.path);
  const original = readFileSync(file, 'utf8');

  const shapes: Array<[string, () => void]> = [
    // A live pid IS the normal held case — reclaiming it would destroy a running campaign's tree.
    ['live pid', () => patchLease(file, { pid: process.pid })],
    // A dead-here pid from another machine proves nothing about that machine.
    ['foreign host', () => patchLease(file, { pid: deadPid(), host: 'build-box-17' })],
    // A record from before pid tracking cannot be judged at all.
    ['missing pid', () => {
      const record = JSON.parse(original) as Record<string, unknown>;
      delete record['pid'];
      delete record['host'];
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    }],
    // An unreadable record still holds its slot — deleting what cannot be parsed is guesswork.
    ['unreadable record', () => writeFileSync(file, 'not json{{{\n')],
  ];

  for (const [label, mutate] of shapes) {
    mutate();
    await assert.rejects(
      () => provider.acquire('cpt-02', repo),
      (error: unknown) => {
        assert.ok(error instanceof PoolExhaustedError, `${label}: still exhausted, never reclaimed`);
        // The fix text names the crash case honestly instead of misdiagnosing it.
        assert.match(error.message, /reclaimed automatically/, `${label}: the message explains reclamation`);
        assert.match(error.message, /doctor/, `${label}: and points at the lease check`);
        return true;
      },
    );
  }

  writeFileSync(file, original);
  await provider.release(held);
});

test("a dead holder's unlanded work still blocks reclamation — the release gate applies to the dead too", async () => {
  const dir = caseDir('lease-reclaim-unlanded');
  const repo = repoWithCommit(join(dir, 'repo'));
  const provider = new ColdWorktreeProvider({
    root: join(dir, 'pool'),
    maxSlots: 1,
    home: join(dir, 'home'),
  });

  const crashed = await provider.acquire('cpt-01', repo);
  // The crashed Engineer left uncommitted work in the tree. Reclaiming would reset it away.
  writeFileSync(join(crashed.path, 'night-of-work.txt'), 'not yet durable\n');
  const file = leaseFileFor(provider, crashed.path);
  patchLease(file, { pid: deadPid() });

  await assert.rejects(() => provider.acquire('cpt-02', repo), PoolExhaustedError);

  // Nothing was destroyed and nothing was unlinked: the slot is still held FOR the dead run,
  // which is the fail-closed answer — a leaked slot is recoverable, a night of work is not.
  assert.ok(existsSync(join(crashed.path, 'night-of-work.txt')), 'the unlanded work survives');
  assert.equal(readLeaseRecord(file)?.leaseId, crashed.leaseId, 'the record survives too');

  await provider.release(crashed, { force: true });
});
