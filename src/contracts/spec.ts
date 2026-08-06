/**
 * The technical spec — the thing a commander has to produce before cheap workers can be useful.
 *
 * ## Why this type exists, in numbers
 *
 * A trial ran the same task at all five reasoning levels under two briefs that carried identical
 * constraints and differed only in whether the thinking had been done above. Under a COMPLETE
 * brief every effort level succeeded, including the lowest, in 1m12s for $0.29. Under a THIN
 * brief — "implement it so the tests pass" — six of eight arms failed, and the two that passed
 * were one unreproducible fluke and one `xhigh` run costing 9m42s and $1.64. Same model, same
 * seed, same acceptance suite.
 *
 * Six of those failures were the SAME missing sentence: a normalisation rule stated in the
 * complete brief and absent from the visible tests. Nobody derived it. The arms that got it right
 * were told it.
 *
 * So the lever is not the worker's reasoning budget. It is whether the decisions were made
 * upstream, and this type is the shape of "were they". A free-text objective cannot answer that
 * question, which is why answering it needed a structure rather than a longer string.
 *
 * ## What it is NOT
 *
 * It is not a quality gate on prose, and nothing here scores how well written a brief is. Every
 * check below is structural — is the field present, is it a non-blank single line, is it within
 * its cap. A parser, not a pattern. A commander that fills six fields with garbage produces a
 * valid `TechnicalSpec`, and that is correct: the human at the terminal approves the spec before
 * anything spawns, and a validator that tried to judge content would be a second, worse reviewer
 * standing between them.
 *
 * What it DOES buy is that the six questions were asked at all — and the commander's standing
 * orders make asking them the price of dispatching.
 *
 * ## Why every entry is a single line
 *
 * The same reason the objective is. Spec entries are rendered into the Engineer's `orders.md` and
 * into the Inspector's brief, both of which are markdown documents with `##` section headings. An
 * entry containing a newline can carry a heading, and a forged heading in a briefing is a forged
 * instruction. A single line cannot open a section. This is the same defence as
 * `OBJECTIVE_MAX_CHARS` and it is here for the same reason.
 */

/** Per-entry ceiling. Matches `OBJECTIVE_MAX_CHARS` — one readable line, not a paragraph. */
export const SPEC_ENTRY_MAX_CHARS = 500;

/** Entries per list. A brief that needs more than this is more than one task. */
export const SPEC_MAX_ENTRIES = 30;

/**
 * Total characters across the whole spec.
 *
 * The per-entry cap bounds injection; this bounds CONTEXT. A spec is prepended to the orders of
 * every attempt and every Inspector brief, so it is paid for repeatedly, and the worker it is
 * meant to help is the one whose context it would eat. Twelve thousand characters is a long
 * technical brief and a small fraction of a worker's window.
 */
export const SPEC_MAX_TOTAL_CHARS = 12_000;

/**
 * The six fields, and why each one is separate rather than folded into prose.
 *
 * Each corresponds to a decision a worker would otherwise have to make for itself, and each was
 * observably load-bearing in the trial: scope violations were the most common compliance failure,
 * an unstated behavioural rule was the most common correctness failure, and the arms that made
 * their own design choices were the slow ones.
 */
export interface TechnicalSpec {
  /** One line. What is being built. This becomes the campaign objective. */
  objective: string;
  /**
   * The files the worker may change.
   *
   * The scope boundary, stated positively. "Change this and nothing else" is the instruction that
   * a worker can actually comply with; "don't break anything" is not.
   */
  filesInScope: readonly string[];
  /**
   * How the worker knows it is finished — commands to run, conditions to observe.
   *
   * Without this a worker invents its own finish line, and the one it invents is always the one
   * it has already crossed.
   */
  acceptance: readonly string[];
  /**
   * Enumerated behaviours and edge cases, including the ones no test covers.
   *
   * This is the field the trial was won and lost on. The rule that six arms missed would have
   * been one entry here.
   */
  behaviours: readonly string[];
  /**
   * Design decisions ALREADY TAKEN, so the worker takes none.
   *
   * Which algorithm, which data structure, which of two defensible shapes. A cheap worker handed
   * a real design question does not know it is being asked one, and will answer it silently.
   */
  decisions: readonly string[];
  /** What the worker must not do. Forbidden actions, dependencies, files, shortcuts. */
  constraints: readonly string[];
  /**
   * The executable half of `acceptance` — shell commands that must exit 0 in the worktree.
   *
   * ## Why this is separate from `acceptance` rather than replacing it
   *
   * `acceptance` is prose, addressed to a human approving the spec and to a worker reading its
   * orders. "invalid input paths exit with code 1 and a message on stderr" is a good criterion
   * and not a command. Turning that field into commands would lose the criteria that cannot be
   * one; deciding which entries are runnable by looking at the text would be pattern-matching
   * prose, which this repo does not do. So the two coexist and the split is structural.
   *
   * ## The incident
   *
   * A commander wrote `node expenses.js sample-expenses.json prints an aligned table` into
   * `acceptance`. The Engineer created `expenses.json` instead. The Inspector ran the CLI against
   * the file that existed, passed the branch, and the criterion — run verbatim afterwards — exits
   * 1. Nothing in the system had ever executed it, because prose does not execute.
   *
   * ## Optional, and its absence is reported rather than assumed
   *
   * Not every task has a runnable check, and forcing one would produce `true` and a gate that is
   * theatre. So this may be absent — but `AcceptanceResult.ran` carries that fact outward, and a
   * campaign that ran no gate says so. An unrun check must never look like a passed one.
   *
   * These strings are executed. They come from the commander and are shown to the human in full
   * at the approval prompt before anything spawns, which is the same trust path as every other
   * field — but it is worth knowing that this is the one field with a process behind it.
   */
  verify?: readonly string[];
}

/** The five list fields, in the order they are asked for and rendered. */
export const SPEC_LIST_FIELDS = [
  'filesInScope',
  'acceptance',
  'behaviours',
  'decisions',
  'constraints',
] as const;
export type SpecListField = (typeof SPEC_LIST_FIELDS)[number];

/** Human-facing names, for the commander's questions and the confirmation prompt. */
export const SPEC_FIELD_LABEL: Record<SpecListField | 'objective' | 'verify', string> = {
  objective: 'Objective',
  filesInScope: 'Files in scope',
  acceptance: 'Acceptance',
  behaviours: 'Behaviours and edge cases',
  decisions: 'Decisions already made',
  constraints: 'Constraints',
  verify: 'Verification commands',
};

export type SpecParse =
  | { ok: true; spec: TechnicalSpec }
  | { ok: false; reason: string };

function badEntry(value: unknown): string | null {
  if (typeof value !== 'string') return `expected a string, got ${typeof value}`;
  if (value.trim() === '') return 'is blank';
  if (value.includes('\n') || value.includes('\r')) return 'contains a newline';
  if (value.length > SPEC_ENTRY_MAX_CHARS) {
    return `is ${String(value.length)} characters, over the ${String(SPEC_ENTRY_MAX_CHARS)} cap`;
  }
  return null;
}

/**
 * Validate an untrusted value — a parsed dispatch block, a spec file off disk — as a
 * `TechnicalSpec`.
 *
 * Refuses rather than repairs, in every direction. A missing field, an empty list, a blank entry,
 * an unknown key and a newline are all refusals with a reason naming the field. Repairing any of
 * them would defeat the point: the value of this type is entirely in the fact that somebody had
 * to answer six questions, and a validator that fills a gap in has answered one of them itself.
 */
export function validateTechnicalSpec(value: unknown): SpecParse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'the spec must be a JSON object' };
  }
  const record = value as Record<string, unknown>;

  const known: string[] = ['objective', ...SPEC_LIST_FIELDS, 'verify'];
  const extra = Object.keys(record).filter((key) => !known.includes(key));
  if (extra.length > 0) {
    return {
      ok: false,
      reason: `the spec names ${extra.join(', ')}, which is not a spec field. The fields are: ${known.join(', ')}.`,
    };
  }

  const objectiveProblem = badEntry(record['objective']);
  if (objectiveProblem !== null) {
    return { ok: false, reason: `spec.objective ${objectiveProblem}` };
  }

  const lists: Record<string, readonly string[]> = {};
  for (const field of SPEC_LIST_FIELDS) {
    const raw = record[field];
    if (!Array.isArray(raw)) {
      return { ok: false, reason: `spec.${field} must be an array of strings` };
    }
    if (raw.length === 0) {
      // An empty list is the one thing that looks like an answer and is not. "There are no
      // constraints" is a claim a commander can make in one entry saying so; an empty array is
      // indistinguishable from never having asked.
      return {
        ok: false,
        reason: `spec.${field} is empty. If it genuinely has no entries, say so in one entry.`,
      };
    }
    if (raw.length > SPEC_MAX_ENTRIES) {
      return {
        ok: false,
        reason: `spec.${field} has ${String(raw.length)} entries, over the ${String(SPEC_MAX_ENTRIES)} cap. This is more than one task.`,
      };
    }
    for (let i = 0; i < raw.length; i += 1) {
      const problem = badEntry(raw[i]);
      if (problem !== null) {
        return { ok: false, reason: `spec.${field}[${String(i)}] ${problem}` };
      }
    }
    lists[field] = raw as readonly string[];
  }

  // `verify` is the one optional field, and absent is NOT the same as empty. Absent means the
  // commander had nothing mechanically checkable; `[]` means it answered the question with
  // nothing, which is the shape that would let a gate look run when it never was. Refuse it, and
  // let the absence be reported honestly by `AcceptanceResult.ran` instead.
  const rawVerify = record['verify'];
  let verify: readonly string[] | undefined;
  if (rawVerify !== undefined) {
    if (!Array.isArray(rawVerify)) {
      return { ok: false, reason: 'spec.verify must be an array of shell commands' };
    }
    if (rawVerify.length === 0) {
      return {
        ok: false,
        reason: 'spec.verify is empty. Omit the field entirely if nothing here is runnable — an empty list would report as a gate that ran.',
      };
    }
    if (rawVerify.length > SPEC_MAX_ENTRIES) {
      return {
        ok: false,
        reason: `spec.verify has ${String(rawVerify.length)} entries, over the ${String(SPEC_MAX_ENTRIES)} cap.`,
      };
    }
    for (let i = 0; i < rawVerify.length; i += 1) {
      const problem = badEntry(rawVerify[i]);
      if (problem !== null) return { ok: false, reason: `spec.verify[${String(i)}] ${problem}` };
    }
    verify = rawVerify as readonly string[];
  }

  const spec: TechnicalSpec = {
    objective: (record['objective'] as string).trim(),
    filesInScope: lists['filesInScope'] as readonly string[],
    acceptance: lists['acceptance'] as readonly string[],
    behaviours: lists['behaviours'] as readonly string[],
    decisions: lists['decisions'] as readonly string[],
    constraints: lists['constraints'] as readonly string[],
    ...(verify === undefined ? {} : { verify }),
  };

  const total = specTotalChars(spec);
  if (total > SPEC_MAX_TOTAL_CHARS) {
    return {
      ok: false,
      reason: `the spec is ${String(total)} characters, over the ${String(SPEC_MAX_TOTAL_CHARS)} cap. It is carried into every attempt and every review brief, so it is paid for repeatedly.`,
    };
  }

  return { ok: true, spec };
}

/** Total characters across every field. The context cost, counted once. */
export function specTotalChars(spec: TechnicalSpec): number {
  let total = spec.objective.length;
  for (const field of SPEC_LIST_FIELDS) {
    for (const entry of spec[field]) total += entry.length;
  }
  for (const entry of spec.verify ?? []) total += entry.length;
  return total;
}

/**
 * Render a spec as the markdown section that goes into a briefing.
 *
 * THE ONLY RENDERER. The commander's confirmation prompt and the Engineer's `orders.md` show the
 * same bytes, because a human approving one thing and a worker receiving another is the failure
 * this whole confirmation step exists to prevent — and two renderers kept in step by a test is
 * worse than one.
 *
 * `heading` is caller-chosen because the same block sits under different headings in a terminal
 * prompt and in a briefing document.
 */
export function renderTechnicalSpec(spec: TechnicalSpec, heading = '## THE SPEC'): string {
  const lines: string[] = [heading, '', `**${SPEC_FIELD_LABEL.objective}.** ${spec.objective}`, ''];
  for (const field of SPEC_LIST_FIELDS) {
    lines.push(`### ${SPEC_FIELD_LABEL[field]}`);
    lines.push('');
    for (const entry of spec[field]) lines.push(`- ${entry}`);
    lines.push('');
  }
  // Rendered LAST and only when present, because this is the field with a process behind it and
  // the human approving the spec has to see every command that will be run, verbatim.
  if (spec.verify !== undefined) {
    lines.push(`### ${SPEC_FIELD_LABEL.verify}`);
    lines.push('');
    lines.push('These are executed in the worktree; each must exit 0.');
    lines.push('');
    for (const entry of spec.verify) lines.push(`- \`${entry}\``);
    lines.push('');
  }
  return lines.join('\n');
}
