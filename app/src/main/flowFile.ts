/**
 * A flow as a file you can send someone, and the way back in. The file is the flow itself with a
 * format tag; reading one trusts nothing in it. Each node is rebuilt from its type's defaults, a
 * connection from an output the node does not have is dropped, and the flow comes in as "Only
 * you" whatever the sender set, so no agent can start it before you have read it.
 */

import { newId, slug } from '../shared/flow.ts';
import { NODE_TYPES, outputHandles, type Flow, type FlowEdge, type FlowNode, type NodeType } from '../shared/types.ts';
import { nodeData, type DraftContext } from './drafter.ts';

export const FLOW_FORMAT = 'agentic-army-flow';
const FORMAT_VERSION = 1;

export function flowFileText(flow: Flow): string {
  const { builtin: _builtin, ...rest } = flow;
  return `${JSON.stringify({ format: FLOW_FORMAT, version: FORMAT_VERSION, flow: rest }, null, 2)}\n`;
}

/** `Build and review` -> `build-and-review.flow.json`. */
export function flowFileName(flow: Pick<Flow, 'name'>): string {
  return `${slug(flow.name).replace(/_/g, '-') || 'flow'}.flow.json`;
}

export type ReadFlow = { ok: true; flow: Flow; notes: string[] } | { ok: false; message: string };

export function readFlowFile(text: string, ctx: DraftContext & { names: string[] }): ReadFlow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'This is not a flow file. A flow file is the JSON the app saves when you share a flow.' };
  }
  // A bare flow, as someone might paste it from their store, reads the same as a file.
  const wrapped = parsed !== null && typeof parsed === 'object' && (parsed as { format?: unknown }).format === FLOW_FORMAT;
  if (wrapped && Number((parsed as { version?: unknown }).version) > FORMAT_VERSION) {
    return { ok: false, message: 'This flow was saved by a newer version of the app. Update the app, then import it again.' };
  }
  const raw = (wrapped ? (parsed as { flow?: unknown }).flow : parsed) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw['nodes'])) {
    return { ok: false, message: 'This is not a flow file. It has no steps in it.' };
  }

  const notes: string[] = [];
  const nodes: FlowNode[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const item of raw['nodes'] as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const n = item as { id?: unknown; type?: unknown; position?: unknown; data?: unknown };
    if (typeof n.type !== 'string' || !(NODE_TYPES as readonly string[]).includes(n.type)) {
      notes.push(`Left out a step of the type "${String(n.type)}", which this version of the app does not have.`);
      continue;
    }
    const type = n.type as NodeType;
    if (type === 'start' && nodes.some((x) => x.type === 'start')) continue;
    const id = typeof n.id === 'string' && /^[\w-]{1,80}$/.test(n.id) && !ids.has(n.id) ? n.id : newId('n');
    ids.add(id);
    const given = n.data !== null && typeof n.data === 'object' ? (n.data as Record<string, unknown>) : {};
    const data = nodeData(type, given, ctx);
    const label = typeof given['label'] === 'string' && slug(given['label']) !== '' ? given['label'].slice(0, 80) : data.label;
    data.label = label;
    if (labels.has(slug(label))) {
      let i = 2;
      while (labels.has(slug(`${label} ${String(i)}`))) i += 1;
      data.label = `${label} ${String(i)}`;
    }
    labels.add(slug(data.label));
    if (type === 'agent' && typeof given['modelId'] === 'string' && (data as { modelId: string | null }).modelId === null) {
      notes.push(`"${data.label}" named a model this Mac does not have, so it uses its role's default model.`);
    }
    const p = n.position as { x?: unknown; y?: unknown } | undefined;
    const position = { x: typeof p?.x === 'number' && Number.isFinite(p.x) ? Math.round(p.x) : 0, y: typeof p?.y === 'number' && Number.isFinite(p.y) ? Math.round(p.y) : 0 };
    nodes.push({ id, type, position, data } as FlowNode);
  }
  if (nodes.length === 0) return { ok: false, message: 'This flow file has no steps the app can read.' };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: FlowEdge[] = [];
  let dropped = 0;
  for (const item of Array.isArray(raw['edges']) ? (raw['edges'] as unknown[]) : []) {
    const e = (item ?? {}) as { source?: unknown; sourceHandle?: unknown; target?: unknown };
    const src = typeof e.source === 'string' ? byId.get(e.source) : undefined;
    const ok = src !== undefined && typeof e.target === 'string' && byId.has(e.target) && typeof e.sourceHandle === 'string' && outputHandles(src).includes(e.sourceHandle);
    if (!ok) {
      dropped += 1;
      continue;
    }
    edges.push({ id: newId('e'), source: src.id, sourceHandle: e.sourceHandle as string, target: e.target as string });
  }
  if (dropped > 0) notes.push(`Dropped ${String(dropped)} connection${dropped === 1 ? '' : 's'} that pointed at a step or an output that is not there.`);

  const name = typeof raw['name'] === 'string' && raw['name'].trim() !== '' ? raw['name'].trim().slice(0, 120) : 'Imported flow';
  const flow: Flow = {
    id: newId('flow'),
    name: ctx.names.some((x) => x.toLowerCase() === name.toLowerCase()) ? `${name} (imported)` : name,
    description: typeof raw['description'] === 'string' ? raw['description'].slice(0, 4000) : '',
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
    invoke: 'you',
  };
  if (raw['invoke'] !== 'you') notes.push('Only you can start it for now. Once you have read it, change "Who can start this" in the editor.');
  return { ok: true, flow, notes };
}
