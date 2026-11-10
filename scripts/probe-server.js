#!/usr/bin/env node
/**
 * scripts/probe-server.js — measures what an MCP client does (MCP-Install-1)
 *
 * Not shipped: scripts/ is outside package.json "files". No keys, no network.
 * Every event goes to PROBE_LOG (default ~/.refueler/probe.log), one JSON line each,
 * with the client's name, so the log answers the questions, not the model.
 *
 * Tools:
 *   probe_hello   — client name/version and its declared capabilities
 *   probe_sleep   — waits `seconds`, sending progress every 5 s if asked; the log
 *                   shows whether the call finished, or was cancelled and when
 *   probe_roots   — calls roots/list and returns what came back
 *   probe_dialog  — elicitation (form mode) whose message holds a canary word. The
 *                   tool result never contains it: if the model can repeat it, the
 *                   dialog text reached the model.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const LOG = process.env.PROBE_LOG || path.join(os.homedir(), '.refueler', 'probe.log');
mkdirSync(path.dirname(LOG), { recursive: true, mode: 0o700 });
const t0 = Date.now();

const server = new Server({ name: 'refueler-probe', version: '0.0.1' }, { capabilities: { tools: {} } });

function log(event, extra = {}) {
  const client = server.getClientVersion?.();
  appendFileSync(LOG, JSON.stringify({
    at: new Date().toISOString(), up_s: Math.round((Date.now() - t0) / 1000),
    client: client ? `${client.name} ${client.version}` : null, event, ...extra,
  }) + '\n');
}

const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

const TOOLS = [
  { name: 'probe_hello', description: 'Report the client and its capabilities.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'probe_sleep',
    description: 'Wait the given number of seconds, then answer. Measures the client time limit.',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'integer' }, progress: { type: 'boolean', description: 'Send progress every 5 s.' } },
      required: ['seconds'],
    },
  },
  { name: 'probe_roots', description: 'List the folders the client offers.', inputSchema: { type: 'object', properties: {} } },
  { name: 'probe_dialog', description: 'Show the user a test dialog and report the button pressed.', inputSchema: { type: 'object', properties: {} } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args = {} } = req.params;
  log('call', { tool: name, args });

  if (name === 'probe_hello') {
    const v = { client: server.getClientVersion(), capabilities: server.getClientCapabilities() };
    log('hello', v);
    return text(v);
  }

  if (name === 'probe_sleep') {
    const start = Date.now();
    const token = req.params._meta?.progressToken;
    let cancelled = false;
    extra.signal.addEventListener('abort', () => {
      cancelled = true;
      log('cancelled', { tool: name, after_s: (Date.now() - start) / 1000 });
    });
    const total = Number(args.seconds) || 0;
    for (let s = 0; s < total && !cancelled; s++) {
      await new Promise(r => setTimeout(r, 1000));
      if (args.progress && token !== undefined && s % 5 === 4) {
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: s + 1, total } }).catch(() => {});
      }
    }
    log(cancelled ? 'sleep_cut' : 'sleep_done', { seconds: total, elapsed_s: (Date.now() - start) / 1000, progress_token: token ?? null });
    return text({ slept_s: (Date.now() - start) / 1000 });
  }

  if (name === 'probe_roots') {
    if (!server.getClientCapabilities()?.roots) { log('roots', { supported: false }); return text({ roots: 'not offered' }); }
    try {
      const { roots } = await server.listRoots(undefined, { timeout: 10_000 });
      log('roots', { supported: true, roots });
      return text({ roots });
    } catch (e) {
      log('roots', { supported: true, error: String(e?.message ?? e) });
      return text({ roots: 'error' });
    }
  }

  if (name === 'probe_dialog') {
    if (!server.getClientCapabilities()?.elicitation) { log('dialog', { supported: false }); return text({ dialog: 'not offered' }); }
    try {
      const r = await server.elicitInput({
        message: 'Refueler probe. The test word is HEMLOCK-7. Press Accept.',
        requestedSchema: { type: 'object', properties: { ok: { type: 'boolean', title: 'Looks fine' } } },
      }, { timeout: 120_000 });
      log('dialog', { supported: true, action: r.action });
      return text({ action: r.action });
    } catch (e) {
      log('dialog', { supported: true, error: String(e?.message ?? e) });
      return text({ dialog: 'error' });
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

server.oninitialized = () => log('initialized', { capabilities: server.getClientCapabilities() });
process.on('SIGTERM', () => { log('sigterm'); process.exit(0); });
process.stdin.on('end', () => { log('stdin_end'); process.exit(0); });

await server.connect(new StdioServerTransport());
log('start', { pid: process.pid });
