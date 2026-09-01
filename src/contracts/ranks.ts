/**
 * Ranks and roles.
 *
 * Rank is authority. Role is branch of service. They are orthogonal: any role can hold any
 * rank. Rank is assigned by the spawner and MUST be strictly junior to the spawner's own rank
 * (`isStrictlyJuniorTo`) — it is never derived from depth. Depth and rank are separate columns
 * in the UI and the gap between them is diagnostic.
 */

/**
 * Seniority order, most senior first. Index into this array IS the seniority number.
 *
 * The order is real US Army seniority, so a tree that reads top to bottom also reads senior to
 * junior. MAJOR sits between COLONEL and CAPTAIN and holds the feature owner (`MAJ·OVERSEER`),
 * which is why it was inserted rather than appended: the alternative was demoting the engineers
 * and the inspectors, whose CAPTAIN rank is already the one the rest of the tables are built on.
 */
export const RANK_ORDER = [
  'GENERAL',
  'COLONEL',
  'MAJOR',
  'CAPTAIN',
  'SERGEANT',
  'PRIVATE',
] as const;

export type Rank = (typeof RANK_ORDER)[number];

/**
 * COMMANDER is the branch of service that only ever talks.
 *
 * It exists because `army chat` needs a soldier whose loadout is ONE INERT TOOL — no Read, no
 * Grep, no Edit, no Bash — and a loadout is chosen by role. Reusing SCOUT would have handed it
 * Read/Grep/Glob/WebFetch, which is precisely the capability that burns a commanding agent's
 * window one file at a time; reusing ENGINEER would have handed it a shell. Neither is a
 * commanding agent, and the difference is not a matter of prompting.
 *
 * ONE INERT TOOL, AND NOT ZERO — the distinction is the reverse of what it looks like.
 * `ROLE_ALLOW.COMMANDER` in `src/command/permissions.ts` is `['TodoWrite']`, and that entry must
 * never be taken out in the name of tidying: `buildClaudeArgs` emits `--allowedTools` only when
 * the list has something in it, so an allow-list holding zero rules drops the flag altogether,
 * and a claude worker spawned without that flag inherits the harness default — which is every
 * tool there is. The emptiest allow-list this codebase can spell is therefore the MOST PERMISSIVE
 * spec it can send, which is why `assertAllowListNonEmpty` refuses that spec at spawn time for
 * every worker, and why `assertCommanderLoadout` refuses a COMMANDER that has additionally grown
 * a rule touching the filesystem, a shell or the network. `TodoWrite` writes a checklist into a
 * context window and never a byte onto disk; it is what keeps the flag on the command line and
 * every other tool off it.
 *
 * A COMMANDER delegates and reads capped reports. That is its whole tool loadout, and because
 * the loadout is derived from this value rather than asserted in a briefing, it is a property of
 * the process rather than a request made of the model.
 *
 * OVERSEER and VALIDATOR are the feature-owning and final-judgement branches of service.
 *
 * An OVERSEER owns one feature: it segments the work into workstreams, asks for an engineer per
 * workstream, adjudicates what the inspectors find, decides which accepted workstream merges into
 * the integration branch and when, and answers the questions climbing to it from below. It is the
 * rank ladder made useful: the unit that exists so a question does not have to reach a human to be
 * answered.
 *
 * It DECIDES the merge and does not perform it. The supervising process runs it, exactly as it
 * runs the rung 3 merge that no worker may perform at any rank, which is why the role holds no
 * editor and no shell (`ROLE_ALLOW.OVERSEER`). A conflict needing content-level judgement becomes
 * a reconciliation workstream a fresh engineer resolves in its own worktree and an inspector
 * reviews. An overseer that resolved one by hand would be an overseer whose work nothing reviews.
 *
 * A VALIDATOR is the last unit of a campaign. It judges the MERGED branch against the ORIGINAL
 * ask, which is a different question from the one an INSPECTOR answers about a diff, and it runs
 * the spec's verification commands rather than only reading. Two questions get asked at the end
 * and they are not the same one: the acceptance gate answers "do the commands pass" mechanically,
 * and the VALIDATOR answers "is this the thing that was asked for".
 *
 * Neither is spawned by anything in this build. They are declared because a permission set and a
 * rank are the vocabulary everything else in the design is written in, and because a role that
 * exists in the table but nowhere in the code is a gap that `army --help` states out loud
 * (`test/contracts.test.ts` enforces that it does).
 */
export const ROLES = [
  'SCOUT',
  'OVERSEER',
  'ENGINEER',
  'INSPECTOR',
  'VALIDATOR',
  'SENTRY',
  'COMMANDER',
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Seniority index. Lower is more senior. GENERAL = 0 … PRIVATE = 5.
 * Never persist this number — persist the `Rank` string; the index is presentation/comparison
 * only and would silently change meaning if a rank were ever inserted. Inserting MAJOR moved
 * CAPTAIN from 2 to 3, which is exactly the drift that sentence exists to warn about.
 */
export const RANK_SENIORITY: Record<Rank, number> = {
  GENERAL: 0,
  COLONEL: 1,
  MAJOR: 2,
  CAPTAIN: 3,
  SERGEANT: 4,
  PRIVATE: 5,
};

/** UI glyphs. Ordered by visual weight, so a tree reads as a ladder without reading the labels. */
export const RANK_GLYPH: Record<Rank, string> = {
  GENERAL: '☆', // ☆
  COLONEL: '◆', // ◆
  MAJOR: '◈', // ◈
  CAPTAIN: '◇', // ◇
  SERGEANT: '▪', // ▪
  PRIVATE: '·', // ·
};

/** Three-letter unit prefix used in labels: `CPT·ENGINEER · take-hill-4`. */
export const RANK_ABBREV: Record<Rank, string> = {
  GENERAL: 'GEN',
  COLONEL: 'COL',
  MAJOR: 'MAJ',
  CAPTAIN: 'CPT',
  SERGEANT: 'SGT',
  PRIVATE: 'PVT',
};

export const SUBSTRATES = ['process', 'subagent'] as const;
export type Substrate = (typeof SUBSTRATES)[number];

/**
 * Substrate. Commanding ranks are real OS processes (durable, observable,
 * resumable); the cheap fan-out layer below them uses native Claude Code subagents (free depth).
 * A `subagent` rank has no session of its own on disk — it is reconstructed from the parent
 * process's stream via `--forward-subagent-text` + `parent_tool_use_id`.
 */
export const SUBSTRATE: Record<Rank, Substrate> = {
  GENERAL: 'process',
  COLONEL: 'process',
  MAJOR: 'process',
  CAPTAIN: 'process',
  SERGEANT: 'subagent',
  PRIVATE: 'subagent',
};

/**
 * Officers never edit files.
 *
 * This is simultaneously the context guard and the safety property: the ranks holding strategy
 * are structurally incapable of a bad `rm`.
 *
 * `permissionsFor` in `src/command/permissions.ts` reads this map on every spawn and subtracts
 * the write-capable tools — Edit, Write, NotebookEdit and the shell — from the loadout of any
 * rank whose entry is `false`, whatever its role asked for, and names them on the deny half as
 * well. Flip an entry here and the tools a worker of that rank receives change; there is no
 * second copy to keep in step and no generator to re-run.
 *
 * MAJOR IS `false`, AND IT WAS BRIEFLY `true`. The reason it was flipped is worth keeping,
 * because the pressure that produced it will come back.
 *
 * `WRITE_CAPABLE_TOOLS` counts `Bash` as write-capable, because a `Bash(prefix:*)` rule bounds the
 * START of a command line and nothing after it, so there is no spelling of a shell rule that is
 * provably read-only. A rank marked `false` here therefore loses every shell rule its role asked
 * for, scoped or not. When the `MAJ·OVERSEER` was given git prefixes so it could merge, `false`
 * would have subtracted them on the way to the harness, so the rank was made a writing rank to
 * keep them: a table changed to fit a loadout.
 *
 * The loadout was the thing that was wrong. The overseer does not run the merge: it DECIDES which
 * workstream merges and when, and the supervising process performs the merge, exactly as it
 * already performs the rung 3 merge that no worker may perform at any rank. So `ROLE_ALLOW`
 * grants it no shell, there is nothing for this entry to subtract, and MAJOR goes back to `false`
 * with the officers. Exactly one rank writes, and it is the one rank that leases a worktree.
 *
 * The consequence is the same at both ends: a `MAJ·OVERSEER` holds Read, Grep, Glob and TodoWrite,
 * whether that is read off the role half or the rank half. See the OVERSEER entry in `ROLE_ALLOW`
 * for why a feature owner that can edit or resolve a conflict by hand stops being a reviewer of
 * its engineers.
 */
export const WRITES_FILES: Record<Rank, boolean> = {
  GENERAL: false,
  COLONEL: false,
  MAJOR: false,
  CAPTAIN: true,
  SERGEANT: false,
  PRIVATE: false,
};

/**
 * WHY THE TWO SUBAGENT RANKS DO NOT WRITE — the ruling, and what it was measured against.
 *
 * Both entries read `true` for the length of a build, and neither had ever been checked against a
 * unit that existed: nothing below CAPTAIN was fieldable, so the value was an inherited permissive
 * default rather than a decision. It is a decision now, and it is `false`, for three reasons that
 * are properties of the substrate rather than preferences.
 *
 * 1. A SUBAGENT RANK HAS NO WORKTREE. CAPTAIN is the lowest rank that leases one; a subagent runs
 *    inside its parent's process, in its parent's leased tree. So a writing SERGEANT does not write
 *    in its own workspace — it writes in someone else's, beside its siblings. Measured on claude
 *    2.1.221: the spawn tool returns `Async agent launched successfully` and the parent does NOT
 *    block, so a fan-out of four is four writers in one directory, racing each other and the index
 *    lock. The branch that comes out is one the CAPTAIN has to own without having made it, and the
 *    review gate reviews that branch. Attribution is the thing the gate is for.
 *
 * 2. THE SUBAGENT NARROWING VOCABULARY CANNOT SPELL A SCOPED SHELL. A subagent's loadout is
 *    declared to the harness as a list of tool NAMES; there is no position in it for the
 *    `Bash(git:*)` form that keeps a CAPTAIN's shell inside its lane. `WRITE_CAPABLE_TOOLS`
 *    includes `Bash` precisely because a prefix rule constrains the START of a command line and
 *    nothing after it — and a subagent cannot even be handed the prefix. Measured: a subagent
 *    granted `Bash` under a session whose only shell rule was `Bash(echo:*)` ran `whoami`
 *    successfully, and was refused `curl`. A shell arrived, and its real boundary was neither this
 *    codebase's rule nor a thing this codebase can state.
 *
 * 3. IT IS WHAT THE LAYER IS FOR. The cheap fan-out layer earns its keep by burning context on
 *    reading and handing back a capped report — many windows spent, one summary ingested. Writing
 *    stays at the rank that holds the tree, the branch and the report. A SERGEANT that reads
 *    widely and returns a bounded answer is the whole benefit; a SERGEANT that also edits is the
 *    benefit plus an unattributable diff.
 *
 * The consequence is visible and intended: `writesFiles('SERGEANT', 'ENGINEER')` is `false`, so a
 * SGT·ENGINEER holds Read/Grep/Glob/TodoWrite and no editor and no shell — the same intersection
 * that has always given a COLONEL·ENGINEER a read-only loadout, applied at the other end of the
 * order. Rank narrows; it never widens.
 */

/**
 * Whether a rank may field units of its own.
 *
 * PRIVATE is the floor, and the floor is the bound. A subagent that can spawn subagents recurses,
 * and every level of that recursion is billed to one subscription — so the floor cannot be a
 * sentence in a briefing that a model may reason its way past. `narrowToRank` subtracts the spawn
 * tools from a rank whose entry here is `false` and `rankDeny` names them, so a PRIVATE reaches
 * the harness holding no tool that spawns anything. Measured on claude 2.1.221: a subagent whose
 * declared loadout omits the spawn tool reports that it has no way to spawn one, and the tool is
 * absent from its list rather than present-and-refused.
 *
 * SERGEANT IS ALSO `false`, AND THAT IS A NARROWER TABLE THAN THE ONE THIS PROJECT INTENDS. The
 * distinction the design draws between the two subagent ranks is exactly this entry — a SERGEANT
 * leads a squad, a PRIVATE is one shot — so with both `false` the two ranks are currently
 * indistinguishable in capability, and only their briefings differ. It is deliberate and it is
 * temporary:
 *
 *   - this is the FIRST time anything below CAPTAIN has ever been fielded. The recursion is the
 *     one failure here whose cost is unbounded and whose bill arrives on somebody's subscription,
 *     and the conservative direction on a first fielding is the one where the fan-out is one level
 *     wide and every level of it is visible in the archive before a second is authorised;
 *   - `maxSubagentDepth('CAPTAIN')` is therefore 1, not 2, and the harness-enforced nesting cap
 *     that goes onto the worker's environment is that same 1. The bound is not a claim about what
 *     a model will choose to do.
 *
 * Turning a SERGEANT into a real squad is this one entry. Flipping it to `true` moves the derived
 * cap, the roster, the deny rules and the depth the archive can record, all from here — which is
 * the point of the value being read rather than restated. Do it when there is a campaign whose
 * shape actually wants two levels, and watch the first one that uses it.
 */
export const SPAWNS_UNITS: Record<Rank, boolean> = {
  GENERAL: true,
  COLONEL: true,
  MAJOR: true,
  CAPTAIN: true,
  SERGEANT: false,
  PRIVATE: false,
};

/**
 * Roles that write files at all — meaning HOLD Edit/Write/NotebookEdit, not "cannot cause a byte
 * to change". A role that runs `npm test` in a writable tree changes bytes and can still be
 * `false` here; the question this map answers is which roles are issued an editing tool.
 *
 * THE INSPECTOR IS STILL `false`, AND IT NOW HOLDS AN EDITOR ON SOME SPAWNS. That is not a
 * contradiction, it is the reason this map answers a narrower question than it looks like. The
 * design wants the reviewer to write the test that exercises its own finding. An earlier pass
 * bought that by flipping this entry and scoping the editing tools to test paths in `ROLE_ALLOW`,
 * and the scope did not scope: the role runs on codex, which reads only the deny half of a
 * permission set, and the shipped posture is `unguarded`, which drops argv scoping on claude.
 *
 * The grant is back, and it is somewhere else. It is a SUPERVISOR DECISION TAKEN PER SPAWN — see
 * `INSPECTOR_TEST_WRITE_RULES` in `src/command/permissions.ts` — because its fourth precondition
 * is that a `CPT·VALIDATOR` re-runs what the reviewer wrote, which is true of some campaigns and
 * false of others. A role table cannot say "iff a validator follows". So the ROLE holds no editor,
 * this entry says so, `permissionsFor` still refuses a loadout that disagrees with it, and the
 * per-spawn grant goes through a guard of its own that reads the spec about to go on the wire.
 *
 * Intersected with `WRITES_FILES` by rank in `writesFiles` below. Checked against the loadout it
 * describes on every spawn: `permissionsFor` refuses a role whose `ROLE_ALLOW` entry disagrees
 * with this map, in either direction, so the two cannot drift apart in silence.
 */
export const ROLE_WRITES_FILES: Record<Role, boolean> = {
  SCOUT: false,
  // An OVERSEER reviews its engineers' work and decides what merges. A feature owner that can
  // edit will edit, and then nothing above an engineer is reviewing what the engineer did. So the
  // role holds Read, Grep, Glob and TodoWrite: no editing tool and no shell, at any rank.
  OVERSEER: false,
  ENGINEER: true,
  INSPECTOR: false,
  // A VALIDATOR runs the spec's verification commands against the merged branch and judges the
  // result against the original ask. It reports; it never changes what it is judging.
  VALIDATOR: false,
  SENTRY: false,
  COMMANDER: false,
};

/**
 * Whether a unit of this rank and role holds a tool that puts bytes on disk — the intersection
 * rule, in one place.
 *
 * Rank narrows; it never widens. A role asks for a loadout and its rank subtracts from it, so a
 * COLONEL·ENGINEER writes nothing even though every ENGINEER asks to, and no rank can hand an
 * INSPECTOR an Edit tool the role never asked for.
 */
export function writesFiles(rank: Rank, role: Role): boolean {
  return WRITES_FILES[rank] && ROLE_WRITES_FILES[role];
}

/**
 * True iff `child` is strictly junior to `parent` — the spawn rule.
 *
 * A rank may never spawn its own rank or above. Equal ranks are NOT junior, so this is a strict
 * comparison: `isStrictlyJuniorTo('CAPTAIN', 'CAPTAIN') === false`.
 *
 * Note it is legal to skip ranks: a GENERAL may detach a CAPTAIN directly without standing up a
 * ceremonial COLONEL.
 */
export function isStrictlyJuniorTo(child: Rank, parent: Rank): boolean {
  return RANK_SENIORITY[child] > RANK_SENIORITY[parent];
}

/**
 * Every rank a unit of `parent` may field. Strictly junior, seniority order.
 *
 * The spawn rule as a LIST rather than as a predicate, because the two answer different questions
 * and only one of them can be enumerated: `isStrictlyJuniorTo` checks a pairing somebody already
 * chose, and this decides what the choices are. A roster built from this cannot contain a rank the
 * predicate would reject, so the two can never disagree about a rank that is actually fielded.
 */
export function fieldableRanks(parent: Rank): Rank[] {
  if (!SPAWNS_UNITS[parent]) return [];
  return RANK_ORDER.filter((candidate) => isStrictlyJuniorTo(candidate, parent));
}

/**
 * The ranks a unit of `parent` may field AS NATIVE SUBAGENTS — strictly junior AND on the subagent
 * substrate. For a CAPTAIN that is SERGEANT and PRIVATE, and it is derived from the two tables
 * above rather than typed out, so moving a rank across the substrate line moves the roster with it.
 */
export function subagentRanksUnder(parent: Rank): Rank[] {
  return fieldableRanks(parent).filter((rank) => SUBSTRATE[rank] === 'subagent');
}

/**
 * How many levels of native subagent a unit of `parent` may nest, counting the first level as one.
 *
 * DERIVED, never a constant. The bound is a fact about the rank table — you may field the subagent
 * ranks junior to you, each of those may field the ones junior to IT, and the chain stops at the
 * rank that spawns nothing. Writing `2` here instead would be a number that stops tracking the
 * table the day a rank is inserted, which is exactly how a cap becomes decorative.
 */
export function maxSubagentDepth(parent: Rank): number {
  const ranks = subagentRanksUnder(parent);
  if (ranks.length === 0) return 0;
  let deepest = 0;
  for (const rank of ranks) {
    const below = SPAWNS_UNITS[rank] ? maxSubagentDepth(rank) : 0;
    if (1 + below > deepest) deepest = 1 + below;
  }
  return deepest;
}

/**
 * Refuse a spawn that the rank table does not permit — the spawn rule, where the spawn happens.
 *
 * Two separate refusals, because they are two separate mistakes: a rank that fields ANYTHING when
 * it is the floor, and a rank that fields its own rank or above. The second is the one the
 * documentation has always stated and nothing enforced; stating it in a comment leaves it true
 * only for as long as everyone remembers, and the first unit ever fielded below CAPTAIN is exactly
 * the moment that stops being good enough.
 */
export function assertMayField(parent: Rank, child: Rank, who: string): void {
  if (!SPAWNS_UNITS[parent]) {
    throw new Error(
      `refusing to field a ${child} under ${who}: ${parent} is the floor and spawns nothing. A ` +
        'rank that can spawn its own subordinates recurses, and every level of that recursion is ' +
        'billed to one subscription. The floor is what bounds the depth, so it does not get an ' +
        'exception for one useful case.',
    );
  }
  if (!isStrictlyJuniorTo(child, parent)) {
    throw new Error(
      `refusing to field a ${child} under ${who}: a ${parent} may field ${
        fieldableRanks(parent).join(', ') || 'nothing'
      } and nothing else. Rank is authority, and authority that can reproduce itself or its own ` +
        'superiors is not authority — it is a loop.',
    );
  }
}

/**
 * Refuse a rank table whose floor is not a floor.
 *
 * ## The property, and the one it is deliberately NOT
 *
 * The obvious guard to write here is "capability never increases going down the order", and it is
 * WRONG — it would reject this project's central design decision. `WRITES_FILES` is a BAND, not a
 * slope: GENERAL, COLONEL and MAJOR do not write, CAPTAIN does, SERGEANT and PRIVATE do not. A
 * CAPTAIN is junior to a COLONEL and holds strictly more, on purpose, because officers are kept
 * incapable of a bad `rm` while the rank that owns a worktree is the rank that works in it. A
 * monotonicity
 * check over `WRITES_FILES` was written first and the suite rejected it immediately, which is the
 * only reason this paragraph exists rather than a quietly weakened table.
 *
 * What IS true, and is what the fork-bomb bound rests on, is that the ranks which spawn NOTHING
 * form an unbroken run at the BOTTOM of the order. `maxSubagentDepth` terminates because the chain
 * walks downward and eventually reaches a rank that fields nobody; if a non-spawning rank sat in
 * the middle with a spawning rank beneath it, the floor would be a hole rather than a floor, and
 * the recursion would resume below it.
 *
 * Called from `permissionsFor` on every spawn rather than at module load, deliberately: a throw at
 * import time takes the whole suite down at the point where a break was planted, and a guard whose
 * failure reads as "the module would not load" is a guard nobody can read the output of.
 */
export function assertRankFloorContiguous(): void {
  let seenFloor: Rank | null = null;
  for (const rank of RANK_ORDER) {
    if (!SPAWNS_UNITS[rank]) {
      seenFloor ??= rank;
      continue;
    }
    if (seenFloor !== null) {
      throw new Error(
        `refusing to build any loadout: SPAWNS_UNITS lets ${rank} field units while ${seenFloor}, ` +
          'which outranks it, fields none. The ranks that spawn nothing must be an unbroken run ' +
          'at the bottom of the order — that run is the floor, and the floor is the only thing ' +
          'that bounds a recursion billed to one subscription. A gap in it is not a floor with an ' +
          'exception; it is a floor with a hole, and the spawning resumes underneath.',
      );
    }
  }
}

/**
 * The UI label for a unit: `CPT·ENGINEER · take-hill-4`.
 * Omit `taskId` for a unit not yet bound to a task (e.g. a GENERAL holding a campaign).
 */
export function formatUnit(rank: Rank, role: Role, taskId?: string): string {
  const unit = `${RANK_ABBREV[rank]}·${role}`;
  return taskId === undefined || taskId === '' ? unit : `${unit} · ${taskId}`;
}

/** `☆ GEN·ENGINEER` — the glyph-prefixed form for tree views. */
export function formatUnitWithGlyph(rank: Rank, role: Role, taskId?: string): string {
  return `${RANK_GLYPH[rank]} ${formatUnit(rank, role, taskId)}`;
}
