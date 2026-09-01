/**
 * The durable spec — what phase 1 leaves behind when it is over.
 *
 * The Commander interrogates and `TechnicalSpec` carries all seven fields, and until now both
 * existed only inside a conversation: the spec reached an Engineer's `orders.md` and the questions
 * that produced it reached nothing at all. This module is the artefact.
 *
 * ## THE ARCHIVE ALWAYS. THE REPOSITORY ONLY IF ASKED.
 *
 * The campaign archive is append-only, audited, and outside every repository — it is where a
 * decision record belongs by default, and writing there is unconditional. Writing the same
 * documents into the git checkout is `planning.spec_to_repo`, and it is OFF by default for one
 * reason: **a rejected branch should not strand design documents in the repo.** A campaign that
 * ends `inspector-failed` still wrote a spec, and if that spec landed in the working tree it is
 * now an untracked file describing a feature nobody shipped, in a directory a human has to clean
 * up by hand.
 *
 * The design note says "instead", and the code says "as well", deliberately. Dropping the archive
 * copy when the repo copy is switched on would trade an audited, append-only record for one that
 * a `git checkout .` removes — which is the opposite of the property the archive exists for. The
 * config key decides whether the repository ALSO gets a copy; it never decides whether the
 * decision was recorded.
 *
 * ## What the three documents are
 *
 *  - `spec.md` — the settled spec, rendered by `renderTechnicalSpec`. THE SAME BYTES the human
 *    approved on the terminal and the Engineer reads in its orders, because there is one renderer
 *    and a second one is a second thing to keep in step.
 *  - `spec.json` — the same spec as data, so a later run can load it without parsing markdown.
 *  - `interrogation.md` — the questions and the answers, in order, marked with whose words each
 *    half carries.
 *
 * ## Whose words are these
 *
 * The transcript is HALF MODEL-AUTHORED and the file says so on every turn, because a document
 * that reads as one voice is a document in which a model's guess and a human's decision are
 * indistinguishable six weeks later. Both halves go through `sanitizeBlock` at capture — see
 * `src/view/progress.ts` for why the flattening `sanitize` cannot be reused for a document, and
 * why this is done once here rather than at each render site.
 *
 * ## NOTHING HERE NEUTRALISES ANYTHING, AND THAT IS THE POINT
 *
 * Three kinds of untrusted text reach these documents and each is neutralised where it ENTERS the
 * process, not where it is rendered:
 *
 *  - the interrogation's two halves, by `captureTurn` below, at the moment a round is banked;
 *  - the SPEC, by `neutraliseSpec` in `src/chat/protocol.ts`, at the moment the dispatch block is
 *    parsed — so `spec.md` and the terminal a human approved at and the Engineer's orders all
 *    carry the same neutralised bytes, which is what "one renderer" was supposed to mean;
 *  - the baseline's `lines`, by `outputLines` in `src/verify/gate.ts`, at the moment a verify
 *    command's output is read.
 *
 * The version of this file that rendered `record.spec` with nothing in front of it is why the list
 * is written out. Measured on that version: `spec.md` carried 6 ESC, 4 C1 and 4 bidi bytes in both
 * the archive and the repository copy, so `cat spec.md` cleared the screen and reversed a path;
 * and `spec.json` escaped the ESC through `JSON.stringify` and passed U+009B and U+202E through
 * untouched, because `JSON.stringify` escapes C0 and neither of those is C0. A header that says a
 * filter exists is not a filter.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TechnicalSpec } from '../contracts/spec.ts';
import { renderTechnicalSpec } from '../contracts/spec.ts';
import { sanitizeBlock } from '../view/progress.ts';

import type { AlignmentResult } from './align.ts';
import { describeReading } from './align.ts';

/** One exchange of the interrogation. */
export interface InterrogationTurn {
  /** 1-based, in the order it happened. */
  round: number;
  /** ISO-8601, from the session's clock. */
  at: string;
  /** MODEL-AUTHORED. What the Commander said, sanitised at capture. */
  commander: string;
  /** THE HUMAN'S WORDS, verbatim apart from the same neutralising. */
  human: string;
}

/**
 * The directory inside the repository, when `planning.spec_to_repo` is on.
 *
 * Relative, and fixed rather than configurable. A second key naming a directory would be a second
 * thing to validate — an absolute path, a `..`, a path outside the repo — for a choice nobody has
 * asked to make. `docs/` is where a repository keeps documents; the campaign id is what makes two
 * specs from two conversations two files.
 */
export const REPO_SPEC_DIR = path.join('docs', 'army-specs');

export interface PlanningRecord {
  campaignId: string;
  /** The project root, for the header and for the repo copy. */
  project: string;
  spec: TechnicalSpec;
  /** In order. May be empty: a spec settled in one turn is still a spec. */
  interrogation: readonly InterrogationTurn[];
  /** The gate's readings, so the baseline sits beside the criteria it was taken for. */
  alignment: AlignmentResult;
  /** ISO-8601. When the gate passed. */
  at: string;
}

/** `spec.md` — the settled spec, with the gate's reading of its criteria under it. */
export function renderSpecDocument(record: PlanningRecord): string {
  const lines: string[] = [];
  lines.push(`# ${record.campaignId} — the settled spec`);
  lines.push('');
  lines.push(`Project: \`${record.project}\``);
  lines.push(`Aligned: ${record.at}`);
  lines.push('');
  lines.push(
    'This is what a human approved before phase 2 began. It is the same text the Engineer reads ' +
      'in its orders and the same text the reviewers are briefed from — one renderer, so what was ' +
      'approved and what was built cannot be two different documents.',
  );
  lines.push('');
  lines.push(renderTechnicalSpec(record.spec));
  lines.push('');
  lines.push('## THE ALIGNMENT GATE');
  lines.push('');
  lines.push(
    'Phase 2 begins only when every required field is answered, every verification command ' +
      'EXECUTES against the base commit — even if it fails — and a human confirms with a ' +
      'keystroke. What follows is the second of those, taken before any Engineer existed.',
  );
  lines.push('');
  lines.push(
    `Base commit: ${record.alignment.baseCommit ?? 'could not be read'}`,
  );
  lines.push('');
  if (record.alignment.noCommands) {
    lines.push(
      '- The spec named no verification commands. Nothing was executed, so there is no baseline ' +
        'here and nothing was mechanically checked. That absence is recorded rather than read as ' +
        '"nothing needed checking".',
    );
  } else {
    for (const reading of record.alignment.readings) {
      lines.push(`- \`${reading.command}\` — ${describeReading(reading)}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** `interrogation.md` — every question and every answer, marked with whose words each one is. */
export function renderInterrogationDocument(record: PlanningRecord): string {
  const lines: string[] = [];
  lines.push(`# ${record.campaignId} — the interrogation`);
  lines.push('');
  lines.push(
    'How the spec above was settled. Each round carries the COMMANDER\'s question, which a model ' +
      'wrote, and the answer, which the human at the terminal typed. The two are labelled on ' +
      'every round rather than once at the top, because a transcript that reads as one voice is a ' +
      'transcript in which a guess and a decision are indistinguishable later.',
  );
  lines.push('');
  if (record.interrogation.length === 0) {
    lines.push(
      '_No rounds were recorded. The spec was settled in the turn that proposed it, which is a ' +
        'real outcome for a small task and is not the same as an interrogation that was skipped._',
    );
    lines.push('');
    return `${lines.join('\n')}\n`;
  }
  // HOW MANY WERE DROPPED, said out loud. `runChat` keeps the most recent `MAX_INTERROGATION_ROUNDS`
  // because a spec is settled at the END of an interrogation, and its comment has always claimed
  // the document reports the drop — it did not, and a transcript that begins `## Round 61` with no
  // explanation misrepresents when a decision was taken. Derived from the first surviving round's
  // own number rather than from a second counter passed in, so the two cannot disagree.
  const first = record.interrogation[0] as InterrogationTurn;
  if (first.round > 1) {
    const dropped = first.round - 1;
    lines.push(
      `_The earliest ${String(dropped)} round(s) are not here. This conversation ran longer than ` +
        'the transcript keeps, and the rounds kept are the most recent, because a spec is settled ' +
        `at the end of an interrogation. Numbering below is the round each exchange actually was._`,
    );
    lines.push('');
  }
  for (const turn of record.interrogation) {
    lines.push(`## Round ${String(turn.round)} — ${turn.at}`);
    lines.push('');
    lines.push('**COL·COMMANDER asked** (a model wrote this):');
    lines.push('');
    lines.push(turn.commander === '' ? '_(nothing)_' : turn.commander);
    lines.push('');
    lines.push('**The Commander answered** (the human typed this):');
    lines.push('');
    lines.push(turn.human === '' ? '_(nothing)_' : turn.human);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** The spec as data, for a later run that wants it without parsing markdown. */
export function renderSpecJson(record: PlanningRecord): string {
  return `${JSON.stringify(
    {
      campaignId: record.campaignId,
      project: record.project,
      at: record.at,
      spec: record.spec,
      alignment: {
        baseCommit: record.alignment.baseCommit,
        passed: record.alignment.passed,
        baseline: record.alignment.baseline,
      },
    },
    null,
    2,
  )}\n`;
}

/** One document, named for the file it becomes. */
export interface PlanningDocument {
  filename: string;
  contents: string;
}

/**
 * The three documents, built once and written wherever they are asked for.
 *
 * ONE BUILDER for both destinations. The archive copy and the repository copy are byte-identical
 * by construction rather than by a test that compares two renderers, which is the same rule
 * `renderTechnicalSpec` follows for the terminal and the orders.
 */
export function planningDocuments(record: PlanningRecord): PlanningDocument[] {
  return [
    { filename: 'spec.md', contents: renderSpecDocument(record) },
    { filename: 'spec.json', contents: renderSpecJson(record) },
    { filename: 'interrogation.md', contents: renderInterrogationDocument(record) },
  ];
}

/** Neutralise a turn at capture. Both halves, and the human's too — see the header. */
export function captureTurn(input: {
  round: number;
  at: string;
  commander: string;
  human: string;
}): InterrogationTurn {
  return {
    round: input.round,
    at: input.at,
    commander: sanitizeBlock(input.commander),
    human: sanitizeBlock(input.human),
  };
}

/**
 * Write the repository copy. Returns the paths written.
 *
 * Never throws for a reason worth stating: this runs immediately after a human has approved a
 * dispatch, and the dispatch is the thing they asked for. A read-only checkout, a full disk or a
 * directory that is somehow a file are all reasons the CONVENIENCE copy does not appear, and none
 * of them is a reason the work does not start — the archive already has the record. The failure is
 * returned so the caller can say so on screen rather than swallowed.
 */
export function writeSpecToRepo(
  record: PlanningRecord,
  documents: readonly PlanningDocument[],
): { written: string[]; failure: string | null } {
  const dir = path.join(record.project, REPO_SPEC_DIR, record.campaignId);
  const written: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const doc of documents) {
      const file = path.join(dir, doc.filename);
      fs.writeFileSync(file, doc.contents, 'utf8');
      written.push(file);
    }
    return { written, failure: null };
  } catch (error) {
    return { written, failure: error instanceof Error ? error.message : String(error) };
  }
}
