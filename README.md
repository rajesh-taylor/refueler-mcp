# @refueler/mcp-server

**Refueler Share — privacy-first encrypted file transfer for AI agents.**

> Refueler Share gives an agent a privacy-first file-transfer capability that runs
> entirely in the agent's own trust domain: files are chunked, encrypted, and
> BLAKE3-hashed locally before anything touches the network, so the Refueler Worker
> relays ciphertext it cannot read and — on the anonymous rail — cannot tie to an
> identity. The v1 toolset lets an agent price a transfer, send a file to any
> recipient with a browser, and pull a signed collection receipt when it's collected,
> paying from a prepaid pool of Share credits. You run the server yourself — it's an
> open-source npm package under Apache 2.0, so your team can audit exactly what it
> does, and Refueler never sees your keys or your plaintext.

---

## Architecture — trust boundary

**This server runs in your infrastructure, not Refueler's.**

That is the point. Encryption happens inside this process, in your trust domain.
The Refueler Worker receives ciphertext it cannot read. On the anonymous rail, it
cannot tie a transfer to an identity. Refueler never sees your keys, your
plaintext, or — on the anonymous rail — who you are.

Do not let a third party host this server on your behalf. The trust model only
holds if the MCP server runs inside the same trust boundary as your agent.

---

## Requirements

- Node.js ≥ 20
- A Refueler Share API credential pair (identity rail)
- `npx @refueler/mcp-server` or `node src/index.js`

---

## Configuration

All configuration is via environment variables. **Never put credential values in a
file that could be committed to git or shared accidentally.**

Place your credentials in your system's secrets manager, your CI environment, or a
`.env` file that is listed in `.gitignore` and never committed.

| Variable | Required | Description |
|---|---|---|
| `REFUELER_LIVE_KEY` | ✅ | `rfs_live_...` identification key from your Refueler dashboard |
| `REFUELER_SIGN_KEY` | ✅ | `rfs_sign_...` request-signing key from your Refueler dashboard |
| `REFUELER_API_BASE` | — | Defaults to `https://api.share.refueler.io` |
| `REFUELER_RAIL` | — | `identity` (default) or `anonymous` (see below) |
| `REFUELER_ANON_CREDITS` | — | Local path to anonymous credit stack JSON (anonymous rail, coming in a future release) |

**Credential files are never copied by an automation tool.** Place them manually.
This is not a workflow limitation — it is a security invariant. The server must never
be able to exfiltrate its own credentials via an automated command.

---

## Quick start

```bash
npm install -g @refueler/mcp-server

export REFUELER_LIVE_KEY=rfs_live_...
export REFUELER_SIGN_KEY=rfs_sign_...

npx @refueler/mcp-server
```

Or add to your MCP client config:

```json
{
  "mcpServers": {
    "refueler": {
      "command": "npx",
      "args": ["@refueler/mcp-server"],
      "env": {
        "REFUELER_LIVE_KEY": "rfs_live_...",
        "REFUELER_SIGN_KEY": "rfs_sign_..."
      }
    }
  }
}
```

---

## Tools (v1)

| Tool | Status | Description |
|---|---|---|
| `refueler_capabilities` | ✅ Live | Fetch service capabilities and rate card. Silent preflight. |
| `refueler_quote` | 🔜 SW-MCP-3 | Price a transfer before spending anything. |
| `refueler_balance` | 🔜 SW-MCP-3 | Check your credit pool balance. |
| `refueler_send_file` | 🔜 SW-MCP-4 | Encrypt locally and lodge a file. Returns a share URL. |
| `refueler_check_transfer` | 🔜 SW-MCP-5 | Pull acceptance and collection receipts. |

**What ships in v1:** the send path, honestly scoped. Standing agent-to-agent inboxes
and inline Lightning payment are on the roadmap, not in this release.

---

## Rails

### Identity rail (available now)
Stripe-billed, server-held credit pool. Monthly allocation. Metered overage up to a
ceiling (API tier). Hard stop at allocation (Personal API). Recoverable, invoiceable,
auditable. The demoable rail today.

### Anonymous rail (coming — gates on B7/NB-4)
Client-held bearer credits stored locally in the agent's trust domain. Topped up via
Lightning. The server is blind to the balance. Non-recoverable. Set
`REFUELER_RAIL=anonymous` and `REFUELER_ANON_CREDITS` to the local credit stack path.
**Not functional in this release.**

---

## Licence

Apache 2.0. Patent grant clause protects the BLAKE3 + Cashu combination.

---

## Links

- [Refueler Share](https://refueler.io/share/)
- [API documentation](https://refueler.io/share/)
- [GitHub](https://github.com/rajesh-taylor/refueler-mcp)
