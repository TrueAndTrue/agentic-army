/**
 * Renders build/icon.svg to every size macOS asks for and packs them into build/icon.icns, which
 * electron-builder puts in the app. Run it after changing the SVG: `npm run icon`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright';

const BUILD = resolve(import.meta.dirname, '../build');
const svg = readFileSync(join(BUILD, 'icon.svg'), 'utf8');
const set = join(BUILD, 'icon.iconset');
rmSync(set, { recursive: true, force: true });
mkdirSync(set);

// Playwright's own Chromium when it is downloaded, otherwise the Google Chrome on this Mac.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage();
async function render(px: number, file: string): Promise<void> {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg style="display:block;width:${String(px)}px;height:${String(px)}px" `)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true });
}

// iconutil wants 16, 32, 128, 256 and 512 points, each at @1x and @2x.
for (const pt of [16, 32, 128, 256, 512]) {
  await render(pt, join(set, `icon_${String(pt)}x${String(pt)}.png`));
  await render(pt * 2, join(set, `icon_${String(pt)}x${String(pt)}@2x.png`));
}
// A plain PNG too, for the window icon in dev runs and for looking at.
await render(1024, join(BUILD, 'icon.png'));
await browser.close();

execFileSync('iconutil', ['-c', 'icns', set, '-o', join(BUILD, 'icon.icns')]);
rmSync(set, { recursive: true });
console.log(`Wrote ${join(BUILD, 'icon.icns')} and icon.png`);
