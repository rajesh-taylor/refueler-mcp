/**
 * test/crypto.test.js — unit tests for src/crypto.js
 *
 * node:test only — no vitest, no jest, no mocha.
 * Test credentials use rfs_test_ prefix per CLAUDE.md.
 *
 * Part encryption (derivePartKey / encryptPart / decryptPart) and the v2 fragment
 * are covered by test/part-crypto.test.js against the vectors shared with
 * refueler-share. The Merkle root is covered by test/merkle.test.js. This file
 * holds what is left: key generation, the chunk digest, chunking and hashSecret.
 *
 * Run: node --test test/crypto.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  generateAesKey,
  blake3Chunk,
  chunkFile,
  hashSecret,
  CHUNK_SIZE,
} from '../src/crypto.js';

// ---------------------------------------------------------------------------
// generateAesKey
// ---------------------------------------------------------------------------

describe('generateAesKey', () => {
  it('returns a 32-byte Uint8Array', () => {
    const key = generateAesKey();
    assert.ok(key instanceof Uint8Array, 'should be Uint8Array');
    assert.equal(key.length, 32, 'should be 32 bytes');
  });

  it('produces different keys on successive calls', () => {
    const a = generateAesKey();
    const b = generateAesKey();
    // Probability of collision: 2^-256 — safe to assert
    assert.notDeepEqual(a, b, 'consecutive keys must differ');
  });
});

// ---------------------------------------------------------------------------
// BLAKE3 chunk hash — determinism
// ---------------------------------------------------------------------------

describe('blake3Chunk', () => {
  it('returns a 32-byte Uint8Array', () => {
    const hash = blake3Chunk(new TextEncoder().encode('rfs_test_blake3'));
    assert.ok(hash instanceof Uint8Array, 'should be Uint8Array');
    assert.equal(hash.length, 32, 'should be 32 bytes');
  });

  it('is deterministic for the same input', () => {
    const data = new TextEncoder().encode('rfs_test_determinism');
    const h1 = blake3Chunk(data);
    const h2 = blake3Chunk(data);
    assert.deepEqual(h1, h2, 'same input must produce same hash');
  });

  it('produces different hashes for different inputs', () => {
    const h1 = blake3Chunk(new TextEncoder().encode('rfs_test_a'));
    const h2 = blake3Chunk(new TextEncoder().encode('rfs_test_b'));
    assert.notDeepEqual(h1, h2, 'different inputs must produce different hashes');
  });

  it('accepts a Buffer input', () => {
    const buf = Buffer.from('rfs_test_buffer_input');
    const hash = blake3Chunk(buf);
    assert.ok(hash instanceof Uint8Array);
    assert.equal(hash.length, 32);
  });

  it('matches the official BLAKE3 test vector for empty input', () => {
    // BLAKE3 of empty input — first 32 bytes of the official test vector
    // Verified against https://github.com/BLAKE3-team/BLAKE3/blob/master/test_vectors/test_vectors.json
    const expected = 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262';
    const hash = blake3Chunk(new Uint8Array(0));
    const hex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
    assert.equal(hex, expected, 'empty-input BLAKE3 must match official test vector');
  });
});

// ---------------------------------------------------------------------------
// chunkFile
// ---------------------------------------------------------------------------

describe('chunkFile', async () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rfs_test_chunk_'));
  });

  it('yields correct chunks for a file smaller than one chunk', async () => {
    const content = new TextEncoder().encode('rfs_test_small_file_content');
    const filePath = join(tmpDir, 'small.bin');
    await writeFile(filePath, content);

    const chunks = [];
    for await (const chunk of chunkFile(filePath, CHUNK_SIZE)) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 1, 'small file should produce exactly one chunk');
    assert.equal(chunks[0].index, 0);
    assert.deepEqual(chunks[0].buffer, content);

    await unlink(filePath);
  });

  it('yields multiple chunks for a file larger than chunkSizeBytes', async () => {
    const chunkSize = 100;
    const content = new Uint8Array(350); // 3 full chunks + 1 partial
    for (let i = 0; i < content.length; i++) content[i] = i % 256;

    const filePath = join(tmpDir, 'multi.bin');
    await writeFile(filePath, content);

    const chunks = [];
    for await (const chunk of chunkFile(filePath, chunkSize)) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 4, 'should produce 4 chunks (3 full + 1 partial)');
    assert.equal(chunks[0].index, 0);
    assert.equal(chunks[1].index, 1);
    assert.equal(chunks[2].index, 2);
    assert.equal(chunks[3].index, 3);

    // Verify each chunk's content
    assert.equal(chunks[0].buffer.length, 100);
    assert.equal(chunks[1].buffer.length, 100);
    assert.equal(chunks[2].buffer.length, 100);
    assert.equal(chunks[3].buffer.length, 50);

    // Reassemble and verify no data loss or corruption
    const reassembled = new Uint8Array(350);
    let offset = 0;
    for (const { buffer } of chunks) {
      reassembled.set(buffer, offset);
      offset += buffer.length;
    }
    assert.deepEqual(reassembled, content, 'reassembled content must match original');

    await unlink(filePath);
  });

  it('yields exactly one empty chunk for an empty file', async () => {
    const filePath = join(tmpDir, 'empty.bin');
    await writeFile(filePath, new Uint8Array(0));

    const chunks = [];
    for await (const chunk of chunkFile(filePath)) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 1, 'empty file should produce one chunk');
    assert.equal(chunks[0].index, 0);
    assert.equal(chunks[0].buffer.length, 0);

    await unlink(filePath);
  });

  it('yields exactly one chunk when file size equals chunkSizeBytes', async () => {
    const chunkSize = 64;
    const content = new Uint8Array(64).fill(0x42);
    const filePath = join(tmpDir, 'exact.bin');
    await writeFile(filePath, content);

    const chunks = [];
    for await (const chunk of chunkFile(filePath, chunkSize)) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].buffer, content);

    await unlink(filePath);
  });

  it('throws on a non-existent path', async () => {
    await assert.rejects(
      async () => {
        // Must consume at least one iteration to trigger the stat
        // eslint-disable-next-line no-unused-vars
        for await (const _ of chunkFile('/no/such/file/rfs_test_missing')) { }
      },
      (err) => err instanceof Error,
      'non-existent file must throw',
    );
  });

  it('throws on invalid chunkSizeBytes', async () => {
    // We need a real file path to get past the guard; create a dummy
    const filePath = join(tmpDir, 'guard.bin');
    await writeFile(filePath, Buffer.from('x'));

    await assert.rejects(
      async () => {
        for await (const _ of chunkFile(filePath, 0)) { }
      },
      /positive integer/,
      'zero chunkSizeBytes must throw',
    );

    await unlink(filePath);
  });
});

// ---------------------------------------------------------------------------
// hashSecret — parity with nut11.js
// ---------------------------------------------------------------------------

describe('hashSecret', () => {
  it('returns a 64-character lowercase hex string', async () => {
    const hex = await hashSecret('rfs_test_passphrase');
    assert.equal(typeof hex, 'string');
    assert.equal(hex.length, 64, 'SHA-256 hex is 64 chars');
    assert.match(hex, /^[0-9a-f]{64}$/, 'must be lowercase hex');
  });

  it('matches the parity test vector', async () => {
    // SHA-256("correct horse battery staple")
    const expected = 'c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a';
    const result = await hashSecret('correct horse battery staple');
    assert.equal(result, expected, 'must match PARITY.md test vector');
  });

  it('is deterministic', async () => {
    const a = await hashSecret('rfs_test_determinism_check');
    const b = await hashSecret('rfs_test_determinism_check');
    assert.equal(a, b, 'same input must produce same hash');
  });

  it('differs for different inputs', async () => {
    const a = await hashSecret('rfs_test_pass_a');
    const b = await hashSecret('rfs_test_pass_b');
    assert.notEqual(a, b, 'different inputs must produce different hashes');
  });
});
