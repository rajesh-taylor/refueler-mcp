/**
 * refueler-mcp/src/index.js — MCP server entry point
 *
 * Tools registered (SW-MCP-1 through SW-MCP-5):
 *   refueler_capabilities  — SW-MCP-1
 *   refueler_quote         — SW-MCP-3
 *   refueler_balance       — SW-MCP-3
 *   refueler_send_file     — SW-MCP-4
 *   refueler_check_transfer — SW-MCP-5
 *
 * Full path: /Users/rajeshtaylor/Documents/refueler-mcp/src/index.js
 * NOT refueler-share/worker/src/index.js — different repo entirely.
 */

'use strict';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { ApiClient } from './api-client.js';
import { signRequest } from './hmac.js';

// ── Tool definitions + handlers ──────────────────────────────────────────────

import {
  CAPABILITIES_TOOL_DEFINITION,
  handleCapabilities,
} from './tools/capabilities.js';

import {
  QUOTE_TOOL_DEFINITION,
  handleQuote,
} from './tools/quote.js';

import {
  BALANCE_TOOL_DEFINITION,
  handleBalance,
} from './tools/balance.js';

import {
  SEND_FILE_TOOL_DEFINITION,
  handleSendFile,
} from './tools/send.js';

import {
  CHECK_TOOL_DEFINITION,
  handleCheckTransfer,
} from './tools/check.js';

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS = [
  CAPABILITIES_TOOL_DEFINITION,
  QUOTE_TOOL_DEFINITION,
  BALANCE_TOOL_DEFINITION,
  SEND_FILE_TOOL_DEFINITION,
  CHECK_TOOL_DEFINITION,
];

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.REFUELER_API_URL ?? 'https://api.share.refueler.io';
const LIVE_KEY = process.env.REFUELER_LIVE_KEY ?? '';
const SIGN_KEY = process.env.REFUELER_SIGN_KEY ?? '';

// ── Server bootstrap ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'refueler-mcp', version: '0.5.0' },
  { capabilities: { tools: {} } },
);

const client = new ApiClient({ baseUrl: BASE_URL, liveKey: LIVE_KEY, signKey: SIGN_KEY, signRequest });

// ── List tools ────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ── Call tool ─────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'refueler_capabilities':
      return { content: await handleCapabilities(args, client) };

    case 'refueler_quote':
      return { content: await handleQuote(args, client) };

    case 'refueler_balance':
      return { content: await handleBalance(args, client) };

    case 'refueler_send_file':
      return { content: await handleSendFile(args, client) };

    case 'refueler_check_transfer':
      return { content: await handleCheckTransfer(args, client) };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
