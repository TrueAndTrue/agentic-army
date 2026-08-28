/**
 * The syntax highlighter behind fenced blocks: `src/view/highlight.ts`.
 *
 * The suite leans on one invariant above everything else: concatenating a line's runs
 * reproduces the line byte for byte. Width arithmetic two modules away measures the plain text,
 * so a highlighter that eats or invents a byte breaks wrapping somewhere it can never be
 * debugged from. Every other assertion here is about ink, and ink is allowed to be wrong in the
 * safe direction (null) but never in the loud one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { HighlightRun, HighlightState } from '../src/view/highlight.ts';
import { highlightLine, initialHighlightState, normalizeLang } from '../src/view/highlight.ts';

/** Runs back to the string they came from. */
function joined(runs: readonly HighlightRun[]): string {
  return runs.map((run) => run.text).join('');
}

/** The ink a given substring landed with, for assertions that read like the requirement. */
function inkOf(runs: readonly HighlightRun[], text: string): string | null | undefined {
  const hit = runs.find((run) => run.text.includes(text));
  return hit?.ink;
}

test('the reproduction invariant holds for every language on hostile lines', () => {
  const nasty = [
    '',
    'plain words only',
    'const s = "unterminated',
    "echo 'half open",
    'a\tb\t\tc',
    '`` ` `` `',
    '\\\\\\" \\\' \\`',
    'emoji 🎖 and CJK 宽字符 mixed in',
    '/* open forever',
    '"""',
    "x = '''",
    '# just a comment',
    '@@ -1,3 +2,4 @@',
    '+++ b/file',
    '[projects]',
    '   ',
    '****',
    '0x1f numbers 12.5e-3 and words',
  ];
  for (const lang of ['js', 'ts', 'json', 'sh', 'toml', 'python', 'diff', null, 'brainfuck']) {
    let state: HighlightState = initialHighlightState();
    for (const line of nasty) {
      const result = highlightLine(line, lang, state);
      assert.equal(
        joined(result.runs),
        line,
        `lang ${String(lang)} did not reproduce ${JSON.stringify(line)}`,
      );
      for (const run of result.runs) {
        assert.notEqual(run.text, '', `lang ${String(lang)} emitted an empty run`);
      }
      state = result.state;
    }
  }
});

test('keywords match at word boundaries only', () => {
  const { runs } = highlightLine('before for beforehand forth for', 'js', initialHighlightState());
  const cyan = runs.filter((run) => run.ink === 'cyan').map((run) => run.text);
  assert.deepEqual(cyan, ['for', 'for'], `'for' inside a word was highlighted: ${JSON.stringify(runs)}`);
  assert.equal(inkOf(runs, 'before'), null);
});

test('a string with escaped quotes stays one green run to its real close', () => {
  const { runs } = highlightLine('const s = "a\\"b" + rest;', 'js', initialHighlightState());
  assert.equal(inkOf(runs, '"a\\"b"'), 'green', JSON.stringify(runs));
  assert.equal(inkOf(runs, 'rest'), null);
  assert.equal(inkOf(runs, 'const'), 'cyan');
});

test('an open block comment greys three lines and releases on its close', () => {
  let state = initialHighlightState();
  const first = highlightLine('const a = 1; /* begins here', 'ts', state);
  assert.equal(inkOf(first.runs, 'begins'), 'grey');
  assert.equal(inkOf(first.runs, 'const'), 'cyan');
  state = first.state;
  assert.equal(state.open, 'js-block-comment');

  const middle = highlightLine('still inside, const is not a keyword here', 'ts', state);
  assert.deepEqual(middle.runs, [
    { text: 'still inside, const is not a keyword here', ink: 'grey' },
  ]);
  state = middle.state;

  const last = highlightLine('done */ const b = 2;', 'ts', state);
  assert.equal(inkOf(last.runs, 'done */'), 'grey');
  assert.equal(inkOf(last.runs, 'const'), 'cyan');
  assert.equal(last.state.open, null);
});

test('a template literal spans lines as one green stretch', () => {
  let state = initialHighlightState();
  state = highlightLine('const t = `first', 'js', state).state;
  assert.equal(state.open, 'js-template');
  const inside = highlightLine('middle line', 'js', state);
  assert.deepEqual(inside.runs, [{ text: 'middle line', ink: 'green' }]);
  const closed = highlightLine('last` + x', 'js', inside.state);
  assert.equal(inkOf(closed.runs, 'last`'), 'green');
  assert.equal(closed.state.open, null);
});

test('a python triple-quoted string spans lines and closes on its own quote', () => {
  let state = initialHighlightState();
  state = highlightLine('doc = """opening', 'python', state).state;
  assert.equal(state.open, 'py-triple-double');
  const inside = highlightLine("it even ignores ''' here", 'python', state);
  assert.deepEqual(inside.runs, [{ text: "it even ignores ''' here", ink: 'green' }]);
  const closed = highlightLine('the end""" + tail', 'python', inside.state);
  assert.equal(inkOf(closed.runs, 'the end"""'), 'green');
  assert.equal(closed.state.open, null);
});

test('diff lines colour by their first column and nothing subtler', () => {
  const state = initialHighlightState();
  assert.deepEqual(highlightLine('+added line', 'diff', state).runs, [
    { text: '+added line', ink: 'green' },
  ]);
  assert.deepEqual(highlightLine('-removed line', 'diff', state).runs, [
    { text: '-removed line', ink: 'red' },
  ]);
  assert.deepEqual(highlightLine('@@ -1,4 +1,6 @@', 'diff', state).runs, [
    { text: '@@ -1,4 +1,6 @@', ink: 'cyan' },
  ]);
  assert.deepEqual(highlightLine(' context stays plain', 'diff', state).runs, [
    { text: ' context stays plain', ink: null },
  ]);
});

test('sh: a comment needs a word boundary, and reserved words are the only cyan', () => {
  const { runs } = highlightLine('if [ -f "$x" ]; then echo ${#x} # count', 'sh', initialHighlightState());
  assert.equal(inkOf(runs, 'if'), 'cyan');
  assert.equal(inkOf(runs, 'then'), 'cyan');
  assert.equal(inkOf(runs, '# count'), 'grey');
  assert.equal(inkOf(runs, '"$x"'), 'green');
  // '${#x}' is parameter expansion, not a comment, and echo is a command, not a reserved word.
  assert.equal(inkOf(runs, 'echo'), null);
  const hash = runs.find((run) => run.text.includes('{#'));
  assert.notEqual(hash?.ink, 'grey', `\${#x} was read as a comment: ${JSON.stringify(runs)}`);
});

test('toml: headers, comments, strings and literals; keys stay plain', () => {
  const state = initialHighlightState();
  assert.deepEqual(highlightLine('[projects]', 'toml', state).runs, [
    { text: '[projects]', ink: 'cyan' },
  ]);
  const { runs } = highlightLine('ceiling = 2 # raised by hand', 'toml', state);
  assert.equal(inkOf(runs, 'ceiling'), null);
  assert.equal(inkOf(runs, '2'), 'yellow');
  assert.equal(inkOf(runs, '# raised by hand'), 'grey');
});

test('json: strings green, numbers and literals yellow, punctuation plain', () => {
  const { runs } = highlightLine('{ "ok": true, "n": -12.5, "s": "x" }', 'json', initialHighlightState());
  assert.equal(inkOf(runs, '"ok"'), 'green');
  assert.equal(inkOf(runs, 'true'), 'yellow');
  assert.equal(inkOf(runs, '-12.5'), 'yellow');
  assert.equal(inkOf(runs, '{'), null);
});

test('an unknown language is one uninked run, never a guess', () => {
  assert.deepEqual(highlightLine('for x in "y" # z', 'brainfuck', initialHighlightState()).runs, [
    { text: 'for x in "y" # z', ink: null },
  ]);
  assert.deepEqual(highlightLine('for x in "y"', null, initialHighlightState()).runs, [
    { text: 'for x in "y"', ink: null },
  ]);
});

test('normalizeLang: fence spellings, aliases, padding, and honest nulls', () => {
  assert.equal(normalizeLang('```ts'), 'ts');
  assert.equal(normalizeLang('```'), null);
  assert.equal(normalizeLang('``` sh '), 'sh');
  assert.equal(normalizeLang('```javascript'), 'js');
  assert.equal(normalizeLang('bash'), 'sh');
  assert.equal(normalizeLang('```python3'), 'python');
  assert.equal(normalizeLang('```patch'), 'diff');
  assert.equal(normalizeLang('```mermaid'), null);
  assert.equal(normalizeLang('   '), null);
});

test('stateless languages always hand back a closed state, even given an open one', () => {
  const open: HighlightState = { open: 'js-template' };
  for (const lang of ['json', 'sh', 'toml', 'diff', null]) {
    assert.deepEqual(highlightLine('anything', lang, open).state, { open: null });
  }
});
