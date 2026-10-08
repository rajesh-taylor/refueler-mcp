/**
 * test/merkle.test.js — ciphertext-chunk Merkle tree parity (MCP-Fix-1)
 *
 * node:test only. No vitest.
 *
 * TEST_VECTORS in src/merkle.js are the shared parity contract with
 * refueler-share frontend/merkle.js and worker/src/merkle.js. A failure here
 * means this port is wrong — fix the code, never the vectors. A wrong root is
 * silent at upload and surfaces only as a 409 wall at download, because the
 * Worker reconstructs the root before it serves the first byte.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMerkleTree, reconstructRoot, testLeaf, TEST_VECTORS, TREE_ALGO,
} from '../src/merkle.js';

const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

function leaves(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(testLeaf(i));
  return out;
}

describe('merkle — pinned parity vectors', () => {
  test('tree algo string is the pinned one', () => {
    assert.equal(TREE_ALGO, 'rfc6962-unbalanced-blake3-v1');
    assert.equal(TEST_VECTORS.algo, TREE_ALGO);
  });

  for (const n of [1, 2, 3, 4]) {
    test(`N = ${n}: root matches the browser and the Worker`, () => {
      const { root, layers } = buildMerkleTree(leaves(n));
      assert.equal(hex(root), TEST_VECTORS[n],
        `root for N=${n} diverged — the port is wrong; do not touch the vectors`);
      assert.equal(hex(layers[layers.length - 1][0]), hex(root));
    });
  }

  test('reconstructRoot and buildMerkleTree cannot drift', () => {
    for (const n of [1, 2, 3, 4, 5, 9]) {
      assert.equal(hex(reconstructRoot(leaves(n))), hex(buildMerkleTree(leaves(n)).root));
    }
  });
});

describe('merkle — structure', () => {
  test('an odd tail node is promoted, never duplicated (CVE-2012-2459)', () => {
    // N=3 must not equal the root of the duplicate-last-leaf tree over [0,1,2,2].
    const three = hex(buildMerkleTree(leaves(3)).root);
    const dup   = hex(buildMerkleTree([testLeaf(0), testLeaf(1), testLeaf(2), testLeaf(2)]).root);
    assert.notEqual(three, dup);
  });

  test('leaf order is load-bearing', () => {
    const a = hex(buildMerkleTree([testLeaf(0), testLeaf(1)]).root);
    const b = hex(buildMerkleTree([testLeaf(1), testLeaf(0)]).root);
    assert.notEqual(a, b);
  });

  test('layer count grows as ceil(log2(N)) + 1', () => {
    assert.equal(buildMerkleTree(leaves(1)).layers.length, 1);
    assert.equal(buildMerkleTree(leaves(2)).layers.length, 2);
    assert.equal(buildMerkleTree(leaves(3)).layers.length, 3);
    assert.equal(buildMerkleTree(leaves(4)).layers.length, 3);
  });
});

describe('merkle — input validation', () => {
  test('an empty leaf set is refused (chunk_count is always >= 1)', () => {
    assert.throws(() => buildMerkleTree([]), RangeError);
  });

  test('a non-array is refused', () => {
    assert.throws(() => buildMerkleTree(null), TypeError);
  });

  test('a leaf that is not a 32-byte Uint8Array is refused', () => {
    assert.throws(() => buildMerkleTree([new Uint8Array(31)]), TypeError);
    assert.throws(() => buildMerkleTree([Array.from(testLeaf(0))]), TypeError);
  });
});
