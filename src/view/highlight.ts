/**
 * Highlight — muted syntax colour for the code inside a fenced block.
 *
 * ## Why this exists
 *
 * `src/view/prose.ts` renders a fenced block dim, which separates code from prose and stops
 * there: a forty-line diff and a forty-line shell script read as the same grey slab. This module
 * gives the renderer per-token ink so the code inside an answer reads the way an editor would
 * show it, at a fraction of the intensity. The palette is deliberately small and quiet, five
 * classes and no more, because the code sits inside a conversation and must not shout over it:
 * comments 'grey', strings 'green', keywords 'cyan', numbers and literals 'yellow', everything
 * else uninked and left to the caller's dim.
 *
 * ## The one invariant
 *
 * Concatenating `runs[].text` reproduces the input line byte for byte, always. The caller
 * measures width and wraps on the plain text, so a tokenizer that swallowed or invented a byte
 * would desynchronise cursor arithmetic two modules away. Every tokenizer here emits slices of
 * the input and nothing else, and the test suite fuzzes the invariant across every language.
 *
 * ## What it refuses to do
 *
 * Guess. An unknown language, an empty info string, or any input that confuses a tokenizer
 * yields uninked runs rather than wrong ink: `highlightLine` never throws, and its catch-all
 * hands the whole line back as one plain run. It also refuses to grow a grammar. This is not a
 * parser; it is a per-line scanner with exactly the cross-line state a stream needs (an open
 * js/ts block comment or template literal, an open python triple-quoted string), kept as a plain
 * serializable object so a caller can carry it between lines without owning this module's
 * internals.
 */

import type { Ink } from './render.ts';

// ---------------------------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------------------------

export interface HighlightRun {
  text: string;
  /** Null means "no opinion": the caller paints the run however it paints the block. */
  ink: Ink | null;
}

/**
 * Everything that survives from one line to the next, and nothing else.
 *
 * `open` names a construct the previous line started and did not finish. Only js/ts and python
 * have any: block comments and template literals for one, triple-quoted strings for the other.
 * The stateless languages always hand back `{ open: null }`, so stale state from a different
 * block can never leak forward even if a caller reuses the object.
 */
export interface HighlightState {
  open: 'js-block-comment' | 'js-template' | 'py-triple-single' | 'py-triple-double' | null;
}

export function initialHighlightState(): HighlightState {
  return { open: null };
}

/**
 * The info string of a fence line to a canonical language id, or null for "just dim it".
 *
 * Accepts the whole fence line ('```ts'), the info string alone ('ts'), and the padded or
 * aliased spellings models actually produce ('``` sh ', '```javascript'). Anything unrecognised
 * is null on purpose: wrong ink on the wrong language is worse than no ink.
 */
export function normalizeLang(info: string): string | null {
  const bare = info.trim().replace(/^`+/u, '').trim();
  const first = bare.split(/\s+/u)[0] ?? '';
  const word = first.toLowerCase();
  if (word === '') return null;
  return LANG_ALIAS[word] ?? null;
}

const LANG_ALIAS: Record<string, string> = {
  js: 'js',
  javascript: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'ts',
  typescript: 'ts',
  tsx: 'ts',
  json: 'json',
  jsonc: 'json',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  shell: 'sh',
  py: 'python',
  python: 'python',
  python3: 'python',
  diff: 'diff',
  patch: 'diff',
  toml: 'toml',
};

/**
 * One line of code to runs, plus the state the next line starts from.
 *
 * Never throws: any internal surprise downgrades to a single uninked run for the whole line,
 * because the block still has to render and plain is always true.
 */
export function highlightLine(
  line: string,
  lang: string | null,
  state: HighlightState,
): { runs: HighlightRun[]; state: HighlightState } {
  try {
    switch (lang) {
      case 'js':
      case 'ts':
        return scanJs(line, state);
      case 'python':
        return scanPython(line, state);
      case 'json':
        return { runs: scanJson(line), state: { open: null } };
      case 'sh':
        return { runs: scanSh(line), state: { open: null } };
      case 'toml':
        return { runs: scanToml(line), state: { open: null } };
      case 'diff':
        return { runs: scanDiff(line), state: { open: null } };
      default:
        return { runs: plain(line), state: { open: null } };
    }
  } catch {
    return { runs: plain(line), state: { open: null } };
  }
}

// ---------------------------------------------------------------------------------------------
// Shared machinery
// ---------------------------------------------------------------------------------------------

function plain(line: string): HighlightRun[] {
  return line === '' ? [] : [{ text: line, ink: null }];
}

/** Coalesces adjacent same-ink text, so a line of punctuation is one run and not forty. */
function makeEmitter(): { emit: (text: string, ink: Ink | null) => void; done: () => HighlightRun[] } {
  const runs: HighlightRun[] = [];
  return {
    emit: (text: string, ink: Ink | null): void => {
      if (text === '') return;
      const last = runs[runs.length - 1];
      if (last !== undefined && last.ink === ink) last.text += text;
      else runs.push({ text, ink });
    },
    done: (): HighlightRun[] => runs,
  };
}

/** Index of the next `quote` not preceded by an odd run of backslashes, or -1. */
function findUnescaped(line: string, quote: string, from: number): number {
  let i = from;
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2;
      continue;
    }
    if (line.startsWith(quote, i)) return i;
    i += 1;
  }
  return -1;
}

const WORD = /[A-Za-z0-9_$]/u;
const IDENT_START = /[A-Za-z_$]/u;
const DIGIT = /[0-9]/u;

// ---------------------------------------------------------------------------------------------
// js / ts
// ---------------------------------------------------------------------------------------------

const JS_KEYWORDS = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in',
  'infer', 'instanceof', 'interface', 'keyof', 'let', 'namespace', 'never', 'new', 'number',
  'object', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'satisfies', 'set',
  'static', 'string', 'super', 'switch', 'symbol', 'this', 'throw', 'try', 'type', 'typeof',
  'unknown', 'var', 'void', 'while', 'yield',
]);
const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

function scanJs(line: string, state: HighlightState): { runs: HighlightRun[]; state: HighlightState } {
  const { emit, done } = makeEmitter();
  let i = 0;

  if (state.open === 'js-block-comment') {
    const close = line.indexOf('*/');
    if (close === -1) return { runs: line === '' ? [] : [{ text: line, ink: 'grey' }], state };
    emit(line.slice(0, close + 2), 'grey');
    i = close + 2;
  } else if (state.open === 'js-template') {
    const end = findUnescaped(line, '`', 0);
    if (end === -1) return { runs: line === '' ? [] : [{ text: line, ink: 'green' }], state };
    emit(line.slice(0, end + 1), 'green');
    i = end + 1;
  }

  let open: HighlightState['open'] = null;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === '/' && line[i + 1] === '/') {
      emit(line.slice(i), 'grey');
      i = line.length;
      break;
    }
    if (ch === '/' && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close === -1) {
        emit(line.slice(i), 'grey');
        open = 'js-block-comment';
        i = line.length;
        break;
      }
      emit(line.slice(i, close + 2), 'grey');
      i = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = findUnescaped(line, ch, i + 1);
      const stop = end === -1 ? line.length : end + 1;
      emit(line.slice(i, stop), 'green');
      i = stop;
      continue;
    }
    if (ch === '`') {
      const end = findUnescaped(line, '`', i + 1);
      if (end === -1) {
        emit(line.slice(i), 'green');
        open = 'js-template';
        i = line.length;
        break;
      }
      emit(line.slice(i, end + 1), 'green');
      i = end + 1;
      continue;
    }
    if (DIGIT.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[\w.]/u.test(line[j] as string)) j += 1;
      emit(line.slice(i, j), 'yellow');
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < line.length && WORD.test(line[j] as string)) j += 1;
      const word = line.slice(i, j);
      emit(word, JS_LITERALS.has(word) ? 'yellow' : JS_KEYWORDS.has(word) ? 'cyan' : null);
      i = j;
      continue;
    }
    emit(ch, null);
    i += 1;
  }
  return { runs: done(), state: { open } };
}

// ---------------------------------------------------------------------------------------------
// python
// ---------------------------------------------------------------------------------------------

const PY_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);
const PY_LITERALS = new Set(['True', 'False', 'None']);

function scanPython(line: string, state: HighlightState): { runs: HighlightRun[]; state: HighlightState } {
  const { emit, done } = makeEmitter();
  let i = 0;

  if (state.open === 'py-triple-single' || state.open === 'py-triple-double') {
    const quote = state.open === 'py-triple-single' ? "'''" : '"""';
    const close = line.indexOf(quote);
    if (close === -1) return { runs: line === '' ? [] : [{ text: line, ink: 'green' }], state };
    emit(line.slice(0, close + 3), 'green');
    i = close + 3;
  }

  let open: HighlightState['open'] = null;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === '#') {
      emit(line.slice(i), 'grey');
      i = line.length;
      break;
    }
    if (line.startsWith("'''", i) || line.startsWith('"""', i)) {
      const quote = line.slice(i, i + 3);
      const close = line.indexOf(quote, i + 3);
      if (close === -1) {
        emit(line.slice(i), 'green');
        open = quote === "'''" ? 'py-triple-single' : 'py-triple-double';
        i = line.length;
        break;
      }
      emit(line.slice(i, close + 3), 'green');
      i = close + 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = findUnescaped(line, ch, i + 1);
      const stop = end === -1 ? line.length : end + 1;
      emit(line.slice(i, stop), 'green');
      i = stop;
      continue;
    }
    if (DIGIT.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[\w.]/u.test(line[j] as string)) j += 1;
      emit(line.slice(i, j), 'yellow');
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < line.length && WORD.test(line[j] as string)) j += 1;
      const word = line.slice(i, j);
      emit(word, PY_LITERALS.has(word) ? 'yellow' : PY_KEYWORDS.has(word) ? 'cyan' : null);
      i = j;
      continue;
    }
    emit(ch, null);
    i += 1;
  }
  return { runs: done(), state: { open } };
}

// ---------------------------------------------------------------------------------------------
// json
// ---------------------------------------------------------------------------------------------

const JSON_LITERALS = new Set(['true', 'false', 'null']);

function scanJson(line: string): HighlightRun[] {
  const { emit, done } = makeEmitter();
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === '"') {
      const end = findUnescaped(line, '"', i + 1);
      const stop = end === -1 ? line.length : end + 1;
      emit(line.slice(i, stop), 'green');
      i = stop;
      continue;
    }
    if (DIGIT.test(ch) || (ch === '-' && DIGIT.test(line[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < line.length && /[\d.eE+-]/u.test(line[j] as string)) j += 1;
      emit(line.slice(i, j), 'yellow');
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < line.length && WORD.test(line[j] as string)) j += 1;
      const word = line.slice(i, j);
      emit(word, JSON_LITERALS.has(word) ? 'yellow' : null);
      i = j;
      continue;
    }
    emit(ch, null);
    i += 1;
  }
  return done();
}

// ---------------------------------------------------------------------------------------------
// sh
// ---------------------------------------------------------------------------------------------

const SH_KEYWORDS = new Set([
  'case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'exit', 'export', 'fi', 'for',
  'function', 'if', 'in', 'local', 'readonly', 'return', 'select', 'set', 'then', 'time',
  'until', 'while',
]);

function scanSh(line: string): HighlightRun[] {
  const { emit, done } = makeEmitter();
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    // A comment starts at '#' only at the line head or after whitespace: '${#var}' and 'a#b'
    // are not comments, and getting that wrong greys out real code.
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      emit(line.slice(i), 'grey');
      i = line.length;
      break;
    }
    if (ch === '"' || ch === "'") {
      const end = ch === "'" ? line.indexOf("'", i + 1) : findUnescaped(line, '"', i + 1);
      const stop = end === -1 ? line.length : end + 1;
      emit(line.slice(i, stop), 'green');
      i = stop;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < line.length && WORD.test(line[j] as string)) j += 1;
      const word = line.slice(i, j);
      emit(word, SH_KEYWORDS.has(word) ? 'cyan' : null);
      i = j;
      continue;
    }
    if (DIGIT.test(ch)) {
      let j = i + 1;
      while (j < line.length && WORD.test(line[j] as string)) j += 1;
      emit(line.slice(i, j), 'yellow');
      i = j;
      continue;
    }
    emit(ch, null);
    i += 1;
  }
  return done();
}

// ---------------------------------------------------------------------------------------------
// toml
// ---------------------------------------------------------------------------------------------

const TOML_LITERALS = new Set(['true', 'false']);

function scanToml(line: string): HighlightRun[] {
  // A section header is the one whole-line construct: '[projects]' names where the reader is.
  if (/^\s*\[[^\]]*\]\s*$/u.test(line)) return line === '' ? [] : [{ text: line, ink: 'cyan' }];
  const { emit, done } = makeEmitter();
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === '#') {
      emit(line.slice(i), 'grey');
      i = line.length;
      break;
    }
    if (ch === '"' || ch === "'") {
      const end = ch === "'" ? line.indexOf("'", i + 1) : findUnescaped(line, '"', i + 1);
      const stop = end === -1 ? line.length : end + 1;
      emit(line.slice(i, stop), 'green');
      i = stop;
      continue;
    }
    if (DIGIT.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[\w.:+-]/u.test(line[j] as string)) j += 1;
      emit(line.slice(i, j), 'yellow');
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < line.length && WORD.test(line[j] as string)) j += 1;
      const word = line.slice(i, j);
      emit(word, TOML_LITERALS.has(word) ? 'yellow' : null);
      i = j;
      continue;
    }
    emit(ch, null);
    i += 1;
  }
  return done();
}

// ---------------------------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------------------------

function scanDiff(line: string): HighlightRun[] {
  if (line === '') return [];
  if (line.startsWith('@@')) return [{ text: line, ink: 'cyan' }];
  if (line.startsWith('+')) return [{ text: line, ink: 'green' }];
  if (line.startsWith('-')) return [{ text: line, ink: 'red' }];
  return [{ text: line, ink: null }];
}
