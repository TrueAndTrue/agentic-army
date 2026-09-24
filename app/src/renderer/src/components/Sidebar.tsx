import { ChevronRight, FolderPlus, Plus, Settings as Cog, Workflow, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { ago } from '../lib/format.ts';
import { api, go, newSession, openSession, useStore } from '../lib/state.ts';
import { cx, Dot, IconButton } from './ui.tsx';

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const view = useStore((s) => s.view);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const addProject = async () => {
    const p = await api().addProject();
    if (p !== null) await newSession(p.id);
  };

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
          const mine = sessions.filter((s) => s.projectId === p.id);
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
                  <span className="truncate text-[13px] font-semibold">{p.name}</span>
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
                <IconButton label={`New session in ${p.name}`} onClick={() => void newSession(p.id)}>
                  <Plus size={15} />
                </IconButton>
              </div>
              {open && (
                <ul className="mt-0.5 space-y-px">
                  {mine.length === 0 && <li className="py-1 pl-7 text-[12px] text-faint">No sessions</li>}
                  {mine.map((s) => {
                    const active = view.kind === 'session' && view.id === s.id;
                    return (
                      <li key={s.id}>
                        <button
                          onClick={() => void openSession(s.id)}
                          className={cx(
                            'flex h-8 w-full items-center gap-2 rounded-md pr-2 pl-7 text-left text-[13px]',
                            active ? 'bg-hover text-text' : 'text-muted hover:bg-hover hover:text-text',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                          {s.waiting ? (
                            <Dot color="var(--warn)" pulse />
                          ) : s.busy ? (
                            <Dot color="var(--run)" pulse />
                          ) : (
                            <span className="shrink-0 text-[11px] text-faint">{ago(s.updatedAt)}</span>
                          )}
                        </button>
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
