import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  // ranks
  RANK_ORDER,
  RANK_SENIORITY,
  RANK_GLYPH,
  RANK_ABBREV,
  ROLES,
  SUBSTRATE,
  WRITES_FILES,
  ROLE_WRITES_FILES,
  writesFiles,
  isStrictlyJuniorTo,
  formatUnit,
  formatUnitWithGlyph,
  // delivery
  RUNGS,
  RUNG_MEANING,
  RUNG_LABEL,
  effectiveRung,
  allowsTaskDependencies,
  // report
  SUMMARY_MAX_CHARS,
  MAX_FINDINGS,
  MAX_ARTIFACTS,
  FINDING_MESSAGE_MAX_CHARS,
  SHORT_STRING_MAX_CHARS,
  codePointLength,
  REPORT_STATUSES,
  VERDICT_VALUES,
  SEVERITIES,
  ARTIFACT_KINDS,
  REPORT_REQUIRED_KEYS,
  REPORT_OPTIONAL_KEYS,
  VERDICT_REQUIRED_KEYS,
  VERDICT_OPTIONAL_KEYS,
  FINDING_REQUIRED_KEYS,
  FINDING_OPTIONAL_KEYS,
  ARTIFACT_REQUIRED_KEYS,
  ARTIFACT_OPTIONAL_KEYS,
  REPORT_SCHEMA_PATH,
  VERDICT_SCHEMA_PATH,
  validateReport,
  validateVerdict,
  // archive
  TASK_STATUSES,
  SIGNAL_KINDS,
  CAMPAIGN_DB_FILENAME,
  MIRRORS_DIRNAME,
  STREAM_JSONL_FILENAME,
  // harness
  SOLDIER_EVENT_TYPES,
  HARNESS_IDS,
  // worktree
  RELEASE_OUTCOMES,
  WORKTREE_PROVIDER_IDS,
  armyBranch,
} from '../src/contracts/index.ts';

import type { Rank, Report, Role, Rung, Verdict } from '../src/contracts/index.ts';

// The loadout table itself, so the claims a contract file makes about a role's tools are checked
// against the rules this process actually puts on a command line — not against a retyped list.
import { ROLE_ALLOW, toolNameOf } from '../src/command/permissions.ts';

// Used only to prove a multi-line string value survived surgery unchanged.
import { parse as parseTomlForTest } from 'smol-toml';

// config loading — src/config/{paths,load}.ts
import { armyHome, configPath } from '../src/config/paths.ts';
import {
  PROJECTS_SECTION,
  clampCeiling,
  loadConfig,
  missingConfigWarning,
  parseConfig,
  readProjectCeiling,
  upsertProjectEntry,
  writeProjectCeiling,
} from '../src/config/load.ts';

// The truth-file names live with the paths, not with the row shapes. Imported rather than
// retyped so that renaming one breaks the layout guard instead of silently weakening it.
import {
  AGENT_JSON_FILENAME,
  CAMPAIGN_JSON_FILENAME,
  SIGNALS_JSONL_FILENAME,
  TASKS_JSONL_FILENAME,
} from '../src/archive/paths.ts';

// The real mirror path builder — the guard below compares the docs to what this produces.
import { mirrorPathFor } from '../src/delivery/durability.ts';

// The ONE read-only import left from the setup module. It is not a pinning test: this is the
// config FORMAT the setup unit writes to disk, and being able to parse it is a real integration
// property. Every other cross-import has gone as `enlist.ts` and `checks.ts` collapsed onto
// this module — a test comparing a function to a wrapper that delegates to it asserts nothing.
import { defaultConfigToml } from '../src/setup/init.ts';

// -----------------------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------------------

type JsonSchema = Record<string, any>;

const reportSchema: JsonSchema = JSON.parse(readFileSync(REPORT_SCHEMA_PATH, 'utf8'));
const verdictSchema: JsonSchema = JSON.parse(readFileSync(VERDICT_SCHEMA_PATH, 'utf8'));

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** True iff the node's `type` admits null — `"type": ["string", "null"]`. */
function isNullable(node: JsonSchema): boolean {
  return Array.isArray(node.type) && node.type.includes('null');
}

/**
 * The strict-mode contract, asserted at one object level.
 *
 * `required` MUST list EVERY key in `properties` — that is OpenAI strict structured outputs,
 * which `codex --output-schema` uses, and a property missing from it is an HTTP 400
 * (`invalid_json_schema: 'required' is required to be supplied and to be an array including
 * every key in properties`), not a lenient schema. TypeScript-optional keys express
 * themselves by being NULLABLE instead, which is exactly the shape `isAbsent` already accepts.
 */
function assertStrictObject(
  node: JsonSchema,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const all = [...required, ...optional];
  assert.equal(node.type, 'object', `${label}: type`);
  assert.equal(node.additionalProperties, false, `${label}: additionalProperties must be false`);
  assert.deepEqual(
    sorted(Object.keys(node.properties)),
    sorted(all),
    `${label}: properties must be exactly the TS key manifest`,
  );
  assert.deepEqual(
    sorted(node.required),
    sorted(all),
    `${label}: strict mode — required must list EVERY property, optional ones included`,
  );
  for (const key of required) {
    assert.equal(
      isNullable(node.properties[key]),
      false,
      `${label}.${key}: required in TS, so it must NOT be nullable`,
    );
  }
  for (const key of optional) {
    assert.equal(
      isNullable(node.properties[key]),
      true,
      `${label}.${key}: optional in TS, so strict mode requires it to be nullable`,
    );
  }
}

/** Every object node in a schema document, so a structural rule can be applied everywhere. */
function objectNodes(node: unknown, path: string, out: Array<[string, JsonSchema]> = []): Array<[string, JsonSchema]> {
  if (Array.isArray(node)) {
    node.forEach((child, i) => objectNodes(child, `${path}[${i}]`, out));
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const schema = node as JsonSchema;
  if (schema.type === 'object' || schema.properties !== undefined) out.push([path, schema]);
  for (const [key, child] of Object.entries(schema)) objectNodes(child, `${path}.${key}`, out);
  return out;
}

function validReport(): Report {
  return {
    status: 'done',
    summary: 'Rate limiter added to the auth router; suite green.',
    findings: [{ severity: 'note', message: 'Config default is 100 rpm.', file: 'src/auth.ts', line: 12 }],
    artifacts: [{ kind: 'diff', ref: 'diff.patch' }],
    branch: armyBranch('take-hill-4'),
    costUsd: 0.42,
  };
}

function validVerdict(): Verdict {
  return {
    verdict: 'pass',
    summary: 'Branch satisfies the original orders; no blockers.',
    findings: [],
    testsRun: true,
    testCommand: 'pnpm test',
  };
}

function findings(n: number) {
  return Array.from({ length: n }, (_unused, i) => ({
    severity: 'minor' as const,
    message: `finding ${i}`,
  }));
}

// -----------------------------------------------------------------------------------------
// ranks
// -----------------------------------------------------------------------------------------

test('rank maps are total over every rank', () => {
  assert.equal(RANK_ORDER.length, 5);
  for (const rank of RANK_ORDER) {
    assert.equal(typeof RANK_SENIORITY[rank], 'number');
    assert.equal(typeof RANK_GLYPH[rank], 'string');
    assert.equal(typeof RANK_ABBREV[rank], 'string');
    assert.equal(typeof WRITES_FILES[rank], 'boolean');
    assert.ok(SUBSTRATE[rank] === 'process' || SUBSTRATE[rank] === 'subagent');
  }
  assert.deepEqual(
    RANK_ORDER.map((r) => RANK_SENIORITY[r]),
    [0, 1, 2, 3, 4],
    'seniority must follow declaration order',
  );
  assert.deepEqual(RANK_ORDER.map((r) => RANK_GLYPH[r]), ['☆', '◆', '◇', '▪', '·']);
});

test('isStrictlyJuniorTo agrees with the seniority order for every rank pair', () => {
  for (const child of RANK_ORDER) {
    for (const parent of RANK_ORDER) {
      const expected = RANK_ORDER.indexOf(child) > RANK_ORDER.indexOf(parent);
      assert.equal(
        isStrictlyJuniorTo(child, parent),
        expected,
        `${child} junior to ${parent} should be ${expected}`,
      );
    }
  }
});

test('a rank is never junior to itself — no peer spawning', () => {
  for (const rank of RANK_ORDER) {
    assert.equal(isStrictlyJuniorTo(rank, rank), false, `${rank} must not spawn its own rank`);
  }
});

test('rank skipping is legal: a GENERAL may detach a CAPTAIN directly', () => {
  assert.equal(isStrictlyJuniorTo('CAPTAIN', 'GENERAL'), true);
  assert.equal(isStrictlyJuniorTo('GENERAL', 'CAPTAIN'), false);
});

test('PRIVATE is the floor — it can spawn nothing', () => {
  for (const child of RANK_ORDER) {
    assert.equal(isStrictlyJuniorTo(child, 'PRIVATE'), false);
  }
});

test('officers never edit files; CAPTAIN and below do', () => {
  assert.equal(WRITES_FILES.GENERAL, false);
  assert.equal(WRITES_FILES.COLONEL, false);
  assert.equal(WRITES_FILES.CAPTAIN, true);
  assert.equal(WRITES_FILES.SERGEANT, true);
  assert.equal(WRITES_FILES.PRIVATE, true);

  const officers: Rank[] = RANK_ORDER.filter((r) => !WRITES_FILES[r]);
  assert.deepEqual(officers, ['GENERAL', 'COLONEL']);

  // The context guard and the safety property are the same property: every writing rank sits
  // strictly below every non-writing one.
  for (const writer of RANK_ORDER.filter((r) => WRITES_FILES[r])) {
    for (const officer of officers) {
      assert.equal(isStrictlyJuniorTo(writer, officer), true);
    }
  }
});

test('ROLE_WRITES_FILES says HOLDS AN EDITING TOOL, not "cannot change a byte"', () => {
  assert.equal(ROLE_WRITES_FILES.ENGINEER, true);
  assert.equal(ROLE_WRITES_FILES.SCOUT, false);
  assert.equal(ROLE_WRITES_FILES.SENTRY, false);
  assert.equal(ROLE_WRITES_FILES.COMMANDER, false);
  // The one that reads like a bug and is not. An INSPECTOR runs the suite and mutation-tests in a
  // WRITABLE tree — bytes change. It is `false` here because it holds no Edit/Write tool, and that
  // is what keeps the review gate independent of the branch it is reviewing. Handing an Inspector
  // an editing tool so this flag could read `true` would be the actual defect.
  assert.equal(ROLE_WRITES_FILES.INSPECTOR, false);
  for (const role of ROLES) assert.equal(typeof ROLE_WRITES_FILES[role], 'boolean');
});

test('writesFiles is rank AND role — the intersection, over all 25 pairs', () => {
  for (const rank of RANK_ORDER) {
    for (const role of ROLES) {
      assert.equal(
        writesFiles(rank, role),
        WRITES_FILES[rank] && ROLE_WRITES_FILES[role],
        `${rank}·${role}`,
      );
    }
  }
  // Rank narrows and never widens: the only pairs that write are an ENGINEER at a writing rank.
  const writers = RANK_ORDER.flatMap((rank) =>
    ROLES.filter((role) => writesFiles(rank, role)).map((role) => `${rank}·${role}`),
  );
  assert.deepEqual(writers, ['CAPTAIN·ENGINEER', 'SERGEANT·ENGINEER', 'PRIVATE·ENGINEER']);
  // The officer ranks write nothing whatever role they are handed — including the role whose
  // entire purpose is writing. This is the claim the README makes in its opening paragraph.
  for (const officer of ['GENERAL', 'COLONEL'] as const) {
    for (const role of ROLES) assert.equal(writesFiles(officer, role), false, `${officer}·${role}`);
  }
});

test('substrate split: commanding ranks are processes, the fan-out layer is subagents', () => {
  assert.deepEqual(
    RANK_ORDER.map((r) => SUBSTRATE[r]),
    ['process', 'process', 'process', 'subagent', 'subagent'],
  );
});

test('formatUnit renders the rank·role · task label', () => {
  assert.equal(formatUnit('CAPTAIN', 'ENGINEER', 'take-hill-4'), 'CPT·ENGINEER · take-hill-4');
  assert.equal(formatUnit('PRIVATE', 'SCOUT'), 'PVT·SCOUT');
  assert.equal(formatUnit('GENERAL', 'ENGINEER', ''), 'GEN·ENGINEER');
  assert.equal(
    formatUnitWithGlyph('CAPTAIN', 'INSPECTOR', 'take-hill-4'),
    '◇ CPT·INSPECTOR · take-hill-4',
  );
  for (const role of ROLES) {
    assert.ok(formatUnit('SERGEANT', role, 't').startsWith('SGT·'));
  }
});

// -----------------------------------------------------------------------------------------
// delivery
// -----------------------------------------------------------------------------------------

test('effectiveRung clamps to the ceiling for every pair and never exceeds it', () => {
  for (const requested of RUNGS) {
    for (const ceiling of RUNGS) {
      const got = effectiveRung(requested, ceiling);
      assert.equal(got, Math.min(requested, ceiling), `requested=${requested} ceiling=${ceiling}`);
      assert.ok(got <= ceiling, 'must never exceed the ceiling');
      assert.ok(got <= requested, 'must never exceed what was requested');
    }
  }
});

test('effectiveRung: requested above the ceiling is clamped down, not honoured', () => {
  assert.equal(effectiveRung(3, 0), 0, 'merge requested on a commit-only repo');
  assert.equal(effectiveRung(3, 2), 2, 'merge requested on a PR-only repo');
  assert.equal(effectiveRung(2, 1), 1);
  assert.equal(effectiveRung(1, 0), 0);
});

test('effectiveRung: at or below the ceiling passes through — a campaign may go lower', () => {
  assert.equal(effectiveRung(3, 3), 3);
  assert.equal(effectiveRung(0, 3), 0);
  assert.equal(effectiveRung(1, 3), 1);
  assert.equal(effectiveRung(2, 3), 2);
});

test('effectiveRung is idempotent — re-clamping cannot ratchet up', () => {
  for (const requested of RUNGS) {
    for (const ceiling of RUNGS) {
      const once = effectiveRung(requested, ceiling);
      assert.equal(effectiveRung(once, ceiling), once);
    }
  }
});

test('every rung has a meaning and a label; only rung >= 1 permits task dependencies', () => {
  for (const rung of RUNGS) {
    assert.ok(RUNG_MEANING[rung].length > 0);
    assert.ok(RUNG_LABEL[rung].length > 0);
  }
  assert.equal(allowsTaskDependencies(0), false);
  for (const rung of [1, 2, 3] as Rung[]) {
    assert.equal(allowsTaskDependencies(rung), true);
  }
});

// -----------------------------------------------------------------------------------------
// report
// -----------------------------------------------------------------------------------------

test('validateReport accepts a fully populated report', () => {
  const result = validateReport(validReport());
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, validReport());
});

test('validateReport accepts the minimal report — required keys only', () => {
  const result = validateReport({ status: 'blocked', summary: 'x', findings: [], artifacts: [] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.branch, undefined);
    assert.equal(result.value.costUsd, undefined);
  }
});

test('validateReport accepts every status and every severity/artifact kind', () => {
  for (const status of REPORT_STATUSES) {
    assert.equal(validateReport({ ...validReport(), status }).ok, true, status);
  }
  for (const severity of SEVERITIES) {
    const r = { ...validReport(), findings: [{ severity, message: 'm' }] };
    assert.equal(validateReport(r).ok, true, severity);
  }
  for (const kind of ARTIFACT_KINDS) {
    const r = { ...validReport(), artifacts: [{ kind, ref: 'x' }] };
    assert.equal(validateReport(r).ok, true, kind);
  }
});

test('validateReport rejects a summary over the cap, and accepts one exactly at it', () => {
  const atCap = { ...validReport(), summary: 'a'.repeat(SUMMARY_MAX_CHARS) };
  assert.equal(validateReport(atCap).ok, true);

  const overCap = { ...validReport(), summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1) };
  const result = validateReport(overCap);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => e.startsWith('summary:') && e.includes(String(SUMMARY_MAX_CHARS))),
      `expected a summary cap error, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test('caps count Unicode code points, the same unit JSON Schema maxLength counts', () => {
  assert.equal(codePointLength('😀'), 1, 'one code point');
  assert.equal('😀'.length, 2, 'two UTF-16 code units — the trap');
  assert.equal(codePointLength(''), 0);
  assert.equal(codePointLength('abc'), 3);

  // 280 code points of emoji is 560 UTF-16 units. The schema calls it valid, so we must too:
  // otherwise the cap silently means 140 characters for anyone writing in emoji, and roughly
  // half its stated length for CJK text outside the BMP.
  const emojiAtCap = '😀'.repeat(SUMMARY_MAX_CHARS);
  assert.equal(emojiAtCap.length, SUMMARY_MAX_CHARS * 2);
  assert.equal(validateReport({ ...validReport(), summary: emojiAtCap }).ok, true);

  const emojiOverCap = '😀'.repeat(SUMMARY_MAX_CHARS + 1);
  const rejected = validateReport({ ...validReport(), summary: emojiOverCap });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.ok(
      rejected.errors.some((e) => e.includes(`got ${SUMMARY_MAX_CHARS + 1}`)),
      `the count must be reported in code points, got ${JSON.stringify(rejected.errors)}`,
    );
  }

  // Same unit everywhere a cap is applied.
  const findingAtCap = {
    ...validReport(),
    findings: [{ severity: 'note', message: '😀'.repeat(FINDING_MESSAGE_MAX_CHARS) }],
  };
  assert.equal(validateReport(findingAtCap).ok, true);
  assert.equal(
    validateVerdict({ ...validVerdict(), summary: '😀'.repeat(SUMMARY_MAX_CHARS) }).ok,
    true,
  );
});

test('validateReport rejects more than MAX_FINDINGS, and accepts exactly MAX_FINDINGS', () => {
  assert.equal(validateReport({ ...validReport(), findings: findings(MAX_FINDINGS) }).ok, true);

  const result = validateReport({ ...validReport(), findings: findings(MAX_FINDINGS + 1) });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => e.startsWith('findings:') && e.includes(String(MAX_FINDINGS))),
      `expected a findings cap error, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test('validateReport rejects malformed input', () => {
  const cases: Array<[string, unknown]> = [
    ['not an object', 'done'],
    ['null', null],
    ['array', []],
    ['missing status', { summary: 'x', findings: [], artifacts: [] }],
    ['missing summary', { status: 'done', findings: [], artifacts: [] }],
    ['missing findings', { status: 'done', summary: 'x', artifacts: [] }],
    ['missing artifacts', { status: 'done', summary: 'x', findings: [] }],
    ['bad status', { status: 'DONE', summary: 'x', findings: [], artifacts: [] }],
    ['empty summary', { status: 'done', summary: '', findings: [], artifacts: [] }],
    ['findings not an array', { status: 'done', summary: 'x', findings: {}, artifacts: [] }],
    [
      'unknown property',
      { status: 'done', summary: 'x', findings: [], artifacts: [], notes: 'sneaky' },
    ],
    [
      'bad finding severity',
      { status: 'done', summary: 'x', findings: [{ severity: 'huge', message: 'm' }], artifacts: [] },
    ],
    [
      'unknown finding property',
      {
        status: 'done',
        summary: 'x',
        findings: [{ severity: 'note', message: 'm', column: 4 }],
        artifacts: [],
      },
    ],
    [
      'finding message over cap',
      {
        status: 'done',
        summary: 'x',
        findings: [{ severity: 'note', message: 'm'.repeat(FINDING_MESSAGE_MAX_CHARS + 1) }],
        artifacts: [],
      },
    ],
    [
      'finding line below 1',
      {
        status: 'done',
        summary: 'x',
        findings: [{ severity: 'note', message: 'm', line: 0 }],
        artifacts: [],
      },
    ],
    ['artifact missing ref', { status: 'done', summary: 'x', findings: [], artifacts: [{ kind: 'diff' }] }],
    ['bad artifact kind', { status: 'done', summary: 'x', findings: [], artifacts: [{ kind: 'zip', ref: 'a' }] }],
    ['too many artifacts', {
      status: 'done',
      summary: 'x',
      findings: [],
      artifacts: Array.from({ length: MAX_ARTIFACTS + 1 }, () => ({ kind: 'file', ref: 'a' })),
    }],
    ['negative cost', { status: 'done', summary: 'x', findings: [], artifacts: [], costUsd: -1 }],
    ['non-numeric cost', { status: 'done', summary: 'x', findings: [], artifacts: [], costUsd: '1' }],
    ['branch over cap', {
      status: 'done',
      summary: 'x',
      findings: [],
      artifacts: [],
      branch: 'b'.repeat(SHORT_STRING_MAX_CHARS + 1),
    }],
  ];

  for (const [label, input] of cases) {
    const result = validateReport(input);
    assert.equal(result.ok, false, `expected rejection: ${label}`);
    if (!result.ok) assert.ok(result.errors.length > 0, `${label}: must explain itself`);
  }
});

test('validateReport treats explicit null on an optional field as absent', () => {
  const result = validateReport({
    status: 'done',
    summary: 'x',
    findings: [],
    artifacts: [],
    branch: null,
    costUsd: null,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { status: 'done', summary: 'x', findings: [], artifacts: [] });
});

test('validateVerdict accepts pass and fail, and requires testsRun', () => {
  assert.equal(validateVerdict(validVerdict()).ok, true);
  for (const verdict of VERDICT_VALUES) {
    assert.equal(validateVerdict({ ...validVerdict(), verdict }).ok, true, verdict);
  }
  assert.equal(
    validateVerdict({ verdict: 'fail', summary: 'blocker found', findings: [], testsRun: false }).ok,
    true,
  );
});

test('validateVerdict rejects malformed input', () => {
  const cases: Array<[string, unknown]> = [
    ['not an object', 42],
    ['bad verdict', { verdict: 'maybe', summary: 'x', findings: [], testsRun: true }],
    ['missing testsRun', { verdict: 'pass', summary: 'x', findings: [] }],
    ['testsRun not boolean', { verdict: 'pass', summary: 'x', findings: [], testsRun: 'yes' }],
    ['summary over cap', {
      verdict: 'pass',
      summary: 's'.repeat(SUMMARY_MAX_CHARS + 1),
      findings: [],
      testsRun: true,
    }],
    ['too many findings', {
      verdict: 'fail',
      summary: 'x',
      findings: findings(MAX_FINDINGS + 1),
      testsRun: true,
    }],
    ['unknown property', {
      verdict: 'pass',
      summary: 'x',
      findings: [],
      testsRun: true,
      status: 'done',
    }],
  ];
  for (const [label, input] of cases) {
    const result = validateVerdict(input);
    assert.equal(result.ok, false, `expected rejection: ${label}`);
    if (!result.ok) assert.ok(result.errors.length > 0, `${label}: must explain itself`);
  }
});

// -----------------------------------------------------------------------------------------
// schema / constant agreement — the two must not drift
// -----------------------------------------------------------------------------------------

// -----------------------------------------------------------------------------------------
// SCHEMA VALIDITY TO ITS CONSUMERS — the two blockers, guarded offline
//
// The drift tests below compare schema values to TS constants. That is necessary and not
// sufficient: it once passed 31/31 while BOTH schema files were rejected outright by BOTH
// CLIs, because "agrees with the constants" and "is a schema codex and claude will accept"
// are different properties. These four tests assert the second one, deterministically and
// for free. The live test at the bottom of this file is the periodic proof that they still
// describe reality.
// -----------------------------------------------------------------------------------------

test('BLOCKER GUARD: no schema file declares $schema — claude cannot resolve the meta-schema', () => {
  // `claude --json-schema` rejects the file before it makes any request:
  //   "not a valid JSON Schema: no schema with key or ref
  //    https://json-schema.org/draft/2020-12/schema"
  // The files are still draft 2020-12; they simply must not SAY so.
  for (const [label, schema] of [
    ['report.v1.json', reportSchema],
    ['verdict.v1.json', verdictSchema],
  ] as Array<[string, JsonSchema]>) {
    assert.equal(
      '$schema' in schema,
      false,
      `${label}: must not declare $schema — claude's validator cannot resolve the URI and ` +
        'rejects the whole file',
    );
    // Same reasoning: an unresolvable $id changes how internal $refs are resolved and buys
    // nothing, so it is not reintroduced either.
    assert.equal('$id' in schema, false, `${label}: must not declare $id`);
  }
});

test('BLOCKER GUARD: strict mode — every property is required at EVERY level, including $defs', () => {
  // `codex --output-schema` uses OpenAI strict structured outputs:
  //   HTTP 400 invalid_json_schema: 'required' is required to be supplied and to be an array
  //   including every key in properties. Missing 'file'
  // The walk is generic so a NEW object added anywhere in either file is covered too.
  for (const [label, schema] of [
    ['report.v1.json', reportSchema],
    ['verdict.v1.json', verdictSchema],
  ] as Array<[string, JsonSchema]>) {
    const nodes = objectNodes(schema, label);
    assert.ok(nodes.length >= 2, `${label}: expected the root and at least one $defs object`);
    for (const [path, node] of nodes) {
      assert.equal(node.additionalProperties, false, `${path}: additionalProperties must be false`);
      assert.ok(Array.isArray(node.required), `${path}: required must be present and an array`);
      assert.deepEqual(
        sorted(node.required),
        sorted(Object.keys(node.properties ?? {})),
        `${path}: strict mode — 'required' must include EVERY key in 'properties'`,
      );
    }
  }
});

test('report.v1.json satisfies strict mode against the TS key manifests', () => {
  assertStrictObject(reportSchema, REPORT_REQUIRED_KEYS, REPORT_OPTIONAL_KEYS, 'report');
  assertStrictObject(
    reportSchema.$defs.finding,
    FINDING_REQUIRED_KEYS,
    FINDING_OPTIONAL_KEYS,
    'report.$defs.finding',
  );
  assertStrictObject(
    reportSchema.$defs.artifactRef,
    ARTIFACT_REQUIRED_KEYS,
    ARTIFACT_OPTIONAL_KEYS,
    'report.$defs.artifactRef',
  );
});

test('verdict.v1.json satisfies strict mode against the TS key manifests', () => {
  assertStrictObject(verdictSchema, VERDICT_REQUIRED_KEYS, VERDICT_OPTIONAL_KEYS, 'verdict');
  assertStrictObject(
    verdictSchema.$defs.finding,
    FINDING_REQUIRED_KEYS,
    FINDING_OPTIONAL_KEYS,
    'verdict.$defs.finding',
  );
});

test('a strict-mode instance — nulls where TS says optional — is accepted by the validators', () => {
  // This is literally what codex and claude emitted for these schemas. If the validator ever
  // stops accepting it, the context guard silently starts rejecting every real return.
  const fromCli = {
    status: 'done',
    summary: 'schema smoke test',
    findings: [],
    artifacts: [{ kind: 'file', ref: 'README.md', note: null }],
    branch: null,
    costUsd: null,
  };
  const reported = validateReport(fromCli);
  assert.equal(reported.ok, true, reported.ok ? '' : JSON.stringify(reported.errors));
  if (reported.ok) {
    assert.equal('branch' in reported.value, false, 'null must normalise to absent, not null');
    assert.equal('costUsd' in reported.value, false);
  }

  const judged = validateVerdict({
    verdict: 'pass',
    summary: 'schema smoke test',
    findings: [{ severity: 'note', message: 'm', file: null, line: null }],
    testsRun: false,
    testCommand: null,
  });
  assert.equal(judged.ok, true, judged.ok ? '' : JSON.stringify(judged.errors));
  if (judged.ok) {
    assert.deepEqual(judged.value.findings, [{ severity: 'note', message: 'm' }]);
    assert.equal('testCommand' in judged.value, false);
  }
});

test('schema caps equal the TS constants', () => {
  assert.equal(reportSchema.properties.summary.maxLength, SUMMARY_MAX_CHARS);
  assert.equal(reportSchema.properties.findings.maxItems, MAX_FINDINGS);
  assert.equal(reportSchema.properties.artifacts.maxItems, MAX_ARTIFACTS);
  assert.equal(reportSchema.properties.branch.maxLength, SHORT_STRING_MAX_CHARS);
  assert.equal(reportSchema.$defs.finding.properties.message.maxLength, FINDING_MESSAGE_MAX_CHARS);
  assert.equal(reportSchema.$defs.finding.properties.file.maxLength, SHORT_STRING_MAX_CHARS);
  assert.equal(reportSchema.$defs.artifactRef.properties.ref.maxLength, SHORT_STRING_MAX_CHARS);
  assert.equal(reportSchema.$defs.artifactRef.properties.note.maxLength, SHORT_STRING_MAX_CHARS);

  assert.equal(verdictSchema.properties.summary.maxLength, SUMMARY_MAX_CHARS);
  assert.equal(verdictSchema.properties.findings.maxItems, MAX_FINDINGS);
  assert.equal(verdictSchema.properties.testCommand.maxLength, SHORT_STRING_MAX_CHARS);
  assert.equal(verdictSchema.$defs.finding.properties.message.maxLength, FINDING_MESSAGE_MAX_CHARS);
});

test('schema enums equal the TS value domains', () => {
  assert.deepEqual(reportSchema.properties.status.enum, [...REPORT_STATUSES]);
  assert.deepEqual(reportSchema.$defs.finding.properties.severity.enum, [...SEVERITIES]);
  assert.deepEqual(reportSchema.$defs.artifactRef.properties.kind.enum, [...ARTIFACT_KINDS]);
  assert.deepEqual(verdictSchema.properties.verdict.enum, [...VERDICT_VALUES]);
  assert.deepEqual(verdictSchema.$defs.finding.properties.severity.enum, [...SEVERITIES]);
});

test('schema and validator agree on non-empty strings and the line floor', () => {
  assert.equal(reportSchema.properties.summary.minLength, 1);
  assert.equal(reportSchema.$defs.finding.properties.message.minLength, 1);
  // nullable, but still an integer >= 1 when present
  assert.deepEqual(reportSchema.$defs.finding.properties.line.type, ['integer', 'null']);
  assert.equal(reportSchema.$defs.finding.properties.line.minimum, 1);
  assert.deepEqual(reportSchema.properties.costUsd.type, ['number', 'null']);
  assert.equal(reportSchema.properties.costUsd.minimum, 0);
  assert.equal(verdictSchema.properties.summary.minLength, 1);
  assert.equal(verdictSchema.properties.testsRun.type, 'boolean');
});

test('nullability did not weaken a single cap', () => {
  // Making a property nullable is a change to `type` and nothing else. If a future edit
  // "simplifies" a nullable property by dropping its cap, the guard is gone.
  const capped: Array<[string, JsonSchema, number]> = [
    ['report.branch', reportSchema.properties.branch, SHORT_STRING_MAX_CHARS],
    ['report.finding.file', reportSchema.$defs.finding.properties.file, SHORT_STRING_MAX_CHARS],
    ['report.artifactRef.note', reportSchema.$defs.artifactRef.properties.note, SHORT_STRING_MAX_CHARS],
    ['verdict.testCommand', verdictSchema.properties.testCommand, SHORT_STRING_MAX_CHARS],
    ['verdict.finding.file', verdictSchema.$defs.finding.properties.file, SHORT_STRING_MAX_CHARS],
  ];
  for (const [label, node, max] of capped) {
    assert.equal(isNullable(node), true, `${label}: expected nullable`);
    assert.equal(node.maxLength, max, `${label}: cap must survive nullability`);
    assert.equal(node.minLength, 1, `${label}: non-empty-when-present must survive nullability`);
  }
});

test('the two schemas share one finding definition', () => {
  assert.deepEqual(reportSchema.$defs.finding, verdictSchema.$defs.finding);
});

test('a maximal instance built to the schema caps validates', () => {
  const maximal = {
    status: 'failed',
    summary: 's'.repeat(SUMMARY_MAX_CHARS),
    findings: Array.from({ length: MAX_FINDINGS }, () => ({
      severity: 'blocker',
      message: 'm'.repeat(FINDING_MESSAGE_MAX_CHARS),
      file: 'f'.repeat(SHORT_STRING_MAX_CHARS),
      line: 1,
    })),
    artifacts: Array.from({ length: MAX_ARTIFACTS }, () => ({
      kind: 'log',
      ref: 'r'.repeat(SHORT_STRING_MAX_CHARS),
      note: 'n'.repeat(SHORT_STRING_MAX_CHARS),
    })),
    branch: 'b'.repeat(SHORT_STRING_MAX_CHARS),
    costUsd: 0,
  };
  const result = validateReport(maximal);
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));
});

// -----------------------------------------------------------------------------------------
// misc contract invariants
// -----------------------------------------------------------------------------------------

test('archive and harness value domains are pinned, member for member', () => {
  assert.deepEqual([...TASK_STATUSES], ['queued', 'in_flight', 'done', 'failed', 'blocked']);
  assert.deepEqual([...SIGNAL_KINDS], ['order', 'report', 'query', 'answer', 'broadcast', 'status']);
  assert.deepEqual([...HARNESS_IDS], ['claude', 'codex']);
  assert.deepEqual([...WORKTREE_PROVIDER_IDS], ['treehouse', 'cold']);
  // `release` reports which of four things happened, and only one of them means the tree came
  // back. Pinned member for member because a caller BRANCHES on this — `src/command/campaign.ts`
  // settles the lease as `not-held` on any of the three no-ops — so a member silently added or
  // renamed would fall into the wrong branch rather than failing to compile.
  assert.deepEqual([...RELEASE_OUTCOMES], ['released', 'stale-lease', 'no-record', 'missing-tree']);
  // Every normalised event type is representable; `unknown` exists so no line is ever dropped.
  assert.ok(SOLDIER_EVENT_TYPES.includes('unknown'));
  assert.ok(SOLDIER_EVENT_TYPES.includes('subagent_text'));
  assert.equal(new Set(SOLDIER_EVENT_TYPES).size, SOLDIER_EVENT_TYPES.length);
});

test('army branches are namespaced', () => {
  assert.equal(armyBranch('take-hill-4'), 'army/take-hill-4');
});

// -----------------------------------------------------------------------------------------
// CONFIG LOADING — src/config/{paths,load}.ts
//
// The security property under test is negative — "a ceiling can only come from the user's own
// global file" — so most of these assert what does NOT happen.
// -----------------------------------------------------------------------------------------

test('armyHome honours AGENTIC_ARMY_HOME', () => {
  assert.equal(armyHome({ AGENTIC_ARMY_HOME: '/tmp/army-x' }), path.resolve('/tmp/army-x'));
  assert.equal(armyHome({ AGENTIC_ARMY_HOME: '   ' }), path.join(os.homedir(), '.agentic-army'));
  assert.equal(armyHome({}), path.join(os.homedir(), '.agentic-army'));
  // Defaults to the live environment when none is passed.
  assert.equal(armyHome(), armyHome(process.env));
  assert.equal(configPath('/tmp/army-x'), path.join('/tmp/army-x', 'config.toml'));
});

test('archiveRoot defaults to the config file’s own directory', () => {
  const file = '/tmp/army-home/config.toml';
  assert.equal(parseConfig('', file).config.archiveRoot, '/tmp/army-home');
  assert.equal(
    parseConfig('archive_root = "/mnt/big-disk/army"', file).config.archiveRoot,
    '/mnt/big-disk/army',
  );
  // Relative means "next to the config", not "next to wherever army was run from".
  assert.equal(parseConfig('archive_root = "spool"', file).config.archiveRoot, '/tmp/army-home/spool');
  // Wrong type falls back rather than throwing.
  const bad = parseConfig('archive_root = 3', file);
  assert.equal(bad.config.archiveRoot, '/tmp/army-home');
  assert.ok(bad.warnings.some((w) => w.startsWith('archive_root:')));
});

test('snake_case TOML maps onto camelCase TypeScript', () => {
  const { config } = parseConfig(
    ['version = 1', 'archive_root = "/a/b"', '[delivery]', 'default_ceiling = 2'].join('\n'),
    '/tmp/h/config.toml',
  );
  assert.equal(config.version, 1);
  assert.equal(config.archiveRoot, '/a/b');
  assert.equal(config.delivery.defaultCeiling, 2);
});

test('clampCeiling: out of range fails closed to 0 and never clamps upward', () => {
  // IN RANGE — honoured exactly.
  for (const [input, expected] of [[0, 0], [1, 1], [2, 2], [3, 3]] as Array<[number, Rung]>) {
    assert.equal(clampCeiling(input), expected);
  }

  // IN-RANGE FRACTION — floored, which only ever moves DOWN the ladder.
  assert.equal(clampCeiling(2.7), 2);
  assert.equal(clampCeiling(0.9), 0);
  assert.equal(clampCeiling(2.999), 2);
  assert.equal(clampCeiling(-0), 0);
  assert.ok(Object.is(clampCeiling(-0), 0), '-0 must normalise to +0');

  // OUT OF RANGE — 0, not the nearest legal rung. A typo must never buy merge rights.
  for (const input of [4, 9, 33, 3000, 3.5, -1, -0.5, -100, Infinity, -Infinity, NaN]) {
    assert.equal(clampCeiling(input), 0, `${String(input)} is out of range and must read as 0`);
  }

  // WRONG TYPE — 0.
  for (const input of ['0', '3', 'three', true, false, null, undefined, {}, [], [3], new Date()]) {
    assert.equal(clampCeiling(input), 0, `${JSON.stringify(input) ?? String(input)} must read as 0`);
  }

  // The property, stated once: nothing may ever read higher than it is written.
  for (const input of [0, 1, 2, 3, 3.5, 4, 9, 3000, -1, NaN, Infinity]) {
    const out = clampCeiling(input);
    assert.ok(out <= 3, 'never above the top rung');
    assert.ok(!(Number.isFinite(input) && input >= 0 && out > input), 'never above what was written');
  }
});

test('ceilings fail closed on every malformed input', () => {
  const cases: Array<[string, Rung]> = [
    ['{ ceiling = 3 }', 3],
    ['{ ceiling = 0 }', 0],
    ['{ ceiling = 2 }', 2],
    ['{ ceiling = 4 }', 0], // out of range: 0, NOT the nearest legal rung
    ['{ ceiling = 9 }', 0],
    ['{ ceiling = 3000 }', 0],
    ['{ ceiling = 3.5 }', 0],
    ['{ ceiling = -1 }', 0],
    ['{ ceiling = inf }', 0], // TOML really does have `inf` and `nan`
    ['{ ceiling = nan }', 0],
    ['{ ceiling = 2.7 }', 2], // in range: floored, never rounded up
    ['{ ceiling = "3" }', 0], // a quoted number is not a number
    ['{ ceiling = true }', 0],
    ['{ ceiling = "merge" }', 0],
    ['{ ceiling = 1979-05-27 }', 0], // a date is not a rung
    ['{ }', 0], // table present, ceiling missing
    ['"not a table"', 0],
  ];
  for (const [literal, expected] of cases) {
    const toml = `[projects]\n"/repo/x" = ${literal}\n`;
    const { config } = parseConfig(toml, '/tmp/h/config.toml');
    assert.equal(
      config.projects['/repo/x']?.ceiling,
      expected,
      `${literal} must resolve to ${expected}`,
    );
  }

  // An out-of-range value must SAY it failed closed, not claim it clamped to something legal.
  const { warnings } = parseConfig('[projects]\n"/repo/x" = { ceiling = 9 }\n', '/tmp/h/config.toml');
  assert.ok(
    warnings.some((w) => w.includes('outside 0..3') && w.includes('failing closed to 0')),
    `expected an out-of-range warning, got ${JSON.stringify(warnings)}`,
  );

  // default_ceiling obeys the same rule.
  assert.equal(
    parseConfig('[delivery]\ndefault_ceiling = 9\n', '/tmp/h/config.toml').config.delivery.defaultCeiling,
    0,
  );
});

test('a project with no entry simply has no policy — absence is the fail-closed case', () => {
  const { config } = parseConfig('[projects]\n"/repo/known" = { ceiling = 3 }\n', '/tmp/h/config.toml');
  assert.equal(config.projects['/repo/known']?.ceiling, 3);
  assert.equal(config.projects['/repo/unknown'], undefined);
  // The absent -> 0 step is projectCeiling() in src/delivery/ladder.ts; what this module
  // guarantees is that a project the user never enlisted is never in the map at all.
});

test('non-absolute project keys are ignored, not resolved against cwd', () => {
  const { config, warnings } = parseConfig(
    '[projects]\n"relative/path" = { ceiling = 3 }\n',
    '/tmp/h/config.toml',
  );
  assert.deepEqual(Object.keys(config.projects), []);
  assert.ok(warnings.some((w) => w.includes('ABSOLUTE')));
});

test('the config that `army init` actually writes parses cleanly', () => {
  // Pins this parser to the file format the setup module ships. If either side changes the
  // key names, this fails rather than silently reading nothing and failing closed forever.
  const { config, warnings } = parseConfig(defaultConfigToml(), '/tmp/h/config.toml');
  assert.deepEqual(warnings, [], `the shipped default config must load without warnings`);
  assert.equal(config.version, 1);
  assert.equal(config.delivery.defaultCeiling, 0, 'the shipped default must be commit-only');
  assert.deepEqual(config.projects, {}, 'a fresh config enlists nothing');
  assert.equal(config.archiveRoot, '/tmp/h', 'archive_root is commented out, so it defaults');
  assert.deepEqual(
    config.dispatch.rules.map((r) => r.use[0]?.harness),
    ['claude', 'codex'],
    'the static vendor split: Engineers on claude, Inspectors on codex',
  );
  assert.equal(config.dispatch.rules[1]?.use[0]?.effort, 'high');
});

test('dispatch rules survive junk without taking a vendor offline', () => {
  const toml = [
    '[[dispatch.rules]]',
    'when = "Any change to any file."',
    'use = [ { harness = "claude", effort = "ludicrous" } ]',
    'why = "Engineers build on Claude."',
    '',
    '[[dispatch.rules]]',
    'when = "junk"',
    'use = [ { harness = "gemini" } ]',
    'why = "unknown vendor"',
  ].join('\n');
  const { config, warnings } = parseConfig(toml, '/tmp/h/config.toml');
  // Bad effort: keep the rule, drop the field, fall back to the adapter default.
  assert.equal(config.dispatch.rules.length, 1);
  assert.equal(config.dispatch.rules[0]?.use[0]?.harness, 'claude');
  assert.equal(config.dispatch.rules[0]?.use[0]?.effort, undefined);
  // Unknown harness: the rule is unusable, so it goes.
  assert.ok(warnings.some((w) => w.includes('effort')));
  assert.ok(warnings.some((w) => w.includes('harness')));
});

test('unparseable TOML throws rather than silently zeroing every ceiling', () => {
  assert.throws(
    () => parseConfig('this is not = = toml', '/tmp/h/config.toml'),
    /not valid TOML/,
  );
});

test('upsertProjectEntry preserves every comment', () => {
  const original = defaultConfigToml();
  const updated = upsertProjectEntry(original, '/repo/alpha', 2);

  // Every comment line survives, byte for byte.
  const comments = original.split('\n').filter((l) => l.trimStart().startsWith('#'));
  assert.ok(comments.length > 20, 'the default config is mostly prose; that is the point');
  for (const line of comments) {
    assert.ok(updated.includes(line), `comment lost on write: ${line}`);
  }
  assert.equal(readProjectCeiling(updated, '/repo/alpha'), 2);

  // Replacing an existing entry does not duplicate it.
  const lowered = upsertProjectEntry(updated, '/repo/alpha', 1);
  const hits = lowered.split('\n').filter((l) => l.includes('"/repo/alpha"'));
  assert.equal(hits.length, 1);
  assert.equal(readProjectCeiling(lowered, '/repo/alpha'), 1);
});

test('loadConfig on a fresh home: no file, no projects, no policy', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'army-cfg-'));
  try {
    const loaded = await loadConfig({ home });
    assert.equal(loaded.exists, false);
    assert.equal(loaded.path, path.join(home, 'config.toml'));
    assert.deepEqual(loaded.config.projects, {});
    assert.equal(loaded.config.delivery.defaultCeiling, 0);
    assert.equal(loaded.config.archiveRoot, home);
    assert.ok(loaded.warnings.some((w) => w.includes('does not exist yet')));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// ===============================================================================================
// THE "NO CONFIG YET" WARNING — how `src/config/**` names a command without importing upward
//
// It used to say ``run `army init``` verbatim, and it is printed to readers running
// `npx agentic-army` and `node src/cli.ts`, for whom `army` is not on PATH.
//
// `invokedAs()` lives in `src/setup/**`, which sits ABOVE `src/config/**` and already imports it
// (`src/setup/enlist.ts`). Importing it back would make the dependency run both ways, so the
// invocation arrives as an optional parameter — and its ABSENCE is a third state with a job:
// `src/command/campaign.ts` copies this warning verbatim into a `config:` signal in the archive,
// where it is read back days later from a different shell. A command prefix baked into a durable
// record is a claim about a context that has expired. The property below is what both spellings
// share: NEITHER of them ever prints a command this reader cannot run.
// ===============================================================================================

test('the missing-config warning routes when it can, and invents nothing when it cannot', () => {
  const file = '/home/u/.agentic-army/config.toml';

  const persisted = missingConfigWarning(file);
  const live = missingConfigWarning(file, 'node src/cli.ts');

  for (const [label, warning] of [['persisted', persisted], ['live', live]] as const) {
    assert.ok(warning.includes(file), `${label}: does not name the file`);
    assert.match(warning, /ceiling 0/, `${label}: does not say what it costs`);
    assert.ok(warning.includes('init'), `${label}: does not name the step that resolves it`);
    // The defect, in the only form it can take here.
    assert.doesNotMatch(
      warning,
      /(^|[\s`])army\s+(init|doctor|enlist|campaign|view|rebuild)\b/,
      `${label}: hardcodes a bare \`army …\`:\n${warning}`,
    );
  }

  // With a caller who knows, it is a line you can paste…
  assert.match(live, /run `node src\/cli\.ts init`/);
  // …and without one, it names the SUBCOMMAND and asserts nothing about how to reach it.
  assert.doesNotMatch(persisted, /node src\/cli\.ts|npx|npm run/);
  assert.match(persisted, /`init`/);
});

test('loadConfig hands the invocation down to that warning rather than guessing', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'army-cfg-'));
  try {
    const guessed = await loadConfig({ home });
    const told = await loadConfig({ home, self: 'npx agentic-army' });
    // The seam is real: the same call with and without `self` differs in exactly this way.
    assert.notDeepEqual(guessed.warnings, told.warnings, 'the `self` seam does nothing');
    assert.ok(told.warnings.some((w) => w.includes('run `npx agentic-army init`')));
    assert.ok(guessed.warnings.every((w) => !w.includes('army init')));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('writeProjectCeiling round-trips through loadConfig and keeps comments', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'army-cfg-'));
  try {
    await fs.writeFile(path.join(home, 'config.toml'), defaultConfigToml(), 'utf8');

    const first = await writeProjectCeiling('/repo/gamma', 2, { home });
    assert.equal(first.previous, null);
    const afterWrite = await loadConfig({ home });
    assert.equal(afterWrite.exists, true);
    assert.equal(afterWrite.config.projects['/repo/gamma']?.ceiling, 2);
    assert.deepEqual(afterWrite.warnings, []);

    const second = await writeProjectCeiling('/repo/gamma', 0, { home });
    assert.equal(second.previous, 2);
    const afterLower = await loadConfig({ home });
    assert.equal(afterLower.config.projects['/repo/gamma']?.ceiling, 0);

    const text = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
    assert.ok(text.includes('# SECURITY — read this before you edit a number below.'));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('SECURITY: a config inside the repo is never consulted for a ceiling', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'army-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'army-repo-'));
  const previousCwd = process.cwd();
  try {
    // The global config says 0 for this repo…
    await fs.writeFile(
      path.join(home, 'config.toml'),
      `[projects]\n${JSON.stringify(repo)} = { ceiling = 0 }\n`,
      'utf8',
    );
    // …while the repo ships every file name a careless loader might pick up, all claiming 3.
    for (const name of ['config.toml', '.agentic-army.toml', 'agentic-army.toml', 'army.toml']) {
      await fs.writeFile(
        path.join(repo, name),
        `[projects]\n${JSON.stringify(repo)} = { ceiling = 3 }\n`,
        'utf8',
      );
    }
    process.chdir(repo);

    const loaded = await loadConfig({ home });
    assert.equal(loaded.config.projects[repo]?.ceiling, 0, 'the repo must not raise its own ceiling');
    assert.equal(loaded.path, path.join(home, 'config.toml'));
    assert.equal(loaded.path.startsWith(repo), false, 'nothing inside the repo may be read');
  } finally {
    process.chdir(previousCwd);
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------------------
// WINDOWS — CRLF. The first Windows risk we have actually hit.
// -----------------------------------------------------------------------------------------

function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/** The precise form of "leave every other byte alone": exactly one line differs. */
function assertOnlyInsertedLine(before: string, after: string, entrySubstring: string): void {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assert.equal(afterLines.length, beforeLines.length + 1, 'exactly one line should be added');
  const inserted = afterLines.findIndex((l) => l.includes(entrySubstring));
  assert.notEqual(inserted, -1, 'the new entry should be present');
  const withoutInserted = afterLines.slice(0, inserted).concat(afterLines.slice(inserted + 1));
  assert.deepEqual(withoutInserted, beforeLines, 'no other line may change, not even its ending');
}

test('CRLF: parse, upsert, round-trip and comments all survive (the Windows blocker)', () => {
  const crlf = toCrlf(defaultConfigToml());
  assert.ok(crlf.includes('[projects]\r\n'), 'fixture really is CRLF');

  // parse
  const { config, warnings } = parseConfig(crlf, '/tmp/h/config.toml');
  assert.deepEqual(warnings, []);
  assert.equal(config.delivery.defaultCeiling, 0);

  // upsert — the bug was here: the header was never matched, so a SECOND [projects] table
  // was appended and the file stopped parsing entirely.
  const updated = upsertProjectEntry(crlf, '/repo/win', 2);
  const headers = updated.split('\n').filter((l) => l.trim() === '[projects]');
  assert.equal(headers.length, 1, 'must not append a second [projects] table');

  // the edit is exactly one inserted line, and it is CRLF like its neighbours
  assertOnlyInsertedLine(crlf, updated, '"/repo/win"');
  const lfCount = (updated.match(/\n/g) ?? []).length;
  const crlfCount = (updated.match(/\r\n/g) ?? []).length;
  assert.equal(lfCount, crlfCount, 'no lone LF may be introduced into a CRLF file');

  // round-trip — this is what the write guard checks before it will touch the disk
  assert.equal(readProjectCeiling(updated, '/repo/win'), 2);
  assert.equal(parseConfig(updated, '/tmp/h/config.toml').config.projects['/repo/win']?.ceiling, 2);

  // comments survive byte for byte
  for (const line of crlf.split('\n').filter((l) => l.trimStart().startsWith('#'))) {
    assert.ok(updated.includes(line), `comment lost on a CRLF write: ${JSON.stringify(line)}`);
  }

  // replacing an existing CRLF entry keeps it CRLF and does not duplicate it
  const lowered = upsertProjectEntry(updated, '/repo/win', 0);
  assert.equal(lowered.split('\n').filter((l) => l.includes('"/repo/win"')).length, 1);
  assert.equal((lowered.match(/\n/g) ?? []).length, (lowered.match(/\r\n/g) ?? []).length);
  assert.equal(readProjectCeiling(lowered, '/repo/win'), 0);
});

test('CRLF: mixed line endings keep their mixture — untouched lines are not rewritten', () => {
  // Exactly what a hand edit on Windows produces: part of the file converted, part not.
  // (The final element is left alone — it is the empty string after the trailing newline, and
  // a bare CR at EOF is not valid TOML in any dialect.)
  const lines = defaultConfigToml().split('\n');
  const mixed = lines
    .map((l, i) => (i % 2 === 0 && i < lines.length - 1 ? `${l}\r` : l))
    .join('\n');
  assert.ok(mixed.includes('\r\n'), 'fixture is mixed');
  assert.ok(/[^\r]\n/.test(mixed), 'fixture really does contain lone LF too');

  const updated = upsertProjectEntry(mixed, '/repo/mixed', 3);
  assert.equal(updated.split('\n').filter((l) => l.trim() === '[projects]').length, 1);
  assertOnlyInsertedLine(mixed, updated, '"/repo/mixed"');
  assert.equal(readProjectCeiling(updated, '/repo/mixed'), 3);
  assert.equal(parseConfig(updated, '/tmp/h/config.toml').warnings.length, 0);
});

test('CRLF: a file with no trailing newline still gets a well-formed line break', () => {
  const toml = '[projects]\r\n"/repo/a" = { ceiling = 0 }';
  const updated = upsertProjectEntry(toml, '/repo/b', 1);
  assert.equal(readProjectCeiling(updated, '/repo/a'), 0);
  assert.equal(readProjectCeiling(updated, '/repo/b'), 1);
  assert.equal((updated.match(/\n/g) ?? []).length, (updated.match(/\r\n/g) ?? []).length);
});

test('CRLF: writeProjectCeiling works end to end on a CRLF config on disk', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'army-crlf-'));
  try {
    const file = path.join(home, 'config.toml');
    await fs.writeFile(file, toCrlf(defaultConfigToml()), 'utf8');

    // Before the fix this threw: the appended second [projects] table made the file
    // unparseable, so the round-trip guard refused the write — permanently.
    const written = await writeProjectCeiling('/repo/windows-user', 2, { home });
    assert.equal(written.previous, null);
    assert.equal(written.ceiling, 2);

    const loaded = await loadConfig({ home });
    assert.equal(loaded.config.projects['/repo/windows-user']?.ceiling, 2);
    assert.deepEqual(loaded.warnings, []);

    const lowered = await writeProjectCeiling('/repo/windows-user', 0, { home });
    assert.equal(lowered.previous, 2);
    assert.equal((await loadConfig({ home })).config.projects['/repo/windows-user']?.ceiling, 0);

    const text = await fs.readFile(file, 'utf8');
    assert.equal((text.match(/\n/g) ?? []).length, (text.match(/\r\n/g) ?? []).length);
    assert.ok(text.includes('# SECURITY — read this before you edit a number below.\r'));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------------------
// BOM — what a Windows editor writes by default, so this is a Windows-path defect
// -----------------------------------------------------------------------------------------

const BOM = '﻿';

test('BOM: a config with a byte-order mark parses, upserts and keeps its BOM', () => {
  const withBom = BOM + defaultConfigToml();

  // parse — `fs.readFile(…, 'utf8')` hands the BOM through as a character and TOML rejects it
  const { config, warnings } = parseConfig(withBom, '/tmp/h/config.toml');
  assert.deepEqual(warnings, []);
  assert.equal(config.delivery.defaultCeiling, 0);

  // upsert — one [projects] table, and the BOM is still the very first character
  const updated = upsertProjectEntry(withBom, '/repo/bom', 2);
  assert.equal(updated.startsWith(BOM), true, 'the BOM must be preserved, not silently dropped');
  assert.equal(updated.indexOf(BOM), 0, 'and it must not appear anywhere else');
  assert.equal(updated.split(BOM).length - 1, 1);
  assert.equal(updated.split('\n').filter((l) => l.trim() === '[projects]').length, 1);

  // round-trip
  assert.equal(readProjectCeiling(updated, '/repo/bom'), 2);
  assert.equal(parseConfig(updated, '/tmp/h/config.toml').config.projects['/repo/bom']?.ceiling, 2);
});

test('BOM: a BOM on the very line holding the header does not hide it', () => {
  // The nastiest arrangement: no preamble, so the BOM sits immediately before `[projects]`.
  const toml = `${BOM}[projects]\n"/repo/a" = { ceiling = 1 }\n`;
  const updated = upsertProjectEntry(toml, '/repo/b', 2);
  assert.equal(updated.split('\n').filter((l) => l.trim() === '[projects]').length, 1);
  assert.equal(readProjectCeiling(updated, '/repo/a'), 1);
  assert.equal(readProjectCeiling(updated, '/repo/b'), 2);
});

test('BOM + CRLF together — the realistic Windows file', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'army-bom-'));
  try {
    await fs.writeFile(
      path.join(home, 'config.toml'),
      BOM + toCrlf(defaultConfigToml()),
      'utf8',
    );
    await writeProjectCeiling('/repo/notepad', 2, { home });
    const loaded = await loadConfig({ home });
    assert.equal(loaded.config.projects['/repo/notepad']?.ceiling, 2);
    assert.deepEqual(loaded.warnings, []);

    const text = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
    assert.equal(text.startsWith(BOM), true);
    assert.equal((text.match(/\n/g) ?? []).length, (text.match(/\r\n/g) ?? []).length);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------------------
// Header spellings TOML allows but nobody writes on purpose
// -----------------------------------------------------------------------------------------

/**
 * Every legal spelling of the `[projects]` header, each verified against smol-toml below.
 *
 * This list has grown once per bug: `\r`, then whitespace and the quoted forms, then a trailing
 * comment — which broke `army enlist` outright. It is enumerated here so the next widening of
 * the parser has somewhere to be proved rather than assumed.
 */
const HEADER_SPELLINGS = [
  '[projects]',
  '[ projects ]',
  '[\tprojects\t]',
  '  [projects]',
  '["projects"]',
  "['projects']",
  '[ "projects" ]',
  '[projects] # repos I have enlisted',
  '[projects]  # a comment containing ] and # and [projects] itself',
  '["projects"] # quoted key plus a trailing comment',
  '[ projects ]\t# tab, then a comment',
  '["pro\\u006Aects"]', // a basic-string key whose escape decodes to `projects`
];

/** A line that opens the real `projects` table, however it is spelled. */
function isProjectsHeaderLine(line: string): boolean {
  const bare = line.replace(/\r$/, '').replace(/\s*#.*$/, '').trim();
  return /^\[\s*(?:projects|"projects"|'projects'|"pro\\u006Aects")\s*\]$/.test(bare);
}

test('every legal header spelling is real TOML — the fixtures are not made up', () => {
  for (const header of HEADER_SPELLINGS) {
    const parsed = parseTomlForTest(`${header}\n"/repo/a" = { ceiling = 1 }\n`) as Record<
      string,
      Record<string, { ceiling: number }>
    >;
    assert.equal(
      parsed['projects']?.['/repo/a']?.ceiling,
      1,
      `${header} must really parse to the projects table`,
    );
  }
});

test('the [projects] header is found in every spelling × line ending × BOM, insert and replace', () => {
  const BOM_ = '﻿';
  const framings: Array<[string, (t: string) => string]> = [
    ['LF', (t) => t],
    ['CRLF', (t) => toCrlf(t)],
    ['BOM+CRLF', (t) => BOM_ + toCrlf(t)],
    ['BOM+LF', (t) => BOM_ + t],
  ];

  for (const header of HEADER_SPELLINGS) {
    for (const [framingName, frame] of framings) {
      const where = `${header}  [${framingName}]`;
      const toml = frame(`version = 1\n\n${header}\n"/repo/a" = { ceiling = 1 }\n`);

      // INSERT
      const inserted = upsertProjectEntry(toml, '/repo/b', 2);
      assert.equal(
        inserted.split('\n').filter(isProjectsHeaderLine).length,
        1,
        `${where}: must not append a second [projects] table`,
      );
      assert.equal(readProjectCeiling(inserted, '/repo/a'), 1, `${where}: existing entry lost`);
      assert.equal(readProjectCeiling(inserted, '/repo/b'), 2, `${where}: new entry not added`);
      assert.deepEqual(parseConfig(inserted, '/tmp/h/config.toml').warnings, [], `${where}`);

      // REPLACE
      const replaced = upsertProjectEntry(inserted, '/repo/a', 0);
      assert.equal(readProjectCeiling(replaced, '/repo/a'), 0, `${where}: replace failed`);
      assert.equal(
        replaced.split('\n').filter((l) => l.includes('"/repo/a"')).length,
        1,
        `${where}: replace duplicated the entry`,
      );

      // framing survives
      if (framingName.startsWith('BOM')) {
        assert.equal(replaced.startsWith(BOM_), true, `${where}: BOM lost`);
        assert.equal(replaced.split(BOM_).length - 1, 1, `${where}: BOM duplicated`);
      }
      if (framingName.includes('CRLF')) {
        assert.equal(
          (replaced.match(/\n/g) ?? []).length,
          (replaced.match(/\r\n/g) ?? []).length,
          `${where}: a lone LF was introduced`,
        );
      }
      // the header line itself is never rewritten
      assert.ok(replaced.includes(header), `${where}: the header line was modified`);
    }
  }
});

test('decoy headers are not mistaken for the projects table', () => {
  // Each of these is a DIFFERENT table. Treating one as ours would write a ceiling into
  // somebody else's section, which parses fine and is silently wrong — the worst outcome here.
  const decoys = ['[projects_archive]', '[a.projects]', '[projectsx]', '[[projects]]'];

  for (const decoy of decoys) {
    const toml = `${decoy}\nfoo = 1\n`;
    const updated = upsertProjectEntry(toml, '/repo/x', 2);

    // the decoy table keeps its own contents, untouched
    assert.ok(updated.includes(`${decoy}\nfoo = 1`), `${decoy}: the decoy section was modified`);
    // and a real [projects] section was added instead of reusing it
    assert.equal(updated.split('\n').filter(isProjectsHeaderLine).length, 1, `${decoy}`);
  }

  // For the three that are genuinely separate tables the result must still parse and be right.
  for (const decoy of ['[projects_archive]', '[a.projects]', '[projectsx]']) {
    const updated = upsertProjectEntry(`${decoy}\nfoo = 1\n`, '/repo/x', 2);
    const { config, warnings } = parseConfig(updated, '/tmp/h/config.toml');
    assert.equal(config.projects['/repo/x']?.ceiling, 2, `${decoy}: entry landed in the wrong table`);
    assert.deepEqual(warnings, [], `${decoy}`);
  }
});

test('the dotted entry spelling is recognised rather than duplicated', () => {
  // `"/repo/a".ceiling = 1` is legal TOML and means the same as the inline table. Appending a
  // second definition of the same key makes the file unparseable and every future write refuse.
  const toml = '[projects]\n"/repo/a".ceiling = 1\n';
  const replaced = upsertProjectEntry(toml, '/repo/a', 3);
  assert.equal(readProjectCeiling(replaced, '/repo/a'), 3);
  assert.equal(replaced.split('\n').filter((l) => l.includes('"/repo/a"')).length, 1);
  assert.ok(replaced.includes('"/repo/a".ceiling = 3'), 'the author’s dotted spelling is kept');

  // A path carrying other subkeys must not be converted into an inline table, which would
  // collide with the surviving subkey.
  const withSubkeys = '[projects]\n"/repo/b".note = "hands off"\n';
  const added = upsertProjectEntry(withSubkeys, '/repo/b', 2);
  const { config, warnings } = parseConfig(added, '/tmp/h/config.toml');
  assert.equal(config.projects['/repo/b']?.ceiling, 2);
  assert.deepEqual(warnings, []);
  assert.ok(added.includes('"/repo/b".note = "hands off"'), 'the unrelated subkey survives');
});

test('a header-less config that uses top-level dotted keys is refused, not corrupted', () => {
  // `projects."/repo/a" = { … }` with no [projects] table is legal. Appending one would
  // redefine it; the old code produced a file whose only symptom was a TOML error.
  assert.throws(
    () => upsertProjectEntry('projects."/repo/a" = { ceiling = 1 }\n', '/repo/b', 2),
    /top-level dotted key/,
  );
});

// -----------------------------------------------------------------------------------------
// TOML string awareness — a header inside a string value is not a header
// -----------------------------------------------------------------------------------------

test('a [projects] header inside a multi-line string is never treated as a table header', () => {
  for (const quote of ['"""', "'''"]) {
    const toml = [
      `notes = ${quote}`,
      '[projects]',
      '"/inside/the/string" = { ceiling = 3 }',
      quote,
      '',
      '[projects]',
      '"/real/repo" = { ceiling = 0 }',
      '',
    ].join('\n');

    // The real table is the target, not the first thing that looks like a header.
    const updated = upsertProjectEntry(toml, '/real/repo', 1);
    assert.equal(readProjectCeiling(updated, '/real/repo'), 1, `${quote}: real entry not updated`);
    assert.equal(
      updated.includes(`${quote}\n[projects]\n"/inside/the/string" = { ceiling = 3 }\n${quote}`),
      true,
      `${quote}: the string value must be byte-identical`,
    );

    // A key that only *appears* inside the string is a NEW entry in the real table, never an
    // in-place rewrite of somebody else's data.
    const added = upsertProjectEntry(toml, '/inside/the/string', 3);
    assert.equal(
      added.split('\n').filter((l) => l.includes('"/inside/the/string"')).length,
      2,
      `${quote}: one line inside the string, one real entry`,
    );
    const parsed = parseConfig(added, '/tmp/h/config.toml').config;
    assert.equal(parsed.projects['/inside/the/string']?.ceiling, 3);
    assert.equal(parsed.projects['/real/repo']?.ceiling, 0);
    // and the string value itself still says what it always said
    const data = parseTomlForTest(added);
    assert.ok(String(data['notes']).includes('[projects]'));
  }
});

test('quotes inside comments and single-line strings do not open phantom strings', () => {
  const toml = [
    '# a comment with a stray \'\'\' and """ in it',
    'title = "he said \\"[projects]\\" loudly"',
    // one unbalanced apostrophe inside a basic string: a scanner that did not understand
    // single-line basic strings would think a literal string opened here and swallow the
    // real [projects] header below.
    'note = "it isn\'t balanced"',
    "literal = 'C:\\Users\\army'",
    '',
    '[projects]',
    '"/repo/quoted" = { ceiling = 0 }',
    '',
  ].join('\n');
  const updated = upsertProjectEntry(toml, '/repo/quoted', 2);
  assert.equal(readProjectCeiling(updated, '/repo/quoted'), 2);
  assert.equal(updated.split('\n').filter((l) => l.trim() === '[projects]').length, 1);
});

// -----------------------------------------------------------------------------------------
// HONEST WORDING — the config prose this module owns
//
// `test/doctor.test.ts` runs the same patterns over the setup unit's files. This module is not
// in that list, and the property should not depend on being on someone else's list: the text
// emitted by PROJECTS_SECTION lands in the user's config and is read at the exact moment
// somebody decides how much to trust the number under it.
// -----------------------------------------------------------------------------------------

test('PROJECTS_SECTION says only what is true about raising a ceiling', () => {
  const falseClaims: Array<[string, RegExp]> = [
    ['worker can never pass the TTY test', /can never satisfy the TTY test/i],
    ['pipe on both ends, therefore cannot', /pipe on both ends[^.]*can never/i],
    ['nothing non-interactive can raise', /never satisfy the TTY test however/i],
    ['raising is always a file edit', /Raising a ceiling is a deliberate human edit to (?:this|config)/i],
    ['escalation path unreachable', /escalation path is\s+\*?\s*deliberately not reachable/i],
  ];

  // The emitted config text, and the module's own prose — a grep for the overclaim must return
  // nothing, including from a doc comment quoting it as a counter-example.
  const moduleText = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'config', 'load.ts'),
    'utf8',
  );
  for (const [label, pattern] of falseClaims) {
    assert.doesNotMatch(PROJECTS_SECTION, pattern, `PROJECTS_SECTION still claims: ${label}`);
    assert.doesNotMatch(moduleText, pattern, `src/config/load.ts still claims: ${label}`);
  }

  // And it must state what is actually true, not merely omit the false part.
  assert.match(PROJECTS_SECTION, /terminal/i, 'name the terminal route');
  assert.match(PROJECTS_SECTION, /edit of this file|edit this file/i, 'name the file-edit route');
  assert.match(
    PROJECTS_SECTION,
    /~\/\.agentic-army/,
    'name the directory that must be denied to workers — that deny rule is the real boundary',
  );
  assert.match(
    PROJECTS_SECTION,
    /guardrail against accident and drift/i,
    'say plainly what this is worth without the deny rule',
  );

  // The one claim that IS absolute stays absolute: the repo has no say.
  assert.match(PROJECTS_SECTION, /never inside the\s*#?\s*repository it governs/i);
});

// -----------------------------------------------------------------------------------------
// DOC/CODE DRIFT — claims a comment makes, pinned to the code that has to keep them true
//
// Every assertion below started life as a sentence in a doc comment that had stopped
// describing the program. A comment nobody can fail is a comment that drifts, so each of these
// reads the REAL artifact — the layout block, the mirror path the delivery code builds, the
// schema description that ships in the npm tarball, the dispatcher's own body — rather than
// trusting the prose next to it.
// -----------------------------------------------------------------------------------------

/** A source file under `src/`, read as text so a comment can be asserted on. */
async function readSrc(...parts: string[]): Promise<string> {
  return fs.readFile(path.resolve(import.meta.dirname, '..', 'src', ...parts), 'utf8');
}

test('the archive layout block names every file `army rebuild` reconstructs from', async () => {
  const text = await readSrc('contracts', 'archive.ts');

  // The fenced block at the head of the module, not the whole file: a filename mentioned in
  // some other paragraph must not satisfy a claim the LAYOUT makes.
  const block = /```\n([\s\S]*?)```/.exec(text)?.[1];
  assert.ok(block !== undefined, 'the layout block must exist to be checked');
  assert.ok(block.includes('campaigns/'), 'the scanner found the right block, not an empty match');

  // Sourced from the path module rather than retyped, so renaming a constant ripples here.
  const truth = [
    CAMPAIGN_JSON_FILENAME,
    TASKS_JSONL_FILENAME,
    SIGNALS_JSONL_FILENAME,
    AGENT_JSON_FILENAME,
    STREAM_JSONL_FILENAME,
  ];
  for (const file of truth) {
    assert.ok(
      block.includes(file),
      `the layout block omits ${file}. The module claims two lines below it that campaign.db ` +
        'is rebuilt from the files on disk; a layout that does not contain those files makes ' +
        'that claim unreadable. Add it, or stop making the claim.',
    );
  }
  // And the index itself, so the "SQLite is the index" contrast has both halves.
  assert.ok(block.includes(CAMPAIGN_DB_FILENAME), 'the index belongs in the layout too');
});

test('the mirror path in the contracts is the one durability actually builds', async () => {
  // The property the digest exists for: two checkouts sharing a basename must not collide.
  const a = mirrorPathFor('/Users/x/work/api', '/archive');
  const b = mirrorPathFor('/Users/x/oss/api', '/archive');
  assert.notEqual(a, b, 'same basename, different absolute path — these must not share a mirror');
  for (const p of [a, b]) {
    assert.equal(path.basename(path.dirname(p)), MIRRORS_DIRNAME);
    assert.match(
      path.basename(p),
      /^api-[0-9a-f]{8}\.git$/,
      'the shipped name is <basename>-<sha1-8>.git — the docs below are pinned to this shape',
    );
  }

  // Both contracts used to document `mirrors/<project>.git`, which is precisely the colliding
  // name the code refuses to produce. Neither may say it again.
  for (const [where, text] of [
    ['contracts/archive.ts', await readSrc('contracts', 'archive.ts')],
    ['contracts/delivery.ts', await readSrc('contracts', 'delivery.ts')],
  ] as const) {
    assert.ok(
      !text.includes('mirrors/<project>.git'),
      `${where} documents mirrors/<project>.git, a path mirrorPathFor never produces`,
    );
    assert.match(
      text,
      /<basename>-<sha1-8>\.git/,
      `${where} must document the digest — it is load-bearing, not cosmetic`,
    );
  }
});

test('the schema descriptions ship in the package, so they must not misdescribe the flags', () => {
  // These strings enter a model's context on every structured return and are published in the
  // npm tarball, so a wrong one is not an internal note.
  for (const [name, schema] of [
    ['report.v1.json', reportSchema],
    ['verdict.v1.json', verdictSchema],
  ] as const) {
    const description = String(schema.description);
    assert.ok(
      !/--json-schema\s*<path>/.test(description),
      `${name} says claude takes --json-schema <path>. It does not: claude rejects a path with ` +
        '"--json-schema is not valid JSON", and src/harness/claude.ts inlines the file contents.',
    );
    assert.ok(description.includes('--output-schema'), `${name}: codex's flag is named`);
  }

  // The verdict schema is the one that carried the false claim; it must now name the asymmetry.
  const verdictDescription = String(verdictSchema.description);
  assert.match(verdictDescription, /inline/i);
  assert.match(verdictDescription, /--output-schema <path>/);
});

test('the claude adapter really does inline the schema file, which is what the docs now say', async () => {
  const claude = await fs.readFile(
    path.resolve(import.meta.dirname, '..', 'src', 'harness', 'claude.ts'),
    'utf8',
  );
  // The doc claim above is only worth pinning if the adapter is the thing it describes.
  assert.match(
    claude,
    /args\.push\('--json-schema',\s*read\(spec\.outputSchemaPath\)\)/,
    'claude.ts must pass the file CONTENTS. If this moved, the schema descriptions and ' +
      'SoldierSpec.outputSchemaPath both describe something that no longer happens.',
  );
});

test('dispatch: `when` and `dispatch.default` are documented as accepted-but-unread, and are', async () => {
  const campaign = await fs.readFile(
    path.resolve(import.meta.dirname, '..', 'src', 'command', 'campaign.ts'),
    'utf8',
  );
  const body = /function dispatchFor\([\s\S]*?\n}\n/.exec(campaign)?.[0];
  assert.ok(body !== undefined, 'dispatchFor must be findable, or this guard proves nothing');
  assert.ok(body.includes('rule.use[0]'), 'the scanner is looking at the real dispatcher');

  // THE CODE HALF. If either of these starts being read, this test fails — which is the point:
  // wiring one up is welcome, and it must come with the doc change, not without it.
  assert.ok(
    !/\.when\b/.test(body),
    'dispatchFor now reads `when`. Good — then update DispatchRule.when in ' +
      'src/contracts/config.ts, the [[dispatch.rules]] block in src/setup/init.ts and the ' +
      'note in parseDispatch, all of which currently tell the user nothing matches on it.',
  );
  assert.ok(
    !/\bdispatch\.default\b|\bconfig\.dispatch\.default\b/.test(body),
    'dispatchFor now reads dispatch.default. Then DispatchConfig.default must stop saying ' +
      'NOT BUILT YET, and the init template must stop saying nothing reads it.',
  );

  // THE DOC HALF, so the two cannot be true separately.
  const contract = await readSrc('contracts', 'config.ts');
  assert.match(contract, /NOT A PREDICATE, AND NOTHING MATCHES ON IT/);
  assert.match(contract, /\*\*ONLY `use\[0\]` IS READ\.\*\*/);
  assert.match(contract, /NOT BUILT YET — accepted, validated, and read by nothing/);
  assert.ok(
    !contract.includes('an unmatched task is an error, not a guess'),
    'that sentence was false in both halves: absence is not an error, and the fallback is a guess',
  );
});

test('the config template promises the vendor split the dispatcher performs', () => {
  const toml = defaultConfigToml();
  // SENTRY -> codex was written here and has never been true: nothing spawns a SENTRY, and were
  // one fielded it would take the non-INSPECTOR branch to claude.
  assert.ok(
    !/^#\s*SENTRY\s*->\s*codex\s*$/m.test(toml),
    'the template routes SENTRY to codex. Only INSPECTOR routes to codex.',
  );
  assert.match(toml, /INSPECTOR\s+->\s+codex/, 'the split that does happen is stated');
  assert.match(toml, /every other role\s+->\s+claude/i);
  assert.match(toml, /IS NOT MATCHED AGAINST ANYTHING/, '`when` is labelled honestly in place');
  assert.match(toml, /ONLY THE FIRST ENTRY IS READ/, '`use` is labelled honestly in place');
  assert.match(toml, /NOTHING READS IT YET/, '`dispatch.default` is labelled honestly in place');
});

test('TOLERANCE: a config carrying the old `when` and `dispatch.default` still loads', () => {
  // The upgrade above changed documentation, not the accepted grammar. A file somebody edited
  // months ago — free-text `when`, a `dispatch.default`, and an extra `use` candidate nothing
  // reads — must still load, with the same live targets and no new warnings.
  const toml = [
    'version = 1',
    '',
    '[dispatch]',
    'default = [ { harness = "claude", model = "claude-sonnet-5" } ]',
    '',
    '[[dispatch.rules]]',
    'when = "the moon is waxing and the task smells like refactoring"',
    'use = [ { harness = "claude", model = "claude-sonnet-5", effort = "xhigh" } ]',
    'why = "Engineers build on Claude."',
    '',
    '[[dispatch.rules]]',
    'when = "An Engineer has claimed done and its branch needs review."',
    'use = [',
    '  { harness = "codex", model = "gpt-5.5", effort = "high" },',
    '  { harness = "claude", model = "claude-sonnet-5", effort = "high" },',
    ']',
    'why = "Reviewer must not share the builder\'s blind spots."',
  ].join('\n');

  const { config, warnings } = parseConfig(toml, '/tmp/h/config.toml');
  assert.deepEqual(warnings, [], 'an already-valid config must not start warning');

  // `when` is carried verbatim, whatever it says — nothing validates it as a predicate.
  assert.equal(config.dispatch.rules[0]?.when, 'the moon is waxing and the task smells like refactoring');
  // The live fields are unaffected by the nonsense label above it.
  assert.deepEqual(config.dispatch.rules[0]?.use[0], {
    harness: 'claude',
    model: 'claude-sonnet-5',
    effort: 'xhigh',
  });
  // Extra candidates survive parsing and are simply never consulted.
  assert.equal(config.dispatch.rules[1]?.use.length, 2);
  assert.equal(config.dispatch.rules[1]?.use[0]?.harness, 'codex');
  // And the default is accepted rather than rejected, exactly as before.
  assert.deepEqual(config.dispatch.default, [{ harness: 'claude', model: 'claude-sonnet-5' }]);
});

// -----------------------------------------------------------------------------------------
// LAYERING — a call-graph fact turned into a guarantee
// -----------------------------------------------------------------------------------------

test('LAYERING: writeProjectCeiling is imported only from src/setup/**', async () => {
  const srcRoot = path.resolve(import.meta.dirname, '..', 'src');
  const entries = await fs.readdir(srcRoot, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => path.join(e.parentPath, e.name));

  assert.ok(files.length > 5, 'the scan must actually find source files, or it proves nothing');

  const definition = path.join(srcRoot, 'config', 'load.ts');
  const referencing: string[] = [];
  for (const file of files) {
    if (file === definition) continue;
    const text = await fs.readFile(file, 'utf8');
    if (text.includes('writeProjectCeiling')) referencing.push(path.relative(srcRoot, file));
  }

  // Sanity: the scanner can see the symbol at all, so a pass is not a pass by blindness.
  assert.ok(
    (await fs.readFile(definition, 'utf8')).includes('export async function writeProjectCeiling'),
    'the scanner is looking at the right symbol in the right file',
  );

  const offenders = referencing.filter((rel) => !rel.startsWith(`setup${path.sep}`));
  assert.deepEqual(
    offenders,
    [],
    'writeProjectCeiling raises a delivery ceiling with no TTY gate and no refusal-to-raise. ' +
      'Only src/setup/** (which owns `army enlist`, where a human is present) may call it. ' +
      `Offending module(s): ${offenders.join(', ')}. If the orchestrator needs config, import ` +
      'loadConfig — not this.',
  );
});

// -----------------------------------------------------------------------------------------
// ROSTER AND LOADOUT DRIFT — four claims that were wrong, now held by the code they describe
//
// Each of these replaced a sentence that had stopped being true. They are here rather than in
// a reviewer's head because prose about a permission set is exactly the prose that goes stale
// silently: nothing breaks, the tests stay green, and the next reader believes it.
//
// The roles a claim may name are DERIVED (`spawnedRoles`), never listed, so a role that starts
// or stops being fielded fails the docs that describe the roster instead of quietly outdating
// them.
// -----------------------------------------------------------------------------------------

/**
 * The roles some module actually hands to a spec builder, read out of `src/**` rather than
 * enumerated here. A listed set would be a second copy of exactly the thing that drifted.
 *
 * The pattern anchors on a property at the start of a line, which is what a spec literal looks
 * like (`        role: 'ENGINEER',`) and what a comment (`// role: 'SENTRY'`) and a comparison
 * (`role === 'COMMANDER'`) do not.
 */
async function spawnedRoles(): Promise<Set<Role>> {
  const srcRoot = path.resolve(import.meta.dirname, '..', 'src');
  const entries = await fs.readdir(srcRoot, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => path.join(e.parentPath, e.name));
  assert.ok(files.length > 5, 'the scan must actually find source files, or it proves nothing');

  const found = new Set<Role>();
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    for (const match of text.matchAll(/^[ \t]*role: '([A-Z]+)',/gm)) {
      const role = match[1] as Role;
      assert.ok(ROLES.includes(role), `${file} builds a spec for an unknown role ${role}`);
      found.add(role);
    }
  }
  // A scanner that finds nothing would make every "is it fielded" question answer the same way.
  assert.ok(found.has('ENGINEER'), 'the scanner must see the Engineer spawn, or it sees nothing');
  return found;
}

test('the COMMANDER doc names the tool it holds and says why the list is never emptied', async () => {
  const text = await readSrc('contracts', 'ranks.ts');
  const start = text.indexOf('COMMANDER is the branch of service');
  const end = text.indexOf('export const ROLES');
  assert.ok(start !== -1 && end > start, 'the COMMANDER doc block must exist to be checked');
  const block = text.slice(start, end);
  assert.ok(block.includes('army chat'), 'the slice selected the doc block, not an empty match');

  // The loadout is not a literary question. Whatever ROLE_ALLOW gives a COMMANDER, the contract
  // file names it — so widening the list forces the sentence describing it to be rewritten.
  assert.ok(
    ROLE_ALLOW.COMMANDER.length > 0,
    'a COMMANDER allow-list with nothing in it drops --allowedTools and inherits every tool',
  );
  for (const rule of ROLE_ALLOW.COMMANDER) {
    assert.ok(
      block.includes(toolNameOf(rule)),
      `ROLE_ALLOW.COMMANDER holds ${toolNameOf(rule)} and the contract doc does not mention it. ` +
        'The doc is where a reader decides what the role IS; a loadout it does not name is a ' +
        'loadout the next reader will feel free to remove.',
    );
  }

  // Wordings that name the dangerous configuration as if it were the safe one.
  const overclaims: Array<[string, RegExp]> = [
    ['the loadout is described as absent', /loadout is\s+\*?\s*nothing/i],
    ['the role is said to carry no tool at all', /holds? no tools|no tools at all|without any tools/i],
    ['an emptied list is called the strict one', /empty allow-list is (?:the )?(?:safest|most restrictive|strictest)/i],
  ];
  for (const [label, pattern] of overclaims) {
    assert.doesNotMatch(block, pattern, `src/contracts/ranks.ts: ${label}`);
  }

  // Omitting the false half is not enough — the reason has to be on the page, or the next
  // simplification pass takes the one tool out and nothing in the prose objects.
  assert.match(block, /--allowedTools/, 'name the flag that goes missing');
  assert.match(block, /most permissive/i, 'say what an emptied list actually produces');
});

test('the --help roster names every role, and marks exactly the ones nothing spawns', async () => {
  const cli = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
  const res = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(res.status, 0, `--help failed: ${res.stderr}`);

  const at = res.stdout.indexOf('\nROLES');
  assert.ok(at !== -1, 'the roster block must be in --help to be checked');
  const block = res.stdout.slice(at);
  assert.ok(block.includes('ENGINEER'), 'the slice selected the roster, not an empty tail');

  const MARKER = 'NOT YET FIELDED:';
  const cut = block.indexOf(MARKER);
  assert.ok(
    cut !== -1,
    'the roster must state the status of the roles nothing spawns rather than listing them ' +
      'beside the ones it does. Deleting them is not the alternative — a sibling settled that ' +
      'in src/contracts/config.ts and src/command/permissions.ts; the gap gets said out loud.',
  );
  const fielded = block.slice(0, cut);
  const deferred = block.slice(cut + MARKER.length);

  const spawned = await spawnedRoles();
  for (const role of ROLES) {
    assert.ok(block.includes(role), `--help omits ${role}; this is the roster a new user reads`);
    if (spawned.has(role)) {
      assert.ok(fielded.includes(role), `${role} is spawned by this build and must be listed as such`);
      assert.ok(!deferred.includes(role), `${role} is spawned by this build and is marked as not fielded`);
    } else {
      assert.ok(deferred.includes(role), `nothing spawns a ${role}; --help must say so, not imply otherwise`);
      assert.ok(!fielded.includes(role), `nothing spawns a ${role}; it must not sit among the fielded roles`);
    }
  }

  // The whole help, not the roster: the same overclaim was also sitting in the command list,
  // four sections above the roster, and a guard scoped to one block would have left it there.
  assert.doesNotMatch(
    res.stdout,
    /holds? no tools|no tools at all|without any tools/i,
    'the help describes the COMMANDER as carrying nothing, which names the one configuration ' +
      'this codebase cannot safely emit. See the loadout guard above.',
  );
});

test('the worktree contract describes one shared writable lease, not an attenuated Inspector tree', async () => {
  const doc = await readSrc('contracts', 'worktree.ts');
  const head = doc.slice(0, doc.indexOf('export const WORKTREE_PROVIDER_IDS'));
  assert.ok(head.includes('Inspector'), 'the header block must name the Inspector to be checked');

  // The claim, checked against the orchestrator rather than against the sentence beside it.
  const campaign = await readSrc('command', 'campaign.ts');
  assert.equal(
    [...campaign.matchAll(/\.acquire\(/g)].length,
    1,
    'a second acquisition would make the one-lease claim in src/contracts/worktree.ts false',
  );
  assert.match(campaign, /const worktree = lease\.path;/, 'the shared cwd must be the leased path');

  const specs = [...campaign.matchAll(/buildSoldierSpec\(\{[\s\S]{0,900}?\}\);/g)].map((m) => m[0]);
  assert.equal(specs.length, 2, 'today exactly two spawns build a spec: the Engineer and the Inspector');
  assert.ok(specs.some((s) => s.includes("role: 'ENGINEER'")), 'one of them is the Engineer');
  assert.ok(specs.some((s) => s.includes("role: 'INSPECTOR'")), 'the other is the Inspector');
  for (const spec of specs) {
    assert.match(
      spec,
      /cwd: worktree,/,
      'both spawns are handed the same leased path. If one ever gets its own tree, the contract ' +
        'header stops describing the program and must be rewritten with it.',
    );
  }

  // And the half that IS true: the Inspector's harmlessness is its loadout.
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    assert.ok(
      !ROLE_ALLOW.INSPECTOR.some((rule) => toolNameOf(rule) === tool),
      `an INSPECTOR holding ${tool} would make the review gate's independence a matter of trust`,
    );
  }
  assert.equal(ROLE_WRITES_FILES.INSPECTOR, false);

  const overclaims: Array<[string, RegExp]> = [
    ['the Inspector is given a tree it cannot write', /Inspector[^.]{0,90}read.only/i],
    ['the tree itself is called restricted', /read.only[^.]{0,90}(?:worktree|tree|checkout)/i],
  ];
  for (const [label, pattern] of overclaims) {
    assert.doesNotMatch(head, pattern, `src/contracts/worktree.ts: ${label}`);
  }
  assert.match(head, /one lease per campaign/i, 'say what the Engineer and Inspector share');
  assert.match(head, /loadout/i, 'say where the Inspector\'s read-only-ness actually comes from');
});

test('the archive docs illustrate to_selector with a value that exists', async () => {
  const spawned = await spawnedRoles();

  // `src/contracts/archive.ts` is a sibling's file and states the caveat inline; these two did
  // not, which is why they are the ones pinned here.
  const cited: string[] = [];
  for (const parts of [['archive', 'schema.ts'], ['archive', 'archive.ts']]) {
    const text = await readSrc(...parts);
    for (const match of text.matchAll(/role:([A-Z]+)/g)) {
      const role = match[1] as string;
      cited.push(role);
      assert.ok(
        spawned.has(role as Role),
        `src/${parts.join('/')} illustrates to_selector with 'role:${role}', and nothing in this ` +
          'build spawns one. An example is the only documentation most readers get; an example ' +
          'that resolves to nobody teaches a shape that has never carried a message.',
      );
    }
  }
  assert.ok(cited.length > 0, 'the scan must find a selector example, or the loop above proves nothing');

  // The one value that is actually written, in both places, and in the code that writes it.
  const schema = await readSrc('archive', 'schema.ts');
  assert.match(schema, /to_selector TEXT,[^\n]*'chain'/, 'the DDL comment leads with the real value');
  assert.match(await readSrc('archive', 'archive.ts'), /'chain'/, 'so does the field doc');
  assert.match(
    await readSrc('command', 'campaign.ts'),
    /toSelector: 'chain',/,
    "the docs above say 'chain' is what gets written; this is the line that writes it",
  );
});

// -----------------------------------------------------------------------------------------
// LIVE — the periodic proof that the offline guards above still describe reality
//
// Skipped by default. `ARMY_LIVE=1 node --test test/contracts.test.ts` spawns the real CLIs,
// which costs wall-clock and subscription quota, so this is a thing you run when a schema
// changes or a CLI upgrades — not on every save. The offline guards are the everyday
// mechanism; this is what keeps them honest.
// -----------------------------------------------------------------------------------------

const LIVE = process.env['ARMY_LIVE'] === '1';
const skipLive: boolean | string =
  LIVE ? false : 'set ARMY_LIVE=1 to run (spawns real CLIs, costs quota)';

const LIVE_TIMEOUT_MS = 300_000;

/** Last line of stdout that parses as a JSON object — both CLIs print the payload last. */
function lastJsonObject(stdout: string): unknown {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i] ?? '');
    } catch {
      /* keep walking backwards */
    }
  }
  throw new Error(`no JSON object in output:\n${stdout}`);
}

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    timeout: LIVE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const REPORT_PROMPT =
  "Emit a Report: status done, summary 'schema smoke test', no findings, one artifact of " +
  'kind file with ref README.md, branch null, costUsd null.';
const VERDICT_PROMPT =
  "Emit a Verdict: pass, summary 'schema smoke test', no findings, testsRun false, " +
  'testCommand null.';

test('LIVE: codex --output-schema accepts report.v1.json and returns a valid Report', { skip: skipLive }, () => {
  // codex takes the FILE PATH.
  const out = run('codex', [
    'exec',
    '--output-schema',
    REPORT_SCHEMA_PATH,
    '--sandbox',
    'read-only',
    REPORT_PROMPT,
  ]);
  const result = validateReport(lastJsonObject(out));
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));
});

test('LIVE: codex --output-schema accepts verdict.v1.json and returns a valid Verdict', { skip: skipLive }, () => {
  const out = run('codex', [
    'exec',
    '--output-schema',
    VERDICT_SCHEMA_PATH,
    '--sandbox',
    'read-only',
    VERDICT_PROMPT,
  ]);
  const result = validateVerdict(lastJsonObject(out));
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));
});

test('LIVE: claude --json-schema accepts report.v1.json and returns a valid Report', { skip: skipLive }, () => {
  // claude takes INLINE JSON — handing it a path fails with "not valid JSON".
  const out = run('claude', [
    '-p',
    '--json-schema',
    readFileSync(REPORT_SCHEMA_PATH, 'utf8'),
    REPORT_PROMPT,
  ]);
  const result = validateReport(lastJsonObject(out));
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));
});

test('LIVE: claude --json-schema accepts verdict.v1.json and returns a valid Verdict', { skip: skipLive }, () => {
  const out = run('claude', [
    '-p',
    '--json-schema',
    readFileSync(VERDICT_SCHEMA_PATH, 'utf8'),
    VERDICT_PROMPT,
  ]);
  const result = validateVerdict(lastJsonObject(out));
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));
});
