import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createRun, startRun, type EngineDeps } from '../src/main/flow/engine.ts';
import { startFlowBridge, type ToolCaller } from '../src/main/flowTools.ts';
import { BUILTIN_FLOWS } from '../src/main/templates.ts';
import { defaultNodeData, flowCommand, invokeLevel, mayStart, parseFlowCommand, validateFlow } from '../src/shared/flow.ts';
import type { Flow, FlowNode, InvokeLevel } from '../src/shared/types.ts';

const quick = BUILTIN_FLOWS.find((f) => f.id === 'builtin-quick-fix')!;
const flowAt = (invoke: InvokeLevel | undefined): Flow => {
  const { invoke: _shipped, ...rest } = quick;
  return invoke === undefined ? rest : { ...rest, invoke };
};

describe('who may start a flow', () => {
  test('a flow is held to the ceiling in Settings, and a flow from before this counts as auto', () => {
    assert.equal(invokeLevel(flowAt('agent'), { invokeCeiling: 'agent-ask' }), 'agent-ask');
    assert.equal(invokeLevel(flowAt('you'), { invokeCeiling: 'agent' }), 'you');
    assert.equal(invokeLevel(flowAt(undefined), {}), 'auto');
    assert.equal(invokeLevel(flowAt('agent'), {}), 'agent', 'with no limit set, the flow decides');
    assert.equal(invokeLevel(flowAt('agent-ask'), {}), 'agent-ask');
  });

  test('Jev may pick auto and above; an agent starts only agent flows, and asks for agent-ask ones', () => {
    const cases: [InvokeLevel, 'yes' | 'no', 'yes' | 'ask' | 'no'][] = [
      ['you', 'no', 'no'],
      ['auto', 'yes', 'no'],
      ['agent-ask', 'yes', 'ask'],
      ['agent', 'yes', 'yes'],
    ];
    for (const [level, jev, agent] of cases) {
      const f = flowAt(level);
      assert.equal(mayStart(f, { invokeCeiling: 'agent' }, 'jev'), jev, `${level}: jev`);
      assert.equal(mayStart(f, { invokeCeiling: 'agent' }, 'agent'), agent, `${level}: agent`);
    }
    assert.equal(mayStart(flowAt('agent'), { invokeCeiling: 'you' }, 'jev'), 'no', 'a ceiling of "you" turns Auto off for every flow');
  });
});

describe('slash commands', () => {
  test('/name runs the flow with the rest as its objective; a path is not a command', () => {
    assert.equal(flowCommand({ name: 'Build and review' }), 'build-and-review');
    assert.deepEqual(parseFlowCommand('/quick-fix add multiply\nand a test', BUILTIN_FLOWS)?.objective, 'add multiply\nand a test');
    assert.equal(parseFlowCommand('/QUICK-FIX x', BUILTIN_FLOWS)?.flow.id, 'builtin-quick-fix');
    assert.equal(parseFlowCommand('/quick-fix', BUILTIN_FLOWS)?.objective, '');
    assert.equal(parseFlowCommand('/Users/me/app is broken', BUILTIN_FLOWS), null);
    assert.equal(parseFlowCommand('please /quick-fix it', BUILTIN_FLOWS), null);
  });
});

describe('the Run flow node', () => {
  const withNode = (data: Partial<Extract<FlowNode, { type: 'flow' }>['data']>): Flow => ({
    id: 'outer',
    name: 'Outer',
    description: '',
    updatedAt: '',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
      { id: 'sub', type: 'flow', position: { x: 1, y: 0 }, data: { ...(defaultNodeData('flow') as Extract<FlowNode, { type: 'flow' }>['data']), label: 'Fix it', ...data } },
      { id: 'ok', type: 'end', position: { x: 2, y: 0 }, data: { label: 'Ok', template: 'ok: {{input}}' } },
      { id: 'bad', type: 'end', position: { x: 2, y: 1 }, data: { label: 'Bad', template: 'bad: {{input}}' } },
    ],
    edges: [
      { id: 'e1', source: 'start', sourceHandle: 'out', target: 'sub' },
      { id: 'e2', source: 'sub', sourceHandle: 'done', target: 'ok' },
      { id: 'e3', source: 'sub', sourceHandle: 'failed', target: 'bad' },
    ],
  });

  test('a node with no flow, one that runs its own flow, or a deleted one is refused', () => {
    const msg = (f: Flow) => validateFlow(f, undefined, new Set(['builtin-quick-fix', 'outer'])).filter((p) => p.level === 'error').map((p) => p.message);
    assert.match(msg(withNode({ flowId: '' })).join(), /does not say which flow/);
    assert.match(msg(withNode({ flowId: 'outer' })).join(), /runs this same flow/);
    assert.match(msg(withNode({ flowId: 'gone' })).join(), /no longer exists/);
    assert.deepEqual(msg(withNode({ flowId: 'builtin-quick-fix' })), []);
  });

  test('it renders its objective, waits for the other run, and leaves by done or failed', async () => {
    const asked: string[] = [];
    const deps = (ok: boolean): EngineDeps =>
      ({
        projectPath: '/p',
        workspace: async () => '/w',
        subflow: async ({ objective }: { objective: string }) => {
          asked.push(objective);
          return { ok, output: ok ? 'multiply added' : 'the review never passed', runId: 'child' };
        },
      }) as unknown as EngineDeps;
    const flow = withNode({ flowId: 'builtin-quick-fix', objective: 'Do this: {{input}}' });
    const good = await startRun(createRun({ id: 'r1', flow, sessionId: 's', projectId: 'p', objective: 'add multiply' }), deps(true), () => {}).done;
    assert.equal(good.result, 'ok: multiply added');
    assert.deepEqual(asked, ['Do this: add multiply']);
    assert.equal(good.nodes['sub']?.visits[0]?.log, 'Run child');
    const bad = await startRun(createRun({ id: 'r2', flow, sessionId: 's', projectId: 'p', objective: 'x' }), deps(false), () => {}).done;
    assert.equal(bad.result, 'bad: the review never passed');
  });
});

/** Speak to the MCP script the way claude and codex do: start it, JSON-RPC on stdio. */
interface RpcReply {
  id: number;
  result?: { tools?: { name: string; description: string }[]; content?: { text: string }[]; isError?: boolean };
  error?: unknown;
}

async function mcpSession(spec: { command: string; args: string[]; env: Record<string, string> }) {
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<number, (m: RpcReply) => void>();
  let buf = '';
  let n = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    for (let k = buf.indexOf('\n'); k >= 0; k = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, k)) as RpcReply;
      buf = buf.slice(k + 1);
      waiting.get(m.id)?.(m);
    }
  });
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<RpcReply>((res) => {
      n += 1;
      waiting.set(n, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  return { rpc, close: () => child.kill() };
}

describe('the start_flow bridge', () => {
  test('the script lists and calls through to the app, which knows the session; a closed key starts nothing', async () => {
    const calls: { caller: ToolCaller; args: Record<string, unknown> }[] = [];
    const bridge = await startFlowBridge(
      mkdtempSync(join(tmpdir(), 'bridge-')),
      {
        list: (caller) => [{ name: 'start_flow', description: `flows for ${caller.model}`, inputSchema: { type: 'object' } }],
        call: (caller, _name, args) => {
          calls.push({ caller, args });
          return { text: `started ${String(args['flow'])}` };
        },
      },
      { command: process.execPath, env: {} },
    );
    const turn = bridge.open({ sessionId: 's1', model: 'Sonnet 5', flows: true, web: false });
    const mcp = await mcpSession(turn.spec);
    try {
      const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18' });
      assert.ok(init.result !== undefined);
      assert.equal((await mcp.rpc('tools/list')).result?.tools?.[0]?.description, 'flows for Sonnet 5');
      const res = await mcp.rpc('tools/call', { name: 'start_flow', arguments: { flow: 'quick-fix', objective: 'x' } });
      assert.equal(res.result?.content?.[0]?.text, 'started quick-fix');
      assert.deepEqual(calls[0]?.caller, { sessionId: 's1', model: 'Sonnet 5', flows: true, web: false });

      turn.close();
      const late = await mcp.rpc('tools/call', { name: 'start_flow', arguments: { flow: 'quick-fix', objective: 'y' } });
      assert.equal(late.result?.isError, true);
      assert.match(late.result?.content?.[0]?.text ?? '', /not live/);
      assert.equal(calls.length, 1, 'the call after the turn ended never reached the app');
    } finally {
      mcp.close();
      bridge.stop();
    }
  });
});
