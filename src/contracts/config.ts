/**
 * Global configuration.
 *
 * Lives at `~/.agentic-army/config.toml`. It is the user's file, not the project's.
 */

import type { HarnessId, ReasoningEffort } from './harness.ts';
import type { ProjectPolicy, Rung } from './delivery.ts';

/** `~/.agentic-army` */
export const GLOBAL_CONFIG_DIR_NAME = '.agentic-army';
/** `~/.agentic-army/config.toml` */
export const GLOBAL_CONFIG_FILE_NAME = 'config.toml';

/**
 * One dispatch candidate: which harness, and how hard it should think.
 * `model` and `effort` fall back to the adapter's defaults for the role when absent.
 */
export interface DispatchTarget {
  harness: HarnessId;
  /** Vendor model id, e.g. `claude-sonnet-5`, `gpt-5.5`. */
  model?: string;
  effort?: ReasoningEffort;
}

/**
 * A rule, in the `rules[]` shape the config has used from day one.
 *
 * ===========================================================================================
 * WHAT THE DISPATCHER ACTUALLY DOES WITH ONE OF THESE
 * ===========================================================================================
 * `dispatchFor` in `src/command/campaign.ts` derives the wanted harness FROM THE ROLE
 * (`INSPECTOR` → codex, everything else → claude), then takes the first rule whose `use[0]`
 * names that harness and uses that target's `model` and `effort`.
 *
 * So the live parts of a rule are `use[0].harness`, which selects WHICH rule is read, and
 * `use[0].model` / `use[0].effort`, which are read from it and reach the spawned process. Edit
 * those and the next agent changes. That much is a working knob, and this comment is not here to
 * suggest otherwise.
 *
 * `when` and `why` are the parts that are NOT read, and each is called out on its own field.
 */
export interface DispatchRule {
  /**
   * A human label for the rule, e.g. "Any change to any file."
   *
   * NOT A PREDICATE, AND NOTHING MATCHES ON IT. It was documented as "a natural-language
   * predicate the dispatcher matches against the task"; no dispatcher has ever compared it to a
   * task, and role alone decides which rule is read. A knob that looks live and is not is worse
   * than an absent one, so this says what it is.
   *
   * It is REQUIRED anyway, and stays required: `parseDispatch` drops a rule that has no `when`
   * (with a warning), every shipped and hand-edited config already carries one, and it is the
   * slot a real matcher would read on the day one is built. Removing the field would invalidate
   * configs that are working today and would buy nothing back.
   */
  when: string;
  /**
   * Candidates, best first. **ONLY `use[0]` IS READ.** Later entries are parsed, validated,
   * carried on this object and then ignored by every consumer.
   *
   * It is an array so that the upgrade to quota-resolved candidates is a CONFIG CHANGE, NOT A
   * REWRITE. See `DispatchConfig` for what triggers that upgrade.
   */
  use: DispatchTarget[];
  /**
   * The audit trail for why a vendor was chosen, e.g. "Reviewer must not share the builder's
   * blind spots." Prose for a human reading the config, by design — no code branches on it.
   */
  why: string;
}

/**
 * The static vendor split.
 *
 * WHAT RUNS: `INSPECTOR` → codex, and every other role → claude. That is the whole rule, and it
 * is computed from the role in `dispatchFor`, not from anything in this file.
 *
 * SCOUT and SENTRY are members of `Role` that NOTHING SPAWNS (see the deferral note on
 * `ROLE_ALLOW` in `src/command/permissions.ts`), so a claim about which vendor they land on
 * describes no traffic. They are named here only to say that: were one fielded today it would
 * take the non-INSPECTOR branch and land on claude — including SENTRY, which the config template
 * used to promise would go to codex.
 *
 * Both subscription pools get used without coordination, and cross-vendor review independence
 * becomes STRUCTURAL rather than a rule someone must remember: a Sonnet Inspector reviewing
 * Sonnet-written code shares its training and its blind spots; a GPT Inspector does not.
 *
 * The accepted weakness is real — Claude exhausts and every Engineer stops while Codex sits at
 * 85%. THAT IS THE TRIGGER to build quota resolution, at which point `use` grows entries and
 * something starts reading past `use[0]`. When that day comes, adopt the hardest dispatch rule
 * verbatim: **never downgrade reasoning class to conserve quota** — report that the
 * strongest-class choice cannot proceed instead.
 */
export interface DispatchConfig {
  rules: DispatchRule[];
  /**
   * NOT BUILT YET — accepted, validated, and read by nothing.
   *
   * `src/config/load.ts` parses this and warns about malformed entries, so a typo in one is
   * still reported. But `dispatchFor` never consults it: a role that matches no rule falls back
   * to a bare `{ harness }` computed from the role, with the adapter's own model and effort.
   * There is therefore no configuration of this field that changes what gets spawned.
   *
   * This field used to be documented as the thing standing between an unmatched task and a
   * guess, with an absent one promised to be an error. Both halves were false: absence is not an
   * error, and the hardcoded fallback is precisely a guess. The old sentence is deliberately not
   * quoted, even to disown it — a grep for the overclaim should return nothing, and a quoted
   * counter-example is indistinguishable from the claim itself to `grep` and to a hurried reader.
   *
   * It stays in the type and stays parsed because a config that already carries one must keep
   * loading. WHAT WOULD TRIGGER WIRING IT UP: a second dispatch axis, so that "no rule matched"
   * becomes reachable at all. While the harness is a pure function of the role and both harnesses
   * appear in the shipped rules, no task can fail to match, so a default has nothing to catch.
   */
  default?: DispatchTarget[];
}

/** `[delivery]` — the fallback applied to a project with no explicit ceiling of its own. */
export interface DeliveryDefaults {
  /**
   * TOML `delivery.default_ceiling`. 0 is the only safe default: an unfamiliar repo gets to
   * commit and nothing more. Anything unparseable resolves to 0, never upward.
   */
  defaultCeiling: Rung;
}

/**
 * The parsed `~/.agentic-army/config.toml`.
 *
 * TOML is snake_case, TypeScript is camelCase, and the mapping is explicit rather than
 * mechanical — `archive_root` <-> `archiveRoot`, `delivery.default_ceiling` <->
 * `delivery.defaultCeiling`. See `src/config/load.ts`, which is the only thing allowed to
 * produce one of these.
 */
export interface GlobalConfig {
  /** TOML `version`. Bumped only by a release that changes this file's shape. */
  version: number;

  /**
   * TOML `archive_root`. Absolute path of the war archive. Campaigns live under
   * `<archiveRoot>/campaigns/`, durability mirrors under `<archiveRoot>/mirrors/`, so reports
   * never pollute your repos. Defaults to the directory holding the config file.
   */
  archiveRoot: string;

  delivery: DeliveryDefaults;

  /**
   * Delivery ceilings, KEYED BY ABSOLUTE PROJECT PATH.
   *
   * SECURITY — this map lives ONLY in the user's global config at `~/.agentic-army/config.toml`
   * and is NEVER read from the repo being worked on. No `.agentic-army.toml`, no `package.json`
   * field, no per-repo override, no merge of repo values over global ones. Otherwise a cloned
   * repo could raise its own delivery ceiling simply by shipping a file — which would hand
   * `gh pr merge` on your machine to whoever wrote the repo you just checked out.
   *
   * The path key is absolute for the same reason: a relative or name-based key can be claimed
   * by any directory that happens to share a basename.
   *
   * A project absent from this map has NO policy. Fail closed — treat it as ceiling 0 (commit,
   * your repo untouched) and make the user opt in with a deliberate file edit.
   */
  projects: Record<string, ProjectPolicy>;

  dispatch: DispatchConfig;

  permissions: PermissionsConfig;
}

// -----------------------------------------------------------------------------------------------
// `[permissions]` — how tightly a worker is confined while it works
// -----------------------------------------------------------------------------------------------

/**
 * How tightly a worker is confined. ONE switch, read by both adapters, meaning the same thing on
 * each: does the confinement stop at the tools a role holds, or does it also police every argv
 * and deny the network?
 *
 * ## Why this exists rather than a pile of individual escape hatches
 *
 * Measured on the campaign of 2026-08-07, which burned 65 minutes and ~$14.86 across three
 * Engineer attempts and delivered nothing:
 *
 * | denial | cause |
 * |---|---|
 * | 6 on the spec's OWN verify commands | the Engineer appended `; echo "exit=$?"` to see the exit status, which is a different string, and `verifyAllowRules` grants EXACT matches |
 * | `git clean -f -- seo-audit/debug-redirect.mjs` | absent from `ENGINEER_BASH_PREFIXES`; under `dontAsk`, absent from the allow-list IS denied |
 * | 50 EPERM on `listen` 127.0.0.1 | the codex Inspector runs `-s workspace-write`, whose sandbox denies the network, and the suite under review binds a loopback socket |
 *
 * None of those is an attack. Each is a competent worker meeting a rule that was written to stop
 * something else, and the last one meant the campaign's headline criterion was never executed by
 * any of the three reviewers — while all three still returned `testsRun: true`.
 *
 * The lesson is not "the rules were wrong in detail". A scoped allow-list is a whitelist of
 * SPELLINGS, and a model that reaches for a different-but-equivalent spelling is not misbehaving.
 * Widening the list one entry at a time chases spellings forever; widening it with `:*` is worse,
 * because `Bash(node x.js:*)` grants `node x.js; rm -rf .`.
 *
 * So the axis is made explicit and moved into config, where it can be turned back up in one line.
 *
 * ## What each value actually changes
 *
 * | | `guarded` | `unguarded` |
 * |---|---|---|
 * | tools a role holds | `ROLE_ALLOW[role]`, rank-narrowed | the same tool NAMES, rank-narrowed — identical set, no argv scoping |
 * | argv scoping (`Bash(git add:*)`) | enforced | none — a granted tool is granted |
 * | verify / file-run exact grants | appended per spec | not needed, not emitted |
 * | `GLOBAL_DENY` (credentials, `~/.agentic-army/**`) | enforced | **enforced, unchanged** |
 * | rank narrowing, `COMMANDER_FORBIDDEN_TOOLS` | enforced | **enforced, unchanged** |
 * | codex write sandbox (`-s workspace-write`) | enforced | **enforced, unchanged** |
 * | codex network | denied | allowed |
 *
 * The right-hand column is the load-bearing half, and it is why this is `unguarded` rather than
 * `dangerous`. What is removed is the layer that polices HOW a held tool is spelled. What is kept
 * is every layer that decides WHICH tools are held and WHERE bytes may land — the rank narrowing,
 * the commander's context guard, the credential and archive denies, and the codex directory
 * sandbox that is the only reason a leased worktree is an isolation boundary at all.
 *
 * An Engineer under `unguarded` can run any command; it still cannot write outside its lease
 * without going through a shell, cannot read your credentials, and cannot rewrite the archive
 * that records what it did. A Commander under `unguarded` still holds no `Read` and no `Bash`.
 *
 * ## The honest residual
 *
 * A claude worker's ONLY confinement is its permission rules — there is no directory sandbox on
 * that harness — so `unguarded` does hand a claude ENGINEER a shell that can write anywhere the
 * user can, `GLOBAL_DENY` notwithstanding, because a deny-list against a shell is a speed bump
 * and this file has said so since it was written. That is the price, it is stated rather than
 * papered over, and it is the same price the user pays running `claude --dangerously-skip-
 * permissions` by hand, which is the posture this mode is named after.
 */
export type PermissionPosture = 'guarded' | 'unguarded';

/** Every accepted spelling of `permissions.mode`, for parsing and for the error message. */
export const PERMISSION_POSTURES: readonly PermissionPosture[] = Object.freeze([
  'guarded',
  'unguarded',
]);

/**
 * The default, and the one place to change it back.
 *
 * `unguarded` while the pipeline is being made to work end-to-end. The reasoning is the user's
 * and is recorded because a security default that drifted in unattributed is a bug: iteration is
 * currently gated on argv spellings rather than on whether the work is right, so the boundary is
 * costing correctness instead of buying it. Every campaign start prints a banner naming this, and
 * `permissions.mode = "guarded"` restores the old behaviour in one line.
 *
 * WHAT MUST FLIP THIS BACK: a green end-to-end run against a real objective, at which point the
 * argv scoping can be re-enabled and the denials it produces are signal rather than noise.
 */
export const DEFAULT_PERMISSION_POSTURE: PermissionPosture = 'unguarded';

/** `[permissions]`. */
export interface PermissionsConfig {
  /** TOML `permissions.mode`. Anything unrecognised warns and falls back to the default. */
  mode: PermissionPosture;
}
