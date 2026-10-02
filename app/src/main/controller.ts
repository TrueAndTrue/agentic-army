/**
 * The app's state and every action the window can ask for. Electron-free: `index.ts` wires it to
 * IPC and gives it a way to open browser pages, so this file can be exercised without a window.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { flowCommand, jevSteps, MAX_FLOW_DEPTH, mayStart, newId, parseFlowCommand, slug } from '../shared/flow.ts';
import { fitEffort, mergeCatalog } from '../shared/models.ts';
import type {
  AgentStatus,
  AppEvent,
  DiffResult,
  DoctorReport,
  Flow,
  ModelEntry,
  Project,
  ProjectHealth,
  Run,
  RunStarter,
  Session,
  SessionItem,
  SessionSummary,
  Settings,
  SetupFix,
} from '../shared/types.ts';
import { findBin, killAllAgents, runAgent } from './agents.ts';
import { pilot, type Page } from './browser/pilot.ts';
import { createRun, startRun, type EngineDeps, type RunHandle } from './flow/engine.ts';
import { ensureWorkspace, finalizeWorkspace, gitNode, mergeRun, projectHealth, runDiff, runShell, setUpGit } from './git.ts';
import type { FlowBridge, ToolCaller, ToolDescription, ToolHandler } from './flowTools.ts';
import { formatAnswer, webRead, webSearch, type WebDeps } from './websearch.ts';
import { askJev, judge } from './jev.ts';
import { modelCatalog } from './models.ts';
import { addUsualDirs, refreshPath } from './setup.ts';
import { Store } from './store.ts';
import { BUILTIN_FLOWS } from './templates.ts';

export interface ControllerOptions {
  store: Store;
  emit(event: AppEvent): void;
  openPage(show: boolean): Page & { close(): void };
  /**
   * How web searches reach the web. The app passes Electron's own, which speaks HTTP/2 with
   * Chromium's TLS: Brave turns Node's HTTP/1.1 fetch away with a 429, and npmjs.com with a 403.
   */
  fetch?: typeof fetch;
}

const nowIso = () => new Date().toISOString();
const TITLE_CHARS = 60;
/** Runs an agent may have going at once in one session, so a loop of requests cannot fan out. */
const MAX_AGENT_RUNS = 3;
/** How much of a finished run's result an agent is told at the start of its next turn. */
const NEWS_CHARS = 2000;

/** A session title from its first message: the first sentence or line, cut at a word. */
function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = /^(.+?[.?!])(\s|$)/.exec(flat)?.[1] ?? flat;
  if (first.length <= TITLE_CHARS) return first;
  const cut = first.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_CHARS * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '')}…`;
}

/**
 * What a chat agent is told apart from the person's message. It goes in as system instructions,
 * never in front of the message: codex quoted a note put there back as "the first message I sent".
 */
function chatInstructions(o: { flows: string[] | null; web: boolean; readOnly: boolean; transcript: string }): string {
  const parts: string[] = [];
  if (o.web) parts.push(WEB_NOTE);
  if (o.flows !== null && o.flows.length > 0) {
    // claude loads MCP tools on demand and sees only their names until then, so an agent is told
    // what start_flow is. It searches the web itself; a flow is for work that needs a team.
    parts.push(
      "You can start the person's flows with the start_flow tool (mcp__army__start_flow). A flow is a team of agents with its own tools and " +
        'permissions that works on its own git branch. Do not start a flow just to look something up. ' +
        'When the person asks for something a flow below does, ' +
        'call start_flow. Do not say you cannot, and do not ask in chat whether to: a flow that needs approval shows the person a card ' +
        'to approve, edit or decline, so asking first makes them answer twice. When a flow you started ends, you get a turn to tell the ' +
        'person how it went, so do not promise to check back. Flows you may start:\n' +
        o.flows.join('\n'),
    );
  }
  if (o.readOnly) {
    parts.push(
      'This chat is set to Read only: you cannot edit files or run commands that change them. When the person asks for a change, ' +
        'say what you would change, and tell them to switch the chat to "Can edit files" (the menu under the message box) if they want you to make it.',
    );
  }
  if (o.transcript !== '') parts.push(`The conversation so far, before this model took over. Continue it; the person can see all of it:\n\n${o.transcript}`);
  return parts.join('\n\n');
}

/** What an agent with Jev's web tools is told. claude sees an MCP tool only by name until it loads it. */
const WEB_NOTE =
  'To look something up on the web, call jev_search (mcp__army__jev_search) with search words and the question to answer. ' +
  'It searches, has Jev open the likeliest pages and pick the passages that answer, and returns them with their links and how sure Jev is. ' +
  'Answer from those passages and link the pages you used. When Jev is sure, one search is enough: answer, do not search again to confirm. ' +
  'When Jev is unsure, search again with different words, or call read_page (mcp__army__read_page) on a result that looks right. ' +
  'To read a page the person gives you, call read_page. Use your own web search tool only when jev_search says every search engine turned it away.';

const TRANSCRIPT_CHARS = 16_000;

/** Whether a flow works in a worktree on its own branch, which needs a repository with a commit. */
function writesOnBranch(flow: Flow): boolean {
  return flow.nodes.some((n) => (n.type === 'agent' || n.type === 'shell') && n.data.workspace === 'run') || flow.nodes.some((n) => n.type === 'git');
}

/** The thread as text, newest last, cut from the front to fit. Empty when nothing was said yet. */
function transcriptOf(items: SessionItem[], models: ModelEntry[]): string {
  const lines: string[] = [];
  for (const it of items) {
    if (it.kind === 'user') lines.push(`The person: ${it.text}`);
    else if (it.kind === 'agent' && it.text.trim() !== '') lines.push(`${models.find((m) => m.id === it.modelId)?.label ?? 'Agent'}: ${it.text.trim()}`);
    else if (it.kind === 'run') lines.push(`(The flow "${it.flowName}" ran here.)`);
  }
  let out = lines.join('\n\n');
  if (out.length > TRANSCRIPT_CHARS) out = `(earlier messages left out)\n\n${out.slice(-TRANSCRIPT_CHARS)}`;
  return out;
}

export class Controller {
  private readonly store: Store;
  private readonly emitRaw: (e: AppEvent) => void;
  private readonly openPage: ControllerOptions['openPage'];
  private readonly webFetch: typeof fetch | undefined;
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
    addUsualDirs();
    this.openPage = opts.openPage;
    this.webFetch = opts.fetch;
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
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          busy: this.chats.has(s.id) || runs.some((r) => r?.status === 'running' || r?.status === 'waiting'),
          waiting: runs.some((r) => r?.status === 'waiting') || s.items.some((i) => (i.kind === 'flow-request' || i.kind === 'needs-jev') && i.status === 'pending'),
        };
      });
  }

  getState() {
    return { projects: this.projectList(), sessions: this.summaries(), flows: this.flows(), settings: this.settings };
  }

  /** The projects, each marked when its folder has gone. */
  private projectList(): Project[] {
    return this.projects.map((p) => (existsSync(p.path) ? p : { ...p, missing: true }));
  }

  async projectHealth(id: string): Promise<ProjectHealth | null> {
    const p = this.projects.find((x) => x.id === id);
    return p === undefined ? null : projectHealth(p.path);
  }

  async setUpGit(id: string): Promise<{ ok: boolean; message: string }> {
    const p = this.projects.find((x) => x.id === id);
    if (p === undefined) return { ok: false, message: 'That project is gone.' };
    try {
      await setUpGit(p.path);
      return { ok: true, message: `${p.name} is a git repository now, with one commit of what was there.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Why work cannot happen in this project's folder, or null. */
  private folderGone(s: Session): string | null {
    const p = this.projects.find((x) => x.id === s.projectId);
    if (p === undefined) return 'This session belongs to a project that was removed.';
    if (!existsSync(p.path)) return `The folder ${p.path} is gone. Move it back, or remove ${p.name} from the sidebar.`;
    return null;
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

  private notice(s: Session, text: string, tone: 'info' | 'warn' | 'error' = 'info', fix?: SetupFix[]): void {
    this.push(s, { kind: 'notice', id: newId('n'), ts: nowIso(), text, tone, ...(fix === undefined || fix.length === 0 ? {} : { fix }) });
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
    this.emitRaw({ type: 'projects', projects: this.projectList() });
    return project;
  }

  removeProject(id: string): void {
    for (const s of [...this.sessions.values()]) if (s.projectId === id) this.deleteSession(s.id);
    this.projects = this.projects.filter((p) => p.id !== id);
    this.store.saveProjects(this.projects);
    this.emitRaw({ type: 'projects', projects: this.projectList() });
  }

  createSession(projectId: string): Session {
    if (!this.projects.some((p) => p.id === projectId)) throw new Error('That project is gone.');
    // An untouched session in the project is the new session: pressing + twice makes one, not two.
    const empty = [...this.sessions.values()].find((x) => x.projectId === projectId && x.items.length === 0 && x.title === 'New session' && x.archived !== true);
    if (empty !== undefined) {
      // It was never used, so it counts as made now: the sidebar lists sessions newest first.
      empty.createdAt = nowIso();
      empty.updatedAt = nowIso();
      this.touchSession(empty, true);
      return empty;
    }
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
    const before = s.chat.modelId;
    s.chat = { ...s.chat, ...patch };
    if (patch.modelId !== undefined && patch.modelId !== before && s.items.some((i) => i.kind === 'agent')) {
      const next = this.model(patch.modelId);
      this.notice(s, `Switched to ${next.label}. It reads the conversation so far before your next message.`);
    }
    // New sessions start from the model and effort you picked last, not from a fixed default.
    if (patch.modelId !== undefined || patch.effort !== undefined) {
      this.settings = { ...this.settings, chatDefault: { modelId: s.chat.modelId, effort: s.chat.effort } };
      this.store.saveSettings(this.settings);
      this.emitRaw({ type: 'settings', settings: this.settings });
    }
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
    // `/quick-fix add multiply` runs Quick fix, whatever the picker says.
    const command = parseFlowCommand(body, this.flows());
    // A message for the chat while the agent is still answering waits its turn. A flow does not
    // wait: it runs beside the chat. Auto might pick the chat, so it waits too.
    if (command === null && (flowId === null || flowId === 'auto') && this.chats.has(s.id)) return this.enqueue(s, body, flowId);
    // The first message names the session, unless you named it already.
    if (s.title === 'New session' && s.items.every((i) => i.kind !== 'user')) s.title = titleFrom(body.replace(/^\/[a-z0-9-]+\s*/i, '') || body);

    if (command !== null) {
      this.push(s, { kind: 'user', id: newId('u'), ts: nowIso(), text: body, flowId: command.flow.id });
      if (command.objective === '') return this.notice(s, `Say what "${command.flow.name}" should do after /${flowCommand(command.flow)}.`, 'warn');
      return await this.startOrSay(s, command.flow, command.objective, { kind: 'you' });
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
    await this.startOrSay(s, flow, body, starter);
  }

  /** One queued message per session: a second send while one waits is added to the end of it. */
  private enqueue(s: Session, text: string, flowId: string | null): void {
    s.queued = s.queued === undefined ? { text, flowId, ts: nowIso() } : { text: `${s.queued.text}\n\n${text}`, flowId, ts: s.queued.ts };
    this.touchSession(s, true);
  }

  editQueued(sessionId: string, text: string | null): void {
    const s = this.sessions.get(sessionId);
    if (s?.queued === undefined) return;
    if (text === null || text.trim() === '') delete s.queued;
    else s.queued = { ...s.queued, text: text.trim() };
    this.touchSession(s, true);
  }

  async sendQueued(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    const q = s?.queued;
    if (s === undefined || q === undefined || this.chats.has(s.id)) return;
    delete s.queued;
    this.touchSession(s, true);
    await this.send(s.id, q.text, q.flowId);
  }

  /** The reply ended: send what was queued, unless the reply failed or you stopped it. Then it waits for you. */
  private afterReply(s: Session, status: AgentStatus): void {
    if (s.queued === undefined || !this.sessions.has(s.id)) return;
    if (status === 'done') {
      void this.sendQueued(s.id).catch((err: unknown) => console.error(err));
      return;
    }
    s.queued.held = status === 'error' ? 'error' : 'stopped';
    this.touchSession(s, true);
  }

  private async startOrSay(s: Session, flow: Flow, objective: string, by: RunStarter): Promise<void> {
    const blocked = await this.blockers(s, flow);
    if (blocked !== null) return this.notice(s, blocked.text, 'error', blocked.fix);
    if (await this.askForJev(s, flow, objective, by)) return;
    const res = this.startFlow(s, flow, objective, by);
    if (typeof res === 'string') this.notice(s, res, 'error');
  }

  /**
   * The CLIs this flow's agent steps run on that this Mac does not have, each with its steps. A
   * flow with a missing CLI would run until that step and fail there, after the others were paid for.
   */
  private missingClis(flow: Flow): { harness: 'claude' | 'codex'; steps: string[]; byStage: boolean }[] {
    const out = new Map<'claude' | 'codex', { harness: 'claude' | 'codex'; steps: string[]; byStage: boolean }>();
    for (const n of flow.nodes) {
      if (n.type !== 'agent') continue;
      const cfg = n.data;
      const model = this.model(cfg.modelId ?? this.settings.stageDefaults[cfg.role].modelId);
      if (findBin(model.harness, this.settings) !== null) continue;
      const entry = out.get(model.harness) ?? { harness: model.harness, steps: [], byStage: true };
      entry.steps.push(cfg.label);
      if (cfg.modelId !== undefined) entry.byStage = false;
      out.set(model.harness, entry);
    }
    return [...out.values()];
  }

  /** Why this flow cannot start on this machine and in this folder, said with the fix, or null. */
  private async blockers(s: Session, flow: Flow): Promise<{ text: string; fix: SetupFix[] } | null> {
    const project = this.projects.find((p) => p.id === s.projectId);
    if (project === undefined || !existsSync(project.path)) return null;
    const lines: string[] = [];
    const fix: SetupFix[] = [];
    const quote = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ');
    for (const m of this.missingClis(flow)) {
      const one = m.steps.length === 1;
      let line = `${quote(m.steps)} ${one ? 'runs' : 'run'} on ${m.harness}, which is not installed.`;
      if (m.harness === 'codex') {
        line += m.byStage
          ? ` Install it, or pick a claude model for ${one ? 'that stage' : 'those stages'} in Settings under "Models at each stage".`
          : ` Install it, or give ${one ? 'that step' : 'those steps'} a claude model on the flow's canvas.`;
      }
      lines.push(line);
      fix.push(m.harness);
    }
    // Only a flow that works on its own branch needs a repository; a web lookup does not.
    if (writesOnBranch(flow)) {
      const h = await projectHealth(project.path);
      if (h.git !== 'ok') {
        lines.push(h.git === 'none' ? `${project.name} is not a git repository, and this flow works on a branch of its own.` : `${project.name} has no commits yet, so this flow has nothing to branch from.`);
        fix.push('repo');
      }
    }
    if (lines.length === 0) return null;
    return { text: `${flow.name} did not start. ${lines.join(' ')}`, fix };
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

  /**
   * One chat turn. `text` is the person's message, or with `origin: 'run-ended'` a note that a flow
   * the agent started has ended, so it can tell the person how it went without being asked.
   */
  private async chat(s: Session, text: string, origin: 'person' | 'run-ended' = 'person'): Promise<void> {
    const project = this.projects.find((p) => p.id === s.projectId);
    const gone = this.folderGone(s);
    if (project === undefined || gone !== null) return this.notice(s, gone ?? 'This session belongs to a project that was removed.', 'error');
    if (this.chats.has(s.id)) return this.notice(s, 'The agent is still answering. Stop it first, or wait.', 'warn');
    const model = this.model(s.chat.modelId);
    const earlier = s.items.slice();
    const item: Extract<SessionItem, { kind: 'agent' }> = { kind: 'agent', id: newId('a'), ts: nowIso(), modelId: model.id, text: '', tools: [], status: 'running' };
    this.push(s, item);
    const ctl = new AbortController();
    this.chats.set(s.id, ctl);
    this.touchSession(s, true);
    const resume = s.chat.harnessModelId === model.id ? s.chat.harnessSessionId : undefined;
    // The start_flow tool, only when some flow lets an agent start it. Its key dies with this turn.
    // A report on a finished run gets no tool: an agent that started a flow in it would report on
    // that one too, and start another, and so on.
    const offerFlows = origin === 'person' && this.agentFlows().length > 0;
    const jevWeb = origin === 'person' && this.jevWeb();
    const tools = this.bridge !== null && (offerFlows || jevWeb) ? this.bridge.open({ sessionId: s.id, model: model.label, flows: offerFlows, web: jevWeb, signal: ctl.signal }) : null;
    // What happened since the agent last spoke: runs it started that finished, requests you answered.
    const news = s.chat.news ?? [];
    delete s.chat.news;
    const instructions = chatInstructions({
      flows: tools === null || !offerFlows ? null : this.flowLines(),
      web: tools !== null && jevWeb,
      readOnly: !s.chat.edits,
      // A new model starts a new conversation in its CLI; the thread so far comes with it.
      transcript: resume === undefined ? transcriptOf(earlier, this.settings.models) : '',
    });
    const newsText = news.length === 0 ? '' : `Since your last turn:\n${news.map((n) => `- ${n}`).join('\n')}`;
    const prompt =
      origin === 'run-ended'
        ? `${newsText}\n\nThe person has not said anything new. Tell them in a few sentences what the flow found or did, and what they might do next.`
        : newsText === ''
          ? text
          : `${newsText}\n\nThe person's message:\n${text}`;
    try {
      const res = await runAgent({
        harness: model.harness,
        model: model.model,
        effort: fitEffort(model, s.chat.effort),
        role: s.chat.edits ? 'engineer' : 'scout',
        // Jev's web tools when there is a working key. The CLI's own search stays, as the backup for
        // when every search engine turns Jev's search away, and as the only search without a key.
        web: true,
        cwd: project.path,
        prompt,
        ...(instructions === '' ? {} : { instructions }),
        ...(tools === null ? {} : { mcp: [tools.spec] }),
        label: `chat-${s.id.slice(-6)}`,
        brief: false,
        ...(resume === undefined ? {} : { resume }),
        ...(resume === undefined || s.chat.harnessTokens === undefined ? {} : { tokensBefore: s.chat.harnessTokens }),
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
      if (res.harnessTokens !== undefined) s.chat.harnessTokens = res.harnessTokens;
      else delete s.chat.harnessTokens;
    } catch (err) {
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
    } finally {
      tools?.close();
      this.chats.delete(s.id);
      this.touchSession(s, true);
      this.afterReply(s, item.status);
    }
  }

  /** The last key Jev was asked with, and whether TypeSafe took it. */
  private jevKnown: { key: string; ok: boolean; setup: boolean; detail: string } | null = null;

  /** Whether agents search the web through Jev: a key TypeSafe has not refused. */
  private jevWeb(): boolean {
    const key = this.settings.typesafe.apiKey.trim();
    if (key === '') return false;
    return !(this.jevKnown?.key === key && !this.jevKnown.ok && this.jevKnown.setup);
  }

  /**
   * Why this flow cannot reach Jev, or null when it can. No key, or a key TypeSafe refused. A key
   * not yet tried is tried now, with one small question, so a bad key stops the flow before its
   * agents are paid for rather than at its first decision.
   */
  private async jevProblem(flow: Flow): Promise<{ steps: string[]; refused?: string } | null> {
    const steps = jevSteps(flow);
    if (steps.length === 0) return null;
    const key = this.settings.typesafe.apiKey.trim();
    if (key === '') return { steps };
    if (this.jevKnown?.key !== key) await this.testJev();
    const known = this.jevKnown;
    // Only a refused key blocks. TypeSafe being slow or unreachable is left for the run to meet.
    if (known !== null && known.key === key && !known.ok && known.setup) return { steps, refused: known.detail };
    return null;
  }

  /**
   * A flow that needs Jev, with no key: put a card in the thread that takes the key and starts the
   * flow, instead of an error that sends you to Settings and back. True when it did.
   */
  private async askForJev(s: Session, flow: Flow, objective: string, by: RunStarter): Promise<boolean> {
    const problem = await this.jevProblem(flow);
    if (problem === null) return false;
    this.push(s, {
      kind: 'needs-jev',
      id: newId('nj'),
      ts: nowIso(),
      flowId: flow.id,
      flowName: flow.name,
      objective,
      steps: problem.steps,
      ...(problem.refused === undefined ? {} : { refused: problem.refused }),
      starter: by,
      status: 'pending',
    });
    this.touchSession(s, true);
    return true;
  }

  async connectJev(sessionId: string, itemId: string, apiKey: string | null): Promise<{ ok: boolean; message: string }> {
    const s = this.sessions.get(sessionId);
    const item = s?.items.find((i) => i.id === itemId);
    if (s === undefined || item === undefined || item.kind !== 'needs-jev' || item.status !== 'pending') return { ok: false, message: 'This card is no longer waiting.' };
    if (apiKey === null) {
      item.status = 'dismissed';
      if (item.starter.kind === 'agent') s.chat.news = [...(s.chat.news ?? []), `"${item.flowName}" did not start: the person has not added a TypeSafe key.`];
      this.touchSession(s, true);
      return { ok: true, message: '' };
    }
    const key = apiKey.trim();
    if (key === '') return { ok: false, message: 'Paste the key first.' };
    // A key already saved elsewhere, say from Settings in the meantime, is kept unless this one works.
    const before = this.settings.typesafe.apiKey;
    this.settings = { ...this.settings, typesafe: { ...this.settings.typesafe, apiKey: key } };
    const test = await this.testJev();
    if (!test.ok) {
      this.settings = { ...this.settings, typesafe: { ...this.settings.typesafe, apiKey: before } };
      return { ok: false, message: test.detail.replace(/ Paste a working key in Settings under Jev\.$/, '') };
    }
    this.saveSettings(this.settings);
    const flow = this.flows().find((f) => f.id === item.flowId);
    if (flow === undefined) {
      item.status = 'dismissed';
      this.touchSession(s, true);
      return { ok: false, message: `The key works, but "${item.flowName}" no longer exists.` };
    }
    const run = this.startFlow(s, flow, item.objective, item.starter);
    if (typeof run === 'string') return { ok: false, message: run };
    item.status = 'started';
    item.runId = run.id;
    this.touchSession(s, true);
    return { ok: true, message: test.detail };
  }

  /** Start a run in this session, or say why not. Every way of starting a flow ends here. */
  private startFlow(s: Session, flow: Flow, objective: string, by: RunStarter, parent?: { runId: string; depth: number }): Run | string {
    const project = this.projects.find((p) => p.id === s.projectId);
    const gone = this.folderGone(s);
    if (project === undefined || gone !== null) return gone ?? 'This session belongs to a project that was removed.';
    // Refuse before anything is spent, rather than fail at the first Jev node halfway through.
    const jevNodes = jevSteps(flow);
    if (jevNodes.length > 0 && this.settings.typesafe.apiKey.trim() === '') {
      return `"${flow.name}" uses Jev in ${jevNodes.map((l) => `"${l}"`).join(', ')}, and there is no TypeSafe API key. Add one in Settings, then send again.`;
    }
    const run = createRun({ id: newId('run'), flow, sessionId: s.id, projectId: project.id, objective });
    run.startedBy = by;
    if (parent !== undefined) {
      run.parentRunId = parent.runId;
      run.depth = parent.depth;
    }
    this.runs.set(run.id, run);
    const runItem: SessionItem = { kind: 'run', id: newId('r'), ts: nowIso(), runId: run.id, flowId: flow.id, flowName: flow.name };
    this.push(s, runItem);
    // Uncommitted work is not in the run, which starts from the last commit. Say so above the run
    // card, as it starts, not under it once it has finished without them.
    void projectHealth(project.path).then((h) => {
      // Only a flow that works on a branch leaves your uncommitted work out; a web lookup does not care.
      if (h.dirty === 0 || parent !== undefined || !writesOnBranch(flow)) return;
      const at = s.items.indexOf(runItem);
      const text = `${h.dirty} ${h.dirty === 1 ? 'file has' : 'files have'} uncommitted changes, and this run starts from your last commit, so it will not see ${h.dirty === 1 ? 'it' : 'them'}. Commit first if the run needs ${h.dirty === 1 ? 'it' : 'them'}.`;
      s.items.splice(at < 0 ? s.items.length : at, 0, { kind: 'notice', id: newId('n'), ts: nowIso(), text, tone: 'warn' });
      this.touchSession(s, true);
    });
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
      // The agent that started it reports back on its own, unless you stopped the run or are
      // talking to it already; then it hears at the start of its next turn.
      if (by.kind === 'agent' && r.status !== 'stopped' && !this.chats.has(s.id) && this.sessions.has(s.id)) void this.chat(s, '', 'run-ended');
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

  /** One line per flow an agent may start, as the tool and the chat note list them. */
  private flowLines(): string[] {
    return this.agentFlows().map(({ flow, ask }) => `- ${flowCommand(flow)}: ${flow.name}. ${flow.description}${ask ? ' (Calling it shows the person a card; the flow starts if they approve.)' : ' (Starts as soon as you call it.)'}`);
  }

  readonly flowTools: ToolHandler = {
    list: (caller: ToolCaller): ToolDescription[] => {
      const flows = this.agentFlows();
      const lines = this.flowLines();
      const web: ToolDescription[] = [
        {
          name: 'jev_search',
          description:
            'Search the web. Jev, a fast judgment model, opens the likeliest results and picks the passages that answer your question. ' +
            'Returns those passages in the pages\' own words, with links, how sure Jev is that they answer it, and the other results. ' +
            'Takes a few seconds and opens nothing on screen.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search words, as you would type them into a search engine.' },
              question: { type: 'string', description: 'The question the passages must answer, in full. Defaults to the query.' },
            },
            required: ['query'],
          },
        },
        {
          name: 'read_page',
          description: "Read one public web page and have Jev pick the passages that answer your question. Returns them in the page's own words, and how sure Jev is.",
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The page, http or https.' },
              question: { type: 'string', description: 'What you want from the page.' },
            },
            required: ['url', 'question'],
          },
        },
      ];
      if (!caller.flows) return caller.web ? web : [];
      return [
        ...(caller.web ? web : []),
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
    call: async (caller: ToolCaller, name: string, args: Record<string, unknown>) => {
      if ((name === 'jev_search' || name === 'read_page') && caller.web) return this.webTool(name, args, caller.signal);
      if (name !== 'start_flow' || !caller.flows) return { text: `There is no tool called ${name}.`, isError: true };
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
      const asking = s.items.filter((i) => (i.kind === 'flow-request' || (i.kind === 'needs-jev' && i.starter.kind === 'agent')) && i.status === 'pending').length;
      if (going + asking >= MAX_AGENT_RUNS) {
        return { text: `You already have ${String(MAX_AGENT_RUNS)} flows running or waiting for approval in this conversation. Wait for one to end.`, isError: true };
      }
      const { flow, ask } = entry;
      // With no key, the card that asks for it also asks whether to start: pasting the key is the yes.
      if (await this.askForJev(s, flow, objective, { kind: 'agent', model: caller.model, approved: ask })) {
        return {
          text: `"${flow.name}" uses Jev, and the person has no working TypeSafe key yet. The app shows them a card to paste one; the flow starts when they do, and you will hear how it went at the start of your next turn. Tell them in a sentence; do not ask them to go to Settings.`,
        };
      }
      if (ask) {
        this.push(s, { kind: 'flow-request', id: newId('fr'), ts: nowIso(), flowId: flow.id, flowName: flow.name, objective, model: caller.model, why, status: 'pending' });
        return { text: `Asked the person to approve starting "${flow.name}". It starts if they approve, and you will hear how it went at the start of your next turn. Tell them what you asked for and why.` };
      }
      const run = this.startFlow(s, flow, objective, { kind: 'agent', model: caller.model, approved: false });
      if (typeof run === 'string') return { text: run, isError: true };
      return { text: `Started "${flow.name}" as run ${run.id}. It shows in this conversation, and you will hear how it went at the start of your next turn.` };
    },
  };

  /** Jev's jev_search and read_page, for any agent given them. */
  private async webTool(name: 'jev_search' | 'read_page', args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError?: boolean }> {
    const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');
    const deps = { ...this.webDeps(), ...(signal === undefined ? {} : { signal }) };
    try {
      if (name === 'read_page') {
        if (str('url') === '') return { text: 'Give the url of the page to read.', isError: true };
        return { text: formatAnswer(await webRead(str('url'), str('question') || 'What does this page say?', deps)) };
      }
      if (str('query') === '') return { text: 'Give the search words in query.', isError: true };
      return { text: formatAnswer(await webSearch(str('query'), str('question') || str('query'), deps)) };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  private webDeps(): WebDeps {
    const brave = this.settings.braveApiKey?.trim() ?? '';
    return { jev: this.settings.typesafe, ...(brave === '' ? {} : { braveKey: brave }), ...(this.webFetch === undefined ? {} : { fetch: this.webFetch }) };
  }

  async answerFlowRequest(sessionId: string, requestId: string, approve: boolean, objective: string): Promise<void> {
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
    if (await this.askForJev(s, flow, req.objective, { kind: 'agent', model: req.model, approved: true })) {
      req.status = 'started';
      return;
    }
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
        // A step that may search gets Jev's web tools when there is a key, and its CLI's own search when not.
        const web = cfg.web ?? cfg.role === 'scout';
        const tools = web && this.jevWeb() && this.bridge !== null ? this.bridge.open({ sessionId: s.id, model: model.label, flows: false, web: true, signal: req.signal }) : null;
        try {
          return await runAgent({
            harness: model.harness,
            model: model.model,
            effort: fitEffort(model, cfg.effort ?? stage.effort),
            role: cfg.role,
            web,
            ...(tools === null ? {} : { mcp: [tools.spec], instructions: WEB_NOTE }),
            cwd: req.cwd,
            prompt: req.prompt,
            label: `${slug(cfg.label) || 'agent'}-${visit}`,
            brief: true,
            ...(req.resume === undefined ? {} : { resume: req.resume }),
            ...(req.tokensBefore === undefined ? {} : { tokensBefore: req.tokensBefore }),
            settings: this.settings,
            signal: req.signal,
            onTurn: req.onTurn,
          });
        } finally {
          tools?.close();
        }
      },
      search: async (req) => {
        const a = await webSearch(req.query, req.question, { ...this.webDeps(), signal: req.signal, onProgress: req.onProgress });
        return { output: formatAnswer(a), answered: a.answered, model: a.model, latencyMs: a.jevMs };
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
      judge: async (req) => {
        try {
          return await judge(this.settings.typesafe, req.config, req.question, req.state, req.signal);
        } catch (err) {
          // The next flow checks the key again instead of trusting an earlier yes.
          if ((err as { setup?: unknown }).setup === true) this.jevKnown = null;
          throw err;
        }
      },

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
    const res = await mergeRun(r, project.path, `${r.flowName}: ${titleFrom(r.objective).replace(/…$/, '')}\n\n${r.objective}`);
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
    // A CLI installed since the app started is on the shell's PATH now, not on the app's.
    await refreshPath();
    const version = (bin: string, args: string[]) =>
      new Promise<{ ok: boolean; detail: string }>((res) => {
        execFile(bin, args, { timeout: 10_000 }, (err, stdout, stderr) => {
          if (err === null) return res({ ok: true, detail: String(stdout).trim().split('\n')[0] ?? '' });
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
          const said = String(stderr).trim().split('\n')[0]?.slice(0, 160) ?? '';
          res({ ok: false, detail: missing ? (bin.includes('/') ? `Not found at ${bin}.` : 'Not installed on this Mac.') : `"${bin} ${args.join(' ')}" failed.${said === '' ? '' : ` ${said}`}` });
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
    const key = this.settings.typesafe.apiKey.trim();
    try {
      const r = await askJev(this.settings.typesafe, 'The build passed.', { ok: { type: 'noul', instructions: 'Did the build pass?' } });
      const detail = `${r.model} answered in ${String(r.latencyMs)} ms`;
      this.jevKnown = { key, ok: true, setup: false, detail };
      return { ok: true, detail };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.jevKnown = { key, ok: false, setup: (err as { setup?: unknown }).setup === true, detail };
      return { ok: false, detail };
    }
  }

  /** Stop everything and write what is pending. */
  async shutdown(): Promise<void> {
    this.bridge?.stop();
    for (const c of this.chats.values()) c.abort();
    const cut = [...this.handles.keys()];
    const waits = [...this.handles.values()].map((h) => {
      h.stop();
      return h.done;
    });
    await Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, 4000))]);
    // A run cut off by quitting says so, rather than reading as if you pressed Stop.
    for (const id of cut) {
      const r = this.runs.get(id);
      if (r !== undefined && r.status === 'stopped' && r.error === undefined) {
        r.error = 'The app closed while this run was going. Start it again to redo it.';
        this.store.saveRunSoon(r);
      }
    }
    // Whatever did not stop in time is killed, process group and all.
    killAllAgents();
    this.store.flush();
  }

  busy(): boolean {
    return this.chats.size > 0 || this.handles.size > 0;
  }
}
