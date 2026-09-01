import TronWeb from "tronweb";

export const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const FULL_HOST = process.env.TRON_FULL_HOST || "https://api.trongrid.io";

export function buildTronWeb(privateKey?: string): any {
  const options: Record<string, unknown> = { fullHost: FULL_HOST };

  if (process.env.TRONGRID_API_KEY) {
    options.headers = { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY };
  }

  if (privateKey) {
    options.privateKey = privateKey;
  }

  return new (TronWeb as any)(options);
}

export function generateKeypair() {
  const account = (TronWeb as any).utils.accounts.generateAccount();
  return {
    address: account.address.base58,
    privateKey: account.privateKey as string,
  };
}
