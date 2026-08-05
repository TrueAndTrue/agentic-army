/**
 * `army trial` — argument parsing, rendering, exit codes.
 *
 * The orchestration is in `src/trial/run.ts`; this file is the CLI skin over it, exactly the way
 * `src/command/index.ts` is the skin over `runCampaign`. Keeping them apart is what lets
 * `test/trial-cli.test.ts` drive the whole command — including a vacuous refusal and a failing
 * check — by calling `trialCommand` with an injected `runTrial`, no argv, no terminal and no
 * process spawned.
 *
 * `trialCommand` never resolves `army trial --help` itself: `src/cli.ts` intercepts `--help`
 * before this module is even imported (see the block above `SELF_DOCUMENTING` there), which is
 * why `TrialArgs` below carries no `help` field the way `CampaignArgs` does.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { TrialMode, TrialResult, TrialSpec } from '../contracts/trial.ts';
import { TRIAL_MODES } from '../contracts/trial.ts';
import { armyHome } from '../config/paths.ts';
import type { Env } from '../config/paths.ts';
import { invokedAs } from '../setup/checks.ts';
import { runTrial } from '../trial/run.ts';
import type { RunTrialOptions } from '../trial/run.ts';
import { parseTrialSpec } from '../trial/spec.ts';
import { renderTrialJson, renderTrialResult } from '../trial/report.ts';

import type { WriteStream } from './campaign.ts';

// ---------------------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------------------

/**
 * See the note above `invokedAs` in `src/setup/checks.ts` and the one at the top of `CAMPAIGN_HELP`
 * in `src/command/index.ts`: every line here that names a command to TYPE is built from `self`,
 * because `army` is not on PATH for `npx agentic-army`, `npm run dev --`, or a plain checkout. The
 * title line is the documented exception — it names the command, it does not instruct anyone to
 * run it.
 */
export const TRIAL_HELP = (self: string): string => `
army trial — a controlled reasoning-effort experiment

  Same model, same brief, same seed repository, N arms in their own workspaces
  — one variable held still so the difference that shows up in the table is
  the difference that was changed. Every arm is scored from ARTIFACTS: the git
  state of its own workspace and its recorded event stream, never from the
  worker's own account of what it did.

USAGE
  ${self} trial <spec.toml> [options]

OPTIONS
  --out <dir>       Where arm workspaces and the result are written. Default:
                    <cwd>/.army-trial/<spec file name, without extension>.
                    Refuses to run if this directory already exists.
  --serial          Run arms one at a time. Overrides the spec's own \`mode\`.
  --concurrent      Run every arm at once. Overrides the spec's own \`mode\`.
                    \`--serial\` and \`--concurrent\` together is an error.
  --json            Emit the result as JSON on stdout, instead of the table.
  --dry-run         Parse the spec and print the arm plan. Runs nothing.
  -h, --help        This.

  The result is ALWAYS written to <out>/result.json, whatever \`--json\` says.
  A trial costs real money; losing the numbers because the terminal scrolled
  past them is not an acceptable failure mode.

EXIT CODES
  0                 Every arm passed every check.
  1                 A check failed, an arm never reached status 'ok', or the
                    spec file could not be read or parsed.
  2                 The trial was refused for vacuity — see below.

THE VACUITY RULE
  A \`job\` check that already passes on the UNTOUCHED seed measures nothing:
  the work was done before any arm ran, so every arm would score full marks
  forever. The runner refuses to spawn a single arm when this happens and
  names which check. Fix the seed or the check; the trial cannot be rerun
  around it.

A WORKED EXAMPLE

  title  = "calc bugfix"
  seed   = "./seed"                    # required; directory, resolved
                                        # against THIS file's own directory
  model  = "claude-sonnet-5"           # optional, this is the default
  mode   = "concurrent"                # optional, "serial" | "concurrent"
  efforts = ["minimal","low","medium","high","xhigh"]   # optional, this is the default
  orders  = "..."                      # inline brief
  # orders_file = "./brief.md"         # OR a file; exactly one of the two

  # optional: name several briefs to cross against every effort
  # [[briefs]]
  # label = "complete"
  # file  = "./complete.md"
  # [[briefs]]
  # label = "thin"
  # orders = "make the tests pass"

  [[checks]]
  id = "tests-pass"
  kind = "job"
  type = "command"
  run = "node --test"
  expect_exit = 0

  [[checks]]
  id = "scope"
  kind = "compliance"
  type = "files-changed"
  allow = ["calc.js"]
  require = ["calc.js"]

  [[checks]]
  id = "no-install"
  kind = "compliance"
  type = "no-tool-use"
  tool = "Bash"
  matching = "npm install"

  [[checks]]
  id = "content"
  kind = "compliance"
  type = "file-content"
  path = "calc.js"
  contains = "export"

  [[checks]]
  id = "committed"
  kind = "compliance"
  type = "committed"
  require_new_commit = true
  require_clean = true
`;

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

class UsageError extends Error {}

export interface TrialArgs {
  /** Positional; the `.toml` spec file. */
  specPath: string;
  /** `--out`. Default: `<cwd>/.army-trial/<spec file name, without extension>`. */
  outDir: string;
  /** `--serial` / `--concurrent`, overriding the spec's own `mode` when present. */
  mode?: TrialMode;
  json: boolean;
  dryRun: boolean;
}

export function parseTrialArgs(argv: readonly string[]): TrialArgs {
  let outDir: string | undefined;
  let serial = false;
  let concurrent = false;
  let json = false;
  let dryRun = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case '--out': {
        const value = next();
        if (value === undefined) throw new UsageError('--out expects a path');
        outDir = path.resolve(value);
        break;
      }
      case '--serial':
        serial = true;
        break;
      case '--concurrent':
        concurrent = true;
        break;
      case '--json':
        json = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
        positional.push(arg);
        break;
    }
  }

  if (serial && concurrent) {
    throw new UsageError('--serial and --concurrent are mutually exclusive');
  }

  if (positional.length === 0) {
    throw new UsageError(`a trial spec file is required, e.g. ${invokedAs()} trial trial.toml`);
  }
  if (positional.length > 1) {
    throw new UsageError(
      `expected one spec file, got ${String(positional.length)}: ${positional.join(', ')}`,
    );
  }
  const specPath = path.resolve(positional[0] as string);

  const resolvedOutDir =
    outDir ?? path.join(process.cwd(), '.army-trial', path.basename(specPath, path.extname(specPath)));

  return {
    specPath,
    outDir: resolvedOutDir,
    ...(serial ? { mode: 'serial' as const } : {}),
    ...(concurrent ? { mode: 'concurrent' as const } : {}),
    json,
    dryRun,
  };
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

export interface TrialCommandDeps {
  stdout?: WriteStream;
  stderr?: WriteStream;
  /**
   * Overrides `runTrial` from `../trial/run.ts` — the whole dependency-injection seam. A test
   * drives every exit-code path (passing, failing, vacuous) through a fake that resolves
   * instantly, without spawning a harness or leasing anything.
   */
  runTrial?: (options: RunTrialOptions) => Promise<TrialResult>;
  /** The environment `armyHome` resolves from when `home` is not supplied. Defaults to `process.env`. */
  env?: Env;
  /**
   * Army home override. Supplying this skips `armyHome()` entirely — the only way a test may run
   * under the test harness, where `armyHome()` throws by design rather than resolve the
   * developer's own `~/.agentic-army`.
   */
  home?: string;
}

function armPlanLine(arm: TrialSpec['arms'][number]): string {
  return `  ${arm.id}  effort=${arm.effort}  brief=${arm.ordersLabel}  orders=${String(arm.orders.length)} chars`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function trialCommand(
  argv: readonly string[],
  deps: TrialCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const self = invokedAs();

  let args: TrialArgs;
  try {
    args = parseTrialArgs(argv);
  } catch (error) {
    stderr.write(`${self} trial: ${errorMessage(error)}\nTry \`${self} trial --help\`.\n`);
    return 1;
  }

  let spec: TrialSpec;
  try {
    const text = await fs.readFile(args.specPath, 'utf8');
    const parsed = parseTrialSpec(text, args.specPath, args.outDir);
    for (const warning of parsed.warnings) stderr.write(`${self} trial: warning: ${warning}\n`);
    spec = args.mode === undefined ? parsed.spec : { ...parsed.spec, mode: args.mode };
  } catch (error) {
    stderr.write(`${self} trial: ${errorMessage(error)}\n`);
    return 1;
  }

  if (args.dryRun) {
    const count = spec.arms.length;
    stdout.write(`${spec.title}  —  ${spec.mode}  —  ${String(count)} arm${count === 1 ? '' : 's'}\n\n`);
    for (const arm of spec.arms) stdout.write(`${armPlanLine(arm)}\n`);
    return 0;
  }

  const env = deps.env ?? process.env;
  const home = deps.home ?? armyHome(env);
  const runTrialFn = deps.runTrial ?? runTrial;

  let result: TrialResult;
  try {
    result = await runTrialFn({
      spec,
      home,
      onProgress: (line: string) => {
        stderr.write(`${line}\n`);
      },
    });
  } catch (error) {
    stderr.write(`${self} trial: ${errorMessage(error)}\n`);
    return 1;
  }

  // A trial costs real money. The numbers are written before anything else can go wrong on this
  // path, so a terminal that scrolled past the table never costs the run itself.
  try {
    await fs.mkdir(args.outDir, { recursive: true });
    await fs.writeFile(path.join(args.outDir, 'result.json'), renderTrialJson(result));
  } catch (error) {
    stderr.write(`${self} trial: could not write result.json: ${errorMessage(error)}\n`);
  }

  stdout.write(args.json ? renderTrialJson(result) : renderTrialResult(result));

  if (result.vacuous.length > 0) return 2;
  const everyArmClean = result.arms.every(
    (arm) => arm.status === 'ok' && arm.checks.every((check) => check.passed),
  );
  return everyArmClean ? 0 : 1;
}
