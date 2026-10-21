/**
 * src/hmac.js — HMAC-SHA256 request signing for Refueler Share API
 *
 * Signs every outbound authenticated API request.
 *
 * Canonical string (v2, UUID-Out-Of-Path-1 · 21 Oct 2026):
 *   method + "\n" + path + "\n" + timestamp + "\n" + body_sha256_hex + "\n" + transfer_uuid
 *
 * Where:
 *   method    — uppercase HTTP verb, e.g. "GET"
 *   path      — URL path including leading slash and query string, e.g. "/api/v1/auth/ping"
 *   timestamp — Unix seconds as a decimal string
 *   body_sha256_hex — lowercase hex SHA-256 of the raw request body bytes;
 *                     empty body → SHA-256 of the empty string
 *   transfer_uuid — the X-Transfer-UUID header, lower-case; "" when the request names
 *                   no transfer. The UUID left the path (Cloudflare's sampled request
 *                   records keep paths), so it is signed on its own line.
 *
 * Produces two headers:
 *   Authorization: HMAC-SHA256 key=<rfs_live_key>, ts=<timestamp>, sig=<hex>
 *   X-Api-Sign-Key: <rfs_sign_key>
 *
 * Timestamp tolerance: ±300 s (enforced by the Worker).
 */

import { createHmac, createHash } from 'node:crypto';

/**
 * sha256Hex — returns lowercase hex SHA-256 of a Buffer or string.
 * Empty string input → SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
 *
 * @param {Buffer|string} data
 * @returns {string} lowercase hex
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * buildCanonical — assembles the string that gets signed.
 *
 * @param {string} method     — uppercase HTTP verb
 * @param {string} path       — URL path + query string
 * @param {number} timestamp  — Unix seconds
 * @param {Buffer|string} body — raw request body (pass empty string for bodyless requests)
 * @param {string} [transferUuid] — X-Transfer-UUID, or '' when the request names none
 * @returns {string}
 */
export function buildCanonical(method, path, timestamp, body = '', transferUuid = '') {
  const bodyHash = sha256Hex(body);
  const uuidLine = String(transferUuid ?? '').trim().toLowerCase();
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}\n${uuidLine}`;
}

/**
 * signRequest — produces the two HMAC auth headers the Worker's requireApiAuth() expects.
 *
 * @param {object} opts
 * @param {string} opts.method     — HTTP verb
 * @param {string} opts.path       — URL path (include query string if present)
 * @param {string} opts.liveKey    — rfs_live_... identification key
 * @param {string} opts.signKey    — rfs_sign_... request-signing key
 * @param {Buffer|string} [opts.body] — request body; defaults to empty string
 * @param {number} [opts.timestamp]   — Unix secs; defaults to Date.now() / 1000 | 0
 * @param {string} [opts.transferUuid] — the X-Transfer-UUID the request carries, if any
 * @returns {{ Authorization: string, 'X-Api-Sign-Key': string, timestamp: number }}
 */
export function signRequest({ method, path, liveKey, signKey, body = '', timestamp, transferUuid = '' }) {
  const ts = timestamp ?? (Date.now() / 1000 | 0);
  const canonical = buildCanonical(method, path, ts, body, transferUuid);
  const sig = createHmac('sha256', signKey).update(canonical).digest('hex');

  return {
    'Authorization': `HMAC-SHA256 key=${liveKey}, ts=${ts}, sig=${sig}`,
    'X-Api-Sign-Key': signKey,
    timestamp: ts,
  };
}
