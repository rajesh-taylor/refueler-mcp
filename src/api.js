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

  /**
   * call — non-throwing request. Returns { ok, status, body, text }.
   *
   * The upload path needs the status, not an exception: 402 payment_required,
   * 409 double-spend and 413 over-cap are all meaningful answers that the send
   * tool turns into its own envelopes. A network failure still throws
   * RefuelerApiError (status 0) — there is no status to report.
   *
   * @param {string} method
   * @param {string} path
   * @param {object} [opts]
   * @param {boolean} [opts.auth]
   * @param {string}  [opts.body]         — JSON string, or '' for a bodyless call
   * @param {object}  [opts.extraHeaders] — e.g. the /initiate X-* header set
   * @returns {Promise<{ ok: boolean, status: number, body: object|null, text: string }>}
   */
  async function call(method, path, { auth = false, body = '', extraHeaders = {} } = {}) {
    const url = `${apiBase}${path}`;
    const headers = { 'Accept': 'application/json', ...extraHeaders };
    if (body) headers['Content-Type'] = 'application/json';

    if (auth) {
      const hmacHeaders = signRequest({ method, path, liveKey, signKey, body });
      headers['Authorization']  = hmacHeaders['Authorization'];
      headers['X-Api-Sign-Key'] = hmacHeaders['X-Api-Sign-Key'];
    }

    const fetchOpts = { method, headers };
    if (body && method !== 'GET' && method !== 'HEAD') fetchOpts.body = body;

    let response;
    try {
      response = await fetchImpl(url, fetchOpts);
    } catch (err) {
      throw new RefuelerApiError(
        `Network error reaching Refueler API (${method} ${path}): ${err.message}`, 0, null,
      );
    }

    const text = await response.text().catch(() => '');
    let parsed = null;
    if ((response.headers.get('content-type') ?? '').includes('application/json') && text) {
      try { parsed = JSON.parse(text); } catch { /* leave null; text carries it */ }
    }

    return { ok: response.ok, status: response.status, body: parsed, text };
  }

  /**
   * get — non-throwing HMAC-signed GET. Returns { ok, status, body, text }.
   * Used by refueler_check_transfer, which reads 404 / 410 as answers.
   */
  async function get(path) {
    return call('GET', path, { auth: true });
  }

  return { getCapabilities, authPing, call, get };
}

/**
 * putPresigned — PUT one encrypted part straight to R2 via a presigned URL.
 *
 * The Worker is NOT in this path. The URL already carries the signature, so no
 * HMAC header goes on it and nothing about the transfer key or the real filename
 * is in the request. The presigned URL signs `content-length` and `host` only
 * (worker/src/r2_presign.js), so the body length must be exactly what /initiate
 * signed — Content-Type is sent for parity with the browser but is not signed.
 *
 * Single attempt; the caller owns the retry schedule.
 *
 * @param {string}     url
 * @param {Uint8Array} bytes
 * @param {object}     [opts]
 * @param {number}     [opts.timeoutMs=60000] — stall ceiling for one attempt
 * @param {Function}   [opts.fetchImpl=fetch]
 * @returns {Promise<{ ok: boolean, status: number, etag: string, text: string }>}
 */
export async function putPresigned(url, bytes, { timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body:    bytes,
      signal:  ac.signal,
    });
    const text = response.ok ? '' : await response.text().catch(() => '');
    return {
      ok:     response.ok,
      status: response.status,
      etag:   (response.headers.get('etag') ?? '').replace(/"/g, ''),
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}
