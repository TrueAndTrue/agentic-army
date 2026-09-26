import { Plus, Trash2 } from 'lucide-react';

import { MAX_FLOW_DEPTH, slug } from '../../../shared/flow.ts';
import { fitEffort } from '../../../shared/models.ts';
import { AGENT_ROLES, ROLE_INFO, type Flow, type FlowNode, type NodeConfigs, type Settings } from '../../../shared/types.ts';
import { TYPE_LABEL } from '../lib/format.ts';
import { useStore } from '../lib/state.ts';
import { EffortOptions, Field, IconButton, Input, ModelOptions, Select, TextArea, Toggle, cx } from './ui.tsx';

type Patch<T> = (p: Partial<T>) => void;

function Vars({ flow, self, onInsert }: { flow: Flow; self: string; onInsert(v: string): void }) {
  const names = ['objective', 'input', 'visit', 'branch', ...flow.nodes.filter((n) => n.id !== self && n.type !== 'start').map((n) => `nodes.${slug(n.data.label)}`)];
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((n) => (
        <button key={n} type="button" onClick={() => onInsert(`{{${n}}}`)} className="rounded border border-line bg-raised px-1.5 py-px font-mono text-[10.5px] text-muted hover:border-brass hover:text-text">
          {`{{${n}}}`}
        </button>
      ))}
    </div>
  );
}

const VAR_HINT = 'Click a name to add it. {{input}} is what the previous node passed on; {{nodes.name}} is the last output of any node.';

function PromptField({ label, value, onChange, flow, self, rows = 7 }: { label: string; value: string; onChange(v: string): void; flow: Flow; self: string; rows?: number }) {
  return (
    <div className="space-y-1.5">
      <Field label={label} hint={VAR_HINT}>
        <TextArea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
      <Vars flow={flow} self={self} onInsert={(v) => onChange(value + (value.endsWith(' ') || value.endsWith('\n') || value === '' ? '' : ' ') + v)} />
    </div>
  );
}

function Num({ value, onChange, min, max, step, id, ...aria }: { value: number; onChange(v: number): void; min: number; max: number; step?: number; id?: string; 'aria-describedby'?: string }) {
  return <Input id={id} {...aria} type="number" value={value} min={min} max={max} step={step ?? 1} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))} />;
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="flex rounded-md border border-line p-0.5">
      {options.map((o) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)} className={cx('h-7 flex-1 rounded text-[12.5px]', value === o.v ? 'bg-hover font-medium text-text' : 'text-muted hover:text-text')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NodeInspector({ node, flow, settings, onChange, onDelete }: { node: FlowNode; flow: Flow; settings: Settings; onChange(data: FlowNode['data']): void; onDelete(): void }) {
  const set = <K extends keyof NodeConfigs>(d: NodeConfigs[K]): Patch<NodeConfigs[K]> => (p) => onChange({ ...d, ...p } as FlowNode['data']);
  const flows = useStore((s) => s.flows);

  let body: React.ReactNode = null;
  switch (node.type) {
    case 'start':
      body = <p className="text-[12.5px] leading-relaxed text-muted">A run starts here. Its output is the message you send, which every node can read as {'{{objective}}'}.</p>;
      break;
    case 'join':
      body = <p className="text-[12.5px] leading-relaxed text-muted">Waits until every node connected into it has finished, then passes all their outputs on together, each under its node's name.</p>;
      break;
    case 'agent': {
      const d = node.data;
      const s = set<'agent'>(d);
      const stage = settings.stageDefaults[d.role];
      const stageModel = settings.models.find((m) => m.id === stage.modelId)?.label ?? stage.modelId;
      const model = settings.models.find((m) => m.id === (d.modelId ?? stage.modelId));
      body = (
        <>
          <Field label="Role" hint={ROLE_INFO[d.role].summary}>
            <Select value={d.role} onChange={(e) => s({ role: e.target.value as typeof d.role })}>
              {AGENT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_INFO[r].label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-1 gap-2">
            <Field label="Model">
              <Select
                value={d.modelId ?? ''}
                onChange={(e) => {
                  const modelId = e.target.value === '' ? null : e.target.value;
                  const next = settings.models.find((m) => m.id === (modelId ?? stage.modelId));
                  s({ modelId, effort: d.effort === null ? null : fitEffort(next, d.effort) });
                }}
              >
                <option value="">Stage default ({stageModel})</option>
                <ModelOptions models={settings.models} />
              </Select>
            </Field>
            <Field label="Effort">
              <Select value={d.effort === null ? '' : fitEffort(model, d.effort)} onChange={(e) => s({ effort: e.target.value === '' ? null : (e.target.value as typeof d.effort) })}>
                <option value="">Stage default ({fitEffort(model, stage.effort)})</option>
                <EffortOptions model={model} />
              </Select>
            </Field>
          </div>
          <Field label="Works in" hint={d.workspace === 'run' ? 'Its own branch, shared by every node in the run. Your checkout is untouched until you merge.' : ROLE_INFO[d.role].writes ? 'Your project folder directly. An engineer here edits your checkout.' : 'Your project folder, read only for this role.'}>
            <Segmented value={d.workspace} onChange={(v) => s({ workspace: v })} options={[{ v: 'run', label: 'Run branch' }, { v: 'project', label: 'Project folder' }]} />
          </Field>
          <PromptField label="Prompt" value={d.prompt} onChange={(v) => s({ prompt: v })} flow={flow} self={node.id} rows={9} />
          <Toggle checked={d.web ?? d.role === 'scout'} onChange={(v) => s({ web: v })} label="Can search the web" />
          <Toggle checked={d.keepContext} onChange={(v) => s({ keepContext: v })} label="Continue the same conversation on a repeat visit" />
          <Field label="Most visits in one run" hint="A loop through this node stops the run when it reaches this.">
            <Num value={d.maxVisits} min={1} max={50} onChange={(v) => s({ maxVisits: v })} />
          </Field>
        </>
      );
      break;
    }
    case 'decide': {
      const d = node.data;
      const s = set<'decide'>(d);
      body = (
        <>
          <p className="rounded-md border border-brass/40 bg-brass-soft px-2.5 py-2 text-[12px] leading-relaxed text-muted">
            Jev reads the text below and answers in a few hundred milliseconds. It picks; it does not write. The node leaves by the output that matches its answer.
          </p>
          <Field label="Kind of answer">
            <Segmented value={d.mode} onChange={(v) => s({ mode: v })} options={[{ v: 'yesno', label: 'Yes or no' }, { v: 'choice', label: 'Choice' }, { v: 'score', label: 'Score' }]} />
          </Field>
          <Field label="Question">
            <TextArea rows={3} className="font-sans text-[12.5px]" value={d.question} onChange={(e) => s({ question: e.target.value })} />
          </Field>
          <PromptField label="What Jev reads" value={d.state} onChange={(v) => s({ state: v })} flow={flow} self={node.id} rows={3} />
          {d.mode === 'yesno' && (
            <Field label={`Yes at or above ${Math.round(d.threshold * 100)}%`} hint="Raise it when a wrong yes is costly.">
              <input type="range" min={0.05} max={0.95} step={0.05} value={d.threshold} onChange={(e) => s({ threshold: Number(e.target.value) })} className="w-full accent-[var(--brass)]" />
            </Field>
          )}
          {d.mode === 'choice' && (
            <Field label="Options" hint="Each option is an output. The key is its name on the canvas; the description is what Jev reads.">
              <div className="space-y-1.5">
                {d.options.map((o, i) => (
                  <div key={i} className="flex min-w-0 items-center gap-1.5">
                    <Input className="!w-24 shrink-0 font-mono text-[12px]" value={o.key} onChange={(e) => s({ options: d.options.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/\s+/g, '_') } : x)) })} />
                    <Input className="min-w-0 flex-1" value={o.description} placeholder="What this option means" onChange={(e) => s({ options: d.options.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} />
                    <IconButton label="Remove option" onClick={() => s({ options: d.options.filter((_, j) => j !== i) })}>
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                ))}
                <button type="button" onClick={() => s({ options: [...d.options, { key: `option_${d.options.length + 1}`, description: '' }] })} className="flex items-center gap-1 text-[12px] text-muted hover:text-text">
                  <Plus size={13} /> Add option
                </button>
              </div>
            </Field>
          )}
          {d.mode === 'score' && (
            <>
              <Field label="Levels, lowest first" hint="One per line. Describe a concrete situation for each.">
                <TextArea rows={4} className="font-sans text-[12.5px]" value={d.levels.join('\n')} onChange={(e) => s({ levels: e.target.value.split('\n') })} />
              </Field>
              <Field label="Leaves by high at or above level">
                <Select value={d.cut} onChange={(e) => s({ cut: Number(e.target.value) })}>
                  {d.levels.map((l, i) => (
                    <option key={i} value={i}>
                      {i}: {l}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <Field
            label={d.minConfidence === 0 ? 'Unsure output: off' : `Go "unsure" when Jev is under ${Math.round(d.minConfidence * 100)}% sure`}
            hint="Slide to 0 to turn it off. When on, the node gets an unsure output you can send somewhere, for example to ask you."
          >
            <input type="range" min={0} max={0.95} step={0.05} value={d.minConfidence} onChange={(e) => s({ minConfidence: Number(e.target.value) })} className="w-full accent-[var(--brass)]" />
          </Field>
          <Field label="Most visits in one run">
            <Num value={d.maxVisits} min={1} max={50} onChange={(v) => s({ maxVisits: v })} />
          </Field>
        </>
      );
      break;
    }
    case 'human': {
      const d = node.data;
      const s = set<'human'>(d);
      body = (
        <>
          <p className="text-[12.5px] leading-relaxed text-muted">The run pauses and the session shows this with Approve and Reject. A note you add travels on with the work.</p>
          <PromptField label="What you are shown" value={d.prompt} onChange={(v) => s({ prompt: v })} flow={flow} self={node.id} rows={5} />
        </>
      );
      break;
    }
    case 'shell': {
      const d = node.data;
      const s = set<'shell'>(d);
      body = (
        <>
          <Field label="Command" hint="Runs in your login shell. Exit code 0 leaves by pass, anything else by fail.">
            <Input className="font-mono text-[12px]" value={d.command} onChange={(e) => s({ command: e.target.value })} />
          </Field>
          <Field label="Runs in">
            <Segmented value={d.workspace} onChange={(v) => s({ workspace: v })} options={[{ v: 'run', label: 'Run branch' }, { v: 'project', label: 'Project folder' }]} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Time limit, seconds">
              <Num value={d.timeoutSec} min={5} max={7200} onChange={(v) => s({ timeoutSec: v })} />
            </Field>
            <Field label="Most visits">
              <Num value={d.maxVisits} min={1} max={50} onChange={(v) => s({ maxVisits: v })} />
            </Field>
          </div>
        </>
      );
      break;
    }
    case 'git': {
      const d = node.data;
      const s = set<'git'>(d);
      body = (
        <>
          <Field label="Action">
            <Select value={d.action} onChange={(e) => s({ action: e.target.value as typeof d.action })}>
              <option value="diff">Show the diff so far</option>
              <option value="commit">Commit the run branch</option>
              <option value="merge">Merge the run branch into your branch</option>
            </Select>
          </Field>
          {d.action !== 'diff' && <PromptField label="Commit message" value={d.message} onChange={(v) => s({ message: v })} flow={flow} self={node.id} rows={2} />}
          {d.action === 'merge' && <p className="text-[12px] text-warn">This changes your checkout without asking. Put an approval before it if you want to look first.</p>}
        </>
      );
      break;
    }
    case 'search': {
      const d = node.data;
      const s = set<'search'>(d);
      body = (
        <>
          <p className="rounded-md border border-brass/40 bg-brass-soft px-2.5 py-2 text-[12px] leading-relaxed text-muted">
            Searches the web over plain HTTP; nothing opens on screen. Jev opens the likeliest three results and picks the passages that answer. The output is those passages with their links, for the next step to answer from.
          </p>
          <PromptField label="Search for" value={d.query} onChange={(v) => s({ query: v })} flow={flow} self={node.id} rows={2} />
          <PromptField label="Question to answer" value={d.question} onChange={(v) => s({ question: v })} flow={flow} self={node.id} rows={2} />
          <p className="-mt-1 text-[11.5px] text-faint">Leave it empty to use the search words.</p>
          <Field label={`Found when Jev is ${Math.round(d.threshold * 100)}% sure or more`} hint="Below that, the step leaves by unanswered.">
            <input type="range" min={0.1} max={0.9} step={0.05} value={d.threshold} onChange={(e) => s({ threshold: Number(e.target.value) })} className="w-full accent-[var(--brass)]" />
          </Field>
        </>
      );
      break;
    }
    case 'browser': {
      const d = node.data;
      const s = set<'browser'>(d);
      body = (
        <>
          <p className="rounded-md border border-brass/40 bg-brass-soft px-2.5 py-2 text-[12px] leading-relaxed text-muted">
            A Chromium page that Jev drives, for sites that need clicking and typing. To look something up, a Web search step is faster. Each step the page becomes a list of actions and Jev picks one. It only types phrases taken from the goal, quoted or after "search for".
          </p>
          <PromptField label="Goal" value={d.goal} onChange={(v) => s({ goal: v })} flow={flow} self={node.id} rows={3} />
          <Field label="Start page">
            <Input value={d.startUrl} onChange={(e) => s({ startUrl: e.target.value })} />
          </Field>
          <Field label="Most steps">
            <Num value={d.maxSteps} min={1} max={60} onChange={(v) => s({ maxSteps: v })} />
          </Field>
          <Toggle checked={d.guard} onChange={(v) => s({ guard: v })} label="Jev guards each click and keystroke" />
          {d.guard && (
            <Field label={`Ask me when risk is ${Math.round(d.guardThreshold * 100)}% or more`} hint="Payments, deletions, sending, posting, account changes and passwords count as risky.">
              <input type="range" min={0.1} max={0.9} step={0.05} value={d.guardThreshold} onChange={(e) => s({ guardThreshold: Number(e.target.value) })} className="w-full accent-[var(--brass)]" />
            </Field>
          )}
          <Toggle checked={d.showWindow} onChange={(v) => s({ showWindow: v })} label="Show the browser window while it works" />
        </>
      );
      break;
    }
    case 'flow': {
      const d = node.data;
      const s = set<'flow'>(d);
      body = (
        <>
          <Field label="Flow to run" hint="It runs as a run of its own, on its own branch, and shows in the thread. This node waits for it, then leaves by done or failed with its result.">
            <Select value={d.flowId} onChange={(e) => s({ flowId: e.target.value })}>
              <option value="">Pick a flow</option>
              {flows
                .filter((f) => f.id !== flow.id)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </Select>
          </Field>
          <PromptField label="Its objective" value={d.objective} onChange={(v) => s({ objective: v })} flow={flow} self={node.id} rows={4} />
          <p className="text-[12px] leading-relaxed text-faint">
            You put this step here, so it runs whatever the other flow's "Who can start this" says. Flows can run flows {String(MAX_FLOW_DEPTH)} deep; a deeper one fails instead of starting.
          </p>
        </>
      );
      break;
    }
    case 'end': {
      const d = node.data;
      const s = set<'end'>(d);
      body = (
        <>
          <PromptField label="Result" value={d.template} onChange={(v) => s({ template: v })} flow={flow} self={node.id} rows={4} />
          <Field label="A run that ends here counts as" hint="Use Failed for an end like &quot;Tests failed&quot;, so the run shows red instead of a green Finished.">
            <Select value={d.outcome ?? 'success'} onChange={(e) => s({ outcome: e.target.value as 'success' | 'failure' | 'stopped' })}>
              <option value="success">Finished</option>
              <option value="failure">Failed</option>
              <option value="stopped">Stopped</option>
            </Select>
          </Field>
        </>
      );
      break;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] font-medium text-faint">{TYPE_LABEL[node.type]}</span>
        <IconButton label="Delete node" onClick={onDelete}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      <Field label="Name" hint={`Other nodes read its output as {{nodes.${slug(node.data.label) || 'name'}}}.`}>
        <Input value={node.data.label} onChange={(e) => onChange({ ...node.data, label: e.target.value } as FlowNode['data'])} />
      </Field>
      {body}
    </div>
  );
}
