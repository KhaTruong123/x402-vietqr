// Turns "pay this VietQR" into a Gaian payout.
// Order of money movement is fixed on purpose:
//   1. quote   : price the VND amount in USDC, nothing moves
//   2. reserve : place the Gaian order, nothing moves (runs inside the paid handler)
//   3. fund    : only after the agent's x402 payment has settled on chain, the treasury
//                wallet sends USDC to Gaian and the order is verified
// If x402 settlement fails, step 3 never runs and the Gaian order simply expires.
import crypto from "node:crypto";
import { Horizon, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { config, LIVE_GAIAN } from "./config.js";
import { GaianClient, quoteUsdcAmount } from "./gaian/client.js";
import { isValidCrc } from "./vietqr.js";

export interface Quote {
  id: string;
  qrString: string;
  amountVnd: number;
  usdc: number; // what the agent pays, already rounded up to the cent
  beneficiaryName: string;
  bankName: string;
  accountTail: string;
  gaianQuoteId?: string;
  expiresAt: number;
  demo: boolean;
}

export type OrderStatus = "reserved" | "funding" | "processing" | "completed" | "failed";

export interface Order {
  id: string;
  quoteId: string;
  status: OrderStatus;
  amountVnd: number;
  usdc: number;
  beneficiaryName: string;
  gaianOrderId?: string;
  encodedTransaction?: string;
  x402Transaction?: string;
  x402Network?: string;
  payer?: string;
  gaianFundingTx?: string;
  error?: string;
  demo: boolean;
  createdAt: string;
  updatedAt: string;
}

const quotes = new Map<string, Quote>();
const orders = new Map<string, Order>();

const gaian = LIVE_GAIAN ? new GaianClient({ host: config.gaianHost, key: config.gaianKey, secret: config.gaianSecret }) : null;

export class PayoutError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const ceilCents = (n: number) => Math.ceil(n * 100) / 100;

// Reads tag 38 (beneficiary) and 54 (amount) from a VietQR string. Used in mock mode
// so the demo works without Gaian credentials.
function readVietQrLocally(qr: string): { bankBin: string; accountNumber: string; amount: number | null } {
  const fields = (s: string) => {
    const out: Record<string, string> = {};
    for (let i = 0; i + 4 <= s.length; ) {
      const id = s.slice(i, i + 2);
      const len = Number(s.slice(i + 2, i + 4));
      out[id] = s.slice(i + 4, i + 4 + len);
      i += 4 + len;
    }
    return out;
  };
  const top = fields(qr);
  const beneficiary = fields(fields(top["38"] ?? "")["01"] ?? "");
  return { bankBin: beneficiary["00"] ?? "", accountNumber: beneficiary["01"] ?? "", amount: top["54"] ? Number(top["54"]) : null };
}

export async function createQuote(qrString: string, amountVndInput?: number): Promise<Quote> {
  if (!isValidCrc(qrString)) throw new PayoutError("qrString is not a valid VietQR (checksum failed)");

  let amountVnd: number;
  let usdc: number;
  let beneficiaryName: string;
  let bankName: string;
  let accountNumber: string;
  let gaianQuoteId: string | undefined;

  if (gaian) {
    const parsed = await gaian.parseQr(qrString, config.gaianTreasuryUserId);
    if (!parsed.isValid) throw new PayoutError("Gaian could not read this QR");
    if (parsed.country !== "VN") throw new PayoutError("Only Vietnamese QR codes are supported");
    amountVnd = parsed.amount ?? amountVndInput ?? 0;
    beneficiaryName = parsed.beneficiaryName;
    bankName = parsed.bankName;
    accountNumber = parsed.accountNumber;
    if (!amountVnd) throw new PayoutError("This QR has no amount, pass amountVnd");
    const q = await gaian.quote({
      qrString,
      amount: amountVnd,
      chainId: config.gaianChainId,
      walletAddress: config.gaianTreasuryWallet,
      country: "VN",
    });
    const quoted = quoteUsdcAmount(q);
    if (!quoted) throw new PayoutError("Gaian quote did not include a USDC amount", 502);
    usdc = ceilCents(quoted);
    gaianQuoteId = q.quoteId;
  } else {
    const local = readVietQrLocally(qrString);
    amountVnd = local.amount ?? amountVndInput ?? 0;
    if (!amountVnd) throw new PayoutError("This QR has no amount, pass amountVnd");
    beneficiaryName = "DEMO MERCHANT";
    bankName = `BIN ${local.bankBin}`;
    accountNumber = local.accountNumber;
    usdc = ceilCents((amountVnd / config.mockVndPerUsdc) * (1 + config.mockFeeRate));
  }

  if (usdc > config.maxOrderUsd) {
    throw new PayoutError(`Order is ${usdc} USDC, above the ${config.maxOrderUsd} USDC limit per order`);
  }

  const quote: Quote = {
    id: crypto.randomUUID(),
    qrString,
    amountVnd,
    usdc,
    beneficiaryName,
    bankName,
    accountTail: accountNumber.slice(-4),
    gaianQuoteId,
    expiresAt: Date.now() + config.quoteTtlSeconds * 1000,
    demo: !gaian,
  };
  quotes.set(quote.id, quote);
  return quote;
}

export function getQuote(id: string): Quote | undefined {
  const q = quotes.get(id);
  if (q && q.expiresAt < Date.now()) return undefined;
  return q;
}

// Runs inside the paid handler, before settlement. Nothing moves yet.
export async function reserveOrder(quoteId: string): Promise<Order> {
  const quote = getQuote(quoteId);
  if (!quote) throw new PayoutError("Quote not found or expired, request a new one", 410);
  if (quoteAlreadyUsed(quoteId)) throw new PayoutError("This quote was already used", 409);

  const order: Order = {
    id: crypto.randomUUID(),
    quoteId,
    status: "reserved",
    amountVnd: quote.amountVnd,
    usdc: quote.usdc,
    beneficiaryName: quote.beneficiaryName,
    demo: quote.demo,
    createdAt: now(),
    updatedAt: now(),
  };
  // Stored before any await so two concurrent requests cannot both use the quote.
  orders.set(order.id, order);
  if (gaian && quote.gaianQuoteId) {
    try {
      const g = await gaian.placeOrder(quote.gaianQuoteId);
      order.gaianOrderId = g.orderId;
      order.encodedTransaction = g.encodedTransaction;
    } catch (err) {
      orders.delete(order.id);
      throw err;
    }
  }
  return order;
}

function update(order: Order, patch: Partial<Order>) {
  Object.assign(order, patch, { updatedAt: now() });
}

// Runs after the agent's payment settled on chain.
export async function fundOrder(orderId: string, settlement: { transaction: string; network: string; payer?: string }): Promise<void> {
  const order = orders.get(orderId);
  if (!order) return;
  update(order, { status: "funding", x402Transaction: settlement.transaction, x402Network: settlement.network, payer: settlement.payer });

  try {
    if (!gaian) {
      // Mock: show the same lifecycle without moving any VND.
      setTimeout(() => update(order, { status: "completed" }), 3000);
      update(order, { status: "processing" });
      return;
    }
    if (!order.gaianOrderId || !order.encodedTransaction) throw new Error("Gaian order has no funding transaction");
    const hash = await submitTreasuryTransaction(order.encodedTransaction);
    update(order, { gaianFundingTx: hash });
    const verified = await gaian.verifyOrder(order.gaianOrderId, hash);
    update(order, { status: verified.status === "failed" ? "failed" : "processing" });
  } catch (err) {
    update(order, { status: "failed", error: err instanceof Error ? err.message : String(err) });
  }
}

async function submitTreasuryTransaction(xdr: string): Promise<string> {
  const secret = process.env.GAIAN_TREASURY_SECRET;
  if (!secret) throw new Error("GAIAN_TREASURY_SECRET is not set");
  const passphrase = process.env.GAIAN_STELLAR_PASSPHRASE ?? Networks.TESTNET;
  const horizon = new Horizon.Server(process.env.GAIAN_HORIZON_URL ?? "https://horizon-testnet.stellar.org");
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  tx.sign(Keypair.fromSecret(secret));
  const res = await horizon.submitTransaction(tx);
  return res.hash;
}

export async function getOrder(id: string): Promise<Order | undefined> {
  const order = orders.get(id);
  if (!order) return undefined;
  if (gaian && order.gaianOrderId && order.status === "processing") {
    try {
      const g = await gaian.getOrder(order.gaianOrderId);
      if (g.status === "completed" || g.status === "failed") update(order, { status: g.status });
    } catch {
      // keep the last known status
    }
  }
  return order;
}

export function quoteAlreadyUsed(quoteId: string): boolean {
  for (const o of orders.values()) if (o.quoteId === quoteId) return true;
  return false;
}

// x402 settlement failed after the order was reserved: nothing was paid, nothing is sent.
export function failOrder(orderId: string, reason: string): void {
  const order = orders.get(orderId);
  if (order && order.status === "reserved") update(order, { status: "failed", error: reason });
}
