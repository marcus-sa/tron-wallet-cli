import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "crypto";

// If WALLET_MASTER_KEY is set in the environment, private keys are encrypted
// at rest with AES-256-GCM using a key derived from that passphrase.
// If it's not set, private keys are stored in plaintext in the SQLite DB
// (fine for local/dev use, not recommended for anything holding real funds).

const MASTER_KEY = process.env.WALLET_MASTER_KEY;

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(MASTER_KEY as string, salt, 32);
}

export function isEncryptionEnabled(): boolean {
  return Boolean(MASTER_KEY);
}

// Output format: salt:iv:authTag:ciphertext (all hex)
export function encryptSecret(plaintext: string): string {
  if (!MASTER_KEY) throw new Error("WALLET_MASTER_KEY is not set; cannot encrypt.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [salt.toString("hex"), iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

export function decryptSecret(payload: string): string {
  if (!MASTER_KEY) throw new Error("WALLET_MASTER_KEY is not set; cannot decrypt stored key.");
  const [saltHex, ivHex, authTagHex, dataHex] = payload.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const key = deriveKey(salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}
