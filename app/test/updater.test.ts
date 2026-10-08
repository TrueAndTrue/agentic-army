import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { offReason, plainUpdateError, readFeed, readSigning } from '../src/main/updateRules.ts';

describe('the update feed', () => {
  test('reads the owner and repo electron-builder writes', () => {
    const yml = 'owner: austin\nrepo: agentic-army\nprovider: github\nupdaterCacheDirName: agentic-army-app-updater\n';
    assert.deepEqual(readFeed(yml), { owner: 'austin', repo: 'agentic-army' });
    assert.deepEqual(readFeed("owner: 'austin'\nrepo: \"agentic-army\"\nprovider: github\n"), { owner: 'austin', repo: 'agentic-army' });
  });

  test('has no feed while the owner is the placeholder, or with no file', () => {
    assert.equal(readFeed('owner: REPLACE_WITH_GITHUB_OWNER\nrepo: agentic-army\nprovider: github\n'), null);
    assert.equal(readFeed(null), null);
    assert.equal(readFeed('provider: github\nrepo: agentic-army\n'), null);
    assert.equal(readFeed('provider: generic\nurl: https://example.com\n'), null);
  });

  test('stays off in dev, in tests and without a feed', () => {
    const feed = { owner: 'austin', repo: 'agentic-army' };
    assert.equal(offReason({ packaged: true, hidden: false, feed }), null);
    assert.match(offReason({ packaged: false, hidden: false, feed })!, /development build/);
    assert.match(offReason({ packaged: true, hidden: true, feed })!, /hidden for tests/);
    assert.equal(offReason({ packaged: true, hidden: false, feed: null }), 'Updates are not set up for this build.');
  });
});

describe('how the app is signed', () => {
  test('a certificate signature, such as a Developer ID', () => {
    const out = [
      'Executable=/Applications/Slack.app/Contents/MacOS/Slack',
      'CodeDirectory v=20500 size=645 flags=0x12000(library-validation,runtime) hashes=9+7 location=embedded',
      'Authority=Developer ID Application: SLACK TECHNOLOGIES L.L.C. (BQR82RBBHL)',
      'Authority=Developer ID Certification Authority',
      'Authority=Apple Root CA',
      'TeamIdentifier=BQR82RBBHL',
    ].join('\n');
    assert.equal(readSigning(out), 'certificate');
  });

  test('ad hoc, as install:mac signs it and as Electron ships', () => {
    assert.equal(readSigning('CodeDirectory v=20400 size=305 flags=0x2(adhoc) hashes=3+3 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n'), 'adhoc');
    assert.equal(readSigning('CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded\nTeamIdentifier=not set\n'), 'adhoc');
  });

  test('unsigned, or anything it cannot read', () => {
    assert.equal(readSigning('/Applications/X.app: code object is not signed at all'), 'unsigned');
    assert.equal(readSigning(''), 'unsigned');
    assert.equal(readSigning('Authority=Someone\nTeamIdentifier=not set\n'), 'unsigned');
  });
});

describe('update errors in plain words', () => {
  const feed = { owner: 'austin', repo: 'agentic-army' };
  test('names the cause', () => {
    assert.equal(plainUpdateError('net::ERR_INTERNET_DISCONNECTED', feed), 'Could not reach GitHub. Check the connection and try again.');
    assert.equal(plainUpdateError('HttpError: 404 \n"method: GET url: https://github.com/austin/agentic-army/releases.atom"', feed), 'No release found at github.com/austin/agentic-army.');
    assert.match(plainUpdateError('Cannot find latest-mac.yml in the latest release artifacts', feed), /no update files for macOS/);
    assert.match(plainUpdateError('Code signature at URL file:///x did not pass validation: code object is not signed at all', feed), /signature does not match/);
  });

  test('keeps the first line of anything else', () => {
    assert.equal(plainUpdateError('Something odd\n    at stack', feed), 'The update failed: Something odd');
    assert.equal(plainUpdateError('', null), 'The update failed for an unknown reason.');
  });
});
