/**
 * `army campaign` — argument parsing, rendering, exit codes.
 *
 * The orchestration is in `campaign.ts`; this file is the CLI skin over it. Keeping them apart is
 * what lets `test/command.test.ts` drive a whole campaign — including every failure path — by
 * calling `runCampaign` directly, with no argv, no terminal and no process to inspect.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { AgentIdInUseError, archiveDurabilityNote } from '../archive/archive.ts';
import { RUNG_LABEL, RUNGS } from '../contracts/delivery.ts';
import { SCOUT_QUESTION_MAX_CHARS } from '../contracts/scout.ts';
import type { Rung } from '../contracts/delivery.ts';
import { validateTechnicalSpec } from '../contracts/spec.ts';
import type { TechnicalSpec } from '../contracts/spec.ts';
import { WORKTREE_PROVIDER_IDS } from '../contracts/worktree.ts';
import type { WorktreeProviderId } from '../contracts/worktree.ts';
import { invokedAs } from '../setup/checks.ts';
import { renderFix } from '../setup/fixes.ts';
import type { Fix } from '../setup/fixes.ts';
import { detectCharset } from '../view/index.ts';
import { createProgressSink } from '../view/progress.ts';
import type { ProgressSink } from '../view/progress.ts';

import { CampaignSetupError, agentIdInUseFix, runCampaign } from './campaign.ts';
import type { CampaignNote, CampaignOptions, CampaignResult, WriteStream } from './campaign.ts';

export * from './campaign.ts';
export * from './orders.ts';
export * from './permissions.ts';

/**
 * Every line here that names a command to TYPE goes through `invokedAs()`; the title line does
 * not, because "army campaign" there is the name of the command, not an instruction to run it.
 *
 * See the block above `invokedAs` in `checks.ts`: this text used to hardcode `army campaign "…"`
 * in its USAGE, and `army` is not on PATH for `npx agentic-army`, `npm run dev --`, or a plain
 * checkout — which is how the tool is invoked in three of the README's own first examples.
 */
export const CAMPAIGN_HELP = `
army campaign — run one objective end to end

  A CPT·ENGINEER (claude) takes a leased worktree, cuts \`army/<task-id>\` and
  commits. Then the GENERAL — not the Engineer — spawns a CPT·INSPECTOR (codex),
  briefed from the ORIGINAL orders and the branch, never from the Engineer's
  account of what it did. On PASS the work is made durable and the delivery
  ladder runs, clamped by the project ceiling. On FAIL a fresh Engineer retries
  in the same worktree with the findings.

USAGE
  ${invokedAs()} campaign "<objective>" [options]
  ${invokedAs()} campaign --spec <path> [options]

OPTIONS
  --rung <0|1|2|3>     Highest delivery rung to attempt. Clamped by the project
                       ceiling, never raised by this flag. Default 2 — a merge is
                       asked for by name, never arrived at by default.
  --spec <path>        A JSON file holding the six answers a TechnicalSpec asks
                       for (objective, filesInScope, acceptance, behaviours,
                       decisions, constraints) — see src/contracts/spec.ts. A
                       spec that fails validation refuses to run rather than
                       falling back to a free-text campaign. The objective
                       becomes spec.objective; a positional objective ALSO
                       given must match it exactly. Without a spec the
                       Engineer's reasoning effort escalates, on the theory
                       that a worker doing its own thinking needs the budget
                       for it.
  --attempts <n>       Total Engineer attempts including the first. Default 3.
  --overseer           Put a MAJ·OVERSEER over the campaign. It reads the repo,
                       cuts the feature into workstreams with declared file
                       ownership, and answers the questions its engineers raise
                       so they never reach you. It holds Read, Grep and Glob and
                       cannot edit, run a command or merge; this process performs
                       every merge it decides on. Off by default: an overseer is
                       a whole model session spent before an engineer starts, and
                       a small objective does not need a feature owner.
  --recce "<question>" Send a CPT·SCOUT first, with this one-line question. It
                       reads the checkout and the web, holds no editor and no
                       worktree, and what it finds goes into the overseer's
                       segmentation brief and every Engineer's orders. In a chat
                       the Commander asks for a scout and you confirm; here you
                       typing the question is that confirmation. One scout, once;
                       a scout that returns nothing usable is a note, and the
                       campaign carries on without one.
  --workstreams <n>    How many workstreams run at once. Default 3, ceiling 8.
                       Each one is another model session, another worktree and
                       another branch to merge, so this multiplies what a
                       campaign costs while only dividing its wall clock. Read
                       with --overseer; a campaign that segments into one
                       workstream runs exactly as it did before either flag.
  --cwd <dir>          Project to fight the campaign in. Default: this directory.
  --provider <id>      Worktree provider. There is one pooled provider today;
                       the seam is what lets a devcontainer or a snapshotting
                       filesystem take over later. Default: the pool.
  --id <campaign-id>   Override the generated campaign id.
  --no-init            Outside a repository, refuse instead of running the
                       auto-init \`${invokedAs()} enlist\` runs: git init plus one empty
                       commit, never in your home directory or a filesystem root.
  --json               Emit the result as JSON on stdout.
  -h, --help           This.

THE DELIVERY LADDER
  0  commit         Durable in the army mirror. Your repo is untouched.
  1  push           Branch on origin. No PR.
  2  pull request   PR opened, Inspector verdict posted as a review.
  3  merge          The PR merged, and only after an Inspector PASS that reached
                    it, with the Engineer done and the retry budget intact.
                    Anything else — a FAIL, a missing verdict, a host that says
                    no — stops at rung 2 and says which. Needs a ceiling of 3.

  The ceiling lives in ~/.agentic-army/config.toml, keyed by absolute path, and
  is never read from the repository being worked on. \`${invokedAs()} enlist\` sets it.

WHAT LEAVES THE WORKTREE, AND WHEN
  Durability is unconditional and happens BEFORE the lease is returned, on the
  failure paths as well as the happy one — returning a lease resets and cleans
  the tree, so anything left inside it is destroyed. If the work cannot be made
  durable the worktree is deliberately RETAINED and the reason is printed.
`;

class UsageError extends Error {}

export interface CampaignArgs {
  objective: string;
  requestedRung?: Rung;
  maxAttempts?: number;
  cwd?: string;
  provider?: WorktreeProviderId;
  campaignId?: string;
  /** Raw `--spec` path, unread and unvalidated. `campaignCommand` does the I/O. */
  specPath?: string;
  /** True when `--overseer` was passed: spawn a MAJ·OVERSEER over the campaign. */
  overseer?: boolean;
  /** `--workstreams N`: how many workstreams may run at once. */
  maxConcurrentWorkstreams?: number;
  /** `--recce "<question>"`: send a CPT·SCOUT first. One line, non-empty, capped like a chat's. */
  recce?: string;
  /** False when `--no-init` was passed — mirrors `enlist`, which grew the flag first. */
  init: boolean;
  json: boolean;
  help: boolean;
}

/**
 * `--rung` → a `Rung`, or a usage error. Never a guess.
 *
 * The digits-only screen is deliberate and is NOT what `Number()` does on its own. `Number()`
 * reads `" 3"`, `"3 "`, `"+3"`, `"3e0"`, `"3.0"` and `"0x3"` as 3, and — the one that actually
 * bit — reads `""` as **0**, so `--rung ""` silently selected a rung instead of complaining. Now
 * that rung 3 is a rung that merges, "what the user typed" and "what the flag selected" have to
 * be the same string. Anything else refuses, and refusing is the safe direction here: the
 * campaign does not start at all, which is lower than rung 0.
 *
 * This is a floor, not a ceiling. Whatever survives is still clamped by the project's ceiling in
 * the global config, which is the only thing that can authorise a rung.
 */
function asRung(raw: string | undefined): Rung {
  const value = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || !(RUNGS as readonly number[]).includes(value)) {
    throw new UsageError(`--rung expects one of ${RUNGS.join(', ')}, got ${JSON.stringify(raw ?? '')}`);
  }
  return value as Rung;
}

export function parseCampaignArgs(argv: readonly string[]): CampaignArgs {
  const args: CampaignArgs = { objective: '', init: true, json: false, help: false };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--rung':
        args.requestedRung = asRung(next());
        break;
      case '--attempts': {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1) {
          throw new UsageError('--attempts expects a positive integer');
        }
        args.maxAttempts = value;
        break;
      }
      case '--cwd': {
        const value = next();
        if (value === undefined) throw new UsageError('--cwd expects a path');
        args.cwd = path.resolve(value);
        break;
      }
      case '--provider': {
        // Validated AGAINST THE CONTRACT's own list rather than two literals repeated here.
        // The literals were a second copy of a value domain that `test/contracts.test.ts` pins
        // member for member, so a provider added there arrived rejected by both commands.
        const value = next();
        if (!(WORKTREE_PROVIDER_IDS as readonly string[]).includes(value ?? '')) {
          throw new UsageError(
            `--provider expects one of ${WORKTREE_PROVIDER_IDS.join(', ')}, ` +
              `got ${JSON.stringify(value ?? '')}`,
          );
        }
        args.provider = value as WorktreeProviderId;
        break;
      }
      case '--id': {
        const value = next();
        if (value === undefined) throw new UsageError('--id expects a campaign id');
        args.campaignId = value;
        break;
      }
      case '--spec': {
        const value = next();
        if (value === undefined) throw new UsageError('--spec expects a path');
        args.specPath = value;
        break;
      }
      case '--overseer':
        args.overseer = true;
        break;
      case '--recce': {
        // The same shape a chat's recce block is held to (`parseScoutDirective`): one line, not
        // blank, under the cap. A question the brief cannot carry is refused here rather than
        // rendered into orders that break at the first newline.
        const value = next();
        if (value === undefined || value.trim() === '') {
          throw new UsageError('--recce expects a one-line question');
        }
        if (/[\r\n]/u.test(value)) throw new UsageError('--recce expects one line, no newlines');
        if (value.length > SCOUT_QUESTION_MAX_CHARS) {
          throw new UsageError(
            `--recce: the question is ${String(value.length)} characters; the cap is ` +
              `${String(SCOUT_QUESTION_MAX_CHARS)}`,
          );
        }
        args.recce = value.trim();
        break;
      }
      case '--workstreams': {
        // The concurrency cap, and the one number that decides how much a campaign may spend at
        // once. Refused rather than clamped when it is not a positive integer, for the reason
        // `--attempts` above is: a budget silently corrected to something the user did not type
        // is a budget nobody agreed to.
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1) {
          throw new UsageError('--workstreams expects a positive integer');
        }
        args.maxConcurrentWorkstreams = value;
        break;
      }
      case '--no-init':
        args.init = false;
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
        positional.push(arg);
        break;
    }
  }

  if (!args.help) {
    // Both of these are the FIRST thing a new user can get wrong, and both used to answer with a
    // diagnosis and no example. The shape of the thing being asked for is the fix.
    if (positional.length > 1) {
      throw new UsageError(
        `expected one objective, got ${String(positional.length)}. Quote it: ` +
          `${invokedAs()} campaign "…"`,
      );
    }
    // A spec carries its own objective (`spec.objective`), so `--spec` alone is a complete
    // campaign with zero positional arguments — the "objective is required" refusal only fires
    // when there is neither a positional objective nor a spec to take one from.
    //
    // WHITESPACE-ONLY IS MISSING. `army campaign ""` used to sail past this check — `""` is a
    // positional — and the cost was not cosmetic: a nameless row in the archive, and no objective
    // means no spec, so the Engineer was dispatched at `UNSPECIFIED_BRIEF_EFFORT`, the most
    // expensive possible way to do nothing. Same refusal, same message, same exit code as no
    // argument at all; with `--spec` a blank positional is simply dropped, exactly as an absent
    // one is, and the spec's own objective carries the campaign.
    const objective = positional[0];
    if ((objective === undefined || objective.trim() === '') && args.specPath === undefined) {
      throw new UsageError(
        `an objective is required, e.g. ${invokedAs()} campaign "add a multiply function to calc.js"`,
      );
    }
    if (objective !== undefined && objective.trim() !== '') args.objective = objective;
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const LEVEL_MARK: Record<CampaignNote['level'], string> = { info: '·', warn: '⚠', error: '✗' };

/**
 * @param self  The command prefix to print in front of every suggested next step. Defaults to the
 *   detected invocation. It is a PARAMETER because a test that asserts on `invokedAs()`'s own
 *   output cannot fail: on a machine with `army` installed it reads `army`, on one without it
 *   reads `node …`, and either way the assertion agrees with whatever was produced. Injecting it
 *   is what lets `test/command.test.ts` render with a known prefix and assert that the *hardcoded*
 *   `army` is gone — the standing order to ask "can this test fail?".
 */
export function renderCampaignResult(result: CampaignResult, self: string = invokedAs()): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`campaign ${result.campaignId}  —  ${result.outcome}`);
  lines.push(`  project   ${result.project}`);
  lines.push(`  task      ${result.taskId}`);
  lines.push(`  branch    ${result.branch}`);
  lines.push(
    `  ceiling   ${result.ceiling} (${RUNG_LABEL[result.ceiling]})   requested ${result.requestedRung} (${RUNG_LABEL[result.requestedRung]})`,
  );
  lines.push(
    result.deliveredRung === null
      ? '  delivered nothing'
      : `  delivered rung ${result.deliveredRung} (${RUNG_LABEL[result.deliveredRung]})`,
  );
  if (result.delivery !== null) {
    const durability = result.delivery.durability;
    lines.push(`  durable   ${durability.target.kind} ${durability.target.url}`);
  }
  // The scout, when one was sent. WHOSE WORDS: a found summary is the scout's own (sanitised at
  // capture); an unavailable reason is this process's. The line says which by naming the unit.
  if (result.recce !== null) {
    lines.push(
      result.recce.kind === 'found'
        ? `  recce     ${result.recce.agentId ?? '?'} found: ${result.recce.summary}` +
            (result.recce.haltedForFanOut ? ' (halted at the fan-out ceiling)' : '')
        : `  recce     none — ${result.recce.summary}`,
    );
  }
  // -----------------------------------------------------------------------------------------
  // THE WORKSTREAMS AND THE CAP, on the screen rather than in a config file. A campaign that can
  // grow to several concurrent model sessions should never be a surprise on a bill, so the cap
  // prints beside what it actually bounded. Suppressed for the single-workstream case, where
  // there is nothing to say that "branch" above has not already said, and where printing it
  // would change the screen every existing campaign produces.
  // -----------------------------------------------------------------------------------------
  if (result.workstreams.length > 1) {
    lines.push(
      `  workstreams ${result.workstreams.length}, at most ${result.maxConcurrentWorkstreams} at once`,
    );
    for (const ws of result.workstreams) {
      const overlaps =
        ws.overlaps.length === 0 ? '' : `, ${ws.overlaps.length} overlap(s) announced`;
      lines.push(`    ${ws.id}  ${ws.status}  ${ws.branch}${overlaps}`);
    }
  }
  if (result.integration !== null) {
    lines.push(
      `  integration ${result.integration.branch} — ${result.integration.merged.length} merged, ` +
        `${result.integration.conflicts.length} conflict(s), tree ${result.integration.state}`,
    );
  }
  // -----------------------------------------------------------------------------------------
  // THE ACCEPTANCE GATE, NAMED ON EVERY SCREEN — this is the line the incident on
  // `TechnicalSpec.verify` (`src/contracts/spec.ts`) exists to force into being. An unrun check
  // must never look like a passed one, so this prints even when there is nothing to praise: a
  // spec with no `verify` commands, or no spec at all, says so in as many words rather than
  // leaving the reader to infer "delivered" means "and it was mechanically checked".
  // -----------------------------------------------------------------------------------------
  if (result.acceptance !== null && result.acceptance.ran) {
    if (result.acceptance.passed) {
      lines.push('  acceptance passed — every `verify` command exited 0');
    } else {
      const failed = result.acceptance.outcomes
        .filter((outcome) => !outcome.passed)
        .map((outcome) => outcome.command);
      lines.push(`  acceptance FAILED — ${failed.join(', ')}`);
    }
  } else {
    lines.push(
      '  acceptance not run — no `verify` commands were checked mechanically; nothing above ' +
        'confirms it',
    );
  }
  // Delivered, but the Inspector said so about fewer clauses than the spec had. Not a failure —
  // `not-verified` is the Inspector telling the truth — but a human reading "delivered" has to
  // also be able to read this.
  if (result.unverifiedBehaviours.length > 0) {
    const total = result.verdict?.behaviours?.length ?? result.unverifiedBehaviours.length;
    lines.push(
      `  ${String(result.unverifiedBehaviours.length)} of ${String(total)} behaviours were not ` +
        `verified: ${result.unverifiedBehaviours.join(', ')}`,
    );
  }
  lines.push(`  worktree  ${result.lease.state} — ${result.lease.reason}`);
  lines.push('');

  for (const attempt of result.attempts) {
    // `testsRun` is rendered next to the verdict, and it is not a detail.
    //
    // `Verdict` keeps it as a separate field precisely because "`testsRun: false` with
    // `verdict: 'pass'` is a distinguishable — and suspicious — state that a shared shape would
    // hide". `report.md` and the rung-2 PR body already carried it; the terminal did not, so a
    // pass from a reviewer that never ran anything looked exactly like a tested one on the only
    // screen the user actually reads.
    const verdict =
      attempt.verdict === null
        ? '—'
        : `${attempt.verdict.verdict.toUpperCase()} ${
            attempt.verdict.testsRun
              ? `(tests run${
                  attempt.verdict.testCommand === undefined
                    ? ''
                    : `: ${attempt.verdict.testCommand}`
                })`
              : '(NO TESTS RUN — verdict is from reading only)'
          }`;
    lines.push(
      `  attempt ${String(attempt.attempt)}  ◇ ${attempt.engineerAgentId} (${attempt.engineerStatus})` +
        `  →  ${attempt.inspectorAgentId ?? 'no inspector'} ${verdict}`,
    );
    if (attempt.report !== null) lines.push(`             ${attempt.report.summary}`);
    if (attempt.verdict !== null) lines.push(`             ${attempt.verdict.summary}`);
  }
  if (result.attempts.length > 0) lines.push('');

  for (const note of result.notes) {
    lines.push(`  ${LEVEL_MARK[note.level]} ${note.message}`);
    // The contract from `src/setup/checks.ts`, honoured here: an outcome that blocks owes the
    // exact command that resolves it. Indented under its own note so a screen with several of
    // them still reads as pairs.
    if (note.fix !== undefined) lines.push(`    ${renderFix(note.fix)}`);
  }
  lines.push('');
  lines.push(`  archive   ${result.campaignRoot}`);
  lines.push(`            ${self} view ${result.campaignId}`);
  lines.push('');
  // =============================================================================================
  // WHERE THE SQLITE DURABILITY DISCLOSURE BELONGS
  //
  // It is a true and useful note, and it was printed on EVERY campaign — including one that
  // never leased a worktree, never ran a soldier and archived nothing but its own abort. On that
  // screen it is the longest paragraph and the least relevant thing present, and a paragraph
  // that is noise four times out of five is a paragraph the reader learns to skip on the fifth.
  //
  // The condition is "did this campaign put anything in the index that a power loss could take
  // away, and that `rebuild` would have work to do about". That is exactly one attempt
  // having been recorded: an attempt means agent rows, task rows and a `stream.jsonl` a reader
  // may later cross-check against the index. A campaign with zero attempts wrote its own
  // campaign row and a handful of signals it has just finished narrating on this very screen.
  //
  // It is NOT deleted, and it is not made hard to find: it prints on every campaign that ran a
  // soldier, and `rebuild` — the command a user reaches for when they suspect the index —
  // prints it unconditionally.
  //
  // It takes `self` for the same reason every other line here does: the note's payload is the
  // clause naming the command that reconstructs the index, and that command has to be one the
  // reader can actually type. See `archiveDurabilityNote` for why the constant became a function.
  // =============================================================================================
  if (result.attempts.length > 0) {
    lines.push(`  ${archiveDurabilityNote(self)}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

export interface CampaignCommandDeps {
  stdout?: WriteStream;
  stderr?: WriteStream;
  /** Everything `runCampaign` accepts except the objective, for tests and for the CLI. */
  overrides?: Partial<CampaignOptions>;
  /** The environment the charset is detected from. Defaults to the real one. */
  env?: Record<string, string | undefined>;
  /**
   * Swap `runCampaign` itself. Test seam only — the CLI always uses the real one. Lets a test
   * confirm the CLI skin read `--spec`, validated it and built `options.spec` correctly without
   * paying for a whole campaign against real harnesses, the same reason `overrides.adapters`
   * exists on `runCampaign` itself.
   */
  runCampaignFn?: (options: CampaignOptions) => Promise<CampaignResult>;
}

/**
 * Where the live narration goes, and whether it may touch the cursor.
 *
 * TWO SEPARATE QUESTIONS, and conflating them is how a progress renderer corrupts a pipe:
 *
 * - **Which stream.** `--json` puts a machine-readable document on stdout, so narration goes to
 *   stderr instead. A reader piping the JSON into `jq` still gets the lifecycle on their terminal,
 *   and the document stays parseable — which "print progress to stdout unless quiet" would not.
 * - **Whether it animates.** Cursor control and spinner frames go out only when the chosen stream
 *   is a real terminal. Redirected to a file, the SAME lines are written, plain: silence is not an
 *   improvement on a log, but escape bytes in one are a corruption.
 */
function progressSinkFor(
  args: CampaignArgs,
  stdout: WriteStream,
  stderr: WriteStream,
  self: string,
  env: Record<string, string | undefined>,
): ProgressSink {
  const stream = args.json ? stderr : stdout;
  const isTTY = stream.isTTY === true;
  return createProgressSink({
    stream,
    self,
    live: isTTY,
    charset: detectCharset(env, isTTY, process.platform),
  });
}

/**
 * The `fix:` line a refusal that escaped `runCampaign` owes, or nothing when there is not one.
 *
 * Two conditions reach here, both of them refusals that happen BEFORE a campaign exists to hang a
 * note on: no git repository, and `--id` naming a campaign that already has agents in it. The
 * second one used to come back as an `aborted` result with a note instead of a throw, and it moved
 * here when the archive started refusing it before its first append — a run that writes nothing has
 * no campaign to report a note in.
 *
 * The twin of `fixForChatFailure` in `chat.ts`, deliberately: same two types, same rule that a
 * genuinely undiagnosed throw prints its sentence alone rather than being handed an invented
 * command. Keyed on TYPES so that rewording either message is not a silent regression.
 */
function fixForCampaignFailure(error: unknown): Fix | undefined {
  if (error instanceof CampaignSetupError) return error.fix;
  if (error instanceof AgentIdInUseError) return agentIdInUseFix(error, 'campaign');
  return undefined;
}

export async function campaignCommand(
  argv: readonly string[],
  deps: CampaignCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  // Resolved once, and every command named below is built from it. See `renderCampaignResult`.
  const self = invokedAs();

  let args: CampaignArgs;
  try {
    args = parseCampaignArgs(argv);
  } catch (error) {
    stderr.write(`${self} campaign: ${(error as Error).message}\nTry \`${self} campaign --help\`.\n`);
    return 1;
  }

  if (args.help) {
    stdout.write(CAMPAIGN_HELP);
    return 0;
  }

  // ---- `--spec` ---------------------------------------------------------------------------
  //
  // Read, parsed and validated HERE, before a single soldier is dispatched, and every failure
  // mode below refuses rather than falling back to a free-text campaign. A user who typed
  // `--spec` and silently got the expensive unspecified path — `UNSPECIFIED_BRIEF_EFFORT`, an
  // Engineer making decisions nobody reviewed — has been lied to; the whole value of a spec is
  // that a human approved it before anything spawned.
  let spec: TechnicalSpec | undefined;
  if (args.specPath !== undefined) {
    let raw: string;
    try {
      raw = fs.readFileSync(args.specPath, 'utf8');
    } catch (error) {
      // ENOENT gets its own sentence: the raw errno text ("ENOENT: no such file or directory,
      // open '…'") is a syscall's account of the problem, and every other refusal on this path
      // speaks in the command's own voice. Anything else (permissions, a directory) keeps the
      // system message — there the errno detail IS the diagnosis.
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      stderr.write(
        missing
          ? `${self} campaign: no such file: ${args.specPath}\n`
          : `${self} campaign: could not read --spec ${args.specPath}: ` +
              `${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      stderr.write(
        `${self} campaign: ${args.specPath} is not valid JSON: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    const validated = validateTechnicalSpec(parsed);
    if (!validated.ok) {
      // The validator's OWN sentence, verbatim, plus the path — never paraphrased.
      stderr.write(`${self} campaign: ${args.specPath}: ${validated.reason}\n`);
      return 1;
    }
    spec = validated.spec;
    // A positional objective is optional with `--spec` — the spec carries its own — but if BOTH
    // are given they must agree. Silently preferring one over the other is how a user ends up
    // reviewing a branch built against an objective they did not think they asked for.
    if (args.objective !== '' && args.objective !== spec.objective) {
      stderr.write(
        `${self} campaign: the objective on the command line (${JSON.stringify(args.objective)}) ` +
          `does not match spec.objective in ${args.specPath} (${JSON.stringify(spec.objective)}). ` +
          'Pass one or the other.\n',
      );
      return 1;
    }
    args.objective = spec.objective;
  }

  const sink = progressSinkFor(args, stdout, stderr, self, deps.env ?? process.env);

  const options: CampaignOptions = {
    objective: args.objective,
    onProgress: sink.emit,
    // The CLI owns this process and its terminal, so Ctrl-C here must settle the campaign —
    // kill the soldier tree, mark the archive, release the lease — rather than orphan a
    // `dontAsk` worker. Embedders (chat) drive `runCampaign` directly and keep the default off.
    handleSignals: true,
    ...(spec === undefined ? {} : { spec }),
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    ...(args.requestedRung === undefined ? {} : { requestedRung: args.requestedRung }),
    ...(args.maxAttempts === undefined ? {} : { maxAttempts: args.maxAttempts }),
    ...(args.provider === undefined ? {} : { worktreeProvider: args.provider }),
    ...(args.overseer === true ? { overseer: true } : {}),
    ...(args.maxConcurrentWorkstreams === undefined
      ? {}
      : { maxConcurrentWorkstreams: args.maxConcurrentWorkstreams }),
    ...(args.recce === undefined ? {} : { recce: args.recce }),
    ...(args.campaignId === undefined ? {} : { campaignId: args.campaignId }),
    ...(args.init ? {} : { init: false }),
    // Spread LAST, so a caller that wants its own listener — or none — wins over the default.
    ...deps.overrides,
  };

  let result: CampaignResult;
  try {
    const run = deps.runCampaignFn ?? runCampaign;
    result = await run(options);
  } catch (error) {
    // Before the report, and before the error line: the ticker owns the cursor's line, and an
    // error printed over a half-drawn spinner frame is an error the reader cannot read.
    sink.close();
    stderr.write(`${self} campaign: ${error instanceof Error ? error.message : String(error)}\n`);
    // The refusals that happen before there is a campaign to hang a note on. Keyed on the error
    // TYPE, never on the words, exactly as `chatCommand` does it — this is the same pair of
    // conditions and it must not be the path where a bare sentence escapes.
    const fix = fixForCampaignFailure(error);
    if (fix !== undefined) stderr.write(`  ${renderFix(fix)}\n`);
    return 1;
  }
  sink.close();

  if (args.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(renderCampaignResult(result, self));
  }
  return result.exitCode;
}
