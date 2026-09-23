# ADR 0001 — Daily reviewable household-payment automation

- **Status:** Proposed (spike validated; implementation not started)
- **Date:** 2026-09-23
- **Issue:** [#7](https://github.com/h3ndr1k-com/finance-tracker/issues/7)
- **Spike:** [`spike/household-ingest/`](../../spike/household-ingest/)

## Context

Ledger is a static, local-first PWA. It accepts manual CSV imports and syncs one encrypted snapshot through a single Dropbox app folder. Browser service workers cannot run a reliable daily job or hold bank credentials.

The household (Canada, CAD base, Wealthsimple + card CSVs today, two spouses / two devices) wants a **daily, reviewable** update flow **without** placing bank credentials in the PWA, browser storage, or Dropbox.

This ADR picks the smallest privacy-preserving server-side path and records decisions that must be true before a real backend is built.

## Decision

**Phase 1 (smallest):** a scheduled server job ingests **user-approved statement/CSV files** (email-forward or private file drop). It normalizes rows, deduplicates, and writes a **review queue**. The PWA never sees bank logins. The ledger is not mutated until a human approves an item.

**Phase 2 (only if Phase 1 is too manual):** one open-banking provider — **Plaid Transactions (Canada)** — with access tokens stored only on the server. Same review queue; still no auto-apply to the ledger.

**Household model:** one shared household identity and one canonical ledger, with two device sessions. Not per-spouse RBAC in v1.

**Sync:** keep **client-side encryption** for the canonical snapshot (today: Dropbox `ledger.bin`). The review queue is a short-lived server-side list of *proposals*. After approval, the PWA applies rows locally (same `txHash` as CSV import) and Dropbox merge remains the two-device bus until a later household-sync service replaces it.

**Do not** put bank credentials, OAuth refresh tokens for banks, or raw statements in Dropbox or IndexedDB.

## Provider comparison

| Option | What it is | Canada fit | Creds location | Est. monthly cost (2-person household) | Verdict |
|---|---|---|---|---|---|
| **Statement / CSV drop** (email or private bucket) | Daily job reads files the household already exports | Exact match for current Amex / Wealthsimple / EU-bank CSVs | None on our side if the user drops files; mailbox if email-forward is used | Hosting only: **~$0–10** (GitHub Actions free tier, or Fly/Railway hobby) | **Phase 1. Smallest. Ship this first.** |
| **Plaid Transactions** | Open-banking aggregator; Plaid Link; items + transactions API | Big 5 + many cards; Wealthsimple coverage must be re-checked at signup | Bank password goes to Plaid, not us. We store Plaid `access_token` server-side only | Dev: $0. Production: typically **~$1–3 / connected item / month** + review; expect **~$10–40** all-in with hosting. Confirm current Plaid Canada price sheet before signing. | **Phase 2** if daily pull is still wanted after Phase 1 |
| **Flinks (Visa)** | Canada-native aggregation | Often stronger on some Canadian FIs | Same pattern: Flinks holds bank login; we store their token | Sales-led; commonly **hundreds $/month** minimum | Reject for a two-person app unless Plaid cannot cover a required FI |
| **Manual CSV (status quo)** | Drag files in the PWA | Works today | None | $0 | Keep as rollback and as the mapper for Phase 1 |

Open-banking in Canada is still institution-by-institution. Do not assume every card/chequing login works until a Link session succeeds against the real FIs.

## Operating cost (Phase 1)

- Compute: one scheduled Node job + tiny authenticated API. Fly.io / Railway hobby or a GitHub Actions cron + object store.
- Storage: encrypted-at-rest review queue (days, not years) + job logs. A few MB.
- **Budget to plan:** **$0–10 / month** until a bank API is added. Phase 2 adds Plaid item fees.

## Data-retention model

| Data | Where | TTL | Who can read |
|---|---|---|---|
| Bank / Plaid tokens | Server secret store only (Phase 2) | Until household disconnects | Server process |
| Incoming CSV / email payload | Job working dir, then deleted | **24 hours** after a successful enqueue | Server process |
| Review-queue proposals | Server DB, encrypted at rest | **30 days** or until approved/rejected | Household session |
| Approved rows | Client IndexedDB + encrypted Dropbox snapshot | Until the household deletes them | Devices with the passphrase |
| Job logs | Server | **14 days** | Operator |
| Canonical ledger ciphertext | Dropbox app folder (today) | Household-controlled | Devices with the passphrase; Dropbox cannot read |

No real financial credentials or live transactions are stored in this repository. The spike uses obviously fake `MOCK *` merchants.

## Credential handling

1. PWA / AsyncStorage / IndexedDB / `sync-config.json` / Dropbox: **never** store bank passwords, open-banking tokens, or mailbox app passwords.
2. Phase 1 file-drop: the household authenticates to **our** API (one household token or magic link). Files are uploaded over HTTPS.
3. Phase 1 email: a dedicated ingest mailbox; credentials live in the server env, not the client. Prefer file-drop over email when possible (email bodies are statement plaintext).
4. Phase 2: Plaid Link in a trusted web view; rotate and encrypt `access_token` at rest; support item disconnect.
5. Household passphrase (Dropbox encryption) stays on devices only.

## Threat model

| Threat | Impact | Mitigation |
|---|---|---|
| Stolen PWA / phone | Local ledger + Dropbox tokens | Existing passphrase + OS lock; no bank creds to steal |
| Stolen Dropbox app-folder file | Ciphertext only | Client-side AES-GCM; passphrase never uploaded |
| Compromised ingest server | Review-queue plaintext + (Phase 2) provider tokens | Minimal data, short TTL, encrypt at rest, no historical ledger key on the server |
| Compromised ingest mailbox | Recent statements | Dedicated mailbox, 24h delete, prefer file-drop |
| Duplicate / replayed import | Double-spend in the ledger | Provider ID first, then conservative `txHash` (same as today's CSV import); queue is idempotent |
| Confused deputy (two Dropbox accounts) | Split-brain ledgers | Same-account app-folder rule (see README / #6). Phase 4 replaces Dropbox with one household snapshot |
| Malicious review item | Bad category / amount | **No auto-apply.** Human approve. Known recurring merchants may be *suggested* later, not applied in v1 |

## Rollback plan

1. Feature-flag the review API and hide the PWA review screen.
2. Stop the cron. Drain or delete the review queue.
3. Household continues **manual CSV + Dropbox** exactly as today. Import IDs stay compatible (`txHash`), so a later re-enable does not double-import approved rows.
4. Revoke household API tokens and (Phase 2) Plaid items.
5. If a bad approval landed, delete those rows on one device and sync; tombstones already win over older imports when the delete is newer.

## Open decisions (must confirm before Phase 2)

- Exact financial institutions besides Wealthsimple + the current card portal.
- Whether email-forward is acceptable vs file-drop only.
- Hosting vendor (Fly vs Railway vs Actions-only).
- Whether known recurring merchants may auto-apply **after** a later explicit setting. **v1: no.**
- Whether spouses later need distinct logins. **v1: no.**

## Follow-up issues

Sized by subsystem; created with this spike:

1. Backend and household auth — #10
2. Ingestion adapter (statement/CSV drop) — #11
3. Review-queue UI in the PWA — #12
4. Shared household synchronization (evolve or replace Dropbox) — #13

## Spike result

`spike/household-ingest` runs a mocked daily job, writes a review queue, exposes an authenticated read API, and proves that re-importing the same provider IDs / fingerprints is idempotent. See that folder's README for commands.
