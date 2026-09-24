/**
 * Flow rules both sides need: the canvas shows these problems as you draw, and the engine refuses
 * to start a run that has any of the errors.
 */

import { outputHandles, type Flow, type FlowNode, type NodeType } from './types.ts';

export interface FlowProblem {
  level: 'error' | 'warn';
  nodeId?: string;
  message: string;
}

/** `Write tests` -> `write_tests`. The name a template uses for a node. */
export function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export interface TemplateContext {
  objective: string;
  input: string;
  visit: number;
  /** Last output of every node that has run, keyed by id AND by label slug. */
  nodes: Record<string, string>;
  branch?: string;
}

/**
 * Fills `{{objective}}`, `{{input}}`, `{{visit}}`, `{{branch}}` and `{{nodes.<name>}}`.
 * A name nothing has produced yet renders as empty, so a loop's first pass reads cleanly.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(TEMPLATE_RE, (_all, name: string) => {
    if (name === 'objective') return ctx.objective;
    if (name === 'input') return ctx.input;
    if (name === 'visit') return String(ctx.visit);
    if (name === 'branch') return ctx.branch ?? '';
    if (name.startsWith('nodes.')) return ctx.nodes[name.slice('nodes.'.length)] ?? '';
    return '';
  });
}

/** Every `{{name}}` in a template, for validation and for the editor's hints. */
export function templateNames(template: string): string[] {
  return [...template.matchAll(TEMPLATE_RE)].map((m) => m[1] ?? '');
}

function templatesOf(node: FlowNode): string[] {
  switch (node.type) {
    case 'agent':
      return [node.data.prompt];
    case 'decide':
      return [node.data.question, node.data.state];
    case 'human':
      return [node.data.prompt];
    case 'shell':
      return [node.data.command];
    case 'git':
      return [node.data.message];
    case 'browser':
      return [node.data.goal, node.data.startUrl];
    case 'end':
      return [node.data.template];
    default:
      return [];
  }
}

export function validateFlow(flow: Flow, knownModelIds?: ReadonlySet<string>): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const starts = flow.nodes.filter((n) => n.type === 'start');
  if (starts.length === 0) problems.push({ level: 'error', message: 'A flow needs a Start node.' });
  if (starts.length > 1) problems.push({ level: 'error', message: 'A flow can have only one Start node.' });

  const names = new Set<string>();
  for (const n of flow.nodes) {
    names.add(n.id);
    names.add(slug(n.data.label));
  }
  const slugs = new Map<string, string>();
  for (const n of flow.nodes) {
    const s = slug(n.data.label);
    if (s === '') problems.push({ level: 'error', nodeId: n.id, message: 'Give this node a name.' });
    else if (slugs.has(s)) problems.push({ level: 'error', nodeId: n.id, message: `Two nodes are named "${n.data.label}". Names must differ.` });
    else slugs.set(s, n.id);
  }

  for (const e of flow.edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (src === undefined || dst === undefined) {
      problems.push({ level: 'error', message: `A connection points at a node that no longer exists.` });
      continue;
    }
    if (!outputHandles(src).includes(e.sourceHandle)) {
      problems.push({ level: 'error', nodeId: src.id, message: `"${src.data.label}" has no "${e.sourceHandle}" output any more. Reconnect it.` });
    }
    if (dst.type === 'start') problems.push({ level: 'error', nodeId: dst.id, message: 'Nothing can connect into Start.' });
  }

  // Reachability from Start.
  if (starts.length === 1) {
    const seen = new Set<string>([starts[0]!.id]);
    const stack = [starts[0]!.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const e of flow.edges) if (e.source === id && !seen.has(e.target)) {
        seen.add(e.target);
        stack.push(e.target);
      }
    }
    for (const n of flow.nodes) {
      if (!seen.has(n.id)) problems.push({ level: 'warn', nodeId: n.id, message: `"${n.data.label}" is not connected to Start, so it never runs.` });
    }
  }

  for (const n of flow.nodes) {
    for (const t of templatesOf(n)) {
      for (const name of templateNames(t)) {
        if (['objective', 'input', 'visit', 'branch'].includes(name)) continue;
        if (name.startsWith('nodes.') && names.has(name.slice(6))) continue;
        problems.push({ level: 'warn', nodeId: n.id, message: `"${n.data.label}" uses {{${name}}}, which nothing provides.` });
      }
    }
    if (n.type === 'agent') {
      if (n.data.prompt.trim() === '') problems.push({ level: 'error', nodeId: n.id, message: `"${n.data.label}" has no prompt.` });
      if (knownModelIds !== undefined && n.data.modelId !== null && !knownModelIds.has(n.data.modelId)) {
        problems.push({ level: 'error', nodeId: n.id, message: `"${n.data.label}" uses a model that is not in Settings.` });
      }
    }
    if (n.type === 'decide') {
      if (n.data.question.trim() === '') problems.push({ level: 'error', nodeId: n.id, message: `"${n.data.label}" has no question.` });
      if (n.data.mode === 'choice') {
        if (n.data.options.length < 2) problems.push({ level: 'error', nodeId: n.id, message: `"${n.data.label}" needs at least two options.` });
        const keys = new Set<string>();
        for (const o of n.data.options) {
          if (!/^[a-z0-9_-]+$/i.test(o.key)) problems.push({ level: 'error', nodeId: n.id, message: `Option "${o.key}" in "${n.data.label}" may use only letters, digits, - and _.` });
          if (keys.has(o.key)) problems.push({ level: 'error', nodeId: n.id, message: `"${n.data.label}" has the option "${o.key}" twice.` });
          if (o.key === 'unsure') problems.push({ level: 'error', nodeId: n.id, message: `"unsure" is reserved in "${n.data.label}".` });
          keys.add(o.key);
        }
      }
      if (n.data.mode === 'score' && n.data.levels.length < 2) {
        problems.push({ level: 'error', nodeId: n.id, message: `"${n.data.label}" needs at least two levels.` });
      }
    }
    if (n.type === 'shell' && n.data.command.trim() === '') problems.push({ level: 'error', nodeId: n.id, message: `"${n.data.label}" has no command.` });
    if (n.type === 'browser' && n.data.goal.trim() === '') problems.push({ level: 'error', nodeId: n.id, message: `"${n.data.label}" has no goal.` });
    if (n.type !== 'end' && n.type !== 'start' && !flow.edges.some((e) => e.source === n.id)) {
      problems.push({ level: 'warn', nodeId: n.id, message: `Nothing follows "${n.data.label}". The path stops there.` });
    }
  }
  return problems;
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultNodeData(type: NodeType): FlowNode['data'] {
  switch (type) {
    case 'start':
      return { label: 'Start' };
    case 'agent':
      return {
        label: 'Agent',
        role: 'engineer',
        modelId: null,
        effort: null,
        prompt: 'Objective: {{objective}}\n\n{{input}}',
        workspace: 'run',
        keepContext: false,
        maxVisits: 3,
      };
    case 'decide':
      return {
        label: 'Decide',
        mode: 'yesno',
        question: 'Does the input say the work is complete and correct?',
        state: '{{input}}',
        options: [
          { key: 'a', description: 'First option' },
          { key: 'b', description: 'Second option' },
        ],
        threshold: 0.5,
        levels: ['Poor', 'Acceptable', 'Good'],
        cut: 1,
        minConfidence: 0,
        maxVisits: 5,
      };
    case 'human':
      return { label: 'Approve', prompt: 'Review this before the flow continues.\n\n{{input}}' };
    case 'shell':
      return { label: 'Run tests', command: 'npm test', workspace: 'run', timeoutSec: 600, maxVisits: 5 };
    case 'git':
      return { label: 'Commit', action: 'commit', message: 'flow: {{objective}}' };
    case 'browser':
      return {
        label: 'Browser',
        goal: '{{input}}',
        startUrl: 'https://duckduckgo.com',
        maxSteps: 12,
        guard: true,
        guardThreshold: 0.5,
        showWindow: true,
      };
    case 'join':
      return { label: 'Join' };
    case 'end':
      return { label: 'End', template: '{{input}}' };
  }
}
