/**
 * test/hmac.test.js — Unit tests for src/hmac.js
 *
 * Uses node:test only. No vitest, no jest.
 * Test credentials use rfs_test_ prefix — never rfs_live_ or rfs_sign_.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256Hex, buildCanonical, signRequest } from '../src/hmac.js';

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

describe('sha256Hex', () => {
  test('empty string produces the correct SHA-256', () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const result = sha256Hex('');
    assert.equal(
      result,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  test('known input produces correct SHA-256', () => {
    // Derive expected from node:crypto directly — no transcribed constant to get wrong.
    const expected = createHash('sha256').update('abc').digest('hex');
    const result = sha256Hex('abc');
    assert.match(result, /^[0-9a-f]{64}$/, 'should be 64 lowercase hex chars');
    assert.equal(result, expected, 'sha256Hex must match node:crypto createHash output');
  });

  test('output is always lowercase hex', () => {
    const result = sha256Hex('Hello World');
    assert.match(result, /^[0-9a-f]{64}$/, 'must be lowercase hex only');
  });

  test('accepts a Buffer', () => {
    const result = sha256Hex(Buffer.from(''));
    assert.equal(
      result,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });
});

// ---------------------------------------------------------------------------
// buildCanonical
// ---------------------------------------------------------------------------

describe('buildCanonical', () => {
  test('produces the correct newline-delimited canonical string', () => {
    const canonical = buildCanonical('GET', '/api/v1/auth/ping', 1700000000, '');
    const parts = canonical.split('\n');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'GET');
    assert.equal(parts[1], '/api/v1/auth/ping');
    assert.equal(parts[2], '1700000000');
    // parts[3] = SHA-256('') 
    assert.equal(parts[3], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('upcases the method', () => {
    const canonical = buildCanonical('get', '/api/v1/capabilities', 1700000000, '');
    assert.equal(canonical.split('\n')[0], 'GET');
  });

  test('body hash changes with different body content', () => {
    const c1 = buildCanonical('POST', '/api/v1/credential/issue', 1700000000, '{"foo":"bar"}');
    const c2 = buildCanonical('POST', '/api/v1/credential/issue', 1700000000, '{"foo":"baz"}');
    const hash1 = c1.split('\n')[3];
    const hash2 = c2.split('\n')[3];
    assert.notEqual(hash1, hash2, 'different bodies must produce different hashes');
  });

  test('empty body defaults when omitted', () => {
    const c1 = buildCanonical('GET', '/api/v1/auth/ping', 1700000000);
    const c2 = buildCanonical('GET', '/api/v1/auth/ping', 1700000000, '');
    assert.equal(c1, c2, 'omitting body should equal empty string body');
  });
});

// ---------------------------------------------------------------------------
// signRequest
// ---------------------------------------------------------------------------

describe('signRequest', () => {
  const TEST_LIVE_KEY = 'rfs_test_live_aaaabbbbccccddddeeeeffffgggghhhhiiiijjjj';
  const TEST_SIGN_KEY = 'rfs_test_sign_zzzzyyyyxxxxwwwwvvvvuuuuttttssssrrrr';

  test('returns Authorization and X-Api-Sign-Key headers', () => {
    const headers = signRequest({
      method: 'GET',
      path: '/api/v1/auth/ping',
      liveKey: TEST_LIVE_KEY,
      signKey: TEST_SIGN_KEY,
      timestamp: 1700000000,
    });
    assert.ok(headers['Authorization'], 'Authorization header must be present');
    assert.ok(headers['X-Api-Sign-Key'], 'X-Api-Sign-Key header must be present');
    assert.equal(headers.timestamp, 1700000000);
  });

  test('Authorization header matches HMAC-SHA256 prefix and structure', () => {
    const headers = signRequest({
      method: 'GET',
      path: '/api/v1/auth/ping',
      liveKey: TEST_LIVE_KEY,
      signKey: TEST_SIGN_KEY,
      timestamp: 1700000000,
    });
    // Expected shape: "HMAC-SHA256 key=rfs_test_live_..., ts=1700000000, sig=<64 hex chars>"
    assert.match(
      headers['Authorization'],
      /^HMAC-SHA256 key=rfs_test_live_[^,]+, ts=\d+, sig=[0-9a-f]{64}$/,
      'Authorization header must match HMAC-SHA256 format'
    );
  });

  test('X-Api-Sign-Key equals the sign key', () => {
    const headers = signRequest({
      method: 'POST',
      path: '/api/v1/credential/issue',
      liveKey: TEST_LIVE_KEY,
      signKey: TEST_SIGN_KEY,
      body: '{"test":true}',
      timestamp: 1700000000,
    });
    assert.equal(headers['X-Api-Sign-Key'], TEST_SIGN_KEY);
  });

  test('signature changes with different method', () => {
    const base = { path: '/api/v1/auth/ping', liveKey: TEST_LIVE_KEY, signKey: TEST_SIGN_KEY, timestamp: 1700000000 };
    const h1 = signRequest({ ...base, method: 'GET' });
    const h2 = signRequest({ ...base, method: 'POST' });
    const sig1 = h1['Authorization'].match(/sig=([0-9a-f]{64})/)?.[1];
    const sig2 = h2['Authorization'].match(/sig=([0-9a-f]{64})/)?.[1];
    assert.notEqual(sig1, sig2, 'different methods must produce different signatures');
  });

  test('signature changes with different path', () => {
    const base = { method: 'GET', liveKey: TEST_LIVE_KEY, signKey: TEST_SIGN_KEY, timestamp: 1700000000 };
    const h1 = signRequest({ ...base, path: '/api/v1/auth/ping' });
    const h2 = signRequest({ ...base, path: '/api/v1/capabilities' });
    const sig1 = h1['Authorization'].match(/sig=([0-9a-f]{64})/)?.[1];
    const sig2 = h2['Authorization'].match(/sig=([0-9a-f]{64})/)?.[1];
    assert.notEqual(sig1, sig2, 'different paths must produce different signatures');
  });

  test('signature changes with different timestamp', () => {
    const base = { method: 'GET', path: '/api/v1/auth/ping', liveKey: TEST_LIVE_KEY, signKey: TEST_SIGN_KEY };
    const h1 = signRequest({ ...base, timestamp: 1700000000 });
    const h2 = signRequest({ ...base, timestamp: 1700000001 });
    const sig1 = h1['Authorization'].match(/sig=([0-9a-f]{64})/)?.[1];
    const sig2 = h2['Authorization'].match(/sig=([0-9a-f]{64})/)?.[1];
    assert.notEqual(sig1, sig2, 'different timestamps must produce different signatures');
  });

  test('signature changes with different body', () => {
    const base = { method: 'POST', path: '/api/v1/credential/issue', liveKey: TEST_LIVE_KEY, signKey: TEST_SIGN_KEY, timestamp: 1700000000 };
    const h1 = signRequest({ ...base, body: '{"a":1}' });
    const h2 = signRequest({ ...base, body: '{"a":2}' });
    const sig1 = h1['Authorization'].match(/sig=([0-9a-f]{64})/)?.[1];
    const sig2 = h2['Authorization'].match(/sig=([0-9a-f]{64})/)?.[1];
    assert.notEqual(sig1, sig2, 'different bodies must produce different signatures');
  });

  test('empty body produces a stable deterministic signature', () => {
    const base = { method: 'GET', path: '/api/v1/auth/ping', liveKey: TEST_LIVE_KEY, signKey: TEST_SIGN_KEY, timestamp: 1700000000 };
    const h1 = signRequest({ ...base });
    const h2 = signRequest({ ...base, body: '' });
    const sig1 = h1['Authorization'].match(/sig=([0-9a-f]{64})/)?.[1];
    const sig2 = h2['Authorization'].match(/sig=([0-9a-f]{64})/)?.[1];
    assert.equal(sig1, sig2, 'omitted body and empty body must produce the same signature');
  });

  test('timestamp defaults to approximately now', () => {
    const before = Date.now() / 1000 | 0;
    const headers = signRequest({
      method: 'GET',
      path: '/api/v1/auth/ping',
      liveKey: TEST_LIVE_KEY,
      signKey: TEST_SIGN_KEY,
    });
    const after = Date.now() / 1000 | 0;
    assert.ok(headers.timestamp >= before && headers.timestamp <= after + 1, 'default timestamp should be approximately now');
  });
});
