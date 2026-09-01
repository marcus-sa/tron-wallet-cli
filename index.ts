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
 *   bun index.ts profile remove <name>
 *
 *   bun index.ts balance [name]                 (defaults to active profile)
 *   bun index.ts send-trx <to> <amount> [--profile name]
 *   bun index.ts send-usdt <to> <amount> [--profile name]
 *
 * Env vars:
 *   WALLET_MASTER_KEY   optional passphrase to encrypt private keys at rest
 *   TRONGRID_API_KEY    optional, recommended for higher rate limits
 *   TRON_FULL_HOST      optional, defaults to https://api.trongrid.io
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

function printUsage() {
  console.log(`
tron-wallet-cli (Bun) — DB: ${DB_PATH}

Profile commands:
  profile add <name>                  Generate a new keypair and save as a profile
  profile import <name> <privKeyHex>  Import an existing private key as a profile
  profile list                        List all profiles (marks the active one)
  profile use <name>                  Set the active profile
  profile show <name> [--reveal]      Show a profile's address (and key with --reveal)
  profile remove <name>               Delete a profile

Wallet commands:
  balance [name]                      Show TRX + USDT balance (active profile if omitted)
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

function cmdProfileShow(name?: string, reveal = false) {
  if (!name) {
    console.error("Usage: profile show <name> [--reveal]");
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

  const sunBalance = await tronWeb.trx.getBalance(profile.address);
  console.log(`Profile: ${profile.name} (${profile.address})`);
  console.log(`  TRX:  ${tronWeb.fromSun(sunBalance)}`);

  const contract = await tronWeb.contract().at(USDT_CONTRACT);
  const usdtRaw = await contract.methods.balanceOf(profile.address).call();
  console.log(`  USDT: ${usdtRaw.toNumber() / 1_000_000}`);
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
          cmdProfileShow(rest2[0], reveal);
          break;
        }
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
