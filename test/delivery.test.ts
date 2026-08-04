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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProjectPolicy, Rung } from '../src/contracts/delivery.ts';
import { RUNGS, RUNG_LABEL, effectiveRung } from '../src/contracts/delivery.ts';
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
  grantMergeAuthority,
  prMergeArgs,
  probeGh,
  runGit,
} from '../src/delivery/git.ts';
import type { GhStatus, MergeAuthority } from '../src/delivery/git.ts';
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
import type {
  DeliveryConfig,
  DeliveryNoteCode,
  MergeRequest,
  RunLadderInput,
} from '../src/delivery/ladder.ts';

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

const PASS: Verdict = {
  verdict: 'pass',
  summary: 'The hill is taken and the suite is green.',
  findings: [],
  testsRun: true,
  testCommand: 'npm test',
};

/** The evidence a caller must supply for rung 3. This is the only shape that merges. */
const CLEARED: MergeRequest = { engineerStatus: 'done', retriesExhausted: false };

// ---------------------------------------------------------------------------------------------
// a stand-in for the host
//
// `gh` cannot be exercised here: it needs a network and a GitHub account, and this suite has
// neither by design. So the HOST is stubbed and everything else is real — real repositories, a
// real bare repo standing in for origin, a real durability push, a real subprocess for every gh
// call, and the real allow-list running on every argv before the spawn. The stub performs a real
// merge (it fast-forwards the bare repo's base branch), so "merged" is a fact about a repository
// on disk rather than a string this suite agreed with itself about.
//
// WHAT THIS DOES NOT PROVE, stated here so nobody reads more into it later: that the real `gh`
// accepts these flags, and that GitHub behaves as the stub does. Those remain code claims.
// ---------------------------------------------------------------------------------------------

const GH_STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STATE = path.join(__dirname, 'state.json');
const CALLS = path.join(__dirname, 'calls.jsonl');
const argv = process.argv.slice(2);
fs.appendFileSync(CALLS, JSON.stringify(argv) + '\\n');

const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const out = (s) => { process.stdout.write(s + '\\n'); process.exit(0); };
const fail = (s) => { process.stderr.write(s + '\\n'); process.exit(1); };
const value = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };

if (argv.includes('--version')) out('gh version 2.60.0 (stub)');
const command = argv.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ');

if (command === 'auth status') out('github.com\\n  ✓ Logged in to github.com account army-stub');

if (command === 'pr create') {
  // Real gh refuses when the branch already has one, and names it. So does this.
  if (state.prState !== 'NONE') {
    fail('a pull request for branch "' + String(value('--head')) + '" already exists:\\n' + state.url);
  }
  state.prState = 'OPEN';
  save();
  out(state.url);
}

if (command === 'pr list') {
  if (state.prState === 'NONE') out('[]');
  out(JSON.stringify([{ url: state.url, state: state.prState }]));
}

if (command === 'pr review') {
  if (state.mode === 'review-fails') fail('HTTP 403: Resource not accessible by integration');
  state.reviews = (state.reviews || 0) + 1;
  save();
  out('Reviewed pull request');
}

if (command === 'pr view') {
  if (state.mode === 'view-fails') fail('GraphQL: Could not resolve to a PullRequest');
  const all = { state: state.prState, headRefOid: state.headRefOid, url: state.url };
  const picked = {};
  for (const field of (value('--json') || '').split(',')) {
    if (Object.prototype.hasOwnProperty.call(all, field)) picked[field] = all[field];
  }
  out(JSON.stringify(picked));
}

if (command === 'pr merge') {
  state.mergeAttempts = (state.mergeAttempts || 0) + 1;
  save();
  // Real gh refuses when the pin does not match; so does this.
  if (value('--match-head-commit') !== state.headRefOid) {
    fail('failed to merge: head commit changed on the pull request');
  }
  if (state.mode === 'protected') {
    fail('Pull request is not mergeable: the base branch policy prohibits the merge.');
  }
  // The merge, actually performed against the bare repository standing in for the host.
  execFileSync('git', ['--git-dir', state.bare, 'update-ref', 'refs/heads/' + state.base, state.headRefOid]);
  state.prState = 'MERGED';
  save();
  if (state.mode === 'partial') fail('merged, but failed to delete branch: HTTP 422');
  out('✓ Merged pull request #' + String(state.number || 1));
}

fail('stub gh: unsupported command: ' + argv.join(' '));
`;

interface GhStub {
  /** Path to the executable, handed to the ladder as \`ghBinary\`. */
  bin: string;
  /** Every argv the ladder actually spawned, in order. */
  calls: () => string[][];
  merges: () => string[][];
  state: () => Record<string, unknown>;
}

function ghStub(dir: string, init: Record<string, unknown>): GhStub {
  const home = join(dir, 'ghbin');
  mkdirSync(home, { recursive: true });
  const bin = join(home, 'gh');
  // Extensionless, so node decides the module system from the nearest package.json. Pin it.
  writeFileSync(join(home, 'package.json'), '{"type":"commonjs"}\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify(init, null, 2));
  writeFileSync(join(home, 'calls.jsonl'), '');
  writeFileSync(bin, GH_STUB);
  chmodSync(bin, 0o755);

  const calls = (): string[][] =>
    readFileSync(join(home, 'calls.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);

  return {
    bin,
    calls,
    merges: () => calls().filter((argv) => argv[0] === 'pr' && argv[1] === 'merge'),
    state: () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as Record<string, unknown>,
  };
}

const PR_URL = 'https://github.invalid/army/hill/pull/7';

/** A stage with an origin, a PASS-worthy commit, and a host that will say yes. */
async function mergeStage(
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<Stage & { gh: GhStub }> {
  const s = await stage(label, { origin: true });
  const gh = ghStub(s.dir, {
    url: PR_URL,
    prState: 'NONE',
    headRefOid: s.sha,
    bare: s.origin,
    base: 'main',
    mode: 'ok',
    ...overrides,
  });
  return { ...s, gh };
}

function mergeInput(s: Stage & { gh: GhStub }, over: Partial<RunLadderInput> = {}): RunLadderInput {
  return {
    taskId: TASK_ID,
    project: s.project,
    worktree: s.worktree,
    requested: 3,
    config: config(s.archiveRoot, [{ project: s.project, ceiling: 3 }]),
    verdict: PASS,
    merge: CLEARED,
    ghBinary: s.gh.bin,
    ...over,
  };
}

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
// rung 3 — implemented, and it needs a caller that implemented it too
// ---------------------------------------------------------------------------------------------

test('every rung is implemented, and rung 3 additionally needs its evidence', () => {
  assert.deepEqual([...IMPLEMENTED_RUNGS], [0, 1, 2, 3]);
  for (const rung of RUNGS) assert.equal(isImplementedRung(rung), true);
});

test('rung 3 with no merge evidence REFUSES rather than silently doing rung 2', async () => {
  const s = await stage('rung-3-no-evidence', { origin: true });
  const input = {
    taskId: TASK_ID,
    project: s.project,
    worktree: s.worktree,
    requested: 3 as Rung,
    config: config(s.archiveRoot, [{ project: s.project, ceiling: 3 }]),
    verdict: PASS,
    ghProbe: async (): Promise<GhStatus> => {
      throw new Error('a rung-3 plan with no evidence must refuse before gh is ever consulted');
    },
  };

  const { plan, notes } = await planDelivery(input);
  assert.equal(plan.rung, 3, 'the ceiling permits it');
  assert.ok(codes(notes).includes('merge-planned'));

  await assert.rejects(
    () => runLadder(input),
    (error: unknown) => {
      assert.ok(error instanceof RungNotImplementedError);
      assert.equal(error.rung, 3);
      assert.match(error.message, /not implemented/);
      assert.match(error.message, /merge evidence/);
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
  const released = await s.provider.release({
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
// rung 3 — the merge, against a real local bare repo and a stubbed host
// ---------------------------------------------------------------------------------------------

test('rung 3 merges after a PASS, and the work is really on the base branch afterwards', async () => {
  const s = await mergeStage('rung-3-merge');
  const baseBefore = refSha(s.origin!, 'refs/heads/main');
  assert.notEqual(baseBefore, s.sha);

  // No injected probe: `probeGh` itself runs, against the stub, so the whole chain is exercised.
  const result = await runLadder(mergeInput(s));

  assert.equal(result.plan.rung, 3);
  assert.equal(result.delivered, 3);
  assert.equal(result.merge?.status, 'merged');
  assert.equal(result.merge?.headCommit, s.sha);
  assert.ok(codes(result.notes).includes('merged'));

  // The fact, not the claim: the bare repository standing in for origin has the work on `main`.
  assert.equal(refSha(s.origin!, 'refs/heads/main'), s.sha);
  assert.equal(s.gh.state().prState, 'MERGED');

  // Durability is unconditional and unchanged by the rung: the branch reached origin and the
  // local marker ref was written, exactly as at rung 1.
  assert.equal(refSha(s.origin!, `refs/heads/${BRANCH}`), s.sha);
  assert.equal(result.durability.target.kind, 'remote');
  assert.equal(refSha(s.project, durableRef(BRANCH)), s.sha);

  // And the argv that did it: one merge, pinned to the reviewed commit, with nothing that
  // overrides the host.
  const merges = s.gh.merges();
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0], ['pr', 'merge', PR_URL, '--squash', '--match-head-commit', s.sha]);
  for (const argv of s.gh.calls()) {
    assert.ok(!argv.includes('--admin'), `no override may appear in any argv: ${argv.join(' ')}`);
    assert.ok(!argv.includes('--auto'));
    assert.ok(!argv.includes('--delete-branch'));
    assert.ok(!argv.includes('--approve'));
  }
});

test('running the same rung-3 delivery twice merges once', async () => {
  const s = await mergeStage('rung-3-twice');
  const first = await runLadder(mergeInput(s));
  assert.equal(first.merge?.status, 'merged');

  // The second run finds the pull request already there (gh refuses to open a second one),
  // adopts it, and finds it merged. Nothing is opened twice and nothing is merged twice.
  const second = await runLadder(mergeInput(s));
  assert.equal(second.delivered, 3);
  assert.equal(second.merge?.status, 'already-merged');
  assert.equal(s.gh.merges().length, 1, 'exactly one merge across two runs');
  assert.ok(codes(second.notes).includes('merge-noop'));
  assert.match(
    second.notes.find((n) => n.code === 'pr-opened')?.message ?? '',
    /adopted the pull request/,
  );
  assert.equal(refSha(s.origin!, 'refs/heads/main'), s.sha);
});

test('a FAIL verdict cannot merge — the pull request stays open with the verdict on it', async () => {
  const s = await mergeStage('rung-3-fail');
  const result = await runLadder(mergeInput(s, { verdict: VERDICT }));

  // The facts first, then what was said about them: an assertion order that fails on the world
  // before it fails on the prose.
  assert.equal(s.gh.merges().length, 0, 'the host was never asked');
  assert.equal(refSha(s.origin!, 'refs/heads/main'), refSha(s.project, 'refs/heads/main'));
  assert.equal(s.gh.state().prState, 'OPEN');

  assert.equal(result.plan.rung, 3);
  assert.equal(result.delivered, 2, 'the pull request is still the right outcome for a FAIL');
  assert.equal(result.merge?.status, 'refused');
  assert.match(result.merge?.detail ?? '', /FAIL/, 'the refusal must name the reason it refused');

  const note = result.notes.find((n) => n.code === 'merge-refused');
  assert.ok(note !== undefined, 'a rung that did not happen must never be silent');
  assert.equal(note.level, 'warn');
});

test('a missing verdict cannot merge, and neither can an unposted one', async () => {
  const missing = await mergeStage('rung-3-no-verdict');
  const noVerdict = await runLadder(mergeInput(missing, { verdict: undefined }));
  assert.equal(noVerdict.delivered, 2);
  assert.equal(noVerdict.merge?.status, 'refused');
  assert.match(noVerdict.merge?.detail ?? '', /no Inspector verdict/);
  assert.equal(missing.gh.merges().length, 0);
  assert.ok(codes(noVerdict.notes).includes('review-not-posted'));

  // A PASS that could not be posted on the pull request leaves rung 2 incomplete, so rung 3
  // never starts: no merge may rest on a judgement the reviewers cannot see.
  const unposted = await mergeStage('rung-3-review-failed', { mode: 'review-fails' });
  const result = await runLadder(mergeInput(unposted));
  assert.equal(result.pr?.reviewPosted, false);
  assert.equal(result.delivered, 2);
  assert.equal(result.merge?.status, 'refused');
  assert.match(result.merge?.detail ?? '', /rung 2 is incomplete/);
  assert.equal(unposted.gh.merges().length, 0);
});

// ---------------------------------------------------------------------------------------------
// what leaves this process and is read by someone else
//
// Two messages in the ladder are read by a HUMAN who is not holding this source: the body of the
// pull request, which lands on a code host, and the note that says a review could not be posted,
// which lands in front of the operator. Both were stating something other than the fact they
// existed to state, and neither had a test — so both stayed wrong through the whole of rung 3
// being built on top of them.
// ---------------------------------------------------------------------------------------------

test('the pull-request body names the rung being delivered, and never a literal one', async () => {
  for (const rung of [2, 3] as Rung[]) {
    const s = await mergeStage(`pr-body-rung-${String(rung)}`);
    await runLadder(
      mergeInput(s, {
        requested: rung,
        config: config(s.archiveRoot, [{ project: s.project, ceiling: rung }]),
      }),
    );

    const create = s.gh.calls().find((argv) => argv[0] === 'pr' && argv[1] === 'create');
    assert.ok(create !== undefined, `rung ${String(rung)} opened no pull request`);
    const body = create[create.indexOf('--body') + 1] ?? '';

    assert.ok(
      body.includes(`rung ${String(rung)} (${RUNG_LABEL[rung]})`),
      `a rung-${String(rung)} delivery described itself as something else:\n${body}`,
    );
    if (rung === 3) {
      // The defect exactly: this pull request is merged minutes later by the rung it is denying.
      assert.doesNotMatch(
        body,
        /rung 2\b/,
        `a rung-3 delivery called itself rung 2 on the code host:\n${body}`,
      );
    }
  }
});

test('a review the host refused quotes the HOST, not the command we sent it', async () => {
  const s = await mergeStage('review-refused-quote', { mode: 'review-fails' });
  const result = await runLadder(mergeInput(s));

  assert.equal(result.pr?.reviewPosted, false);
  const note = result.notes.find((n) => n.code === 'review-not-posted');
  assert.ok(note !== undefined, 'a review that was not posted must never be silent');

  // What the operator needs: why the remote said no.
  assert.match(
    note.message,
    /HTTP 403: Resource not accessible by integration/,
    `the host's reason is not in the note:\n${note.message}`,
  );

  // What they were given instead. `CommandError.message` opens with `<file> <argv…> exited <n>`
  // and puts the host's words on the lines below, so taking its first line printed our own
  // command — and for a review that argv ends in the verdict markdown, so the note trailed off
  // into the model's prose where the reason should have been.
  for (const ours of ['--body', 'pr review', '**Inspector verdict: PASS**', 'exited 1']) {
    assert.ok(
      !note.message.includes(ours),
      `the note quotes our own command back at the reader (${ours}):\n${note.message}`,
    );
  }
});

test('a blocked Engineer and an exhausted retry budget cannot merge', async () => {
  for (const [label, evidence] of [
    ['blocked', { engineerStatus: 'blocked', retriesExhausted: false }],
    ['failed', { engineerStatus: 'failed', retriesExhausted: false }],
    ['retries exhausted', { engineerStatus: 'done', retriesExhausted: true }],
  ] as [string, MergeRequest][]) {
    const s = await mergeStage(`rung-3-${label.replace(/\s+/g, '-')}`);
    const result = await runLadder(mergeInput(s, { merge: evidence }));
    assert.equal(result.delivered, 2, label);
    assert.equal(result.merge?.status, 'refused', label);
    assert.equal(s.gh.merges().length, 0, label);
    assert.equal(refSha(s.origin!, 'refs/heads/main'), refSha(s.project, 'refs/heads/main'), label);
  }
});

test('a ceiling below 3 cannot merge, whatever the campaign asks for', async () => {
  // Highest first: ceiling 2 is the one that has a pull request to merge and is therefore the
  // only one where a broken clamp could actually land something.
  for (const ceiling of [2, 1, 0] as Rung[]) {
    const s = await mergeStage(`rung-3-ceiling-${String(ceiling)}`);
    const result = await runLadder(
      mergeInput(s, { config: config(s.archiveRoot, [{ project: s.project, ceiling }]) }),
    );
    assert.equal(s.gh.merges().length, 0, `ceiling ${String(ceiling)} asked the host to merge`);
    assert.equal(
      refSha(s.origin!, 'refs/heads/main'),
      refSha(s.project, 'refs/heads/main'),
      `ceiling ${String(ceiling)} moved the base branch`,
    );
    assert.equal(result.plan.ceiling, ceiling);
    assert.equal(result.plan.rung, ceiling, 'the clamp, not the request, decides');
    assert.equal(result.plan.clamped, true);
    assert.equal(result.merge, null, `ceiling ${String(ceiling)} never reaches the merge rung`);
    assert.ok(result.delivered <= 2);
  }
});

test('an unparseable ceiling falls to 0, and never to 3', async () => {
  const s = await mergeStage('rung-3-unparseable-ceiling');
  const nonsense: unknown[] = ['3', 3.0001, null, Number.NaN, {}, [3], true, '', Number.POSITIVE_INFINITY];

  for (const value of nonsense) {
    const cfg = config(s.archiveRoot, [{ project: s.project, ceiling: value as Rung }]);
    assert.equal(projectCeiling(cfg, s.project).ceiling, 0, String(value));
    assert.equal(projectCeiling(cfg, s.project).source, 'fail-closed', String(value));

    const { plan } = await planDelivery({
      taskId: TASK_ID,
      project: s.project,
      requested: 3,
      config: cfg,
    });
    assert.equal(plan.rung, 0, `ceiling ${String(value)} must fail closed at 0`);
  }

  // …and end to end: a rung-3 request against a garbage ceiling delivers rung 0 and asks the
  // host nothing at all.
  const result = await runLadder(
    mergeInput(s, {
      config: config(s.archiveRoot, [{ project: s.project, ceiling: 'three' as unknown as Rung }]),
    }),
  );
  assert.equal(result.delivered, 0);
  assert.equal(result.merge, null);
  assert.equal(result.durability.target.kind, 'mirror', 'rung 0 keeps origin out of it');
  assert.equal(s.gh.calls().length, 0, 'gh was never even probed');
  assert.equal(refSha(s.origin!, `refs/heads/${BRANCH}`), null);
});

test("the host's refusal is reported faithfully and never worked around", async () => {
  const s = await mergeStage('rung-3-branch-protection', { mode: 'protected' });
  const result = await runLadder(mergeInput(s));

  assert.equal(result.delivered, 2);
  assert.equal(result.merge?.status, 'blocked');
  assert.match(result.merge?.detail ?? '', /base branch policy prohibits the merge/);

  const note = result.notes.find((n) => n.code === 'merge-blocked');
  assert.ok(note !== undefined);
  assert.match(note.message, /honoured as stated/);

  // ONE attempt. No retry with different flags, no admin override, and the base branch is
  // exactly where the host left it.
  assert.equal(s.gh.merges().length, 1);
  assert.equal(refSha(s.origin!, 'refs/heads/main'), refSha(s.project, 'refs/heads/main'));
  assert.equal(s.gh.state().prState, 'OPEN');
});

test('a pull request that is already merged is a no-op, not a second merge', async () => {
  const s = await mergeStage('rung-3-idempotent', { prState: 'MERGED' });
  const result = await runLadder(mergeInput(s));

  assert.equal(result.delivered, 3, 'the work IS merged; reporting less would be false');
  assert.equal(result.merge?.status, 'already-merged');
  assert.equal(s.gh.merges().length, 0, 'nothing is merged twice');
  assert.ok(codes(result.notes).includes('merge-noop'));
});

test('a closed pull request is a decision, and is not merged over', async () => {
  const s = await mergeStage('rung-3-closed', { prState: 'CLOSED' });
  const result = await runLadder(mergeInput(s));
  assert.equal(result.delivered, 2);
  assert.equal(result.merge?.status, 'blocked');
  assert.match(result.merge?.detail ?? '', /closed/);
  assert.equal(s.gh.merges().length, 0);
});

test('a merge that half-succeeds is reported as uncertain, and is never retried', async () => {
  const s = await mergeStage('rung-3-partial', { mode: 'partial' });
  const result = await runLadder(mergeInput(s));

  // The merge landed — the command failed afterwards. Reporting rung 2 here would be a lie in
  // the comfortable direction, so the rung is 3 and the note is an error.
  assert.equal(result.delivered, 3);
  assert.equal(result.merge?.status, 'uncertain');
  assert.equal(refSha(s.origin!, 'refs/heads/main'), s.sha);
  assert.equal(s.gh.merges().length, 1, 'a merge with an unknown outcome is never re-sent');

  const note = result.notes.find((n) => n.code === 'merge-uncertain');
  assert.ok(note !== undefined);
  assert.equal(note.level, 'error', 'this one needs a human');
  assert.match(note.message, /Nothing is retried/);
});

test('a branch that moved after the verdict does not merge', async () => {
  // A commit pushed to the branch between the Inspector reading it and the merge. The head the
  // host reports is no longer the head that was passed.
  const s = await mergeStage('rung-3-moved-head', {
    headRefOid: '0123456789012345678901234567890123456789',
  });
  const result = await runLadder(mergeInput(s));

  assert.equal(result.delivered, 2);
  assert.equal(result.merge?.status, 'refused');
  assert.match(result.merge?.detail ?? '', /nothing inspected/);
  assert.equal(s.gh.merges().length, 0);
  assert.equal(refSha(s.origin!, 'refs/heads/main'), refSha(s.project, 'refs/heads/main'));
});

test('a pull request whose state cannot be read is not merged on a guess', async () => {
  const s = await mergeStage('rung-3-view-fails', { mode: 'view-fails' });
  const result = await runLadder(mergeInput(s));
  assert.equal(result.delivered, 2);
  assert.equal(result.merge?.status, 'blocked');
  assert.match(result.merge?.detail ?? '', /could not be read/);
  assert.equal(s.gh.merges().length, 0);
});

test('rung 3 without a pull request stops at the rung it actually reached', async () => {
  const s = await mergeStage('rung-3-no-gh');
  const result = await runLadder(mergeInput(s, { ghProbe: async () => GH_MISSING }));
  assert.equal(result.delivered, 1, 'the push happened; the pull request did not');
  assert.equal(result.merge?.status, 'refused');
  assert.match(result.merge?.detail ?? '', /no pull request to merge/);
  assert.equal(s.gh.merges().length, 0);
});

// ---------------------------------------------------------------------------------------------
// the merge authority — the only door `gh pr merge` has
// ---------------------------------------------------------------------------------------------

const HEAD_SHA = 'a'.repeat(40);
const AUTHORITY = grantMergeAuthority({
  ceiling: 3,
  verdict: 'pass',
  prRef: PR_URL,
  headCommit: HEAD_SHA,
})!;

test('an authority is minted only from ceiling 3 and a PASS, and never otherwise', () => {
  assert.ok(AUTHORITY !== null);
  assert.equal(AUTHORITY.prRef, PR_URL);

  const refused: Array<[string, Parameters<typeof grantMergeAuthority>[0]]> = [
    ['ceiling 2', { ceiling: 2, verdict: 'pass', prRef: PR_URL, headCommit: HEAD_SHA }],
    ['ceiling 0', { ceiling: 0, verdict: 'pass', prRef: PR_URL, headCommit: HEAD_SHA }],
    ['ceiling 4', { ceiling: 4, verdict: 'pass', prRef: PR_URL, headCommit: HEAD_SHA }],
    ['a FAIL', { ceiling: 3, verdict: 'fail', prRef: PR_URL, headCommit: HEAD_SHA }],
    ['no verdict', { ceiling: 3, verdict: '', prRef: PR_URL, headCommit: HEAD_SHA }],
    ['no pull request', { ceiling: 3, verdict: 'pass', prRef: '  ', headCommit: HEAD_SHA }],
    ['an abbreviated sha', { ceiling: 3, verdict: 'pass', prRef: PR_URL, headCommit: 'a1b2c3d' }],
    ['no commit at all', { ceiling: 3, verdict: 'pass', prRef: PR_URL, headCommit: '' }],
  ];
  for (const [label, input] of refused) {
    assert.equal(grantMergeAuthority(input), null, label);
  }
});

test('`gh pr merge` is refused without an authority, by every spelling, as before', () => {
  const argv = prMergeArgs(PR_URL, HEAD_SHA);
  assert.throws(() => assertGhAllowed(argv), DeniedCommandError, 'the exact argv the ladder sends');
  assert.throws(() => assertGhAllowed(argv, undefined), DeniedCommandError);
  // The refusal must name the reason, because this is the message a worker's operator reads.
  try {
    assertGhAllowed(argv);
    assert.fail('unreachable');
  } catch (error) {
    assert.ok(error instanceof DeniedCommandError);
    assert.match(error.message, /MergeAuthority/);
  }
});

test('an authority merges one pull request at one commit, and nothing else', () => {
  assert.doesNotThrow(() => assertGhAllowed(prMergeArgs(PR_URL, HEAD_SHA), AUTHORITY));
  assert.doesNotThrow(() => assertGhAllowed(prMergeArgs(PR_URL, HEAD_SHA, 'merge'), AUTHORITY));
  assert.doesNotThrow(() => assertGhAllowed(prMergeArgs(PR_URL, HEAD_SHA, 'rebase'), AUTHORITY));

  const denied: Array<[string, string[]]> = [
    ['another pull request', prMergeArgs('https://github.invalid/army/hill/pull/8', HEAD_SHA)],
    ['another commit', prMergeArgs(PR_URL, 'b'.repeat(40))],
    ['no pin at all', ['pr', 'merge', PR_URL, '--squash']],
    ['a pin with no value', ['pr', 'merge', PR_URL, '--squash', '--match-head-commit']],
    ['no method', ['pr', 'merge', PR_URL, '--match-head-commit', HEAD_SHA]],
    ['two methods', ['pr', 'merge', PR_URL, '--squash', '--merge', '--match-head-commit', HEAD_SHA]],
    ['a second pull request as an operand', ['pr', 'merge', PR_URL, '8', '--squash', '--match-head-commit', HEAD_SHA]],
    // The three flags that would each undo the point of the rung.
    ['--admin', ['pr', 'merge', PR_URL, '--squash', '--admin', '--match-head-commit', HEAD_SHA]],
    ['--auto', ['pr', 'merge', PR_URL, '--squash', '--auto', '--match-head-commit', HEAD_SHA]],
    ['--delete-branch', ['pr', 'merge', PR_URL, '--squash', '--delete-branch', '--match-head-commit', HEAD_SHA]],
    ['-d, which is --delete-branch bundled', ['pr', 'merge', PR_URL, '--squash', '-d', '--match-head-commit', HEAD_SHA]],
  ];
  for (const [label, argv] of denied) {
    assert.throws(() => assertGhAllowed(argv, AUTHORITY), DeniedCommandError, label);
  }

  // An authority whose own fields are wrong is refused at the guard as well as at the mint —
  // the two checks are independent, so both would have to fail for a merge to escape.
  const forged: MergeAuthority[] = [
    { ceiling: 2, verdict: 'pass', prRef: PR_URL, headCommit: HEAD_SHA },
    { ceiling: 3, verdict: 'fail', prRef: PR_URL, headCommit: HEAD_SHA },
  ];
  for (const authority of forged) {
    assert.throws(() => assertGhAllowed(prMergeArgs(PR_URL, HEAD_SHA), authority), DeniedCommandError);
  }
});

test('an authority unlocks the merge and NOTHING else — not gh api, not a force-push', async () => {
  // Everything the gh allow-list refused before is still refused while holding one.
  for (const argv of [
    ['api', '-X', 'PUT', 'repos/org/repo/pulls/412/merge'],
    ['api', 'repos/org/repo/pulls/412/merge'],
    ['pr', 'review', '1', '--approve'],
    ['repo', 'delete', 'org/repo'],
    ['pr', '--repo', 'org/repo', 'merge', '412'],
  ]) {
    assert.throws(() => assertGhAllowed(argv, AUTHORITY), DeniedCommandError, argv.join(' '));
  }

  // And git's allow-list is a different guard entirely: the two bypasses that once landed a real
  // force-push are refused with a merge authority in hand, because it is not an input to it.
  const bypasses: string[][] = [
    ['push', '/tmp/origin.git', '--', '+refs/heads/main:refs/heads/main'],
    ['push', 'ext::sh -c touch% /tmp/pwned', 'refs/heads/main'],
  ];
  for (const argv of bypasses) {
    assert.throws(() => assertGitAllowed(argv), DeniedCommandError, argv.join(' '));
    await assert.rejects(() => runGit(argv), DeniedCommandError);
  }
  // The ordinary durability push is still allowed — the guard would be worthless if it were not.
  assert.doesNotThrow(() =>
    assertGitAllowed(['push', '/tmp/mirror.git', `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]),
  );
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
