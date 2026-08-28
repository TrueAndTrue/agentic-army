/**
 * Live campaign progress — one event in, one line out.
 *
 * ## Why this exists
 *
 * The signal bus already recorded the campaign lifecycle faithfully, into `signals.jsonl`, where
 * nobody was watching. Meanwhile the one place with a blocked human in front of it — the terminal
 * that ran the campaign — printed nothing at all until the whole thing was over. A run that takes
 * minutes and says nothing is indistinguishable from a run that has hung, and the reader has no
 * way to tell which they have.
 *
 * ## Why the renderer is pure, like `render.ts`
 *
 * `renderProgressEvent` never reads `process.env`, never asks whether a stream is a TTY and never
 * calls a clock. Charset, colour, width and the invocation prefix arrive as arguments. That is
 * what makes "does a hostile summary move the cursor" and "does a redirected stream stay clean"
 * unit tests rather than manual rituals.
 *
 * The one stateful thing — the in-place elapsed ticker — is `createProgressSink`, which is the
 * only thing in this file that writes anywhere, and the only thing that knows a terminal exists.
 *
 * ## One vocabulary, not two
 *
 * `army chat` already narrates a dispatch to a terminal, and it spells a unit
 * `◇ cpt-01 ENGINEER`, an error `✗ …` and a handoff `→`. `army campaign`'s own result renderer
 * spells notes `· ⚠ ✗`. Both are reused here rather than reinvented: the rank glyph comes from the
 * same `Glyphs` table `render.ts` uses for the tree, and the unit label is `formatUnit` from
 * `contracts/ranks.ts` — the same function that builds every label in `army view`. A second
 * spelling of "the Engineer is working" is drift that costs nothing to prevent now.
 *
 * ## Model-controlled text
 *
 * A `Report.summary` and a `Verdict.summary` are written by a model and land on a human's
 * terminal. `sanitize` strips the C0/C1 control range from them before they are printed, because
 * a summary containing `ESC[2J` would otherwise clear the screen of the person reading it, and
 * one containing `\r` would overwrite the line that says which unit produced it. The tree renderer
 * has the same exposure and answers it for the ASCII path with `asciiFold`; this is the answer for
 * the UTF-8 path, where the bytes pass through untouched.
 */

import type { Rung } from '../contracts/delivery.ts';
import { RUNG_LABEL } from '../contracts/delivery.ts';
import type { Rank, Role } from '../contracts/ranks.ts';
import { formatUnit } from '../contracts/ranks.ts';

import type { Charset } from './render.ts';
import { SPINNER_FRAMES, asciiFold, clipTo as clipColumns, glyphsFor } from './render.ts';

// ---------------------------------------------------------------------------------------------
// The events
// ---------------------------------------------------------------------------------------------

/**
 * What became of a leased tree, mirrored from the campaign's own `LeaseState`.
 *
 * Spelled out here rather than imported so that `src/view` does not depend on `src/command`, which
 * is the direction that would make the view layer un-reusable. `test/command.test.ts` pins the two
 * unions equal, so the copy cannot drift without a red test.
 */
export const PROGRESS_LEASE_STATES = ['never-acquired', 'released', 'retained', 'not-held'] as const;
export type ProgressLeaseState = (typeof PROGRESS_LEASE_STATES)[number];

/**
 * The campaign lifecycle, as the terminal sees it.
 *
 * These are the same moments `signals.jsonl` already records. The point of a separate type is that
 * a signal row is an archive record — capped, addressed, sequenced — while this is a thing to
 * print, and the two have different obligations. What they must NOT have is different content, so
 * every event below is emitted next to the `appendSignal` for the same moment.
 */
export type ProgressEvent =
  | { kind: 'campaign-opened'; campaignId: string; title: string }
  | { kind: 'worktree-leased'; provider: string; path: string }
  /** How to watch in more detail. `campaignId` is filled in; the caller supplies the prefix. */
  | { kind: 'watch-hint'; campaignId: string }
  | {
      kind: 'unit-dispatched';
      agentId: string;
      rank: Rank;
      role: Role;
      harness: string;
      attempt: number;
    }
  | {
      kind: 'unit-returned';
      agentId: string;
      rank: Rank;
      role: Role;
      status: string;
      /** Model-controlled. Sanitised and clipped before it reaches a terminal. */
      summary: string | null;
    }
  /**
   * A worker started a tool call.
   *
   * `tool` and `target` are the OUTPUT of `describeToolUse` — already extracted from the raw
   * input, already sanitised, already clipped. There is deliberately no field here that can carry
   * `ToolUseEvent.input`: the largest input in the reference archive was 10,656 bytes and a tool
   * result can reach 40 MB, so the type is the thing that guarantees neither reaches a terminal.
   */
  | {
      kind: 'unit-acting';
      agentId: string;
      /** Correlates with the `unit-acted` that closes it. */
      toolUseId: string;
      tool: string;
      target: string;
      /** 0 for the worker itself; 1+ for a native subagent beneath it. */
      depth: number;
    }
  /**
   * A tool call finished. Carries no output — see `unit-acting` for why.
   *
   * This does NOT clear what the roster is showing. A row that blanks the moment a tool returns
   * spends the reasoning gaps saying nothing, and the reasoning gaps are 75% of a run's wall
   * clock — they are the whole complaint. The last completed action, with its own timestamp, is
   * the honest thing to show while the model thinks.
   */
  | { kind: 'unit-acted'; agentId: string; toolUseId: string; isError: boolean }
  /**
   * The worker is reasoning. `tokens` is cumulative for this unit, never a delta.
   *
   * Emitted from the harness's own reasoning-token telemetry, coalesced by the translator. This is
   * the only signal that exists during the long silences: on the reference run a 248-second gap
   * between two tool calls contained 166 of these, never more than 4.0s apart.
   */
  | { kind: 'unit-thinking'; agentId: string; tokens: number }
  /**
   * A tool call was refused by the permission layer.
   *
   * Its own kind rather than a `note` because it is the one live event that says the worker's
   * loadout and its orders disagree, and a reader who sees it while it is happening can stop a
   * run that is otherwise going to spend two more attempts discovering the same thing.
   */
  | {
      kind: 'unit-blocked';
      agentId: string;
      tool: string;
      /**
       * The refused call, as `unit-acting` spelled it — empty when the denial names no call this
       * translator had already announced.
       *
       * Load-bearing rather than decorative: the harness's own denial message is four hundred
       * characters of advice addressed to the MODEL, and says nothing about which command was
       * refused. A reader watching `⊘ Bash refused` learns that something was blocked; a reader
       * watching `⊘ Bash(cat > /tmp/…) refused` learns that the worker reached outside its
       * worktree, which is the fact worth interrupting a run for.
       */
      target: string;
      reason: string;
    }
  | {
      kind: 'verdict';
      agentId: string;
      rank: Rank;
      role: Role;
      verdict: 'pass' | 'fail';
      /** Rendered next to the verdict, never folded into it — a pass from a reviewer that ran
       *  nothing is a distinguishable and suspicious state, and the terminal is where it matters. */
      testsRun: boolean;
      /** Model-controlled. */
      summary: string;
    }
  | { kind: 'delivered'; rung: Rung | null; url: string | null }
  | { kind: 'lease-settled'; state: ProgressLeaseState; path: string | null; reason: string }
  | { kind: 'note'; level: 'info' | 'warn' | 'error'; message: string };

export type ProgressListener = (event: ProgressEvent) => void;

// ---------------------------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------------------------

/** How much model-controlled prose survives onto a progress line. */
export const PROGRESS_SUMMARY_MAX = 100;

/**
 * Strip everything a terminal would obey rather than display.
 *
 * C0 (U+0000-U+001F), DEL and C1 (U+0080-U+009F) all go, including the ESC that starts
 * every ANSI sequence — so a summary carrying `ESC[2K` arrives as the literal text `[2K` and
 * moves nothing. Tabs and newlines collapse to spaces rather than vanishing, so words do not run
 * together.
 *
 * ## Why the invisible ranges go too
 *
 * A bidi override is obeyed just as surely as an escape sequence: U+202E reverses the rendered
 * order of everything after it, so `Write lib/` + RLO + `sj.esrever` displays as a path that was
 * never written. That is the Trojan Source shape, and a status row quoting a model-chosen file
 * path is exactly where it would land. The isolates (U+2066-U+2069) do the same job with a scope.
 *
 * The zero-width range goes with them for a different reason: those code points occupy no column,
 * so they let a string be arbitrarily longer than it measures — which is a way to smuggle content
 * past a clip, and a way to make `displayWidth` disagree with what a human counts.
 *
 * One accepted cost: U+200D is the joiner in emoji sequences, so a ZWJ family decomposes into its
 * component people. That is a visual change in a model-written summary, never a cursor hazard,
 * and it is not worth a carve-out that makes the rule harder to state than "invisible goes".
 */
const OBEYED_INVISIBLE = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero-width space/joiners, LRM, RLM
  0x2028, 0x2029, // line and paragraph separators
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embedding, override, pop
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner and the invisible operators
  0x2066, 0x2067, 0x2068, 0x2069, // bidi isolates
  0xfeff, // zero-width no-break space / BOM
]);

export function sanitize(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isC0 = code <= 0x1f;
    const isC1 = code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (isC0 || isC1) {
      out += code === 0x09 || code === 0x0a || code === 0x0d ? ' ' : '';
      continue;
    }
    // Collapsed to a space rather than deleted, for the same reason a tab is: a word boundary the
    // author intended must not silently close up into a different word.
    if (OBEYED_INVISIBLE.has(code)) {
      out += ' ';
      continue;
    }
    out += char;
  }
  return out.replace(/\s+/gu, ' ').trim();
}

function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Sanitised, collapsed and clipped — everything a model-written string needs before printing. */
function quotable(text: string, max = PROGRESS_SUMMARY_MAX): string {
  return clipTo(sanitize(text), max);
}

/**
 * The first sentence, for prose written to be read by a model rather than by a person.
 *
 * A permission denial arrives as roughly four hundred characters: one sentence stating the refusal
 * and then a paragraph coaching the worker on what to try instead. The first sentence is the fact;
 * the rest is addressed to somebody else. Falls back to the whole string when there is no sentence
 * break, so a terse message is never truncated to nothing.
 */
function firstSentence(text: string): string {
  const end = text.indexOf('. ');
  return end === -1 ? text : text.slice(0, end + 1);
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export interface ProgressStyle {
  /** The command prefix for anything the reader is told to type, e.g. from `invokedAs()`. */
  self: string;
  charset?: Charset;
}

const INDENT = '  ';

/**
 * How much of a `Tool(target)` call survives onto a feed line.
 *
 * Larger than `PROGRESS_SUMMARY_MAX` because `describeToolUse` has already clipped the target to
 * its own budget: this is the backstop that catches a long TOOL NAME plus a long target, not the
 * primary limit.
 */
const FEED_LINE_MAX = 96;

/**
 * Indent levels a nested subagent's tool call may earn.
 *
 * Capped so a runaway nesting depth cannot push a feed line off the right edge — `depth` comes
 * from the harness and nothing in this module gets to assume it is small.
 */
const MAX_FEED_DEPTH = 3;

/**
 * The level marks, per charset.
 *
 * The unicode row is `renderCampaignResult`'s `LEVEL_MARK`, character for character, so the live
 * narration and the report that follows it mark the same severity the same way.
 */
const NOTE_MARK: Record<Charset, Record<'info' | 'warn' | 'error', string>> = {
  unicode: { info: '·', warn: '⚠', error: '✗' },
  ascii: { info: '-', warn: '!', error: 'x' },
};

/**
 * One event, one line, no trailing newline.
 *
 * Returns `''` for nothing worth printing, which the sink drops — a renderer that returns an empty
 * line and a sink that prints it would put blank lines in the middle of the narration.
 */
export function renderProgressEvent(event: ProgressEvent, style: ProgressStyle): string {
  const charset: Charset = style.charset ?? 'unicode';
  const g = glyphsFor(charset);
  const fold = (text: string): string => (charset === 'ascii' ? asciiFold(text) : text);
  const unit = (rank: Rank, role: Role, agentId: string): string =>
    `${g.ranks[rank]} ${formatUnit(rank, role)} ${g.bullet} ${agentId}`;

  switch (event.kind) {
    case 'campaign-opened':
      return fold(
        `${g.ranks.GENERAL} campaign ${event.campaignId} ${g.bullet} ${quotable(event.title, 72)}`,
      );

    case 'worktree-leased':
      return fold(`${INDENT}${g.bullet} worktree leased (${event.provider}) ${g.arrow} ${event.path}`);

    case 'watch-hint':
      // Every command a reader is told to type is built from `self`. There is no spelling of the
      // binary in this file, because there is no spelling that is right for every reader.
      return fold(
        `${INDENT}${g.bullet} watching in detail: ${style.self} view ${event.campaignId} --follow`,
      );

    case 'unit-dispatched':
      return fold(
        `${INDENT}${unit(event.rank, event.role, event.agentId)} dispatched ` +
          `(${event.harness}, attempt ${String(event.attempt)})`,
      );

    case 'unit-returned': {
      const tail = event.summary === null ? '' : ` ${g.dash} ${quotable(event.summary)}`;
      return fold(
        `${INDENT}${unit(event.rank, event.role, event.agentId)} returned ${event.status}${tail}`,
      );
    }

    case 'unit-acting': {
      // Indented one level PAST a lifecycle line, and by an extra level per subagent depth, so the
      // feed reads as a tree: the Captain's calls sit under the Captain, a Sergeant's under both.
      const nest = INDENT.repeat(Math.min(event.depth, MAX_FEED_DEPTH));
      const call = event.target === '' ? event.tool : `${event.tool}(${event.target})`;
      return fold(`${INDENT}${nest}${g.tool} ${quotable(call, FEED_LINE_MAX)}`);
    }

    // Roster bookkeeping only. A line per tool RESULT would double the feed's length to say
    // "the thing you just saw start has stopped", which the next line already implies.
    case 'unit-acted':
      return '';

    // Never printed: it fires every couple of seconds for the whole of a reasoning gap. It moves
    // the live status row and the roster, both of which repaint in place.
    case 'unit-thinking':
      return '';

    case 'unit-blocked': {
      // The reason is harness prose, not model prose, but it arrives through the same untrusted
      // path and is quoted for the same reason everything else here is. Clipped short, because
      // the rest of a denial message is instructions to the model about what to try instead.
      const call = event.target === '' ? event.tool : `${event.tool}(${event.target})`;
      return fold(
        `${INDENT}${g.blocked} ${quotable(call, FEED_LINE_MAX)} refused ` +
          `${g.dash} ${quotable(firstSentence(event.reason), 96)}`,
      );
    }

    case 'verdict': {
      // `renderDispatchOutcome` in chat spells this exact pair the same way, deliberately.
      const tests = event.testsRun ? '' : ' (NO TESTS RUN)';
      return fold(
        `${INDENT}${unit(event.rank, event.role, event.agentId)} ${g.arrow} ` +
          `${event.verdict.toUpperCase()}${tests} ${g.dash} ${quotable(event.summary)}`,
      );
    }

    case 'delivered': {
      const where = event.url === null ? '' : ` ${g.arrow} ${event.url}`;
      return fold(
        event.rung === null
          ? `${INDENT}${g.bullet} delivered nothing`
          : `${INDENT}${g.bullet} delivered rung ${String(event.rung)} (${RUNG_LABEL[event.rung]})${where}`,
      );
    }

    case 'lease-settled': {
      if (event.state === 'never-acquired') return '';
      // `not-held` earns the warn mark alongside `retained`: in both, a tree this run leased did
      // NOT come back the way it should have, and both want an operator's eye. Only `released` is
      // the quiet, expected ending.
      const mark = event.state === 'released' ? g.bullet : g.warn;
      const where = event.path === null ? '' : ` ${g.arrow} ${event.path}`;
      return fold(
        `${INDENT}${mark} worktree ${event.state}${where} ${g.dash} ${quotable(event.reason, 80)}`,
      );
    }

    case 'note': {
      // NOT run through `fold`, and that is the point of spelling both sets out.
      //
      // `⚠` is in the transliteration table and becomes `!`; `✗` is NOT, so it fell through to
      // the "this character could not be shown" `?` — which on a codepage-437 console made an
      // ERROR indistinguishable from a rendering failure, on the one line the reader most needs
      // to trust. The mark is chosen from the charset here instead, so neither level depends on
      // a table entry existing.
      const mark = NOTE_MARK[charset][event.level];
      // Longer than a summary: a note is the supervisor's own prose and usually carries a path
      // the reader needs whole. It is still sanitised, because `permission-denied` notes quote a
      // tool input the worker chose.
      return `${INDENT}${mark} ${fold(quotable(event.message, 220))}`;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The sink — the only thing here that writes, and the only thing that knows about a terminal
// ---------------------------------------------------------------------------------------------

export interface ProgressStream {
  write(text: string): unknown;
  isTTY?: boolean;
  /**
   * Terminal width, when the stream knows it (`process.stdout.columns`).
   *
   * Read live on every frame rather than captured once, so a resized window is honoured on the
   * next tick. Absent on a pipe, where `TICKER_FALLBACK_WIDTH` applies and nothing animates anyway.
   */
  columns?: number;
}

/** Assumed width when a stream reports none. The conventional terminal, and the safe guess. */
export const TICKER_FALLBACK_WIDTH = 80;

/**
 * `12.4k`, `980`, `1.2M` — a reasoning-token count at a glance.
 *
 * Rounded rather than exact because the number it reports is itself an estimate from the harness,
 * and a precise-looking figure would claim an accuracy the source does not have.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0';
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : String(Math.round(thousands))}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * What the sink must do with an event, beyond rendering it.
 *
 * Three cases rather than two, because "does it print" and "may it stop the ticker" stopped being
 * the same question when activity events arrived:
 *
 *   `lifecycle` — prints, and may start or end the in-flight unit. The original nine kinds.
 *   `activity`  — prints a feed line, but a unit is still working and the clock must keep running.
 *   `silent`    — never printed. Moves the live row's detail in place; arrives every few seconds.
 */
export type ProgressDisposition = 'lifecycle' | 'activity' | 'silent';

export function dispositionOf(event: ProgressEvent): ProgressDisposition {
  switch (event.kind) {
    case 'unit-acted':
    case 'unit-thinking':
      return 'silent';
    case 'unit-acting':
    case 'unit-blocked':
      return 'activity';
    default:
      return 'lifecycle';
  }
}

/**
 * In-place redraw, so a reader watching a five-minute Engineer sees the clock move.
 *
 * The frames come from `render.ts` rather than from a table here. There used to be one in this
 * file and another in `src/chat/io.ts`, and they had already drifted — the ASCII rows spun in
 * opposite directions, on two surfaces a chat session shows within a second of each other.
 */
const SPINNER = SPINNER_FRAMES;

/** `\r` to column zero, then erase to end of line. The only cursor control this module emits. */
const CLEAR_LINE = '\r\u001b[2K';

export interface ProgressSinkOptions {
  stream: ProgressStream;
  self: string;
  charset?: Charset;
  /**
   * Emit cursor control and the elapsed ticker.
   *
   * Defaults to `stream.isTTY === true`. When output is piped or redirected there is no cursor to
   * control and no reader to animate for: the frames would land in the file as literal escape
   * bytes, and a progress renderer that corrupts a redirect is worse than silence. The narration
   * lines themselves are NOT gated on this — a redirected campaign still gets every line, plain.
   */
  live?: boolean;
  /** Injected clock, so the ticker's elapsed reading is deterministic in a test. */
  now?: () => number;
  tickMs?: number;
  /** Injected timers, so no test has to wait on a real one. */
  timers?: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
}

export interface ProgressSink {
  emit: ProgressListener;
  /** Stop the ticker and leave the cursor on a clean line. Safe to call twice. */
  close(): void;
}

/**
 * A sink that narrates to a stream.
 *
 * The ticker starts when a unit is dispatched and stops at the next event of any kind, which is
 * exactly the window in which nothing else is going to print — a model is running and the process
 * is waiting on it. That window is the entire complaint this module answers.
 */
export function createProgressSink(options: ProgressSinkOptions): ProgressSink {
  const charset: Charset = options.charset ?? 'unicode';
  const live = options.live ?? options.stream.isTTY === true;
  const now = options.now ?? ((): number => Date.now());
  const tickMs = options.tickMs ?? 1000;
  const timers = options.timers ?? {
    set: (fn: () => void, ms: number): unknown => {
      const handle = setInterval(fn, ms);
      // A progress animation must never be the reason a finished process stays alive.
      if (typeof (handle as { unref?: () => void }).unref === 'function') {
        (handle as { unref: () => void }).unref();
      }
      return handle;
    },
    clear: (handle: unknown): void => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
  const style: ProgressStyle = { self: options.self, charset };
  const frames = SPINNER[charset];
  const glyphs = glyphsFor(charset);
  const tickerWidth = (): number => {
    const columns = options.stream.columns;
    return typeof columns === 'number' && columns > 20 ? columns : TICKER_FALLBACK_WIDTH;
  };
  const clipTo = (text: string, width: number, ellipsis: string): string =>
    clipColumns(text, Math.max(1, width), ellipsis);

  let handle: unknown = null;
  let painted = false;
  let closed = false;
  /**
   * Kept across ticker restarts, so the spinner keeps turning through a tool call instead of
   * snapping back to its first frame every time a feed line prints.
   */
  let frame = 0;
  /**
   * The unit the ticker animates for, or `null` between dispatches.
   *
   * `startedAt` is stamped ONCE, at dispatch, and never re-stamped. The ticker is now stopped and
   * restarted around every printed line, and a restart that re-read the clock would reset the
   * elapsed reading to zero on each tool call — turning the one number a watching human trusts
   * into a stopwatch that measures the gap between tool calls.
   */
  let inFlight: { label: string; detail: string; startedAt: number } | null = null;

  const stopTicker = (): void => {
    if (handle !== null) {
      timers.clear(handle);
      handle = null;
    }
    if (painted) {
      // Only ever reached on the `live` path — `painted` cannot be true otherwise.
      options.stream.write(CLEAR_LINE);
      painted = false;
    }
  };

  const startTicker = (): void => {
    const unit = inFlight;
    if (unit === null) return;
    handle = timers.set(() => {
      const seconds = Math.max(0, Math.round((now() - unit.startedAt) / 1000));
      const mark = frames[frame % frames.length] as string;
      frame += 1;
      try {
        // Clipped to the stream's own width. The ticker erases exactly ONE row (`CLEAR_LINE`), so
        // a line that wraps leaves its own tail on screen forever — and `detail` now carries
        // model-chosen file paths, which is precisely how a row gets long enough to wrap.
        const row = `${INDENT}${mark} ${unit.label}${unit.detail} ${String(seconds)}s`;
        options.stream.write(`${CLEAR_LINE}${clipTo(row, tickerWidth() - 1, glyphs.ellipsis)}`);
        // Only after the write LANDED: `painted` is a promise that there is a frame on screen to
        // erase, and `stopTicker` honours it with another write to the same stream.
        painted = true;
      } catch {
        // A dead TTY must not turn a narration frame into an uncaught exception — every other
        // emission here is reached through a caller's guard (`runCampaign`'s `progress`, chat's
        // `guardedProgress`), but a timer callback has no caller to catch it, and this one fires
        // while a campaign may be holding a worktree lease. Cleared directly rather than via
        // `stopTicker`, which would write the line-erase to the stream that just refused a write.
        if (handle !== null) {
          timers.clear(handle);
          handle = null;
        }
        painted = false;
      }
    }, tickMs);
  };

  /**
   * Move the live row's trailing detail. Never writes: the ticker repaints on its own schedule,
   * and a write here would put a second frame on a row that already has one.
   */
  const noteDetail = (event: ProgressEvent): void => {
    const unit = inFlight;
    if (unit === null) return;
    if (event.kind === 'unit-thinking') {
      unit.detail = ` ${glyphs.bullet} thinking ${formatTokens(event.tokens)}`;
      return;
    }
    if (event.kind === 'unit-acting') {
      const call = event.target === '' ? event.tool : `${event.tool}(${event.target})`;
      unit.detail = ` ${glyphs.bullet} ${call}`;
    }
  };

  return {
    emit(event: ProgressEvent): void {
      if (closed) return;

      // Silent kinds move the live row's detail and nothing else — no stream write, no ticker
      // stop, no restart. On the reference run a single 248-second reasoning gap produced 166 of
      // them, and every one that reached `stopTicker` would be a visible flicker.
      if (dispositionOf(event) === 'silent') {
        noteDetail(event);
        return;
      }

      stopTicker();
      const line = renderProgressEvent(event, style);
      if (line !== '') options.stream.write(`${line}\n`);

      if (event.kind === 'unit-dispatched') {
        inFlight = {
          label: `${formatUnit(event.rank, event.role)} ${glyphs.bullet} ${event.agentId} working`,
          detail: '',
          startedAt: now(),
        };
      } else if (event.kind === 'unit-returned') {
        inFlight = null;
      } else {
        noteDetail(event);
      }

      // Restart on EVERY printed event, not only on `unit-dispatched`. The ticker is the only live
      // signal `army campaign` has, and before activity events existed nothing else printed
      // between a dispatch and a return — so "start it once" and "restart it whenever a unit is
      // still in flight" were the same rule. They are not the same rule any more.
      if (live) startTicker();
    },
    close(): void {
      if (closed) return;
      stopTicker();
      inFlight = null;
      closed = true;
    },
  };
}
