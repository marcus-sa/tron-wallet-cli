import { USDT_CONTRACT } from "./tron";

// SunSwap V2 is a Uniswap-V2 fork, so the router speaks the familiar
// swapExactETHForTokens / swapExactTokensForETH interface. "ETH" in those
// names means the chain's native coin — TRX here, wrapped as WTRX for the
// pool. Verified on mainnet: router.WETH() == WTRX.
export const SUNSWAP_ROUTER = "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax";
export const WTRX = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";

// Both TRX and TRC-20 USDT use 6 decimals.
const UNIT = 1_000_000;

// Fee limits are ceilings, not spends. A swap touches the router, the pool and
// the wrapper, so it burns roughly twice the energy of a plain TRC-20 transfer
// on an account with nothing staked.
const SWAP_FEE_LIMIT = 100_000_000; // 100 TRX
const APPROVE_FEE_LIMIT = 30_000_000; // 30 TRX

const DEFAULT_DEADLINE_MINUTES = 10;

// Swapping the whole balance leaves nothing to pay the next transaction's
// bandwidth/energy with, so hold this much TRX back by default.
export const DEFAULT_TRX_RESERVE = 30;

const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WITHDRAWAL_TOPIC = "7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

export type SwapDirection = "trx-usdt" | "usdt-trx";

export interface SwapPlan {
  direction: SwapDirection;
  amountIn: number;
  expectedOut: number;
  minOut: number;
  slippagePercent: number;
}

export function isSwapDirection(value: string): value is SwapDirection {
  return value === "trx-usdt" || value === "usdt-trx";
}

export function tokensFor(direction: SwapDirection): { in: string; out: string } {
  return direction === "trx-usdt" ? { in: "TRX", out: "USDT" } : { in: "USDT", out: "TRX" };
}

function pathFor(direction: SwapDirection): string[] {
  return direction === "trx-usdt" ? [WTRX, USDT_CONTRACT] : [USDT_CONTRACT, WTRX];
}

function toUnits(amount: number): number {
  return Math.round(amount * UNIT);
}

function fromUnits(units: string | number | bigint): number {
  return Number(BigInt(units.toString())) / UNIT;
}

/** Ask the router what `amountIn` would fetch right now. Free — it's a constant call. */
export async function quoteSwap(tronWeb: any, direction: SwapDirection, amountIn: number): Promise<number> {
  const router = await tronWeb.contract().at(SUNSWAP_ROUTER);
  const result = await router.methods.getAmountsOut(toUnits(amountIn), pathFor(direction)).call();

  // getAmountsOut returns one uint256 per hop, and TronWeb wraps that single
  // array return value in an outer tuple: [[amountIn, amountOut]].
  const amounts = Array.isArray(result[0]) ? result[0] : result;
  return fromUnits(amounts[amounts.length - 1].toString());
}

export async function planSwap(
  tronWeb: any,
  direction: SwapDirection,
  amountIn: number,
  slippagePercent: number
): Promise<SwapPlan> {
  const expectedOut = await quoteSwap(tronWeb, direction, amountIn);
  // Floor rather than round: the minimum must never end up above what the
  // quote actually promised.
  const minOut = Math.floor(expectedOut * (1 - slippagePercent / 100) * UNIT) / UNIT;
  return { direction, amountIn, expectedOut, minOut, slippagePercent };
}

/**
 * TRX-in swaps need no allowance — the TRX rides along as callValue. USDT-in
 * swaps do, so top it up when it falls short. Returns the approval txID, or
 * null when the existing allowance already covers the swap.
 */
export async function ensureUsdtAllowance(tronWeb: any, owner: string, amountIn: number): Promise<string | null> {
  const usdt = await tronWeb.contract().at(USDT_CONTRACT);
  const current = BigInt((await usdt.methods.allowance(owner, SUNSWAP_ROUTER).call()).toString());
  const needed = BigInt(toUnits(amountIn));

  if (current >= needed) return null;

  // Tether-style tokens reject a non-zero -> non-zero approval outright, so
  // clear a stale allowance before writing the new one.
  if (current > 0n) {
    await usdt.methods.approve(SUNSWAP_ROUTER, 0).send({ feeLimit: APPROVE_FEE_LIMIT });
  }

  return await usdt.methods.approve(SUNSWAP_ROUTER, needed.toString()).send({ feeLimit: APPROVE_FEE_LIMIT });
}

export async function executeSwap(
  tronWeb: any,
  plan: SwapPlan,
  to: string,
  deadlineMinutes = DEFAULT_DEADLINE_MINUTES
): Promise<string> {
  const router = await tronWeb.contract().at(SUNSWAP_ROUTER);
  const path = pathFor(plan.direction);
  // Seconds, not milliseconds — the router compares against block.timestamp.
  const deadline = Math.floor(Date.now() / 1000) + deadlineMinutes * 60;
  const minOutUnits = toUnits(plan.minOut);

  if (plan.direction === "trx-usdt") {
    return await router.methods
      .swapExactETHForTokens(minOutUnits, path, to, deadline)
      .send({ callValue: toUnits(plan.amountIn), feeLimit: SWAP_FEE_LIMIT });
  }

  return await router.methods
    .swapExactTokensForETH(toUnits(plan.amountIn), minOutUnits, path, to, deadline)
    .send({ feeLimit: SWAP_FEE_LIMIT });
}

/**
 * send() resolves as soon as the node accepts the transaction, which says
 * nothing about whether it executed. Poll until the receipt lands.
 */
export async function waitForReceipt(tronWeb: any, txId: string, timeoutMs = 90_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const info = await tronWeb.trx.getTransactionInfo(txId);
    if (info && info.id) return info;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  return null;
}

export function receiptSucceeded(info: any): boolean {
  return info?.receipt?.result === "SUCCESS";
}

export function receiptError(info: any): string {
  if (info?.resMessage) {
    try {
      return Buffer.from(info.resMessage, "hex").toString("utf8");
    } catch {
      return info.resMessage;
    }
  }
  return info?.receipt?.result || "unknown failure";
}

/**
 * Read what actually arrived out of the receipt logs rather than trusting the
 * pre-trade quote. Log addresses come back as bare 20-byte hex (no 0x, no 41
 * prefix) and topics as unprefixed 32-byte hex.
 */
export function receivedAmount(tronWeb: any, info: any, direction: SwapDirection, to: string): number | null {
  const logs: any[] = info?.log || [];
  const bare = (address: string) => tronWeb.address.toHex(address).replace(/^41/, "").toLowerCase();

  try {
    if (direction === "trx-usdt") {
      const recipient = bare(to);
      const log = logs.find(
        (l) =>
          l.address?.toLowerCase() === bare(USDT_CONTRACT) &&
          l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC &&
          l.topics?.[2]?.toLowerCase().endsWith(recipient)
      );
      return log ? fromUnits(BigInt("0x" + log.data)) : null;
    }

    // TRX out arrives as an internal transfer, but the wrapper's Withdrawal
    // event carries the same amount and is far easier to read.
    const log = logs.find(
      (l) => l.address?.toLowerCase() === bare(WTRX) && l.topics?.[0]?.toLowerCase() === WITHDRAWAL_TOPIC
    );
    return log ? fromUnits(BigInt("0x" + log.data)) : null;
  } catch {
    return null;
  }
}
