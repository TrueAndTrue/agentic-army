import { cloneElement, isValidElement, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Tone = 'primary' | 'quiet' | 'danger' | 'outline';

export function Button({ tone = 'outline', className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      {...rest}
      className={cx(
        'no-drag inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        tone === 'primary' && 'bg-brass text-brass-ink hover:brightness-110',
        tone === 'outline' && 'border border-line bg-panel text-text hover:bg-hover',
        tone === 'quiet' && 'text-muted hover:bg-hover hover:text-text',
        tone === 'danger' && 'border border-line bg-panel text-bad hover:bg-hover',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx('no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-40', className)}
    >
      {children}
    </button>
  );
}

export function PillSelect({ className, children, style, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      // Size to the chosen option, not the longest one.
      style={{ fieldSizing: 'content', ...style } as React.CSSProperties}
      className={cx(
        'no-drag h-7 max-w-[220px] cursor-pointer appearance-none truncate rounded-md border border-transparent bg-transparent pr-6 pl-2 text-[12.5px] text-muted hover:border-line hover:bg-hover hover:text-text focus:text-text',
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%226%22><path d=%22M1 1l4 4 4-4%22 stroke=%22%23888%22 fill=%22none%22 stroke-width=%221.4%22/></svg>')] bg-[length:10px_6px] bg-[position:right_8px_center] bg-no-repeat",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cx(
        'h-8 w-full cursor-pointer appearance-none rounded-md border border-line bg-panel pr-7 pl-2.5 text-[13px] text-text hover:border-line-strong',
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%226%22><path d=%22M1 1l4 4 4-4%22 stroke=%22%23888%22 fill=%22none%22 stroke-width=%221.4%22/></svg>')] bg-[length:10px_6px] bg-[position:right_10px_center] bg-no-repeat",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx('h-8 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] text-text placeholder:text-faint hover:border-line-strong focus:border-brass focus:outline-none', className)} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={cx('w-full resize-y rounded-md border border-line bg-panel px-2.5 py-2 font-mono text-[12px] leading-relaxed text-text placeholder:text-faint hover:border-line-strong focus:border-brass focus:outline-none', className)}
    />
  );
}

/**
 * A labelled control. The label names the control and nothing else; the hint is attached as its
 * description, so a screen reader reads "Name, edit text" and then the hint, not one long name.
 */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactElement<{ id?: string; 'aria-describedby'?: string }> | ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const control = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { id, ...(hint === undefined ? {} : { 'aria-describedby': hintId }) })
    : children;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[12px] font-medium text-muted">
        {label}
      </label>
      {control}
      {hint !== undefined && (
        <span id={hintId} className="block text-[11.5px] leading-snug text-faint">
          {hint}
        </span>
      )}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="no-drag flex items-center gap-2 text-[13px] text-text"
    >
      <span className={cx('relative h-[18px] w-8 rounded-full transition-colors', checked ? 'bg-brass' : 'bg-line-strong')}>
        <span className={cx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all', checked ? 'left-[16px]' : 'left-[2px]')} />
      </span>
      {label}
    </button>
  );
}

export function Dot({ color, pulse, className }: { color: string; pulse?: boolean; className?: string }) {
  return <span className={cx('inline-block h-2 w-2 shrink-0 rounded-full', pulse && 'pulse', className)} style={{ background: color }} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-raised px-1 font-mono text-[10.5px] text-muted">{children}</kbd>;
}
