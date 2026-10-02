/**
 * The app, driven through its window. Every test launches the built app against a throwaway
 * home and project, the engine's fake claude and codex, and a fake Jev, so the suite costs
 * nothing and gives the same answer every time. `npm run e2e` builds first.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
      await until(async () => (await agentItems(l.page))[0]?.status === 'done', 20000, 'the first reply');
      // What start_flow starts goes in as system instructions, never in front of the message.
      assert.equal((await agentItems(l.page))[0]!.text, 'echo:What does calc.js export?');
      // Tokens, not dollars: the fake reports 1 new + 3 cache read + 4 cache written in, 2 out.
      await l.page.getByText('8 in, 38% cached, 2 out').waitFor();
      assert.equal(await l.page.getByText(/\$\d/).count(), 0, 'no dollar figure anywhere');
    });
    const probe = join(root, 'argv.json');
    await withApp({ jevUrl, home, root, env: { FAKE_PROBE_FILE: probe } }, async (l) => {
      await l.page.getByRole('navigation').getByRole('button', { name: /^What does calc.js export/ }).click();
      await send(l, 'And now?');
      await until(async () => (await agentItems(l.page)).filter((a) => a.status === 'done').length === 2, 20000, 'the second reply');
      const argv = (JSON.parse(readFileSync(probe, 'utf8')) as { argv: string[] }).argv;
      assert.ok(argv.includes('--resume'), `the second turn resumed: ${argv.join(' ')}`);
      assert.equal(argv.includes('--session-id'), false);
      const second = (await agentItems(l.page))[1]!;
      assert.equal(second.text, 'echo:And now?');
      const note = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';
      assert.match(note, /start_flow tool[\s\S]*- look-it-up-on-the-web: Look it up on the web\./, 'the flows go in as system instructions');
      await shot(l.page, 'e2e-chat-resumed');
    });
  });

  test('the sidebar keeps its order when you send in an older session', async () => {
    await withApp({ jevUrl }, async (l) => {
      await openSession(l);
      await send(l, 'First session');
      await until(async () => (await agentItems(l.page))[0]?.status === 'done', 20000, 'the first reply');
      await l.page.getByRole('button', { name: 'New session in calc' }).click();
      await send(l, 'Second session');
      const rows = l.page.getByRole('navigation').getByRole('listitem');
      await until(async () => (await rows.allTextContents()).length === 2 && (await rows.allTextContents()).every((t) => !t.startsWith('New session')), 10000, 'two named sessions');
      const order = async () => (await rows.allTextContents()).map((t) => t.replace(/(now|\d+[smhd]( ago)?)$/, '').trim());
      assert.deepEqual(await order(), ['Second session', 'First session']);
      await l.page.getByRole('navigation').getByRole('button', { name: /^First session/ }).click();
      await send(l, 'Back in the first one');
      await l.page.getByText('echo:Back in the first one').waitFor();
      assert.deepEqual(await order(), ['Second session', 'First session'], 'sending did not move the open session to the top');
    });
  });

  test('a message sent while the agent answers is queued, survives a reload, and goes out when the reply ends', async () => {
    await withApp({ jevUrl, claudeMode: 'slow' }, async (l) => {
      const userTexts = async () =>
        l.page.evaluate(async () => {
          const s = await window.api.getState();
          const sess = await window.api.getSession(s.sessions[0]!.id);
          return { users: sess!.items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text), queued: sess!.queued };
        });
      const queued = l.page.getByLabel('Queued message');
      await openSession(l);
      await send(l, 'first');
      await until(async () => (await agentItems(l.page))[0]?.status === 'running', 10000, 'the first reply to start');
      await send(l, 'second');
      await queued.getByText('Queued. It goes out when the reply ends.').waitFor();
      await l.page.getByText('A message is already queued. What you send now is added to the end of it.').waitFor();
      await send(l, 'third');
      await until(async () => (await userTexts()).queued?.text === 'second\n\nthird', 5000, 'the second send to join the queued one');
      assert.deepEqual((await userTexts()).users, ['first'], 'nothing queued went into the thread yet');
      await shot(l.page, 'e2e-queued');

      await queued.getByRole('button', { name: 'Edit' }).click();
      await queued.getByRole('textbox', { name: 'Edit queued message' }).fill('second, edited');
      await l.page.keyboard.press('Enter');
      await until(async () => (await userTexts()).queued?.text === 'second, edited', 5000, 'the edit to reach the main process');

      // The window reloading does not lose it: the main process holds the queue.
      await l.page.reload();
      await queued.getByText('second, edited').waitFor();

      await until(async () => (await userTexts()).users.length === 2, 20000, 'the queued message to go out when the reply ended');
      assert.deepEqual((await userTexts()).users, ['first', 'second, edited']);
      assert.equal((await userTexts()).queued, undefined);
      await until(async () => (await agentItems(l.page))[1]?.status === 'running', 10000, 'the second reply to start');

      // Esc still stops the reply. A stopped reply holds the queued message until you decide.
      await send(l, 'fourth');
      await queued.waitFor();
      await l.page.getByRole('textbox', { name: 'Message' }).press('Escape');
      await queued.getByText('Not sent, because you stopped the reply.').waitFor();
      assert.equal((await agentItems(l.page))[1]?.status, 'stopped');
      await queued.getByRole('button', { name: 'Send now' }).click();
      await until(async () => (await userTexts()).users.at(-1) === 'fourth', 10000, 'Send now to send it');

      await until(async () => (await agentItems(l.page))[2]?.status === 'running', 10000, 'the third reply to start');
      await send(l, 'never mind');
      await queued.getByRole('button', { name: 'Remove' }).click();
      await queued.waitFor({ state: 'detached' });
      assert.equal((await userTexts()).queued, undefined);
      await l.page.getByRole('button', { name: 'Stop' }).click();
      await until(async () => (await agentItems(l.page))[2]?.status === 'stopped', 10000, 'the third reply to stop');

      // A reply that fails holds the queued message too. This claude takes a moment, then fails.
      const failing = join(l.root, 'failing-claude');
      writeFileSync(failing, '#!/bin/sh\nsleep 2\necho "no such model" >&2\nexit 1\n');
      chmodSync(failing, 0o755);
      await l.page.evaluate(async (bin) => {
        const s = await window.api.getState();
        await window.api.saveSettings({ ...s.settings, claudeBin: bin });
      }, failing);
      await send(l, 'this one fails');
      await until(async () => (await agentItems(l.page))[3]?.status === 'running', 10000, 'the failing reply to start');
      await send(l, 'wait for me');
      await queued.getByText('Not sent, because the reply failed. Send it, change it, or remove it.').waitFor({ timeout: 15000 });
      assert.equal((await agentItems(l.page))[3]?.status, 'error');
      assert.equal((await userTexts()).queued?.text, 'wait for me');
    });
  });

  test('code blocks in a reply are highlighted, diffs keep their line colours, and each block has a copy button', async () => {
    await withApp({ jevUrl }, async (l) => {
      await openSession(l);
      // The fake claude echoes the message, so the reply carries these blocks back.
      await l.page.getByRole('textbox', { name: 'Message' }).fill(
        'Blocks:\n```ts\n// add two numbers\nexport const add = (a: number, b: number): number => a + b;\n```\n```diff\n@@ -1 +1 @@\n-old line\n+new line\n```\n```python\ndef hi(name):\n    return f"hi {name}"\n```',
      );
      await l.page.keyboard.press('Enter');
      const reply = l.page.locator('article').filter({ hasText: 'echo:Blocks:' });
      await reply.locator('.hljs-keyword', { hasText: 'export' }).waitFor();
      await reply.locator('.hljs-comment', { hasText: '// add two numbers' }).waitFor();
      await reply.locator('.hljs-string', { hasText: 'f"hi {name}"' }).waitFor();
      await reply.locator('span.text-ok', { hasText: '+new line' }).waitFor();
      await reply.locator('span.text-bad', { hasText: '-old line' }).waitFor();
      assert.equal(await reply.getByRole('button', { name: 'Copy code' }).count(), 3);
      await shot(l.page, 'e2e-code-dark');
      await l.page.evaluate(async () => {
        const s = await window.api.getState();
        await window.api.saveSettings({ ...s.settings, theme: 'light' });
      });
      await l.page.locator('html[data-theme="light"]').waitFor({ state: 'attached' });
      await shot(l.page, 'e2e-code-light');
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

describe('first run', () => {
  test('on a Mac with no claude, every dead end says how to install it, and Check again finds it once it is there', async () => {
    const root = mkdtempSync(join(tmpdir(), 'army-e2e-'));
    const userHome = join(root, 'user');
    mkdirSync(userHome);
    // A clean Mac: only the system folders on PATH, no login shell to read a longer one from, an
    // empty home folder, and no fake CLIs.
    const env = { PATH: '/usr/bin:/bin', SHELL: '/nonexistent', HOME: userHome, ARMY_CLAUDE_BIN: '', ARMY_CODEX_BIN: '' };
    await withApp({ jevUrl, root, env }, async (l) => {
      const claudeRow = l.page.getByLabel('How to install claude');
      await claudeRow.getByText('curl -fsSL https://claude.ai/install.sh | bash').waitFor();
      await l.page.getByLabel('How to install codex').getByText('npm install -g @openai/codex').waitFor();
      await l.page.getByText('The Reviewer and Validator stages run on a GPT model').waitFor();
      await shot(l.page, 'e2e-first-run-home');

      // A folder that is not a repository: chat says how to install claude, a flow says what it lacks.
      const folder = join(root, 'notes');
      mkdirSync(folder);
      writeFileSync(join(folder, 'todo.md'), '- milk\n');
      await l.page.evaluate((path) => window.api.addProject(path), folder);
      await l.page.getByRole('button', { name: 'New session in notes' }).click();
      await l.page.getByText('claude is not installed on this Mac, so Sonnet 5 cannot answer yet.').waitFor();
      await send(l, 'What is in todo.md?');
      await l.page.getByText('claude is not installed on this Mac, or the app cannot find it.').waitFor();
      await l.page.getByRole('main').getByLabel('How to install claude').waitFor();
      await send(l, 'add a line', 'Quick fix');
      await l.page.getByText(/^Quick fix did not start\. "Build" runs on claude, which is not installed\. "Review" runs on codex/).waitFor();
      await l.page.getByRole('button', { name: 'Start a git repository here' }).waitFor();
      assert.equal(await lastRun(l), null, 'nothing started');
      await shot(l.page, 'e2e-first-run-flow-blocked');

      // Claude Code's installer puts claude in ~/.local/bin. Check again finds it there without a restart.
      mkdirSync(join(userHome, '.local/bin'), { recursive: true });
      writeFileSync(join(userHome, '.local/bin/claude'), '#!/bin/sh\necho "2.1.281 (Claude Code)"\n');
      chmodSync(join(userHome, '.local/bin/claude'), 0o755);
      const help = l.page.getByRole('main').getByLabel('How to install claude').first();
      await help.getByRole('button', { name: 'Check again' }).click();
      await help.getByText('Found 2.1.281 (Claude Code).').waitFor();
    });
  });
});

describe('narrow window', () => {
  test('with a run open at 900 wide, the panel lies over the thread and the message box stays usable', async () => {
    await withApp({ jevUrl, claudeMode: 'work' }, async (l) => {
      await openSession(l);
      await send(l, 'Add multiply', 'Quick fix');
      await runToEnd(l);
      await l.page.getByRole('button', { name: 'Open run' }).click();
      // The hidden test window keeps the size it was made with, so the page's viewport stands in for
      // the window: the layout's media queries follow it the same way.
      await l.page.setViewportSize({ width: 900, height: 700 });
      const panel = l.page.getByRole('complementary', { name: 'Run' });
      await panel.getByRole('button', { name: 'changes', exact: true }).click();
      await panel.getByRole('button', { name: 'Merge into main' }).waitFor();
      const box = l.page.getByRole('textbox', { name: 'Message' });
      const p = (await panel.boundingBox())!;
      const b = (await box.boundingBox())!;
      assert.ok(p.x + p.width <= 900 && p.x >= 264, `the panel sits inside the session area: ${JSON.stringify(p)}`);
      assert.ok(p.y + p.height <= b.y, `the panel ends above the message box: panel ${JSON.stringify(p)}, box ${JSON.stringify(b)}`);
      // Nothing lies over the box: a click in its middle lands on it.
      const onTop = await l.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('aria-label'), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
      assert.equal(onTop, 'Message');
      await shot(l.page, 'e2e-narrow-900');
      await l.page.getByLabel('Where this message goes').selectOption({ label: 'Chat' });
      await box.fill('Written with the run open');
      await l.page.keyboard.press('Enter');
      await l.page.getByText('echo:Written with the run open').waitFor();
      await panel.getByRole('button', { name: 'Close run panel' }).click();
      await panel.waitFor({ state: 'detached' });
    });
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
    // `ok` is the app checking the key before the run; only the review questions count.
    const strict = fakeJev({ noul: (id) => (id === 'ok' ? 0.9 : ++reviews === 1 ? 0.1 : 0.95) });
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
      await l.page.getByRole('button', { name: 'Send back with note', exact: true }).click();
      await until(async () => ((await lastRun(l))?.nodes['plan']?.visits.length ?? 0) === 2, 30000, 'a second plan');
      const r = (await lastRun(l))!;
      assert.match(r.nodes['plan']!.visits[1]!.input, /From the person reviewing: Use integer division/);
      await l.page.evaluate((id) => window.api.stopRun(id), r.id);
      await until(async () => (await lastRun(l))?.status === 'stopped', 10000, 'the run to stop');
    });
  });

  test('a Jev flow with no TypeSafe key asks for one in the thread, checks it, and then starts', async () => {
    await withApp({ jevUrl, claudeMode: 'work' }, async (l) => {
      await l.page.evaluate(async () => {
        const s = await window.api.getState();
        await window.api.saveSettings({ ...s.settings, typesafe: { ...s.settings.typesafe, apiKey: '' } });
      });
      await openSession(l);
      await send(l, 'Add multiply', 'Quick fix');
      const card = l.page.getByRole('article', { name: 'Quick fix needs a TypeSafe key' });
      await card.getByText(/Jev makes the calls in "Review passed"/).waitFor();
      assert.equal(await lastRun(l), null, 'nothing started without the key');
      await shot(l.page, 'e2e-needs-jev');

      // A key TypeSafe refuses is not saved, and the card says why.
      await card.getByRole('textbox', { name: 'TypeSafe API key' }).fill('bad-key');
      await card.getByRole('button', { name: 'Connect and start' }).click();
      await card.getByText("TypeSafe refused the API key (invalid api key).", { exact: true }).waitFor();
      assert.equal(await l.page.evaluate(async () => (await window.api.getState()).settings.typesafe.apiKey), '');

      await card.getByRole('textbox', { name: 'TypeSafe API key' }).fill('good-key');
      await card.getByRole('button', { name: 'Connect and start' }).click();
      await l.page.getByText('Jev is connected. Quick fix started.').waitFor();
      // The window learns there is a key, never the key.
      assert.equal(await l.page.evaluate(async () => (await window.api.getState()).settings.typesafe.apiKey), '(saved)');
      assert.equal(jev.calls.at(-1)?.auth, 'Bearer good-key');
      await until(async () => (await lastRun(l))?.status === 'succeeded', 60000, 'the run to finish');
      await l.page.getByText(/Review passed\s*Jev: yes, 90% sure/).waitFor();
    });
  });
});

describe('starting flows', () => {
  async function items(l: Launched) {
    return l.page.evaluate(async () => {
      const s = await window.api.getState();
      return (await window.api.getSession(s.sessions[0]!.id))!.items;
    });
  }
  async function runs(l: Launched): Promise<Run[]> {
    return l.page.evaluate(async () => {
      const s = await window.api.getState();
      const sess = await window.api.getSession(s.sessions[0]!.id);
      const ids = sess!.items.flatMap((i) => (i.kind === 'run' ? [i.runId] : []));
      return (await Promise.all(ids.map((id) => window.api.getRun(id)))) as Run[];
    });
  }
  const settled = (r: Run | undefined) => r !== undefined && r.status !== 'running' && r.status !== 'waiting';

  test('typing / lists the flows, and /quick-fix runs Quick fix as yours', async () => {
    await withApp({ jevUrl, claudeMode: 'work' }, async (l) => {
      await openSession(l);
      await l.page.getByRole('textbox', { name: 'Message' }).fill('/qu');
      await l.page.getByRole('listbox', { name: 'Flows you can run' }).getByText('/quick-fix').waitFor();
      await l.page.keyboard.press('Tab');
      assert.equal(await l.page.getByRole('textbox', { name: 'Message' }).inputValue(), '/quick-fix ');
      await l.page.keyboard.type('Add multiply');
      await l.page.getByText('Runs Quick fix with the rest as its objective.').waitFor();
      await shot(l.page, 'e2e-slash-command');
      await l.page.keyboard.press('Enter');
      const r = await runToEnd(l);
      assert.equal(r.flowName, 'Quick fix');
      assert.equal(r.objective, 'Add multiply');
      assert.deepEqual(r.startedBy, { kind: 'you' });
    });
  });

  test('Run on the Flows page opens a session set to that flow', async () => {
    await withApp({ jevUrl }, async (l) => {
      await l.page.evaluate((path) => window.api.addProject(path), makeProject(l.root));
      await l.page.getByRole('button', { name: 'Flows', exact: true }).click();
      await l.page.getByRole('button', { name: 'Run Look it up on the web' }).click();
      assert.equal(await l.page.getByLabel('Where this message goes').inputValue(), 'builtin-web-research');
      await l.page.getByPlaceholder('What should Look it up on the web do?').waitFor();
    });
  });

  test('a chat agent asks to start Quick fix; you edit the objective and approve; it hears how it went', async () => {
    await withApp({ jevUrl, claudeMode: 'start-flow', env: { FAKE_FLOW: 'quick-fix' } }, async (l) => {
      await openSession(l);
      await send(l, 'Add multiply to calc.js');
      const card = l.page.getByRole('article', { name: /asks to run Quick fix/ });
      await card.waitFor({ timeout: 20000 });
      await l.page.getByText(/start_flow said: Asked the person to approve starting "Quick fix"/).waitFor();
      await shot(l.page, 'e2e-agent-asks');
      await card.getByRole('textbox').fill('Add multiply to calc.js, with a test for negative numbers');
      await card.getByRole('button', { name: 'Start with my edit' }).click();
      await until(async () => settled((await runs(l))[0]), 60000, 'the approved run to end');
      const [r] = await runs(l);
      assert.equal(r!.objective, 'Add multiply to calc.js, with a test for negative numbers');
      assert.equal(r!.startedBy?.kind, 'agent');
      assert.equal((r!.startedBy as { approved: boolean }).approved, true);
      await l.page.getByText(/asked, you approved/).first().waitFor();
      await l.page.getByText(/You approved it\./).waitFor();

      // The next turn opens with what happened. (In this mode the fake asks again; decline that one.)
      await send(l, 'How did it go?');
      await until(
        async () => (await items(l)).some((i) => i.kind === 'agent' && /^echo:Since your last turn:\n- The flow "Quick fix" you started finished\. Its result:\nReady on /.test(i.text)),
        20000,
        'the next turn to open with the news',
      );
      const again = l.page.getByRole('article', { name: /asks to run Quick fix/ });
      await again.getByRole('button', { name: 'Decline' }).click();
      await l.page.getByText(/You declined\./).waitFor();
    });
  });

  test('with "Agents too, without asking", the agent starts the flow itself', async () => {
    await withApp({ jevUrl, claudeMode: 'start-flow', env: { FAKE_FLOW: 'quick-fix' } }, async (l) => {
      await l.page.evaluate(async () => {
        const s = await window.api.getState();
        await window.api.saveSettings({ ...s.settings, invokeCeiling: 'agent' });
        const q = s.flows.find((f) => f.id === 'builtin-quick-fix')!;
        await window.api.saveFlow({ ...q, invoke: 'agent' });
      });
      await openSession(l);
      await send(l, 'Add multiply');
      await until(async () => (await runs(l)).length >= 1, 20000, 'the agent to start a run');
      assert.equal((await items(l)).some((i) => i.kind === 'flow-request'), false, 'nobody was asked');
      const [r] = await runs(l);
      assert.deepEqual(r!.startedBy, { kind: 'agent', model: 'Sonnet 5', approved: false });
      await l.page.getByText('Sonnet 5 started it').waitFor();
      await until(async () => settled((await runs(l))[0]), 60000, 'the run to end');
    });
  });

  test('with Settings at "Only you", a chat agent is not given start_flow, only Jev\'s web tools', async () => {
    await withApp({ jevUrl, claudeMode: 'start-flow' }, async (l) => {
      await l.page.evaluate(async () => {
        const s = await window.api.getState();
        await window.api.saveSettings({ ...s.settings, invokeCeiling: 'you' });
      });
      await openSession(l);
      await send(l, 'Add multiply');
      await l.page.getByText('start_flow said: start_flow is not listed; the tools are: jev_search, read_page.').waitFor({ timeout: 20000 });
      assert.deepEqual(await runs(l), []);
    });
  });

  test('a Run flow node runs Quick fix as a step, and the child run says who started it', async () => {
    await withApp({ jevUrl, claudeMode: 'work' }, async (l) => {
      await l.page.evaluate(async () => {
        await window.api.saveFlow({
          id: 'outer',
          name: 'Fix then report',
          description: 'Runs Quick fix, then reports.',
          updatedAt: '',
          nodes: [
            { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
            { id: 'fix', type: 'flow', position: { x: 260, y: 0 }, data: { label: 'Fix it', flowId: 'builtin-quick-fix', objective: 'Quickly: {{input}}' } },
            { id: 'end', type: 'end', position: { x: 520, y: 0 }, data: { label: 'Done', template: 'Report: {{input}}' } },
            { id: 'bad', type: 'end', position: { x: 520, y: 160 }, data: { label: 'Failed', template: 'It failed: {{input}}' } },
          ],
          edges: [
            { id: 'a', source: 'start', sourceHandle: 'out', target: 'fix' },
            { id: 'b', source: 'fix', sourceHandle: 'done', target: 'end' },
            { id: 'c', source: 'fix', sourceHandle: 'failed', target: 'bad' },
          ],
        });
      });
      await openSession(l);
      await send(l, 'Add multiply', 'Fix then report');
      await until(async () => {
        const rs = await runs(l);
        return rs.length === 2 && rs.every(settled);
      }, 90000, 'both runs to end');
      const [outer, inner] = await runs(l);
      assert.equal(outer!.flowName, 'Fix then report');
      assert.equal(inner!.flowName, 'Quick fix');
      assert.equal(inner!.objective, 'Quickly: Add multiply');
      assert.deepEqual(inner!.startedBy, { kind: 'flow', runId: outer!.id, flowName: 'Fix then report', node: 'Fix it' });
      assert.equal(inner!.parentRunId, outer!.id);
      assert.equal(outer!.status, 'succeeded', outer!.error);
      assert.match(outer!.result ?? '', /^Report: Ready on army\/run-/);
      await l.page.getByText('"Fix it" in Fix then report started it').waitFor();
      await shot(l.page, 'e2e-flow-runs-flow');
    });
  });
});

describe('the canvas', () => {
  test('a flow drawn on the canvas saves and runs from a session', async () => {
    await withApp({ jevUrl }, async (l) => {
      await openSession(l);
      await l.page.getByRole('button', { name: 'Flows', exact: true }).click();
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

describe('updates', () => {
  test('Settings shows the version and why updates are off; a downloaded update shows above Settings until closed', async () => {
    await withApp({ jevUrl }, async (l) => {
      await l.page.getByRole('button', { name: 'Settings' }).click();
      const status = l.page.getByRole('status', { name: 'Update status' });
      // A dev build and a hidden test run both keep the updater off, and say so.
      await status.getByText(/^Updates are off/).waitFor();
      assert.equal(await l.page.getByRole('button', { name: 'Check for updates' }).isDisabled(), true);
      const version = (await l.page.evaluate(() => window.api.updateStatus())).version;
      await l.page.getByText(version, { exact: true }).waitFor();

      // The window hears about a finished download the way the updater tells it.
      await l.app.evaluate(({ BrowserWindow }, v) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send('army:event', { type: 'update', update: { version: v, state: 'ready', next: '9.9.9' } });
      }, version);
      await status.getByText('Version 9.9.9 is downloaded. Restart to update.').waitFor();
      await l.page.getByRole('button', { name: 'Restart to update' }).waitFor();
      const notice = l.page.getByText('Version 9.9.9 is ready');
      await notice.waitFor();
      await l.page.locator('#settings-updates').scrollIntoViewIfNeeded();
      await shot(l.page, 'e2e-update-ready');
      await l.page.getByRole('button', { name: 'Hide until the next version' }).click();
      await notice.waitFor({ state: 'detached' });
    });
  });
});

describe('safe to hand over', () => {
  test('a key saved in Settings is encrypted on disk, survives a restart, and still works', async () => {
    const root = mkdtempSync(join(tmpdir(), 'army-e2e-'));
    const home = join(root, 'home');
    const settingsFile = join(home, 'settings.json');
    // The harness writes the key in the clear, the way older versions saved it.
    await withApp({ jevUrl, root }, async (l) => {
      await until(async () => !readFileSync(settingsFile, 'utf8').includes('fake-key'), 10000, 'the old plain key to be encrypted');
      assert.match(readFileSync(settingsFile, 'utf8'), /"apiKey": "encrypted:/);

      await l.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      const field = l.page.getByLabel('TypeSafe API key', { exact: true });
      assert.equal(await field.inputValue(), '', 'the window shows no key, only that one is saved');
      assert.match((await field.getAttribute('placeholder')) ?? '', /^Saved, and encrypted in your Keychain/);
      await field.fill('round-trip-key');
      await l.page.getByRole('button', { name: 'Save and test' }).click();
      await l.page.getByText(/^jev-fake answered in \d+ ms$/).waitFor();
      assert.equal(jev.calls.at(-1)?.auth, 'Bearer round-trip-key');
      const text = readFileSync(settingsFile, 'utf8');
      assert.doesNotMatch(text, /round-trip-key/);
      assert.match(text, /"apiKey": "encrypted:/);
      await shot(l.page, 'e2e-settings-key-saved');
    });

    await withApp({ jevUrl, root, home }, async (l) => {
      assert.equal(await l.page.evaluate(async () => (await window.api.getState()).settings.typesafe.apiKey), '(saved)');
      const r = await l.page.evaluate(() => window.api.testJev());
      assert.equal(r.ok, true, r.detail);
      assert.equal(jev.calls.at(-1)?.auth, 'Bearer round-trip-key');
      assert.doesNotMatch(readFileSync(settingsFile, 'utf8'), /round-trip-key/);

      // The report has what support needs and none of the keys.
      const report = await l.page.evaluate(() => window.api.diagnostics());
      assert.match(report, /^Agentic Army diagnostics$/m);
      assert.match(report, /^App: \S+/m);
      assert.match(report, /^macOS: \S+ on (arm64|x64)$/m);
      assert.match(report, /^TypeSafe key: set, and it works$/m);
      assert.match(report, /^Permissions: unguarded$/m);
      assert.match(report, /^Projects: 0, sessions: 0, runs: 0/m);
      assert.match(report, /INFO  Started\./);
      assert.match(report, /Moved the keys in settings\.json into encrypted storage/);
      assert.doesNotMatch(report, /round-trip-key|fake-key/);
      assert.ok(existsSync(join(home, 'logs', 'main.log')));
      assert.doesNotMatch(readFileSync(join(home, 'logs', 'main.log'), 'utf8'), /round-trip-key|fake-key/);
      await l.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await l.page.getByRole('button', { name: 'Copy diagnostics' }).waitFor();
      await l.page.getByRole('button', { name: 'Open logs folder' }).waitFor();
      await l.page.locator('#settings-permissions').scrollIntoViewIfNeeded();
      await shot(l.page, 'e2e-settings-permissions');
      await l.page.locator('#settings-diagnostics').scrollIntoViewIfNeeded();
      await shot(l.page, 'e2e-settings-diagnostics');
    });
  });

  test('a Git merge step shows what it would merge and waits; declining leaves the checkout alone', async () => {
    await withApp({ jevUrl, claudeMode: 'work' }, async (l) => {
      const project = await openSession(l);
      // Saved the way a flow from before the setting looks: the git node has no askBeforeMerge.
      await l.page.evaluate(() =>
        window.api.saveFlow({
          id: 'build-and-merge',
          name: 'Build and merge',
          description: 'An engineer builds it and the branch merges.',
          invoke: 'you',
          updatedAt: '',
          nodes: [
            { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
            { id: 'build', type: 'agent', position: { x: 200, y: 0 }, data: { label: 'Build', role: 'engineer', modelId: null, effort: null, prompt: '{{objective}}', workspace: 'run', keepContext: false, maxVisits: 2 } },
            { id: 'merge', type: 'git', position: { x: 400, y: 0 }, data: { label: 'Merge to main', action: 'merge', message: 'flow: {{objective}}' } },
            { id: 'end', type: 'end', position: { x: 600, y: 0 }, data: { label: 'Done', template: 'Merged.' } },
          ],
          edges: [
            { id: 'e1', source: 'start', sourceHandle: 'out', target: 'build' },
            { id: 'e2', source: 'build', sourceHandle: 'out', target: 'merge' },
            { id: 'e3', source: 'merge', sourceHandle: 'out', target: 'end' },
          ],
        }),
      );

      await send(l, 'Add multiply', 'Build and merge');
      const card = l.page.getByText(/^Merge army\/run-\w+ into main\?$/);
      await card.waitFor({ timeout: 30000 });
      const waiting = (await lastRun(l))!;
      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.pending[0]?.kind, 'merge');
      assert.match(waiting.pending[0]?.body ?? '', /Merging brings \d+ commits? from `army\/run-\w+` into `main`/);
      assert.match(waiting.pending[0]?.body ?? '', /engineer-work\.txt \| 2 \+\+/);
      assert.equal(existsSync(join(project, 'engineer-work.txt')), false, 'nothing merged while it waits');
      await shot(l.page, 'e2e-merge-asks');
      await l.page.getByRole('button', { name: 'Do not merge' }).click();
      await until(async () => (await lastRun(l))?.status === 'failed', 15000, 'the declined run to end');
      assert.match((await lastRun(l))!.nodes['merge']!.visits[0]!.output ?? '', /^You did not merge\. Your checkout is as it was/);
      assert.equal(existsSync(join(project, 'engineer-work.txt')), false);

      await send(l, 'Add multiply again', 'Build and merge');
      await until(async () => (await lastRun(l))?.id !== waiting.id && (await lastRun(l))?.pending[0]?.kind === 'merge', 30000, 'the second merge question');
      await l.page.getByRole('button', { name: 'Merge', exact: true }).click();
      await until(async () => (await lastRun(l))?.status === 'succeeded', 15000, 'the merge to finish');
      assert.equal(readFileSync(join(project, 'engineer-work.txt'), 'utf8'), 'engineer was here\nand edited it\n');
    });
  });
});
