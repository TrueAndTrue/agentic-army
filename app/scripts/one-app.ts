/**
 * After `npm run install:mac`: leave one Agentic Army on this Mac, the one in /Applications.
 *
 * A build in release/ is a full app too. macOS registers it, Spotlight lists it, and `open -a`
 * may launch it instead of the installed copy, so an old build kept running with an old icon.
 * This deletes the build's copy, tells Launch Services to forget it, and keeps Spotlight out of
 * release/ for the next build.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const INSTALLED = '/Applications/Agentic Army.app';
const release = join(import.meta.dirname, '..', 'release');

if (existsSync(release)) {
  writeFileSync(join(release, '.metadata_never_index'), '');
  for (const dir of readdirSync(release)) {
    const app = join(release, dir, 'Agentic Army.app');
    if (!existsSync(app)) continue;
    execFileSync(LSREGISTER, ['-u', app], { stdio: 'ignore' });
    rmSync(app, { recursive: true, force: true });
    console.log(`Removed the build copy in release/${dir}`);
  }
}
execFileSync(LSREGISTER, ['-f', INSTALLED], { stdio: 'ignore' });
console.log(`The one Agentic Army is ${INSTALLED}`);
