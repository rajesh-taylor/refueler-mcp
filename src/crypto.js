/**
 * crypto.js — local encryption and hashing for the Refueler MCP server
 *
 * Matches frontend/crypto.js and frontend/upload.js behaviour exactly.
 *
 * AAD per chunk: 4-byte big-endian uint32 via DataView.setUint32(0, i, false).
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

/** Default chunk size: 8 MiB — matches frontend/upload.js */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

/** AES-GCM IV length in bytes */
const IV_LENGTH = 12;

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

// ---------------------------------------------------------------------------
// AES-GCM encryption / decryption
// ---------------------------------------------------------------------------

/**
 * encryptChunk(keyBytes, chunkIndex, plaintextBuffer) → Promise<Uint8Array>
 *
 * Encrypts a single chunk with AES-256-GCM.
 *
 * AAD = 4-byte big-endian uint32(chunkIndex).
 * Matches DataView.setUint32(0, i, false) in frontend/crypto.js exactly.
 *
 * IV = 12 random bytes prepended to the ciphertext.
 * Output layout: [ IV (12 bytes) | ciphertext | auth tag (16 bytes) ]
 *
 * @param {Uint8Array}        keyBytes       — 32-byte AES key
 * @param {number}            chunkIndex     — zero-based chunk index (uint32)
 * @param {Uint8Array|Buffer} plaintextBuffer
 * @returns {Promise<Uint8Array>}
 */
export async function encryptChunk(keyBytes, chunkIndex, plaintextBuffer) {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) {
    throw new TypeError('keyBytes must be a 32-byte Uint8Array');
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xFFFFFFFF) {
    throw new RangeError('chunkIndex must be a non-negative uint32');
  }

  // AAD: 4-byte big-endian uint32 — load-bearing, must match frontend exactly
  const aad = new Uint8Array(4);
  new DataView(aad.buffer).setUint32(0, chunkIndex, false); // false = big-endian

  // Random 12-byte IV
  const iv = new Uint8Array(IV_LENGTH);
  randomFillSync(iv);

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const ciphertextWithTag = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_LENGTH_BITS },
    cryptoKey,
    plaintextBuffer instanceof Uint8Array ? plaintextBuffer : new Uint8Array(plaintextBuffer),
  );

  // Output: [ IV (12) | ciphertext+tag ]
  const output = new Uint8Array(IV_LENGTH + ciphertextWithTag.byteLength);
  output.set(iv, 0);
  output.set(new Uint8Array(ciphertextWithTag), IV_LENGTH);
  return output;
}

/**
 * decryptChunk(keyBytes, chunkIndex, encryptedBuffer) → Promise<Uint8Array>
 *
 * Inverse of encryptChunk. Used in round-trip tests and by the download path.
 * Will throw (DOMException) if the auth tag fails — caller must treat this as
 * an integrity failure and abort, never silently discard.
 *
 * @param {Uint8Array}        keyBytes
 * @param {number}            chunkIndex
 * @param {Uint8Array|Buffer} encryptedBuffer — [ IV (12) | ciphertext+tag ]
 * @returns {Promise<Uint8Array>}
 */
export async function decryptChunk(keyBytes, chunkIndex, encryptedBuffer) {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) {
    throw new TypeError('keyBytes must be a 32-byte Uint8Array');
  }

  const buf = encryptedBuffer instanceof Uint8Array
    ? encryptedBuffer
    : new Uint8Array(encryptedBuffer);

  if (buf.length < IV_LENGTH + 16) {
    throw new RangeError('encryptedBuffer too short to contain IV + auth tag');
  }

  const iv = buf.slice(0, IV_LENGTH);
  const ciphertextWithTag = buf.slice(IV_LENGTH);

  const aad = new Uint8Array(4);
  new DataView(aad.buffer).setUint32(0, chunkIndex, false);

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_LENGTH_BITS },
    cryptoKey,
    ciphertextWithTag,
  );

  return new Uint8Array(plaintext);
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

/**
 * blake3Root(chunkHashes) → Uint8Array (32 bytes)
 *
 * Rolling BLAKE3 root from an array of per-chunk hashes.
 * Matches frontend/crypto.js: concatenate all 32-byte chunk hashes in order,
 * then BLAKE3-hash the concatenation.
 *
 * Note: full Merkle-tree verification is blocked until B9. This value proves
 * the chunk set was consistent at upload time; it does not prove end-to-end
 * file integrity on its own.
 *
 * @param {Uint8Array[]} chunkHashes — ordered array of 32-byte hashes
 * @returns {Uint8Array} 32-byte root hash
 */
export function blake3Root(chunkHashes) {
  if (!Array.isArray(chunkHashes) || chunkHashes.length === 0) {
    throw new TypeError('chunkHashes must be a non-empty array');
  }

  const concat = new Uint8Array(chunkHashes.length * 32);
  for (let i = 0; i < chunkHashes.length; i++) {
    const h = chunkHashes[i];
    if (!(h instanceof Uint8Array) || h.length !== 32) {
      throw new TypeError(`chunkHashes[${i}] must be a 32-byte Uint8Array`);
    }
    concat.set(h, i * 32);
  }

  return blake3Chunk(concat);
}

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
