/**
 * Session chrome — the frame around a conversation, as opposed to the conversation.
 *
 * `army chat` used to print six left-aligned lines and then a bare prompt, and that was the
 * whole of its interface. Everything a reader needed in order to know WHERE they were — which
 * branch the repository is on, whether it is dirty, which model is answering, what has been
 * dispatched so far, whether anything is running right now — was either never printed or printed
 * once, at the top, and then scrolled off the screen by the first long answer.
 *
 * This file draws three things, and it is the only file that knows how they look:
 *
 * - **the header** — the boxed identity block a session opens with. Printed once.
 * - **the status bar** — one or two rows pinned under the composer, repainted in place, carrying
 *   the branch, the loadout and the cost. This is the answer to "where am I", and it is the row
 *   that has to stay on screen.
 * - **the roster** — one row per unit currently in flight, with its own elapsed clock. This is
 *   the answer to "what is running", and before it existed a dispatch was a five-minute silence
 *   with a single spinner in it.
 *
 * ## Pure, exactly like `render.ts` and `progress.ts`
 *
 * Nothing here reads `process.env`, asks whether a stream is a TTY, or calls a clock. Charset,
 * colour, width, elapsed milliseconds and the animation frame all arrive as arguments. That is
 * what makes "does the status bar fit in 40 columns under NO_COLOR on a codepage-437 console" a
 * unit test rather than a manual ritual — and it is load-bearing here in a way it is not in the
 * tree renderer, because these rows are repainted several times a second and a row that is one
 * column too wide wraps, which silently breaks the cursor arithmetic in `src/chat/io.ts`.
 *
 * **Every row this file returns is clipped to `width - 1`.** Not `width`: a glyph printed into the
 * final column leaves a terminal in the wrap-pending state, and the status block is painted with
 * relative cursor movement (`ESC[nA`) that counts rows. One wrapped row and every count below it
 * is off by one, which shows up as the header being eaten a line at a time.
 *
 * ## Model-controlled text
 *
 * A branch name comes from a repository, a unit's role does not — but an objective does come from
 * a model, and one of these rows carries one. Anything of that provenance goes through `sanitize`
 * from `progress.ts` before it is placed, for the reason stated there: a string containing `\r`
 * would overwrite the row that says which unit it belongs to.
 */

import type { Rank, Role } from '../contracts/ranks.ts';
import { formatUnit } from '../contracts/ranks.ts';

import { formatTokens, sanitize } from './progress.ts';
import type { Charset, Glyphs, Ink } from './render.ts';
import {
  SPINNER_FRAMES,
  asciiFold,
  clipTo,
  displayWidth,
  glyphsFor,
  padTo,
  paintInk,
} from './render.ts';

/**
 * How long a reported action may stand before the row starts dating it.
 *
 * Below this, "what it is doing" and "what it just did" are the same answer and a timestamp is
 * clutter. Above it, they diverge — and the reference run's reasoning gaps ran to 248 seconds.
 */
const STALE_DETAIL_MS = 10_000;

/**
 * How long a unit may emit NOTHING before the bar says so.
 *
 * The harness reports reasoning tokens roughly every 1.5 seconds while a model thinks, so silence
 * on this scale is not thinking — it is a stalled process, a hung tool, or a network wait, and it
 * is the one thing a watching human cannot otherwise distinguish from progress.
 */
const STALL_MS = 45_000;

// ---------------------------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------------------------

export interface ChromeStyle {
  charset: Charset;
  color: boolean;
  /** Terminal columns. Never sniffed here; the caller decides once and passes it down. */
  width: number;
}

/** Below this there is no room for two columns of anything, and every row is a single clipped run. */
const MIN_WIDTH = 24;

interface Ctx {
  g: Glyphs;
  style: ChromeStyle;
  /** Usable columns — one held back, for the wrap-pending reason in the header above. */
  width: number;
}

function contextOf(style: ChromeStyle): Ctx {
  return {
    g: glyphsFor(style.charset),
    style,
    width: Math.max(MIN_WIDTH, style.width) - 1,
  };
}

function fold(ctx: Ctx, text: string): string {
  return ctx.style.charset === 'ascii' ? asciiFold(text) : text;
}

function paint(ctx: Ctx, ink: Ink, text: string): string {
  return paintInk(ctx.style.color, ink, text);
}

/** Fold, then clip, then paint — in that order, always. See the header on measuring painted text. */
function row(ctx: Ctx, ink: Ink | null, text: string): string {
  const plain = clipTo(fold(ctx, text), ctx.width, ctx.g.ellipsis);
  return ink === null ? plain : paint(ctx, ink, plain);
}

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

/**
 * `47s`, `1m12s`, `1h04m` — an elapsed clock, not a duration.
 *
 * Deliberately NOT `formatDuration` from `render.ts`, which drops to a single unit (`1m` for
 * anything from 60s to 119s). That is the right answer for "this campaign was silent for 2h",
 * and the wrong one for a clock a human is watching tick: a reader looking at a working Engineer
 * needs to see the number move every second, and `1m` sitting still for a minute is exactly the
 * "has this hung?" question the roster exists to answer.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${String(hours)}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`;
  return `${String(seconds)}s`;
}

// ---------------------------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------------------------

export interface HeaderModel {
  /** The line inside the box. Short — it is the session's identity, not its documentation. */
  title: string;
  /** The line under the title, inside the box. */
  subtitle: string;
  /** `key   value` rows under the box. Keys are padded to the widest; empty values are dropped. */
  facts: ReadonlyArray<{ key: string; value: string }>;
  /** Dim rows under the facts — the keystrokes that work, and nothing else. */
  hints: readonly string[];
}

/**
 * The boxed identity block, as an array of lines with no trailing newline.
 *
 * The box is sized to its CONTENT, not to the terminal: a 200-column window drawing a
 * 200-column-wide box around eleven words looks like a mistake, and every other tool that draws
 * one caps it. It is capped at `MAX_BOX` or the usable width, whichever is smaller.
 */
export function renderHeader(model: HeaderModel, style: ChromeStyle): string[] {
  const ctx = contextOf(style);
  const g = ctx.g;
  const MAX_BOX = 72;

  const title = fold(ctx, model.title);
  const subtitle = fold(ctx, model.subtitle);
  // Four columns go to the frame: a corner and a space at each edge. The terminal's width is a
  // HARD bound here and `MIN_WIDTH` is not — a floor applied to the inner width is a floor on the
  // whole box, and a 24-column window was drawing a 28-column box that wrapped every row of it.
  const inner = Math.max(1, Math.min(Math.max(title.length, subtitle.length), MAX_BOX, ctx.width - 4));

  const edge = (left: string, right: string): string =>
    paint(ctx, 'grey', `${left}${g.boxH.repeat(inner + 2)}${right}`);
  const inside = (text: string, ink: Ink | null): string => {
    const clipped = clipTo(text, inner, g.ellipsis);
    const body = ink === null ? padTo(clipped, inner, 'left') : paint(ctx, ink, clipped) + ' '.repeat(inner - clipped.length);
    return `${paint(ctx, 'grey', g.boxV)} ${body} ${paint(ctx, 'grey', g.boxV)}`;
  };

  const lines: string[] = ['', edge(g.boxTL, g.boxTR), inside(title, 'bold')];
  if (subtitle !== '') lines.push(inside(subtitle, 'grey'));
  lines.push(edge(g.boxBL, g.boxBR), '');

  const facts = model.facts.filter((fact) => fact.value !== '');
  if (facts.length > 0) {
    const keyWidth = Math.max(...facts.map((fact) => fact.key.length));
    for (const fact of facts) {
      lines.push(
        `  ${paint(ctx, 'grey', padTo(fold(ctx, fact.key), keyWidth, 'left'))}  ` +
          clipTo(fold(ctx, fact.value), Math.max(8, ctx.width - keyWidth - 4), g.ellipsis),
      );
    }
    lines.push('');
  }
  for (const hint of model.hints) lines.push(row(ctx, 'grey', `  ${hint}`));
  if (model.hints.length > 0) lines.push('');
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The repository, as the status bar sees it
// ---------------------------------------------------------------------------------------------

/**
 * What a working copy looks like from outside.
 *
 * Every field is nullable and null means UNKNOWN, never zero: a repository whose `git status`
 * timed out has an unknown dirty count, and rendering that as `clean` is the one failure mode a
 * status bar must not have — a human reads "clean" and skips the check they were about to do.
 */
export interface RepoState {
  /** Branch name, or null at a detached HEAD. */
  branch: string | null;
  /** Short commit id. */
  head: string | null;
  /** Paths `git status --porcelain` reported, or null when it could not be asked. */
  dirty: number | null;
  /** Commits on HEAD that the upstream does not have, or null when there is no upstream. */
  ahead: number | null;
  /** Commits on the upstream that HEAD does not have. */
  behind: number | null;
}

export const REPO_UNKNOWN: RepoState = {
  branch: null,
  head: null,
  dirty: null,
  ahead: null,
  behind: null,
};

/**
 * `main*` / `main ↑2` / `main*↑2↓1` / `HEAD@a1b2c3d` / `no branch`.
 *
 * Compressed on purpose — this is one segment of a one-row bar, and the words it would take to
 * spell out ("3 files modified, 2 commits ahead") are words that push the cost and the loadout
 * off the right-hand edge on an 80-column terminal. The header spells the same state out in full
 * at session start, where there is room for it.
 */
export function formatRepo(state: RepoState, glyphs: Glyphs): string {
  const name = state.branch ?? (state.head === null ? 'no branch' : `${glyphs.none}${state.head}`);
  // `*` for dirty and NOTHING for clean, rather than a tick for clean: a bar is scanned, not read,
  // and the only state worth a mark is the one that changes what a dispatch will pick up. A mark
  // on the quiet state is a mark the eye learns to skip, which costs the loud one its meaning.
  const dirty = state.dirty !== null && state.dirty > 0 ? '*' : '';
  const ahead = state.ahead !== null && state.ahead > 0 ? `${glyphs.ahead}${String(state.ahead)}` : '';
  const behind =
    state.behind !== null && state.behind > 0 ? `${glyphs.behind}${String(state.behind)}` : '';
  return `${name}${dirty}${ahead}${behind}`;
}

/** The same state, spelled out for the header, where there is room for words. */
export function describeRepo(state: RepoState): string {
  if (state.branch === null && state.head === null) return '';
  const parts: string[] = [state.branch ?? `detached at ${state.head ?? '?'}`];
  if (state.branch !== null && state.head !== null) parts.push(state.head);
  if (state.dirty === null) parts.push('working copy not read');
  else parts.push(state.dirty === 0 ? 'clean' : `${String(state.dirty)} uncommitted`);
  if (state.ahead !== null && state.ahead > 0) parts.push(`${String(state.ahead)} ahead`);
  if (state.behind !== null && state.behind > 0) parts.push(`${String(state.behind)} behind`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------------------------

export const ROSTER_STATES = ['working', 'returned', 'passed', 'failed'] as const;
export type RosterState = (typeof ROSTER_STATES)[number];

export interface RosterUnit {
  agentId: string;
  rank: Rank;
  role: Role;
  harness: string;
  attempt: number;
  state: RosterState;
  /** Milliseconds this unit has been in whatever state it is in. */
  elapsedMs: number;
  /**
   * What the unit is doing, or last did: `Write(lib/html.js)` while it works, its report summary
   * once it has returned. Model-controlled either way; sanitised before it is placed.
   */
  detail: string | null;
  /**
   * How long `detail` has been the answer, or `null` when nothing has been reported yet.
   *
   * Shown once it goes stale, and that is the point of carrying it. A tool call finishing does not
   * clear the row — a blank row through a four-minute reasoning gap is the complaint this whole
   * block exists to answer — so the row keeps saying `Write(lib/html.js)` and this is what stops
   * that from being a lie about the present tense.
   */
  detailAgeMs: number | null;
  /**
   * Cumulative reasoning tokens the harness has reported, or `null` when it reports none.
   *
   * `null` renders as absent, NEVER as `0`. A harness that does not report reasoning telemetry and
   * a model that has done no reasoning are different facts, and the bar may not merge them.
   */
  thinkingTokens: number | null;
  /**
   * Milliseconds since ANY event arrived for this unit, or `null` when unknown.
   *
   * Rendered only once it crosses `STALL_MS`. Below that it is noise; above it, it is the one
   * number that distinguishes a model thinking hard from a process that has hung — which, before
   * any of this existed, a reader could only tell by waiting.
   */
  silentMs: number | null;
}

const ROSTER_INK: Record<RosterState, Ink> = {
  working: 'cyan',
  returned: 'grey',
  passed: 'green',
  failed: 'red',
};

/**
 * One row per unit in flight, spinner and clock included.
 *
 * `tick` rather than a clock: the frame is chosen by the caller's animation counter, so this
 * function is a pure map from (roster, tick) to rows and a test can assert on frame 0.
 */
export function renderRoster(
  units: readonly RosterUnit[],
  tick: number,
  style: ChromeStyle,
): string[] {
  const ctx = contextOf(style);
  const g = ctx.g;
  const frames = SPINNER_FRAMES[ctx.style.charset];
  return units.map((unit) => {
    const mark =
      unit.state === 'working'
        ? (frames[tick % frames.length] as string)
        : unit.state === 'failed'
          ? g.warn
          : g.bullet;
    const label = `${formatUnit(unit.rank, unit.role)} ${g.bullet} ${unit.agentId}`;
    const attempt = unit.attempt > 1 ? ` #${String(unit.attempt)}` : '';
    const clock = unit.state === 'working' ? ` ${formatElapsed(unit.elapsedMs)}` : '';
    // The detail is what is LEFT after the fixed part is placed, never the other way round: a
    // returned unit's summary is model-controlled and arbitrarily long, and letting it size the
    // row is letting a model push the unit's own id off the screen.
    const head = `  ${mark} ${label}${attempt} ${unit.state}${clock}`;
    const roomForDetail = ctx.width - displayWidth(head) - 3;
    const detail =
      unit.detail === null || roomForDetail < 8
        ? ''
        : ` ${g.dash} ${clipTo(sanitize(unit.detail), roomForDetail, g.ellipsis)}`;
    return row(ctx, ROSTER_INK[unit.state], `${head}${detail}${liveness(unit, ctx, roomForDetail)}`);
  });
}

/**
 * How long the row has been telling the truth, and whether anything is still arriving.
 *
 * Only ever appended to a WORKING row: a returned unit's detail is its final summary, and dating
 * it would say "this finished four minutes ago" in a slot the reader is using to read what it
 * found. Everything here is `null`-guarded because unknown is a real state — a harness that
 * reports no reasoning tokens must produce an absent segment, never `thinking 0`.
 */
function liveness(unit: RosterUnit, ctx: Ctx, roomForDetail: number): string {
  if (unit.state !== 'working') return '';
  const g = ctx.g;
  const parts: string[] = [];
  if (unit.detailAgeMs !== null && unit.detailAgeMs >= STALE_DETAIL_MS) {
    parts.push(`${formatElapsed(unit.detailAgeMs)} ago`);
  }
  if (unit.thinkingTokens !== null) parts.push(`thinking ${formatTokens(unit.thinkingTokens)}`);
  if (unit.silentMs !== null && unit.silentMs >= STALL_MS) {
    parts.push(`silent ${formatElapsed(unit.silentMs)}`);
  }
  if (parts.length === 0) return '';
  const text = ` ${g.bullet} ${parts.join(` ${g.bullet} `)}`;
  // Sized against whatever the detail did NOT use. A liveness segment that pushes the row over
  // the width would wrap it, and a wrapped row breaks the `ESC[nA` count for every row below.
  const spare = roomForDetail - (unit.detail === null ? 0 : displayWidth(sanitize(unit.detail)) + 3);
  return displayWidth(text) <= Math.max(0, spare) ? text : '';
}

// ---------------------------------------------------------------------------------------------
// The status bar
// ---------------------------------------------------------------------------------------------

export interface StatusModel {
  repo: RepoState;
  /** Repository directory name — the project, as a human says its name. */
  project: string;
  /** The commander's model id, as configured. Empty when the harness picked its own default. */
  model: string;
  /** The rung a dispatch will ask for, and the label for it. */
  rung: string;
  /** Human turns so far. */
  turns: number;
  /** Dispatches approved so far. */
  dispatches: number;
  /** Session cost in USD, or null when the harness has not reported one yet. */
  costUsd: number | null;
  /** Units in flight, newest last. Empty between dispatches. */
  roster: readonly RosterUnit[];
  /** Shown instead of the counters while something is blocking on a keystroke. */
  hint: string | null;
}

/** `$0.41`, and never `$0.00` for a session that has spent something too small to show. */
function formatCost(usd: number): string {
  if (usd <= 0) return '$0';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

function countLabel(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** One segment of the context row: its text, and how it is painted when it survives the budget. */
interface Segment {
  text: string;
  ink: Ink;
}

/**
 * Fit as many segments as the width allows, in order, and DROP the rest.
 *
 * Not clipped with an ellipsis, which is what every other renderer in this program does and what
 * this one did first. The difference is that the tree's rows are read once and this one is read
 * at a glance, hundreds of times, out of the corner of an eye — and `rung 2 (pull req…` is worse
 * than absent, because a half-word costs a reader the fraction of a second they were spending on
 * the whole row. Segments are ordered so that what goes first is what a reader most needs: where
 * they are, then how far a dispatch may go, then what the session has cost.
 *
 * The one exception is the FIRST segment, which is clipped rather than dropped. A bar with no
 * branch on it is a bar that has lost the thing it exists to say, and on a terminal too narrow
 * for a branch name the honest answer is a clipped branch name.
 */
function fitSegments(segments: readonly Segment[], ctx: Ctx): string {
  // The separator is measured PLAIN and painted only at the join. Budgeting against the painted
  // form would have charged eleven invisible bytes per gap against a column count, which is the
  // same class of mistake `clipTo`'s own note warns about, one indirection further out.
  const separator = ` ${ctx.g.bullet} `;
  const budget = ctx.width - 2;
  const kept: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    const cost = (kept.length === 0 ? 0 : separator.length) + segment.text.length;
    if (kept.length > 0 && used + cost > budget) continue;
    kept.push(segment);
    used += cost;
  }
  const first = kept[0];
  if (first !== undefined) first.text = clipTo(first.text, budget, ctx.g.ellipsis);
  return `  ${kept
    .map((segment) => paint(ctx, segment.ink, segment.text))
    .join(paint(ctx, 'grey', separator))}`;
}

/**
 * The block pinned under the composer: the roster first, the context row last.
 *
 * Order matters and is not aesthetic. The context row is the one that must never move, because a
 * human's eye learns where it is; the roster grows and shrinks as units come and go. Putting the
 * roster ABOVE means the row that changes height pushes against the transcript, which is already
 * scrolling, rather than against the row nobody wants to have to hunt for.
 */
export function renderStatusBar(model: StatusModel, tick: number, style: ChromeStyle): string[] {
  const ctx = contextOf(style);
  const g = ctx.g;

  // The branch is the one segment that is not grey. It is the fact this bar was added for, it is
  // the fact that changes without the reader doing anything, and a row of uniform dim text has no
  // way to say which of its six facts is the one to look at.
  const segments: Segment[] = [{ text: fold(ctx, formatRepo(model.repo, g)), ink: 'cyan' }];
  // SECOND, ahead of every standing fact, and yellow. A hint is a rule about the key the reader
  // is about to press, true for the next few seconds rather than for the session — and it was
  // last here until an 80-column terminal showed what that costs: `Ctrl-C lets the dispatch
  // settle` is the one row on this bar with a deadline, and it was the first thing dropped.
  if (model.hint !== null) segments.push({ text: fold(ctx, model.hint), ink: 'yellow' });
  segments.push({ text: fold(ctx, model.project), ink: 'grey' });
  if (model.model !== '') segments.push({ text: fold(ctx, model.model), ink: 'grey' });
  segments.push({ text: fold(ctx, model.rung), ink: 'grey' });
  // Displaced by a hint rather than queued behind one: a turn count is the least urgent thing
  // here and there is no width at which it should cost the reader the branch or the rule.
  if (model.hint === null) {
    if (model.turns > 0) {
      segments.push({ text: countLabel(model.turns, 'turn', 'turns'), ink: 'grey' });
    }
    if (model.dispatches > 0) {
      segments.push({ text: countLabel(model.dispatches, 'dispatch', 'dispatches'), ink: 'grey' });
    }
    if (model.costUsd !== null) segments.push({ text: formatCost(model.costUsd), ink: 'grey' });
  }

  return [...renderRoster(model.roster, tick, style), fitSegments(segments, ctx)];
}
