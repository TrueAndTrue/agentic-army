/**
 * The app, driven through its window. Every test launches the built app against a throwaway
 * home and project, the engine's fake claude and codex, and a fake Jev, so the suite costs
 * nothing and gives the same answer every time. `npm run e2e` builds first.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import type { Run } from '../src/shared/types.ts';
import { agentItems, fakeJev, launch, makeProject, shot, until, type Launched } from './harness.ts';

const jev = fakeJev();
const jevUrl = await jev.listen();
after(() => jev.close());

/** Launch, run the body, and always close, so a failure reports instead of leaving a window open. */
async function withApp(opts: Parameters<typeof launch>[0], body: (l: Launched) => Promise<void>): Promise<void> {
  const l = await launch(opts);
  try {
    await body(l);
  } finally {
    await Promise.race([l.app.close(), new Promise((r) => setTimeout(r, 8000))]);
  }
}

async function openSession(l: Launched, name = 'calc'): Promise<string> {
  const project = makeProject(l.root, name);
  const p = await l.page.evaluate((path) => window.api.addProject(path), project);
  await l.page.getByRole('button', { name: `New session in ${p!.name}` }).click();
  return project;
}

async function send(l: Launched, text: string, flow?: string): Promise<void> {
  if (flow !== undefined) await l.page.getByLabel('Where this message goes').selectOption({ label: flow });
  await l.page.getByRole('textbox', { name: 'Message' }).fill(text);
  await l.page.keyboard.press('Enter');
}

async function lastRun(l: Launched): Promise<Run | null> {
  return (await l.page.evaluate(async () => {
    const s = await window.api.getState();
    const id = s.sessions[0]?.id;
    if (id === undefined) return null;
    const sess = await window.api.getSession(id);
    const item = sess?.items.filter((i) => i.kind === 'run').at(-1) as { runId: string } | undefined;
    return item === undefined ? null : window.api.getRun(item.runId);
  })) as Run | null;
}

async function runToEnd(l: Launched, approve = true): Promise<Run> {
  await until(
    async () => {
      const r = await lastRun(l);
      if (r === null) return false;
      for (const q of r.pending) await l.page.evaluate(({ id, qid, ok }) => window.api.answer(id, qid, ok, ''), { id: r.id, qid: q.id, ok: approve });
      return r.status !== 'running' && r.status !== 'waiting';
    },
    60000,
    'the run to finish',
  );
  return (await lastRun(l))!;
}

function fakeAgents(): number {
  try {
    return execFileSync('pgrep', ['-f', 'fake-claude.mjs']).toString().trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe('sessions', () => {
  test('a chat streams its reply, and after a restart the next turn resumes the same conversation', async () => {
    let home = '';
    let root = '';
    await withApp({ jevUrl }, async (l) => {
      home = l.home;
      root = l.root;
      await openSession(l);
      await send(l, 'What does calc.js export?');
      await l.page.getByText('echo:What does calc.js export?').waitFor();
      await until(async () => (await agentItems(l.page))[0]?.status === 'done', 20000, 'the first reply');
    });
    const probe = join(root, 'argv.json');
    await withApp({ jevUrl, home, root, env: { FAKE_PROBE_FILE: probe } }, async (l) => {
      await l.page.getByRole('navigation').getByRole('button', { name: /What does calc.js export/ }).click();
      await send(l, 'And now?');
      await until(async () => (await agentItems(l.page)).filter((a) => a.status === 'done').length === 2, 20000, 'the second reply');
      const argv = (JSON.parse(readFileSync(probe, 'utf8')) as { argv: string[] }).argv;
      assert.ok(argv.includes('--resume'), `the second turn resumed: ${argv.join(' ')}`);
      assert.equal(argv.includes('--session-id'), false);
      await shot(l.page, 'e2e-chat-resumed');
    });
  });

  test('Stop ends a running reply, and quitting leaves no agent process behind', async () => {
    await withApp({ jevUrl, claudeMode: 'slow' }, async (l) => {
      await openSession(l);
      await send(l, 'take your time');
      await until(async () => (await agentItems(l.page)).length === 1 && fakeAgents() > 0, 10000, 'the agent to start');
      await l.page.getByRole('button', { name: 'Stop' }).click();
      await until(async () => (await agentItems(l.page))[0]?.status === 'stopped', 10000, 'the reply to stop');
      await send(l, 'another slow one');
      await until(async () => (await agentItems(l.page)).length === 2 && fakeAgents() > 0, 10000, 'the second agent');
    });
    await until(async () => fakeAgents() === 0, 10000, 'every agent to be gone after quit');
  });
});

describe('models', () => {
  test("codex's own model list is on offer, and each model shows and gets only the efforts it takes", async () => {
    const probe = join(mkdtempSync(join(tmpdir(), 'army-probe-')), 'codex-argv.json');
    await withApp({ jevUrl, env: { FAKE_PROBE_FILE: probe } }, async (l) => {
      await openSession(l);
      const model = l.page.getByLabel('Model', { exact: true });
      const effort = l.page.getByLabel('Effort', { exact: true });
      const options = async () => effort.locator('option').allTextContents();
      await model.selectOption({ label: 'GPT-6-Astra' });
      assert.deepEqual(await options(), ['low effort', 'medium effort', 'high effort', 'xhigh effort', 'max effort', 'ultra effort']);
      await effort.selectOption('ultra');
      await send(l, 'Which file exports add?');
      await until(async () => (await agentItems(l.page))[0]?.status === 'done', 20000, 'the codex reply');
      const argv = (JSON.parse(readFileSync(probe, 'utf8')) as { argv: string[] }).argv;
      assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-6-astra');
      assert.ok(argv.includes('model_reasoning_effort=ultra'), argv.join(' '));

      // GPT-5.5 stops at xhigh: switching keeps the chat on the highest level it takes.
      await model.selectOption({ label: 'GPT-5.5' });
      await until(async () => (await effort.inputValue()) === 'xhigh', 5000, 'the effort to fit GPT-5.5');
      assert.deepEqual(await options(), ['low effort', 'medium effort', 'high effort', 'xhigh effort']);

      await l.page.getByRole('button', { name: 'Settings' }).click();
      await l.page.getByText('Effort low, medium, high, xhigh, max, ultra.').first().waitFor();
      await l.page.getByText('Frontier intelligence for the most demanding work.').waitFor();
      assert.equal(await l.page.getByRole('button', { name: 'Save' }).isDisabled(), true, 'nothing to save until you change something');
      const listed = await l.page.getByRole('textbox').evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value).filter((v) => v.startsWith('GPT')));
      assert.deepEqual(listed, ['GPT-6-Astra', 'GPT-5.6-Luna', 'GPT-5.5'], 'newest codex model first');
      await shot(l.page, 'e2e-models-settings');
    });
  });
});

describe('flows', () => {
  test('Quick fix builds on its own branch, shows the diff, and merges into main', async () => {
    await withApp({ jevUrl, claudeMode: 'work' }, async (l) => {
      const project = await openSession(l);
      await send(l, 'Add multiply', 'Quick fix');
      const r = await runToEnd(l);
      assert.equal(r.status, 'succeeded', r.error);
      assert.deepEqual(
        ['build', 'review', 'passed', 'end'].map((id) => r.nodes[id]?.status),
        ['done', 'done', 'done', 'done'],
      );
      assert.ok(r.branch?.startsWith('army/run-'));
      assert.equal(existsSync(join(project, 'engineer-work.txt')), false, 'the checkout is untouched before the merge');
      await l.page.getByRole('button', { name: /Review changes on army\/run-/ }).click();
      await l.page.getByText('+engineer was here').waitFor();
      await l.page.getByRole('button', { name: /Merge into main/ }).click();
      await l.page.getByText(/^Merged army\/run-/).first().waitFor();
      assert.equal(readFileSync(join(project, 'engineer-work.txt'), 'utf8'), 'engineer was here\nand edited it\n');
      await shot(l.page, 'e2e-quick-fix-merged');
    });
  });

  test('Build and review waits for both approvals and loops back to Build when Jev says the review failed', async () => {
    let reviews = 0;
    const strict = fakeJev({ noul: () => (++reviews === 1 ? 0.1 : 0.95) });
    const url = await strict.listen();
    try {
      await withApp({ jevUrl: url, claudeMode: 'work' }, async (l) => {
        await openSession(l);
        await send(l, 'Add divide', 'Build and review');
        await l.page.getByRole('button', { name: 'Approve', exact: true }).waitFor({ timeout: 30000 });
        const waiting = await lastRun(l);
        assert.equal(waiting?.status, 'waiting');
        assert.equal(waiting?.pending[0]?.title, 'Approve plan');
        const r = await runToEnd(l);
        assert.equal(r.status, 'succeeded', r.error);
        assert.equal(r.nodes['build']?.visits.length, 2, 'a failed review sent the work back once');
        assert.deepEqual(r.nodes['passed']?.visits.map((v) => v.handle), ['no', 'yes']);
        assert.equal(r.nodes['sign_off']?.visits.length, 1);
        assert.match(r.result ?? '', /^Finished on branch army\/run-/);
      });
    } finally {
      strict.close();
    }
  });

  test('a rejected plan goes back to the planner with the note', async () => {
    await withApp({ jevUrl, claudeMode: 'work' }, async (l) => {
      await openSession(l);
      await send(l, 'Add divide', 'Build and review');
      await l.page.getByRole('button', { name: 'Reject', exact: true }).waitFor({ timeout: 30000 });
      await l.page.getByPlaceholder(/Optional note/).fill('Use integer division');
      await l.page.getByRole('button', { name: 'Reject', exact: true }).click();
      await until(async () => ((await lastRun(l))?.nodes['plan']?.visits.length ?? 0) === 2, 30000, 'a second plan');
      const r = (await lastRun(l))!;
      assert.match(r.nodes['plan']!.visits[1]!.input, /From the person reviewing: Use integer division/);
      await l.page.evaluate((id) => window.api.stopRun(id), r.id);
      await until(async () => (await lastRun(l))?.status === 'stopped', 10000, 'the run to stop');
    });
  });

  test('a flow that uses Jev will not start without a TypeSafe key', async () => {
    await withApp({ jevUrl }, async (l) => {
      await l.page.evaluate(async () => {
        const s = await window.api.getState();
        await window.api.saveSettings({ ...s.settings, typesafe: { ...s.settings.typesafe, apiKey: '' } });
      });
      await openSession(l);
      await send(l, 'Add multiply', 'Quick fix');
      await l.page.getByText(/uses Jev in "Review passed", and there is no TypeSafe API key/).waitFor();
      assert.equal(await lastRun(l), null);
    });
  });
});

describe('the canvas', () => {
  test('a flow drawn on the canvas saves and runs from a session', async () => {
    await withApp({ jevUrl }, async (l) => {
      await openSession(l);
      await l.page.getByRole('button', { name: 'Flows' }).click();
      await l.page.getByRole('button', { name: 'New flow' }).click();
      await l.page.getByRole('button', { name: 'Agent', exact: true }).click();
      const node = (label: string) => l.page.locator('.react-flow__node').filter({ hasText: label });
      await l.page.getByLabel('Name', { exact: true }).fill('Summarise');
      await l.page.getByLabel('Prompt', { exact: true }).fill('Summarise {{objective}}');
      const handle = (label: string, id: string) => node(label).locator(`.react-flow__handle[data-handleid="${id}"]`);
      // A drag can land before the canvas has settled; check each connection took, and try again if not.
      const connect = async (from: string, to: string) => {
        const edges = l.page.locator('.react-flow__edge');
        const before = await edges.count();
        for (let attempt = 0; attempt < 3 && (await edges.count()) === before; attempt += 1) {
          await handle(from, 'out').dragTo(handle(to, 'in'));
          await l.page.waitForTimeout(200);
        }
        assert.equal(await edges.count(), before + 1, `${from} connected to ${to}`);
      };
      await connect('Start', 'Summarise');
      await connect('Summarise', 'End');
      await l.page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } });
      try {
        await l.page.getByText('No problems. This flow can run.').waitFor({ timeout: 10000 });
      } catch (err) {
        await shot(l.page, 'e2e-canvas-FAILED');
        throw err;
      }
      await shot(l.page, 'e2e-canvas-drawn');
      await l.page.getByRole('button', { name: 'Save' }).click();
      await until(async () => (await l.page.evaluate(async () => (await window.api.getState()).flows.find((f) => f.name === 'Untitled flow')?.edges.length)) === 2, 5000, 'the saved flow');
      await l.page.getByRole('button', { name: 'Sessions' }).click();
      await send(l, 'the calculator', 'Untitled flow');
      const r = await runToEnd(l);
      assert.equal(r.status, 'succeeded', r.error);
      assert.match(r.result ?? '', /Summarise the calculator/);
    });
  });
});
