# Household ingest spike

Mocked end-to-end path for [#7](https://github.com/h3ndr1k-com/finance-tracker/issues/7) / [ADR 0001](../../docs/adr/0001-household-payment-automation.md).

**This is not production.** There is no real bank, no real mailbox, and no credentials in git. Fixtures use `MOCK *` merchants only.

## What it proves

1. A job can run **once** or on a **schedule**.
2. New/changed payments land in a **review queue** — they are not written to a ledger.
3. Re-running the same day (same provider IDs, or the same date/amount/desc/account fingerprint) is **idempotent**.
4. An authenticated API can list the queue. A missing/wrong bearer token is rejected.

## Commands

```bash
# from this directory
node --test tests/spike.test.js
node bin/run.js --once --fixture fixtures/day-1.json
node bin/run.js --once --fixture fixtures/day-2.json   # includes duplicates from day-1
```

Optional schedule (prints each tick; Ctrl+C to stop):

```bash
node bin/run.js --schedule 2000 --fixture fixtures/day-1.json
```

Optional API (default token `spike-dev-token`, not a real secret):

```bash
SPIKE_TOKEN=spike-dev-token node bin/api.js
curl -H 'Authorization: Bearer spike-dev-token' http://127.0.0.1:8787/review
```

## Dedup

1. **Provider transaction ID** (`providerTxId`) if present — stable across re-fetches.
2. Else the same conservative fingerprint Ledger already uses for CSV import: `txHash(date|amount|desc|account)` (djb2, 36-radix).

Rows that already exist in the mocked household ledger, or were already queued/approved, are skipped.

## Layout

- `lib/fingerprint.js` — matches `txHash` in `index.html`
- `lib/mock-provider.js` — fake bank/statement source
- `lib/normalize.js` — provider payload → proposal
- `lib/queue.js` — file-backed review queue (`.tmp/`, gitignored)
- `lib/job.js` — one scheduled tick
- `lib/api.js` — authenticated GET `/review`
- `fixtures/` — fake days only
