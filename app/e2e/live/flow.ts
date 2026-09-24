import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Run } from '../../src/shared/types.ts';
import { launch, shot, until } from '../harness.ts';

const SCRATCH = process.env['SCRATCH'] ?? tmpdir();
const FLOW = process.env['FLOW'] ?? 'Quick fix';
const MESSAGE = process.env['MESSAGE'] ?? 'Add a multiply(a, b) function to calc.js and a node:test test for it in calc.test.js.';
const root = mkdtempSync(join(SCRATCH, 'live-'));
const project = join(root, 'calc');
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'calc.js'), 'exports.add = (a, b) => a + b;\n');
writeFileSync(join(project, 'calc.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./calc.js');\ntest('add', () => assert.equal(add(2, 3), 5));\n");
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'calc', version: '1.0.0', scripts: { test: 'node --test' } }, null, 1));
const git = (...a: string[]) => execFileSync('git', a, { cwd: project }).toString();
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-qm', 'a calculator with one operation');

const { app, page } = await launch({ live: true, root });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const p = await page.evaluate((path) => window.api.addProject(path), project);
await page.getByRole('button', { name: `New session in ${p!.name}` }).click();
await page.getByLabel('Where this message goes').selectOption({ label: FLOW });
await page.getByRole('textbox', { name: 'Message' }).fill(MESSAGE);
await page.keyboard.press('Enter');
const t0 = Date.now();
const getRun = () =>
  page.evaluate(async () => {
    const s = await window.api.getState();
    const sess = await window.api.getSession(s.sessions[0]!.id);
    const item = sess!.items.find((i) => i.kind === 'run') as { runId: string } | undefined;
    return item === undefined ? null : window.api.getRun(item.runId);
  }) as Promise<Run | null>;
await page.getByRole('button', { name: 'Open run' }).click({ timeout: 30000 });
let shots = 0;
await until(async () => {
  const r = await getRun();
  if (r === null) return false;
  for (const q of r.pending) {
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] APPROVING: ${q.title}\n${q.body.slice(0, 600)}\n---`);
    await page.evaluate(({ id, qid }) => window.api.answer(id, qid, true, ''), { id: r.id, qid: q.id });
  }
  if (Date.now() - t0 > shots * 60000) {
    await shot(page, `40-live-flow-${shots}`);
    shots += 1;
  }
  return r.status !== 'running' && r.status !== 'waiting';
}, 30 * 60000, 'the run to finish');
const r = (await getRun())!;
await shot(page, '41-live-flow-done');
console.log(`status ${r.status} in ${Math.round((Date.now() - t0) / 1000)}s cost $${r.costUsd.toFixed(3)} branch ${r.branch} error ${r.error ?? '-'}`);
for (const n of r.flow.nodes) {
  const st = r.nodes[n.id]!;
  for (const v of st.visits) {
    console.log(`\n## ${n.data.label} visit ${v.n} -> ${v.handle ?? '-'} ${v.error ?? ''}`);
    if (v.turn) console.log(`tools: ${v.turn.tools.map((t) => `${t.name}(${t.summary.slice(0, 50)})`).join(', ')}\n${(v.turn.final ?? v.turn.text).slice(0, 900)}`);
    if (v.judgment) console.log(`jev: ${JSON.stringify(v.judgment)}`);
    if (v.log) console.log(v.log.slice(0, 400));
  }
}
if (r.branch !== undefined) {
  await page.getByRole('button', { name: 'changes', exact: true }).click();
  await page.waitForTimeout(1000);
  await shot(page, '42-live-flow-changes');
  const m = await page.evaluate((id) => window.api.mergeRun(id), r.id);
  console.log('merge:', m);
  console.log(git('log', '--oneline', '-4'));
  try {
    console.log(execFileSync('npm', ['test'], { cwd: project }).toString().split('\n').filter((l) => /^# (pass|fail)|^ℹ (pass|fail)|ok \d/.test(l)).join('\n'));
  } catch (e) {
    console.log('npm test failed', String((e as { stdout?: Buffer }).stdout ?? e));
  }
}
await app.close();
