/**
 * refueler_check_transfer — SW-MCP-5
 *
 * Pulls HMAC-signed receipts from the Worker and derives transfer state.
 *
 * Vocabulary invariants (§2.7, locked):
 *   - "collection" / "collected" everywhere — never "delivered" / "delivered"
 *   - collection: null = honest not-yet, never an error
 *   - state: "uploaded" | "collected" | "expired" | "unknown"
 *
 * Backing endpoints (api.share.refueler.io):
 *   GET /api/v1/receipt/{uuid}/acceptance   — HMAC-auth
 *   GET /api/v1/receipt/{uuid}/collection   — HMAC-auth
 *
 * Error matrix: auth_failed | not_found | rate_limited
 */

'use strict';

// ─── Tool schema ──────────────────────────────────────────────────────────────

export const CHECK_TOOL_DEFINITION = {
  name: 'refueler_check_transfer',
  description: [
    'Pull HMAC-signed receipts for a Refueler Share transfer.',
    'Returns an acceptance receipt (lodged by sender) and a collection receipt',
    '(served to downloader) plus a derived state.',
    'collection: null means not yet collected — an honest not-yet, never an error.',
    'Use "collected" / "collection receipt" exclusively — the vocabulary of proof-of-receipt is not applicable here.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      uuid: {
        type: 'string',
        description: 'Transfer UUID returned by refueler_send_file.',
      },
      type: {
        type: 'string',
        enum: ['acceptance', 'collection', 'both'],
        description: 'Which receipts to fetch. Defaults to "both".',
      },
    },
    required: ['uuid'],
  },
};

// ─── State derivation ─────────────────────────────────────────────────────────

/**
 * Derive transfer state from receipt objects.
 *
 * Logic (§2.7):
 *   - acceptance present + collection present       → "collected"
 *   - acceptance present + collection null/missing  → "uploaded"
 *   - both null/missing                             → "unknown"
 *   - Worker returned a 410 / TTL-expired shape     → "expired"
 *     (the Worker signals expiry via a dedicated error code on the receipt endpoint)
 *
 * @param {object|null} acceptance
 * @param {object|null} collection
 * @param {boolean}     expired   - true when the Worker returned `transfer_expired`
 * @returns {"uploaded"|"collected"|"expired"|"unknown"}
 */
export function deriveState(acceptance, collection, expired = false) {
  if (expired) return 'expired';
  if (acceptance && collection) return 'collected';
  if (acceptance && !collection) return 'uploaded';
  return 'unknown';
}

// ─── Receipt fetch helpers ────────────────────────────────────────────────────

/**
 * Fetch one receipt endpoint.
 *
 * @param {import('../api-client.js').ApiClient} client
 * @param {string} uuid
 * @param {'acceptance'|'collection'} kind
 * @returns {Promise<{receipt: object, sig: string}|null>}
 *
 * Returns null for an honest 404 meaning "not yet available" (collection only).
 * Throws a structured error for auth_failed, rate_limited, or unexpected status.
 */
async function fetchReceipt(client, uuid, kind) {
  const path = `/api/v1/receipt/${uuid}/${kind}`;
  const result = await client.get(path);

  // 200 → return receipt object, or null if the Worker signals not-yet-collected
  // (body.receipt === null = honest "not yet" for collection; treat as absent)
  if (result.status === 200) {
    const body = result.body;
    if (body.receipt === null) return null;
    return { receipt: body.receipt, sig: body.sig };
  }

  // 404 → transfer never existed, or 7-day TTL expired
  if (result.status === 404) {
    const code = result.body?.error;
    if (code === 'transfer_expired') {
      // Signal expiry distinctly so the caller can set state correctly
      const err = new Error('transfer_expired');
      err.code = 'transfer_expired';
      throw err;
    }
    // not_found (UUID unknown, or receipt TTL elapsed)
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }

  // 401 → HMAC signing failure
  if (result.status === 401) {
    const err = new Error('auth_failed');
    err.code = 'auth_failed';
    err.detail = result.body?.detail ?? 'HMAC signature rejected';
    throw err;
  }

  // 429 → rate limited
  if (result.status === 429) {
    const err = new Error('rate_limited');
    err.code = 'rate_limited';
    err.retryAfterS = result.body?.retry_after_s ?? null;
    throw err;
  }

  // Unexpected: treat as a transient server error, surface the status
  const err = new Error('unexpected_status');
  err.code = 'unexpected_status';
  err.status = result.status;
  throw err;
}

// ─── Tool handler ─────────────────────────────────────────────────────────────

/**
 * Handle a refueler_check_transfer tool call.
 *
 * @param {object} input              - Validated MCP tool input
 * @param {string} input.uuid
 * @param {'acceptance'|'collection'|'both'} [input.type='both']
 * @param {import('../api-client.js').ApiClient} client
 * @returns {Promise<object>}         - MCP content array
 */
export async function handleCheckTransfer(input, client) {
  const { uuid } = input;
  const type = input.type ?? 'both';

  // Validate uuid is present and looks plausibly UUID-shaped
  if (typeof uuid !== 'string' || uuid.length === 0) {
    return errorEnvelope('invalid_input', 'uuid is required');
  }

  const fetchAcceptance = type === 'acceptance' || type === 'both';
  const fetchCollection = type === 'collection' || type === 'both';

  let acceptance = null;
  let collection = null;
  let expired = false;

  try {
    if (fetchAcceptance) {
      acceptance = await fetchReceipt(client, uuid, 'acceptance');
    }
    if (fetchCollection) {
      collection = await fetchReceipt(client, uuid, 'collection');
    }
  } catch (err) {
    // transfer_expired resolves to state "expired" — not an error response
    if (err.code === 'transfer_expired') {
      expired = true;
    } else if (err.code === 'not_found') {
      return errorEnvelope('not_found', 'Transfer not found or receipt TTL elapsed (7-day window)');
    } else if (err.code === 'auth_failed') {
      return errorEnvelope('auth_failed', err.detail ?? 'HMAC signature rejected');
    } else if (err.code === 'rate_limited') {
      return rateLimitedEnvelope(err.retryAfterS);
    } else {
      // Unexpected — surface what we know
      return errorEnvelope(
        'server_error',
        `Unexpected response (HTTP ${err.status ?? 'unknown'})`,
      );
    }
  }

  const state = deriveState(acceptance, collection, expired);

  const payload = {
    uuid,
    acceptance,
    collection,
    state,
  };

  return [
    {
      type: 'text',
      text: JSON.stringify(payload, null, 2),
    },
  ];
}

// ─── Envelope helpers ─────────────────────────────────────────────────────────

function errorEnvelope(error, detail) {
  return [
    {
      type: 'text',
      text: JSON.stringify({ error, detail }, null, 2),
    },
  ];
}

function rateLimitedEnvelope(retryAfterS) {
  return [
    {
      type: 'text',
      text: JSON.stringify(
        { error: 'rate_limited', retry_after_s: retryAfterS },
        null,
        2,
      ),
    },
  ];
}
