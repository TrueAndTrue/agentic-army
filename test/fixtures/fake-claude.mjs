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
 *   work            USES TOOLS on its cwd, under the permission rules it was actually handed
 *   fanout          FIELDS NATIVE SUBAGENTS off its `--agents` roster, nested and forwarded
 *   start-flow      STARTS the `army` MCP server from `--mcp-config` and calls its start_flow tool
 *                   with the turn's text as the objective (flow from FAKE_FLOW, else the first)
 *
 * `--include-partial-messages` is orthogonal to the mode and is read off THIS PROCESS'S argv,
 * like the permission rules: token-level `stream_event` lines are emitted only if the adapter
 * actually asked for them.
 *
 * ==========================================================================================
 * WHAT THIS FAKE MODELS, AND WHAT IT DOES NOT — a fake must never be more forgiving than the
 * real thing.
 *
 * A fake that is MORE FORGIVING than the real thing hides the bugs it exists to catch. Not
 * hypothetical, twice over:
 *
 *   - this file used to answer EVERY `control_request` with a `result`, which silently cleared
 *     the adapter's interrupt flag and let a real leak pass 135 green tests;
 *   - this file used to ignore `--allowedTools` / `--disallowedTools` entirely and never
 *     populate `permission_denials`. A worker was provisioned a worktree it was completely
 *     denied — Read, Grep, Glob, Write and Edit all refused, not one file created — and 621
 *     tests were green. The permission tests asserted the deny globs were EMITTED. Nothing
 *     asserted a worker could still WORK with them applied.
 *
 * Each remaining gap is listed so the next person knows what this fake does NOT prove.
 * Close one, or add to the list — never leave one undocumented.
 *
 * ---- MODELLED -----------------------------------------------------------------------------
 *
 *   PERMISSIONS. `--allowedTools` / `--disallowedTools` are parsed off THIS PROCESS'S OWN argv
 *   and enforced on Read, Grep, Glob, Write and Edit in `work` mode. Deny beats allow; a
 *   non-empty allow-list is exhaustive, so a tool named by neither list is refused, which is
 *   what `--permission-mode dontAsk` does. A refusal emits the real three-part shape — an
 *   assistant `tool_use`, a `tool_result` with `is_error: true`, and an entry in
 *   `permission_denials` on the result line — and, crucially, does NOT touch the filesystem.
 *   So a worker denied its own workspace produces no files, exactly as it did in the field.
 *
 *   PATH SCOPING. `Tool(<glob>)` patterns are matched against the resolved target: `**` spans
 *   separators, `*` and `?` do not, `~` expands to the home directory and
 *   `$AGENTIC_ARMY_HOME` to the environment the adapter forwarded. A bare `Tool` with no
 *   parentheses matches any input. Targets are matched in BOTH their resolved and their
 *   realpath'd spelling, because `/tmp` and `/private/tmp` are one directory with two names
 *   and a guard that compares only one of them fails open.
 *
 *   NATIVE SUBAGENTS, in `fanout` mode, measured against claude 2.1.221 on 2026-08-04 with a live
 *   parent and a live subordinate. The roster is parsed off `--agents` on THIS PROCESS'S argv and
 *   every one of these was watched on a real stream before being reproduced here:
 *
 *     - a subordinate's declared `tools` list is its ACTUAL loadout, not a hint. One declared
 *       without `Write` reported holding no such tool while its parent held `Write` throughout,
 *       so a tool the roster did not name is refused here with NO rule attributed — there is no
 *       rule, the tool is simply absent.
 *     - the session's deny rules are INHERITED. A subordinate hit the credential deny and was told
 *       the path was denied by permission settings, so the global deny holds at depth 2.
 *     - the session's allow rules are inherited too: a subordinate under `Bash(echo:*)` was
 *       refused `curl`. A subagent's permission is the INTERSECTION of its declared list and the
 *       session rules, and that is what `subagentActor` computes.
 *     - the spawn is gated by the DENY half ONLY. Naming an agent type on the allow half does not
 *       restrict types — a parent whose only spawn rules were `Agent(<declared type>)` spawned a
 *       built-in `general-purpose` anyway. This fake does NOT gate the spawn on the allow list,
 *       deliberately, even though doing so would be harsher: harshness here would hide the hole,
 *       by letting a test pass on a mechanism that does not exist in the field.
 *     - `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is a HARD bound. At the cap the real CLI does not
 *       refuse the spawn, it removes the spawn tools from the subordinate's loadout, so there is
 *       nothing to attempt. Read off the environment, never assumed.
 *
 *   Forwarded lines carry `parent_tool_use_id` AND a top-level `subagent_type`, which is the shape
 *   `--forward-subagent-text` actually delivers and what the normalizer reconstructs depth from.
 *
 *   A control_request with NO turn in flight sends the receipt and no result, matching the real
 *   CLI. That is the one that bit us. Turns occupy time and QUEUE, so "a turn is running" is a
 *   real state rather than a fiction, and two turns produce two results.
 *
 *   STDIN CLOSING IS NOT AN ABORT. Measured: a turn written and then followed immediately by
 *   `stdin.end()` still produces its assistant message and its result before the real CLI exits
 *   0. See the `rl.on('close')` handler for what this file used to do instead, and what that
 *   cost.
 *
 *   PARTIAL MESSAGES, recorded from claude 2.1.221 on 2026-08-03 and reproduced exactly,
 *   INCLUDING THE TRAP. `--include-partial-messages` is purely ADDITIVE upstream: the same turn
 *   run with and without it produces byte-identical `assistant` / `user` / `result` lines, and
 *   the flag only interleaves extra `stream_event` lines. So the aggregate `assistant` message
 *   STILL CARRIES THE WHOLE TEXT after the deltas have already delivered it, and a fake that
 *   emitted only the deltas would hide every double-render bug there is. It is emitted here,
 *   in the measured position — after the last delta of the block and BEFORE that block's
 *   `content_block_stop`.
 *
 *   INTERRUPTED MID-STREAM. Measured: the aggregate that lands after a mid-stream abort is
 *   byte-identical to the deltas delivered so far — truncated, not re-generated — there is no
 *   `content_block_stop`, a `[Request interrupted by user]` user line follows, and the result
 *   reports `aborted_streaming`. All four are reproduced.
 *
 * ---- NOT MODELLED -------------------------------------------------------------------------
 *
 *   1 `system/init` is emitted once; the real CLI re-emits it at the start of every turn.
 *     Covered instead by claude-duplex.jsonl, which contains 3.
 *   2 No `thinking` blocks, `system/thinking_tokens` or `rate_limit_event`. Covered by the
 *     recorded fixtures, not here.
 *   3 `work` mode runs tools at depth 0 only. `fanout` mode is the one that nests — see the
 *     MODELLED entry above it. Neither mode reproduces a THREE-level chain from a live recording;
 *     claude-subagent.jsonl remains the fixture for that.
 *   4 `Bash(prefix:*)` rules are PARSED but never exercised — this fake runs no commands, so a
 *     command allow-list is asserted on argv and nowhere else. The path tools are the half
 *     that governs whether a worker can use its workspace, and they are the half enforced here.
 *   5 The matcher is deliberately CRUDER and slightly HARSHER than the real one: `**` matches
 *     dotfiles, and a rule whose `$AGENTIC_ARMY_HOME` is unset matches nothing rather than
 *     guessing. Harsher in a fake costs a false alarm; kinder costs a shipped lockout. Do not
 *     "fix" this by making it more permissive.
 *   6 Only tools in `work` mode go through the check. Every other mode calls no tools at all,
 *     so its permission argv is inert — a test that wants the boundary exercised must ask for
 *     `work`.
 *   7 `still_queued` is always [], so `interrupt_cancel_queued_v1` is untested everywhere. Turns
 *     DO queue now and each reports its own result, but an interrupt cancels the lot and reports
 *     one abort rather than naming the survivors.
 *   8 Costs are exact multiples of 0.25 and usage is constant — realistic in SHAPE
 *     (cumulative) but not in value.
 *   9 Never emits `error_max_turns` / `budget_exhausted`; those exist only as pure
 *     `claudeResultStatus` unit tests.
 *  10 No `thinking_delta` partials, because there are no `thinking` blocks to partial (gap 2).
 *     `content_block_delta` carrying `delta.thinking` is covered by claude-partial.jsonl.
 *  11 The `[Request interrupted by user]` user line is emitted only on the partial-message
 *     abort path, which is the one measured fresh. The non-partial abort path still omits it;
 *     claude-abort-streaming.jsonl is what covers it there.
 * ==========================================================================================
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const mode = process.env['FAKE_CLAUDE_MODE'] ?? 'ok';
const argv = process.argv.slice(2);
const sessionIdIndex = argv.indexOf('--session-id');
const sessionId = sessionIdIndex === -1 ? 'no-session' : (argv[sessionIdIndex + 1] ?? 'no-session');

const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

/**
 * The desktop app's flow drafter, known by the first line of its system text. Whatever the mode,
 * it gets what the real model would send: a question until the prompt holds two answers, then a
 * small flow whose summary repeats the last answer, so a test can see its answers went through.
 */
const appendAt = argv.indexOf('--append-system-prompt');
const drafting = appendAt !== -1 && (argv[appendAt + 1] ?? '').startsWith('You draft flows for Agentic Army');

function draftReply(text) {
  const answers = [...text.matchAll(/^\s*A: (.*)$/gm)].map((m) => m[1]);
  if (answers.length === 0) {
    return `I need to know the kind of work first.\n\n${JSON.stringify({
      kind: 'question',
      question: 'What kind of work is this?',
      why: 'It decides which agents the flow needs.',
      options: [{ label: 'Fix a bug', detail: 'Something is broken and needs a tested fix' }, { label: 'Build a feature' }, { label: 'Answer a question' }],
      multi: false,
      understanding: 'You want a flow for the objective you gave.',
    })}`;
  }
  if (answers.length === 1) {
    return '```json\n' + JSON.stringify({
      kind: 'question',
      question: 'How should the work be checked?',
      why: 'This decides whether the flow loops.',
      options: [{ label: 'Run the tests' }, { label: 'A reviewer agent' }],
      multi: true,
      understanding: `The work is: ${answers[0]}.`,
    }) + '\n```';
  }
  return `Here is the flow.\n${JSON.stringify({
    kind: 'flow',
    name: 'Fix with tests',
    description: 'A bug fixed on its own branch, with the tests run until they pass.',
    summary: `Built from your answers: ${answers.join(' / ')}.`,
    nodes: [
      { id: 'start', type: 'start', label: 'Start' },
      { id: 'fix', type: 'agent', label: 'Fix the bug', role: 'engineer', keepContext: true, prompt: 'Fix: {{objective}}\n\n{{nodes.run_tests}}' },
      { id: 'tests', type: 'shell', label: 'Run tests', command: 'npm test', maxVisits: 3 },
      { id: 'done', type: 'end', label: 'Done', template: '{{nodes.fix_the_bug}}' },
    ],
    edges: [['start', 'out', 'fix'], ['fix', 'out', 'tests'], ['tests', 'pass', 'done'], ['tests', 'fail', 'fix']],
  })}`;
}

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

// ============================================================================================
// THE PERMISSION MODEL
//
// Read off argv, not off an environment variable a test could set to something the adapter
// never actually passed. The whole point is that what constrains this process is what reached
// execve — if `buildClaudeArgs` stops emitting a rule, the rule stops being enforced here too,
// and the test that depended on it goes red.
// ============================================================================================

/**
 * The values of a variadic flag: everything up to the next `--flag`.
 *
 * Safe because no rule may begin with `-` — both `buildClaudeArgs` and `assertNoFlagLikeRules`
 * refuse one, precisely because a rule that looks like a flag becomes a real flag here.
 */
function flagList(name) {
  const at = argv.indexOf(name);
  if (at === -1) return [];
  const out = [];
  for (let i = at + 1; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (token.startsWith('--')) break;
    out.push(token);
  }
  return out;
}

const allowRules = flagList('--allowedTools');
const denyRules = flagList('--disallowedTools');

/**
 * `start-flow` mode: behave as claude does with an MCP server. Start it from the inline
 * `--mcp-config` exactly as configured (command, args, env), speak JSON-RPC to it on stdio, and
 * call `start_flow`. Refused, as `--permission-mode dontAsk` would, unless `mcp__army` is allowed.
 */
async function callStartFlow(objective) {
  const at = argv.indexOf('--mcp-config');
  if (at === -1) return 'start_flow is not available: no --mcp-config.';
  if (!allowRules.includes('mcp__army') || denyRules.includes('mcp__army')) return 'start_flow was denied: mcp__army is not allowed.';
  const server = JSON.parse(argv[at + 1]).mcpServers.army;
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  let next = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    for (let k = buf.indexOf('\n'); k >= 0; k = buf.indexOf('\n')) {
      const line = buf.slice(0, k).trim();
      buf = buf.slice(k + 1);
      if (line === '') continue;
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
    }
  });
  const rpc = (method, params) =>
    new Promise((res) => {
      next += 1;
      waiting.set(next, res);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
    });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
    const list = await rpc('tools/list', {});
    const tool = list.result.tools.find((t) => t.name === 'start_flow');
    if (tool === undefined) return `start_flow is not listed; the tools are: ${list.result.tools.map((t) => t.name).join(', ') || 'none'}.`;
    const flow = process.env['FAKE_FLOW'] ?? tool.inputSchema.properties.flow.enum[0];
    const res = await rpc('tools/call', { name: 'start_flow', arguments: { flow, objective, why: 'The fake agent was told to.' } });
    return `${res.result.isError ? 'ERROR ' : ''}${res.result.content[0].text}`;
  } finally {
    child.stdin.end();
    child.kill();
  }
}

/**
 * Token-level streaming, read off argv for the same reason the permission rules are: if
 * `buildClaudeArgs` stops emitting the flag, this process stops emitting partials, and the test
 * that depended on them goes red instead of passing on a fiction.
 */
const partialMessages = argv.includes('--include-partial-messages');

const RULE_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\(([\s\S]*)\))?$/;

/**
 * Canonical spelling of a path that may not exist yet: realpath the deepest existing ancestor
 * and re-append the tail. `/tmp` IS `/private/tmp` on macOS, so a lease under one spelling and
 * a deny root under the other are the same directory — and a matcher that compares strings
 * calls them unrelated, which is a guard that fails open in the permissive direction.
 */
function canonical(target) {
  let current = resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Every spelling a rule might legitimately be written against. */
function spellings(target) {
  const abs = isAbsolute(target) ? resolve(target) : resolve(process.cwd(), target);
  const real = canonical(abs);
  return real === abs ? [abs] : [abs, real];
}

/**
 * `~` and `$AGENTIC_ARMY_HOME` expanded, or `null` when the variable is not in this process's
 * environment. Null means "matches nothing": guessing at an unset home would invent a boundary
 * the real CLI does not have.
 */
function expandPattern(pattern) {
  let out = pattern;
  if (out === '~' || out.startsWith('~/')) out = homedir() + out.slice(1);
  if (out.includes('$AGENTIC_ARMY_HOME')) {
    const home = process.env['AGENTIC_ARMY_HOME'];
    if (home === undefined || home === '') return null;
    out = out.split('$AGENTIC_ARMY_HOME').join(home);
  }
  return out;
}

/** `**` spans separators; `*` and `?` stop at one. Everything else is a literal. */
function globToSource(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

function patternMatches(pattern, candidates) {
  const expanded = expandPattern(pattern);
  if (expanded === null) return false;
  // A pattern with no leading `/` names a shape anywhere in the tree — `**&#47;.env` is a
  // filename rule, not a region rule, and the real CLI treats it as one.
  const anchored = expanded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(expanded);
  const re = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globToSource(expanded)}$`);
  return candidates.some((candidate) => re.test(candidate));
}

function ruleMatches(rule, tool, candidates) {
  const parsed = RULE_RE.exec(rule.trim());
  if (parsed === null) return false;
  if (parsed[1] !== tool) return false;
  // A bare `Read` with no parentheses is the tool itself, on any input.
  if (parsed[2] === undefined) return true;
  return patternMatches(parsed[2], candidates);
}

/**
 * Deny beats allow. A non-empty allow-list is EXHAUSTIVE — anything it does not name is
 * refused, because `--permission-mode dontAsk` has nowhere to ask. An empty allow-list means
 * no allow-list was passed at all, which is unconstrained; that is what keeps every existing
 * lifecycle test, none of which passes permission argv, behaving as it did.
 */
function decide(tool, target) {
  const candidates = spellings(target);
  for (const rule of denyRules) {
    if (ruleMatches(rule, tool, candidates)) return { allowed: false, rule };
  }
  if (allowRules.length === 0) return { allowed: true, rule: null };
  for (const rule of allowRules) {
    if (ruleMatches(rule, tool, candidates)) return { allowed: true, rule };
  }
  return { allowed: false, rule: null };
}

// ============================================================================================
// TOOL USE — only in `work` mode
// ============================================================================================

/** Denials accrued this turn. Drained onto the result line, as the real CLI does. */
let denials = [];
let toolSeq = 0;

function emitToolUse(name, input, parentToolUseId = null) {
  toolSeq += 1;
  const id = `toolu_fake${String(toolSeq).padStart(4, '0')}`;
  say({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: parentToolUseId,
    session_id: sessionId,
  });
  return id;
}

function emitToolResult(id, content, isError, parentToolUseId = null) {
  say({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }],
    },
    parent_tool_use_id: parentToolUseId,
    session_id: sessionId,
  });
}

/**
 * One tool call, permission-checked. `perform` runs ONLY if the call is allowed — a denied tool
 * must leave the filesystem untouched, or the fake would be proving the opposite of the thing
 * it is here to prove.
 */
function useTool(name, input, target, perform, actor = TOP_LEVEL) {
  const id = emitToolUse(name, input, actor.parentToolUseId);
  const verdict = actor.decide(name, target);
  if (!verdict.allowed) {
    denials.push({ tool_name: name, tool_use_id: id, tool_input: input });
    emitToolResult(
      id,
      verdict.rule === null
        ? `Claude requested permissions to use ${name}, but you haven't granted it yet.`
        : `Permission to use ${name} has been denied by the rule ${verdict.rule}.`,
      true,
      actor.parentToolUseId,
    );
    return null;
  }
  try {
    const content = perform();
    emitToolResult(id, content, false, actor.parentToolUseId);
    return content;
  } catch (error) {
    // A real filesystem error is NOT a permission denial and must not be filed as one.
    emitToolResult(id, `Error: ${error?.message ?? String(error)}`, true, actor.parentToolUseId);
    return null;
  }
}

/**
 * Who is making a tool call: the worker process itself, or one of its native subagents.
 *
 * `decide` is per-actor because the two are NOT the same function. The process is bound by the
 * session's allow/deny rules alone. A subagent is bound by those rules AND by the tool-name list
 * its `--agents` entry declared — measured on claude 2.1.221, that declared list is its ACTUAL
 * loadout, not a hint: a subordinate declared without `Write` reported holding no such tool while
 * its parent held `Write` throughout.
 */
const TOP_LEVEL = { parentToolUseId: null, decide };

function absoluteIn(cwd, target) {
  return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
}

// ============================================================================================
// NATIVE SUBAGENTS — only in `fanout` mode
// ============================================================================================

/**
 * The roster this process was handed, read off `--agents`, which is a single JSON argument.
 *
 * Read off THIS PROCESS'S OWN ARGV, exactly like the permission rules and for the same reason: a
 * fake that took its roster from an environment variable would be answering a question the
 * adapter was never asked, and the argv is the thing under test.
 */
function parseRoster() {
  const at = argv.indexOf('--agents');
  if (at === -1) return {};
  try {
    const parsed = JSON.parse(argv[at + 1] ?? '{}');
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const roster = parseRoster();

/**
 * The nesting cap, off the ENVIRONMENT this process was actually given.
 *
 * Measured to be a hard bound rather than a request: at the cap the harness does not refuse the
 * spawn, it removes the spawn tools from the subordinate's loadout, so a unit at the floor has
 * nothing to attempt. Modelled that way below — a depth at or beyond the cap has no `Agent`.
 */
const spawnDepthCap = Number.parseInt(process.env['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH'] ?? '', 10);
const maxSpawnDepth = Number.isFinite(spawnDepthCap) ? spawnDepthCap : 1;

/**
 * An actor for one native subagent.
 *
 * The permission model is the INTERSECTION of three things, and each third was measured
 * separately rather than assumed:
 *
 *   1. the tool-name list its roster entry declared — its actual loadout;
 *   2. the session's deny rules, which a subagent INHERITS (a subordinate hit the credential deny
 *      and was told the path was `denied by your permission settings`);
 *   3. the session's allow rules, which it also inherits (a subordinate under `Bash(echo:*)` was
 *      refused `curl`).
 *
 * A tool the roster entry did not name is refused with no rule attributed, because there is no
 * rule — the tool is simply not in the loadout. That is the shape the real one produces, and it is
 * why a subagent's refusal does not always look like a permission denial.
 */
function subagentActor(type, parentToolUseId) {
  const declared = Array.isArray(roster[type]?.tools) ? roster[type].tools : [];
  return {
    parentToolUseId,
    type,
    decide(tool, target) {
      if (!declared.includes(tool)) return { allowed: false, rule: null };
      return decide(tool, target);
    },
  };
}

/** Forwarded subagent prose, as `--forward-subagent-text` delivers it: nested, and typed. */
function saySubagent(type, parentToolUseId, text) {
  say({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: parentToolUseId,
    subagent_type: type,
    session_id: sessionId,
  });
}

/**
 * Field one subagent and run its steps, or be refused.
 *
 * THE SPAWN IS GATED BY THE DENY HALF ONLY, and that asymmetry is measured rather than tidied.
 * A parent whose only spawn rules were `Agent(<a declared type>)` on the ALLOW half spawned a
 * built-in `general-purpose` anyway, successfully — the spawn tool is simply not gated by the
 * allow list. Modelling the allow half here would make this fake HARSHER than the real CLI in the
 * one place where harshness would hide the hole: a test asserting that a built-in type is blocked
 * would pass on a mechanism that does not exist in the field.
 */
function fieldSubagent(type, steps, depth = 1) {
  const input = { subagent_type: type, description: `field a ${type}`, prompt: steps.join('\n') };
  const id = emitToolUse('Agent', input);

  if (depth > maxSpawnDepth) {
    emitToolResult(id, `No Agent tool available at depth ${String(depth)}.`, true);
    return;
  }
  for (const rule of denyRules) {
    if (ruleMatches(rule, 'Agent', spellings(type)) || ruleMatches(rule, 'Task', spellings(type))) {
      denials.push({ tool_name: 'Agent', tool_use_id: id, tool_input: input });
      emitToolResult(id, `Agent type '${type}' has been denied by permission rule '${rule}'.`, true);
      return;
    }
  }
  if (!Object.hasOwn(roster, type)) {
    emitToolResult(id, `Agent type '${type}' is not defined.`, true);
    return;
  }

  const actor = subagentActor(type, id);
  saySubagent(type, id, `${type} reporting: ${String(steps.length)} step(s) to run.`);
  let refused = 0;
  for (const step of steps) {
    const parsed = /^(glob|read|write|edit|grep|spawn)\s+(\S+)\s*([\s\S]*)$/i.exec(step.trim());
    if (parsed === null) continue;
    const op = parsed[1].toLowerCase();
    if (op === 'spawn') {
      // A subagent trying to field a subagent. Its declared loadout decides, exactly as it does
      // for every other tool — there is no separate spawn path in the real one either.
      if (!subagentActor(type, id).decide('Agent', parsed[2]).allowed) {
        saySubagent(type, id, `${type}: I hold no tool that fields a subordinate.`);
        refused += 1;
        continue;
      }
      fieldSubagent(parsed[2], [], depth + 1);
      continue;
    }
    if (runStep({ op, arg: parsed[2], rest: parsed[3] ?? '' }, actor) === null) refused += 1;
  }
  saySubagent(type, id, `${type} done: ${String(refused)} refused.`);
  emitToolResult(id, `${type} reported back (${String(refused)} refused).`, false);
}

/**
 * The steps a turn performs. Orders may name them explicitly, one per line:
 *
 *   glob <dir>            read <path>            grep <needle> <path>
 *   write <path> <text>   edit <path> <text>
 *
 * Orders that name none get the default routine below — a worker that looks around its
 * workspace, writes a file, reads it back, greps it and edits it. Prose orders therefore still
 * exercise all five path tools, so a test does not have to know this syntax to be hostile.
 */
function stepsFor(text) {
  const steps = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const parsed = /^(glob|read|write|edit|grep)\s+(\S+)\s*([\s\S]*)$/i.exec(line);
    if (parsed === null) continue;
    steps.push({ op: parsed[1].toLowerCase(), arg: parsed[2], rest: parsed[3] ?? '' });
  }
  if (steps.length > 0) return steps;

  const file = process.env['FAKE_CLAUDE_WORK_FILE'] ?? 'engineer-work.txt';
  return [
    { op: 'glob', arg: '.', rest: '' },
    { op: 'write', arg: file, rest: 'engineer was here' },
    { op: 'read', arg: file, rest: '' },
    { op: 'grep', arg: 'engineer', rest: file },
    { op: 'edit', arg: file, rest: 'and edited it' },
  ];
}

/**
 * The subordinates a turn fields, and what it tells each to do. Orders name them as:
 *
 *   fanout <subagent_type>
 *     read <path>
 *     spawn <subagent_type>
 *
 * Indented lines belong to the `fanout` above them. Orders naming none field one of every type on
 * the roster with a single `glob .` each, so a test that only wants nesting to EXIST does not have
 * to know this syntax — and one that wants a specific refusal can ask for it precisely.
 */
function fanoutPlan(text) {
  const plan = [];
  for (const raw of text.split('\n')) {
    const squad = /^\s*fanout\s+(\S+)\s*$/i.exec(raw);
    if (squad !== null) {
      plan.push({ type: squad[1], steps: [] });
      continue;
    }
    if (plan.length > 0 && /^\s+\S/.test(raw)) plan[plan.length - 1].steps.push(raw.trim());
  }
  if (plan.length > 0) return plan;
  return Object.keys(roster).map((type) => ({ type, steps: ['glob .'] }));
}

function runStep(step, actor = TOP_LEVEL) {
  const cwd = process.cwd();
  if (step.op === 'glob') {
    const dir = absoluteIn(cwd, step.arg);
    return useTool(
      'Glob',
      { pattern: '**/*', path: dir },
      dir,
      () => readdirSync(dir).sort().join('\n'),
      actor,
    );
  }
  if (step.op === 'read') {
    const file = absoluteIn(cwd, step.arg);
    return useTool('Read', { file_path: file }, file, () => readFileSync(file, 'utf8'), actor);
  }
  if (step.op === 'write') {
    const file = absoluteIn(cwd, step.arg);
    const content = `${step.rest}\n`;
    return useTool(
      'Write',
      { file_path: file, content },
      file,
      () => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
        return `File created successfully at: ${file}`;
      },
      actor,
    );
  }
  if (step.op === 'edit') {
    const file = absoluteIn(cwd, step.arg);
    // The real Edit reads the file itself, under its OWN permission — an Edit that is allowed
    // does not additionally need Read. Modelled that way on purpose.
    return useTool(
      'Edit',
      { file_path: file, old_string: '', new_string: step.rest },
      file,
      () => {
        const before = readFileSync(file, 'utf8');
        writeFileSync(file, `${before}${step.rest}\n`);
        return `The file ${file} has been updated.`;
      },
      actor,
    );
  }
  if (step.op === 'grep') {
    const target = absoluteIn(cwd, step.rest === '' ? '.' : step.rest);
    return useTool(
      'Grep',
      { pattern: step.arg, path: target },
      target,
      () => {
        const files = statSync(target).isDirectory()
          ? readdirSync(target).map((entry) => join(target, entry))
          : [target];
        const hits = [];
        for (const file of files) {
          let body;
          try {
            if (statSync(file).isDirectory()) continue;
            body = readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          for (const line of body.split('\n')) {
            if (line.includes(step.arg)) hits.push(`${file}:${line}`);
          }
        }
        return hits.length === 0 ? 'No matches found' : hits.join('\n');
      },
      actor,
    );
  }
  return null;
}

// ============================================================================================

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

/**
 * Turns accepted and not yet reported, oldest first — the state the real CLI has and this fake
 * used to pretend away twice over.
 *
 * It was a single `turnInFlight` boolean plus a single `turnTimer`, and a second turn pushed
 * before the first one's timer fired OVERWROTE that timer. The first turn's `finish` then ran,
 * cleared the shared flag, and the second turn's `finish` returned early — so two turns produced
 * ONE result, and the test named "a duplex round trip: ready, two turns, clean close" never once
 * saw two turns close. The real CLI reports one result per turn, which is why
 * `interrupt_cancel_queued_v1` and `still_queued` exist at all.
 */
const turns = [];
const turnInFlight = () => turns.length > 0;

// ============================================================================================
// PARTIAL MESSAGES
// ============================================================================================

/** Modes whose turn occupies real time, and therefore stream their text over real time. */
const SLOW_MODES = new Set(['slow', 'abort-streaming', 'abort-unknown']);
/** Gap between deltas in a slow turn — wide enough for an interrupt to land between two of them. */
const DELTA_GAP_MS = SLOW_MODES.has(mode) ? 120 : 0;

let uuidSeq = 0;

function sayStreamEvent(event) {
  uuidSeq += 1;
  say({
    type: 'stream_event',
    event,
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: `fake-partial-${String(uuidSeq).padStart(4, '0')}`,
  });
}

/**
 * `stamped` reproduces which lines carried a `timestamp` before partial messages existed — the
 * turn echo did, the `work` summary did not. Kept exactly, so that with the flag off this file's
 * output is byte-for-byte what it was: the adapter stamps an unstamped line on receipt, and a
 * wall-clock `ts` is not the same value as a fixed one.
 */
function sayAssistantText(text, stamped = true) {
  say({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    ...(stamped ? { timestamp: '2026-08-02T00:00:00.000Z' } : {}),
  });
}

/**
 * The chunking. Four pieces, so a test can tell "arrived in pieces" from "arrived in one lump"
 * and still assert that the pieces rejoin into EXACTLY the aggregate — which is the property the
 * adapter's suppression rule rests on, measured true on every real turn including an aborted one.
 */
function chunksOf(text) {
  if (text.length === 0) return [''];
  const size = Math.max(1, Math.ceil(text.length / 4));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** The block currently being streamed, or null. Non-null is what makes an abort mid-STREAM. */
let streaming = null;

/**
 * Deliver one assistant text block. Without the flag that is a single `assistant` line, exactly
 * as before. With it, the measured sequence — and the aggregate is still emitted, because the
 * real CLI still emits it and a fake that dropped it would prove the opposite of the point.
 */
function streamText(text, onComplete, stamped = true) {
  if (!partialMessages) {
    sayAssistantText(text, stamped);
    onComplete();
    return;
  }
  sayStreamEvent({
    type: 'message_start',
    message: {
      id: `msg_fake${String(turn)}`,
      type: 'message',
      role: 'assistant',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  sayStreamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

  // `flush` delivers the rest at once. Used when stdin closes mid-stream: that is not an abort,
  // so the block is completed rather than cut, and the aggregate still equals the deltas.
  streaming = { delivered: '', timer: undefined, flush: null };
  const chunks = chunksOf(text);
  let gap = DELTA_GAP_MS;
  let i = 0;
  const step = () => {
    if (i < chunks.length) {
      streaming.delivered += chunks[i];
      sayStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: chunks[i] },
      });
      i += 1;
      if (gap === 0) return step();
      streaming.timer = setTimeout(step, gap);
      return;
    }
    // MEASURED ORDER: the aggregate lands after the last delta and BEFORE content_block_stop.
    sayAssistantText(streaming.delivered, stamped);
    sayStreamEvent({ type: 'content_block_stop', index: 0 });
    sayStreamEvent({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: chunks.length },
    });
    sayStreamEvent({ type: 'message_stop' });
    streaming = null;
    onComplete();
  };
  streaming.flush = () => {
    gap = 0;
    clearTimeout(streaming.timer);
    step();
  };
  step();
}

/**
 * Cut a stream short, the way the real CLI does. The aggregate that follows an abort carries
 * what was ALREADY DELIVERED and nothing more — no `content_block_stop`, no `message_stop` —
 * then the `[Request interrupted by user]` echo. Measured, not guessed.
 */
function abortStreaming() {
  if (streaming === null) return;
  clearTimeout(streaming.timer);
  const delivered = streaming.delivered;
  streaming = null;
  sayAssistantText(delivered);
  say({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
}

const rl = createInterface({ input: process.stdin });

/** Everything denied since the last result line, in the real CLI's shape, then cleared. */
function drainDenials() {
  const out = denials;
  denials = [];
  return out;
}

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
    if (!turnInFlight()) return;

    // Mid-STREAM rather than mid-tool: the half that reports `aborted_streaming`.
    abortStreaming();
    // ONE result per interrupt, however many turns it cancelled — the rest are what the receipt's
    // `still_queued` is for, and that is gap 7, not modelled.
    for (const t of [...turns]) t.cancel();
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
      permission_denials: drainDenials(),
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
    const myTurn = turn;
    const text = msg.message?.content?.[0]?.text ?? '';

    // A turn OCCUPIES TIME, as it does in reality. Without this there is no window in which an
    // interrupt can land mid-turn, so `slow` is what the abort tests drive; `ok` finishes promptly
    // but still asynchronously, so an in-flight turn is a real state rather than a fiction.
    //
    // Enqueued BEFORE the reply is delivered, not after: with partial messages the delivery
    // itself spans time, and an interrupt that lands between two deltas has a turn to abort.
    let timer;
    let settled = false;
    const entry = {
      /** Stop tracking this turn without reporting it — the interrupt path owns the result. */
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const at = turns.indexOf(entry);
        if (at !== -1) turns.splice(at, 1);
      },
      finish: () => {},
    };
    entry.finish = () => {
      if (settled) return;
      entry.cancel();
      say({
        type: 'result',
        subtype: 'success',
        is_error: false,
        terminal_reason: 'completed',
        session_id: sessionId,
        duration_ms: 5,
        // Cumulative, exactly like the real CLI: turn 1 reports 0.25, turn 2 reports 0.50.
        total_cost_usd: myTurn * 0.25,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
        // Always present, even when empty — the recorded fixtures carry `permission_denials: []`
        // on every result line, and a consumer that only ever sees the key when it is populated
        // is a consumer whose empty case was never exercised.
        permission_denials: drainDenials(),
      });
    };

    turns.push(entry);

    // Deliver the reply, THEN start the clock on the result. Without partial messages that is one
    // `assistant` line and the timer is armed in the same tick, exactly as it always was — but it
    // is now THIS turn's timer, not a single shared one a later turn can stamp on.
    streamText(drafting ? draftReply(text) : `echo:${text}`, () => {
      if (mode === 'work') {
        const steps = stepsFor(text);
        for (const step of steps) runStep(step);
        streamText(
          `ran ${String(steps.length)} tool(s), ${String(denials.length)} denied`,
          () => {},
          false,
        );
      }
      if (mode === 'fanout') {
        const plan = fanoutPlan(text);
        for (const squad of plan) fieldSubagent(squad.type, squad.steps);
        streamText(
          `fielded ${String(plan.length)} subordinate(s), ${String(denials.length)} denied`,
          () => {},
          false,
        );
      }
      if (mode === 'start-flow') {
        void callStartFlow(text).then(
          (said) => streamText(`start_flow said: ${said}`, () => (timer = setTimeout(entry.finish, 5)), false),
          (err) => streamText(`start_flow failed: ${String(err)}`, () => (timer = setTimeout(entry.finish, 5)), false),
        );
        return;
      }
      timer = setTimeout(entry.finish, SLOW_MODES.has(mode) ? 5000 : 5);
    });
  }
});

/**
 * STDIN CLOSED.
 *
 * MEASURED against claude 2.1.221 on 2026-08-03: a turn written and then followed IMMEDIATELY by
 * `stdin.end()` still produces its `assistant` message and its `result`, and only then exits 0.
 * The real CLI finishes the turn it is running.
 *
 * This handler used to be `process.exit(0)`, which does neither half of that:
 *
 *   1. It discarded a turn that was still in flight, so the adapter saw a worker that was given
 *      work and produced no `result` — `silentlyDied()`, i.e. `exitCode: 0, status: 'error'`.
 *   2. `process.stdout` on a PIPE is ASYNCHRONOUS, and `process.exit` does not drain it. Lines
 *      already written — `system/init` included — were thrown away unwritten.
 *
 * Together those put an UNSTATED DEADLINE on every test that sends and then closes: the turn had
 * to have completed before `close()`, or the run failed for reasons that had nothing to do with
 * the adapter. Measured at 28ms typical and 36ms under an eight-way CPU load against a 250ms
 * budget, so it did not fire here — but a budget nobody wrote down is a budget nobody maintains,
 * and this signature is indistinguishable from a real silent death.
 *
 * So: settle the turn, then let node exit of its own accord once no handles remain. Falling off
 * the end of the event loop flushes stdout; `process.exit` truncates it.
 */
rl.on('close', () => {
  if (mode === 'deaf') {
    setInterval(() => {}, 1000);
    return;
  }
  // A block still streaming is delivered in FULL rather than cut: stdin closing is not an abort,
  // and the aggregate must still equal what the deltas carried.
  if (streaming !== null) streaming.flush();
  for (const t of [...turns]) t.finish();
  process.exitCode = 0;
});
