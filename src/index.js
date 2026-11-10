#!/usr/bin/env node
/**
 * refueler-mcp/src/index.js — MCP server entry point
 *
 * Tools registered:
 *   refueler_capabilities   — SW-MCP-1
 *   refueler_quote          — SW-MCP-3
 *   refueler_balance        — SW-MCP-3
 *   refueler_send_file      — SW-MCP-4, rebuilt for the direct-to-R2 path at MCP-Fix-1
 *   refueler_check_transfer — SW-MCP-5
 *   refueler_fetch          — MCP-Fetch-1 (free, keyless)
 *   refueler_fetch_status   — MCP-Fetch-1
 *   refueler_send_status    — MCP-Install-1 (send runs on the job runner)
 *
 * Full path: /Users/rajeshtaylor/Documents/refueler-mcp/src/index.js
 * NOT refueler-share/worker/src/index.js — different repo entirely.
 *
 * The tool modules return different shapes (a full MCP result, a content array,
 * or a plain object). toResult() below normalises them, so a handler can keep
 * whichever shape its own tests pin.
 */

import { readFileSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createApiClient } from './api.js';
import { loadConfig } from './config.js';
import { createJobRunner } from './jobs.js';

// ── Tool definitions + handlers ──────────────────────────────────────────────

import { capabilitiesTool,  handleCapabilities }   from './tools/capabilities.js';
import { quoteTool,         refuelerQuote }        from './tools/quote.js';
import { balanceTool,       refuelerBalance }      from './tools/balance.js';
import { sendFileTool }                           from './tools/send.js';
import { CHECK_TOOL_DEFINITION, handleCheckTransfer } from './tools/check.js';
import {
  fetchToolDefinition,
  fetchStatusToolDefinition,
  handleFetch,
  handleFetchStatus,
} from './tools/fetch.js';
import { sendStatusToolDefinition, handleSendJob, handleSendStatus } from './tools/send-job.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// ── Config + client ───────────────────────────────────────────────────────────
// loadConfig throws with a plain message on a half-set config. No keys at all is
// a working server: fetch is free, and the paid tools say what they need.

const config = loadConfig();
const api    = createApiClient(config);
const jobs   = createJobRunner();

/** Deps object every handler receives. `api` is the name quote/balance/send use. */
const deps = { api, apiClient: api, config };

// ── Tool registry ─────────────────────────────────────────────────────────────

/**
 * Tool annotations (MCP-Install-1). Hints for the client's UI, never a security
 * control. fetch is marked destructive: on a link that works once, it causes the
 * transfer's deletion. send spends credits, so it is not idempotent.
 */
const READ_REMOTE = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const READ_LOCAL  = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const ANNOTATIONS = {
  refueler_capabilities:   { title: 'Share capabilities', ...READ_REMOTE },
  refueler_quote:          { title: 'Quote a send', ...READ_REMOTE },
  refueler_balance:        { title: 'Credit balance', ...READ_REMOTE },
  refueler_send_file:      { title: 'Send a file', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  refueler_check_transfer: { title: 'Check a transfer', ...READ_REMOTE },
  refueler_fetch:          { title: 'Fetch a Share link', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  refueler_fetch_status:   { title: 'Fetch progress', ...READ_LOCAL },
  refueler_send_status:    { title: 'Send progress', ...READ_LOCAL },
};

const TOOLS = [
  capabilitiesTool,
  quoteTool,
  balanceTool,
  sendFileTool,
  CHECK_TOOL_DEFINITION,
  fetchToolDefinition(config),
  fetchStatusToolDefinition,
  sendStatusToolDefinition,
].map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: ANNOTATIONS[name] }));

/** Every one of these signs its requests. */
const NEEDS_API_KEYS = new Set([
  'refueler_quote',
  'refueler_balance',
  'refueler_send_file',
  'refueler_check_transfer',
]);

// ── Server bootstrap ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'refueler-mcp', version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/** Normalise a handler's return value into an MCP tool result. */
function toResult(value) {
  if (Array.isArray(value))                  return { content: value };
  if (value && Array.isArray(value.content)) return value;
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** The client's folders, or null if it has none to offer. */
async function clientRoots() {
  if (!server.getClientCapabilities()?.roots) return null;
  try {
    const { roots } = await server.listRoots(undefined, { timeout: 5000 });
    return roots.map(r => r.uri);
  } catch {
    return null;
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (NEEDS_API_KEYS.has(name) && !config.hasApiKeys) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'api_keys_required',
          detail: 'This tool needs REFUELER_LIVE_KEY and REFUELER_SIGN_KEY. refueler_fetch needs neither.',
        }),
      }],
      isError: true,
    };
  }

  switch (name) {
    case 'refueler_capabilities':
      return toResult(await handleCapabilities(args, api));

    case 'refueler_quote':
      return toResult(await refuelerQuote(args, deps));

    case 'refueler_balance':
      return toResult(await refuelerBalance(args, deps));

    case 'refueler_send_file':
      return handleSendJob(args, { ...deps, jobs });

    case 'refueler_check_transfer':
      return toResult(await handleCheckTransfer(args, api));

    case 'refueler_fetch':
      return handleFetch(args, { config, jobs, clientRoots });

    case 'refueler_fetch_status':
      return handleFetchStatus(args, { jobs });

    case 'refueler_send_status':
      return handleSendStatus(args, { jobs });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Stop ──────────────────────────────────────────────────────────────────────
// Jobs end with the process, and leave no part file behind. A client going away
// must not leave a fetch running with nobody to report to, least of all on a
// link that works once.

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await jobs.abortAll();
  process.exit(0);
}

process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
