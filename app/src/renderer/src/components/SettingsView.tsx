import { CheckCircle2, CircleAlert, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AGENT_ROLES, EFFORTS, ROLE_INFO, type DoctorReport, type Harness, type Settings } from '../../../shared/types.ts';
import { ROLE_COLOR } from '../lib/format.ts';
import { api, useStore } from '../lib/state.ts';
import { Button, Field, IconButton, Input, Select } from './ui.tsx';

function Section({ title, children, note }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line py-7 first:pt-2 last:border-0">
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
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [jev, setJev] = useState<{ ok: boolean; detail: string } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => setS(saved), [saved]);
  useEffect(() => {
    void api().doctor().then(setDoctor);
  }, []);
  if (s === null) return null;
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);
  const save = async () => {
    await api().saveSettings(s);
    setSavedAt(Date.now());
    void api().doctor().then(setDoctor);
  };
  const modelIds = new Set(s.models.map((m) => m.id));

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
          <Section title="This machine" note="The app drives the claude and codex command-line tools you are already logged in to. It never asks for an Anthropic or OpenAI key.">
            <div className="space-y-2">
              <Check label="claude" r={doctor?.claude} />
              <Check label="codex" r={doctor?.codex} />
              <Check label="git" r={doctor?.git} />
              <Check label="Jev" r={doctor?.typesafe} />
            </div>
          </Section>

          <Section title="Models" note="Every model a node or chat can use. Add one when a vendor ships a new model: the model id is what the command-line tool receives.">
            <div className="space-y-1.5">
              <div className="grid grid-cols-[1fr_110px_1.3fr_32px] gap-2 px-0.5 text-[11.5px] text-faint">
                <span>Name</span>
                <span>Runs on</span>
                <span>Model id</span>
                <span />
              </div>
              {s.models.map((m, i) => (
                <div key={m.id} className="grid grid-cols-[1fr_110px_1.3fr_32px] gap-2">
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
                </div>
              ))}
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
            </div>
          </Section>

          <Section title="Models at each stage" note="What an agent node uses when it does not name its own model. Change a stage here and every flow that relies on the default follows.">
            <div className="space-y-2">
              {AGENT_ROLES.map((r) => (
                <div key={r} className="grid grid-cols-[150px_1fr_130px] items-center gap-2">
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ROLE_COLOR[r] }} />
                    {ROLE_INFO[r].label}
                  </span>
                  <Select value={s.stageDefaults[r].modelId} onChange={(e) => setS({ ...s, stageDefaults: { ...s.stageDefaults, [r]: { ...s.stageDefaults[r], modelId: e.target.value } } })}>
                    {s.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.harness}
                      </option>
                    ))}
                  </Select>
                  <Select value={s.stageDefaults[r].effort} onChange={(e) => setS({ ...s, stageDefaults: { ...s.stageDefaults, [r]: { ...s.stageDefaults[r], effort: e.target.value as typeof s.chatDefault.effort } } })}>
                    {EFFORTS.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
              <div className="grid grid-cols-[150px_1fr_130px] items-center gap-2 pt-2">
                <span className="text-[13px] font-medium">New chats</span>
                <Select value={s.chatDefault.modelId} onChange={(e) => setS({ ...s, chatDefault: { ...s.chatDefault, modelId: e.target.value } })}>
                  {s.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} · {m.harness}
                    </option>
                  ))}
                </Select>
                <Select value={s.chatDefault.effort} onChange={(e) => setS({ ...s, chatDefault: { ...s.chatDefault, effort: e.target.value as typeof s.chatDefault.effort } })}>
                  {EFFORTS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </Section>

          <Section title="Jev" note="TypeSafe's Jev answers the decision nodes, picks flows in Auto mode, and drives and guards the browser node. The key stays on this machine.">
            <div className="space-y-3">
              <Field label="TypeSafe API key">
                <Input type="password" autoComplete="off" value={s.typesafe.apiKey} placeholder="Paste a key" onChange={(e) => setS({ ...s, typesafe: { ...s.typesafe, apiKey: e.target.value } })} />
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
                {jev !== null && <span className={`selectable text-[12.5px] ${jev.ok ? 'text-ok' : 'text-bad'}`}>{jev.detail}</span>}
              </div>
            </div>
          </Section>

          <Section title="Permissions" note="Every agent gets its role's tools and nothing more, and every role is denied your credentials and destructive commands. This setting decides how tightly the shell is scoped.">
            <div className="space-y-2">
              {(['unguarded', 'guarded'] as const).map((p) => (
                <label key={p} className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                  <input type="radio" className="mt-1 accent-[var(--brass)]" checked={s.posture === p} onChange={() => setS({ ...s, posture: p })} />
                  <span>
                    <span className="font-medium">{p === 'unguarded' ? 'Any shell command in the role' : 'Only listed shell commands'}</span>
                    <span className="block text-[12px] text-muted">
                      {p === 'unguarded'
                        ? 'An engineer may run any command; the deny list and write boundaries still hold. Best for real work.'
                        : 'Every command must match the role’s allow list exactly. Safer, and some test runners will be refused.'}
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
        </div>
      </div>
    </div>
  );
}
