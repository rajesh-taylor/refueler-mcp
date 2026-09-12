// src/tools/quote.js — refueler-mcp
// refueler_quote: cost preview before any spend.
// Output shape: §2.2 of refueler-mcp-spec-v2.md (locked).
// No credits are spent here. No upload is initiated.

'use strict';

import { RATE_CARD_VERSION, costCredits, gbpReference } from '../rate-card.js';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const QUOTE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    size_bytes: {
      type: 'integer',
      description: 'File size in bytes (required, must be > 0).',
    },
    permanent_record: {
      type: 'boolean',
      description: 'Whether the transfer includes a Bitcoin-anchored permanent record. Default false.',
    },
    rail: {
      type: 'string',
      enum: ['identity', 'anonymous'],
      description: 'Payment rail. Defaults to the configured credential rail.',
    },
  },
  required: ['size_bytes'],
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * refuelerQuote(input, { api, config })
 *
 * @param {object} input            — validated tool input
 * @param {object} ctx
 * @param {object} ctx.api          — API client (src/api.js)
 * @param {object} ctx.config       — loaded config (src/config.js)
 * @returns {Promise<object>}       — §2.2 success envelope or error envelope
 */
export async function refuelerQuote(input, { api, config }) {
  // ------------------------------------------------------------------
  // Input validation
  // ------------------------------------------------------------------
  const { size_bytes, permanent_record = false, rail: railInput } = input ?? {};

  if (
    typeof size_bytes !== 'number' ||
    !Number.isInteger(size_bytes) ||
    size_bytes <= 0
  ) {
    return {
      error: 'invalid_input',
      detail: 'size_bytes must be a positive integer',
    };
  }

  // Rail: use explicitly supplied value, or fall back to the configured
  // credential's rail. Anonymous rail has no live credential on the server
  // side — the server is blind to the client-held bearer stack.
  const rail = railInput ?? config.rail ?? 'identity';

  // ------------------------------------------------------------------
  // Cost calculation (pure — no I/O)
  // ------------------------------------------------------------------
  const breakdown = costCredits({ sizeBytes: size_bytes, permanentRecord: permanent_record });
  const totalCredits = breakdown.total;

  // ------------------------------------------------------------------
  // GBP reference — from capabilities cache (passed via config)
  // Null if rate absent, stale, or invalid.  Never blocks a transfer.
  // ------------------------------------------------------------------
  const btcRefRate = config.btcRefRate ?? null;
  const cost_gbp_reference = gbpReference(totalCredits, btcRefRate);

  // ------------------------------------------------------------------
  // Balance check
  // ------------------------------------------------------------------
  if (rail === 'anonymous') {
    // Server is blind to the local bearer stack.
    // Count is held by the client — here we use config.localCredits if set.
    const localCredits = typeof config.localCredits === 'number'
      ? config.localCredits
      : null;

    const affordable = localCredits !== null ? localCredits >= totalCredits : null;

    return {
      rate_card_version: RATE_CARD_VERSION,
      cost_credits: totalCredits,
      cost_gbp_reference,
      rail: 'anonymous',
      // affordable: null means "cannot determine" (no local stack configured).
      // Spec does not enumerate this case explicitly; we omit affordable
      // rather than lie.
      ...(affordable !== null ? { affordable } : {}),
      balance: {
        kind: 'local_credits',
        remaining_credits: localCredits,
      },
    };
  }

  // Identity rail — call auth/ping for live remaining_credits.
  let pingResult;
  try {
    pingResult = await api.ping();
  } catch (err) {
    // Degrade gracefully: return cost calculation with balance_available false.
    // The spec does not name this field, but we need to convey the degraded state.
    return {
      rate_card_version: RATE_CARD_VERSION,
      cost_credits: totalCredits,
      cost_gbp_reference,
      rail,
      balance_available: false,
      balance_error: err?.message ?? 'ping failed',
      balance: {
        kind: 'credit_pool',
        remaining_credits: null,
      },
    };
  }

  const remaining = pingResult.remaining_credits;
  const affordable = typeof remaining === 'number' ? remaining >= totalCredits : null;

  const result = {
    rate_card_version: RATE_CARD_VERSION,
    cost_credits: totalCredits,
    cost_gbp_reference,
    rail: pingResult.rail ?? rail,
    ...(affordable !== null ? { affordable } : {}),
    balance: {
      kind: 'credit_pool',
      remaining_credits: remaining ?? null,
    },
  };

  return result;
}

// ---------------------------------------------------------------------------
// MCP tool descriptor
// ---------------------------------------------------------------------------

export const quoteTool = {
  name: 'refueler_quote',
  description:
    'Returns the credit cost of a Refueler file transfer before any spend is made. ' +
    'Use this before refueler_send_file to confirm the transfer is affordable. ' +
    'Costs are in credits; a GBP reference is shown at today\'s reference rate when available.',
  inputSchema: QUOTE_INPUT_SCHEMA,
  handler: refuelerQuote,
};
