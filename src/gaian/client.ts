// Gaian payments API v2 client. Signs every call with the gateway's HMAC scheme:
// signature = base64url(HMAC-SHA256(secret, key + METHOD + path + query + sortedBody + unixTs))
import crypto from "node:crypto";

export interface GaianCredentials {
  host: string;
  key: string;
  secret: string;
}

export class GaianError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export function canonicalBody(body?: Record<string, unknown>): string {
  if (!body) return "";
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(body).sort()) sorted[k] = body[k];
  return JSON.stringify(sorted);
}

export function sign(creds: Pick<GaianCredentials, "key" | "secret">, method: string, pathWithQuery: string, body: string, ts: number): string {
  const [path, query = ""] = pathWithQuery.split("?");
  const data = creds.key + method.toUpperCase() + path.replace(/:/g, "") + query + body + ts;
  return crypto.createHmac("sha256", creds.secret).update(data).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

export interface ParsedQr {
  isValid: boolean;
  country: string;
  bankBin: string;
  accountNumber: string;
  amount: number | null;
  beneficiaryName: string;
  bankName: string;
}

export interface GaianQuote {
  quoteId: string;
  [k: string]: unknown;
}

export interface GaianOrder {
  orderId: string;
  status?: string;
  encodedTransaction?: string;
  [k: string]: unknown;
}

export class GaianClient {
  constructor(private readonly creds: GaianCredentials) {
    if (!creds.key || !creds.secret) throw new Error("GAIAN_KEY and GAIAN_SECRET are required for GAIAN_MODE=sandbox");
  }

  private async call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const ts = Math.floor(Date.now() / 1000);
    const payload = canonicalBody(body);
    const res = await fetch(this.creds.host + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": crypto.randomUUID(),
        "X-Gaian-Key": this.creds.key,
        "X-Gaian-Signature": sign(this.creds, method, path, payload, ts),
        "X-Gaian-Timestamp": String(ts),
      },
      body: payload || undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (!res.ok) {
      const msg = json?.error?.message ?? json?.message ?? text;
      throw new GaianError(`Gaian ${method} ${path} failed (${res.status}): ${msg}`, res.status, json);
    }
    return (json?.data ?? json) as T;
  }

  parseQr(qrString: string, userId: string): Promise<ParsedQr> {
    return this.call("POST", "/api/v2/parseQr", { qrString, userId });
  }

  quote(input: { qrString: string; amount: number; chainId: number; walletAddress: string; country: string }): Promise<GaianQuote> {
    return this.call("POST", "/api/v2/quote", { ...input, settlementCurrency: "USDC" });
  }

  placeOrder(quoteId: string): Promise<GaianOrder> {
    return this.call("POST", "/api/v2/orders", { quoteId });
  }

  verifyOrder(orderId: string, transactionHash: string): Promise<GaianOrder> {
    return this.call("POST", `/api/v2/orders/${orderId}/verify`, { transactionHash });
  }

  getOrder(orderId: string): Promise<GaianOrder> {
    return this.call("GET", `/api/v2/orders/${orderId}`);
  }
}

// The quote response has carried the crypto amount under different names across
// versions. Take the first positive number we recognise.
export function quoteUsdcAmount(q: Record<string, unknown>): number | null {
  for (const key of ["cryptoAmount", "settlementAmount", "totalCryptoAmount", "amountCrypto", "usdcAmount", "totalAmount"]) {
    const v = Number(q[key]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}
