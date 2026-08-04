/**
 * `army view` — every byte of IO the view performs, and follow mode.
 *
 * `tree.ts` and `render.ts` are pure; this file is where the filesystem, the clock and the SQLite
 * driver are allowed to exist. Keeping the boundary that sharp is what lets the model and the
 * renderer be tested exhaustively over hand-built fixtures, and it is what will let a web
 * dashboard reuse them untouched.
 *
 * ## Read-only is a safety property, not a description
 *
 * `army view` must never write to the archive, never mutate a file and never spawn an agent. It
 * is the one command a Commander runs while a campaign is in flight, possibly from a second
 * terminal, possibly against a campaign another supervisor process is actively writing — and a
 * view that took a write lock, checkpointed a WAL or "helpfully" repaired a torn line would be
 * capable of corrupting the very thing it exists to observe. So:
 *
 * - The DEFAULT source is the FILES. SQLite is the index and the files are truth; reading the
 *   files means the view still works days later against a campaign whose `campaign.db` was
 *   deleted, and means the common path opens no database at all.
 * - The `db` source opens the index with `readOnly: true`, so the *database itself* rejects a
 *   write. `PRAGMA journal_mode` is read and never set, because setting it rewrites the file
 *   header. It does NOT go through `openCampaign` — see `readRowsFromIndex` for why that is now
 *   impossible, and for the archive change that would fix it.
 * - `test/view.test.ts` asserts the property with teeth: sizes, mtimes and the SHA-256 of every
 *   file in the campaign directory are compared before and after a render, `campaign.db` byte for
 *   byte, and the `files` path is required to create no file at all.
 *
 * ## Tailing without `fs.watch`
 *
 * `fs.watch` semantics differ per platform — recursive is macOS/Windows only, rename-vs-change is
 * inconsistent, and on some network filesystems it never fires. Windows in particular has never
 * been tested, so the view polls at a fixed interval instead. Slower, and correct everywhere, with
 * no native dependency.
 *
 * ## The torn final line
 *
 * A live tail routinely catches `stream.jsonl` mid-append. `createJsonlReader` therefore tracks a
 * byte offset and holds the trailing partial line in a buffer instead of parsing it: the record is
 * WAITED ON, and re-read when the rest of it lands. It is never parsed as garbage, never crashes
 * the view and never becomes a row. A complete JSON object that merely lost its newline is only
 * recovered on a FINAL read (the one-shot render), which is exactly `rebuild.ts`'s stance: a
 * truncated line is not a fact, but a whole one that lost its terminator is.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

import type { AgentRow, CampaignRow, SignalRow, TaskRow } from '../contracts/archive.ts';
import type { SoldierEvent } from '../contracts/harness.ts';
import type { Db, DbFactory } from '../archive/db.ts';

import { DEFAULT_BUSY_TIMEOUT_MS, installWarningFilter } from '../archive/db.ts';
import {
  AGENT_JSON_FILENAME,
  agentDir,
  agentsDir,
  campaignDbPath,
  campaignDir,
  campaignJsonPath,
  campaignsRoot,
  isSafeSegment,
  signalsJsonlPath,
  streamJsonlPath,
  tasksJsonlPath,
} from '../archive/paths.ts';

import type { CampaignSnapshot, StreamDigest } from './tree.ts';
import { digestStream, emptyDigest } from './tree.ts';

export const SNAPSHOT_SOURCES = ['files', 'db'] as const;
export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

// ---------------------------------------------------------------------------------------------
// The JSONL tail
// ---------------------------------------------------------------------------------------------

export interface JsonlBatch {
  /** Fully-formed records, in file order. Never contains a partial line. */
  records: unknown[];
  /** Complete lines that were not parseable JSON. Counted; never rendered. */
  malformed: number;
  /** A partial final line is being held, unparsed, waiting for the rest of the write. */
  truncatedTail: boolean;
  /** Bytes consumed so far. */
  offset: number;
  /** The file does not exist. Distinct from "exists and is empty". */
  missing: boolean;
}

export interface JsonlReader {
  /**
   * Consume everything appended since the last call.
   *
   * `final` marks a one-shot read: a trailing line with no newline is speculatively parsed and,
   * if it is complete JSON, kept. In follow mode (`final` false, the default) it is always held.
   */
  read(final?: boolean): JsonlBatch;
  reset(): void;
}

const LF = 0x0a;
const EMPTY = Buffer.alloc(0);

export function createJsonlReader(file: string): JsonlReader {
  let offset = 0;
  let pending = EMPTY;

  const reset = (): void => {
    offset = 0;
    pending = EMPTY;
  };

  const read = (final = false): JsonlBatch => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { records: [], malformed: 0, truncatedTail: false, offset, missing: true };
      }
      throw error;
    }

    // Shorter than we have already consumed means the file was replaced or truncated — a rebuild,
    // or a campaign directory restored from elsewhere. Start again rather than reading from the
    // middle of a record.
    if (size < offset) reset();

    let chunk = EMPTY;
    if (size > offset) {
      const fd = fs.openSync(file, 'r');
      try {
        const want = size - offset;
        const buffer = Buffer.allocUnsafe(want);
        const got = fs.readSync(fd, buffer, 0, want, offset);
        chunk = buffer.subarray(0, got);
        offset += got;
      } finally {
        fs.closeSync(fd);
      }
    }

    const buffer = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    const records: unknown[] = [];
    let malformed = 0;
    let start = 0;
    // Split at the BYTE level so a multi-byte character straddling two reads cannot be decoded
    // twice or half-decoded into U+FFFD.
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== LF) continue;
      const text = buffer.subarray(start, i).toString('utf8').trim();
      start = i + 1;
      if (text.length === 0) continue;
      const parsed = parseJson(text);
      if (parsed === undefined) malformed += 1;
      else records.push(parsed);
    }
    pending = start >= buffer.length ? EMPTY : buffer.subarray(start);

    let truncatedTail = pending.length > 0;
    if (final && truncatedTail) {
      const parsed = parseJson(pending.toString('utf8').trim());
      if (parsed !== undefined) {
        records.push(parsed);
        truncatedTail = false;
      }
    }

    return { records, malformed, truncatedTail, offset, missing: false };
  };

  return { read, reset };
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Read a whole `.jsonl` once, tolerating a torn final line. */
function readJsonlOnce(file: string): JsonlBatch {
  return createJsonlReader(file).read(true);
}

// ---------------------------------------------------------------------------------------------
// Stream digests, folded incrementally
// ---------------------------------------------------------------------------------------------

interface StreamState {
  reader: JsonlReader;
  digest: StreamDigest;
  seen: boolean;
}

/**
 * Keeps one tail per agent and folds new events into the running digest. This is the reason
 * follow mode does not get slower as a campaign gets longer: poll N re-reads only the bytes
 * appended since poll N-1.
 */
function createStreamWatcher(campaignRoot: string): {
  update(agentIds: readonly string[], final: boolean): Record<string, StreamDigest>;
} {
  const states = new Map<string, StreamState>();

  const update = (agentIds: readonly string[], final: boolean): Record<string, StreamDigest> => {
    const out: Record<string, StreamDigest> = {};
    for (const agentId of agentIds) {
      let state = states.get(agentId);
      if (state === undefined) {
        state = {
          reader: createJsonlReader(streamJsonlPath(campaignRoot, agentId)),
          digest: emptyDigest(agentId),
          seen: false,
        };
        states.set(agentId, state);
      }
      const batch = state.reader.read(final);
      if (batch.missing && !state.seen) continue; // no stream.jsonl at all — say so, honestly
      state.seen = true;
      state.digest = digestStream(agentId, batch.records as SoldierEvent[], {
        base: state.digest,
        malformed: batch.malformed,
        truncatedTail: batch.truncatedTail,
      });
      out[agentId] = state.digest;
    }
    return out;
  };

  return { update };
}

// ---------------------------------------------------------------------------------------------
// Files as truth
// ---------------------------------------------------------------------------------------------

function readJsonFile(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = parseJson(text.trim());
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/** `tasks.jsonl` is a log of snapshots; last line for an id wins, first-seen order is kept. */
function readTasksFromFiles(campaignRoot: string): TaskRow[] {
  const order: string[] = [];
  const byId = new Map<string, TaskRow>();
  for (const record of readJsonlOnce(tasksJsonlPath(campaignRoot)).records) {
    const row = record as TaskRow | null;
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue;
    if (!byId.has(row.id)) order.push(row.id);
    byId.set(row.id, row);
  }
  return order.map((id) => byId.get(id) as TaskRow);
}

function readAgentsFromFiles(campaignRoot: string): AgentRow[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir(campaignRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: AgentRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
    const row = readJsonFile(path.join(agentDir(campaignRoot, entry.name), AGENT_JSON_FILENAME));
    if (row === undefined || typeof row.id !== 'string') continue;
    rows.push(row as unknown as AgentRow);
  }
  rows.sort((a, b) =>
    a.started_at === b.started_at ? cmp(a.id, b.id) : cmp(a.started_at, b.started_at),
  );
  return rows;
}

function readSignalsFromFiles(campaignRoot: string): SignalRow[] {
  const bySeq = new Map<number, SignalRow>();
  for (const record of readJsonlOnce(signalsJsonlPath(campaignRoot)).records) {
    const row = record as SignalRow | null;
    if (row === null || typeof row !== 'object' || !Number.isInteger(row.seq)) continue;
    bySeq.set(row.seq, row);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * `self` is the invocation prefix, threaded in from `runView`, NOT read here.
 *
 * This message names two next steps, and one of them is a command to type. It shipped as a bare
 * `army rebuild` to every reader for whom `army` is not on PATH — and it is reached from a
 * message that is itself prefixed with the reader's real invocation, so a single line of output
 * managed to report one spelling and suggest another. `live.ts` is deliberately below the layer
 * that reads the environment (see `view/index.ts`'s header), so it cannot ask `invokedAs()` and
 * must be handed the answer.
 */
function readCampaignRow(campaignRoot: string, self: string): CampaignRow {
  const row = readJsonFile(campaignJsonPath(campaignRoot));
  if (row === undefined || typeof row.id !== 'string') {
    throw new Error(
      `${campaignJsonPath(campaignRoot)} is missing or unreadable — ` +
        `this directory carries no campaign row. Try \`--source db\`, or \`${self} rebuild\`.`,
    );
  }
  return row as unknown as CampaignRow;
}

// ---------------------------------------------------------------------------------------------
// The index, opened read-only
// ---------------------------------------------------------------------------------------------

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    filename: string,
    options?: { readOnly?: boolean; enableForeignKeyConstraints?: boolean },
  ) => NodeSqliteDatabase;
}

const requireFromHere = createRequire(import.meta.url);
let cachedModule: NodeSqliteModule | undefined;

/**
 * Load the driver, silently.
 *
 * `installWarningFilter()` is not decoration and it is not defensive: this was the third route to
 * `node:sqlite` and the only one that did not filter, so `army view --source db` printed
 * `ExperimentalWarning: SQLite is an experimental feature…` to stderr while `army doctor`'s own
 * sqlite line was on screen promising that warning is filtered and never reaches your terminal.
 * A `createRequire` of its own is fine; a warning policy of its own is not.
 *
 * It goes BEFORE the require, because the warning fires on load and a filter installed afterwards
 * has nothing left to catch. The archive's filter is the only implementation — see
 * `installWarningFilter` in `src/archive/db.ts` — so this route cannot drift from the promise.
 */
function loadNodeSqlite(): NodeSqliteModule {
  if (cachedModule === undefined) {
    installWarningFilter();
    cachedModule = requireFromHere('node:sqlite') as NodeSqliteModule;
  }
  return cachedModule;
}

/**
 * A `DbFactory` that cannot write, for `openCampaign`'s `dbFactory` seam.
 *
 * Two departures from `src/archive/db.ts`, both deliberate:
 *
 * - `readOnly: true`, so an accidental INSERT is `SQLITE_READONLY` from the engine rather than a
 *   promise in a comment. Verified: a write through this handle fails with "attempt to write a
 *   readonly database", and opening a live WAL database this way leaves every byte and mtime of
 *   `campaign.db`, `-wal` and `-shm` untouched.
 * - **`PRAGMA journal_mode` is never SET**, only read. It is the one pragma in `db.ts`'s set that
 *   rewrites the database header, so issuing it would be a write — and it is unnecessary, because
 *   a reader inherits whatever mode the file is already in. The other three
 *   (`busy_timeout`, `recursive_triggers`, `foreign_keys`) are per-CONNECTION state living only in
 *   this process's memory, so they are set: `assertArchivePragmas` checks all four on open, and a
 *   reader that skipped them would fail that check for no safety gain. `busy_timeout` in
 *   particular is not ceremony for a reader — a WAL reader really can hit SQLITE_BUSY while
 *   another process checkpoints.
 *
 * `transaction` runs its function directly: there is nothing to make atomic in a reader, and
 * issuing `BEGIN IMMEDIATE` would take a write lock against a running supervisor.
 */
export const openReadOnlyDb: DbFactory = (filename, options) => {
  const { DatabaseSync } = loadNodeSqlite();
  const handle = new DatabaseSync(filename, {
    readOnly: true,
    enableForeignKeyConstraints: true,
  });
  handle.exec(`PRAGMA busy_timeout=${Math.trunc(options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)};`);
  handle.exec('PRAGMA recursive_triggers=ON;');

  return {
    prepare(sql: string) {
      const statement = handle.prepare(sql);
      return {
        run(params?: unknown) {
          const result = statement.run(...spread(params));
          return {
            changes: Number(result.changes),
            lastInsertRowid: Number(result.lastInsertRowid),
          };
        },
        get<T>(params?: unknown) {
          return statement.get(...spread(params)) as T | undefined;
        },
        all<T>(params?: unknown) {
          return statement.all(...spread(params)) as T[];
        },
      };
    },
    exec(sql: string) {
      handle.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
    close() {
      handle.close();
    },
  } satisfies Db;
};

function spread(params?: unknown): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params as unknown[];
  return [params];
}

/**
 * Read the campaign's rows straight off the index, through a handle that cannot write.
 *
 * **Why this does not go through `openCampaign`.** It used to. The archive's open path now runs
 * `assertArchivePragmas`, which calls `assertReplaceFiresDeleteTriggers` — a probe that ATTACHes
 * `:memory:` and executes `CREATE TABLE` / `INSERT` to demonstrate that the append-only triggers
 * really fire on an `INSERT OR REPLACE`. That check is right, and it is right to run it on every
 * WRITER open. But SQLite refuses `CREATE TABLE` on a read-only connection in *any* schema,
 * attached or not, so the probe cannot run at all here: `openCampaign` now throws
 * `attempt to write a readonly database` before it returns. The archive exposes no read-only open,
 * and `army view` must never take a write handle to a campaign another supervisor is writing —
 * so the four SELECTs live here instead. **Reported upward rather than worked around silently;
 * the fix belongs in the archive (an `openCampaignReadOnly`), not in this file.**
 *
 * `openIndex`'s `mkdirSync` and `applySchema` are skipped for the same reason: both are writer
 * behaviour, and neither is anything a reader needs.
 *
 * The column lists and orderings mirror `CampaignArchive.listTasks` / `listAgents` / `listSignals`
 * exactly — including `ORDER BY created_at, rowid`, which is what keeps a plan in plan order
 * rather than shuffling it into alphabetical nonsense by opaque task id.
 */
function readRowsFromIndex(
  campaignRoot: string,
  campaignId: string,
): { campaign: CampaignRow; tasks: TaskRow[]; agents: AgentRow[]; signals: SignalRow[] } {
  const db = openReadOnlyDb(campaignDbPath(campaignRoot));
  try {
    const campaign = db
      .prepare('SELECT * FROM campaigns WHERE id = ?')
      .get<Record<string, unknown>>([campaignId]);
    if (campaign === undefined) {
      throw new Error(`campaign ${campaignId} is missing from its own index`);
    }
    return {
      campaign: plain(campaign) as unknown as CampaignRow,
      tasks: db
        .prepare('SELECT * FROM tasks WHERE campaign_id = ? ORDER BY created_at, rowid')
        .all<Record<string, unknown>>([campaignId])
        .map((row) => plain(row) as unknown as TaskRow),
      agents: db
        .prepare('SELECT * FROM agents WHERE campaign_id = ? ORDER BY started_at, id')
        .all<Record<string, unknown>>([campaignId])
        .map((row) => plain(row) as unknown as AgentRow),
      signals: db
        .prepare('SELECT * FROM signals ORDER BY seq')
        .all<Record<string, unknown>>()
        .map((row) => plain(row) as unknown as SignalRow),
    };
  } finally {
    db.close();
  }
}

/** `node:sqlite` hands back null-prototype objects; the model layer expects plain ones. */
function plain(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

// ---------------------------------------------------------------------------------------------
// Campaign reader
// ---------------------------------------------------------------------------------------------

export interface ReaderOptions {
  archiveRoot: string;
  campaignId: string;
  source?: SnapshotSource;
  /**
   * The invocation prefix for any command this reader's errors tell the caller to TYPE, e.g.
   * `army`, `node src/cli.ts`. See `ViewDeps.self` — this is the same seam, threaded one level
   * down rather than a second mechanism.
   *
   * REQUIRED, not defaulted. A default here would be a silent `army`, which is the exact defect
   * this parameter exists to close, and it would be invisible at every call site.
   */
  self: string;
}

export interface CampaignReader {
  readonly campaignRoot: string;
  readonly source: SnapshotSource;
  /** `final` marks the one-shot read — see `JsonlReader.read`. */
  read(final?: boolean): CampaignSnapshot;
  close(): void;
}

/**
 * Open a campaign for reading. Nothing here creates, locks or modifies anything.
 *
 * Streams always come from `stream.jsonl` regardless of source, because the file is truth and
 * because only the file can tell us that its last record is half-written.
 */
export function openCampaignReader(options: ReaderOptions): CampaignReader {
  const source: SnapshotSource = options.source ?? 'files';
  const campaignRoot = campaignDir(options.archiveRoot, options.campaignId);
  if (!fs.existsSync(campaignRoot)) {
    throw new Error(`no such campaign directory: ${campaignRoot}`);
  }
  const streams = createStreamWatcher(campaignRoot);

  const readRows = (): {
    campaign: CampaignRow;
    tasks: TaskRow[];
    agents: AgentRow[];
    signals: SignalRow[];
  } => {
    if (source === 'files') {
      return {
        campaign: readCampaignRow(campaignRoot, options.self),
        tasks: readTasksFromFiles(campaignRoot),
        agents: readAgentsFromFiles(campaignRoot),
        signals: readSignalsFromFiles(campaignRoot),
      };
    }
    // Opened and closed per read so a long-running follow never pins a WAL snapshot or holds a
    // file handle across a checkpoint by another process.
    return readRowsFromIndex(campaignRoot, options.campaignId);
  };

  return {
    campaignRoot,
    source,
    read(final = true): CampaignSnapshot {
      const rows = readRows();
      return {
        campaign: rows.campaign,
        tasks: rows.tasks,
        agents: rows.agents,
        signals: rows.signals,
        streams: streams.update(
          rows.agents.map((agent) => agent.id),
          final,
        ),
        source,
      };
    },
    close(): void {
      /* nothing is held open */
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Campaign discovery
// ---------------------------------------------------------------------------------------------

export interface CampaignSummary {
  id: string;
  title: string;
  status: string;
  project: string;
  createdAt: string;
}

/** Newest first, by `created_at` then id. A directory without `campaign.json` is not a campaign. */
export function listCampaigns(archiveRoot: string): CampaignSummary[] {
  const root = campaignsRoot(archiveRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: CampaignSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
    const row = readJsonFile(campaignJsonPath(path.join(root, entry.name)));
    if (row === undefined || typeof row.id !== 'string') continue;
    out.push({
      id: row.id,
      title: typeof row.title === 'string' ? row.title : row.id,
      status: typeof row.status === 'string' ? row.status : 'unknown',
      project: typeof row.project === 'string' ? row.project : '',
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    });
  }
  out.sort((a, b) => cmp(b.createdAt, a.createdAt) || cmp(b.id, a.id));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Follow mode
// ---------------------------------------------------------------------------------------------

export const DEFAULT_POLL_MS = 1000;
/** Below this, polling costs more than it observes. */
export const MIN_POLL_MS = 50;

export interface FollowOptions {
  reader: CampaignReader;
  /**
   * How this command names ITSELF in the one line it prints that is not a rendered frame.
   *
   * `army view: …` was hardcoded here, so a reader running `node src/cli.ts view -f` watched a
   * session that reported itself as one command while every refusal from `runView` reported the
   * other. Same seam as `ViewDeps.self` and `ReaderOptions.self`, and required for the same
   * reason: a default would reintroduce the bug invisibly.
   */
  self: string;
  /** Model + render, injected so follow mode knows nothing about charsets or clocks. */
  frame(snapshot: CampaignSnapshot): string;
  write(text: string): void;
  intervalMs?: number;
  /** Redraw in place. False for a pipe, where cursor control is noise. */
  clearScreen?: boolean;
  signal?: AbortSignal;
  /** Stop after this many frames. Tests use it; production leaves it undefined. */
  maxFrames?: number;
  /** Swap the sleep for a deterministic one in tests. */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

const HOME_AND_CLEAR = '\u001b[H\u001b[2J\u001b[3J';

/**
 * Poll, re-read, redraw. Returns when aborted or when `maxFrames` frames have been drawn.
 *
 * Frames are skipped when the rendered text is byte-identical to the previous one, so a quiet
 * campaign does not repaint a terminal once a second for no reason — and, on a pipe, produces no
 * output at all until something actually changes.
 */
export async function followCampaign(options: FollowOptions): Promise<void> {
  const interval = Math.max(MIN_POLL_MS, options.intervalMs ?? DEFAULT_POLL_MS);
  const sleep = options.sleep ?? defaultSleep;
  const clearScreen = options.clearScreen ?? false;
  let previous: string | undefined;
  let frames = 0;

  for (;;) {
    if (options.signal?.aborted === true) return;
    // A campaign directory can vanish or be rebuilt underneath us; a read failure is reported into
    // the frame rather than being allowed to kill a view someone is watching.
    let text: string;
    try {
      text = options.frame(options.reader.read(false));
    } catch (error) {
      text = `${options.self} view: ${error instanceof Error ? error.message : String(error)}\n`;
    }
    if (text !== previous) {
      options.write(clearScreen ? `${HOME_AND_CLEAR}${text}` : text);
      previous = text;
    }
    frames += 1;
    if (options.maxFrames !== undefined && frames >= options.maxFrames) return;
    try {
      await sleep(interval, options.signal);
    } catch {
      return; // AbortError — the only way this rejects
    }
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal });
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
