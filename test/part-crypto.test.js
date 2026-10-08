/**
 * test/part-crypto.test.js — part key schedule and link format v2 (MCP-Fix-1)
 *
 * node:test only. No vitest.
 *
 * The vectors below are copied verbatim from refueler-share
 * `worker/test/part-crypto.test.js`, where they were produced by the BROWSER's
 * own frontend/crypto.js (and cross-checked against node:crypto). Passing them
 * here means this server's parts are byte-identical to the browser's.
 *
 *   part_key = HKDF-SHA256(K, salt = empty, info = utf8("refueler.share.payload.v2") ‖ 0x00)
 *   nonce_i  = 0x00 ×7 ‖ BE32(i) ‖ last      AAD_i = BE32(i)
 *
 * NEVER edit a vector to make a test pass. A mismatch means this port is wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePartKey, partNonce, partAad, encryptPart, decryptPart, CHUNK_SIZE,
} from '../src/crypto.js';
import { assembleFragment, parseFragment } from '../src/fragment.js';

const hex   = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const utf8  = (s) => new TextEncoder().encode(s);
const b64u  = (bytes) => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const frag  = (obj) => b64u(utf8(JSON.stringify(obj)));
const sha256 = async (b) => hex(await crypto.subtle.digest('SHA-256', b));

// ─── Vectors (shared with refueler-share) ────────────────────────────────────
const K        = Uint8Array.from({ length: 32 }, (_, i) => i);   // 00 01 .. 1f
const INFO     = '72656675656c65722e73686172652e7061796c6f61642e763200';
const PART_KEY = '071ab966413cac37cbf2a65ebe81ad4da4049b2ecf665ce219891f073c231727';
const P = [
  new Uint8Array(64),
  Uint8Array.from({ length: 64 }, (_, i) => i),
  utf8('refueler share v2 tail'),
];
const T1 = {
  nonces: ['000000000000000000000000', '000000000000000000000100', '000000000000000000000201'],
  aads:   ['00000000', '00000001', '00000002'],
  C: [
    'cf47ee88c5c37583842f70540588361ba8d0431f7d6759d7dc28e8c861d6367fbde366c2d2cc88a8daab89fda2943b962c327fae94522385539c91c46cbd55dddfa4ea7f052da674b103f22c01d2453b',
    '78c1270ac7411c536825378da89b0d3b57cfff1ef5b68268352c5d6a9410ea5bf9b3d1f9dd89b9257b7b57163a7a72e54940845b6f576af1f6d9e9fbdab0bdf40a2a7f8ccf7c623fa9b7c2ef59ca517e',
    '61122800f308c8ca48965584e0d6085da38bb5bad574a434760d80aacb1a3ce67124232ab404',
  ],
};
const T2 = {
  nonce: '000000000000000000000001',
  C: '88b66ec651266c7222c3d1da3f5d544d85688199515e75129211588dc55681e47c833567470c',
};
const T3 = {
  len: 33554448,
  sha256: '41ab6071f878149bc764b6e78d14b9fe12fa70397e504cedf998a400a3d7439a',
  tag: '8cbbb1515c359c14696240207fe6b3c5',
};
const T4 = 'eyJ2IjoyLCJrIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EeEFSRWhNVUZSWVhHQmthR3h3ZEhoOCIsIm4iOiJ0ZXN0LmJpbiIsInoiOjMzNTU0NDU1fQ';

const encKey = () => derivePartKey(K, ['encrypt']);
const decKey = () => derivePartKey(K, ['decrypt']);

// ─── 1. Known answers ────────────────────────────────────────────────────────
describe('part key schedule — known answers', () => {
  test('HKDF info and part key match the vector', async () => {
    assert.equal(hex(new Uint8Array([...utf8('refueler.share.payload.v2'), 0])), INFO);
    const ikm  = await crypto.subtle.importKey('raw', K, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: unhex(INFO) }, ikm, 256);
    assert.equal(hex(bits), PART_KEY);
  });

  test('T1: nonces, AADs and ciphertexts for N = 3', async () => {
    const pk = await encKey();
    for (let i = 0; i < 3; i++) {
      assert.equal(hex(partNonce(i, i === 2)), T1.nonces[i]);
      assert.equal(hex(partAad(i)), T1.aads[i]);
      assert.equal(hex(await encryptPart(pk, P[i], i, 3)), T1.C[i]);
    }
  });

  test('T2: a single part carries the last flag on index 0', async () => {
    assert.equal(hex(partNonce(0, true)), T2.nonce);
    assert.equal(hex(await encryptPart(await encKey(), P[2], 0, 1)), T2.C);
  });

  test('T3: full-size part (CHUNK_SIZE zeros, index 0 of 2) — length, sha256, tag', async () => {
    assert.equal(CHUNK_SIZE, 33554432);
    const c = await encryptPart(await encKey(), new Uint8Array(CHUNK_SIZE), 0, 2);
    assert.equal(c.length, T3.len);
    assert.equal(await sha256(c), T3.sha256);
    assert.equal(hex(c.subarray(c.length - 16)), T3.tag);
  });

  test('the part key is not K: a K-keyed decrypt of a part fails', async () => {
    const kKey = await crypto.subtle.importKey('raw', K, 'AES-GCM', false, ['decrypt']);
    await assert.rejects(() => crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: partNonce(0, false), additionalData: partAad(0) }, kKey, unhex(T1.C[0])));
  });

  test('derivePartKey refuses a K that is not 32 bytes', async () => {
    await assert.rejects(() => derivePartKey(new Uint8Array(31), ['encrypt']), TypeError);
  });
});

// ─── 2. Properties ───────────────────────────────────────────────────────────
describe('part encryption — properties', () => {
  test('keystreams differ across parts: C0 ⊕ C1 ≠ P0 ⊕ P1', async () => {
    const pk = await encKey();
    const p0 = crypto.getRandomValues(new Uint8Array(4096));
    const p1 = crypto.getRandomValues(new Uint8Array(4096));
    const c0 = await encryptPart(pk, p0, 0, 2);
    const c1 = await encryptPart(pk, p1, 1, 2);
    let same = true;
    for (let j = 0; j < 4096; j++) if ((c0[j] ^ c1[j]) !== (p0[j] ^ p1[j])) { same = false; break; }
    assert.equal(same, false);
  });

  test('stored part = plaintext + 16 bytes', async () => {
    const c = await encryptPart(await encKey(), new Uint8Array(1000), 0, 1);
    assert.equal(c.length, 1016);
  });

  test('re-encrypting part i with a freshly derived key gives identical bytes', async () => {
    const p = crypto.getRandomValues(new Uint8Array(2048));
    const a = await encryptPart(await encKey(), p, 1, 3);
    const b = await encryptPart(await encKey(), p, 1, 3);
    assert.equal(hex(a), hex(b));
  });

  test('round trip for every part', async () => {
    const pk = await decKey();
    for (let i = 0; i < 3; i++) {
      assert.equal(hex(await decryptPart(pk, unhex(T1.C[i]), i, 3)), hex(P[i]));
    }
  });

  test('truncation refused: part 1 of 3 opened as the last of 2 throws', async () => {
    const pk = await decKey();
    await assert.rejects(() => decryptPart(pk, unhex(T1.C[1]), 1, 2));
  });

  test('extension refused: the last part opened as a middle part throws', async () => {
    const pk = await decKey();
    await assert.rejects(() => decryptPart(pk, unhex(T1.C[2]), 2, 4));
  });

  test('reorder refused: part 1 served as part 0 throws', async () => {
    const pk = await decKey();
    await assert.rejects(() => decryptPart(pk, unhex(T1.C[1]), 0, 3));
  });
});

// ─── 3. Fragment ─────────────────────────────────────────────────────────────
describe('link format v2 — fragment', () => {
  test('assembles v2 (v, k, n, z; no i) and parses back', () => {
    const f = assembleFragment({ keyBytes: K, filename: 'test.bin', sizeBytes: 33554455 });
    assert.equal(f, T4);
    const json = JSON.parse(Buffer.from(f.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.deepEqual(Object.keys(json), ['v', 'k', 'n', 'z']);
    const p = parseFragment(f);
    assert.equal(p.v, 2);
    assert.equal(p.filename, 'test.bin');
    assert.equal(p.sizeBytes, 33554455);
    assert.equal(p.ivBytes, null);
    assert.equal(p.sealNonce, null);
    assert.equal(p.legacy, false);
    assert.equal(hex(p.keyBytes), hex(K));
  });

  test('assembles s between n and z when a seal nonce is given', () => {
    const sn = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    const f = assembleFragment({ keyBytes: K, filename: 'a.txt', sealNonce: sn, sizeBytes: 5 });
    const json = JSON.parse(Buffer.from(f.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.deepEqual(Object.keys(json), ['v', 'k', 'n', 's', 'z']);
    assert.equal(hex(parseFragment(f).sealNonce), hex(sn));
  });

  test('T4 vector: z gives the part count the receiver checks', () => {
    const p = parseFragment(T4);
    assert.equal(p.v, 2);
    assert.equal(p.sizeBytes, 33554455);
    assert.equal(Math.ceil(p.sizeBytes / CHUNK_SIZE), 2);
  });

  test('assembleFragment refuses a missing size or a short key', () => {
    assert.throws(() => assembleFragment({ keyBytes: K, filename: 'x' }), TypeError);
    assert.throws(() => assembleFragment({ keyBytes: K.slice(0, 31), filename: 'x', sizeBytes: 1 }), TypeError);
  });

  const k = b64u(K);
  const malformed = [
    ['no z',          { v: 2, k, n: 'x' }],
    ['z = 0',         { v: 2, k, n: 'x', z: 0 }],
    ['z not integer', { v: 2, k, n: 'x', z: 1.5 }],
    ['z as string',   { v: 2, k, n: 'x', z: '10' }],
    ['31-byte k',     { v: 2, k: b64u(K.slice(0, 31)), n: 'x', z: 1 }],
    ['33-byte k',     { v: 2, k: b64u(new Uint8Array(33)), n: 'x', z: 1 }],
    ['no k',          { v: 2, n: 'x', z: 1 }],
    ['no n',          { v: 2, k, z: 1 }],
    ['empty n',       { v: 2, k, n: '', z: 1 }],
    ['empty s',       { v: 2, k, n: 'x', s: '', z: 1 }],
  ];
  for (const [label, obj] of malformed) {
    test(`v2 with ${label} throws (never read as a legacy key)`, () => {
      assert.throws(() => parseFragment(frag(obj)));
    });
  }

  test('v1 links still parse as before (key, IV, name, optional z)', () => {
    const iv = Uint8Array.from({ length: 12 }, (_, i) => 100 + i);
    const p = parseFragment(frag({ v: 1, k: b64u(K), i: b64u(iv), n: 'old.bin', z: 42 }));
    assert.equal(p.v, 1);
    assert.equal(p.filename, 'old.bin');
    assert.equal(p.sizeBytes, 42);
    assert.equal(p.legacy, false);
    assert.equal(hex(p.ivBytes), hex(iv));
    assert.equal(parseFragment(frag({ v: 1, k: b64u(K), i: b64u(iv), n: 'old.bin' })).sizeBytes, null);
  });

  test('pre-v1 links (raw key, no JSON) still parse as legacy', () => {
    const p = parseFragment(b64u(K));
    assert.equal(p.legacy, true);
    assert.equal(hex(p.keyBytes), hex(K));
  });
});

// ─── 4. Cross-check against the browser's own module ─────────────────────────
// Byte equality with the vectors above already proves parity, because those
// vectors ARE the browser's bytes. This runs the other direction as well: the
// browser's decryptPart opening a part this server encrypted.
//
// Skipped unless REFUELER_SHARE_DIR points at a refueler-share checkout, so a
// clean CI without the sibling repo still passes.
describe('cross-check: frontend/crypto.js decrypts an MCP-encrypted part', () => {
  const shareDir = process.env.REFUELER_SHARE_DIR;

  test('round trip through the browser module', { skip: !shareDir && 'REFUELER_SHARE_DIR not set' }, async () => {
    const fe = await import(`${shareDir}/frontend/crypto.js`);

    const key = crypto.getRandomValues(new Uint8Array(32));
    const mcpEncKey = await derivePartKey(key, ['encrypt']);
    const feDecKey  = await fe.derivePartKey(key, ['decrypt']);

    const plain = crypto.getRandomValues(new Uint8Array(5000));
    const part  = await encryptPart(mcpEncKey, plain, 1, 3);

    const back = new Uint8Array(await fe.decryptPart(feDecKey, part, 1, 3));
    assert.equal(hex(back), hex(plain));

    // and the browser refuses it at the wrong index / wrong place as last
    await assert.rejects(() => fe.decryptPart(feDecKey, part, 2, 3));
    await assert.rejects(() => fe.decryptPart(feDecKey, part, 1, 2));
  });

  test('the two CHUNK_SIZE constants agree', { skip: !shareDir && 'REFUELER_SHARE_DIR not set' }, async () => {
    const fe = await import(`${shareDir}/frontend/crypto.js`);
    assert.equal(CHUNK_SIZE, fe.CHUNK_SIZE);
  });

  test('the two fragment modules produce the same blob', { skip: !shareDir && 'REFUELER_SHARE_DIR not set' }, async () => {
    const feFrag = await import(`${shareDir}/frontend/fragment.js`);
    const args = { keyBytes: K, filename: 'test.bin', sizeBytes: 33554455 };
    assert.equal(assembleFragment(args), feFrag.assembleFragment(args));
  });
});
