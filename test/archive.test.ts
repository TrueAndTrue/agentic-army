/**
 * The war archive.
 *
 * `node:test` + `node:assert/strict`, zero dependencies, every case in its own temp directory.
 *
 * The headline is `signals survives real concurrent writers`. It spawns actual child processes
 * that hammer one campaign database at once, and asserts that every row survives with a `seq`
 * that is a gapless total order with no reuse. That is the property the append-only log exists
 * to guarantee, and it is capable of failing: with `busy_timeout` at zero a contended writer gets
 * SQLITE_BUSY and the worker dies non-zero, and with the log mutable at all a lost update would
 * show up as a missing body.
 *
 * What that test does NOT prove is WAL. `busy_timeout` alone serialises the writers, so forcing
 * `journal_mode=DELETE` leaves it green. WAL is covered separately and explicitly by
 * `WAL is what lets a reader hold a snapshot while a writer commits`, which fails without it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  AgentRow,
  CampaignRow,
  EventRow,
  SignalRow,
  TaskRow,
} from '../src/contracts/archive.ts';
import type { SoldierEvent } from '../src/contracts/harness.ts';

import {
  AgentIdInUseError,
  CampaignArchive,
  createCampaign,
  listCampaignIds,
  openCampaign,
  openCampaignReadOnly,
} from '../src/archive/archive.ts';
import { rebuildCampaign } from '../src/archive/rebuild.ts';
import type { Db } from '../src/archive/db.ts';
import { archiveDurabilityNote, assertArchivePragmas, openDb } from '../src/archive/db.ts';
import {
  applySchema,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  SIGNALS_PRAGMA_SQL,
  SIGNALS_TABLE_SQL,
} from '../src/archive/schema.ts';
import { RANK_ORDER, ROLES } from '../src/contracts/ranks.ts';
import {
  agentDirRelative,
  campaignDbPath,
  isSafeSegment,
  resolveInCampaign,
  signalsJsonlPath,
  streamJsonlPath,
} from '../src/archive/paths.ts';

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------

const ARCHIVE_MODULE_URL = new URL('../src/archive/archive.ts', import.meta.url).href;

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'army-archive-'));
}

function removeTempRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

interface Fixture {
  archiveRoot: string;
  archive: CampaignArchive;
}

/** Fresh temp archive + one campaign, torn down whatever happens. */
function withCampaign(fn: (fixture: Fixture) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const archiveRoot = makeTempRoot();
    const archive = createCampaign(
      { archiveRoot },
      { id: '2026-08-02-take-hill-4', project: '/projects/agentic-army', title: 'Take Hill 4' },
    );
    try {
      await fn({ archiveRoot, archive });
    } finally {
      archive.close();
      removeTempRoot(archiveRoot);
    }
  };
}

function run(file: string, args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // stdout is asserted empty by the caller: node:sqlite emits an ExperimentalWarning, and
      // anything on stdout would corrupt `--json` output.
      resolve({ code, stderr: stderr + (stdout.length > 0 ? `\n[STDOUT]${stdout}` : '') });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// the frozen signals DDL
// ---------------------------------------------------------------------------------------------

/**
 * The signals DDL, frozen.
 *
 * This is a PIN, not a second implementation: nothing reads it but the assertion below, so there
 * is no path by which the two can both be live and disagree. Its whole job is to make a change to
 * the bus schema impossible to make by accident — reformat the alignment, retitle a comment, add
 * a column, and this goes red on the byte.
 *
 * Updating it is therefore a deliberate act. If you are here because it failed, decide whether
 * the schema change was intended before you touch this string.
 */
const FROZEN_SIGNALS_BLOCK = `CREATE TABLE signals (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- total order, never reused
  ts          TEXT    NOT NULL,
  from_agent  TEXT    NOT NULL,
  to_agent    TEXT,                               -- explicit id…
  to_selector TEXT,                               -- …or a selector. Only 'chain' is ever written.
  kind        TEXT    NOT NULL,                   -- order|report|query|answer|broadcast|status
  in_reply_to INTEGER REFERENCES signals(seq),
  body        TEXT    NOT NULL,                   -- capped
  artifact    TEXT                                -- pointer to the big stuff
);
PRAGMA journal_mode=WAL;  PRAGMA busy_timeout=5000;`;

test('the signals DDL has not drifted from the frozen block', () => {
  const block = `${SIGNALS_TABLE_SQL}\n${SIGNALS_PRAGMA_SQL}`;
  assert.equal(
    block,
    FROZEN_SIGNALS_BLOCK,
    'schema.ts drifted — the signals table SQL is frozen and must match byte for byte',
  );
  // And the shape the rest of the archive relies on: a total order, and no state column.
  assert.ok(SIGNALS_TABLE_SQL.includes('seq         INTEGER PRIMARY KEY AUTOINCREMENT'));
  assert.ok(!/\bstate\b/.test(SIGNALS_TABLE_SQL), 'signals must never grow a state column');
});

test('the rank and role CHECK lists are generated, so a new rank is a storable row', () => {
  // The lists are `quotedList(RANK_ORDER)` and `quotedList(ROLES)`, which is what stops a value
  // added to the contract from becoming a row the database rejects at 3am. Asserted against the
  // constants rather than against a retyped list, and then against a real INSERT, because a
  // generated string that nothing has ever inserted through proves only that it is a string.
  for (const rank of RANK_ORDER) assert.ok(SCHEMA_SQL.includes(`'${rank}'`), `rank ${rank}`);
  for (const role of ROLES) assert.ok(SCHEMA_SQL.includes(`'${role}'`), `role ${role}`);
  // The frozen bus DDL depends on neither, which is what makes a rank or role addition safe to
  // make: it changes the agents table and leaves the append-only log byte-identical.
  for (const value of ['MAJOR', 'OVERSEER', 'VALIDATOR']) {
    assert.ok(!SIGNALS_TABLE_SQL.includes(value), `${value} reached the frozen signals block`);
  }

  const root = makeTempRoot();
  try {
    const archive = createCampaign({ archiveRoot: root }, { project: '/p', title: 'ranks' });
    const task = archive.createTask({ title: 'own the feature' });
    // The pair the whole design is written in, through the real insert path. At schema version 1
    // this row was rejected by the CHECK constraint, not by anything a reader could see.
    const agent = archive.recordAgentAttempt({
      id: 'maj-01',
      taskId: task.id,
      rank: 'MAJOR',
      role: 'OVERSEER',
      harness: 'claude',
      sessionId: '11111111-1111-4111-8111-111111111111',
      depth: 1,
      orders: '# Orders\nOwn the feature.\n',
    });
    const stored = archive.listAgents().find((row) => row.id === agent.id);
    assert.equal(stored?.rank, 'MAJOR');
    assert.equal(stored?.role, 'OVERSEER');
    archive.close();
  } finally {
    removeTempRoot(root);
  }
});

test('an index written by an older release is refused with the reason, not with a DDL error', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'old.db');
    const db = openDb(file);
    try {
      // Exactly what the previous release left on disk: every table present, an older
      // `user_version`. `applySchema` would otherwise run the DDL straight over the top of it and
      // fail on `CREATE TABLE campaigns`, a true sentence that explains nothing and names no fix.
      db.exec(SCHEMA_SQL);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1};`);
      assert.throws(
        () => applySchema(db),
        /schema version .* the `rebuild` command/su,
        'an old index must be refused by the version check, not by the first CREATE TABLE',
      );
      // A refusal that names a command has to name one THIS reader can type. `src/archive/**`
      // sits below `src/setup/**` and cannot ask `invokedAs()`, so the invocation arrives as a
      // parameter and the caller that has one passes it. Both spellings are checked, and the
      // hardcoded `army` that neither of them is:
      const self = 'node src/cli.ts';
      assert.throws(
        () => applySchema(db, self),
        new RegExp(`\`${self.replace(/[/.]/g, '\\$&')} rebuild\``, 'su'),
        'a caller that knows the invocation must get it printed back',
      );
      // Capable of failing: drop the parameter and this passes on the word `rebuild` alone.
      try {
        applySchema(db, self);
        assert.fail('the refusal did not throw');
      } catch (error) {
        assert.doesNotMatch((error as Error).message, /`army rebuild`/);
        assert.doesNotMatch((error as Error).message, /the `rebuild` command/);
      }
      // …and the fast path is untouched: a current database is a no-op, a fresh one is written.
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      assert.equal(applySchema(db), false);
    } finally {
      db.close();
    }

    const fresh = openDb(path.join(root, 'fresh.db'));
    try {
      assert.equal(applySchema(fresh), true, 'an empty file is version 0 and gets the schema');
      const version = fresh.prepare('PRAGMA user_version').get<{ user_version: number }>();
      assert.equal(version?.user_version, SCHEMA_VERSION);
      assert.equal(applySchema(fresh), false, 'applying twice writes nothing');
    } finally {
      fresh.close();
    }
  } finally {
    removeTempRoot(root);
  }
});

test('WAL and busy_timeout are actually set on every connection', () => {
  const root = makeTempRoot();
  try {
    const db = openDb(path.join(root, 'pragmas.db'));
    try {
      const journal = db.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>();
      const busy = db.prepare('PRAGMA busy_timeout').get<{ timeout: number }>();
      assert.equal(journal?.journal_mode, 'wal');
      assert.equal(busy?.timeout, 5000);
    } finally {
      db.close();
    }
  } finally {
    removeTempRoot(root);
  }
});

/**
 * WAL's DISTINGUISHING property, and the one the concurrent-writer test below cannot falsify:
 * readers do not block writers.
 *
 * `busy_timeout` alone is enough to keep the concurrency test green in rollback-journal mode —
 * writers just serialise and no row is lost — so that test would not notice WAL being dropped.
 * This one would. It is self-falsifying: it asserts the WAL behaviour AND asserts that the very
 * same sequence fails in `journal_mode=DELETE`, so it cannot pass if the modes were confused.
 */
test('WAL is what lets a reader hold a snapshot while a writer commits', () => {
  const root = makeTempRoot();
  const outcomes: Record<string, string> = {};
  try {
    for (const wal of [true, false]) {
      const file = path.join(root, `reader-${String(wal)}.db`);
      const setup = openDb(file, { wal });
      setup.exec('CREATE TABLE t (a INTEGER PRIMARY KEY AUTOINCREMENT, b TEXT);');
      setup.prepare('INSERT INTO t (b) VALUES (?)').run(['seed']);
      const mode = setup.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>();
      assert.equal(mode?.journal_mode, wal ? 'wal' : 'delete');
      setup.close();

      // A short timeout: without WAL this test would otherwise wait the full 5s to prove a point.
      const reader = openDb(file, { wal, busyTimeoutMs: 250 });
      const writer = openDb(file, { wal, busyTimeoutMs: 250 });
      try {
        reader.exec('BEGIN;');
        // Touching the table is what actually takes the read lock / snapshot.
        const before = reader.prepare('SELECT count(*) AS c FROM t').get<{ c: number }>();
        assert.equal(before?.c, 1);

        try {
          writer.transaction(() => writer.prepare('INSERT INTO t (b) VALUES (?)').run(['during']));
          outcomes[String(wal)] = 'committed';
        } catch (error) {
          outcomes[String(wal)] = error instanceof Error ? error.message : String(error);
        }

        // The reader's snapshot is unchanged either way — that is what a snapshot means.
        const after = reader.prepare('SELECT count(*) AS c FROM t').get<{ c: number }>();
        assert.equal(after?.c, 1);
        reader.exec('COMMIT;');
      } finally {
        reader.close();
        writer.close();
      }
    }

    assert.equal(outcomes.true, 'committed', 'under WAL a held read must not block a writer');
    assert.match(
      outcomes.false ?? '',
      /locked|busy/i,
      'without WAL the same held read must block the writer — if this passes, the test below ' +
        'is not proving WAL either',
    );
  } finally {
    removeTempRoot(root);
  }
});

// ---------------------------------------------------------------------------------------------
// THE HEADLINE: real concurrent writers
// ---------------------------------------------------------------------------------------------

const WORKERS = 6;
const PER_WORKER = 100;
/**
 * Two things stop naive "spawn N processes" from testing anything.
 *
 * Process startup costs ~100ms, which is longer than the whole write loop, so without a BARRIER
 * the workers queue up politely and never overlap. And SQLite's busy handler backs off in
 * increasing sleeps, so a worker that wins the write lock and never yields simply starves every
 * other one out — which is why the loop yields between inserts.
 *
 * With both, all six processes are live against the same database at the same instant, which the
 * test then verifies rather than assumes.
 */
const START_BARRIER_MS = 750;

test(
  'signals survives real concurrent writers: every row, total order, no reuse',
  { timeout: 120_000 },
  withCampaign(async ({ archiveRoot, archive }) => {
    const campaignId = archive.campaignId;
    // The parent's own handle must not hold a write lock while the children run.
    archive.close();

    const workerPath = path.join(archiveRoot, 'concurrent-writer.mjs');
    fs.writeFileSync(
      workerPath,
      `import { setTimeout as sleep } from 'node:timers/promises';
import { openCampaign } from ${JSON.stringify(ARCHIVE_MODULE_URL)};

const [archiveRoot, campaignId, worker, count, startAt] = process.argv.slice(2);
const archive = openCampaign({ archiveRoot }, campaignId);

// Barrier: every worker starts writing at the same instant, so the inserts genuinely contend.
const remaining = Number(startAt) - Date.now();
if (remaining > 5) await sleep(remaining - 5);
while (Date.now() < Number(startAt)) { /* tighten the last few ms */ }

const began = Date.now();
try {
  for (let i = 0; i < Number(count); i++) {
    archive.appendSignal({
      fromAgent: worker,
      toSelector: 'chain',
      kind: 'status',
      body: worker + ':' + i,
    });
    // Read while others write — WAL's whole point, and it must not block or tear.
    if (i % 10 === 0) archive.listSignals({ limit: 5 });
    // Yield, or whoever grabs the write lock first starves the rest inside their busy handlers.
    await sleep(1);
  }
} finally {
  // The worker's own window, so the parent can prove the processes really overlapped.
  archive.appendSignal({
    fromAgent: worker,
    kind: 'report',
    body: JSON.stringify({ began, ended: Date.now() }),
  });
  archive.close();
}
`,
      'utf8',
    );

    const startAt = Date.now() + START_BARRIER_MS;
    const results = await Promise.all(
      Array.from({ length: WORKERS }, (_unused, index) =>
        run(workerPath, [archiveRoot, campaignId, `w${index}`, String(PER_WORKER), String(startAt)]),
      ),
    );
    for (const [index, result] of results.entries()) {
      assert.equal(result.code, 0, `worker w${index} failed:\n${result.stderr}`);
      assert.equal(result.stderr, '', `worker w${index} wrote to stderr/stdout:\n${result.stderr}`);
    }

    const reopened = openCampaign({ archiveRoot }, campaignId);
    try {
      const expectedStatus = WORKERS * PER_WORKER;
      const expectedTotal = expectedStatus + WORKERS;
      const rows = reopened.listSignals();

      // 0. The writers were genuinely simultaneous — every worker's window contains one common
      //    instant. Without this the rest of the test could pass on six processes that politely
      //    took turns, and would say nothing about WAL or busy_timeout.
      const windows = reopened
        .listSignals({ kind: 'report' })
        .map((row) => JSON.parse(row.body) as { began: number; ended: number });
      assert.equal(windows.length, WORKERS);
      const latestStart = Math.max(...windows.map((w) => w.began));
      const earliestEnd = Math.min(...windows.map((w) => w.ended));
      assert.ok(
        latestStart <= earliestEnd,
        `workers did not overlap: last start ${latestStart} > first end ${earliestEnd}`,
      );

      // 1. Nothing was lost.
      assert.equal(rows.length, expectedTotal, 'a signal row went missing under concurrent writers');

      // 2. seq is a total order with no gaps and no reuse.
      const seqs = rows.map((row) => row.seq);
      assert.deepEqual(
        seqs,
        Array.from({ length: expectedTotal }, (_unused, i) => i + 1),
        'seq must be a gapless total order starting at 1',
      );
      assert.equal(new Set(seqs).size, expectedTotal, 'a seq was reused');

      // 3. Every body written by every worker is present exactly once — no overwrite.
      const bodies = new Map<string, number>();
      for (const row of rows) bodies.set(row.body, (bodies.get(row.body) ?? 0) + 1);
      for (let w = 0; w < WORKERS; w++) {
        for (let i = 0; i < PER_WORKER; i++) {
          assert.equal(bodies.get(`w${w}:${i}`), 1, `w${w}:${i} was lost or duplicated`);
        }
      }

      // 4. And the rows really are interleaved in the log, not six contiguous blocks.
      let switches = 0;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i]?.from_agent !== rows[i - 1]?.from_agent) switches += 1;
      }
      assert.ok(
        switches >= WORKERS * 4,
        `writers did not interleave (${switches} author changes across ${expectedTotal} rows)`,
      );

      // 5. FILES ARE TRUTH — the jsonl mirror holds the same rows, with the same seqs.
      const fileRows = fs
        .readFileSync(signalsJsonlPath(reopened.root), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SignalRow);
      assert.equal(fileRows.length, expectedTotal, 'signals.jsonl lost a row an O_APPEND write made');
      assert.deepEqual(
        [...fileRows].map((row) => row.seq).sort((a, b) => a - b),
        seqs,
      );

      // 6. And it survives a rebuild: the total order is reconstructible from the file alone.
      reopened.close();
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${campaignDbPath(reopened.root)}${suffix}`, { force: true });
      }
      const result = rebuildCampaign(reopened.root);
      assert.equal(result.written.signals, expectedTotal);
      assert.deepEqual(result.skipped, { tasks: 0, agents: 0, signals: 0, events: 0 });
      assert.deepEqual(result.warnings, []);
    } finally {
      reopened.close();
    }
  }),
);

// ---------------------------------------------------------------------------------------------
// signals: append-only, enforced by the database
// ---------------------------------------------------------------------------------------------

test(
  'the database itself refuses to UPDATE or DELETE a signal',
  withCampaign(({ archive }) => {
    archive.appendSignal({ fromAgent: 'cpt-03', kind: 'report', body: 'done' });
    assert.throws(
      () => archive.db.exec("UPDATE signals SET body = 'tampered' WHERE seq = 1"),
      /append-only/,
    );
    assert.throws(() => archive.db.exec('DELETE FROM signals WHERE seq = 1'), /append-only/);
    assert.equal(archive.getSignal(1)?.body, 'done');
  }),
);

/**
 * REGRESSION — the append-only triggers are NOT self-sufficient.
 *
 * SQLite fires DELETE triggers on a REPLACE conflict only when `recursive_triggers` is ON, and it
 * defaults to OFF. With the default, `INSERT OR REPLACE INTO signals` and `REPLACE INTO signals`
 * delete the conflicting row without firing `signals_no_delete` and rewrite the audit log with no
 * error at all. `rebuild.ts` already inserts explicit `seq` values, so that is precisely where the
 * edit which would exploit this hole ("make rebuild idempotent") will one day be written.
 */
test(
  'REPLACE cannot rewrite the bus: every conflict-resolution path is refused, row intact',
  withCampaign(({ archive }) => {
    const original = archive.appendSignal({
      fromAgent: 'cpt-03',
      toAgent: 'col-01',
      kind: 'report',
      body: 'ORIGINAL',
    });

    const attacks: [string, string][] = [
      [
        'INSERT OR REPLACE',
        `INSERT OR REPLACE INTO signals (seq, ts, from_agent, kind, body)
         VALUES (1, 't', 'evil', 'report', 'REPLACED')`,
      ],
      [
        'REPLACE INTO',
        `REPLACE INTO signals (seq, ts, from_agent, kind, body)
         VALUES (1, 't', 'evil', 'report', 'REPLACED')`,
      ],
      [
        'UPSERT DO UPDATE',
        `INSERT INTO signals (seq, ts, from_agent, kind, body)
         VALUES (1, 't', 'evil', 'report', 'REPLACED')
         ON CONFLICT(seq) DO UPDATE SET body = 'REPLACED'`,
      ],
      [
        'plain same-seq INSERT',
        `INSERT INTO signals (seq, ts, from_agent, kind, body)
         VALUES (1, 't', 'evil', 'report', 'REPLACED')`,
      ],
    ];

    for (const [name, sql] of attacks) {
      assert.throws(() => archive.db.exec(sql), `${name} was NOT refused`);
      assert.deepEqual(archive.getSignal(1), original, `${name} altered the row`);
    }

    // INSERT OR IGNORE is allowed to succeed as a no-op — what must not happen is the row
    // changing, or a second row appearing under the same seq.
    try {
      archive.db.exec(
        `INSERT OR IGNORE INTO signals (seq, ts, from_agent, kind, body)
         VALUES (1, 't', 'evil', 'report', 'REPLACED')`,
      );
    } catch {
      // Refusing outright is fine too.
    }
    assert.deepEqual(archive.getSignal(1), original, 'INSERT OR IGNORE altered the row');
    assert.equal(archive.listSignals().length, 1);
  }),
);

/**
 * A REAL connection with selected PRAGMA READS falsified, and nothing else.
 *
 * Deliberately not a stub: `assertArchivePragmas` now runs live SQL, so a stub that cannot execute
 * anything would be rejected for the wrong reason and would prove nothing about the declarative
 * checks. `mutate` runs first, so a test can genuinely turn a pragma OFF while the report still
 * claims it is ON — which is exactly the driver the behavioural probe exists to catch.
 */
function connectionReporting(
  file: string,
  report: Record<string, unknown>,
  mutate?: (db: Db) => void,
): Db {
  const real = openDb(file);
  mutate?.(real);
  return {
    prepare(sql: string) {
      const key = sql.trim().replace(/^PRAGMA\s+/, '');
      if (Object.prototype.hasOwnProperty.call(report, key)) {
        return {
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
          get: <T>() => report[key] as T,
          all: <T>() => [] as T[],
        };
      }
      return real.prepare(sql);
    },
    exec: (sql: string) => real.exec(sql),
    transaction: <T>(fn: () => T) => real.transaction(fn),
    close: () => real.close(),
  };
}

/** Open a falsified connection, run `fn` against it, always close it. */
function withReporting(
  root: string,
  name: string,
  report: Record<string, unknown>,
  fn: (db: Db) => void,
  mutate?: (db: Db) => void,
): void {
  const db = connectionReporting(path.join(root, `${name}.db`), report, mutate);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

test(
  'recursive_triggers is ON, and a connection without it is refused before anything is written',
  withCampaign(({ archive }) => {
    // A live archive connection really carries it — this is what makes the triggers above bite.
    const pragma = archive.db
      .prepare('PRAGMA recursive_triggers')
      .get<{ recursive_triggers: number }>();
    assert.equal(pragma?.recursive_triggers, 1);
    assert.doesNotThrow(() => assertArchivePragmas(archive.db));

    // And a driver swapped in behind the `Db` seam that dropped any one of them fails loudly
    // rather than leaving the bus quietly rewritable. Every pragma is checked, not just assumed.
    const root = makeTempRoot();
    try {
      withReporting(root, 'healthy', {}, (db) => {
        assert.doesNotThrow(() => assertArchivePragmas(db));
      });
      withReporting(root, 'no-recursive', { recursive_triggers: { recursive_triggers: 0 } }, (db) => {
        assert.throws(() => assertArchivePragmas(db), /recursive_triggers=OFF/);
      });
      withReporting(root, 'no-wal', { journal_mode: { journal_mode: 'delete' } }, (db) => {
        assert.throws(() => assertArchivePragmas(db), /requires WAL/);
      });
      withReporting(root, 'no-timeout', { busy_timeout: { timeout: 0 } }, (db) => {
        assert.throws(() => assertArchivePragmas(db), /busy_timeout=0/);
      });
      withReporting(root, 'no-fk', { foreign_keys: { foreign_keys: 0 } }, (db) => {
        assert.throws(() => assertArchivePragmas(db), /foreign_keys=OFF/);
      });
    } finally {
      removeTempRoot(root);
    }
  }),
);

/**
 * THE GAP A REPORTED-VALUE CHECK CANNOT CLOSE: a driver that ANSWERS `recursive_triggers=1` and
 * does not enforce it. Every declarative check waves it through, and `INSERT OR REPLACE` then
 * rewrites audit rows. So the guard also runs a live REPLACE against a scratch table in an
 * attached `:memory:` database and checks the trigger actually fired.
 *
 * The liar below is a faithful model rather than a stub: a real connection with the pragma
 * genuinely turned OFF, wrapped so only the pragma READ is falsified. Every statement the probe
 * issues hits real SQLite.
 */
test('the guard observes enforcement rather than trusting it: a lying driver is refused', () => {
  const root = makeTempRoot();
  const lie = { recursive_triggers: { recursive_triggers: 1 } };
  const turnItOff = (db: Db): void => db.exec('PRAGMA recursive_triggers=OFF;');
  try {
    withReporting(
      root,
      'liar',
      lie,
      (db) => {
        // It passes every declarative check — that is the whole point of the scenario.
        assert.equal(
          db.prepare('PRAGMA recursive_triggers').get<{ recursive_triggers: number }>()
            ?.recursive_triggers,
          1,
        );
        // And is still caught, by what it does rather than what it says.
        assert.throws(
          () => assertArchivePragmas(db),
          /reports recursive_triggers=ON but does not enforce it/,
        );
      },
      turnItOff,
    );

    // End to end: a lying factory cannot get far enough to create a campaign at all.
    const archiveRoot = path.join(root, 'archive');
    assert.throws(
      () =>
        createCampaign(
          { archiveRoot, dbFactory: (f) => connectionReporting(f, lie, turnItOff) },
          { project: '/p', title: 'lying driver' },
        ),
      /does not enforce it/,
    );

    // An honest factory through the very same seam is accepted.
    const honest = createCampaign(
      { archiveRoot, dbFactory: (f) => openDb(f) },
      { project: '/p', title: 'honest driver' },
    );
    honest.close();
  } finally {
    removeTempRoot(root);
  }
});

test('the probe leaves no residue: it never touches the campaign file', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'probe.db');
    const setup = openDb(file);
    setup.exec('CREATE TABLE real_table (a INTEGER PRIMARY KEY);');
    setup.close();

    const sizeBefore = fs.statSync(file).size;
    const db = openDb(file);
    try {
      for (let i = 0; i < 5; i++) assertArchivePragmas(db);

      // Nothing added to the real schema...
      assert.deepEqual(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name")
          .all<{ name: string }>()
          .map((row) => row.name),
        ['real_table'],
      );
      // ...and the scratch schema is detached, so its name is free every time.
      assert.deepEqual(
        db
          .prepare('PRAGMA database_list')
          .all<{ name: string }>()
          .map((row) => row.name),
        ['main'],
      );
    } finally {
      db.close();
    }
    // Not one byte written to the campaign file — the probe runs in an attached :memory: db.
    assert.equal(fs.statSync(file).size, sizeBefore);
    assert.equal(fs.existsSync(`${file}-wal`), false);
  } finally {
    removeTempRoot(root);
  }
});

test(
  'a query is answered iff an answer row points at its seq — computed, never stored',
  withCampaign(({ archive }) => {
    const columns = archive.db
      .prepare('PRAGMA table_info(signals)')
      .all<{ name: string }>()
      .map((column) => column.name);
    assert.deepEqual(columns, [
      'seq',
      'ts',
      'from_agent',
      'to_agent',
      'to_selector',
      'kind',
      'in_reply_to',
      'body',
      'artifact',
    ]);
    assert.ok(!columns.includes('state'), 'signals must never have a state column');

    const asked = archive.appendSignal({
      fromAgent: 'cpt-03',
      toAgent: 'col-01',
      kind: 'query',
      body: 'may I raise the delivery rung?',
    });
    const alsoAsked = archive.appendSignal({
      fromAgent: 'cpt-04',
      toAgent: 'col-01',
      kind: 'query',
      body: 'which branch do I base on?',
    });

    assert.equal(archive.isAnswered(asked.seq), false);
    assert.equal(archive.isAnswered(alsoAsked.seq), false);
    assert.deepEqual(
      archive.unansweredQueries().map((row) => row.seq),
      [asked.seq, alsoAsked.seq],
    );

    // A `report` referencing the query is NOT an answer — the kind is load-bearing.
    archive.appendSignal({
      fromAgent: 'col-01',
      toAgent: 'cpt-03',
      kind: 'report',
      inReplyTo: asked.seq,
      body: 'seen',
    });
    assert.equal(archive.isAnswered(asked.seq), false);

    const answer = archive.appendSignal({
      fromAgent: 'col-01',
      toAgent: 'cpt-03',
      kind: 'answer',
      inReplyTo: asked.seq,
      body: 'no — the ceiling is a file edit',
    });

    assert.equal(archive.isAnswered(asked.seq), true);
    assert.equal(archive.isAnswered(alsoAsked.seq), false);
    assert.deepEqual(
      archive.unansweredQueries().map((row) => row.seq),
      [alsoAsked.seq],
    );
    assert.deepEqual(
      archive.answersTo(asked.seq).map((row) => row.seq),
      [answer.seq],
    );

    // Nothing was mutated to make that true.
    assert.deepEqual(archive.getSignal(asked.seq), asked);
  }),
);

// ---------------------------------------------------------------------------------------------
// tasks vs agents
// ---------------------------------------------------------------------------------------------

test(
  'tasks nest, and a QUEUED task with no agent is a real row',
  withCampaign(({ archive }) => {
    const harden = archive.createTask({ title: 'harden auth', status: 'in_flight' });
    const rateLimiter = archive.createTask({
      parentTaskId: harden.id,
      title: 'add rate limiter',
      status: 'in_flight',
    });
    const rotateSecrets = archive.createTask({ parentTaskId: harden.id, title: 'rotate secrets' });
    const auditEndpoints = archive.createTask({
      parentTaskId: harden.id,
      title: 'audit endpoints',
      status: 'done',
    });

    // The point of the table: real work no process has ever touched.
    assert.equal(rotateSecrets.status, 'queued');
    assert.equal(rotateSecrets.agent_id, null);
    assert.equal(rotateSecrets.attempts, 0);
    assert.deepEqual(archive.agentsForTask(rotateSecrets.id), []);

    // Attempt 1 fails inspection three times; attempt 2 is a different agent on a different model.
    const first = archive.recordAgentAttempt({
      id: 'cpt-03',
      taskId: rateLimiter.id,
      rank: 'CAPTAIN',
      role: 'ENGINEER',
      harness: 'claude',
      model: 'claude-sonnet-5',
      sessionId: '11111111-1111-4111-8111-111111111111',
      depth: 1,
      orders: '# Orders\nAdd a rate limiter.\n',
    });
    assert.equal(first.attempt, 1);
    assert.equal(archive.getTask(rateLimiter.id)?.attempts, 1);
    assert.equal(archive.getTask(rateLimiter.id)?.agent_id, 'cpt-03');
    assert.equal(first.dir, agentDirRelative('cpt-03'));
    assert.equal(
      fs.readFileSync(resolveInCampaign(archive.root, `${first.dir}/orders.md`), 'utf8'),
      '# Orders\nAdd a rate limiter.\n',
    );

    archive.finishAgent('cpt-03', { status: 'failed', exitCode: 1, costUsd: 1.25, durationMs: 90_000 });

    const second = archive.recordAgentAttempt({
      id: 'cpt-07',
      taskId: rateLimiter.id,
      rank: 'CAPTAIN',
      role: 'ENGINEER',
      harness: 'claude',
      model: 'claude-opus-5',
      sessionId: '22222222-2222-4222-8222-222222222222',
      depth: 1,
    });
    assert.equal(second.attempt, 2);
    assert.equal(archive.getTask(rateLimiter.id)?.attempts, 2);
    assert.equal(archive.getTask(rateLimiter.id)?.agent_id, 'cpt-07');
    assert.deepEqual(
      archive.agentsForTask(rateLimiter.id).map((row) => row.id),
      ['cpt-03', 'cpt-07'],
    );

    // Between retries a task may point at no agent at all — also a real state.
    const cleared = archive.updateTask(rotateSecrets.id, { agentId: null, status: 'blocked' });
    assert.equal(cleared.agent_id, null);

    archive.updateTask(auditEndpoints.id, { deliveredRung: 2, prUrl: 'https://example/pull/412' });

    // An agent bound to no task at all (a synthesist) is legal too.
    archive.recordAgentAttempt({
      id: 'pvt-synth',
      rank: 'PRIVATE',
      role: 'SCOUT',
      harness: 'claude',
      sessionId: '33333333-3333-4333-8333-333333333333',
      depth: 2,
    });

    const tree = archive.tree();
    assert.equal(tree.campaign.id, '2026-08-02-take-hill-4');
    assert.equal(tree.tasks.length, 1);
    const root = tree.tasks[0];
    assert.ok(root !== undefined);
    assert.equal(root.task.id, harden.id);
    assert.deepEqual(
      root.children.map((child) => child.task.title),
      ['add rate limiter', 'rotate secrets', 'audit endpoints'],
    );
    const queuedNode = root.children[1];
    assert.ok(queuedNode !== undefined);
    assert.equal(queuedNode.task.status, 'blocked');
    assert.deepEqual(queuedNode.agents, [], 'a task with no agent must still render as a node');
    assert.deepEqual(
      root.children[0]?.agents.map((agent) => agent.attempt),
      [1, 2],
    );
    assert.deepEqual(
      tree.agentsWithoutTask.map((agent) => agent.id),
      ['pvt-synth'],
    );

    // Cost/timing: recorded as given, and what was NOT reported is counted, not zeroed.
    const ledger = archive.ledger();
    assert.equal(ledger.costUsd, 1.25);
    assert.equal(ledger.durationMs, 90_000);
    assert.equal(ledger.agents, 3);
    assert.equal(ledger.agentsMissingCost, 2);
    assert.equal(ledger.agentsMissingDuration, 2);
  }),
);

// ---------------------------------------------------------------------------------------------
// stream.jsonl — lossless, including `raw`
// ---------------------------------------------------------------------------------------------

function gnarlyEvents(): SoldierEvent[] {
  return [
    {
      type: 'ready',
      ts: '2026-08-02T10:00:00.000Z',
      raw: { type: 'system', subtype: 'init', session_id: 'abc', tools: ['Read', 'Edit'] },
      parentToolUseId: null,
      depth: 0,
      sessionId: 'abc',
      capabilities: ['interrupt_receipt_v1'],
    },
    {
      type: 'assistant_text',
      ts: '2026-08-02T10:00:01.000Z',
      // Everything that has ever broken a JSONL writer: newlines, tabs, quotes, backslashes,
      // astral-plane characters, lone surrogate escapes, deep nesting, empty containers, floats.
      raw: {
        text: 'line one\nline two\ttabbed "quoted" back\\slash',
        unicode: 'ünïcø∂é — 日本語 — \u{1F600}',
        escaped: '\\u0000 not a real null',
        nested: { a: [1, [2, [3, [{ b: null }]]]] },
        empties: { obj: {}, arr: [] },
        numbers: [0, -1, 1.5, 1e21, -0.000001],
        bool: [true, false],
      },
      parentToolUseId: null,
      depth: 0,
      text: 'line one\nline two',
    },
    {
      type: 'tool_use',
      ts: '2026-08-02T10:00:02.000Z',
      raw: { name: 'Edit', input: { file_path: 'C:\\Users\\a\\x.ts' } },
      parentToolUseId: null,
      depth: 0,
      name: 'Edit',
      toolUseId: 'toolu_1',
      input: { file_path: 'C:\\Users\\a\\x.ts' },
    },
    {
      type: 'tool_result',
      ts: '2026-08-02T10:00:03.000Z',
      raw: { tool_use_id: 'toolu_1', is_error: false, content: [{ type: 'text', text: 'ok' }] },
      parentToolUseId: null,
      depth: 0,
      toolUseId: 'toolu_1',
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    },
    {
      type: 'subagent_text',
      ts: '2026-08-02T10:00:04.000Z',
      raw: { parent_tool_use_id: 'toolu_1', subagent_type: 'Explore', text: 'found it' },
      parentToolUseId: 'toolu_1',
      depth: 2,
      text: 'found it',
      subagentType: 'Explore',
    },
    {
      type: 'error',
      ts: '2026-08-02T10:00:05.000Z',
      raw: { error: 'boom' },
      parentToolUseId: null,
      depth: 0,
      message: 'boom',
    },
    {
      type: 'unknown',
      ts: '2026-08-02T10:00:06.000Z',
      raw: { type: 'something_the_harness_invented_yesterday', payload: [1, 2, 3] },
      parentToolUseId: null,
      depth: 0,
      harnessType: 'something_the_harness_invented_yesterday',
    },
    {
      type: 'result',
      ts: '2026-08-02T10:00:07.000Z',
      raw: { subtype: 'success', total_cost_usd: 0.0731, duration_ms: 7412 },
      parentToolUseId: null,
      depth: 0,
      status: 'ok',
      costUsd: 0.0731,
      durationMs: 7412,
      usage: { inputTokens: 12_345, outputTokens: 678, cacheReadInputTokens: 90 },
    },
  ];
}

test(
  'stream.jsonl round-trips a SoldierEvent losslessly, raw included',
  withCampaign(({ archive }) => {
    archive.createTask({ id: 'task-1', title: 'harden auth', status: 'in_flight' });
    archive.recordAgentAttempt({
      id: 'cpt-03',
      taskId: 'task-1',
      rank: 'CAPTAIN',
      role: 'ENGINEER',
      harness: 'claude',
      sessionId: '44444444-4444-4444-8444-444444444444',
    });

    const events = gnarlyEvents();
    const rows = archive.appendEvents('cpt-03', events);
    assert.equal(rows.length, events.length);

    // 1. Read back from the FILE — that is what replay days later actually does.
    assert.deepEqual(archive.readStream('cpt-03'), { events, damaged: [] });

    // 2. One JSON object per line, no embedded newlines.
    const file = streamJsonlPath(archive.root, 'cpt-03');
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    assert.equal(lines.at(-1), '', 'every line must be newline-terminated');
    assert.equal(lines.length - 1, events.length);

    // 3. `raw` survived exactly, including the astral-plane and backslash cases.
    const replayed = archive.readStream('cpt-03').events;
    for (const [index, event] of events.entries()) {
      assert.deepEqual(replayed[index]?.raw, event.raw, `raw lost fidelity on event ${index}`);
    }

    // 4. EventRow.offset is a real byte offset into the file — the dashboard seeks with it.
    const buffer = fs.readFileSync(file);
    for (const [index, row] of rows.entries()) {
      assert.notEqual(row.offset, null);
      const start = row.offset as number;
      const end = buffer.indexOf(0x0a, start);
      assert.deepEqual(JSON.parse(buffer.subarray(start, end).toString('utf8')), events[index]);
    }

    // 5. A row alone replays: `payload` is the same JSON.
    const indexed = archive.listEvents('cpt-03');
    assert.equal(indexed.length, events.length);
    assert.deepEqual(
      indexed.map((row) => JSON.parse(row.payload)),
      events,
    );
    assert.deepEqual(
      indexed.map((row) => row.type),
      events.map((event) => event.type),
    );
    assert.equal(indexed[4]?.parent_tool_use_id, 'toolu_1');
    assert.equal(indexed[4]?.depth, 2);
  }),
);

// ---------------------------------------------------------------------------------------------
// rebuild-from-files
// ---------------------------------------------------------------------------------------------

interface Snapshot {
  campaign: CampaignRow;
  tasks: TaskRow[];
  agents: AgentRow[];
  signals: SignalRow[];
  events: Omit<EventRow, 'seq'>[];
}

function snapshot(archive: CampaignArchive): Snapshot {
  return {
    campaign: archive.getCampaign(),
    tasks: archive.listTasks(),
    agents: archive.listAgents(),
    signals: archive.listSignals(),
    // `seq` is dropped: it is a fresh AUTOINCREMENT over an index, and the FILE is what carries
    // event identity. Everything that is truth — agent, offset, depth, payload — is compared.
    events: archive
      .listEvents()
      .map(({ seq: _seq, ...rest }) => rest)
      .sort((a, b) => (a.agent_id === b.agent_id ? (a.offset ?? 0) - (b.offset ?? 0) : (a.agent_id < b.agent_id ? -1 : 1))),
  };
}

/** Populate a campaign with every shape rebuild has to reproduce. */
function populate(archive: CampaignArchive): void {
  const harden = archive.createTask({ id: 'task-harden', title: 'harden auth', status: 'in_flight' });
  archive.createTask({ id: 'task-rate', parentTaskId: harden.id, title: 'add rate limiter' });
  archive.createTask({ id: 'task-secrets', parentTaskId: harden.id, title: 'rotate secrets' });

  archive.recordAgentAttempt({
    id: 'cpt-03',
    taskId: 'task-rate',
    rank: 'CAPTAIN',
    role: 'ENGINEER',
    harness: 'claude',
    model: 'claude-sonnet-5',
    effort: 'xhigh',
    sessionId: '55555555-5555-4555-8555-555555555555',
    depth: 1,
    worktreePath: path.join('/', 'worktrees', 'cpt-03'),
    leaseId: 'lease-abc',
    orders: '# Orders\n',
  });
  archive.finishAgent('cpt-03', {
    status: 'exited',
    exitCode: 0,
    costUsd: 2.5,
    durationMs: 123_456,
  });
  archive.recordAgentAttempt({
    id: 'cpt-09',
    taskId: 'task-rate',
    parentAgentId: 'cpt-03',
    rank: 'CAPTAIN',
    role: 'INSPECTOR',
    harness: 'codex',
    model: 'gpt-5.5',
    sessionId: '66666666-6666-4666-8666-666666666666',
    depth: 1,
  });
  archive.updateTask('task-rate', { branch: 'army/task-rate', deliveredRung: 1 });

  const query = archive.appendSignal({
    fromAgent: 'cpt-03',
    toAgent: 'gen-01',
    kind: 'query',
    body: 'ceiling?',
  });
  archive.appendSignal({
    fromAgent: 'gen-01',
    toAgent: 'cpt-03',
    kind: 'answer',
    inReplyTo: query.seq,
    body: 'rung 2',
    artifact: 'agents/cpt-03/report.md',
  });
  archive.appendSignal({ fromAgent: 'cpt-09', toSelector: 'chain', kind: 'broadcast', body: 'PASS' });

  archive.appendEvents('cpt-03', gnarlyEvents());
  archive.appendEvents('cpt-09', gnarlyEvents().slice(0, 3));
  archive.writeReportMd('cpt-03', '# Findings\n');
  archive.writeDiff('cpt-03', 'diff --git a/x b/x\n');
}

test(
  'rebuild reproduces an equivalent DB after the original is deleted, and is idempotent',
  withCampaign(({ archiveRoot, archive }) => {
    populate(archive);
    const before = snapshot(archive);
    const campaignId = archive.campaignId;
    const root = archive.root;
    archive.close();

    // Destroy the index completely — rebuild must not need it, and must not read it.
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${campaignDbPath(root)}${suffix}`, { force: true });
    }
    assert.equal(fs.existsSync(campaignDbPath(root)), false);

    const result = rebuildCampaign(root);
    assert.equal(result.campaignId, campaignId);
    assert.deepEqual(result.skipped, { tasks: 0, agents: 0, signals: 0, events: 0 });
    assert.deepEqual(result.warnings, [], 'a clean rebuild must be silent');
    assert.equal(result.written.tasks, 3);
    assert.equal(result.written.agents, 2);
    assert.equal(result.written.signals, 3);
    assert.equal(result.written.events, 11);

    const rebuilt = openCampaign({ archiveRoot }, campaignId);
    try {
      assert.deepEqual(snapshot(rebuilt), before, 'rebuild produced a different archive');

      // The computed answer state survives, because it was never stored.
      assert.equal(rebuilt.isAnswered(1), true);
      assert.deepEqual(rebuilt.unansweredQueries(), []);

      // Replay still works, byte for byte.
      assert.deepEqual(rebuilt.readStream('cpt-03'), { events: gnarlyEvents(), damaged: [] });

      // seq is never reused: the next signal continues above the highest seq ever issued.
      const next = rebuilt.appendSignal({ fromAgent: 'gen-01', kind: 'status', body: 'resumed' });
      assert.equal(next.seq, 4);
    } finally {
      rebuilt.close();
    }

    // Idempotent — running it again over a live DB yields the same content.
    const again = rebuildCampaign(root);
    assert.deepEqual(again.written, { ...result.written, signals: 4 });
    const twice = openCampaign({ archiveRoot }, campaignId);
    try {
      const after = snapshot(twice);
      assert.deepEqual(after.tasks, before.tasks);
      assert.deepEqual(after.agents, before.agents);
      assert.deepEqual(after.events, before.events);
      assert.deepEqual(after.signals.slice(0, 3), before.signals);
    } finally {
      twice.close();
    }
  }),
);

test(
  'rebuild refuses a directory that carries no campaign row rather than inventing one',
  withCampaign(({ archive }) => {
    const root = archive.root;
    archive.close();
    fs.rmSync(path.join(root, 'campaign.json'), { force: true });
    assert.throws(() => rebuildCampaign(root), /campaign\.json is missing/);
  }),
);

// ---------------------------------------------------------------------------------------------
// layout and portability, including Windows
// ---------------------------------------------------------------------------------------------

test(
  'the on-disk layout is the one rebuild-from-files depends on, and stored paths are POSIX-relative',
  withCampaign(({ archiveRoot, archive }) => {
    populate(archive);

    const campaignRoot = path.join(archiveRoot, 'campaigns', '2026-08-02-take-hill-4');
    assert.equal(archive.root, campaignRoot);
    for (const file of ['campaign.db', 'campaign.json', 'tasks.jsonl', 'signals.jsonl']) {
      assert.ok(fs.existsSync(path.join(campaignRoot, file)), `${file} missing`);
    }
    for (const file of ['orders.md', 'report.md', 'stream.jsonl', 'diff.patch', 'agent.json']) {
      assert.ok(
        fs.existsSync(path.join(campaignRoot, 'agents', 'cpt-03', file)),
        `agents/cpt-03/${file} missing`,
      );
    }

    // Stored paths never carry a platform separator, so an archive written here still resolves
    // on Windows and vice versa.
    const agent = archive.getAgent('cpt-03');
    assert.equal(agent?.dir, 'agents/cpt-03');
    assert.equal(archive.getTask('task-rate')?.orders_path, 'agents/cpt-03/orders.md');
    assert.ok(!(agent?.dir ?? '').includes('\\'));
    assert.equal(
      resolveInCampaign(campaignRoot, 'agents/cpt-03/orders.md'),
      path.join(campaignRoot, 'agents', 'cpt-03', 'orders.md'),
    );

    assert.deepEqual(listCampaignIds(archiveRoot), ['2026-08-02-take-hill-4']);
  }),
);

test(
  're-recording an agent id is refused with the reason, not with a SQLite constraint',
  withCampaign(({ archive }) => {
    // Run one. Agent ids are minted from 01 by the supervisor, so this is what every run starts
    // with, and a run pointed at an existing campaign starts with it again.
    archive.recordAgentAttempt({
      id: 'cpt-01',
      rank: 'CAPTAIN',
      role: 'ENGINEER',
      harness: 'claude',
      sessionId: 's-1',
      startedAt: '2026-08-02T09:00:00.000Z',
    });

    let thrown: unknown;
    try {
      archive.recordAgentAttempt({
        id: 'cpt-01',
        rank: 'CAPTAIN',
        role: 'ENGINEER',
        harness: 'claude',
        sessionId: 's-2',
      });
      assert.fail('a duplicate agent id was accepted');
    } catch (error) {
      thrown = error;
    }

    // TYPED, so the layer that owes the reader a `fix:` line can recognise the condition without
    // matching on prose that is free to be reworded.
    assert.ok(
      thrown instanceof AgentIdInUseError,
      `not the typed refusal: ${String(thrown)}`,
    );
    assert.equal(thrown.agentId, 'cpt-01');
    assert.equal(thrown.campaignId, '2026-08-02-take-hill-4');
    assert.equal(thrown.startedAt, '2026-08-02T09:00:00.000Z');

    const message = thrown.message;
    // What the reader used to get, and what no reader can act on: the name of a table and a
    // constraint. The whole defect is that this string reached a terminal.
    assert.doesNotMatch(
      message,
      /UNIQUE constraint|agents\.id/,
      `the database error reached the reader:\n${message}`,
    );
    // What they need instead: the id, why it can only ever collide, and the way out.
    assert.match(message, /cpt-01/, 'the colliding id is not named');
    assert.match(message, /minted from 01 on every run/, 'the reason it can never succeed is not given');
    assert.match(message, /no campaign has used yet/, 'the way out is not stated');
    assert.match(message, /Nothing was written/, 'the reader is not told the archive is intact');

    // And it means it: the refusal is a refusal, not a partial write.
    assert.deepEqual(
      archive.listAgents().map((agent) => agent.id),
      ['cpt-01'],
    );
    assert.equal(archive.getAgent('cpt-01')?.session_id, 's-1', 'the first attempt was overwritten');
  }),
);

test(
  'agent ids that collide case-insensitively are refused before the directories can merge',
  withCampaign(({ archive }) => {
    archive.recordAgentAttempt({
      id: 'cpt-03',
      rank: 'CAPTAIN',
      role: 'ENGINEER',
      harness: 'claude',
      sessionId: 's-1',
    });
    // `agents.id` is case-sensitive, but `agents/<id>/` is not on macOS or Windows — the two rows
    // would share one directory and the second agent.json would overwrite the first.
    assert.throws(
      () =>
        archive.recordAgentAttempt({
          id: 'CPT-03',
          rank: 'CAPTAIN',
          role: 'INSPECTOR',
          harness: 'codex',
          sessionId: 's-2',
        }),
      /collides case-insensitively/,
    );
    assert.deepEqual(
      archive.listAgents().map((agent) => agent.id),
      ['cpt-03'],
    );
    // A genuinely different id is of course still fine.
    assert.doesNotThrow(() =>
      archive.recordAgentAttempt({
        id: 'cpt-04',
        rank: 'CAPTAIN',
        role: 'INSPECTOR',
        harness: 'codex',
        sessionId: 's-3',
      }),
    );
  }),
);

test(
  'campaign ids that collide case-insensitively are refused',
  withCampaign(({ archiveRoot, archive }) => {
    archive.close();
    assert.throws(
      () =>
        createCampaign(
          { archiveRoot },
          { id: '2026-08-02-TAKE-HILL-4', project: '/projects/agentic-army', title: 'Take Hill 4' },
        ),
      /collides case-insensitively/,
    );
  }),
);

/**
 * The damage is already done by the time rebuild runs — on a case-insensitive filesystem the two
 * agent directories merged and one `agent.json` overwrote the other, which no reader can undo.
 * What must not happen is rebuild recovering one agent, losing the other, and reporting
 * `skipped.agents = 0`.
 */
test(
  'rebuild counts an agent lost to a case collision instead of reporting zero skips',
  withCampaign(({ archive }) => {
    archive.createTask({ id: 'task-1', title: 'harden auth', status: 'in_flight' });
    archive.recordAgentAttempt({
      id: 'cpt-03',
      taskId: 'task-1',
      rank: 'CAPTAIN',
      role: 'ENGINEER',
      harness: 'claude',
      sessionId: 's-1',
    });
    const root = archive.root;
    const recovered = archive.getAgent('cpt-03') as AgentRow;
    archive.close();

    // Reproduce the post-merge state exactly: the directory keeps the name it was created with,
    // while agent.json now carries the id of the agent that overwrote it.
    fs.writeFileSync(
      path.join(root, 'agents', 'cpt-03', 'agent.json'),
      `${JSON.stringify({ ...recovered, id: 'CPT-03', dir: 'agents/CPT-03' }, null, 2)}\n`,
      'utf8',
    );
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${campaignDbPath(root)}${suffix}`, { force: true });
    }

    const result = rebuildCampaign(root);
    assert.equal(result.written.agents, 1, 'the readable agent must still be recovered');
    assert.equal(result.skipped.agents, 1, 'the overwritten agent must be COUNTED, not vanish');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /case-colliding agent id/);
  }),
);

/**
 * A crash between the `signals.jsonl` append and COMMIT leaves an orphan line whose `seq` the next
 * writer reissues. Last-wins by file order resolves it correctly, but the loser is a row that
 * existed on disk and is not in the index — so it is counted.
 */
test(
  'rebuild counts a duplicate signal seq left behind by a crashed writer',
  withCampaign(({ archive }) => {
    const root = archive.root;
    archive.appendSignal({ fromAgent: 'cpt-03', kind: 'status', body: 'committed' });
    archive.close();

    // The orphan is written FIRST in real life; append a second line reusing seq 1 to stand in
    // for the reissue, and assert the later line is the one that survives.
    const file = signalsJsonlPath(root);
    const orphan = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as SignalRow;
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...orphan, body: 'ORPHAN' })}\n${JSON.stringify(orphan)}\n`,
      'utf8',
    );
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${campaignDbPath(root)}${suffix}`, { force: true });
    }

    const result = rebuildCampaign(root);
    assert.equal(result.written.signals, 1);
    assert.equal(result.skipped.signals, 1, 'the dropped duplicate must be counted');
    assert.match(result.warnings.join('\n'), /duplicate seq 1/);
  }),
);

test(
  'readStream reports damaged lines instead of quietly returning a shorter replay',
  withCampaign(({ archive }) => {
    archive.recordAgentAttempt({
      id: 'cpt-03',
      rank: 'CAPTAIN',
      role: 'ENGINEER',
      harness: 'claude',
      sessionId: 's-1',
    });
    const events = gnarlyEvents();
    archive.appendEvents('cpt-03', events);

    const healthy = archive.readStream('cpt-03');
    assert.equal(healthy.events.length, events.length);
    assert.deepEqual(healthy.damaged, []);

    // Corrupt one line in the middle, and truncate the last one — both real crash shapes.
    const file = streamJsonlPath(archive.root, 'cpt-03');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    lines[2] = '{"type":"tool_use","ts":"2026-08-02T10:00:02.000Z",TRUNCATED';
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    const damagedReplay = archive.readStream('cpt-03');
    assert.equal(damagedReplay.events.length, events.length - 1);
    assert.equal(damagedReplay.damaged.length, 1, 'the unreadable line must be reported');
    const [damage] = damagedReplay.damaged;
    assert.equal(damage?.line, 3, 'the caller needs the line number to go and look');
    assert.ok((damage?.offset ?? -1) > 0);
    assert.ok((damage?.bytes ?? 0) > 0);
    assert.ok((damage?.reason ?? '').length > 0);

    // The surviving events are still exact — damage is isolated, not contagious.
    assert.deepEqual(damagedReplay.events[0], events[0]);
    assert.deepEqual(damagedReplay.events.at(-1), events.at(-1));
  }),
);

// ---------------------------------------------------------------------------------------------
// read-only open — `army view` treats this as a safety property, not a hint
// ---------------------------------------------------------------------------------------------

/** Every file under `dir`, campaign-relative, with its size. */
function listTree(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = fs.statSync(full).size;
    }
  };
  walk(dir);
  return out;
}

/** A campaign with enough shape that ordering guarantees are actually observable. */
function populateForReading(archive: CampaignArchive): void {
  // Titles deliberately NOT in alphabetical order, and ids opaque, so creation order is the only
  // thing that can produce the expected sequence.
  const root = archive.createTask({ id: 'zz-root', title: 'harden auth', status: 'in_flight' });
  archive.createTask({ id: 'mm-child', parentTaskId: root.id, title: 'zebra task' });
  archive.createTask({ id: 'aa-child', parentTaskId: root.id, title: 'alpha task' });
  archive.recordAgentAttempt({
    id: 'cpt-03',
    taskId: 'zz-root',
    rank: 'CAPTAIN',
    role: 'ENGINEER',
    harness: 'claude',
    sessionId: 's-1',
    orders: '# orders\n',
  });
  archive.finishAgent('cpt-03', { status: 'exited', exitCode: 0, costUsd: 1.5, durationMs: 900 });
  archive.recordAgentAttempt({
    id: 'cpt-09',
    taskId: 'zz-root',
    rank: 'CAPTAIN',
    role: 'INSPECTOR',
    harness: 'codex',
    sessionId: 's-2',
  });
  const query = archive.appendSignal({
    fromAgent: 'cpt-03',
    toAgent: 'gen-01',
    kind: 'query',
    body: 'ceiling?',
  });
  archive.appendSignal({
    fromAgent: 'gen-01',
    kind: 'answer',
    inReplyTo: query.seq,
    body: 'rung 2',
  });
  archive.appendSignal({ fromAgent: 'cpt-09', kind: 'query', body: 'unanswered' });
  archive.appendEvents('cpt-03', gnarlyEvents());
  archive.writeReportMd('cpt-03', '# findings\n');
}

test('a read-only open reads everything, with orderings identical to the read-write path', () => {
  const archiveRoot = makeTempRoot();
  try {
    const rw = createCampaign(
      { archiveRoot },
      { id: '2026-08-02-take-hill-4', project: '/p', title: 'Take Hill 4' },
    );
    populateForReading(rw);
    const expected = {
      campaign: rw.getCampaign(),
      tasks: rw.listTasks(),
      children: rw.childTasks('zz-root'),
      roots: rw.childTasks(null),
      agents: rw.listAgents(),
      attempts: rw.agentsForTask('zz-root'),
      signals: rw.listSignals(),
      queries: rw.listSignals({ kind: 'query' }),
      unanswered: rw.unansweredQueries(),
      answers: rw.answersTo(1),
      events: rw.listEvents(),
      agentEvents: rw.listEvents('cpt-03'),
      stream: rw.readStream('cpt-03'),
      tree: rw.tree(),
      ledger: rw.ledger(),
      answered: rw.isAnswered(1),
      task: rw.getTask('aa-child'),
      agent: rw.getAgent('cpt-09'),
      signal: rw.getSignal(2),
    };
    // Creation order, not alphabetical — the property a hand-mirrored ORDER BY would get wrong.
    assert.deepEqual(
      expected.children.map((t) => t.title),
      ['zebra task', 'alpha task'],
    );
    rw.close();

    const ro = openCampaignReadOnly({ archiveRoot }, '2026-08-02-take-hill-4');
    try {
      assert.deepEqual(
        {
          campaign: ro.getCampaign(),
          tasks: ro.listTasks(),
          children: ro.childTasks('zz-root'),
          roots: ro.childTasks(null),
          agents: ro.listAgents(),
          attempts: ro.agentsForTask('zz-root'),
          signals: ro.listSignals(),
          queries: ro.listSignals({ kind: 'query' }),
          unanswered: ro.unansweredQueries(),
          answers: ro.answersTo(1),
          events: ro.listEvents(),
          agentEvents: ro.listEvents('cpt-03'),
          stream: ro.readStream('cpt-03'),
          tree: ro.tree(),
          ledger: ro.ledger(),
          answered: ro.isAnswered(1),
          task: ro.getTask('aa-child'),
          agent: ro.getAgent('cpt-09'),
          signal: ro.getSignal(2),
        },
        expected,
        'the read-only handle must return byte-identical results, including ordering',
      );
      assert.equal(ro.campaignId, '2026-08-02-take-hill-4');
      assert.deepEqual(ro.readReportJson('cpt-03'), undefined);
    } finally {
      ro.close();
    }
  } finally {
    removeTempRoot(archiveRoot);
  }
});

test('a read-only handle rejects every write, at the type, the guard and the driver', () => {
  const archiveRoot = makeTempRoot();
  try {
    const rw = createCampaign(
      { archiveRoot },
      { id: '2026-08-02-take-hill-4', project: '/p', title: 'Take Hill 4' },
    );
    populateForReading(rw);
    rw.close();

    const ro = openCampaignReadOnly({ archiveRoot }, '2026-08-02-take-hill-4');
    // The writers are not on `CampaignReader` at all; reaching them takes a deliberate cast, which
    // is the point. Having cast, every one of them must still refuse.
    const forced = ro as unknown as CampaignArchive;
    try {
      assert.equal(forced.writable, false);

      const writes: [string, () => unknown][] = [
        ['setCampaignStatus', () => forced.setCampaignStatus('done')],
        ['createTask', () => forced.createTask({ title: 'nope' })],
        ['updateTask', () => forced.updateTask('zz-root', { status: 'done' })],
        [
          'recordAgentAttempt',
          () =>
            forced.recordAgentAttempt({
              id: 'cpt-99',
              rank: 'CAPTAIN',
              role: 'ENGINEER',
              harness: 'claude',
              sessionId: 's-9',
            }),
        ],
        ['finishAgent', () => forced.finishAgent('cpt-03', { status: 'failed' })],
        ['setAgentStatus', () => forced.setAgentStatus('cpt-03', 'running')],
        ['appendSignal', () => forced.appendSignal({ fromAgent: 'x', kind: 'status', body: 'no' })],
        ['appendEvent', () => forced.appendEvent('cpt-03', gnarlyEvents()[0] as SoldierEvent)],
        ['appendEvents', () => forced.appendEvents('cpt-03', gnarlyEvents())],
        ['writeOrders', () => forced.writeOrders('cpt-09', 'tampered')],
        [
          'writeReportJson',
          () =>
            forced.writeReportJson('cpt-09', {
              status: 'done',
              summary: 'x',
              findings: [],
              artifacts: [],
            }),
        ],
        ['writeReportMd', () => forced.writeReportMd('cpt-09', 'tampered')],
        ['writeDiff', () => forced.writeDiff('cpt-09', 'tampered')],
      ];
      for (const [name, attempt] of writes) {
        assert.throws(attempt, /opened read-only/, `${name} was NOT refused`);
      }

      // Layer 3: SQLite itself, for anyone who reaches past the guard to the raw handle.
      assert.throws(
        () => forced.db.exec("INSERT INTO signals (ts, from_agent, kind, body) VALUES ('t','x','status','no')"),
        /readonly database/,
      );
      assert.throws(() => forced.db.exec('CREATE TABLE nope (a INTEGER)'), /readonly database/);

      // And nothing the filesystem writers would have created exists.
      assert.equal(fs.existsSync(path.join(ro.root, 'agents', 'cpt-09', 'orders.md')), false);
      assert.equal(fs.existsSync(path.join(ro.root, 'agents', 'cpt-09', 'report.md')), false);
      assert.equal(fs.existsSync(path.join(ro.root, 'agents', 'cpt-09', 'diff.patch')), false);
      assert.equal(ro.listSignals().length, 3);
    } finally {
      ro.close();
    }
  } finally {
    removeTempRoot(archiveRoot);
  }
});

/**
 * The bounded exception, asserted rather than hidden: a read-only open materialises
 * `campaign.db-shm` and `campaign.db-wal` because SQLite needs the shared-memory index to read a
 * WAL database, and a read-only connection may not remove them on close. No DATA is touched.
 */
test('a read-only open creates exactly the two WAL sidecars and changes no data', () => {
  const archiveRoot = makeTempRoot();
  try {
    const rw = createCampaign(
      { archiveRoot },
      { id: '2026-08-02-take-hill-4', project: '/p', title: 'Take Hill 4' },
    );
    populateForReading(rw);
    const root = rw.root;
    rw.close();

    const before = listTree(root);
    // Content, not just size — the whole claim is that no DATA changed.
    const contentBefore = new Map<string, Buffer>(
      Object.keys(before).map((file) => [file, fs.readFileSync(path.join(root, file))]),
    );
    // A clean close checkpoints and removes the sidecars, so they are genuinely absent first.
    assert.equal(Object.hasOwn(before, 'campaign.db-wal'), false);
    assert.equal(Object.hasOwn(before, 'campaign.db-shm'), false);

    const ro = openCampaignReadOnly({ archiveRoot }, '2026-08-02-take-hill-4');
    ro.tree();
    ro.listSignals();
    ro.readStream('cpt-03');
    ro.close();

    const after = listTree(root);
    const added = Object.keys(after).filter((f) => !Object.hasOwn(before, f));
    const removed = Object.keys(before).filter((f) => !Object.hasOwn(after, f));

    assert.deepEqual(added.sort(), ['campaign.db-shm', 'campaign.db-wal'], 'ONLY the two sidecars');
    assert.deepEqual(removed, []);
    assert.equal(after['campaign.db-wal'], 0, 'no WAL frames were ever appended');

    // Every pre-existing file is byte-identical, campaign.db included.
    for (const [file, size] of Object.entries(before)) {
      assert.equal(after[file], size, `${file} changed size`);
      assert.ok(
        (contentBefore.get(file) as Buffer).equals(fs.readFileSync(path.join(root, file))),
        `${file} changed content`,
      );
    }
  } finally {
    removeTempRoot(archiveRoot);
  }
});

test('read-only skips ONLY the behavioural probe; the writer path still runs it', () => {
  const root = makeTempRoot();
  const lie = { recursive_triggers: { recursive_triggers: 1 } };
  const turnItOff = (db: Db): void => db.exec('PRAGMA recursive_triggers=OFF;');
  try {
    // Same lying connection, both modes. The asymmetry IS the proof the probe is writer-only.
    withReporting(
      root,
      'asymmetry',
      lie,
      (db) => {
        assert.throws(() => assertArchivePragmas(db, 'readwrite'), /does not enforce it/);
        assert.doesNotThrow(
          () => assertArchivePragmas(db, 'readonly'),
          'read-only must skip the probe — a reader cannot execute the write it guards',
        );
        // The default must be the SAFE one: forgetting the argument runs more checking, not less.
        assert.throws(() => assertArchivePragmas(db), /does not enforce it/);
      },
      turnItOff,
    );

    // And the declarative checks are NOT skipped read-only.
    withReporting(root, 'ro-no-wal', { journal_mode: { journal_mode: 'delete' } }, (db) => {
      assert.throws(() => assertArchivePragmas(db, 'readonly'), /requires WAL/);
    });
    withReporting(root, 'ro-no-fk', { foreign_keys: { foreign_keys: 0 } }, (db) => {
      assert.throws(() => assertArchivePragmas(db, 'readonly'), /foreign_keys=OFF/);
    });
  } finally {
    removeTempRoot(root);
  }
});

test('a read-only open refuses to invent a campaign or an index', () => {
  const archiveRoot = makeTempRoot();
  try {
    assert.throws(
      () => openCampaignReadOnly({ archiveRoot }, 'nope-not-here'),
      /no such campaign directory/,
    );

    const rw = createCampaign({ archiveRoot }, { id: 'c-1', project: '/p', title: 'c' });
    const root = rw.root;
    rw.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${campaignDbPath(root)}${suffix}`, { force: true });
    }
    assert.throws(() => openCampaignReadOnly({ archiveRoot }, 'c-1'), /no campaign index at/);
    // ...and it did not create one on the way out.
    assert.equal(fs.existsSync(campaignDbPath(root)), false);
  } finally {
    removeTempRoot(archiveRoot);
  }
});

test('ids that would escape the campaign directory are rejected', () => {
  for (const bad of ['..', '../evil', 'a/b', 'a\\b', '', '.hidden', 'con', 'NUL.txt', 'trailing.']) {
    assert.equal(isSafeSegment(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
  for (const good of ['cpt-03', '2026-08-02-take-hill-4', 'a.b_c-1']) {
    assert.equal(isSafeSegment(good), true, `${JSON.stringify(good)} should be accepted`);
  }
  assert.throws(() => resolveInCampaign('/campaign', 'agents/../../etc/passwd'), /escaping path/);
});

test(
  'creating a campaign twice re-attaches instead of destroying it',
  withCampaign(({ archiveRoot, archive }) => {
    archive.appendSignal({ fromAgent: 'gen-01', kind: 'status', body: 'first' });
    archive.close();
    const again = createCampaign(
      { archiveRoot },
      { id: '2026-08-02-take-hill-4', project: '/projects/agentic-army', title: 'Take Hill 4' },
    );
    try {
      assert.equal(again.listSignals().length, 1);
      assert.equal(again.getCampaign().status, 'active');
      assert.deepEqual(again.setCampaignStatus('done', '2026-08-03T00:00:00.000Z').ended_at, '2026-08-03T00:00:00.000Z');
    } finally {
      again.close();
    }
  }),
);

// ===============================================================================================
// THE DURABILITY DISCLOSURE — a printable sentence, and the command in it must be typeable
//
// The note's whole payload is its last clause: the one thing to DO when the newest rows went
// missing. That clause hardcoded `army rebuild`, and it is printed by `campaign` and by
// `rebuild` itself to readers running `node src/cli.ts`, `npx agentic-army` and `npm run dev --`,
// for none of whom `army` is on PATH.
//
// It became a FUNCTION OF THE INVOCATION rather than a constant, and takes it as a parameter
// rather than importing `invokedAs()`: `src/setup/**` sits above `src/archive/**`, and a constant
// cannot call a function anyway. There is no default — a default could only be spelled `army`,
// which is the defect. Do not filter a hostile field, make it unreachable — a caller that forgets
// does not print a broken command, it fails to compile.
// ===============================================================================================

test('the durability note states the trade, and names a rebuild the reader can actually run', () => {
  for (const self of ['army', 'node src/cli.ts', 'npx agentic-army', 'npm run dev --']) {
    const note = archiveDurabilityNote(self);

    // The disclosure itself: all four facts, not merely the reassuring ones.
    assert.match(note, /synchronous=NORMAL/, 'the setting is not named');
    assert.match(note, /WAL/);
    assert.match(note, /power loss/i, 'the case where rows ARE lost is not disclosed');
    assert.match(note, /never corrupted/i, 'the reassurance that IS true is missing');

    // And the actionable clause, in this reader's form.
    assert.ok(note.includes(`\`${self} rebuild\``), `no runnable rebuild for \`${self}\`:\n${note}`);
    assert.match(note, /which are truth/, 'the reason rebuild works is not given');
  }
});

test('the durability note cannot be produced with a hardcoded `army` any more', () => {
  // Capable of failing: restore the constant and `archiveDurabilityNote('node src/cli.ts')`
  // starts containing `army rebuild` again, on every one of these four inputs.
  for (const self of ['node src/cli.ts', 'npx agentic-army', 'npm run dev --']) {
    assert.doesNotMatch(
      archiveDurabilityNote(self),
      /(^|[\s`])army\s+(rebuild|doctor|init|enlist|campaign|view)\b/,
      `a hardcoded \`army …\` survived for self=${JSON.stringify(self)}`,
    );
  }
  // `army` is still the right answer when it IS the right answer.
  assert.match(archiveDurabilityNote('army'), /`army rebuild`/);
});
