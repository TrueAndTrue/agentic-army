#!/usr/bin/env node
// The one bin, for two kinds of install. A published tarball ships only `dist/`, but a checkout
// or `npm link` install has the live TypeScript right there — and pointing the bin at `dist/`
// in that case runs whatever `npm run build` last froze, which silently diverges from the code
// the checkout actually contains. So: prefer `src/` when it exists, fall back to `dist/`.
// Node 24 executes the TypeScript directly (type stripping), so no build step is involved.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src', 'cli.ts');
await import(pathToFileURL(existsSync(src) ? src : join(here, '..', 'dist', 'cli.js')).href);
