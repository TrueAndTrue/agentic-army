/**
 * Launches the built app against a throwaway home, a throwaway git project, the engine's fake
 * claude and codex, and a fake Jev. Nothing here spends money or touches your real settings.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

const APP = resolve(import.meta.dirname, '..');
const FIXTURES = resolve(APP, '../test/fixtures');

export interface JevCall {
  state: unknown;
  questions: Record<string, { type: string; criteria?: unknown }>;
  /** The Authorization header the app sent. */
  auth?: string;
}

/** Answers every noul with `noul`, every choice with `choice(criteria)`, every score with 2. */
export function fakeJev(opts: { noul?: (id: string) => number; choice?: (id: string, keys: string[]) => string } = {}) {
  const calls: JevCall[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers.authorization === 'Bearer bad-key') {
        res.statusCode = 401;
        res.end('{"error":"invalid api key"}');
        return;
      }
      const parsed = JSON.parse(body) as JevCall;
      calls.push({ ...parsed, auth: req.headers.authorization ?? '' });
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(parsed.questions)) {
        if (q.type === 'noul') answers[id] = { type: 'noul', noul: opts.noul?.(id) ?? 0.9 };
        else if (q.type === 'choice') {
          const keys = Object.keys(q.criteria as object);
          const pick = opts.choice?.(id, keys) ?? keys[0]!;
          answers[id] = { type: 'choice', choice: pick, confidence: 0.88, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 0.9 : 0.1 / (keys.length - 1)])) };
        } else answers[id] = { type: 'score', score: 2, confidence: 0.8, legend: {}, probabilities: { '2': 0.8 } };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'jev-fake', answers, usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  return {
    calls,
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      return `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
    },
    close: () => server.close(),
  };
}

export function makeProject(root: string, name = 'calc'): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'calc.js'), 'exports.add = (a, b) => a + b;\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, scripts: { test: 'node -e "process.exit(0)"' } }, null, 1));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a calculator');
  return dir;
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  home: string;
  root: string;
}

export async function launch(opts: { jevUrl?: string; claudeMode?: string; env?: Record<string, string>; home?: string; root?: string; live?: boolean }): Promise<Launched> {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'army-e2e-'));
  const home = opts.home ?? join(root, 'home');
  mkdirSync(home, { recursive: true });
  if (opts.home === undefined && opts.live !== true) {
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ typesafe: { apiKey: 'fake-key', model: 'jev-latest', baseUrl: opts.jevUrl }, theme: 'dark' }),
    );
  }
  // codex's model list, as codex 0.154 writes it, so the models on offer do not depend on this machine.
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  const levels = (...e: string[]) => e.map((effort) => ({ effort }));
  writeFileSync(
    join(codexHome, 'models_cache.json'),
    JSON.stringify({
      models: [
        { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', visibility: 'list', priority: 1, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
        { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', priority: 8, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max') },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12, supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh') },
      ],
    }),
  );
  // The app checks the machine with `claude --version` and `codex --version`. The fakes do not
  // answer that: they wait on stdin until the check gives up, and they overwrite FAKE_PROBE_FILE,
  // which tests read to see what a real turn received. A wrapper answers it and passes the rest on.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const wrap = (name: string, fixture: string, version: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nif [ "$#" = 1 ] && [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexec "${join(FIXTURES, fixture)}" "$@"\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const fakeClaude = wrap('claude', 'fake-claude.mjs', '2.1.281 (Claude Code)');
  const fakeCodex = wrap('codex', 'fake-codex.mjs', 'codex-cli 0.154.0');
  const require = createRequire(import.meta.url);
  // ARMY_E2E_PACKAGED=1 runs the same tests against the built .app instead of the dev build.
  const packaged = process.env['ARMY_E2E_PACKAGED'] === '1';
  // Set ARMY_E2E_SHOW=1 to watch the window; by default it runs hidden and never takes focus.
  const hidden: Record<string, string> = process.env['ARMY_E2E_SHOW'] === '1' ? {} : { ARMY_APP_HIDDEN: '1' };
  const app = await electron.launch({
    executablePath: packaged ? join(APP, 'release/mac-universal/Agentic Army.app/Contents/MacOS/Agentic Army') : (require('electron') as unknown as string),
    args: packaged ? [] : [join(APP, 'out/main/index.js')],
    cwd: APP,
    env:
      opts.live === true
        ? { ...process.env, ARMY_APP_HOME: home, ARMY_APP_NO_QUIT_CONFIRM: '1', ARMY_APP_MOCK_KEYCHAIN: '1', ...hidden, ...(opts.env ?? {}) }
        : {
            ...process.env,
            ARMY_APP_HOME: home,
            ARMY_APP_NO_QUIT_CONFIRM: '1',
            // Keys are encrypted with Chromium's stand-in Keychain, never your login Keychain.
            ARMY_APP_MOCK_KEYCHAIN: '1',
            ...hidden,
            // The army's own home (config, archive) goes somewhere throwaway too.
            AGENTIC_ARMY_HOME: join(root, 'army-home'),
            ARMY_CLAUDE_BIN: fakeClaude,
            ARMY_CODEX_BIN: fakeCodex,
            FAKE_CLAUDE_MODE: opts.claudeMode ?? 'ok',
            TYPESAFE_API_KEY: '',
            CODEX_HOME: codexHome,
            ...(opts.env ?? {}),
          },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.waitForSelector('#root > div');
  return { app, page, home, root };
}

export const SHOTS = process.env['ARMY_SHOTS'] ?? join(tmpdir(), 'army-shots');
mkdirSync(SHOTS, { recursive: true });

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/**
 * Poll until `check` returns true. Playwright's waitForFunction treats a returned Promise as a
 * truthy value and resolves at once, so async checks against window.api go through this instead.
 */
export async function until(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out after ${String(timeoutMs / 1000)} s waiting for ${what}`);
}

/** The first session's agent replies, as the main process holds them. */
export async function agentItems(page: Page): Promise<{ status: string; text: string; error?: string; costUsd?: number; tools: { name: string; summary: string }[] }[]> {
  return page.evaluate(async () => {
    const s = await window.api.getState();
    const id = s.sessions[0]?.id;
    if (id === undefined) return [];
    const sess = await window.api.getSession(id);
    return (sess?.items ?? []).filter((i) => i.kind === 'agent') as never;
  });
}
