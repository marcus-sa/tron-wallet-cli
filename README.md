# tron-wallet-cli (Bun edition)

Multi-profile Tron wallet CLI using Bun and `bun:sqlite`. Generate keypairs,
store multiple named profiles locally, and send TRX / TRC-20 USDT.

## Setup

```bash
bun install
cp .env.example .env
# optionally set WALLET_MASTER_KEY in .env to encrypt private keys at rest
# optionally set TRONGRID_API_KEY (free at https://www.trongrid.io/)
```

Profiles are stored in a local SQLite DB at `~/.tron-wallet-cli/wallet.db`
by default. Override the location with `WALLET_DATA_DIR` — see
[Storing the DB on Proton Drive](#storing-the-db-on-proton-drive-macos) below.

## Profile management

```bash
# Create a new profile (generates a fresh keypair)
bun index.ts profile add alice

# Import an existing private key as a profile
bun index.ts profile import bob <privateKeyHex>

# List all profiles (marks the active one with *)
bun index.ts profile list

# Set which profile is "active" (used by default for balance/send)
bun index.ts profile use alice

# Show a profile's address; add --reveal to also print the private key
bun index.ts profile show alice
bun index.ts profile show alice --reveal

# Delete a profile
bun index.ts profile remove bob
```

## Wallet commands

```bash
# Check balance for a specific profile, or the active one if omitted
bun index.ts balance
bun index.ts balance alice

# Send TRX / USDT using the active profile
bun index.ts send-trx <toAddress> <amount>
bun index.ts send-usdt <toAddress> <amount>

# Or specify a profile explicitly
bun index.ts send-trx <toAddress> <amount> --profile alice
bun index.ts send-usdt <toAddress> <amount> --profile alice
```

## Storing the DB on Proton Drive (macOS)

Proton Drive's desktop app syncs a local folder to the cloud, so pointing
`WALLET_DATA_DIR` at a folder inside it works like any other local path —
Proton Drive handles the sync in the background.

1. Find your local Proton Drive sync folder. It's typically:
   ```
   ~/Library/CloudStorage/ProtonDrive-<your-email>/My files
   ```
   (Check Proton Drive's app settings if the exact path differs for you.)

2. Point the CLI at a subfolder there, e.g. in your `.env`:
   ```
   WALLET_DATA_DIR=/Users/yourname/Library/CloudStorage/ProtonDrive-you@proton.me/My files/tron-wallet-cli
   ```
   or export it in your shell profile:
   ```bash
   export WALLET_DATA_DIR="$HOME/Library/CloudStorage/ProtonDrive-you@proton.me/My files/tron-wallet-cli"
   ```

3. Run any command as usual — the `wallet.db` file will be created there and
   Proton Drive will sync it like any other file.

**Important caveats for a synced DB:**

- **Set `WALLET_MASTER_KEY`.** Anything in a cloud-synced folder should be
  treated as "at rest in the cloud" — encrypt the private keys before they
  ever touch Proton's servers, even though Proton Drive itself is
  end-to-end encrypted.
- **Don't run the CLI from two devices at the same time.** SQLite handles
  concurrent access on one machine fine, but two machines writing to the
  same synced file near-simultaneously can create sync conflicts (Proton
  Drive will usually save a conflicted copy rather than corrupt data, but
  you don't want to find that out mid-transaction).
- **Wait for sync to finish** after a write (`profile add`, `send-trx`,
  etc.) before switching to another device, so you're not reading a
  stale/partially-synced copy.
- This CLI pins the DB to SQLite's `DELETE` journal mode specifically
  because it's safer for synced folders than `WAL` mode (which spreads
  writes across extra sidecar files that can desync from the main `.db`
  file).
- Treat it like a shared, syncable secrets file: a proper backup/version
  history (which Proton Drive does provide) is a nice side benefit here,
  but it's not a substitute for exporting/backing up private keys
  separately if you're managing meaningful funds.

## Encryption at rest

If `WALLET_MASTER_KEY` is set in your environment, private keys are encrypted
with AES-256-GCM (key derived via scrypt) before being written to SQLite.
If it's unset, keys are stored in plaintext — fine for local testing, not
recommended for anything holding real funds.

```bash
export WALLET_MASTER_KEY="a long random passphrase"
bun index.ts profile add prod-wallet
```

**Important:** if you lose `WALLET_MASTER_KEY`, encrypted private keys in the
DB become unrecoverable. Back up your master key and/or exported private
keys separately.

## Making it globally runnable (optional)

```bash
chmod +x index.ts
bun link
tron-wallet profile list
```

## Notes

- New addresses need a small amount of TRX before sending anything, since
  Tron transactions consume TRX for bandwidth/energy.
- `feeLimit` in send-usdt is a cap, not a fixed cost — typical TRC-20
  transfers burn a few TRX worth of energy unless the account has
  pre-staked energy.
- Never commit `.env`, the SQLite DB file, or logs containing revealed keys.
