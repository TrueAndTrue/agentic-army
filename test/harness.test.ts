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

function normalizeClaudeFixture(name: string, partialText = false): SoldierEvent[] {
  const n = createClaudeNormalizer(partialText ? { partialText } : undefined);
  return loadFixture(name).flatMap((l) => n.next(l, FIXED_TS));
}

/** Every text-bearing event, in order — what a consumer that renders text actually renders. */
function renderedText(events: readonly SoldierEvent[]): string {
  return events
    .map((e) => (e.type === 'assistant_text' || e.type === 'subagent_text' ? e.text : ''))
    .join('');
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

/**
 * How long `collectResults` will wait before giving up. NOT a timing assumption: the passing path
 * never reaches it, because it settles on the event itself. It is a HANG-BREAKER — a soldier that
 * under-reports must fail on an assertion that names what was missing, not park the runner
 * forever. Mutation-tested: making the fake drop one of two turns hangs a bare `await` and the
 * whole file with it, which is how this ceiling came to be here.
 */
const RESULT_CEILING_MS = 15_000;

/**
 * `collect`, plus a promise that settles once `n` `result` events have landed.
 *
 * A lifecycle test that sleeps before closing is asserting an UNSTATED DEADLINE — "the fake will
 * be finished within 250ms" — and a deadline nobody wrote down is a deadline nobody maintains.
 * Waiting for the event the test is actually about removes the guess: it cannot pass by luck on a
 * fast machine, and it cannot fail by bad luck on a loaded one. It settles on stream end too, so
 * a soldier that dies without reporting fails on its assertion rather than hanging.
 */
function collectResults(
  stream: AsyncIterable<SoldierEvent>,
  n: number,
): { all: Promise<SoldierEvent[]>; results: Promise<void> } {
  const out: SoldierEvent[] = [];
  let seen = 0;
  let done: () => void = () => {};
  const results = new Promise<void>((r) => (done = r));
  const ceiling = setTimeout(() => done(), RESULT_CEILING_MS);
  ceiling.unref?.();
  const all = (async (): Promise<SoldierEvent[]> => {
    for await (const e of stream) {
      out.push(e);
      if (e.type === 'result' && (seen += 1) >= n) {
        clearTimeout(ceiling);
        done();
      }
    }
    clearTimeout(ceiling);
    done();
    return out;
  })();
  return { all, results };
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

  test('--include-partial-messages is OPT-IN, and off by default', () => {
    // Off by default because the lines it produces are duplicates of the aggregate `assistant`
    // message. Measured against claude 2.1.221: a 2217-char reply arrives as 32 deltas and those
    // lines are 54% of the turn's stdout. A campaign soldier has nobody at a prompt, so for it
    // that is pure cost — and asking for lines we then discard would break the archive's rule
    // that no line is dropped.
    assert.equal(args.includes('--include-partial-messages'), false);
    assert.equal(buildClaudeArgs(spec(), {}).includes('--include-partial-messages'), false);
    assert.equal(
      buildClaudeArgs(spec(), { partialMessages: false }).includes('--include-partial-messages'),
      false,
    );
    assert.ok(
      buildClaudeArgs(spec(), { partialMessages: true }).includes('--include-partial-messages'),
    );
  });

  test('the partial flag is a bare flag, and lands clear of the variadic ones', () => {
    // `--allowedTools` swallows everything up to the next `--flag`, so a flag emitted INSIDE that
    // run would be read as a tool name by the CLI and by the fake alike.
    const a = buildClaudeArgs(spec({ allow: ['Read', 'Grep'], deny: ['Bash(git push*)'] }), {
      partialMessages: true,
    });
    const at = a.indexOf('--include-partial-messages');
    assert.ok(at > -1);
    assert.ok(at < a.indexOf('--allowedTools'), 'must precede --allowedTools');
    assert.ok(at < a.indexOf('--disallowedTools'), 'must precede --disallowedTools');
    // It takes no value: whatever follows is another flag, never a bare word.
    assert.equal((a[at + 1] ?? '--end').startsWith('--'), true);
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

describe('extra MCP servers (the desktop app hands a chat agent its start_flow tool)', () => {
  const army = { name: 'army', command: '/Applications/X.app/Contents/MacOS/X', args: ['/home/mcp/army-flows.cjs'], env: { ELECTRON_RUN_AS_NODE: '1', ARMY_FLOW_TOKEN: 't"1' } };

  test('claude gets them inline in --mcp-config, placed before the variadic tool lists', () => {
    const a = buildClaudeArgs(spec({ mcpServers: [army], allow: ['Read', 'mcp__army'] }));
    const i = a.indexOf('--mcp-config');
    assert.ok(i > 0 && i < a.indexOf('--allowedTools'), a.join(' '));
    assert.deepEqual(JSON.parse(a[i + 1]!), { mcpServers: { army: { type: 'stdio', command: army.command, args: army.args, env: army.env } } });
    assert.equal(buildClaudeArgs(spec()).includes('--mcp-config'), false);
  });

  test('codex gets TOML overrides on both a fresh exec and exec resume', () => {
    for (const extra of [{}, { resumeSessionId: 'thread-1' }]) {
      const a = buildCodexArgs(spec({ harness: 'codex', mcpServers: [army], ...extra }), 'go');
      assert.ok(a.includes(`mcp_servers.army.command="${army.command}"`));
      assert.ok(a.includes(`mcp_servers.army.args=["/home/mcp/army-flows.cjs"]`));
      assert.ok(a.includes('mcp_servers.army.env={ ELECTRON_RUN_AS_NODE = "1", ARMY_FLOW_TOKEN = "t\\"1" }'), a.join(' '));
      assert.ok(a.indexOf('--') > a.indexOf(`mcp_servers.army.command="${army.command}"`), 'before the prompt');
      assert.ok(a.includes('mcp_servers.army.default_tools_approval_mode="approve"'), 'exec cannot answer an approval prompt');
    }
  });

  test('a server name or env key that could break out of its slot is refused', () => {
    assert.throws(() => buildClaudeArgs(spec({ mcpServers: [{ ...army, name: 'a b' }] })), /lowercase identifier/);
    assert.throws(() => buildCodexArgs(spec({ harness: 'codex', mcpServers: [{ ...army, name: 'x.y' }] }), 'go'), /lowercase identifier/);
    assert.throws(() => buildCodexArgs(spec({ harness: 'codex', mcpServers: [{ ...army, env: { 'A=1,B': 'x' } }] }), 'go'), /not a variable name/);
  });
});

describe('standing instructions (the desktop app tells a chat what start_flow starts)', () => {
  const note = 'You can start flows.\nSay "done" when "done".';

  test('claude gets --append-system-prompt, and nothing when there are none', () => {
    const a = buildClaudeArgs(spec({ instructions: note }));
    assert.equal(a[a.indexOf('--append-system-prompt') + 1], note);
    assert.equal(buildClaudeArgs(spec()).includes('--append-system-prompt'), false);
    assert.throws(() => buildClaudeArgs(spec({ instructions: '--bare' })), /must not start with "-"/);
  });

  test('codex gets developer_instructions as a TOML string, on exec and exec resume', () => {
    for (const extra of [{}, { resumeSessionId: 'thread-1' }]) {
      const a = buildCodexArgs(spec({ harness: 'codex', instructions: note, ...extra }), 'go');
      assert.ok(a.includes(`developer_instructions=${JSON.stringify(note)}`), a.join(' '));
      assert.ok(a.indexOf('--') > a.indexOf(`developer_instructions=${JSON.stringify(note)}`), 'before the prompt');
    }
    assert.equal(buildCodexArgs(spec({ harness: 'codex' }), 'go').some((x) => x.startsWith('developer_instructions')), false);
  });
});

describe('resuming a conversation (the desktop app keeps a chat across restarts)', () => {
  const RESUME = '99999999-8888-7777-6666-555555555555';

  test('claude swaps --session-id for --resume, and a fresh spec is untouched', () => {
    const resumed = buildClaudeArgs(spec({ resumeSessionId: RESUME }));
    assert.equal(resumed[resumed.indexOf('--resume') + 1], RESUME);
    assert.equal(resumed.includes('--session-id'), false);
    assert.equal(buildClaudeArgs(spec()).includes('--resume'), false);
  });

  test('claude refuses a resume id that is not a UUID', () => {
    assert.throws(() => buildClaudeArgs(spec({ resumeSessionId: '--bare' })), /resumeSessionId must be a UUID/);
  });

  test('codex runs exec resume with the id and prompt after --, and keeps the sandbox', () => {
    const args = buildCodexArgs(spec({ harness: 'codex', resumeSessionId: 'thread-1', model: 'gpt-5.5' }), 'next turn');
    assert.deepEqual(args.slice(0, 2), ['exec', 'resume']);
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
    assert.equal(args.includes('-C'), false);
    assert.equal(args.includes('-s'), false);
    assert.deepEqual(args.slice(-3), ['--', 'thread-1', 'next turn']);
    assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.5');
  });

  test('codex refuses a flag-like resume id', () => {
    assert.throws(() => buildCodexArgs(spec({ harness: 'codex', resumeSessionId: '--last' }), 'x'), /resumeSessionId/);
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
    // `ultra` measured on 2026-09-24 with codex 0.154: gpt-6-astra and gpt-5.6-sol answer at it.
    const usable = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
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

// =============================================================================================
// 3b. partial messages — token-level streaming, pinned against recorded real streams
//
// claude-partial.jsonl and claude-partial-abort.jsonl were captured from claude 2.1.221 on
// 2026-08-03 by running the real duplex invocation with --include-partial-messages. Between them
// they carry text_delta, thinking_delta, signature_delta and input_json_delta, a tool round trip,
// two messages in one turn, and a turn aborted MID-STREAM by a real control_request.
// =============================================================================================

describe('claude normalizer / --include-partial-messages, default OFF', () => {
  // THE "CONSUMERS MUST NOT CARE" GUARD. `army campaign`'s narration, `army view`, the archive
  // writer and the org-chart tracking all read this stream. Adding a finer granularity must not
  // change what any of them sees, and this is what says so.
  const off = normalizeClaudeFixture('claude-partial');

  test('every partial line becomes `unknown` — never text, never dropped', () => {
    const lines = loadFixture('claude-partial');
    const partialLines = lines.filter(
      (l) => l.ok && (l.value as { type?: string }).type === 'stream_event',
    ).length;
    assert.equal(partialLines, 26, 'the fixture must actually contain partials');

    const partials = off.filter(
      (e) => e.type === 'unknown' && (e.harnessType ?? '').startsWith('stream_event/'),
    );
    assert.equal(partials.length, partialLines, 'one event per partial line, no more, no fewer');
    assert.deepEqual(
      [...new Set(partials.map((e) => (e.type === 'unknown' ? e.harnessType : '')))].sort(),
      [
        'stream_event/content_block_delta',
        'stream_event/content_block_start',
        'stream_event/content_block_stop',
        'stream_event/message_delta',
        'stream_event/message_start',
        'stream_event/message_stop',
      ],
    );
  });

  test('the text a consumer renders is the aggregate message, exactly as before', () => {
    const texts = off.filter((e) => e.type === 'assistant_text').map((e) => e.text);
    // Two thinking blocks' worth of nothing plus the one real reply: the SAME three
    // assistant_text events a run without the flag produces, because the flag is additive.
    assert.equal(texts.length, 2);
    assert.match(texts.join(''), /^Yes — 1729 is the smallest such number/);
  });

  test('the tool round trip is untouched by the partials interleaved through it', () => {
    const uses = off.filter((e) => e.type === 'tool_use');
    assert.equal(uses.length, 1);
    assert.equal(uses[0]?.type === 'tool_use' ? uses[0].name : null, 'Bash');
    // input_json_delta fragments are NOT individually parseable; the aggregate is authoritative.
    const input = uses[0]?.type === 'tool_use' ? uses[0].input : null;
    assert.equal(typeof (input as { command?: unknown }).command, 'string');
    assert.equal(off.filter((e) => e.type === 'tool_result').length, 1);
  });
});

describe('claude normalizer / --include-partial-messages, opted IN', () => {
  const on = normalizeClaudeFixture('claude-partial', true);
  const off = normalizeClaudeFixture('claude-partial');

  test('text now arrives in pieces — the whole point', () => {
    const said = (events: readonly SoldierEvent[]): string[] =>
      events.flatMap((e) => (e.type === 'assistant_text' && e.text !== '' ? [e.text] : []));
    // Without the flag the reply is ONE lump, delivered after the whole wait. With it, three.
    assert.deepEqual(said(off).length, 1);
    assert.equal(said(on).length, 3);
    assert.equal(said(on)[0], 'Y');
    assert.equal(said(on).join(''), said(off).join(''));
  });

  test('BLOCKER: the same text is never rendered twice', () => {
    // The aggregate `assistant` message still arrives — verified against the real CLI, which is
    // why the fixture has it. A consumer that concatenates text must see the reply ONCE.
    assert.equal(renderedText(on), renderedText(off));
    const reply = renderedText(on);
    assert.match(reply, /^Yes — 1729 is the smallest such number/);
    assert.equal(reply.indexOf('1729'), reply.lastIndexOf('1729'), 'the reply appears once');
  });

  test('the suppressed LINE still reaches the stream — only the TEXT is deduplicated', () => {
    // `stream.jsonl` is replay truth. Losing the aggregate line would lose its usage block, its
    // message id and its `raw` altogether.
    const marker = on.filter(
      (e) => e.type === 'unknown' && e.harnessType === 'assistant/text_streamed',
    );
    assert.equal(marker.length, 1);
    assert.equal((marker[0]?.raw as { type?: string }).type, 'assistant');
  });

  test('NO LINE IS DROPPED, in either mode', () => {
    // The archive's one hard rule. Asserted per line rather than in total, so a line that
    // silently produced zero events cannot hide behind one that produced two.
    for (const partial of [false, true]) {
      for (const name of ['claude-partial', 'claude-partial-abort']) {
        const n = createClaudeNormalizer(partial ? { partialText: true } : undefined);
        for (const line of loadFixture(name)) {
          assert.ok(
            n.next(line, FIXED_TS).length >= 1,
            `${name} (partial=${String(partial)}) dropped ${line.text.slice(0, 60)}`,
          );
        }
      }
    }
  });

  test('everything that is not text stays `unknown`, including tool-input fragments', () => {
    // `input_json_delta` carries fragments of a tool call's arguments. They are not text and must
    // never be rendered as any; and `thinking_delta` on the -p path is redacted to an empty
    // string plus a token estimate, so it must not become a run of contentless text events.
    const kinds = on
      .filter((e) => e.type === 'unknown')
      .map((e) => (e.type === 'unknown' ? e.harnessType : ''));
    assert.equal(kinds.filter((k) => k === 'stream_event/content_block_delta').length, 11);
    // The one empty text event is the aggregate's own redacted `thinking` block, and it is
    // present in BOTH modes. The eleven partials added none of their own — which is the point:
    // turning the flag on must not put a run of contentless rows in the archive, and must not
    // register an empty buffer that then suppresses that very block.
    const blanks = (events: readonly SoldierEvent[]): number =>
      events.filter((e) => e.type === 'assistant_text' && e.text === '').length;
    assert.equal(blanks(on), blanks(off));
    assert.equal(blanks(on), 1);
  });

  test('the tool round trip and the result survive identically', () => {
    for (const type of ['tool_use', 'tool_result', 'result', 'ready'] as const) {
      assert.deepEqual(
        on.filter((e) => e.type === type).map((e) => JSON.stringify(e.raw)),
        off.filter((e) => e.type === type).map((e) => JSON.stringify(e.raw)),
        type,
      );
    }
  });

  test('suppression is EXACT MATCH: an aggregate that differs is emitted, not lost', () => {
    // The two mistakes are not symmetric. Suppressing wrongly LOSES text the soldier produced;
    // failing to suppress shows a duplicate. So a future CLI that post-processes what it streamed
    // must fall out on the safe side.
    const n = createClaudeNormalizer({ partialText: true });
    const feed = (value: unknown): SoldierEvent[] => n.next({ ok: true, index: 0, text: '', value });
    feed({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null });
    feed({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hell' } },
      parent_tool_use_id: null,
    });
    const out = feed({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
    });
    assert.equal(out[0]?.type, 'assistant_text', 'a mismatched aggregate must still be emitted');
    assert.equal(out[0]?.type === 'assistant_text' ? out[0].text : null, 'hello there');
  });

  test('a message boundary clears the buffers, so one turn cannot suppress the next', () => {
    const n = createClaudeNormalizer({ partialText: true });
    const feed = (value: unknown): SoldierEvent[] => n.next({ ok: true, index: 0, text: '', value });
    feed({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null });
    feed({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'same' } },
      parent_tool_use_id: null,
    });
    // A NEW message that happens to say the same words, with no deltas of its own — a turn cut
    // short leaves exactly this state behind.
    feed({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null });
    const out = feed({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'same' }] },
    });
    assert.equal(out[0]?.type, 'assistant_text');
  });

  test('two identical blocks in one message are not both eaten by one run of deltas', () => {
    const n = createClaudeNormalizer({ partialText: true });
    const feed = (value: unknown): SoldierEvent[] => n.next({ ok: true, index: 0, text: '', value });
    feed({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null });
    feed({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      parent_tool_use_id: null,
    });
    const out = feed({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'text', text: 'ok' },
        ],
      },
    });
    assert.deepEqual(out.map((e) => e.type), ['assistant_text']);
  });

  test('a forwarded subagent delta becomes subagent_text, not assistant_text', () => {
    // Text at depth >= 1 belongs to a nested agent. Lifting it to the top level would put a
    // subagent's words in the Commander's mouth on the org chart.
    const n = createClaudeNormalizer({ partialText: true });
    const feed = (value: unknown): SoldierEvent[] => n.next({ ok: true, index: 0, text: '', value });
    const out = feed({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub' } },
      parent_tool_use_id: 'toolu_parent',
      subagent_type: 'scout',
    });
    assert.equal(out[0]?.type, 'subagent_text');
    assert.equal(out[0]?.type === 'subagent_text' ? out[0].subagentType : null, 'scout');
    assert.equal(out[0]?.depth, 1);
  });
});

describe('claude normalizer / fixture claude-partial-abort.jsonl (interrupted MID-STREAM)', () => {
  const on = normalizeClaudeFixture('claude-partial-abort', true);
  const off = normalizeClaudeFixture('claude-partial-abort');

  test('a real mid-stream abort is still classified as an abort, not an error', () => {
    // The recorded result carries `subtype: error_during_execution, is_error: true,
    // terminal_reason: aborted_streaming` — the exact shape that used to be filed as a failure
    // and retried, re-running work a human deliberately stopped.
    const raw = on.find((e) => e.type === 'result')?.raw as Record<string, unknown>;
    assert.equal(raw['terminal_reason'], 'aborted_streaming');
    assert.equal(raw['is_error'], true);
    for (const events of [on, off]) {
      assert.equal(events.find((e) => e.type === 'result')?.status, 'interrupted');
    }
  });

  test('the record is coherent: what was streamed is what the aggregate holds', () => {
    // Measured on the real abort — the aggregate is TRUNCATED to what was already delivered, not
    // re-generated. So the transcript reads the same whether it was replayed from the deltas or
    // from the aggregate, and neither shows a word the soldier did not produce.
    assert.equal(renderedText(on), renderedText(off));
    assert.ok(renderedText(on).startsWith('The sea does not begin anywhere in particular'));
    assert.ok(renderedText(on).endsWith('the sea is simply the'), 'cut off mid-sentence');
  });

  test('the partial text survives the abort as three events, not one', () => {
    assert.equal(on.filter((e) => e.type === 'assistant_text').length, 3);
    assert.equal(off.filter((e) => e.type === 'assistant_text').length, 1);
  });

  test('there is no content_block_stop — the block was cut, and that is recorded', () => {
    const kinds = on
      .filter((e) => e.type === 'unknown')
      .map((e) => (e.type === 'unknown' ? e.harnessType : ''));
    assert.equal(kinds.includes('stream_event/content_block_stop'), false);
    assert.ok(kinds.includes('stream_event/message_start'));
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
    // This test was reported flaky (`close.status: 'error'` about 1 run in 3). It is not a race:
    // the adapter reports `error` here only via `silentlyDied()` — turns sent, no result seen —
    // and the fake reaches that state only when it is prevented from reporting. Two things could
    // prevent it, and both were in the FIXTURE, not the product: a half-written `fake-claude.mjs`
    // caught mid-save (a valid prefix of it runs, emits `system/init`, and exits 0 having never
    // installed its stdin handler), and the fixture's own `process.exit(0)` on stdin close, which
    // discarded a turn that was still in flight. The second is fixed; the first is why nothing
    // here waits on a clock any more.
    const soldier = await adapter.spawn(spec());
    const { all: events, results } = collectResults(soldier.stream(), 2);
    await soldier.send('first');
    await soldier.send('second');
    await results; // both turns have REPORTED — no sleep, so no unstated deadline
    const close = await soldier.close();
    const all = await events;

    assert.equal(close.exitCode, 0);
    assert.equal(close.status, 'ok');
    assert.ok((close.durationMs ?? 0) >= 0);

    // TWO turns, two results. This used to see one: the fake kept a single shared turn timer and
    // the second `send` overwrote the first's, so a test named "two turns" closed one.
    const costs = all.flatMap((e) => (e.type === 'result' ? [e.costUsd] : []));
    assert.deepEqual(costs, [0.25, 0.5], 'one result per turn, cumulative');
    // Cumulative, so the ledger takes the LAST value, not the sum of 0.25 + 0.50.
    assert.equal(close.costUsd, 0.5);

    const texts = all.filter((e) => e.type === 'assistant_text').map((e) => e.text);
    assert.deepEqual(texts, ['echo:first', 'echo:second']);
    assert.equal(all.filter((e) => e.type === 'ready').length, 1);
    assert.equal(all.at(-1)?.type, 'result');
  });

  test('closing stdin mid-turn does not lose the turn — the real CLI finishes it', async () => {
    // MEASURED against claude 2.1.221: a turn written and then followed IMMEDIATELY by
    // `stdin.end()` still produces its assistant message and its result before exiting 0.
    //
    // The fixture used to `process.exit(0)` the moment readline closed, throwing away a turn it
    // had accepted — which the adapter then reports, correctly, as a worker that did no work:
    // `exitCode: 0, status: 'error'`. That is the reported flake's exact signature, and it made
    // every send-then-close test carry a hidden timing budget. Measured at 28ms typical / 36ms
    // under an 8-way CPU load against the 250ms that test used to sleep — 7x margin, so it was
    // not firing, but the budget was real and nothing named it.
    const soldier = await adapter.spawn(spec());
    const events = collect(soldier.stream());
    await soldier.send('work please');
    const close = await soldier.close(); // NO sleep: close races the turn on purpose
    const all = await events;

    assert.equal(close.status, 'ok', 'a turn accepted is a turn reported');
    assert.equal(close.exitCode, 0);
    assert.equal(all.filter((e) => e.type === 'result').length, 1);
    assert.deepEqual(
      all.filter((e) => e.type === 'assistant_text').map((e) => e.text),
      ['echo:work please'],
    );
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

// =============================================================================================
// 4a2. token-level streaming, end to end through a real process
//
// The normalizer tests above run over recorded lines. These run the fake CLI, so the argv builder,
// `spawn`, the framer, the normalizer and the interrupt path are all on the wire together.
// =============================================================================================

describe('claude adapter / token-level streaming', { skip: WINDOWS ? 'POSIX shebang fakes' : false }, () => {
  const plain = createClaudeAdapter({ bin: FAKE_CLAUDE, closeGraceMs: 1500, killGraceMs: 500 });
  const partial = createClaudeAdapter({
    bin: FAKE_CLAUDE,
    closeGraceMs: 1500,
    killGraceMs: 500,
    partialMessages: true,
  });

  async function turn(adapter: HarnessAdapter, text: string): Promise<SoldierEvent[]> {
    const soldier = await adapter.spawn(spec());
    const events = collect(soldier.stream());
    await soldier.send(text);
    await new Promise((r) => setTimeout(r, 250));
    await soldier.close();
    return events;
  }

  test('PROCESS-LEVEL: the flag reaches the child only when asked for', async () => {
    // Asserting on `buildClaudeArgs` alone proves the pure function; this looks at execve.
    const off = await probeViaAdapter(plain, spec());
    assert.equal(off.argv.includes('--include-partial-messages'), false);
    const on = await probeViaAdapter(partial, spec());
    assert.ok(on.argv.includes('--include-partial-messages'));
  });

  test('ARMY_CLAUDE_PARTIAL=1 turns it on out of band, like ARMY_CLAUDE_BIN', async () => {
    const saved = process.env['ARMY_CLAUDE_PARTIAL'];
    process.env['ARMY_CLAUDE_PARTIAL'] = '1';
    try {
      const a = createClaudeAdapter({ bin: FAKE_CLAUDE, closeGraceMs: 1500, killGraceMs: 500 });
      const probe = await probeViaAdapter(a, spec());
      assert.ok(probe.argv.includes('--include-partial-messages'));
    } finally {
      if (saved === undefined) delete process.env['ARMY_CLAUDE_PARTIAL'];
      else process.env['ARMY_CLAUDE_PARTIAL'] = saved;
    }
    // ...and it is read at construction, so an adapter built without it stays without it.
    assert.equal(
      (await probeViaAdapter(plain, spec())).argv.includes('--include-partial-messages'),
      false,
    );
  });

  test('a reply arrives in pieces instead of one lump, and says itself once', async () => {
    const lumpy = await turn(plain, 'hello');
    const streamed = await turn(partial, 'hello');

    const said = (events: SoldierEvent[]): string[] =>
      events.flatMap((e) => (e.type === 'assistant_text' ? [e.text] : []));

    assert.deepEqual(said(lumpy), ['echo:hello'], 'today: one event, after the whole wait');
    assert.ok(said(streamed).length > 1, 'streamed text must arrive in more than one piece');
    // THE NO-DOUBLE-EMIT RULE, through a real process. The fake still emits the aggregate
    // `assistant` line after the deltas — because the real CLI does — so a consumer that
    // concatenates would show the reply twice if the rule were not enforced in the normalizer.
    assert.equal(said(streamed).join(''), 'echo:hello');
  });

  test('the aggregate line is still archived — only its text is deduplicated', async () => {
    const streamed = await turn(partial, 'hello');
    const marker = streamed.filter(
      (e) => e.type === 'unknown' && e.harnessType === 'assistant/text_streamed',
    );
    assert.equal(marker.length, 1);
    assert.equal((marker[0]?.raw as { type?: string }).type, 'assistant');
  });

  test('CONSUMERS MUST NOT CARE: the default stream is unchanged, event for event', async () => {
    // `army campaign`'s narration, `army view`, the archive writer and the org-chart tracking all
    // read this stream. With the flag off they must see exactly what they saw before — and the
    // fake reads the flag off its own argv, so this fails the moment the flag stops being opt-in.
    const before = await turn(plain, 'hello');
    assert.deepEqual(countTypes(before), { ready: 1, assistant_text: 1, result: 1 });
    assert.equal(
      before.some((e) => e.type === 'unknown' && (e.harnessType ?? '').startsWith('stream_event')),
      false,
    );
  });

  test('a turn interrupted MID-STREAM keeps the partial text and is filed as an abort', async () => {
    // `slow` streams its deltas across real time, so the interrupt lands BETWEEN two of them —
    // the state that reports `aborted_streaming` rather than `aborted_tools`, and the half that
    // was once misfiled as an error and retried.
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'abort-streaming';
    try {
      const soldier = await partial.spawn(spec());
      const events = collect(soldier.stream());
      await soldier.send('a long answer');
      await new Promise((r) => setTimeout(r, 200)); // mid-stream: some deltas, not all
      await soldier.interrupt();
      await new Promise((r) => setTimeout(r, 200));
      const close = await soldier.close();
      const all = await events;

      const result = all.find((e) => e.type === 'result');
      assert.equal(result?.status, 'interrupted', 'aborted_streaming is an abort, not an error');
      assert.equal((result?.raw as Record<string, unknown>)['terminal_reason'], 'aborted_streaming');
      assert.equal(close.status, 'interrupted');

      // A COHERENT RECORD. What survives is a prefix of the reply, said exactly once — not
      // nothing, and not the same words twice.
      const text = all
        .flatMap((e) => (e.type === 'assistant_text' ? [e.text] : []))
        .join('');
      assert.ok(text.length > 0, 'the words already produced are not thrown away');
      assert.ok('echo:a long answer'.startsWith(text), `a prefix of the reply, got ${text}`);
      assert.ok(text.length < 'echo:a long answer'.length, 'it really was cut short');
      assert.ok(all.some((e) => e.type === 'unknown' && e.harnessType === 'user/text'));
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }
  });

  test('BLOCKER: an abort mid-stream must not misfile the NEXT clean turn', async () => {
    // The leaked-flag inverse, now with a delta stream in the middle of it. This project shipped
    // the bug and then its inverse; a new event granularity must not reintroduce either.
    const soldier = await partial.spawn(spec());
    const events = collect(soldier.stream());
    await soldier.send('first');
    await new Promise((r) => setTimeout(r, 150)); // turn 1 completes; nothing is in flight
    await soldier.interrupt(); // no-op: receipt only, no result
    await new Promise((r) => setTimeout(r, 60));
    await soldier.send('second');
    await new Promise((r) => setTimeout(r, 150));
    const close = await soldier.close();
    const all = await events;

    assert.deepEqual(
      all.filter((e) => e.type === 'result').map((e) => e.status),
      ['ok', 'ok'],
      'neither turn was interrupted',
    );
    assert.equal(close.status, 'ok');
    assert.equal(
      all.flatMap((e) => (e.type === 'assistant_text' ? [e.text] : [])).join(''),
      'echo:firstecho:second',
    );
  });
});

// =============================================================================================
// 4b. THE FAKE'S OWN TEETH
//
// A fake that is kinder than the real thing is not a test double, it is a second implementation
// that always agrees with you. This one used to ignore `--allowedTools` / `--disallowedTools`
// completely and never populate `permission_denials`, and a worker that was denied its own
// worktree — every path tool refused, not one file created — passed 621 green tests.
//
// So these tests are about the DOUBLE, not the adapter: they check that the permission argv the
// adapter really emits actually constrains the process it is emitted to. `test/worktree.test.ts`
// spends that hostility on the end-to-end lockout; this section pins the matcher semantics the
// lockout test depends on, because a matcher that denies EVERYTHING would pass that test too.
// =============================================================================================

interface FakeWorkRun {
  events: SoldierEvent[];
  /** Tool names from `permission_denials`, in order. */
  denied: string[];
  /** Tool names whose `tool_result` came back clean. */
  used: string[];
  /** Tool names whose `tool_result` was an error but NOT a permission denial. */
  failed: string[];
}

describe('the fake claude CLI enforces the permission argv it is handed', { skip: WINDOWS ? 'POSIX shebang fakes' : false }, () => {
  const adapter = createClaudeAdapter({ bin: FAKE_CLAUDE, closeGraceMs: 2000, killGraceMs: 500 });

  function workDir(label: string): string {
    return nodeFs.mkdtempSync(join(realpathSync.native(tmpdir()), `army-work-${label}-`));
  }

  async function work(
    cwd: string,
    allow: string[],
    deny: string[],
    orders: string,
  ): Promise<FakeWorkRun> {
    const saved = process.env['FAKE_CLAUDE_MODE'];
    process.env['FAKE_CLAUDE_MODE'] = 'work';
    const events: SoldierEvent[] = [];
    try {
      const soldier = await adapter.spawn(spec({ cwd, allow, deny, orders }));
      let done: () => void = () => {};
      const finished = new Promise<void>((r) => (done = r));
      const pump = (async () => {
        for await (const event of soldier.stream()) {
          events.push(event);
          if (event.type === 'result') done();
        }
      })();
      await soldier.send(orders);
      await Promise.race([finished, new Promise((r) => setTimeout(r, 10_000))]);
      await soldier.close();
      await pump;
    } finally {
      if (saved === undefined) delete process.env['FAKE_CLAUDE_MODE'];
      else process.env['FAKE_CLAUDE_MODE'] = saved;
    }

    const names = new Map<string, string>();
    for (const e of events) if (e.type === 'tool_use') names.set(e.toolUseId, e.name);
    const results = events.filter(
      (e): e is Extract<SoldierEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    const denied = events
      .filter((e) => e.type === 'unknown' && e.harnessType === 'permission_denial')
      .map((e) => ((e as { raw?: unknown }).raw as { tool_name?: string }).tool_name ?? '?');
    const deniedIds = new Set(
      events
        .filter((e) => e.type === 'unknown' && e.harnessType === 'permission_denial')
        .map((e) => ((e as { raw?: unknown }).raw as { tool_use_id?: string }).tool_use_id ?? ''),
    );
    return {
      events,
      denied,
      used: results.filter((e) => !e.isError).map((e) => names.get(e.toolUseId) ?? '?'),
      failed: results
        .filter((e) => e.isError && !deniedIds.has(e.toolUseId))
        .map((e) => names.get(e.toolUseId) ?? '?'),
    };
  }

  test('with no permission argv it does real work — otherwise every assertion below is vacuous', async () => {
    const dir = workDir('unconstrained');
    const run = await work(dir, [], [], 'write out.txt hello\nread out.txt');

    assert.deepEqual(run.denied, []);
    assert.deepEqual(run.used, ['Write', 'Read']);
    assert.equal(nodeFs.readFileSync(join(dir, 'out.txt'), 'utf8'), 'hello\n');
    // The empty case belongs on the wire too. A consumer that only ever sees the key when it is
    // populated is a consumer whose empty branch was never exercised.
    const result = run.events.find((e) => e.type === 'result');
    assert.deepEqual((result as { raw?: Record<string, unknown> }).raw?.['permission_denials'], []);
  });

  test('deny beats allow, and a denied tool leaves the filesystem UNTOUCHED', async () => {
    const dir = workDir('deny-wins');
    const run = await work(
      dir,
      ['Read', 'Write'],
      [`Write(${dir}/**)`],
      'write blocked.txt nope\nread blocked.txt',
    );

    assert.deepEqual(run.denied, ['Write'], 'the deny rule must outrank the allow entry');
    assert.equal(
      nodeFs.existsSync(join(dir, 'blocked.txt')),
      false,
      'a denial that still writes the file proves nothing at all',
    );
    // The Read that follows fails on a missing file — an ordinary tool error, NOT a denial.
    assert.deepEqual(run.failed, ['Read']);
    assert.deepEqual(run.denied, ['Write'], 'an ENOENT must never be filed as a ceiling breach');
  });

  test('a non-empty allow-list is EXHAUSTIVE: a tool it does not name is refused', async () => {
    // This is what `--permission-mode dontAsk` means — there is nowhere to ask, so anything the
    // role loadout does not grant is simply refused. A fake that only honoured the deny-list
    // would model half the boundary and call it the whole one.
    const dir = workDir('allow-exhaustive');
    const run = await work(dir, ['Glob'], [], 'glob .\nwrite nope.txt x');

    assert.deepEqual(run.used, ['Glob']);
    assert.deepEqual(run.denied, ['Write']);
    assert.equal(nodeFs.existsSync(join(dir, 'nope.txt')), false);
  });

  test('rules are PATH-scoped, not tool-scoped — a sibling path is still writable', async () => {
    // The property that stops the lockout test passing for the wrong reason. If the fake refused
    // every Write whenever any Write rule existed, a totally-denied workspace and a correctly
    // scoped one would be indistinguishable.
    const dir = workDir('path-scope');
    const run = await work(
      dir,
      ['Write'],
      [`Write(${join(dir, 'nested')}/**)`],
      `write top.txt fine\nwrite ${join(dir, 'nested', 'deep', 'x.txt')} denied`,
    );

    assert.deepEqual(run.used, ['Write'], 'the unscoped sibling write must still land');
    assert.deepEqual(run.denied, ['Write'], 'and only the scoped one is refused');
    assert.equal(nodeFs.readFileSync(join(dir, 'top.txt'), 'utf8'), 'fine\n');
    assert.equal(nodeFs.existsSync(join(dir, 'nested', 'deep', 'x.txt')), false);
  });

  test('`**` spans separators and `*` does not — the two globs the deny-list is built from', async () => {
    const dir = workDir('glob-depth');
    nodeFs.mkdirSync(join(dir, 'a', 'b'), { recursive: true });

    const deep = await work(dir, ['Write'], [`Write(${dir}/**)`], `write ${join(dir, 'a', 'b', 'c.txt')} x`);
    assert.deepEqual(deep.denied, ['Write'], '`**` must reach an arbitrarily deep descendant');

    // `*` stops at one segment, so a nested path escapes a single-star rule. Pinned because
    // silently widening `*` to `**` would make every scoped rule in GLOBAL_DENY broader than the
    // real CLI applies it, and the fake would start failing runs the real thing allows.
    const shallow = await work(dir, ['Write'], [`Write(${dir}/*)`], `write ${join(dir, 'a', 'b', 'd.txt')} x`);
    assert.deepEqual(shallow.denied, []);
    assert.deepEqual(shallow.used, ['Write']);
  });

  test('$AGENTIC_ARMY_HOME in a rule is expanded from the environment the adapter forwarded', async () => {
    // `PROTECTED_CONFIG_GLOBS` ships the unexpanded spelling, and the adapter inherits the
    // supervisor's environment wholesale, so this is the form that actually reaches a worker
    // alongside the resolved one.
    const home = workDir('army-home');
    const tree = join(home, 'worktrees', 'cpt-01');
    nodeFs.mkdirSync(tree, { recursive: true });

    const saved = process.env['AGENTIC_ARMY_HOME'];
    process.env['AGENTIC_ARMY_HOME'] = home;
    try {
      const run = await work(tree, ['Write'], ['Write($AGENTIC_ARMY_HOME/**)'], 'write x.txt x');
      assert.deepEqual(run.denied, ['Write']);
      assert.equal(nodeFs.existsSync(join(tree, 'x.txt')), false);
    } finally {
      if (saved === undefined) delete process.env['AGENTIC_ARMY_HOME'];
      else process.env['AGENTIC_ARMY_HOME'] = saved;
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

  // -------------------------------------------------------------------------------------------
  // THE SANDBOX, RUN RATHER THAN DECLARED.
  //
  // `codexConfinement` sorts every deny rule into `enforced` or `unenforceable`, and the tests
  // below it assert on that classification — which is a claim about a region, checked by nothing
  // that ever tried to write to it. This is the codex-shaped half of the blindness that let a
  // completely denied claude worktree pass 621 green tests: a fake that never touches the disk
  // reports a clean run whatever its confinement says.
  // -------------------------------------------------------------------------------------------
  async function codexWork(cwd: string, deny: string[], orders: string): Promise<SoldierEvent[]> {
    const saved = process.env['FAKE_CODEX_MODE'];
    process.env['FAKE_CODEX_MODE'] = 'work';
    try {
      const soldier = await adapter.spawn(spec({ harness: 'codex', cwd, deny, orders }));
      const events = collect(soldier.stream());
      await soldier.send(orders);
      await soldier.close();
      return await events;
    } finally {
      if (saved === undefined) delete process.env['FAKE_CODEX_MODE'];
      else process.env['FAKE_CODEX_MODE'] = saved;
    }
  }

  /** `exit_code` of each `tool_result`, in order — 0 for a command the sandbox allowed. */
  function exitCodes(events: SoldierEvent[]): unknown[] {
    return events
      .filter((e) => e.type === 'tool_result')
      .map((e) => ((e as { raw?: unknown }).raw as { item?: { exit_code?: unknown } })?.item?.exit_code);
  }

  test('a codex worker CAN write inside its own workspace, and cannot write outside it', async () => {
    const base = realpathSync.native(nodeFs.mkdtempSync(join(tmpdir(), 'army-codex-work-')));
    const tree = join(base, 'tree');
    const home = join(base, 'army-home');
    nodeFs.mkdirSync(tree, { recursive: true });
    nodeFs.mkdirSync(home, { recursive: true });

    // The rule the confinement classifier calls `enforced`. This is the run that checks it.
    const deny = [`Write(${home}/**)`];
    const confinement = codexConfinement(spec({ harness: 'codex', cwd: tree, deny }), {});
    assert.deepEqual(confinement.breaches, [], 'precondition: the deny root is outside the tree');
    assert.deepEqual(confinement.enforced, deny, 'precondition: it is claimed to be enforced');

    const events = await codexWork(
      tree,
      deny,
      `write ${join(tree, 'work.txt')} inside\nwrite ${join(home, 'config.toml')} outside`,
    );

    assert.deepEqual(exitCodes(events), [0, 1], 'the workspace write lands, the outside one does not');
    assert.equal(nodeFs.readFileSync(join(tree, 'work.txt'), 'utf8'), 'inside\n');
    assert.equal(
      nodeFs.existsSync(join(home, 'config.toml')),
      false,
      'a refused write must touch nothing — `enforced` has to mean the file is not there',
    );
  });

  test('reads are NOT confined, and the fake must not pretend otherwise', async () => {
    // The measured asymmetry: `-s workspace-write` is a WRITE sandbox and a codex worker read a
    // decoy private key. A fake that confined reads would certify a protection this harness does
    // not provide — the expensive direction of wrong, because a read of a credential IS the
    // exfiltration. This test exists so that "unenforceable" stays a demonstrated fact.
    const base = realpathSync.native(nodeFs.mkdtempSync(join(tmpdir(), 'army-codex-read-')));
    const tree = join(base, 'tree');
    const secret = join(base, 'secrets', 'id_rsa');
    nodeFs.mkdirSync(tree, { recursive: true });
    nodeFs.mkdirSync(dirname(secret), { recursive: true });
    nodeFs.writeFileSync(secret, 'PRIVATE KEY\n');

    const deny = [`Read(${dirname(secret)}/**)`, `Write(${dirname(secret)}/**)`];
    const confinement = codexConfinement(spec({ harness: 'codex', cwd: tree, deny }), {});
    assert.deepEqual(confinement.unenforceable, [deny[0]], 'the read deny cannot be expressed');

    const events = await codexWork(tree, deny, `read ${secret}`);
    assert.deepEqual(exitCodes(events), [0], 'the read succeeds, outside every writable root');
    const output = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => ((e as { raw?: unknown }).raw as { item?: { aggregated_output?: string } })?.item?.aggregated_output);
    assert.deepEqual(output, ['PRIVATE KEY\n']);
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

  /**
   * THE INSPECTOR'S BLINDNESS.
   *
   * `-s workspace-write` denies `listen`. Campaign of 2026-08-07: 50 `EPERM ... syscall: 'listen'`
   * failures in one reviewer's stream, on all three review attempts, because the suite under
   * review binds 127.0.0.1 — so the campaign's headline end-to-end criterion was never executed by
   * any reviewer, and all three still returned `testsRun: true`.
   *
   * Both directions are pinned, and the `guarded` half matters as much as the fix: the flag is
   * emitted EXPLICITLY either way, so a user's `config.toml` cannot widen a guarded run or narrow
   * an unguarded one. The value is read off `networkAccess` rather than grepped out of `args`,
   * and then `args` is checked separately — a test that only asserted the boolean would pass
   * while the flag went missing from execve.
   */
  test('the codex sandbox opens the network under `unguarded` and pins it shut under `guarded`', () => {
    const cwd = '/work/tree';

    const guarded = codexConfinement(spec({ harness: 'codex', cwd, posture: 'guarded' }), ENV, HOME);
    assert.equal(guarded.networkAccess, false);
    assert.ok(
      guarded.args.includes('sandbox_workspace_write.network_access=false'),
      `guarded did not pin the flag shut:\n${guarded.args.join(' ')}`,
    );

    const unguarded = codexConfinement(spec({ harness: 'codex', cwd, posture: 'unguarded' }), ENV, HOME);
    assert.equal(unguarded.networkAccess, true);
    assert.ok(
      unguarded.args.includes('sandbox_workspace_write.network_access=true'),
      `unguarded did not open the network:\n${unguarded.args.join(' ')}`,
    );

    // ABSENT means SHUT. `SoldierSpec.posture` is optional so that a call site which has never
    // heard of the posture builds a confined worker, and this is that polarity on the wire.
    const silent = codexConfinement(spec({ harness: 'codex', cwd }), ENV, HOME);
    assert.equal(silent.networkAccess, false, 'a spec with no posture opened the network');

    // Opening the network changes the NETWORK and nothing else — the write sandbox is the reason
    // a leased worktree is an isolation boundary, and it is not part of this trade.
    assert.deepEqual(unguarded.writableRoots, guarded.writableRoots);
    assert.deepEqual(unguarded.breaches, guarded.breaches);
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
