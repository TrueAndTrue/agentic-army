import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DRAFTER_INSTRUCTIONS, draft, draftPrompt, lastJsonObject, layoutFlow, parseReply, specToFlow, type Ask } from '../src/main/drafter.ts';
import { MAX_DRAFT_QUESTIONS, type DraftRequest } from '../src/shared/draft.ts';
import { defaultNodeData, validateFlow } from '../src/shared/flow.ts';
import type { FlowNode } from '../src/shared/types.ts';

const QUESTION = {
  kind: 'question',
  question: 'What should happen when the tests fail?',
  why: 'This decides whether the flow loops.',
  options: [{ label: 'Try again', detail: 'Up to three times' }, { label: 'Stop' }],
  multi: false,
  understanding: 'You want a bug fixed with tests.',
};

/** A small flow that passes the checks: Start, an engineer, the tests, and two ends. */
const GOOD = {
  kind: 'flow',
  name: 'Fix with tests',
  description: 'A bug fixed on a branch with the tests run.',
  summary: 'An engineer fixes it and the tests run.',
  nodes: [
    { id: 'start', type: 'start', label: 'Start' },
    { id: 'fix', type: 'agent', label: 'Fix', role: 'engineer', prompt: 'Fix {{objective}}\n\n{{nodes.tests}}', keepContext: true },
    { id: 'tests', type: 'shell', label: 'Tests', command: 'npm test', maxVisits: 3 },
    { id: 'done', type: 'end', label: 'Done', template: '{{nodes.fix}}' },
  ],
  edges: [
    ['start', 'out', 'fix'],
    ['fix', 'out', 'tests'],
    ['tests', 'pass', 'done'],
    ['tests', 'fail', 'fix'],
  ],
};

const signal = new AbortController().signal;

/** An `ask` that answers from a list, and keeps every prompt it got. */
function scripted(...replies: string[]): Ask & { prompts: string[]; instructions: string[] } {
  const prompts: string[] = [];
  const instructions: string[] = [];
  const fn: Ask = async (prompt, inst) => {
    prompts.push(prompt);
    instructions.push(inst);
    const next = replies.shift();
    if (next === undefined) throw new Error('asked once too often');
    return next;
  };
  return Object.assign(fn, { prompts, instructions });
}

const req = (answers = 0, finish = false): DraftRequest => ({
  objective: 'Fix the login bug',
  answers: Array.from({ length: answers }, (_, i) => ({ question: `Question ${String(i + 1)}?`, answer: `Answer ${String(i + 1)}` })),
  ...(finish ? { finish } : {}),
});

describe('reading the reply', () => {
  test('finds the object in a code fence with prose around it', () => {
    const text = `Here is my question.\n\n\`\`\`json\n${JSON.stringify(QUESTION, null, 2)}\n\`\`\`\n\nLet me know.`;
    const r = parseReply(text);
    assert.equal(r.kind, 'question');
    assert.equal(r.kind === 'question' && r.question, QUESTION.question);
    assert.deepEqual(r.kind === 'question' && r.options, QUESTION.options);
  });

  test('takes the last object, not one nested inside it or one said earlier', () => {
    const text = `First I thought {"kind":"question"} but then:\n${JSON.stringify(GOOD)}\nThat's it, the "fix" node loops.`;
    const obj = lastJsonObject(text) as { name?: string };
    assert.equal(obj.name, 'Fix with tests');
  });

  test('braces inside strings do not confuse it', () => {
    const obj = lastJsonObject('Sure. {"a": "{{input}} and }{ odd", "b": {"c": 1}}') as { a: string };
    assert.equal(obj.a, '{{input}} and }{ odd');
  });

  test('options that repeat the window\'s own "You pick" and free text are dropped', () => {
    const r = parseReply(JSON.stringify({ ...QUESTION, options: [{ label: 'npm test' }, { label: 'You pick', detail: 'I will choose' }, { label: 'Other' }] }));
    assert.deepEqual(r.kind === 'question' && r.options, [{ label: 'npm test' }]);
  });

  test('bad JSON is a reply it cannot use, with a reason', () => {
    const r = parseReply('{"kind": "question", "question": "Which?", options: [}');
    assert.equal(r.kind, 'bad');
    assert.equal(parseReply('No JSON here at all.').kind, 'bad');
    assert.equal(parseReply('{"kind":"question","question":"Which?","options":["only one"]}').kind, 'bad');
  });
});

describe('from the spec to a flow', () => {
  test('fills defaults, drops unknown fields, and falls back on wrong types', () => {
    const { flow, dropped } = specToFlow({
      name: 'X',
      nodes: [
        { id: 's', type: 'start' },
        { id: 'a', type: 'agent', label: 'Build', role: 'wizard', maxVisits: 'many', prompt: 'Go', colour: 'red', modelId: 'not-a-model', effort: 'max' },
        { id: 'e', type: 'end' },
      ],
      edges: [['s', 'out', 'a'], ['a', 'out', 'e']],
    });
    assert.deepEqual(dropped, []);
    const agent = flow.nodes.find((n) => n.type === 'agent') as Extract<FlowNode, { type: 'agent' }>;
    const def = defaultNodeData('agent') as Extract<FlowNode, { type: 'agent' }>['data'];
    assert.equal(agent.data.role, def.role, 'an unknown role falls back');
    assert.equal(agent.data.maxVisits, def.maxVisits, 'a string where a number goes falls back');
    assert.equal(agent.data.prompt, 'Go');
    assert.equal(agent.data.modelId, null, 'a model that is not in Settings becomes the stage default');
    assert.equal(agent.data.effort, 'max');
    assert.equal('colour' in agent.data, false);
    assert.equal(flow.nodes.find((n) => n.type === 'end')!.data.label, 'End');
    assert.notEqual(agent.id, 'a', 'nodes get fresh ids');
    assert.equal(validateFlow(flow).filter((p) => p.level === 'error').length, 0);
  });

  test('drops a connection from a handle the node does not have, and says so', () => {
    const { flow, dropped } = specToFlow({
      nodes: [
        { id: 's', type: 'start' },
        { id: 't', type: 'shell', label: 'Tests', command: 'npm test' },
        { id: 'e', type: 'end' },
      ],
      edges: [['s', 'out', 't'], ['t', 'yes', 'e'], ['t', 'pass', 'e'], ['t', 'pass', 'e'], ['t', 'fail', 'ghost']],
    });
    assert.equal(flow.edges.length, 2, 'the bad handle, the duplicate and the missing node are gone');
    assert.equal(dropped.length, 2);
    assert.match(dropped[0]!, /"Tests" has no "yes" output.*Its outputs are: pass, fail/);
    assert.match(dropped[1]!, /not in the flow/);
  });

  test('makes labels unique the way templates name nodes', () => {
    const { flow } = specToFlow({
      nodes: [
        { id: 's', type: 'start' },
        { id: 'a', type: 'agent', label: 'Review', prompt: 'x' },
        { id: 'b', type: 'agent', label: 'review!', prompt: 'x' },
        { id: 'c', type: 'agent', label: '???', prompt: 'x' },
      ],
      edges: [],
    });
    const labels = flow.nodes.map((n) => n.data.label);
    assert.deepEqual(labels, ['Start', 'Review', 'review! 2', 'Agent']);
  });

  test('an End nothing connects into is left out, since it could never run', () => {
    const { flow } = specToFlow({ ...GOOD, nodes: [...GOOD.nodes, { id: 'gave_up', type: 'end', label: 'Tests never passed', outcome: 'failure' }] });
    assert.deepEqual(flow.nodes.map((n) => n.data.label), ['Start', 'Fix', 'Tests', 'Done']);
    assert.deepEqual(validateFlow(flow), []);
  });

  test("a template that names a node by the spec's id is pointed at its label", () => {
    const { flow } = specToFlow({
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'update', type: 'agent', label: 'Update deps', prompt: 'Update. Last test run:\n{{nodes.tests}}' },
        { id: 'tests', type: 'shell', label: 'Run tests', command: 'npm test' },
        { id: 'end', type: 'end', template: '{{ nodes.update }} and {{nodes.run_tests}} and {{nodes.nobody}}' },
      ],
      edges: [['start', 'out', 'update'], ['update', 'out', 'tests'], ['tests', 'pass', 'end'], ['tests', 'fail', 'update']],
    });
    const data = (label: string) => flow.nodes.find((n) => n.data.label === label)!.data as { prompt?: string; template?: string };
    assert.equal(data('Update deps').prompt, 'Update. Last test run:\n{{nodes.run_tests}}');
    assert.equal(data('End').template, '{{nodes.update_deps}} and {{nodes.run_tests}} and {{nodes.nobody}}');
    assert.deepEqual(
      validateFlow(flow).map((p) => p.message),
      ['"End" uses {{nodes.nobody}}, which nothing provides.'],
    );
  });

  test('lays out left to right from Start, with branches stacked and nothing overlapping', () => {
    const { flow } = specToFlow({ ...GOOD, nodes: [...GOOD.nodes, { id: 'lint', type: 'shell', label: 'Lint', command: 'npm run lint' }] });
    const at = (label: string) => flow.nodes.find((n) => n.data.label === label)!.position;
    const xs = flow.nodes.map((n) => n.position.x);
    assert.equal(at('Start').x, Math.min(...xs), 'Start is leftmost');
    assert.ok(at('Fix').x > at('Start').x);
    assert.ok(at('Tests').x > at('Fix').x);
    assert.ok(at('Done').x > at('Tests').x, 'a later layer sits to the right');
    assert.equal(at('Fix').y, at('Start').y, 'the main path is a straight line');
    assert.equal(at('Lint').x, Math.max(...xs), 'a node Start never reaches goes past the rest');
    // Two nodes in one column never sit on top of each other.
    for (const a of flow.nodes) for (const b of flow.nodes) {
      if (a !== b && a.position.x === b.position.x) assert.ok(Math.abs(a.position.y - b.position.y) >= 100, `${a.data.label} and ${b.data.label} overlap`);
    }
  });

  test('a branch puts its first output level with it and the next below', () => {
    const { flow } = specToFlow({
      nodes: [
        { id: 's', type: 'start' },
        { id: 'd', type: 'decide', label: 'Route', question: 'Is it a bug?' },
        { id: 'y', type: 'end', label: 'Bug' },
        { id: 'n', type: 'end', label: 'Not a bug' },
      ],
      edges: [['s', 'out', 'd'], ['d', 'no', 'n'], ['d', 'yes', 'y']],
    });
    const at = (label: string) => flow.nodes.find((n) => n.data.label === label)!.position;
    assert.equal(at('Bug').y, at('Route').y);
    assert.ok(at('Not a bug').y > at('Bug').y);
    assert.equal(at('Bug').x, at('Not a bug').x);
    layoutFlow(flow);
    assert.equal(at('Bug').y, at('Route').y, 'laying out again changes nothing');
  });
});

describe('the conversation', () => {
  test('the prompt carries the objective and every answer, and asks for the next question', () => {
    const p = draftPrompt({ objective: 'Fix the login bug', answers: [{ question: 'Who reviews?', answer: 'Another model' }] });
    assert.match(p, /Fix the login bug/);
    assert.match(p, /1\. Q: Who reviews\?\n {3}A: Another model/);
    assert.match(p, /Ask your next question/);
    assert.match(DRAFTER_INSTRUCTIONS, /^You draft flows for Agentic Army/);
  });

  test('a question comes back as it is', async () => {
    const ask = scripted(`Thinking.\n${JSON.stringify(QUESTION)}`);
    const r = await draft(req(1), ask, { signal });
    assert.equal(r.kind, 'question');
    assert.equal(ask.prompts.length, 1);
    assert.match(ask.prompts[0]!, /Q: Question 1\?\n {3}A: Answer 1/);
    assert.equal(ask.instructions[0], DRAFTER_INSTRUCTIONS);
  });

  test('a flow with errors goes back with the problems, and the fixed one comes out', async () => {
    const broken = { ...GOOD, nodes: GOOD.nodes.map((n) => (n.id === 'tests' ? { ...n, command: '' } : n)), edges: [...GOOD.edges, ['tests', 'maybe', 'done']] };
    const ask = scripted(JSON.stringify(broken), JSON.stringify(GOOD));
    const r = await draft(req(3), ask, { signal });
    assert.equal(r.kind, 'flow');
    assert.equal(ask.prompts.length, 2);
    assert.match(ask.prompts[1]!, /"Tests" has no command/);
    assert.match(ask.prompts[1]!, /"Tests" has no "maybe" output/);
    assert.match(ask.prompts[1]!, /Fix them and reply with the whole corrected flow/);
    if (r.kind === 'flow') {
      assert.equal(r.flow.name, 'Fix with tests');
      assert.equal(r.summary, GOOD.summary);
      assert.equal(r.problems.filter((p) => p.level === 'error').length, 0);
    }
  });

  test('a warning, like an End nothing leads to, also goes back once', async () => {
    const stray = { ...GOOD, nodes: [...GOOD.nodes, { id: 'lost', type: 'shell', label: 'Never reached', command: 'true' }] };
    const ask = scripted(JSON.stringify(stray), JSON.stringify(GOOD));
    const r = await draft(req(3), ask, { signal });
    assert.equal(ask.prompts.length, 2);
    assert.match(ask.prompts[1]!, /"Never reached" is not connected to Start/);
    assert.ok(r.kind === 'flow' && !r.flow.nodes.some((n) => n.data.label === 'Never reached'));
  });

  test('after two repairs it returns the draft with its problems instead of asking forever', async () => {
    const noStart = { ...GOOD, nodes: GOOD.nodes.filter((n) => n.type !== 'start') };
    const ask = scripted(JSON.stringify(noStart), JSON.stringify(noStart), JSON.stringify(noStart));
    const r = await draft(req(3), ask, { signal });
    assert.equal(ask.prompts.length, 3);
    assert.equal(r.kind, 'flow');
    assert.ok(r.kind === 'flow' && r.problems.some((p) => p.message === 'A flow needs a Start node.'));
  });

  test('a reply it cannot read gets another try, then an error in plain words', async () => {
    const ask = scripted('Hmm.', 'Still thinking.', 'I am not sure.');
    const r = await draft(req(), ask, { signal });
    assert.equal(r.kind, 'error');
    assert.match(ask.prompts[1]!, /did not end with a JSON object/);
  });

  test(`after ${String(MAX_DRAFT_QUESTIONS)} answers, or on Build it now, the model must write the flow`, async () => {
    assert.match(draftPrompt(req(MAX_DRAFT_QUESTIONS)), /Draft the flow now\. Do not ask another question\./);
    assert.match(draftPrompt(req(2, true)), /pressed "Build it now"/);
    assert.doesNotMatch(draftPrompt(req(2)), /Draft the flow now/);
    // A question when the flow is due is sent back, not shown.
    const ask = scripted(JSON.stringify(QUESTION), JSON.stringify(GOOD));
    const r = await draft(req(MAX_DRAFT_QUESTIONS), ask, { signal });
    assert.equal(r.kind, 'flow');
    assert.match(ask.prompts[1]!, /You asked another question, but the flow is due now/);
  });

  test('a model in Settings is kept when the person asked for it', async () => {
    const spec = { ...GOOD, nodes: GOOD.nodes.map((n) => (n.id === 'fix' ? { ...n, modelId: 'opus' } : n)) };
    const ask = scripted(JSON.stringify(spec));
    const r = await draft(req(2), ask, { signal, context: { models: [{ id: 'opus', label: 'Claude Opus' }], flows: [] } });
    assert.match(ask.prompts[0]!, /- opus: Claude Opus/);
    const fix = r.kind === 'flow' ? r.flow.nodes.find((n) => n.data.label === 'Fix') : undefined;
    assert.equal(fix?.type === 'agent' && fix.data.modelId, 'opus');
  });
});
