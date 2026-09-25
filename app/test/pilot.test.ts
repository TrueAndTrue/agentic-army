import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { candidatesFor, phrasesFrom, pilot, type Action, type Ask, type Page, type PageSnapshot } from '../src/main/browser/pilot.ts';
import { decideQuestion, judge, judgmentFrom, type JevResponse } from '../src/main/jev.ts';
import { defaultNodeData } from '../src/shared/flow.ts';
import type { BrowserStep, DecideConfig } from '../src/shared/types.ts';

describe('what the pilot may type', () => {
  test('quoted phrases and what follows "search for" come from the goal, nothing else', () => {
    assert.deepEqual(phrasesFrom('Search for "react flow" and open the docs'), ['react flow']);
    assert.deepEqual(phrasesFrom('search for electron releases, then report the latest'), ['electron releases']);
    assert.deepEqual(phrasesFrom('weather in Oslo'), ['weather in Oslo']);
  });

  test('a text box is offered once per phrase; buttons, links, scroll and stop are always there', () => {
    const snap: PageSnapshot = {
      url: 'https://x',
      title: 'x',
      text: '',
      canGoBack: false,
      elements: [
        { id: 'e0', tag: 'input', kind: 'input', text: '', inputType: 'search', name: 'q', inViewport: true },
        { id: 'e1', tag: 'button', kind: 'button', text: 'Search', inViewport: true },
        { id: 'e2', tag: 'input', kind: 'input', text: 'Go', inputType: 'submit', inViewport: true },
      ],
    };
    const keys = candidatesFor(snap, 'search for "a" or "b"').map((c) => c.key);
    assert.deepEqual(keys, ['type_e0_0', 'type_e0_1', 'click_e1', 'click_e2', 'scroll', 'done', 'fail']);
  });
});

/** A two-page site: a search box, then results with a buy button. */
function fakeSite() {
  let page: 'home' | 'results' = 'home';
  const performed: Action[] = [];
  const p: Page = {
    async open() {
      page = 'home';
    },
    async snapshot() {
      return page === 'home'
        ? { url: 'https://shop/', title: 'Shop', text: 'Welcome', canGoBack: false, elements: [{ id: 'e0', tag: 'input', kind: 'input', text: '', inputType: 'text', inViewport: true }] }
        : {
            url: 'https://shop/s?q=kettle',
            title: 'Results',
            text: 'Kettle £20',
            canGoBack: true,
            elements: [{ id: 'e0', tag: 'button', kind: 'button', text: 'Buy now', inViewport: true }],
          };
    },
    async perform(a) {
      performed.push(a);
      if (a.kind === 'type') page = 'results';
    },
  };
  return { page: p, performed };
}

function scriptedJev(script: { next: string; achieved?: number; risky?: number }[]): Ask {
  let i = 0;
  return async (_state, questions): Promise<JevResponse> => {
    if ('risky' in questions) return { model: 'jev', inputTokens: 0, latencyMs: 1, answers: { risky: { type: 'noul', noul: script[i - 1]?.risky ?? 0 } } };
    const s = script[i++] ?? { next: 'fail' };
    return {
      model: 'jev',
      inputTokens: 0,
      latencyMs: 1,
      answers: { next: { type: 'choice', choice: s.next, confidence: 0.9 }, achieved: { type: 'noul', noul: s.achieved ?? 0 } },
    };
  };
}

describe('the pilot', () => {
  test('types the phrase from the goal, then stops when Jev says the goal is met', async () => {
    const site = fakeSite();
    const steps: BrowserStep[] = [];
    const res = await pilot({
      goal: 'search for "kettle" and find the price',
      startUrl: 'https://shop/',
      maxSteps: 5,
      guard: true,
      guardThreshold: 0.5,
      page: site.page,
      ask: scriptedJev([{ next: 'type_e0_0', risky: 0.05 }, { next: 'done', achieved: 0.9 }]),
      signal: new AbortController().signal,
      onStep: (s) => steps.push(s),
      confirm: async () => assert.fail('a safe step must not ask'),
    });
    assert.equal(res.ok, true);
    assert.deepEqual(site.performed, [{ kind: 'type', elementId: 'e0', text: 'kettle', submit: true }]);
    assert.deepEqual(steps.map((s) => s.outcome), ['ran', 'done']);
    assert.match(res.output, /Kettle £20/);
  });

  test('a risky click pauses for you, and a refusal stops the pilot without clicking', async () => {
    const site = fakeSite();
    let asked = '';
    const res = await pilot({
      goal: 'search for "kettle"',
      startUrl: 'https://shop/',
      maxSteps: 5,
      guard: true,
      guardThreshold: 0.5,
      page: site.page,
      ask: scriptedJev([{ next: 'type_e0_0', risky: 0 }, { next: 'click_e0', risky: 0.93 }]),
      signal: new AbortController().signal,
      onStep: () => {},
      confirm: async (_t, body) => {
        asked = body;
        return false;
      },
    });
    assert.equal(res.ok, false);
    assert.match(asked, /Click button "Buy now"/);
    assert.match(asked, /93%/);
    assert.equal(site.performed.length, 1, 'the buy click never ran');
  });

  test('with the guard off, the same click runs without asking', async () => {
    const site = fakeSite();
    await pilot({
      goal: 'search for "kettle"',
      startUrl: 'https://shop/',
      maxSteps: 2,
      guard: false,
      guardThreshold: 0.5,
      page: site.page,
      ask: scriptedJev([{ next: 'type_e0_0' }, { next: 'click_e0' }]),
      signal: new AbortController().signal,
      onStep: () => {},
      confirm: async () => assert.fail('guard is off'),
    });
    assert.deepEqual(site.performed.at(-1), { kind: 'click', elementId: 'e0' });
  });
});

describe('Jev decisions', () => {
  const base = defaultNodeData('decide') as DecideConfig;

  test('yes/no uses the threshold; choice sends option descriptions as criteria', () => {
    const j = judgmentFrom({ ...base, mode: 'yesno', threshold: 0.7 }, { type: 'noul', noul: 0.65 }, { model: 'm', latencyMs: 1 });
    assert.equal(j.answer, 'no');
    const q = decideQuestion({ ...base, mode: 'choice', options: [{ key: 'bug', description: 'Something broke' }, { key: 'x', description: '' }] }, 'What is it?');
    assert.deepEqual(q, { type: 'choice', instructions: 'What is it?', criteria: { bug: 'Something broke', x: null } });
  });

  test('score levels count from zero, and the cut decides high or low', () => {
    const cfg = { ...base, mode: 'score' as const, levels: ['None', 'Some', 'Strong'], cut: 2 };
    assert.equal(judgmentFrom(cfg, { type: 'score', score: 1.4, confidence: 0.6 }, { model: 'm', latencyMs: 1 }).answer, 'low');
    assert.equal(judgmentFrom(cfg, { type: 'score', score: 2, confidence: 0.6 }, { model: 'm', latencyMs: 1 }).answer, 'high');
  });

  test('a missing key fails with a message that says where to fix it', async () => {
    await assert.rejects(judge({ apiKey: '', model: 'jev-latest', baseUrl: 'https://x' }, base, 'q', 's'), /no TypeSafe API key yet/);
  });

  test('a 401 names the key as the likely cause', async () => {
    const fake = (async () => new Response('bad key', { status: 401 })) as typeof fetch;
    await assert.rejects(judge({ apiKey: 'k', model: 'jev-latest', baseUrl: 'https://x' }, base, 'q', 's', undefined, fake), /refused the API key/);
  });
});

describe('what an agent is allowed to touch', async () => {
  const { runAgent } = await import('../src/main/agents.ts');
  const { DEFAULT_SETTINGS } = await import('../src/main/store.ts');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');

  test('a project under your home directory is not denied, and the army home is', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const armyHome = mkdtempSync(join(tmpdir(), 'army-home-'));
    process.env['AGENTIC_ARMY_HOME'] = armyHome;
    let spec: { allow: string[]; deny: string[] } | null = null;
    await runAgent({
      harness: 'claude',
      model: 'm',
      effort: 'low',
      role: 'engineer',
      cwd: join(homedir(), 'code', 'app'),
      prompt: 'x',
      label: 'probe',
      brief: false,
      settings: DEFAULT_SETTINGS,
      signal: new AbortController().signal,
      onTurn: () => {},
      adapter: {
        id: 'claude',
        supportsDuplex: true,
        async spawn(s) {
          spec = s;
          throw new Error('stop here');
        },
      },
    }).catch((err: Error) => assert.equal(err.message, 'stop here'));
    assert.ok(spec !== null);
    const deny = (spec as { deny: string[] }).deny;
    assert.equal(deny.includes(`Read(${homedir()}/**)`), false, 'the whole home directory is denied');
    assert.equal(deny.includes(`Write(${homedir()}/**)`), false);
    assert.ok(deny.some((d) => d.startsWith(`Write(${armyHome}`)), 'the army home is protected');
    delete process.env['AGENTIC_ARMY_HOME'];
  });
});
