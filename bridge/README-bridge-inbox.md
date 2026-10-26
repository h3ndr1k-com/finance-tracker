# Encrypted bridge inbox (Mac → iPhone)

Hermes still writes to the local add-only queue (`~/.hermes/finance-bridge/queue.json`). A Mac background job encrypts pending items into a separate household blob at `/api/bridge-inbox` (LED1 / same passphrase as sync). Any device with the passphrase consumes that inbox during normal sync, merges transactions once (`bridge:<queue-uuid>` ids), and acks by uploading a trimmed inbox.

The loopback bridge (`ledger-bridge.js serve` + Ledger **Pair this Ledger**) is unchanged as a fallback when Ledger is open on the Mac.

## One-time Mac setup

1. **Household sync** must already work (token + passphrase on phone and at least one upload of the main snapshot).

2. **Copy config** (adjust paths if your repo lives elsewhere):

   ```bash
   cp bridge/inbox-push.example.json ~/.hermes/finance-bridge/inbox-push.json
   chmod 600 ~/.hermes/finance-bridge/inbox-push.json
   ```

3. **Secrets on disk only** (mode `600`, never commit):

   ```bash
   printf '%s\n' 'YOUR_HOUSEHOLD_TOKEN' > ~/.hermes/finance-bridge/household-token
   printf '%s\n' 'YOUR_SYNC_PASSPHRASE' > ~/.hermes/finance-bridge/sync-passphrase
   chmod 600 ~/.hermes/finance-bridge/household-token ~/.hermes/finance-bridge/sync-passphrase
   ```

   Optional: store the passphrase in Keychain and point `passphraseFile` at a small wrapper script that runs `security find-generic-password -s ledger-sync -w`.

   Salt is read automatically from the existing `/api/sync` or `/api/bridge-inbox` LED1 header. If both are empty, the first push creates `~/.hermes/finance-bridge/sync-salt.b64` — use the same passphrase as on your devices.

4. **Restart the loopback bridge** (if you use Telegram check-in):

   ```bash
   node /path/to/ledger/bridge/ledger-bridge.js serve
   ```

5. **Install the launchd job** (runs `inbox-push.js` every 2 minutes):

   ```bash
   cp bridge/com.ledger.bridge-inbox.plist.example ~/Library/LaunchAgents/com.ledger.bridge-inbox.plist
   # Edit ProgramArguments: node path + inbox-push.js path
   launchctl load ~/Library/LaunchAgents/com.ledger.bridge-inbox.plist
   ```

6. **Manual test push**:

   ```bash
   node bridge/inbox-push.js
   ```

   Pending queue items should disappear from `queue.json` acknowledgements after a successful push (same as if Ledger had pulled them locally).

## Bridge `--source`

Tag Grok Bot entries:

```bash
node bridge/ledger-bridge.js enqueue --date 2026-10-24 --desc "Puppet show" --amount -10 --currency CAD --account Cash --category Entertainment --source grokbot
```

Default remains `telegram`.

## Vercel

Deploy this branch so `/api/bridge-inbox` is live. Uses the same `HOUSEHOLD_SYNC_TOKEN` and Blob store as `/api/sync`; no new env vars.

## iPhone end-to-end test

1. Queue a transaction on the Mac (`enqueue` or Hermes).
2. Run `node bridge/inbox-push.js` (or wait for launchd).
3. On iPhone, open Ledger (online, passphrase entered).
4. **Sync now** or wait for automatic sync — the transaction appears with id `bridge:…` and the chosen `source`.
5. Re-sync: no duplicate row.
