/**
 * Reading and writing `~/.agentic-army/config.toml`.
 *
 * ===========================================================================================
 * TWO RULES, AND EVERYTHING ELSE IS DETAIL
 * ===========================================================================================
 *
 * 1. **Ceilings come from HERE and nowhere else.** This module reads exactly one file, at an
 *    absolute path derived from the user's home directory (or `$AGENTIC_ARMY_HOME`). It never
 *    looks inside the repository being worked on — no `.agentic-army.toml`, no `package.json`
 *    field, no walking up from `cwd`, no merge of repo values over global ones. If it did,
 *    `git clone` would be an escalation primitive: shipping one file in a repo would be enough
 *    for that repo to grant itself merge rights on your machine, and the attack costs the
 *    author nothing. There is deliberately no parameter on any function here that could point
 *    it at a project-local file.
 *
 * 2. **Every failure resolves DOWNWARD.** Missing file, missing key, missing project, a string
 *    where a number belongs, a number out of range, `ceiling = "three"` — all of it lands on
 *    rung 0 (commit; your repo untouched). The failure mode of guessing low is "you have to go
 *    and edit a file". The failure mode of guessing high is "it merged something". Those are
 *    not comparable, so nothing here is ever lenient upward.
 *
 * ===========================================================================================
 * NAMING
 * ===========================================================================================
 * TOML is snake_case; TypeScript is camelCase. The mapping is written out by hand rather than
 * derived, so that renaming a TS field cannot silently start reading a TOML key that does not
 * exist (and therefore silently fail to 0):
 *
 *     archive_root             <->  archiveRoot
 *     delivery.default_ceiling <->  delivery.defaultCeiling
 *     [projects]."<abs path>".ceiling  <->  projects["<abs path>"].ceiling
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parse as parseToml } from 'smol-toml';

import type {
  DispatchConfig,
  DispatchRule,
  DispatchTarget,
  GlobalConfig,
  PermissionPosture,
  PermissionsConfig,
  PlanningConfig,
} from '../contracts/config.ts';
import {
  DEFAULT_PERMISSION_POSTURE,
  DEFAULT_SPEC_TO_REPO,
  PERMISSION_POSTURES,
} from '../contracts/config.ts';
import type { ProjectPolicy, Rung } from '../contracts/delivery.ts';
import { RUNG_LABEL } from '../contracts/delivery.ts';
import { HARNESS_IDS, REASONING_EFFORTS } from '../contracts/harness.ts';
import type { HarnessId, ReasoningEffort } from '../contracts/harness.ts';
import { armyHome, configPath, resolveArchiveRoot } from './paths.ts';
import type { Env } from './paths.ts';

/** Shape version of `config.toml`. Bumped only by a release that changes the file's layout. */
export const CONFIG_VERSION = 1;

/**
 * The static vendor split — Inspectors on codex, every other role on claude — used when the
 * config is absent or has no usable rules. Unlike a ceiling, a dispatch default has no blast
 * radius in the sense that matters for merge authority — the worst case used to be simply "a job
 * runs on the wrong vendor". It is now SLIGHTLY less true than that: the worst case also includes
 * "a job runs at the wrong reasoning level", because the Engineer rule below sets `effort`, not
 * only `harness`. That is still a cost-and-time mistake, never an authority one — a ceiling still
 * bounds what the job may do — so falling back to a working default here remains safe; it is just
 * no longer costless to get wrong, which is the whole reason the change is documented this
 * carefully instead of being a quiet one-line edit.
 *
 * The split is enacted by `dispatchFor` in `src/command/campaign.ts` and is a function of the
 * ROLE alone; what these rules supply is the `model` and `effort` for whichever harness the role
 * chose. The `when` strings below are labels — see `DispatchRule.when`, which nothing matches on.
 *
 * Kept byte-compatible with the `[[dispatch.rules]]` block that `army init` writes.
 *
 * WHY THE ENGINEER RULE READS `effort: 'low'`, NOT `'xhigh'`.
 *
 * A controlled trial ran one coding task at all five reasoning levels under two briefs that
 * carried identical constraints and differed only in whether the thinking had been done above.
 * Under a COMPLETE brief every effort level succeeded, including `low` — 1m12s, $0.29 — and
 * `xhigh` produced a byte-identical outcome for 4x the cost and 4x the time. Under a THIN brief
 * six of eight arms failed, all six on the same missing sentence a complete brief would have
 * stated and nobody derived; `xhigh` was the one effort level that still got there, at 9m42s and
 * $1.64.
 *
 * So `low` is the right default ONLY in a system that guarantees a complete spec, and this file
 * is not that guarantee by itself — it is the third leg of one. The other two: the commander now
 * interrogates the human until it can fill a six-field `TechnicalSpec`, and a dispatch made
 * without one is escalated back up automatically — `UNSPECIFIED_BRIEF_EFFORT` in
 * `src/command/campaign.ts`'s `dispatchFor` raises an unspecified brief to `xhigh` regardless of
 * what this rule says. `low` here is therefore a measured default conditioned on that escalation
 * existing, not a claim that `low` is enough on its own — see the reasoning-class rule above
 * `REASONING_EFFORTS` in `src/contracts/harness.ts` for the line between the two.
 */
export const DEFAULT_DISPATCH: DispatchConfig = {
  rules: [
    {
      when: 'Any change to any file.',
      use: [{ harness: 'claude', model: 'claude-sonnet-5', effort: 'low' }],
      why:
        'Engineers build on Claude. Effort is low by measured default, not by economy: a ' +
        'complete spec produced byte-identical output at low and xhigh, 4x cheaper and 4x ' +
        'faster. A brief dispatched without a complete spec never sees this value — ' +
        "UNSPECIFIED_BRIEF_EFFORT in campaign.ts's dispatchFor escalates it to xhigh first.",
    },
    {
      when: 'An Engineer has claimed done and its branch needs review.',
      use: [{ harness: 'codex', model: 'gpt-5.5', effort: 'high' }],
      why: "Reviewer must not share the builder's blind spots.",
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Rungs
// ---------------------------------------------------------------------------------------------

/**
 * Coerce anything at all into a rung, failing closed. THE SOLE IMPLEMENTATION — `army enlist`
 * imports this one; there is no second copy to drift from.
 *
 * Applied to every ceiling on every read, because a hand-edited file is precisely the input we
 * cannot assume is well formed. Three cases, and only the third is a judgement call:
 *
 *   OUT OF RANGE      9, 4, 3000, -1, Infinity, NaN   -> 0
 *   WRONG TYPE        "3", true, [], {}, a date       -> 0
 *   IN-RANGE FRACTION 2.7                             -> 2   (floor: downward, so safe)
 *
 * OUT OF RANGE USED TO CLAMP UPWARD — `9` became 3, which is `merge`. That is the wrong
 * direction for the one number in this system that decides whether an agent may merge to your
 * default branch: a fat-fingered `33` in a hand-edited file would have silently granted the
 * maximum authority the ladder has, and it would have looked like a working config forever
 * because nothing would ever complain. Out of range is not "they meant the nearest legal
 * value", it is "this file does not say what its author thinks it says", and the only safe
 * reading of a number nobody can vouch for is 0.
 *
 * The in-range fraction stays a floor because floors only ever move DOWN the ladder — `2.7`
 * cannot become 3 — so it is the same fail-closed direction, not an exception to it.
 */
export function clampCeiling(value: unknown): Rung {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0 || value > 3) return 0;
  const floored = Math.floor(value);
  // `=== 0` also normalises `-0`, which is a legal TOML float and would otherwise survive as
  // `-0` into a row, a JSON payload and a log line.
  return (floored === 0 ? 0 : floored) as Rung;
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export interface ParsedConfig {
  config: GlobalConfig;
  /**
   * Everything that was wrong with the file but did not stop the load. These are not debug
   * noise: each one means some setting the user wrote is NOT in effect, and a silently ignored
   * ceiling is the exact failure this module exists to prevent. Surface them.
   */
  warnings: string[];
}

function isTable(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

/**
 * U+FEFF, the byte-order mark. Notepad, older PowerShell redirections and several Windows
 * editors write one at the head of a UTF-8 file by default, and `fs.readFile(…, 'utf8')` hands
 * it straight through as a character.
 *
 * It is not a curiosity: TOML has no provision for it, `smol-toml` rejects the document with
 * "only letter, numbers, dashes and underscores are allowed in keys", and the failure lands on
 * line 1 of a file the user believes is fine. On the write path it is worse than a parse error
 * — the BOM sits in front of the first line, so a header on that line would not match and a
 * second `[projects]` table would be appended (the CRLF failure, by a different route).
 *
 * So every entry point strips it before parsing or scanning, and the write path puts it back
 * verbatim. Removing a BOM the user's editor will simply rewrite is not our business.
 */
const BOM = '﻿';

function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(BOM.length) } : { bom: '', body: text };
}

/** The config that applies when there is no file yet. Ceiling-free, so every project is 0. */
export function defaultConfig(configFilePath: string): GlobalConfig {
  return {
    version: CONFIG_VERSION,
    archiveRoot: resolveArchiveRoot(undefined, configFilePath),
    delivery: { defaultCeiling: 0 },
    projects: {},
    dispatch: DEFAULT_DISPATCH,
    permissions: { mode: DEFAULT_PERMISSION_POSTURE },
    planning: { specToRepo: DEFAULT_SPEC_TO_REPO },
  };
}

/**
 * `[planning] spec_to_repo = true | false`.
 *
 * Warns only about a MALFORMED value, and says nothing about a well-formed `false` — the rule
 * `parsePermissions` below settled and the reason it gives applies unchanged: this array means
 * "something about YOUR CONFIG is questionable", it is read by `doctor` and by every command that
 * loads a file, and a warning that fires on every load for every reader is the shape people learn
 * to scroll past, taking the warnings that matter with it.
 *
 * A string `"true"` is a malformed value rather than a truthy one. TOML has a boolean type; a
 * quoted one is somebody who meant the boolean and got the syntax wrong, and silently honouring it
 * would mean the next person to write `"false"` gets a directory in their working copy.
 */
function parsePlanning(raw: unknown, warnings: string[]): PlanningConfig {
  let specToRepo = DEFAULT_SPEC_TO_REPO;
  if (isTable(raw)) {
    const value = raw['spec_to_repo'];
    if (typeof value === 'boolean') {
      specToRepo = value;
    } else if (value !== undefined) {
      warnings.push(
        `planning.spec_to_repo: expected true or false, got ${JSON.stringify(value)}; using ` +
          `${String(DEFAULT_SPEC_TO_REPO)}`,
      );
    }
  } else if (raw !== undefined) {
    warnings.push(
      `planning: expected a table; using spec_to_repo = ${String(DEFAULT_SPEC_TO_REPO)}`,
    );
  }
  return { specToRepo };
}

/**
 * `[permissions] mode = "guarded" | "unguarded"`.
 *
 * Warns ONLY about a malformed value, and deliberately says nothing about a well-formed
 * `unguarded`.
 *
 * THE FIRST VERSION OF THIS WARNED UNCONDITIONALLY, and fourteen tests failed — every one of them
 * a case asserting the warnings array for some unrelated reason. That is not fourteen stale
 * assertions; it is the codebase stating what `warnings` means. This array is "something about
 * YOUR CONFIG is questionable", it is read by `doctor`, by `view`, by every command that loads a
 * file, and the effort-drift warning next door already argues that one warning is worth more than
 * a wall of them. Since `DEFAULT_PERMISSION_POSTURE` is `unguarded`, an unconditional warning here
 * fires on every load for every reader including ones with no `[permissions]` block at all —
 * which is the exact shape of a warning people learn to scroll past, taking the effort-drift line
 * with it.
 *
 * The posture still gets announced, louder than a warning would have: `runCampaign` raises it as a
 * `permissions` NOTE, so it prints once per campaign next to the delivery ceiling, which is the
 * channel for "here is the authority this run is operating under". Config problems go here;
 * run-scoped posture goes there.
 */
function parsePermissions(raw: unknown, warnings: string[]): PermissionsConfig {
  let mode: PermissionPosture = DEFAULT_PERMISSION_POSTURE;

  if (isTable(raw)) {
    const rawMode = raw['mode'];
    if (typeof rawMode === 'string' && (PERMISSION_POSTURES as readonly string[]).includes(rawMode)) {
      mode = rawMode as PermissionPosture;
    } else if (rawMode !== undefined) {
      warnings.push(
        `permissions.mode: expected one of ${PERMISSION_POSTURES.map((p) => `"${p}"`).join(', ')}, ` +
          `got ${JSON.stringify(rawMode)}; using "${DEFAULT_PERMISSION_POSTURE}"`,
      );
    }
  } else if (raw !== undefined) {
    warnings.push(
      `permissions: expected a table; using mode = "${DEFAULT_PERMISSION_POSTURE}"`,
    );
  }

  return { mode };
}

/**
 * The one sentence a reader needs about the posture this run is operating under.
 *
 * Two lengths, one set of facts. `postureNotice` is the paragraph the campaign prints as a note
 * before its first spawn. `postureSummary` is the row the chat banner carries, cut to fit one
 * fact line at 80 columns. `test/contracts.test.ts` pins that both name the same posture and that
 * the unguarded forms both say what still holds, so the two cannot drift into describing
 * different runs.
 */
export function postureSummary(mode: PermissionPosture): string {
  return mode === 'unguarded'
    ? 'unguarded · any command; rank narrowing, denies, sandbox hold'
    : 'guarded · every command must match the allow-list verbatim';
}

export function postureNotice(mode: PermissionPosture): string {
  return mode === 'unguarded'
    ? 'permissions: unguarded — workers hold their tools unscoped, so an Engineer runs any ' +
        'command rather than a listed one, and the codex reviewer may open a socket to run your ' +
        'tests. Still enforced: rank narrowing, the commander context guard, the credential and ' +
        'archive denies, and the codex write sandbox. Set permissions.mode = "guarded" in ' +
        'config.toml to restore per-command scoping.'
    : 'permissions: guarded — every command a worker runs must match its allow-list verbatim, ' +
        'and the codex reviewer cannot open a socket.';
}

/**
 * Reasoning classes, weakest first — the order `REASONING_EFFORTS` already declares.
 *
 * Local rather than imported as a value so this stays a pure comparison over a config, with no
 * opinion about what a harness does with the class it is handed.
 */
const EFFORT_ORDER: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Say so when a hand-written config dispatches Engineers above the measured default.
 *
 * ## Why this is a warning and not a migration
 *
 * `army init` writes a config and never rewrites one, which is correct — a config is the user's
 * file and this codebase refuses to repair rather than repairing behind a reader's back. The cost
 * of that correctness is that a config written before 2026-08-05 still says `xhigh`, and the
 * measured default became `low` on that date under the justification on `DEFAULT_DISPATCH`. A run
 * observed in the field spent 27.1 minutes and $6.93 on one Engineer attempt for a task the same
 * trial had measured at a quarter of both, and nothing anywhere said a word.
 *
 * ## Why this does not violate NEVER-DOWNGRADE-REASONING
 *
 * `src/contracts/harness.ts` forbids silently trading correctness for cost under pressure,
 * absolutely. This is neither silent nor a reaction to a bill: it reports a divergence from a
 * default that was chosen on MEASURED OUTCOME under a guaranteed-complete spec, it changes
 * nothing, and the escalation for a brief with no spec is untouched. A reader who wants `xhigh`
 * keeps `xhigh` and now knows what it costs.
 */
function warnEffortDrift(rules: readonly DispatchRule[], warnings: string[]): void {
  const baseline = DEFAULT_DISPATCH.rules[0]?.use[0]?.effort;
  if (baseline === undefined) return;
  const floor = EFFORT_ORDER.indexOf(baseline);
  if (floor === -1) return;

  for (const [i, rule] of rules.entries()) {
    for (const [j, target] of rule.use.entries()) {
      // The ENGINEER rule only. A reviewer at `high` is a deliberate, separate choice — it must
      // not share the builder's blind spots — and warning about it would be noise that teaches a
      // reader to ignore the one warning that matters.
      if (target.harness !== 'claude' || target.effort === undefined) continue;
      const level = EFFORT_ORDER.indexOf(target.effort);
      if (level <= floor) continue;
      warnings.push(
        `dispatch.rules[${String(i)}].use[${String(j)}]: effort is "${target.effort}", above the ` +
          `measured default "${baseline}". A trial measured a complete spec producing ` +
          'byte-identical output at both, 4x cheaper and 4x faster at the lower class. Nothing ' +
          'has been changed — this is your config. Lower it to reclaim that, or keep it and know ' +
          'the cost.',
      );
      return; // One warning, not one per rule: the reader needs the fact, not a wall.
    }
  }
}

function parseDispatchTarget(raw: unknown, where: string, warnings: string[]): DispatchTarget | null {
  if (!isTable(raw)) {
    warnings.push(`${where}: expected a table, ignoring this target`);
    return null;
  }
  const harness = raw['harness'];
  if (typeof harness !== 'string' || !(HARNESS_IDS as readonly string[]).includes(harness)) {
    warnings.push(
      `${where}.harness: expected one of ${HARNESS_IDS.join(' | ')}, got ${JSON.stringify(harness)} — ignoring this target`,
    );
    return null;
  }
  const target: DispatchTarget = { harness: harness as HarnessId };

  const model = raw['model'];
  if (typeof model === 'string' && model.trim() !== '') target.model = model;
  else if (model !== undefined) warnings.push(`${where}.model: expected a non-empty string, ignoring it`);

  const effort = raw['effort'];
  if (typeof effort === 'string' && (REASONING_EFFORTS as readonly string[]).includes(effort)) {
    target.effort = effort as ReasoningEffort;
  } else if (effort !== undefined) {
    // Ignore the field, keep the rule. Dropping the whole rule over an unknown effort would
    // take a vendor offline for a typo; and we never silently downgrade reasoning class, so
    // the adapter default is the right fallback.
    warnings.push(
      `${where}.effort: expected one of ${REASONING_EFFORTS.join(' | ')}, got ${JSON.stringify(effort)} — using the adapter default`,
    );
  }

  return target;
}

/**
 * `[dispatch]` -> `DispatchConfig`.
 *
 * TOLERANCE IS THE POINT HERE, and it is worth saying which fields this function accepts without
 * anything downstream reading them, because "accepted" and "in effect" are different claims and
 * only one of them is true of each:
 *
 *   IN EFFECT   `use[0].harness` (selects which rule a role reads), `use[0].model`,
 *               `use[0].effort` — these reach the spawned process.
 *   ACCEPTED,   `when`  — required, validated non-empty, never matched against a task;
 *   NOT READ    `why`   — prose, by design;
 *               `use[1..]` — parsed and validated, then ignored;
 *               `default` — parsed and validated, then ignored (`dispatchFor` has its own
 *                           hardcoded fallback). See `DispatchConfig.default`.
 *
 * None of the four is rejected and none produces a warning on its own, deliberately: a config
 * somebody has already hand-edited must keep loading, and an upgrade that turned a working file
 * into a warning storm — or a load failure — would be a worse bug than the documentation one it
 * fixed. What each field is worth is stated on the type and in the `army init` template, which is
 * where a reader is standing when they edit it.
 */
function parseDispatch(raw: unknown, warnings: string[]): DispatchConfig {
  if (raw === undefined) return DEFAULT_DISPATCH;
  if (!isTable(raw)) {
    warnings.push('dispatch: expected a table — using the built-in vendor split');
    return DEFAULT_DISPATCH;
  }

  const rules: DispatchRule[] = [];
  const rawRules = raw['rules'];
  if (rawRules !== undefined && !Array.isArray(rawRules)) {
    warnings.push('dispatch.rules: expected an array of [[dispatch.rules]] tables');
  } else if (Array.isArray(rawRules)) {
    rawRules.forEach((entry, i) => {
      const where = `dispatch.rules[${i}]`;
      if (!isTable(entry)) {
        warnings.push(`${where}: expected a table, ignoring this rule`);
        return;
      }
      const when = entry['when'];
      const why = entry['why'];
      const use = entry['use'];
      if (typeof when !== 'string' || when.trim() === '') {
        warnings.push(`${where}.when: expected a non-empty string, ignoring this rule`);
        return;
      }
      if (!Array.isArray(use)) {
        warnings.push(`${where}.use: expected an array of targets, ignoring this rule`);
        return;
      }
      const targets = use
        .map((t, j) => parseDispatchTarget(t, `${where}.use[${j}]`, warnings))
        .filter((t): t is DispatchTarget => t !== null);
      if (targets.length === 0) {
        warnings.push(`${where}.use: no usable targets, ignoring this rule`);
        return;
      }
      rules.push({
        when,
        use: targets,
        why: typeof why === 'string' ? why : '',
      });
    });
  }

  if (rules.length === 0) {
    warnings.push('dispatch: no usable rules — using the built-in vendor split');
    return DEFAULT_DISPATCH;
  }

  warnEffortDrift(rules, warnings);

  const config: DispatchConfig = { rules };

  // Parsed and validated so that a typo in a `dispatch.default` is still reported, and so that a
  // config carrying one keeps loading. NOTHING READS THE RESULT — `dispatchFor` falls back to its
  // own `{ harness }` computed from the role. See `DispatchConfig.default`.
  const rawDefault = raw['default'];
  if (Array.isArray(rawDefault)) {
    const targets = rawDefault
      .map((t, j) => parseDispatchTarget(t, `dispatch.default[${j}]`, warnings))
      .filter((t): t is DispatchTarget => t !== null);
    if (targets.length > 0) config.default = targets;
  } else if (rawDefault !== undefined) {
    warnings.push('dispatch.default: expected an array of targets, ignoring it');
  }

  return config;
}

/**
 * `[projects]` -> `Record<absolutePath, ProjectPolicy>`.
 *
 * Every surviving entry is guaranteed to hold a valid `Rung`, so the consumers of a
 * `GlobalConfig` never have to re-validate. An entry that cannot be understood is kept at
 * ceiling 0 rather than dropped, so that `army enlist` still sees the project as enlisted and
 * the user gets a warning naming the line they need to fix.
 *
 * Absence is handled one layer up, by `projectCeiling` in `src/delivery/ladder.ts`: a project
 * with no entry has no policy and is 0. That is deliberately not duplicated here.
 */
function parseProjects(raw: unknown, warnings: string[]): Record<string, ProjectPolicy> {
  const projects: Record<string, ProjectPolicy> = {};
  if (raw === undefined) return projects;
  if (!isTable(raw)) {
    warnings.push('projects: expected a table — no project has a delivery policy');
    return projects;
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key.trim() === '') {
      warnings.push('projects: ignoring an entry with an empty path key');
      continue;
    }
    if (!path.isAbsolute(key)) {
      // Keys are absolute because a relative or bare-name key can be claimed by any directory
      // that happens to match — the ceiling would follow you into the wrong repo.
      warnings.push(
        `projects.${JSON.stringify(key)}: keys must be ABSOLUTE paths; this entry is ignored`,
      );
      continue;
    }
    const resolved = path.resolve(key);
    if (!isTable(value)) {
      warnings.push(
        `projects.${JSON.stringify(key)}: expected a table like { ceiling = 0 }; failing closed to ceiling 0`,
      );
      projects[resolved] = { project: resolved, ceiling: 0 };
      continue;
    }
    const rawCeiling = value['ceiling'];
    const ceiling = clampCeiling(rawCeiling);
    if (typeof rawCeiling !== 'number') {
      warnings.push(
        `projects.${JSON.stringify(key)}.ceiling: expected a number 0..3, got ${JSON.stringify(rawCeiling)}; failing closed to 0`,
      );
    } else if (!Number.isFinite(rawCeiling) || rawCeiling < 0 || rawCeiling > 3) {
      // Deliberately NOT "clamped to the nearest legal rung" — see `clampCeiling`.
      warnings.push(
        `projects.${JSON.stringify(key)}.ceiling: ${rawCeiling} is outside 0..3; failing closed to 0 (${RUNG_LABEL[0]}) rather than guessing at the nearest legal rung`,
      );
    } else if (ceiling !== rawCeiling) {
      warnings.push(
        `projects.${JSON.stringify(key)}.ceiling: ${rawCeiling} is not an integer; floored to ${ceiling} (${RUNG_LABEL[ceiling]})`,
      );
    }
    projects[resolved] = { project: resolved, ceiling };
  }

  return projects;
}

/**
 * Parse config text. Pure — no filesystem, no environment — so the whole failure surface is
 * unit-testable without a home directory.
 *
 * Throws only when the TOML itself will not parse. That is the one case where failing closed
 * means stopping: silently treating an unparseable config as "no projects" would take every
 * ceiling the user set down to 0 without saying so, and they would find out by watching a
 * campaign refuse to open a PR.
 */
/**
 * The one sentence every reader of an unparseable config gets, exported so `army doctor`'s
 * config check prints the SAME fix text `enlist` and `campaign` already print through the throw
 * below. Doctor green-lit a config the other commands refused to run against precisely because
 * it had no shared definition of this condition to reach for.
 */
export const CONFIG_FIX_BY_HAND =
  'Fix the file by hand. Nothing will run against a config that cannot be read, because ' +
  'guessing would mean guessing about delivery ceilings.';

export function parseConfig(toml: string, configFilePath: string): ParsedConfig {
  const warnings: string[] = [];

  let data: Record<string, unknown>;
  try {
    // A BOM is a character to `readFile`, and TOML has no provision for one.
    data = parseToml(splitBom(toml).body) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `${configFilePath} is not valid TOML: ${(e as Error).message}\n${CONFIG_FIX_BY_HAND}`,
    );
  }

  const rawVersion = data['version'];
  let version = CONFIG_VERSION;
  if (typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion > 0) {
    version = rawVersion;
    if (version > CONFIG_VERSION) {
      warnings.push(
        `version = ${version} is newer than this build understands (${CONFIG_VERSION}); ` +
          'some settings may be ignored',
      );
    }
  } else if (rawVersion !== undefined) {
    warnings.push(`version: expected a positive integer, got ${JSON.stringify(rawVersion)}`);
  }

  const archiveRoot = resolveArchiveRoot(data['archive_root'], configFilePath);
  if (data['archive_root'] !== undefined && typeof data['archive_root'] !== 'string') {
    warnings.push('archive_root: expected a string path; using the config directory instead');
  }

  const rawDelivery = data['delivery'];
  let defaultCeiling: Rung = 0;
  if (isTable(rawDelivery)) {
    const rawDefaultCeiling = rawDelivery['default_ceiling'];
    defaultCeiling = clampCeiling(rawDefaultCeiling);
    if (rawDefaultCeiling !== undefined && typeof rawDefaultCeiling !== 'number') {
      warnings.push(
        `delivery.default_ceiling: expected a number 0..3, got ${JSON.stringify(rawDefaultCeiling)}; failing closed to 0`,
      );
    } else if (
      typeof rawDefaultCeiling === 'number' &&
      (!Number.isFinite(rawDefaultCeiling) || rawDefaultCeiling < 0 || rawDefaultCeiling > 3)
    ) {
      warnings.push(
        `delivery.default_ceiling: ${rawDefaultCeiling} is outside 0..3; failing closed to 0`,
      );
    }
  } else if (rawDelivery !== undefined) {
    warnings.push('delivery: expected a table; failing closed to default_ceiling = 0');
  }

  return {
    config: {
      version,
      archiveRoot,
      delivery: { defaultCeiling },
      projects: parseProjects(data['projects'], warnings),
      dispatch: parseDispatch(data['dispatch'], warnings),
      permissions: parsePermissions(data['permissions'], warnings),
      planning: parsePlanning(data['planning'], warnings),
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

export interface LoadedConfig extends ParsedConfig {
  /** Absolute path of the file that was read (or would have been). */
  path: string;
  /** False when no config file exists yet — every project is then ceiling 0. */
  exists: boolean;
}

export interface LoadOptions {
  /** Override the army home. Defaults to `$AGENTIC_ARMY_HOME` or `~/.agentic-army`. */
  home?: string;
  env?: Env;
  /**
   * The command prefix the reader actually invoked — `army`, `node src/cli.ts`, `npx
   * agentic-army`. Supply it and the "no config yet" warning names a command they can paste.
   *
   * OPTIONAL, AND THE DEFAULT IS TO NAME NO PREFIX AT ALL. See `missingConfigWarning`.
   */
  self?: string;
}

/**
 * "There is no config yet", in the form the reader can act on.
 *
 * =============================================================================================
 * THE LAYERING, WHICH IS WHY THIS TAKES A PARAMETER AND DOES NOT IMPORT `invokedAs()`
 * =============================================================================================
 *
 * This warning hardcoded ``run \`army init\``` and was printed to readers running `npx
 * agentic-army` and `node src/cli.ts`, for whom `army` is not on PATH — the defect `invokedAs()`
 * exists to prevent. Importing `invokedAs()` here would fix the spelling and invert the layering:
 * `src/config/**` sits BELOW `src/setup/**`, and `src/setup/enlist.ts` already imports this
 * module. The dependency would run both ways.
 *
 * So the invocation arrives from above, as an optional parameter — and its ABSENCE is a
 * deliberate third state, not an oversight. This warning does not only reach a live terminal:
 * `src/command/campaign.ts` copies it verbatim into a `config:` signal in the archive, where it
 * is read back by `view` days later, from a different shell, possibly after a global install
 * that did not exist when it was written. A command prefix baked into a PERSISTED record is a
 * claim about a context that no longer applies. So a caller that is writing to a durable store
 * passes nothing, and gets a sentence that names the SUBCOMMAND without asserting how to reach
 * it; a caller printing to a live screen passes `self` and gets a paste-and-run line.
 *
 * Neither spelling ever prints a command the reader cannot run, which is the whole property.
 */
export function missingConfigWarning(file: string, self?: string): string {
  const how =
    self === undefined
      ? 'the `init` command creates it'
      : `run \`${self} init\` to create it`;
  return `${file} does not exist yet — ${how}. Every project is ceiling 0 until then.`;
}

/**
 * Read and parse the global config.
 *
 * A missing file is not an error — it is the pre-`init` state, and it resolves to a config with
 * no projects, which means every project is ceiling 0. Exactly the right answer.
 */
export async function loadConfig(opts: LoadOptions = {}): Promise<LoadedConfig> {
  const home = opts.home ?? armyHome(opts.env ?? process.env);
  const file = configPath(home);

  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return {
        config: defaultConfig(file),
        warnings: [missingConfigWarning(file, opts.self)],
        path: file,
        exists: false,
      };
    }
    throw new Error(`cannot read ${file}: ${err.message}`);
  }

  const parsed = parseConfig(text, file);
  return { ...parsed, path: file, exists: true };
}

// ---------------------------------------------------------------------------------------------
// Writing — text surgery, because the comments ARE the configuration
// ---------------------------------------------------------------------------------------------

/*
 * `smol-toml`'s `stringify` round-trips the DATA faithfully and discards every comment, and the
 * comments in this particular file are where the security property is written down, at the exact
 * spot a person is standing when they change a number. Losing them the first time anything edits
 * the config would be a real regression, so every write below is a line edit against the
 * original text: insert or replace one line, leave every other byte alone.
 *
 * THIS IS THE SOLE IMPLEMENTATION of the surgery. `src/setup/enlist.ts` used to carry a second
 * copy and now imports these; there is nothing left to keep in step. The two copies had already
 * diverged once — the CRLF fix landed here and not there, so `army enlist` was unusable on a
 * Windows-authored config while this module was fine — which is the argument for one copy, not
 * for a better pinning test. `enlist.ts` keeps only CLI policy: argument parsing, the ceiling
 * decision, the terminal check, refusal messaging, and repo-root resolution.
 */

/**
 * Quote a path as a TOML basic string. THE SOLE IMPLEMENTATION — `army enlist` imports this one.
 *
 * `JSON.stringify` emits exactly the escape set TOML basic strings accept, and the escaping is
 * the point: a Windows path is full of backslashes, and an unescaped `C:\Users\new-project`
 * contains a newline.
 */
export function quoteTomlKey(key: string): string {
  return JSON.stringify(key);
}

function unquoteTomlKey(token: string): string | null {
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return null;
    }
  }
  if (token.startsWith("'")) return token.slice(1, -1); // literal string: no escapes
  return token; // bare key
}

/*
 * LINE ENDINGS (Windows).
 *
 * Splitting on `\n` leaves a trailing `\r` on every line of a CRLF file, so `[ \t]*$` in the
 * header pattern does not match `[projects]\r`. The consequence was not cosmetic: the header
 * was never found, a SECOND `[projects]` table was appended, the file stopped parsing
 * ("cannot redefine an already defined table"), and the round-trip guard then refused every
 * write forever. Correct behaviour, unusable tool.
 *
 * So: `\r?` before every end anchor, and every line we write inherits the CR of the line it
 * replaces (or of the `[projects]` header, for an insertion). Mixed-ending files — routine
 * after a hand edit on Windows — keep their mixture, because the alternative is rewriting
 * every line of a file whose entire promise is that we only touch one.
 */
/**
 * Finding the `[projects]` header — a PARSER, deliberately not a regex.
 *
 * This pattern has now been widened three times, each time by someone who had just been shown a
 * legal spelling it did not match: `\r` (CRLF), then inner whitespace and the quoted forms, then
 * a trailing comment (`[projects]  # repos I have enlisted`) — which broke `army enlist` outright
 * and was only found by running the real command. Each fix was correct and each left the next
 * spelling unhandled, because "the spellings I have thought of" is not a property anyone can
 * hold in their head, whereas "what TOML permits" is written down.
 *
 * So this reads the line the way TOML defines it: optional whitespace, `[`, a dotted key path of
 * bare / basic-string / literal-string parts with whitespace anywhere between them, `]`,
 * optional whitespace, and optionally a comment to end of line. Every legal spelling matches by
 * construction — including `["projects"]`, whose escape decodes to `projects` — and the
 * decoys still fail, because they genuinely are different tables:
 *
 *   [projects_archive]   a different key
 *   [a.projects]         a two-part path, so not the top-level table
 *   [[projects]]         an array of tables, a different construct entirely
 *
 * The same parser reads entry keys, which is what makes the dotted form `"…".ceiling = 3` work.
 */

function skipWs(line: string, i: number): number {
  let j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j += 1;
  return j;
}

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;

/** One key part: `bare`, `"basic"` (escapes decoded) or `'literal'` (no escapes). */
function readKeyPart(line: string, i: number): { key: string; end: number } | null {
  if (line[i] === '"') {
    let j = i + 1;
    while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
    if (j >= line.length) return null;
    const decoded = unquoteTomlKey(line.slice(i, j + 1));
    return decoded === null ? null : { key: decoded, end: j + 1 };
  }
  if (line[i] === "'") {
    const close = line.indexOf("'", i + 1);
    if (close === -1) return null;
    return { key: line.slice(i + 1, close), end: close + 1 };
  }
  let j = i;
  while (j < line.length && BARE_KEY_CHAR.test(line[j] ?? '')) j += 1;
  return j === i ? null : { key: line.slice(i, j), end: j };
}

/** A dotted key path: `a`, `a.b`, `"a" . 'b'` … */
function readKeyPath(line: string, start: number): { parts: string[]; end: number } | null {
  const parts: string[] = [];
  let i = skipWs(line, start);
  for (;;) {
    const part = readKeyPart(line, i);
    if (part === null) return null;
    parts.push(part.key);
    i = skipWs(line, part.end);
    if (line[i] !== '.') return { parts, end: i };
    i = skipWs(line, i + 1);
  }
}

function withoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** The key path of a table header line, or null. `[[x]]` (array of tables) is not one. */
function tableHeaderPath(line: string): string[] | null {
  const text = withoutCr(line);
  const open = skipWs(text, 0);
  if (text[open] !== '[' || text[open + 1] === '[') return null;
  const path = readKeyPath(text, open + 1);
  if (path === null) return null;
  let i = skipWs(text, path.end);
  if (text[i] !== ']') return null;
  i = skipWs(text, i + 1);
  // Only a comment may follow. Anything else means this is not a bare table header.
  return i >= text.length || text[i] === '#' ? path.parts : null;
}

function isProjectsHeader(line: string): boolean {
  const parts = tableHeaderPath(line);
  return parts !== null && parts.length === 1 && parts[0] === 'projects';
}

/** The key path of a `key = value` line, or null. Handles `"path".ceiling = 3`. */
function entryKeyPath(line: string): string[] | null {
  const text = withoutCr(line);
  const path = readKeyPath(text, 0);
  if (path === null) return null;
  return text[skipWs(text, path.end)] === '=' ? path.parts : null;
}

/** Any table header or array-of-tables header — i.e. the end of the `[projects]` region. */
const TABLE_HEADER_RE = /^[ \t]*\[/;

/** The `\r` that a CRLF file leaves behind when the text is split on `\n`. */
function crSuffix(line: string): string {
  return line.endsWith('\r') ? '\r' : '';
}

/** Dominant line ending, used only when writing a whole new section. */
function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const total = (text.match(/\n/g) ?? []).length;
  return crlf > total - crlf ? '\r\n' : '\n';
}

/**
 * For each line, is its START outside every multi-line string?
 *
 * Only such lines may be treated as table headers or key/value entries. Without this, a config
 * holding
 *
 *     notes = """
 *     [projects]
 *     "/anything" = { ceiling = 3 }
 *     """
 *
 * would have that inner line rewritten as though it were a real entry — silently mutating an
 * unrelated value. The round-trip guard in `writeProjectCeiling` caught the damage and wrote
 * nothing, which is the right backstop but the wrong place to solve it: the scan should not
 * misidentify the header in the first place.
 *
 * Tracks single-line basic/literal strings and `#` comments too, so a `'''` inside `"..."` or
 * after a `#` cannot open a phantom multi-line string. The one accepted imprecision is TOML's
 * rule that a multi-line basic string may end with up to two extra quotes (`""""`); we close on
 * the first `"""`. Erring that way costs at most a missed edit, never a wrong one.
 */
function linesOutsideStrings(lines: readonly string[]): boolean[] {
  const outside: boolean[] = [];
  let multiline: '"""' | "'''" | null = null;

  for (const raw of lines) {
    outside.push(multiline === null);
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    let i = 0;
    while (i < line.length) {
      if (multiline === '"""') {
        if (line[i] === '\\') {
          i += 2; // escape, including the line-ending backslash continuation
          continue;
        }
        if (line.startsWith('"""', i)) {
          multiline = null;
          i += 3;
          continue;
        }
        i += 1;
        continue;
      }
      if (multiline === "'''") {
        if (line.startsWith("'''", i)) {
          multiline = null;
          i += 3;
          continue;
        }
        i += 1;
        continue;
      }

      // outside any string
      const ch = line[i];
      if (ch === '#') break; // comment runs to end of line
      if (line.startsWith('"""', i)) {
        multiline = '"""';
        i += 3;
        continue;
      }
      if (line.startsWith("'''", i)) {
        multiline = "'''";
        i += 3;
        continue;
      }
      if (ch === '"') {
        i += 1;
        while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
        i += 1;
        continue;
      }
      if (ch === "'") {
        i += 1;
        while (i < line.length && line[i] !== "'") i += 1;
        i += 1;
        continue;
      }
      i += 1;
    }
  }

  return outside;
}

/**
 * Emitted only when `[projects]` is missing entirely — e.g. a hand-written config.
 * THE SOLE IMPLEMENTATION — `army enlist` imports this one.
 *
 * WORDING IS LOAD-BEARING. This text used to assert that a raise required a human editing the
 * file and that nothing in the running system could perform one. That was false, and it was
 * demonstrated false four different ways from a non-TTY shell (`script -q /dev/null`, `expect`,
 * `python3 pty.spawn`, `NODE_OPTIONS`). `process.stdin.isTTY` answers "is fd 0 a character
 * device", not "is a human present", and anything holding Bash can arrange the former.
 *
 * The old sentence is deliberately not quoted here, even as an example of what not to say: a
 * grep for the overclaim should return zero hits across the tree, and a quoted counter-example
 * is indistinguishable from the claim itself to both `grep` and a hurried reader.
 *
 * A comment that overstates a guarantee is worse than no comment: it is read at exactly the
 * moment somebody is deciding how much to trust the number below it. So this now says what is
 * actually true, and names the condition the claim depends on — the global permission deny on
 * `~/.agentic-army/**`, which the setup unit exports as `PROTECTED_CONFIG_GLOBS` for the
 * orchestrator to enforce. Without that rule this file is a guardrail against accident and
 * drift, and the text says so in as many words.
 */
export const PROJECTS_SECTION = `

# ---------------------------------------------------------------------------
# [projects] — enlisted repositories and their delivery ceilings
# ---------------------------------------------------------------------------
# Keyed by ABSOLUTE PATH. Added by \`army enlist\` from inside a repo.
#
# SECURITY — read this before you edit a number below.
#
# A project's ceiling lives HERE, in your global config, and never inside the
# repository it governs. If it lived in the repo, cloning somebody's repository
# would be enough for that repository to grant itself merge rights on your
# machine. It does not, and it cannot. That part is absolute.
#
# Raising a ceiling takes either a terminal (\`army enlist\` refuses to raise
# without one) or a direct edit of this file. A worker denied write access to
# ~/.agentic-army/** can do neither, and that deny rule is what makes the
# sentence above a boundary.
#
# Be clear about what holds without it: the terminal check asks whether stdin
# is a character device, not whether a human is present, and anything holding
# Bash can arrange the former. So absent the deny rule, treat everything below
# as a guardrail against accident and drift — not as a security boundary.
#
# Values out of 0..3 read as 0, and a campaign may only ever go lower than the
# ceiling, never higher.
#
#   0 commit   1 push   2 pull request   3 merge
[projects]
`;

/**
 * One `[projects]` line: `"<abs path>" = { ceiling = N }   # <label>`.
 * THE SOLE IMPLEMENTATION — `army enlist` imports this one, so the line it prints as a
 * copy-paste suggestion and the line that actually gets written are the same string.
 */
export function formatProjectEntry(absPath: string, ceiling: Rung): string {
  return `${quoteTomlKey(absPath)} = { ceiling = ${ceiling} }   # ${RUNG_LABEL[ceiling]}`;
}

/**
 * The dotted spelling: `"<abs path>".ceiling = N   # <label>`.
 *
 * Used only when the file already speaks that way — either because this exact key is already
 * written as a dotted key, or because the path carries other subkeys that an inline table would
 * collide with. Writing back in the author's own spelling is not politeness: converting
 * `"/repo".ceiling = 2` into `"/repo" = { ceiling = 2 }` next to a surviving `"/repo".note`
 * produces a duplicate-key error and a config nothing can write to again.
 */
function formatDottedProjectEntry(absPath: string, ceiling: Rung): string {
  return `${quoteTomlKey(absPath)}.ceiling = ${ceiling}   # ${RUNG_LABEL[ceiling]}`;
}

/**
 * Insert or replace one project entry, leaving every other byte of the file — and in particular
 * every comment — exactly where it was. THE SOLE IMPLEMENTATION — `army enlist` imports this one.
 *
 * Tolerates the things a hand-edited config on a real machine actually contains: CRLF and mixed
 * line endings, a leading BOM, `["projects"]` / `[ projects ]` spellings, and `[projects]`-shaped
 * lines inside multi-line string values.
 */
export function upsertProjectEntry(toml: string, absPath: string, ceiling: Rung): string {
  const entry = formatProjectEntry(absPath, ceiling);
  // Held aside and restored verbatim: a BOM in front of line 1 would stop the header on that
  // line from matching, which is the same failure as the CRLF one by a different route.
  const { bom, body } = splitBom(toml);
  const lines = body.split('\n');
  const outside = linesOutsideStrings(lines);

  const headerIndex = lines.findIndex((l, i) => outside[i] === true && isProjectsHeader(l));
  if (headerIndex === -1) {
    // A config may declare the table with top-level dotted keys and no header at all
    // (`projects."/repo" = { ceiling = 0 }`). Appending a `[projects]` table would redefine it,
    // so say what is wrong instead of emitting a file whose only symptom is a TOML error.
    for (let i = 0; i < lines.length; i += 1) {
      if (outside[i] !== true) continue;
      if (TABLE_HEADER_RE.test(lines[i] ?? '')) break; // past the top-level region
      if (entryKeyPath(lines[i] ?? '')?.[0] === 'projects') {
        throw new Error(
          'this config declares projects with a top-level dotted key (projects."…" = …) and no ' +
            '[projects] table. Adding one would redefine it, so nothing was changed. Convert the ' +
            'file to a [projects] table by hand, or edit the ceiling where it already is.',
        );
      }
    }
    const eol = detectEol(body);
    const trimmed = body.replace(/\s+$/, '');
    const section = PROJECTS_SECTION.split('\n').join(eol);
    return `${bom}${trimmed}${eol}${section}${entry}${eol}`;
  }

  // The region owned by [projects]: everything up to the next table header.
  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (outside[i] === true && TABLE_HEADER_RE.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }

  // Find this path's existing line, in either spelling TOML allows for it:
  //   "/repo" = { ceiling = 2 }     inline table
  //   "/repo".ceiling = 2           dotted key — legal, and a duplicate if we ignored it
  let replaceAt = -1;
  let replaceDotted = false;
  let hasOtherSubkeys = false;
  for (let i = headerIndex + 1; i < end; i += 1) {
    if (outside[i] !== true) continue;
    const parts = entryKeyPath(lines[i] ?? '');
    if (parts === null || parts[0] !== absPath) continue;
    if (parts.length === 1) {
      replaceAt = i;
      replaceDotted = false;
      break;
    }
    if (parts.length === 2 && parts[1] === 'ceiling') {
      replaceAt = i;
      replaceDotted = true;
      break;
    }
    hasOtherSubkeys = true; // e.g. "/repo".note = "…" — an inline table would collide with it
  }

  if (replaceAt >= 0) {
    const line = lines[replaceAt] ?? '';
    // Inherit the replaced line's own ending, so one edit cannot flip a file's convention,
    // and keep the author's spelling rather than converting their dotted key to a table.
    const replacement = replaceDotted ? formatDottedProjectEntry(absPath, ceiling) : entry;
    lines[replaceAt] = `${replacement}${crSuffix(line)}`;
    return `${bom}${lines.join('\n')}`;
  }

  const newLine = hasOtherSubkeys ? formatDottedProjectEntry(absPath, ceiling) : entry;

  // New entry: append after the last non-blank line of the region, so it is not stranded
  // below a run of blank lines.
  let insertAt = end;
  while (insertAt > headerIndex + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1;

  // A trailing `\r` on an element supplies the CR of the break that FOLLOWS it, since `join`
  // only ever contributes the `\n`. Take the local convention from the `[projects]` header.
  const cr = crSuffix(lines[headerIndex] ?? '');
  if (insertAt >= lines.length) {
    // Appending past the end of a file with no trailing newline: the break that now has to
    // exist is the one after the previous last line, so that is where the CR belongs.
    const previous = lines[lines.length - 1] ?? '';
    if (cr === '\r' && !previous.endsWith('\r')) lines[lines.length - 1] = `${previous}\r`;
    lines.push(newLine);
  } else {
    lines.splice(insertAt, 0, `${newLine}${cr}`);
  }
  return `${bom}${lines.join('\n')}`;
}

/**
 * The ceiling recorded for `absPath` in this config text, or null if it has no entry.
 * THE SOLE IMPLEMENTATION — `army enlist` imports this one.
 */
export function readProjectCeiling(toml: string, absPath: string): Rung | null {
  const data = parseToml(splitBom(toml).body) as Record<string, unknown>;
  const projects = data['projects'];
  if (!isTable(projects)) return null;
  const entry = projects[path.resolve(absPath)] ?? projects[absPath];
  if (!isTable(entry)) return null;
  if (entry['ceiling'] === undefined) return null;
  return clampCeiling(entry['ceiling']);
}

/**
 * Persist one project's ceiling, preserving comments.
 *
 * ===========================================================================================
 * LAYERING RULE — enforced by a test, not by hope
 *
 *   `writeProjectCeiling` may be imported ONLY from `src/setup/**`.
 *
 * This is MECHANISM ONLY: it writes whatever rung it is given, including a higher one. The
 * REFUSAL TO RAISE is a command-layer policy and lives in `army enlist`. Keeping the two apart
 * is deliberate — a mechanism that silently refuses is one nobody can build a "lower this
 * ceiling" flow on, and a policy buried inside a writer is one nobody can see.
 *
 * State the strength of that policy honestly: `army enlist` gates a raise on a terminal, and a
 * terminal check asks whether stdin is a character device, not whether a human is present —
 * it has been defeated four ways from a non-TTY shell. It is a speed bump. The boundary is the
 * permission layer denying workers write access to `~/.agentic-army/**` (the setup unit's
 * `PROTECTED_CONFIG_GLOBS`), which stops both the command and a direct file edit. This import
 * rule below is the third layer, and the only one that fails loudly at build time.
 *
 * But that safety is currently a fact about the call graph ("nothing else imports it"), and
 * facts about call graphs stop being true the moment somebody adds an import — most plausibly
 * from the orchestrator, which will legitimately import `loadConfig` FROM THIS SAME MODULE and
 * will find an ungated raise primitive sitting next to it. `test/contracts.test.ts` therefore
 * scans `src/` and fails if any module outside `src/setup/**` so much as names this function.
 * The day someone wires it into the orchestrator, a test fails instead of a ceiling quietly
 * rising.
 * ===========================================================================================
 *
 * Verifies the edit round-trips before writing. A global config that no longer parses would take
 * every project's ceiling down with it, so an edit that would corrupt it writes nothing at all.
 */
export async function writeProjectCeiling(
  absPath: string,
  ceiling: Rung,
  opts: LoadOptions = {},
): Promise<{ path: string; previous: Rung | null; ceiling: Rung }> {
  const home = opts.home ?? armyHome(opts.env ?? process.env);
  const file = configPath(home);

  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw new Error(`cannot read ${file}: ${err.message}`);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    text = '';
  }

  const resolved = path.resolve(absPath);
  const previous = text === '' ? null : readProjectCeiling(text, resolved);
  const updated = upsertProjectEntry(text, resolved, ceiling);

  const verified = readProjectCeiling(updated, resolved);
  if (verified !== ceiling) {
    throw new Error(
      `refusing to write ${file}: the edit would not round-trip ` +
        `(wrote ${ceiling}, read back ${String(verified)}). Nothing was written.`,
    );
  }

  // 0o600 for the same reason the archive is 0o700: this file decides how much authority
  // agents have on this machine, and it is not for other accounts.
  await fs.writeFile(file, updated, { encoding: 'utf8', mode: 0o600 });
  return { path: file, previous, ceiling };
}
