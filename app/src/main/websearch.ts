/**
 * Web search with Jev, and no browser.
 *
 * Search results and pages come over plain HTTP. Jev makes the two calls a person makes when they
 * search: which results are worth opening, then which lines of those pages answer the question.
 * It is the line-search recipe from TypeSafe's cookbook (https://docs.typesafe.ai/cookbooks/semantic_find.md):
 * every passage gets an id, one Choice question ranks the ids, and a Noul question in the same
 * request says whether the pages answer at all, since a Choice always ranks something first.
 *
 * Jev picks and does not write, so what comes back is the pages' own words with their links. The
 * agent or the flow step after it writes the answer.
 */

import { askJev, type JevFetch, type JevQuestion } from './jev.ts';
import type { Settings } from '../shared/types.ts';

export interface Hit {
  title: string;
  url: string;
  snippet: string;
}

export interface Passage {
  id: string;
  source: number;
  text: string;
  /** A search snippet's own page; passages read from a page take the page's. */
  url?: string;
  /** Jev's probability that this passage is the one that answers. */
  p: number;
}

export interface PageRead {
  url: string;
  title: string;
  ok: boolean;
  error?: string;
}

export interface WebAnswer {
  question: string;
  query?: string;
  engine?: string;
  hits: Hit[];
  pages: PageRead[];
  /** The passages Jev picked, most likely first. */
  passages: Passage[];
  /** Jev's probability that the pages answer the question. */
  answered: number;
  jevMs: number;
  inputTokens: number;
  model: string;
}

type Fetch = typeof fetch;

export interface WebDeps {
  jev: Settings['typesafe'];
  /** Brave's Search API, asked before the public results pages when set. */
  braveKey?: string;
  fetch?: Fetch;
  jevFetch?: JevFetch;
  signal?: AbortSignal;
  /** Called as each stage finishes, for a log a person can follow. */
  onProgress?: (line: string) => void;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MAX_HITS = 10;
const PAGES = 3;
const PAGE_TIMEOUT_MS = 10_000;
const MAX_BODY = 3_000_000;
/** A Choice takes at most 255 options; the rest of the room is for the question and the ids. */
const MAX_PASSAGES = 240;
/** Jev reads 32k tokens of state; about 4 characters a token, with room left over. */
const MAX_CHARS = 80_000;
const PASSAGE_CHARS = 500;
const PICKED = 6;

// ------------------------------------------------------------------------------------------------
// Text
// ------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: '(c)' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** A page's readable lines: the main content when the page marks it, without scripts, menus and footers. */
export function pageLines(html: string): { title: string; lines: string[] } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  let body = html.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ');
  // The page's own main content, when it says where that is. The largest wins: some pages mark a
  // small <article> per card.
  const mains = [...body.matchAll(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]!).sort((a, b) => b.length - a.length);
  if (mains[0] !== undefined && stripTags(mains[0]).length > 400) body = mains[0];
  body = body.replace(/<(nav|footer|header|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ');
  body = body.replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _h, t: string) => `\n# ${stripTags(t)}\n`);
  body = body.replace(/<\/?(p|div|li|tr|td|th|pre|blockquote|section|article|main|br|dd|dt|table|ul|ol|dl|figcaption|summary|details)\b[^>]*>/gi, '\n');
  const lines: string[] = [];
  for (const raw of decodeEntities(body.replace(/<[^>]*>/g, ' ')).split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < 3 || line === '#') continue;
    lines.push(line);
  }
  return { title, lines };
}

/** Lines as passages: short lines stay whole, long ones are cut at a sentence near the limit. */
export function passagesOf(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let rest = line;
    while (rest.length > PASSAGE_CHARS) {
      const cut = rest.slice(0, PASSAGE_CHARS);
      const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
      const at = stop > PASSAGE_CHARS * 0.4 ? stop + 1 : cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : PASSAGE_CHARS;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest !== '') out.push(rest);
  }
  // A lone word or a menu item says nothing a question can hang on; headings stay for context.
  return out.filter((p) => p.startsWith('# ') || p.length >= 20 || /\d/.test(p));
}

// ------------------------------------------------------------------------------------------------
// Search engines
// ------------------------------------------------------------------------------------------------

/** DuckDuckGo's HTML results page, which needs no script. Ads are left out. */
export function parseDuckDuckGo(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const block of html.split(/<div class="result results_links/).slice(1)) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (a === null) continue;
    let url = decodeEntities(a[1]!);
    const uddg = /[?&]uddg=([^&]+)/.exec(url)?.[1];
    if (uddg !== undefined) url = decodeURIComponent(uddg);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1];
    hits.push({ title: stripTags(a[2]!), url, snippet: snippet === undefined ? '' : stripTags(snippet) });
  }
  return hits;
}

/** Bing's results page. Its links go through a redirect that carries the real URL in base64. */
export function parseBing(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const a = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (a === null) continue;
    let url = decodeEntities(a[1]!);
    const u = /[?&]u=a1([^&]+)/.exec(url)?.[1];
    if (u !== undefined) {
      try {
        url = Buffer.from(u.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      } catch {
        /* keep the redirect */
      }
    }
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? /class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/.exec(block)?.[1];
    hits.push({ title: stripTags(a[2]!), url, snippet: snippet === undefined ? '' : stripTags(snippet) });
  }
  return hits;
}

/** Brave's results page, rendered on the server. */
export function parseBrave(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const block of html.split('data-type="web"').slice(1)) {
    const href = /<a[^>]*href="(https?:\/\/[^"]+)"/.exec(block)?.[1];
    if (href === undefined) continue;
    const title = /class="title[^"]*"[^>]*title="([^"]*)"/.exec(block)?.[1] ?? /class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '';
    const snippet = /class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '';
    hits.push({ title: stripTags(title), url: decodeEntities(href), snippet: stripTags(snippet) });
  }
  return hits;
}

/**
 * Tried in order. DuckDuckGo answers a program best until it decides there are too many
 * questions and sends a challenge instead; Brave is next. Bing last: without cookies it often
 * answers with unrelated articles.
 */
const ENGINES: { name: string; url: (q: string) => string; parse: (html: string) => Hit[] }[] = [
  { name: 'DuckDuckGo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGo },
  { name: 'Brave', url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`, parse: parseBrave },
  { name: 'Bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-US`, parse: parseBing },
];

/** Brave's Search API: JSON, with a key, and never a challenge. */
export function parseBraveApi(json: string): Hit[] {
  const parsed = JSON.parse(json) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return (parsed.web?.results ?? []).flatMap((r) => (typeof r.url === 'string' ? [{ title: stripTags(r.title ?? ''), url: r.url, snippet: stripTags(r.description ?? '') }] : []));
}

/** Fewer results than this looks like an engine brushing a program off. */
const ENOUGH_HITS = 3;
/** An engine that refused is left alone this long, rather than asked and refused on every search. */
const COOLDOWN_MS = 10 * 60_000;
const refusedUntil = new Map<string, number>();

async function get(url: string, deps: WebDeps, timeoutMs = PAGE_TIMEOUT_MS, extra: Record<string, string> = {}): Promise<{ body: string; type: string; url: string }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = deps.signal === undefined ? timeout : AbortSignal.any([deps.signal, timeout]);
  const res = await (deps.fetch ?? fetch)(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'Accept-Language': 'en', ...extra }, signal, redirect: 'follow' });
  if (res.status === 429) throw new Error('429, too many searches');
  if (!res.ok) throw new Error(`${String(res.status)} ${res.statusText}`.trim());
  const type = res.headers.get('content-type') ?? '';
  if (!/text\/|json|xml/.test(type) && type !== '') throw new Error(`not a page (${type.split(';')[0] ?? type})`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw new Error('too large to read');
  const body = await res.text();
  return { body: body.slice(0, MAX_BODY), type, url: res.url === '' ? url : res.url };
}

export async function search(query: string, deps: WebDeps, now = Date.now()): Promise<{ engine: string; hits: Hit[] }> {
  const failures: string[] = [];
  const key = deps.braveKey?.trim() ?? '';
  const engines = [
    ...(key === ''
      ? []
      : [{ name: 'Brave Search API', url: (q: string) => `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${String(MAX_HITS)}`, parse: parseBraveApi, headers: { 'X-Subscription-Token': key, Accept: 'application/json' } }]),
    ...ENGINES.map((e) => ({ ...e, headers: {} })),
  ];
  const ready = engines.filter((e) => (refusedUntil.get(e.name) ?? 0) <= now);
  // If every engine is cooling down, ask them all anyway rather than not search.
  for (const engine of ready.length > 0 ? ready : engines) {
    try {
      const { body } = await get(engine.url(query), deps, PAGE_TIMEOUT_MS, engine.headers);
      const hits = engine.parse(body).filter((h) => /^https?:\/\//.test(h.url));
      if (hits.length >= ENOUGH_HITS) {
        refusedUntil.delete(engine.name);
        return { engine: engine.name, hits: hits.slice(0, MAX_HITS) };
      }
      refusedUntil.set(engine.name, now + COOLDOWN_MS);
      // One or two results is what an engine gives a program it has decided to brush off: Bing
      // answered a World Cup question with a page on a 19th-century neurologist.
      failures.push(`${engine.name} returned ${hits.length === 0 ? 'no results' : `only ${String(hits.length)}`}`);
    } catch (err) {
      if (deps.signal?.aborted === true) throw err;
      refusedUntil.set(engine.name, now + COOLDOWN_MS);
      failures.push(`${engine.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Every search engine turned the search away (${failures.join('; ')}). ${SEARCH_REFUSED}`);
}

/** The tail of the error when every engine refused; agents and the app look for it. */
export const SEARCH_REFUSED = 'Too many searches in a row, most likely. A Brave Search API key in Settings under Jev avoids this.';

/** For tests: forget which engines refused. */
export function resetEngines(): void {
  refusedUntil.clear();
}

// ------------------------------------------------------------------------------------------------
// Reading pages
// ------------------------------------------------------------------------------------------------

/**
 * Only public web pages. An agent that may not run commands could otherwise ask for
 * http://localhost:… and read what a local server says.
 */
export function publicUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return null;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return null;
  if (h.includes(':') && (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h === '::')) return null;
  return u;
}

async function readPage(url: string, deps: WebDeps): Promise<{ title: string; passages: string[]; url: string }> {
  const target = publicUrl(url);
  if (target === null) throw new Error('only public http and https pages can be read');
  const page = await get(target.href, deps);
  if (/json|text\/plain/.test(page.type)) {
    let text = page.body;
    if (/json/.test(page.type)) {
      try {
        text = JSON.stringify(JSON.parse(page.body), null, 1);
      } catch {
        /* read it as it came */
      }
    }
    return { title: target.hostname + target.pathname, passages: passagesOf(text.split('\n').map((l) => l.trim()).filter((l) => l !== '')), url: page.url };
  }
  const { title, lines } = pageLines(page.body);
  return { title: title || target.hostname, passages: passagesOf(lines), url: page.url };
}

// ------------------------------------------------------------------------------------------------
// Jev
// ------------------------------------------------------------------------------------------------

const ranked = (probs: Record<string, number> | undefined) => Object.entries(probs ?? {}).sort((a, b) => b[1] - a[1]);

/** Jev picks which results to open. */
async function pickResults(question: string, hits: Hit[], deps: WebDeps): Promise<{ order: number[]; ms: number; tokens: number; model: string }> {
  const state = { question, results: hits.map((h, i) => ({ id: `R${String(i + 1)}`, title: h.title, url: h.url, snippet: h.snippet })) };
  const questions: Record<string, JevQuestion> = {
    open: {
      type: 'choice',
      instructions:
        'Which search result should be opened to answer `question`? Prefer the page most likely to state the answer directly: the ' +
        "primary source, such as official documentation, the project's own site, a package registry or the original publisher, over forums, " +
        'aggregators and pages written to rank in search.',
      criteria: Object.fromEntries(state.results.map((r) => [r.id, null])),
    },
  };
  const res = await askJev(deps.jev, state, questions, deps.signal, deps.jevFetch);
  const order = ranked(res.answers['open']?.probabilities)
    .filter(([, p], i) => i === 0 || p >= 0.03)
    .map(([id]) => Number(id.slice(1)) - 1)
    .filter((i) => i >= 0 && i < hits.length);
  // Anything Jev left out still follows, in the engine's order, in case the picks cannot be read.
  for (let i = 0; i < hits.length; i++) if (!order.includes(i)) order.push(i);
  return { order, ms: res.latencyMs, tokens: res.inputTokens, model: res.model };
}

/** Jev picks the passages that answer, and says whether they do. */
async function pickPassages(
  question: string,
  sources: { title: string; url: string; passages: string[] }[],
  deps: WebDeps,
  snippets: Hit[] = [],
): Promise<{ passages: Passage[]; answered: number; ms: number; tokens: number; model: string }> {
  const all: Passage[] = [];
  const seen = new Set<string>();
  const add = (source: number, text: string, url?: string) => {
    // Pages repeat themselves: a menu, a code sample shown twice. One copy is enough.
    if (seen.has(text)) return;
    seen.add(text);
    all.push({ id: `P${String(all.length + 1).padStart(3, '0')}`, source, text, p: 0, ...(url === undefined ? {} : { url }) });
  };
  // The engine's snippets come first and are short. A site that refuses a program, as npmjs.com
  // does, often has the answer in its snippet.
  for (const h of snippets) if (h.snippet !== '') add(-1, `${h.title}: ${h.snippet}`, h.url);
  // Every page gets a fair share of the room, in the order they were ranked.
  const share = Math.floor(MAX_CHARS / Math.max(1, sources.length));
  sources.forEach((s, si) => {
    let used = 0;
    for (const text of s.passages) {
      if (all.length >= MAX_PASSAGES || used + text.length > share) break;
      used += text.length;
      add(si, text);
    }
  });
  if (all.length === 0) return { passages: [], answered: 0, ms: 0, tokens: 0, model: deps.jev.model };
  const state = {
    question,
    sources: [...(snippets.length > 0 ? [{ source: 'S0', title: 'Search result snippets', url: '' }] : []), ...sources.map((s, i) => ({ source: `S${String(i + 1)}`, title: s.title, url: s.url }))],
    passages: all.map((p) => `${p.id} [S${String(p.source + 1)}]| ${p.text}`).join('\n'),
  };
  const questions: Record<string, JevQuestion> = {
    where: {
      type: 'choice',
      instructions: 'Which passage in `passages` best answers `question`? Each line starts with its id and the source it came from.',
      criteria: Object.fromEntries(all.map((p) => [p.id, null])),
    },
    answered: {
      type: 'noul',
      instructions: 'Do `passages`, taken together, contain the answer to `question`?',
      criteria: { true: 'The passages state the answer, or enough to work it out.', false: 'The passages are about the topic but do not give the answer, or are about something else.' },
    },
  };
  const res = await askJev(deps.jev, state, questions, deps.signal, deps.jevFetch);
  const byId = new Map(all.map((p) => [p.id, p]));
  const picked: Passage[] = [];
  for (const [id, p] of ranked(res.answers['where']?.probabilities)) {
    if (picked.length >= PICKED || (picked.length > 0 && p < 0.04)) break;
    const hit = byId.get(id);
    if (hit !== undefined) picked.push({ ...hit, p });
  }
  // The heading just before a picked passage says what the passage is about.
  const withContext: Passage[] = [];
  for (const p of picked) {
    const i = all.findIndex((x) => x.id === p.id);
    const prev = all[i - 1];
    if (prev !== undefined && prev.source === p.source && prev.text.startsWith('# ') && !picked.some((x) => x.id === prev.id) && !withContext.some((x) => x.id === prev.id)) {
      withContext.push({ ...prev, p: 0 });
    }
    withContext.push(p);
  }
  return { passages: withContext, answered: res.answers['answered']?.noul ?? 0, ms: res.latencyMs, tokens: res.inputTokens, model: res.model };
}

// ------------------------------------------------------------------------------------------------
// The two things an agent can ask for
// ------------------------------------------------------------------------------------------------

/** Search the web and answer from the pages Jev picks. */
export async function webSearch(query: string, question: string, deps: WebDeps): Promise<WebAnswer> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 300);
  const { engine, hits } = await search(q, deps);
  deps.onProgress?.(`Searched ${engine} for "${q}": ${String(hits.length)} results.`);
  const pick = await pickResults(question, hits, deps);
  deps.onProgress?.(`Jev picked ${pick.order.slice(0, PAGES).map((i) => hostOf(hits[i]!.url)).join(', ')} to open.`);
  const pages: PageRead[] = [];
  const sources: { title: string; url: string; passages: string[] }[] = [];
  // Open the picks together; if one cannot be read, the next result in Jev's order takes its place.
  let next = 0;
  while (sources.length < PAGES && next < pick.order.length) {
    const batch = pick.order.slice(next, next + (PAGES - sources.length));
    next += batch.length;
    const reads = await Promise.all(
      batch.map(async (i) => {
        const hit = hits[i]!;
        try {
          const page = await readPage(hit.url, deps);
          if (page.passages.length === 0) throw new Error('no readable text');
          pages.push({ url: page.url, title: page.title || hit.title, ok: true });
          return { title: page.title || hit.title, url: page.url, passages: page.passages };
        } catch (err) {
          if (deps.signal?.aborted === true) throw err;
          pages.push({ url: hit.url, title: hit.title, ok: false, error: err instanceof Error ? err.message : String(err) });
          return null;
        }
      }),
    );
    for (const r of reads) if (r !== null) sources.push(r);
  }
  deps.onProgress?.(`Read ${pages.filter((p) => p.ok).map((p) => hostOf(p.url)).join(', ') || 'no pages'}${pages.some((p) => !p.ok) ? `; could not read ${pages.filter((p) => !p.ok).map((p) => `${hostOf(p.url)} (${p.error ?? 'failed'})`).join(', ')}` : ''}.`);
  const found = await pickPassages(question, sources, deps, hits);
  deps.onProgress?.(`Jev picked ${String(found.passages.filter((p) => p.p > 0).length)} passages and is ${pct(found.answered)} sure they answer it.`);
  return {
    question,
    query: q,
    engine,
    hits,
    pages: sources.map((s) => ({ url: s.url, title: s.title, ok: true })).concat(pages.filter((p) => !p.ok)),
    passages: found.passages,
    answered: found.answered,
    jevMs: pick.ms + found.ms,
    inputTokens: pick.tokens + found.tokens,
    model: found.model,
  };
}

/** Read one page and answer from it. */
export async function webRead(url: string, question: string, deps: WebDeps): Promise<WebAnswer> {
  const page = await readPage(url, deps);
  deps.onProgress?.(`Read ${hostOf(page.url)}: ${String(page.passages.length)} passages.`);
  const found = await pickPassages(question, [page], deps);
  return {
    question,
    hits: [],
    pages: [{ url: page.url, title: page.title, ok: true }],
    passages: found.passages,
    answered: found.answered,
    jevMs: found.ms,
    inputTokens: found.tokens,
    model: found.model,
  };
}

const pct = (p: number) => `${String(Math.round(p * 100))}%`;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The result as Markdown: what Jev is sure of, the pages' own words with links, and what else came up. */
export function formatAnswer(a: WebAnswer): string {
  const read = a.pages.filter((p) => p.ok);
  const lines: string[] = [];
  const how = a.query === undefined ? `Jev read ${read[0]?.url ?? 'the page'}` : `Searched ${a.engine ?? 'the web'} for "${a.query}". Jev read ${String(read.length)} ${read.length === 1 ? 'page' : 'pages'}`;
  lines.push(
    a.answered >= 0.5
      ? `${how} and is ${pct(a.answered)} sure the passages below answer it.`
      : `${how} and is only ${pct(a.answered)} sure they answer it. These are the closest passages; a different search may do better.`,
  );
  const bySource = new Map<number, Passage[]>();
  for (const p of a.passages) bySource.set(p.source, [...(bySource.get(p.source) ?? []), p]);
  // Sources in the order of their best passage.
  const order = [...bySource.entries()].sort((x, y) => Math.max(...y[1].map((p) => p.p)) - Math.max(...x[1].map((p) => p.p)));
  for (const [source, ps] of order) {
    const page = read[source];
    lines.push('', page === undefined ? 'From the search results:' : `From [${page.title.replace(/[[\]]/g, '')}](${page.url}):`);
    for (const p of ps.sort((x, y) => Number(x.id.slice(1)) - Number(y.id.slice(1)))) {
      lines.push(`> ${p.text.replace(/^# /, '')}${p.url === undefined ? '' : ` (${p.url})`}`, '>');
    }
    lines.pop();
  }
  const quoted = new Set(a.passages.map((p) => p.url));
  const others = a.hits.filter((h) => !read.some((p) => p.url === h.url) && !quoted.has(h.url)).slice(0, 5);
  if (others.length > 0) {
    lines.push('', 'Other results:');
    for (const h of others) lines.push(`- [${h.title.replace(/[[\]]/g, '')}](${h.url})${h.snippet === '' ? '' : `: ${h.snippet.slice(0, 200)}`}`);
  }
  const failed = a.pages.filter((p) => !p.ok);
  if (failed.length > 0) lines.push('', `Could not read: ${failed.map((p) => `${p.url} (${p.error ?? 'failed'})`).join(', ')}.`);
  return lines.join('\n');
}
