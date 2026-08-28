/**
 * `army view`.
 *
 * `node:test` + `node:assert/strict`, zero dependencies, every filesystem case in its own temp
 * directory.
 *
 * The headline is **`view writes absolutely nothing`**. It builds a real archive through the
 * `src/archive` API, fingerprints every file in the campaign directory — size, mtime and a SHA-256
 * of the bytes, including `campaign.db` and its `-wal`/`-shm` sidecars — renders the campaign
 * through both sources, and asserts the fingerprint is identical. It then proves the seam that
 * makes it hold, by showing the database handle the view opens rejects an INSERT outright. That
 * test is capable of failing: swap `openReadOnlyDb` for the archive's normal factory and the WAL
 * pragma alone changes `campaign.db`'s bytes.
 *
 * Everything else is a pure function over a hand-built fixture, which is the point of keeping
 * `tree.ts` and `render.ts` free of the filesystem, the clock and the environment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentRow, CampaignRow, SignalRow, TaskRow } from '../src/contracts/archive.ts';
import type { SoldierEvent } from '../src/contracts/harness.ts';
import type { Rank, Role } from '../src/contracts/ranks.ts';
import { RANK_GLYPH } from '../src/contracts/ranks.ts';

import { createCampaign } from '../src/archive/archive.ts';
import { campaignDbPath, campaignDir, campaignJsonPath, streamJsonlPath } from '../src/archive/paths.ts';

import type {
  CampaignSnapshot,
  StateSource,
  StreamDigest,
  TreeModel,
  UnitNode,
  UnitState,
} from '../src/view/tree.ts';
import {
  DEFAULT_PRESUMED_DEAD_AFTER_MS,
  STATE_SOURCES,
  buildTree,
  computeUnitState,
  digestStream,
  walkTree,
} from '../src/view/tree.ts';
import {
  ASCII_GLYPHS,
  UNICODE_GLYPHS,
  asciiFold,
  chooseColumns,
  clipTo,
  displayWidth,
  formatAge,
  formatDuration,
  padTo,
  renderJson,
  renderTree,
} from '../src/view/render.ts';
import { describeToolUse, formatToolAction } from '../src/view/activity.ts';
import {
  createProgressSink,
  dispositionOf,
  formatTokens,
  renderProgressEvent,
  sanitize,
} from '../src/view/progress.ts';
import type { ProgressEvent } from '../src/view/progress.ts';
import {
  REPO_UNKNOWN,
  describeRepo,
  formatElapsed,
  formatRepo,
  renderHeader,
  renderRoster,
  renderStatusBar,
} from '../src/view/chrome.ts';
import type { HeaderModel, RepoState, RosterUnit, StatusModel } from '../src/view/chrome.ts';
import {
  createJsonlReader,
  followCampaign,
  listCampaigns,
  openCampaignReader,
  openReadOnlyDb,
} from '../src/view/live.ts';
import type { ViewDeps } from '../src/view/index.ts';
import { detectCharset, detectColor, detectWidth, parseViewArgs, runView } from '../src/view/index.ts';
import { unrunnableReason } from '../src/setup/fixes.ts';

// ---------------------------------------------------------------------------------------------
// Fixtures — hand-built rows, no database required
// ---------------------------------------------------------------------------------------------

const T0 = Date.parse('2026-08-02T09:00:00.000Z');
/** The injected "now". Ten minutes into the campaign, always. */
const NOW = T0 + 600_000;

function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

function campaignRow(over: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: '2026-08-02-take-hill-4',
    project: '/projects/take-hill-4',
    title: 'Take Hill 4',
    status: 'active',
    created_at: at(0),
    ended_at: null,
    root_dir: '/archive/campaigns/2026-08-02-take-hill-4',
    ...over,
  };
}

function taskRow(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    campaign_id: '2026-08-02-take-hill-4',
    parent_task_id: null,
    title: id,
    status: 'queued',
    agent_id: null,
    attempts: 0,
    orders_path: null,
    branch: null,
    delivered_rung: null,
    pr_url: null,
    created_at: at(1),
    updated_at: at(1),
    ...over,
  };
}

function agentRow(id: string, rank: Rank, depth: number, over: Partial<AgentRow> = {}): AgentRow {
  return {
    id,
    campaign_id: '2026-08-02-take-hill-4',
    task_id: null,
    parent_agent_id: null,
    rank,
    role: 'ENGINEER' as Role,
    harness: 'claude',
    model: 'claude-sonnet-5',
    effort: 'xhigh',
    session_id: `session-${id}`,
    attempt: 1,
    depth,
    status: 'running',
    worktree_path: null,
    lease_id: null,
    dir: `agents/${id}`,
    started_at: at(10),
    ended_at: null,
    exit_code: null,
    cost_usd: null,
    duration_ms: null,
    ...over,
  };
}

function event(type: SoldierEvent['type'], seconds: number, extra: Record<string, unknown> = {}): SoldierEvent {
  return {
    ts: at(seconds),
    raw: { stub: true },
    parentToolUseId: null,
    depth: 0,
    type,
    ...extra,
  } as unknown as SoldierEvent;
}

function snapshot(over: Partial<CampaignSnapshot> = {}): CampaignSnapshot {
  return { campaign: campaignRow(), tasks: [], agents: [], ...over };
}

function model(over: Partial<CampaignSnapshot> = {}): TreeModel {
  return buildTree(snapshot(over), { now: NOW });
}

function unitFor(built: TreeModel, agentId: string): UnitNode {
  const found = walkTree(built).find(
    (row) => row.node.kind === 'unit' && row.node.agentId === agentId,
  );
  assert.ok(found !== undefined, `no unit ${agentId} in the tree`);
  return found.node as UnitNode;
}

// ---------------------------------------------------------------------------------------------
// rank and spawn depth are SEPARATE columns, and the gap between them is diagnostic
// ---------------------------------------------------------------------------------------------

test('a Captain at depth 1 is normal: a General may detach one directly', () => {
  const built = model({ agents: [agentRow('cpt-03', 'CAPTAIN', 1)] });
  const unit = unitFor(built, 'cpt-03');

  assert.equal(unit.depth, 1, 'depth comes off the row and is never derived from rank');
  assert.equal(unit.rankSeniority, 2);
  assert.equal(unit.rankDepthGap, -1);
  assert.equal(unit.gapAnomalous, false);
  assert.deepEqual(built.summary.anomalies, []);
});

test('a Captain at depth 4 is an anomaly: the chain outran its ranks', () => {
  const built = model({ agents: [agentRow('cpt-09', 'CAPTAIN', 4)] });
  const unit = unitFor(built, 'cpt-09');

  assert.equal(unit.rankDepthGap, 2);
  assert.equal(unit.gapAnomalous, true);
  assert.equal(built.summary.anomalies.length, 1);
  assert.equal(built.summary.anomalies[0]?.kind, 'rank-depth-gap');
  assert.equal(built.summary.anomalies[0]?.subject, 'cpt-09');
  assert.match(built.summary.anomalies[0]?.message ?? '', /depth 4 \(\+2\)/);
});

test('a ceremonial GEN>COL>CPT>SGT>PVT chain has a gap of 0 at every level', () => {
  const chain: [string, Rank, number][] = [
    ['gen-01', 'GENERAL', 0],
    ['col-01', 'COLONEL', 1],
    ['cpt-01', 'CAPTAIN', 2],
    ['sgt-01', 'SERGEANT', 3],
    ['pvt-01', 'PRIVATE', 4],
  ];
  const built = model({ agents: chain.map(([id, rank, depth]) => agentRow(id, rank, depth)) });
  for (const [id] of chain) {
    assert.equal(unitFor(built, id).rankDepthGap, 0, `${id} should sit at gap 0`);
  }
  assert.deepEqual(built.summary.anomalies, []);
});

test('the gap is rendered so the reader never has to subtract', () => {
  const built = model({ agents: [agentRow('cpt-01', 'CAPTAIN', 1), agentRow('cpt-09', 'CAPTAIN', 4)] });
  const text = renderTree(built, { width: 120, charset: 'ascii' });
  const normal = lineFor(text, 'cpt-01');
  const anomalous = lineFor(text, 'cpt-09');

  assert.match(normal, /\bCPT\b/);
  assert.match(normal, /\s1\s+-1\s/, 'depth 1 and gap -1 sit in their own columns');
  assert.ok(!normal.includes('!'), 'a negative gap is legal and must not be flagged');
  assert.match(anomalous, /\s4\s+\+2!\s/, 'depth 4, gap +2, flagged');
});

test('when the terminal is too narrow for a gap column the marker moves onto depth', () => {
  const built = model({ agents: [agentRow('cpt-09', 'CAPTAIN', 4)] });
  const narrow = renderTree(built, { width: 38, charset: 'ascii' });
  assert.deepEqual(chooseColumns(38), ['rank', 'depth', 'state']);
  // The label column is too narrow to hold the agent id here, so the assertion is on the row's
  // cells: rank, then depth carrying the marker the dropped GAP column would have shown.
  assert.match(narrow, /\sCPT\s+4!\s+unknown/, 'the anomaly survives the column being dropped');
});

test('rank and depth are never the same column: an anomalous unit still reports its true rank', () => {
  const built = model({ agents: [agentRow('cpt-09', 'CAPTAIN', 4)] });
  const unit = unitFor(built, 'cpt-09');
  assert.equal(unit.rank, 'CAPTAIN');
  assert.equal(unit.depth, 4);
  assert.notEqual(unit.rank, 'PRIVATE', 'depth 4 must never be allowed to imply a rank');
});

/**
 * The row for one unit, not merely a line mentioning it: an agent id also shows up in its task's
 * "current attempt" cell and in the anomaly footer, and a naive substring search finds those first.
 * Unit labels always end `<bullet> <agentId>`, which the task cell never does.
 */
function unitLine(text: string, agentId: string): string {
  const line = text.split('\n').find((candidate) => candidate.includes(`· ${agentId}`));
  assert.ok(line !== undefined, `no unit row for ${agentId}:\n${text}`);
  return line;
}

function lineFor(text: string, needle: string): string {
  const line = text.split('\n').find((candidate) => candidate.includes(needle));
  assert.ok(line !== undefined, `no line mentioning ${needle}:\n${text}`);
  return line;
}

// ---------------------------------------------------------------------------------------------
// tasks and agents are different things — an agent is a process, a task is intent
// ---------------------------------------------------------------------------------------------

test('a QUEUED task with no agent at all is a row, not an omission', () => {
  const built = model({ tasks: [taskRow('rotate-secrets', { title: 'rotate secrets' })] });
  const rows = walkTree(built);

  assert.equal(rows.length, 1);
  const node = rows[0]?.node;
  assert.equal(node?.kind, 'task');
  assert.equal(node?.kind === 'task' ? node.status : '', 'queued');
  assert.equal(node?.kind === 'task' ? node.neverAttempted : false, true);
  assert.equal(built.summary.queuedTasks, 1);

  const text = renderTree(built, { width: 100, charset: 'ascii' });
  assert.match(text, /rotate secrets/);
  assert.match(lineFor(text, 'rotate secrets'), /queued/);
  assert.match(lineFor(text, 'rotate secrets'), /no agent yet/);
});

test('a task with two attempts by different agents shows both, oldest first', () => {
  const built = model({
    tasks: [taskRow('rate-limiter', { status: 'in_flight', agent_id: 'cpt-07', attempts: 2 })],
    agents: [
      agentRow('cpt-03', 'CAPTAIN', 1, {
        task_id: 'rate-limiter',
        attempt: 1,
        status: 'failed',
        ended_at: at(300),
        exit_code: 1,
      }),
      agentRow('cpt-07', 'CAPTAIN', 1, { task_id: 'rate-limiter', attempt: 2, model: 'claude-opus-5' }),
    ],
  });

  const task = built.tasks[0];
  assert.equal(task?.units.length, 2, 'both attempts survive into the model');
  assert.deepEqual(
    task?.units.map((unit) => unit.agentId),
    ['cpt-03', 'cpt-07'],
  );
  assert.equal(task?.currentAgentId, 'cpt-07');

  const text = renderTree(built, { width: 120, charset: 'unicode' });
  assert.match(text, /#1 · cpt-03/, 'the failed first attempt keeps its own row');
  assert.match(text, /#2 · cpt-07/, 'the retry must not replace it');
  assert.match(text, /dead/);
  assert.match(text, /2 attempts/, 'and the task says how many there have been');
});

test('nested tasks keep the task spine even when a unit names a parent on another task', () => {
  const built = model({
    tasks: [
      taskRow('harden-auth', { status: 'in_flight' }),
      taskRow('rate-limiter', { parent_task_id: 'harden-auth', status: 'in_flight' }),
    ],
    agents: [
      agentRow('gen-01', 'GENERAL', 0),
      // Spawned BY the General, but working on its own task: the task owns the row.
      agentRow('cpt-03', 'CAPTAIN', 1, { task_id: 'rate-limiter', parent_agent_id: 'gen-01' }),
      // Spawned inside cpt-03's attempt, on the same task: genuinely nested.
      agentRow('sgt-11', 'SERGEANT', 2, {
        task_id: 'rate-limiter',
        parent_agent_id: 'cpt-03',
        attempt: 2,
      }),
    ],
  });

  assert.deepEqual(built.unattached.map((unit) => unit.agentId), ['gen-01']);
  assert.equal(built.unattached[0]?.children.length, 0, 'the Captain is not yanked under the General');
  const rate = built.tasks[0]?.children[0];
  assert.deepEqual(rate?.units.map((unit) => unit.agentId), ['cpt-03']);
  assert.deepEqual(rate?.units[0]?.children.map((unit) => unit.agentId), ['sgt-11']);
});

// ---------------------------------------------------------------------------------------------
// state is COMPUTED from the signal log, never stored, and always carries its source
// ---------------------------------------------------------------------------------------------

function stateOf(
  agent: AgentRow,
  events: readonly SoldierEvent[] | undefined,
  over: { truncatedTail?: boolean } = {},
): { state: UnitState; source: StateSource; detail: string } {
  const digest: StreamDigest | undefined =
    events === undefined ? undefined : digestStream(agent.id, events, over);
  const verdict = computeUnitState(agent, digest, NOW);
  return { state: verdict.state, source: verdict.source, detail: verdict.detail };
}

test('busy — an unmatched tool_use is open', () => {
  const verdict = stateOf(agentRow('cpt-07', 'CAPTAIN', 1), [
    event('ready', 1, { sessionId: 's', capabilities: [] }),
    event('tool_use', 595, { name: 'Bash', toolUseId: 'tu-1' }),
  ]);
  assert.equal(verdict.state, 'busy');
  assert.equal(verdict.source, 'stream:open-tool');
  assert.equal(verdict.detail, 'Bash open');
});

test('busy — a matched tool plus a recent event', () => {
  const verdict = stateOf(agentRow('cpt-07', 'CAPTAIN', 1), [
    event('tool_use', 590, { name: 'Bash', toolUseId: 'tu-1' }),
    event('tool_result', 592, { toolUseId: 'tu-1', isError: false }),
    event('assistant_text', 594, { text: 'still going' }),
  ]);
  assert.equal(verdict.state, 'busy');
  assert.equal(verdict.source, 'stream:recent-activity');
});

test('idle — the turn finished and nothing is in flight', () => {
  const verdict = stateOf(agentRow('cpt-07', 'CAPTAIN', 1), [
    event('assistant_text', 500, { text: 'done' }),
    event('result', 560, { status: 'ok' }),
  ]);
  assert.equal(verdict.state, 'idle');
  assert.equal(verdict.source, 'stream:turn-complete');
  assert.equal(verdict.detail, 'turn ok');
});

test('idle — quiet, but not yet stale', () => {
  const verdict = stateOf(agentRow('cpt-07', 'CAPTAIN', 1), [
    event('assistant_text', 480, { text: 'thinking' }),
  ]);
  assert.equal(verdict.state, 'idle');
  assert.equal(verdict.source, 'stream:quiet');
});

test('unknown — there is no stream.jsonl to compute from', () => {
  const verdict = stateOf(agentRow('cpt-09', 'CAPTAIN', 4), undefined);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.source, 'stream:missing');
});

test('unknown — spawning, with the stream still empty', () => {
  const verdict = stateOf(agentRow('cpt-09', 'CAPTAIN', 1, { status: 'spawning' }), []);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.source, 'agent-row:spawning');
});

test('unknown — the stream exists but has no events, and the row is not spawning', () => {
  const verdict = stateOf(agentRow('cpt-09', 'CAPTAIN', 1, { status: 'running' }), []);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.source, 'stream:empty');
});

test('unknown — silence past --stale-after is never dressed up as idle', () => {
  const verdict = stateOf(agentRow('cpt-07', 'CAPTAIN', 1), [
    // Twelve minutes before `NOW`, i.e. past the 10-minute default staleness window.
    event('tool_use', -120, { name: 'Bash', toolUseId: 'tu-1' }),
  ]);
  assert.equal(verdict.state, 'unknown', 'an open tool and twelve minutes of silence proves nothing');
  assert.equal(verdict.source, 'stream:stale');
  assert.match(verdict.detail, /Bash open/, 'the open tool is still reported, just not believed');
});

test('unknown — a last event with an unusable timestamp', () => {
  const verdict = stateOf(agentRow('cpt-07', 'CAPTAIN', 1), [
    { ...event('assistant_text', 1, { text: 'x' }), ts: 'not-a-time' } as SoldierEvent,
  ]);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.source, 'stream:bad-timestamp');
});

test('dead — the index recorded a terminal disposition', () => {
  const cases: [AgentRow['status'], StateSource][] = [
    ['failed', 'agent-row:failed'],
    ['interrupted', 'agent-row:interrupted'],
    ['exited', 'agent-row:exited'],
  ];
  for (const [status, source] of cases) {
    const verdict = stateOf(
      agentRow('cpt-03', 'CAPTAIN', 1, { status, ended_at: at(300), exit_code: 1 }),
      [event('assistant_text', 595, { text: 'still chatty' })],
    );
    assert.equal(verdict.state, 'dead', `${status} must be dead`);
    assert.equal(verdict.source, source);
    assert.equal(verdict.detail, `${terminalWord(status)}, exit 1`);
  }
});

function terminalWord(status: AgentRow['status']): string {
  return status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'exited';
}

test('dead — an end time was recorded even though the status was never moved', () => {
  const verdict = stateOf(agentRow('cpt-03', 'CAPTAIN', 1, { status: 'running', ended_at: at(300) }), []);
  assert.equal(verdict.state, 'dead');
  assert.equal(verdict.source, 'agent-row:ended-at');
});

test('dead — the log ends in an error while the index still says running', () => {
  const verdict = stateOf(agentRow('cpt-03', 'CAPTAIN', 1, { status: 'running' }), [
    event('error', 580, { message: 'stream closed unexpectedly' }),
  ]);
  assert.equal(verdict.state, 'dead');
  assert.equal(verdict.source, 'stream:error');
  assert.equal(verdict.detail, 'stream closed unexpectedly');
});

test('every declared state source is reachable, and none is invented', () => {
  const produced = new Set<StateSource>();
  const record = (agent: AgentRow, events: readonly SoldierEvent[] | undefined): void => {
    produced.add(stateOf(agent, events).source);
  };
  record(agentRow('a', 'CAPTAIN', 1, { status: 'failed' }), []);
  record(agentRow('a', 'CAPTAIN', 1, { status: 'interrupted' }), []);
  record(agentRow('a', 'CAPTAIN', 1, { status: 'exited' }), []);
  record(agentRow('a', 'CAPTAIN', 1, { status: 'running', ended_at: at(1) }), []);
  record(agentRow('a', 'CAPTAIN', 1, { status: 'spawning' }), []);
  record(agentRow('a', 'CAPTAIN', 1), [event('error', 590, { message: 'x' })]);
  record(agentRow('a', 'CAPTAIN', 1), undefined);
  record(agentRow('a', 'CAPTAIN', 1), []);
  record(agentRow('a', 'CAPTAIN', 1), [{ ...event('result', 1, { status: 'ok' }), ts: 'x' } as SoldierEvent]);
  record(agentRow('a', 'CAPTAIN', 1), [event('tool_use', -120, { name: 'B', toolUseId: 't' })]);
  record(agentRow('a', 'CAPTAIN', 1), [event('tool_use', 595, { name: 'B', toolUseId: 't' })]);
  record(agentRow('a', 'CAPTAIN', 1), [event('assistant_text', 595, { text: 'x' })]);
  record(agentRow('a', 'CAPTAIN', 1), [event('result', 560, { status: 'ok' })]);
  record(agentRow('a', 'CAPTAIN', 1), [event('assistant_text', 480, { text: 'x' })]);

  assert.deepEqual([...produced].sort(), [...STATE_SOURCES].sort());
});

test('a result event clears open tools so a finished turn is not reported as phantom work', () => {
  const digest = digestStream('cpt-07', [
    event('tool_use', 100, { name: 'Bash', toolUseId: 'tu-1' }),
    event('result', 101, { status: 'ok' }),
  ]);
  assert.deepEqual(digest.openTools, []);
});

test('the digest reconstructs the native-subagent layer from parent_tool_use_id', () => {
  const digest = digestStream('cpt-07', [
    event('tool_use', 100, { name: 'Agent', toolUseId: 'tu-1' }),
    { ...event('subagent_text', 101, { text: 'scouting' }), parentToolUseId: 'tu-1', depth: 1 } as SoldierEvent,
    { ...event('subagent_text', 102, { text: 'deeper' }), parentToolUseId: 'tu-2', depth: 2 } as SoldierEvent,
  ]);
  assert.equal(digest.maxDepth, 2);
  assert.equal(digest.subagents, 2);
});

// ---------------------------------------------------------------------------------------------
// Rendering — charset, colour, width, JSON
// ---------------------------------------------------------------------------------------------

function demoModel(): TreeModel {
  return buildTree(
    {
      campaign: campaignRow(),
      tasks: [
        taskRow('harden-auth', { title: 'harden auth', status: 'in_flight' }),
        taskRow('rotate-secrets', { title: 'rotate secrets', parent_task_id: 'harden-auth' }),
      ],
      agents: [
        agentRow('gen-01', 'GENERAL', 0),
        agentRow('cpt-03', 'CAPTAIN', 1, { task_id: 'harden-auth', parent_agent_id: 'gen-01' }),
        agentRow('sgt-11', 'SERGEANT', 3, { task_id: 'harden-auth', parent_agent_id: 'cpt-03', attempt: 2 }),
        agentRow('pvt-02', 'PRIVATE', 4, { task_id: 'harden-auth', parent_agent_id: 'sgt-11', attempt: 3 }),
      ],
      streams: {
        'cpt-03': digestStream('cpt-03', [event('tool_use', 595, { name: 'Bash', toolUseId: 'tu-1' })]),
      },
    },
    { now: NOW },
  );
}

test('unicode output uses the rank glyphs', () => {
  const text = renderTree(demoModel(), { width: 120, charset: 'unicode' });
  for (const rank of ['GENERAL', 'CAPTAIN', 'SERGEANT', 'PRIVATE'] as Rank[]) {
    assert.ok(text.includes(RANK_GLYPH[rank]), `expected the ${rank} glyph ${RANK_GLYPH[rank]}`);
  }
  assert.ok(text.includes('│') && text.includes('├') && text.includes('└'), 'box drawing');
});

test('the ASCII fallback emits nothing a codepage-437 console cannot draw', () => {
  const text = renderTree(demoModel(), { width: 120, charset: 'ascii' });
  const offending = [...text].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return char !== '\n' && (code < 0x20 || code > 0x7e);
  });
  assert.deepEqual(offending, [], `non-ASCII survived the fallback: ${JSON.stringify(offending)}`);
  for (const rank of ['GENERAL', 'CAPTAIN', 'SERGEANT', 'PRIVATE'] as Rank[]) {
    assert.ok(text.includes(ASCII_GLYPHS.ranks[rank]), `expected the ASCII ${rank} glyph`);
  }
});

test('asciiFold transliterates decoration and refuses to pass unknown bytes through', () => {
  assert.equal(asciiFold('CPT·ENGINEER'), 'CPT.ENGINEER');
  assert.equal(asciiFold('a→b'), 'a->b');
  assert.equal(asciiFold('☆◆◇▪'), '*#o+');
  assert.equal(asciiFold('naïve 🙂'), 'na?ve ?', 'user text is folded too — that is where surprises live');
});

test('colour appears only when asked for, and NO_COLOR always wins', () => {
  const plain = renderTree(demoModel(), { width: 120, color: false });
  const coloured = renderTree(demoModel(), { width: 120, color: true });
  assert.ok(!plain.includes('['), 'no escapes without colour');
  assert.ok(coloured.includes('['), 'escapes when colour is on');

  assert.equal(detectColor({ NO_COLOR: '1' }, true), false);
  assert.equal(detectColor({ NO_COLOR: '1', FORCE_COLOR: '3' }, true), false, 'NO_COLOR outranks FORCE_COLOR');
  assert.equal(detectColor({ FORCE_COLOR: '1' }, false), true);
  assert.equal(detectColor({ FORCE_COLOR: '0' }, true), true, 'FORCE_COLOR=0 is not a request for colour, but a TTY is');
  assert.equal(detectColor({}, true), true);
  assert.equal(detectColor({}, false), false, 'a pipe gets no colour');
  assert.equal(detectColor({ TERM: 'dumb' }, true), false);
});

test('charset detection defends the default Windows console and respects the locale', () => {
  assert.equal(detectCharset({}, true, 'win32'), 'ascii', 'cmd.exe at codepage 437 cannot draw the glyphs');
  assert.equal(detectCharset({ WT_SESSION: 'x' }, true, 'win32'), 'unicode');
  assert.equal(detectCharset({ TERM_PROGRAM: 'vscode' }, true, 'win32'), 'unicode');
  assert.equal(detectCharset({}, true, 'darwin'), 'unicode');
  assert.equal(detectCharset({ LANG: 'C' }, true, 'linux'), 'ascii');
  assert.equal(detectCharset({ LANG: 'en_US.UTF-8' }, true, 'linux'), 'unicode');
  assert.equal(detectCharset({ TERM: 'dumb' }, true, 'linux'), 'ascii');
  assert.equal(detectCharset({}, false, 'linux'), 'unicode', 'a pipe to a UTF-8 file is fine');
});

test('narrow terminals drop columns in priority order and never wrap a row', () => {
  assert.deepEqual(chooseColumns(200), ['rank', 'depth', 'gap', 'state', 'why', 'doing', 'when']);
  assert.deepEqual(chooseColumns(80), ['rank', 'depth', 'gap', 'state', 'why', 'when']);
  assert.deepEqual(chooseColumns(52), ['rank', 'depth', 'gap', 'state', 'when']);
  assert.deepEqual(chooseColumns(43), ['rank', 'depth', 'gap', 'state']);
  assert.deepEqual(chooseColumns(20), ['rank', 'depth', 'state'], 'rank/depth/state are never dropped');

  const built = demoModel();
  const wide = renderTree(built, { width: 120, charset: 'ascii' }).split('\n').length;
  for (const width of [120, 100, 80, 60, 45, 38]) {
    const text = renderTree(built, { width, charset: 'ascii' });
    assert.equal(text.split('\n').length, wide, `width ${width} changed the line count — that is wrapping`);
    for (const line of text.split('\n')) {
      assert.ok(line.length <= Math.max(width, 38), `width ${width}: line overflowed: ${line}`);
    }
  }
});

test('relative times are deterministic, driven only by the injected clock', () => {
  assert.equal(formatAge(null), '');
  assert.equal(formatAge(0), 'now');
  assert.equal(formatAge(12_000), '12s ago');
  assert.equal(formatAge(125_000), '2m ago');
  assert.equal(formatAge(3 * 3_600_000), '3h ago');
  assert.equal(formatAge(4 * 86_400_000), '4d ago');
  assert.equal(formatAge(-5_000), 'in 5s');

  // Same rows, two different clocks: the only thing that changes is the age.
  const rows = { agents: [agentRow('cpt-03', 'CAPTAIN', 1)], streams: { 'cpt-03': digestStream('cpt-03', [event('result', 60, { status: 'ok' })]) } };
  const early = buildTree(snapshot(rows), { now: T0 + 120_000 });
  const late = buildTree(snapshot(rows), { now: T0 + 300_000 });
  assert.equal(unitFor(early, 'cpt-03').state.ageMs, 60_000);
  assert.equal(unitFor(late, 'cpt-03').state.ageMs, 240_000);
  assert.match(lineFor(renderTree(early, { width: 120, charset: 'ascii' }), 'cpt-03'), /1m ago/);
  assert.match(lineFor(renderTree(late, { width: 120, charset: 'ascii' }), 'cpt-03'), /4m ago/);
  assert.equal(early.generatedAt, new Date(T0 + 120_000).toISOString());
});

test('--json is undecorated, parseable and stable in shape', () => {
  const built = demoModel();
  const text = renderJson(built);
  assert.ok(!text.includes('['), 'no ANSI');
  assert.ok(text.endsWith('\n'));
  const parsed = JSON.parse(text) as TreeModel;

  assert.equal(parsed.v, 1);
  assert.deepEqual(Object.keys(parsed).sort(), ['campaign', 'generatedAt', 'source', 'summary', 'tasks', 'unattached', 'v']);
  assert.deepEqual(Object.keys(parsed.summary).sort(), [
    'anomalies',
    'byState',
    'depthMax',
    'depthMaxObserved',
    'depthMin',
    'openQueries',
    'queuedTasks',
    'ranks',
    'tasks',
    'units',
  ]);
  const unit = parsed.unattached[0] as UnitNode;
  assert.deepEqual(Object.keys(unit.state).sort(), ['ageMs', 'detail', 'since', 'source', 'state']);
  assert.equal(parsed.generatedAt, new Date(NOW).toISOString(), 'reproducible from the injected clock');
  assert.deepEqual(renderJson(demoModel()), text, 'the same input renders the same bytes');
});

test('unanswered queries are computed from the log, not stored', () => {
  const signals: SignalRow[] = [
    { seq: 1, ts: at(1), from_agent: 'cpt-03', to_agent: 'gen-01', to_selector: null, kind: 'query', in_reply_to: null, body: 'raise the ceiling?', artifact: null },
    { seq: 2, ts: at(2), from_agent: 'cpt-03', to_agent: 'gen-01', to_selector: null, kind: 'query', in_reply_to: null, body: 'again?', artifact: null },
    { seq: 3, ts: at(3), from_agent: 'gen-01', to_agent: 'cpt-03', to_selector: null, kind: 'answer', in_reply_to: 1, body: 'no', artifact: null },
  ];
  assert.equal(model({ signals }).summary.openQueries, 1);
});

/**
 * The blind spot is admitted where the rows are READ, not only where they are written.
 *
 * `src/command/campaign.ts` already carries this, on `recordDenials`, and `test/command.test.ts`
 * pins it there. That is the writing end. This is the reading end, and it is the end that
 * matters: nobody forms a belief about a campaign by looking at the function that appended a
 * row. They look at `army view`, see a summary with no warning in it, and conclude the ceiling
 * held. An empty denial log does not support that conclusion, so the file that builds the
 * summary has to say so.
 *
 * Pinned by claim rather than by wording — each pattern is one thing a reader must not be able
 * to lose, and a rewrite that drops any of them is a rewrite that quietly restores the
 * misreading.
 */
test('the view says what an empty denial log does and does not prove', () => {
  const source = fs.readFileSync(new URL('../src/view/tree.ts', import.meta.url), 'utf8');
  const at = source.indexOf('function countOpenQueries(');
  assert.ok(at > 0, 'countOpenQueries has moved; this guard is pointing at nothing');

  // The signal-reading section of the view, not the whole file: a sentence somewhere else must
  // not satisfy a claim that has to sit beside the code doing the reading.
  const head = source.lastIndexOf('// ------', at);
  assert.ok(head > 0 && at - head < 4000, 'the section header above countOpenQueries was not found');
  const section = source.slice(head, at);

  for (const [what, pattern] of [
    ['names the shape the refusal actually arrives in', /is_error/],
    ['names where it arrives', /tool_result/],
    ['names the array the row does come from', /permission_denials/],
    ['says which depth is blind', /depth >= 1/],
    ['says what an absent row DOES prove', /missing its allow-list/],
    ['says what it does not prove', /does NOT prove that nothing was refused/],
    ['refuses the clean-bill-of-health reading', /clean bill of health/i],
    ['points at the evidence that does survive', /stream\.jsonl/],
  ] as const) {
    assert.match(section, pattern, `the signal-reading section of src/view/tree.ts no longer ${what}`);
  }
});

// ---------------------------------------------------------------------------------------------
// The JSONL tail — a torn final line is waited on, never parsed as garbage
// ---------------------------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'army-view-'));
}

test('a half-written final line is held, and consumed once the rest lands', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'stream.jsonl');
    fs.writeFileSync(file, '{"type":"ready","ts":"t1"}\n{"type":"tool_use","ts":"t2"');
    const reader = createJsonlReader(file);

    const first = reader.read(false);
    assert.equal(first.records.length, 1, 'only the complete line is a record');
    assert.equal(first.truncatedTail, true, 'the torn line is reported, not parsed');
    assert.equal(first.malformed, 0, 'a torn line is not a malformed one');

    // …the writer finishes the record.
    fs.appendFileSync(file, ',"name":"Bash"}\n');
    const second = reader.read(false);
    assert.equal(second.truncatedTail, false);
    assert.deepEqual(second.records, [{ type: 'tool_use', ts: 't2', name: 'Bash' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a complete final record that merely lost its newline is recovered on a final read', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'stream.jsonl');
    fs.writeFileSync(file, '{"type":"ready","ts":"t1"}\n{"type":"result","ts":"t2"}');
    assert.equal(createJsonlReader(file).read(false).records.length, 1, 'a live tail waits');
    const final = createJsonlReader(file).read(true);
    assert.equal(final.records.length, 2, 'a one-shot read keeps a whole record that lost its terminator');
    assert.equal(final.truncatedTail, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed complete line is counted, never turned into a row', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'stream.jsonl');
    fs.writeFileSync(file, '{"type":"ready","ts":"t1"}\nnot json at all\n{"type":"result","ts":"t3"}\n');
    const batch = createJsonlReader(file).read(true);
    assert.equal(batch.records.length, 2);
    assert.equal(batch.malformed, 1);
    const digest = digestStream('a', batch.records as SoldierEvent[], { malformed: batch.malformed });
    assert.equal(digest.events, 2, 'the garbage never became an event');
    assert.equal(digest.malformed, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a line that is valid JSON but not an event is skipped rather than rendered', () => {
  const digest = digestStream('a', [42, null, { nope: true }] as unknown as SoldierEvent[]);
  assert.equal(digest.events, 0);
  assert.equal(digest.malformed, 3);
  assert.equal(digest.lastType, null);
});

test('the tail restarts cleanly when the file is truncated or replaced', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'stream.jsonl');
    fs.writeFileSync(file, '{"type":"ready","ts":"t1"}\n{"type":"result","ts":"t2"}\n');
    const reader = createJsonlReader(file);
    assert.equal(reader.read(false).records.length, 2);
    fs.writeFileSync(file, '{"type":"ready","ts":"t9"}\n');
    const after = reader.read(false);
    assert.deepEqual(after.records, [{ type: 'ready', ts: 't9' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file is missing, not empty', () => {
  const dir = tempDir();
  try {
    const batch = createJsonlReader(path.join(dir, 'nope.jsonl')).read(true);
    assert.equal(batch.missing, true);
    assert.deepEqual(batch.records, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// A real archive
// ---------------------------------------------------------------------------------------------

const CAMPAIGN_ID = '2026-08-02-take-hill-4';

/**
 * Built through the real `src/archive` API — never by hand-writing a database — so the read-only
 * assertions below are made against a file layout the supervisor actually produces.
 */
function buildFixtureArchive(archiveRoot: string): string {
  let tick = 0;
  const archive = createCampaign(
    { archiveRoot, now: () => at(tick++) },
    { id: CAMPAIGN_ID, project: '/projects/take-hill-4', title: 'Take Hill 4', createdAt: at(0) },
  );

  archive.recordAgentAttempt({
    id: 'gen-01', rank: 'GENERAL', role: 'ENGINEER', harness: 'claude',
    sessionId: 's-gen', depth: 0, status: 'idle', startedAt: at(1),
  });
  archive.appendEvents('gen-01', [
    event('ready', 2, { sessionId: 's-gen', capabilities: ['interrupt_receipt_v1'] }),
    event('result', 4, { status: 'ok' }),
  ]);

  const auth = archive.createTask({ id: 'harden-auth', title: 'harden auth', status: 'in_flight' });
  const rate = archive.createTask({ id: 'rate-limiter', parentTaskId: auth.id, title: 'add rate limiter', status: 'in_flight' });

  archive.recordAgentAttempt({
    id: 'cpt-03', taskId: rate.id, parentAgentId: 'gen-01', rank: 'CAPTAIN', role: 'ENGINEER',
    harness: 'claude', sessionId: 's-3', depth: 1, startedAt: at(10),
    orders: '# Orders\nAdd a rate limiter.\n',
  });
  archive.appendEvents('cpt-03', [event('ready', 11, { sessionId: 's-3', capabilities: [] })]);
  archive.finishAgent('cpt-03', { status: 'failed', endedAt: at(300), exitCode: 1 });

  archive.recordAgentAttempt({
    id: 'cpt-07', taskId: rate.id, parentAgentId: 'gen-01', rank: 'CAPTAIN', role: 'ENGINEER',
    harness: 'claude', sessionId: 's-7', depth: 1, status: 'running', startedAt: at(320),
  });
  archive.appendEvents('cpt-07', [
    event('ready', 321, { sessionId: 's-7', capabilities: [] }),
    event('tool_use', 590, { name: 'Bash', toolUseId: 'tu-9' }),
  ]);

  // Queued work: a task no process has ever touched.
  archive.createTask({ id: 'rotate-secrets', parentTaskId: auth.id, title: 'rotate secrets' });

  // The anomaly: a Captain four levels deep. Deliberately given no stream at all.
  const deep = archive.createTask({ id: 'chase-flake', parentTaskId: rate.id, title: 'chase the flaky test', status: 'in_flight' });
  archive.recordAgentAttempt({
    id: 'cpt-09', taskId: deep.id, parentAgentId: 'cpt-07', rank: 'CAPTAIN', role: 'ENGINEER',
    harness: 'claude', sessionId: 's-9', depth: 4, status: 'running', startedAt: at(500),
  });

  archive.appendSignal({ fromAgent: 'cpt-07', toAgent: 'gen-01', kind: 'query', body: 'raise the ceiling?', ts: at(595) });
  archive.close();

  // A half-written record on a live stream — exactly what a tail sees mid-append.
  fs.appendFileSync(streamJsonlPath(campaignDir(archiveRoot, CAMPAIGN_ID), 'cpt-07'), '{"ts":"x","type":"assistant_te');

  return campaignDir(archiveRoot, CAMPAIGN_ID);
}

interface Fingerprint {
  [relativePath: string]: string;
}

/** Size, mtime and a hash of the bytes for every file under `dir`. */
function fingerprint(dir: string): Fingerprint {
  const out: Fingerprint = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = fs.statSync(full);
      const hash = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      out[path.relative(dir, full)] = `${stat.size}:${stat.mtimeMs}:${hash}`;
    }
  };
  walk(dir);
  return out;
}

function collect(): { stream: { write(text: string): void; isTTY: boolean; columns: number }; text(): string } {
  let buffer = '';
  return {
    stream: {
      write(text: string): void {
        buffer += text;
      },
      isTTY: false,
      columns: 110,
    },
    text: () => buffer,
  };
}

const NOW_DATE = (): Date => new Date(NOW);
const CLEAN_ENV = { LANG: 'en_US.UTF-8' };

test('THE SAFETY PROPERTY: rendering a real archive writes nothing at all', async () => {
  const archiveRoot = tempDir();
  try {
    const campaignRootDir = buildFixtureArchive(archiveRoot);
    const before = fingerprint(campaignRootDir);
    const dbBefore = fs.readFileSync(campaignDbPath(campaignRootDir));
    assert.ok(Object.keys(before).includes('campaign.db'), 'the fixture really has an index to protect');

    for (const source of ['files', 'db'] as const) {
      const out = collect();
      const code = await runView(['--archive', archiveRoot, CAMPAIGN_ID, '--source', source, '--unicode'], {
        stdout: out.stream,
        stderr: out.stream,
        now: NOW_DATE,
        env: CLEAN_ENV,
        homeDir: archiveRoot,
      });
      assert.equal(code, 0, `--source ${source} failed: ${out.text()}`);
      assert.match(out.text(), /Take Hill 4/);

      const after = fingerprint(campaignRootDir);

      // Nothing that already existed may have changed — size, mtime or a single byte.
      for (const [file, stamp] of Object.entries(before)) {
        assert.equal(after[file], stamp, `--source ${source} modified ${file}`);
      }
      assert.deepEqual(
        fs.readFileSync(campaignDbPath(campaignRootDir)),
        dbBefore,
        `--source ${source} modified campaign.db`,
      );

      // And nothing new may appear, with ONE bounded exception, asserted rather than waved at:
      // opening a WAL database at all — even read-only — makes SQLite materialise its
      // shared-memory index, and a read-only connection cannot clean it up on close. That is why
      // `files` is the DEFAULT source: it is the path with no exception to state.
      const added = Object.keys(after).filter((file) => before[file] === undefined);
      if (source === 'files') {
        assert.deepEqual(added, [], 'the default source must not create a single file');
      } else {
        assert.deepEqual(added.sort(), ['campaign.db-shm', 'campaign.db-wal']);
        assert.equal(fs.statSync(path.join(campaignRootDir, 'campaign.db-wal')).size, 0,
          'the WAL is empty: a reader appends no frames');
      }
    }
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('the seam is real: the database handle the view opens rejects writes', () => {
  const archiveRoot = tempDir();
  try {
    const campaignRootDir = buildFixtureArchive(archiveRoot);
    const db = openReadOnlyDb(campaignDbPath(campaignRootDir));
    try {
      // Reading is fine…
      const row = db.prepare('SELECT count(*) AS n FROM agents').get<{ n: number }>();
      assert.equal(row?.n, 4);
      // …and writing is refused by SQLite itself, not by a convention in this codebase.
      assert.throws(
        () => db.exec("INSERT INTO signals (ts, from_agent, kind, body) VALUES ('t','x','status','y')"),
        /readonly/i,
      );
      assert.throws(() => db.exec('DELETE FROM agents'), /readonly/i);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('files and the index tell the same story — SQLite is only the index', () => {
  const archiveRoot = tempDir();
  try {
    buildFixtureArchive(archiveRoot);
    const build = (source: 'files' | 'db'): TreeModel => {
      const reader = openCampaignReader({ archiveRoot, campaignId: CAMPAIGN_ID, source, self: SELF });
      try {
        return buildTree(reader.read(true), { now: NOW });
      } finally {
        reader.close();
      }
    };
    const fromFiles = build('files');
    const fromDb = build('db');
    assert.equal(fromDb.source, 'db');
    assert.deepEqual({ ...fromFiles, source: 'db' }, fromDb, 'the two sources must not drift');
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('the view still works days later with campaign.db deleted — files are truth', async () => {
  const archiveRoot = tempDir();
  try {
    const campaignRootDir = buildFixtureArchive(archiveRoot);
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${campaignDbPath(campaignRootDir)}${suffix}`, { force: true });
    }
    const out = collect();
    const code = await runView(['--archive', archiveRoot, '--ascii'], {
      stdout: out.stream,
      stderr: out.stream,
      now: NOW_DATE,
      env: CLEAN_ENV,
      homeDir: archiveRoot,
    });
    assert.equal(code, 0, out.text());
    assert.match(out.text(), /rotate secrets/, 'the queued task survives without an index');
    assert.match(out.text(), /cpt-09/);
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('the real archive renders the whole story: queued work, retries, depth and a torn tail', async () => {
  const archiveRoot = tempDir();
  try {
    buildFixtureArchive(archiveRoot);
    const out = collect();
    const code = await runView(['--archive', archiveRoot, CAMPAIGN_ID, '--unicode', '--width', '120'], {
      stdout: out.stream,
      stderr: out.stream,
      now: NOW_DATE,
      env: CLEAN_ENV,
      homeDir: archiveRoot,
    });
    assert.equal(code, 0, out.text());
    const text = out.text();

    assert.match(lineFor(text, 'rotate secrets'), /queued/, 'unstarted work is visible');
    assert.match(unitLine(text, 'cpt-03'), /CPT\s+1\s+-1\s+dead\s+agent-row:failed/);
    assert.match(unitLine(text, 'cpt-07'), /CPT\s+1\s+-1\s+busy\s+stream:open-tool/);
    assert.match(unitLine(text, 'cpt-09'), /CPT\s+4\s+\+2!\s+unknown\s+stream:missing/);
    assert.match(text, /partially written record/, 'the torn tail is reported, not swallowed');
    assert.match(text, /1 unanswered query/);
    assert.match(text, /read-only/);
    assert.ok(!text.includes('['), 'a pipe gets no colour');
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('--json against a real archive is parseable and carries the anomaly', async () => {
  const archiveRoot = tempDir();
  try {
    buildFixtureArchive(archiveRoot);
    const out = collect();
    const code = await runView(['--archive', archiveRoot, CAMPAIGN_ID, '--json'], {
      stdout: out.stream,
      stderr: out.stream,
      now: NOW_DATE,
      env: { ...CLEAN_ENV, FORCE_COLOR: '3' },
      homeDir: archiveRoot,
    });
    assert.equal(code, 0, out.text());
    assert.ok(!out.text().includes('['), '--json is never decorated, even under FORCE_COLOR');

    const parsed = JSON.parse(out.text()) as TreeModel;
    assert.equal(parsed.v, 1);
    assert.equal(parsed.campaign.id, CAMPAIGN_ID);
    assert.equal(parsed.summary.queuedTasks, 1);
    assert.equal(parsed.summary.depthMax, 4);
    assert.deepEqual(parsed.summary.ranks, ['GENERAL', 'CAPTAIN']);
    assert.deepEqual(
      parsed.summary.anomalies.map((anomaly) => anomaly.kind).sort(),
      ['rank-depth-gap', 'torn-stream'],
    );
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('--list names the campaigns and writes nothing', async () => {
  const archiveRoot = tempDir();
  try {
    const campaignRootDir = buildFixtureArchive(archiveRoot);
    const before = fingerprint(campaignRootDir);
    const out = collect();
    const code = await runView(['--archive', archiveRoot, '--list'], {
      stdout: out.stream,
      stderr: out.stream,
      now: NOW_DATE,
      env: CLEAN_ENV,
      homeDir: archiveRoot,
    });
    assert.equal(code, 0);
    assert.match(out.text(), new RegExp(CAMPAIGN_ID));
    assert.deepEqual(listCampaigns(archiveRoot).map((c) => c.id), [CAMPAIGN_ID]);
    assert.deepEqual(fingerprint(campaignRootDir), before);
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

// F11: rows were `<id>  <status>  <title>` with the id unpadded, so the status and title columns
// started wherever each id happened to end. `listCampaigns` only reads `campaign.json`, so the
// rows are written by hand here — that is also the only way to hold an empty title still, which
// is the case that leaves padding as trailing whitespace.
test('--list pads by the widest id, and no row carries trailing whitespace', async () => {
  const archiveRoot = tempDir();
  const rows: Array<{ id: string; title: string; status: string; created_at: string }> = [
    { id: 'campaign-with-a-much-longer-id', title: 'Take Hill 4', status: 'running', created_at: '2026-08-06T00:00:00Z' },
    { id: 'c-1', title: 'Short one', status: 'done', created_at: '2026-08-05T00:00:00Z' },
    { id: 'c-2', title: '', status: 'done', created_at: '2026-08-04T00:00:00Z' },
  ];
  try {
    for (const row of rows) {
      const dir = path.join(archiveRoot, 'campaigns', row.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ ...row, project: '/p' }), 'utf8');
    }
    const out = collect();
    const code = await runView(['--archive', archiveRoot, '--list'], {
      stdout: out.stream,
      stderr: out.stream,
      now: NOW_DATE,
      env: CLEAN_ENV,
      homeDir: archiveRoot,
    });
    assert.equal(code, 0, out.text());
    const printed = out.text().split('\n').filter((line) => line !== '');
    assert.equal(printed.length, 3, out.text());

    for (const line of printed) {
      assert.equal(line, line.trimEnd(), `trailing whitespace on ${JSON.stringify(line)}`);
    }

    const width = Math.max(...rows.map((r) => r.id.length));
    const long = printed.find((l) => l.startsWith('campaign-with-a-much-longer-id'));
    const short = printed.find((l) => l.startsWith('c-1'));
    assert.ok(long !== undefined && short !== undefined, out.text());
    // The status column starts at the same offset on every row: widest id + two-space gutter.
    assert.equal(short.slice(0, width).trimEnd(), 'c-1', `id field is not padded:\n${out.text()}`);
    assert.equal(short.slice(width, width + 2), '  ');
    // And the titles land in one column too, which is the visible symptom the finding named.
    assert.equal(long.indexOf('Take Hill 4'), short.indexOf('Short one'), `misaligned:\n${out.text()}`);
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Follow mode
// ---------------------------------------------------------------------------------------------

test('follow mode polls, redraws only on change, and writes nothing', async () => {
  const archiveRoot = tempDir();
  try {
    const campaignRootDir = buildFixtureArchive(archiveRoot);
    const before = fingerprint(campaignRootDir);
    const reader = openCampaignReader({ archiveRoot, campaignId: CAMPAIGN_ID, self: SELF });
    const frames: string[] = [];
    let sleeps = 0;

    await followCampaign({
      reader,
      self: SELF,
      frame: (snap) => renderTree(buildTree(snap, { now: NOW }), { width: 100, charset: 'ascii' }),
      write: (text) => frames.push(text),
      maxFrames: 3,
      intervalMs: 50,
      sleep: async () => {
        sleeps += 1;
        // Between polls a new event lands, exactly as it would in flight.
        if (sleeps === 1) {
          fs.appendFileSync(
            streamJsonlPath(campaignRootDir, 'cpt-07'),
            `st","text":"back"}\n${JSON.stringify(event('result', 596, { status: 'ok' }))}\n`,
          );
        }
      },
    });

    assert.equal(sleeps, 2, 'three frames means two waits');
    assert.equal(frames.length, 2, 'the unchanged third frame is not repainted');
    assert.match(frames[0] ?? '', /busy/);
    assert.match(frames[1] ?? '', /idle/, 'the new result event moved the unit to idle');
    reader.close();

    // The appended line is the writer's doing, so compare everything except that stream.
    const after = fingerprint(campaignRootDir);
    const stream = path.relative(campaignRootDir, streamJsonlPath(campaignRootDir, 'cpt-07'));
    delete after[stream];
    const expected = { ...before };
    delete expected[stream];
    assert.deepEqual(after, expected, 'follow mode modified the archive');
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('follow mode stops when its signal aborts', async () => {
  const archiveRoot = tempDir();
  try {
    buildFixtureArchive(archiveRoot);
    const reader = openCampaignReader({ archiveRoot, campaignId: CAMPAIGN_ID, self: SELF });
    const controller = new AbortController();
    let frames = 0;
    await followCampaign({
      reader,
      self: SELF,
      frame: () => `frame\n`,
      write: () => {
        frames += 1;
      },
      intervalMs: 1,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });
    assert.equal(frames, 1, 'one frame, then the abort ends the loop');
    reader.close();
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('a read failure inside follow mode is a frame, not a crash', async () => {
  const archiveRoot = tempDir();
  try {
    buildFixtureArchive(archiveRoot);
    const reader = openCampaignReader({ archiveRoot, campaignId: CAMPAIGN_ID, self: SELF });
    const frames: string[] = [];
    await followCampaign({
      reader,
      self: SELF,
      frame: () => {
        throw new Error('archive vanished mid-poll');
      },
      write: (text) => frames.push(text),
      maxFrames: 1,
      sleep: async () => undefined,
    });
    assert.match(frames[0] ?? '', /archive vanished mid-poll/);
    reader.close();
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------------------------

test('argument parsing covers the documented surface and rejects the rest', () => {
  const parsed = parseViewArgs(['my-campaign', '--json', '-f', '--interval', '250', '--ascii', '--no-color', '--width', '99', '--source', 'db']);
  assert.equal(parsed.campaignId, 'my-campaign');
  assert.equal(parsed.json, true);
  assert.equal(parsed.follow, true);
  assert.equal(parsed.intervalMs, 250);
  assert.equal(parsed.charset, 'ascii');
  assert.equal(parsed.color, false);
  assert.equal(parsed.width, 99);
  assert.equal(parsed.source, 'db');

  assert.throws(() => parseViewArgs(['--nope']), /unknown option/);
  assert.throws(() => parseViewArgs(['--source', 'sqlite']), /files or db/);
  assert.throws(() => parseViewArgs(['a', 'b']), /unexpected argument/);
  assert.throws(() => parseViewArgs(['--width', 'wide']), /non-negative number/);
});

test('detectWidth prefers the real terminal, then COLUMNS, then 80', () => {
  assert.equal(detectWidth({}, { write: () => undefined, columns: 132 }), 132);
  assert.equal(detectWidth({ COLUMNS: '73' }, { write: () => undefined }), 73);
  assert.equal(detectWidth({}, undefined), 80);
});

test('--help explains that rank and depth are separate, and exits 0 without touching an archive', async () => {
  const out = collect();
  const code = await runView(['--help'], { stdout: out.stream, stderr: out.stream, env: CLEAN_ENV, homeDir: '/nonexistent' });
  assert.equal(code, 0);
  assert.match(out.text(), /RANK AND DEPTH ARE SEPARATE COLUMNS/);
  assert.match(out.text(), /STATE IS COMPUTED, NEVER STORED/);
  assert.match(out.text(), /read-only/i);
});

test('an empty archive is an error message, not a stack trace', async () => {
  const dir = tempDir();
  try {
    const out = collect();
    const code = await runView(['--archive', dir], { stdout: out.stream, stderr: out.stream, env: CLEAN_ENV, homeDir: dir });
    assert.equal(code, 1);
    assert.match(out.text(), /no campaigns found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown campaign id is an error message, not a stack trace', async () => {
  const archiveRoot = tempDir();
  try {
    buildFixtureArchive(archiveRoot);
    const out = collect();
    const code = await runView(['--archive', archiveRoot, 'no-such-campaign'], {
      stdout: out.stream,
      stderr: out.stream,
      env: CLEAN_ENV,
      homeDir: archiveRoot,
    });
    assert.equal(code, 1);
    assert.match(out.text(), /no such campaign directory/);
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

// ===============================================================================================
// EVERY REFUSAL SAYS WHAT TO DO, IN A FORM THIS READER CAN TYPE
//
// Two questions, and the second is the one that keeps getting skipped:
//
//   1. Does it say what to do?
//   2. Would the command it prints actually work here?
//
// `view` failed both. All five error paths printed a diagnosis and no next step, and all five
// prefixed themselves `army view:` — the command that does not exist for anyone running
// `node src/cli.ts`, `npx agentic-army` or `npm run dev --`.
//
// `SELF` is INJECTED rather than read from `invokedAs()`. An assertion against `invokedAs()`'s
// own output cannot fail: it agrees with whatever the function produced, on any machine, which
// is exactly the shape of guard that let this ship four times.
// ===============================================================================================

const SELF = 'node src/cli.ts';

/** The `fix:` / `no fix:` lines an error screen emitted, without their indent. */
function fixLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('fix: ') || l.startsWith('no fix: '));
}

async function refusal(argv: string[], deps: Partial<ViewDeps> = {}): Promise<{ code: number; text: string }> {
  const out = collect();
  const code = await runView(argv, {
    stdout: out.stream,
    stderr: out.stream,
    env: CLEAN_ENV,
    self: SELF,
    ...deps,
  });
  return { code, text: out.text() };
}

test('every way `view` can refuse names a next step, and never a command this reader lacks', async () => {
  const archiveRoot = tempDir();
  const empty = tempDir();
  try {
    buildFixtureArchive(archiveRoot);

    const refusals = [
      // 1. no campaigns anywhere
      await refusal(['--archive', empty], { homeDir: empty }),
      // 2. an id that is not in this archive — the headline case
      await refusal(['--archive', archiveRoot, 'no-such-campaign'], { homeDir: archiveRoot }),
      // 3. an id that is not in an archive with nothing in it either
      await refusal(['--archive', empty, 'no-such-campaign'], { homeDir: empty }),
    ];

    for (const { code, text } of refusals) {
      assert.equal(code, 1, `expected a refusal, got:\n${text}`);
      assert.equal(fixLines(text).length, 1, `a refusal with no fix line, or several:\n${text}`);
      // It reports itself as the form the reader used…
      assert.match(text, /^node src\/cli\.ts view: /m, `reported as something else:\n${text}`);
      // …and never as the one they may not have.
      assert.doesNotMatch(
        text,
        /(^|[\s`])army (view|campaign|enlist|rebuild|doctor|init)\b/m,
        `a hardcoded \`army …\` survived:\n${text}`,
      );
    }
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// F8: view's unknown-option refusal printed a `fix:` line while campaign, trial, chat and
// rebuild all print `Try \`… --help\`.` — one CLI, two grammars for the same mistake. Usage
// errors now speak the majority form; the fix: contract stays for the refusals that diagnose
// a real condition.
test('a usage error routes to `view --help` in the shared Try-form', async () => {
  const { code, text } = await refusal(['--nope']);
  assert.equal(code, 1);
  assert.match(text, /^node src\/cli\.ts view: unknown option --nope$/m);
  assert.match(text, /Try `node src\/cli\.ts view --help`\./);
  assert.equal(fixLines(text).length, 0, `usage errors use the Try-form, not a fix: line:\n${text}`);
});

test('a wrong campaign id answers with the ids that DO exist', async () => {
  const archiveRoot = tempDir();
  try {
    buildFixtureArchive(archiveRoot);
    const { code, text } = await refusal(['--archive', archiveRoot, 'no-such-campaign'], {
      homeDir: archiveRoot,
    });
    assert.equal(code, 1);
    assert.match(text, /no such campaign directory/, 'the diagnosis is still there');
    // The whole point. The reader mistyped an id; the archive is holding the answer, and the
    // old message — a complete, useless diagnosis — did not print it.
    assert.ok(text.includes(CAMPAIGN_ID), `the campaigns that exist were not listed:\n${text}`);
    assert.ok(text.includes('Take Hill 4'), `the id was listed without its title:\n${text}`);
    assert.deepEqual(fixLines(text), [`fix: ${SELF} view ${CAMPAIGN_ID}`]);
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('a long archive points at --list rather than paging the terminal', async () => {
  const archiveRoot = tempDir();
  try {
    for (let i = 0; i < 12; i++) {
      createCampaign({ archiveRoot }, { id: `c-${i}`, project: '/p', title: `campaign ${i}` }).close();
    }
    const { text } = await refusal(['--archive', archiveRoot, 'no-such-campaign'], {
      homeDir: archiveRoot,
    });
    assert.match(text, /12 campaigns are in this archive/);
    assert.deepEqual(fixLines(text), [`fix: ${SELF} view --list`]);
    assert.doesNotMatch(text, /campaign 7/, 'twelve titles were pasted into an error message');
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('an empty archive is told WHY it is empty, from the config itself', async () => {
  const home = tempDir();
  try {
    // No `--archive`: this is the pre-init path a checkout user is standing on, where the
    // interesting fact is not "no campaigns" but "there is no archive yet".
    const { code, text } = await refusal([], { homeDir: home, env: { ...CLEAN_ENV } });
    assert.equal(code, 1);
    assert.match(text, /no campaigns found/);
    assert.match(text, /config\.toml does not exist yet/, `the reason was swallowed:\n${text}`);
    // Routed through the seam `src/config/load.ts` grew for exactly this, since it cannot ask
    // `invokedAs()` itself without inverting the layering.
    assert.match(text, new RegExp(`run \`${SELF.replace(/[/.]/g, '\\$&')} init\``));
    // NOT offered as the fix: `init` creates the archive, it does not create a campaign, so the
    // condition would survive the fix. That is the `mkdir -p "<file>"` mistake in another shirt.
    assert.deepEqual(fixLines(text).length, 1);
    assert.doesNotMatch(fixLines(text)[0] as string, /^fix: \S+ \S+ init$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test(
  'THE FIX CONTRACT: a `fix:` that is a command is run through a shell and clears the condition',
  { skip: process.platform === 'win32' ? 'the emitted fixes are POSIX shell commands' : false },
  async () => {
    // `test/doctor.test.ts` established this: a fix that satisfies every static assertion and
    // fails with `File exists` the moment anyone types it is worse than no fix at all. So the
    // ones that CLAIM to be commands are executed, against the same archive, and the condition
    // is re-checked. `self` is the real `node src/cli.ts`, run from the real repo root.
    const archiveRoot = tempDir();
    try {
      buildFixtureArchive(archiveRoot);
      const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

      const { text } = await refusal(['--archive', archiveRoot, 'no-such-campaign'], {
        homeDir: archiveRoot,
      });
      const fix = (fixLines(text)[0] as string).slice('fix: '.length);

      // Static screen first — the same one `src/setup/fixes.ts` exports, so there is one
      // definition of "not a command" rather than a second copy here.
      assert.equal(unrunnableReason(fix), null, `emitted an unrunnable fix: ${fix}`);

      const res = spawnSync('/bin/sh', ['-c', fix], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, AGENTIC_ARMY_HOME: archiveRoot, NODE_OPTIONS: '' },
      });
      assert.equal(res.status, 0, `the fix did not run: ${res.stderr}`);
      // Ran, and the thing the reader was trying to do now happens.
      assert.match(res.stdout, /Take Hill 4/, `the fix ran but showed nothing: ${res.stdout}`);
      assert.doesNotMatch(res.stderr, /no such campaign/);
    } finally {
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    }
  },
);

test('`view --help` USAGE is a line the reader can paste', async () => {
  const out = collect();
  const code = await runView(['--help'], {
    stdout: out.stream,
    stderr: out.stream,
    env: CLEAN_ENV,
    homeDir: '/nonexistent',
    self: SELF,
  });
  assert.equal(code, 0);
  const usage = out.text().slice(out.text().indexOf('USAGE'));
  assert.match(usage, /node src\/cli\.ts view \[campaign-id\]/);
  // The title line is the documented exception: `army view — …` NAMES the command.
  assert.match(out.text(), /^army view — /m);
});

// ===============================================================================================
// THE TWO LINES `src/view/live.ts` PRINTS ON ITS OWN
//
// The block above routed `runView`'s five refusals and guarded them. It could not reach the two
// lines that come from BELOW that layer: `readCampaignRow`'s diagnosis, which names a command to
// TYPE, and follow mode's own banner. Both were a hardcoded `army`. The result was not a cosmetic
// inconsistency — a reader running `node src/cli.ts view -f` against a campaign directory whose
// `campaign.json` had gone watched a single frame that reported itself as `army view:` and, in
// the same sentence, told them to run `army rebuild`. Two commands, neither of which they had,
// printed by a process that already knew the right answer and was holding it one stack frame up.
//
// `ReaderOptions.self` and `FollowOptions.self` are REQUIRED parameters now, so the compiler
// rejects a call site that forgets one. That proves a value arrives. These prove it is the value
// that reaches the terminal — a different claim, and the one that was false.
//
// `SELF` is injected, for the reason stated above: an assertion against `invokedAs()`'s own
// output agrees with whatever that function produced and cannot fail.
// ===============================================================================================

test('a campaign directory with no campaign.json suggests a rebuild THIS reader can type', () => {
  const archiveRoot = tempDir();
  try {
    buildFixtureArchive(archiveRoot);
    // The condition the message exists for: the directory is there, the row is not.
    fs.rmSync(campaignJsonPath(campaignDir(archiveRoot, CAMPAIGN_ID)));

    const reader = openCampaignReader({ archiveRoot, campaignId: CAMPAIGN_ID, self: SELF });
    try {
      assert.throws(
        () => reader.read(true),
        (error: unknown) => {
          const message = (error as Error).message;
          assert.match(message, /carries no campaign row/, `the diagnosis was lost:\n${message}`);
          assert.ok(
            message.includes(`\`${SELF} rebuild\``),
            `the suggestion was not routed through the caller's invocation:\n${message}`,
          );
          assert.doesNotMatch(
            message,
            /(^|[\s`])army rebuild\b/,
            `a hardcoded \`army rebuild\` survived:\n${message}`,
          );
          return true;
        },
      );
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('follow mode names ITSELF as the invocation the reader used', async () => {
  const archiveRoot = tempDir();
  try {
    buildFixtureArchive(archiveRoot);
    const reader = openCampaignReader({ archiveRoot, campaignId: CAMPAIGN_ID, self: SELF });
    const frames: string[] = [];
    await followCampaign({
      reader,
      self: SELF,
      frame: () => {
        throw new Error('archive vanished mid-poll');
      },
      write: (text) => frames.push(text),
      maxFrames: 1,
      sleep: async () => undefined,
    });
    reader.close();

    assert.equal(frames.length, 1);
    assert.equal(frames[0], `${SELF} view: archive vanished mid-poll\n`);
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('END TO END: both of `live.ts`’s lines come out of the same `self` as every refusal', async () => {
  const archiveRoot = tempDir();
  try {
    buildFixtureArchive(archiveRoot);
    fs.rmSync(campaignJsonPath(campaignDir(archiveRoot, CAMPAIGN_ID)));

    // Nothing below is a unit test with a hand-passed string: this is the real command, wired
    // the real way, and `self` enters exactly where a CLI user's `invokedAs()` would.
    const base = {
      env: CLEAN_ENV,
      homeDir: archiveRoot,
      self: SELF,
      now: NOW_DATE,
    };

    // 1. The one-shot path. The read fails inside `runView`'s try, so it lands on a refusal.
    const once = collect();
    const onceCode = await runView([CAMPAIGN_ID, '--archive', archiveRoot], {
      ...base,
      stdout: once.stream,
      stderr: once.stream,
    });
    assert.equal(onceCode, 1, `expected a refusal:\n${once.text()}`);

    // 2. Follow mode. The read fails INSIDE a frame, so it is drawn rather than thrown — the
    //    path that had its own hardcoded banner, and the only one that prints both defects at once.
    const followed = collect();
    const followCode = await runView([CAMPAIGN_ID, '--archive', archiveRoot, '--follow'], {
      ...base,
      stdout: followed.stream,
      stderr: followed.stream,
      maxFrames: 1,
    });
    assert.equal(followCode, 0, `a read failure must be a frame, not an exit:\n${followed.text()}`);

    for (const [what, text] of [
      ['the one-shot refusal', once.text()],
      ['the follow-mode frame', followed.text()],
    ] as const) {
      assert.match(text, /carries no campaign row/, `${what} lost the diagnosis:\n${text}`);
      // It reports itself as the form the reader used…
      assert.match(text, new RegExp(`^${SELF.replace(/[/.]/g, '\\$&')} view: `, 'm'), `${what}:\n${text}`);
      // …and the command it suggests is the same form, from the same resolution.
      assert.ok(text.includes(`\`${SELF} rebuild\``), `${what} suggests something else:\n${text}`);
      // The whole property, stated once: no spelling of `army` this reader lacks, anywhere.
      assert.doesNotMatch(
        text,
        /(^|[\s`])army (view|campaign|enlist|rebuild|doctor|init)\b/m,
        `a hardcoded \`army …\` survived ${what}:\n${text}`,
      );
    }
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// A KILLED CAMPAIGN MUST NOT READ AS LIVE FOREVER
//
// SIGKILL cannot be caught, so a supervisor killed mid-flight leaves `campaign.json` frozen at
// `status: "active"` — field-reproduced three times, three permanently-"active" rows. The view
// never edits truth (this command is read-only), so the fix is presentation: an `active` whose
// newest evidence is hours old is flagged `probably interrupted` instead of being vouched for.
// ---------------------------------------------------------------------------------------------

/** Three hours after the campaign opened — safely past the two-hour presumed-dead line. */
const HOURS_LATER = T0 + 3 * 60 * 60_000;

test('an active campaign silent past the threshold is flagged, in the model and on the screen', () => {
  const built = buildTree(
    snapshot({
      agents: [agentRow('cpt-07', 'CAPTAIN', 1, { status: 'running' })],
      streams: {
        'cpt-07': digestStream('cpt-07', [
          event('ready', 11),
          event('tool_use', 30, { name: 'Bash', toolUseId: 'tu-1' }),
        ]),
      },
    }),
    { now: HOURS_LATER },
  );

  const liveness = built.campaign.liveness;
  assert.ok(liveness !== null, 'an active campaign always carries a liveness verdict');
  assert.equal(liveness.presumedDead, true);
  assert.equal(liveness.lastEvidenceTs, at(30), 'anchored to the newest evidence in the snapshot');
  assert.equal(liveness.silentMs, HOURS_LATER - Date.parse(at(30)));
  assert.ok(liveness.silentMs > DEFAULT_PRESUMED_DEAD_AFTER_MS);

  // The header keeps the recorded status AND refuses to let it stand alone.
  const text = renderTree(built, { width: 120, charset: 'ascii' });
  assert.match(text, /active/);
  assert.match(text, /! active - stream silent 2h, probably interrupted/, text);

  // `--json` carries the same verdict, so a script is not left re-deriving it from mtimes.
  const parsed = JSON.parse(renderJson(built)) as TreeModel;
  assert.equal(parsed.campaign.liveness?.presumedDead, true);
});

test('an active campaign with recent evidence is NOT flagged — silence is the claim, not activity', () => {
  const built = buildTree(
    snapshot({
      agents: [agentRow('cpt-07', 'CAPTAIN', 1, { status: 'running' })],
      streams: { 'cpt-07': digestStream('cpt-07', [event('tool_use', 590, { name: 'Bash', toolUseId: 'tu' })]) },
    }),
    { now: NOW },
  );
  assert.ok(built.campaign.liveness !== null);
  assert.equal(built.campaign.liveness.presumedDead, false);
  assert.doesNotMatch(renderTree(built, { width: 120, charset: 'ascii' }), /probably interrupted/);
});

test('a campaign that ENDED is never flagged, however long ago — its status is already the truth', () => {
  const built = buildTree(
    snapshot({ campaign: campaignRow({ status: 'done', ended_at: at(600) }) }),
    { now: HOURS_LATER },
  );
  assert.equal(built.campaign.liveness, null, 'liveness is an `active`-only question');
  assert.doesNotMatch(renderTree(built, { width: 120, charset: 'ascii' }), /probably interrupted/);
});

test('a campaign killed before its first soldier still ages, from the one timestamp it has', () => {
  // The setup-window death: no agents, no streams, no tasks — only campaign.json exists.
  const built = buildTree(snapshot(), { now: HOURS_LATER });
  assert.ok(built.campaign.liveness !== null);
  assert.equal(built.campaign.liveness.presumedDead, true);
  assert.equal(built.campaign.liveness.lastEvidenceTs, at(0), 'created_at is the last evidence');
});

test('--list flags an active campaign whose directory has not moved in hours, and only that one', async () => {
  const archiveRoot = tempDir();
  try {
    const campaignRootDir = buildFixtureArchive(archiveRoot);

    // A terminal campaign of the same age must NOT be flagged: done is done, however old.
    const doneDir = path.join(archiveRoot, 'campaigns', 'finished-long-ago');
    fs.mkdirSync(doneDir, { recursive: true });
    fs.writeFileSync(
      path.join(doneDir, 'campaign.json'),
      JSON.stringify({ id: 'finished-long-ago', title: 'Done Deal', status: 'done', project: '/p', created_at: at(0) }),
    );

    // Nothing in the killed campaign's directory has moved for three hours: age every file's
    // mtime, which is exactly the evidence `--list` reads (it must stay too cheap for streams).
    const old = new Date(T0);
    const age = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) age(full);
        else fs.utimesSync(full, old, old);
      }
    };
    age(campaignRootDir);
    age(doneDir);

    const summaries = listCampaigns(archiveRoot);
    const active = summaries.find((c) => c.id === CAMPAIGN_ID);
    assert.ok(active !== undefined);
    assert.equal(active.status, 'active');
    assert.equal(active.lastActivityAt, new Date(T0).toISOString());
    assert.equal(
      summaries.find((c) => c.id === 'finished-long-ago')?.lastActivityAt,
      null,
      'a terminal campaign is not even measured',
    );

    const out = collect();
    const code = await runView(['--archive', archiveRoot, '--list'], {
      stdout: out.stream,
      stderr: out.stream,
      now: () => new Date(HOURS_LATER),
      env: CLEAN_ENV,
      homeDir: archiveRoot,
    });
    assert.equal(code, 0, out.text());
    const activeRow = out.text().split('\n').find((line) => line.includes(CAMPAIGN_ID)) ?? '';
    assert.match(activeRow, /active/);
    assert.match(activeRow, /stream silent 3h, probably interrupted/, out.text());
    const doneRow = out.text().split('\n').find((line) => line.includes('finished-long-ago')) ?? '';
    assert.doesNotMatch(doneRow, /probably interrupted/, out.text());
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

// ===============================================================================================
// SESSION CHROME — the header, the status bar and the roster
//
// Every test here is a pure-function test, which is the whole reason `src/view/chrome.ts` takes
// its charset, colour, width, elapsed milliseconds and animation frame as arguments. The one
// property that is not about looks is load-bearing on `src/chat/io.ts` and is asserted first:
// a row wider than the terminal WRAPS, and a wrapped row puts the cursor arithmetic that pins
// the block under the composer out by one for the rest of the session.
// ===============================================================================================

const CHROME_REPO: RepoState = {
  branch: 'main',
  head: 'a1b2c3d',
  dirty: 3,
  ahead: 2,
  behind: 1,
};

const CHROME_ROSTER: RosterUnit[] = [
  {
    agentId: 'cpt-01',
    rank: 'CAPTAIN',
    role: 'ENGINEER',
    harness: 'claude',
    attempt: 2,
    state: 'returned',
    elapsedMs: 0,
    detail: 'the session is read once per request and cached on the request object',
    detailAgeMs: 0,
    thinkingTokens: null,
    silentMs: 0,
  },
  {
    agentId: 'cpt-02',
    rank: 'CAPTAIN',
    role: 'INSPECTOR',
    harness: 'claude',
    attempt: 1,
    state: 'working',
    elapsedMs: 72_000,
    detail: null,
    detailAgeMs: null,
    thinkingTokens: null,
    silentMs: 0,
  },
];

const CHROME_STATUS: StatusModel = {
  repo: CHROME_REPO,
  project: 'agentic-army',
  model: 'claude-opus-5',
  rung: 'rung 2 (pull request)',
  turns: 3,
  dispatches: 1,
  costUsd: 0.4137,
  roster: CHROME_ROSTER,
  hint: null,
};

const CHROME_HEADER: HeaderModel = {
  title: '◆ COL·COMMANDER — a live session',
  subtitle: 'it holds the objective, and one inert tool: TodoWrite',
  facts: [
    { key: 'project', value: 'agentic-army' },
    { key: 'path', value: '/Users/someone/organizations/personal/agentic-army' },
    { key: 'branch', value: 'main · a1b2c3d · 3 uncommitted' },
    { key: 'dropped', value: '' },
  ],
  hints: ['every dispatch is reviewed by an independent Inspector'],
};

/** Columns a row occupies once the SGR is taken off. */
function chromeColumns(line: string): number {
  return line.replace(/\[[0-9;]*m/gu, '').length;
}

  const widths = [24, 40, 62, 80, 100, 200];

test('session chrome — every row fits the terminal it was rendered for — no status row is ever wider than width - 1, in either charset', () => {
  for (const charset of ['unicode', 'ascii'] as const) {
    for (const width of widths) {
      for (const model of [CHROME_STATUS, { ...CHROME_STATUS, hint: 'Ctrl-C again to leave' }]) {
        const rows = renderStatusBar(model, 3, { charset, color: true, width });
        for (const row of rows) {
          assert.ok(
            chromeColumns(row) <= width - 1,
            `${charset}@${String(width)}: ${String(chromeColumns(row))} columns — ${JSON.stringify(row)}`,
          );
        }
      }
    }
  }
});

test('session chrome — every row fits the terminal it was rendered for — no header row is ever wider than width - 1, and the box is square', () => {
  for (const charset of ['unicode', 'ascii'] as const) {
    for (const width of widths) {
      const lines = renderHeader(CHROME_HEADER, { charset, color: false, width });
      for (const line of lines) {
        assert.ok(
          chromeColumns(line) <= width - 1,
          `${charset}@${String(width)}: ${JSON.stringify(line)}`,
        );
      }
      // The four frame rows — top, title, subtitle, bottom — are the block's own rectangle, and
      // a box whose corners do not line up is the most visible possible way to fail this.
      const framed = lines.filter((line) => line.trim() !== '').slice(0, 4);
      const widthsOf = new Set(framed.map((line) => chromeColumns(line)));
      assert.equal(
        widthsOf.size,
        1,
        `${charset}@${String(width)}: the box is not rectangular — ${JSON.stringify(framed)}`,
      );
    }
  }
});

test('session chrome — every row fits the terminal it was rendered for — nothing the chrome emits is a newline or a cursor move', () => {
  // `src/chat/io.ts` paints the block with relative cursor movement and counts the rows it
  // wrote. A renderer that emitted its own `\n`, or its own `ESC[2A`, would put that count out
  // — so the only escape sequence allowed out of this file is SGR colour.
  const rows = [
    ...renderStatusBar(CHROME_STATUS, 0, { charset: 'unicode', color: true, width: 80 }),
    ...renderHeader(CHROME_HEADER, { charset: 'unicode', color: true, width: 80 }),
  ];
  for (const row of rows) {
    assert.doesNotMatch(row, /[\n\r]/u, `a chrome row carried a line break: ${JSON.stringify(row)}`);
    // An escape whose FINAL byte is not `m` — i.e. anything that is not SGR colour. The first
    // spelling of this was `[^m]*[A-Za-z]`, which matches the `m` itself with an empty middle
    // and therefore fired on every colour code in the file: a guard that fails on correct output
    // is a guard that gets deleted rather than one that catches anything.
    const escapes = row.match(/\u001b\[[0-9;]*[^0-9;m]/gu) ?? [];
    assert.deepEqual(escapes, [], `a chrome row carried a non-SGR escape: ${JSON.stringify(row)}`);
  }
});

test('session chrome — every row fits the terminal it was rendered for — the ascii charset leaves no unrenderable character behind', () => {
  const rows = [
    ...renderStatusBar(CHROME_STATUS, 0, { charset: 'ascii', color: false, width: 100 }),
    ...renderHeader(CHROME_HEADER, { charset: 'ascii', color: false, width: 100 }),
  ];
  for (const row of rows) {
    assert.doesNotMatch(
      row,
      /\?/u,
      `a glyph fell through the fold table to a literal "?": ${JSON.stringify(row)}`,
    );
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(row, /[^ -~]/u, `non-ASCII survived: ${JSON.stringify(row)}`);
  }
});

test('the repository, as the bar and the header report it — an unread working copy is never rendered as a clean one', () => {
  // The one failure mode a status bar must not have. `git status` timing out and `git status`
  // coming back empty are different facts, and a bar that spells them the same way is a bar
  // that tells a reader they have nothing uncommitted when nobody has checked.
  const unread: RepoState = { ...REPO_UNKNOWN, branch: 'main', head: 'a1b2c3d' };
  const clean: RepoState = { ...unread, dirty: 0 };
  assert.equal(formatRepo(unread, UNICODE_GLYPHS), 'main');
  assert.equal(formatRepo(clean, UNICODE_GLYPHS), 'main');
  // Identical on the bar, where there is no room to say it — and never identical in the header.
  assert.match(describeRepo(unread), /working copy not read/);
  assert.match(describeRepo(clean), /clean/);
  assert.notEqual(describeRepo(unread), describeRepo(clean));
});

test('the repository, as the bar and the header report it — dirt, ahead and behind each get exactly one mark', () => {
  assert.equal(formatRepo(CHROME_REPO, UNICODE_GLYPHS), 'main*↑2↓1');
  assert.equal(formatRepo(CHROME_REPO, ASCII_GLYPHS), 'main*^2v1');
  assert.equal(
    formatRepo({ ...CHROME_REPO, dirty: 0, ahead: 0, behind: 0 }, UNICODE_GLYPHS),
    'main',
    'a quiet branch carries no marks at all',
  );
});

test('the repository, as the bar and the header report it — a detached HEAD says so rather than inventing a branch', () => {
  const detached: RepoState = { ...REPO_UNKNOWN, branch: null, head: 'a1b2c3d' };
  assert.equal(formatRepo(detached, UNICODE_GLYPHS), '—a1b2c3d');
  assert.match(describeRepo(detached), /detached at a1b2c3d/);
  // And a directory git could not be asked about at all renders as nothing, rather than as a
  // branch called "null" — the header drops the row, because an empty fact value is dropped.
  assert.equal(describeRepo(REPO_UNKNOWN), '');
  assert.equal(formatRepo(REPO_UNKNOWN, UNICODE_GLYPHS), 'no branch');
});

test('the status bar drops what does not fit, in order of what matters — the branch survives every width, and the counters are the first to go', () => {
  const wide = renderStatusBar(CHROME_STATUS, 0, { charset: 'unicode', color: false, width: 120 });
  const narrow = renderStatusBar(CHROME_STATUS, 0, { charset: 'unicode', color: false, width: 46 });
  const contextOf = (rows: string[]): string => rows[rows.length - 1] as string;
  assert.match(contextOf(wide), /main\*↑2↓1/);
  assert.match(contextOf(wide), /\$0\.41/, 'a wide bar should carry the cost');
  assert.match(contextOf(narrow), /main\*↑2↓1/, 'the branch was dropped to make room for less');
  assert.doesNotMatch(contextOf(narrow), /\$0\.41/, 'the cost outlived the width');
  // Dropped whole, never clipped to a half-word — the row is read at a glance and `rung 2 (pull
  // req…` costs a reader more than the segment was worth.
  assert.doesNotMatch(contextOf(narrow), /…/u);
});

test('the status bar drops what does not fit, in order of what matters — a hint outranks every counter, because it expires and they do not', () => {
  const hinted: StatusModel = {
    ...CHROME_STATUS,
    hint: 'dispatch in flight — Ctrl-C lets it settle',
  };
  const rows = renderStatusBar(hinted, 0, { charset: 'unicode', color: false, width: 80 });
  const context = rows[rows.length - 1] as string;
  assert.match(context, /dispatch in flight/, 'the hint did not survive an 80-column bar');
  assert.doesNotMatch(context, /3 turns/, 'the counters queued ahead of a rule about a keystroke');
});

test('the status bar drops what does not fit, in order of what matters — a session that has spent nothing measurable says so without lying about zero', () => {
  const model = (costUsd: number | null): string => {
    const rows = renderStatusBar(
      { ...CHROME_STATUS, roster: [], hint: null, costUsd },
      0,
      { charset: 'unicode', color: false, width: 120 },
    );
    return rows[rows.length - 1] as string;
  };
  assert.match(model(0.0004), /<\$0\.01/);
  assert.match(model(0), /\$0\b/);
  assert.doesNotMatch(model(null), /\$/, 'a harness that reported no cost must not imply zero');
});

test('the roster — one row per unit, and a clock only on the one that is running — the spinner advances with the tick and only the working unit carries a clock', () => {
  const style = { charset: 'unicode' as const, color: false, width: 120 };
  const frame0 = renderRoster(CHROME_ROSTER, 0, style);
  const frame1 = renderRoster(CHROME_ROSTER, 1, style);
  assert.equal(frame0.length, 2);
  assert.notEqual(frame0[1], frame1[1], 'the working row did not animate');
  assert.equal(frame0[0], frame1[0], 'a finished row animated, which reads as still running');
  assert.match(frame0[1] as string, /CPT·INSPECTOR · cpt-02 working 1m12s/);
  assert.doesNotMatch(frame0[0] as string, /\d+s/u, 'a returned unit was given a running clock');
  // The attempt number appears only when there has been more than one — a `#1` on every row is
  // a column of noise that says nothing.
  assert.match(frame0[0] as string, /cpt-01 #2 returned/);
  assert.doesNotMatch(frame0[1] as string, /#1/u);
});

test("the roster — one row per unit, and a clock only on the one that is running — a unit's own summary cannot move the cursor or overwrite its label", () => {
  // Model-controlled text, on a row that is repainted in place. `\r` would put the summary on
  // top of the unit id it belongs to, and `ESC[2J` would clear the screen of the person
  // reading it.
  const hostile: RosterUnit = {
    ...(CHROME_ROSTER[0] as RosterUnit),
    detail: 'done\r[2Jand the screen is mine\nsecond line',
  };
  const [row] = renderRoster([hostile], 0, { charset: 'unicode', color: false, width: 200 });
  assert.doesNotMatch(row as string, /[\n\r]/u);
  assert.ok(!(row as string).includes(''), `an escape survived: ${JSON.stringify(row)}`);
  assert.match(row as string, /CPT·ENGINEER · cpt-01/, 'the label was overwritten');
  assert.match(row as string, /\[2Jand the screen is mine/, 'the text should survive as text');
});

test('the roster — one row per unit, and a clock only on the one that is running — a long summary is clipped rather than allowed to push the unit off the row', () => {
  const chatty: RosterUnit = { ...(CHROME_ROSTER[0] as RosterUnit), detail: 'x'.repeat(500) };
  const [row] = renderRoster([chatty], 0, { charset: 'unicode', color: false, width: 80 });
  assert.ok(chromeColumns(row as string) <= 79);
  assert.match(row as string, /CPT·ENGINEER · cpt-01 #2 returned/);
});

test('formatElapsed — a clock a human is watching, not a duration — keeps the seconds moving where formatDuration would sit still for a minute', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(47_000), '47s');
  assert.equal(formatElapsed(72_000), '1m12s');
  assert.equal(formatElapsed(119_000), '1m59s');
  assert.equal(formatElapsed(3_600_000), '1h00m');
  assert.equal(formatElapsed(3_840_000), '1h04m');
  assert.equal(formatElapsed(-5), '0s', 'a clock that has not started must not run backwards');
  // The contrast this function exists for: `formatDuration` answers "how long was it silent",
  // and reads 1m for everything from 60s to 119s. A reader watching a unit work needs the
  // number to move, because a number that does not move is the question "has this hung?".
  assert.equal(formatDuration(72_000), '1m');
  assert.equal(formatDuration(119_000), '1m');
});

// ===============================================================================================
// COLUMNS — why `String.length` was never the right measure
//
// `src/view/chrome.ts` states that exact column counting is load-bearing: every row is clipped to
// `width - 1` because a wrapped row adds a physical line that `src/chat/io.ts`'s `ESC[nA`
// arithmetic does not know about, and from then on the cursor is one row adrift for the rest of
// the session. These tests are that claim, made checkable.
// ===============================================================================================

const ESC = '\u001b';

test('displayWidth counts terminal columns, not UTF-16 code units', () => {
  assert.equal(displayWidth('abc'), 3);
  // A CJK ideograph is ONE code unit and TWO columns — the direction `String.length` gets wrong
  // in the way that makes a row overflow rather than come up short.
  assert.equal('世界'.length, 2);
  assert.equal(displayWidth('世界'), 4);
  // An emoji is TWO code units and TWO columns; counting units happens to agree here, which is
  // exactly why measuring one and assuming the other survived so long.
  assert.equal('🔥'.length, 2);
  assert.equal(displayWidth('🔥'), 2);
  // A combining accent is one code unit and NO columns.
  assert.equal('é'.length, 2);
  assert.equal(displayWidth('é'), 1);
  assert.equal(displayWidth(''), 0);
});

test('clipTo cuts to columns and never emits a half-drawn double-width cell', () => {
  assert.equal(clipTo('abcdef', 10, '…'), 'abcdef');
  assert.equal(displayWidth(clipTo('abcdefghij', 5, '…')), 5);
  // Four ideographs are eight columns. Clipped to five, the ellipsis takes one and only two whole
  // ideographs fit in the remaining four — the fifth column is left EMPTY rather than filled with
  // half a character, because a terminal draws the whole cell or none of it.
  const clipped = clipTo('世界世界', 5, '…');
  assert.ok(displayWidth(clipped) <= 5, `clip overflowed: ${String(displayWidth(clipped))} columns`);
  assert.ok(clipped.endsWith('…'));
  // The invariant that actually matters, across every width a narrow terminal might hand us.
  for (let width = 1; width <= 12; width += 1) {
    const out = clipTo('a世b界c🔥d', width, '…');
    assert.ok(
      displayWidth(out) <= width,
      `width ${String(width)}: clipped to ${String(displayWidth(out))} columns`,
    );
  }
});

test('padTo pads to columns, so a CJK cell is not padded twice', () => {
  assert.equal(padTo('ab', 5, 'left'), 'ab   ');
  assert.equal(displayWidth(padTo('世', 5, 'left')), 5);
  assert.equal(displayWidth(padTo('世', 5, 'right')), 5);
  // Already at or past the budget: never truncates. That is `clipTo`'s job, and doing both here
  // would silently shorten a column somebody had already measured.
  assert.equal(padTo('世界世', 4, 'left'), '世界世');
});

// ===============================================================================================
// SANITISING — everything a terminal obeys rather than displays
// ===============================================================================================

test('sanitize strips bidi overrides, which a terminal obeys as surely as an escape', () => {
  // Trojan Source, in the one slot a model chooses the bytes for: without this, the row displays
  // a path that was never written.
  assert.ok(!sanitize('Write lib/\u202esj.esrever').includes('\u202e'), 'an RLO survived');
  assert.ok(!sanitize('a\u2066b\u2069c').includes('\u2066'), 'a bidi isolate survived');
  // Zero-width characters go too: they let a string be arbitrarily longer than it measures.
  assert.equal(sanitize('a\u200bb'), 'a b');
  assert.equal(sanitize('a\ufeffb'), 'a b');
  // Collapsed to a space rather than deleted — a word boundary the author intended must not close
  // up into a different word.
  assert.equal(sanitize('one\u200btwo'), 'one two');
  // The original contract still holds.
  assert.equal(sanitize(`a${ESC}[2Kb`), 'a[2Kb');
  assert.equal(sanitize('  a\tb\n c  '), 'a b c');
});

test('every sanitized string measures the same before and after painting', () => {
  // The composed guarantee: sanitize removes the invisible, displayWidth measures what is left,
  // and clipTo cuts on that measure. A hostile summary cannot make a row wider than its budget.
  const hostile = `${ESC}[2J\u202ewide 世界 \u200b\u200b\u200b🔥 ${'x'.repeat(200)}`;
  const out = clipTo(sanitize(hostile), 40, '…');
  assert.ok(displayWidth(out) <= 40, `${String(displayWidth(out))} columns survived a 40 budget`);
  assert.ok(!out.includes(ESC), 'an escape byte reached a painted row');
});

// ===============================================================================================
// DESCRIBING A TOOL CALL — the only function permitted to read model-chosen tool input
// ===============================================================================================

const WT = '/Users/x/.agentic-army-trees/trees/proj-abc/wt-01';

test('describeToolUse names the salient argument for each claude tool', () => {
  const at = (name: string, input: unknown): string =>
    formatToolAction(describeToolUse(name, input, { root: WT }));
  assert.equal(at('Write', { file_path: `${WT}/lib/html.js` }), 'Write(lib/html.js)');
  assert.equal(at('Read', { file_path: `${WT}/package.json` }), 'Read(package.json)');
  assert.equal(at('Edit', { file_path: `${WT}/lib/cli.js` }), 'Edit(lib/cli.js)');
  assert.equal(at('Glob', { pattern: '**/*.ts' }), 'Glob(**/*.ts)');
  assert.equal(at('Grep', { pattern: 'seo-audit/1.0' }), 'Grep(seo-audit/1.0)');
  // The COMMAND, not the model's description of it — a description is a claim, the command is the
  // fact, and the command is what a permission layer is about to refuse.
  assert.equal(
    at('Bash', { command: 'node --test', description: 'Run the suite' }),
    'Bash(node --test)',
  );
  // A tool with nothing worth naming is reported by name alone, never with an invented argument.
  assert.equal(at('StructuredOutput', {}), 'StructuredOutput');
  assert.equal(at('Glob', {}), 'Glob');
});

test('describeToolUse translates codex tool shapes into the same vocabulary', () => {
  const at = (name: string, input: unknown): string =>
    formatToolAction(describeToolUse(name, input, { root: WT }));
  // The `/bin/zsh -lc` wrapper is on every single codex command and is pure constant — nine
  // columns that would push the informative half of the row off the end.
  assert.equal(
    at('command_execution', { command: ['/bin/zsh', '-lc', 'npm test'] }),
    'Bash(npm test)',
  );
  assert.equal(at('command_execution', { command: "/bin/zsh -lc 'npm test'" }), 'Bash(npm test)');
  assert.equal(at('command_execution', { command: 'npm test' }), 'Bash(npm test)');
  assert.equal(
    at('file_change', { changes: [{ path: `${WT}/a.js` }, { path: `${WT}/b.js` }] }),
    'Edit(a.js +1 more)',
  );
  assert.equal(
    at('mcp_tool_call', { server: 'virlo', tool: 'get_trends' }),
    'MCP(virlo.get_trends)',
  );
});

test('describeToolUse strips the worktree prefix but never a path outside it', () => {
  const inside = describeToolUse('Write', { file_path: `${WT}/lib/a.js` }, { root: WT });
  assert.equal(inside.target, 'lib/a.js');
  // An absolute path OUTSIDE the lease is the shape of a worker writing where it should not, and
  // is exactly the thing a reader most needs to see whole.
  const outside = describeToolUse('Write', { file_path: '/tmp/scratch.js' }, { root: WT });
  assert.equal(outside.target, '/tmp/scratch.js');
  // No root: nothing is stripped, and nothing throws.
  assert.equal(describeToolUse('Write', { file_path: '/a/b.js' }).target, '/a/b.js');
});

test('describeToolUse sanitises and clips before anything downstream sees the target', () => {
  const hostile = describeToolUse(
    'Bash',
    { command: `${ESC}[2Jrm -rf ${'x'.repeat(400)}` },
    { root: WT, max: 30 },
  );
  assert.ok(!hostile.target.includes(ESC), 'an escape byte survived into a target');
  assert.ok(
    displayWidth(hostile.target) <= 30,
    `target was ${String(displayWidth(hostile.target))} columns against a 30 budget`,
  );
  // Non-record input must not throw: `ToolUseEvent.input` is optional and `unknown`.
  assert.equal(describeToolUse('Bash', undefined).target, '');
  assert.equal(describeToolUse('Bash', 'a string').target, '');
  assert.equal(describeToolUse('Bash', null).verb, 'Bash');
});

test('bookkeeping tools are marked, so a caller can drop them instead of drowning in them', () => {
  // 25 of the reference run's 107 calls were these, in bursts of nine.
  for (const name of ['TaskCreate', 'TaskUpdate', 'TodoWrite', 'ToolSearch']) {
    assert.equal(describeToolUse(name, {}).bookkeeping, true, `${name} was not bookkeeping`);
  }
  for (const name of ['Write', 'Bash', 'Read', 'Grep', 'Task']) {
    assert.equal(describeToolUse(name, {}).bookkeeping, false, `${name} was marked bookkeeping`);
  }
});

// ===============================================================================================
// THE ACTIVITY EVENTS, AND THE TICKER THEY NEARLY KILLED
// ===============================================================================================

test('dispositionOf separates printing from ticker-safe from never-printed', () => {
  assert.equal(dispositionOf({ kind: 'unit-thinking', agentId: 'a', tokens: 1 }), 'silent');
  assert.equal(
    dispositionOf({ kind: 'unit-acted', agentId: 'a', toolUseId: 't', isError: false }),
    'silent',
  );
  assert.equal(
    dispositionOf({
      kind: 'unit-acting',
      agentId: 'a',
      toolUseId: 't',
      tool: 'Write',
      target: 'a.js',
      depth: 0,
    }),
    'activity',
  );
  assert.equal(dispositionOf({ kind: 'note', level: 'info', message: 'x' }), 'lifecycle');
});

test('formatTokens rounds rather than claiming an accuracy the harness does not have', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1200), '1.2k');
  assert.equal(formatTokens(23_550), '24k');
  assert.equal(formatTokens(1_500_000), '1.5M');
  // Never renders as a negative or a NaN, whatever the harness reports.
  assert.equal(formatTokens(-5), '0');
  assert.equal(formatTokens(Number.NaN), '0');
});

const STYLE = { self: 'army', charset: 'unicode' as const };

test('a tool call prints one line; a result and a reasoning tick print nothing', () => {
  const acting = renderProgressEvent(
    {
      kind: 'unit-acting',
      agentId: 'cpt-01',
      toolUseId: 't',
      tool: 'Write',
      target: 'lib/a.js',
      depth: 0,
    },
    STYLE,
  );
  assert.match(acting, /Write\(lib\/a\.js\)/u);
  // A line per RESULT would double the feed to say "the thing you saw start has stopped", which
  // the next line already implies.
  assert.equal(
    renderProgressEvent({ kind: 'unit-acted', agentId: 'a', toolUseId: 't', isError: false }, STYLE),
    '',
  );
  // 662 of these arrived on the reference run. Every one of them printing is a worse terminal
  // than none of them printing.
  assert.equal(renderProgressEvent({ kind: 'unit-thinking', agentId: 'a', tokens: 900 }, STYLE), '');
});

test('a nested subagent call is indented under its parent, and the nesting is capped', () => {
  const call = (depth: number): string =>
    renderProgressEvent(
      { kind: 'unit-acting', agentId: 'a', toolUseId: 't', tool: 'Write', target: 'a.js', depth },
      STYLE,
    );
  assert.ok(call(1).length > call(0).length, 'a depth-1 call was not indented past its parent');
  // `depth` comes from the harness and nothing here may assume it is small: an absurd depth must
  // not push the line off the right edge.
  assert.equal(call(9).length, call(3).length, 'nesting was not capped');
});

test('a refused call names the command, and quotes only the sentence addressed to a human', () => {
  const line = renderProgressEvent(
    {
      kind: 'unit-blocked',
      agentId: 'cpt-01',
      tool: 'Bash',
      target: 'cat > /tmp/probe.js',
      reason:
        "Permission to use Bash has been denied because Claude Code is running in don't ask mode. " +
        'IMPORTANT: You *may* attempt to accomplish this action using other tools. ' +
        'x'.repeat(300),
    },
    STYLE,
  );
  // The command, not just the tool name: `Bash refused` says something was blocked, and
  // `Bash(cat > /tmp/...) refused` says the worker reached outside its worktree.
  assert.match(line, /cat > \/tmp\/probe\.js/u);
  assert.match(line, /refused/u);
  assert.ok(!line.includes('IMPORTANT'), 'advice addressed to the model reached the human');
  assert.ok(line.length < 220, `a denial line ran to ${String(line.length)} characters`);
});

/**
 * A sink over a fake stream and fake timers, so no test waits on a real one.
 *
 * `clear` genuinely REMOVES the handle, and `tick` fires only what is still live. That is not a
 * detail: the first version of this helper ignored `clear`, so a ticker the sink had stopped kept
 * painting when the test poked it — and the regression test for "an activity event must not kill
 * the ticker" passed happily against the very bug it was written to catch. A fake that is more
 * forgiving than the real timer makes every assertion built on it worthless.
 */
function scriptedSink(columns: number): {
  writes: string[];
  emit: (event: ProgressEvent) => void;
  /** Fire every live timer. Returns how many there were — zero means nothing is ticking. */
  tick: () => number;
  advance: (ms: number) => void;
  close: () => void;
} {
  const writes: string[] = [];
  const live = new Map<number, () => void>();
  let next = 0;
  let clock = 1_000_000;
  const sink = createProgressSink({
    stream: { write: (text: string) => writes.push(text), isTTY: true, columns },
    self: 'army',
    live: true,
    now: () => clock,
    timers: {
      set: (fn: () => void) => {
        const handle = next;
        next += 1;
        live.set(handle, fn);
        return handle;
      },
      clear: (handle: unknown) => {
        live.delete(handle as number);
      },
    },
  });
  return {
    writes,
    emit: (event) => sink.emit(event),
    tick: () => {
      const fns = [...live.values()];
      for (const fn of fns) fn();
      return fns.length;
    },
    advance: (ms) => {
      clock += ms;
    },
    close: () => sink.close(),
  };
}

const DISPATCHED: ProgressEvent = {
  kind: 'unit-dispatched',
  agentId: 'cpt-01',
  rank: 'CAPTAIN',
  role: 'ENGINEER',
  harness: 'claude',
  attempt: 1,
};

test('the elapsed ticker survives a tool call, and does not restart its clock', () => {
  // The regression this exists for: `emit` used to stop the ticker on EVERY event and restart it
  // only on `unit-dispatched`, so the first activity event permanently disabled the one live
  // signal `army campaign` has. Capable of failing — revert that and the second assert goes dead.
  const s = scriptedSink(100);
  s.emit(DISPATCHED);
  s.advance(120_000);
  assert.equal(s.tick(), 1, 'no ticker was started at dispatch');
  assert.match(s.writes[s.writes.length - 1] ?? '', /120s/u, 'no elapsed reading before the call');

  s.emit({
    kind: 'unit-acting',
    agentId: 'cpt-01',
    toolUseId: 't1',
    tool: 'Write',
    target: 'lib/a.js',
    depth: 0,
  });
  s.advance(5_000);
  // The assertion that catches the regression: a stopped-and-not-restarted ticker leaves NO live
  // timer, and the fake reports that honestly rather than firing a handle the sink has cleared.
  assert.equal(s.tick(), 1, 'the activity event left no live ticker');
  const after = s.writes[s.writes.length - 1] ?? '';
  assert.match(after, /\d+s$/u, `the ticker stopped after a tool call: ${after}`);
  // And still counting from the DISPATCH, not from the tool call: a restart that re-read the
  // clock would turn the one number a watching human trusts into a stopwatch measuring the gap
  // between tool calls.
  assert.match(after, /125s/u, `the elapsed clock restarted: ${after}`);
  s.close();
});

test('a reasoning tick moves the live row without stopping or repainting the ticker', () => {
  const s = scriptedSink(100);
  s.emit(DISPATCHED);
  const before = s.writes.length;
  for (let i = 0; i < 50; i += 1) {
    s.emit({ kind: 'unit-thinking', agentId: 'cpt-01', tokens: i * 100 });
  }
  // Fifty reasoning ticks wrote NOTHING. They arrive every couple of seconds for minutes at a
  // time; each one reaching the stream is a visible flicker on a line that repaints itself.
  assert.equal(s.writes.length, before, 'a reasoning tick wrote to the stream');
  s.advance(3_000);
  s.tick();
  assert.match(s.writes[s.writes.length - 1] ?? '', /thinking/u, 'the count never reached the row');
  s.close();
});

test('the ticker never emits a row wider than the terminal', () => {
  // A wrapped ticker row is unrecoverable: `CLEAR_LINE` erases exactly one row, so the tail stays
  // on screen forever. `detail` now carries model-chosen file paths, which is how a row gets long.
  const s = scriptedSink(40);
  s.emit(DISPATCHED);
  s.emit({
    kind: 'unit-acting',
    agentId: 'cpt-01',
    toolUseId: 't',
    tool: 'Write',
    target: 'a/very/deeply/nested/path/that/keeps/going/forever/and/ever/file.js',
    depth: 0,
  });
  s.tick();
  const frame = (s.writes[s.writes.length - 1] ?? '').replace(`\r${ESC}[2K`, '');
  assert.ok(displayWidth(frame) < 40, `the ticker painted ${String(displayWidth(frame))} of 40`);
  s.close();
});

// ===============================================================================================
// THE ROSTER ROW, THROUGH A REASONING GAP
// ===============================================================================================

function workingUnit(over: Partial<RosterUnit> = {}): RosterUnit {
  return {
    agentId: 'cpt-01',
    rank: 'CAPTAIN',
    role: 'ENGINEER',
    harness: 'claude',
    attempt: 1,
    state: 'working',
    elapsedMs: 200_000,
    detail: null,
    detailAgeMs: null,
    thinkingTokens: null,
    silentMs: 0,
    ...over,
  };
}

const WIDE = { charset: 'unicode' as const, color: false, width: 120 };

test('a working row keeps naming the last action, and dates it once it goes stale', () => {
  // The complaint, exactly: through a 248-second reasoning gap the row must not go blank. It
  // keeps the last action AND says how old it is, so it is never a claim about the present tense.
  const fresh =
    renderRoster([workingUnit({ detail: 'Write(lib/html.js)', detailAgeMs: 2_000 })], 0, WIDE)[0] ??
    '';
  assert.match(fresh, /Write\(lib\/html\.js\)/u);
  assert.ok(!/ago/u.test(fresh), 'a two-second-old action was dated');

  const stale =
    renderRoster(
      [workingUnit({ detail: 'Write(lib/html.js)', detailAgeMs: 183_000 })],
      0,
      WIDE,
    )[0] ?? '';
  assert.match(stale, /Write\(lib\/html\.js\)/u, 'the row went blank during a reasoning gap');
  assert.match(stale, /3m03s ago/u, 'a three-minute-old action was not dated');
});

test('unknown is a real state on the roster row, never zero', () => {
  // `src/view/chrome.ts` states this rule for the repo state; it holds just as hard here. A
  // harness that reports no reasoning telemetry and a model that has done no reasoning are
  // different facts, and the bar may not merge them.
  const silent = renderRoster([workingUnit()], 0, WIDE)[0] ?? '';
  assert.ok(!/thinking/u.test(silent), 'a null token count rendered as a claim');
  assert.ok(!/ago/u.test(silent), 'a null detail age rendered as a claim');
  assert.match(renderRoster([workingUnit({ thinkingTokens: 23_550 })], 0, WIDE)[0] ?? '', /24k/u);
});

test('a stalled unit is distinguishable from one that is thinking hard', () => {
  // The harness reports reasoning tokens roughly every 1.5s, so silence on this scale is not
  // thinking — and before this existed a reader could only tell by waiting.
  const busy =
    renderRoster([workingUnit({ thinkingTokens: 900, silentMs: 3_000 })], 0, WIDE)[0] ?? '';
  assert.ok(!/silent/u.test(busy), 'a three-second gap was called a stall');
  const stalled =
    renderRoster([workingUnit({ thinkingTokens: 900, silentMs: 120_000 })], 0, WIDE)[0] ?? '';
  assert.match(stalled, /silent 2m/u, 'a two-minute silence was not reported');
});

test('a settled row is never dated or given a live token count', () => {
  // Its detail is the final summary, and dating it would say "this finished four minutes ago" in
  // the slot a reader is using to read what it found.
  const returned =
    renderRoster(
      [
        workingUnit({
          state: 'returned',
          detail: 'built the crawler',
          detailAgeMs: 200_000,
          thinkingTokens: 900,
        }),
      ],
      0,
      WIDE,
    )[0] ?? '';
  assert.match(returned, /built the crawler/u);
  assert.ok(!/ago/u.test(returned), 'a returned unit had its summary dated');
  assert.ok(!/thinking/u.test(returned), 'a returned unit was still shown thinking');
});

test('no roster row ever exceeds its width, however hostile the detail', () => {
  const hostile = workingUnit({
    detail: `${ESC}[2J\u202e${'世界'.repeat(80)}`,
    detailAgeMs: 500_000,
    thinkingTokens: 999_999,
    silentMs: 500_000,
  });
  for (const width of [24, 40, 80, 120]) {
    const row = renderRoster([hostile], 0, { charset: 'unicode', color: false, width })[0] ?? '';
    assert.ok(
      displayWidth(row) < width,
      `width ${String(width)}: row painted ${String(displayWidth(row))} columns`,
    );
    assert.ok(!row.includes(ESC), `width ${String(width)}: an escape byte reached the row`);
  }
});

test('the ascii charset folds every new glyph rather than printing a question mark', () => {
  // The tool and blocked marks are new. A glyph with no FOLD entry becomes `?`, which on a
  // codepage-437 console makes a REFUSED call indistinguishable from a rendering failure.
  const style = { self: 'army', charset: 'ascii' as const };
  const acting = renderProgressEvent(
    { kind: 'unit-acting', agentId: 'a', toolUseId: 't', tool: 'Write', target: 'a.js', depth: 0 },
    style,
  );
  const blocked = renderProgressEvent(
    { kind: 'unit-blocked', agentId: 'a', tool: 'Bash', target: 'cat x', reason: 'denied.' },
    style,
  );
  for (const line of [acting, blocked]) {
    assert.ok(!line.includes('?'), `an unfolded glyph reached the ascii path: ${line}`);
    assert.ok(!/[^ -~]/u.test(line), `a non-ascii byte survived the fold: ${line}`);
  }
});

// -----------------------------------------------------------------------------------------------
// Prose — the commander's answers rendered: gutter, wrap, and markdown as ink.
//
// Every stream test collects writes into one string and asserts on it whole, because the thing
// under test is what a terminal ends up SHOWING, and the terminal does not care how many writes
// it took. The pure pieces (parseInline, blockShape) get their own assertions because they are
// the grammar, and a grammar bug would render every streaming assertion misleading at once.
// -----------------------------------------------------------------------------------------------

import type { ProseStream } from '../src/view/prose.ts';
import { blockShape, createProseStream, firstOpenMarker, parseInline } from '../src/view/prose.ts';

const BOLD = '[1m';
const DIM = '[2m';
const CYAN = '[36m';
const RESET = '[0m';

test('parseInline: bold and code become runs, unmatched markers stay literal', () => {
  assert.deepEqual(parseInline('plain **bold** and `code` here'), [
    { text: 'plain ', style: 'plain' },
    { text: 'bold', style: 'bold' },
    { text: ' and ', style: 'plain' },
    { text: 'code', style: 'code' },
    { text: ' here', style: 'plain' },
  ]);
  // An unmatched marker is text. A style that swallowed the rest of the line would turn one
  // stray asterisk pair into an answer that LOOKS truncated.
  assert.deepEqual(parseInline('2 ** 3 is 8'), [{ text: '2 ** 3 is 8', style: 'plain' }]);
  // Backticks win over bold, so `**` inside code is code, not emphasis.
  assert.deepEqual(parseInline('`a ** b`'), [{ text: 'a ** b', style: 'code' }]);
});

test('firstOpenMarker: the point past which a stream must not print early', () => {
  assert.equal(firstOpenMarker('all closed **here** and `there`'), -1);
  assert.equal(firstOpenMarker('safe then **still open'), 10);
  assert.equal(firstOpenMarker('safe then `still open'), 10);
});

test('blockShape: headings strip, lists hang under their text, fences classify', () => {
  assert.deepEqual(blockShape('## The plan', false), { kind: 'heading', hang: 0, text: 'The plan' });
  assert.deepEqual(blockShape('- first point', false), { kind: 'list', hang: 2, text: '- first point' });
  assert.deepEqual(blockShape('12. later point', false), { kind: 'list', hang: 4, text: '12. later point' });
  assert.equal(blockShape('```sh', false).kind, 'fence');
  // Inside a fence, a line that would otherwise be a list is code.
  assert.equal(blockShape('- not a list', true).kind, 'fence');
  assert.equal(blockShape('just words', false).kind, 'paragraph');
});

/** One whole turn through one stream, collected. */
function prose(width: number, color: boolean, feed: (s: ProseStream) => void): string {
  let out = '';
  const stream = createProseStream({
    width: () => width,
    color,
    charset: 'unicode',
    write: (text) => {
      out += text;
    },
  });
  stream.begin();
  feed(stream);
  stream.end();
  return out;
}

test('an answer wraps at word boundaries and hangs under the gutter', () => {
  const out = prose(40, false, (s) => {
    s.push('the quick brown fox jumps over the lazy dog and keeps going\n');
  });
  const rows = out.split('\n');
  assert.equal(rows[0], '◆ the quick brown fox jumps over the');
  assert.equal(rows[1], '  lazy dog and keeps going');
  for (const row of rows) {
    assert.ok(row.length <= 39, `a row reached the final column: ${JSON.stringify(row)}`);
  }
});

test('a list continuation indents under the item text, not under the margin', () => {
  const out = prose(40, false, (s) => {
    s.push('- dealership sites only, scraped directly and reliably\n');
  });
  const rows = out.split('\n');
  assert.equal(rows[0], '◆ - dealership sites only, scraped');
  assert.equal(rows[1], '    directly and reliably');
});

test('markdown renders as ink: markers gone, bold and code and gutter painted', () => {
  const out = prose(80, true, (s) => {
    s.push('**Question 1: what do we hit?** Run `army doctor` first.\n');
  });
  assert.ok(!out.includes('**'), `a bold marker survived rendering:\n${JSON.stringify(out)}`);
  assert.ok(!out.includes('`'), `a code marker survived rendering:\n${JSON.stringify(out)}`);
  assert.ok(out.includes(`${BOLD}Question 1: what do we hit?${RESET}`), 'bold text is not bold');
  assert.ok(out.includes(`${CYAN}army doctor${RESET}`), 'code text is not cyan');
  assert.ok(out.includes(`${CYAN}◆ ${RESET}`), 'the gutter is not painted');
});

test('colour off: markers still stripped, no escape byte anywhere', () => {
  const out = prose(80, false, (s) => {
    s.push('**bold** and `code`\n');
  });
  assert.equal(out, '◆ bold and code\n');
});

test('a fenced block keeps its quotes: nothing inside it is eaten as markdown', () => {
  const out = prose(80, true, (s) => {
    s.push('```sh\ngrep -q "deps" package.json\n```\n');
  });
  const rows = out.split('\n');
  // The body is highlighted now (the string paints green), so the assertion is on CONTENT
  // surviving, not on a single dim run: strip the ink and the bytes must be exactly the line,
  // left rule and all.
  const plain = (rows[0] ?? '').replace(/\[\d+m/gu, '');
  assert.equal(plain, '◆ │ grep -q "deps" package.json', `fence body is wrong:\n${JSON.stringify(rows[0])}`);
  // The ``` lines print NOTHING, not even the blank row they used to occupy. The body is the
  // whole block, and the rule down its edge says `code` without the model's syntax showing.
  assert.ok(!out.includes('```'), `a fence marker survived into the rendering:\n${JSON.stringify(out)}`);
  assert.equal(out.split('\n').length, 2, `the dropped markers left rows behind:\n${JSON.stringify(out)}`);
});

test('spill prints whole words only, and the line continues seamlessly after it', () => {
  let out = '';
  const stream = createProseStream({
    width: () => 80,
    color: false,
    charset: 'unicode',
    write: (text) => {
      out += text;
    },
  });
  stream.begin();
  stream.push('The Engineer is still working on the acc');
  stream.spill();
  assert.ok(out.endsWith('the'), `spill did not stop at a word boundary:\n${JSON.stringify(out)}`);
  assert.ok(!out.includes('acc'), 'a partial word was printed, and printed cannot be unprinted');
  stream.push('eptance gate now.');
  stream.end();
  assert.equal(out, '◆ The Engineer is still working on the acceptance gate now.');
});

test('spill holds an unclosed bold span, and the close renders it styled', () => {
  let out = '';
  const stream = createProseStream({
    width: () => 80,
    color: true,
    charset: 'unicode',
    write: (text) => {
      out += text;
    },
  });
  stream.begin();
  stream.push('So: **Question 1 (of');
  stream.spill();
  assert.ok(!out.includes('**'), `spill printed an unclosed marker:\n${JSON.stringify(out)}`);
  stream.push(' several)** follows.');
  stream.end();
  assert.ok(out.includes(`${BOLD}Question 1 (of several)${RESET}`), 'the closed span did not render bold');
  assert.ok(!out.includes('**'), 'a marker leaked into the transcript');
});

test('a stray unclosed marker prints literally at turn end, because it is the truth', () => {
  const out = prose(80, false, (s) => {
    s.push('the result of 2 ** 10');
  });
  assert.equal(out, '◆ the result of 2 ** 10');
});

test('an empty turn still gets its bare gutter, and ascii folds it', () => {
  let out = '';
  const stream = createProseStream({
    width: () => 80,
    color: false,
    charset: 'ascii',
    write: (text) => {
      out += text;
    },
  });
  stream.begin();
  stream.end();
  assert.equal(out, '#');
});

test('a word wider than the row hard-breaks at the width instead of at the terminal edge', () => {
  const out = prose(24, false, (s) => {
    s.push('see /Users/somebody/organizations/personal/agentic-army/src/view/prose.ts\n');
  });
  for (const row of out.split('\n')) {
    assert.ok(row.length <= 23, `a row reached the final column: ${JSON.stringify(row)}`);
  }
});

test('blank lines survive: a paragraph gap is part of what was said', () => {
  const out = prose(80, false, (s) => {
    s.push('first paragraph.\n\nsecond paragraph.\n');
  });
  assert.equal(out, '◆ first paragraph.\n\n  second paragraph.\n');
});

// ---- links ------------------------------------------------------------------------------------

test('parseInline: a link run carries its url, and brackets without one stay text', () => {
  assert.deepEqual(parseInline('see [docs](u.io) here'), [
    { text: 'see ', style: 'plain' },
    { text: 'docs', style: 'link', url: 'u.io' },
    { text: ' here', style: 'plain' },
  ]);
  // `array[0]` has a bracket and no destination: text, never a link.
  assert.deepEqual(parseInline('array[0] wins'), [{ text: 'array[0] wins', style: 'plain' }]);
});

test('firstOpenMarker: a link is open until all three of its delimiters have arrived', () => {
  assert.equal(firstOpenMarker('see [docs](u.io) ok'), -1);
  assert.equal(firstOpenMarker('see [docs'), 4);
  // The `]` is the last known character: the next chunk may bring the `(` that makes a link.
  assert.equal(firstOpenMarker('see [docs]'), 4);
  assert.equal(firstOpenMarker('see [docs](u.i'), 4);
  assert.equal(firstOpenMarker('see [docs] more'), -1);
});

test('a link renders its text cyan and its destination dim, or cyan alone when they match', () => {
  const out = prose(80, true, (s) => {
    s.push('read [the docs](https://ex.io/d) or [https://a.io](https://a.io) now\n');
  });
  assert.ok(
    out.includes(`${CYAN}the docs${RESET} ${DIM}(https://ex.io/d)${RESET}`),
    `the two halves are not two inks:\n${JSON.stringify(out)}`,
  );
  assert.ok(out.includes(`${CYAN}https://a.io${RESET} now`), 'a self-link repeats its url');
  assert.ok(!out.includes(']('), 'link markers reached the terminal');
});

test('colour off, a link is its text with the destination in parentheses, markers gone', () => {
  const out = prose(80, false, (s) => {
    s.push('read [the docs](https://ex.io/d).\n');
  });
  assert.equal(out, '◆ read the docs (https://ex.io/d).\n');
});

test('spill holds an unfinished link, and the close renders it whole', () => {
  let out = '';
  const stream = createProseStream({
    width: () => 80,
    color: false,
    charset: 'unicode',
    write: (text) => {
      out += text;
    },
  });
  stream.begin();
  stream.push('see [the ');
  stream.spill();
  assert.equal(out, '◆ see', `spill printed part of a pending link:\n${JSON.stringify(out)}`);
  stream.push('guide](http://g.io) now');
  stream.end();
  assert.equal(out, '◆ see the guide (http://g.io) now');
});

test('punctuation tight after a styled span wraps with the span, not on a row of its own', () => {
  const out = prose(80, false, (s) => {
    s.push('so [same](same). And `gate.ts`, then **bold**.\n');
  });
  assert.equal(out, '◆ so same. And gate.ts, then bold.\n');
});

// ---- horizontal rules -------------------------------------------------------------------------

test('a line of dashes renders as a dim rule, not as those characters', () => {
  const out = prose(80, true, (s) => {
    s.push('---\n');
  });
  assert.ok(out.includes(`${DIM}${'─'.repeat(40)}${RESET}`), `no rule:\n${JSON.stringify(out)}`);
  assert.ok(!out.replace(/\[\d+m/gu, '').includes('---'), 'the dashes leaked through');
  // Stars and underscores are the same rule, and colour off draws it plain.
  assert.equal(prose(80, false, (s) => s.push('***\n')), `◆ ${'─'.repeat(40)}\n`);
  assert.equal(prose(80, false, (s) => s.push('___\n')), `◆ ${'─'.repeat(40)}\n`);
});

test('a narrow terminal shortens the rule instead of wrapping it', () => {
  const out = prose(30, false, (s) => {
    s.push('---\n');
  });
  // usable 29, gutter 2: the rule spans 27 columns, under the 40 cap.
  assert.equal(out, `◆ ${'─'.repeat(27)}\n`);
});

test('ascii charset draws the rule in plain dashes', () => {
  let out = '';
  const stream = createProseStream({
    width: () => 80,
    color: false,
    charset: 'ascii',
    write: (text) => {
      out += text;
    },
  });
  stream.begin();
  stream.push('---\n');
  stream.end();
  assert.equal(out, `# ${'-'.repeat(40)}\n`);
});

test('dashes followed by words are a paragraph, not a rule', () => {
  const out = prose(80, false, (s) => {
    s.push('--- but wait\n');
  });
  assert.equal(out, '◆ --- but wait\n');
});

// ---- tables -----------------------------------------------------------------------------------

test('a table aligns every column to its widest cell, divider row included', () => {
  const out = prose(80, false, (s) => {
    s.push('| name | cost |\n|---|---|\n| cpt-01 | $8.86 |\n| c | $0.41 |\n');
    s.push('after.\n');
  });
  const rows = out.split('\n');
  assert.equal(rows[0], '◆ | name   | cost  |');
  assert.equal(rows[1], '  |────────|───────|');
  assert.equal(rows[2], '  | cpt-01 | $8.86 |');
  assert.equal(rows[3], '  | c      | $0.41 |');
  // The paragraph after the table is what flushed it.
  assert.equal(rows[4], '  after.');
});

test('inline styles apply inside cells and alignment measures the visible text', () => {
  const out = prose(80, true, (s) => {
    s.push('| **who** | note |\n| cpt-01 | ok |\n');
    s.push('done\n');
  });
  assert.ok(out.includes(`${BOLD}who${RESET}`), 'bold in a cell is not bold');
  assert.ok(!out.includes('**'), 'a marker reached a cell');
  const plain = out.replace(/\[\d+m/gu, '');
  // Markers stripped BEFORE measuring: the column is as wide as `cpt-01`, not `**who**`.
  assert.ok(plain.includes('| who    | note |'), `alignment counted the markers:\n${plain}`);
  assert.ok(plain.includes('| cpt-01 | ok   |'), `alignment is off:\n${plain}`);
});

test('spill never flushes a partial table; the turn end aligns it whole', () => {
  let out = '';
  const stream = createProseStream({
    width: () => 80,
    color: false,
    charset: 'unicode',
    write: (text) => {
      out += text;
    },
  });
  stream.begin();
  stream.push('| a | boo |\n| ccc ');
  stream.spill();
  assert.equal(out, '', `a partial table reached the terminal:\n${JSON.stringify(out)}`);
  stream.push('| d |\n');
  stream.end();
  assert.equal(out, '◆ | a   | boo |\n  | ccc | d   |\n');
});

test('a table wider than the terminal shrinks its widest column and wraps the cells into it', () => {
  const long = `| ${'alpha '.repeat(9).trim()} | ${'beta '.repeat(9).trim()} |`;
  const out = prose(40, false, (s) => {
    s.push(`${long}\n| a | b |\n`);
    s.push('done\n');
  });
  const rows = out.split('\n').filter((row) => row.includes('|'));
  // Every row of the table fits, and every one is the SAME width: that is what alignment means,
  // and it is the thing the old raw-lines fallback could not give. A hundred-column window makes
  // almost every table a model writes too wide, so this path is the normal one, not the corner.
  const widths = new Set(rows.map((row) => row.length));
  assert.equal(widths.size, 1, `the table rows are ragged:\n${out}`);
  assert.ok((rows[0] ?? '').length <= 39, `the table overruns the window:\n${out}`);
  // The wrap is inside the cells, so the words are all still there, in order.
  assert.equal((out.match(/alpha/gu) ?? []).length, 9, `words were lost in the wrap:\n${out}`);
  assert.equal((out.match(/beta/gu) ?? []).length, 9, `words were lost in the wrap:\n${out}`);
});

test('a table with more columns than the window can seat still falls back to raw dim lines', () => {
  const many = `| ${['a', 'b', 'c', 'd', 'e', 'f'].join(' | ')} |`;
  const out = prose(24, true, (s) => {
    s.push(`${many}\n`);
    s.push('done\n');
  });
  assert.ok(out.includes(`${DIM}${many}${RESET}`), `the unseatable row is not raw and dim:\n${out}`);
});

// The fence body goes through the highlighter (src/view/highlight.ts); these assert the WIRING,
// not the grammar, which has its own suite in test/highlight.test.ts.

const GREEN = '\u001b[32m';

test('a fenced block with a language highlights: keywords cyan, strings green, rest dim', () => {
  const out = prose(80, true, (s) => {
    s.push("```js\nconst x = 'hi';\n```\n");
  });
  assert.ok(out.includes(`${CYAN}const${RESET}`), `the keyword is not cyan:\n${JSON.stringify(out)}`);
  assert.ok(out.includes(`${GREEN}'hi'${RESET}`), `the string is not green:\n${JSON.stringify(out)}`);
  // The info string still picks the language even though its line never prints.
  assert.ok(!out.includes('```'), `a fence marker survived into the rendering:\n${JSON.stringify(out)}`);
});

test('a fence with no language stays exactly the dim block it was before highlighting existed', () => {
  const out = prose(80, true, (s) => {
    s.push('```\nwords with no grammar\n```\n');
  });
  assert.ok(out.includes(`${DIM}words with no grammar${RESET}`), `unhighlighted body is not one dim run:\n${out}`);
});

test('highlight state does not leak between fences: a block comment left open dies with its block', () => {
  const out = prose(80, true, (s) => {
    s.push('```js\n/* never closed\n```\n');
    s.push('```js\nreturn 1;\n```\n');
  });
  assert.ok(out.includes(`${CYAN}return${RESET}`), `the second fence inherited comment state:\n${out}`);
});
