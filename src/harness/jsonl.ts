/**
 * Newline-delimited JSON framing that survives reality.
 *
 * Both harnesses speak NDJSON on stdout, and both of them will eventually hand us something the
 * happy path does not cover. This module is the single place that deals with it, so neither
 * adapter has to. It is pure — no I/O, no clock, no process — which is why it can be tested to
 * death.
 *
 * Hazards handled, all of them load-bearing:
 *
 *   - **Chunk boundaries mid-line.** A 200 KB `item.completed` arrives in 16 KB pieces. Bytes are
 *     buffered until a `\n` is actually seen.
 *   - **Multi-byte UTF-8 split across chunks.** `Buffer.toString()` per chunk corrupts any
 *     character straddling the boundary, which turns a valid JSON line into noise. A
 *     `StringDecoder` holds the partial code point instead.
 *   - **CRLF.** Windows is the whole reason the substrate is pipes-only; a trailing `\r` would make
 *     every line fail `JSON.parse`.
 *   - **A trailing partial line at EOF.** A killed child leaves a half-written line. `flush()`
 *     emits it (as noise if it does not parse) rather than swallowing it.
 *   - **Blank lines.** Skipped entirely — they are framing, not content.
 *   - **Non-JSON noise.** A stray deprecation warning on stdout must not kill the stream: it comes
 *     back as `ok: false` and the adapter turns it into an `unknown` event. NEVER drop a line.
 *   - **Unbounded lines.** An optional `maxLineBytes` stops a runaway line from exhausting memory;
 *     the oversize line is reported as noise and the framer resynchronises at the next newline.
 */

import { StringDecoder } from 'node:string_decoder';

/**
 * One framed line. Discriminated on `ok` so a consumer cannot read `value` off a line that never
 * parsed. `text` is always the exact line content with the terminator (and any `\r`) stripped, so
 * even the failure case is losslessly reportable.
 */
export type JsonlLine =
  | { ok: true; index: number; text: string; value: unknown }
  | { ok: false; index: number; text: string; error: string };

export interface JsonlFramerOptions {
  /**
   * Hard cap on a single line's decoded length, in UTF-16 code units. `0` (the default) means
   * unlimited — a 40 MB tool result is legitimate and must not be truncated. Set it only when the
   * source is untrusted.
   */
  maxLineBytes?: number;
}

export interface JsonlFramer {
  /** Feed a chunk. Returns every line that completed within it — possibly none. */
  push(chunk: Uint8Array | string): JsonlLine[];
  /** End of stream. Returns the trailing partial line, if any. Safe to call more than once. */
  flush(): JsonlLine[];
  /** Buffered, not-yet-terminated characters. Diagnostics only. */
  readonly pending: number;
  /** Number of lines emitted so far. */
  readonly count: number;
}

function classify(text: string, index: number): JsonlLine {
  try {
    return { ok: true, index, text, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, index, text, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createJsonlFramer(options?: JsonlFramerOptions): JsonlFramer {
  const maxLineBytes = options?.maxLineBytes ?? 0;
  const decoder = new StringDecoder('utf8');

  let buffer = '';
  let index = 0;
  let atStart = true;
  /** Set after an oversize line: discard characters until the next newline resynchronises us. */
  let discarding = false;
  let flushed = false;

  function takeLine(text: string): JsonlLine | null {
    // CRLF: strip exactly one trailing CR. Anything else is content.
    const line = text.endsWith('\r') ? text.slice(0, -1) : text;
    if (line.trim() === '') return null; // blank lines are framing, not content
    // The cap applies to a line that arrived whole just as much as to one being buffered —
    // otherwise the limit would depend on how the OS happened to split the pipe.
    if (maxLineBytes > 0 && line.length > maxLineBytes) {
      const out: JsonlLine = {
        ok: false,
        index,
        text: line.slice(0, maxLineBytes),
        error: `line exceeds maxLineBytes (${String(maxLineBytes)}); truncated`,
      };
      index += 1;
      return out;
    }
    const out = classify(line, index);
    index += 1;
    return out;
  }

  function consume(text: string, isFinal: boolean): JsonlLine[] {
    const lines: JsonlLine[] = [];
    let chunk = text;

    if (atStart && chunk.length > 0) {
      atStart = false;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1); // BOM
    }

    let start = 0;
    for (;;) {
      const nl = chunk.indexOf('\n', start);
      if (nl === -1) break;
      const segment = chunk.slice(start, nl);
      start = nl + 1;
      if (discarding) {
        // The oversize line ends here; the newline resynchronises the framer.
        discarding = false;
        buffer = '';
        continue;
      }
      const emitted = takeLine(buffer + segment);
      buffer = '';
      if (emitted !== null) lines.push(emitted);
    }

    const tail = chunk.slice(start);
    if (discarding) {
      // still swallowing an oversize line — keep nothing
    } else if (tail.length > 0) {
      buffer += tail;
      if (maxLineBytes > 0 && buffer.length > maxLineBytes) {
        lines.push({
          ok: false,
          index,
          text: buffer.slice(0, maxLineBytes),
          error: `line exceeds maxLineBytes (${String(maxLineBytes)}); truncated and resynchronising`,
        });
        index += 1;
        buffer = '';
        discarding = true;
      }
    }

    if (isFinal && !discarding && buffer.length > 0) {
      const emitted = takeLine(buffer);
      buffer = '';
      if (emitted !== null) lines.push(emitted);
    }

    return lines;
  }

  return {
    push(chunk: Uint8Array | string): JsonlLine[] {
      if (flushed) return [];
      const text = typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (text === '') return [];
      return consume(text, false);
    },
    flush(): JsonlLine[] {
      if (flushed) return [];
      flushed = true;
      // Drain any half-decoded multi-byte character; U+FFFD is better than silence.
      return consume(decoder.end(), true);
    },
    get pending(): number {
      return buffer.length;
    },
    get count(): number {
      return index;
    },
  };
}

/** Convenience wrapper over any byte/string source — e.g. a child's `stdout`. */
export async function* framedLines(
  source: AsyncIterable<Uint8Array | string>,
  options?: JsonlFramerOptions,
): AsyncGenerator<JsonlLine> {
  const framer = createJsonlFramer(options);
  for await (const chunk of source) {
    for (const line of framer.push(chunk)) yield line;
  }
  for (const line of framer.flush()) yield line;
}

/** Frame a whole string in one go. Used by the fixture tests. */
export function parseJsonl(text: string, options?: JsonlFramerOptions): JsonlLine[] {
  const framer = createJsonlFramer(options);
  return [...framer.push(text), ...framer.flush()];
}

// ---------------------------------------------------------------------------------------------
// Async queue — the plumbing behind `Soldier.stream()`.
// ---------------------------------------------------------------------------------------------

/**
 * A single-consumer push/pull queue.
 *
 * `Soldier.stream()` has to buffer from the moment the process starts, because the `system/init`
 * event lands before any realistic caller has begun iterating. It also has to terminate cleanly on
 * a killed child — hence `end()` being idempotent and resolving any parked consumer rather than
 * leaving it hanging on a promise nobody will ever settle.
 */
export interface AsyncQueue<T> {
  push(value: T): void;
  /** No more values. Idempotent. A parked consumer is released immediately. */
  end(): void;
  readonly ended: boolean;
  readonly size: number;
  iterator(): AsyncGenerator<T>;
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = [];
  let closed = false;
  let wake: (() => void) | null = null;

  function signal(): void {
    const w = wake;
    wake = null;
    if (w !== null) w();
  }

  return {
    push(value: T): void {
      if (closed) return;
      values.push(value);
      signal();
    },
    end(): void {
      if (closed) return;
      closed = true;
      signal();
    },
    get ended(): boolean {
      return closed;
    },
    get size(): number {
      return values.length;
    },
    async *iterator(): AsyncGenerator<T> {
      for (;;) {
        while (values.length > 0) {
          yield values.shift() as T;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
