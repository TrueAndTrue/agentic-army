import { Workflow } from 'lucide-react';
import { useState } from 'react';

import type { SessionItem } from '../../../shared/types.ts';
import { api } from '../lib/state.ts';
import { Button, Dot, TextArea } from './ui.tsx';

type FlowRequest = Extract<SessionItem, { kind: 'flow-request' }>;

/** A chat agent asks to start a flow. You approve it as asked, edit the objective first, or decline. */
export function FlowRequestCard({ sessionId, item }: { sessionId: string; item: FlowRequest }) {
  const [objective, setObjective] = useState(item.objective);
  const [busy, setBusy] = useState(false);
  const answer = async (approve: boolean) => {
    setBusy(true);
    await api().answerFlowRequest(sessionId, item.id, approve, objective === item.objective ? '' : objective);
  };

  if (item.status !== 'pending') {
    return (
      <div className="flex items-center justify-center gap-1.5 text-[12px] text-faint">
        <Workflow size={12} />
        {item.model} asked to run {item.flowName}. {item.status === 'started' ? 'You approved it.' : 'You declined.'}
      </div>
    );
  }
  return (
    <article className="rounded-xl border border-warn/50 bg-warn/[0.07] p-3.5" aria-label={`${item.model} asks to run ${item.flowName}`}>
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <Dot color="var(--warn)" pulse />
        {item.model} wants to run {item.flowName}
      </div>
      {item.why !== '' && <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{item.why}</p>}
      <label className="mt-2.5 block text-[12px] font-medium text-muted" htmlFor={`objective-${item.id}`}>
        Objective the flow starts from
      </label>
      <TextArea id={`objective-${item.id}`} className="mt-1 font-sans text-[12.5px]" rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} />
      <div className="mt-2 flex gap-2">
        <Button tone="primary" disabled={busy || objective.trim() === ''} onClick={() => void answer(true)}>
          {objective === item.objective ? 'Start it' : 'Start with my edit'}
        </Button>
        <Button disabled={busy} onClick={() => void answer(false)}>
          Decline
        </Button>
      </div>
    </article>
  );
}
