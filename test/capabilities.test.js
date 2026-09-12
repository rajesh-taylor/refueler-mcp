/**
 * test/capabilities.test.js — Unit tests for refueler_capabilities tool
 *
 * Uses node:test only. No vitest, no jest.
 * Mock fetch — no network calls in tests.
 * Test credentials use rfs_test_ prefix.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createApiClient, RefuelerApiError } from '../src/api.js';
import { handleCapabilities, _resetCache, _seedCache } from '../src/tools/capabilities.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  liveKey: 'rfs_test_live_aaaabbbbccccddddeeeeffffgggghhhhiiiijjjj',
  signKey: 'rfs_test_sign_zzzzyyyyxxxxwwwwvvvvuuuuttttssssrrrr',
  apiBase: 'https://api.share.refueler.io',
  rail: 'identity',
  anonCreditsPath: null,
};

/** The §7.1 locked capabilities shape — illustrative values */
const MOCK_CAPABILITIES = {
  service: 'refueler-share',
  schema_version: 'cap.v1',
  rate_card_version: 'v1.0',
  credit_unit: 'sat',
  rails_available: ['identity'],
  features: {
    send_file: true,
    collection_receipt: true,
    permanent_record: true,
    agent_to_agent_inbox: false,
    inline_payment: false,
  },
  rate_card: {
    transfer: 10,
    per_gb: 100,
    permanent_record: 20,
    capability_discovery: 0,
    ots_webhook: 0,
  },
  daily_reference_rate: {
    gbp_per_btc: 89000,
    source: 'manual',
    last_updated: 1757500000,
    stale: false,
  },
  limits: {
    max_transfer_bytes: 250000000000,
    chunk_bytes: 8388608,
    max_chunk_bytes: 10485760,
  },
};

/**
 * makeMockFetch — returns a fetch mock that returns the given response.
 *
 * @param {object} opts
 * @param {number} opts.status
 * @param {object} opts.body
 */
function makeMockFetch({ status = 200, body = MOCK_CAPABILITIES } = {}) {
  return async (_url, _opts) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      json: async () => body,
    };
  };
}

/** Mock fetch that throws a network error */
function makeNetworkErrorFetch(message = 'fetch failed') {
  return async () => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleCapabilities — happy path', () => {
  beforeEach(() => _resetCache());

  test('returns the capabilities payload on success', async () => {
    const mockFetch = makeMockFetch({ status: 200, body: MOCK_CAPABILITIES });
    const client = createApiClient(TEST_CONFIG, mockFetch);

    const result = await handleCapabilities({}, client);

    assert.equal(result.isError, false);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.service, 'refueler-share');
    assert.equal(parsed.schema_version, 'cap.v1');
    assert.equal(parsed.rate_card_version, 'v1.0');
    assert.equal(parsed.credit_unit, 'sat');
    assert.deepEqual(parsed.rails_available, ['identity'], 'must be identity only — not anonymous yet');
  });

  test('detail field is carried through in response', async () => {
    const mockFetch = makeMockFetch({ status: 200, body: MOCK_CAPABILITIES });
    const client = createApiClient(TEST_CONFIG, mockFetch);

    const result = await handleCapabilities({ detail: 'full' }, client);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed._detail, 'full');
  });

  test('detail defaults to summary when omitted', async () => {
    const mockFetch = makeMockFetch({ status: 200, body: MOCK_CAPABILITIES });
    const client = createApiClient(TEST_CONFIG, mockFetch);

    const result = await handleCapabilities({}, client);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed._detail, 'summary');
  });

  test('no degraded flag on live success', async () => {
    const mockFetch = makeMockFetch({ status: 200, body: MOCK_CAPABILITIES });
    const client = createApiClient(TEST_CONFIG, mockFetch);

    const result = await handleCapabilities({}, client);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.degraded, undefined, 'degraded must not be set on live success');
  });

  test('rate_card contains no "sat" in values — only "credits" framing', () => {
    // Confirming the fixture itself is vocabulary-compliant.
    // The only permitted sat disclosure is credit_unit: "sat".
    const rc = MOCK_CAPABILITIES.rate_card;
    for (const [key, val] of Object.entries(rc)) {
      assert.equal(typeof val, 'number', `rate_card.${key} must be a number (in credits)`);
    }
    // credit_unit is the one permitted technical disclosure
    assert.equal(MOCK_CAPABILITIES.credit_unit, 'sat');
  });

  test('features.agent_to_agent_inbox is false — gates on Silent Drop', async () => {
    const mockFetch = makeMockFetch({ status: 200, body: MOCK_CAPABILITIES });
    const client = createApiClient(TEST_CONFIG, mockFetch);

    const result = await handleCapabilities({}, client);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.features.agent_to_agent_inbox, false);
  });

  test('features.inline_payment is false — gates on B9+', async () => {
    const mockFetch = makeMockFetch({ status: 200, body: MOCK_CAPABILITIES });
    const client = createApiClient(TEST_CONFIG, mockFetch);

    const result = await handleCapabilities({}, client);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.features.inline_payment, false);
  });
});

// ---------------------------------------------------------------------------
// Degraded mode — last-known-good cache
// ---------------------------------------------------------------------------

describe('handleCapabilities — degraded mode (cache fallback)', () => {
  beforeEach(() => _resetCache());

  test('falls back to cache on network error and marks degraded: true', async () => {
    // Seed the cache first (simulates a prior successful fetch)
    _seedCache(MOCK_CAPABILITIES);

    const failingClient = createApiClient(TEST_CONFIG, makeNetworkErrorFetch('Connection refused'));

    const result = await handleCapabilities({}, failingClient);
    assert.equal(result.isError, false, 'degraded response should not be isError');

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.degraded, true, 'degraded must be true when serving from cache');
    assert.ok(parsed.degraded_reason, 'degraded_reason must be present');
    assert.equal(parsed.service, 'refueler-share', 'cached payload must still be present');
  });

  test('returns capabilities_unavailable error when network fails and no cache exists', async () => {
    _resetCache(); // Ensure cache is empty

    const failingClient = createApiClient(TEST_CONFIG, makeNetworkErrorFetch('Connection refused'));

    const result = await handleCapabilities({}, failingClient);
    assert.equal(result.isError, true, 'should be isError when no cache and no network');

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error, 'capabilities_unavailable');
    assert.ok(parsed.detail, 'detail must be present');
  });

  test('cache is populated after a successful fetch', async () => {
    _resetCache();
    const mockFetch = makeMockFetch({ status: 200, body: MOCK_CAPABILITIES });
    const client = createApiClient(TEST_CONFIG, mockFetch);

    // First call — live success — populates cache
    await handleCapabilities({}, client);

    // Second call — network fails — should degrade to the cache we just populated
    const failingClient = createApiClient(TEST_CONFIG, makeNetworkErrorFetch());
    const result = await handleCapabilities({}, failingClient);

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.degraded, true);
    assert.equal(parsed.service, 'refueler-share');
  });

  test('cache is updated on each successful fetch', async () => {
    _resetCache();
    const v1 = { ...MOCK_CAPABILITIES, rate_card_version: 'v1.0' };
    const v2 = { ...MOCK_CAPABILITIES, rate_card_version: 'v2.0' };

    const client1 = createApiClient(TEST_CONFIG, makeMockFetch({ status: 200, body: v1 }));
    await handleCapabilities({}, client1);

    const client2 = createApiClient(TEST_CONFIG, makeMockFetch({ status: 200, body: v2 }));
    await handleCapabilities({}, client2);

    // Now fail — cache should have v2
    const failingClient = createApiClient(TEST_CONFIG, makeNetworkErrorFetch());
    const result = await handleCapabilities({}, failingClient);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.rate_card_version, 'v2.0', 'cache should hold the most recent successful response');
  });
});

// ---------------------------------------------------------------------------
// Rate limit (429)
// ---------------------------------------------------------------------------

describe('handleCapabilities — rate limit', () => {
  beforeEach(() => _resetCache());

  test('returns rate_limited shape on HTTP 429', async () => {
    const mockFetch = makeMockFetch({
      status: 429,
      body: { retry_after_s: 30 },
    });
    const client = createApiClient(TEST_CONFIG, mockFetch);

    const result = await handleCapabilities({}, client);
    assert.equal(result.isError, false, '429 is a well-formed API response, not an MCP tool error');

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error, 'rate_limited');
    assert.equal(parsed.retry_after_s, 30);
  });

  test('rate_limited shape with null retry when not provided by server', async () => {
    const mockFetch = makeMockFetch({
      status: 429,
      body: {},  // no retry_after_s
    });
    const client = createApiClient(TEST_CONFIG, mockFetch);

    const result = await handleCapabilities({}, client);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error, 'rate_limited');
    assert.equal(parsed.retry_after_s, null);
  });

  test('429 does NOT update the cache', async () => {
    // Prime cache with valid caps
    _seedCache(MOCK_CAPABILITIES);

    const mockFetch = makeMockFetch({ status: 429, body: { retry_after_s: 60 } });
    const client = createApiClient(TEST_CONFIG, mockFetch);
    await handleCapabilities({}, client);

    // Cache should still contain the original caps — confirm by failing with network error
    const failingClient = createApiClient(TEST_CONFIG, makeNetworkErrorFetch());
    const result = await handleCapabilities({}, failingClient);
    const parsed = JSON.parse(result.content[0].text);
    // Should serve from cache, not be unavailable
    assert.equal(parsed.service, 'refueler-share', '429 must not overwrite the cache');
  });
});

// ---------------------------------------------------------------------------
// RefuelerApiError
// ---------------------------------------------------------------------------

describe('RefuelerApiError', () => {
  test('carries status and body', () => {
    const err = new RefuelerApiError('something failed', 400, { error: 'bad_request' });
    assert.equal(err.name, 'RefuelerApiError');
    assert.equal(err.status, 400);
    assert.deepEqual(err.body, { error: 'bad_request' });
    assert.equal(err.message, 'something failed');
    assert.ok(err instanceof Error);
  });
});
