#!/usr/bin/env node
/**
 * A stand-in for `codex exec --json`.
 *
 * Its most important job is proving that the adapter spawned it with stdin IGNORED. `codex exec`
 * hangs forever on an open stdin pipe (0 bytes out, no error, no timeout), so this fake stats fd 0
 * and reports whether it is a FIFO. The test asserts it is not — that is the regression guard on
 * the single most expensive mistake in this module.
 *
 * FAKE_CODEX_MODE:
 *   ok      thread.started -> command_execution -> agent_message -> turn.completed, writes -o
 *   fail    thread.started -> error -> turn.failed, exit 1, does NOT write -o (real behaviour)
 *   silent  exit 0 immediately, no events at all, no -o          (silent-death test)
 *   no-output  a full successful run (incl. turn.completed) that never writes -o
 *   partial thread.started + agent_message, then exit 0 with NO turn.completed and NO -o
 */

import { fstatSync, writeFileSync } from 'node:fs';

const mode = process.env['FAKE_CODEX_MODE'] ?? 'ok';
const argv = process.argv.slice(2);
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

process.stderr.write('ARGV ' + JSON.stringify(argv) + '\n');
process.stderr.write('CODEX_HOME ' + JSON.stringify(process.env['CODEX_HOME'] ?? null) + '\n');
// Record what THIS PROCESS ACTUALLY RECEIVED, so the auth guard asserts on execve reality rather
// than on the return value of a pure function.
if (process.env['FAKE_PROBE_FILE']) {
  writeFileSync(
    process.env['FAKE_PROBE_FILE'],
    JSON.stringify({
      argv,
      env: {
        CODEX_HOME: process.env['CODEX_HOME'] ?? null,
        OPENAI_API_KEY: process.env['OPENAI_API_KEY'] ?? null,
        OPENAI_BASE_URL: process.env['OPENAI_BASE_URL'] ?? null,
      },
    }),
  );
}
if (mode === 'silent') process.exit(0);
// The real CLI writes this to stderr even on a clean run. Non-empty stderr is not a failure.
process.stderr.write('Reading additional input from stdin...\n');

let stdinKind = 'unknown';
try {
  const st = fstatSync(0);
  stdinKind = st.isFIFO() ? 'fifo' : st.isCharacterDevice() ? 'chardev' : st.isFile() ? 'file' : 'other';
} catch (err) {
  stdinKind = `error:${err.code ?? 'unknown'}`;
}
process.stderr.write('STDIN_KIND ' + stdinKind + '\n');

say({ type: 'thread.started', thread_id: '019fc000-0000-7000-8000-00000000fake' });

if (mode === 'partial') {
  say({ type: 'turn.started' });
  say({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'half a thought' } });
  process.exit(0);
}

if (mode === 'fail') {
  say({ type: 'turn.started' });
  say({ type: 'error', message: '{"type":"error","status":400}' });
  say({ type: 'turn.failed', error: { message: '{"type":"error","status":400}' } });
  process.exit(1);
}

const outIndex = argv.indexOf('-o');
const outPath = outIndex === -1 ? null : argv[outIndex + 1];
const payload = JSON.stringify({
  verdict: 'pass',
  summary: `stdin was ${stdinKind}`,
  findings: [],
  testsRun: ['fake'],
});

say({ type: 'turn.started' });
say({
  type: 'item.started',
  item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: null, status: 'in_progress' },
});
say({
  type: 'item.completed',
  item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: 'calc.py\n', exit_code: 0, status: 'completed' },
});
say({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: payload } });
say({
  type: 'turn.completed',
  usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 2 },
});

// `no-output`: a run that reaches turn.completed but never produces the demanded artifact.
if (mode !== 'no-output' && outPath !== null && outPath !== undefined) writeFileSync(outPath, payload);
process.exit(0);
