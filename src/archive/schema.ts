/**
 * The campaign index schema.
 *
 * Inlined in TypeScript rather than shipped as `schema.sql` for one practical reason: the publish
 * build is `tsc -p tsconfig.build.json` and `package.json#files` lists `dist`, so a loose `.sql`
 * file would type-check fine in development and then be missing from the published package. A
 * `.ts` constant cannot rot that way.
 *
 * Two things here are load-bearing:
 *
 * 1. **`SIGNALS_TABLE_SQL` is FROZEN** — a pinned constant, comments and alignment included, that
 *    `test/archive.test.ts` asserts byte-for-byte against a checked-in expected copy. Do not
 *    reformat it, do not re-align it, do not grow it a column. It is a `CREATE TABLE` and not a
 *    `CREATE TABLE IF NOT EXISTS` because that is the pinned form, so schema application is
 *    guarded by `PRAGMA user_version` instead of by the DDL.
 * 2. **The signals table is append-only, enforced by the database.** `signals_no_update` and
 *    `signals_no_delete` make an UPDATE or DELETE an error, not a code-review finding. There is
 *    no `state` column and there never will be one: a query is answered iff an `answer` row
 *    exists with `in_reply_to = seq`, which is a QUERY (`ANSWERED_QUERY_SQL`) and not a column.
 *
 *    THESE TRIGGERS ARE NOT SELF-SUFFICIENT. SQLite fires DELETE triggers on a REPLACE conflict
 *    only when `recursive_triggers` is ON, and it defaults to OFF — so with the default,
 *    `INSERT OR REPLACE INTO signals` and `REPLACE INTO signals` delete the conflicting row
 *    WITHOUT firing `signals_no_delete`, and rewrite the audit log with no error. `db.ts` sets
 *    the pragma, and `assertArchivePragmas` PROVES on every open that the connection actually
 *    enforces it — it runs a REPLACE against a scratch table and checks the trigger fired, so a
 *    driver that reports the pragma without honouring it is caught. If you are porting this
 *    schema to another driver, that pragma travels with it or the invariant is fiction.
 *
 * Every CHECK list is generated from the contract constants, so a value added to `TASK_STATUSES`
 * cannot silently become a row the database rejects at 3am.
 */

import { AGENT_STATUSES, CAMPAIGN_STATUSES, SIGNAL_KINDS, TASK_STATUSES } from '../contracts/archive.ts';
import { HARNESS_IDS, SOLDIER_EVENT_TYPES } from '../contracts/harness.ts';
import { RANK_ORDER, ROLES } from '../contracts/ranks.ts';
import { RUNGS } from '../contracts/delivery.ts';

/** Bumped whenever the DDL below changes. Guards application, and tells `rebuild` what it wrote. */
export const SCHEMA_VERSION = 1;

function quotedList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

function numberList(values: readonly number[]): string {
  return values.join(', ');
}

/**
 * FROZEN — VERBATIM. Do not reformat, do not "tidy" the alignment, do not add a column.
 * `test/archive.test.ts` diffs this against a checked-in expected copy and fails on a single
 * changed byte.
 */
export const SIGNALS_TABLE_SQL = `CREATE TABLE signals (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- total order, never reused
  ts          TEXT    NOT NULL,
  from_agent  TEXT    NOT NULL,
  to_agent    TEXT,                               -- explicit id…
  to_selector TEXT,                               -- …or a selector. Only 'chain' is ever written.
  kind        TEXT    NOT NULL,                   -- order|report|query|answer|broadcast|status
  in_reply_to INTEGER REFERENCES signals(seq),
  body        TEXT    NOT NULL,                   -- capped
  artifact    TEXT                                -- pointer to the big stuff
);`;

/**
 * The pragma line from the same block. Applied by `db.ts` at connection open, not here — pragmas
 * are per-connection state, so a schema string is the wrong place for them to live. Exported so
 * the fidelity test can reconstruct the whole pinned block.
 */
export const SIGNALS_PRAGMA_SQL = 'PRAGMA journal_mode=WAL;  PRAGMA busy_timeout=5000;';

/**
 * A query is answered iff an `answer` row exists with `in_reply_to = seq`.
 * Current state is COMPUTED. This is the entire reason there is no `state` column.
 */
export const ANSWERED_QUERY_SQL = `SELECT EXISTS (
  SELECT 1 FROM signals WHERE kind = 'answer' AND in_reply_to = ?
) AS answered`;

export const SCHEMA_SQL = `
-- ============================================================================================
-- campaigns. One row; the file it lives in IS the campaign.
-- ============================================================================================
CREATE TABLE campaigns (
  id         TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN (${quotedList(CAMPAIGN_STATUSES)})),
  created_at TEXT NOT NULL,
  ended_at   TEXT,
  root_dir   TEXT NOT NULL
);

-- ============================================================================================
-- tasks. An agent is a process; a task is INTENT. They nest, and a task with
-- agent_id NULL / status 'queued' is real work no process has ever touched. That row existing
-- with no agent is the whole point of the table: unstarted work must live somewhere other than
-- a commanding agent's context window.
--
-- agent_id points at the CURRENT attempt and is deliberately nullable between retries. It has no
-- FOREIGN KEY to agents(id): agents.task_id already references tasks(id), and closing the cycle
-- would force every insert order in the codebase to thread a needle for no integrity gain.
-- ============================================================================================
CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT NOT NULL REFERENCES campaigns(id),
  parent_task_id TEXT REFERENCES tasks(id),
  title          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN (${quotedList(TASK_STATUSES)})),
  agent_id       TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  orders_path    TEXT,
  branch         TEXT,
  delivered_rung INTEGER CHECK (delivered_rung IS NULL OR delivered_rung IN (${numberList(RUNGS)})),
  pr_url         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);
CREATE INDEX tasks_by_campaign ON tasks(campaign_id);
CREATE INDEX tasks_by_parent   ON tasks(parent_task_id);
CREATE INDEX tasks_by_status   ON tasks(status);

-- ============================================================================================
-- agents — one ATTEMPT at a task. depth is a SEPARATE column from rank on purpose:
-- rank is assigned by the spawner, depth is structural, and the gap between them is diagnostic.
-- cost_usd / duration_ms are recorded from what the harness reported; nothing is ever inferred.
-- ============================================================================================
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  task_id         TEXT REFERENCES tasks(id),
  parent_agent_id TEXT REFERENCES agents(id),
  rank            TEXT NOT NULL CHECK (rank IN (${quotedList(RANK_ORDER)})),
  role            TEXT NOT NULL CHECK (role IN (${quotedList(ROLES)})),
  harness         TEXT NOT NULL CHECK (harness IN (${quotedList(HARNESS_IDS)})),
  model           TEXT,
  effort          TEXT,
  session_id      TEXT NOT NULL,
  attempt         INTEGER NOT NULL CHECK (attempt >= 1),
  depth           INTEGER NOT NULL CHECK (depth >= 0),
  status          TEXT NOT NULL CHECK (status IN (${quotedList(AGENT_STATUSES)})),
  worktree_path   TEXT,
  lease_id        TEXT,
  dir             TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  exit_code       INTEGER,
  cost_usd        REAL,
  duration_ms     INTEGER,
  CHECK (parent_agent_id IS NULL OR parent_agent_id <> id),
  UNIQUE (task_id, attempt)
);
CREATE INDEX agents_by_campaign ON agents(campaign_id);
CREATE INDEX agents_by_task     ON agents(task_id);
CREATE INDEX agents_by_parent   ON agents(parent_agent_id);

-- ============================================================================================
-- signals — the message bus, pinned verbatim. APPEND-ONLY, enforced below by triggers rather
-- than by convention. NEVER add a state column.
-- ============================================================================================
${SIGNALS_TABLE_SQL}

CREATE TRIGGER signals_no_update BEFORE UPDATE ON signals BEGIN
  SELECT RAISE(ABORT, 'signals is append-only: UPDATE is forbidden');
END;
CREATE TRIGGER signals_no_delete BEFORE DELETE ON signals BEGIN
  SELECT RAISE(ABORT, 'signals is append-only: DELETE is forbidden');
END;

CREATE INDEX signals_by_reply    ON signals(in_reply_to);
CREATE INDEX signals_by_kind     ON signals(kind);
CREATE INDEX signals_by_from     ON signals(from_agent);
CREATE INDEX signals_by_to       ON signals(to_agent);
CREATE INDEX signals_by_selector ON signals(to_selector);

-- ============================================================================================
-- events — the INDEX over stream.jsonl. The FILE is truth; this table exists so the
-- dashboard can seek without replaying, and so rebuild can regenerate it from the jsonl alone.
-- payload is the full normalised SoldierEvent including its raw line, so one row replays.
-- "offset" is quoted: OFFSET is a SQLite keyword.
-- ============================================================================================
CREATE TABLE events (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id        TEXT NOT NULL REFERENCES campaigns(id),
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  ts                 TEXT NOT NULL,
  type               TEXT NOT NULL CHECK (type IN (${quotedList(SOLDIER_EVENT_TYPES)})),
  "offset"           INTEGER,
  parent_tool_use_id TEXT,
  depth              INTEGER NOT NULL CHECK (depth >= 0),
  payload            TEXT NOT NULL
);
CREATE INDEX events_by_agent    ON events(agent_id, seq);
CREATE INDEX events_by_campaign ON events(campaign_id, seq);
CREATE INDEX events_by_parent   ON events(parent_tool_use_id);
`;

/**
 * Apply the schema to a fresh database, returning true iff it actually wrote anything.
 *
 * Idempotent, and safe when several supervisor processes open the same campaign at once: the
 * signals DDL is a plain `CREATE TABLE`, so re-running it would throw, and the check-then-apply is
 * therefore done inside `BEGIN IMMEDIATE` where the second process waits for the first and then
 * sees the bumped `user_version`.
 */
export function applySchema(db: {
  exec(sql: string): void;
  prepare(sql: string): { get<T>(): T | undefined };
  transaction<T>(fn: () => T): T;
}): boolean {
  // Fast path first: opening an existing campaign is the common case and must not take a write
  // lock, or every `army` command would briefly block every running supervisor.
  const seen = db.prepare('PRAGMA user_version').get<{ user_version: number }>();
  if ((seen?.user_version ?? 0) >= SCHEMA_VERSION) return false;

  return db.transaction(() => {
    const row = db.prepare('PRAGMA user_version').get<{ user_version: number }>();
    if ((row?.user_version ?? 0) >= SCHEMA_VERSION) return false;
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    return true;
  });
}
