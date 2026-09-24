# Agentic Army, the desktop app

A Mac app for working with claude and codex in your projects. The left side lists projects and their
sessions, like Codex or T3 Code. A session is a thread: you can chat with one agent in the project
folder, or send the message to a flow, which is a team of agents wired together on a canvas.

The app drives the `claude` and `codex` command-line tools you are already logged in to. It never
asks for an Anthropic or OpenAI key. Jev, TypeSafe's fast judgment model, makes the quick calls
between agents and drives the browser node; it needs a TypeSafe key.

## Running it

```sh
cd app
npm install
npm run dev        # the app, with hot reload of the window
npm run dist       # an unsigned app at release/mac-arm64/Agentic Army.app
```

The built app is not signed. The first time, open it with right-click, Open. It reads your login
shell's PATH at startup, so an app opened from the Dock finds `claude`, `codex` and `git` the same
way your terminal does.

Settings holds the TypeSafe key. If `TYPESAFE_API_KEY` is set in the environment the app starts
from, the key is filled in from it.

Everything the app keeps lives in `~/Library/Application Support/agentic-army-app/army`: settings,
projects, sessions, flows and runs as JSON files. Set `ARMY_APP_HOME` to use another folder; the
window's own storage moves with it, so two homes never share state.

## Sessions

Each message goes where the picker under the box says:

- **Chat** sends it to one agent in the project folder, on the model, effort and permission you
  pick. "Can edit files" runs it as an engineer; "Read only" runs it as a scout, which can read
  and search the web but change nothing. A chat remembers the conversation across turns and across
  restarts: the next turn resumes the same claude or codex conversation. Changing the model starts
  a fresh one.
- **Auto** asks Jev which fits: a chat, or one of your flows, judged from each flow's
  description. A notice in the thread says what it picked and how sure it was. Below 0.4
  confidence it stays a chat.
- **A flow** runs the flow with your message as its objective.

Stop, next to the send button, stops everything running in the session. Quitting the app while
agents work asks first, then stops them and kills their processes.

## Flows

A flow is a graph. A node runs each time a connection delivers to it, with the previous node's
output as its input, and leaves by one of its outputs. Several connections from one output run in
parallel. A connection that points back is a loop, and each node's visit limit is what ends a loop
that never settles.

| Node | What it does | Outputs |
|---|---|---|
| Start | The run begins here with your message. | out |
| Agent | claude or codex with a role, a model and a prompt. | out, error |
| Jev decision | Asks Jev a yes/no, choice or score question about its input, and leaves by the answer. The input passes through unchanged. | yes/no, each option, or high/low; plus unsure when a confidence floor is set |
| Your approval | Pauses the run and shows you the text, with Approve and Reject. A note you add travels on with the work, so a rejection can say what to fix. | approve, reject |
| Command | Runs a shell command in the run's branch or the project folder. Exit 0 is pass. | pass, fail |
| Browser | A Chromium window that Jev drives toward a goal, with a guard on risky actions. | done, failed |
| Git | Shows the diff, commits the run branch, or merges it into your branch. | out, fail |
| Join | Waits until every node connected into it has delivered, then passes all their outputs on together. | out |
| End | The run's result, from a template. | none |

Prompts are templates. `{{objective}}` is your message, `{{input}}` is what the previous node passed
on, `{{visit}}` counts visits to this node, `{{branch}}` is the run's branch, and
`{{nodes.<name>}}` is the last output of any node, by its name in lowercase with underscores.

### Roles and permissions

An agent node's role decides what it may touch. The allow-list and deny-list come from the same
tables the CLI's campaigns use (`src/command/permissions.ts`), so nothing here is a second copy of
the rules.

| Role | Holds | Runs as |
|---|---|---|
| Scout | Read, Grep, Glob, WebFetch, WebSearch | CAPTAIN·SCOUT |
| Planner | Read, Grep, Glob, TodoWrite. No shell, no edits. | MAJOR·OVERSEER |
| Engineer | Edits and a shell | CAPTAIN·ENGINEER |
| Reviewer | Read and the test runners. No edits. | CAPTAIN·INSPECTOR |
| Validator | Read and the test runners. No edits. | CAPTAIN·VALIDATOR |

Every role is denied your credentials (`~/.ssh`, `~/.aws`, `.env` files, keys) and the army's own
home, `~/.agentic-army`. Settings chooses how tightly the shell is scoped: any command in the role,
or only the listed ones.

### Models at each stage

Settings lists every model a node can use; add one when a vendor ships a new model. "Models at each
stage" says which model each role gets when a node does not name its own. Change the Reviewer stage
to a different model and every flow that uses the default follows.

### Workspaces

A node that writes works on the run's own branch, `army/run-<id>`, in a worktree cut from your last
commit. Your checkout is untouched until you merge, from the run's Changes tab or with a Git node.
When the run ends, what is left in the worktree is committed to the branch and the worktree is
removed; a branch with nothing on it is deleted. Uncommitted changes in your project are not in the
run's copy, and the thread says so when there were some.

### Flows that ship with the app

- **Build and review** is the main flow from `docs/main-flow.md` as nodes. A scout reads the code,
  a planner writes a plan you approve (or reject with a note, which goes back to the planner), an
  engineer builds it, a codex reviewer checks it, and Jev sends it back to the engineer until the
  review passes. A validator judges the result against your objective, and you sign off.
- **Quick fix** is the same without planning.
- **Look it up on the web** sends the Jev browser to search, then a scout answers from the page.
- **Triage with Jev** has Jev sort a request into a bug, a feature or a question, and asks you
  when it is not sure.

Editing one saves your own version in its place; Reset brings the original back.

## Jev in the app

Jev returns probabilities over answers you define; it writes no text. The app uses it where a
program needs a judgment rather than prose:

- **Decision nodes.** A yes/no answer is yes at or above the node's threshold. A choice leaves by
  the option Jev picked. A score leaves by high at or above the cut level. With a confidence floor
  set, an unsure answer takes its own output, for example to your approval.
- **Auto routing.** One choice question over "chat" and every flow's description.
- **The browser.** Each step, the page becomes a closed list of actions: click this link or
  button, type this phrase into that box, scroll, go back, stop. Jev picks one, and a second
  question asks whether the goal is already met. Typing is limited to phrases taken from the goal,
  quoted or after words like "search for", because Jev picks and does not write.
- **The guard.** Before each click or keystroke, Jev rates whether it could spend money, delete,
  send, post, change account settings or hand over a password. At or above the node's threshold
  the run pauses and asks you. The browser runs in its own session, with no access to the app or
  to your Chrome profile.

A flow that uses Jev will not start without a key, rather than fail halfway through.

## Testing

```sh
npm test           # the flow engine, Jev client, browser pilot and permissions: 29 tests, no network
npm run e2e        # builds, then drives the real app window with Playwright: 7 tests
ARMY_E2E_PACKAGED=1 node --test e2e/app.test.ts   # the same 7 against the built .app
```

The end-to-end tests launch the app against a throwaway home and project, the engine's fake
`claude` and `codex` (`../test/fixtures`), and a fake Jev server. They cover a chat that resumes
after a restart, Stop, quitting without leaving agent processes behind, Quick fix to a merge, the
main flow's two approvals and its review loop, a rejected plan going back with its note, a Jev flow
refusing to start without a key, and a flow drawn on the canvas by dragging connections.

`e2e/live/` holds the runs against the real tools. They cost money and need you logged in:

```sh
npm run live:chat                       # two turns with claude; MODEL="GPT-5.5" for codex
TYPESAFE_API_KEY=... npm run live:flow  # Quick fix with claude, codex and Jev, then merge and npm test
TYPESAFE_API_KEY=... npm run live:jev   # the browser guard on a local shop page, and Auto routing
```

What those showed on 2026-09-24, with claude 2.1.281 and codex 0.154.0:

- A claude chat answered in about 4 s and its second turn quoted the first question back. A codex
  chat's second turn named the file the first asked about. Both resume paths work.
- Quick fix: claude added `multiply` and a test, codex reviewed it and ran the tests, Jev judged
  the review passed at 0.96 in 365 ms, and the merge left `npm test` at 2 of 2 on main. 57 s, $0.15.
- The web lookup found the npm page through search and a scout answered from it in 13 s, noting
  that two search snippets disagreed.
- The guard let "type kettle into the search box" through at 4% risk, stopped "Click Place order"
  at 93%, and the refusal ended the run without clicking.
- Auto kept "What does the README say?" as a chat and sent "Add a CONTRIBUTING.md ... and have it
  reviewed" to Quick fix at 0.79.
- The packaged app, started with PATH set to `/usr/bin:/bin` as the Dock would, found claude and
  completed two turns.

## What it does not do yet

- **Quitting stops the work.** Agents run inside the app, so a closed app means stopped flows.
  The app asks before quitting while anything runs, and a run that was cut off says so when you
  reopen it. Keeping agents alive without the window needs a separate background process.
- **The CLI campaign is a template, not a node.** "Build and review" has the campaign's shape, but
  not its held inspector tests or its question ladder. Those still live in `army campaign`.
- **The browser types only what the goal says.** It cannot fill a form with details it was not
  given, and it does not log in to sites.
- **Codex reports no cost** on a ChatGPT subscription, so codex turns show none.
- **No app icon and no signing.** The app uses Electron's default icon.

## Layout

```
src/shared/     types and flow rules both sides read (validation, templates)
src/main/       Electron main: the controller, the flow engine, agents, git, Jev, the browser
src/preload/    the bridge the window calls
src/renderer/   React: sessions, the run panel, the canvas editor, settings
test/           unit tests for the engine, Jev and the pilot
e2e/            Playwright tests of the real window, and e2e/live for runs against real tools
```

The app imports the engine from `../src` directly, with no copy: the claude and codex adapters,
the permission tables, and the army home resolution. `ARMY_DEBUG_AGENT=1` prints every agent event
to the main process's stderr.
