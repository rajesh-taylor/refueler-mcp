/**
 * src/config.js — Refueler MCP server configuration
 *
 * All secrets are read from environment variables only.
 * Never from a file the operator might accidentally commit.
 *
 * Required:
 *   REFUELER_LIVE_KEY   — rfs_live_... identification key
 *   REFUELER_SIGN_KEY   — rfs_sign_... request-signing key
 *
 * Optional:
 *   REFUELER_API_BASE   — defaults to https://api.share.refueler.io
 *   REFUELER_RAIL       — "identity" (default) | "anonymous" (post-B7)
 *   REFUELER_ANON_CREDITS — local JSON path to anonymous credit stack (post-B7, not functional in v1)
 */

export function loadConfig() {
  const liveKey = process.env.REFUELER_LIVE_KEY;
  const signKey = process.env.REFUELER_SIGN_KEY;

  const missing = [];
  if (!liveKey) missing.push('REFUELER_LIVE_KEY');
  if (!signKey) missing.push('REFUELER_SIGN_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Refueler MCP server cannot start — missing required environment variable(s): ${missing.join(', ')}.\n` +
      `Set these in your environment or secrets manager before running the server.\n` +
      `Never write credential values into a file that could be committed to git.`
    );
  }

  const rail = process.env.REFUELER_RAIL ?? 'identity';
  if (rail !== 'identity' && rail !== 'anonymous') {
    throw new Error(
      `REFUELER_RAIL must be "identity" or "anonymous" — got "${rail}".`
    );
  }

  if (rail === 'anonymous') {
    // Anonymous rail is scaffolded but not functional until SW-MCP-7 (gates on B7/NB-4).
    // We warn and continue — the server starts, but anonymous sends will fail gracefully.
    process.stderr.write(
      '[refueler-mcp] WARNING: REFUELER_RAIL=anonymous is configured but the anonymous rail ' +
      'is not yet functional in this release. Sends will fail with a clear error. ' +
      'Anonymous rail ships when SW-MCP-7 lands (gates on B7/NB-4).\n'
    );
  }

  return {
    liveKey,
    signKey,
    apiBase: (process.env.REFUELER_API_BASE ?? 'https://api.share.refueler.io').replace(/\/$/, ''),
    rail,
    // anonCreditsPath: local JSON path to the credit stack (post-B7, optional).
    // Operator places this file manually — never a `cp` from an automation tool.
    anonCreditsPath: process.env.REFUELER_ANON_CREDITS ?? null,
  };
}
