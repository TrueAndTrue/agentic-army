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
 *   work    TOUCHES THE FILESYSTEM, confined by the sandbox argv it was actually handed
 *
 * ==========================================================================================
 * WHAT THIS FAKE MODELS, AND WHAT IT DOES NOT.
 *
 * The sibling fake for claude used to ignore `--allowedTools` entirely, and a worker locked out
 * of its own worktree passed 621 green tests. The codex-shaped version of that blindness is a
 * fake that never writes anything: `codexConfinement` classifies each deny rule `enforced` or
 * `unenforceable`, and until this file honoured a sandbox, nothing anywhere ran a process under
 * one. "Enforced" was a claim about a region, checked by no test that ever tried to write to it.
 *
 * ---- MODELLED ---------------------------------------------------------------------------
 *
 *   THE WRITE SANDBOX. `-C`, `-s` and the `-c sandbox_workspace_write.*` overrides are parsed
 *   off this process's own argv. Under `workspace-write` the writable set is the `-C` directory
 *   plus `/tmp` and `$TMPDIR`, each dropped when its `exclude_*` override is present; under
 *   `read-only` it is empty; `danger-full-access` and the bypass flag lift it entirely. A write
 *   outside the set is REFUSED and touches nothing, reported as a `command_execution` that
 *   exited non-zero — which is what a sandboxed shell write looks like from outside.
 *
 *   THE ASYMMETRY THAT MATTERS. Reads succeed ANYWHERE, including outside every writable root,
 *   because that is what was measured: `-s workspace-write` is a *write* sandbox and a codex
 *   worker read a decoy private key. A fake that confined reads would quietly certify a
 *   protection this harness does not provide, which is the more expensive direction of wrong.
 *
 *   Paths are compared canonically, since `/tmp` and `/private/tmp` are one directory with two
 *   spellings and a sandbox compares inodes rather than strings.
 *
 * ---- NOT MODELLED -----------------------------------------------------------------------
 *
 *   1 Only `work` mode runs the agent's own tools; every other mode is inert under any sandbox.
 *     The `-o` last-message file is written unconfined in every mode, which is correct — the
 *     CLI writes it, not the sandboxed agent — but it means `-o` proves nothing about the
 *     boundary and no test should read it as if it did.
 *   2 No network confinement. `network_access=false` is asserted on argv and nowhere else.
 *   3 No per-tool permissions of any kind — correctly, because codex has none. Every
 *     `Read(...)`, `Grep(...)` and `Bash(...)` deny is unenforceable here exactly as it is on
 *     the real harness, and this fake must never grow a way to honour one.
 *   4 The refusal is modelled as a failed command, not as Seatbelt's own error text.
 * ==========================================================================================
 */

import {
  existsSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

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

// ============================================================================================
// THE SANDBOX, read off argv rather than off an environment variable a test could set to
// something the adapter never passed. If `buildCodexArgs` stops emitting `-C`, the writable
// region stops being the worktree here too, and the test that depended on it goes red.
// ============================================================================================

function flagValue(...names) {
  for (const name of names) {
    const at = argv.indexOf(name);
    if (at !== -1 && argv[at + 1] !== undefined) return argv[at + 1];
  }
  return null;
}

/** Every `-c key=value` override, as a map. */
function configOverrides() {
  const out = new Map();
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] !== '-c') continue;
    const eq = argv[i + 1].indexOf('=');
    if (eq > 0) out.set(argv[i + 1].slice(0, eq), argv[i + 1].slice(eq + 1));
  }
  return out;
}

/**
 * Canonical spelling of a path that may not exist yet. A sandbox compares inodes; a lexical
 * compare compares spellings, and on macOS `/tmp` IS `/private/tmp` — a region named one way and
 * checked the other looks unrelated, which fails open.
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

const overrides = configOverrides();
const workspace = canonical(flagValue('-C', '--cd') ?? process.cwd());
const sandbox = flagValue('-s', '--sandbox') ?? 'read-only';
const bypass = argv.includes('--dangerously-bypass-approvals-and-sandbox');

/** `null` means unconfined; an array is the exhaustive set of writable roots. */
function writableRoots() {
  if (bypass || sandbox === 'danger-full-access') return null;
  if (sandbox !== 'workspace-write') return [];
  const roots = [workspace];
  if (overrides.get('sandbox_workspace_write.exclude_slash_tmp') !== 'true') roots.push(canonical('/tmp'));
  const tmp = process.env['TMPDIR'];
  if (overrides.get('sandbox_workspace_write.exclude_tmpdir_env_var') !== 'true' && tmp !== undefined) {
    roots.push(canonical(tmp));
  }
  return roots;
}

const ROOTS = writableRoots();

function writable(target) {
  if (ROOTS === null) return true;
  const path = canonical(target);
  return ROOTS.some((root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`));
}

let itemSeq = 0;
function command(cmd, run) {
  itemSeq += 1;
  const id = `item_w${String(itemSeq)}`;
  say({
    type: 'item.started',
    item: { id, type: 'command_execution', command: cmd, aggregated_output: '', exit_code: null, status: 'in_progress' },
  });
  const result = run();
  say({
    type: 'item.completed',
    item: {
      id,
      type: 'command_execution',
      command: cmd,
      aggregated_output: result.output,
      exit_code: result.code,
      status: result.code === 0 ? 'completed' : 'failed',
    },
  });
}

/**
 * `work` mode. Directives, one per line of the prompt: `write <path> <text>` / `read <path>`.
 * A prompt naming none gets the default routine — write a file in the workspace, read it back.
 */
function doWork() {
  const prompt = argv.at(-1) ?? '';
  const steps = [];
  for (const raw of prompt.split('\n')) {
    const parsed = /^(write|read)\s+(\S+)\s*([\s\S]*)$/i.exec(raw.trim());
    if (parsed !== null) steps.push({ op: parsed[1].toLowerCase(), arg: parsed[2], rest: parsed[3] ?? '' });
  }
  if (steps.length === 0) {
    const file = process.env['FAKE_CODEX_WORK_FILE'] ?? 'codex-work.txt';
    steps.push({ op: 'write', arg: file, rest: 'codex was here' });
    steps.push({ op: 'read', arg: file, rest: '' });
  }

  for (const step of steps) {
    const target = isAbsolute(step.arg) ? resolve(step.arg) : resolve(workspace, step.arg);
    if (step.op === 'write') {
      command(`printf %s > ${target}`, () => {
        // A refused write must touch NOTHING. A fake that denies loudly and writes anyway proves
        // the opposite of what it claims.
        if (!writable(target)) {
          return { code: 1, output: `sh: ${target}: Operation not permitted (sandbox: ${sandbox})\n` };
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `${step.rest}\n`);
        return { code: 0, output: '' };
      });
      continue;
    }
    // Reads are NOT confined by any codex sandbox mode. Measured, not assumed — and the whole
    // reason `SECRET_PATH_GLOBS`'s read half is classified unenforceable on this harness.
    command(`cat ${target}`, () =>
      existsSync(target)
        ? { code: 0, output: readFileSync(target, 'utf8') }
        : { code: 1, output: `cat: ${target}: No such file or directory\n` },
    );
  }
}

say({ type: 'turn.started' });
if (mode === 'work') {
  doWork();
} else {
  say({
    type: 'item.started',
    item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: null, status: 'in_progress' },
  });
  say({
    type: 'item.completed',
    item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: 'calc.py\n', exit_code: 0, status: 'completed' },
  });
}
say({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: payload } });
say({
  type: 'turn.completed',
  usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 2 },
});

// `no-output`: a run that reaches turn.completed but never produces the demanded artifact.
if (mode !== 'no-output' && outPath !== null && outPath !== undefined) writeFileSync(outPath, payload);
process.exit(0);
