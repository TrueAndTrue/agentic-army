/**
 * The question inbox: several parked workers, one composer, one human.
 *
 * ## What it replaces, and why the old shape stopped working
 *
 * Wave 2 gave a blocked worker a way to reach a human: `askHuman` printed the question and read
 * the next line off the terminal. That is a correct design for ONE worker. Wave 3 made a campaign
 * a fan-out of up to eight concurrent engineers, and at that point the old shape has two defects
 * that no amount of care at the call site fixes:
 *
 * 1. **Two questions cannot both hold the terminal.** `ChatIo` has one pending read. A second
 *    `nextLine` while the first is outstanding replaces the resolver, and the first worker's
 *    promise is never settled. A parked workstream holds a worktree lease and waits forever on
 *    a prompt that has been painted over by somebody else's.
 * 2. **A question seizes the composer.** It arrives on a worker's schedule, which is to say in
 *    the middle of a word somebody is typing. A prompt that grabs the row is a prompt that eats
 *    the sentence that was on it.
 *
 * So a question no longer takes the terminal. It PRINTS, into scrollback, under its own marker,
 * and joins a queue. The composer's prompt is relabelled in place (`ChatIo.setPrompt`, which is
 * exactly the "do not touch the buffer" primitive this needs), the status block carries the open
 * count, and the human answers when they are ready, one question at a time, `/next` to move on.
 *
 * ## What it deliberately is not
 *
 * It is not a router and it is not a turn. Nothing in this file talks to the Commander, and the
 * answer goes back to the promise the campaign is parked on and nowhere else. That is the same
 * property `src/chat/dispatch.ts` states on `askHuman`: a model between a human's words and the
 * worker waiting for them would be a second source of intent, and the keystroke gate in `run.ts`
 * exists to be the only one.
 *
 * ## Every ending resolves the promise
 *
 * A question that is answered, skipped, left unanswered by a Ctrl-C, or abandoned because the
 * session is ending all resolve, with the answer or with `''`, which the campaign already reads
 * as "no answer came back" and treats exactly as it treated a campaign with no `askHuman` at all.
 * A promise this file forgets is a workstream parked forever on a lease, so `drain` is called from
 * the dispatch's `finally` and not only from the happy path.
 */

import type { PendingQuestion } from '../contracts/question.ts';
import type { Charset } from '../view/render.ts';
import { glyphsFor } from '../view/render.ts';

/** One question, and the promise the campaign is parked on. */
interface Entry {
  readonly id: number;
  readonly question: PendingQuestion;
  readonly settle: (answer: string) => void;
  settled: boolean;
}

/** What a caller may see of an entry. The resolver stays inside. */
export interface InboxEntry {
  /** 1-based, minted in arrival order and stable for the life of the session. */
  readonly id: number;
  readonly question: PendingQuestion;
}

export interface Inbox {
  /** Park a question. The promise resolves when it is answered, skipped or drained. */
  ask(question: PendingQuestion): Promise<string>;
  /** Open questions, oldest first. */
  readonly entries: readonly InboxEntry[];
  /** How many are open. What the status block counts. */
  readonly size: number;
  /** The one a typed line would answer, or null when nothing is open. */
  readonly current: InboxEntry | null;
  /** 1-based position of `current` among the open entries, or 0. */
  readonly position: number;
  /** Answer `current` and take it out of the queue. Returns what was answered, or null. */
  answer(text: string): InboxEntry | null;
  /** Leave `current` unanswered and take it out of the queue. Returns it, or null. */
  skip(): InboxEntry | null;
  /** Move to the next open question without answering. Returns the new `current`. */
  next(): InboxEntry | null;
  /** Leave EVERY open question unanswered. Returns them, oldest first. */
  drain(): InboxEntry[];
}

export function createInbox(): Inbox {
  const entries: Entry[] = [];
  let cursor = 0;
  let minted = 0;

  const clampCursor = (): void => {
    if (entries.length === 0) cursor = 0;
    else if (cursor >= entries.length) cursor = 0;
  };

  const settle = (entry: Entry, answer: string): void => {
    if (entry.settled) return;
    entry.settled = true;
    entry.settle(answer);
  };

  const takeCurrent = (answer: string): InboxEntry | null => {
    const entry = entries[cursor];
    if (entry === undefined) return null;
    entries.splice(cursor, 1);
    settle(entry, answer);
    clampCursor();
    return { id: entry.id, question: entry.question };
  };

  return {
    ask(question: PendingQuestion): Promise<string> {
      minted += 1;
      return new Promise<string>((resolve) => {
        entries.push({ id: minted, question, settle: resolve, settled: false });
      });
    },
    get entries(): readonly InboxEntry[] {
      return entries.map((entry) => ({ id: entry.id, question: entry.question }));
    },
    get size(): number {
      return entries.length;
    },
    get current(): InboxEntry | null {
      const entry = entries[cursor];
      return entry === undefined ? null : { id: entry.id, question: entry.question };
    },
    get position(): number {
      return entries.length === 0 ? 0 : cursor + 1;
    },
    answer(text: string): InboxEntry | null {
      return takeCurrent(text);
    },
    skip(): InboxEntry | null {
      // `''` and not a rejection: the campaign documents a blank answer and a refusal as the same
      // thing, and a rejection here would surface as an error on a path where nothing went wrong.
      return takeCurrent('');
    },
    next(): InboxEntry | null {
      if (entries.length === 0) return null;
      cursor = (cursor + 1) % entries.length;
      const entry = entries[cursor] as Entry;
      return { id: entry.id, question: entry.question };
    },
    drain(): InboxEntry[] {
      const taken = entries.splice(0, entries.length);
      cursor = 0;
      for (const entry of taken) settle(entry, '');
      return taken.map((entry) => ({ id: entry.id, question: entry.question }));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// What the human sees
// ---------------------------------------------------------------------------------------------

/**
 * The marker a question arrives under.
 *
 * It names the agent AND the workstream, because with eight engineers in flight "somebody is
 * blocked" is not a fact anybody can act on. The workstream is spelled by its task id, which is
 * what `PendingQuestion` carries and what `/work <id>` takes, so the marker doubles as the
 * argument for the command that shows the rest of the picture.
 *
 * Everything here is supervisor-owned. The worker's own words are underneath, in
 * `renderPendingQuestion`, which marks them as such; nothing on this line came back from a model,
 * which is why nothing on it needs sanitising and why it can be trusted to say who is speaking.
 */
export function renderQuestionMarker(
  entry: InboxEntry,
  open: number,
  charset: Charset = 'unicode',
): string {
  const g = glyphsFor(charset);
  const of = open > 1 ? ` ${g.bullet} ${String(open)} open` : '';
  // `?` rather than a glyph off the table, and on purpose: it exists in every codepage, it cannot
  // be confused with the `!` a warning note carries or the `⊘` a refused tool call carries, and a
  // question mark is the one mark whose meaning nobody has to be taught.
  return (
    `  ? QUESTION ${String(entry.id)} ${g.bullet} ${entry.question.agentId} ` +
    `${g.bullet} workstream ${entry.question.taskId}${of}`
  );
}

/**
 * The composer's prompt, given what is open.
 *
 * SHORT, all three of them, and that is a measured constraint rather than taste: this string is
 * repainted on every keystroke, it is charged against the width the buffer gets, and
 * `paintEntry` repeats it down every wrapped row of what the human types. A forty-four column
 * prompt cut an eighty-column terminal's typing room to thirty-five, which is how the previous
 * one-line answer prompt was found: by typing at it on a real pty, not by reading it.
 *
 * The guidance the prompt does NOT carry is on the status block, which has room and repaints for
 * free.
 */
export function inboxPrompt(inbox: Inbox, answerPrompt: string, idlePrompt: string): string {
  const current = inbox.current;
  if (current === null) return idlePrompt;
  // Exactly one open: the prompt says what typing does and needs no address, because there is
  // only one place a line could go.
  if (inbox.size === 1) return answerPrompt;
  // Several open: the prompt NAMES the one being answered. A prompt that said "your answer" with
  // three questions on screen would be asking the reader to guess which, and a guess that lands
  // in the wrong worktree is not recoverable by retyping.
  return `  ${String(inbox.position)}/${String(inbox.size)} ${current.question.agentId}  `;
}
