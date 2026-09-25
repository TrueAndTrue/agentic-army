import { ChevronDown } from 'lucide-react';
import { cloneElement, isValidElement, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

import { effortsFor } from '../../../shared/models.ts';
import type { Harness, ModelEntry } from '../../../shared/types.ts';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Tone = 'primary' | 'quiet' | 'danger' | 'outline';

export function Button({ tone = 'outline', className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      {...rest}
      className={cx(
        'no-drag inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        // A disabled primary loses its colour: at reduced opacity brass still read as ready to press.
        tone === 'primary' && 'bg-brass text-brass-ink hover:brightness-110 disabled:bg-hover disabled:text-faint disabled:hover:brightness-100',
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

/**
 * The chevron is an icon beside the select, not a background image: Tailwind dropped the old
 * data-URI class from the build, so every select read as plain text with no sign it opens.
 */
function Chevron({ right }: { right: number }) {
  return <ChevronDown aria-hidden size={13} strokeWidth={2} className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-faint" style={{ right }} />;
}

export function PillSelect({ className, children, style, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="no-drag relative inline-flex min-w-0">
      <select
        {...rest}
        // Size to the chosen option, not the longest one.
        style={{ fieldSizing: 'content', ...style } as React.CSSProperties}
        className={cx(
          'h-7 max-w-[220px] cursor-pointer appearance-none truncate rounded-md border border-transparent bg-transparent pr-6 pl-2 text-[12.5px] text-muted hover:border-line hover:bg-hover hover:text-text focus:text-text',
          className,
        )}
      >
        {children}
      </select>
      <Chevron right={7} />
    </span>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative flex w-full min-w-0">
      <select
        {...rest}
        className={cx('h-8 w-full cursor-pointer appearance-none rounded-md border border-line bg-panel pr-7 pl-2.5 text-[13px] text-text hover:border-line-strong', className)}
      >
        {children}
      </select>
      <Chevron right={9} />
    </span>
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

const HARNESS_GROUP: Record<Harness, string> = { claude: 'Claude', codex: 'Codex' };

/** The models as `<option>`s, grouped by the tool that runs them. */
export function ModelOptions({ models }: { models: ModelEntry[] }) {
  return (
    <>
      {(['claude', 'codex'] as const).map((h) => {
        const list = models.filter((m) => m.harness === h);
        return list.length === 0 ? null : (
          <optgroup key={h} label={HARNESS_GROUP[h]}>
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

/** The effort levels this model takes, as `<option>`s. */
export function EffortOptions({ model, suffix = '' }: { model: ModelEntry | undefined; suffix?: string }) {
  return (
    <>
      {effortsFor(model).map((x) => (
        <option key={x} value={x}>
          {x}
          {suffix}
        </option>
      ))}
    </>
  );
}
