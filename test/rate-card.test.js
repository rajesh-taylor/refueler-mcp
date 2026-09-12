// test/rate-card.test.js — refueler-mcp
// node:test only. No vitest.
// Tests the pure functions in src/rate-card.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATE_CARD_VERSION, costCredits, gbpReference } from '../src/rate-card.js';

// ---------------------------------------------------------------------------
// RATE_CARD_VERSION
// ---------------------------------------------------------------------------

test('RATE_CARD_VERSION is v1.0', () => {
  assert.equal(RATE_CARD_VERSION, 'v1.0');
});

// ---------------------------------------------------------------------------
// costCredits — transfer fixed cost
// ---------------------------------------------------------------------------

test('costCredits: transfer is always 10 credits', () => {
  const r = costCredits({ sizeBytes: 0 });
  assert.equal(r.transfer, 10);
});

test('costCredits: 0 bytes → 0 storage credits', () => {
  const r = costCredits({ sizeBytes: 0 });
  assert.equal(r.storage, 0);
  assert.equal(r.total, 10); // transfer only
});

test('costCredits: 1 byte → 100 storage credits (ceiling to first GB)', () => {
  const r = costCredits({ sizeBytes: 1 });
  assert.equal(r.storage, 100);
  assert.equal(r.total, 110);
});

test('costCredits: exactly 1 GB → 100 storage credits', () => {
  const r = costCredits({ sizeBytes: 1_000_000_000 });
  assert.equal(r.storage, 100);
  assert.equal(r.total, 110);
});

test('costCredits: 1 GB + 1 byte → 200 storage credits (ceiling to second GB)', () => {
  const r = costCredits({ sizeBytes: 1_000_000_001 });
  assert.equal(r.storage, 200);
  assert.equal(r.total, 210);
});

test('costCredits: 5 GB exactly → 500 storage credits', () => {
  const r = costCredits({ sizeBytes: 5_000_000_000 });
  assert.equal(r.storage, 500);
  assert.equal(r.total, 510);
});

test('costCredits: 1.4 GB → 200 storage credits (ceiling)', () => {
  // 1.4 GB = 1,400,000,000 bytes → ceil(1.4) = 2 → 200 credits
  const r = costCredits({ sizeBytes: 1_400_000_000 });
  assert.equal(r.storage, 200);
  assert.equal(r.total, 210);
});

// ---------------------------------------------------------------------------
// costCredits — permanent record surcharge
// ---------------------------------------------------------------------------

test('costCredits: permanentRecord false → 0 surcharge', () => {
  const r = costCredits({ sizeBytes: 1_000_000_000, permanentRecord: false });
  assert.equal(r.permanentRecord, 0);
  assert.equal(r.total, 110);
});

test('costCredits: permanentRecord true → 20 credits surcharge', () => {
  const r = costCredits({ sizeBytes: 1_000_000_000, permanentRecord: true });
  assert.equal(r.permanentRecord, 20);
  assert.equal(r.total, 130); // 10 + 100 + 20
});

test('costCredits: 0 bytes with permanentRecord → 30 total', () => {
  const r = costCredits({ sizeBytes: 0, permanentRecord: true });
  assert.equal(r.transfer, 10);
  assert.equal(r.storage, 0);
  assert.equal(r.permanentRecord, 20);
  assert.equal(r.total, 30);
});

test('costCredits: permanentRecord defaults to false', () => {
  const r = costCredits({ sizeBytes: 1_000_000_000 });
  assert.equal(r.permanentRecord, 0);
});

// ---------------------------------------------------------------------------
// costCredits — known cost-card examples from spec §2.2
// "1.4 GB transfer costs ~210 credits"
// ---------------------------------------------------------------------------

test('costCredits: spec example — 1.4 GB = 210 credits', () => {
  const r = costCredits({ sizeBytes: 1_400_000_000 });
  assert.equal(r.total, 210);
});

// ---------------------------------------------------------------------------
// costCredits — output fields carry no forbidden vocabulary
// ---------------------------------------------------------------------------

test('costCredits: no field name contains "sat", "ecash", "token"', () => {
  const r = costCredits({ sizeBytes: 1_000_000_000, permanentRecord: true });
  const keys = Object.keys(r).join(' ');
  assert.ok(!keys.includes('sat'), 'no "sat" in field names');
  assert.ok(!keys.includes('ecash'), 'no "ecash" in field names');
  assert.ok(!keys.includes('token'), 'no "token" in field names');
});

// ---------------------------------------------------------------------------
// costCredits — error cases
// ---------------------------------------------------------------------------

test('costCredits: negative sizeBytes throws TypeError', () => {
  assert.throws(
    () => costCredits({ sizeBytes: -1 }),
    TypeError,
  );
});

test('costCredits: non-number sizeBytes throws TypeError', () => {
  assert.throws(
    () => costCredits({ sizeBytes: '1gb' }),
    TypeError,
  );
});

test('costCredits: Infinity throws TypeError', () => {
  assert.throws(
    () => costCredits({ sizeBytes: Infinity }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// gbpReference — happy path
// ---------------------------------------------------------------------------

test('gbpReference: 110 credits at £89,000/BTC → correct GBP', () => {
  // 110 sat / 100,000,000 sat × 89,000 GBP
  const result = gbpReference(110, 89_000);
  const expected = (110 / 100_000_000) * 89_000;
  assert.equal(result, expected);
  // Sanity check magnitude: 110 sat at £89,000/BTC ≈ £0.0979
  assert.ok(result > 0 && result < 1, 'GBP reference is a small positive number under £1');
});

test('gbpReference: 210 credits at £89,000/BTC → correct GBP', () => {
  const result = gbpReference(210, 89_000);
  const expected = (210 / 100_000_000) * 89_000;
  assert.equal(result, expected);
});

test('gbpReference: 0 credits → 0 GBP (not null)', () => {
  const result = gbpReference(0, 89_000);
  assert.equal(result, 0);
});

// ---------------------------------------------------------------------------
// gbpReference — null cases
// ---------------------------------------------------------------------------

test('gbpReference: null btcRefRate → null', () => {
  assert.equal(gbpReference(110, null), null);
});

test('gbpReference: undefined btcRefRate → null', () => {
  assert.equal(gbpReference(110, undefined), null);
});

test('gbpReference: 0 btcRefRate → null (not a real rate)', () => {
  assert.equal(gbpReference(110, 0), null);
});

test('gbpReference: negative btcRefRate → null', () => {
  assert.equal(gbpReference(110, -1000), null);
});

test('gbpReference: NaN btcRefRate → null', () => {
  assert.equal(gbpReference(110, NaN), null);
});

test('gbpReference: Infinity btcRefRate → null', () => {
  assert.equal(gbpReference(110, Infinity), null);
});

test('gbpReference: null creditsTotal → null', () => {
  assert.equal(gbpReference(null, 89_000), null);
});

test('gbpReference: undefined creditsTotal → null', () => {
  assert.equal(gbpReference(undefined, 89_000), null);
});

test('gbpReference: NaN creditsTotal → null', () => {
  assert.equal(gbpReference(NaN, 89_000), null);
});

test('gbpReference: both null → null', () => {
  assert.equal(gbpReference(null, null), null);
});

test('gbpReference: string inputs → null', () => {
  assert.equal(gbpReference('110', 89_000), null);
  assert.equal(gbpReference(110, '89000'), null);
});
