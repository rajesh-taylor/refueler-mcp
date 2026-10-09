# @refueler/mcp-server

[![Apache 2.0](https://img.shields.io/badge/licence-Apache_2.0-blue)](./LICENSE)

---

## What this is

An MCP server that runs in your own infrastructure and gives an AI agent a
privacy-first file-transfer capability backed by Refueler Share. The server
handles local encryption, BLAKE3 part integrity, and upload orchestration;
the encrypted parts go straight to R2 under signed URLs, so the Refueler
Worker never holds a byte of your file and could not read it if it did.
Five tools ship: `refueler_capabilities`, `refueler_quote`,
`refueler_balance`, `refueler_send_file`, and `refueler_check_transfer`.

> **Status: in development — not yet published to npm.** `refueler_send_file`
> now drives the Worker's direct-to-R2 path (`initiate` → signed PUTs
> straight to R2 → `finalise`) and makes link format v2 links. A permanent
> record (the Bitcoin-anchored date seal) is browser-side only and this
> server refuses the option rather than faking it.

The identity rail — HMAC-authenticated, credit-pool-funded — is the first
rail this server targets. The anonymous rail, which settles transfers over Lightning
with no identity at all, gates on the B7 infrastructure milestone and is not
in this release.

---

## Trust boundary

This is the section that matters. Read it once; it decides whether this
product is right for your threat model.

**What the server does in your infrastructure**

- Splits files into 32 MiB parts and encrypts each one locally with
  AES-256-GCM before anything leaves the process. The part key is derived
  from the transfer key with HKDF-SHA256, and each part gets its own counter
  nonce with a last-part flag, so no two parts are ever encrypted under the
  same key and nonce and a reordered, dropped or appended part fails its tag.
- Puts the transfer key, the real filename and the exact plaintext size in
  the returned `share_url` fragment only — never transmitted to the Refueler
  Worker, never written to a log, never present in any request.
- Computes a BLAKE3 hash over each ciphertext part and the Merkle root over
  those hashes, and hands both to the Worker when the upload is finalised.
- Uploads each encrypted part directly to R2 under a URL the Worker signed
  for that part's exact byte length. The Worker is not in the data path.
- Holds your API credentials (`rfs_live_`, `rfs_sign_`) locally, in your
  environment. They are used to sign HMAC-SHA256 requests outbound to the
  Refueler API. They never leave your infrastructure in any request payload.
- On the anonymous rail (B7): holds a local stack of blind-signed capability
  tokens. The balance is your local state — Refueler's server is blind to it.

**What the Refueler Worker sees**

- The per-part BLAKE3 hashes and the Merkle root over them. Not the parts
  themselves — those go straight to R2.
- The part count, the total byte count, the UUID, the credential commitment
  and the expiry. The byte count is used for the cap, the cost and the tail
  URL's signed length, and is not stored.
- On the identity rail: your `rfs_live_` handle and an optional
  `transfer_ref` you supply for your own attribution. No plaintext.
  No key. No passphrase.

There is no upload-time file-type check. The Worker never learns or stores
the file type.

**What the Refueler Worker never sees**

- Plaintext bytes. The Worker is a blind byte-relay; it physically cannot
  produce your file content under compulsion because it never held the key.
- The transfer key, or the part key derived from it.
- The passphrase, if set. The Worker receives only a SHA-256 hash of the
  passphrase — not the passphrase itself.
- The filename. It travels in the URL fragment alongside the transfer key,
  never in any request; `X-File-Name` is always the constant
  `encrypted-payload`.

- On the anonymous rail: any identity, email address, or Supabase row. The
  anonymous rail has no identity by architectural construction, not policy.

The size is a different matter, and worth stating plainly: it is not hidden.
The part count gives it to within 32 MiB, and R2 object sizes give it exactly
to anyone with storage access. The fragment carries the exact size so the
recipient can check the part count, not to conceal it.

**What "part integrity" means, and what it does not**

Ciphertext storage integrity is live on the Refueler Worker. At upload,
the per-part BLAKE3 hashes and the Merkle root over them
(`rfc6962-unbalanced-blake3-v1`) are recorded when the transfer is
finalised. On download, the Worker reconstructs the root and checks it
before it serves the first byte, and refuses (`409`) on any mismatch. The
claim this supports is "the encrypted object served equals the encrypted
object stored" — ciphertext storage integrity.

It is not end-to-end file integrity. The Worker never sees plaintext, so it
cannot vouch for the file you meant to send. Only the recipient, after
decrypting, can check the plaintext — and that check never passes through
this server or the Worker.

The part encryption carries its own, separate guarantee. Each part's nonce
commits to its index and to whether it is the last part, so a part served out
of order, a missing part or an appended one fails its authentication tag in
the recipient's own decrypt. That is the recipient's check, not Refueler's.

**The server runs in your infrastructure.** Refueler has no visibility
into your MCP server process, your credential store, or your agent's
conversation history. If your security model requires an audit,
the full source is on GitHub under Apache 2.0.

---

## Requirements

- Node.js ≥ 20
- Credentials from `refueler.io/share/` — you need two keys per
  credential relationship:
  - `rfs_live_…` — identifies the API relationship
  - `rfs_sign_…` — signs outbound requests (HMAC-SHA256)
- `rfs_whsec_…` is the webhook signing secret for **your own** endpoint to
  verify with. This server does not read it, and webhooks are not firing
  today — see the note under `refueler_check_transfer` below.

Environment variable names:

```
REFUELER_LIVE_KEY=rfs_live_…
REFUELER_SIGN_KEY=rfs_sign_…
REFUELER_API_BASE=https://api.share.refueler.io
```

Use a `.env` file for local development or a secrets manager for
production. Never commit key values to version control — the `rfs_live_`
and `rfs_sign_` prefixes are pattern-matched by common secret scanners.

---

## Install

Not yet on npm (see Status above). When published:

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

**`refueler_balance`** — the current credit balance for this credential. On
the identity rail, the live server balance, allocation and period end. On the
anonymous rail, your locally held credit count, which the server cannot see.
No spend occurs.

**`refueler_send_file`** — encrypt and send a file. Splits into 32 MiB parts,
encrypts and BLAKE3-hashes each one locally, uploads them straight to R2
under signed URLs, then finalises with the Merkle root. Returns a `share_url`
carrying the transfer key, the real filename and the exact size in its
fragment. Accepts an optional passphrase for a second access factor. Deducts
credits from your pool on issuance.

**`refueler_check_transfer`** — pull a signed receipt. The acceptance receipt
is written when the transfer is finalised; the collection receipt once the
recipient has downloaded. These are *collection* receipts — they confirm
collection, not delivery. Delivery to a specific person is not something the
server can verify, and this product does not claim it.

> **Receipts need a registered webhook.** Receipts are signed with your
> `rfs_whsec_`, which exists only once you register a webhook
> (`POST /api/v1/webhook/register`). Without one there is no receipt to return.
> Live since 9 Oct 2026 (Worker API-Repair-1); receipts are `refueler.receipt.v2`,
> name your `org_account_id`, and only your own keys can pull them.

**Gates on B7:** Anonymous-rail sends — where no identity is associated with
the transfer and credits settle over Lightning — require the B7/NB-4
Lightning infrastructure milestone. The tool is present in v0.1 but the
anonymous rail is not available until that milestone lands.

**Gates on Silent Drop:** `refueler_receive` — a standing agent-to-agent
inbox — is not in v0.1. A recipient in v0.1 collects via a browser link.

---

## Licence

Apache 2.0. §3 of the licence gives you an express patent licence from
contributors for their contributions, so you can build on this server
without patent risk from those who wrote it.

---

## Roadmap

- **Anonymous rail (B7):** Lightning-settled transfers with no identity
  required — credits purchased over BOLT11, stored locally, spent per send.
- **Silent Drop standing inbox (SD-block):** `refueler_receive` — publish
  a receiving address; senders lodge ciphertext without a prior link exchange.
- **Inline Lightning payment (B9+):** the agent prices a transfer, pays
  inline in the same tool call, and sends — no separate top-up step.
