import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDuration } from '../src/duration.js';

test('single units', () => {
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('10s'), 10_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
});

test('fractional values', () => {
  assert.equal(parseDuration('2.5s'), 2500);
  assert.equal(parseDuration('0.5h'), 1_800_000);
});

test('compound values sum left to right', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1m30s'), 90_000);
  assert.equal(parseDuration('1h1m1s1ms'), 3_661_001);
});

test('surrounding whitespace is ignored', () => {
  assert.equal(parseDuration('  10s  '), 10_000);
});

test('rejects malformed input with a TypeError', () => {
  for (const bad of ['', '   ', 'abc', '10', '10x', 's', '10s5', '-5s', '1h30', null, undefined, 42]) {
    assert.throws(
      () => parseDuration(bad),
      TypeError,
      `expected parseDuration(${JSON.stringify(bad)}) to throw a TypeError`,
    );
  }
});
