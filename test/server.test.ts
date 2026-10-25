import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Throwaway recipients, generated per run. No funds, no keys kept.
process.env.GAIAN_MODE = "mock";
process.env.MOCK_FEE_RATE = "0";
process.env.STELLAR_PAY_TO = Keypair.random().publicKey();
process.env.BASE_PAY_TO = privateKeyToAccount(generatePrivateKey()).address;
const { createApp } = await import("../src/server.js");
const { buildVietQr } = await import("../src/vietqr.js");

async function withServer(fn: (url: string) => Promise<void>) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("unknown quote is rejected before any payment is asked", async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/v1/pay?quoteId=nope`, { method: "POST" });
    assert.equal(res.status, 410);
  });
});

test("paying a quote without x402 payment returns 402 with Stellar and Base at the quoted price", async () => {
  await withServer(async (url) => {
    const qrString = buildVietQr({ bankBin: "970436", accountNumber: "9990000001", amountVnd: 900_000 });
    const q = await (await fetch(`${url}/v1/quote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ qrString }) })).json();
    const res = await fetch(`${url}/v1/pay?quoteId=${q.quote.id}`, { method: "POST" });
    assert.equal(res.status, 402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    assert.ok(header, "PAYMENT-REQUIRED header");
    const required = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
    const byNetwork = Object.fromEntries(required.accepts.map((a: { network: string; amount: string }) => [a.network, a.amount]));
    assert.equal(byNetwork["stellar:testnet"], "342300000");
    assert.equal(byNetwork["eip155:84532"], "34230000");
  });
});
