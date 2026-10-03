/**
 * How data moves through a flow, in words the editor can show. A node runs when a connection
 * delivers to it, and `{{input}}` is what the node at the other end passed on. What each node
 * passes on depends on its type and the output it left by, so it is written down here once, next
 * to the rules the engine follows, instead of in hints scattered over the inspector.
 */

import { canRunBefore, nodeByName, slug, templatesOf } from './flow.ts';
import type { Flow, FlowEdge, FlowNode, NodeType } from './types.ts';

export { canRunBefore } from './flow.ts';

/** What a node passes on, in one sentence, and where a particular output passes something else. */
export const OUTPUT_INFO: Record<NodeType, { out: string; handles?: Record<string, string> }> = {
  start: { out: 'The objective, the message that started the run.' },
  agent: {
    out: 'Its final reply, the text after its last tool call.',
    handles: { error: 'Its name and "failed:" with the error, then the input it was given.' },
  },
  decide: {
    out: 'Its input, unchanged. Jev picks the path and adds nothing.',
    handles: { unsure: 'Its input, unchanged. If Jev could not answer at all, the error comes first.' },
  },
  human: { out: "Its input, with the reviewer's note added when there is one." },
  shell: { out: 'The command, its exit code and everything it printed.' },
  git: { out: 'Its input, unchanged.', handles: { fail: 'The git error.' } },
  search: { out: 'The passages that answer, each with its link.' },
  browser: { out: 'What the browser did, step by step, and how it ended.' },
  flow: { out: "The other flow's result.", handles: { failed: 'Why the other flow failed.' } },
  join: { out: "Every input it waited for, each under its node's name." },
  end: { out: "Its result template, filled in. That is the run's result." },
};

/** What a node passes on by one output. A git diff passes the diff, not its input. */
export function sends(node: FlowNode, handle: string): string {
  if (node.type === 'git' && node.data.action === 'diff' && handle === 'out') return 'The diff of the run branch so far.';
  if (node.type === 'agent' && handle === 'error') return `"${node.data.label} failed:" and the error, then the input it was given.`;
  const info = OUTPUT_INFO[node.type];
  return info.handles?.[handle] ?? info.out;
}

/** The built-in variables, as the inspector explains them. */
export const VAR_INFO: Record<'objective' | 'input' | 'visit' | 'branch' | 'nodes', string> = {
  objective: 'The message that started the run. The same in every node.',
  input: 'What the node that sent the work here passed on. A Join gets every input, each under its name.',
  visit: 'How many times this node has run in this run, counting this time. 1 on the first pass.',
  branch: "The run's own git branch, once a step has used it. Empty before that.",
  nodes: "A node's last output. Empty until that node has run.",
};

export interface Incoming {
  edge: FlowEdge;
  node: FlowNode;
  handle: string;
}

/** Every connection into a node, with the node it comes from and the output it leaves by. */
export function incoming(flow: Flow, nodeId: string): Incoming[] {
  const out: Incoming[] = [];
  for (const e of flow.edges) {
    if (e.target !== nodeId) continue;
    const node = flow.nodes.find((n) => n.id === e.source);
    if (node !== undefined) out.push({ edge: e, node, handle: e.sourceHandle });
  }
  return out;
}

export interface InputSource {
  node: FlowNode;
  handle: string;
  /** A short name for it, such as "Review's reply" for a decision that passes Review's reply through. */
  name: string;
  /** What that node passes on by that output. */
  sends: string;
}

/**
 * What `{{input}}` will be in a node. `one`: a single connection. `any`: several, and each arrival
 * runs the node with what it brought. `all`: a Join, which waits for every one and gets them all.
 * `none`: nothing connects in, so the node never runs. Start reads the objective.
 */
export function inputSources(flow: Flow, node: FlowNode): { mode: 'start' | 'none' | 'one' | 'any' | 'all'; sources: InputSource[] } {
  if (node.type === 'start') return { mode: 'start', sources: [] };
  const sources = incoming(flow, node.id).map((i) => ({ node: i.node, handle: i.handle, sends: sends(i.node, i.handle), name: outputName(flow, i.node, i.handle) }));
  if (sources.length === 0) return { mode: 'none', sources };
  if (node.type === 'join') return { mode: 'all', sources };
  return { mode: sources.length === 1 ? 'one' : 'any', sources };
}

/**
 * A short name for what a node passes on, such as "Scout's reply". A decision and a git step
 * pass their input through, so with one way in they are named after what they pass.
 */
export function outputName(flow: Flow, node: FlowNode, handle?: string, seen: Set<string> = new Set()): string {
  const own = (noun: string) => `${node.data.label}'s ${noun}`;
  switch (node.type) {
    case 'start':
      return 'the objective';
    case 'agent':
      return handle === 'error' ? own('error') : own('reply');
    case 'shell':
      return own('command output');
    case 'search':
      return own('passages');
    case 'browser':
      return own('report');
    case 'flow':
      return own('result');
    case 'join':
      return own('inputs');
    case 'end':
      return own('result');
    case 'human':
      return own('input and note');
    case 'git':
      if (node.data.action === 'diff' && handle !== 'fail') return own('diff');
      if (handle === 'fail') return own('error');
      break;
    case 'decide':
      break;
  }
  // Passes its input through: name it after what came in, when only one thing can.
  const ins = seen.has(node.id) ? [] : incoming(flow, node.id).filter((i) => i.node.id !== node.id);
  const distinct = new Set(ins.map((i) => `${i.node.id}.${i.handle}`));
  if (distinct.size === 1) {
    seen.add(node.id);
    return outputName(flow, ins[0]!.node, ins[0]!.handle, seen);
  }
  return own('input');
}

export type Segment =
  | { kind: 'text'; text: string }
  | {
      kind: 'var';
      /** The template text, such as `{{nodes.scout}}`. */
      raw: string;
      name: string;
      /** What a person reads in its place, such as "Scout's reply". */
      label: string;
      /** A sentence on what it holds here. */
      info: string;
      /** Always empty in this node. */
      empty: boolean;
    };

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

function describeVar(name: string, flow: Flow, node: FlowNode): { label: string; info: string; empty: boolean } {
  if (name === 'objective') return { label: 'the objective', info: VAR_INFO.objective, empty: false };
  if (name === 'visit') return { label: 'the visit number', info: VAR_INFO.visit, empty: false };
  if (name === 'branch') return { label: 'the run branch', info: VAR_INFO.branch, empty: false };
  if (name === 'input') {
    const { mode, sources } = inputSources(flow, node);
    if (mode === 'start') return { label: 'the objective', info: VAR_INFO.objective, empty: false };
    if (mode === 'none') return { label: 'what arrived', info: 'Nothing connects into this node yet, so it never runs.', empty: true };
    if (mode === 'all') return { label: 'every input', info: `${sources.map((s) => s.node.data.label).join(', ')}, each under its name.`, empty: false };
    if (mode === 'one') return { label: outputName(flow, sources[0]!.node, sources[0]!.handle), info: sources[0]!.sends, empty: false };
    return { label: 'what arrived', info: `Whichever arrives: ${sources.map((s) => outputName(flow, s.node, s.handle)).join(', or ')}.`, empty: false };
  }
  if (name.startsWith('nodes.')) {
    const target = nodeByName(flow, name.slice('nodes.'.length));
    if (target === undefined) return { label: 'nothing', info: `No node is named "${name.slice(6)}", so this is empty.`, empty: true };
    const label = outputName(flow, target, undefined);
    if (!canRunBefore(flow, target.id, node.id)) {
      const why = target.id === node.id ? 'Nothing loops back to this node' : `"${target.data.label}" never runs before this node`;
      return { label, info: `${why}, so this is always empty here.`, empty: true };
    }
    return { label, info: `${sends(target, 'out')} The last one, and empty until "${target.data.label}" has run.`, empty: false };
  }
  return { label: 'nothing', info: `Nothing provides {{${name}}}, so it is empty.`, empty: true };
}

/** A template as text and readable placeholders, for the inspector's preview. */
export function previewTemplate(template: string, flow: Flow, node: FlowNode): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of template.matchAll(VAR_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: template.slice(last, at) });
    const name = m[1] ?? '';
    out.push({ kind: 'var', raw: m[0], name, ...describeVar(name, flow, node) });
    last = at + m[0].length;
  }
  if (last < template.length) out.push({ kind: 'text', text: template.slice(last) });
  return out;
}

/** The `{{nodes.x}}` a node reads, as the nodes they name. */
export function readsFrom(flow: Flow, node: FlowNode): FlowNode[] {
  const out: FlowNode[] = [];
  for (const t of templatesOf(node)) {
    for (const m of t.matchAll(VAR_RE)) {
      const name = m[1] ?? '';
      if (!name.startsWith('nodes.')) continue;
      const n = nodeByName(flow, name.slice(6));
      if (n !== undefined && n.id !== node.id && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** The name a template uses for a node. */
export function varName(node: FlowNode): string {
  return `nodes.${slug(node.data.label)}`;
}
