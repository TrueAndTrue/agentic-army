/**
 * Permissions. Where the delivery ceiling stops being a number in a file and becomes
 * a boundary.
 *
 * ```
 * ALLOW  ENGINEER   Read Grep Glob, Edit Write, Bash(git*|test|build|lint)
 *                   + spec-derived authority: the approved `verify` commands as EXACT Bash rules,
 *                   and a run rule for each runnable `filesInScope` entry as a PREFIX Bash rule
 *        INSPECTOR  Read Grep Glob, Bash(test|lint), and no editing tool at any rank
 *        OVERSEER   Read Grep Glob TodoWrite, and no editing tool and no shell at any rank
 *        VALIDATOR  Read Grep Glob, Bash(test|lint)
 *
 * NARROW (by rank, subtracted from whatever the role asked for)
 *        GENERAL COLONEL   no Edit Write NotebookEdit, no Bash at all
 *
 * DENY   (global, every role, no override)
 *        git push --force*   npm publish   gh pr merge
 *        writes outside the leased worktree
 *        ~/.ssh  ~/.aws  **&#47;.env  **&#47;credentials*
 *        PROTECTED_CONFIG_GLOBS
 * ```
 *
 * ## Why `PROTECTED_CONFIG_GLOBS` is the load-bearing entry
 *
 * The ceiling lives in `~/.agentic-army/config.toml`. `army enlist` gates a RAISE on a terminal —
 * and that gate was demonstrated bypassable four ways from a non-TTY shell, because
 * `process.stdin.isTTY` answers *"is fd 0 a character device"*, not *"is a human present"*.
 * Anything that can spawn a pty can satisfy it. So the CLI-level gate is a guardrail against
 * accident and drift, and nothing more.
 *
 * What makes it a boundary is denying every worker write access to `~/.agentic-army/**` by ANY
 * route: the command and the direct file edit are then both closed. That is why this module
 * IMPORTS the constant from `src/setup/init.ts` rather than re-declaring the paths — a second
 * copy would be a second thing to keep in step, and the one that drifts is the one that is
 * enforced.
 *
 * ## The mechanism, not the rule
 *
 * `assertGlobalDenyIntact` is called by `buildSoldierSpec` (campaign.ts) on EVERY spec before it
 * reaches a harness. Deleting an entry from `GLOBAL_DENY` therefore does not quietly widen the
 * blast radius — it throws at spawn time and the campaign refuses to start. `test/command.test.ts`
 * has watched it do exactly that.
 *
 * ## Known scope — stated because a guard that overstates itself is worse than none
 *
 * **THIS LIST IS NOT EQUALLY ENFORCEABLE ACROSS HARNESSES, and it is not a matter of degree.**
 *
 * On CLAUDE the lists reach the worker as `--allowedTools` / `--disallowedTools` under
 * `--permission-mode dontAsk`, and every rule below is enforced.
 *
 * On CODEX there is no per-tool permission model at all. `codex exec` offers a directory sandbox
 * and nothing else, so `src/harness/codex.ts` translates what it can and reports the rest as
 * unenforceable (`codexConfinement`, announced on the event stream so the archive records what was
 * enforced rather than what was intended). Measured on the real harnesses, not assumed:
 *
 * | Rule class | codex |
 * |---|---|
 * | rooted **write** deny (`~/.agentic-army/**`) | **enforced** — a sandbox can name a region |
 * | **read** deny (`~/.ssh`, `~/.aws`) | **UNENFORCEABLE** — a codex worker read a decoy key |
 * | **command** deny (`npm publish`, `gh pr merge`) | **UNENFORCEABLE** — paths, not argv |
 * | filename-anywhere globs (`**&#47;.env`) | **UNENFORCEABLE** — a name, not a region |
 *
 * So the entry this module calls load-bearing — the protected-config block — IS enforced on both
 * harnesses, which is why the delivery ceiling remains a boundary. The credential-read denies and
 * the command denies are enforced on the Engineer and are recorded intent on the Inspector; what
 * makes that liveable rather than fixed is that the adapter pins `network_access` off, so a read
 * has no channel out, and REFUSES to spawn when a rooted write-deny lands inside the writable
 * root. Do not read this list as protection codex cannot deliver.
 *
 * Measured on macOS/Seatbelt only. Linux (Landlock) and Windows must be re-measured before the
 * "enforced" column is trusted there.
 */

import type { PermissionPosture } from '../contracts/config.ts';
import type { SubagentDefinition } from '../contracts/harness.ts';
import type { Rank, Role } from '../contracts/ranks.ts';
import {
  assertMayField,
  assertRankFloorContiguous,
  formatUnit,
  maxSubagentDepth,
  RANK_ABBREV,
  RANK_ORDER,
  ROLE_WRITES_FILES,
  SPAWNS_UNITS,
  subagentRanksUnder,
  WRITES_FILES,
  writesFiles,
} from '../contracts/ranks.ts';
import { DENIED_COMMAND_SPELLINGS } from '../contracts/spec.ts';
import { isInsideOrEqual, worktreesRootFor } from '../config/paths.ts';
import { invokedAs } from '../setup/checks.ts';
import { PROTECTED_CONFIG_GLOBS, protectedConfigGlobs } from '../setup/init.ts';

/**
 * Re-exported so this module stays the one place a reader looks for what is denied. The list
 * itself lives in `src/contracts/spec.ts` — the spec validator refuses `verify` commands that
 * collide with it, and contracts is the leaf layer, so the copy had to live where both readers
 * can reach it without a wrong-way import. There is still exactly one copy.
 */
export { DENIED_COMMAND_SPELLINGS } from '../contracts/spec.ts';

// ---------------------------------------------------------------------------------------------
// Role allow-lists
// ---------------------------------------------------------------------------------------------

/**
 * Bash prefixes an ENGINEER may run — the loadout's `Bash(git*|test|build|lint)`, spelled out.
 *
 * An allow-list, per standing order: the input here is a model's idea of a command line,
 * which is exactly the adversarial case where enumerating the forbidden loses. `git` is broad on
 * purpose (the Engineer must branch, add, commit, diff) and is narrowed a second time, inside
 * this process, by `assertGitAllowed` in `src/delivery/git.ts` — which refuses every force-push
 * spelling including `ext::` transports and bare `+refspec` operands.
 */
export const ENGINEER_BASH_PREFIXES: readonly string[] = Object.freeze([
  'git',
  'npm test',
  'npm run test',
  'npm run build',
  'npm run lint',
  'npm run typecheck',
  'npx tsc',
  'tsc',
  'node --test',
  'pnpm test',
  'pnpm build',
  'pnpm lint',
  'yarn test',
  'yarn build',
  'yarn lint',
  'make test',
  'make build',
  'make lint',
  'cargo test',
  'cargo build',
  'cargo clippy',
  'go test',
  'go build',
  'go vet',
  'pytest',
  'ruff',
  'eslint',
  'prettier',
]);

/**
 * Prefixes whose documented flags rewrite the tree in place.
 *
 * `prettier --write src/`, `eslint --fix .` and `ruff check --fix .` are each ONE allowed command
 * line that edits every file it is pointed at. A `Bash(<prefix>:*)` rule constrains the START of a
 * command line and nothing after it (see `WRITE_CAPABLE_TOOLS`), so there is no narrowing of these
 * three that provably cannot take the write flag: `Bash(prettier --check:*)` still permits
 * `prettier --check x --write`. They are REMOVED from the reviewer's shell rather than narrowed,
 * because a narrowing that cannot be proved is a boundary that only looks like one.
 *
 * The ENGINEER keeps all three: it already holds `Edit`, `Write` and `NotebookEdit` over its own
 * worktree, so a formatter takes nothing it did not already have.
 */
export const IN_PLACE_WRITE_RUNNERS: readonly string[] = Object.freeze([
  'prettier',
  'eslint',
  'ruff',
]);

/**
 * The Engineer's shell with git and every in-place writer taken out: run the suite, nothing that
 * touches a branch, nothing that rewrites a file.
 *
 * Carried by the two roles whose whole job is running what somebody else wrote: the INSPECTOR
 * against one workstream's diff, the VALIDATOR against the merged branch. It is derived from
 * `ENGINEER_BASH_PREFIXES` rather than typed out so a runner added for the Engineer is a runner
 * the reviewer can also invoke; a reviewer that cannot run the suite the Engineer ran is reviewing
 * a different repository.
 *
 * `IN_PLACE_WRITE_RUNNERS` is subtracted because of precondition 2 on `INSPECTOR_TEST_WRITE_RULES`:
 * a path scope on the editing tools means nothing while a single granted command line reaches every
 * file in the tree. THE SUBTRACTION ONLY BITES UNDER `guarded`. Under `unguarded` the loadout
 * collapses to a bare `Bash`, which runs `sed -i` too, and there the containment is the supervisor's
 * post-hoc reading rather than any rule — see `assertInspectorWriteContained`.
 */
export const VERIFY_BASH_PREFIXES: readonly string[] = Object.freeze(
  ENGINEER_BASH_PREFIXES.filter(
    (prefix) => !prefix.startsWith('git') && !IN_PLACE_WRITE_RUNNERS.includes(prefix),
  ),
);

function bashRules(prefixes: readonly string[]): string[] {
  return prefixes.map((prefix) => `Bash(${prefix}:*)`);
}

/** Every tool that can put bytes on disk. A path rule must cover all of them or it covers none. */
const WRITE_TOOLS: readonly string[] = Object.freeze(['Write', 'Edit', 'NotebookEdit']);

/** `(['Edit'], ['test/**'])` -> `['Edit(test/**)']`. Used by both halves of a permission set. */
function pathRules(tools: readonly string[], globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const glob of globs) for (const tool of tools) out.push(`${tool}(${glob})`);
  return out;
}

/**
 * Where a test lives, in the spellings the repositories this thing is pointed at actually use.
 *
 * NOT IN `ROLE_ALLOW`, AND THAT IS DELIBERATE NOW RATHER THAN A WITHDRAWAL. The write is a
 * SUPERVISOR DECISION TAKEN PER SPAWN, not a property of the role, because precondition 4 —
 * a `VALIDATOR` re-runs what the inspector wrote, in a process it does not own — is true of some
 * campaigns and false of others. A role table cannot say "iff a validator follows"; a call site
 * can. See `INSPECTOR_TEST_WRITE_RULES` and `assertInspectorWriteContained` below.
 *
 * A LIST OF CONVENTIONS, NOT A DISCOVERY. Nothing here inspects the repo. These are the directory
 * and filename shapes that `test/`-style, `pytest`-style and `go test`-style projects put their
 * tests in, and a project that names its tests something else gives its INSPECTOR a write that
 * reaches nothing. That failure is the safe direction (the inspector reports the missing test
 * instead of writing it) and it is the reason this list is worth widening when a repo needs it,
 * carefully, rather than replacing with something like `**` scoped by briefing.
 *
 * The globs are worktree-relative because the worker's cwd IS its leased worktree, which is also
 * how `ENGINEER_BASH_PREFIXES` and the spec's `filesInScope` rules are already spelled.
 */
export const TEST_PATH_GLOBS: readonly string[] = Object.freeze([
  'test/**',
  'tests/**',
  'spec/**',
  '__tests__/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/test_*.py',
]);

/**
 * The INSPECTOR's write, scoped to the paths above. GRANTED PER SPAWN, never by the role table.
 *
 * An inspector that can write can write the thing that makes its own verdict pass. The first
 * attempt at containing that hazard was measured and found inert on the configuration this project
 * actually ships, and four things had to hold before the grant went back on. Each is now built, and
 * each is stated below with what it costs and where it stops:
 *
 * 1. THE CONTAINMENT IS A DENY, NOT A SCOPED ALLOW. Two independent reasons, either one fatal.
 *    The INSPECTOR runs on codex by default (`DEFAULT_DISPATCH`, `src/config/load.ts`), and
 *    `src/harness/codex.ts` says plainly that codex has no equivalent of the permission model:
 *    `codexConfinement` reads `spec.deny` to build sandbox roots and never reads `spec.allow` at
 *    all, so a scoped allow-list on this role is not weakened on codex, it is ABSENT. And
 *    `DEFAULT_PERMISSION_POSTURE` is `unguarded`, which maps every scoped rule in this file to its
 *    bare tool name — though only on the ALLOW half: `permissionsFor` leaves the deny half
 *    byte-identical under both postures, which is precisely why the bound has to live there.
 *
 *    So `inspectorWriteDeny` builds the containment as DENY rules over the implementation under
 *    review, and it is emitted at both postures on both harnesses. What it is worth differs, and
 *    the difference is measured rather than assumed — see `assertInspectorWriteContained`:
 *
 *    | harness / posture | what the deny does |
 *    |---|---|
 *    | claude, guarded   | **enforced.** deny beats allow, so the editor reaches test paths only |
 *    | claude, unguarded | **enforced.** the deny half does not collapse; only the allow half does |
 *    | codex, either     | **UNENFORCEABLE, and reported as such.** the rules are worktree-relative, so `resolveDenyRoot` returns null and `codexConfinement` classifies them `unenforceable` rather than `enforced`. Deliberately relative: an ABSOLUTE deny inside the writable root is a `breach`, and codex REFUSES TO SPAWN on one |
 *
 *    On codex the whole worktree is writable and always was, editor or no editor, so the grant adds
 *    no capability there. What contains it on codex is (3) and (4) below plus the supervisor's own
 *    post-hoc reading of what the inspector actually wrote, which is harness-independent and is the
 *    only half of this that holds on the configuration this project ships.
 * 2. THE SHELL IT ALREADY HOLDS CANNOT WRITE THE TREE. `VERIFY_BASH_PREFIXES` carried
 *    `Bash(prettier:*)`, `Bash(eslint:*)` and `Bash(ruff:*)`, and all three have a documented
 *    in-place write mode. All three are gone — see `IN_PLACE_WRITE_RUNNERS` for why they are
 *    removed rather than narrowed. Under `unguarded` the reviewer holds a bare `Bash` and this buys
 *    nothing; that is stated rather than glossed, and it is the second reason the supervisor's
 *    post-hoc reading is the load-bearing half.
 * 3. THE VERDICT AND THE TEST AUTHORSHIP LAND IN THE ARCHIVE AS SEPARATE SIGNALS. `src/command/
 *    campaign.ts` writes an `authorship` note and its own `status` signal listing the files the
 *    inspector wrote, next to and distinct from the `report` signal carrying the verdict.
 * 4. TESTS IT WRITES RUN AGAIN UNDER THE `VALIDATOR`, in a process the inspector does not own —
 *    AND THEY BECOME HISTORY ONLY AFTER ONE HAS. This was a promise made at spawn time, which is a
 *    moment at which nobody can know whether a validator will run: the literal `true` that carried
 *    it could not be false, and a campaign whose reviewer refused, or whose integration failed, or
 *    whose gate never passed, committed a reviewer's test onto a durable branch under a note saying
 *    a validator would run it. Now the campaign HOLDS what a reviewer writes out of history, applies
 *    it to the integration tree for the gate and the validator to execute, and commits it only once
 *    a validator has come back with a verdict on a tree containing it. `commitInspectorTests`
 *    refuses without the validator that ran them. An unsegmented campaign fields no validator, its
 *    inspector holds no editor, and nothing it might write could ever land.
 *
 * See the Permissions section of `docs/main-flow.md`, which is where this list is.
 *
 * Every write tool is covered, not just the two that matter, because a path rule that names two of
 * the three write tools is a path rule with a hole in it.
 */
export const INSPECTOR_TEST_WRITE_RULES: readonly string[] = Object.freeze(
  pathRules(WRITE_TOOLS, TEST_PATH_GLOBS),
);

/**
 * `test/**` -> a matcher. `**` crosses separators, `*` does not, everything else is literal.
 *
 * Written here rather than pulled in because `TEST_PATH_GLOBS` is the only glob vocabulary this
 * module has to interpret, and a dependency on a general-purpose matcher would bring a second
 * definition of what `**` means into a file whose whole job is being unambiguous about scope.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // `**/` is ZERO OR MORE directories, so `**&#47;*.test.*` matches `a.test.js` at the root.
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

const TEST_PATH_MATCHERS: readonly RegExp[] = Object.freeze(TEST_PATH_GLOBS.map(globToRegExp));

/**
 * Is this repository-relative path one `TEST_PATH_GLOBS` reaches?
 *
 * THE SAME LIST THE ALLOW RULES ARE BUILT FROM, read a second way. Two spellings of "where a test
 * lives" is the drift that would let an inspector's allow-list and the supervisor's after-the-fact
 * check disagree about one file, and the file they disagree about is the one that matters.
 *
 * A leading `./` is stripped, because a worker names a path either way and git names it neither.
 * A path that escapes the tree (`../`, absolute) is NOT a test path by any reading, and answering
 * `false` is the safe direction: the caller's `false` branch is "this write is out of scope".
 */
export function isTestPath(file: string): boolean {
  const cleaned = file.replace(/^\.\//, '').trim();
  if (cleaned === '' || cleaned.startsWith('/') || cleaned.startsWith('../')) return false;
  return TEST_PATH_MATCHERS.some((matcher) => matcher.test(cleaned));
}

/**
 * The containment, as DENY rules over the implementation this inspector is reviewing.
 *
 * ## Why these paths and not a region
 *
 * The rule grammar has no negation, so "everywhere except the test paths" is not a thing either
 * harness can be told. What CAN be named exactly is the set the hazard is about: an inspector makes
 * its own verdict pass by editing the code under review, and the code under review is the branch's
 * own changed files plus whatever the spec put in scope. Both lists are SUPERVISOR-OWNED — one
 * comes out of `git diff --name-only`, the other out of a spec a human approved before the Engineer
 * existed — so neither is a list a reviewee can grow.
 *
 * Test paths are filtered OUT of the deny, because a reviewer strengthening an existing test file
 * is the thing this grant exists for. Everything else the branch touched is denied.
 *
 * ## Why every entry stays worktree-relative
 *
 * `codexConfinement` resolves an ABSOLUTE write-deny that lands inside the writable root to a
 * `breach`, and a breach REFUSES THE SPAWN. A relative pattern resolves to no region at all and is
 * reported `unenforceable`, which is the honest classification and does not cost a reviewer. So a
 * caller must pass repository-relative paths, and an absolute one is dropped rather than emitted:
 * a containment rule that stops the reviewer being spawned protects nothing.
 */
export function inspectorWriteDeny(paths: readonly string[]): string[] {
  const globs: string[] = [];
  for (const raw of paths) {
    const file = raw.replace(/^\.\//, '').trim();
    if (file === '' || file.startsWith('/') || file.includes('..')) continue;
    if (isTestPath(file)) continue;
    if (!globs.includes(file)) globs.push(file);
  }
  return pathRules(WRITE_TOOLS, globs);
}

/**
 * Refuse an inspector's editor unless the preconditions a SPEC can carry actually hold for it.
 *
 * A MECHANISM, NOT A CHECKLIST SOMEBODY REMEMBERS. The four preconditions were written down once,
 * measured, and found inert; the way that does not happen twice is that the grant cannot be issued
 * without this function agreeing, and this function reads the spec that is about to go on the wire
 * rather than the intention behind it.
 *
 * ## What it does NOT check, and where each of those went instead
 *
 * Precondition 3 is an archive write that happens after the run, so nothing here can see it. It is
 * covered by `src/command/campaign.ts` emitting the authorship signal on the same path that emits
 * the verdict, and by the test that removes it.
 *
 * Precondition 4 — a `CPT·VALIDATOR` re-runs what the reviewer wrote — used to be checked here, as
 * a `validatorFollows: boolean` its one caller passed as the literal `true`. THAT IS THE SHAPE THIS
 * WHOLE FILE EXISTS TO AVOID: authority derived from a condition asserted at a call site. Nothing
 * computed it, so the refusal could not fire; and the assertion was regularly false, because a
 * validator is skipped whenever any workstream ends other than delivered, integration fails, the
 * gate never passes inside the validation budget, or an abort lands in between. A spawn is simply
 * not a moment at which "a validator will run" is knowable.
 *
 * So it moved to the moment it IS knowable. A reviewer's tests are no longer committed where they
 * were written; the campaign holds them out of history and `commitInspectorTests` refuses to write
 * them onto a branch without naming the validator that ran them. The check is the same check, at
 * the only point where it can be true or false rather than merely asserted, and the durable
 * artefact now follows the fact instead of preceding it.
 */
export function assertInspectorWriteContained(input: {
  allow: readonly string[];
  /** The rules `inspectorWriteDeny` produced — NOT the whole deny-list, which is rooted by design. */
  containment: readonly string[];
  who: string;
}): void {
  const { allow, containment, who } = input;
  const writeScopes = allow.filter((rule) => WRITE_TOOLS.includes(toolNameOf(rule)));
  const unscoped = writeScopes.filter((rule) => !rule.includes('('));
  if (unscoped.length > 0) {
    throw new Error(
      `refusing to grant ${who} an editor: ${unscoped.join(', ')} carries no path scope. A bare ` +
        'write tool on a reviewer is the whole hazard, not a loose end of it.',
    );
  }
  const shell = allow.filter((rule) => toolNameOf(rule) === 'Bash');
  const writers = shell.filter((rule) =>
    IN_PLACE_WRITE_RUNNERS.some((runner) => rule.startsWith(`Bash(${runner}`)),
  );
  if (writers.length > 0) {
    throw new Error(
      `refusing to grant ${who} an editor: its shell still holds ${writers.join(', ')}, and each ` +
        'of those has a documented in-place write mode. Precondition 2: a path scope on the ' +
        'editing tools means nothing while a single granted command line reaches every file in ' +
        'the tree.',
    );
  }
  // Precondition 1, read off the wire rather than off the intention. A deny that names an ABSOLUTE
  // region would be a codex `breach` and the reviewer would not spawn at all, so the containment
  // has to be relative — and that is checked here rather than trusted to the builder.
  for (const rule of containment) {
    const open = rule.indexOf('(');
    if (open === -1 || !WRITE_TOOLS.includes(toolNameOf(rule))) continue;
    const pattern = rule.slice(open + 1, rule.length - 1);
    if (pattern.startsWith('/')) {
      throw new Error(
        `refusing to grant ${who} an editor: the containment rule ${rule} names an absolute path. ` +
          'codexConfinement classifies an absolute write-deny inside the writable root as a breach ' +
          'and refuses to spawn, so a containment written that way would stop the review instead ' +
          'of bounding it.',
      );
    }
    if (isTestPath(pattern)) {
      throw new Error(
        `refusing to grant ${who} an editor: the containment rule ${rule} denies a TEST path, and ` +
          'deny beats allow. The grant would be issued and immediately cancelled, which is a ' +
          'reviewer told it may write tests and refused every time it tries.',
      );
    }
  }
}

/**
 * A verify command, sorted into what this harness's rule grammar can and cannot carry as an
 * exact-match Bash allow rule.
 *
 * ## Field-confirmed, not hypothetical
 *
 * `verifyAllowRules` used to carry a "known limitation, stated rather than solved" comment about
 * `)` inside a `Bash(<specifier>)` rule. A live campaign settled the question: EVERY verify
 * command containing `)` was denied by claude's permission engine, every one without `)` was
 * allowed — fifteen denial notes on one Engineer before it finished despite them, because the
 * acceptance gate runs the commands outside the permission layer regardless. The rule grammar
 * cannot carry a closing paren inside the specifier. It is broken on arrival, not sometimes
 * broken, so granting a rule for one is granting a denial.
 *
 * `)` anywhere in the trimmed command is ungrantable — not just inside `$(...)`, because the
 * grammar has no notion of "this paren is fine" and neither does this classifier. Empty and
 * whitespace-only entries are dropped from both lists, matching what `verifyAllowRules` already
 * did before splitting.
 *
 * Exported so `verifyAllowRules` and `renderEngineerOrders` share ONE classifier: two copies of
 * the `)` test is two places for the mitigation to drift out of step with the grammar it works
 * around.
 */
export function splitVerifyCommands(commands: readonly string[]): {
  grantable: string[];
  ungrantable: string[];
} {
  const grantable: string[] = [];
  const ungrantable: string[] = [];
  for (const command of commands) {
    const trimmed = command.trim();
    if (trimmed === '') continue;
    (trimmed.includes(')') ? ungrantable : grantable).push(trimmed);
  }
  return { grantable, ungrantable };
}

/**
 * The spec's own `verify` commands as EXACT-match Bash allow rules, for the ENGINEER that has to
 * run them.
 *
 * ## Why this exists — a field failure, not a convenience
 *
 * A spec named `node --check webvitals.js` as proof of done. The Engineer's orders told it to run
 * that command before reporting done; `ENGINEER_BASH_PREFIXES` allows `git`, test, build and lint
 * runners — not bare `node`, not `sh` — so the command was denied, retried, denied again, and the
 * attempt timed out having delivered nothing. The gate then ran the same command itself. A worker
 * ordered to run a command and structurally refused it is not a permission boundary working; it
 * is two halves of one campaign contradicting each other.
 *
 * ## Why this does not widen the boundary
 *
 * These strings come from the spec, and the human at the terminal approves the spec — verify
 * commands shown verbatim — before anything spawns (or authored them outright in `--spec` mode).
 * That approval is the authorization for THESE EXACT STRINGS, which is why the rules are exact
 * matches: bare `Bash(<command>)` in claude's rule grammar is an exact match, and `:*` — the
 * prefix form every role loadout uses — is deliberately NOT emitted, so `node --check x.js` does
 * not become a licence for `node --check x.js; rm -rf .`. The global deny-list is emitted
 * unchanged and deny wins over allow in claude's engine, so a hostile verify command that collides
 * with a denied prefix stays dead — and `validateTechnicalSpec` refuses it earlier, with a reason.
 *
 * ## Only the grantable half
 *
 * `splitVerifyCommands` sorts out the commands whose rule can never fire — see that function for
 * the field evidence. Emitting a rule for one anyway would not widen anything (the command still
 * carries whatever the human approved, and deny still wins over allow), but it would be a promise
 * this permission set cannot keep: a rule on the wire that is denied every single time it matches
 * is worse than no rule, because it tells the Engineer's orders (`renderEngineerOrders`) it may
 * claim an authority it does not have.
 */
export function verifyAllowRules(commands: readonly string[]): string[] {
  return splitVerifyCommands(commands).grantable.map((command) => `Bash(${command})`);
}

/**
 * The interpreter a `Bash(<interpreter> <file>:*)` rule needs, keyed by the file's extension.
 * Anything else — `.ts`, `.md`, `.json`, `.css`, extensionless — is not this codebase's to run: a
 * rule for a file nothing can execute is noise, and `.ts` in particular is edited and type-checked,
 * never run directly by a bare interpreter.
 */
const FILE_RUN_INTERPRETERS: Readonly<Record<string, string>> = Object.freeze({
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.py': 'python3',
  '.sh': 'sh',
});

/**
 * The spec's `filesInScope`, as PREFIX Bash allow rules — one per file the Engineer can actually
 * run, arguments unrestricted.
 *
 * ## Why this exists — the same shape of field failure `verifyAllowRules` closes
 *
 * A spec ordered a Captain-Engineer to write `slugify.js`, then debug it by running
 * `node slugify.js "Hello, World!"`. `ENGINEER_BASH_PREFIXES` allows `node --test` and nothing
 * else bare-`node`-shaped, so every ad-hoc run of the file it had just written — with its own
 * arguments, exploring its own bug — was denied. The Engineer already holds `Write` on the
 * worktree; denying it a run of a file the spec itself named restricts debugging without
 * restricting anything an adversary could not already do through the tools it holds. Authority
 * derives from what the human approved, and the spec names these files before dispatch — so their
 * runnable half carries authority the same way `verify` does.
 *
 * ## PREFIX, not exact — the one place this deliberately differs from `verifyAllowRules`
 *
 * `verify` commands are a fixed, human-approved command line, so `verifyAllowRules` grants an
 * EXACT match and nothing wider. A file being debugged is run with DIFFERENT arguments on every
 * attempt — that is the whole point of ad-hoc execution — so an exact rule would have to be
 * re-derived per invocation and would grant nothing on the second run. `Bash(node slugify.js:*)`
 * fixes the interpreter and the file and leaves the argument tail open, which is the same shape
 * `ENGINEER_BASH_PREFIXES` already uses for every other prefix rule on this loadout.
 *
 * ## What is deliberately NOT granted
 *
 * No bare `node`, no `node -e`, no `sh -c` prefix, and no rule at all for a file the spec did not
 * name — each of those is authority over more than the spec approved. An entry with no runnable
 * extension (`.ts`, `.md`, `.json`, `.css`, extensionless) emits nothing: those files are edited,
 * not executed, by this codebase's own toolchain, and a rule nothing can run is noise on the wire.
 *
 * An entry containing `)` emits nothing — the same rule-grammar limit `splitVerifyCommands`
 * documents field evidence for; a granted-but-ungrantable rule is worse than no rule because it
 * tells the Engineer it holds an authority it does not.
 *
 * Entries are the spec's own spelling, worktree-relative, verbatim — no `./`-stripping, no
 * separator normalisation. The Engineer's orders name the file the same way the spec did, and a
 * rule spelled differently from the orders would not match the command the Engineer actually runs.
 */
export function fileRunRules(filesInScope: readonly string[]): string[] {
  const rules: string[] = [];
  for (const entry of filesInScope) {
    const trimmed = entry.trim();
    if (trimmed === '' || trimmed.includes(')')) continue;
    const dot = trimmed.lastIndexOf('.');
    const ext = dot === -1 ? '' : trimmed.slice(dot);
    const interpreter = FILE_RUN_INTERPRETERS[ext];
    if (interpreter === undefined) continue;
    rules.push(`Bash(${interpreter} ${trimmed}:*)`);
  }
  return rules;
}

/**
 * The per-role loadout table, as tool rules.
 *
 * SENTRY is present only so this map is total over `Role`: nothing in this build spawns one, and
 * it is deferred from the v1 slice rather than designed away.
 *
 * SCOUT's entry is now live. Phase 1 fields a `CPT·SCOUT` from `army chat`, on exactly the five
 * rules below and NOT ONE MORE — the fan-out roster it is issued at spawn holds the same names,
 * narrowed by rank, because `subagentRosterFor` computes a subordinate's loadout from this table
 * rather than from a second list. It holds no `Task` and no `Agent` here, and that is deliberate:
 * the measurement recorded on `SubagentDefinition` below found the allow half does not gate the
 * spawn tool at all, so the enforcing form is the roster plus `subagentDeny` plus the harness's
 * nesting cap — and adding a spawn rule to this table would widen the role for a mechanism that
 * does not read it.
 */
export const ROLE_ALLOW: Record<Role, readonly string[]> = Object.freeze({
  SCOUT: Object.freeze(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
  // ==========================================================================================
  // AN OVERSEER DECIDES. IT RUNS NOTHING.
  //
  // Read, Grep and Glob are what "it can look at the code directly" means, and they are the whole
  // of its reading: the archive it reasons about arrives in its briefing, because every worker is
  // denied Read on `~/.agentic-army/**` and that deny is what makes the delivery ceiling a
  // boundary rather than a speed bump.
  //
  // NO Edit, NO Write, NO NotebookEdit, at any rank, and the deny half names them too
  // (`ROLE_DENY.OVERSEER`). A feature owner that can edit will edit, being the unit with the most
  // context and the most impatience, and the moment it does, nothing above an engineer is
  // reviewing an engineer's work, which is the entire reason the layer exists.
  //
  // NO SHELL EITHER, AND THAT IS THE PART WORTH EXPLAINING, because a feature owner has to get
  // the work integrated and integrating sounds like git. It does not run the merge. It DECIDES
  // which workstream merges
  // and when, and the supervising process performs the merge, exactly as the supervisor already
  // performs the rung 3 merge that no worker may perform at any rank. A conflict git resolves by
  // itself needs nobody; a conflict needing content-level judgement becomes a reconciliation
  // workstream, where a fresh engineer resolves it in its own worktree and an inspector reviews
  // the resolution like any other work. An overseer that could resolve a conflict by hand is an
  // overseer whose work nothing reviews, and giving it `Bash(git merge:*)` to avoid one extra
  // spawn would buy that at the price of the only property this layer has.
  //
  // Withholding the shell also means the role no longer needs its rank to be a writing rank:
  // `WRITE_CAPABLE_TOOLS` counts `Bash`, so a role holding scoped shell rules at a non-writing
  // rank loses them silently, and that pressure is what made `WRITES_FILES.MAJOR` true for a
  // while. With nothing to subtract, `narrowToRank` takes nothing from a `MAJ·OVERSEER`.
  //
  // `TodoWrite` is the segmentation it is asked to make visible, and it is also what keeps the
  // allow-list non-empty at every rank, including the officer ranks that narrow hardest.
  // ==========================================================================================
  OVERSEER: Object.freeze(['Read', 'Grep', 'Glob', 'TodoWrite']),
  // `Task` and `Agent` are the fan-out. BOTH spellings, and that is not belt-and-braces: measured
  // on claude 2.1.221, `Task` is what the tool roster on `system/init` calls it and `Agent` is what
  // the model actually emitted when asked to spawn one. Naming one of the two would have produced
  // a rank that could spawn on paper and not in the field, or the reverse — a floor rank denied
  // the name nobody uses. A rank that may not spawn loses both in `narrowToRank` and is denied both
  // by `rankDeny`, so the pair travels together in every direction.
  ENGINEER: Object.freeze([
    'Read',
    'Grep',
    'Glob',
    'Edit',
    'Write',
    'NotebookEdit',
    'TodoWrite',
    'Task',
    'Agent',
    ...bashRules(ENGINEER_BASH_PREFIXES),
  ]),
  // An Inspector reads and runs. It holds NO editing tool, which is what the review gate's
  // independence rests on: a reviewer that can write can write the thing that makes its own
  // verdict pass. The scoped test write the design wants is spelled out in
  // `INSPECTOR_TEST_WRITE_RULES` and deliberately not referenced here. That comment lists the
  // four things that have to hold first, and the reason the first attempt was withdrawn. It also
  // holds no git: the branch under review is not the reviewer's to move.
  INSPECTOR: Object.freeze([
    'Read',
    'Grep',
    'Glob',
    'TodoWrite',
    ...bashRules(VERIFY_BASH_PREFIXES),
  ]),
  // A Validator runs the merged branch against the spec's verification commands and judges the
  // result against the ORIGINAL ask. It writes nothing at all: it is the last unit to look at the
  // work, and the last look has to be at what everybody else produced rather than at anything it
  // touched. Its shell is the reviewer's, not the Engineer's: no git, because a validator that
  // could commit could make the branch it is judging into the branch it wanted.
  VALIDATOR: Object.freeze([
    'Read',
    'Grep',
    'Glob',
    'TodoWrite',
    ...bashRules(VERIFY_BASH_PREFIXES),
  ]),
  SENTRY: Object.freeze(['Bash(gh pr view:*)', 'Bash(gh run list:*)']),
  // ==========================================================================================
  // THE COMMANDER'S LOADOUT IS THE POINT OF THE COMMANDER.
  //
  // A commanding agent that can read a file will read a file, and the whole hierarchy exists
  // because that is the failure: one `Read` of a 2000-line module and the window holding the
  // strategy is gone. Telling it not to is a request. Not giving it the tool is a mechanism.
  //
  // `TodoWrite` is here and it is not decoration. `buildClaudeArgs` only emits `--allowedTools`
  // when the list is NON-EMPTY, so a literally empty allow-list omits the flag — and a claude
  // worker with no `--allowedTools` gets the DEFAULT loadout, which is everything. An empty
  // allow-list would therefore be the most permissive spec this codebase can produce. One inert
  // tool keeps the flag on the command line and every other tool off it.
  //
  // `assertCommanderLoadout` below refuses to spawn a COMMANDER whose list has grown a tool
  // that touches the filesystem, a shell, or the network, so this cannot be widened quietly.
  // ==========================================================================================
  COMMANDER: Object.freeze(['TodoWrite']),
}) as Record<Role, readonly string[]>;

// ---------------------------------------------------------------------------------------------
// The global deny-list
// ---------------------------------------------------------------------------------------------

/** Home directories and file patterns a worktree does not protect. */
export const SECRET_PATH_GLOBS: readonly string[] = Object.freeze([
  '~/.ssh',
  '~/.ssh/**',
  '~/.aws',
  '~/.aws/**',
  '~/.config/gh/**',
  '**/.env',
  '**/.env.*',
  '**/credentials',
  '**/credentials.*',
  '**/*.pem',
  '**/id_rsa*',
]);

/** Reading a credential is exfiltration; the secret globs are denied for reads as well. */
const READ_TOOLS: readonly string[] = Object.freeze(['Read', 'Grep', 'Glob']);

/**
 * The three denied commands, in every spelling a `Bash(...)` prefix rule can carry.
 *
 * DERIVED, not declared: the spellings themselves live in `src/contracts/spec.ts` (re-exported
 * above), because the spec validator refuses a `verify` command that collides with one of them and
 * `contracts` is the leaf layer — it cannot import from here. One list, two readers; the rules on
 * the wire and the refusal in the validator cannot drift apart.
 */
export const DENIED_COMMAND_RULES: readonly string[] = Object.freeze(
  DENIED_COMMAND_SPELLINGS.map((spelling) => `Bash(${spelling}:*)`),
);

/**
 * The global deny-list — every role, no override, at any rank.
 *
 * `PROTECTED_CONFIG_GLOBS` is spliced in verbatim, in the exact strings the setup unit exports,
 * so `assertGlobalDenyIntact` can check for them by identity rather than by pattern.
 *
 * A NOTE ON WHAT THIS LIST IS. The rule is blunt: *deny-lists do not work here; use
 * allow-lists.* That verdict is honoured — the ENFORCING layer is `ROLE_ALLOW` plus
 * `assertGitAllowed` / `assertGhAllowed`, both allow-lists. This list is the backstop for the
 * three commands and the credential paths named above by hand, and it is not claimed to be
 * exhaustive against an adversary with a shell. The one entry that IS a boundary is the
 * protected-config block, because it denies a filesystem region rather than a command spelling,
 * and there is no clever argv that writes to a path the tool refuses to open.
 */
export const GLOBAL_DENY: readonly string[] = Object.freeze([
  ...DENIED_COMMAND_RULES,
  ...pathRules(WRITE_TOOLS, SECRET_PATH_GLOBS),
  ...pathRules(READ_TOOLS, SECRET_PATH_GLOBS),
  // ---- the load-bearing block ----------------------------------------------------------
  ...pathRules([...WRITE_TOOLS, ...READ_TOOLS], PROTECTED_CONFIG_GLOBS),
]);

/**
 * `GLOBAL_DENY` plus the same protection expressed against a RESOLVED home.
 *
 * `PROTECTED_CONFIG_GLOBS` contains `~` and `$AGENTIC_ARMY_HOME`, which a permission engine that
 * does not do shell expansion will simply not match. `protectedConfigGlobs(home)` returns the
 * absolute forms; both go on the wire, because which one a given harness understands is not a
 * thing to guess at.
 */
export function globalDeny(home?: string): string[] {
  const resolved = home === undefined ? [] : pathRules([...WRITE_TOOLS, ...READ_TOOLS], protectedConfigGlobs(home));
  return [...GLOBAL_DENY, ...resolved];
}

// ---------------------------------------------------------------------------------------------
// The commander's context guard
// ---------------------------------------------------------------------------------------------

/**
 * Tool names a COMMANDER may never hold, whatever the allow-list says.
 *
 * The classification is "can this put bytes into the holder's context window, or bytes onto this
 * machine" — not "is this dangerous". `Read` is not dangerous. `Read` is the thing that ends a
 * commanding agent's usefulness, one file at a time, which is why it is on the same list as
 * `Bash`.
 *
 * Names, not rules: a rule is `Bash(git:*)` and a name is `Bash`, so the check below strips the
 * parenthesised argument before comparing. Matching on the whole rule string would let
 * `Bash(cat:*)` through a list that names `Bash`.
 */
export const COMMANDER_FORBIDDEN_TOOLS: readonly string[] = Object.freeze([
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
]);

/** `Bash(git:*)` -> `Bash`. A rule's tool NAME, which is what a loadout is really made of. */
export function toolNameOf(rule: string): string {
  const open = rule.indexOf('(');
  return (open === -1 ? rule : rule.slice(0, open)).trim();
}

/**
 * Extra denies that apply to one role only.
 *
 * The global deny-list is deliberately the same for everyone — it is the floor. This is the
 * ceiling for a role whose whole definition is an absence, and it exists because two mechanisms
 * that fail independently are worth more here than one: `--allowedTools` omits every tool not
 * named, and `--disallowedTools` names them anyway. If a future flag change, a harness default,
 * or a hand-edited spec ever restores the default loadout, the deny half still holds.
 *
 * The OVERSEER and the VALIDATOR are the second and third roles defined by an absence, so they get
 * the same treatment as the COMMANDER: their allow-lists name no editing tool, and the deny half
 * names the editing tools anyway. Bare names, never `Edit(<glob>)`: a deny beats an allow in
 * claude's engine, so a scoped deny would say less, and a scoped ALLOW appearing later in one of
 * those loadouts is precisely what this is here to kill.
 *
 * `Bash` is deliberately NOT denied to the VALIDATOR: it holds scoped `Bash(...)` rules for the
 * spec's verification commands, and a bare `Bash` deny beats an allow in claude's engine, so it
 * would leave the validator unable to run the only thing it exists to run. The OVERSEER holds no
 * shell rules to protect, so nothing here has to make room for any; it is denied the editing tools
 * and gets its shell-lessness from `ROLE_ALLOW` naming none, which is the stronger of the two
 * spellings when there is nothing to keep.
 */
export const ROLE_DENY: Record<Role, readonly string[]> = Object.freeze({
  SCOUT: Object.freeze([]),
  OVERSEER: Object.freeze([...WRITE_TOOLS]),
  ENGINEER: Object.freeze([]),
  INSPECTOR: Object.freeze([]),
  VALIDATOR: Object.freeze([...WRITE_TOOLS]),
  SENTRY: Object.freeze([]),
  COMMANDER: Object.freeze(COMMANDER_FORBIDDEN_TOOLS.map((tool) => tool)),
}) as Record<Role, readonly string[]>;

/**
 * Refuse to spawn a COMMANDER that can read a file, run a command, or reach the network.
 *
 * Called from `permissionsFor`, so there is no route to a permission set that skips it, and it
 * throws rather than filtering. Filtering would mean a widened `ROLE_ALLOW.COMMANDER` silently
 * became a narrow one at spawn time, and the next reader would find a list whose contents are
 * not what the process actually runs with. A refusal is visible; a quiet correction is not.
 *
 * Scope, stated because a guard that overstates itself is worse than none: this checks the rules
 * this process is about to put on the command line. It is not a claim about what the harness
 * enforces — see the harness table at the top of this file for that, and note that a COMMANDER
 * runs on claude, which is the harness where per-tool rules ARE enforced.
 */
export function assertCommanderLoadout(allow: readonly string[], who: string): void {
  const forbidden = new Set(COMMANDER_FORBIDDEN_TOOLS);
  const offending = allow.filter((rule) => forbidden.has(toolNameOf(rule)));
  if (offending.length > 0) {
    throw new Error(
      `refusing to spawn ${who}: its allow-list holds ${offending.join(', ')}. A commanding ` +
        'agent that can read files or run commands does not delegate — it does the work itself, ' +
        'fills the window that was holding the strategy, and the hierarchy underneath it stops ' +
        'paying for itself. The loadout is the guard; a sentence in the briefing is not.',
    );
  }
  assertAllowListNonEmpty(allow, who);
}

/**
 * Refuse an empty allow-list, for ANY worker.
 *
 * An empty list is not "no tools". `buildClaudeArgs` omits `--allowedTools` when there is nothing
 * to put after it, and a claude worker spawned without that flag receives the DEFAULT loadout,
 * which is every tool — so the emptiest list this codebase can produce is also the most
 * permissive spec it can produce. That trap predates rank narrowing; narrowing makes it reachable
 * by a second route, because subtracting the write-capable tools from a role whose whole loadout
 * is write-capable leaves nothing (a SENTRY holds two `Bash` rules and nothing else). Hence the
 * check moved out of the commander's guard and onto every path.
 */
export function assertAllowListNonEmpty(allow: readonly string[], who: string): void {
  if (allow.length > 0) return;
  throw new Error(
    `refusing to spawn ${who}: its allow-list is empty. An empty list is not "no tools" — the ` +
      'claude adapter omits `--allowedTools` entirely when there is nothing to put after it, ' +
      'and a worker spawned without that flag receives the default loadout, which is every ' +
      'tool. The most restrictive spelling of this list is one harmless tool, never none.',
  );
}

// ---------------------------------------------------------------------------------------------
// Rank narrows authority
// ---------------------------------------------------------------------------------------------

/**
 * Tool names a rank that does not write may never hold, whatever its role asks for.
 *
 * The first three are the obvious ones. `Bash` is here for the unobvious reason, and it is the
 * whole reason this list is not just `WRITE_TOOLS`: a `Bash(prefix:*)` rule constrains the START
 * of a command line and nothing after it, so `Bash(npm test:*)` permits `npm test; rm -rf .` and
 * `Bash(prettier:*)` permits `prettier --write`. There is no spelling of a bash prefix rule that
 * is provably read-only. A rank whose stated property is that it is structurally incapable of a
 * bad `rm` therefore holds no shell at all — the alternative is a list of prefixes someone has
 * decided look harmless, which is a deny-list wearing an allow-list's clothes.
 *
 * `BashOutput` and `KillShell` are here because they are the handles on a shell that is already
 * running; they are inert without `Bash`, and removing them costs a rank that holds no `Bash`
 * exactly nothing.
 */
export const WRITE_CAPABLE_TOOLS: readonly string[] = Object.freeze([
  ...WRITE_TOOLS,
  'Bash',
  'BashOutput',
  'KillShell',
]);

/**
 * Every tool that fields another unit. A rank that may not spawn must lose all of them or none.
 *
 * Both names, for the reason `ROLE_ALLOW.ENGINEER` gives: the roster and the model disagree about
 * what the spawn tool is called, so a list holding one of them is a list with a spelling-shaped
 * hole in it. `COMMANDER_FORBIDDEN_TOOLS` has named both since before anything could spawn, and
 * this is the same pair — kept separate because that list is a role's ceiling and this is a rank's.
 */
export const SPAWN_TOOLS: readonly string[] = Object.freeze(['Task', 'Agent']);

/**
 * The role's loadout with everything this rank may not hold subtracted.
 *
 * Rank narrows; it never widens. A rank that writes gets its role's list unchanged — which is why
 * every unit this project actually fields today (`CPT·ENGINEER`, `CPT·INSPECTOR`) is byte-for-byte
 * unaffected by this function, and why `COL·COMMANDER` is too: its one tool is `TodoWrite`, which
 * writes a checklist in a context window, not a byte on disk.
 */
export function narrowToRank(rank: Rank, allow: readonly string[]): string[] {
  const forbidden = [
    ...(WRITES_FILES[rank] ? [] : WRITE_CAPABLE_TOOLS),
    ...(SPAWNS_UNITS[rank] ? [] : SPAWN_TOOLS),
  ];
  if (forbidden.length === 0) return [...allow];
  return allow.filter((rule) => !forbidden.includes(toolNameOf(rule)));
}

/**
 * The deny half of the same narrowing — the second, independent mechanism.
 *
 * `narrowToRank` omits the tools; this names them. The two fail for different reasons: an
 * omission is undone by a widened `ROLE_ALLOW`, a harness default, or a hand-edited spec, and the
 * deny still holds. Nothing is added for a rank that writes, so a `CPT·ENGINEER`'s deny-list is
 * the same list it was before rank meant anything.
 */
export function rankDeny(rank: Rank): readonly string[] {
  return [
    ...(WRITES_FILES[rank] ? [] : WRITE_CAPABLE_TOOLS),
    ...(SPAWNS_UNITS[rank] ? [] : SPAWN_TOOLS),
  ];
}

/**
 * Refuse a loadout that contradicts what its rank and role declare about writing.
 *
 * Called twice on every spawn, on two different lists, because the two calls catch two different
 * mistakes:
 *
 *  - on `ROLE_ALLOW[role]` against `ROLE_WRITES_FILES[role]`, which makes the role map load-bearing
 *    rather than decorative: adding `Edit` to the INSPECTOR loadout, or clearing the ENGINEER's
 *    flag, stops every spawn instead of quietly restating the review gate;
 *  - on the NARROWED list against `writesFiles(rank, role)`, which is the post-condition of the
 *    narrowing itself: delete the filter in `narrowToRank` and no COLONEL·ENGINEER can be built.
 *
 * It checks `WRITE_TOOLS` only, not `WRITE_CAPABLE_TOOLS`, because holding a shell is not the same
 * claim: a CPT·INSPECTOR declares `false` here and keeps its `Bash(npm test:*)`, which is the
 * point of the distinction the INSPECTOR loadout comment makes.
 */
export function assertDeclaredWritesMatchLoadout(
  allow: readonly string[],
  declared: boolean,
  who: string,
): void {
  const held = allow.filter((rule) => WRITE_TOOLS.includes(toolNameOf(rule)));
  if (held.length > 0 === declared) return;
  throw new Error(
    declared
      ? `refusing to spawn ${who}: it is declared to write files and its loadout holds no ` +
        `${WRITE_TOOLS.join('/')} tool. A worker told to edit and handed nothing to edit with ` +
        'fails at the far end of an expensive run, and the failure looks like a bad model.'
      : `refusing to spawn ${who}: it is declared not to write files and its loadout holds ` +
        `${held.join(', ')}. Rank is authority: it narrows a role's loadout and never widens ` +
        'one, so a write tool surviving here means the narrowing was bypassed rather than that ' +
        'the declaration was wrong. Change the declaration deliberately, or leave the tool off.',
  );
}

export interface PermissionSet {
  allow: string[];
  deny: string[];
}

/**
 * `['Bash(git add:*)', 'Bash(npm test:*)', 'Read']` -> `['Bash', 'Read']`.
 *
 * The `unguarded` posture in one function: keep every tool the role was granted, drop the argv
 * scoping, dedupe. It is a projection, never a widening — `unscoped(x)` and `x` name the same
 * tools, which is what lets `assertDeclaredWritesMatchLoadout` and `assertCommanderLoadout` run
 * unchanged over either. See `PermissionPosture` in `src/contracts/config.ts` for why.
 */
export function unscoped(rules: readonly string[]): string[] {
  return toolNamesOf(rules);
}

/**
 * The allow/deny pair for one worker. The only supported way to build one.
 *
 * ## The intersection rule
 *
 * A ROLE asks for a loadout. A RANK subtracts from it. Nothing anywhere adds.
 *
 * ```
 * allow = ROLE_ALLOW[role]  minus  (WRITES_FILES[rank] ? nothing : WRITE_CAPABLE_TOOLS)
 * deny  = globalDeny(home)  plus   ROLE_DENY[role]  plus  rankDeny(rank)
 * ```
 *
 * so a worker holds a write tool iff `writesFiles(rank, role)` — rank AND role, never either
 * alone. The rank half is the new one: a COLONEL·ENGINEER is constructible and receives Read,
 * Grep, Glob and TodoWrite, with no Edit, no Write, no NotebookEdit and no shell, because the
 * ranks holding strategy are the ranks that must be incapable of a bad `rm`.
 *
 * `rank` is a required positional argument and deliberately has no default. A rank that a call
 * site may omit is a mechanism that the next call site will omit, and this whole function exists
 * because a map declared as the single source of truth had no reader for the length of a build.
 *
 * `posture` DOES have a default, and it is the tight one — see `SoldierSpec.posture` for why the
 * polarity matters. It changes the allow half only, and only by dropping argv scoping; the deny
 * half below is byte-identical under both postures.
 */
export function permissionsFor(
  rank: Rank,
  role: Role,
  home?: string,
  posture: PermissionPosture = 'guarded',
): PermissionSet {
  const who = `a ${formatUnit(rank, role)}`;
  // Before anything is subtracted, check that the bottom of the rank order is still a floor. Every
  // loadout below depends on the recursion terminating somewhere, and the place it terminates is a
  // table entry that nothing else reads.
  assertRankFloorContiguous();
  assertDeclaredWritesMatchLoadout(ROLE_ALLOW[role], ROLE_WRITES_FILES[role], `${who} (its role loadout)`);

  // THE ONE LINE THE POSTURE CHANGES. `unscoped` maps the role's rules to their tool NAMES, so the
  // SET OF TOOLS is bit-for-bit the set `guarded` would grant — `Bash(git add:*)` and
  // `Bash(npm test:*)` collapse to one `Bash`, `Read` stays `Read` — and only the argv scoping is
  // dropped. Everything downstream is unchanged and still runs: the rank narrowing below, the
  // commander's context guard, the write-declaration check, and the whole deny half.
  //
  // Deliberately NOT a wider list. A posture that added a tool would make `ROLE_ALLOW` stop being
  // the single source of truth for who holds what, and `assertDeclaredWritesMatchLoadout` would be
  // checking a list nobody declared.
  const requested = posture === 'unguarded' ? unscoped(ROLE_ALLOW[role]) : ROLE_ALLOW[role];
  const allow = narrowToRank(rank, requested);
  if (role === 'COMMANDER') assertCommanderLoadout(allow, who);
  assertDeclaredWritesMatchLoadout(allow, writesFiles(rank, role), who);
  assertAllowListNonEmpty(allow, who);

  const deny = [...globalDeny(home), ...ROLE_DENY[role]];
  // Appended only when absent, so the wire format of every worker that was already correct is
  // unchanged: a COL·COMMANDER is denied `Bash` once, by `ROLE_DENY`, exactly as it was.
  for (const tool of rankDeny(rank)) if (!deny.includes(tool)) deny.push(tool);
  return { allow, deny };
}

// ---------------------------------------------------------------------------------------------
// Carrying rank across the spawn boundary
// ---------------------------------------------------------------------------------------------

/**
 * A subordinate a process-substrate unit may field as a native subagent.
 *
 * ## THE PROBLEM THIS SOLVES, WHICH IS NOT THE ONE IT LOOKS LIKE
 *
 * A native subagent does not go through `permissionsFor`. It is not a process, it has no argv, and
 * nobody hands it an `--allowedTools`. It runs INSIDE its parent and INHERITS its parent's
 * permission settings — so on the day something below CAPTAIN could first be fielded, the rank
 * narrowing above reached exactly as far as the parent and no further. A CPT·ENGINEER spawning a
 * SERGEANT would have produced a unit holding Edit, Write, NotebookEdit and a shell, because its
 * parent holds them, and `WRITES_FILES.SERGEANT` would have had no reader. A rank whose narrowing
 * can be escaped by spawning is not a rank; it is a label on a unit that has its parent's powers.
 *
 * The fix is that the subordinate is DECLARED, with its loadout, at the moment its parent is
 * spawned — and the loadout is computed by the same `narrowToRank` that computes the parent's, off
 * the same two tables. There is no second place where a subagent's tools are decided, and no
 * spelling of "remember to narrow it too".
 *
 * ## WHAT THE HARNESS ENFORCES, MEASURED RATHER THAN ASSUMED
 *
 * Measured against claude 2.1.221 on 2026-08-04, a live parent with a live subagent, each row run
 * and read off the stream rather than reasoned about:
 *
 * | Property | Result |
 * |---|---|
 * | a declared `tools` list is the subagent's ACTUAL loadout | **enforced** — a subordinate declared without `Write` was refused it and reported holding only what it was declared, while its parent held `Write` throughout |
 * | the parent's deny rules reach the subagent | **enforced** — a subordinate hit the credential deny and got `denied by your permission settings` |
 * | the parent's scoped shell rules reach the subagent | **enforced** — a subordinate under `Bash(echo:*)` was refused `curl` |
 * | a subordinate declared without a spawn tool cannot spawn | **enforced** — it reports no such tool, rather than calling one and being refused |
 * | the spawn DEPTH cap removes the spawn tool at the limit | **enforced** — at the cap, a subordinate declared WITH the spawn tools did not have them |
 * | naming an agent type on the DENY half blocks it | **enforced** — `denied by permission rule ... from cliArg` |
 * | naming an agent type on the ALLOW half restricts types | **NOT ENFORCED** — see below |
 *
 * That last row is why `BUILTIN_AGENT_TYPES` exists and is a deny. The standing order on this
 * project is that deny-lists do not work and allow-lists do, and the allow-list was tried FIRST:
 * a parent whose only spawn rules were `Agent(<our type>)` spawned a built-in `general-purpose`
 * anyway, successfully. The spawn tool is simply not gated by the allow half. So the enforcing
 * form here is the deny, against the honest statement of what a deny cannot promise — and the
 * residual is bounded by two things that ARE enforced: an undeclared built-in still inherits the
 * parent's own allow and deny rules, so it cannot reach anything the parent could not, and the
 * depth cap still terminates it. What an escape buys is an unranked unit at the parent's own
 * ceiling, one level down. Not a wider blast radius — a missing name in the org chart.
 *
 * The type itself is `SubagentDefinition` in `src/contracts/harness.ts`; everything that decides
 * what goes IN one is here.
 *
 * A last note on the tool vocabulary, because it is the second reason `WRITES_FILES` denies both
 * subagent ranks: a declaration carries tool NAMES and has no position for the `Bash(git:*)` form,
 * so a subordinate cannot be handed a SCOPED shell. The only shell it could be handed is an
 * unscoped one, and this codebase does not hand out unscoped shells. With both ranks non-writing,
 * `WRITE_CAPABLE_TOOLS` removes `Bash` before it could ever reach a declaration, and the missing
 * vocabulary costs nothing.
 */

/**
 * Agent types the harness ships with, which exist whether or not this codebase declares them.
 *
 * MEASURED, from the `agents` array a live `system/init` reported, and therefore A SNAPSHOT OF ONE
 * INSTALLATION rather than a closed set — plugins and future releases add to it. It is written down
 * anyway because the deny is the only form the harness enforces for agent types, and a deny that
 * names six things is worth more than a deny that names none. What keeps its incompleteness from
 * mattering is stated above: an unnamed built-in inherits the parent's ceiling and dies at the
 * depth cap.
 */
export const BUILTIN_AGENT_TYPES: readonly string[] = Object.freeze([
  'claude',
  'Explore',
  'general-purpose',
  'Plan',
  'statusline-setup',
]);

/** `SERGEANT` + `ENGINEER` -> `sgt-engineer`. The `subagent_type` a parent names. */
export function subagentTypeName(rank: Rank, role: Role): string {
  return `${RANK_ABBREV[rank]}-${role}`.toLowerCase();
}

/**
 * The subordinates a unit of this rank and role may field, with each one's narrowed loadout.
 *
 * Rank comes from `subagentRanksUnder`, so the roster cannot contain a rank the spawn rule would
 * reject. Role is INHERITED from the parent: role is branch of service, and a squad fielded to
 * decompose an engineering objective is engineering. Rank is what changes going down, which is the
 * whole distinction the two axes exist to draw.
 */
export function subagentRosterFor(parentRank: Rank, parentRole: Role): SubagentDefinition[] {
  return subagentRanksUnder(parentRank).map((rank) => {
    const tools = toolNamesOf(narrowToRank(rank, ROLE_ALLOW[parentRole]));
    const writes = writesFiles(rank, parentRole);
    const spawns = SPAWNS_UNITS[rank];
    return {
      name: subagentTypeName(rank, parentRole),
      rank,
      role: parentRole,
      description:
        `A ${formatUnit(rank, parentRole)} under your command. ` +
        (spawns
          ? 'Fan out to it when one objective splits into parts that can be investigated ' +
            'independently; it may field its own subordinates.'
          : 'Field it for a single self-contained question. It fields nobody.') +
        ` It holds ${tools.join(', ')}${writes ? '' : ' and no editor and no shell'}.`,
      prompt: subordinateBriefing(rank, parentRole, tools, writes, spawns),
      tools,
    };
  });
}

/**
 * The unique tool NAMES behind a list of rules, first occurrence order.
 *
 * Twenty-eight `Bash(prefix:*)` rules are one tool called `Bash`, and a subagent declaration that
 * repeated it twenty-eight times would be declaring the same capability over and over while saying
 * nothing about its scope — which the format cannot carry anyway.
 */
export function toolNamesOf(rules: readonly string[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    const name = toolNameOf(rule);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function subordinateBriefing(
  rank: Rank,
  role: Role,
  tools: readonly string[],
  writes: boolean,
  spawns: boolean,
): string {
  return [
    `You are a ${formatUnit(rank, role)}. Your rank is your authority and it is narrower than`,
    'the unit that fielded you. Do the one thing you were sent to do and report back.',
    '',
    `Your tools are: ${tools.join(', ')}.`,
    // Terse, deliberately — this briefing is paid for on every subagent spawn.
    //
    // The effort sentence is worded as INHERITANCE rather than as a fact about this subordinate,
    // because that is what it is: `SubagentDefinition` carries a description, a prompt and a tool
    // list, and `buildAgentsJson` emits exactly those three. There is no effort field and no model
    // field, so a native subagent runs inside its parent's process at its parent's effort. Saying
    // "you run at low effort" flatly would be false for precisely the subordinates that matter
    // most — the ones fielded by an Engineer that was escalated to `xhigh` for arriving without a
    // spec, which is the case where a briefing telling them not to think would be worst.
    //
    // What is true in BOTH cases is the instruction underneath: an ambiguity resolved by guessing
    // looks like an answer and is the expensive failure, and one NAMED back costs a single turn.
    'You do not get a reasoning budget of your own — you run inside the unit that fielded you, ' +
      'at whatever effort it was given, and by default that is LOW. That is deliberate: the ' +
      'decisions were supposed to be made before you were sent. You are NOT being asked to make ' +
      'design decisions. If your ' +
      'orders are ambiguous, under-specified, or seem to need a choice nobody told you how to ' +
      'make, REPORT THE GAP in your answer — name what is missing — instead of resolving it ' +
      'yourself and carrying on.',
    writes
      ? ''
      : 'You hold no editing tool and no shell, and this is deliberate rather than an oversight: ' +
        'you share your commander\'s worktree with your siblings, and a change you made there ' +
        'would arrive on a branch nobody could attribute. Report what should change and where. ' +
        'Do not ask another unit to make the change on your behalf.',
    spawns ? '' : 'You field no subordinates. You are the floor.',
    '',
    'Return a short, dense answer: what you found, where (file and line), and what you could not',
    'determine. Your commander is reading many of these — length costs it the context it needs to',
    'act on yours. Do not restate your orders back.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Deny rules that stop a parent fielding anything it was not issued a roster for.
 *
 * Two halves, both denies, because the allow half was measured not to gate the spawn tool at all:
 *
 *  - every built-in agent type, so the roster is the roster rather than a suggestion alongside a
 *    shelf of unranked units carrying the parent's own loadout;
 *  - every ranked type the parent may NOT field. A CAPTAIN's roster names SERGEANT and PRIVATE; the
 *    types for GENERAL, COLONEL and CAPTAIN itself are denied by name, so the spawn rule is
 *    enforced where the spawn happens and not only in the roster that omitted them.
 */
export function subagentDeny(parentRank: Rank, parentRole: Role): string[] {
  const allowedNames = new Set(subagentRosterFor(parentRank, parentRole).map((def) => def.name));
  const forbidden = [
    ...BUILTIN_AGENT_TYPES,
    ...RANK_ORDER.filter((rank) => !allowedNames.has(subagentTypeName(rank, parentRole))).map(
      (rank) => subagentTypeName(rank, parentRole),
    ),
  ];
  const out: string[] = [];
  for (const type of forbidden) {
    for (const tool of SPAWN_TOOLS) {
      const rule = `${tool}(${type})`;
      if (!out.includes(rule)) out.push(rule);
    }
  }
  return out;
}

/**
 * Refuse a roster that would field something the rank table does not permit, or hand a subordinate
 * a tool its parent does not itself hold.
 *
 * The containment check is the one worth explaining. Rank narrows and never widens, and a spawn is
 * the one place that rule could be broken without touching any table: declare a subordinate with a
 * tool its parent was never issued, and the child is more capable than the unit that fielded it.
 * Inheritance makes that a real possibility rather than a theoretical one, because the child's
 * environment is the parent's — so the check is against the parent's OWN narrowed allow-list, after
 * its rank has already subtracted from it, not against the role table the parent asked from.
 */
export function assertSubagentRosterSafe(
  roster: readonly SubagentDefinition[],
  parentRank: Rank,
  parentAllow: readonly string[],
  who: string,
): void {
  const held = new Set(toolNamesOf(parentAllow));
  const seen = new Set<string>();
  for (const def of roster) {
    assertMayField(parentRank, def.rank, who);
    if (seen.has(def.name)) {
      throw new Error(`refusing to spawn ${who}: its roster declares ${def.name} twice`);
    }
    seen.add(def.name);

    // The same trap the allow-list has, one level down. A declaration with no tools is not a
    // subordinate with no tools — it is a subordinate the harness has been told nothing about.
    assertAllowListNonEmpty(def.tools, `${who}'s subordinate ${def.name}`);

    const gained = def.tools.filter((tool) => !held.has(tool));
    if (gained.length > 0) {
      throw new Error(
        `refusing to spawn ${who}: it would field a ${def.name} holding ${gained.join(', ')}, ` +
          'which it does not hold itself. Rank narrows going down and never widens, and a spawn ' +
          'is the one place that can be broken without editing a table — the subordinate runs ' +
          'inside this unit and inherits its settings, so a tool declared here that the parent ' +
          'was never issued is authority appearing out of nowhere.',
      );
    }
    assertDeclaredWritesMatchLoadout(
      def.tools,
      writesFiles(def.rank, def.role),
      `${who}'s subordinate ${def.name}`,
    );

    const spawnHeld = def.tools.filter((tool) => SPAWN_TOOLS.includes(tool));
    if (spawnHeld.length > 0 && !SPAWNS_UNITS[def.rank]) {
      throw new Error(
        `refusing to spawn ${who}: it would field a ${def.name} holding ${spawnHeld.join(', ')}, ` +
          `and ${def.rank} is the floor. The floor is what bounds the depth — a subordinate that ` +
          'can field subordinates recurses, and every level of it is billed to one subscription.',
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The assertion — mechanism, not a rule to remember
// ---------------------------------------------------------------------------------------------

/** Every `PROTECTED_CONFIG_GLOBS` entry that no rule in `deny` mentions. Empty means intact. */
export function missingProtectedGlobs(deny: readonly string[]): string[] {
  const haystack = deny.join('\n');
  return PROTECTED_CONFIG_GLOBS.filter((glob) => !haystack.includes(`(${glob})`));
}

/**
 * Refuse to spawn a worker whose deny-list has lost the protected-config block.
 *
 * Called by `buildSoldierSpec` for EVERY role on EVERY attempt, including the Inspector and
 * including retries. The failure mode this prevents is not an attack — it is someone tidying up
 * a list six months from now and taking the boundary with them, in a commit whose tests all pass.
 */
export function assertGlobalDenyIntact(deny: readonly string[], who: string): void {
  const missing = missingProtectedGlobs(deny);
  if (missing.length > 0) {
    throw new Error(
      `refusing to spawn ${who}: its deny-list is missing ${missing.join(', ')}. ` +
        'Denying workers write access to ~/.agentic-army/** is what makes the ' +
        'delivery ceiling a boundary rather than a speed bump, because the TTY gate on ' +
        '`army enlist` is satisfiable by anything that can spawn a pty. Without this entry the ' +
        'ceiling is a guardrail against accident, and this campaign would be claiming otherwise.',
    );
  }
}

/**
 * Refuse a rule that would be parsed as a CLI flag.
 *
 * `--allowedTools` and `--disallowedTools` are variadic, so a value beginning with `-` becomes a
 * real flag on claude's command line. The claude adapter already refuses this at
 * `buildClaudeArgs`; checking here too means a malformed rule is caught where it was written
 * rather than three modules downstream.
 */
export function assertNoFlagLikeRules(rules: readonly string[], what: string): void {
  for (const rule of rules) {
    if (rule.startsWith('-')) {
      throw new Error(`${what} contains a flag-like rule ${JSON.stringify(rule)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The worktree pool must not be inside the region every worker is denied
// ---------------------------------------------------------------------------------------------

/** A `protectedConfigGlobs()` entry with its trailing `/**` removed — the directory it roots. */
function globBase(glob: string): string {
  return glob.replace(/[/\\]\*\*$/, '');
}

/**
 * The protected glob that contains `target`, or `null`.
 *
 * Compares RESOLVED REAL paths, never strings. On macOS a pool root under `/tmp` and a deny root
 * under `/private/tmp` are the same directory spelled two ways, and a lexical comparison calls
 * them unrelated — a guard that fails open. `isInsideOrEqual` realpaths the deepest existing
 * ancestor of each side (the pool root legitimately may not exist yet) and case-folds on the
 * platforms whose filesystems are case-insensitive.
 */
export function protectedGlobContaining(target: string, home?: string): string | null {
  for (const glob of protectedConfigGlobs(home)) {
    if (isInsideOrEqual(target, globBase(glob))) return glob;
  }
  return null;
}

/**
 * Refuse to start a campaign whose worktree pool sits inside the protected config tree.
 *
 * This is the bug that shipped: the pool root defaulted to `<archiveRoot>/worktrees`, and
 * `archiveRoot` defaults to the army home — the one region every worker is denied Read, Grep,
 * Glob, Write and Edit on. The Engineer was denied its own leased worktree and could do nothing.
 *
 * Fixing the default is not enough on its own, because `--worktree-root`, `archive_root` and a
 * test seam can all still name a path inside the home, and the symptom (an agent that reads no
 * files and reports nothing) does not look anything like its cause. So the invariant is asserted
 * where it can be seen, rather than left to a default nobody re-checks.
 *
 * The deny itself is never what gives. It is what makes the delivery ceiling a boundary and
 * what keeps an Inspector's brief independent of the Engineer's own report.
 */
export function assertWorktreeRootOutsideProtected(worktreeRoot: string, home?: string): void {
  const hit = protectedGlobContaining(worktreeRoot, home);
  if (hit === null) return;
  const suggested = home === undefined ? '<army home>-trees' : worktreesRootFor(home);
  throw new Error(
    `refusing to start: the worktree pool root ${worktreeRoot} is inside ${hit}, which every ` +
      'worker is denied Read, Grep, Glob, Write and Edit on. An Engineer leased a ' +
      'tree there would be denied its own worktree and could not open a single file. The deny ' +
      'does not move: it is what makes the delivery ceiling a boundary, and it is also what ' +
      'stops a worker reading a previous agent\'s report.md and walking around the review gate. ' +
      `Point the pool outside the army home — the default is the sibling ` +
      `${suggested}. \`${invokedAs()} doctor\` reports where the pool is.`,
  );
}
