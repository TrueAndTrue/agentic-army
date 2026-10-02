import { ClipboardCopy, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { api, toast } from '../lib/state.ts';
import { Button } from './ui.tsx';

/** Settings, under Diagnostics: copy the support report, or open the folder the log is in. */
export function Diagnostics() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            // The report runs the machine check and tries Jev, so it takes a second or two.
            await api().copyDiagnostics();
            toast('Copied the diagnostics. Paste them into a message to whoever is helping you.', 'info');
          } catch (err) {
            toast(`Could not make the diagnostics: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ClipboardCopy size={14} /> {busy ? 'Checking this Mac…' : 'Copy diagnostics'}
      </Button>
      <Button tone="quiet" onClick={() => void api().openLogs()}>
        <FolderOpen size={14} /> Open logs folder
      </Button>
    </div>
  );
}
