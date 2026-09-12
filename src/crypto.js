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
import { blake3 } from '@noble/hashes/blake3';

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
