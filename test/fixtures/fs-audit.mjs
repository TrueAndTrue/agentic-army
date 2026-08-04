/**
 * The filesystem tripwire every hermeticity audit in this suite shares.
 *
 * WHY IT EXISTS. This package writes into `~/.agentic-army`: campaign archives, the global
 * config, the worktree pool beside it. A test that resolves that path from the ambient
 * environment instead of a temporary directory does not fail — it succeeds, against the
 * developer's own data. The first instance found here was worse than data: the worktree pool
 * read `<home>/config.toml` for its `post_create` hooks, so a plain `npm test` executed whatever
 * commands happened to be configured on the machine, 31 times per run.
 *
 * WHY IT IS NOT A GREP. The next default that falls back to the real home will be spelled
 * differently from the last one. So this observes what the process actually does: `node:fs` and
 * `node:fs/promises` are patched, every path argument is compared against a set of protected
 * roots, and every match is recorded with the API that touched it.
 *
 * WHY IT IS A SEPARATE MODULE. There were two copies of this patch inline in two test files,
 * and they had already drifted — one watched `~/.agentic-army-trees` and the other did not.
 * A tripwire that differs between the places it is installed reports the union of nobody's
 * intent. There is one list now, and the audits differ only in what they run underneath it.
 *
 * ORDERING. The patch must land before the code under audit is LINKED, because an ESM named
 * import snapshots its binding at link time. So a runner imports this module first and reaches
 * for everything else with a dynamic `import()` afterwards. Patching the CJS exports object is
 * what makes that work: every ESM consumer of a builtin resolves through it.
 *
 * WHAT IT DOES NOT SEE, stated because a guard that overstates its reach is worse than none:
 *
 *   - Subprocesses. `git`, the fake harnesses and any spawned CLI have their own file tables.
 *     What they are given instead is an explicit `env` and an explicit `cwd`.
 *   - `node:sqlite`. It opens database files in native code and never calls through `node:fs`,
 *     so an archive opened in the real home would be invisible here. The path it is handed is
 *     usually built by code that this audit does see reaching for the home, but not always.
 *   - Writes through a file descriptor or a `FileHandle` after the fact. The `open` that
 *     produced the handle is recorded, which is where the path is; the later `write` is not.
 *   - `fs.watch` and `fs.watchFile`, deliberately: neither is used by this package, and
 *     wrapping the watcher API to cover a caller that does not exist buys nothing.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The directories nothing under audit may touch, derived from the real home in
 * `ARMY_AUDIT_HOME`.
 *
 * DERIVED HERE, not passed in by each audit, because that is precisely where the two inline
 * copies drifted: one of them watched the worktree pool at `<home>-trees` and the other did
 * not, so the same defect was a failure in one test file and invisible in the other. An audit
 * now says only which process to run.
 *
 * `ARMY_AUDIT_ROOTS` overrides the list outright, and exists for one caller: this module's own
 * self-test, which points it at a scratch directory and then writes, renames and deletes inside
 * it. A detector that has never been watched to fire is not a detector.
 */
function protectedRoots() {
  const override = process.env['ARMY_AUDIT_ROOTS'];
  if (override !== undefined) return JSON.parse(override);
  const home = process.env['ARMY_AUDIT_HOME'];
  // Neither one set means every comparison below is against nothing, so the audit records zero
  // hits and passes. Refuse instead: a vacuous green is the exact failure this module exists to
  // prevent, and it is the one shape of it that is invisible in the result.
  if (home === undefined || home.trim() === '') {
    throw new Error('fs-audit: set ARMY_AUDIT_HOME to the real home, or ARMY_AUDIT_ROOTS outright');
  }
  return ['/.agentic-army', '/.agentic-army-trees', '/.ssh', '/.aws', '/.config/gh'].map(
    (suffix) => home + suffix,
  );
}

export const PROTECTED_ROOTS = protectedRoots();

/** Every touch, as `<api> <path>`. Naming the API is what makes a hit actionable. */
export const hits = new Set();

/** The recorded touches, sorted, as a plain array. */
export function hitList() {
  return [...hits].sort();
}

function record(api, value) {
  if (typeof value !== 'string') {
    if (value instanceof URL) value = value.pathname;
    else if (Buffer.isBuffer(value)) value = value.toString('utf8');
    else return; // a file descriptor, or something with no path in it at all
  }
  for (const root of PROTECTED_ROOTS) {
    if (value === root || value.startsWith(root + '/')) hits.add(`${api} ${value}`);
  }
}

/**
 * APIs whose FIRST argument is a path.
 *
 * Reads and writes together, and the writes are the half that was missing: the previous copies
 * of this list carried `writeFileSync`, `appendFileSync` and `mkdirSync` but no way to remove
 * anything, so `writeFile` followed by `rm` — which is exactly how `inspectWritableDir` proves
 * a directory is writable — was recorded as a single touch at best and, on the promises API,
 * left the deletion completely unobserved.
 */
const SINGLE_PATH = [
  // Reads and metadata.
  'readFile', 'readFileSync',
  'stat', 'statSync', 'lstat', 'lstatSync', 'statfs', 'statfsSync',
  'exists', 'existsSync', 'access', 'accessSync',
  'readdir', 'readdirSync', 'opendir', 'opendirSync',
  'realpath', 'realpathSync', 'readlink', 'readlinkSync',
  'open', 'openSync', 'createReadStream',
  // Creation and mutation.
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
  'truncate', 'truncateSync',
  'chmod', 'chmodSync', 'chown', 'chownSync', 'lchmod', 'lchmodSync', 'lchown', 'lchownSync',
  'utimes', 'utimesSync', 'lutimes', 'lutimesSync',
  // Removal.
  'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync',
];

/**
 * APIs with a path in the first AND second argument. Both are recorded.
 *
 * `rename` out of a protected root is a write to it and a delete from it at once, and recording
 * only the source would call moving the developer's config somewhere else a read.
 */
const TWO_PATH = [
  'rename', 'renameSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'link', 'linkSync', 'symlink', 'symlinkSync',
];

/**
 * Wrap, preserving own properties.
 *
 * `fs.realpathSync.native` and `fs.realpath.native` are real call sites in this package and are
 * properties hanging off the function object. A naive wrapper drops them, and the module under
 * audit then dies on a TypeError that has nothing to do with what is being audited — a guard
 * that breaks its subject proves nothing about it.
 */
function wrap(original, onCall) {
  const patched = function patched(...args) {
    onCall(args);
    return original.apply(this, args);
  };
  // `Reflect.ownKeys`, not `getOwnPropertyNames`: `util.promisify.custom` hangs off several of
  // these as a SYMBOL, and dropping it silently changes what `promisify` returns.
  for (const name of Reflect.ownKeys(original)) {
    if (name === 'length' || name === 'name' || name === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, name);
    if (descriptor !== undefined) Object.defineProperty(patched, name, descriptor);
  }
  return patched;
}

// `require('node:fs').promises` and `node:fs/promises` are the SAME object, so the promises API
// is patched exactly once even though both are listed here.
for (const mod of [require('node:fs'), require('node:fs/promises')]) {
  for (const name of SINGLE_PATH) {
    const original = mod[name];
    if (typeof original !== 'function') continue;
    mod[name] = wrap(original, (args) => record(name, args[0]));
  }
  for (const name of TWO_PATH) {
    const original = mod[name];
    if (typeof original !== 'function') continue;
    mod[name] = wrap(original, (args) => {
      record(name, args[0]);
      record(name, args[1]);
    });
  }
}
