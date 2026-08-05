/**
 * Parse a `.toml` trial file into a `TrialSpec` — the one place experiment prose becomes the
 * fixed contract `runTrial` executes against.
 *
 * Two disciplines are borrowed straight from `src/config/load.ts`, because the failure modes are
 * the same failure modes even though the file is not the global config:
 *
 *   - A relative path INSIDE this file means "next to me" — resolved against the spec file's own
 *     directory, never against whatever directory the reader happened to run `army trial` from.
 *     `seed`, a brief's `file`, and the top-level `orders_file` all follow this rule.
 *   - A leading UTF-8 BOM is stripped before parsing, because the same Windows editors that write
 *     one at the head of `config.toml` write one here too, and `smol-toml` has no provision for it.
 *
 * ## Why an unknown `effort` or a malformed `check` THROWS and an unknown top-level key WARNS
 *
 * This file protects a number a reader is about to trust. An `efforts` list that silently dropped
 * an unrecognised value would run a four-arm experiment and label it five; a `check` this parser
 * could not fully validate would score every arm against a rule nobody actually wrote. Both are
 * indistinguishable from a working trial until someone reads the numbers wrong. An unrecognised
 * top-level key, by contrast, costs nothing but a moment's confusion — so it is a warning, and the
 * trial still runs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { REASONING_EFFORTS } from '../contracts/harness.ts';
import type { ReasoningEffort } from '../contracts/harness.ts';
import { CHECK_KINDS, CHECK_TYPES, TRIAL_MODES } from '../contracts/trial.ts';
import type { Check, CheckKind, CheckType, TrialArm, TrialMode, TrialSpec } from '../contracts/trial.ts';

export interface ParsedTrialSpec {
  spec: TrialSpec;
  warnings: string[];
}

// -------------------------------------------------------------------------------------------
// BOM — see `src/config/load.ts`'s `BOM` / `splitBom` for the full story. Not imported from
// there: that module keeps it private, and re-deriving four lines is cheaper than exporting a
// primitive whose only other caller would be this file.
// -------------------------------------------------------------------------------------------

const BOM = '﻿';

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

function isTable(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

function isStringArray(u: unknown): u is string[] {
  return Array.isArray(u) && u.every((x) => typeof x === 'string');
}

const BRIEF_LABEL_RE = /^[a-z0-9][a-z0-9-]*$/i;

// -------------------------------------------------------------------------------------------
// Briefs
// -------------------------------------------------------------------------------------------

/** A brief before it is crossed with an effort: a label and its resolved orders text. */
interface ResolvedBrief {
  label: string;
  orders: string;
}

/**
 * `orders` / `<fileKey>` -> the brief text, read synchronously when it came from a file.
 *
 * A brief carries no meaning without its text, so the text has to exist by the time the arms are
 * built — not lazily, the first time a worker is about to be spawned with it three hours into a
 * run. `fileKey` differs between the two call sites: the top-level implicit brief spells the
 * file field `orders_file`, a `[[briefs]]` entry spells it `file` — see the worked example in
 * `TRIAL_HELP`.
 */
function resolveOrders(
  raw: Record<string, unknown>,
  fileKey: 'file' | 'orders_file',
  specDir: string,
  where: string,
): string {
  const inline = raw['orders'];
  const filePath = raw[fileKey];
  const hasInline = typeof inline === 'string';
  const hasFile = typeof filePath === 'string';
  if (hasInline && hasFile) {
    throw new Error(`${where}: has both 'orders' and '${fileKey}' — exactly one is required`);
  }
  if (!hasInline && !hasFile) {
    throw new Error(`${where}: needs exactly one of 'orders' or '${fileKey}'`);
  }

  let text: string;
  if (hasInline) {
    text = inline as string;
  } else {
    const resolved = path.resolve(specDir, filePath as string);
    try {
      text = fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      throw new Error(
        `${where}: cannot read ${fileKey} ${JSON.stringify(filePath as string)} (${resolved}): ` +
          `${(e as Error).message}`,
      );
    }
  }

  if (text.trim() === '') {
    throw new Error(
      `${where}: the brief is empty — the whole premise of a trial is that the brief carries the ` +
        'thinking, so an empty brief is not a valid experimental condition',
    );
  }
  return text;
}

function parseBriefs(raw: unknown, specDir: string): ResolvedBrief[] {
  if (!Array.isArray(raw)) {
    throw new Error('briefs: expected an array of [[briefs]] tables');
  }
  if (raw.length === 0) {
    throw new Error('briefs: at least one [[briefs]] entry is required when the table is present');
  }
  return raw.map((entry, i) => {
    const where = `briefs[${i}]`;
    if (!isTable(entry)) throw new Error(`${where}: expected a table`);
    const label = entry['label'];
    if (typeof label !== 'string' || !BRIEF_LABEL_RE.test(label)) {
      throw new Error(
        `${where}.label: expected a label matching ${BRIEF_LABEL_RE.source}, got ${JSON.stringify(label)}`,
      );
    }
    const orders = resolveOrders(entry, 'file', specDir, `${where} (label ${JSON.stringify(label)})`);
    return { label, orders };
  });
}

// -------------------------------------------------------------------------------------------
// Efforts and arms
// -------------------------------------------------------------------------------------------

function parseEfforts(raw: unknown): ReasoningEffort[] {
  if (raw === undefined) return [...REASONING_EFFORTS];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`efforts: expected a non-empty array of ${REASONING_EFFORTS.join(', ')}`);
  }
  return raw.map((e) => {
    if (typeof e !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(e)) {
      throw new Error(
        `efforts: unknown effort ${JSON.stringify(e)} — expected one of ${REASONING_EFFORTS.join(', ')}`,
      );
    }
    return e as ReasoningEffort;
  });
}

/**
 * The cross-product, in EFFORT-order then BRIEF-order — never the order `efforts` happened to be
 * written in the file, so a spec author who wrote `efforts = ["xhigh", "minimal"]` still gets a
 * report that reads left-to-right cheapest-to-most-expensive.
 */
function buildArms(
  efforts: readonly ReasoningEffort[],
  briefs: readonly ResolvedBrief[],
  model: string,
): TrialArm[] {
  const requested = new Set(efforts);
  const orderedEfforts = REASONING_EFFORTS.filter((e) => requested.has(e));
  const multiBrief = briefs.length > 1;

  const arms: TrialArm[] = [];
  const seenIds = new Set<string>();
  for (const effort of orderedEfforts) {
    for (const brief of briefs) {
      const id = multiBrief ? `${effort}-${brief.label}` : effort;
      if (seenIds.has(id)) {
        throw new Error(`duplicate arm id ${JSON.stringify(id)}`);
      }
      seenIds.add(id);
      arms.push({ id, effort, model, orders: brief.orders, ordersLabel: brief.label });
    }
  }
  return arms;
}

// -------------------------------------------------------------------------------------------
// Checks
// -------------------------------------------------------------------------------------------

/** Fields legal on a `[[checks]]` table for each `type`, beyond the base `id`/`kind`/`type`/`why`. */
const TYPE_KEYS: Record<CheckType, readonly string[]> = {
  command: ['run', 'expect_exit', 'timeout_ms'],
  'files-changed': ['allow', 'require'],
  'file-content': ['path', 'contains', 'absent'],
  'no-tool-use': ['tool', 'matching'],
  committed: ['require_new_commit', 'require_clean'],
};

const BASE_CHECK_KEYS = ['id', 'kind', 'type', 'why'];

function parseCheck(entry: unknown, index: number, warnings: string[]): Check {
  const where = `checks[${index}]`;
  if (!isTable(entry)) throw new Error(`${where}: expected a table`);

  const idRaw = entry['id'];
  if (typeof idRaw !== 'string' || idRaw.trim() === '') {
    throw new Error(`${where}.id: expected a non-empty string, got ${JSON.stringify(idRaw)}`);
  }
  const id = idRaw;
  const named = `${where} (id ${JSON.stringify(id)})`;

  const kindRaw = entry['kind'];
  if (typeof kindRaw !== 'string' || !(CHECK_KINDS as readonly string[]).includes(kindRaw)) {
    throw new Error(`${named}.kind: expected one of ${CHECK_KINDS.join(', ')}, got ${JSON.stringify(kindRaw)}`);
  }
  const kind = kindRaw as CheckKind;

  const typeRaw = entry['type'];
  if (typeof typeRaw !== 'string' || !(CHECK_TYPES as readonly string[]).includes(typeRaw)) {
    throw new Error(`${named}.type: expected one of ${CHECK_TYPES.join(', ')}, got ${JSON.stringify(typeRaw)}`);
  }
  const type = typeRaw as CheckType;

  const whyRaw = entry['why'];
  if (whyRaw !== undefined && typeof whyRaw !== 'string') {
    throw new Error(`${named}.why: expected a string`);
  }
  const base = { id, kind, ...(typeof whyRaw === 'string' ? { why: whyRaw } : {}) };

  // Unknown keys are a WARNING, not a throw — a typo'd optional field should be visible, but the
  // check itself is still well formed.
  const allowedKeys = new Set([...BASE_CHECK_KEYS, ...TYPE_KEYS[type]]);
  for (const key of Object.keys(entry)) {
    if (!allowedKeys.has(key)) {
      warnings.push(`${named}: unknown key ${JSON.stringify(key)}`);
    }
  }

  switch (type) {
    case 'command': {
      const run = entry['run'];
      if (typeof run !== 'string' || run.trim() === '') {
        throw new Error(`${named}.run: expected a non-empty string`);
      }
      const expectExit = entry['expect_exit'];
      if (expectExit !== undefined && typeof expectExit !== 'number') {
        throw new Error(`${named}.expect_exit: expected a number`);
      }
      const timeoutMs = entry['timeout_ms'];
      if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
        throw new Error(`${named}.timeout_ms: expected a number`);
      }
      return {
        ...base,
        type: 'command',
        run,
        ...(expectExit !== undefined ? { expectExit } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case 'files-changed': {
      const allow = entry['allow'];
      if (allow !== undefined && !isStringArray(allow)) {
        throw new Error(`${named}.allow: expected an array of strings`);
      }
      const requireField = entry['require'];
      if (requireField !== undefined && !isStringArray(requireField)) {
        throw new Error(`${named}.require: expected an array of strings`);
      }
      return {
        ...base,
        type: 'files-changed',
        ...(allow !== undefined ? { allow } : {}),
        ...(requireField !== undefined ? { require: requireField } : {}),
      };
    }
    case 'file-content': {
      const p = entry['path'];
      if (typeof p !== 'string' || p.trim() === '') {
        throw new Error(`${named}.path: expected a non-empty string`);
      }
      const contains = entry['contains'];
      const absent = entry['absent'];
      if (contains === undefined && absent === undefined) {
        throw new Error(`${named}: needs one of 'contains' or 'absent'`);
      }
      if (contains !== undefined && typeof contains !== 'string') {
        throw new Error(`${named}.contains: expected a string`);
      }
      if (absent !== undefined && typeof absent !== 'boolean') {
        throw new Error(`${named}.absent: expected a boolean`);
      }
      return {
        ...base,
        type: 'file-content',
        path: p,
        ...(contains !== undefined ? { contains } : {}),
        ...(absent !== undefined ? { absent } : {}),
      };
    }
    case 'no-tool-use': {
      const tool = entry['tool'];
      if (typeof tool !== 'string' || tool.trim() === '') {
        throw new Error(`${named}.tool: expected a non-empty string`);
      }
      const matching = entry['matching'];
      if (matching !== undefined && typeof matching !== 'string') {
        throw new Error(`${named}.matching: expected a string`);
      }
      return {
        ...base,
        type: 'no-tool-use',
        tool,
        ...(matching !== undefined ? { matching } : {}),
      };
    }
    case 'committed': {
      const requireNewCommit = entry['require_new_commit'];
      if (requireNewCommit !== undefined && typeof requireNewCommit !== 'boolean') {
        throw new Error(`${named}.require_new_commit: expected a boolean`);
      }
      const requireClean = entry['require_clean'];
      if (requireClean !== undefined && typeof requireClean !== 'boolean') {
        throw new Error(`${named}.require_clean: expected a boolean`);
      }
      return {
        ...base,
        type: 'committed',
        ...(requireNewCommit !== undefined ? { requireNewCommit } : {}),
        ...(requireClean !== undefined ? { requireClean } : {}),
      };
    }
  }
}

function parseChecks(raw: unknown, warnings: string[]): Check[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error('checks: expected an array of [[checks]] tables');
  }
  const checks: Check[] = [];
  const seenIds = new Set<string>();
  raw.forEach((entry, i) => {
    const check = parseCheck(entry, i, warnings);
    if (seenIds.has(check.id)) {
      throw new Error(`checks[${i}]: duplicate check id ${JSON.stringify(check.id)}`);
    }
    seenIds.add(check.id);
    checks.push(check);
  });
  return checks;
}

// -------------------------------------------------------------------------------------------
// The top-level document
// -------------------------------------------------------------------------------------------

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'title',
  'seed',
  'model',
  'mode',
  'efforts',
  'orders',
  'orders_file',
  'briefs',
  'checks',
]);

const DEFAULT_MODEL = 'claude-sonnet-5';

export function parseTrialSpec(text: string, specPath: string, outDir: string): ParsedTrialSpec {
  const warnings: string[] = [];
  const specDir = path.dirname(path.resolve(specPath));

  let data: Record<string, unknown>;
  try {
    data = parseToml(stripBom(text)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${specPath} is not valid TOML: ${(e as Error).message}`);
  }

  const titleRaw = data['title'];
  if (typeof titleRaw !== 'string' || titleRaw.trim() === '') {
    throw new Error('title: expected a non-empty string');
  }
  const title = titleRaw;

  const seedRaw = data['seed'];
  if (typeof seedRaw !== 'string' || seedRaw.trim() === '') {
    throw new Error('seed: a directory is required, e.g. seed = "./seed"');
  }
  const seed = path.resolve(specDir, seedRaw);

  const modelRaw = data['model'];
  let model = DEFAULT_MODEL;
  if (modelRaw !== undefined) {
    if (typeof modelRaw !== 'string' || modelRaw.trim() === '') {
      warnings.push(`model: expected a non-empty string, got ${JSON.stringify(modelRaw)} — using ${DEFAULT_MODEL}`);
    } else {
      model = modelRaw;
    }
  }

  const modeRaw = data['mode'];
  let mode: TrialMode = 'concurrent';
  if (modeRaw !== undefined) {
    if (typeof modeRaw !== 'string' || !(TRIAL_MODES as readonly string[]).includes(modeRaw)) {
      throw new Error(`mode: expected one of ${TRIAL_MODES.join(', ')}, got ${JSON.stringify(modeRaw)}`);
    }
    mode = modeRaw as TrialMode;
  }

  const efforts = parseEfforts(data['efforts']);

  const briefs: ResolvedBrief[] =
    data['briefs'] === undefined
      ? [{ label: 'default', orders: resolveOrders(data, 'orders_file', specDir, 'orders') }]
      : parseBriefs(data['briefs'], specDir);

  const arms = buildArms(efforts, briefs, model);
  const checks = parseChecks(data['checks'], warnings);

  for (const key of Object.keys(data)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`unknown top-level key ${JSON.stringify(key)}`);
    }
  }

  const spec: TrialSpec = { title, seed, arms, checks, mode, outDir };
  return { spec, warnings };
}
