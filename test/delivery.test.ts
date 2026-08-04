/**
 * Delivery — the rung ladder and the ceiling clamp, plus the global git deny-list.
 *
 * Real repositories and a real local BARE repository standing in for `origin`, which is what
 * makes push and durability genuinely testable with no network, no GitHub account and no
 * credentials. Rung 2 needs `gh`, which needs the network to even establish whether it is
 * authenticated, so the rung-2 assertions here are about the CAPPING DECISION (with an injected
 * probe) and about the argv that would be sent — never a pretend pull request.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProjectPolicy, Rung } from '../src/contracts/delivery.ts';
import { RUNGS, effectiveRung } from '../src/contracts/delivery.ts';
import type { Verdict } from '../src/contracts/report.ts';
import { armyBranch } from '../src/contracts/worktree.ts';
import { ColdWorktreeProvider } from '../src/worktree/index.ts';
import {
  DurabilityError,
  durableRef,
  ensureDurable,
  ensureMirror,
  mirrorPathFor,
  resolveDurabilityTarget,
} from '../src/delivery/durability.ts';
import {
  DeniedCommandError,
  assertGhAllowed,
  assertGitAllowed,
  probeGh,
  runGit,
} from '../src/delivery/git.ts';
import type { GhStatus } from '../src/delivery/git.ts';
import {
  IMPLEMENTED_RUNGS,
  RungNotImplementedError,
  formatVerdictReview,
  isImplementedRung,
  planDelivery,
  prCreateArgs,
  prReviewArgs,
  projectCeiling,
  runLadder,
} from '../src/delivery/ladder.ts';
import type { DeliveryConfig, DeliveryNoteCode } from '../src/delivery/ladder.ts';

// ---------------------------------------------------------------------------------------------
// hermetic git — no global/system config, fixed identity, no credential prompts, no network
// ---------------------------------------------------------------------------------------------

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'army-delivery-')));
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
  // Worktree lifecycle hooks are read from the army home and nowhere else. Without this
  // the providers built below would read the DEVELOPER's real `~/.agentic-army/config.toml` and
  // run whatever `post_create` it happens to contain, during a test run.
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

function refSha(repo: string, ref: string): string | null {
  try {
    return sh(repo, 'rev-parse', '--verify', '--quiet', ref);
  } catch {
    return null;
  }
}

function config(archiveRoot: string, policies: ProjectPolicy[] = []): DeliveryConfig {
  const projects: Record<string, ProjectPolicy> = {};
  for (const policy of policies) projects[policy.project] = policy;
  return { archiveRoot, projects };
}

const TASK_ID = 'take-hill-4';
const BRANCH = armyBranch(TASK_ID);

interface Stage {
  dir: string;
  project: string;
  archiveRoot: string;
  origin: string | null;
  provider: ColdWorktreeProvider;
  worktree: string;
  sha: string;
}

/** A project, optionally with a local bare `origin`, and a leased worktree holding one commit. */
async function stage(label: string, opts: { origin?: boolean; commit?: boolean } = {}): Promise<Stage> {
  const dir = caseDir(label);
  const project = join(dir, 'repo');
  mkdirSync(project, { recursive: true });
  sh(project, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(project, 'README.md'), '# hill\n');
  sh(project, 'add', '-A');
  sh(project, 'commit', '--quiet', '-m', 'base');

  let origin: string | null = null;
  if (opts.origin === true) {
    origin = join(dir, 'origin.git');
    sh(dir, 'init', '--bare', '--quiet', '-b', 'main', origin);
    sh(project, 'remote', 'add', 'origin', origin);
    sh(project, 'push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main');
  }

  const provider = new ColdWorktreeProvider({ root: join(dir, 'pool') });
  const lease = await provider.acquire('cpt-03', project);

  let sha = sh(lease.path, 'rev-parse', 'HEAD');
  if (opts.commit !== false) {
    sh(lease.path, 'checkout', '--quiet', '-b', BRANCH);
    writeFileSync(join(lease.path, 'hill.txt'), 'taken\n');
    sh(lease.path, 'add', '-A');
    sh(lease.path, 'commit', '--quiet', '-m', 'take the hill');
    sha = sh(lease.path, 'rev-parse', 'HEAD');
  }

  return {
    dir,
    project,
    archiveRoot: join(dir, 'archive'),
    origin,
    provider,
    worktree: lease.path,
    sha,
  };
}

function codes(notes: { code: DeliveryNoteCode }[]): DeliveryNoteCode[] {
  return notes.map((note) => note.code);
}

const GH_MISSING: GhStatus = {
  available: false,
  authenticated: false,
  reason: '`gh` is not installed, so a pull request cannot be opened.',
};
const GH_UNAUTHENTICATED: GhStatus = {
  available: true,
  authenticated: false,
  reason: '`gh` is installed but not authenticated: You are not logged into any GitHub hosts.',
};

const VERDICT: Verdict = {
  verdict: 'fail',
  summary: 'Rate limiter is bypassable when the header is absent.',
  findings: [{ severity: 'blocker', message: 'No default when X-Client is missing.', file: 'src/auth.ts', line: 12 }],
  testsRun: true,
  testCommand: 'npm test',
};

// ---------------------------------------------------------------------------------------------
// the ceiling — global config only, keyed by absolute path, fail closed
// ---------------------------------------------------------------------------------------------

test('a project absent from the global config has no policy and fails closed at rung 0', async () => {
  const s = await stage('no-policy');
  const lookup = projectCeiling(config(s.archiveRoot), s.project);
  assert.equal(lookup.known, false);
  assert.equal(lookup.ceiling, 0);

  const { plan, notes } = await planDelivery({
    taskId: TASK_ID,
    project: s.project,
    requested: 2,
    config: config(s.archiveRoot),
  });
  assert.equal(plan.ceiling, 0);
  assert.equal(plan.rung, 0);
  assert.equal(plan.clamped, true);
  assert.ok(codes(notes).includes('ceiling-missing'), 'the fail-closed default must be announced');
  assert.ok(codes(notes).includes('clamped'));
});

test('the ceiling is NEVER read from the repository being worked on', async () => {
  const s = await stage('repo-cannot-raise-its-own-ceiling');
  // A hostile clone ships every override it can think of.
  writeFileSync(join(s.project, '.agentic-army.toml'), '[projects]\nself = { ceiling = 3 }\n');
  writeFileSync(join(s.project, 'agentic-army.toml'), 'ceiling = 3\n');
  writeFileSync(join(s.project, 'package.json'), JSON.stringify({ agenticArmy: { ceiling: 3 } }));
  sh(s.project, 'add', '-A');
  sh(s.project, 'commit', '--quiet', '-m', 'raise my own ceiling');

  const { plan } = await planDelivery({
    taskId: TASK_ID,
    project: s.project,
    requested: 3,
    config: config(s.archiveRoot), // the user's global config knows nothing about this project
  });
  assert.equal(plan.ceiling, 0, 'a cloned repo must not be able to raise its own blast radius');
  assert.equal(plan.rung, 0);
});

test('the ceiling key is the ABSOLUTE project path, not a basename', async () => {
  const s = await stage('absolute-key');
  const byBasename = config(s.archiveRoot, [{ project: 'repo', ceiling: 3 }]);
  assert.equal(projectCeiling(byBasename, s.project).known, false);
  assert.equal(projectCeiling(byBasename, s.project).ceiling, 0);

  const byPath = config(s.archiveRoot, [{ project: s.project, ceiling: 2 }]);
  assert.deepEqual(projectCeiling(byPath, s.project), { ceiling: 2, known: true, source: 'project' });
});

test('`[delivery] default_ceiling` is honoured for a project with no entry of its own', async () => {
  const s = await stage('default-ceiling');
  const withDefault: DeliveryConfig = {
    ...config(s.archiveRoot),
    delivery: { defaultCeiling: 2 },
  };

  const lookup = projectCeiling(withDefault, s.project);
  assert.deepEqual(lookup, { ceiling: 2, known: false, source: 'default' });

  const { plan, notes } = await planDelivery({
    taskId: TASK_ID,
    project: s.project,
    requested: 3,
    config: withDefault,
  });
  assert.equal(plan.ceiling, 2, 'the documented knob must actually do something');
  assert.equal(plan.rung, 2);
  assert.ok(codes(notes).includes('ceiling-default'), 'and it must say it applied');

  // A per-project entry still wins over the default, in both directions.
  const overridden: DeliveryConfig = {
    ...config(s.archiveRoot, [{ project: s.project, ceiling: 0 }]),
    delivery: { defaultCeiling: 3 },
  };
  assert.deepEqual(projectCeiling(overridden, s.project), {
    ceiling: 0,
    known: true,
    source: 'project',
  });
});

test('a malformed ceiling — anywhere — resolves DOWNWARD, never upward', async () => {
  const s = await stage('malformed-ceiling');
  const bad: unknown[] = [9, -1, 2.5, '3', null, Number.NaN, Number.POSITIVE_INFINITY, {}];

  for (const value of bad) {
    const viaDefault: DeliveryConfig = {
      ...config(s.archiveRoot),
      delivery: { defaultCeiling: value as Rung },
    };
    assert.equal(projectCeiling(viaDefault, s.project).ceiling, 0, `default_ceiling = ${String(value)}`);

    const viaProject: DeliveryConfig = config(s.archiveRoot, [
      { project: s.project, ceiling: value as Rung },
    ]);
    const lookup = projectCeiling(viaProject, s.project);
    assert.equal(lookup.ceiling, 0, `project ceiling = ${String(value)}`);
    assert.equal(lookup.source, 'fail-closed');
  }
});

test('effectiveRung clamping holds end to end, for every requested/ceiling pair', async () => {
  const s = await stage('clamp-matrix');
  for (const requested of RUNGS) {
    for (const ceiling of RUNGS) {
      const { plan, notes } = await planDelivery({
        taskId: TASK_ID,
        project: s.project,
        requested,
        config: config(s.archiveRoot, [{ project: s.project, ceiling }]),
      });
      assert.equal(plan.rung, effectiveRung(requested, ceiling), `${requested}/${ceiling}`);
      assert.ok(plan.rung <= ceiling, 'never above the ceiling');
      assert.equal(plan.requested, requested, 'the request is retained so a clamp is auditable');
      assert.equal(plan.ceiling, ceiling);
      assert.equal(plan.clamped, requested > ceiling);
      assert.equal(
        codes(notes).includes('clamped'),
        requested > ceiling,
        `a clamp must never be silent (${requested}/${ceiling})`,
      );
      assert.equal(plan.branch, BRANCH);
      assert.ok(plan.durability.url.length > 0, 'durability is always planned');
    }
  }
});

test('merge requested on a PR-only repo is clamped to 2, and to 1 on a push-only repo', async () => {
  const s = await stage('clamp-3-to-1');
  const { plan, notes } = await planDelivery({
    taskId: TASK_ID,
    project: s.project,
    requested: 3,
    config: config(s.archiveRoot, [{ project: s.project, ceiling: 1 }]),
  });
  assert.equal(plan.rung, 1);
  assert.equal(plan.clamped, true);
  const clamp = notes.find((n) => n.code === 'clamped');
  assert.ok(clamp !== undefined);
  assert.equal(clamp.level, 'warn');
  assert.match(clamp.message, /3/);
  assert.match(clamp.message, /never higher/);
});

// ---------------------------------------------------------------------------------------------
// rung 3 — unimplemented, and it refuses
// ---------------------------------------------------------------------------------------------

test('rung 3 is not implemented', () => {
  assert.deepEqual([...IMPLEMENTED_RUNGS], [0, 1, 2]);
  for (const rung of [0, 1, 2] as Rung[]) assert.equal(isImplementedRung(rung), true);
  assert.equal(isImplementedRung(3), false);
});

test('rung 3 REFUSES rather than silently doing rung 2', async () => {
  const s = await stage('rung-3', { origin: true });
  const input = {
    taskId: TASK_ID,
    project: s.project,
    worktree: s.worktree,
    requested: 3 as Rung,
    config: config(s.archiveRoot, [{ project: s.project, ceiling: 3 }]),
    verdict: VERDICT,
    ghProbe: async (): Promise<GhStatus> => {
      throw new Error('rung 3 must refuse before gh is ever consulted');
    },
  };

  const { plan, notes } = await planDelivery(input);
  assert.equal(plan.rung, 3, 'the ceiling permits it; the implementation does not');
  assert.ok(codes(notes).includes('rung-unimplemented'));

  await assert.rejects(
    () => runLadder(input),
    (error: unknown) => {
      assert.ok(error instanceof RungNotImplementedError);
      assert.equal(error.rung, 3);
      assert.match(error.message, /not implemented/);
      return true;
    },
  );

  // Nothing shipped: no branch on origin, and no half-done rung 2.
  assert.equal(refSha(s.origin!, `refs/heads/${BRANCH}`), null);
});

// ---------------------------------------------------------------------------------------------
// durability — unconditional, and it is what makes releasing a lease safe
// ---------------------------------------------------------------------------------------------

test('the army mirror is created on demand as a bare repo, disambiguated by absolute path', async () => {
  const s = await stage('mirror-on-demand', { commit: false });
  const path = mirrorPathFor(s.project, s.archiveRoot);
  assert.equal(existsSync(path), false);

  const created = await ensureMirror(s.project, s.archiveRoot);
  assert.equal(created, path);
  assert.equal(sh(created, 'rev-parse', '--is-bare-repository'), 'true');
  assert.ok(created.startsWith(join(s.archiveRoot, 'mirrors')));
  assert.equal(await ensureMirror(s.project, s.archiveRoot), path, 'idempotent');

  // Two checkouts that share a basename must not share a mirror, or `army/<task-id>` from one
  // silently collides with the same branch name from the other.
  const other = mirrorPathFor(join(s.dir, 'elsewhere', 'repo'), s.archiveRoot);
  assert.notEqual(other, path);
});

test('durability targets origin only when the campaign is cleared to push there', async () => {
  const s = await stage('target-selection', { origin: true, commit: false });

  const closed = await resolveDurabilityTarget({ project: s.project, archiveRoot: s.archiveRoot });
  assert.equal(closed.kind, 'mirror', 'fail closed: origin is opt-in');

  const open = await resolveDurabilityTarget({
    project: s.project,
    archiveRoot: s.archiveRoot,
    allowOrigin: true,
  });
  assert.equal(open.kind, 'remote');
  assert.equal(open.remote, 'origin');
  assert.equal(open.url, s.origin);

  // No origin at all is not a failure — durability is not optional.
  const noRemote = await stage('target-no-remote', { commit: false });
  const fallback = await resolveDurabilityTarget({
    project: noRemote.project,
    archiveRoot: noRemote.archiveRoot,
    allowOrigin: true,
  });
  assert.equal(fallback.kind, 'mirror');
});

test('durable marker refs are collision-free and cannot conflict with each other', async () => {
  const dir = caseDir('durable-refs');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '--quiet', '-m', 'base');
  const sha = sh(repo, 'rev-parse', 'HEAD');

  // `x` and `army/x` used to collapse onto the same marker, so making one durable vouched for
  // the other; `army/a` and `army/a/b` used to be a git directory/file conflict, which threw
  // AFTER the push had already succeeded and wedged the lease.
  const branches = ['x', 'army/x', 'army/a', 'army/a/b', 'army/a-b', 'feature/a', 'army/A'];
  const refs = branches.map(durableRef);
  assert.equal(new Set(refs).size, branches.length, 'every branch gets its own marker');

  for (const ref of refs) {
    // `check-ref-format` exits non-zero on an invalid name, and `sh` throws on non-zero — so
    // this line is the assertion that git itself accepts every marker we mint.
    sh(repo, 'check-ref-format', ref);
    sh(repo, 'update-ref', ref, sha);
  }
  // All of them coexist — which is only true because each is a single flat segment.
  const listed = sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/army/durable/').split('\n');
  assert.equal(listed.length, branches.length);
  assert.equal(durableRef('army/take-hill-4'), durableRef('army/take-hill-4'), 'stable');
});

test('durability refuses a dirty tree — the release would destroy what was not pushed', async () => {
  const s = await stage('dirty');
  writeFileSync(join(s.worktree, 'scratch.txt'), 'unstaged\n');
  await assert.rejects(
    () => ensureDurable({ worktree: s.worktree, branch: BRANCH, project: s.project, archiveRoot: s.archiveRoot }),
    DurabilityError,
  );
});

// ---------------------------------------------------------------------------------------------
// the ladder, rung by rung
// ---------------------------------------------------------------------------------------------

test('rung 0: durable in the army mirror, and YOUR REPO IS UNTOUCHED', async () => {
  const s = await stage('rung-0', { origin: true });
  const result = await runLadder({
    taskId: TASK_ID,
    project: s.project,
    worktree: s.worktree,
    requested: 0,
    config: config(s.archiveRoot, [{ project: s.project, ceiling: 0 }]),
  });

  assert.equal(result.plan.rung, 0);
  assert.equal(result.delivered, 0);
  assert.equal(result.pr, null);
  assert.equal(result.durability.target.kind, 'mirror');
  assert.equal(result.durability.commit, s.sha);

  // Durable…
  assert.equal(sh(result.durability.target.url, 'rev-parse', `refs/heads/${BRANCH}`), s.sha);
  // …and the project's own remote never heard about it.
  assert.equal(refSha(s.origin!, `refs/heads/${BRANCH}`), null, 'rung 0 must not touch origin');

  // And the lease is now safe to return, which is the entire point of treating the push as
  // durability rather than as delivery.
  const released = await s.provider.tryRelease({
    path: s.worktree,
    leaseId: s.provider.listLeases()[0]!.leaseId,
    leaseHolder: 'cpt-03',
    leasedAt: new Date().toISOString(),
    provider: 'cold',
  });
  assert.equal(released.outcome, 'released');
  // A release now returns the tree to the pool WARM instead of deleting it, so the thing
  // that proves durability here is not that the directory vanished — it is that the tree was
  // reset back to base, taking the work with it, and the work is durable anyway.
  assert.equal(released.warm, true);
  assert.equal(existsSync(join(s.worktree, 'hill.txt')), false, 'the tree no longer holds it');
  assert.equal(sh(result.durability.target.url, 'rev-parse', `refs/heads/${BRANCH}`), s.sha);
});

test('rung 1: the branch lands on origin, and the durability push IS the push', async () => {
  const s = await stage('rung-1', { origin: true });
  const result = await runLadder({
    taskId: TASK_ID,
    project: s.project,
    worktree: s.worktree,
    requested: 1,
    config: config(s.archiveRoot, [{ project: s.project, ceiling: 1 }]),
  });

  assert.equal(result.delivered, 1);
  assert.equal(result.durability.target.kind, 'remote');
  assert.equal(result.durability.target.url, s.origin);
  assert.equal(refSha(s.origin!, `refs/heads/${BRANCH}`), s.sha);
  assert.equal(result.pr, null);
});

test('rung 1 without an origin delivers 0 and says so; the work is still durable', async () => {
  const s = await stage('rung-1-no-origin');
  const result = await runLadder({
    taskId: TASK_ID,
    project: s.project,
    worktree: s.worktree,
    requested: 1,
    config: config(s.archiveRoot, [{ project: s.project, ceiling: 1 }]),
  });

  assert.equal(result.plan.rung, 1);
  assert.equal(result.delivered, 0, 'there is no origin to push a branch to');
  const note = result.notes.find((n) => n.code === 'no-origin');
  assert.ok(note !== undefined, 'a delivered rung below the planned one must never be silent');
  assert.equal(note.level, 'warn');
  assert.equal(result.durability.target.kind, 'mirror');
  assert.equal(sh(result.durability.target.url, 'rev-parse', `refs/heads/${BRANCH}`), s.sha);
});

test('rung 2 caps at rung 1 when gh is missing, and says why', async () => {
  const s = await stage('rung-2-no-gh', { origin: true });
  const result = await runLadder({
    taskId: TASK_ID,
    project: s.project,
    worktree: s.worktree,
    requested: 2,
    config: config(s.archiveRoot, [{ project: s.project, ceiling: 2 }]),
    verdict: VERDICT,
    ghProbe: async () => GH_MISSING,
  });

  assert.equal(result.plan.rung, 2);
  assert.equal(result.delivered, 1, 'the push still happened — rungs are prefixes');
  assert.equal(result.pr, null);
  assert.equal(refSha(s.origin!, `refs/heads/${BRANCH}`), s.sha);

  const note = result.notes.find((n) => n.code === 'gh-unavailable');
  assert.ok(note !== undefined);
  assert.equal(note.level, 'warn');
  assert.match(note.message, /not installed/);
  assert.match(note.message, /rung 1/);
});

test('rung 2 caps at rung 1 when gh is installed but unauthenticated', async () => {
  const s = await stage('rung-2-unauth', { origin: true });
  const result = await runLadder({
    taskId: TASK_ID,
    project: s.project,
    worktree: s.worktree,
    requested: 2,
    config: config(s.archiveRoot, [{ project: s.project, ceiling: 2 }]),
    verdict: VERDICT,
    ghProbe: async () => GH_UNAUTHENTICATED,
  });

  assert.equal(result.delivered, 1);
  const note = result.notes.find((n) => n.code === 'gh-unauthenticated');
  assert.ok(note !== undefined);
  assert.match(note.message, /not authenticated/);
});

test('a clamped campaign never consults gh at all', async () => {
  const s = await stage('clamped-no-gh', { origin: true });
  const result = await runLadder({
    taskId: TASK_ID,
    project: s.project,
    worktree: s.worktree,
    requested: 2,
    config: config(s.archiveRoot, [{ project: s.project, ceiling: 1 }]),
    ghProbe: async (): Promise<GhStatus> => {
      throw new Error('gh must not be probed for a campaign clamped below rung 2');
    },
  });
  assert.equal(result.plan.rung, 1);
  assert.equal(result.delivered, 1);
  assert.equal(result.plan.clamped, true);
});

test('the ladder refuses a dirty worktree before anything is delivered', async () => {
  const s = await stage('ladder-dirty', { origin: true });
  writeFileSync(join(s.worktree, 'untracked.txt'), 'work nobody committed\n');
  await assert.rejects(
    () =>
      runLadder({
        taskId: TASK_ID,
        project: s.project,
        worktree: s.worktree,
        requested: 1,
        config: config(s.archiveRoot, [{ project: s.project, ceiling: 1 }]),
      }),
    DurabilityError,
  );
  assert.equal(refSha(s.origin!, `refs/heads/${BRANCH}`), null);
});

// ---------------------------------------------------------------------------------------------
// rung 2 argv — offline, because building the command is separable from sending it
// ---------------------------------------------------------------------------------------------

test('the pull-request argv opens against the army branch and nothing else', () => {
  assert.deepEqual(prCreateArgs(BRANCH, { title: 't', body: 'b' }), [
    'pr',
    'create',
    '--head',
    BRANCH,
    '--title',
    't',
    '--body',
    'b',
  ]);
  assert.ok(prCreateArgs(BRANCH, { title: 't', body: 'b', base: 'main' }).includes('--base'));
});

test('the Inspector verdict is posted as a COMMENT review, never an approval', () => {
  const args = prReviewArgs('https://example.invalid/pr/1', VERDICT);
  assert.deepEqual(args.slice(0, 4), ['pr', 'review', 'https://example.invalid/pr/1', '--comment']);
  assert.ok(!args.includes('--approve'), 'the army must never approve a pull request');
  assert.ok(!args.includes('--request-changes'));

  const body = formatVerdictReview(VERDICT);
  assert.match(body, /FAIL/);
  assert.match(body, /bypassable/);
  assert.match(body, /blocker/);
  assert.match(body, /src\/auth\.ts:12/);
  assert.match(body, /npm test/);
  assert.match(body, /Not an approval/);

  const unread = formatVerdictReview({ verdict: 'pass', summary: 'looks fine', findings: [], testsRun: false });
  assert.match(unread, /NOT executed/, 'a pass without tests must be visibly suspicious');
});

// ---------------------------------------------------------------------------------------------
// the global deny-list — no per-role override, enforced before spawn
// ---------------------------------------------------------------------------------------------

test('git push --force and every variant of it are denied globally', async () => {
  const denied: string[][] = [
    ['push', '--force', 'origin', 'main'],
    ['push', '-f', 'origin', 'main'],
    ['push', '--force-with-lease', 'origin', 'main'],
    ['push', '--force-with-lease=main', 'origin', 'main'],
    ['push', '--force-if-includes', 'origin', 'main'],
    ['push', '--mirror', 'origin'],
    ['push', '--delete', 'origin', 'army/take-hill-4'],
    ['push', 'origin', '+refs/heads/main:refs/heads/main'],
    ['-C', '/tmp', 'push', '--force', 'origin', 'main'],
  ];
  for (const args of denied) {
    assert.throws(() => assertGitAllowed(args), DeniedCommandError, `git ${args.join(' ')}`);
    // and it is refused before a process is ever spawned
    await assert.rejects(() => runGit(args), DeniedCommandError);
  }

  // The ordinary push the ladder actually makes is allowed.
  assert.doesNotThrow(() =>
    assertGitAllowed(['push', '/tmp/mirror.git', `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]),
  );
  assert.doesNotThrow(() => assertGitAllowed(['worktree', 'remove', '--force', '/tmp/wt']));
  assert.doesNotThrow(() => assertGitAllowed(['commit', '-m', 'a --force of nature']));
});

// -------------------------------------------------------------------------------------------
// ADVERSARIAL. Every one of these got past the first version of the guard; two of them landed
// a real force-push through `runGit` and overwrote a bare remote's history. They are asserted
// against a real local bare repo — argv refusal AND the remote's sha afterwards — because a
// guard that is only unit-tested against itself proves nothing about what git would have done.
// -------------------------------------------------------------------------------------------

test('a force-push cannot be smuggled past the guard, and the remote is untouched', async () => {
  const dir = caseDir('force-push-bypasses');
  const project = join(dir, 'repo');
  mkdirSync(project, { recursive: true });
  sh(project, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(project, 'a.txt'), 'one\n');
  sh(project, 'add', '-A');
  sh(project, 'commit', '--quiet', '-m', 'one');

  const bare = join(dir, 'origin.git');
  sh(dir, 'init', '--bare', '--quiet', '-b', 'main', bare);
  sh(project, 'push', '--quiet', bare, 'refs/heads/main:refs/heads/main');
  const pristine = sh(bare, 'rev-parse', 'refs/heads/main');

  // A rewritten history that ONLY a force-push could land on `main`.
  writeFileSync(join(project, 'a.txt'), 'REWRITTEN\n');
  sh(project, 'add', '-A');
  sh(project, 'commit', '--quiet', '--amend', '-m', 'rewritten');
  const rewritten = sh(project, 'rev-parse', 'HEAD');
  assert.notEqual(rewritten, pristine);

  const smuggled: Array<[string, string[]]> = [
    // `--` separates flags from operands; it does not make an operand safe. This one exited 0
    // and overwrote the remote before the fix.
    ['+refspec after --', ['push', bare, '--', `+${rewritten}:refs/heads/main`]],
    ['--force after --', ['push', bare, '--', '--force', `${rewritten}:refs/heads/main`]],
    // git's parse-options accepts short-flag clusters, so `-f` can hide inside `-uf`. This one
    // also exited 0 and overwrote the remote before the fix.
    ['-f bundled into -uf', ['push', '-uf', bare, `${rewritten}:refs/heads/main`]],
    ['-f bundled into -qf', ['push', '-qf', bare, `${rewritten}:refs/heads/main`]],
    ['+refspec with no colon', ['push', bare, `+${rewritten}`]],
    // Flags that hand the far end an arbitrary payload.
    ['--receive-pack=', ['push', `--receive-pack=git-receive-pack`, bare, 'refs/heads/main:refs/heads/main']],
    ['--exec=', ['push', `--exec=git-receive-pack`, bare, 'refs/heads/main:refs/heads/main']],
    ['--push-option', ['push', '-o', 'anything', bare, 'refs/heads/main:refs/heads/main']],
    ['--prune (deletes remote refs)', ['push', '--prune', bare, 'refs/heads/*:refs/heads/*']],
    // Config injection: `protocol.ext.allow` turns a URL into command execution.
    ['-c protocol.ext.allow', ['-c', 'protocol.ext.allow=always', 'push', bare, 'main']],
    ['--config-env', ['--config-env', 'protocol.ext.allow=X', 'push', bare, 'main']],
    ['ext:: transport URL', ['push', 'ext::sh -c touch% /tmp/pwned', 'refs/heads/main']],
  ];

  for (const [label, args] of smuggled) {
    assert.throws(() => assertGitAllowed(args), DeniedCommandError, label);
    await assert.rejects(() => runGit(args, { cwd: project }), DeniedCommandError, label);
    assert.equal(
      sh(bare, 'rev-parse', 'refs/heads/main'),
      pristine,
      `${label}: the remote must be exactly as it was`,
    );
  }

  // The control: the ordinary fast-forward push the ladder actually makes still works.
  const ok = await runGit(['push', bare, `refs/heads/main:refs/heads/army-control`], { cwd: project });
  assert.equal(ok.code, 0, ok.stderr);
});

test('gh pr merge is not reachable, by any spelling', () => {
  const denied: Array<[string, string[]]> = [
    ['plain', ['pr', 'merge', '412']],
    ['with a flag', ['pr', 'merge', '--squash', '412']],
    // cobra accepts flags BEFORE the subcommand, so `--repo O/R` hid `merge` from a scanner
    // that filtered on leading dashes.
    ['flags before the subcommand', ['pr', '--repo', 'org/repo', 'merge', '412']],
    ['flag with =', ['pr', '--repo=org/repo', 'merge', '412']],
    ['short flag', ['pr', '-R', 'org/repo', 'merge', '412']],
    // …and the REST API reaches the same endpoint without ever saying "merge" as a subcommand.
    ['gh api -X PUT', ['api', '-X', 'PUT', 'repos/org/repo/pulls/412/merge']],
    ['gh api --method', ['api', '--method', 'PUT', 'repos/org/repo/pulls/412/merge']],
    ['gh api plain', ['api', 'repos/org/repo/pulls/412/merge']],
    ['gh repo delete', ['repo', 'delete', 'org/repo']],
    ['gh workflow run', ['workflow', 'run', 'deploy.yml']],
    ['gh release create', ['release', 'create', 'v9']],
    ['unknown flag on a permitted command', ['pr', 'view', '--web']],
    ['approval', ['pr', 'review', '1', '--approve']],
    ['request changes', ['pr', 'review', '1', '--request-changes', '--body', 'no']],
    ['a review that is not a comment', ['pr', 'review', '1', '--body', 'no']],
  ];
  for (const [label, args] of denied) {
    assert.throws(() => assertGhAllowed(args), DeniedCommandError, label);
  }

  // Exactly what this module needs, and nothing else.
  assert.doesNotThrow(() => assertGhAllowed(prCreateArgs(BRANCH, { title: 't', body: 'b' })));
  assert.doesNotThrow(() => assertGhAllowed(prCreateArgs(BRANCH, { title: 't', body: 'b', base: 'main' })));
  assert.doesNotThrow(() => assertGhAllowed(prReviewArgs('1', VERDICT)));
  assert.doesNotThrow(() => assertGhAllowed(['--version']));
  assert.doesNotThrow(() => assertGhAllowed(['auth', 'status']));
  assert.doesNotThrow(() => assertGhAllowed(['pr', 'view', '1', '--json', 'url']));
});

test('a pull-request body that looks like a flag is a value, not an argument', () => {
  // `--body` consumes the next token whatever it looks like, so a hostile verdict summary
  // cannot inject `--approve` by living inside the body.
  const args = prReviewArgs('1', { ...VERDICT, summary: '--approve --admin' });
  assert.doesNotThrow(() => assertGhAllowed(args));
  assert.equal(args[args.length - 2], '--body');
  assert.ok(args[args.length - 1]!.includes('--approve'), 'it is carried as text, not as a flag');
});

test('probing a gh that is not installed reports it instead of throwing', async () => {
  const status = await probeGh({ binary: 'gh-absent-6f1c2d' });
  assert.equal(status.available, false);
  assert.equal(status.authenticated, false);
  assert.match(status.reason ?? '', /not installed/);
});
