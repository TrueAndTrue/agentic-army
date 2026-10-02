import { CheckCircle2, CircleAlert, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { effortsFor, fitEffort } from '../../../shared/models.ts';
import { AGENT_ROLES, INVOKE_INFO, INVOKE_LEVELS, ROLE_INFO, SAVED_KEY, type Harness, type InvokeLevel, type Settings, type StageDefault } from '../../../shared/types.ts';
import { DEFAULT_INVOKE_CEILING } from '../../../shared/flow.ts';
import { ROLE_COLOR } from '../lib/format.ts';
import { api, checkMachine, useStore } from '../lib/state.ts';
import { Diagnostics } from './Diagnostics.tsx';
import { SecretInput } from './SecretInput.tsx';
import { Button, EffortOptions, Field, IconButton, Input, ModelOptions, Select } from './ui.tsx';

function Section({ id, title, children, note }: { id?: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section id={id === undefined ? undefined : `settings-${id}`} className="scroll-mt-4 border-b border-line py-7 first:pt-2 last:border-0">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {note !== undefined && <p className="mt-1 max-w-[620px] text-[12.5px] leading-relaxed text-muted">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Check({ label, r }: { label: string; r: { ok: boolean; detail: string } | undefined }) {
  return (
    <div className="flex items-start gap-2 text-[12.5px]">
      {r === undefined ? <span className="mt-1 h-3 w-3 rounded-full border border-line" /> : r.ok ? <CheckCircle2 size={15} className="mt-px text-ok" /> : <CircleAlert size={15} className="mt-px text-bad" />}
      <span className="w-20 shrink-0 font-medium">{label}</span>
      <span className="selectable min-w-0 text-muted">{r?.detail ?? 'Checking…'}</span>
    </div>
  );
}

export function SettingsView() {
  const saved = useStore((s) => s.settings);
  const [s, setS] = useState<Settings | null>(saved);
  const doctor = useStore((st) => st.doctor);
  const view = useStore((st) => st.view);
  const [checking, setChecking] = useState(false);
  const [jev, setJev] = useState<{ ok: boolean; detail: string } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [refreshed, setRefreshed] = useState<string | null>(null);

  useEffect(() => setS(saved), [saved]);
  useEffect(() => {
    void checkMachine();
  }, []);
  // A link from elsewhere ("add it in Settings under Jev") lands on that section.
  const section = view.kind === 'settings' ? view.section : undefined;
  useEffect(() => {
    if (section !== undefined) document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' });
  }, [section]);
  if (s === null) return null;
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);
  const save = async () => {
    await api().saveSettings(s);
    setSavedAt(Date.now());
    void checkMachine(true);
  };
  const modelIds = new Set(s.models.map((m) => m.id));
  const byId = (id: string) => s.models.find((m) => m.id === id);
  /** A stage row: pick a model and effort; changing the model keeps the effort if it still fits. */
  const stageRow = (key: string, label: React.ReactNode, value: StageDefault, onChange: (v: StageDefault) => void) => (
    <div key={key} className="grid grid-cols-[150px_1fr_130px] items-center gap-2">
      {label}
      <Select aria-label={`${key} model`} value={value.modelId} onChange={(e) => onChange({ modelId: e.target.value, effort: fitEffort(byId(e.target.value), value.effort) })}>
        <ModelOptions models={s.models} />
      </Select>
      <Select aria-label={`${key} effort`} value={fitEffort(byId(value.modelId), value.effort)} onChange={(e) => onChange({ ...value, effort: e.target.value as StageDefault['effort'] })}>
        <EffortOptions model={byId(value.modelId)} />
      </Select>
    </div>
  );
  const refresh = async () => {
    const { settings: next, added } = await api().refreshModels();
    // Keep unsaved edits; take only the models the lists added or updated.
    setS((cur) => (cur === null ? next : { ...cur, models: next.models, offeredModels: next.offeredModels }));
    setRefreshed(added.length === 0 ? 'No new models.' : `Added ${added.join(', ')}.`);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-6">
        <span className="text-[13.5px] font-semibold">Settings</span>
        {savedAt !== null && !dirty && <span className="text-[12px] text-ok">Saved</span>}
        <div className="no-drag ml-auto flex gap-2">
          <Button tone="quiet" disabled={!dirty} onClick={() => setS(saved)}>
            Discard
          </Button>
          <Button tone="primary" disabled={!dirty} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-6 pb-16">
          <Section id="machine" title="This machine" note="The app drives the claude and codex command-line tools you are already logged in to. It never asks for an Anthropic or OpenAI key.">
            <div className="space-y-2">
              <button
                className="float-right -mt-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-faint hover:bg-hover hover:text-text"
                onClick={async () => {
                  setChecking(true);
                  await checkMachine(true);
                  setChecking(false);
                }}
              >
                <RefreshCw size={12} className={checking ? 'animate-spin' : undefined} /> Check again
              </button>
              <Check label="claude" r={doctor?.claude} />
              <Check label="codex" r={doctor?.codex} />
              <Check label="git" r={doctor?.git} />
              <Check label="Jev" r={doctor?.typesafe} />
            </div>
          </Section>

          <Section id="jev" title="Jev" note="TypeSafe's Jev answers the decision steps in flows, picks a flow in Auto, reads web searches for agents, and drives and guards the browser step. Every built-in flow uses it. The keys stay on this Mac, encrypted with a key macOS keeps in your Keychain.">
            <div className="space-y-3">
              <Field
                label="TypeSafe API key"
                hint={
                  <>
                    No key yet?{' '}
                    <a className="text-muted underline decoration-line-strong underline-offset-2 hover:text-text" href="https://typesafe.ai" target="_blank" rel="noreferrer">
                      Get one from TypeSafe
                    </a>
                    .
                  </>
                }
              >
                <SecretInput label="TypeSafe API key" value={s.typesafe.apiKey} wasSaved={saved?.typesafe.apiKey === SAVED_KEY} placeholder="Paste a key" onChange={(v) => setS({ ...s, typesafe: { ...s.typesafe, apiKey: v } })} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Model">
                  <Input className="font-mono text-[12px]" value={s.typesafe.model} onChange={(e) => setS({ ...s, typesafe: { ...s.typesafe, model: e.target.value } })} />
                </Field>
                <Field label="Endpoint">
                  <Input className="font-mono text-[12px]" value={s.typesafe.baseUrl} onChange={(e) => setS({ ...s, typesafe: { ...s.typesafe, baseUrl: e.target.value } })} />
                </Field>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  onClick={async () => {
                    if (dirty) await save();
                    setJev(await api().testJev());
                  }}
                >
                  {dirty ? 'Save and test' : 'Test Jev'}
                </Button>
                {jev !== null && <span className={`selectable min-w-0 text-[12.5px] ${jev.ok ? 'text-ok' : 'text-bad'}`}>{jev.detail.replace(/ (Jev needs one; add it in Settings under Jev|Paste a working key in Settings under Jev)\.$/, '')}</span>}
              </div>
              <Field
                label="Brave Search API key (optional)"
                hint={
                  <>
                    Jev's web searches read DuckDuckGo's and Brave's public results pages, which turn a program away after many searches in a row. Brave's Search API does not, and{' '}
                    <a className="text-muted underline decoration-line-strong underline-offset-2 hover:text-text" href="https://brave.com/search/api/" target="_blank" rel="noreferrer">
                      its free plan
                    </a>{' '}
                    covers 2,000 searches a month.
                  </>
                }
              >
                <SecretInput label="Brave Search API key" value={s.braveApiKey} wasSaved={saved?.braveApiKey === SAVED_KEY} placeholder="Leave empty to use the public pages" onChange={(v) => setS({ ...s, braveApiKey: v })} />
              </Field>
            </div>
          </Section>
          <Section title="Models at each stage" note="What an agent node uses when it does not name its own model. Change a stage here and every flow that relies on the default follows.">
            <div className="space-y-2">
              {AGENT_ROLES.map((r) =>
                stageRow(
                  r,
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ROLE_COLOR[r] }} />
                    {ROLE_INFO[r].label}
                  </span>,
                  s.stageDefaults[r],
                  (v) => setS({ ...s, stageDefaults: { ...s.stageDefaults, [r]: v } }),
                ),
              )}
              <div className="pt-2">{stageRow('chat', <span className="text-[13px] font-medium">New chats</span>, s.chatDefault, (v) => setS({ ...s, chatDefault: v }))}</div>
            </div>
          </Section>
          <Section
            title="Starting flows"
            note="You can always start a flow: pick it under the message box, press Run on the Flows page, or type its command, like /quick-fix. Each flow also says whether Jev in Auto and chat agents may start it. This is the most any flow may allow."
          >
            <div className="grid grid-cols-[150px_1fr] items-start gap-2">
              <span className="pt-1.5 text-[13px] font-medium">At most</span>
              <div>
                <Select aria-label="The most any flow may allow" value={s.invokeCeiling ?? DEFAULT_INVOKE_CEILING} onChange={(e) => setS({ ...s, invokeCeiling: e.target.value as InvokeLevel })}>
                  {INVOKE_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {INVOKE_INFO[l].label}
                    </option>
                  ))}
                </Select>
                <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{INVOKE_INFO[s.invokeCeiling ?? DEFAULT_INVOKE_CEILING].summary}</p>
              </div>
            </div>
          </Section>
          <Section
            id="models"
            title="Models"
            note="Every model a node or chat can use. The claude models are built in. The codex models come from codex's own list, so a model OpenAI ships appears here once codex has seen it. You can also add one by hand: the model id is what the command-line tool receives."
          >
            <div className="space-y-1.5">
              <div className="grid grid-cols-[1fr_110px_1.3fr_32px] gap-2 px-0.5 text-[11.5px] text-faint">
                <span>Name</span>
                <span>Runs on</span>
                <span>Model id</span>
                <span />
              </div>
              {s.models.map((m, i) => (
                <div key={m.id} className="grid grid-cols-[1fr_110px_1.3fr_32px] gap-x-2">
                  <Input value={m.label} onChange={(e) => setS({ ...s, models: s.models.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                  <Select value={m.harness} onChange={(e) => setS({ ...s, models: s.models.map((x, j) => (j === i ? { ...x, harness: e.target.value as Harness } : x)) })}>
                    <option value="claude">claude</option>
                    <option value="codex">codex</option>
                  </Select>
                  <Input className="font-mono text-[12px]" value={m.model} onChange={(e) => setS({ ...s, models: s.models.map((x, j) => (j === i ? { ...x, model: e.target.value.trim() } : x)) })} />
                  <IconButton
                    label={`Remove ${m.label}`}
                    disabled={s.models.length <= 1}
                    onClick={() => {
                      const models = s.models.filter((_, j) => j !== i);
                      const fallback = models[0]!.id;
                      const fix = (id: string) => (id === m.id ? fallback : id);
                      setS({
                        ...s,
                        models,
                        chatDefault: { ...s.chatDefault, modelId: fix(s.chatDefault.modelId) },
                        stageDefaults: Object.fromEntries(Object.entries(s.stageDefaults).map(([k, v]) => [k, { ...v, modelId: fix(v.modelId) }])) as Settings['stageDefaults'],
                      });
                    }}
                    className="h-8 w-8"
                  >
                    <Trash2 size={14} />
                  </IconButton>
                  <p className="col-span-4 mb-1.5 mt-0.5 px-0.5 text-[11.5px] text-faint">
                    {m.description !== undefined && <span className="text-muted">{m.description} </span>}
                    Effort {effortsFor(m).join(', ')}.
                  </p>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-1 pt-1">
                <Button
                  tone="quiet"
                  onClick={() => {
                    let n = s.models.length + 1;
                    while (modelIds.has(`model-${n}`)) n += 1;
                    setS({ ...s, models: [...s.models, { id: `model-${n}`, harness: 'claude', model: '', label: 'New model' }] });
                  }}
                >
                  <Plus size={14} /> Add a model
                </Button>
                <Button tone="quiet" onClick={() => void refresh()}>
                  <RefreshCw size={13} /> Check for new models
                </Button>
                {refreshed !== null && <span className="ml-1 text-[12px] text-muted">{refreshed}</span>}
              </div>
            </div>
          </Section>




          <Section
            id="permissions"
            title="Permissions"
            note="Every agent gets its role's tools and nothing more. Every role is denied your credentials (~/.ssh, ~/.aws, .env files) and commands like npm publish and force pushes. A run works on its own branch, and your checkout changes only when you merge. This setting decides how far an agent's shell reaches."
          >
            <div className="space-y-3">
              {(['unguarded', 'guarded'] as const).map((p) => (
                <label key={p} className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                  <input type="radio" name="posture" className="mt-1 accent-[var(--brass)]" checked={s.posture === p} onChange={() => setS({ ...s, posture: p })} />
                  <span>
                    <span className="font-medium">{p === 'unguarded' ? 'Any shell command in the role' : 'Only listed shell commands'}</span>
                    {p === 'unguarded' && <span className="ml-1.5 text-[11.5px] text-faint">the default</span>}
                    <span className="block max-w-[620px] text-[12px] leading-relaxed text-muted">
                      {p === 'unguarded'
                        ? "Engineers and chats can install packages and run any command, and codex agents can use the network, so a codex reviewer can run tests that start a local server. Nothing sandboxes the shell: a claude agent's commands run with your access to this Mac. Use it in projects you would let a colleague work in."
                        : "The shell runs only each role's listed commands: git, and the usual test, build and lint commands. codex agents get no network. An engineer cannot run npm install or a node script, and a codex reviewer fails any test that opens a port, so the built-in flows stop more often. It catches mistakes more than it stops a determined agent: npm test still runs whatever the project's test script says."}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Section>

          <Section title="Appearance and tools">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Theme">
                <Select value={s.theme} onChange={(e) => setS({ ...s, theme: e.target.value as Settings['theme'] })}>
                  <option value="system">Match the system</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </Select>
              </Field>
              <Field label="claude binary" hint="Empty uses claude on your PATH.">
                <Input className="font-mono text-[12px]" value={s.claudeBin} placeholder="claude" onChange={(e) => setS({ ...s, claudeBin: e.target.value })} />
              </Field>
              <Field label="codex binary" hint="Empty uses codex on your PATH.">
                <Input className="font-mono text-[12px]" value={s.codexBin} placeholder="codex" onChange={(e) => setS({ ...s, codexBin: e.target.value })} />
              </Field>
            </div>
          </Section>

          <Section
            id="diagnostics"
            title="Diagnostics"
            note="When something goes wrong, copy this and send it to whoever is helping you. It has the app's and this Mac's versions, what the machine check found, counts of your projects and runs, and the end of the app's log. It never includes your keys, your messages or your files."
          >
            <Diagnostics />
          </Section>
        </div>
      </div>
    </div>
  );
}
