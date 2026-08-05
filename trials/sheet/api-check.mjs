#!/usr/bin/env node
// Compliance check for the "sheet" trial's `api-intact` id.
//
// The check it replaces was a substring test — `src/sheet.js` contains the literal text
// "export function evaluate" — and it scored a correct implementation as a violation because an
// arm wrote `function evaluate(cells) {...}` and exported it at the bottom of the file with
// `export { evaluate };`. Same export, different spelling. This repo's standing rule is to
// compare identities, not spellings, so this script actually imports the module and inspects its
// export surface instead of grepping for a phrase.
//
// Run with the working directory set to the workspace under test (the trial's `run` executes it
// there). Prints nothing and exits 0 on success. On failure it prints one line to stderr naming
// what it actually found and exits 1 — the exit code is the whole signal a `command` check reads,
// so this must never exit any other way, including on an unhandled rejection.

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

async function main() {
  const target = join(process.cwd(), 'src/sheet.js');
  let mod;
  try {
    mod = await import(pathToFileURL(target).href);
  } catch (error) {
    process.stderr.write(`api-check: failed to import src/sheet.js: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const names = Object.keys(mod).sort();
  const hasDefault = Object.hasOwn(mod, 'default');
  const namedNonDefault = names.filter((name) => name !== 'default');

  const exactlyOneEvaluate = namedNonDefault.length === 1 && namedNonDefault[0] === 'evaluate';
  const evaluateIsFunction = typeof mod.evaluate === 'function';

  if (!exactlyOneEvaluate || hasDefault || !evaluateIsFunction) {
    process.stderr.write(
      `api-check: expected exactly one named export, "evaluate", a function, and no default ` +
        `export. Found named exports: [${names.join(', ')}]; default export: ${String(hasDefault)}; ` +
        `typeof evaluate: ${typeof mod.evaluate}\n`,
    );
    process.exitCode = 1;
    return;
  }
}

main().catch((error) => {
  process.stderr.write(`api-check: unexpected failure: ${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
