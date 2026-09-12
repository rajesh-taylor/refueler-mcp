// src/index.js — refueler-mcp
// MCP server entry point. stdio transport.
// Tools: refueler_capabilities, refueler_quote, refueler_balance
//
// SW-MCP-1: scaffold + capabilities
// SW-MCP-2: crypto.js + fragment.js (no index changes)
// SW-MCP-3: quote + balance wired here

'use strict';

import { loadConfig } from './config.js';
import { makeApiClient } from './api.js';
import { capabilitiesTool } from './tools/capabilities.js';
import { quoteTool } from './tools/quote.js';
import { balanceTool } from './tools/balance.js';
import { sendFileTool, handleSendFile } from './tools/send.js';

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const TOOLS = [
  capabilitiesTool,
  quoteTool,
  balanceTool,
  sendFileTool,
];

// Build a lookup map: tool name → descriptor
const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// MCP protocol helpers (stdio, newline-delimited JSON)
// ---------------------------------------------------------------------------

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendError(id, code, message) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

function handleInitialize(id) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'refueler-mcp',
        version: '0.3.0',
      },
    },
  });
}

function handleToolsList(id) {
  const tools = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  sendMessage({ jsonrpc: '2.0', id, result: { tools } });
}

async function handleToolCall(id, params, ctx) {
  const { name, arguments: args } = params ?? {};

  const tool = TOOL_MAP[name];
  if (!tool) {
    sendError(id, -32601, `Unknown tool: ${name}`);
    return;
  }

  let result;
  try {
    result = await tool.handler(args ?? {}, ctx);
  } catch (err) {
    sendError(id, -32603, err?.message ?? 'Internal tool error');
    return;
  }

  sendMessage({
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    process.stderr.write(`[refueler-mcp] Config error: ${err.message}\n`);
    process.exit(1);
  }

  const api = makeApiClient(config);
  const ctx = { api, config };

  // Accumulate partial lines from stdin
  let buffer = '';

  process.stdin.setEncoding('utf8');

  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep the (possibly partial) last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // Malformed JSON — log and continue; no id to reply with
        process.stderr.write(`[refueler-mcp] JSON parse error: ${trimmed}\n`);
        continue;
      }

      const { jsonrpc, id, method, params } = msg;

      if (jsonrpc !== '2.0') {
        sendError(id ?? null, -32600, 'Invalid JSON-RPC version');
        continue;
      }

      switch (method) {
        case 'initialize':
          handleInitialize(id);
          break;

        case 'notifications/initialized':
          // Acknowledgement — no response required.
          break;

        case 'tools/list':
          handleToolsList(id);
          break;

        case 'tools/call':
          await handleToolCall(id, params, ctx);
          break;

        case 'ping':
          sendMessage({ jsonrpc: '2.0', id, result: {} });
          break;

        default:
          sendError(id, -32601, `Method not found: ${method}`);
      }
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });

  // Degrade-mode cache: if capabilities has been loaded into config
  // (e.g. pre-fetched at startup), it is available via config.capabilities.
  // Capabilities tool handles its own staleness logic.
}

main().catch((err) => {
  process.stderr.write(`[refueler-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
