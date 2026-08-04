/**
 * Permissions. Where the delivery ceiling stops being a number in a file and becomes
 * a boundary.
 *
 * ```
 * ALLOW  ENGINEER   Read Grep Glob, Edit Write, Bash(git*|test|build|lint)
 *        INSPECTOR  Read Grep Glob, Bash(test|lint)
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

import type { Role } from '../contracts/ranks.ts';
import { isInsideOrEqual, worktreesRootFor } from '../config/paths.ts';
import { invokedAs } from '../setup/checks.ts';
import { PROTECTED_CONFIG_GLOBS, protectedConfigGlobs } from '../setup/init.ts';

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

/** The read-only half of an INSPECTOR's Bash: run the suite, run the linter, nothing else. */
export const INSPECTOR_BASH_PREFIXES: readonly string[] = Object.freeze(
  ENGINEER_BASH_PREFIXES.filter((prefix) => !prefix.startsWith('git')),
);

function bashRules(prefixes: readonly string[]): string[] {
  return prefixes.map((prefix) => `Bash(${prefix}:*)`);
}

/**
 * The per-role loadout table, as tool rules.
 *
 * SCOUT and SENTRY are deferred from the v1 slice and are present only so this map is
 * total over `Role` — nothing in the slice spawns one.
 */
export const ROLE_ALLOW: Record<Role, readonly string[]> = Object.freeze({
  SCOUT: Object.freeze(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
  ENGINEER: Object.freeze([
    'Read',
    'Grep',
    'Glob',
    'Edit',
    'Write',
    'NotebookEdit',
    'TodoWrite',
    ...bashRules(ENGINEER_BASH_PREFIXES),
  ]),
  // An Inspector reads and runs; it never edits. Mutation testing does mean an
  // Inspector needs a WRITABLE tree — that is a worktree question, answered by handing it a
  // disposable copy, not a licence to hold the Edit tool.
  INSPECTOR: Object.freeze([
    'Read',
    'Grep',
    'Glob',
    'TodoWrite',
    ...bashRules(INSPECTOR_BASH_PREFIXES),
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

/** Every tool that can put bytes on disk. A path deny must cover all of them or it covers none. */
const WRITE_TOOLS: readonly string[] = Object.freeze(['Write', 'Edit', 'NotebookEdit']);

/** Reading a credential is exfiltration; the secret globs are denied for reads as well. */
const READ_TOOLS: readonly string[] = Object.freeze(['Read', 'Grep', 'Glob']);

function denyPaths(tools: readonly string[], globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const glob of globs) for (const tool of tools) out.push(`${tool}(${glob})`);
  return out;
}

/** The three denied commands, in every spelling a `Bash(...)` prefix rule can carry. */
export const DENIED_COMMAND_RULES: readonly string[] = Object.freeze([
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git push --force-with-lease:*)',
  'Bash(git push --mirror:*)',
  'Bash(git push --delete:*)',
  'Bash(npm publish:*)',
  'Bash(pnpm publish:*)',
  'Bash(yarn publish:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh api:*)',
  'Bash(gh auth token:*)',
]);

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
  ...denyPaths(WRITE_TOOLS, SECRET_PATH_GLOBS),
  ...denyPaths(READ_TOOLS, SECRET_PATH_GLOBS),
  // ---- the load-bearing block ----------------------------------------------------------
  ...denyPaths([...WRITE_TOOLS, ...READ_TOOLS], PROTECTED_CONFIG_GLOBS),
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
  const resolved = home === undefined ? [] : denyPaths([...WRITE_TOOLS, ...READ_TOOLS], protectedConfigGlobs(home));
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
 */
export const ROLE_DENY: Record<Role, readonly string[]> = Object.freeze({
  SCOUT: Object.freeze([]),
  ENGINEER: Object.freeze([]),
  INSPECTOR: Object.freeze([]),
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
  if (allow.length === 0) {
    throw new Error(
      `refusing to spawn ${who}: its allow-list is empty. An empty list is not "no tools" — the ` +
        'claude adapter omits `--allowedTools` entirely when there is nothing to put after it, ' +
        'and a worker spawned without that flag receives the default loadout, which is every ' +
        'tool. The most restrictive spelling of this list is one harmless tool, never none.',
    );
  }
}

export interface PermissionSet {
  allow: string[];
  deny: string[];
}

/** The allow/deny pair for one worker. The only supported way to build one. */
export function permissionsFor(role: Role, home?: string): PermissionSet {
  const allow = [...ROLE_ALLOW[role]];
  if (role === 'COMMANDER') assertCommanderLoadout(allow, `a ${role}`);
  return { allow, deny: [...globalDeny(home), ...ROLE_DENY[role]] };
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
