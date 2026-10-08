/** The grammars `highlight.ts` loads on first use. Each import here adds to that chunk, so add sparingly. */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { HLJSApi } from 'highlight.js';

export function highlighter(): HLJSApi {
  const grammars = { bash, css, go, ini, javascript, json, markdown, python, rust, sql, typescript, xml, yaml };
  for (const [name, g] of Object.entries(grammars)) if (hljs.getLanguage(name) === undefined) hljs.registerLanguage(name, g);
  return hljs;
}
