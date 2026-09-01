/**
 * `army view` — tree model in, strings out.
 *
 * **This file is pure**, exactly like `tree.ts`: it never reads `process.env`, never asks whether
 * stdout is a TTY and never calls a clock. Charset, colour and width all arrive as arguments,
 * decided once by `index.ts`. That separation is what makes "does this render correctly under
 * `NO_COLOR` on a 40-column Windows console" a unit test rather than a manual ritual.
 *
 * ## Why there is an ASCII mode at all
 *
 * The rank glyphs — ☆ ◆ ◈ ◇ ▪ · — and the box-drawing characters ├ └ │ are U+2500-block and
 * U+25xx-block characters. A default Windows `cmd.exe` runs codepage 437 or 850, where none of
 * them exist: the console does not fall back, it prints replacement junk, and the tree becomes
 * unreadable in exactly the environment that has never been tested. So there is a
 * complete ASCII glyph set, it is chosen automatically, and there is a flag to force either way.
 * `asciiFold` also rewrites the model's own text, because a task title someone typed in a UTF-8
 * editor breaks that console just as thoroughly as a box-drawing character does.
 *
 * ## Layout rules
 *
 * - **Rank and depth are separate columns** and neither is ever dropped. The reader must be
 *   able to see a CPT at depth 4 without doing arithmetic, so the gap gets its own column and a
 *   `!` marker, and when the terminal is too narrow for a gap column the marker moves onto the
 *   depth cell rather than disappearing.
 * - **Truncate, never wrap.** A wrapped tree loses the one thing a tree is for: the eye following
 *   an indent down a column. Long labels get an ellipsis; the structure survives.
 * - Terminal width is never assumed. The caller supplies it or it defaults to 80, and the column
 *   set is chosen from the width rather than from a guess about what people have.
 */

import type { Rank } from '../contracts/ranks.ts';
import { RANK_ABBREV, RANK_GLYPH } from '../contracts/ranks.ts';

import type { TaskNodeView, TreeModel, UnitNode, UnitState, WalkedRow } from './tree.ts';
import { walkTree } from './tree.ts';

// ---------------------------------------------------------------------------------------------
// Charset
// ---------------------------------------------------------------------------------------------

export const CHARSETS = ['unicode', 'ascii'] as const;
export type Charset = (typeof CHARSETS)[number];

export interface Glyphs {
  ranks: Record<Rank, string>;
  /** Task marker — tasks are intent, not units, and must not borrow a rank glyph. */
  task: string;
  branch: string;
  lastBranch: string;
  vertical: string;
  blank: string;
  ellipsis: string;
  bullet: string;
  dash: string;
  arrow: string;
  warn: string;
  none: string;
  /**
   * The frame around the session header.
   *
   * Separate keys from `branch`/`vertical` above, which carry their own trailing padding because
   * a tree prefix is built by concatenation. A box corner is placed by column arithmetic and must
   * be exactly one character wide, so sharing the tree's keys would have made the header's width
   * budget silently wrong by two columns per row.
   */
  boxH: string;
  boxV: string;
  boxTL: string;
  boxTR: string;
  boxBL: string;
  boxBR: string;
  /** Commits a branch has that its upstream does not, and the other way round: `main↑2↓1`. */
  ahead: string;
  behind: string;
  /**
   * A tool call in the activity feed.
   *
   * Deliberately NOT `bullet`: a tool line and a note line sit next to each other in scrollback,
   * and one is a thing the worker did while the other is a thing the supervisor observed. Sharing
   * a mark would make the feed unreadable at exactly the density it is meant for.
   */
  tool: string;
  /** A tool call the permission layer refused. */
  blocked: string;
}

/**
 * The animation, per charset — one table, three callers.
 *
 * `src/chat/io.ts` (the composer's busy spinner), `src/view/progress.ts` (the campaign ticker)
 * and `src/view/chrome.ts` (the roster in the status bar) all animate on the same screen, often
 * within a second of each other. They each used to carry their own copy, and the two that
 * existed had already drifted: the ASCII rows spun in opposite directions.
 */
export const SPINNER_FRAMES: Record<Charset, readonly string[]> = {
  unicode: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  ascii: ['-', '\\', '|', '/'],
};

export const UNICODE_GLYPHS: Glyphs = {
  ranks: RANK_GLYPH,
  task: '▸',
  branch: '├─ ',
  lastBranch: '└─ ',
  vertical: '│  ',
  blank: '   ',
  ellipsis: '…',
  bullet: '·',
  dash: '–',
  arrow: '→',
  warn: '!',
  none: '—',
  boxH: '─',
  boxV: '│',
  boxTL: '╭',
  boxTR: '╮',
  boxBL: '╰',
  boxBR: '╯',
  ahead: '↑',
  behind: '↓',
  tool: '⏺',
  blocked: '⊘',
};

/**
 * Distinct at a glance in a 437 codepage, and ordered by visual weight the same way the Unicode
 * set is: a General is the biggest mark on the page, a Private the smallest.
 */
export const ASCII_GLYPHS: Glyphs = {
  ranks: { GENERAL: '*', COLONEL: '#', MAJOR: '%', CAPTAIN: 'o', SERGEANT: '+', PRIVATE: '.' },
  task: '>',
  branch: '|- ',
  lastBranch: '`- ',
  vertical: '|  ',
  blank: '   ',
  ellipsis: '...',
  bullet: '-',
  dash: '-',
  arrow: '->',
  warn: '!',
  none: '-',
  boxH: '-',
  boxV: '|',
  boxTL: '+',
  boxTR: '+',
  boxBL: '+',
  boxBR: '+',
  ahead: '^',
  behind: 'v',
  tool: '*',
  blocked: 'x',
};

export function glyphsFor(charset: Charset): Glyphs {
  return charset === 'ascii' ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

const FOLD: Record<string, string> = {
  '·': '.',
  '…': '...',
  '–': '-',
  '—': '-',
  '→': '->',
  '☆': '*',
  '◆': '#',
  '◈': '%',
  '◇': 'o',
  '▪': '+',
  '▸': '>',
  '▌': '|',
  '│': '|',
  '├': '|',
  '└': '`',
  '─': '-',
  '╭': '+',
  '╮': '+',
  '╰': '+',
  '╯': '+',
  '↑': '^',
  '↓': 'v',
  '⏺': '*',
  '⊘': 'x',
  '⚠': '!',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
};

/**
 * Make a string safe for a codepage-437 console.
 *
 * Known decoration is transliterated; anything else outside printable ASCII becomes `?`. That is
 * lossy on purpose — a `?` is a legible admission that a character could not be shown, whereas
 * passing the original byte through produces a different, wrong glyph with no indication that
 * anything happened. Applied to user text too, since that is where the surprising characters are.
 */
export function asciiFold(text: string): string {
  let out = '';
  for (const char of text) {
    const mapped = FOLD[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e ? char : '?';
  }
  return out;
}

/**
 * `asciiFold` over a document, a line at a time.
 *
 * ONE LINE IS THE UNIT `asciiFold` WORKS ON, and the reason is `0x0A`. Everything outside
 * `0x20..0x7e` that is not in `FOLD` becomes `?`, and a newline is outside it — so folding a
 * multi-line block collapses the whole thing into a single row with `?` where each break was.
 * Measured: the alignment gate on an ascii terminal arrived as ONE 582-column row beginning
 * `?  o alignment gate?    ok  spec...`. Every other caller of `asciiFold` hands it a single line
 * or a single glyph, which is why the hazard sat there unnoticed.
 *
 * Split on `\n` rather than on every line terminator: `\r` is a cursor control this codebase emits
 * deliberately and never a document break, and a fold that silently turned one into a row boundary
 * would corrupt the composer's own repaint.
 */
export function asciiFoldBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => asciiFold(line))
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

/**
 * The one colour table in this program.
 *
 * Exported because it already had a rival: `src/chat/io.ts` carried a five-entry copy for the
 * composer, and `src/view/chrome.ts` would have needed a third for the session chrome. Three
 * tables is three chances for `dim` to mean something different on three surfaces of one screen,
 * and the drift is silent — nothing tests that two escape sequences agree.
 */
export const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  grey: '\u001b[90m',
} as const;

export type Ink = keyof typeof ANSI;

/**
 * Wrap `text` in one SGR pair, or return it untouched.
 *
 * Empty text is never painted: an SGR pair around nothing occupies no columns but is not nothing
 * — it is two escape sequences in a string somebody is about to measure, and a padding cell
 * carrying colour is a cell that bleeds into whatever gets appended after it.
 */
export function paintInk(color: boolean, ink: Ink, text: string): string {
  if (!color || text.length === 0) return text;
  return `${ANSI[ink]}${text}${ANSI.reset}`;
}

// ---------------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------------

/**
 * Code point ranges a terminal draws two columns wide (East Asian Wide and Fullwidth).
 *
 * There is no `\p{East_Asian_Width=Wide}` in JavaScript's regex property escapes, so the table is
 * spelled out. `\p{Extended_Pictographic}` DOES exist and covers emoji, which is why no emoji
 * block appears here — see `isWide`.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compatibility Jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Miscellaneous symbols and pictographs, emoticons
  [0x1f900, 0x1f9ff], // Supplemental symbols and pictographs
  [0x20000, 0x2fffd], // CJK Unified Ideographs Extension B+
  [0x30000, 0x3fffd], // CJK Unified Ideographs Extension G+
];

/** Occupies no column: combining marks, enclosing marks, and format characters such as ZWJ. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
/** Emoji and friends, which every modern terminal draws double-wide. */
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;

function isWide(code: number, char: string): boolean {
  for (const [lo, hi] of WIDE_RANGES) {
    if (code < lo) return false; // the table is sorted, so nothing further can match
    if (code <= hi) return true;
  }
  return PICTOGRAPHIC.test(char) && code >= 0x1f000;
}

/** How many terminal columns one code point occupies: 0, 1 or 2. */
function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  // C0/C1 and DEL move the cursor or do nothing; neither is a column. `sanitize` should have
  // removed them long before here, so this is a floor rather than a policy.
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return 0;
  if (ZERO_WIDTH.test(char)) return 0;
  return isWide(code, char) ? 2 : 1;
}

/**
 * How many terminal columns `text` occupies.
 *
 * ## Why this is not `text.length`
 *
 * `src/view/chrome.ts` states that exact column counting is load-bearing: every row it emits is
 * clipped to `width - 1` because a row that wraps adds a physical line the `ESC[nA` arithmetic in
 * `src/chat/io.ts` does not know about, and from then on the cursor is permanently one row adrift
 * — silently, for the rest of the session. `String.length` counts UTF-16 code units, which is
 * wrong three separate ways: an emoji is two units and two columns, a CJK ideograph is one unit
 * and two columns, and a combining accent is one unit and no columns at all.
 *
 * This was survivable while the only model-controlled string on a repainted row was a clipped
 * `Report.summary`. It stops being survivable the moment tool arguments — model-chosen file paths
 * and shell command lines — are painted there on every tool call.
 *
 * NEVER measure a painted string: an SGR sequence occupies no column and this function would
 * count its letters. Measure first, paint at the join.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

/**
 * Word-wrap unpainted text into rows of at most `width` columns.
 *
 * The composer's echo is why this exists. A submitted entry used to go out as one string and let
 * the terminal hard-break it at its right edge, mid-word, which is the exact defect
 * `src/view/prose.ts` was built to end on the commander's side of the conversation. The human's
 * side kept it, and a screen where one speaker's paragraphs wrap and the other's shatter reads
 * as broken rendering rather than as two speakers.
 *
 * Runs of spaces survive: this echoes what someone typed, and swallowing their double space is a
 * silent edit of a transcript. A word wider than a whole row is broken across rows, because the
 * terminal would break it one column later anyway and without the caller's indent.
 *
 * Never hand this painted text. It measures what it is given, and an SGR sequence measures as
 * letters — see `displayWidth` above.
 */
export function wrapPlain(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const rows: string[] = [];
  let row = '';
  for (const word of text.split(' ')) {
    const separated = row === '' ? word : `${row} ${word}`;
    if (displayWidth(separated) <= limit) {
      row = separated;
      continue;
    }
    if (row !== '') {
      rows.push(row);
      row = '';
    }
    let rest = word;
    while (displayWidth(rest) > limit) {
      let take = 0;
      let cols = 0;
      for (const char of rest) {
        const w = charWidth(char);
        if (cols + w > limit) break;
        cols += w;
        take += char.length;
      }
      // A limit narrower than one double-width glyph would take nothing and spin forever.
      if (take === 0) take = [...rest][0]?.length ?? 1;
      rows.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
    row = rest;
  }
  rows.push(row);
  return rows;
}

/**
 * Truncate to `width` COLUMNS, marking the cut. Never pads, and never measures a painted string —
 * an escape sequence occupies no column, so clipping after colouring is how a "fits in 80" check
 * silently becomes wrong.
 *
 * A double-width code point that would straddle the boundary is dropped rather than half-drawn,
 * so the result is never wider than asked for. That can leave one column short; a gap is a
 * rendering choice, an overflow is a wrapped row and a broken cursor.
 */
export function clipTo(text: string, width: number, ellipsis: string): string {
  if (displayWidth(text) <= width) return text;
  const budget = width <= displayWidth(ellipsis) ? width : width - displayWidth(ellipsis);
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = charWidth(char);
    if (used + w > budget) break;
    out += char;
    used += w;
  }
  return width <= displayWidth(ellipsis) ? out : `${out}${ellipsis}`;
}

/** Pad to `width` COLUMNS. Never truncates — `clipTo` first if the text may be longer. */
export function padTo(text: string, width: number, align: 'left' | 'right'): string {
  const used = displayWidth(text);
  if (used >= width) return text;
  const filler = ' '.repeat(width - used);
  return align === 'right' ? `${filler}${text}` : `${text}${filler}`;
}

const STATE_INK: Record<UnitState, Ink> = {
  busy: 'green',
  idle: 'cyan',
  unknown: 'yellow',
  dead: 'red',
};

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

/**
 * `2m ago`. Deterministic given a number, which is the whole reason `buildTree` resolves ages
 * against an injected clock and stores milliseconds rather than letting the renderer ask the
 * system what time it is.
 */
export function formatAge(ms: number | null): string {
  if (ms === null) return '';
  if (ms < -1000) return `in ${formatDuration(-ms)}`;
  if (ms < 1000) return 'now';
  return `${formatDuration(ms)} ago`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ---------------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------------

type ColumnId = 'rank' | 'depth' | 'gap' | 'state' | 'why' | 'doing' | 'when';

interface ColumnSpec {
  id: ColumnId;
  header: string;
  width: number;
  align: 'left' | 'right';
}

const COLUMN_SPECS: Record<ColumnId, ColumnSpec> = {
  rank: { id: 'rank', header: 'RANK', width: 4, align: 'left' },
  depth: { id: 'depth', header: 'DEPTH', width: 5, align: 'right' },
  gap: { id: 'gap', header: 'GAP', width: 3, align: 'right' },
  state: { id: 'state', header: 'STATE', width: 9, align: 'left' },
  why: { id: 'why', header: 'WHY', width: 20, align: 'left' },
  doing: { id: 'doing', header: 'DOING', width: 14, align: 'left' },
  when: { id: 'when', header: 'WHEN', width: 7, align: 'right' },
};

/**
 * Richest first. The order encodes what may be lost: `doing` is a nicety, `why` is the audit
 * trail for the state and outranks it, `when` outranks both, and rank/depth/state are never
 * dropped because they are the three questions the command exists to answer.
 */
const COLUMN_SETS: ColumnId[][] = [
  ['rank', 'depth', 'gap', 'state', 'why', 'doing', 'when'],
  ['rank', 'depth', 'gap', 'state', 'why', 'when'],
  ['rank', 'depth', 'gap', 'state', 'when'],
  ['rank', 'depth', 'gap', 'state'],
  ['rank', 'depth', 'state'],
];

const GUTTER = 2;
const MIN_LABEL = 14;

/**
 * The label width worth borrowing from another column to reach.
 *
 * `└─ ◇ CPT·ENGINEER · cpt-01` is 29 columns, and the agent id is at the END of it, so a label
 * column narrower than this clips off exactly the field every other command takes as an argument.
 * Found on a real pty: at 80 and at 100 columns the fixed columns took everything and the label
 * was left with 20, so the status block and `army view` both drew `◇ CPT·ENGINEER ·…` and no id.
 * The unit column is the one a reader scans; it does not lose to `WHY` and `DOING`.
 */
const PREFERRED_LABEL = 30;

/**
 * How far a column may be squeezed to pay for that.
 *
 * Only the two prose columns are borrowed from, and only down to a width where they still say
 * something: `stream:re…` and `Write(li…` are worse than the full text and far better than
 * nothing. The fixed-shape columns (rank, depth, gap, state, when) are never touched, because
 * their contents have known widths and clipping them would produce a lie rather than a hint.
 */
const COLUMN_FLOOR: Partial<Record<ColumnId, number>> = { why: 10, doing: 8 };

function fixedWidth(ids: readonly ColumnId[]): number {
  return ids.reduce((total, id) => total + GUTTER + COLUMN_SPECS[id].width, 0);
}

/** The declared width of every column, as a mutable copy the layout can hand slack to. */
function columnWidths(): Record<ColumnId, number> {
  return {
    rank: COLUMN_SPECS.rank.width,
    depth: COLUMN_SPECS.depth.width,
    gap: COLUMN_SPECS.gap.width,
    state: COLUMN_SPECS.state.width,
    why: COLUMN_SPECS.why.width,
    doing: COLUMN_SPECS.doing.width,
    when: COLUMN_SPECS.when.width,
  };
}

export function chooseColumns(width: number): ColumnId[] {
  for (const set of COLUMN_SETS) {
    if (fixedWidth(set) + MIN_LABEL <= width) return set;
  }
  return COLUMN_SETS[COLUMN_SETS.length - 1] as ColumnId[];
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export interface RenderOptions {
  charset?: Charset;
  color?: boolean;
  /** Terminal columns. Never sniffed here; `index.ts` decides and passes it down. */
  width?: number;
  /** Repeat the column header. Off for the compact footer-only forms. */
  header?: boolean;
}

interface Ctx {
  glyphs: Glyphs;
  color: boolean;
  width: number;
  charset: Charset;
}

function paint(ctx: Ctx, ink: Ink, text: string): string {
  return paintInk(ctx.color, ink, text);
}

function fold(ctx: Ctx, text: string): string {
  return ctx.charset === 'ascii' ? asciiFold(text) : text;
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  return padTo(text, width, align);
}

function clip(ctx: Ctx, text: string, width: number): string {
  return clipTo(text, width, ctx.glyphs.ellipsis);
}

function prefixFor(ctx: Ctx, lastFlags: readonly boolean[]): string {
  let out = '';
  for (let i = 0; i < lastFlags.length; i++) {
    const isLast = lastFlags[i] as boolean;
    if (i === lastFlags.length - 1) out += isLast ? ctx.glyphs.lastBranch : ctx.glyphs.branch;
    else out += isLast ? ctx.glyphs.blank : ctx.glyphs.vertical;
  }
  return out;
}

interface Cells {
  rank: string;
  depth: string;
  gap: string;
  state: string;
  why: string;
  doing: string;
  when: string;
}

function unitCells(ctx: Ctx, node: UnitNode, hasGapColumn: boolean): Cells {
  // `1+2` = recorded spawn depth 1, plus two more levels of native subagents seen only in the
  // stream. Without it the depth column would under-report the real nesting.
  const depthText = node.streamDepth > 0 ? `${node.depth}+${node.streamDepth}` : String(node.depth);
  const gapText = node.rankDepthGap === 0 ? '0' : signed(node.rankDepthGap);
  return {
    rank: RANK_ABBREV[node.rank],
    depth: node.gapAnomalous && !hasGapColumn ? `${depthText}${ctx.glyphs.warn}` : depthText,
    gap: node.gapAnomalous ? `${gapText}${ctx.glyphs.warn}` : gapText,
    state: node.state.state,
    why: node.state.source,
    doing: node.state.detail,
    when: formatAge(node.state.ageMs),
  };
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function taskCells(ctx: Ctx, node: TaskNodeView): Cells {
  const none = ctx.glyphs.none;
  const doing =
    node.prUrl !== null
      ? node.prUrl
      : node.branch !== null
        ? node.branch
        : node.neverAttempted
          ? 'no agent yet'
          : `${node.attempts} attempt${node.attempts === 1 ? '' : 's'}`;
  return {
    rank: none,
    depth: none,
    gap: none,
    state: node.status,
    // A task's "why" is which attempt currently owns it — arrowed so the column reads as
    // "currently: cpt-04" rather than as a status source, which is what it means on a unit row.
    why: node.currentAgentId === null ? none : `${ctx.glyphs.arrow} ${node.currentAgentId}`,
    doing,
    when: formatAge(node.ageMs),
  };
}

function cellInk(row: WalkedRow, id: ColumnId): Ink | null {
  if (row.node.kind === 'unit') {
    if (id === 'state') return STATE_INK[row.node.state.state];
    if ((id === 'gap' || id === 'depth') && row.node.gapAnomalous) return 'red';
    if (id === 'why' || id === 'when') return 'grey';
    return null;
  }
  if (id === 'state') return row.node.status === 'queued' ? 'magenta' : 'blue';
  if (id === 'why' || id === 'when' || id === 'doing') return 'grey';
  return null;
}

function labelFor(ctx: Ctx, row: WalkedRow): string {
  if (row.node.kind === 'task') {
    return `${ctx.glyphs.task} ${row.node.title}`;
  }
  const glyph = ctx.glyphs.ranks[row.node.rank];
  const base = row.underOwnTask ? row.node.labelShort : row.node.label;
  const attempt = row.node.showAttempt ? ` #${row.node.attempt}` : '';
  return `${glyph} ${base}${attempt} ${ctx.glyphs.bullet} ${row.node.agentId}`;
}

/**
 * The BODY of the tree: one row per walked node, and nothing else.
 *
 * Split out of `renderTree` for one reason and it is a rule this project already wrote down: the
 * status block in `army chat` draws the same tree, and a second renderer would be a second layout
 * to keep in step. `renderTree` calls this, so the full-screen view and the pinned block cannot
 * disagree about a column width, a prefix glyph or an ellipsis. They are the same code with a
 * different frame around it.
 *
 * The column header is NOT here: it is a frame decision (`renderTree` prints one, the status block
 * has no room for one), while the widths those headers describe are computed here and returned
 * alongside so a caller that wants a header can build one that lines up.
 *
 * Every row is at most `width` columns and carries no `\n`. The status block depends on both:
 * a row that wraps breaks the `ESC[nA` arithmetic in `src/chat/io.ts`, and a row carrying a
 * newline puts the block's own row count out by one.
 */
export interface TreeRows {
  rows: string[];
  /** Column header, ready to paint, for a caller that draws one. */
  header: string;
  /** True when the model had nothing to walk. */
  empty: boolean;
}

export function renderTreeRows(model: TreeModel, options: RenderOptions = {}): TreeRows {
  const charset: Charset = options.charset ?? 'unicode';
  const ctx: Ctx = {
    glyphs: glyphsFor(charset),
    color: options.color ?? false,
    width: Math.max(20, options.width ?? 80),
    charset,
  };

  const columns = chooseColumns(ctx.width);
  const hasGap = columns.includes('gap');
  const walked = walkTree(model);

  // The unit column is the one the reader actually scans, so it gets what it needs up to
  // `MAX_LABEL` and only then starts truncating. Whatever is left over is handed to `doing`,
  // which is the one column that is genuinely better long — a branch name or a PR url.
  const fixed = fixedWidth(columns);
  const natural = walked.reduce(
    (widest, row) => Math.max(widest, prefixFor(ctx, row.lastFlags).length + labelFor(ctx, row).length),
    0,
  );
  let labelWidth = Math.min(
    Math.max(MIN_LABEL, natural),
    Math.max(MIN_LABEL, ctx.width - fixed),
  );
  const widths: Record<ColumnId, number> = { ...columnWidths() };
  // Borrow, before slack is handed out, and only what the label actually wants. This moves
  // columns between two cells of the SAME row, so the row's total width is unchanged and the
  // column set `chooseColumns` picked is untouched. The only thing that changes is which cell
  // gets clipped when the window is tight, and the answer is no longer "the agent id".
  let wanted = Math.min(PREFERRED_LABEL, Math.max(MIN_LABEL, natural)) - labelWidth;
  for (const id of ['doing', 'why'] as const) {
    if (wanted <= 0) break;
    if (!columns.includes(id)) continue;
    const give = Math.min(wanted, widths[id] - (COLUMN_FLOOR[id] ?? widths[id]));
    if (give <= 0) continue;
    widths[id] -= give;
    labelWidth += give;
    wanted -= give;
  }
  const used = columns.reduce((total, id) => total + GUTTER + widths[id], labelWidth);
  const slack = ctx.width - used;
  if (slack > 0 && columns.includes('doing')) widths.doing += slack;

  let head = pad('UNIT', labelWidth, 'left');
  for (const id of columns) {
    const spec = COLUMN_SPECS[id];
    head += ' '.repeat(GUTTER) + pad(spec.header, widths[id], spec.align);
  }

  const rows = walked.map((row) => {
    const cells =
      row.node.kind === 'unit' ? unitCells(ctx, row.node, hasGap) : taskCells(ctx, row.node);
    const rawLabel = fold(ctx, `${prefixFor(ctx, row.lastFlags)}${labelFor(ctx, row)}`);
    const cell = pad(clip(ctx, rawLabel, labelWidth), labelWidth, 'left');
    let line = row.node.kind === 'task' ? paint(ctx, 'bold', cell) : cell;

    for (const id of columns) {
      const spec = COLUMN_SPECS[id];
      const text = clip(ctx, fold(ctx, cells[id]), widths[id]);
      const padded = pad(text, widths[id], spec.align);
      const ink = cellInk(row, id);
      line += ' '.repeat(GUTTER) + (ink === null ? padded : paint(ctx, ink, padded));
    }
    return line.replace(/\s+$/u, '');
  });

  return { rows, header: paint(ctx, 'dim', head.trimEnd()), empty: walked.length === 0 };
}

/** The whole view, ready for stdout. */
export function renderTree(model: TreeModel, options: RenderOptions = {}): string {
  const charset: Charset = options.charset ?? 'unicode';
  const ctx: Ctx = {
    glyphs: glyphsFor(charset),
    color: options.color ?? false,
    width: Math.max(20, options.width ?? 80),
    charset,
  };

  const body = renderTreeRows(model, options);
  const lines: string[] = [];

  lines.push(...renderHeader(ctx, model));

  if (options.header !== false) lines.push(body.header);

  if (body.empty) {
    lines.push(paint(ctx, 'dim', `  (no tasks and no units recorded yet)`));
  }

  lines.push(...body.rows);

  lines.push(...renderFooter(ctx, model));
  return `${lines.join('\n')}\n`;
}

function renderHeader(ctx: Ctx, model: TreeModel): string[] {
  const g = ctx.glyphs;
  const lines: string[] = [];
  // Clip the PLAIN text first and colour the pieces afterwards: an escape sequence occupies no
  // column, so measuring a painted string is how a "fits in 80" check silently becomes wrong.
  const title = fold(ctx, `${g.ranks.GENERAL} ${model.campaign.title}`);
  const idPart = fold(ctx, ` ${g.bullet} ${model.campaign.id} ${g.bullet} ${model.campaign.status}`);
  const titleShown = clip(ctx, title, ctx.width);
  const idShown = clip(ctx, idPart, Math.max(0, ctx.width - titleShown.length));
  lines.push(paint(ctx, 'bold', titleShown) + paint(ctx, 'grey', idShown));
  lines.push(paint(ctx, 'grey', clip(ctx, fold(ctx, `  ${model.campaign.project}`), ctx.width)));

  // An `active` that nothing has backed up for hours is a claim, not a state — SIGKILL cannot be
  // caught, so a killed supervisor freezes `campaign.json` at `active` forever. The header keeps
  // the recorded status (this command never edits truth) and refuses to let it stand alone.
  const liveness = model.campaign.liveness;
  if (liveness !== null && liveness.presumedDead) {
    lines.push(
      paint(
        ctx,
        'yellow',
        clip(
          ctx,
          fold(
            ctx,
            `  ${g.warn} ${model.campaign.status} ${g.dash} stream silent ${formatDuration(liveness.silentMs)}, probably interrupted`,
          ),
          ctx.width,
        ),
      ),
    );
  }

  const s = model.summary;
  const ranks = s.ranks.length === 0 ? g.none : s.ranks.map((rank) => RANK_ABBREV[rank]).join(`${g.arrow}`);
  const depth =
    s.depthMaxObserved > s.depthMax
      ? `${s.depthMin}${g.dash}${s.depthMax} (${s.depthMaxObserved} observed)`
      : `${s.depthMin}${g.dash}${s.depthMax}`;
  const stats = [
    `${s.tasks} task${s.tasks === 1 ? '' : 's'}${s.queuedTasks > 0 ? ` (${s.queuedTasks} queued)` : ''}`,
    `${s.units} attempt${s.units === 1 ? '' : 's'}`,
    `ranks ${ranks}`,
    `depth ${depth}`,
    `busy ${s.byState.busy} idle ${s.byState.idle} unknown ${s.byState.unknown} dead ${s.byState.dead}`,
  ].join(` ${g.bullet} `);
  lines.push(paint(ctx, 'grey', clip(ctx, fold(ctx, `  ${stats}`), ctx.width)));
  lines.push('');
  return lines;
}

function renderFooter(ctx: Ctx, model: TreeModel): string[] {
  const g = ctx.glyphs;
  const lines: string[] = [''];
  const s = model.summary;

  if (s.anomalies.length > 0) {
    lines.push(
      paint(ctx, 'yellow', clip(ctx, fold(ctx, `${g.warn} ${s.anomalies.length} anomal${s.anomalies.length === 1 ? 'y' : 'ies'}`), ctx.width)),
    );
    for (const anomaly of s.anomalies) {
      lines.push(
        paint(ctx, 'yellow', clip(ctx, fold(ctx, `  ${anomaly.subject}: ${anomaly.message}`), ctx.width)),
      );
    }
  }
  if (s.openQueries > 0) {
    lines.push(paint(ctx, 'grey', fold(ctx, `  ${s.openQueries} unanswered quer${s.openQueries === 1 ? 'y' : 'ies'} on the bus`)));
  }
  lines.push(
    paint(
      ctx,
      'grey',
      clip(ctx, fold(ctx, `  read-only ${g.bullet} source ${model.source} ${g.bullet} ${model.generatedAt}`), ctx.width),
    ),
  );
  return lines;
}

/**
 * `--json`: the model verbatim, no decoration, on stdout.
 *
 * Deliberately the SAME object the terminal renderer consumes, so a script and a future web
 * dashboard see exactly what the tree showed rather than a second, drifting projection of it.
 */
export function renderJson(model: TreeModel): string {
  return `${JSON.stringify(model, null, 2)}\n`;
}
