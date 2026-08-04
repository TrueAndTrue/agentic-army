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
}
