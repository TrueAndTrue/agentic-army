/**
 * The Codex adapter — the one-shot one. INSPECTOR and SENTRY run on codex.
 *
 * ```
 * codex exec --json -C <repo> -s workspace-write --output-schema <file> -o <file> \
 *            -m gpt-5.5 -c model_reasoning_effort=high <prompt>   < /dev/null
 * ```
 *
 * `app-server` is explicitly out of scope for v1 (unverified, and the recon's recommendation): an
 * Inspector runs to completion unsupervised, so the duplex affordances it unlocks are builder
 * features we would be paying ~500 generated types for.
 *
 * ## The three ways this harness silently ruins your day
 *
 * 1. **`codex exec` hangs forever if stdin is an open pipe.** `--help`: *"If stdin is piped and a
 *    prompt is also provided, stdin is appended as a `<stdin>` block"* — so it blocks on an EOF
 *    that never comes. Measured: 0 bytes of stdout, killed at 7 minutes. The identical command
 *    with `< /dev/null` finished in 9.4s. We therefore spawn with stdin `'ignore'`, and there is
 *    a test that asserts it. This is a silent-hang class bug, not an error.
 * 2. **Setting `CODEX_HOME` drops the ChatGPT subscription login** and falls through to
 *    `OPENAI_API_KEY` — API billing, or a 401 retry storm. This adapter never introduces it.
 *    (Note the inverse of the usual assumption: a stored `auth.json` WINS over `OPENAI_API_KEY`,
 *    so an API key in the environment is harmless. The dangerous direction is losing the store.)
 * 3. **`-o` is not written when the run fails.** Exit 1 leaves no file at all, which is a
 *    different failure from "file present but unparseable" and is handled as such below.
 *
 * ## The identity asymmetry, absorbed here
 *
 * There is no `--session-id` analogue: the thread id is Codex-minted and appears exactly once, on
 * the FIRST line, as `thread.started.thread_id`. Our `spec.agentId` and `spec.sessionId` stay
 * supervisor-minted; the Codex thread id is captured as a foreign key and read back with
 * `codexThreadId()`, so callers above the seam never have to know the difference.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  CloseResult,
  HarnessAdapter,
  ReasoningEffort,
  Soldier,
  SoldierEvent,
  SoldierSpec,
  SoldierStatus,
  TokenUsage,
} from '../contracts/harness.ts';
import { killProcessTree } from '../setup/checks.ts';
import type { JsonlLine } from './jsonl.ts';
import { createAsyncQueue, createJsonlFramer } from './jsonl.ts';
import type { KillableSoldier } from './kill.ts';

// ---------------------------------------------------------------------------------------------
// argv / env
// ---------------------------------------------------------------------------------------------

/**
 * Item types that are a tool invocation rather than model output. `item.started` on one of these
 * becomes `tool_use`; the matching `item.completed` becomes `tool_result`.
 */
const CODEX_TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

/**
 * `minimal` is in the server's accepted enum but is INCOMPATIBLE with codex's default toolset —
 * see `buildCodexArgs`. Everything else passes through unchanged.
 */
const CODEX_EFFORT: Record<ReasoningEffort, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
};

export interface CodexArgsOptions {
  /** Where `-o/--output-last-message` should land. */
  outputPath?: string;
  /** Precomputed confinement; recomputed from the spec when absent. */
  confinement?: CodexConfinement;
}

// ---------------------------------------------------------------------------------------------
// CONFINEMENT — what `-s workspace-write` actually enforces, and what it does not
// ---------------------------------------------------------------------------------------------

/**
 * ## Exactly what is enforced on a codex worker, and what is only recorded intent
 *
 * `SoldierSpec.allow` / `SoldierSpec.deny` are the permission model. Claude enforces them
 * directly (`--allowedTools` / `--disallowedTools`). **Codex has no equivalent** — `codex exec`
 * offers a filesystem sandbox and nothing else. So this module states the boundary precisely
 * rather than implying parity.
 *
 * ### MEASURED, codex-cli 0.142.5 / macOS Seatbelt, 2026-08-02
 *
 * Probes ran real `codex exec -s workspace-write` runs and checked the filesystem afterwards, both
 * through a shell command the agent spawned AND through codex's own file-editing tool:
 *
 * | Target                                   | shell write | file-tool write | read |
 * |------------------------------------------|-------------|-----------------|------|
 * | inside `-C` dir                          | **WRITE**   | **WRITE**       | read |
 * | true sibling / parent of `-C`            | denied      | —               | read |
 * | arbitrary path in `$HOME`                | denied      | —               | read |
 * | `~/.agentic-army`-shaped path in `$HOME` | denied      | **denied**      | read |
 * | `/tmp`                                   | **WRITE**   | —               | read |
 * | `$TMPDIR`                                | **WRITE**   | —               | read |
 * | `~/.ssh` listing, a private key, `.env`  | —           | —               | **READ** |
 *
 * ### The three conclusions
 *
 * 1. **`-s workspace-write` is a WRITE sandbox. Reads are not confined at all.** Every `Read(...)`
 *    / `Grep(...)` / `Glob(...)` deny — the whole `SECRET_PATH_GLOBS` read half, which exists
 *    because "reading a credential is exfiltration" — is UNENFORCEABLE on codex.
 * 2. **`PROTECTED_CONFIG_GLOBS` is enforced by default, but only incidentally** — because the army
 *    home normally sits under `$HOME`, which the sandbox denies. It stops being enforced the
 *    moment `AGENTIC_ARMY_HOME` points into `/tmp`, `$TMPDIR`, or the worktree itself. That is a
 *    configuration away, not an attack away, so it is checked per spawn rather than assumed.
 * 3. **Command denials cannot be expressed.** `git push --force`, `npm publish`, `gh pr merge`
 *    have no analogue in `codex exec`; the sandbox governs paths, not argv.
 *
 * ### What this module does about it
 *
 * - Closes the `/tmp` / `$TMPDIR` holes with `-c sandbox_workspace_write.exclude_slash_tmp` and
 *   `exclude_tmpdir_env_var`, but ONLY when a protected path actually lives there — excluding
 *   `$TMPDIR` unconditionally would break most test runners, and an Inspector is leased a writable
 *   tree precisely so it can run them.
 * - Pins `network_access` explicitly — to `false` under the `guarded` posture and `true` under
 *   `unguarded` — so a user's `config.toml` decides neither. Under `guarded` the sandbox denies
 *   `listen`, which is a real boundary and also the reason a socket-bound test suite cannot be
 *   reviewed; `PermissionPosture` in `src/contracts/config.ts` records the campaign that made the
 *   trade explicit.
 * - **REFUSES TO SPAWN** when a rooted write-deny still lands inside the writable region. A
 *   boundary that is silently absent is worse than one that is explicitly unavailable.
 * - Reports everything it cannot enforce as a structured limitation, on the event stream and via
 *   `codexConfinement()`.
 */
export interface CodexConfinement {
  /** Extra `-c` overrides that tighten the sandbox. */
  args: string[];
  /** Absolute roots the worker can write to, after the overrides above. */
  writableRoots: string[];
  /**
   * Whether the sandbox will let this worker open a socket. Reported rather than inferred from
   * `args`, so a caller — and the test that proves the Inspector can bind 127.0.0.1 again — reads
   * the decision instead of grepping a `-c` string for a substring.
   */
  networkAccess: boolean;
  /** Deny rules the sandbox genuinely enforces. */
  enforced: string[];
  /** Deny rules codex cannot express. Recorded intent, NOT enforcement. */
  unenforceable: string[];
  /**
   * Rooted write-denies that still land inside the writable region. Non-empty means the boundary
   * is absent and `spawn()` refuses.
   */
  breaches: string[];
}

/** Tools that put bytes on disk — mirrors `WRITE_TOOLS` in src/command/permissions.ts. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

const RULE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s;

/** `Write(~/.agentic-army/**)` -> `{ tool: 'Write', pattern: '~/.agentic-army/**' }`. */
function parseRule(rule: string): { tool: string; pattern: string } | null {
  const m = RULE_RE.exec(rule.trim());
  return m === null ? null : { tool: m[1] ?? '', pattern: m[2] ?? '' };
}

/**
 * Canonical absolute path: symlinks resolved, real on-disk casing, for a path that may not exist.
 *
 * THE BUG THIS EXISTS TO PREVENT. The sandbox compares inodes; a lexical `resolve()` compares
 * spellings. On macOS `/tmp` IS `/private/tmp`, so a deny root written either way looked like a
 * different region from the writable root and was classified `enforced` while a live write went
 * straight through. That needs no attacker: `/private/tmp/army` is the canonical form macOS itself
 * reports, so `AGENTIC_ARMY_HOME=/private/tmp/army` produces it by hand.
 *
 * `realpathSync` fails on a path that does not exist yet — and a protected config directory very
 * often does not — so we walk up to the nearest existing ancestor, canonicalise that, and
 * re-append the tail. The tail is not symlink-resolvable by definition (it is not there), which is
 * fine: what matters is that the existing prefix is.
 */
function canonicalize(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p); // reached the root; nothing on this path exists
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * True when `child` is `parent` or sits beneath it, comparing CANONICAL paths.
 *
 * Deliberately asymmetric on case. The two possible mistakes are not equally bad:
 *   - a false TRUE  -> we add an exclusion flag or refuse to spawn. Over-tight, never unsafe.
 *   - a false FALSE -> we claim `enforced` for a region the sandbox will happily let a worker
 *                      write. That is the false-assurance pattern this module exists to prevent.
 * macOS and Windows default to case-insensitive filesystems, so a case-folded match is treated as
 * inside even on a case-sensitive volume, where it can only ever over-tighten.
 */
function isInsideCanonical(child: string, parent: string): boolean {
  if (isInside(child, parent)) return true;
  return isInside(child.toLowerCase(), parent.toLowerCase());
}

/**
 * Resolve a deny pattern to an absolute, CANONICAL directory, or null when it does not name a
 * fixed region.
 *
 * The rooted/unrooted split is the whole trick. `~/.agentic-army/**` names a REGION, which a
 * directory sandbox can reason about. `**` + `/.env` names a FILENAME anywhere, which it
 * fundamentally cannot — so the latter is reported as unenforceable instead of being quietly
 * treated as covered.
 */
function resolveDenyRoot(pattern: string, env: NodeJS.ProcessEnv, home: string): string | null {
  let p = pattern.trim();
  if (p === '') return null;

  if (p.startsWith('$AGENTIC_ARMY_HOME')) {
    const value = env['AGENTIC_ARMY_HOME'];
    if (value === undefined || value === '') return null;
    p = value + p.slice('$AGENTIC_ARMY_HOME'.length);
  }
  if (p === '~' || p.startsWith('~/')) p = join(home, p.slice(1));
  if (p.includes('$')) return null; // an unexpanded variable is not a region we can reason about

  // Take the leading glob-free segments; anything from the first wildcard on is a pattern.
  const segments = p.split('/');
  const fixed: string[] = [];
  for (const seg of segments) {
    if (/[*?[\]]/.test(seg)) break;
    fixed.push(seg);
  }
  const base = fixed.join('/');
  if (base === '' || !isAbsolute(base)) return null; // unrooted (`**/.env`) — not a region
  return canonicalize(base);
}

/** True when `child` is `parent` or sits beneath it. */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Work out what the sandbox will and will not enforce for this spec. Pure — it reads `env` and the
 * spec, touches no disk, and spawns nothing, so the tests can drive every branch.
 */
export function codexConfinement(
  spec: SoldierSpec,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): CodexConfinement {
  // EVERY path in the comparison is canonicalised — cwd, deny roots, /tmp and $TMPDIR alike.
  // Canonicalising one side only would reintroduce exactly the aliasing this is here to kill.
  const cwd = canonicalize(spec.cwd);
  const slashTmp = canonicalize('/tmp');
  const tmpDir = env['TMPDIR'] === undefined ? null : canonicalize(env['TMPDIR']);

  const enforced: string[] = [];
  const unenforceable: string[] = [];
  const breaches: string[] = [];
  let excludeSlashTmp = false;
  let excludeTmpDir = false;

  for (const rule of spec.deny) {
    const parsed = parseRule(rule);
    if (parsed === null) {
      unenforceable.push(rule);
      continue;
    }
    // Reads are not confined by ANY codex sandbox mode — measured, not assumed.
    // Bash denials have no analogue: the sandbox governs paths, not argv.
    if (!WRITE_TOOL_NAMES.has(parsed.tool)) {
      unenforceable.push(rule);
      continue;
    }
    const root = resolveDenyRoot(parsed.pattern, env, home);
    if (root === null) {
      // `**/.env` and friends: a filename pattern, not a region.
      unenforceable.push(rule);
      continue;
    }
    if (isInsideCanonical(root, cwd)) {
      // Unfixable: the workspace MUST be writable for an Engineer to work and an Inspector to run
      // tests. Nothing in codex's config can carve a hole out of the writable root.
      breaches.push(rule);
      continue;
    }
    if (tmpDir !== null && isInsideCanonical(root, tmpDir)) {
      excludeTmpDir = true;
      enforced.push(rule);
      continue;
    }
    if (isInsideCanonical(root, slashTmp)) {
      excludeSlashTmp = true;
      enforced.push(rule);
      continue;
    }
    // Outside every writable root: denied by the sandbox as measured.
    enforced.push(rule);
  }

  // THE INSPECTOR'S BLINDNESS, and why this is a switch rather than a constant.
  //
  // `-s workspace-write` denies `listen`, so a suite that binds 127.0.0.1 dies with
  // `EPERM ... syscall: 'listen'` before it asserts anything. Measured on the campaign of
  // 2026-08-07: 50 such failures in one Inspector's stream, on all three review attempts, which
  // meant the campaign's headline end-to-end criterion was never executed by any reviewer — while
  // all three still returned `testsRun: true`. A reviewer that cannot run the tests is not a
  // reviewer, and one that cannot run them but says it did is worse than none.
  //
  // Still PINNED either way, which is the part worth keeping: the value is whatever this posture
  // decided, so a user's `config.toml` cannot widen it under `guarded` and cannot narrow it under
  // `unguarded`. What changed is that the pin has a reason on both settings instead of one.
  const networkAccess = spec.posture === 'unguarded';
  const args: string[] = [
    '-c',
    `sandbox_workspace_write.network_access=${String(networkAccess)}`,
  ];
  if (excludeSlashTmp) args.push('-c', 'sandbox_workspace_write.exclude_slash_tmp=true');
  if (excludeTmpDir) args.push('-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true');

  const writableRoots = [cwd];
  if (!excludeSlashTmp) writableRoots.push(slashTmp);
  if (!excludeTmpDir && tmpDir !== null) writableRoots.push(tmpDir);

  return { args, writableRoots, networkAccess, enforced, unenforceable, breaches };
}

/** The message used both by the refusal and by the test that proves the refusal fires. */
export function codexBreachMessage(spec: SoldierSpec, confinement: CodexConfinement): string {
  return (
    `refusing to spawn codex soldier ${spec.agentId}: ${String(confinement.breaches.length)} deny rule(s) ` +
    `cannot be enforced because the path they protect is inside a writable root ` +
    `(${confinement.writableRoots.join(', ')}). codex exec has no per-tool permission model, so an ` +
    `unenforceable write-deny is silently absent rather than merely degraded. Rules: ` +
    confinement.breaches.join(', ')
  );
}

/**
 * Same flag-injection hazard as the claude side: a spec value that begins with `-` lands in an
 * argv value slot and is parsed as a flag. `--dangerously-bypass-approvals-and-sandbox` arriving
 * through `spec.model` would hand a reviewer full machine access.
 */
function assertNotFlagLike(field: string, value: string): void {
  if (value.startsWith('-')) {
    throw new Error(
      `SoldierSpec.${field} may not begin with "-" (got ${JSON.stringify(value)}): it would be parsed as a CLI flag`,
    );
  }
}

/**
 * Build the argv for a one-shot run. Pure, so the "never sets CODEX_HOME", "stdin is ignored" and
 * "sandbox is workspace-write" guards can assert on it without spawning anything.
 */
/** Every spec field that reaches an argv VALUE slot. Shared by `spawn` (fail fast) and argv build. */
export function assertCodexSpecArgSafe(spec: SoldierSpec): void {
  if (spec.model !== undefined) assertNotFlagLike('model', spec.model);
  if (spec.outputSchemaPath !== undefined) assertNotFlagLike('outputSchemaPath', spec.outputSchemaPath);
  assertNotFlagLike('cwd', spec.cwd);
  if (spec.resumeSessionId !== undefined) assertNotFlagLike('resumeSessionId', spec.resumeSessionId);
}

export function buildCodexArgs(spec: SoldierSpec, prompt: string, options?: CodexArgsOptions): string[] {
  assertCodexSpecArgSafe(spec);

  // `exec resume` accepts a narrower flag set than `exec`: no `-C`, no `-s`, no `--color`. The
  // process cwd is already `spec.cwd`, and the sandbox mode goes in as a `-c` override so the
  // resumed turn is confined exactly like the first one.
  if (spec.resumeSessionId !== undefined) {
    const resumed = [
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'sandbox_mode="workspace-write"',
    ];
    resumed.push(...(options?.confinement ?? codexConfinement(spec)).args);
    if (options?.outputPath !== undefined) resumed.push('-o', options.outputPath);
    if (spec.outputSchemaPath !== undefined && spec.outputSchemaPath !== '') {
      resumed.push('--output-schema', spec.outputSchemaPath);
    }
    if (spec.model !== undefined && spec.model !== '') resumed.push('-m', spec.model);
    if (spec.effort !== undefined) resumed.push('-c', `model_reasoning_effort=${CODEX_EFFORT[spec.effort]}`);
    resumed.push('--', spec.resumeSessionId, prompt);
    return resumed;
  }

  const args = [
    'exec',
    '--json',
    // Stable text: no ANSI escapes leaking into the stderr tail we may quote back to a human.
    '--color',
    'never',
    // A cold worktree or a scratch cwd is not always a repo; without this, non-interactive exec
    // hard-errors instead of running.
    '--skip-git-repo-check',
    '-C',
    spec.cwd,
    // An INSPECTOR must run the test suite, and a suite writes (.pytest_cache,
    // node_modules/.cache, build dirs). `read-only` would fail most of them.
    '-s',
    'workspace-write',
  ];

  // Sandbox tightening — see `codexConfinement` for exactly what is and is not enforced.
  args.push(...(options?.confinement ?? codexConfinement(spec)).args);

  if (options?.outputPath !== undefined) args.push('-o', options.outputPath);

  // codex takes the schema as a FILE PATH; claude takes it inline. That asymmetry stops here.
  if (spec.outputSchemaPath !== undefined && spec.outputSchemaPath !== '') {
    args.push('--output-schema', spec.outputSchemaPath);
  }
  if (spec.model !== undefined && spec.model !== '') args.push('-m', spec.model);

  // MEASURED: there is no `--reasoning-effort` flag; it is a `-c` override. Probing the API with a
  // bad value returns the authoritative enum: none|minimal|low|medium|high|xhigh|max.
  //
  // BUT the enum being accepted is not the same as the value being USABLE. `minimal` 400s against
  // the default toolset:
  //   "The following tools cannot be used with reasoning.effort 'minimal': web_search."
  // so it is mapped UP to `low` — the same direction claude's adapter maps it, and an upgrade
  // rather than the downgrade firstmate's dispatch rule forbids.
  if (spec.effort !== undefined) {
    args.push('-c', `model_reasoning_effort=${CODEX_EFFORT[spec.effort]}`);
  }

  // `--` before the positional prompt, ALWAYS.
  //
  // Orders are free text, and clap parses a leading `-` as a flag:
  //   $ codex exec ... "--bare-looking-prompt"
  //   error: unexpected argument '--bare-looking-prompt' found
  //   tip: to pass '--bare-looking-prompt' as a value, use '-- --bare-looking-prompt'
  // Without this, a brief that happens to begin with a dash either fails the run or — far worse —
  // injects a real flag. Unconditional, so there is no "did we need it this time" judgement.
  args.push('--', prompt);
  return args;
}

/**
 * Variables a caller is permitted to inject through `spec.env`.
 *
 * An ALLOW-list, not a deny-list, and the reason is the failure mode: getting this wrong is silent
 * and expensive. A deny-list only ever knows about the hazards somebody already thought to write
 * down, so the first unknown-unknown gets through — and here "getting through" means a worker that
 * quietly falls off the ChatGPT subscription onto API-key billing, or into a 401 retry storm.
 *
 * Deliberately narrow. Anything a codex worker legitimately needs from the ambient environment it
 * already has, because `process.env` is inherited wholesale (see below); this list only governs
 * what a SPEC may add on top.
 */
export const CODEX_ENV_ALLOW = [
  // Proxy / TLS — a worker behind a corporate proxy needs these and they carry no auth identity.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // Locale and diagnostics.
  'LANG',
  'LC_ALL',
  'TZ',
  'RUST_LOG',
  'RUST_BACKTRACE',
] as const;

/**
 * Injecting any of these takes the worker off the stored ChatGPT login. `CODEX_HOME` is the
 * headline hazard: with a fresh `CODEX_HOME` the login is simply gone and codex falls through to
 * `OPENAI_API_KEY` — measured as either API billing or `401 Unauthorized` x5. These throw rather
 * than being dropped, because a caller that asked for credential isolation and silently did not
 * get it is worse off than one that got an error.
 */
export const CODEX_ENV_FORBIDDEN = [
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
] as const;

const ALLOW_SET: ReadonlySet<string> = new Set(CODEX_ENV_ALLOW);
const FORBIDDEN_SET: ReadonlySet<string> = new Set(CODEX_ENV_FORBIDDEN);

/** Our own variables are always forwardable — they cannot influence codex's auth. */
export function isForwardableCodexEnvKey(key: string): boolean {
  if (FORBIDDEN_SET.has(key)) return false;
  return key.startsWith('ARMY_') || ALLOW_SET.has(key);
}

export interface CodexEnvResult {
  env: NodeJS.ProcessEnv;
  /** `spec.env` keys that were not forwarded, so the adapter can say so out loud. */
  dropped: string[];
}

/**
 * The child's environment, with the reasoning split across the two halves:
 *
 *   - **`process.env` is inherited wholesale.** That inheritance IS the auth story: codex
 *     only needs `HOME` to find `auth.json`. It also means a commander who has legitimately
 *     relocated their own `CODEX_HOME` keeps working — filtering the ambient environment would
 *     break exactly the setup we are trying to protect.
 *   - **`spec.env` is policed**, because that is the injection vector an orchestrator controls.
 *
 * Note the adapter NEVER introduces `CODEX_HOME` of its own accord either.
 */
export function buildCodexEnvDetailed(
  spec: SoldierSpec,
  base: NodeJS.ProcessEnv = process.env,
): CodexEnvResult {
  const extra = spec.env ?? {};
  for (const key of Object.keys(extra)) {
    if (FORBIDDEN_SET.has(key)) {
      throw new Error(
        `SoldierSpec.env may not set ${key}: it drops the stored ChatGPT login and falls back to ` +
          `an API key. Codex workers inherit the commander's credentials.`,
      );
    }
  }
  const env: NodeJS.ProcessEnv = { ...base };
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(extra)) {
    if (isForwardableCodexEnvKey(key)) env[key] = value;
    else dropped.push(key);
  }
  return { env, dropped };
}

/** Convenience wrapper — the env only. */
export function buildCodexEnv(
  spec: SoldierSpec,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildCodexEnvDetailed(spec, base).env;
}

// ---------------------------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * MEASURED: `cached_input_tokens` is a SUBSET of `input_tokens` (23443 in / 12032 cached), the
 * opposite of claude's disjoint accounting — so the total is input + output, not a sum of all
 * four buckets. `reasoning_output_tokens` is likewise inside `output_tokens`.
 */
function codexUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const usage: TokenUsage = {};
  const input = num(raw['input_tokens']);
  const output = num(raw['output_tokens']);
  const cached = num(raw['cached_input_tokens']);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cached !== undefined) usage.cacheReadInputTokens = cached;
  if (input !== undefined || output !== undefined) {
    usage.totalTokens = (input ?? 0) + (output ?? 0);
  }
  return Object.keys(usage).length === 0 ? undefined : usage;
}

export interface CodexNormalizer {
  next(line: JsonlLine, receivedAt?: string): SoldierEvent[];
  /** Captured from `thread.started` on the first line. `null` until then. */
  readonly threadId: string | null;
  /** 0-based; incremented by every `turn.started`. */
  readonly turn: number;
}

export interface CodexNormalizerOptions {
  /** Monotonic milliseconds. Codex emits NO duration and NO cost, so we time it ourselves. */
  now?: () => number;
}

function monotonicMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * Stateful for two reasons the wire format forces on us:
 *
 *   - **Item ids restart at `item_0` on every turn**, including after `resume`. Keying tool_use /
 *     tool_result on `item.id` alone collides across turns, so the correlation key is
 *     `<thread_id>#<turn>#<item.id>`.
 *   - **There is no duration and no cost anywhere in `exec --json`.** We measure elapsed time with
 *     a monotonic clock and leave `costUsd` undefined rather than inventing a figure.
 */
export function createCodexNormalizer(options?: CodexNormalizerOptions): CodexNormalizer {
  const now = options?.now ?? monotonicMs;
  const startedAt = now();
  let turnStartedAt = startedAt;
  let threadId: string | null = null;
  let turn = 0;

  function key(itemId: string): string {
    return `${threadId ?? 'thread'}#${String(turn)}#${itemId}`;
  }

  const normalizer: CodexNormalizer = {
    get threadId(): string | null {
      return threadId;
    },
    get turn(): number {
      return turn;
    },
    next(line: JsonlLine, receivedAt?: string): SoldierEvent[] {
      const ts = receivedAt ?? new Date().toISOString();

      // stderr is chatty on this harness and is captured separately, but a stray non-JSON line on
      // stdout must still not kill the stream.
      if (!line.ok) {
        return [
          { type: 'unknown', ts, raw: line.text, parentToolUseId: null, depth: 0, harnessType: 'noise' },
        ];
      }

      const rec = line.value;
      if (!isRecord(rec)) {
        return [{ type: 'unknown', ts, raw: rec, parentToolUseId: null, depth: 0 }];
      }

      // `codex exec` has no subagent layer in its JSONL, so every event is top-level by
      // construction. The contract's org-chart fields are still populated, not omitted.
      const base = { ts, raw: rec, parentToolUseId: null, depth: 0 };
      const kind = str(rec['type']);
      const unknown = (harnessType?: string): SoldierEvent[] => [
        harnessType === undefined
          ? { type: 'unknown', ...base }
          : { type: 'unknown', ...base, harnessType },
      ];

      if (kind === 'thread.started') {
        threadId = str(rec['thread_id']) ?? null;
        return [
          {
            type: 'ready',
            ...base,
            // NOTE: this is the CODEX-minted thread id, not `spec.sessionId`. The mismatch is
            // structural for this harness, not the bug the contract warns about.
            sessionId: threadId ?? '',
            capabilities: [],
          },
        ];
      }

      if (kind === 'turn.started') {
        turn += 1;
        turnStartedAt = now();
        return unknown('turn.started');
      }

      if (kind === 'turn.completed') {
        return [
          {
            type: 'result',
            ...base,
            status: 'ok',
            durationMs: now() - turnStartedAt,
            ...(codexUsage(rec['usage']) === undefined ? {} : { usage: codexUsage(rec['usage']) }),
          },
        ];
      }

      if (kind === 'turn.failed') {
        const error = rec['error'];
        const message = (isRecord(error) ? str(error['message']) : undefined) ?? 'turn failed';
        // Emit BOTH: the error for triage, and a terminal result so that every codex stream ends
        // the same way a claude stream does. A caller waiting for `result` must not hang because
        // the run happened to fail.
        return [
          { type: 'error', ...base, message },
          { type: 'result', ...base, status: 'error', durationMs: now() - turnStartedAt },
        ];
      }

      if (kind === 'error') {
        return [{ type: 'error', ...base, message: str(rec['message']) ?? 'codex error' }];
      }

      if (kind === 'item.started' || kind === 'item.completed' || kind === 'item.updated') {
        const item = rec['item'];
        if (!isRecord(item)) return unknown(kind);
        const itemType = str(item['type']) ?? 'unknown';
        const itemId = str(item['id']) ?? '';

        if (kind === 'item.completed' && (itemType === 'agent_message' || itemType === 'reasoning')) {
          // `reasoning` is folded into assistant_text to stay symmetric with the claude adapter's
          // handling of `thinking`; the contract has no thinking variant. `raw` keeps the
          // distinction for anyone who needs it.
          return [{ type: 'assistant_text', ...base, text: str(item['text']) ?? '' }];
        }

        if (kind === 'item.completed' && itemType === 'error') {
          // ADVISORY, not fatal — e.g. "Model metadata not found. Defaulting to fallback". The
          // fatal signal is the top-level `error` + `turn.failed` pair, which is what actually
          // drives `status`; this only surfaces the warning.
          return [{ type: 'error', ...base, message: str(item['message']) ?? 'codex item error' }];
        }

        if (CODEX_TOOL_ITEMS.has(itemType)) {
          if (kind === 'item.started') {
            return [{ type: 'tool_use', ...base, name: itemType, toolUseId: key(itemId), input: item }];
          }
          if (kind === 'item.completed') {
            const exitCode = num(item['exit_code']);
            return [
              {
                type: 'tool_result',
                ...base,
                toolUseId: key(itemId),
                isError: exitCode !== undefined && exitCode !== 0,
                content: item,
              },
            ];
          }
        }

        return unknown(`${kind}/${itemType}`);
      }

      return unknown(kind);
    },
  };

  return normalizer;
}

// ---------------------------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------------------------

/**
 * A codex soldier, with the two things the neutral `Soldier` interface has nowhere to put:
 * the Codex-minted thread id (the foreign key for `codex exec resume`) and the raw text of the
 * `-o` file (the schema-capped return path).
 */
export interface CodexSoldier extends KillableSoldier {
  /** `thread.started.thread_id`, or null before the first line / if the run never started. */
  readonly codexThreadId: string | null;
  /** Raw contents of `--output-last-message`, or null when the run failed and never wrote it. */
  readonly outputText: string | null;
}

/** Narrow a neutral `Soldier` back to a codex one. */
export function isCodexSoldier(soldier: Soldier): soldier is CodexSoldier {
  return soldier.spec.harness === 'codex' && 'codexThreadId' in soldier;
}

/** The Codex thread id for `codex exec resume`, or null if this is not a codex soldier. */
export function codexThreadId(soldier: Soldier): string | null {
  return isCodexSoldier(soldier) ? soldier.codexThreadId : null;
}

export interface CodexAdapterOptions {
  /** Binary to spawn. `ARMY_CODEX_BIN` overrides it out of band. */
  bin?: string;
  /** Wall-clock ceiling for one `codex exec`. Exceeding it yields `status: 'timeout'`. */
  timeoutMs?: number;
  /** Grace period after SIGTERM before SIGKILL. */
  killGraceMs?: number;
}

const CODEX_DEFAULTS = {
  timeoutMs: 30 * 60_000,
  killGraceMs: 5_000,
};

const STDERR_TAIL_CHARS = 4096;

export function createCodexAdapter(options?: CodexAdapterOptions): HarnessAdapter {
  const bin = options?.bin ?? process.env['ARMY_CODEX_BIN'] ?? 'codex';
  const timeoutMs = options?.timeoutMs ?? CODEX_DEFAULTS.timeoutMs;
  const killGraceMs = options?.killGraceMs ?? CODEX_DEFAULTS.killGraceMs;
  return {
    id: 'codex',
    // `exec --json` is turn-based. `send` is valid exactly once; `interrupt` rejects rather
    // than pretending.
    supportsDuplex: false,
    spawn(spec: SoldierSpec): Promise<Soldier> {
      // Permission boundary check, BEFORE a process exists. Refuse rather than run a worker whose
      // deny-list is decorative — a boundary that is silently absent is worse than one that is
      // explicitly unavailable.
      // Same rule as claude's spawn: every failure on an async-typed method rejects.
      try {
        assertCodexSpecArgSafe(spec);
        const confinement = codexConfinement(spec);
        if (confinement.breaches.length > 0) {
          return Promise.reject(new Error(codexBreachMessage(spec, confinement)));
        }
        return Promise.resolve(makeCodexSoldier(spec, bin, timeoutMs, killGraceMs, confinement));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

export const codexAdapter: HarnessAdapter = createCodexAdapter();

function makeCodexSoldier(
  spec: SoldierSpec,
  bin: string,
  timeoutMs: number,
  killGraceMs: number,
  confinement: CodexConfinement,
): CodexSoldier {
  const queue = createAsyncQueue<SoldierEvent>();
  const normalizer = createCodexNormalizer();
  const framer = createJsonlFramer();
  const createdAt = process.hrtime.bigint();

  let child: ChildProcess | null = null;
  let started = false;
  let processExited = false;
  /**
   * `exit` has fired — the PROCESS is gone, whatever its pipes are doing. Distinct from
   * `processExited`, which this file keys on `close` (exit + stdio EOF): a grandchild holding an
   * inherited write end delays `close` indefinitely, and a `close`-only wait registered after
   * the child already died waits for an event that fired before anyone listened.
   */
  let processGone = false;
  let stdoutEnded = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let timedOut = false;
  let hardKilled = false;
  /**
   * Set by `killTree()`. Codex launches its child in `send()`, not `spawn()`, so an abort can
   * land in the window where the soldier exists and its process does not — without this flag a
   * killed-before-launch soldier would go on to start the very process the kill was for.
   */
  let treeKilled = false;
  let stderrTail = '';
  let outputText: string | null = null;
  let resultCount = 0;
  let missingDemandedOutput = false;
  const schemaDemanded = spec.outputSchemaPath !== undefined && spec.outputSchemaPath !== '';
  let closePromise: Promise<CloseResult> | null = null;
  let tempDir: string | null = null;
  let outputPath: string | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  const seenAssistantText = new Set<string>();

  function elapsedMs(): number {
    return Number(process.hrtime.bigint() - createdAt) / 1e6;
  }

  function emit(event: SoldierEvent): void {
    if (event.type === 'assistant_text') seenAssistantText.add(event.text.trim());
    if (event.type === 'result') resultCount += 1;
    queue.push(event);
  }

  function emitSynthetic(message: string, source: string): void {
    emit({
      type: 'error',
      ts: new Date().toISOString(),
      raw: { __source: source, message },
      parentToolUseId: null,
      depth: 0,
      message,
    });
  }

  function handleLine(line: JsonlLine): void {
    for (const event of normalizer.next(line)) emit(event);
  }

  /**
   * Put the confinement on the record, at the head of the stream.
   *
   * stream.jsonl is both the live view and the replay, so a limitation announced here is
   * visible in the dashboard AND recoverable months later when someone asks what the Inspector was
   * actually prevented from doing. `unknown` is the honest carrier: it is not an error (the run is
   * proceeding), and the contract has no variant for "structured note from the adapter".
   */
  function announceConfinement(): void {
    emit({
      type: 'unknown',
      ts: new Date().toISOString(),
      raw: {
        __source: 'agentic-army/codex-adapter',
        kind: 'confinement',
        harness: 'codex',
        sandbox: 'workspace-write',
        writableRoots: confinement.writableRoots,
        enforced: confinement.enforced,
        // The load-bearing half: these rules are RECORDED INTENT ONLY on this harness.
        unenforceable: confinement.unenforceable,
        note:
          'codex exec has no per-tool permission model. Only rooted write-denies outside the ' +
          'writable roots are enforced; read-denies and Bash command-denies are advisory.',
      },
      parentToolUseId: null,
      depth: 0,
      harnessType: 'agentic-army/confinement',
    });
  }

  function finish(): void {
    if (!(processExited && stdoutEnded) || queue.ended) return;

    // The schema-constrained return. Recon verified the `-o` file and the last
    // `agent_message` are byte-identical, so the normal path emits nothing extra here — this is
    // the rescue for a run whose JSONL was truncated but whose file landed.
    if (outputPath !== null && existsSync(outputPath)) {
      try {
        const text = readFileSync(outputPath, 'utf8');
        outputText = text;
        if (text.trim() !== '' && !seenAssistantText.has(text.trim())) {
          emit({
            type: 'assistant_text',
            ts: new Date().toISOString(),
            raw: { __source: 'codex:output-last-message', path: outputPath, text },
            parentToolUseId: null,
            depth: 0,
            text,
          });
        }
      } catch (err) {
        emitSynthetic(
          `could not read --output-last-message at ${outputPath}: ${err instanceof Error ? err.message : String(err)}`,
          'agentic-army/codex-adapter',
        );
      }
    } else if (started && exitCode !== 0) {
      // MEASURED: a failing run exits 1 and the `-o` file is never created. "Absent" is a distinct
      // failure mode from "present but unparseable" and must not be a stat() surprise later.
      emitSynthetic(
        `codex exited ${String(exitCode)} without writing --output-last-message${stderrTail.trim() === '' ? '' : `: ${stderrTail.trim()}`}`,
        'agentic-army/codex-adapter',
      );
    }

    if (started && schemaDemanded && outputText === null && exitCode === 0 && !silentlyDied()) {
      // `outputSchemaPath` means the caller DEMANDED a schema-capped return. A run that
      // reached `turn.completed` but produced no `-o` file has not delivered it, and a quiet
      // `outputText: null` alongside `status: 'ok'` invites the caller to treat "no verdict" as
      // "no findings". Absence of a demanded artifact is a failure, not a null.
      emitSynthetic(
        `codex completed but produced no structured output, though --output-schema was demanded ` +
          `(${spec.outputSchemaPath ?? ''})`,
        'agentic-army/codex-adapter',
      );
      missingDemandedOutput = true;
    }

    if (silentlyDied()) {
      // EXIT 0 WITH NOTHING TO SHOW FOR IT — the most dangerous state this adapter can be in.
      //
      // The INSPECTOR runs on codex, and the Inspector is the gate between unreviewed
      // code and delivery. A reviewer that dies silently and is recorded as `ok` is a gate that
      // passes a branch it never read, which is strictly worse than having no gate at all: the
      // campaign now has positive evidence of a review that did not happen.
      emitSynthetic(
        `codex exited ${String(exitCode)} having produced no result event and no structured output` +
          ` (${String(resultCount)} results, output file ${outputText === null ? 'absent' : 'present'})` +
          `${stderrTail.trim() === '' ? '' : `: ${stderrTail.trim()}`}`,
        'agentic-army/codex-adapter',
      );
    }

    cleanupTemp();
    queue.end();
  }

  function cleanupTemp(): void {
    if (tempDir === null) return;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    tempDir = null;
  }

  function launch(prompt: string): void {
    started = true;
    // The abort landed before the process existed. Refuse to start one: a kill that is answered
    // by a fresh spawn is not a kill, and the caller reaching for `killTree` is a supervisor
    // that has already promised its user nothing outlives it.
    if (treeKilled) {
      emitSynthetic('soldier was killed before its process launched', 'agentic-army/codex-adapter');
      processExited = true;
      stdoutEnded = true;
      finish();
      return;
    }
    announceConfinement();
    try {
      tempDir = mkdtempSync(join(tmpdir(), 'army-codex-'));
      outputPath = join(tempDir, 'last-message.json');
    } catch {
      tempDir = null;
      outputPath = null;
    }

    const args = buildCodexArgs(spec, prompt, { confinement, ...(outputPath === null ? {} : { outputPath }) });
    let env: NodeJS.ProcessEnv;
    try {
      const built = buildCodexEnvDetailed(spec);
      env = built.env;
      if (built.dropped.length > 0) {
        emitSynthetic(
          `spec.env keys not forwarded to the codex child (not on CODEX_ENV_ALLOW): ${built.dropped.join(', ')}`,
          'agentic-army/codex-adapter',
        );
      }
    } catch (err) {
      emitSynthetic(
        err instanceof Error ? err.message : String(err),
        'agentic-army/codex-adapter',
      );
      processExited = true;
      stdoutEnded = true;
      finish();
      return;
    }

    try {
      child = spawn(bin, args, {
        cwd: spec.cwd,
        env,
        // THE most important line in this file. An open stdin pipe makes `codex exec` wait for an
        // EOF that never arrives: 0 bytes of output, no error, forever.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Own process group on POSIX, so `killTree()` reaches everything codex spawned and the
        // terminal's Ctrl-C reaches only the supervisor. See `./kill.ts`.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      emitSynthetic(
        `failed to spawn \`${bin}\`: ${err instanceof Error ? err.message : String(err)}`,
        'agentic-army/codex-adapter',
      );
      processExited = true;
      stdoutEnded = true;
      finish();
      return;
    }

    const proc = child;
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of framer.push(chunk)) handleLine(line);
    });
    proc.stdout?.on('end', () => {
      for (const line of framer.flush()) handleLine(line);
      stdoutEnded = true;
      finish();
    });
    proc.stdout?.on('error', () => {
      stdoutEnded = true;
      finish();
    });
    // MEASURED: `Reading additional input from stdin...` and tracing lines always go to stderr,
    // even on a clean run. Non-empty stderr is NOT a failure signal — keep it out of the JSONL.
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    proc.stderr?.on('error', () => {});
    proc.on('error', (err: Error) => {
      emitSynthetic(`failed to spawn \`${bin}\`: ${err.message}`, 'agentic-army/codex-adapter');
      processExited = true;
      stdoutEnded = true;
      finish();
    });
    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // Recorded HERE, not only on `close`, because `close` can be held hostage by a pipe some
      // grandchild inherited — and the exit code must survive that. Registered at launch so a
      // `close()` that starts after a fast child died still knows the process is gone.
      processGone = true;
      if (exitCode === null) exitCode = code;
      if (exitSignal === null) exitSignal = signal;
    });
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal;
      processExited = true;
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      finish();
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      const hard = setTimeout(() => {
        hardKilled = true;
        // The group, not the direct child — same reasoning as the claude adapter's escalation:
        // a grandchild that inherited the stdout write end keeps `close` from ever firing after
        // the child alone is killed, and `codex exec` runs real tools that spawn real processes.
        killProcessTree(proc);
      }, killGraceMs);
      hard.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();
  }

  /**
   * The run was launched and came back with neither a `result` event nor structured output.
   *
   * Both halves matter: a truncated JSONL stream that still wrote its `-o` file did produce the
   * verdict, and a `turn.completed` with no file is still evidence the model ran.
   */
  function silentlyDied(): boolean {
    return started && resultCount === 0 && outputText === null;
  }

  function finalStatus(): SoldierStatus {
    if (hardKilled) return 'killed';
    if (timedOut) return 'timeout';
    if (!started) return 'ok';
    if (exitSignal !== null) return 'killed';
    // Checked before the exit code: exit 0 is precisely what makes a dead worker look successful.
    if (silentlyDied()) return 'error';
    if (missingDemandedOutput) return 'error';
    if (exitCode === 0) return 'ok';
    return 'error';
  }

  const soldier: CodexSoldier = {
    id: spec.agentId,
    spec,

    get codexThreadId(): string | null {
      return normalizer.threadId;
    },
    get outputText(): string | null {
      return outputText;
    },

    /**
     * The abort seam — see `./kill.ts`. `hardKilled` makes `close()` report `killed` even on the
     * pre-launch path, and the flag stops a not-yet-launched soldier from starting a process
     * AFTER its own kill.
     */
    killTree(): void {
      treeKilled = true;
      if (child !== null && !processExited) {
        hardKilled = true;
        killProcessTree(child);
      }
    },

    /**
     * Launches the run. Turn-based: valid exactly once.
     *
     * `spawn()` deliberately does not auto-start, so the caller's sequence is IDENTICAL for both
     * harnesses — `spawn(spec)` / consume `stream()` / `send(spec.orders)` / `close()`. The
     * one-shot vs duplex difference stays inside the seam.
     */
    send(text: string): Promise<void> {
      if (closePromise !== null) return Promise.reject(new Error(`soldier ${spec.agentId} is closed`));
      if (started) {
        return Promise.reject(
          new Error(
            `soldier ${spec.agentId} runs on codex exec (turn-based): send() is valid exactly once`,
          ),
        );
      }
      // MUST NOT THROW. `send` is typed `Promise<void>`, so a caller's `.catch()` never sees a
      // synchronous throw — it propagates out of the call site and takes the process with it.
      // `launch` reaches `buildCodexArgs`, which throws on a flag-like spec value.
      try {
        launch(text);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return Promise.resolve();
    },

    stream(): AsyncIterable<SoldierEvent> {
      return { [Symbol.asyncIterator]: () => queue.iterator() };
    },

    /** No interrupt on `codex exec`. Reject rather than pretend — the contract is explicit. */
    interrupt(): Promise<void> {
      return Promise.reject(
        new Error(
          `soldier ${spec.agentId} runs on codex exec (turn-based); interrupt is not supported (app-server is out of scope for v1)`,
        ),
      );
    },

    close(): Promise<CloseResult> {
      if (closePromise !== null) return closePromise;
      closePromise = (async (): Promise<CloseResult> => {
        if (!started) {
          // Nothing was ever asked of this soldier. A clean no-op, genuinely `ok`.
          cleanupTemp();
          queue.end();
          return { exitCode: null, status: 'ok', durationMs: elapsedMs() };
        }
        if (child === null) {
          // We TRIED to launch and no process exists: the credential guard refused, or spawn threw.
          // The old `!started || child === null` short-circuit reported this as `ok` — and since
          // the INSPECTOR is the codex role, a review that never ran was being recorded as a clean
          // run. Same class as the silent-death bug, one step earlier.
          processExited = true;
          stdoutEnded = true;
          finish();
          return { exitCode: null, status: 'error', durationMs: elapsedMs() };
        }
        const proc = child;
        if (!processExited) {
          // Anchored on `exit`, bounded on `close`. `close` is the event the rest of this file
          // keys on, but it fires only once the child's stdio pipes reach EOF — and a process
          // the child spawned with inherited stdio holds those write ends open after the child
          // itself is gone, so a `close`-only wait here is unbounded. `exit` fires the moment
          // the process dies regardless of pipes; after it, the streams get one kill-grace to
          // drain normally and then this stops waiting for an EOF that cannot come.
          let reaped = false;
          await new Promise<void>((resolve) => {
            if (processExited) {
              reaped = true;
              resolve();
              return;
            }
            proc.once('close', () => {
              reaped = true;
              resolve();
            });
            const afterExit = (): void => {
              const drain = setTimeout(resolve, killGraceMs);
              drain.unref?.();
            };
            // `processGone`, not a fresh `once('exit')` alone: a fast child dies before close()
            // is ever called, and a listener registered after the event waits forever.
            if (processGone) afterExit();
            else proc.once('exit', afterExit);
          });
          if (!reaped) {
            // Same backstop as the claude adapter and `runResolved`: a survivor still holding
            // our pipe ends would keep the CALLER's event loop alive forever, so our ends are
            // destroyed and the child unreferenced. The `-o` output file is unaffected — it is
            // a file, not a pipe, and was read (or found absent) by the stream handlers.
            try {
              proc.stdout?.destroy();
            } catch {
              /* already gone */
            }
            try {
              proc.stderr?.destroy();
            } catch {
              /* already gone */
            }
            proc.unref();
          }
        }
        stdoutEnded = true;
        processExited = true;
        finish();
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        return {
          exitCode,
          status: finalStatus(),
          durationMs: elapsedMs(),
          // No cost field exists anywhere in `exec --json`. Leaving it undefined is the honest
          // answer; inventing one from a price table would put a fiction in the campaign ledger.
        };
      })();
      return closePromise;
    },
  };

  return soldier;
}
