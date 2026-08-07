/**
 * `army view` — the entry point.
 *
 * Everything environmental is decided exactly once, here: which archive, which campaign, how wide
 * the terminal is, whether colour is wanted, whether the console can draw a `◇`. Below this file
 * nothing reads `process.env` and nothing asks the clock, which is why every layout and status
 * decision in this command is reachable from a unit test without a subprocess or a fake TTY.
 *
 * `runView` is exported for `src/cli.ts` to wire up. It takes argv AFTER the subcommand and
 * returns an exit code; it never calls `process.exit`, so the CLI keeps ownership of the process.
 *
 * THIS COMMAND IS READ-ONLY. It opens no worktree, spawns no agent, and writes nothing — see the
 * header of `live.ts` for how that is enforced rather than promised.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { GLOBAL_CONFIG_DIR_NAME } from '../contracts/config.ts';
import { loadConfig } from '../config/load.ts';
import { invokedAs } from '../setup/checks.ts';
import { doThis, renderFix, runThis } from '../setup/fixes.ts';
import type { Fix } from '../setup/fixes.ts';

import type { BuildTreeOptions, CampaignSnapshot, TreeModel } from './tree.ts';
import {
  DEFAULT_BUSY_WITHIN_MS,
  DEFAULT_PRESUMED_DEAD_AFTER_MS,
  DEFAULT_STALE_AFTER_MS,
  buildTree,
} from './tree.ts';
import type { Charset } from './render.ts';
import { formatDuration, renderJson, renderTree } from './render.ts';
import type { CampaignReader, SnapshotSource } from './live.ts';
import { DEFAULT_POLL_MS, followCampaign, listCampaigns, openCampaignReader } from './live.ts';

export type { Charset } from './render.ts';
export type { SnapshotSource } from './live.ts';

// ---------------------------------------------------------------------------------------------
// Injection seams
// ---------------------------------------------------------------------------------------------

export interface WriteStream {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface ViewDeps {
  env?: Record<string, string | undefined>;
  stdout?: WriteStream;
  stderr?: WriteStream;
  /** Injected clock. Relative times are deterministic in tests because of this. */
  now?: () => Date;
  /** Home directory, for `~/.agentic-army`. */
  homeDir?: string;
  /** Cancels follow mode. */
  signal?: AbortSignal;
  /** Test seam: stop follow mode after N frames. */
  maxFrames?: number;
  /**
   * The command prefix printed in front of every suggested next step, e.g. `army`,
   * `node src/cli.ts`. Defaults to the detected invocation.
   *
   * It is a SEAM for the same reason `renderCampaignResult` takes one: a test that asserts on
   * `invokedAs()`'s own output cannot fail — it agrees with whatever it produced, on any machine.
   */
  self?: string;
}

// ---------------------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------------------

/**
 * A function of the invocation, not a constant: the USAGE line is a command to TYPE, and it was
 * printed as a bare `army view …` to readers for whom `army` is not on PATH. The title line
 * keeps the package spelling — there it is the NAME of the command, not an instruction.
 */
export function viewHelp(self: string): string {
  return `
army view — read-only tree view of a campaign

  Answers three questions at a glance: how deep the nesting goes, which ranks
  are in play, and what every unit is doing right now.

  It is strictly read-only. It opens the archive without a write lock, never
  repairs a torn record, never spawns anything. Safe to run against a campaign
  that is in flight, and safe to run days later against one that is not.

USAGE
  ${self} view [campaign-id] [options]

OPTIONS
  --list               List campaigns in the archive and exit.
  --archive <dir>      Archive root. Default: config archive_root, else
                       $AGENTIC_ARMY_HOME, else ~/.agentic-army.
  --source files|db    Where rows come from. Default files — SQLite is the
                       index, files are truth, so the default path opens no
                       database at all. \`db\` opens it read-only.
  --json               Emit the tree model as JSON on stdout, no decoration.
  -f, --follow         Poll and redraw. No fs.watch, no native dependency.
  --interval <ms>      Poll interval for --follow. Default ${DEFAULT_POLL_MS}.
  --ascii / --unicode  Force the glyph set. Default is detected: a Windows
                       console on codepage 437 cannot draw the rank glyphs.
  --color / --no-color Force colour. NO_COLOR and FORCE_COLOR are honoured.
  --width <n>          Terminal width. Default: the real width, else 80.
  --busy-within <ms>   An event newer than this proves work. Default ${DEFAULT_BUSY_WITHIN_MS}.
  --stale-after <ms>   Silence longer than this proves nothing, and the state
                       becomes \`unknown\`. Default ${DEFAULT_STALE_AFTER_MS}.
  -h, --help           This.

RANK AND DEPTH ARE SEPARATE COLUMNS
  Rank is assigned by the spawner and must be strictly junior to it; it is not
  derived from depth. A General may detach a Captain directly, so CPT at depth
  1 is normal and reads as GAP -1. GAP is depth minus rank seniority: a
  ceremonial GEN>COL>CPT>SGT>PVT chain is 0 at every level, rank skipping is
  negative, and a POSITIVE gap means the chain has more nesting levels than it
  consumed ranks — which is only possible if a spawn failed to go strictly
  junior. Those rows are marked \`!\` and listed as anomalies.

STATE IS COMPUTED, NEVER STORED
  Derived from stream.jsonl, and every verdict carries the rule that produced
  it in the WHY column.

    busy     an unmatched tool_use is open, or events are arriving
    idle     alive, turn complete, nothing in flight
    unknown  no stream, no events, or silence past --stale-after. An honest
             answer, and never rendered as anything more confident
    dead     the index recorded an exit, or the log ends in an error
`;
}

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

interface Options {
  campaignId?: string;
  archiveRoot?: string;
  source: SnapshotSource;
  json: boolean;
  follow: boolean;
  list: boolean;
  help: boolean;
  intervalMs: number;
  charset?: Charset;
  color?: boolean;
  width?: number;
  busyWithinMs: number;
  staleAfterMs: number;
}

class UsageError extends Error {}

function positiveInt(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value < 0) {
    throw new UsageError(`${flag} expects a non-negative number, got ${JSON.stringify(raw ?? '')}`);
  }
  return Math.trunc(value);
}

export function parseViewArgs(argv: readonly string[]): Options {
  const options: Options = {
    source: 'files',
    json: false,
    follow: false,
    list: false,
    help: false,
    intervalMs: DEFAULT_POLL_MS,
    busyWithinMs: DEFAULT_BUSY_WITHIN_MS,
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-f':
      case '--follow':
        options.follow = true;
        break;
      case '--ascii':
        options.charset = 'ascii';
        break;
      case '--unicode':
        options.charset = 'unicode';
        break;
      case '--color':
        options.color = true;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '--archive':
        options.archiveRoot = next();
        if (options.archiveRoot === undefined) throw new UsageError('--archive expects a path');
        break;
      case '--source': {
        const value = next();
        if (value !== 'files' && value !== 'db') {
          throw new UsageError(`--source expects files or db, got ${JSON.stringify(value ?? '')}`);
        }
        options.source = value;
        break;
      }
      case '--interval':
        options.intervalMs = positiveInt(next(), '--interval');
        break;
      case '--width':
        options.width = positiveInt(next(), '--width');
        break;
      case '--busy-within':
        options.busyWithinMs = positiveInt(next(), '--busy-within');
        break;
      case '--stale-after':
        options.staleAfterMs = positiveInt(next(), '--stale-after');
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
        if (options.campaignId !== undefined) {
          throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
        }
        options.campaignId = arg;
        break;
    }
  }
  return options;
}

// ---------------------------------------------------------------------------------------------
// Environment detection — the only place any of this is read
// ---------------------------------------------------------------------------------------------

export type Env = Record<string, string | undefined>;

/**
 * Colour, per the informal but near-universal contract.
 *
 * `NO_COLOR` wins over `FORCE_COLOR` because it is the one a user sets deliberately to make a
 * tool stop, and a tool that can be talked out of it is not honouring it.
 */
export function detectColor(env: Env, isTTY: boolean): boolean {
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '' && force !== '0') return true;
  if (env['TERM'] === 'dumb') return false;
  return isTTY;
}

/**
 * Glyph set.
 *
 * The failure this exists to prevent is specific: a default `cmd.exe` is codepage 437, where
 * ☆ ◆ ◇ ▪ · and the box-drawing characters do not exist, and the console prints replacement junk
 * rather than falling back. So Windows is ASCII unless something identifies a modern terminal —
 * Windows Terminal (`WT_SESSION`), an integrated editor terminal (`TERM_PROGRAM`), ConEmu, or a
 * real `TERM` from a POSIX-style shell. Elsewhere, a locale that explicitly is NOT UTF-8 also
 * means ASCII; an unset locale does not, because unset is the normal state of a piped process.
 */
export function detectCharset(env: Env, isTTY: boolean, platform: string): Charset {
  if (platform === 'win32') {
    const modern =
      env['WT_SESSION'] !== undefined ||
      env['TERM_PROGRAM'] !== undefined ||
      env['ConEmuANSI'] === 'ON' ||
      (env['TERM'] !== undefined && env['TERM'] !== '' && env['TERM'] !== 'dumb');
    return modern ? 'unicode' : 'ascii';
  }
  if (env['TERM'] === 'dumb') return 'ascii';
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? '';
  if (locale !== '' && !/utf-?8/i.test(locale)) return 'ascii';
  // `isTTY` deliberately does NOT force ASCII: redirecting to a UTF-8 file is a normal thing to
  // do, and the locale check above already covers the consoles that cannot cope.
  void isTTY;
  return 'unicode';
}

export function detectWidth(env: Env, stream: WriteStream | undefined): number {
  if (stream?.columns !== undefined && stream.columns > 0) return stream.columns;
  const columns = Number(env['COLUMNS']);
  if (Number.isFinite(columns) && columns > 0) return Math.trunc(columns);
  return 80;
}

/**
 * Where the archive is.
 *
 * `config.toml`'s `archive_root` is authoritative when it exists, because `army init` may have
 * put the archive somewhere other than next to the config. A missing or unreadable config is not
 * an error — it just means the default location, which is also the pre-`army init` answer.
 */
export function resolveArmyHome(env: Env, homeDir: string): string {
  const override = env['AGENTIC_ARMY_HOME'];
  if (override !== undefined && override.trim() !== '') return path.resolve(override.trim());
  return path.join(homeDir, GLOBAL_CONFIG_DIR_NAME);
}

/**
 * The archive root, plus anything the config had to say about itself.
 *
 * The warnings come back rather than being dropped because the commonest reason `view` finds
 * nothing is that the archive was never created, and `config.toml does not exist yet` is that
 * fact stated at the source. `self` is handed down so the command in it is one this reader can
 * type — `src/config/**` is below `src/setup/**` and cannot ask `invokedAs()` itself.
 */
async function resolveArchive(
  explicit: string | undefined,
  env: Env,
  homeDir: string,
  self: string,
): Promise<{ root: string; warnings: readonly string[] }> {
  if (explicit !== undefined) return { root: path.resolve(explicit), warnings: [] };
  const home = resolveArmyHome(env, homeDir);
  try {
    const loaded = await loadConfig({ env, home, self });
    return { root: loaded.config.archiveRoot, warnings: loaded.warnings };
  } catch {
    // An unreadable config is not a reason to refuse to show a campaign: the archive is almost
    // always right where the config would have been, and `--archive` covers the rest.
    return { root: home, warnings: [] };
  }
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

export interface ViewPresentation {
  charset: Charset;
  color: boolean;
  width: number;
}

/** Model + render in one step, so follow mode and the one-shot path cannot drift. */
export function frameOf(
  snapshot: CampaignSnapshot,
  build: BuildTreeOptions,
  presentation: ViewPresentation,
  json: boolean,
): string {
  const model: TreeModel = buildTree(snapshot, build);
  return json ? renderJson(model) : renderTree(model, presentation);
}

// ---------------------------------------------------------------------------------------------
// Refusals — every one of them owes a fix line
// ---------------------------------------------------------------------------------------------

/*
 * =============================================================================================
 * WHY EVERY REFUSAL BELOW CARRIES A `fix:`
 * =============================================================================================
 *
 * `src/setup/checks.ts` states the contract for the whole tool — blocking owes the exact command
 * that resolves it — and `doctor`, `enlist` and `campaign` honour it. `view` did not. All five of
 * its error paths printed a diagnosis and nothing else, in the command whose entire job is to
 * answer "what is going on", to a reader who by definition already knows something is wrong.
 *
 * The fix is a three-state `Fix` (`src/setup/fixes.ts`), never a bare string: a paste-and-run
 * command, a concrete manual action, or an explicit `none`. The two-state "a fix or silence"
 * shape is what let `mkdir -p "<file>"` ship as advice for a path that was a file.
 */

/** How many ids an unknown-campaign message spells out before deferring to `--list`. */
const MAX_LISTED_CAMPAIGNS = 8;

/**
 * The one thing a reader of `view <wrong-id>` wants: the ids that DO exist.
 *
 * `no such campaign directory: /…/campaigns/no-such-campaign` is a complete diagnosis and a
 * useless one — the reader mistyped or half-remembered an id, and the archive is holding the
 * answer. `--list` already existed and nothing pointed at it. Short archives are spelled out in
 * full because the id IS the fix; long ones defer to `--list` rather than paging the terminal.
 */
function unknownCampaignHelp(
  campaigns: readonly { id: string; status: string; title: string }[],
  self: string,
): { lines: string[]; fix: Fix } {
  if (campaigns.length === 0) {
    return {
      lines: [],
      fix: doThis(
        `this archive holds no campaigns at all — start one with \`${self} campaign ` +
          `"<objective>"\`, or point at another archive with \`--archive <dir>\``,
      ),
    };
  }
  if (campaigns.length > MAX_LISTED_CAMPAIGNS) {
    return {
      lines: [`  ${campaigns.length} campaigns are in this archive.`],
      fix: runThis(`${self} view --list`),
    };
  }
  // Same column rule as `--list`: pad by the widest id, never leave padding as trailing space.
  const idWidth = Math.max(...campaigns.map((c) => c.id.length));
  const lines = [
    `  ${campaigns.length === 1 ? 'the one campaign' : `the ${campaigns.length} campaigns`} in this archive:`,
    ...campaigns.map((c) => `    ${`${c.id.padEnd(idWidth)}  ${c.status.padEnd(8)}  ${c.title}`.trimEnd()}`),
  ];
  // A paste-and-run command, and the id in it is real: it came off the disk a moment ago.
  return { lines, fix: runThis(`${self} view ${campaigns[0]?.id ?? ''}`) };
}

/**
 * Milliseconds an `active` campaign's directory has sat untouched, or null when the row is not
 * `active` or offered no timestamp. mtime-based (`CampaignSummary.lastActivityAt`), because the
 * list must stay cheap; the single-campaign view answers the same question from the stream
 * contents through `buildTree`.
 */
function listSilence(
  campaign: { status: string; lastActivityAt: string | null },
  nowMs: number,
): number | null {
  if (campaign.status !== 'active' || campaign.lastActivityAt === null) return null;
  const last = Date.parse(campaign.lastActivityAt);
  return Number.isNaN(last) ? null : nowMs - last;
}

/** `<self> view: <what happened>` + optional context + one `fix:` line. One spelling, five sites. */
function refuse(
  stderr: WriteStream,
  self: string,
  message: string,
  fix: Fix,
  context: readonly string[] = [],
): number {
  stderr.write([`${self} view: ${message}`, ...context, `  ${renderFix(fix)}`, ''].join('\n'));
  return 1;
}

export async function runView(argv: readonly string[], deps: ViewDeps = {}): Promise<number> {
  const env: Env = deps.env ?? process.env;
  const stdout: WriteStream = deps.stdout ?? process.stdout;
  const stderr: WriteStream = deps.stderr ?? process.stderr;
  const now = deps.now ?? ((): Date => new Date());
  const homeDir = deps.homeDir ?? os.homedir();
  // Resolved once, and every command named below is built from it, so this screen can never
  // report itself as one form and suggest another.
  //
  // "Below" means below this LINE, not below this FILE. It used to mean only this file, and the
  // two lines `live.ts` printed on its own — follow mode's `army view:` banner and the missing-
  // `campaign.json` fix — carried the other spelling, in the same session, sometimes in the same
  // frame. Both are now parameters (`FollowOptions.self`, `ReaderOptions.self`), required rather
  // than defaulted, so the resolution below is the only one in the process.
  const self = deps.self ?? invokedAs();

  let options: Options;
  try {
    options = parseViewArgs(argv);
  } catch (error) {
    // The Try-form the other subcommands refuse usage errors with, not a `fix:` line: a mistyped
    // flag is not a diagnosed condition, and one CLI must not keep two grammars for one mistake.
    stderr.write(`${self} view: ${(error as Error).message}\nTry \`${self} view --help\`.\n`);
    return 1;
  }

  if (options.help) {
    stdout.write(viewHelp(self));
    return 0;
  }

  const isTTY = stdout.isTTY === true;
  const presentation: ViewPresentation = {
    charset: options.charset ?? detectCharset(env, isTTY, process.platform),
    // `--json` must be undecorated on stdout, so colour is forced off rather than merely defaulted.
    color: options.json ? false : (options.color ?? detectColor(env, isTTY)),
    width: options.width ?? detectWidth(env, stdout),
  };

  let archiveRoot: string;
  let configWarnings: readonly string[] = [];
  try {
    const resolved = await resolveArchive(options.archiveRoot, env, homeDir, self);
    archiveRoot = resolved.root;
    configWarnings = resolved.warnings;
  } catch (error) {
    // `--archive` bypasses config resolution entirely, so it clears this whatever went wrong —
    // but it needs a value only the reader has, which is `manual` and not `command`.
    return refuse(
      stderr,
      self,
      (error as Error).message,
      doThis(`name the archive root yourself: \`${self} view --archive <dir>\``),
    );
  }

  const campaigns = listCampaigns(archiveRoot);

  if (options.list) {
    if (options.json) {
      stdout.write(`${JSON.stringify({ v: 1, archiveRoot, campaigns }, null, 2)}\n`);
      return 0;
    }
    if (campaigns.length === 0) {
      stdout.write(`no campaigns in ${archiveRoot}\n`);
      return 0;
    }
    // Padded by the widest id in THIS archive — ids are user-choosable (`--id`), so a fixed
    // width would be wrong the first time someone named a campaign, and unpadded ids put the
    // status column wherever each id happened to end. `trimEnd` because a row with an empty
    // title would otherwise carry the status padding as trailing whitespace.
    const idWidth = Math.max(...campaigns.map((c) => c.id.length));
    for (const campaign of campaigns) {
      // A SIGKILLed campaign stays `active` in campaign.json forever — nothing that could have
      // written the terminal status survived. The list keeps the recorded status (files are
      // truth) and appends what the directory's own mtimes testify, so three dead rows no
      // longer read as three live campaigns. Same threshold as the single-campaign header.
      const silence = listSilence(campaign, now().getTime());
      const flag =
        silence !== null && silence > DEFAULT_PRESUMED_DEAD_AFTER_MS
          ? ` — stream silent ${formatDuration(silence)}, probably interrupted`
          : '';
      const row = `${campaign.id.padEnd(idWidth)}  ${campaign.status.padEnd(8)}  ${campaign.title}${flag}`;
      stdout.write(`${row.trimEnd()}\n`);
    }
    return 0;
  }

  const campaignId = options.campaignId ?? campaigns[0]?.id;
  if (campaignId === undefined) {
    // NOT `${self} init`, tempting as it is. `init` creates the archive directory; it does not
    // create a campaign, so the condition would survive the fix and the reader would be left
    // doubting the diagnosis rather than the advice. Both real routes need a value from them.
    return refuse(
      stderr,
      self,
      `no campaigns found in ${archiveRoot}`,
      doThis(
        `start one with \`${self} campaign "<objective>"\`, or point at the archive that has ` +
          'them with `--archive <dir>`',
      ),
      // Usually exactly one line, and usually the real answer: the archive was never created.
      configWarnings.map((w) => `  ${w}`),
    );
  }

  let reader: CampaignReader;
  try {
    reader = openCampaignReader({ archiveRoot, campaignId, source: options.source, self });
  } catch (error) {
    const help = unknownCampaignHelp(campaigns, self);
    return refuse(stderr, self, (error as Error).message, help.fix, help.lines);
  }

  const build = (): BuildTreeOptions => ({
    now: now(),
    busyWithinMs: options.busyWithinMs,
    staleAfterMs: options.staleAfterMs,
  });

  try {
    if (!options.follow) {
      stdout.write(frameOf(reader.read(true), build(), presentation, options.json));
      return 0;
    }
    await followCampaign({
      reader,
      // Follow mode draws its own error line, so it needs the same spelling every refusal below
      // uses. Handed down rather than re-detected: one resolution per process, one answer.
      self,
      frame: (snapshot) => frameOf(snapshot, build(), presentation, options.json),
      write: (text) => void stdout.write(text),
      intervalMs: options.intervalMs,
      // Cursor control in a pipe is noise, and would corrupt `--json`.
      clearScreen: isTTY && !options.json,
      signal: deps.signal,
      maxFrames: deps.maxFrames,
    });
    return 0;
  } catch (error) {
    // Reaching here means the one-shot render or the follow loop itself failed — a read error
    // inside a frame is already caught and drawn INTO the frame by `followCampaign`. The cause is
    // therefore unknown from here, so this is deliberately `manual`: the single-frame form is a
    // real next step and a judgement call, not a command that provably clears the condition.
    return refuse(
      stderr,
      self,
      error instanceof Error ? error.message : String(error),
      doThis(
        `\`${self} view ${campaignId}\` renders one frame from the same archive without the ` +
          'poll loop, which narrows this to the archive or to follow mode',
      ),
    );
  } finally {
    reader.close();
  }
}

export { buildTree, walkTree } from './tree.ts';
export { renderJson, renderTree } from './render.ts';
export { listCampaigns, openCampaignReader } from './live.ts';
