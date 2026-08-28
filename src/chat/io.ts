/**
 * The terminal seam.
 *
 * ## Why this is an interface and not `process.stdout.write`
 *
 * A test on this project once captured output by patching `process.stdout.write`. `node:test`
 * runs suites concurrently, so it also swallowed the RUNNER's own reporter output for everything
 * else in flight: twenty-six tests vanished from the report, two real failures surfaced as a bare
 * `test failed`, and the green number everyone was reading was a number for a smaller suite than
 * anyone thought. Injecting the seam costs one parameter. Patching a global costs the ability to
 * trust any count in the same run.
 *
 * So `runChat` never touches `process.*`. The real terminal lives in `createTerminalIo`. Its
 * piped path (either stream not a TTY) is driven by `node:readline` exactly as before, and is
 * what every test in this project still drives — through `createScriptedIo`, which stands in for
 * it. Its TTY path is a hand-rolled raw-mode line editor, and it IS exercised in the test suite
 * now, with a fake input/output pair standing in for a real terminal.
 *
 * ## Ctrl-C is not a signal here
 *
 * With a TTY, `ISIG` handling is off the moment raw mode is on — a `^C` keystroke does not
 * generate SIGINT at all, in `readline`'s terminal mode or in this file's own raw mode. The byte
 * `\x03` is read like any other keystroke and turned into an `interrupt` action by `applyKey`, or
 * — on the piped path — into a `SIGINT` emitted on the `readline` interface. A real, external
 * `SIGINT` (an operator's `kill -INT`) is wired separately, at the process level, because neither
 * of those two keystroke paths would ever see it. Both spellings coexist because they answer two
 * different questions: "did the human just type Ctrl-C" and "did something send this process a
 * real signal" — and a session should leave gracefully either way.
 *
 * This matters more than it looks. The soldier's own interrupt is ALSO not a signal — it is a
 * stdin control message — so the whole path from keystroke to aborted turn contains no signal at
 * any point, and nothing in it can kill the conversation by accident.
 *
 * ## Two painted regions, and why they are painted separately
 *
 * This file used to own exactly one row: the cursor's own, repainted with `\r` + erase-line. The
 * status block adds rows BELOW it, and the temptation is to treat the whole thing as one overlay
 * repainted together. That would be wrong in a way that costs real bytes, because the two change
 * at wildly different rates — the composer repaints on every keystroke and the spinner eight
 * times a second, while the block changes when a unit starts or a clock ticks over. So:
 *
 * - `repaint()` draws the cursor's row and does not touch what is under it. The rows below have
 *   not moved, and redrawing them per keystroke would be a cursor round trip per character.
 * - `writeBelow()` draws the rows below and puts the cursor back. It compares what it would paint
 *   against what is on screen and returns without writing a byte when they agree, which is what
 *   makes it safe to call from a 120ms timer.
 *
 * Everything that moves the cursor off its row goes through `emit`, which erases the block first
 * and paints it again afterwards. That is the whole protocol, and the two rules that keep it
 * honest are on `statusRows` (when the block may be drawn at all) and on `submitLine` (when
 * `currentExtra()` may be evaluated). Both are stated where they are enforced.
 */

import { createInterface, emitKeypressEvents } from 'node:readline';
import type { Interface as ReadlineInterface } from 'node:readline';

import { detectCharset, detectColor } from '../view/index.ts';
import type { Charset } from '../view/render.ts';
import { ANSI, SPINNER_FRAMES, asciiFold, displayWidth, paintInk, wrapPlain } from '../view/render.ts';

/**
 * The status block, as a pure function of the animation frame and the terminal's width.
 *
 * A FUNCTION rather than an array of lines, because the block animates: a spinner frame and an
 * elapsed clock both change without anything happening in the session, and a `setStatus(lines)`
 * taking a snapshot would need its caller to own a second timer writing to a stream this file is
 * documented as owning alone. So the caller supplies what the block SAYS and this file decides
 * when it is drawn, which keeps every write to `output` behind one door.
 *
 * `width` is handed in for the same reason `nextLine` does not take one: the terminal's width is
 * this file's knowledge, it changes under a running session when somebody drags a window, and a
 * caller that captured it at startup would produce rows that wrap. A wrapped status row breaks
 * the cursor arithmetic below — see `writeBelow`.
 */
export type StatusRenderer = (tick: number, width: number) => readonly string[];

export interface ChatIo {
  /** Write to the conversation. No trailing newline is added. */
  write(text: string): void;
  /**
   * Print `prompt`, then resolve with the next line the human types.
   *
   * A prompt may span lines — `runChat` asks for `'\n▌ '`, a blank separator and then the
   * prompt. On a TTY everything up to the last `\n` is printed once and only the FINAL line is
   * repainted while the human edits; on the piped path the whole string is written verbatim. The
   * distinction lives here, in the contract, because the caller has no way to know which physical
   * lines a raw-mode repaint touches — and guessing wrong is how a session once printed a stale
   * half-prompt on every keystroke.
   *
   * `null` means there will be no more input — end of stream, or `abortLine()`. The caller treats
   * both as "leave", which is why Ctrl-D and a second Ctrl-C land in the same branch.
   */
  nextLine(prompt: string): Promise<string | null>;
  /** Unblock a pending `nextLine` with `null`. What a confirmed exit uses to get out of a read. */
  abortLine(): void;
  /** Register a Ctrl-C handler. Returns the unsubscribe. */
  onInterrupt(handler: () => void): () => void;
  close(): void;
  /** True when this is a real terminal — decides whether colour and re-prompting are worth it. */
  readonly isTTY: boolean;
  /**
   * Terminal columns, live.
   *
   * A getter rather than a number, because a window that is resized mid-session changes it and
   * anything that captured it at startup starts producing rows that wrap. Off a terminal it is
   * the conventional 80 — a width nothing is measured against, but one every renderer that asks
   * for a width can be given.
   */
  readonly width: number;
  /**
   * The session is waiting on the model, with nothing to show yet. On a TTY this animates
   * `<spinner> <label> …` appended to the current line — the label so the reader knows WHOSE
   * silence they are looking at; everywhere else it is bookkeeping only. `write` (the model's
   * first token) and `setIdle` both end it — a spinner that outlived the text it stood in for
   * would be a lie about what the process is doing.
   */
  setBusy(label: string): void;
  /** The wait is over, with nothing ever written. Idempotent with an unstarted or already-ended spinner. */
  setIdle(): void;
  /**
   * Install, replace or clear (`null`) the status block pinned under the conversation.
   *
   * On a TTY this is one or more rows painted BELOW the cursor's row and repainted in place —
   * the branch, the loadout, the cost, and a row per unit in flight. Everywhere else it is
   * bookkeeping only: escape bytes in a redirected transcript are a corruption, not a feature,
   * and the same reasoning gates the spinner and the campaign ticker.
   *
   * The block is drawn only when the current row is FINISHED — see `writeBelow`. A caller that
   * installs one is asking for it to be visible whenever it can be, not promising a row count.
   */
  setStatus(render: StatusRenderer | null): void;
}

/**
 * A queue-backed line reader.
 *
 * Lines typed WHILE A TURN IS STREAMING are buffered rather than dropped. That is not politeness:
 * the alternative is that a human who types their next question during a long answer loses it,
 * and the failure is silent — they see their own characters echoed and then nothing happens.
 */
interface LineQueue {
  push(line: string): void;
  end(): void;
  take(): Promise<string | null>;
  abort(): void;
}

function createLineQueue(): LineQueue {
  const buffered: string[] = [];
  let waiter: ((value: string | null) => void) | null = null;
  let ended = false;

  const deliver = (value: string | null): boolean => {
    if (waiter === null) return false;
    const resolve = waiter;
    waiter = null;
    resolve(value);
    return true;
  };

  return {
    push(line: string): void {
      if (!deliver(line)) buffered.push(line);
    },
    end(): void {
      ended = true;
      deliver(null);
    },
    abort(): void {
      // Buffered type-ahead is discarded on the way out. Replaying a queued line into a session
      // that is closing would run a turn nobody is watching.
      buffered.length = 0;
      deliver(null);
    },
    take(): Promise<string | null> {
      const next = buffered.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (ended) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        waiter = resolve;
      });
    },
  };
}

/** Ctrl-C bookkeeping, identical on both the piped and the raw path. */
function createInterruptHub(): {
  fire(): void;
  onInterrupt(handler: () => void): () => void;
  clear(): void;
} {
  const handlers = new Set<() => void>();
  return {
    fire(): void {
      for (const handler of handlers) handler();
    },
    onInterrupt(handler: () => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    clear(): void {
      handlers.clear();
    },
  };
}

// =================================================================================================
// The line-editor core — pure, and exported so it is testable without a terminal in sight.
//
// `applyKey` knows nothing about a stream, a spinner, or history. It takes the buffer and the
// cursor as they stand and one keystroke, and says what changed. Everything that touches a stream
// — painting, erasing, the spinner, session history — is glue built on top of it in
// `createRawTerminalIo`, and stays thin because this is where the decisions already live.
// =================================================================================================

export interface EditorState {
  readonly buffer: string;
  readonly cursor: number;
}

export type EditorAction =
  | { kind: 'state'; state: EditorState }
  | { kind: 'submit'; line: string }
  | { kind: 'eof' }
  | { kind: 'interrupt' }
  | { kind: 'ignore' };

/**
 * A minimal shape of `readline`'s keypress event. Not imported from `node:readline` — that type
 * is an implementation detail of a module this file does not want `applyKey`'s tests to depend
 * on, and the four fields below are the whole of what a keystroke ever needs to mean here.
 */
export interface Key {
  readonly sequence?: string;
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

function stateAction(current: EditorState, buffer: string, cursor: number): EditorAction {
  // A key that changes nothing (Left at column 0, Ctrl-K on an already-empty tail) reports
  // `ignore` rather than a `state` action equal to the one already held — so a caller watching
  // for "did anything happen" (whether to repaint, say) has one thing to check, not a deep-equal.
  if (buffer === current.buffer && cursor === current.cursor) return { kind: 'ignore' };
  return { kind: 'state', state: { buffer, cursor } };
}

/** Strip C0 controls (and DEL) from a keystroke's raw text before it can reach the buffer. */
function printableText(sequence: string): string {
  let out = '';
  for (const ch of sequence) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

function deleteLeft(state: EditorState): EditorAction {
  if (state.cursor === 0) return { kind: 'ignore' };
  const buffer = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
  return stateAction(state, buffer, state.cursor - 1);
}

function deleteRight(state: EditorState): EditorAction {
  if (state.cursor >= state.buffer.length) return { kind: 'ignore' };
  const buffer = state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1);
  return stateAction(state, buffer, state.cursor);
}

/** Ctrl-W: delete the word behind the cursor, the way every readline-alike does it. */
function deleteWordLeft(state: EditorState): EditorAction {
  if (state.cursor === 0) return { kind: 'ignore' };
  let start = state.cursor;
  while (start > 0 && state.buffer[start - 1] === ' ') start -= 1;
  while (start > 0 && state.buffer[start - 1] !== ' ') start -= 1;
  const buffer = state.buffer.slice(0, start) + state.buffer.slice(state.cursor);
  return stateAction(state, buffer, start);
}

/**
 * One keystroke in, one action out.
 *
 * History (Up/Down) is deliberately absent: this function has no session to remember, only the
 * buffer in front of it, and `createRawTerminalIo` intercepts those two names before a keystroke
 * ever reaches here — see `historyUp`/`historyDown` below.
 */
export function applyKey(state: EditorState, key: Key): EditorAction {
  if (key.ctrl === true && key.name === 'c') return { kind: 'interrupt' };
  if (key.name === 'return' || key.name === 'enter') return { kind: 'submit', line: state.buffer };
  if (key.ctrl === true && key.name === 'd') {
    return state.buffer === '' ? { kind: 'eof' } : deleteRight(state);
  }
  // A blanket rule ahead of the named-key table below: an Alt/Option-modified key has no assigned
  // meaning here (no word-left/word-right), and letting it fall through to "insert as text" would
  // put the raw escape bytes of somebody's OS keybinding into the conversation.
  if (key.meta === true) return { kind: 'ignore' };

  if (key.name === 'backspace') return deleteLeft(state);
  if (key.name === 'delete') return deleteRight(state);
  if (key.name === 'left') return stateAction(state, state.buffer, Math.max(0, state.cursor - 1));
  if (key.name === 'right') {
    return stateAction(state, state.buffer, Math.min(state.buffer.length, state.cursor + 1));
  }
  if (key.name === 'home' || (key.ctrl === true && key.name === 'a')) {
    return stateAction(state, state.buffer, 0);
  }
  if (key.name === 'end' || (key.ctrl === true && key.name === 'e')) {
    return stateAction(state, state.buffer, state.buffer.length);
  }
  if (key.ctrl === true && key.name === 'u') {
    return stateAction(state, state.buffer.slice(state.cursor), 0);
  }
  if (key.ctrl === true && key.name === 'k') {
    return stateAction(state, state.buffer.slice(0, state.cursor), state.cursor);
  }
  if (key.ctrl === true && key.name === 'w') return deleteWordLeft(state);
  // Owned by the glue's session history, not this function — see the module comment above.
  if (key.name === 'up' || key.name === 'down') return { kind: 'ignore' };
  // Any other control combination (Ctrl-B, Ctrl-L, …) has no assigned behaviour either.
  if (key.ctrl === true) return { kind: 'ignore' };

  const text = printableText(key.sequence ?? '');
  if (text === '') return { kind: 'ignore' };
  const buffer = state.buffer.slice(0, state.cursor) + text + state.buffer.slice(state.cursor);
  return stateAction(state, buffer, state.cursor + text.length);
}

/**
 * Session-local history — separate from `EditorState` on purpose (decision in the brief this file
 * implements): `applyKey` is pure over one buffer, and history is a second, independent piece of
 * state the terminal glue owns and feeds back in. Kept as pure functions so it is testable the
 * same way `applyKey` is, without a stream anywhere near it.
 */
export interface EditorHistory {
  readonly lines: readonly string[];
  /** Index into `lines` currently shown; `lines.length` means "viewing the live draft". */
  readonly index: number;
  /** The live buffer as it stood the moment Up first moved off it. */
  readonly draft: string;
}

export function historyInit(): EditorHistory {
  return { lines: [], index: 0, draft: '' };
}

/** Recorded on submit — editing a recalled line and then submitting stores the edited version. */
export function historySubmit(history: EditorHistory, line: string): EditorHistory {
  const lines = [...history.lines, line];
  return { lines, index: lines.length, draft: '' };
}

export function historyUp(
  history: EditorHistory,
  currentBuffer: string,
): { history: EditorHistory; buffer: string } {
  if (history.index === 0) return { history, buffer: currentBuffer };
  const draft = history.index === history.lines.length ? currentBuffer : history.draft;
  const index = history.index - 1;
  return { history: { lines: history.lines, index, draft }, buffer: history.lines[index] as string };
}

export function historyDown(
  history: EditorHistory,
  currentBuffer: string,
): { history: EditorHistory; buffer: string } {
  if (history.index >= history.lines.length) return { history, buffer: currentBuffer };
  const index = history.index + 1;
  if (index === history.lines.length) {
    return { history: { lines: history.lines, index, draft: '' }, buffer: history.draft };
  }
  return {
    history: { lines: history.lines, index, draft: history.draft },
    buffer: history.lines[index] as string,
  };
}

// =================================================================================================
// Backslash continuation: multiline input without a multi-row composer.
//
// A line whose Enter arrives with a single trailing backslash continues instead of submitting:
// the backslash comes off, the segment is held, and the next line joins it with a newline. The
// composer itself never holds a newline. Earlier segments are already echoed above, only the
// segment being typed is live on the cursor row, so the one-row repaint model and every piece of
// cursor arithmetic built on it stay untouched.
// =================================================================================================

export type ContinuationStep =
  | { kind: 'continue'; segment: string }
  | { kind: 'submit'; line: string };

/**
 * One Enter press, judged against the segments already held.
 *
 * Only the line's last characters are inspected, and the rule is two cases deep on purpose: a
 * single trailing backslash continues (and comes off), a trailing double backslash submits with
 * the pair collapsed to one literal backslash (the escape for "I really mean a backslash at the
 * end"), and everything else submits as typed. Backslashes anywhere else in the line are never
 * touched, so paths and regexes pass through whole. Shared by all three input paths, which is
 * what keeps `first \` + `second` meaning the same two-line turn on a raw terminal, a pipe and a
 * scripted test.
 */
export function continuationStep(segments: readonly string[], line: string): ContinuationStep {
  if (line.endsWith('\\\\')) {
    return { kind: 'submit', line: [...segments, `${line.slice(0, -2)}\\`].join('\n') };
  }
  if (line.endsWith('\\')) return { kind: 'continue', segment: line.slice(0, -1) };
  return { kind: 'submit', line: [...segments, line].join('\n') };
}

/**
 * Fold backslash-continued lines into whole entries, for the queue-fed paths.
 *
 * The raw path applies `continuationStep` keystroke by keystroke because it also owns the echo;
 * the piped path and the scripted stand-in have no composer, so this fold is the entire feature
 * there. An entry still open when the stream ends is dropped with the stream, the same way a
 * half-typed line is.
 */
function continuationFold(push: (entry: string) => void): (line: string) => void {
  let segments: string[] = [];
  return (line: string): void => {
    const step = continuationStep(segments, line);
    if (step.kind === 'continue') {
      segments = [...segments, step.segment];
      return;
    }
    segments = [];
    push(step.line);
  };
}

// =================================================================================================
// The real terminal
// =================================================================================================

export interface TerminalIoOptions {
  input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  /**
   * `rows` is read for exactly one decision: whether there is room under the conversation for a
   * status block at all. A terminal three rows tall that is asked to pin two of them has no
   * screen left to hold a conversation in.
   */
  output?: NodeJS.WritableStream & { isTTY?: boolean; columns?: number; rows?: number };
}

/** `\r` to column zero, then erase to end of line. With `cursorUp`, the whole cursor vocabulary. */
const ERASE_LINE = '\r[2K';

/**
 * Move the cursor up `n` rows, staying in the same column.
 *
 * The second and last cursor control this file emits, and it is the whole of what makes a
 * multi-row overlay possible. RELATIVE, never absolute: a terminal that scrolls while the block
 * is being painted moves the conversation and the cursor together, so "up two rows" stays correct
 * where a saved absolute position would be wrong by however far it had scrolled.
 */
const cursorUp = (n: number): string => `[${String(n)}A`;

const ELLIPSIS: Record<Charset, string> = { unicode: '…', ascii: '~' };

/** The trailing mark on the busy label — `⠋ commander …`. `~` would read as a typo in prose. */
const LABEL_ELLIPSIS: Record<Charset, string> = { unicode: '…', ascii: '...' };

/**
 * The composer's prompt while a backslash continuation is open. Painted dim where the main
 * prompt is bold: this row is the tail of an entry, not a fresh question. `~ ` on ascii would
 * read as a home-directory typo, so the fold picks `. ` instead.
 */
const CONTINUATION_PROMPT: Record<Charset, string> = { unicode: '… ', ascii: '. ' };

/**
 * Split a prompt into the lines above the composer and the composer's own single line.
 *
 * `runChat`'s prompt is `'\n▌ '` — a blank separator line, then the prompt. The separator is
 * ordinary output: printed once, when the read begins. Only the FINAL line may be repainted per
 * keystroke, because the repaint primitive is `\r` + erase-line, which touches exactly one
 * physical row. Feeding the whole string to the repaint was the shipped bug: every keystroke
 * re-emitted the embedded `\n`, the cursor walked DOWN a row per key, and each abandoned row kept
 * a stale partial prompt. This function is where that class of bug dies, for any prompt bytes.
 */
export function splitPromptLead(prompt: string): { lead: string; line: string } {
  const cut = prompt.lastIndexOf('\n');
  if (cut === -1) return { lead: '', line: prompt };
  return { lead: prompt.slice(0, cut + 1), line: prompt.slice(cut + 1) };
}

/** What the composer paints from. `prompt` and `colouredPrompt` are the SAME text ± SGR. */
export interface ComposerView {
  /** The live prompt, colour-free and single-line — this is what the width budget is charged. */
  prompt: string;
  /** The same prompt as painted, possibly wrapped in SGR. Never charged against the width. */
  colouredPrompt: string;
  buffer: string;
  cursor: number;
  /** Terminal columns. */
  width: number;
  /** The mark for a cut edge when the buffer is wider than the window. */
  ellipsis: string;
}

/**
 * One frame of the composer — the bytes painted after `\r\x1b[2K`, mapping
 * (prompt, buffer, cursor, width) to exactly one physical row. Pure, so a test can assert on the
 * frame itself: it must never contain `\n` (a newline here is the walking-cursor bug), and it
 * must fit the width.
 *
 * Cursor positioning by re-writing, not column math: draw the full visible line, return to
 * column 0, then redraw only the prompt and the slice left of the cursor. The terminal's own
 * cursor lands after that second write, wherever it is — a wide glyph earlier in the line cannot
 * desynchronise a column count that was never computed. This requires that the frame OWNS the
 * whole physical row: the glue starts a fresh line before painting for exactly that reason.
 */
export function renderComposerFrame(view: ComposerView): string {
  // Code points, not UTF-16 units — `›` is fine either way but a prompt is caller-supplied text.
  const promptCols = [...view.prompt].length;
  // One column held back: a glyph printed into the final column leaves the terminal in the
  // wrap-pending state, where the next frame's `\r` can land on the wrong row.
  const maxBufferWidth = Math.max(0, view.width - promptCols - 1);
  const { text, cursorAt } = slidingWindow(view.buffer, view.cursor, maxBufferWidth, view.ellipsis);
  return `${view.colouredPrompt}${text}\r${view.colouredPrompt}${text.slice(0, cursorAt)}`;
}

/**
 * Keep the cursor visible inside a `maxWidth`-wide slice of `buffer`, marking whichever edge got
 * cut. Not asked to get column arithmetic right for wide glyphs — nothing downstream of this
 * counts columns to PLACE the cursor, only to decide how much of the buffer fits at all. See the
 * cursor-positioning note on `renderInputLine` below for why that split is safe.
 */
function slidingWindow(
  buffer: string,
  cursor: number,
  maxWidth: number,
  ellipsis: string,
): { text: string; cursorAt: number } {
  if (maxWidth <= 0) return { text: '', cursorAt: 0 };
  if (buffer.length <= maxWidth) return { text: buffer, cursorAt: cursor };
  let start = Math.max(0, Math.min(cursor - Math.floor(maxWidth / 2), buffer.length - maxWidth));
  const leftCut = start > 0;
  let budget = maxWidth - (leftCut ? 1 : 0);
  let end = Math.min(buffer.length, start + budget);
  const rightCut = end < buffer.length;
  if (rightCut) budget -= 1;
  end = Math.min(buffer.length, start + budget);
  if (leftCut) start = Math.max(start, 1);
  const left = leftCut ? ellipsis : '';
  const right = rightCut ? ellipsis : '';
  const text = left + buffer.slice(start, end) + right;
  const cursorAt = left.length + Math.max(0, Math.min(cursor, end) - start);
  return { text, cursorAt };
}

/**
 * The raw-mode terminal.
 *
 * Owns the stream completely: nothing else is allowed to write to `output` while this is live,
 * because the whole point of this file is that two writers on one cursor is the bug. The core
 * invariant it keeps — stated in full in the module this implements — is that the input line is
 * painted if and only if a `nextLine` is pending. Everywhere else, keystrokes update `editor`
 * silently and never touch `output`.
 */
function createRawTerminalIo(
  input: NonNullable<TerminalIoOptions['input']>,
  output: NonNullable<TerminalIoOptions['output']>,
): ChatIo {
  const colour = detectColor(process.env, true);
  const charset: Charset = detectCharset(process.env, true, process.platform);
  const frames = SPINNER_FRAMES[charset];
  const ellipsis = ELLIPSIS[charset];

  const hub = createInterruptHub();

  /** Text written since the last `\n` — what a repaint restores before appending anything. */
  let tail = '';
  let painted = false;
  let plainPrompt = '';
  let colouredPrompt = '';
  /**
   * Completed segments of a backslash-continued entry; empty when no continuation is open.
   *
   * While it is non-empty the composer paints the continuation prompt instead of the main one,
   * and Enter keeps joining rather than submitting. It never holds the live segment; that is
   * `editor.buffer`, on the one row the repaint owns.
   */
  let pendingSegments: string[] = [];
  const contPlainPrompt = CONTINUATION_PROMPT[charset];
  const contColouredPrompt = paintInk(colour, 'dim', contPlainPrompt);
  const livePlainPrompt = (): string =>
    pendingSegments.length > 0 ? contPlainPrompt : plainPrompt;
  const liveColouredPrompt = (): string =>
    pendingSegments.length > 0 ? contColouredPrompt : colouredPrompt;
  let editor: EditorState = { buffer: '', cursor: 0 };
  let history: EditorHistory = historyInit();
  let resolveLine: ((value: string | null) => void) | null = null;
  /** Fully Enter-terminated lines typed while nobody was reading — delivered whole, in order. */
  const committed: string[] = [];
  let ended = false;
  let closed = false;

  let spinnerActive = false;
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  /** Whose silence the spinner stands for — painted next to the frame as `⠋ commander …`. */
  let busyLabel = '';
  /** A `\r\n` paste sends two keypress events; the LF half is swallowed so no phantom line lands. */
  let pendingCrlf = false;

  /** The status block's source, its animation frame, and what is currently on screen below. */
  let statusRender: StatusRenderer | null = null;
  let statusTick = 0;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  /** Rows the block occupies below the cursor's row right now. */
  let below = 0;
  /** What those rows say, so an unchanged block is never repainted. */
  let belowText = '';

  const colourizePrompt = (prompt: string): string =>
    colour ? `${ANSI.bold}${ANSI.green}${prompt}${ANSI.reset}` : prompt;

  const spinnerText = (): string => {
    const frame = frames[spinnerFrame % frames.length] as string;
    const text = busyLabel === '' ? frame : `${frame} ${busyLabel} ${LABEL_ELLIPSIS[charset]}`;
    // Dim, not coloured: the spinner is a placeholder for text that has not arrived, and it must
    // read as quieter than the text that will replace it.
    return paintInk(colour, 'dim', text);
  };

  /**
   * Terminal columns.
   *
   * Not `?? 80`: a PTY without a window size — `script(1)`, some SSH and CI terminals — reports
   * columns as 0, which is not nullish. A 0-column width makes the composer's buffer window empty
   * and everything typed INVISIBLE. Found on a real PTY; no fake with `columns: 80` could ever
   * have seen it, which is why the guard is `> 0` rather than a nullish coalesce.
   */
  const widthOf = (): number => {
    const columns = output.columns;
    return typeof columns === 'number' && columns > 0 ? columns : 80;
  };

  const currentExtra = (): string => {
    if (spinnerActive) return spinnerText();
    if (painted) {
      return renderComposerFrame({
        prompt: livePlainPrompt(),
        colouredPrompt: liveColouredPrompt(),
        buffer: editor.buffer,
        cursor: editor.cursor,
        width: widthOf(),
        ellipsis,
      });
    }
    return '';
  };

  /**
   * What the status block should say right now, or nothing at all.
   *
   * **The block is drawn only when `tail === ''`** — when the writer has finished with the row the
   * cursor is on. That single rule is what keeps the cursor arithmetic in `writeBelow` honest, and
   * it is worth being exact about why, because the rule looks like a stylistic choice and is not:
   *
   * `writeBelow` returns the cursor by re-writing `tail` after a bare `\r`. If `tail` is longer
   * than the terminal is wide it has already WRAPPED, so `\r` lands at the start of its last
   * physical row and the rewrite paints the whole of it again from there — the same one-row
   * assumption the composer's repaint has always made, and the reason `nextLine` forces a fresh
   * line before painting. Mid-answer, `tail` is a partial line of streamed model prose and grows
   * without bound between newlines, so it is exactly the case the assumption does not survive.
   *
   * The visible consequence is that the block is up at the prompt and through a dispatch's
   * line-by-line narration, and steps aside while an answer streams — where the inline spinner is
   * already saying what it would have said. It reappears on the newline that ends the answer.
   */
  const statusRows = (): readonly string[] => {
    if (statusRender === null || tail !== '' || closed) return [];
    const width = widthOf();
    const rows = statusRender(statusTick, width);
    // A row carrying a newline would put the block's own row count out by one and leave the
    // cursor a row adrift for the rest of the session. The renderer is trusted to be pure, not
    // to be careful, and the fix has to be here rather than in a contract nobody can enforce.
    const flat = rows.map((line) => line.replace(/[\r\n]+/gu, ' '));
    const rowCount = output.rows;
    // Two rows held back: one for the row the conversation is being written on, one so the
    // terminal is not left with nowhere to scroll. A window too short for that gets no block at
    // all rather than a block that eats the conversation.
    if (typeof rowCount === 'number' && rowCount > 0 && flat.length + 2 > rowCount) return [];
    return flat;
  };

  /**
   * Paint (or erase) the rows under the cursor, and put the cursor back where it was.
   *
   * The span is `max(wanted, painted)`: shrinking from three rows to one still has to walk over
   * the third and erase it, or a unit that has finished stays on screen forever. A no-op when
   * nothing has changed, which is what makes it safe to call from the 120ms spinner tick.
   */
  const writeBelow = (rows: readonly string[]): void => {
    const text = rows.join('\n');
    if (rows.length === below && text === belowText) return;
    const span = Math.max(rows.length, below);
    if (span === 0) return;
    let out = '';
    for (let i = 0; i < span; i += 1) out += `\n${ERASE_LINE}${rows[i] ?? ''}`;
    out += cursorUp(span);
    // `\r` and then the row's own content again, which is how the cursor gets back to a column
    // this file never had to count — the same trick `renderComposerFrame` uses, for the same
    // reason: a wide glyph earlier in the line cannot desynchronise arithmetic that never ran.
    out += `\r${tail}${currentExtra()}`;
    below = rows.length;
    belowText = text;
    output.write(out);
  };

  /** Erase the block. Called before ANY write that can move the cursor off its row. */
  const clearBelow = (): void => {
    writeBelow([]);
  };

  const syncBelow = (): void => {
    writeBelow(statusRows());
  };

  /** Repaint the cursor's own row. Leaves the block below alone — it has not moved. */
  const repaint = (): void => {
    output.write(`${ERASE_LINE}${tail}${currentExtra()}`);
    syncBelow();
  };

  const extendTail = (text: string): void => {
    const combined = tail + text;
    const at = combined.lastIndexOf('\n');
    tail = at === -1 ? combined : combined.slice(at + 1);
  };

  const stopSpinnerTimer = (): void => {
    if (spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    spinnerActive = false;
  };

  /** The one primitive every write in this file goes through. */
  const emit = (text: string): void => {
    const needsRestore = spinnerActive || painted;
    if (spinnerActive) stopSpinnerTimer();
    // Before anything else, and unconditionally: the block occupies rows below the one about to
    // be written, and `text` may wrap onto them, scroll past them, or end in a newline that lands
    // the cursor straight on top of the first of them.
    clearBelow();
    if (needsRestore) output.write(`${ERASE_LINE}${tail}`);
    output.write(text);
    extendTail(text);
    syncBelow();
  };

  const eraseInputLine = (): void => {
    output.write(`${ERASE_LINE}${tail}`);
    painted = false;
    syncBelow();
  };

  const settlePending = (value: string | null): void => {
    const resolve = resolveLine;
    resolveLine = null;
    if (resolve !== null) resolve(value);
  };

  /**
   * A submitted entry, painted as a block belonging to the human.
   *
   * Two things changed here after watching a real session, and both were failures of the same
   * kind — the screen not saying who was speaking.
   *
   * The entry now WRAPS. It used to go out as one string, so a question longer than the window
   * hard-broke at the terminal's right edge, mid-word, while the commander's answer beneath it
   * wrapped properly. One speaker's paragraphs breaking and the other's not does not read as two
   * speakers; it reads as a bug.
   *
   * And the prompt repeats down every wrapped row. `you › ` was a label on the first row of a
   * turn, and a label on one row cannot mark a region — the eye had nothing to follow. A coloured
   * rule down the left edge of every row is a region, recognisable before a word of it is read.
   * The text itself is no longer dimmed, either: the rule carries the identity now, and dim is
   * the weight of metadata, not of the thing the reader just said.
   *
   * Every row takes the READ's own prompt rather than the live one, so a backslash-continued
   * entry lands as one block instead of a first row and a train of `… ` tails.
   */
  const paintEntry = (rows: readonly string[]): string => {
    // Held off the last column for the same reason every other row here is: a row that reaches
    // the right edge leaves the terminal in the wrap-pending state the `ESC[nA` arithmetic in
    // `writeBelow` cannot see. The floor keeps a narrow window from producing a zero-width one.
    const budget = Math.max(8, widthOf() - displayWidth(plainPrompt) - 1);
    return rows
      .flatMap((row) => wrapPlain(row, budget))
      .map((row) => `${colouredPrompt}${row}`)
      .join('\n');
  };

  const echoEntryLine = (line: string): void => {
    // The composer is retired BEFORE the echo, not after it, and the order is load-bearing.
    //
    // `emit` ends by putting the status block back, and putting it back means returning the
    // cursor — which it does by re-writing `tail` and `currentExtra()`. With `painted` still true
    // at that moment, `currentExtra()` is the composer's own frame, so Enter drew the submitted
    // line, then drew it AGAIN on the row below: one duplicate per line typed, for the whole
    // session. Erasing first means there is no composer left for the restore to paint.
    //
    // The general rule, and the one to keep in mind when adding a caller: `currentExtra()` must
    // never be evaluated after a write that consumed the row the composer was painted on. `write`
    // does not violate it — there the composer legitimately follows the output down a row.
    eraseInputLine();
    // A continued row echoes AS TYPED, trailing backslash included: the transcript records
    // keystrokes, and the join is the delivered text's business.
    emit(`${paintEntry([line])}\n`);
  };

  const takeCommitted = (): string | null | undefined => {
    if (committed.length > 0) return committed.shift() as string;
    if (ended) return null;
    return undefined;
  };

  const applyHistoryMove = (
    move: (h: EditorHistory, buf: string) => { history: EditorHistory; buffer: string },
  ): void => {
    const result = move(history, editor.buffer);
    history = result.history;
    editor = { buffer: result.buffer, cursor: result.buffer.length };
    if (painted) repaint();
  };

  const onKeypress = (
    chunk: string | undefined,
    raw: { sequence?: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean } | undefined,
  ): void => {
    const key: Key = {
      sequence: raw?.sequence ?? chunk,
      name: raw?.name,
      ctrl: raw?.ctrl,
      meta: raw?.meta,
      shift: raw?.shift,
    };

    if (pendingCrlf) {
      pendingCrlf = false;
      // The `\n` half of a `\r\n` paste line — already accounted for by the `\r` above it.
      if (key.name === 'enter' && key.sequence === '\n') return;
    }
    pendingCrlf = key.name === 'return' && key.sequence === '\r';

    if (key.name === 'up') {
      applyHistoryMove(historyUp);
      return;
    }
    if (key.name === 'down') {
      applyHistoryMove(historyDown);
      return;
    }

    const action = applyKey(editor, key);
    switch (action.kind) {
      case 'interrupt':
        // Ctrl-C with a continuation open abandons the pending entry, painted or not. It is the
        // "throw away what I was typing" gesture, not an exit gesture, so the hub never hears
        // it: arming exit off a discarded draft is how a later keystroke ends a session by
        // surprise. The echoed segments stay in scrollback; nothing after them was delivered.
        if (pendingSegments.length > 0) {
          pendingSegments = [];
          editor = { buffer: '', cursor: 0 };
          if (painted) repaint();
          return;
        }
        hub.fire();
        return;
      case 'eof':
        // Ctrl-D ends the read whole: a half-built continuation must not leak into a later one.
        pendingSegments = [];
        if (painted) {
          eraseInputLine();
          settlePending(null);
        } else {
          ended = true;
        }
        return;
      case 'submit': {
        const step = continuationStep(pendingSegments, action.line);
        if (painted) {
          echoEntryLine(action.line);
          editor = { buffer: '', cursor: 0 };
          if (step.kind === 'continue') {
            // The entry is still open: hold the segment, repaint a fresh continuation row, and
            // leave the pending `nextLine` exactly where it is.
            pendingSegments.push(step.segment);
            painted = true;
            repaint();
            return;
          }
          pendingSegments = [];
          // History stores the DELIVERED text with newlines flattened to spaces: the composer
          // is one row, so a recalled entry must be a line, and flattening at store time means
          // recall, edit and resubmit all handle the same honest string. Stated behaviour, and
          // pinned by a test, rather than a silent mangling at recall time.
          history = historySubmit(history, step.line.replace(/\n/gu, ' '));
          settlePending(step.line);
          return;
        }
        // Nobody is reading yet: the same state machine, minus the echo nobody would see. A
        // completed entry queues whole and is echoed at pickup, exactly the multi-message
        // type-ahead the old `LineQueue` gave the piped path.
        editor = { buffer: '', cursor: 0 };
        if (step.kind === 'continue') {
          pendingSegments.push(step.segment);
          return;
        }
        pendingSegments = [];
        committed.push(step.line);
        return;
      }
      case 'state':
        editor = action.state;
        if (painted) repaint();
        return;
      case 'ignore':
        return;
    }
  };

  emitKeypressEvents(input);
  if (typeof input.setRawMode === 'function') input.setRawMode(true);
  if (typeof (input as { resume?: () => void }).resume === 'function') {
    (input as { resume: () => void }).resume();
  }
  input.on('keypress', onKeypress as (chunk: string, key: unknown) => void);
  process.on('SIGINT', hub.fire);

  return {
    isTTY: true,
    get width(): number {
      return widthOf();
    },

    write(text: string): void {
      emit(text);
      if (painted) {
        // The composer's frame repositions with a bare `\r`, so it must own its physical row from
        // column 0. A write that did not end in `\n` (none of `runChat`'s do, but the seam cannot
        // know that) would otherwise leave its tail under the prompt's repaint.
        if (tail !== '') {
          output.write('\n');
          tail = '';
        }
        repaint();
      }
    },

    nextLine(prompt: string): Promise<string | null> {
      // Only the final line of the prompt is live — see `splitPromptLead` for the bug this kills.
      const { lead, line } = splitPromptLead(prompt);
      // Folded HERE rather than at every call site. A prompt is decoration like any other row,
      // and `runChat` spells its two in unicode; a cp437 console was getting the raw code points
      // and drawing whatever its own table said they were.
      plainPrompt = charset === 'ascii' ? asciiFold(line) : line;
      colouredPrompt = colourizePrompt(plainPrompt);
      // The lead (usually one blank separator line) is ordinary output, printed once per read.
      // Then the composer takes a fresh physical line: if something is still sitting on the
      // current one — narration that never got a trailing `\n`, say — start below it rather than
      // paint the prompt onto its end.
      const freshLine = (): void => {
        if (lead !== '') emit(lead);
        if (tail !== '') emit('\n');
      };
      const queued = takeCommitted();
      if (queued !== undefined) {
        if (queued !== null) {
          freshLine();
          // A queued entry may be multiline (typed with backslash continuations while a turn
          // streamed). It echoes as the same block a live entry does, wrap and all.
          emit(`${paintEntry(queued.split('\n'))}\n`);
        }
        return Promise.resolve(queued);
      }
      freshLine();
      painted = true;
      repaint();
      return new Promise<string | null>((resolve) => {
        resolveLine = resolve;
      });
    },

    abortLine(): void {
      committed.length = 0;
      pendingSegments = [];
      editor = { buffer: '', cursor: 0 };
      if (spinnerActive) stopSpinnerTimer();
      if (painted) eraseInputLine();
      settlePending(null);
    },

    setStatus(render: StatusRenderer | null): void {
      statusRender = render;
      statusTick = 0;
      if (statusTimer !== null) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      if (render !== null && !closed) {
        // The same 120ms the composer's spinner runs at, deliberately: two animations on one
        // screen at two rates read as one of them stuttering, and nothing here needs a rate of
        // its own. The tick is cheap when nothing has changed — `writeBelow` compares the block
        // it would paint against the one on screen and returns without writing a byte.
        statusTimer = setInterval(() => {
          statusTick += 1;
          try {
            syncBelow();
          } catch {
            // Same rule as the spinner tick below: a timer callback has no caller to catch it, so
            // a dead output stream must not turn a status frame into an uncaught exception.
            if (statusTimer !== null) {
              clearInterval(statusTimer);
              statusTimer = null;
            }
            below = 0;
            belowText = '';
          }
        }, 120);
        if (typeof statusTimer.unref === 'function') statusTimer.unref();
      }
      syncBelow();
    },

    onInterrupt: hub.onInterrupt,

    close(): void {
      if (closed) return;
      // The block comes down BEFORE `closed` is set, because `statusRows` refuses to render for a
      // closed terminal — flipping the flag first would make `clearBelow` a no-op and leave the
      // status rows sitting under the shell prompt for the rest of the day.
      if (statusTimer !== null) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      statusRender = null;
      clearBelow();
      closed = true;
      ended = true;
      pendingSegments = [];
      const hadOverlay = spinnerActive || painted;
      if (spinnerActive) stopSpinnerTimer();
      if (painted) painted = false;
      if (hadOverlay) output.write(`${ERASE_LINE}${tail}`);
      if (tail !== '') output.write('\n');
      tail = '';
      try {
        if (typeof input.setRawMode === 'function') input.setRawMode(false);
      } catch {
        /* best effort — a dead stream cannot un-raw itself, and that is not this call's problem */
      }
      input.removeListener('keypress', onKeypress as (chunk: string, key: unknown) => void);
      // The mirror of the `resume()` at construction, and the line the process's exit hangs on:
      // a resumed stdin holds a ref that keeps the event loop alive, so without this a session
      // that failed preflight printed its refusal and then sat until Ctrl-C. Guarded the same
      // way the resume is, because the seam only promises a readable stream.
      if (typeof (input as { pause?: () => void }).pause === 'function') {
        (input as { pause: () => void }).pause();
      }
      process.removeListener('SIGINT', hub.fire);
      hub.clear();
      settlePending(null);
    },

    setBusy(label: string): void {
      busyLabel = label;
      spinnerActive = true;
      spinnerFrame = 0;
      repaint();
      spinnerTimer = setInterval(() => {
        spinnerFrame += 1;
        try {
          repaint();
        } catch {
          // A dead output stream must not turn a spinner tick into an uncaught exception — see
          // the module note this implements: every other write in this file is allowed to throw
          // (that policy belongs to `guardedWrite` in `run.ts`), but a timer callback has no
          // caller to catch it, so THIS one repaint is the exception.
          stopSpinnerTimer();
        }
      }, 120);
      if (typeof spinnerTimer.unref === 'function') spinnerTimer.unref();
    },

    setIdle(): void {
      if (!spinnerActive) return;
      stopSpinnerTimer();
      repaint();
    },
  };
}

/** The piped path: `node:readline` in non-terminal mode, exactly as before. */
function createPipedTerminalIo(
  input: NonNullable<TerminalIoOptions['input']>,
  output: NonNullable<TerminalIoOptions['output']>,
): ChatIo {
  const queue = createLineQueue();
  const rl: ReadlineInterface = createInterface({
    input,
    output,
    terminal: false,
    // A pasted CRLF must not arrive as an empty second line. Windows is a target here.
    crlfDelay: Infinity,
  });
  rl.setPrompt('');

  // The fold, not a bare push: `first \` then `second` must reach the session as one two-line
  // turn on a pipe exactly as it does on a raw terminal, or the scripted stand-in below tests a
  // behaviour the real piped path does not have.
  const foldLine = continuationFold((entry) => {
    queue.push(entry);
  });
  rl.on('line', foldLine);
  rl.on('close', () => {
    queue.end();
  });

  const hub = createInterruptHub();
  rl.on('SIGINT', hub.fire);
  process.on('SIGINT', hub.fire);

  let closed = false;
  return {
    isTTY: false,
    // A pipe has no width. 80 is the conventional answer and the one every other module in this
    // program defaults to (`detectWidth`), so a renderer handed this one lays out the same way a
    // redirected `army view` does.
    width: 80,
    write(text: string): void {
      output.write(text);
    },
    nextLine(prompt: string): Promise<string | null> {
      if (prompt !== '') output.write(prompt);
      return queue.take();
    },
    abortLine(): void {
      queue.abort();
    },
    onInterrupt: hub.onInterrupt,
    close(): void {
      if (closed) return;
      closed = true;
      process.removeListener('SIGINT', hub.fire);
      hub.clear();
      // Also what releases stdin: `rl.close()` pauses the input it put into flowing mode, so a
      // still-open writer on the other end of the pipe cannot keep the event loop alive after a
      // refusal. The raw path shipped exactly that hang, so the property is pinned by a test
      // here rather than trusted to stay a readline detail.
      rl.close();
    },
    // No cursor to animate for, and nothing reading a spinner frame in a redirected file — same
    // reasoning `createProgressSink`'s `live` flag uses for the campaign ticker. The status block
    // is the same case one step further on: it is not merely animated, it is painted with cursor
    // movement, and a redirected transcript that contains `ESC[2A` is a corrupted transcript.
    setBusy(): void {},
    setIdle(): void {},
    setStatus(): void {},
  };
}

/** The real terminal. */
export function createTerminalIo(options: TerminalIoOptions = {}): ChatIo {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isTTY = input.isTTY === true && output.isTTY === true;
  return isTTY ? createRawTerminalIo(input, output) : createPipedTerminalIo(input, output);
}

/**
 * An `ChatIo` driven from a script: a list of lines in, a transcript out.
 *
 * Lives here rather than in the test file because the session loop is the thing under test and it
 * needs a second implementation of this interface to be testable at all — and because a driver
 * written next to the interface stays in step with it, while one written in a test file drifts
 * the first time the interface gains a method.
 */
export interface ScriptedIo extends ChatIo {
  /** Everything written, in order. */
  readonly transcript: string;
  /** Fire a Ctrl-C, exactly as the terminal would. */
  sendInterrupt(): void;
  /** Queue another line, e.g. from inside a handler. */
  feed(line: string): void;
  /** Prompts shown, in order. */
  readonly prompts: readonly string[];
  /** `busy:<label>` / `idle`, in order — the record `setBusy`/`setIdle` leave for an assertion. */
  readonly states: readonly string[];
  /**
   * The status renderer currently installed, or null.
   *
   * Exposed rather than recorded as a transcript line: the block never reaches a scripted
   * transcript (it is cursor-painted chrome, and a script has no cursor), so the only way a test
   * can assert on what a session PUT there is to render it itself. `runChat`'s renderer is pure
   * over a tick and a width, so calling it is safe and deterministic.
   */
  readonly status: StatusRenderer | null;
}

export interface ScriptedIoOptions {
  /**
   * Keep accepting input after `lines` runs out, for a script that feeds a line from inside a
   * Ctrl-C handler. Default is to close, so a session driven by a finished script ENDS rather
   * than parking on a read nobody will answer — a hung test is a test whose failure has no
   * message.
   */
  open?: boolean;
  /**
   * Claim to be a terminal.
   *
   * Default false, which is what a script IS. It is switchable because `isTTY` is not only a
   * question about escape bytes any more — `runChat` gates the whole session chrome on it — and
   * a scripted session that can never be a terminal is a scripted session that can never reach
   * the code paths a terminal takes. The transcript stays free of cursor control either way: a
   * `ScriptedIo` records what it is TOLD, and the block is painted by the raw terminal alone.
   */
  isTTY?: boolean;
}

export function createScriptedIo(
  lines: readonly string[] = [],
  options: ScriptedIoOptions = {},
): ScriptedIo {
  const queue = createLineQueue();
  // The same fold the piped path applies, so a scripted `['first \\', 'second']` drives the
  // exact multiline entry a human would have typed. An entry left open by the script is dropped
  // at end of input, the same way a half-typed line dies with its terminal.
  const foldLine = continuationFold((entry) => {
    queue.push(entry);
  });
  for (const line of lines) foldLine(line);
  if (options.open !== true) queue.end();
  const chunks: string[] = [];
  const prompts: string[] = [];
  const states: string[] = [];
  const handlers = new Set<() => void>();
  let ended = false;
  let status: StatusRenderer | null = null;

  return {
    isTTY: options.isTTY === true,
    width: 80,
    get transcript(): string {
      return chunks.join('');
    },
    get status(): StatusRenderer | null {
      return status;
    },
    get prompts(): readonly string[] {
      return prompts;
    },
    get states(): readonly string[] {
      return states;
    },
    write(text: string): void {
      chunks.push(text);
    },
    nextLine(prompt: string): Promise<string | null> {
      prompts.push(prompt);
      return queue.take();
    },
    abortLine(): void {
      queue.abort();
    },
    feed(line: string): void {
      foldLine(line);
    },
    onInterrupt(handler: () => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    sendInterrupt(): void {
      for (const handler of handlers) handler();
    },
    close(): void {
      if (ended) return;
      ended = true;
      queue.end();
      handlers.clear();
    },
    setBusy(label: string): void {
      states.push(`busy:${label}`);
    },
    setIdle(): void {
      states.push('idle');
    },
    setStatus(render: StatusRenderer | null): void {
      status = render;
    },
  };
}
