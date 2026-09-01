/**
 * `/work <id>`: one agent or one workstream, printed into scrollback.
 *
 * ## Why it prints
 *
 * Every other tool would open a pager here. This one cannot: a pager needs the alternate screen,
 * and the whole interface is built on not having one. No alternate screen, no absolute cursor
 * addressing, append-only scrollback, native scrolling and terminal copy still working. So the
 * snapshot is ordinary output, it lands above the composer like any other line, and the reader
 * scrolls it with the scrollbar they already have.
 *
 * ## Where the facts come from
 *
 * The `TreeModel` the status block is already drawing, plus two files in the agent's own archive
 * directory. Nothing is recomputed: the state, its provenance, the age and the last action are the
 * same fields `army view` prints, read off the same model, so a reader cannot be shown one story
 * by the block and another by the command that explains it.
 *
 * ## Everything model-written is sanitised
 *
 * `orders.md` is written by the supervisor, but it EMBEDS a worker's question, a human's answer
 * and a model-authored objective, and `diff` is entirely a worker's output. Both land on a
 * terminal. Wave 2 and wave 3 each shipped a defect where worker text was printed raw, and one of
 * them let a string erase a supervisor-owned heading and repaint a forged one. Every line this
 * file emits from a file goes through `sanitize`, and the ones that do not come from a file are
 * ids, paths and numbers this process minted.
 */

import { diffPath, ordersPath } from '../archive/paths.ts';
import { sanitize } from '../view/progress.ts';
import type { Charset } from '../view/render.ts';
import { clipTo, formatAge, glyphsFor } from '../view/render.ts';
import type { TaskNodeView, TreeModel, UnitNode } from '../view/tree.ts';
import { walkTree } from '../view/tree.ts';

/** File access, injected so the renderer stays testable without an archive on disk. */
export interface SnapshotFiles {
  /** File contents, or null when it is absent, unreadable, or larger than this reader will take. */
  read(file: string): string | null;
}

export interface WorkSnapshotInput {
  /** What the human typed after `/work`. An agent id or a task id. */
  id: string;
  /** The live tree, or null when no campaign has been read yet. */
  model: TreeModel | null;
  /** `<archiveRoot>/campaigns/<id>`, or null when there is no campaign to read files from. */
  campaignRoot: string | null;
  charset: Charset;
  width: number;
}

/**
 * How much of `orders.md` is printed before the reader is pointed at the file.
 *
 * A brief runs to hundreds of lines once a spec, a review gate and an answered question are in it.
 * Printing all of it would push the thing the reader asked about off their screen, which is the
 * failure mode a pager exists to avoid, and this command has no pager. Forty lines is the head of
 * the brief: the objective, the constraints and the top of the acceptance criteria.
 */
export const ORDERS_PREVIEW_LINES = 40;

/** A parsed `git diff` summary. Null counts mean the file was not there to read. */
export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * Count a unified diff, the way `--stat` does.
 *
 * Line-oriented and deliberately dumb: `+++`/`---` are headers and not content, `diff --git`
 * starts a file, and everything else is counted or ignored. It does not have to be `git`'s
 * arithmetic to the byte; it has to answer "is this a two-line change or a two-thousand-line one"
 * without spawning a process while a campaign is running.
 */
export function diffStat(patch: string): DiffStat {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files += 1;
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) insertions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { files, insertions, deletions };
}

interface Found {
  unit: UnitNode | null;
  task: TaskNodeView | null;
}

function find(model: TreeModel, id: string): Found {
  let unit: UnitNode | null = null;
  let task: TaskNodeView | null = null;
  for (const row of walkTree(model)) {
    if (row.node.kind === 'unit') {
      if (row.node.agentId === id) unit = row.node;
    } else if (row.node.taskId === id) task = row.node;
  }
  return { unit, task };
}

/** Ids the reader could have typed, so a miss is answered with an offer rather than a refusal. */
function knownIds(model: TreeModel): { agents: string[]; tasks: string[] } {
  const agents: string[] = [];
  const tasks: string[] = [];
  for (const row of walkTree(model)) {
    if (row.node.kind === 'unit') agents.push(row.node.agentId);
    else tasks.push(row.node.taskId);
  }
  return { agents, tasks };
}

export function renderWorkSnapshot(input: WorkSnapshotInput, files: SnapshotFiles): string {
  const g = glyphsFor(input.charset);
  const width = Math.max(40, input.width) - 1;
  const lines: string[] = [];
  // Every row goes through one clip, so nothing this command prints can wrap the composer's
  // arithmetic when it lands above a painted prompt.
  const push = (text: string): void => {
    lines.push(clipTo(text, width, g.ellipsis));
  };
  const field = (key: string, value: string): void => {
    push(`    ${key.padEnd(9, ' ')} ${value}`);
  };

  if (input.model === null) {
    return `  ${g.bullet} nothing is running, and no campaign has been read yet.\n`;
  }
  const { unit, task } = find(input.model, input.id);
  if (unit === null && task === null) {
    const ids = knownIds(input.model);
    push(`  ${g.bullet} no agent or workstream called ${JSON.stringify(input.id)} in this campaign.`);
    if (ids.agents.length > 0) field('agents', ids.agents.join(' '));
    if (ids.tasks.length > 0) field('workstreams', ids.tasks.join(' '));
    return `${lines.join('\n')}\n`;
  }

  if (unit !== null) {
    const state = unit.state;
    push(
      `  ${g.ranks[unit.rank]} ${unit.label} ${g.bullet} attempt ${String(unit.attempt)} ` +
        `${g.bullet} ${state.state} ${g.bullet} ${formatAge(state.ageMs)}`,
    );
    field('why', `${state.source}${state.detail === '' ? '' : ` ${g.dash} ${sanitize(state.detail)}`}`);
    field('task', unit.taskId ?? g.none);
    field('harness', `${unit.harness}${unit.model === null ? '' : ` ${g.bullet} ${unit.model}`}`);
    if (unit.worktreePath !== null) field('worktree', unit.worktreePath);
    if (unit.costUsd !== null) field('cost', `$${unit.costUsd.toFixed(2)}`);
    if (unit.note !== null) field('last said', sanitize(unit.note));
    // The branch belongs to the TASK, never to the agent: `armyBranch(taskId)` is what the
    // supervisor cut, and an agent's own account of which branch it used is model-controlled text
    // the campaign already reconciles in its notes. So it is read off the task or not at all.
    const owner =
      unit.taskId === null ? null : find(input.model, unit.taskId).task;
    if (owner !== null && owner.branch !== null) field('branch', owner.branch);
    appendFiles(input, files, unit.agentId, push, field, g);
    return `${lines.join('\n')}\n`;
  }

  const node = task as TaskNodeView;
  push(
    `  ${g.task} ${sanitize(node.title)} ${g.bullet} ${node.taskId} ${g.bullet} ${node.status} ` +
      `${g.bullet} ${formatAge(node.ageMs)}`,
  );
  field('branch', node.branch ?? g.none);
  if (node.prUrl !== null) field('pr', node.prUrl);
  field('attempts', String(node.attempts));
  for (const attempt of node.units) {
    push(
      `      ${g.ranks[attempt.rank]} ${attempt.labelShort} ${g.bullet} ${attempt.agentId} ` +
        `${g.bullet} #${String(attempt.attempt)} ${g.bullet} ${attempt.state.state} ` +
        `${g.bullet} ${formatAge(attempt.state.ageMs)}`,
    );
  }
  const current = node.currentAgentId;
  if (current !== null) {
    push(`    ${g.arrow} ${current} owns it now; \`/work ${current}\` for its orders and diff.`);
  }
  return `${lines.join('\n')}\n`;
}

function appendFiles(
  input: WorkSnapshotInput,
  files: SnapshotFiles,
  agentId: string,
  push: (text: string) => void,
  field: (key: string, value: string) => void,
  g: ReturnType<typeof glyphsFor>,
): void {
  const root = input.campaignRoot;
  if (root === null) return;
  const ordersFile = ordersPath(root, agentId);
  const orders = files.read(ordersFile);
  if (orders === null) {
    field('orders', `not written yet ${g.bullet} ${ordersFile}`);
  } else {
    const rows = orders.split('\n');
    const shown = rows.slice(0, ORDERS_PREVIEW_LINES);
    field(
      'orders',
      `${String(rows.length)} line${rows.length === 1 ? '' : 's'} ${g.bullet} ${ordersFile}`,
    );
    for (const row of shown) push(`      ${g.boxV} ${sanitize(row)}`);
    if (rows.length > shown.length) {
      push(`      ${g.boxV} ${g.ellipsis} ${String(rows.length - shown.length)} more lines`);
    }
  }
  const patch = files.read(diffPath(root, agentId));
  if (patch === null) {
    field('diff', `none recorded ${g.bullet} the attempt has not been read back yet`);
    return;
  }
  const stat = diffStat(patch);
  field(
    'diff',
    `${String(stat.files)} file${stat.files === 1 ? '' : 's'} ${g.bullet} ` +
      `+${String(stat.insertions)} ${g.dash}${String(stat.deletions)}`,
  );
}
