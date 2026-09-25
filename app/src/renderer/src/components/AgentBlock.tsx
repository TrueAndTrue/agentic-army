import { Check, ChevronRight, CircleAlert, LoaderCircle, Wrench } from 'lucide-react';
import { useContext, useState } from 'react';

import type { AgentTurn, ToolCall } from '../../../shared/types.ts';
import { tokenDetail, tokenLine } from '../lib/format.ts';
import { CopyButton, LinkBase, Markdown } from './Markdown.tsx';
import { cx } from './ui.tsx';

/** The CLI's own plumbing: loading a tool is not work the person asked for. */
const HIDDEN_TOOLS = new Set(['ToolSearch']);

function ToolLine({ t }: { t: ToolCall }) {
  const base = useContext(LinkBase);
  // Paths inside the project read from the project, so the file name is what survives truncation.
  const summary = base === undefined ? t.summary : t.summary.split(`${base}/`).join('');
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
      <span className="selectable min-w-0 truncate font-mono text-[11.5px] text-faint" title={t.summary}>
        {summary}
      </span>
    </li>
  );
}

export function ToolList({ tools: all, live }: { tools: ToolCall[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = all.filter((t) => !HIDDEN_TOOLS.has(t.name));
  if (tools.length === 0) return null;
  const failed = tools.filter((t) => t.status === 'error').length;
  const shown = open ? tools : live ? tools.slice(-3) : [];
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12px] text-faint hover:text-muted">
        <ChevronRight size={13} className={cx('transition-transform', open && 'rotate-90')} />
        <Wrench size={12} />
        <span>
          {tools.length} tool {tools.length === 1 ? 'call' : 'calls'}
          {failed > 0 && <span className="text-bad">, {failed} failed</span>}
          {!open && live && tools.length > 3 && ', latest'}
        </span>
      </button>
      {shown.length > 0 && <ul className="mt-1 border-l border-line pl-3">{shown.map((t) => <ToolLine key={t.id} t={t} />)}</ul>}
    </div>
  );
}

/**
 * The turn as it happened: text, then the tools it ran, then more text. Each tool records how much
 * text came before it; tools from turns saved before that was recorded all sit at the top.
 */
function segments(turn: AgentTurn): { text: string; tools: ToolCall[] }[] {
  const out: { text: string; tools: ToolCall[] }[] = [];
  let from = 0;
  let group: ToolCall[] = [];
  for (const t of turn.tools) {
    const at = Math.min(t.at ?? 0, turn.text.length);
    if (at > from) {
      if (group.length > 0) out.push({ text: '', tools: group });
      group = [];
      out.push({ text: turn.text.slice(from, at), tools: [] });
      from = at;
    }
    group.push(t);
  }
  if (group.length > 0) out.push({ text: '', tools: group });
  if (from < turn.text.length) out.push({ text: turn.text.slice(from), tools: [] });
  return out;
}

export function AgentBody({ turn, compact }: { turn: AgentTurn; compact?: boolean }) {
  const live = turn.status === 'running';
  const parts = segments(turn);
  return (
    <div>
      {turn.text === '' && turn.tools.length === 0 && live ? (
        <div className="caret text-[13px] text-faint">Thinking</div>
      ) : (
        <div className={cx(live && 'caret-host', 'space-y-2')}>
          {parts.map((p, i) =>
            p.tools.length > 0 ? (
              <ToolList key={`t${i}`} tools={p.tools} live={live && i === parts.length - 1} />
            ) : p.text.trim() === '' ? null : (
              <Markdown key={`m${i}`} text={p.text} className={compact ? 'text-[12.5px]' : undefined} />
            ),
          )}
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
        {turn.status !== 'running' && turn.text.trim() !== '' && (
          <CopyButton text={turn.text.trim()} label="Copy reply" className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100" />
        )}
      </header>
      <AgentBody turn={turn} />
    </article>
  );
}
