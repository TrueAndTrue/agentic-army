/**
 * Delivery.
 *
 * **Push is durability. PR and merge are delivery.** Conflating them is what makes "stop at
 * commit" look incompatible with returning a lease.
 *
 * - **Durability is UNCONDITIONAL and uncapped.** Work leaves the ephemeral worktree for a real
 *   git ref before the lease is released — the origin remote if the project has one, otherwise
 *   a bare mirror at `~/.agentic-army/mirrors/<basename>-<sha1-8>.git`, where the digest is of
 *   the project's ABSOLUTE path (`mirrorPathFor`, `src/delivery/durability.ts`). The digest is
 *   load-bearing, not noise: without it `~/work/api` and `~/oss/api` share one bare repo and
 *   their identical `army/<task-id>` branches collide. No ceiling suppresses this: the
 *   pool never drains and no overnight run is ever lost. A ceiling of 0 does not mean "do not
 *   persist", it means "your repo stays untouched".
 * - **Delivery IS capped.** The rungs are prefixes, not alternatives, so a ceiling is a clamp
 *   (`effectiveRung`), never a veto. A campaign may go lower; never higher.
 */

/** 0 commit · 1 push · 2 pull request · 3 merge. Prefixes, not alternatives. */
export type Rung = 0 | 1 | 2 | 3;

export const RUNGS = [0, 1, 2, 3] as const;

export const RUNG_MEANING: Record<Rung, string> = {
  0: 'commit — durable in the army mirror, your repo untouched',
  1: 'push — branch on origin, no PR',
  2: 'pull request — opened, Inspector verdict posted as a review',
  3: 'merge — after Inspector PASS (+ green CI if a Sentry is watching)',
};

/** Short label for tree views and tables. */
export const RUNG_LABEL: Record<Rung, string> = {
  0: 'commit',
  1: 'push',
  2: 'pull request',
  3: 'merge',
};

/**
 * A project's delivery ceiling.
 *
 * `project` is an ABSOLUTE path. Raising a ceiling is a deliberate edit to the user's global
 * config outside any conversation — see the security note on `GlobalConfig.projects`.
 */
export interface ProjectPolicy {
  project: string;
  ceiling: Rung;
}

/** Where durability lands. Always populated — durability is not optional. */
export interface DurabilityTarget {
  /** `remote` = the project has an origin; `mirror` = bare repo in the army archive. */
  kind: 'remote' | 'mirror';
  /** Git remote name, e.g. `origin` or `army-mirror`. */
  remote: string;
  /** Remote url or absolute mirror path. */
  url: string;
}

/**
 * The resolved plan for landing one task's work.
 *
 * `rung` MUST equal `effectiveRung(requested, ceiling)`; `requested` and `ceiling` are retained
 * so a clamp is visible and auditable rather than silent.
 */
export interface DeliveryPlan {
  taskId: string;
  /** Absolute project path — the key into `GlobalConfig.projects`. */
  project: string;
  /** What the campaign asked for. */
  requested: Rung;
  /** What the project's policy permits. */
  ceiling: Rung;
  /** The clamped result. Never greater than `ceiling`. */
  rung: Rung;
  /** `army/<task-id>` — the branch cut inside the worktree. */
  branch: string;
  /** Unconditional; unaffected by `rung`. */
  durability: DurabilityTarget;
  /**
   * True when the clamp actually bit, i.e. `requested > ceiling`. Worth a signal row so the
   * commander learns the campaign is shipping lower than it asked for.
   */
  clamped: boolean;
}

/**
 * Clamp a requested rung to a project's ceiling. NEVER exceeds the ceiling — this is the whole
 * safety property of the ladder: no prompt, however persuasive, however tired you are, can escalate
 * blast radius on a repo you deliberately locked down, because the ceiling is not reachable
 * from the conversation.
 */
export function effectiveRung(requested: Rung, ceiling: Rung): Rung {
  return requested <= ceiling ? requested : ceiling;
}

/**
 * At rung 0 there is nothing on origin to branch from, so tasks must be independent; at rung >= 1
 * task B may branch from A's pushed ref. This is why the ladder also settles task dependencies.
 */
export function allowsTaskDependencies(rung: Rung): boolean {
  return rung >= 1;
}
