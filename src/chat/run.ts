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

import * as path from 'node:path';

import { CampaignArchive, campaignIdFor, createCampaign, listCampaignIds } from '../archive/archive.ts';
import type { ArchiveConfig } from '../archive/archive.ts';
import { GENERAL_AGENT_ID, buildSoldierSpec, resolveProjectRootOrInit } from '../command/campaign.ts';
import type { CampaignResult } from '../command/campaign.ts';
import { loadConfig } from '../config/load.ts';
import { armyHome } from '../config/paths.ts';
import type { Env } from '../config/paths.ts';
import { RUNG_LABEL, effectiveRung } from '../contracts/delivery.ts';
import type { Rung } from '../contracts/delivery.ts';
import type { TaskRow } from '../contracts/archive.ts';
import type { HarnessAdapter, HarnessId, SoldierEvent, SoldierSpec } from '../contracts/harness.ts';
import { codePointLength } from '../contracts/report.ts';
import { renderTechnicalSpec } from '../contracts/spec.ts';
import type { WorktreeProviderId } from '../contracts/worktree.ts';
import type { DeliveryConfig } from '../delivery/ladder.ts';
import { projectCeiling } from '../delivery/ladder.ts';
import type { GhStatus } from '../delivery/git.ts';
import { createClaudeAdapter } from '../harness/claude.ts';
import { invokedAs } from '../setup/checks.ts';
import { registerProjectIfAbsent } from '../setup/enlist.ts';
import { ensureConfig } from '../setup/init.ts';
import { detectCharset, detectColor } from '../view/index.ts';
import type { Charset } from '../view/render.ts';
import {
  REPO_UNKNOWN,
  describeRepo,
  renderHeader,
  renderStatusBar,
} from '../view/chrome.ts';
import type { ChromeStyle, RepoState, RosterUnit, StatusModel } from '../view/chrome.ts';
import { createProgressSink, renderProgressEvent } from '../view/progress.ts';
import { createProseStream } from '../view/prose.ts';
import type { ProgressEvent, ProgressListener, ProgressStyle } from '../view/progress.ts';

import { factsFrom, guardedProgress, runDispatch } from './dispatch.ts';
import type { ChatIo, StatusRenderer } from './io.ts';
import { readRepoState } from './repo.ts';
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

/**
 * Exported so tests can drive the terminal with the REAL bytes. The last shipped terminal bug —
 * the composer walking down the screen one row per keystroke — lived precisely in the gap between
 * these constants and the prompt every io test hand-rolls: the leading `\n` here never met
 * the repaint code until a human did. `ChatIo.nextLine` documents the multi-line contract; a test
 * that spells its own prompt is a test of a prompt nobody uses.
 */
export const PROMPT = '\n▌ ';
export const CONFIRM_PROMPT = '  ◇ dispatch this? [y/N] ';

/** `y` / `yes`, and nothing else. Anything ambiguous is a no — the default must be the safe one. */
export function isApproval(line: string): boolean {
  const answer = line.trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

export interface BannerFacts {
  self: string;
  project: string;
  repo: RepoState;
  ceiling: Rung;
  rung: Rung;
  /** The commander's model id, or empty when the harness was left to pick its own. */
  model: string;
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

  const session = new ChatSession({
    adapter: commanderAdapter,
    spec,
    onText: (chunk) => {
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
  let awaitingApproval = false;

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
      case 'unit-dispatched':
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
        return;
    }
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
    const hint = dispatchInFlight
      ? 'dispatch in flight — Ctrl-C lets it settle'
      : awaitingApproval
        ? 'approve to dispatch, anything else declines'
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
      costUsd: session.costUsd,
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
  const guardedWrite = (text: string): void => {
    try {
      io.write(text);
    } catch {
      /* the reader is gone; that is never a reason to take the process with it */
    }
  };

  const onInterrupt = (): void => {
    void (async (): Promise<void> => {
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
      const line = await io.nextLine(PROMPT);
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
              campaignId,
              archiveRoot: archive.root,
            },
            chromeStyle(),
          ),
        );
        continue;
      }

      humanTurns += 1;
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
      awaitingApproval = true;
      const answer = await io.nextLine(CONFIRM_PROMPT);
      awaitingApproval = false;
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
        if (!exitRequested) {
          if (commanderGone) commanderDeathCloseOut();
          else exitReason = 'eof';
        }
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
        // Before the emit, and inside the guard: the roster is what the reader sees a unit in
        // while the campaign is running, and a dead pipe must not be the reason it goes blank.
        // `sink.emit` is the throwing half; the bookkeeping above it cannot throw at all.
        rosterObserve(event);
        sink.emit(event);
      });
      roster = [];
      dispatchInFlight = true;
      let result: CampaignResult | null = null;
      let failure: string | null = null;
      try {
        result = await runDispatch({
          onProgress: narrate,
          objective: proposal.objective,
          ...(proposal.spec === undefined ? {} : { spec: proposal.spec }),
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
  /help          this
  Ctrl-C         stop the answer in flight; again to leave
  Ctrl-D         leave
  Up / Down      the lines you have already typed

  The commander's whole loadout is one inert tool, TodoWrite. It is one rather than none
  because an emptied allow-list makes the launcher omit --allowedTools altogether, and the
  process then inherits claude's own default loadout — the most permissive configuration
  this program can start. To change a file it proposes an objective, you approve it, and an
  Engineer is raised in a leased worktree and reviewed by an independent Inspector.
`;
