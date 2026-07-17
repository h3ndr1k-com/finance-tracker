# Ledger

Local, private, multi-currency personal finance tracker. No accounts, no backend, no build step. Data lives in your browser (IndexedDB); optional two-device sync goes through **your own Dropbox**, encrypted before it leaves the device.

## Run it

Service workers don't run from `file://`, so serve the folder: `python3 -m http.server 8000`, open `http://localhost:8000`. For phones, deploy the folder as a static site (Vercel: `vercel --prod`) and open the https URL - then "Add to Home Screen" on each device. Works fully offline after first load.

Empty on first open: click **Load sample data** (or Settings → Load sample data) to explore a 3-month multi-currency dataset, then **Wipe all data** and drop in your real CSVs.

## Getting your data in

**Credit card:** the web portal's "Download transactions / statement → CSV". **Wealthsimple:** Activity → Export, or Statements → CSV, once per account. Drag the files onto the app, confirm the column mapping once per format (it's remembered per file layout), and re-importing overlapping statements adds zero duplicates. There is no live bank connection by design - that needs a server holding your credentials, which is the one thing this app refuses to be.

**Exchange rates:** Settings → enter EUR-per-unit rates for USD/CAD (e.g. USD 0.92). Everything converts to your base currency (default CAD) through these manual rates; edit one and every view recalculates. Originals are never overwritten.

**Jars** are T. Harv Eker allocation buckets - income auto-splits by percentage, spending draws from each category's jar, all editable. The **Recurring** panel on Overview auto-detects subscriptions and flags price hikes.

## Sync (optional, two devices)

Off by default. When on, each device encrypts a full snapshot with a passphrase and stores it at `/Apps/Ledger/ledger.bin` in your Dropbox. Dropbox holds ciphertext it cannot read, and the static host never sees your data at all.

1. **Create a Dropbox app** at [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps): choose *Scoped access* → *App folder* → name it. Under **Permissions** enable `files.content.read` and `files.content.write`. Under **Settings → OAuth 2 → Redirect URIs** add your deployed URL (e.g. `https://ledger-xyz.vercel.app/`) and `http://localhost:8000/` if you develop locally. Copy the **App key**.
2. **On each device:** Settings → Sync → paste the App key → Connect Dropbox → approve.
3. **On each device:** set the **same passphrase**. This is what encrypts the file.

After that it syncs on open, on focus, and a few seconds after any edit. There's also a manual **Sync now**.

**Keep a passphrase you won't lose.** It never leaves your devices and there is no reset - if you both forget it, the Dropbox copy is unrecoverable. Export JSON is the escape hatch; keep one somewhere safe.

### How conflicts resolve

Last-write-wins per record. Two deliberate consequences worth knowing:

- **Editing beats deleting.** If one device deletes a transaction and the other edits it afterwards, the edit wins and the row comes back. Losing an edit is worse than resurrecting a row you can delete again.
- **Re-importing beats an old delete.** Delete a row, re-import that statement later, and it stays - that's what re-importing means.

Two people editing *the same transaction* within one sync window: the later edit wins outright (not merged field-by-field). Rare enough at two-person volume to not be worth the machinery.

**Not synced:** receipt images (the transaction and its data sync; the photo stays on the device that scanned it), and your light/dark theme (deliberately per-device). Sync needs IndexedDB, so it's unavailable in private-browsing modes.

**Wipe all data** clears this device and unlinks it from Dropbox. The other device is untouched.
