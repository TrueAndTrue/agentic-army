# The main flow

The three phases a feature passes through, who runs each one, what they are allowed to touch, and
which of it exists. Written 2026-08-30 from the Main Flow diagram; the design is unchanged since,
and the state sections were re-read against the tree at `d40e1fa` on 2026-09-01.

## How to read this

The first version of this document mixed design intent with a gap analysis written against
`18f8bf0`, and within four commits the gap analysis was lying — it said phase 2 was "MISSING almost
entirely" while an overseer was cutting features into concurrent workstreams. A design document
whose status section rots is worse than one with no status section, because the design half stays
true and lends the stale half its credibility. So the two are separated here and labelled:

- **Part 1 is the design.** It does not change when code lands. If the code disagrees with it, one
  of the two is wrong and that is worth an argument.
- **Part 2 is what is built**, as of `d40e1fa`, with the measurements taken along the way that are
  worth keeping.
- **Part 3 is what is not built.** Short, current, and the only section that should ever need
  editing when something ships.
- **Part 4 is where the code disagrees with its own prose** — sentences a model or a reader is
  handed that stopped being true. Found while writing the README; recorded here rather than fixed,
  because fixing them is a code change and this is a document.

---

# Part 1 — the design

## The ladder

Rank is authority. Role is branch of service. They stay orthogonal, and a spawner may only assign
a rank strictly junior to its own (`isStrictlyJuniorTo`). The order below is real US Army
seniority, so a diagram that reads top to bottom also reads senior to junior.

| Rank | Who holds it | Spawned by |
| --- | --- | --- |
| GENERAL | the supervising process that owns a campaign | nothing, it is the process |
| COLONEL | the Commander you talk to | the process, at session start |
| MAJOR | the feature owner, one per feature | the GENERAL, on an approved dispatch |
| CAPTAIN | engineers, inspectors, the validator, scouts | the MAJOR (or the COLONEL, for a phase 1 scout) |
| SERGEANT | sub-agents a scout or an engineer needs | a CAPTAIN |
| PRIVATE | spare depth below a SERGEANT | a SERGEANT |

MAJOR is the one addition to `RANK_ORDER`. It exists so the feature owner sits between the
Commander and the workers without demoting `CPT·ENGINEER` and `CPT·INSPECTOR`, which are already
correct. The diagram called the feature owner a Captain and the engineers Colonels; those two
labels were swapped relative to both real rank and the existing code, and this table is the
un-swapped version.

Two things the diagram says that the code does differently, deliberately:

A model never spawns anything. The diagram says "the commander spawns a Captain". In the code the
Commander *proposes* and the supervising GENERAL *spawns*, because a spawn is an authority
decision and a model's output is not authority. Everything below reads "the MAJOR spawns an
engineer" as shorthand for "the MAJOR asks, the supervisor spawns".

Depth and rank are separate. A SERGEANT three levels down is still a SERGEANT. The gap between
depth and rank is diagnostic and both are shown in the tree.

## Roles

Existing before this design: `SCOUT`, `ENGINEER`, `INSPECTOR`, `SENTRY`, `COMMANDER`.

Three changes:

**`OVERSEER` is new.** The feature owner. Fans out workstreams, adjudicates findings, decides which
branch integrates and when, and answers questions climbing from below. This is the name I am least
sure of; it is one constant and a rename is cheap.

**`VALIDATOR` is new.** The last agent of phase 3. It judges the merged branch against the
*original ask*, which is a different question from the one an `INSPECTOR` answers about a diff,
and it needs to run things rather than only read them.

**`INSPECTOR` grows a scoped write.** The diagram has the reviewer writing tests. Before this
design an inspector could not write at all. See Permissions for how far that write reaches, the
hazard it introduces, and the measurement that decided where the containment had to live.

## Permissions

Every worker is denied write access to `~/.agentic-army/**` regardless of role, and no allow-list
is ever empty (an empty one drops `--allowedTools` and inherits every tool there is).

| Role | Reads | Writes | Runs | Network |
| --- | --- | --- | --- | --- |
| COMMANDER | nothing | nothing | nothing | no |
| SCOUT | repo, no worktree | nothing | nothing | yes, fetch and search |
| OVERSEER | repo, diffs handed to it | nothing | nothing | no |
| ENGINEER | repo | anything inside its own worktree | yes | no |
| INSPECTOR | repo, the diff under review | test paths only, and only where a VALIDATOR follows | test commands only, none that writes in place | no |
| VALIDATOR | repo, archive | nothing | the spec's verify commands | no |
| SENTRY | CI status | nothing | `gh` reads only | yes |

The `COMMANDER` row is unchanged and stays load-bearing: one inert tool, `TodoWrite`, which keeps
`--allowedTools` on the command line while putting no capability behind it.

The `OVERSEER` row deliberately withholds a general edit. It can inspect code directly, which the
diagram calls for, but "inspect" is `Read`, `Grep` and `Glob`. A feature owner that can edit will
edit, and then nothing above it is reviewing an engineer's work.

### The INSPECTOR row is the hazard, and four things had to hold

The write is GRANTED — per spawn, by the supervisor, never by the role table, and only where a
`CPT·VALIDATOR` will re-run what it wrote. An inspector that can write can make its own verdict
pass. Four preconditions, each worth a different amount on a different configuration:

1. **The containment is expressed as a DENY, not as a scoped allow.** The Inspector runs on codex,
   and `src/harness/codex.ts` says plainly that codex has no equivalent of the permission model:
   it reads `spec.deny` to build sandbox roots and never reads `spec.allow` at all. A scoped
   allow-list on this role is not weakened on codex, it is absent.

   On claude the picture is BETTER than this document used to predict, and the correction is
   worth making because the wrong version argues for a weaker design. `unguarded` collapses scoped
   rules to bare tool names, but `unscoped()` runs INSIDE `permissionsFor`, and `buildSoldierSpec`
   appends these 27 rules afterwards — so they arrive path-scoped at BOTH postures. `Edit(test/**)`
   is a real bound on claude wherever it is read. What the deny half is for is codex, where the
   allow half is not read at all, and the fact that deny beats allow when both are.

2. **The shell it already holds cannot write the tree.** `Bash(prettier:*)`, `Bash(eslint:*)` and
   `Bash(ruff:*)` each have a documented in-place write mode. All three are GONE from
   `VERIFY_BASH_PREFIXES` rather than narrowed: a prefix rule constrains the start of a command
   line and nothing after it, so `Bash(prettier --check:*)` still permits a trailing `--write`.

3. **Its verdict and its test authorship land in the archive as separate signals**, so "it passed"
   and "it wrote the thing that passed" are separately visible. A `status` signal listing the files
   it wrote, beside the `report` signal carrying the verdict, plus an `authorship` note.

4. **Tests it writes run under the `VALIDATOR` afterwards, in a process the inspector does not own,
   AND THEY BECOME HISTORY ONLY AFTER ONE HAS.** The first spelling of this was a boolean handed to
   `assertInspectorWriteContained` at spawn time, and it was wrong twice over: nothing computed it,
   so the refusal could never fire; and a spawn is not a moment at which "a validator will run" is
   knowable, because the validator is skipped whenever a workstream ends other than delivered,
   integration fails, the gate never passes inside the validation budget, or an abort lands in
   between. Two workstreams and one refusal was enough — zero validators ran, both inspectors held
   all 27 rules, and a reviewer's test sat committed on a durable branch under a note saying a
   validator would run it.

   So the supervisor now HOLDS what a reviewer writes out of history. The content comes out of the
   workstream tree, the tree goes back as if the test were temporary, and the files are applied to
   the integration tree for the acceptance gate and the validator to execute. `commitInspectorTests`
   writes them onto the integrated branch only when it is handed the validator that ran them, and
   refuses otherwise — the same check, at the one moment it can be true or false rather than
   asserted. This is also why the grant still cannot live in `ROLE_ALLOW`: it is a supervisor
   decision about one spawn, not a property of the role.

   The VALIDATOR itself may write NOTHING at all, test paths included. It is the last agent of
   phase 3, so a test it wrote would be executed only by the run whose verdict it supports, and the
   supervisor reads its tree back on the same discipline every per-workstream reviewer gets:
   anything it wrote discards its verdict and is put back, because a dirty integration tree is
   merged work that cannot be made durable.

**And the honest part, which is the reason item 4 is not merely a nicety.** On the configuration
this project SHIPS — codex, `unguarded` — item 1's deny half and item 2 buy nothing (item 1's allow
half does bind, but only on claude). `codexConfinement` reports every containment rule
`unenforceable` (they are worktree-relative, which is deliberate: an absolute write-deny inside the
writable root is a `breach` and codex refuses to spawn on one), and a bare `Bash` writes the tree
with `sed -i` whatever the editor is scoped to. So the containment that actually holds is item 3's
reading, used as a gate: the supervisor lists what the reviewer changed in its tree and DISCARDS
the verdict if any of it is not a test path. That is harness-independent and posture-independent,
and it is checked by construction on both harnesses at both postures rather than described.

A reviewer can still write. It cannot write and be believed.

## Phase 1, planning and alignment

The Commander may ask for a `SCOUT`, and a human confirms the question with its own keystroke —
a reader and a writer are different decisions and they do not share a prompt. A scout reads the
repo and the web, may field its own sub-agents when a question splits, and returns a written
finding. It never writes to the repo and it holds no worktree.

Its fan-out is bounded three ways, and only two of them are mechanisms this code owns. Depth is the
harness's nesting cap, derived from the rank table. Count is measured off the scout's own event
stream by the supervising process, which kills the process at the crossing — a roster says who may
be fielded and cannot say how many. Cost follows from those two plus a wall clock, with a session
ledger refusing a further recce once the conversation has spent enough on reconnaissance. The
finding is worker-authored, so it is capped by schema and neutralised once at capture in
`src/command/scout.ts`, and every surface that prints it says whose words it carries.

The Commander then interrogates you until the `TechnicalSpec` is full: objective, files in scope,
acceptance, behaviours and edge cases, decisions already made, constraints, and optionally
verification commands.

Phase 2 begins when the alignment gate passes, and the gate is mechanical rather than a
judgement:

- every required spec field is non-empty, and
- the verification commands execute against the base commit, even if they fail, and
- you confirm with a keystroke.

The middle condition draws one line and it is the line the whole gate is built around. A command
that RUNS and exits non-zero passes, with its reading banked, because a red test is the normal
starting point for work meant to turn it green. A command a shell cannot execute at all
(`SHELL_CANNOT_EXECUTE`, 126 and 127), one that produces no exit code, and one still running at the
deadline each fail: none of them has said anything about the work, and `src/contracts/verify.ts`
already draws the timeout half of that distinction — a non-zero exit says the work is wrong, a
timeout says nobody found out.

The keystroke is LAST, and that ordering is the change. It confirms a gate that already passed
rather than being the whole gate, which is what one keystroke on a printed objective was.

The second condition is the one that earns its place. A criterion nobody has ever run is a
criterion nobody has agreed to, which is the incident that put `src/verify/gate.ts` in the
codebase. Running the commands at alignment time also gives phase 3 a baseline to compare
against, so "this test was already failing" stops being an argument an agent can make later.

The interrogation transcript and the settled spec are written to the campaign archive. Writing
them into the git checkout as well is `planning.spec_to_repo`, off by default: a rejected branch
should not strand design documents in the repo, and the archive is already append-only and audited.
The config key decides whether the repository ALSO gets a copy; it never decides whether the
decision was recorded, because a record with an off switch is a record nobody can rely on.

## Phase 2, implementation

The GENERAL spawns one `MAJ·OVERSEER` per feature, briefed with the spec and the scout's
findings. The overseer decides how many workstreams the feature needs and asks for an engineer
each. Each engineer gets its own worktree from the existing provider.

The overseer segments the work before it spawns anyone. Each workstream is declared with the
files or modules it owns, and the segmentation is part of the plan you can see, not a private
decision.

Segmentation is the plan, not a fence. An engineer that needs a file another workstream owns says
so and keeps working. What it must not do is discover the overlap silently, so the overseer is
told the moment it happens and can decide whether to redirect the work, hold one workstream, or
let both proceed and reconcile later.

Three mechanisms follow from that:

**Declared ownership, checked at spawn.** Two workstreams claiming the same file up front is a
planning error the overseer fixes before an engineer is spent on it.

**Overlap announced at the moment of the write.** A claim on a file outside a workstream's
declaration raises a signal. It is a notification and not a refusal, because a fence around the
files an engineer may touch turns a solvable merge into a blocked workstream.

**Integration is incremental, and the supervisor performs it.** The overseer decides which
workstream merges and when. The supervising process runs the merge, exactly as it already runs
the rung 3 merge that no worker is allowed to perform at any rank. Merging incrementally rather
than accumulating branches means the first conflict surfaces after one workstream instead of
after five.

A merge that git resolves needs nobody. A conflict that needs content-level judgement becomes a
reconciliation workstream: a fresh engineer resolves it in its own worktree, where an inspector
reviews the resolution like any other work. What the overseer never does is edit the file itself,
which is why it holds no editor and no shell at all. An overseer that could resolve a conflict by
hand is an overseer whose work nothing reviews.

A conflict between two correct implementations of overlapping code, where the reconciliation
itself is a design decision rather than a mechanical merge, is a question and climbs to you.

### The question ladder

An engineer that is blocked or needs a decision raises a `query` signal. It climbs: the overseer
tries to answer, and only what the overseer cannot settle reaches you through the Commander.

While a question is outstanding its workstream parks and holds its worktree. Every other
workstream keeps running. Your answer resumes the parked one.

The archive already had the data model for this before any of it was built. `SIGNAL_KINDS`
includes `query` and `answer`, `ANSWERED_QUERY_SQL` decides answered-ness by the existence of a
reply rather than by a mutable column, and `to_selector` is written as `'chain'` on every campaign.
No selector resolver was ever built, for the reason the `to_selector` contract gives itself: a
question climbs an edge that already exists.

## Phase 3, test and review

When a workstream finishes, a `CPT·INSPECTOR` is spawned for it, on a different provider from the
engineer where the machine has one configured. The inspector is briefed from the *workstream's
orders and the diff*, never from the engineer's account of what it did. If only one provider is
configured the campaign continues and records the downgrade as a note, the same way a retired
worktree provider is recorded.

A slice reviewer is not asked to account for the whole feature's numbered behaviours. That question
belongs to the validator, on the integrated branch, and asking it of a fraction would fail every
workstream by construction.

The inspector looks for edge cases, unhandled errors and bad practice, and writes tests that
exercise the claim. Whether those tests are temporary or permanent follows the repo: if the spec
named verification commands and the repo has a test directory, they are permanent and land on the
integrated branch once a validator has run them. Otherwise they run and are discarded with the
worktree.

Findings go to the overseer, which either asks for another engineer against the same workstream
or accepts it. An accepted workstream merges into the integration branch. Every unusable
adjudication resolves to `retry`, which is what a campaign with no overseer does at all: an
adjudication rung must never be able to accept work by malfunctioning.

When every workstream has merged, one `CPT·VALIDATOR` runs against the integrated branch. The
validator runs the spec's verification commands and judges the result against the original ask,
with the acceptance gate's mechanical output as evidence. These are two different questions and
both get asked: the gate answers "do the commands pass", the validator answers "is this the thing
that was asked for".

A validator that says no returns to the overseer with findings, which re-enters the fix loop
under the campaign's remaining attempt budget. When the budget is gone the campaign ends
unsuccessfully and still lands its work durably, because durability is unconditional and a failed
night is still a night's work.

A workstream's retries come out of a per-workstream budget and the validation rounds out of a
campaign one. **They multiply rather than share**, for the reason `MAX_QUESTION_ROUNDS` is already
per-workstream: one pool across N concurrent workstreams turns a budget into a race, and a slice's
task and the assembled feature are different tasks with different failures.

## The chat interface

Phase 1 is a conversation and phases 2 and 3 are a running tree, and the interface has to be both
without becoming a dashboard. The existing rules hold: no alternate screen, no absolute cursor
addressing, append-only scrollback, and the status block pinned under the prompt.

**The tree lives in the status block.** `src/view/tree.ts` builds a `TreeModel` from a campaign
snapshot and `army view` renders it. The status block gets the same model, truncated to the rows it
is allowed. Nothing is re-derived in a second renderer.

**Questions arrive as blocks, not as interruptions.** A question that reaches you prints into
scrollback under its own marker with the agent and workstream that raised it, and the status block
carries a count of what is open. Nothing seizes the composer mid-keystroke. When exactly one
question is open, typing answers it and the prompt says so. When several are open the prompt names
the one you are answering and `/next` moves through them.

**The Commander stays available while a campaign runs.** This is the largest interface consequence
of making the campaign non-blocking, and the reason to do it. You can ask what is happening, and
the Commander answers from the archive rather than from a stream it is holding open.

**Ctrl-C keeps meaning "stop this answer".** During a campaign it must not silently mean "kill
sixteen agents and their worktrees". Stopping a campaign is `/stop`, and it confirms, because
every worktree in flight has to be settled rather than dropped.

**Inspecting an engineer's work does not leave the chat.** `/work <id>` prints a snapshot of one
agent into scrollback: its orders, its branch, its last activity, its diffstat. It prints rather
than opens, because a pager would need the alternate screen this UI does not use.

**The budget is visible.** Agent count, concurrency cap and spend belong in the status block from
the first spawn. A tree that can grow to dozens of agents should never be a surprise on a bill.

## Decisions taken

Four decisions taken by the Commander, recorded here because the reasoning is the part that is
expensive to reconstruct.

**Ranks follow real US Army seniority.** The diagram's Captain and Colonel labels were swapped;
the un-swapped ladder is above, with `MAJOR` added for the feature owner.

**The overseer spawns the inspector, briefed from orders.** Not the engineer. The party under
review does not write its reviewer's instructions, which is the property `campaign.ts` already
guards for today's Inspector and the one it names as most expensive to get wrong.

**A blocked workstream parks; the others continue.** You may return to several queued questions
at once. The alternative, pausing the whole campaign, wastes wall-clock that an overnight run
exists to use.

**Work is segmented up front, and overlap is reconciled rather than refused.** The overseer
declares file ownership per workstream before spawning anyone, which catches the avoidable
collisions while they are still free to fix. It does not enforce that declaration as a boundary:
an engineer that needs a neighbour's file takes it and announces it, and the overseer reconciles
at integration. Segmentation without reconciliation would block workstreams over solvable
merges; reconciliation without segmentation would spend expensive work discovering collisions a
plan would have avoided. Both, in that order.

---

# Part 2 — what is built

All of it is on `d40e1fa` and its three predecessors, and all of it is green under `npm test` and
`npm run typecheck`.

| # | Build order item | State |
| --- | --- | --- |
| 1 | `MAJOR` rank, `OVERSEER` and `VALIDATOR` roles, and their permission sets | built |
| 2 | The question ladder: `query`/`answer` dispatched, with parking and resumption | built, both rungs |
| 3 | Concurrent workstreams under an overseer, with the advisory overlap warning | built |
| 4 | The integration worktree, incremental merge, and branch archiving | built |
| 5 | Per-workstream inspectors with scoped test writes, then the validator | built |
| 6 | Phase 1's scout, the spec artifact, and the mechanical alignment gate | built |
| 7 | The chat surface: live tree, question inbox, `/stop`, `/work`, budget | built |

Two and three were the load-bearing ones. Everything after them was composition; everything before
them was naming.

## Wave 1 — the vocabulary

The `MAJOR` rank, the `OVERSEER` and `VALIDATOR` roles, and their permission sets. The overseer
holds `Read`, `Grep`, `Glob` and `TodoWrite` and nothing else, at both postures. `CAPTAIN` remains
the only writing rank.

`MAJOR` was briefly `true` in `WRITES_FILES`, and the pressure that produced it will come back:
`WRITE_CAPABLE_TOOLS` counts `Bash` as write-capable, so a rank marked `false` loses every shell
rule its role asked for, scoped or not — and an overseer given git prefixes so it could merge would
have had them subtracted on the way to the harness. The table was changed to fit a loadout. The
loadout was the thing that was wrong: the overseer decides which workstream merges, the supervisor
performs the merge, `ROLE_ALLOW` grants no shell, there is nothing to subtract, and `MAJOR` went
back with the officers.

The Inspector's scoped test-path write was built here, measured, and withdrawn. The measurement is
what survived and it is in Part 1's Permissions section: a scoped allow-list on a codex role is
absent rather than weakened, and the default posture collapses scoped rules to bare tool names. The
rules lived on for one wave as unreferenced constants carrying the four preconditions.

One guard was written wrong first and the suite caught it, which is the only reason the reasoning
is written down. The obvious property to assert about the rank table is "capability never increases
going down the order", and it is WRONG — `WRITES_FILES` is a BAND, not a slope. A CAPTAIN is junior
to a COLONEL and holds strictly more, on purpose. What IS true, and is what the fork-bomb bound
rests on, is that the ranks which spawn nothing form an unbroken run at the BOTTOM of the order:
`maxSubagentDepth` terminates because the chain walks downward and reaches a rank that fields
nobody. A non-spawning rank in the middle with a spawning rank beneath it would be a floor with a
hole, and the recursion would resume underneath.

## Wave 2 — the question ladder's outer rung

A `blocked` report MAY carry a question, `askHuman` on `CampaignOptions` reaches a human, and the
answer resumes the work as a new agent against the same task in the same worktree.

MAY, not must: requiring the question and enforcing it in `validateReport` was tried and withdrawn.
`schemas/report.v1.json` cannot express "required when another property equals a value", so a model
that followed the schema and skipped the prose lost its WHOLE report to the validator — no
`report.json`, and the block's own account of itself gone from the archive. A block with a question
climbs; a block without one is terminal exactly as it was before this wave, and everything the
worker did say is still on disk.

Both halves are `query` and `answer` signals linked by `in_reply_to`, and `isAnswered` is the
decision to resume rather than a local variable. A question round does not charge the retry budget,
on the reasoning that a human answering is not the agent failing; `MAX_QUESTION_ROUNDS` bounds it
separately, per workstream.

## Wave 3 — concurrent workstreams and integration

The `MAJ·OVERSEER`, concurrent workstreams, the advisory overlap warning, the integration worktree
and the incremental merge. The overseer segments a feature, asks for an engineer per workstream,
and fills the middle rung of the ladder so a question it can answer never reaches you. Each
workstream leases its tree inside its own pool slot and settles it there, so an unstarted workstream
holds nothing. The supervising process performs every merge; `merge` reports a conflict and never
resolves one, and a conflict becomes a reconciliation workstream for a fresh engineer.

`merge` aborts back to exactly where it started and proves the restoration against the dirty set it
captured BEFORE the attempt rather than against clean, because pool trees are warm and hold
`node_modules`. Two non-conflict failure shapes were measured and are handled where they arise: an
unrelated-histories refusal (exit 128, no `MERGE_HEAD`) and a `pre-merge-commit` hook exiting
non-zero (exit 1, `MERGE_HEAD` present, merge staged) — which is why the restore runs before the
throw.

Overlap detection is live for tool-use writes and complete at branch-diff time, and **cannot see a
shell**, which is written down rather than implied. `writtenPaths` recognises the editing tools on
both harnesses and returns nothing for `Bash`, `command_execution` and `local_shell_call`: a command
line is not a file list and guessing one from `>` or `tee` would produce a detector that is wrong in
both directions. On the shipped `unguarded` posture an engineer holds a bare `Bash`, so an absence
of live overlaps proves nothing and the branch diff is the reading integration is decided on.

This wave flagged one asymmetry rather than hiding it: an unsegmented campaign retried on an
Inspector FAIL and a segmented one ended `inspector-failed` with no retry, because there was no
per-workstream fix loop to route findings into. Wave 4 is what that was waiting for.

## Wave 4 — phase 3, and the chat surface

Per-workstream inspectors, the fix loop, the `CPT·VALIDATOR`, and the Inspector's test write.

Each workstream is reviewed on its own branch, by its own inspector, briefed from THAT workstream's
slice and diff and never from the engineer's account. `Report` is structurally unreachable from a
reviewer's brief — there is no field on `InspectorBrief` or `ValidatorBrief` that could carry one —
and the reason is a real incident rather than a principle: `Report.branch` is model-controlled free
text, and a hostile Engineer wrote a fake "SUPPLEMENTARY BRIEF FROM THE GENERAL" into it that
reached the Inspector's `orders.md` and the codex argv.

The `VALIDATOR` runs last, once, on the integrated branch. It holds the spec's `verify` commands as
exact Bash rules — `buildSoldierSpec`'s ENGINEER-only refusal was widened to exactly two roles, with
the stated reason corrected, because "every other role holds no shell" stopped being true — and it
reads the acceptance gate's mechanical output as EVIDENCE rather than as an answer. Its refusal
re-enters the fix loop: a fresh engineer against the INTEGRATED branch, in the integration tree,
under the campaign's remaining budget.

**The Inspector's test write is GRANTED**, per spawn and never by the role table, and the four
preconditions and the honest measurement are in Part 1. The containment that holds is the supervisor
reading back what the reviewer actually wrote — for the VALIDATOR too — and discarding the verdict
if it strayed or if the tree could not be read at all. Three outcomes rather than two: `clean`,
`strayed`, `unread`, because "it wrote outside its scope" and "the tree could not be read" are
different facts owed different explanations.

The chat surface landed with it: the live tree in the status block from the same `TreeModel`
`army view` renders, a question inbox, `/stop` with confirmation, `/work <id>`, and the agent budget
on screen.

## Wave 5 — phase 1

The `CPT·SCOUT`, the durable spec artefact, and the mechanical alignment gate.

The scout is the first unit fielded below the Commander in a conversation, and the first fan-out
this project has bounded on purpose rather than by accident. Three ceilings, worth different
amounts and stated as such. DEPTH is the harness's and was already there: `fanOut: true` makes
`buildSoldierSpec` issue `subagentRosterFor('CAPTAIN', 'SCOUT')` and the claude adapter pins
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` to `maxSubagentDepth('CAPTAIN')`, which is 1 because
`SPAWNS_UNITS.SERGEANT` is `false`. COUNT is the supervisor's, because a roster names who may be
fielded and has no position for how many: `watchFanOut` counts distinct spawn identities off the
normalised event stream and the chat loop kills the process at the crossing. COST is arithmetic —
one recce is at most 1 + `SCOUT_MAX_SUBAGENTS` = 5 model sessions in one process inside
`SCOUT_TIMEOUT_MS` — plus a session ledger that refuses a further recce once cumulative spend
crosses `SCOUT_SESSION_BUDGET_USD`.

`ROLE_ALLOW.SCOUT` was NOT widened. It holds `Read`, `Grep`, `Glob`, `WebFetch` and `WebSearch`
and no spawn tool, which is correct rather than an oversight: the measurement recorded on
`SubagentDefinition` found that the allow half does not gate the spawn tool at all, so the forms
that bind are the roster, `subagentDeny`, and the nesting cap. **A scout holds no worktree**, and
every surface that describes it says so — a lease exists to isolate a writing worker's changes and
`ROLE_WRITES_FILES.SCOUT` is `false`.

One measurement worth keeping. The halt was written as `interrupt()` first, with a kill behind it,
on the reasoning that a scout's answer survives an interrupt and does not survive a kill. That code
was dead: `runSoldier` closes stdin immediately after the orders, so by the time any event reaches
the listener the claude adapter's `interrupt()` rejects with `is not running`, and every crossing
fell through to the kill anyway. The kill is what there is, and what it costs is stated where it
happens — a unit still fanning out has usually not answered yet, so the common outcome of a halt is
a recce with nothing to show.

The gate replaces one keystroke on a printed objective. Its second condition is the load-bearing
one and its two halves are kept apart everywhere: a command that EXECUTES and exits non-zero PASSES
with its reading banked, because a red test is where work starts; a command a shell cannot execute
(126/127), one that returns no exit code, and one still running at the deadline all FAIL, because
each has told the system nothing and `src/contracts/verify.ts` already says a timeout means nobody
found out. A proposal carrying NO SPEC does not enter the gate at all and the screen says so: the
free-text path stays what it was, and it is visibly the worse deal rather than the cheaper one,
because `dispatchFor` escalates a spec-less brief to the most expensive reasoning class there is.

The settled spec, the interrogation's rounds and the gate's readings go to the campaign archive
unconditionally. `planning.spec_to_repo` also writes them into the checkout and is OFF by default,
because a rejected branch should not strand design documents in the repo. One builder renders both
copies, so they are byte-identical by construction rather than by a test.

## One property, broken three times, now structural

A line typed for one reader must never be delivered to a different one. It broke through the
type-ahead queue, then through a composer relabel, then through the read itself, because the
addressee was attached to the READ and every call site had to remember to ask for protection. It is
now attached to the LINE: a line inherits the addressee of the prompt it was typed under, a read
consumes only lines addressed to it, and `addressee` is a required field, so omitting it is a
compile error rather than a missing guard.

---

# Part 3 — what is not built

Five things. Each is a design intent above that the code does not yet meet, and each is stated as
what a reader would find rather than as a plan.

**A campaign is still a blocking call, so the Commander is not available while one runs.**
`runDispatch` calls `runCampaign` and waits for one JSON envelope. What wave 4 added is a dispatch
*console*, which is not the same thing: a question, `/stop`, `/work`, `/next` and `/help` are
answered there and then, and **anything else — including a sentence for the Commander — is queued
and reaches it the moment the dispatch settles**. Part 1's "you can ask what is happening, and the
Commander answers from the archive" is not what happens. This is the largest remaining gap between
the design and the code, and it is the one the design called the reason to do the rest.

**A scout on the `army campaign` path.** That command takes an objective off a command line and has
no conversation in which to have asked for a recce, so `CampaignOptions.scoutFindings` is empty
there and the field says so rather than pretending otherwise.

**Reviewer independence on a one-provider machine.** The campaign continues and records the
downgrade, which is honest and is not the same thing as having it.

**`SENTRY` is declared and never spawned.** `army --help` states the gap out loud rather than
leaving it to be discovered, and `test/contracts.test.ts` enforces that it does.

**`SERGEANT` and `PRIVATE` are currently indistinguishable in capability.** The design draws the
line between them at exactly one entry — a SERGEANT leads a squad, a PRIVATE is one shot — and
`SPAWNS_UNITS.SERGEANT` is `false`, so only their briefings differ. That is deliberate and
temporary: this is the first time anything below CAPTAIN has ever been fielded, the recursion is the
one failure here whose cost is unbounded and whose bill arrives on somebody's subscription, and the
conservative direction on a first fielding is one level wide with every level of it visible in the
archive before a second is authorised. `maxSubagentDepth('CAPTAIN')` is therefore 1, not 2, and the
harness-enforced nesting cap is that same 1.

And one thing that is not a gap but is worth stating in the same place, because it changes what
every permission sentence above is worth: **the shipped posture is `unguarded`**, which is what
`army init` writes. Under it the scoped rules collapse to bare tool names. What survives is rank
narrowing, the commander context guard, the credential and archive denies, and the codex write
sandbox. No campaign has been fought under `guarded`.

Delivery is unchanged and still correct. Durability stays unconditional and uncapped, the rungs
stay prefixes, and the project ceiling clamps whatever the campaign asks for. The integrated branch
is what climbs the ladder.

---

# Part 4 — where the code disagrees with its own prose

Six sentences that a reader or a model is handed and that stopped being true — or were never true —
as the mechanism moved underneath them. None is a behaviour defect; all six are documentation
defects inside the code, which is the kind this project treats as a defect rather than as
untidiness — two of them are handed to a model as fact. Recorded, not fixed, because fixing them
is a code change and this is a document.

1. **`renderTestWriteSection`, permanent mode, tells an inspector "the supervisor commits the test
   paths onto this branch, they merge with it".** Since wave 4's fourth precondition it does not:
   the tests are lifted out of the workstream tree, the tree is put back as if they were temporary,
   and they are applied to the integration tree instead. Nothing is committed where it was written.

2. **`renderValidatorBrief` tells the validator the reviewer's tests "are committed on this
   branch".** They are not — `campaign.ts` says so explicitly at the call site four lines above
   where the brief is built: "They are NOT on the branch yet: whether they ever are is decided a few
   lines below, by whether this agent came back with a verdict at all."

3. **`--plain`'s help text says "No session chrome: no boxed header, and no status block pinned
   under the prompt".** `--plain` suppresses the pinned block only. `io.write(chatBanner(...))` is
   unconditional, so the boxed header still prints, which is arguably the right behaviour — a header
   is ordinary output and the README says so — but the flag's own description claims otherwise.

4. **`ROLES` in `src/contracts/ranks.ts` still says of `OVERSEER` and `VALIDATOR`: "Neither is
   spawned by anything in this build."** Both are spawned by `src/command/campaign.ts` — the
   overseer for segmentation, questions and adjudication, the validator on the integrated branch.
   The sentence was true when the vocabulary landed in wave 1 and stopped being true in wave 3.

Two smaller ones:

`WORK_FILE_MAX_BYTES`'s comment claims "Over the cap the field says so rather than lying about a
file it did not read." The reader returns `null` for an oversized file, and a `null` diff renders
as "none recorded — the attempt has not been read back yet", which is the lie the comment says it
avoids.

`postureNotice` says it is "exported so the campaign note, the chat banner and the test that pins
the wording all say the same thing". Only the campaign note calls it. The chat banner does not
mention the posture at all, and nothing pins the wording — so on the one surface a person spends an
hour looking at, the posture the run is operating under is not stated.
