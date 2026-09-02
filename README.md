# agentic-army

A war-hierarchy multi-agent orchestrator. You are the **Commander**; everything below you is
an agent with a rank (its authority), a role (its branch of service), and a bounded blast
radius. Officers hold strategy and are structurally incapable of editing a file; exactly one
rank writes, and it is the one rank that leases a worktree, so the work happens there rather
than in your checkout; and every change is reviewed by an Inspector that was briefed by the
*parent*, from the original orders, never by the agent under review. Between those two sits an
optional feature owner — a `MAJ·OVERSEER` that cuts one feature into concurrent workstreams and
answers the questions climbing to it from below — and after them a `CPT·VALIDATOR` that judges
the integrated branch against what was originally asked for. The design goal is that nothing
enters a commanding agent's context except a hard-schema report — guarded by mechanism rather
than by discipline.

> **Status: the loop runs; the package is not published.** `army doctor`, `army init`,
> `army enlist`, `army chat`, `army campaign`, `army view` and `army rebuild` are all
> implemented, and every transcript below is real output from running them — bytes off a real
> terminal or a real stdout, never composed by hand. Some of those runs put stand-in `claude` and
> `codex` executables on `PATH` instead of the live vendor CLIs; where that is true the paragraph
> above the transcript says so, because what a screen looks like and what a model would have said
> are two different claims. What is missing is distribution:
> `agentic-army` is not on the npm registry, so `npx agentic-army …` and `npm install -g
> agentic-army` both 404 today — run it from a checkout, see [Getting it](#getting-it).
>
> Nothing in this README describes a feature that does not work. Where something is implemented
> but has not been exercised end to end, it is named in
> [What has actually been run](#what-has-actually-been-run) rather than quietly implied. This is a
> description of what runs today, not of where the project is going.

## Requirements

- **Node.js >= 20.** Hard floor, enforced by `engines` and re-checked by `army doctor`.
- **git >= 2.20** — worktree support.
- **Claude Code >= 2.1.219** — below that, `--forward-subagent-text` does not forward at nested
  depth and the lower half of your org chart silently vanishes from the stream.
- An **OAuth Claude subscription**, not an API key. See the warning below.

Optional, each buying you one specific capability: `codex`, `gh`.

That is the whole list. Nothing else has to be fetched — worktree pooling, lifecycle hooks and
warm reuse are built in, not a separate binary to go and find.

## Getting it

Not from npm, yet. Both lines you would expect currently fail, with the same error:

```sh
npx agentic-army doctor      # npm error 404 Not Found - GET https://registry.npmjs.org/agentic-army
npm install -g agentic-army  # the same 404
```

Until it publishes, run it from a checkout. There is no build step for that — Node 24 strips
types natively, so the source runs directly:

```sh
git clone <this repository> agentic-army && cd agentic-army
npm install                  # smol-toml, plus the TypeScript the tests and `npm run build` use
node src/cli.ts doctor       # changes nothing on your machine, so it is a safe first look
```

## First run

One step:

```sh
cd ~/code/some-repo
army chat        # or just `army` — no command, on a terminal, opens a chat
```

Chat does its own setup on the way in. It creates `~/.agentic-army/` and writes `config.toml`
where they are missing, turns a bare directory into a git repository, and registers the project
at delivery ceiling 0, the fail-closed default an unregistered project already has. Nothing it
creates widens authority; raising a ceiling still takes `army enlist --ceiling N` from a
terminal.

Every piece is also its own command, in whichever spelling you are on. **You never have to keep
track of which one that is**: every command this tool prints for you to type is emitted in the
form you actually invoked it with. A checkout's `node src/cli.ts doctor` ends with
``Next: `node src/cli.ts init` ``; the installed `army doctor` ends with ``Next: `army init` ``.
Same for every fix line, every usage line and every error.

| | installed | from a checkout | via `npx`, once it publishes |
|---|---|---|---|
| what is missing, and the exact command to fix each thing | `army doctor` | `node src/cli.ts doctor` | `npx agentic-army doctor` |
| create `~/.agentic-army/` and write `config.toml` | `army init` | `node src/cli.ts init` | `npx agentic-army init` |
| register this repo, delivery ceiling 0, commit only | `army enlist` | `node src/cli.ts enlist` | `npx agentic-army enlist` |
| run one objective end to end | `army campaign "…"` | `node src/cli.ts campaign "…"` | `npx agentic-army campaign "…"` |

`chat`, `enlist` and `campaign` read the current directory, so `cd` into the repository you want
worked on first. From here on this README writes `army …`; substitute your column.

There is a fourth form and it is handled too: `npm run dev -- doctor` ends with
``Next: `npm run dev -- init` ``, `--` included, because without it npm eats the flags.

## `army doctor`

Every failure mode in this system is environmental, so `doctor` is the first thing to run when
anything looks wrong — not just at install time. It never writes anything, runs all its checks
concurrently, and exits **0** unless something is blocking, so it works as a CI gate. Add
`--json` for machine-readable output.

Each check returns exactly one of three outcomes:

| | Outcome | Meaning |
|---|---|---|
| ✓ | **ok** | Nothing to do. |
| ⚠ | **degraded** | It works, but you lose a *named* capability. The check tells you which one. |
| ✗ | **blocking** | It cannot run. The check gives you the exact command to fix it. |

A degraded result never fails the exit code. What each degradation actually costs you:

- **no `codex`** — you lose cross-vendor review independence. Inspectors fall back to the same
  vendor that wrote the code, so the reviewer shares the builder's blind spots. You also lose a
  second, independent quota pool.
- **no `gh`, or not logged in** — delivery is capped at rung 1 (push). Pull requests and merges
  both go through `gh`.
- **`ANTHROPIC_API_KEY` is set** — read the next section. This is the one people miss.

### The `ANTHROPIC_API_KEY` warning

If that variable is set, `doctor` flags it loudly, and the reason is worth stating plainly:
workers are spawned as subprocesses and inherit your environment, and Claude Code prefers an API
key over the OAuth credential store. So every soldier you field gets billed to the key at API
rates instead of drawing on the subscription you are already paying for. Nothing fails. Nothing
warns. You find out on the invoice. Unset it.

## `army init`

Runs `doctor` first and refuses to proceed if anything is blocking. Then creates
`~/.agentic-army/` with `campaigns/` and `mirrors/`, and writes `config.toml` — heavily
commented, because those comments are the entire reason the file is TOML and not JSON.

It is idempotent. An existing `config.toml` is never overwritten, so re-running it on a working
machine does nothing.

## `army enlist` and the delivery ceiling

**Push is durability; PR and merge are delivery.** Work always leaves its ephemeral worktree for
a real git ref before the lease is returned — your origin if the project has one, otherwise a
bare mirror in the archive — so no run is ever lost regardless of the setting below. What the
ceiling caps is *delivery*:

| Rung | Meaning |
|---|---|
| 0 | commit — durable in the army mirror, your repo untouched. **Default.** |
| 1 | push — branch on origin, no PR |
| 2 | pull request — opened, Inspector verdict posted as a review |
| 3 | merge — after an Inspector PASS, by the supervisor, if the host allows it |

**Everything about rung 3 is fail-closed.** The merge is performed by the supervisor process you
launched — never by a worker, which is denied `gh pr merge` at every rank — and only when all of
these hold at once: the project ceiling is 3, the Inspector returned PASS, that verdict reached
the pull request as a review, the Engineer finished, and the retry budget was not exhausted.
Anything else delivers rung 2 and names the condition that failed. The merge is pinned to the
exact commit the Inspector read, so a commit pushed to the branch after the verdict cannot ride
in on it. Nothing overrides the remote: no admin override, no auto-merge, no force. If branch
protection, a required check, a required review or a conflict makes the host refuse, the refusal
is reported as the host worded it and the campaign stops there. Re-running is safe — an existing
pull request is adopted rather than opened a second time, and one that is already merged is a
no-op rather than an error.

The two facts rung 3 needs — whether the Engineer finished, and whether the retry budget ran out
— are read off the campaign's own state by `mergeEvidence` and handed to `runLadder`, which
refuses outright for a caller that supplies neither rather than shipping rung 2 under a rung-3
heading. Neither field is a literal: if this call site answered `done` and `false`
unconditionally, both of the ladder's refusals would be unreachable from it, and a dead gate is
worse than an absent one because everybody stops thinking about it.
`src/delivery/ladder.ts` is where the gate lives. What a refused rung 3 says is the rung it could
actually reach and why — asked for on a ceiling-3 project with no `origin`, it comes back *"rung 3
refused, delivered rung 2: there is no pull request to merge — rung 2 was not reached, so rung 3
cannot be. The rungs are prefixes: a merge is the last step of a pull request, not an alternative
to one."*

```sh
army enlist                 # ceiling 0
army enlist --ceiling 2     # from a terminal: allow PRs on this repo
army enlist --no-init       # refuse rather than create a repository
```

If the current directory is not a git repository yet, `enlist` creates one — `git init` plus a
single empty commit, because a campaign cannot lease a worktree of a repository with no HEAD, so
initialising without committing would only move the refusal one command later. It will not do this
in your home directory or at a filesystem root; both are a wrong `cd` rather than a new project,
and it says so instead. Nothing already in the directory is added to that commit.

"Your repo untouched" at rung 0 means *nothing is pushed anywhere and no branch you use is
moved* — that is what the mirror is for. It does not mean the repository is bit-for-bit
unchanged: an Engineer works in a linked worktree of it, so after a ceiling-0 campaign your
repository has gained the commit objects, a local `army/<task-id>` branch and a
`refs/army/durable/…` ref. `main` is where you left it and `git status` is clean.

Two properties are worth understanding before you rely on them:

**The ceiling is stored in your global config, never in the repo.** If it lived in the
repository it governed, then cloning somebody's repository would be enough for that repository
to grant itself merge rights on your machine — it would ship a file saying `ceiling = 3` and a
tool that read it would obey. So the repo gets no say. Only `~/.agentic-army/config.toml` does,
keyed by absolute path.

**Raising a ceiling takes a terminal or a hand edit; and the ceiling is a guardrail, not a
security boundary.** `--ceiling N` raises one only when stdin is a real TTY; anything running
non-interactively is refused and shown the line to edit. Lowering is always allowed and needs no
terminal, because reducing blast radius is never the dangerous direction.

Be clear about what that buys you. The TTY check stops the naive path and stops accidents, but
`process.stdin.isTTY` answers "is fd 0 a character device", not "is a human present" — `script`,
`expect` and `python3 -c 'import pty'` each allocate a terminal, and each is one command away
from anything that can run commands. **The boundary that actually holds is the permission layer:
every worker must be denied write access to `~/.agentic-army/**` by every route — the CLI,
`$EDITOR`, shell redirection, `sed -i`, all of it.** A worker that can write there can raise its
own ceiling by editing the config, which is the documented way to raise one, and then nothing in
this section constrains it. The package exports `PROTECTED_CONFIG_GLOBS` so the orchestrator
enforces that list rather than re-deriving it. Treat the ceiling as protection against accident
and prompt-driven drift, not against a hostile process that already has your shell.

Entries are keyed by the **main** repository root, so running `enlist` inside a linked worktree
updates that project rather than registering the worktree as a separate one with its own
ceiling. Since every Engineer works in a worktree, that is the common path.

## The ladder, and what each rung may hold

Rank is authority. Role is branch of service. They are orthogonal — any role can hold any rank —
and a spawner may only assign a rank strictly junior to its own. The order is real US Army
seniority, so a tree that reads top to bottom also reads senior to junior.

| Rank | Substrate | Writes files | Who holds it |
|---|---|---|---|
| ☆ GENERAL | process | no | the supervising process that owns a campaign |
| ◆ COLONEL | process | no | the Commander you talk to in `army chat` |
| ◈ MAJOR | process | no | the feature owner, one per feature: `MAJ·OVERSEER` |
| ◇ CAPTAIN | process | **yes** | engineers, inspectors, the validator, scouts |
| ▪ SERGEANT | subagent | no | sub-agents a scout or an engineer fields |
| · PRIVATE | subagent | no | the floor: spare depth below a Sergeant, spawns nothing |

**Exactly one cell in that column is `true`**, and it is the rank that leases a worktree. That is
not tidiness, it is the two properties this project is built on in one table: officers are
structurally incapable of a bad `rm`, and a diff always has one owner. A `SGT·ENGINEER` therefore
holds Read, Grep, Glob and TodoWrite and no editor, exactly as a `COL·ENGINEER` does — rank
narrows what a role asks for and never widens it.

MAJOR is the newest entry and was briefly a writing rank, because an overseer that merges needs
git and `Bash` counts as write-capable. The loadout was the thing that was wrong: the overseer
*decides* which workstream merges, and the supervising process performs the merge, so there was
nothing for the table to subtract and MAJOR went back with the officers.

The roles, and the loadout each one is actually built with — this is `permissionsFor` output, not
a description of it:

| Role | Loadout |
|---|---|
| COMMANDER | `TodoWrite`, and nothing else, at any rank |
| SCOUT | Read, Grep, Glob, WebFetch, WebSearch. No worktree |
| OVERSEER | Read, Grep, Glob, TodoWrite. No editor, no shell, no network |
| ENGINEER | Read, Grep, Glob, Edit, Write, NotebookEdit, TodoWrite, Task, Agent, and 28 `Bash` prefixes |
| INSPECTOR | Read, Grep, Glob, TodoWrite, and 24 `Bash` prefixes — plus, on some spawns, a scoped test write. See below |
| VALIDATOR | the Inspector's, plus the spec's own `verify` commands as exact-match rules |
| SENTRY | `Bash(gh pr view:*)`, `Bash(gh run list:*)`. **Declared and never spawned** — `army --help` says so out loud rather than leaving the gap for you to find |

The Inspector's 24 prefixes are the Engineer's 28 minus `git`, `prettier`, `eslint` and `ruff`.
The last three are gone rather than narrowed, and the reason generalises: a `Bash(prefix:*)` rule
constrains the *start* of a command line and nothing after it, so `Bash(prettier --check:*)` would
still permit a trailing `--write`. Every one of those three has a documented in-place write mode.

**One thing here is worth reading before you trust any of it.** `[permissions] mode` in
`config.toml` ships as `unguarded`, which is what `army init` writes, and under it the scoped
rules above collapse to bare tool names: an Engineer holds `Bash` rather than 28 prefixes of one.
Every campaign prints the consequence in its own result rather than leaving it in a config file:
*"workers hold their tools unscoped, so an Engineer runs any command rather than a listed one, and
the codex reviewer may open a socket to run your tests. Still enforced: rank narrowing, the
commander context guard, the credential and archive denies, and the codex write sandbox."* It is a
`warn` under `unguarded` and an `info` under `guarded`, so the posture is on screen either way.

What survives the posture is what the rest of this README leans on: rank narrowing, the
commander's one inert tool, the credential and `~/.agentic-army/**` denies, and the codex sandbox.
What does not survive it is the command scoping. Both halves are stated because a reader who
takes "an Engineer may run these 28 commands" as a boundary, on the configuration this ships,
would be wrong.

## `army campaign`

One objective, end to end. A CPT·ENGINEER (claude) takes a leased worktree, cuts
`army/<task-id>` and commits. Then the **GENERAL** — not the Engineer — spawns a CPT·INSPECTOR
(codex), briefed from the *original orders and the branch*, never from the Engineer's account of
what it did. On PASS the work is made durable and the delivery ladder runs, clamped by the
project ceiling. On FAIL a fresh Engineer retries in the same worktree with the findings.

**One tree per workstream, and its Inspector shares it.** A campaign with one workstream leases
exactly one worktree and runs the Engineer and then the Inspector in it, so the Inspector reads
and tests the branch in place. Its independence is *not* a fact about the tree, and it is worth
being exact about where it does come from: the **brief** (the original orders plus the branch,
assembled by the GENERAL — the Engineer's `report.md` is never handed to it, and there is no field
on `InspectorBrief` that could carry one) and the **loadout** (Read, Grep, Glob, TodoWrite and the
24 `Bash` prefixes above). A second, disposable tree per Inspector is a reasonable thing to want —
it would stop a mutation-test edit from being visible to a retrying Engineer — but it is not what
runs.

```sh
army campaign "add a multiply function to calc.js"
```

Against a throwaway repo at ceiling 0, asked for `--rung 3`, the result block was (paths
shortened, and the notes that follow it left out):

```
campaign 2026-09-01-add-a-multiply-function-to-calc-js  —  delivered
  project   …/repo
  task      t-77bf06a47e23
  branch    army/t-77bf06a47e23
  ceiling   0 (commit)   requested 3 (merge)
  delivered rung 0 (commit)
  durable   mirror …/mirrors/repo-dab84036.git
  acceptance not run — no `verify` commands were checked mechanically; nothing above confirms it
  worktree  released — work is durable; the tree was returned to the pool

  attempt 1  ◇ cpt-01 (ok)  →  cpt-02 PASS (tests run: node --test)
             changed calc.js
             the branch does what it was cut to do
```

That run had stand-in vendor CLIs on `PATH`, so the two model summaries are theirs and not a real
model's; everything else on the screen is the supervisor's own. Four things there are the design,
not decoration. **The verdict carries whether tests were actually run** — a reviewer that only
read prints `PASS (NO TESTS RUN — verdict is from reading only)` instead of letting "PASS" imply
a green suite that never existed. **The acceptance row is printed even when there was nothing to
run**, because a gate that did not run has not passed anything and must never look like one that
did. **The ceiling clamped the request** rather than honouring `--rung 3`, and said so in a note
underneath. And **durability happened before the lease was returned**, so the commit survived the
worktree being reset and handed to the next campaign; it is readable out of the mirror afterwards
with plain `git`.

### One overseer, several workstreams, one integration

`--overseer` puts a `MAJ·OVERSEER` above the campaign. It reads the repository, cuts the feature
into workstreams with declared file ownership, answers the questions its engineers raise so they
never reach you, and decides which accepted workstream merges and when. It holds Read, Grep, Glob
and TodoWrite: no editor, no shell, no git. **This process performs every merge it decides on**,
exactly as it performs the rung 3 merge no worker may perform at any rank.

```sh
army campaign "add multiply and divide to calc.js" --overseer --workstreams 2
```

`--workstreams` is how many run at once — default 3, clamped to 8, and it multiplies what a
campaign costs while only dividing its wall clock, because each one is another model session,
another worktree and another branch to merge. Off by default for the same reason: an overseer is a
whole session spent before any engineer starts, and a two-line objective does not need a feature
owner. **A campaign that segments into one workstream runs exactly as it did before either flag
existed** — that is the same code at N = 1 rather than a compatibility path, and it has a test on
it.

With several workstreams, the two gates *move* rather than multiply. The spec's `verify` commands
and the objective both describe the whole feature, so running either against one partial branch
would fail every workstream by construction; both run once, on the integrated branch. What does
multiply is the review: each workstream is inspected on its own branch, by its own Inspector,
briefed from that workstream's slice and diff.

**Segmentation is a declaration, not a fence.** Two workstreams claiming the same file up front is
a planning error and the overseer is asked to segment again — once, and then the campaign gives up
on segmenting and runs whole. But an engineer that needs a neighbour's file takes it and the
overlap is *announced*, because a fence around the files an engineer may touch turns a solvable
merge into a blocked workstream. Overlap is read twice: live off the tool-use stream while the
engineer runs, and completely off `git diff --name-only` once it is down. **It cannot see a
shell** — a command line is not a file list, and guessing one from `>` or `tee` would give you a
detector that is wrong in both directions — which matters more than it sounds, because under the
shipped `unguarded` posture an engineer holds a bare `Bash`.

A merge git resolves needs nobody. A conflict becomes a **reconciliation workstream**: the
supervisor writes the orders, because every field in them is a branch this process cut or a file
git reported, and a fresh engineer resolves it in its own worktree where an inspector reviews the
resolution like any other work. Here is one, end to end, with stand-in vendor CLIs on `PATH`. Two
engineers were told to own different files and both wrote `calc.js`. Absolute paths are elided
with `…` and one line carrying nothing but a path is dropped; every line that is here is here as
it was emitted, so the long notes run as long as they run — a terminal soft-wraps them, this page
does not:

```
☆ campaign 2026-09-01-add-multiply-and-divide-to-calc-js · add multiply and divide to calc.js
  ◈ MAJ·OVERSEER · maj-01 dispatched (claude, attempt 1)
  ◈ MAJ·OVERSEER · maj-01 returned ok
  · worktree leased (cold) → …/trees/repo-e33e3b53/wt-01
  ◇ CPT·ENGINEER · cpt-02 dispatched (claude, attempt 1)
  · worktree leased (cold) → …/trees/repo-e33e3b53/wt-02
  ◇ CPT·ENGINEER · cpt-01 dispatched (claude, attempt 1)
  ⚠ divide wrote calc.js, which is outside its own declaration (multiply declared it). Seen in the branch diff. This is announced, not refused.
  ◇ CPT·ENGINEER · cpt-02 returned ok – changed calc.js
  ◇ CPT·INSPECTOR · cpt-03 dispatched (codex, attempt 1)
  ◇ CPT·ENGINEER · cpt-01 returned ok – changed calc.js
  ◇ CPT·INSPECTOR · cpt-04 dispatched (codex, attempt 1)
  ◇ CPT·INSPECTOR · cpt-04 → PASS – the branch does what it was cut to do
  ◇ CPT·INSPECTOR · cpt-03 → PASS – the branch does what it was cut to do
  · worktree released → …/trees/repo-e33e3b53/wt-02 – work is durable; the tree was returned to the pool
  · worktree released → …/trees/repo-e33e3b53/wt-01 – work is durable; the tree was returned to the pool
  · integration tree at …/trees/repo-e33e3b53/wt-01 on army/t-8616dc59c8e3
  ⚠ divide (army/t-8616dc59c8e3-divide) conflicts with army/t-8616dc59c8e3 in calc.js. A fresh engineer reconciles it; nothing here resolves a conflict by hand.
  · worktree leased (cold) → …/trees/repo-e33e3b53/wt-02
  ◇ CPT·ENGINEER · cpt-05 dispatched (claude, attempt 1)
  ◇ CPT·ENGINEER · cpt-05 returned ok – reconciled both sides in calc.js
  ◇ CPT·INSPECTOR · cpt-06 dispatched (codex, attempt 1)
  ◇ CPT·INSPECTOR · cpt-06 → PASS – the branch does what it was cut to do
  · worktree released → …/trees/repo-e33e3b53/wt-02 – work is durable; the tree was returned to the pool
  ◇ CPT·VALIDATOR · cpt-07 dispatched (codex, attempt 1)
  ◇ CPT·VALIDATOR · cpt-07 → PASS – the branch does what it was cut to do
  · delivered rung 0 (commit) → …/mirrors/repo-e33e3b53.git
```

and its result block, which is where the shape of the run is legible:

```
campaign 2026-09-01-add-multiply-and-divide-to-calc-js  —  delivered
  ceiling   0 (commit)   requested 0 (commit)
  delivered rung 0 (commit)
  workstreams 3, at most 2 at once
    multiply  accepted  army/t-8616dc59c8e3-multiply
    divide  accepted  army/t-8616dc59c8e3-divide, 1 overlap(s) announced
    divide-merge  accepted  army/t-8616dc59c8e3-divide-merge
  integration army/t-8616dc59c8e3 — 2 merged, 1 conflict(s), tree released
```

Two workstreams were planned and three ran: `divide-merge` is the reconciliation, named after the
workstream whose merge failed. The merge itself reports a conflict and never resolves one — it
reads the conflicted paths out of the index, then aborts back to exactly where it started and
proves the restoration against the dirty set it captured *before* the attempt, because integrating
the next workstream onto a half-merged branch is the failure that has no good recovery. **Nothing
partial is delivered**: if any accepted workstream never reaches the integration branch, the
campaign says so and delivers nothing, and every branch is still made durable.

Last, once every workstream has merged, one `CPT·VALIDATOR` runs on the integrated branch. It asks
a different question from an Inspector's: not "does this diff do what it was cut to do" but "is
this the thing that was asked for". It holds the spec's `verify` commands as exact-match rules so
it can run them, and it reads the acceptance gate's mechanical output as *evidence* rather than as
an answer — the gate says whether the commands pass, the validator says whether that amounts to
the feature. A validator that refuses sends the integrated branch back to one more engineer,
working in the integration tree on the integrated branch, under a validation budget that is
separate from each workstream's retry budget rather than shared with it. One pool across N
concurrent workstreams turns a budget into a race.

The validator is **skipped** whenever the campaign did not segment, any workstream ended other
than delivered, integration failed, the acceptance gate never passed inside the budget, or an
abort landed in between. That list is why the next section matters.

### The Inspector may now write tests, and it is not the permission model that stops it lying

The design wants the reviewer to write the test that exercises its own finding. So on a segmented
campaign an Inspector is granted the editing tools, scoped to test paths — 27 rules over
`test/**`, `tests/**`, `spec/**`, `__tests__/**`, `**/*.test.*` and four more — with every
non-test file already on the branch named on its deny half. The grant is **per spawn, by the
supervisor, never by the role table**: `ROLE_WRITES_FILES.INSPECTOR` is still `false`, and
`permissionsFor` refuses a loadout that disagrees with it.

An inspector that can write can make its own verdict pass. The first attempt at containing that
was measured and found inert, and the measurement is the interesting part. The Inspector runs on
codex, and the codex adapter reads `spec.deny` to build sandbox roots and **never reads
`spec.allow` at all** — so a scoped allow-list on that role is not weakened there, it is absent.
The shipped posture is `unguarded`, which drops argv scoping. And a bare `Bash` writes the tree
with `sed -i` whatever an editor is scoped to. On the configuration this project ships, neither
half of the permission rule bites.

**What holds is supervisor-side and harness-independent.** The tree is read before the reviewer
spawns and again after it exits, with `git status --porcelain -z --untracked-files=all`; the
difference is what that reviewer wrote. Three outcomes, not two: `clean`, `strayed`, and `unread`
— because "it wrote outside its scope" and "the tree could not be read" are different facts owed
different explanations, and an unreadable tree is not a clean tree. Either of the last two
**discards the verdict** and puts the files back. A reviewer can still write. It cannot write and
be believed.

And the durable artefact follows the fact rather than preceding it. Nothing a reviewer writes is
committed where it was written: the content is lifted out of the workstream tree, the tree is put
back as if the tests were temporary, and the files are applied to the integration tree for the
gate and the validator to execute. They become history only after a validator has actually
produced a verdict on a tree containing them, and if none ever does they are withdrawn and nothing
on any branch ever claimed otherwise. That is the fourth precondition, and its first spelling was
a boolean handed in at spawn time — a claim about a future, at a call site, which is exactly the
shape this codebase's permission model exists to avoid. It could not be false, because nothing
computed it; and it was routinely wrong, because of that skip list above. Two workstreams and one
refusal was enough: zero validators ran, both inspectors held all 27 rules, and a reviewer's test
sat committed on a durable branch under a note saying a validator would run it.

The `CPT·VALIDATOR` itself may write **nothing at all**, test paths included. It is the last agent
of the campaign, so a test it wrote would be executed only by the run whose verdict it supports.

## The spec, and why the workers are cheap

Engineers dispatch at **`low`** reasoning effort. That is not a cost saving, and it is only safe
because of what sits above it — see [What a trial measured](#what-a-trial-measured) for the run
that decided it. Under a complete brief every effort level solved the same task, `low` included,
in 1m12s for 29 cents. Under a one-line brief six of eight attempts failed, and six of those
failures were one missing sentence that nobody derived.

So the cheap default is **coupled to the brief, not chosen despite it**:

- A dispatch carrying a validated `TechnicalSpec` runs the Engineer at the configured effort.
- A dispatch carrying only a free-text objective escalates it to `xhigh` — `UNSPECIFIED_BRIEF_EFFORT`
  in `src/command/campaign.ts`. Failing toward *more* reasoning when the brief is thin is the safe
  direction, and it is what the trial's one reliable thin-brief success actually needed.

A spec has seven fields and six of them are required: objective, files in scope, acceptance,
behaviours and edge cases, decisions already made, and constraints. The seventh is `verify`, the
executable half of `acceptance`, and it is optional because not every task has a runnable check
and forcing one would produce `true` and a gate that is theatre — see the next section for what it
buys and what its absence costs. Validation is **structural only** — present, single line, within
caps. It never judges content, because you approve the spec before anything spawns and a validator
that filled a gap in would have answered one of the six questions itself.

```sh
army campaign --spec ./spec.json          # a spec you wrote
army campaign "fix the flaky test"        # no spec: still works, escalated to xhigh
```

## Two gates, because a reviewer is not a review

A campaign delivered work that passed review and was wrong, in two different ways. Both fixes
exist because of that run, and both are aimed at a failure the Inspector could not have caught by
trying harder.

**The acceptance gate.** A spec's `acceptance` entries are prose — they get read, not executed.
So a criterion reading `node app.js sample.json prints a table` sat in a brief while the Engineer
created `app.json`, and the criterion, run verbatim afterwards, exits 1. `verify` is the
executable half: shell commands that must exit 0, run in the worktree **before the Inspector is
fielded**. A branch that fails its own acceptance commands is not ready for a human-grade review,
and the Inspector runs on a metered account whose quota is the scarcest thing here — so failing
early costs nothing and hands the retry Engineer an exact command and its output.

`verify` is optional, and its absence is *reported*, never assumed. A gate that did not run comes
back `passed: false`, because a gate that did not run has not passed anything.

**And the gate itself is checked, against the tree before anybody worked on it.** A verify command
defines done, so a command that can never pass defines a done nobody can reach — and the campaign
will spend every attempt it has discovering that. It happened: a spec carried

```sh
sh -c 'grep -q \"\\\"dependencies\\\": {}\" package.json'
```

which has balanced quotes, contains no denied word, passes every static check, and exits 2 against
every file that has ever existed. Three Engineers ran for 37.6 minutes and $8.86 — **two of them
succeeded, with tests passing** — and nothing was delivered, because nothing in the system could
tell an unpassable command from a failing branch.

So every `verify` command is now run once against an untouched tree before the first Engineer is
dispatched, and what it said is kept. Two things come of that. The failing ones are printed
immediately — in `army chat` they are printed *before* the approval prompt, and a command a shell
cannot execute means no prompt is offered at all, which is
[the alignment gate](#before-anything-is-built-a-scout-and-a-gate-that-is-not-a-keystroke). And
when the gate runs for real, a command that says *nothing the baseline had not already said* is
flagged: *"`false` failed identically with and without the work — it exited 1 against the untouched
tree too, so on this attempt it did not distinguish the work from its absence."*

One such reading is a warning, not a verdict — an Engineer that committed something useless
produces the identical reading, and it deserves its retry. Two in a row is where the explanations
separate: a second Engineer failing to move the same command the same way is the command's fault,
and the campaign stops rather than buying a third. The comparison is deliberately reluctant —
containment rather than equality, because the baseline legitimately says *more* than a later run
(the files are not there yet), and any genuine failure introduces a line the baseline never had. It
would rather miss a broken command than tell you your spec is at fault when your branch is.

None of this relaxes the gate. `passed` is still `false`, nothing is delivered, and the branch stays
durable. What changes is who is told to fix it, and how much is spent finding out.

**Per-behaviour verdicts.** The second defect was subtler. A spec listed six behaviours; clause 2
was never implemented. The Engineer wrote the tests as well as the code, so its suite was blind in
exactly the place its code was — and the Inspector's mutation check disturbed the ordering the
tests *do* cover, reading as confirmation on the one clause that was broken. The verdict came back
`findings: []`, `pass`. Nothing recorded that clause 2 had never been considered.

A verdict now carries one determination per numbered behaviour: `met`, `not-met`, or
`not-verified`. Incomplete coverage fails the attempt even on a `pass` — an Inspector that skipped
clauses has not reviewed the work. `not-verified` does **not** fail: it is the honest answer, and
making it a failure would only teach the model to claim `met`. Unverified clauses are surfaced on
the result and in the verdict file instead.

Measured on the first live run to use it: codex returned all five determinations, each noting that
the behaviour was *exercised directly* rather than inferred from the suite — and its own first
attempt at a verdict was `fail` with every clause `not-verified`, because it had not yet run
anything. The escape hatch got used honestly before it was ever needed dishonestly.

**The awareness runs the whole way down.** The commander is told its Engineer is cheap and
literal. The Engineer is told the same about the Sergeants it fields, and that it owes each of
them the same six answers it was owed. The Sergeant is told that if its orders are ambiguous the
correct move is to **report the gap upward, not resolve it** — a guess that looks like an answer
is the expensive failure; a named gap costs one turn.

One thing that briefing is careful *not* to say is that a subagent runs at low effort. It has no
effort of its own: `--agents` carries a description, a prompt and a tool list, so a native
subagent runs inside its parent at its parent's effort — which is `xhigh` whenever that parent
was escalated for arriving without a spec. A test asserts the wording stays inherited rather than
flat, because the sentence reads fine either way.

## `army chat`

A campaign is one objective, decided up front. `chat` is the other shape: a live session with a
**COL·COMMANDER** that can raise work mid-conversation.

It will not propose a dispatch until it can fill all six required spec fields. It interrogates one
question at a time, carries its own recommended answer on each so you can agree with a word, and
when you genuinely do not know something it records the decision it took on your behalf under
*Decisions already made* and says so. The failure being replaced is the assumption nobody wrote
down.

```sh
army chat
army chat --rung 2          # highest rung any dispatch may attempt, still clamped by the ceiling
army chat --attempts 5      # Engineer attempts per dispatch, including the first. Default 3
army chat --overseer        # put a MAJ·OVERSEER over each dispatch, as `campaign --overseer` does
army chat --concurrency 4   # workstreams at once, with an overseer. Shown on the status block
army chat --plain           # no pinned status block, for a terminal that lies about being one
```

**The commander's entire loadout is `TodoWrite`.** Read, Grep, Glob, Edit, Write, Bash and
network are all denied to it by the same permission layer that governs every worker. One inert
tool rather than an empty list, deliberately: an empty allow-list makes the harness omit
`--allowedTools` altogether, and the worker then inherits every tool there is — so "no tools" is
the most permissive thing this program can start, not the least.
When it says it has not read a file, that is not modesty and not an instruction it was given that
it might ignore. Asked directly to read one, it answers that the function is not there to call.
This is the point of the rank: the window holding your objective cannot be spent one source file
at a time, because spending it that way is not an available action. What it does instead is ask
for a scout — see below.

**Nothing is dispatched without a keystroke, and the keystroke is no longer the whole gate.** The
commander proposes; a mechanical gate runs; you approve last. Everything it raises then goes
through the gate `army campaign` uses — the same code, so the same independent Inspector briefed
from the objective and the branch, the same durability, the same ceiling clamp. `--rung` sets a
maximum for the session and is itself clamped; it can lower, never raise.

**Ctrl-C means one thing at a time, and never "kill sixteen agents".** The interrupt is a control
message on stdin rather than a signal, so an answer in flight aborts in milliseconds and the same
session takes your next line. Where the session is decides what it stops, and each press does
exactly one of these: with a worker's question open it leaves the question unanswered and hands
the session back, and the dispatch keeps running and keeps its worktree; during the alignment gate
it stops the gate, and every command it did not reach is recorded as unrun rather than as passed;
during a dispatch it waits, because only the campaign's own cleanup can settle a lease and
abandoning one mid-flight is how a worktree leaks. **Ending a running campaign is `/stop`**, which
confirms first. None of those presses arms the exit — one gesture, one meaning — so the press
after any of them lands wherever the session is by then. A second Ctrl-C at an idle prompt, or
Ctrl-D, exits.

### Before anything is built: a scout, and a gate that is not a keystroke

A commander that holds no reader cannot answer "how does this repository do X today", and the
honest move is not to guess. So it may ask for a **`CPT·SCOUT`**: a reader that holds Read, Grep,
Glob and the web, writes nothing, and **holds no worktree**, because a lease exists to isolate a
writing worker's changes and a scout makes none. It gets its own `[y/N]`, separate from the
dispatch prompt, because a reader and a writer are different decisions and should not share a key.

```
  ◇ proposed recce
     how does calc.js export its functions today?
     a CPT·SCOUT reads the repository and the web. It writes nothing, holds no
     worktree, may field at most 4 subordinates and none of them may field any,
     and has 10 minutes.
  ◇ send a scout? [y/N] y
  ◇ scouting — one CPT·SCOUT, reading only.

  ◇ cpt-01 reported — the words below are the SCOUT'S, not this process's, and 2
    subordinate(s) contributed to them.
     calc.js has a single named export, add, defined as an arrow function
     · calc.js:1 `export const add = (a, b) => a + b;` — one named export, no
       default
     · there is no test directory and no package.json test script in the
       repository
     ? could not determine: whether anything outside this repository imports
       calc.js
     it is carried into the segmentation of anything dispatched from here.
```

A scout is the first fan-out this project has bounded on purpose rather than by accident, and its
three ceilings are worth different amounts. **Depth** is the harness's: a Captain may field the
subagent ranks, and a Sergeant fields nothing, so the nesting cap that goes onto the worker's
environment is 1 — derived from the rank table rather than typed in. **Count** is the supervisor's,
because a roster names who may be fielded and has no position for how many: distinct spawn
identities are counted off the normalised event stream and the crossing kills the process. That
kill costs something and the cost is stated where it happens — a unit still fanning out has
usually not answered yet, so the common outcome of a halt is a recce with nothing to show. An
`interrupt()` was tried first and was measured dead: the soldier's stdin is closed immediately
after its orders, so by the time any event reaches the listener the adapter's `interrupt()` rejects
with `is not running`, and every crossing fell through to the kill anyway. **Cost** is arithmetic —
at most 1 + 4 = 5 model sessions in one process inside 10 minutes — plus a session ledger that
refuses a further recce once cumulative reconnaissance spend crosses $5.

A crossing looks like this, and the last paragraph is the ceiling saying what it cost you rather
than congratulating itself:

```
  ◇ scouting — one CPT·SCOUT, reading only.
  ⚠ scout stopped — it fielded more than 4 subordinates

  ◇ cpt-01 reported — the words below are the SCOUT'S, not this process's, and 7
    subordinate(s) contributed to them.
     calc.js has a single named export, add, defined as an arrow function
     …
  ! the scout fielded 7 subordinates, past the ceiling of 4, and its process was
    killed. Every one of them runs inside that process and is billed to the same
    subscription, so an uncapped fan-out spends the budget before an Engineer
    has been raised. Anything it had already reported is above; a scout that had
    not answered yet returns nothing, which is what a ceiling that stops rather
    than asks actually costs.
```

The live line quotes the ceiling and the account afterwards quotes the final measured count. They
differ — 4 against 7 — because events keep arriving through the kill, and reporting the same number
twice would mean one of them was a guess.

Note the reporting line. Everything under it is the scout's own words, and the screen says so
before printing any of them, because a subordinate's prose entering a commanding context is
exactly where a briefing gets forged. The finding is capped by schema and neutralised once, at
capture.

**Then the alignment gate, and the keystroke is last.** A dispatch that carries a spec begins
phase 2 only when three things hold, in this order: every required field is answered, every
verification command **executes** against the base commit, and you confirm. That ordering is the
change. What it replaces was one keystroke on a printed objective, which is a confirmation of
nothing in particular.

```
  ◇ running the spec's verification commands against the base commit…
      baseline: `true` exited 0 against the base tree
      baseline: `false` exited 1 against the base tree

  ◇ alignment gate
    ✓ spec         every required field answered (6 of them; verification
                   commands are the optional seventh)
    ✓ criteria     2 of 2 executed against 19cc6aa
      ✓ `true`
          exit 0 at base — already green before any work. It is a real check and
          it will not be the one that proves the feature.
      ✓ `false`
          exit 1 at base — a red criterion, which is the normal starting point.
          The reading is recorded, so phase 3 can tell a test that was already
          failing from one the work broke.

  ◇ dispatch this? [y/N] y
  ◇ spec written to docs/army-specs/pty-w5-gatered/spec.md
  ◇ dispatching — Engineer, then an independent Inspector.
```

**The second condition is the load-bearing one and its two halves are kept apart everywhere.** A
command that *executes* and exits non-zero **passes**, with its reading banked, because a red test
is where work starts and `node --test` should fail before the feature exists. A command a shell
cannot execute, one that returns no exit code, and one still running at the deadline all **fail**,
because each has told the system nothing — `src/contracts/verify.ts` already draws that line: a
non-zero exit says the work is wrong, a timeout says nobody found out. Collapsing "failed" into
"could not run" is the mistake that would make this gate refuse every honest red test in existence.

When it fails, no keystroke is offered at all:

```
  ◇ running the spec's verification commands against the base commit…
      baseline: `army-no-such-tool-w5 --check` exited 127 against the base tree

  ◇ alignment gate
    ✓ spec         every required field answered (6 of them; verification
                   commands are the optional seventh)
    ✗ criteria     0 of 1 executed against 41c63c9
      ✗ `army-no-such-tool-w5 --check`
          a shell could not execute it — exit 126 is found-but-not-executable
          and 127 is not-found. That is a fact about the command rather than
          about the work, and it will be just as true after an Engineer, so this
          campaign could never pass its own gate.

  ◇ not dispatched — the alignment gate did not pass.
```

That is the $8.86 incident closed at the front instead of half an hour in. A spec with no `verify`
commands passes, loudly: the absence is reported, the screen says nothing was executed and phase 3
has no baseline, and `AcceptanceResult.ran` says the same thing one phase later. A proposal with
**no spec at all** does not enter the gate — the free-text path stays exactly what it was, and it
is visibly the worse deal rather than the cheaper one, because a spec-less brief escalates the
Engineer to the most expensive reasoning class there is:

```
  ◇ alignment gate — NOT RUN
     This proposal carries no spec, so there is nothing to align: none of the six questions was
     asked, no verification command exists to run against the base commit, and phase 3 will have no
     baseline to compare against. The Engineer is escalated to the highest reasoning class to make
     up for it, which is the most expensive way to answer a question a sentence would have settled.
```

**What phase 1 leaves behind.** The settled spec, the interrogation that produced it, and the
gate's readings go to the campaign archive as `spec.md`, `spec.json` and `interrogation.md` under
`agents/col-01/`, unconditionally and with no key that turns it off — a decision record with an
off switch is a record nobody can rely on being there. `[planning] spec_to_repo` in `config.toml`
decides whether the *same three documents* also land in the checkout, under
`docs/army-specs/<campaign-id>/`. It is **off by default**, because a rejected branch should not
strand design documents in the repo: a campaign that ends `inspector-failed` still produced a spec,
and with this on that spec is an untracked directory describing a feature nobody shipped. Turn it
on when the spec is meant to be reviewed next to the diff. One function renders both copies, so
they are byte-identical by construction rather than by a test.

The three transcripts above came from real sessions driven under a pty, with stand-in vendor CLIs
on `PATH` — the screen is production code and the bytes are what a terminal received; the
commander's and the scout's words are the stand-in's.

### An answer reads as an answer, and your words read as yours

On a terminal the commander's answers render instead of streaming out raw. Each answer hangs
under a `◆` gutter, wraps at word boundaries with the indent kept on every continuation row, and
the markdown a model actually sends becomes ink: `**bold**` prints bold with the markers gone,
`` `code` `` prints cyan, list continuations align under their item text, `[text](url)` paints
the text cyan with the destination dim beside it, and `---` becomes a dim rule.

Pipe tables render aligned with dim borders. A table too wide for the window has its widest
columns taken down and its cells wrapped inside them, which is what a person does by hand; only a
table with more columns than the window can seat gives up and prints its raw lines dim. It is the
one construct that waits for its last row, since alignment printed early could never be corrected.

Fenced code drops its backticks and takes a dim rule down its left edge instead, the same way
`**bold**` prints without its asterisks. The body is syntax highlighted for js/ts, json, sh,
python, toml and diff (`src/view/highlight.ts`), muted so a block reads as one quiet region:
comments grey, strings green, keywords cyan, everything else dim.

Your own turns are a block, not a label. Every row of a submitted entry carries a green `▌` down
the left edge and wraps to the window like the answers do, so the two voices are two regions on
the screen rather than two kinds of sentence. The composer accepts multiline input the way Claude
Code does: a trailing `\` then Enter continues on the next line under a dim `…` prompt, and the
whole entry lands as one bar-marked block and one message. Pasted text is one message too. A
newline inside a paste ends the row and not the turn, so a dictated paragraph reaches the
commander whole rather than as its first line plus four interruptions of the answer to it. The
terminal's bracketed paste mode is what tells the two apart, and where a terminal does not offer
it, a line break with more bytes behind it in the same read is read as pasted. A paste never
sends by itself: your Enter does. Streaming survives it: answers render line by line as they
arrive, and a commander that stalls mid-sentence has its held words printed after a beat rather
than hidden, so the wedge is visible with everything it managed to say. Piped or redirected,
none of this engages and the transcript stays raw bytes (`src/view/prose.ts`).

### A worker can stop and ask you

An Engineer that hits a decision it has no authority to make reports `blocked` with a question
instead of guessing, and the question climbs to your terminal while the dispatch is still running.
It arrives as a block that marks whose words are whose: the agent, the task and the branch are the
supervisor's own facts, and everything the worker wrote is quoted under a heading that says so.

```
  ? QUESTION 1 · cpt-01 · workstream t-f14690b69c1b
  ◇ cpt-01 (CAPTAIN·ENGINEER) is blocked and is asking.
    attempt 1 · task t-f14690b69c1b · branch army/t-f14690b69c1b
    objective   add a multiply function to calc.js

    ITS QUESTION, in its own words:
      > should multiply() throw on a non-number, or coerce it?

    ITS ACCOUNT of where it got to:
      > the objective needs a decision I cannot make

    WHAT IT SAYS IT TRIED OR RULED OUT:
      > blocker: both spellings are defensible
    a blank answer, or Ctrl-C, leaves the question unanswered.
  ◇ your answer
```

**A question climbs one rung at a time.** With an overseer over the campaign, the `MAJ·OVERSEER`
is asked first, and it answers only what it owns: `answer: null` is a first-class return that
sends the question on to you unchanged, and declining is what makes the rung worth having rather
than a rung that guesses. A wrong answer there is more expensive than a question that reaches a
human, because nothing above it will look at it again. Without an overseer the question comes
straight to you, which is what this looks like.

**That prompt is not the composer.** Everything typed at `▌` goes to the commander; this one line
goes to a worker that is holding a worktree and waiting, so the two never share a prompt — and it
reads only what you type after seeing the question. Anything you had already typed while the
dispatch ran stays queued for the commander and reaches it, in order, once the dispatch is over.
That is a property of the *line* rather than of the read, and it is written that way because it
broke three times when it was a property of the read: a line inherits the addressee of the prompt
it was typed under, a read consumes only lines addressed to it, and the field is required, so
omitting it is a compile error rather than a missing guard. A half-typed draft caught by the prompt
changing under it is not eaten either — it is displaced to the commander's queue, and the session
says so in as many words: *"the line you were typing was addressed to the prompt that just
changed. It is queued for the Commander rather than sent to this one"*.

A blank answer, Ctrl-C, or a closed terminal all mean the same thing: the question goes unanswered,
the block ends that attempt, and the branch and the worktree are settled the way any other ending
settles them. The status block says which of the two states you are in while it is true.

**Several questions queue rather than interrupt.** Each arrives as a block in scrollback under its
own `? QUESTION n` marker naming the agent and the workstream that raised it, and the count of what
is open sits on the status block. Nothing seizes what you were typing. With one open, typing
answers it and the prompt says so; with several, the prompt names the one you are answering and
`/next` cycles. While a question is outstanding its workstream parks and holds its worktree, and
every sibling workstream keeps running.

An answer resumes the work as a fresh Engineer against the same task in the same worktree, briefed
with your decision, and answering does not spend an attempt from the retry budget — a worker that
stops to ask should not end up with fewer tries than one that guessed. There are two counters and
exactly one line where they diverge. `MAX_QUESTION_ROUNDS` is 3 and bounds it, per workstream
rather than per campaign, for the same reason the retry budget is per workstream: one pool across N
concurrent workstreams turns a budget into a race. Both halves are in the archive as linked `query`
and `answer` signals, so `army view` reads back what was asked and what you said. Run headless
(`army campaign` in a script) there is nobody to ask: the block ends the attempt, and the
unanswered question is still recorded, because a campaign that stopped on a question nobody was
there to answer is a thing you want to be able to see afterwards.

A `blocked` report **may** carry a question and is not required to. Requiring it was tried and
withdrawn: JSON Schema cannot express "required when another property equals a value", so a model
that followed the schema and skipped the prose lost its *whole* report to the validator — no
`report.json`, and the block's own account of itself gone from the archive. A block with a question
climbs; a block without one is terminal exactly as it was before, and everything the worker did say
is still on disk.

### `/stop`, `/work` and `/next`

Three commands exist because a campaign is no longer something you sit and watch.

**`/stop`** ends the running campaign, and confirms first, because every worktree in flight has to
be settled rather than dropped. It tells you how many agents it is about to end before it asks.
Ctrl-C never means this. A line typed while the confirmation is armed and which is not a yes or a
no is not swallowed as a decline — it is re-routed, so it can still be another slash command, and
otherwise it is queued for the Commander as your next turn. It is explicitly *not* eligible to
become a parked worker's answer: a sentence typed at `stop the campaign? [y/N]` was not typed for
an engineer.

**`/work <id>`** prints one agent or workstream into scrollback: its rank and state and why, its
task, its harness and model, its worktree, its cost, its branch read off the task rather than off
the model's own summary, the head of its `orders.md`, and a diffstat. It prints rather than opens,
because a pager would need the alternate screen this interface deliberately does not use. It
answers after the dispatch has ended, too.

**`/next`** moves to the next open question. It cycles; it does not answer, skip or remove
anything.

The session's own budget is on the status block from the first spawn: agents raised against the
concurrency cap, and what has been spent. A tree that can grow to dozens of agents should never be
a surprise on a bill.

### The session tells you where you are

A session opens with a header, and keeps a status block pinned under the prompt for as long as it
runs. Both exist for the same reason: a commanding session approves work against a *place* — a
repository, on a branch, with or without uncommitted changes — and the one command in this tool
where that place was never named was the one that dispatches Engineers into it.

```

╭───────────────────────────────────────────────────────╮
│ ◆ COL·COMMANDER — a live session                      │
│ it holds the objective, and one inert tool: TodoWrite │
╰───────────────────────────────────────────────────────╯

  project      calc
  path         /Users/you/code/calc
  branch       main · bbaf74f · 3 uncommitted · 2 ahead
  commander    claude · claude-opus-5
  permissions  unguarded · any command; rank narrowing, denies, sandbox hold
  ceiling      0 (commit)   dispatches ask for at most 0 (commit)
  archive      /Users/you/.agentic-army/campaigns/2026-08-07-chat

  every dispatch is reviewed by an independent Inspector
  Ctrl-C stops the answer in flight · a second one leaves · /help for the rest
  army view 2026-08-07-chat   reads this conversation back
```

The `permissions` row is the posture every worker this session dispatches is built under, and it
is on the header because the header is what a person looks at for an hour. `army init` writes
`unguarded`, under which an Engineer runs any command rather than a listed one; the row says so,
and says what still holds.

The block under the prompt is repainted in place rather than scrolled, so it is still there an
hour later. Its last row is the context row and never moves, so the eye learns one position: the
branch and whether it is dirty, then whatever the session most needs to say, then the questions
open, the agents raised against the concurrency cap, the spend, the project, the model and the
rung. Above it, **while a dispatch runs, the campaign's live tree**:

```
└─ ▸ add a multiply function …  —         —    —  blocked    —                    1 attem…   5s ago
   └─ ◇ CPT·ENGINEER · cpt-01   CPT       1   -2  dead       agent-row:exited     exited,…   5s ago
  main · asking: type to answer, Ctrl-C to skip · 1 question open · 1/1 agents · $0.50 · repo
```

**That tree is not a second renderer.** It is the same `TreeModel` `army view` builds from the
campaign's own archive files, drawn by the same function, truncated to the rows the block is
allowed — never more than a third of the window, with three rows held back. When it does not fit,
rows are scored and the *running* ones are kept over the finished ones, and one row accounts for
what was dropped and points at `army view` for the rest. A running unit is never dropped to keep a
settled one.

The context row is the block earning its place. Ctrl-C behaves differently during a dispatch than
anywhere else in the session, and differently again with a question open, and the row says which
you are in while it is true — that is a surprising rule to meet for the first time by pressing the
key.

It degrades rather than guesses. `git` unavailable, or a `git status` that times out, renders as an
absent branch and never as a clean one. A terminal too short for the whole block gets **no block at
all** rather than a trimmed one, which is why the tree does its own arithmetic first. Piped or
redirected there is neither block nor git probe, because escape bytes in a saved transcript are a
corruption rather than a feature. `--plain` turns the painted rows off on a terminal that reports
itself as one and does not honour cursor movement — an editor's embedded console, a CI runner with
a PTY — and leaves the header, which is ordinary output, exactly where it was. `/status` prints
the header again with the working copy re-read.

### The session tells you what a unit is doing, not just that it exists

A dispatch used to say one thing and then nothing: `CPT·ENGINEER · cpt-01 working 14m00s`, for as
long as it took. Everything else went to `stream.jsonl` and stopped there — for a 27-minute
Engineer that was 972 events, 107 tool calls, five permission denials and 662 reasoning-token
readings, written to disk and shown to nobody.

The supervisor now narrates the run. Finished tool calls scroll past as they happen:

```
  ⏺ Write(lib/html.js)
  ⏺ Write(lib/checks.js)
  ⏺ Bash(cat > /tmp/redirect_test.js << 'EOF' const http = require('http'); …)
  ⊘ Bash(cat > /tmp/redirect_test.js << 'EOF' …) refused – Permission to use Bash has been denied…
  ⏺ Bash(node --test 2>&1)
```

and where the block cannot draw the tree — the archive unreadable, or a window under 38 columns —
it falls back to a roster, one row per unit in flight with its own clock:

```
  ⠸ CPT·ENGINEER · cpt-01 working 3m19s – Bash(node --version) · 3m03s ago · thinking 18k
```

Three things there are deliberate. The row shows the **command**, not the model's description of
it — a description is a claim, and the command is what a permission layer is about to refuse. A
finished tool call does **not** blank the row; it keeps naming the last action and dates it, because
75% of a run's wall clock is reasoning *between* tool calls and a blank row through those minutes
was the original complaint. And `thinking 18k` is the harness's own reasoning telemetry, which
arrives every second or so — it is the only thing that moves during a long silence, so it is what
tells you the difference between a model working hard and a wedged process. If nothing arrives at
all for 45 seconds the row says `silent 1m20s` instead of pretending.

What it never does is invent a number. There is no percent bar and no ETA, because there is no
denominator for an agent. A harness that reports no reasoning tokens renders no token count rather
than `thinking 0` — unknown is a real state here exactly as it is for the branch. Bookkeeping calls
(`TaskCreate`, `TaskUpdate`, `ToolSearch`) produce no line at all: they were 25 of the reference
run's 107 calls and arrived in bursts of nine, which is enough to push the real work off a short
terminal.

Nothing downstream of the translator can carry a tool's payload. `describeToolUse`
(`src/view/activity.ts`) is the only function permitted to read `ToolUseEvent.input`, and the event
it produces carries `tool` and `target` as already-sanitised, already-clipped strings — so a 40 MB
tool result has no type-legal route to a terminal. Model-chosen paths on a repainted row are also
why `displayWidth` exists: a CJK ideograph is one UTF-16 unit and two columns, and a row measured
the wrong way wraps, which puts the cursor permanently one line adrift.

The conversation is archived like any campaign — `army view` renders it, and the query/answer
pairs are linked in `signals.jsonl`, so a crash costs you nothing.

## `army view`

A read-only tree view of a campaign: how deep the nesting goes, which ranks are in play, and
what every unit is doing right now. Safe to run from a second terminal against a campaign in
flight, and safe days later against one that is over.

```sh
army view                   # the newest campaign in the archive
army view --list            # what is in the archive
army view <id> --follow     # poll and redraw, no fs.watch and no native dependency
```

This is the segmented campaign from further up, read back after it finished:

```
☆ add multiply and divide to calc.js · 2026-09-01-add-multiply-and-divide-to-calc-js · done
  /private/tmp/doc-conflict-yb8gUQ/repo
  9 tasks · 8 attempts · ranks MAJ→CPT · depth 1–1 · busy 0 idle 0 unknown 0 dead 8

UNIT                            RANK  DEPTH  GAP  STATE      WHY                   DOING        WHEN
└─ ▸ add multiply and divide …  —         —    —  done       —                     army/t-…   8m ago
   ├─ ▸ segment: add multiply…  —         —    —  done       → maj-01              1 attem…   8m ago
   │  └─ ◈ MAJ·OVERSEER · maj…  MAJ       1   -1  dead       agent-row:exited      exited,…   8m ago
   ├─ ▸ add and export multip…  —         —    —  done       → cpt-01              army/t-…   8m ago
   │  ├─ ◇ CPT·ENGINEER · cpt…  CPT       1   -2  dead       agent-row:exited      exited,…   8m ago
   │  └─ ▸ review army/t-8616…  —         —    —  done       → cpt-04              army/t-…   8m ago
   │     └─ ◇ CPT·INSPECTOR ·…  CPT       1   -2  dead       agent-row:exited      exited,…   8m ago
   ├─ ▸ add and export divide…  —         —    —  done       → cpt-02              army/t-…   8m ago
   │  ├─ ◇ CPT·ENGINEER · cpt…  CPT       1   -2  dead       agent-row:exited      exited,…   8m ago
   │  └─ ▸ review army/t-8616…  —         —    —  done       → cpt-03              army/t-…   8m ago
   │     └─ ◇ CPT·INSPECTOR ·…  CPT       1   -2  dead       agent-row:exited      exited,…   8m ago
   ├─ ▸ Reconcile army/t-8616…  —         —    —  done       → cpt-05              army/t-…   8m ago
   │  ├─ ◇ CPT·ENGINEER · cpt…  CPT       1   -2  dead       agent-row:exited      exited,…   8m ago
   │  └─ ▸ review army/t-8616…  —         —    —  done       → cpt-06              army/t-…   8m ago
   │     └─ ◇ CPT·INSPECTOR ·…  CPT       1   -2  dead       agent-row:exited      exited,…   8m ago
   └─ ▸ validate army/t-8616d…  —         —    —  done       → cpt-07              army/t-…   8m ago
      └─ ◇ CPT·VALIDATOR · cp…  CPT       1   -2  dead       agent-row:exited      exited,…   8m ago

  read-only · source files · 2026-09-01T21:34:00.575Z
```

**Read-only is enforced, not promised.** The default source is the files, so the common path
opens no database at all; `--source db` opens the index with `readOnly: true` and never *sets*
`PRAGMA journal_mode`, because setting it would rewrite the file header. The test suite
fingerprints size, mtime and a SHA-256 of every file in the campaign directory — `campaign.db`
and its `-wal`/`-shm` sidecars included — before and after a render, and requires them
identical.

**Every verdict carries the rule that produced it**, in the `WHY` column, and `unknown` is a
real state rather than a confident guess: no stream, no events, or silence past `--stale-after`
all report as `unknown` rather than as `idle`.

`RANK` and `DEPTH` are separate columns on purpose. Rank is assigned by the spawner and must be
strictly junior to it; it is not derived from depth. `GAP` is depth minus rank seniority, so the
two values above are both normal and both mean something: the `-1` on the overseer is a General
detaching a Major and skipping COLONEL; the `-2`s are a Captain detached directly, skipping
COLONEL and MAJOR. A *positive* gap is the anomaly — more nesting levels than ranks consumed,
which is only possible if a spawn failed to go strictly junior — and those rows get a `!` and are
listed.

## `army rebuild`

Throws `campaign.db` away and puts it back from `campaign.json`, `tasks.jsonl`, `signals.jsonl`,
`agents/*/agent.json` and `agents/*/stream.jsonl`. It never reads the existing database, so
anything that comes back was really on disk:

```sh
army rebuild                # every campaign in the archive
army rebuild <campaign-id>  # one
```

```
2026-09-01-add-multiply-and-divide-to-calc-js  tasks 9  agents 8  signals 31  events 32
```

It exits 1 if rows were present in the files but did not make it into the index, and names every
one of them.

## `army trial`

A campaign asks whether the work got done. A trial asks what a variable is *worth*: same model,
same brief, same seed commit, one directory per arm, one thing changed. It exists because
"engineers are taking too long" is not a claim you can act on until you know whether reasoning
effort is buying anything.

A trial is a TOML file naming a seed repository, a brief, a set of efforts, and the checks that
decide whether an arm succeeded. `trials/duration/` and `trials/sheet/` are worked examples.
Run `trials/prepare.mjs <name>` first — it mints that trial's seed as a real repository, which
is checked in as plain files because a nested `.git` cannot live inside this checkout.

`trials/sheet/` is the one built to discriminate: a formula evaluator with a tokeniser, a
precedence-correct parser, cycle detection that must not take the rest of the sheet down with
it, and an empty-cell rule the obvious implementation gets wrong. It carries a second job check
run against a **held-out suite the arms never see**, which is what separates implementing the
specification from fitting the visible tests.

Three things are measured, and none of them is the worker's opinion:

| question | scored from |
|---|---|
| did it do the job | a command run in the arm's workspace, exit code compared |
| did it follow orders | the git diff against the seed commit, and the recorded tool-call stream |
| how fast | wall clock around the spawn, plus tool calls, tokens and cost |

**Nothing reads the `Report` the worker returned.** A worker that believes it finished and did
not is the most common failure recorded here, so a benchmark scored from self-reports measures
how confidently a model writes a summary. `Report` is a good transport and a useless scoreboard.

Before any arm is spawned, every `job` check is evaluated against an untouched copy of the seed.
If one of them passes, the trial **refuses to run** and exits 2. A check that is already green
scores every arm full marks forever, which is the benchmark equivalent of a test that has never
been seen to fail.

Two things the report is obliged to print, because leaving them out would fabricate a result.
`--effort minimal` does not exist in claude and is mapped up to `low`, so a `minimal` arm and a
`low` arm are byte-identical invocations; when two arms were sent the same value the report says
so, and the gap between them is your run-to-run variance measured for free. And in concurrent
mode — the default, because five arms contending simultaneously share that contention
symmetrically — the wall column compares arms honestly against *each other* and must never be
put in the same column as a serial run.

Exit codes are 0 (every arm passed everything), 1 (something scored badly), 2 (the trial was
refused and never ran). Three codes because a script needs to tell the second from the third.

## Where things live

```
~/.agentic-army/
  config.toml                      # ceilings + dispatch rules + hooks + planning. Yours to edit.
  campaigns/<date>-<campaign>/
    campaign.db                    # the INDEX: agents, tasks, signals, timings, cost
    campaign.json                  # truth. campaign.db is rebuilt FROM these, never the reverse
    tasks.jsonl  signals.jsonl     # truth
    agents/cpt-01/
      agent.json                   # truth
      orders.md  report.json  report.md  stream.jsonl  diff.patch
    agents/col-01/
      spec.md  spec.json  interrogation.md   # what phase 1 settled. Always written.
  mirrors/<basename>-<hash>.git    # durability when a project has no remote

~/.agentic-army-trees/             # the leased worktree pool, created on first use
  trees/<project>-<hash>/wt-01/    # one leased worktree per slot; the integration tree is one too

<your repo>/
  docs/army-specs/<campaign-id>/   # the same three documents, ONLY with planning.spec_to_repo
```

The pool is a **sibling** of `~/.agentic-army`, not a directory inside it, and it does not follow
`archive_root`. Every worker is denied Read, Grep, Glob, Write and Edit on `~/.agentic-army/**` —
that deny is what makes the delivery ceiling a boundary, and it is also what keeps an Inspector's
brief independent of the Engineer's own `report.md`. A worktree inside that region
would therefore be a worktree the Engineer could not open a single file in. `AGENTIC_ARMY_HOME`
moves the trees too: the pool root is always `<home>-trees`.

SQLite is the index; the files are truth, which is why `army rebuild` can throw
`campaign.db` away and put it back from the files alone, and why `army view` reads the files by
default and opens no database at all. The mirror name carries a hash of the project's absolute
path because two checkouts sharing a basename would otherwise share a mirror and collide on
identical `army/<task-id>` branches.

Reports never land in your repositories, and the one thing that can is off by default and named
above. `AGENTIC_ARMY_HOME` relocates this whole directory, including every ceiling in it — it is
read from your own environment at startup, and a supervisor must never accept it from a worker.

## Development

No build step: Node 24 strips types natively, so the source runs directly.

```sh
npm run dev -- doctor     # node src/cli.ts doctor
npm test                  # node --test
npm run typecheck         # tsc --noEmit
npm run build             # tsc -> dist/, what publishing ships
```

Only `smol-toml` at runtime. The published package contains `dist/` and `schemas/` — never
source or tests — and compiles down to plain ESM so installers need nothing newer than Node 20.

The language rules are enforced mechanically rather than by review: `erasableSyntaxOnly` bans
`enum`, `namespace`, decorators and parameter properties, and `verbatimModuleSyntax` requires
every type-only import to say `import type`. Relative imports carry an explicit `.ts` extension
and are rewritten to `.js` on emit.

## What has actually been run

This README used to claim two commands were "not available yet". They were not; they shipped.
So that this section does not rot into the same shape, here is the line between what was
exercised end to end while writing it and what was not. Everything below was run on macOS, from
a checkout, against a throwaway git repository, with `AGENTIC_ARMY_HOME` pointed at a temporary
directory.

There are now three grades of evidence behind this document and they are not interchangeable, so
they get three headings rather than one list.

**Run against live claude and codex, and the output is what you see above:** `doctor` (fully ok,
and again with `codex`/`gh` removed from `PATH` and `ANTHROPIC_API_KEY` set, to see all three
degradations and exit 0); `init`, twice, for the idempotence claim; `enlist`, and
`enlist --ceiling 2` and `--ceiling 3` non-interactively to see the refusal and the exact config
line it prints instead; `campaign`, end to end, Engineer through Inspector to durability; `chat` —
one objective proposed, approved at the prompt, dispatched through the gate to a rung-0 delivery,
plus the refusal when the commander was asked to read a file, and a live interrupt mid-answer;
`view`, `view --list`, `view --source db`, `view --follow`; `rebuild`; `trial`, five times across
two seeds — 32 arms spawned, 30 of which produced a result. What that measured is written up under
[What a trial measured](#what-a-trial-measured) below. The `army` spelling in the first column of
[First run](#first-run) was checked too, against a built `dist/` on `PATH`, because the claim
that suggestions match your invocation is only interesting if it holds in more than one form.

**Run with stand-in vendor CLIs on `PATH`, so the screen is real and the model is not.** Everything
above the vendor CLI is production code — the supervisor, the permission layer, the worktree pool,
git, the archive, the renderer — and the transcripts of it in this README are the bytes those runs
emitted. What is *not* demonstrated is anything a real model would have decided. On that footing:
the whole overseer path (`--overseer`, segmentation, two concurrent workstreams each with its own
tree and branch, the overlap announcement, a real merge conflict, a reconciliation workstream, the
`CPT·VALIDATOR`, delivery); `--rung 3` on a ceiling-3 project, reaching the ladder and being
refused by it for the rung it could not reach; and, driven under a pty on a real terminal in raw
mode, the `army chat` surface — the scout proposal and its finding, the alignment gate passing and
refusing, a worker's question arriving and being answered, a half-typed line being displaced to the
Commander rather than sent to a worker, and the pinned status block with the live tree in it.

**Implemented but NOT exercised end to end at all, so take the description and not a
demonstration:**

- **The whole of the five waves above against a real objective and real vendor CLIs.** This is the
  big one and it is worth stating plainly rather than distributing across the bullets below. The
  overseer, the question ladder's middle rung, per-workstream inspectors, the fix loop, the
  validator, the scout, the alignment gate and the chat surface have been driven under a pty and
  through the real supervisor many times, and never once with claude and codex actually behind
  them on a real repository and a real objective. Every sentence in this README about what those
  units *decide* — a segmentation a model would return, a question an overseer would decline, a
  verdict a validator would give — is a claim about the machinery that carries the decision, not
  evidence about the decision.
- **Delivery rungs 1, 2 and 3 through `army campaign` against a real host.** Only rung 0 has been
  delivered that way. The merge rung is exercised in `test/delivery.test.ts` against local
  infrastructure only: real repositories, a real bare repo standing in for `origin`, a real
  durability push, the real allow-list on every argv, and a stand-in `gh` executable on disk that
  performs the merge by moving the bare repo's `main`. So "it merged" is a fact about a repository
  on this machine, and the gates, the argv, the idempotence and the reporting are all demonstrated.
  What is NOT demonstrated: that the real `gh` accepts these flags, and that GitHub's branch
  protection refuses the way the stand-in does.
- **The spec path against a live commander.** `TechnicalSpec` validation, the effort coupling, the
  `--spec` flag, the interrogation text and every briefing that carries the spec downward are
  covered by tests and were exercised end to end in-process. What has NOT happened is a live `chat`
  session where a real commander interrogated a real human and produced a spec it then dispatched.
  The wording of the interrogation is a code claim until that runs.
- **A scout's fan-out against a real model.** The count ceiling, the kill at the crossing and the
  session ledger are all driven and observed under a pty, with a stand-in that fans out on demand.
  Nobody has watched a real `CPT·SCOUT` choose how many subordinates to field.
- **Reviewer-written tests reaching a branch.** The authorship reading, the discard on a stray
  write, the hold-out-of-history and `commitInspectorTests` are covered by tests, and the
  transcripts above are from campaigns where the repository had no test directory, so
  `testsArePermanent` was false and nothing was ever held. The path from a reviewer's editor to a
  commit on the integrated branch has not been walked with a model at the top of it.
- **The retry path against a real Inspector FAIL.** Every recorded live Inspector passed on attempt
  1, so no second Engineer has been fielded by a real refusal.
- **Raising a ceiling from a real TTY.** Only the non-interactive refusal was observed.
- **The `guarded` permission posture in a real campaign.** The shipped default is `unguarded`, and
  that is what every run above used. The scoped rules are built and asserted by tests at both
  postures; no campaign has been fought under `guarded`.
- **Windows.** Untested, and never claimed otherwise. Paths are built with `node:path` and the
  glyph set falls back to ASCII on a codepage-437 console, but neither has been run there.

## What a trial measured

Two seeds, five runs, 32 arms. Every number below is off artifacts — the workspace's git state
and the recorded event stream — never off what a worker said about itself.

**The first seed could not separate its conditions.** A duration-string parser, 15 arms: all 15
did the job, at every effort level, under both briefs. Two arms sent the *identical* effort
value finished 23s and 45s apart, a spread wider than anything between effort levels. That is a
benchmark measuring the task rather than the variable, and the honest report of it is "too easy",
not "effort does not matter".

**The second seed separated them cleanly.** A spreadsheet formula evaluator — tokeniser,
precedence-correct parser, memoised evaluation, cycle detection that must not take the rest of
the sheet down with it, and an empty-cell rule the obvious implementation gets wrong. Two briefs
carrying identical constraint sections, differing only in whether the thinking had been done
above. Scored against the visible suite *and* a held-out suite no arm ever saw.

| brief | effort | job | wall | cost |
|---|---|---|---|---|
| complete | minimal | pass | 55s | $0.48 |
| complete | **low** | **pass** | **1m12s** | **$0.29** |
| complete | medium | pass | 1m38s | $0.62 |
| complete | high | pass | 3m44s | $0.93 |
| complete | xhigh | pass | 4m31s | $1.27 |
| thin | minimal | 1 of 2 runs | ~2m50s | $0.71 |
| thin | low | fail | ~3m20s | $0.71 |
| thin | medium | fail | ~4m10s | $0.95 |
| thin | high | fail | 5m49s | $1.03 |
| thin | **xhigh** | **pass** | **9m42s** | **$1.64** |

The complete brief succeeded at **every** effort level, including the lowest. The thin brief
succeeded reliably only at the highest — and the one low-effort thin arm that passed did not
reproduce, the same cell failing when it was run again.

**The two boldface rows are the finding.** Identical outcome — both suites green, every
constraint obeyed — for **8× the wall clock and 5.7× the cost**. Maximum reasoning effort can
substitute for a specification. It is the most expensive way to buy one.

The failures name their own mechanism rather than merely correlating. Six of the eight thin arms
failed on `-0` normalisation, and one also scanned a range column-major when choosing which error
to surface. Both rules are stated in the complete brief and appear **nowhere in the visible
tests**. The complete arms did not derive them; they were told them.

Two caveats the numbers carry. Wall-clock figures come from concurrent runs, so they compare
arms against each other and not against anything recorded elsewhere. And `minimal` does not exist
in claude — it is mapped up to `low` — so those two rows are byte-identical invocations, which is
where the run-to-run variance above was measured from.

## License

MIT
