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
 * The rank glyphs — ☆ ◆ ◇ ▪ · — and the box-drawing characters ├ └ │ are U+2500-block and
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
}

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
};

/**
 * Distinct at a glance in a 437 codepage, and ordered by visual weight the same way the Unicode
 * set is: a General is the biggest mark on the page, a Private the smallest.
 */
export const ASCII_GLYPHS: Glyphs = {
  ranks: { GENERAL: '*', COLONEL: '#', CAPTAIN: 'o', SERGEANT: '+', PRIVATE: '.' },
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
  '◇': 'o',
  '▪': '+',
  '▸': '>',
  '│': '|',
  '├': '|',
  '└': '`',
  '─': '-',
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

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

const ANSI = {
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

type Ink = keyof typeof ANSI;

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
  if (!ctx.color || text.length === 0) return text;
  return `${ANSI[ink]}${text}${ANSI.reset}`;
}

function fold(ctx: Ctx, text: string): string {
  return ctx.charset === 'ascii' ? asciiFold(text) : text;
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  if (text.length >= width) return text;
  const filler = ' '.repeat(width - text.length);
  return align === 'right' ? `${filler}${text}` : `${text}${filler}`;
}

function clip(ctx: Ctx, text: string, width: number): string {
  if (text.length <= width) return text;
  const mark = ctx.glyphs.ellipsis;
  if (width <= mark.length) return text.slice(0, width);
  return `${text.slice(0, width - mark.length)}${mark}`;
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

/** The whole view, ready for stdout. */
export function renderTree(model: TreeModel, options: RenderOptions = {}): string {
  const charset: Charset = options.charset ?? 'unicode';
  const ctx: Ctx = {
    glyphs: glyphsFor(charset),
    color: options.color ?? false,
    width: Math.max(20, options.width ?? 80),
    charset,
  };

  const columns = chooseColumns(ctx.width);
  const hasGap = columns.includes('gap');
  const rows = walkTree(model);

  // The unit column is the one the reader actually scans, so it gets what it needs up to
  // `MAX_LABEL` and only then starts truncating. Whatever is left over is handed to `doing`,
  // which is the one column that is genuinely better long — a branch name or a PR url.
  const fixed = fixedWidth(columns);
  const natural = rows.reduce(
    (widest, row) => Math.max(widest, prefixFor(ctx, row.lastFlags).length + labelFor(ctx, row).length),
    0,
  );
  const labelWidth = Math.min(
    Math.max(MIN_LABEL, natural),
    Math.max(MIN_LABEL, ctx.width - fixed),
  );
  const widths: Record<ColumnId, number> = { ...columnWidths() };
  const slack = ctx.width - fixed - labelWidth;
  if (slack > 0 && columns.includes('doing')) widths.doing += slack;

  const lines: string[] = [];

  lines.push(...renderHeader(ctx, model));

  if (options.header !== false) {
    let head = pad('UNIT', labelWidth, 'left');
    for (const id of columns) {
      const spec = COLUMN_SPECS[id];
      head += ' '.repeat(GUTTER) + pad(spec.header, widths[id], spec.align);
    }
    lines.push(paint(ctx, 'dim', head.trimEnd()));
  }

  if (rows.length === 0) {
    lines.push(paint(ctx, 'dim', `  (no tasks and no units recorded yet)`));
  }

  for (const row of rows) {
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
    lines.push(line.replace(/\s+$/u, ''));
  }

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
