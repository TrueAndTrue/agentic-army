import { MessagesSquare } from 'lucide-react';
import { useEffect } from 'react';

import { FlowEditor } from './components/FlowEditor.tsx';
import { Home } from './components/Home.tsx';
import { SessionView } from './components/SessionView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { getState, go, newSession, openSession, useStore } from './lib/state.ts';

export function App() {
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        const s = getState();
        const current = s.view.kind === 'session' ? s.sessionById[s.view.id]?.projectId : undefined;
        const pid = current ?? s.projects[0]?.id;
        if (pid !== undefined) void newSession(pid);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ready) return <div className="drag h-full" />;
  return (
    <div className="flex h-full">
      {view.kind !== 'flows' && <Sidebar />}
      {view.kind === 'flows' && (
        <div className="flex h-full w-[64px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="drag h-12" />
          <BackButton />
        </div>
      )}
      {view.kind === 'home' && <Home />}
      {view.kind === 'session' && <SessionView id={view.id} />}
      {view.kind === 'flows' && <FlowEditor flowId={view.flowId} />}
      {view.kind === 'settings' && <SettingsView />}
    </div>
  );
}

function BackButton() {
  return (
    <button
      onClick={() => {
        const last = getState().sessions[0];
        if (last === undefined) go({ kind: 'home' });
        else void openSession(last.id);
      }}
      className="mx-auto mt-2 flex flex-col items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-muted hover:bg-hover hover:text-text"
      title="Back to sessions"
    >
      <MessagesSquare size={16} />
      Sessions
    </button>
  );
}
