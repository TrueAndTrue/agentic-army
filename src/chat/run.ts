/**
 * `army chat` — the conversation loop.
 *
 * ```
 * ▌ the auth middleware feels wrong to me
 *
 * ◆ it would, if it re-reads the session on every request. I cannot see the
 *   file. Shall I put an Engineer on it?
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
 * ◆ passed on the first attempt, rung 0, branch army/t-1.
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
 * 2. **The commander's loadout is one inert tool.** The spec goes through `buildSoldierSpec`, the same
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

import * as fs from 'node:fs';
import * as path from 'node:path';

import { CampaignArchive, campaignIdFor, createCampaign, listCampaignIds } from '../archive/archive.ts';
import type { ArchiveConfig } from '../archive/archive.ts';
import {
  GENERAL_AGENT_ID,
  UNSPECIFIED_BRIEF_EFFORT,
  buildSoldierSpec,
  dispatchFor,
  resolveProjectRootOrInit,
  runSoldier,
} from '../command/campaign.ts';
import type { CampaignResult } from '../command/campaign.ts';
import { renderScoutBrief } from '../command/orders.ts';
import { describeFanOutHalt, fanOutHaltLine, runRecce, watchFanOut } from '../command/scout.ts';
import type { RecceOutcome, ScoutSpawn } from '../command/scout.ts';
import { loadConfig, postureSummary } from '../config/load.ts';
import { armyHome } from '../config/paths.ts';
import type { Env } from '../config/paths.ts';
import { RUNG_LABEL, effectiveRung } from '../contracts/delivery.ts';
import type { PermissionPosture } from '../contracts/config.ts';
import type { Rung } from '../contracts/delivery.ts';
import type { TaskRow } from '../contracts/archive.ts';
import type { HarnessAdapter, HarnessId, Soldier, SoldierEvent, SoldierSpec } from '../contracts/harness.ts';
import type { PendingQuestion } from '../contracts/question.ts';
import { renderPendingQuestion } from '../contracts/question.ts';
import { codePointLength } from '../contracts/report.ts';
import type { CommandRunner } from '../contracts/verify.ts';
import {
  SCOUT_MAX_SUBAGENTS,
  SCOUT_MODEL_SESSION_USD,
  SCOUT_TIMEOUT_MS,
  scoutFindingLines,
} from '../contracts/scout.ts';
import { renderTechnicalSpec } from '../contracts/spec.ts';
import type { WorktreeProviderId } from '../contracts/worktree.ts';
import type { DeliveryConfig } from '../delivery/ladder.ts';
import { projectCeiling } from '../delivery/ladder.ts';
import type { GhStatus } from '../delivery/git.ts';
import { createClaudeAdapter } from '../harness/claude.ts';
import { killSoldierTree } from '../harness/kill.ts';
import { invokedAs } from '../setup/checks.ts';
import { registerProjectIfAbsent } from '../setup/enlist.ts';
import { ensureConfig } from '../setup/init.ts';
import { DEFAULT_MAX_CONCURRENT_WORKSTREAMS } from '../contracts/workstream.ts';
import { detectCharset, detectColor } from '../view/index.ts';
import type { Charset } from '../view/render.ts';
import { displayWidth, glyphsFor, renderTreeRows, wrapPlain } from '../view/render.ts';
import {
  DEFAULT_TREE_ROWS,
  REPO_UNKNOWN,
  describeRepo,
  renderHeader,
  renderStatusBar,
} from '../view/chrome.ts';
import type {
  BudgetModel,
  ChromeStyle,
  RepoState,
  RosterUnit,
  StatusModel,
} from '../view/chrome.ts';
import { openCampaignReader } from '../view/live.ts';
import type { CampaignReader } from '../view/live.ts';
import { buildTree, walkTree } from '../view/tree.ts';
import type { TreeModel } from '../view/tree.ts';
import { createProgressSink, dispositionOf, renderProgressEvent, sanitize } from '../view/progress.ts';
import { createProseStream } from '../view/prose.ts';
import type { ProgressEvent, ProgressListener, ProgressStyle } from '../view/progress.ts';

import { alignmentRefusals, renderAlignment, runAlignmentGate } from './align.ts';
import type { AlignmentResult } from './align.ts';
import { factsFrom, guardedProgress, runDispatch } from './dispatch.ts';
import { createInbox, inboxPrompt, renderQuestionMarker } from './inbox.ts';
import type { InboxEntry } from './inbox.ts';
import type { ChatIo, StatusRenderer } from './io.ts';
import { COMMANDER_ADDRESSEE } from './io.ts';
import { readRepoState } from './repo.ts';
import { renderStandingOrders } from './orders.ts';
import { captureTurn, planningDocuments, writeSpecToRepo } from './planning.ts';
import type { InterrogationTurn, PlanningRecord } from './planning.ts';
import type { DispatchRequest, ScoutRequest, SituationFacts } from './protocol.ts';
import { ChatSession } from './session.ts';
import type { TurnResult } from './session.ts';
import { renderWorkSnapshot } from './snapshot.ts';
import type { SnapshotFile } from './snapshot.ts';

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
  /**
   * Turn a bare directory into a repository before refusing it, exactly as `enlist` does.
   * Default true; `--no-init` is the opt-out. See `resolveProjectRootOrInit` for the guards.
   */
  init?: boolean;
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
  /**
   * Draw the session chrome — the boxed header and the status block pinned under the composer.
   *
   * Default is on for a terminal and off everywhere else. The opt-out (`--plain`) exists because
   * the block is painted with cursor movement, and there are terminals that lie about being one:
   * an editor's embedded console, a CI runner with a PTY, an `ssh -t` through something that
   * eats `ESC[nA`. On any of those the honest recovery is a flag, not a heuristic that guesses
   * wrong in the other direction and hides the chrome from everybody.
   */
  chrome?: boolean;
  /**
   * Milliseconds, for the elapsed clocks in the status block.
   *
   * Separate from `now`, which yields the ISO strings the archive records: one is a timestamp on
   * a durable row and the other is a stopwatch a human is watching, and a test that wants a
   * deterministic `1m12s` on a roster row must be able to move the second without touching the
   * first.
   */
  nowMs?: () => number;
  /** Repository state for the chrome. Injected by tests; production reads the working copy. */
  readRepo?: (dir: string) => Promise<RepoState>;
  /**
   * Put a `MAJ·OVERSEER` over anything this session dispatches, so the feature is segmented into
   * concurrent workstreams. Off by default, exactly as `army campaign` has it.
   */
  overseer?: boolean;
  /**
   * The concurrency cap a dispatch runs under, and the number the status block draws.
   *
   * ONE VARIABLE for both, because a cap on screen that the pool is not enforcing would be worse
   * than no cap on screen: the whole reason it is up there is that a reader can see how far the
   * fan-out may go before the bill arrives.
   */
  maxConcurrentWorkstreams?: number;
  /**
   * The process runner the alignment gate uses to read the spec's verification commands.
   *
   * Injected so a test never spawns a shell, exactly as `CampaignOptions.verifyRun` is. It is NOT
   * threaded onward into the dispatch: the campaign takes its own baseline inside the leased
   * worktree, which is a different tree at the same base commit, and one seam feeding both would
   * make a test that stubs the gate silently stub the campaign too.
   */
  verifyRun?: CommandRunner;
  /**
   * How often the status block re-reads the running campaign's archive, in milliseconds.
   *
   * The tree in the block is built by `buildTree` from a real `CampaignSnapshot`, read off the
   * campaign's own files, by the same path `army view --follow` polls, at the same rate, for
   * the same reason: the archive is truth, and a model rebuilt from the narration would be a
   * second derivation of the thing the block exists to show. Injected so a test does not have to
   * wait on a real second.
   */
  treePollMs?: number;
}

export interface ChatDispatchRecord {
  objective: string;
  approved: boolean;
  campaignId: string | null;
  outcome: string | null;
  verdict: 'pass' | 'fail' | null;
  deliveredRung: Rung | null;
  /**
   * What the mechanical alignment gate did with this proposal.
   *
   * `passed` — every required spec field answered and every verification command executed against
   * the base commit, so the keystroke was offered. `refused` — one of those failed and no
   * keystroke was ever offered, which is the state where `approved` is false for a reason nobody
   * typed. `no-spec` — the proposal carried no spec, so there was no phase 1 to be aligned with;
   * see the block that prints for that case in the loop below.
   */
  gate: 'passed' | 'refused' | 'no-spec';
}

/** One recce this conversation asked for, whether or not it happened. */
export interface ChatRecceRecord {
  question: string;
  approved: boolean;
  agentId: string | null;
  /** How many subordinates it fielded. MEASURED off the event stream, never self-reported. */
  subagentsFielded: number;
  /** True when this process stopped it for crossing the fan-out ceiling. */
  haltedForFanOut: boolean;
  /** The scout's own cost, as the harness reported it. Null when it reported none. */
  costUsd: number | null;
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
  /** Every recce this session proposed, in order. */
  recces: ChatRecceRecord[];
  /** Every dispatch or recce block that was parsed and not honoured, with the reason. */
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

/**
 * Exported so tests can drive the terminal with the REAL bytes. The last shipped terminal bug —
 * the composer walking down the screen one row per keystroke — lived precisely in the gap between
 * these constants and the prompt every io test hand-rolls: the leading `\n` here never met
 * the repaint code until a human did. `ChatIo.nextLine` documents the multi-line contract; a test
 * that spells its own prompt is a test of a prompt nobody uses.
 */
export const PROMPT = '\n▌ ';
export const CONFIRM_PROMPT = '  ◇ dispatch this? [y/N] ';
/**
 * The prompt a parked question is answered at.
 *
 * Deliberately NOT the ordinary composer prompt. Everything typed at `PROMPT` goes to the
 * commander; this line goes to a worker that is holding a worktree and waiting, and the two must
 * not look the same. Exported for the same reason `PROMPT` is: a test that spells its own prompt
 * is a test of a prompt nobody uses.
 *
 * SHORT, and the guidance it used to carry now sits on `ANSWER_HINT` above it. The prompt is
 * repainted down every wrapped row of the entry the human types — that is `paintEntry`, and for
 * the two-column `▌` it is a rule marking a region. At forty-four columns it stopped being a rule
 * and became the same sentence printed twice, with the wrapping budget cut to 35 columns on an
 * 80-column terminal. Found by typing a one-line answer on a real pty, not by reading.
 */
export const ANSWER_PROMPT = '  ◇ your answer  ';
/** The two ways out, stated where a reader meets them, since one of them is a keystroke. */
export const ANSWER_HINT = '    a blank answer, or Ctrl-C, leaves the question unanswered.';

/**
 * The composer's prompt while a dispatch runs and nothing is asking.
 *
 * There IS a prompt now, where before there was none, and that is the change that makes `/stop`
 * and `/work` reachable at all: a command nobody can type while the thing it acts on is running is
 * not a command. Deliberately not `PROMPT`: a line typed here is routed by the console first,
 * and what reaches the Commander is a `human-in-flight` turn with the campaign's state alongside
 * it rather than the bare line, and the two must not look the same.
 *
 * Short for the reason every prompt in this file is short: it is repainted per keystroke, charged
 * against the width the buffer gets, and repeated down every wrapped row of the entry. What it
 * does not say is on the status block, which has room and repaints for nothing.
 */
export const DISPATCH_PROMPT = '\n  ▪ ';
/** `/stop` confirms, because every worktree in flight has to be settled rather than dropped. */
export const STOP_CONFIRM_PROMPT = '  ◇ stop the campaign? [y/N] ';

/**
 * The keystroke that sends a scout.
 *
 * A SECOND prompt, not a reuse of `CONFIRM_PROMPT`, and the wording says which of the two things
 * is about to happen. A human who typed `y` at "dispatch this?" has agreed to an Engineer with an
 * editor in a leased worktree; a human who typed `y` here has agreed to a reader. Those are
 * different decisions with different bills, and one prompt for both would be a prompt that means
 * whatever the last block happened to be.
 */
export const SCOUT_CONFIRM_PROMPT = '  ◇ send a scout? [y/N] ';

/**
 * Who the dispatch console reads for, and why it is not the Commander.
 *
 * The console is a READER IN ITS OWN RIGHT. A line typed at it is routed by this file — as a
 * command, as an answer to a parked worker, or as a `human-in-flight` turn for the Commander —
 * and is never sent to the Commander as a turn without passing through that routing. So a line typed at the COMMANDER's prompt before
 * a dispatch began is addressed to somebody else and this loop cannot take it, which is exactly
 * the property `{ fresh: true }` used to buy one call site at a time. Naming the reader honestly
 * is what makes it structural: `src/chat/io.ts` compares addressees for equality and nothing else.
 */
export const DISPATCH_CONSOLE_ADDRESSEE = 'dispatch-console';

/**
 * How many interrogation rounds the durable transcript keeps, newest last.
 *
 * The spec is settled at the END of an interrogation, so when a conversation runs longer than
 * this the rounds worth keeping are the recent ones. Over the cap `renderInterrogationDocument`
 * says how many were dropped rather than quietly beginning in the middle — a transcript that
 * starts at round 61 and does not say so is a transcript that misrepresents when a decision was
 * taken. It works that out from the first surviving round's own number, so nothing here has to
 * hand it a count that could disagree.
 */
export const MAX_INTERROGATION_ROUNDS = 60;

/**
 * Per-half cap on one recorded round, in characters.
 *
 * A commander's reply is prose with no upper bound anybody has promised, and this document is
 * written to the archive and sometimes into a repository. Truncation is marked in the text.
 */
export const INTERROGATION_HALF_MAX_CHARS = 4000;



/**
 * The largest archive file `/work` will open.
 *
 * An `orders.md` is kilobytes; a `diff.patch` is a worker's entire branch and has no upper bound
 * anybody has promised. This command runs inside a live conversation, on the same thread as the
 * composer, so it reads to count and must not be able to pull a hundred megabytes into memory to
 * do it. Over the cap the reader returns `too-large` with the size, and the field prints that
 * size and the path, rather than "none recorded" about a file that is there.
 */
export const WORK_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * How many narration lines a `human-in-flight` turn carries to the Commander, newest last.
 *
 * The tree says where every unit IS; these say what just HAPPENED, which the tree cannot: a
 * verdict that landed, a merge that conflicted, a question that climbed. A dozen is the last
 * minute or two of a campaign and is the part a "what is going on?" is usually asking about.
 */
export const RECENT_NARRATION_MAX = 12;

/**
 * How many tree rows a `human-in-flight` turn carries. Over the cap the situation says how many
 * were dropped and where to read them, because a model told about forty units and not about the
 * forty-first will answer as if there were forty.
 */
export const SITUATION_TREE_MAX_ROWS = 40;

/** `y` / `yes`, and nothing else. Anything ambiguous is a no — the default must be the safe one. */
export function isApproval(line: string): boolean {
  const answer = line.trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/**
 * `n` / `no` / nothing, and nothing else. The EXPLICIT half of "anything else is a no".
 *
 * Not the complement of `isApproval`, and the difference is the whole reason it exists. At a y/N
 * prompt "anything ambiguous is a no" decides whether the dangerous thing happens; it does not
 * decide what becomes of the words the human typed. `n` is an answer to the question that was
 * asked and is consumed by it. `where is cpt-03?` is not — it is a sentence for somebody else that
 * happens to have been typed while a confirmation was on the row, and swallowing it as a decline
 * is how a line the human typed disappears with a message that does not mention it.
 */
export function isDecline(line: string): boolean {
  const answer = line.trim().toLowerCase();
  return answer === '' || answer === 'n' || answer === 'no';
}

export interface BannerFacts {
  self: string;
  project: string;
  repo: RepoState;
  ceiling: Rung;
  rung: Rung;
  /** The commander's model id, or empty when the harness was left to pick its own. */
  model: string;
  /**
   * The permission posture every worker this session dispatches is built under. On the banner
   * because the banner is the one surface a person looks at for an hour, and under `unguarded`,
   * which is what `army init` writes, an Engineer runs any command rather than a listed one.
   */
  posture: PermissionPosture;
  campaignId: string;
  archiveRoot: string;
}

/**
 * The block a session opens with.
 *
 * It answers, in order, the four questions a reader has before they type anything: what is this,
 * where am I, how far may it go, and which keys work. That ordering is the whole design — the
 * flat six lines this replaced put the keystrokes in the middle, between two facts, where nobody
 * looking for them found them twice.
 *
 * The repository line is new and is the reason this grew a `RepoState`. A commanding session
 * dispatches Engineers that branch and commit; a reader who cannot see which branch they are
 * standing on, and whether it is dirty, is being asked to approve work against a location they
 * were never told. `army chat` is the one command in this tool where that fact was missing.
 *
 * Kept in this file, and spelling `COL·COMMANDER` here rather than in `src/view/chrome.ts`,
 * because the repo-wide sweep in `test/contracts.test.ts` reads every file under `src/chat/**`
 * for claims about the commander's loadout. A banner that moved its text into the view layer
 * would have moved it out from under the guard that checks the text is true.
 */
export function chatBanner(facts: BannerFacts, style: ChromeStyle): string {
  const repo = describeRepo(facts.repo);
  return `${renderHeader(
    {
      title: '◆ COL·COMMANDER — a live session',
      subtitle: 'it holds the objective, and one inert tool: TodoWrite',
      facts: [
        { key: 'project', value: path.basename(facts.project) },
        { key: 'path', value: facts.project },
        { key: 'branch', value: repo },
        { key: 'commander', value: facts.model === '' ? 'claude' : `claude · ${facts.model}` },
        { key: 'permissions', value: postureSummary(facts.posture) },
        {
          key: 'ceiling',
          value:
            `${String(facts.ceiling)} (${RUNG_LABEL[facts.ceiling]})` +
            `   dispatches ask for at most ${String(facts.rung)} (${RUNG_LABEL[facts.rung]})`,
        },
        { key: 'archive', value: facts.archiveRoot },
      ],
      // Three short rows rather than two long ones. An 80-column terminal is the width to design
      // for, and a hint that reaches it gets an ellipsis put through the middle of the command it
      // was telling the reader to type.
      hints: [
        'every dispatch is reviewed by an independent Inspector',
        // Deliberately NOT the words the running session uses. `^C  (again to leave, or /exit)`
        // is a line the interrupt handler prints and two tests match on, and a banner carrying
        // the same phrase makes every one of those matches ambiguous from the first byte of the
        // session — which is how one of them came to assert that a header had armed an exit.
        'Ctrl-C stops the answer in flight · a second one leaves · /help for the rest',
        `${facts.self} view ${facts.campaignId}   reads this conversation back`,
      ],
    },
    style,
  ).join('\n')}\n`;
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
 * - error notes that were NEVER narrated. The re-statement here is deliberate only for notes
 *   raised BEFORE the campaign opened, which the live stream never carries — the field
 *   transcript showed every narrated error printed twice, once live and once here, so `narrated`
 *   is the set of note messages the live stream already showed and those are skipped. PURE: the
 *   set is passed in; this function watches nothing itself. Exported for the test that pins both
 *   halves — a narrated error appears once, an un-narrated one still appears.
 */
export function renderDispatchOutcome(
  result: CampaignResult,
  style: ProgressStyle,
  narrated: ReadonlySet<string>,
): string {
  const lines: string[] = [];
  for (const note of result.notes) {
    if (note.level === 'error' && !narrated.has(note.message)) {
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
  const nowMs = options.nowMs ?? ((): number => Date.now());
  /**
   * The pinned status block, and everything that follows from having one.
   *
   * Off the terminal there is no cursor to move and nothing to animate for, so this is false and
   * every consequence below falls back to what the command did before it existed — including the
   * campaign ticker, which is `live` exactly when this is NOT: the two draw the same fact (a unit
   * is working, and for how long) and drawing it twice on one screen is drawing it wrong.
   */
  const chrome = (options.chrome ?? true) && io.isTTY;
  const chromeStyle = (): ChromeStyle => ({
    charset,
    color: detectColor(env, io.isTTY),
    width: io.width,
  });

  /**
   * The commander's answers, rendered: gutter, word wrap, and the model's markdown as ink.
   *
   * Gated on the terminal, not on `chrome`: the prose stream is ordinary forward output with no
   * cursor movement in it, so `--plain` (which exists for terminals that lie about honouring
   * cursor movement) keeps it. Off a terminal it is null and every answer goes out as the raw
   * bytes it always was, because a redirected transcript is a record, not a rendering.
   */
  const prose = io.isTTY
    ? createProseStream({
        width: () => io.width,
        color: detectColor(env, io.isTTY),
        charset,
        write: (text) => {
          io.write(text);
        },
      })
    : null;
  /**
   * The idle flush the note on `settle` below demands: a chunk arriving re-arms it, and when the
   * stream has been quiet this long the held words are printed rather than kept hidden behind a
   * stalled commander. Short enough that a human never notices the hold; long enough that a
   * normally streaming answer renders line by line, not fragment by fragment.
   */
  const SPILL_MS = 350;
  let spillTimer: ReturnType<typeof setTimeout> | null = null;
  const disarmSpill = (): void => {
    if (spillTimer !== null) clearTimeout(spillTimer);
    spillTimer = null;
  };
  const armSpill = (): void => {
    if (prose === null) return;
    disarmSpill();
    spillTimer = setTimeout(() => {
      spillTimer = null;
      prose.spill();
    }, SPILL_MS);
  };
  /** An answer turn is starting: the gutter arms, and off a terminal the exact former bytes. */
  const beginAnswer = (fresh: boolean): void => {
    if (prose === null) {
      io.write(fresh ? '\n◆ ' : '◆ ');
      return;
    }
    if (fresh) io.write('\n');
    prose.begin();
  };
  /** The turn settled: print whatever is still held, unmatched markers and all. */
  const endAnswer = (): void => {
    disarmSpill();
    prose?.end();
  };

  const project = await resolveProjectRootOrInit({
    cwd,
    init: options.init ?? true,
    needs: 'A commander needs a repository to send anyone into.',
    // The same line `enlist` prints, before the banner: the reader is owed the fact that a
    // repository now exists that did not when they typed the command.
    onCreated: (dir) => io.write(`\n  created a git repository in ${dir}\n`),
  });

  /**
   * First-run setup, on the way in rather than as homework.
   *
   * Chat is the front door, and until this block existed the front door had a queue in front of
   * it: `init`, then `cd`, then `enlist`, then finally the command the reader wanted, four
   * commands and two of them in other directories. Every piece was already idempotent, so the
   * only thing standing between "fresh machine" and "conversation" was that nobody called them.
   *
   * Neither step here can widen authority, which is what makes it safe to run unasked.
   * `ensureConfig` creates `~/.agentic-army` and the default config only where they are missing,
   * never overwriting. The registration below records the FAIL-CLOSED ceiling 0, byte-identical
   * in effect to not being registered at all (`projectCeiling` answers 0 for an unknown project),
   * so the write changes what the config says, not what anything may do. Raising a ceiling still
   * takes `army enlist --ceiling N` from a terminal, or a hand edit, exactly as `enlist`'s own
   * policy block demands.
   */
  const setup = await ensureConfig(home);
  if (setup.createdConfig) {
    io.write(`\n  created the war archive in ${home}\n`);
  }

  const loaded = await loadConfig({ home, env });
  const config = loaded.config;
  if (config.projects[project] === undefined) {
    try {
      const { registered } = await registerProjectIfAbsent(project, home);
      if (registered) {
        // Kept in the in-memory config too, so everything downstream reads what the file says.
        config.projects[project] = { project, ceiling: 0 };
        io.write(
          `  enlisted ${project} at ceiling 0, ${RUNG_LABEL[0]} only. ` +
            `Raise it with \`${invokedAs()} enlist --ceiling N\`.\n`,
        );
      }
    } catch (error) {
      // Degrade, never refuse: the session runs at the same fail-closed 0 whether or not the
      // registration landed, so a read-only home or a config with a syntax error costs the
      // reader a bookkeeping line, not the conversation they asked for.
      io.write(
        `  note: could not record ${project} in the config ` +
          `(${error instanceof Error ? error.message : String(error)}); continuing at ceiling 0\n`,
      );
    }
  }
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
    // So the schema refusal on an index written by an older release names a command this reader
    // can paste. `src/archive/**` cannot resolve it; this layer already has.
    self: invokedAs(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.dbFactory === undefined ? {} : { dbFactory: options.dbFactory }),
  };
  const archive: CampaignArchive = createCampaign(archiveConfig, {
    id: campaignId,
    project,
    title: `chat in ${path.basename(project)}`,
  });
  const standingOrders = renderStandingOrders({ project, ceiling, requestedRung, maxAttempts });

  /**
   * Where the human is standing, as the header and the status bar report it.
   *
   * Read here — before the banner, which names it — and RE-READ after every dispatch, because a
   * dispatch commits and branches: a branch name captured once is a fact that turns into a lie
   * halfway through the session, and a stale fact on a status bar is read with exactly the same
   * confidence as a fresh one.
   *
   * Gated on there being a HUMAN — `io.isTTY` — and not on `chrome`. `--plain` turns off the
   * rows that are painted with cursor movement; it does not turn off knowing where you are, and
   * the header and `/status` still print the branch under it. What the gate does rule out is a
   * redirected session spawning five git processes to decorate a transcript nobody is watching:
   * `readRepoState` is the only thing in this file that shells out at all.
   */
  const readRepo = options.readRepo ?? (io.isTTY ? readRepoState : null);
  let repo: RepoState = readRepo === null ? REPO_UNKNOWN : await readRepo(project);

  // ---- the setup window --------------------------------------------------------------------
  //
  // Everything between the archive opening and the main `try` used to be unprotected: a throw
  // from any call in here — the `col-01` collision, a refused commander loadout, a banner write
  // to a pipe whose reader is gone — exited `runChat` with the archive OPEN, `campaign.json`
  // frozen at `status: "active"` and the task `in_flight` forever, so `view` showed a phantom
  // live session. The main `finally` cannot cover this window (it needs `task` and `session` to
  // exist), so the window closes itself and rethrows for `chatCommand` to report.
  //
  // Status `aborted`, not `done` (what the finally writes) and not `failed`: nothing was ever
  // said, and `runCampaign`'s own setup convention for "ended before anything ran" is `aborted`,
  // with the task `blocked`. The status write keys on the archive still saying `active`, so a
  // collision with a campaign some other run already settled leaves that run's record untouched.
  const { task, spec } = ((): { task: TaskRow; spec: SoldierSpec } => {
    let created: TaskRow | null = null;
    try {
      // Before the first append, for the reason spelled out at the same call in `runCampaign`: a
      // session refused for colliding on `col-01` used to open a task and append signals into
      // somebody else's conversation first, and `tasks.jsonl` and `signals.jsonl` are
      // append-only, so those rows stayed. `chatCommand` renders the `fix:` line off the type.
      archive.assertAgentIdAvailable(COMMANDER_AGENT_ID);

      created = archive.createTask({ title: 'the conversation', status: 'in_flight' });

      // The same choke point every campaign worker goes through. `assertGlobalDenyIntact` and
      // `assertCommanderLoadout` both run in here, so a commander with a widened loadout does
      // not start — it throws, before a process exists.
      const commanderSpec = buildSoldierSpec({
        agentId: COMMANDER_AGENT_ID,
        rank: 'COLONEL',
        role: 'COMMANDER',
        harness: 'claude',
        ...(options.model === undefined ? {} : { model: options.model }),
        cwd: project,
        orders: standingOrders,
        home,
        // Carried for symmetry with the campaign workers, and it changes almost nothing here: a
        // COMMANDER's loadout holds no `Bash`, no `Read` and no write tool under either posture —
        // `COMMANDER_FORBIDDEN_TOOLS` is enforced inside `permissionsFor` regardless — so there is
        // no argv left to scope. Passed anyway so there is no spawn site whose posture is a
        // question, and so widening the commander later cannot silently arrive unconfined.
        posture: config.permissions.mode,
      });

      archive.recordAgentAttempt({
        id: COMMANDER_AGENT_ID,
        taskId: created.id,
        parentAgentId: null,
        rank: 'COLONEL',
        role: 'COMMANDER',
        harness: 'claude',
        model: commanderSpec.model ?? null,
        effort: commanderSpec.effort ?? null,
        sessionId: commanderSpec.sessionId,
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
      // Inside the window on purpose: this is the first write to the human's terminal, EPIPE is
      // one `army chat < script | head` away, and a banner that cannot land must not strand the
      // rows above as a live session. Nothing else prints between here and the old call site.
      io.write(
        chatBanner(
          {
            self,
            project,
            repo,
            ceiling,
            rung: requestedRung,
            model: commanderSpec.model ?? '',
            posture: config.permissions.mode,
            campaignId,
            archiveRoot: archive.root,
          },
          chromeStyle(),
        ),
      );
      return { task: created, spec: commanderSpec };
    } catch (error) {
      // Per-step guards, the same rule as the closing `finally`: a cleanup failure must not
      // replace the error the caller is owed.
      const guard = (fn: () => void): void => {
        try {
          fn();
        } catch {
          /* the setup error is the report; cleanup must not mask it */
        }
      };
      guard(() => {
        if (created !== null && archive.getTask(created.id)?.status === 'in_flight') {
          archive.updateTask(created.id, { status: 'blocked' });
        }
      });
      guard(() => {
        if (archive.getCampaign().status === 'active') archive.setCampaignStatus('aborted');
      });
      guard(() => archive.close());
      throw error;
    }
  })();

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
      // The adapter's default close grace (300s) exists for campaign soldiers that may be
      // mid-write when stdin closes. A commander writes nothing — its whole loadout is TodoWrite
      // — so there is nothing to wait for, and the long grace has a real cost here: an armed
      // Ctrl-C during a wedged turn leaves through `session.close()`, and 300s of grace would
      // turn "again to leave" into a five-minute goodbye.
      closeGraceMs: 2_000,
      ...(options.commanderBin === undefined ? {} : { bin: options.commanderBin }),
    });

  const appendEvent = (event: SoldierEvent): void => {
    archive.appendEvent(COMMANDER_AGENT_ID, event);
  };

  // ---- session state the interrupt handler and the death callback read ---------------------
  let exitRequested = false;
  let exitReason: ChatExitReason = 'eof';
  let exitCode = 0;
  /** The commander's process died — set by `onEnded`, never by a close this process asked for. */
  let commanderGone = false;
  /** The armed second Ctrl-C is leaving; further presses must not re-run the close. */
  let exitLeaving = false;

  /**
   * A turn is over: take the spinner down.
   *
   * ## How the status block and a streaming answer share the screen
   *
   * `src/chat/io.ts` refuses to paint below a cursor that is mid-line (`tail !== ''`), and a
   * model's chunks almost never end on a newline. An earlier revision therefore had the block
   * suppressed for the whole of every answer, and recorded here why naive line-buffering was
   * rejected: holding a partial line until its newline hides a STALLED commander's last words,
   * which is exactly when a reader most needs them, and the wedged-commander cases in
   * `test/chat.test.ts` caught it.
   *
   * The prose stream (`src/view/prose.ts`, built above as `prose`) is the correct version of
   * that idea, idle flush included: an answer renders line by line, so `tail` is empty between
   * lines and the block gets its moments back, and `armSpill`'s timer releases held words the
   * moment the stream goes quiet for a beat, so a stall shows what it has rather than nothing.
   * Off a terminal none of this engages and the raw bytes flow as they always did.
   */
  const settle = (): void => {
    io.setIdle();
  };

  /**
   * True while a `human-in-flight` turn is running and its text is being HELD rather than streamed.
   *
   * During a dispatch the terminal's live thing is the campaign: narration lines land whenever a
   * worker does something, and a Commander answer streamed a word at a time through the prose
   * gutter would have `cpt-02 dispatched` printed into the middle of one of its paragraphs. So
   * an in-flight answer arrives as a block, printed whole once the turn settles, the same way a
   * worker's question does. The chunks are dropped here and `turn.text` is what gets printed.
   */
  let holdAnswer = false;
  const session = new ChatSession({
    adapter: commanderAdapter,
    spec,
    onText: (chunk) => {
      if (holdAnswer) return;
      if (prose === null) {
        io.write(chunk);
        return;
      }
      prose.push(chunk);
      armSpill();
    },
    onEvent: appendEvent,
    onEnded: () => {
      // The QA field shape this exists for: a commander binary that exits shortly after start.
      // The loop is parked on `nextLine` with nothing to wake it, so the prompt just sits there
      // looking healthy while the next input goes to a corpse. The flag is what the loop reads;
      // the abort is what gets the loop back to reading it.
      commanderGone = true;
      io.abortLine();
    },
  });
  /** True while a dispatch campaign is running. A campaign holds a lease; only it may settle one. */
  let dispatchInFlight = false;
  /**
   * The running alignment gate's way out, or null when no gate is running.
   *
   * Non-null for exactly the window in which a human can be waiting on commands with nothing
   * spawned and no lease held, which is why Ctrl-C is allowed to end it outright.
   */
  let gateAbort: AbortController | null = null;
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
  const recces: ChatRecceRecord[] = [];
  const refusals: string[] = [];
  let humanTurns = 0;

  // ---- phase 1: the interrogation, the recce, and what they leave behind ---------------------
  //
  // Three pieces of session state, all written by the loop and read by the dispatch branch.
  //
  // The transcript is a pairing rather than a log. A round is the COMMANDER's question and the
  // human's answer TO it, which is what an interrogation is; recording a log of turns would put
  // each answer next to the reply it provoked instead of next to the question it answered, and a
  // reader six weeks later cannot tell those apart. `pendingQuestion` is what makes the pairing
  // possible: it holds the last thing the commander said until the human answers it.
  const interrogation: InterrogationTurn[] = [];
  let pendingQuestion = '';
  let interrogationRounds = 0;

  /**
   * Every scout finding this conversation has gathered, flattened.
   *
   * Threaded into the dispatch as `scoutFindings`, which reaches `renderSegmentationBrief` and
   * becomes the `## WHAT THE SCOUT FOUND` section a `MAJ·OVERSEER` plans from. Until this wave
   * that field was declared, rendered and populated by nothing at all.
   *
   * ACCUMULATED ACROSS THE SESSION rather than per dispatch: two recces answering two halves of
   * one question are two halves of one briefing, and dropping the earlier one would make the
   * order in which a human asked things decide what the planner is told.
   */
  const scoutFindings: string[] = [];
  /** Cumulative recce spend, for `refuseOnBudget`. See `SCOUT_SESSION_BUDGET_USD`. */
  let recceSpendUsd = 0;
  let scoutCounter = 0;

  // ---- the status block ---------------------------------------------------------------------
  //
  // Everything below is read BY the renderer and written by the loop, never the other way round.
  // That direction is the whole discipline of a status bar: the moment a render can change what
  // it is describing, a repaint becomes a side effect and a 120ms timer becomes a way to corrupt
  // a session. `statusModel` therefore only reads, and `renderStatusBar` is pure over what it
  // returns.

  /**
   * A unit in flight, plus the instants the bar computes its three clocks from.
   *
   * Three timestamps rather than one, because they answer three different questions and a single
   * `since` conflated them the moment activity events started arriving:
   *
   *   `since`       — when the current STATE began. Feeds `elapsedMs`. Moved only by a state
   *                   change, never by a tool call, or the elapsed reading would restart on every
   *                   `Write` and stop being the thing a watching human is actually timing.
   *   `detailSince` — when `detail` last changed. Feeds `detailAgeMs`, which is what lets a row
   *                   keep naming the last action without claiming it is the present one.
   *   `lastEventAt` — when ANYTHING last arrived. Feeds `silentMs`, the stall signal.
   */
  type RosterRow = Omit<RosterUnit, 'elapsedMs' | 'detailAgeMs' | 'silentMs'> & {
    since: number;
    detailSince: number | null;
    lastEventAt: number;
  };
  /** Cleared when a dispatch settles: between dispatches nothing is running, and the bar says so. */
  let roster: RosterRow[] = [];
  /** How many units stay on the bar. The Engineer is worth keeping while the Inspector reads it. */
  const ROSTER_MAX = 4;
  /** True while the human is being asked to approve a dispatch — the one blocking keystroke. */
  /**
   * Which confirmation prompt is up, or null.
   *
   * NOT A BOOLEAN, and it used to be. The status bar's hint reads this to say what the next
   * keystroke does, and with one flag for two prompts a human at `send a scout? [y/N]` was told
   * `approve to dispatch, anything else declines` on the row underneath it. Found by driving the
   * real binary under a pty and reading the bar; every unit test in this file asserts on the
   * prompt, which was correct, and none of them looks at the row below it.
   */
  let awaitingApproval: 'dispatch' | 'scout' | null = null;
  /**
   * Questions parked on this human, oldest first.
   *
   * Replaces the `awaitingAnswer` boolean, which was correct while a campaign could only have one
   * blocked worker. Wave 3 made a campaign a fan-out of up to eight engineers, and a boolean
   * cannot say which of three is being answered, nor stop a second `nextLine` from orphaning the
   * first worker's promise. See `src/chat/inbox.ts`.
   *
   * `inbox.size > 0` reads exactly where `awaitingAnswer` used to, and means the same thing: a
   * worker has stopped and the reason is this person.
   */
  const inbox = createInbox();
  /**
   * The dispatch console: one read, owned by one loop, for the whole of a dispatch.
   *
   * `active` is what tells that loop to keep reading and what tells `askHuman` there is anybody
   * there to read at all: a question raised after the console has stopped (end of input, a dead
   * terminal) must be resolved immediately rather than parked on a prompt nobody will answer.
   * `interrupted` is set by the Ctrl-C handler before it aborts the read, so the loop can tell
   * "the human pressed Ctrl-C at this question" from "there will never be any more input", which
   * arrive as the same `null`.
   */
  let consoleActive = false;
  let consoleInterrupted = false;
  let consoleLoop: Promise<void> = Promise.resolve();
  /**
   * Commander turns taken WHILE A DISPATCH RUNS, one after another.
   *
   * The console's read must never wait on a Commander answer, or `/stop` is unreachable for as
   * long as the model takes, so a line for the Commander is chained here and the console goes
   * straight back to reading. One chain, because `ChatSession` runs one turn at a time. Awaited
   * in the dispatch's `finally`, after the console, so an answer in flight finishes printing
   * before the outcome does, and reset at each dispatch.
   */
  let commanderChain: Promise<void> = Promise.resolve();
  /** When the running dispatch was approved. For the situation's elapsed reading. */
  let dispatchStartedAt = 0;
  /** The objective the human approved for the running dispatch, from this process's memory. */
  let dispatchObjective = '';
  /** The last narration lines, plain, oldest first. Cleared per dispatch. */
  const recentNarration: string[] = [];
  /** True between `/stop` and the y/N that answers it. */
  let stopArmed = false;
  /** The dispatch's own abort, or null when nothing is running. See `CampaignOptions.abortSignal`. */
  let stopController: AbortController | null = null;

  const rosterUpdate = (agentId: string, change: Partial<RosterRow>): void => {
    const row = roster.find((entry) => entry.agentId === agentId);
    if (row !== undefined) Object.assign(row, change);
  };

  /**
   * Make room on the bar without dropping a unit that is still running.
   *
   * This was `roster.slice(-ROSTER_MAX)`, which keeps the NEWEST rows — exactly backwards. The
   * oldest row is the Engineer, and the newest are whatever settled most recently, so a campaign
   * that produced four settled rows would evict the one unit still working in order to keep four
   * that had finished. A working unit is evicted only when there is nothing settled to drop.
   */
  const evictRoster = (rows: readonly RosterRow[]): RosterRow[] => {
    const excess = rows.length - ROSTER_MAX;
    if (excess <= 0) return [...rows];
    const doomed = new Set<RosterRow>();
    // Settled rows first, oldest first — they are history, and history is what scrollback is for.
    for (const row of rows) {
      if (doomed.size >= excess) break;
      if (row.state !== 'working') doomed.add(row);
    }
    for (const row of rows) {
      if (doomed.size >= excess) break;
      doomed.add(row);
    }
    return rows.filter((row) => !doomed.has(row));
  };

  /**
   * Roster bookkeeping, from the same events the narration prints.
   *
   * Not a second source of truth: every field here comes off a `ProgressEvent` that was emitted
   * next to the `appendSignal` for the same moment, so the bar cannot claim a unit the archive
   * does not have. What it adds is DURATION — the stream says a unit was dispatched, and only
   * something holding a clock can say it has been working for four minutes.
   */
  const rosterObserve = (event: ProgressEvent): void => {
    switch (event.kind) {
      case 'campaign-opened':
        // The one event that names the archive this dispatch is writing to, and therefore the
        // earliest moment the block can start reading a real tree out of it.
        openTree(event.campaignId);
        return;

      case 'unit-dispatched':
        // Counted from the EVENT and not from the polled tree, so the budget row moves on the
        // first spawn rather than on the first poll after it. A fan-out that appears a second
        // late is a fan-out somebody has already stopped watching for.
        agentsSpawned.add(event.agentId);
        roster.push({
          agentId: event.agentId,
          rank: event.rank,
          role: event.role,
          harness: event.harness,
          attempt: event.attempt,
          state: 'working',
          detail: null,
          detailSince: null,
          thinkingTokens: null,
          since: nowMs(),
          lastEventAt: nowMs(),
        });
        if (roster.length > ROSTER_MAX) roster = evictRoster(roster);
        return;

      // ---- activity: the four fifths of a run that used to be blank ---------------------------
      //
      // These move `detail` and the two activity clocks. They must NEVER touch `since`: it is what
      // `elapsedMs` is measured from, and a unit that has been working for fourteen minutes has
      // been working for fourteen minutes regardless of how recently it called a tool.
      case 'unit-acting': {
        // Depth 0 only. A native subagent's tool call belongs to the SERGEANT that made it, and
        // painting it on the Captain's row would attribute a subordinate's work to its supervisor
        // — on the one surface whose entire job is saying who is doing what.
        if (event.depth !== 0) return;
        const call = event.target === '' ? event.tool : `${event.tool}(${event.target})`;
        rosterUpdate(event.agentId, {
          detail: call,
          detailSince: nowMs(),
          lastEventAt: nowMs(),
        });
        return;
      }

      case 'unit-acted':
        // Deliberately does NOT clear `detail`. See `RosterUnit.detailAgeMs`.
        rosterUpdate(event.agentId, { lastEventAt: nowMs() });
        return;

      case 'unit-thinking':
        rosterUpdate(event.agentId, { thinkingTokens: event.tokens, lastEventAt: nowMs() });
        return;

      case 'unit-blocked':
        rosterUpdate(event.agentId, {
          detail:
            event.target === ''
              ? `${event.tool} refused`
              : `${event.tool}(${event.target}) refused`,
          detailSince: nowMs(),
          lastEventAt: nowMs(),
        });
        return;

      case 'unit-returned':
        rosterUpdate(event.agentId, {
          // An adapter status other than `ok` is a unit that did not come back usefully — a
          // reviewer that hit its account's usage limit, an Engineer whose process died. Drawn
          // as `failed` rather than `returned`, because the roster's whole job is to be readable
          // at a glance and a red row is the difference between "this finished" and "this is why
          // the campaign is about to refuse".
          state: event.status === 'ok' ? 'returned' : 'failed',
          detail: event.summary,
          since: nowMs(),
          detailSince: nowMs(),
          lastEventAt: nowMs(),
          // A unit that has returned is not thinking. Left in place it would keep a live-looking
          // token count next to a finished row, which is the shape of a bar that has stopped
          // tracking reality — and this file's one rule is that the bar only ever reads.
          thinkingTokens: null,
        });
        return;
      case 'verdict':
        // The verdict overwrites the Inspector's own `returned` row rather than adding one: a
        // unit is one row, and PASS/FAIL is the most informative thing that row will ever say.
        rosterUpdate(event.agentId, {
          state: event.verdict === 'pass' ? 'passed' : 'failed',
          detail: event.summary,
          since: nowMs(),
          detailSince: nowMs(),
          lastEventAt: nowMs(),
          thinkingTokens: null,
        });
        return;
      default:
        // AN UNKNOWN KIND DEGRADES TO NOTHING, and that is a deliberate contract rather than a
        // missing case. `ProgressEvent` belongs to its emitter and gains kinds as the campaign
        // gains moments to report; this switch is one consumer of it. An unrecognised kind leaves
        // the roster, the budget and the tree exactly as they were. The narration still prints
        // it (that is `renderProgressEvent`'s job, and its switch is exhaustive so a new kind
        // cannot be added without a line for it), and the tree still shows it, because the tree is
        // read from the archive rather than accumulated from these events. So the cost of a kind
        // this file has never heard of is one clock that does not restart, and never a throw from
        // inside a listener that runs while a worktree lease is held.
        return;
    }
  };

  // ---- the live tree ------------------------------------------------------------------------
  //
  // The block draws the SAME `TreeModel` `army view` draws, built by the same `buildTree` from a
  // real `CampaignSnapshot` read off the running campaign's own files. Not a model reconstructed
  // from the narration: that would be a second derivation of the thing the block exists to show,
  // and the two would disagree the first time an event was added on one path and not the other.
  // The reader is the one `army view --follow` polls with, at its default rate, and it re-reads
  // only the bytes appended since the last poll.

  const treePollMs = Math.max(50, options.treePollMs ?? 1000);
  let treeReader: CampaignReader | null = null;
  let treeTimer: ReturnType<typeof setInterval> | null = null;
  /** The last good model. Kept after a dispatch ends so `/work` still has something to answer. */
  let tree: TreeModel | null = null;
  /** True only while a campaign is actually running. It decides whether the BLOCK draws it. */
  let treeLive = false;
  /** The running (or last) campaign's directory, for `/work`'s orders and diff. */
  let dispatchRoot: string | null = null;
  /** The running dispatch's campaign id, for the pointer a situation gives the Commander. */
  let dispatchCampaignId = '';
  /**
   * What the RUNNING campaign has spent, as its own archive reports it, or null when nothing has.
   *
   * Null and not 0: a harness that reports no cost and a campaign that has spent nothing are
   * different facts, and the bar may not merge them. It is the rule `RosterUnit.thinkingTokens`
   * states one layer down.
   */
  let campaignCostUsd: number | null = null;
  /**
   * What the campaigns this session has ALREADY finished spent, folded in as each one ends.
   *
   * Separate from the live figure because the live one is rebuilt per dispatch from a fresh
   * reader, and a session's second dispatch would otherwise reset the bar to that dispatch's
   * spend alone, and a bill that goes DOWN as more work is done is the one number on this bar
   * would be worse than absent.
   */
  let finishedCampaignsUsd: number | null = null;
  /** Agents this dispatch has raised. From the events, so the bar moves on the FIRST spawn. */
  let agentsSpawned = new Set<string>();
  const concurrencyCap =
    options.overseer === true
      ? Math.max(1, options.maxConcurrentWorkstreams ?? DEFAULT_MAX_CONCURRENT_WORKSTREAMS)
      : // Without an overseer a campaign runs ONE workstream over the whole objective, whatever
        // the cap says. Printing 3 there would be a number the pool is not enforcing.
        1;

  const refreshTree = (): void => {
    const reader = treeReader;
    if (reader === null) return;
    try {
      tree = buildTree(reader.read(false), { now: new Date(nowMs()) });
      let spent = 0;
      let reported = false;
      for (const row of walkTree(tree)) {
        if (row.node.kind !== 'unit' || row.node.costUsd === null) continue;
        spent += row.node.costUsd;
        reported = true;
      }
      // Null, not 0, when nothing has reported a cost. A harness that reports none and a campaign
      // that has spent nothing are different facts, and the bar may not merge them. It is the rule
      // `RosterUnit.thinkingTokens` states one layer down.
      campaignCostUsd = reported ? spent : null;
    } catch {
      // The archive is being appended to by another process as this reads it. A torn read costs
      // the block one frame of freshness, never a session: it keeps the last good model.
    }
  };

  const openTree = (id: string): void => {
    dispatchCampaignId = id;
    try {
      treeReader = openCampaignReader({ archiveRoot, campaignId: id, source: 'files', self });
      dispatchRoot = treeReader.campaignRoot;
      treeLive = true;
      refreshTree();
      treeTimer = setInterval(refreshTree, treePollMs);
      if (typeof treeTimer.unref === 'function') treeTimer.unref();
    } catch {
      // No readable archive means no tree, and the roster answers instead. A decoration is never
      // a reason to fail a dispatch.
      treeReader = null;
    }
  };

  const closeTree = (): void => {
    if (treeTimer !== null) {
      clearInterval(treeTimer);
      treeTimer = null;
    }
    // One last read, so the tree `/work` answers from is the campaign's ENDING rather than its
    // last poll, which on a fast campaign can be several units out of date.
    refreshTree();
    treeLive = false;
    try {
      treeReader?.close();
    } catch {
      /* nothing is held open; this is the seam's own contract, not a promise about the future */
    }
    treeReader = null;
  };

  /**
   * How many rows the block may spend on the tree.
   *
   * `statusRows` in `src/chat/io.ts` REFUSES to draw a block that does not leave the conversation
   * two rows, so a renderer that asked for one row too many would not be trimmed: it would
   * vanish, and a reader has no way to tell a suppressed block from a broken one. The arithmetic
   * is therefore done here, against the terminal's real height: two rows for that rule, one for
   * the context row the block always ends with, and never more than a third of the window, because
   * the window is for the conversation.
   */
  const treeBudget = (): number => {
    const rows = io.rows;
    if (rows <= 0) return DEFAULT_TREE_ROWS;
    return Math.max(0, Math.min(DEFAULT_TREE_ROWS, rows - 3, Math.max(1, Math.floor(rows / 3))));
  };

  /** Session and campaigns together. Two costs on one bar, differing, is a bar arguing with itself. */
  const totalCostUsd = (): number | null => {
    const parts = [session.costUsd, finishedCampaignsUsd, campaignCostUsd];
    if (parts.every((part) => part === null)) return null;
    return parts.reduce((total: number, part) => total + (part ?? 0), 0);
  };

  const budgetModel = (): BudgetModel | null => {
    if (!dispatchInFlight || agentsSpawned.size === 0) return null;
    return { agents: agentsSpawned.size, cap: concurrencyCap, costUsd: totalCostUsd() };
  };

  /**
   * What the bar says, sampled at paint time.
   *
   * `hint` displaces the counters rather than joining them, and the order of these three branches
   * is the order of how badly the reader needs them. A dispatch in flight is the state where
   * Ctrl-C behaves differently from everywhere else in the session — it does not interrupt, it
   * waits, because a campaign holds a worktree lease that only its own cleanup may settle. That
   * is a surprising rule to meet for the first time by pressing the key, and the bar is the only
   * surface that can say it while it is true.
   */
  const statusModel = (): StatusModel => {
    // Before the dispatch-in-flight branch, because a parked question is ALSO a dispatch in
    // flight and the reader is the reason it is parked. "Ctrl-C lets it settle" is true and
    // useless when what the campaign is waiting for is this person typing.
    const hint = stopArmed
      ? 'y stops the campaign and settles every worktree; anything else carries on'
      : inbox.size > 0
      ? // Cut to a third of its length after a pty run at 100 columns, twice. The seventy-column
        // version pushed the agent count and the spend clean off the row; making the budget
        // reserved then pushed the HINT off instead. The count of what is open is its own segment
        // now, so this no longer has to carry it, and what is left is the only thing a hint has
        // ever been for: what the next keystroke does. The full sentence still prints in
        // scrollback under the question, where there is room for it. That is `ANSWER_HINT`.
        'asking: type to answer, Ctrl-C to skip'
      : dispatchInFlight
      ? 'dispatch in flight — Ctrl-C lets it settle, /stop ends it'
      : awaitingApproval !== null
        ? `approve to ${awaitingApproval === 'scout' ? 'send the scout' : 'dispatch'}, anything else declines`
        : exitArmed
          ? 'Ctrl-C again to leave'
          : null;
    const at = nowMs();
    return {
      repo,
      project: path.basename(project),
      model: spec.model ?? '',
      rung: `rung ${String(requestedRung)} (${RUNG_LABEL[requestedRung]})`,
      turns: humanTurns,
      dispatches: dispatches.filter((record) => record.approved).length,
      costUsd: totalCostUsd(),
      tree: treeLive ? tree : null,
      treeRows: treeBudget(),
      questions: inbox.size,
      budget: budgetModel(),
      // Every clock is computed HERE, at paint time, from a timestamp the loop stored — which is
      // what keeps `src/view/chrome.ts` free of a clock and therefore unit-testable at a fixed
      // instant. `detailAgeMs` stays null until something has actually been reported: a row that
      // has never seen a tool call has no age to state, and stating `0` would claim otherwise.
      roster: roster.map((row) => ({
        ...row,
        elapsedMs: at - row.since,
        detailAgeMs: row.detailSince === null ? null : at - row.detailSince,
        silentMs: at - row.lastEventAt,
      })),
      hint,
    };
  };

  const statusRenderer: StatusRenderer = (tick, width) =>
    renderStatusBar(statusModel(), tick, { charset, color: detectColor(env, io.isTTY), width });

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
  /**
   * A block of prose, wrapped to the terminal and indented, ready for `io.write`.
   *
   * FOUND BY DRIVING THE REAL BINARY, not by a unit test: the recce description and the finding's
   * attribution line each went out as one `write`, and at 100 columns the terminal hard-broke them
   * at its right edge, mid-word — `may field a / t most 4`, `2 subordinate(s) cont / ributed`. The
   * commander's own prose has been wrapped since `src/view/prose.ts` was built precisely to end
   * that, and a screen where one speaker's paragraphs wrap and this process's shatter reads as
   * broken rendering rather than as two speakers.
   *
   * `io.width` is read AT WRITE TIME rather than captured, for the same reason `StatusRenderer`
   * takes a width: somebody drags a window and a captured number starts producing rows that wrap.
   *
   * The MARKER goes on the first row only and continuation rows are padded to the same width, so
   * a wrapped finding reads as one finding. Repeating the marker down every row was the first
   * spelling and it turns a two-row bullet into two bullets, which is the same class of lie as
   * the hard break it replaced.
   */
  const wrapBlock = (marker: string, text: string): string => {
    const room = Math.max(20, io.width - displayWidth(marker));
    const pad = ' '.repeat(displayWidth(marker));
    return wrapPlain(text, room)
      .map((row, index) => `${index === 0 ? marker : pad}${row}\n`)
      .join('');
  };

  const guardedWrite = (text: string): void => {
    try {
      io.write(text);
    } catch {
      /* the reader is gone; that is never a reason to take the process with it */
    }
  };

  const onInterrupt = (): void => {
    void (async (): Promise<void> => {
      // BEFORE the dispatch branch, and that order is the fix.
      //
      // A parked question is also a dispatch in flight, so this used to fall into the branch
      // below, which returns early — `io.abortLine()` was unreachable and `exitArmed` was never
      // set, and the only ways out of an answer prompt anybody could find were Enter and `kill
      // -9`. The narration was false as well: it said the dispatch was "settling" when nothing was
      // settling, because the campaign was blocked on the very keystroke that had just been
      // pressed.
      //
      // A blank answer already means "unanswered" and the campaign already treats it as silence —
      // the attempt ends and the lease is settled by the campaign's own cleanup, exactly as it
      // would have been with no way to ask at all. So the outcome already existed and only the
      // path to it was missing. This press takes it: the question goes unanswered, the dispatch
      // keeps running and keeps its lease, and control comes back. It does NOT arm the exit — one
      // gesture, one meaning — so a press after this one lands in the branch below, where the
      // "letting it settle" line is now true.
      if (inbox.size > 0) {
        guardedWrite('\n  ^C  leaving the question unanswered — the dispatch keeps its worktree.\n');
        // Set BEFORE the abort, and that order is load-bearing: `abortLine` resolves the console's
        // read, and the console has to be able to tell this press from end of input, which arrives
        // as the same `null`. State a later reader depends on never sits downstream of a call that
        // can hand control to it.
        consoleInterrupted = true;
        // `keepQueued`, because the session is not ending: the lines behind this read were typed
        // for the Commander and it is still there to receive them.
        io.abortLine({ keepQueued: true });
        return;
      }
      // AFTER the inbox and BEFORE the dispatch, because a gate is neither. Nothing has been
      // spawned and nothing holds a lease — the whole point of the gate is that it runs before any
      // of that — so this press can simply stop it, which is the one gesture that used to reach
      // nothing at all: the loop is inside `runAlignmentGate` rather than on a read, so
      // `abortLine` had no read to unblock and the session sat through every command's deadline.
      //
      // It does NOT arm the exit. One gesture, one meaning: this press stopped the gate, and the
      // press after it lands wherever the session is by then.
      const gate = gateAbort;
      if (gate !== null) {
        guardedWrite(
          '\n  ^C  stopping the alignment gate. Nothing has been dispatched, and every command it ' +
            'did not reach is recorded as unrun rather than as passed.\n',
        );
        gate.abort();
        return;
      }
      if (dispatchInFlight && session.busy) {
        // A Commander answer in flight DURING a dispatch. Ctrl-C keeps meaning "stop this
        // answer", which is what it means everywhere else in the session, and it must not mean
        // "kill the campaign" here any more than it does below. It does NOT arm the exit: one
        // gesture, one meaning, and a press after this one lands in the branch below, where the
        // "letting it settle" line is true.
        if (interruptBusy) return;
        interruptBusy = true;
        guardedWrite("\n  ^C  stopping the Commander's answer. The dispatch carries on.\n");
        try {
          const stopped = await session.interrupt();
          if (!stopped) {
            guardedWrite('  ◇ the Commander did not stop; its answer prints when it is whole.\n');
          }
        } finally {
          interruptBusy = false;
        }
        return;
      }
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
            'interrupting here would strand the tree and the branch inside it. ' +
            'Type /stop to end the campaign; it confirms, and settles every tree on the way out.',
        });
        return;
      }
      if (exitArmed) {
        // BEFORE the busy check, and that order is the whole fix. It used to sit after, which
        // read sensibly — "stop the answer first, leave second" — but made the exit unreachable
        // whenever a turn could not be stopped: an interrupt receipt that times out (30s), or a
        // CLI that never advertised interrupt_receipt_v1, kept `session.busy` true forever, so
        // every armed press re-entered the busy branch and the only way out was kill -9. Once
        // armed, a press means leave, and a wedged commander is the last reason to refuse.
        if (exitLeaving) return;
        exitLeaving = true;
        exitRequested = true;
        exitReason = 'interrupt';
        guardedWrite('\n  leaving.\n');
        if (session.busy) {
          // The turn cannot be waited out — that is why the user is leaving. `close()` is the
          // best-effort kill: stdin ends, then SIGTERM, then SIGKILL on the short grace set at
          // the adapter above; and the stream ending is what settles the stuck turn, so the main
          // loop wakes and leaves through the same `finally` as /exit — archive written, io
          // closed. A failure here changes nothing: the loop's own close would repeat it.
          try {
            await session.close();
          } catch {
            /* the commander was already gone */
          }
        }
        // Unguarded on purpose: `abortLine` is the thing that actually ends the session, by
        // unblocking the read the loop is parked on. It is a queue operation with no stream
        // under it, and if it ever did throw, swallowing it would park the session forever on a
        // read nobody will answer — a hang with no message, which is worse than a stack trace.
        // What matters is that it is no longer downstream of a write that can throw.
        io.abortLine();
        return;
      }
      if (session.busy) {
        // One interrupt per turn: a second press lands in the armed branch above, so this guard
        // only serialises the receipt round-trip, never the way out.
        if (interruptBusy) return;
        interruptBusy = true;
        try {
          // Arm and acknowledge BEFORE awaiting the receipt. The await is a round trip to a
          // separate process that can take 30s to time out — or never resolve at all — and both
          // used to sit on the far side of it: the user's press was invisible for the whole
          // wait, and the session was not yet armed, so a wedged commander swallowed every
          // subsequent press too. State a later keystroke reads must never sit downstream of an
          // emission, so the assignment comes first.
          exitArmed = true;
          guardedWrite('\n  ^C  stopping this answer — Ctrl-C again to leave.\n');
          const stopped = await session.interrupt();
          // An armed press may have left while this was suspended; its close-out owns the
          // terminal now.
          if (exitRequested) return;
          guardedWrite(
            stopped
              ? '  turn stopped.\n'
              : '  the commander would not stop; waiting for this turn. Ctrl-C again to leave.\n',
          );
        } finally {
          interruptBusy = false;
        }
        return;
      }
      exitArmed = true;
      guardedWrite('\n  ^C  (again to leave, or /exit)\n');
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

  /**
   * The one-line account of a commander that died, and the exit it forces.
   *
   * Nonzero on purpose, where every other way out of a chat exits 0: an inspector FAIL is news
   * about the work, but a commander that died is the tool breaking, and a script watching this
   * command is owed the difference.
   */
  const commanderDeathCloseOut = (): void => {
    exitReason = 'commander-ended';
    exitCode = 1;
    io.write(
      `\n  ✗ the commander is gone — ${session.lastError ?? 'its stream ended without a result'}` +
        '. Ending the session.\n',
    );
  };

  // ---- the dispatch console -------------------------------------------------------------------
  //
  // While a campaign runs there is now a prompt, and one loop owns it. That is the whole of what
  // makes this wave's four commands reachable: a `/stop` nobody can type while sixteen agents are
  // running is not a way to stop them.
  //
  // IT IS ITS OWN READER. `DISPATCH_CONSOLE_ADDRESSEE` is not `COMMANDER_ADDRESSEE`, and that one
  // fact is the whole of what used to be `{ fresh: true }`: a line typed at the Commander's prompt
  // before the dispatch began is addressed to the Commander, so this loop cannot consume it, and no
  // flag has to be remembered to keep that true. A line typed AT this console is addressed to this
  // console, is routed here, and — when it turns out to have been the Commander's after all — goes
  // back through `io.queueLine`, re-addressed, reaching the Commander after the dispatch exactly as
  // it did when nothing was reading at all.

  /**
   * What the composer should say right now, in ONE place.
   *
   * The confirmation outranks the inbox, and it has to be decided here rather than at the point
   * `/stop` is typed: the console re-issues its read after every line, and a prompt set inside a
   * handler was overwritten by the very next `nextLine`, so the y/N that ends a campaign was
   * painted as the ordinary dispatch prompt. Caught on a pty, where the echoed entry read
   * `▪ y` instead of naming what the `y` was answering.
   */
  const promptNow = (): string =>
    stopArmed ? STOP_CONFIRM_PROMPT : inboxPrompt(inbox, ANSWER_PROMPT, DISPATCH_PROMPT);

  /**
   * WHO the composer is reading for right now, which is a different question from what it says.
   *
   * Two prompts can carry the same words and reach different readers — `inboxPrompt` names the
   * agent once several are open — and one reader can be shown two spellings. The routing in
   * `handleConsoleLine` is the authority on where a line goes, and this is that routing's own
   * answer, written once so the composer cannot disagree with it. `src/chat/io.ts` compares it
   * for equality and nothing else.
   */
  const addresseeNow = (): string => {
    if (stopArmed) return 'stop-confirmation';
    const current = inbox.current;
    return current === null ? DISPATCH_CONSOLE_ADDRESSEE : `question:${String(current.id)}`;
  };

  /**
   * A draft the composer gave back because the reader under it changed.
   *
   * The human sees it, always. `io.setPrompt` puts the half-typed entry on the Commander's queue
   * rather than letting a worker's question inherit it, and a draft that vanished from under the
   * cursor with no account of where it went would be the same defect wearing the other hat.
   */
  const announceDisplaced = (draft: string | null): void => {
    if (draft === null) return;
    guardedWrite(
      '  ◇ the line you were typing was addressed to the prompt that just changed. It is queued ' +
        'for the Commander rather than sent to this one:\n' +
        `  ▪ ${draft.replace(/\s+/gu, ' ').trim()}\n`,
    );
  };

  /**
   * A line typed at a y/N prompt that is neither a yes nor a no.
   *
   * `isDecline` is what makes this possible and it is why it is not the complement of `isApproval`:
   * `n`, `no` and a blank line ARE answers to the question that was asked and are consumed by it,
   * and `where is cpt-03?` is not. The `/stop` confirmation has routed the difference since wave 2
   * and the two other y/N prompts in this file swallowed it — printed `no scout sent` and dropped
   * the sentence, which is a line the human typed disappearing under a message that does not
   * mention it.
   *
   * It goes to the COMMANDER rather than to whatever the prompt was about, which is the same rule
   * the whole addressee property states: the line was typed at this session's own confirmation, so
   * it belongs to this session, and a sentence typed at `send a scout? [y/N]` may not become a
   * scout's question or an Engineer's decision. `io.queueLine` re-addresses it, so nothing else
   * can pick it up.
   */
  const keepUnansweredLine = (answer: string): void => {
    if (isDecline(answer)) return;
    io.queueLine(answer);
    guardedWrite(
      '  ◇ that was not a yes or a no, so it was not read as one. It is queued for the Commander ' +
        `as your next turn:\n  ▪ ${answer.replace(/\s+/gu, ' ').trim()}\n`,
    );
  };

  /** Relabel the composer under the read that is already pending. Never ends it. */
  const refreshPrompt = (): void => {
    let displaced: string | null = null;
    try {
      displaced = io.setPrompt(promptNow(), { addressee: addresseeNow() });
    } catch {
      /* a dead terminal cannot be relabelled, and a prompt is never load-bearing */
    }
    announceDisplaced(displaced);
  };

  const sayNextQuestion = (): void => {
    const current = inbox.current;
    if (current === null) return;
    guardedWrite(
      `  ◇ ${String(inbox.size)} still open. answering ${current.question.agentId} ` +
        `(question ${String(current.id)}). /next moves on without answering.\n`,
    );
  };

  /**
   * One question ended with nothing.
   *
   * The sentence is the one the previous wave printed, word for word, because it means exactly
   * what it meant then: the campaign already treats silence as an answer, ends the attempt on it,
   * and settles the lease through its own cleanup. What is new is the address in front of it:
   * with three questions on screen, "no answer" without a name is a fact nobody can act on.
   */
  const NO_ANSWER = 'no answer. the campaign carries on without one.';
  const sayUnanswered = (entry: InboxEntry): void => {
    guardedWrite(`  ◇ ${entry.question.agentId} (question ${String(entry.id)}): ${NO_ANSWER}\n`);
  };

  /** The prompt follows the inbox, never the other way round. */
  const leaveUnanswered = (): void => {
    const left = inbox.skip();
    if (left === null) return;
    sayUnanswered(left);
    refreshPrompt();
    sayNextQuestion();
  };

  const printWork = (id: string): void => {
    guardedWrite(
      renderWorkSnapshot(
        {
          id,
          model: tree,
          campaignRoot: dispatchRoot,
          charset,
          width: io.width,
        },
        {
          read(file: string): SnapshotFile {
            try {
              // Stat first, then read. An `orders.md` is kilobytes and a `diff.patch` can be a
              // worker's entire branch, so the cap is what keeps a command that prints into a
              // conversation from loading a hundred megabytes to count its lines.
              const stat = fs.statSync(file);
              if (stat.size > WORK_FILE_MAX_BYTES) return { kind: 'too-large', bytes: stat.size };
              return { kind: 'content', text: fs.readFileSync(file, 'utf8') };
            } catch {
              return { kind: 'absent' };
            }
          },
        },
      ),
    );
  };

  /**
   * `/stop`, the campaign's own abort path, reached by a typed command.
   *
   * It does NOT settle anything itself, and that is the point. `runCampaign` already kills the
   * soldiers' process trees, records the abort, makes whatever was committed durable and releases
   * every lease through the one `finally` that knows how; a second implementation of that here
   * would be a second thing that can strand a worktree. All this does is ask.
   */
  const requestStop = (): void => {
    const controller = stopController;
    if (controller === null) {
      guardedWrite('  ◇ nothing is running.\n');
      return;
    }
    guardedWrite(
      '  ◇ stopping. The campaign kills its workers, makes whatever is committed durable, ' +
        'and settles every worktree on the way out.\n',
    );
    // BEFORE the abort. A campaign parked on `askHuman` cannot reach the checkpoint that unwinds
    // it until that promise resolves, so a stop that left a question outstanding would be a stop
    // that hangs, waiting on the person who just asked for it.
    for (const left of inbox.drain()) sayUnanswered(left);
    refreshPrompt();
    controller.abort();
  };

  /**
   * One line typed while a dispatch runs.
   *
   * The order of these branches is what the line MEANS, most specific first: a confirmation the
   * session asked for, then a command, then an answer to a parked worker, then, as the default,
   * words for the Commander, which are handed back to its queue rather than consumed here.
   */
  const handleConsoleLine = (line: string): void => {
    const text = line.trim();
    if (stopArmed) {
      stopArmed = false;
      if (isApproval(text)) {
        requestStop();
        return;
      }
      guardedWrite('  ◇ not stopped. the campaign carries on.\n');
      // The confirmation is over either way, so the composer goes back to whatever it was.
      refreshPrompt();
      // `n`, `no` and a blank line ARE the answer to `[y/N]` and are consumed by it.
      if (isDecline(text)) return;
      // Anything else was never a confirmation. It is a line the human typed, and this branch used
      // to swallow it whole — printed "not stopped" and dropped the words, so a `/work cpt-03`
      // typed one keystroke after `/stop` ran nothing and reached nobody. Same family as the
      // draft that a relabel used to hand to a worker, and the same property answers it: the line
      // belongs to the reader it was typed under, and that reader was the confirmation, not a
      // parked worker. So it is routed — as a command, or to the Commander — and `mayAnswer` is
      // FALSE, because a sentence typed at `stop the campaign? [y/N]` was addressed to this
      // session and may not become a decision in somebody's worktree.
      routeConsoleLine(text, { mayAnswer: false });
      return;
    }
    routeConsoleLine(text, { mayAnswer: true });
  };

  /**
   * Where a line typed at the dispatch console goes, once it is known not to be a confirmation.
   *
   * `mayAnswer` is the one caller-visible knob, and it is the wave-2 property in one word: a line
   * may answer a parked worker only when the composer it was typed at was reading FOR that worker.
   */
  const routeConsoleLine = (text: string, options: { mayAnswer: boolean }): void => {
    if (text === '') {
      // A blank line at a question is the documented way to leave it unanswered; anywhere else it
      // is nothing at all, exactly as it is at the Commander's prompt. `mayAnswer` gates it for
      // the same reason it gates the answer below: a blank line typed at `[y/N]` was a decline,
      // and it has already been consumed as one.
      if (options.mayAnswer && inbox.current !== null) leaveUnanswered();
      return;
    }
    const verb = text.split(/\s+/u)[0] as string;
    const rest = text.slice(verb.length).trim();
    switch (verb) {
      case '/stop':
        if (stopController === null) {
          guardedWrite('  ◇ nothing is running.\n');
          return;
        }
        stopArmed = true;
        guardedWrite(
          `  ◇ /stop ends the campaign: ${String(agentsSpawned.size)} agent(s) raised so far, ` +
            'and every worktree in flight is settled rather than dropped.\n',
        );
        // Its own prompt, because y/N here is not the y/N that approves a dispatch and the two
        // must not look the same on the row where the difference is decided. `promptNow` is what
        // chooses it, so the console's next read cannot paint over the choice.
        refreshPrompt();
        return;
      case '/next': {
        if (inbox.size === 0) {
          guardedWrite('  ◇ no questions are open.\n');
          return;
        }
        const moved = inbox.next();
        refreshPrompt();
        if (moved !== null) {
          guardedWrite(
            `  ◇ now answering ${moved.question.agentId} (question ${String(moved.id)}) ` +
              `of ${String(inbox.size)}.\n`,
          );
        }
        return;
      }
      case '/work':
        if (rest === '') {
          guardedWrite('  ◇ /work <agent-id or workstream-id>\n');
          return;
        }
        printWork(rest);
        return;
      case '/help':
        guardedWrite(SLASH_HELP);
        return;
      case '/status':
        // The header, with the working copy as it was last read. Not re-read here: the console
        // routes synchronously so its read is back up before the next keystroke, and a git probe
        // in the middle of a campaign that is committing into worktrees answers for the primary
        // checkout only, which is what was last read anyway.
        guardedWrite(
          chatBanner(
            {
              self,
              project,
              repo,
              ceiling,
              rung: requestedRung,
              model: spec.model ?? '',
              posture: config.permissions.mode,
              campaignId,
              archiveRoot: archive.root,
            },
            chromeStyle(),
          ),
        );
        return;
      case '/exit':
      case '/quit':
        // Handed BACK rather than obeyed. Leaving now would abandon a campaign holding worktree
        // leases that only its own cleanup may settle, and the human did not ask to abandon it:
        // they asked to leave. So the command reaches the loop that can honour it safely, one
        // dispatch later, which is exactly where it landed before anything was reading here.
        io.queueLine(text);
        guardedWrite('  ◇ leaving when the dispatch settles. /stop ends it now.\n');
        return;
      default:
        break;
    }
    if (options.mayAnswer && inbox.current !== null) {
      const answered = inbox.answer(text);
      refreshPrompt();
      if (answered !== null) {
        guardedWrite(
          `  ◇ answered ${answered.question.agentId}: the workstream resumes with it.\n`,
        );
      }
      sayNextQuestion();
      return;
    }
    askCommanderInFlight(text);
  };

  /**
   * What the Commander is told about the running campaign, built from the ARCHIVE.
   *
   * The same `TreeModel` the status block draws and `army view` prints, rendered by the same
   * function at a width nothing will clip, and the roster only when no archive could be opened.
   * Nothing here reads a stream a worker is writing to; the Commander "answers from the archive"
   * because the archive is the only thing this function looks at.
   */
  const situationFacts = (): SituationFacts => {
    let rows: string[];
    if (tree !== null) {
      const rendered = renderTreeRows(tree, { charset: 'ascii', color: false, width: 120 });
      rows = [rendered.header, ...rendered.rows];
      if (rows.length > SITUATION_TREE_MAX_ROWS + 1) {
        const dropped = rows.length - (SITUATION_TREE_MAX_ROWS + 1);
        rows = [
          ...rows.slice(0, SITUATION_TREE_MAX_ROWS + 1),
          `... ${String(dropped)} more row(s) not shown; \`${self} view ${dispatchCampaignId}\` has all of them`,
        ];
      }
    } else {
      rows = roster.map(
        (row) =>
          `${row.agentId} ${row.rank}·${row.role} ${row.state}` +
          (row.detail === null ? '' : ` ${row.detail}`),
      );
    }
    return {
      objective: dispatchObjective,
      elapsedMs: Math.max(0, nowMs() - dispatchStartedAt),
      agentsSpawned: agentsSpawned.size,
      concurrency: concurrencyCap,
      costUsd: campaignCostUsd,
      questionsOpen: inbox.size,
      tree: rows.map(sanitize),
      recent: [...recentNarration],
      archive: dispatchRoot ?? '',
    };
  };

  /**
   * One Commander turn taken while a dispatch runs. Runs on `commanderChain`, never awaited by
   * the console.
   *
   * If the dispatch settled before this turn's place in the chain came up, the line goes back to
   * the ordinary queue and the main loop takes it as an ordinary turn: a situation describing a
   * campaign that is over would be a turn built on a stale fact, and the `dispatch-result` turn
   * that follows is the one that should describe how it ended.
   */
  const commanderTurnInFlight = async (text: string): Promise<void> => {
    if (!dispatchInFlight) {
      io.queueLine(text);
      guardedWrite('  ◇ the dispatch settled first; that line reaches the Commander next.\n');
      return;
    }
    if (session.ended) {
      guardedWrite('  ◇ the Commander is gone, so nothing can answer that. The dispatch carries on.\n');
      return;
    }
    humanTurns += 1;
    archive.appendSignal({
      fromAgent: GENERAL_AGENT_ID,
      toAgent: COMMANDER_AGENT_ID,
      kind: 'order',
      body: cap(text),
    });
    holdAnswer = true;
    let turn: TurnResult;
    try {
      turn = await session.humanTurnInFlight(text, situationFacts());
    } catch (error) {
      holdAnswer = false;
      const message = error instanceof Error ? error.message : String(error);
      guardedWrite(`  ✗ the Commander could not be asked: ${message}\n`);
      return;
    }
    holdAnswer = false;
    try {
      // The narration ticker owns the current line while a campaign runs, exactly as it does
      // when a worker's question arrives; `setIdle` is idempotent and takes it down.
      io.setIdle();
      // Whole, as one block, through the same gutter every other answer uses.
      beginAnswer(true);
      if (prose === null) io.write(turn.text);
      else prose.push(turn.text);
      endAnswer();
      io.write('\n');
      recordCommanderTurn(turn.text, turn.refusals);
      if (turn.status === 'error' && turn.errors.length > 0 && !commanderGone) {
        io.write(`\n  ✗ ${turn.errors[0] as string}\n`);
      }
    } catch {
      /* the reader is gone; that is never a reason to end a campaign holding a lease */
    }
    refreshPrompt();
  };

  /**
   * A line typed for the Commander while a dispatch runs.
   *
   * It USED to be queued for the moment the dispatch settled, which made the Commander the one
   * party in the session that could not be spoken to while the thing it started was running. Now
   * it is a turn, taken as soon as the Commander is free, briefed from the archive, and the
   * console keeps reading throughout, so `/stop` is one line away the whole time.
   */
  const askCommanderInFlight = (text: string): void => {
    if (session.ended) {
      guardedWrite('  ◇ the Commander is gone, so nothing can answer that. The dispatch carries on.\n');
      return;
    }
    guardedWrite(
      session.busy
        ? '  ◇ the Commander is still answering; this reaches it next.\n'
        : '  ◇ asked the Commander, with the campaign\'s state from the archive. Its answer prints ' +
            'whole; Ctrl-C stops it, and the dispatch carries on either way.\n',
    );
    commanderChain = commanderChain
      .then(() => commanderTurnInFlight(text))
      .catch(() => undefined);
  };

  /**
   * The loop. One read at a time, for the life of one dispatch.
   *
   * It CANNOT throw and it cannot end without resolving what it was holding. Both are load-bearing
   * in the same way: this promise is awaited in a `finally` that runs while a campaign may still
   * hold a worktree lease, and a question left parked is a workstream that never finishes.
   */
  const dispatchConsole = async (): Promise<void> => {
    try {
      while (consoleActive) {
        const line = await io.nextLine(promptNow(), { addressee: addresseeNow() });
        // The dispatch finished while this read was parked, and the `finally` aborted it to get
        // here. Nothing was typed; there is nothing to route.
        if (!consoleActive) return;
        if (line === null) {
          if (consoleInterrupted) {
            consoleInterrupted = false;
            leaveUnanswered();
            continue;
          }
          // End of input, a closed terminal, or a commander death that aborted every read. Nothing
          // more will ever be typed here, so the loop stops, and everything it was holding is let
          // go on the way out, because a promise nobody will ever resolve is a parked worktree.
          return;
        }
        handleConsoleLine(line);
      }
    } catch {
      /* a console that cannot read is never a reason to end a campaign holding a lease */
    } finally {
      consoleActive = false;
      for (const left of inbox.drain()) sayUnanswered(left);
    }
  };

  // ---- phase 1: the scout ---------------------------------------------------------------------
  //
  // THE SUPERVISING PROCESS SPAWNS. A model never does. The commander's reply may carry a recce
  // block; this process reads it, prints the question, waits for a keystroke, and only then builds
  // a spec and starts a process. That is the same rule the dispatch path follows, and a recce does
  // not get an exception for reading rather than writing — it costs money and it reaches the
  // network.
  //
  // Shaped like `spawnOverseer` in `campaign.ts` and for the same reason: `src/command/scout.ts`
  // holds the decisions and spawns nothing, so this is the only place a `CPT·SCOUT` is built and
  // it goes through `buildSoldierSpec` like every other worker. There is no second spawn path
  // where a worker could be assembled without the global deny-list.
  /** The last thing the human typed, for the scout's `## WHAT IS ALREADY SETTLED` section. */
  let pendingHumanContext = '';

  /** Glyphs for the gate block. One charset decision, made once, where the session made it. */
  const glyph = glyphsFor(charset);

  /**
   * What the gate did with a proposal, for the session's record.
   *
   * `null` means the gate was never entered because the proposal carried no spec — a state the
   * record has to be able to state, because "the gate did not refuse it" and "there was no gate"
   * are different facts and a boolean would collapse them.
   */
  const gateOf = (result: AlignmentResult | null): ChatDispatchRecord['gate'] =>
    result === null ? 'no-spec' : result.passed ? 'passed' : 'refused';

  /** Cap one half of a recorded round, marking the cut rather than hiding it. */
  const capHalf = (raw: string): string =>
    codePointLength(raw) <= INTERROGATION_HALF_MAX_CHARS
      ? raw
      : `${[...raw].slice(0, INTERROGATION_HALF_MAX_CHARS).join('')}\n\n_[truncated at ${String(
          INTERROGATION_HALF_MAX_CHARS,
        )} characters]_`;

  /**
   * Bank one round of the interrogation: the commander's last question and the answer to it.
   *
   * Neutralised at capture by `captureTurn` — both halves, the human's included. The human's is
   * not neutralised because a human is untrusted; it is neutralised because this document is read
   * with `cat` and `less`, which obey an escape byte whoever typed it, and a filter with an
   * exception is a filter with a hole shaped like the exception.
   */
  const recordRound = (answer: string): void => {
    interrogationRounds += 1;
    interrogation.push(
      captureTurn({
        round: interrogationRounds,
        at: options.now === undefined ? new Date().toISOString() : options.now(),
        commander: capHalf(pendingQuestion),
        human: capHalf(answer),
      }),
    );
    // Newest last. A spec is settled at the END of an interrogation, so the rounds worth keeping
    // when a conversation runs long are the recent ones; `renderInterrogationDocument` numbers
    // them with the round they actually were, so a document beginning at 61 says so.
    while (interrogation.length > MAX_INTERROGATION_ROUNDS) interrogation.shift();
  };

  const spawnScout: ScoutSpawn = async (input) => {
    scoutCounter += 1;
    const agentId = `cpt-${String(scoutCounter).padStart(2, '0')}`;
    // The vendor and the model come from the user's config, exactly as every other worker's do.
    // The EFFORT does not, and the override is the same judgement `dispatchFor` makes for a
    // spec-less ENGINEER: the configured `low` is a measured default for a worker whose thinking
    // was done above it, and a scout by definition has none — it is being sent to produce the
    // information a spec would have carried. Escalating here rather than widening `dispatchFor`
    // keeps the decision at the one call site it applies to.
    const target = dispatchFor(config, 'SCOUT', false);
    const scoutSpec = buildSoldierSpec({
      agentId,
      rank: 'CAPTAIN',
      role: 'SCOUT',
      harness: 'claude',
      ...(target.model === undefined ? {} : { model: target.model }),
      effort: UNSPECIFIED_BRIEF_EFFORT,
      // The primary checkout. A SCOUT HOLDS NO WORKTREE: a lease exists to isolate and recover a
      // writing worker's changes, and `ROLE_WRITES_FILES.SCOUT` is false, so there is nothing to
      // isolate. Nothing below leases one and nothing releases one.
      cwd: project,
      orders: input.orders,
      outputSchemaPath: input.outputSchemaPath,
      home,
      posture: config.permissions.mode,
      // The roster. `buildSoldierSpec` builds it from the rank table, refuses one whose
      // subordinates would hold a tool their parent does not, and the claude adapter pins the
      // nesting cap to `maxSubagentDepth('CAPTAIN')` — which is 1. That is the DEPTH ceiling, and
      // none of it is this call site's to get right. The COUNT ceiling is below.
      fanOut: true,
    });

    const scoutTask = archive.createTask({
      parentTaskId: task.id,
      title: `scout: ${cap(input.question, 100)}`,
      status: 'in_flight',
    });
    archive.recordAgentAttempt({
      id: agentId,
      taskId: scoutTask.id,
      parentAgentId: COMMANDER_AGENT_ID,
      rank: 'CAPTAIN',
      role: 'SCOUT',
      harness: 'claude',
      model: scoutSpec.model ?? null,
      effort: scoutSpec.effort ?? null,
      sessionId: scoutSpec.sessionId,
      depth: 2,
      status: 'running',
      // Null, and it is the honest value rather than a placeholder: this unit has no tree.
      worktreePath: null,
      leaseId: null,
      orders: input.orders,
      attempt: 1,
    });
    archive.appendSignal({
      fromAgent: GENERAL_AGENT_ID,
      toAgent: agentId,
      kind: 'order',
      body: cap(`recce: ${input.question}`),
      artifact: `agents/${agentId}/orders.md`,
    });

    // The adapter is built here rather than taken from the registry so the recce's own wall clock
    // rides on it. `closeGraceMs` IS a one-shot worker's whole working time — `runSoldier` closes
    // stdin straight after the orders — so this is the ceiling that stops a running recce on the
    // clock, and the adapter's own 300s default would be the wrong one in both directions.
    const adapter =
      options.adapters?.claude ??
      createClaudeAdapter({
        closeGraceMs: SCOUT_TIMEOUT_MS,
        ...(options.claudeBin === undefined ? {} : { bin: options.claudeBin }),
      });

    // ---- the COUNT ceiling, which is the half the harness does not enforce ------------------
    //
    // The roster says WHO may be fielded and has no position for HOW MANY. `watchFanOut` counts
    // distinct subordinates off the normalised stream and reports the crossing exactly once.
    //
    // THE HALT IS A KILL, and the first version of this was not. It tried `interrupt()` first, on
    // the reasoning that the scout's answer so far survives an interrupt and does not survive a
    // kill — and that reasoning is sound and the code was dead. MEASURED by driving a scout that
    // fans out past the ceiling under a real pipe: `runSoldier` closes stdin immediately after
    // sending the orders, so by the time any event reaches this listener the claude adapter's
    // `interrupt()` rejects with `soldier … is not running` and every crossing fell through to the
    // kill anyway. A graceful halt would need a duplex path this one-shot worker does not have.
    //
    // What that costs is worth stating rather than hiding: a scout killed at the crossing usually
    // returns NOTHING, because a unit that is still fanning out has not answered yet. When it has
    // already emitted a finding the pump has banked the text and it survives — which is real, and
    // is the uncommon case rather than the reassuring one.
    const watch = watchFanOut(SCOUT_MAX_SUBAGENTS);
    let live: Soldier | null = null;
    const run = await runSoldier(adapter, scoutSpec, archive, {
      onSpawn: (soldier) => {
        live = soldier;
      },
      onEvent: (event) => {
        if (!watch.observe(event)) return;
        const soldier: Soldier | null = live;
        if (soldier === null) return;
        // ONE LINE here. This runs inside the loop draining the child's stdout, and the note
        // channel clips at `PROGRESS_SUMMARY_MAX` and does not wrap — the paragraph version came
        // out truncated mid-word across three hard-broken rows on a real pty. The full account is
        // in the block below, where there is room for it.
        narrate({ kind: 'note', level: 'warn', message: fanOutHaltLine(SCOUT_MAX_SUBAGENTS) });
        // SIGKILL to the whole process group, so the subordinates go with it — they are threads of
        // the same process, and anything it left running is a grandchild.
        if (killSoldierTree(soldier)) return;
        // No kill seam. Only an injected adapter reaches here (a test, a future harness), and the
        // polite close is the only stop that exists then. Idempotent, so racing `runSoldier`'s own
        // close is not a hazard, and guarded because a halt must never become the exception that
        // ends the conversation.
        void soldier.close().catch(() => {
          /* it was already going down; that is the outcome this branch wanted */
        });
      },
    });

    archive.finishAgent(agentId, {
      status: run.status === 'ok' ? 'exited' : 'failed',
      costUsd: run.costUsd,
    });
    archive.updateTask(scoutTask.id, {
      status: run.status === 'ok' && run.structured !== undefined ? 'done' : 'failed',
    });

    return {
      agentId,
      structured: run.structured,
      status: run.status,
      errors: run.errors,
      subagentsFielded: watch.count,
      haltedForFanOut: watch.halted,
      costUsd: run.costUsd,
    };
  };

  /**
   * Send one scout and print what it found. Returns the finding's lines, or null.
   *
   * Everything worker-authored on this path has already been through `sanitize` at capture in
   * `src/command/scout.ts`, so what is printed here and what reaches the overseer's brief are the
   * same neutralised strings — and the block says whose words they are, on the line above them,
   * because a finding printed under this process's own glyphs and nothing else is a finding a
   * reader will attribute to this process.
   */
  const sendScout = async (question: string): Promise<RecceOutcome> => {
    const outcome = await runRecce({
      spawn: spawnScout,
      question,
      spentUsd: recceSpendUsd,
      renderBrief: () =>
        renderScoutBrief({
          question,
          project,
          campaignId,
          maxSubagents: SCOUT_MAX_SUBAGENTS,
          timeoutMs: SCOUT_TIMEOUT_MS,
          // Supervisor-held: the objective as the human typed it, never a subordinate's account.
          ...(pendingHumanContext === '' ? {} : { context: pendingHumanContext }),
        }),
    });
    // `chargedUsd`, never `costUsd`. The old line was `if (costUsd !== null)`, which added nothing
    // for a HALTED recce — SIGKILLed before the `result` event that carries the cost — so the
    // single most expensive thing this conversation can do (five model sessions) was free to the
    // budget `refuseOnBudget` guards, while a one-subordinate recce that finished properly was
    // charged $0.11. See `unreportedRecceUsd`.
    recceSpendUsd += outcome.chargedUsd;
    return outcome;
  };

  // After the interrupt handler is wired, so a Ctrl-C during the opening turn already finds a bar
  // that knows how to say what that key will do.
  if (chrome) io.setStatus(statusRenderer);

  try {
    await session.open();

    beginAnswer(false);
    io.setBusy('commander');
    const opening = await session.openingTurn(standingOrders);
    settle();
    endAnswer();
    io.write('\n');
    recordCommanderTurn(opening.text, opening.refusals);

    while (!exitRequested) {
      // Before the read, not after: a commander that died on the previous turn must not be given
      // a fresh prompt at all — the field observation was exactly that prompt, sitting live over
      // a corpse, with the next input going nowhere.
      if (commanderGone) {
        commanderDeathCloseOut();
        break;
      }
      const line = await io.nextLine(PROMPT, { addressee: COMMANDER_ADDRESSEE });
      if (line === null) {
        // `onEnded` aborts a parked read, so a null line is how a death at the prompt arrives
        // here. An exit the human asked for keeps its own reason.
        if (!exitRequested) {
          if (commanderGone) commanderDeathCloseOut();
          else exitReason = 'eof';
        }
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
      // The three campaign commands answer HERE too, rather than being unknown outside a
      // dispatch. A command that exists only while something is running is a command whose error
      // message is "the commander did not understand that", which is the wrong answer twice: it
      // blames the reader, and it spends a turn asking a model about a word this loop owns.
      if (text === '/stop') {
        io.write('  ◇ nothing is running.\n');
        continue;
      }
      if (text === '/next') {
        io.write('  ◇ no questions are open.\n');
        continue;
      }
      if (text === '/work' || text.startsWith('/work ')) {
        const id = text.slice('/work'.length).trim();
        if (id === '') io.write('  ◇ /work <agent-id or workstream-id>\n');
        else printWork(id);
        continue;
      }
      if (text === '/status') {
        // The header block again, with the working copy re-read. The bar carries the same facts
        // in one row and drops whatever did not fit; this is the form that fits everything, and
        // it is the only way to ask a question the chrome answers continuously but tersely.
        if (readRepo !== null) repo = await readRepo(project);
        io.write(
          chatBanner(
            {
              self,
              project,
              repo,
              ceiling,
              rung: requestedRung,
              model: spec.model ?? '',
              posture: config.permissions.mode,
              campaignId,
              archiveRoot: archive.root,
            },
            chromeStyle(),
          ),
        );
        continue;
      }

      humanTurns += 1;
      pendingHumanContext = text;
      archive.appendSignal({
        fromAgent: GENERAL_AGENT_ID,
        toAgent: COMMANDER_AGENT_ID,
        kind: 'order',
        body: cap(text),
      });

      beginAnswer(true);
      io.setBusy('commander');
      const turn = await session.humanTurn(text);
      settle();
      endAnswer();
      io.write('\n');
      recordCommanderTurn(turn.text, turn.refusals);
      // The round the human just closed, banked before anything else can consume the turn. The
      // pairing is the commander's LAST question and this answer to it — see `interrogation`.
      recordRound(text);
      pendingQuestion = turn.text;
      // Not when the commander died: the close-out at the top of the loop prints the same
      // message with its consequence attached, and the same sentence twice is noise.
      if (turn.status === 'error' && turn.errors.length > 0 && !commanderGone) {
        io.write(`\n  ✗ ${turn.errors[0] as string}\n`);
      }
      if (exitRequested) break;
      // Back to the top, which diagnoses and leaves. A proposal parsed out of the commander's
      // dying words must not open a confirm flow whose result nobody can be told about.
      if (commanderGone) continue;

      const proposal: DispatchRequest | null = turn.proposal;
      const scoutProposal: ScoutRequest | null = turn.scoutProposal;

      // =====================================================================================
      // ONE REPLY ASKS FOR ONE THING.
      //
      // A turn carrying both a dispatch block and a recce block has asked for two different
      // things at once, and honouring either would be this process choosing which. Refused as a
      // pair, on the same reasoning `parseDispatchDirective` refuses two dispatch blocks:
      // picking one is the supervisor inventing intent, and it would be inventing it at the one
      // prompt where a keystroke is supposed to mean something specific.
      // =====================================================================================
      if (proposal !== null && scoutProposal !== null) {
        const reason =
          'this reply asks for a dispatch AND a recce. One turn asks for one thing; nothing was ' +
          'started. Send the scout, read what it found, and then propose the work — or propose ' +
          'the work if you already know enough to.';
        refusals.push(reason);
        io.write(`\n  ◇ ${reason}\n`);
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          kind: 'status',
          body: cap(`refused: ${reason}`),
        });
        if (commanderGone) continue;
        beginAnswer(true);
        io.setBusy('commander');
        const reaction = await session.scoutDeclinedTurn(scoutProposal.question, reason);
        settle();
        endAnswer();
        io.write('\n');
        recordCommanderTurn(reaction.text, reaction.refusals);
        continue;
      }

      // ---- the recce ------------------------------------------------------------------------
      //
      // Its own keystroke, on its own prompt. A scout reads rather than writes, which makes it
      // cheaper to be wrong about and does not make it free: it is a metered model session that
      // reaches the network, and the rule that a model never spawns anything has no exception for
      // reading.
      if (scoutProposal !== null) {
        const question = scoutProposal.question;
        const query = archive.appendSignal({
          fromAgent: COMMANDER_AGENT_ID,
          toAgent: GENERAL_AGENT_ID,
          kind: 'query',
          body: cap(`requests a recce: ${question}`),
        });
        io.write(`\n  ◇ proposed recce\n${wrapBlock('     ', question)}`);
        io.write(
          wrapBlock(
            '     ',
            'a CPT·SCOUT reads the repository and the web. It writes nothing, holds no worktree, ' +
              `may field at most ${String(SCOUT_MAX_SUBAGENTS)} subordinates and none of them may ` +
              `field any, and has ${String(Math.round(SCOUT_TIMEOUT_MS / 60_000))} minutes.`,
          ),
        );
        awaitingApproval = 'scout';
        const answer = await io.nextLine(SCOUT_CONFIRM_PROMPT, { addressee: 'scout-approval' });
        awaitingApproval = null;
        if (answer === null) {
          archive.appendSignal({
            fromAgent: GENERAL_AGENT_ID,
            toAgent: COMMANDER_AGENT_ID,
            kind: 'answer',
            inReplyTo: query.seq,
            body: 'the session ended before the recce was approved; nothing was sent',
          });
          recces.push({
            question,
            approved: false,
            agentId: null,
            subagentsFielded: 0,
            haltedForFanOut: false,
            costUsd: null,
          });
          if (!exitRequested) {
            if (commanderGone) commanderDeathCloseOut();
            else exitReason = 'eof';
          }
          break;
        }
        if (!isApproval(answer)) {
          io.write('  ◇ no scout sent.\n');
          keepUnansweredLine(answer);
          archive.appendSignal({
            fromAgent: GENERAL_AGENT_ID,
            toAgent: COMMANDER_AGENT_ID,
            kind: 'answer',
            inReplyTo: query.seq,
            body: cap(`declined: ${question}`),
          });
          recces.push({
            question,
            approved: false,
            agentId: null,
            subagentsFielded: 0,
            haltedForFanOut: false,
            costUsd: null,
          });
          if (commanderGone) continue;
          beginAnswer(true);
          io.setBusy('commander');
          const reaction = await session.scoutDeclinedTurn(
            question,
            'the Commander did not approve it',
          );
          settle();
          endAnswer();
          io.write('\n');
          recordCommanderTurn(reaction.text, reaction.refusals);
          continue;
        }

        io.write('  ◇ scouting — one CPT·SCOUT, reading only.\n');
        // The same narration sink a dispatch uses, built and closed with the recce, for the same
        // reason: a session-long sink is one whose ticker can outlive the thing that started it.
        const scoutSink = createProgressSink({
          stream: io,
          self,
          charset,
          live: io.isTTY && !chrome,
        });
        narrate = guardedProgress((event) => {
          scoutSink.emit(event);
        });
        let outcome: RecceOutcome;
        try {
          outcome = await sendScout(question);
        } catch (error) {
          outcome = {
            kind: 'unavailable',
            reason: `the recce could not be run: ${error instanceof Error ? error.message : String(error)}`,
            agentId: null,
            costUsd: null,
            // ONE SESSION, not zero. `runRecce` threw, so `runSoldier` never returned and there is
            // no measurement to price — but the throw can land after a process was spawned and a
            // model session opened, and the ledger's failure mode is undercharging. A floor of one
            // session is what this branch knows for certain it might have spent.
            chargedUsd: SCOUT_MODEL_SESSION_USD,
          };
        } finally {
          narrate = () => {};
          try {
            scoutSink.close();
          } catch {
            /* narration is never load-bearing */
          }
        }

        if (outcome.kind === 'unavailable') {
          io.write(`  ✗ ${outcome.reason}\n`);
          archive.appendSignal({
            fromAgent: GENERAL_AGENT_ID,
            toAgent: COMMANDER_AGENT_ID,
            kind: 'answer',
            inReplyTo: query.seq,
            body: cap(`no finding: ${outcome.reason}`),
          });
          recces.push({
            question,
            approved: true,
            agentId: outcome.agentId,
            subagentsFielded: 0,
            haltedForFanOut: false,
            costUsd: outcome.costUsd,
          });
          if (commanderGone) continue;
          beginAnswer(true);
          io.setBusy('commander');
          // The declined envelope, whose only strings are the question the human approved and a
          // sentence this process wrote. Nothing a scout said crosses on this path, which is what
          // makes it safe to use after a run whose output could not be trusted enough to parse.
          const reaction = await session.scoutDeclinedTurn(question, cap(outcome.reason, 400));
          settle();
          endAnswer();
          io.write('\n');
          recordCommanderTurn(reaction.text, reaction.refusals);
          continue;
        }

        const finding = outcome.finding;
        const lines = scoutFindingLines(finding);
        scoutFindings.push(...lines);
        recces.push({
          question,
          approved: true,
          agentId: outcome.agentId,
          subagentsFielded: outcome.subagentsFielded,
          haltedForFanOut: outcome.haltedForFanOut,
          costUsd: outcome.costUsd,
        });
        // WHOSE WORDS THESE ARE, on the line above them. Every string below has been through
        // `sanitize` at capture in `src/command/scout.ts`; what this line adds is attribution,
        // because a finding printed under this process's own glyphs and nothing else is a finding
        // a reader will attribute to this process.
        io.write('\n');
        io.write(
          wrapBlock(
            '  ◇ ',
            `${outcome.agentId} reported — the words below are the SCOUT'S, not this process's` +
              `${
                outcome.subagentsFielded === 0
                  ? ''
                  : `, and ${String(outcome.subagentsFielded)} subordinate(s) contributed to them`
              }.`,
          ),
        );
        io.write(wrapBlock('     ', finding.summary));
        for (const entry of finding.findings) io.write(wrapBlock('     · ', entry));
        for (const entry of finding.unknowns) {
          io.write(wrapBlock('     ? ', `could not determine: ${entry}`));
        }
        io.write(
          wrapBlock('     ', 'it is carried into the segmentation of anything dispatched from here.'),
        );
        // LAST, so the finding reads as one block and the caveat is the last word about it rather
        // than a paragraph wedged into the middle of somebody's evidence.
        if (outcome.haltedForFanOut) {
          io.write(
            wrapBlock('  ! ', describeFanOutHalt(outcome.subagentsFielded, SCOUT_MAX_SUBAGENTS)),
          );
        }
        archive.appendSignal({
          fromAgent: outcome.agentId,
          toAgent: GENERAL_AGENT_ID,
          kind: 'report',
          inReplyTo: query.seq,
          body: cap(finding.summary),
          artifact: `agents/${outcome.agentId}/orders.md`,
        });

        if (commanderGone) continue;
        beginAnswer(true);
        io.setBusy('commander');
        const reaction = await session.scoutFindingTurn({
          agentId: outcome.agentId,
          question,
          summary: finding.summary,
          findings: [...finding.findings],
          unknowns: [...finding.unknowns],
          subagentsFielded: outcome.subagentsFielded,
          haltedForFanOut: outcome.haltedForFanOut,
        });
        settle();
        endAnswer();
        io.write('\n');
        recordCommanderTurn(reaction.text, reaction.refusals);
        continue;
      }

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
      // A human approving a one-line objective while a full spec silently rides along has not
      // approved the spec — so when one is present, it is shown in full, beneath the objective,
      // in the SAME bytes `renderTechnicalSpec` puts into the Engineer's orders and the
      // Inspector's brief. One renderer, so what is approved here is what a worker later reads.
      if (proposal.spec !== undefined) {
        io.write(`\n${renderTechnicalSpec(proposal.spec)}\n`);
      }

      // =====================================================================================
      // THE MECHANICAL ALIGNMENT GATE.
      //
      // Phase 2 begins only when every required spec field is answered, every verification
      // command EXECUTES against the base commit — even if it fails — and a human confirms with
      // a keystroke. This is the first two; the keystroke below is the third, and it is LAST on
      // purpose: it confirms a gate that already passed rather than being the whole gate, which
      // is exactly what it used to be.
      //
      // A PROPOSAL WITH NO SPEC DOES NOT ENTER THE GATE, and that is a statement about what the
      // gate is rather than a hole in it. Condition 1 is a question about a spec; a dispatch that
      // carries none has had no interrogation, nothing was aligned, and there is nothing to check
      // it against. It stays the supported degraded path `army campaign "fix the thing"` also
      // takes — and it is visibly the worse deal rather than the cheaper one, because
      // `dispatchFor` escalates a spec-less brief to the most expensive reasoning class there is
      // and no mechanical criterion runs at any point. The block below says so in as many words.
      // =====================================================================================
      let alignment: AlignmentResult | null = null;
      if (proposal.spec === undefined) {
        io.write(`\n  ${glyph.ranks.CAPTAIN} alignment gate — NOT RUN\n`);
        io.write(
          wrapBlock(
            '     ',
            'This proposal carries no spec, so there is nothing to align: none of the six ' +
              'questions was asked, no verification command exists to run against the base ' +
              'commit, and phase 3 will have no baseline to compare against. The Engineer is ' +
              'escalated to the highest reasoning class to make up for it, which is the most ' +
              'expensive way to answer a question a sentence would have settled.',
          ),
        );
      } else {
        io.write(
          wrapBlock(
            `  ${glyph.ranks.CAPTAIN} `,
            "running the spec's verification commands against the base commit…",
          ),
        );
        gateAbort = new AbortController();
        try {
          alignment = await runAlignmentGate({
            spec: proposal.spec,
            cwd: project,
            signal: gateAbort.signal,
            ...(options.verifyRun === undefined ? {} : { run: options.verifyRun }),
            onProgress: (line) => {
              try {
                // WRAPPED, like the block these lines are the live half of. Unwrapped they
                // measured 133 and 116 columns on a 60-column terminal, hard-broken mid-word by
                // the terminal while the gate block three rows below them wrapped properly — one
                // surface of one gate rendering two different ways.
                io.write(wrapBlock('      ', line));
              } catch {
                /* a dead pipe is never a reason a gate does not finish running */
              }
            },
          });
        } finally {
          // Cleared before anything below can run, so a Ctrl-C after the gate is over cannot try
          // to abort a controller nobody is listening to and swallow a press that meant something
          // else. `runAlignmentGate` never throws, so this only ever runs on the ordinary path —
          // it is here because "never throws" is a promise this file should not have to re-check.
          gateAbort = null;
        }
        io.write(renderAlignment(alignment, charset, io.width));

        if (!alignment.passed) {
          // NO KEYSTROKE IS OFFERED. A gate that failed and then asked anyway would be a gate
          // whose whole content is the question, which is the shape this replaces.
          //
          // The reasons are NOT reprinted here, and the first version of this did print them. On a
          // pty the same paragraph appeared twice three rows apart — once under the command it
          // belongs to, in the block above, and once again as a refusal. The block is where a
          // reader is already looking; this line says what happened to the dispatch. The full
          // sentences still go to the archive and to the commander, which are the two readers who
          // do not see the block.
          io.write('  ◇ not dispatched — the alignment gate did not pass.\n');
          const summary = alignmentRefusals(alignment).join(' ');
          archive.appendSignal({
            fromAgent: GENERAL_AGENT_ID,
            toAgent: COMMANDER_AGENT_ID,
            kind: 'answer',
            inReplyTo: query.seq,
            body: cap(`alignment gate refused: ${summary}`),
          });
          dispatches.push({
            objective: proposal.objective,
            approved: false,
            campaignId: null,
            outcome: null,
            verdict: null,
            deliveredRung: null,
            gate: 'refused',
          });
          if (commanderGone) continue;
          beginAnswer(true);
          io.setBusy('commander');
          // The declined envelope: its only strings are the objective the human approved and a
          // sentence this process wrote from its own readings. No command output crosses.
          const reaction = await session.dispatchDeclinedTurn(
            proposal.objective,
            `the alignment gate did not pass. ${cap(summary, 400)}`,
          );
          settle();
          endAnswer();
          io.write('\n');
          recordCommanderTurn(reaction.text, reaction.refusals);
          continue;
        }
      }

      awaitingApproval = 'dispatch';
      const answer = await io.nextLine(CONFIRM_PROMPT, { addressee: 'dispatch-approval' });
      awaitingApproval = null;
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
          gate: gateOf(alignment),
        });
        if (!exitRequested) {
          if (commanderGone) commanderDeathCloseOut();
          else exitReason = 'eof';
        }
        break;
      }
      if (!isApproval(answer)) {
        const reason = 'the Commander did not approve it';
        io.write('  ◇ not dispatched.\n');
        keepUnansweredLine(answer);
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
          gate: gateOf(alignment),
        });
        // A commander that died while the human was deciding cannot be told the decision — the
        // loop's own close-out says why the session is over. Same guard on the two turns below.
        if (commanderGone) continue;
        beginAnswer(true);
        io.setBusy('commander');
        const reaction = await session.dispatchDeclinedTurn(proposal.objective, reason);
        settle();
        endAnswer();
        io.write('\n');
        recordCommanderTurn(reaction.text, reaction.refusals);
        continue;
      }

      // ---- the durable spec --------------------------------------------------------------
      //
      // WRITTEN AFTER THE KEYSTROKE AND BEFORE THE FIRST SPAWN. After, because a document
      // describing work nobody approved is a document about nothing; before, because the campaign
      // that follows can fail, be interrupted, or take its worktree with it, and the record of
      // what was agreed has to survive all three.
      //
      // The archive copy is unconditional. The repository copy is `planning.spec_to_repo`, off by
      // default, because a rejected branch should not strand design documents in the repo — see
      // `src/chat/planning.ts`.
      if (proposal.spec !== undefined && alignment !== null) {
        const record: PlanningRecord = {
          campaignId,
          project,
          spec: proposal.spec,
          interrogation,
          alignment,
          at: options.now === undefined ? new Date().toISOString() : options.now(),
        };
        const documents = planningDocuments(record);
        for (const doc of documents) {
          try {
            archive.writeAgentText(COMMANDER_AGENT_ID, doc.filename, doc.contents);
          } catch (error) {
            // The archive said no. Said out loud rather than swallowed, and never a reason the
            // dispatch does not happen: the human approved work, not a filing system.
            io.write(
              `  ! could not write ${doc.filename} to the archive: ` +
                `${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }
        archive.appendSignal({
          fromAgent: GENERAL_AGENT_ID,
          kind: 'status',
          body: cap(
            `the settled spec and ${String(interrogation.length)} interrogation round(s) are in ` +
              'the archive',
          ),
          artifact: `agents/${COMMANDER_AGENT_ID}/spec.md`,
        });
        if (config.planning.specToRepo) {
          const written = writeSpecToRepo(record, documents);
          if (written.failure === null) {
            io.write(`  ◇ spec written to ${path.relative(project, written.written[0] ?? '')}\n`);
          } else {
            io.write(`  ! could not write the spec into the repository: ${written.failure}\n`);
          }
        }
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
        //
        // And NOT when the status block is up. The sink's ticker and the block's roster draw the
        // same fact — this unit is working, and for this long — and two writers animating one
        // screen is the bug this whole file's io seam exists to prevent. The roster is the better
        // of the two (every unit, not just the newest, and it survives the narration lines that
        // land on top of a ticker), so the ticker stands down rather than the block.
        live: io.isTTY && !chrome,
      });
      // Every note message the live narration forwards, so the close-out below can re-state only
      // the errors a reader has NOT already seen. Rebuilt per dispatch with the sink it records
      // for; recorded before the emit, inside the guard, because a message the set holds is one
      // this wrapper handed to the terminal — not a claim about what a dead pipe displayed.
      const narratedNotes = new Set<string>();
      narrate = guardedProgress((event) => {
        if (event.kind === 'note') narratedNotes.add(event.message);
        // What a `human-in-flight` turn carries as "recent". Plain and ascii: it is read by a
        // model, not painted, and it goes through `sanitize` like every other subordinate line.
        const line = renderProgressEvent(event, { self, charset: 'ascii' });
        if (line !== '') {
          recentNarration.push(sanitize(line));
          if (recentNarration.length > RECENT_NARRATION_MAX) recentNarration.shift();
        }
        // Before the emit, and inside the guard: the roster is what the reader sees a unit in
        // while the campaign is running, and a dead pipe must not be the reason it goes blank.
        // `sink.emit` is the throwing half; the bookkeeping above it cannot throw at all.
        rosterObserve(event);
        // The tree re-reads on a LIFECYCLE event as well as on its timer, and the timer is the
        // backstop rather than the mechanism. Polling alone made the block up to a poll interval
        // behind the narration: a reader watched `cpt-01 dispatched` print and then looked down at
        // a tree that still said the task had no agent yet. The disposition is asked for rather
        // than a list of kinds spelled here, so a kind added upstream is classified by the module
        // that owns the vocabulary, and an unknown kind lands in `lifecycle`, which costs one
        // cheap incremental read and can never be wrong about what is on screen.
        if (dispositionOf(event) === 'lifecycle') refreshTree();
        sink.emit(event);
      });

      /**
       * The human rung of the question ladder.
       *
       * ## What this is not
       *
       * It is not a turn. The commander is not told, is not asked, and does not reply: the
       * question is printed on this terminal and the answer is the next line the human types,
       * handed straight back to the campaign. That is deliberate and it is the reason this seam
       * does not go through `ChatSession` at all. `session.ts` guarantees that a dispatch proposal
       * survives only out of a turn whose authority is the human's, and it enforces that by
       * DELETING a directive parsed from any other turn. Routing an answer through the commander
       * would put a model between a human's words and the worker waiting on them, and it would
       * create a second way for work to be proposed, on a turn nobody confirmed with a keystroke.
       * There is one source of new intent in this file and it is the approval prompt above.
       *
       * ## Why the whole question is printed
       *
       * `renderPendingQuestion` marks which half a worker wrote. Nothing is summarised here,
       * because the person answering has to be able to answer WITHOUT going and reading a
       * transcript, and a question they have to research is one this rung cannot serve.
       *
       * ## Why it no longer reads
       *
       * It used to print the question and then `io.nextLine(ANSWER_PROMPT, { fresh: true })` on the
       * spot. That is correct for ONE blocked worker and wrong for eight: `ChatIo` has a single
       * pending read, so a second question would replace the first worker's resolver and park a
       * workstream on a promise nothing would ever settle, with its worktree lease held. And a
       * read that opens on a worker's schedule opens in the middle of a word somebody is typing.
       *
       * So it prints and PARKS. The dispatch console above owns the one read, the inbox owns the
       * queue, and the composer is relabelled in place rather than seized. The `{ fresh: true }`
       * rule is unchanged and is now the console's: a line typed for the Commander still cannot
       * become a worker's decision, because the queue holding those lines is never drained here.
       */
      const askHuman = async (question: PendingQuestion): Promise<string> => {
        // The narration ticker owns the current line while a campaign runs; a block painted over
        // it would be repainted away. `setIdle` is idempotent and takes it down.
        try {
          io.setIdle();
        } catch {
          /* a dead terminal cannot be tidied, and a question is worth more than a tidy line */
        }
        const answer = inbox.ask(question);
        const entry = inbox.entries[inbox.entries.length - 1] as InboxEntry;
        guardedWrite(
          `\n${renderQuestionMarker(entry, inbox.size, charset)}\n` +
            `${renderPendingQuestion(question)}${ANSWER_HINT}\n`,
        );
        // The composer says where a line goes, under the read that is already open. It is the only
        // surface that can say it while it is true, and `setPrompt` is the one way to change it
        // without seizing a composer somebody is mid-word in. What it does take is the DRAFT: a
        // half-typed line written under the dispatch prompt was written for the Commander, and it
        // goes back to the Commander's queue with a line on screen saying so, rather than sitting
        // under the new prompt one Enter away from becoming this worker's decision.
        refreshPrompt();
        // Nobody is reading: end of input, or a terminal that went away. A question parked on a
        // prompt that will never be shown is a workstream parked on a lease forever, so this ends
        // it now with the answer the campaign already knows how to treat.
        if (!consoleActive) {
          for (const left of inbox.drain()) sayUnanswered(left);
        }
        return answer;
      };

      roster = [];
      agentsSpawned = new Set<string>();
      campaignCostUsd = null;
      dispatchInFlight = true;
      stopController = new AbortController();
      consoleActive = true;
      consoleInterrupted = false;
      stopArmed = false;
      dispatchStartedAt = nowMs();
      dispatchObjective = proposal.objective;
      recentNarration.length = 0;
      commanderChain = Promise.resolve();
      // Started BEFORE the campaign, so a `/stop` typed in the first second of a dispatch has
      // somewhere to land. Never awaited here: it is a reader, and the dispatch is the work.
      consoleLoop = dispatchConsole();
      let result: CampaignResult | null = null;
      let failure: string | null = null;
      try {
        result = await runDispatch({
          onProgress: narrate,
          askHuman,
          abortSignal: stopController.signal,
          objective: proposal.objective,
          ...(proposal.spec === undefined ? {} : { spec: proposal.spec }),
          // Everything every scout in this conversation found, so a MAJ·OVERSEER segments the
          // feature knowing what was already looked up rather than sending an engineer to
          // rediscover it.
          ...(scoutFindings.length === 0 ? {} : { scoutFindings }),
          cwd: project,
          env,
          home,
          requestedRung,
          maxAttempts,
          ...(options.overseer === undefined ? {} : { overseer: options.overseer }),
          ...(options.maxConcurrentWorkstreams === undefined
            ? {}
            : { maxConcurrentWorkstreams: options.maxConcurrentWorkstreams }),
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
        stopController = null;
        stopArmed = false;
        // The console goes down FIRST and is waited for, because it is holding the terminal's one
        // read and the close-out below writes to that terminal. Its own `finally` resolves every
        // question still parked, so nothing downstream of here can be waiting on this human.
        consoleActive = false;
        try {
          io.abortLine({ keepQueued: true });
        } catch {
          /* the read is already over, or the terminal is gone; either way there is nothing to end */
        }
        try {
          await consoleLoop;
        } catch {
          /* `dispatchConsole` does not throw; this is the belt on top of its own braces */
        }
        // Then any Commander answer the console started, so it finishes printing before the
        // outcome does and the `dispatch-result` turn below never races a turn still in flight.
        // A line chained but not yet started sees `dispatchInFlight` false and requeues itself.
        try {
          await commanderChain;
        } catch {
          /* every link of the chain catches; this is the belt on top of its own braces */
        }
        // The tree stops being LIVE the moment the campaign does, and one last read is taken on
        // the way down so `/work` answers from the ending rather than from the last poll.
        closeTree();
        // Folded in AFTER that last read, so what is banked is the campaign's final figure and
        // not whatever the last poll happened to catch.
        if (campaignCostUsd !== null) {
          finishedCampaignsUsd = (finishedCampaignsUsd ?? 0) + campaignCostUsd;
        }
        campaignCostUsd = null;
        // `close` writes — it erases the ticker's line — so it is an emission like any other and
        // is guarded like one. A throw from a `finally` replaces whatever the block was doing,
        // and what this block is doing is returning a session to a human.
        try {
          sink.close();
        } catch {
          /* narration is never load-bearing */
        }
        narrate = () => {};
        // Nothing is running any more, so nothing may still be drawn as running. A roster left
        // standing between dispatches would show an Engineer working for the rest of the
        // session, which is the one lie a status bar cannot recover from.
        roster = [];
        // The dispatch branched and committed. Re-read rather than reason about what it did:
        // this is the branch the reader is now standing on, and it changed while they watched.
        if (readRepo !== null) {
          try {
            repo = await readRepo(project);
          } catch {
            /* the bar renders `unknown`; a decoration is never a reason to fail a dispatch */
          }
        }
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
          gate: gateOf(alignment),
        });
        if (commanderGone) continue;
        beginAnswer(true);
        io.setBusy('commander');
        // A failure to START is not a subordinate's account of anything — it is this process
        // reporting on itself, so it goes back as the declined envelope, whose only strings are
        // the objective the human approved and a message this file wrote.
        const reaction = await session.dispatchDeclinedTurn(
          proposal.objective,
          `the dispatch could not be started: ${cap(message, 200)}`,
        );
        settle();
        endAnswer();
        io.write('\n');
        recordCommanderTurn(reaction.text, reaction.refusals);
        continue;
      }

      io.write(renderDispatchOutcome(result, progressStyle, narratedNotes));
      const facts = factsFrom(result, proposal.objective);
      dispatches.push({
        objective: proposal.objective,
        approved: true,
        campaignId: result.campaignId,
        outcome: result.outcome,
        verdict: facts.verdict,
        deliveredRung: result.deliveredRung,
        gate: gateOf(alignment),
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

      if (commanderGone) continue;
      beginAnswer(true);
      io.setBusy('commander');
      const reaction = await session.dispatchResultTurn(facts);
      settle();
      endAnswer();
      io.write('\n');
      recordCommanderTurn(reaction.text, reaction.refusals);
    }
  } finally {
    disarmSpill();
    unsubscribe();
    // A poll timer that outlived its session would keep re-reading an archive nobody is watching,
    // once a second, for as long as the process lived. Idempotent, and a no-op when no dispatch
    // ever opened one.
    try {
      closeTree();
    } catch {
      /* a reader that will not close is not a reason to lose the archive rows below */
    }
    // First, and guarded like everything else here: the block is rows of chrome pinned under the
    // conversation, and the close-out below writes the archive path into the same region. A bar
    // still installed would be repainted over the last thing this command says.
    try {
      io.setStatus(null);
    } catch {
      /* a dead terminal cannot be tidied, and that is not this path's problem */
    }
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
    recces,
    refusals,
    exitReason,
    costUsd: session.costUsd,
    // A conversation that happened is a conversation that succeeded. A dispatch that failed
    // inspection is news, not an error in the session — `army view` and the printed outcome say
    // so, and exiting non-zero would make every honest FAIL look like a broken tool. The one
    // exception is a commander that DIED: that is the tool breaking, and it exits 1.
    exitCode,
  };
}

export const SLASH_HELP = `
  /exit  /quit   leave the session
  /status        the header again, with the working copy re-read
  /work <id>     one agent or workstream, printed: orders, branch, last activity, diffstat.
                 It prints rather than opens: a pager needs an alternate screen this does not use.
  /stop          end the running campaign. It confirms first, because every worktree in flight
                 has to be settled rather than dropped.
  /next          with several questions open, move to the next one without answering this one
  /help          this
  Ctrl-C         stop the answer in flight; again to leave. At a question it leaves that question
                 unanswered and the dispatch keeps running. It never ends a campaign.
  Ctrl-D         leave
  Up / Down      the lines you have already typed

  While a dispatch runs the prompt is still yours. /stop, /work, /next, /status and /help answer
  there and then; a question that reaches you is answered by typing; a sentence for the Commander
  reaches it now, with the campaign's state read from the archive, and its answer prints whole
  when it is done (Ctrl-C stops the answer, never the campaign); /exit is queued and runs the
  moment the dispatch settles.

  The commander's whole loadout is one inert tool, TodoWrite. It is one rather than none
  because an emptied allow-list makes the launcher omit --allowedTools altogether, and the
  process then inherits claude's own default loadout — the most permissive configuration
  this program can start. To change a file it proposes an objective, you approve it, and an
  Engineer is raised in a leased worktree and reviewed by an independent Inspector.

  BEFORE THAT it may propose a CPT·SCOUT — a reader that goes and finds something out.
  It has its own [y/N], because a reader and a writer are different decisions. A scout
  holds Read, Grep, Glob and the web, writes nothing, and holds no worktree at all. What
  it finds is carried into the plan of anything you dispatch afterwards.

  A dispatch carrying a spec then meets the alignment gate: every required field must be
  answered and every verification command must EXECUTE against the base commit. A command
  that runs and FAILS passes the gate — a red test is where work starts, and its reading is
  recorded so nothing can later claim the failure was already there. What fails the gate is
  a command a shell cannot run, one that returns no result, or one still going at the
  deadline. Only then are you asked to confirm.
`;
