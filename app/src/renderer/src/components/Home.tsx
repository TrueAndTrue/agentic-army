import { CheckCircle2, CircleAlert, FolderPlus, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DoctorReport } from '../../../shared/types.ts';
import { addProjectFlow, api, checkMachine, go, newSession, useStore } from '../lib/state.ts';
import { shortPath } from './SessionView.tsx';
import { Button, Input } from './ui.tsx';

type Check = DoctorReport[keyof DoctorReport] | undefined;

function Row({ label, what, r, children }: { label: string; what: string; r: Check; children?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 shrink-0">
        {r === undefined ? <LoaderCircle size={15} className="animate-spin text-faint" /> : r.ok ? <CheckCircle2 size={15} className="text-ok" /> : <CircleAlert size={15} className="text-warn" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium">{label}</span>
          <span className="text-[12px] text-faint">{what}</span>
        </div>
        {r !== undefined && <div className="selectable mt-0.5 text-[12px] text-muted">{r.ok ? r.detail : r.detail.replace(/ (Jev needs one; add it in Settings under Jev|Paste a working key in Settings under Jev)\.$/, '')}</div>}
        {children}
      </div>
    </li>
  );
}

/** Paste a TypeSafe key right here; it is checked with one small question before it is kept. */
function JevKey() {
  const settings = useStore((s) => s.settings);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings === null) return null;
  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const before = settings.typesafe.apiKey;
        await api().saveSettings({ ...settings, typesafe: { ...settings.typesafe, apiKey: key.trim() } });
        const r = await api().testJev();
        if (!r.ok) {
          await api().saveSettings({ ...settings, typesafe: { ...settings.typesafe, apiKey: before } });
          setError(r.detail.replace(/ Paste a working key in Settings under Jev\.$/, ''));
        }
        await checkMachine(true);
        setBusy(false);
      }}
    >
      <Input type="password" autoComplete="off" aria-label="TypeSafe API key" placeholder="Paste a TypeSafe API key" value={key} onChange={(e) => setKey(e.target.value)} className="max-w-[300px]" />
      <Button tone="primary" type="submit" disabled={busy || key.trim() === ''}>
        {busy ? 'Checking…' : 'Connect'}
      </Button>
      {error !== null && <p className="selectable basis-full text-[12px] text-bad">{error}</p>}
    </form>
  );
}

export function Home() {
  const projects = useStore((s) => s.projects);
  const doctor = useStore((s) => s.doctor);
  const [rechecking, setRechecking] = useState(false);
  useEffect(() => {
    void checkMachine();
  }, []);
  const ready = doctor !== null && doctor.claude.ok && doctor.git.ok && doctor.typesafe.ok;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="drag h-12 shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[560px] px-8 pt-[8vh] pb-16">
          <h1 className="text-[26px] font-semibold tracking-tight">Agentic Army</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
            Chat with claude and codex in your projects, or run a flow: a team of them, a scout, a planner, an engineer and a reviewer, with Jev making the quick calls between steps. Each run works on its own git branch until you merge it.
          </p>

          <section className="mt-8">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-semibold">{ready ? 'This Mac is ready' : 'Before you start'}</h2>
              <button
                className="no-drag ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-faint hover:bg-hover hover:text-text"
                onClick={async () => {
                  setRechecking(true);
                  await checkMachine(true);
                  setRechecking(false);
                }}
              >
                <RefreshCw size={12} className={rechecking ? 'animate-spin' : undefined} /> Check again
              </button>
            </div>
            <ul className="mt-1 divide-y divide-line rounded-lg border border-line bg-panel px-3.5">
              <Row label="claude" what="runs chats and most flow steps" r={doctor?.claude}>
                {doctor !== null && !doctor.claude.ok && <p className="mt-1 text-[12px] text-faint">Install Claude Code and log in, or set its path in Settings.</p>}
              </Row>
              <Row label="codex" what="optional: GPT models, and the reviewer in Build and review" r={doctor?.codex}>
                {doctor !== null && !doctor.codex.ok && <p className="mt-1 text-[12px] text-faint">Install the Codex CLI and log in to use GPT models. Everything else works without it.</p>}
              </Row>
              <Row label="git" what="each run works on its own branch" r={doctor?.git} />
              <Row label="Jev" what="makes the decisions inside flows, reads web searches, and picks a flow in Auto" r={doctor?.typesafe}>
                {doctor !== null && !doctor.typesafe.ok && (
                  <>
                    <p className="mt-1 text-[12px] text-faint">
                      Every built-in flow asks Jev at some step, and agents search the web through it. Chat works without it.{' '}
                      <a className="text-muted underline decoration-line-strong underline-offset-2 hover:text-text" href="https://typesafe.ai" target="_blank" rel="noreferrer">
                        Get a key from TypeSafe
                      </a>
                      .
                    </p>
                    <JevKey />
                  </>
                )}
              </Row>
            </ul>
          </section>

          <section className="mt-8">
            <h2 className="text-[13px] font-semibold">{projects.length === 0 ? 'Add a project' : 'Start a session'}</h2>
            {projects.length === 0 ? (
              <>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">A project is a folder on this Mac, usually a git repository. Agents work inside it.</p>
                <Button tone="primary" className="mt-3" onClick={() => void addProjectFlow()}>
                  <FolderPlus size={15} /> Add a project folder
                </Button>
              </>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {projects.map((p) => (
                  <Button key={p.id} disabled={p.missing === true} onClick={() => void newSession(p.id)} title={p.missing === true ? `${p.path} is gone` : p.path}>
                    {p.name}
                    <span className="font-mono text-[11px] font-normal text-faint">{shortPath(p.path)}</span>
                  </Button>
                ))}
                <Button tone="quiet" onClick={() => void addProjectFlow()}>
                  <FolderPlus size={14} /> Add another
                </Button>
              </div>
            )}
          </section>

          <p className="mt-10 text-[12px] text-faint">
            <button className="underline decoration-line-strong underline-offset-2 hover:text-muted" onClick={() => go({ kind: 'flows', flowId: null })}>
              See the flows
            </button>{' '}
            to learn what each one does, or build your own. <kbd className="font-mono">⌘N</kbd> starts a new session.
          </p>
        </div>
      </div>
    </div>
  );
}
