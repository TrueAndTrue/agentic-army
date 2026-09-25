import { ArrowUp, ChevronDown, FolderX, GitBranch, Pencil, Square, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { flowCommand, parseFlowCommand } from '../../../shared/flow.ts';
import { fitEffort } from '../../../shared/models.ts';
import type { Flow, Project, ProjectHealth, Session, SessionItem } from '../../../shared/types.ts';
import { api, getState, go, openSession, setState, useStore } from '../lib/state.ts';
import { AgentBlock } from './AgentBlock.tsx';
import { FlowRequestCard } from './FlowRequestCard.tsx';
import { LinkBase } from './Markdown.tsx';
import { NeedsJevCard } from './NeedsJevCard.tsx';
import { RunCard } from './RunCard.tsx';
import { RunPanel } from './RunPanel.tsx';
import { Button, cx, EffortOptions, IconButton, Kbd, ModelOptions, PillSelect } from './ui.tsx';

/** `~/code/app` for a path under home, and only the last few folders of a long one. */
export function shortPath(path: string): string {
  const home = path.replace(/^\/Users\/[^/]+/, '~');
  const parts = home.split('/');
  return parts.length > 4 ? `${parts[0] === '~' ? '~/…' : '…'}/${parts.slice(-2).join('/')}` : home;
}

const LONG_LINES = 14;
const LONG_CHARS = 1400;

function UserBubble({ text, flow }: { text: string; flow: Flow | undefined }) {
  const long = text.split('\n').length > LONG_LINES || text.length > LONG_CHARS;
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-end">
      {flow !== undefined && <div className="mb-1 text-[11.5px] text-faint">to {flow.name}</div>}
      <div className={cx('selectable relative max-w-[85%] overflow-hidden rounded-2xl rounded-br-md bg-raised px-3.5 py-2 text-[13.5px] whitespace-pre-wrap', long && !open && 'max-h-[260px]')}>
        {text}
        {long && !open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-raised" />}
      </div>
      {long && (
        <button onClick={() => setOpen((o) => !o)} className="mt-1 flex items-center gap-1 text-[12px] text-muted hover:text-text">
          <ChevronDown size={13} className={cx(open && 'rotate-180')} /> {open ? 'Show less' : `Show all ${text.split('\n').length} lines`}
        </button>
      )}
    </div>
  );
}

function Item({ item, sessionId }: { item: SessionItem; sessionId: string }) {
  const settings = useStore((s) => s.settings);
  const run = useStore((s) => (item.kind === 'run' ? s.runById[item.runId] : undefined));
  const panelRunId = useStore((s) => s.panelRunId);
  const flows = useStore((s) => s.flows);
  switch (item.kind) {
    case 'user':
      return <UserBubble text={item.text} flow={item.flowId === undefined ? undefined : flows.find((f) => f.id === item.flowId)} />;
    case 'agent': {
      const label = settings?.models.find((m) => m.id === item.modelId)?.label ?? item.modelId;
      return <AgentBlock turn={item} modelLabel={label} />;
    }
    case 'run':
      return <RunCard run={run} active={panelRunId === item.runId} />;
    case 'flow-request':
      return <FlowRequestCard sessionId={sessionId} item={item} />;
    case 'needs-jev':
      return <NeedsJevCard sessionId={sessionId} item={item} />;
    case 'notice':
      return (
        <div className={cx('selectable mx-auto max-w-[620px] text-center text-[12px] whitespace-pre-wrap', item.tone === 'error' ? 'text-bad' : item.tone === 'warn' ? 'text-warn' : 'text-faint')}>{item.text}</div>
      );
  }
}

const TARGET_KEY = 'army.target.';
const DRAFT_KEY = 'army.draft.';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null): void {
  try {
    if (value === null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* a convenience only */
  }
}

function usesJev(f: Flow): boolean {
  return f.nodes.some((n) => n.type === 'decide' || n.type === 'browser');
}

/** The message box. Mounted once per session (keyed by its id), so the picker and draft are that session's own. */
function Composer({ session, busy }: { session: Session; busy: boolean }) {
  const settings = useStore((s) => s.settings);
  const flows = useStore((s) => s.flows);
  const [text, setTextRaw] = useState(() => stored(DRAFT_KEY + session.id) ?? '');
  const [target, setTargetRaw] = useState<string>(() => stored(TARGET_KEY + session.id) ?? 'chat');
  const [pick, setPick] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const setText = (t: string) => {
    setTextRaw(t);
    setMenuClosed(false);
    setHint(null);
    store(DRAFT_KEY + session.id, t);
  };
  const setTarget = (t: string) => {
    setTargetRaw(t);
    store(TARGET_KEY + session.id, t);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);
  useEffect(() => ref.current?.focus(), []);

  const flowExists = target === 'chat' || target === 'auto' || flows.some((f) => f.id === target);
  const effectiveTarget = flowExists ? target : 'chat';
  const toChat = effectiveTarget === 'chat' || effectiveTarget === 'auto';
  const chatModel = settings?.models.find((m) => m.id === session.chat.modelId);
  const noJevKey = settings !== null && settings.typesafe.apiKey.trim() === '';

  // `/qu` lists the flows whose command starts that way; `/quick-fix add x` says what it will run.
  const typing = /^\/([a-z0-9-]*)$/i.exec(text);
  const matches = typing === null || menuClosed ? [] : flows.filter((f) => flowCommand(f).startsWith(typing[1]!.toLowerCase()));
  const selected = Math.min(pick, Math.max(0, matches.length - 1));
  const command = parseFlowCommand(text, flows);
  // A flow, or a slash command, starts work regardless of the chat; only a chat message waits for the agent.
  const chatBusy = busy && toChat && command === null;

  const send = () => {
    const body = text.trim();
    if (body === '') return;
    if (chatBusy) {
      setHint('The agent is still answering. Press Esc to stop it, or wait and send again.');
      return;
    }
    setText('');
    void api().send(session.id, body, effectiveTarget === 'chat' ? null : effectiveTarget);
  };
  const stop = () => {
    void api().stop(session.id);
    setHint(null);
    ref.current?.focus();
  };
  const complete = (f: Flow) => {
    setText(`/${flowCommand(f)} `);
    ref.current?.focus();
  };

  return (
    <div className="mx-auto w-full max-w-[820px] px-6 pb-5">
      {matches.length > 0 && (
        <ul role="listbox" aria-label="Flows you can run" className="mb-1.5 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[0_2px_12px_rgba(0,0,0,0.18)]">
          {matches.map((f, i) => (
            <li key={f.id} role="option" aria-selected={i === selected}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setPick(i)}
                onClick={() => complete(f)}
                className={cx('flex w-full items-baseline gap-3 px-3.5 py-1.5 text-left', i === selected && 'bg-hover')}
              >
                <code className="shrink-0 font-mono text-[12.5px] text-text">/{flowCommand(f)}</code>
                <span className="truncate text-[12.5px] text-muted">
                  {f.name}. {f.description}
                </span>
              </button>
            </li>
          ))}
          <li className="px-3.5 pt-1 pb-0.5 text-[11px] text-faint">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> to choose, <Kbd>Tab</Kbd> to complete, <Kbd>Esc</Kbd> to close. Then say what the flow should do.
          </li>
        </ul>
      )}
      {command !== null && (
        <div className="mb-1.5 px-1 text-[12px] text-muted">
          Runs {command.flow.name}
          {command.objective === '' ? '. Say what it should do after the command.' : ' with the rest as its objective.'}
        </div>
      )}
      {hint !== null && <div className="mb-1.5 px-1 text-[12px] text-warn">{hint}</div>}
      {hint === null && noJevKey && !toChat && flows.some((f) => f.id === effectiveTarget && usesJev(f)) && (
        <div className="mb-1.5 px-1 text-[12px] text-muted">This flow uses Jev. There is no TypeSafe key yet, so it will ask you for one first.</div>
      )}
      <div className="rounded-2xl border border-line bg-panel shadow-[0_2px_12px_rgba(0,0,0,0.18)] focus-within:border-line-strong">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (matches.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setPick((selected + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === 'Tab') {
                e.preventDefault();
                complete(matches[selected]!);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMenuClosed(true);
                return;
              }
            }
            if (e.key === 'Escape' && busy) {
              e.preventDefault();
              stop();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          aria-label="Message"
          placeholder={
            effectiveTarget === 'chat'
              ? 'Ask or tell the agent something. Type / to run a flow.'
              : effectiveTarget === 'auto'
                ? 'Describe the work; Jev picks a flow or a chat'
                : `What should ${flows.find((f) => f.id === effectiveTarget)?.name ?? 'the flow'} do?`
          }
          className="block max-h-[260px] min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed placeholder:text-faint focus:outline-none focus-visible:outline-none"
        />
        <div className="flex flex-wrap items-center gap-0.5 px-2 pb-2">
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
          {toChat && settings !== null && (
            <>
              <PillSelect
                aria-label="Model"
                title={effectiveTarget === 'auto' ? 'Used when Jev keeps the message as a chat' : undefined}
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
          {!toChat && (
            <button className="no-drag h-7 rounded-md px-2 text-[12.5px] text-muted hover:bg-hover hover:text-text" onClick={() => go({ kind: 'flows', flowId: effectiveTarget })}>
              View flow
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {busy && (
              <button onClick={stop} className="flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] text-muted hover:bg-hover hover:text-text" title="Stop everything in this session (Esc)">
                <Square size={11} fill="currentColor" /> Stop
              </button>
            )}
            <button
              onClick={send}
              disabled={text.trim() === ''}
              aria-label="Send"
              className={cx('flex h-8 w-8 items-center justify-center rounded-full bg-brass text-brass-ink transition-opacity disabled:opacity-30', chatBusy && 'opacity-40')}
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
        {busy && (
          <span>
            <Kbd>Esc</Kbd> stop
          </span>
        )}
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
        aria-label="Session name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (value.trim() !== '' && value !== session.title) void api().renameSession(session.id, value.trim());
          else setValue(session.title);
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
    <button onClick={() => setEditing(true)} className="no-drag group flex min-w-[80px] shrink items-center gap-1.5 text-left" title="Rename">
      <span className="truncate text-[13.5px] font-semibold">{session.title}</span>
      <Pencil size={12} className="shrink-0 text-faint opacity-0 group-hover:opacity-100" />
    </button>
  );
}

/** What stands between this project and a flow, said where you start one, with the fix beside it. */
function ProjectCheck({ project }: { project: Project }) {
  const [health, setHealth] = useState<ProjectHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const check = () => void api().projectHealth(project.id).then(setHealth);
  useEffect(check, [project.id]);
  if (health === null) return null;
  if (!health.exists) {
    return (
      <div className="mx-auto mt-6 flex max-w-[480px] items-start gap-2.5 rounded-lg border border-bad/40 bg-bad/10 px-3.5 py-3 text-left text-[12.5px]">
        <FolderX size={15} className="mt-0.5 shrink-0 text-bad" />
        <span>
          The folder <span className="font-mono">{shortPath(project.path)}</span> is gone. Move it back, or remove {project.name} from the sidebar.
        </span>
      </div>
    );
  }
  const note =
    health.git === 'none'
      ? `${project.name} is not a git repository. Chat works, but flows need git: each run works on its own branch so your files stay as they are until you merge.`
      : health.git === 'no-commits'
        ? `${project.name} has no commits yet, so a flow has nothing to branch from.`
        : health.dirty > 0
          ? `${health.dirty} ${health.dirty === 1 ? 'file has' : 'files have'} changes you have not committed. A flow starts from your last commit, so it will not see ${health.dirty === 1 ? 'it' : 'them'}.`
          : null;
  if (note === null && msg === null) return null;
  return (
    <div className="mx-auto mt-6 max-w-[480px] rounded-lg border border-line bg-panel px-3.5 py-3 text-left text-[12.5px] leading-relaxed">
      {note !== null && (
        <div className="flex items-start gap-2.5">
          <GitBranch size={15} className="mt-0.5 shrink-0 text-warn" />
          <span className="text-muted">{note}</span>
        </div>
      )}
      {health.git !== 'ok' && (
        <Button
          className="mt-2.5 ml-[26px]"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await api().setUpGit(project.id);
            setBusy(false);
            setMsg({ ok: r.ok, text: r.message });
            check();
          }}
        >
          {health.git === 'none' ? 'Start a git repository here' : 'Make the first commit'}
        </Button>
      )}
      {msg !== null && <p className={cx('selectable mt-2 ml-[26px]', msg.ok ? 'text-ok' : 'text-bad')}>{msg.text}</p>}
    </div>
  );
}

export function SessionView({ id }: { id: string }) {
  const session = useStore((s) => s.sessionById[id]);
  const summary = useStore((s) => s.sessions.find((x) => x.id === id));
  const project = useStore((s) => s.projects.find((p) => p.id === session?.projectId));
  const panelRun = useStore((s) => (s.panelRunId === null ? undefined : s.runById[s.panelRunId]));
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the bottom while you are there: a reply streaming, a run card filling in, a new card.
  // Watching the content's size catches all of them, where counting items missed a card growing.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (el === null || inner === null) return;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [id, session === undefined]);

  if (session === undefined) return <div className="flex flex-1 items-center justify-center text-faint">Loading…</div>;
  const busy = summary?.busy ?? false;

  return (
    <LinkBase.Provider value={project?.path}>
      <div className="relative flex min-w-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
            <Title session={session} />
            {project !== undefined && (
              <span className="shrink-0 font-mono text-[11.5px] text-faint" title={project.path}>
                {shortPath(project.path)}
              </span>
            )}
            <div className="no-drag ml-auto flex items-center">
              <IconButton
                label="Delete this session"
                onClick={() => {
                  if (!window.confirm('Delete this session? Its runs are stopped and their record removed. Branches stay in git.')) return;
                  // Land on the next session in the same project, not on the home screen.
                  const next = getState().sessions.find((x) => x.id !== session.id && x.projectId === session.projectId) ?? getState().sessions.find((x) => x.id !== session.id);
                  void api().deleteSession(session.id);
                  setState({ panelRunId: null });
                  if (next !== undefined) void openSession(next.id);
                  else go({ kind: 'home' });
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
            <div ref={content} className="mx-auto max-w-[820px] space-y-5 px-6 py-6">
              {session.items.length === 0 && (
                <div className="pt-[12vh] text-center">
                  <h2 className="text-[20px] font-semibold tracking-tight">What should we work on{project !== undefined ? ` in ${project.name}` : ''}?</h2>
                  <p className="mx-auto mt-2 max-w-[460px] text-[13px] leading-relaxed text-muted">
                    Chat with one agent in this folder, or open the menu under the box (it says Chat) to run a flow: a team of agents that works on its own branch until you merge. Type{' '}
                    <Kbd>/</Kbd> to list the flows.
                  </p>
                  {project !== undefined && <ProjectCheck project={project} />}
                </div>
              )}
              {session.items.map((item) => (
                <Item key={item.id} item={item} sessionId={session.id} />
              ))}
            </div>
          </div>
          <Composer key={session.id} session={session} busy={busy} />
        </main>
        {panelRun !== undefined && panelRun.sessionId === session.id && <RunPanel run={panelRun} />}
      </div>
    </LinkBase.Provider>
  );
}
