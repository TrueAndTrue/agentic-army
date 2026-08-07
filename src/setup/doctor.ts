/**
 * `army doctor` — the diagnostic surface.
 *
 * This is deliberately runnable standalone at any time, not just during
 * install: every failure mode in this system is environmental, so "run doctor"
 * has to be a genuinely useful first response to any weirdness.
 *
 * Exit code is 0 when nothing is blocking and 1 otherwise, so it works as a CI
 * gate. `--json` prints the whole report as one object on stdout.
 */

import { invokedAs, runChecks, type CheckResult, type DoctorReport, type Outcome } from './checks.ts';

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

type Glyphs = { ok: string; degraded: string; blocking: string };

const UNICODE_GLYPHS: Glyphs = { ok: '✓', degraded: '⚠', blocking: '✗' };
const ASCII_GLYPHS: Glyphs = { ok: '[ok]', degraded: '[!!]', blocking: '[XX]' };

function glyphs(): Glyphs {
  if (process.platform !== 'win32') return UNICODE_GLYPHS;
  // Windows Terminal / VS Code render these fine; legacy conhost does not.
  const modern = process.env['WT_SESSION'] !== undefined || process.env['TERM_PROGRAM'] === 'vscode';
  return modern ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

function useColor(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return process.stdout.isTTY === true;
}

const CODES = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
} as const;

function paint(text: string, code: keyof typeof CODES, colored: boolean): string {
  return colored ? `${CODES[code]}${text}${CODES.reset}` : text;
}

function colorFor(outcome: Outcome): keyof typeof CODES {
  if (outcome === 'ok') return 'green';
  if (outcome === 'degraded') return 'yellow';
  return 'red';
}

function terminalWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols === 'number' && cols >= 40) return Math.min(cols, 100);
  return 80;
}

/** Word-wrap `text` to `width`, prefixing every line with `indent`. */
export function wrap(text: string, width: number, indent: string): string[] {
  const usable = Math.max(20, width - indent.length);
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (current === '') {
      current = word;
    } else if (current.length + 1 + word.length <= usable) {
      current += ` ${word}`;
    } else {
      lines.push(indent + current);
      current = word;
    }
  }
  if (current !== '') lines.push(indent + current);
  return lines;
}

export function renderCheck(check: CheckResult, colored: boolean, width: number): string[] {
  const g = glyphs();
  const mark = paint(g[check.outcome], colorFor(check.outcome), colored);
  const title = check.title.padEnd(32, ' ');
  const out: string[] = [`  ${mark}  ${title} ${paint(check.found, 'dim', colored)}`];

  const indent = '        ';
  if (check.outcome === 'degraded' && check.impact !== undefined) {
    for (const line of wrap(`lost: ${check.impact}`, width, indent)) {
      out.push(paint(line, 'yellow', colored));
    }
  }
  // A blocking result MUST carry a fix (outcome contract); a degraded one may. When it does, it
  // gets printed: a command the reader could paste, held back because the finding was only a ⚠,
  // is a check that describes a problem and then hides its own answer in `--json`.
  if (check.outcome !== 'ok' && check.fix !== undefined) {
    out.push(paint(`${indent}fix:  ${check.fix}`, check.outcome === 'blocking' ? 'red' : 'yellow', colored));
  }
  if (check.note !== undefined) {
    for (const line of wrap(check.note, width, indent)) {
      out.push(paint(line, 'dim', colored));
    }
  }
  return out;
}

export function renderReport(report: DoctorReport, colored: boolean = useColor()): string {
  const width = terminalWidth();
  // One lookup for the whole report: every suggestion below has to be a command this reader can
  // actually run, and `army` is only one of four ways to be running right now.
  const self = invokedAs();
  const lines: string[] = [];
  lines.push('');
  lines.push(paint(`${self} doctor`, 'bold', colored) + paint('  — environment check', 'dim', colored));
  lines.push('');
  for (const check of report.checks) lines.push(...renderCheck(check, colored, width));
  lines.push('');

  const { ok, degraded, blocking } = report.counts;
  const summary = [
    paint(`${ok} ok`, ok > 0 ? 'green' : 'dim', colored),
    paint(`${degraded} degraded`, degraded > 0 ? 'yellow' : 'dim', colored),
    paint(`${blocking} blocking`, blocking > 0 ? 'red' : 'dim', colored),
  ].join(paint(' · ', 'dim', colored));
  lines.push(`  ${summary}${paint(`   (${report.elapsedMs}ms)`, 'dim', colored)}`);
  lines.push('');

  if (blocking > 0) {
    lines.push(
      paint('  Not ready.', 'red', colored) + ` Fix the ✗ items above, then re-run \`${self} doctor\`.`,
    );
  } else if (degraded > 0) {
    lines.push(
      paint('  Ready, with reduced capability.', 'yellow', colored) +
        ' Everything above still runs — see the ⚠ items for what you give up.',
    );
  } else {
    lines.push(paint('  Ready.', 'green', colored) + ` Full capability. Next: \`${self} init\`.`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type DoctorOptions = { json: boolean; timeoutMs: number };

/** Same refusing shape as `parseEnlistArgs`: a diagnosis to print, never a guessed run. */
export type DoctorArgs = { ok: true; options: DoctorOptions } | { ok: false; error: string };

export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
  const options: DoctorOptions = { json: false, timeoutMs: 5000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const raw = arg === '--timeout' ? argv[++i] : arg.slice('--timeout='.length);
      // Digits only, same screen as `--rung`: `Number('')` is 0 and `Number('5e3')` is 5000, and
      // a flag whose value silently differs from what was typed is the failure mode this parser
      // used to have in a worse form — an unparseable timeout silently became the default, so
      // `--timeout banana` checked with a budget nobody chose.
      const value = raw !== undefined && /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
      if (!Number.isFinite(value) || value <= 0) {
        return {
          ok: false,
          error: `--timeout expects a positive number of milliseconds, got ${JSON.stringify(raw ?? '')}`,
        };
      }
      options.timeoutMs = value;
    } else if (arg.startsWith('-')) {
      // A typo'd flag that runs anyway is a typo that hides; every sibling command refuses.
      return { ok: false, error: `unknown option ${arg}` };
    } else {
      return { ok: false, error: `unexpected argument ${JSON.stringify(arg)} — doctor takes no positional arguments` };
    }
  }
  return { ok: true, options };
}

/** Runs the checks and prints them. Returns the process exit code. */
export async function doctorCommand(argv: readonly string[]): Promise<number> {
  const self = invokedAs();
  const parsed = parseDoctorArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${self} doctor: ${parsed.error}\nTry \`${self} doctor --help\`.\n`);
    return 1;
  }
  const report = await runChecks(parsed.options.timeoutMs);

  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderReport(report));
  }
  return report.ok ? 0 : 1;
}

/**
 * Used by `army init`: run the checks quietly and hand back the report so the
 * caller can refuse to proceed on a blocking failure.
 */
export async function doctorReport(timeoutMs: number = 5000): Promise<DoctorReport> {
  return runChecks(timeoutMs);
}
