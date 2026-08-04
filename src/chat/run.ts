/**
 * `army chat` — the conversation loop.
 *
 * ```
 * you ›  the auth middleware feels wrong to me
 * ◆      it would, if it re-reads the session on every request. I cannot see the
 *        file. Shall I put an Engineer on it?
 *
 *        ```army-dispatch
 *        {"objective": "make the auth middleware read the session once per request"}
 *        ```
 *
 *   ◇ dispatch this? [y/N] y
 *   ◇ dispatching — Engineer, then an independent Inspector.
 * ☆ campaign 2026-08-04-make-the-auth-middleware · make the auth middleware read …
 *   · worktree leased (cold) → …/trees/app-1f2e/wt-01
 *   ◇ CPT·ENGINEER · cpt-01 dispatched (claude, attempt 1)
 *   ⠹ CPT·ENGINEER · cpt-01 working 47s
 *   ◇ CPT·INSPECTOR · cpt-02 → PASS – the session is read once and cached per request
 *   · worktree released → …/trees/app-1f2e/wt-01 – work is durable
 *   · delivered — branch army/t-1 — rung 0 (commit)
 *
 * ◆      passed on the first attempt, rung 0, branch army/t-1.
 * ```
 *
 * Five things this file is responsible for, in descending order of how badly it hurts to get
 * them wrong.
 *
 * 1. **NOTHING IS DISPATCHED WITHOUT A KEYSTROKE.** The commander proposes; a human approves.
 *    This is the layer that actually holds, and it is worth being precise about why the two
 *    layers under it do not, on their own:
 *
 *    - The turn-authority gate in `session.ts` stops a subordinate's report from being ANSWERED
 *      with a dispatch. It does not stop the report's text from being read back later: ask the
 *      commander "what did that last report say?" and a forged dispatch block inside the summary
 *      could be quoted back on a turn that DOES carry human authority.
 *    - The envelope encoding in `protocol.ts` stops a summary from impersonating the framing. It
 *      does not stop a model from being persuaded by a string that is honestly labelled as a
 *      subordinate's.
 *
 *    Neither is wasted — the first makes the direct route impossible and audible, the second
 *    removes the confusion that makes persuasion easy. But the property the brief actually needs
 *    is *the human's typed input is the only source of new intent*, and the only mechanism that
 *    delivers it is a human typing. So the objective is printed in full, on one line, and the
 *    dispatch runs if and only if the next line read from the terminal says yes.
 *
 * 2. **The commander never holds a tool.** The spec goes through `buildSoldierSpec`, the same
 *    choke point every campaign worker goes through, so the protected-config deny is asserted on
 *    it and `assertCommanderLoadout` refuses a widened allow-list.
 *
 * 3. **Ctrl-C stops the answer, not the conversation.** And a dispatch in flight is never
 *    abandoned: it holds a worktree lease, and only its own cleanup can settle one.
 *
 * 4. **Everything persists as it happens.** Each turn is a signal row and each event is a line in
 *    `stream.jsonl` before the next turn starts, so a crash loses the turn in flight and nothing
 *    before it.
 *
 * 5. **A dispatch is never silent.** It is `runCampaign`, it takes minutes, and this window is the
 *    only place a human is blocked on it. The lifecycle arrives through `src/view/progress.ts` —
 *    the same renderer and the same vocabulary the campaign command narrates with, because a
 *    second spelling of "the Engineer is working" is a second thing to change. Narration is
 *    strictly subordinate to (3): every emission is guarded, because a listener writing to a
 *    closed pipe must never be the reason a lease goes unsettled.
 */

import * as path from 'node:path';

import { CampaignArchive, campaignIdFor, createCampaign, listCampaignIds } from '../archive/archive.ts';
import type { ArchiveConfig } from '../archive/archive.ts';
import { GENERAL_AGENT_ID, buildSoldierSpec, resolveProjectRoot } from '../command/campaign.ts';
import { CampaignSetupError } from '../command/campaign.ts';
import type { CampaignResult } from '../command/campaign.ts';
import { loadConfig } from '../config/load.ts';
import { armyHome } from '../config/paths.ts';
import type { Env } from '../config/paths.ts';
import { RUNG_LABEL, effectiveRung } from '../contracts/delivery.ts';
import type { Rung } from '../contracts/delivery.ts';
import type { HarnessAdapter, HarnessId, SoldierEvent } from '../contracts/harness.ts';
import { codePointLength } from '../contracts/report.ts';
import type { WorktreeProviderId } from '../contracts/worktree.ts';
import type { DeliveryConfig } from '../delivery/ladder.ts';
import { projectCeiling } from '../delivery/ladder.ts';
import type { GhStatus } from '../delivery/git.ts';
import { createClaudeAdapter } from '../harness/claude.ts';
import { invokedAs } from '../setup/checks.ts';
import { initRepoFix } from '../setup/fixes.ts';
import { detectCharset } from '../view/index.ts';
import type { Charset } from '../view/render.ts';
import { createProgressSink, renderProgressEvent } from '../view/progress.ts';
import type { ProgressListener, ProgressStyle } from '../view/progress.ts';

import { factsFrom, guardedProgress, runDispatch } from './dispatch.ts';
import type { ChatIo } from './io.ts';
import { renderStandingOrders } from './orders.ts';
import type { DispatchRequest } from './protocol.ts';
import { ChatSession } from './session.ts';

// ---------------------------------------------------------------------------------------------
// Options and result
// ---------------------------------------------------------------------------------------------

export interface ChatOptions {
  /** The terminal, or a script standing in for one. Required — this module owns no globals. */
  io: ChatIo;
  cwd?: string;
  /** Commander's own environment. NEVER accept `AGENTIC_ARMY_HOME` from a worker. */
  env?: Env;
  /** Override the army home. Test seam; production reads `env`. */
  home?: string;
  /** Highest rung any dispatch may attempt, before the project ceiling clamps it. Default 2. */
  requestedRung?: Rung;
  /** Engineer attempts per dispatch, including the first. Default 3. */
  maxAttempts?: number;
  campaignId?: string;
  worktreeProvider?: WorktreeProviderId;
  worktreeRoot?: string;
  /** The commander's own binary. Separate from `claudeBin` so a test can drive the two roles. */
  commanderBin?: string;
  /** Full adapter override for the commander. */
  commanderAdapter?: HarnessAdapter;
  /** Binaries for the units a dispatch raises. */
  claudeBin?: string;
  codexBin?: string;
  adapters?: Partial<Record<HarnessId, HarnessAdapter>>;
  ghProbe?: () => Promise<GhStatus>;
  dbFactory?: ArchiveConfig['dbFactory'];
  now?: () => string;
  timeoutMs?: number;
  /** Model and effort for the commander. Frontier reasoning belongs at the top. */
  model?: string;
  /**
   * Glyph set for the dispatch narration. Detected from `env` and the terminal when absent.
   *
   * An override rather than a preference: a test that asserts on `CPT·ENGINEER` must not depend
   * on the locale of the machine running it, and `detectCharset` reads three environment
   * variables and the platform to decide.
   */
  charset?: Charset;
}

export interface ChatDispatchRecord {
  objective: string;
  approved: boolean;
  campaignId: string | null;
  outcome: string | null;
  verdict: 'pass' | 'fail' | null;
  deliveredRung: Rung | null;
}

export const CHAT_EXIT_REASONS = ['eof', 'interrupt', 'command', 'commander-ended'] as const;
export type ChatExitReason = (typeof CHAT_EXIT_REASONS)[number];

export interface ChatResult {
  campaignId: string;
  campaignRoot: string;
  project: string;
  ceiling: Rung;
  /** Already clamped by the ceiling — what this session will actually ask for. */
  requestedRung: Rung;
  /** Human turns. The opening standing-orders turn is not one. */
  turns: number;
  dispatches: ChatDispatchRecord[];
  /** Every dispatch block that was parsed and not honoured, with the reason. */
  refusals: string[];
  exitReason: ChatExitReason;
  costUsd: number | null;
  exitCode: number;
}

const DEFAULT_REQUESTED_RUNG: Rung = 2;
const DEFAULT_MAX_ATTEMPTS = 3;

/** The commander's agent id. A COLONEL: the human is the GENERAL, and rank must be junior. */
export const COMMANDER_AGENT_ID = 'col-01';

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Flatten and cap, in code points — signal bodies are capped and the archive is not a log. */
function cap(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return codePointLength(flat) <= max ? flat : `${[...flat].slice(0, max - 1).join('')}…`;
}

/** A campaign id that is not already taken, so two chats on one day cannot share a directory. */
function uniqueCampaignId(archiveRoot: string, title: string): string {
  const base = campaignIdFor(title);
  const taken = new Set(listCampaignIds(archiveRoot).map((id) => id.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${String(Date.now())}`;
}

const PROMPT = '\nyou › ';
const CONFIRM_PROMPT = '  ◇ dispatch this? [y/N] ';

/** `y` / `yes`, and nothing else. Anything ambiguous is a no — the default must be the safe one. */
export function isApproval(line: string): boolean {
  const answer = line.trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

export function chatBanner(self: string, project: string, ceiling: Rung, rung: Rung): string {
  return [
    '',
    '◆ COL·COMMANDER — a live session. It holds the objective; it holds no tools.',
    `  project   ${project}`,
    `  ceiling   ${String(ceiling)} (${RUNG_LABEL[ceiling]})   dispatches ask for at most ${String(rung)} (${RUNG_LABEL[rung]})`,
    '  Ctrl-C stops the answer. Again to leave. /exit leaves too.',
    `  Anything it dispatches is reviewed by an independent Inspector — ${self} view <id> reads it back.`,
    '',
  ].join('\n');
}

/**
 * What is left to say once the dispatch has narrated itself.
 *
 * This function used to spell the attempt line itself — `◇ cpt-01 ENGINEER (done) → cpt-02 PASS`
 * — because at the time nothing else in the process could. That is no longer true: the same
 * moments now arrive on this terminal live, from `runCampaign`, through `renderProgressEvent`,
 * with strictly more in them (the harness, the attempt number, both model summaries). A second
 * spelling of "the Engineer is working" would now be a re-print of a line already on screen AND a
 * second place to change when the vocabulary moves, so the loop is gone rather than reformatted.
 *
 * Every line that remains still goes through `renderProgressEvent`, so this file holds no glyph
 * table and no severity marks of its own. What remains is what the narration does NOT carry:
 *
 * - `result.branch`, which is `armyBranch(taskId)` — the supervisor's own name for the work. The
 *   only branch a reader saw during narration came out of the Engineer's model-written summary.
 * - the archive path, which is where the whole thing can be read back.
 * - error notes, which are re-stated deliberately. Notes raised BEFORE the campaign opened are
 *   never narrated at all, and the ones that were are ten lines up by now.
 */
function renderDispatchOutcome(result: CampaignResult, style: ProgressStyle): string {
  const lines: string[] = [];
  for (const note of result.notes) {
    if (note.level === 'error') {
      lines.push(renderProgressEvent({ kind: 'note', level: 'error', message: note.message }, style));
    }
  }
  const delivered =
    result.deliveredRung === null
      ? 'delivered nothing'
      : `rung ${String(result.deliveredRung)} (${RUNG_LABEL[result.deliveredRung]})`;
  lines.push(
    renderProgressEvent(
      { kind: 'note', level: 'info', message: `${result.outcome} — branch ${result.branch} — ${delivered}` },
      style,
    ),
  );
  lines.push(
    renderProgressEvent(
      { kind: 'note', level: 'info', message: `archive ${result.campaignRoot}` },
      style,
    ),
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------------------------

export async function runChat(options: ChatOptions): Promise<ChatResult> {
  const io = options.io;
  const env: Env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const home = options.home ?? armyHome(env);
  const self = invokedAs();
  const charset: Charset = options.charset ?? detectCharset(env, io.isTTY, process.platform);
  /** Shared by the live narration and the close-out, so the two cannot spell a unit differently. */
  const progressStyle: ProgressStyle = { self, charset };

  const project = await resolveProjectRoot(cwd);
  if (project === null) {
    throw new CampaignSetupError(
      `${cwd} is not inside a git repository. A commander needs a repository to send anyone into.`,
      initRepoFix(cwd),
    );
  }

  const loaded = await loadConfig({ home, env });
  const config = loaded.config;
  const ceiling = projectCeiling(config as DeliveryConfig, project).ceiling;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  // Clamped HERE as well as inside the ladder, because the number is printed to the human and
  // read by the commander. Telling both of them a rung the project will refuse is how a session
  // spends an hour planning delivery that was never going to happen.
  const requestedRung = effectiveRung(options.requestedRung ?? DEFAULT_REQUESTED_RUNG, ceiling);

  const archiveRoot = config.archiveRoot;
  const campaignId = options.campaignId ?? uniqueCampaignId(archiveRoot, 'chat');
  const archiveConfig: ArchiveConfig = {
    archiveRoot,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.dbFactory === undefined ? {} : { dbFactory: options.dbFactory }),
  };
  const archive: CampaignArchive = createCampaign(archiveConfig, {
    id: campaignId,
    project,
    title: `chat in ${path.basename(project)}`,
  });
  const task = archive.createTask({ title: 'the conversation', status: 'in_flight' });

  const standingOrders = renderStandingOrders({ project, ceiling, requestedRung, maxAttempts });

  // The same choke point every campaign worker goes through. `assertGlobalDenyIntact` and
  // `assertCommanderLoadout` both run in here, so a commander with a widened loadout does not
  // start — it throws, before a process exists.
  const spec = buildSoldierSpec({
    agentId: COMMANDER_AGENT_ID,
    rank: 'COLONEL',
    role: 'COMMANDER',
    harness: 'claude',
    ...(options.model === undefined ? {} : { model: options.model }),
    cwd: project,
    orders: standingOrders,
    home,
  });

  archive.recordAgentAttempt({
    id: COMMANDER_AGENT_ID,
    taskId: task.id,
    parentAgentId: null,
    rank: 'COLONEL',
    role: 'COMMANDER',
    harness: 'claude',
    model: spec.model ?? null,
    effort: spec.effort ?? null,
    sessionId: spec.sessionId,
    depth: 1,
    status: 'running',
    worktreePath: null,
    leaseId: null,
    orders: standingOrders,
    attempt: 1,
  });
  archive.appendSignal({
    fromAgent: GENERAL_AGENT_ID,
    toAgent: COMMANDER_AGENT_ID,
    kind: 'order',
    body: cap(`chat opened in ${project}`),
    artifact: `agents/${COMMANDER_AGENT_ID}/orders.md`,
  });
  for (const warning of loaded.warnings) {
    archive.appendSignal({ fromAgent: GENERAL_AGENT_ID, kind: 'status', body: cap(`config: ${warning}`) });
  }

  /**
   * The commander streams at TOKEN level. This is the one caller in the tree that opts in.
   *
   * `--include-partial-messages` is off by default in `createClaudeAdapter` because a campaign
   * soldier gains nothing from it and pays for it in archive rows. A conversation is the opposite
   * case, and it is the whole difference between the two commands: a human is sitting in front of
   * this one with nothing to read until the turn ends. Without the flag the reply lands as one
   * lump after a long silence; with it, text arrives continuously from the first token.
   *
   * The registry entry (`getAdapter('claude')`) cannot be used for the default branch any more,
   * because it is the shared, un-opted-in adapter — so both branches are built here and differ
   * only in whether a binary was injected. `ARMY_CLAUDE_BIN` is still honoured underneath.
   *
   * NOTHING ELSE IS OPTED IN, and specifically not `runCampaign`: a dispatch raised from this
   * session builds its own adapters through `campaign.ts`, which does not pass this flag. The
   * `ARMY_CLAUDE_PARTIAL=1` environment switch would have been one line here, but it is global —
   * it would opt every campaign soldier in too, which is the change this is deliberately not.
   *
   * No reconciliation logic lives here, and none may: the normalizer accumulates deltas per
   * content-block index and suppresses the aggregate only on a byte-identical match, so a
   * consumer sees every piece of text exactly once whether the flag is on or off.
   */
  const commanderAdapter =
    options.commanderAdapter ??
    createClaudeAdapter({
      partialMessages: true,
      ...(options.commanderBin === undefined ? {} : { bin: options.commanderBin }),
    });

  const appendEvent = (event: SoldierEvent): void => {
    archive.appendEvent(COMMANDER_AGENT_ID, event);
  };

  const session = new ChatSession({
    adapter: commanderAdapter,
    spec,
    onText: (chunk) => {
      io.write(chunk);
    },
    onEvent: appendEvent,
  });

  // ---- session state the interrupt handler reads ------------------------------------------
  let exitRequested = false;
  let exitReason: ChatExitReason = 'eof';
  /** True while a dispatch campaign is running. A campaign holds a lease; only it may settle one. */
  let dispatchInFlight = false;
  /** Armed by the first Ctrl-C; the second one leaves. Reset whenever the human speaks again. */
  let exitArmed = false;
  let interruptBusy = false;
  /**
   * Where a dispatch narrates. Rebuilt for each dispatch and dropped after it.
   *
   * Held out here because the interrupt handler writes through it too, and that handler fires
   * from a detached promise while the lease is held: an exception escaping it is an unhandled
   * rejection, not a caught error. `guardedProgress` is what makes this sink safe to call from
   * there. It is not the only emission in this file that needs that treatment — EVERY emission
   * the interrupt handler makes does, on whichever branch — and the other three go through
   * `guardedWrite` for the same reason. See the block above it.
   *
   * A no-op between dispatches, which is also the right answer: the ticker and the lifecycle
   * vocabulary belong to the minutes a campaign owns, not to the conversation around them.
   */
  let narrate: ProgressListener = () => {};

  const dispatches: ChatDispatchRecord[] = [];
  const refusals: string[] = [];
  let humanTurns = 0;

  /**
   * `io.write` for the interrupt handler, and only for it.
   *
   * The handler runs inside `void (async () => …)()`. There is nothing on the other end of that
   * promise, so an exception raised anywhere in it is an UNHANDLED REJECTION — which Node treats
   * as fatal — and not a caught error. `io.write` throws EPIPE the moment the reader goes away,
   * and `army chat < script | head` is enough to arrange that, so every branch of this handler
   * that emits is one closed pipe away from killing the process.
   *
   * The claim that made the other three branches look safe was that they only fire when no
   * dispatch is in flight, so no lease can be stranded. That claim does not hold, and the hole is
   * `await session.interrupt()`. The `dispatchInFlight` check runs synchronously, before the
   * await; the write runs after it. In between, the interrupted turn resolves and the main loop
   * runs on — and with piped stdin the approval line is ALREADY BUFFERED, so `io.nextLine`
   * resolves without waiting for anybody and `runDispatch` can be holding a real worktree lease
   * by the time the write finally happens. `test/chat.test.ts` drives exactly that interleaving.
   * So this is the same guarantee `guardedProgress` gives the narration path, for the same
   * reason, and it is load-bearing on all three.
   *
   * Even where the reasoning DID hold, a crash here is still the wrong exit: it skips the
   * `finally` that closes the commander's session and writes the archive's final row, so a closed
   * pipe would leave a live subprocess and a campaign row that never says how it ended.
   */
  const guardedWrite = (text: string): void => {
    try {
      io.write(text);
    } catch {
      /* the reader is gone; that is never a reason to take the process with it */
    }
  };

  const onInterrupt = (): void => {
    if (interruptBusy) return;
    interruptBusy = true;
    void (async (): Promise<void> => {
      try {
        if (dispatchInFlight) {
          // Killing here leaks a worktree lease: the pool slot is held by a process that is no
          // longer coming back, and the branch inside it has not been made durable yet. The
          // campaign's own cleanup is the only thing that settles a lease, so it is allowed to
          // finish. Leaking a tree is recoverable; a half-torn-down one is not.
          //
          // Through the narration sink, not `io.write`: this line lands in the middle of the
          // dispatch's own lifecycle lines and is a warning about it, so it is marked the way
          // every other warning in that stretch is marked — and, on a terminal, it stops the
          // elapsed ticker rather than being painted over by the next frame.
          narrate({
            kind: 'note',
            level: 'warn',
            message:
              'a dispatch is in flight and holds a worktree lease. Letting it settle — ' +
              'interrupting here would strand the tree and the branch inside it.',
          });
          return;
        }
        if (session.busy) {
          const stopped = await session.interrupt();
          // Arm BEFORE emitting, so this branch is correct on its own rather than because of the
          // line above it. With the write unguarded AND the assignment after it, a closed pipe
          // left `exitArmed` false and the user's next Ctrl-C re-armed instead of leaving — three
          // keystrokes to get out of a session that promises two. `guardedWrite` already stops
          // that, since a caught write cannot skip what follows it; this is belt and braces and
          // is not independently observable while the guard holds. It is here because state a
          // later keystroke reads should not sit downstream of an emission at all.
          exitArmed = true;
          guardedWrite(
            stopped
              ? '\n  ^C  turn stopped. The session is still up — Ctrl-C again to leave.\n'
              : '\n  ^C  the commander would not stop; waiting for this turn. Ctrl-C again to leave.\n',
          );
          return;
        }
        if (exitArmed) {
          exitRequested = true;
          exitReason = 'interrupt';
          guardedWrite('\n  leaving.\n');
          // Unguarded on purpose: `abortLine` is the thing that actually ends the session, by
          // unblocking the read the loop is parked on. It is a queue operation with no stream
          // under it, and if it ever did throw, swallowing it would park the session forever on a
          // read nobody will answer — a hang with no message, which is worse than a stack trace.
          // What matters is that it is no longer downstream of a write that can throw.
          io.abortLine();
          return;
        }
        exitArmed = true;
        guardedWrite('\n  ^C  (again to leave, or /exit)\n');
      } finally {
        interruptBusy = false;
      }
    })();
  };
  const unsubscribe = io.onInterrupt(onInterrupt);

  const recordCommanderTurn = (text: string, turnRefusals: readonly string[]): void => {
    archive.appendSignal({
      fromAgent: COMMANDER_AGENT_ID,
      toAgent: GENERAL_AGENT_ID,
      kind: 'report',
      body: cap(text === '' ? '(no reply)' : text),
    });
    for (const refusal of turnRefusals) {
      refusals.push(refusal);
      archive.appendSignal({
        fromAgent: COMMANDER_AGENT_ID,
        toAgent: GENERAL_AGENT_ID,
        kind: 'status',
        body: cap(`dispatch refused: ${refusal}`),
      });
      io.write(`\n  ⚠ ${refusal}\n`);
    }
  };

  io.write(chatBanner(self, project, ceiling, requestedRung));

  try {
    await session.open();

    io.write('◆ ');
    const opening = await session.openingTurn(standingOrders);
    io.write('\n');
    recordCommanderTurn(opening.text, opening.refusals);

    while (!exitRequested) {
      const line = await io.nextLine(PROMPT);
      if (line === null) {
        if (!exitRequested) exitReason = 'eof';
        break;
      }
      const text = line.trim();
      if (text === '') continue;
      exitArmed = false;
      if (text === '/exit' || text === '/quit') {
        exitReason = 'command';
        break;
      }
      if (text === '/help') {
        io.write(SLASH_HELP);
        continue;
      }

      humanTurns += 1;
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        toAgent: COMMANDER_AGENT_ID,
        kind: 'order',
        body: cap(text),
      });

      io.write('\n◆ ');
      const turn = await session.humanTurn(text);
      io.write('\n');
      recordCommanderTurn(turn.text, turn.refusals);
      if (turn.status === 'error' && turn.errors.length > 0) {
        io.write(`\n  ✗ ${turn.errors[0] as string}\n`);
      }
      if (exitRequested) break;

      const proposal: DispatchRequest | null = turn.proposal;
      if (proposal === null) continue;

      // =====================================================================================
      // THE KEYSTROKE.
      //
      // Everything above this point is a model's opinion. Below it, a real process gets a real
      // worktree and a real `Edit` tool. The only thing that crosses the line is a line of text
      // read from the terminal, which is the one input in this system that no subordinate can
      // write to.
      // =====================================================================================
      const query = archive.appendSignal({
        fromAgent: COMMANDER_AGENT_ID,
        toAgent: GENERAL_AGENT_ID,
        kind: 'query',
        body: cap(`requests a dispatch: ${proposal.objective}`),
      });

      io.write(`\n  ◇ proposed objective\n     ${proposal.objective}\n`);
      const answer = await io.nextLine(CONFIRM_PROMPT);
      if (answer === null) {
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          toAgent: COMMANDER_AGENT_ID,
          kind: 'answer',
          inReplyTo: query.seq,
          body: 'the session ended before the dispatch was approved; nothing was spawned',
        });
        dispatches.push({
          objective: proposal.objective,
          approved: false,
          campaignId: null,
          outcome: null,
          verdict: null,
          deliveredRung: null,
        });
        if (!exitRequested) exitReason = 'eof';
        break;
      }
      if (!isApproval(answer)) {
        const reason = 'the Commander did not approve it';
        io.write('  ◇ not dispatched.\n');
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          toAgent: COMMANDER_AGENT_ID,
          kind: 'answer',
          inReplyTo: query.seq,
          body: cap(`declined: ${proposal.objective}`),
        });
        dispatches.push({
          objective: proposal.objective,
          approved: false,
          campaignId: null,
          outcome: null,
          verdict: null,
          deliveredRung: null,
        });
        io.write('\n◆ ');
        const reaction = await session.dispatchDeclinedTurn(proposal.objective, reason);
        io.write('\n');
        recordCommanderTurn(reaction.text, reaction.refusals);
        continue;
      }

      // ---- the dispatch ---------------------------------------------------------------
      io.write('  ◇ dispatching — Engineer, then an independent Inspector.\n');
      // From here the process is waiting on a model for minutes and this window is the only place
      // a human is blocked on it. The lifecycle was never missing — `runCampaign` has offered it
      // since the campaign command started narrating — it was simply never asked for here.
      //
      // Built per dispatch and closed with it. A session-long sink would be one whose elapsed
      // ticker could outlive the campaign that started it and paint over the conversation.
      const sink = createProgressSink({
        stream: io,
        self,
        charset,
        // Two questions, kept apart: WHICH lines (all of them, always) and whether they animate.
        // Piped or redirected there is no cursor to control and no reader to animate for, and
        // escape bytes in a saved transcript are a corruption, not a feature.
        live: io.isTTY,
      });
      narrate = guardedProgress(sink.emit);
      dispatchInFlight = true;
      let result: CampaignResult | null = null;
      let failure: string | null = null;
      try {
        result = await runDispatch({
          onProgress: narrate,
          objective: proposal.objective,
          cwd: project,
          env,
          home,
          requestedRung,
          maxAttempts,
          ...(options.worktreeProvider === undefined ? {} : { worktreeProvider: options.worktreeProvider }),
          ...(options.worktreeRoot === undefined ? {} : { worktreeRoot: options.worktreeRoot }),
          ...(options.claudeBin === undefined ? {} : { claudeBin: options.claudeBin }),
          ...(options.codexBin === undefined ? {} : { codexBin: options.codexBin }),
          ...(options.adapters === undefined ? {} : { adapters: options.adapters }),
          ...(options.ghProbe === undefined ? {} : { ghProbe: options.ghProbe }),
          ...(options.dbFactory === undefined ? {} : { dbFactory: options.dbFactory }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        dispatchInFlight = false;
        // `close` writes — it erases the ticker's line — so it is an emission like any other and
        // is guarded like one. A throw from a `finally` replaces whatever the block was doing,
        // and what this block is doing is returning a session to a human.
        try {
          sink.close();
        } catch {
          /* narration is never load-bearing */
        }
        narrate = () => {};
      }

      if (result === null) {
        const message = failure ?? 'the dispatch produced no result';
        io.write(`  ✗ ${message}\n`);
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          toAgent: COMMANDER_AGENT_ID,
          kind: 'answer',
          inReplyTo: query.seq,
          body: cap(`dispatch failed to start: ${message}`),
        });
        dispatches.push({
          objective: proposal.objective,
          approved: true,
          campaignId: null,
          outcome: 'aborted',
          verdict: null,
          deliveredRung: null,
        });
        io.write('\n◆ ');
        // A failure to START is not a subordinate's account of anything — it is this process
        // reporting on itself, so it goes back as the declined envelope, whose only strings are
        // the objective the human approved and a message this file wrote.
        const reaction = await session.dispatchDeclinedTurn(
          proposal.objective,
          `the dispatch could not be started: ${cap(message, 200)}`,
        );
        io.write('\n');
        recordCommanderTurn(reaction.text, reaction.refusals);
        continue;
      }

      io.write(renderDispatchOutcome(result, progressStyle));
      const facts = factsFrom(result, proposal.objective);
      dispatches.push({
        objective: proposal.objective,
        approved: true,
        campaignId: result.campaignId,
        outcome: result.outcome,
        verdict: facts.verdict,
        deliveredRung: result.deliveredRung,
      });
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        toAgent: COMMANDER_AGENT_ID,
        kind: 'answer',
        inReplyTo: query.seq,
        body: cap(
          `${result.outcome}: ${result.branch} — inspector ${facts.verdict ?? 'no verdict'}`,
        ),
        artifact: result.campaignRoot,
      });

      io.write('\n◆ ');
      const reaction = await session.dispatchResultTurn(facts);
      io.write('\n');
      recordCommanderTurn(reaction.text, reaction.refusals);
    }
  } finally {
    unsubscribe();
    // Every step guarded on its own: a cleanup path that can throw is a cleanup path that does
    // not run, and this one is what closes the archive the whole conversation is in.
    try {
      await session.close();
    } catch {
      /* the commander was already gone */
    }
    try {
      archive.finishAgent(COMMANDER_AGENT_ID, {
        status: 'exited',
        costUsd: session.costUsd,
      });
    } catch {
      /* the index refused; the files are truth */
    }
    try {
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        kind: 'status',
        body: cap(
          `chat closed after ${String(humanTurns)} turn(s) and ${String(dispatches.length)} ` +
            `dispatch proposal(s); ${exitReason}`,
        ),
      });
    } catch {
      /* as above */
    }
    try {
      archive.updateTask(task.id, { status: 'done' });
    } catch {
      /* as above */
    }
    try {
      archive.setCampaignStatus('done');
    } catch {
      /* as above */
    }
    try {
      archive.close();
    } catch {
      /* as above */
    }
    io.write(`\n  archive   ${archive.root}\n            ${self} view ${campaignId}\n\n`);
  }

  return {
    campaignId,
    campaignRoot: archive.root,
    project,
    ceiling,
    requestedRung,
    turns: humanTurns,
    dispatches,
    refusals,
    exitReason,
    costUsd: session.costUsd,
    // A conversation that happened is a conversation that succeeded. A dispatch that failed
    // inspection is news, not an error in the session — `army view` and the printed outcome say
    // so, and exiting non-zero would make every honest FAIL look like a broken tool.
    exitCode: 0,
  };
}

export const SLASH_HELP = `
  /exit  /quit   leave the session
  /help          this
  Ctrl-C         stop the answer in flight; again to leave
  Ctrl-D         leave

  The commander holds no tools. To change a file it proposes an objective, you approve it,
  and an Engineer is raised in a leased worktree and reviewed by an independent Inspector.
`;
