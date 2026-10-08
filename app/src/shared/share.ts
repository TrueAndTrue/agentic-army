/**
 * What a flow can do on your Mac, listed before you add one somebody sent you. A flow is a
 * program: its commands run in your shell and its engineers edit your files, so an import shows
 * every one of those first.
 */

import type { Flow } from './types.ts';

export interface FlowPower {
  /** `high` touches your files, your shell or your checkout. `note` is worth knowing, nothing more. */
  level: 'high' | 'note';
  /** The step's name. */
  node: string;
  text: string;
  /** The exact command or address, shown as code. */
  code?: string;
}

export function flowPowers(flow: Flow, knownFlowIds?: ReadonlySet<string>): FlowPower[] {
  const out: FlowPower[] = [];
  for (const n of flow.nodes) {
    const node = n.data.label;
    switch (n.type) {
      case 'shell':
        out.push({
          level: 'high',
          node,
          text: n.data.workspace === 'project' ? 'Runs this command in your project folder.' : 'Runs this command on the run branch.',
          code: n.data.command,
        });
        break;
      case 'agent':
        if (n.data.role === 'engineer') {
          out.push(
            n.data.workspace === 'project'
              ? { level: 'high', node, text: 'An engineer that edits files and runs commands in your project folder directly, not on a branch.' }
              : { level: 'high', node, text: 'An engineer that edits files and runs commands on the run branch.' },
          );
        }
        if (n.data.web === true || (n.data.web === undefined && n.data.role === 'scout')) out.push({ level: 'note', node, text: 'Searches and reads the web.' });
        break;
      case 'git':
        if (n.data.action === 'merge') {
          out.push({ level: 'high', node, text: n.data.askBeforeMerge === false ? 'Merges the run branch into your checkout without asking.' : 'Merges the run branch into your checkout, after asking you.' });
        } else if (n.data.action === 'commit') out.push({ level: 'note', node, text: 'Commits on the run branch.' });
        break;
      case 'browser':
        out.push({ level: n.data.guard ? 'note' : 'high', node, text: n.data.guard ? 'Clicks and types on web pages, with Jev guarding each action.' : 'Clicks and types on web pages, with no guard.', code: n.data.startUrl });
        break;
      case 'search':
        out.push({ level: 'note', node, text: 'Searches the web.' });
        break;
      case 'flow':
        if (knownFlowIds !== undefined && !knownFlowIds.has(n.data.flowId)) out.push({ level: 'note', node, text: 'Runs another flow that is not on this Mac. Pick one in its settings, or it cannot run.' });
        else out.push({ level: 'note', node, text: 'Runs another of your flows.' });
        break;
      default:
        break;
    }
  }
  // The riskiest first, in flow order within each level.
  return [...out.filter((p) => p.level === 'high'), ...out.filter((p) => p.level === 'note')];
}
