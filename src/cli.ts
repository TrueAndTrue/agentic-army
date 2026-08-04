#!/usr/bin/env node
/**
 * `army` — argument routing only.
 *
 * This file deliberately contains no orchestration. It parses argv by hand (no
 * dependency), dispatches to a command module, and turns the returned number
 * into an exit code. Anything that thinks is somewhere else.
 */

import { readFileSync } from 'node:fs';

import { invokedAs } from './setup/checks.ts';
import { doctorCommand } from './setup/doctor.ts';
import { enlistCommand } from './setup/enlist.ts';
import { initCommand } from './setup/init.ts';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

function readVersion(): string {
  // Works from src/cli.ts during development and from dist/cli.js once built:
  // package.json is one level up in both layouts.
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/*
 * =============================================================================================
 * EVERY LINE HERE THAT NAMES A COMMAND TO TYPE GOES THROUGH `invokedAs()`.
 * =============================================================================================
 *
 * These blocks were `const` strings hardcoding `army …`, which is right for exactly one audience
 * — someone who has already run `npm i -g agentic-army` — and wrong for `npx agentic-army`,
 * `npm run dev --`, and `node src/cli.ts`. The FIRST RUN block was the worst of them: it is the
 * first thing a checkout user reads, and all three of its steps were commands they could not run.
 *
 * They are FUNCTIONS OF `self` rather than constants because the answer is not knowable until
 * there is a process — see the block above `invokedAs` in `src/setup/checks.ts`.
 *
 * The TITLE lines are the documented exception and stay `army <command>`: `army doctor — check
 * the environment` names the command, it is not an instruction to run it. Same convention as
 * `src/command/index.ts`, and the repo-wide guard in `test/doctor.test.ts` encodes it.
 */

/** `army doctor  # note`, aligned, with the invocation the reader can actually type. */
function alignedSteps(steps: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...steps.map(([command]) => command.length));
  return steps
    .map(([command, note]) => (note === '' ? `  ${command}` : `  ${command.padEnd(width)}  # ${note}`))
    .join('\n');
}

function topLevelHelp(self: string): string {
  const firstRun = alignedSteps([
    [`${self} doctor`, 'find out what is missing before anything else'],
    [`${self} init`, 'create the war archive in ~/.agentic-army'],
    ['cd ~/code/some-repo', ''],
    [`${self} enlist`, 'register it — ceiling 0, commit only'],
  ]);
  return `
army — a war-hierarchy multi-agent orchestrator

  You are the Commander. Everything below you is an agent with a rank, a role,
  and a bounded authority. Officers plan and never edit files; Captains and
  below do the work in isolated worktrees; every change is reviewed by an
  independent Inspector before it can be reported up.

USAGE
  ${self} <command> [options]

SETUP
  doctor            Check this machine's environment. Safe to run at any time.
                    Exits 1 if anything is blocking, so it works in CI.
  init              Create ~/.agentic-army/ and write config.toml. Idempotent.
  enlist            Register the current git repository and set its delivery
                    ceiling. Run it from inside the repo.

CAMPAIGNS
  campaign          Run one objective end to end: Engineer, review gate,
                    delivery up to the project ceiling.
  view              Read-only tree view of a campaign in flight.
  rebuild           Rebuild campaign.db from the files, which are truth.

GLOBAL OPTIONS
  -h, --help        Show this help, or \`${self} <command> --help\` for one.
  -v, --version     Print the version and exit.

FIRST RUN

${firstRun}

  The delivery ceiling is worth understanding before your first campaign:
  it decides whether an agent may open a pull request or merge one. Raising it
  takes a terminal or a hand edit of ~/.agentic-army/config.toml — a guardrail
  against drift, which only becomes a real boundary once workers are denied
  write access to that directory.

RANKS   ☆ GENERAL   ◆ COLONEL   ◇ CAPTAIN   ▪ SERGEANT   · PRIVATE
ROLES   SCOUT (find out)  ENGINEER (change)  INSPECTOR (verify)  SENTRY (wait)
`;
}

const COMMAND_HELP: Record<string, (self: string) => string> = {
  doctor: (self) => `
army doctor — check the environment

  Every failure mode in this system is environmental, so this is the first
  thing to run when anything looks wrong. It never changes anything.

USAGE
  ${self} doctor [--json] [--timeout <ms>]

OPTIONS
  --json            Emit the full report as JSON on stdout.
  --timeout <ms>    Per-subprocess timeout. Default 5000.

EXIT CODES
  0                 Nothing blocking. Degraded checks still exit 0.
  1                 At least one blocking failure.

OUTCOMES
  ✓ ok              Fine.
  ⚠ degraded        Works, but you lose a named capability. Doctor tells you
                    which one — e.g. no gh means delivery is capped at rung 1.
  ✗ blocking        Cannot run. Doctor gives you the exact command to fix it.
`,
  init: (self) => `
army init — create the war archive

  Runs doctor first and refuses to proceed if anything is blocking. Then
  creates ~/.agentic-army/{campaigns,mirrors} and writes config.toml with the
  default dispatch rules.

USAGE
  ${self} init [--skip-doctor]

OPTIONS
  --skip-doctor     Create the layout without checking the environment first.

  Idempotent: an existing config.toml is never overwritten, so re-running this
  on a working machine does nothing.
`,
  enlist: (self) => `
army enlist — register the current repository

USAGE
  ${self} enlist [--ceiling 0|1|2|3]

  Records the repository's absolute path and its delivery ceiling in the GLOBAL
  config at ~/.agentic-army/config.toml. Nothing is written into the repo.

THE DELIVERY LADDER
  0  commit         Durable in the army mirror. Your repo is untouched. Default.
  1  push           Branch pushed to origin. No PR.
  2  pull request   PR opened, Inspector verdict posted as a review.
  3  merge          Merged after an Inspector PASS.

WHY THE CEILING IS NOT IN YOUR REPO
  Because cloning a repository would otherwise be enough for that repository to
  grant itself merge rights on your machine. The repo gets no say; only your
  own machine-local config does.

RAISING vs LOWERING
  A ceiling can be raised two ways: from a terminal (\`--ceiling N\` requires
  stdin to be a real TTY), or by editing config.toml directly. Lowering is
  always allowed and needs no terminal.

  Scope this honestly. The TTY check is a guardrail against accident and
  prompt-driven drift, NOT a boundary against a process that already has shell
  access — \`script\` and \`python3 -c 'import pty'\` both hand out a terminal.
  What closes both routes is denying workers write access to ~/.agentic-army/**
  at the permission layer. Without that deny rule this refusal is a speed bump.

  The entry is keyed by the MAIN repository root, so running enlist inside a
  linked worktree updates the same project rather than creating a second one
  with its own ceiling.
`,
  rebuild: (self) => `
army rebuild — reconstruct campaign.db from the files

  SQLite is the index; the files are truth. This command throws the
  index away and puts it back from campaign.json, tasks.jsonl, signals.jsonl,
  agents/*/agent.json and agents/*/stream.jsonl. It never reads the existing
  database, so anything that comes back was really on disk — and anything that
  does not was never truth to begin with.

USAGE
  ${self} rebuild [campaign-id] [--archive <dir>] [--json]

  With no campaign id, every campaign in the archive is rebuilt.

OPTIONS
  --archive <dir>   Archive root. Default: config archive_root, else
                    $AGENTIC_ARMY_HOME, else ~/.agentic-army.
  --json            Emit the rebuild report as JSON.

EXIT CODES
  0                 Rebuilt, nothing skipped.
  1                 Rows were present in the files but did not make the index.
                    Every one of them is named in the warnings.
`,
};

// ---------------------------------------------------------------------------
// rebuild — the files are truth, and this "must exist from day one or that seam rots"
// ---------------------------------------------------------------------------

async function rebuildCommand(argv: readonly string[], self: string): Promise<number> {
  const [{ rebuildArchive, rebuildCampaign }, { archiveDurabilityNote }, { loadConfig }, { armyHome }, { campaignDir }] =
    await Promise.all([
      import('./archive/rebuild.ts'),
      import('./archive/archive.ts'),
      import('./config/load.ts'),
      import('./config/paths.ts'),
      import('./archive/paths.ts'),
    ]);

  let archiveRoot: string | undefined;
  let campaignId: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--archive') {
      archiveRoot = argv[++i];
      if (archiveRoot === undefined) {
        process.stderr.write(
          `${self} rebuild: --archive expects a path\nTry \`${self} rebuild --help\`.\n`,
        );
        return 1;
      }
    } else if (arg.startsWith('-')) {
      process.stderr.write(
        `${self} rebuild: unknown option ${arg}\nTry \`${self} rebuild --help\`.\n`,
      );
      return 1;
    } else if (campaignId === undefined) {
      campaignId = arg;
    } else {
      process.stderr.write(
        `${self} rebuild: unexpected argument ${JSON.stringify(arg)}\n` +
          `  rebuild takes at most one campaign id; use \`${self} view --list\` to see them.\n` +
          `Try \`${self} rebuild --help\`.\n`,
      );
      return 1;
    }
  }

  const home = armyHome();
  const root = archiveRoot ?? (await loadConfig({ home }).then((c) => c.config.archiveRoot).catch(() => home));

  const results =
    campaignId === undefined
      ? rebuildArchive(root)
      : [rebuildCampaign(campaignDir(root, campaignId))];

  if (json) {
    process.stdout.write(`${JSON.stringify({ v: 1, archiveRoot: root, results }, null, 2)}\n`);
  } else if (results.length === 0) {
    process.stdout.write(`no campaigns in ${root}\n`);
  } else {
    for (const result of results) {
      const w = result.written;
      process.stdout.write(
        `${result.campaignId}  tasks ${w.tasks}  agents ${w.agents}  signals ${w.signals}  events ${w.events}\n`,
      );
      for (const warning of result.warnings) process.stdout.write(`  ⚠ ${warning}\n`);
    }
    // Printed here because this is the command a user reaches for when they suspect the index
    // is wrong, and this note is the reason it might legitimately be.
    process.stdout.write(`\n${archiveDurabilityNote(self)}\n`);
  }

  const skipped = results.some(
    (r) => r.skipped.tasks + r.skipped.agents + r.skipped.signals + r.skipped.events > 0,
  );
  return skipped ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/** Commands that carry their own `--help` text, so it cannot drift from their own options. */
const SELF_DOCUMENTING = new Set(['campaign', 'view']);

/**
 * Every command this file routes, in the order the help lists them.
 *
 * Derived from the two registries above rather than written out a third time, so `unknown
 * command` can never advertise a stale set.
 */
function knownCommands(): string[] {
  const order = ['doctor', 'init', 'enlist', 'campaign', 'view', 'rebuild'];
  const all = new Set([...Object.keys(COMMAND_HELP), ...SELF_DOCUMENTING]);
  return [...order.filter((c) => all.has(c)), ...[...all].filter((c) => !order.includes(c))];
}

export async function run(argv: readonly string[]): Promise<number> {
  const [first, ...rest] = argv;
  // Resolved once. Every command this file prints for the reader to TYPE is built from it, so a
  // screen can never report one form and suggest another.
  const self = invokedAs();

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    const topic = first === 'help' ? rest[0] : undefined;
    const topicHelp = topic === undefined ? undefined : COMMAND_HELP[topic];
    if (topicHelp !== undefined) {
      process.stdout.write(topicHelp(self));
      return 0;
    }
    if (topic !== undefined && SELF_DOCUMENTING.has(topic)) {
      return run([topic, '--help']);
    }
    process.stdout.write(topLevelHelp(self));
    return 0;
  }

  if (first === '--version' || first === '-v') {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  if (first.startsWith('-')) {
    process.stderr.write(
      `${self}: unknown option ${first}\n` +
        `  options come after the command, e.g. \`${self} doctor --json\`.\n` +
        `Try \`${self} --help\`.\n`,
    );
    return 1;
  }

  const commandHelp = COMMAND_HELP[first];
  if (commandHelp !== undefined && wantsHelp(rest)) {
    process.stdout.write(commandHelp(self));
    return 0;
  }

  switch (first) {
    case 'doctor':
      return doctorCommand(rest);
    case 'init':
      return initCommand(rest);
    case 'enlist':
      return enlistCommand(rest);
    // The three campaign commands are imported on demand. `army doctor` is the thing you run
    // when the machine is broken, and it should not have to load the archive, the harness
    // adapters and the delivery ladder to tell you `claude` is missing.
    case 'campaign': {
      const { campaignCommand } = await import('./command/index.ts');
      return campaignCommand(rest);
    }
    case 'view': {
      const { runView } = await import('./view/index.ts');
      return runView(rest);
    }
    case 'rebuild':
      return rebuildCommand(rest, self);
    default:
      // The list is DERIVED from the two registries this file already routes on, not re-spelled:
      // a seventh command cannot be added without appearing here. Naming them is the point —
      // "unknown command" alone tells a reader they were wrong and nothing about being right.
      process.stderr.write(
        `${self}: unknown command ${JSON.stringify(first)}\n` +
          `  commands: ${knownCommands().join(', ')}\n` +
          `Try \`${self} --help\`.\n`,
      );
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const exitCode = await run(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${invokedAs()}: ${message}\n`);
  if (process.env['ARMY_DEBUG'] !== undefined && error instanceof Error) {
    process.stderr.write(`${error.stack ?? ''}\n`);
  }
  return 1;
});

process.exitCode = exitCode;
