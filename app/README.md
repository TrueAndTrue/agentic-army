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
npm run dev          # the app, with hot reload of the window
npm run dist         # an unsigned app for Intel and Apple Silicon at release/mac-universal/Agentic Army.app
npm run install:mac  # builds it, copies it into /Applications, ad hoc signs it, and deletes the build copy so macOS knows one app
```

`npm run dist` takes about 15 s and never signs, even on a Mac with a Developer ID. The first time,
open the app with right-click, Open. It reads your login shell's PATH at startup, so an app opened
from the Dock finds `claude`, `codex` and `git` the same way your terminal does.
The app also looks in `~/.local/bin` (where Claude Code's installer puts
`claude`), `/opt/homebrew/bin` and `/usr/local/bin`.

On a Mac without them, Home lists what is missing with the command that installs each one, a
button that opens Terminal, and "Check again", which reads the shell's PATH again so a CLI you
just installed is found without a restart. The same help shows wherever the missing tool stops
you: under a chat reply that could not start, in Settings, and in the model pickers, which mark a
model "needs codex" when codex is not there. A flow checks before it starts, before it asks for a
Jev key: if one of its agent steps runs on a CLI this Mac lacks, or it works on a branch and the
folder is not a git repository with a commit, it does not start and the thread says which steps
and how to fix each one.

Settings holds the TypeSafe key and the optional Brave Search key. Both are encrypted in
`settings.json` with Electron's safeStorage, whose own key macOS keeps in your login Keychain. A
key an older version saved in the clear is encrypted the first time the new version starts. A key
the app cannot decrypt, say from a settings file copied off another Mac, counts as no key: the
log says so, and the usual "add a key" card and Settings field take over. The window never gets a
saved key, only the word that one is saved, and the main process tests and saves a new one. If
`TYPESAFE_API_KEY` is set in the environment the app starts from, it fills in a missing key.

Everything the app keeps lives in `~/Library/Application Support/agentic-army-app/army`: settings,
projects, sessions, flows and runs as JSON files. Set `ARMY_APP_HOME` to use another folder; the
window's own storage moves with it, so two homes never share state.

## Sessions

The sidebar lists each project's sessions newest first, by when you made them. Sending a message
does not move a row, so the list stays put under the cursor; the time beside each row is its last
activity.

Each message goes where the picker under the box says:

- **Chat** sends it to one agent in the project folder, on the model, effort and permission you
  pick. "Can edit files" runs it as an engineer; "Read only" runs it as a scout, which can read
  but change nothing. Either one searches the web through Jev (see "Web search with Jev" below),
  and the searches show in the reply with their queries. A read-only chat is told so, and asked for an edit it
  tells you to switch. A chat remembers the conversation across turns and across restarts: the
  next turn resumes the same claude or codex conversation. Changing the model starts a fresh one
  in the new CLI, so the app hands it the thread so far and says so in the thread.
- **Auto** asks Jev which fits: a chat, or one of your flows, judged from each flow's
  description. A notice in the thread says what it picked and how sure it was. Below 0.4
  confidence it stays a chat.
- **A flow** runs the flow with your message as its objective.

A chat message you send while the agent is still answering waits its turn. It shows dimmed at the
end of the thread, where you can edit or remove it, and goes out when the reply ends. A session
holds one queued message: sending again while one waits adds the new text to the end of it, and
the line above the box says so. If the reply fails, or you stop it, the queued message stays put
with Send now beside it. The main process keeps the queue with the session, so it survives the
window reloading and the app restarting. A flow, or a slash command, does not wait: it runs beside
the chat.

Stop, next to the send button, stops everything running in the session (Esc does the same).

Open run, on a run card, shows the run's map, steps and changes in a panel. In a window wider
than 1180 px it sits beside the thread. In a narrower one it lies over the thread but stops above
the message box, so you can keep writing while you read the run. The message box grows to fit its
text again whenever its width changes. Quitting the app while
agents work asks first, then stops them and kills their processes.

## Starting a flow

You can always start a flow yourself, three ways:

- Pick it in the picker under the message box, then type the objective.
- Type its command in the box: `/quick-fix add a multiply function`. Typing `/` lists the
  flows and Tab completes one. A message that starts with a path, like `/Users/me`, is not a
  command.
- Press Run on its card on the Flows page. That opens a new session with the flow picked.

Two others can start one, if you let them:

- **Jev in Auto.** Pick Auto in the picker and Jev chooses a chat or a flow for your message.
- **A chat agent.** A claude or codex chat gets a `start_flow` tool listing the flows it may
  use, with each one's description. When a run it started ends, it gets a short turn of its own
  to tell you how it went; that turn has no tool, so it cannot start another. claude sees an MCP
  tool only by name until it loads it, so the chat's system instructions (`--append-system-prompt`
  for claude, `developer_instructions` for codex) list the flows and say to start one rather than
  refuse, and not to start a flow just to look something up. The note never goes in front of your message: codex once quoted it back
  as "the first thing you asked".

Each flow has a "Who can start this" setting, in its side panel on the canvas:

| Level | You | Jev in Auto | A chat agent |
|---|---|---|---|
| Only you | yes | no | no |
| You, and Jev in Auto | yes | yes | no |
| Agents too, with your approval | yes | yes | asks first |
| Agents too, without asking | yes | yes | yes |

Settings, under "Starting flows", holds every flow to at most one level. Until you set it, the
limit allows everything, so each flow's own level decides. Lower it to rein in every flow at once:
at "with your approval" every agent request becomes a card, and at "Only you" chat agents do not
get the tool at all.

The agent is told to call the tool rather than ask in chat first. The card does the asking, and
an agent that also asked in chat made you answer twice.

When an agent asks, a card appears in the thread with its reason and the objective it wrote. You
can start it as asked, edit the objective first, or decline. Every run card says who started it:
Jev and how sure it was, the agent and whether you approved, or the flow that ran it.

An agent can have at most three flows running or waiting for approval in one session. The tool's
key works only during the chat turn it was issued for, so a copy of it found later starts
nothing.

A flow can also run another flow as a step with the **Run flow** node. You put that step in the
flow yourself, so it runs whatever the other flow's setting says. The other flow gets a run of its
own, on its own branch, shown in the same thread. Flows can run flows three deep, and a deeper one
fails instead of starting.

The built-in flows start as: Build and review and Quick fix at "with your approval", Look it up
on the web at "without asking", and Triage
with Jev at "You, and Jev in Auto".

## Flows

A flow is a graph. A node runs each time a connection delivers to it, with the previous node's
output as its input, and leaves by one of its outputs. Several connections from one output run in
parallel. A connection that points back is a loop, and each node's visit limit is what ends a loop
that never settles.

| Node | What it does | Outputs |
|---|---|---|
| Start | The run begins here with your message. | out |
| Agent | claude or codex with a role, a model and a prompt. "Can search the web" gives it Jev's `jev_search` and `read_page`; a scout has it unless you turn it off. | out, error |
| Jev decision | Asks Jev a yes/no, choice or score question about its input, and leaves by the answer. The input passes through unchanged. | yes/no, each option, or high/low; plus unsure when a confidence floor is set |
| Your approval | Pauses the run and shows you the text, with Approve and Reject. A note you add travels on with the work, so a rejection can say what to fix. | approve, reject |
| Command | Runs a shell command in the run's branch or the project folder. Exit 0 is pass. | pass, fail |
| Web search | Searches the web and has Jev pick the pages and the passages that answer. The output is those passages with their links. | found, unanswered |
| Browser | A page Jev clicks and types on toward a goal, with a guard on risky actions. For forms and sites that need clicking; a Web search step is the way to look something up. The window stays hidden unless you turn on "Show the browser window". | done, failed |
| Git | Shows the diff, commits the run branch, or merges it into your branch. A merge asks you first (see below). | out, fail |
| Run flow | Runs another flow with an objective from a template, waits for it, and passes its result on. | done, failed |
| Join | Waits until every node connected into it has delivered, then passes all their outputs on together. | out |
| End | The run's result, from a template. | none |

Prompts are templates. `{{objective}}` is your message, `{{input}}` is what the previous node passed
on, `{{visit}}` counts visits to this node, `{{branch}}` is the run's branch, and
`{{nodes.<name>}}` is the last output of any node, by its name in lowercase with underscores.

### Draft with AI

Draft with AI on the Flows page builds a flow from a conversation. You say what the flow should
do, and the model new chats start on asks one multiple-choice question at a time: who checks the
work, what needs your approval, what happens when the tests fail. Pick an option, type your own
answer, or press You pick to leave it to the model. Build it now skips the rest of the questions,
and after eight answers the model drafts the flow without being asked.

The draft shows on a read-only canvas with the model's summary. Nothing is saved until you press
Open in editor. Click an earlier answer to go back to that question; the answers after it are
dropped. Each turn is a fresh planner turn with no tools, run in an empty `drafts` folder in the
army home, with the objective and every answer so far in its prompt.

The model ends each reply with one JSON object, a question or a compact flow spec, and
`src/main/drafter.ts` turns the spec into a flow. It fills in defaults, gives the nodes new ids,
drops connections from outputs a node does not have, points `{{nodes.x}}` at labels when the
model used its own ids, and lays the nodes out left to right from Start. When the checks find
problems, the model gets them back and two tries to fix them. Whatever is left shows under the
draft for you to fix in the editor.

### A merge asks first

A Git node set to merge changes your checkout, so by default the run pauses with a card: the
branch, the branch it goes into, how many commits it brings and the files it changes, with Merge
and Do not merge. Do not merge leaves by the node's fail output, with your checkout as it was and
the work still on the run branch. A merge that cannot happen (your checkout is on another branch
or has uncommitted changes) fails without asking, and one that brings nothing does not ask.

The card does not show when the step right before the merge was one of your approvals, so you
never approve twice in a row. "Ask me before merging" in the node's panel turns the card off.
Flows saved before the setting existed ask. No built-in flow merges by itself; you merge those
from the run's Changes tab.

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
home, `~/.agentic-army`. Settings, under Permissions, chooses how far the shell reaches:

- **Any shell command in the role**, the default. Engineers and chats run any command, and codex
  agents have the network. claude's shell has no sandbox, so its commands run with your access.
- **Only listed shell commands.** The shell takes each role's listed commands only (git and the
  usual test, build and lint commands), and codex runs with `network_access=false`.

The default stays at any command because the listed-only setting breaks the built-in flows more
than it protects. Measured on 2026-10-02 with claude 2.1.287 and codex 0.154.0: a Haiku engineer
under the listed-only setting was refused `npm install` and `node -e`, and a GPT-5.5 reviewer
running `npm test` on a suite that opens a port got `EPERM listen`, where both passed under the
default. The Reviewer and Validator stages default to codex, so every Build and review and Quick
fix on such a project would fail review. It also does not stop a determined agent: an engineer
can edit `package.json` and `npm test` runs whatever it says. What does hold under both settings
is the deny list, the run's own branch, your approvals, and the merge card.

### Models at each stage

Settings lists every model a node can use. The claude models (Opus 5.5, Fable 5.1, Sonnet 5, Haiku
4.5) are built in. The codex models come from codex's own list in `~/.codex/models_cache.json`,
which codex refreshes itself, so GPT-6-Astra, GPT-5.6-Sol, GPT-5.6-Terra, GPT-5.6-Luna and GPT-5.5
all show up, and a model OpenAI ships later appears once codex has seen it. The app reads the list
at startup and when you press "Check for new models". A model you remove stays removed. You can
still add a model by hand.

Each model takes its own effort levels. codex lists them per model: Astra, Sol and Terra go up to
`ultra`, Luna to `max`, and GPT-5.5 stops at `xhigh` (codex rejects `max` on it). claude models take
`low` through `max`. The pickers offer only what the chosen model takes. If a saved level is above
what a model takes, the app sends the model's highest level, because a level the model does not
take fails the turn.

"Models at each stage" says which model each role gets when a node does not name its own. Change
the Reviewer stage to a different model and every flow that uses the default follows.

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
- **Look it up on the web** is a Web search step, then a scout that writes the answer from the
  passages with links. When Jev is less than 50% sure the pages answer it, the run ends as
  Failed and shows the closest passages. Nothing opens on your screen.
- **Triage with Jev** has Jev sort a request into a bug, a feature or a question, and asks you
  when it is not sure. A bug goes to a fix-and-test loop that sends failing tests back to the
  engineer, three times at most.

An End node says how a run that reaches it counts: Finished, Failed or Stopped. An output with
nothing connected ends the run as Failed and says which step went where, and the canvas warns
about such outputs before you run. A loop that runs out of visits names the decision that kept
sending the work back.

Editing one saves your own version in its place; Reset brings the original back.

## Jev in the app

Jev returns probabilities over answers you define; it writes no text. The app uses it where a
program needs a judgment rather than prose:

- **Decision nodes.** A yes/no answer is yes at or above the node's threshold. A choice leaves by
  the option Jev picked. A score leaves by high at or above the cut level. With a confidence floor
  set, an unsure answer takes its own output, for example to your approval.
- **Auto routing.** One choice question over "chat" and every flow's description.
- **Web search.** See the next section.
- **The browser.** Each step, the page becomes a closed list of actions: click this link or
  button, type this phrase into that box, scroll, go back, stop. Jev picks one, and a second
  question asks whether the goal is already met. Typing is limited to phrases taken from the goal,
  quoted or after words like "search for", because Jev picks and does not write.
- **The guard.** Before each click or keystroke, Jev rates whether it could spend money, delete,
  send, post, change account settings or hand over a password. At or above the node's threshold
  the run pauses and asks you. The browser runs in its own session, with no access to the app or
  to your Chrome profile.

## Web search with Jev

Agents search without a browser. A search is plain HTTP plus two Jev requests, and takes 1 to 2 s:

1. The app fetches a results page: DuckDuckGo's HTML page, then Brave's, then Bing's. An engine
   that returns fewer than 3 results is turning a program away (DuckDuckGo sends a challenge,
   Bing unrelated pages), so it is passed over and left alone for ten minutes. A Brave Search API
   key in Settings under Jev goes first and is never turned away.
2. Jev ranks the results with one Choice question, preferring primary sources, and the app opens
   the top three at once. A page that refuses gives way to the next result.
3. Every readable line of those pages, and the result snippets, gets an id like `P012`. One
   request asks a Choice question over the ids (which passage answers) and a Noul question (do
   these passages answer it at all). This is the line-search recipe from TypeSafe's cookbook.

The agent gets up to six passages in the pages' own words, each page's link, Jev's probability
that they answer the question, and the other results. Jev picks and does not write; the agent
writes the answer. `read_page` does step 3 for one page. Pages and results come through
Electron's own network stack in a session of their own: Brave refuses Node's HTTP/1.1 `fetch`
with a 429 and npmjs.com with a 403, and serves Chromium. Only public http and https pages are
read, never localhost or a private network.

Chats and agent steps get `jev_search` and `read_page` from the app's MCP server when there is a
working TypeSafe key. They keep their CLI's own search (claude's WebSearch, codex's
`web_search="live"`) and are told to use it only when `jev_search` says every engine turned it
away. Without a key, the CLI's own search is all they have. An agent step with "Can search the
web" off gets neither, and on codex that means `web_search="disabled"`, since `codex exec`
otherwise searches a cached index.

A flow that uses Jev will not start without a working key, rather than fail halfway through. The
app asks TypeSafe one small question to check a key it has not tried yet. With no key, or one
TypeSafe refuses, the thread shows a card where you paste a key; the app checks it, saves it and
starts the flow. That happens whoever started the flow: you, Jev in Auto, or a chat agent. A
refused key during a run fails the step with a message that says so; it never counts as Jev
being unsure.

Each decision shows on the run card as the step's name with Jev's answer, like "Review passed,
Jev: yes, 93% sure", and on the run map. The step in the run panel shows the question Jev was
asked, every probability, and the cutoff that turned them into a path.

## Code in replies

Code blocks are highlighted for ts, tsx, js, jsx, json, bash, sh, shell, python, go, rust, css,
html, yaml, toml, sql and markdown, in colours taken from the theme, so light and dark both work.
Diffs are coloured by line instead: added green, removed red, hunk headers blue. The grammars are
highlight.js's core and those languages only, about 155 kB (39 kB gzipped), in a chunk the window
loads the first time a reply has a code block. Each block is highlighted again only when its own
text changes, so a long reply streaming in redoes the block still growing and nothing above it.

## Tokens

The app runs on your claude and codex logins, so each reply and run shows the tokens it read and
wrote, and how much came from the cache: "26k in, 89% cached, 41 out". Hover for exact numbers and,
on claude, how full the context was after the last request. codex reports a running total for the
whole conversation, so the app subtracts the total it saw last turn. claude's dollar figure is
what the turn would cost at API prices; the app still saves it but no longer shows it.

## Logs and diagnostics

The main process writes `logs/main.log` in the app's home folder: when the app started (its
version, Electron, macOS), uncaught errors and rejected promises, a window renderer that crashed,
agents that failed to start or ended with an error, each run's end with its status, and Jev and
web search failures. It holds no keys, prompts, replies or file contents. Every line passes
through a redactor that removes the configured keys and anything shaped like one (`sk-...`,
bearer tokens, `api_key=...`). At 1 MB the file rotates to `main.1.log`, keeping three.

Settings, under Diagnostics, has "Copy diagnostics", which puts a plain-text report on the
clipboard: the app, Electron and macOS versions and the Mac's chip, claude's and codex's versions
and paths, whether a TypeSafe key is set and works, the permission setting, how many models,
projects, sessions and runs there are, and the last 200 lines of the log, redacted again. "Open
logs folder" opens the folder in Finder.

## Testing

```sh
npm test           # engine, Jev, web search, browser pilot, permissions, models, tokens, who may start a flow, how a run ends, updates, keys at rest, the log, setup help, sidebar order, drafting a flow with AI: 108 tests
npm run e2e        # builds, then drives the real app window with Playwright: 23 tests
ARMY_E2E_PACKAGED=1 node --test e2e/app.test.ts   # the same 23 against the built .app
ARMY_E2E_SHOW=1 npm run e2e                        # the same, with the window on screen
```

The test window stays hidden and out of the Dock, so a run does not take focus while you work.
The app does this when `ARMY_APP_HIDDEN=1`; it keeps painting, so screenshots still work. The
tests also set `ARMY_APP_MOCK_KEYCHAIN=1`, which encrypts keys with Chromium's stand-in Keychain,
so a test run never adds an item to your login Keychain.

The end-to-end tests launch the app against a throwaway home and project, the engine's fake
`claude` and `codex` (`../test/fixtures`), and a fake Jev server. They cover a chat that resumes
after a restart, Stop, quitting without leaving agent processes behind, Quick fix to a merge, the
main flow's two approvals and its review loop, a rejected plan going back with its note, a Jev flow
with no key asking for one in the thread (refusing a bad key, then starting with a good one), a flow drawn on the canvas by dragging connections, a flow drafted with AI through two
questions and opened in the editor, codex's model
list and per-model efforts, and every way to start a flow: a slash command, Run on the Flows page,
a chat agent asking and you editing and approving, an agent starting one without asking, an agent
given no tool when Settings says "Only you", and a Run flow node running Quick fix. Two more check
that a key saved in Settings is encrypted on disk and still works after a restart (with no key in
the diagnostics or the log), and that a Git merge step waits on its card, leaves the checkout
alone when you decline, and merges when you approve. In the agent
tests the fake claude starts the app's MCP server from `--mcp-config` and calls `start_flow` over
stdio, the same path real claude takes.

Five more cover the first run and the session view. One starts the app as a clean Mac would, with
`PATH=/usr/bin:/bin`, no login shell, an empty home folder and no CLIs, and checks that Home, a
chat reply and a flow each say how to install what is missing; then it puts a `claude` in
`~/.local/bin` and Check again finds it. The others check that sending in an older session leaves
the sidebar's order alone, that a message sent mid-reply is queued, edited, kept across a reload,
sent when the reply ends and held when one fails or is stopped, that code blocks are highlighted
in both themes, and that at 900 px wide the run panel leaves the message box clear. The hidden test
window does not resize, so that test narrows the page's viewport, which the layout follows the
same way.

`e2e/live/` holds the runs against the real tools. They cost money and need you logged in:

```sh
npm run live:chat                       # two turns with claude; MODEL="GPT-6-Astra" EFFORT=ultra for codex
TYPESAFE_API_KEY=... npm run live:flow  # Quick fix with claude, codex and Jev, then merge and npm test
TYPESAFE_API_KEY=... npm run live:jev   # the browser guard on a local shop page, and Auto routing
TYPESAFE_API_KEY=... npm run live:agent-flow  # a claude chat asks for Quick fix, is approved, reports back
```

Before a change to the app's look or wording ships, it goes through a dogfood pass: agents drive
the built app with real models, screenshot every state they reach, and report what looks broken
or confusing. The 2026-09-25 pass covered first run and setup, chat, and flows. It reported 72
findings, a few of them the same problem seen twice; this README describes the app after the fixes. On the same day, live:

- A Haiku chat read two files, added `multiply` with a test and ran it. The thread showed its three
  groups of tool calls between the sentences they belonged to. Switched to GPT-5.6-Luna, the chat
  quoted the first message back from the transcript the app handed over.
- "What is the latest version of zod on npm" through Look it up on the web: the browser clicked
  through from the results to npmjs.com and the scout answered "4.6.5" from the page, in 7 s.
  Before the fix it typed into DuckDuckGo's search box eight times and never searched.

On 2026-09-26 web lookups moved off the browser and onto Jev:

- Three searches through Electron's fetch took 1.5 to 2 s each, of which Jev took 0.3 to 0.4 s,
  and Jev was 96 to 97% sure each time. "Latest version of zod on npm" quoted npmjs.com's own
  "4.6.5 • Published 13 days ago".
- Look it up on the web answered the zod question in 12 s, with the npm page and the GitHub
  releases as sources, and pointed out the one site that still listed 4.5.4.
- Asked how long to roast peanuts, a Sonnet chat and a GPT-5.5 chat each ran one `jev_search`
  and answered with links, in 25 s and 16 s.
- After about fifteen searches in a few minutes DuckDuckGo answered with a challenge (HTTP 202)
  and Bing with one page about a 19th-century neurologist. That is why an engine with fewer than
  3 results is passed over, and why the Brave API key exists.

What the earlier runs showed on 2026-09-24, with claude 2.1.281 and codex 0.154.0:

- A claude chat answered in about 4 s and its second turn quoted the first question back. A codex
  chat's second turn named the file the first asked about. Both resume paths work.
- Quick fix: claude added `multiply` and a test, codex reviewed it and ran the tests, Jev judged
  the review passed at 0.96 in 365 ms, and the merge left `npm test` at 2 of 2 on main. 57 s, $0.15.
- The web lookup found the npm page through search and a scout answered from it in 13 s, noting
  that two search snippets disagreed.
- The guard let "type kettle into the search box" through at 4% risk, stopped "Click Place order"
  at 93%, and the refusal ended the run without clicking.
- A Sonnet 5 chat, asked to "start the right flow" for a multiply function, called `start_flow`
  for Quick fix with a specific objective and a one-line reason. After approval the run took 48 s
  and $0.22, and on the next turn Sonnet reported the branch and that 5 tests passed. codex
  (GPT-5.6-Luna) also calls the tool: codex needs its MCP tools marked approved, since `exec`
  cannot answer a prompt.
- Auto kept "What does the README say?" as a chat and sent "Add a CONTRIBUTING.md ... and have it
  reviewed" to Quick fix at 0.79.
- A chat on GPT-6-Astra at `ultra` answered in 12 s, and its second turn quoted the first question
  back.
- The same Sonnet chat, set to "Can edit files" and asked "Can you look up the best way to make
  peanut butter for me?", loaded `start_flow` and asked to run the web lookup, with an objective
  listing what to find. Before the chat was told about its flows, it tried WebSearch and gave up.
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
- **No update from a local build.** Only a signed release can update itself. See "Releasing".

## Updates

A released copy checks GitHub Releases 15 s after it starts and every six hours. It downloads a new
version in the background, and the sidebar shows "Version x is ready" above Flows. Restart installs
it; so does the next quit. Settings, under Updates, shows the version and the updater's status, and
has "Check for updates".

The updater stays off in `npm run dev`, when `ARMY_APP_HIDDEN=1` (the e2e tests), and in a build
whose feed is missing or still says `REPLACE_WITH_GITHUB_OWNER`. Settings says which. macOS installs
an update only over an app signed with a certificate, so a copy that is ad hoc signed or unsigned
still checks, but instead of downloading it says the new version is out and offers the download
page. The app tells the two apart by running `codesign -dv` on its own bundle
(`src/main/updateRules.ts`).

## Releasing

A release is a universal `.dmg` for people to download and a `.zip` the updater installs from, both
signed with a Developer ID, notarized by Apple and attached to a GitHub release with
`latest-mac.yml`.

What the owner has to get once:

1. Apple Developer Program membership at developer.apple.com. It costs $99 a year.
2. A **Developer ID Application** certificate. Create it in Xcode under Settings, Accounts, Manage
   Certificates, or on developer.apple.com, and keep it in the login keychain. For CI, export it as
   a `.p12` with a password. An "Apple Development" certificate will not do.
3. Your Team ID, from the Membership page.
4. An app-specific password for your Apple ID, from account.apple.com under Sign-In and Security.
   An App Store Connect API key works instead.
5. A GitHub token that can write releases to the repo: a fine-grained token with Contents read and
   write on that repo, or a classic token with `repo`.
6. The repo's owner. Replace `REPLACE_WITH_GITHUB_OWNER` under `build.publish` in
   `app/package.json` with the account or organization, and push the repo to GitHub as
   `agentic-army`. A private repo also works for publishing, but the app cannot read its releases
   without a token, so make it public or host releases in a public repo.

Then, for each release:

```sh
cd app
npm version 0.2.0 --no-git-tag-version   # the updater compares this version
export GH_TOKEN=...
export APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop APPLE_TEAM_ID=ABCDE12345
# or: export APPLE_API_KEY=/path/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=<issuer uuid>
# in CI, without the certificate in a keychain: export CSC_LINK=/path/cert.p12 CSC_KEY_PASSWORD=...
npm run release
```

`npm run release` first checks all of the above and stops with a list of what is missing. Then it
builds for Intel and Apple Silicon, signs with the hardened runtime and
`build/entitlements.mac.plist`, notarizes, and uploads to a draft release on GitHub. Publish the
draft on GitHub; copies already installed see it at their next check. With more than one Developer ID
in the keychain, pick one with `-c.mac.identity="Name (TEAMID)"`.

`npm run dist:release` makes the same `.dmg` and `.zip` in `release/` without publishing. It signs
and notarizes when the certificate and variables are there, and otherwise leaves the app unsigned.

The icon is `build/icon.svg`. After changing it, `npm run icon` renders `build/icon.png` and
`build/icon.icns`.

## Layout

```
src/shared/     types and flow rules both sides read (validation, templates)
src/main/       Electron main: the controller, the flow engine, agents, git, Jev, web search, the browser
src/preload/    the bridge the window calls
src/renderer/   React: sessions, the run panel, the canvas editor, settings
test/           unit tests for the engine, Jev and the pilot
e2e/            Playwright tests of the real window, and e2e/live for runs against real tools
```

The app imports the engine from `../src` directly, with no copy: the claude and codex adapters,
the permission tables, and the army home resolution. `ARMY_DEBUG_AGENT=1` prints every agent event
to the main process's stderr.
