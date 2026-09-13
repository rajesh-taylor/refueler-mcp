# @refueler/mcp-server

[![npm](https://img.shields.io/npm/v/@refueler/mcp-server)](https://www.npmjs.com/package/@refueler/mcp-server)
[![Apache 2.0](https://img.shields.io/badge/licence-Apache_2.0-blue)](./LICENSE)

---

## What this is

An MCP server that runs in your own infrastructure and gives an AI agent a
privacy-first file-transfer capability backed by Refueler Share. The server
handles local encryption, BLAKE3 chunk integrity, and upload orchestration;
the Refueler Worker relays the resulting ciphertext to R2 storage without
being able to read it. Four tools ship in v0.1: `refueler_capabilities`,
`refueler_quote`, `refueler_send_file`, and `refueler_check_transfer`. The
identity rail — HMAC-authenticated, credit-pool-funded — is live and
demoable today. The anonymous rail, which settles transfers over Lightning
with no identity at all, gates on the B7 infrastructure milestone and is not
in this release.

---

## Trust boundary

This is the section that matters. Read it once; it decides whether this
product is right for your threat model.

**What the server does in your infrastructure**

- Chunks and encrypts files locally using AES-256-GCM before anything
  leaves the process. The session key lives in the returned `share_url`
  fragment only — it is never transmitted to the Refueler Worker, never
  written to a log, never present in any request.
- Computes a BLAKE3 integrity hash over each ciphertext chunk and verifies
  it on the Worker's behalf. The Worker rejects any chunk whose hash does
  not match.
- Holds your API credentials (`rfs_live_`, `rfs_sign_`) locally, in your
  environment. They are used to sign HMAC-SHA256 requests outbound to the
  Refueler API. They never leave your infrastructure in any request payload.
- On the anonymous rail (B7): holds a local stack of blind-signed capability
  tokens. The balance is your local state — Refueler's server is blind to it.

**What the Refueler Worker sees**

- Ciphertext chunks and their BLAKE3 hashes.
- Byte counts, UUID, credential commitment, and expiry.
- The declared Content-Type at the upload boundary, checked against an
  execution-capable denylist and not stored.
- On the identity rail: your `rfs_live_` handle and an optional
  `transfer_ref` you supply for your own attribution. No plaintext.
  No key. No passphrase.

**What the Refueler Worker never sees**

- Plaintext bytes. The Worker is a blind byte-relay; it physically cannot
  produce your file content under compulsion because it never held the key.
- The AES-256-GCM session key.
- The passphrase, if set. The Worker receives only a SHA-256 hash of the
  passphrase — not the passphrase itself.
- The filename. From SW-MCP-4 onward, the filename travels in the URL
  fragment alongside the session key, never in any request. Until that
  release, the filename is present in the upload manifest — scope your trust
  claims accordingly.
- On the anonymous rail: any identity, email address, or Supabase row. The
  anonymous rail has no identity by architectural construction, not policy.

**What "chunk integrity" means, and what it does not**

Per-chunk BLAKE3 verification is live: the Worker rejects tampered or
corrupted individual chunks at upload. Full Merkle-root verification —
where the Worker reconstructs the complete ciphertext Merkle tree on
download and compares it against the root committed at upload — is
in build (B9) and not yet live. Until B9-3 ships, the correct claim is
"chunk integrity," not "ciphertext storage integrity" and not
"end-to-end file integrity." The recipient's browser verifies the
full plaintext BLAKE3 root on their side; that is the end-to-end check.
It does not pass through this server.

**The server runs in your infrastructure.** Refueler has no visibility
into your MCP server process, your credential store, or your agent's
conversation history. If your security model requires an audit,
the full source is on GitHub under Apache 2.0.

---

## Requirements

- Node.js ≥ 18
- Credentials from `refueler.io/share/` — you need two keys per
  credential relationship:
  - `rfs_live_…` — identifies the API relationship
  - `rfs_sign_…` — signs outbound requests (HMAC-SHA256)
- Optional: `rfs_whsec_…` — webhook signing verification (Chartered /
  identity-API tier only)

Environment variable names:

```
REFUELER_LIVE_KEY=rfs_live_…
REFUELER_SIGN_KEY=rfs_sign_…
REFUELER_WHSEC_KEY=rfs_whsec_…   # optional; Chartered tier only
REFUELER_API_BASE=https://api.share.refueler.io
```

Use a `.env` file for local development or a secrets manager for
production. Never commit key values to version control — the `rfs_live_`
and `rfs_sign_` prefixes are pattern-matched by common secret scanners.

---

## Install

```bash
npm install @refueler/mcp-server
```

Add to your MCP host configuration — the exact method depends on your
agent framework. The server expects credentials via environment variables
or a `.env` file in the working directory. You manage your own config;
no credentials are ever pulled from a remote source by this package.

---

## Tools

**`refueler_capabilities`** — discover the live feature set and rate card.
Unauthenticated, free, called automatically before any send. The agent
will not offer features the server cannot honour.

**`refueler_quote`** — price a transfer before committing. Returns cost in
Share credits, your remaining balance, and whether the transfer would exceed
your allocation. No spend occurs.

**`refueler_send_file`** — encrypt and send a file. Chunks, encrypts, and
BLAKE3-hashes locally; uploads ciphertext to R2; returns a `share_url` with
the session key in the fragment. Accepts an optional passphrase for a second
access factor. Deducts credits from your pool on issuance.

**`refueler_check_transfer`** — pull a signed receipt. Acceptance receipt is
available immediately after upload. Collection receipt is available once the
recipient has downloaded. These are collection receipts — they confirm
collection, not delivery; delivery to a specific person is not something the
server can verify.

**Gates on B7:** Anonymous-rail sends — where no identity is associated with
the transfer and credits settle over Lightning — require the B7/NB-4
Lightning infrastructure milestone. The tool is present in v0.1 but the
anonymous rail is not available until that milestone lands.

**Gates on Silent Drop:** `refueler_receive` — a standing agent-to-agent
inbox — is not in v0.1. A recipient in v0.1 collects via a browser link.

---

## Licence

Apache 2.0. The patent grant clause in §3 of the Apache licence covers
the BLAKE3 + Cashu combination used in this server and in the Refueler
Worker, so you can build on it without worrying about downstream patent risk
from that pairing.

---

## Roadmap

- **Anonymous rail (B7):** Lightning-settled transfers with no identity
  required — credits purchased over BOLT11, stored locally, spent per send.
- **Silent Drop standing inbox (SD-block):** `refueler_receive` — publish
  a receiving address; senders lodge ciphertext without a prior link exchange.
- **Inline Lightning payment (B9+):** the agent prices a transfer, pays
  inline in the same tool call, and sends — no separate top-up step.
