/**
 * crypto.js — local encryption and hashing for the Refueler MCP server
 *
 * Matches frontend/crypto.js and frontend/upload.js behaviour exactly.
 *
 * Link format v2 (MCP-Fix-1): parts are encrypted under a key derived from the
 * transfer key K with HKDF-SHA256, with a STREAM counter nonce per part — never
 * K directly, never a per-part random IV. See the part-crypto block below. The
 * reference implementation is frontend/crypto.js (derivePartKey / encryptPart);
 * known-answer vectors live in refueler-share worker/test/part-crypto.test.js.
 *
 * AAD per part: 4-byte big-endian uint32 via DataView.setUint32(0, i, false).
 * This is load-bearing — wrong AAD = silent corruption downstream. Do not alter.
 *
 * BLAKE3 = chunk integrity only. Not the auth layer. Not the passphrase hash.
 * Passphrase hash = SHA-256 only (hashSecret() — parity with nut11.js confirmed
 * at SW-MCP-2; see PARITY.md).
 */

import { randomFillSync } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { blake3 } from '@noble/hashes/blake3.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Part size: 32 MiB — must equal frontend/crypto.js CHUNK_SIZE and the Worker's
 * sweep_rules CHUNK_SIZE. /initiate 400s unless
 * total_chunks === ceil(total_bytes / CHUNK_SIZE), so this is load-bearing on the
 * wire, not a local preference.
 */
export const CHUNK_SIZE = 32 * 1024 * 1024;

/** Back-compat alias. Prefer CHUNK_SIZE. */
export const DEFAULT_CHUNK_SIZE = CHUNK_SIZE;

/** AES-GCM auth tag in bytes — a stored part is plaintext length + this. */
export const CHUNK_TAG_BYTES = 16;

/** AES-GCM auth tag length in bits */
const TAG_LENGTH_BITS = 128;

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * generateAesKey() → Uint8Array (32 bytes)
 *
 * Generates a cryptographically random 256-bit AES-GCM session key.
 * Returns raw key bytes — caller is responsible for URL-fragment delivery.
 * Key never touches the network; never stored in logs or manifests.
 */
export function generateAesKey() {
  const key = new Uint8Array(32);
  randomFillSync(key);
  return key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Part crypto — link format v2 (Share-Crypto-1). Twin of frontend/crypto.js
// derivePartKey / partNonce / partAad / encryptPart / decryptPart. Keep them
// byte-identical: a divergence here produces parts the browser cannot decrypt.
//
//   part_key = HKDF-SHA256(K, salt = empty, info = utf8("refueler.share.payload.v2") ‖ 0x00)
//   nonce_i  = 0x00 ×7 ‖ BE32(i) ‖ last   (last = 0x01 on part N−1, else 0x00)
//   AAD_i    = BE32(i)
// Stored part = AES-256-GCM(part_key, nonce_i, AAD_i, P_i) = ciphertext ‖ 16-byte tag.
//
// Every part under one key gets its own nonce (the counter), and the last-part
// flag means a reordered, dropped or appended part fails its tag. There is no IV
// in the stored object — v2 links carry no `i` field, and the presigned PUT signs
// content-length = CHUNK_SIZE + 16 exactly, so a prefixed IV would be rejected.
//
// The date seal stays on K itself with its own random IV (timestamp path).
// Links before v2 are a receiver concern only — senders make v2 and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

const _PAYLOAD_INFO = new Uint8Array([
  ...new TextEncoder().encode('refueler.share.payload.v2'), 0x00,
]);

/**
 * derivePartKey(kBytes, usages) → Promise<CryptoKey>
 * K (32 bytes) → AES-GCM key for parts. usages: ['encrypt'] or ['decrypt'].
 */
export async function derivePartKey(kBytes, usages) {
  const k = kBytes instanceof Uint8Array ? kBytes : new Uint8Array(kBytes);
  if (k.length !== 32) throw new TypeError('derivePartKey: K must be 32 bytes');
  const ikm = await globalThis.crypto.subtle.importKey('raw', k, 'HKDF', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: _PAYLOAD_INFO },
    ikm, { name: 'AES-GCM', length: 256 }, false, usages,
  );
}

/** 12-byte nonce for part i; last = true on the final part. */
export function partNonce(i, last) {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setUint32(7, i, false);
  n[11] = last ? 1 : 0;
  return n;
}

/** 4-byte AAD for part i (BE uint32 = object index = Merkle leaf index). */
export function partAad(i) {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, i, false);
  return a;
}

/** Encrypt part i of n → Uint8Array (ciphertext ‖ tag). */
export async function encryptPart(partKey, raw, i, n) {
  return new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: partNonce(i, i === n - 1), additionalData: partAad(i), tagLength: TAG_LENGTH_BITS },
    partKey,
    raw instanceof Uint8Array ? raw : new Uint8Array(raw),
  ));
}

/**
 * Decrypt part i of n → Uint8Array. Throws if the part, its index or its place
 * as last doesn't check out — the caller must treat that as an integrity
 * failure and abort, never silently discard.
 */
export async function decryptPart(partKey, ct, i, n) {
  return new Uint8Array(await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: partNonce(i, i === n - 1), additionalData: partAad(i), tagLength: TAG_LENGTH_BITS },
    partKey,
    ct instanceof Uint8Array ? ct : new Uint8Array(ct),
  ));
}

// ---------------------------------------------------------------------------
// BLAKE3 hashing
// ---------------------------------------------------------------------------

/**
 * blake3Chunk(chunkBuffer) → Uint8Array (32 bytes)
 *
 * BLAKE3 hash of a ciphertext chunk (always post-encryption).
 * Uses @noble/hashes/blake3 — pure JS, no WASM, no native bindings.
 *
 * BLAKE3 = chunk integrity only. Not the auth layer.
 *
 * @param {Uint8Array|Buffer} chunkBuffer
 * @returns {Uint8Array} 32-byte hash
 */
export function blake3Chunk(chunkBuffer) {
  const buf = chunkBuffer instanceof Uint8Array
    ? chunkBuffer
    : new Uint8Array(chunkBuffer);
  // @noble/hashes exports blake3 as a direct hash function
  return blake3(buf);
}

// NOTE: there is no blake3Root() here any more. The transfer's root is the
// RFC 6962 unbalanced ciphertext-chunk Merkle root from src/merkle.js — that is
// what POST /upload/:uuid/finalise records and what the Worker reconstructs
// before it serves a download. The old rolling concat-then-hash root matched
// nothing the Worker reads.

// ---------------------------------------------------------------------------
// File chunking
// ---------------------------------------------------------------------------

/**
 * chunkFile(filePath, chunkSizeBytes) → AsyncGenerator<{ index, buffer }>
 *
 * Reads a file from disk and yields fixed-size chunks as Uint8Array buffers.
 * The final chunk may be smaller than chunkSizeBytes.
 * An empty file yields exactly one chunk with an empty buffer.
 *
 * The caller encrypts each yielded buffer before upload.
 *
 * @param {string} filePath
 * @param {number} [chunkSizeBytes=DEFAULT_CHUNK_SIZE] — must be > 0
 * @yields {{ index: number, buffer: Uint8Array }}
 */
export async function* chunkFile(filePath, chunkSizeBytes = DEFAULT_CHUNK_SIZE) {
  if (!Number.isInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new RangeError('chunkSizeBytes must be a positive integer');
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }

  const stream = createReadStream(filePath, { highWaterMark: chunkSizeBytes });

  let index = 0;
  let carry = null; // bytes left over from the previous stream read

  for await (const chunk of stream) {
    // Node stream chunks are Buffers; normalise to Uint8Array without copy
    const incoming = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    let data;
    if (carry !== null) {
      const merged = new Uint8Array(carry.length + incoming.length);
      merged.set(carry, 0);
      merged.set(incoming, carry.length);
      data = merged;
      carry = null;
    } else {
      data = incoming;
    }

    // Emit every complete chunk
    let offset = 0;
    while (offset + chunkSizeBytes <= data.length) {
      yield { index, buffer: data.slice(offset, offset + chunkSizeBytes) };
      index++;
      offset += chunkSizeBytes;
    }

    // Keep the remainder for the next iteration
    if (offset < data.length) {
      carry = data.slice(offset);
    }
  }

  // Flush the final (possibly partial) chunk
  if (carry !== null && carry.length > 0) {
    yield { index, buffer: carry };
  } else if (index === 0) {
    // Empty file: yield one empty chunk so callers always iterate at least once
    yield { index: 0, buffer: new Uint8Array(0) };
  }
}

// ---------------------------------------------------------------------------
// Passphrase hash — parity with worker/src/nut11.js hashSecret()
// ---------------------------------------------------------------------------

/**
 * hashSecret(passphrase) → Promise<string> (lowercase hex)
 *
 * SHA-256 of the UTF-8 passphrase. Stored in the manifest as p2sh_secret_hash.
 *
 * Exact parity with worker/src/nut11.js hashSecret():
 *   - bare SHA-256, no domain tag, no salt, no prefix
 *   - returns lowercase hex string
 * See PARITY.md for the formal verification result.
 */
export async function hashSecret(passphrase) {
  const encoded = new TextEncoder().encode(passphrase);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential format v2 — a standard Cashu proof { id, amount: 1, secret, C }.
// Twin of frontend/crypto.js generateBlindedCredential / unblindSignature.
// Worker side: verifyProofV2 in worker/src/nut00.js (Y = hash_to_curve(utf8(secret)),
// k·Y == C, serial = hex(Y)). Anything else is a 401 and nothing is spent.
//
// @cashu/cashu-ts is pinned to the EXACT version the Worker and the browser run
// (4.11.0 — worker/package.json and bin/vendor-cashu.sh). Upgrade all three
// together. No hand-rolled curve maths here or anywhere (locked decision).
// ─────────────────────────────────────────────────────────────────────────────

import {
  blindMessage as _cashuBlindMessage,
  unblindSignature as _cashuUnblindSignature,
  verifyDLEQProof as _cashuVerifyDLEQProof,
  pointFromHex as _cashuPointFromHex,
} from '@cashu/cashu-ts';

/** Thrown when the issue response's NUT-12 DLEQ proof does not check out. */
export class CredentialProofError extends Error {
  constructor(message) { super(message); this.name = 'CredentialProofError'; }
}

/**
 * Step 1 → { blindedMsg, blindingFactor, secret }. Keep the result until step 2.
 * secret: 64-hex of 32 random bytes; its UTF-8 bytes are hashed to the curve (NUT-00).
 */
export function generateBlindedCredential() {
  const secretBytes = new Uint8Array(32);
  randomFillSync(secretBytes);
  const secret = bufToHex(secretBytes);
  const { B_, r } = _cashuBlindMessage(new TextEncoder().encode(secret));
  return {
    blindedMsg:     B_.toHex(true),
    blindingFactor: r.toString(16).padStart(64, '0'),
    secret,
  };
}

/**
 * Step 2. issued = the /credential/issue JSON ({ signed_point, mint_pubkey, keyset_id, dleq }),
 * blinded = generateBlindedCredential()'s result. Checks the NUT-12 DLEQ proof (the
 * signature matches the key it came with — the key is not pinned until the anonymous
 * rail), then unblinds.
 *
 * → JSON string for X-Cashu-Credential. Throws CredentialProofError on a bad or
 * missing proof, before anything is spent.
 */
export function unblindSignature(issued, blinded) {
  const { signed_point, mint_pubkey, keyset_id, dleq } = issued || {};
  if (!signed_point || !mint_pubkey || !keyset_id || !dleq?.e || !dleq?.s) {
    throw new CredentialProofError('Credential issue response missing signature, keyset id or DLEQ proof');
  }
  let C_, K, verified = false;
  try {
    C_ = _cashuPointFromHex(signed_point);
    K  = _cashuPointFromHex(mint_pubkey);
    const B_ = _cashuPointFromHex(blinded.blindedMsg);
    const proof = { e: hexToBuf(dleq.e), s: hexToBuf(dleq.s) };
    verified = _cashuVerifyDLEQProof(proof, B_, C_, K);
  } catch {
    // malformed point or out-of-range scalar — the library throws rather than returning false
  }
  if (!verified) throw new CredentialProofError('Credential DLEQ proof did not verify');
  const C = _cashuUnblindSignature(C_, BigInt('0x' + blinded.blindingFactor), K);
  return JSON.stringify({ id: keyset_id, amount: 1, secret: blinded.secret, C: C.toHex(true) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Byte helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Uint8Array | ArrayBuffer → lowercase hex. */
export function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase or uppercase hex → Uint8Array. */
export function hexToBuf(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new TypeError('hexToBuf: not an even-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// =============================================================================
// B8-1 — NUT-11 Mode 2 (Locke) pure functions — MCP in-process sign side
//
// Full repo path: refueler-mcp/src/crypto.js
// DO NOT confuse with worker/src/locke.js (verify side) or worker/src/nut11.js.
//
// hashSecret() above is UNTOUCHED. It is Mode 1 (bare SHA-256 of passphrase).
// These are a NEW, SEPARATE surface. No collision with Mode 1.
//
// Parity: worker/src/locke.js (verify) ↔ frontend/crypto.js (sign) ↔ this file (sign)
//
// Requires these packages — already present in refueler-mcp:
//   @noble/curves/secp256k1  → schnorr, secp256k1
//   @noble/hashes/sha2       → sha256, sha512
//   @noble/hashes/hkdf       → hkdf
//   @noble/hashes/pbkdf2     → pbkdf2
// =============================================================================

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';

// ---------------------------------------------------------------------------
// Locke constants (must match worker/src/locke.js exactly)
// ---------------------------------------------------------------------------

const _MCP_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'
);
const _MCP_LOCKE_HKDF_SALT = new TextEncoder().encode('refueler.locke.v1');
const _MCP_LOCKE_INFO_BASE  = 'locke_keypair';
const _MCP_DOMAIN_LOGIN     = 'refueler.locke.login.v1';
const _MCP_DOMAIN_AUTHORISE = 'refueler.locke.authorise.v1';
const _MCP_DOMAIN_REVOKE    = 'refueler.locke.revoke.v1';

// ---------------------------------------------------------------------------
// deriveLockeFromDeed
//
// BIP-39 mnemonic → secp256k1 keypair via HKDF (B8-Opus D-1).
// Locke key lives in agent process memory only — no Keychain, no WebAuthn-PRF.
// Never persisted. Never logged. Caller is responsible for zeroing after use.
//
// @param {string} mnemonic
// @returns {{ privateKey: Uint8Array, publicKey: Uint8Array }}
// ---------------------------------------------------------------------------
export function deriveLockeFromDeed(mnemonic) {
  if (typeof mnemonic !== 'string' || !mnemonic.trim()) {
    throw new TypeError('deriveLockeFromDeed: mnemonic must be a non-empty string');
  }

  const mnemonicBytes = new TextEncoder().encode(mnemonic.normalize('NFKD'));
  const saltBytes     = new TextEncoder().encode('mnemonic'); // BIP-39 passphrase = ""
  const seed = pbkdf2(sha512, mnemonicBytes, saltBytes, { c: 2048, dkLen: 64 });

  let counter = 0;
  while (true) {
    const info = counter === 0 ? _MCP_LOCKE_INFO_BASE : `${_MCP_LOCKE_INFO_BASE}.${counter}`;
    const okm  = hkdf(sha256, seed, _MCP_LOCKE_HKDF_SALT, new TextEncoder().encode(info), 32);

    let d = BigInt(0);
    for (const byte of okm) { d = (d << BigInt(8)) | BigInt(byte); }

    if (d >= BigInt(1) && d < _MCP_N) {
      return {
        privateKey: okm,
        publicKey:  secp256k1.getPublicKey(okm, true),
      };
    }
    counter++;
    if (counter > 100) throw new Error('deriveLockeFromDeed: reject-sampling failed (cosmological event)');
  }
}

// ---------------------------------------------------------------------------
// signCredential
//
// Signs a 32-byte Locke message with the Locke private key.
// Schnorr BIP-340. Message is from buildLockeLoginMsg / buildLockeAuthoriseMsg
// / buildLockeRevokeMsg — always a SHA-256 digest (32 bytes).
//
// @param {Uint8Array} privateKey  32-byte Locke private key
// @param {Uint8Array} message     32-byte message
// @returns {Uint8Array}  64-byte Schnorr signature
// ---------------------------------------------------------------------------
export function signCredential(privateKey, message) {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new TypeError('signCredential: privateKey must be Uint8Array(32)');
  }
  if (!(message instanceof Uint8Array) || message.length !== 32) {
    throw new TypeError('signCredential: message must be Uint8Array(32)');
  }
  return schnorr.sign(message, privateKey);
}

// ---------------------------------------------------------------------------
// verifyCredential
//
// Verifies a Schnorr BIP-340 signature over a Locke message.
// Accepts compressed 33-byte pubkey and strips the parity byte automatically.
//
// @param {Uint8Array|string} pubkey     33-byte compressed pubkey or 66-char hex
// @param {Uint8Array|string} signature  64-byte signature or 128-char hex
// @param {Uint8Array}        message    32-byte message
// @returns {boolean}
// ---------------------------------------------------------------------------
export function verifyCredential(pubkey, signature, message) {
  const pubBytes = _mcpEnsureBytes(pubkey, 33, 'pubkey');
  const sigBytes = _mcpEnsureBytes(signature, 64, 'signature');
  if (!(message instanceof Uint8Array) || message.length !== 32) {
    throw new TypeError('verifyCredential: message must be Uint8Array(32)');
  }
  const xonly = pubBytes.slice(1); // drop parity byte — BIP-340 is x-only
  try {
    return schnorr.verify(sigBytes, message, xonly);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// buildLockeLoginMsg
//
// msg = SHA-256(utf8("refueler.locke.login.v1") ‖ utf8(harbourUuid) ‖ hexToBytes(challengeHex))
//
// @param {string} harbourUuid
// @param {string} challengeHex  32-byte hex (64 chars)
// @returns {Uint8Array}  32-byte message
// ---------------------------------------------------------------------------
export function buildLockeLoginMsg(harbourUuid, challengeHex) {
  return _mcpBuildMsg(_MCP_DOMAIN_LOGIN, harbourUuid, _mcpHexToBytes(challengeHex, 32, 'challengeHex'));
}

// ---------------------------------------------------------------------------
// buildLockeAuthoriseMsg
//
// msg = SHA-256(utf8("refueler.locke.authorise.v1") ‖ utf8(harbourUuid) ‖ hexToBytes(newPubkeyHex))
//
// @param {string} harbourUuid
// @param {string} newPubkeyHex  33-byte compressed pubkey hex (66 chars)
// @returns {Uint8Array}  32-byte message
// ---------------------------------------------------------------------------
export function buildLockeAuthoriseMsg(harbourUuid, newPubkeyHex) {
  return _mcpBuildMsg(_MCP_DOMAIN_AUTHORISE, harbourUuid, _mcpHexToBytes(newPubkeyHex, 33, 'newPubkeyHex'));
}

// ---------------------------------------------------------------------------
// buildLockeRevokeMsg
//
// msg = SHA-256(utf8("refueler.locke.revoke.v1") ‖ utf8(harbourUuid) ‖ hexToBytes(targetPubkeyHex))
//
// @param {string} harbourUuid
// @param {string} targetPubkeyHex  33-byte compressed pubkey hex (66 chars)
// @returns {Uint8Array}  32-byte message
// ---------------------------------------------------------------------------
export function buildLockeRevokeMsg(harbourUuid, targetPubkeyHex) {
  return _mcpBuildMsg(_MCP_DOMAIN_REVOKE, harbourUuid, _mcpHexToBytes(targetPubkeyHex, 33, 'targetPubkeyHex'));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _mcpHexToBytes(hex, expectedLen, name) {
  if (typeof hex !== 'string' || hex.length !== expectedLen * 2 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new TypeError(`${name} must be ${expectedLen}-byte hex (${expectedLen * 2} chars), got "${hex}"`);
  }
  const bytes = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function _mcpEnsureBytes(val, expectedLen, name) {
  if (typeof val === 'string') return _mcpHexToBytes(val, expectedLen, name);
  if (val instanceof Uint8Array && val.length === expectedLen) return val;
  throw new TypeError(`${name} must be Uint8Array(${expectedLen}) or ${expectedLen * 2}-char hex`);
}

function _mcpBuildMsg(domain, harbourUuid, extraBytes) {
  if (!harbourUuid) throw new TypeError('harbourUuid required');
  const enc = new TextEncoder();
  const t = enc.encode(domain), u = enc.encode(harbourUuid);
  const combined = new Uint8Array(t.length + u.length + extraBytes.length);
  combined.set(t); combined.set(u, t.length); combined.set(extraBytes, t.length + u.length);
  return sha256(combined);
}
