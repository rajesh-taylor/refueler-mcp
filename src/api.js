/**
 * src/api.js — Thin fetch wrapper for the Refueler Share API
 *
 * Handles:
 *   - Attaching HMAC signing headers to authenticated requests
 *   - Parsing JSON responses
 *   - Throwing typed RefuelerApiError on non-2xx responses
 *
 * Methods available in SW-MCP-1:
 *   getCapabilities()  — GET /api/v1/capabilities (unauthenticated)
 *   authPing()         — GET /api/v1/auth/ping    (HMAC-signed)
 */

import { signRequest } from './hmac.js';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class RefuelerApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status      — HTTP status code
   * @param {object|null} body   — parsed response body, if any
   */
  constructor(message, status, body = null) {
    super(message);
    this.name = 'RefuelerApiError';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * createApiClient — returns a client bound to a specific config.
 *
 * @param {object} config — from loadConfig()
 * @param {Function} [fetchImpl] — injectable fetch (for tests); defaults to global fetch
 */
export function createApiClient(config, fetchImpl = fetch) {
  const { liveKey, signKey, apiBase } = config;

  /**
   * _request — internal fetch wrapper.
   *
   * @param {string} method
   * @param {string} path         — e.g. "/api/v1/capabilities"
   * @param {object} [opts]
   * @param {boolean} [opts.auth] — whether to attach HMAC headers (default false)
   * @param {string|Buffer} [opts.body] — request body
   * @param {object} [opts.extraHeaders]
   * @returns {Promise<object>} parsed JSON
   */
  async function _request(method, path, { auth = false, body = '', extraHeaders = {} } = {}) {
    const url = `${apiBase}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...extraHeaders,
    };

    if (auth) {
      const hmacHeaders = signRequest({ method, path, liveKey, signKey, body });
      headers['Authorization'] = hmacHeaders['Authorization'];
      headers['X-Api-Sign-Key'] = hmacHeaders['X-Api-Sign-Key'];
    }

    const fetchOpts = { method, headers };
    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = body;
    }

    let response;
    try {
      response = await fetchImpl(url, fetchOpts);
    } catch (err) {
      throw new RefuelerApiError(
        `Network error reaching Refueler API (${method} ${path}): ${err.message}`,
        0,
        null
      );
    }

    let parsed = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        parsed = await response.json();
      } catch {
        // non-JSON body on a JSON-declared response — treat as parse error
        throw new RefuelerApiError(
          `Refueler API returned unparseable JSON (${method} ${path}, status ${response.status})`,
          response.status,
          null
        );
      }
    }

    if (!response.ok) {
      throw new RefuelerApiError(
        `Refueler API error (${method} ${path}): HTTP ${response.status}`,
        response.status,
        parsed
      );
    }

    return { status: response.status, body: parsed, headers: response.headers };
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  /**
   * getCapabilities — GET /api/v1/capabilities
   * Unauthenticated, free. No HMAC.
   *
   * @returns {Promise<object>} the §7.1 capabilities payload
   * @throws {RefuelerApiError}
   */
  async function getCapabilities() {
    const result = await _request('GET', '/api/v1/capabilities', { auth: false });
    return result.body;
  }

  /**
   * authPing — GET /api/v1/auth/ping
   * HMAC-signed. Returns caller rail + quota summary.
   *
   * @returns {Promise<object>}
   * @throws {RefuelerApiError}
   */
  async function authPing() {
    const result = await _request('GET', '/api/v1/auth/ping', { auth: true });
    return result.body;
  }

  return { getCapabilities, authPing };
}
