import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { Controller } from '../src/main/controller.ts';
import { FileLog, setLogFile } from '../src/main/log.ts';
import { ENCRYPTED, Store, type Secrets } from '../src/main/store.ts';
import { SAVED_KEY, type AppEvent } from '../src/shared/types.ts';

/** Stands in for safeStorage: reversible, and refuses anything it did not write, like a changed Keychain. */
function fakeKeychain(tag = 'mac-1'): Secrets & { encrypted: number } {
  const k = {
    encrypted: 0,
    available: () => true,
    encrypt(plain: string) {
      k.encrypted += 1;
      return Buffer.from(`${tag}:${plain}`).toString('base64');
    },
    decrypt(sealed: string) {
      const text = Buffer.from(sealed, 'base64').toString();
      if (!text.startsWith(`${tag}:`)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return text.slice(tag.length + 1);
    },
  };
  return k;
}

function home(settings?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'army-secrets-'));
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
}

const onDisk = (dir: string) => readFileSync(join(dir, 'settings.json'), 'utf8');

describe('keys at rest', () => {
  let envKey: string | undefined;
  let logDir: string;
  beforeEach(() => {
    envKey = process.env['TYPESAFE_API_KEY'];
    delete process.env['TYPESAFE_API_KEY'];
    logDir = mkdtempSync(join(tmpdir(), 'army-log-'));
    setLogFile(new FileLog(logDir));
  });
  afterEach(() => {
    if (envKey === undefined) delete process.env['TYPESAFE_API_KEY'];
    else process.env['TYPESAFE_API_KEY'] = envKey;
    setLogFile(null);
  });

  test('a plain key from an older version is encrypted on first load, and still reads back', () => {
    const dir = home({ typesafe: { apiKey: 'ts-live-1234567', model: 'jev-latest', baseUrl: 'https://x' }, braveApiKey: 'brave-secret-99' });
    const s = new Store(dir, { secrets: fakeKeychain() }).loadSettings();
    assert.equal(s.typesafe.apiKey, 'ts-live-1234567');
    assert.equal(s.braveApiKey, 'brave-secret-99');
    const text = onDisk(dir);
    assert.doesNotMatch(text, /ts-live-1234567|brave-secret-99/);
    const raw = JSON.parse(text) as { typesafe: { apiKey: string }; braveApiKey: string };
    assert.ok(raw.typesafe.apiKey.startsWith(ENCRYPTED));
    assert.ok(raw.braveApiKey.startsWith(ENCRYPTED));
    assert.equal(new Store(dir, { secrets: fakeKeychain() }).loadSettings().typesafe.apiKey, 'ts-live-1234567');
    assert.match(readFileSync(join(logDir, 'main.log'), 'utf8'), /Moved the keys in settings\.json into encrypted storage/);
  });

  test('saving writes ciphertext; an empty key stays empty', () => {
    const dir = home();
    const store = new Store(dir, { secrets: fakeKeychain() });
    const s = store.loadSettings();
    store.saveSettings({ ...s, typesafe: { ...s.typesafe, apiKey: 'ts-new-key-777' } });
    assert.doesNotMatch(onDisk(dir), /ts-new-key-777/);
    assert.equal(store.loadSettings().typesafe.apiKey, 'ts-new-key-777');
    store.saveSettings({ ...s, typesafe: { ...s.typesafe, apiKey: '' } });
    assert.equal((JSON.parse(onDisk(dir)) as { typesafe: { apiKey: string } }).typesafe.apiKey, '');
  });

  test('a key this Mac cannot decrypt counts as no key, is logged, and does not throw', () => {
    const dir = home();
    new Store(dir, { secrets: fakeKeychain('other-mac') }).saveSettings({ ...new Store(dir).loadSettings(), typesafe: { apiKey: 'copied-key-123', model: 'jev-latest', baseUrl: 'https://x' } });
    const s = new Store(dir, { secrets: fakeKeychain('this-mac') }).loadSettings();
    assert.equal(s.typesafe.apiKey, '');
    assert.match(readFileSync(join(logDir, 'main.log'), 'utf8'), /could not be decrypted .* treats it as no key/);
  });

  test('plain Node, with no keychain, reads and writes keys as before and cannot read an encrypted one', () => {
    const dir = home({ typesafe: { apiKey: 'plain-key-555', model: 'jev-latest', baseUrl: 'https://x' } });
    const store = new Store(dir);
    assert.equal(store.loadSettings().typesafe.apiKey, 'plain-key-555');
    assert.match(onDisk(dir), /plain-key-555/, 'nothing rewrote the file');
    new Store(dir, { secrets: fakeKeychain() }).loadSettings();
    assert.equal(new Store(dir).loadSettings().typesafe.apiKey, '');
  });

  test('TYPESAFE_API_KEY fills in a missing key, and loading does not write it to disk', () => {
    process.env['TYPESAFE_API_KEY'] = 'env-key-424242';
    const dir = home({ typesafe: { apiKey: '', model: 'jev-latest', baseUrl: 'https://x' }, braveApiKey: 'brave-plain-1' });
    const s = new Store(dir, { secrets: fakeKeychain() }).loadSettings();
    assert.equal(s.typesafe.apiKey, 'env-key-424242');
    assert.doesNotMatch(onDisk(dir), /env-key-424242/);
    // An undecryptable key falls back to the environment too.
    const other = home();
    new Store(other, { secrets: fakeKeychain('elsewhere') }).saveSettings({ ...s, typesafe: { ...s.typesafe, apiKey: 'lost-key-1' } });
    assert.equal(new Store(other, { secrets: fakeKeychain() }).loadSettings().typesafe.apiKey, 'env-key-424242');
  });
});

describe('the window never gets a key', () => {
  test('state and settings events carry SAVED_KEY; sending it back keeps the key; an empty one removes it', () => {
    const dir = home({ typesafe: { apiKey: 'ts-window-key', model: 'jev-latest', baseUrl: 'https://x' }, braveApiKey: 'brave-window-key' });
    const events: AppEvent[] = [];
    const c = new Controller({ store: new Store(dir, { secrets: fakeKeychain() }), emit: (e) => events.push(e), openPage: () => { throw new Error('no pages here'); } });
    const shown = c.getState().settings;
    assert.equal(shown.typesafe.apiKey, SAVED_KEY);
    assert.equal(shown.braveApiKey, SAVED_KEY);
    const back = c.saveSettings({ ...shown, theme: 'light' });
    assert.equal(back.typesafe.apiKey, SAVED_KEY);
    assert.equal(c.settings.typesafe.apiKey, 'ts-window-key');
    assert.equal(c.settings.braveApiKey, 'brave-window-key');
    const sent = events.filter((e): e is Extract<AppEvent, { type: 'settings' }> => e.type === 'settings');
    assert.ok(sent.length > 0);
    assert.ok(sent.every((e) => !JSON.stringify(e).includes('window-key')));
    c.saveSettings({ ...shown, braveApiKey: '' });
    assert.equal(c.settings.braveApiKey, '');
    assert.equal(c.settings.typesafe.apiKey, 'ts-window-key');
    assert.deepEqual(c.secrets(), ['ts-window-key']);
  });
});
