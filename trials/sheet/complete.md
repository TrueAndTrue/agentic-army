# ORDERS — implement the sheet evaluator

You are an Engineer. This brief is complete. Every decision has already been made above you.
You should not need to design anything, choose between approaches, or infer any behaviour that
is not written down here. If you find yourself weighing options, re-read this file — the answer
is in it. If you find yourself guessing, stop and re-read; guessing means you missed a section.

## THE ONE FILE YOU CHANGE

`src/sheet.js`. It must export exactly one function:

```js
export function evaluate(cells)
```

Do not rename it, do not add a default export, do not add other exports, do not split it into
more files. It arrives as a stub that throws; replacing that stub is the job.

## WHAT IT DOES

`cells` is a plain object mapping a cell reference to a string: `{ A1: '5', B2: '=A1*2' }`.

`evaluate` returns a NEW plain object with the same keys, mapping each to that cell's computed
value — a JavaScript number, or one of the error strings below.

**It must not mutate its argument.** Not the object, not any value on it.

### What a cell's text means

| text | meaning |
|------|---------|
| `''`, or whitespace only | an EMPTY cell |
| a number literal, e.g. `'42'`, `'-3.5'`, `'  7  '` | that number |
| starts with `=` (after trimming) | a formula |
| anything else | `#ERROR!` |

A number literal is: an optional leading `-`, then digits, then optionally `.` and more digits.
No exponent (`1e3` is not a number literal), no leading `+`, no trailing `.` (`2.` is invalid),
no bare `.5`. Surrounding whitespace is trimmed before this test.

An EMPTY cell's value in the RETURNED object is the number `0`. Being empty matters elsewhere —
see functions — but what comes back for the cell itself is `0`.

A reference to a key that is not present in `cells` at all is treated exactly as an empty cell.
It is not an error, and it does not appear in the returned object.

## THE FORMULA LANGUAGE

Everything after the leading `=`. Whitespace is permitted between any two tokens and is
otherwise insignificant.

```
expr    := term (('+' | '-') term)*
term    := factor (('*' | '/') factor)*
factor  := '-' factor | primary
primary := NUMBER | REF | FUNC '(' arglist ')' | '(' expr ')'
arglist := arg (',' arg)*
arg     := range | expr
range   := REF ':' REF
```

- `+` and `-` are left-associative. `1-2-3` is `-4`, not `2`.
- `*` and `/` are left-associative and bind tighter than `+` and `-`. `2+3*4` is `14`.
- Unary `-` binds tighter than `*` and `/`. `-2*3` is `-6`. `--1` is `1` and is legal.
- `NUMBER` inside a formula has the same shape as a number literal but WITHOUT the leading `-`
  (a leading minus is unary minus, handled by the grammar above).
- `REF` is one uppercase letter `A`–`Z` followed by one to three digits with no leading zero:
  `A1`, `Z999`, `C42`. `a1`, `A0`, `AA1`, `A1000` and `A01` are not refs, and a formula
  containing one is `#ERROR!`.
- `FUNC` is one of exactly `SUM`, `MIN`, `MAX`, `COUNT`. Uppercase only; `sum` is `#ERROR!`.
- A `range` is legal ONLY as a direct argument to a function. `=A1:B2` and `=1+A1:B2` are
  `#ERROR!`.
- A function call with zero arguments — `=SUM()` — is `#ERROR!`.
- Trailing junk after a complete expression is `#ERROR!`. So is an empty formula (`=`).

### Ranges

`A1:B3` is the inclusive rectangle spanned by the two corners. **Corner order does not matter**:
`B3:A1`, `A3:B1` and `A1:B3` all denote the same nine cells. Normalise the column letters and
the row numbers independently, each min-to-max.

The cells of a range are visited in **row-major order**: ascending row, and within a row,
ascending column.

### The four functions

Each takes one or more arguments. An argument is either a range (contributing every cell in it)
or an expression (contributing its single value). The contributions are concatenated in argument
order, and within a range argument in row-major order, into one list of values.

**Empty cells are SKIPPED by all four functions.** This is the rule most likely to be got wrong:
an empty cell is not a zero here. `SUM(A1:A3)` where `A2` is empty adds two numbers, not three.

- `SUM` — total of the non-empty values. A list with no non-empty values sums to `0`.
- `COUNT` — how many non-empty values there are. Always a number, never `#EMPTY!`.
- `MIN` / `MAX` — the smallest / largest non-empty value. If there are NO non-empty values, the
  result is `#EMPTY!`.

Note that an expression argument is never "empty" — `SUM(A1, 0)` contributes the `0`.

## ERRORS

The five error values, as exact strings:

| value | when |
|-------|------|
| `#ERROR!` | the cell's text is neither empty, nor a number literal, nor a parseable formula |
| `#DIV/0!` | a division whose divisor evaluates to `0` |
| `#CYCLE!` | the cell's value depends, directly or transitively, on itself |
| `#EMPTY!` | `MIN` or `MAX` over a list with no non-empty values |

(That table has four rows. There is no fifth error value; do not invent one.)

### Propagation

An error is a value, and it flows outward.

- If either operand of a binary operator is an error, the result is an error. **If both are
  errors, the LEFT operand's error wins.**
- Unary minus of an error is that error.
- If any value contributed to a function's argument list is an error, the function's result is
  that error — specifically, the FIRST error encountered in the concatenation order defined
  above (argument order, then row-major within a range).
- Division checks its divisor for zero only after both operands are known not to be errors, and
  the left operand's error still wins if both are errors.

### Cycles

`#CYCLE!` is produced when evaluating a cell requires that same cell's value. It then propagates
like any other error, so a cell that merely depends on a cycle also ends up `#CYCLE!` — you do
not need to distinguish "on the cycle" from "downstream of the cycle".

**A cycle must not prevent the rest of the sheet from computing.** If `A1` and `A2` reference
each other and `B1` is `=5`, then `B1` is `5` in the result. This is the single most important
behaviour in this brief.

Self-reference (`A1: '=A1'`) is a cycle. A cycle through a range (`A1: '=SUM(A1:A3)'`) is a
cycle.

## THE ALGORITHM

Use this. It is chosen; you are not being asked to pick one.

Memoised depth-first evaluation with three-colour marking.

1. Keep two maps: `done` (ref → computed value) and `state` (ref → `'visiting'` or `'done'`).
2. `valueOf(ref)`:
   - If `ref` is in `done`, return it.
   - If `state.get(ref) === 'visiting'`, return `#CYCLE!` — **do not** write that into `done`,
     because the cell is still mid-evaluation and its real result is decided by the frame that
     started it.
   - Mark `state.set(ref, 'visiting')`.
   - Compute the cell: empty → `0`; number literal → the number; formula → parse and evaluate,
     recursing through `valueOf` for every `REF` it mentions; otherwise `#ERROR!`.
   - Write the result into `done`, set `state.set(ref, 'done')`, return it.
3. Drive it by calling `valueOf` once for every key in `cells`, and build the result object from
   `done`.

Parse each formula into an AST first and then evaluate the AST. Do not try to parse and
evaluate in one pass — the unary-minus and precedence rules above are hard to get right that
way, and a re-parse per reference is wasteful.

A parse error must be contained: it makes THAT cell `#ERROR!` and must not throw out of
`evaluate`. **`evaluate` must never throw**, whatever it is handed.

## NUMBERS

Every numeric result — the value of a cell, not intermediate arithmetic — is rounded to ten
decimal places before it is returned:

```js
Math.round(value * 1e10) / 1e10
```

This is so that `=0.1+0.2` is `0.3` and not `0.30000000000000004`. Round once, at the point the
cell's value is settled. Do not round intermediates.

`-0` must be normalised to `0`.

## HOW YOU KNOW YOU ARE DONE

In the root of your workspace:

```
node --test test/sheet.test.js
```

It must report `fail 0`. On the stub as you received it, every test fails.

Passing that suite is necessary and not sufficient: the behaviour above is the specification,
and it is checked against cases the visible suite does not contain. Implement the spec, not the
test file.

## CONSTRAINTS — these are hard

1. **Change `src/sheet.js` and nothing else.** Not the test file, not `package.json`, not
   `NOTES.md`. If a test looks wrong to you, it is not wrong — it agrees with this brief.
2. **Leave no other files behind.** No scratch scripts, no debug output files, no temporary
   notes. If you write one to try something out, delete it before you finish. The working tree
   is checked, and an untracked file you forgot about counts as changing a file you were told
   not to touch.
3. **Do not install anything.** No `npm install`, no dependencies, no imports beyond what Node
   itself provides. This package has none and is not getting any.
4. **Commit your work** before you finish, and leave the working tree clean. The workspace
   arrives at a detached HEAD; committing there is fine and is what is expected.
5. **Do not push anything anywhere.**

## WHEN YOU ARE DONE

Return the schema-constrained report and nothing else.
