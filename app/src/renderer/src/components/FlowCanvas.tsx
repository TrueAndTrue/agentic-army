/**
 * The node as the canvas draws it, and the conversion from a Flow to React Flow's shapes. The
 * editor and the live run map both use these, so a node looks the same in both places.
 */

import { Handle, Position, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { Bot, Flag, GitBranch, Globe, Merge, Play, Split, Terminal, UserCheck } from 'lucide-react';
import { memo, useCallback, useRef, useState } from 'react';

import { outputHandles, hasInput, ROLE_INFO, type Flow, type FlowNode, type NodeRunStatus, type NodeType, type Settings } from '../../../shared/types.ts';
import { NODE_STATUS_COLOR, ROLE_COLOR, TYPE_COLOR, TYPE_LABEL } from '../lib/format.ts';
import { cx } from './ui.tsx';

export const TYPE_ICON: Record<NodeType, typeof Bot> = {
  start: Play,
  agent: Bot,
  decide: Split,
  human: UserCheck,
  shell: Terminal,
  git: GitBranch,
  browser: Globe,
  join: Merge,
  end: Flag,
};

export interface ArmyNodeData extends Record<string, unknown> {
  node: FlowNode;
  subtitle: string;
  status?: NodeRunStatus;
  visits?: number;
  problem?: 'error' | 'warn';
  /** The run map's small form: name and status only. */
  compact?: boolean;
}

export type ArmyFlowNode = Node<ArmyNodeData, 'army'>;

export function nodeColor(node: FlowNode): string {
  return node.type === 'agent' ? ROLE_COLOR[node.data.role] : TYPE_COLOR[node.type];
}

export function subtitleFor(node: FlowNode, settings: Settings | null): string {
  switch (node.type) {
    case 'agent': {
      const stage = settings?.stageDefaults[node.data.role];
      const modelId = node.data.modelId ?? stage?.modelId;
      const model = settings?.models.find((m) => m.id === modelId);
      return `${ROLE_INFO[node.data.role].label} · ${model?.label ?? 'default model'}`;
    }
    case 'decide':
      return node.data.question;
    case 'human':
      return 'Pauses until you answer';
    case 'shell':
      return node.data.command;
    case 'git':
      return node.data.action === 'merge' ? 'Merge into your branch' : node.data.action === 'commit' ? 'Commit the run branch' : 'Show the diff';
    case 'browser':
      return node.data.startUrl;
    case 'join':
      return 'Waits for every input';
    case 'start':
      return 'Your message';
    case 'end':
      return 'The result';
  }
}

const ROW = 22;

function handleColor(h: string, color: string): string {
  return h === 'error' || h === 'fail' || h === 'failed' || h === 'reject' || h === 'no' ? 'var(--bad)' : h === 'unsure' ? 'var(--warn)' : color;
}

function CompactNode({ data, selected }: NodeProps<ArmyFlowNode>) {
  const { node, status, visits } = data;
  const Icon = TYPE_ICON[node.type];
  const color = nodeColor(node);
  const outs = outputHandles(node);
  const statusColor = status === undefined || status === 'idle' ? undefined : NODE_STATUS_COLOR[status];
  const h = 46;
  return (
    <div
      className={cx('relative flex w-[172px] items-center gap-2 rounded-[10px] border-[1.5px] bg-panel px-2.5', selected ? 'border-brass' : 'border-line', status === 'running' && 'pulse', status === 'skipped' && 'opacity-50')}
      style={{ height: h, ...(statusColor !== undefined && !selected ? { borderColor: statusColor } : {}) }}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
        <Icon size={13} strokeWidth={2.2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] leading-tight font-semibold">{node.data.label}</div>
        <div className="truncate text-[10.5px] leading-tight" style={{ color: statusColor ?? 'var(--faint)' }}>
          {status === undefined || status === 'idle' ? 'not run' : status}
          {visits !== undefined && visits > 1 ? ` ×${visits}` : ''}
        </div>
      </div>
      {outs.map((o, i) => (
        <Handle key={o} id={o} type="source" position={Position.Bottom} title={o} className="!h-2 !w-2 !border-2 !border-panel" style={{ background: handleColor(o, color), left: `${(100 / (outs.length + 1)) * (i + 1)}%`, bottom: -4 }} />
      ))}
      {hasInput(node.type) && <Handle id="in" type="target" position={Position.Top} className="!h-2 !w-2 !border-2 !border-panel !bg-line-strong" style={{ top: -4 }} />}
      {/* Where a loop comes back in, so it routes up the side instead of through the column. */}
      {hasInput(node.type) && <Handle id="back" type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" style={{ left: -1 }} />}
    </div>
  );
}

function ArmyNodeView(props: NodeProps<ArmyFlowNode>) {
  if (props.data.compact === true) return <CompactNode {...props} />;
  const { data, selected } = props;
  const { node, subtitle, status, visits, problem } = data;
  const Icon = TYPE_ICON[node.type];
  const color = nodeColor(node);
  const outs = outputHandles(node);
  const running = status === 'running';
  const statusColor = status === undefined ? undefined : NODE_STATUS_COLOR[status];

  return (
    <div
      className={cx(
        'w-[200px] rounded-[10px] border bg-panel text-left shadow-[0_1px_0_rgba(0,0,0,0.25)]',
        selected ? 'border-brass' : 'border-line',
        running && 'pulse',
        status === 'skipped' && 'opacity-50',
      )}
      style={statusColor !== undefined && status !== 'idle' ? { borderColor: statusColor } : undefined}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
          <Icon size={14} strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-tight font-semibold text-text">{node.data.label}</div>
          <div className="text-[10.5px] leading-tight text-faint">{node.type === 'decide' ? `Jev · ${node.data.mode === 'yesno' ? 'yes/no' : node.data.mode}` : TYPE_LABEL[node.type]}</div>
        </div>
        {visits !== undefined && visits > 1 && <span className="rounded bg-raised px-1 font-mono text-[10.5px] text-muted">×{visits}</span>}
        {problem !== undefined && <span className="h-2 w-2 rounded-full" style={{ background: problem === 'error' ? 'var(--bad)' : 'var(--warn)' }} title="This node has a problem" />}
      </div>
      <div className="px-3 pt-1.5 pb-2">
        <div className="line-clamp-2 text-[11.5px] leading-snug text-muted">{subtitle}</div>
      </div>
      {outs.length > 0 && (
        <div className="border-t border-line py-1">
          {outs.map((h) => (
            <div key={h} className="relative flex items-center justify-end pr-3.5 text-[11px] text-muted" style={{ height: ROW }}>
              {h}
              <Handle
                id={h}
                type="source"
                position={Position.Right}
                className="!h-2.5 !w-2.5 !border-2 !border-panel"
                style={{ background: handleColor(h, color), top: ROW / 2, right: -5 }}
              />
            </div>
          ))}
        </div>
      )}
      {hasInput(node.type) && (
        <Handle id="in" type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-panel !bg-line-strong" style={{ top: 22, left: -5 }} />
      )}
    </div>
  );
}

export const nodeTypes = { army: memo(ArmyNodeView) };

export function toRfNodes(flow: Flow, settings: Settings | null, extra?: (n: FlowNode) => Partial<ArmyNodeData>, scale = 1): ArmyFlowNode[] {
  return flow.nodes.map((n) => ({
    id: n.id,
    type: 'army',
    position: { x: n.position.x * scale, y: n.position.y * scale },
    data: { node: n, subtitle: subtitleFor(n, settings), ...(extra?.(n) ?? {}) },
  }));
}

export function toRfEdges(flow: Flow, animated?: (targetId: string) => boolean): Edge[] {
  return flow.edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: 'in',
    type: 'smoothstep',
    pathOptions: { borderRadius: 14, offset: 22 },
    animated: animated?.(e.target) ?? false,
  })) as Edge[];
}

/** Edges for the top-to-bottom run map: curves going down, loops around the left side. */
export function mapEdges(flow: Flow, layout: Record<string, { x: number; y: number }>, animated: (targetId: string) => boolean): Edge[] {
  return flow.edges.map((e) => {
    const back = (layout[e.target]?.y ?? 0) <= (layout[e.source]?.y ?? 0);
    return {
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: back ? 'back' : 'in',
      type: back ? 'smoothstep' : 'default',
      ...(back ? { pathOptions: { borderRadius: 12, offset: 26 } } : {}),
      ...(e.sourceHandle !== 'out' ? { label: e.sourceHandle, labelBgPadding: [4, 2] as [number, number], labelBgBorderRadius: 4 } : {}),
      animated: animated(e.target),
    } as Edge;
  });
}

/**
 * React Flow v12 reads each node's measured size off the node objects it is given. The canvas
 * rebuilds those objects from the flow on every change, so the sizes are kept here and put back.
 */
export function useMeasured() {
  const sizes = useRef(new Map<string, { width: number; height: number }>());
  const [, bump] = useState(0);
  const apply = useCallback((changes: NodeChange[]) => {
    let changed = false;
    for (const c of changes) {
      if (c.type === 'dimensions' && c.dimensions !== undefined) {
        const prev = sizes.current.get(c.id);
        if (prev?.width !== c.dimensions.width || prev?.height !== c.dimensions.height) {
          sizes.current.set(c.id, { width: c.dimensions.width, height: c.dimensions.height });
          changed = true;
        }
      }
    }
    if (changed) bump((n) => n + 1);
  }, []);
  const withMeasured = <T extends Node>(nodes: T[]): T[] =>
    nodes.map((n) => {
      const m = sizes.current.get(n.id);
      return m === undefined ? n : { ...n, measured: m };
    });
  return { apply, withMeasured };
}

/**
 * Top-to-bottom positions for the run map: each node sits at its distance from Start, so the path
 * a run takes reads downward and loops show as edges climbing back up.
 */
export function layeredPositions(flow: Flow): Record<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const start = flow.nodes.find((n) => n.type === 'start');
  if (start !== undefined) {
    depth.set(start.id, 0);
    const queue = [start.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const e of flow.edges) {
        if (e.source === id && !depth.has(e.target)) {
          depth.set(e.target, (depth.get(id) ?? 0) + 1);
          queue.push(e.target);
        }
      }
    }
  }
  const deepest = Math.max(0, ...depth.values());
  for (const n of flow.nodes) if (!depth.has(n.id)) depth.set(n.id, deepest + 1);
  const rows = new Map<number, FlowNode[]>();
  for (const n of flow.nodes) rows.set(depth.get(n.id)!, [...(rows.get(depth.get(n.id)!) ?? []), n]);
  const out: Record<string, { x: number; y: number }> = {};
  for (const [d, row] of rows) {
    row.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    row.forEach((n, i) => {
      out[n.id] = { x: (i - (row.length - 1) / 2) * 200, y: d * 84 };
    });
  }
  return out;
}
