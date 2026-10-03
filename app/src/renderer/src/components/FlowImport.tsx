/**
 * Import a flow someone sent you, from a file or pasted text. Nothing is saved until you have seen
 * what the flow can do on this Mac: the commands it runs, the files its engineers edit, whether it
 * merges into your checkout.
 */

import { ChevronLeft, CircleAlert, FileUp, Info, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import { flowPowers } from '../../../shared/share.ts';
import type { Flow } from '../../../shared/types.ts';
import { api, go, useStore } from '../lib/state.ts';
import { Preview } from './FlowDrafter.tsx';
import { Button, cx, TextArea } from './ui.tsx';

export function FlowImport() {
  const flows = useStore((s) => s.flows);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [read, setRead] = useState<{ flow: Flow; notes: string[] } | null>(null);
  const [saving, setSaving] = useState(false);

  const check = async (body: string) => {
    setError('');
    const res = await api().readFlow(body);
    if (res.ok) setRead({ flow: res.flow, notes: res.notes });
    else setError(res.message);
  };

  const pick = async () => {
    const res = await api().pickFlowFile();
    if (res === null) return;
    if ('error' in res) setError(res.error);
    else await check(res.text);
  };

  const add = async () => {
    if (read === null) return;
    setSaving(true);
    const saved = await api().saveFlow(read.flow);
    go({ kind: 'flows', flowId: saved.id });
  };

  const powers = read === null ? [] : flowPowers(read.flow, new Set(flows.map((f) => f.id)));

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <button className="no-drag flex items-center gap-1 text-[13px] text-muted hover:text-text" onClick={() => go({ kind: 'flows', flowId: null })}>
          <ChevronLeft size={15} /> Flows
        </button>
        <span className="text-faint">/</span>
        <span className="text-[13.5px] font-semibold">Import a flow</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {read === null ? (
          <div className="mx-auto max-w-[640px] px-6 pt-10 pb-16">
            <h1 className="text-[20px] font-semibold tracking-tight">Import a flow</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Open a flow file someone sent you, or paste its text. You see what it does on this Mac before anything is saved.
            </p>
            <Button tone="primary" className="mt-5" onClick={() => void pick()}>
              <FileUp size={14} /> Choose a file
            </Button>
            <div className="mt-6 text-[12px] font-medium text-muted">Or paste it</div>
            <TextArea
              aria-label="Flow text"
              rows={8}
              className="mt-1.5 font-mono text-[11.5px]"
              placeholder='{ "format": "agentic-army-flow", ... }'
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <Button className="mt-2" disabled={text.trim() === ''} onClick={() => void check(text)}>
              Read it
            </Button>
            {error !== '' && (
              <p role="alert" className="mt-4 flex items-start gap-2 text-[13px] text-bad">
                <CircleAlert size={15} className="mt-0.5 shrink-0" /> {error}
              </p>
            )}
          </div>
        ) : (
          <div className="mx-auto flex max-w-[1240px] flex-col gap-8 px-6 pt-10 pb-16 min-[1180px]:flex-row min-[1180px]:items-start">
            <main className="min-w-0 flex-1">
              <h1 className="text-[22px] font-semibold tracking-tight">{read.flow.name}</h1>
              {read.flow.description !== '' && <p className="mt-1.5 max-w-[720px] text-[13px] leading-relaxed text-muted">{read.flow.description}</p>}
              <div className="mt-5">
                <Preview flow={read.flow} />
              </div>
              <div className="mt-5 flex items-center gap-2">
                <Button tone="primary" disabled={saving} onClick={() => void add()}>
                  Add to my flows
                </Button>
                <Button tone="quiet" onClick={() => setRead(null)}>
                  Cancel
                </Button>
              </div>
            </main>
            <aside className="w-full shrink-0 min-[1180px]:w-[360px]">
              <h2 className="text-[13px] font-semibold">What it can do on this Mac</h2>
              {powers.length === 0 ? (
                <p className="mt-2 text-[12.5px] leading-relaxed text-muted">No commands, no file edits and no merges. Its agents read and answer.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {powers.map((p, i) => (
                    <li key={i} className={cx('rounded-md border px-2.5 py-2 text-[12.5px] leading-snug', p.level === 'high' ? 'border-warn/40 bg-warn/5' : 'border-line')}>
                      <div className="flex items-start gap-2">
                        {p.level === 'high' ? <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warn" /> : <Info size={14} className="mt-0.5 shrink-0 text-faint" />}
                        <div className="min-w-0">
                          <span className="font-medium text-text">{p.node}</span> <span className="text-muted">{p.text}</span>
                          {p.code !== undefined && <code className="selectable mt-1 block truncate rounded bg-raised px-1.5 py-0.5 font-mono text-[11.5px] text-text" title={p.code}>{p.code}</code>}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {read.notes.length > 0 && (
                <>
                  <h2 className="mt-6 text-[13px] font-semibold">Changed on the way in</h2>
                  <ul className="mt-2 space-y-1.5">
                    {read.notes.map((n, i) => (
                      <li key={i} className="text-[12.5px] leading-snug text-muted">
                        {n}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
