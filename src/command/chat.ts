/**
 * `army chat` — argument parsing, help, exit codes.
 *
 * The conversation is in `src/chat/run.ts`; this file is the CLI skin over it. Keeping them apart
 * is what lets `test/chat.test.ts` drive whole sessions — including the interrupt and the refused
 * dispatch — by calling `runChat` with a scripted terminal, with no argv, no TTY and no process
 * to inspect.
 */

import * as path from 'node:path';

import { RUNGS } from '../contracts/delivery.ts';
import type { Rung } from '../contracts/delivery.ts';
import { WORKTREE_PROVIDER_IDS } from '../contracts/worktree.ts';
import type { WorktreeProviderId } from '../contracts/worktree.ts';
import { AgentIdInUseError } from '../archive/archive.ts';
import { CampaignSetupError, agentIdInUseFix } from './campaign.ts';
import type { WriteStream } from './campaign.ts';
import type { Fix } from '../setup/fixes.ts';
import { createTerminalIo } from '../chat/io.ts';
import { runChat } from '../chat/run.ts';
import type { ChatOptions } from '../chat/run.ts';
import { invokedAs } from '../setup/checks.ts';
import { renderFix } from '../setup/fixes.ts';

/**
 * Every line naming a command to TYPE goes through `invokedAs()`. The title line does not: there,
 * `army chat` is the name of the command rather than an instruction to run it — the same
 * convention the rest of the CLI uses, and the repo-wide guard encodes it.
 */
export const CHAT_HELP = `
army chat — a live session with a commanding officer

  A COL·COMMANDER (claude) holds one persistent duplex session. Its whole loadout
  is TodoWrite — no Read, no Grep, no Edit, no Bash, no network — and one inert
  tool rather than none, because an emptied allow-list is the most permissive
  spec this can emit: it drops --allowedTools and inherits every tool there is.
  What the commander holds is a permission set, not a
  request — it is what keeps the window that holds your objective from being
  spent one source file at a time.

  When it needs to know something neither of you can answer from memory, it
  proposes a CPT·SCOUT: a reader that holds Read, Grep, Glob and the web, writes
  nothing, and holds no worktree, because a lease exists to isolate changes and a
  scout makes none. It has its own [y/N]. It may field a few subordinates inside
  its own process and no deeper; that count is measured off its event stream and
  crossing it stops the recce. What it found is carried into the plan of anything
  dispatched afterwards.

  When something needs changing it proposes a one-line objective. You approve it,
  and a CPT·ENGINEER is raised in a leased worktree, reviewed by an independent
  CPT·INSPECTOR briefed from that objective and the branch — never from the
  Engineer's account of what it did — and delivered up to the project ceiling.
  It is the same gate \`${invokedAs()} campaign\` runs, because it is the same code.

  Between the two sits the alignment gate, and it is mechanical rather than a
  judgement. A dispatch that carries a spec begins phase 2 only when every
  required field is answered, every verification command EXECUTES against the
  base commit, and you confirm with a keystroke — in that order, with the
  keystroke last, because it confirms a gate that already passed. A command that
  runs and FAILS passes: a red test is where work starts, and its reading is
  banked so nothing can argue later that a failure was already there. A command a
  shell cannot execute, one that returns no result, or one still running at the
  deadline does not pass, and no keystroke is offered. The settled spec and the
  whole interrogation are written to the campaign archive; \`planning.spec_to_repo\`
  in config.toml also writes them into the repository, and is off by default
  because a rejected branch should not strand design documents in your checkout.

  Chat needs no setup first. On the way in it creates ~/.agentic-army and the
  default config where they are missing, turns a bare directory into a git
  repository, and registers the project at ceiling 0, the fail-closed default
  an unregistered project already has. Nothing it creates widens authority;
  raising a ceiling still takes \`${invokedAs()} enlist --ceiling N\` from a terminal.

USAGE
  ${invokedAs()} chat [options]

OPTIONS
  --rung <0|1|2>       Highest rung any dispatch may attempt. Clamped by the
                       project ceiling, never raised by this flag. Default 2.
  --attempts <n>       Engineer attempts per dispatch, including the first.
                       Default 3.
  --cwd <dir>          Project to talk about. Default: this directory.
  --model <id>         Model for the commander. Frontier reasoning belongs at
                       the top; the units below it are dispatched by role.
  --provider <id>      Worktree provider for anything dispatched.
  --id <campaign-id>   Override the generated archive id for the conversation.
  --overseer           Put a MAJ·OVERSEER over each dispatch: it segments the feature into
                       workstreams and runs an Engineer on each, concurrently. Off by
                       default, because an overseer is a whole model session spent before any
                       engineer starts, and a two-line objective does not need one.
  --concurrency <n>    How many workstreams run at once, with an overseer. This is the whole
                       of the budget control on fan-out, and the status block shows it next
                       to the agent count from the first spawn.
  --no-init            Outside a repository, refuse instead of running the
                       auto-init \`${invokedAs()} enlist\` runs: git init plus one empty
                       commit, never in your home directory or a filesystem root.
  --plain              No status block pinned under the prompt. The boxed header
                       still prints, because it is ordinary output; the block is
                       painted with cursor movement, so this is the escape hatch
                       for a terminal that reports itself as one and does not
                       honour it — an editor's embedded console, a CI runner with
                       a PTY. Off a terminal it is already the default.
  -h, --help           This.

IN THE SESSION
  \\ then Enter         Continue on the next line; the whole entry submits as one
                       message. A trailing \\\\ submits a literal backslash.
  Ctrl-C               Stop the answer in flight. The session survives it — the
                       interrupt is a stdin message, not a signal. Again to leave.
                       With a continued entry open, it discards the draft instead.
  Ctrl-D, /exit        Leave.
  /status              The header again, with the working copy re-read.
  /work <id>           One agent or workstream, printed into scrollback: its orders,
                       its branch, its last activity, its diffstat. It prints rather
                       than opens, because a pager needs an alternate screen this
                       interface deliberately does not use.
  /stop                End the running campaign. It confirms first, because every
                       worktree in flight has to be settled rather than dropped.
                       Ctrl-C never means this: it stops the answer in flight.
  /next                With several questions open, move to the next one.
  /help                The same, from inside.

WHILE A DISPATCH RUNS
  The prompt is still yours. A worker's question arrives as a block in scrollback
  under its own marker, naming the agent and the workstream that raised it, and
  the count of what is open sits on the status block. Nothing seizes what you were
  typing. With one question open, typing answers it and the prompt says so; with
  several, the prompt names the one you are answering. /stop, /work, /next and
  /help answer there and then. Anything else (/status, /exit, a sentence for the
  Commander) is queued and runs the moment the dispatch settles.

WHAT THE STATUS BLOCK SAYS
  Pinned under the prompt, repainted in place: the branch you are on and whether
  it is dirty, the project, the commander's model, the rung a dispatch will ask
  for, what the session has spent and, while a dispatch runs, the campaign's
  live tree, read from its archive and drawn by the same renderer \`${invokedAs()} view\`
  uses, plus how many agents are up against the concurrency cap. When the tree is
  taller than the block is allowed, running units are kept over finished ones and
  one row accounts for what was dropped. It steps aside while an answer streams,
  where the spinner on the answer's own line is already saying the same thing.

WHAT PERSISTS
  Every turn is a signal row and every event is a line in stream.jsonl, written
  as it happens — so a crash loses the turn in flight and nothing before it.
  \`${invokedAs()} view <id>\` reads the conversation back. Anything dispatched gets its
  own campaign in the archive, linked from the conversation's signals.

WHO CAN START WORK
  You. The commander proposes and you confirm, every time. That is the only
  mechanism that actually holds: a subordinate's report enters the commander's
  context, and no amount of framing stops a model being persuaded by what it
  reads there. What a keystroke stops is any of it turning into a process.
`;

class UsageError extends Error {}

/**
 * The `fix:` line a failed session owes, or nothing when there genuinely is not one.
 *
 * Only `CampaignSetupError` used to be recognised here, which meant `chat --id <existing>` — the
 * commander colliding on its own agent id, the exact same condition `campaign` diagnoses — printed
 * a full diagnosis with NO `fix:` line under it at all. Same defect as `campaign`'s catch-all,
 * in its silent form rather than its false-`none` form: the error arrives carrying everything
 * needed to answer, and the printing layer threw the answer away because it only knew one type.
 *
 * Keyed on the exported error types, never on the message text, and a genuinely undiagnosed throw
 * still prints its sentence alone rather than being handed an invented command.
 */
function fixForChatFailure(error: unknown): Fix | undefined {
  if (error instanceof CampaignSetupError) return error.fix;
  if (error instanceof AgentIdInUseError) return agentIdInUseFix(error, 'chat');
  return undefined;
}

export interface ChatArgs {
  requestedRung?: Rung;
  maxAttempts?: number;
  cwd?: string;
  model?: string;
  provider?: WorktreeProviderId;
  campaignId?: string;
  /** True when `--overseer` was passed. Segments a dispatch into concurrent workstreams. */
  overseer?: boolean;
  /** `--concurrency <n>`. Only in force with an overseer; the status block shows what is. */
  maxConcurrentWorkstreams?: number;
  /** False when `--no-init` was passed — mirrors `enlist`, which grew the flag first. */
  init: boolean;
  /** False when `--plain` was passed. Never true off a terminal — `runChat` clamps it. */
  chrome: boolean;
  help: boolean;
}

function asRung(raw: string | undefined): Rung {
  const value = Number(raw);
  if (!Number.isInteger(value) || !(RUNGS as readonly number[]).includes(value)) {
    throw new UsageError(`--rung expects one of ${RUNGS.join(', ')}, got ${JSON.stringify(raw ?? '')}`);
  }
  return value as Rung;
}

export function parseChatArgs(argv: readonly string[]): ChatArgs {
  const args: ChatArgs = { init: true, chrome: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
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
      case '--model': {
        const value = next();
        if (value === undefined || value === '') throw new UsageError('--model expects a model id');
        args.model = value;
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
      case '--overseer':
        args.overseer = true;
        break;
      case '--concurrency': {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1) {
          throw new UsageError('--concurrency expects a positive integer');
        }
        args.maxConcurrentWorkstreams = value;
        break;
      }
      case '--no-init':
        args.init = false;
        break;
      case '--plain':
        args.chrome = false;
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
        // A chat takes no objective — that is the difference between it and a campaign, and a
        // reader who typed one has a specific wrong model of the command rather than a typo.
        throw new UsageError(
          `chat takes no objective — the conversation is the objective. Did you mean ` +
            `${invokedAs()} campaign ${JSON.stringify(arg)}?`,
        );
    }
  }
  return args;
}

export interface ChatCommandDeps {
  stdout?: WriteStream;
  stderr?: WriteStream;
  /** Everything `runChat` accepts, for tests and for the CLI. `io` overrides the real terminal. */
  overrides?: Partial<ChatOptions>;
}

export async function chatCommand(
  argv: readonly string[],
  deps: ChatCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const self = invokedAs();

  let args: ChatArgs;
  try {
    args = parseChatArgs(argv);
  } catch (error) {
    stderr.write(`${self} chat: ${(error as Error).message}\nTry \`${self} chat --help\`.\n`);
    return 1;
  }

  if (args.help) {
    stdout.write(CHAT_HELP);
    return 0;
  }

  const overrides = deps.overrides ?? {};
  // Built only when nobody injected one, so a test never touches stdin, stdout or a signal
  // handler by accident.
  const io = overrides.io ?? createTerminalIo();
  const options: ChatOptions = {
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    ...(args.requestedRung === undefined ? {} : { requestedRung: args.requestedRung }),
    ...(args.maxAttempts === undefined ? {} : { maxAttempts: args.maxAttempts }),
    ...(args.provider === undefined ? {} : { worktreeProvider: args.provider }),
    ...(args.campaignId === undefined ? {} : { campaignId: args.campaignId }),
    ...(args.overseer === undefined ? {} : { overseer: args.overseer }),
    ...(args.maxConcurrentWorkstreams === undefined
      ? {}
      : { maxConcurrentWorkstreams: args.maxConcurrentWorkstreams }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.init ? {} : { init: false }),
    ...(args.chrome ? {} : { chrome: false }),
    ...overrides,
    io,
  };

  try {
    const result = await runChat(options);
    return result.exitCode;
  } catch (error) {
    stderr.write(`${self} chat: ${error instanceof Error ? error.message : String(error)}\n`);
    const fix = fixForChatFailure(error);
    if (fix !== undefined) stderr.write(`  ${renderFix(fix)}\n`);
    return 1;
  } finally {
    io.close();
  }
}
