/**
 * Harness tests.
 *
 * Three layers, deliberately weighted towards the cheap end:
 *
 *  1. **The JSONL framer**, unit-tested against every hazard a real pipe produces. Pure, so it can
 *     be hammered.
 *  2. **The normalizers, against recorded fixtures.** This is the primary layer. `test/fixtures/*`
 *     is real wire data captured from claude 2.1.220 and codex-cli 0.142.5 on 2026-08-02, so these
 *     tests pin the wire format: an upstream change shows up as a failing test instead of as
 *     silently dropped events.
 *  3. **Adapter lifecycle against fake CLIs.** Fast and free, and the only way to assert the two
 *     silent-auth-breaking mistakes (`--bare`, `CODEX_HOME`) and the silent-hang one (codex stdin)
 *     without spending quota.
 *
 * A single live smoke test per harness sits at the bottom, skipped unless `ARMY_LIVE=1`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  createJsonlFramer,
  parseJsonl,
  framedLines,
  createAsyncQueue,
  buildClaudeArgs,
  buildClaudeEnv,
  claudeResultStatus,
  isClaudeAbortReason,
  createClaudeNormalizer,
  createClaudeAdapter,
  CLAUDE_TERMINAL_ABORT,
  CLAUDE_TERMINAL_CEILING,
  CLAUDE_TERMINAL_ERROR,
  CLAUDE_TERMINAL_OK,
  buildCodexArgs,
  buildCodexEnv,
  buildCodexEnvDetailed,
  isForwardableCodexEnvKey,
  codexConfinement,
  CODEX_ENV_FORBIDDEN,
  createCodexNormalizer,
  createCodexAdapter,
  codexThreadId,
  isCodexSoldier,
  getAdapter,
  spawnSoldier,
  ADAPTERS,
  claudeAdapter,
  codexAdapter,
} from '../src/harness/index.ts';
import type { JsonlLine } from '../src/harness/index.ts';
import type { HarnessAdapter, SoldierEvent, SoldierSpec } from '../src/contracts/index.ts';
import type { CodexConfinement } from '../src/harness/index.ts';
import { HARNESS_IDS, REASONING_EFFORTS, SOLDIER_EVENT_TYPES } from '../src/contracts/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const FAKE_CLAUDE = join(FIXTURES, 'fake-claude.mjs');
const FAKE_CODEX = join(FIXTURES, 'fake-codex.mjs');
const LIVE = process.env['ARMY_LIVE'] === '1';
const WINDOWS = process.platform === 'win32';

const FIXED_TS = '2026-08-02T00:00:00.000Z';

function spec(overrides: Partial<SoldierSpec> = {}): SoldierSpec {
  return {
    agentId: 'cpt-03',
    rank: 'CAPTAIN',
    role: 'ENGINEER',
    harness: 'claude',
    cwd: HERE,
    sessionId: '11111111-2222-3333-4444-555555555555',
    allow: [],
    deny: [],
    orders: 'take hill 4',
    ...overrides,
  };
}

function loadFixture(name: string): JsonlLine[] {
  return parseJsonl(readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8'));
}

function normalizeClaudeFixture(name: string): SoldierEvent[] {
  const n = createClaudeNormalizer();
  return loadFixture(name).flatMap((l) => n.next(l, FIXED_TS));
}

function normalizeCodexFixture(name: string): SoldierEvent[] {
  // Deterministic clock: codex reports no duration at all, so the normalizer times it — and a
  // wall-clock reading would make these assertions flap.
  let t = 0;
  const n = createCodexNormalizer({ now: () => (t += 1000) });
  return loadFixture(name).flatMap((l) => n.next(l, FIXED_TS));
}

function countTypes(events: SoldierEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

async function collect(stream: AsyncIterable<SoldierEvent>): Promise<SoldierEvent[]> {
  const out: SoldierEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** The value of a `-c key=value` override, or undefined. Robust to override ordering. */
function configOverride(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== '-c') continue;
    const kv = args[i + 1] ?? '';
    if (kv.startsWith(`${key}=`)) return kv.slice(key.length + 1);
  }
  return undefined;
}

interface Probe {
  argv: string[];
  env: Record<string, string | null>;
}

/**
 * Run a fake CLI and read back the argv and environment IT ACTUALLY RECEIVED.
 *
 * This is the difference between a guard and a decoration: asserting on `buildClaudeArgs()` only
 * proves the pure function is fine, and both of the original auth guards did exactly that (one of
 * them literally asserted `typeof stderr === 'string'`). These probes look at the child.
 */
async function spawnProbe(
  bin: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<Probe> {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'army-probe-'));
  const probeFile = join(dir, 'probe.json');
  try {
    execFileSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv, FAKE_PROBE_FILE: probeFile },
    });
    return JSON.parse(readFileSync(probeFile, 'utf8')) as Probe;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Probe through the REAL adapter, so the argv builder, the env builder and `spawn()` are all on
 * the path. `spawnProbe` above drives the fake directly and therefore cannot catch a leak the
 * adapter itself introduces — a distinction that mattered: an adapter-level `CODEX_HOME` leak
 * sailed past the direct probe.
 */
async function probeViaAdapter(adapter: HarnessAdapter, s: SoldierSpec): Promise<Probe> {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'army-probe-'));
  const probeFile = join(dir, 'probe.json');
  const saved = process.env['FAKE_PROBE_FILE'];
  process.env['FAKE_PROBE_FILE'] = probeFile;
  try {
    const soldier = await adapter.spawn(s);
    const events = collect(soldier.stream());
    await soldier.send('probe');
    await soldier.close();
    await events;
    return JSON.parse(readFileSync(probeFile, 'utf8')) as Probe;
  } finally {
    if (saved === undefined) delete process.env['FAKE_PROBE_FILE'];
    else process.env['FAKE_PROBE_FILE'] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================================
// 1. jsonl framer
// =============================================================================================

describe('jsonl framer', () => {
  test('frames whole lines', () => {
    const lines = parseJsonl('{"a":1}\n{"a":2}\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => (l.ok ? l.value : null)), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(lines.map((l) => l.index), [0, 1]);
  });

  test('survives a chunk boundary mid-line', () => {
    const f = createJsonlFramer();
    assert.deepEqual(f.push('{"type":"assis'), []);
    assert.equal(f.pending, 14);
    const out = f.push('tant","n":7}\n');
    assert.equal(out.length, 1);
    assert.ok(out[0]?.ok);
    assert.deepEqual(out[0].value, { type: 'assistant', n: 7 });
    assert.equal(f.pending, 0);
  });

  test('survives a chunk boundary that splits a multi-byte character', () => {
    // "☆ GEN" — the rank glyph is 3 UTF-8 bytes. Splitting it naively yields two replacement
    // characters and a line that no longer parses as JSON.
    const payload = Buffer.from('{"glyph":"☆"}\n', 'utf8');
    const f = createJsonlFramer();
    const first = f.push(payload.subarray(0, 12));
    const second = f.push(payload.subarray(12));
    const lines = [...first, ...second, ...f.flush()];
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.ok);
    assert.deepEqual(lines[0].value, { glyph: '☆' });
  });

  test('byte-at-a-time delivery reassembles exactly', () => {
    const source = '{"a":"héllo ☆"}\n{"b":[1,2,3]}\n';
    const bytes = Buffer.from(source, 'utf8');
    const f = createJsonlFramer();
    const lines: JsonlLine[] = [];
    for (const byte of bytes) lines.push(...f.push(Uint8Array.of(byte)));
    lines.push(...f.flush());
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => (l.ok ? l.value : null)), [{ a: 'héllo ☆' }, { b: [1, 2, 3] }]);
  });

  test('strips CRLF — Windows', () => {
    const lines = parseJsonl('{"a":1}\r\n{"a":2}\r\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0]?.ok);
    assert.ok(lines[1]?.ok);
    assert.deepEqual(lines[1].value, { a: 2 });
  });

  test('a lone CR inside a string is content, not a terminator', () => {
    const lines = parseJsonl('{"a":"x\\ry"}\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.ok);
    assert.deepEqual(lines[0].value, { a: 'x\ry' });
  });

  test('emits a trailing partial line at EOF', () => {
    const f = createJsonlFramer();
    assert.deepEqual(f.push('{"a":1}\n{"b":2}'), [
      { ok: true, index: 0, text: '{"a":1}', value: { a: 1 } },
    ]);
    const tail = f.flush();
    assert.equal(tail.length, 1);
    assert.ok(tail[0]?.ok);
    assert.deepEqual(tail[0].value, { b: 2 });
  });

  test('a TRUNCATED trailing line at EOF is reported as noise, never dropped', () => {
    // What a killed child leaves behind.
    const lines = parseJsonl('{"a":1}\n{"type":"assis');
    assert.equal(lines.length, 2);
    assert.equal(lines[1]?.ok, false);
    assert.equal(lines[1]?.text, '{"type":"assis');
  });

  test('skips blank lines and whitespace-only lines', () => {
    const lines = parseJsonl('\n{"a":1}\n\n   \n\r\n{"a":2}\n\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => l.index), [0, 1]);
  });

  test('non-JSON noise does not kill the stream', () => {
    const lines = parseJsonl('(node:1) Warning: something\n{"a":1}\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.ok, false);
    assert.equal(lines[0]?.text, '(node:1) Warning: something');
    assert.ok(lines[1]?.ok);
    assert.deepEqual(lines[1].value, { a: 1 });
  });

  test('handles a very long line', () => {
    const big = { text: 'x'.repeat(2_000_000) };
    const source = JSON.stringify(big) + '\n';
    const f = createJsonlFramer();
    const lines: JsonlLine[] = [];
    for (let i = 0; i < source.length; i += 16_384) {
      lines.push(...f.push(source.slice(i, i + 16_384)));
    }
    lines.push(...f.flush());
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.ok);
    assert.deepEqual(lines[0].value, big);
  });

  test('maxLineBytes truncates and then resynchronises at the next newline', () => {
    const f = createJsonlFramer({ maxLineBytes: 16 });
    const out = [...f.push('{"a":"' + 'x'.repeat(100) + '"}\n{"b":1}\n'), ...f.flush()];
    assert.equal(out.length, 2);
    assert.equal(out[0]?.ok, false);
    assert.match(out[0]?.error ?? '', /maxLineBytes/);
    assert.ok(out[1]?.ok);
    assert.deepEqual(out[1].value, { b: 1 });
  });

  test('strips a leading BOM', () => {
    const lines = parseJsonl('﻿{"a":1}\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.ok);
    assert.deepEqual(lines[0].value, { a: 1 });
  });

  test('accepts non-object JSON values without pretending they are records', () => {
    const lines = parseJsonl('123\n"hi"\nnull\n[1]\n');
    assert.equal(lines.length, 4);
    assert.deepEqual(lines.map((l) => (l.ok ? l.value : 'NOISE')), [123, 'hi', null, [1]]);
  });

  test('flush is idempotent and push after flush is inert', () => {
    const f = createJsonlFramer();
    f.push('{"a":1}');
    assert.equal(f.flush().length, 1);
    assert.deepEqual(f.flush(), []);
    assert.deepEqual(f.push('{"b":2}\n'), []);
  });

  test('framedLines drains an async source including its tail', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('{"a":1}\n{"b"');
      yield Buffer.from(':2}\n{"c":3}');
    }
    const seen: unknown[] = [];
    for await (const line of framedLines(source())) seen.push(line.ok ? line.value : 'NOISE');
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

describe('async queue', () => {
  test('buffers values pushed before iteration begins', async () => {
    const q = createAsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    const out: number[] = [];
    for await (const v of q.iterator()) out.push(v);
    assert.deepEqual(out, [1, 2]);
  });

  test('a parked consumer is released by end()', async () => {
    const q = createAsyncQueue<number>();
    const done = (async () => {
      const out: number[] = [];
      for await (const v of q.iterator()) out.push(v);
      return out;
    })();
    setTimeout(() => {
      q.push(7);
      q.end();
    }, 5);
    assert.deepEqual(await done, [7]);
  });

  test('end is idempotent and later pushes are dropped', async () => {
    const q = createAsyncQueue<number>();
    q.push(1);
    q.end();
    q.end();
    q.push(2);
    assert.equal(q.ended, true);
    assert.deepEqual(await collectNumbers(q.iterator()), [1]);
  });
});

async function collectNumbers(it: AsyncGenerator<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const v of it) out.push(v);
  return out;
}

// =============================================================================================
// 2. argv — the auth regression guards
// =============================================================================================

describe('claude argv', () => {
  const args = buildClaudeArgs(spec());

  test('NEVER passes --bare (it skips the keychain and demands ANTHROPIC_API_KEY)', () => {
    assert.equal(args.includes('--bare'), false);
    // and not under any spec we can construct
    for (const s of [
      spec(),
      spec({ model: 'claude-sonnet-5', effort: 'xhigh' }),
      spec({ allow: ['Read'], deny: ['Bash(git push*)'] }),
    ]) {
      assert.equal(buildClaudeArgs(s).includes('--bare'), false);
    }
  });

  test('never injects a credential flag', () => {
    const joined = args.join(' ');
    assert.equal(/ANTHROPIC_API_KEY/.test(joined), false);
    assert.equal(args.includes('--settings'), false);
  });

  test('is the duplex, pipes-only invocation, with subagents visible on the stream', () => {
    assert.ok(args.includes('-p'));
    assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(args.includes('--forward-subagent-text'));
    assert.equal(args[args.indexOf('--session-id') + 1], '11111111-2222-3333-4444-555555555555');
  });

  test('nothing prompts', () => {
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  });

  test('never introduces a PTY or tmux dependency — the Windows story', () => {
    assert.equal(args.includes('--tmux'), false);
    assert.equal(args.includes('--worktree'), false);
    assert.equal(args.includes('-w'), false);
  });

  test('maps effort onto the levels claude accepts', () => {
    assert.equal(buildClaudeArgs(spec({ effort: 'xhigh' }))[
      buildClaudeArgs(spec({ effort: 'xhigh' })).indexOf('--effort') + 1
    ], 'xhigh');
    // `minimal` is not a claude level; map UP rather than dropping the flag.
    const a = buildClaudeArgs(spec({ effort: 'minimal' }));
    assert.equal(a[a.indexOf('--effort') + 1], 'low');
  });

  test('allow/deny become --allowedTools / --disallowedTools, and are omitted when empty', () => {
    const a = buildClaudeArgs(spec({ allow: ['Read', 'Grep'], deny: ['Bash(git push*)'] }));
    assert.deepEqual(a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--allowedTools') + 3), ['Read', 'Grep']);
    assert.equal(a[a.indexOf('--disallowedTools') + 1], 'Bash(git push*)');
    assert.equal(buildClaudeArgs(spec()).includes('--allowedTools'), false);
  });

  test('--json-schema is INLINE JSON, not a path (verified asymmetry with codex)', () => {
    const schema = '{"type":"object","additionalProperties":false,"required":[],"properties":{}}';
    const a = buildClaudeArgs(spec({ outputSchemaPath: '/schemas/verdict.v1.json' }), {
      readFile: (p) => {
        assert.equal(p, '/schemas/verdict.v1.json');
        return schema;
      },
    });
    const value = a[a.indexOf('--json-schema') + 1];
    assert.equal(value, schema);
    assert.notEqual(value, '/schemas/verdict.v1.json');
    assert.doesNotThrow(() => JSON.parse(value ?? ''));
  });

  test('the real schema files inline cleanly', () => {
    for (const path of ['schemas/report.v1.json', 'schemas/verdict.v1.json']) {
      const a = buildClaudeArgs(spec({ outputSchemaPath: join(HERE, '..', path) }));
      const value = a[a.indexOf('--json-schema') + 1] ?? '';
      const parsed: unknown = JSON.parse(value);
      assert.equal(typeof parsed, 'object');
      // claude's validator cannot resolve the draft-2020-12 meta-schema URI.
      assert.equal(Object.hasOwn(parsed as object, '$schema'), false, `${path} must not carry $schema`);
    }
  });
});

describe('codex argv + env', () => {
  const args = buildCodexArgs(spec({ harness: 'codex' }), 'review the branch');

  test('NEVER sets CODEX_HOME (it silently drops the ChatGPT login)', () => {
    assert.equal(args.some((a) => a.includes('CODEX_HOME')), false);
    const base = { HOME: '/Users/x', PATH: '/usr/bin' };
    const env = buildCodexEnv(spec({ harness: 'codex' }), base);
    assert.equal(Object.hasOwn(env, 'CODEX_HOME'), false);
    // ...and it is not smuggled in via a -c override either.
    assert.equal(args.some((a) => a.startsWith('CODEX_HOME')), false);
  });

  test('inherits the environment rather than injecting credentials', () => {
    const base = { HOME: '/Users/x', PATH: '/usr/bin' };
    assert.deepEqual(buildCodexEnv(spec({ harness: 'codex' }), base), base);
    const withExtra = buildCodexEnv(spec({ harness: 'codex', env: { ARMY_TASK: 'hill-4' } }), base);
    assert.equal(withExtra['ARMY_TASK'], 'hill-4');
    assert.equal(withExtra['HOME'], '/Users/x');
  });

  test('never calls codex login (it would rewrite auth.json and flip auth_mode)', () => {
    assert.equal(args.includes('login'), false);
    assert.equal(args.includes('--with-api-key'), false);
  });

  test('is the verified working invocation', () => {
    assert.equal(args[0], 'exec');
    assert.ok(args.includes('--json'));
    assert.equal(args[args.indexOf('-C') + 1], HERE);
    // read-only breaks test runners; an Inspector must run the suite.
    assert.equal(args[args.indexOf('-s') + 1], 'workspace-write');
    assert.equal(args.at(-1), 'review the branch', 'the prompt is the trailing positional');
    assert.equal(args.at(-2), '--', 'and it is always guarded by a -- separator');
  });

  test('--output-schema takes a PATH (asymmetric with claude)', () => {
    const a = buildCodexArgs(spec({ harness: 'codex', outputSchemaPath: '/s/verdict.v1.json' }), 'go');
    assert.equal(a[a.indexOf('--output-schema') + 1], '/s/verdict.v1.json');
  });

  test('reasoning effort has no flag — it is -c model_reasoning_effort=<v>', () => {
    const a = buildCodexArgs(spec({ harness: 'codex', effort: 'high' }), 'go');
    assert.equal(a.includes('--reasoning-effort'), false);
    assert.equal(configOverride(a, 'model_reasoning_effort'), 'high');
  });

  test('`minimal` is mapped up to `low` — it 400s against codex\'s default toolset', () => {
    // MEASURED 2026-08-02: `-c model_reasoning_effort=minimal` returns
    //   "The following tools cannot be used with reasoning.effort 'minimal': web_search."
    // The value is in the server's accepted enum but is unusable, so every Inspector dispatched
    // at `minimal` would 400. Mapping UP is safe; mapping down would breach the dispatch rule.
    const a = buildCodexArgs(spec({ harness: 'codex', effort: 'minimal' }), 'go');
    assert.equal(configOverride(a, 'model_reasoning_effort'), 'low');
    assert.equal(a.some((x) => x.includes('minimal')), false);
  });

  test('every ReasoningEffort produces a value codex actually accepts', () => {
    const usable = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const effort of REASONING_EFFORTS) {
      const a = buildCodexArgs(spec({ harness: 'codex', effort }), 'go');
      const value = configOverride(a, 'model_reasoning_effort') ?? '';
      assert.ok(usable.has(value), `${effort} -> ${value}`);
      assert.notEqual(value, 'minimal', 'minimal is enum-valid but tool-incompatible');
    }
  });

  test('never passes the sandbox escape hatch', () => {
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    assert.equal(args.includes('--ephemeral'), false, 'ephemeral would break `codex exec resume`');
  });

  test('a prompt that begins with a dash is a value, not a flag', () => {
    // Orders are free text. Verified against the real CLI:
    //   error: unexpected argument '--bare-looking-prompt' found
    //   tip: to pass '--bare-looking-prompt' as a value, use '-- --bare-looking-prompt'
    const a = buildCodexArgs(spec({ harness: 'codex' }), '--dangerously-bypass-approvals-and-sandbox');
    assert.equal(a.at(-2), '--');
    assert.equal(a.at(-1), '--dangerously-bypass-approvals-and-sandbox');
    assert.equal(a.indexOf('--dangerously-bypass-approvals-and-sandbox'), a.length - 1,
      'it appears only after the separator, never as a parsed flag');
  });

  test('flag-like spec values are rejected before they reach argv', () => {
    assert.throws(() => buildCodexArgs(spec({ harness: 'codex', model: '--dangerously-bypass-approvals-and-sandbox' }), 'go'), /may not begin with/);
    assert.throws(() => buildCodexArgs(spec({ harness: 'codex', outputSchemaPath: '-s' }), 'go'), /may not begin with/);
  });
});

describe('argv injection guards (a spec field must never become a flag)', () => {
  test('--bare cannot be injected through any spec field', () => {
    // `--allowedTools <tools...>` is VARIADIC, so a `--bare` inside spec.allow lands on the command
    // line as a real flag and silently takes the worker off subscription auth.
    assert.throws(() => buildClaudeArgs(spec({ allow: ['Read', '--bare'] })), /allow\[1\].*may not begin with/s);
    assert.throws(() => buildClaudeArgs(spec({ deny: ['--bare'] })), /deny\[0\].*may not begin with/s);
    assert.throws(() => buildClaudeArgs(spec({ model: '--bare' })), /model.*may not begin with/s);
  });

  test('sessionId must be a UUID — it is an argv slot too', () => {
    assert.throws(() => buildClaudeArgs(spec({ sessionId: '--bare' })), /must be a UUID/);
    assert.throws(() => buildClaudeArgs(spec({ sessionId: 'not-a-uuid' })), /must be a UUID/);
    assert.doesNotThrow(() => buildClaudeArgs(spec({ sessionId: randomUUID() })));
  });

  test('PROCESS-LEVEL: an injected --bare in spec.allow never reaches the child', async () => {
    if (WINDOWS) return;
    // Belt and braces: prove the throw happens rather than the flag arriving.
    assert.throws(() => buildClaudeArgs(spec({ allow: ['--bare'] })));
    const clean = await spawnProbe(FAKE_CLAUDE, buildClaudeArgs(spec({ allow: ['Read', 'Grep'] })));
    assert.equal(clean.argv.includes('--bare'), false);
    assert.deepEqual(
      clean.argv.slice(clean.argv.indexOf('--allowedTools') + 1, clean.argv.indexOf('--allowedTools') + 3),
      ['Read', 'Grep'],
    );
  });
});

// =============================================================================================
// 3. normalizers against recorded fixtures  (the primary layer)
// =============================================================================================

describe('claude normalizer / fixture claude-duplex.jsonl', () => {
  const events = normalizeClaudeFixture('claude-duplex');

  test('maps the whole recorded stream', () => {
    assert.deepEqual(countTypes(events), {
      ready: 3,
      unknown: 25,
      assistant_text: 8,
      result: 3,
      tool_use: 4,
      tool_result: 4,
    });
  });

  test('system/init becomes ready and carries the interrupt capability', () => {
    const ready = events.filter((e) => e.type === 'ready');
    assert.equal(ready.length, 3, 'claude re-emits system/init at the start of every turn');
    assert.equal(ready[0]?.sessionId, 'b3391cca-1561-4dd3-b57f-5f84d001eaba');
    assert.ok(ready[0]?.capabilities.includes('interrupt_receipt_v1'));
  });

  test('an interrupted turn is `interrupted`, not `error`', () => {
    // The aborted turn reports subtype error_during_execution + is_error:true; only
    // terminal_reason distinguishes a deliberate barge-in from a failure worth retrying.
    assert.deepEqual(
      events.filter((e) => e.type === 'result').map((e) => e.status),
      ['ok', 'interrupted', 'ok'],
    );
  });

  test('cost is CUMULATIVE across turns, so a ledger must take the last value', () => {
    const costs = events.filter((e) => e.type === 'result').map((e) => e.costUsd);
    assert.deepEqual(costs, [0.0175056, 0.0352224, 0.0385563]);
    for (let i = 1; i < costs.length; i += 1) {
      assert.ok((costs[i] ?? 0) > (costs[i - 1] ?? 0), 'monotonic => cumulative, never summed');
    }
  });

  test('claude cache tokens are DISJOINT from input tokens, so the total is a plain sum', () => {
    const first = events.find((e) => e.type === 'result');
    assert.deepEqual(first?.usage, {
      inputTokens: 10,
      outputTokens: 39,
      cacheReadInputTokens: 17476,
      cacheCreationInputTokens: 7486,
      totalTokens: 25011,
    });
  });

  test('tool_use and tool_result correlate on the same id, and an aborted tool is an error', () => {
    const uses = events.filter((e) => e.type === 'tool_use');
    const results = events.filter((e) => e.type === 'tool_result');
    assert.deepEqual(uses.map((u) => u.toolUseId), results.map((r) => r.toolUseId));
    assert.deepEqual(uses.map((u) => u.name), ['Bash', 'Bash', 'Bash', 'Bash']);
    assert.deepEqual(results.map((r) => r.isError), [false, false, false, true]);
  });

  test('every event carries a lossless `raw` and an ISO timestamp', () => {
    for (const e of events) {
      assert.notEqual(e.raw, undefined);
      assert.ok(SOLDIER_EVENT_TYPES.includes(e.type));
      assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test('the control_response for our interrupt is kept, not dropped', () => {
    const kept = events.filter((e) => e.type === 'unknown' && e.harnessType === 'control_response');
    assert.equal(kept.length, 1);
  });

  test('unmodelled system events survive as `unknown` with their harness type', () => {
    const kinds = new Set(
      events.filter((e) => e.type === 'unknown').map((e) => e.harnessType),
    );
    assert.ok(kinds.has('system/thinking_tokens'));
    assert.ok(kinds.has('rate_limit_event'));
    assert.ok(kinds.has('user/text'), 'the [Request interrupted] marker is not the soldier speaking');
  });
});

describe('claude normalizer / fixture claude-subagent.jsonl (subagents on the org chart)', () => {
  const events = normalizeClaudeFixture('claude-subagent');

  test('maps the whole recorded stream', () => {
    assert.deepEqual(countTypes(events), {
      ready: 2,
      unknown: 53,
      assistant_text: 5,
      tool_use: 2,
      tool_result: 2,
      subagent_text: 2,
      result: 2,
    });
  });

  test('forwarded subagent text becomes subagent_text at depth 1 with its edge intact', () => {
    const subs = events.filter((e) => e.type === 'subagent_text');
    assert.equal(subs.length, 2);
    for (const s of subs) {
      assert.equal(s.depth, 1);
      assert.equal(s.parentToolUseId, 'toolu_01BuwaiPeJPME9TtgNHqD34Q');
      assert.equal(s.subagentType, 'general-purpose');
    }
    assert.equal(subs[1]?.text, 'hello from the subagent');
  });

  test('depth is DERIVED from the tool_use that issued the child, not hardcoded', () => {
    // The Agent tool_use is the edge; the subagent's own text sits one level below it.
    const agent = events.filter((e) => e.type === 'tool_use').find((e) => e.name === 'Agent');
    assert.equal(agent?.depth, 0);
    assert.equal(agent?.toolUseId, 'toolu_01BuwaiPeJPME9TtgNHqD34Q');
    const sub = events.find((e) => e.type === 'subagent_text');
    assert.equal(sub?.depth, (agent?.depth ?? 0) + 1);
  });

  test('a synthetic nested-nested forward lands at depth 2', () => {
    // >=2.1.219 forwards at every nesting level; prove the derivation generalises rather than
    // waiting for a three-deep live capture.
    const n = createClaudeNormalizer();
    const feed = (o: unknown): SoldierEvent[] =>
      n.next({ ok: true, index: 0, text: '', value: o }, FIXED_TS);
    feed({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: {} }] },
    });
    feed({
      type: 'assistant',
      parent_tool_use_id: 'toolu_A',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_B', name: 'Agent', input: {} }] },
    });
    const deep = feed({
      type: 'assistant',
      parent_tool_use_id: 'toolu_B',
      subagent_type: 'Explore',
      message: { role: 'assistant', content: [{ type: 'text', text: 'three deep' }] },
    });
    assert.equal(deep[0]?.type, 'subagent_text');
    assert.equal(deep[0]?.depth, 2);
  });

  test('top-level events are depth 0 with a null parent', () => {
    for (const e of events.filter((x) => x.type === 'assistant_text')) {
      assert.equal(e.depth, 0);
      assert.equal(e.parentToolUseId, null);
    }
  });
});

describe('claude normalizer / edge cases', () => {
  const n = createClaudeNormalizer();
  const feed = (line: JsonlLine): SoldierEvent[] => n.next(line, FIXED_TS);

  test('a noise line becomes `unknown`, never a dropped line', () => {
    const out = feed({ ok: false, index: 0, text: 'Warning: bad', error: 'x' });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.type, 'unknown');
    assert.equal(out[0]?.raw, 'Warning: bad');
    assert.equal(out[0]?.type === 'unknown' ? out[0].harnessType : null, 'noise');
  });

  test('a JSON scalar becomes `unknown` rather than being treated as a record', () => {
    const out = feed({ ok: true, index: 0, text: '42', value: 42 });
    assert.equal(out[0]?.type, 'unknown');
    assert.equal(out[0]?.raw, 42);
  });

  test('a future event type survives instead of breaking us', () => {
    const out = feed({
      ok: true,
      index: 0,
      text: '',
      value: { type: 'quantum_entanglement_v9', payload: { a: 1 } },
    });
    assert.equal(out[0]?.type, 'unknown');
    assert.equal(out[0]?.type === 'unknown' ? out[0].harnessType : null, 'quantum_entanglement_v9');
    assert.deepEqual(out[0]?.raw, { type: 'quantum_entanglement_v9', payload: { a: 1 } });
  });

  test('an unknown CONTENT block inside a known message survives too', () => {
    const out = feed({
      ok: true,
      index: 0,
      text: '',
      value: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'hologram', data: 1 }] },
      },
    });
    assert.equal(out[0]?.type, 'unknown');
    assert.equal(out[0]?.type === 'unknown' ? out[0].harnessType : null, 'assistant/hologram');
  });

  test('claudeResultStatus prefers terminal_reason over is_error', () => {
    assert.equal(
      claudeResultStatus({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' }),
      'interrupted',
    );
    assert.equal(claudeResultStatus({ subtype: 'success', is_error: false }), 'ok');
    assert.equal(claudeResultStatus({ subtype: 'error_during_execution', is_error: true }), 'error');
    assert.equal(claudeResultStatus({ subtype: 'error_max_turns' }), 'timeout');
    assert.equal(claudeResultStatus({ is_error: true }), 'error');
  });
});

// ---------------------------------------------------------------------------------------------
// The blocker, in detail.
//
// An earlier version handled `aborted_tools` (the one observed live) plus `interrupted` and
// `cancelled` — neither of which exists in the CLI at all — while missing `aborted_streaming`,
// which is real and arrives on a timing-dependent basis. Roughly half of all barge-ins were
// therefore classified as failures — and a failure is retried, so the army would re-run work a
// human deliberately stopped.
//
// The enum below was read out of claude 2.1.220's own bundle rather than guessed:
//   function Wpt(e){ return e==="aborted_streaming" || e==="aborted_tools" }
// ---------------------------------------------------------------------------------------------
describe('terminal_reason classification (the interrupt blocker)', () => {
  test('EVERY real abort literal maps to interrupted', () => {
    // Both members of claude's own abort predicate, each with the error flags that accompany a
    // real interrupt — the exact payload shape measured live.
    for (const reason of CLAUDE_TERMINAL_ABORT) {
      assert.equal(
        claudeResultStatus({
          subtype: 'error_during_execution',
          is_error: true,
          stop_reason: 'tool_use',
          terminal_reason: reason,
        }),
        'interrupted',
        `${reason} must be interrupted, not error`,
      );
    }
    assert.deepEqual([...CLAUDE_TERMINAL_ABORT], ['aborted_streaming', 'aborted_tools']);
  });

  test('aborted_streaming specifically — the half that used to be misfiled', () => {
    assert.equal(
      claudeResultStatus({
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
      }),
      'interrupted',
    );
  });

  test('the bare `aborted` variant is covered by the family rule', () => {
    assert.equal(claudeResultStatus({ is_error: true, terminal_reason: 'aborted' }), 'interrupted');
    assert.equal(isClaudeAbortReason('aborted'), true);
    // ...and so is any future member of the family.
    assert.equal(isClaudeAbortReason('aborted_by_some_future_mechanism'), true);
    assert.equal(isClaudeAbortReason('completed'), false);
    assert.equal(isClaudeAbortReason(undefined), false);
  });

  test('an UNRECOGNISED terminal_reason is not assumed to be a failure', () => {
    // Drift: the enumeration came from `strings` on one version and will rot. An unknown reason
    // with no error flags must not be invented into an error.
    assert.equal(claudeResultStatus({ terminal_reason: 'invented_in_2027' }), 'ok');
  });

  test('an unrecognised reason resolves to interrupted when WE issued the interrupt', () => {
    // The authoritative rule: our own knowledge outranks any string on the wire.
    assert.equal(
      claudeResultStatus(
        { subtype: 'error_during_execution', is_error: true, terminal_reason: 'invented_in_2027' },
        { interruptRequested: true },
      ),
      'interrupted',
    );
    // ...and it outranks even a reason claude classifies as a hard error.
    assert.equal(
      claudeResultStatus(
        { subtype: 'error_during_execution', is_error: true, terminal_reason: 'api_error' },
        { interruptRequested: true },
      ),
      'interrupted',
    );
    // Without the interrupt, that same payload is correctly an error.
    assert.equal(
      claudeResultStatus({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'api_error' }),
      'error',
    );
  });

  test('claude\'s own error reasons map to error', () => {
    for (const reason of CLAUDE_TERMINAL_ERROR) {
      assert.equal(claudeResultStatus({ terminal_reason: reason }), 'error', reason);
    }
  });

  test('ceiling breaches map to timeout, not error', () => {
    for (const reason of CLAUDE_TERMINAL_CEILING) {
      assert.equal(claudeResultStatus({ terminal_reason: reason }), 'timeout', reason);
    }
  });

  test('ordinary endings map to ok even when a stale is_error is set', () => {
    for (const reason of CLAUDE_TERMINAL_OK) {
      assert.equal(claudeResultStatus({ terminal_reason: reason }), 'ok', reason);
    }
  });

  test('the four buckets are disjoint and none of them invents a value', () => {
    const all = [
      ...CLAUDE_TERMINAL_ABORT,
      ...CLAUDE_TERMINAL_ERROR,
      ...CLAUDE_TERMINAL_CEILING,
      ...CLAUDE_TERMINAL_OK,
    ];
    assert.equal(new Set(all).size, all.length, 'no reason appears in two buckets');
    // The union of the real enum (j1_ + W1_) read from the binary. If a future version adds one,
    // this list is where the drift becomes visible.
    const REAL_ENUM = [
      'blocking_limit', 'rapid_refill_breaker', 'prompt_too_long', 'image_error', 'model_error',
      'api_error', 'malformed_tool_use_exhausted', 'aborted_streaming', 'aborted_tools',
      'stop_hook_prevented', 'hook_stopped', 'tool_deferred', 'max_turns', 'background_requested',
      'completed', 'budget_exhausted', 'structured_output_retry_exhausted',
      'tool_deferred_unavailable', 'turn_setup_failed',
    ];
    assert.deepEqual([...all].sort(), [...REAL_ENUM].sort(), 'every real reason is classified, and no invented one is');
  });

  test('FIXTURE: a real aborted_streaming interrupt, captured live', () => {
    // test/fixtures/claude-abort-streaming.jsonl was recorded by interrupting a pure text
    // generation (no tool call in flight) against claude 2.1.220. That is the code path the
    // original adapter misfiled: same barge-in, different reason string, opposite verdict.
    const events = normalizeClaudeFixture('claude-abort-streaming');
    const result = events.find((e) => e.type === 'result');
    assert.equal(
      (result?.raw as Record<string, unknown>)['terminal_reason'],
      'aborted_streaming',
      'fixture must actually contain the streaming variant',
    );
    assert.equal((result?.raw as Record<string, unknown>)['is_error'], true, 'and claude flags it as an error');
    assert.equal(result?.status, 'interrupted', 'but WE must classify it as interrupted');
  });

  test('the normalizer consults the interrupt flag, not just the string', () => {
    let pending = false;
    const n = createClaudeNormalizer({ interruptRequested: () => pending });
    const feed = (o: unknown): SoldierEvent[] =>
      n.next({ ok: true, index: 0, text: '', value: o }, FIXED_TS);
    const payload = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'some_future_word',
    };
    assert.equal(feed(payload).find((e) => e.type === 'result')?.status, 'error');
    pending = true;
    assert.equal(feed(payload).find((e) => e.type === 'result')?.status, 'interrupted');
  });
});

describe('codex normalizer / fixture codex-run.jsonl', () => {
  const events = normalizeCodexFixture('codex-run');

  test('maps the whole recorded stream', () => {
    assert.deepEqual(countTypes(events), {
      ready: 1,
      unknown: 1,
      tool_use: 1,
      tool_result: 1,
      assistant_text: 1,
      result: 1,
    });
  });

  test('thread.started becomes ready and is the ONLY place the thread id appears', () => {
    const ready = events.find((e) => e.type === 'ready');
    assert.equal(ready?.sessionId, '019fc3d9-0b7b-7543-a30a-ee44ff5860dd');
    assert.deepEqual(ready?.capabilities, [], 'codex exec advertises nothing; interrupt must reject');
  });

  test('the schema-constrained verdict arrives as assistant_text', () => {
    const text = events.find((e) => e.type === 'assistant_text')?.text ?? '';
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(parsed['verdict'], 'pass');
    assert.deepEqual(Object.keys(parsed).sort(), ['findings', 'summary', 'testsRun', 'verdict']);
  });

  test('codex cached tokens are a SUBSET of input tokens, so the total is input + output', () => {
    const result = events.find((e) => e.type === 'result');
    assert.deepEqual(result?.usage, {
      inputTokens: 23935,
      outputTokens: 135,
      cacheReadInputTokens: 21248,
      totalTokens: 24070,
    });
  });

  test('no cost is invented — codex reports none anywhere', () => {
    assert.equal(events.find((e) => e.type === 'result')?.costUsd, undefined);
  });

  test('duration comes from our own clock because codex emits none', () => {
    assert.equal(typeof events.find((e) => e.type === 'result')?.durationMs, 'number');
  });

  test('turn.started is kept as `unknown` rather than dropped', () => {
    assert.equal(events.filter((e) => e.type === 'unknown' && e.harnessType === 'turn.started').length, 1);
  });
});

describe('codex normalizer / fixture codex-tools.jsonl', () => {
  const events = normalizeCodexFixture('codex-tools');

  test('tool ids are namespaced by (thread, turn, item) — item ids restart every turn', () => {
    const ids = events.filter((e) => e.type === 'tool_use').map((e) => e.toolUseId);
    assert.deepEqual(ids, [
      '019fc3c0-e049-7600-a36a-e279a6966e60#1#item_0',
      '019fc3c0-e049-7600-a36a-e279a6966e60#1#item_1',
    ]);
    assert.deepEqual(
      events.filter((e) => e.type === 'tool_result').map((e) => e.toolUseId),
      ids,
      'item.completed re-sends the whole item under the same id',
    );
  });

  test('a second turn does NOT collide with the first', () => {
    let t = 0;
    const n = createCodexNormalizer({ now: () => (t += 1) });
    const feed = (o: unknown): SoldierEvent[] => n.next({ ok: true, index: 0, text: '', value: o }, FIXED_TS);
    feed({ type: 'thread.started', thread_id: 'th-1' });
    feed({ type: 'turn.started' });
    const a = feed({ type: 'item.started', item: { id: 'item_0', type: 'command_execution' } });
    feed({ type: 'turn.completed', usage: {} });
    feed({ type: 'turn.started' });
    const b = feed({ type: 'item.started', item: { id: 'item_0', type: 'command_execution' } });
    assert.equal(a[0]?.type === 'tool_use' ? a[0].toolUseId : '', 'th-1#1#item_0');
    assert.equal(b[0]?.type === 'tool_use' ? b[0].toolUseId : '', 'th-1#2#item_0');
    assert.notEqual(
      a[0]?.type === 'tool_use' ? a[0].toolUseId : 'x',
      b[0]?.type === 'tool_use' ? b[0].toolUseId : 'y',
    );
  });

  test('a non-zero exit_code makes the tool_result an error', () => {
    let t = 0;
    const n = createCodexNormalizer({ now: () => (t += 1) });
    const out = n.next(
      {
        ok: true,
        index: 0,
        text: '',
        value: { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', exit_code: 2 } },
      },
      FIXED_TS,
    );
    assert.equal(out[0]?.type === 'tool_result' ? out[0].isError : null, true);
  });
});

describe('codex normalizer / fixture codex-turn-failed.jsonl', () => {
  const events = normalizeCodexFixture('codex-turn-failed');

  test('maps the whole recorded failure stream', () => {
    assert.deepEqual(countTypes(events), { ready: 1, error: 3, unknown: 1, result: 1 });
  });

  test('turn.failed yields a terminal result too, so a consumer never waits forever', () => {
    const result = events.find((e) => e.type === 'result');
    assert.equal(result?.status, 'error');
    assert.equal(events.at(-1)?.type, 'result');
  });

  test('the advisory item error and the fatal error are both surfaced', () => {
    const messages = events.filter((e) => e.type === 'error').map((e) => e.message);
    assert.match(messages[0] ?? '', /Model metadata/);
    assert.match(messages[1] ?? '', /invalid_request_error/);
  });
});

// =============================================================================================
// 4. adapter lifecycle, against the fake CLIs
// =============================================================================================

describe('claude adapter lifecycle', { skip: WINDOWS ? 'POSIX shebang fakes' : false }, () => {
  const adapter = createClaudeAdapter({ bin: FAKE_CLAUDE, closeGraceMs: 1500, killGraceMs: 500 });

  test('a duplex round trip: ready, two turns, clean close', async () => {
    const soldier = await adapter.spawn(spec());
    const events = collect(soldier.stream());
    await soldier.send('first');
    await soldier.send('second');
    await new Promise((r) => setTimeout(r, 250));
    const close = await soldier.close();
    const all = await events;

    assert.equal(close.exitCode, 0);
    assert.equal(close.status, 'ok');
    assert.ok((close.durationMs ?? 0) >= 0);
    // Cumulative, so the ledger takes the LAST value, not the sum of 0.25 + 0.50.
    assert.equal(close.costUsd, 0.5);

    const texts = all.filter((e) => e.type === 'assistant_text').map((e) => e.text);
    assert.deepEqual(texts, ['echo:first', 'echo:second']);
    assert.equal(all.filter((e) => e.type === 'ready').length, 1);
    assert.equal(all.at(-1)?.type, 'result');
  });

  test('close() is idempotent', async () => {
    const soldier = await adapter.spawn(spec());
    void collect(soldier.stream());
    await soldier.send('hi');
    const a = await soldier.close();
    const b = await soldier.close();
    assert.equal(a, b);
  });

  test('send() after close rejects instead of hanging', async () => {
    const soldier = await adapter.spawn(spec());
    void collect(soldier.stream());
    await soldier.close();
    await assert.rejects(() => soldier.send('too late'), /closed/);
  });

  test('interrupt() writes a control_request and resolves on the receipt', async () => {
    // `slow` keeps the turn in flight, which is the only state in which an interrupt does
    // anything. The fake used to answer a control_request with a result unconditionally, so this
    // test passed without ever exercising a real mid-turn abort.
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'slow';
    try {
      const soldier = await adapter.spawn(spec());
      const events = collect(soldier.stream());
      await soldier.send('long task');
      await new Promise((r) => setTimeout(r, 150));
      await soldier.interrupt();
      await new Promise((r) => setTimeout(r, 150));
      await soldier.close();
      const all = await events;
      assert.ok(all.some((e) => e.type === 'result' && e.status === 'interrupted'));
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });

  test('BLOCKER: a no-op interrupt must not misfile the NEXT clean turn', async () => {
    // The inverse of the aborted_streaming bug, and it costs as much. The real CLI answers an
    // interrupt with no turn in flight using a bare `control_response` and NO `result`, so an
    // unconditionally-armed flag stays armed until the next turn's result — turning a perfectly
    // clean `terminal_reason: "completed"` into `interrupted`, and the retry logic then routes a
    // successful turn as one the Commander deliberately stopped.
    const soldier = await adapter.spawn(spec());
    const events = collect(soldier.stream());

    await soldier.send('first');
    await new Promise((r) => setTimeout(r, 120)); // let turn 1 finish: nothing is in flight now
    await soldier.interrupt(); // a no-op interrupt — receipt only, no result
    await new Promise((r) => setTimeout(r, 60));

    await soldier.send('second'); // a completely clean turn
    await new Promise((r) => setTimeout(r, 120));
    const close = await soldier.close();
    const all = await events;

    const statuses = all.filter((e) => e.type === 'result').map((e) => e.status);
    assert.deepEqual(statuses, ['ok', 'ok'], 'neither turn was interrupted');
    assert.equal(close.status, 'ok');
  });

  test('a no-op interrupt still gets its receipt, and emits no result', async () => {
    const soldier = await adapter.spawn(spec());
    const events = collect(soldier.stream());
    await new Promise((r) => setTimeout(r, 80)); // idle: no turn has ever been sent
    await soldier.interrupt(); // must still resolve
    await new Promise((r) => setTimeout(r, 60));
    await soldier.close();
    const all = await events;
    assert.equal(all.filter((e) => e.type === 'result').length, 0, 'nothing was running to stop');
  });

  test('interrupt() rejects when the harness did not advertise interrupt_receipt_v1', async () => {
    const a = createClaudeAdapter({
      bin: FAKE_CLAUDE,
      closeGraceMs: 1500,
      killGraceMs: 500,
    });
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'no-interrupt';
    try {
      const soldier = await a.spawn(spec());
      void collect(soldier.stream());
      await new Promise((r) => setTimeout(r, 200));
      await assert.rejects(() => soldier.interrupt(), /interrupt_receipt_v1/);
      await soldier.close();
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });

  test('a control_response error rejects interrupt() rather than silently succeeding', async () => {
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'interrupt-error';
    try {
      const soldier = await adapter.spawn(spec());
      void collect(soldier.stream());
      await new Promise((r) => setTimeout(r, 150));
      await assert.rejects(() => soldier.interrupt(), /refused by the fake/);
      await soldier.close();
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });

  test('a malformed line on stdout does not kill the stream', async () => {
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'noise';
    try {
      const soldier = await adapter.spawn(spec());
      const all = await collect(soldier.stream());
      await soldier.close();
      assert.ok(all.some((e) => e.type === 'unknown' && e.harnessType === 'noise'));
      assert.ok(all.some((e) => e.type === 'assistant_text' && e.text === 'survived-the-noise'));
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });

  test('a truncated final line from a killed child is emitted, and close is clean', async () => {
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'partial';
    try {
      const soldier = await adapter.spawn(spec());
      const all = await collect(soldier.stream());
      const close = await soldier.close();
      assert.equal(close.status, 'ok');
      assert.ok(all.some((e) => e.type === 'unknown' && e.harnessType === 'noise'));
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });

  test('a non-zero exit produces an error event and status error, never a hang', async () => {
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'crash';
    try {
      const soldier = await adapter.spawn(spec());
      const all = await collect(soldier.stream());
      const close = await soldier.close();
      assert.equal(close.exitCode, 3);
      assert.equal(close.status, 'error');
      assert.ok(all.some((e) => e.type === 'error'));
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });

  test('a child that ignores stdin close and SIGTERM is escalated, not waited on forever', async () => {
    const a = createClaudeAdapter({ bin: FAKE_CLAUDE, closeGraceMs: 300, killGraceMs: 300 });
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'deaf';
    try {
      const soldier = await a.spawn(spec());
      const events = collect(soldier.stream());
      const close = await soldier.close();
      await events;
      assert.ok(close.status === 'killed' || close.status === 'timeout', `got ${close.status}`);
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });

  test('a missing binary produces an error event and a clean close, not an unhandled rejection', async () => {
    const a = createClaudeAdapter({ bin: join(FIXTURES, 'definitely-not-a-binary'), closeGraceMs: 300 });
    const soldier = await a.spawn(spec());
    const all = await collect(soldier.stream());
    const close = await soldier.close();
    assert.ok(all.some((e) => e.type === 'error' && /failed to spawn/.test(e.message)));
    assert.equal(close.status, 'error');
    assert.equal(close.exitCode, null);
  });

  // -------------------------------------------------------------------------------------------
  // PROCESS-LEVEL auth guard. The previous version of this test asserted
  // `typeof stderr === 'string'`, which passes with `--bare` sitting in the argv — i.e. the guard
  // on the single most expensive mistake in this module was incapable of failing.
  //
  // This one reads back what the CHILD PROCESS actually received and is proven to fail: see the
  // `injected` half of each case below, which asserts the guard fires on the bad input.
  // -------------------------------------------------------------------------------------------
  test('PROCESS-LEVEL: --bare never reaches the child, and the guard is proven to fail if it does', async () => {
    // Through the REAL adapter: argv builder, env builder and spawn() are all on the path.
    const probe = await probeViaAdapter(adapter, spec());
    assert.equal(probe.argv.includes('--bare'), false);
    assert.equal(probe.env['ANTHROPIC_API_KEY'], null, 'no API key is injected');
    assert.equal(probe.env['ANTHROPIC_AUTH_TOKEN'], null);

    // NEGATIVE CONTROL: the same assertion, with the flag deliberately injected. If this does not
    // throw, the guard above is decorative.
    const poisoned = await spawnProbe(FAKE_CLAUDE, [...buildClaudeArgs(spec()), '--bare']);
    assert.throws(
      () => assert.equal(poisoned.argv.includes('--bare'), false),
      /true !== false|Expected values to be strictly equal/,
      'the --bare guard must be able to fail',
    );
    const poisonedEnv = await spawnProbe(FAKE_CLAUDE, buildClaudeArgs(spec()), {
      ANTHROPIC_API_KEY: 'sk-should-not-be-here',
    });
    assert.throws(
      () => assert.equal(poisonedEnv.env['ANTHROPIC_API_KEY'], null),
      /Expected values to be strictly equal/,
      'the API-key guard must be able to fail',
    );
  });

  test('spec.env may not inject ANTHROPIC_API_KEY', () => {
    assert.throws(
      () => buildClaudeEnv(spec({ env: { ANTHROPIC_API_KEY: 'sk-nope' } }), { HOME: '/h' }),
      /may not set ANTHROPIC_API_KEY/,
    );
    // CLAUDE_CONFIG_DIR is the opposite case: it points at the inherited login, so it is forwarded.
    const env = buildClaudeEnv(spec({ env: { CLAUDE_CONFIG_DIR: '/cfg' } }), { HOME: '/h' });
    assert.equal(env['CLAUDE_CONFIG_DIR'], '/cfg');
  });

  test('a turn that produces NO result is an error, not a success', async () => {
    // A worker that accepts the work, exits 0, and reports nothing. Left unchecked this is
    // ledgered as `ok` — a fictitious success.
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'silent';
    try {
      const soldier = await adapter.spawn(spec());
      const events = collect(soldier.stream());
      await soldier.send('do the work');
      const close = await soldier.close();
      const all = await events;
      assert.equal(close.exitCode, 0, 'the process really did exit cleanly');
      assert.equal(close.status, 'error', 'exit 0 with no result must NOT be ok');
      assert.ok(
        all.some((e) => e.type === 'error' && /without producing a result event/.test(e.message)),
        'and the reason must be diagnosable',
      );
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });

  test('closing without ever sending is still a clean no-op', async () => {
    // The counterpart to the test above: no work was requested, so nothing is missing.
    const soldier = await adapter.spawn(spec());
    const events = collect(soldier.stream());
    const close = await soldier.close();
    await events;
    assert.equal(close.status, 'ok');
  });

  test('an interrupt answered with aborted_streaming is `interrupted`, not `error`', async () => {
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'abort-streaming';
    try {
      const soldier = await adapter.spawn(spec());
      const events = collect(soldier.stream());
      await soldier.send('long task');
      await new Promise((r) => setTimeout(r, 150));
      await soldier.interrupt();
      await new Promise((r) => setTimeout(r, 150));
      const close = await soldier.close();
      const all = await events;
      assert.ok(all.some((e) => e.type === 'result' && e.status === 'interrupted'));
      assert.equal(close.status, 'interrupted');
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });

  test('an interrupt answered with an UNRECOGNISED reason is still `interrupted`', async () => {
    // The drift case. We issued the interrupt, so whatever word a future claude invents for it,
    // the turn was stopped — and misfiling a stop as a failure is the expensive direction.
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'abort-unknown';
    try {
      const soldier = await adapter.spawn(spec());
      const events = collect(soldier.stream());
      await soldier.send('long task');
      await new Promise((r) => setTimeout(r, 150));
      await soldier.interrupt();
      await new Promise((r) => setTimeout(r, 150));
      const close = await soldier.close();
      const all = await events;
      assert.ok(all.some((e) => e.type === 'result' && e.status === 'interrupted'));
      assert.equal(close.status, 'interrupted');
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });
});

describe('codex adapter lifecycle', { skip: WINDOWS ? 'POSIX shebang fakes' : false }, () => {
  const adapter = createCodexAdapter({ bin: FAKE_CODEX, timeoutMs: 10_000 });

  test('spawns with stdin IGNORED — the silent-hang guard', async () => {
    // `codex exec` blocks forever on an open stdin pipe. The fake stats fd 0 and reports what it
    // found in the verdict text.
    const soldier = await adapter.spawn(spec({ harness: 'codex' }));
    const events = collect(soldier.stream());
    await soldier.send('go');
    await soldier.close();
    const all = await events;
    const text = all.filter((e) => e.type === 'assistant_text').at(-1)?.text ?? '';
    const parsed = JSON.parse(text) as { summary: string };
    assert.equal(parsed.summary, 'stdin was chardev', 'fd 0 must be /dev/null, never a FIFO');
    assert.doesNotMatch(parsed.summary, /fifo/);
  });

  // -------------------------------------------------------------------------------------------
  // PROCESS-LEVEL auth guard. The previous version asserted on the return value of the pure
  // function instead of on the child, so it could not catch the adapter handing CODEX_HOME over.
  // -------------------------------------------------------------------------------------------
  test('PROCESS-LEVEL: CODEX_HOME never reaches the child, and the guard is proven to fail if it does', async () => {
    // Precondition: this machine's own environment must be clean, otherwise ambient inheritance
    // (which is correct and intended) would make the assertion below meaningless.
    assert.equal(process.env['CODEX_HOME'], undefined, 'precondition: ambient CODEX_HOME unset');
    // Through the REAL adapter, so an adapter-introduced leak is caught — driving the fake
    // directly would bypass buildCodexEnv entirely.
    const probe = await probeViaAdapter(adapter, spec({ harness: 'codex' }));
    assert.equal(probe.env['CODEX_HOME'], null, 'CODEX_HOME must be unset in the child');
    assert.equal(probe.env['OPENAI_BASE_URL'], null);
    assert.equal(probe.argv.some((a) => a.includes('CODEX_HOME')), false);

    // NEGATIVE CONTROL: same assertion, with the variable actually present in the child.
    const poisoned = await spawnProbe(FAKE_CODEX, buildCodexArgs(spec({ harness: 'codex' }), 'go'), {
      CODEX_HOME: '/tmp/some-empty-dir',
    });
    assert.equal(poisoned.env['CODEX_HOME'], '/tmp/some-empty-dir', 'the poison really did land');
    assert.throws(
      () => assert.equal(poisoned.env['CODEX_HOME'], null),
      /Expected values to be strictly equal/,
      'the CODEX_HOME guard must be able to fail',
    );
  });

  test('spec.env cannot smuggle CODEX_HOME past the allow-list', () => {
    assert.throws(
      () => buildCodexEnv(spec({ harness: 'codex', env: { CODEX_HOME: '/tmp/x' } }), { HOME: '/h' }),
      /may not set CODEX_HOME/,
    );
    for (const key of CODEX_ENV_FORBIDDEN) {
      assert.throws(
        () => buildCodexEnv(spec({ harness: 'codex', env: { [key]: 'x' } }), { HOME: '/h' }),
        new RegExp(`may not set ${key}`),
      );
    }
  });

  test('spec.env is an allow-list: unknown keys are dropped, not forwarded', () => {
    const { env, dropped } = buildCodexEnvDetailed(
      spec({ harness: 'codex', env: { ARMY_TASK: 'hill-4', HTTPS_PROXY: 'http://p', SNEAKY: 'x' } }),
      { HOME: '/h' },
    );
    assert.equal(env['ARMY_TASK'], 'hill-4', 'our own namespace is always forwardable');
    assert.equal(env['HTTPS_PROXY'], 'http://p', 'proxy config carries no auth identity');
    assert.equal(env['SNEAKY'], undefined, 'anything not on the list is dropped');
    assert.deepEqual(dropped, ['SNEAKY']);
    assert.equal(env['HOME'], '/h', 'the ambient environment is still inherited wholesale');
    assert.equal(isForwardableCodexEnvKey('CODEX_HOME'), false);
    assert.equal(isForwardableCodexEnvKey('ARMY_ANYTHING'), true);
  });

  test('the ambient CODEX_HOME is still inherited — filtering it would break a relocated store', () => {
    // The hazard is INJECTION via spec.env, not a commander who legitimately moved ~/.codex.
    const env = buildCodexEnv(spec({ harness: 'codex' }), { HOME: '/h', CODEX_HOME: '/custom' });
    assert.equal(env['CODEX_HOME'], '/custom');
  });

  test('a run producing no result and no output is an error, not a success', async () => {
    const saved = process.env['FAKE_CODEX_MODE'];
    process.env['FAKE_CODEX_MODE'] = 'silent';
    try {
      const soldier = await adapter.spawn(spec({ harness: 'codex' }));
      const events = collect(soldier.stream());
      await soldier.send('review the branch');
      const close = await soldier.close();
      const all = await events;
      assert.equal(close.exitCode, 0, 'the process really did exit cleanly');
      assert.equal(close.status, 'error', 'a silent INSPECTOR must never be ledgered as ok');
      assert.ok(all.some((e) => e.type === 'error' && /no result event and no structured output/.test(e.message)));
    } finally {
      if (saved === undefined) delete process.env['FAKE_CODEX_MODE'];
      else process.env['FAKE_CODEX_MODE'] = saved;
    }
  });

  test('exit 0 with partial output but no result is also an error', async () => {
    // Truncated mid-run: some events arrived, but no `turn.completed` and no -o file, so there is
    // no verdict. Partial evidence of work is not evidence of a completed review.
    const saved = process.env['FAKE_CODEX_MODE'];
    process.env['FAKE_CODEX_MODE'] = 'partial';
    try {
      const soldier = await adapter.spawn(spec({ harness: 'codex' }));
      const events = collect(soldier.stream());
      await soldier.send('review the branch');
      const close = await soldier.close();
      const all = await events;
      assert.equal(close.exitCode, 0);
      assert.equal(close.status, 'error');
      assert.ok(all.some((e) => e.type === 'assistant_text'), 'some work was visible');
      assert.equal(all.some((e) => e.type === 'result' && e.status === 'ok'), false);
    } finally {
      if (saved === undefined) delete process.env['FAKE_CODEX_MODE'];
      else process.env['FAKE_CODEX_MODE'] = saved;
    }
  });

  test('a full one-shot run: thread id, verdict, usage, clean close', async () => {
    const soldier = await adapter.spawn(spec({ harness: 'codex' }));
    const events = collect(soldier.stream());
    await soldier.send('review it');
    const close = await soldier.close();
    const all = await events;

    assert.equal(close.exitCode, 0);
    assert.equal(close.status, 'ok');
    assert.equal(close.costUsd, undefined, 'codex reports no cost; do not invent one');
    assert.ok((close.durationMs ?? 0) > 0, 'duration is our own measurement');

    assert.equal(codexThreadId(soldier), '019fc000-0000-7000-8000-00000000fake');
    assert.ok(isCodexSoldier(soldier));
    assert.equal(all.find((e) => e.type === 'ready')?.sessionId, '019fc000-0000-7000-8000-00000000fake');
    assert.deepEqual(all.find((e) => e.type === 'result')?.usage, {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 40,
      totalTokens: 110,
    });
  });

  test('the -o structured output is read back and matches the agent_message', async () => {
    const soldier = await adapter.spawn(spec({ harness: 'codex' }));
    const events = collect(soldier.stream());
    await soldier.send('go');
    await soldier.close();
    const all = await events;
    assert.ok(isCodexSoldier(soldier));
    const fromFile = soldier.outputText;
    assert.notEqual(fromFile, null);
    // Identical in both places, so no duplicate assistant_text is synthesised.
    assert.equal(all.filter((e) => e.type === 'assistant_text').length, 1);
    assert.equal(all.find((e) => e.type === 'assistant_text')?.text, fromFile);
  });

  test('a failed run writes no -o file, and that is reported rather than stat-crashing', async () => {
    const saved = process.env['FAKE_CODEX_MODE'];
    process.env['FAKE_CODEX_MODE'] = 'fail';
    try {
      const soldier = await adapter.spawn(spec({ harness: 'codex' }));
      const events = collect(soldier.stream());
      await soldier.send('go');
      const close = await soldier.close();
      const all = await events;
      assert.equal(close.exitCode, 1);
      assert.equal(close.status, 'error');
      assert.ok(isCodexSoldier(soldier));
      assert.equal(soldier.outputText, null);
      assert.ok(all.some((e) => e.type === 'error' && /without writing --output-last-message/.test(e.message)));
      assert.ok(all.some((e) => e.type === 'result' && e.status === 'error'));
    } finally {
      if (saved === undefined) delete process.env['FAKE_CODEX_MODE'];
      else process.env['FAKE_CODEX_MODE'] = saved;
    }
  });

  test('send() is valid exactly once — it is turn-based', async () => {
    const soldier = await adapter.spawn(spec({ harness: 'codex' }));
    void collect(soldier.stream());
    await soldier.send('one');
    await assert.rejects(() => soldier.send('two'), /exactly once/);
    await soldier.close();
  });

  test('interrupt() rejects rather than pretending', async () => {
    const soldier = await adapter.spawn(spec({ harness: 'codex' }));
    void collect(soldier.stream());
    await assert.rejects(() => soldier.interrupt(), /not supported/);
    await soldier.close();
  });

  test('close() without a send is clean and does not hang', async () => {
    const soldier = await adapter.spawn(spec({ harness: 'codex' }));
    const events = collect(soldier.stream());
    const close = await soldier.close();
    assert.deepEqual(await events, []);
    assert.equal(close.exitCode, null);
  });

  test('a missing binary produces an error event and a clean close', async () => {
    const a = createCodexAdapter({ bin: join(FIXTURES, 'definitely-not-a-binary') });
    const soldier = await a.spawn(spec({ harness: 'codex' }));
    const events = collect(soldier.stream());
    await soldier.send('go');
    const close = await soldier.close();
    assert.ok((await events).some((e) => e.type === 'error' && /failed to spawn/.test(e.message)));
    assert.equal(close.status, 'error');
  });

  test('a soldier REFUSED by the credential guard does not report success', async () => {
    // The INSPECTOR is the codex role, so a review that never ran must never read as a clean run.
    // The old `!started || child === null` short-circuit returned `ok` here.
    const soldier = await adapter.spawn(spec({ harness: 'codex' }));
    const events = collect(soldier.stream());
    // Mutate the spec so the env guard refuses at launch, exactly as a bad caller would.
    (soldier.spec as { env?: Record<string, string> }).env = { CODEX_HOME: '/tmp/isolated' };
    await soldier.send('review the branch');
    const close = await soldier.close();
    const all = await events;
    assert.equal(close.status, 'error', 'a soldier that never started is NOT ok');
    assert.equal(close.exitCode, null);
    assert.ok(all.some((e) => e.type === 'error' && /may not set CODEX_HOME/.test(e.message)));
  });

  test('send() REJECTS rather than throwing synchronously', async () => {
    // `send` is typed Promise<void>; a synchronous throw slips past every caller's .catch() and
    // takes the process out. It reaches buildCodexArgs, which throws on a flag-like spec value.
    const soldier = await adapter.spawn(spec({ harness: 'codex' }));
    (soldier.spec as { model?: string }).model = '--dangerously-bypass-approvals-and-sandbox';
    let sync = false;
    let rejected = false;
    try {
      await soldier.send('go').catch(() => {
        rejected = true;
      });
    } catch {
      sync = true;
    }
    assert.equal(sync, false, 'must not throw synchronously');
    assert.equal(rejected, true, 'must reject so .catch() sees it');
    await soldier.close();
  });

  test('spawn() rejects rather than throwing, on both harnesses', async () => {
    let sync = false;
    try {
      await codexAdapter.spawn(spec({ harness: 'codex', model: '-s' })).catch(() => undefined);
      await claudeAdapter.spawn(spec({ sessionId: 'not-a-uuid' })).catch(() => undefined);
    } catch {
      sync = true;
    }
    assert.equal(sync, false);
    await assert.rejects(() => codexAdapter.spawn(spec({ harness: 'codex', model: '-s' })), /may not begin with/);
    await assert.rejects(() => claudeAdapter.spawn(spec({ sessionId: 'not-a-uuid' })), /must be a UUID/);
  });

  test('a DEMANDED verdict that never arrives is a failure, not a quiet null', async () => {
    // outputSchemaPath means the caller demanded a schema-capped return. `status: ok` with
    // `outputText: null` invites reading "no verdict" as "no findings".
    const saved = process.env['FAKE_CODEX_MODE'];
    process.env['FAKE_CODEX_MODE'] = 'no-output';
    try {
      const soldier = await adapter.spawn(
        spec({ harness: 'codex', outputSchemaPath: join(HERE, '..', 'schemas', 'verdict.v1.json') }),
      );
      const events = collect(soldier.stream());
      await soldier.send('review it');
      const close = await soldier.close();
      const all = await events;
      assert.equal(close.exitCode, 0, 'the run itself completed');
      assert.equal(close.status, 'error', 'but the demanded artifact never arrived');
      assert.ok(all.some((e) => e.type === 'error' && /--output-schema was demanded/.test(e.message)));
    } finally {
      if (saved === undefined) delete process.env['FAKE_CODEX_MODE'];
      else process.env['FAKE_CODEX_MODE'] = saved;
    }
  });

  test('...but no structured output was demanded, so its absence is fine', async () => {
    const saved = process.env['FAKE_CODEX_MODE'];
    process.env['FAKE_CODEX_MODE'] = 'no-output';
    try {
      const soldier = await adapter.spawn(spec({ harness: 'codex' }));
      const events = collect(soldier.stream());
      await soldier.send('just do the thing');
      const close = await soldier.close();
      await events;
      assert.equal(close.status, 'ok');
    } finally {
      if (saved === undefined) delete process.env['FAKE_CODEX_MODE'];
      else process.env['FAKE_CODEX_MODE'] = saved;
    }
  });
});

// =============================================================================================
// 4b. CONFINEMENT — the permission boundary on a harness that has no permission model
//
// MEASURED against codex-cli 0.142.5 / macOS Seatbelt on 2026-08-02, by running real
// `codex exec -s workspace-write` probes and then inspecting the filesystem:
//
//   writable : the -C subtree, /tmp, $TMPDIR
//   denied   : siblings and parents of -C, arbitrary $HOME paths, ~/.agentic-army-shaped paths
//              (denied via a shell command AND via codex's own file-editing tool)
//   READS    : not confined anywhere — a private key and a ~/.ssh listing were both readable
//
// So the read half of SECRET_PATH_GLOBS and every Bash command-deny are RECORDED INTENT on this
// harness, and PROTECTED_CONFIG_GLOBS is enforced only because the army home normally lives under
// $HOME. These tests pin the boundary in both directions.
// =============================================================================================

describe('codex confinement', () => {
  const HOME = '/Users/probe';
  const ENV = { TMPDIR: '/var/folders/xx/T' };
  const denyFor = (globs: string[]): string[] =>
    globs.flatMap((g) => [`Write(${g})`, `Edit(${g})`, `Read(${g})`, `Grep(${g})`]);

  test('the army home under $HOME is ENFORCED — it is outside every writable root', () => {
    const c = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/tree', deny: denyFor(['~/.agentic-army', '~/.agentic-army/**']) }),
      ENV,
      HOME,
    );
    assert.deepEqual(c.breaches, [], 'no breach: $HOME is not writable under workspace-write');
    assert.ok(c.enforced.includes('Write(~/.agentic-army/**)'));
    assert.ok(c.enforced.includes('Edit(~/.agentic-army)'));
  });

  test('read-denies are UNENFORCEABLE and reported as such, never as enforced', () => {
    const c = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/tree', deny: denyFor(['~/.ssh', '~/.agentic-army']) }),
      ENV,
      HOME,
    );
    assert.ok(c.unenforceable.includes('Read(~/.ssh)'));
    assert.ok(c.unenforceable.includes('Grep(~/.ssh)'));
    assert.ok(c.unenforceable.includes('Read(~/.agentic-army)'));
    assert.equal(c.enforced.includes('Read(~/.ssh)'), false, 'a read-deny must NEVER be claimed as enforced');
    for (const rule of c.enforced) assert.match(rule, /^(Write|Edit|MultiEdit|NotebookEdit)\(/);
  });

  test('Bash command denials are UNENFORCEABLE — the sandbox governs paths, not argv', () => {
    const denies = ['Bash(npm publish:*)', 'Bash(gh pr merge:*)'];
    const c = codexConfinement(spec({ harness: 'codex', cwd: '/work/tree', deny: denies }), ENV, HOME);
    assert.deepEqual(c.unenforceable, denies);
    assert.deepEqual(c.enforced, []);
    assert.deepEqual(c.breaches, [], 'unenforceable, but not a refusal — codex simply has no such control');
  });

  test('an unrooted glob is unenforceable — a filename pattern is not a region', () => {
    const c = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/tree', deny: ['Write(**/.env)', 'Write(**/id_rsa*)'] }),
      ENV,
      HOME,
    );
    assert.deepEqual(c.unenforceable, ['Write(**/.env)', 'Write(**/id_rsa*)']);
    assert.deepEqual(c.breaches, [], 'every worktree contains these; refusing would ban the harness');
  });

  test('an army home in /tmp is a HOLE, and the hole is closed rather than ignored', () => {
    const c = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/tree', deny: ['Write(/tmp/army-home/**)'] }),
      ENV,
      HOME,
    );
    assert.deepEqual(c.breaches, []);
    assert.ok(c.enforced.includes('Write(/tmp/army-home/**)'));
    assert.ok(c.args.includes('sandbox_workspace_write.exclude_slash_tmp=true'), 'the /tmp exemption is removed');
    assert.equal(c.writableRoots.includes('/tmp'), false);
  });

  test('an army home in $TMPDIR closes the TMPDIR exemption specifically', () => {
    const c = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/tree', deny: ['Write(/var/folders/xx/T/army/**)'] }),
      ENV,
      HOME,
    );
    assert.ok(c.args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
    assert.equal(c.args.includes('sandbox_workspace_write.exclude_slash_tmp=true'), false);
  });

  test('$TMPDIR stays writable when nothing protected lives there — test runners need it', () => {
    const c = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/tree', deny: ['Write(~/.agentic-army/**)'] }),
      ENV,
      HOME,
    );
    assert.equal(c.args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'), false);
    // writableRoots are CANONICAL, so compare against the canonical form rather than the spelling
    // we happened to pass in — that difference is the whole of blocker #1.
    assert.equal(c.writableRoots.length, 3);
    assert.ok(c.writableRoots.some((r) => r.endsWith('/folders/xx/T')));
  });

  test('network access is pinned off so a user config.toml cannot quietly widen it', () => {
    const c = codexConfinement(spec({ harness: 'codex', cwd: '/work/tree' }), ENV, HOME);
    assert.ok(c.args.includes('sandbox_workspace_write.network_access=false'));
    assert.ok(
      buildCodexArgs(spec({ harness: 'codex' }), 'go').includes('sandbox_workspace_write.network_access=false'),
    );
  });

  test('$AGENTIC_ARMY_HOME is expanded from the supervisor env; an unresolvable one is not claimed', () => {
    const resolved = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/tree', deny: ['Write($AGENTIC_ARMY_HOME/**)'] }),
      { ...ENV, AGENTIC_ARMY_HOME: '/Users/probe/.army' },
      HOME,
    );
    assert.ok(resolved.enforced.includes('Write($AGENTIC_ARMY_HOME/**)'));
    const unresolved = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/tree', deny: ['Write($AGENTIC_ARMY_HOME/**)'] }),
      ENV,
      HOME,
    );
    assert.ok(unresolved.unenforceable.includes('Write($AGENTIC_ARMY_HOME/**)'));
    assert.equal(unresolved.enforced.includes('Write($AGENTIC_ARMY_HOME/**)'), false);
  });

  // ---- PATH ALIASING: the sandbox compares inodes, not spellings -----------------------------
  //
  // BLOCKER, found live: the classifier used lexical resolve()/relative() and never realpath().
  // On macOS `/tmp` IS `/private/tmp`, so a deny root inside the writable region classified as
  // `enforced`, no exclusion flag was emitted, and the file was written. No attacker required —
  // `/private/tmp/army` is the canonical form macOS itself reports.

  test('a /private/tmp deny root is NOT falsely enforced (the live-proven hole)', () => {
    const c = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/tree', deny: ['Write(/private/tmp/army/**)'] }),
      ENV,
      HOME,
    );
    assert.ok(
      c.args.includes('sandbox_workspace_write.exclude_slash_tmp=true'),
      '/private/tmp is /tmp; the exemption must be closed',
    );
    assert.equal(c.writableRoots.some((r) => r === '/private/tmp' || r === '/tmp'), false);
  });

  test('both spellings of /tmp classify identically', () => {
    const mk = (p: string): CodexConfinement =>
      codexConfinement(spec({ harness: 'codex', cwd: '/work/tree', deny: [`Write(${p}/army/**)`] }), ENV, HOME);
    const viaSymlink = mk('/tmp');
    const viaReal = mk('/private/tmp');
    assert.deepEqual(viaSymlink.args, viaReal.args, 'aliases must not produce different confinement');
  });

  test('a symlinked cwd and its real path classify identically, in both directions', () => {
    const { mkdtempSync, symlinkSync, mkdirSync, rmSync } = nodeFs;
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'army-alias-')));
    try {
      const real = join(base, 'real-tree');
      const link = join(base, 'link-tree');
      mkdirSync(join(real, 'army'), { recursive: true });
      symlinkSync(real, link);

      // deny root spelled via the symlink, cwd spelled via the real path...
      const a = codexConfinement(
        spec({ harness: 'codex', cwd: real, deny: [`Write(${join(link, 'army')}/**)`] }),
        ENV,
        HOME,
      );
      // ...and the reverse.
      const b = codexConfinement(
        spec({ harness: 'codex', cwd: link, deny: [`Write(${join(real, 'army')}/**)`] }),
        ENV,
        HOME,
      );
      assert.equal(a.breaches.length, 1, 'the deny root IS inside the workspace, however it is spelled');
      assert.equal(b.breaches.length, 1, 'and in the other direction too');
      assert.deepEqual(a.enforced, []);
      assert.deepEqual(b.enforced, []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('a path that does not exist yet still canonicalises via its nearest ancestor', () => {
    // A protected config dir very often does not exist. realpath() throws on it, so the walk-up is
    // load-bearing: without it every not-yet-created deny root falls back to a lexical compare.
    const { mkdtempSync, rmSync } = nodeFs;
    const base = mkdtempSync(join(tmpdir(), 'army-alias-')); // spelled /var/..., real /private/var/...
    try {
      const missing = join(base, 'does', 'not', 'exist', 'army');
      const c = codexConfinement(
        spec({ harness: 'codex', cwd: join(base, 'tree'), deny: [`Write(${missing}/**)`] }),
        { TMPDIR: base },
        HOME,
      );
      assert.deepEqual(c.breaches, [], 'not inside the worktree');
      assert.ok(
        c.args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'),
        'but it IS inside TMPDIR, which must therefore be excluded',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('case-only differences are treated as inside — the safe direction on APFS/NTFS', () => {
    const c = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/wt', deny: ['Write(/work/WT/army/**)'] }),
      ENV,
      HOME,
    );
    assert.deepEqual(c.breaches, ['Write(/work/WT/army/**)']);
    assert.equal(c.enforced.length, 0, 'never claim enforcement across a case alias');
  });

  // ---- THE BOUNDARY: refuse to spawn ---------------------------------------------------------

  test('an army home INSIDE the worktree is a BREACH — unfixable by any config', () => {
    const c = codexConfinement(
      spec({ harness: 'codex', cwd: '/work/tree', deny: ['Write(/work/tree/.agentic-army/**)'] }),
      ENV,
      HOME,
    );
    assert.deepEqual(c.breaches, ['Write(/work/tree/.agentic-army/**)']);
    assert.equal(c.enforced.length, 0);
  });

  test('spawn() REFUSES when the protected region sits inside the writable root', async () => {
    const adapter = createCodexAdapter({ bin: FAKE_CODEX });
    await assert.rejects(
      () =>
        adapter.spawn(
          spec({ harness: 'codex', cwd: HERE, deny: [`Write(${join(HERE, '.agentic-army')}/**)`] }),
        ),
      /refusing to spawn codex soldier/,
      'a deny-list that cannot be honoured must stop the worker, not be silently dropped',
    );
  });

  test('spawn() PROCEEDS for a normal spec — the refusal is conditional, not blanket', async () => {
    if (WINDOWS) return;
    const adapter = createCodexAdapter({ bin: FAKE_CODEX });
    const soldier = await adapter.spawn(
      spec({ harness: 'codex', cwd: HERE, deny: ['Write(~/.agentic-army/**)', 'Read(~/.ssh)'] }),
    );
    const events = collect(soldier.stream());
    await soldier.send('go');
    const close = await soldier.close();
    await events;
    assert.equal(close.status, 'ok');
  });

  test('the confinement is announced on the stream, so a replay records what was NOT enforced', async () => {
    if (WINDOWS) return;
    const adapter = createCodexAdapter({ bin: FAKE_CODEX });
    const soldier = await adapter.spawn(
      spec({
        harness: 'codex',
        cwd: HERE,
        deny: ['Write(~/.agentic-army/**)', 'Read(~/.ssh)', 'Bash(npm publish:*)'],
      }),
    );
    const events = collect(soldier.stream());
    await soldier.send('go');
    await soldier.close();
    const all = await events;
    const note = all.find((e) => e.type === 'unknown' && e.harnessType === 'agentic-army/confinement');
    assert.ok(note, 'every codex run must state its confinement');
    const raw = note.raw as { unenforceable: string[]; enforced: string[] };
    assert.ok(raw.unenforceable.includes('Read(~/.ssh)'));
    assert.ok(raw.unenforceable.includes('Bash(npm publish:*)'));
    assert.ok(raw.enforced.includes('Write(~/.agentic-army/**)'));
    assert.equal(all.indexOf(note), 0, 'and state it BEFORE any model output');
  });
});

describe('permission denials are first-class (a denial IS a ceiling breach)', () => {
  test('each permission_denial becomes its own event, not a dig into ResultEvent.raw', () => {
    const n = createClaudeNormalizer();
    const out = n.next(
      {
        ok: true,
        index: 0,
        text: '',
        value: {
          type: 'result',
          subtype: 'success',
          terminal_reason: 'completed',
          permission_denials: [
            { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm publish' } },
            { tool_name: 'Write', tool_use_id: 'toolu_2', tool_input: { file_path: '~/.agentic-army/config.toml' } },
          ],
        },
      },
      FIXED_TS,
    );
    const denials = out.filter((e) => e.type === 'unknown' && e.harnessType === 'permission_denial');
    assert.equal(denials.length, 2);
    assert.equal((denials[0]?.raw as { tool_name: string }).tool_name, 'Bash');
    assert.equal((denials[1]?.raw as { tool_name: string }).tool_name, 'Write');
    assert.equal(out.at(-1)?.type, 'result', 'the result still terminates the turn');
  });

  test('an empty permission_denials array adds nothing', () => {
    const n = createClaudeNormalizer();
    const out = n.next(
      {
        ok: true,
        index: 0,
        text: '',
        value: { type: 'result', subtype: 'success', terminal_reason: 'completed', permission_denials: [] },
      },
      FIXED_TS,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.type, 'result');
  });
});

// =============================================================================================
// 5. registry
// =============================================================================================

describe('adapter registry', () => {
  test('covers every HarnessId', () => {
    assert.deepEqual(Object.keys(ADAPTERS).sort(), [...HARNESS_IDS].sort());
    for (const id of HARNESS_IDS) assert.equal(getAdapter(id).id, id);
  });

  test('declares duplex support honestly', () => {
    assert.equal(claudeAdapter.supportsDuplex, true);
    assert.equal(codexAdapter.supportsDuplex, false);
  });

  test('an unknown harness throws rather than returning undefined', () => {
    // @ts-expect-error deliberately off-contract
    assert.throws(() => getAdapter('opencode'), /unknown harness/);
  });

  test('spawnSoldier dispatches on spec.harness', async () => {
    if (WINDOWS) return;
    const soldier = await spawnSoldier(spec({ harness: 'codex', cwd: HERE }));
    assert.equal(soldier.id, 'cpt-03');
    assert.equal(soldier.spec.harness, 'codex');
    void collect(soldier.stream());
    await soldier.close();
  });
});

// =============================================================================================
// 6. live smoke — one per harness, skipped unless ARMY_LIVE=1
// =============================================================================================

describe('live smoke', { skip: LIVE ? false : 'set ARMY_LIVE=1 to run (spends quota)' }, () => {
  test('claude replies ok over the duplex pipe', { timeout: 120_000 }, async () => {
    const soldier = await claudeAdapter.spawn(
      spec({ harness: 'claude', model: 'haiku', sessionId: randomUUID(), cwd: HERE }),
    );
    // `stream()` is single-consumer by contract: one pump, and everything else reads `seen`.
    const seen: SoldierEvent[] = [];
    const pump = (async () => {
      for await (const e of soldier.stream()) seen.push(e);
    })();

    await soldier.send('reply with the word ok and nothing else');
    const deadline = Date.now() + 90_000;
    while (!seen.some((e) => e.type === 'result')) {
      if (Date.now() > deadline) throw new Error('live claude smoke timed out waiting for a result');
      await new Promise((r) => setTimeout(r, 200));
    }

    const close = await soldier.close();
    await pump;

    const ready = seen.find((e) => e.type === 'ready');
    assert.ok(ready, 'expected a ready event');
    assert.equal(ready.sessionId, soldier.spec.sessionId, '--session-id is supervisor-minted');
    assert.ok(ready.capabilities.includes('interrupt_receipt_v1'));
    const text = seen.filter((e) => e.type === 'assistant_text').map((e) => e.text).join(' ');
    assert.match(text.toLowerCase(), /ok/);
    assert.ok(seen.some((e) => e.type === 'result' && e.status === 'ok'));
    assert.equal(close.status, 'ok');
  });

  test('codex replies ok over exec --json', { timeout: 180_000 }, async () => {
    const soldier = await codexAdapter.spawn(
      spec({ harness: 'codex', model: 'gpt-5.5', effort: 'minimal', sessionId: randomUUID(), cwd: HERE }),
    );
    const events = collect(soldier.stream());
    await soldier.send('reply with the word ok');
    const close = await soldier.close();
    const seen = await events;
    assert.equal(close.status, 'ok');
    assert.notEqual(codexThreadId(soldier), null);
    const text = seen.filter((e) => e.type === 'assistant_text').map((e) => e.text).join(' ');
    assert.match(text.toLowerCase(), /ok/);
  });
});
