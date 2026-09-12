#!/usr/bin/env node
/**
 * scripts/demo-send.js — Refueler Share MCP demo script
 * Repo: refueler-mcp  (/Users/rajeshtaylor/Documents/refueler-mcp/scripts/demo-send.js)
 *
 * Usage:
 *   REFUELER_LIVE_KEY=rfs_live_... REFUELER_SIGN_KEY=rfs_sign_... node scripts/demo-send.js
 *
 * Sends scripts/demo-payload.txt, prints share_url / cost_credits / expires_at,
 * then immediately checks the transfer state. Exits 0 on success, 1 on any error.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Terminal styling — Carbon/Paper palette, graceful on any terminal
// ---------------------------------------------------------------------------
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  // Paper (#F5F0E8) approximated as bright white; Carbon (#1A1A1A) via default bg
  paper:  '\x1b[97m',
  amber:  '\x1b[33m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  grey:   '\x1b[90m',
};

const line  = () => process.stdout.write(C.grey + '─'.repeat(60) + C.reset + '\n');
const head  = (t) => console.log(C.bold + C.paper + t + C.reset);
const label = (k, v) => console.log(`  ${C.grey}${k.padEnd(18)}${C.reset}${C.paper}${v}${C.reset}`);
const ok    = (t) => console.log(C.green + '  ✓ ' + C.reset + t);
const warn  = (t) => console.log(C.amber + '  ⚠ ' + C.reset + t);
const fail  = (t) => { console.error(C.red + '  ✗ ' + C.reset + t); };

function fatal(reason) {
  fail(reason);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Environment + payload
// ---------------------------------------------------------------------------
const LIVE_KEY = process.env.REFUELER_LIVE_KEY;
const SIGN_KEY = process.env.REFUELER_SIGN_KEY;

if (!LIVE_KEY || !LIVE_KEY.startsWith('rfs_live_')) {
  fatal('REFUELER_LIVE_KEY not set or does not start with rfs_live_');
}
if (!SIGN_KEY || !SIGN_KEY.startsWith('rfs_sign_')) {
  fatal('REFUELER_SIGN_KEY not set or does not start with rfs_sign_');
}

const __dir      = dirname(fileURLToPath(import.meta.url));
const payloadPath = join(__dir, 'demo-payload.txt');

let payloadBytes;
try {
  payloadBytes = readFileSync(payloadPath);
} catch {
  fatal(`Cannot read demo payload at ${payloadPath}`);
}

// ---------------------------------------------------------------------------
// Dynamically import the MCP tool implementations from src/
// We call the underlying tool handlers directly — no MCP transport needed.
// ---------------------------------------------------------------------------
const srcDir = join(__dir, '..', 'src');

let quoteHandler, sendHandler, checkHandler;
try {
  const quoteMod  = await import(join(srcDir, 'tools', 'quote.js'));
  const sendMod   = await import(join(srcDir, 'tools', 'send.js'));
  const checkMod  = await import(join(srcDir, 'tools', 'check.js'));
  quoteHandler = quoteMod.handler  ?? quoteMod.default;
  sendHandler  = sendMod.handler   ?? sendMod.default;
  checkHandler = checkMod.handler  ?? checkMod.default;
} catch (err) {
  fatal(`Failed to import tool modules: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Config object (mirrors what src/config.js exposes at runtime)
// ---------------------------------------------------------------------------
const config = {
  apiKey:  LIVE_KEY,
  signKey: SIGN_KEY,
  baseUrl: 'https://api.share.refueler.io',
};

// ---------------------------------------------------------------------------
// Helper: call a tool handler and unwrap the MCP content array
// ---------------------------------------------------------------------------
async function callTool(handler, args) {
  // Tool handlers return { content: [{ type: 'text', text: '...' }] }
  // or throw on hard errors.
  const result = await handler(args, config);
  if (!result || !result.content || !result.content.length) {
    throw new Error('Tool returned empty content');
  }
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  // Parse JSON if possible; fall back to raw text
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Quote
// ---------------------------------------------------------------------------
line();
head('Refueler Share — demo send');
line();

console.log();
console.log(C.bold + '  Step 1 · Quote' + C.reset);
console.log();

const sizeBytes = payloadBytes.length;
label('file', 'demo-payload.txt');
label('size', `${sizeBytes} bytes`);
console.log();

let quote;
try {
  quote = await callTool(quoteHandler, {
    size_bytes:       sizeBytes,
    permanent_record: false,
    rail:             'identity',
  });
} catch (err) {
  fatal(`Quote failed: ${err.message}`);
}

if (quote.error) {
  fatal(`Quote error: ${quote.error}${quote.detail ? ' — ' + quote.detail : ''}`);
}

label('cost',      `${quote.cost_credits} credits`);
if (quote.cost_gbp_reference != null) {
  label('ref rate',  `£${quote.cost_gbp_reference.toFixed(4)} (today's reference rate)`);
}
label('affordable', quote.affordable ? 'yes' : 'no');
if (!quote.affordable) {
  const bal = quote.balance;
  const rem = bal && bal.remaining_credits != null ? bal.remaining_credits : '?';
  fail(`Insufficient credits — ${rem} remaining, ${quote.cost_credits} required`);
  process.exit(1);
}
ok('quota check passed');

// ---------------------------------------------------------------------------
// Step 2 — Send
// ---------------------------------------------------------------------------
console.log();
console.log(C.bold + '  Step 2 · Lodge transfer' + C.reset);
console.log();

let send;
try {
  send = await callTool(sendHandler, {
    file_path:        payloadPath,
    expires_in_hours: 24,
    permanent_record: false,
  });
} catch (err) {
  fatal(`Send failed: ${err.message}`);
}

// Surface structured error from 402 / auth failure
if (send.error) {
  const code = send.error;
  const detail = send.detail ?? '';

  if (code === 'auth_failed') {
    fail('Authentication failed — check REFUELER_LIVE_KEY and REFUELER_SIGN_KEY');
  } else if (code === 'quota_exhausted') {
    fail('Credit quota exhausted for this billing period');
  } else if (code === 'overage_ceiling') {
    fail('Overage ceiling reached — contact your account manager');
  } else if (code === 'account_cancelled') {
    fail('Account is cancelled — credits are no longer issued');
  } else if (code === 'credit_invalid') {
    fail('Credit token rejected by the Worker — likely a double-spend');
  } else {
    fail(`Transfer error: ${code}${detail ? ' — ' + detail : ''}`);
  }
  process.exit(1);
}

if (!send.share_url) {
  fatal('Send returned no share_url — unexpected response shape');
}

ok('file lodged');
console.log();
label('share_url',    send.share_url);
label('cost_credits', `${send.cost_credits} credits`);
label('expires_at',   send.expires_at ?? '—');
if (send.transfer_id) {
  label('transfer_id',  send.transfer_id);
}

// ---------------------------------------------------------------------------
// Step 3 — Check transfer state
// ---------------------------------------------------------------------------
console.log();
console.log(C.bold + '  Step 3 · Check transfer state' + C.reset);
console.log();

// The check tool needs a share_url or transfer_id.
// Try transfer_id first; fall back to share_url if the tool accepts it.
const checkArgs = send.transfer_id
  ? { transfer_id: send.transfer_id }
  : { share_url: send.share_url };

let check;
try {
  check = await callTool(checkHandler, checkArgs);
} catch (err) {
  // Non-fatal — the transfer was sent; check is a bonus
  warn(`State check failed: ${err.message}`);
  check = null;
}

if (check && !check.error) {
  const state = check.state ?? 'unknown';
  const stateColour = state === 'uploaded' ? C.green
    : state === 'collected'               ? C.cyan
    : state === 'expired'                 ? C.amber
    :                                       C.grey;
  label('state', stateColour + state + C.reset);

  if (check.acceptance_receipt) {
    ok('acceptance receipt present');
  }
  if (check.collection_receipt) {
    ok('collection receipt present');
  } else {
    label('collection',   C.grey + 'not yet collected' + C.reset);
  }
} else if (check && check.error) {
  warn(`State check returned error: ${check.error}`);
} else {
  warn('State check skipped');
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log();
line();
console.log(
  C.bold + C.green + '  Transfer lodged successfully.' + C.reset +
  C.grey + ' Share the URL above with your recipient.' + C.reset
);
line();
console.log();

process.exit(0);
