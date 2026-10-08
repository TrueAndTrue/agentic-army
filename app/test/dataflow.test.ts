import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BUILTIN_FLOWS } from '../src/main/templates.ts';
import { canRunBefore, incoming, inputSources, OUTPUT_INFO, outputName, previewTemplate, readsFrom, sends, VAR_INFO, type Segment } from '../src/shared/dataflow.ts';
import { defaultNodeData } from '../src/shared/flow.ts';
import { NODE_TYPES, type Flow, type FlowEdge, type FlowNode, type NodeType } from '../src/shared/types.ts';

function node<T extends NodeType>(id: string, type: T, data: Partial<FlowNode['data']> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { ...defaultNodeData(type), label: id, ...data } } as FlowNode;
}

function edge(source: string, sourceHandle: string, target: string): FlowEdge {
  return { id: `${source}.${sourceHandle}->${target}`, source, sourceHandle, target };
}

function flow(nodes: FlowNode[], edges: FlowEdge[]): Flow {
  return { id: 'f', name: 'test', description: '', nodes, edges, updatedAt: '' };
}

const main = BUILTIN_FLOWS.find((f) => f.id === 'builtin-main-flow')!;
const byId = (f: Flow, id: string) => f.nodes.find((n) => n.id === id)!;

/** A preview as a string, with each variable as [its label]. */
function show(segments: Segment[]): string {
  return segments.map((s) => (s.kind === 'text' ? s.text : `[${s.label}${s.empty ? ', empty' : ''}]`)).join('');
}

describe('what each node passes on', () => {
  test('every node type has a sentence, and the outputs that pass something else have their own', () => {
    for (const t of NODE_TYPES) assert.ok(OUTPUT_INFO[t].out.length > 10, t);
    assert.ok(Object.keys(VAR_INFO).includes('input'));
    const agent = node('Scout', 'agent');
    assert.match(sends(agent, 'out'), /final reply/);
    assert.match(sends(agent, 'error'), /^"Scout failed:"/);
    assert.match(sends(node('d', 'decide'), 'yes'), /unchanged/);
    assert.match(sends(node('g', 'git', { action: 'commit' }), 'out'), /unchanged/);
    assert.match(sends(node('g', 'git', { action: 'diff' }), 'out'), /diff/);
    assert.match(sends(node('g', 'git'), 'fail'), /error/);
    assert.match(sends(node('s', 'shell'), 'fail'), /exit code/);
  });

  test('a node that passes its input through is named after what came in', () => {
    assert.equal(outputName(main, byId(main, 'scout')), "Scout's reply");
    assert.equal(outputName(main, byId(main, 'start')), 'the objective');
    // Review passed only ever passes on what Review said.
    assert.equal(outputName(main, byId(main, 'passed'), 'yes'), "Review's reply");
    assert.equal(outputName(main, byId(main, 'scout'), 'error'), "Scout's error");
  });
});

describe('connections into a node', () => {
  test('incoming lists each connection with its source and output', () => {
    const into = incoming(main, 'build').map((i) => `${i.node.id}.${i.handle}`);
    assert.deepEqual(into.sort(), ['approve_plan.approve', 'passed.no', 'sign_off.reject']);
  });

  test('inputSources says one, any, all, none, or that Start reads the objective', () => {
    const f = flow(
      [node('start', 'start'), node('a', 'agent'), node('b', 'shell'), node('join', 'join'), node('lonely', 'agent'), node('end', 'end')],
      [edge('start', 'out', 'a'), edge('start', 'out', 'b'), edge('a', 'out', 'join'), edge('b', 'pass', 'join'), edge('join', 'out', 'end'), edge('a', 'error', 'end')],
    );
    assert.equal(inputSources(f, byId(f, 'start')).mode, 'start');
    assert.equal(inputSources(f, byId(f, 'a')).mode, 'one');
    assert.equal(inputSources(f, byId(f, 'lonely')).mode, 'none');
    const join = inputSources(f, byId(f, 'join'));
    assert.equal(join.mode, 'all');
    assert.deepEqual(join.sources.map((s) => s.node.id), ['a', 'b']);
    assert.match(join.sources[1]!.sends, /exit code/);
    const end = inputSources(f, byId(f, 'end'));
    assert.equal(end.mode, 'any');
    assert.deepEqual(end.sources.map((s) => `${s.node.id}.${s.handle}`), ['join.out', 'a.error']);
  });
});

describe('what can run before what', () => {
  test('a path forward, a loop back, and no path', () => {
    assert.equal(canRunBefore(main, 'scout', 'plan'), true);
    assert.equal(canRunBefore(main, 'review', 'build'), true, 'through Review passed saying no');
    assert.equal(canRunBefore(main, 'build', 'build'), true, 'Build is in a loop');
    assert.equal(canRunBefore(main, 'scout', 'scout'), false, 'nothing loops back to Scout');
    assert.equal(canRunBefore(main, 'validate', 'scout'), false);
    assert.equal(canRunBefore(main, 'end', 'build'), false);
  });

  test('readsFrom finds the nodes a template names, by slug or id', () => {
    assert.deepEqual(readsFrom(main, byId(main, 'build')).map((n) => n.id), ['plan', 'review', 'sign_off']);
    assert.deepEqual(readsFrom(main, byId(main, 'scout')), []);
  });
});

describe('a template with readable placeholders', () => {
  test("Plan's prompt reads the objective, Scout's reply and what Scout sent it", () => {
    const plan = byId(main, 'plan');
    const out = show(previewTemplate('Objective: {{objective}}\n{{nodes.scout}}\n{{input}}', main, plan));
    // Plan's input is Scout's reply, or the plan you sent back with a note.
    assert.equal(out, "Objective: [the objective]\n[Scout's reply]\n[what arrived]");
  });

  test('one way in names the source; a Join gets every input', () => {
    const f = flow(
      [node('start', 'start'), node('Scout', 'agent'), node('b', 'shell'), node('join', 'join'), node('end', 'end')],
      [edge('start', 'out', 'Scout'), edge('start', 'out', 'b'), edge('Scout', 'out', 'join'), edge('b', 'pass', 'join'), edge('join', 'out', 'end')],
    );
    assert.equal(show(previewTemplate('Go: {{input}}', f, byId(f, 'Scout'))), 'Go: [the objective]');
    assert.equal(show(previewTemplate('{{input}}', f, byId(f, 'join'))), '[every input]');
    assert.equal(show(previewTemplate('{{ input }}', f, byId(f, 'end'))), "[join's inputs]");
  });

  test('a node that never runs first, an unknown name and an unconnected node read as empty', () => {
    const f = flow(
      [node('start', 'start'), node('plan', 'agent'), node('tests', 'shell'), node('lonely', 'agent'), node('end', 'end')],
      [edge('start', 'out', 'plan'), edge('plan', 'out', 'tests'), edge('tests', 'pass', 'end')],
    );
    const segs = previewTemplate('{{nodes.tests}} {{nodes.nope}} {{visit}}', f, byId(f, 'plan'));
    assert.equal(show(segs), "[tests's command output, empty] [nothing, empty] [the visit number]");
    const first = segs[0] as Extract<Segment, { kind: 'var' }>;
    assert.equal(first.raw, '{{nodes.tests}}');
    assert.match(first.info, /never runs before this node/);
    assert.equal(show(previewTemplate('{{input}}', f, byId(f, 'lonely'))), '[what arrived, empty]');
    assert.equal(show(previewTemplate('{{nodes.plan}}', f, byId(f, 'end'))), "[plan's reply]");
    assert.equal(show(previewTemplate('plain text', f, byId(f, 'end'))), 'plain text');
  });
});
