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
 * A rule, in firstmate's `rules[]` shape — verbatim, from day one.
 *
 * `when` is a natural-language predicate the dispatcher matches against the task; `why` is not
 * decoration, it is the audit trail for why a vendor was chosen.
 */
export interface DispatchRule {
  /** e.g. "Any change to any file." */
  when: string;
  /**
   * Candidates, best first. SINGLE-ENTRY TODAY: v1 is a static vendor split by role, with zero
   * quota machinery. It is an array anyway so that upgrading to firstmate's quota-resolved
   * candidate arrays is a CONFIG CHANGE, NOT A REWRITE.
   */
  use: DispatchTarget[];
  /** e.g. "Reviewer must not share the builder's blind spots." */
  why: string;
}

/**
 * The static vendor split: ENGINEER/SCOUT → claude, INSPECTOR/SENTRY → codex.
 *
 * Both subscription pools get used without coordination, and cross-vendor review independence
 * becomes STRUCTURAL rather than a rule someone must remember: a Sonnet Inspector reviewing
 * Sonnet-written code shares its training and its blind spots; a GPT Inspector does not.
 *
 * The accepted weakness is real — Claude exhausts and every Engineer stops while Codex sits at
 * 85%. That is the trigger to build quota resolution, at which point `use` grows entries.
 * When that day comes, adopt firstmate's hardest rule verbatim: **never downgrade reasoning
 * class to conserve quota** — report that the strongest-class choice cannot proceed instead.
 */
export interface DispatchConfig {
  rules: DispatchRule[];
  /** Used when no rule matches. If absent, an unmatched task is an error, not a guess. */
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
