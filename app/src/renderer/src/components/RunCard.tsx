import { ChevronDown, GitMerge, Map as MapIcon, Square } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { PendingQuestion, Run } from '../../../shared/types.ts';
import { duration, NODE_STATUS_COLOR, RUN_STATUS_COLOR, RUN_STATUS_LABEL, usd } from '../lib/format.ts';
import { api, setState } from '../lib/state.ts';
import { Markdown } from './Markdown.tsx';
import { Button, cx, Dot, TextArea } from './ui.tsx';

function Ticker({ run }: { run: Run }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (run.endedAt !== undefined) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [run.endedAt]);
  return <span>{duration(run.startedAt, run.endedAt)}</span>;
}

function Question({ run, q }: { run: Run; q: PendingQuestion }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const answer = async (approve: boolean) => {
    setBusy(true);
    await api().answer(run.id, q.id, approve, note);
  };
  return (
    <div className="rounded-lg border border-warn/50 bg-warn/[0.07] p-3">
      <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold">
        <Dot color="var(--warn)" pulse />
        {q.title}
      </div>
      <div className="max-h-[320px] overflow-y-auto pr-1">
        <Markdown text={q.body} className="text-[12.5px]" />
      </div>
      <TextArea
        className="mt-2.5 font-sans text-[12.5px]"
        rows={2}
        placeholder={q.kind === 'guard' ? 'Optional note' : 'Optional note. On a rejection, say what to change; it goes back with the work.'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <Button tone="primary" disabled={busy} onClick={() => void answer(true)}>
          {q.kind === 'guard' ? 'Allow' : 'Approve'}
        </Button>
        <Button disabled={busy} onClick={() => void answer(false)}>
          {q.kind === 'guard' ? 'Refuse' : 'Reject'}
        </Button>
      </div>
    </div>
  );
}

export function RunCard({ run, active }: { run: Run | undefined; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (run === undefined) return <div className="text-[12px] text-faint">Loading run…</div>;
  const live = run.status === 'running' || run.status === 'waiting';
  const order = run.flow.nodes
    .filter((n) => (run.nodes[n.id]?.visits.length ?? 0) > 0 || run.nodes[n.id]?.status === 'queued')
    .sort((a, b) => (run.nodes[a.id]?.visits[0]?.startedAt ?? 'z').localeCompare(run.nodes[b.id]?.visits[0]?.startedAt ?? 'z'));
  const result = run.result ?? '';
  const long = result.length > 900;

  return (
    <article className={cx('rounded-xl border bg-panel', active ? 'border-brass/60' : 'border-line')}>
      <header className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <Dot color={RUN_STATUS_COLOR[run.status]} pulse={live} />
        <span className="text-[13px] font-semibold">{run.flowName}</span>
        <span className="text-[12px] text-muted">{RUN_STATUS_LABEL[run.status]}</span>
        <span className="ml-auto flex items-center gap-3 text-[12px] text-faint">
          {run.costUsd > 0 && <span>{usd(run.costUsd)}</span>}
          <Ticker run={run} />
        </span>
      </header>

      <div className="space-y-3 px-3.5 py-3">
        <ol className="flex flex-wrap gap-1.5" aria-label="Steps">
          {order.length === 0 && <li className="text-[12px] text-faint">Starting…</li>}
          {order.map((n) => {
            const st = run.nodes[n.id]!;
            return (
              <li key={n.id}>
                <button
                  onClick={() => setState({ panelRunId: run.id, panelTab: 'steps' })}
                  className="flex h-6 items-center gap-1.5 rounded-md border border-line bg-raised px-2 text-[11.5px] text-muted hover:text-text"
                >
                  <Dot color={NODE_STATUS_COLOR[st.status]} pulse={st.status === 'running' || st.status === 'waiting'} className="h-1.5 w-1.5" />
                  {n.data.label}
                  {st.visits.length > 1 && <span className="font-mono text-[10.5px] text-faint">×{st.visits.length}</span>}
                </button>
              </li>
            );
          })}
        </ol>

        {run.pending.map((q) => (
          <Question key={q.id} run={run} q={q} />
        ))}

        {run.error !== undefined && <div className="selectable rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{run.error}</div>}

        {!live && result.trim() !== '' && (
          <div>
            <div className={cx('relative overflow-hidden', long && !expanded && 'max-h-[240px]')}>
              <Markdown text={result} className="text-[13px]" />
              {long && !expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-panel" />}
            </div>
            {long && (
              <button onClick={() => setExpanded((e) => !e)} className="mt-1 flex items-center gap-1 text-[12px] text-muted hover:text-text">
                <ChevronDown size={13} className={cx(expanded && 'rotate-180')} /> {expanded ? 'Show less' : 'Show all'}
              </button>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button tone="outline" onClick={() => setState({ panelRunId: run.id, panelTab: 'map' })}>
            <MapIcon size={14} /> Open run
          </Button>
          {live && (
            <Button tone="quiet" onClick={() => void api().stopRun(run.id)}>
              <Square size={12} /> Stop
            </Button>
          )}
          {!live && run.branch !== undefined && !run.merged && (
            <Button tone="outline" onClick={() => setState({ panelRunId: run.id, panelTab: 'changes' })}>
              <GitMerge size={14} /> Review changes on {run.branch}
            </Button>
          )}
          {run.merged === true && <span className="text-[12px] text-ok">Merged</span>}
        </div>
      </div>
    </article>
  );
}
