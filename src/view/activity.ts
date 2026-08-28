/**
 * What a worker is doing right now, in one line.
 *
 * ## Why this exists
 *
 * `runSoldier` has always written every `tool_use` event to `stream.jsonl` and nowhere else, and
 * `ProgressEvent` had nine kinds, all of them lifecycle. So between `unit-dispatched` and
 * `unit-returned` the type system permitted a terminal to say exactly nothing, and a human watched
 * `CPT·ENGINEER working 14m00s` for twenty-seven minutes while a 993 KB record of what the
 * Engineer was doing accumulated two directories away. This module is the translation that closes
 * that gap: a normalised `tool_use` in, one short human sentence out.
 *
 * ## This is the ONLY thing allowed to read a tool's input
 *
 * `ToolUseEvent.input` is `unknown` for a reason — it is model-chosen, unbounded and untyped. The
 * largest single input in the reference archive was 10,656 bytes (a `Write` payload) and results
 * reach 40 MB. Nothing downstream of here may carry it: a `ProgressEvent` gets `tool` and `target`
 * as already-extracted, already-sanitised, already-clipped `string`s, so there is no type-legal
 * route from a tool payload to a terminal. If a future field wants richer detail, it extracts it
 * HERE and hands on a string; it does not widen the event.
 *
 * ## Pure, like the rest of `src/view`
 *
 * No `process.env`, no `isTTY`, no clock — and specifically no filesystem. `root` is prefix-
 * stripped as text, never resolved: `path.relative` would stat, and a renderer that touches the
 * disk is a renderer that cannot be unit-tested and can block a terminal on a dead network mount.
 *
 * ## Harness-neutral by construction
 *
 * Claude names its tools `Bash`, `Write`, `Grep`; codex names them `command_execution`,
 * `file_change`, `mcp_tool_call`. Both tables live here rather than in the adapters, because the
 * adapters' job is to normalise the EVENT and this is a question about how to SAY it — and a
 * second table in a second adapter is how `SPINNER_FRAMES` ended up spinning two directions at
 * once.
 */

import { clipTo, displayWidth } from './render.ts';
import { sanitize } from './progress.ts';

/** How much of a tool's argument survives onto a status row. */
export const ACTIVITY_TARGET_MAX = 68;

/**
 * One tool call, as a human reads it.
 *
 * `verb` is never model-controlled — it is chosen from the tables below, or is the harness's own
 * tool name, which is vendor-controlled rather than model-controlled. `target` IS model-controlled
 * and has been through `sanitize` and `clipTo` before it gets here.
 */
export interface ToolAction {
  verb: string;
  /** The salient argument. Empty when the call has nothing worth naming. */
  target: string;
  /**
   * Bookkeeping rather than work: task lists, todo writes, tool searches.
   *
   * 25 of the reference run's 107 tool calls were `TaskCreate`/`TaskUpdate`. Rendering a row for
   * each buries the two `Write`s between them, so a caller counts these instead of listing them.
   */
  bookkeeping: boolean;
}

export interface DescribeOptions {
  /**
   * The worker's working directory. Stripped from the FRONT of a path as plain text so a row reads
   * `lib/html.js` rather than
   * `/Users/…/.agentic-army-trees/trees/army-test-3-901c0dc3/wt-01/lib/html.js`, which is 68
   * columns of noise before the first informative character. Never resolved — see the header.
   */
  root?: string;
  /** Column budget for `target`. Defaults to `ACTIVITY_TARGET_MAX`. */
  max?: number;
  /** Marks a clipped target. Defaults to `…`; pass `...` on an ASCII terminal. */
  ellipsis?: string;
}

/** Tools that are the worker organising itself rather than changing anything. */
const BOOKKEEPING = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite', 'ToolSearch']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field, or `''` — never a number coerced into one, and never `"undefined"`. */
function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Drop the worktree prefix, as text.
 *
 * Tolerates a trailing separator on `root` and leaves anything that does not start with it
 * completely alone — an absolute path outside the lease is exactly the thing a reader most needs
 * to see in full, because it is the shape of a worker writing outside its worktree.
 */
function relativise(value: string, root: string | undefined): string {
  if (root === undefined || root === '') return value;
  const base = root.endsWith('/') ? root : `${root}/`;
  return value.startsWith(base) ? value.slice(base.length) : value;
}

/**
 * The interpreter wrapper codex puts around every shell command.
 *
 * `["/bin/zsh", "-lc", "npm test"]` and `/bin/zsh -lc 'npm test'` both mean `npm test`, and the
 * wrapper is the same on every single call — so it is nine columns of constant that would push the
 * informative half off the end of the row.
 */
const SHELL_WRAPPER = /^\/(?:usr\/)?bin\/(?:ba|z|d)?sh\s+-[a-z]*c\s+/u;

function unwrapCommand(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string');
    // `["/bin/zsh","-lc","npm test"]` — the payload is the last element, not a join of all three.
    if (parts.length >= 3 && SHELL_WRAPPER.test(`${parts[0] ?? ''} ${parts[1] ?? ''} `)) {
      return parts[parts.length - 1] ?? '';
    }
    return parts.join(' ');
  }
  if (typeof value !== 'string') return '';
  const unwrapped = value.replace(SHELL_WRAPPER, '');
  if (unwrapped === value) return value;
  // The wrapper's payload is quoted; drop one matched pair so `'npm test'` reads as `npm test`.
  const first = unwrapped[0];
  if ((first === "'" || first === '"') && unwrapped.endsWith(first) && unwrapped.length >= 2) {
    return unwrapped.slice(1, -1);
  }
  return unwrapped;
}

/** `changes: [{path}, …]` from codex's `file_change`, as `lib/a.js +2 more`. */
function describeFileChange(input: Record<string, unknown>, root: string | undefined): string {
  const changes = input['changes'];
  if (!Array.isArray(changes) || changes.length === 0) return '';
  const first = changes[0];
  const head = isRecord(first) ? (str(first, 'path') || str(first, 'file_path')) : '';
  if (head === '') return '';
  const rest = changes.length - 1;
  return rest > 0 ? `${relativise(head, root)} +${String(rest)} more` : relativise(head, root);
}

/**
 * Pick the one argument worth showing for a tool call.
 *
 * Returns the RAW string; sanitising and clipping happen once, in `describeToolUse`, so that no
 * table entry can forget to do it.
 */
function salientArgument(name: string, input: Record<string, unknown>, root: string | undefined): string {
  switch (name) {
    // ---- claude ----------------------------------------------------------------------------
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return relativise(str(input, 'file_path'), root);
    case 'Bash':
    case 'BashOutput':
      // The COMMAND, not the model's `description` of it. A description is a claim about what a
      // command does; the command is what will run. On the reference run the descriptions read
      // `Verify package.json load command (always exits 0 due to || true)` — fluent, and no
      // substitute for seeing the line that a permission layer is about to refuse. `description`
      // is the fallback only, for a harness that sends no command text at all.
      return str(input, 'command') || str(input, 'description');
    case 'Glob':
    case 'Grep':
      return str(input, 'pattern');
    case 'WebFetch':
      return str(input, 'url');
    case 'WebSearch':
      return str(input, 'query');
    case 'ToolSearch':
      return str(input, 'query');
    case 'TaskCreate':
      return str(input, 'subject');
    case 'TaskUpdate': {
      const id = str(input, 'taskId');
      const status = str(input, 'status');
      return status === '' ? id : `${id} ${status}`.trim();
    }
    case 'Task':
    case 'Agent':
      // The subagent spawn is the single call a roster most wants to name: it is the edge in the
      // org chart, and the row it produces is what tells a reader a SERGEANT now exists.
      return str(input, 'description') || str(input, 'subagent_type');
    // ---- codex -----------------------------------------------------------------------------
    case 'command_execution':
    case 'local_shell_call':
      return unwrapCommand(input['command']);
    case 'file_change':
    case 'apply_patch':
      return describeFileChange(input, root);
    case 'mcp_tool_call': {
      const server = str(input, 'server');
      const tool = str(input, 'tool');
      return server === '' ? tool : `${server}.${tool}`;
    }
    case 'web_search':
      return str(input, 'query');
    default:
      return '';
  }
}

/** How codex's tool names read once a human is looking at them. */
const CODEX_VERB: Record<string, string> = {
  command_execution: 'Bash',
  local_shell_call: 'Bash',
  file_change: 'Edit',
  apply_patch: 'Edit',
  mcp_tool_call: 'MCP',
  web_search: 'WebSearch',
};

/**
 * One tool call, described.
 *
 * Never throws and never returns a `verb` of `''`: an unrecognised tool is reported by NAME with
 * an empty target, because "the Engineer called something I do not have a table entry for" is a
 * true and useful row, and inventing a target for it would not be.
 */
export function describeToolUse(name: string, input: unknown, options: DescribeOptions = {}): ToolAction {
  const max = options.max ?? ACTIVITY_TARGET_MAX;
  const ellipsis = options.ellipsis ?? '…';
  const verb = CODEX_VERB[name] ?? (name === '' ? 'tool' : name);
  const raw = isRecord(input) ? salientArgument(name, input, options.root) : '';
  // Sanitise BEFORE clipping. The other order measures escape bytes as columns and then cuts a
  // multi-byte sequence in half, which is how a "clipped" string still moves a cursor.
  const clean = sanitize(raw);
  const target = displayWidth(clean) > max ? clipTo(clean, max, ellipsis) : clean;
  return { verb, target, bookkeeping: BOOKKEEPING.has(name) };
}

/**
 * `Write(lib/html.js)`, `Bash(npm test)`, `Glob` — one call, ready to print.
 *
 * Kept next to `describeToolUse` rather than inlined at the two call sites so that the live status
 * row and the scrollback line spell a tool call the same way. They are within a second of each
 * other on screen; two spellings would read as two different events.
 */
export function formatToolAction(action: ToolAction): string {
  return action.target === '' ? action.verb : `${action.verb}(${action.target})`;
}
