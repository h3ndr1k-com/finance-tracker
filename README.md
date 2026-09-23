# Ledger

Local, private, multi-currency personal finance tracker. No accounts, no build step. Data lives in your browser (IndexedDB). Optional live sync uses a **first-party household API** on the same site: one encrypted LED1 snapshot, shared household token, no Dropbox or Google OAuth.

## Run it

Service workers don't run from `file://`. For UI-only local work, `python3 -m http.server 8000` still works. Household sync needs the `/api/sync` function: `npx vercel dev` or the test static server (`node -e "require('./tests/static-server').startStaticServer(8000).then(({port})=>console.log(port))"`). Production is the Vercel deploy — open the https URL, then Add to Home Screen on each phone. Works fully offline after first load; sync runs when you are back online.

Empty on first open: click **Load sample data** (or Settings → Load sample data) to explore a 3-month multi-currency dataset, then **Wipe all data** and drop in your real CSVs.

## Getting your data in

**Credit card:** the web portal's "Download transactions / statement → CSV". **Wealthsimple:** Activity → Export, or Statements → CSV, once per account. Drag the files onto the app, confirm the column mapping once per format (it's remembered per file layout), and re-importing overlapping statements adds zero duplicates. There is no live bank connection by design - that needs a server holding your credentials, which is the one thing this app refuses to be.

A proposed daily review-queue (still no bank creds in the PWA) is documented in [`docs/adr/0001-household-payment-automation.md`](docs/adr/0001-household-payment-automation.md) and exercised by the mocked spike in [`spike/household-ingest/`](spike/household-ingest/).

**Exchange rates:** Settings → enter EUR-per-unit rates for USD/CAD (e.g. USD 0.92). Everything converts to your base currency (default CAD) through these manual rates; edit one and every view recalculates. Originals are never overwritten.

**Jars** are T. Harv Eker allocation buckets - income auto-splits by percentage, spending draws from each category's jar, all editable. The **Recurring** panel on Overview auto-detects subscriptions and flags price hikes.

## Sync (optional, household devices)

Off by default. When on, each device encrypts a full snapshot with a passphrase (LED1 / AES-GCM) and `GET`/`PUT`s that ciphertext to **`/api/sync` on this same origin**. The server stores bytes it cannot read. Connect never leaves the home-screen PWA — there is no OAuth redirect.

**Every device uses the same household token and the same passphrase.** That is one household identity and one ciphertext (issue #13). Disconnect or wipe on one phone does not wipe the others or the household copy.

1. **Once on the host:** set `HOUSEHOLD_SYNC_TOKEN` in the Vercel project (encrypted env). Production also uses the private Blob store (`BLOB_READ_WRITE_TOKEN`) for `household/ledger.bin`. Local tests use a temp directory.
2. **Once on each device** (Hendrik’s phone, desktop, and the other phone): open Ledger → Settings → Sync → paste the household token → **Connect household** → enter the **same passphrase** → Unlock & sync.

If sync fails, open **Settings → Sync diagnostics** for service-worker state, connection status, and a concrete next step (missing token, reconnect, offline, wrong passphrase, conflict/rate limit). Secrets (token, passphrase) are never shown there.

After that it syncs on open, on focus, and a few seconds after any edit. There's also a manual **Sync now**.

**Keep a passphrase you won't lose.** It never leaves your devices and there is no reset — if you both forget it, the household copy is unrecoverable. Export JSON is the escape hatch; keep one somewhere safe.

### How conflicts resolve

Last-write-wins per record. Two deliberate consequences worth knowing:

- **Editing beats deleting.** If one device deletes a transaction and the other edits it afterwards, the edit wins and the row comes back. Losing an edit is worse than resurrecting a row you can delete again.
- **Re-importing beats an old delete.** Delete a row, re-import that statement later, and it stays - that's what re-importing means.

Two people editing *the same transaction* within one sync window: the later edit wins outright (not merged field-by-field). Rare enough at two-person volume to not be worth the machinery.

**Not synced:** receipt images (the transaction and its data sync; the photo stays on the device that scanned it), and your light/dark theme (deliberately per-device). Sync needs IndexedDB, so it's unavailable in private-browsing modes.

**Wipe all data** or **Disconnect** clears this device only. The other devices and the household snapshot stay.

## Design handoff

The production design system lives in [`design-assets/`](design-assets/): concept explorations, light/dark tokens, component snippets, responsive mockups, and the printable style guide. See [`IMPLEMENTATION_NOTES.txt`](IMPLEMENTATION_NOTES.txt) for the hover/refresh root-cause report and QA checklist.

```bash
npm install
npx playwright install chromium
npm test
```

`npm test` runs unit checks (`sw.js` / sync issue mapping), UI QA, and the PWA/sync regression (service-worker upgrade + mobile tab bar + diagnostics). Set `LEDGER_QA_BROWSER` to `firefox` or `webkit` for the cross-engine UI checks.
