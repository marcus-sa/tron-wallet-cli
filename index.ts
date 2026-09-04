#!/usr/bin/env bun

/**
 * tron-wallet-cli (Bun edition)
 *
 * Multi-profile Tron wallet CLI backed by bun:sqlite.
 *
 * Usage:
 *   bun index.ts profile add <name>
 *   bun index.ts profile import <name> <privateKeyHex>
 *   bun index.ts profile list
 *   bun index.ts profile use <name>
 *   bun index.ts profile show <name> [--reveal]
 *   bun index.ts profile qr [name]
 *   bun index.ts profile remove <name>
 *
 *   bun index.ts balance [name]                 (defaults to active profile)
 *   bun index.ts transactions [name] [--limit N] [--all] [--type trx|usdt|trc20|all] [--json]
 *   bun index.ts send-trx <to> <amount> [--profile name]
 *   bun index.ts send-usdt <to> <amount> [--profile name]
 *
 * Env vars:
 *   WALLET_MASTER_KEY   optional passphrase to encrypt private keys at rest
 *   TRONGRID_API_KEY    optional, recommended for higher rate limits
 *   TRON_FULL_HOST      optional, defaults to https://api.trongrid.io
 *   TRONGRID_API_HOST   optional, host for the v1 REST API (tx history)
 *   WALLET_DATA_DIR     optional, defaults to ~/.tron-wallet-cli
 */

import {
  insertProfile,
  getProfile,
  listProfiles,
  deleteProfile,
  setSetting,
  getActiveProfileName,
  DB_PATH,
} from "./lib/db";
import { encryptSecret, decryptSecret, isEncryptionEnabled } from "./lib/crypto";
import { buildTronWeb, generateKeypair, USDT_CONTRACT } from "./lib/tron";
import { renderQrToTerminal } from "./lib/qr";
import { fetchHistory, type HistoryEntry } from "./lib/history";

function printUsage() {
  console.log(`
tron-wallet-cli (Bun) — DB: ${DB_PATH}

Profile commands:
  profile add <name>                  Generate a new keypair and save as a profile
  profile import <name> <privKeyHex>  Import an existing private key as a profile
  profile list                        List all profiles (marks the active one)
  profile use <name>                  Set the active profile
  profile show <name> [--reveal]      Show a profile's address (and key with --reveal)
  profile qr [name]                   Render the address as a scannable QR code
  profile remove <name>               Delete a profile

Wallet commands:
  balance [name]                      Show TRX + USDT balance (active profile if omitted)
  transactions [name] [options]       Show transaction history (aliases: txs, history)
      --limit <n>                       Number of transactions to show (default 20)
      --all                             Fetch the complete history, no limit
      --type <trx|usdt|trc20|all>       Filter by transfer type (default all)
      --json                            Print raw JSON instead of a table
      --profile <name>                  Profile to use
  send-trx <to> <amount> [--profile name]
  send-usdt <to> <amount> [--profile name]

Encryption: ${isEncryptionEnabled() ? "ENABLED (WALLET_MASTER_KEY set)" : "disabled (set WALLET_MASTER_KEY to encrypt keys at rest)"}
`);
}

function getPrivateKeyPlaintext(profile: { private_key: string; encrypted: number }): string {
  if (profile.encrypted) {
    return decryptSecret(profile.private_key);
  }
  return profile.private_key;
}

function resolveProfileName(explicit?: string): string {
  const name = explicit || getActiveProfileName();
  if (!name) {
    console.error("No profile specified and no active profile set.");
    console.error("Run 'profile add <name>' then 'profile use <name>', or pass --profile <name>.");
    process.exit(1);
  }
  return name as string;
}

function requireProfile(name: string) {
  const profile = getProfile(name);
  if (!profile) {
    console.error(`Profile "${name}" not found. Run 'profile list' to see available profiles.`);
    process.exit(1);
  }
  return profile;
}

// --- profile commands ---------------------------------------------------

function cmdProfileAdd(name?: string) {
  if (!name) {
    console.error("Usage: profile add <name>");
    process.exit(1);
  }
  if (getProfile(name)) {
    console.error(`Profile "${name}" already exists.`);
    process.exit(1);
  }

  const { address, privateKey } = generateKeypair();
  const stored = isEncryptionEnabled() ? encryptSecret(privateKey) : privateKey;

  insertProfile({ name, address, private_key: stored, encrypted: isEncryptionEnabled() ? 1 : 0 });

  if (!getActiveProfileName()) {
    setSetting("active_profile", name);
  }

  console.log(`Created profile "${name}"`);
  console.log(`  Address: ${address}`);
  if (!isEncryptionEnabled()) {
    console.log(`  Private key stored in plaintext (set WALLET_MASTER_KEY to encrypt).`);
  }
  console.log(`\nFund this address with a small amount of TRX before sending anything.`);
}

function cmdProfileImport(name?: string, privateKeyHex?: string) {
  if (!name || !privateKeyHex) {
    console.error("Usage: profile import <name> <privateKeyHex>");
    process.exit(1);
  }
  if (getProfile(name)) {
    console.error(`Profile "${name}" already exists.`);
    process.exit(1);
  }

  const tronWeb = buildTronWeb();
  let address: string;
  try {
    address = tronWeb.address.fromPrivateKey(privateKeyHex);
  } catch {
    console.error("Invalid private key.");
    process.exit(1);
  }

  const stored = isEncryptionEnabled() ? encryptSecret(privateKeyHex) : privateKeyHex;
  insertProfile({ name, address: address!, private_key: stored, encrypted: isEncryptionEnabled() ? 1 : 0 });

  if (!getActiveProfileName()) {
    setSetting("active_profile", name);
  }

  console.log(`Imported profile "${name}"`);
  console.log(`  Address: ${address}`);
}

function cmdProfileList() {
  const profiles = listProfiles();
  const active = getActiveProfileName();

  if (profiles.length === 0) {
    console.log("No profiles yet. Run 'profile add <name>' to create one.");
    return;
  }

  console.log("Profiles:");
  for (const p of profiles) {
    const marker = p.name === active ? "*" : " ";
    console.log(`  ${marker} ${p.name}  ${p.address}${p.encrypted ? "  (encrypted)" : ""}`);
  }
}

function cmdProfileUse(name?: string) {
  if (!name) {
    console.error("Usage: profile use <name>");
    process.exit(1);
  }
  requireProfile(name);
  setSetting("active_profile", name);
  console.log(`Active profile set to "${name}"`);
}

function cmdProfileShow(name?: string, reveal = false, qr = false) {
  if (!name) {
    console.error("Usage: profile show <name> [--reveal] [--qr]");
    process.exit(1);
  }
  const profile = requireProfile(name);
  console.log(`Profile: ${profile.name}`);
  console.log(`  Address: ${profile.address}`);
  console.log(`  Created: ${profile.created_at}`);
  console.log(`  Encrypted at rest: ${profile.encrypted ? "yes" : "no"}`);
  if (reveal) {
    console.log(`  Private key: ${getPrivateKeyPlaintext(profile)}`);
  }
  if (qr) {
    console.log();
    console.log(renderQrToTerminal(profile.address));
  }
}

function cmdProfileQr(nameArg?: string) {
  const name = resolveProfileName(nameArg);
  const profile = requireProfile(name);
  console.log(`${profile.name}: ${profile.address}`);
  console.log();
  console.log(renderQrToTerminal(profile.address));
}

function cmdProfileRemove(name?: string) {
  if (!name) {
    console.error("Usage: profile remove <name>");
    process.exit(1);
  }
  requireProfile(name);
  deleteProfile(name);
  if (getActiveProfileName() === name) {
    setSetting("active_profile", "");
  }
  console.log(`Removed profile "${name}"`);
}

// --- wallet commands ------------------------------------------------------

async function cmdBalance(nameArg?: string) {
  const name = resolveProfileName(nameArg);
  const profile = requireProfile(name);
  const tronWeb = buildTronWeb();
  // Constant-contract calls (balanceOf) require an owner_address; without a
  // private key the only address we have is the profile's own.
  tronWeb.setAddress(profile.address);

  const sunBalance = await tronWeb.trx.getBalance(profile.address);
  console.log(`Profile: ${profile.name} (${profile.address})`);
  console.log(`  TRX:  ${tronWeb.fromSun(sunBalance)}`);

  const contract = await tronWeb.contract().at(USDT_CONTRACT);
  const usdtRaw = await contract.methods.balanceOf(profile.address).call();
  console.log(`  USDT: ${usdtRaw.toNumber() / 1_000_000}`);
}

interface TransactionsOptions {
  limit: number;
  type: string;
  json: boolean;
}

function formatWhen(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function signedAmount(entry: HistoryEntry): string {
  if (entry.amount === null) return "—";
  if (entry.direction === "self") return entry.amount;
  return `${entry.direction === "out" ? "-" : "+"}${entry.amount}`;
}

function printHistoryTable(entries: HistoryEntry[]) {
  // The status column is dead weight when nothing failed, and dropping it buys
  // back the width that the full 64-char txID needs. Truncating the txID
  // instead would be worse: a partial hash can't be pasted into an explorer.
  const showStatus = entries.some((e) => e.status !== "SUCCESS");

  const rows = entries.map((e) => [
    formatWhen(e.timestamp),
    e.direction.toUpperCase(),
    e.kind,
    signedAmount(e),
    e.counterparty || "—",
    ...(showStatus ? [e.status] : []),
    e.txId,
  ]);

  const header = ["WHEN", "DIR", "TYPE", "AMOUNT", "COUNTERPARTY", ...(showStatus ? ["STATUS"] : []), "TXID"];
  // Amount reads best right-aligned so decimal points line up.
  const rightAligned = new Set([3]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));

  const renderRow = (cells: string[]) =>
    "  " +
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : rightAligned.has(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
      .join("  ");

  console.log(renderRow(header));
  for (const row of rows) {
    console.log(renderRow(row));
  }
}

async function cmdTransactions(nameArg?: string, options: TransactionsOptions = { limit: 20, type: "all", json: false }) {
  const name = resolveProfileName(nameArg);
  const profile = requireProfile(name);

  const entries = await fetchHistory(profile.address, { limit: options.limit, type: options.type });

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  const scope = options.type === "all" ? "" : ` [${options.type}]`;
  console.log(`Transactions for "${profile.name}" (${profile.address})${scope}`);

  if (entries.length === 0) {
    console.log("  No transactions found.");
    return;
  }

  console.log();
  printHistoryTable(entries);
  console.log();

  const reachedLimit = Number.isFinite(options.limit) && entries.length >= options.limit;
  console.log(
    `  ${entries.length} transaction${entries.length === 1 ? "" : "s"}` +
      (reachedLimit ? ` (limit reached — use --limit <n> or --all for more)` : "")
  );
}

async function cmdSendTrx(toAddress?: string, amountStr?: string, profileName?: string) {
  if (!toAddress || !amountStr) {
    console.error("Usage: send-trx <toAddress> <amount> [--profile name]");
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (Number.isNaN(amount) || amount <= 0) {
    console.error("Amount must be a positive number.");
    process.exit(1);
  }

  const name = resolveProfileName(profileName);
  const profile = requireProfile(name);
  const privateKey = getPrivateKeyPlaintext(profile);
  const tronWeb = buildTronWeb(privateKey);

  const amountInSun = tronWeb.toSun(amount);
  const tx = await tronWeb.trx.sendTransaction(toAddress, amountInSun);
  console.log(`Sent from profile "${profile.name}" (${profile.address})`);
  console.log(JSON.stringify(tx, null, 2));
}

async function cmdSendUsdt(toAddress?: string, amountStr?: string, profileName?: string) {
  if (!toAddress || !amountStr) {
    console.error("Usage: send-usdt <toAddress> <amount> [--profile name]");
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (Number.isNaN(amount) || amount <= 0) {
    console.error("Amount must be a positive number.");
    process.exit(1);
  }

  const name = resolveProfileName(profileName);
  const profile = requireProfile(name);
  const privateKey = getPrivateKeyPlaintext(profile);
  const tronWeb = buildTronWeb(privateKey);

  const contract = await tronWeb.contract().at(USDT_CONTRACT);
  const amountInSmallestUnit = Math.round(amount * 1_000_000); // USDT has 6 decimals

  const tx = await contract.methods.transfer(toAddress, amountInSmallestUnit).send({
    feeLimit: 10_000_000,
  });
  console.log(`Sent from profile "${profile.name}" (${profile.address})`);
  console.log("Transaction ID:", tx);
}

// --- arg parsing ------------------------------------------------------

function extractFlag(args: string[], flag: string): { value: string | undefined; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { value: undefined, rest: args };
  const value = args[idx + 1];
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { value, rest };
}

function hasFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, rest: args };
  const rest = [...args.slice(0, idx), ...args.slice(idx + 1)];
  return { present: true, rest };
}

async function main() {
  const argv = process.argv.slice(2);
  const [command, sub, ...rest] = argv;

  try {
    if (command === "profile") {
      switch (sub) {
        case "add":
          cmdProfileAdd(rest[0]);
          break;
        case "import":
          cmdProfileImport(rest[0], rest[1]);
          break;
        case "list":
          cmdProfileList();
          break;
        case "use":
          cmdProfileUse(rest[0]);
          break;
        case "show": {
          const { present: reveal, rest: rest2 } = hasFlag(rest, "--reveal");
          const { present: qr, rest: rest3 } = hasFlag(rest2, "--qr");
          cmdProfileShow(rest3[0], reveal, qr);
          break;
        }
        case "qr":
          cmdProfileQr(rest[0]);
          break;
        case "remove":
          cmdProfileRemove(rest[0]);
          break;
        default:
          printUsage();
      }
      return;
    }

    if (command === "balance") {
      const { value: profileFlag, rest: rest2 } = extractFlag([sub, ...rest].filter(Boolean) as string[], "--profile");
      await cmdBalance(profileFlag || rest2[0]);
      return;
    }

    if (command === "transactions" || command === "txs" || command === "history") {
      let args = [sub, ...rest].filter(Boolean) as string[];

      const profileFlag = extractFlag(args, "--profile");
      args = profileFlag.rest;
      const limitFlag = extractFlag(args, "--limit");
      args = limitFlag.rest;
      const typeFlag = extractFlag(args, "--type");
      args = typeFlag.rest;
      const allFlag = hasFlag(args, "--all");
      args = allFlag.rest;
      const jsonFlag = hasFlag(args, "--json");
      args = jsonFlag.rest;

      let limit = 20;
      if (allFlag.present) {
        limit = Infinity;
      } else if (limitFlag.value !== undefined) {
        limit = parseInt(limitFlag.value, 10);
        if (Number.isNaN(limit) || limit <= 0) {
          console.error("--limit must be a positive integer.");
          process.exit(1);
        }
      }

      const type = (typeFlag.value ?? "all").toLowerCase();
      const allowedTypes = ["all", "trx", "trc20", "usdt"];
      if (!allowedTypes.includes(type)) {
        console.error(`--type must be one of: ${allowedTypes.join(", ")}`);
        process.exit(1);
      }

      await cmdTransactions(profileFlag.value || args[0], { limit, type, json: jsonFlag.present });
      return;
    }

    if (command === "send-trx") {
      const args = [sub, ...rest].filter(Boolean) as string[];
      const { value: profileFlag, rest: rest2 } = extractFlag(args, "--profile");
      await cmdSendTrx(rest2[0], rest2[1], profileFlag);
      return;
    }

    if (command === "send-usdt") {
      const args = [sub, ...rest].filter(Boolean) as string[];
      const { value: profileFlag, rest: rest2 } = extractFlag(args, "--profile");
      await cmdSendUsdt(rest2[0], rest2[1], profileFlag);
      return;
    }

    printUsage();
    process.exit(command ? 1 : 0);
  } catch (err: any) {
    console.error("Error:", err?.message || err);
    process.exit(1);
  }
}

main();
