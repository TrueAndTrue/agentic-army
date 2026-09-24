import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { codexModels, modelCatalog } from '../src/main/models.ts';
import { DEFAULT_SETTINGS } from '../src/main/store.ts';
import { fitEffort, mergeCatalog } from '../src/shared/models.ts';
import type { ModelEntry } from '../src/shared/types.ts';

/** The shape codex 0.154 writes, trimmed to the fields the app reads. */
function codexHome(models: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
  writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({ fetched_at: '2026-09-24T17:56:58Z', client_version: '0.154.0', models }));
  return dir;
}

const levels = (...e: string[]) => e.map((effort) => ({ effort, description: '' }));

const CODEX_0154 = [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', visibility: 'list', priority: 1, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 3, supported_reasoning_levels: levels('low') },
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 4, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', priority: 8, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max') },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 7, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh') },
  { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
];

describe("codex's model list", () => {
  test('listed models in priority order, hidden ones left out, each with its own effort levels', () => {
    const models = codexModels(codexHome(CODEX_0154));
    assert.deepEqual(
      models.map((m) => m.label),
      ['GPT-6-Astra', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5'],
    );
    assert.deepEqual(models[0]!.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.deepEqual(models.at(-1)!.efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(models[0]!.description, 'Frontier intelligence for the most demanding work.');
  });

  test('a missing or unfamiliar file gives no codex models, and the claude ones are still there', () => {
    const empty = mkdtempSync(join(tmpdir(), 'codex-none-'));
    assert.deepEqual(codexModels(empty), []);
    assert.deepEqual(codexModels(codexHome([{ name: 'no slug' }, 'junk', null])), []);
    assert.deepEqual(
      modelCatalog(empty).map((m) => m.label),
      ['Opus 5.5', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5'],
    );
  });
});

describe('joining the lists into your models', () => {
  const catalog = modelCatalog(codexHome(CODEX_0154));

  test('settings saved before the lists existed gain the new codex models and keep their ids', () => {
    const old = {
      ...DEFAULT_SETTINGS,
      models: DEFAULT_SETTINGS.models.map(({ efforts: _e, source: _s, ...m }) => m as ModelEntry),
    };
    const { settings, added } = mergeCatalog(old, catalog);
    assert.deepEqual(
      added.map((m) => m.label),
      ['GPT-6-Astra', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna'],
    );
    assert.deepEqual(
      settings.models.map((m) => m.label),
      ['Opus 5.5', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5', 'GPT-6-Astra', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5'],
    );
    const gpt55 = settings.models.find((m) => m.model === 'gpt-5.5')!;
    assert.equal(gpt55.id, 'codex-gpt55', 'stage defaults that point at it still resolve');
    assert.deepEqual(gpt55.efforts, ['low', 'medium', 'high', 'xhigh']);
  });

  test('a model you removed is not added back, and your own name for a listed model stays', () => {
    const first = mergeCatalog(DEFAULT_SETTINGS, catalog).settings;
    const edited = {
      ...first,
      models: first.models.filter((m) => m.model !== 'gpt-5.6-luna').map((m) => (m.model === 'gpt-6-astra' ? { ...m, label: 'Astra' } : m)),
    };
    const { settings, added } = mergeCatalog(edited, catalog);
    assert.deepEqual(added, []);
    assert.equal(settings.models.some((m) => m.model === 'gpt-5.6-luna'), false);
    assert.equal(settings.models.find((m) => m.model === 'gpt-6-astra')?.label, 'Astra');
  });

  test('a model codex starts listing later is added on the next read', () => {
    const first = mergeCatalog(DEFAULT_SETTINGS, catalog).settings;
    const later = modelCatalog(codexHome([...CODEX_0154, { slug: 'gpt-6-nova', display_name: 'GPT-6-Nova', visibility: 'list', priority: 0, supported_reasoning_levels: levels('low', 'high') }]));
    const { added } = mergeCatalog(first, later);
    assert.deepEqual(added.map((m) => m.model), ['gpt-6-nova']);
  });
});

describe('fitting an effort to a model', () => {
  const gpt55: ModelEntry = { id: 'x', harness: 'codex', model: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] };
  const astra: ModelEntry = { ...gpt55, model: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };

  test('a level the model takes goes through unchanged', () => {
    assert.equal(fitEffort(astra, 'ultra'), 'ultra');
    assert.equal(fitEffort(gpt55, 'high'), 'high');
  });

  test('above the model, it sends the model\'s highest: codex rejects max on gpt-5.5', () => {
    assert.equal(fitEffort(gpt55, 'max'), 'xhigh');
    assert.equal(fitEffort(gpt55, 'ultra'), 'xhigh');
  });

  test('a level below the model rounds up, never down', () => {
    assert.equal(fitEffort(astra, 'minimal'), 'low');
  });

  test('claude with no list takes up to max; ultra becomes max', () => {
    const claude: ModelEntry = { id: 'c', harness: 'claude', model: 'claude-new', label: 'New' };
    assert.equal(fitEffort(claude, 'max'), 'max');
    assert.equal(fitEffort(claude, 'ultra'), 'max');
  });
});

test('a model you added by hand stays after the listed ones of its harness', () => {
  const mine: ModelEntry = { id: 'model-9', harness: 'claude', model: 'claude-opus-4-7', label: 'Opus 4.7', source: 'you' };
  const { settings } = mergeCatalog({ ...DEFAULT_SETTINGS, models: [mine, ...DEFAULT_SETTINGS.models] }, modelCatalog(mkdtempSync(join(tmpdir(), 'codex-none-'))));
  assert.deepEqual(
    settings.models.map((m) => m.label),
    ['Opus 5.5', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5', 'Opus 4.7', 'GPT-5.5'],
  );
});
