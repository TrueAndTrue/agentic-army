import { Check, Copy } from 'lucide-react';
import { createContext, memo, useContext, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { api } from '../lib/state.ts';
import { cx } from './ui.tsx';

/** The folder relative links resolve against: the session's project. */
export const LinkBase = createContext<string | undefined>(undefined);

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className={cx('inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-faint hover:bg-hover hover:text-text', className)}
    >
      {done ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
      {done ? 'Copied' : null}
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = children as { props?: { className?: string; children?: ReactNode } } | undefined;
  const lang = /language-([\w+-]+)/.exec(code?.props?.className ?? '')?.[1];
  const text = textOf(code?.props?.children).replace(/\n$/, '');
  const diff = lang === 'diff' || lang === 'patch';
  return (
    <div className="code-block group/code relative">
      <div className="absolute top-1 right-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/code:opacity-100 focus-within:opacity-100">
        {lang !== undefined && <span className="px-1 font-mono text-[10.5px] text-faint">{lang}</span>}
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre>
        {diff ? (
          <code>
            {text.split('\n').map((l, i) => (
              <span key={i} className={cx('block', l.startsWith('+') ? 'text-ok' : l.startsWith('-') ? 'text-bad' : l.startsWith('@@') ? 'text-run' : undefined)}>
                {l === '' ? ' ' : l}
              </span>
            ))}
          </code>
        ) : (
          children
        )}
      </pre>
    </div>
  );
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const base = useContext(LinkBase);
  const [miss, setMiss] = useState<string | null>(null);
  return (
    <a
      href={href}
      title={miss ?? href}
      onClick={(e) => {
        // Nothing a reply links to may navigate the window; the main process decides where it opens.
        e.preventDefault();
        if (href === undefined || href.startsWith('#')) return;
        void api()
          .openLink(href, base)
          .then((r) => setMiss(r.ok ? null : r.message));
      }}
      className={cx(miss !== null && 'decoration-dotted')}
    >
      {children}
    </a>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`prose selectable ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
