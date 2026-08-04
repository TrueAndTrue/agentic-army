/**
 * The `Db` seam.
 *
 * > `node:sqlite` is functional but flagged experimental. Put it behind a thin interface;
 * > `bun:sqlite` and `better-sqlite3` are stable drop-ins.
 *
 * So this file is the ONLY place in the archive that knows a SQLite driver exists. The surface is
 * four verbs — `prepare`, `exec`, `transaction`, `close` — chosen to be the intersection of what
 * `node:sqlite`, `bun:sqlite` and `better-sqlite3` all already provide, so a swap is a
 * `setDbFactory` call and not a migration. It is deliberately not an ORM: no query builder, no
 * schema reflection, no connection pool. The archive writes SQL by hand.
 *
 * Four behaviours are load-bearing rather than incidental:
 *
 * 1. **WAL + `busy_timeout=5000`**. The archive is written by several concurrent
 *    supervisor processes. WAL lets readers run while a writer holds the lock; `busy_timeout`
 *    makes a contended writer wait instead of failing. Without both, concurrent `appendSignal`
 *    calls lose rows — which is exactly the property the append-only log exists to guarantee.
 * 2. **`recursive_triggers = ON`.** Without it SQLite does NOT fire DELETE triggers on a REPLACE
 *    conflict, so `INSERT OR REPLACE` / `REPLACE INTO` walk straight past the append-only
 *    triggers in `schema.ts` and silently rewrite an audit row. It defaults to OFF. This one
 *    pragma is the difference between "signals is append-only" being enforced and being a
 *    comment. `assertArchivePragmas` does not merely re-read it — it runs a live REPLACE against
 *    a scratch table on every open, so a driver that reports the pragma without honouring it is
 *    caught by what it does rather than trusted for what it says.
 * 3. **`BEGIN IMMEDIATE`, never `BEGIN`.** A deferred transaction takes its write lock lazily and
 *    can fail with `SQLITE_BUSY_SNAPSHOT` on upgrade — which `busy_timeout` does NOT retry.
 *    Taking the lock up front is what makes the timeout actually apply.
 * 4. **The `ExperimentalWarning` never reaches stdout.** `node:sqlite` warns on load. Node writes
 *    warnings to stderr, so `--json` on stdout was never at risk, but the warning is still noise
 *    in every CLI invocation, so the driver is loaded lazily behind a filter that suppresses this
 *    one warning and re-emits every other one through Node's own handler.
 */

import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------------

/** What a bound parameter may be. The archive stores text, integers, reals and NULL. */
export type DbValue = string | number | bigint | null | Uint8Array;

/** Positional (`?`) or named (`$name`) binding — both are supported by all three drivers. */
export type DbParams = readonly DbValue[] | Readonly<Record<string, DbValue>>;

export interface DbRunResult {
  changes: number;
  /** Normalised to `number`: drivers disagree about `bigint` here and the archive never needs it. */
  lastInsertRowid: number;
}

export interface DbStatement {
  run(params?: DbParams): DbRunResult;
  get<T>(params?: DbParams): T | undefined;
  all<T>(params?: DbParams): T[];
}

/**
 * The whole driver surface the archive is allowed to use.
 *
 * Note there is no `pragma()` verb: pragmas go through `exec`, which every driver has, so the
 * seam does not grow a method for something the four verbs already cover.
 */
export interface Db {
  /** Prepared statements are cached by the caller when hot; this is a plain compile. */
  prepare(sql: string): DbStatement;
  /** Multi-statement SQL — schema application and pragmas. */
  exec(sql: string): void;
  /**
   * Run `fn` inside `BEGIN IMMEDIATE` … `COMMIT`, rolling back on throw. Re-entrant via
   * `SAVEPOINT`, because `appendEvent` composes a file append with an index insert and callers
   * should not have to know whether they are already inside one.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface DbOpenOptions {
  /** Milliseconds a contended writer waits before giving up. The archive fixes this at 5000. */
  busyTimeoutMs?: number;
  /** Off only for tests that want to prove WAL and the timeout are what make concurrency work. */
  wal?: boolean;
  /**
   * Open the file read-only. Every write — INSERT, UPDATE, DDL, and DDL in an ATTACHed schema —
   * is refused by SQLite itself with `attempt to write a readonly database`.
   *
   * The file must already exist: a read-only open cannot create one, which is the correct
   * behaviour for a viewer pointed at a campaign that is not there.
   */
  readOnly?: boolean;
}

export type DbFactory = (filename: string, options?: DbOpenOptions) => Db;

/** Fixed, not a tunable: every archive connection opens with exactly this `busy_timeout`. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * DURABILITY DISCLOSURE — surface this to users; do not leave it buried in a source comment.
 *
 * The archive runs `synchronous=NORMAL` under WAL. That is durable across an application or OS
 * crash — a killed supervisor never loses a committed signal — but a COMMIT is not guaranteed to
 * have reached the platter, so a sudden POWER LOSS can lose the most recent transactions. The
 * database is never corrupted either way; only the newest rows can go missing.
 *
 * This is the right trade for an audit index that is written on the hot path of every agent event
 * and whose contents are reconstructible from the files anyway (`rebuild.ts`) — but it is a real
 * property of the system, so it is exported as a printable string rather than a comment, for
 * every command that surfaces it and the README to render.
 *
 * ===========================================================================================
 * WHY THIS IS A FUNCTION AND NOT A CONSTANT — THE LAYERING
 * ===========================================================================================
 *
 * It used to end in a hardcoded ``\`army rebuild\` reconstructs the index``, printed verbatim to
 * a reader running `node src/cli.ts`, for whom `army` is not on PATH. The whole point of the
 * sentence is the last clause — the one thing to DO about a lost row — and it named a command
 * that does not exist in the context it was printed in.
 *
 * The obvious repair is `invokedAs()`, and it is the wrong one HERE. `src/setup/**` sits above
 * `src/archive/**`; importing upward would make the storage layer depend on environment
 * detection, and a constant cannot call a function anyway. So the invocation arrives as a
 * PARAMETER, from the layer that already resolved it (`campaignCommand` and `src/cli.ts` both
 * hold a `self` before they ever reach here).
 *
 * It has NO DEFAULT, deliberately. A default would have to be spelled `army`, which is the
 * defect; and the standing order holds — do not filter a hostile field, make it unreachable. A
 * caller that forgets does not print the wrong command, it fails to compile.
 *
 * @param self  The command prefix the reader actually invoked, e.g. `army`, `node src/cli.ts`,
 *              `npx agentic-army`. Whatever `invokedAs()` resolved for THIS process.
 */
export function archiveDurabilityNote(self: string): string {
  return (
    'The campaign index uses SQLite WAL with synchronous=NORMAL: committed rows survive a ' +
    'process or OS crash, but a power loss may lose the most recent transactions. The database ' +
    `is never corrupted, and \`${self} rebuild\` reconstructs the index from the files, which ` +
    'are truth.'
  );
}

// ---------------------------------------------------------------------------------------------
// ExperimentalWarning containment
// ---------------------------------------------------------------------------------------------

let warningFilterInstalled = false;

/**
 * Swallow `ExperimentalWarning: SQLite is an experimental feature…` and nothing else.
 *
 * Node installs its own `warning` listener at bootstrap; adding a second one would not stop it
 * printing, so the existing listeners are captured, detached, and re-invoked by ours for every
 * warning that is not the SQLite one. Any future warning still prints exactly as it would have.
 */
function installWarningFilter(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const previous = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning: Error) => {
    if (warning.name === 'ExperimentalWarning' && /\bSQLite\b/i.test(warning.message)) return;
    for (const listener of previous) listener.call(process, warning);
  });
}

// ---------------------------------------------------------------------------------------------
// node:sqlite implementation
// ---------------------------------------------------------------------------------------------

/**
 * Structural type for the slice of `node:sqlite` used here.
 *
 * Written out rather than imported so this file does not depend on `@types/node`'s typings for an
 * experimental module — those change shape between releases, and a type break in a dependency is
 * not a reason for the archive to stop compiling.
 */
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

function loadNodeSqlite(): NodeSqliteModule {
  if (cachedModule === undefined) {
    // The filter must be in place BEFORE the module is loaded — the warning fires on load, which
    // is why this is a lazy `require` and not a hoisted `import`.
    installWarningFilter();
    cachedModule = requireFromHere('node:sqlite') as NodeSqliteModule;
  }
  return cachedModule;
}

/** `run`/`get`/`all` take spread args on every driver; normalise our one params shape onto that. */
function spread(params?: DbParams): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params as unknown[];
  return [params];
}

function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

/** Open (creating if needed) a SQLite database on `node:sqlite`. */
export const openNodeSqliteDb: DbFactory = (filename, options) => {
  const { DatabaseSync } = loadNodeSqlite();
  const readOnly = options?.readOnly === true;
  const handle = new DatabaseSync(filename, {
    readOnly,
    enableForeignKeyConstraints: true,
  });

  const busyTimeoutMs = options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  // The required pragmas. Order matters: set the timeout first so the journal-mode switch itself,
  // which takes an exclusive lock, waits rather than failing when another process is mid-write.
  handle.exec(`PRAGMA busy_timeout=${Math.trunc(busyTimeoutMs)};`);
  // Journal mode is a property of the FILE, not the connection, so a read-only handle can only
  // ever observe it — `assertArchivePragmas` still reads it back and rejects a non-WAL archive.
  if (options?.wal !== false && !readOnly) handle.exec('PRAGMA journal_mode=WAL;');
  // See `archiveDurabilityNote` — power-loss semantics are disclosed there, not only here.
  handle.exec('PRAGMA synchronous=NORMAL;');
  handle.exec('PRAGMA foreign_keys=ON;');
  // The one that makes `signals` actually append-only rather than nominally so. Off by default,
  // and with it off `INSERT OR REPLACE` deletes a row WITHOUT firing the BEFORE DELETE trigger.
  handle.exec('PRAGMA recursive_triggers=ON;');

  let depth = 0;

  const db: Db = {
    prepare(sql) {
      const statement = handle.prepare(sql);
      return {
        run(params) {
          const result = statement.run(...spread(params));
          return {
            changes: toNumber(result.changes),
            lastInsertRowid: toNumber(result.lastInsertRowid),
          };
        },
        get<T>(params?: DbParams) {
          return statement.get(...spread(params)) as T | undefined;
        },
        all<T>(params?: DbParams) {
          return statement.all(...spread(params)) as T[];
        },
      };
    },

    exec(sql) {
      handle.exec(sql);
    },

    transaction<T>(fn: () => T): T {
      if (depth > 0) {
        const name = `army_sp_${depth}`;
        depth += 1;
        handle.exec(`SAVEPOINT ${name};`);
        try {
          const value = fn();
          handle.exec(`RELEASE ${name};`);
          return value;
        } catch (error) {
          handle.exec(`ROLLBACK TO ${name};`);
          handle.exec(`RELEASE ${name};`);
          throw error;
        } finally {
          depth -= 1;
        }
      }
      depth = 1;
      handle.exec('BEGIN IMMEDIATE;');
      try {
        const value = fn();
        handle.exec('COMMIT;');
        return value;
      } catch (error) {
        try {
          handle.exec('ROLLBACK;');
        } catch {
          // A failed rollback means the transaction was already resolved by SQLite; the original
          // error is what the caller needs to see, so it is not masked here.
        }
        throw error;
      } finally {
        depth = 0;
      }
    },

    close() {
      handle.close();
    },
  };

  return db;
};

// ---------------------------------------------------------------------------------------------
// The guard that survives a driver swap
// ---------------------------------------------------------------------------------------------

/** Schema name for the throwaway in-memory database the behavioural probe runs inside. */
const PROBE_SCHEMA = 'army_pragma_probe';

/**
 * DEMONSTRATE — not merely read — that this connection fires BEFORE DELETE triggers on a REPLACE
 * conflict. That single behaviour is what makes `signals` append-only; every other guarantee the
 * bus makes rests on it.
 *
 * Reading `PRAGMA recursive_triggers` proves only what the driver SAYS. A driver that reports 1
 * without enforcing it passes a declarative check and then lets `INSERT OR REPLACE` rewrite an
 * audit row. So this builds the exact situation in miniature and checks what actually happens.
 *
 * It runs inside an ATTACHed `:memory:` database, which is what makes it safe to do on every
 * open: the campaign file is not written at all (not one WAL frame), the probe cannot collide
 * with any real table, and a crash halfway through leaves nothing behind anywhere — the scratch
 * schema dies with the connection.
 */
function assertReplaceFiresDeleteTriggers(db: Db): void {
  let attached = false;
  try {
    try {
      db.exec(`ATTACH ':memory:' AS ${PROBE_SCHEMA};`);
      attached = true;
    } catch (error) {
      throw new Error(
        'archive database cannot ATTACH an in-memory database, so the append-only guarantee ' +
          'cannot be demonstrated on this driver; refusing to open rather than assuming it holds ' +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }

    db.exec(`CREATE TABLE ${PROBE_SCHEMA}.probe (k INTEGER PRIMARY KEY, v TEXT NOT NULL);`);
    db.exec(
      `CREATE TRIGGER ${PROBE_SCHEMA}.probe_no_delete BEFORE DELETE ON probe BEGIN
         SELECT RAISE(ABORT, 'probe: DELETE forbidden');
       END;`,
    );
    db.exec(`INSERT INTO ${PROBE_SCHEMA}.probe (k, v) VALUES (1, 'original');`);

    let refused = false;
    try {
      db.exec(`INSERT OR REPLACE INTO ${PROBE_SCHEMA}.probe (k, v) VALUES (1, 'rewritten');`);
    } catch {
      refused = true;
    }
    // Both halves matter: the statement must have been refused AND the row must be untouched.
    // A driver could conceivably throw after having already replaced the row.
    const survivor = db
      .prepare(`SELECT v FROM ${PROBE_SCHEMA}.probe WHERE k = 1`)
      .get<{ v: string }>();
    if (!refused || survivor?.v !== 'original') {
      throw new Error(
        'archive database reports recursive_triggers=ON but does not enforce it: INSERT OR ' +
          'REPLACE bypassed a BEFORE DELETE trigger in a live probe' +
          (survivor?.v === 'original' ? '' : ` and rewrote the row to ${JSON.stringify(survivor?.v)}`) +
          '. The signals table would be silently rewritable on this driver.',
      );
    }
  } finally {
    if (attached) {
      try {
        db.exec(`DETACH ${PROBE_SCHEMA};`);
      } catch {
        // Nothing recoverable, and nothing persistent to clean: the scratch schema is in memory
        // and goes away with the connection. Never mask the original error.
      }
    }
  }
}

/**
 * Verify that a connection actually carries the settings the archive's invariants depend on, and
 * throw loudly if it does not.
 *
 * This exists because the pragmas are PER-CONNECTION and are set inside one particular factory.
 * `setDbFactory` is an explicit invitation to replace that factory with `bun:sqlite` or
 * `better-sqlite3`, and a replacement that forgot `recursive_triggers` would leave every other
 * test passing while `INSERT OR REPLACE` quietly rewrote the audit log. So the archive re-reads
 * the values from the live connection rather than trusting whoever opened it.
 *
 * WHAT IS MEASURED, on this exact connection, at every read-write open:
 *  - that a BEFORE DELETE trigger really fires on a REPLACE conflict, by running one
 *    (`assertReplaceFiresDeleteTriggers`). This is the behaviour the append-only bus depends on,
 *    and it is checked by observation, so a driver that merely CLAIMS `recursive_triggers=1` is
 *    caught. `bun:sqlite` and `better-sqlite3` are not installed here and so were never tested
 *    directly — but the probe means a non-compliant one fails on the machine that actually runs
 *    it, rather than being trusted on the strength of sharing a C library.
 *
 * WHAT IS STILL ONLY REPORTED, not demonstrated:
 *  - `journal_mode=WAL` and `busy_timeout` are read back, not exercised. Proving those
 *    behaviourally needs contention and a clock, which does not belong on the open path; they are
 *    covered by tests instead (`WAL is what lets a reader hold a snapshot while a writer commits`
 *    and the concurrent-writer test).
 *  - `foreign_keys` is read back only.
 *
 * `mode: 'readonly'` SKIPS THE BEHAVIOURAL PROBE, and only that. The probe needs `CREATE TABLE` +
 * `INSERT`, which SQLite refuses on a read-only connection in every schema — including an
 * ATTACHed `:memory:` one, where the ATTACH succeeds and the CREATE inside it still fails. Losing
 * it costs nothing there: the hole it guards is `INSERT OR REPLACE` rewriting an audit row, and a
 * read-only handle cannot execute any write at all, so the hole is not reachable through one. All
 * four declarative checks are readable read-only and still run. The default is `'readwrite'`, so
 * forgetting the argument buys MORE checking, never less.
 */
export function assertArchivePragmas(db: Db, mode: 'readwrite' | 'readonly' = 'readwrite'): void {
  const read = <T>(pragma: string): T | undefined => db.prepare(`PRAGMA ${pragma}`).get<T>();

  const journal = read<{ journal_mode: string }>('journal_mode')?.journal_mode;
  // `memory` is the only legal alternative: an in-memory database cannot use WAL, and has no
  // concurrency story to protect in the first place.
  if (journal !== 'wal' && journal !== 'memory') {
    throw new Error(
      `archive database opened with journal_mode=${String(journal)}; the archive requires WAL: ` +
        'concurrent supervisor processes read this file while one of them writes, and without ' +
        'WAL a contended write can lose a row from an append-only log',
    );
  }

  const busy = read<{ timeout: number }>('busy_timeout')?.timeout;
  if (typeof busy !== 'number' || busy < DEFAULT_BUSY_TIMEOUT_MS) {
    throw new Error(
      `archive database opened with busy_timeout=${String(busy)}; the archive requires ` +
        `${DEFAULT_BUSY_TIMEOUT_MS} — with several supervisor processes writing, a contended ` +
        'writer would fail instead of waiting, and the row it was appending would be lost',
    );
  }

  const recursive = read<{ recursive_triggers: number }>('recursive_triggers')?.recursive_triggers;
  if (recursive !== 1) {
    throw new Error(
      'archive database opened with recursive_triggers=OFF; the signals append-only triggers ' +
        'do not fire on a REPLACE conflict without it, so INSERT OR REPLACE would silently ' +
        'overwrite audit rows',
    );
  }

  const foreignKeys = read<{ foreign_keys: number }>('foreign_keys')?.foreign_keys;
  if (foreignKeys !== 1) {
    throw new Error('archive database opened with foreign_keys=OFF');
  }

  // Last, and the only one that observes rather than asks. Not reachable read-only — see above.
  if (mode === 'readwrite') assertReplaceFiresDeleteTriggers(db);
}

// ---------------------------------------------------------------------------------------------
// Factory registration — the swap point
// ---------------------------------------------------------------------------------------------

let factory: DbFactory = openNodeSqliteDb;

/** Drop in `bun:sqlite` / `better-sqlite3` without touching a single call site. */
export function setDbFactory(next: DbFactory): void {
  factory = next;
}

export function getDbFactory(): DbFactory {
  return factory;
}

export function openDb(filename: string, options?: DbOpenOptions): Db {
  return factory(filename, options);
}
