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
import { asciiFold, glyphsFor } from './render.ts';

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
 */
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
}

/** In-place redraw, so a reader watching a five-minute Engineer sees the clock move. */
const SPINNER: Record<Charset, readonly string[]> = {
  unicode: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  ascii: ['|', '/', '-', '\\'],
};

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

  let handle: unknown = null;
  let painted = false;
  let closed = false;

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

  const startTicker = (label: string): void => {
    const startedAt = now();
    let frame = 0;
    handle = timers.set(() => {
      const seconds = Math.max(0, Math.round((now() - startedAt) / 1000));
      const mark = frames[frame % frames.length] as string;
      frame += 1;
      painted = true;
      options.stream.write(`${CLEAR_LINE}${INDENT}${mark} ${label} ${String(seconds)}s`);
    }, tickMs);
  };

  return {
    emit(event: ProgressEvent): void {
      if (closed) return;
      stopTicker();
      const line = renderProgressEvent(event, style);
      if (line !== '') options.stream.write(`${line}\n`);
      if (live && event.kind === 'unit-dispatched') {
        const g = glyphsFor(charset);
        startTicker(`${formatUnit(event.rank, event.role)} ${g.bullet} ${event.agentId} working`);
      }
    },
    close(): void {
      if (closed) return;
      stopTicker();
      closed = true;
    },
  };
}
