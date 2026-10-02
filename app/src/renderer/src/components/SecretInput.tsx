import { SAVED_KEY } from '../../../shared/types.ts';
import { Button, Input } from './ui.tsx';

/**
 * A field for a key the main process keeps encrypted. The window never gets a saved key, only
 * `SAVED_KEY`, so the box stays empty and says a key is saved. Typing replaces it on Save; clearing
 * the box keeps it; Remove deletes it on Save.
 */
export function SecretInput({ value, wasSaved, onChange, placeholder, label }: { value: string | undefined; wasSaved: boolean; onChange(v: string): void; placeholder: string; label: string }) {
  const kept = value === SAVED_KEY;
  const removed = wasSaved && (value ?? '') === '';
  return (
    <div className="flex gap-2">
      <Input
        type="password"
        autoComplete="off"
        aria-label={label}
        value={kept ? '' : (value ?? '')}
        placeholder={kept ? 'Saved, and encrypted in your Keychain. Paste a new key to replace it.' : removed ? 'Removed when you save.' : placeholder}
        onChange={(e) => onChange(e.target.value === '' && wasSaved ? SAVED_KEY : e.target.value)}
      />
      {kept && (
        <Button tone="quiet" type="button" onClick={() => onChange('')}>
          Remove
        </Button>
      )}
      {removed && (
        <Button tone="quiet" type="button" onClick={() => onChange(SAVED_KEY)}>
          Keep it
        </Button>
      )}
    </div>
  );
}
