import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { FileLog, redact } from '../src/main/log.ts';

describe('redact', () => {
  test('takes out keys by their shape', () => {
    const cases: [string, string][] = [
      ['claude said: invalid x-api-key sk-ant-api03-abcdefghijklmnop', 'claude said: invalid x-api-key [redacted]'],
      ['OPENAI key sk-proj-AbCdEf123456789 refused', 'OPENAI key [redacted] refused'],
      ['Authorization: Bearer abc.def-123456', 'Authorization: Bearer [redacted]'],
      ['token ghp_abcdefghijklmnopqrstuvwxyz0123', 'token [redacted]'],
      ['aws AKIAABCDEFGHIJKLMNOP done', 'aws [redacted] done'],
      ['{"apiKey": "ts_9a8b7c6d5e"}', '{"apiKey": "[redacted]"}'],
      ['api_key=hunter2hunter2&x=1', 'api_key=[redacted]&x=1'],
      ['password: correct-horse', 'password: [redacted]'],
    ];
    for (const [input, want] of cases) assert.equal(redact(input), want, input);
  });

  test('takes out the configured keys wherever they appear, and leaves ordinary text alone', () => {
    assert.equal(redact('TypeSafe refused tsk_live_0042 (401)', ['tsk_live_0042']), 'TypeSafe refused [redacted] (401)');
    assert.equal(redact('brave key BSA-xyz-9876 twice BSA-xyz-9876', ['BSA-xyz-9876']), 'brave key [redacted] twice [redacted]');
    // A key too short to tell from a word is left to the patterns rather than blanking every "k".
    assert.equal(redact('the build passed in 3 s', ['k', '']), 'the build passed in 3 s');
    assert.equal(redact('Run run_abc ended succeeded after 12 s.'), 'Run run_abc ended succeeded after 12 s.');
    assert.equal(redact('the skill-based task'), 'the skill-based task');
  });
});

describe('the log file', () => {
  test('writes one redacted line per entry, rotates by size, and tails across the rotation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'army-log-'));
    const log = new FileLog(dir, { maxBytes: 400, keep: 2, secrets: () => ['my-typesafe-key'] });
    log.write('error', 'TypeSafe refused my-typesafe-key\nsecond line');
    const first = readFileSync(join(dir, 'main.log'), 'utf8');
    assert.match(first, /^\d{4}-\d\d-\d\dT.* ERROR TypeSafe refused \[redacted\] \| second line\n$/);
    for (let i = 0; i < 20; i += 1) log.write('info', `entry ${String(i)} ${'x'.repeat(40)}`);
    assert.ok(existsSync(join(dir, 'main.1.log')));
    assert.ok(existsSync(join(dir, 'main.2.log')));
    assert.equal(existsSync(join(dir, 'main.3.log')), false, 'only two rotated files are kept');
    assert.ok(readFileSync(join(dir, 'main.log'), 'utf8').length <= 400);
    const tail = log.tail(6);
    assert.equal(tail.length, 6);
    assert.match(tail.at(-1)!, /entry 19 /);
  });

  test('tail redacts a key saved after the line was written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'army-log-'));
    let keys: string[] = [];
    const log = new FileLog(dir, { secrets: () => keys });
    log.write('warn', 'Jev check failed for late-key-123');
    keys = ['late-key-123'];
    assert.match(log.tail(1)[0]!, /Jev check failed for \[redacted\]$/);
  });
});
