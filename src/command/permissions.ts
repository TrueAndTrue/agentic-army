/**
 * Permissions. Where the delivery ceiling stops being a number in a file and becomes
 * a boundary.
 *
 * ```
 * ALLOW  ENGINEER   Read Grep Glob, Edit Write, Bash(git*|test|build|lint)
 *        INSPECTOR  Read Grep Glob, Bash(test|lint)
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
 */
export function permissionsFor(rank: Rank, role: Role, home?: string): PermissionSet {
  const who = `a ${formatUnit(rank, role)}`;
  // Before anything is subtracted, check that the bottom of the rank order is still a floor. Every
  // loadout below depends on the recursion terminating somewhere, and the place it terminates is a
  // table entry that nothing else reads.
  assertRankFloorContiguous();
  assertDeclaredWritesMatchLoadout(ROLE_ALLOW[role], ROLE_WRITES_FILES[role], `${who} (its role loadout)`);

  const allow = narrowToRank(rank, ROLE_ALLOW[role]);
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
