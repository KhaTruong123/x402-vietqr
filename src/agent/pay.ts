// The agent side: finds a place, gets a quote, and pays it with x402.
// Three independent limits stop it from overspending:
//   1. the user's budget for this session (checked here before paying)
//   2. MAX_ORDER_USD per order (checked here, by x402 spend controls, and again on the server)
//   3. a policy that refuses to sign for more than the quoted amount or an unexpected recipient
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequirements } from "@x402/core/types";
import { config } from "../config.js";
import type { SearchInput, SearchResult } from "../places.js";

export interface AgentOptions {
  apiUrl: string;
  stellarSecret?: string;
  evmPrivateKey?: string;
  maxOrderUsd?: number;
  trustedPayTo?: string[];
}

export interface PublicQuote {
  id: string;
  amountVnd: number;
  usdc: number;
  beneficiaryName: string;
  bankName: string;
  accountTail: string;
  expiresAt: number;
  demo: boolean;
}

export class BudgetError extends Error {}

const DECIMALS = (network: string) => (network.startsWith("stellar:") ? 7 : 6);

export function toAtomic(usd: number, network: string): bigint {
  return BigInt(Math.round(usd * 100)) * 10n ** BigInt(DECIMALS(network) - 2);
}

// Keeps only payment options that charge at most the quoted amount, to a known recipient.
export function quotePolicy(expectedUsd: number, trustedPayTo: string[]) {
  return (_version: number, reqs: PaymentRequirements[]) =>
    reqs.filter((r) => {
      if (BigInt(r.amount) > toAtomic(expectedUsd, r.network)) return false;
      if (trustedPayTo.length && !trustedPayTo.some((t) => t.toLowerCase() === r.payTo.toLowerCase())) return false;
      return true;
    });
}

export class TravelAgent {
  private spentUsd = 0;
  // Payments run one at a time so two parallel tool calls cannot both pass the budget check.
  private queue: Promise<unknown> = Promise.resolve();
  private readonly maxOrderUsd: number;
  private readonly trustedPayTo: string[];

  constructor(private readonly opts: AgentOptions) {
    if (!opts.stellarSecret && !opts.evmPrivateKey) throw new Error("Set AGENT_STELLAR_SECRET or AGENT_EVM_PRIVATE_KEY");
    this.maxOrderUsd = opts.maxOrderUsd ?? config.maxOrderUsd;
    this.trustedPayTo = opts.trustedPayTo ?? [];
  }

  get spent(): number {
    return this.spentUsd;
  }

  async search(input: SearchInput): Promise<SearchResult[]> {
    const params = new URLSearchParams();
    if (input.city) params.set("city", input.city);
    if (input.kind) params.set("kind", input.kind);
    if (input.nights) params.set("nights", String(input.nights));
    if (input.maxTotalVnd) params.set("maxTotalVnd", String(input.maxTotalVnd));
    if (input.tags?.length) params.set("tags", input.tags.join(","));
    const res = await fetch(`${this.opts.apiUrl}/v1/places?${params}`);
    if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { results: SearchResult[] }).results;
  }

  async quote(qrString: string, amountVnd?: number): Promise<{ quote: PublicQuote; payUrl: string }> {
    const res = await fetch(`${this.opts.apiUrl}/v1/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qrString, amountVnd }),
    });
    const body = (await res.json()) as { quote: PublicQuote; payUrl: string; error?: string };
    if (!res.ok) throw new Error(body.error ?? `quote failed: ${res.status}`);
    return body;
  }

  // Quote then pay, refusing anything above the budget or the per-order limit.
  pay(qrString: string, budgetUsd: number, amountVnd?: number) {
    const run = this.queue.then(() => this.payNow(qrString, budgetUsd, amountVnd));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async payNow(qrString: string, budgetUsd: number, amountVnd?: number) {
    const { quote, payUrl } = await this.quote(qrString, amountVnd);
    if (quote.usdc > this.maxOrderUsd) throw new BudgetError(`Order is ${quote.usdc} USDC, above the ${this.maxOrderUsd} USDC per-order limit`);
    if (this.spentUsd + quote.usdc > budgetUsd) {
      throw new BudgetError(`Order is ${quote.usdc} USDC, already spent ${this.spentUsd.toFixed(2)} of a ${budgetUsd} USDC budget`);
    }

    const client = x402Client.fromConfig({
      schemes: [
        ...(this.opts.stellarSecret ? [{ network: "stellar:*" as const, client: new ExactStellarScheme(createEd25519Signer(this.opts.stellarSecret, "stellar:testnet")) }] : []),
        ...(this.opts.evmPrivateKey ? [{ network: "eip155:*" as const, client: new ExactEvmScheme(privateKeyToAccount(this.opts.evmPrivateKey as `0x${string}`)) }] : []),
      ],
      spendControls: { maxAmountPerPayment: `$${this.maxOrderUsd}` },
      policies: [quotePolicy(quote.usdc, this.trustedPayTo)],
      paymentRequirementsSelector: (_v, reqs) => reqs.find((r) => r.network.startsWith("stellar:")) ?? reqs[0],
    });
    const payFetch = wrapFetchWithPayment(fetch, client);

    const res = await payFetch(payUrl, { method: "POST" });
    const body = (await res.json()) as { order?: Record<string, unknown>; error?: string };
    if (!res.ok || !body.order) throw new Error(body.error ?? `payment failed: ${res.status}`);

    const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    const settlement = header ? decodePaymentResponseHeader(header) : undefined;
    this.spentUsd = Math.round((this.spentUsd + quote.usdc) * 100) / 100;
    return { quote, order: body.order, settlement };
  }

  async order(id: string) {
    const res = await fetch(`${this.opts.apiUrl}/v1/orders/${id}`);
    const body = (await res.json()) as { order?: Record<string, unknown>; error?: string };
    if (!res.ok) throw new Error(body.error ?? `order lookup failed: ${res.status}`);
    return body.order;
  }
}

export function agentFromEnv(): TravelAgent {
  return new TravelAgent({
    apiUrl: process.env.AGENT_API_URL ?? config.publicUrl,
    stellarSecret: process.env.AGENT_STELLAR_SECRET || undefined,
    evmPrivateKey: process.env.AGENT_EVM_PRIVATE_KEY || undefined,
    trustedPayTo: [process.env.STELLAR_PAY_TO, process.env.BASE_PAY_TO].filter((v): v is string => !!v),
  });
}
