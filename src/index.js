#!/usr/bin/env node
/**
 * src/index.js — Refueler Share MCP server
 *
 * Privacy-first, encrypted file transfer for agents.
 * Runs in the agent's trust domain — Refueler never hosts this server.
 *
 * Transport: stdio (MCP standard)
 * Launch:    npx @refueler/mcp-server
 *            node src/index.js
 *
 * Required env:  REFUELER_LIVE_KEY, REFUELER_SIGN_KEY
 * Optional env:  REFUELER_API_BASE, REFUELER_RAIL, REFUELER_ANON_CREDITS
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import { createApiClient } from './api.js';
import { capabilitiesTool, handleCapabilities } from './tools/capabilities.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let config;
try {
  config = loadConfig();
} catch (err) {
  process.stderr.write(`[refueler-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
}

const apiClient = createApiClient(config);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: '@refueler/mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ---------------------------------------------------------------------------
// Tool registry
// SW-MCP-1: capabilities only.
// SW-MCP-3: refueler_quote + refueler_balance
// SW-MCP-4: refueler_send_file
// SW-MCP-5: refueler_check_transfer
// ---------------------------------------------------------------------------

const TOOLS = [capabilitiesTool];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'refueler_capabilities':
      return handleCapabilities(args ?? {}, apiClient);

    default:
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'unknown_tool',
              detail: `Tool "${name}" is not available in this version of @refueler/mcp-server.`,
            }),
          },
        ],
        isError: true,
      };
  }
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();

async function main() {
  await server.connect(transport);
  process.stderr.write('[refueler-mcp] Server running on stdio. Rail: ' + config.rail + '\n');
}

main().catch((err) => {
  process.stderr.write(`[refueler-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
