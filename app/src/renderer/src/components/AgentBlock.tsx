import { Check, ChevronRight, CircleAlert, LoaderCircle, Wrench } from 'lucide-react';
import { useState } from 'react';

import type { AgentTurn, ToolCall } from '../../../shared/types.ts';
import { tokenDetail, tokenLine } from '../lib/format.ts';
import { Markdown } from './Markdown.tsx';
import { cx } from './ui.tsx';

function ToolLine({ t }: { t: ToolCall }) {
  return (
    <li className="flex min-w-0 items-center gap-2 py-[3px] text-[12px]">
      {t.status === 'running' ? (
        <LoaderCircle size={12} className="shrink-0 animate-spin text-run" />
      ) : t.status === 'ok' ? (
        <Check size={12} className="shrink-0 text-ok" />
      ) : (
        <CircleAlert size={12} className="shrink-0 text-bad" />
      )}
      <span className="shrink-0 font-medium text-muted">{t.name}</span>
      <span className="selectable min-w-0 truncate font-mono text-[11.5px] text-faint">{t.summary}</span>
    </li>
  );
}

export function ToolList({ tools, live }: { tools: ToolCall[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 0) return null;
  const shown = open ? tools : live ? tools.slice(-3) : [];
  return (
    <div className="mb-2">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12px] text-faint hover:text-muted">
        <ChevronRight size={13} className={cx('transition-transform', open && 'rotate-90')} />
        <Wrench size={12} />
        {tools.length} tool {tools.length === 1 ? 'call' : 'calls'}
        {!open && live && tools.length > 3 && <span>, latest</span>}
      </button>
      {shown.length > 0 && <ul className="mt-1 border-l border-line pl-3">{shown.map((t) => <ToolLine key={t.id} t={t} />)}</ul>}
    </div>
  );
}

export function AgentBody({ turn, compact }: { turn: AgentTurn; compact?: boolean }) {
  const live = turn.status === 'running';
  return (
    <div>
      <ToolList tools={turn.tools} live={live} />
      {turn.text === '' && live ? (
        <div className="caret text-[13px] text-faint">{turn.tools.length > 0 ? 'Working' : 'Thinking'}</div>
      ) : (
        <div className={cx(live && 'caret-host')}>
          <Markdown text={turn.text} className={compact ? 'text-[12.5px]' : undefined} />
          {live && <span className="caret" />}
        </div>
      )}
      {turn.status === 'error' && (
        <div className="selectable mt-2 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{turn.error ?? 'The agent failed.'}</div>
      )}
      {turn.status === 'stopped' && <div className="mt-2 text-[12px] text-faint">Stopped{turn.error !== undefined ? `: ${turn.error}` : '.'}</div>}
    </div>
  );
}

export function AgentBlock({ turn, modelLabel }: { turn: AgentTurn; modelLabel: string }) {
  return (
    <article className="group">
      <header className="mb-1.5 flex items-center gap-2 text-[12px] text-faint">
        <span className="font-medium text-muted">{modelLabel}</span>
        {turn.status !== 'running' && tokenLine(turn.tokens) !== '' && <span title={tokenDetail(turn.tokens)}>{tokenLine(turn.tokens)}</span>}
      </header>
      <AgentBody turn={turn} />
    </article>
  );
}
