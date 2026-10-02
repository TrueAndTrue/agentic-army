/**
 * The main process's log, at `logs/main.log` in the app home. It is what "Copy diagnostics" sends,
 * so it holds what went wrong and when, never what you asked for: no keys, no prompts, no file
 * contents. Every line passes through `redact` on the way in and again on the way out.
 *
 * Plain Node, so the store and the controller can log from unit tests, where nothing sets a file
 * and every call is a no-op.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MASK = '[redacted]';

/**
 * Shapes that are keys whoever configured them. The configured keys themselves are passed in as
 * well, since a TypeSafe or Brave key has no prefix to spot it by.
 */
const KEY_PATTERNS: RegExp[] = [
  // OpenAI and Anthropic style: sk-..., sk-ant-..., sk-proj-...
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // GitHub, Slack, AWS, Google.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
];

/** An Authorization header or a bearer token quoted in an error. The scheme stays. */
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

/** `api_key=...`, `"apiKey": "..."`, `token: ...` and the like. The name stays, so the line still says what was there. */
const NAMED_SECRET = /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|passwd)(["']?\s*[:=]\s*["']?)[^\s"',;}&]{4,}/gi;

/** Below this length a configured key is too short to tell from ordinary words, so it is left to the patterns. */
const MIN_SECRET = 6;

export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    const key = s.trim();
    if (key.length >= MIN_SECRET) out = out.split(key).join(MASK);
  }
  for (const re of KEY_PATTERNS) out = out.replace(re, MASK);
  out = out.replace(AUTH_HEADER, (_m, scheme: string) => `${scheme} ${MASK}`);
  out = out.replace(NAMED_SECRET, (_m, name: string, sep: string) => `${name}${sep}${MASK}`);
  return out;
}

export type Level = 'info' | 'warn' | 'error';

export interface LogOptions {
  /** Rotate when the file would pass this size. */
  maxBytes?: number;
  /** Rotated files to keep: main.1.log is the newest. */
  keep?: number;
  /** The configured keys, read at each write so a key saved later is redacted too. */
  secrets?: () => string[];
}

export class FileLog {
  readonly dir: string;
  readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly secrets: () => string[];

  constructor(dir: string, opts: LogOptions = {}) {
    this.dir = dir;
    this.file = join(dir, 'main.log');
    this.maxBytes = opts.maxBytes ?? 1_000_000;
    this.keep = opts.keep ?? 3;
    this.secrets = opts.secrets ?? (() => []);
    mkdirSync(dir, { recursive: true });
  }

  write(level: Level, message: string): void {
    const flat = redact(message, this.secrets()).replace(/\s*\n\s*/g, ' | ').slice(0, 2000);
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${flat}\n`;
    try {
      this.rotateFor(Buffer.byteLength(line));
      appendFileSync(this.file, line);
    } catch {
      // A full disk or a read-only home must not take the app down with it.
    }
  }

  private rotateFor(bytes: number): void {
    if (!existsSync(this.file) || statSync(this.file).size + bytes <= this.maxBytes) return;
    rmSync(join(this.dir, `main.${String(this.keep)}.log`), { force: true });
    for (let i = this.keep - 1; i >= 1; i -= 1) {
      const from = join(this.dir, `main.${String(i)}.log`);
      if (existsSync(from)) renameSync(from, join(this.dir, `main.${String(i + 1)}.log`));
    }
    renameSync(this.file, join(this.dir, 'main.1.log'));
  }

  /** The last `n` lines, newest last, reaching into the rotated file when the current one is short. */
  tail(n: number): string[] {
    const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l !== '') : []);
    let lines = read(this.file);
    if (lines.length < n) lines = [...read(join(this.dir, 'main.1.log')), ...lines];
    // Redacted again: a key saved after a line was written is still kept out of what you send.
    return lines.slice(-n).map((l) => redact(l, this.secrets()));
  }
}

let current: FileLog | null = null;

/** Where `log` writes from now on. Only the app sets this; tests and scripts leave it unset. */
export function setLogFile(file: FileLog | null): void {
  current = file;
}

export function logFile(): FileLog | null {
  return current;
}

const errText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

export const log = {
  info: (message: string) => current?.write('info', message),
  warn: (message: string) => current?.write('warn', message),
  error: (message: string, err?: unknown) => current?.write('error', err === undefined ? message : `${message}: ${errText(err)}`),
};
