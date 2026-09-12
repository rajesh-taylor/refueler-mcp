// test/quote.test.js — refueler-mcp
// node:test only. No vitest.
// Tests src/tools/quote.js with mocked api and config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuelerQuote } from '../src/tools/quote.js';
import { RATE_CARD_VERSION } from '../src/rate-card.js';

// ---------------------------------------------------------------------------
// Helpers — mock ping responses
// ---------------------------------------------------------------------------

function makePing(overrides = {}) {
  return {
    remaining_credits: 5000,
    rail: 'identity',
    plan: 'identity_api',
    period_end: 1762000000,
    allocation_credits: 50000,
    status: 'active',
    ...overrides,
  };
}

function makeCtx(pingOverrides = {}, configOverrides = {}) {
  const pingData = makePing(pingOverrides);
  return {
    api: {
      async ping() { return pingData; },
    },
    config: {
      rail: 'identity',
      btcRefRate: 89_000,
      ...configOverrides,
    },
  };
}

function makeFailCtx(errorMsg = 'network error') {
  return {
    api: {
      async ping() { throw new Error(errorMsg); },
    },
    config: { rail: 'identity', btcRefRate: 89_000 },
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('quote: missing size_bytes → invalid_input error', async () => {
  const ctx = makeCtx();
  const result = await refuelerQuote({}, ctx);
  assert.equal(result.error, 'invalid_input');
  assert.ok(result.detail.includes('size_bytes'));
});

test('quote: size_bytes = 0 → invalid_input (must be > 0)', async () => {
  const ctx = makeCtx();
  const result = await refuelerQuote({ size_bytes: 0 }, ctx);
  assert.equal(result.error, 'invalid_input');
});

test('quote: negative size_bytes → invalid_input', async () => {
  const ctx = makeCtx();
  const result = await refuelerQuote({ size_bytes: -100 }, ctx);
  assert.equal(result.error, 'invalid_input');
});

test('quote: non-integer size_bytes → invalid_input', async () => {
  const ctx = makeCtx();
  const result = await refuelerQuote({ size_bytes: 1.5 }, ctx);
  assert.equal(result.error, 'invalid_input');
});

test('quote: string size_bytes → invalid_input', async () => {
  const ctx = makeCtx();
  const result = await refuelerQuote({ size_bytes: '1000' }, ctx);
  assert.equal(result.error, 'invalid_input');
});

// ---------------------------------------------------------------------------
// Output shape — identity rail, can afford
// ---------------------------------------------------------------------------

test('quote: identity rail — returns rate_card_version v1.0', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.rate_card_version, RATE_CARD_VERSION);
});

test('quote: identity rail — 1 GB file costs 110 credits', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.cost_credits, 110);
});

test('quote: identity rail — cost_gbp_reference is a number when rate available', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 }, { btcRefRate: 89_000 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.ok(typeof result.cost_gbp_reference === 'number');
  assert.ok(result.cost_gbp_reference > 0);
});

test('quote: identity rail — rail field present', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.rail, 'identity');
});

test('quote: identity rail — affordable true when balance >= cost', async () => {
  // 1 GB = 110 credits; balance = 5000 → affordable
  const ctx = makeCtx({ remaining_credits: 5000 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.affordable, true);
});

test('quote: identity rail — balance.kind = credit_pool', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.balance.kind, 'credit_pool');
});

test('quote: identity rail — balance.remaining_credits from ping', async () => {
  const ctx = makeCtx({ remaining_credits: 4800 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.balance.remaining_credits, 4800);
});

// ---------------------------------------------------------------------------
// Output shape — can_afford false (insufficient balance)
// ---------------------------------------------------------------------------

test('quote: affordable false when balance < cost', async () => {
  // 1 GB = 110 credits; balance = 50 → cannot afford
  const ctx = makeCtx({ remaining_credits: 50 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.affordable, false);
});

test('quote: affordable false — balance.remaining_credits still present', async () => {
  const ctx = makeCtx({ remaining_credits: 50 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.balance.remaining_credits, 50);
});

test('quote: affordable false — cost_credits still correct', async () => {
  const ctx = makeCtx({ remaining_credits: 50 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.cost_credits, 110);
});

// ---------------------------------------------------------------------------
// permanent_record surcharge
// ---------------------------------------------------------------------------

test('quote: permanent_record = true adds 20 credits', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 });
  const without = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  const with_pr = await refuelerQuote({ size_bytes: 1_000_000_000, permanent_record: true }, ctx);
  assert.equal(with_pr.cost_credits - without.cost_credits, 20);
});

test('quote: permanent_record = false same as omitted', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 });
  const omitted = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  const explicit = await refuelerQuote({ size_bytes: 1_000_000_000, permanent_record: false }, ctx);
  assert.equal(omitted.cost_credits, explicit.cost_credits);
});

// ---------------------------------------------------------------------------
// GBP reference — stale / absent rate
// ---------------------------------------------------------------------------

test('quote: cost_gbp_reference is null when btcRefRate absent', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 }, { btcRefRate: null });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.cost_gbp_reference, null);
});

test('quote: cost_gbp_reference is null when btcRefRate is 0', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 }, { btcRefRate: 0 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.cost_gbp_reference, null);
});

test('quote: cost_gbp_reference null does not block response', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 }, { btcRefRate: null });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  // Cost and affordability still returned
  assert.equal(result.cost_credits, 110);
  assert.equal(result.affordable, true);
});

// ---------------------------------------------------------------------------
// Ping failure — graceful degradation
// ---------------------------------------------------------------------------

test('quote: ping failure → balance_available false', async () => {
  const ctx = makeFailCtx('connection refused');
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.balance_available, false);
});

test('quote: ping failure → cost_credits still returned', async () => {
  const ctx = makeFailCtx();
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.cost_credits, 110);
});

test('quote: ping failure → balance.remaining_credits is null', async () => {
  const ctx = makeFailCtx();
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.balance.remaining_credits, null);
});

test('quote: ping failure → balance.kind is credit_pool', async () => {
  const ctx = makeFailCtx();
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.balance.kind, 'credit_pool');
});

test('quote: ping failure → rate_card_version still present', async () => {
  const ctx = makeFailCtx();
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.rate_card_version, RATE_CARD_VERSION);
});

// ---------------------------------------------------------------------------
// Rail override from input
// ---------------------------------------------------------------------------

test('quote: rail explicitly set in input overrides config default', async () => {
  const ctx = makeCtx({}, { rail: 'identity' });
  // Anonymous rail does not call ping; local credits not set → null
  const result = await refuelerQuote({ size_bytes: 1_000_000_000, rail: 'anonymous' }, ctx);
  assert.equal(result.rail, 'anonymous');
  assert.equal(result.balance.kind, 'local_credits');
});

// ---------------------------------------------------------------------------
// Anonymous rail
// ---------------------------------------------------------------------------

test('quote: anonymous rail — balance.kind = local_credits', async () => {
  const ctx = {
    api: { async ping() { throw new Error('should not be called'); } },
    config: { rail: 'anonymous', btcRefRate: 89_000, localCredits: 500 },
  };
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.rail, 'anonymous');
  assert.equal(result.balance.kind, 'local_credits');
  assert.equal(result.balance.remaining_credits, 500);
});

test('quote: anonymous rail — ping is never called', async () => {
  let pingCalled = false;
  const ctx = {
    api: { async ping() { pingCalled = true; return {}; } },
    config: { rail: 'anonymous', btcRefRate: 89_000, localCredits: 500 },
  };
  await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(pingCalled, false);
});

test('quote: anonymous rail — affordable true when localCredits >= cost', async () => {
  const ctx = {
    api: { async ping() { throw new Error('no ping'); } },
    config: { rail: 'anonymous', btcRefRate: 89_000, localCredits: 500 },
  };
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  // 1 GB = 110 credits; localCredits = 500 → affordable
  assert.equal(result.affordable, true);
});

test('quote: anonymous rail — affordable false when localCredits < cost', async () => {
  const ctx = {
    api: { async ping() { throw new Error('no ping'); } },
    config: { rail: 'anonymous', btcRefRate: 89_000, localCredits: 50 },
  };
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  assert.equal(result.affordable, false);
});

// ---------------------------------------------------------------------------
// Vocabulary — no forbidden strings in any output field values
// ---------------------------------------------------------------------------

test('quote: no "sats" string in any output field', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes('"sats"'), 'no "sats" value');
  assert.ok(!serialised.includes('"ecash"'), 'no "ecash" value');
  assert.ok(!serialised.includes('"tokens"'), 'no "tokens" value');
});

test('quote: output field names all use _credits suffix for monetary values', async () => {
  const ctx = makeCtx({ remaining_credits: 5000 });
  const result = await refuelerQuote({ size_bytes: 1_000_000_000 }, ctx);
  // Check that monetary fields use _credits suffix
  assert.ok('cost_credits' in result, 'cost_credits present');
  assert.ok('remaining_credits' in result.balance, 'remaining_credits present in balance');
});
