/**
 * test/fragment.test.js — unit tests for src/fragment.js
 *
 * node:test only — no vitest, no jest, no mocha.
 * Test credentials use rfs_test_ prefix per CLAUDE.md.
 *
 * Run: node --test test/fragment.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assembleFragment, parseFragment } from '../src/fragment.js';
import { generateAesKey } from '../src/crypto.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBase64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const mod = padded.length % 4;
  const standard = mod === 0 ? padded : padded + '===='.slice(mod);
  const binary = atob(standard);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// assembleFragment
// ---------------------------------------------------------------------------

describe('assembleFragment', () => {
  it('returns a non-empty string', () => {
    const key = generateAesKey();
    const fragment = assembleFragment({ keyBytes: key, filename: 'rfs_test_document.pdf' });
    assert.equal(typeof fragment, 'string');
    assert.ok(fragment.length > 0);
  });

  it('produces valid base64url output (no +, /, or = chars)', () => {
    const key = generateAesKey();
    const fragment = assembleFragment({ keyBytes: key, filename: 'rfs_test_file.txt' });
    assert.doesNotMatch(fragment, /[+/=]/, 'fragment must be base64url encoded');
  });

  it('encodes a v1 JSON object with v, k, n fields', () => {
    const key = generateAesKey();
    const filename = 'rfs_test_photo.jpg';
    const fragment = assembleFragment({ keyBytes: key, filename });

    const decoded = JSON.parse(new TextDecoder().decode(fromBase64url(fragment)));
    assert.equal(decoded.v, 1, 'v field must be 1');
    assert.equal(typeof decoded.k, 'string', 'k field must be a string');
    assert.equal(decoded.n, filename, 'n field must match filename');
    assert.equal(decoded.s, undefined, 's field must be absent when no sealNonce');
  });

  it('encodes the key bytes correctly', () => {
    const key = generateAesKey();
    const fragment = assembleFragment({ keyBytes: key, filename: 'rfs_test_key_check.bin' });
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64url(fragment)));
    const recoveredKey = fromBase64url(decoded.k);
    assert.deepEqual(recoveredKey, key, 'key bytes must survive encode/decode');
  });

  it('includes s field when sealNonce is provided', () => {
    const key = generateAesKey();
    const nonce = new Uint8Array(32).fill(0xAB);
    const filename = 'rfs_test_sealed.pdf';
    const fragment = assembleFragment({ keyBytes: key, filename, sealNonce: nonce });

    const decoded = JSON.parse(new TextDecoder().decode(fromBase64url(fragment)));
    assert.equal(decoded.v, 1);
    assert.equal(decoded.n, filename);
    assert.ok(typeof decoded.s === 'string' && decoded.s.length > 0, 's field must be present');

    const recoveredNonce = fromBase64url(decoded.s);
    assert.deepEqual(recoveredNonce, nonce, 'seal nonce bytes must survive encode/decode');
  });

  it('omits s field when sealNonce is undefined', () => {
    const key = generateAesKey();
    const fragment = assembleFragment({ keyBytes: key, filename: 'rfs_test_no_seal.txt' });
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64url(fragment)));
    assert.equal(Object.prototype.hasOwnProperty.call(decoded, 's'), false, 's must be absent');
  });

  it('throws when keyBytes is missing', () => {
    assert.throws(
      () => assembleFragment({ filename: 'rfs_test.txt' }),
      /keyBytes must be a non-empty Uint8Array/,
    );
  });

  it('throws when filename is empty string', () => {
    const key = generateAesKey();
    assert.throws(
      () => assembleFragment({ keyBytes: key, filename: '' }),
      /filename must be a non-empty string/,
    );
  });

  it('throws when sealNonce is an empty Uint8Array', () => {
    const key = generateAesKey();
    assert.throws(
      () => assembleFragment({ keyBytes: key, filename: 'rfs_test.txt', sealNonce: new Uint8Array(0) }),
      /sealNonce must be a non-empty Uint8Array/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseFragment — v1 round-trip
// ---------------------------------------------------------------------------

describe('parseFragment — v1 round-trip', () => {
  it('round-trips a fragment without sealNonce', () => {
    const key = generateAesKey();
    const filename = 'rfs_test_roundtrip.docx';

    const fragment = assembleFragment({ keyBytes: key, filename });
    const parsed = parseFragment(fragment);

    assert.equal(parsed.legacy, false, 'should not be flagged as legacy');
    assert.equal(parsed.filename, filename, 'filename must match');
    assert.equal(parsed.sealNonce, null, 'sealNonce must be null');
    assert.deepEqual(parsed.keyBytes, key, 'keyBytes must match');
  });

  it('round-trips a fragment with sealNonce', () => {
    const key = generateAesKey();
    const filename = 'rfs_test_sealed_roundtrip.pdf';
    const nonce = new Uint8Array(32);
    for (let i = 0; i < 32; i++) nonce[i] = i;

    const fragment = assembleFragment({ keyBytes: key, filename, sealNonce: nonce });
    const parsed = parseFragment(fragment);

    assert.equal(parsed.legacy, false);
    assert.equal(parsed.filename, filename);
    assert.deepEqual(parsed.keyBytes, key);
    assert.ok(parsed.sealNonce instanceof Uint8Array, 'sealNonce must be Uint8Array');
    assert.deepEqual(parsed.sealNonce, nonce, 'sealNonce bytes must match');
  });

  it('round-trips with a filename containing unicode characters', () => {
    const key = generateAesKey();
    const filename = 'rfs_test_ünïcödé_文件.pdf';

    const fragment = assembleFragment({ keyBytes: key, filename });
    const parsed = parseFragment(fragment);

    assert.equal(parsed.filename, filename, 'unicode filename must survive round-trip');
  });

  it('round-trips with a filename containing spaces and punctuation', () => {
    const key = generateAesKey();
    const filename = 'rfs test (draft 3) — final.pdf';

    const fragment = assembleFragment({ keyBytes: key, filename });
    const parsed = parseFragment(fragment);

    assert.equal(parsed.filename, filename);
  });

  it('different keys produce different fragments', () => {
    const key1 = generateAesKey();
    const key2 = generateAesKey();
    const filename = 'rfs_test_same_name.txt';

    const f1 = assembleFragment({ keyBytes: key1, filename });
    const f2 = assembleFragment({ keyBytes: key2, filename });

    assert.notEqual(f1, f2, 'different keys must produce different fragments');
  });
});

// ---------------------------------------------------------------------------
// parseFragment — error cases
// ---------------------------------------------------------------------------

describe('parseFragment — error cases', () => {
  it('throws on empty string', () => {
    assert.throws(
      () => parseFragment(''),
      /non-empty string/,
    );
  });

  it('throws on non-string input', () => {
    assert.throws(
      () => parseFragment(null),
      /non-empty string/,
    );
  });

  it('throws on a fragment with v:1 but missing k field', () => {
    // Manually build a broken v1 fragment
    const broken = toBase64url(new TextEncoder().encode(JSON.stringify({ v: 1, n: 'file.txt' })));
    assert.throws(
      () => parseFragment(broken),
      /missing or empty key field/,
    );
  });

  it('throws on a fragment with v:1 but missing n field', () => {
    const broken = toBase64url(new TextEncoder().encode(JSON.stringify({ v: 1, k: 'abc123' })));
    assert.throws(
      () => parseFragment(broken),
      /missing or empty filename field/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseFragment — legacy fallback
// ---------------------------------------------------------------------------

describe('parseFragment — legacy fallback', () => {
  it('parses a raw base64url key as a legacy fragment', () => {
    const key = generateAesKey();
    const rawB64url = toBase64url(key);

    const parsed = parseFragment(rawB64url);

    assert.equal(parsed.legacy, true, 'must be flagged as legacy');
    assert.equal(parsed.filename, null, 'filename must be null for legacy fragment');
    assert.equal(parsed.sealNonce, null, 'sealNonce must be null for legacy fragment');
    assert.deepEqual(parsed.keyBytes, key, 'key bytes must be recovered correctly');
  });

  it('legacy fragment does not have a filename', () => {
    const key = generateAesKey();
    const rawB64url = toBase64url(key);
    const parsed = parseFragment(rawB64url);
    assert.equal(parsed.filename, null);
  });

  it('legacy fragment does not have a sealNonce', () => {
    const key = generateAesKey();
    const rawB64url = toBase64url(key);
    const parsed = parseFragment(rawB64url);
    assert.equal(parsed.sealNonce, null);
  });
});

// ---------------------------------------------------------------------------
// Fragment — with and without sealNonce (spec checklist items)
// ---------------------------------------------------------------------------

describe('Fragment with and without sealNonce — spec checklist', () => {
  it('assembleFragment without sealNonce: s key absent in decoded JSON', () => {
    const key = generateAesKey();
    const fragment = assembleFragment({ keyBytes: key, filename: 'rfs_test_no_s.bin' });
    const obj = JSON.parse(new TextDecoder().decode(fromBase64url(fragment)));
    assert.ok(!('s' in obj), 's key must not appear in JSON when sealNonce is absent');
  });

  it('assembleFragment with sealNonce: s key present in decoded JSON', () => {
    const key = generateAesKey();
    const nonce = new Uint8Array(16).fill(0xFF);
    const fragment = assembleFragment({ keyBytes: key, filename: 'rfs_test_with_s.bin', sealNonce: nonce });
    const obj = JSON.parse(new TextDecoder().decode(fromBase64url(fragment)));
    assert.ok('s' in obj, 's key must appear in JSON when sealNonce is provided');
  });

  it('parseFragment with sealNonce: returned sealNonce is non-null Uint8Array', () => {
    const key = generateAesKey();
    const nonce = new Uint8Array(32).fill(0x7E);
    const fragment = assembleFragment({ keyBytes: key, filename: 'rfs_test_parse_s.pdf', sealNonce: nonce });
    const parsed = parseFragment(fragment);
    assert.ok(parsed.sealNonce instanceof Uint8Array);
    assert.ok(parsed.sealNonce.length > 0);
  });

  it('parseFragment without sealNonce: returned sealNonce is null', () => {
    const key = generateAesKey();
    const fragment = assembleFragment({ keyBytes: key, filename: 'rfs_test_no_parse_s.txt' });
    const parsed = parseFragment(fragment);
    assert.equal(parsed.sealNonce, null);
  });
});
