import { ArrowDownToLine, RefreshCw, X } from 'lucide-react';

import type { UpdateStatus } from '../../../shared/types.ts';
import { api, setState, useStore } from '../lib/state.ts';
import { Button, IconButton } from './ui.tsx';

function line(u: UpdateStatus): string {
  switch (u.state) {
    case 'off':
      return u.reason;
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking for updates…';
    case 'current':
      return `Up to date. Checked at ${new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    case 'downloading':
      return `Downloading version ${u.next}, ${String(u.percent)}%.`;
    case 'ready':
      return `Version ${u.next} is downloaded. Restart to update.`;
    case 'manual':
      return `Version ${u.next} is out. ${u.reason}`;
    case 'error':
      return u.reason;
  }
}

/** The body of the Updates section in Settings: this version, where the updater stands, and what you can do. */
export function UpdatesPanel() {
  const u = useStore((s) => s.update);
  if (u === null) return null;
  const busy = u.state === 'checking' || u.state === 'downloading';
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[150px_1fr] items-baseline gap-2 text-[13px]">
        <span className="font-medium">Version</span>
        <span className="selectable font-mono text-[12px]">{u.version}</span>
        <span className="font-medium">Status</span>
        <span role="status" aria-label="Update status" className={`selectable text-[12.5px] ${u.state === 'error' ? 'text-bad' : u.state === 'ready' ? 'text-ok' : 'text-muted'}`}>
          {line(u)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {u.state === 'ready' ? (
          <Button key="install" tone="primary" onClick={() => void api().installUpdate()}>
            Restart to update
          </Button>
        ) : (
          <Button key="check" disabled={u.state === 'off' || busy} onClick={() => void api().checkForUpdates()}>
            <RefreshCw size={13} className={busy ? 'animate-spin' : undefined} /> Check for updates
          </Button>
        )}
        {u.state === 'manual' && (
          <Button tone="quiet" onClick={() => void api().openLink(u.url)}>
            <ArrowDownToLine size={13} /> Open the download page
          </Button>
        )}
      </div>
    </div>
  );
}

/** A quiet line above Flows and Settings once an update is downloaded. Closing it hides it for that version. */
export function UpdateNotice() {
  const u = useStore((s) => s.update);
  const dismissed = useStore((s) => s.updateDismissed);
  if (u?.state !== 'ready' || dismissed === u.next) return null;
  return (
    <div role="status" className="mb-1 flex items-center gap-1 rounded-md bg-brass-soft py-1 pr-1 pl-2 text-[12.5px]">
      <span className="min-w-0 flex-1 truncate">Version {u.next} is ready</span>
      <Button tone="quiet" className="h-6 px-2 text-[12px] text-text" onClick={() => void api().installUpdate()}>
        Restart
      </Button>
      <IconButton label="Hide until the next version" className="h-6 w-6" onClick={() => setState({ updateDismissed: u.next })}>
        <X size={13} />
      </IconButton>
    </div>
  );
}
