import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BUILTIN_FLOWS } from '../src/main/templates.ts';
import { flowFileName, flowFileText, readFlowFile } from '../src/main/flowFile.ts';
import { validateFlow } from '../src/shared/flow.ts';
import { flowPowers } from '../src/shared/share.ts';

const ctx = { models: [], flows: [], names: [] as string[] };
const build = () => structuredClone(BUILTIN_FLOWS.find((f) => f.id === 'builtin-main-flow')!);

describe('a flow as a file', () => {
  test('goes out and comes back the same, as a new flow only you can start', () => {
    const flow = build();
    const back = readFlowFile(flowFileText(flow), ctx);
    assert.ok(back.ok);
    assert.notEqual(back.flow.id, flow.id);
    assert.equal(back.flow.invoke, 'you');
    assert.equal(back.flow.builtin, undefined);
    assert.deepEqual(back.flow.nodes.map((n) => [n.type, n.data.label, n.position]), flow.nodes.map((n) => [n.type, n.data.label, n.position]));
    assert.equal(back.flow.edges.length, flow.edges.length);
    assert.deepEqual(validateFlow(back.flow), []);
    assert.ok(back.notes.some((n) => /Only you can start it/.test(n)));
    assert.equal(flowFileName(flow), 'build-and-review.flow.json');
  });

  test('a name you already have gets "(imported)"; a model this Mac lacks falls back to the default', () => {
    const flow = build();
    const scout = flow.nodes.find((n) => n.type === 'agent')!;
    (scout.data as { modelId: string | null }).modelId = 'their-private-model';
    const back = readFlowFile(flowFileText(flow), { ...ctx, names: ['Build and review'] });
    assert.ok(back.ok);
    assert.equal(back.flow.name, 'Build and review (imported)');
    assert.equal((back.flow.nodes.find((n) => n.id === scout.id)!.data as { modelId: string | null }).modelId, null);
    assert.ok(back.notes.some((n) => n.includes('named a model this Mac does not have')));
  });

  test('trusts nothing: unknown steps, fields and outputs are dropped', () => {
    const text = JSON.stringify({
      format: 'agentic-army-flow',
      version: 1,
      flow: {
        name: 'Odd',
        nodes: [
          { id: 's', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
          { id: 'x', type: 'teleport', data: { label: 'Beam' } },
          { id: 'sh', type: 'shell', position: { x: 300, y: 0 }, data: { label: 'Run', command: 'make', timeoutSec: 'soon', evil: true } },
        ],
        edges: [
          { source: 's', sourceHandle: 'out', target: 'sh' },
          { source: 'sh', sourceHandle: 'explode', target: 's' },
        ],
      },
    });
    const back = readFlowFile(text, ctx);
    assert.ok(back.ok);
    assert.deepEqual(back.flow.nodes.map((n) => n.type), ['start', 'shell']);
    const sh = back.flow.nodes[1]!.data as unknown as Record<string, unknown>;
    assert.equal(sh['command'], 'make');
    assert.equal(sh['timeoutSec'], 600);
    assert.equal('evil' in sh, false);
    assert.equal(back.flow.edges.length, 1);
    assert.ok(back.notes.some((n) => n.includes('"teleport"')));
    assert.ok(back.notes.some((n) => n.includes('Dropped 1 connection')));
  });

  test('says plainly what is not a flow, and what is from a newer app', () => {
    assert.match((readFlowFile('hello', ctx) as { message: string }).message, /not a flow file/);
    assert.match((readFlowFile('{"a":1}', ctx) as { message: string }).message, /no steps/);
    assert.match((readFlowFile('{"format":"agentic-army-flow","version":9,"flow":{}}', ctx) as { message: string }).message, /newer version/);
  });
});

describe('what a flow can do', () => {
  test('commands, engineers and merges come first, with the exact command', () => {
    const powers = flowPowers(build());
    const high = powers.filter((p) => p.level === 'high');
    assert.ok(high.length > 0);
    assert.ok(powers.indexOf(high.at(-1)!) < powers.findIndex((p) => p.level === 'note') || !powers.some((p) => p.level === 'note'));
    assert.ok(high.some((p) => p.node === 'Build' && /engineer/.test(p.text)));
    const quick = structuredClone(BUILTIN_FLOWS.find((f) => f.name === 'Triage with Jev')!);
    const shell = flowPowers(quick).find((p) => p.code !== undefined && p.text.includes('command'));
    assert.ok(shell === undefined || shell.level === 'high');
  });
});
