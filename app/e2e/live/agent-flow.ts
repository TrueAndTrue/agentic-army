/**
 * Live: a real claude chat agent asks to start Quick fix with its start_flow tool, the probe
 * approves the request as you would, the run goes through claude, codex and Jev, and the agent's
 * next turn is asked what happened. Costs money; needs TYPESAFE_API_KEY.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Run, SessionItem } from '../../src/shared/types.ts';
import { launch, shot, until } from '../harness.ts';

const root = mkdtempSync(join(process.env['SCRATCH'] ?? tmpdir(), 'live-agent-'));
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
const p = await page.evaluate((path) => window.api.addProject(path), project);
await page.getByRole('button', { name: `New session in ${p!.name}` }).click();
await page.getByLabel('Model', { exact: true }).selectOption({ label: process.env['MODEL'] ?? 'Sonnet 5' });
await page.getByLabel('Effort', { exact: true }).selectOption('low');
const say = async (text: string) => {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.keyboard.press('Enter');
};
const items = () =>
  page.evaluate(async () => {
    const s = await window.api.getState();
    return (await window.api.getSession(s.sessions[0]!.id))!.items;
  }) as Promise<SessionItem[]>;
const t0 = Date.now();
const at = () => `[${Math.round((Date.now() - t0) / 1000)}s]`;

await say('calc.js needs a multiply(a, b) function with a node:test test. That is a job for one of my flows rather than a chat edit: please start the right one for it.');
await until(async () => (await items()).some((i) => i.kind === 'flow-request' || i.kind === 'run') || (await items()).some((i) => i.kind === 'agent' && i.status !== 'running'), 5 * 60000, 'the agent to answer');
let list = await items();
const agent1 = list.find((i) => i.kind === 'agent') as Extract<SessionItem, { kind: 'agent' }>;
console.log(`${at()} AGENT 1 tools: ${agent1.tools.map((t) => `${t.name}(${t.summary})`).join(', ')}\n${agent1.text.slice(0, 600)}`);
const req = list.find((i) => i.kind === 'flow-request') as Extract<SessionItem, { kind: 'flow-request' }> | undefined;
if (req === undefined) {
  console.log('NO REQUEST. Items:', JSON.stringify(list.map((i) => i.kind)));
  await shot(page, 'live-agent-no-request');
  await app.close();
  process.exit(1);
}
console.log(`${at()} REQUEST: ${req.model} wants ${req.flowName}\n  why: ${req.why}\n  objective: ${req.objective}`);
await shot(page, 'live-agent-request');
await page.getByRole('article', { name: /asks to run/ }).getByRole('button', { name: 'Start it' }).click();

const getRun = async () => {
  const it = (await items()).find((i) => i.kind === 'run') as { runId: string } | undefined;
  return it === undefined ? null : ((await page.evaluate((id) => window.api.getRun(id), it.runId)) as Run | null);
};
await until(async () => {
  const r = await getRun();
  return r !== null && r.status !== 'running' && r.status !== 'waiting';
}, 20 * 60000, 'the run to finish');
const r = (await getRun())!;
console.log(`${at()} RUN ${r.status} cost $${r.costUsd.toFixed(3)} branch ${r.branch ?? '-'} startedBy ${JSON.stringify(r.startedBy)} error ${r.error ?? '-'}`);
await shot(page, 'live-agent-run-done');

await until(async () => (await items()).filter((i) => i.kind === 'agent').every((i) => (i as { status: string }).status !== 'running'), 60000, 'the chat to be idle');
await say('How did that go? One or two sentences.');
await until(async () => {
  const a = (await items()).filter((i) => i.kind === 'agent');
  return a.length === 2 && (a[1] as { status: string }).status !== 'running';
}, 5 * 60000, 'the second answer');
list = await items();
const agent2 = list.filter((i) => i.kind === 'agent')[1] as Extract<SessionItem, { kind: 'agent' }>;
console.log(`${at()} AGENT 2: ${agent2.text.slice(0, 700)}`);
await shot(page, 'live-agent-followup');
await app.close();
