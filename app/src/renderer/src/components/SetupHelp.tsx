import { RefreshCw, SquareTerminal } from 'lucide-react';
import { useState } from 'react';

import { api, checkMachine, go } from '../lib/state.ts';
import { CopyButton } from './Markdown.tsx';
import { cx } from './ui.tsx';

export type SetupTool = 'claude' | 'codex' | 'git';

/** How to get each tool onto a Mac, as commands to paste into Terminal. */
const HOW: Record<SetupTool, { intro: string; commands: string[]; then: string }> = {
  claude: {
    intro: 'Install Claude Code by pasting this into Terminal:',
    commands: ['curl -fsSL https://claude.ai/install.sh | bash'],
    then: 'Then run claude once in Terminal and log in.',
  },
  codex: {
    intro: 'Install the Codex CLI with npm or with Homebrew:',
    commands: ['npm install -g @openai/codex', 'brew install --cask codex'],
    then: 'Then run codex login in Terminal.',
  },
  git: {
    intro: "Install Apple's command line tools, which include git:",
    commands: ['xcode-select --install'],
    then: 'Follow the window that opens.',
  },
};

const TERMINAL = '/System/Applications/Utilities/Terminal.app';

/**
 * A missing CLI, with the command that installs it, a way to open Terminal, and a check that says
 * whether the app finds it now. Shown on Home, in Settings, and wherever a step failed for want of it.
 */
export function SetupHelp({ tool, after, className }: { tool: SetupTool; after?: string; className?: string }) {
  const how = HOW[tool];
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const check = async () => {
    setChecking(true);
    const d = await checkMachine(true);
    setChecking(false);
    setResult(tool === 'claude' ? d.claude : tool === 'codex' ? d.codex : d.git);
  };
  return (
    <div className={cx('text-[12px] leading-relaxed text-muted', className)} aria-label={`How to install ${tool}`}>
      <p>{how.intro}</p>
      {how.commands.map((c) => (
        <div key={c} className="mt-1 flex items-center gap-1 rounded-md border border-line bg-raised py-0.5 pr-0.5 pl-2.5">
          <code className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-text">{c}</code>
          <CopyButton text={c} label={`Copy ${c}`} />
        </div>
      ))}
      <p className="mt-1.5">
        {how.then}
        {after !== undefined && ` ${after}`}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <button type="button" className="no-drag inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 text-[12px] text-text hover:bg-hover" onClick={() => void api().openLink(TERMINAL)}>
          <SquareTerminal size={13} /> Open Terminal
        </button>
        <button type="button" disabled={checking} className="no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-muted hover:bg-hover hover:text-text" onClick={() => void check()}>
          <RefreshCw size={12} className={checking ? 'animate-spin' : undefined} /> Check again
        </button>
        {result !== null &&
          (result.ok ? (
            <span role="status" className="text-ok">
              Found {result.detail}.
            </span>
          ) : (
            <span role="status" className="text-warn">
              Still not found.{' '}
              {tool !== 'git' && (
                <button type="button" className="underline decoration-line-strong underline-offset-2 hover:text-text" onClick={() => go({ kind: 'settings', section: 'tools' })}>
                  Set its path in Settings
                </button>
              )}
            </span>
          ))}
      </div>
    </div>
  );
}
