/**
 * The decisions behind updates, kept apart from Electron so the tests can run them: whether this
 * build has a feed, whether macOS will let it replace itself, and what to say when a check fails.
 */

/** Where electron-builder points the updater, read from the app-update.yml it writes into the app. */
export interface Feed {
  owner: string;
  repo: string;
}

/**
 * The feed in an app-update.yml, or null when there is none to use. electron-builder writes the
 * file from `build.publish`, and until the repo has an owner that block holds a placeholder, which
 * would send every check to a GitHub account that does not exist.
 */
export function readFeed(yaml: string | null): Feed | null {
  if (yaml === null) return null;
  const field = (key: string) => yaml.match(new RegExp(`^${key}:\\s*['"]?([^'"\\n]*?)['"]?\\s*$`, 'm'))?.[1] ?? '';
  const provider = field('provider');
  const owner = field('owner');
  const repo = field('repo');
  if (provider !== 'github' || owner === '' || repo === '' || /REPLACE_WITH/i.test(owner) || /REPLACE_WITH/i.test(repo)) return null;
  return { owner, repo };
}

/** Why updates stay off for this run, or null when the updater may run. */
export function offReason(opts: { packaged: boolean; hidden: boolean; feed: Feed | null }): string | null {
  if (!opts.packaged) return 'Updates are off in a development build.';
  // The e2e suite runs the packaged app too, and a test must never download or install anything.
  if (opts.hidden) return 'Updates are off while the app runs hidden for tests.';
  if (opts.feed === null) return 'Updates are not set up for this build.';
  return null;
}

export type Signing = 'certificate' | 'adhoc' | 'unsigned';

/**
 * How the app bundle is signed, from what `codesign -dv --verbose=2` prints about it (to stderr).
 * Squirrel.Mac installs an update only when the new copy satisfies the running copy's designated
 * requirement, and an ad hoc signature has no certificate to match against, so only a copy signed
 * with a real certificate can update itself. `Signature=adhoc` and the `adhoc` flag mark an ad hoc
 * signature; "not signed at all" means none; an `Authority=` line with a `TeamIdentifier` means a
 * certificate signed it. Anything else counts as unsigned, because guessing wrong in that direction
 * only means pointing you to the download page.
 */
export function readSigning(codesignOutput: string): Signing {
  if (/not signed at all/i.test(codesignOutput)) return 'unsigned';
  if (/^Signature=adhoc/m.test(codesignOutput) || /flags=0x[0-9a-f]+\([^)]*\badhoc\b/i.test(codesignOutput)) return 'adhoc';
  const team = codesignOutput.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (/^Authority=/m.test(codesignOutput) && team !== undefined && team !== 'not set') return 'certificate';
  return 'unsigned';
}

/** A failed check or download, said the way a person would want to hear it. */
export function plainUpdateError(message: string, feed: Feed | null): string {
  const where = feed === null ? 'GitHub' : `github.com/${feed.owner}/${feed.repo}`;
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ECONNREFUSED|ETIMEDOUT|ERR_NETWORK_CHANGED|ERR_CONNECTION/i.test(message)) return 'Could not reach GitHub. Check the connection and try again.';
  if (/\b404\b|Unable to find latest version|No published versions/i.test(message)) return `No release found at ${where}.`;
  if (/\b(401|403)\b|rate limit/i.test(message)) return 'GitHub refused the request. It may be rate limiting; try again later.';
  if (/latest-mac\.yml|Cannot find .*\.yml/i.test(message)) return `The latest release at ${where} has no update files for macOS.`;
  if (/code ?signature|did not pass validation|designated requirement/i.test(message)) return 'macOS refused the update because its signature does not match this copy. Download the new version from GitHub instead.';
  if (/sha512 checksum mismatch/i.test(message)) return 'The download was damaged. Try again.';
  const first = message.split('\n')[0]?.trim() ?? '';
  return first === '' ? 'The update failed for an unknown reason.' : `The update failed: ${first.slice(0, 200)}`;
}
