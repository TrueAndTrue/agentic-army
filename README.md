# agentic-army

A war-hierarchy multi-agent orchestrator. You are the **Commander**; everything below you is
an agent with a rank (its authority), a role (its branch of service), and a bounded blast
radius. Officers hold strategy and are structurally incapable of editing a file; Captains and
below do the work, each in its own isolated worktree; and every change is reviewed by an
Inspector that was briefed by the *parent*, from the original orders, never by the agent under
review. The design goal is that nothing enters a commanding agent's context except a
hard-schema report — guarded by mechanism rather than by discipline.

> **Status: the loop runs; the package is not published.** `army doctor`, `army init`,
> `army enlist`, `army chat`, `army campaign`, `army view` and `army rebuild` are all
> implemented, and every transcript below is real output from running them. What is missing is
> distribution:
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

Four steps, in whichever spelling you are on. **You never have to keep track of which one that
is**: every command this tool prints for you to type is emitted in the form you actually invoked
it with. A checkout's `node src/cli.ts doctor` ends with ``Next: `node src/cli.ts init` ``; the
installed `army doctor` ends with ``Next: `army init` ``. Same for every fix line, every usage
line and every error.

| | installed | from a checkout | via `npx`, once it publishes |
|---|---|---|---|
| what is missing, and the exact command to fix each thing | `army doctor` | `node src/cli.ts doctor` | `npx agentic-army doctor` |
| create `~/.agentic-army/` and write `config.toml` | `army init` | `node src/cli.ts init` | `npx agentic-army init` |
| register this repo — delivery ceiling 0, commit only | `army enlist` | `node src/cli.ts enlist` | `npx agentic-army enlist` |
| run one objective end to end | `army campaign "…"` | `node src/cli.ts campaign "…"` | `npx agentic-army campaign "…"` |

`enlist` and `campaign` read the current directory, so `cd` into the repository you want worked
on before either of them. From here on this README writes `army …`; substitute your column.

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

`army campaign --rung 3` still refuses, and says why. The campaign command does not yet hand the
ladder the two facts rung 3 needs from it — whether the Engineer finished, and whether the retry
budget ran out — and a rung whose evidence is missing refuses rather than shipping rung 2 under a
rung-3 heading. `src/delivery/ladder.ts` is where that gate lives.

```sh
army enlist                 # ceiling 0
army enlist --ceiling 2     # from a terminal: allow PRs on this repo
```

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

## `army campaign`

One objective, end to end. A CPT·ENGINEER (claude) takes a leased worktree, cuts
`army/<task-id>` and commits. Then the **GENERAL** — not the Engineer — spawns a CPT·INSPECTOR
(codex), briefed from the *original orders and the branch*, never from the Engineer's account of
what it did. On PASS the work is made durable and the delivery ladder runs, clamped by the
project ceiling. On FAIL a fresh Engineer retries in the same worktree with the findings.

```sh
army campaign "add a multiply function to calc.js"
```

Against a throwaway repo at ceiling 0, that printed (paths shortened):

```
campaign 2026-08-03-add-a-multiply-function-to-calc-js  —  delivered
  project   …/demo-repo
  task      t-b5ad0c70d0c1
  branch    army/t-b5ad0c70d0c1
  ceiling   0 (commit)   requested 3 (merge)
  delivered rung 0 (commit)
  durable   mirror …/mirrors/demo-repo-7d030673.git
  worktree  released — work is durable; the tree was returned to the pool

  attempt 1  ◇ cpt-01 (ok)  →  cpt-02 PASS (NO TESTS RUN — verdict is from reading only)
             Added a multiply(a,b) function to calc.js and exported it alongside add, …
             The branch adds and exports multiply in calc.js; no substitutions or debris
             found, but no test suite exists to run or mutate.

  ⚠ requested rung 3 (merge) exceeds the ceiling for …/demo-repo, which is 0 (commit).
    Delivering at rung 0. A campaign may go lower than its ceiling, never higher.
```

Three things there are the design, not decoration. **The Inspector qualifies its own PASS** —
`NO TESTS RUN — verdict is from reading only` — instead of letting "PASS" imply a green suite
that never existed. **The ceiling clamped the request** rather than honouring `--rung 3`, and
said so. And **durability happened before the lease was returned**, so the commit survived the
worktree being reset and handed to the next campaign; it is readable out of the mirror
afterwards with plain `git`.

## `army chat`

A campaign is one objective, decided up front. `chat` is the other shape: a live session with a
**COL·COMMANDER** that can raise work mid-conversation.

```sh
army chat
army chat --rung 2          # highest rung any dispatch may attempt, still clamped by the ceiling
```

```
you › I want calc.js to also export a multiply function. Propose the objective.

◆ I haven't read `calc.js` — I don't know whether it uses CommonJS or ESM, so I'm keeping
  the objective about behaviour, not style, so it can't drift into a rewrite.

  ```army-dispatch
  {"objective": "Add a multiply function to calc.js that returns the product of its two
   numeric arguments, and export it alongside the existing exports using the same
   module/export style already in that file; leave existing functions unchanged."}
  ```

  ◇ dispatch this? [y/N] y
  ◇ cpt-01 ENGINEER (ok)  →  cpt-02 PASS (NO TESTS RUN)
  delivered · branch army/t-e12c2e318b38 · rung 0 (commit) · worktree released

◆ Delivered, first attempt, verdict pass. One caveat worth your attention: `testsRun: false`.
  There's no package.json, so nothing verified the behaviour beyond the Inspector reading
  the diff. The claim that it multiplies correctly rests on review, not execution.
```

**The commander has no tools.** Its allow-list is one inert entry; Read, Grep, Glob, Edit, Write,
Bash and network are all denied to it by the same permission layer that governs every worker.
That is why it says *"I haven't read calc.js"* — not modesty, and not an instruction it was given
that it might ignore. Asked directly to read a file, it answers that the function is not there to
call. This is the point of the rank: the window holding your objective cannot be spent one source
file at a time, because spending it that way is not an available action.

**Nothing is dispatched without a keystroke.** The commander proposes; you approve. Everything it
raises goes through the gate `army campaign` uses — the same code, so the same independent
Inspector briefed from the objective and the branch, the same durability, the same ceiling clamp.
`--rung` sets a maximum for the session and is itself clamped; it can lower, never raise.

**Ctrl-C stops the turn, not the session.** The interrupt is a control message on stdin rather
than a signal, so an answer in flight aborts in milliseconds and the same session takes your next
line. During a dispatch it refuses instead, and says why: only the campaign's own cleanup can
settle a lease, and abandoning one mid-flight is how a worktree leaks. A second Ctrl-C, or
Ctrl-D, exits.

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

```
* add a multiply function to calc.js - 2026-08-03-add-a-multiply-function-to-calc-js - done
  2 tasks - 2 attempts - ranks CPT - depth 1-1 - busy 0 idle 0 unknown 0 dead 2

UNIT                      RANK  DEPTH  GAP  STATE      WHY                   DOING              WHEN
`- > add a multiply f...  -         -    -  done       -> cpt-01             army/t-b5ad...   9s ago
   |- o CPT.ENGINEER ...  CPT       1   -1  dead       agent-row:exited      exited, exit 0   1m ago
   `- > review army/t...  -         -    -  done       -> cpt-02             army/t-b5ad...   9s ago
      `- o CPT.INSPEC...  CPT       1   -1  dead       agent-row:exited      exited, exit 0   9s ago

  read-only - source files - 2026-08-03T02:51:15.930Z
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
strictly junior to it; it is not derived from depth. A `GAP` of `-1` above is normal — a General
detaching a Captain directly skips two ranks. A *positive* gap is the anomaly, and gets a `!`.

## `army rebuild`

Throws `campaign.db` away and puts it back from `campaign.json`, `tasks.jsonl`, `signals.jsonl`,
`agents/*/agent.json` and `agents/*/stream.jsonl`. It never reads the existing database, so
anything that comes back was really on disk:

```sh
army rebuild                # every campaign in the archive
army rebuild <campaign-id>  # one
```

```
2026-08-03-add-a-multiply-function-to-calc-js  tasks 2  agents 2  signals 9  events 55
```

It exits 1 if rows were present in the files but did not make it into the index, and names every
one of them.

## Where things live

```
~/.agentic-army/
  config.toml                      # ceilings + dispatch rules + hooks. Yours to edit.
  campaigns/<date>-<campaign>/
    campaign.db                    # the INDEX: agents, tasks, signals, timings, cost
    campaign.json                  # truth. campaign.db is rebuilt FROM these, never the reverse
    tasks.jsonl  signals.jsonl     # truth
    agents/cpt-01/
      agent.json                   # truth
      orders.md  report.json  report.md  stream.jsonl  diff.patch
  mirrors/<basename>-<hash>.git    # durability when a project has no remote

~/.agentic-army-trees/             # the leased worktree pool, created on first use
  trees/<project>-<hash>/wt-01/    # one leased worktree per slot
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

Reports never land in your repositories. `AGENTIC_ARMY_HOME` relocates this whole directory,
including every ceiling in it — it is read from your own environment at startup, and a
supervisor must never accept it from a worker.

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

**Run, and the output is what you see above:** `doctor` (fully ok, and again with `codex`/`gh`
removed from `PATH` and `ANTHROPIC_API_KEY` set, to see all three degradations and exit 0);
`init`, twice, for the idempotence claim; `enlist`, and `enlist --ceiling 2` and `--ceiling 3`
non-interactively to see the refusal and the exact config line it prints instead; `campaign`,
end to end, Engineer through Inspector to durability; `chat`, against real claude and codex —
one objective proposed, approved at the prompt, dispatched through the gate to a rung-0
delivery, plus the refusal when the commander was asked to read a file, and a live interrupt
mid-answer; `view`, `view --list`, `view --source db`,
`view --follow`; `rebuild`. The `army` spelling in the first column of
[First run](#first-run) was checked too, against a built `dist/` on `PATH`, because the claim
that suggestions match your invocation is only interesting if it holds in more than one form.

**Implemented but NOT exercised here, so take the description and not a demonstration:**

- **Delivery rungs 1, 2 and 3 through `army campaign`.** Only rung 0 was run that way. Push,
  pull request and merge need a real remote and a `gh` login against one, which a throwaway repo
  does not have.
- **Rung 3 against a real host.** The merge rung is exercised in `test/delivery.test.ts` against
  local infrastructure only: real repositories, a real bare repo standing in for `origin`, a real
  durability push, the real allow-list on every argv, and a stand-in `gh` executable on disk that
  performs the merge by moving the bare repo's `main`. So "it merged" is a fact about a
  repository on this machine, and the gates, the argv, the idempotence and the reporting are all
  demonstrated. What is NOT demonstrated: that the real `gh` accepts these flags, and that
  GitHub's branch protection refuses the way the stand-in does. Those two remain code claims.
- **The retry path.** The Inspector passed on attempt 1, so no second Engineer was fielded.
- **Raising a ceiling from a real TTY.** Only the non-interactive refusal was observed.
- **Windows.** Untested, and never claimed otherwise. Paths are built with `node:path` and the
  glyph set falls back to ASCII on a codepage-437 console, but neither has been run there.

## License

MIT
