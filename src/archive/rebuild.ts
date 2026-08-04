/**
 * `rebuild-from-files`.
 *
 * > **SQLite is the index; files are truth** — a `rebuild-from-files` command must exist from day
 * > one or that seam rots.
 *
 * This is the command that keeps it honest. It reconstructs `campaign.db` from the campaign
 * directory alone and **never opens the existing database** — if it did, a column that only ever
 * lived in SQLite would keep working, nobody would notice, and the claim above would quietly
 * become false. Delete `campaign.db` and run this: whatever comes back is the real content of the
 * archive, and whatever does not was never truth to begin with.
 *
 * ## The gap this had to close
 *
 * The per-agent artefacts are exactly five files — `orders.md`, `report.json`, `report.md`,
 * `stream.jsonl`, `diff.patch` — plus `campaign.db`. None of them carries a `CampaignRow`, a
 * `TaskRow`, an `AgentRow` or a `SignalRow`. A rebuild from that set alone would produce a
 * database containing an `events` table and four empty ones, which is not a rebuild.
 *
 * `archive.ts` therefore also writes, next to them:
 *
 * | File | Truth for | Shape |
 * |---|---|---|
 * | `campaign.json` | `CampaignRow` | one JSON object |
 * | `tasks.jsonl` | `TaskRow` | append-only snapshots, last line per id wins |
 * | `signals.jsonl` | `SignalRow` | append-only, mirrors the append-only table exactly |
 * | `agents/<id>/agent.json` | `AgentRow` | one JSON object |
 *
 * `tasks.jsonl` is a log rather than a document because tasks mutate (status, attempts, rung) and
 * a rewritten document loses its own history; `signals.jsonl` is a log because the bus is one, and
 * a mirror that could be rewritten would not be a mirror of an append-only table.
 *
 * ## Guarantees
 *
 * - **Idempotent.** Running it twice produces the same database, byte-for-byte in content: task
 *   and agent rows are keyed, signal rows keep their original `seq`, and `events.seq` is
 *   regenerated in a deterministic order (agents by `started_at` then id, events in file order).
 * - **Does not require the original DB.** The output is built in a temporary file and moved into
 *   place, so a missing, stale or corrupt `campaign.db` is not an input.
 * - **Tolerant of a crash.** A torn final line in any `.jsonl` is skipped and counted, not fatal.
 *
 * ## A dangling `tasks.agent_id` is a legitimate outcome, not a bug
 *
 * A rebuilt task may name an `agent_id` for which no `agents/<id>/agent.json` exists, and the
 * rebuild will report `warnings: []` — nothing was skipped, because nothing was lost. That is
 * correct: `tasks.jsonl` is truth about tasks, it recorded that this agent was the current
 * attempt, and that fact remains true whether or not the agent's directory survived. Blanking the
 * column would be inventing a different history to make a foreign key look tidy, which is why
 * `tasks.agent_id` deliberately has no FK (see `schema.ts`). Do not "fix" this.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentRow, CampaignRow, SignalRow, TaskRow } from '../contracts/archive.ts';
import type { SoldierEvent } from '../contracts/harness.ts';

import type { Db, DbFactory } from './db.ts';
import { assertArchivePragmas, openDb } from './db.ts';
import { applySchema } from './schema.ts';
import {
  agentDir,
  agentsDir,
  campaignDbPath,
  campaignJsonPath,
  campaignsRoot,
  signalsJsonlPath,
  streamJsonlPath,
  tasksJsonlPath,
  isSafeSegment,
  AGENT_JSON_FILENAME,
} from './paths.ts';

export interface RebuildOptions {
  dbFactory?: DbFactory;
  /**
   * Where to write. Defaults to `<campaignRoot>/campaign.db`, built via a temp file and moved
   * into place. Point it elsewhere to diff a rebuild against a live index without touching it.
   */
  target?: string;
}

export interface RebuildCounts {
  tasks: number;
  agents: number;
  signals: number;
  events: number;
}

export interface RebuildResult {
  campaignId: string;
  campaignRoot: string;
  dbPath: string;
  written: RebuildCounts;
  /**
   * Rows that were present in the files but did NOT make it into the index — a torn write, a row
   * that failed validation, a duplicate `seq`, an agent whose directory was overwritten by a
   * case-colliding sibling.
   *
   * A nonzero count here always has a matching entry in `warnings`. The one outcome this type
   * exists to prevent is losing a row while reporting zero skips.
   */
  skipped: RebuildCounts;
  /** Human-readable detail for everything counted in `skipped`. Empty on a clean rebuild. */
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Reading files as truth
// ---------------------------------------------------------------------------------------------

interface RawLine {
  /** Byte offset of the line's first byte — exactly what `EventRow.offset` means. */
  offset: number;
  text: string;
}

/**
 * Split on LF at the BYTE level, not after decoding, so the offsets handed back are the same ones
 * `archive.ts` recorded when it appended. Decoding first and using string indices would be off by
 * the width of every non-ASCII character in the stream.
 */
function readLines(file: string): RawLine[] {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: RawLine[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) {
      if (i > start) out.push({ offset: start, text: buffer.subarray(start, i).toString('utf8') });
      start = i + 1;
    }
  }
  if (start < buffer.length) {
    // No trailing newline: a write that was cut short. Still offered to the parser — a complete
    // JSON object that merely lost its newline is perfectly good truth.
    out.push({ offset: start, text: buffer.subarray(start).toString('utf8') });
  }
  return out;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readCampaign(campaignRoot: string): CampaignRow {
  const file = campaignJsonPath(campaignRoot);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${file} is missing — a campaign directory without it carries no campaign row, ` +
          'so there is nothing to rebuild from',
      );
    }
    throw error;
  }
  const row = parseObject(text);
  if (row === undefined || typeof row.id !== 'string') {
    throw new Error(`${file} is not a readable CampaignRow`);
  }
  return row as unknown as CampaignRow;
}

/**
 * Last snapshot per id wins; first-seen order is preserved so parents precede their children.
 *
 * A superseded snapshot is NOT a skip — `tasks.jsonl` is a mutation log and every line but the
 * last for an id is expected to be replaced. Only an unreadable line counts.
 */
function readTasks(campaignRoot: string): {
  rows: TaskRow[];
  skipped: number;
  warnings: string[];
} {
  const order: string[] = [];
  const byId = new Map<string, TaskRow>();
  const warnings: string[] = [];
  let skipped = 0;
  for (const line of readLines(tasksJsonlPath(campaignRoot))) {
    const row = parseObject(line.text);
    if (row === undefined || typeof row.id !== 'string') {
      skipped += 1;
      warnings.push(`tasks.jsonl: unusable line at byte ${line.offset}`);
      continue;
    }
    if (!byId.has(row.id)) order.push(row.id);
    byId.set(row.id, row as unknown as TaskRow);
  }
  return { rows: order.map((id) => byId.get(id) as TaskRow), skipped, warnings };
}

/** Deterministic order — `started_at` then id — so `events.seq` is reproducible across rebuilds. */
function readAgents(campaignRoot: string): {
  rows: AgentRow[];
  skipped: number;
  warnings: string[];
} {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir(campaignRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rows: [], skipped: 0, warnings: [] };
    }
    throw error;
  }
  const rows: AgentRow[] = [];
  const warnings: string[] = [];
  const seenLower = new Map<string, string>();
  let skipped = 0;
  for (const entry of entries) {
    // A directory the archive could never have created is not truth about an agent — skip it
    // rather than letting `agentDir`'s path-traversal guard abort the whole rebuild.
    if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;

    // Two directories that differ only in case survive on a case-sensitive filesystem and merge
    // into one the moment the archive is copied to macOS or Windows. Flag it here, where both
    // still exist, because after the merge there is nothing left to notice.
    const lower = entry.name.toLowerCase();
    const twin = seenLower.get(lower);
    if (twin !== undefined) {
      warnings.push(
        `agents/${entry.name} and agents/${twin} differ only by case; this archive would lose ` +
          'one of them if copied to a case-insensitive filesystem',
      );
    } else {
      seenLower.set(lower, entry.name);
    }

    const file = path.join(agentDir(campaignRoot, entry.name), AGENT_JSON_FILENAME);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const row = parseObject(text);
    if (row === undefined || typeof row.id !== 'string') {
      skipped += 1;
      warnings.push(`agents/${entry.name}/${AGENT_JSON_FILENAME} is not a readable AgentRow`);
      continue;
    }

    // THE SMOKING GUN for a case collision that has already happened: on a case-insensitive
    // filesystem `mkdir agents/CPT-03` lands inside the existing `agents/cpt-03`, so the
    // directory keeps the OLD name while agent.json carries the NEW id. Exactly one agent's
    // truth survives, and the count says so — the row we can still read is written, and the one
    // that was overwritten is counted as skipped rather than vanishing at zero.
    if (row.id !== entry.name) {
      skipped += 1;
      warnings.push(
        `agents/${entry.name}/${AGENT_JSON_FILENAME} declares id ${JSON.stringify(row.id)}: the ` +
          'directory was overwritten by a case-colliding agent id and at least one agent row was ' +
          'lost before this rebuild ran',
      );
    }
    rows.push(row as unknown as AgentRow);
  }
  rows.sort((a, b) => (a.started_at === b.started_at ? cmp(a.id, b.id) : cmp(a.started_at, b.started_at)));
  return { rows, skipped, warnings };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `seq` comes from the file, so the bus's total order survives the index being deleted. */
function readSignals(campaignRoot: string): {
  rows: SignalRow[];
  skipped: number;
  warnings: string[];
} {
  const bySeq = new Map<number, SignalRow>();
  const warnings: string[] = [];
  let skipped = 0;
  for (const line of readLines(signalsJsonlPath(campaignRoot))) {
    const row = parseObject(line.text);
    if (row === undefined || typeof row.seq !== 'number' || !Number.isInteger(row.seq)) {
      skipped += 1;
      warnings.push(`signals.jsonl: unusable line at byte ${line.offset}`);
      continue;
    }
    if (bySeq.has(row.seq)) {
      // A crash between the jsonl append and COMMIT leaves an orphan line whose `seq` the next
      // writer then reissues. File order resolves it — the later line is the committed one — but
      // the loser is a row that existed on disk and is not in the index, so it is COUNTED.
      skipped += 1;
      warnings.push(
        `signals.jsonl: duplicate seq ${row.seq} at byte ${line.offset}; keeping the later line ` +
          '(an uncommitted append whose seq was reissued after a crash)',
      );
    }
    bySeq.set(row.seq, row as unknown as SignalRow);
  }
  const rows = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { rows, skipped, warnings };
}

// ---------------------------------------------------------------------------------------------
// Writing the index
// ---------------------------------------------------------------------------------------------

function insertAll(
  db: Db,
  campaign: CampaignRow,
  tasks: readonly TaskRow[],
  agents: readonly AgentRow[],
  signals: readonly SignalRow[],
  campaignRoot: string,
): { written: RebuildCounts; skipped: RebuildCounts; warnings: string[] } {
  const written: RebuildCounts = { tasks: 0, agents: 0, signals: 0, events: 0 };
  const skipped: RebuildCounts = { tasks: 0, agents: 0, signals: 0, events: 0 };
  const warnings: string[] = [];
  const note = (message: string, error: unknown): void => {
    warnings.push(`${message}: ${error instanceof Error ? error.message : String(error)}`);
  };

  db.transaction(() => {
    // The reference graph is not a DAG in insertion order (agents.parent_agent_id can name an
    // agent read later), so validate every foreign key once at COMMIT rather than per statement.
    db.exec('PRAGMA defer_foreign_keys = ON;');

    db.prepare(
      `INSERT INTO campaigns (id, project, title, status, created_at, ended_at, root_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run([
      campaign.id,
      campaign.project,
      campaign.title,
      campaign.status,
      campaign.created_at,
      campaign.ended_at ?? null,
      campaign.root_dir,
    ]);

    const insertTask = db.prepare(
      `INSERT INTO tasks (id, campaign_id, parent_task_id, title, status, agent_id, attempts,
                          orders_path, branch, delivered_rung, pr_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const task of tasks) {
      try {
        insertTask.run([
          task.id,
          campaign.id,
          task.parent_task_id ?? null,
          task.title,
          task.status,
          task.agent_id ?? null,
          task.attempts,
          task.orders_path ?? null,
          task.branch ?? null,
          task.delivered_rung ?? null,
          task.pr_url ?? null,
          task.created_at,
          task.updated_at,
        ]);
        written.tasks += 1;
      } catch (error) {
        skipped.tasks += 1;
        note(`tasks.jsonl: task ${task.id} rejected by the index`, error);
      }
    }

    const insertAgent = db.prepare(
      `INSERT INTO agents (id, campaign_id, task_id, parent_agent_id, rank, role, harness, model,
                           effort, session_id, attempt, depth, status, worktree_path, lease_id,
                           dir, started_at, ended_at, exit_code, cost_usd, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const agent of agents) {
      try {
        insertAgent.run([
          agent.id,
          campaign.id,
          agent.task_id ?? null,
          agent.parent_agent_id ?? null,
          agent.rank,
          agent.role,
          agent.harness,
          agent.model ?? null,
          agent.effort ?? null,
          agent.session_id,
          agent.attempt,
          agent.depth,
          agent.status,
          agent.worktree_path ?? null,
          agent.lease_id ?? null,
          agent.dir,
          agent.started_at,
          agent.ended_at ?? null,
          agent.exit_code ?? null,
          agent.cost_usd ?? null,
          agent.duration_ms ?? null,
        ]);
        written.agents += 1;
      } catch (error) {
        skipped.agents += 1;
        note(`agents/${agent.id}: rejected by the index`, error);
      }
    }

    // Explicit `seq`, so AUTOINCREMENT resumes above the highest one ever issued and the total
    // order is never reused after a rebuild — the one property the signals bus cannot afford to
    // lose.
    const insertSignal = db.prepare(
      `INSERT INTO signals (seq, ts, from_agent, to_agent, to_selector, kind, in_reply_to, body, artifact)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const signal of signals) {
      try {
        insertSignal.run([
          signal.seq,
          signal.ts,
          signal.from_agent,
          signal.to_agent ?? null,
          signal.to_selector ?? null,
          signal.kind,
          signal.in_reply_to ?? null,
          signal.body,
          signal.artifact ?? null,
        ]);
        written.signals += 1;
      } catch (error) {
        skipped.signals += 1;
        note(`signals.jsonl: seq ${signal.seq} rejected by the index`, error);
      }
    }

    const insertEvent = db.prepare(
      `INSERT INTO events (campaign_id, agent_id, ts, type, "offset", parent_tool_use_id, depth, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const agent of agents) {
      for (const line of readLines(streamJsonlPath(campaignRoot, agent.id))) {
        const parsed = parseObject(line.text);
        if (parsed === undefined) {
          skipped.events += 1;
          warnings.push(
            `agents/${agent.id}/stream.jsonl: unusable line at byte ${line.offset}`,
          );
          continue;
        }
        const event = parsed as unknown as SoldierEvent;
        try {
          insertEvent.run([
            campaign.id,
            agent.id,
            event.ts,
            event.type,
            line.offset,
            event.parentToolUseId ?? null,
            event.depth,
            // The line VERBATIM, so `payload` is byte-identical to what the live writer stored
            // and a replay from the index equals a replay from the file.
            line.text,
          ]);
          written.events += 1;
        } catch (error) {
          skipped.events += 1;
          note(`agents/${agent.id}/stream.jsonl: line at byte ${line.offset} rejected`, error);
        }
      }
    }
  });

  return { written, skipped, warnings };
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Rebuild one campaign's index from its directory.
 *
 * The existing `campaign.db` is never read — only replaced.
 */
export function rebuildCampaign(campaignRoot: string, options: RebuildOptions = {}): RebuildResult {
  const campaign = readCampaign(campaignRoot);
  const tasks = readTasks(campaignRoot);
  const agents = readAgents(campaignRoot);
  const signals = readSignals(campaignRoot);

  const finalPath = options.target ?? campaignDbPath(campaignRoot);
  const tempPath = `${finalPath}.rebuild-${process.pid}-${Date.now()}.tmp`;
  unlinkQuiet(tempPath);
  unlinkQuiet(`${tempPath}-wal`);
  unlinkQuiet(`${tempPath}-shm`);

  const factory = options.dbFactory ?? openDb;
  const db = factory(tempPath);
  let counts: { written: RebuildCounts; skipped: RebuildCounts; warnings: string[] };
  try {
    // Same guard as `openIndex`: rebuild inserts explicit `seq` values, so it is the single most
    // likely place for a future `INSERT OR REPLACE` to appear. If a swapped driver has lost
    // `recursive_triggers`, that edit would silently destroy audit rows — fail here instead.
    assertArchivePragmas(db);
    applySchema(db);
    counts = insertAll(db, campaign, tasks.rows, agents.rows, signals.rows, campaignRoot);
  } catch (error) {
    // Closing checkpoints and removes the temp `-wal`/`-shm`, so the move below is a single file.
    db.close();
    unlinkQuiet(tempPath);
    unlinkQuiet(`${tempPath}-wal`);
    unlinkQuiet(`${tempPath}-shm`);
    // A half-built index is worse than none: the existing one is left exactly as it was.
    throw error;
  }
  db.close();

  // Stale sidecars of the OLD database must go before the new one takes its name; SQLite keys a
  // WAL to its database by salt, and leaving one next to a replaced file is asking for trouble on
  // the platform with the least forgiving file locking (Windows, which is untested).
  unlinkQuiet(`${finalPath}-wal`);
  unlinkQuiet(`${finalPath}-shm`);
  fs.renameSync(tempPath, finalPath);

  return {
    campaignId: campaign.id,
    campaignRoot,
    dbPath: finalPath,
    written: counts.written,
    skipped: {
      tasks: counts.skipped.tasks + tasks.skipped,
      agents: counts.skipped.agents + agents.skipped,
      signals: counts.skipped.signals + signals.skipped,
      events: counts.skipped.events,
    },
    warnings: [
      ...tasks.warnings,
      ...agents.warnings,
      ...signals.warnings,
      ...counts.warnings,
    ],
  };
}

/** Rebuild every campaign under an archive root. */
export function rebuildArchive(archiveRoot: string, options: RebuildOptions = {}): RebuildResult[] {
  const root = campaignsRoot(archiveRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const results: RebuildResult[] = [];
  for (const entry of entries.sort((a, b) => cmp(a.name, b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(campaignJsonPath(dir))) continue;
    results.push(rebuildCampaign(dir, options));
  }
  return results;
}
