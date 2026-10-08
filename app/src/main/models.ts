/**
 * The models each command-line tool offers. codex keeps its list, with each model's effort levels,
 * in `~/.codex/models_cache.json` and refreshes it itself, so a model OpenAI ships shows up here
 * once codex has seen it. claude keeps no such list, so its models are written down here.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EFFORTS, type Effort, type ModelEntry } from '../shared/types.ts';

/** Every claude model accepts low through max; measured on 2026-09-24 with claude 2.1.281. */
const CLAUDE_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const CLAUDE_MODELS: ModelEntry[] = [
  { id: 'claude-opus', harness: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', efforts: CLAUDE_EFFORTS, source: 'claude' },
  { id: 'claude-fable', harness: 'claude', model: 'claude-fable-5-1', label: 'Fable 5.1', efforts: CLAUDE_EFFORTS, source: 'claude' },
  { id: 'claude-sonnet', harness: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5', efforts: CLAUDE_EFFORTS, source: 'claude' },
  { id: 'claude-haiku', harness: 'claude', model: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: CLAUDE_EFFORTS, source: 'claude' },
];

interface CodexCacheModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  priority?: unknown;
  supported_reasoning_levels?: unknown;
}

/**
 * The models codex lists for your account, in codex's own order. Hidden entries (internal review
 * models, previews) stay out. An unreadable or unfamiliar file gives an empty list rather than an
 * error: the file is codex's, not a documented format, and the app still has your saved models.
 */
export function codexModels(codexHome = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')): ModelEntry[] {
  let raw: { models?: unknown };
  try {
    raw = JSON.parse(readFileSync(join(codexHome, 'models_cache.json'), 'utf8')) as { models?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(raw.models)) return [];
  const out: { entry: ModelEntry; priority: number }[] = [];
  for (const m of raw.models as (CodexCacheModel | null)[]) {
    if (m === null || typeof m !== 'object' || typeof m.slug !== 'string' || m.slug === '' || m.visibility !== 'list') continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? (m.supported_reasoning_levels as { effort?: unknown }[]) : [];
    const efforts = EFFORTS.filter((e) => levels.some((l) => l?.effort === e) && e !== 'minimal');
    const entry: ModelEntry = {
      id: `codex-${m.slug.replace(/[^a-z0-9]+/gi, '-')}`,
      harness: 'codex',
      model: m.slug,
      label: typeof m.display_name === 'string' && m.display_name !== '' ? m.display_name : m.slug,
      source: 'codex',
    };
    if (efforts.length > 0) entry.efforts = efforts;
    if (typeof m.description === 'string' && m.description !== '') entry.description = m.description;
    out.push({ entry, priority: typeof m.priority === 'number' ? m.priority : 1000 });
  }
  return out.sort((a, b) => a.priority - b.priority).map((o) => o.entry);
}

export function modelCatalog(codexHome?: string): ModelEntry[] {
  return [...CLAUDE_MODELS, ...codexModels(codexHome)];
}
