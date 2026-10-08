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
 *
 * Full path: /Users/rajeshtaylor/Documents/refueler-mcp/src/index.js
 * NOT refueler-share/worker/src/index.js — different repo entirely.
 *
 * The three tool modules return three different shapes (a full MCP result, a
 * content array, or a plain object). toResult() below normalises them, so a
 * handler can keep whichever shape its own tests pin.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createApiClient } from './api.js';
import { loadConfig } from './config.js';

// ── Tool definitions + handlers ──────────────────────────────────────────────

import { capabilitiesTool,  handleCapabilities }   from './tools/capabilities.js';
import { quoteTool,         refuelerQuote }        from './tools/quote.js';
import { balanceTool,       refuelerBalance }      from './tools/balance.js';
import { sendFileTool,      handleSendFile }       from './tools/send.js';
import { CHECK_TOOL_DEFINITION, handleCheckTransfer } from './tools/check.js';

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS = [
  capabilitiesTool,
  quoteTool,
  balanceTool,
  sendFileTool,
  CHECK_TOOL_DEFINITION,
].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

// ── Config + client ───────────────────────────────────────────────────────────
// loadConfig throws with a plain message when a credential is missing, which is
// the right failure: the server must not start half-authenticated.

const config = loadConfig();
const api    = createApiClient(config);

/** Deps object every handler receives. `api` is the name quote/balance/send use. */
const deps = { api, apiClient: api, config };

// ── Server bootstrap ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'refueler-mcp', version: '0.5.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/** Normalise a handler's return value into an MCP tool result. */
function toResult(value) {
  if (Array.isArray(value))                  return { content: value };
  if (value && Array.isArray(value.content)) return value;
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'refueler_capabilities':
      return toResult(await handleCapabilities(args, api));

    case 'refueler_quote':
      return toResult(await refuelerQuote(args, deps));

    case 'refueler_balance':
      return toResult(await refuelerBalance(args, deps));

    case 'refueler_send_file':
      return toResult(await handleSendFile(args, deps));

    case 'refueler_check_transfer':
      return toResult(await handleCheckTransfer(args, api));

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
