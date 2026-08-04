#!/usr/bin/env node
/**
 * A stand-in for `claude -p --input-format stream-json`, so the adapter's lifecycle, resilience
 * and control-channel behaviour can be tested without spending quota or waiting on a model.
 *
 * It speaks the real wire format (recorded in ../fixtures/claude-duplex.jsonl). Behaviour is
 * selected with FAKE_CLAUDE_MODE:
 *
 *   ok              init, then echo + result per user turn        (default)
 *   noise           a non-JSON warning on stdout before real events
 *   partial         a truncated final line, then exit             (killed-child simulation)
 *   crash           init, then exit(3)
 *   no-interrupt    init WITHOUT interrupt_receipt_v1
 *   interrupt-error control_response with subtype:error
 *   deaf            ignores stdin close and SIGTERM               (close-escalation test)
 *   slow            turn stays in flight ~5s                      (mid-turn interrupt window)
 *   silent          accepts the turn, emits NOTHING, exits 0      (silent-death test)
 *   abort-streaming interrupt answered with terminal_reason:aborted_streaming
 *   abort-unknown   interrupt answered with an unrecognised terminal_reason
 *
 * ==========================================================================================
 * KNOWN DIVERGENCES FROM THE REAL CLI — a fake must never be more forgiving than the real thing.
 *
 * A fake that is MORE FORGIVING than the real thing hides the bugs it exists to catch. Not
 * hypothetical: this file used to answer EVERY `control_request` with a `result`, which
 * silently cleared the adapter's interrupt flag and let a real leak pass 135 green tests.
 * Each remaining gap is listed so the next person knows what this fake does NOT prove.
 * Close one, or add to the list — never leave one undocumented.
 *
 *   FIXED  a control_request with NO turn in flight now sends the receipt and no result,
 *          matching the real CLI. This is the one that bit us.
 *   FIXED  turns occupy time, so `turnInFlight` is a real state rather than a fiction.
 *
 *   OPEN 1 `system/init` is emitted once; the real CLI re-emits it at the start of every turn.
 *          Covered instead by claude-duplex.jsonl, which contains 3.
 *   OPEN 2 No `thinking` blocks, `system/thinking_tokens` or `rate_limit_event`. Covered by
 *          the recorded fixtures, not here.
 *   OPEN 3 No tool_use/tool_result cycle and no subagent forwarding. Covered by
 *          claude-subagent.jsonl.
 *   OPEN 4 `permission_denials` is never populated; covered by a normalizer unit test.
 *   OPEN 5 `still_queued` is always []; `interrupt_cancel_queued_v1` semantics are not
 *          modelled AT ALL, so queued-message cancellation is untested everywhere.
 *   OPEN 6 Costs are exact multiples of 0.25 and usage is constant — realistic in SHAPE
 *          (cumulative) but not in value.
 *   OPEN 7 Never emits `error_max_turns` / `budget_exhausted`; those exist only as pure
 *          `claudeResultStatus` unit tests.
 * ==========================================================================================
 */

import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const mode = process.env['FAKE_CLAUDE_MODE'] ?? 'ok';
const argv = process.argv.slice(2);
const sessionIdIndex = argv.indexOf('--session-id');
const sessionId = sessionIdIndex === -1 ? 'no-session' : (argv[sessionIdIndex + 1] ?? 'no-session');

const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// Record the argv and environment THIS PROCESS ACTUALLY RECEIVED. The auth guards assert on this
// file, not on what buildClaudeArgs returned — the point is to check what reached execve.
process.stderr.write('ARGV ' + JSON.stringify(argv) + '\n');
if (process.env['FAKE_PROBE_FILE']) {
  writeFileSync(
    process.env['FAKE_PROBE_FILE'],
    JSON.stringify({
      argv,
      env: {
        ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] ?? null,
        ANTHROPIC_AUTH_TOKEN: process.env['ANTHROPIC_AUTH_TOKEN'] ?? null,
        CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] ?? null,
      },
    }),
  );
}

say({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  cwd: process.cwd(),
  capabilities: mode === 'no-interrupt' ? [] : ['interrupt_receipt_v1', 'msg_lifecycle_v1'],
});

if (mode === 'noise') {
  process.stdout.write('(node:1) Warning: a stray line on stdout that is not JSON\n');
  process.stdout.write('\n');
  say({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'survived-the-noise' }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
  process.exit(0);
}

if (mode === 'crash') process.exit(3);

if (mode === 'partial') {
  process.stdout.write('{"type":"assistant","message":{"role":"assis');
  process.exit(0);
}

if (mode === 'deaf') process.on('SIGTERM', () => {});

let turn = 0;
/** Whether a turn is running — the state the real CLI has and this fake used to pretend away. */
let turnInFlight = false;
let turnTimer;
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (line.trim() === '') return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.type === 'control_request') {
    if (mode === 'interrupt-error') {
      say({
        type: 'control_response',
        response: { subtype: 'error', request_id: msg.request_id, error: 'refused by the fake' },
      });
      return;
    }

    // Always acknowledge. This half is unconditional in the real CLI too.
    say({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } },
    });

    // ---------------------------------------------------------------------------------------
    // THE DIVERGENCE THAT HID A BUG.
    //
    // This fake used to emit a `result` after EVERY control_request. The real CLI does not: with
    // no turn in flight there is nothing to abort, so it sends the receipt and stops. Because the
    // fake always sent a result, the adapter's `interruptPending` flag was always cleared — and
    // 135 green tests sailed past a leak that misfiled the next clean turn as `interrupted`.
    //
    // A fake more forgiving than reality hides exactly the bug it exists to catch.
    // ---------------------------------------------------------------------------------------
    if (!turnInFlight) return;

    clearTimeout(turnTimer);
    turnInFlight = false;
    say({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      // `aborted_streaming` is the half the first version of the adapter misfiled as `error`.
      terminal_reason:
        mode === 'abort-streaming'
          ? 'aborted_streaming'
          : mode === 'abort-unknown'
            ? 'stopped_by_the_future'
            : 'aborted_tools',
      stop_reason: 'tool_use',
      session_id: sessionId,
      duration_ms: 11,
      total_cost_usd: 0.5,
    });
    return;
  }

  if (msg.type === 'user') {
    if (mode === 'silent') {
      // Accepts the work, produces nothing, exits successfully. The shape of a worker that dies
      // without noticing — and is ledgered as a success unless the adapter catches it.
      process.exit(0);
    }
    turn += 1;
    const text = msg.message?.content?.[0]?.text ?? '';
    say({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
      parent_tool_use_id: null,
      session_id: sessionId,
      timestamp: '2026-08-02T00:00:00.000Z',
    });

    // A turn OCCUPIES TIME, as it does in reality. Without this there is no window in which an
    // interrupt can land mid-turn, so `slow` is what the abort tests drive; `ok` finishes promptly
    // but still asynchronously, so `turnInFlight` is a real state rather than a fiction.
    turnInFlight = true;
    const finish = () => {
      if (!turnInFlight) return;
      turnInFlight = false;
      say({
        type: 'result',
        subtype: 'success',
        is_error: false,
        terminal_reason: 'completed',
        session_id: sessionId,
        duration_ms: 5,
        // Cumulative, exactly like the real CLI.
        total_cost_usd: turn * 0.25,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      });
    };
    turnTimer = setTimeout(finish, mode === 'slow' || mode === 'abort-streaming' || mode === 'abort-unknown' ? 5000 : 5);
  }
});

rl.on('close', () => {
  if (mode === 'deaf') setInterval(() => {}, 1000);
  else process.exit(0);
});
