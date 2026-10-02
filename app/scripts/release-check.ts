/**
 * Runs before `npm run release` and stops it early, with the reason, when something a public
 * release needs is missing. Without this, electron-builder spends minutes on a universal build and
 * then fails at signing or publishing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { build: { publish: { owner: string; repo: string }[] } };
const env = process.env;
const missing: string[] = [];

const feed = pkg.build.publish[0];
if (feed === undefined || /REPLACE_WITH/.test(feed.owner)) missing.push('Set build.publish owner in app/package.json to the GitHub account or organization that owns the repo.');
if ((env['GH_TOKEN'] ?? '') === '') missing.push('Set GH_TOKEN to a GitHub token that can write releases to the repo.');

// electron-builder signs with CSC_LINK when it is set, otherwise with a Developer ID in the keychain.
const hasKeychainId = (() => {
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).includes('Developer ID Application');
  } catch {
    return false;
  }
})();
if ((env['CSC_LINK'] ?? '') === '' && !hasKeychainId) missing.push('Add a "Developer ID Application" certificate to the keychain, or set CSC_LINK and CSC_KEY_PASSWORD to its .p12 file.');

const appleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every((k) => (env[k] ?? '') !== '');
const apiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every((k) => (env[k] ?? '') !== '');
if (!appleId && !apiKey && (env['APPLE_KEYCHAIN_PROFILE'] ?? '') === '')
  missing.push('Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID, or APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, so Apple can notarize the app.');

if (missing.length > 0) {
  console.error(`Not ready to release:\n${missing.map((m) => `- ${m}`).join('\n')}\nSee "Releasing" in app/README.md.`);
  process.exit(1);
}
console.log(`Releasing to github.com/${feed!.owner}/${feed!.repo}.`);
