// src/tools/balance.js — refueler-mcp
// refueler_balance: current balance snapshot. No spend. No upload.
// Output shape: §2.6 of refueler-mcp-spec-v2.md (locked).
//
// Identity rail  — server-held recovering ledger; auth/ping returns authoritative balance.
// Anonymous rail — client-held bearer stack; server is blind beyond what ping returns.

'use strict';

// ---------------------------------------------------------------------------
// Input schema (no required fields — context from config)
// ---------------------------------------------------------------------------

export const BALANCE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    rail: {
      type: 'string',
      enum: ['identity', 'anonymous'],
      description: 'Rail to query. Defaults to configured credential rail.',
    },
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * refuelerBalance(input, { api, config })
 *
 * @param {object} input            — validated tool input (may be empty)
 * @param {object} ctx
 * @param {object} ctx.api          — API client (src/api.js)
 * @param {object} ctx.config       — loaded config (src/config.js)
 * @returns {Promise<object>}       — §2.6 balance envelope or error envelope
 */
export async function refuelerBalance(input, { api, config }) {
  const rail = input?.rail ?? config.rail ?? 'identity';

  // ------------------------------------------------------------------
  // Anonymous rail — server is blind to client-held bearer credits.
  // Return local stack count only; no period, no allocation.
  // §2.6: "returns remaining_credits only — no period, no allocation"
  // ------------------------------------------------------------------
  if (rail === 'anonymous') {
    const localCredits = typeof config.localCredits === 'number'
      ? config.localCredits
      : null;

    return {
      rail: 'anonymous',
      remaining_credits: localCredits,
      server_blind: true,
      note: 'You hold credits locally — the server cannot see this balance.',
    };
  }

  // ------------------------------------------------------------------
  // Identity rail — call auth/ping for authoritative snapshot.
  // ------------------------------------------------------------------
  let pingResult;
  try {
    pingResult = await api.ping();
  } catch (err) {
    return {
      error: 'ping_failed',
      detail: err?.message ?? 'auth/ping request failed',
      rail,
      remaining_credits: null,
    };
  }

  // Build the response from ping data.
  // ping is expected to return:
  //   remaining_credits, rail, plan, period_end,
  //   allocation_credits (identity_api), overage_credits (identity_api), status
  //
  // We surface exactly what the spec §2.6 lists; extra fields from ping are
  // not forwarded (minimal surface principle).

  const result = {
    remaining_credits: pingResult.remaining_credits ?? null,
    rail: pingResult.rail ?? rail,
    plan: pingResult.plan ?? null,       // identity_api | personal_api
    period_end: pingResult.period_end ?? null,  // unix secs
    allocation_credits: pingResult.allocation_credits ?? null,
    status: pingResult.status ?? null,   // active | cancelled
  };

  // overage_credits: identity_api only — omit for personal_api and anonymous.
  // If the plan is identity_api and the field is present, include it.
  if (result.plan === 'identity_api' && pingResult.overage_credits !== undefined) {
    result.overage_credits = pingResult.overage_credits;
  }

  return result;
}

// ---------------------------------------------------------------------------
// MCP tool descriptor
// ---------------------------------------------------------------------------

export const balanceTool = {
  name: 'refueler_balance',
  description:
    'Returns the current credit balance snapshot for this Refueler credential. ' +
    'Identity rail: live server balance, allocation, and period end date. ' +
    'Anonymous rail: locally held credit count — the server cannot see this balance. ' +
    'No credits are spent.',
  inputSchema: BALANCE_INPUT_SCHEMA,
  handler: refuelerBalance,
};
