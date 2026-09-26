/**
 * Types shared by the main process, the preload bridge and the renderer. Nothing in this file
 * imports from Node or from the DOM, so every side can read it.
 */

export type Harness = 'claude' | 'codex';
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type Effort = (typeof EFFORTS)[number];

/** A model you can put on a node. `id` is ours; `model` is what the vendor CLI receives. */
export interface ModelEntry {
  id: string;
  harness: Harness;
  model: string;
  label: string;
  /** The effort levels this model accepts, lowest first. Absent means the harness's usual set. */
  efforts?: Effort[];
  /** One line on what the model is for, from the vendor's list. */
  description?: string;
  /** Where the entry came from: the app's claude list, codex's own model list, or you. */
  source?: 'claude' | 'codex' | 'you';
}

/**
 * What an agent node is allowed to do. Each maps onto the engine's rank and role tables, so the
 * tool allow-list and deny-list come from the same place the CLI's campaigns take them.
 */
export const AGENT_ROLES = ['scout', 'planner', 'engineer', 'reviewer', 'validator'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const ROLE_INFO: Record<AgentRole, { label: string; summary: string; writes: boolean }> = {
  scout: { label: 'Scout', summary: 'Reads the code and the web. Changes nothing.', writes: false },
  planner: { label: 'Planner', summary: 'Reads the code and writes a plan. No shell, no edits.', writes: false },
  engineer: { label: 'Engineer', summary: 'Edits files and runs commands in its workspace.', writes: true },
  reviewer: { label: 'Reviewer', summary: 'Reads and runs tests. Cannot edit.', writes: false },
  validator: { label: 'Validator', summary: 'Runs the checks and judges against the objective. Cannot edit.', writes: false },
};

export interface StageDefault {
  modelId: string;
  effort: Effort;
}

export interface Settings {
  models: ModelEntry[];
  /** The model each role gets when a node does not name one. */
  stageDefaults: Record<AgentRole, StageDefault>;
  /** The model a new chat starts on. */
  chatDefault: StageDefault;
  typesafe: { apiKey: string; model: string; baseUrl: string };
  /** `unguarded` keeps each role's tools but drops argv scoping on the shell. */
  posture: 'guarded' | 'unguarded';
  claudeBin: string;
  codexBin: string;
  theme: 'system' | 'dark' | 'light';
  /**
   * Every model the app has offered, as `harness:model`. A listed model you removed stays in here,
   * so it is not added back the next time the app reads the vendor lists.
   */
  offeredModels?: string[];
  /** The most any flow may allow. A flow set higher is held to this. Absent means `agent-ask`. */
  invokeCeiling?: InvokeLevel;
}

/**
 * Who may start a flow, lowest first. Each level includes the ones before it: you can always
 * start a flow, `auto` adds Jev choosing it for a message you sent in Auto, and the agent levels
 * let a chat agent start it with its `start_flow` tool, after you approve or without asking.
 * A Run flow node is not on this scale: you put it in a flow you built, so it is your call.
 */
export const INVOKE_LEVELS = ['you', 'auto', 'agent-ask', 'agent'] as const;
export type InvokeLevel = (typeof INVOKE_LEVELS)[number];

export const INVOKE_INFO: Record<InvokeLevel, { label: string; summary: string }> = {
  you: { label: 'Only you', summary: 'Starts only when you pick it or type its command.' },
  auto: { label: 'You, and Jev in Auto', summary: 'Jev may also pick it for a message you send in Auto.' },
  'agent-ask': { label: 'Agents too, with your approval', summary: 'A chat agent may ask to start it. You see a card and approve, edit or decline.' },
  agent: { label: 'Agents too, without asking', summary: 'A chat agent may start it on its own. The run still shows in the thread, marked with who started it.' },
};

/** Who started a run. */
export type RunStarter =
  | { kind: 'you' }
  | { kind: 'jev'; confidence: number }
  | { kind: 'agent'; model: string; approved: boolean }
  | { kind: 'flow'; runId: string; flowName: string; node: string };

export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  /** Set by the app when the folder is no longer there. Never saved. */
  missing?: boolean;
}

/** What flows need from a project folder. */
export interface ProjectHealth {
  exists: boolean;
  /** `none`: not a repository. `no-commits`: nothing to branch from yet. */
  git: 'ok' | 'none' | 'no-commits';
  /** Files with changes not yet committed. A run branches from the last commit, so it leaves these out. */
  dirty: number;
}

// ------------------------------------------------------------------------------------------------
// Sessions
// ------------------------------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  /** One line a person can read: the command, the file, the pattern. */
  summary: string;
  status: 'running' | 'ok' | 'error';
  /** How much of the turn's text came before this call, so the thread shows it where it happened. */
  at?: number;
}

export type AgentStatus = 'running' | 'done' | 'error' | 'stopped';

/** Tokens one turn read and wrote, as claude or codex reported them. */
export interface TokenCount {
  /** Every token the model read over the turn, from the cache or not. */
  input: number;
  /** The part of `input` read from the prompt cache. */
  cached: number;
  output: number;
  /** How full the model's context was on its last request. claude reports it; codex does not. */
  context?: number;
}

/** One agent turn's worth of output, as a session or a run node shows it. */
export interface AgentTurn {
  /** Everything the agent said, with a paragraph break wherever a tool call sat. */
  text: string;
  /** What it said after its last tool call. This is what the next node receives. */
  final?: string;
  tools: ToolCall[];
  status: AgentStatus;
  /** What the CLI says the turn would cost at API prices. Kept, not shown: a subscription pays nothing per turn. */
  costUsd?: number;
  tokens?: TokenCount;
  error?: string;
}

export type SessionItem =
  | { kind: 'user'; id: string; ts: string; text: string; flowId?: string }
  | ({ kind: 'agent'; id: string; ts: string; modelId: string } & AgentTurn)
  | { kind: 'run'; id: string; ts: string; runId: string; flowId: string; flowName: string }
  | {
      kind: 'flow-request';
      id: string;
      ts: string;
      flowId: string;
      flowName: string;
      objective: string;
      /** The model that asked, by its label. */
      model: string;
      why: string;
      status: 'pending' | 'started' | 'declined';
      runId?: string;
    }
  | {
      /** A flow that uses Jev was about to start with no TypeSafe key. The card takes the key and starts it. */
      kind: 'needs-jev';
      id: string;
      ts: string;
      flowId: string;
      flowName: string;
      objective: string;
      /** The steps that ask Jev, by label, so the card can say where Jev comes in. */
      steps: string[];
      /** Set when there was a key and TypeSafe refused it: what it said. */
      refused?: string;
      starter: RunStarter;
      status: 'pending' | 'started' | 'dismissed';
      runId?: string;
    }
  | { kind: 'notice'; id: string; ts: string; text: string; tone: 'info' | 'warn' | 'error' };

export interface Session {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: SessionItem[];
  /** The chat's agent. Changing the model starts a fresh harness conversation. */
  chat: {
    modelId: string;
    effort: Effort;
    /** Engineer when true, scout when false. */
    edits: boolean;
    /** The harness's own conversation id, for resume. */
    harnessSessionId?: string;
    harnessModelId?: string;
    /** What happened since the agent's last turn, told to it at the start of the next. */
    news?: string[];
    /** codex counts tokens for the whole conversation, so the next turn subtracts this. */
    harnessTokens?: TokenCount;
  };
  archived?: boolean;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  updatedAt: string;
  busy: boolean;
  /** A run in this session is waiting on you. */
  waiting: boolean;
}

// ------------------------------------------------------------------------------------------------
// Flows
// ------------------------------------------------------------------------------------------------

export const NODE_TYPES = ['start', 'agent', 'decide', 'human', 'shell', 'git', 'browser', 'flow', 'join', 'end'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export type Workspace = 'run' | 'project';

export interface StartConfig {
  label: string;
}
export interface AgentConfig {
  label: string;
  role: AgentRole;
  /** Null means the role's stage default from settings. */
  modelId: string | null;
  effort: Effort | null;
  prompt: string;
  workspace: Workspace;
  /** On a second visit, continue the same conversation rather than start fresh. */
  keepContext: boolean;
  maxVisits: number;
  /** Search and read the web with the CLI's own tools. Unset means the role decides: only a scout can. */
  web?: boolean;
}
export interface DecideOption {
  key: string;
  description: string;
}
export interface DecideConfig {
  label: string;
  mode: 'choice' | 'yesno' | 'score';
  question: string;
  /** What Jev reads. Defaults to the input. */
  state: string;
  options: DecideOption[];
  /** yes/no: the probability at or above which the answer is yes. */
  threshold: number;
  /** score: ordered levels, lowest first. */
  levels: string[];
  /** score: at or above this level index the output is `high`. */
  cut: number;
  /** Below this confidence (choice, score) or this distance from 0.5 (yes/no), take `unsure`. */
  minConfidence: number;
  maxVisits: number;
}
export interface HumanConfig {
  label: string;
  prompt: string;
}
export interface ShellConfig {
  label: string;
  command: string;
  workspace: Workspace;
  timeoutSec: number;
  maxVisits: number;
}
export interface GitConfig {
  label: string;
  action: 'diff' | 'commit' | 'merge';
  message: string;
}
export interface BrowserConfig {
  label: string;
  goal: string;
  startUrl: string;
  maxSteps: number;
  /** Ask Jev whether each action is risky before it runs. */
  guard: boolean;
  /** At or above this risk, pause and ask you. */
  guardThreshold: number;
  showWindow: boolean;
}
export interface FlowCallConfig {
  label: string;
  /** The flow to run. */
  flowId: string;
  /** Its objective, as a template. */
  objective: string;
}
export interface JoinConfig {
  label: string;
}
export interface EndConfig {
  label: string;
  template: string;
  /**
   * How a run that ends here counts. A "Tests failed" end is a failed run, not a green one, and
   * "you rejected the design" is a stopped one. Default success.
   */
  outcome?: 'success' | 'failure' | 'stopped';
}

export interface NodeConfigs {
  start: StartConfig;
  agent: AgentConfig;
  decide: DecideConfig;
  human: HumanConfig;
  shell: ShellConfig;
  git: GitConfig;
  browser: BrowserConfig;
  flow: FlowCallConfig;
  join: JoinConfig;
  end: EndConfig;
}

export type FlowNode = {
  [K in NodeType]: { id: string; type: K; position: { x: number; y: number }; data: NodeConfigs[K] };
}[NodeType];

export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
}

export interface Flow {
  id: string;
  name: string;
  description: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  updatedAt: string;
  /** Shipped with the app. Editing one saves a copy. */
  builtin?: boolean;
  /** Who may start it. Absent means `auto`, what every flow allowed before this existed. */
  invoke?: InvokeLevel;
}

/** The output handles a node offers, in display order. */
export function outputHandles(node: FlowNode): string[] {
  switch (node.type) {
    case 'start':
      return ['out'];
    case 'agent':
      return ['out', 'error'];
    case 'decide': {
      const d = node.data;
      const base =
        d.mode === 'choice' ? d.options.map((o) => o.key) : d.mode === 'yesno' ? ['yes', 'no'] : ['high', 'low'];
      return d.minConfidence > 0 ? [...base, 'unsure'] : base;
    }
    case 'human':
      return ['approve', 'reject'];
    case 'shell':
      return ['pass', 'fail'];
    case 'git':
      return ['out', 'fail'];
    case 'browser':
      return ['done', 'failed'];
    case 'flow':
      return ['done', 'failed'];
    case 'join':
      return ['out'];
    case 'end':
      return [];
  }
}

export function hasInput(type: NodeType): boolean {
  return type !== 'start';
}

// ------------------------------------------------------------------------------------------------
// Runs
// ------------------------------------------------------------------------------------------------

export type NodeRunStatus = 'idle' | 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'stopped';

export interface NodeVisit {
  n: number;
  startedAt: string;
  endedAt?: string;
  input: string;
  output?: string;
  handle?: string;
  /** Agent nodes. */
  turn?: AgentTurn;
  /** Decide nodes: what Jev answered. */
  judgment?: Judgment;
  /** Browser nodes. */
  steps?: BrowserStep[];
  /** Anything else worth reading: shell output, git output, errors. */
  log?: string;
  error?: string;
}

export interface Judgment {
  /** The question as Jev got it, with the templates filled in. */
  question?: string;
  mode: DecideConfig['mode'];
  answer: string;
  probabilities: Record<string, number>;
  confidence: number;
  value?: number;
  model?: string;
  latencyMs?: number;
}

export interface BrowserStep {
  n: number;
  url: string;
  action: string;
  why: string;
  confidence: number;
  risk?: number;
  outcome: 'ran' | 'blocked' | 'approved' | 'refused' | 'failed' | 'done';
}

export interface NodeRunState {
  status: NodeRunStatus;
  visits: NodeVisit[];
}

export type RunStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'stopped';

export interface PendingQuestion {
  id: string;
  nodeId: string;
  kind: 'approve' | 'guard';
  title: string;
  body: string;
}

export interface Run {
  id: string;
  flowId: string;
  flowName: string;
  /** The flow as it was when the run began. Editing the flow later changes nothing here. */
  flow: Flow;
  sessionId: string;
  projectId: string;
  objective: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  nodes: Record<string, NodeRunState>;
  /** The worktree branch, once a node asked for the run workspace. */
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
  merged?: boolean;
  result?: string;
  error?: string;
  costUsd: number;
  /** Every agent turn's tokens, added up. Absent on runs from before this was recorded. */
  tokens?: TokenCount;
  pending: PendingQuestion[];
  /** Absent on runs from before this was recorded; those were all yours. */
  startedBy?: RunStarter;
  /** Set when a Run flow node started this run. */
  parentRunId?: string;
  /** How many Run flow nodes deep this run is. A run you start is 0. */
  depth?: number;
}

// ------------------------------------------------------------------------------------------------
// The bridge
// ------------------------------------------------------------------------------------------------

export interface DoctorReport {
  claude: { ok: boolean; detail: string };
  codex: { ok: boolean; detail: string };
  git: { ok: boolean; detail: string };
  typesafe: { ok: boolean; detail: string };
}

export interface DiffResult {
  stat: string;
  patch: string;
  truncated: boolean;
}

export type AppEvent =
  | { type: 'session'; session: Session }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'run'; run: Run }
  | { type: 'flows'; flows: Flow[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'projects'; projects: Project[] };

export interface Api {
  getState(): Promise<{
    projects: Project[];
    sessions: SessionSummary[];
    flows: Flow[];
    settings: Settings;
  }>;
  addProject(path?: string): Promise<Project | null>;
  removeProject(id: string): Promise<void>;
  createSession(projectId: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  setChat(id: string, chat: Partial<Session['chat']>): Promise<void>;
  send(sessionId: string, text: string, flowId: string | null): Promise<void>;
  stop(sessionId: string): Promise<void>;
  getRun(id: string): Promise<Run | null>;
  answer(runId: string, questionId: string, approve: boolean, text: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  /** Answer an agent's request to start a flow. `objective` replaces the agent's when you edited it. */
  answerFlowRequest(sessionId: string, requestId: string, approve: boolean, objective: string): Promise<void>;
  projectHealth(projectId: string): Promise<ProjectHealth | null>;
  /** A link from a reply: web links in the browser, file paths in their app, resolved against `base`. */
  openLink(href: string, base?: string): Promise<{ ok: boolean; message: string }>;
  /** `git init` if needed, then commit what is in the folder. */
  setUpGit(projectId: string): Promise<{ ok: boolean; message: string }>;
  /** Save a TypeSafe key from a needs-jev card, check it, and start the flow. `null` dismisses the card. */
  connectJev(sessionId: string, itemId: string, apiKey: string | null): Promise<{ ok: boolean; message: string }>;
  runDiff(runId: string): Promise<DiffResult>;
  mergeRun(runId: string): Promise<{ ok: boolean; message: string }>;
  saveFlow(flow: Flow): Promise<Flow>;
  deleteFlow(id: string): Promise<void>;
  saveSettings(settings: Settings): Promise<Settings>;
  doctor(): Promise<DoctorReport>;
  /** Read claude's and codex's model lists again and add any model not offered before. */
  refreshModels(): Promise<{ settings: Settings; added: string[] }>;
  testJev(): Promise<{ ok: boolean; detail: string }>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
