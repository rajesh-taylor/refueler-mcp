// test/balance.test.js — refueler-mcp
// node:test only. No vitest.
// Tests src/tools/balance.js with mocked api and config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuelerBalance } from '../src/tools/balance.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdentityPing(overrides = {}) {
  return {
    remaining_credits: 48_500,
    rail: 'identity',
    plan: 'identity_api',
    period_end: 1762000000,
    allocation_credits: 50_000,
    overage_credits: 1_500,
    status: 'active',
    ...overrides,
  };
}

function makeIdentityCtx(pingOverrides = {}) {
  const data = makeIdentityPing(pingOverrides);
  return {
    api: { async ping() { return data; } },
    config: { rail: 'identity' },
  };
}

function makeFailCtx(msg = 'network timeout') {
  return {
    api: { async ping() { throw new Error(msg); } },
    config: { rail: 'identity' },
  };
}

// ---------------------------------------------------------------------------
// Identity rail — field presence and values
// ---------------------------------------------------------------------------

test('balance: identity rail — remaining_credits from ping', async () => {
  const ctx = makeIdentityCtx({ remaining_credits: 48_500 });
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.remaining_credits, 48_500);
});

test('balance: identity rail — rail = identity', async () => {
  const ctx = makeIdentityCtx();
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.rail, 'identity');
});

test('balance: identity rail — plan present', async () => {
  const ctx = makeIdentityCtx({ plan: 'identity_api' });
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.plan, 'identity_api');
});

test('balance: identity rail — period_end present (unix secs)', async () => {
  const ctx = makeIdentityCtx({ period_end: 1762000000 });
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.period_end, 1762000000);
});

test('balance: identity rail — allocation_credits present', async () => {
  const ctx = makeIdentityCtx({ allocation_credits: 50_000 });
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.allocation_credits, 50_000);
});

test('balance: identity_api plan — overage_credits included', async () => {
  const ctx = makeIdentityCtx({ plan: 'identity_api', overage_credits: 1_500 });
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.overage_credits, 1_500);
});

test('balance: identity rail — status = active', async () => {
  const ctx = makeIdentityCtx({ status: 'active' });
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.status, 'active');
});

// ---------------------------------------------------------------------------
// Identity rail — personal_api plan
// ---------------------------------------------------------------------------

test('balance: personal_api plan — overage_credits omitted', async () => {
  // personal_api has no overage — hard stop at allocation
  const ping = {
    remaining_credits: 9_500,
    rail: 'identity',
    plan: 'personal_api',
    period_end: 1762000000,
    allocation_credits: 10_000,
    // overage_credits deliberately absent
    status: 'active',
  };
  const ctx = {
    api: { async ping() { return ping; } },
    config: { rail: 'identity' },
  };
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.plan, 'personal_api');
  assert.ok(!('overage_credits' in result), 'overage_credits must be absent for personal_api');
});

// ---------------------------------------------------------------------------
// Identity rail — cancelled status
// ---------------------------------------------------------------------------

test('balance: cancelled status surfaced correctly', async () => {
  const ctx = makeIdentityCtx({ status: 'cancelled', remaining_credits: 0 });
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.remaining_credits, 0);
});

// ---------------------------------------------------------------------------
// Anonymous rail — server blind
// ---------------------------------------------------------------------------

test('balance: anonymous rail — remaining_credits from localCredits', async () => {
  const ctx = {
    api: { async ping() { throw new Error('should not be called'); } },
    config: { rail: 'anonymous', localCredits: 12_000 },
  };
  const result = await refuelerBalance({ rail: 'anonymous' }, ctx);
  assert.equal(result.remaining_credits, 12_000);
});

test('balance: anonymous rail — server_blind = true', async () => {
  const ctx = {
    api: { async ping() { throw new Error('should not be called'); } },
    config: { rail: 'anonymous', localCredits: 12_000 },
  };
  const result = await refuelerBalance({ rail: 'anonymous' }, ctx);
  assert.equal(result.server_blind, true);
});

test('balance: anonymous rail — rail = anonymous', async () => {
  const ctx = {
    api: { async ping() { throw new Error('should not be called'); } },
    config: { rail: 'anonymous', localCredits: 12_000 },
  };
  const result = await refuelerBalance({ rail: 'anonymous' }, ctx);
  assert.equal(result.rail, 'anonymous');
});

test('balance: anonymous rail — no period_end, no allocation_credits', async () => {
  const ctx = {
    api: { async ping() { throw new Error('should not be called'); } },
    config: { rail: 'anonymous', localCredits: 12_000 },
  };
  const result = await refuelerBalance({ rail: 'anonymous' }, ctx);
  assert.ok(!('period_end' in result), 'no period_end on anonymous rail');
  assert.ok(!('allocation_credits' in result), 'no allocation_credits on anonymous rail');
});

test('balance: anonymous rail — ping is never called', async () => {
  let pingCalled = false;
  const ctx = {
    api: { async ping() { pingCalled = true; return {}; } },
    config: { rail: 'anonymous', localCredits: 500 },
  };
  await refuelerBalance({ rail: 'anonymous' }, ctx);
  assert.equal(pingCalled, false);
});

test('balance: anonymous rail — localCredits null when not configured', async () => {
  const ctx = {
    api: { async ping() { throw new Error('no ping'); } },
    config: { rail: 'anonymous' }, // no localCredits
  };
  const result = await refuelerBalance({ rail: 'anonymous' }, ctx);
  assert.equal(result.remaining_credits, null);
});

// ---------------------------------------------------------------------------
// Rail from config when not in input
// ---------------------------------------------------------------------------

test('balance: defaults to config.rail when rail not in input', async () => {
  const ctx = makeIdentityCtx();
  const result = await refuelerBalance({}, ctx); // no rail in input
  assert.equal(result.rail, 'identity');
});

// ---------------------------------------------------------------------------
// Ping failure — graceful degradation
// ---------------------------------------------------------------------------

test('balance: ping failure → error field present', async () => {
  const ctx = makeFailCtx('ECONNREFUSED');
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.error, 'ping_failed');
});

test('balance: ping failure → detail field contains error message', async () => {
  const ctx = makeFailCtx('ECONNREFUSED');
  const result = await refuelerBalance({}, ctx);
  assert.ok(typeof result.detail === 'string');
  assert.ok(result.detail.length > 0);
});

test('balance: ping failure → remaining_credits is null', async () => {
  const ctx = makeFailCtx();
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.remaining_credits, null);
});

test('balance: ping failure → rail still present', async () => {
  const ctx = makeFailCtx();
  const result = await refuelerBalance({}, ctx);
  assert.equal(result.rail, 'identity');
});

// ---------------------------------------------------------------------------
// Vocabulary — no forbidden strings in any output field values or names
// ---------------------------------------------------------------------------

test('balance: identity rail — no "sats", "ecash", "tokens" in output', async () => {
  const ctx = makeIdentityCtx();
  const result = await refuelerBalance({}, ctx);
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes('"sats"'), 'no sats');
  assert.ok(!serialised.includes('"ecash"'), 'no ecash');
  assert.ok(!serialised.includes('"tokens"'), 'no tokens');
});

test('balance: anonymous rail — no "sats", "ecash", "tokens" in output', async () => {
  const ctx = {
    api: { async ping() { throw new Error('no ping'); } },
    config: { rail: 'anonymous', localCredits: 500 },
  };
  const result = await refuelerBalance({ rail: 'anonymous' }, ctx);
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes('"sats"'), 'no sats');
  assert.ok(!serialised.includes('"ecash"'), 'no ecash');
  assert.ok(!serialised.includes('"tokens"'), 'no tokens');
});

test('balance: monetary field name uses _credits suffix', async () => {
  const ctx = makeIdentityCtx();
  const result = await refuelerBalance({}, ctx);
  assert.ok('remaining_credits' in result, 'remaining_credits field present');
});
