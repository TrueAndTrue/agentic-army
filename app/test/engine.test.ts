import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createRun, startRun, type EngineDeps } from '../src/main/flow/engine.ts';
import { defaultNodeData, renderTemplate, validateFlow } from '../src/shared/flow.ts';
import type { Flow, FlowEdge, FlowNode, Judgment, NodeType, Run } from '../src/shared/types.ts';

function node<T extends NodeType>(id: string, type: T, data: Partial<FlowNode['data']> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { ...defaultNodeData(type), label: id, ...data } } as FlowNode;
}

function edge(source: string, sourceHandle: string, target: string): FlowEdge {
  return { id: `${source}.${sourceHandle}->${target}`, source, sourceHandle, target };
}

function flow(nodes: FlowNode[], edges: FlowEdge[]): Flow {
  return { id: 'f', name: 'test', description: '', nodes, edges, updatedAt: '' };
}

interface FakeLog {
  agentPrompts: { node: string; prompt: string; resume?: string }[];
  shells: string[];
}

function deps(over: Partial<EngineDeps> = {}, log: FakeLog = { agentPrompts: [], shells: [] }): EngineDeps {
  return {
    projectPath: '/project',
    async workspace() {
      return '/worktree';
    },
    async agent(req) {
      log.agentPrompts.push({ node: req.node.id, prompt: req.prompt, ...(req.resume ? { resume: req.resume } : {}) });
      return { turn: { text: `${req.node.id} did: ${req.prompt.split('\n')[0]}`, tools: [], status: 'done', costUsd: 0.01, tokens: { input: 100, cached: 60, output: 7, context: 107 } }, harnessSessionId: `s-${req.node.id}` };
    },
    async judge({ config }): Promise<Judgment> {
      return { mode: config.mode, answer: config.mode === 'yesno' ? 'yes' : (config.options[0]?.key ?? 'a'), probabilities: {}, confidence: 0.9, value: 0.9 };
    },
    async shell({ command }) {
      log.shells.push(command);
      return { code: 0, output: 'ok' };
    },
    async git() {
      return { ok: true, output: 'committed' };
    },
    async browser() {
      return { ok: true, output: 'browsed' };
    },
    async subflow({ objective }) {
      return { ok: true, output: `sub-run did: ${objective}`, runId: 'child' };
    },
    ...over,
  };
}

async function run(f: Flow, d: EngineDeps, objective = 'add multiply'): Promise<Run> {
  const r = createRun({ id: 'r1', flow: f, sessionId: 's', projectId: 'p', objective });
  return startRun(r, d, () => {}).done;
}

describe('templates', () => {
  test('fill objective, input, visit and named nodes; unknown names render empty', () => {
    const out = renderTemplate('{{objective}}|{{input}}|{{visit}}|{{nodes.plan}}|{{nodes.nope}}|{{what}}', {
      objective: 'O',
      input: 'I',
      visit: 2,
      nodes: { plan: 'P' },
    });
    assert.equal(out, 'O|I|2|P||');
  });
});

describe('validation', () => {
  test('a flow with no start, a dangling handle and an empty prompt is refused', () => {
    const f = flow([node('a', 'agent', { prompt: ' ' }), node('b', 'end')], [edge('a', 'nope', 'b')]);
    const errors = validateFlow(f).filter((p) => p.level === 'error').map((p) => p.message);
    assert.ok(errors.some((m) => m.includes('Start')));
    assert.ok(errors.some((m) => m.includes('no "nope" output')));
    assert.ok(errors.some((m) => m.includes('no prompt')));
  });

  test('the engine refuses to start a flow with errors and says why', async () => {
    const r = await run(flow([node('end', 'end')], []), deps());
    assert.equal(r.status, 'failed');
    assert.match(r.error ?? '', /Start/);
  });

  test('two nodes with the same name are an error, since templates address them by name', () => {
    const f = flow([node('start', 'start'), node('x', 'agent', { label: 'Build' }), node('y', 'agent', { label: 'build' })], []);
    assert.ok(validateFlow(f).some((p) => p.level === 'error' && p.message.includes('named')));
  });
});

describe('running a flow', () => {
  test('a straight line passes each output on and ends with the End template', async () => {
    const log: FakeLog = { agentPrompts: [], shells: [] };
    const f = flow(
      [
        node('start', 'start'),
        node('plan', 'agent', { prompt: 'Plan {{objective}}' }),
        node('build', 'agent', { prompt: 'Build from: {{input}}' }),
        node('end', 'end', { template: 'Plan was: {{nodes.plan}}' }),
      ],
      [edge('start', 'out', 'plan'), edge('plan', 'out', 'build'), edge('build', 'out', 'end')],
    );
    const r = await run(f, deps({}, log));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(log.agentPrompts.map((p) => p.prompt), ['Plan add multiply', 'Build from: plan did: Plan add multiply']);
    assert.equal(r.result, 'Plan was: plan did: Plan add multiply');
    assert.equal(r.costUsd, 0.02);
    assert.deepEqual(r.tokens, { input: 200, cached: 120, output: 14 }, 'two agents added up, with no context: each had its own');
    assert.deepEqual(r.tokens, { input: 200, cached: 120, output: 14 }, 'two agents added up, with no context: each had its own');
    assert.equal(r.nodes['build']?.status, 'done');
  });

  test('a loop runs until the decision says yes, feeding the review back each time', async () => {
    const log: FakeLog = { agentPrompts: [], shells: [] };
    let reviews = 0;
    const f = flow(
      [
        node('start', 'start'),
        node('build', 'agent', { prompt: 'Build. Feedback: {{input}}', keepContext: true, maxVisits: 5 }),
        node('check', 'decide', { mode: 'yesno' }),
        node('end', 'end'),
      ],
      [edge('start', 'out', 'build'), edge('build', 'out', 'check'), edge('check', 'yes', 'end'), edge('check', 'no', 'build')],
    );
    const r = await run(
      f,
      deps(
        {
          async judge({ config }) {
            reviews += 1;
            const yes = reviews >= 3;
            return { mode: config.mode, answer: yes ? 'yes' : 'no', probabilities: {}, confidence: 1, value: yes ? 0.9 : 0.1 };
          },
        },
        log,
      ),
    );
    assert.equal(r.status, 'succeeded');
    assert.equal(r.nodes['build']?.visits.length, 3);
    // keepContext: the second and third visits resume the first conversation.
    assert.equal(log.agentPrompts[0]?.resume, undefined);
    assert.equal(log.agentPrompts[1]?.resume, 's-build');
    assert.equal(log.agentPrompts[2]?.resume, 's-build');
  });

  test('a loop that never settles stops at the visit limit, and the run says which node', async () => {
    const f = flow(
      [node('start', 'start'), node('build', 'agent', { maxVisits: 2 }), node('check', 'decide', { mode: 'yesno' })],
      [edge('start', 'out', 'build'), edge('build', 'out', 'check'), edge('check', 'no', 'build')],
    );
    const r = await run(
      f,
      deps({ judge: async ({ config }) => ({ mode: config.mode, answer: 'no', probabilities: {}, confidence: 1, value: 0 }) }),
    );
    assert.equal(r.status, 'failed');
    assert.match(r.error ?? '', /"build" reached its limit of 2 visits/);
  });

  test('parallel branches meet at a Join, which fires once with both outputs', async () => {
    const f = flow(
      [node('start', 'start'), node('a', 'agent'), node('b', 'agent'), node('join', 'join'), node('end', 'end')],
      [edge('start', 'out', 'a'), edge('start', 'out', 'b'), edge('a', 'out', 'join'), edge('b', 'out', 'join'), edge('join', 'out', 'end')],
    );
    let concurrent = 0;
    let peak = 0;
    const r = await run(
      f,
      deps({
        async agent(req) {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((res) => setTimeout(res, 20));
          concurrent -= 1;
          return { turn: { text: `${req.node.id} out`, tools: [], status: 'done' } };
        },
      }),
    );
    assert.equal(peak, 2);
    assert.equal(r.nodes['join']?.visits.length, 1);
    assert.match(r.result ?? '', /## a\n\na out/);
    assert.match(r.result ?? '', /## b\n\nb out/);
  });

  test('a Choice routes on the option Jev picked, and low confidence takes unsure', async () => {
    const f = flow(
      [
        node('start', 'start'),
        node('route', 'decide', { mode: 'choice', options: [{ key: 'bug', description: '' }, { key: 'feature', description: '' }], minConfidence: 0.6 }),
        node('fix', 'end', { template: 'fix' }),
        node('build', 'end', { template: 'build' }),
        node('ask', 'end', { template: 'ask' }),
      ],
      [edge('start', 'out', 'route'), edge('route', 'bug', 'fix'), edge('route', 'feature', 'build'), edge('route', 'unsure', 'ask')],
    );
    const sure = await run(f, deps({ judge: async () => ({ mode: 'choice', answer: 'feature', probabilities: { feature: 0.9 }, confidence: 0.8 }) }));
    assert.equal(sure.result, 'build');
    const unsure = await run(f, deps({ judge: async () => ({ mode: 'choice', answer: 'bug', probabilities: { bug: 0.5 }, confidence: 0.3 }) }));
    assert.equal(unsure.result, 'ask');
  });

  test('an agent failure takes the error edge when one is wired, and fails the run when not', async () => {
    const failing = deps({ agent: async () => ({ turn: { text: '', tools: [], status: 'error', error: 'rate limited' } }) });
    const wired = flow(
      [node('start', 'start'), node('build', 'agent'), node('recover', 'end', { template: 'recovered: {{input}}' })],
      [edge('start', 'out', 'build'), edge('build', 'error', 'recover')],
    );
    const a = await run(wired, failing);
    assert.equal(a.status, 'succeeded');
    assert.match(a.result ?? '', /recovered: build failed: rate limited/);

    const bare = flow([node('start', 'start'), node('build', 'agent'), node('end', 'end')], [edge('start', 'out', 'build'), edge('build', 'out', 'end')]);
    const b = await run(bare, failing);
    assert.equal(b.status, 'failed');
    assert.match(b.error ?? '', /"build" failed: rate limited/);
  });

  test('a shell node routes on the exit code and passes the output on', async () => {
    const f = flow(
      [node('start', 'start'), node('test', 'shell', { command: 'npm test' }), node('ok', 'end', { template: 'green' }), node('bad', 'end', { template: 'red: {{input}}' })],
      [edge('start', 'out', 'test'), edge('test', 'pass', 'ok'), edge('test', 'fail', 'bad')],
    );
    const r = await run(f, deps({ shell: async () => ({ code: 1, output: '1 failing' }) }));
    assert.match(r.result ?? '', /^red: Command: npm test\nExit code: 1\n\n1 failing/);
  });
});

describe('a person in the loop', () => {
  test('the run waits on an approval, and a rejection carries the note onward', async () => {
    const f = flow(
      [node('start', 'start'), node('gate', 'human', { prompt: 'Ship {{input}}?' }), node('yes', 'end', { template: 'shipped' }), node('no', 'end', { template: '{{input}}' })],
      [edge('start', 'out', 'gate'), edge('gate', 'approve', 'yes'), edge('gate', 'reject', 'no')],
    );
    const r = createRun({ id: 'r', flow: f, sessionId: 's', projectId: 'p', objective: 'v2' });
    const seen: string[] = [];
    const handle = startRun(r, deps(), (x) => seen.push(x.status));
    while (r.pending.length === 0) await new Promise((res) => setTimeout(res, 1));
    assert.equal(r.status, 'waiting');
    assert.equal(r.pending[0]?.body, 'Ship v2?');
    assert.equal(handle.answer('nope', true, ''), false);
    handle.answer(r.pending[0]!.id, false, 'needs a changelog');
    const done = await handle.done;
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result, 'v2\n\nFrom the person reviewing: needs a changelog');
    assert.ok(seen.includes('waiting'));
  });

  test('stop ends a waiting run as stopped, not failed', async () => {
    const f = flow([node('start', 'start'), node('gate', 'human'), node('end', 'end')], [edge('start', 'out', 'gate'), edge('gate', 'approve', 'end')]);
    const r = createRun({ id: 'r', flow: f, sessionId: 's', projectId: 'p', objective: 'x' });
    const handle = startRun(r, deps(), () => {});
    while (r.pending.length === 0) await new Promise((res) => setTimeout(res, 1));
    handle.stop();
    const done = await handle.done;
    assert.equal(done.status, 'stopped');
    assert.equal(done.nodes['gate']?.status, 'stopped');
    assert.equal(done.pending.length, 0);
  });

  test('stop reaches a running agent through its signal', async () => {
    const f = flow([node('start', 'start'), node('build', 'agent'), node('end', 'end')], [edge('start', 'out', 'build'), edge('build', 'out', 'end')]);
    const r = createRun({ id: 'r', flow: f, sessionId: 's', projectId: 'p', objective: 'x' });
    let aborted = false;
    const handle = startRun(
      r,
      deps({
        agent: (req) =>
          new Promise((resolve) => {
            req.signal.addEventListener('abort', () => {
              aborted = true;
              resolve({ turn: { text: '', tools: [], status: 'stopped' } });
            });
          }),
      }),
      () => {},
    );
    await new Promise((res) => setTimeout(res, 5));
    handle.stop();
    const done = await handle.done;
    assert.equal(aborted, true);
    assert.equal(done.status, 'stopped');
    assert.equal(done.nodes['end']?.visits.length, 0);
  });
});

describe('the flows that ship with the app', async () => {
  const { BUILTIN_FLOWS } = await import('../src/main/templates.ts');
  for (const f of BUILTIN_FLOWS) {
    test(`"${f.name}" has no errors and no warnings`, () => {
      assert.deepEqual(validateFlow(f), []);
    });
  }

  test('"Build and review" loops back to Build on a failed review and finishes on a passing one', async () => {
    const f = BUILTIN_FLOWS.find((x) => x.id === 'builtin-main-flow')!;
    let reviews = 0;
    const r = createRun({ id: 'r', flow: f, sessionId: 's', projectId: 'p', objective: 'add divide' });
    const handle = startRun(
      r,
      deps({
        async workspace(run) {
          run.branch = 'army/run-x';
          return '/wt';
        },
        async judge({ config }) {
          reviews += 1;
          const yes = reviews > 1;
          return { mode: config.mode, answer: yes ? 'yes' : 'no', probabilities: {}, confidence: 1, value: yes ? 1 : 0 };
        },
      }),
      () => {},
    );
    for (let answered = 0; answered < 2; ) {
      await new Promise((res) => setTimeout(res, 1));
      const q = r.pending[0];
      if (q !== undefined) {
        handle.answer(q.id, true, '');
        answered += 1;
      }
    }
    const done = await handle.done;
    assert.equal(done.status, 'succeeded');
    assert.equal(done.nodes['build']?.visits.length, 2);
    assert.equal(done.nodes['review']?.visits.length, 2);
    assert.match(done.result ?? '', /^Finished on branch army\/run-x\./);
  });
});
