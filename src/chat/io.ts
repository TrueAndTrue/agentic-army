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
 * So `runChat` never touches `process.*`. The real terminal lives in `createTerminalIo`, which is
 * the only thing in this file that knows a TTY exists, and nothing in the test suite calls it.
 *
 * ## Ctrl-C is not a signal here
 *
 * With a TTY and `readline` in terminal mode, the terminal driver's `ISIG` handling is off — a
 * `^C` keystroke does not generate SIGINT at all. `readline` reads the `\x03` byte and, if the
 * interface has a `SIGINT` listener, emits one on the interface; otherwise it raises the real
 * signal at the process. Both spellings are wired below because they are mutually exclusive by
 * construction: the interface listener answers the raw-mode case and the process listener answers
 * the piped case, and neither fires in the other's situation.
 *
 * This matters more than it looks. The soldier's own interrupt is ALSO not a signal — it is a
 * stdin control message — so the whole path from keystroke to aborted turn contains no signal at
 * any point, and nothing in it can kill the conversation by accident.
 */

import { createInterface } from 'node:readline';
import type { Interface as ReadlineInterface } from 'node:readline';

export interface ChatIo {
  /** Write to the conversation. No trailing newline is added. */
  write(text: string): void;
  /**
   * Print `prompt`, then resolve with the next line the human types.
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

export interface TerminalIoOptions {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
}

/** The real terminal. Nothing in the test suite constructs one of these. */
export function createTerminalIo(options: TerminalIoOptions = {}): ChatIo {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isTTY = input.isTTY === true && output.isTTY === true;

  const queue = createLineQueue();
  const rl: ReadlineInterface = createInterface({
    input,
    output,
    terminal: isTTY,
    // A pasted CRLF must not arrive as an empty second line. Windows is a target here.
    crlfDelay: Infinity,
  });
  // The prompt is written by hand so that streamed model output and the prompt cannot both try to
  // own the cursor. readline never redraws something it was not given.
  rl.setPrompt('');

  rl.on('line', (line: string) => {
    queue.push(line);
  });
  rl.on('close', () => {
    queue.end();
  });

  const handlers = new Set<() => void>();
  const fire = (): void => {
    for (const handler of handlers) handler();
  };
  rl.on('SIGINT', fire);
  process.on('SIGINT', fire);

  let closed = false;
  return {
    isTTY,
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
    onInterrupt(handler: () => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close(): void {
      if (closed) return;
      closed = true;
      process.removeListener('SIGINT', fire);
      handlers.clear();
      rl.close();
    },
  };
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
  };
}
