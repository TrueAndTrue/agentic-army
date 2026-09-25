import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { GitMerge, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { DiffResult, FlowNode, Judgment, NodeVisit, Run } from '../../../shared/types.ts';
import { duration, NODE_STATUS_COLOR, RUN_STATUS_COLOR, RUN_STATUS_LABEL, tokenDetail, tokenLine } from '../lib/format.ts';
import { api, setState, useStore } from '../lib/state.ts';
import { AgentBody } from './AgentBlock.tsx';
import { layeredPositions, mapEdges, nodeTypes, toRfNodes, TYPE_ICON, nodeColor, useMeasured } from './FlowCanvas.tsx';
import { Markdown } from './Markdown.tsx';
import { jevVerdict } from './RunCard.tsx';
import { Button, cx, Dot, IconButton } from './ui.tsx';

type Tab = 'map' | 'steps' | 'changes';

function MapView({ run, onPick, picked }: { run: Run; onPick(id: string): void; picked: string | null }) {
  const settings = useStore((s) => s.settings);
  const measured = useMeasured();
  const layout = useMemo(() => layeredPositions(run.flow), [run.flow]);
  const nodes = useMemo(
    () =>
      toRfNodes(
        run.flow,
        settings,
        (n) => {
          const j = run.nodes[n.id]?.visits.at(-1)?.judgment;
          return {
            status: run.nodes[n.id]?.status ?? 'idle',
            visits: run.nodes[n.id]?.visits.length ?? 0,
            compact: true,
            ...(j === undefined ? {} : { note: jevVerdict(n, j) }),
          };
        },
        1,
      ).map((n) => ({ ...n, position: layout[n.id] ?? n.position }))
      .map((n) => ({ ...n, selected: n.id === picked, draggable: false, connectable: false })),
    [run, settings, picked, layout],
  );
  const edges = useMemo(() => mapEdges(run.flow, layout, (t) => run.nodes[t]?.status === 'running'), [run, layout]);
  const rf = useReactFlow();
  // The node to keep in view: whatever is running or waiting, else the last one that ran.
  const active = useMemo(() => {
    const live = run.flow.nodes.find((n) => ['running', 'waiting'].includes(run.nodes[n.id]?.status ?? ''));
    if (live !== undefined) return live;
    return [...run.flow.nodes]
      .filter((n) => (run.nodes[n.id]?.visits.length ?? 0) > 0)
      .sort((a, b) => (run.nodes[b.id]?.visits.at(-1)?.startedAt ?? '').localeCompare(run.nodes[a.id]?.visits.at(-1)?.startedAt ?? ''))[0];
  }, [run]);
  const activeId = active?.id;
  useEffect(() => {
    const t = setTimeout(() => {
      void rf.fitView({ padding: 0.12, maxZoom: 1 }).then(() => {
        // Too small to read: zoom to a legible size and centre on the active node instead.
        if (rf.getZoom() < 0.6 && active !== undefined) void rf.setCenter((layout[active.id]?.x ?? 0) + 86, (layout[active.id]?.y ?? 0) + 23, { zoom: 0.75 });
      });
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, rf]);
  useEffect(() => {
    if (active === undefined || rf.getZoom() >= 0.6) return;
    void rf.setCenter((layout[active.id]?.x ?? 0) + 86, (layout[active.id]?.y ?? 0) + 23, { zoom: rf.getZoom(), duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  return (
    <ReactFlow
      nodes={measured.withMeasured(nodes)}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={measured.apply}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onNodeClick={(_e, n) => onPick(n.id)}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--canvas-dot)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/** What Jev was asked, what it said, and how that became the path the run took. */
function JevBlock({ node, j }: { node: FlowNode; j: Judgment }) {
  const d = node.type === 'decide' ? node.data : null;
  const rule =
    d === null
      ? null
      : j.mode === 'yesno'
        ? `It answers with the chance the answer is yes. At ${Math.round(d.threshold * 100)}% or more this step goes "yes"${d.minConfidence > 0 ? `, and within ${Math.round(d.minConfidence * 50)} points of 50% it goes "unsure"` : ''}.`
        : j.mode === 'score'
          ? `It places the answer on the levels below. At "${d.levels[d.cut] ?? d.cut}" or higher this step goes "high".`
          : `It picks one option; the bars show how likely it found each.${d.minConfidence > 0 ? ` Below ${Math.round(d.minConfidence * 100)}% sure it goes "unsure".` : ''}`;
  return (
    <div className="rounded-md border border-brass/40 bg-brass-soft px-3 py-2.5 text-[12.5px]">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">Jev: {jevVerdict(node, j)}</span>
        <span className="text-[11.5px] text-faint">
          {j.model ?? 'Jev'}
          {j.latencyMs !== undefined && `, ${j.latencyMs} ms`}
        </span>
      </div>
      {j.question !== undefined && <p className="selectable mt-1 text-muted">Asked: {j.question}</p>}
      <div className="mt-2 space-y-1">
        {Object.entries(j.probabilities)
          .sort((a, b) => b[1] - a[1])
          .map(([k, p]) => (
            <div key={k} className="flex items-center gap-2">
              <span className={cx('w-24 truncate font-mono text-[11px]', k === j.answer ? 'text-text' : 'text-muted')}>{k}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded bg-raised">
                <span className={cx('block h-full', k === j.answer ? 'bg-brass' : 'bg-line-strong')} style={{ width: `${Math.round(p * 100)}%` }} />
              </span>
              <span className="w-9 text-right font-mono text-[11px] text-faint">{Math.round(p * 100)}%</span>
            </div>
          ))}
      </div>
      {rule !== null && <p className="mt-2 text-[11.5px] text-faint">{rule}</p>}
    </div>
  );
}

function VisitView({ node, visit }: { node: FlowNode; visit: NodeVisit }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 text-[11.5px] text-faint">
        <span>Visit {visit.n}</span>
        <span>{duration(visit.startedAt, visit.endedAt)}</span>
        {visit.handle !== undefined && visit.handle !== '' && <span className="rounded bg-raised px-1.5 py-px font-mono text-muted">→ {visit.handle}</span>}
        {tokenLine(visit.turn?.tokens) !== '' && <span title={tokenDetail(visit.turn?.tokens)}>{tokenLine(visit.turn?.tokens)}</span>}
      </div>
      {node.type !== 'start' && visit.input.trim() !== '' && (
        <details className="group rounded-md border border-line bg-raised">
          <summary className="cursor-pointer px-2.5 py-1.5 text-[12px] text-muted">Input</summary>
          <pre className="selectable max-h-60 overflow-auto px-2.5 pb-2 font-mono text-[11.5px] whitespace-pre-wrap text-muted">{visit.input}</pre>
        </details>
      )}
      {visit.turn !== undefined && <AgentBody turn={visit.turn} compact />}
      {visit.judgment !== undefined && <JevBlock node={node} j={visit.judgment} />}
      {visit.steps !== undefined && visit.steps.length > 0 && (
        <ol className="space-y-1.5">
          {visit.steps.map((s) => (
            <li key={s.n} className="rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px]">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-faint">{s.n}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{s.action}</span>
                <span className={cx('text-[11px]', s.outcome === 'refused' || s.outcome === 'failed' ? 'text-bad' : s.outcome === 'approved' ? 'text-warn' : 'text-faint')}>{s.outcome}</span>
              </div>
              <div className="truncate text-[11px] text-faint">
                {s.url}
                {s.risk !== undefined && ` · risk ${Math.round(s.risk * 100)}%`}
              </div>
            </li>
          ))}
        </ol>
      )}
      {visit.log !== undefined && <pre className="selectable max-h-72 overflow-auto rounded-md border border-line bg-raised px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-muted">{visit.log}</pre>}
      {visit.error !== undefined && <div className="selectable rounded-md border border-bad/40 bg-bad/10 px-2.5 py-1.5 text-[12px] text-bad">{visit.error}</div>}
      {visit.output !== undefined && node.type !== 'agent' && node.type !== 'shell' && node.type !== 'git' && node.type !== 'start' && visit.output.trim() !== '' && (
        <details className="rounded-md border border-line bg-raised" open={node.type === 'end'}>
          <summary className="cursor-pointer px-2.5 py-1.5 text-[12px] text-muted">Output</summary>
          <div className="px-2.5 pb-2">
            <Markdown text={visit.output} className="text-[12.5px]" />
          </div>
        </details>
      )}
    </div>
  );
}

function Steps({ run, focus }: { run: Run; focus: string | null }) {
  const settings = useStore((s) => s.settings);
  const running = run.flow.nodes.find((n) => run.nodes[n.id]?.status === 'running' || run.nodes[n.id]?.status === 'waiting')?.id;
  // Keep the step that is working in view as earlier steps fill with output.
  useEffect(() => {
    if (running === undefined) return;
    document.getElementById(`step-${run.id}-${running}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [running, run.id]);
  const who = (n: FlowNode): string | null => {
    if (n.type === 'decide') return 'Jev';
    if (n.type !== 'agent') return null;
    const id = n.data.modelId ?? settings?.stageDefaults[n.data.role].modelId;
    return settings?.models.find((m) => m.id === id)?.label ?? null;
  };
  const nodes = run.flow.nodes
    .filter((n) => (run.nodes[n.id]?.visits.length ?? 0) > 0 && (focus === null || n.id === focus))
    .sort((a, b) => (run.nodes[a.id]?.visits[0]?.startedAt ?? '').localeCompare(run.nodes[b.id]?.visits[0]?.startedAt ?? ''));
  if (nodes.length === 0) return <div className="p-4 text-[12.5px] text-faint">{focus === null ? 'Nothing has run yet.' : 'This node has not run yet.'}</div>;
  return (
    <div className="space-y-4 p-4">
      {nodes.map((n) => {
        const Icon = TYPE_ICON[n.type];
        const st = run.nodes[n.id]!;
        return (
          <section key={n.id} id={`step-${run.id}-${n.id}`}>
            <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
              <Icon size={14} style={{ color: nodeColor(n) }} />
              {n.data.label}
              {who(n) !== null && <span className="text-[11.5px] font-normal text-muted">{who(n)}</span>}
              <Dot color={NODE_STATUS_COLOR[st.status]} pulse={st.status === 'running'} />
              <span className="text-[11.5px] font-normal text-faint">{st.status}</span>
            </h3>
            <div className="space-y-3 border-l border-line pl-3">
              {st.visits.map((v) => (
                <VisitView key={v.n} node={n} visit={v} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DiffLine({ line }: { line: string }) {
  const color = line.startsWith('+++') || line.startsWith('---') ? 'text-muted' : line.startsWith('+') ? 'text-ok' : line.startsWith('-') ? 'text-bad' : line.startsWith('@@') ? 'text-run' : line.startsWith('diff ') ? 'text-text font-semibold' : 'text-faint';
  return <div className={cx('min-h-[1.2em] whitespace-pre', color)}>{line}</div>;
}

function Changes({ run }: { run: Run }) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void api().runDiff(run.id).then(setDiff);
  useEffect(load, [run.id, run.status, run.branch]);
  const live = run.status === 'running' || run.status === 'waiting';
  if (run.branch === undefined) return <div className="p-4 text-[12.5px] text-faint">{live ? 'No node has written anything yet.' : 'This run changed no files.'}</div>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-mono text-[12px] text-muted">
          {run.branch} ← {run.baseRef}
        </span>
        <IconButton label="Refresh" onClick={load} className="ml-auto">
          <RefreshCw size={13} />
        </IconButton>
        {run.merged === true ? (
          <span className="text-[12px] text-ok">Merged</span>
        ) : (
          <Button
            tone="primary"
            disabled={live || busy}
            title={live ? 'Merge when the run finishes' : undefined}
            onClick={async () => {
              setBusy(true);
              const r = await api().mergeRun(run.id);
              setMessage({ ok: r.ok, text: r.message });
              setBusy(false);
            }}
          >
            <GitMerge size={14} /> Merge into {run.baseRef}
          </Button>
        )}
      </div>
      {message !== null && <div className={cx('selectable shrink-0 border-b border-line px-4 py-2 text-[12px] whitespace-pre-wrap', message.ok ? 'text-ok' : 'text-bad')}>{message.text}</div>}
      <div className="selectable min-h-0 flex-1 overflow-auto p-4 font-mono text-[11.5px] leading-[1.45]">
        {diff === null ? (
          <span className="text-faint">Loading…</span>
        ) : diff.patch === '' ? (
          <span className="text-faint">No changes.</span>
        ) : (
          <>
            <pre className="mb-3 whitespace-pre-wrap text-muted">{diff.stat}</pre>
            {diff.patch.split('\n').map((l, i) => (
              <DiffLine key={i} line={l} />
            ))}
            {diff.truncated && <div className="mt-2 text-warn">The diff is longer than this; the rest is on the branch.</div>}
          </>
        )}
      </div>
    </div>
  );
}

export function RunPanel({ run }: { run: Run }) {
  const tab = useStore((s) => s.panelTab);
  const setTab = (t: Tab) => setState({ panelTab: t });
  const [focus, setFocus] = useState<string | null>(null);
  const live = run.status === 'running' || run.status === 'waiting';
  return (
    <aside className="flex h-full w-[50%] min-w-[440px] max-w-[820px] shrink-0 flex-col border-l border-line bg-panel max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:right-0 max-[1180px]:z-30 max-[1180px]:w-[min(560px,92%)] max-[1180px]:min-w-0 max-[1180px]:shadow-[-12px_0_32px_rgba(0,0,0,0.28)]">
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Dot color={RUN_STATUS_COLOR[run.status]} pulse={live} />
        <span className="truncate text-[13px] font-semibold">{run.flowName}</span>
        <span className="text-[12px] text-muted">{RUN_STATUS_LABEL[run.status]}</span>
        <div className="no-drag ml-auto flex items-center rounded-md border border-line p-0.5">
          {(['map', 'steps', 'changes'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cx('h-6 rounded px-2.5 text-[12px] capitalize', tab === t ? 'bg-hover text-text' : 'text-muted hover:text-text')}>
              {t}
            </button>
          ))}
        </div>
        <IconButton label="Close run panel" onClick={() => setState({ panelRunId: null })}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'map' && (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <ReactFlowProvider>
                <MapView
                  run={run}
                  picked={focus}
                  onPick={(id) => {
                    setFocus(id);
                    setTab('steps');
                  }}
                />
              </ReactFlowProvider>
            </div>
            <div className="shrink-0 border-t border-line px-4 py-2 text-[11.5px] text-faint">
              Click a node to read what it did. {tokenLine(run.tokens) !== '' && `All agents together: ${tokenLine(run.tokens)}.`}
            </div>
          </div>
        )}
        {tab === 'steps' && (
          <>
            {focus !== null && (
              <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[12px] text-muted">
                Showing one node.
                <button className="text-brass underline" onClick={() => setFocus(null)}>
                  Show every step
                </button>
              </div>
            )}
            <Steps run={run} focus={focus} />
          </>
        )}
        {tab === 'changes' && <Changes run={run} />}
      </div>
    </aside>
  );
}
