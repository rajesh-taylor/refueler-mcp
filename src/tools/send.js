/**
 * src/tools/send.js — refueler_send_file tool
 *
 * E2E encrypted file transfer via the Refueler Worker.
 * Encryption lives entirely in this process — the Worker receives ciphertext only.
 *
 * Upload path (MCP-Fix-1 — direct-to-R2, the only path the Worker serves since
 * Share-6-6b retired the Worker-relay chunk PUT):
 *
 *   POST /upload/:uuid/initiate   headers only, no body → session token, the first
 *                                 batch of presigned PutObject URLs, and the
 *                                 separately-signed tail URL for part N−1
 *   PUT  <presigned R2 URL>       each encrypted part, straight to R2 — the Worker
 *                                 is not in this path at all
 *   POST /upload/:uuid/urls       the next batch of URLs, session-token authed
 *   POST /upload/:uuid/finalise   per-part digests + the ciphertext Merkle root
 *
 * Invariants (see refueler-share CLAUDE.md locked decisions):
 *   - X-File-Name to the Worker is always the constant "encrypted-payload".
 *   - The real filename, the transfer key K and the exact plaintext size travel
 *     in the URL fragment only, as link format v2 (fragment.js assembleFragment).
 *   - Parts are encrypted under a key DERIVED from K (crypto.js derivePartKey),
 *     with a STREAM counter nonce per part. Never K directly. Never a stored IV.
 *   - seal_nonce lives in the fragment only — never transmitted.
 *   - A stored part is exactly its plaintext length + 16; the presigned URL signs
 *     content-length, so one extra byte is rejected by R2.
 *   - No Math.random() — randomFillSync / crypto.getRandomValues only.
 *   - Vocabulary: "credits" in every user-facing field. Never "sats", "ecash",
 *     "tokens".
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  generateAesKey,
  derivePartKey,
  encryptPart,
  blake3Chunk,
  chunkFile,
  hashSecret,
  generateBlindedCredential,
  unblindSignature,
  CredentialProofError,
  bufToHex,
  CHUNK_SIZE,
  CHUNK_TAG_BYTES,
} from '../crypto.js';
import { buildMerkleTree, TREE_ALGO } from '../merkle.js';
import { assembleFragment } from '../fragment.js';
import { costCredits } from '../rate-card.js';
import { putPresigned, RefuelerApiError } from '../api.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The live receiver page. `?uuid=` is what loads the receiver card; `#` carries v2. */
const SHARE_BASE_URL = 'https://refueler.io/share/';

/**
 * Expiry requested at /initiate.
 *
 * Cred-Fix-1: no request header selects a tier, so EVERY upload resolves to the
 * free tier at the Worker until B12-4a — a Chartered credential included. The
 * Worker's ceiling is therefore 7 days and it 400s ('expiry_exceeds_tier') on
 * anything longer, whatever the issued tier says. Raising this before B12-4a
 * ships would break every send.
 */
const ENFORCED_EXPIRY_SECS = 7 * 24 * 3600;

/** Parts in flight. Two, matching the browser after Safari-Slow-Link-1. */
const PARTS_IN_FLIGHT = 2;

/** One part's stall ceiling, and the retry schedule for a recoverable failure. */
const PART_TIMEOUT_MS   = 60_000;
const PART_RETRY_DELAYS = [2000, 5000, 10_000, 10_000];

/** Presigned-URL batch size the Worker serves (Share-6 spec §6, D-5). */
const URL_BATCH_SIZE = 256;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Uint8Array → base64url (no padding) — the finalise wire encoding. */
function toB64url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

export const sendFileTool = {
  name: 'refueler_send_file',
  description:
    'Encrypt a local file and lodge it on Refueler Share. Returns a share URL whose ' +
    'fragment carries the transfer key, the real filename and the exact size — none of ' +
    'which ever reaches the Worker. Cost is deducted from your credit pool.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or relative path to the file to send.',
      },
      recipient_hint: {
        type: 'string',
        description:
          'Agent-side prose only (e.g. "Alice at Acme"). Never sent to the Worker or logged anywhere.',
      },
      passphrase: {
        type: 'string',
        description:
          'Optional NUT-11 P2SH access gate. The recipient must supply this to collect. ' +
          'Send it by a separate channel — never include it in the share URL.',
      },
      destroy_after_download: {
        type: 'boolean',
        description: 'If true, the transfer is deleted the moment it is collected.',
      },
      available_from: {
        type: 'integer',
        description: 'Unix timestamp (seconds) — unavailable before this time. Paid tiers only.',
      },
      available_until: {
        type: 'integer',
        description: 'Unix timestamp (seconds) — unavailable after this time. Paid tiers only.',
      },
      transfer_ref: {
        type: 'string',
        maxLength: 128,
        description:
          'Chartered-tier attribution reference (≤128 chars). Logged to Analytics Engine only. ' +
          'Never stored in the manifest or shown to the recipient.',
      },
    },
    required: ['file_path'],
  },
  handler: handleSendFile,
};

/** Back-compat alias for src/index.js's tool registry. */
export const SEND_FILE_TOOL_DEFINITION = sendFileTool;

// ---------------------------------------------------------------------------
// Credential provider — the production path
// ---------------------------------------------------------------------------

/**
 * issueApiCredential — POST /api/v1/credential/issue, HMAC-signed.
 *
 * Returns the pieces /initiate needs. The NUT-12 DLEQ proof is checked locally
 * before anything is spent (crypto.js unblindSignature), so a mint that signed
 * with a different key stops the send here rather than burning an upload.
 *
 * A soak run injects a different provider — see scripts/soak-send.js. The shape
 * of the return value is the contract between the two.
 *
 * @returns {Promise<{ uuid, credential, commitment, issuedTier, extraHeaders }>}
 */
export async function issueApiCredential({ api }) {
  const blinded = generateBlindedCredential();
  const res = await api.call('POST', '/api/v1/credential/issue', {
    auth: true,
    body: JSON.stringify({ blinded_message: blinded.blindedMsg }),
  });

  if (res.status === 402) {
    const e = new Error('payment_required');
    e.paymentRequired = res.body || {};
    throw e;
  }
  if (res.status === 401) {
    const e = new Error(res.body?.error || 'HMAC authentication failed.');
    e.authFailed = true;
    throw e;
  }
  if (!res.ok) {
    throw new Error(`Credential issue returned HTTP ${res.status}.`);
  }

  const { uuid, issued_tier: issuedTier, commitment } = res.body || {};
  if (!uuid || !commitment || !issuedTier) {
    throw new Error('Credential issue response missing required fields (uuid, commitment, issued_tier).');
  }

  // Throws CredentialProofError on a bad or missing proof — before any upload.
  const credential = unblindSignature(res.body, blinded);

  return { uuid, credential, commitment, issuedTier, extraHeaders: {} };
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * handleSendFile(input, deps) → MCP content array
 *
 * @param {object}   input  — validated tool input per inputSchema
 * @param {object}   deps
 * @param {object}   deps.api               — API client (src/api.js createApiClient)
 * @param {object}   [deps.config]          — loaded config/secrets
 * @param {Function} [deps.issueCredential] — credential provider; defaults to the
 *                                            HMAC API path. Injected by a soak run.
 * @param {Function} [deps.putPart]         — injectable presigned PUT (tests)
 */
export async function handleSendFile(input, deps = {}) {
  const {
    api,
    config,
    issueCredential = issueApiCredential,
    putPart = putPresigned,
  } = deps;

  const {
    file_path,
    // recipient_hint is intentionally ignored — agent prose only, never forwarded
    passphrase,
    destroy_after_download,
    available_from,
    available_until,
    permanent_record,
    transfer_ref,
  } = input || {};

  if (!api) return _err('Send is not configured: no API client.');

  // ── 0. permanent_record is not available from this server ────────────────
  // The Bitcoin-anchored seal is a client-side OTS pipeline (frontend/timestamp.js)
  // that this server does not implement. Writing `s` into the fragment without
  // running that pipeline would hand the recipient a seal nonce for a seal that
  // was never made — so refuse rather than claim it.
  if (permanent_record) {
    return _mcpError(
      'not_supported',
      'A permanent record cannot be created from this server yet — the timestamp pipeline is browser-side. ' +
      'Send without permanent_record, or make this transfer from refueler.io/share/.',
    );
  }

  // ── 1. Validate the file ─────────────────────────────────────────────────
  if (typeof file_path !== 'string' || file_path.length === 0) {
    return _err('file_path is required.');
  }
  // path traversal guard — reject ../../etc/passwd style injection
  const resolvedPath = path.resolve(file_path);
  if (file_path.split(path.sep).some(seg => seg === '..')) {
    return _err(`File path contains traversal sequence: ${file_path}`);
  }

  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) return _err(`Not a regular file: ${file_path}`);
  } catch (e) {
    return _err(`Cannot access file: ${e.message}`);
  }

  const sizeBytes = fileStat.size;
  // /initiate requires total_bytes >= 1 and total_chunks === ceil(bytes / CHUNK_SIZE).
  if (sizeBytes < 1) return _err('File is empty — there is nothing to send.');

  const fileName    = path.basename(resolvedPath) || 'file';
  const totalChunks = Math.ceil(sizeBytes / CHUNK_SIZE);
  const costOfSend  = costCredits({ sizeBytes }).total;

  // Cap pre-check. /initiate checks the cap before the Cashu spend, so a 413 there
  // costs nothing at the Worker — but credential/issue has already taken a credit
  // from the pool by then. When the capabilities card is to hand, refuse first.
  const capBytes = deps.capabilities?.limits?.max_transfer_bytes;
  if (Number.isSafeInteger(capBytes) && capBytes > 0 && sizeBytes > capBytes) {
    return _mcpError('too_large',
      `This file is ${sizeBytes} bytes; the current per-transfer cap is ${capBytes} bytes.`,
      { size_bytes: sizeBytes, max_transfer_bytes: capBytes });
  }

  // ── 2. Local crypto — transfer key, part key, optional passphrase hash ───
  const keyBytes = generateAesKey();            // K: 32 random bytes, no network
  const partKey  = await derivePartKey(keyBytes, ['encrypt']);

  let p2shSecretHash = null;
  if (passphrase) p2shSecretHash = await hashSecret(passphrase);

  // ── 3. Credential — the only spend. Nothing has been uploaded yet. ───────
  let cred;
  try {
    cred = await issueCredential(deps);
  } catch (e) {
    if (e.paymentRequired)                 return _paymentRequired(e.paymentRequired, costOfSend);
    if (e.authFailed)                      return _mcpError('auth_failed', e.message);
    if (e instanceof CredentialProofError) return _mcpError('credential_invalid', e.message);
    if (e instanceof RefuelerApiError)     return _err(`Credential issue failed: ${e.message}`);
    return _err(`Credential issue failed: ${e.message}`);
  }

  const { uuid, credential, commitment, issuedTier, extraHeaders = {} } = cred;
  const expiresAt = Math.floor(Date.now() / 1000) + ENFORCED_EXPIRY_SECS;

  // ── 4. Initiate — headers only, no body ──────────────────────────────────
  const initiateHeaders = {
    'X-Cashu-Credential':      credential,
    'X-Credential-Commitment': commitment,
    'X-Issued-Tier':           issuedTier,
    'X-Total-Chunks':          String(totalChunks),
    'X-Total-Bytes':           String(sizeBytes),
    'X-Expiry-Timestamp':      String(expiresAt),
    // D-1 invariant: constant placeholder. The real name is in the fragment.
    'X-File-Name':             'encrypted-payload',
    ...extraHeaders,
  };
  if (p2shSecretHash)         initiateHeaders['X-P2SH-Secret-Hash']       = p2shSecretHash;
  if (destroy_after_download) initiateHeaders['X-Destroy-After-Download'] = '1';
  if (available_from)         initiateHeaders['X-Available-From']         = String(available_from);
  if (available_until)        initiateHeaders['X-Available-Until']        = String(available_until);
  if (config?.liveKey)        initiateHeaders['X-Api-Live-Key']           = config.liveKey;
  if (transfer_ref)           initiateHeaders['X-Transfer-Ref']           = transfer_ref.slice(0, 128);

  let initRes;
  try {
    initRes = await api.call('POST', `/upload/${uuid}/initiate`, { extraHeaders: initiateHeaders });
  } catch (e) {
    return _err(`Initiate failed: ${e.message}`);
  }

  if (initRes.status === 402) return _paymentRequired(initRes.body || {}, costOfSend);
  if (initRes.status === 401) {
    return _mcpError('credential_invalid', initRes.body?.error || 'Credential rejected at initiate.');
  }
  if (initRes.status === 403) {
    return _mcpError('tier_gate', initRes.body?.error ||
      'This option needs a paid subscription, which is not reachable from this server yet.');
  }
  if (initRes.status === 409) {
    return _mcpError('already_complete',
      'Credential already spent, or this transfer was already initiated.', { uuid });
  }
  if (initRes.status === 413) {
    return _mcpError('too_large', initRes.body?.error || 'File exceeds the per-transfer cap.',
      { size_bytes: sizeBytes });
  }
  if (!initRes.ok) {
    return _err(`Initiate returned HTTP ${initRes.status}: ${(initRes.body?.error || initRes.text || '').slice(0, 200)}`);
  }

  const initData     = initRes.body || {};
  const sessionToken = initData.session_token;
  if (!sessionToken) return _err('Initiate response carried no upload session token.');

  // The tail URL (part N−1) is signed for its exact length and issued once, here.
  // /urls never covers it, so without it the transfer cannot be completed.
  const tail = initData.tail_url;
  if (!tail || tail.index !== totalChunks - 1) {
    return _err(`Initiate did not return a usable tail URL for part ${totalChunks - 1}.`);
  }

  /** index → presigned URL. Seeded from initiate, extended by /urls on demand. */
  const urlMap = new Map();
  for (const u of initData.urls || []) urlMap.set(u.index, u.url);
  urlMap.set(tail.index, tail.url);

  /** /urls serves full parts 0…N−2 only. */
  const fullCount = totalChunks - 1;

  async function fetchUrlsFrom(from) {
    const res = await api.call('POST', `/upload/${uuid}/urls`, {
      body: JSON.stringify({ from, count: URL_BATCH_SIZE }),
      extraHeaders: { 'X-Upload-Session': sessionToken },
    });
    if (res.status === 401) {
      throw new SendStop('session_expired', 'The upload session expired or was already spent.');
    }
    if (!res.ok) {
      throw new SendStop('url_batch_failed',
        `Could not get presigned URLs from part ${from} (HTTP ${res.status}).`);
    }
    for (const u of res.body?.urls || []) urlMap.set(u.index, u.url);
  }

  // ── 5. Encrypt and upload, PARTS_IN_FLIGHT at a time ─────────────────────
  // chunkFile streams the plaintext from disk, so only the parts actually in
  // flight are held in memory (PARTS_IN_FLIGHT × 32 MiB), never the whole file.
  const partHashes = new Array(totalChunks);  // raw 32-byte ciphertext digests, in order
  const inFlight   = new Map();               // index → Promise

  async function uploadOne(index, bytes, isLast) {
    const expectedLen = isLast
      ? (sizeBytes - fullCount * CHUNK_SIZE) + CHUNK_TAG_BYTES
      : CHUNK_SIZE + CHUNK_TAG_BYTES;
    if (bytes.length !== expectedLen) {
      throw new SendStop('part_size_mismatch',
        `Part ${index} is ${bytes.length} bytes; the presigned URL signs ${expectedLen}.`);
    }

    const url = urlMap.get(index);
    if (!url) throw new SendStop('url_missing', `No presigned URL for part ${index}.`);

    let lastErr;
    for (let attempt = 0; attempt <= PART_RETRY_DELAYS.length; attempt++) {
      let res = null;
      try {
        res = await putPart(url, bytes, { timeoutMs: PART_TIMEOUT_MS });
      } catch (e) {
        lastErr = e;
      }

      if (res?.ok) return;

      if (res) {
        // 403 = signature invalid or URL already used — a retry cannot fix it.
        if (res.status === 403) {
          throw new SendStop('part_rejected',
            `Part ${index}: R2 rejected the presigned URL (403). ${(res.text || '').slice(0, 120)}`);
        }
        if (res.status < 500 && res.status !== 429) {
          throw new SendStop('part_rejected',
            `Part ${index}: HTTP ${res.status}. ${(res.text || '').slice(0, 120)}`);
        }
        lastErr = new Error(`HTTP ${res.status}`);
      }

      if (attempt < PART_RETRY_DELAYS.length) await sleep(PART_RETRY_DELAYS[attempt]);
    }
    throw new SendStop('part_upload_failed',
      `Part ${index} did not upload after ${PART_RETRY_DELAYS.length + 1} attempts: ${lastErr?.message}`);
  }

  try {
    for await (const { index, buffer } of chunkFile(resolvedPath, CHUNK_SIZE)) {
      if (index >= totalChunks) {
        throw new SendStop('file_changed', 'The file grew while it was being read.');
      }
      if (!urlMap.has(index) && index < fullCount) await fetchUrlsFrom(index);

      const isLast     = index === totalChunks - 1;
      const ciphertext = await encryptPart(partKey, buffer, index, totalChunks);
      partHashes[index] = blake3Chunk(ciphertext);

      if (inFlight.size >= PARTS_IN_FLIGHT) await Promise.race(inFlight.values());

      const p = uploadOne(index, ciphertext, isLast).finally(() => inFlight.delete(index));
      inFlight.set(index, p);
      // Surface a rejection at the next await rather than as an unhandled one.
      p.catch(() => {});
    }

    await Promise.all(inFlight.values());
  } catch (e) {
    // Let any still-running PUT settle so nothing rejects after we have returned.
    await Promise.allSettled(inFlight.values());
    if (e instanceof SendStop) return _mcpError(e.code, e.message, { uuid });
    return _err(`Upload failed: ${e.message}`);
  }

  for (let i = 0; i < totalChunks; i++) {
    if (!partHashes[i]) return _err(`Part ${i} was never encrypted — refusing to finalise.`);
  }

  // ── 6. Finalise — per-part digests + the ciphertext-chunk Merkle root ────
  // This is the CIPHERTEXT root: Worker-verifiable storage integrity. The
  // plaintext root is never computed here, never sent, never in any receipt.
  const { root } = buildMerkleTree(partHashes);
  let finRes;
  try {
    finRes = await api.call('POST', `/upload/${uuid}/finalise`, {
      body: JSON.stringify({
        hashes:      partHashes.map(toB64url),
        merkle_root: toB64url(root),
      }),
      extraHeaders: { 'X-Upload-Session': sessionToken },
    });
  } catch (e) {
    return _mcpError('finalise_failed',
      `Every part uploaded but finalise could not be reached: ${e.message}`, { uuid });
  }

  if (finRes.status === 409) {
    const body = finRes.body || {};
    if (body.error === 'already_complete') {
      return _mcpError('already_complete', 'This transfer was already finalised.', { uuid });
    }
    return _mcpError('incomplete',
      `Finalise says the stored set is not right (${body.error || 'incomplete'}). The transfer is not collectable.`,
      {
        uuid,
        ...(body.missing  ? { missing:  body.missing }  : {}),
        ...(body.segments ? { segments: body.segments } : {}),
      });
  }
  if (finRes.status === 401) {
    return _mcpError('session_expired', 'The upload session expired before finalise.', { uuid });
  }
  if (!finRes.ok) {
    return _mcpError('finalise_failed',
      `Finalise returned HTTP ${finRes.status}: ${(finRes.body?.error || finRes.text || '').slice(0, 200)}`,
      { uuid });
  }

  // ── 7. Share URL — link format v2 in the fragment ────────────────────────
  const fragmentBlob = assembleFragment({ keyBytes, filename: fileName, sizeBytes });
  const shareUrl = `${SHARE_BASE_URL}?uuid=${uuid}#${fragmentBlob}`;

  return _success({
    uuid,
    share_url:                    shareUrl,
    passphrase_required:          !!passphrase,
    expires_at:                   expiresAt,
    size_bytes:                   sizeBytes,
    total_parts:                  totalChunks,
    merkle_root:                  bufToHex(root),
    tree_algo:                    TREE_ALGO,
    cost_credits:                 costOfSend,
    collection_receipt_available: true,
  });
}

// ---------------------------------------------------------------------------
// Internal control-flow error — carries the envelope code to report.
// ---------------------------------------------------------------------------
class SendStop extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SendStop';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// MCP response helpers
// ---------------------------------------------------------------------------

function _success(data) {
  return [{ type: 'text', text: JSON.stringify(data) }];
}

function _mcpError(errorCode, detail, extra = {}) {
  return [{ type: 'text', text: JSON.stringify({ error: errorCode, detail, ...extra }) }];
}

function _err(detail) {
  return _mcpError('send_failed', detail);
}

/**
 * _paymentRequired — builds the §2.5 payment_required envelope.
 * Never mentions sats, ecash, or tokens in any value.
 */
function _paymentRequired(workerBody, costOfSend) {
  const code = workerBody.code || 'payment_required';
  const rail = workerBody.rail || 'identity';

  const remaining = workerBody.remaining_credits ?? 0;
  const shortfall = workerBody.shortfall_credits ?? Math.max(0, costOfSend - remaining);

  const envelope = {
    error:             'payment_required',
    code,
    rail,
    shortfall_credits: shortfall,
    payment: {
      method:        'out_of_band_v1',
      instructions:  rail === 'anonymous'
        ? 'Buy a credit block on the Refueler dashboard and add the credits to this server\'s local config.'
        : 'Request a credit top-up (or wait for your monthly reset) from your Refueler account.',
      dashboard_url: 'https://refueler.io/share/',
      offer:         null,
    },
  };

  if (code !== 'account_cancelled') envelope.remaining_credits = remaining;

  return [{ type: 'text', text: JSON.stringify(envelope) }];
}
