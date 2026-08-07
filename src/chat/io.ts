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
 */

import { createInterface, emitKeypressEvents } from 'node:readline';
import type { Interface as ReadlineInterface } from 'node:readline';

import { detectCharset, detectColor } from '../view/index.ts';
import type { Charset } from '../view/render.ts';

export interface ChatIo {
  /** Write to the conversation. No trailing newline is added. */
  write(text: string): void;
  /**
   * Print `prompt`, then resolve with the next line the human types.
   *
   * A prompt may span lines — `runChat` asks for `'\nyou › '`, a blank separator and then the
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
   * The session is waiting on the model, with nothing to show yet. On a TTY this animates
   * `<spinner> <label> …` appended to the current line — the label so the reader knows WHOSE
   * silence they are looking at; everywhere else it is bookkeeping only. `write` (the model's
   * first token) and `setIdle` both end it — a spinner that outlived the text it stood in for
   * would be a lie about what the process is doing.
   */
  setBusy(label: string): void;
  /** The wait is over, with nothing ever written. Idempotent with an unstarted or already-ended spinner. */
  setIdle(): void;
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
// The real terminal
// =================================================================================================

export interface TerminalIoOptions {
  input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  output?: NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
}

/** `\r` to column zero, then erase to end of line — the only cursor control this file emits. */
const ERASE_LINE = '\r[2K';

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  green: '[32m',
  cyan: '[36m',
} as const;

const SPINNER_FRAMES: Record<Charset, readonly string[]> = {
  unicode: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  ascii: ['-', '\\', '|', '/'],
};

const ELLIPSIS: Record<Charset, string> = { unicode: '…', ascii: '~' };

/** The trailing mark on the busy label — `⠋ commander …`. `~` would read as a typo in prose. */
const LABEL_ELLIPSIS: Record<Charset, string> = { unicode: '…', ascii: '...' };

/**
 * Split a prompt into the lines above the composer and the composer's own single line.
 *
 * `runChat`'s prompt is `'\nyou › '` — a blank separator line, then the prompt. The separator is
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

  const colourizePrompt = (prompt: string): string =>
    colour ? `${ANSI.bold}${ANSI.green}${prompt}${ANSI.reset}` : prompt;

  const spinnerText = (): string => {
    const frame = frames[spinnerFrame % frames.length] as string;
    const text = busyLabel === '' ? frame : `${frame} ${busyLabel} ${LABEL_ELLIPSIS[charset]}`;
    // Dim, not coloured: the spinner is a placeholder for text that has not arrived, and it must
    // read as quieter than the text that will replace it.
    return colour ? `${ANSI.dim}${text}${ANSI.reset}` : text;
  };

  const currentExtra = (): string => {
    if (spinnerActive) return spinnerText();
    if (painted) {
      // Not `?? 80`: a PTY without a window size — `script(1)`, some SSH and CI terminals —
      // reports columns as 0, which is not nullish. A 0-column width makes the buffer window
      // empty and everything typed INVISIBLE. Found on a real PTY; no fake with `columns: 80`
      // could ever have seen it.
      const columns = output.columns;
      const width = typeof columns === 'number' && columns > 0 ? columns : 80;
      return renderComposerFrame({
        prompt: plainPrompt,
        colouredPrompt,
        buffer: editor.buffer,
        cursor: editor.cursor,
        width,
        ellipsis,
      });
    }
    return '';
  };

  const repaint = (): void => {
    output.write(`${ERASE_LINE}${tail}${currentExtra()}`);
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
    if (needsRestore) output.write(`${ERASE_LINE}${tail}`);
    output.write(text);
    extendTail(text);
  };

  const eraseInputLine = (): void => {
    output.write(`${ERASE_LINE}${tail}`);
    painted = false;
  };

  const settlePending = (value: string | null): void => {
    const resolve = resolveLine;
    resolveLine = null;
    if (resolve !== null) resolve(value);
  };

  const submitLine = (line: string): void => {
    emit(`${colouredPrompt}${line}\n`);
    painted = false;
    history = historySubmit(history, line);
    editor = { buffer: '', cursor: 0 };
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
        hub.fire();
        return;
      case 'eof':
        if (painted) {
          eraseInputLine();
          settlePending(null);
        } else {
          ended = true;
        }
        return;
      case 'submit':
        if (painted) {
          submitLine(action.line);
          settlePending(action.line);
        } else {
          // Nobody is reading yet — queue the whole line and start the next one fresh, exactly
          // the multi-message type-ahead the old `LineQueue` gave the piped path.
          committed.push(action.line);
          editor = { buffer: '', cursor: 0 };
        }
        return;
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
      plainPrompt = line;
      colouredPrompt = colourizePrompt(line);
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
          emit(`${colouredPrompt}${queued}\n`);
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
      editor = { buffer: '', cursor: 0 };
      if (spinnerActive) stopSpinnerTimer();
      if (painted) eraseInputLine();
      settlePending(null);
    },

    onInterrupt: hub.onInterrupt,

    close(): void {
      if (closed) return;
      closed = true;
      ended = true;
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

  rl.on('line', (line: string) => {
    queue.push(line);
  });
  rl.on('close', () => {
    queue.end();
  });

  const hub = createInterruptHub();
  rl.on('SIGINT', hub.fire);
  process.on('SIGINT', hub.fire);

  let closed = false;
  return {
    isTTY: false,
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
    // reasoning `createProgressSink`'s `live` flag uses for the campaign ticker.
    setBusy(): void {},
    setIdle(): void {},
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
}

export interface ScriptedIoOptions {
  /**
   * Keep accepting input after `lines` runs out, for a script that feeds a line from inside a
   * Ctrl-C handler. Default is to close, so a session driven by a finished script ENDS rather
   * than parking on a read nobody will answer — a hung test is a test whose failure has no
   * message.
   */
  open?: boolean;
}

export function createScriptedIo(
  lines: readonly string[] = [],
  options: ScriptedIoOptions = {},
): ScriptedIo {
  const queue = createLineQueue();
  for (const line of lines) queue.push(line);
  if (options.open !== true) queue.end();
  const chunks: string[] = [];
  const prompts: string[] = [];
  const states: string[] = [];
  const handlers = new Set<() => void>();
  let ended = false;

  return {
    isTTY: false,
    get transcript(): string {
      return chunks.join('');
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
      queue.push(line);
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
  };
}
