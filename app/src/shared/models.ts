/**
 * Rules about models that both sides need: which effort levels a model takes, and how the models
 * the vendors list join the models you keep in Settings. Pure, so the renderer can use it too.
 */

import { EFFORTS, type Effort, type Harness, type ModelEntry, type Settings } from './types.ts';

/** What a model takes when its entry does not say: claude's `--effort` range, and codex's older one. */
const USUAL_EFFORTS: Record<Harness, Effort[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
};

export function effortsFor(m: Pick<ModelEntry, 'harness' | 'efforts'> | undefined): Effort[] {
  if (m === undefined) return USUAL_EFFORTS.claude;
  return m.efforts !== undefined && m.efforts.length > 0 ? m.efforts : USUAL_EFFORTS[m.harness];
}

/**
 * The level to send for `effort` on this model. A level the model takes goes through as it is.
 * Otherwise the nearest level above it, and if there is none, the model's highest. Sending a level
 * the model does not take fails the turn: codex answers "'max' is not supported with the
 * 'gpt-5.5' model".
 */
export function fitEffort(m: Pick<ModelEntry, 'harness' | 'efforts'> | undefined, effort: Effort): Effort {
  const ok = effortsFor(m);
  if (ok.includes(effort)) return effort;
  const rank = EFFORTS.indexOf(effort);
  return ok.find((e) => EFFORTS.indexOf(e) > rank) ?? ok.at(-1) ?? effort;
}

export const modelKey = (m: Pick<ModelEntry, 'harness' | 'model'>): string => `${m.harness}:${m.model}`;

/**
 * Join the vendor lists into your models. A listed model you already have keeps your id and name,
 * and takes the list's effort levels and description. A model the app never offered before is
 * added. A model you removed stays removed, because its key is already in `offeredModels`.
 *
 * Listed models sit in the vendor's order, newest first, so GPT-5.5 does not sit above GPT-6 just
 * because you had it first. Claude models come before codex ones, and models you added by hand
 * follow the listed ones of their harness.
 */
export function mergeCatalog(settings: Settings, catalog: ModelEntry[]): { settings: Settings; added: ModelEntry[] } {
  const offered = new Set(settings.offeredModels ?? []);
  // Settings from before the lists existed never recorded what was offered. Count what they hold.
  if (settings.offeredModels === undefined) for (const m of settings.models) offered.add(modelKey(m));
  const byKey = new Map(catalog.map((c) => [modelKey(c), c]));
  const models = settings.models.map((m) => {
    const c = byKey.get(modelKey(m));
    if (c === undefined) return m;
    const next: ModelEntry = { ...m, source: m.source ?? c.source };
    if (c.efforts !== undefined) next.efforts = c.efforts;
    if (c.description !== undefined) next.description = c.description;
    return next;
  });
  const have = new Set(models.map(modelKey));
  const ids = new Set(models.map((m) => m.id));
  const added: ModelEntry[] = [];
  for (const c of catalog) {
    const key = modelKey(c);
    if (have.has(key) || offered.has(key)) continue;
    let id = c.id;
    for (let n = 2; ids.has(id); n += 1) id = `${c.id}-${n}`;
    ids.add(id);
    const entry = { ...c, id };
    models.push(entry);
    added.push(entry);
  }
  for (const c of catalog) offered.add(modelKey(c));
  const order = new Map(catalog.map((c, i) => [modelKey(c), i]));
  const rank = (m: ModelEntry) => (m.harness === 'claude' ? 0 : 1) * 1e6 + (order.get(modelKey(m)) ?? 1e5);
  // Array sort is stable, so hand-added models keep their order among themselves.
  models.sort((a, b) => rank(a) - rank(b));
  return { settings: { ...settings, models, offeredModels: [...offered].sort() }, added };
}
