import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatAnswer, pageLines, parseBing, parseBrave, parseDuckDuckGo, passagesOf, publicUrl, resetEngines, search, SEARCH_REFUSED, webSearch } from '../src/main/websearch.ts';

const DDG = `
<div class="result results_links results_links_deep result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Buy zod</a></div>
<div class="result results_links results_links_deep web-result">
  <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2Fzod&amp;rut=abc">zod - <b>npm</b></a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Latest version: 4.6.5, last published: 10 days ago &amp; more.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fzod.dev%2F&amp;rut=def">Zod docs</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=y">TypeScript-first schema validation.</a>
</div>`;

const DDG3 = `${DDG}
<div class="result results_links results_links_deep web-result">
  <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fcolinhacks%2Fzod&amp;rut=g">colinhacks/zod</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=z">Source code.</a>
</div>`;

describe('search result pages', () => {
  test('DuckDuckGo: real URLs out of its redirects, snippets as text, ads left out', () => {
    assert.deepEqual(parseDuckDuckGo(DDG), [
      { title: 'zod - npm', url: 'https://www.npmjs.com/package/zod', snippet: 'Latest version: 4.6.5, last published: 10 days ago & more.' },
      { title: 'Zod docs', url: 'https://zod.dev/', snippet: 'TypeScript-first schema validation.' },
    ]);
  });

  test("Bing: the real URL comes out of its base64 redirect", () => {
    const u = Buffer.from('https://www.npmjs.com/package/zod').toString('base64url');
    const html = `<li class="b_algo" data-id><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1${u}&amp;ntb=1">zod - npm</a></h2><div class="b_caption"><p>Latest version: 4.6.5</p></div></li>`;
    assert.deepEqual(parseBing(html), [{ title: 'zod - npm', url: 'https://www.npmjs.com/package/zod', snippet: 'Latest version: 4.6.5' }]);
  });

  test('Brave: the link, the title attribute and the description', () => {
    const html = `<div class="snippet svelte-x" data-pos="0" data-type="web"><a href="https://en.wikipedia.org/wiki/2022_FIFA_World_Cup_final" class="l1"><div class="title search-snippet-title svelte-y" title="2022 FIFA World Cup final - Wikipedia">2022 FIFA World Cup final</div></a><div class="generic-snippet"><div class="content desktop-default-regular t-primary"> Argentina beat France 4-2 on <strong>penalties</strong>.</div></div></div>`;
    assert.deepEqual(parseBrave(html), [{ title: '2022 FIFA World Cup final - Wikipedia', url: 'https://en.wikipedia.org/wiki/2022_FIFA_World_Cup_final', snippet: 'Argentina beat France 4-2 on penalties.' }]);
  });

  test('an engine that brushes a program off is passed over, and left alone for ten minutes', async () => {
    resetEngines();
    const asked: string[] = [];
    const fetchFake = (async (url: string) => {
      asked.push(new URL(url).hostname);
      // DuckDuckGo's challenge is a 202 with no results; Bing gives one unrelated page.
      if (url.includes('duckduckgo')) return new Response('<html>challenge</html>', { status: 202 });
      if (url.includes('bing')) return new Response('<li class="b_algo"><h2><a href="https://litfl.com/x">A neurologist</a></h2></li>', { status: 200 });
      return new Response('', { status: 429 });
    }) as typeof fetch;
    await assert.rejects(search('world cup', { jev: { apiKey: 'k', model: 'm', baseUrl: 'https://x' }, fetch: fetchFake }, 1000), (err: Error) => {
      assert.ok(err.message.includes(SEARCH_REFUSED));
      assert.match(err.message, /DuckDuckGo returned no results; Brave: 429, too many searches; Bing returned only 1/);
      return true;
    });
    asked.length = 0;
    const fine = (async () => new Response(DDG3, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const counting = (async (url: string) => {
      asked.push(new URL(url).hostname);
      return fine(url);
    }) as typeof fetch;
    // Five minutes on, all three are cooling down, so all three are asked again.
    const r = await search('world cup', { jev: { apiKey: 'k', model: 'm', baseUrl: 'https://x' }, fetch: counting }, 1000 + 5 * 60_000);
    assert.equal(r.engine, 'DuckDuckGo');
    assert.equal(r.hits.length, 3);
    resetEngines();
  });
});

describe('reading a page', () => {
  test('keeps the main content and headings, drops scripts, menus and footers', () => {
    const html = `<html><head><title>Peanut butter</title><script>var x = "Buy now";</script></head><body>
      <nav><a href="/">Home</a><a href="/r">Recipes of the day and more</a></nav>
      <main><h2>Instructions</h2><p>Roast the peanuts at 350&deg;F for about 10 minutes, until golden.</p>
      <p>Blend for five minutes, scraping down the sides.</p>${'<p>More text about peanuts and blending and salt.</p>'.repeat(10)}</main>
      <footer>Copyright 2026 Recipes Inc, all rights reserved</footer></body></html>`;
    const { title, lines } = pageLines(html);
    assert.equal(title, 'Peanut butter');
    assert.equal(lines[0], '# Instructions');
    assert.ok(lines.includes('Blend for five minutes, scraping down the sides.'));
    assert.ok(!lines.some((l) => /Buy now|Recipes of the day|Copyright/.test(l)), lines.join('\n'));
  });

  test('long lines are cut at a sentence; lone words go, headings and numbers stay', () => {
    const long = `${'This sentence is here to make the line long. '.repeat(20)}End.`;
    const out = passagesOf([long, 'Menu', '# Usage', 'v4.6.5']);
    assert.ok(out.filter((p) => p.startsWith('This')).every((p) => p.length <= 500 && p.endsWith('.')));
    assert.deepEqual(out.slice(-2), ['# Usage', 'v4.6.5']);
    assert.ok(!out.includes('Menu'));
  });

  test('only public pages: no localhost, private networks or other schemes', () => {
    for (const bad of ['http://localhost:3000', 'http://127.0.0.1/x', 'http://192.168.1.1', 'http://10.0.0.8', 'file:///etc/passwd', 'http://[::1]/', 'http://printer.local', 'http://intranet']) {
      assert.equal(publicUrl(bad), null, bad);
    }
    assert.equal(publicUrl('example.com/a')?.href, 'https://example.com/a');
  });
});

describe('a web search', () => {
  test('Jev picks the pages to open, then the passages; a refused page gives way to the next, and snippets count as evidence', async () => {
    const pages: Record<string, Response> = {
      'https://www.npmjs.com/package/zod': new Response('Forbidden', { status: 403 }),
      'https://zod.dev/': new Response('<title>Zod</title><main><h1>Zod</h1><p>Zod is a TypeScript-first validation library for schemas.</p><p>Install it with npm install zod.</p></main>', { headers: { 'content-type': 'text/html' } }),
    };
    const fetchFake = (async (url: string) => (url.includes('duckduckgo') ? new Response(DDG3, { headers: { 'content-type': 'text/html' } }) : (pages[url] ?? new Response('', { status: 404 })))) as typeof fetch;
    const asked: Record<string, unknown>[] = [];
    const jevFake = (async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { state: Record<string, unknown>; questions: Record<string, unknown> };
      asked.push(body.state);
      const answers =
        'open' in body.questions
          ? { open: { type: 'choice', choice: 'R1', probabilities: { R1: 0.7, R2: 0.3 }, confidence: 0.4 } }
          : { where: { type: 'choice', choice: 'P001', probabilities: { P001: 0.8, P005: 0.15, P006: 0.05 }, confidence: 0.6 }, answered: { type: 'noul', noul: 0.91 } };
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const progress: string[] = [];
    const a = await webSearch('zod latest version', 'What is the latest zod version?', {
      jev: { apiKey: 'k', model: 'jev-latest', baseUrl: 'https://x' },
      fetch: fetchFake,
      jevFetch: jevFake,
      onProgress: (l) => progress.push(l),
    });
    assert.equal(a.answered, 0.91);
    assert.deepEqual(
      a.pages.map((p) => [p.url, p.ok]),
      [
        ['https://zod.dev/', true],
        ['https://www.npmjs.com/package/zod', false],
        ['https://github.com/colinhacks/zod', false],
      ],
    );
    // P001 is the npm snippet, read even though the page refused; P005 is the page's first line under its heading, P004.
    const passages = String((asked[1] as { passages: string }).passages);
    assert.match(passages, /^P001 \[S0\]\| zod - npm: Latest version: 4\.6\.5/);
    const text = formatAnswer(a);
    assert.match(text, /91% sure/);
    assert.match(text, /From the search results:\n> zod - npm: Latest version: 4\.6\.5.*\(https:\/\/www\.npmjs\.com\/package\/zod\)/);
    assert.match(text, /From \[Zod\]\(https:\/\/zod\.dev\/\):\n> Zod\n>\n> Zod is a TypeScript-first/);
    assert.match(text, /Could not read: https:\/\/www\.npmjs\.com\/package\/zod \(403/);
    assert.equal(progress.length, 4);
  });
});
