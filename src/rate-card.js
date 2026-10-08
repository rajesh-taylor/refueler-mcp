// src/rate-card.js — refueler-mcp
// Rate card v1.0. Pure functions, no I/O.
// 1 credit = 1 sat (internal canonical unit).
// User-facing copy always says "credits" — never sats, ecash, tokens.

'use strict';

export const RATE_CARD_VERSION = 'v1.0';

// Transfer fixed cost in credits.
const TRANSFER_CREDITS = 10;

// Storage cost per full or partial GB band in credits.
const STORAGE_CREDITS_PER_GB = 100;

// Permanent-record surcharge in credits.
const PERMANENT_RECORD_CREDITS = 20;

// Bytes in one GB band — BINARY (GiB), 1024³.
//
// MCP-Fix-1 (Rajesh, 8 Oct 2026): match what the Worker actually charges.
// worker/src/r2_presign.js computeTransferCost() divides by 1024³ and that is
// the number debited from the credit pool at /initiate. This file previously
// used decimal 1e9 "matching spec §2.2", which made the quote disagree with the
// invoice: a 1.0 GiB file quoted 210 credits and was charged 110. A quote that
// does not match the debit is worse than a spec typo, so the Worker wins and
// the spec is corrected to say GiB.
//
// If the Worker's GIB constant ever changes, change this with it, in the same
// session. The two are one decision.
const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * costCredits({ sizeBytes, permanentRecord })
 *
 * Pure cost calculation — no network, no config.
 * Returns breakdown and total in credits.
 *
 * @param {object} opts
 * @param {number} opts.sizeBytes       — file size in bytes (>= 0)
 * @param {boolean} [opts.permanentRecord=false]
 * @returns {{ transfer: number, storage: number, permanentRecord: number, total: number }}
 */
export function costCredits({ sizeBytes, permanentRecord = false }) {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new TypeError('sizeBytes must be a non-negative finite number');
  }

  // Ceiling division: 0 bytes → 0 storage credits.
  // Any positive fraction of a GB rounds up to the full GB band.
  const storageCredits = sizeBytes === 0
    ? 0
    : Math.ceil(sizeBytes / BYTES_PER_GB) * STORAGE_CREDITS_PER_GB;

  const permanentRecordCredits = permanentRecord ? PERMANENT_RECORD_CREDITS : 0;

  const total = TRANSFER_CREDITS + storageCredits + permanentRecordCredits;

  return {
    transfer: TRANSFER_CREDITS,
    storage: storageCredits,
    permanentRecord: permanentRecordCredits,
    total,
  };
}

/**
 * gbpReference(creditsTotal, btcRefRate)
 *
 * Convert a credit total to a GBP reference figure using the daily rate
 * from the capabilities endpoint.
 *
 * Formula: (creditsTotal / 100_000_000) × gbp_per_btc
 * (1 credit = 1 sat; 100,000,000 sats = 1 BTC)
 *
 * Returns null when either argument is missing, zero, or non-finite.
 * Never invents a rate.
 *
 * @param {number} creditsTotal    — total cost in credits
 * @param {number} btcRefRate      — gbp_per_btc integer from capabilities response
 * @returns {number | null}
 */
export function gbpReference(creditsTotal, btcRefRate) {
  if (
    typeof creditsTotal !== 'number' ||
    !Number.isFinite(creditsTotal) ||
    creditsTotal < 0 ||
    typeof btcRefRate !== 'number' ||
    !Number.isFinite(btcRefRate) ||
    btcRefRate <= 0
  ) {
    return null;
  }

  return (creditsTotal / 100_000_000) * btcRefRate;
}
