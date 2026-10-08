/**
 * Draft with AI: you say what the flow should do, the AI asks one multiple-choice question at a
 * time, and then it drafts the flow for you to look over and open in the editor. Every request
 * carries the whole conversation, so going back to an earlier answer is just a shorter list.
 */

import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { ArrowRight, ChevronLeft, CircleAlert, PencilLine, RotateCcw, Sparkles, Square, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { MAX_DRAFT_QUESTIONS, YOU_PICK, type DraftAnswer, type DraftQuestion, type DraftReply } from '../../../shared/draft.ts';
import type { Flow } from '../../../shared/types.ts';
import { api, go, setState, useStore } from '../lib/state.ts';
import { nodeTypes, toRfEdges, toRfNodes } from './FlowCanvas.tsx';
import { Button, cx, Kbd } from './ui.tsx';

const EXAMPLES = [
  'Fix a bug: write a failing test, fix it, run the tests, and have another model review the change',
  'Research a question on the web and write a short summary with links',
  'Triage a failing CI command: find the cause, propose a fix, and ask me before changing anything',
  'Add a small feature from a plan I approve, then commit it on its own branch',
];

/** An answered question, kept whole so going back can show it again exactly as it was asked. */
interface Answered extends DraftAnswer {
  asked: DraftQuestion;
  /** The choice as you made it, to put back when you return to this question. */
  picked: number[];
  other: string;
}

type Screen =
  | { kind: 'objective' }
  | { kind: 'question'; q: DraftQuestion; picked: number[]; other: string }
  | { kind: 'waiting'; drafting: boolean }
  | { kind: 'flow'; reply: Extract<DraftReply, { kind: 'flow' }> }
  | { kind: 'error'; message: string; finish: boolean };

export function FlowDrafter() {
  const [objective, setObjective] = useState('');
  const [answers, setAnswers] = useState<Answered[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: 'objective' });
  /** The screen to go back to when you stop a request. */
  const before = useRef<Screen>({ kind: 'objective' });
  /** Bumped on every request and every stop, so an answer nobody is waiting for is dropped. */
  const ticket = useRef(0);

  const understanding = screen.kind === 'question' ? screen.q.understanding : (answers.at(-1)?.asked.understanding ?? '');

  const ask = async (list: Answered[], finish: boolean) => {
    const mine = ++ticket.current;
    if (screen.kind === 'objective' || screen.kind === 'question') before.current = screen;
    setAnswers(list);
    setScreen({ kind: 'waiting', drafting: finish || list.length >= MAX_DRAFT_QUESTIONS });
    let reply: DraftReply;
    try {
      reply = await api().draftFlow({ objective: objective.trim(), answers: list.map(({ question, answer }) => ({ question, answer })), ...(finish ? { finish } : {}) });
    } catch (err) {
      reply = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    if (mine !== ticket.current) return;
    if (reply.kind === 'question') setScreen({ kind: 'question', q: reply, picked: [], other: '' });
    else if (reply.kind === 'flow') setScreen({ kind: 'flow', reply });
    else setScreen({ kind: 'error', message: reply.message, finish });
  };

  const stop = () => {
    ticket.current += 1;
    void api().stopDraft();
    setScreen(before.current);
  };

  /** Back to an answered question: the answers after it go, and it is asked again. */
  const revisit = (i: number) => {
    const a = answers[i];
    if (a === undefined) return;
    ticket.current += 1;
    void api().stopDraft();
    setAnswers(answers.slice(0, i));
    setScreen({ kind: 'question', q: a.asked, picked: a.picked, other: a.other });
  };

  const startOver = () => {
    ticket.current += 1;
    void api().stopDraft();
    setAnswers([]);
    setScreen({ kind: 'objective' });
  };

  // On the result the summary says what the AI understood, so the side keeps only your answers.
  const shownUnderstanding = screen.kind === 'flow' ? '' : understanding;
  const showSide = screen.kind !== 'objective' && (answers.length > 0 || shownUnderstanding !== '');

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <button className="no-drag flex items-center gap-1 text-[13px] text-muted hover:text-text" onClick={() => go({ kind: 'flows', flowId: null })}>
          <ChevronLeft size={15} /> Flows
        </button>
        <span className="text-faint">/</span>
        <span className="text-[13.5px] font-semibold">Draft with AI</span>
        {screen.kind !== 'objective' && screen.kind !== 'flow' && (
          <Button tone="quiet" className="ml-auto" onClick={startOver}>
            <RotateCcw size={13} /> Start over
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cx('mx-auto flex flex-col gap-8 px-6 pt-10 pb-16 min-[1180px]:flex-row-reverse min-[1180px]:items-start', screen.kind === 'flow' ? 'max-w-[1240px]' : 'max-w-[1080px]')}>
          {showSide && <Side understanding={shownUnderstanding} answers={answers} onRevisit={revisit} />}
          <main className="min-w-0 flex-1">
            {screen.kind === 'objective' && <Objective value={objective} onChange={setObjective} onSubmit={() => void ask([], false)} />}
            {screen.kind === 'question' && (
              <Question
                key={`${String(answers.length)}:${screen.q.question}`}
                n={answers.length + 1}
                screen={screen}
                onAnswer={(answer, picked, other) => void ask([...answers, { question: screen.q.question, answer, asked: screen.q, picked, other }], false)}
                onFinish={() => void ask(answers, true)}
              />
            )}
            {screen.kind === 'waiting' && <Waiting drafting={screen.drafting} n={answers.length + 1} onStop={stop} />}
            {screen.kind === 'error' && (
              <div role="alert" className="max-w-[640px]">
                <div className="flex items-start gap-2.5">
                  <CircleAlert size={18} className="mt-0.5 shrink-0 text-bad" />
                  <div>
                    <h2 className="text-[17px] font-semibold">The draft did not come through</h2>
                    <p className="selectable mt-1.5 text-[13px] leading-relaxed text-muted">{screen.message}</p>
                  </div>
                </div>
                <div className="mt-5 flex gap-2">
                  <Button tone="primary" onClick={() => void ask(answers, screen.finish)}>
                    Try again
                  </Button>
                  <Button tone="quiet" onClick={() => setScreen(before.current)}>
                    Back
                  </Button>
                </div>
              </div>
            )}
            {screen.kind === 'flow' && (
              <Result
                reply={screen.reply}
                onChange={() => (answers.length > 0 ? revisit(answers.length - 1) : setScreen({ kind: 'objective' }))}
                onStartOver={startOver}
              />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function Objective({ value, onChange, onSubmit }: { value: string; onChange(v: string): void; onSubmit(): void }) {
  const ready = value.trim() !== '';
  return (
    <div className="mx-auto max-w-[680px]">
      <div className="flex items-center gap-2 text-[12px] font-medium text-brass">
        <Sparkles size={14} /> Draft with AI
      </div>
      <h1 className="mt-2 text-[26px] font-semibold tracking-tight">What should this flow do?</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
        Say the main goal in a sentence or two. The AI asks a few quick questions, one at a time, and then drafts the flow. You see it before anything is saved.
      </p>
      <textarea
        autoFocus
        aria-label="What the flow should do"
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ready) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Fix bugs people report, with a test that proves each fix and a review before I merge"
        className="mt-5 w-full resize-y rounded-lg border border-line bg-panel px-3.5 py-3 text-[15px] leading-relaxed text-text placeholder:text-faint hover:border-line-strong focus:border-brass focus:outline-none"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => onChange(ex)}
            className="max-w-full rounded-full border border-line bg-panel px-3 py-1 text-left text-[12.5px] text-muted hover:border-brass hover:text-text"
          >
            {ex}
          </button>
        ))}
      </div>
      <div className="mt-6 flex items-center gap-3">
        <Button tone="primary" disabled={!ready} onClick={onSubmit}>
          Continue <ArrowRight size={14} />
        </Button>
        <span className="text-[12px] text-faint">
          <Kbd>⌘</Kbd> <Kbd>Enter</Kbd>
        </span>
      </div>
    </div>
  );
}

function Question({
  n,
  screen,
  onAnswer,
  onFinish,
}: {
  n: number;
  screen: Extract<Screen, { kind: 'question' }>;
  onAnswer(answer: string, picked: number[], other: string): void;
  onFinish(): void;
}) {
  const { q } = screen;
  const [picked, setPicked] = useState<number[]>(screen.picked);
  const [other, setOther] = useState(screen.other);
  const ready = picked.length > 0 || other.trim() !== '';

  const pick = (i: number) => {
    if (q.multi) setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)));
    else {
      setPicked([i]);
      setOther('');
    }
  };

  const next = () => {
    if (!ready) return;
    const parts = picked.map((i) => q.options[i]!.label);
    if (other.trim() !== '') parts.push(other.trim());
    onAnswer(parts.join('; '), picked, other.trim());
  };

  // Number keys pick an option and Enter moves on, unless you are typing in the box.
  const keys = useRef({ pick, next });
  keys.current = { pick, next };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      // Enter on a focused button presses that button, except on an option, where it means Next.
      const button = e.target instanceof HTMLButtonElement && !['radio', 'checkbox'].includes(e.target.getAttribute('role') ?? '');
      if (e.key === 'Enter' && !button) {
        e.preventDefault();
        keys.current.next();
        return;
      }
      if (typing) return;
      const i = Number(e.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < q.options.length) {
        e.preventDefault();
        keys.current.pick(i);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [q.options.length]);

  return (
    <div className="max-w-[680px]">
      <Progress n={n} />
      <h1 className="mt-3 text-[22px] leading-snug font-semibold tracking-tight">{q.question}</h1>
      {q.why !== '' && <p className="mt-1.5 text-[13px] text-faint">{q.why}</p>}
      <div role={q.multi ? 'group' : 'radiogroup'} aria-label={q.question} className="mt-5 space-y-2">
        {q.options.map((o, i) => {
          const on = picked.includes(i);
          return (
            <button
              key={i}
              type="button"
              role={q.multi ? 'checkbox' : 'radio'}
              aria-checked={on}
              onClick={() => pick(i)}
              className={cx('flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors', on ? 'border-brass bg-brass-soft' : 'border-line bg-panel hover:border-line-strong hover:bg-raised')}
            >
              <span
                className={cx(
                  'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center border-[1.5px]',
                  q.multi ? 'rounded-[5px]' : 'rounded-full',
                  on ? 'border-brass bg-brass' : 'border-line-strong',
                )}
              >
                {on && <span className={cx('bg-brass-ink', q.multi ? 'h-2 w-2 rounded-[2px]' : 'h-1.5 w-1.5 rounded-full')} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium text-text">{o.label}</span>
                {o.detail !== undefined && <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{o.detail}</span>}
              </span>
              <Kbd>{i + 1}</Kbd>
            </button>
          );
        })}
        <label className={cx('flex items-center gap-3 rounded-lg border px-4 py-2.5', other.trim() !== '' ? 'border-brass bg-brass-soft' : 'border-line bg-panel')}>
          <span className="shrink-0 text-[13px] text-muted">Something else</span>
          <input
            aria-label="Something else"
            value={other}
            onChange={(e) => {
              setOther(e.target.value);
              if (!q.multi && e.target.value.trim() !== '') setPicked([]);
            }}
            placeholder="Say it in your own words"
            className="h-7 min-w-0 flex-1 bg-transparent text-[13.5px] text-text placeholder:text-faint focus:outline-none"
          />
        </label>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button tone="primary" disabled={!ready} onClick={next}>
          Next <ArrowRight size={14} />
        </Button>
        <Button tone="outline" title="Leave this one to the AI" onClick={() => onAnswer(YOU_PICK, [], '')}>
          You pick
        </Button>
        <Button tone="quiet" className="ml-auto" title="Draft the flow from what you have said so far" onClick={onFinish}>
          <Wand2 size={13} /> Build it now
        </Button>
      </div>
    </div>
  );
}

/** Where you are: the question number, and dots that fill as the questions narrow. */
function Progress({ n }: { n: number }) {
  return (
    <div className="flex items-center gap-2.5 text-[12px] text-faint">
      <span className="font-medium text-muted">Question {n}</span>
      <span aria-hidden className="flex items-center gap-1">
        {Array.from({ length: Math.max(n, 4) }, (_, i) => (
          <span key={i} className={cx('h-1 rounded-full', i < n ? 'w-4 bg-brass' : 'w-2 bg-line-strong')} />
        ))}
      </span>
    </div>
  );
}

function Waiting({ drafting, n, onStop }: { drafting: boolean; n: number; onStop(): void }) {
  return (
    <div className="max-w-[680px]" role="status" aria-live="polite">
      {!drafting && <Progress n={n} />}
      <div className="mt-6 flex items-center gap-3">
        <span className="pulse h-2.5 w-2.5 rounded-full bg-brass" />
        <span className="text-[17px] font-medium">{drafting ? 'Drafting your flow' : 'Thinking of the next question'}</span>
      </div>
      <p className="mt-2 text-[13px] text-muted">{drafting ? 'This can take a minute. The app checks the draft and has the AI fix anything it finds.' : 'Usually a few seconds.'}</p>
      <Button tone="outline" className="mt-5" onClick={onStop}>
        <Square size={11} /> Stop
      </Button>
    </div>
  );
}

function Side({ understanding, answers, onRevisit }: { understanding: string; answers: Answered[]; onRevisit(i: number): void }) {
  return (
    <aside className="w-full shrink-0 space-y-5 min-[1180px]:sticky min-[1180px]:top-0 min-[1180px]:w-[320px]">
      {understanding !== '' && (
        <section className="rounded-lg border border-line bg-panel p-4">
          <h2 className="text-[12px] font-medium text-muted">What I know so far</h2>
          <p className="selectable mt-1.5 text-[13px] leading-relaxed text-text">{understanding}</p>
        </section>
      )}
      {answers.length > 0 && (
        <section>
          <h2 className="text-[12px] font-medium text-muted">Your answers</h2>
          <ol className="mt-2 space-y-1">
            {answers.map((a, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onRevisit(i)}
                  title="Go back to this question"
                  className="group w-full rounded-md px-2.5 py-1.5 text-left hover:bg-hover"
                >
                  <span className="block text-[12px] leading-snug text-faint">{a.question}</span>
                  <span className="flex items-center gap-1.5 text-[13px] leading-snug text-text">
                    {a.answer}
                    <PencilLine size={11} className="shrink-0 text-faint opacity-0 group-hover:opacity-100" />
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </aside>
  );
}

export function Preview({ flow }: { flow: Flow }) {
  const settings = useStore((s) => s.settings);
  const nodes = useMemo(() => toRfNodes(flow, settings), [flow, settings]);
  const edges = useMemo(() => toRfEdges(flow), [flow]);
  return (
    <div className="h-[420px] overflow-hidden rounded-lg border border-line bg-bg" aria-label="Preview of the drafted flow">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} color="var(--canvas-dot)" />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

function Result({ reply, onChange, onStartOver }: { reply: Extract<DraftReply, { kind: 'flow' }>; onChange(): void; onStartOver(): void }) {
  const [saving, setSaving] = useState(false);
  const { flow, summary, problems } = reply;
  const open = async () => {
    setSaving(true);
    const saved = await api().saveFlow(flow);
    // The editor looks the flow up in the list, so it is there before the editor opens.
    setState((s) => ({ flows: s.flows.some((f) => f.id === saved.id) ? s.flows : [...s.flows, saved] }));
    go({ kind: 'flows', flowId: saved.id });
  };
  return (
    <div>
      <div className="flex items-center gap-2 text-[12px] font-medium text-brass">
        <Sparkles size={14} /> Your draft
      </div>
      <h1 className="mt-2 text-[24px] font-semibold tracking-tight">{flow.name}</h1>
      {summary !== '' && <p className="selectable mt-2 max-w-[720px] text-[13.5px] leading-relaxed text-muted">{summary}</p>}
      <div className="mt-5">
        <Preview flow={flow} />
      </div>
      {problems.length > 0 && (
        <div className="mt-4 max-w-[720px]">
          <h2 className="text-[12px] font-medium text-muted">Left for you to fix in the editor</h2>
          <ul className="mt-1.5 space-y-1">
            {problems.map((p, i) => (
              <li key={i} className={cx('text-[12.5px] leading-snug', p.level === 'error' ? 'text-bad' : 'text-warn')}>
                {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button tone="primary" disabled={saving} onClick={() => void open()}>
          Open in editor <ArrowRight size={14} />
        </Button>
        <Button tone="outline" onClick={onChange}>
          Change answers
        </Button>
        <Button tone="quiet" onClick={onStartOver}>
          Start over
        </Button>
      </div>
      <p className="mt-3 text-[12px] text-faint">Nothing is saved until you open it in the editor.</p>
    </div>
  );
}
