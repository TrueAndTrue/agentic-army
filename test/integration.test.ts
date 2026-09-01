/**
 * The integration worktree.
 *
 * Real git, real pooled worktrees, real merges, real conflicts. Merge behaviour is the kind of
 * thing that is obvious in the manual and wrong in practice, so nothing here is asserted from a
 * documented exit code: every outcome is produced by running git against a repository built for
 * it.
 *
 * The properties this file exists to protect:
 *
 *  1. **A conflict leaves the tree exactly where it was.** `a conflict is aborted and the next
 *     workstream still integrates` is the one that makes the contract's refusal usable rather
 *     than merely principled.
 *  2. **A second merge of the same branch makes no commit.** Asserted by counting commits, not by
 *     trusting the reported outcome.
 *  3. **The integration branch is cut from the campaign base**, so a human committing to the
 *     project mid-campaign cannot turn the first workstream's merge into a collision with work
 *     that workstream never saw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ColdWorktreeProvider, UnlandedWorkError } from '../src/worktree/index.ts';
import {
  IntegrationError,
  integrationBranch,
  openIntegrationTree,
} from '../src/worktree/integration.ts';
import type { PooledIntegrationTree } from '../src/worktree/integration.ts';
import { ensureDurable } from '../src/delivery/durability.ts';

// ---------------------------------------------------------------------------------------------
// hermetic git: no global or system config, a fixed identity, no credential prompts, no network
// ---------------------------------------------------------------------------------------------

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'army-integration-')));
const EMPTY_GITCONFIG = join(ROOT, 'gitconfig');
writeFileSync(EMPTY_GITCONFIG, '');

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
  GIT_CONFIG_SYSTEM: EMPTY_GITCONFIG,
  GIT_AUTHOR_NAME: 'Army Test',
  GIT_AUTHOR_EMAIL: 'army@example.invalid',
  GIT_COMMITTER_NAME: 'Army Test',
  GIT_COMMITTER_EMAIL: 'army@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
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

interface Fixture {
  dir: string;
  project: string;
  /** The campaign base: the project head at the moment the campaign was planned. */
  base: string;
  branch: string;
  provider: ColdWorktreeProvider;
}

/** A project with one commit on `main`, and a pool rooted beside it. */
function fixture(label: string): Fixture {
  const dir = caseDir(label);
  const project = join(dir, 'project');
  mkdirSync(project, { recursive: true });
  sh(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'shared.txt'), 'base\n');
  writeFileSync(join(project, 'README.md'), '# project\n');
  sh(project, 'add', '.');
  sh(project, 'commit', '-qm', 'base');
  return {
    dir,
    project,
    base: sh(project, 'rev-parse', 'HEAD'),
    branch: integrationBranch(label),
    provider: new ColdWorktreeProvider({
      root: join(dir, 'pool'),
      home: join(ROOT, 'nonexistent-home'),
    }),
  };
}

/** A workstream branch cut from `from`, writing `content` into `file`. */
function workstream(fx: Fixture, name: string, file: string, content: string, from?: string): string {
  sh(fx.project, 'checkout', '-q', '-b', name, from ?? fx.base);
  writeFileSync(join(fx.project, file), content);
  sh(fx.project, 'add', '.');
  sh(fx.project, 'commit', '-qm', `${name}: ${file}`);
  const tip = sh(fx.project, 'rev-parse', 'HEAD');
  sh(fx.project, 'checkout', '-q', 'main');
  return tip;
}

function open(fx: Fixture): Promise<PooledIntegrationTree> {
  return openIntegrationTree({
    provider: fx.provider,
    holder: 'maj-overseer',
    project: fx.project,
    branch: fx.branch,
    base: fx.base,
  });
}

/** Commits on the integration branch, so "no empty commit" can be counted rather than believed. */
function commitCount(fx: Fixture): number {
  return Number.parseInt(sh(fx.project, 'rev-list', '--count', fx.branch), 10);
}

function parentsOf(fx: Fixture, commit: string): string[] {
  return sh(fx.project, 'rev-list', '--no-walk', '--parents', commit).split(/\s+/).slice(1);
}

/** Tracked modifications only, which is what "the tree is clean" means for a warm pool tree. */
function trackedDirty(cwd: string): string {
  return sh(cwd, 'status', '--porcelain', '--untracked-files=no');
}

// ---------------------------------------------------------------------------------------------
// where the branch is cut from
// ---------------------------------------------------------------------------------------------

test('the integration branch is cut from the campaign base, not the moved project head', async () => {
  const fx = fixture('cut-from-base');
  // The human commits to main while the campaign is running.
  writeFileSync(join(fx.project, 'human.txt'), 'not the army\n');
  sh(fx.project, 'add', '.');
  sh(fx.project, 'commit', '-qm', 'human works too');
  const humanCommit = sh(fx.project, 'rev-parse', 'HEAD');
  assert.notEqual(humanCommit, fx.base);

  const tree = await open(fx);
  try {
    assert.equal(sh(tree.path, 'rev-parse', 'HEAD'), fx.base);
    assert.equal(sh(tree.path, 'symbolic-ref', '--short', 'HEAD'), fx.branch);
    // The consequence, asserted so it cannot regress silently: the integration branch is BEHIND
    // the project, and the human's commit is not on it. `--is-ancestor` exits 1 for "no", which
    // `execFileSync` raises.
    assert.throws(() => sh(fx.project, 'merge-base', '--is-ancestor', humanCommit, fx.branch));
    assert.equal(sh(fx.project, 'merge-base', '--is-ancestor', fx.base, humanCommit), '');
  } finally {
    await tree.release();
  }
});

test('a base that does not resolve is refused before a tree is leased', async () => {
  const fx = fixture('bad-base');
  await assert.rejects(
    openIntegrationTree({
      provider: fx.provider,
      holder: 'maj-overseer',
      project: fx.project,
      branch: fx.branch,
      base: 'refs/heads/nothing-here',
    }),
    (error: unknown) => error instanceof IntegrationError && /does not resolve/.test(String(error)),
  );
  assert.deepEqual(fx.provider.listLeases(), []);
});

test('a branch name that would read as a flag is refused', async () => {
  const fx = fixture('flag-branch');
  await assert.rejects(
    openIntegrationTree({
      provider: fx.provider,
      holder: 'maj-overseer',
      project: fx.project,
      branch: '--force',
      base: fx.base,
    }),
    (error: unknown) => error instanceof IntegrationError && /begin with a dash/.test(String(error)),
  );
  await assert.rejects(
    openIntegrationTree({
      provider: fx.provider,
      holder: 'maj-overseer',
      project: fx.project,
      branch: 'army/bad..name',
      base: fx.base,
    }),
    (error: unknown) => error instanceof IntegrationError && /not a valid branch name/.test(String(error)),
  );
  assert.deepEqual(fx.provider.listLeases(), []);
});

// ---------------------------------------------------------------------------------------------
// merging
// ---------------------------------------------------------------------------------------------

test('a workstream that could fast-forward still gets a merge commit', async () => {
  const fx = fixture('no-ff');
  const tip = workstream(fx, 'army/w1', 'one.txt', 'one\n');
  const tree = await open(fx);
  try {
    const outcome = await tree.merge('army/w1');
    assert.equal(outcome.kind, 'merged');
    assert.notEqual(outcome.kind === 'merged' ? outcome.commit : '', tip);
    // Two parents is the proof it did not fast-forward: the campaign base and the workstream tip.
    const parents = parentsOf(fx, outcome.kind === 'merged' ? outcome.commit : '');
    assert.deepEqual(parents, [fx.base, tip]);
    assert.equal(sh(tree.path, 'rev-parse', 'HEAD'), outcome.kind === 'merged' ? outcome.commit : '');
    assert.equal(readFileSync(join(tree.path, 'one.txt'), 'utf8'), 'one\n');
  } finally {
    await releaseDurably(fx, tree);
  }
});

test('two workstreams that do not collide both integrate, in the order they are merged', async () => {
  const fx = fixture('two-clean');
  workstream(fx, 'army/w1', 'one.txt', 'one\n');
  const two = workstream(fx, 'army/w2', 'two.txt', 'two\n');
  const tree = await open(fx);
  try {
    const a = await tree.merge('army/w1');
    const b = await tree.merge('army/w2');
    assert.equal(a.kind, 'merged');
    assert.equal(b.kind, 'merged');
    assert.equal(sh(tree.path, 'cat-file', '-p', `${fx.branch}:one.txt`), 'one');
    assert.equal(sh(tree.path, 'cat-file', '-p', `${fx.branch}:two.txt`), 'two');
    assert.deepEqual(parentsOf(fx, b.kind === 'merged' ? b.commit : ''), [
      a.kind === 'merged' ? a.commit : '',
      two,
    ]);
  } finally {
    await releaseDurably(fx, tree);
  }
});

// ---------------------------------------------------------------------------------------------
// already-current, in all four shapes it arrives in
// ---------------------------------------------------------------------------------------------

test('a second merge of the same branch reports already-current and makes no commit', async () => {
  const fx = fixture('second-merge');
  workstream(fx, 'army/w1', 'one.txt', 'one\n');
  const tree = await open(fx);
  try {
    assert.equal((await tree.merge('army/w1')).kind, 'merged');
    const after = commitCount(fx);
    const tip = sh(fx.project, 'rev-parse', fx.branch);

    assert.equal((await tree.merge('army/w1')).kind, 'already-current');
    assert.equal(commitCount(fx), after);
    assert.equal(sh(fx.project, 'rev-parse', fx.branch), tip);
  } finally {
    await releaseDurably(fx, tree);
  }
});

test('a branch with no commits of its own is already-current', async () => {
  const fx = fixture('empty-branch');
  sh(fx.project, 'branch', 'army/idle', fx.base);
  const tree = await open(fx);
  try {
    const before = commitCount(fx);
    assert.equal((await tree.merge('army/idle')).kind, 'already-current');
    assert.equal(commitCount(fx), before);
  } finally {
    await tree.release();
  }
});

test('a branch whose tip equals the integration tip, and the integration branch itself, are already-current', async () => {
  const fx = fixture('identical-tips');
  workstream(fx, 'army/w1', 'one.txt', 'one\n');
  const tree = await open(fx);
  try {
    await tree.merge('army/w1');
    const tip = sh(fx.project, 'rev-parse', fx.branch);
    sh(fx.project, 'branch', 'army/twin', tip);

    assert.equal((await tree.merge('army/twin')).kind, 'already-current');
    assert.equal((await tree.merge(fx.branch)).kind, 'already-current');
    assert.equal(sh(fx.project, 'rev-parse', fx.branch), tip);
  } finally {
    await releaseDurably(fx, tree);
  }
});

// ---------------------------------------------------------------------------------------------
// conflict: the property this module owns
// ---------------------------------------------------------------------------------------------

test('a conflict is aborted, reports its files, and the next workstream still integrates', async () => {
  const fx = fixture('conflict');
  workstream(fx, 'army/w1', 'shared.txt', 'from w1\n');
  const theirs = workstream(fx, 'army/w2', 'shared.txt', 'from w2\n');
  workstream(fx, 'army/w3', 'three.txt', 'three\n');

  const tree = await open(fx);
  try {
    const first = await tree.merge('army/w1');
    assert.equal(first.kind, 'merged');
    const ours = sh(fx.project, 'rev-parse', fx.branch);
    const before = commitCount(fx);

    const clash = await tree.merge('army/w2');
    assert.equal(clash.kind, 'conflict');
    if (clash.kind !== 'conflict') return;
    assert.deepEqual(clash.files, ['shared.txt']);
    assert.equal(clash.ours, ours);
    assert.equal(clash.theirs, theirs);

    // The tree is CLEAN and the branch is exactly where it was.
    assert.equal(sh(tree.path, 'rev-parse', 'HEAD'), ours);
    assert.equal(sh(tree.path, 'symbolic-ref', '--short', 'HEAD'), fx.branch);
    assert.equal(trackedDirty(tree.path), '');
    assert.equal(commitCount(fx), before);
    assert.equal(readFileSync(join(tree.path, 'shared.txt'), 'utf8'), 'from w1\n');
    assert.equal(sh(tree.path, 'ls-files', '--unmerged'), '');
    // Nothing resolved, and no marker left behind for anyone to mistake for a resolution.
    assert.ok(!readFileSync(join(tree.path, 'shared.txt'), 'utf8').includes('<<<<<<<'));

    // The whole point of aborting: the order carries on.
    const next = await tree.merge('army/w3');
    assert.equal(next.kind, 'merged');
    assert.equal(commitCount(fx), before + 2);
  } finally {
    await releaseDurably(fx, tree);
  }
});

test('a conflict inside a binary file reports the path like any other', async () => {
  const fx = fixture('binary-conflict');
  sh(fx.project, 'checkout', '-q', '-b', 'army/b1', fx.base);
  writeFileSync(join(fx.project, 'asset.bin'), Buffer.from([0, 1, 65, 0, 255]));
  sh(fx.project, 'add', '.');
  sh(fx.project, 'commit', '-qm', 'b1');
  sh(fx.project, 'checkout', '-q', '-b', 'army/b2', fx.base);
  writeFileSync(join(fx.project, 'asset.bin'), Buffer.from([0, 1, 66, 0, 255]));
  sh(fx.project, 'add', '.');
  sh(fx.project, 'commit', '-qm', 'b2');
  sh(fx.project, 'checkout', '-q', 'main');

  const tree = await open(fx);
  try {
    assert.equal((await tree.merge('army/b1')).kind, 'merged');
    const ours = sh(fx.project, 'rev-parse', fx.branch);

    const clash = await tree.merge('army/b2');
    assert.equal(clash.kind, 'conflict');
    if (clash.kind !== 'conflict') return;
    assert.deepEqual(clash.files, ['asset.bin']);
    assert.equal(sh(tree.path, 'rev-parse', 'HEAD'), ours);
    assert.equal(trackedDirty(tree.path), '');
  } finally {
    await releaseDurably(fx, tree);
  }
});

test('several conflicted paths come back sorted', async () => {
  const fx = fixture('many-conflicts');
  for (const name of ['army/m1', 'army/m2']) {
    sh(fx.project, 'checkout', '-q', '-b', name, fx.base);
    writeFileSync(join(fx.project, 'shared.txt'), `${name}\n`);
    writeFileSync(join(fx.project, 'README.md'), `# ${name}\n`);
    sh(fx.project, 'add', '.');
    sh(fx.project, 'commit', '-qm', name);
  }
  sh(fx.project, 'checkout', '-q', 'main');

  const tree = await open(fx);
  try {
    await tree.merge('army/m1');
    const clash = await tree.merge('army/m2');
    assert.equal(clash.kind, 'conflict');
    if (clash.kind !== 'conflict') return;
    assert.deepEqual(clash.files, ['README.md', 'shared.txt']);
  } finally {
    await releaseDurably(fx, tree);
  }
});

test('a failure with no conflicted paths is raised, not reported as a conflict', async () => {
  const fx = fixture('unrelated');
  // An orphan branch shares no history, so git refuses outright: exit 128, nothing unmerged, and
  // no merge to abort. Reporting `conflict` here would brief a reconciliation engineer with an
  // empty list of files to reconcile.
  sh(fx.project, 'checkout', '-q', '--orphan', 'army/orphan');
  sh(fx.project, 'rm', '-q', '-rf', '.');
  writeFileSync(join(fx.project, 'alien.txt'), 'alien\n');
  sh(fx.project, 'add', '.');
  sh(fx.project, 'commit', '-qm', 'orphan');
  sh(fx.project, 'checkout', '-q', 'main');

  const tree = await open(fx);
  try {
    await assert.rejects(
      tree.merge('army/orphan'),
      (error: unknown) =>
        error instanceof IntegrationError && /no conflicted paths/.test(String(error)),
    );
    assert.equal(sh(tree.path, 'rev-parse', 'HEAD'), fx.base);
    assert.equal(trackedDirty(tree.path), '');
  } finally {
    await tree.release();
  }
});

test('a pre-merge-commit hook that refuses leaves no half-merged tree behind', async () => {
  const fx = fixture('hook-refuses');
  workstream(fx, 'army/w1', 'one.txt', 'one\n');
  workstream(fx, 'army/w2', 'two.txt', 'two\n');
  const hooks = join(fx.project, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'pre-merge-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const tree = await open(fx);
  try {
    // git computes the merge, the hook refuses the commit, and git leaves MERGE_HEAD with a
    // staged result and NOTHING unmerged. Without the abort the next merge would run onto it.
    await assert.rejects(
      tree.merge('army/w1'),
      (error: unknown) =>
        error instanceof IntegrationError && /no conflicted paths/.test(String(error)),
    );
    assert.equal(sh(tree.path, 'rev-parse', 'HEAD'), fx.base);
    assert.equal(trackedDirty(tree.path), '');

    rmSync(hook);
    assert.equal((await tree.merge('army/w2')).kind, 'merged');
  } finally {
    await releaseDurably(fx, tree);
  }
});

test('a branch that does not exist is raised rather than reported', async () => {
  const fx = fixture('missing-branch');
  const tree = await open(fx);
  try {
    await assert.rejects(
      tree.merge('army/never-cut'),
      (error: unknown) => error instanceof IntegrationError && /no branch/.test(String(error)),
    );
    // A tag of the same name is not a branch and must not stand in for one.
    sh(fx.project, 'tag', 'army/tagged', fx.base);
    await assert.rejects(tree.merge('army/tagged'), IntegrationError);
  } finally {
    await tree.release();
  }
});

// ---------------------------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------------------------

test('concurrent merges are serialised, including one that conflicts', async () => {
  const fx = fixture('concurrent');
  workstream(fx, 'army/c1', 'shared.txt', 'from c1\n');
  workstream(fx, 'army/c2', 'shared.txt', 'from c2\n');
  workstream(fx, 'army/c3', 'three.txt', 'three\n');

  const tree = await open(fx);
  try {
    const [a, b, c] = await Promise.all([
      tree.merge('army/c1'),
      tree.merge('army/c2'),
      tree.merge('army/c3'),
    ]);
    assert.equal(a.kind, 'merged');
    assert.equal(b.kind, 'conflict');
    assert.equal(c.kind, 'merged');
    // Two merges, in call order, on one linear first-parent chain: nothing raced.
    assert.equal(commitCount(fx), 5);
    assert.equal(trackedDirty(tree.path), '');
    assert.equal(sh(tree.path, 'cat-file', '-p', `${fx.branch}:shared.txt`), 'from c1');
    assert.equal(sh(tree.path, 'cat-file', '-p', `${fx.branch}:three.txt`), 'three');
  } finally {
    await releaseDurably(fx, tree);
  }
});

test('a second holder of the same integration branch is refused by git', async () => {
  const fx = fixture('second-holder');
  const first = await open(fx);
  try {
    await assert.rejects(
      open(fx),
      (error: unknown) =>
        error instanceof IntegrationError && /could not check out/.test(String(error)),
    );
    // The refused open released the tree it leased: only the first holder's lease remains.
    assert.equal(fx.provider.listLeases().length, 1);
  } finally {
    await first.release();
  }
});

// ---------------------------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------------------------

test('release is idempotent and safe after a failed merge', async () => {
  const fx = fixture('release-after-conflict');
  workstream(fx, 'army/w1', 'shared.txt', 'w1\n');
  workstream(fx, 'army/w2', 'shared.txt', 'w2\n');
  const tree = await open(fx);
  // Integrate one, conflict on the other, and only then hand the tree back: the release has to
  // work from the state a conflict leaves behind, which is the state it will most often meet.
  assert.equal((await tree.merge('army/w2')).kind, 'merged');
  assert.equal((await tree.merge('army/w1')).kind, 'conflict');

  await ensureDurable({
    worktree: tree.path,
    branch: fx.branch,
    project: fx.project,
    archiveRoot: join(fx.dir, 'archive'),
  });

  const first = await tree.release();
  assert.deepEqual(first, { kind: 'released', path: tree.path });
  assert.equal(tree.released, true);
  assert.deepEqual(fx.provider.listLeases(), []);

  // Idempotent, and it SAYS so rather than claiming a second return. A caller that released twice
  // has not freed two trees, and an audit log that says it did is an audit log with a phantom slot
  // in it.
  const second = await tree.release();
  assert.deepEqual(second, { kind: 'already-released' });
  assert.equal(tree.released, true);
  assert.deepEqual(fx.provider.listLeases(), []);
});

test('a release the pool refuses comes back as `not-held`, naming what it refused', async () => {
  // THE OUTCOME THAT WAS BEING SWALLOWED. `release()` returned `Promise<void>`, so a refusal had
  // nowhere to go and the campaign wrote `state: 'released'` on the strength of the call not
  // throwing, narrating a path that, for a stale lease, belongs to another holder.
  //
  // The lease record is removed out from under the tree, which is what a crash-recovering
  // supervisor, a `doctor` sweep or another holder taking the slot all look like from in here.
  const fx = fixture('release-not-held');
  workstream(fx, 'army/w1', 'one.txt', 'one\n');
  const tree = await open(fx);
  assert.equal((await tree.merge('army/w1')).kind, 'merged');
  await ensureDurable({
    worktree: tree.path,
    branch: fx.branch,
    project: fx.project,
    archiveRoot: join(fx.dir, 'archive'),
  });

  assert.equal(fx.provider.listLeases().length, 1, 'the tree must be held before the record goes');
  for (const name of readdirSync(fx.provider.leasesDir)) {
    rmSync(join(fx.provider.leasesDir, name), { force: true });
  }

  const outcome = await tree.release();
  assert.equal(outcome.kind, 'not-held', JSON.stringify(outcome));
  if (outcome.kind !== 'not-held') return;
  assert.match(outcome.reason, /no lease record/, 'the reason must name what was refused');
  // And the tree is NOT recorded as returned: nothing here freed a pool slot.
  assert.equal(tree.released, false);
});

test('release refuses while the merges are reachable from no durable ref', async () => {
  const fx = fixture('release-fail-closed');
  workstream(fx, 'army/w1', 'one.txt', 'one\n');
  const tree = await open(fx);
  assert.equal((await tree.merge('army/w1')).kind, 'merged');

  await assert.rejects(tree.release(), UnlandedWorkError);
  assert.equal(tree.released, false);
  assert.equal(fx.provider.listLeases().length, 1);

  await ensureDurable({
    worktree: tree.path,
    branch: fx.branch,
    project: fx.project,
    archiveRoot: join(fx.dir, 'archive'),
  });
  await tree.release();
  assert.equal(tree.released, true);
  assert.deepEqual(fx.provider.listLeases(), []);
});

test('merging after a release is refused rather than performed somewhere else', async () => {
  const fx = fixture('merge-after-release');
  workstream(fx, 'army/w1', 'one.txt', 'one\n');
  const tree = await open(fx);
  await tree.release();
  await assert.rejects(
    tree.merge('army/w1'),
    (error: unknown) => error instanceof IntegrationError && /has been released/.test(String(error)),
  );
});

// ---------------------------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------------------------

test('reopening checks the branch out and carries on from what it already integrated', async () => {
  const fx = fixture('resume');
  workstream(fx, 'army/w1', 'one.txt', 'one\n');
  workstream(fx, 'army/w2', 'two.txt', 'two\n');

  const first = await open(fx);
  assert.equal((await first.merge('army/w1')).kind, 'merged');
  const tip = sh(fx.project, 'rev-parse', fx.branch);
  await releaseDurably(fx, first);

  const second = await open(fx);
  try {
    assert.equal(sh(second.path, 'rev-parse', 'HEAD'), tip);
    assert.equal((await second.merge('army/w1')).kind, 'already-current');
    assert.equal((await second.merge('army/w2')).kind, 'merged');
  } finally {
    await releaseDurably(fx, second);
  }
});

test('a branch of the same name that does not contain the campaign base is refused', async () => {
  const fx = fixture('foreign-branch');
  // A branch that name-collides but descends from somewhere else entirely.
  sh(fx.project, 'checkout', '-q', '--orphan', fx.branch);
  sh(fx.project, 'rm', '-q', '-rf', '.');
  writeFileSync(join(fx.project, 'stranger.txt'), 'not this campaign\n');
  sh(fx.project, 'add', '.');
  sh(fx.project, 'commit', '-qm', 'stranger');
  sh(fx.project, 'checkout', '-q', 'main');

  await assert.rejects(
    open(fx),
    (error: unknown) =>
      error instanceof IntegrationError && /does not contain this campaign/.test(String(error)),
  );
  // Setup closed what it opened: no leaked slot.
  assert.deepEqual(fx.provider.listLeases(), []);
});

/** Durability first, release second. The ordering the whole worktree design turns on. */
async function releaseDurably(fx: Fixture, tree: PooledIntegrationTree): Promise<void> {
  await ensureDurable({
    worktree: tree.path,
    branch: fx.branch,
    project: fx.project,
    archiveRoot: join(fx.dir, 'archive'),
  });
  await tree.release();
}
