/**
 * A question climbing the chain, and the shape a human answers it from.
 *
 * ## Why this is a projection and not a report
 *
 * A blocked `Report` is the whole of a worker's account of itself: a status, a summary, up to five
 * findings, an artifact list, a branch it claims to have cut, a cost. Handing that object to
 * whatever ends up displaying a question would classify every future field of `Report` by
 * accident, which is the mistake `factsFrom` in `src/chat/dispatch.ts` exists to not make. So this
 * type names the fields one at a time, and `pendingQuestionFrom` is the only way to build one.
 *
 * The split below is the point of the type. Everything above the line was minted by the
 * supervisor before the worker existed: the campaign id, the task, the agent id it was issued, the
 * rank and role it was spawned at, the branch `armyBranch(taskId)` produced, the objective the
 * human approved. Everything below the line is the worker's own prose, schema-capped on the way
 * out of the model and capped again here. A human reading a question has to be able to tell which
 * is which, and `renderPendingQuestion` says so on the screen rather than leaving it to whoever
 * reads the type.
 *
 * ## What is deliberately not here
 *
 * No transcript, no diff, no orders text, and no `Report`. A question is meant to be answerable
 * without reading any of that; if it is not, the answer is a better question, not a bigger
 * envelope. And no address: a question travels to the agent's parent, which the parent already
 * knows, so there is no selector to resolve and nothing here that names a recipient. See the
 * `to_selector` note in `./archive.ts` for why a resolver is not built yet.
 */

import type { Rank, Role } from './ranks.ts';
import type { Finding, Severity } from './report.ts';
import {
  FINDING_MESSAGE_MAX_CHARS,
  MAX_FINDINGS,
  QUESTION_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  codePointLength,
} from './report.ts';

/** One thing the worker tried or ruled out, projected from a `Finding`. */
export interface QuestionEvidence {
  severity: Severity;
  /** WORKER-AUTHORED. */
  message: string;
}

export interface PendingQuestion {
  // ---- supervisor-owned. None of this came back from the worker. ---------------------------
  campaignId: string;
  /** The task the question is about. The work parks against this id, not against the agent. */
  taskId: string;
  /** The objective as the human approved it, held verbatim since the command line. */
  objective: string;
  /** The agent that asked. Its parent is who the question climbs to. */
  agentId: string;
  rank: Rank;
  role: Role;
  /** 1-based, so a reader can tell a first question from one asked after two failed attempts. */
  attempt: number;
  /** `army/<task-id>`, as the supervisor cut it. Never read back from a report. */
  branch: string;

  // ---- worker-authored. Sanitised, capped, and marked as such wherever it is rendered. -------
  //
  // SANITISED BEFORE IT GETS HERE, and that is a precondition of the whole type rather than a
  // property of any one field. `cap` below collapses `\s` runs, which is not the same thing as
  // neutralising a control sequence: `\s` does not cover ESC, BEL, backspace, NUL, the C1 range
  // or `U+202E`, and this text is printed on a terminal. See the note on `renderPendingQuestion`
  // for what a terminal does with those, and `src/command/campaign.ts` for where the call is.
  /** WORKER-AUTHORED. The decision it could not make. One line. */
  question: string;
  /** WORKER-AUTHORED. Its own one-line account of where it got to. */
  summary: string;
  /** WORKER-AUTHORED, capped in count and in length. What it tried or ruled out. */
  tried: QuestionEvidence[];
}

/** Flatten and cap, in code points, so the cap counts what the schema counts. */
function cap(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return codePointLength(flat) <= max ? flat : `${[...flat].slice(0, max - 1).join('')}…`;
}

export interface PendingQuestionInput {
  campaignId: string;
  taskId: string;
  objective: string;
  agentId: string;
  rank: Rank;
  role: Role;
  attempt: number;
  branch: string;
  /** The worker's `Report.question`. */
  question: string;
  /** The worker's `Report.summary`. */
  summary: string;
  /** The worker's `Report.findings`. */
  findings: readonly Finding[];
}

/**
 * Build a `PendingQuestion` from facts the supervisor holds plus three worker strings.
 *
 * There is no parameter here that can receive a `Report`, and that is the mechanism rather than a
 * style choice: a caller has to name each worker-authored string as it passes it, so adding a
 * field to `Report` never silently adds a field to what a human is shown. The caps are applied
 * again here even though the schema already applied them, because a `report.json` read back off
 * disk goes through `validateReport` and a hand-built input does not.
 */
export function pendingQuestionFrom(input: PendingQuestionInput): PendingQuestion {
  return {
    campaignId: input.campaignId,
    taskId: input.taskId,
    objective: input.objective,
    agentId: input.agentId,
    rank: input.rank,
    role: input.role,
    attempt: input.attempt,
    branch: input.branch,
    question: cap(input.question, QUESTION_MAX_CHARS),
    summary: cap(input.summary, SUMMARY_MAX_CHARS),
    tried: input.findings.slice(0, MAX_FINDINGS).map((finding) => ({
      severity: finding.severity,
      message: cap(finding.message, FINDING_MESSAGE_MAX_CHARS),
    })),
  };
}

/**
 * The block a human answers from.
 *
 * Every worker-authored line is quoted with a `>` and sits under a heading that says whose words
 * they are. That is the whole of the marking, and it holds only while two things are true of the
 * strings underneath it, both enforced elsewhere because neither can be enforced here:
 *
 * 1. **The question is one line.** `validateReport` refuses a `\r` or `\n` in it. A multi-line
 *    question could open its own `ITS QUESTION` heading inside the quoted region.
 * 2. **Every worker-authored field has been sanitised.** This block is printed on a TERMINAL, and
 *    a terminal obeys what it is sent. A question beginning with an erase-display and a
 *    cursor-home wipes the three supervisor-owned rows above it — the agent, the task, the branch
 *    — and repaints its own `ITS QUESTION, in its own words:` heading over the wreckage, so the
 *    marking is deleted by the very string it was marking. `U+202E` does the same job to reading
 *    order without an escape byte in sight. `sanitize` in `src/view/progress.ts` neutralises both;
 *    it is called at CAPTURE, where the `PendingQuestion` is built in `src/command/campaign.ts`,
 *    because this module is the bottom layer and imports nothing.
 *
 * Pure, and in `contracts` next to the type rather than in `src/chat`, so the one place that
 * decides how a question is presented is the one place that knows which half of it a worker wrote.
 */
export function renderPendingQuestion(pending: PendingQuestion): string {
  const lines: string[] = [];
  lines.push(`  ◇ ${pending.agentId} (${pending.rank}·${pending.role}) is blocked and is asking.`);
  lines.push(`    attempt ${String(pending.attempt)} · task ${pending.taskId} · branch ${pending.branch}`);
  lines.push(`    objective   ${pending.objective}`);
  lines.push('');
  lines.push('    ITS QUESTION, in its own words:');
  lines.push(`      > ${pending.question}`);
  lines.push('');
  lines.push('    ITS ACCOUNT of where it got to:');
  lines.push(`      > ${pending.summary}`);
  if (pending.tried.length > 0) {
    lines.push('');
    lines.push('    WHAT IT SAYS IT TRIED OR RULED OUT:');
    for (const item of pending.tried) lines.push(`      > ${item.severity}: ${item.message}`);
  }
  return `${lines.join('\n')}\n`;
}
