import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { ChevronLeft, Copy, Play, Plus, RotateCcw, Save, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import { DEFAULT_INVOKE_CEILING, defaultNodeData, flowCommand, invokeLevel, newId, validateFlow } from '../../../shared/flow.ts';
import { INVOKE_INFO, INVOKE_LEVELS, NODE_TYPES, type Flow, type FlowNode, type InvokeLevel, type NodeType } from '../../../shared/types.ts';
import { TYPE_LABEL } from '../lib/format.ts';
import { api, go, newFlowSession, useStore } from '../lib/state.ts';
import { nodeColor, nodeTypes, toRfEdges, toRfNodes, TYPE_ICON, useMeasured } from './FlowCanvas.tsx';
import { NodeInspector } from './NodeInspector.tsx';
import { Button, cx, Field, Input, PillSelect, Select, TextArea } from './ui.tsx';

const PALETTE: { type: NodeType; hint: string }[] = [
  { type: 'agent', hint: 'Claude or Codex with a role' },
  { type: 'decide', hint: 'Jev routes on a question' },
  { type: 'human', hint: 'Pause for your approval' },
  { type: 'shell', hint: 'Run a command' },
  { type: 'search', hint: 'Jev reads the web for an answer' },
  { type: 'browser', hint: 'Jev clicks and types on a page' },
  { type: 'git', hint: 'Diff, commit or merge' },
  { type: 'flow', hint: 'Run another flow as a step' },
  { type: 'join', hint: 'Wait for parallel paths' },
  { type: 'end', hint: 'Finish with a result' },
  { type: 'start', hint: 'Where a run begins' },
];

/** Node size on the canvas, near enough to keep a new node off the ones already there. */
const NODE_W = 230;
const NODE_H = 76;

/** The nearest free spot to `at`, stepping down, then right, until nothing overlaps. */
function freeSpot(nodes: FlowNode[], at: { x: number; y: number }): { x: number; y: number } {
  const taken = (p: { x: number; y: number }) => nodes.some((n) => Math.abs(n.position.x - p.x) < NODE_W && Math.abs(n.position.y - p.y) < NODE_H + 12);
  for (let col = 0; col < 6; col += 1) {
    for (let row = 0; row < 8; row += 1) {
      const p = { x: at.x + col * (NODE_W + 50), y: at.y + row * (NODE_H + 24) };
      if (!taken(p)) return p;
    }
  }
  return at;
}

function blankFlow(): Flow {
  return {
    id: newId('flow'),
    name: 'Untitled flow',
    description: '',
    updatedAt: new Date().toISOString(),
    nodes: [
      { id: newId('n'), type: 'start', position: { x: 0, y: 120 }, data: defaultNodeData('start') } as FlowNode,
      { id: newId('n'), type: 'end', position: { x: 620, y: 120 }, data: defaultNodeData('end') } as FlowNode,
    ],
    edges: [],
  };
}

function uniqueLabel(flow: Flow, base: string): string {
  const taken = new Set(flow.nodes.map((n) => n.data.label.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

function Canvas({ draft, setDraft, selected, setSelected }: { draft: Flow; setDraft(f: (d: Flow) => Flow): void; selected: string | null; setSelected(id: string | null): void }) {
  const settings = useStore((s) => s.settings);
  const rf = useReactFlow();
  const measured = useMeasured();
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const allFlows = useStore((s) => s.flows);
  const problems = useMemo(() => validateFlow(draft, new Set(settings?.models.map((m) => m.id)), new Set(allFlows.map((f) => f.id))), [draft, settings, allFlows]);
  const nodes = useMemo(
    () =>
      toRfNodes(draft, settings, (n) => {
        const p = problems.filter((x) => x.nodeId === n.id);
        return p.length === 0 ? {} : { problem: p.some((x) => x.level === 'error') ? 'error' : 'warn' };
      }).map((n) => ({ ...n, selected: n.id === selected })),
    [draft, settings, problems, selected],
  );
  const shown = measured.withMeasured(nodes);
  const edges = useMemo(() => toRfEdges(draft), [draft]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      measured.apply(changes);
      for (const c of changes) {
        if (c.type === 'select' && c.selected) setSelected(c.id);
      }
      const moved = (changes.filter((c) => c.type === 'position' && c.position !== undefined) as Extract<NodeChange, { type: 'position' }>[]).filter((c) => {
        const n = draftRef.current.nodes.find((x) => x.id === c.id);
        return n !== undefined && (Math.round(c.position!.x) !== n.position.x || Math.round(c.position!.y) !== n.position.y);
      });
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id));
      if (moved.length === 0 && removed.size === 0) return;
      setDraft((d) => ({
        ...d,
        nodes: d.nodes
          .filter((n) => !removed.has(n.id))
          .map((n) => {
            const m = moved.find((c) => c.id === n.id);
            return m?.position !== undefined ? ({ ...n, position: { x: Math.round(m.position.x), y: Math.round(m.position.y) } } as FlowNode) : n;
          }),
        edges: d.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
      }));
      if (selected !== null && removed.has(selected)) setSelected(null);
    },
    [setDraft, selected, setSelected, measured.apply],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id));
      if (removed.size > 0) setDraft((d) => ({ ...d, edges: d.edges.filter((e) => !removed.has(e.id)) }));
    },
    [setDraft],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === null || c.target === null || c.sourceHandle === null || c.source === c.target) return;
      setDraft((d) =>
        d.edges.some((e) => e.source === c.source && e.sourceHandle === c.sourceHandle && e.target === c.target)
          ? d
          : { ...d, edges: [...d.edges, { id: newId('e'), source: c.source, sourceHandle: c.sourceHandle!, target: c.target }] },
      );
    },
    [setDraft],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/army-node') as NodeType;
    if (!NODE_TYPES.includes(type)) return;
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNode(type, { x: pos.x - 112, y: pos.y - 30 });
  };

  const addNode = (type: NodeType, position?: { x: number; y: number }) => {
    const id = newId('n');
    const at = position ?? (() => {
      const r = document.querySelector('.react-flow')?.getBoundingClientRect();
      const p = rf.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2, y: (r?.top ?? 0) + (r?.height ?? 600) / 2 });
      return { x: p.x - 112, y: p.y - 40 };
    })();
    setDraft((d) => {
      const data = defaultNodeData(type);
      // From the Add bar, a new node goes to the right of the one you have selected, else the
      // middle of the view, and never on top of another: eight added in a row used to stack up.
      const anchor = position === undefined && selected !== null ? d.nodes.find((n) => n.id === selected) : undefined;
      const spot = position ?? freeSpot(d.nodes, anchor === undefined ? at : { x: anchor.position.x + NODE_W + 50, y: anchor.position.y });
      return { ...d, nodes: [...d.nodes, { id, type, position: { x: Math.round(spot.x), y: Math.round(spot.y) }, data: { ...data, label: uniqueLabel(d, data.label) } } as FlowNode] };
    });
    setSelected(id);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel px-3 py-1.5">
        <span className="mr-1 shrink-0 text-[11.5px] text-faint">Add</span>
        {PALETTE.filter((p) => p.type !== 'start' || !draft.nodes.some((n) => n.type === 'start')).map((p) => {
          const Icon = TYPE_ICON[p.type];
          const color = nodeColor({ type: p.type, data: defaultNodeData(p.type) } as FlowNode);
          return (
            <button
              key={p.type}
              draggable
              title={`${p.hint}. Drag onto the canvas, or click to add.`}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/army-node', p.type);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => addNode(p.type)}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted hover:bg-hover hover:text-text"
            >
              <Icon size={13} strokeWidth={2.2} style={{ color }} />
              {p.type === 'decide' ? 'Jev decision' : TYPE_LABEL[p.type]}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 min-w-0 flex-1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <ReactFlow
          nodes={shown}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onPaneClick={() => setSelected(null)}
          isValidConnection={(c) => c.targetHandle === 'in' && c.source !== c.target}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1, minZoom: 0.55 }}
          minZoom={0.2}
          snapToGrid
          snapGrid={[10, 10]}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} color="var(--canvas-dot)" />
          <Controls />
          <MiniMap pannable zoomable nodeColor={(n) => nodeColor((n.data as { node: FlowNode }).node)} maskColor="color-mix(in srgb, var(--bg) 70%, transparent)" />
        </ReactFlow>
      </div>
    </div>
  );
}

export function FlowEditor({ flowId }: { flowId: string | null }) {
  const flows = useStore((s) => s.flows);
  const settings = useStore((s) => s.settings);
  const current = flows.find((f) => f.id === flowId) ?? null;
  const [draft, setDraftRaw] = useState<Flow | null>(current);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    setDraftRaw(current === null ? null : structuredClone(current));
    setDirty(false);
    setSelected(null);
    // Only when the flow being edited changes, not on every save echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  const setDraft = useCallback((f: (d: Flow) => Flow) => {
    setDraftRaw((d) => (d === null ? d : f(d)));
    setDirty(true);
  }, []);

  const open = (id: string | null) => {
    if (dirty && !window.confirm('Discard the unsaved changes to this flow?')) return;
    go({ kind: 'flows', flowId: id });
  };

  const save = async () => {
    if (draft === null) return;
    const saved = await api().saveFlow(draft);
    setDraftRaw(saved);
    setDirty(false);
  };

  const projects = useStore((s) => s.projects);
  const problems = draft === null || settings === null ? [] : validateFlow(draft, new Set(settings.models.map((m) => m.id)), new Set(flows.map((f) => f.id)));
  const node = draft?.nodes.find((n) => n.id === selected) ?? null;
  const isBuiltinCopy = draft !== null && draft.id.startsWith('builtin-') && draft.builtin !== true;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex min-w-0 flex-1">
      {draft === null ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="drag flex h-12 shrink-0 items-center border-b border-line px-6">
            <span className="text-[13.5px] font-semibold">Flows</span>
            <Button
              tone="quiet"
              className="ml-auto"
              onClick={async () => {
                const f = await api().saveFlow(blankFlow());
                open(f.id);
              }}
            >
              <Plus size={14} /> Blank flow
            </Button>
            <Button tone="primary" onClick={() => go({ kind: 'flows', flowId: null, draft: true })}>
              <Sparkles size={14} /> Draft with AI
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[980px] px-6 py-8">
              <p className="max-w-[640px] text-[13px] leading-relaxed text-muted">
                A flow is a team of agents you wire together. Each node is a step: an agent with a role and a model, a Jev decision that picks a path, your approval, a command, a web search, a browser, git, or another flow. Loops are connections that point back.
              </p>
              <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-muted">
                Start one with Run below, from the box in a session, or by typing its command, such as <code className="font-mono text-[12px] text-text">/quick-fix add a multiply function</code>. Each flow also says whether Jev and chat agents may start it.
              </p>
              <ul className="mt-6 grid grid-cols-2 gap-3">
                {flows.map((f) => (
                  <li key={f.id} className="relative">
                    <button onClick={() => open(f.id)} className="flex h-full w-full flex-col items-start justify-start rounded-xl border border-line bg-panel p-4 text-left hover:border-line-strong hover:bg-raised">
                      <div className="flex items-center gap-2 pr-20">
                        <span className="text-[14px] font-semibold">{f.name}</span>
                        <span className="text-[11.5px] text-faint">{f.builtin === true ? 'ships with the app' : f.id.startsWith('builtin-') ? 'your version' : 'yours'}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] text-faint">
                        <code className="font-mono">/{flowCommand(f)}</code>
                        <span>{settings === null ? '' : `Who can start it: ${INVOKE_INFO[invokeLevel(f, settings)].label}`}</span>
                      </div>
                      <p className="mt-1.5 line-clamp-3 text-[12.5px] leading-relaxed text-muted">{f.description || 'No description yet.'}</p>
                      <div className="mt-3 flex flex-wrap gap-1">
                        {f.nodes
                          .filter((n) => n.type !== 'start' && n.type !== 'end')
                          .map((n) => (
                            <span key={n.id} className="flex items-center gap-1 rounded border border-line px-1.5 py-px text-[11px] text-muted">
                              <span className="h-1.5 w-1.5 rounded-full" style={{ background: nodeColor(n) }} />
                              {n.data.label}
                            </span>
                          ))}
                      </div>
                    </button>
                    <div className="absolute top-3 right-3">
                      {projects.length <= 1 ? (
                        <Button
                          tone="outline"
                          aria-label={`Run ${f.name}`}
                          disabled={projects.length === 0}
                          title={projects.length === 0 ? 'Add a project first' : undefined}
                          onClick={() => projects[0] !== undefined && void newFlowSession(projects[0].id, f.id)}
                        >
                          <Play size={12} /> Run
                        </Button>
                      ) : (
                        <label className="flex h-8 items-center gap-1 rounded-md border border-line bg-panel pl-2.5 text-[12.5px] font-medium text-text hover:border-line-strong">
                          <Play size={12} />
                          <PillSelect aria-label={`Run ${f.name} in`} value="" onChange={(e) => e.target.value !== '' && void newFlowSession(e.target.value, f.id)} className="pl-0 font-medium text-text">
                            <option value="">Run in…</option>
                            {projects.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </PillSelect>
                        </label>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
            <button className="no-drag flex items-center gap-1 text-[13px] text-muted hover:text-text" onClick={() => open(null)}>
              <ChevronLeft size={15} /> Flows
            </button>
            <span className="text-faint">/</span>
            <span className="truncate text-[13.5px] font-semibold">{draft.name}</span>
            {dirty && <span className="text-[12px] text-warn">Unsaved</span>}
            {draft.builtin === true && <span className="text-[12px] text-faint">Saving keeps your version in place of this one</span>}
            <div className="no-drag ml-auto flex items-center gap-1.5">
              {isBuiltinCopy && (
                <Button
                  tone="quiet"
                  onClick={async () => {
                    if (!window.confirm('Go back to the version that ships with the app? Your changes to it are lost.')) return;
                    await api().deleteFlow(draft.id);
                    setDirty(false);
                    const fresh = (await api().getState()).flows.find((f) => f.id === draft.id);
                    if (fresh !== undefined) setDraftRaw(structuredClone(fresh));
                  }}
                >
                  <RotateCcw size={13} /> Reset
                </Button>
              )}
              <Button
                tone="quiet"
                onClick={async () => {
                  const copy = await api().saveFlow({ ...structuredClone(draft), id: newId('flow'), name: `${draft.name} copy` });
                  go({ kind: 'flows', flowId: copy.id });
                }}
              >
                <Copy size={13} /> Duplicate
              </Button>
              {draft.builtin !== true && !draft.id.startsWith('builtin-') && (
                <Button
                  tone="quiet"
                  onClick={async () => {
                    if (!window.confirm(`Delete "${draft.name}"?`)) return;
                    await api().deleteFlow(draft.id);
                    setDirty(false);
                    go({ kind: 'flows', flowId: null });
                  }}
                >
                  <Trash2 size={13} /> Delete
                </Button>
              )}
              <Button tone="primary" disabled={!dirty} onClick={() => void save()}>
                <Save size={13} /> Save
              </Button>
            </div>
          </header>
          <div className="flex min-h-0 flex-1">
            <ReactFlowProvider>
              <Canvas key={draft.id} draft={draft} setDraft={setDraft} selected={selected} setSelected={setSelected} />
            </ReactFlowProvider>
            <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-line bg-panel p-4">
              {node !== null && settings !== null ? (
                <NodeInspector
                  node={node}
                  flow={draft}
                  settings={settings}
                  onChange={(data) => setDraft((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === node.id ? ({ ...n, data } as FlowNode) : n)) }))}
                  onDelete={() => {
                    setDraft((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== node.id), edges: d.edges.filter((e) => e.source !== node.id && e.target !== node.id) }));
                    setSelected(null);
                  }}
                />
              ) : (
                <div className="space-y-4">
                  <Field label="Name">
                    <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                  </Field>
                  <Field label="Description" hint="Jev in Auto and chat agents read this when they choose a flow, so say what kind of work the flow is for.">
                    <TextArea rows={5} className="font-sans text-[12.5px]" value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
                  </Field>
                  {settings !== null && (
                    <Field label="Who can start this" hint={<InvokeHint flow={draft} ceiling={settings.invokeCeiling ?? DEFAULT_INVOKE_CEILING} />}>
                      <Select value={draft.invoke ?? 'auto'} onChange={(e) => setDraft((d) => ({ ...d, invoke: e.target.value as InvokeLevel }))}>
                        {INVOKE_LEVELS.map((l) => (
                          <option key={l} value={l}>
                            {INVOKE_INFO[l].label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  <div>
                    <div className="mb-1.5 text-[12px] font-medium text-muted">Checks</div>
                    {problems.length === 0 ? (
                      <div className="text-[12.5px] text-ok">No problems. This flow can run.</div>
                    ) : (
                      <ul className="space-y-1.5">
                        {problems.map((p, i) => (
                          <li key={i}>
                            <button
                              className={cx('w-full text-left text-[12.5px] leading-snug', p.level === 'error' ? 'text-bad' : 'text-warn')}
                              onClick={() => p.nodeId !== undefined && setSelected(p.nodeId)}
                            >
                              {p.message}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <p className="text-[12px] leading-relaxed text-faint">
                    Select a node to set it up. Drag from an output on the right of a node to the input on the left of another to connect them. Select a connection and press Delete to remove it.
                  </p>
                </div>
              )}
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}

function InvokeHint({ flow, ceiling }: { flow: Flow; ceiling: InvokeLevel }) {
  const own = flow.invoke ?? 'auto';
  const held = INVOKE_LEVELS.indexOf(own) > INVOKE_LEVELS.indexOf(ceiling);
  return (
    <>
      {INVOKE_INFO[own].summary} You can always start it yourself, or type <code className="font-mono">/{flowCommand(flow)}</code> in a session.
      {held && <span className="text-warn"> Settings allows at most "{INVOKE_INFO[ceiling].label}", so that is what applies.</span>}
    </>
  );
}
