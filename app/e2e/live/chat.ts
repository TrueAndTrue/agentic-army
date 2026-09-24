import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { agentItems, launch, shot, until } from '../harness.ts';

const SCRATCH = process.env['SCRATCH'] ?? tmpdir();
const root = mkdtempSync(join(SCRATCH, 'live-'));
const project = join(root, 'calc');
execFileSync('mkdir', ['-p', project]);
writeFileSync(join(project, 'calc.js'), 'exports.add = (a, b) => a + b;\n');
writeFileSync(join(project, 'calc.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./calc.js');\ntest('add', () => assert.equal(add(2, 3), 5));\n");
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'calc', version: '1.0.0', scripts: { test: 'node --test' } }, null, 1));
const git = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-qm', 'a calculator with one operation');
console.log('project', project);

const { app, page, home } = await launch({ live: true, root });
console.log('home', home);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const p = await page.evaluate((path) => window.api.addProject(path), project);
await page.getByRole('button', { name: `New session in ${p!.name}` }).click();
if (process.env['MODEL'] !== undefined) await page.getByLabel('Model').selectOption({ label: process.env['MODEL'] });
await page.getByLabel('Effort').selectOption(process.env['EFFORT'] ?? 'low');
const box = page.getByRole('textbox', { name: 'Message' });
await box.fill('What does calc.js export? One sentence.');
await page.keyboard.press('Enter');
const t0 = Date.now();
await page.waitForTimeout(2500);
await shot(page, '30-live-streaming');
const settled = (n: number) =>
  until(async () => {
    const agents = await agentItems(page);
    return agents.length >= n && agents.every((x) => x.status !== 'running');
  }, 180000, `${String(n)} finished replies`);
await settled(1);
console.log('turn 1 took', Date.now() - t0, 'ms');
await box.fill(process.env['TURN2'] ?? 'What exact question did I just ask you? Quote it.');
await page.keyboard.press('Enter');
await settled(2);
await shot(page, '31-live-two-turns');
const sess = await page.evaluate(async () => {
  const s = await window.api.getState();
  return window.api.getSession(s.sessions[0]!.id);
});
for (const it of sess!.items) {
  if (it.kind === 'agent') console.log('AGENT', it.status, it.costUsd, JSON.stringify(it.text).slice(0, 300), it.error ?? '');
  else if (it.kind === 'user') console.log('USER', it.text);
  else console.log(it.kind, JSON.stringify(it).slice(0, 200));
}
console.log('chat', JSON.stringify(sess!.chat));
await app.close();
