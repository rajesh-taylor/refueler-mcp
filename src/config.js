/**
 * src/config.js — Refueler MCP server configuration
 *
 * All secrets are read from environment variables only.
 * Never from a file the operator might accidentally commit.
 *
 * Optional, as a pair (fetch is free and keyless; every paid tool needs both):
 *   REFUELER_LIVE_KEY   — rfs_live_... identification key
 *   REFUELER_SIGN_KEY   — rfs_sign_... request-signing key
 *
 * Optional:
 *   REFUELER_API_BASE   — defaults to https://api.share.refueler.io
 *   REFUELER_RAIL       — "identity" (default) | "anonymous" (post-B7)
 *   REFUELER_ANON_CREDITS — local JSON path to anonymous credit stack (post-B7, not functional in v1)
 *   REFUELER_ROOT       — one more folder send and fetch may use, beside the client's roots
 *   REFUELER_LINK_DIR   — where send writes <uuid>.link and <uuid>.password
 *                         (default ~/.refueler/links; folder 0700, files 0600)
 *   REFUELER_LINK_IN_CHAT — "1" puts share_url in send's result and lets
 *                         refueler_fetch take the link as tool input.
 *                         The model provider then receives the key. Operator only.
 *   REFUELER_CONFIRM_SEND — "0" turns off the user's confirmation before a send,
 *                         for unattended use (CI, agent-to-agent). Operator only.
 *   REFUELER_SANDBOX_HOST — one more host whose links fetch accepts (a test Worker)
 */

import path from 'node:path';
import { DEFAULT_LINK_DIR } from './links.js';

const SHARE_HOST = 'share.refueler.io';

export function loadConfig() {
  const liveKey = process.env.REFUELER_LIVE_KEY || null;
  const signKey = process.env.REFUELER_SIGN_KEY || null;

  // Neither key is a keyless server. One without the other is a mistake worth stopping for.
  if (Boolean(liveKey) !== Boolean(signKey)) {
    const missing = liveKey ? 'REFUELER_SIGN_KEY' : 'REFUELER_LIVE_KEY';
    throw new Error(
      `Refueler MCP server cannot start — ${missing} is missing. Set both API keys, or neither.\n` +
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

  const sandboxHost = process.env.REFUELER_SANDBOX_HOST || null;

  return {
    liveKey,
    signKey,
    hasApiKeys: Boolean(liveKey),
    apiBase: (process.env.REFUELER_API_BASE ?? 'https://api.share.refueler.io').replace(/\/$/, ''),
    rail,
    // anonCreditsPath: local JSON path to the credit stack (post-B7, optional).
    // Operator places this file manually — never a `cp` from an automation tool.
    anonCreditsPath: process.env.REFUELER_ANON_CREDITS ?? null,
    linkHosts: sandboxHost ? [SHARE_HOST, sandboxHost] : [SHARE_HOST],
    linkInChat: process.env.REFUELER_LINK_IN_CHAT === '1',
    rootEnv: process.env.REFUELER_ROOT || null,
    linkDir: path.resolve(process.env.REFUELER_LINK_DIR || DEFAULT_LINK_DIR),
    confirmSend: process.env.REFUELER_CONFIRM_SEND !== '0',
  };
}
