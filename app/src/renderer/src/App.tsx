import { MessagesSquare, Settings as Cog, X } from 'lucide-react';
import { useEffect } from 'react';

import { FlowDrafter } from './components/FlowDrafter.tsx';
import { FlowEditor } from './components/FlowEditor.tsx';
import { FlowImport } from './components/FlowImport.tsx';
import { Home } from './components/Home.tsx';
import { SessionView } from './components/SessionView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { getState, go, newSession, openSession, setState, useStore } from './lib/state.ts';

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
        <div className="flex h-full w-[84px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="drag h-12" />
          <BackButton />
          <button
            onClick={() => go({ kind: 'settings' })}
            className="mx-auto mt-auto mb-3 flex flex-col items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-muted hover:bg-hover hover:text-text"
            title="Settings"
          >
            <Cog size={16} />
            Settings
          </button>
        </div>
      )}
      {view.kind === 'home' && <Home />}
      {view.kind === 'session' && <SessionView id={view.id} />}
      {view.kind === 'flows' && (view.draft === true ? <FlowDrafter /> : view.import === true ? <FlowImport /> : <FlowEditor flowId={view.flowId} />)}
      {view.kind === 'settings' && <SettingsView />}
      <Toast />
    </div>
  );
}

/** Errors with nowhere else to go, like a folder that could not be added. */
function Toast() {
  const toast = useStore((s) => s.toast);
  if (toast === null) return null;
  return (
    <div role="status" className="fixed bottom-5 left-1/2 z-50 flex max-w-[520px] -translate-x-1/2 items-start gap-2 rounded-lg border border-line-strong bg-raised px-3.5 py-2.5 text-[12.5px] shadow-[0_8px_24px_rgba(0,0,0,0.3)]">
      <span className={toast.tone === 'error' ? 'selectable text-bad' : 'selectable text-text'}>{toast.text}</span>
      <button aria-label="Dismiss" className="shrink-0 text-faint hover:text-text" onClick={() => setState({ toast: null })}>
        <X size={14} />
      </button>
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
