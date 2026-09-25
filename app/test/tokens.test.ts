import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readableReport, readTokens } from '../src/main/agents.ts';
import { addTokens, tokensSince } from '../src/shared/tokens.ts';
import type { SoldierEvent } from '../../src/contracts/harness.ts';

type Result = SoldierEvent & { type: 'result' };
const result = (usage: Result['usage'], raw: unknown = {}): Result => ({ type: 'result', status: 'ok', usage, raw }) as Result;

describe('reading a turn\'s tokens', () => {
  test('claude: cache reads and writes sit outside input_tokens, and the last request is the context', () => {
    // A real Haiku turn, resumed: 10 new, 23,528 read from the cache, 2,807 written to it, 41 out.
    const raw = { usage: { iterations: [{ input_tokens: 10, cache_read_input_tokens: 23528, cache_creation_input_tokens: 2807, output_tokens: 41 }] } };
    const t = readTokens('claude', result({ inputTokens: 10, cacheReadInputTokens: 23528, cacheCreationInputTokens: 2807, outputTokens: 41 }, raw));
    assert.deepEqual(t, { input: 26345, cached: 23528, output: 41, context: 26386 });
  });

  test('codex: cached tokens are inside input_tokens', () => {
    assert.deepEqual(readTokens('codex', result({ inputTokens: 19783, cacheReadInputTokens: 9984, outputTokens: 5 })), { input: 19783, cached: 9984, output: 5 });
  });

  test('no usage gives nothing rather than zeros', () => {
    assert.equal(readTokens('claude', result(undefined)), undefined);
  });
});

describe('a JSON verdict, as a person reads it', () => {
  test('a reviewer verdict becomes a line with its findings; other text is left alone', () => {
    const v = JSON.stringify({ verdict: 'fail', summary: 'multiply is wrong for negatives.', findings: [{ severity: 'blocker', message: 'returns a + b', file: 'calc.js', line: 2 }], testsRun: true, testCommand: 'npm test' });
    assert.equal(readableReport(v), '**Review: failed.** multiply is wrong for negatives.\n\nFindings:\n- blocker: returns a + b (calc.js:2)\n\nTests: ran `npm test`.');
    assert.equal(readableReport('{"a": 1}'), '{"a": 1}');
    assert.equal(readableReport('APPROVED'), 'APPROVED');
  });
});

describe("codex's running total", () => {
  // Measured on gpt-5.6-luna: turn one reported these, the resumed turn two the second.
  const one = { input: 19783, cached: 9984, output: 5 };
  const two = { input: 41282, cached: 29184, output: 10 };

  test('a resumed turn counts only itself', () => {
    assert.deepEqual(tokensSince(two, one), { input: 21499, cached: 19200, output: 5 });
  });

  test('a first turn, or a total that went down, stands alone', () => {
    assert.deepEqual(tokensSince(one, undefined), one);
    assert.deepEqual(tokensSince(one, two), one);
  });

  test('adding keeps the later context', () => {
    assert.deepEqual(addTokens({ ...one, context: 100 }, { ...one, context: 200 }), { input: 39566, cached: 19968, output: 10, context: 200 });
    assert.equal(addTokens(undefined, undefined), undefined);
  });
});
