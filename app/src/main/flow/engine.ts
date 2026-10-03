/**
 * Runs a flow graph.
 *
 * A node runs each time an edge delivers to it, with the upstream node's output as its input. A
 * node finishes on one of its output handles, and every edge leaving that handle delivers
 * onward. Several edges from one handle run in parallel. A Join waits until every node feeding
 * it has delivered, then fires once with all of their outputs. Loops are ordinary edges that
 * point backwards; each node's `maxVisits` is what ends one that never converges.
 *
 * Everything that touches the world (agents, Jev, the shell, git, the browser) arrives through
 * `EngineDeps`, so the tests drive this file with fakes and the app drives it with the real
 * adapters.
 */

import { renderTemplate, renderUrlTemplate, slug, validateFlow } from '../../shared/flow.ts';
import { addTokens } from '../../shared/tokens.ts';
import type {
  AgentConfig,
  AgentTurn,
  BrowserConfig,
  BrowserStep,
  DecideConfig,
  Flow,
  FlowNode,
  GitConfig,
  Judgment,
  NodeVisit,
  PendingQuestion,
  Run,
  TokenCount,
} from '../../shared/types.ts';

export interface AgentRequest {
  run: Run;
  node: Extract<FlowNode, { type: 'agent' }>;
  prompt: string;
  cwd: string;
  resume?: string;
  /** codex's running token total for the conversation being resumed. */
  tokensBefore?: TokenCount;
  signal: AbortSignal;
  onTurn(turn: AgentTurn): void;
}

export interface AgentResult {
  turn: AgentTurn;
  harnessSessionId?: string;
  harnessTokens?: TokenCount;
}

export interface BrowserRequest {
  run: Run;
  config: BrowserConfig;
  goal: string;
  startUrl: string;
  signal: AbortSignal;
  onStep(step: BrowserStep): void;
  /** Ask the person whether a risky action may run. Resolves false on refusal or stop. */
  ask(title: string, body: string): Promise<boolean>;
}

export interface SearchResult {
  /** The pages' own words, with links, as Markdown. */
  output: string;
  /** Jev's probability that the pages answer the question. */
  answered: number;
  model: string;
  latencyMs: number;
}

export interface EngineDeps {
  agent(req: AgentRequest): Promise<AgentResult>;
  judge(req: { config: DecideConfig; question: string; state: string; signal: AbortSignal }): Promise<Judgment>;
  shell(req: { command: string; cwd: string; timeoutMs: number; signal: AbortSignal }): Promise<{ code: number | null; output: string }>;
  /**
   * `ask` is set when a merge must be approved first: the git side shows what would merge and
   * resolves false on a refusal or a stop, the same way the browser guard asks.
   */
  git(req: { run: Run; config: GitConfig; message: string; signal: AbortSignal; ask?: (title: string, body: string) => Promise<boolean> }): Promise<{ ok: boolean; output: string }>;
  browser(req: BrowserRequest): Promise<{ ok: boolean; output: string }>;
  /** Search the web, with Jev picking the pages and the passages. */
  search(req: { query: string; question: string; signal: AbortSignal; onProgress(line: string): void }): Promise<SearchResult>;
  /**
   * Run another flow to its end, for a Run flow node, and say how it went. The child run is its own
   * run, with its own branch, and stops when this one does.
   */
  subflow(req: { run: Run; node: Extract<FlowNode, { type: 'flow' }>; objective: string; signal: AbortSignal }): Promise<{ ok: boolean; output: string; runId?: string }>;
  /** The run's own worktree, created the first time a node asks for it. */
  workspace(run: Run): Promise<string>;
  projectPath: string;
  /** How many nodes may run at once. */
  concurrency?: number;
}

export interface RunHandle {
  run: Run;
  done: Promise<Run>;
  stop(): void;
  answer(questionId: string, approve: boolean, text: string): boolean;
}

/** A node that nobody gave a limit still stops somewhere. */
const DEFAULT_MAX_VISITS = 20;

interface Activation {
  nodeId: string;
  input: string;
  /** The node and the output that sent the work here, to name the cause when a loop runs out. */
  from?: { node: FlowNode; handle: string };
  /** A Join's inputs: every node it waited for, and the output each left by. */
  joined?: { nodeId: string; handle: string }[];
}

interface Outcome {
  handle: string;
  output: string;
}

class NodeFailure extends Error {}

function maxVisitsOf(node: FlowNode): number {
  if (node.type === 'agent' || node.type === 'decide' || node.type === 'shell') return Math.max(1, node.data.maxVisits);
  return DEFAULT_MAX_VISITS;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createRun(input: {
  id: string;
  flow: Flow;
  sessionId: string;
  projectId: string;
  objective: string;
}): Run {
  const nodes: Run['nodes'] = {};
  for (const n of input.flow.nodes) nodes[n.id] = { status: 'idle', visits: [] };
  return {
    id: input.id,
    flowId: input.flow.id,
    flowName: input.flow.name,
    flow: structuredClone(input.flow),
    sessionId: input.sessionId,
    projectId: input.projectId,
    objective: input.objective,
    status: 'running',
    startedAt: nowIso(),
    nodes,
    costUsd: 0,
    pending: [],
  };
}

export function startRun(run: Run, deps: EngineDeps, onUpdate: (run: Run) => void): RunHandle {
  const flow = run.flow;
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const controller = new AbortController();
  const signal = controller.signal;
  const concurrency = Math.max(1, deps.concurrency ?? 4);

  /** Last output per node, under its id and its label slug, for `{{nodes.x}}`. */
  const outputs: Record<string, string> = {};
  const harnessSessions = new Map<string, string>();
  const harnessTokens = new Map<string, TokenCount>();
  const joinArrivals = new Map<string, Map<string, { output: string; handle: string }>>();
  const waiters = new Map<string, (answer: { approve: boolean; text: string }) => void>();
  const queue: Activation[] = [];
  const inFlight = new Set<Promise<void>>();
  let lastOutput = '';
  let endOutput: string | null = null;
  let endOutcome: 'success' | 'failure' | 'stopped' = 'success';
  /** The last output that led nowhere: the node and the handle it took. */
  let deadEnd: { label: string; handle: string } | null = null;

  const update = () => onUpdate(run);

  const fail = (message: string) => {
    if (run.error === undefined) run.error = message;
    controller.abort();
  };

  const problems = validateFlow(flow).filter((p) => p.level === 'error');
  if (problems.length > 0) {
    run.status = 'failed';
    run.error = `The flow has problems: ${problems.map((p) => p.message).join(' ')}`;
    run.endedAt = nowIso();
    update();
    return { run, done: Promise.resolve(run), stop() {}, answer: () => false };
  }

  const start = flow.nodes.find((n) => n.type === 'start')!;
  queue.push({ nodeId: start.id, input: run.objective });

  const ask = (nodeId: string, kind: PendingQuestion['kind'], title: string, body: string) =>
    new Promise<{ approve: boolean; text: string }>((resolve) => {
      const id = `q_${run.pending.length}_${Date.now().toString(36)}`;
      run.pending.push({ id, nodeId, kind, title, body });
      run.status = 'waiting';
      const state = run.nodes[nodeId];
      if (state !== undefined) state.status = 'waiting';
      waiters.set(id, (answer) => {
        waiters.delete(id);
        run.pending = run.pending.filter((q) => q.id !== id);
        if (run.pending.length === 0 && run.status === 'waiting') run.status = 'running';
        if (state !== undefined && state.status === 'waiting') state.status = 'running';
        update();
        resolve(answer);
      });
      update();
    });

  signal.addEventListener('abort', () => {
    for (const w of [...waiters.values()]) w({ approve: false, text: '' });
  });

  const context = (input: string, visit: number) => ({
    objective: run.objective,
    input,
    visit,
    nodes: outputs,
    ...(run.branch === undefined ? {} : { branch: run.branch }),
  });

  const cwdFor = async (workspace: 'run' | 'project') =>
    workspace === 'project' ? deps.projectPath : await deps.workspace(run);

  async function execute(node: FlowNode, input: string, visit: NodeVisit, from?: Activation['from']): Promise<Outcome> {
    const ctx = context(input, visit.n);
    switch (node.type) {
      case 'start':
        return { handle: 'out', output: input };

      case 'agent': {
        const cfg: AgentConfig = node.data;
        const prompt = renderTemplate(cfg.prompt, ctx);
        visit.sent = prompt;
        const cwd = await cwdFor(cfg.workspace);
        const resume = cfg.keepContext ? harnessSessions.get(node.id) : undefined;
        const tokensBefore = resume === undefined ? undefined : harnessTokens.get(node.id);
        visit.turn = { text: '', tools: [], status: 'running' };
        let result: AgentResult;
        try {
          result = await deps.agent({
            run,
            node,
            prompt,
            cwd,
            ...(resume === undefined ? {} : { resume }),
            ...(tokensBefore === undefined ? {} : { tokensBefore }),
            signal,
            onTurn(turn) {
              visit.turn = turn;
              update();
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          visit.turn = { ...(visit.turn ?? { text: '', tools: [] }), status: 'error', error: message };
          throw new NodeFailure(message);
        }
        visit.turn = result.turn;
        if (result.harnessSessionId !== undefined) harnessSessions.set(node.id, result.harnessSessionId);
        if (result.harnessTokens !== undefined) harnessTokens.set(node.id, result.harnessTokens);
        run.costUsd += result.turn.costUsd ?? 0;
        // A run's agents each have their own context, so the total leaves context out.
        const { context: _context, ...spent } = result.turn.tokens ?? { input: 0, cached: 0, output: 0 };
        const tokens = result.turn.tokens === undefined ? run.tokens : addTokens(run.tokens, spent);
        if (tokens !== undefined) run.tokens = tokens;
        if (result.turn.status !== 'done') {
          throw new NodeFailure(result.turn.error ?? `The agent ended with status ${result.turn.status}.`);
        }
        return { handle: 'out', output: (result.turn.final ?? result.turn.text).trim() };
      }

      case 'decide': {
        const cfg = node.data;
        const question = renderTemplate(cfg.question, ctx);
        const state = renderTemplate(cfg.state.trim() === '' ? '{{input}}' : cfg.state, ctx);
        visit.sent = `${question}\n\n${state}`;
        const judgment = await deps.judge({ config: cfg, question, state, signal });
        visit.judgment = { ...judgment, question };
        let handle = judgment.answer;
        if (cfg.minConfidence > 0) {
          const sure = cfg.mode === 'yesno' ? Math.abs((judgment.value ?? 0.5) - 0.5) * 2 : judgment.confidence;
          if (sure < cfg.minConfidence) handle = 'unsure';
        }
        // The input passes through: a decision routes the work, it does not replace it.
        return { handle, output: input };
      }

      case 'human': {
        const body = renderTemplate(node.data.prompt, ctx);
        visit.sent = body;
        const answer = await ask(node.id, 'approve', node.data.label, body);
        if (signal.aborted) throw new NodeFailure('Stopped.');
        const note = answer.text.trim();
        visit.log = `${answer.approve ? 'Approved' : 'Rejected'}${note === '' ? '' : `: ${note}`}`;
        // A note travels on as the output, so a rejection can carry what to fix.
        const output = note === '' ? input : `${input}\n\nFrom the person reviewing: ${note}`;
        return { handle: answer.approve ? 'approve' : 'reject', output };
      }

      case 'shell': {
        const cfg = node.data;
        const command = renderTemplate(cfg.command, ctx);
        visit.sent = command;
        const cwd = await cwdFor(cfg.workspace);
        const res = await deps.shell({ command, cwd, timeoutMs: cfg.timeoutSec * 1000, signal });
        visit.log = `$ ${command}\n${res.output}`;
        // Fenced, so wherever it is shown as Markdown its lines stay lines and `> x` stays text.
        const output = `Command: \`${command}\`\nExit code: ${res.code === null ? 'none (timed out or killed)' : String(res.code)}\n\n\`\`\`\n${res.output.trimEnd()}\n\`\`\``;
        return { handle: res.code === 0 ? 'pass' : 'fail', output };
      }

      case 'git': {
        const message = renderTemplate(node.data.message, ctx);
        // A diff takes no message, so there is nothing it was given.
        if (node.data.action !== 'diff') visit.sent = message;
        // A merge changes your checkout, so it asks first. Not when the step that sent the work
        // here was your own approval: that was the question, and asking again is a second click
        // for nothing. Flows saved before the setting existed have no value, and ask.
        const justApproved = from?.node.type === 'human' && from.handle === 'approve';
        const confirm = node.data.action === 'merge' && node.data.askBeforeMerge !== false && !justApproved;
        const res = await deps.git({
          run,
          config: node.data,
          message,
          signal,
          ...(confirm ? { ask: async (title: string, body: string) => (await ask(node.id, 'merge', title, body)).approve } : {}),
        });
        if (signal.aborted) throw new NodeFailure('Stopped.');
        visit.log = res.output;
        return { handle: res.ok ? 'out' : 'fail', output: res.ok && node.data.action !== 'diff' ? input : res.output };
      }

      case 'search': {
        const cfg = node.data;
        const query = renderTemplate(cfg.query, ctx);
        const question = cfg.question.trim() === '' ? query : renderTemplate(cfg.question, ctx);
        visit.sent = question === query ? query : `${query}\n\n${question}`;
        visit.log = '';
        const res = await deps.search({
          query,
          question,
          signal,
          onProgress(line) {
            visit.log = `${visit.log ?? ''}${visit.log === '' ? '' : '\n'}${line}`;
            update();
          },
        });
        const found = res.answered >= cfg.threshold;
        // The verdict shows where every Jev answer shows: on the card, the map and the step.
        visit.judgment = {
          question: `Do the pages answer: ${question}`,
          mode: 'yesno',
          answer: found ? 'yes' : 'no',
          probabilities: { yes: res.answered, no: 1 - res.answered },
          confidence: Math.abs(res.answered - 0.5) * 2,
          value: res.answered,
          model: res.model,
          latencyMs: res.latencyMs,
        };
        return { handle: found ? 'found' : 'unanswered', output: res.output };
      }

      case 'browser': {
        const cfg = node.data;
        visit.steps = [];
        const goal = renderTemplate(cfg.goal, ctx);
        visit.sent = goal;
        const res = await deps.browser({
          run,
          config: cfg,
          goal,
          startUrl: renderUrlTemplate(cfg.startUrl, ctx),
          signal,
          onStep(step) {
            visit.steps = [...(visit.steps ?? []), step];
            update();
          },
          ask: async (title, body) => (await ask(node.id, 'guard', title, body)).approve,
        });
        return { handle: res.ok ? 'done' : 'failed', output: res.output };
      }

      case 'flow': {
        const objective = renderTemplate(node.data.objective, ctx);
        visit.sent = objective;
        const res = await deps.subflow({ run, node, objective, signal });
        if (res.runId !== undefined) visit.log = `Run ${res.runId}`;
        return { handle: res.ok ? 'done' : 'failed', output: res.output };
      }

      case 'join':
        return { handle: 'out', output: input };

      case 'end':
        return { handle: '', output: renderTemplate(node.data.template, ctx) };
    }
  }

  function deliver(node: FlowNode, outcome: Outcome) {
    if (node.type !== 'end' && !flow.edges.some((e) => e.source === node.id && e.sourceHandle === outcome.handle)) deadEnd = { label: node.data.label, handle: outcome.handle };
    for (const e of flow.edges) {
      if (e.source !== node.id || e.sourceHandle !== outcome.handle) continue;
      const target = byId.get(e.target);
      if (target === undefined) continue;
      if (target.type === 'join') {
        const sources = new Set(flow.edges.filter((x) => x.target === target.id).map((x) => x.source));
        const arrivals = joinArrivals.get(target.id) ?? new Map<string, { output: string; handle: string }>();
        arrivals.set(node.id, { output: outcome.output, handle: outcome.handle });
        joinArrivals.set(target.id, arrivals);
        const state = run.nodes[target.id];
        if (state !== undefined && state.status === 'idle') state.status = 'waiting';
        if ([...sources].every((s) => arrivals.has(s))) {
          joinArrivals.delete(target.id);
          const combined = [...sources]
            .map((s) => `## ${byId.get(s)?.data.label ?? s}\n\n${arrivals.get(s)?.output ?? ''}`)
            .join('\n\n');
          const joined = [...sources].map((s) => ({ nodeId: s, handle: arrivals.get(s)?.handle ?? '' }));
          queue.push({ nodeId: target.id, input: combined, joined });
        }
      } else {
        queue.push({ nodeId: target.id, input: outcome.output, from: { node, handle: outcome.handle } });
        const state = run.nodes[target.id];
        if (state !== undefined && state.status !== 'running' && state.status !== 'waiting') state.status = 'queued';
      }
    }
  }

  async function activate(act: Activation): Promise<void> {
    const node = byId.get(act.nodeId);
    const state = run.nodes[act.nodeId];
    if (node === undefined || state === undefined) return;
    const n = state.visits.length + 1;
    if (n > maxVisitsOf(node)) {
      // Name what kept sending the work back. The node itself did its job each time.
      const max = String(maxVisitsOf(node));
      const by = act.from;
      fail(
        by === undefined
          ? `"${node.data.label}" ran ${max} times, its limit, so the run stopped instead of looping again.`
          : by.node.type === 'decide'
            ? `Jev answered "${by.handle}" at "${by.node.data.label}" each time, sending the work back to "${node.data.label}". It ran ${max} times, its limit, so the run stopped instead of looping again.`
            : `"${by.node.data.label}" went "${by.handle}" and sent the work back to "${node.data.label}" ${max} times, its limit, so the run stopped instead of looping again.`,
      );
      update();
      return;
    }
    const from = act.joined ?? (act.from === undefined ? undefined : [{ nodeId: act.from.node.id, handle: act.from.handle }]);
    const visit: NodeVisit = { n, startedAt: nowIso(), input: act.input, ...(from === undefined ? {} : { from }) };
    state.visits.push(visit);
    state.status = 'running';
    update();
    let outcome: Outcome;
    try {
      outcome = await execute(node, act.input, visit, act.from);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      visit.error = message;
      visit.endedAt = nowIso();
      if (signal.aborted) {
        state.status = 'stopped';
        update();
        return;
      }
      state.status = 'failed';
      // A wired error path takes the failure; otherwise the run stops on it.
      // A Jev setup problem (no key, a refused key) is not uncertainty, so it never takes `unsure`.
      const setup = (err as { setup?: unknown } | null)?.setup === true;
      const errorHandle = node.type === 'agent' ? 'error' : node.type === 'decide' && !setup ? 'unsure' : null;
      if (errorHandle !== null && flow.edges.some((e) => e.source === node.id && e.sourceHandle === errorHandle)) {
        visit.handle = errorHandle;
        deliver(node, { handle: errorHandle, output: `${node.data.label} failed: ${message}\n\n${act.input}` });
      } else {
        fail(`"${node.data.label}" failed: ${message}`);
      }
      update();
      return;
    }
    visit.endedAt = nowIso();
    visit.output = outcome.output;
    visit.handle = outcome.handle;
    state.status = 'done';
    outputs[node.id] = outcome.output;
    outputs[slug(node.data.label)] = outcome.output;
    lastOutput = outcome.output;
    if (node.type === 'end') {
      endOutput = outcome.output;
      endOutcome = node.data.outcome ?? 'success';
    }
    if (!signal.aborted) deliver(node, outcome);
    update();
  }

  const done = (async () => {
    while (!signal.aborted && (queue.length > 0 || inFlight.size > 0)) {
      while (queue.length > 0 && inFlight.size < concurrency && !signal.aborted) {
        const act = queue.shift()!;
        const p: Promise<void> = activate(act).finally(() => inFlight.delete(p));
        inFlight.add(p);
      }
      if (inFlight.size > 0) await Promise.race(inFlight);
    }
    // After a stop or a failure, let what is running wind down before the run is sealed.
    await Promise.allSettled([...inFlight]);
    for (const q of queue.splice(0)) {
      const state = run.nodes[q.nodeId];
      if (state !== undefined && state.status === 'queued') state.status = 'skipped';
    }
    for (const [id, state] of Object.entries(run.nodes)) {
      if (state.status === 'waiting' && joinArrivals.has(id)) state.status = 'skipped';
    }
    run.pending = [];
    run.endedAt = nowIso();
    // Reaching no End means the work went down a path that leads nowhere: that is a failure, not
    // a green "Finished" with the End node never run.
    const lost = deadEnd as { label: string; handle: string } | null;
    if (run.error === undefined && !signal.aborted && endOutput === null && lost !== null) {
      run.error = `"${lost.label}" took its "${lost.handle}" path, and nothing is connected there, so the run ended without reaching an End.`;
    }
    // Set inside deliver's callers, which TypeScript cannot see from here.
    const ended = endOutcome as 'success' | 'failure' | 'stopped';
    if (run.error !== undefined || ended === 'failure') run.status = 'failed';
    else if (signal.aborted || ended === 'stopped') run.status = 'stopped';
    else run.status = 'succeeded';
    // A stopped or failed run has no result of its own; the last output would be, say, the objective.
    const result = endOutput ?? (run.status === 'succeeded' ? lastOutput : null);
    if (result !== null) run.result = result;
    update();
    return run;
  })();

  return {
    run,
    done,
    stop() {
      if (run.endedAt !== undefined) return;
      controller.abort();
    },
    answer(questionId, approve, text) {
      const w = waiters.get(questionId);
      if (w === undefined) return false;
      w({ approve, text });
      return true;
    },
  };
}
