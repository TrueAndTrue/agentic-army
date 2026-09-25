/**
 * The app's state and every action the window can ask for. Electron-free: `index.ts` wires it to
 * IPC and gives it a way to open browser pages, so this file can be exercised without a window.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { flowCommand, MAX_FLOW_DEPTH, mayStart, newId, parseFlowCommand, slug } from '../shared/flow.ts';
import { fitEffort, mergeCatalog } from '../shared/models.ts';
import type {
  AppEvent,
  DiffResult,
  DoctorReport,
  Flow,
  ModelEntry,
  Project,
  Run,
  RunStarter,
  Session,
  SessionItem,
  SessionSummary,
  Settings,
} from '../shared/types.ts';
import { killAllAgents, runAgent } from './agents.ts';
import { pilot, type Page } from './browser/pilot.ts';
import { createRun, startRun, type EngineDeps, type RunHandle } from './flow/engine.ts';
import { ensureWorkspace, finalizeWorkspace, gitNode, mergeRun, runDiff, runShell } from './git.ts';
import type { FlowBridge, ToolCaller, ToolDescription, ToolHandler } from './flowTools.ts';
import { askJev, judge } from './jev.ts';
import { modelCatalog } from './models.ts';
import { Store } from './store.ts';
import { BUILTIN_FLOWS } from './templates.ts';

export interface ControllerOptions {
  store: Store;
  emit(event: AppEvent): void;
  openPage(show: boolean): Page & { close(): void };
}

const nowIso = () => new Date().toISOString();
const TITLE_CHARS = 60;
/** Runs an agent may have going at once in one session, so a loop of requests cannot fan out. */
const MAX_AGENT_RUNS = 3;
/** How much of a finished run's result an agent is told at the start of its next turn. */
const NEWS_CHARS = 2000;

export class Controller {
  private readonly store: Store;
  private readonly emitRaw: (e: AppEvent) => void;
  private readonly openPage: ControllerOptions['openPage'];
  settings: Settings;
  private projects: Project[];
  private userFlows: Flow[];
  private readonly sessions = new Map<string, Session>();
  private readonly runs = new Map<string, Run>();
  private readonly handles = new Map<string, RunHandle>();
  private readonly chats = new Map<string, AbortController>();
  private readonly workspaces = new Map<string, Promise<string>>();
  private readonly throttles = new Map<string, NodeJS.Timeout>();
  private bridge: FlowBridge | null = null;

  constructor(opts: ControllerOptions) {
    this.store = opts.store;
    this.emitRaw = opts.emit;
    this.openPage = opts.openPage;
    this.settings = this.store.loadSettings();
    this.addListedModels();
    this.projects = this.store.loadProjects();
    this.userFlows = this.store.loadFlows();
    for (const s of this.store.loadSessions()) this.sessions.set(s.id, s);
    for (const r of this.store.loadRuns()) this.runs.set(r.id, r);
    this.recoverFromLastLaunch();
  }

  /** Anything that was live when the app last closed is not live now. Say so, and clean up. */
  private recoverFromLastLaunch(): void {
    for (const s of this.sessions.values()) {
      let changed = false;
      for (const it of s.items) {
        if (it.kind === 'agent' && it.status === 'running') {
          it.status = 'stopped';
          it.error = 'The app closed during this reply.';
          changed = true;
        }
      }
      if (changed) this.store.saveSessionSoon(s);
    }
    for (const r of this.runs.values()) {
      if (r.status === 'running' || r.status === 'waiting') {
        r.status = 'stopped';
        r.error = 'The app closed while this run was going.';
        r.endedAt = nowIso();
        r.pending = [];
        for (const st of Object.values(r.nodes)) if (['running', 'queued', 'waiting'].includes(st.status)) st.status = 'stopped';
        const project = this.projects.find((p) => p.id === r.projectId);
        if (project !== undefined) void finalizeWorkspace(r, project.path).then(() => this.store.saveRunSoon(r));
        this.store.saveRunSoon(r);
      }
    }
  }

  // ----------------------------------------------------------------------------------------------
  // Reading
  // ----------------------------------------------------------------------------------------------

  flows(): Flow[] {
    const mine = new Set(this.userFlows.map((f) => f.id));
    return [...BUILTIN_FLOWS.filter((f) => !mine.has(f.id)), ...this.userFlows].sort((a, b) =>
      a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin === true ? -1 : 1,
    );
  }

  summaries(): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((s) => s.archived !== true)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => {
        const runs = s.items.filter((i) => i.kind === 'run').map((i) => this.runs.get((i as { runId: string }).runId));
        return {
          id: s.id,
          projectId: s.projectId,
          title: s.title,
          updatedAt: s.updatedAt,
          busy: this.chats.has(s.id) || runs.some((r) => r?.status === 'running' || r?.status === 'waiting'),
          waiting: runs.some((r) => r?.status === 'waiting') || s.items.some((i) => i.kind === 'flow-request' && i.status === 'pending'),
        };
      });
  }

  getState() {
    return { projects: this.projects, sessions: this.summaries(), flows: this.flows(), settings: this.settings };
  }

  getSession(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }

  getRun(id: string): Run | null {
    return this.runs.get(id) ?? null;
  }

  model(id: string): ModelEntry {
    return this.settings.models.find((m) => m.id === id) ?? this.settings.models[0] ?? { id: 'fallback', harness: 'claude', model: '', label: 'Claude default' };
  }

  // ----------------------------------------------------------------------------------------------
  // Events
  // ----------------------------------------------------------------------------------------------

  /** Coalesce bursts (a streaming reply changes a session dozens of times a second). */
  private later(key: string, ms: number, fn: () => void): void {
    if (this.throttles.has(key)) return;
    this.throttles.set(
      key,
      setTimeout(() => {
        this.throttles.delete(key);
        fn();
      }, ms),
    );
  }

  private touchSession(s: Session, immediate = false): void {
    s.updatedAt = nowIso();
    this.store.saveSessionSoon(s);
    const send = () => {
      this.emitRaw({ type: 'session', session: s });
      this.emitRaw({ type: 'sessions', sessions: this.summaries() });
    };
    if (immediate) send();
    else this.later(`session:${s.id}`, 60, send);
  }

  private touchRun(r: Run): void {
    this.store.saveRunSoon(r);
    this.later(`run:${r.id}`, 80, () => {
      this.emitRaw({ type: 'run', run: r });
      this.emitRaw({ type: 'sessions', sessions: this.summaries() });
    });
  }

  private push(s: Session, item: SessionItem): void {
    s.items.push(item);
    this.touchSession(s, true);
  }

  private notice(s: Session, text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
    this.push(s, { kind: 'notice', id: newId('n'), ts: nowIso(), text, tone });
  }

  // ----------------------------------------------------------------------------------------------
  // Projects and sessions
  // ----------------------------------------------------------------------------------------------

  addProject(path: string): Project {
    const full = resolve(path);
    if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error(`${full} is not a folder.`);
    const existing = this.projects.find((p) => p.path === full);
    if (existing !== undefined) return existing;
    const project: Project = { id: newId('p'), name: basename(full), path: full, addedAt: nowIso() };
    this.projects = [...this.projects, project];
    this.store.saveProjects(this.projects);
    this.emitRaw({ type: 'projects', projects: this.projects });
    return project;
  }

  removeProject(id: string): void {
    for (const s of [...this.sessions.values()]) if (s.projectId === id) this.deleteSession(s.id);
    this.projects = this.projects.filter((p) => p.id !== id);
    this.store.saveProjects(this.projects);
    this.emitRaw({ type: 'projects', projects: this.projects });
  }

  createSession(projectId: string): Session {
    if (!this.projects.some((p) => p.id === projectId)) throw new Error('That project is gone.');
    const s: Session = {
      id: newId('s'),
      projectId,
      title: 'New session',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      items: [],
      chat: { modelId: this.settings.chatDefault.modelId, effort: this.settings.chatDefault.effort, edits: true },
    };
    this.sessions.set(s.id, s);
    this.touchSession(s, true);
    return s;
  }

  renameSession(id: string, title: string): void {
    const s = this.sessions.get(id);
    if (s === undefined) return;
    s.title = title.trim().slice(0, 120) || s.title;
    this.touchSession(s, true);
  }

  deleteSession(id: string): void {
    const s = this.sessions.get(id);
    if (s === undefined) return;
    this.stop(id);
    const runIds = s.items.flatMap((i) => (i.kind === 'run' ? [i.runId] : []));
    for (const r of runIds) this.runs.delete(r);
    this.sessions.delete(id);
    this.store.deleteSession(id, runIds);
    this.emitRaw({ type: 'sessions', sessions: this.summaries() });
  }

  setChat(id: string, patch: Partial<Session['chat']>): void {
    const s = this.sessions.get(id);
    if (s === undefined) return;
    s.chat = { ...s.chat, ...patch };
    this.touchSession(s, true);
  }

  // ----------------------------------------------------------------------------------------------
  // Sending
  // ----------------------------------------------------------------------------------------------

  async send(sessionId: string, text: string, flowId: string | null): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s === undefined) throw new Error('That session is gone.');
    const body = text.trim();
    if (body === '') return;
    if (s.items.filter((i) => i.kind === 'user').length === 0) s.title = body.replace(/\s+/g, ' ').slice(0, TITLE_CHARS);

    // `/quick-fix add multiply` runs Quick fix, whatever the picker says, unless it names a flow.
    const command = flowId === null || flowId === 'auto' ? parseFlowCommand(body, this.flows()) : null;
    if (command !== null) {
      this.push(s, { kind: 'user', id: newId('u'), ts: nowIso(), text: body, flowId: command.flow.id });
      if (command.objective === '') return this.notice(s, `Say what "${command.flow.name}" should do after /${flowCommand(command.flow)}.`, 'warn');
      return this.startOrSay(s, command.flow, command.objective, { kind: 'you' });
    }

    let target = flowId;
    let starter: RunStarter = { kind: 'you' };
    this.push(s, { kind: 'user', id: newId('u'), ts: nowIso(), text: body, ...(flowId !== null && flowId !== 'auto' ? { flowId } : {}) });

    if (target === 'auto') {
      const routed = await this.route(s, body);
      target = routed?.flowId ?? null;
      if (routed !== null) starter = { kind: 'jev', confidence: routed.confidence };
    }
    if (target === null) return this.chat(s, body);
    const flow = this.flows().find((f) => f.id === target);
    if (flow === undefined) return this.notice(s, 'That flow no longer exists. Pick another one.', 'error');
    this.startOrSay(s, flow, body, starter);
  }

  private startOrSay(s: Session, flow: Flow, objective: string, by: RunStarter): void {
    const res = this.startFlow(s, flow, objective, by);
    if (typeof res === 'string') this.notice(s, res, 'error');
  }

  /** Jev picks between chatting and each flow, by the flow's description. */
  private async route(s: Session, text: string): Promise<{ flowId: string; confidence: number } | null> {
    const flows = this.flows().filter((f) => mayStart(f, this.settings, 'jev') === 'yes');
    if (flows.length === 0) {
      this.notice(s, 'No flow lets Jev pick it in Auto, so this is a chat. Each flow says who may start it, on its canvas.');
      return null;
    }
    const criteria: Record<string, string> = {
      chat: 'A question, an explanation, or a small edit one assistant can handle in conversation.',
    };
    for (const f of flows) criteria[f.id] = `${f.name}: ${f.description}`;
    try {
      const res = await askJev(this.settings.typesafe, { request: text }, {
        route: { type: 'choice', instructions: 'Which of these is the best way to handle the `request`?', criteria },
      });
      const a = res.answers['route'];
      const pick = a?.choice ?? 'chat';
      const conf = a?.confidence ?? 0;
      if (pick === 'chat' || conf < 0.4) {
        this.notice(s, `Jev kept this as a chat${pick === 'chat' ? '' : ` (it leaned toward "${flows.find((f) => f.id === pick)?.name ?? pick}" but only at ${conf.toFixed(2)} confidence)`}.`);
        return null;
      }
      this.notice(s, `Jev sent this to "${flows.find((f) => f.id === pick)?.name ?? pick}" with confidence ${conf.toFixed(2)}.`);
      return { flowId: pick, confidence: conf };
    } catch (err) {
      this.notice(s, `Jev could not route this (${err instanceof Error ? err.message : String(err)}). Answering as a chat.`, 'warn');
      return null;
    }
  }

  private async chat(s: Session, text: string): Promise<void> {
    const project = this.projects.find((p) => p.id === s.projectId);
    if (project === undefined) return this.notice(s, 'This session belongs to a project that was removed.', 'error');
    if (this.chats.has(s.id)) return this.notice(s, 'The agent is still answering. Stop it first, or wait.', 'warn');
    const model = this.model(s.chat.modelId);
    const item: Extract<SessionItem, { kind: 'agent' }> = { kind: 'agent', id: newId('a'), ts: nowIso(), modelId: model.id, text: '', tools: [], status: 'running' };
    this.push(s, item);
    const ctl = new AbortController();
    this.chats.set(s.id, ctl);
    this.touchSession(s, true);
    const resume = s.chat.harnessModelId === model.id ? s.chat.harnessSessionId : undefined;
    // The start_flow tool, only when some flow lets an agent start it. Its key dies with this turn.
    const tools = this.bridge !== null && this.agentFlows().length > 0 ? this.bridge.open({ sessionId: s.id, model: model.label }) : null;
    // What happened since the agent last spoke: runs it started that finished, requests you answered.
    const news = s.chat.news ?? [];
    delete s.chat.news;
    const prompt = news.length === 0 ? text : `Since your last turn:\n${news.map((n) => `- ${n}`).join('\n')}\n\nThe person's message:\n${text}`;
    try {
      const res = await runAgent({
        harness: model.harness,
        model: model.model,
        effort: fitEffort(model, s.chat.effort),
        role: s.chat.edits ? 'engineer' : 'scout',
        cwd: project.path,
        prompt,
        ...(tools === null ? {} : { mcp: [tools.spec] }),
        label: `chat-${s.id.slice(-6)}`,
        brief: false,
        ...(resume === undefined ? {} : { resume }),
        settings: this.settings,
        signal: ctl.signal,
        onTurn: (turn) => {
          Object.assign(item, turn);
          this.touchSession(s);
        },
      });
      Object.assign(item, res.turn);
      if (res.harnessSessionId !== undefined) {
        s.chat.harnessSessionId = res.harnessSessionId;
        s.chat.harnessModelId = model.id;
      }
    } catch (err) {
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
    } finally {
      tools?.close();
      this.chats.delete(s.id);
      this.touchSession(s, true);
    }
  }

  /** Start a run in this session, or say why not. Every way of starting a flow ends here. */
  private startFlow(s: Session, flow: Flow, objective: string, by: RunStarter, parent?: { runId: string; depth: number }): Run | string {
    const project = this.projects.find((p) => p.id === s.projectId);
    if (project === undefined) return 'This session belongs to a project that was removed.';
    // Refuse before anything is spent, rather than fail at the first Jev node halfway through.
    const jevNodes = flow.nodes.filter((n) => n.type === 'decide' || n.type === 'browser');
    if (jevNodes.length > 0 && this.settings.typesafe.apiKey.trim() === '') {
      return `"${flow.name}" uses Jev in ${jevNodes.map((n) => `"${n.data.label}"`).join(', ')}, and there is no TypeSafe API key. Add one in Settings, then send again.`;
    }
    const run = createRun({ id: newId('run'), flow, sessionId: s.id, projectId: project.id, objective });
    run.startedBy = by;
    if (parent !== undefined) {
      run.parentRunId = parent.runId;
      run.depth = parent.depth;
    }
    this.runs.set(run.id, run);
    this.push(s, { kind: 'run', id: newId('r'), ts: nowIso(), runId: run.id, flowId: flow.id, flowName: flow.name });
    const handle = startRun(run, this.engineDeps(s, project), (r) => this.touchRun(r));
    this.handles.set(run.id, handle);
    this.touchRun(run);
    void handle.done.then(async (r) => {
      this.handles.delete(r.id);
      this.workspaces.delete(r.id);
      try {
        await finalizeWorkspace(r, project.path);
      } catch (err) {
        this.notice(s, `The run finished, but its worktree could not be cleaned up: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
      if (by.kind === 'agent') {
        const result = (r.status === 'succeeded' ? r.result : r.error) ?? '';
        const cut = result.length > NEWS_CHARS ? `${result.slice(0, NEWS_CHARS)}…` : result;
        const how = r.status === 'succeeded' ? 'finished' : `ended: ${r.status}`;
        s.chat.news = [...(s.chat.news ?? []), `The flow "${r.flowName}" you started ${how}${r.branch === undefined ? '' : ` on branch ${r.branch}`}.${cut === '' ? '' : ` Its result:\n${cut}`}`];
      }
      this.touchRun(r);
      this.touchSession(s, true);
    });
    return run;
  }

  // ----------------------------------------------------------------------------------------------
  // Flows an agent may start
  // ----------------------------------------------------------------------------------------------

  attachBridge(bridge: FlowBridge): void {
    this.bridge = bridge;
  }

  /** The flows a chat agent may start, and whether each needs your approval. */
  private agentFlows(): { flow: Flow; ask: boolean }[] {
    return this.flows().flatMap((flow) => {
      const may = mayStart(flow, this.settings, 'agent');
      return may === 'no' ? [] : [{ flow, ask: may === 'ask' }];
    });
  }

  readonly flowTools: ToolHandler = {
    list: (): ToolDescription[] => {
      const flows = this.agentFlows();
      const lines = flows.map(({ flow, ask }) => `- ${flowCommand(flow)}: ${flow.name}. ${flow.description}${ask ? ' (The person approves before it starts.)' : ''}`);
      return [
        {
          name: 'start_flow',
          description:
            "Start one of the person's flows: a team of agents wired together that works on its own git branch and shows in this conversation. " +
            'Use it when the work is bigger than a reply, matches a flow below, and the person wants it done. It returns at once; the run goes on without you, ' +
            'and you are told how it ended at the start of your next turn. Flows you may start:\n' +
            lines.join('\n'),
          inputSchema: {
            type: 'object',
            properties: {
              flow: { type: 'string', enum: flows.map(({ flow }) => flowCommand(flow)), description: 'Which flow, by the name before the colon above.' },
              objective: { type: 'string', description: 'What the flow should achieve, written as the person would: complete and specific, because the flow starts from this alone.' },
              why: { type: 'string', description: 'One sentence the person reads: why this flow, now.' },
            },
            required: ['flow', 'objective', 'why'],
          },
        },
      ];
    },
    call: (caller: ToolCaller, name: string, args: Record<string, unknown>) => {
      if (name !== 'start_flow') return { text: `There is no tool called ${name}.`, isError: true };
      const s = this.sessions.get(caller.sessionId);
      if (s === undefined) return { text: 'This conversation is gone.', isError: true };
      const wanted = typeof args['flow'] === 'string' ? args['flow'] : '';
      const objective = typeof args['objective'] === 'string' ? args['objective'].trim() : '';
      const why = typeof args['why'] === 'string' ? args['why'].trim() : '';
      const entry = this.agentFlows().find(({ flow }) => flowCommand(flow) === wanted || flow.name === wanted);
      if (entry === undefined) {
        const known = this.flows().find((f) => flowCommand(f) === wanted || f.name === wanted);
        return {
          text:
            known === undefined
              ? `There is no flow called "${wanted}".`
              : `The person has not allowed agents to start "${known.name}". Suggest it to them instead; they can start it with /${flowCommand(known)}.`,
          isError: true,
        };
      }
      if (objective === '') return { text: 'Give the objective: the flow starts from it alone.', isError: true };
      const going = s.items.filter((i) => i.kind === 'run' && this.runs.get(i.runId)?.startedBy?.kind === 'agent' && this.handles.has(i.runId)).length;
      const asking = s.items.filter((i) => i.kind === 'flow-request' && i.status === 'pending').length;
      if (going + asking >= MAX_AGENT_RUNS) {
        return { text: `You already have ${String(MAX_AGENT_RUNS)} flows running or waiting for approval in this conversation. Wait for one to end.`, isError: true };
      }
      const { flow, ask } = entry;
      if (ask) {
        this.push(s, { kind: 'flow-request', id: newId('fr'), ts: nowIso(), flowId: flow.id, flowName: flow.name, objective, model: caller.model, why, status: 'pending' });
        return { text: `Asked the person to approve starting "${flow.name}". It starts if they approve, and you will hear how it went at the start of your next turn. Tell them what you asked for and why.` };
      }
      const run = this.startFlow(s, flow, objective, { kind: 'agent', model: caller.model, approved: false });
      if (typeof run === 'string') return { text: run, isError: true };
      return { text: `Started "${flow.name}" as run ${run.id}. It shows in this conversation, and you will hear how it went at the start of your next turn.` };
    },
  };

  answerFlowRequest(sessionId: string, requestId: string, approve: boolean, objective: string): void {
    const s = this.sessions.get(sessionId);
    const req = s?.items.find((i) => i.id === requestId);
    if (s === undefined || req === undefined || req.kind !== 'flow-request' || req.status !== 'pending') return;
    if (!approve) {
      req.status = 'declined';
      s.chat.news = [...(s.chat.news ?? []), `The person declined your request to start "${req.flowName}".`];
      this.touchSession(s, true);
      return;
    }
    const flow = this.flows().find((f) => f.id === req.flowId);
    if (flow === undefined) {
      req.status = 'declined';
      return this.notice(s, `"${req.flowName}" no longer exists, so it could not start.`, 'error');
    }
    const edited = objective.trim();
    if (edited !== '') req.objective = edited;
    const run = this.startFlow(s, flow, req.objective, { kind: 'agent', model: req.model, approved: true });
    if (typeof run === 'string') {
      req.status = 'declined';
      return this.notice(s, run, 'error');
    }
    req.status = 'started';
    req.runId = run.id;
    this.touchSession(s, true);
  }


  private engineDeps(s: Session, project: Project): EngineDeps {
    return {
      projectPath: project.path,
      concurrency: 4,
      workspace: (run) => {
        let p = this.workspaces.get(run.id);
        if (p === undefined) {
          p = ensureWorkspace(run, project.path, this.store.worktreeRoot).then((w) => {
            if (w.notice !== undefined) this.notice(s, w.notice, 'warn');
            this.touchRun(run);
            return w.path;
          });
          p.catch(() => this.workspaces.delete(run.id));
          this.workspaces.set(run.id, p);
        }
        return p;
      },
      agent: async (req) => {
        const cfg = req.node.data;
        const stage = this.settings.stageDefaults[cfg.role];
        const model = this.model(cfg.modelId ?? stage.modelId);
        const visit = (req.run.nodes[req.node.id]?.visits.length ?? 1).toString();
        return runAgent({
          harness: model.harness,
          model: model.model,
          effort: fitEffort(model, cfg.effort ?? stage.effort),
          role: cfg.role,
          cwd: req.cwd,
          prompt: req.prompt,
          label: `${slug(cfg.label) || 'agent'}-${visit}`,
          brief: true,
          ...(req.resume === undefined ? {} : { resume: req.resume }),
          settings: this.settings,
          signal: req.signal,
          onTurn: req.onTurn,
        });
      },
      subflow: async (req) => {
        const flow = this.flows().find((f) => f.id === req.node.data.flowId);
        if (flow === undefined) return { ok: false, output: `"${req.node.data.label}" runs a flow that no longer exists.` };
        const depth = (req.run.depth ?? 0) + 1;
        if (depth > MAX_FLOW_DEPTH) {
          return { ok: false, output: `"${req.node.data.label}" would run flows ${String(depth)} deep. The limit is ${String(MAX_FLOW_DEPTH)}, so a chain of flows starting flows always ends.` };
        }
        const child = this.startFlow(s, flow, req.objective, { kind: 'flow', runId: req.run.id, flowName: req.run.flowName, node: req.node.data.label }, { runId: req.run.id, depth });
        if (typeof child === 'string') return { ok: false, output: child };
        const handle = this.handles.get(child.id);
        if (handle === undefined) return { ok: false, output: 'The flow could not start.', runId: child.id };
        const stop = () => handle.stop();
        req.signal.addEventListener('abort', stop, { once: true });
        try {
          const r = await handle.done;
          const detail = r.status === 'succeeded' ? (r.result ?? '') : `"${flow.name}" ${r.status}${r.error === undefined ? '' : `: ${r.error}`}`;
          return { ok: r.status === 'succeeded', output: r.branch === undefined ? detail : `${detail}\n\n(Its work is on branch ${r.branch}.)`, runId: child.id };
        } finally {
          req.signal.removeEventListener('abort', stop);
        }
      },
      judge: (req) => judge(this.settings.typesafe, req.config, req.question, req.state, req.signal),

      shell: (req) => runShell(req.command, req.cwd, req.timeoutMs, req.signal),
      git: (req) => gitNode(req.run, req.config, req.message, project.path),
      browser: async (req) => {
        const page = this.openPage(req.config.showWindow);
        try {
          return await pilot({
            goal: req.goal,
            startUrl: req.startUrl,
            maxSteps: req.config.maxSteps,
            guard: req.config.guard,
            guardThreshold: req.config.guardThreshold,
            page,
            ask: (state, questions, signal) => askJev(this.settings.typesafe, state, questions, signal),
            signal: req.signal,
            onStep: req.onStep,
            confirm: req.ask,
          });
        } finally {
          page.close();
        }
      },
    };
  }

  stop(sessionId: string): void {
    this.chats.get(sessionId)?.abort();
    const s = this.sessions.get(sessionId);
    if (s === undefined) return;
    for (const it of s.items) if (it.kind === 'run') this.handles.get(it.runId)?.stop();
  }

  stopRun(runId: string): void {
    this.handles.get(runId)?.stop();
  }

  answer(runId: string, questionId: string, approve: boolean, text: string): void {
    this.handles.get(runId)?.answer(questionId, approve, text);
  }

  async runDiff(runId: string): Promise<DiffResult> {
    const r = this.runs.get(runId);
    const project = this.projects.find((p) => p.id === r?.projectId);
    if (r === undefined || project === undefined) return { stat: '', patch: '', truncated: false };
    return runDiff(r, project.path);
  }

  async mergeRun(runId: string): Promise<{ ok: boolean; message: string }> {
    const r = this.runs.get(runId);
    const project = this.projects.find((p) => p.id === r?.projectId);
    if (r === undefined || project === undefined) return { ok: false, message: 'That run is gone.' };
    if (this.handles.has(runId)) return { ok: false, message: 'The run is still going. Merge when it finishes.' };
    const res = await mergeRun(r, project.path, `Merge flow "${r.flowName}": ${r.objective.slice(0, 60)}`);
    this.touchRun(r);
    const s = this.sessions.get(r.sessionId);
    if (s !== undefined) this.notice(s, res.message, res.ok ? 'info' : 'error');
    return res;
  }

  // ----------------------------------------------------------------------------------------------
  // Flows and settings
  // ----------------------------------------------------------------------------------------------

  saveFlow(flow: Flow): Flow {
    const saved: Flow = { ...flow, updatedAt: nowIso() };
    delete saved.builtin;
    this.userFlows = [...this.userFlows.filter((f) => f.id !== saved.id), saved];
    this.store.saveFlow(saved);
    this.emitRaw({ type: 'flows', flows: this.flows() });
    return saved;
  }

  deleteFlow(id: string): void {
    this.userFlows = this.userFlows.filter((f) => f.id !== id);
    this.store.deleteFlow(id);
    this.emitRaw({ type: 'flows', flows: this.flows() });
  }

  saveSettings(next: Settings): Settings {
    this.settings = next;
    this.store.saveSettings(next);
    this.emitRaw({ type: 'settings', settings: next });
    return next;
  }

  /** Add the models claude and codex list that you have not been offered yet. */
  private addListedModels(): string[] {
    const before = JSON.stringify(this.settings);
    const { settings, added } = mergeCatalog(this.settings, modelCatalog());
    this.settings = settings;
    if (JSON.stringify(settings) !== before) this.store.saveSettings(settings);
    return added.map((m) => m.label);
  }

  refreshModels(): { settings: Settings; added: string[] } {
    const added = this.addListedModels();
    this.emitRaw({ type: 'settings', settings: this.settings });
    return { settings: this.settings, added };
  }

  async doctor(): Promise<DoctorReport> {
    const version = (bin: string, args: string[]) =>
      new Promise<{ ok: boolean; detail: string }>((res) => {
        execFile(bin, args, { timeout: 10_000 }, (err, stdout, stderr) => {
          if (err !== null) res({ ok: false, detail: `Not found or failed to run "${bin}". ${String(stderr).trim().slice(0, 120)}` });
          else res({ ok: true, detail: String(stdout).trim().split('\n')[0] ?? '' });
        });
      });
    const [claude, codex, gitv, typesafe] = await Promise.all([
      // The same binary the adapters will spawn: the setting, then the override, then PATH.
      version(this.settings.claudeBin.trim() || process.env['ARMY_CLAUDE_BIN'] || 'claude', ['--version']),
      version(this.settings.codexBin.trim() || process.env['ARMY_CODEX_BIN'] || 'codex', ['--version']),
      version('git', ['--version']),
      this.testJev(),
    ]);
    return { claude, codex, git: gitv, typesafe };
  }

  async testJev(): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await askJev(this.settings.typesafe, 'The build passed.', { ok: { type: 'noul', instructions: 'Did the build pass?' } });
      return { ok: true, detail: `${r.model} answered in ${String(r.latencyMs)} ms` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Stop everything and write what is pending. */
  async shutdown(): Promise<void> {
    this.bridge?.stop();
    for (const c of this.chats.values()) c.abort();
    const waits = [...this.handles.values()].map((h) => {
      h.stop();
      return h.done;
    });
    await Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, 4000))]);
    // Whatever did not stop in time is killed, process group and all.
    killAllAgents();
    this.store.flush();
  }

  busy(): boolean {
    return this.chats.size > 0 || this.handles.size > 0;
  }
}
