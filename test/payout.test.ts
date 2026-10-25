import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GAIAN_MODE = "mock";
process.env.QUOTE_TTL_SECONDS = "1";
process.env.MOCK_FEE_RATE = "0";
const { createQuote, reserveOrder, fundOrder, getOrder, PayoutError } = await import("../src/payout.js");
const { buildVietQr } = await import("../src/vietqr.js");

const qr = (amountVnd: number) => buildVietQr({ bankBin: "970436", accountNumber: "9990000001", amountVnd });

test("mock quote prices VND in USDC, rounded up, and is marked demo", async () => {
  // 900,000 / 26,300 = 34.2205..., rounded up to the cent.
  const q = await createQuote(qr(900_000));
  assert.equal(q.usdc, 34.23);
  assert.equal(q.demo, true);
});

test("an order above 50 USD is refused at quote time", async () => {
  await assert.rejects(createQuote(qr(1_380_000)), (e: unknown) => e instanceof PayoutError && /50 USDC limit/.test(e.message));
});

test("an invalid QR is refused", async () => {
  await assert.rejects(createQuote(qr(100_000).slice(0, -1) + "0"), /checksum/);
});

test("a quote can be used once", async () => {
  const q = await createQuote(qr(100_000));
  await reserveOrder(q.id);
  await assert.rejects(reserveOrder(q.id), (e: unknown) => e instanceof PayoutError && e.httpStatus === 409);
});

test("an expired quote is refused", async () => {
  const q = await createQuote(qr(100_000));
  await new Promise((r) => setTimeout(r, 1100));
  await assert.rejects(reserveOrder(q.id), (e: unknown) => e instanceof PayoutError && e.httpStatus === 410);
});

test("an order only moves past reserved after settlement", async () => {
  const q = await createQuote(qr(200_000));
  const o = await reserveOrder(q.id);
  assert.equal((await getOrder(o.id))?.status, "reserved");
  await fundOrder(o.id, { transaction: "tx", network: "stellar:testnet" });
  assert.equal((await getOrder(o.id))?.status, "processing");
});
