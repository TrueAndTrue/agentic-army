/**
 * The tools a chat agent uses to start flows, served over MCP.
 *
 * claude and codex start MCP servers themselves, as child processes speaking JSON-RPC on stdio. So
 * the server is a small script the app writes to disk, run by the app's own binary with
 * ELECTRON_RUN_AS_NODE=1 (a packaged app has no guarantee of a `node` on PATH). The script holds no
 * logic: it forwards each call over HTTP to the app on 127.0.0.1, where the controller decides.
 *
 * Every chat turn gets its own key. The app answers only calls that carry a live key, learns the
 * session and the model from it, and forgets it when the turn ends, so a key read out of a
 * process's environment afterwards starts nothing.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import type { McpServerSpec } from '../../../src/contracts/harness.ts';

export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCaller {
  sessionId: string;
  /** The model's label, for the thread: "Sonnet 5". */
  model: string;
}

export interface ToolHandler {
  list(caller: ToolCaller): ToolDescription[];
  call(caller: ToolCaller, name: string, args: Record<string, unknown>): { text: string; isError?: boolean };
}

/** The MCP server, as the script the harness starts. CommonJS with no imports beyond Node's own. */
export const MCP_SCRIPT = String.raw`'use strict';
// Written by Agentic Army. Forwards MCP tool calls to the app; see src/main/flowTools.ts.
const url = process.env.ARMY_FLOW_URL;
const token = process.env.ARMY_FLOW_TOKEN;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
async function app(body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(text || 'The app answered ' + r.status + '.');
  return JSON.parse(text);
}
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agentic-army', version: '1.0.0' } } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: (await app({ op: 'list' })).tools } });
    if (method === 'tools/call') {
      const r = await app({ op: 'call', name: params && params.name, args: (params && params.arguments) || {} });
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError === true } });
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method ' + method } });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } });
    else send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
  }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === '') continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    void handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

export interface FlowBridge {
  /** A key for one chat turn, and the MCP server spec that carries it. */
  open(caller: ToolCaller): { spec: McpServerSpec; close(): void };
  stop(): void;
}

export async function startFlowBridge(root: string, handler: ToolHandler, runtime = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } as Record<string, string> }): Promise<FlowBridge> {
  const dir = join(root, 'mcp');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'army-flows.cjs');
  writeFileSync(script, MCP_SCRIPT, { mode: 0o600 });

  const keys = new Map<string, ToolCaller>();
  const server: Server = createServer((req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const caller = key === undefined ? undefined : keys.get(key);
    if (req.method !== 'POST' || caller === undefined) {
      res.writeHead(401).end('This key is not live. Flows can be started only during the chat turn that was given the tool.');
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => {
      body += d;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let msg: { op?: unknown; name?: unknown; args?: unknown };
      try {
        msg = JSON.parse(body) as typeof msg;
      } catch {
        return reply(400, { text: 'Not JSON.', isError: true });
      }
      try {
        if (msg.op === 'list') return reply(200, { tools: handler.list(caller) });
        if (msg.op === 'call' && typeof msg.name === 'string') {
          const args = msg.args !== null && typeof msg.args === 'object' ? (msg.args as Record<string, unknown>) : {};
          return reply(200, handler.call(caller, msg.name, args));
        }
        reply(400, { text: 'Unknown request.', isError: true });
      } catch (err) {
        reply(200, { text: err instanceof Error ? err.message : String(err), isError: true });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    open(caller) {
      const key = randomBytes(24).toString('hex');
      keys.set(key, caller);
      return {
        spec: {
          name: 'army',
          command: runtime.command,
          args: [script],
          env: { ...runtime.env, ARMY_FLOW_URL: `http://127.0.0.1:${port}/tools`, ARMY_FLOW_TOKEN: key },
        },
        close: () => keys.delete(key),
      };
    },
    stop() {
      keys.clear();
      server.close();
    },
  };
}
