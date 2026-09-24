import { FolderPlus } from 'lucide-react';

import { api, newSession, useStore } from '../lib/state.ts';
import { Button } from './ui.tsx';

export function Home() {
  const projects = useStore((s) => s.projects);
  return (
    <div className="flex flex-1 flex-col">
      <div className="drag h-12 shrink-0" />
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="max-w-[460px]">
          <h1 className="text-[24px] font-semibold tracking-tight">Agentic Army</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
            Sessions with claude and codex in your projects, and flows that put a team of them to work: scouts, planners, engineers and reviewers, with Jev making the fast calls between them.
          </p>
          {projects.length === 0 ? (
            <Button
              tone="primary"
              className="mt-6"
              onClick={async () => {
                const p = await api().addProject();
                if (p !== null) await newSession(p.id);
              }}
            >
              <FolderPlus size={15} /> Add a project folder
            </Button>
          ) : (
            <div className="mt-6">
              <div className="mb-2 text-[12px] text-faint">Start a session in</div>
              <div className="flex flex-wrap gap-2">
                {projects.map((p) => (
                  <Button key={p.id} onClick={() => void newSession(p.id)} title={p.path}>
                    {p.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
