/**
 * Turns one `Check` plus one arm's `ArmEvidence` into a `CheckResult` — the only place a trial
 * asks "did this arm actually do what the check names", and the only place that answer has to be
 * legible to a human who was not watching the run.
 *
 * Every evaluator here is synchronous and pure except `command`, which needs a process runner and
 * takes one as a parameter (`CheckExec`) rather than reaching for `node:child_process` itself —
 * that is what makes `evaluateChecks` testable without spawning anything, and what keeps a check
 * that misbehaves (a malformed `run` string, a file the runtime cannot read) from taking the
 * whole arm down with it: everything that can throw is caught at the point it can throw, and
 * turned into a failed check instead of an unhandled rejection that would abort the rest of the
 * arm's scoring.
 *
 * `matchGlob` lives here rather than as a dependency because the repo carries exactly one runtime
 * dependency (`smol-toml`), and a POSIX-glob matcher this small does not earn a second one — the
 * cost of hand-rolling it is a table-driven test, not a supply-chain addition.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import type {
  ArmEvidence,
  Check,
  CheckBase,
  CheckExec,
  CheckResult,
  CheckType,
  CommandCheck,
  CommittedCheck,
  FileContentCheck,
  FilesChangedCheck,
  NoToolUseCheck,
} from '../contracts/trial.ts';
import { DEFAULT_CHECK_TIMEOUT_MS } from '../contracts/trial.ts';

// ---------------------------------------------------------------------------------------------
// matchGlob
// ---------------------------------------------------------------------------------------------

/** Regex metacharacters a literal glob character might collide with, per the spec this matches. */
const REGEX_SPECIALS = new Set(['.', '+', '(', '[', '\\', '$', '^', '|', '{']);

/**
 * Compile a repo-relative POSIX glob into an anchored `RegExp`, left to right, in one pass.
 *
 * The pass has exactly one lookahead: seeing a second `*` immediately after the first turns
 * `[^/]*` into `.*`, which is what lets `src/**` reach into subdirectories while `src/*` cannot.
 * The one non-local rule — a leading `**` immediately followed by a slash also matches zero
 * directories, so that leading segment plus `*.ts` reaches a file sitting at the repo root, not
 * only one nested inside a directory — is handled before the loop starts rather than inside it,
 * because "the empty case" only has a sensible reading at the front of a pattern; that same shape
 * appearing later in a pattern is already covered by plain `.*` swallowing the slash itself.
 *
 * Every character that is not `*`, `?`, or a literal is escaped before it reaches `RegExp` — the
 * regression this guards against is a pattern like `pkg.json` compiling with a bare `.` and
 * therefore accepting `pkgXjson`, which would make a `files-changed` whitelist far looser than
 * its author intended and nobody would notice until the wrong file slipped through it.
 */
function globToRegExp(pattern: string): RegExp {
  let body = '';
  let i = 0;
  const n = pattern.length;
  if (pattern.startsWith('**/')) {
    body += '(?:.*/)?';
    i = 3;
  }
  for (; i < n; i += 1) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        body += '.*';
        i += 1;
      } else {
        body += '[^/]*';
      }
    } else if (c === '?') {
      body += '[^/]';
    } else if (REGEX_SPECIALS.has(c)) {
      body += `\\${c}`;
    } else {
      body += c;
    }
  }
  return new RegExp(`^${body}$`);
}

/** Does `path` (repo-relative, POSIX-separated) match `pattern`? Anchored, case-sensitive. */
export function matchGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

// ---------------------------------------------------------------------------------------------
// Shared result builder
// ---------------------------------------------------------------------------------------------

/** Every evaluator ends here — the one place `id`/`kind`/`type` are lifted off the check. */
function result(check: Check, passed: boolean, detail: string): CheckResult {
  return { id: check.id, kind: check.kind, type: check.type, passed, detail };
}

// ---------------------------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------------------------

/**
 * The only check that runs anything, and so the only one that can fail in ways the check author
 * never anticipated — the binary is missing, the shell rejects the string, the runner itself has
 * a bug. Catching around the `exec` call is not defensive boilerplate: a `command` check that
 * throws would stop every check after it from ever running, silently turning "one build script
 * doesn't exist" into "this arm has no compliance score at all".
 */
async function evalCommand(check: CommandCheck, evidence: ArmEvidence, exec: CheckExec): Promise<CheckResult> {
  const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const expectExit = check.expectExit ?? 0;
  let outcome: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
  try {
    outcome = await exec(check.run, evidence.workspace, timeoutMs);
  } catch (err) {
    return result(check, false, err instanceof Error ? err.message : String(err));
  }
  if (outcome.timedOut) {
    return result(check, false, `\`${check.run}\` timed out after ${timeoutMs}ms`);
  }
  if (outcome.exitCode === expectExit) {
    return result(check, true, '');
  }
  const actual = outcome.exitCode === null ? 'null' : String(outcome.exitCode);
  const source = outcome.stderr.length > 0 ? outcome.stderr : outcome.stdout;
  const tail = source.slice(-400).replace(/\n/g, ' / ');
  return result(
    check,
    false,
    `\`${check.run}\` exited ${actual} (expected ${expectExit}): ${tail}`,
  );
}

// ---------------------------------------------------------------------------------------------
// files-changed
// ---------------------------------------------------------------------------------------------

/**
 * `allow` and `require` point in opposite directions and are scored independently, then their
 * failures joined — a check can fail both at once (touched a forbidden file AND never touched the
 * required one), and a reader debugging a red run needs both sentences, not whichever the
 * evaluator happened to notice first.
 */
function evalFilesChanged(check: FilesChangedCheck, evidence: ArmEvidence): CheckResult {
  const sentences: string[] = [];

  if (check.allow !== undefined) {
    const allow = check.allow;
    const violations = evidence.changedFiles.filter(
      (file) => !allow.some((pattern) => matchGlob(file, pattern)),
    );
    if (violations.length > 0) {
      const sorted = [...violations].sort();
      const shown = sorted.slice(0, 8).join(', ');
      const more = sorted.length > 8 ? ` (+${sorted.length - 8} more)` : '';
      sentences.push(`changed ${violations.length} file(s) outside the whitelist: ${shown}${more}`);
    }
  }

  if (check.require !== undefined) {
    const unmatched = check.require.filter(
      (pattern) => !evidence.changedFiles.some((file) => matchGlob(file, pattern)),
    );
    if (unmatched.length > 0) {
      sentences.push(`required path(s) never changed: ${unmatched.join(', ')}`);
    }
  }

  return result(check, sentences.length === 0, sentences.join('; '));
}

// ---------------------------------------------------------------------------------------------
// file-content
// ---------------------------------------------------------------------------------------------

/**
 * `check.path` names a location inside the arm's workspace, but it is written by whoever authored
 * the trial spec, not by the worker — so the only thing that needs defending against here is a
 * typo or a deliberately hostile spec walking the resolved path outside the workspace with `..`.
 * The guard runs before any filesystem call, so a spec that tries it fails the check cleanly
 * instead of reading (or, on a differently-shaped check, writing) something outside the sandbox.
 */
function evalFileContent(check: FileContentCheck, evidence: ArmEvidence): CheckResult {
  const resolved = path.resolve(evidence.workspace, check.path);
  const rel = path.relative(evidence.workspace, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return result(check, false, `path escapes the workspace: ${check.path}`);
  }

  try {
    const exists = existsSync(resolved);

    if (check.absent === true) {
      if (!exists) return result(check, true, '');
      const bytes = statSync(resolved).size;
      return result(check, false, `expected ${check.path} to be absent, it exists (${bytes} bytes)`);
    }

    if (check.contains !== undefined) {
      if (!exists) return result(check, false, `${check.path} does not exist`);
      const content = readFileSync(resolved, 'utf8');
      if (content.includes(check.contains)) return result(check, true, '');
      return result(check, false, `${check.path} does not contain ${JSON.stringify(check.contains)}`);
    }

    // Neither assertion was given. Passing silently here would let a spec author's typo (meant
    // `contains`, wrote nothing) score as a check that never fails — the exact vacuity the trial
    // contract's whole design is built to rule out.
    return result(check, false, 'malformed check: needs `contains` or `absent: true`');
  } catch (err) {
    return result(check, false, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------------------------
// no-tool-use
// ---------------------------------------------------------------------------------------------

/**
 * Scans every event regardless of `depth`, because a worker that cannot reach for `WebFetch`
 * directly but delegates a subagent that does has still broken the constraint — the compliance
 * question is "did the tool run", not "did the top-level process invoke it".
 */
function evalNoToolUse(check: NoToolUseCheck, evidence: ArmEvidence): CheckResult {
  const matching = check.matching?.toLowerCase();
  let count = 0;
  let firstInput: unknown;
  let sawFirst = false;

  for (const event of evidence.events) {
    if (event.type !== 'tool_use') continue;
    if (event.name !== check.tool) continue;
    if (matching !== undefined && !JSON.stringify(event.input ?? null).toLowerCase().includes(matching)) {
      continue;
    }
    count += 1;
    if (!sawFirst) {
      firstInput = event.input;
      sawFirst = true;
    }
  }

  if (count === 0) return result(check, true, '');

  const serialised = JSON.stringify(firstInput ?? null);
  const truncated = serialised.length > 200 ? serialised.slice(0, 200) : serialised;
  let detail = `${check.tool} ran ${count} time(s)`;
  if (check.matching !== undefined) detail += ` matching ${JSON.stringify(check.matching)}`;
  detail += `: ${truncated}`;
  return result(check, false, detail);
}

// ---------------------------------------------------------------------------------------------
// committed
// ---------------------------------------------------------------------------------------------

/**
 * The two requirements are independent (a run can move HEAD and still leave a dirty tree, or vice
 * versa), so both are checked and both failures are reported — the whole reason this is its own
 * check type rather than a `command` running `git status` is that the failure has to name WHICH
 * of the two properties broke, and a shell exit code cannot carry that.
 */
function evalCommitted(check: CommittedCheck, evidence: ArmEvidence): CheckResult {
  const requireNewCommit = check.requireNewCommit ?? true;
  const requireClean = check.requireClean ?? true;
  const sentences: string[] = [];

  if (requireNewCommit) {
    if (evidence.headCommit === null) {
      sentences.push('HEAD could not be read');
    } else if (evidence.headCommit === evidence.baseCommit) {
      sentences.push(
        `HEAD is still the seed commit ${evidence.baseCommit.slice(0, 8)} — nothing was committed`,
      );
    }
  }

  if (requireClean && evidence.dirty) {
    sentences.push('the working tree has uncommitted changes');
  }

  return result(check, sentences.length === 0, sentences.join('; '));
}

// ---------------------------------------------------------------------------------------------
// evaluateCheck / evaluateChecks / vacuousJobChecks
// ---------------------------------------------------------------------------------------------

/**
 * Score one check against one arm's evidence.
 *
 * The `default` branch is reachable at runtime even though the switch above it is exhaustive at
 * compile time: `check` came off a parsed trial spec file, and nothing stops that file from
 * naming a `type` this build has never heard of. `exhaustive` exists purely to keep the compiler
 * honest — assigning to a `never`-typed local means a future check variant that forgets its own
 * `case` is a build failure, not a silent fall-through — and the cast beneath it is what lets the
 * same branch also produce a real, addressed `CheckResult` for the value that actually showed up.
 */
export async function evaluateCheck(
  check: Check,
  evidence: ArmEvidence,
  exec: CheckExec,
): Promise<CheckResult> {
  switch (check.type) {
    case 'command':
      return evalCommand(check, evidence, exec);
    case 'files-changed':
      return evalFilesChanged(check, evidence);
    case 'file-content':
      return evalFileContent(check, evidence);
    case 'no-tool-use':
      return evalNoToolUse(check, evidence);
    case 'committed':
      return evalCommitted(check, evidence);
    default: {
      const exhaustive: never = check;
      const runtime = exhaustive as unknown as CheckBase & { type: string };
      return {
        id: runtime.id,
        kind: runtime.kind,
        type: runtime.type as CheckType,
        passed: false,
        detail: `unknown check type ${JSON.stringify(runtime.type)}`,
      };
    }
  }
}

/**
 * Score every check against one arm's evidence, IN ORDER, one at a time.
 *
 * `Promise.all` would be the obvious way to write this and the wrong one: two `command` checks
 * that both happen to run a build in the same workspace directory (a common shape — "it builds"
 * and "it builds in release mode") would then race each other's file writes and process output,
 * and a check runner is worthless if its own concurrency is what makes a run flaky.
 */
export async function evaluateChecks(
  checks: readonly Check[],
  evidence: ArmEvidence,
  exec: CheckExec,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await evaluateCheck(check, evidence, exec));
  }
  return results;
}

/**
 * The ids of every `job` check that already passed — the evidence behind `TrialResult.vacuous`.
 *
 * Scoped to `job` on purpose: a `compliance` check passing against an untouched seed is correct
 * (nothing changed, so nothing was violated), while a `job` check passing before the worker did
 * anything means the acceptance test was never capable of failing, and every arm would score full
 * marks on it forever regardless of what any effort level actually contributed.
 */
export function vacuousJobChecks(results: readonly CheckResult[]): string[] {
  return results.filter((r) => r.kind === 'job' && r.passed).map((r) => r.id);
}
