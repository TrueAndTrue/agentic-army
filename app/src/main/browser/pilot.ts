/**
 * Computer use with Jev.
 *
 * Jev selects; it does not write. So each step turns the page into a closed list of actions a
 * person could take (click this link, type this phrase into that box, scroll, go back, stop),
 * and asks Jev which one moves toward the goal. Text to type is never invented: it is taken from
 * the goal itself, from quoted phrases and from what follows words like "search for".
 *
 * A second question guards the chosen action. If Jev thinks it could spend money, delete, send,
 * post or hand over credentials, the step pauses for you.
 *
 * This file is pure. The Electron page lives in `page.ts` behind the `Page` interface, so the
 * tests drive it with a fake page and a fake Jev.
 */

import type { BrowserStep } from '../../shared/types.ts';
import type { JevQuestion, JevResponse } from '../jev.ts';

export interface PageElement {
  /** Stable for one snapshot: `e12`. */
  id: string;
  tag: string;
  kind: 'link' | 'button' | 'input' | 'textarea' | 'select' | 'other';
  text: string;
  href?: string;
  inputType?: string;
  name?: string;
  inViewport: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** The visible text, trimmed. */
  text: string;
  elements: PageElement[];
  canGoBack: boolean;
}

export type Action =
  | { kind: 'click'; elementId: string }
  | { kind: 'type'; elementId: string; text: string; submit: boolean }
  | { kind: 'scroll' }
  | { kind: 'back' }
  | { kind: 'done' }
  | { kind: 'fail' };

export interface Page {
  open(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  perform(action: Action): Promise<void>;
}

export type Ask = (state: unknown, questions: Record<string, JevQuestion>, signal: AbortSignal) => Promise<JevResponse>;

export interface PilotInput {
  goal: string;
  startUrl: string;
  maxSteps: number;
  guard: boolean;
  guardThreshold: number;
  page: Page;
  ask: Ask;
  signal: AbortSignal;
  onStep(step: BrowserStep): void;
  confirm(title: string, body: string): Promise<boolean>;
}

const MAX_ELEMENTS = 80;
const MAX_TYPE_TARGETS = 4;
const MAX_PHRASES = 4;
const PAGE_TEXT_CHARS = 2500;
/** At or above this, Jev thinks the goal is met on the current page. */
const DONE_THRESHOLD = 0.75;

/** Phrases worth typing, taken from the goal. The closed list is what keeps Jev honest. */
export function phrasesFrom(goal: string): string[] {
  const out: string[] = [];
  const add = (s: string | undefined) => {
    const t = (s ?? '').trim().replace(/[.?!,;]+$/, '');
    if (t.length > 0 && t.length <= 120 && !out.includes(t)) out.push(t);
  };
  for (const m of goal.matchAll(/["“']([^"”']{1,120})["”']/g)) add(m[1]);
  for (const m of goal.matchAll(/\b(?:search(?: for)?|look up|find|type|enter)\s+(.+?)(?:\s+(?:and|then|on|in)\s|[.;,\n]|$)/gi)) {
    // A quoted phrase was taken whole by the pass above.
    if (!/["“”']/.test(m[1] ?? '')) add(m[1]);
  }
  if (out.length === 0 && goal.trim().length <= 80) add(goal);
  return out.slice(0, MAX_PHRASES);
}

function describe(el: PageElement): string {
  const label = el.text === '' ? (el.name ?? el.tag) : el.text;
  const where = el.href !== undefined ? ` (goes to ${el.href.slice(0, 100)})` : '';
  return `${el.kind} "${label.slice(0, 80)}"${where}`;
}

export interface Candidate {
  key: string;
  action: Action;
  description: string;
}

/** Every action on offer for one snapshot, keyed for a Jev Choice. */
export function candidatesFor(snap: PageSnapshot, goal: string): Candidate[] {
  const out: Candidate[] = [];
  const els = [...snap.elements].sort((a, b) => Number(b.inViewport) - Number(a.inViewport)).slice(0, MAX_ELEMENTS);
  const phrases = phrasesFrom(goal);
  let typeTargets = 0;
  for (const el of els) {
    if (el.kind === 'input' || el.kind === 'textarea') {
      if (['submit', 'button', 'checkbox', 'radio', 'hidden', 'file', 'image', 'reset'].includes(el.inputType ?? 'text')) {
        out.push({ key: `click_${el.id}`, action: { kind: 'click', elementId: el.id }, description: `Click ${describe(el)}` });
        continue;
      }
      if (typeTargets >= MAX_TYPE_TARGETS) continue;
      typeTargets += 1;
      // A search box can be a textarea (DuckDuckGo's is). Without Enter, the text sat there and the
      // browser clicked around it for eight steps.
      const submit = el.kind === 'input' || /^q$|search/i.test(el.name ?? '') || /search/i.test(el.text);
      phrases.forEach((p, i) => {
        out.push({
          key: `type_${el.id}_${String(i)}`,
          action: { kind: 'type', elementId: el.id, text: p, submit },
          description: `Type "${p}" into ${describe(el)}${submit ? ' and press Enter' : ''}`,
        });
      });
    } else if (el.kind === 'link' || el.kind === 'button' || el.kind === 'other') {
      out.push({ key: `click_${el.id}`, action: { kind: 'click', elementId: el.id }, description: `Click ${describe(el)}` });
    }
  }
  out.push({ key: 'scroll', action: { kind: 'scroll' }, description: 'Scroll down to see more of this page' });
  if (snap.canGoBack) out.push({ key: 'back', action: { kind: 'back' }, description: 'Go back to the previous page' });
  out.push({ key: 'done', action: { kind: 'done' }, description: 'Stop: the goal is achieved on this page' });
  out.push({ key: 'fail', action: { kind: 'fail' }, description: 'Stop: the goal cannot be achieved from here' });
  // A Jev Choice takes at most 255 options.
  return out.slice(0, 255);
}

export const GUARD_QUESTION =
  'Could performing `action` on this page cause a harmful or irreversible effect: spending money, placing an order, deleting data, sending a message or email, posting publicly, changing account or security settings, or entering a password or payment details?';

export interface PilotResult {
  ok: boolean;
  output: string;
  steps: BrowserStep[];
}

export async function pilot(input: PilotInput): Promise<PilotResult> {
  const steps: BrowserStep[] = [];
  const history: string[] = [];
  const record = (step: BrowserStep) => {
    steps.push(step);
    input.onStep(step);
  };
  await input.page.open(input.startUrl);
  let snap = await input.page.snapshot();

  // A success hands the page to the agent that answers from it. A failure is read by a person, who
  // wants where it stopped and what it tried, not a whole page of text.
  const summary = (why: string, pageChars = 4000) =>
    `${why}\n\nPage: ${snap.title}\nURL: ${snap.url}\n\nSteps taken:\n${history.length === 0 ? '(none)' : history.map((h, i) => `${String(i + 1)}. ${h}`).join('\n')}${pageChars === 0 ? '' : `\n\nPage text:\n${snap.text.slice(0, pageChars)}`}`;
  /** What was already tried on each URL. Offering it again is how the browser looped. */
  const tried = new Map<string, Set<string>>();

  for (let n = 1; n <= input.maxSteps; n += 1) {
    if (input.signal.aborted) return { ok: false, output: summary('Stopped.', 0), steps };
    const done = tried.get(snap.url) ?? new Set<string>();
    const candidates = candidatesFor(snap, input.goal).filter((c) => c.key === 'scroll' || !done.has(c.key));
    const state = {
      goal: input.goal,
      page: { url: snap.url, title: snap.title, text: snap.text.slice(0, PAGE_TEXT_CHARS) },
      steps_so_far: history,
    };
    const res = await input.ask(
      state,
      {
        next: {
          type: 'choice',
          instructions: 'Which one action on this page moves most directly toward the `goal`? Avoid repeating a step in `steps_so_far` that did not help.',
          criteria: Object.fromEntries(candidates.map((c) => [c.key, c.description])),
        },
        achieved: {
          type: 'noul',
          instructions: 'Is the `goal` already achieved: does the current `page` show what the goal asks for?',
        },
      },
      input.signal,
    );
    const achieved = res.answers['achieved']?.noul ?? 0;
    const choice = res.answers['next'];
    const picked = candidates.find((c) => c.key === choice?.choice);
    const confidence = choice?.confidence ?? 0;

    if (achieved >= DONE_THRESHOLD || picked?.action.kind === 'done') {
      record({ n, url: snap.url, action: 'Stop: goal achieved', why: `Jev: goal met with p=${achieved.toFixed(2)}`, confidence, outcome: 'done' });
      return { ok: true, output: summary('The goal looks achieved.'), steps };
    }
    if (picked === undefined || picked.action.kind === 'fail') {
      record({ n, url: snap.url, action: 'Stop: cannot proceed', why: 'Jev found no action that moves toward the goal.', confidence, outcome: 'failed' });
      return { ok: false, output: summary('Could not find a way to the goal from here.', 0), steps };
    }

    let risk: number | undefined;
    let outcome: BrowserStep['outcome'] = 'ran';
    if (input.guard && (picked.action.kind === 'click' || picked.action.kind === 'type')) {
      const g = await input.ask(
        { goal: input.goal, page: { url: snap.url, title: snap.title }, action: picked.description },
        { risky: { type: 'noul', instructions: GUARD_QUESTION } },
        input.signal,
      );
      risk = g.answers['risky']?.noul ?? 1;
      if (risk >= input.guardThreshold) {
        const approved = await input.confirm(
          'The browser wants to do something risky',
          `${picked.description}\n\nOn ${snap.url}\nJev rates the risk at ${(risk * 100).toFixed(0)}%. Allow it?`,
        );
        if (!approved) {
          record({ n, url: snap.url, action: picked.description, why: 'You refused a risky action.', confidence, risk, outcome: 'refused' });
          return { ok: false, output: summary(`Stopped before a risky action you refused: ${picked.description}`, 0), steps };
        }
        outcome = 'approved';
      }
    }

    tried.set(snap.url, done.add(picked.key));
    try {
      await input.page.perform(picked.action);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      record({ n, url: snap.url, action: picked.description, why: msg, confidence, ...(risk === undefined ? {} : { risk }), outcome: 'failed' });
      history.push(`${picked.description} (failed: ${msg})`);
      snap = await input.page.snapshot();
      continue;
    }
    record({ n, url: snap.url, action: picked.description, why: `Jev picked it with confidence ${confidence.toFixed(2)}`, confidence, ...(risk === undefined ? {} : { risk }), outcome });
    history.push(picked.description);
    snap = await input.page.snapshot();
  }
  return { ok: false, output: summary(`Reached the limit of ${String(input.maxSteps)} steps before the goal.`, 0), steps };
}
