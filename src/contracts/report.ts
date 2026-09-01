/**
 * The return path. This file is the context guard.
 *
 * Every child returns a hard-schema object, enforced by `--json-schema` on Claude and
 * `--output-schema` on Codex. Mechanism, not prose instruction: a commanding agent's window
 * cannot be flooded because the transport itself is capped.
 *
 * Full artifacts always persist; the capped return is TRANSPORT, NOT TRUTH. `artifacts`
 * points at the big stuff — `report.md`, `diff.patch`, `stream.jsonl` — which a parent may
 * choose to read, or hand to a synthesist, or never read at all.
 *
 * The constants below are the SINGLE SOURCE OF TRUTH. `schemas/report.v1.json` and
 * `schemas/verdict.v1.json` mirror them, and `test/contracts.test.ts` fails if they drift.
 */

import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------------------------

/** One line. If it does not fit in 280 characters it is not a summary. */
export const SUMMARY_MAX_CHARS = 280;

/** More than five findings is a report.md, not a return value. */
export const MAX_FINDINGS = 5;

/** Per-finding message cap. Same budget as the summary. */
export const FINDING_MESSAGE_MAX_CHARS = 280;

/** Artifacts are pointers, so the cap is generous — but not unbounded. */
export const MAX_ARTIFACTS = 20;

/** Shared cap for the small pointer strings: branch, file, artifact ref/note, test command. */
export const SHORT_STRING_MAX_CHARS = 512;

/**
 * One line, and a longer one than a summary gets.
 *
 * A question has to state the decision AND the options a human is choosing between, which a
 * 280-character account of what happened does not have to do. 500 is the same ceiling
 * `SPEC_ENTRY_MAX_CHARS` and `OBJECTIVE_MAX_CHARS` use, and it is the same ceiling for the same
 * reason: a question climbs into the NEXT Engineer's `orders.md`, which is a markdown document
 * with `##` section headings in it. A single line cannot open a section, so a worker cannot write
 * itself a forged instruction from the rank above. `validateReport` enforces the newline half; the
 * schema enforces the length half, and both have to hold because only one of them is on the wire.
 */
export const QUESTION_MAX_CHARS = 500;

// ---------------------------------------------------------------------------------------------
// Value domains
// ---------------------------------------------------------------------------------------------

export const REPORT_STATUSES = ['done', 'blocked', 'failed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const VERDICT_VALUES = ['pass', 'fail'] as const;
export type VerdictValue = (typeof VERDICT_VALUES)[number];

/** Ordered most severe first. A `blocker` is what turns an Inspector verdict into `fail`. */
export const SEVERITIES = ['blocker', 'major', 'minor', 'note'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ARTIFACT_KINDS = ['file', 'diff', 'branch', 'pr', 'url', 'log', 'report'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

export interface Finding {
  severity: Severity;
  message: string;
  /** Repo-relative path where possible, so it survives the worktree being returned. */
  file?: string;
  /** 1-based. */
  line?: number;
}

/**
 * A pointer to the big stuff. `ref` is deliberately not called `path`: for `branch` it is a
 * branch name, for `pr` a PR url or number, for `url` a url, for the rest a path — absolute, or
 * relative to the agent's archive directory (`campaigns/<id>/agents/<agent-id>/`).
 */
export interface ArtifactRef {
  kind: ArtifactKind;
  ref: string;
  note?: string;
}

/** The schema-capped return of any working agent. */
export interface Report {
  status: ReportStatus;
  summary: string;
  findings: Finding[];
  artifacts: ArtifactRef[];
  /** `army/<task-id>` when the agent cut one. */
  branch?: string;
  costUsd?: number;
  /**
   * The decision this agent could not make. OPTIONAL on every status, `blocked` included.
   *
   * ## Why it is not required when `blocked`
   *
   * It was, for one wave, enforced by `validateReport` because `schemas/report.v1.json` cannot
   * express "required when another property equals a value" (OpenAI strict mode takes a flat
   * `required` array and nothing else). The cost was measured and it is not worth paying: a model
   * that follows the schema and skips the prose returns `blocked` with `question: null`, the
   * validator then rejects the WHOLE report, and the worker's own account of why it stopped is
   * lost — no `report.json`, a `report.md` saying "No valid Report was returned", and a report
   * signal that degrades from the worker's sentence to "no valid report (ok)".
   *
   * Trading a whole report for a missing field is a bad trade, so the field is optional and the
   * two shapes are both legal states of the ladder rather than one legal state and one schema
   * error:
   *
   *   `blocked` WITH a question    — climbs. A human is asked and the answer resumes the work.
   *   `blocked` WITHOUT a question — terminal, exactly as it was before the ladder existed. The
   *                                  attempt ends and the summary, the findings and the branch
   *                                  are all still in the archive.
   *
   * The schema names the field in the `blocked` prose so a worker knows to fill it in. Nothing
   * enforces that it did, because there is no enforcement that does not cost more than it buys.
   *
   * WORKER-AUTHORED. When it IS present it crosses into a human's terminal and into the next
   * Engineer's orders, so the single-line and length rules below still bite: those are the
   * injection defence and they are not what was reversed.
   */
  question?: string;
}

/**
 * The Inspector's return. Deliberately NOT a `Report`: an Inspector does not report
 * progress, it renders a judgement, and `testsRun: false` with `verdict: 'pass'` is a
 * distinguishable — and suspicious — state that a shared shape would hide.
 */
/**
 * What an Inspector determined about ONE enumerated behaviour of the spec.
 *
 * ## The incident this exists for
 *
 * A spec listed six behaviours. Clause 2 was "rows sorted by total descending; ties broken
 * alphabetically by category". The Engineer implemented `sort((a, b) => b.total - a.total)` — no
 * tie-break — and wrote the tests itself, so its suite was blind in exactly the place its code
 * was. The Inspector ran that suite (14 green), and even mutated the sort order to check the
 * tests had teeth. They went red, so it concluded sorting was covered. It was not: the mutation
 * disturbed the descending order the tests DO check, and left the tie-break they do not.
 *
 * The verdict came back `findings: []`, `verdict: pass`. Nothing anywhere recorded that clause 2
 * had never been considered — a silent omission is indistinguishable from a clean bill of health.
 *
 * ## Why an array of these, rather than a better prompt
 *
 * Asking an Inspector to "check every behaviour" is a request. Requiring one entry per behaviour
 * is a shape: a verdict that skips clause 2 is now a verdict with a hole in it that the campaign
 * can see and say so. `not-verified` exists so full coverage is always achievable honestly — an
 * Inspector that could not check something says so instead of quietly omitting it, and an
 * omission it CANNOT make silently is one it has no reason to lie about.
 */
export const BEHAVIOUR_STATUSES = ['met', 'not-met', 'not-verified'] as const;
export type BehaviourStatus = (typeof BEHAVIOUR_STATUSES)[number];

export interface BehaviourVerdict {
  /**
   * 1-based index into the spec's `behaviours`, so a reader lines the two up without matching
   * prose. An index rather than the text: a restated behaviour is a paraphrase, and a paraphrase
   * is where a clause quietly becomes a different, easier clause.
   */
  behaviour: number;
  status: BehaviourStatus;
  /** One line: how it was checked, or why it could not be. */
  note: string;
}

export interface Verdict {
  verdict: VerdictValue;
  summary: string;
  findings: Finding[];
  /** Did the Inspector actually execute the suite, or only read? */
  testsRun: boolean;
  /** The exact command run, so a human can reproduce the verdict. */
  testCommand?: string;
  /**
   * One determination per enumerated behaviour, when the campaign supplied a spec.
   *
   * Optional in the type because a campaign run from a free-text objective has no behaviours to
   * account for. When a spec WAS supplied, the campaign checks the coverage and reports what is
   * missing — see `BehaviourVerdict`.
   */
  behaviours?: BehaviourVerdict[];
}

/*
 * Key manifests. Exported so the schema-drift test can check the JSON Schema against these
 * lists in both directions.
 *
 * "OPTIONAL" here means optional IN TYPESCRIPT. In the schema files these keys are still listed
 * in `required` — every property is, at every level — and are instead made NULLABLE
 * (`"type": ["string", "null"]`). That is not a stylistic choice: `codex --output-schema` uses
 * OpenAI strict structured outputs, which rejects the request outright with
 * `invalid_json_schema: 'required' is required to be supplied and to be an array including
 * every key in properties` if a property is missing from `required`.
 *
 * So a model emits `"branch": null`, and `isAbsent` below maps that back to "the field is not
 * there". The two directions of the mapping are:
 *
 *     TS optional + absent   <->   schema required + null
 *
 * `test/contracts.test.ts` asserts every key in these OPTIONAL lists is nullable in the schema
 * and every key in the REQUIRED lists is not.
 */
export const REPORT_REQUIRED_KEYS = ['status', 'summary', 'findings', 'artifacts'] as const;
export const REPORT_OPTIONAL_KEYS = ['branch', 'costUsd', 'question'] as const;
export const VERDICT_REQUIRED_KEYS = ['verdict', 'summary', 'findings', 'testsRun'] as const;
export const VERDICT_OPTIONAL_KEYS = ['testCommand', 'behaviours'] as const;
export const FINDING_REQUIRED_KEYS = ['severity', 'message'] as const;
export const FINDING_OPTIONAL_KEYS = ['file', 'line'] as const;
export const ARTIFACT_REQUIRED_KEYS = ['kind', 'ref'] as const;
export const ARTIFACT_OPTIONAL_KEYS = ['note'] as const;

/**
 * Absolute paths to the on-disk JSON Schemas. Codex's `--output-schema` takes a FILE PATH, so
 * these must exist as files. Resolved relative to this module, which means the published
 * package must keep `schemas/` at its root (`dist/contracts/report.js` → `../../schemas`).
 *
 * Claude's `--json-schema` takes INLINE JSON rather than a path, so its adapter reads the file
 * and passes the contents. Both CLIs were verified against these exact files:
 *
 *   codex exec --output-schema schemas/report.v1.json   -> conforming Report
 *   claude -p --json-schema "$(cat schemas/report.v1.json)" -> conforming Report
 *
 * Two rules keep that true, both enforced by `test/contracts.test.ts`:
 *   1. NO `$schema` key. Claude's validator cannot resolve the 2020-12 meta-schema URI and
 *      refuses the file locally: `no schema with key or ref https://json-schema.org/...`.
 *   2. OpenAI strict mode — see the key-manifest note above.
 */
export const REPORT_SCHEMA_PATH = fileURLToPath(
  new URL('../../schemas/report.v1.json', import.meta.url),
);
export const VERDICT_SCHEMA_PATH = fileURLToPath(
  new URL('../../schemas/verdict.v1.json', import.meta.url),
);

// ---------------------------------------------------------------------------------------------
// Validation — hand-rolled, zero dependencies
// ---------------------------------------------------------------------------------------------

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

function isPlainObject(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

/** Optional fields accept an explicit `null` as "absent" — models emit it and it means nothing. */
function isAbsent(v: unknown): boolean {
  return v === undefined || v === null;
}

function checkKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of required) {
    if (isAbsent(obj[key])) errors.push(`${path}${key}: required`);
  }
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) {
      errors.push(`${path}${key}: unknown property`);
    }
  }
}

/**
 * Length in Unicode CODE POINTS, which is what JSON Schema `maxLength` counts.
 *
 * `String.prototype.length` counts UTF-16 code units, so every emoji and every character
 * outside the BMP counts double — a 280-code-point summary of `'😀'.repeat(280)` is valid to
 * the schema and to the model that produced it, and would have been rejected here as "got 560".
 * The validator and the schema must agree on the units or the cap means two different things
 * depending on which side of the wire you are standing on.
 *
 * (Grapheme clusters are a third answer — `'👩‍👩‍👦'` is one glyph and five code points — but
 * JSON Schema counts code points, and matching the schema is the requirement.)
 */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _codePoint of value) count += 1;
  return count;
}

function checkString(
  value: unknown,
  max: number,
  path: string,
  errors: string[],
  opts?: { allowEmpty?: boolean },
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${path}: expected string`);
    return undefined;
  }
  if (opts?.allowEmpty !== true && value.length === 0) {
    errors.push(`${path}: must not be empty`);
    return undefined;
  }
  const length = codePointLength(value);
  if (length > max) {
    errors.push(`${path}: exceeds ${max} characters (got ${length})`);
    return undefined;
  }
  return value;
}

function checkEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: string[],
): T | undefined {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  errors.push(`${path}: expected one of ${allowed.join(' | ')}`);
  return undefined;
}

function checkFindings(value: unknown, path: string, errors: string[]): Finding[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array`);
    return undefined;
  }
  if (value.length > MAX_FINDINGS) {
    errors.push(`${path}: exceeds ${MAX_FINDINGS} findings (got ${value.length})`);
    return undefined;
  }
  const out: Finding[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    const itemPath = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      errors.push(`${itemPath}: expected object`);
      continue;
    }
    checkKeys(item, FINDING_REQUIRED_KEYS, FINDING_OPTIONAL_KEYS, `${itemPath}.`, errors);
    const severity = checkEnum(item.severity, SEVERITIES, `${itemPath}.severity`, errors);
    const message = checkString(
      item.message,
      FINDING_MESSAGE_MAX_CHARS,
      `${itemPath}.message`,
      errors,
    );
    let file: string | undefined;
    if (!isAbsent(item.file)) {
      file = checkString(item.file, SHORT_STRING_MAX_CHARS, `${itemPath}.file`, errors);
    }
    let line: number | undefined;
    if (!isAbsent(item.line)) {
      if (typeof item.line !== 'number' || !Number.isInteger(item.line) || item.line < 1) {
        errors.push(`${itemPath}.line: expected integer >= 1`);
      } else {
        line = item.line;
      }
    }
    if (severity === undefined || message === undefined) continue;
    const finding: Finding = { severity, message };
    if (file !== undefined) finding.file = file;
    if (line !== undefined) finding.line = line;
    out.push(finding);
  }
  return out;
}

function checkArtifacts(value: unknown, path: string, errors: string[]): ArtifactRef[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array`);
    return undefined;
  }
  if (value.length > MAX_ARTIFACTS) {
    errors.push(`${path}: exceeds ${MAX_ARTIFACTS} artifacts (got ${value.length})`);
    return undefined;
  }
  const out: ArtifactRef[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    const itemPath = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      errors.push(`${itemPath}: expected object`);
      continue;
    }
    checkKeys(item, ARTIFACT_REQUIRED_KEYS, ARTIFACT_OPTIONAL_KEYS, `${itemPath}.`, errors);
    const kind = checkEnum(item.kind, ARTIFACT_KINDS, `${itemPath}.kind`, errors);
    const ref = checkString(item.ref, SHORT_STRING_MAX_CHARS, `${itemPath}.ref`, errors);
    let note: string | undefined;
    if (!isAbsent(item.note)) {
      note = checkString(item.note, SHORT_STRING_MAX_CHARS, `${itemPath}.note`, errors);
    }
    if (kind === undefined || ref === undefined) continue;
    const artifact: ArtifactRef = { kind, ref };
    if (note !== undefined) artifact.note = note;
    out.push(artifact);
  }
  return out;
}

function checkCostUsd(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push(`${path}: expected finite number >= 0`);
    return undefined;
  }
  return value;
}

/**
 * Validate an untrusted value (a parsed model return, a `report.json` off disk) as a `Report`.
 *
 * Strict, mirroring `additionalProperties: false` in the schema: unknown properties are an
 * error, not something to silently drop. A rejected return is a signal row, not a crash — the
 * caller decides whether to re-prompt the child or fail the attempt.
 */
export function validateReport(u: unknown): ValidationResult<Report> {
  const errors: string[] = [];
  if (!isPlainObject(u)) {
    return { ok: false, errors: ['report: expected object'] };
  }
  checkKeys(u, REPORT_REQUIRED_KEYS, REPORT_OPTIONAL_KEYS, '', errors);

  const status = checkEnum(u.status, REPORT_STATUSES, 'status', errors);
  const summary = checkString(u.summary, SUMMARY_MAX_CHARS, 'summary', errors);
  const findings = checkFindings(u.findings, 'findings', errors);
  const artifacts = checkArtifacts(u.artifacts, 'artifacts', errors);

  let branch: string | undefined;
  if (!isAbsent(u.branch)) {
    branch = checkString(u.branch, SHORT_STRING_MAX_CHARS, 'branch', errors);
  }
  let costUsd: number | undefined;
  if (!isAbsent(u.costUsd)) {
    costUsd = checkCostUsd(u.costUsd, 'costUsd', errors);
  }

  // ---- the question ----------------------------------------------------------------------
  //
  // THERE IS NO CONDITIONAL RULE HERE, and the absence is deliberate — see `Report.question`.
  // Optional on every status, `blocked` included: a validator that rejected a blocked report for
  // a missing question threw away the whole report, which is a worse outcome than the state it
  // was refusing. A blocked report with nothing to ask is terminal, and the campaign says so.
  //
  // What IS checked is the shape of a question that is present, and both halves are load-bearing.
  // The length keeps a 500-character ceiling on a string that rides into the next Engineer's
  // brief; the single-line rule is the injection defence — that brief is a markdown document with
  // `##` headings in it, and a worker string carrying a newline can carry a heading.
  //
  // A `done` report that also asked something is odd, not malformed. Refusing it would turn a
  // whole successful attempt into a schema failure over a field the campaign is about to ignore.
  let question: string | undefined;
  if (!isAbsent(u.question)) {
    question = checkString(u.question, QUESTION_MAX_CHARS, 'question', errors);
    if (question !== undefined && /[\r\n]/.test(question)) {
      errors.push(
        'question: must be one line. It is rendered into the next Engineer\'s orders, which is a ' +
          'markdown document, and a worker string carrying a newline can carry a `##` heading.',
      );
      question = undefined;
    }
  }

  if (
    errors.length > 0 ||
    status === undefined ||
    summary === undefined ||
    findings === undefined ||
    artifacts === undefined
  ) {
    return { ok: false, errors: errors.length > 0 ? errors : ['report: invalid'] };
  }

  const value: Report = { status, summary, findings, artifacts };
  if (branch !== undefined) value.branch = branch;
  if (costUsd !== undefined) value.costUsd = costUsd;
  if (question !== undefined) value.question = question;
  return { ok: true, value };
}

/** Validate an untrusted value as an Inspector `Verdict`. Same strictness as `validateReport`. */
export function validateVerdict(u: unknown): ValidationResult<Verdict> {
  const errors: string[] = [];
  if (!isPlainObject(u)) {
    return { ok: false, errors: ['verdict: expected object'] };
  }
  checkKeys(u, VERDICT_REQUIRED_KEYS, VERDICT_OPTIONAL_KEYS, '', errors);

  const verdict = checkEnum(u.verdict, VERDICT_VALUES, 'verdict', errors);
  const summary = checkString(u.summary, SUMMARY_MAX_CHARS, 'summary', errors);
  const findings = checkFindings(u.findings, 'findings', errors);

  let testsRun: boolean | undefined;
  if (typeof u.testsRun === 'boolean') {
    testsRun = u.testsRun;
  } else {
    errors.push('testsRun: expected boolean');
  }

  let testCommand: string | undefined;
  if (!isAbsent(u.testCommand)) {
    testCommand = checkString(u.testCommand, SHORT_STRING_MAX_CHARS, 'testCommand', errors);
  }

  const behaviours = checkBehaviourVerdicts(u.behaviours, 'behaviours', errors);

  if (
    errors.length > 0 ||
    verdict === undefined ||
    summary === undefined ||
    findings === undefined ||
    testsRun === undefined
  ) {
    return { ok: false, errors: errors.length > 0 ? errors : ['verdict: invalid'] };
  }

  const value: Verdict = { verdict, summary, findings, testsRun };
  if (testCommand !== undefined) value.testCommand = testCommand;
  if (behaviours !== undefined) value.behaviours = behaviours;
  return { ok: true, value };
}

/**
 * Validate the per-behaviour accounting. Absent is legal — a free-text campaign has no spec to
 * account for — so this returns `undefined` for absent and pushes errors only for a MALFORMED
 * array. Whether the coverage is COMPLETE is not decidable here: it depends on how many
 * behaviours the spec had, which this module has never seen. The campaign checks that, where the
 * spec is in hand.
 */
function checkBehaviourVerdicts(
  u: unknown,
  path: string,
  errors: string[],
): BehaviourVerdict[] | undefined {
  if (isAbsent(u)) return undefined;
  if (!Array.isArray(u)) {
    errors.push(`${path}: expected array`);
    return undefined;
  }
  const out: BehaviourVerdict[] = [];
  for (let i = 0; i < u.length; i += 1) {
    const raw: unknown = u[i];
    const where = `${path}[${String(i)}]`;
    if (!isPlainObject(raw)) {
      errors.push(`${where}: expected object`);
      continue;
    }
    checkKeys(raw, BEHAVIOUR_VERDICT_KEYS, [], where, errors);
    const status = checkEnum(raw.status, BEHAVIOUR_STATUSES, `${where}.status`, errors);
    const note = checkString(raw.note, SUMMARY_MAX_CHARS, `${where}.note`, errors);
    const index = raw.behaviour;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) {
      errors.push(`${where}.behaviour: expected a 1-based integer index into the spec's behaviours`);
      continue;
    }
    if (status === undefined || note === undefined) continue;
    out.push({ behaviour: index, status, note });
  }
  return out;
}

/** Every key a `BehaviourVerdict` may carry. All required — there is no optional half. */
export const BEHAVIOUR_VERDICT_KEYS = ['behaviour', 'status', 'note'] as const;
