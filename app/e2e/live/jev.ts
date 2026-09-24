import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { Flow, Run } from '../../src/shared/types.ts';
import { launch, shot, until } from '../harness.ts';

const SHOP = `<!doctype html><title>Kettle Shop</title><h1>Kettle Shop</h1>
<form action="/search"><input name="q" placeholder="Search products"><button>Search</button></form>`;
const RESULTS = `<!doctype html><title>Results</title><h1>Results for kettle</h1>
<div><h2>Steel kettle</h2><p>Price: £24</p><button onclick="document.body.innerHTML='<h1>Order placed. Card charged £24.</h1>'">Place order</button>
<a href="/">Back to shop</a></div>`;
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(req.url?.startsWith('/search') ? RESULTS : SHOP);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

const root = mkdtempSync(join(process.env['SCRATCH'] ?? tmpdir(), 'live-'));
const project = join(root, 'p');
mkdirSync(project);
writeFileSync(join(project, 'README.md'), '# p\n');
execFileSync('git', ['init', '-q'], { cwd: project });

const { app, page } = await launch({ live: true, root });
const p = await page.evaluate((path) => window.api.addProject(path), project);

// A flow that exists only for this test: the browser, straight to End.
const flow: Flow = {
  id: 'flow_guard_test',
  name: 'Guard test',
  description: 'Browser buys a kettle.',
  updatedAt: new Date().toISOString(),
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
    { id: 'shop', type: 'browser', position: { x: 260, y: 0 }, data: { label: 'Shop', goal: 'search for "kettle" and buy the steel kettle', startUrl: `http://127.0.0.1:${port}/`, maxSteps: 6, guard: true, guardThreshold: 0.5, showWindow: true } },
    { id: 'end', type: 'end', position: { x: 520, y: 0 }, data: { label: 'End', template: '{{input}}' } },
    { id: 'stopped', type: 'end', position: { x: 520, y: 140 }, data: { label: 'Stopped', template: '{{input}}' } },
  ],
  edges: [
    { id: 'e1', source: 'start', sourceHandle: 'out', target: 'shop' },
    { id: 'e2', source: 'shop', sourceHandle: 'done', target: 'end' },
    { id: 'e3', source: 'shop', sourceHandle: 'failed', target: 'stopped' },
  ],
};
await page.evaluate((f) => window.api.saveFlow(f), flow);
await page.getByRole('button', { name: `New session in ${p!.name}` }).click();
await page.getByLabel('Where this message goes').selectOption({ label: 'Guard test' });
await page.getByRole('textbox', { name: 'Message' }).fill('buy a kettle');
await page.keyboard.press('Enter');

const run = () =>
  page.evaluate(async () => {
    const s = await window.api.getState();
    const sess = await window.api.getSession(s.sessions[0]!.id);
    const item = sess!.items.filter((i) => i.kind === 'run').at(-1) as { runId: string } | undefined;
    return item === undefined ? null : window.api.getRun(item.runId);
  }) as Promise<Run | null>;

let asked = '';
await until(async () => {
  const r = await run();
  if (r === null) return false;
  const q = r.pending[0];
  if (q !== undefined && asked === '') {
    asked = q.body;
    await page.getByRole('button', { name: 'Open run' }).click();
    await page.waitForTimeout(500);
    await shot(page, '50-guard-question');
    await page.getByRole('button', { name: 'Refuse', exact: true }).click();
  }
  return r.status !== 'running' && r.status !== 'waiting';
}, 180000, 'the guard run');
const r = (await run())!;
console.log('GUARD ASKED:\n' + asked);
console.log('status', r.status, 'result:', (r.result ?? '').split('\n')[0]);
for (const s of r.nodes['shop']!.visits[0]!.steps ?? []) console.log(`  step ${s.n}: ${s.action} | ${s.outcome} | conf ${s.confidence.toFixed(2)} | risk ${s.risk?.toFixed(2) ?? '-'}`);
await page.getByRole('button', { name: 'steps', exact: true }).click();
await page.waitForTimeout(400);
await shot(page, '51-guard-steps');

// Auto routing: a question and a feature request.
await page.getByLabel('Where this message goes').selectOption({ value: 'auto' });
for (const msg of ['What does the README say?', 'Add a CONTRIBUTING.md that explains how to run the tests, and have it reviewed']) {
  await page.getByRole('textbox', { name: 'Message' }).fill(msg);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  const note = await page.evaluate(async () => {
    const s = await window.api.getState();
    const sess = await window.api.getSession(s.sessions[0]!.id);
    return (sess!.items.filter((i) => i.kind === 'notice').at(-1) as { text: string } | undefined)?.text;
  });
  console.log(`AUTO "${msg}" -> ${note}`);
  await page.evaluate(async () => {
    const s = await window.api.getState();
    await window.api.stop(s.sessions[0]!.id);
  });
  await page.waitForTimeout(1500);
}
await shot(page, '52-auto');
await app.close();
server.close();
