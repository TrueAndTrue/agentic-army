import { ArrowUp, Pencil, Square, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { fitEffort } from '../../../shared/models.ts';
import type { Session, SessionItem } from '../../../shared/types.ts';
import { api, go, setState, useStore } from '../lib/state.ts';
import { AgentBlock } from './AgentBlock.tsx';
import { RunCard } from './RunCard.tsx';
import { RunPanel } from './RunPanel.tsx';
import { cx, EffortOptions, IconButton, Kbd, ModelOptions, PillSelect } from './ui.tsx';

function Item({ item }: { item: SessionItem }) {
  const settings = useStore((s) => s.settings);
  const run = useStore((s) => (item.kind === 'run' ? s.runById[item.runId] : undefined));
  const panelRunId = useStore((s) => s.panelRunId);
  const flows = useStore((s) => s.flows);
  switch (item.kind) {
    case 'user': {
      const flow = item.flowId === undefined ? undefined : flows.find((f) => f.id === item.flowId);
      return (
        <div className="flex flex-col items-end">
          {flow !== undefined && <div className="mb-1 text-[11.5px] text-faint">to {flow.name}</div>}
          <div className="selectable max-w-[85%] rounded-2xl rounded-br-md bg-raised px-3.5 py-2 text-[13.5px] whitespace-pre-wrap">{item.text}</div>
        </div>
      );
    }
    case 'agent': {
      const label = settings?.models.find((m) => m.id === item.modelId)?.label ?? item.modelId;
      return <AgentBlock turn={item} modelLabel={label} />;
    }
    case 'run':
      return <RunCard run={run} active={panelRunId === item.runId} />;
    case 'notice':
      return (
        <div className={cx('selectable text-center text-[12px]', item.tone === 'error' ? 'text-bad' : item.tone === 'warn' ? 'text-warn' : 'text-faint')}>{item.text}</div>
      );
  }
}

const TARGET_KEY = 'army.target.';

function Composer({ session, busy }: { session: Session; busy: boolean }) {
  const settings = useStore((s) => s.settings);
  const flows = useStore((s) => s.flows);
  const [text, setText] = useState('');
  const [target, setTargetRaw] = useState<string>(() => {
    try {
      return localStorage.getItem(TARGET_KEY + session.id) ?? 'chat';
    } catch {
      return 'chat';
    }
  });
  const ref = useRef<HTMLTextAreaElement>(null);
  const setTarget = (t: string) => {
    setTargetRaw(t);
    try {
      localStorage.setItem(TARGET_KEY + session.id, t);
    } catch {
      /* convenience only */
    }
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);
  useEffect(() => ref.current?.focus(), [session.id]);

  const flowExists = target === 'chat' || target === 'auto' || flows.some((f) => f.id === target);
  const effectiveTarget = flowExists ? target : 'chat';
  const chatBusy = busy && effectiveTarget === 'chat';
  const chatModel = settings?.models.find((m) => m.id === session.chat.modelId);

  const send = () => {
    const body = text.trim();
    if (body === '' || chatBusy) return;
    setText('');
    void api().send(session.id, body, effectiveTarget === 'chat' ? null : effectiveTarget);
  };

  const noJevKey = settings !== null && settings.typesafe.apiKey.trim() === '';

  return (
    <div className="mx-auto w-full max-w-[820px] px-6 pb-5">
      <div className="rounded-2xl border border-line bg-panel shadow-[0_2px_12px_rgba(0,0,0,0.18)] focus-within:border-line-strong">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          aria-label="Message"
          placeholder={effectiveTarget === 'chat' ? 'Ask or tell the agent something' : effectiveTarget === 'auto' ? 'Describe the work; Jev picks a flow or a chat' : `Describe the objective for ${flows.find((f) => f.id === effectiveTarget)?.name ?? 'the flow'}`}
          className="block max-h-[260px] min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed placeholder:text-faint focus:outline-none focus-visible:outline-none"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <PillSelect aria-label="Where this message goes" value={effectiveTarget} onChange={(e) => setTarget(e.target.value)} className="font-medium text-text">
            <option value="chat">Chat</option>
            <option value="auto" disabled={noJevKey}>
              Auto: Jev picks{noJevKey ? ' (needs a TypeSafe key)' : ''}
            </option>
            <optgroup label="Run a flow">
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          </PillSelect>
          {effectiveTarget === 'chat' && settings !== null && (
            <>
              <PillSelect
                aria-label="Model"
                value={session.chat.modelId}
                onChange={(e) => {
                  const next = settings.models.find((m) => m.id === e.target.value);
                  void api().setChat(session.id, { modelId: e.target.value, effort: fitEffort(next, session.chat.effort) });
                }}
              >
                <ModelOptions models={settings.models} />
              </PillSelect>
              <PillSelect
                aria-label="Effort"
                value={fitEffort(chatModel, session.chat.effort)}
                onChange={(e) => void api().setChat(session.id, { effort: e.target.value as Session['chat']['effort'] })}
              >
                <EffortOptions model={chatModel} suffix=" effort" />
              </PillSelect>
              <PillSelect aria-label="Permissions" value={session.chat.edits ? 'edit' : 'read'} onChange={(e) => void api().setChat(session.id, { edits: e.target.value === 'edit' })}>
                <option value="edit">Can edit files</option>
                <option value="read">Read only</option>
              </PillSelect>
            </>
          )}
          {effectiveTarget !== 'chat' && effectiveTarget !== 'auto' && (
            <button className="h-7 rounded-md px-2 text-[12.5px] text-muted hover:bg-hover hover:text-text" onClick={() => go({ kind: 'flows', flowId: effectiveTarget })}>
              View flow
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {busy && (
              <button
                onClick={() => void api().stop(session.id)}
                className="flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] text-muted hover:bg-hover hover:text-text"
                title="Stop everything in this session"
              >
                <Square size={11} fill="currentColor" /> Stop
              </button>
            )}
            <button
              onClick={send}
              disabled={text.trim() === '' || chatBusy}
              aria-label="Send"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-brass text-brass-ink transition-opacity disabled:opacity-30"
            >
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex justify-center gap-3 text-[11px] text-faint">
        <span>
          <Kbd>Enter</Kbd> send
        </span>
        <span>
          <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
        </span>
      </div>
    </div>
  );
}

function Title({ session }: { session: Session }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(session.title);
  useEffect(() => setValue(session.title), [session.title]);
  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setEditing(false);
          void api().renameSession(session.id, value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setValue(session.title);
            setEditing(false);
          }
        }}
        className="no-drag h-7 w-[360px] rounded-md border border-line bg-panel px-2 text-[13.5px] font-semibold focus:outline-none"
      />
    );
  }
  return (
    <button onDoubleClick={() => setEditing(true)} className="no-drag group flex max-w-[60%] min-w-[120px] shrink-0 items-center gap-1.5 text-left" title="Double-click to rename">
      <span className="truncate text-[13.5px] font-semibold">{session.title}</span>
      <Pencil size={12} className="shrink-0 text-faint opacity-0 group-hover:opacity-100" onClick={() => setEditing(true)} />
    </button>
  );
}

export function SessionView({ id }: { id: string }) {
  const session = useStore((s) => s.sessionById[id]);
  const summary = useStore((s) => s.sessions.find((x) => x.id === id));
  const project = useStore((s) => s.projects.find((p) => p.id === session?.projectId));
  const panelRun = useStore((s) => (s.panelRunId === null ? undefined : s.runById[s.panelRunId]));
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const last = session?.items.at(-1);
  const lastLen = last?.kind === 'agent' ? last.text.length + last.tools.length : 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight;
  }, [session?.items.length, lastLen, session?.id]);

  if (session === undefined) return <div className="flex flex-1 items-center justify-center text-faint">Loading…</div>;
  const busy = summary?.busy ?? false;

  return (
    <div className="flex min-w-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
          <Title session={session} />
          {project !== undefined && (
            <span className="min-w-0 truncate font-mono text-[11.5px] text-faint" title={project.path}>
              {project.path.replace(/^\/Users\/[^/]+/, '~')}
            </span>
          )}
          <div className="no-drag ml-auto flex items-center">
            <IconButton
              label="Delete this session"
              onClick={() => {
                if (window.confirm('Delete this session? Its runs are stopped and their record removed. Branches stay in git.')) {
                  void api().deleteSession(session.id);
                  setState({ panelRunId: null });
                  go({ kind: 'home' });
                }
              }}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        </header>
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="mx-auto max-w-[820px] space-y-5 px-6 py-6">
            {session.items.length === 0 && (
              <div className="pt-[14vh] text-center">
                <h2 className="text-[20px] font-semibold tracking-tight">What should we work on{project !== undefined ? ` in ${project.name}` : ''}?</h2>
                <p className="mx-auto mt-2 max-w-[440px] text-[13px] leading-relaxed text-muted">
                  Chat with one agent in this folder, or pick a flow below to run a team of them. Flows work on their own branch, so your checkout is untouched until you merge.
                </p>
              </div>
            )}
            {session.items.map((item) => (
              <Item key={item.id} item={item} />
            ))}
          </div>
        </div>
        <Composer session={session} busy={busy} />
      </main>
      {panelRun !== undefined && panelRun.sessionId === session.id && <RunPanel run={panelRun} />}
    </div>
  );
}

