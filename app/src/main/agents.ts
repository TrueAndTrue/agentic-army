/**
 * One agent turn on claude or codex, through the engine's own adapters.
 *
 * The permission set comes from `permissionsFor`, the same function the CLI's campaigns use, so a
 * Reviewer here holds exactly what an INSPECTOR holds there. Nothing in this file widens a loadout.
 */

import { randomUUID } from 'node:crypto';

import { createClaudeAdapter } from '../../../src/harness/claude.ts';
import { createCodexAdapter } from '../../../src/harness/codex.ts';
import { killSoldierTree } from '../../../src/harness/kill.ts';
import { permissionsFor } from '../../../src/command/permissions.ts';
import { armyHome } from '../../../src/config/paths.ts';
import type { HarnessAdapter, Soldier, SoldierEvent, SoldierSpec } from '../../../src/contracts/harness.ts';
import type { Rank, Role } from '../../../src/contracts/ranks.ts';
import type { AgentRole, AgentTurn, Effort, Harness, Settings } from '../shared/types.ts';

export const ROLE_UNITS: Record<AgentRole, { rank: Rank; role: Role }> = {
  scout: { rank: 'CAPTAIN', role: 'SCOUT' },
  planner: { rank: 'MAJOR', role: 'OVERSEER' },
  engineer: { rank: 'CAPTAIN', role: 'ENGINEER' },
  reviewer: { rank: 'CAPTAIN', role: 'INSPECTOR' },
  validator: { rank: 'CAPTAIN', role: 'VALIDATOR' },
};

const ROLE_BRIEF: Record<AgentRole, string> = {
  scout: 'You are a scout. Read what you need and report facts with file paths. Change nothing.',
  planner: 'You are a planner. Read the code and write a plan someone else will carry out. You cannot edit or run anything.',
  engineer: 'You are an engineer. Make the change in this working directory and check it runs.',
  reviewer:
    'You are a reviewer. Read the change and run the checks. You cannot edit files. Say plainly whether it is correct, and list every problem with its file and line.',
  validator: 'You are a validator. Run the checks and judge the result against the objective. You cannot edit files.',
};

/** Every agent process alive right now, so quitting the app can take them all down with it. */
const live = new Set<Soldier>();

/**
 * Kill every running agent's whole process tree, now. Agents run in their own process group, so
 * without this an app that quits leaves them running with nobody reading their output.
 */
export function killAllAgents(): number {
  let n = 0;
  for (const s of live) if (killSoldierTree(s)) n += 1;
  live.clear();
  return n;
}

export function liveAgentCount(): number {
  return live.size;
}

export interface AgentRunInput {
  harness: Harness;
  model: string;
  effort: Effort;
  role: AgentRole;
  cwd: string;
  prompt: string;
  /** A name for the process: `review-2`. */
  label: string;
  /** Put the role's brief in front of the prompt. Chats skip it. */
  brief: boolean;
  resume?: string;
  settings: Settings;
  signal: AbortSignal;
  onTurn(turn: AgentTurn): void;
  /** Tests inject a fake adapter. */
  adapter?: HarnessAdapter;
}

export interface AgentRunResult {
  turn: AgentTurn;
  harnessSessionId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STR_FIELDS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];

/** One readable line for a tool call. */
export function summarizeTool(name: string, input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  if (Array.isArray(rec['changes'])) {
    const paths = (rec['changes'] as unknown[])
      .map((c) => (c !== null && typeof c === 'object' ? (c as Record<string, unknown>)['path'] : undefined))
      .filter((p): p is string => typeof p === 'string');
    if (paths.length > 0) return paths.join(', ');
  }
  for (const f of STR_FIELDS) {
    const v = rec[f];
    if (typeof v === 'string' && v.trim() !== '') return v.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).join(' ').slice(0, 200);
  }
  return name === 'TodoWrite' ? 'updated its task list' : '';
}

/** Pretty names for codex item types. */
function toolName(name: string): string {
  if (name === 'command_execution') return 'Shell';
  if (name === 'file_change') return 'Edit';
  if (name === 'web_search') return 'WebSearch';
  if (name === 'mcp_tool_call') return 'MCP';
  return name;
}

export function makeAdapter(harness: Harness, settings: Settings): HarnessAdapter {
  if (harness === 'claude') {
    return createClaudeAdapter({
      partialMessages: true,
      closeGraceMs: 10_000,
      ...(settings.claudeBin.trim() === '' ? {} : { bin: settings.claudeBin.trim() }),
    });
  }
  return createCodexAdapter(settings.codexBin.trim() === '' ? {} : { bin: settings.codexBin.trim() });
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const unit = ROLE_UNITS[input.role];
  // The protected region is the army's own home (~/.agentic-army), where the CLI keeps its config
  // and archive. Never the user's home directory: that would deny every project under it.
  const perms = permissionsFor(unit.rank, unit.role, armyHome(), input.settings.posture);
  const orders = input.brief
    ? `${ROLE_BRIEF[input.role]}\n\nWorking directory: ${input.cwd}\nEnd with a short summary: it is what the next step of the flow receives.\n\n---\n\n${input.prompt}`
    : input.prompt;
  const spec: SoldierSpec = {
    agentId: input.label,
    rank: unit.rank,
    role: unit.role,
    harness: input.harness,
    ...(input.model === '' ? {} : { model: input.model }),
    effort: input.effort,
    cwd: input.cwd,
    sessionId: randomUUID(),
    allow: perms.allow,
    deny: perms.deny,
    posture: input.settings.posture,
    orders,
    ...(input.resume === undefined ? {} : { resumeSessionId: input.resume }),
  };

  const turn: AgentTurn = { text: '', final: '', tools: [], status: 'running' };
  const emit = () => input.onTurn({ ...turn, tools: turn.tools.map((t) => ({ ...t })) });
  if (input.signal.aborted) return { turn: { ...turn, status: 'stopped' } };

  const adapter = input.adapter ?? makeAdapter(input.harness, input.settings);
  const soldier = await adapter.spawn(spec);
  live.add(soldier);
  let harnessSessionId: string | undefined = input.resume;
  let afterTool = false;
  const errors: string[] = [];
  let resultSeen: (SoldierEvent & { type: 'result' }) | null = null;
  let stopped = false;

  const onAbort = () => {
    stopped = true;
    soldier.interrupt().catch(() => {});
    // An interrupt is a request. The kill is what makes stop mean stop.
    setTimeout(() => killSoldierTree(soldier), 1500).unref();
  };
  input.signal.addEventListener('abort', onAbort, { once: true });

  let resolveResult: () => void = () => {};
  const resultArrived = new Promise<void>((r) => (resolveResult = r));

  const debug = process.env['ARMY_DEBUG_AGENT'] === '1' ? (m: string) => console.error(`[agent ${input.label}] ${m}`) : () => {};
  const pump = (async () => {
    try {
      for await (const ev of soldier.stream()) {
        debug(
          `event ${ev.type}${ev.type === 'result' ? ` ${ev.status}` : ''}${ev.type === 'unknown' ? ` ${ev.harnessType ?? ''} ${JSON.stringify(ev.raw).slice(0, 160)}` : ''}`,
        );
        switch (ev.type) {
          case 'ready':
            // Keep only an id the harness will take back: claude resumes by UUID only.
            if (ev.sessionId !== '' && (input.harness !== 'claude' || UUID_RE.test(ev.sessionId))) harnessSessionId = ev.sessionId;
            break;
          case 'assistant_text':
            if (ev.depth !== 0) break;
            if (afterTool) {
              if (turn.text !== '' && !turn.text.endsWith('\n\n')) turn.text += '\n\n';
              turn.final = '';
              afterTool = false;
            }
            turn.text += ev.text;
            turn.final = (turn.final ?? '') + ev.text;
            emit();
            break;
          case 'tool_use':
            if (ev.depth !== 0) break;
            turn.tools.push({ id: ev.toolUseId, name: toolName(ev.name), summary: summarizeTool(ev.name, ev.input), status: 'running' });
            afterTool = true;
            emit();
            break;
          case 'tool_result': {
            const t = turn.tools.find((x) => x.id === ev.toolUseId);
            if (t !== undefined) {
              t.status = ev.isError ? 'error' : 'ok';
              emit();
            }
            break;
          }
          case 'error':
            errors.push(ev.message);
            break;
          case 'result':
            resultSeen = ev;
            if (ev.costUsd !== undefined) turn.costUsd = (turn.costUsd ?? 0) + ev.costUsd;
            resolveResult();
            break;
          default:
            break;
        }
      }
    } finally {
      // Whatever ended the stream, the turn stops waiting for a result that will not come.
      debug('stream ended');
      resolveResult();
    }
  })();

  try {
    await soldier.send(spec.orders);
    debug('sent');
    await resultArrived;
    debug('result arrived');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const closed = await soldier.close().catch(() => null);
  debug(`closed ${JSON.stringify(closed)}`);
  // The process has exited. Its stdout normally ends with it, but a grandchild the agent started
  // can hold the pipe open forever, so the turn does not wait on the stream past a short grace.
  await Promise.race([
    pump.catch((err: unknown) => errors.push(err instanceof Error ? err.message : String(err))),
    new Promise((r) => setTimeout(r, 3000).unref()),
  ]);
  debug('pump done');
  input.signal.removeEventListener('abort', onAbort);
  live.delete(soldier);

  const result = resultSeen as (SoldierEvent & { type: 'result' }) | null;
  const status = result?.status ?? closed?.status ?? 'error';
  if (turn.costUsd === undefined && closed?.costUsd !== undefined) turn.costUsd = closed.costUsd;
  if (stopped || status === 'interrupted' || status === 'killed') turn.status = 'stopped';
  else if (status === 'ok') turn.status = 'done';
  else {
    turn.status = 'error';
    turn.error = errors.at(-1) ?? (status === 'timeout' ? 'The agent ran out of time.' : `The agent exited with status ${status}.`);
  }
  turn.tools = turn.tools.map((t) => (t.status === 'running' ? { ...t, status: turn.status === 'done' ? 'ok' : 'error' } : t));
  emit();
  return { turn, ...(harnessSessionId === undefined ? {} : { harnessSessionId }) };
}
