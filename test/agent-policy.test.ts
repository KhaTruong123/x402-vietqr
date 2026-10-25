import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaymentRequirements } from "@x402/core/types";
import { quotePolicy, toAtomic } from "../src/agent/pay.js";

const req = (network: string, amount: string, payTo: string) => ({ scheme: "exact", network, amount, payTo, asset: "USDC", maxTimeoutSeconds: 60, extra: {} }) as PaymentRequirements;

test("atomic amounts use 7 decimals on Stellar and 6 on Base", () => {
  assert.equal(toAtomic(34.47, "stellar:testnet"), 344_700_000n);
  assert.equal(toAtomic(34.47, "eip155:84532"), 34_470_000n);
});

test("policy drops options that charge more than the quote", () => {
  const policy = quotePolicy(10, []);
  const kept = policy(2, [req("stellar:testnet", "100000000", "G1"), req("stellar:testnet", "100000001", "G1")]);
  assert.equal(kept.length, 1);
});

test("policy drops unknown recipients when a trusted list is set", () => {
  const policy = quotePolicy(10, ["GTRUSTED"]);
  const kept = policy(2, [req("stellar:testnet", "1", "GTRUSTED"), req("stellar:testnet", "1", "GOTHER")]);
  assert.deepEqual(kept.map((r) => r.payTo), ["GTRUSTED"]);
});

test("parallel payments cannot both pass the budget check", async () => {
  const { TravelAgent, BudgetError } = await import("../src/agent/pay.js");
  const agent = new TravelAgent({ apiUrl: "http://unused", stellarSecret: "S".padEnd(56, "A") });
  let calls = 0;
  // Stand-in for the network part: each payment costs 30 USD.
  (agent as any).payNow = async function (this: any, _qr: string, budget: number) {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    if (this.spentUsd + 30 > budget) throw new BudgetError("over budget");
    this.spentUsd += 30;
    return {};
  };
  const results = await Promise.allSettled([agent.pay("a", 45), agent.pay("b", 45)]);
  assert.equal(calls, 2);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected"]);
  assert.equal(agent.spent, 30);
});
