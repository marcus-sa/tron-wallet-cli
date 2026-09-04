import TronWeb from "tronweb";
import { API_HOST, USDT_CONTRACT } from "./tron";

// Transaction history comes from TronGrid's v1 REST API rather than TronWeb,
// because TronWeb only exposes single-transaction lookups — there is no
// "list this account's transactions" call on the node RPC itself.
//
// Two endpoints are needed to see everything an account did:
//   /v1/accounts/{addr}/transactions        native txs (TRX transfers,
//                                           contract calls, staking, ...)
//   /v1/accounts/{addr}/transactions/trc20  TRC-20 token transfer events
//
// A USDT send shows up in both (as a TriggerSmartContract on one side and a
// Transfer event on the other), so the merge below drops the native row when
// the TRC-20 stream already described that txID with real token amounts.

const PAGE_SIZE = 200; // TronGrid's per-request maximum

// When a filter rejects most rows (e.g. --type trx on an account that only
// ever staked), paging could otherwise walk an entire whale-sized history.
// Cap the scan unless the caller explicitly asked for everything.
const MAX_SCAN_PAGES = 25;

export type Direction = "in" | "out" | "self";

export interface HistoryEntry {
  txId: string;
  timestamp: number;
  /** Display label: "TRX", a token symbol like "USDT", or a contract type. */
  kind: string;
  direction: Direction;
  counterparty: string;
  /** Decimal string, or null for transactions that move no tracked value. */
  amount: string | null;
  symbol: string | null;
  status: string;
  /** Fee in TRX. Only known for native rows. */
  fee: number | null;
}

export interface HistoryOptions {
  /** Max entries to return. Use Infinity to walk the full history. */
  limit?: number;
  /** "all" | "trx" | "trc20" | "usdt" */
  type?: string;
  /** Restrict TRC-20 results to a single contract. */
  contract?: string;
}

interface TronGridPage<T> {
  data: T[];
  success?: boolean;
  error?: unknown;
  meta?: { fingerprint?: string; page_size?: number };
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.TRONGRID_API_KEY) {
    headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
  }
  return headers;
}

async function fetchPage<T>(path: string, params: Record<string, string>): Promise<TronGridPage<T>> {
  const url = new URL(path, API_HOST);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) {
    const hint = res.status === 429 ? " (rate limited — set TRONGRID_API_KEY for a higher quota)" : "";
    throw new Error(`TronGrid request failed: ${res.status} ${res.statusText}${hint}`);
  }

  const body = (await res.json()) as TronGridPage<T>;
  if (body.success === false) {
    throw new Error(`TronGrid error: ${JSON.stringify(body.error ?? body)}`);
  }
  return body;
}

/**
 * Walks fingerprint-paginated results until `limit` *accepted* rows or the end
 * of history. Counting accepted rows rather than fetched ones matters: with a
 * filter, one page of 200 can contribute nothing, and stopping there would
 * report "no transactions" for an account that simply staked recently.
 */
async function fetchAllPages<T>(
  path: string,
  params: Record<string, string>,
  limit: number,
  accept?: (row: T) => boolean
): Promise<T[]> {
  const rows: T[] = [];
  const unbounded = !Number.isFinite(limit);
  const maxPages = unbounded ? Infinity : MAX_SCAN_PAGES;
  let fingerprint: string | undefined;
  let pages = 0;

  while (rows.length < limit && pages < maxPages) {
    // Without a filter, ask only for what's still missing; with one, always
    // take full pages since an unknown share of each page will be dropped.
    const remaining = limit - rows.length;
    const pageSize = accept || unbounded ? PAGE_SIZE : Math.min(PAGE_SIZE, remaining);

    const page = await fetchPage<T>(path, {
      ...params,
      limit: String(pageSize),
      order_by: "block_timestamp,desc",
      ...(fingerprint ? { fingerprint } : {}),
    });
    pages++;

    const data = page.data ?? [];
    for (const row of data) {
      if (!accept || accept(row)) rows.push(row);
    }

    fingerprint = page.meta?.fingerprint;
    // TronGrid keeps returning a fingerprint on the final page, so stop on a
    // short page instead of trusting it to disappear.
    if (!fingerprint || data.length === 0 || data.length < pageSize) break;
  }

  return unbounded ? rows : rows.slice(0, limit);
}

function toBase58(hexAddress?: string): string {
  if (!hexAddress) return "";
  try {
    return (TronWeb as any).address.fromHex(hexAddress);
  } catch {
    return hexAddress;
  }
}

/** Divides an integer string by 10**decimals without losing precision. */
export function formatUnits(value: string, decimals: number): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const scale = 10n ** BigInt(decimals);
  const raw = BigInt(digits || "0");
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function directionOf(from: string, to: string, self: string): Direction {
  if (from === self && to === self) return "self";
  return from === self ? "out" : "in";
}

// --- native transactions --------------------------------------------------

interface NativeTx {
  txID: string;
  block_timestamp: number;
  ret?: { contractRet?: string; fee?: number }[];
  raw_data?: { contract?: { type?: string; parameter?: { value?: Record<string, any> } }[] };
}

function mapNativeTx(tx: NativeTx, address: string): HistoryEntry {
  const contract = tx.raw_data?.contract?.[0];
  const type = contract?.type ?? "Unknown";
  const value = contract?.parameter?.value ?? {};

  const from = toBase58(value.owner_address);
  // Different contract types name the other party differently.
  const to = toBase58(value.to_address ?? value.receiver_address ?? value.contract_address);

  const entry: HistoryEntry = {
    txId: tx.txID,
    timestamp: tx.block_timestamp,
    kind: type === "TransferContract" ? "TRX" : type.replace(/Contract$/, ""),
    direction: directionOf(from, to, address),
    counterparty: from === address ? to : from,
    amount: null,
    symbol: null,
    status: tx.ret?.[0]?.contractRet ?? "UNKNOWN",
    fee: (tx.ret?.[0]?.fee ?? 0) / 1_000_000,
  };

  if (type === "TransferContract" && typeof value.amount === "number") {
    entry.amount = formatUnits(String(value.amount), 6); // TRX has 6 decimals (SUN)
    entry.symbol = "TRX";
  }

  return entry;
}

// --- TRC-20 transfers -----------------------------------------------------

interface Trc20Tx {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  value: string;
  type?: string;
  token_info?: { symbol?: string; decimals?: number; address?: string };
}

function mapTrc20Tx(tx: Trc20Tx, address: string): HistoryEntry {
  const decimals = tx.token_info?.decimals ?? 0;
  const symbol = tx.token_info?.symbol || "TRC20";

  return {
    txId: tx.transaction_id,
    timestamp: tx.block_timestamp,
    kind: symbol,
    direction: directionOf(tx.from, tx.to, address),
    counterparty: tx.from === address ? tx.to : tx.from,
    amount: formatUnits(tx.value ?? "0", decimals),
    symbol,
    status: "SUCCESS", // the TRC-20 endpoint only emits events from mined transfers
    fee: null,
  };
}

// --- public API -----------------------------------------------------------

export async function fetchHistory(address: string, options: HistoryOptions = {}): Promise<HistoryEntry[]> {
  const limit = options.limit ?? 20;
  const type = (options.type ?? "all").toLowerCase();

  const wantNative = type === "all" || type === "trx";
  const wantTokens = type === "all" || type === "trc20" || type === "usdt";
  const contract = type === "usdt" ? USDT_CONTRACT : options.contract;

  // Tokens are fetched first so the native pass can recognise — and skip — the
  // TriggerSmartContract rows the TRC-20 stream already described in full.
  const tokens = wantTokens
    ? await fetchAllPages<Trc20Tx>(
        `/v1/accounts/${address}/transactions/trc20`,
        contract ? { contract_address: contract } : {},
        limit
      )
    : [];

  const tokenEntries = tokens.map((tx) => mapTrc20Tx(tx, address));
  const describedByToken = new Set(tokenEntries.map((e) => e.txId));

  const native = wantNative
    ? await fetchAllPages<NativeTx>(`/v1/accounts/${address}/transactions`, {}, limit, (tx) => {
        const contractType = tx.raw_data?.contract?.[0]?.type;
        if (type === "trx") return contractType === "TransferContract";
        return !describedByToken.has(tx.txID);
      })
    : [];

  // Each stream is fetched to the full limit; the merged list is trimmed after
  // sorting, since we can't know in advance how the two interleave.
  const merged = [...native.map((tx) => mapNativeTx(tx, address)), ...tokenEntries].sort(
    (a, b) => b.timestamp - a.timestamp
  );
  return Number.isFinite(limit) ? merged.slice(0, limit) : merged;
}
