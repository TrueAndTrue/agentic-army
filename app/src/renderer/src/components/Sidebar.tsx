import { ChevronRight, FolderPlus, FolderX, Plus, Settings as Cog, Workflow, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { ago } from '../lib/format.ts';
import { addProjectFlow, api, getState, go, newSession, openSession, setState, useStore } from '../lib/state.ts';
import { cx, Dot, IconButton } from './ui.tsx';

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const view = useStore((s) => s.view);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const addProject = () => void addProjectFlow();
  // Two folders with the same name: show the folder each sits in, so they can be told apart.
  const names = new Map<string, number>();
  for (const p of projects) names.set(p.name, (names.get(p.name) ?? 0) + 1);
  const parentOf = (path: string) => path.split('/').slice(-2, -1)[0] ?? '';

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="drag flex h-12 shrink-0 items-center justify-end gap-1 px-3 pl-20">
        <IconButton label="Add a project" onClick={() => void addProject()}>
          <FolderPlus size={16} />
        </IconButton>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Projects and sessions">
        {projects.length === 0 && (
          <div className="px-2 pt-6 text-[12.5px] leading-relaxed text-faint">
            No projects yet. Add a folder to start a session in it.
          </div>
        )}
        {projects.map((p) => {
          // Newest first by when the session was made, not by its last message. Sorting by activity
          // moved the open session to the top each time you sent, so the row under the cursor
          // changed while you were using the list. A row now moves only when a new session lands above it.
          const mine = sessions.filter((s) => s.projectId === p.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
          const open = collapsed[p.id] !== true;
          return (
            <section key={p.id} className="mb-2">
              <div className="group flex h-8 items-center gap-1 rounded-md pr-1 pl-1 hover:bg-hover">
                <button
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  onClick={() => setCollapsed((c) => ({ ...c, [p.id]: open }))}
                  title={p.path}
                >
                  <ChevronRight size={14} className={cx('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
                  <span className={cx('truncate text-[13px] font-semibold', p.missing === true && 'text-faint line-through')}>{p.name}</span>
                  {(names.get(p.name) ?? 0) > 1 && <span className="truncate text-[11.5px] text-faint">in {parentOf(p.path)}</span>}
                  {p.missing === true && (
                    <span title={`${p.path} is gone`} className="shrink-0">
                      <FolderX size={13} className="text-bad" />
                    </span>
                  )}
                </button>
                <IconButton
                  label={`Remove ${p.name} and its sessions`}
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => {
                    if (window.confirm(`Remove ${p.name} from the app? Its sessions are deleted. The folder is not touched.`)) void api().removeProject(p.id);
                  }}
                >
                  <Trash2 size={13} />
                </IconButton>
                <IconButton label={`New session in ${p.name}`} disabled={p.missing === true} onClick={() => void newSession(p.id)}>
                  <Plus size={15} />
                </IconButton>
              </div>
              {open && (
                <ul className="mt-0.5 space-y-px">
                  {mine.length === 0 && <li className="py-1 pl-7 text-[12px] text-faint">No sessions</li>}
                  {mine.map((s) => {
                    const active = view.kind === 'session' && view.id === s.id;
                    return (
                      <li key={s.id} className="group/row relative">
                        <button
                          onClick={() => void openSession(s.id)}
                          aria-current={active ? 'page' : undefined}
                          className={cx(
                            'flex h-8 w-full items-center gap-2 rounded-md pr-2 pl-7 text-left text-[13px]',
                            active ? 'bg-hover font-medium text-text' : 'text-muted hover:bg-hover/60 hover:text-text',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                          {s.waiting ? (
                            <Dot color="var(--warn)" pulse />
                          ) : s.busy ? (
                            <Dot color="var(--run)" pulse />
                          ) : (
                            <span className="shrink-0 text-[11px] text-faint group-hover/row:invisible">{ago(s.updatedAt)}</span>
                          )}
                        </button>
                        {!s.busy && !s.waiting && (
                          <IconButton
                            label={`Delete ${s.title}`}
                            className="absolute top-0.5 right-1 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                            onClick={() => {
                              if (!window.confirm(`Delete "${s.title}"? Its runs' record goes with it. Branches stay in git.`)) return;
                              void api().deleteSession(s.id);
                              if (active) {
                                const next = getState().sessions.find((x) => x.id !== s.id && x.projectId === s.projectId) ?? getState().sessions.find((x) => x.id !== s.id);
                                setState({ panelRunId: null });
                                if (next !== undefined) void openSession(next.id);
                                else go({ kind: 'home' });
                              }
                            }}
                          >
                            <X size={13} />
                          </IconButton>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </nav>

      <div className="shrink-0 space-y-px border-t border-line p-2">
        <button
          onClick={() => go({ kind: 'flows', flowId: null })}
          className={cx('flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px]', view.kind === 'flows' ? 'bg-hover text-text' : 'text-muted hover:bg-hover hover:text-text')}
        >
          <Workflow size={15} /> Flows
        </button>
        <button
          onClick={() => go({ kind: 'settings' })}
          className={cx('flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px]', view.kind === 'settings' ? 'bg-hover text-text' : 'text-muted hover:bg-hover hover:text-text')}
        >
          <Cog size={15} /> Settings
        </button>
      </div>
    </aside>
  );
}
