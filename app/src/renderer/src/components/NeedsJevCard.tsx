import { KeyRound } from 'lucide-react';
import { useState } from 'react';

import type { SessionItem } from '../../../shared/types.ts';
import { api } from '../lib/state.ts';
import { Button, Input } from './ui.tsx';

type NeedsJev = Extract<SessionItem, { kind: 'needs-jev' }>;

const KEY_URL = 'https://typesafe.ai';

/**
 * A flow that asks Jev was about to start, and there is no TypeSafe key. Paste one here: the app
 * checks it with one small question, saves it, and starts the flow, so you never leave the thread.
 */
export function NeedsJevCard({ sessionId, item }: { sessionId: string; item: NeedsJev }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (item.status !== 'pending') {
    return (
      <div className="flex items-center justify-center gap-1.5 text-[12px] text-faint">
        <KeyRound size={12} />
        {item.status === 'started' ? `Jev is connected. ${item.flowName} started.` : `${item.flowName} did not start: no TypeSafe key.`}
      </div>
    );
  }

  const connect = async () => {
    setBusy(true);
    setError(null);
    const res = await api().connectJev(sessionId, item.id, key);
    setBusy(false);
    if (!res.ok) setError(res.message);
  };
  const who = item.starter.kind === 'agent' ? `${item.starter.model} asked for this flow.` : item.starter.kind === 'jev' ? 'Jev in Auto picked this flow.' : null;

  return (
    <article className="rounded-xl border border-brass/45 bg-brass-soft p-4" aria-label={`${item.flowName} needs a TypeSafe key`}>
      <div className="flex items-center gap-2 text-[13.5px] font-semibold">
        <KeyRound size={15} className="text-brass" />
        {item.flowName} needs Jev
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
        {item.refused === undefined
          ? `Jev makes the calls in ${item.steps.map((s) => `"${s}"`).join(', ')}, and it needs a TypeSafe API key. Paste yours and the flow starts right away.`
          : `Jev makes the calls in ${item.steps.map((s) => `"${s}"`).join(', ')}, and TypeSafe refused the saved key. Paste a working one and the flow starts right away.`}{' '}
        The key stays on this machine; change it later in Settings.
        {who !== null && <span className="text-faint"> {who}</span>}
      </p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          aria-label="TypeSafe API key"
          placeholder="Paste a TypeSafe API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="flex-1"
        />
        <Button tone="primary" type="submit" disabled={busy || key.trim() === ''}>
          {busy ? 'Checking…' : 'Connect and start'}
        </Button>
        <Button tone="quiet" type="button" disabled={busy} onClick={() => void api().connectJev(sessionId, item.id, null)}>
          Not now
        </Button>
      </form>
      {error !== null && <p className="selectable mt-2 text-[12px] text-bad">{error}</p>}
      <p className="mt-2 text-[11.5px] text-faint">
        No key yet?{' '}
        <a href={KEY_URL} target="_blank" rel="noreferrer" className="text-muted underline decoration-line-strong underline-offset-2 hover:text-text">
          Get one from TypeSafe
        </a>
        .
      </p>
    </article>
  );
}
