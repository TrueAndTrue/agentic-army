/**
 * Syntax highlighting for code blocks in replies: highlight.js's core with only the grammars agents
 * write, not its full set of 190. They load as a chunk of their own the first time a reply has a
 * code block, so a window that never shows code never loads them; until then a block shows plain.
 * Diffs are not among them: `Markdown.tsx` colours those by line.
 */

import { useSyncExternalStore } from 'react';

import type { HLJSApi } from 'highlight.js';

/** Fence names agents use, to the grammar that reads them. */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  python: 'python',
  py: 'python',
  go: 'go',
  golang: 'go',
  rust: 'rust',
  rs: 'rust',
  css: 'css',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  markdown: 'markdown',
  md: 'markdown',
};

export function grammarFor(lang: string | undefined): string | undefined {
  return lang === undefined ? undefined : ALIASES[lang.toLowerCase()];
}

let hljs: HLJSApi | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): void {
  if (loading !== null) return;
  loading = import('./grammars.ts')
    .then((m) => {
      hljs = m.highlighter();
      for (const l of listeners) l();
    })
    .catch(() => {
      // Plain code is still readable; try again on the next block.
      loading = null;
    });
}

/** The highlighter once it has loaded, or null. Asking starts the load. */
export function useHighlighter(): HLJSApi | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      load();
      return () => listeners.delete(l);
    },
    () => hljs,
  );
}

/** Highlighted HTML for one block, escaped by highlight.js, or null when the grammar is not one we load. */
export function highlight(h: HLJSApi, code: string, grammar: string): string | null {
  try {
    return h.highlight(code, { language: grammar, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
