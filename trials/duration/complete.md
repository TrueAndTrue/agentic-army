# ORDERS — fix `parseDuration`

You are an Engineer. This brief is complete. Everything you need to decide has already been
decided above you; you should not need to design anything, choose anything, or infer anything.
If you find yourself weighing options, re-read this file — the answer is in it.

## THE ONE FILE YOU CHANGE

`src/duration.js`. It exports one function:

```js
export function parseDuration(input)
```

Do not rename it, do not change how it is exported, do not add a default export, do not split it
into more files.

## WHAT IT MUST DO

Take a duration string, return an integer number of milliseconds.

### Units, and their values in milliseconds

| suffix | milliseconds |
|--------|--------------|
| `ms`   | 1            |
| `s`    | 1000         |
| `m`    | 60000        |
| `h`    | 3600000      |
| `d`    | 86400000     |

No other suffix exists. `w`, `y`, `sec`, `min`, `S`, `M`, `H` are all invalid input.
Matching is case-SENSITIVE: `10S` is invalid, `10s` is valid.

### The grammar, exactly

A valid input is a string of one or more `<number><suffix>` segments, concatenated with nothing
between them, optionally surrounded by whitespace.

- `<number>` is one or more digits, optionally followed by `.` and one or more digits.
  `2`, `2.5`, `0.5` are numbers. `.5`, `2.`, `2.5.5`, `+2`, `-2`, `1e3` are NOT.
- `<suffix>` is one of the five in the table above.
- Segments are summed left to right. `1h30m` is `3600000 + 1800000 = 5400000`.
- Leading and trailing whitespace is stripped before parsing. Whitespace INSIDE the string is
  invalid: `1h 30m` is invalid input.
- A number with no suffix is invalid. A suffix with no number is invalid. Trailing junk after
  the last complete segment is invalid.
- Repeated units are not special-cased: `1h1h` is valid and returns `7200000`. Do not add a
  rule forbidding it, and do not require the units to be in descending order.

### The return value

An integer. Fractional segments are legal input (`2.5s`), and the SUM is rounded to the nearest
integer with `Math.round` at the very end — round once, at the end, not per segment.

### What it does on bad input

Throw a `TypeError`. The message is not asserted by the tests; anything readable is fine.

Non-string input throws the same `TypeError`. `null`, `undefined`, `42`, `{}`, an array — all
`TypeError`. Do not coerce, do not call `String()` on the argument to make it parseable.

### The complete list of inputs the tests use

These are the exact cases. There are no hidden ones.

Valid:

| input          | returns   |
|----------------|-----------|
| `'500ms'`      | 500       |
| `'10s'`        | 10000     |
| `'5m'`         | 300000    |
| `'2h'`         | 7200000   |
| `'1d'`         | 86400000  |
| `'2.5s'`       | 2500      |
| `'0.5h'`       | 1800000   |
| `'1h30m'`      | 5400000   |
| `'1m30s'`      | 90000     |
| `'1h1m1s1ms'`  | 3661001   |
| `'  10s  '`    | 10000     |

Invalid — every one of these throws `TypeError`:

`''`, `'   '`, `'abc'`, `'10'`, `'10x'`, `'s'`, `'10s5'`, `'-5s'`, `'1h30'`, `null`,
`undefined`, `42`

## HOW YOU KNOW YOU ARE DONE

Run this, in the root of your workspace:

```
node --test test/duration.test.js
```

It must report `fail 0`. On the code as you received it, two of its five tests fail — that is
expected, and making those two pass without breaking the other three is the entire job.

## CONSTRAINTS — these are hard

1. **Change `src/duration.js` and nothing else.** Not the test file, not `package.json`, not
   `NOTES.md`, not the README. If a test looks wrong to you, it is not wrong — it is the
   specification, and it agrees with this brief.
2. **Do not install anything.** No `npm install`, no new dependencies, no imports beyond what
   Node provides. This package has no dependencies and will not be getting any.
3. **Commit your work** before you finish, and leave the working tree clean. An uncommitted
   change here is a lost change. The workspace arrives at a detached HEAD; a commit on a
   detached HEAD is fine and is what is expected.
4. **Do not push anything anywhere.**

## WHEN YOU ARE DONE

Return the schema-constrained report and nothing else.
