/**
 * What the window and the main process say to each other while an AI drafts a flow. You state the
 * objective, the AI asks one multiple-choice question at a time, and once the answers settle the
 * shape of the work it sends back a flow. Every request carries the whole conversation, so the
 * main process keeps nothing between questions.
 */

import type { FlowProblem } from './flow.ts';
import type { Flow } from './types.ts';

/** After this many answers the AI is told to draft the flow instead of asking more. */
export const MAX_DRAFT_QUESTIONS = 8;

/** What you send when you press "You pick" on a question. */
export const YOU_PICK = 'You pick';

export interface DraftAnswer {
  question: string;
  answer: string;
}

export interface DraftRequest {
  objective: string;
  answers: DraftAnswer[];
  /** You pressed "Build it now": draft the flow from what is known, with no more questions. */
  finish?: boolean;
}

export interface DraftOption {
  label: string;
  detail?: string;
}

export interface DraftQuestion {
  question: string;
  /** One short line on why the answer matters to the flow. */
  why: string;
  options: DraftOption[];
  /** Several options may be picked together. */
  multi: boolean;
  /** What the AI knows so far, in a few sentences, for you to check as you go. */
  understanding: string;
}

export type DraftReply =
  | ({ kind: 'question' } & DraftQuestion)
  | {
      kind: 'flow';
      flow: Flow;
      /** A few sentences to you on what it built and why. */
      summary: string;
      /** What the checks still find in the draft after the AI's repairs. */
      problems: FlowProblem[];
    }
  | { kind: 'error'; message: string };
