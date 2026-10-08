/**
 * src/merkle.js — ciphertext-chunk Merkle tree (MCP-Fix-1)
 *
 * Node twin of refueler-share `frontend/merkle.js` and `worker/src/merkle.js`.
 * RFC 6962 unbalanced, domain-separated (0x00 leaf / 0x01 node), BLAKE3 node hash.
 *
 * PARITY IS THE ENTIRE POINT. This module must reproduce, byte-for-byte, the roots
 * the browser and the Worker produce from identical chunk digests. A one-byte
 * divergence silently corrupts every merkle_root and surfaces only as a 409 wall at
 * download (the Worker reconstructs the root before it serves the first byte).
 * TEST_VECTORS below are the shared parity contract with both other modules —
 * if a vector fails, the port is wrong. Fix the code, never the vectors.
 *
 * BLAKE3 source: @noble/hashes (pure JS). Parity holds because every side computes
 * the standardised BLAKE3-256 digest: identical bytes in, identical root out.
 *
 * This is the CIPHERTEXT-chunk root — Worker-verifiable storage integrity only.
 * The plaintext blake3PlaintextRoot never enters this module, the Worker, or any
 * receipt (invariant).
 */

import { blake3 } from '@noble/hashes/blake3.js';

/** Pinned. Any change is a NEW version string, never an in-place edit. */
export const TREE_ALGO = 'rfc6962-unbalanced-blake3-v1';

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;
const DIGEST_LEN  = 32;

/** leaf_hash = BLAKE3(0x00 ‖ chunk_ciphertext_digest_i) */
function leafHash(digest) {
  const buf = new Uint8Array(1 + DIGEST_LEN);
  buf[0] = LEAF_PREFIX;
  buf.set(digest, 1);
  return blake3(buf);
}

/** node_hash = BLAKE3(0x01 ‖ left ‖ right) */
function nodeHash(left, right) {
  const buf = new Uint8Array(1 + DIGEST_LEN + DIGEST_LEN);
  buf[0] = NODE_PREFIX;
  buf.set(left, 1);
  buf.set(right, 1 + DIGEST_LEN);
  return blake3(buf);
}

function assertLeaves(leafHashes) {
  if (!Array.isArray(leafHashes)) {
    throw new TypeError('merkle: leafHashes must be an array of Uint8Array');
  }
  if (leafHashes.length === 0) {
    // chunk_count is always >= 1; an empty tree has no committed root.
    throw new RangeError('merkle: leafHashes must be non-empty (chunk_count >= 1)');
  }
  for (let i = 0; i < leafHashes.length; i++) {
    const h = leafHashes[i];
    if (!(h instanceof Uint8Array) || h.length !== DIGEST_LEN) {
      throw new TypeError(`merkle: leaf ${i} must be a 32-byte Uint8Array`);
    }
  }
}

/**
 * buildMerkleTree(leafHashes) → { root: Uint8Array, layers: Uint8Array[][] }
 *
 * leafHashes are the raw 32-byte per-chunk ciphertext digests, in big-endian
 * chunk order. layers[0] is the domain-separated leaf layer; the final layer
 * is [root].
 */
export function buildMerkleTree(leafHashes) {
  assertLeaves(leafHashes);

  const leaves = new Array(leafHashes.length);
  for (let i = 0; i < leafHashes.length; i++) {
    leaves[i] = leafHash(leafHashes[i]);
  }

  const layers = [leaves];
  let current = leaves;

  // Fold pairwise. No padding: an odd tail node is promoted unchanged to the
  // next layer (RFC 6962 unbalanced). No duplicate-last-leaf (CVE-2012-2459),
  // no zero-pad. chunk_count in the manifest closes the residual ambiguity.
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < current.length; i += 2) {
      next.push(nodeHash(current[i], current[i + 1]));
    }
    if (current.length % 2 === 1) {
      next.push(current[current.length - 1]);
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0], layers };
}

/**
 * reconstructRoot(leafHashes) → Uint8Array
 * Delegates to buildMerkleTree so the two exports can never drift.
 */
export function reconstructRoot(leafHashes) {
  return buildMerkleTree(leafHashes).root;
}

// ---------------------------------------------------------------------------
// Parity vectors (N = 1, 2, 3-odd, 4) — HARD pass/fail gate.
// Identical to frontend/merkle.js and worker/src/merkle.js. Deterministic leaves:
//   test leaf i = BLAKE3(utf8("refueler-share/merkle/v1 leaf " + i))
// so a third party reproduces every expected root from this file alone.
// NEVER edit these to match the code; a mismatch means the port is wrong.
// ---------------------------------------------------------------------------

const _enc = new TextEncoder();

/** Exposed for tests — the deterministic leaf digest for index i. */
export function testLeaf(i) {
  return blake3(_enc.encode('refueler-share/merkle/v1 leaf ' + i));
}

export const TEST_VECTORS = {
  algo: TREE_ALGO,
  // N -> expected root hex over test leaves [0 .. N-1]
  1: '4cd7f5f299a2b771456696c501cf2b8f81be7b8f7c2bf1e2a788bddf3f0a50a8',
  2: '8b17cfc93a3cd63287d3a7392c7de27e4b81709e721f77ef8045deee80308b42',
  3: '10ea1b69823bb8b87b541fe6530cc24589201887ba520896ab317f795b5a3ea1',
  4: 'a9b25513176fc8eb9ee938569ba8c75b1bd7078cb5ac45b77bce9c09a998e7a7',
};
