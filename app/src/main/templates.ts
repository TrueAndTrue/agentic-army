/**
 * Flows that ship with the app. Each is an ordinary flow: open it on the canvas, change it, and
 * the change saves as your own copy.
 */

import { defaultNodeData } from '../shared/flow.ts';
import type { Flow, FlowEdge, FlowNode, NodeConfigs, NodeType } from '../shared/types.ts';

function n<T extends NodeType>(id: string, type: T, x: number, y: number, data: Partial<NodeConfigs[T]>): FlowNode {
  return { id, type, position: { x, y }, data: { ...(defaultNodeData(type) as NodeConfigs[T]), ...data } } as FlowNode;
}

function e(source: string, sourceHandle: string, target: string): FlowEdge {
  return { id: `e_${source}_${sourceHandle}_${target}`, source, sourceHandle, target };
}

const X = 260;
const ROW = 250;

const mainFlow: Flow = {
  id: 'builtin-main-flow',
  invoke: 'agent-ask',
  name: 'Build and review',
  description:
    'A change that needs planning, building and independent review. A scout reads the code, a planner writes the plan you approve, an engineer builds it on its own branch, a reviewer on a different model checks it, and Jev sends it back to the engineer until the review passes.',
  builtin: true,
  updatedAt: '2026-09-24T00:00:00.000Z',
  nodes: [
    n('start', 'start', 0, 0, { label: 'Start' }),
    n('scout', 'agent', X, 0, {
      label: 'Scout',
      role: 'scout',
      workspace: 'project',
      prompt:
        'Find out what someone would need to know before doing this:\n\n{{objective}}\n\nReport the relevant files, how the code is organised there, how tests are run, and anything that could get in the way. Facts with paths, no plan.',
    }),
    n('plan', 'agent', X * 2, 0, {
      label: 'Plan',
      role: 'planner',
      workspace: 'project',
      prompt:
        'Objective: {{objective}}\n\nWhat the scout found:\n{{nodes.scout}}\n\n{{input}}\n\nWrite the plan an engineer will follow: the files to change, the behaviour to add, the tests that prove it, and the command that runs them. Keep it short enough to read in a minute.',
    }),
    n('approve_plan', 'human', X * 3, 0, {
      label: 'Approve plan',
      prompt: 'Approve this plan, or reject it with a note saying what to change.\n\n{{input}}',
    }),
    n('build', 'agent', X, ROW, {
      label: 'Build',
      role: 'engineer',
      workspace: 'run',
      keepContext: true,
      maxVisits: 4,
      prompt:
        'Objective: {{objective}}\n\nThe approved plan:\n{{nodes.plan}}\n\nThis is attempt {{visit}}. If a reviewer or the person signing off has already looked, what they said follows; fix every point.\n\n{{nodes.review}}\n\n{{nodes.sign_off}}\n\nMake the change, add the tests, run them, and end with what you changed and the test result.',
    }),
    n('review', 'agent', X * 2, ROW, {
      label: 'Review',
      role: 'reviewer',
      workspace: 'run',
      maxVisits: 4,
      prompt:
        'Objective: {{objective}}\n\nPlan the engineer followed:\n{{nodes.plan}}\n\nThe engineer reports:\n{{input}}\n\nReview the change in this working tree (git diff against the branch point shows it). Run the tests. List every problem with file and line. End with one line: APPROVED or CHANGES NEEDED.',
    }),
    n('passed', 'decide', X * 3, ROW, {
      label: 'Review passed',
      mode: 'yesno',
      question: 'Does this review approve the change, with no remaining problems that must be fixed?',
      state: '{{input}}',
      threshold: 0.6,
      maxVisits: 4,
    }),
    n('validate', 'agent', X * 2, ROW * 2, {
      label: 'Validate',
      role: 'validator',
      workspace: 'run',
      prompt:
        'The original objective:\n{{objective}}\n\nRun the checks in this working tree and judge the result against the objective, not against the plan. Say what works, what is missing, and whether you would ship it.',
    }),
    n('sign_off', 'human', X * 3, ROW * 2, {
      label: 'Sign off',
      prompt: 'The work is reviewed and validated. Approve to finish; the branch is ready to merge from the run panel.\n\n{{input}}',
    }),
    n('end', 'end', X * 4, ROW * 2, {
      label: 'Done',
      template: 'Finished on branch {{branch}}.\n\nValidation:\n{{nodes.validate}}',
    }),
  ],
  edges: [
    e('start', 'out', 'scout'),
    e('scout', 'out', 'plan'),
    e('plan', 'out', 'approve_plan'),
    e('approve_plan', 'approve', 'build'),
    e('approve_plan', 'reject', 'plan'),
    e('build', 'out', 'review'),
    e('review', 'out', 'passed'),
    e('passed', 'yes', 'validate'),
    e('passed', 'no', 'build'),
    e('validate', 'out', 'sign_off'),
    e('sign_off', 'approve', 'end'),
    e('sign_off', 'reject', 'build'),
  ],
};

const quickFix: Flow = {
  id: 'builtin-quick-fix',
  invoke: 'agent-ask',
  name: 'Quick fix',
  description: 'A small, clear change. An engineer makes it on a branch, a reviewer checks it, and Jev loops it back until the review passes. No planning step.',
  builtin: true,
  updatedAt: '2026-09-24T00:00:00.000Z',
  nodes: [
    n('start', 'start', 0, 100, { label: 'Start' }),
    n('build', 'agent', X, 100, {
      label: 'Build',
      role: 'engineer',
      workspace: 'run',
      keepContext: true,
      maxVisits: 3,
      prompt: 'Do this: {{objective}}\n\nAttempt {{visit}}. Reviewer findings to fix, if any:\n{{nodes.review}}\n\nRun the tests and end with what you changed and the result.',
    }),
    n('review', 'agent', X * 2, 100, {
      label: 'Review',
      role: 'reviewer',
      workspace: 'run',
      maxVisits: 3,
      prompt: 'The task was: {{objective}}\n\nThe engineer reports:\n{{input}}\n\nCheck the change and run the tests. List every problem. End with APPROVED or CHANGES NEEDED.',
    }),
    n('passed', 'decide', X * 3, 100, {
      label: 'Review passed',
      mode: 'yesno',
      question: 'Does this review approve the change, with no remaining problems that must be fixed?',
      state: '{{input}}',
      threshold: 0.6,
      maxVisits: 3,
    }),
    // The engineer's summary says what changed and how the tests went; the review only says it passed.
    n('end', 'end', X * 4, 40, { label: 'Done', template: 'Ready on {{branch}}. The review passed.\n\n{{nodes.build}}' }),
  ],
  edges: [e('start', 'out', 'build'), e('build', 'out', 'review'), e('review', 'out', 'passed'), e('passed', 'yes', 'end'), e('passed', 'no', 'build')],
};

const webResearch: Flow = {
  id: 'builtin-web-research',
  invoke: 'agent',
  name: 'Look it up on the web',
  description: 'A question answered from a live web page. A browser driven by Jev searches and reads, a guard stops risky clicks, and a scout writes the answer from what the browser found.',
  builtin: true,
  updatedAt: '2026-09-24T00:00:00.000Z',
  nodes: [
    n('start', 'start', 0, 100, { label: 'Start' }),
    // Start on the results page: typing into a search box is the step the browser got stuck on.
    n('browse', 'browser', X, 100, { label: 'Browse', goal: 'Open the page that best answers this, not a search results page: {{objective}}', startUrl: 'https://duckduckgo.com/html/?q={{objective}}', maxSteps: 8 }),
    n('answer', 'agent', X * 2, 40, {
      label: 'Answer',
      role: 'scout',
      workspace: 'project',
      prompt: 'Answer this from the page a browser found. Quote what you rely on, and say if the page does not answer it.\n\nQuestion: {{objective}}\n\n{{input}}',
    }),
    n('end', 'end', X * 3, 40, { label: 'Done', template: '{{input}}' }),
    n('gave_up', 'end', X * 2, 200, { label: 'Not found', outcome: 'failure', template: 'The browser could not find an answer.\n\n{{input}}' }),
  ],
  edges: [e('start', 'out', 'browse'), e('browse', 'done', 'answer'), e('browse', 'failed', 'gave_up'), e('answer', 'out', 'end')],
};

const triage: Flow = {
  id: 'builtin-triage',
  invoke: 'auto',
  name: 'Triage with Jev',
  description: 'Jev reads the request and sends it down the right path: a bug goes to a fix-and-test loop, a feature gets a plan for you to approve, and a question gets an answer.',
  builtin: true,
  updatedAt: '2026-09-24T00:00:00.000Z',
  nodes: [
    n('start', 'start', 0, 200, { label: 'Start' }),
    n('route', 'decide', X, 200, {
      label: 'What is it',
      mode: 'choice',
      question: 'What kind of request is this?',
      state: '{{objective}}',
      options: [
        { key: 'bug', description: 'Something that used to work, or should work, is broken' },
        { key: 'feature', description: 'A request for new behaviour or a change in behaviour' },
        { key: 'question', description: 'A question about the code that needs an answer, not a change' },
      ],
      minConfidence: 0.5,
    }),
    n('fix', 'agent', X * 2, 40, {
      label: 'Fix',
      role: 'engineer',
      workspace: 'run',
      keepContext: true,
      maxVisits: 3,
      prompt:
        'Fix this bug: {{objective}}\n\nAttempt {{visit}}. Write a failing test first, then make it pass. End with the cause and the test result.\n\nThe test run after your last attempt, if there was one:\n{{nodes.tests}}',
    }),
    n('tests', 'shell', X * 3, 40, { label: 'Tests', command: 'npm test --silent', workspace: 'run', timeoutSec: 600, maxVisits: 3 }),
    n('design', 'agent', X * 2, 200, {
      label: 'Design',
      role: 'planner',
      workspace: 'project',
      prompt: 'Design this feature for this codebase: {{objective}}\n\nName the files, the behaviour and the tests. Short.',
    }),
    n('approve', 'human', X * 3, 200, { label: 'Approve design', prompt: '{{input}}' }),
    n('answer', 'agent', X * 2, 360, {
      label: 'Answer',
      role: 'scout',
      workspace: 'project',
      prompt: 'Answer this question about the code, with file paths: {{objective}}',
    }),
    n('ask_me', 'human', X * 2, 500, { label: 'Ask me', prompt: 'Jev was not sure what kind of request this is. Approve to treat it as a feature, reject to stop.\n\n{{objective}}' }),
    n('end', 'end', X * 4, 200, { label: 'Done', template: '{{input}}' }),
    n('fixed', 'end', X * 4, 40, { label: 'Fixed', template: 'Fixed on {{branch}}, and the tests pass.\n\n{{nodes.fix}}' }),
    n('designed', 'end', X * 4, 280, { label: 'Design approved', template: '{{nodes.design}}' }),
    n('declined', 'end', X * 3, 500, { label: 'Stopped', outcome: 'stopped', template: 'You stopped it here.' }),
  ],
  edges: [
    e('start', 'out', 'route'),
    e('route', 'bug', 'fix'),
    e('route', 'feature', 'design'),
    e('route', 'question', 'answer'),
    e('route', 'unsure', 'ask_me'),
    e('ask_me', 'approve', 'design'),
    e('fix', 'out', 'tests'),
    // The fix-and-test loop the description promises: failing tests go back to Fix, three times at most.
    e('tests', 'pass', 'fixed'),
    e('tests', 'fail', 'fix'),
    e('design', 'out', 'approve'),
    e('approve', 'approve', 'designed'),
    e('approve', 'reject', 'declined'),
    e('ask_me', 'reject', 'declined'),
    e('answer', 'out', 'end'),
  ],
};

export const BUILTIN_FLOWS: Flow[] = [mainFlow, quickFix, webResearch, triage];
