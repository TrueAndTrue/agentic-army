#!/usr/bin/env node
/**
 * Materialise `seed/` as a real git repository at `.seed/`.
 *
 * The seed is checked in as PLAIN FILES and turned into a repository here, rather than being
 * committed as one. A nested `.git` inside a checkout is not a directory the outer repository can
 * hold — git records it as a gitlink and the files vanish from the parent's history — so the two
 * cannot both be true at once.
 *
 * The trial runner refuses a seed that is not a repository with at least one commit, and it is
 * right to: every arm has to start from a byte-identical base or the experiment is comparing
 * workers that were handed different problems. This script is where that base is minted, once,
 * deterministically, before any arm exists.
 *
 * `.seed/` is gitignored. Re-running replaces it.
 */
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const which = process.argv[2];

if (which === undefined) {
  console.error('usage: prepare.mjs <trial-directory-name>   e.g. duration, sheet');
  process.exit(1);
}

const source = join(here, which, 'seed');
const target = join(here, which, '.seed');

if (!existsSync(source)) {
  console.error(`no seed source at ${source}`);
  process.exit(1);
}

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

const git = (...args) => execFileSync('git', args, { cwd: target, stdio: 'pipe' });

git('init', '--quiet', '--initial-branch=main');
// A local identity, so the commit below cannot fail on a machine with no global git config —
// and so the seed commit is identical on every machine rather than carrying whoever ran this.
git('config', 'user.email', 'seed@agentic-army.invalid');
git('config', 'user.name', 'Trial Seed');
git('add', '--all');
git('commit', '--quiet', '--message', `seed: ${which}`);

const head = git('rev-parse', 'HEAD').toString().trim();
console.log(`${target}\n${head}`);
