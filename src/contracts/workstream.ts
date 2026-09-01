/**
 * A workstream: one engineer's line of work inside one feature.
 *
 * ## What a workstream is, and what it is not
 *
 * It is an id, a slice of the objective, the files it is EXPECTED to touch, its branch, its
 * worktree, its status, and its attempt history. It is NOT a permission boundary. The design is
 * explicit about this (`docs/main-flow.md`, "Work is segmented up front, and overlap is reconciled
 * rather than refused"): an engineer that needs a neighbour's file takes it and the overlap is
 * ANNOUNCED. A fence around the files an engineer may touch turns a solvable merge into a blocked
 * workstream, so `expectedFiles` is a declaration and nothing in this file or downstream of it
 * refuses a write.
 *
 * The one thing declared ownership IS used for is a check at PLANNING time. Two workstreams
 * claiming the same file before either engineer exists is a mistake in the plan, and it is free to
 * fix then and expensive to fix after a model has spent forty minutes on it. `duplicateClaims`
 * answers that question and the overseer is made to re-segment.
 *
 * ## Why the segmentation is validated here rather than trusted
 *
 * It is a model's return crossing back into the supervising process, which puts it under the same
 * rule as `Report` and `Verdict`: only capped, schema-validated objects cross that line
 * (`src/command/campaign.ts`, property 4). A segmentation is worse than a report in one respect,
 * because a workstream id becomes a task id and then a git branch name, so `WORKSTREAM_ID_RE` is
 * narrower than anything a model would think to violate on purpose.
 *
 * ## Layering
 *
 * `src/contracts/**` imports nothing, this file included. It therefore carries its own small
 * validator rather than reaching for the one in `./report.ts`; what it does share with that module
 * is the CAPS, imported as values, so a slice and a spec entry cannot drift into two different
 * ideas of how long a line may be.
 */

import { fileURLToPath } from 'node:url';

import type { IntegrationTree } from './integration.ts';
import { QUESTION_MAX_CHARS, SHORT_STRING_MAX_CHARS, SUMMARY_MAX_CHARS, codePointLength } from './report.ts';
import type { ReportStatus, ValidationResult } from './report.ts';

/**
 * How a campaign obtains its one integration tree.
 *
 * ## Why this type is HERE and not in `./integration.ts`, which is where it belongs
 *
 * `./integration.ts` declares `IntegrationTree` and `MergeOutcome` and says nothing about how one
 * comes into existence, so the supervising process has a type for the thing it is handed and no
 * type for the handing. I did not add one there because that file is the declared seam between
 * two workstreams and its implementer is writing against it right now. This is the same shape a
 * `WorktreeProvider.acquire` call has, and it should move next to `IntegrationTree` the moment
 * both sides can agree on it in one edit.
 *
 * `holder` is an agent id, exactly as `WorktreeProvider.acquire` takes one, so a lease record can
 * name who holds the integration tree the same way it names who holds an engineer's.
 */
export type OpenIntegrationTree = (input: {
  /** Absolute path of the project, from `resolveProjectRoot`. */
  project: string;
  /** The branch every accepted workstream is merged onto. Supervisor-minted. */
  branch: string;
  /** The agent id recorded as holding it. */
  holder: string;
  /**
   * The commit every workstream branch was cut from, and the commit the integration branch is
   * cut from too.
   *
   * ## Why this is on the type rather than in a comment at the call site
   *
   * It is `HEAD` at the moment the campaign started, which is NOT the same value as `HEAD` at the
   * moment the integration tree is opened: the workstreams have been running for the length of a
   * model session, and a human's own commits may have landed on the project in between. An
   * integration branch cut from a moved head turns the first merge into a three-way merge against
   * commits no engineer has seen, and git reports the collision as a conflict belonging to
   * whichever workstream merged first. That brands one engineer for a collision it never caused
   * and points a reconciliation workstream at the wrong two branches.
   *
   * It was briefly absent from this type, with the implementer requiring it and the campaign
   * closing over a value. That worked and could not be checked: a later edit substituting `HEAD`
   * would have deleted the property silently, because a closure has no signature. Naming it here
   * makes the compiler the thing that enforces it.
   */
  base: string;
}) => Promise<IntegrationTree>;

// ---------------------------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------------------------

/**
 * The most workstreams one feature may be cut into.
 *
 * Separate from the CONCURRENCY cap below and larger than it, because they bound different things:
 * this bounds how finely a feature is sliced, and the concurrency cap bounds how many of those
 * slices are in flight at once. Eight is chosen against the worktree pool's own default of sixteen
 * trees, so a fully segmented feature plus its integration tree still leaves room for a second
 * campaign on the same repository.
 */
export const MAX_WORKSTREAMS = 8;

/**
 * How many workstreams run at the same time when nobody says otherwise.
 *
 * Three, and the number is a spending decision rather than a technical limit. Each concurrent
 * workstream is a whole metered model session plus a worktree plus its share of one SQLite index,
 * so the cost of a campaign is linear in this number and only the wall-clock is saved. Three
 * matches `DEFAULT_MAX_ATTEMPTS`, which is this campaign's other answer to "how much may one run
 * spend before a human has said anything".
 *
 * ## What it costs in TREES, which is the arithmetic that was wrong
 *
 * At most `maxConcurrentWorkstreams` engineer trees at any instant, plus the one integration tree
 * once the merging starts: four of the pool's sixteen at this default. That claim is true because
 * a workstream leases its tree INSIDE its pool slot and settles it at the end of the same slot; it
 * was false when written, because every workstream's tree was leased in a sequential loop before
 * the pool started, so the cap bounded live engineers and nothing bounded held trees. Four
 * workstreams at a cap of 1 against a pool of two trees failed two of them with
 * `PoolExhaustedError` and integrated nothing.
 *
 * THE ABSOLUTE CEILING, when things go wrong rather than right: a tree whose work could not be made
 * durable is RETAINED rather than returned, and a retained tree never comes back to the pool. A
 * campaign in which every settlement fails that way holds `MAX_WORKSTREAMS` (8) plus its
 * reconciliations (at most 7, since the first merge onto a branch cut from the same base cannot
 * conflict) plus 1 integration tree, which is 16, exactly `DEFAULT_MAX_TREES`. That is the honest
 * worst case and it is a failure mode, not an operating point: every one of those sixteen comes
 * with an error-level note naming the tree and the reason it is held.
 *
 * Raising it is a decision someone should have to type. `CampaignOptions.maxConcurrentWorkstreams`
 * is where, and the campaign puts the effective value in its notes so no reader has to guess which
 * number was in force.
 */
export const DEFAULT_MAX_CONCURRENT_WORKSTREAMS = 3;

/** A slice of the objective. Same ceiling as a spec entry and a question, for the same reason. */
export const SLICE_MAX_CHARS = QUESTION_MAX_CHARS;

/** Declared files per workstream. A declaration longer than this is a module list, not a slice. */
export const MAX_EXPECTED_FILES = 40;

/** A workstream id. Short, because it becomes a task id and then a branch name. */
export const WORKSTREAM_ID_MAX_CHARS = 48;

/**
 * A workstream id, as narrow as the things it turns into.
 *
 * It becomes `army/<campaign-task>-<id>` and a directory name in the archive. `assertSupervisorBranch`
 * in `src/command/orders.ts` would catch a bad one on the way into a brief, and that is the wrong
 * place to catch it: by then a model has been spawned. Lowercase alphanumerics and single
 * separators only, and it may not start or end with one.
 */
export const WORKSTREAM_ID_RE = /^[a-z0-9](?:[a-z0-9]|[-_][a-z0-9])*$/;

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

/** One workstream as the overseer PLANNED it, before anything was spawned. */
export interface WorkstreamPlan {
  /** Unique within the segmentation. `WORKSTREAM_ID_RE`. */
  id: string;
  /** This workstream's slice of the objective, in the overseer's own words. One line. */
  slice: string;
  /**
   * Repository-relative paths this workstream is EXPECTED to touch.
   *
   * A declaration, never a fence. Empty is legal and means the overseer would not commit to a
   * file list, which is worth knowing: nothing can be announced as an overlap against a
   * declaration that claims nothing, so the campaign says so rather than reporting silence as
   * cleanliness.
   */
  expectedFiles: readonly string[];
}

/** What a `MAJ·OVERSEER` returns when it is asked to segment a feature. */
export interface Segmentation {
  workstreams: WorkstreamPlan[];
  /** One line on why the feature was cut this way. For a human, not for a machine. */
  rationale: string;
}

export const WORKSTREAM_STATUSES = [
  /** Planned and not yet started. */
  'planned',
  /** An engineer is running against it. */
  'running',
  /** Its question is outstanding. It holds its worktree while its siblings keep running. */
  'parked',
  /** Its engineer finished and its mechanical gate passed. Eligible to integrate. */
  'accepted',
  /** It ran and did not produce work fit to integrate. */
  'rejected',
  /** It never ran, or it ended on something that was not a verdict on the work. */
  'abandoned',
] as const;
export type WorkstreamStatus = (typeof WORKSTREAM_STATUSES)[number];

/**
 * One engineer process against one workstream.
 *
 * A projection, deliberately thinner than `AttemptRecord` in `src/command/campaign.ts`. The rich
 * record stays there, carries `workstreamId`, and is the one place a reader goes for a verdict or
 * an acceptance result. This is the per-workstream index into it: enough to see how many processes
 * were spent and how each one ended, and nothing that would have to be kept in step.
 */
export interface WorkstreamAttempt {
  /** 1-based, counting processes. A question round does not reset it. */
  attempt: number;
  engineerAgentId: string;
  /** The adapter's terminal status: `ok`, `timeout`, `spawn-failed`. */
  engineerStatus: string;
  /** What the worker said about itself, or null when no valid report came back. */
  reportStatus: ReportStatus | null;
}

/**
 * What became of the worktree. There is no "unknown": release is destructive, so a supervisor
 * that cannot say what it did to a tree has already failed the only safety property that matters
 * there.
 *
 *   `never-acquired`  no lease was ever taken. Nothing to settle.
 *   `released`        this run returned the tree. It is back in the pool.
 *   `retained`        this run still HOLDS the tree, deliberately, because releasing it would
 *                     have destroyed work no durable ref can reach. `reason` is what a human
 *                     needs to recover it, and `path` is where.
 *   `not-held`        this run neither returned the tree nor holds it. The lease went stale
 *                     (the slot has been re-leased and `path` belongs to another holder now),
 *                     or the record was already gone, or the tree was.
 *
 * `not-held` is the newest and it exists because `release` started telling the truth. The
 * provider distinguishes released / stale-lease / no-record / missing-tree; `release` used to
 * return `void`, so this file collapsed all four into `released` and narrated `worktree
 * released: <path>` — for a path that, in the stale case, belongs to somebody else's Engineer.
 * A crash-recovering operator reading that line would go looking in the wrong tree, and, worse,
 * would believe a slot had been freed that was never this run's to free.
 *
 * It is deliberately ONE state rather than three. What a reader does about it is identical in all
 * three cases — nothing, the work is already durable — and the difference between them is a
 * sentence, which is what `reason` is for.
 */
export const LEASE_STATES = ['never-acquired', 'released', 'retained', 'not-held'] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

export interface LeaseDisposition {
  state: LeaseState;
  path: string | null;
  leaseId: string | null;
  /**
   * Always populated. For `retained`, this is what a human needs in order to recover the work;
   * for `not-held`, it is the provider's own sentence about which of the three no-ops happened
   * and who holds the tree now.
   */
  reason: string;
}


/** One workstream as it actually ran. */
export interface Workstream {
  id: string;
  slice: string;
  expectedFiles: readonly string[];
  /** The archive task this workstream's work hangs off. */
  taskId: string;
  /** `army/<task-id>`, cut by the supervisor before the engineer existed. */
  branch: string;
  /** Absolute path of its leased tree, or null when it never got one. */
  worktree: string | null;
  /**
   * What became of THIS workstream's tree.
   *
   * ONE PER WORKSTREAM, because there is one tree per workstream. `CampaignResult.lease` is the
   * FIRST workstream's — correct when a campaign had one tree and a hole with N. The other trees'
   * dispositions were in the notes, the progress stream and the archive, so nothing was hidden;
   * what was missing is a result surface that can answer "what happened to each tree", which is
   * exactly what property 2 of `src/command/campaign.ts`'s header promises. A caller holding the
   * result had to parse prose to find out which of six trees is still holding a night's work.
   */
  lease: LeaseDisposition;
  status: WorkstreamStatus;
  attempts: readonly WorkstreamAttempt[];
  /**
   * Files this workstream wrote that its own declaration did not claim.
   *
   * See `OverlapClaim`. Empty means either that nothing strayed or that nothing could be seen to
   * stray, and the two are distinguishable only by whether `expectedFiles` was empty to begin
   * with.
   */
  overlaps: readonly OverlapClaim[];
  /**
   * True for a workstream the overseer created to reconcile a merge conflict rather than to build
   * a slice of the feature. It is an ordinary workstream in every other respect: its own engineer,
   * its own worktree, and its output is reviewed like any other work.
   */
  reconciliation: boolean;
}

// ---------------------------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------------------------

/** How an overlap came to be known, which is also how much it can be trusted. */
export const OVERLAP_SOURCES = [
  /**
   * A tool call, seen on the event stream while the engineer was still running.
   *
   * LIVE and INCOMPLETE. It sees an editing tool by name and reads the path out of its input; it
   * cannot see a file written by a shell, and under the `unguarded` posture an engineer holds a
   * bare `Bash`. So a `tool-use` overlap is true, and the absence of one proves nothing.
   */
  'tool-use',
  /**
   * `git diff --name-only <base>..<branch>` once the engineer's process is down.
   *
   * COMPLETE and LATE. It is what the branch actually contains, whichever tool put it there, and
   * it is the reading integration is decided on.
   */
  'branch-diff',
] as const;
export type OverlapSource = (typeof OVERLAP_SOURCES)[number];

/** One file a workstream wrote that its own declaration did not claim. */
export interface OverlapClaim {
  /** Repository-relative where it could be made so, otherwise as the worker named it. */
  file: string;
  source: OverlapSource;
  /**
   * The workstream that DID declare the file, when one did.
   *
   * Null means nobody claimed it. That is still worth announcing, because the point of the
   * declaration is that the plan can be compared against the work, but it is a weaker event than
   * two engineers in one file.
   */
  declaredBy: string | null;
}

/**
 * Files a tool call is about to write, from its name and its input.
 *
 * ## Why this is here and not beside `describeToolUse`
 *
 * `src/view/activity.ts` says it is the only thing allowed to read a tool's input, and that rule
 * is about what may travel onward: an input is model-chosen and unbounded, so nothing downstream
 * of the extraction may carry it. This function keeps that rule. It takes `unknown`, returns
 * `string[]`, and no caller ever sees the payload. What it does not share with `describeToolUse`
 * is the QUESTION: that one asks how to say a call in one line for a human, this one asks whether
 * a call put bytes in a file. `Read` has a salient argument and writes nothing; `Bash` has a
 * command and may write anything. One table cannot answer both without one of the answers being
 * wrong.
 *
 * ## What it cannot see, stated rather than implied
 *
 * A shell. `Bash`, `command_execution` and `local_shell_call` return nothing here, on purpose,
 * because a command line is not a file list and guessing one from `>` or `tee` would produce a
 * detector that is wrong in both directions. The complete reading is the branch diff, and it
 * arrives when the process is down.
 *
 * ## Every path that leaves here is CAPPED
 *
 * This is a model-chosen string out of a tool input, and it is the newest one in the system: it is
 * copied onto an `OverlapClaim`, interpolated into a `CampaignNote.message`, put on
 * `Workstream.overlaps`, and printed by both `--json` and `renderCampaignResult`. A 50,000-character
 * `file_path` arrived whole on the result, which is property 4 of `src/command/campaign.ts`'s own
 * header ("nothing but the capped report crosses back") broken on a newly added path. Capped HERE,
 * at the extraction, because this is the one function that reads the input and every consumer is
 * downstream of it. `SHORT_STRING_MAX_CHARS` is the same ceiling `expectedFiles` is held to, so a
 * path a workstream DECLARED and a path it WROTE cannot drift into two ideas of how long a path may
 * be. The ellipsis is deliberate: an overlap on a truncated path is still worth announcing, and it
 * must be visibly truncated rather than quietly renamed.
 */
export function capPath(file: string): string {
  const length = codePointLength(file);
  if (length <= SHORT_STRING_MAX_CHARS) return file;
  return `${[...file].slice(0, SHORT_STRING_MAX_CHARS - 1).join('')}…`;
}

export function writtenPaths(toolName: string, input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const one = (key: string): string[] => {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? [capPath(value)] : [];
  };
  switch (toolName) {
    // ---- claude ----------------------------------------------------------------------------
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return one('file_path');
    case 'MultiEdit': {
      // Not in `describeToolUse`'s table because it has no single salient argument to print. It
      // has a very clear answer to THIS question, which is the whole reason the two tables differ.
      const edits = record['edits'];
      const paths = one('file_path');
      if (!Array.isArray(edits)) return paths;
      for (const edit of edits) {
        if (typeof edit !== 'object' || edit === null) continue;
        const file = (edit as Record<string, unknown>)['file_path'];
        if (typeof file === 'string' && file !== '') paths.push(capPath(file));
      }
      return [...new Set(paths)];
    }
    // ---- codex -----------------------------------------------------------------------------
    case 'file_change':
    case 'apply_patch': {
      const changes = record['changes'];
      if (!Array.isArray(changes)) return [];
      const paths: string[] = [];
      for (const change of changes) {
        if (typeof change !== 'object' || change === null) continue;
        const entry = change as Record<string, unknown>;
        const file = entry['path'] ?? entry['file_path'];
        if (typeof file === 'string' && file !== '') paths.push(capPath(file));
      }
      return [...new Set(paths)];
    }
    default:
      return [];
  }
}

/**
 * Compare a path against a declaration.
 *
 * A declaration may name a file (`src/a.ts`) or a directory (`src/worktree/` or `src/worktree`),
 * and a directory claim covers everything under it. That is not generosity, it is what the
 * overseer is actually asked for in its brief: files OR modules. Matching is textual and
 * case-sensitive, on already-normalised repository-relative paths, because this file may not touch
 * a disk and `path.resolve` would be a lie about a tree this process is not standing in.
 */
export function claims(declaration: readonly string[], file: string): boolean {
  for (const entry of declaration) {
    const claim = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    if (claim === '') continue;
    if (file === claim) return true;
    if (file.startsWith(`${claim}/`)) return true;
  }
  return false;
}

/**
 * Files claimed by more than one workstream, before any engineer is spawned.
 *
 * THE PLANNING ERROR. Sorted by file so the message the overseer is sent back is stable, which
 * matters because that message is the difference between a re-segmentation that fixes the right
 * thing and one that shuffles.
 *
 * Exact matches only. A directory claim overlapping a file claim underneath it is a real
 * relationship and it is deliberately NOT reported here: `src/worktree/` and
 * `src/worktree/cold.ts` in two different workstreams is exactly the "one owns the module, one
 * owns a file in it" plan a human would write, and refusing it would make the check the fence the
 * design says it must not be.
 */
export function duplicateClaims(
  workstreams: readonly WorkstreamPlan[],
): { file: string; workstreams: string[] }[] {
  const byFile = new Map<string, string[]>();
  for (const ws of workstreams) {
    for (const raw of ws.expectedFiles) {
      const file = raw.replace(/^\.\//, '').replace(/\/+$/, '');
      if (file === '') continue;
      const holders = byFile.get(file) ?? [];
      if (!holders.includes(ws.id)) holders.push(ws.id);
      byFile.set(file, holders);
    }
  }
  const out: { file: string; workstreams: string[] }[] = [];
  for (const [file, holders] of byFile) {
    if (holders.length > 1) out.push({ file, workstreams: holders });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// The overseer's two returns
// ---------------------------------------------------------------------------------------------

/**
 * What a `MAJ·OVERSEER` returns when a question climbs to it.
 *
 * `answer: null` is a first-class result and the reason the rung is worth having at all: an
 * overseer that cannot settle something says so, and the question goes on to the human unchanged.
 * A rung that could only answer would be a rung that guesses.
 */
export interface OverseerAnswer {
  /** The decision, in the overseer's own words, or null when it will not make one. */
  answer: string | null;
  /** Why it answered, or why it would not. One line, for the archive and for a human. */
  rationale: string;
}

/**
 * What a `MAJ·OVERSEER` returns when a reviewer has refused a branch.
 *
 * TWO VALUES AND NO THIRD. A rung that could answer "maybe" is a rung the supervisor has to decide
 * on top of, which is the rung not existing with extra steps. `retry` is the fail-safe value and
 * every unusable return resolves to it, because retrying is what this campaign does with no
 * overseer at all — an adjudication rung must never be able to accept work by malfunctioning.
 */
export const ADJUDICATIONS = ['retry', 'accept'] as const;
export type AdjudicationDecision = (typeof ADJUDICATIONS)[number];

export interface Adjudication {
  decision: AdjudicationDecision;
  /** One line on why. On a retry it rides into the next engineer's orders beside the findings. */
  rationale: string;
}

export const SEGMENTATION_REQUIRED_KEYS = ['workstreams', 'rationale'] as const;
export const WORKSTREAM_PLAN_REQUIRED_KEYS = ['id', 'slice', 'expectedFiles'] as const;
export const OVERSEER_ANSWER_REQUIRED_KEYS = ['answer', 'rationale'] as const;
export const ADJUDICATION_REQUIRED_KEYS = ['decision', 'rationale'] as const;

/**
 * Absolute paths to the on-disk schemas, resolved the same way `REPORT_SCHEMA_PATH` is and subject
 * to the same two rules: no `$schema` key, and every property in `required` with the optional ones
 * nullable. See `src/contracts/report.ts` for what each rule costs when it is broken.
 */
export const SEGMENTATION_SCHEMA_PATH = fileURLToPath(
  new URL('../../schemas/segmentation.v1.json', import.meta.url),
);
export const OVERSEER_ANSWER_SCHEMA_PATH = fileURLToPath(
  new URL('../../schemas/overseer-answer.v1.json', import.meta.url),
);
export const ADJUDICATION_SCHEMA_PATH = fileURLToPath(
  new URL('../../schemas/adjudication.v1.json', import.meta.url),
);

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function isPlainObject(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

/** Models emit `null` for an absent optional field. Same convention as `validateReport`. */
function isAbsent(v: unknown): boolean {
  return v === undefined || v === null;
}

function checkKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of required) {
    if (obj[key] === undefined) errors.push(`${path}${key}: required`);
  }
  for (const key of Object.keys(obj)) {
    if (!required.includes(key)) errors.push(`${path}${key}: unknown property`);
  }
}

function checkLine(value: unknown, max: number, path: string, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${path}: expected string`);
    return undefined;
  }
  const flat = value.trim();
  if (flat === '') {
    errors.push(`${path}: must not be empty`);
    return undefined;
  }
  const length = codePointLength(flat);
  if (length > max) {
    errors.push(`${path}: exceeds ${String(max)} characters (got ${String(length)})`);
    return undefined;
  }
  // The same defence `Report.question` carries, for the same reason: these strings are rendered
  // into markdown briefs that have `##` headings in them, and a single line cannot open a section.
  if (/[\r\n]/.test(flat)) {
    errors.push(`${path}: must be one line`);
    return undefined;
  }
  return flat;
}

/**
 * Validate an untrusted value as a `Segmentation`.
 *
 * Refuses, rather than repairing, in every case. A segmentation with a duplicated id or an
 * unusable one is a plan the overseer has to make again, and quietly renaming a workstream here
 * would hand a model's mistake a supervisor's authority.
 *
 * `duplicateClaims` is NOT run here. It is a question about the plan's content rather than its
 * shape, its answer is an instruction to the overseer rather than a rejection, and running it in
 * a validator would collapse "this is not a segmentation" and "this segmentation needs another
 * pass" into one outcome with one message.
 */
export function validateSegmentation(u: unknown): ValidationResult<Segmentation> {
  const errors: string[] = [];
  if (!isPlainObject(u)) return { ok: false, errors: ['segmentation: expected object'] };
  checkKeys(u, SEGMENTATION_REQUIRED_KEYS, '', errors);

  const rationale = checkLine(u['rationale'], SUMMARY_MAX_CHARS, 'rationale', errors);

  const raw = u['workstreams'];
  const workstreams: WorkstreamPlan[] = [];
  if (!Array.isArray(raw)) {
    errors.push('workstreams: expected array');
  } else if (raw.length === 0) {
    errors.push('workstreams: a feature has at least one workstream');
  } else if (raw.length > MAX_WORKSTREAMS) {
    errors.push(`workstreams: exceeds ${String(MAX_WORKSTREAMS)} (got ${String(raw.length)})`);
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < raw.length; i += 1) {
      const item: unknown = raw[i];
      const where = `workstreams[${String(i)}]`;
      if (!isPlainObject(item)) {
        errors.push(`${where}: expected object`);
        continue;
      }
      checkKeys(item, WORKSTREAM_PLAN_REQUIRED_KEYS, `${where}.`, errors);
      const id = checkLine(item['id'], WORKSTREAM_ID_MAX_CHARS, `${where}.id`, errors);
      if (id !== undefined && !WORKSTREAM_ID_RE.test(id)) {
        errors.push(
          `${where}.id: ${JSON.stringify(id)} is not usable as a branch and directory name. ` +
            'Lowercase letters, digits, and single `-` or `_` between them.',
        );
      } else if (id !== undefined) {
        if (seen.has(id)) errors.push(`${where}.id: ${JSON.stringify(id)} is used twice`);
        seen.add(id);
      }
      const slice = checkLine(item['slice'], SLICE_MAX_CHARS, `${where}.slice`, errors);

      const files: string[] = [];
      const declared = item['expectedFiles'];
      if (isAbsent(declared)) {
        // Legal. An overseer that will not commit to a file list has said something true, and
        // the campaign reports it rather than treating silence as a clean plan.
      } else if (!Array.isArray(declared)) {
        errors.push(`${where}.expectedFiles: expected array`);
      } else if (declared.length > MAX_EXPECTED_FILES) {
        errors.push(
          `${where}.expectedFiles: exceeds ${String(MAX_EXPECTED_FILES)} (got ${String(declared.length)})`,
        );
      } else {
        for (let j = 0; j < declared.length; j += 1) {
          const file = checkLine(
            declared[j],
            SHORT_STRING_MAX_CHARS,
            `${where}.expectedFiles[${String(j)}]`,
            errors,
          );
          if (file === undefined) continue;
          if (file.startsWith('/') || file.includes('..')) {
            errors.push(
              `${where}.expectedFiles[${String(j)}]: expected a repository-relative path, got ` +
                JSON.stringify(file),
            );
            continue;
          }
          files.push(file.replace(/^\.\//, ''));
        }
      }
      if (id === undefined || slice === undefined) continue;
      workstreams.push({ id, slice, expectedFiles: files });
    }
  }

  if (errors.length > 0 || rationale === undefined) {
    return { ok: false, errors: errors.length > 0 ? errors : ['segmentation: invalid'] };
  }
  return { ok: true, value: { workstreams, rationale } };
}

/** Validate an untrusted value as an `OverseerAnswer`. `answer: null` is a legal answer. */
export function validateOverseerAnswer(u: unknown): ValidationResult<OverseerAnswer> {
  const errors: string[] = [];
  if (!isPlainObject(u)) return { ok: false, errors: ['overseer answer: expected object'] };
  checkKeys(u, OVERSEER_ANSWER_REQUIRED_KEYS, '', errors);

  let answer: string | null = null;
  if (!isAbsent(u['answer'])) {
    // An answer rides into the next engineer's orders exactly where a human's would, so it is
    // held to the same one-line, capped shape a question is. A model that needs more than 500
    // characters to settle a decision has not settled it.
    const checked = checkLine(u['answer'], QUESTION_MAX_CHARS, 'answer', errors);
    answer = checked ?? null;
  }
  const rationale = checkLine(u['rationale'], SUMMARY_MAX_CHARS, 'rationale', errors);
  if (errors.length > 0 || rationale === undefined) {
    return { ok: false, errors: errors.length > 0 ? errors : ['overseer answer: invalid'] };
  }
  return { ok: true, value: { answer, rationale } };
}

/**
 * Validate an untrusted value as an `Adjudication`.
 *
 * A DECISION THAT IS NOT ONE OF THE TWO WORDS IS NOT A DECISION, and it is refused rather than
 * coerced. Coercing an unrecognised string to `retry` would look identical to a legitimate retry in
 * every archive row, and the caller's answer to an invalid return is already `retry` — so the two
 * paths reach the same place, and only one of them tells a reader that a model returned nonsense.
 */
export function validateAdjudication(u: unknown): ValidationResult<Adjudication> {
  const errors: string[] = [];
  if (!isPlainObject(u)) return { ok: false, errors: ['adjudication: expected object'] };
  checkKeys(u, ADJUDICATION_REQUIRED_KEYS, '', errors);

  const raw = u['decision'];
  let decision: AdjudicationDecision | undefined;
  if (typeof raw !== 'string') {
    errors.push('adjudication.decision: expected string');
  } else if (!(ADJUDICATIONS as readonly string[]).includes(raw)) {
    errors.push(`adjudication.decision: expected one of ${ADJUDICATIONS.join(', ')}`);
  } else {
    decision = raw as AdjudicationDecision;
  }
  const rationale = checkLine(u['rationale'], SUMMARY_MAX_CHARS, 'rationale', errors);
  if (errors.length > 0 || decision === undefined || rationale === undefined) {
    return { ok: false, errors: errors.length > 0 ? errors : ['adjudication: invalid'] };
  }
  return { ok: true, value: { decision, rationale } };
}
