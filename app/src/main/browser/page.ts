/**
 * The Electron side of computer use: a real Chromium window the pilot reads and drives.
 *
 * The window runs in its own session partition with no preload and no Node, so a page it visits
 * reaches nothing in the app. Reading the page and acting on it both go through
 * `executeJavaScript` and `sendInputEvent`, the way a person's clicks and keys would.
 */

import { BrowserWindow } from 'electron';

import type { Action, Page, PageSnapshot } from './pilot.ts';

const EXTRACT = `(() => {
  const seen = new Set();
  const out = [];
  let n = 0;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
    return r;
  };
  const label = (el) => {
    const t = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim();
    if (t) return t.slice(0, 120);
    const img = el.querySelector && el.querySelector('img[alt]');
    return img ? img.getAttribute('alt').slice(0, 120) : '';
  };
  const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=true], [onclick]';
  for (const el of document.querySelectorAll(sel)) {
    if (seen.has(el) || out.length >= 200) continue;
    seen.add(el);
    if (el.disabled) continue;
    const r = vis(el);
    if (!r) continue;
    const tag = el.tagName.toLowerCase();
    const kind = tag === 'a' || el.getAttribute('role') === 'link' ? 'link'
      : tag === 'button' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'menuitem' ? 'button'
      : tag === 'input' ? 'input' : tag === 'textarea' || el.isContentEditable ? 'textarea' : tag === 'select' ? 'select' : 'other';
    const text = label(el);
    if (!text && kind !== 'input' && kind !== 'textarea') continue;
    const id = 'e' + (n++);
    el.setAttribute('data-army-id', id);
    const rec = { id, tag, kind, text, inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth };
    if (tag === 'a') rec.href = el.href;
    if (tag === 'input') rec.inputType = (el.getAttribute('type') || 'text').toLowerCase();
    if (el.getAttribute('name')) rec.name = el.getAttribute('name');
    out.push(rec);
  }
  const text = (document.body ? document.body.innerText : '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 12000);
  return { url: location.href, title: document.title, text, elements: out };
})()`;

const center = (id: string) => `(() => {
  const el = document.querySelector('[data-army-id="${id}"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

function settle(win: BrowserWindow, ms = 8000): Promise<void> {
  return new Promise((resolve) => {
    const wc = win.webContents;
    const done = () => {
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', onStop);
      // Give scripts a moment to render after the load event.
      setTimeout(resolve, 600);
    };
    const onStop = () => done();
    const timer = setTimeout(done, ms);
    // A click that does not navigate never fires did-stop-loading; the short wait covers it.
    setTimeout(() => {
      if (!wc.isLoading()) done();
    }, 400);
    wc.on('did-stop-loading', onStop);
  });
}

export class ElectronPage implements Page {
  readonly win: BrowserWindow;

  constructor(show: boolean) {
    this.win = new BrowserWindow({
      width: 1200,
      height: 820,
      show,
      title: 'Agentic Army · browser',
      webPreferences: { partition: 'persist:army-browser', sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      // A new tab opens in this window instead, so the pilot never loses the page it is on.
      void this.win.loadURL(url);
      return { action: 'deny' };
    });
  }

  async open(url: string): Promise<void> {
    const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    await this.win.loadURL(target).catch(() => {});
    await settle(this.win);
  }

  async snapshot(): Promise<PageSnapshot> {
    const snap = (await this.win.webContents.executeJavaScript(EXTRACT, true)) as Omit<PageSnapshot, 'canGoBack'>;
    return { ...snap, canGoBack: this.win.webContents.navigationHistory.canGoBack() };
  }

  private async click(id: string): Promise<void> {
    const p = (await this.win.webContents.executeJavaScript(center(id), true)) as { x: number; y: number } | null;
    if (p === null) throw new Error('The element is gone from the page.');
    const wc = this.win.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }

  async perform(action: Action): Promise<void> {
    const wc = this.win.webContents;
    switch (action.kind) {
      case 'click':
        await this.click(action.elementId);
        break;
      case 'type': {
        await this.click(action.elementId);
        await wc.executeJavaScript(
          `(() => { const el = document.querySelector('[data-army-id="${action.elementId}"]'); if (el) { el.focus(); if (el.select) el.select(); } })()`,
          true,
        );
        await wc.insertText(action.text);
        if (action.submit) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          wc.sendInputEvent({ type: 'char', keyCode: '\r' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        }
        break;
      }
      case 'scroll':
        await wc.executeJavaScript('window.scrollBy(0, Math.round(innerHeight * 0.8))', true);
        break;
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      default:
        return;
    }
    await settle(this.win);
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}
