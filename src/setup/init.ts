/**
 * `army init` — one-time setup of the war archive.
 *
 * Runs `doctor` first and refuses to proceed on any blocking failure, then
 * creates `~/.agentic-army/{campaigns,mirrors}` and writes `config.toml`.
 *
 * Idempotent by construction: directories are `mkdir -p`, and the config is
 * only ever written when absent. Re-running `army init` on a machine that has
 * been in use for six months must be a no-op, because it is the first thing
 * anyone tries when something looks wrong.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { campaignsRoot, mirrorsRoot } from '../archive/paths.ts';
import { armyHome, configPath } from '../config/paths.ts';
import { invokedAs } from './checks.ts';
import { doctorReport, renderReport } from './doctor.ts';

export { configPath };

export function campaignsDir(home: string = armyHome()): string {
  return campaignsRoot(home);
}

export function mirrorsDir(home: string = armyHome()): string {
  return mirrorsRoot(home);
}

// ---------------------------------------------------------------------------
// The permission boundary that the ceiling actually depends on
// ---------------------------------------------------------------------------

/**
 * Paths that NO WORKER MAY EVER WRITE TO, by any route.
 *
 * ===========================================================================
 * This is the boundary. `army enlist`'s refusal to raise a ceiling is not.
 * ===========================================================================
 *
 * A delivery ceiling can be raised two ways: from a terminal, or by editing
 * `config.toml` directly. The TTY check in `enlist.ts` addresses the first and
 * is only a speed bump — `script`, `expect` and `python3 -c 'import pty'` each
 * hand a terminal to anything that can run a command, and every ENGINEER is
 * granted exactly that. **The deny rule below is what addresses the second, and
 * closing only one of the two closes neither.**
 *
 * A worker permitted to write `~/.agentic-army/**` can set its own ceiling to
 * 3 and merge to your default branch. Not by exploiting anything — by editing
 * a config file, which is the documented, supported way to raise a ceiling.
 * At that point every delivery guarantee is decoration.
 *
 * This is exported rather than described in prose because the orchestrator —
 * which owns worker spawning, and which this module cannot reach — has to
 * enforce it. A constant can be imported and asserted on. A rule in a document
 * has to be remembered by whoever writes the spawn code next.
 *
 * ENFORCEMENT REQUIREMENTS, all of them, or the rule leaks:
 *   - the deny must cover EVERY route: direct writes, `$EDITOR`, shell
 *     redirection, `sed -i`, `tee`, `cp`, `mv`, and `army enlist` itself;
 *   - it must cover the directory as well as the file, since creating
 *     `config.toml` where none exists is equally sufficient;
 *   - it must be a GLOBAL deny with no per-role override, because
 *     a role allow-list that can be widened is not a deny;
 *   - `AGENTIC_ARMY_HOME` must be resolved from the SUPERVISOR's environment,
 *     never from anything a worker supplies — otherwise a worker just points
 *     the army at a config it wrote itself.
 */
export const PROTECTED_CONFIG_GLOBS: readonly string[] = Object.freeze([
  '~/.agentic-army',
  '~/.agentic-army/**',
  '$AGENTIC_ARMY_HOME',
  '$AGENTIC_ARMY_HOME/**',
]);

/**
 * `PROTECTED_CONFIG_GLOBS` resolved against a real home — absolute, with `~`
 * and `$AGENTIC_ARMY_HOME` already expanded, ready to hand to a permission
 * engine that does not do shell expansion.
 */
export function protectedConfigGlobs(home: string = armyHome()): readonly string[] {
  const root = path.resolve(home);
  return Object.freeze([root, path.join(root, '**'), configPath(root)]);
}

/**
 * The default config, comments and all.
 *
 * The comments are the entire reason this file is TOML rather than JSON. A
 * config that silently governs how much authority an agent has over your
 * machine has to explain itself in place — nobody is going to go and read the
 * design document at the moment they are editing a number.
 *
 * Layout note: `[projects]` is deliberately LAST. It is the only table that a
 * command ever edits (`army enlist`), and keeping it at the end means those
 * edits are appends that cannot disturb anything above them or lose a comment.
 */
export function defaultConfigToml(): string {
  return `# agentic-army — global configuration
#
# Written by \`army init\`. Everything here is hand-editable, and \`army init\`
# will never overwrite this file once it exists.
#
# This is TOML, not JSON, for one reason: the comments below are part of the
# configuration. If you convert this file to JSON you lose them.

# Config schema version. Bumped only by a release that changes the shape of
# this file; agentic-army will tell you if it needs migrating.
version = 1

# Where the war archive lives. Campaigns go under <archive_root>/campaigns/ and
# durability mirrors under <archive_root>/mirrors/, so reports never pollute
# your repos. Defaults to the directory holding this file; set it
# only if you want the archive somewhere else, e.g. off a small system disk.
# archive_root = "/absolute/path"

# ENVIRONMENT OVERRIDE — AGENTIC_ARMY_HOME
#
# Setting AGENTIC_ARMY_HOME relocates this entire directory, and therefore THIS
# FILE and every delivery ceiling in it. Point it somewhere else and the army
# reads a different set of ceilings — which is exactly why it is documented here
# rather than left as an undocumented seam.
#
# It is intended for tests and for unusual setups, and it is read from the
# COMMANDER's own environment at startup. A supervisor MUST resolve ceilings
# from its own environment and MUST NEVER accept this value from a worker, a
# campaign file, a repo, or anything else it is told at runtime: honouring an
# attacker-supplied AGENTIC_ARMY_HOME would let a worker point the army at a
# config it wrote itself, which hands it any ceiling it likes.


# ---------------------------------------------------------------------------
# [delivery] — blast radius
# ---------------------------------------------------------------------------
# Push is durability; PR and merge are delivery. Work always
# leaves an ephemeral worktree for a real git ref before its lease is returned,
# so nothing is ever lost regardless of the settings below — a bare mirror
# under ./mirrors/ is used when a project has no remote.
#
# The ladder. These are prefixes, not alternatives:
#
#   0  commit  — durable in the army mirror, your repo untouched
#   1  push    — branch on origin, no PR
#   2  pr      — pull request opened, Inspector verdict posted as a review
#   3  merge   — merged after Inspector PASS (+ green CI if a Sentry is watching)
#
# A campaign may go LOWER than a project's ceiling, never higher.
[delivery]

# Ceiling applied to a project that has been enlisted without an explicit one.
# 0 is the only safe default: an unfamiliar repo gets to commit and nothing more.
default_ceiling = 0


# ---------------------------------------------------------------------------
# [worktree] — the pool every agent works in
# ---------------------------------------------------------------------------
# A campaign leases ONE tree and runs its Engineer and then its Inspector in it.
# The Inspector needs a WRITABLE tree — its most valuable move is mutation
# testing: revert a fix, watch the test go red, restore it — and a leased tree
# is writable, so sharing works. It is not granted an editing tool either way;
# that is its loadout, not the tree. (A second disposable tree per Inspector
# would isolate those mutations from a retrying Engineer, and is not built.)
# Trees are pooled and reused rather than created per task, because a warm reset
# preserves node_modules and turns a 1–3 minute dependency install into an
# incremental one.
#
# Pooling is built in. There is no external binary to install: \`npm i -g
# agentic-army\` is the whole install story.
# Trees live in ~/.agentic-army-trees/ — a SIBLING of this directory, not a
# subdirectory of it, and it does not follow archive_root. Everything under
# ~/.agentic-army is denied to every worker by PROTECTED_CONFIG_GLOBS (see
# [projects] below), so an agent leased a tree inside it would be denied its
# own worktree and could not read a single file. AGENTIC_ARMY_HOME moves the
# trees too: the pool root is always <home>-trees.
[worktree]

# Maximum leased trees. Each is a full checkout plus a warm dependency
# directory, so this is really a disk bound. Default 16.
# max_trees = 16

# Warm reuse. When true (the default) a released tree is cleaned with
# \`git clean -fdx\` EXCEPT for the preserved directories below, so the next
# task's install runs incrementally. Set false to scrub every tree completely.
# warm = true

# Directories a warm release must not delete. ADDITIVE — whatever you list is
# added to the built-in set (node_modules, .venv, venv, vendor, __pycache__,
# .mypy_cache, .ruff_cache, .pytest_cache, .gradle, .turbo), never a
# replacement for it, so adding "target" for a Rust repo cannot silently stop
# preserving node_modules.
#
# Preserve regenerable INPUTS only — things a hook rebuilds from a lockfile.
# Never a build OUTPUT: a stale one is what the next task's tests will load,
# and it is indistinguishable from a correct one until it is wrong.
# preserve = ["target"]

# How long one hook command may run. Default 900000 (15 minutes) — a cold
# dependency install is genuinely slow.
# hook_timeout_ms = 900000


# ---------------------------------------------------------------------------
# LIFECYCLE HOOKS — and why they live in [projects] below, in THIS file
# ---------------------------------------------------------------------------
# post_create runs after a tree is provisioned AND after every warm reset —
# this is where dependency installation goes. pre_destroy runs before a tree is
# cleaned, while it still has its contents. Both are set PER PROJECT, in the
# [projects] table at the bottom of this file:
#
#   [projects."/Users/you/code/my-app"]
#   ceiling     = 1
#   post_create = ["pnpm install --frozen-lockfile"]
#   pre_destroy = []
#
# A bare string goes through a shell; a nested array is an exact argv and does
# not — [["pnpm", "install", "--frozen-lockfile"]]. Prefer the argv form in
# anything generated, because it has no quoting or word-splitting to get wrong.
#
# A failing hook does NOT abort the lease and is NOT swallowed: the failure is
# reported on the lease so the caller can decide what a failed warm-up means.
#
# =========================================================================
# SECURITY — hooks are read ONLY from this file, never from a repository.
# =========================================================================
#
# A hook is arbitrary command execution. If a hook could be read from the
# repository it runs in — a committed .agentic-army.toml, a package.json field,
# anything — then \`git clone\` would be remote code execution: cloning someone's
# repository would be enough for that repository to run their commands on your
# machine, the moment any agent touched it. The attack costs its author one
# committed file, and nothing about it looks unusual.
#
# So a repo-supplied hook is not merged, not consulted, and not offered as an
# override. The repository gets no say. Only this file does.
#
# This is EXACTLY the same hole as a repo-supplied delivery ceiling, closed the
# same way and for the same reason — see [projects] below. And it rests on the
# same precondition: every worker must be denied write access to this
# directory, or a worker simply writes its own hook here and has it run.


# ---------------------------------------------------------------------------
# [[dispatch.rules]] — which harness runs which job
# ---------------------------------------------------------------------------
# HOW MATCHING WORKS TODAY, in one sentence: the role picks the vendor, and the
# first rule below whose \`use\` names that vendor supplies the model and effort.
#
#   INSPECTOR            -> codex
#   every other role     -> claude
#
# So the two rules below are, in practice, "the claude settings" and "the codex
# settings", and editing \`model\` or \`effort\` in them genuinely changes what
# gets spawned. Only SCOUT and SENTRY are absent from that list, and only
# because nothing spawns one — see [projects]'s neighbours in the docs.
#
# \`when\` IS NOT MATCHED AGAINST ANYTHING. It is accepted, it is required (a
# rule without one is ignored, with a warning), and it is read by humans and by
# the audit trail — but no dispatcher compares it to a task. It is the slot a
# real predicate will occupy. Write it as a truthful label for the rule, not as
# a condition you expect to be evaluated. Same for \`why\`, which is prose by
# design.
#
# \`use\` is an array and ONLY THE FIRST ENTRY IS READ. Extra entries are
# parsed, validated and then ignored.
#
# Zero quota machinery, both subscription pools used without coordination, and
# cross-vendor review independence is structural rather than a rule somebody has
# to remember: a Sonnet Inspector reviewing Sonnet-written code shares its
# training and therefore its blind spots. A GPT Inspector does not.
#
# The accepted weakness is real: when Claude quota is exhausted every Engineer
# stops while Codex sits at 85%. THAT IS THE TRIGGER to build quota resolution,
# and it is what makes \`use\` an array and \`when\` a string ahead of either
# being consulted: on that day the second entry starts being read and a matcher
# starts reading \`when\`, and this file does not change shape.
#
# When that day comes, one rule carries over verbatim: never downgrade reasoning
# class to conserve quota. Report that the strongest-class choice cannot proceed
# instead.
#
# THE ENGINEER RULE'S effort BELOW READS "low", NOT "xhigh" — READ THIS FIRST.
#
# A controlled trial ran one coding task at all five reasoning levels under two
# briefs that differed only in whether the thinking had been done above. Under a
# COMPLETE brief every level succeeded, including low — 4x cheaper and 4x faster
# than xhigh for a byte-identical outcome. Under a THIN brief six of eight arms
# failed on the same sentence a complete brief would have stated; xhigh was the
# one level that still got there.
#
# So low is only the right default in a system that guarantees a complete spec,
# and this file is one leg of that guarantee, not the whole of it: the commander
# now interrogates you until it can fill a six-field spec, and a dispatch made
# without one is escalated back to xhigh automatically (UNSPECIFIED_BRIEF_EFFORT
# in campaign.ts's dispatchFor). This is a measured default, not a quota
# downgrade — see the reasoning-class rule above REASONING_EFFORTS in
# src/contracts/harness.ts for the line between the two.

[[dispatch.rules]]
when = "Any change to any file."
use = [ { harness = "claude", model = "claude-sonnet-5", effort = "low" } ]
why = "Engineers build on Claude. Effort is low by measured default, not by economy: a complete spec produced byte-identical output at low and xhigh, 4x cheaper and 4x faster. A brief dispatched without a complete spec never sees this value — UNSPECIFIED_BRIEF_EFFORT in campaign.ts's dispatchFor escalates it to xhigh first."

[[dispatch.rules]]
when = "An Engineer has claimed done and its branch needs review."
use = [ { harness = "codex", model = "gpt-5.5", effort = "high" } ]
why = "Reviewer must not share the builder's blind spots."

# There is also an optional \`dispatch.default\` array of targets. It parses and
# it validates; NOTHING READS IT YET. A role that matches no rule falls back to
# a built-in target, not to this. It is accepted rather than rejected so that a
# config already carrying one keeps loading.


# ---------------------------------------------------------------------------
# [projects] — enlisted repositories: delivery ceilings AND lifecycle hooks
# ---------------------------------------------------------------------------
# Keyed by ABSOLUTE PATH. Added by \`army enlist\` from inside a repo.
#
# Both of the things kept here — the delivery ceiling and the lifecycle hooks —
# are here for the SAME reason, and it is the reason stated below: a repository
# must never be able to grant itself authority on your machine.
#
# SECURITY — read this before you edit a number below.
#
# A project's ceiling lives HERE, in your global config, and never inside the
# repository it governs. If it lived in the repo, then cloning somebody's
# repository would be enough for that repository to grant itself merge rights on
# your machine. It does not, and it cannot.
#
# A ceiling can be RAISED two ways:
#
#   1. a human at a terminal running \`army enlist --ceiling N\` — stdin must be
#      a real TTY, so a piped or redirected invocation is refused;
#   2. editing this file directly.
#
# LOWERING is always allowed, from anywhere, with no terminal. Reducing blast
# radius is never the dangerous direction.
#
# WHAT THIS IS. The ceiling is a GUARDRAIL against accident and prompt-driven
# drift. It is NOT a security boundary against a process that already has shell
# access on this machine, and it is worth knowing which of the two you have.
# The TTY test stops the naive \`army enlist --ceiling 3\`, but it only asks
# whether fd 0 is a character device — \`script\`, \`expect\` and
# \`python3 -c 'import pty'\` all hand a terminal to anything that can run a
# command, and route 2 above is just a file write.
#
# WHAT MAKES IT A BOUNDARY. One rule, and it is not enforced by this file:
#
#   EVERY WORKER MUST BE DENIED WRITE ACCESS TO THIS DIRECTORY, BY EVERY ROUTE
#   — the CLI, \$EDITOR, shell redirection, \`sed -i\`, \`tee\`, \`cp\`, all of it.
#
# That single deny closes both raise routes at once. Without it, a worker edits
# this file and sets its own ceiling to 3, and everything above is decoration.
# The list is exported as PROTECTED_CONFIG_GLOBS so the orchestrator enforces
# it from code rather than from someone's memory.
#
# Entries are keyed by the MAIN repository root — the parent of the shared
# \`.git\` directory — so a linked worktree cannot register itself as a separate
# project with a separate ceiling. Every Engineer works in a worktree
#, so this is the common path, not an edge case.
#
# Values are clamped to 0..3 on read, and a campaign may only ever go lower.
#
# That is the whole point. No prompt — however persuasive, however late at
# night — can escalate blast radius on a repo you deliberately locked down,
# because the escalation path is not in the conversation.
[projects]
`;
}

export type InitResult = {
  home: string;
  createdHome: boolean;
  createdCampaigns: boolean;
  createdMirrors: boolean;
  configPath: string;
  createdConfig: boolean;
};

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Creates the archive layout. Safe to call repeatedly. */
export async function ensureHomeLayout(home: string = armyHome()): Promise<InitResult> {
  const hadHome = await exists(home);
  const hadCampaigns = await exists(campaignsDir(home));
  const hadMirrors = await exists(mirrorsDir(home));

  // 0o700: this directory ends up holding full transcripts of every agent that
  // has ever touched your source. It is not for other accounts on the machine.
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(campaignsDir(home), { recursive: true, mode: 0o700 });
  await fs.mkdir(mirrorsDir(home), { recursive: true, mode: 0o700 });

  const cfg = configPath(home);
  const hadConfig = await exists(cfg);
  if (!hadConfig) {
    // wx: fail rather than truncate if something wrote it between our stat and
    // now. Never clobber a config, not even by a race.
    await fs.writeFile(cfg, defaultConfigToml(), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }

  return {
    home,
    createdHome: !hadHome,
    createdCampaigns: !hadCampaigns,
    createdMirrors: !hadMirrors,
    configPath: cfg,
    createdConfig: !hadConfig,
  };
}

/**
 * Used by `army enlist`, which must not force the user through `army init`
 * first but also must not silently skip the config's comment block.
 */
export async function ensureConfig(home: string = armyHome()): Promise<InitResult> {
  return ensureHomeLayout(home);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Same refusing shape as `parseDoctorArgs`: a typo'd flag must never init with defaults. */
export type InitArgs = { ok: true; skipDoctor: boolean } | { ok: false; error: string };

export function parseInitArgs(argv: readonly string[]): InitArgs {
  let skipDoctor = false;
  for (const arg of argv) {
    if (arg === '--skip-doctor') {
      skipDoctor = true;
    } else if (arg.startsWith('-')) {
      // `argv.includes('--skip-doctor')` was the whole parser, so `init --bogus` ran to
      // completion at exit 0 while every sibling command refused. Refusing is the only way a
      // typo'd `--skip-doctr` gets noticed before the checks it meant to skip have already run.
      return { ok: false, error: `unknown option ${arg}` };
    } else {
      return { ok: false, error: `unexpected argument ${JSON.stringify(arg)} — init takes no positional arguments` };
    }
  }
  return { ok: true, skipDoctor };
}

export async function initCommand(argv: readonly string[]): Promise<number> {
  const self = invokedAs();
  const parsed = parseInitArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${self} init: ${parsed.error}\nTry \`${self} init --help\`.\n`);
    return 1;
  }
  const skipDoctor = parsed.skipDoctor;
  const home = armyHome();

  // Checks run exactly once — they are ~8 concurrent subprocess spawns, and running them twice
  // to satisfy the print order would be paying real time for a cosmetic property.
  const report = skipDoctor ? null : await doctorReport();

  // A blocking environment means there is no init to narrate, so this returns before the header
  // is printed. Everything after it is part of the init, and therefore goes under the header.
  if (report !== null && !report.ok) {
    process.stdout.write(renderReport(report));
    process.stderr.write(
      '\nInit stopped: the environment has blocking problems.\n' +
        `Fix the items marked ✗ above, then run \`${self} init\` again.\n` +
        `(\`${self} doctor\` re-runs these checks at any time.)\n\n`,
    );
    return 1;
  }

  // The header goes FIRST. A warning that arrives before the thing it is warning about reads as
  // a crash — which is precisely how the reduced-capability block used to land: above the
  // header, with no context, as the first output of the user's first ever command.
  process.stdout.write(`\n${self} init\n\n`);

  const degraded = report === null ? [] : report.checks.filter((c) => c.outcome === 'degraded');
  if (degraded.length > 0) {
    process.stdout.write('  Proceeding with reduced capability:\n');
    for (const c of degraded) process.stdout.write(`    ⚠ ${c.title} — ${c.found}\n`);
    process.stdout.write(`    (run \`${self} doctor\` for the detail on what each one costs you)\n\n`);
  }

  let result: InitResult;
  try {
    result = await ensureHomeLayout(home);
  } catch (e) {
    process.stderr.write(`\nInit failed while creating ${home}: ${(e as Error).message}\n`);
    return 1;
  }

  const mark = (created: boolean): string => (created ? 'created' : 'already present');
  process.stdout.write(`  ${result.home}${path.sep}                ${mark(result.createdHome)}\n`);
  process.stdout.write(`  ${result.home}${path.sep}campaigns${path.sep}      ${mark(result.createdCampaigns)}\n`);
  process.stdout.write(`  ${result.home}${path.sep}mirrors${path.sep}        ${mark(result.createdMirrors)}\n`);
  process.stdout.write(`  ${result.configPath}    ${mark(result.createdConfig)}\n`);

  if (!result.createdConfig) {
    process.stdout.write('\n  Existing config left untouched — init never overwrites it.\n');
  }
  process.stdout.write(
    `\n  Next: \`cd\` into a repo you want the army to work on and run \`${self} enlist\`.\n\n`,
  );
  return 0;
}
