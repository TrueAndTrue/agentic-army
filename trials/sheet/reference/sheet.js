/**
 * Reference implementation of the sheet evaluator described in complete.md.
 *
 * Algorithm: memoised depth-first evaluation with three-colour marking (done / visiting),
 * parsing each formula into an AST first and then evaluating that AST.
 *
 * @param {Object<string, string>} cells - a plain object mapping a cell reference to its text.
 * @returns {Object<string, number|string>} a new object, same keys, mapping each to its computed value.
 */
export function evaluate(cells) {
  const source = cells && typeof cells === 'object' ? cells : {};

  // ref -> computed, settled value (number or error string)
  const done = new Map();
  // ref -> 'visiting' | 'done', used for cycle detection
  const state = new Map();

  function hasCell(ref) {
    return Object.prototype.hasOwnProperty.call(source, ref);
  }

  function cellText(ref) {
    const raw = source[ref];
    return typeof raw === 'string' ? raw : '';
  }

  // A cell (or an absent key) is "empty" for the purposes of the range-skip rule.
  function isEmptyRef(ref) {
    if (!hasCell(ref)) return true;
    return cellText(ref).trim() === '';
  }

  function valueOf(ref) {
    if (done.has(ref)) return done.get(ref);
    if (!hasCell(ref)) return 0; // absent key behaves exactly like an empty cell
    if (state.get(ref) === 'visiting') return '#CYCLE!'; // do not write to `done` here
    state.set(ref, 'visiting');

    let result;
    try {
      result = computeCell(ref);
    } catch {
      result = '#ERROR!';
    }

    if (typeof result === 'number') {
      result = Math.round(result * 1e10) / 1e10;
      if (result === 0) result = 0; // normalise -0 to 0
    }

    done.set(ref, result);
    state.set(ref, 'done');
    return result;
  }

  function computeCell(ref) {
    const trimmed = cellText(ref).trim();
    if (trimmed === '') return 0;
    if (isNumberLiteral(trimmed)) return Number(trimmed);
    if (trimmed[0] === '=') {
      const ast = parseFormula(trimmed.slice(1));
      return evalNode(ast, valueOf, isEmptyRef);
    }
    return '#ERROR!';
  }

  const result = {};
  for (const key of Object.keys(source)) {
    result[key] = valueOf(key);
  }
  return result;
}

// --- number literals -----------------------------------------------------------------------

// Leading '-' allowed (used for whole-cell literals, not for the formula NUMBER token).
function isNumberLiteral(s) {
  return /^-?[0-9]+(\.[0-9]+)?$/.test(s);
}

const REF_RE = /^[A-Z][1-9][0-9]{0,2}$/;
const FUNCS = new Set(['SUM', 'MIN', 'MAX', 'COUNT']);

// --- tokenizer -------------------------------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if ('()+-*/:,'.includes(ch)) {
      tokens.push({ type: ch });
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      tokens.push({ type: 'NUM', text: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const m = /^[A-Za-z][A-Za-z0-9]*/.exec(src.slice(i));
      tokens.push({ type: 'IDENT', text: m[0] });
      i += m[0].length;
      continue;
    }
    throw new Error('unrecognised character');
  }
  return tokens;
}

// --- parser: builds an AST, never evaluates ---------------------------------------------------

function parseFormula(src) {
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new Error('empty formula');

  let pos = 0;
  const peek = (o = 0) => tokens[pos + o];
  const consume = () => tokens[pos++];
  const expect = (type) => {
    const t = consume();
    if (!t || t.type !== type) throw new Error(`expected ${type}`);
  };

  function parseExpr() {
    let left = parseTerm();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = consume().type;
      const right = parseTerm();
      left = { type: 'bin', op, left, right };
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (peek() && (peek().type === '*' || peek().type === '/')) {
      const op = consume().type;
      const right = parseFactor();
      left = { type: 'bin', op, left, right };
    }
    return left;
  }

  function parseFactor() {
    if (peek() && peek().type === '-') {
      consume();
      return { type: 'neg', operand: parseFactor() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('unexpected end of formula');

    if (t.type === 'NUM') {
      consume();
      return { type: 'num', value: Number(t.text) };
    }

    if (t.type === 'IDENT') {
      if (REF_RE.test(t.text)) {
        consume();
        return { type: 'ref', ref: t.text };
      }
      if (FUNCS.has(t.text)) {
        consume();
        expect('(');
        const args = parseArglist();
        expect(')');
        return { type: 'call', func: t.text, args };
      }
      throw new Error('invalid identifier');
    }

    if (t.type === '(') {
      consume();
      const e = parseExpr();
      expect(')');
      return e;
    }

    throw new Error('unexpected token');
  }

  function parseArglist() {
    const args = [parseArg()];
    while (peek() && peek().type === ',') {
      consume();
      args.push(parseArg());
    }
    return args;
  }

  function parseArg() {
    const a = peek();
    const b = peek(1);
    const c = peek(2);
    if (
      a && a.type === 'IDENT' && REF_RE.test(a.text) &&
      b && b.type === ':' &&
      c && c.type === 'IDENT' && REF_RE.test(c.text)
    ) {
      consume();
      consume();
      consume();
      return { type: 'range', from: a.text, to: c.text };
    }
    return { type: 'expr', node: parseExpr() };
  }

  const ast = parseExpr();
  if (pos !== tokens.length) throw new Error('trailing junk after formula');
  return ast;
}

// --- range enumeration (row-major, corners normalised independently) --------------------------

function colNum(letter) {
  return letter.charCodeAt(0) - 64;
}

function colLetter(n) {
  return String.fromCharCode(64 + n);
}

function parseRefParts(ref) {
  const m = /^([A-Z])([0-9]+)$/.exec(ref);
  return { col: colNum(m[1]), row: Number(m[2]) };
}

function* rangeRefs(fromRef, toRef) {
  const a = parseRefParts(fromRef);
  const b = parseRefParts(toRef);
  const colMin = Math.min(a.col, b.col);
  const colMax = Math.max(a.col, b.col);
  const rowMin = Math.min(a.row, b.row);
  const rowMax = Math.max(a.row, b.row);
  for (let r = rowMin; r <= rowMax; r++) {
    for (let c = colMin; c <= colMax; c++) {
      yield colLetter(c) + r;
    }
  }
}

// --- AST evaluation ----------------------------------------------------------------------------

function evalNode(node, valueOf, isEmptyRef) {
  switch (node.type) {
    case 'num':
      return node.value;

    case 'ref':
      return valueOf(node.ref);

    case 'neg': {
      const v = evalNode(node.operand, valueOf, isEmptyRef);
      if (typeof v === 'string') return v;
      return -v;
    }

    case 'bin': {
      const l = evalNode(node.left, valueOf, isEmptyRef);
      if (typeof l === 'string') return l; // left operand's error wins
      const r = evalNode(node.right, valueOf, isEmptyRef);
      if (typeof r === 'string') return r;
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          if (r === 0) return '#DIV/0!';
          return l / r;
        default:
          throw new Error('unknown operator');
      }
    }

    case 'call': {
      const values = [];
      for (const arg of node.args) {
        if (arg.type === 'range') {
          for (const cellRef of rangeRefs(arg.from, arg.to)) {
            if (isEmptyRef(cellRef)) continue; // empty cells are skipped by all four functions
            values.push(valueOf(cellRef));
          }
        } else {
          // an expression argument always contributes its single value, never skipped
          values.push(evalNode(arg.node, valueOf, isEmptyRef));
        }
      }

      for (const v of values) {
        if (typeof v === 'string') return v; // first error in concatenation order
      }

      switch (node.func) {
        case 'SUM':
          return values.reduce((a, b) => a + b, 0);
        case 'COUNT':
          return values.length;
        case 'MIN':
          return values.length ? Math.min(...values) : '#EMPTY!';
        case 'MAX':
          return values.length ? Math.max(...values) : '#EMPTY!';
        default:
          throw new Error('unknown function');
      }
    }

    default:
      throw new Error('unknown node type');
  }
}
