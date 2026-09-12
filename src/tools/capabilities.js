/**
 * src/tools/capabilities.js — refueler_capabilities MCP tool
 *
 * Discovery tool. Unauthenticated, free, silent preflight.
 *
 * Input (optional):
 *   { "detail": "summary" | "full" }   — default "summary"
 *
 * Output (success):
 *   The §7.1 capabilities payload from GET /api/v1/capabilities.
 *   On network error: last-known-good in-memory cache, flagged degraded: true.
 *   On 429: { error: "rate_limited", retry_after_s: <n> }
 *
 * This tool narrates nothing to the user unless asked — it is a silent preflight
 * tool. The agent gates all later behaviour on features and rails_available.
 */

import { RefuelerApiError } from '../api.js';

// ---------------------------------------------------------------------------
// In-memory cache — persists for process lifetime
// ---------------------------------------------------------------------------

let _cachedCapabilities = null;

/** Exposed for testing — reset the in-process cache. */
export function _resetCache() {
  _cachedCapabilities = null;
}

/** Exposed for testing — seed the cache with a known-good value. */
export function _seedCache(value) {
  _cachedCapabilities = value;
}

// ---------------------------------------------------------------------------
// Tool definition (MCP SDK schema)
// ---------------------------------------------------------------------------

export const capabilitiesTool = {
  name: 'refueler_capabilities',
  description:
    'Fetch current Refueler Share service capabilities, rate card, and feature flags. ' +
    'Call this before any send to gate behaviour on live server state. ' +
    'Unauthenticated, free, costs nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        enum: ['summary', 'full'],
        description: 'Level of detail to return. "summary" (default) returns the full §7.1 payload; "full" is identical in v1.',
      },
    },
    required: [],
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * handleCapabilities — execute the refueler_capabilities tool.
 *
 * @param {object} input — validated tool input (may be empty)
 * @param {object} apiClient — from createApiClient()
 * @returns {Promise<object>} MCP tool result content
 */
export async function handleCapabilities(input, apiClient) {
  // detail is advisory in v1 — the endpoint returns the same payload either way.
  // We carry the field through in case v2 adds a server-side projection.
  const detail = input?.detail ?? 'summary';

  let capabilities;
  let degraded = false;

  try {
    capabilities = await apiClient.getCapabilities();
    // Update the in-process last-known-good cache on every successful fetch.
    _cachedCapabilities = capabilities;
  } catch (err) {
    if (err instanceof RefuelerApiError && err.status === 429) {
      // Rate limited — surface the retry hint, never the internal error details.
      const retryAfter = err.body?.retry_after_s ?? err.body?.retry_after ?? null;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'rate_limited',
              retry_after_s: retryAfter,
            }),
          },
        ],
        isError: false, // Not a tool error — a well-formed API response
      };
    }

    // Any other error (network, 5xx, parse failure) — degrade to cache.
    if (_cachedCapabilities !== null) {
      capabilities = _cachedCapabilities;
      degraded = true;
    } else {
      // No cache and no live response — surface a clear failure.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'capabilities_unavailable',
              detail: err.message ?? 'Unable to reach the Refueler API and no cached capabilities are available.',
            }),
          },
        ],
        isError: true,
      };
    }
  }

  // Successful (or degraded) response
  const payload = {
    ...capabilities,
    // Stamp degraded: true if we're serving from cache — the agent must know.
    ...(degraded ? { degraded: true, degraded_reason: 'serving cached capabilities — live fetch failed' } : {}),
    // Carry the detail level through for forward compatibility.
    _detail: detail,
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
    isError: false,
  };
}
