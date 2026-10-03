/**
 * Drafts a flow from your objective and your answers to a few multiple-choice questions.
 *
 * Each call is one turn with a fresh model conversation that gets the objective and every answer
 * so far. The model replies with one JSON object at the end of its message: either the next
 * question or the flow. A flow comes back as a compact spec, which this file turns into a real
 * Flow with defaults filled in, fresh ids and a tidy layout, and checks with `validateFlow`. When
 * the checks find problems, the model gets them back and two tries to fix them.
 *
 * The model call arrives as `ask`, so the tests drive this file with a fake and the app drives it
 * with `runAgent`.
 */

import { defaultNodeData, newId, slug, validateFlow, type FlowProblem } from '../shared/flow.ts';
import { MAX_DRAFT_QUESTIONS, YOU_PICK, type DraftOption, type DraftReply, type DraftRequest } from '../shared/draft.ts';
import { AGENT_ROLES, EFFORTS, NODE_TYPES, outputHandles, ROLE_INFO, type Flow, type FlowEdge, type FlowNode, type NodeType } from '../shared/types.ts';

export type Ask = (prompt: string, instructions: string, signal: AbortSignal) => Promise<string>;

/** What the model may refer to: the models in Settings and the flows a Run flow node can start. */
export interface DraftContext {
  models: { id: string; label: string; description?: string }[];
  flows: { id: string; name: string; description: string }[];
}

/** How many times the model may try again after a draft the checks reject. */
const MAX_REPAIRS = 2;

// ------------------------------------------------------------------------------------------------
// What the model is told
// ------------------------------------------------------------------------------------------------

const roleLines = AGENT_ROLES.map((r) => `- ${r}: ${ROLE_INFO[r].summary}`).join('\n');

/**
 * The first line is how the e2e suite's fake claude knows it is being asked to draft a flow, so it
 * stays as it is.
 */
export const DRAFTER_INSTRUCTIONS = `You draft flows for Agentic Army, a desktop app that runs teams of AI agents.

A person has told you what they want a flow to do. You ask them short multiple-choice questions, one at a time, until you know enough, and then you write the flow. You do not do the work yourself, read files or run anything. Your whole job is the questions and the flow.

# What a flow is

A flow is a graph of steps. A run starts at the Start node with the person's message as its objective. Each node runs when a connection delivers work to it, and the upstream node's output becomes its input. A node finishes on one of its outputs (handles), and every connection leaving that handle delivers onward. Several connections from one handle run in parallel. A connection that points back to an earlier node makes a loop; the node's maxVisits ends a loop that never converges. When work reaches a node that has already run maxVisits times, the run stops as failed by itself. No handle fires for that, so a loop needs no End for running out of tries. A path whose handle has nothing connected stops the run there as failed, so connect every handle that can happen. A run that reaches an End node finishes with the End's template as its result. Every node except Start needs a connection into it, or it never runs.

A flow runs when someone starts it: the person, Jev picking it for a message, or a chat agent. There are no schedules, triggers or events, so never ask how often a flow should run and never promise that it will run on its own.

# Node types

Each node has "id", "type" and "label" (a short name, unique in the flow). Make each id the label's template name (see Templates), so "Run tests" gets the id "run_tests". The other fields depend on the type. Leave a field out to get its default.

start
  Fields: none. Exactly one per flow.
  Handles: out. Output: the objective.

agent: Claude or Codex working with a role.
  role: one of the roles below. Default engineer.
  prompt: what the agent is told, a template. Required.
  workspace: "run" (its own git branch, for changes) or "project" (the person's folder, for reading). Default run.
  keepContext: true continues the same conversation on a second visit, for a fix loop. Default false.
  maxVisits: how many times it may run, default 3.
  web: true lets it search the web itself. Default: only a scout can.
  modelId: null uses the role's default model. Set a model id only when the person asked for that model.
  effort: null, or one of ${EFFORTS.join(', ')}. Leave null unless the person asked.
  Handles: out, error (the agent crashed). Output: its final reply.

decide: Jev, a fast judgment model, answers a question about the input and picks a path. Use it to route on a judgment ("did the review approve?", "is this a bug or a feature?"), never for work.
  mode: "yesno", "choice" or "score". Default yesno.
  question: the question, a template. Required.
  state: what Jev reads, a template. Default {{input}}.
  threshold: yesno only, the probability of yes at or above which it says yes. Default 0.5. Use 0.6 to 0.7 for "is it good enough".
  options: choice only, [{ "key": "bug", "description": "Something is broken" }, ...]. Keys use letters, digits, - and _. At least two.
  levels: score only, ordered names lowest first, like ["Poor", "Acceptable", "Good"]. cut: the level index at or above which it says high.
  minConfidence: above 0 adds an "unsure" handle taken when Jev is less sure than this. Default 0.
  maxVisits: default 5.
  Handles: yesno gives yes, no. choice gives one handle per option key. score gives high, low. Plus unsure when minConfidence > 0.
  Output: its input, unchanged. A decision routes the work, it does not replace it.

human: the run pauses for the person to approve or reject. Use it before anything risky or hard to undo, and where the person wants a say.
  prompt: what the person reads, a template. Default "Review this before the flow continues." plus the input.
  Handles: approve, reject. Output: its input, plus the person's note if they wrote one. A rejection with a note can loop back so an agent fixes what the person said.

shell: runs a command.
  command: the shell command, a template. Required.
  workspace: "run" or "project". Default run.
  timeoutSec: default 600. maxVisits: default 5.
  Handles: pass (exit code 0), fail. Output: the command, its exit code and what it printed.

git: works on the run's branch.
  action: "diff" (show the changes), "commit" (commit the run branch) or "merge" (merge the run branch into the person's checkout). Default commit.
  message: the commit message, a template.
  askBeforeMerge: a merge shows the person what would merge and waits for approval. Default true.
  Handles: out, fail. Output: the diff for diff, otherwise its input.

search: Jev searches the web, opens the likeliest pages and picks the passages that answer.
  query: what goes to the search engine, a template. Required. Default {{input}}.
  question: what the passages must answer. Empty means the query.
  threshold: how sure Jev must be that the pages answer, default 0.5.
  Handles: found, unanswered. Output: the passages with their links.

browser: Jev drives a web page, clicking and typing, to reach a goal.
  goal: what to get done, a template. Required.
  startUrl: where to begin, a template.
  maxSteps: default 12. guard: true asks Jev whether each action is risky and pauses for the person when it is.
  Handles: done, failed. Output: what it found or did.

flow: runs another of the person's flows as one step.
  flowId: the id of a flow listed below. Required.
  objective: the child run's objective, a template. Default {{input}}.
  Handles: done, failed. Output: the child run's result.

join: waits until every node connected into it has finished, then fires once.
  Handles: out. Output: every input, each under its node's name.

end: finishes the run.
  template: the run's result, a template. Default {{input}}.
  outcome: "success" (default), "failure" or "stopped". Use failure for an End on a failure path, like tests that never passed, and stopped for one the person rejected.
  Handles: none.

# Roles for agent nodes

${roleLines}

Only an engineer can change files. Give an engineer workspace "run" so its changes land on the run's own branch. Scouts and planners usually read the person's folder with workspace "project". A reviewer or validator that checks an engineer's work needs workspace "run" to see the changes.

# Templates

Prompts, questions, commands, messages and End templates are templates:
- {{objective}}: what the person asked for when the run started.
- {{input}}: what the previous node passed on.
- {{visit}}: which time this node is running, 1 on the first.
- {{branch}}: the run's git branch, once it has one.
- {{nodes.<name>}}: the last output of any node, where <name> is its label in lower case with every run of other characters turned into _ ("Run tests" becomes nodes.run_tests). It names the node by its label, never by anything else. Empty until that node has run, so a loop's first pass reads cleanly.

Write real prompts: say what the agent should do with its input and what to end its reply with. A reviewer should end with a clear verdict, so a decide node can read it.

# Patterns

- Review loop: engineer, then reviewer, then a yesno decide asking whether the review approves; "no" goes back to the engineer, which has keepContext true and reads {{nodes.<reviewer>}}. Set maxVisits on the loop's nodes to the number of tries.
- Test loop: engineer, then a shell running the tests; "fail" goes back to the engineer with the output in {{nodes.<tests>}}.
- Approval: a human node before a merge, a deploy or anything hard to undo. "reject" either loops back with the note or goes to an End with outcome stopped.
- Routing: a choice decide early on, one path per kind of request.
- Parallel work: one handle connected to several nodes, then a join.
- Failure paths: a fail, reject or no handle connected to an End with outcome failure, and a template that says what went wrong. Add such an End only where a handle leads to it.

# A worked example

The person wants to fix a bug with tests and a review. A good flow:
{"kind":"flow","name":"Fix with tests","description":"A bug fixed on its own branch: an engineer writes a failing test and the fix, the tests run, and a reviewer checks the change before it is done.","summary":"An engineer fixes the bug on a branch and runs the tests until they pass, three tries at most. A reviewer then checks the change, and Jev sends it back when the review asks for changes.","nodes":[{"id":"start","type":"start","label":"Start"},{"id":"fix","type":"agent","label":"Fix","role":"engineer","workspace":"run","keepContext":true,"maxVisits":3,"prompt":"Fix this bug: {{objective}}\\n\\nAttempt {{visit}}. Write a failing test first, then make it pass.\\n\\nTest output from the last attempt, if any:\\n{{nodes.tests}}\\n\\nReviewer findings to fix, if any:\\n{{nodes.review}}\\n\\nEnd with the cause and what you changed."},{"id":"tests","type":"shell","label":"Tests","command":"npm test","maxVisits":3},{"id":"review","type":"agent","label":"Review","role":"reviewer","workspace":"run","prompt":"The bug: {{objective}}\\n\\nThe engineer says:\\n{{nodes.fix}}\\n\\nReview the change and run the tests. List every problem with file and line. End with APPROVED or CHANGES NEEDED."},{"id":"review_passed","type":"decide","label":"Review passed","mode":"yesno","question":"Does this review approve the change, with nothing left that must be fixed?","threshold":0.6,"maxVisits":3},{"id":"done","type":"end","label":"Done","template":"Fixed on {{branch}}.\\n\\n{{nodes.fix}}"}],"edges":[["start","out","fix"],["fix","out","tests"],["tests","pass","review"],["tests","fail","fix"],["review","out","review_passed"],["review_passed","yes","done"],["review_passed","no","fix"]]}

# How to ask

- One question per reply. Start broad: what kind of work this is, and what done looks like. Then narrow: who reviews or approves, which command runs the tests, what happens when something fails, which model where the person cares.
- Give 2 to 5 concrete options, the likeliest first. Each option label is a few words; put any explanation in its detail.
- Do not offer "Other", "Something else" or "${YOU_PICK}" as an option. The app always shows a box for an answer in the person's own words and a ${YOU_PICK} button.
- Set "multi" to true only when several options can sensibly apply together.
- Read the objective as answers already given. If it names the test command, a review or an approval, do not ask about it again.
- Ask about what the person wants: the kind of work, who checks it, what needs their approval, what happens on failure. Never ask about settings such as workspace, keepContext, maxVisits, thresholds or effort; pick those yourself.
- Questions not to ask: "What command runs your tests?" when the objective says "run npm test". "How many tries before giving up?" (pick three). "Should the engineer keep its context?" (yes, in a fix loop). "How often should this run?" (flows have no schedule).
- Usually 3 to 6 questions are enough. Stop as soon as the flow is clear.
- An answer of "${YOU_PICK}" means the person left it to you: choose the likeliest option.
- "understanding" is a short paragraph, two or three sentences, saying what you know so far about the flow you will build. Write it to the person, plainly.

# Your reply

Write at most a sentence or two of thinking if you need it, then end your message with exactly one JSON object and nothing after it. Either a question:

{"kind":"question","question":"What should happen when the tests fail?","why":"This decides whether the flow loops or stops.","options":[{"label":"Try again","detail":"Send the output back to the engineer, up to three times"},{"label":"Stop and tell me"}],"multi":false,"understanding":"You want a bug fixed on its own branch, with a test that proves it."}

or the flow:

{"kind":"flow","name":"...","description":"...","summary":"...","nodes":[...],"edges":[[from, handle, to], ...]}

In the flow, "name" is a few words in sentence case. "description" says what kind of work the flow is for, in one or two sentences; other agents read it when they choose a flow. "summary" is two to four sentences to the person on what you built and why. Each edge is [source node id, handle, target node id], and the handle must be one the source node has. Write plain JSON: double quotes, no comments, no trailing commas.`;

/** The models and flows the model may use, as text for the prompt. */
function contextText(ctx: DraftContext): string {
  const lines: string[] = [];
  if (ctx.models.length > 0) {
    lines.push('Models in Settings, for an agent\'s modelId when the person asks for one:');
    for (const m of ctx.models) lines.push(`- ${m.id}: ${m.label}${m.description === undefined ? '' : `. ${m.description}`}`);
  }
  if (ctx.flows.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Flows the person already has, for a Run flow node:');
    for (const f of ctx.flows) lines.push(`- ${f.id}: ${f.name}. ${f.description.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  return lines.join('\n');
}

/** Whether this request must end in a flow: you pressed "Build it now", or the questions ran out. */
export function mustFinish(req: DraftRequest): boolean {
  return req.finish === true || req.answers.length >= MAX_DRAFT_QUESTIONS;
}

/** The turn's message: the objective, every question and answer so far, and what to do next. */
export function draftPrompt(req: DraftRequest, ctx: DraftContext = { models: [], flows: [] }): string {
  const parts = [`The person's objective:\n${req.objective.trim()}`];
  if (req.answers.length === 0) parts.push('No questions asked yet.');
  else {
    const qa = req.answers.map((a, i) => `${String(i + 1)}. Q: ${a.question}\n   A: ${a.answer}`).join('\n');
    parts.push(`Questions asked so far, with the person's answers:\n${qa}`);
  }
  const known = contextText(ctx);
  if (known !== '') parts.push(known);
  if (req.finish === true) parts.push('The person pressed "Build it now". Draft the flow now from what you know, choosing sensibly where they did not say. Do not ask another question.');
  else if (req.answers.length >= MAX_DRAFT_QUESTIONS) parts.push(`That is ${String(MAX_DRAFT_QUESTIONS)} questions, the most there may be. Draft the flow now. Do not ask another question.`);
  else parts.push('Ask your next question, or draft the flow if the answers already settle it.');
  return parts.join('\n\n');
}

// ------------------------------------------------------------------------------------------------
// Reading the reply
// ------------------------------------------------------------------------------------------------

/**
 * The last balanced `{...}` in the text that parses as JSON, or null. Models wrap the object in a
 * code fence, or say a sentence after it, or both; this finds it either way. Braces inside JSON
 * strings are skipped, so a prompt with `{{input}}` in it does not throw the count off.
 */
export function lastJsonObject(text: string): unknown {
  const spans: [number, number][] = [];
  const open: number[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    // Quotes count only inside braces, so an apostrophe or a stray quote in the prose is harmless.
    if (c === '"' && open.length > 0) inString = true;
    else if (c === '{') open.push(i);
    else if (c === '}' && open.length > 0) spans.push([open.pop()!, i]);
  }
  // Latest end first, and for one end the widest first, so an object nested inside never wins.
  spans.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (const [from, to] of spans) {
    try {
      const v = JSON.parse(text.slice(from, to + 1)) as unknown;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* not this one */
    }
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export type ParsedReply =
  | Extract<DraftReply, { kind: 'question' }>
  | { kind: 'flow'; spec: Record<string, unknown> }
  | { kind: 'bad'; why: string };

export function parseReply(text: string): ParsedReply {
  const obj = lastJsonObject(text) as Record<string, unknown> | null;
  if (obj === null) return { kind: 'bad', why: 'Your reply did not end with a JSON object.' };
  const kind = obj['kind'] ?? (Array.isArray(obj['nodes']) ? 'flow' : 'options' in obj ? 'question' : undefined);
  if (kind === 'flow') {
    if (!Array.isArray(obj['nodes'])) return { kind: 'bad', why: 'The flow has no "nodes" list.' };
    return { kind: 'flow', spec: obj };
  }
  if (kind === 'question') {
    const question = str(obj['question']);
    const options: DraftOption[] = [];
    if (Array.isArray(obj['options'])) {
      for (const o of obj['options']) {
        const label = typeof o === 'string' ? str(o) : o !== null && typeof o === 'object' ? str((o as Record<string, unknown>)['label']) : null;
        if (label === null) continue;
        const detail = o !== null && typeof o === 'object' ? str((o as Record<string, unknown>)['detail']) : null;
        options.push(detail === null ? { label } : { label, detail });
      }
    }
    if (question === null) return { kind: 'bad', why: 'The question has no "question" text.' };
    if (options.length < 2) return { kind: 'bad', why: 'A question needs at least two options.' };
    // The window always offers its own "You pick" button and a box for your own words, and models
    // add those as options anyway.
    const own = options.filter((o) => !/^(you pick|other|something else)\b/i.test(o.label));
    return {
      kind: 'question',
      question,
      why: str(obj['why']) ?? '',
      options: (own.length > 0 ? own : options).slice(0, 6),
      multi: obj['multi'] === true,
      understanding: str(obj['understanding']) ?? '',
    };
  }
  return { kind: 'bad', why: 'The JSON object\'s "kind" must be "question" or "flow".' };
}

// ------------------------------------------------------------------------------------------------
// From the spec to a Flow
// ------------------------------------------------------------------------------------------------

const ENUMS: Record<string, readonly string[]> = {
  role: AGENT_ROLES,
  workspace: ['run', 'project'],
  mode: ['choice', 'yesno', 'score'],
  action: ['diff', 'commit', 'merge'],
  outcome: ['success', 'failure', 'stopped'],
};

/** Fields a node may have that its defaults leave out. */
const OPTIONAL: Partial<Record<NodeType, Record<string, 'boolean' | 'outcome'>>> = {
  agent: { web: 'boolean' },
  end: { outcome: 'outcome' },
};

const PROBABILITY = new Set(['threshold', 'guardThreshold', 'minConfidence']);
const COUNT = new Set(['maxVisits', 'maxSteps', 'timeoutSec', 'cut']);

/**
 * One node's fields: each one the spec gives that fits the default's type, and the default for the
 * rest. Anything the node type does not have is dropped.
 */
function nodeData(type: NodeType, raw: Record<string, unknown>, ctx: DraftContext): FlowNode['data'] {
  const base = defaultNodeData(type) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const [key, def] of Object.entries(base)) {
    if (key === 'label' || !(key in raw)) continue;
    const v = raw[key];
    if (key === 'modelId') {
      out[key] = typeof v === 'string' && ctx.models.some((m) => m.id === v) ? v : null;
    } else if (key === 'effort') {
      out[key] = typeof v === 'string' && (EFFORTS as readonly string[]).includes(v) ? v : null;
    } else if (key in ENUMS) {
      if (typeof v === 'string' && ENUMS[key]!.includes(v)) out[key] = v;
    } else if (key === 'options') {
      const opts = Array.isArray(v)
        ? v
            .map((o) => (o !== null && typeof o === 'object' ? { key: str((o as Record<string, unknown>)['key']), description: str((o as Record<string, unknown>)['description']) ?? '' } : null))
            .filter((o): o is { key: string; description: string } => o !== null && o.key !== null)
        : [];
      if (opts.length > 0) out[key] = opts;
    } else if (key === 'levels') {
      const levels = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
      if (levels.length > 0) out[key] = levels;
    } else if (typeof def === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      out[key] = PROBABILITY.has(key) ? Math.min(1, Math.max(0, v)) : COUNT.has(key) ? Math.max(key === 'cut' ? 0 : 1, Math.round(v)) : v;
    } else if (typeof def === typeof v) out[key] = v;
  }
  for (const [key, kind] of Object.entries(OPTIONAL[type] ?? {})) {
    const v = raw[key];
    if (kind === 'boolean' && typeof v === 'boolean') out[key] = v;
    if (kind === 'outcome' && typeof v === 'string' && ENUMS['outcome']!.includes(v)) out[key] = v;
  }
  if (type === 'decide' && typeof out['cut'] === 'number') out['cut'] = Math.min(out['cut'], (out['levels'] as string[]).length - 1);
  return out as unknown as FlowNode['data'];
}

/** `base`, or `base 2`, `base 3`... whichever no node has yet, compared the way templates name nodes. */
function uniqueLabel(base: string, taken: Set<string>): string {
  let label = base;
  for (let i = 2; taken.has(slug(label)); i += 1) label = `${base} ${String(i)}`;
  taken.add(slug(label));
  return label;
}

/** The fields of each node type that are templates, where `{{nodes.x}}` can appear. */
const TEMPLATE_FIELDS: Partial<Record<NodeType, string[]>> = {
  agent: ['prompt'],
  decide: ['question', 'state'],
  human: ['prompt'],
  shell: ['command'],
  git: ['message'],
  search: ['query', 'question'],
  browser: ['goal', 'startUrl'],
  flow: ['objective'],
  end: ['template'],
};

/**
 * Point `{{nodes.x}}` at the node the model meant. Templates name a node by its label, but models
 * write the spec's own id there (`{{nodes.update}}` for a node labelled "Update deps"), and those
 * ids are replaced, so a name no label has but a spec id does is changed to that node's label name.
 */
function rewriteNodeRefs(nodes: FlowNode[], ids: Map<string, string>): void {
  const labels = new Set(nodes.map((n) => slug(n.data.label)));
  const bySpecId = new Map<string, string>();
  for (const [specId, id] of ids) {
    const node = nodes.find((n) => n.id === id);
    if (node !== undefined) bySpecId.set(specId, slug(node.data.label));
  }
  const fix = (t: string) =>
    t.replace(/\{\{\s*nodes\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (all, name: string) => {
      if (labels.has(name)) return all;
      const to = bySpecId.get(name);
      return to === undefined ? all : `{{nodes.${to}}}`;
    });
  for (const n of nodes) {
    const data = n.data as unknown as Record<string, unknown>;
    for (const f of TEMPLATE_FIELDS[n.type] ?? []) if (typeof data[f] === 'string') data[f] = fix(data[f]);
  }
}

export interface SpecResult {
  flow: Flow;
  /** What was thrown away on the way: connections from a handle a node does not have, and the like. */
  dropped: string[];
}

export function specToFlow(spec: Record<string, unknown>, ctx: DraftContext = { models: [], flows: [] }): SpecResult {
  const dropped: string[] = [];
  const ids = new Map<string, string>();
  const nodes: FlowNode[] = [];
  const taken = new Set<string>();
  const rawNodes = Array.isArray(spec['nodes']) ? spec['nodes'] : [];
  for (const [i, item] of rawNodes.entries()) {
    if (item === null || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const type = raw['type'];
    if (typeof type !== 'string' || !(NODE_TYPES as readonly string[]).includes(type)) {
      dropped.push(`Node ${String(raw['id'] ?? i + 1)} has the type "${String(type)}", which does not exist, so it was left out.`);
      continue;
    }
    const specId = str(raw['id']) ?? `node${String(i + 1)}`;
    if (ids.has(specId)) {
      dropped.push(`Two nodes have the id "${specId}". The second was left out.`);
      continue;
    }
    const data = nodeData(type as NodeType, raw, ctx);
    const wanted = str(raw['label']);
    data.label = uniqueLabel(wanted !== null && slug(wanted) !== '' ? wanted : data.label, taken);
    const id = newId('n');
    ids.set(specId, id);
    nodes.push({ id, type, position: { x: 0, y: 0 }, data } as FlowNode);
  }

  rewriteNodeRefs(nodes, ids);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: FlowEdge[] = [];
  const rawEdges = Array.isArray(spec['edges']) ? spec['edges'] : [];
  for (const item of rawEdges) {
    let from: unknown, handle: unknown, to: unknown;
    if (Array.isArray(item)) [from, handle, to] = item as unknown[];
    else if (item !== null && typeof item === 'object') {
      const r = item as Record<string, unknown>;
      from = r['from'] ?? r['source'];
      handle = r['handle'] ?? r['sourceHandle'];
      to = r['to'] ?? r['target'];
    }
    const source = typeof from === 'string' ? ids.get(from) : undefined;
    const target = typeof to === 'string' ? ids.get(to) : undefined;
    if (source === undefined || target === undefined) {
      dropped.push(`The connection ${JSON.stringify(item)} names a node that is not in the flow, so it was dropped.`);
      continue;
    }
    const src = byId.get(source)!;
    const handles = outputHandles(src);
    if (typeof handle !== 'string' || !handles.includes(handle)) {
      const has = handles.length === 0 ? 'none, since an End finishes the run' : handles.join(', ');
      dropped.push(`"${src.data.label}" has no "${String(handle)}" output, so its connection to "${byId.get(target)!.data.label}" was dropped. Its outputs are: ${has}.`);
      continue;
    }
    if (edges.some((e) => e.source === source && e.sourceHandle === handle && e.target === target)) continue;
    edges.push({ id: newId('e'), source, sourceHandle: handle, target });
  }
  // Models add a "Tests never passed" End for a loop that runs out of tries, with nothing leading
  // to it: running out fails the run by itself. An End nothing connects into can never run, so it
  // goes, rather than sitting on the canvas as a warning a repair turn seldom clears.
  const reached = new Set(edges.map((e) => e.target));
  const kept = nodes.filter((n) => n.type !== 'end' || reached.has(n.id));
  nodes.splice(0, nodes.length, ...kept);

  const flow: Flow = {
    id: newId('flow'),
    name: str(spec['name']) ?? 'Drafted flow',
    description: str(spec['description']) ?? '',
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };
  layoutFlow(flow);
  return { flow, dropped };
}

// ------------------------------------------------------------------------------------------------
// Layout
// ------------------------------------------------------------------------------------------------

/** Columns as the built-in flows space them: a 200 wide node and a 60 gap. */
const COLUMN = 260;
const GAP = 40;

/** Near enough to the canvas's own node height: a header, two lines of subtitle, a row per output. */
function heightOf(node: FlowNode): number {
  return 72 + 22 * outputHandles(node).length;
}

/**
 * Left to right by distance from Start. Each node sits level with the node that first leads to it,
 * and a node's later outputs stack below its first, so the main path reads as a straight line and
 * branches fan downward. Loops are connections that point back and need no place of their own.
 */
export function layoutFlow(flow: Flow): void {
  const start = flow.nodes.find((n) => n.type === 'start');
  const depth = new Map<string, number>();
  /** The node and handle that first reached each node, which decides its place in the column. */
  const parent = new Map<string, { id: string; handle: number }>();
  if (start !== undefined) {
    depth.set(start.id, 0);
    const queue = [start.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const node = flow.nodes.find((n) => n.id === id)!;
      const handles = outputHandles(node);
      const out = flow.edges.filter((e) => e.source === id).sort((a, b) => handles.indexOf(a.sourceHandle) - handles.indexOf(b.sourceHandle));
      for (const e of out) {
        if (depth.has(e.target)) continue;
        depth.set(e.target, depth.get(id)! + 1);
        parent.set(e.target, { id, handle: handles.indexOf(e.sourceHandle) });
        queue.push(e.target);
      }
    }
  }
  // Nodes Start does not reach go in a column of their own past the rest, where they are easy to spot.
  const deepest = Math.max(0, ...depth.values());
  for (const n of flow.nodes) if (!depth.has(n.id)) depth.set(n.id, deepest + 1);

  const columns = new Map<number, FlowNode[]>();
  for (const n of flow.nodes) columns.set(depth.get(n.id)!, [...(columns.get(depth.get(n.id)!) ?? []), n]);
  const y = new Map<string, number>();
  const order = new Map<string, number>();
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    const col = columns.get(d)!;
    const want = (n: FlowNode) => {
      const p = parent.get(n.id);
      return p === undefined ? 0 : (y.get(p.id) ?? 0);
    };
    const key = (n: FlowNode) => {
      const p = parent.get(n.id);
      return p === undefined ? [Number.MAX_SAFE_INTEGER, 0] : [order.get(p.id) ?? 0, p.handle];
    };
    col.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka[0]! - kb[0]! || ka[1]! - kb[1]!;
    });
    let bottom = -Infinity;
    col.forEach((n, i) => {
      const top = Math.max(want(n), bottom + GAP);
      y.set(n.id, top);
      order.set(n.id, i);
      bottom = top + heightOf(n);
    });
  }
  for (const n of flow.nodes) n.position = { x: depth.get(n.id)! * COLUMN, y: Math.round((y.get(n.id) ?? 0) / 10) * 10 };
}

// ------------------------------------------------------------------------------------------------
// The conversation
// ------------------------------------------------------------------------------------------------

function problemLines(problems: FlowProblem[], dropped: string[], flow: Flow): string {
  const label = (id?: string) => flow.nodes.find((n) => n.id === id)?.data.label;
  return [...dropped, ...problems.map((p) => (p.nodeId === undefined || p.message.includes(`"${label(p.nodeId) ?? ''}"`) ? p.message : `${label(p.nodeId) ?? 'A node'}: ${p.message}`))]
    .map((m) => `- ${m}`)
    .join('\n');
}

/**
 * One step of the conversation: the next question, or the flow. A reply that cannot be read, a
 * question when a flow was due, and a flow the checks find problems in each get one more turn
 * with what was wrong, twice at most.
 */
export async function draft(req: DraftRequest, ask: Ask, opts: { signal: AbortSignal; context?: DraftContext; knownFlowIds?: ReadonlySet<string> }): Promise<DraftReply> {
  const ctx = opts.context ?? { models: [], flows: [] };
  if (req.objective.trim() === '') return { kind: 'error', message: 'Say what the flow should do first.' };
  const finish = mustFinish(req);
  const base = draftPrompt(req, ctx);
  let prompt = base;
  /** The draft with the fewest errors so far, kept in case no repair clears them all. */
  let best: { flow: Flow; summary: string; problems: FlowProblem[]; score: number } | null = null;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
    const text = await ask(prompt, DRAFTER_INSTRUCTIONS, opts.signal);
    const parsed = parseReply(text);
    if (parsed.kind === 'question' && !finish) return parsed;
    if (parsed.kind === 'flow') {
      const { flow, dropped } = specToFlow(parsed.spec, ctx);
      const problems = validateFlow(flow, new Set(ctx.models.map((m) => m.id)), opts.knownFlowIds ?? new Set(ctx.flows.map((f) => f.id)));
      const summary = str(parsed.spec['summary']) ?? '';
      // Errors stop the flow from running; warnings, like a node nothing leads to, are usually a
      // mistake too. Both go back for a repair, and an error weighs more when picking the best try.
      const score = 100 * (problems.filter((p) => p.level === 'error').length + dropped.length) + problems.length;
      if (best === null || score <= best.score) best = { flow, summary, problems, score };
      if (score === 0) break;
      prompt = `${base}\n\nYou drafted this flow:\n${JSON.stringify(parsed.spec)}\n\nThe app's checks found these problems:\n${problemLines(problems, dropped, flow)}\n\nFix them and reply with the whole corrected flow as one JSON object, in the same format.`;
      continue;
    }
    const why = parsed.kind === 'question' ? 'You asked another question, but the flow is due now.' : parsed.why;
    prompt = `${base}\n\nYour last reply could not be used. ${why} Reply again, ending with exactly one JSON object${finish ? ' for the flow' : ''}, in the format you were given.`;
  }
  if (best !== null) return { kind: 'flow', flow: best.flow, summary: best.summary, problems: best.problems };
  return { kind: 'error', message: `The AI answered ${String(MAX_REPAIRS + 1)} times without a question or a flow the app could read. Try again, or pick another chat model in Settings.` };
}
