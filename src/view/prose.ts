/**
 * Prose — the commander's answers, rendered instead of dumped.
 *
 * ## Why this exists
 *
 * An answer used to reach the terminal as the raw bytes of the stream pump: full-width text that
 * the terminal hard-wrapped at its right edge, mid-word ("logi / n"), with the model's markdown
 * printed literally ("**Question 1**"), in the same white as everything else on the screen. Put
 * next to any tool that renders its transcript, the session read as one undifferentiated block,
 * and a reader could not tell at a glance which lines they wrote and which the commander did.
 * This module is the difference: a gutter mark that hangs in the margin, word wrap with a
 * hanging indent under it, and the three pieces of markdown a model actually sends (bold, inline
 * code, fenced blocks) turned into ink instead of punctuation.
 *
 * ## Pure core, streaming shell
 *
 * The core (`parseInline`, `blockShape`) is pure the way the rest of `src/view` is pure: width,
 * colour and charset arrive as arguments and a test asserts on strings. `createProseStream` is
 * the shell that feeds it from a live model stream, and it holds the one genuinely hard problem:
 * chunks almost never end on a newline, and a renderer that waits for the newline hides a
 * stalled commander's last words. The note on `settle` in `src/chat/run.ts` names the design
 * this implements: hold a partial line, and let the caller's idle timer `spill()` it once the
 * stream has gone quiet for a beat.
 *
 * ## The append-only rule
 *
 * Nothing printed is ever repainted. A `spill()` therefore emits only what cannot need revising
 * later: whole words, and only text with no unclosed `**`, backtick or `[link](…)` in front of
 * it, so a bold phrase never appears half-printed with its marker showing. The rest of the line
 * continues on the open row when it arrives. `end()` is unconditional: whatever is still held
 * renders with unmatched markers shown literally, because at turn end a literal `**` is the
 * truth.
 *
 * ## What this is not
 *
 * Not a markdown engine. Headings, bullet and numbered lists, fences, bold, inline code, links,
 * horizontal rules and pipe tables are the whole grammar, chosen from what answers actually
 * contain. Underscore emphasis, footnotes and nesting render as what they are: text. And nothing
 * here moves a cursor: every write is ordinary forward output, which is what keeps this module
 * out of the repaint arithmetic that `src/chat/io.ts` owns alone.
 *
 * ## The one construct that waits
 *
 * A table can only be aligned once its widest cell is known, so table lines buffer until the
 * first non-table line or the end of the turn, and a `spill()` never flushes a partial table:
 * alignment printed early is a claim about cells that have not arrived, and the append-only rule
 * means it could never be corrected. Everything else still streams line by line.
 */

import type { Charset } from './render.ts';
import { asciiFold, displayWidth, paintInk } from './render.ts';
import type { HighlightState } from './highlight.ts';
import { highlightLine, initialHighlightState, normalizeLang } from './highlight.ts';

// ---------------------------------------------------------------------------------------------
// Inline runs
// ---------------------------------------------------------------------------------------------

export type InlineStyle = 'plain' | 'bold' | 'code' | 'link';

/** One styled span of a line: what a reader sees, and how it is inked. */
export interface InlineRun {
  text: string;
  style: InlineStyle;
  /** Link runs only: where the text points. Absent on every other style. */
  url?: string;
}

/**
 * Where the first unclosed `**`, backtick or `[link](…)` starts, or -1.
 *
 * The stream refuses to emit past this point before turn end: text after it may still become a
 * styled span, and the append-only rule means a marker printed literally stays printed. A `[`
 * counts as open until its `]` has arrived AND the character after the `]` is known, because
 * `](` is what turns a bracketed aside into a link and that `(` may be the next chunk.
 */
export function firstOpenMarker(src: string): number {
  let i = 0;
  while (i < src.length) {
    if (src[i] === '`') {
      const close = src.indexOf('`', i + 1);
      if (close === -1) return i;
      i = close + 1;
      continue;
    }
    if (src.startsWith('**', i)) {
      const close = src.indexOf('**', i + 2);
      if (close === -1) return i;
      i = close + 2;
      continue;
    }
    if (src[i] === '[') {
      const bracket = src.indexOf(']', i + 1);
      if (bracket === -1 || bracket === src.length - 1) return i;
      if (src[bracket + 1] === '(') {
        const paren = src.indexOf(')', bracket + 2);
        if (paren === -1) return i;
        i = paren + 1;
        continue;
      }
      i = bracket + 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Split one line into styled runs. A backtick span wins over bold, matching how models nest the
 * two; an unmatched marker is literal text, never a style that silently swallows the line.
 */
export function parseInline(src: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let plain = '';
  const flushPlain = (): void => {
    if (plain !== '') runs.push({ text: plain, style: 'plain' });
    plain = '';
  };
  let i = 0;
  while (i < src.length) {
    if (src[i] === '`') {
      const close = src.indexOf('`', i + 1);
      if (close !== -1) {
        flushPlain();
        runs.push({ text: src.slice(i + 1, close), style: 'code' });
        i = close + 1;
        continue;
      }
    }
    if (src[i] === '[') {
      // `[text](url)`, all three delimiters present. A bracketed aside with no `(` after its
      // `]` is ordinary text, so `array[0]` never turns into a link.
      const bracket = src.indexOf(']', i + 1);
      if (bracket !== -1 && src[bracket + 1] === '(') {
        const paren = src.indexOf(')', bracket + 2);
        if (paren !== -1) {
          flushPlain();
          runs.push({
            text: src.slice(i + 1, bracket),
            style: 'link',
            url: src.slice(bracket + 2, paren),
          });
          i = paren + 1;
          continue;
        }
      }
    }
    if (src.startsWith('**', i)) {
      const close = src.indexOf('**', i + 2);
      if (close !== -1) {
        flushPlain();
        runs.push({ text: src.slice(i + 2, close), style: 'bold' });
        i = close + 2;
        continue;
      }
    }
    plain += src[i] as string;
    i += 1;
  }
  flushPlain();
  return runs;
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

/** How one logical line renders, decided from its first characters. */
export interface BlockShape {
  kind: 'paragraph' | 'heading' | 'list' | 'fence' | 'rule';
  /** Columns of indent, under the gutter, for this line's continuation rows. */
  hang: number;
  /** The line ready for inline parsing: heading markers stripped, list markers kept. */
  text: string;
}

const LIST_MARKER = /^(\s*)(?:[-*•]|\d{1,3}[.)])\s+/u;
const HEADING = /^#{1,6}\s+/u;
export const FENCE = /^\s*```/u;
/** A line that is only dashes, stars or underscores: a horizontal rule, not those characters. */
export const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;
/** A complete table line: pipe at both edges. Only trustworthy on a COMPLETE line. */
const TABLE_LINE = /^\s*\|.*\|\s*$/u;
/** A line that has STARTED like a table line, and so must not stream out as prose yet. */
const TABLE_OPEN = /^\s*\|/u;
/** One divider cell of a `|---|:---:|` row. */
const DIVIDER_CELL = /^:?-+:?$/u;

/**
 * Classify one logical line. Pure; fence state spans lines and is the caller's to keep.
 *
 * A list item hangs its continuation under its own text rather than under its marker, which is
 * the whole difference between a list a reader can scan and a ragged left edge.
 *
 * `rule` is only trustworthy on a COMPLETE line: a partial `---` may still grow a word after
 * it, so the stream holds a line this classifies as a rule until its newline arrives.
 */
export function blockShape(line: string, inFence: boolean): BlockShape {
  if (inFence || FENCE.test(line)) return { kind: 'fence', hang: 2, text: line };
  const heading = HEADING.exec(line);
  if (heading !== null) return { kind: 'heading', hang: 0, text: line.slice(heading[0].length) };
  if (RULE.test(line)) return { kind: 'rule', hang: 0, text: line };
  const list = LIST_MARKER.exec(line);
  if (list !== null) return { kind: 'list', hang: list[0].length, text: line };
  return { kind: 'paragraph', hang: 0, text: line };
}

// ---------------------------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------------------------

export interface ProseStreamOptions {
  /** Live terminal columns, re-read per row: windows get dragged mid-answer. */
  width: () => number;
  color: boolean;
  charset: Charset;
  /** Where output goes. Ordinary forward writes only; the caller owns the terminal. */
  write: (text: string) => void;
}

export interface ProseStream {
  /** A new answer turn: reset every line state and arm the gutter for the first row. */
  begin(): void;
  push(chunk: string): void;
  /** The stream has gone quiet: print held whole words rather than hide a stalled commander. */
  spill(): void;
  /** The turn is over: print everything held, unmatched markers and all. Leaves the row open. */
  end(): void;
}

/** The gutter every answer hangs under. Two columns; continuation rows get two spaces. */
export const GUTTER = '◆ ';

/** What a fenced block gets instead of its backticks: two columns of rule in the margin. */
export const CODE_RULE = '│ ';

/** A word (or an atomic styled span) with the ink it renders in. */
interface Word {
  /** The VISIBLE text, the thing the wrap arithmetic measures. */
  text: string;
  style: InlineStyle;
  /** Link words: the two differently inked halves. Absent once a link has been hard-broken. */
  link?: { label: string; url: string | null };
  /**
   * Tight punctuation glued to a styled span: the `.` of "`gate.ts`." rendered plain, measured
   * and wrapped with the span it trails, so a period never opens a row of its own.
   */
  suffix?: string;
}

/**
 * What a link run shows: cyan text alone when the text IS the url, otherwise the text with the
 * destination dim in parentheses after it, so a reader can act on either without a mouse.
 */
export function linkParts(run: InlineRun): { visible: string; label: string; url: string | null } {
  const url = run.url ?? '';
  if (url === '' || url === run.text) return { visible: run.text, label: run.text, url: null };
  return { visible: `${run.text} (${url})`, label: run.text, url };
}

/**
 * Runs to words. Plain runs split on spaces; a styled span stays whole, because half a bold
 * phrase on each of two rows reads as two phrases. Spans longer than a row are hard-broken by
 * the writer instead.
 */
function wordsOf(runs: readonly InlineRun[]): Word[] {
  const words: Word[] = [];
  const rest = [...runs];
  for (let r = 0; r < rest.length; r += 1) {
    const run = rest[r] as InlineRun;
    if (run.style !== 'plain') {
      const word: Word =
        run.style === 'link'
          ? ((): Word => {
              const parts = linkParts(run);
              return { text: parts.visible, style: 'link', link: { label: parts.label, url: parts.url } };
            })()
          : { text: run.text, style: run.style };
      // Tight punctuation directly after a styled span belongs to the span: without this,
      // "`gate.ts`." wraps as the word "." on a row of its own.
      const next = rest[r + 1];
      if (next !== undefined && next.style === 'plain' && next.text !== '' && !next.text.startsWith(' ')) {
        const cut = next.text.indexOf(' ');
        word.suffix = cut === -1 ? next.text : next.text.slice(0, cut);
        rest[r + 1] = { ...next, text: cut === -1 ? '' : next.text.slice(cut) };
      }
      words.push(word);
      continue;
    }
    for (const piece of run.text.split(' ')) {
      if (piece !== '') words.push({ text: piece, style: 'plain' });
    }
  }
  return words;
}

export function createProseStream(options: ProseStreamOptions): ProseStream {
  const gutter = options.charset === 'ascii' ? asciiFold(GUTTER) : GUTTER;
  const indent = displayWidth(gutter);
  /** The rule down the left edge of a fenced block, standing in for the dropped ``` markers. */
  const codeRule = options.charset === 'ascii' ? asciiFold(CODE_RULE) : CODE_RULE;

  /**
   * Everything a public call produces goes out as ONE write. The terminal layer repaints its
   * pinned status block around every write it is handed, so a write per word would be a block
   * erase and repaint per word; a write per chunk is what the raw stream always cost.
   */
  let pending = '';
  const out = (text: string): void => {
    pending += text;
  };
  const flush = (): void => {
    if (pending === '') return;
    const text = pending;
    pending = '';
    options.write(text);
  };

  /** Unprinted source of the current logical line. */
  let src = '';
  /** True once any row of the current logical line has been opened: its first row takes no hang. */
  let lineOpened = false;
  /** The line's classification, decided the first time any of it prints. Null = not started. */
  let shape: BlockShape | null = null;
  /** Printable columns on the open visual row, or null when the cursor is at a fresh row. */
  let openCols: number | null = null;
  /** Columns at which the open row's content began, so the first word on it takes no space. */
  let rowBase = 0;
  let inFence = false;
  /** The open fence's language, from its info string, and the tokenizer state inside it. */
  let fenceLang: string | null = null;
  let highlight: HighlightState = initialHighlightState();
  let gutterPending = false;
  /**
   * The line just consumed printed nothing and must not cost a row either.
   *
   * Only a fence marker sets it. `finishLine` would otherwise end every logical line with a
   * newline, which for a dropped ``` would leave the blank row the marker used to occupy — the
   * marker gone and its hole still there, which looks worse than printing it.
   */
  let suppressRow = false;
  /** Completed table lines waiting for the table's end. See the module header on waiting. */
  let tableRows: string[] = [];

  /** The last usable column index is held back: see the wrap-pending note in `view/chrome.ts`. */
  const usable = (): number => Math.max(indent + 16, options.width()) - 1;

  const paintWord = (word: Word): string => {
    if (word.style === 'link') {
      // A hard-broken slice of a link has lost its halves and paints as one cyan piece; whole
      // links paint the label cyan and the destination dim.
      if (word.link === undefined) return paintInk(options.color, 'cyan', word.text);
      const label = paintInk(options.color, 'cyan', word.link.label);
      return word.link.url === null
        ? label
        : `${label} ${paintInk(options.color, 'dim', `(${word.link.url})`)}`;
    }
    return word.style === 'bold' || (shape !== null && shape.kind === 'heading')
      ? paintInk(options.color, 'bold', word.text)
      : word.style === 'code'
        ? paintInk(options.color, 'cyan', word.text)
        : word.text;
  };

  /**
   * Open a fresh visual row: the gutter once per turn, spaces ever after.
   *
   * The FIRST row of a logical line takes no hang, so a list's marker sits at the left edge and
   * its continuation rows indent under the text. `lineOpened` is what tells the two apart.
   */
  const openRow = (): void => {
    const extra = lineOpened ? (shape?.hang ?? 0) : 0;
    lineOpened = true;
    if (gutterPending) {
      gutterPending = false;
      out(paintInk(options.color, 'cyan', gutter) + ' '.repeat(extra));
    } else {
      out(' '.repeat(indent + extra));
    }
    openCols = indent + extra;
    rowBase = indent + extra;
  };

  /** Append one word to the open row, wrapping onto a fresh indented row when it will not fit. */
  const putWord = (word: Word): void => {
    let text = word.text;
    let suffix = word.suffix ?? '';
    // The halves of a link and the plainness of a glued suffix survive only while the word is
    // whole; any slice paints as one piece in the span's own ink, because half a dim url in
    // parentheses is not a url.
    let intact = true;
    for (;;) {
      if (openCols === null) openRow();
      const width = usable();
      const cols = openCols ?? 0;
      const sep = cols > rowBase ? 1 : 0;
      const w = displayWidth(text) + displayWidth(suffix);
      if (cols + sep + w <= width) {
        const painted = intact
          ? paintWord({ ...word, text }) + suffix
          : paintWord({ text, style: word.style });
        out((sep === 1 ? ' ' : '') + painted);
        openCols = cols + sep + w;
        return;
      }
      if (cols > rowBase) {
        // The row is full: close it and try again on a fresh one.
        out('\n');
        openCols = null;
        continue;
      }
      // A single word wider than an empty row: hard-break it, because the alternative is the
      // terminal doing the same one column later with no indent.
      if (intact) {
        text += suffix;
        suffix = '';
        intact = false;
      }
      let take = 0;
      let taken = 0;
      while (take < text.length) {
        const ch = displayWidth(text.slice(take, take + 1));
        if (taken + ch > width - cols) break;
        taken += ch;
        take += 1;
      }
      out(paintWord({ text: text.slice(0, take), style: word.style }));
      out('\n');
      openCols = null;
      text = text.slice(take);
      if (text === '') return;
    }
  };

  /**
   * Render what can be rendered of `src`, holding back what cannot.
   *
   * `final` marks the two calls that hold nothing: a completed line (its newline arrived) and
   * the end of the turn. A non-final emit keeps unclosed spans and the trailing partial word.
   */
  const emit = (final: boolean): void => {
    // A line that has started like a table line must not stream out as prose: its newline
    // decides whether it joins the table buffer, and words printed now could not be taken back.
    if (!final && shape === null && !inFence && TABLE_OPEN.test(src)) return;
    if (shape === null && src !== '') {
      // In a fence, or opening one, the line renders as code: held whole until its newline,
      // because code is the one place a half-line changes meaning. Everything else classifies
      // now and streams word by word.
      const probe = blockShape(src, inFence);
      if (probe.kind === 'fence') {
        if (!final) return;
        shape = probe;
        if (FENCE.test(src)) {
          // The ``` line prints NOTHING, not even a row.
          //
          // Backticks are how a model says "code" in a format that has no other way to say it.
          // Once the block below has a rule down its left edge, the marker is the model's syntax
          // showing through the rendering — the same reason `**bold**` does not print its
          // asterisks. What the opening marker is still good for is its info string: it picks the
          // language, and resets the tokenizer, so an unclosed template literal in one block
          // cannot bleed green into the next.
          if (!inFence) {
            fenceLang = normalizeLang(src);
            highlight = initialHighlightState();
          }
          inFence = !inFence;
          src = '';
          suppressRow = true;
          return;
        }
        openRow();
        // Interior code: a dim rule in the margin, then the highlighter's runs with uninked text
        // dim so the block still reads as one quiet region. The runs reproduce the line byte for
        // byte (the module's stated invariant), so the width arithmetic is unaffected.
        const lit = highlightLine(src, fenceLang, highlight);
        highlight = lit.state;
        out(
          paintInk(options.color, 'dim', codeRule) +
            lit.runs.map((run) => paintInk(options.color, run.ink ?? 'dim', run.text)).join(''),
        );
        src = '';
        return;
      }
      if (probe.kind === 'rule') {
        // Only a COMPLETE line is a rule: a partial `---` may still grow a word after it.
        if (!final) return;
        shape = probe;
        openRow();
        const dash = options.charset === 'ascii' ? '-' : '─';
        out(paintInk(options.color, 'dim', dash.repeat(Math.max(1, Math.min(40, usable() - indent)))));
        src = '';
        return;
      }
      shape = probe;
      // The classified text replaces the raw line exactly once, before any of it prints:
      // heading markers are stripped here and never seen again.
      src = probe.text;
    }
    if (src === '') return;

    let safe = src;
    let held = '';
    if (!final) {
      const open = firstOpenMarker(safe);
      if (open !== -1) {
        held = safe.slice(open);
        safe = safe.slice(0, open);
      }
      const lastSpace = safe.lastIndexOf(' ');
      if (lastSpace === -1) return;
      held = safe.slice(lastSpace + 1) + held;
      safe = safe.slice(0, lastSpace + 1);
      if (safe.trim() === '') return;
    }

    for (const word of wordsOf(parseInline(safe))) putWord(word);
    src = held;
  };

  /**
   * The line's newline arrived: print the rest, close the row, forget the line.
   *
   * Always exactly one '\n', whatever the line held. A line of words closes its open row; a
   * blank line IS the newline, which is what keeps paragraph gaps in the transcript.
   */
  const finishLine = (): void => {
    emit(true);
    if (suppressRow) {
      suppressRow = false;
    } else {
      out('\n');
    }
    openCols = null;
    shape = null;
    lineOpened = false;
  };

  /** One cell, inline styles applied, with the columns its visible text occupies. */
  const paintCell = (cell: string): { painted: string; cols: number } => {
    let painted = '';
    let cols = 0;
    for (const run of parseInline(cell)) {
      if (run.style === 'link') {
        const parts = linkParts(run);
        painted += paintInk(options.color, 'cyan', parts.label);
        if (parts.url !== null) painted += ` ${paintInk(options.color, 'dim', `(${parts.url})`)}`;
        cols += displayWidth(parts.visible);
        continue;
      }
      painted +=
        run.style === 'bold'
          ? paintInk(options.color, 'bold', run.text)
          : run.style === 'code'
            ? paintInk(options.color, 'cyan', run.text)
            : run.text;
      cols += displayWidth(run.text);
    }
    return { painted, cols };
  };

  /**
   * One cell, wrapped to `width` columns, as painted rows with the columns each one occupies.
   *
   * Packs the same `Word` stream the paragraph wrap uses, so a `**bold**` span is never split
   * across rows with its markers half-consumed, and a trailing `.` never opens a row of its own.
   * A single word wider than the column is hard-broken, in its own ink; the alternative is a row
   * that overflows the table and takes every row below it out of alignment.
   */
  const wrapCellRows = (cell: string, width: number): { painted: string; cols: number }[] => {
    const rows: { painted: string; cols: number }[] = [];
    let painted = '';
    let cols = 0;
    const closeRow = (): void => {
      rows.push({ painted, cols });
      painted = '';
      cols = 0;
    };
    for (const word of wordsOf(parseInline(cell))) {
      const suffix = word.suffix ?? '';
      const w = displayWidth(word.text) + displayWidth(suffix);
      if (cols > 0 && cols + 1 + w > width) closeRow();
      if (cols === 0 && w > width) {
        let rest = word.text + suffix;
        while (displayWidth(rest) > width) {
          let take = 0;
          let taken = 0;
          for (const char of rest) {
            const cw = displayWidth(char);
            if (taken + cw > width) break;
            taken += cw;
            take += char.length;
          }
          if (take === 0) take = [...rest][0]?.length ?? 1;
          rows.push({
            painted: paintWord({ text: rest.slice(0, take), style: word.style }),
            cols: taken,
          });
          rest = rest.slice(take);
        }
        painted = paintWord({ text: rest, style: word.style });
        cols = displayWidth(rest);
        continue;
      }
      painted += (cols === 0 ? '' : ' ') + paintWord(word) + suffix;
      cols += (cols === 0 ? 0 : 1) + w;
    }
    closeRow();
    return rows;
  };

  /** `| a | b |` to trimmed cells, edge pipes dropped. */
  const cellsOf = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/u, '')
      .replace(/\|$/u, '')
      .split('|')
      .map((cell) => cell.trim());

  /**
   * Render the buffered table, aligned, and empty the buffer.
   *
   * Alignment is why the buffer exists: a column is as wide as its widest cell, and that cell may
   * be the last row's. Cells measure by their VISIBLE width, after inline markers are stripped,
   * so `**bold**` in a cell does not open a four-column hole in its column. A table wider than
   * the terminal has its widest columns taken down until it fits and its cells wrapped inside
   * them, which is what a person does by hand. Only a table with more columns than the window
   * can seat gives up and prints its raw lines dim.
   */
  const flushTable = (): void => {
    if (tableRows.length === 0) return;
    const lines = tableRows;
    tableRows = [];
    const dash = options.charset === 'ascii' ? '-' : '─';

    const rows = lines.map(cellsOf);
    const isDivider = rows.map((cells) => cells.every((cell) => DIVIDER_CELL.test(cell)));
    const columns = Math.max(...rows.map((cells) => cells.length));
    const widths: number[] = Array.from({ length: columns }, () => 1);
    rows.forEach((cells, row) => {
      if (isDivider[row] === true) return;
      cells.forEach((cell, i) => {
        widths[i] = Math.max(widths[i] ?? 1, paintCell(cell).cols);
      });
    });

    // `| ` + cell + ` ` per column, then the closing `|`.
    const chrome = 1 + 3 * columns;
    const budget = usable() - indent - chrome;
    // Below this a column holds one short word per row and the table is a stack of confetti;
    // there the raw lines really are the better answer.
    const MIN_CELL = 6;
    const tooWide = budget < columns * MIN_CELL;
    if (!tooWide) {
      // Take columns down from the widest until the table fits. Proportional shrinking would
      // punish a narrow column for a wide neighbour's sake; taking from the widest is what a
      // person does by hand, and it leaves short columns at their natural width.
      let total = widths.reduce((sum, w) => sum + w, 0);
      while (total > budget) {
        let widest = 0;
        for (let i = 1; i < columns; i += 1) {
          if ((widths[i] ?? 0) > (widths[widest] ?? 0)) widest = i;
        }
        if ((widths[widest] ?? 0) <= MIN_CELL) break;
        widths[widest] = (widths[widest] ?? 0) - 1;
        total -= 1;
      }
    }

    const startRow = (): void => {
      shape = null;
      lineOpened = false;
      openCols = null;
      openRow();
    };
    for (const [row, cells] of rows.entries()) {
      startRow();
      if (tooWide) {
        out(paintInk(options.color, 'dim', lines[row] ?? ''));
      } else if (isDivider[row] === true) {
        out(paintInk(options.color, 'dim', `|${widths.map((w) => dash.repeat(w + 2)).join('|')}|`));
      } else {
        const bar = paintInk(options.color, 'dim', '|');
        // A cell too long for its shrunken column becomes several rows of the same cell rather
        // than a row the terminal breaks for us. This is the whole reason a shrink is allowed to
        // happen at all: without it the only honest choice was to print the raw pipes, and in a
        // hundred-column window almost every table a model writes is too wide, so the fallback
        // was not the rare case the code called it. It was the normal one.
        const parts = widths.map((w, i) => wrapCellRows(cells[i] ?? '', w));
        const height = Math.max(1, ...parts.map((rows) => rows.length));
        for (let line = 0; line < height; line += 1) {
          if (line > 0) startRow();
          const body = widths
            .map((w, i) => {
              const piece = parts[i]?.[line] ?? { painted: '', cols: 0 };
              return `${piece.painted}${' '.repeat(Math.max(0, w - piece.cols))}`;
            })
            .join(` ${bar} `);
          out(`${bar} ${body} ${bar}\n`);
          openCols = null;
          lineOpened = false;
        }
        continue;
      }
      out('\n');
      openCols = null;
      lineOpened = false;
    }
    shape = null;
  };

  /**
   * Route one COMPLETE line: table lines buffer, and anything else first flushes the table it
   * just ended. `shape === null` is a given here, because `emit` holds every partial line that
   * begins with a pipe: no half-printed line can reach the buffer.
   */
  const consumeLine = (): void => {
    if (!inFence && shape === null && TABLE_LINE.test(src)) {
      tableRows.push(src);
      src = '';
      return;
    }
    flushTable();
    finishLine();
  };

  return {
    begin(): void {
      src = '';
      shape = null;
      openCols = null;
      rowBase = 0;
      inFence = false;
      fenceLang = null;
      highlight = initialHighlightState();
      gutterPending = true;
      lineOpened = false;
      suppressRow = false;
      tableRows = [];
      pending = '';
    },
    push(chunk: string): void {
      src += chunk.replace(/\r\n/gu, '\n');
      let at = src.indexOf('\n');
      while (at !== -1) {
        const rest = src.slice(at + 1);
        src = src.slice(0, at);
        consumeLine();
        src = rest;
        at = src.indexOf('\n');
      }
      // Between newlines, print eagerly once the held text has outgrown a row; short partials
      // wait for their newline or for the caller's idle beat, whichever comes first.
      if (displayWidth(src) > usable()) emit(false);
      flush();
    },
    spill(): void {
      // Deliberately NOT flushTable(): a partial table aligned early is a claim about cells
      // that have not arrived, and the append-only rule means it could never be corrected.
      emit(false);
      flush();
    },
    end(): void {
      // The last row of a table is usually the last line of the whole answer, and a last line
      // arrives with no newline behind it — so `consumeLine`, the only thing that files a row
      // into the buffer, never ran for it. It fell through to `emit` and printed as prose: the
      // observed symptom was a table's final row rendered as a wrapped paragraph of raw pipes
      // while every row above it was aligned. The buffer is closed here instead, on the same
      // test `consumeLine` uses.
      if (!inFence && shape === null && src !== '' && TABLE_LINE.test(src)) {
        tableRows.push(src);
        src = '';
      }
      flushTable();
      emit(true);
      if (gutterPending) {
        // A turn that said nothing still marks that it happened; the bare gutter is that mark.
        out(paintInk(options.color, 'cyan', gutter.trimEnd()));
        gutterPending = false;
      }
      src = '';
      shape = null;
      openCols = null;
      lineOpened = false;
      flush();
    },
  };
}
